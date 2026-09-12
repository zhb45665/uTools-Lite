import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let detected: boolean | null = null;
let cachedExePath: string | null = null;

const COMMON_EVERYTHING_PATHS = [
  "D:\\Program Files\\Everything\\Everything.exe",
  "C:\\Program Files\\Everything\\Everything.exe",
  "C:\\Program Files (x86)\\Everything\\Everything.exe",
  "D:\\Program Files (x86)\\Everything\\Everything.exe",
  "E:\\Program Files\\Everything\\Everything.exe",
  "E:\\Program Files (x86)\\Everything\\Everything.exe",
];

/**
 * Locate local Everything.exe installation on disk.
 */
export function findEverythingExe(): string | null {
  if (cachedExePath && fs.existsSync(cachedExePath)) return cachedExePath;

  for (const p of COMMON_EVERYTHING_PATHS) {
    if (fs.existsSync(p)) {
      cachedExePath = p;
      return p;
    }
  }

  const prog = process.env["ProgramFiles"];
  if (prog) {
    const p = path.join(prog, "Everything", "Everything.exe");
    if (fs.existsSync(p)) {
      cachedExePath = p;
      return p;
    }
  }
  const prog86 = process.env["ProgramFiles(x86)"];
  if (prog86) {
    const p = path.join(prog86, "Everything", "Everything.exe");
    if (fs.existsSync(p)) {
      cachedExePath = p;
      return p;
    }
  }

  return null;
}

/**
 * Open local Everything GUI window, optionally focusing a search query.
 */
export function openLocalEverything(query?: string): boolean {
  const exe = findEverythingExe();
  if (!exe) return false;
  try {
    const args = query && query.trim() ? ["-search", query.trim()] : [];
    const child = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether Everything is available (either `es` CLI or local Everything.exe installation).
 * Caches the result after the first probe.
 */
export function detectEverything(): Promise<boolean> {
  return new Promise((resolve) => {
    if (detected !== null) return resolve(detected);

    // If local Everything.exe exists, Everything is definitely installed!
    if (findEverythingExe() !== null) {
      detected = true;
      return resolve(true);
    }

    const proc = spawn("es", ["--version"], { windowsHide: true });
    let got = false;
    const done = (ok: boolean) => {
      detected = ok;
      resolve(ok);
    };
    proc.on("error", () => done(false));
    proc.stdout.on("data", () => {
      if (!got) {
        got = true;
        done(true);
      }
    });
    proc.on("close", (code) => {
      if (!got) done(code === 0);
    });
    // safety timeout
    setTimeout(() => {
      if (!got) {
        proc.kill();
        done(false);
      }
    }, 2000);
  });
}

export interface EverythingResult {
  available: boolean;
  paths: string[];
}

/**
 * Search files via the Everything `es` CLI (instant, index-backed).
 * Each line of stdout is one full path. Returns up to `limit` results.
 */
export function searchEverything(
  query: string,
  limit = 30,
): Promise<EverythingResult> {
  return detectEverything().then((available) => {
    if (!available) return { available: false, paths: [] };
    return new Promise<EverythingResult>((resolve) => {
      const proc = spawn("es", [query, "-n", String(limit)], {
        windowsHide: true,
      });
      let buf = "";
      let lines = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const paths = buf
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, limit);
        resolve({ available: true, paths });
      };
      const timer = setTimeout(() => {
        proc.kill();
        finish();
      }, 1500);
      proc.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        lines = buf.split(/\r?\n/).length;
        if (lines > limit + 5) {
          // we have enough; let the process die naturally but stop accumulating
          proc.stdout.pause();
        }
      });
      proc.on("close", () => {
        clearTimeout(timer);
        finish();
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve({ available: false, paths: [] });
      });
    });
  });
}
