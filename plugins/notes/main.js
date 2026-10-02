/**
 * notes — 多文档随手笔记（Markdown 详情视图 + 数据安全四件套）。
 *
 * 存储结构（插件私有目录，免授权）：
 *   plugin-data/notes/notes.json       [{ id, title, updatedAt, preview }]
 *   plugin-data/notes/n-<id>.md        每篇笔记正文（Markdown；旧 .txt 自动迁移读取）
 *   plugin-data/notes/n-<id>.prev.md   上一版正文备份（覆盖/删除前自动保留）
 *
 * 数据安全：
 *   - 所有写入走 writeFileAtomic（temp + rename + flush，半截文件不可能）
 *   - 每次覆盖保存前先把旧正文备份到 .prev.md；删除同样先备份
 *   - detail 页实现 beforeClose 协商（dirty 时拦截，保存失败可"继续编辑"）
 *
 * 搜索结果页：
 *   note / memo            -> 新建笔记 + 全部已有笔记（按更新时间倒序）
 *   note <kw> / 笔记 <kw>  -> 新建：<kw> + 按标题/内容过滤的已有笔记
 *
 * 详情视图（detail.html）与本文件通过消息桥通信：
 *   list   -> { type:"list", notes: [...] }
 *   save   { id?, content }  有 id 覆盖保存（先备份）；无 id 新建并回发 id
 *   delete { id }            先备份到 .prev.md 再删除，回发剩余列表
 *   restore { id }           用 .prev.md 覆盖当前正文（覆盖前当前版也备份）
 */

const INDEX_FILE = "notes.json";

function mdFile(id) {
  return `n-${id}.md`;
}
function txtFile(id) {
  return `n-${id}.txt`;
}
function prevFile(id) {
  return `n-${id}.prev.md`;
}

async function loadIndex() {
  try {
    const raw = await main.readFile(INDEX_FILE);
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr;
  } catch {
    /* 首次使用或索引损坏 */
  }
  return [];
}

async function saveIndex(notes) {
  // 原子写：notes.json 永远要么是旧版要么是新版，不会半截
  await main.writeFileAtomic(INDEX_FILE, JSON.stringify(notes, null, 2));
}

/**
 * Read a note's body. Prefers .md; transparently falls back to the legacy
 * .txt so pre-upgrade data keeps working. Returns null when neither exists.
 */
async function readNote(id) {
  for (const f of [mdFile(id), txtFile(id)]) {
    try {
      return await main.readFile(f);
    } catch {
      /* try next */
    }
  }
  return null;
}

function previewOf(content) {
  return String(content || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~>\-|]/g, " ")
    .replace(/\[([^]]*)\]\([^)]*\)/g, "$1")
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function titleOf(content, fallback) {
  const first = String(content || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^#{1,6}\s+/, ""))
    .find((l) => l.length > 0);
  return (first || fallback || "未命名笔记").slice(0, 30);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function listNotes(query) {
  const notes = await loadIndex();
  let out = [];
  for (const n of notes) {
    const content = (await readNote(n.id)) ?? "";
    out.push({ ...n, content });
  }
  if (query) {
    const q = String(query).toLowerCase();
    out = out.filter(
      (n) =>
        (n.title || "").toLowerCase().includes(q) ||
        (n.content || "").toLowerCase().includes(q),
    );
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

function toListItem(n) {
  return {
    id: n.id,
    title: n.title || "未命名笔记",
    updatedAt: n.updatedAt || 0,
    preview: n.preview || previewOf(n.content),
  };
}

async function pushListToDetail() {
  const notes = await listNotes("");
  main.sendMainMessage({ type: "list", notes: notes.map(toListItem) });
}

// ------------------------------------------------------------------ 搜索
function buildItems(query) {
  return listNotes(query).then((notes) => {
    const items = notes.map((n) => ({
      text: `📝 ${n.title || "未命名笔记"}`,
      description: n.preview ? `${n.preview}…` : "（空笔记）",
      icon: "📝",
      data: { action: "open", id: n.id },
    }));
    if (!query) {
      items.unshift({
        text: "打开随手笔记",
        description: notes.length ? `${notes.length} 篇笔记 · 独立窗口` : "新建第一篇笔记",
        icon: "📝",
        data: { action: "new", value: "" },
      });
    }
    if (query) {
      items.push({
        text: `✏️ 新建笔记：${query}`,
        description: "回车打开详情视图并填入内容",
        icon: "✏️",
        data: { action: "new", value: query },
      });
    }
    return items;
  });
}

main.onInput("note", (_keyword, cb) => {
  buildItems("")
    .then(cb)
    .catch((e) =>
      cb([{ text: `❌ 加载笔记失败：${e.message || e}`, icon: "⚠️" }]),
    );
});

main.onInputSearch("note", (_keyword, value, cb) => {
  buildItems(value)
    .then(cb)
    .catch((e) => cb([{ text: `❌ 搜索失败：${e.message || e}`, icon: "⚠️" }]));
});

main.onInput("memo", (_keyword, cb) => {
  buildItems("")
    .then(cb)
    .catch((e) =>
      cb([{ text: `❌ 加载笔记失败：${e.message || e}`, icon: "⚠️" }]),
    );
});

// ------------------------------------------------------------------ 详情视图消息
main.onMainMessage(async (msg) => {
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.type === "list") {
      await pushListToDetail();
    } else if (msg.type === "save" && typeof msg.content === "string") {
      const notes = await loadIndex();
      let id = typeof msg.id === "string" && msg.id ? msg.id : null;
      const idx = id ? notes.findIndex((n) => n.id === id) : -1;
      const now = Date.now();
      const title = titleOf(msg.content);
      const preview = previewOf(msg.content);

      if (idx >= 0) {
        // 覆盖保存已有笔记：先把旧版正文备份到 .prev.md（原子写），再原子写入新版
        const old = await readNote(id);
        if (old !== null && old !== msg.content) {
          await main.writeFileAtomic(prevFile(id), old);
        }
        notes[idx].title = title || notes[idx].title;
        notes[idx].preview = preview;
        notes[idx].updatedAt = now;
        await main.writeFileAtomic(mdFile(id), msg.content);
        await saveIndex(notes);
        main.sendMainMessage({ type: "saved", id, at: now, requestId: msg.requestId });
        main.toast("笔记已保存 ✅");
      } else {
        // 新建（或索引里找不到 -> 降级新建）
        id = newId();
        notes.unshift({ id, title, preview, updatedAt: now });
        await main.writeFileAtomic(mdFile(id), msg.content);
        await saveIndex(notes);
        // 先把最终 id 交给 detail，再推全量列表，避免 detail 侧空窗
        main.sendMainMessage({ type: "saved", id, at: now, requestId: msg.requestId });
        main.toast("笔记已创建 ✅");
      }
      await pushListToDetail();
    } else if (msg.type === "delete" && msg.id) {
      const notes = await loadIndex();
      const idx = notes.findIndex((n) => n.id === msg.id);
      if (idx >= 0) notes.splice(idx, 1);
      await saveIndex(notes);
      // 删除前先备份正文到 .prev.md（原子写），误删可手动从插件数据目录找回
      const body = await readNote(msg.id);
      if (body !== null) {
        await main.writeFileAtomic(prevFile(msg.id), body);
      }
      for (const f of [mdFile(msg.id), txtFile(msg.id)]) {
        try {
          await main.deleteFile(f);
        } catch {
          /* 文件已不存在则忽略 */
        }
      }
      main.toast("笔记已删除 🗑（已备份到 .prev.md）");
      await pushListToDetail();
    } else if (msg.type === "restore" && msg.id) {
      // 用上一版备份覆盖当前正文；覆盖前当前版也先备份（可来回切）
      const id = String(msg.id);
      const prev = await main.readFile(prevFile(id)).catch(() => null);
      if (prev === null) {
        main.sendMainMessage({
          type: "restore-error",
          error: "没有上一版备份可恢复",
        });
        return;
      }
      const cur = await readNote(id);
      if (cur !== null && cur !== prev) {
        await main.writeFileAtomic(prevFile(id), cur);
      }
      await main.writeFileAtomic(mdFile(id), prev);
      const notes = await loadIndex();
      const idx = notes.findIndex((n) => n.id === id);
      if (idx >= 0) {
        notes[idx].title = titleOf(prev) || notes[idx].title;
        notes[idx].preview = previewOf(prev);
        notes[idx].updatedAt = Date.now();
        await saveIndex(notes);
      }
      main.sendMainMessage({ type: "restored", id, content: prev });
      main.toast("已恢复到上一版 ⏪");
      await pushListToDetail();
    }
  } catch (e) {
    main.sendMainMessage({
      type: "save-error",
      error: String(e.message || e),
      requestId: msg && msg.requestId,
    });
  }
});

main.onExit(() => {
  main.log("notes detail view closed");
});

main.log("notes plugin loaded (markdown + atomic safety)");
