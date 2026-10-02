const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "utools-screen-capture-"));
app.setPath("userData", data);
app.setPath("sessionData", data);
app.disableHardwareAcceleration();
const { registerPluginScheme, registerPluginProtocol } = require("../dist/main/plugins/protocol");
registerPluginScheme();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  let pm;
  try {
    await require("../dist/main/database").initDatabase();
    const windows = require("../dist/main/launcher-window");
    const { SettingsStore } = require("../dist/main/store");
    const store = new SettingsStore();
    windows.createLauncherWindow(store);
    const launcher = windows.getLauncherWindow();
    pm = require("../dist/main/plugins/manager").createPluginManager(() => launcher);
    pm.init();
    registerPluginProtocol((id) => pm.dirOf(id));
    require("../dist/main/ipc").registerIpc(store, pm, () => {});
    const item = (await pm.searchPlugins("ocr")).find((x) => x.pluginId === "ocr");
    assert(item);
    await pm.handleSelect(item);
    await wait(600);
    const owner = require("../dist/main/note-window").getNoteWindow();
    assert(owner && owner.isVisible());
    const pending = require("../dist/main/ocr-screen-capture").captureScreenRegion();
    let overlay;
    for (let i = 0; i < 80 && !overlay; i++) {
      await wait(50);
      overlay = BrowserWindow.getAllWindows().find((w) => w !== owner && w.webContents.getURL().startsWith("data:text/html"));
    }
    assert(overlay, "selection overlay did not open");
    await overlay.webContents.executeJavaScript("screenCapture.finish({x:20,y:20,width:240,height:120,viewportWidth:innerWidth,viewportHeight:innerHeight})");
    const result = await pending;
    assert(!result.canceled);
    assert(result.dataUrl.startsWith("data:image/png;base64,"));
    assert(result.width > 0 && result.height > 0);
    assert(owner.isVisible());
    console.log(JSON.stringify({ width: result.width, height: result.height, ownerRestored: owner.isVisible() }));
    console.log("PASS: OCR screen selection captured and cropped a real display image");
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    pm?.shutdown();
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    app.exit(process.exitCode || 0);
  }
});
