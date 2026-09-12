import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileIndexStatus } from "../../shared/ipc";

/**
 * Local file index — the offline fallback when Everything (`es` CLI) is not
 * installed. Walks all fixed drives in the background (user folders first)
 * and keeps a bounded in-memory index for fast name/folder matching.
 *
 * Memory model: two parallel arrays, `orig` (original-case paths, for
 * display) and `keys` (lowercased `name + last-3 dir segments`, for the
 * fast search pass). Bounded by MAX_ENTRIES so a very large disk cannot
 * grow the index without limit.
 */

export type { FileIndexStatus };

export interface LocalIndexOptions {
  /**
   * Drive roots to walk. Default: all existing local drives (A:–H: probed).
   * Injectable for tests.
   */
  rootDirs?: string[];
  /**
   * High-priority dirs indexed first (user folders). Default: the six well-
   * known user folders (Desktop/Documents/Downloads/Pictures/Videos/Music),
   * resolved through realpath so OneDrive junctions are indexed once.
   * Injectable for tests.
   */
  userDirs?: string[];
}

const MAX_ENTRIES = 600_000;

interface State {
  orig: string[];
  keys: string[];
  running: boolean;
  complete: boolean;
  capped: boolean;
  started: boolean;
}

const state: State = {
  orig: [],
  keys: [],
  running: false,
  complete: false,
  capped: false,
  started: false,
};

/**
 * Skip rules, matched against the lowercased full path. Targets the classic
 * Windows noise: component store, recycle bin, UWP package cache, temp,
 * dependency/SCC internals.
 */
const SKIP_SUBSTRINGS = [
  "\\windows\\winsxs",
  "\\windows\\cwf",
  "\\windows\\installer",
  "$recycle.bin",
  "system volume information",
  "appdata\\local\\packages",
  "appdata\\local\\temp",
  "appdata\\local\\crashdumps",
  "node_modules",
  ".git",
  "$windows.~q",
  "\\perflogs",
  "\\recovery",
  "\\users\\default",
  "programdata\\package cache",
  "microsoft\\windows\\wer",
  "\\appdata\\local\\pip",
];

function shouldSkipDir(lowerDir: string): boolean {
  for (const s of SKIP_SUBSTRINGS) {
    if (lowerDir.includes(s)) return true;
  }
  return false;
}

// --- drive discovery ------------------------------------------------------

function listDriveRoots(): string[] {
  // fs.accessSync on a drive root returns immediately for present local
  // drives and throws fast for absent letters; only a stuck network share
  // would be slow, and we probe a fixed, small letter set.
  const roots: string[] = [];
  for (const l of ["C", "D", "E", "F", "G", "H"]) {
    try {
      fs.accessSync(l + ":\\", fs.constants.F_OK);
      roots.push(l + ":\\");
    } catch {
      /* absent drive */
    }
  }
  return roots.length ? roots : ["C:\\"];
}

// --- user dir discovery ----------------------------------------------------

function defaultUserDirs(): string[] {
  const home = os.homedir();
  const names = [
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Videos",
    "Music",
  ];
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(home, n);
    // Resolve junctions (Win11 Desktop/Documents live under OneDrive) so the
    // same files are indexed exactly once.
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      continue; // folder missing -> skip
    }
    const lower = real.toLowerCase();
    if (!out.some((x) => x.toLowerCase() === lower)) out.push(real);
  }
  return out;
}

// --- the walk --------------------------------------------------------------

let onProgress: ((s: FileIndexStatus) => void) | null = null;

function addEntry(full: string, nameLower: string, dir: string): void {
  if (state.orig.length >= MAX_ENTRIES) {
    state.capped = true;
    return;
  }
  const parent = path.basename(dir).toLowerCase();
  const grand = path.basename(path.dirname(dir)).toLowerCase();
  const great = path.basename(path.dirname(path.dirname(dir))).toLowerCase();
  state.orig.push(full);
  state.keys.push(nameLower + " " + parent + " " + grand + " " + great);
}

async function walkDir(
  dir: string,
  queue: string[],
  skipSubtrees: Set<string>,
  inQueue: Set<string>,
  stop: { flag: boolean },
): Promise<void> {
  if (stop.flag) return;
  const lower = dir.toLowerCase();
  // NB: no skipSubtrees check here — the explicit user dirs are themselves
  // queued for walking. They are excluded from the full-disk walk at child-
  // enqueue time instead (see the isDirectory branch below).
  if (inQueue.has(lower)) return;
  inQueue.add(lower);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    if (stop.flag) return;
    // Junctions/symlinks: never descend (loop + duplicate protection).
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const fullLower = full.toLowerCase();
      if (shouldSkipDir(fullLower) || skipSubtrees.has(fullLower)) continue;
      queue.push(full);
    } else if (e.isFile()) {
      addEntry(full, e.name.toLowerCase(), dir);
      if (state.orig.length >= MAX_ENTRIES) {
        stop.flag = true;
        return;
      }
    }
  }
}

/**
 * Start the background index walk. Safe to call multiple times; the second
 * call is a no-op. Returns immediately — indexing continues asynchronously.
 */
export function startLocalIndex(
  opts: LocalIndexOptions = {},
  progressCb?: (s: FileIndexStatus) => void,
): void {
  if (state.started) return;
  state.started = true;
  state.running = true;
  onProgress = progressCb ?? null;

  const userDirs = opts.userDirs ?? defaultUserDirs();
  const rootDirs = opts.rootDirs ?? listDriveRoots();

  const skipSubtrees = new Set(userDirs.map((d) => d.toLowerCase()));
  const queue: string[] = [...userDirs, ...rootDirs];
  const inQueue = new Set<string>();
  const qhead = { i: 0 };
  const stop = { flag: false };
  let inFlight = 0;

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop.flag) return;
      if (qhead.i < queue.length) {
        // Claim a slot. Peek-then-claim (no ++ on out-of-range grabs):
        // a worker must never consume a slot number that is beyond the
        // queue's current length, or directories enqueued later at that
        // index would be silently skipped.
        const idx = qhead.i++;
        inFlight++;
        try {
          await walkDir(queue[idx], queue, skipSubtrees, inQueue, stop);
        } finally {
          inFlight--;
        }
      } else if (inFlight === 0) {
        // Queue fully drained and nobody mid-walk -> done.
        return;
      } else {
        await sleep(5);
      }
    }
  };

  // Progress reporting: at most every 2 s.
  let lastReport = Date.now();
  const reportTimer = setInterval(() => {
    if (onProgress && Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      onProgress(status());
    }
  }, 1000);

  void Promise.all([worker(), worker(), worker(), worker()])
    .then(() => {
      state.running = false;
      state.complete = true;
      clearInterval(reportTimer);
      onProgress?.(status());
    })
    .catch(() => {
      state.running = false;
      state.complete = true;
      clearInterval(reportTimer);
      onProgress?.(status());
    });
}

export function status(): FileIndexStatus {
  return {
    count: state.orig.length,
    complete: state.complete,
    running: state.running,
    capped: state.capped,
  };
}

// --- search ----------------------------------------------------------------

/**
 * Match query against the local index.
 *
 * Scans `keys` (lowercased filename + last three directory segments) —
 * covers the near-universal case of typing a file name or a folder name.
 * O(n) indexOf over short strings; bounded top-list keeps memory constant.
 *
 * Ranking: filename prefix > filename contains > folder-segment match,
 * with a segment-start bonus, then shorter path wins.
 */
export function searchLocalIndex(
  query: string,
  limit = 15,
): { paths: string[] } {
  const needle = query.toLowerCase().trim();
  const n = state.orig.length;
  if (!needle || n === 0) return { paths: [] };

  const cap = limit * 3;
  // Bounded top-list kept sorted (score desc, path len asc). The worst
  // element is at the end, so each new match is an O(1) reject or an
  // O(cap) insert; cap is small (3x the display limit).
  const top: { score: number; len: number; idx: number }[] = [];

  const keys = state.keys;
  const orig = state.orig;
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const p = k.indexOf(needle);
    if (p === -1) continue;
    const firstSpace = k.indexOf(" ");
    let score: number;
    if (p < firstSpace) {
      // matched inside the filename
      score = p === 0 ? 100 : 80;
    } else {
      // matched inside a directory segment
      score = 30;
    }
    if (p === 0 || k.charCodeAt(p - 1) === 32) score += 10; // segment start
    const len = orig[i].length;

    const worst = top[top.length - 1];
    if (top.length < cap) {
      top.push({ score, len, idx: i });
    } else if (
      worst &&
      (score > worst.score || (score === worst.score && len < worst.len))
    ) {
      top[top.length - 1] = { score, len, idx: i };
    } else {
      continue;
    }
    // Keep sorted: score desc, len asc. Insertion sort from the tail.
    let j = top.length - 1;
    while (j > 0) {
      const a = top[j - 1];
      const b = top[j];
      if (a.score > b.score || (a.score === b.score && a.len <= b.len)) {
        break;
      }
      top[j - 1] = b;
      top[j] = a;
      j--;
    }
  }

  top.sort((a, b) => b.score - a.score || a.len - b.len || a.idx - b.idx);
  const paths = top.slice(0, limit).map((t) => orig[t.idx]);
  return { paths };
}

export function getIndexStatus(): FileIndexStatus {
  return status();
}
