/**
 * notes — detail view + filesystem permission demo.
 *
 * Demonstrates:
 *   - main.onInput / onInputSearch -> open detail.html
 *   - plugin private data dir (no authorization needed)
 *   - fs permission: relative paths resolve into plugin-data/notes/
 *
 * The detail view (detail.html) talks to this file through the host:
 *   detail.html --sendMainMessage--> main.js
 *   main.js   --sendMainMessage-->   detail.html
 */

const NOTE_FILE = "note.txt";

function notePath() {
  // Relative path -> plugin's private data dir (no auth prompt).
  // getDataDir returns the absolute dir; join with a plain string.
  return NOTE_FILE; // passed relative; host resolves against data dir
}

main.onInput("note", (keyword, cb) => {
  cb([
    {
      text: "📝 打开随手笔记",
      description: "查看 / 编辑当前笔记",
      icon: "📝",
      data: { action: "open" },
    },
    {
      text: "✂️ 保存剪贴板内容到笔记",
      description: "需要 clipboard 权限",
      icon: "📋",
      data: { action: "save-clipboard" },
    },
  ]);
});

main.onInputSearch("note", (keyword, value, cb) => {
  cb([
    {
      text: `📝 新建笔记：${value}`,
      description: "回车打开详情视图并填入内容",
      icon: "📝",
      data: { action: "new", value },
    },
  ]);
});

main.onInput("memo", (keyword, cb) => {
  cb([
    {
      text: "📝 打开随手笔记",
      description: "查看 / 编辑当前笔记",
      icon: "📝",
      data: { action: "open" },
    },
  ]);
});

// Messages from the detail view.
main.onMainMessage((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "save" && typeof msg.content === "string") {
    main
      .writeFile(notePath(), msg.content)
      .then(() => {
        main.sendMainMessage({ type: "saved", at: Date.now() });
        main.toast("笔记已保存 ✅");
      })
      .catch((e) => {
        main.sendMainMessage({
          type: "save-error",
          error: String(e.message || e),
        });
      });
  } else if (msg.type === "append" && typeof msg.content === "string") {
    (async () => {
      let old = "";
      try {
        old = await main.readFile(notePath());
      } catch {
        /* first write */
      }
      await main.writeFile(notePath(), old + msg.content);
      main.sendMainMessage({ type: "appended", at: Date.now() });
    })().catch((e) => {
      main.sendMainMessage({
        type: "save-error",
        error: String(e.message || e),
      });
    });
  }
});

main.onExit(() => {
  main.log("notes detail view closed");
});

main.log("notes plugin loaded");
