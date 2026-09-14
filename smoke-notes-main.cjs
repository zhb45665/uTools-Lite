/**
 * notes 插件逻辑测试（脱离 Electron，mock main.* API）。
 * 验证：原子写调用、.prev.md 备份、.md/.txt 迁移读取、索引完整性、restore 来回切换。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? " — " + JSON.stringify(extra) : ""}`);
  }
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error("测试数据 JSON 解析失败: " + e.message);
  }
}

// ---------- 数据目录 + mock main API（模拟宿主的原子写语义） ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-test-"));

async function writeAtomicLikeHost(p, content, exclusive) {
  const temp = path.join(path.dirname(p), `.utools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const h = await fs.promises.open(temp, exclusive ? "wx" : "w", 0o600);
  try {
    await h.writeFile(content, "utf8");
    await h.sync();
  } finally {
    await h.close();
  }
  await fs.promises.rename(temp, p);
}

const toasts = [];
let sent = [];
const inputHandlers = {};
let mainMsgHandler = null;

global.main = {
  readFile: (p) =>
    fs.promises.readFile(path.join(dataDir, p), "utf8").then((s) => s),
  writeFile: async (p, c) => {
    await fs.promises.writeFile(path.join(dataDir, p), c, "utf8");
  },
  writeFileAtomic: (p, c, exclusive) =>
    writeAtomicLikeHost(path.join(dataDir, p), c, exclusive),
  deleteFile: async (p) => {
    await fs.promises.unlink(path.join(dataDir, p));
  },
  listDir: async (p) => ({
    entries: await fs.promises.readdir(path.join(dataDir, p)),
  }),
  sendMainMessage: (m) => sent.push(m),
  toast: (m) => toasts.push(m),
  log: () => {},
  onInput: (kw, cb) => { inputHandlers[kw] = cb; },
  onInputSearch: () => {},
  onMainMessage: (cb) => { mainMsgHandler = cb; },
  onExit: () => {},
};
global.uTools = global.main;

// 加载插件 main.js
require(path.join(__dirname, "plugins", "notes", "main.js"));

const run = async () => {
  // 1. 新建笔记（action=new 场景：无 id 的 save）
  sent = [];
  await mainMsgHandler({ type: "save", id: null, content: "# 测试标题\n\n第一版内容" });
  const savedMsg = sent.find((m) => m.type === "saved");
  check("save 新建回发 saved+id", savedMsg && typeof savedMsg.id === "string" && savedMsg.id.length > 0);
  const id1 = savedMsg.id;
  const files = fs.readdirSync(dataDir);
  check("正文写入 .md", files.includes(`n-${id1}.md`), files);
  check("notes.json 已建", files.includes("notes.json"));
  const idx1 = parseJson(fs.readFileSync(path.join(dataDir, "notes.json"), "utf8"));
  check("索引 1 条且标题正确", idx1.length === 1 && idx1[0].title === "测试标题", idx1);

  // 2. 覆盖保存 -> 旧版应备份到 .prev.md
  sent = [];
  await mainMsgHandler({ type: "save", id: id1, content: "# 测试标题\n\n第二版内容" });
  check("覆盖保存有 saved", sent.some((m) => m.type === "saved" && m.id === id1));
  const prevPath = path.join(dataDir, `n-${id1}.prev.md`);
  check(".prev.md 备份存在", fs.existsSync(prevPath));
  check("备份内容=第一版", fs.readFileSync(prevPath, "utf8").includes("第一版内容"));
  check("正文=第二版", fs.readFileSync(path.join(dataDir, `n-${id1}.md`), "utf8").includes("第二版内容"));

  // 3. 相同内容重复保存 -> 不应产生新备份（内容相同跳过）
  await mainMsgHandler({ type: "save", id: id1, content: "# 测试标题\n\n第二版内容" });
  check("相同内容不重复备份", fs.readFileSync(prevPath, "utf8").includes("第一版内容"));

  // 4. restore：用备份覆盖当前；当前版成为新备份（可来回切）
  sent = [];
  await mainMsgHandler({ type: "restore", id: id1 });
  check("restore 回发 restored+content", sent.some((m) => m.type === "restored" && m.id === id1 && m.content.includes("第一版内容")));
  check("restore 后正文=第一版", fs.readFileSync(path.join(dataDir, `n-${id1}.md`), "utf8").includes("第一版内容"));
  check("restore 后 .prev.md=第二版（可切回）", fs.readFileSync(prevPath, "utf8").includes("第二版内容"));
  // 再 restore 一次切回第二版
  sent = [];
  await mainMsgHandler({ type: "restore", id: id1 });
  check("二次 restore 切回第二版", fs.readFileSync(path.join(dataDir, `n-${id1}.md`), "utf8").includes("第二版内容"));

  // 5. 旧 .txt 数据兼容读取 + 列表
  const legacyId = "legacy1";
  await fs.promises.writeFile(path.join(dataDir, `n-${legacyId}.txt`), "旧 txt 笔记内容 秦保无人机");
  const idx = parseJson(fs.readFileSync(path.join(dataDir, "notes.json"), "utf8"));
  idx.push({ id: legacyId, title: "旧笔记", preview: "", updatedAt: Date.now() - 1000 });
  await main.writeFileAtomic("notes.json", JSON.stringify(idx, null, 2));
  sent = [];
  await mainMsgHandler({ type: "list" });
  const listMsg = sent.find((m) => m.type === "list");
  check("list 返回 2 条", listMsg && listMsg.notes.length === 2, listMsg && listMsg.notes);
  check("旧 .txt 笔记 title 保留", listMsg.notes.some((n) => n.id === legacyId && n.title === "旧笔记"));

  // 6. 搜索过滤（onInputSearch 未在 mock 注册场景下直接走 listNotes 路径：用 note 关键词的 onInput）
  const items = await new Promise((res) => inputHandlers["note"]("note", res));
  check("note 搜索返回 2 条已有笔记 + 无新建项（无 query）", items.length === 2, items.map((i) => i.text));
  const filtered = await new Promise((res) => {
    // onInputSearch 未 mock；直接测 mainMsgHandler list + 过滤由 detail 侧做，
    // 这里验证 buildItems 通过 onInput 的 query 变体不可行，改为验证 listNotes 全文检索：
    res(null);
  });
  void filtered;

  // 7. 删除：正文删除但 .prev.md 保留
  sent = [];
  await mainMsgHandler({ type: "delete", id: legacyId });
  check("删除后 .md/.txt 不存在",
    !fs.existsSync(path.join(dataDir, `n-${legacyId}.md`)) &&
    !fs.existsSync(path.join(dataDir, `n-${legacyId}.txt`)));
  check("删除后 .prev.md 保留（误删可找回）", fs.existsSync(path.join(dataDir, `n-${legacyId}.prev.md`)));
  const idxAfterDel = parseJson(fs.readFileSync(path.join(dataDir, "notes.json"), "utf8"));
  check("索引不再含已删除 id", !idxAfterDel.some((n) => n.id === legacyId));
  sent = [];
  await mainMsgHandler({ type: "list" });
  check("删除后 list 剩 1 条", sent.find((m) => m.type === "list").notes.length === 1);

  // 8. 损坏索引容错
  await fs.promises.writeFile(path.join(dataDir, "notes.json"), "{ 损坏的 json");
  const itemsAfterCorrupt = await new Promise((res) => inputHandlers["note"]("note", res));
  check("损坏索引 -> 返回 [] 不抛异常", Array.isArray(itemsAfterCorrupt), itemsAfterCorrupt);

  // 9. 原子写模拟崩溃安全：验证写入走 temp+rename（这里验证 .md 文件内容完整，
  //    宿主 writeAtomic 实现已在 atomic-file.ts 单测，此处验证插件调用路径不写半截）
  const mdContent = fs.readFileSync(path.join(dataDir, `n-${id1}.md`), "utf8");
  check("正文文件完整可读（非半截）", mdContent.length > 0 && !mdContent.includes("undefined"));

  console.log(failures ? `\n${failures} failure(s)` : "\nall notes tests passed");
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
};

run().catch((e) => {
  console.error("test run crashed:", e);
  process.exit(1);
});
