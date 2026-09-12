import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AppEntry {
  /** Display name (lnk base name). */
  name: string;
  /** The .lnk path; launching it executes the target on Windows. */
  path: string;
  /** Where it came from, for the subtitle. */
  source: "user" | "system";
}

let cache: AppEntry[] | null = null;
let scanning = false;
let lastScanError: string | null = null;

function startMenuDirs(): { dir: string; source: "user" | "system" }[] {
  const dirs: { dir: string; source: "user" | "system" }[] = [];
  const appData = process.env.APPDATA;
  const programData = process.env.ProgramData;
  if (appData) {
    dirs.push({
      dir: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
      source: "user",
    });
  }
  if (programData) {
    dirs.push({
      dir: path.join(
        programData,
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
      ),
      source: "system",
    });
  }
  // Fallback for non-Windows dev machines so the code still runs.
  if (dirs.length === 0) {
    dirs.push({ dir: path.join(os.homedir(), "Applications"), source: "user" });
  }
  return dirs;
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".lnk")) {
      out.push(full);
    }
  }
}

/**
 * Scan Start Menu folders for .lnk shortcuts. Cached after the first call.
 * Runs in the background at startup; returns the cache (possibly stale).
 */
export function scanApps(): Promise<AppEntry[]> {
  if (cache && !scanning) return Promise.resolve(cache);
  if (scanning) return scanPromise;
  scanning = true;
  scanPromise = doScan();
  return scanPromise;
}

let scanPromise: Promise<AppEntry[]>;

async function doScan(): Promise<AppEntry[]> {
  const lnks: string[] = [];
  const dirs = startMenuDirs();
  await Promise.all(
    dirs.map(async (d) => {
      await walk(d.dir, lnks, 0);
      return undefined;
    }),
  );

  const seen = new Map<string, AppEntry>();
  for (const lnk of lnks) {
    const base = path.basename(lnk, ".lnk");
    const key = base.toLowerCase();
    if (!seen.has(key)) {
      const source: "user" | "system" = lnk.includes("ProgramData")
        ? "system"
        : "user";
      seen.set(key, { name: base, path: lnk, source });
    }
  }
  const list = Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  cache = list;
  scanning = false;
  lastScanError = null;
  return list;
}

export function getAppCount(): number {
  return cache?.length ?? 0;
}

export function scanError(): string | null {
  return lastScanError;
}
