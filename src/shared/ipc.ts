// Shared IPC channel names + payload types. Imported by main, preload, and renderer.

export const Ipc = {
 /** Run a search query. */
 SearchQuery: "search:query",
 /** Open/launch a file or app. */
 Launch: "launch:item",
 /** Get app/system info (e.g. whether Everything CLI is available). */
 AppInfo: "app:info",
 /** Push local file-index progress (count/complete) to the launcher UI. */
 FileIndexProgress: "file-index:progress",
 /** Get the current hotkey string. */
 HotkeyGet: "hotkey:get",
 /** Set the hotkey and re-register it. Returns { ok, error? }. */
 HotkeySet: "hotkey:set",
 /** Request to quit the app (from settings). */
 AppQuit: "app:quit",

 // --- Plugin system ---
 /** List installed plugins + running status. */
 PluginList: "plugin:list",
 /** Install a plugin from a local folder or .zip. */
 PluginInstall: "plugin:install",
 /** Open a native picker (folder or .zip) and return the chosen path. */
 PluginInstallPick: "plugin:install-pick",
 /** Remove a user-installed plugin. */
 PluginUninstall: "plugin:uninstall",
 /** Rescan the plugin directories. */
 PluginRescan: "plugin:rescan",
 /** Open a plugin folder in Explorer. */
 PluginReveal: "plugin:reveal",
 /** Select a plugin result item -> runs the plugin / opens its detail view. */
 PluginSelect: "plugin:select",
 /** Renderer tells main the detail iframe finished mounting. */
 PluginDetailReady: "plugin:detail-ready",
 /** Close the currently open detail view (plugin onExit fires). */
 PluginDetailClose: "plugin:detail-close",
 /** Detail view -> plugin main.js message. */
 PluginDetailSend: "plugin:detail-send",
 /** Read the detail-view context (keyword, selected item, plugin id). */
 PluginDetailContext: "plugin:detail-context",
 /** Permission prompt answer from the renderer. */
 PermissionReply: "plugin:permission-reply",
 /** Detail frame -> host capability call (fs/clipboard/net/shell), gated. */
 PluginCapability: "plugin:capability",

 // --- main -> renderer push events ---
 /** main -> renderer: show an inline permission prompt. */
 EvtPermissionRequest: "plugin:evt-permission-request",
 /** main -> renderer: plugin toast. */
 EvtToast: "plugin:evt-toast",
 /** main -> renderer: message from plugin main.js to the detail view. */
 EvtDetailMessage: "plugin:evt-detail-message",
 /** main -> renderer: detail view should close (e.g. plugin called exit). */
 EvtDetailExit: "plugin:evt-detail-exit",
 /** main -> renderer: launcher shown (reset UI). */
 EvtLauncherShow: "launcher:show",
} as const;

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc];

export type ItemType = "file" | "app" | "command" | "snippet" | "plugin";

export interface SearchItem {
 id: string;
 type: ItemType;
 /** Display title. */
 title: string;
 /** Secondary line (path, description). */
 subtitle?: string;
 /** Optional icon hint (emoji or letter) for quick rendering. */
 icon?: string;
 /** Real shell icon as data URL (32×32 PNG); takes precedence over `icon`. */
 iconUrl?: string;
 /** Launch payload (file path / app .lnk / command result). */
 payload: string;
 /** Set for `type === "plugin"` items: which plugin produced it. */
 pluginId?: string;
 /** Opaque data handed back to the plugin when the item is selected. */
 raw?: unknown;
}

export interface SearchResponse {
 query: string;
 files: SearchItem[];
 apps: SearchItem[];
 commands: SearchItem[];
 plugins: SearchItem[];
 /** Present when the query looks like a calculator expression. */
 calc?: { expression: string; result: string };
 /** Local file-index state (meaningful when Everything is absent). */
 fileIndex?: FileIndexStatus;
}

export interface FileIndexStatus {
 count: number;
 complete: boolean;
 running: boolean;
 capped: boolean;
}

export interface AppInfo {
 platform: string;
 everythingAvailable: boolean;
 fileIndex: FileIndexStatus;
 appCount: number;
 pluginCount: number;
 pluginsDir: string;
}

// --- Plugin types -------------------------------------------------------

export type PluginPermission = "fs" | "clipboard" | "net";

export type PluginStatus = "idle" | "starting" | "running" | "error";

export interface PluginInfo {
 id: string;
 name: string;
 description?: string;
 /** Emoji or icon hint for lists. */
 icon?: string;
 keywords: string[];
 hasDetail: boolean;
 permissions: PluginPermission[];
 /** Built-in (shipped with the app) vs user-installed. */
 builtin: boolean;
 /** Absolute path of the plugin folder. */
 dir: string;
 status: PluginStatus;
 error?: string;
}

export interface PermissionRequest {
 requestId: number;
 pluginId: string;
 pluginName: string;
 /** Directory (or URL host) being requested. */
 target: string;
 /** What the plugin wants to do, for the prompt copy. */
 purpose: string;
 /** "dir" for filesystem access, "net" for network origin. */
 kind: "dir" | "net";
}

/** A result item produced by a plugin's main.js. */
export interface PluginItem {
 text: string;
 icon?: string;
 description?: string;
 /** Opaque; handed back to the plugin on select. */
 data?: unknown;
}

/** Context available to a plugin's detail view. */
export interface DetailContext {
 pluginId: string;
 pluginName: string;
 keyword: string;
 /** Text typed after the keyword. */
 value: string;
 item: PluginItem | null;
}

/**
 * A capability call coming from a plugin's detail frame (window.uTools.*).
 * Routed to the owning plugin's gate in the main process.
 */
export interface CapabilityCall {
 pluginId: string;
 /** e.g. "fs.read" | "fs.write" | "fs.list" | "clipboard.read" | "clipboard.write" | "net.fetch" | "shell.openPath" | "data.dir" */
 method: string;
 params?: Record<string, unknown>;
}

/** Result of selecting a plugin item. */
export interface PluginSelectResult {
 /** Set when the plugin has a detail view and it was opened. */
 openedDetail?: { pluginId: string; pluginName: string; detail: string };
 /** Set when a pure-command plugin handled the selection. */
 executed?: boolean;
 error?: string;
}
