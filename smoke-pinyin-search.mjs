// Standalone test for the pinyin search paths (no Electron needed).
// Mirrors the match logic in src/main/search.ts (apps) and
// src/main/file-index/local-index.ts (files) against pinyin-match.ts.
import {
  toPinyin,
  toPinyinInitials,
  pinyinHaystack,
} from "./src/main/pinyin-match.ts";

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? " — " + JSON.stringify(extra) : ""}`);
  }
}

// --- toPinyin -------------------------------------------------------------
check("toPinyin 微信", toPinyin("微信") === "weixin", toPinyin("微信"));
check("toPinyin 记事本", toPinyin("记事本") === "jishiben", toPinyin("记事本"));
check("toPinyin 设置", toPinyin("设置") === "shezhi", toPinyin("设置"));
check(
  "toPinyin mixed QQ音乐",
  toPinyin("QQ音乐") === "QQyinle",
  toPinyin("QQ音乐"),
);
check(
  "toPinyin ascii unchanged",
  toPinyin("Visual Studio Code") === "Visual Studio Code",
);
check("toPinyin lowercased input", toPinyin("微信abc") === "weixinabc");

// --- toPinyinInitials -------------------------------------------------------
check(
  "initials 微信",
  toPinyinInitials("微信") === "wx",
  toPinyinInitials("微信"),
);
check(
  "initials 记事本",
  toPinyinInitials("记事本") === "jsb",
  toPinyinInitials("记事本"),
);
check(
  "initials 计算器",
  toPinyinInitials("计算器") === "jsq",
  toPinyinInitials("计算器"),
);
check(
  "initials 设置",
  toPinyinInitials("设置") === "sz",
  toPinyinInitials("设置"),
);
check(
  "initials ascii run folded",
  toPinyinInitials("QQ音乐") === "qyl",
  toPinyinInitials("QQ音乐"),
);
check(
  "initials vsc",
  toPinyinInitials("Visual Studio Code") === "vsc",
  toPinyinInitials("Visual Studio Code"),
);

// --- pinyinHaystack ---------------------------------------------------------
check(
  "haystack 微信",
  pinyinHaystack("微信") === "微信weixin",
  pinyinHaystack("微信"),
);
check("haystack ascii passthrough", pinyinHaystack("Notepad") === "Notepad");

// --- app matching (same key shape as search.ts) -----------------------------
const { filter } = await import("fuzzaldrin-plus");
const apps = [
  "微信",
  "企业微信",
  "QQ音乐",
  "记事本",
  "计算器",
  "Visual Studio Code",
  "设置",
].map((name) => ({
  name,
  pinyin: pinyinHaystack(name) + " " + toPinyinInitials(name),
}));
const appHits = (q, max = 8) =>
  filter(apps, q, { key: "pinyin", maxResults: max }).map((a) => a.name);

check("app 微 hits 微信", appHits("微").includes("微信"), appHits("微"));
check("app wx hits 微信", appHits("wx").includes("微信"), appHits("wx"));
check(
  "app weixin hits 微信",
  appHits("weixin").includes("微信"),
  appHits("weixin"),
);
check(
  "app weix fuzzy hits 微信",
  appHits("weix").includes("微信"),
  appHits("weix"),
);
check("app jsb hits 记事本", appHits("jsb").includes("记事本"), appHits("jsb"));
check("app jsq hits 计算器", appHits("jsq").includes("计算器"), appHits("jsq"));
check("app sz hits 设置", appHits("sz").includes("设置"), appHits("sz"));
check(
  "app vsc hits VSCode",
  appHits("vsc").includes("Visual Studio Code"),
  appHits("vsc"),
);
check(
  "app 记事本 hits 记事本",
  appHits("记事本").includes("记事本"),
  appHits("记事本"),
);
check("app qq hits QQ音乐", appHits("qq").includes("QQ音乐"), appHits("qq"));
check("app 中文 query 不被拼音误吞", appHits("微").length >= 1);

// --- local index search (replicates the scoring loop in local-index.ts) ------
function searchLocalFixture(query, limit = 15) {
  // Fixture mirrors addEntry(): keys = name + last-3 dirs (lowercased),
  // py/pyinit only for CJK names.
  const entries = [
    {
      full: "D:\\work\\微信截图 2024-01-01.png",
      name: "微信截图 2024-01-01.png",
      dirs: ["work", "d", "drive"],
    },
    {
      full: "D:\\work\\report.pdf",
      name: "report.pdf",
      dirs: ["work", "d", "drive"],
    },
    {
      full: "E:\\资料\\季度报告.docx",
      name: "季度报告.docx",
      dirs: ["资料", "e", "drive"],
    },
    {
      full: "E:\\资料\\notes.txt",
      name: "notes.txt",
      dirs: ["资料", "e", "drive"],
    },
    { full: "F:\\a\\b\\微信.pdf", name: "微信.pdf", dirs: ["b", "a", "f"] },
  ];
  const orig = entries.map((e) => e.full);
  const keys = entries.map(
    (e) => e.name.toLowerCase() + " " + e.dirs.join(" "),
  );
  const py = entries.map((e) =>
    /[一-鿿]/.test(e.name) ? toPinyin(e.name.toLowerCase()) : "",
  );
  const pyinit = entries.map((e) =>
    /[一-鿿]/.test(e.name) ? toPinyinInitials(e.name.toLowerCase()) : "",
  );

  const needle = query.toLowerCase().trim();
  const n = orig.length;
  const cap = limit * 3;
  const top = [];
  const pyRelevant = /[a-z0-9]/.test(needle);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    let score;
    const plainP = k.indexOf(needle);
    if (plainP !== -1) {
      const firstSpace = k.indexOf(" ");
      if (plainP < firstSpace) {
        score = plainP === 0 ? 100 : 80;
        if (plainP === 0 || k.charCodeAt(plainP - 1) === 32) score += 10;
      } else {
        score = 30;
        if (k.charCodeAt(plainP - 1) === 32) score += 10;
      }
    } else if (pyRelevant) {
      if (py[i].indexOf(needle) !== -1) score = 90;
      else if (pyinit[i].indexOf(needle) === -1) continue;
      else score = 85;
    } else {
      continue;
    }
    const len = orig[i].length;
    const worst = top[top.length - 1];
    if (top.length < cap) top.push({ score, len, idx: i });
    else if (
      worst &&
      (score > worst.score || (score === worst.score && len < worst.len))
    )
      top[top.length - 1] = { score, len, idx: i };
    else continue;
    let j = top.length - 1;
    while (j > 0) {
      const a = top[j - 1];
      const b = top[j];
      if (a.score > b.score || (a.score === b.score && a.len <= b.len)) break;
      top[j - 1] = b;
      top[j] = a;
      j--;
    }
  }
  top.sort((a, b) => b.score - a.score || a.len - b.len || a.idx - b.idx);
  return top.slice(0, limit).map((t) => orig[t.idx]);
}

check(
  "file plain 中文 still works",
  searchLocalFixture("微信").includes("F:\\a\\b\\微信.pdf"),
);
check(
  "file pinyin jidu hits 季度报告",
  searchLocalFixture("jidu").includes("E:\\资料\\季度报告.docx"),
  searchLocalFixture("jidu"),
);
check(
  "file initials jdbg hits 季度报告",
  searchLocalFixture("jdbg").includes("E:\\资料\\季度报告.docx"),
  searchLocalFixture("jdbg"),
);
check(
  "file ascii unchanged: pdf",
  searchLocalFixture("pdf").length >= 2,
  searchLocalFixture("pdf"),
);
check(
  "file no false pinyin hit for rpt",
  searchLocalFixture("rpt").length === 0,
  searchLocalFixture("rpt"),
);
check(
  "file pinyin weixin hits 微信.pdf",
  searchLocalFixture("weixin").includes("F:\\a\\b\\微信.pdf"),
  searchLocalFixture("weixin"),
);
check(
  "file pure-ascii query skips pinyin path",
  searchLocalFixture("report").includes("D:\\work\\report.pdf"),
);

console.log(failures ? `\n${failures} failure(s)` : "\nall tests passed");
process.exit(failures ? 1 : 0);
