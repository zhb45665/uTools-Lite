/* Actual Electron/preload/iframe/utilityProcess test. All data stays in dist. */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const dataDir = path.resolve(__dirname, '../dist/password-electron-check', randomUUID());
fs.mkdirSync(dataDir, {recursive:true});
app.setPath('userData', dataDir);
app.setPath('sessionData', dataDir);
app.disableHardwareAcceleration();
const { registerPluginScheme, registerPluginProtocol } = require('../dist/main/plugins/protocol');
registerPluginScheme();
let pm, win;
async function until(check, label) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) { if(await check()) return; await new Promise(r=>setTimeout(r,60)); }
  throw Error('Timed out: '+label);
}
app.whenReady().then(async()=>{
  try {
    const windows = require('../dist/main/launcher-window');
    const { SettingsStore } = require('../dist/main/store');
    const store = new SettingsStore();
    windows.createLauncherWindow(store); win=windows.getLauncherWindow();
    pm=require('../dist/main/plugins/manager').createPluginManager(()=>win); pm.init();
    windows.setWindowBlurHandler(()=>pm.onDetailBlur());
    registerPluginProtocol(id=>pm.dirOf(id));
    require('../dist/main/ipc').registerIpc(store,pm,()=>{});
    await until(()=>win.webContents.executeJavaScript("!!window.launcher && document.querySelectorAll('.plugin-row').length === 4"),'launcher ready');
    const original=win.getContentSize();
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.plugin-row')].find(e=>e.textContent.includes('密码本')).click()");
    await until(()=>win.webContents.mainFrame.frames.some(f=>f.url.startsWith('plugin://password/')),'detail frame');
    const frame=win.webContents.mainFrame.frames.find(f=>f.url.startsWith('plugin://password/'));
    await until(()=>frame.executeJavaScript("!!document.getElementById('unlockbtn') && !document.getElementById('unlockbtn').disabled"),'cold plugin handshake');
    assert(win.getSize()[0]>=original[0]);
    await frame.executeJavaScript("document.getElementById('master').value='Electron-test-master'; document.getElementById('master2').value='Electron-test-master'; document.getElementById('unlockbtn').click()");
    await until(()=>frame.executeJavaScript("!document.getElementById('workspace').hidden"),'vault created');
    await frame.executeJavaScript("document.getElementById('newbtn').click()");
    await until(()=>frame.executeJavaScript("!document.getElementById('editor').hidden"),'editor');
    await frame.executeJavaScript("document.getElementById('f-title').value='Electron test server'; document.getElementById('f-host').value='192.0.2.99'; document.getElementById('f-user').value='deploy'; document.getElementById('f-pass').value='Electron-test-secret'; document.getElementById('f-save').click()");
    await until(()=>frame.executeJavaScript("document.getElementById('editor').hidden && document.getElementById('detail').textContent.includes('Electron test server')"),'atomic save');
    const saved=fs.readFileSync(path.join(dataDir,'plugin-data/password/vault.json'),'utf8');
    assert(!saved.includes('Electron-test-secret'));
    const decrypted=require('../plugins/password/vault.js').decryptVault('Electron-test-master',JSON.parse(saved));
    assert.equal(decrypted.entries[0].host,'192.0.2.99');
    assert.equal(await frame.executeJavaScript("document.querySelector('.secret').type"),'password');
    await frame.executeJavaScript("document.getElementById('lockbtn').click()");
    await until(()=>frame.executeJavaScript("!document.getElementById('lockbox').hidden"),'lock');
    assert.equal(await frame.executeJavaScript("document.getElementById('detail').childElementCount"),0);
    await frame.executeJavaScript("document.getElementById('master').value='Electron-test-master'; document.getElementById('unlockbtn').click()");
    await until(()=>frame.executeJavaScript("!document.getElementById('workspace').hidden"),'unlock');
    await frame.executeJavaScript("void uTools.closeDetail()");
    await until(()=>win.webContents.executeJavaScript("!document.querySelector('iframe')"),'iframe exit restores search');
    assert.deepEqual(win.getContentSize(),original);
    for (let i=0;i<5;i++) { windows.setCredentialWindow(true); windows.setCredentialWindow(false); }
    assert.deepEqual(win.getContentSize(),original);
    console.log('PASS: real Electron cold start, window expansion, RPC save/encryption, lock/unlock, iframe exit and size restore');
  } catch(e) { console.error(e.stack || e); process.exitCode=1; }
  finally { pm?.shutdown(); win?.destroy(); app.exit(process.exitCode || 0); }
});
setTimeout(()=>{console.error('Electron test exceeded 60 seconds');pm?.shutdown();app.exit(1);},60000).unref();
