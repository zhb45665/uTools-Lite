import { pinyinHaystack, toPinyinInitials } from "../pinyin-match";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export interface AppEntry {
  /** Display name. */
  name: string;
  /**
   * Launch target:
   *  - classic apps: the .lnk path (launching it executes the target)
   *  - Store / built-in (UWP) apps: `shell:AppsFolder\<AppID>` — these apps
   *    have NO Start Menu .lnk at all, so they must come from Get-StartApps
   */
  path: string;
  /** Where it came from, for the subtitle. */
  source: "user" | "system" | "store";
  /** true when `path` is a shell: target (launch via explorer.exe). */
  shell?: boolean;
}

let cache: AppEntry[] | null = null;
let pinyinCache: Map<string, string[]> | null = null;
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
 * The two pinyin haystacks for one app name:
 *  - full pinyin concatenated onto the original ("微信weixin")
 *  - first-letter abbreviation ("wx")
 * Cached across searches (app list changes only on re-scan).
 */
export function appPinyinKeys(name: string): string[] {
  if (!pinyinCache) pinyinCache = new Map();
  let k = pinyinCache.get(name);
  if (!k) {
    k = [pinyinHaystack(name), toPinyinInitials(name)];
    pinyinCache.set(name, k);
  }
  return k;
}

const PS_TIMEOUT_MS = 8000;

/**
 * Run a PowerShell one-liner and return stdout.
 *
 * `OutputEncoding` MUST be pinned to UTF-8: the child otherwise writes in the
 * system ANSI code page (GBK here) and non-ASCII app names come back garbled.
 */
function runPowerShell(
  command: string,
  timeoutMs = PS_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`,
    ];
    const child = spawn("powershell.exe", args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new Error("powershell timeout"));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `powershell exited ${code}`));
    });
  });
}

/**
 * Store / built-in apps (UWP). They are NOT in the Start Menu folders — the
 * shell registers them under shell:AppsFolder, which is exactly what
 * `Get-StartApps` exposes (Name + AppID). Without this the launcher could not
 * find or open Calculator / Settings / Photos / Terminal / Store apps.
 */
async function scanShellApps(): Promise<AppEntry[]> {
  const raw = await runPowerShell(
    "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
  );
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: AppEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { Name?: unknown; AppID?: unknown };
    const name = String(r.Name ?? "").trim();
    const appId = String(r.AppID ?? "").trim();
    if (!name || !appId) continue;
    out.push({
      name,
      path: `shell:AppsFolder\\${appId}`,
      source: "store",
      shell: true,
    });
  }
  return out;
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
  const shellAppsPromise = scanShellApps().catch((e) => {
    lastScanError = String((e as Error).message || e);
    return [] as AppEntry[];
  });

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

  // Store / built-in apps fill the gaps (a classic .lnk wins when both exist).
  for (const app of await shellAppsPromise) {
    const key = app.name.toLowerCase();
    if (!seen.has(key)) seen.set(key, app);
  }

  const list = Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  cache = list;
  pinyinCache = null;
  scanning = false;
  return list;
}

export function getAppCount(): number {
  return cache?.length ?? 0;
}

export function scanError(): string | null {
  return lastScanError;
}
