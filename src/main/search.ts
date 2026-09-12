import { filter } from "fuzzaldrin-plus";
import { SearchItem, SearchResponse } from "../shared/ipc";
import { searchEverything } from "./file-index/everything-cli";
import { scanApps } from "./file-index/app-index";
import { searchLocalIndex, getIndexStatus } from "./file-index/local-index";
import { getIconUrl } from "./file-index/icon-service";
import { getPluginManager } from "./plugins/manager";

// --- Calculator ---------------------------------------------------------

const CALC_ALLOWED = /^[\s\d+\-*/().%]+$/;

/**
 * Try to interpret the query as an arithmetic expression.
 * Strict character whitelist (digits + operators + parens + dot + %) makes
 * the subsequent eval injection-safe: no identifiers, quotes, or semicolons.
 */
function tryCalc(raw: string): { expression: string; result: string } | null {
  const expr = raw.trim().replace(/^[=]\s*/, "");
  if (expr.length === 0) return null;
  if (!/\d/.test(expr)) return null;
  if (!/[+\-*/%]/.test(expr)) return null;
  if (!CALC_ALLOWED.test(expr)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const val = Function(`"use strict"; return (${expr});`)();
    if (typeof val !== "number" || !Number.isFinite(val)) return null;
    const rounded = Math.round(val * 1e10) / 1e10;
    return { expression: expr, result: String(rounded) };
  } catch {
    return null;
  }
}

function iconForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "📕",
    doc: "📘",
    docx: "📘",
    xls: "📗",
    xlsx: "📗",
    ppt: "📙",
    pptx: "📙",
    txt: "📄",
    md: "📄",
    csv: "📊",
    jpg: "🖼️",
    jpeg: "🖼️",
    png: "🖼️",
    gif: "🖼️",
    bmp: "🖼️",
    mp3: "🎵",
    wav: "🎵",
    mp4: "🎬",
    mkv: "🎬",
    zip: "🗜️",
    rar: "🗜️",
    js: "📜",
    ts: "📜",
    json: "📜",
    html: "🌐",
  };
  return map[ext] ?? "📄";
}

// --- App fuzzy match ----------------------------------------------------

async function matchAppsAsync(query: string, limit = 8): Promise<SearchItem[]> {
  const apps = await scanApps();
  if (!apps.length || !query.trim()) return [];
  const hits = filter(apps, query, { key: "name", maxResults: limit });
  return hits.map((a, i) => ({
    id: `app:${i}:${a.name}`,
    type: "app" as const,
    title: a.name,
    subtitle: a.source === "system" ? "System app" : "User app",
    icon: "🚀",
    payload: a.path,
  }));
}

// --- Main search --------------------------------------------------------

export async function runSearch(query: string): Promise<SearchResponse> {
  const q = query.trim();
  const response: SearchResponse = {
    query,
    files: [],
    apps: [],
    commands: [],
    plugins: [],
  };
  if (!q) return response;

  // Calculator first (high priority).
  const calc = tryCalc(q);
  if (calc) {
    response.calc = calc;
    response.commands.push({
      id: "cmd:calc",
      type: "command",
      title: `${calc.expression} = ${calc.result}`,
      subtitle: "Press Enter to copy the result",
      icon: "🧮",
      payload: calc.result,
    });
  }

  // File search via Everything (instant when available), plugin keyword
  // match, and app fuzzy match all run in parallel; the UI fills as they land.
  const [fileRes, pluginItems, apps] = await Promise.all([
    searchEverything(q, 15),
    (async () => {
      const pm = getPluginManager();
      if (!pm) return [];
      try {
        return await pm.searchPlugins(q);
      } catch {
        return [];
      }
    })(),
    matchAppsAsync(q, 8),
  ]);
  if (fileRes.available) {
    // Everything is authoritative when present: its index is complete, so
    // zero hits means zero files — no local fallback needed.
    response.files = fileRes.paths.map((p, i) => ({
      id: `file:${i}:${p}`,
      type: "file" as const,
      title: p.split(/[\\/]/).pop() ?? p,
      subtitle: p,
      icon: iconForPath(p),
      payload: p,
    }));
  } else {
    // Offline fallback: the local whole-disk index (still filling while the
    // background walk runs — whatever is indexed so far is searchable).
    response.files = searchLocalIndex(q, 15).paths.map((p, i) => ({
      id: `file:${i}:${p}`,
      type: "file" as const,
      title: p.split(/[\\/]/).pop() ?? p,
      subtitle: p,
      icon: iconForPath(p),
      payload: p,
    }));
  }
  response.fileIndex = getIndexStatus();
  response.plugins = pluginItems;
  response.apps = apps;

  // Real Windows shell icons (cached across searches; emoji fallback when
  // the icon service is unavailable or a path yields no icon). The whole
  // batch is capped so a slow/cold service can never stall the search UI.
  const iconTargets = [...response.files, ...response.apps];
  if (iconTargets.length > 0) {
    const urls = await Promise.race([
      Promise.all(iconTargets.map((it) => getIconUrl(it.payload))),
      new Promise<Array<null>>((resolve) =>
        setTimeout(() => resolve([]), 2500),
      ),
    ]);
    iconTargets.forEach((it, i) => {
      const u = urls[i];
      if (u) it.iconUrl = u;
    });
  }

  return response;
}
