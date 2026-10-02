const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "utools-plugin-search-")));
app.disableHardwareAcceleration();

(async () => {
  await app.whenReady();
  await require("../dist/main/database").initDatabase();
  const pm = require("../dist/main/plugins/manager").createPluginManager(() => null);
  try {
    pm.init();
    const cases = [
      ["jsgz", "calc-paper"],
      ["mmb", "password"],
      ["wzsb", "ocr"],
      ["时间戳", "timestamp"],
      ["大小写转换", "amount"],
    ];
    for (const [query, pluginId] of cases) {
      const results = await pm.searchPlugins(query);
      assert(results.some((item) => item.pluginId === pluginId), `${query} did not find ${pluginId}`);
    }
    console.log(JSON.stringify(cases));
    console.log("PASS: plugin search covers names, descriptions, keywords, pinyin and initials");
  } finally {
    pm.shutdown();
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
