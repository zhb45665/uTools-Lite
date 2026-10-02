const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

(async () => {
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "utools-direct-search-")));
  await app.whenReady();
  const { initDatabase } = require("../dist/main/database.js");
  const { detectEverything, findEverythingCli, searchEverything } = require("../dist/main/file-index/everything-cli.js");
  const { runSearch } = require("../dist/main/search.js");
  await initDatabase();
  const directEverything = await detectEverything();
  assert.equal(directEverything, findEverythingCli() !== null);
  if (directEverything) {
    const chinese = await searchEverything("演示", 10);
    assert(chinese.available);
    assert(chinese.paths.some((p) => p.includes("演示")), "Chinese path was not decoded correctly");
    assert(chinese.paths.every((p) => !p.includes("�")), "UTF-8 replacement character found");
  }
  const result = await runSearch("README");
  assert.equal(
    result.commands.some((item) => String(item.payload).startsWith("everything:")),
    false,
    "search results must not contain an Enter-to-open-Everything command",
  );
  console.log(JSON.stringify({ directEverything, commandCount: result.commands.length }));
  console.log("PASS: full-disk results stay in the launcher; no Everything jump item");
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
