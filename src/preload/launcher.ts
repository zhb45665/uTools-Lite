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
  PublicSettings,
  ResultContextMenuRequest,
  ResultContextMenuResponse,
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
  hide(): Promise<void> {
    return ipcRenderer.invoke(Ipc.LauncherHide);
  },
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
  /**
   * Show a native context menu for a search result (right-click / menu key).
   * The main process validates the path and builds the menu; the renderer
   * never sees Electron's Menu or shell directly.
   */
  showResultContextMenu(
    req: ResultContextMenuRequest,
  ): Promise<ResultContextMenuResponse> {
    return ipcRenderer.invoke(
      Ipc.ResultContextMenu,
      req,
    ) as Promise<ResultContextMenuResponse>;
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
  getSettings(): Promise<PublicSettings> {
    return ipcRenderer.invoke(Ipc.SettingsGet) as Promise<PublicSettings>;
  },
  setSettings(settings: Partial<PublicSettings>): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.SettingsSet, settings) as Promise<{
      ok: boolean;
    }>;
  },
  revealData(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(Ipc.DataReveal) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  },
  revealLogs(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(Ipc.LogsReveal) as Promise<{
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
  revealPlugin(
    pluginId: string,
  ): Promise<{ ok: boolean; error?: string; note?: string }> {
    return ipcRenderer.invoke(Ipc.PluginReveal, pluginId) as Promise<{
      ok: boolean;
      error?: string;
      note?: string;
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
  /** Close the current detail view. Performs the beforeClose negotiation
   *  (unsaved-changes check inside the plugin page) before the host
   *  actually closes it. Use detailCloseUnsafe() for force-close. */
  detailClose(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailClose) as Promise<{
      ok: boolean;
    }>;
  },
  /** Force-close the detail view without the beforeClose negotiation. */
  detailCloseUnsafe(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(Ipc.PluginDetailCloseUnsafe) as Promise<{
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
  /**
   * Ask the detail frame whether it allows closing (retention plan 阶段二).
   * The top frame forwards the request to the plugin iframe and waits for
   * its answer; a frame that does not answer within the timeout is treated
   * as allowing close (safe policy, logged by the host).
   */
  detailBeforeClose(): Promise<boolean> {
    void askBeforeCloseInTop();
    return ipcRenderer.invoke(Ipc.DetailBeforeClose) as Promise<boolean>;
  },
  /** Host says the window is showing again: restore focus/scroll state. */
  onDetailResume(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on(Ipc.EvtDetailResume, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtDetailResume, listener);
    };
  },
  /**
   * Snapshot the focused field / caret / scroll position in the top frame
   * and push it to the detail iframe, which stores it for the next resume.
   */
  detailSaveFocus(): void {
    try {
      const el = document.activeElement as HTMLElement | null;
      const frame = document.querySelector(
        "iframe.detail-frame",
      ) as HTMLIFrameElement | null;
      const state = {
        fieldId: el && el.id ? el.id : null,
        selStart:
          el && "selectionStart" in el
            ? (el as HTMLInputElement).selectionStart
            : null,
        selEnd:
          el && "selectionEnd" in el
            ? (el as HTMLInputElement).selectionEnd
            : null,
        bodyTop: document.body.scrollTop || 0,
        bodyLeft: document.body.scrollLeft || 0,
        frameTop: frame ? frame.scrollTop : 0,
        frameLeft: frame ? frame.scrollLeft : 0,
      };
      ipcRenderer.send(Ipc.DetailSaveFocus, state);
    } catch {
      /* focus snapshot is best-effort */
    }
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
  /** Close this detail view. Runs the page's save hooks first, then asks
   *  the host to perform the beforeClose negotiation (unsaved-changes
   *  check) before actually closing. Returns { closed: false } when the
   *  page denied the close (e.g. the user chose "继续编辑").
   *
   *  For the standalone note window, this routes to the NoteWindowClose
   *  IPC (which destroys the separate BrowserWindow) instead of the main
   *  launcher's inline-iframe close path. */
  closeDetail(): Promise<{ closed: boolean }> {
    void runBeforeUnload();
    const isNoteWin = isStandaloneNoteWindow();
    const channel = isNoteWin ? Ipc.NoteWindowClose : Ipc.PluginDetailClose;
    return ipcRenderer.invoke(channel) as Promise<{ closed: boolean }>;
  },
  // --- Standalone note-window controls (no-op in the inline iframe) ---
  /**
   * Read-only flag: true when this plugin: frame is the top-level page of the
   * standalone note window (isMainFrame), false when it's a sub-frame inside
   * the main launcher's inline iframe. The page uses this to decide whether
   * to show its custom title bar (frameless window needs one).
   */
  get isStandalone(): boolean {
    return isStandaloneNoteWindow();
  },
  /** Minimize the standalone note window. No-op when not in the note window. */
  noteWindowMinimize(): Promise<{ ok: boolean }> {
    if (!isStandaloneNoteWindow()) return Promise.resolve({ ok: false });
    return ipcRenderer.invoke(Ipc.NoteWindowMinimize) as Promise<{
      ok: boolean;
    }>;
  },
  /** Toggle maximize/restore for the standalone note window. No-op otherwise. */
  noteWindowToggleMaximize(): Promise<{ ok: boolean }> {
    if (!isStandaloneNoteWindow()) return Promise.resolve({ ok: false });
    return ipcRenderer.invoke(Ipc.NoteWindowToggleMaximize) as Promise<{
      ok: boolean;
    }>;
  },
  /**
   * Subscribe to maximize/restore state changes of the standalone note
   * window (the page swaps the title-bar glyph between ⊡ and ⊟). Returns
   * unsubscribe. In the inline iframe the callback is never fired.
   */
  onNoteWindowState(cb: (maximized: boolean) => void): () => void {
    if (!isStandaloneNoteWindow()) return () => {};
    // Reuse a dedicated push channel the main process emits on maximize/restore.
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on(Ipc.EvtNoteWindowState, listener);
    return () => {
      ipcRenderer.removeListener(Ipc.EvtNoteWindowState, listener);
    };
  },
  /**
   * Register a hook invoked when the host asks whether the detail view may
   * be closed (retention plan 阶段二). Return true to allow, false to keep
   * editing. The host applies a short timeout: an unanswered page is
   * closed anyway (safe policy, logged). Returns unsubscribe.
   */
  onBeforeClose(cb: () => boolean | Promise<boolean>): () => void {
    beforeCloseHandlers.push(cb);
    return () => {
      const i = beforeCloseHandlers.indexOf(cb);
      if (i >= 0) beforeCloseHandlers.splice(i, 1);
    };
  },
  /**
   * Register an async save hook invoked right before the detail view
   * disappears (Esc / window blur). Windows blur-hide in a few ms, so a
   * debounced autosave that has not fired yet would be lost otherwise.
   * Returns unsubscribe.
   */
  onDetailClose(cb: () => unknown): () => void {
    beforeUnloadHandlers.push(cb);
    return () => {
      const i = beforeUnloadHandlers.indexOf(cb);
      if (i >= 0) beforeUnloadHandlers.splice(i, 1);
    };
  },

  // --- capabilities (all gated by the manifest permission model)
  readFile(path: string): Promise<string> {
    // The host answers { content }, but plugin pages expect the file text
    // (matching plugin-host/bootstrap.js, which unwraps the same field).
    return callCapability("fs.read", { path }).then((r) => r.content as string);
  },
  writeFile(path: string, content: string): Promise<{ ok: true }> {
    return callCapability("fs.write", { path, content });
  },
  listDir(
    path: string,
  ): Promise<{ entries: { name: string; dir: boolean; size: number }[] }> {
    return callCapability("fs.list", { path });
  },
  deleteFile(path: string): Promise<{ ok: true }> {
    return callCapability("fs.delete", { path });
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

const beforeUnloadHandlers: Array<() => unknown> = [];
const beforeCloseHandlers: Array<() => boolean | Promise<boolean>> = [];

/**
 * Ask every page hook (in the TOP frame) whether the view may close.
 * Kept symmetric with the plugin-frame askBeforeClose() so the same API
 * shape exists on both sides; the top frame has no page hooks of its own.
 */
async function askBeforeCloseInTop(): Promise<boolean> {
  return true;
}

/** Ask every page hook whether the view may close. Default: allow. */
async function askBeforeClose(): Promise<boolean> {
  for (const cb of [...beforeCloseHandlers]) {
    try {
      const allow = await cb();
      if (allow === false) return false;
    } catch {
      /* a failing check must not block closing */
    }
  }
  return true;
}

/** Run every page-registered save hook; failures must not block closing. */
async function runBeforeUnload(): Promise<void> {
  for (const cb of [...beforeUnloadHandlers]) {
    try {
      await cb();
    } catch {
      /* a failing save must not keep the user in the detail view */
    }
  }
}

// Focus / scroll state saved by the top frame before the window hides.
let savedFocusState: Record<string, unknown> | null = null;

if (location.protocol === "plugin:") {
  ipcRenderer.on(Ipc.DetailSaveFocus, (_e, state: Record<string, unknown>) => {
    savedFocusState = state ?? null;
  });
  // The host tells us the window is visible again: restore focus / caret /
  // scroll on the next frame (the window must be visible first, otherwise
  // focus() is a no-op on Windows).
  ipcRenderer.on(Ipc.EvtDetailResume, () => {
    const state = savedFocusState;
    savedFocusState = null;
    if (!state) return;
    requestAnimationFrame(() => {
      try {
        const body = document.body;
        if (typeof state.frameTop === "number") body.scrollTop = state.frameTop;
        if (typeof state.frameLeft === "number")
          body.scrollLeft = state.frameLeft;
        const id = state.fieldId as string | null;
        if (!id) return;
        const el = document.getElementById(id) as HTMLElement | null;
        if (!el) return;
        el.focus();
        const selStart = state.selStart as number | null;
        const selEnd = state.selEnd as number | null;
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          if (typeof selStart === "number" && typeof selEnd === "number") {
            try {
              el.setSelectionRange(
                Math.min(selStart, el.value.length),
                Math.min(selEnd, el.value.length),
              );
            } catch {
              /* selection may be invalid mid-edit */
            }
          }
        }
      } catch {
        /* resume is best-effort */
      }
    });
  });
}

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

/* Latched by the EvtNoteWindowIdentity event (see wiring below). false until
 * the main process confirms this frame is the standalone note window. */
let noteWindowStandalone = false;

/**
 * True when this plugin: frame is the TOP-LEVEL frame of the standalone
 * note window, as opposed to a sub-frame inside the main launcher's
 * inline iframe. The note window loads plugin://notes/detail.html directly
 * as its main page; the launcher embeds it in an <iframe>. Identity is
 * pushed by the main process via EvtNoteWindowIdentity after did-finish-load
 * (reliable — no URL query or process.isMainFrame dependency).
 */
function isStandaloneNoteWindow(): boolean {
  if (pluginIdFromFrame !== "notes") return false;
  return noteWindowStandalone;
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
  // Latch the standalone-window identity flag. The main process sends this
  // one-shot event to the standalone note window's webContents after
  // did-finish-load; the main launcher's inline iframe never receives it,
  // so noteWindowStandalone stays false there.
  ipcRenderer.on(Ipc.EvtNoteWindowIdentity, (_e, isStandalone: boolean) => {
    noteWindowStandalone = Boolean(isStandalone);
  });
  // Esc inside the detail frame closes the view (acceptance: Esc -> 搜索态).
  // The close goes through the negotiation, so unsaved changes are still
  // confirmed with the user.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void uToolsApi.closeDetail();
    }
  });
  // Host asks whether this page may be closed (beforeClose negotiation).
  ipcRenderer.on(Ipc.EvtDetailBeforeClose, async (_e, reqId: number) => {
    const allow = await askBeforeClose();
    ipcRenderer.send(Ipc.DetailCloseResult, reqId, allow);
  });
  contextBridge.exposeInMainWorld("uTools", uToolsApi);
} else if (isTopFrame) {
  contextBridge.exposeInMainWorld("launcher", launcherApi);
}
