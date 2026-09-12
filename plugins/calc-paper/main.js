/**
 * calc-paper (计算稿纸) — keyboard calculator with a persistent scratch list.
 *
 * Behavior:
 *   - `paper` / `稿纸`  -> open the detail view (or clear all records)
 *   - `计算 2+2*3`      -> evaluates inline in the result row; Enter opens
 *                          the detail view with that calculation pre-filled
 *                          and records it
 *   - detail view: type an expression, Enter/`=` appends it to the paper;
 *                  records persist to plugin-data/calc-paper/records.json
 *                  (plugin private dir — no authorization prompt);
 *                  one-click "清空" wipes the paper (also available here).
 *
 * Expression evaluation is the same injection-safe whitelist the host
 * calculator uses: digits + operators only, no identifiers/quotes/semicolons.
 */

const PAPER_FILE = "paper.txt";

const CALC_ALLOWED = /^[\s\d+\-*/().%]+$/;

/**
 * Evaluate an arithmetic expression with a tiny hand-written recursive
 * descent parser (digits, + - * / %, parens, unary minus). No dynamic code
 * execution — the expression is never turned into a function. Returns a
 * finite number, or null when the input is not a valid calculation.
 */
function evalExpr(raw) {
  const expr = String(raw == null ? "" : raw)
    .trim()
    .replace(/^[=]\s*/, "");
  if (expr.length === 0) return null;
  if (!/\d/.test(expr)) return null;
  if (!/[+\-*/%]/.test(expr)) return null;
  if (!CALC_ALLOWED.test(expr)) return null;
  let pos = 0;
  const skipWs = () => {
    while (pos < expr.length && expr[pos] === " ") pos++;
  };
  function parseFactor() {
    skipWs();
    if (expr[pos] === "-") {
      pos++;
      return -parseFactor();
    }
    if (expr[pos] === "(") {
      pos++;
      const v = parseExpression();
      skipWs();
      if (expr[pos] !== ")") throw new Error("unbalanced parens");
      pos++;
      return v;
    }
    const m = /^[0-9]+(\.[0-9]+)?/.exec(expr.slice(pos));
    if (!m) throw new Error("bad number");
    pos += m[0].length;
    return parseFloat(m[0]);
  }
  function parseTerm() {
    let v = parseFactor();
    for (;;) {
      skipWs();
      const c = expr[pos];
      if (c === "*" || c === "/" || c === "%") {
        pos++;
        const r = parseFactor();
        v = c === "*" ? v * r : c === "/" ? v / r : v % r;
      } else {
        return v;
      }
    }
  }
  function parseExpression() {
    let v = parseTerm();
    for (;;) {
      skipWs();
      const c = expr[pos];
      if (c === "+" || c === "-") {
        pos++;
        const r = parseTerm();
        v = c === "+" ? v + r : v - r;
      } else {
        return v;
      }
    }
  }
  try {
    const v = parseExpression();
    skipWs();
    if (pos !== expr.length) return null; // trailing garbage
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return Math.round(v * 1e10) / 1e10;
  } catch {
    return null;
  }
}

/** Read the paper as an array of expression lines (one per line). */
function readLines() {
  return main
    .readFile(PAPER_FILE)
    .then((s) =>
      String(s)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .catch(() => []);
}

async function clearRecords() {
  await main.writeFile(PAPER_FILE, "");
  main.toast("计算稿纸已清空 🧹");
}

// --- search results ------------------------------------------------------

main.onInput("paper", (_keyword, cb) => {
  cb([
    {
      text: "🧾 打开计算稿纸",
      description: "键盘即算 · 记录暂存 · 一键清空",
      icon: "🧾",
      data: { action: "open" },
    },
    {
      text: "🧹 清空全部计算记录",
      description: "删除 plugin-data 里的暂存稿纸",
      icon: "🧹",
      data: { action: "clear-all" },
    },
  ]);
});

main.onInput("稿纸", (_keyword, cb) => {
  cb([
    {
      text: "🧾 打开计算稿纸",
      description: "键盘即算 · 记录暂存 · 一键清空",
      icon: "🧾",
      data: { action: "open" },
    },
  ]);
});

function calcSearch(_keyword, value, cb) {
  const v = evalExpr(value);
  if (v === null) {
    cb([
      {
        text: "🧾 打开计算稿纸",
        description: `「${value}」不是合法表达式，回车进稿纸手算`,
        icon: "🧾",
        data: { action: "open", expr: value },
      },
    ]);
    return;
  }
  cb([
    {
      text: `🧾 ${value} = ${v}`,
      description: "回车打开稿纸并暂存这次计算",
      icon: "🧾",
      data: { action: "calc", expr: value, result: v },
    },
  ]);
}

main.onInputSearch("计算", calcSearch);
main.onInputSearch("calc", calcSearch);

// Messages from the detail view (e.g. record an inline calculation made in
// the search row before the detail opened).
main.onMainMessage((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "record" && msg.expr) {
    (async () => {
      const lines = await readLines();
      const expr = String(msg.expr).trim();
      if (expr && lines[lines.length - 1] !== expr) lines.push(expr);
      await main.writeFile(PAPER_FILE, lines.join("\n"));
      main.sendMainMessage({ type: "recorded", at: Date.now() });
    })().catch((e) => {
      main.sendMainMessage({
        type: "record-error",
        error: String((e && e.message) || e),
      });
    });
  } else if (msg.type === "clear-all") {
    clearRecords().catch((e) => {
      main.sendMainMessage({
        type: "clear-error",
        error: String((e && e.message) || e),
      });
    });
  }
});

main.onExit(() => {
  main.log("calc-paper detail view closed");
});

main.log("calc-paper plugin loaded");
