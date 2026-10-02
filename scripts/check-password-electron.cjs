/* Actual Electron/preload/standalone-window/utilityProcess test. */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const dataDir = path.resolve(
  __dirname,
  "../dist/password-electron-check",
  randomUUID(),
);
fs.mkdirSync(dataDir, { recursive: true });
app.setPath("userData", dataDir);
app.setPath("sessionData", dataDir);
app.disableHardwareAcceleration();
const {
  registerPluginScheme,
  registerPluginProtocol,
} = require("../dist/main/plugins/protocol");
registerPluginScheme();
let pm, win, passwordWin;
async function until(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("Timed out: " + label);
}
app.whenReady().then(async () => {
  try {
    await require("../dist/main/database").initDatabase();
    const windows = require("../dist/main/launcher-window");
    const { SettingsStore } = require("../dist/main/store");
    const store = new SettingsStore();
    windows.createLauncherWindow(store);
    win = windows.getLauncherWindow();
    pm = require("../dist/main/plugins/manager").createPluginManager(() => win);
    pm.init();
    windows.setWindowBlurHandler(() => pm.onDetailBlur());
    registerPluginProtocol((id) => pm.dirOf(id));
    require("../dist/main/ipc").registerIpc(store, pm, () => {});
    await until(
      () =>
        win.webContents.executeJavaScript(
          "!!window.launcher && document.querySelectorAll('.plugin-row').length >= 4",
        ),
      "launcher ready",
    );
    const original = win.getContentSize();
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.plugin-row')].find(e=>e.textContent.includes('密码本')).click()",
    );
    await until(() => {
      passwordWin = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith("plugin://password/"),
      );
      return !!passwordWin;
    }, "standalone password window");
    const frame = passwordWin.webContents;
    await until(
      () =>
        frame.executeJavaScript(
          "!!document.getElementById('unlockbtn') && !document.getElementById('unlockbtn').disabled",
        ),
      "cold plugin handshake",
    );
    assert.deepEqual(win.getContentSize(), original);
    assert(passwordWin.getContentSize()[0] >= 1000);
    await frame.executeJavaScript(
      "document.getElementById('master').value='Electron-test-master'; document.getElementById('master2').value='Electron-test-master'; document.getElementById('unlockbtn').click()",
    );
    await until(
      () =>
        frame.executeJavaScript("!document.getElementById('workspace').hidden"),
      "vault created",
    );
    await frame.executeJavaScript("document.getElementById('newbtn').click()");
    await until(
      () =>
        frame.executeJavaScript("!document.getElementById('editor').hidden"),
      "editor",
    );
    await frame.executeJavaScript(
      "document.getElementById('f-title').value='Electron test server'; document.getElementById('f-host').value='192.0.2.99'; document.getElementById('f-user').value='deploy'; document.getElementById('f-pass').value='Electron-test-secret'; document.getElementById('f-save').click()",
    );
    await until(
      () =>
        frame.executeJavaScript(
          "document.getElementById('editor').hidden && document.getElementById('detail').textContent.includes('Electron test server')",
        ),
      "atomic save",
    );
    const saved = require("../dist/main/database").readPluginFile(
      "password",
      "vault.json",
    );
    assert(!saved.includes("Electron-test-secret"));
    const decrypted = require("../plugins/password/vault.js").decryptVault(
      "Electron-test-master",
      JSON.parse(saved),
    );
    assert.equal(decrypted.entries[0].host, "192.0.2.99");
    assert.equal(
      await frame.executeJavaScript("document.querySelector('.secret').type"),
      "password",
    );
    await frame.executeJavaScript("document.getElementById('lockbtn').click()");
    await until(
      () =>
        frame.executeJavaScript("!document.getElementById('lockbox').hidden"),
      "lock",
    );
    assert.equal(
      await frame.executeJavaScript(
        "document.getElementById('detail').childElementCount",
      ),
      0,
    );
    await frame.executeJavaScript(
      "document.getElementById('master').value='Electron-test-master'; document.getElementById('unlockbtn').click()",
    );
    await until(
      () =>
        frame.executeJavaScript("!document.getElementById('workspace').hidden"),
      "unlock",
    );
    await frame.executeJavaScript("void uTools.closeDetail()");
    await until(() => passwordWin.isDestroyed(), "standalone window close");
    assert.deepEqual(win.getContentSize(), original);
    // Every remaining detail plugin must also open as a movable, resizable
    // top-level window rather than mounting an iframe inside the launcher.
    for (const [query, pluginId] of [
      ["paper", "calc-paper"],
      ["金额", "amount"],
      ["时间戳", "timestamp"],
    ]) {
      const items = await pm.searchPlugins(query);
      const item = items.find((it) => it.pluginId === pluginId);
      assert(item, `missing search item for ${pluginId}`);
      await pm.handleSelect(item);
      let toolWin;
      await until(() => {
        toolWin = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith(`plugin://${pluginId}/`),
        );
        return !!toolWin;
      }, `${pluginId} standalone window`);
      assert.equal(toolWin.isMovable(), true);
      assert.equal(toolWin.isResizable(), true);
      assert.equal(
        await toolWin.webContents.executeJavaScript(
          "['window-min','window-max','window-close'].every(id => !!document.getElementById(id))",
        ),
        true,
      );
      await toolWin.webContents.executeJavaScript(
        "document.getElementById('window-max').click()",
      );
      await until(() => toolWin.isMaximized(), `${pluginId} maximize button`);
      await toolWin.webContents.executeJavaScript(
        "document.getElementById('window-max').click()",
      );
      await until(() => !toolWin.isMaximized(), `${pluginId} restore button`);
      assert.equal(
        await win.webContents.executeJavaScript("document.querySelector('iframe') === null"),
        true,
      );
      await require("../dist/main/note-window").closeNoteWindow(true);
      await until(() => toolWin.isDestroyed(), `${pluginId} window close`);
    }
    for (let i = 0; i < 5; i++) {
      windows.setCredentialWindow(true);
      windows.setCredentialWindow(false);
    }
    assert.deepEqual(win.getContentSize(), original);
    console.log(
      "PASS: real Electron cold start, standalone password window, RPC save/encryption, lock/unlock, close and compact launcher size",
    );
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  } finally {
    pm?.shutdown();
    win?.destroy();
    app.exit(process.exitCode || 0);
  }
});
setTimeout(() => {
  console.error("Electron test exceeded 60 seconds");
  pm?.shutdown();
  app.exit(1);
}, 60000).unref();
