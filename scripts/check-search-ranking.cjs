const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "utools-search-rank-"));
  app.setPath("userData", userData);
  try {
    await app.whenReady();
    const { initDatabase } = require("../dist/main/database.js");
    await initDatabase();
    const { recordSearchSelection, applyUsageRanking } = require("../dist/main/search-usage.js");
    const make = (payload, title) => ({ id: payload, type: "app", payload, title });
    const first = make("C:\\Apps\\first.lnk", "First");
    const preferred = make("C:\\Apps\\preferred.lnk", "Preferred");
    const response = () => ({ query: "微", files: [], apps: [first, preferred], commands: [], plugins: [] });

    assert.equal(applyUsageRanking(response(), "微").apps[0].payload, first.payload);
    recordSearchSelection("微", preferred);
    assert.equal(applyUsageRanking(response(), "微").apps[0].payload, preferred.payload);

    const persisted = applyUsageRanking(response(), "微");
    assert.equal(persisted.apps[0].payload, preferred.payload);
    console.log("PASS: local selection history promotes the chosen result for the same query");
  } finally {
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
