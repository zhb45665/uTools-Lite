import { app, Tray, Menu, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Ipc } from "../shared/ipc";
import { SettingsStore } from "./store";
import { registerHotkey, unregisterHotkey } from "./hotkey";
import {
  createLauncherWindow,
  getLauncherWindow,
  showLauncher,
  toggleLauncher,
  setWindowBlurHandler,
  setBlurSuspendProbe,
  setLauncherShownHook,
} from "./launcher-window";
import { registerIpc } from "./ipc";
import { scanApps } from "./file-index/app-index";
import { detectEverything } from "./file-index/everything-cli";
import { startLocalIndex } from "./file-index/local-index";
import {
  warmupIcons,
  killIcons,
  preloadIcons,
} from "./file-index/icon-service";
import { createPluginManager, getPluginManager } from "./plugins/manager";
import {
  registerPluginScheme,
  registerPluginProtocol,
} from "./plugins/protocol";
import { initLogger, log } from "./logger";

// plugin:// must be declared privileged before the app is ready.
registerPluginScheme();

// Single instance: a second launch just re-opens the launcher in the first.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    showLauncher();
  });

  let store: SettingsStore;
  let tray: Tray;

  app.whenReady().then(() => {
    try {
      initLogger();
      log("INFO", "app", "application ready", `version=${app.getVersion()}`);
      doStartup();
    } catch (e) {
      // A throw in this chain used to kill the packaged app silently
      // (unhandled rejection, no console for GUI apps). Log to userData so
      // installed builds can be diagnosed.
      const msg = `[${new Date().toISOString()}] fatal init error: ${e}\n`;
      try {
        fs.appendFileSync(
          path.join(app.getPath("userData"), "main-error.log"),
          msg,
          "utf8",
        );
      } catch {
        /* ignore */
      }
      console.error("[init] fatal startup error", e);
      log("ERROR", "app", "fatal startup error", e);
    }
  });

  function doStartup() {
    store = new SettingsStore();
    createLauncherWindow(store);

    // First launch: reveal the launcher once it has loaded, so the user is
    // not left staring at an empty tray (the window starts hidden).
    if (!store.get("hasLaunchedBefore")) {
      getLauncherWindow()?.webContents.once("did-finish-load", () => {
        store.set("hasLaunchedBefore", true);
        showLauncher();
      });
    }

    // Plugin system: discovery + detail-view blur hook + protocol.
    const pluginManager = createPluginManager(() => getLauncherWindow());
    pluginManager.init();
    setWindowBlurHandler(() => pluginManager.onDetailBlur());
    // Keep the window visible while a permission card is unanswered
    // (a hidden card cannot be answered and would stall the plugin).
    setBlurSuspendProbe(() => pluginManager.blurSuspendCount());
    // On re-show, resume the active detail view (focus/scroll restore).
    setLauncherShownHook(() => pluginManager.resumeDetail());
    registerPluginProtocol((id) => pluginManager.dirOf(id));

    registerIpc(store, pluginManager, () => {
      /* hotkey changed; nothing else to do */
    });

    // Register the configured global hotkey.
    const initialHotkey = store.get("hotkey");
    const ok = registerHotkey(initialHotkey, toggleLauncher);
    if (!ok) {
      console.warn(
        `[init] could not register initial hotkey "${initialHotkey}"`,
      );
    }

    setTray();

    // Kick off background index work; never blocks startup.
    void scanApps()
      .then((apps) => preloadIcons(apps.map((a) => a.path)))
      .catch((e) => console.error("[init] app scan failed", e));
    void detectEverything()
      .then((es) => {
        // Offline fallback: when Everything is not installed, walk the disk
        // in the background so file search still works out of the box.
        if (!es) {
          startLocalIndex({}, (s) =>
            getLauncherWindow()?.webContents.send(Ipc.FileIndexProgress, s),
          );
        }
      })
      .catch(() => {});

    // Real Windows shell icons for search results (background ~1s boot).
    warmupIcons();

    app.setLoginItemSettings({ openAtLogin: store.get("launchAtLogin") });
  }

  function setTray() {
    // Resolves to <repo>/build/tray-icon.png in dev and
    // <asar>/build/tray-icon.png when packaged — the file MUST be listed in
    // electron-builder `files` or this path is empty inside the asar.
    const iconPath = path.join(__dirname, "../../build/tray-icon.png");
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // new Tray(empty) THROWS on Windows and would kill startup.
      console.error(`[tray] icon not found at ${iconPath} — tray disabled`);
      return;
    }
    tray = new Tray(icon);
    tray.setToolTip("uTools Lite");
    const menu = Menu.buildFromTemplate([
      { label: "Open Launcher", click: () => showLauncher() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on("double-click", () => showLauncher());
  }
} else {
  app.quit();
}

app.on("window-all-closed", () => {
  // Keep running in the tray; do not quit.
});

app.on("before-quit", () => {
  unregisterHotkey();
  killIcons();
  getPluginManager()?.shutdown();
  // Destroy the standalone note window (force: skip the beforeClose
  // negotiation on quit — the page's autosave + .prev.md backup already
  // cover data safety).
  void (async () => {
    const { closeNoteWindow } = await import("./note-window");
    await closeNoteWindow(true);
  })();
});
