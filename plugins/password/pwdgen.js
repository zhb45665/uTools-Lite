/**
 * 随机密码生成 + 强度评估
 *
 * 单一实现，两个运行环境共用：
 *   - 插件沙箱 main.js:  require("./pwdgen.js")
 *   - 详情页 detail.html: <script src="pwdgen.js"></script> -> window.PwdGen
 *
 * 随机源一律用密码学安全 RNG（Node crypto.randomInt / 浏览器
 * crypto.getRandomValues），并做拒绝采样避免取模偏差——绝不用 Math.random。
 */
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PwdGen = api;
})(typeof window === "object" ? window : null, () => {
  const SETS = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{}<>?/",
  };
  /** 视觉上易混的字符（默认排除，减少手抄错误） */
  const AMBIGUOUS = "0OoIl1|`'\";:,.";
  const MIN_LENGTH = 4;
  const MAX_LENGTH = 128;

  let nodeCrypto = null;
  let nodeCryptoChecked = false;
  function getNodeCrypto() {
    if (!nodeCryptoChecked) {
      nodeCryptoChecked = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        nodeCrypto = require("node:crypto");
      } catch (_) {
        nodeCrypto = null;
      }
    }
    return nodeCrypto;
  }

  /** Uniform random integer in [0, n) — no modulo bias. */
  function randIndex(n) {
    if (!Number.isInteger(n) || n <= 0) throw new Error("randIndex: bad n");
    const nc = getNodeCrypto();
    if (nc && typeof nc.randomInt === "function") return nc.randomInt(n);
    const g = typeof globalThis === "object" ? globalThis.crypto : null;
    if (g && typeof g.getRandomValues === "function") {
      const limit = Math.floor(4294967296 / n) * n;
      const buf = new Uint32Array(1);
      let v = 0;
      do {
        g.getRandomValues(buf);
        v = buf[0];
      } while (v >= limit);
      return v % n;
    }
    throw new Error("没有可用的密码学随机源");
  }

  function pick(str) {
    return str[randIndex(str.length)];
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randIndex(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function filterSet(set, excludeAmbiguous) {
    if (!excludeAmbiguous) return set;
    let out = "";
    for (const ch of set) if (!AMBIGUOUS.includes(ch)) out += ch;
    return out;
  }

  const DEFAULTS = {
    length: 20,
    lower: true,
    upper: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: true,
    requireEach: true,
  };

  /**
   * Generate a password. Returns null only if no character set is usable.
   * @param {object} opts
   */
  function generatePassword(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    let length = Number(o.length);
    if (!Number.isFinite(length)) length = DEFAULTS.length;
    length = Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, Math.round(length)));

    let keys = ["lower", "upper", "digits", "symbols"].filter((k) => o[k]);
    if (keys.length === 0) keys = ["lower", "upper", "digits"];

    const pools = keys
      .map((k) => filterSet(SETS[k], o.excludeAmbiguous))
      .filter((s) => s.length > 0);
    if (pools.length === 0) return null;

    // 保证每类至少一个：长度不够就抬高到类别数
    if (o.requireEach) length = Math.max(length, pools.length);
    const all = pools.join("");
    const out = [];
    if (o.requireEach) for (const p of pools) out.push(pick(p));
    while (out.length < length) out.push(pick(all));
    return shuffle(out).join("");
  }

  /** Entropy-based strength estimate. */
  function strength(pw) {
    const s = String(pw == null ? "" : pw);
    if (!s) return { bits: 0, score: 0, label: "—", pool: 0 };
    let pool = 0;
    if (/[a-z]/.test(s)) pool += 26;
    if (/[A-Z]/.test(s)) pool += 26;
    if (/[0-9]/.test(s)) pool += 10;
    if (/[^A-Za-z0-9]/.test(s)) pool += 24;
    const bits = Math.round(s.length * Math.log2(pool || 1));
    const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
    return { bits, score, label: ["—", "弱", "中", "强", "很强"][score], pool };
  }

  return {
    SETS,
    AMBIGUOUS,
    MIN_LENGTH,
    MAX_LENGTH,
    DEFAULTS,
    generatePassword,
    strength,
  };
});
