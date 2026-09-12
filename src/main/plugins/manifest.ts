import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { PluginInfo, PluginPermission } from "../../shared/ipc";

/**
 * Plugin manifest discovery + validation (hand-rolled, no zod).
 *
 * Sources, in order:
 *   1. builtin  <repo>/plugins/<id>       (shipped with the app)
 *   2. user     %APPDATA%/utools-lite/plugins/<id>   (installed by the user)
 * User plugins win on id conflicts (so users can shadow built-ins).
 */

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KNOWN_PERMISSIONS: PluginPermission[] = ["fs", "clipboard", "net"];

export interface Manifest {
  id: string;
  name: string;
  description?: string;
  version?: string;
  main: string;
  detail?: string;
  keywords: string[];
  icon?: string;
  permissions: PluginPermission[];
  /** Absolute plugin folder. */
  dir: string;
  builtin: boolean;
}

export interface ManifestIssue {
  pluginDir: string;
  level: "error" | "warning";
  message: string;
}

function builtinPluginsRoot(): string {
  // dist/main/plugins -> repo root (dev). Packaged builds ship the folder
  // next to app.asar via electron-builder `files`.
  return path.join(__dirname, "../../../plugins");
}

function userPluginsRoot(): string {
  const dir = path.join(app.getPath("userData"), "plugins");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dataRoot(): string {
  const dir = path.join(app.getPath("userData"), "plugin-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate one plugin folder. Returns the manifest plus a list of issues.
 * `issues` with level "error" make the plugin unusable.
 */
export function validatePluginFolder(
  dir: string,
  builtin: boolean,
): { manifest: Manifest | null; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const manifestPath = path.join(dir, "uTLS.json");

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: `uTLS.json missing or invalid JSON: ${(e as Error).message}`,
    });
    return { manifest: null, issues };
  }
  if (!isPlainObject(raw)) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: "uTLS.json must be a JSON object",
    });
    return { manifest: null, issues };
  }

  // name (required)
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  if (!name) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: 'missing required field "name"',
    });
  }

  // main (required, file must exist)
  const main =
    typeof raw.main === "string" && raw.main.trim() ? raw.main.trim() : "";
  if (!main) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: 'missing required field "main"',
    });
  } else if (!fs.existsSync(path.resolve(dir, main))) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: `entry file "${main}" does not exist`,
    });
  }

  // keywords (required, non-empty string array)
  const keywords: string[] = [];
  if (Array.isArray(raw.keywords)) {
    for (const k of raw.keywords) {
      if (typeof k === "string" && k.trim()) keywords.push(k.trim());
    }
  }
  if (keywords.length === 0) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: '"keywords" must be a non-empty array of strings',
    });
  }

  // id: validate or fall back to folder name
  const folderName = path.basename(dir);
  let id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
  if (id && !ID_RE.test(id)) {
    issues.push({
      pluginDir: dir,
      level: "warning",
      message: `invalid id "${raw.id}", falling back to folder name "${folderName}"`,
    });
    id = "";
  }
  if (!id) id = folderName.toLowerCase();
  if (!ID_RE.test(id)) {
    issues.push({
      pluginDir: dir,
      level: "error",
      message: `plugin id "${id}" is invalid (use [a-z0-9-_])`,
    });
    return { manifest: null, issues };
  }

  // detail (optional; file must exist when set)
  let detail: string | undefined;
  if (typeof raw.detail === "string" && raw.detail.trim()) {
    detail = raw.detail.trim();
    if (!fs.existsSync(path.resolve(dir, detail))) {
      issues.push({
        pluginDir: dir,
        level: "warning",
        message: `detail file "${detail}" does not exist`,
      });
    }
  }

  // permissions: unknown values are ignored with a warning (tolerant)
  const permissions: PluginPermission[] = [];
  if (Array.isArray(raw.permissions)) {
    for (const p of raw.permissions) {
      if (
        typeof p === "string" &&
        (KNOWN_PERMISSIONS as string[]).includes(p)
      ) {
        if (!permissions.includes(p as PluginPermission)) {
          permissions.push(p as PluginPermission);
        }
      } else {
        issues.push({
          pluginDir: dir,
          level: "warning",
          message: `unknown permission "${String(p)}" ignored`,
        });
      }
    }
  }

  const icon =
    typeof raw.icon === "string" && raw.icon.trim()
      ? raw.icon.trim()
      : undefined;

  if (issues.some((i) => i.level === "error")) {
    return { manifest: null, issues };
  }

  const manifest: Manifest = {
    id,
    name,
    description:
      typeof raw.description === "string" ? raw.description : undefined,
    version: typeof raw.version === "string" ? raw.version : undefined,
    main,
    detail,
    keywords,
    icon,
    permissions,
    dir,
    builtin,
  };
  return { manifest, issues };
}

/**
 * Scan builtin + user plugin roots. First-seen id wins only for the same
 * source; user source overrides builtin on conflict.
 */
export function discoverPlugins(): {
  plugins: Map<string, Manifest>;
  issues: ManifestIssue[];
} {
  const plugins = new Map<string, Manifest>();
  const issues: ManifestIssue[] = [];

  const sources: { root: string; builtin: boolean }[] = [
    { root: builtinPluginsRoot(), builtin: true },
    { root: userPluginsRoot(), builtin: false },
  ];

  for (const source of sources) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(source.root, { withFileTypes: true });
    } catch {
      continue; // root missing (fresh install) is fine
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(source.root, entry.name);
      const { manifest, issues: folderIssues } = validatePluginFolder(
        dir,
        source.builtin,
      );
      issues.push(...folderIssues);
      if (!manifest) continue;
      const existing = plugins.get(manifest.id);
      if (existing) {
        // user overrides builtin; builtin-builtin conflicts keep the first.
        if (source.builtin) {
          issues.push({
            pluginDir: dir,
            level: "warning",
            message: `duplicate id "${manifest.id}" (skipped, ${existing.dir} wins)`,
          });
          continue;
        }
        issues.push({
          pluginDir: dir,
          level: "warning",
          message: `user plugin "${manifest.id}" overrides builtin ${existing.dir}`,
        });
      }
      plugins.set(manifest.id, manifest);
    }
  }
  return { plugins, issues };
}

export function pluginsRoot(): string {
  return userPluginsRoot();
}

export function pluginDataDir(pluginId: string): string {
  const dir = path.join(dataRoot(), pluginId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function toPluginInfo(m: Manifest): PluginInfo {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    keywords: m.keywords,
    hasDetail: !!m.detail,
    permissions: m.permissions,
    builtin: m.builtin,
    dir: m.dir,
    status: "idle",
  };
}
