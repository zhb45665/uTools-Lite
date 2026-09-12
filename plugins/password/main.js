/**
 * password (密码本) — 密码管理 + 随机密码生成
 *
 * 安全模型：
 *   · 明文条目只存在于沙箱内存 + 页面内存；磁盘上只有 AES-256-GCM 密文包
 *   · 主密码经 scrypt 派生密钥，本身不落盘、只在解锁期间留在沙箱内存
 *   · 无操作 5 分钟自动锁定；关掉面板不立即锁（沙箱 10 分钟闲置才回收）
 *   · 复制密码类敏感内容后 30 秒自动清空剪贴板（仅当内容没被改写）
 *   · 搜索结果里绝不出现密码明文（只出现名称 / 账号）
 *
 * 转换/生成实现与详情页共用：pwdgen.js（页面用它即时生成）
 */
const crypto = require("node:crypto");
const vault = require("./vault.js");
const pwdgen = require("./pwdgen.js");

const VAULT_FILE = "vault.json";
const AUTO_LOCK_MS = 5 * 60 * 1000;
const CLIP_CLEAR_MS = 30 * 1000;
const MIN_MASTER = 6;

let master = null; // 主密码（仅内存）
let entries = []; // 明文条目（仅内存）
let lockTimer = null;
let clipTimer = null;

// ---------------------------------------------------------------- lifecycle

function touchLockTimer() {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => lock("idle"), AUTO_LOCK_MS);
}

function lock(reason) {
  master = null;
  entries = [];
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  main.sendMainMessage({ type: "locked", reason: reason || "manual" });
}

const isUnlocked = () => master !== null;

async function readBlob() {
  try {
    const txt = await main.readFile(VAULT_FILE);
    try {
      const parsed = JSON.parse(txt);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  } catch {
    return null; // 还没有密码本
  }
}

async function persist() {
  if (!isUnlocked()) throw new Error("未解锁");
  const blob = vault.encryptVault(master, { version: vault.VERSION, entries });
  await main.writeFile(VAULT_FILE, JSON.stringify(blob));
}

function findEntry(id) {
  return entries.find((e) => e.id === id) || null;
}

function normalizeEntry(raw) {
  const e = raw && typeof raw === "object" ? raw : {};
  return {
    title: String(e.title || "").trim(),
    username: String(e.username || "").trim(),
    password: String(e.password || ""),
    url: String(e.url || "").trim(),
    note: String(e.note || "").trim(),
  };
}

// ---------------------------------------------------------------- messages

function reply(id, payload) {
  main.sendMainMessage(Object.assign({ id, type: "res" }, payload));
}

async function handleMessage(msg) {
  const id = msg.id;
  try {
    switch (msg.type) {
      case "status": {
        const blob = await readBlob();
        reply(id, {
          unlocked: isUnlocked(),
          hasVault: !!blob,
          entries,
          autoLockMs: AUTO_LOCK_MS,
          clipClearMs: CLIP_CLEAR_MS,
        });
        return;
      }
      case "create": {
        const m = String(msg.master || "");
        if (m.length < MIN_MASTER) {
          reply(id, { error: `主密码至少 ${MIN_MASTER} 位` });
          return;
        }
        if (await readBlob()) {
          reply(id, { error: "已存在密码本，请直接解锁" });
          return;
        }
        master = m;
        entries = [];
        await persist();
        touchLockTimer();
        reply(id, { unlocked: true, entries });
        return;
      }
      case "unlock": {
        const blob = await readBlob();
        if (!blob) {
          reply(id, { error: "还没有密码本，请先设置主密码" });
          return;
        }
        const attempt = String(msg.master || "");
        try {
          const data = vault.decryptVault(attempt, blob);
          master = attempt;
          entries = Array.isArray(data.entries) ? data.entries : [];
        } catch {
          // GCM 认证失败：密码错或文件被动过，两者都不会泄露信息
          reply(id, { error: "主密码错误（或密码本已损坏）" });
          return;
        }
        touchLockTimer();
        reply(id, { unlocked: true, entries });
        return;
      }
      case "lock": {
        lock("manual");
        reply(id, { locked: true });
        return;
      }
      case "save": {
        if (!isUnlocked()) {
          reply(id, { error: "未解锁" });
          return;
        }
        const data = normalizeEntry(msg.entry);
        if (!data.title) {
          reply(id, { error: "名称不能为空" });
          return;
        }
        const now = Date.now();
        const existing = msg.entry && msg.entry.id ? findEntry(msg.entry.id) : null;
        if (existing) {
          Object.assign(existing, data, { updatedAt: now });
        } else {
          entries.push(
            Object.assign({ id: crypto.randomUUID(), createdAt: now }, data, {
              updatedAt: now,
            }),
          );
        }
        await persist();
        touchLockTimer();
        reply(id, { saved: true, entries });
        return;
      }
      case "delete": {
        if (!isUnlocked()) {
          reply(id, { error: "未解锁" });
          return;
        }
        entries = entries.filter((e) => e.id !== String(msg.id || ""));
        await persist();
        touchLockTimer();
        reply(id, { deleted: true, entries });
        return;
      }
      case "copy": {
        const text = String(msg.text == null ? "" : msg.text);
        if (!text) {
          reply(id, { error: "没有可复制的内容" });
          return;
        }
        await main.copyText(text);
        touchLockTimer();
        if (clipTimer) {
          clearTimeout(clipTimer);
          clipTimer = null;
        }
        if (msg.sensitive) {
          clipTimer = setTimeout(() => {
            void (async () => {
              try {
                const cur = await main.getClipboardText();
                if (cur === text) await main.copyText("");
              } catch {
                /* clipboard gone; nothing to clean */
              }
            })();
          }, CLIP_CLEAR_MS);
        }
        reply(id, { copied: true, clearInMs: msg.sensitive ? CLIP_CLEAR_MS : 0 });
        return;
      }
      default:
        reply(id, { error: `未知请求: ${msg.type}` });
    }
  } catch (e) {
    reply(id, { error: String((e && e.message) || e) });
  }
}

main.onMainMessage((msg) => {
  if (!msg || typeof msg !== "object" || msg.type === "res") return;
  void handleMessage(msg);
});

// ---------------------------------------------------------------- search

function openItems() {
  return [
    {
      text: "🔐 打开密码本",
      description: isUnlocked()
        ? `已解锁 · ${entries.length} 条记录`
        : "需要主密码解锁（AES-256-GCM 本地加密）",
      icon: "🔐",
      data: { action: "vault" },
    },
    {
      text: "🔑 生成随机密码",
      description: "长度 / 字符集可调，双击结果复制",
      icon: "🔑",
      data: { action: "generator" },
    },
  ];
}

main.onInput("密码", (_k, cb) => cb(openItems()));
main.onInput("password", (_k, cb) => cb(openItems()));
main.onInput("pwd", (_k, cb) => cb(openItems()));

function searchVault(_keyword, value, cb) {
  const q = String(value || "").trim().toLowerCase();
  if (!isUnlocked()) {
    cb([
      {
        text: "🔐 密码本未解锁",
        description: "回车打开并输入主密码",
        icon: "🔐",
        data: { action: "vault", filter: q },
      },
    ]);
    return;
  }
  const hits = entries.filter((e) => {
    if (!q) return true;
    return `${e.title} ${e.username} ${e.url || ""}`.toLowerCase().includes(q);
  });
  if (hits.length === 0) {
    cb([
      {
        text: "🔐 没有匹配的记录",
        description: `「${value}」· 回车打开密码本`,
        icon: "🔐",
        data: { action: "vault", filter: q },
      },
    ]);
    return;
  }
  // 注意：搜索结果里只出现名称/账号，绝不出现密码明文
  cb(
    hits.slice(0, 8).map((e) => ({
      text: `🔐 ${e.title}`,
      description: `${e.username || "（无账号）"} · 回车打开密码本`,
      icon: "🔐",
      data: { action: "vault", filter: q, entryId: e.id },
    })),
  );
}

main.onInputSearch("密码", searchVault);
main.onInputSearch("password", searchVault);

main.onInputSearch("生成密码", (_keyword, value, cb) => {
  const len = Number(String(value || "").replace(/[^\d]/g, "")) || 20;
  const pw = pwdgen.generatePassword({ length: len });
  const st = pwdgen.strength(pw);
  cb([
    {
      text: `🔑 ${pw}`,
      description: `${String(pw).length} 位 · ${st.label}（约 ${st.bits} 位熵）· 回车打开生成器`,
      icon: "🔑",
      data: { action: "generator", length: len },
    },
  ]);
});

main.onExit(() => {
  main.log("password detail view closed");
});

main.log("password plugin loaded");
