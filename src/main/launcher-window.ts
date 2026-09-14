import { BrowserWindow, screen, shell, app } from "electron";
import path from "node:path";
import { SettingsStore } from "./store";

let win: BrowserWindow | null = null;
let store: SettingsStore;
let isPreload = true;
let blurSuspended = 0; // ref-counted: native dialogs would otherwise blur-hide the window
let onExternalSuspend: (() => number) | null = null;
let credentialOriginalSize: [number, number] | null = null;

/** Expand the credential workspace and restore the compact launcher on exit. */
export function setCredentialWindow(expanded: boolean): void {
  if (!win || win.isDestroyed()) return;
  if (expanded && !credentialOriginalSize)
    credentialOriginalSize = win.getContentSize() as [number, number];
  if (!expanded && !credentialOriginalSize) return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const desired = expanded ? [1000, 700] : credentialOriginalSize!;
  // Store/restore content dimensions; outer dimensions include rounded Windows borders.
  const width = Math.min(desired[0], area.width - 2),
    height = Math.min(desired[1], area.height - 2);
  win.setContentSize(width, height);
  const bounds = win.getBounds();
  win.setPosition(
    Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)),
  );
  if (!expanded) credentialOriginalSize = null;
}

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
    useContentSize: true,
    show: false,
    frame: false,
    // Start transparent for the compact launcher (rounded card on desktop).
    // The maximize path toggles this off for a solid full-screen surface —
    // transparent windows can't be reliably maximized on Windows.
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
    if (effectiveBlurSuspended() > 0) return; // dialog / permission card open: stay visible
    // Hide when focus is lost, like Spotlight / uTools. The detail view is
    // intentionally NOT closed here: blur is a temporary departure, and the
    // password editor (and other long-form plugin pages) must survive it.
    // Explicit close paths (Esc / close button / plugin switch) still go
    // through PluginManager.closeDetail().
    //
    // Do not persist rememberSize while the window is in the expanded
    // credential workspace: the compact launcher size must not be replaced
    // by the 1000x700 detail size (risk 12.3). credentialOriginalSize
    // already holds the pre-detail size and is restored on explicit close.
    if (win && !win.isDestroyed() && !credentialOriginalSize) {
      const [w, h] = win.getContentSize();
      store.set("rememberSize", { width: w, height: h });
    }
    if (win && !win.isDestroyed()) win.hide();
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
  // Do NOT call setCredentialWindow(false) here: a re-show must restore the
  // editor the user left, at the expanded size. The compact size is only
  // restored by an explicit detail close (PluginDetailClose / Esc / close
  // button), which goes through closeDetail().
  positionOnCursorDisplay(win);
  win.show();
  win.focus();
  win.webContents.send("launcher:show");
  // Ask the plugin manager to resume the active detail view (focus/scroll).
  // The manager only sends the frame-targeted event when a detail is open.
  onLauncherShown?.();
}

/** Hook: called after the launcher window is shown (used to resume details). */
let onLauncherShown: (() => void) | null = null;

export function setLauncherShownHook(fn: (() => void) | null): void {
  onLauncherShown = fn;
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
export function suspendBlurHide(): number {
  const wasSuspended = blurSuspended;
  blurSuspended++;
  return wasSuspended; // 0 -> this call is what suspends blur-hide
}

export function resumeBlurHide(): void {
  blurSuspended = Math.max(0, blurSuspended - 1);
}

/** Tell the plugin manager a detail view was visible and the window blurred.
 *  Retained for API compatibility; the blur handler no longer closes the
 *  detail (retention plan 阶段一), so the handler is now a no-op sink that
 *  only records activity. index.ts still registers it. */
let onWindowBlur: (() => void) | null = null;

export function setWindowBlurHandler(fn: (() => void) | null): void {
  onWindowBlur = fn;
  void onWindowBlur; // keep the variable alive for future re-wiring
}

/**
 * Register a callback that participates in blur-hide suspension from
 * outside the window module (e.g. a permission card that must stay on
 * screen to be answered). Returns the current external suspend count.
 */
export function setBlurSuspendProbe(fn: (() => number) | null): void {
  onExternalSuspend = fn;
}

/**
 * Total blur-hide suspension: window-local dialog locks plus external
 * locks (permission cards). A probe failure must not break blur handling.
 */
function effectiveBlurSuspended(): number {
  let total = blurSuspended;
  if (onExternalSuspend) {
    try {
      const n = onExternalSuspend();
      if (typeof n === "number" && n > 0) total += n;
    } catch {
      /* ignore */
    }
  }
  return total;
}
