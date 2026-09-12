/**
 * 金额大小写转换（阿拉伯数字 <-> 人民币中文大写）
 *
 * 单一实现，两个运行环境共用：
 *   - 插件沙箱 main.js:  require("./convert.js")
 *   - 详情页 detail.html: <script src="convert.js"></script> -> window.AmountConvert
 *
 * 规则遵循《正确填写票据和结算凭证的基本规定》：
 *   - 到"元"为止写"整"；到"角"为止写"整"；有"分"则不写"整"
 *   - 角位为 0 而分位不为 0 时，中间写一个"零"（如 100.05 -> 壹佰元零伍分）
 *   - 中间连续 0 只写一个"零"，组尾 0 不写（如 10000 -> 壹万元整）
 *   - 多于两位小数按四舍五入（字符串精确进位，不用浮点）
 */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmountConvert = api;
})(typeof window === "object" ? window : null, () => {
  const DIGITS = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
  const UNIT1 = ["", "拾", "佰", "仟"]; // 组内（万以内）
  const UNIT2 = ["", "万", "亿", "万亿"]; // 组间
  const MAX_DIGITS = 16;

  /** 全角转半角 + 去掉货币符号/千分位/单位等修饰。 */
  function tidy(raw) {
    return String(raw == null ? "" : raw)
      .trim()
      .replace(/[\uFF10-\uFF19]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0),
      )
      .replace(/\uFF0E/g, ".")
      .replace(/[\uFF0C\u3001]/g, ",")
      .replace(/[\uFF0D\u2212\u2013\u2014]/g, "-")
      .replace(/\uFF0B/g, "+");
  }

  function incDigits(s) {
    try {
      return (BigInt(s) + BigInt(1)).toString();
    } catch (_) {
      return s;
    }
  }

  /**
   * 解析成 { negative, intStr, decStr }；decStr 恒为 2 位（角分）。
   * 不是合法金额返回 null。
   */
  function normalizeAmount(raw) {
    let s = tidy(raw).replace(/人民币|RMB|CNY|￥|¥|\s|,|元|整|正/gi, "");
    if (!/\d/.test(s)) return null;
    let negative = false;
    const sign = /^([-+])/.exec(s);
    if (sign) {
      negative = sign[1] === "-";
      s = s.slice(1);
    }
    if (!/^\d*(?:\.\d*)?$/.test(s)) return null;

    const parts = s.split(".");
    let intStr = parts[0] || "";
    let decStr = parts[1] || "";
    intStr = intStr.replace(/^0+(?=\d)/, "");
    if (intStr === "") intStr = "0";
    if (intStr.length > MAX_DIGITS) return null;

    if (decStr.length > 2) {
      let cents = Number(decStr.slice(0, 2) || "0");
      if (Number(decStr[2]) >= 5) cents += 1;
      if (cents >= 100) {
        cents -= 100;
        intStr = incDigits(intStr);
      }
      decStr = String(cents).padStart(2, "0");
    }
    decStr = (decStr + "00").slice(0, 2);
    return { negative, intStr, decStr };
  }

  /** 整数部分 -> 中文大写（不含"元"）。 */
  function intToCapital(intStr) {
    const digits = String(intStr).replace(/^0+/, "");
    if (!digits) return "零";
    const groups = [];
    for (let end = digits.length; end > 0; end -= 4) {
      groups.unshift(digits.slice(Math.max(0, end - 4), end));
    }
    let out = "";
    const n = groups.length;
    for (let gi = 0; gi < n; gi++) {
      const g = groups[gi];
      const gu = UNIT2[n - 1 - gi] || "";
      let sec = "";
      let pendingZero = false;
      for (let j = 0; j < g.length; j++) {
        const d = Number(g[j]);
        if (d === 0) {
          pendingZero = true;
          continue;
        }
        if (pendingZero && sec !== "") sec += "零";
        pendingZero = false;
        sec += DIGITS[d] + UNIT1[g.length - 1 - j];
      }
      if (sec === "") {
        if (out !== "" && !out.endsWith("零")) out += "零";
      } else {
        if (out !== "" && g.length === 4 && g[0] === "0" && !out.endsWith("零")) {
          out += "零";
        }
        out += sec + gu;
      }
    }
    return out.replace(/零+$/, "") || "零";
  }

  /** 金额 -> 人民币大写（如 1234.56 -> 壹仟贰佰叁拾肆元伍角陆分）。 */
  function toCapitalAmount(raw) {
    const norm = normalizeAmount(raw);
    if (!norm) return null;
    const jiao = Number(norm.decStr[0]);
    const fen = Number(norm.decStr[1]);
    let out = intToCapital(norm.intStr) + "元";
    if (jiao === 0 && fen === 0) out += "整";
    else if (fen === 0) out += DIGITS[jiao] + "角整";
    else if (jiao === 0) out += "零" + DIGITS[fen] + "分";
    else out += DIGITS[jiao] + "角" + DIGITS[fen] + "分";
    const isZero = out === "零元整";
    return (norm.negative && !isZero ? "负" : "") + out;
  }

  /** 规范小写：千分位 + 两位小数（如 1,234.56）。 */
  function formatPlain(raw) {
    const norm = normalizeAmount(raw);
    if (!norm) return null;
    const sep = norm.intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (norm.negative ? "-" : "") + sep + "." + norm.decStr;
  }

  /** 带货币符号的规范写法：-¥1,234.56。 */
  function formatCurrency(raw) {
    const plain = formatPlain(raw);
    if (plain === null) return null;
    return plain.startsWith("-") ? "-¥" + plain.slice(1) : "¥" + plain;
  }

  return {
    normalizeAmount,
    intToCapital,
    toCapitalAmount,
    formatPlain,
    formatCurrency,
    MAX_DIGITS,
  };
});
