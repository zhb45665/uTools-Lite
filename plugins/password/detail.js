/* DOM-only view. Record copies are resolved by ID in the plugin process. */
const $ = id => document.getElementById(id);
let entries = [], selectedId = null, editingId = null, isUnlocked = false, creating = false;
let seq = 0, generation = 0, dirty = false, tab = "vault", restoreText = "", lastActivity = 0;
let confirmDone = null;
const pending = new Map();
const status = (text, error = false) => { $("status").textContent = text; $("status").classList.toggle("error", error); };
function call(type, payload = {}) {
  const requestId = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("操作超时，请重新打开密码本确认结果")); }, ["backup", "pickBackup"].includes(type) ? 125000 : 20000);
    pending.set(requestId, { resolve, reject, timer, generation });
    Promise.resolve(uTools.sendMainMessage({ ...payload, type, requestId })).catch(e => {
      const p = pending.get(requestId);
      if (p) { clearTimeout(timer); pending.delete(requestId); reject(e); }
    });
  });
}
uTools.onMainMessage(msg => {
  if (msg?.type === "locked") { onLocked(msg.reason); return; }
  const p = pending.get(msg?.requestId);
  if (!p) return;
  pending.delete(msg.requestId); clearTimeout(p.timer);
  if (p.generation !== generation) { p.reject(new Error("密码本已锁定")); return; }
  if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg);
});
function clearEditor() {
  $("editor").reset(); $("f-pass").value = ""; $("f-pass").type = "password";
  $("f-reveal").textContent = "显示"; $("f-err").textContent = "";
  editingId = null; dirty = false;
}
function onLocked(reason) {
  generation++; isUnlocked = false; entries = []; selectedId = null;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("密码本已锁定")); }
  pending.clear(); clearEditor();
  $("list").replaceChildren(); $("detail").replaceChildren(); $("group-options").replaceChildren();
  $("filter").value = ""; $("group-filter").replaceChildren(new Option("全部分组", ""));
  $("master").value = ""; $("master2").value = ""; $("genpw").textContent = "";
  $("editor").hidden = true; $("restore-dialog").close(); $("restore-form").reset(); restoreText = "";
  if (confirmDone) { confirmDone(false); confirmDone = null; } $("confirm-dialog").close();
  creating = false; $("confirm-master").hidden = true; $("unlockbtn").disabled = false;
  $("unlockbtn").textContent = "解锁"; $("locktitle").textContent = "已锁定，请输入主密码";
  tab = "vault"; syncView(); status(reason === "idle" ? "闲置超时，已清除页面中的凭据内容" : "已锁定");
  $("master").focus();
}
function syncView() {
  $("tab-vault").classList.toggle("active", tab === "vault");
  $("tab-gen").classList.toggle("active", tab === "gen");
  $("lockbox").hidden = tab !== "vault" || isUnlocked;
  $("workspace").hidden = tab !== "vault" || !isUnlocked;
  $("generator").hidden = tab !== "gen";
  $("lockbtn").hidden = !isUnlocked; $("backup").hidden = !isUnlocked;
}
function confirmAction(title, text, label = "确认") {
  $("confirm-title").textContent = title; $("confirm-text").textContent = text;
  $("confirm-yes").textContent = label; $("confirm-dialog").showModal(); $("confirm-no").focus();
  return new Promise(resolve => { confirmDone = resolve; });
}
function answerConfirm(ok) { const done = confirmDone; confirmDone = null; $("confirm-dialog").close(); done?.(ok); }
$("confirm-yes").onclick = () => answerConfirm(true);
$("confirm-no").onclick = () => answerConfirm(false);
$("confirm-dialog").addEventListener("cancel", e => { e.preventDefault(); answerConfirm(false); });
async function canLeave() { return !dirty || await confirmAction("放弃未保存的修改？", "当前表单还没有保存，离开后这些修改将丢失。", "放弃修改"); }
function listEntries() {
  const q = $("filter").value, type = $("type-filter").value, env = $("env-filter").value, group = $("group-filter").value;
  return entries.filter(e => Credentials.matches(e, q) && (!type || e.type === type) && (!env || e.environment === env) && (!group || e.group === group) && (!$("favorites").checked || e.favorite))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt);
}
function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
function button(text, fn, cls = "") { const b = element("button", cls, text); b.type = "button"; b.onclick = fn; return b; }
function badge(text, cls = "") { return element("span", "badge " + cls, text); }
function renderList() {
  const shown = listEntries();
  $("count").textContent = `${shown.length} / ${entries.length} 条凭据`;
  $("list").replaceChildren();
  if (!shown.length) $("list").append(element("div", "empty", entries.length ? "没有匹配的记录，试试其他条件。" : "还没有凭据，点击新建开始。"));
  for (const e of shown) {
    const row = button("", async () => {
      if (!await canLeave()) return;
      clearEditor(); $("editor").hidden = true; $("detail").hidden = false;
      selectedId = e.id; renderList(); renderDetail();
    }, "entry" + (selectedId === e.id ? " active" : ""));
    row.dataset.id = e.id;
    row.setAttribute("aria-pressed", String(selectedId === e.id));
    const title = element("div", "entry-title"); title.append(element("span", "", e.title), element("span", "", e.favorite ? "★" : ""));
    const sub = element("span", "entry-sub", e.type === "server" ? Credentials.address(e) : [e.username, e.url].filter(Boolean).join(" · "));
    sub.title = sub.textContent;
    const meta = element("div", "entry-meta");
    meta.append(badge(e.type === "server" ? Credentials.protocols[e.protocol] : "账号"));
    if (e.environment) meta.append(badge(Credentials.environments[e.environment], e.environment));
    if (e.group) meta.append(element("span", "", e.group));
    row.append(title, sub, meta); $("list").append(row);
  }
}
function refreshGroups() {
  const selected = $("group-filter").value;
  const groups = [...new Set(entries.map(e => e.group).filter(Boolean))].sort();
  $("group-filter").replaceChildren(new Option("全部分组", "")); $("group-options").replaceChildren();
  for (const g of groups) { $("group-filter").add(new Option(g, g)); $("group-options").append(new Option(g, g)); }
  $("group-filter").value = groups.includes(selected) ? selected : "";
}
function applyEntries(res) {
  entries = (res.entries || []).map(Credentials.normalize); isUnlocked = true;
  refreshGroups(); renderList(); renderDetail(); syncView();
}
async function copyField(e, field) {
  try {
    const res = await call("copy", { entryId: e.id, field });
    status(field === "password" ? `密码已复制，${Math.round(res.clearInMs / 1000)} 秒后清理剪贴板` : field === "ssh" ? "已复制 PowerShell SSH 命令（不含密码）" : "已复制");
  } catch (e) { status(e.message, true); }
}
function dataRow(label, value, e, field, secret = false) {
  const row = element("div", "data-row"); row.append(element("span", "label", label));
  if (secret) {
    const input = element("input", "secret mono"); input.type = "password"; input.readOnly = true;
    input.value = value; input.setAttribute("aria-label", "已保存的密码");
    const tools = element("div", "password-tools");
    const reveal = button("显示", () => { input.type = input.type === "password" ? "text" : "password"; reveal.textContent = input.type === "password" ? "显示" : "隐藏"; });
    tools.append(reveal, button("复制密码", () => copyField(e, field))); row.append(input, tools);
  } else {
    row.append(element("span", "data-value mono", value || "未填写"));
    if (field && value) row.append(button("复制" + label, () => copyField(e, field)));
  }
  return row;
}
function renderDetail() {
  const root = $("detail"); root.replaceChildren();
  const e = entries.find(e => e.id === selectedId);
  if (!e) { root.append(element("div", "empty", "选择一条凭据查看详情，或新建服务器记录。")); return; }
  const head = element("div", "detail-head"); head.append(element("h2", "", e.title), button(e.favorite ? "★ 已收藏" : "☆ 收藏", async () => {
    try { applyEntries(await call("favorite", { entryId: e.id })); } catch (err) { status(err.message, true); }
  })); root.append(head);
  const tags = element("div", "detail-tags"); tags.append(badge(e.type === "server" ? Credentials.protocols[e.protocol] : "普通账号"));
  if (e.environment) tags.append(badge(Credentials.environments[e.environment], e.environment));
  if (e.group) tags.append(badge(e.group)); root.append(tags);
  if (e.type === "server") {
    root.append(element("div", "connection", Credentials.address(e)), dataRow("地址", e.host, e, "host"), dataRow("端口", e.port, e, "port"));
  } else root.append(dataRow("网址", e.url, e, "url"));
  root.append(dataRow("账号", e.username, e, "username"));
  if (e.type === "server" && e.auth === "key") root.append(dataRow("密钥路径", e.keyPath, e, "keyPath"));
  root.append(dataRow("密码", e.password, e, "password", true));
  if (e.note) { const note = element("div", "notes"); note.append(element("small", "", "备注 / 连接说明"), document.createTextNode(e.note)); root.append(note); }
  const actions = element("div", "detail-actions");
  if (e.type === "server" && e.protocol === "ssh") actions.append(button("复制 SSH 命令", () => copyField(e, "ssh"), "primary"));
  actions.append(button("编辑", () => openEditor(e)), button("复制为新记录", () => openEditor(e, true)), button("删除", async () => {
    if (!await confirmAction("删除这条凭据？", `将删除「${e.title}」。确认名称与环境后再继续。`, "删除凭据")) return;
    try { const res = await call("delete", { entryId: e.id }); selectedId = null; applyEntries(res); status("已删除凭据，上一版已保留加密备份"); }
    catch (err) { status(err.message, true); }
  }, "danger")); root.append(actions, element("p", "detail-updated", e.updatedAt ? `更新于 ${new Date(e.updatedAt).toLocaleString("zh-CN")}` : "来自旧版密码本"));
}
const fieldMap = { type:"f-type",title:"f-title",group:"f-group",environment:"f-env",protocol:"f-protocol",auth:"f-auth",host:"f-host",port:"f-port",username:"f-user",url:"f-url",keyPath:"f-key",password:"f-pass",note:"f-note" };
function syncFields() {
  const server = $("f-type").value === "server", ssh = $("f-protocol").value === "ssh";
  if (!ssh) $("f-auth").value = "password";
  $("f-auth").querySelector('[value="key"]').disabled = !ssh;
  for (const el of document.querySelectorAll(".server-field")) el.hidden = !server;
  for (const el of document.querySelectorAll(".account-field")) el.hidden = server;
  for (const el of document.querySelectorAll(".key-field")) el.hidden = !(server && $("f-auth").value === "key");
  $("f-host").required = server; $("f-port").required = server;
  $("f-host").disabled = !server; $("f-port").disabled = !server;
  $("f-key").required = server && $("f-auth").value === "key";
  $("pass-label").textContent = server && $("f-auth").value === "key" ? "备用密码（可选，不会加入连接命令）" : "密码";
}
async function openEditor(record = null, duplicate = false) {
  if (!await canLeave()) return;
  clearEditor();
  const e = record ? Credentials.normalize(record) : Credentials.normalize({ type:"server",port:"22" });
  editingId = duplicate ? null : e.id || null;
  if (duplicate) e.title += "（副本）";
  for (const [field, id] of Object.entries(fieldMap)) $(id).value = e[field];
  $("editor-title").textContent = duplicate ? "复制为新记录" : record ? "编辑凭据" : "新建服务器 / 账号";
  $("editor").hidden = false; $("detail").hidden = true; syncFields(); $("f-title").focus();
}
async function closeEditor() {
  if (!await canLeave()) return;
  clearEditor(); $("editor").hidden = true; $("detail").hidden = false; renderDetail();
}
$("editor").addEventListener("input", () => { dirty = true; });
$("editor").addEventListener("change", () => { dirty = true; });
$("editor").onsubmit = async event => {
  event.preventDefault(); if (!isUnlocked) return;
  const old = entries.find(e => e.id === editingId);
  const entry = { ...old, id:editingId || undefined };
  for (const [field, id] of Object.entries(fieldMap)) entry[field] = $(id).value;
  $("f-save").disabled = true;
  try {
    Credentials.validate(Credentials.normalize(entry));
    const res = await call("save", { entry }); selectedId = res.entryId;
    clearEditor(); $("editor").hidden = true; $("detail").hidden = false;
    // A saved record must remain visible even if its grouping changed.
    $("filter").value = ""; $("type-filter").value = ""; $("env-filter").value = ""; $("group-filter").value = ""; $("favorites").checked = false;
    applyEntries(res); status("凭据已加密保存");
  } catch (err) { $("f-err").textContent = err.message; }
  finally { $("f-save").disabled = false; }
};
$("f-cancel").onclick = closeEditor; $("newbtn").onclick = () => openEditor();
$("f-type").onchange = syncFields; $("f-auth").onchange = syncFields;
$("f-protocol").onchange = () => {
  const port = $("f-port").value;
  if (!port || port === "22" || port === "3389") $("f-port").value = $("f-protocol").value === "rdp" ? "3389" : $("f-protocol").value === "ssh" ? "22" : "";
  syncFields();
};
$("f-reveal").onclick = () => { $("f-pass").type = $("f-pass").type === "password" ? "text" : "password"; $("f-reveal").textContent = $("f-pass").type === "password" ? "显示" : "隐藏"; };
$("f-gen").onclick = async () => {
  if ($("f-pass").value && !await confirmAction("生成新密码？", "这会替换当前表单中的密码，保存后才会修改记录。", "生成并替换")) return;
  if (!isUnlocked) return;
  $("f-pass").value = PwdGen.generatePassword({ length:20 }); dirty = true;
};
for (const id of ["filter", "type-filter", "env-filter", "group-filter", "favorites"]) $(id).addEventListener(id === "filter" ? "input" : "change", renderList);
$("unlock-form").onsubmit = async event => {
  event.preventDefault(); $("lockerr").textContent = "";
  if (creating && $("master").value !== $("master2").value) { $("lockerr").textContent = "两次主密码不一致"; return; }
  $("unlockbtn").disabled = true;
  try { const res = await call(creating ? "create" : "unlock", { master:$("master").value }); $("master").value = ""; $("master2").value = ""; creating = false; applyEntries(res); status("已解锁 · 密码默认隐藏"); }
  catch (err) { $("lockerr").textContent = err.message; }
  finally { $("unlockbtn").disabled = false; }
};
$("lockbtn").onclick = async () => { try { await call("lock"); } catch {} };
for (const name of ["vault", "gen"]) $("tab-" + name).onclick = async () => {
  if (!await canLeave()) return;
  clearEditor(); $("editor").hidden = true; $("detail").hidden = false;
  tab = name; if (name === "gen") regenerate(); syncView();
};
function regenerate() {
  try {
    const opts = { length:Number($("len").value), upper:$("opt-upper").checked, lower:$("opt-lower").checked, digits:$("opt-digits").checked, symbols:$("opt-symbols").checked, excludeAmbiguous:$("opt-amb").checked };
    $("lenval").textContent = opts.length;
    const pw = PwdGen.generatePassword(opts); $("genpw").textContent = pw;
    $("strength").textContent = `${pw.length} 位 · ${PwdGen.strength(pw).label}`;
  } catch (err) { $("genpw").textContent = ""; $("strength").textContent = err.message; }
}
$("regen").onclick = regenerate;
for (const id of ["len", "opt-upper", "opt-lower", "opt-digits", "opt-symbols", "opt-amb"]) $(id).oninput = regenerate;
$("gencopy").onclick = async () => { try { await call("copyGenerated", { text:$("genpw").textContent }); status("已复制生成密码，30 秒后清理剪贴板"); } catch (err) { status(err.message, true); } };
$("backup").onclick = async () => {
  $("backup").disabled = true;
  try { const res = await call("backup"); if (!res.canceled) status("加密备份已保存；恢复时需要当前主密码"); }
  catch (err) { status(err.message, true); } finally { $("backup").disabled = false; }
};
$("restore-open").onclick = async () => {
  if (!await canLeave()) return;
  $("restore-form").reset(); restoreText = ""; $("restore-name").textContent = "尚未选择"; $("restore-error").textContent = ""; $("restore-dialog").showModal();
};
$("restore-file").onclick = async () => {
  try { const res = await call("pickBackup"); if (!res.canceled) { restoreText = res.encrypted; $("restore-name").textContent = res.name; } }
  catch (err) { $("restore-error").textContent = err.message; }
};
function closeRestore() { $("restore-dialog").close(); $("restore-form").reset(); restoreText = ""; }
$("restore-cancel").onclick = closeRestore;
$("restore-dialog").addEventListener("cancel", e => { e.preventDefault(); closeRestore(); });
$("restore-form").onsubmit = async event => {
  event.preventDefault(); if (!restoreText) { $("restore-error").textContent = "请先选择加密备份文件"; return; }
  $("restore-submit").disabled = true;
  try {
    const res = await call("restore", { encrypted:restoreText, master:$("restore-master").value, confirm:$("restore-confirm").checked });
    closeRestore(); clearEditor(); selectedId = null; $("editor").hidden = true; $("detail").hidden = false;
    tab = "vault"; applyEntries(res); status("恢复完成，之后使用备份的主密码解锁");
  } catch (err) { $("restore-error").textContent = err.message; }
  finally { $("restore-submit").disabled = false; }
};
// Inactivity follows actual keyboard/pointer work, rather than only saves and copies.
for (const name of ["keydown", "pointerdown", "input"]) document.addEventListener(name, () => {
  if (isUnlocked && Date.now() - lastActivity > 15000) { lastActivity = Date.now(); void call("activity").catch(() => {}); }
}, { capture:true });
window.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if ($("confirm-dialog").open || $("restore-dialog").open || !$("editor").hidden) {
    event.preventDefault(); event.stopImmediatePropagation();
    if ($("confirm-dialog").open) answerConfirm(false);
    else if ($("restore-dialog").open) closeRestore();
    else void closeEditor();
  }
}, true);
window.addEventListener("pagehide", () => { onLocked("closed"); });
(async () => {
  try {
    const ctx = await uTools.getDetailContext();
    const data = ctx?.item?.data;
    if (data?.filter) $("filter").value = data.filter;
    if (data?.entryId) selectedId = data.entryId;
    if (data?.action === "generator") { tab = "gen"; if (data.length) $("len").value = data.length; regenerate(); }
    const res = await call("status");
    if (res.unlocked) applyEntries(res);
    else {
      creating = !res.hasVault; $("confirm-master").hidden = !creating;
      $("locktitle").textContent = creating ? "创建你的加密密码本" : "解锁你的凭据";
      $("unlockbtn").textContent = creating ? "创建密码本" : "解锁";
      $("master").minLength = creating ? 8 : 0;
      $("unlockbtn").disabled = !!res.storageError;
      if (res.storageError) $("lockerr").textContent = res.storageError;
      syncView();
    }
    status(res.storageError || (res.unlocked ? "已解锁 · 密码默认隐藏" : "本机加密保存 · 主密码不会上传"), !!res.storageError);
  } catch (err) { status(err.message, true); $("lockerr").textContent = "读取失败，原文件未改动。可重试或恢复加密备份。"; }
})();
