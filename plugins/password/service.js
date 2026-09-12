/* Serialized encrypted credential storage. Never publish uncommitted records. */
const crypto = require("node:crypto");
const vault = require("./vault.js");
const records = require("./records.js");
const FILE = "vault.json", AUTO_LOCK_MS = 300000, CLIP_CLEAR_MS = 30000;
let master = null, entries = [], lastText = null, epoch = 0;
let lockTimer = null, clipTimer = null, queue = Promise.resolve();
const unlocked = () => master !== null;
function touch() {
  if (!unlocked()) return;
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => lock("idle"), AUTO_LOCK_MS);
}
function lock(reason) {
  epoch++; master = null; entries = []; lastText = null;
  clearTimeout(lockTimer); lockTimer = null;
  main.sendMainMessage({ type: "locked", reason });
}
function guard() { if (!unlocked()) throw new Error("密码本已锁定，请重新解锁"); }
async function read(file = FILE) {
  try { return await main.readFile(file); }
  catch (e) {
    if (/\bENOENT\b/.test(String(e.message || e))) return null;
    throw new Error("无法读取密码本，请检查文件权限；原文件未改动");
  }
}
function parse(text) {
  try {
    const b = JSON.parse(text);
    if (!b || b.version !== 1 || !b.kdf || !b.iv || !b.tag || typeof b.data !== "string") throw new Error();
    return b;
  } catch { throw new Error("密码本文件损坏，请恢复加密备份；不要重新创建"); }
}
function decrypt(text, key) {
  const blob = parse(text);
  let data;
  try { data = vault.decryptVault(key, blob); }
  catch { throw new Error("主密码错误，或密码本已损坏"); }
  return { data, loaded: records.decode(data) };
}
async function commit(next, key = master, creating = false) {
  const revision = epoch;
  if (!key) throw new Error("密码本已锁定");
  const current = await read();
  if (creating ? current !== null : current !== lastText)
    throw new Error("密码本文件已变化，请重新解锁后保存；原文件未覆盖");
  const encrypted = JSON.stringify(vault.encryptVault(key, { version: records.SCHEMA_VERSION, entries: next }));
  if (current !== null) {
    const { data } = decrypt(current, key);
    await main.writeFileAtomic("vault.previous.json", current);
    if (data.version === 1 && await read("vault.legacy-v1.json") === null)
      await main.writeFileAtomic("vault.legacy-v1.json", current, true);
  }
  if (epoch !== revision) throw new Error("保存期间已锁定，请重新解锁确认记录");
  await main.writeFileAtomic(FILE, encrypted, creating);
  if (epoch !== revision) throw new Error("记录已写入，密码本已锁定，请重新解锁查看");
  master = key; entries = next; lastText = encrypted; touch();
}
function reply(requestId, payload) { main.sendMainMessage({ ...payload, type: "res", requestId }); }
async function copy(text, sensitive) {
  if (!text) throw new Error("没有可复制的内容");
  await main.copyText(text);
  clearTimeout(clipTimer); clipTimer = null;
  if (sensitive) clipTimer = setTimeout(() => {
    void (async () => { try { if (await main.getClipboardText() === text) await main.copyText(""); } catch {} })();
  }, CLIP_CLEAR_MS);
  touch();
  return { copied: true, clearInMs: sensitive ? CLIP_CLEAR_MS : 0 };
}
async function handle(msg) {
  const id = msg.requestId;
  try {
    switch (msg.type) {
      case "status": {
        const text = await read();
        let storageError = "";
        if (text !== null) { try { parse(text); } catch (e) { storageError = e.message; } }
        reply(id, { unlocked: unlocked(), hasVault: text !== null, storageError, entries, autoLockMs: AUTO_LOCK_MS, clipClearMs: CLIP_CLEAR_MS });
        break;
      }
      case "create": {
        const key = String(msg.master || "");
        if (key.length < 8) throw new Error("新主密码至少 8 位");
        await commit([], key, true); reply(id, { unlocked: true, entries }); break;
      }
      case "unlock": {
        const revision = epoch, text = await read(), key = String(msg.master || "");
        if (text === null) throw new Error("未找到密码本，请创建或恢复备份");
        const { loaded } = decrypt(text, key);
        if (epoch !== revision) throw new Error("解锁已取消");
        master = key; entries = loaded; lastText = text; touch();
        reply(id, { unlocked: true, entries }); break;
      }
      case "activity": guard(); touch(); reply(id, { ok: true }); break;
      case "save": {
        guard();
        const e = records.normalize(msg.entry); records.validate(e);
        const old = e.id ? entries.find(x => x.id === e.id) : null;
        if (e.id && !old) throw new Error("记录已不存在，请刷新后重试");
        const now = Date.now(), saved = { ...e, id: old?.id || crypto.randomUUID(), createdAt: old?.createdAt || now, updatedAt: now };
        await commit(old ? entries.map(x => x.id === old.id ? saved : x) : [...entries, saved]);
        reply(id, { saved: true, entries, entryId: saved.id }); break;
      }
      case "delete": {
        guard();
        if (!entries.some(e => e.id === msg.entryId)) throw new Error("记录已不存在");
        await commit(entries.filter(e => e.id !== msg.entryId));
        reply(id, { deleted: true, entries }); break;
      }
      case "favorite": {
        guard();
        if (!entries.some(e => e.id === msg.entryId)) throw new Error("记录已不存在");
        await commit(entries.map(e => e.id === msg.entryId ? { ...e, favorite: !e.favorite } : e));
        reply(id, { entries }); break;
      }
      case "copy": {
        guard();
        const e = entries.find(e => e.id === msg.entryId);
        if (!e) throw new Error("记录已不存在");
        if (msg.field !== "ssh" && !["host", "port", "username", "password", "url", "keyPath"].includes(msg.field)) throw new Error("不支持复制此字段");
        reply(id, await copy(msg.field === "ssh" ? records.sshCommand(e) : String(e[msg.field] || ""), msg.field === "password")); break;
      }
      case "copyGenerated": reply(id, await copy(String(msg.text || ""), true)); break;
      case "backup": {
        guard(); const text = await read();
        if (text !== lastText) throw new Error("文件已变化，请重新解锁后备份");
        reply(id, await main.saveEncryptedBackup(text)); break;
      }
      case "pickBackup": reply(id, await main.pickEncryptedBackup()); break;
      case "restore": {
        if (msg.confirm !== true) throw new Error("请确认恢复备份");
        const text = String(msg.encrypted || ""), key = String(msg.master || "");
        if (text.length > 10 * 1024 * 1024) throw new Error("备份文件过大");
        const { loaded } = decrypt(text, key);
        const revision = epoch, current = await read();
        if (current !== null) await main.writeFileAtomic(`vault.before-restore-${Date.now()}.json`, current, true);
        const encrypted = JSON.stringify(vault.encryptVault(key, { version: records.SCHEMA_VERSION, entries: loaded }));
        if (epoch !== revision) throw new Error("恢复已取消");
        await main.writeFileAtomic(FILE, encrypted, current === null);
        if (epoch !== revision) throw new Error("恢复已完成，请重新解锁");
        master = key; entries = loaded; lastText = encrypted; touch();
        reply(id, { unlocked: true, entries, restored: true }); break;
      }
      default: throw new Error("未知请求");
    }
  } catch (e) { reply(id, { error: String(e.message || e) }); }
}
main.onMainMessage(msg => {
  if (!msg || typeof msg !== "object" || !Number.isSafeInteger(msg.requestId)) return;
  if (msg.type === "lock") { lock("manual"); reply(msg.requestId, { locked: true }); return; }
  const revision = epoch;
  queue = queue.then(() => {
    if (epoch !== revision) { reply(msg.requestId, { error: "操作已取消，请重新解锁" }); return; }
    return handle(msg);
  }).catch(() => main.log("credential request failed"));
});
function openItems() {
  return [
    { text: "打开密码本", description: unlocked() ? `服务器与普通账号 · ${entries.length} 条` : "服务器与普通账号 · 主密码解锁", data: { action: "vault" } },
    { text: "生成随机密码", description: "按需生成并复制", data: { action: "generator" } },
  ];
}
for (const keyword of ["密码", "密码本", "密码管理", "password", "pwd", "服务器"]) {
  main.onInput(keyword, (_kw, cb) => cb(openItems()));
  main.onInputSearch(keyword, (_kw, value, cb) => {
    const filter = String(value || "").trim();
    if (!unlocked()) { cb([{ text: "密码本未解锁", description: "回车打开并输入主密码", data: { action: "vault", filter } }]); return; }
    const hits = entries.filter(e => records.matches(e, filter));
    cb(hits.length ? hits.slice(0, 8).map(e => ({ text: e.title, description: [records.address(e), e.group, records.environments[e.environment]].filter(Boolean).join(" · "), data: { action: "vault", filter, entryId: e.id } })) : [{ text: "没有匹配的凭据", description: "回车打开密码本", data: { action: "vault", filter } }]);
  });
}
main.onInput("生成密码", (_kw, cb) => cb([{ text: "生成随机密码", data: { action: "generator" } }]));
main.onInputSearch("生成密码", (_kw, value, cb) => {
  const length = Math.max(4, Math.min(64, Number(String(value).replace(/\D/g, "")) || 20));
  cb([{ text: `生成 ${length} 位随机密码`, description: "回车打开生成器", data: { action: "generator", length } }]);
});
main.onExit(() => {});
main.log("password plugin loaded");
