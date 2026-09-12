import fs from "node:fs";
import path from "node:path";
import { ipcMain, app, clipboard, dialog } from "electron";
import { Ipc, SearchItem, CapabilityCall } from "../shared/ipc";
import { SettingsStore } from "./store";
import { registerHotkey, getCurrentHotkey } from "./hotkey";
import {
  showLauncher,
  hideLauncher,
  suspendBlurHide,
  resumeBlurHide,
} from "./launcher-window";
import { runSearch } from "./search";
import { detectEverything } from "./file-index/everything-cli";
import { getAppCount } from "./file-index/app-index";
import { getIndexStatus } from "./file-index/local-index";
import { shell } from "electron";
import { PluginManager } from "./plugins/manager";

/**
 * Wire up all ipcMain handlers the renderer talks to via the preload bridge.
 */
export function registerIpc(
  store: SettingsStore,
  pm: PluginManager,
  onHotkeyChanged: () => void,
): void {
  ipcMain.handle(Ipc.SearchQuery, async (_e, query: string) => {
    return runSearch(query ?? "");
  });

  ipcMain.handle(
    Ipc.Launch,
    async (_e, item: { payload: string; type: string }) => {
      const payload = item?.payload;
      if (!payload) return { ok: false };
      try {
        if (item.type === "command") {
          // Calculator result -> copy to clipboard.
          clipboard.writeText(payload);
          return { ok: true, copied: payload };
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
    const ok = registerHotkey(accelerator, () => showLauncher());
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
    pm.markDetailReady();
    return { ok: true };
  });

  ipcMain.handle(Ipc.PluginDetailClose, () => {
    pm.closeDetail(true);
    return { ok: true };
  });

  ipcMain.handle(Ipc.PluginDetailSend, (_e, data: unknown) => {
    pm.detailSend(data);
    return { ok: true };
  });

  ipcMain.handle(Ipc.PluginDetailContext, () => {
    return pm.detailContext();
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
