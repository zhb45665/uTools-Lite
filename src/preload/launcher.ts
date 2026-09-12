import { contextBridge, ipcRenderer } from "electron";
import {
  Ipc,
  SearchItem,
  SearchResponse,
  AppInfo,
  FileIndexStatus,
  PluginInfo,
  PluginSelectResult,
  PermissionRequest,
  DetailContext,
} from "../shared/ipc";

/**
 * Preload bridge.
 *
 * Two worlds, one script:
 *   - main launcher frame (file:): exposes `window.launcher` (narrow API)
 *   - plugin detail frame (plugin:): exposes ONLY `window.uTools`
 *
 * The plugin frame NEVER gets `launcher` (or raw ipcRenderer), so a plugin
 * page cannot talk to launcher internals or forge host commands.
 */

// ------------------------------------------------------------------ types
export interface ToastPayload {
  msg: string;
}

export interface DetailMessagePayload {
  pluginId: string;
  data: unknown;
}

// ------------------------------------------------- launcher frame (main)
const launcherApi = {
  search(query: string): Promise<SearchResponse> {
    return ipcRenderer.invoke(
      Ipc.SearchQuery,
      query,
    ) as Promise<SearchResponse>;
  },
  launch(
    item: Pick<SearchItem, "payload" | "type">,
  ): Promise<{ ok: boolean; error?: string; copied?: string }> {
    return ipcRenderer.invoke(Ipc.Launch, item) as Promise<{
      ok: boolean;
      error?: string;
      copied?: string;
    }>;
  },
  appInfo(): Promise<AppInfo> {
    return ipcRenderer.invoke(Ipc.AppInfo) as Promise<AppInfo>;
  },
  getHotkey(): Promise<{ hotkey: string }> {
    return ipcRenderer.invoke(Ipc.HotkeyGet) as Promise<{ hotkey: string }>;
  },
  setHotkey(accelerator: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(Ipc.HotkeySet, accelerator) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  },
  quit(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.AppQuit) as Promise<{ ok: boolean }>;
  },

  // --- plugins
  listPlugins(): Promise<PluginInfo[]> {
    return ipcRenderer.invoke(Ipc.PluginList) as Promise<PluginInfo[]>;
  },
  installPlugin(
    fromPath: string,
  ): Promise<{ ok: boolean; error?: string; pluginId?: string }> {
    return ipcRenderer.invoke(Ipc.PluginInstall, fromPath) as Promise<{
      ok: boolean;
      error?: string;
      pluginId?: string;
    }>;
  },
  installPluginPick(): Promise<{
    ok: boolean;
    error?: string;
    pluginId?: string;
  }> {
    return ipcRenderer.invoke(Ipc.PluginInstallPick) as Promise<{
      ok: boolean;
      error?: string;
      pluginId?: string;
    }>;
  },
  uninstallPlugin(pluginId: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(Ipc.PluginUninstall, pluginId) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  },
  rescanPlugins(): Promise<PluginInfo[]> {
    return ipcRenderer.invoke(Ipc.PluginRescan) as Promise<PluginInfo[]>;
  },
  revealPlugin(pluginId: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginReveal, pluginId) as Promise<{
      ok: boolean;
    }>;
  },
  selectPlugin(item: SearchItem): Promise<PluginSelectResult> {
    return ipcRenderer.invoke(
      Ipc.PluginSelect,
      item,
    ) as Promise<PluginSelectResult>;
  },
  detailReady(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailReady) as Promise<{
      ok: boolean;
    }>;
  },
  detailClose(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailClose) as Promise<{
      ok: boolean;
    }>;
  },
  detailSend(data: unknown): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailSend, data) as Promise<{
      ok: boolean;
    }>;
  },
  permissionReply(
    requestId: number,
    granted: boolean,
  ): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(
      Ipc.PermissionReply,
      requestId,
      granted,
    ) as Promise<{ ok: boolean }>;
  },

  // --- main -> renderer events
  onShow(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on(Ipc.EvtLauncherShow, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtLauncherShow, listener);
    };
  },
  onPermissionRequest(cb: (req: PermissionRequest) => void): () => void {
    const listener = (_e: unknown, req: PermissionRequest) => cb(req);
    ipcRenderer.on(Ipc.EvtPermissionRequest, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtPermissionRequest, listener);
    };
  },
  onToast(cb: (t: ToastPayload) => void): () => void {
    const listener = (_e: unknown, t: ToastPayload) => cb(t);
    ipcRenderer.on(Ipc.EvtToast, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtToast, listener);
    };
  },
  onDetailExit(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on(Ipc.EvtDetailExit, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtDetailExit, listener);
    };
  },
  onFileIndexProgress(cb: (s: FileIndexStatus) => void): () => void {
    const listener = (_e: unknown, s: FileIndexStatus) => cb(s);
    ipcRenderer.on(Ipc.FileIndexProgress, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.FileIndexProgress, listener);
    };
  },
};

export type LauncherApi = typeof launcherApi;

// ------------------------------------------- plugin detail frame (uTools)
const pluginIdFromFrame = location.protocol === "plugin:" ? location.host : "";

const uToolsApi = {
  /** Context of the currently open detail view. */
  getDetailContext(): Promise<DetailContext | null> {
    return ipcRenderer.invoke(
      Ipc.PluginDetailContext,
    ) as Promise<DetailContext | null>;
  },
  /** Subscribe to messages from the plugin's main.js. Returns unsubscribe. */
  onMainMessage(cb: (data: unknown) => void): () => void {
    const listener = (_e: unknown, p: DetailMessagePayload) => {
      if (p.pluginId !== pluginIdFromFrame) return;
      cb(p.data);
    };
    ipcRenderer.on(Ipc.EvtDetailMessage, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtDetailMessage, listener);
    };
  },
  /** Send a message to the plugin's main.js (host relays it). */
  sendMainMessage(data: unknown): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailSend, data) as Promise<{
      ok: boolean;
    }>;
  },
  /** Close this detail view (host fires main.js onExit). */
  closeDetail(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailClose) as Promise<{
      ok: boolean;
    }>;
  },

  // --- capabilities (all gated by the manifest permission model)
  readFile(path: string): Promise<string> {
    return callCapability("fs.read", { path });
  },
  writeFile(path: string, content: string): Promise<{ ok: true }> {
    return callCapability("fs.write", { path, content });
  },
  listDir(
    path: string,
  ): Promise<{ entries: { name: string; dir: boolean; size: number }[] }> {
    return callCapability("fs.list", { path });
  },
  getClipboardText(): Promise<string> {
    return callCapability("clipboard.read", {}).then((r) => r.text as string);
  },
  copyText(text: string): Promise<{ ok: true }> {
    return callCapability("clipboard.write", { text });
  },
  fetch(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{ status: number; ok: boolean; body: string }> {
    return callCapability("net.fetch", { url, options });
  },
  openPath(path: string): Promise<{ ok: boolean; error?: string }> {
    return callCapability("shell.openPath", { path });
  },
  getDataDir(): Promise<string> {
    return callCapability("data.dir", {}).then((r) => r.dir as string);
  },

  // --- misc
  toast(msg: string): void {
    // Detail frames have their own DOM; render a small in-frame toast.
    toastLocal(msg);
  },
  log(...args: unknown[]): void {
    console.log(`[uTools:${pluginIdFromFrame}]`, ...args);
  },
  onToast(cb: (t: ToastPayload) => void): () => void {
    const listener = (_e: unknown, t: ToastPayload) => cb(t);
    ipcRenderer.on(Ipc.EvtToast, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtToast, listener);
    };
  },
  onExit(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on(Ipc.EvtDetailExit, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtDetailExit, listener);
    };
  },
};

async function callCapability(
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const res = (await ipcRenderer.invoke(Ipc.PluginCapability, {
    pluginId: pluginIdFromFrame,
    method,
    params,
  })) as { ok: boolean; result?: unknown; error?: string };
  if (!res.ok) throw new Error(res.error ?? "capability call failed");
  return res.result;
}

function toastLocal(msg: string): void {
  // Lightweight in-frame toast (detail views have their own DOM).
  try {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);" +
      "background:rgba(30,30,34,.95);color:#e8e8ea;padding:8px 14px;" +
      "border-radius:8px;font:13px system-ui;z-index:9999;pointer-events:none;";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  } catch {
    /* no DOM yet */
  }
}

export type UToolsApi = typeof uToolsApi;

// ---------------------------------------------------------------- wiring
// The preload now also runs inside subframes (nodeIntegrationInSubFrames),
// which is how plugin detail iframes receive window.uTools. Only the TOP
// frame may get `launcher`: a plugin page could otherwise create a nested
// iframe (e.g. about:blank) and pick up the launcher API from inside it.
const isTopFrame =
  typeof process === "undefined" ||
  (process as { isMainFrame?: boolean }).isMainFrame !== false;

if (location.protocol === "plugin:") {
  // Esc inside the detail frame closes the view (acceptance: Esc -> 搜索态).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void uToolsApi.closeDetail();
    }
  });
  contextBridge.exposeInMainWorld("uTools", uToolsApi);
} else if (isTopFrame) {
  contextBridge.exposeInMainWorld("launcher", launcherApi);
}
