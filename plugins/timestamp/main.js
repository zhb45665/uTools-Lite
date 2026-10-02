/**
 * timestamp (时间戳转换) — Unix 时间戳 <-> 日期时间
 *
 * 用法：
 *   · `时间戳` / `时间` / `ts` / `date` / `timestamp` -> 打开转换面板（自动读剪贴板）
 *   · `时间戳 1719936000`   -> 结果行直接显示对应时间，回车进面板
 *   · `时间 1719936000000`  -> 毫秒时间戳自动识别
 *   · `时间 2026-07-01 12:00` -> 日期时间转时间戳
 */

/**
 * Parse a Unix timestamp (seconds or milliseconds) or a date-time string
 * into a Date. Returns null when the input is not recognizable.
 *
 * Auto-detects seconds vs milliseconds:
 *   - value >= 1e14 or 10 digits+ with leading zeros -> milliseconds
 *   - value < 1e12 (up to ~2001) or 13 digits -> milliseconds
 *   - otherwise -> seconds
 */
function parseInput(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;

  // Try numeric timestamp (integer, with optional leading +/-)
  const numMatch = /^([+-]?\d+)(?:\.(\d+))?$/.exec(s);
  if (numMatch) {
    const intPart = numMatch[1];
    const decPart = numMatch[2] || "";
    // Ignore decimal part for the magnitude test but keep it for ms precision
    const digits = intPart.replace(/^[+-]/, "");
    // Heuristic: >= 1e14 or exactly 13+ digits => milliseconds
    // 1e12 = ~2001-09-09, 1e14 = ~5138-00-00 (far future, definitely ms)
    // Typical seconds timestamps are 9-10 digits (up to ~5138 in seconds)
    // Typical milliseconds timestamps are 12-13 digits
    let value;
    if (decPart) {
      // Has decimal: treat as seconds with fractional part
      value = parseFloat(s);
      if (!isFinite(value) || Math.abs(value) < 1e6) return null;
      return new Date(value * 1000);
    }
    if (
      digits.length >= 13 ||
      (digits.length >= 12 && BigInt(digits) >= BigInt("1e12"))
    ) {
      // milliseconds
      value = BigInt(intPart);
      if (value < 0) return null; // negative timestamps unsupported
      if (value > BigInt(8640000000000000)) return null; // > year 275760
      return new Date(Number(value));
    }
    // seconds
    value = parseInt(intPart, 10);
    if (!isFinite(value) || value < 0 || value > 86400000000) return null; // > year 285337
    return new Date(value * 1000);
  }

  // Try date-time strings
  // ISO: 2026-07-01, 2026-07-01 12:00, 2026-07-01T12:00:00
  // Chinese: 2026年07月01日 12:00:00, 2026-07-01 12:00
  // Loose: 07/01/2026, 2026/7/1 12:00
  const d = tryParseDateTime(s);
  if (d && !isNaN(d.getTime())) return d;

  return null;
}

function tryParseDateTime(s) {
  // Normalize: replace Chinese separators
  const norm = s
    .replace(/年/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/时/g, " ")
    .replace(/分/g, ":")
    .replace(/秒/g, "")
    .trim();

  // Try native Date first (handles most ISO and locale formats)
  const native = new Date(norm);
  if (!isNaN(native.getTime())) {
    // Guard: bare month names or ambiguous strings that Date "helpfully" parses
    // If the input has no digits, it's not a valid date-time
    if (/\d/.test(norm)) return native;
  }

  // Manual parse: YYYY-MM-DD[ HH:MM[:SS]] or YYYY/MM/DD
  const m1 =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      norm,
    );
  if (m1) {
    const [_, y, mo, d2, h, mi, se] = m1;
    const dt = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d2),
      Number(h || 0),
      Number(mi || 0),
      Number(se || 0),
    );
    if (!isNaN(dt.getTime())) return dt;
  }

  // MM/DD/YYYY or DD/MM/YYYY (ambiguous — prefer MM/DD)
  const m2 =
    /^(\d{1,2})[/](\d{1,2})[/](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      norm,
    );
  if (m2) {
    const [_, a, b, y, h, mi, se] = m2;
    // If a > 12, it must be day (DD/MM)
    let mo = Number(a);
    let d3 = Number(b);
    if (mo > 12 && d3 <= 12) {
      mo = Number(b);
      d3 = Number(a);
    }
    const dt = new Date(
      Number(y),
      mo - 1,
      d3,
      Number(h || 0),
      Number(mi || 0),
      Number(se || 0),
    );
    if (!isNaN(dt.getTime())) return dt;
  }

  return null;
}

/** Format a Date as a readable string in the given timezone offset (hours). */
function formatInTz(date, tzOffsetHours) {
  const utcMs = date.getTime();
  const tzMs = tzOffsetHours * 3600000;
  const d = new Date(utcMs + tzMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const se = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi}:${se}`;
}

/** Weekday name in Chinese. */
function weekdayName(date) {
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return names[date.getDay()];
}

const OPEN_ITEM = {
  text: "⏱️ 打开时间戳转换",
  description: "粘贴即转 · 秒/毫秒自动识别 · 多时区",
  icon: "⏱️",
  data: { action: "open" },
};

main.onInput("时间戳", (_kw, cb) => cb([OPEN_ITEM]));
main.onInput("时间", (_kw, cb) => cb([OPEN_ITEM]));
main.onInput("timestamp", (_kw, cb) => cb([OPEN_ITEM]));
main.onInput("ts", (_kw, cb) => cb([OPEN_ITEM]));
main.onInput("date", (_kw, cb) => cb([OPEN_ITEM]));

function tsSearch(_kw, value, cb) {
  const d = parseInput(value);
  if (!d) {
    cb([
      {
        text: "⏱️ 打开时间戳转换",
        description: `「${value}」无法识别，回车进面板手输`,
        icon: "⏱️",
        data: { action: "open", value },
      },
    ]);
    return;
  }
  const localStr = formatInTz(d, new Date().getTimezoneOffset() / -60);
  cb([
    {
      text: `⏱️ ${localStr} ${weekdayName(d)}`,
      description: `时间戳 ${Math.floor(d.getTime() / 1000)} · 回车打开转换面板`,
      icon: "⏱️",
      data: { action: "convert", value },
    },
  ]);
}

main.onInputSearch("时间戳", tsSearch);
main.onInputSearch("时间", tsSearch);
main.onInputSearch("timestamp", tsSearch);
main.onInputSearch("ts", tsSearch);
main.onInputSearch("date", tsSearch);

main.onExit(() => {
  main.log("timestamp detail view closed");
});

main.log("timestamp plugin loaded");
