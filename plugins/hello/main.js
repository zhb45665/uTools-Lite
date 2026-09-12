/**
 * hello — the smallest possible pure-command plugin.
 *
 * Demonstrates:
 *   - main.onInput        (query equals the keyword)
 *   - main.onInputSearch  (query = keyword + value, host debounced)
 *   - main.onSelect       (user pressed Enter on an item)
 *   - main.toast / main.log
 *
 * No permissions declared -> no fs / clipboard / net access.
 */

main.onInput("hello", (keyword, cb) => {
  cb([
    {
      text: "打个招呼 👋",
      description: "回车执行",
      icon: "👋",
      data: { action: "greet" },
    },
  ]);
});

main.onInput("hi", (keyword, cb) => {
  cb([
    {
      text: "Hi there 👋",
      description: "回车执行",
      icon: "👋",
      data: { action: "greet" },
    },
  ]);
});

main.onInputSearch("hello", (keyword, value, cb) => {
  cb([
    {
      text: `回显：${value}`,
      description: "这是你关键词后面输入的内容",
      icon: "🔁",
      data: { action: "echo", value },
    },
  ]);
});

main.onSelect((item) => {
  if (!item || !item.data) return;
  if (item.data.action === "greet") {
    main.toast("Hello, world! 插件系统工作正常 ✅");
  } else if (item.data.action === "echo") {
    main.toast(`你输入了：${item.data.value}`);
    main.log("echo selected:", item.data.value);
  }
});

main.log("hello plugin loaded");
