/**
 * Plugin sandbox bootstrap (runs inside utilityProcess, pure Node).
 *
 * Sequence:
 *   1. require our own deps + read the plugin manifest (gate not installed yet)
 *   2. install the module gate (blocks fs/net/child_process/... for the plugin)
 *   3. build the `main` API object, expose it as global main / uTools
 *   4. require the plugin's main.js
 *   5. emit `ready` (or `error` on load failure) to the host
 *
 * Env: UTL_PLUGIN_DIR = absolute path of the plugin folder.
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");
const rpc = require("./rpc");

const pluginDir = process.env.UTL_PLUGIN_DIR;
if (!pluginDir) {
  console.error("[bootstrap] UTL_PLUGIN_DIR not set");
  process.exit(1);
}

// ---------------------------------------------------------------- manifest
let manifest;
try {
  manifest = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "uTLS.json"), "utf8"),
  );
} catch (e) {
  rpc.emit("error", {
    message: `Failed to read uTLS.json: ${e.message}`,
    stack: String((e && e.stack) || ""),
  });
  process.exit(1);
}

// ------------------------------------------------------- module gate (L2)
const BLOCKED = new Set([
  "fs",
  "fs/promises",
  "net",
  "http",
  "https",
  "http2",
  "child_process",
  "dgram",
  "tls",
  "worker_threads",
  "cluster",
  "inspector",
]);

const origLoad = Module._load;
Module._load = function (request) {
  const bare = request.startsWith("node:") ? request.slice(5) : request;
  if (BLOCKED.has(bare)) {
    throw new Error(
      `[sandbox] Module "${request}" is blocked. Use the main.* API instead.`,
    );
  }
  return origLoad.apply(this, arguments);
};

// ------------------------------------------------------------ main.* API
function fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Invoke a plugin handler that may return items directly, return a promise,
 * or call the trailing `cb(items)` callback (uTools style).
 */
function callCollect(fn, args) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (items) => {
      if (done) return;
      done = true;
      resolve(normalizeItems(items));
    };
    try {
      const ret = fn(...args, finish);
      if (ret && typeof ret.then === "function") {
        ret.then(finish, (e) => {
          console.error("[sandbox] handler promise rejected", e);
          finish([]);
        });
      }
      // If the handler neither called cb nor returned a promise the host-side
      // request timeout will fire and return an empty result.
    } catch (e) {
      console.error("[sandbox] handler threw", e);
      finish([]);
    }
  });
}

function normalizeItems(items) {
  if (!Array.isArray(items)) items = [];
  return items
    .filter((it) => it && typeof it === "object" && typeof it.text === "string")
    .map((it) => ({
      text: it.text,
      icon: typeof it.icon === "string" ? it.icon : undefined,
      description:
        typeof it.description === "string" ? it.description : undefined,
      data: it.data === undefined ? undefined : it.data,
    }));
}

const inputHandlers = new Map(); // keyword(lower) -> handler(keyword, cb)
const searchHandlers = new Map(); // keyword(lower) -> handler(keyword, value, cb)
let selectHandler = null;
let mainMessageHandler = null;
let keydownHandler = null;
let exitHandler = null;

const main = {
  onInput(keyword, cb) {
    inputHandlers.set(String(keyword).toLowerCase(), cb);
  },
  onInputSearch(keyword, cb) {
    searchHandlers.set(String(keyword).toLowerCase(), cb);
  },
  onSelect(cb) {
    selectHandler = cb;
  },
  onMainMessage(cb) {
    mainMessageHandler = cb;
  },
  onKeydown(cb) {
    keydownHandler = cb;
  },
  onExit(cb) {
    exitHandler = cb;
  },

  sendMainMessage(data) {
    rpc.emit("mainMessage", { data });
  },
  toast(msg) {
    rpc.emit("toast", { msg: String(msg) });
  },
  log(...args) {
    rpc.emit("log", { level: "info", msg: args.map(fmt).join(" ") });
  },

  readFile(p) {
    return rpc
      .call("fs.read", { path: String(p) }, 10000)
      .then((r) => r.content);
  },
  writeFile(p, content) {
    return rpc.call(
      "fs.write",
      { path: String(p), content: String(content) },
      10000,
    );
  },
  listDir(p) {
    return rpc
      .call("fs.list", { path: String(p) }, 10000)
      .then((r) => r.entries);
  },

  getClipboardText() {
    return rpc.call("clipboard.read", {}, 5000).then((r) => r.text);
  },
  copyText(text) {
    return rpc.call("clipboard.write", { text: String(text) }, 5000);
  },

  fetch(url, options) {
    return rpc
      .call("net.fetch", { url: String(url), options: options || {} }, 30000)
      .then((r) => ({
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        body: r.body,
      }));
  },

  openPath(p) {
    return rpc.call("shell.openPath", { path: String(p) }, 5000);
  },
  getDataDir() {
    return rpc.call("data.dir", {}, 5000).then((r) => r.dir);
  },
};

globalThis.main = main;
globalThis.uTools = main; // alias for developers coming from uTools

// ------------------------------------------- host -> plugin request dispatch
rpc.onRequest("input", (params) => {
  const kw = String(params.keyword || "").toLowerCase();
  const cb = inputHandlers.get(kw);
  if (!cb) return { items: [] };
  return callCollect(cb, [params.keyword]).then((items) => ({ items }));
});

rpc.onRequest("inputSearch", (params) => {
  const kw = String(params.keyword || "").toLowerCase();
  const cb = searchHandlers.get(kw);
  if (!cb) return { items: [] };
  return callCollect(cb, [params.keyword, params.value]).then((items) => ({
    items,
  }));
});

rpc.onRequest("select", async (params) => {
  if (selectHandler) {
    await callCollect(selectHandler, [
      params.item,
      params.keyword,
      params.value,
    ]);
  }
  return { ok: true };
});

rpc.onRequest("keydown", (params) => {
  if (keydownHandler) {
    try {
      keydownHandler(params);
    } catch (e) {
      console.error("[sandbox] onKeydown handler threw", e);
    }
  }
  return { ok: true };
});

rpc.onRequest("exit", async () => {
  if (exitHandler) {
    try {
      await Promise.resolve(exitHandler());
    } catch (e) {
      console.error("[sandbox] onExit handler threw", e);
    }
  }
  return { ok: true };
});

// --------------------------------------------- host -> plugin event dispatch
rpc.onEvent("mainMessage", (params) => {
  if (mainMessageHandler) {
    try {
      mainMessageHandler(params.data);
    } catch (e) {
      console.error("[sandbox] onMainMessage handler threw", e);
    }
  }
});

rpc.onEvent("exit", () => {
  // Fired when the detail view closes: run plugin onExit cleanup but keep
  // the sandbox WARM (doc §7.4). Real reaping comes as an "exit" request
  // followed by kill(), or when the host terminates the process.
  if (exitHandler) {
    try {
      exitHandler();
    } catch {
      /* cleanup only */
    }
  }
});

// ------------------------------------------------------------- error paths
process.on("uncaughtException", (e) => {
  console.error("[sandbox] uncaughtException", e);
  rpc.emit("error", {
    message: String((e && e.message) || e),
    stack: String((e && e.stack) || ""),
  });
});

process.on("exit", () => {
  rpc.settleAllPending(new Error("sandbox shutting down"));
});

// ------------------------------------------------------------ load plugin
const entry = path.join(pluginDir, manifest.main || "main.js");
let loadError = null;
try {
  require(entry);
} catch (e) {
  loadError = e;
  console.error("[sandbox] failed to load plugin", e);
}

if (loadError) {
  rpc.emit("error", {
    message: `Failed to load ${manifest.main}: ${loadError.message}`,
    stack: String((loadError && loadError.stack) || ""),
  });
} else {
  rpc.emit("ready", {
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
  });
}
