/**
 * unit — unit conversion with a detail view + message bridge + net demo.
 *
 * Demonstrates:
 *   - fast inline result via onInputSearch ("unit 5km" -> 3.108837 mi)
 *   - detail view with a full conversion UI
 *   - message bridge: detail.html asks main.js to compute (and vice versa)
 *   - net permission: optional web lookup (fails gracefully offline)
 */

// factor to "base" unit (meter / kilogram / celsius)
const LENGTH = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  mi: 1609.344,
};
const WEIGHT = {
  mg: 0.000001,
  g: 0.001,
  kg: 1,
  t: 1000,
  oz: 0.0283495,
  lb: 0.453592,
};

function convert(value, from, to, table) {
  if (!(from in table) || !(to in table)) return null;
  return (value * table[from]) / table[to];
}

function autoTable(unit) {
  return unit in LENGTH ? LENGTH : unit in WEIGHT ? WEIGHT : null;
}

// Inline quick result: "unit 5km2mi"
main.onInputSearch("unit", (keyword, value, cb) => {
  const m = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:->|to|=)\s*([a-z]+)$/i);
  if (m) {
    const v = parseFloat(m[1]);
    const from = m[2].toLowerCase();
    const to = m[3].toLowerCase();
    const table = autoTable(from);
    const r = table ? convert(v, from, to, table) : null;
    if (r !== null) {
      cb([
        {
          text: `${v} ${from} = ${round(r)} ${to}`,
          description: "回车打开完整换算器",
          icon: "📐",
          data: { value: v, from, to },
        },
      ]);
      return;
    }
  }
  cb([
    {
      text: "📐 打开单位换算器",
      description: "长度 / 重量 / 温度",
      icon: "📐",
      data: { value: "", from: "", to: "" },
    },
  ]);
});

function round(x) {
  return Math.round(x * 1e8) / 1e8;
}

main.onInput("换算", (keyword, cb) => {
  cb([
    {
      text: "📐 打开单位换算器",
      description: "长度 / 重量 / 温度",
      icon: "📐",
      data: {},
    },
  ]);
});

// Message bridge: the detail view asks main.js to compute.
main.onMainMessage((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "convert") {
    const { value, from, to, kind } = msg;
    let r = null;
    if (kind === "temp") {
      r = convertTemp(parseFloat(value), from, to);
    } else {
      const table = kind === "weight" ? WEIGHT : LENGTH;
      r = convert(parseFloat(value), from, to, table);
    }
    main.sendMainMessage({
      type: "result",
      reqId: msg.reqId,
      result: r === null ? null : round(r),
    });
  } else if (msg.type === "web-lookup") {
    // net permission demo: ask the host to fetch on our behalf.
    main
      .fetch("https://www.baidu.com", { method: "GET" })
      .then((res) => {
        main.sendMainMessage({
          type: "web-result",
          reqId: msg.reqId,
          ok: res.ok,
          status: res.status,
          bytes: res.body.length,
        });
      })
      .catch((e) => {
        main.sendMainMessage({
          type: "web-result",
          reqId: msg.reqId,
          ok: false,
          error: String(e.message || e),
        });
      });
  } else if (msg.type === "copy-result" && typeof msg.text === "string") {
    main.copyText(msg.text).then(() => main.toast("结果已复制 ✅"));
  }
});

// Temperature conversions (celsius as base).
function convertTemp(v, from, to) {
  let c;
  if (from === "c") c = v;
  else if (from === "f") c = ((v - 32) * 5) / 9;
  else if (from === "k") c = v - 273.15;
  else return null;
  if (to === "c") return c;
  if (to === "f") return (c * 9) / 5 + 32;
  if (to === "k") return c + 273.15;
  return null;
}

main.onExit(() => {
  main.log("unit detail view closed");
});

main.log("unit plugin loaded");
