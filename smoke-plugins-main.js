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
    // Self-heal: a previous run may have left its throwaway plugin behind
    // (Windows keeps the dir locked while a sandbox holds it as cwd), and
    // discovery below would then report an unexpected plugin.
    for (const stale of ["cmdplug", "badplug"]) {
      try {
        fs.rmSync(path.join(pm.userPluginsRoot(), stale), {
          recursive: true,
          force: true,
        });
      } catch {
        /* still locked; the run below will surface it */
      }
    }
    pm.init();

    // --- discovery
    const list = pm.list();
    check(
      "discover 3 builtin plugins",
      list.length === 3,
      list.map((p) => p.id),
    );
    check(
      "plugin ids",
      list.every((p) => ["notes", "calc-paper", "amount"].includes(p.id)),
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
      "calc-paper declares fs+clipboard",
      JSON.stringify(paper.permissions) === JSON.stringify(["fs", "clipboard"]),
      paper.permissions,
    );
    const amount = list.find((p) => p.id === "amount");
    check(
      "amount declares clipboard",
      JSON.stringify(amount.permissions) === JSON.stringify(["clipboard"]),
      amount.permissions,
    );
    check("amount plugin ships detail view", amount.hasDetail === true, amount);
    const revMissing = pm.reveal("no-such-plugin");
    check(
      "reveal 未知插件 -> 返回错误而非静默",
      revMissing.ok === false && /不存在/.test(revMissing.error || ""),
      revMissing,
    );

    // --- 金额大写转换算法（官方票据例子 + 边界 + 非法输入）
    const conv = require("./plugins/amount/convert.js");
    const convCases = [
      ["1234.56", "壹仟贰佰叁拾肆元伍角陆分"],
      ["1409.50", "壹仟肆佰零玖元伍角整"],
      ["6007.14", "陆仟零柒元壹角肆分"],
      ["107000.53", "壹拾万柒仟元伍角叁分"],
      ["10000", "壹万元整"],
      ["100.05", "壹佰元零伍分"],
      ["0", "零元整"],
      ["100000001", "壹亿零壹元整"],
      ["-1234.5", "负壹仟贰佰叁拾肆元伍角整"],
      ["¥1,234.56", "壹仟贰佰叁拾肆元伍角陆分"],
      ["１２３４．５６", "壹仟贰佰叁拾肆元伍角陆分"],
      ["1.005", "壹元零壹分"],
      ["0.999", "壹元整"],
      [
        "99999999999.99",
        "玖佰玖拾玖亿玖仟玖佰玖拾玖万玖仟玖佰玖拾玖元玖角玖分",
      ],
    ];
    const convBad = convCases.filter(
      ([input, want]) => conv.toCapitalAmount(input) !== want,
    );
    check(
      "金额大写转换 14/14（含票据例子/全角/负数/四舍五入）",
      convBad.length === 0,
      convBad.map(([i]) => `${i} -> ${conv.toCapitalAmount(i)}`),
    );
    check(
      "非法金额被拒绝（空/字母/IP/多小数点）",
      ["", "abc", "192.168.1.1", "1.2.3", "1e5"].every(
        (s) => conv.toCapitalAmount(s) === null,
      ),
    );
    check(
      "规范小写 = 千分位两位小数",
      conv.formatCurrency("1234.5") === "¥1,234.50" &&
        conv.formatCurrency("-1234.5") === "-¥1,234.50",
      [conv.formatCurrency("1234.5"), conv.formatCurrency("-1234.5")],
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

    // --- keyword match + lazy spawn + input (pure `keyword` -> onInput)
    const noteHit = await pm.searchPlugins("note");
    check(
      "input: 'note' -> 打开随手笔记",
      noteHit.length === 2 && /打开随手笔记/.test(noteHit[0].title),
      noteHit.map((i) => i.title),
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

    // --- combined search: bare expression -> 计算稿纸 first, copy kept
    const { runSearch } = require("./dist/main/search");
    const rs = await runSearch("2+2*3");
    check(
      "expression search -> calc-paper item first (opens 稿纸)",
      !!rs.commands[0] &&
        rs.commands[0].pluginId === "calc-paper" &&
        /2\+2\*3 = 8/.test(rs.commands[0].title),
      rs.commands.map((c) => c.title),
    );
    check(
      "expression search keeps copy-result command",
      rs.commands.some((c) => c.type === "command" && c.payload === "8"),
      rs.commands.map((c) => c.type),
    );

    // --- 金额大写：插件关键词 + 搜索层集成
    const amountItems = await pm.searchPlugins("金额 1234.56");
    check(
      "inputSearch: '金额 1234.56' -> 大写金额",
      amountItems.length === 1 &&
        /壹仟贰佰叁拾肆元伍角陆分/.test(amountItems[0].title),
      amountItems.map((i) => i.title),
    );
    const rsAmount = await runSearch("¥1,234.56");
    check(
      "粘贴 ¥1,234.56 -> 金额大写项排第一",
      !!rsAmount.commands[0] &&
        rsAmount.commands[0].pluginId === "amount" &&
        /壹仟贰佰叁拾肆元伍角陆分/.test(rsAmount.commands[0].title),
      rsAmount.commands.map((c) => c.title),
    );
    const rsPlainInt = await runSearch("2024");
    check(
      "纯整数 2024 不触发金额（不抢文件/应用搜索）",
      !rsPlainInt.commands.some((c) => c.pluginId === "amount"),
      rsPlainInt.commands.map((c) => c.title),
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

    // --- permission model: amount declares only clipboard (no fs)
    let noPermRejected = false;
    try {
      await pm.detailCapability("amount", "fs.read", { path: "x.txt" });
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

    // --- pure-command plugin (no detail view): select runs it + toasts.
    //     Coverage kept via a throwaway user plugin now that the builtin
    //     hello demo plugin is gone.
    const cmdDir = path.join(pm.userPluginsRoot(), "cmdplug");
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdDir, "uTLS.json"),
      JSON.stringify({
        id: "cmdplug",
        name: "Cmd Plug",
        main: "main.js",
        keywords: ["cmdplug"],
        permissions: [],
      }),
    );
    fs.writeFileSync(
      path.join(cmdDir, "main.js"),
      'main.onInput("cmdplug", (k, cb) => cb([{ text: "CMD 执行", icon: "⚡", data: {} }]));\n' +
        'main.onSelect(() => main.toast("纯命令插件已执行 ✅"));\n',
    );
    pm.rescan();
    const cmdItems = await pm.searchPlugins("cmdplug");
    check(
      "纯命令插件 keyword 命中",
      cmdItems.length === 1 && /CMD/.test(cmdItems[0].title),
      cmdItems,
    );
    await pm.handleSelect(cmdItems[0]);
    await new Promise((r) => setTimeout(r, 400));
    const toastEvt = sentEvents.find(([ch]) => ch === "plugin:evt-toast");
    check(
      "纯命令插件 onSelect -> toast 事件到渲染层",
      !!toastEvt,
      sentEvents.map((e) => e[0]),
    );
    // Kill the sandboxes FIRST: on Windows a live utilityProcess holds its
    // cwd, so the temp plugin dir stays locked (EBUSY) while the child runs.
    pm.shutdown();
    for (let i = 0; ; i++) {
      try {
        fs.rmSync(cmdDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i >= 9 || e.code !== "EBUSY") throw e;
        const end = Date.now() + 200;
        while (Date.now() < end) {
          /* spin */
        }
      }
    }
    check("清理临时命令插件目录", !fs.existsSync(cmdDir));
  } catch (e) {
    failures++;
    console.log("FAIL  unhandled smoke error —", e && e.stack ? e.stack : e);
  }

  console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
});
