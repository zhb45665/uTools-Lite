/**
 * P2 plugin-system smoke test (run: npx electron smoke-plugins-main.js)
 *
 * Verifies the acceptance items of 离线方案文档.md §17.2 that are testable
 * without a human at the keyboard:
 *   - discovery of the 3 builtin plugins
 *   - keyword match -> lazy sandbox spawn -> ready handshake
 *   - input / inputSearch -> result items
 *   - select with detail view -> openedDetail
 *   - detailCapability fs gate: data dir free, no-perm rejected
 *   - module gate: a plugin requiring "fs" fails with [sandbox] message
 *   - detail context
 *
 * Prints PASS/FAIL lines and exits 1 on any failure.
 */

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

// Fake launcher window: permission prompts would be sent here.
const sentEvents = [];
const fakeWin = {
  isVisible: () => true,
  show() {},
  hide() {},
  webContents: {
    send: (channel, payload) => sentEvents.push([channel, payload]),
  },
};

app.whenReady().then(async () => {
  const { createPluginManager } = require("./dist/main/plugins/manager");
  const {
    assertInside,
    resolvePluginPath,
  } = require("./dist/main/plugins/permissions");

  try {
    const pm = createPluginManager(() => fakeWin);
    pm.init();

    // --- discovery
    const list = pm.list();
    check(
      "discover 4 builtin plugins",
      list.length === 4,
      list.map((p) => p.id),
    );
    check(
      "plugin ids",
      list.every((p) =>
        ["hello", "notes", "unit", "calc-paper"].includes(p.id),
      ),
      list.map((p) => p.id),
    );
    const notes = list.find((p) => p.id === "notes");
    check(
      "notes declares fs+clipboard",
      JSON.stringify(notes.permissions) === JSON.stringify(["fs", "clipboard"]),
      notes.permissions,
    );
    const paper = list.find((p) => p.id === "calc-paper");
    check(
      "calc-paper declares fs",
      JSON.stringify(paper.permissions) === JSON.stringify(["fs"]),
      paper.permissions,
    );

    // --- pure path validation (no traversal)
    let traversalBlocked = false;
    try {
      assertInside("C:\\data", "C:\\data-evil\\x.txt");
    } catch (e) {
      traversalBlocked = /escapes/.test(e.message);
    }
    check("assertInside blocks sibling-prefix traversal", traversalBlocked);
    check(
      "relative path resolves into plugin data dir",
      resolvePluginPath("notes", "a/b.txt")
        .toLowerCase()
        .includes("plugin-data") &&
        resolvePluginPath("notes", "a/b.txt").includes(
          path.join("notes", "a", "b.txt"),
        ),
      resolvePluginPath("notes", "a/b.txt"),
    );

    // --- keyword match + lazy spawn + input
    const hiItems = await pm.searchPlugins("hello");
    check(
      "input: 'hello' returns greet item",
      hiItems.length === 1 && /招呼/.test(hiItems[0].title),
      hiItems,
    );

    // --- inputSearch (lazy spawn on first hit)
    const noteItems = await pm.searchPlugins("note hello");
    check(
      "inputSearch: 'note hello' -> 新建笔记",
      noteItems.length === 1 && /新建笔记：hello/.test(noteItems[0].title),
      noteItems,
    );
    check(
      "plugin status running after spawn",
      pm.get("notes").status === "running",
      pm.get("notes"),
    );

    // --- calc-paper: input items + inline evaluation
    const paperItems = await pm.searchPlugins("paper");
    check(
      "input: 'paper' -> 打开稿纸 + 一键清空",
      paperItems.length === 2 &&
        /打开计算稿纸/.test(paperItems[0].title) &&
        /清空/.test(paperItems[1].title),
      paperItems,
    );
    const calcItems = await pm.searchPlugins("计算 2+2*3");
    check(
      "inputSearch: '计算 2+2*3' -> inline 2+2*3 = 8",
      calcItems.length === 1 && /2\+2\*3 = 8/.test(calcItems[0].title),
      calcItems,
    );

    // --- unit inline math via regex in plugin
    const unitItems = await pm.searchPlugins("unit 5km->mi");
    check(
      "inputSearch: 'unit 5km->mi' inline result",
      unitItems.length === 1 &&
        /5 km = 3\.10685596 mi/.test(unitItems[0].title),
      unitItems,
    );

    // --- no keyword hit
    const none = await pm.searchPlugins("zzz-no-plugin");
    check("non-matching query -> no plugin items", none.length === 0, none);

    // --- select opens detail view
    const sel = await pm.handleSelect(noteItems[0]);
    check(
      "select notes item -> openedDetail",
      !!sel.openedDetail && sel.openedDetail.detail === "detail.html",
      sel,
    );
    const ctx = pm.detailContext();
    check(
      "detail context has keyword+value+item",
      ctx &&
        ctx.pluginId === "notes" &&
        ctx.keyword === "note" &&
        ctx.value === "hello" &&
        !!ctx.item,
      ctx,
    );

    // --- capability gate via detail path
    const w = await pm.detailCapability("notes", "fs.write", {
      path: "smoke.txt",
      content: "hello-p2",
    });
    check("detail fs.write into data dir", w && w.ok === true, w);
    const rd = await pm.detailCapability("notes", "fs.read", {
      path: "smoke.txt",
    });
    check("detail fs.read roundtrip", rd && rd.content === "hello-p2", rd);

    // --- permission model: hello has NO fs permission
    let noPermRejected = false;
    try {
      await pm.detailCapability("hello", "fs.read", { path: "x.txt" });
    } catch (e) {
      noPermRejected = /no "fs" permission/.test(e.message);
    }
    check("fs on undeclared permission -> rejected", noPermRejected);

    // --- clipboard declared on notes
    const cbText = await pm.detailCapability("notes", "clipboard.read", {});
    check(
      "clipboard.read allowed on notes",
      cbText && typeof cbText.text === "string",
      cbText,
    );

    // --- module gate: bad plugin that requires('fs') at load
    const userRoot = pm.userPluginsRoot();
    const badDir = path.join(userRoot, "badplug");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "uTLS.json"),
      JSON.stringify({
        id: "badplug",
        name: "Bad Plug",
        main: "main.js",
        keywords: ["badplug"],
        permissions: [],
      }),
    );
    fs.writeFileSync(
      path.join(badDir, "main.js"),
      'const fs = require("fs");\nmain.log("nope");\n',
    );
    pm.rescan();
    const badItems = await pm.searchPlugins("badplug");
    check(
      "module gate: require('fs') -> error item with [sandbox] message",
      badItems.length === 1 &&
        /sandbox.*blocked/i.test(badItems[0].subtitle || ""),
      badItems,
    );
    check(
      "bad plugin marked error",
      pm.get("badplug").status === "error",
      pm.get("badplug"),
    );

    // cleanup bad plugin (its sandbox just died; Windows may still hold the cwd)
    for (let i = 0; ; i++) {
      try {
        fs.rmSync(badDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i >= 9 || e.code !== "EBUSY") throw e;
        const end = Date.now() + 200;
        while (Date.now() < end) {
          /* spin */
        }
      }
    }
    pm.rescan();
    check("rescan removes uninstalled plugin", !pm.get("badplug"));

    // --- exit event to renderer (toast from hello plugin)
    const greet = await pm.searchPlugins("hello");
    await pm.handleSelect(greet[0]);
    await new Promise((r) => setTimeout(r, 300));
    const toastEvt = sentEvents.find(([ch]) => ch === "plugin:evt-toast");
    check(
      "hello onSelect -> toast event to renderer",
      !!toastEvt,
      sentEvents.map((e) => e[0]),
    );

    pm.shutdown();
  } catch (e) {
    failures++;
    console.log("FAIL  unhandled smoke error —", e && e.stack ? e.stack : e);
  }

  console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
});
