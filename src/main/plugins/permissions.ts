import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { pluginDataDir } from "./manifest";
import { readState, writeState } from "../database";

/**
 * Directory authorization table + path validation.
 *
 * Storage: %APPDATA%/utools-lite/plugin-permissions.json
 *   { "notes": { "dirs": ["C:\\Users\\me\\Documents"], "net": [] } }
 *
 * Rules:
 *   - relative paths resolve against the plugin's private data dir (no auth)
 *   - absolute paths inside the data dir: allowed
 *   - absolute paths inside an authorized dir: allowed
 *   - everything else: the manager prompts the user (inline card)
 */

interface PluginGrant {
 dirs: string[];
 net: string[];
}

interface GrantTable {
 [pluginId: string]: PluginGrant;
}

let table: GrantTable = {};
let file: string;

export function initPermissions(): void {
 file = path.join(app.getPath("userData"), "plugin-permissions.json");
 try {
  let raw = readState<unknown>("app", "plugin-permissions");
  if (!raw) {
   raw = JSON.parse(fs.readFileSync(file, "utf8"));
   writeState("app", "plugin-permissions", raw);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
   const objectRaw = raw as { schemaVersion?: number; grants?: unknown };
   const candidate = objectRaw.schemaVersion === 1 ? objectRaw.grants : raw;
   table = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as GrantTable : {};
  }
 } catch {
  table = {};
 }
}

function persist(): void {
 try {
  writeState("app", "plugin-permissions", { schemaVersion: 1, grants: table });
 } catch (e) {
  console.error("[permissions] failed to persist", e);
 }
}

function grant(pluginId: string): PluginGrant {
 if (!table[pluginId]) table[pluginId] = { dirs: [], net: [] };
 return table[pluginId];
}

/**
 * Resolve a plugin-provided path to an absolute path.
 * Relative paths are rooted at the plugin's private data dir.
 */
export function resolvePluginPath(pluginId: string, p: string): string {
 const trimmed = String(p).trim();
 if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
 return path.resolve(pluginDataDir(pluginId), trimmed);
}

/**
 * Strict containment check. Must compare against root + separator so that
 * "C:\\data-evil" does not match root "C:\\data".
 */
export function assertInside(root: string, target: string): string {
 const resolvedRoot = path.resolve(root);
 const resolvedTarget = path.resolve(target);
 if (
  resolvedTarget !== resolvedRoot &&
  !resolvedTarget.startsWith(resolvedRoot + path.sep)
 ) {
  throw new Error("path escapes authorized directory");
 }
 return resolvedTarget;
}

/** True when `absPath` sits inside the plugin's private data dir. */
export function isInsideDataDir(pluginId: string, absPath: string): boolean {
 const dataDir = pluginDataDir(pluginId);
 const resolved = path.resolve(absPath);
 return resolved === dataDir || resolved.startsWith(dataDir + path.sep);
}

/** True when `absPath` sits inside one of the plugin's authorized dirs. */
export function isInsideAuthorizedDir(
 pluginId: string,
 absPath: string,
): string | null {
 const dirs = table[pluginId]?.dirs ?? [];
 const resolved = path.resolve(absPath);
 for (const d of dirs) {
  const root = path.resolve(d);
  if (resolved === root || resolved.startsWith(root + path.sep)) {
   return d;
  }
 }
 return null;
}

/**
 * Check access for a filesystem call.
 * Returns "allowed" or the directory that should be offered to the user.
 */
export function checkFsAccess(
 pluginId: string,
 absPath: string,
): { ok: true } | { ok: false; offerDir: string } {
 if (isInsideDataDir(pluginId, absPath)) return { ok: true };
 const hit = isInsideAuthorizedDir(pluginId, absPath);
 if (hit) return { ok: true };
 // Offer the parent directory (so plugins can list it too).
 const offer =
  path.dirname(absPath) === path.parse(absPath).root
   ? absPath
   : path.dirname(absPath);
 return { ok: false, offerDir: offer };
}

/** Record a user grant (a directory the plugin may read/write). */
export function authorizeDir(pluginId: string, dir: string): void {
 const g = grant(pluginId);
 const resolved = path.resolve(dir);
 if (!g.dirs.includes(resolved)) g.dirs.push(resolved);
 persist();
}

/** Deny = remember nothing; the plugin simply gets an error. */

export function authorizedDirs(pluginId: string): string[] {
 return table[pluginId]?.dirs ?? [];
}
