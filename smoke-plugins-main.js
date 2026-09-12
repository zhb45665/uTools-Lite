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
    for (const stale of ["cmdplug", "capplug", "badplug"]) {
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
      "discover 4 builtin plugins",
      list.length === 4,
      list.map((p) => p.id),
    );
    check(
      "plugin ids",
      list.every((p) =>
        ["notes", "calc-paper", "amount", "password"].includes(p.id),
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

    // --- 密码本：加密保险库 + 随机密码生成
    const pwVault = require("./plugins/password/vault.js");
    const pwGen = require("./plugins/password/pwdgen.js");
    const pwList = list.find((p) => p.id === "password");
    check(
      "password declares fs+clipboard",
      JSON.stringify(pwList.permissions) ===
        JSON.stringify(["fs", "clipboard"]),
      pwList.permissions,
    );

    const secretBlob = pwVault.encryptVault("主密码-123", {
      entries: [
        {
          id: "1",
          title: "GitHub",
          username: "me@x.com",
          password: "S3cret!中文",
        },
      ],
    });
    const roundTrip = pwVault.decryptVault("主密码-123", secretBlob);
    check(
      "保险库加解密往返一致（含中文/符号）",
      roundTrip.entries[0].password === "S3cret!中文",
      roundTrip,
    );
    let wrongPwRejected = false;
    try {
      pwVault.decryptVault("错误密码", secretBlob);
    } catch {
      wrongPwRejected = true;
    }
    check("错误主密码被拒绝（GCM 认证失败）", wrongPwRejected);
    const blobText = JSON.stringify(secretBlob);
    check(
      "磁盘内容不含任何明文",
      !blobText.includes("S3cret") &&
        !blobText.includes("中文") &&
        !blobText.includes("GitHub") &&
        !blobText.includes("me@x.com"),
      Object.keys(secretBlob),
    );

    const genPw = pwGen.generatePassword({ length: 24 });
    check(
      "生成密码 24 位且四类字符齐全",
      genPw.length === 24 &&
        /[A-Z]/.test(genPw) &&
        /[a-z]/.test(genPw) &&
        /[0-9]/.test(genPw) &&
        /[^A-Za-z0-9]/.test(genPw),
      genPw,
    );
    check(
      "默认排除易混字符（0O1lI 等）",
      ![...genPw].some((c) => pwGen.AMBIGUOUS.includes(c)),
      genPw,
    );
    const uniqPw = new Set();
    for (let i = 0; i < 50; i++)
      uniqPw.add(pwGen.generatePassword({ length: 12 }));
    check("50 次生成无重复", uniqPw.size === 50, uniqPw.size);
    const genSrc = fs
      .readFileSync("./plugins/password/pwdgen.js", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    check(
      "生成器只用密码学随机源（无 Math.random）",
      !/Math\.random/.test(genSrc) && /randomInt|getRandomValues/.test(genSrc),
    );

    // --- 应用索引：商店 / 内置（UWP）应用没有任何 .lnk，必须从 Get-StartApps 补
    const { scanApps } = require("./dist/main/file-index/app-index");
    const apps = await scanApps();
    const shellApps = apps.filter((a) => a.shell);
    check("应用索引含商店/内置应用（UWP）", shellApps.length >= 10, {
      total: apps.length,
      shell: shellApps.length,
    });
    check(
      "商店应用启动目标为 shell:AppsFolder\\<AppID>",
      shellApps.length > 0 &&
        shellApps.every((a) => a.path.startsWith("shell:AppsFolder\\")) &&
        shellApps.every((a) => a.path.length > "shell:AppsFolder\\".length + 3),
      shellApps.slice(0, 3).map((a) => a.path),
    );
    const calcApp = apps.find((a) => /计算器|Calculator/i.test(a.name));
    check(
      "内置「计算器」现在能搜到",
      !!calcApp && calcApp.path.startsWith("shell:"),
      calcApp ?? apps.filter((a) => /计算/.test(a.name)).map((a) => a.name),
    );
    check(
      "经典 .lnk 应用未被丢掉（两者合并去重）",
      apps.some((a) => a.path.toLowerCase().endsWith(".lnk")) &&
        apps.some((a) => a.source === "store"),
      { total: apps.length, lnk: apps.filter((a) => !a.shell).length },
    );

    // --- UWP 图标：shell:AppsFolder -> SHParseDisplayName -> 真实图标
    const { getIconUrl, warmupIcons, killIcons } = require("./dist/main/file-index/icon-service");
    warmupIcons();
    const calcIcon = await getIconUrl(
      "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
    );
    const photosIcon = await getIconUrl(
      "shell:AppsFolder\\Microsoft.Windows.Photos_8wekyb3d8bbwe!App",
    );
    check(
      "商店/内置应用能提真实图标（不再是占位）",
      typeof calcIcon === "string" &&
        calcIcon.startsWith("data:image/png;base64,") &&
        typeof photosIcon === "string" &&
        calcIcon !== photosIcon,
      {
        calc: calcIcon ? calcIcon.length : null,
        photos: photosIcon ? photosIcon.length : null,
      },
    );
    check(
      "不存在的 AppID 图标返回 null（不抛错）",
      (await getIconUrl("shell:AppsFolder\\NotAReal_9!App")) === null,
    );
    check(
      "经典 exe 图标未回归",
      typeof (await getIconUrl("C:\\Windows\\System32\\notepad.exe")) === "string",
    );
    killIcons();

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

    // --- 密码本：关键词 + 生成密码 + 未解锁不泄露
    const pwItems = await pm.searchPlugins("密码");
    check(
      "input: '密码' -> 打开密码本 + 生成随机密码",
      pwItems.length === 2 && /打开密码本/.test(pwItems[0].title),
      pwItems.map((i) => i.title),
    );
    const genItems = await pm.searchPlugins("生成密码 16");
    check(
      "inputSearch: '生成密码 16' -> 恰 16 位随机密码",
      genItems.length === 1 &&
        String(genItems[0].title).replace(/^🔑 /, "").length === 16,
      genItems.map((i) => i.title),
    );
    const lockedSearch = await pm.searchPlugins("密码 github");
    check(
      "未解锁时搜索记录只提示解锁（不泄露内容）",
      lockedSearch.length === 1 && /未解锁/.test(lockedSearch[0].title),
      lockedSearch.map((i) => i.title),
    );

    // --- 中文无空格：插件名必须能命中关键词（曾经“密码本”什么都搜不到）
    const byName = await pm.searchPlugins("密码本");
    check(
      "中文前缀：'密码本' 命中密码插件（插件名可直接搜）",
      byName.length === 2 && /打开密码本/.test(byName[0].title),
      byName.map((i) => i.title),
    );
    const byNameAmount = await pm.searchPlugins("金额大写");
    check(
      "中文前缀：'金额大写' 也能命中金额插件",
      byNameAmount.length === 1,
      byNameAmount.map((i) => i.title),
    );
    const calcWord = await pm.searchPlugins("计算器");
    check(
      "'计算器' 不得命中插件（否则会抢在真正的应用前面）",
      calcWord.length === 0,
      calcWord.map((i) => i.title),
    );
    const asciiStrict = await pm.searchPlugins("passwordchange");
    check(
      "ASCII 关键词不放宽（passwordchange 不命中）",
      asciiStrict.length === 0,
      asciiStrict.map((i) => i.title),
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

    // --- sandbox -> host capability channel (main.readFile/writeFile/...)
    //     Regression guard: the "req" branch was missing from the sandbox
    //     message handler, so EVERY capability call from a plugin hung until
    //     its own timeout and then failed (silent in practice).
    const capDir = path.join(pm.userPluginsRoot(), "capplug");
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(
      path.join(capDir, "uTLS.json"),
      JSON.stringify({
        id: "capplug",
        name: "Cap Plug",
        main: "main.js",
        keywords: ["capplug"],
        permissions: ["fs"],
      }),
    );
    fs.writeFileSync(
      path.join(capDir, "main.js"),
      'main.onInput("capplug", async (k, cb) => {\n' +
        '  let out = "";\n' +
        "  try {\n" +
        '    await main.writeFile("cap-probe.txt", "cap-ok-中文");\n' +
        '    const back = await main.readFile("cap-probe.txt");\n' +
        '    out = back + "|" + (await main.getDataDir());\n' +
        '  } catch (e) { out = "ERR:" + e.message; }\n' +
        '  cb([{ text: out, icon: "🧪", data: {} }]);\n' +
        "});\n",
    );
    pm.rescan();
    const capItems = await pm.searchPlugins("capplug");
    check(
      "沙箱 -> 宿主能力调用可用（fs 写读往返）",
      capItems.length === 1 && /cap-ok-中文\|/.test(capItems[0].title),
      capItems.map((i) => i.title),
    );

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
    for (const dir of [cmdDir, capDir]) {
      for (let i = 0; ; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch (e) {
          if (i >= 9 || e.code !== "EBUSY") throw e;
          const end = Date.now() + 200;
          while (Date.now() < end) {
            /* spin */
          }
        }
      }
    }
    check("清理临时插件目录", !fs.existsSync(cmdDir) && !fs.existsSync(capDir));
  } catch (e) {
    failures++;
    console.log("FAIL  unhandled smoke error —", e && e.stack ? e.stack : e);
  }

  console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`);
  app.exit(failures === 0 ? 0 : 1);
});
