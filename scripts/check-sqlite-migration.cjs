const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.join(process.env.APPDATA, "utools-lite");
const target = fs.mkdtempSync(path.join(os.tmpdir(), "utools-sqlite-migration-"));
app.disableHardwareAcceleration();
process.on("uncaughtException", (error) => { console.error(error.stack || error); process.exitCode = 1; app.exit(1); });
process.on("unhandledRejection", (error) => { console.error(error && error.stack || error); process.exitCode = 1; app.exit(1); });
for (const name of ["settings.json", "plugin-permissions.json", "plugin-data"]) {
  const from = path.join(source, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(target, name), { recursive: true });
}
app.setPath("userData", target);
app.setPath("sessionData", target);

function collectFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({
        pluginId: path.relative(root, full).split(path.sep)[0],
        file: path.relative(path.join(root, path.relative(root, full).split(path.sep)[0]), full).replace(/\\/g, "/"),
        content: fs.readFileSync(full, "utf8"),
      });
    }
  };
  walk(root);
  return out;
}

app.whenReady().then(async () => {
  try {
    const originals = collectFiles(path.join(target, "plugin-data"));
    const database = require("../dist/main/database");
    await database.initDatabase();
    const count = database.pluginFileCount();
    if (count !== originals.length) throw new Error(`file count mismatch ${count} != ${originals.length}`);
    for (const item of originals) {
      if (database.readPluginFile(item.pluginId, item.file) !== item.content) {
        throw new Error(`content mismatch: ${item.pluginId}/${item.file}`);
      }
    }
    database.writePluginFile("migration-test", "probe.txt", "sqlite-ok");
    if (database.readPluginFile("migration-test", "probe.txt") !== "sqlite-ok") throw new Error("write/read failed");
    database.deletePluginFile("migration-test", "probe.txt");
    const { SettingsStore } = require("../dist/main/store");
    const store = new SettingsStore();
    const settingsRow = database.readState("app", "settings");
    if (!settingsRow || settingsRow.hotkey !== store.get("hotkey")) throw new Error("settings migration failed");
    const integrity = database.databaseIntegrity();
    if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
    console.log(JSON.stringify({ database: database.databasePath(), importedFiles: count, hotkey: store.get("hotkey"), integrity }));
    console.log("PASS: isolated SQLite migration preserved every plugin file and app settings");
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
