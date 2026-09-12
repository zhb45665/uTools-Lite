import { spawn } from "node:child_process";

let detected: boolean | null = null;

/**
 * Detect whether the Everything `es` CLI is on PATH.
 * Caches the result after the first probe.
 */
export function detectEverything(): Promise<boolean> {
  return new Promise((resolve) => {
    if (detected !== null) return resolve(detected);
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
    }, 3000);
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
      const proc = spawn("es", [query, "-a"], { windowsHide: true });
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
