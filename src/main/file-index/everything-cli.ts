import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * es.exe has no encoding switch (verified against ES 1.1.0.38 `-help`): it
 * writes its results in the console's ANSI code page. On a zh-CN Windows that
 * is GBK/CP936, so a path like `F:\演示项目代码` arrives as bytes
 * `d1 dd ca be cf ee c4 bf b4 fa c2 eb`. Decoding those as UTF-8 produced
 * mojibake (`ʾ��Ŀ����`) — the classic "Chinese paths are garbled" bug.
 *
 * Note the query *input* was never the problem: Node passes argv to
 * CreateProcessW as UTF-16, so es.exe matched Chinese queries correctly and
 * only the stdout decoding was wrong.
 *
 * gb18030 is a superset of GBK and also covers GB2312, so one decoder handles
 * every zh-CN case. UTF-8 is used when the OEM code page is already 65001, and
 * as a fallback anywhere TextDecoder lacks the code page (e.g. non-Windows).
 */
function resolveAnsiDecoder(): { decoder: TextDecoder; encoding: string } {
  if (process.platform !== "win32") {
    return { decoder: new TextDecoder("utf-8"), encoding: "utf-8" };
  }
  // chcp reports the console page (e.g. "65001" or "936"); CP_ACP is what
  // es.exe actually writes with, but they agree in practice and chcp is the
  // cheapest reliable probe.
  const cp = (() => {
    try {
      const out = spawnSync("chcp.com", [], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 1200,
      }).stdout;
      const m = /(\d{3,5})/.exec(out ?? "");
      return m ? m[1] : "";
    } catch {
      return "";
    }
  })();
  const candidates =
    cp === "65001" ? ["utf-8"] : ["gb18030", "gbk", "utf-8"];
  for (const enc of candidates) {
    try {
      return { decoder: new TextDecoder(enc), encoding: enc };
    } catch {
      /* try next */
    }
  }
  return { decoder: new TextDecoder("utf-8"), encoding: "utf-8" };
}

let ansiEncoding: { decoder: TextDecoder; encoding: string } | null = null;
function ansiDecode(buf: Buffer): string {
  if (!ansiEncoding) ansiEncoding = resolveAnsiDecoder();
  return ansiEncoding.decoder.decode(buf);
}

let detected: boolean | null = null;
let cachedExePath: string | null = null;
let cachedCliPath: string | null | undefined;

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

/** Locate the Everything command-line query client (`es.exe`).
 * Everything.exe alone can open its own UI, but cannot stream result paths
 * back to this app. Treat only es.exe as direct-search capability. */
export function findEverythingCli(): string | null {
  if (cachedCliPath !== undefined) return cachedCliPath;
  const besideGui = COMMON_EVERYTHING_PATHS.map((p) => path.join(path.dirname(p), "es.exe"));
  for (const p of besideGui) {
    if (fs.existsSync(p)) return (cachedCliPath = p);
  }
  try {
    // where.exe speaks the console ANSI code page too, so an install under a
    // Chinese-named folder (e.g. D:\软件\Everything\es.exe) would decode to
    // mojibake and fail the existsSync check below — silently disabling
    // Everything search. Decode the raw bytes instead of trusting UTF-8.
    const where = spawnSync("where.exe", ["es.exe"], {
      windowsHide: true,
      timeout: 1200,
    });
    const found = ansiDecode(where.stdout ?? Buffer.alloc(0))
      .split(/\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && fs.existsSync(p));
    if (found) return (cachedCliPath = found);
  } catch {
    /* fall through */
  }
  cachedCliPath = null;
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

    const cli = findEverythingCli();
    if (!cli) {
      detected = false;
      return resolve(false);
    }
    const proc = spawn(cli, ["--version"], { windowsHide: true });
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
      const cli = findEverythingCli();
      if (!cli) return resolve({ available: false, paths: [] });
      const proc = spawn(cli, [query, "-n", String(limit)], {
        windowsHide: true,
      });
      // Collect raw bytes and decode once at the end. Decoding per chunk is
      // unsafe here: a multi-byte GBK character can be split across stdout
      // chunks, and TextDecoder without {stream:true} would emit a replacement
      // char for each half. Buffering raw bytes also means a single byte run
      // can never be mis-split by a line boundary.
      let chunks: Buffer[] = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const buf = Buffer.concat(chunks);
        chunks = [];
        const paths = ansiDecode(buf)
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
        if (settled) return;
        chunks.push(d);
        // Count newlines in raw bytes: 0x0A can never appear inside a GBK
        // (or UTF-8) multi-byte sequence, so this is safe without decoding.
        let lines = 0;
        for (const c of d) if (c === 0x0a) lines++;
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
