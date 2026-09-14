import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ipcMain,
  app,
  clipboard,
  dialog,
  Menu,
  shell,
  BrowserWindow,
} from "electron";
import {
  Ipc,
  SearchItem,
  CapabilityCall,
  PublicSettings,
  ResultContextMenuRequest,
  ResultContextMenuResponse,
} from "../shared/ipc";
import { SettingsStore } from "./store";
import { registerHotkey, getCurrentHotkey } from "./hotkey";
import {
  hideLauncher,
  suspendBlurHide,
  resumeBlurHide,
  toggleLauncher,
} from "./launcher-window";
import { isNoteWindowOpen, getNoteWindow } from "./note-window";
import { runSearch } from "./search";
import {
  detectEverything,
  openLocalEverything,
} from "./file-index/everything-cli";
import { getAppCount } from "./file-index/app-index";
import { getIndexStatus } from "./file-index/local-index";
import { PluginManager } from "./plugins/manager";
import { logsDirectory, log } from "./logger";

/**
 * Frame identity of the IPC sender.
 *
 * Plugin detail views live in a `plugin://` IFRAME, and webContents.send()
 * only reaches the top frame — messages to a detail page must be addressed
 * with webContents.sendToFrame([processId, routingId], ...) or the plugin
 * never hears back from the host.
 */
function frameIdOf(e: {
  senderFrame?: { processId: number; routingId: number } | null;
}): [number, number] | null {
  const f = e && e.senderFrame;
  return f ? [f.processId, f.routingId] : null;
}

/**
 * Wire up all ipcMain handlers the renderer talks to via the preload bridge.
 */
export function registerIpc(
  store: SettingsStore,
  pm: PluginManager,
  onHotkeyChanged: () => void,
): void {
  ipcMain.handle(Ipc.LauncherHide, () => {
    // Esc in the search UI: hide the window. If a detail view happens to be
    // open (edge case), it stays alive per the retention plan; the user
    // resumes it next time the launcher is shown.
    hideLauncher();
  });
  ipcMain.handle(Ipc.SearchQuery, async (_e, query: string) => {
    return runSearch(query ?? "");
  });

  ipcMain.handle(
    Ipc.Launch,
    async (_e, item: { payload: string; type: string }) => {
      const payload = item?.payload;
      if (!payload) return { ok: false };
      try {
        if (payload.startsWith("everything:")) {
          const q = payload.slice("everything:".length);
          openLocalEverything(q);
          hideLauncher();
          return { ok: true };
        }
        if (item.type === "command") {
          // Calculator result -> copy to clipboard.
          clipboard.writeText(payload);
          return { ok: true, copied: payload };
        }
        if (payload.startsWith("http://") || payload.startsWith("https://")) {
          void shell.openExternal(payload);
          hideLauncher();
          return { ok: true };
        }
        // Store / built-in (UWP) apps: no real path exists, so neither
        // existsSync nor shell.openPath applies — the id is resolved by the
        // shell namespace (explorer) instead.
        if (payload.startsWith("shell:")) {
          spawn("explorer.exe", [payload], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          }).unref();
          hideLauncher();
          return { ok: true };
        }
        // file / app -> open via shell (apps are .lnk; opening executes them).
        // Guard first: a stale search hit (file moved/deleted, app .lnk whose
        // target is gone) would otherwise surface a raw Windows message such
        // as "找不到路径".
        if (!fs.existsSync(payload)) {
          const label = item.type === "app" ? "应用" : "文件";
          return {
            ok: false,
            error: `找不到${label}（可能已被移动或删除）：${payload}`,
          };
        }
        const err = await shell.openPath(payload);
        if (err) {
          // A shortcut can exist while its target is gone (uninstalled app);
          // Windows then answers "找不到路径" — explain it in plain Chinese.
          return {
            ok: false,
            error:
              item.type === "app"
                ? `应用启动失败：${path.basename(payload)}（快捷方式可能已失效，目标程序已卸载或移动）`
                : err,
          };
        }
        hideLauncher();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  );

  // --- search result context menu (右键定位) ---
  //
  // Renderer sends the SearchItem type + payload + title (+ optional
  // pointer coords). Main re-validates the path (does NOT trust the
  // renderer's type), builds a native Menu, suspends blur-hide for the
  // menu's lifetime, and executes the chosen action.
  ipcMain.handle(
    Ipc.ResultContextMenu,
    async (
      _e,
      req: ResultContextMenuRequest,
    ): Promise<ResultContextMenuResponse> => {
      // 1. Validate payload format — reject non-local-path protocols.
      const payload = typeof req?.payload === "string" ? req.payload : "";
      if (!payload) return { ok: false, error: "该结果没有可打开的本地位置" };
      if (payload.includes("\0"))
        return { ok: false, error: "路径包含非法字符" };
      if (
        payload.startsWith("http://") ||
        payload.startsWith("https://") ||
        payload.startsWith("everything:") ||
        payload.startsWith("shell:")
      ) {
        return { ok: false, error: "该结果没有可打开的本地位置" };
      }
      if (!path.isAbsolute(payload)) {
        return { ok: false, error: "该结果没有可打开的本地位置" };
      }

      // 2. Existence check — the file may have been moved/deleted since search.
      let st: fs.Stats;
      try {
        st = fs.statSync(payload);
      } catch {
        return { ok: false, error: "找不到该文件，可能已被移动或删除" };
      }

      // 3. Determine kind: directory / .lnk shortcut / regular file.
      const isDir = st.isDirectory();
      const isLnk = !isDir && path.extname(payload).toLowerCase() === ".lnk";
      const isFile = !isDir && !isLnk;

      // 4. Build the menu items based on kind.
      const menuItems: Electron.MenuItemConstructorOptions[] = [];

      if (isDir) {
        menuItems.push({
          label: "打开文件夹",
          click: () => {
            void doOpen(payload);
          },
        });
        menuItems.push({
          label: "在资源管理器中显示",
          click: () => {
            void doReveal(payload);
          },
        });
      } else if (isLnk) {
        menuItems.push({
          label: "启动应用",
          click: () => {
            void doOpen(payload);
          },
        });
        menuItems.push({
          label: "打开快捷方式所在位置",
          click: () => {
            void doReveal(payload);
          },
        });
      } else if (isFile) {
        menuItems.push({
          label: "打开",
          click: () => {
            void doOpen(payload);
          },
        });
        menuItems.push({
          label: "打开文件所在位置",
          click: () => {
            void doReveal(payload);
          },
        });
      } else {
        return { ok: false, error: "该结果没有可打开的本地位置" };
      }
      menuItems.push({ type: "separator" });
      const copyLabel = isLnk ? "复制快捷方式路径" : "复制完整路径";
      menuItems.push({
        label: copyLabel,
        click: () => {
          void doCopy(payload);
        },
      });

      // 5. Show the native menu. Suspend blur-hide for the menu's lifetime
      //    so the launcher window is not hidden while the menu is open.
      const sender = _e.sender;
      const win = BrowserWindow.fromWebContents(sender);
      if (!win || win.isDestroyed()) return { ok: false, error: "窗口不可用" };

      suspendBlurHide();
      let resumed = false;
      const ensureResume = () => {
        if (!resumed) {
          resumed = true;
          resumeBlurHide();
        }
      };

      // --- action helpers (close over `win`) ---
      let lastAction: "open" | "reveal" | "copy" | "dismissed" = "dismissed";

      async function doOpen(p: string) {
        try {
          const err = await shell.openPath(p);
          if (err) return;
          lastAction = "open";
          hideLauncher();
        } catch {
          lastAction = "open";
        }
      }
      function doReveal(p: string) {
        try {
          shell.showItemInFolder(p);
          lastAction = "reveal";
        } catch {
          lastAction = "reveal";
        }
      }
      function doCopy(p: string) {
        try {
          clipboard.writeText(p);
          lastAction = "copy";
        } catch {
          lastAction = "copy";
        }
      }

      try {
        const menu = Menu.buildFromTemplate(menuItems);
        const pos =
          typeof req.x === "number" && typeof req.y === "number"
            ? { x: req.x, y: req.y }
            : undefined;
        menu.popup({ window: win, ...(pos ? { x: pos.x, y: pos.y } : {}) });

        // Wait for the menu to close (action chosen or dismissed).
        await new Promise<void>((resolve) => {
          const onWillClose = () => {
            ensureResume();
            resolve();
          };
          menu.on("menu-will-close", onWillClose);
          // Safety net: if the event never fires, resume after 10 s so we
          // don't leak the suspend count. (The menu is always closed by the
          // user or by Electron, so this is a defensive guard only.)
          setTimeout(() => {
            ensureResume();
            resolve();
          }, 10_000);
        });
        return { ok: true, action: lastAction };
      } catch (err) {
        ensureResume();
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(Ipc.AppInfo, async () => {
    const everythingAvailable = await detectEverything();
    return {
      platform: process.platform,
      everythingAvailable,
      fileIndex: getIndexStatus(),
      appCount: getAppCount(),
      pluginCount: pm.list().length,
      pluginsDir: pm.userPluginsRoot(),
    };
  });

  ipcMain.handle(Ipc.HotkeyGet, () => {
    return { hotkey: getCurrentHotkey() ?? store.get("hotkey") };
  });

  ipcMain.handle(Ipc.HotkeySet, (_e, accelerator: string) => {
    const ok = registerHotkey(accelerator, toggleLauncher);
    if (ok) {
      store.set("hotkey", accelerator);
      onHotkeyChanged();
      return { ok: true };
    }
    return {
      ok: false,
      error: `Hotkey "${accelerator}" is unavailable or invalid.`,
    };
  });

  ipcMain.handle(
    Ipc.SettingsGet,
    (): PublicSettings => ({
      hotkey: getCurrentHotkey() ?? store.get("hotkey"),
      launchAtLogin: store.get("launchAtLogin"),
      theme: store.get("theme"),
    }),
  );

  ipcMain.handle(Ipc.SettingsSet, (_e, patch: Partial<PublicSettings>) => {
    if (typeof patch?.launchAtLogin === "boolean") {
      store.set("launchAtLogin", patch.launchAtLogin);
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    if (["system", "light", "dark"].includes(String(patch?.theme)))
      store.set("theme", patch.theme!);
    log("INFO", "settings", "settings updated");
    return { ok: true };
  });

  ipcMain.handle(Ipc.DataReveal, async () => {
    const error = await shell.openPath(app.getPath("userData"));
    return { ok: !error, error: error || undefined };
  });
  ipcMain.handle(Ipc.LogsReveal, async () => {
    fs.mkdirSync(logsDirectory(), { recursive: true });
    const error = await shell.openPath(logsDirectory());
    return { ok: !error, error: error || undefined };
  });

  ipcMain.handle(Ipc.AppQuit, () => {
    app.quit();
    return { ok: true };
  });

  // ------------------------------------------------------------ plugins
  ipcMain.handle(Ipc.PluginList, () => {
    return pm.list();
  });

  ipcMain.handle(Ipc.PluginInstall, async (_e, fromPath: string) => {
    return pm.install(fromPath ?? "");
  });

  ipcMain.handle(Ipc.PluginInstallPick, async () => {
    // Native picker blurs the window -> suspend blur-hide while it is open.
    suspendBlurHide();
    try {
      const r = await dialog.showOpenDialog({
        title: "Install plugin",
        buttonLabel: "Install",
        properties: ["openFile", "openDirectory"],
        filters: [
          { name: "Plugin", extensions: ["zip", "json"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (r.canceled || r.filePaths.length === 0) return { ok: false };
      return pm.install(r.filePaths[0]);
    } finally {
      resumeBlurHide();
    }
  });

  ipcMain.handle(Ipc.PluginUninstall, (_e, pluginId: string) => {
    return pm.uninstall(String(pluginId ?? ""));
  });

  ipcMain.handle(Ipc.PluginRescan, () => {
    return pm.rescan();
  });

  ipcMain.handle(Ipc.PluginReveal, (_e, pluginId: string) =>
    pm.reveal(String(pluginId ?? "")),
  );

  ipcMain.handle(Ipc.PluginSelect, async (_e, item: SearchItem) => {
    return pm.handleSelect(item ?? ({} as SearchItem));
  });

  ipcMain.handle(Ipc.PluginDetailReady, () => {
    // The launcher top frame reports iframe onLoad; it is not the recipient.
    // detailSend records the actual plugin frame when it sends its first request.
    pm.markDetailReady();
    return { ok: true };
  });

  ipcMain.handle(Ipc.PluginDetailClose, async () => {
    // Goes through the beforeClose negotiation: a page with unsaved changes
    // can refuse (it shows its own confirm dialog and returns false).
    const r = await pm.closeDetail(true);
    return { ok: true, closed: r.closed };
  });

  ipcMain.handle(Ipc.PluginDetailCloseUnsafe, () => {
    pm.closeDetailUnsafe(true);
    return { ok: true };
  });

  // Standalone note window: Esc / close-button path. Runs the beforeClose
  // negotiation (unsaved-changes check inside the note page) before actually
  // destroying the window. The note window is a separate BrowserWindow from
  // the main launcher, so it needs its own close handler.
  ipcMain.handle(Ipc.NoteWindowClose, async () => {
    console.log("[ipc] NoteWindowClose received");
    const { closeNoteWindow, isNoteWindowOpen } = await import("./note-window");
    console.log(`[ipc] NoteWindowClose isNoteWindowOpen=${isNoteWindowOpen()}`);
    await closeNoteWindow(false);
    return { ok: true };
  });

  // Standalone note window: custom title-bar buttons (minimize / maximize).
  // The window is frameless (no native title bar), so the page draws its
  // own minimal title bar and these IPCs drive the window controls.
  ipcMain.handle(Ipc.NoteWindowMinimize, () => {
    const { minimizeNoteWindow } =
      require("./note-window") as typeof import("./note-window");
    minimizeNoteWindow();
    return { ok: true };
  });
  ipcMain.handle(Ipc.NoteWindowToggleMaximize, () => {
    const { toggleNoteWindowMaximize } =
      require("./note-window") as typeof import("./note-window");
    toggleNoteWindowMaximize();
    return { ok: true };
  });

  /**
   * Top frame asks the detail iframe whether it allows closing.
   * Re-uses the manager's negotiation (which sends to the frame directly)
   * but returns the answer to the top frame. The top frame's own Esc /
   * close-button path calls detailClose() which triggers the same flow
   * via PluginDetailClose, so this handler is only used when the top frame
   * wants to check without closing (e.g. for diagnostics).
   */
  ipcMain.handle(Ipc.DetailBeforeClose, async () => {
    const pmRef = pm;
    const d = pmRef.activeDetailRef();
    if (!d) return true;
    return pmRef.negotiateBeforeClosePublic(d);
  });

  ipcMain.handle(Ipc.PluginDetailSend, (e, data: unknown) => {
    // If the message comes from the standalone note window, route it there
    // (bypasses activeDetail, which is bound to the main launcher iframe).
    const fromNoteWin =
      isNoteWindowOpen() && e.sender === getNoteWindow()?.webContents;
    pm.detailSend(data, frameIdOf(e), fromNoteWin ? getNoteWindow() : null);
    return { ok: true };
  });

  ipcMain.handle(Ipc.PluginDetailContext, (e) => {
    // The standalone note window has its own context payload (not tied to
    // the main launcher's activeDetail).
    if (isNoteWindowOpen() && e.sender === getNoteWindow()?.webContents) {
      const { noteWindowContext } =
        require("./note-window") as typeof import("./note-window");
      return noteWindowContext();
    }
    return pm.detailContext();
  });

  ipcMain.handle(Ipc.DetailSaveFocus, (_e, state: unknown) => {
    pm.saveFocusState(state);
  });

  ipcMain.handle(
    Ipc.PermissionReply,
    (_e, requestId: number, granted: boolean) => {
      pm.permissionReply(Number(requestId), !!granted);
      return { ok: true };
    },
  );

  // Capability calls from a plugin detail frame (window.uTools.*).
  // The owning plugin comes from the plugin:// hostname; the same gate as
  // sandbox calls applies (manifest permissions + dir authorization).
  ipcMain.handle(Ipc.PluginCapability, async (_e, call: CapabilityCall) => {
    if (!call || !call.pluginId || !call.method) {
      return { ok: false, error: "bad capability call" };
    }
    try {
      const result = await pm.detailCapability(
        call.pluginId,
        call.method,
        call.params ?? {},
      );
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    }
  });
}
