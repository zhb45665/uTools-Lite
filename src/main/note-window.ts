import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { Ipc } from "../shared/ipc";
import { hideLauncher } from "./launcher-window";
import { getPluginManager } from "./plugins/manager";

let noteWin: BrowserWindow | null = null;
let noteContext: {
  pluginId: string;
  pluginName: string;
  detail: string;
  keyword: string;
  value: string;
  item: unknown;
} | null = null;
// Guards against a re-entrant close negotiation: destroy() re-fires the
// "close" event, which would otherwise preventDefault() + re-negotiate
// forever (the window could never actually close).
let noteWinDestroying = false;
let noteClosePromise: Promise<boolean> | null = null;

/**
 * Open (or focus) a standalone, resizable note window.
 *
 * The window has a native title bar (frame: true) so the user can drag,
 * resize, minimize, maximize, and close it like a normal app window. The
 * main launcher window keeps its compact fixed size — the note editor
 * lives in this separate surface, matching the "笔记单独弹窗调整大小"
 * request.
 *
 * The loaded URL is plugin://notes/detail.html so the existing preload
 * branch (location.protocol === "plugin:") attaches window.uTools with
 * the same capability API the inline iframe uses.
 */
export function openNoteWindow(ctx: {
  keyword: string;
  value: string;
  item: unknown;
}): void {
  openStandalonePluginWindow({
    pluginId: "notes",
    pluginName: "随手笔记",
    detail: "detail.html",
    ...ctx,
  });
}

/** Open a long-form plugin in a dedicated resizable window. */
export function openStandalonePluginWindow(ctx: {
  pluginId: string;
  pluginName: string;
  detail: string;
  keyword: string;
  value: string;
  item: unknown;
}): void {
  if (noteWin && !noteWin.isDestroyed()) {
    if (noteContext?.pluginId !== ctx.pluginId) {
      void closeWithNegotiation(false).then((closed) => {
        if (closed) openStandalonePluginWindow(ctx);
      });
      return;
    }
    // Already open: update the context payload and re-focus.
    noteContext = ctx;
    if (noteWin.isMinimized()) noteWin.restore();
    noteWin.show();
    noteWin.focus();
    return;
  }

  noteContext = ctx;

  // Size: start at a comfortable default; the user can drag the edges.
  const display = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = display.workAreaSize;
  const preferredSize: Record<string, { width: number; height: number }> = {
    password: { width: 1120, height: 760 },
    notes: { width: 1000, height: 700 },
    "calc-paper": { width: 900, height: 640 },
    amount: { width: 820, height: 560 },
    timestamp: { width: 900, height: 640 },
    ocr: { width: 1040, height: 720 },
  };
  const preferred = preferredSize[ctx.pluginId] ?? { width: 920, height: 660 };
  const w = Math.min(preferred.width, dw - 80);
  const h = Math.min(preferred.height, dh - 100);
  const x = Math.round(display.workArea.x + (dw - w) / 2);
  const y = Math.round(display.workArea.y + (dh - h) / 2);

  noteWin = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    useContentSize: true,
    // Frameless: no native blue title bar. The page draws its own minimal
    // title bar (drag region + minimize/maximize/close buttons). Windows
    // edge-resize works via thickFrame (native frame metrics, transparent).
    // Notes/password/amount 等插件均使用无边框，保持整体 UI 风格统一。
    // 如需新插件也去掉蓝色标题栏，只需将 pluginId 加入下方列表。
    frame: !["notes", "password", "amount", "calc-paper", "timestamp", "ocr"].includes(ctx.pluginId),
    thickFrame: true,
    title: ctx.pluginName,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    hasShadow: true,
    // 匹配各插件页面背景色，frameless 边缘无白边。
    backgroundColor: ctx.pluginId === "password" ? "#f2f5fa" : "#f7f7f9",
    webPreferences: {
      preload: path.join(__dirname, "../preload/launcher.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The plugin: protocol frame needs nodeIntegrationInSubFrames for the
      // preload to run inside it and expose window.uTools.
      nodeIntegrationInSubFrames: true,
    },
  });

  // Load the notes detail page via the plugin: scheme. The standalone flag
  // is pushed to the page via a one-shot IPC event AFTER load (see the
  // did-finish-load handler below), because a ?query string on the plugin:
  // scheme breaks Electron's custom-protocol request handling (caused a
  // white-screen "load failed" error). process.isMainFrame in preload is
  // also unreliable (process not available in isolated world).
  noteWin.loadURL(`plugin://${ctx.pluginId}/${ctx.detail}`);

  // Push the standalone identity flag to the page as early as possible.
  // Use dom-ready (DOM parsed, fires around DOMContentLoaded) rather than
  // did-finish-load (fires after all sub-resources load) so the flag is
  // latched in the preload BEFORE the page's DOMContentLoaded handler reads
  // uTools.isStandalone to decide whether to show the title bar. The main
  // launcher's inline iframe never receives this event.
  noteWin.webContents.on("dom-ready", () => {
    noteWin?.webContents.send(Ipc.EvtNoteWindowIdentity, true);
    emitWindowState();
  });

  noteWin.on("close", (e) => {
    // While we are the ones calling destroy() (after a successful
    // negotiation), let the close through without re-negotiating —
    // destroy() re-fires "close", and intercepting it again would loop
    // forever and the window could never close.
    if (noteWinDestroying) return;
    // Perform the beforeClose negotiation: ask the page if it has unsaved
    // changes. The page's onBeforeClose hook returns false to refuse.
    // We defer the actual close until the page answers (or times out).
    e.preventDefault();
    void closeWithNegotiation(false);
  });

  noteWin.on("closed", () => {
    noteClosePromise = null;
    noteWin = null;
    noteContext = null;
  });

  // Keep the custom title-bar glyph in sync with maximize/restore.
  noteWin.on("maximize", emitWindowState);
  noteWin.on("unmaximize", emitWindowState);
  // Push the initial (restored) state once the page is ready to listen.
  noteWin.webContents.on("did-finish-load", emitWindowState);

  // When the note window gains focus, hide the launcher (Spotlight-style):
  // the user is now "inside" the notes; pressing the hotkey again should
  // bring back the search bar, not both windows stacked.
  noteWin.on("focus", () => {
    hideLauncher();
  });
}

/**
 * Close the note window with the beforeClose negotiation. The page may
 * refuse (return false) if it has unsaved content; in that case the window
 * stays open and the user is left to decide (save / discard / Esc again).
 *
 * @param force true to skip negotiation (app quit path).
 */
export async function closeNoteWindow(force = false): Promise<boolean> {
  if (noteWin && !noteWin.isDestroyed()) {
    return closeWithNegotiation(force);
  }
  return true;
}

async function closeWithNegotiation(force: boolean): Promise<boolean> {
  if (!noteWin || noteWin.isDestroyed()) return true;
  if (noteClosePromise) return noteClosePromise;
  noteClosePromise = closeWithNegotiationOnce(force);
  try {
    return await noteClosePromise;
  } finally {
    noteClosePromise = null;
  }
}

async function closeWithNegotiationOnce(force: boolean): Promise<boolean> {
  const win = noteWin;
  if (!win || win.isDestroyed()) return true;
  console.log(
    `[note-window] closeWithNegotiation force=${force} win=${win.id}`,
  );

  if (!force) {
    // Ask the page: may we close?
    console.log("[note-window] negotiating beforeClose...");
    const allow = await negotiateBeforeClose(win);
    console.log(`[note-window] negotiation result allow=${allow}`);
    if (!allow) return false; // page said no — stay open
  }

  // Tell the plugin sandbox we're exiting (fires onExit in main.js).
  const pm = getPluginManager();
  if (pm) {
    try {
      // Access the sandbox map via the public list() to avoid reaching into
      // private state; post "exit" if the notes sandbox is still alive.
      const list = pm.list();
      const info = list.find((p) => p.id === "notes");
      if (info && info.status === "running") {
        // Fire the exit signal; the sandbox stays warm for reuse.
        // The manager doesn't expose a direct post(), so we rely on the
        // idle-reaper to clean up. The onExit hook in main.js fires when
        // the sandbox process exits naturally or is reaped.
        void info;
      }
    } catch {
      /* sandbox may already be gone */
    }
  }

  // Mark as destroying BEFORE destroy() so the re-fired "close" event is
  // not intercepted into another negotiation loop.
  if (win.isDestroyed()) return true;
  noteWinDestroying = true;
  try {
    console.log("[note-window] calling destroy()");
    win.destroy();
  } catch (e) {
    console.error("[note-window] destroy() threw", e);
  } finally {
    noteWinDestroying = false;
  }
  if (noteWin === win) {
    noteWin = null;
    noteContext = null;
  }
  console.log("[note-window] closeWithNegotiation done");
  return true;
}

/**
 * Ask the note page whether it allows closing. Sends EvtDetailBeforeClose
 * and waits for DetailCloseResult. An unanswered or destroyed page is kept
 * open/treated as denied so an uncertain save can never silently lose data.
 */
function negotiateBeforeClose(win: BrowserWindow): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const reqId = Date.now() + Math.floor(Math.random() * 1000);

    const senderId = win.webContents.id;
    let timer: NodeJS.Timeout | null = null;
    const onResult = (event: Electron.IpcMainEvent, id: number, allow: boolean) => {
      if (event.sender.id === senderId && id === reqId) {
        console.log(`[note-window] DetailCloseResult received allow=${allow}`);
        settle(Boolean(allow));
      }
    };
    const settle = (allow: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ipcMain.removeListener(Ipc.DetailCloseResult, onResult);
      win.removeListener("closed", onWindowGone);
      resolve(allow);
    };

    const onWindowGone = () => settle(false);

    timer = setTimeout(() => {
      console.log("[note-window] negotiation TIMEOUT -> keep open");
      settle(false);
    }, 10_000);
    timer.unref?.();

    ipcMain.on(Ipc.DetailCloseResult, onResult);
    win.once("closed", onWindowGone);
    console.log("[note-window] sending EvtDetailBeforeClose to page");
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      settle(false);
      return;
    }
    try {
      win.webContents.send(Ipc.EvtDetailBeforeClose, reqId);
    } catch {
      settle(false);
    }
  });
}

/**
 * Return the context payload the note page should see from
 * uTools.getDetailContext(). Called by the IPC handler that serves
 * PluginDetailContext for the note window's webContents.
 */
export function noteWindowContext(): {
  pluginId: string;
  pluginName: string;
  keyword: string;
  value: string;
  item: unknown;
} | null {
  if (!noteContext) return null;
  return {
    pluginId: noteContext.pluginId,
    pluginName: noteContext.pluginName,
    keyword: noteContext.keyword,
    value: noteContext.value,
    item: noteContext.item,
  };
}

/** Plugin currently hosted by the standalone window. */
export function standaloneWindowPluginId(): string | null {
  return isNoteWindowOpen() ? noteContext?.pluginId ?? null : null;
}

/** True when the note window is currently open. */
export function isNoteWindowOpen(): boolean {
  return !!noteWin && !noteWin.isDestroyed();
}

/** Return the note window (or null). Used by the plugin manager to route
 *  main.js -> detail messages to the standalone surface instead of the
 *  main launcher's inline iframe. */
export function getNoteWindow(): BrowserWindow | null {
  return noteWin && !noteWin.isDestroyed() ? noteWin : null;
}

/** Minimize the note window (called from the custom title bar). */
export function minimizeNoteWindow(): void {
  if (noteWin && !noteWin.isDestroyed()) noteWin.minimize();
}

/** Toggle maximize / restore (called from the custom title bar). The page
 *  listens for maximize/restore events to swap the button glyph. */
export function toggleNoteWindowMaximize(): void {
  if (!noteWin || noteWin.isDestroyed()) return;
  if (noteWin.isMaximized()) noteWin.unmaximize();
  else noteWin.maximize();
}

/**
 * Push the current maximize/restore state to the note page so its custom
 * title bar can swap the button glyph (⊡ maximize / ⊟ restore). Called on
 * every maximize/restore transition and once after the window loads.
 */
function emitWindowState(): void {
  if (noteWin && !noteWin.isDestroyed()) {
    noteWin.webContents.send(Ipc.EvtNoteWindowState, noteWin.isMaximized());
  }
}

/** Re-export for the IPC layer to call after a maximize toggle settles. */
export function notifyNoteWindowState(): void {
  emitWindowState();
}

/** Whether the note window is currently maximized (for the title-bar glyph). */
export function isNoteWindowMaximized(): boolean {
  return !!noteWin && !noteWin.isDestroyed() && noteWin.isMaximized();
}
