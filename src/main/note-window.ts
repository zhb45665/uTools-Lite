import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { Ipc } from "../shared/ipc";
import { hideLauncher } from "./launcher-window";
import { getPluginManager } from "./plugins/manager";

let noteWin: BrowserWindow | null = null;
let noteContext: {
  keyword: string;
  value: string;
  item: unknown;
} | null = null;
// Guards against a re-entrant close negotiation: destroy() re-fires the
// "close" event, which would otherwise preventDefault() + re-negotiate
// forever (the window could never actually close).
let noteWinDestroying = false;

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
  if (noteWin && !noteWin.isDestroyed()) {
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
  const w = Math.min(1000, dw - 80);
  const h = Math.min(700, dh - 120);
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
    frame: false,
    thickFrame: true,
    title: "随手笔记",
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    hasShadow: true,
    // Match the notes page background so the frameless edge is seamless.
    backgroundColor: "#f7f7f9",
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

  // Load the notes detail page via the plugin: scheme. The ?standalone=1
  // query flag is the RELIABLE discriminator between the standalone note
  // window and the main launcher's inline iframe: both load the same
  // plugin://notes/detail.html path, but only the standalone window carries
  // this query. (process.isMainFrame in the preload is unreliable — process
  // is not always available in the isolated preload world, which caused the
  // close button to route to the wrong IPC channel.)
  noteWin.loadURL("plugin://notes/detail.html?standalone=1");

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
export async function closeNoteWindow(force = false): Promise<void> {
  if (noteWin && !noteWin.isDestroyed()) {
    await closeWithNegotiation(force);
  }
}

async function closeWithNegotiation(force: boolean): Promise<void> {
  if (!noteWin || noteWin.isDestroyed()) return;
  console.log(
    `[note-window] closeWithNegotiation force=${force} win=${noteWin.id}`,
  );

  if (!force) {
    // Ask the page: may we close?
    console.log("[note-window] negotiating beforeClose...");
    const allow = await negotiateBeforeClose(noteWin);
    console.log(`[note-window] negotiation result allow=${allow}`);
    if (!allow) return; // page said no — stay open
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
  noteWinDestroying = true;
  try {
    console.log("[note-window] calling destroy()");
    noteWin.destroy();
  } catch (e) {
    console.error("[note-window] destroy() threw", e);
  } finally {
    noteWinDestroying = false;
  }
  noteWin = null;
  noteContext = null;
  console.log("[note-window] closeWithNegotiation done");
}

/**
 * Ask the note page whether it allows closing. Sends EvtDetailBeforeClose
 * and waits for DetailCloseResult, with a 10-second timeout (safe policy:
 * an unanswered page is closed anyway).
 */
function negotiateBeforeClose(win: BrowserWindow): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const reqId = Date.now() + Math.floor(Math.random() * 1000);

    const onResult = (_e: unknown, id: number, allow: boolean) => {
      if (id === reqId) {
        console.log(`[note-window] DetailCloseResult received allow=${allow}`);
        settle(Boolean(allow));
      }
    };
    // SAFETY: Electron's d.ts only types a subset of WebContents events;
    // the cast silences the incomplete event-name union. The listener
    // receives (event, reqId, allow) at runtime.
    const onResultAny = onResult as unknown as (event: unknown) => void;

    const settle = (allow: boolean) => {
      if (settled) return;
      settled = true;
      // SAFETY: same event-name union cast as the .on() call above; the
      // channel name is a valid runtime event, the d.ts union is incomplete.
      win.webContents.removeListener(
        Ipc.DetailCloseResult as unknown as "zoom-changed",
        onResultAny,
      );
      resolve(allow);
    };

    const timer = setTimeout(() => {
      console.log("[note-window] negotiation TIMEOUT -> allow close");
      settle(true);
    }, 10_000);
    timer.unref?.();

    // SAFETY: same event-name union cast; see comment on onResultAny.
    win.webContents.on(
      Ipc.DetailCloseResult as unknown as "zoom-changed",
      onResultAny,
    );
    console.log("[note-window] sending EvtDetailBeforeClose to page");
    win.webContents.send(Ipc.EvtDetailBeforeClose, reqId);
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
    pluginId: "notes",
    pluginName: "随手笔记",
    keyword: noteContext.keyword,
    value: noteContext.value,
    item: noteContext.item,
  };
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
