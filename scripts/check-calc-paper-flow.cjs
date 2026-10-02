const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "utools-calc-flow-"));
app.setPath("userData", data);
app.setPath("sessionData", data);
app.disableHardwareAcceleration();
const { registerPluginScheme, registerPluginProtocol } = require("../dist/main/plugins/protocol");
registerPluginScheme();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await app.whenReady();
  let pm;
  let launcher;
  try {
    await require("../dist/main/database").initDatabase();
    const windows = require("../dist/main/launcher-window");
    const { SettingsStore } = require("../dist/main/store");
    const store = new SettingsStore();
    windows.createLauncherWindow(store);
    launcher = windows.getLauncherWindow();
    pm = require("../dist/main/plugins/manager").createPluginManager(() => launcher);
    pm.init();
    registerPluginProtocol((id) => pm.dirOf(id));
    require("../dist/main/ipc").registerIpc(store, pm, () => {});
    const item = (await pm.searchPlugins("paper")).find((x) => x.pluginId === "calc-paper");
    assert(item);
    await pm.handleSelect(item);
    let win;
    for (let i = 0; i < 100 && !win; i++) {
      win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("plugin://calc-paper/"));
      if (!win) await wait(50);
    }
    assert(win, "calculator window did not open");
    await wait(500);
    const state = await win.webContents.executeJavaScript(`(async()=>{
      const fireInput=(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))};
      const press=(el,key)=>el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
      let input=document.querySelector('.expr');
      fireInput(input,'5+*2');
      const sanitized=input.value;
      press(input,'Enter');
      await new Promise(r=>setTimeout(r,30));
      let inputs=[...document.querySelectorAll('.expr')];
      const seeded=inputs.map(x=>x.value);
      input=inputs[1];
      fireInput(input,input.value+'*4');
      press(input,'Enter');
      await new Promise(r=>setTimeout(r,30));
      inputs=[...document.querySelectorAll('.expr')];
      return {sanitized,seeded,final:inputs.map(x=>x.value),results:[...document.querySelectorAll('.res')].map(x=>x.textContent)};
    })()`);
    assert.equal(state.sanitized, "5*2");
    assert.deepEqual(state.seeded.slice(0, 2), ["5*2", "10"]);
    assert.deepEqual(state.final.slice(0, 3), ["5*2", "10*4", "40"]);
    assert.equal(state.results[0], "= 10");
    assert.equal(state.results[1], "= 40");
    assert.equal(state.results[2], "");
    console.log(JSON.stringify(state));
    console.log("PASS: operators are normalized and Enter chains from the previous result");
  } finally {
    pm?.shutdown();
    BrowserWindow.getAllWindows().forEach((w) => { if (!w.isDestroyed()) w.destroy(); });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
