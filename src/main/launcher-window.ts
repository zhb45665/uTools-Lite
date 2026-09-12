import { BrowserWindow, screen, shell, app } from "electron";
import path from "node:path";
import { SettingsStore } from "./store";

let win: BrowserWindow | null = null;
let store: SettingsStore;
let isPreload = true;
let blurSuspended = 0; // ref-counted: native dialogs would otherwise blur-hide the window

function devRendererUrl(): string | undefined {
  // In dev we could point at the Vite dev server, but for P1 we always load
  // the built renderer so a single `npm start` path works.
  return undefined;
}

function rendererUrl(): string {
  const dev = devRendererUrl();
  if (dev) return dev;
  return path.join(__dirname, "../renderer/index.html");
}

/**
 * Create the launcher window once (pre-created & hidden) so the hotkey path is
 * just a show() -> sub-50ms.
 */
export function createLauncherWindow(settings: SettingsStore): void {
  store = settings;
  if (win) return;

  const { width, height } = store.get("rememberSize") ?? {
    width: 720,
    height: 460,
  };

  win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/launcher.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: false — REQUIRED. The tsc-compiled preload does
      // require("../shared/ipc") for channel constants, and a sandboxed
      // preload's polyfilled require cannot load local modules
      // ("module not found") — the bridge never installs and the UI stays
      // blank (transparent window). Page-side isolation is preserved:
      // contextIsolation + nodeIntegration:false keep the page away from
      // Node entirely; only the explicit window.launcher API is reachable.
      sandbox: false,
      // nodeIntegrationInSubFrames — REQUIRED for plugin detail views. The
      // preload branches on location.protocol: `plugin:` frames get
      // window.uTools, the top frame gets window.launcher. Without this flag
      // the preload never runs inside the detail iframe, so every plugin
      // detail API (getDetailContext/readFile/writeFile/toast/capabilities)
      // is missing and plugin pages silently fail.
      // Safety: contextIsolation + nodeIntegration:false keep the plugin page
      // away from Node; the preload only exposes uTools there (see
      // src/preload/launcher.ts) and nothing at all in deeper frames.
      nodeIntegrationInSubFrames: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(rendererUrl());

  win.on("blur", () => {
    if (blurSuspended > 0) return; // dialog open: stay visible
    // Hide when focus is lost, like Spotlight / uTools.
    if (win && !win.isDestroyed()) {
      // Save size before hiding.
      const [w, h] = win.getSize();
      store.set("rememberSize", { width: w, height: h });
      onWindowBlur?.(); // e.g. close an open plugin detail view (fires onExit)
      win.hide();
    }
  });

  win.webContents.on("did-finish-load", () => {
    isPreload = false;
  });
}

function positionOnCursorDisplay(w: BrowserWindow): void {
  const [width] = w.getSize();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width: dw, height: dh } = display.workArea;
  // Center horizontally, place at ~30% from the top of the work area.
  const nx = x + Math.round((dw - width) / 2);
  const ny = y + Math.round(dh * 0.3);
  w.setPosition(nx, ny);
}

export function showLauncher(): void {
  if (!win || win.isDestroyed()) return;
  positionOnCursorDisplay(win);
  win.show();
  win.focus();
  win.webContents.send("launcher:show");
}

export function hideLauncher(): void {
  if (win && !win.isDestroyed()) win.hide();
}

export function toggleLauncher(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) hideLauncher();
  else showLauncher();
}

export function isLauncherVisible(): boolean {
  return !!win && win.isVisible();
}

export function getLauncherWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function openExternal(target: string): void {
  if (target) shell.openPath(target);
}

export function isWindowPreloaded(): boolean {
  return isPreload;
}

/**
 * Temporarily disable blur-hide (ref-counted). Needed before opening native
 * dialogs: a modal dialog blurs the window and would hide it (pitfall §16.2-5).
 */
export function suspendBlurHide(): void {
  blurSuspended++;
}

export function resumeBlurHide(): void {
  blurSuspended = Math.max(0, blurSuspended - 1);
}

/** Tell the plugin manager a detail view was visible and the window blurred. */
let onWindowBlur: (() => void) | null = null;

export function setWindowBlurHandler(fn: (() => void) | null): void {
  onWindowBlur = fn;
}
