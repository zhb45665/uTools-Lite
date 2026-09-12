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

// --- 金额大写 -------------------------------------------------------------
// The converter lives inside the amount plugin so that the sandbox, the
// detail page and this search path all share ONE implementation. It is
// loaded lazily: if the plugin folder is missing, search still works.
type AmountConverter = {
  toCapitalAmount: (raw: string) => string | null;
  formatCurrency: (raw: string) => string | null;
};

let amountConverter: AmountConverter | null | undefined;

function getAmountConverter(): AmountConverter | null {
  if (amountConverter === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      amountConverter =
        require("../../plugins/amount/convert.js") as AmountConverter;
    } catch {
      amountConverter = null;
    }
  }
  return amountConverter;
}

/** Currency symbol/unit marker. A decimal point also counts as a signal. */
const AMOUNT_MARK = /[¥￥$]|人民币|rmb|cny|元/i;

/**
 * Detect an unambiguous amount. A bare integer ("2024") is deliberately left
 * alone so normal file/app searches are never hijacked.
 */
function tryAmount(
  raw: string,
): { value: string; capital: string; plain: string } | null {
  const q = raw.trim();
  if (!q || q.length > 28) return null;
  if (!/[.．]/.test(q) && !AMOUNT_MARK.test(q)) return null;
  const conv = getAmountConverter();
  if (!conv) return null;
  const capital = conv.toCapitalAmount(q);
  if (!capital) return null;
  return { value: q, capital, plain: conv.formatCurrency(q) ?? "" };
}

// --- App fuzzy match ----------------------------------------------------

const APP_SOURCE_LABEL: Record<string, string> = {
  user: "用户应用",
  system: "系统应用",
  store: "商店 / 内置应用",
};

async function matchAppsAsync(query: string, limit = 8): Promise<SearchItem[]> {
  const apps = await scanApps();
  if (!apps.length || !query.trim()) return [];
  const hits = filter(apps, query, { key: "name", maxResults: limit });
  return hits.map((a, i) => ({
    id: `app:${i}:${a.name}`,
    type: "app" as const,
    title: a.name,
    subtitle: APP_SOURCE_LABEL[a.source] ?? "应用",
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
    // A bare expression opens the 计算稿纸 plugin (records the calculation
    // and supports one-click clear); the classic "copy result" command
    // stays available as the second item.
    const pm = getPluginManager();
    if (pm && pm.list().some((p) => p.id === "calc-paper")) {
      response.commands.unshift({
        id: "plugin:calc-paper:expr",
        type: "plugin" as const,
        title: `🧾 ${calc.expression} = ${calc.result}`,
        subtitle: "打开计算稿纸并暂存这次计算",
        icon: "🧾",
        payload: calc.expression,
        pluginId: "calc-paper",
        raw: {
          keyword: "计算",
          value: calc.expression,
          data: { action: "calc", expr: calc.expression, result: calc.result },
        },
      });
    }
    response.commands.push({
      id: "cmd:calc",
      type: "command",
      title: `${calc.expression} = ${calc.result}`,
      subtitle: "Press Enter to copy the result",
      icon: "🧮",
      payload: calc.result,
    });
  }

  // 金额大写：粘贴 "¥1,234.56" / "1234.56" 直接出中文大写（回车进面板继续转）
  const amount = tryAmount(q);
  if (amount) {
    const pm = getPluginManager();
    if (pm && pm.list().some((p) => p.id === "amount")) {
      response.commands.unshift({
        id: "plugin:amount:value",
        type: "plugin" as const,
        title: `💰 ${amount.capital}`,
        subtitle: `${amount.plain} · 回车打开金额大写转换`,
        icon: "💰",
        payload: amount.value,
        pluginId: "amount",
        raw: {
          keyword: "金额",
          value: amount.value,
          data: { action: "convert", value: amount.value },
        },
      });
    }
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
  // Real shell icons for files, classic .lnk apps AND Store/builtin apps:
  // their `shell:AppsFolder\<AppID>` target is resolved by the icon service
  // via SHParseDisplayName + SHGetFileInfo(SHGFI_PIDL).
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
