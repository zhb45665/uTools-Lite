import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BrowserWindow, app, shell } from "electron";
import {
  Ipc,
  PluginInfo,
  PluginItem,
  PluginSelectResult,
  SearchItem,
} from "../../shared/ipc";
import {
  Manifest,
  discoverPlugins,
  pluginsRoot,
  toPluginInfo,
  validatePluginFolder,
} from "./manifest";
import { ApiServer, GateContext } from "./api-server";
import { PluginSandbox } from "./sandbox";
import { authorizeDir, initPermissions } from "./permissions";
import { setCredentialWindow } from "../launcher-window";
import {
  openNoteWindow,
  isNoteWindowOpen,
  getNoteWindow,
} from "../note-window";

/**
 * rm -rf with retries: a freshly killed sandbox may still hold its cwd
 * open for a moment on Windows (EBUSY), so retry briefly before giving up.
 */
function rmDirSafe(dir: string, attempts = 6, delayMs = 200): void {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (
        i >= attempts - 1 ||
        (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY")
      ) {
        throw e;
      }
      // Synchronous short sleep: the Windows handle release takes a few ms.
      const end = Date.now() + delayMs;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
}

/**
 * Plugin manager: discovery, keyword index, lazy sandbox lifecycle,
 * detail-view state, permission prompts, and install/uninstall.
 */

const IDLE_REAP_MS = 10 * 60 * 1000; // 10 min idle -> reap sandbox
const REAP_INTERVAL_MS = 60 * 1000;
/** CJK keywords get prefix matching: Chinese has no word boundaries. */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

const PERM_PROMPT_TIMEOUT_MS = 120_000;
/** beforeClose negotiation window: long enough for a confirm dialog, short
 *  enough that a dead page cannot wedge the close flow. */
const BEFORE_CLOSE_TIMEOUT_MS = 10_000;

interface ActiveDetail {
  pluginId: string;
  keyword: string;
  value: string;
  item: PluginItem | null;
  ready: boolean; // renderer said the iframe is mounted
  /** [processId, routingId] of the plugin iframe. `webContents.send` only
   *  reaches the TOP frame, so replies to a detail page must go through
   *  sendToFrame() or they are silently lost. */
  frameId: [number, number] | null;
}

interface PendingGrant {
  resolve: (granted: boolean) => void;
  timer: NodeJS.Timeout;
  pluginId: string;
  offeredDir: string;
}

export class PluginManager {
  private manifests = new Map<string, Manifest>();
  private infos = new Map<string, PluginInfo>();
  private keywordIndex = new Map<string, string>(); // keyword(lower) -> pluginId
  private sandboxes = new Map<string, PluginSandbox>();
  private spawning = new Map<string, Promise<PluginSandbox>>();
  private lastActive = new Map<string, number>();
  private apiServer: ApiServer;
  private activeDetail: ActiveDetail | null = null;
  /**
   * Plugin -> detail-frame messages that arrived before the iframe reported
   * `ready`. The page's first request is usually sent from its own
   * DOMContentLoaded, which fires BEFORE the renderer's iframe onLoad —
   * dropping those replies left the plugin waiting forever.
   */
  private detailQueue: { pluginId: string; data: unknown }[] = [];
  private nextRequestId = 1;
  private pendingGrants = new Map<number, PendingGrant>();
  /**
   * Ref-counted blur-hide suspension for pending permission cards. A
   * permission card needs to stay on screen to be answered; if the user
   * switches apps while it is up, the window must not blur-hide (and a
   * hidden card cannot be answered). Counter mirrors blurSuspended in
   * launcher-window.ts.
   */
  private permSuspend = 0;
  /** Guards against re-entrant beforeClose negotiations. */
  private closingDetail = false;
  private reapTimer: NodeJS.Timeout | null = null;
  private shutDown = false;
  private getWin: () => BrowserWindow | null;

  constructor(getWin: () => BrowserWindow | null) {
    this.getWin = getWin;
    initPermissions();
    this.apiServer = new ApiServer({
      requestDirGrant: (pluginId, pluginName, dir, purpose) =>
        this.requestDirGrant(pluginId, pluginName, dir, purpose),
    } satisfies GateContext);
  }

  // ------------------------------------------------------------ lifecycle
  /** Discover plugins. Call after app ready; safe to call repeatedly. */
  init(): void {
    const { plugins, issues } = discoverPlugins();
    for (const i of issues) {
      console.warn(
        `[plugins] ${i.level} (${path.basename(i.pluginDir)}): ${i.message}`,
      );
    }
    this.manifests = plugins;
    this.infos.clear();
    this.keywordIndex.clear();
    for (const m of plugins.values()) {
      const info = toPluginInfo(m);
      this.infos.set(m.id, info);
      for (const kw of m.keywords) {
        this.keywordIndex.set(kw.toLowerCase(), m.id); // later source wins
      }
    }
    if (!this.reapTimer) {
      this.reapTimer = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS);
      this.reapTimer.unref?.();
    }
    console.log(`[plugins] discovered ${plugins.size} plugin(s)`);
  }

  /** Kill every sandbox. Called on app quit / rescan. */
  shutdown(): void {
    this.shutDown = true;
    for (const s of this.sandboxes.values()) s.kill();
    this.sandboxes.clear();
    this.spawning.clear();
    for (const [, p] of this.pendingGrants) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pendingGrants.clear();
    this.permSuspend = 0; // blur-hide lock released at shutdown
    if (this.reapTimer) clearInterval(this.reapTimer);
    this.reapTimer = null;
  }

  // ------------------------------------------------------------- queries
  list(): PluginInfo[] {
    return Array.from(this.infos.values());
  }

  get(pluginId: string): PluginInfo | undefined {
    return this.infos.get(pluginId);
  }

  dirOf(pluginId: string): string | null {
    return this.manifests.get(pluginId)?.dir ?? null;
  }

  userPluginsRoot(): string {
    return pluginsRoot();
  }

  /**
   * Match a query against plugin keywords. Longest keyword wins.
   *
   * Accepts: exact match, `keyword + space + value`, and — for CJK keywords
   * only — a bare prefix, because Chinese has no word boundaries: the plugin
   * named 密码本 must be reachable by typing its name (previously "密码本"
   * matched nothing while the keyword was "密码"). ASCII keywords stay strict
   * so "passwordchange" is not treated as a match.
   */
  matchQuery(
    query: string,
  ): { pluginId: string; keyword: string; value: string } | null {
    const q = query.trim();
    if (!q) return null;
    const ql = q.toLowerCase();
    let best: { keyword: string; pluginId: string; value: string } | null =
      null;
    for (const [kw, pluginId] of this.keywordIndex) {
      let value = "";
      if (ql === kw) {
        value = "";
      } else if (ql.startsWith(kw + " ")) {
        value = q.slice(kw.length + 1);
      } else if (CJK_RE.test(kw) && ql.startsWith(kw)) {
        // Chinese has no word boundaries, so typing a plugin's NAME must reach
        // it even when the keyword is shorter (密码本 -> keyword 密码).
        // But it must be a prefix of the plugin's OWN name: otherwise an
        // unrelated word like "计算器" would hijack the calc-paper plugin
        // (keyword 计算) and sit ABOVE the real Calculator app, so the app
        // could never be launched by name.
        const name = (this.manifests.get(pluginId)?.name ?? "").toLowerCase();
        if (!name || !name.startsWith(ql)) continue;
        value = q.slice(kw.length).trim();
      } else {
        continue;
      }
      if (!best || kw.length > best.keyword.length) {
        best = { keyword: kw, pluginId, value };
      }
    }
    if (!best) return null;
    // The keyword itself must be from the manifest (original casing).
    const m = this.manifests.get(best.pluginId)!;
    const originalKw =
      m.keywords.find((k) => k.toLowerCase() === best!.keyword) ?? best.keyword;
    return { pluginId: best.pluginId, keyword: originalKw, value: best.value };
  }

  /**
   * Search across plugin results. Empty array when the query doesn't hit a
   * keyword; errors never propagate (search UI must not break).
   */
  async searchPlugins(query: string): Promise<SearchItem[]> {
    const hit = this.matchQuery(query);
    if (!hit) return [];
    const m = this.manifests.get(hit.pluginId);
    if (!m) return [];
    try {
      const sb = await this.ensureLoaded(m);
      const method = hit.value === "" ? "input" : "inputSearch";
      const res: { items: PluginItem[] } = await sb.call(method, {
        keyword: hit.keyword,
        value: hit.value,
      });
      const items = Array.isArray(res?.items) ? res.items : [];
      return items.map((it, i) => ({
        id: `plugin:${m.id}:${i}`,
        type: "plugin" as const,
        title: it.text,
        subtitle: it.description ?? `${m.name} · 回车执行`,
        icon: it.icon ?? m.icon ?? "🧩",
        payload: it.text,
        pluginId: m.id,
        raw: { keyword: hit.keyword, value: hit.value, data: it.data },
      }));
    } catch (e) {
      const info = this.infos.get(m.id);
      if (info && info.status !== "error") {
        info.status = "error";
        info.error = String((e as Error).message || e);
      }
      return [this.errorItem(m, String((e as Error).message || e))];
    }
  }

  private errorItem(m: Manifest, message: string): SearchItem {
    return {
      id: `plugin:${m.id}:error`,
      type: "plugin",
      title: `插件「${m.name}」出错了`,
      subtitle: message,
      icon: "⚠️",
      payload: "",
      pluginId: m.id,
    };
  }

  // --------------------------------------------------------- selection
  /**
   * User pressed Enter on a plugin item.
   * - plugin with detail view -> open it (returns openedDetail)
   * - pure command plugin -> fire select in the sandbox
   */
  async handleSelect(item: SearchItem): Promise<PluginSelectResult> {
    const m = this.manifests.get(item.pluginId ?? "");
    if (!m) return { error: "unknown plugin" };
    const raw = (item.raw ?? {}) as {
      keyword?: string;
      value?: string;
      data?: unknown;
    };
    const keyword = raw.keyword ?? "";
    const value = raw.value ?? "";
    const pluginItem: PluginItem = {
      text: item.title,
      icon: item.icon,
      description: item.subtitle,
      data: raw.data,
    };

    if (m.detail) {
      // Notes plugin: open in a standalone resizable window instead of the
      // inline iframe. The main launcher keeps its compact fixed size; the
      // note editor gets its own native-title-bar window the user can drag,
      // resize, minimize, maximize, and close.
      if (m.id === "notes") {
        openNoteWindow({
          keyword,
          value,
          item: { text: item.title, icon: item.icon, description: item.subtitle, data: raw.data },
        });        // Best-effort warm start so main.js state is ready when the view opens.
        void this.ensureLoaded(m).catch(() => {});
        return {
          openedDetail: {
            pluginId: m.id,
            pluginName: m.name,
            detail: m.detail,
          },
        };
      }

      setCredentialWindow(m.id === "password");
      this.activeDetail = {
        pluginId: m.id,
        keyword,
        value,
        item: pluginItem,
        ready: false,
        frameId: null,
      };
      this.detailQueue = [];
      // Best-effort warm start so main.js state is ready when the view opens.
      void this.ensureLoaded(m).catch(() => {});
      return {
        openedDetail: { pluginId: m.id, pluginName: m.name, detail: m.detail },
      };
    }

    const sb = await this.ensureLoaded(m);
    try {
      await sb.call("select", { item: pluginItem, keyword, value }, 5000);
    } catch {
      /* plugin-side errors are non-fatal for selection */
    }
    return { executed: true };
  }

  // ------------------------------------------------------ detail plumbing
  detailContext(): import("../../shared/ipc").DetailContext | null {
    const d = this.activeDetail;
    if (!d) return null;
    const m = this.manifests.get(d.pluginId);
    return {
      pluginId: d.pluginId,
      pluginName: m?.name ?? d.pluginId,
      keyword: d.keyword,
      value: d.value,
      item: d.item,
    };
  }

  markDetailReady(frameId?: [number, number] | null): void {
    const d = this.activeDetail;
    if (!d) return;
    if (frameId) d.frameId = frameId;
    d.ready = true;
    // Deliver whatever the plugin already answered while the frame mounted.
    const queued = this.detailQueue;
    this.detailQueue = [];
    for (const msg of queued) {
      this.forwardDetailMessage(msg.pluginId, msg.data);
    }
  }

  /** Target the plugin iframe explicitly; fall back to the top frame. */
  private forwardDetailMessage(pluginId: string, data: unknown): void {
    const wc = this.getWin()?.webContents;
    if (!wc) return;
    const payload = { pluginId, data: data ?? null };
    const frameId = this.activeDetail?.frameId;
    if (frameId) {
      try {
        wc.sendToFrame(frameId, Ipc.EvtDetailMessage, payload);
      } catch {
        // frame navigated away mid-send: nothing to deliver to
      }
    } else {
      wc.send(Ipc.EvtDetailMessage, payload);
    }
  }

  /** Detail frame -> plugin main.js message.
   *  `sourceWin` disambiguates when the message comes from the standalone
   *  note window (vs the main launcher's inline iframe): the note window
   *  has no activeDetail entry, so we route straight to the notes sandbox. */
  detailSend(data: unknown, frameId?: [number, number] | null, sourceWin?: BrowserWindow | null): void {
    // Standalone note window: route directly to the notes sandbox, bypassing
    // activeDetail (which is bound to the main launcher's inline iframe).
    if (sourceWin) {
      const m = this.manifests.get("notes");
      if (!m) return;
      void this.ensureLoaded(m)
        .then((sb) => {
          sb.post("mainMessage", { data });
        })
        .catch((e) => {
          const request = data as { requestId?: number } | null;
          sourceWin?.webContents.send(Ipc.EvtDetailMessage, {
            pluginId: "notes",
            data: {
              type: "res",
              requestId: request?.requestId,
              error: `插件启动失败：${String((e as Error).message || e)}`,
            },
          });
        });
      return;
    }

    const d = this.activeDetail;
    if (!d) return;
    if (frameId) d.frameId = frameId; // remember where to send the reply
    const m = this.manifests.get(d.pluginId);
    if (!m) return;
    // A newly mounted detail page can send its first request before handshake.
    void this.ensureLoaded(m)
      .then((sb) => {
        if (this.activeDetail === d) sb.post("mainMessage", { data });
      })
      .catch((e) => {
        if (this.activeDetail !== d) return;
        const request = data as { requestId?: number } | null;
        this.forwardDetailMessage(d.pluginId, {
          type: "res",
          requestId: request?.requestId,
          error: `插件启动失败：${String((e as Error).message || e)}`,
        });
      });
  }

  /**
   * Close the detail view (Esc / close button / plugin switch). Performs
   * the beforeClose negotiation first: the plugin page gets a short window
   * to inspect unsaved state and refuse (e.g. show "继续编辑 / 放弃修改").
   * A page that does not answer within the timeout is closed anyway (safe
   * policy, logged). Use closeDetailUnsafe() to skip the negotiation.
   */
  async closeDetail(fireExit: boolean): Promise<{ closed: boolean }> {
    const d = this.activeDetail;
    if (!d) return { closed: true };
    const allow = await this.negotiateBeforeClose(d);
    if (!allow) return { closed: false };
    this.closeDetailUnsafe(fireExit);
    return { closed: true };
  }

  /** Close the detail view without the beforeClose negotiation. */
  closeDetailUnsafe(fireExit: boolean): void {
    setCredentialWindow(false);
    const d = this.activeDetail;
    this.activeDetail = null;
    this.detailQueue = []; // never leak a previous page's messages into the next
    if (!d) return;
    this.getWin()?.webContents.send(Ipc.EvtDetailExit);
    const sb = this.sandboxes.get(d.pluginId);
    if (sb && fireExit) {
      // onExit is a one-way signal; the sandbox stays warm for reuse.
      sb.post("exit", {});
    }
  }

  /**
   * beforeClose negotiation (retention plan 阶段二). Asks the detail iframe
   * whether it allows closing; the page decides (e.g. confirm unsaved
   * changes). Timeout => allow close (safe policy, logged).
   */
  private negotiateBeforeClose(d: ActiveDetail): Promise<boolean> {
    const wc = this.getWin()?.webContents;
    if (!wc || this.closingDetail) return Promise.resolve(true);
    this.closingDetail = true;
    const reqIdCurrent = Date.now() + Math.floor(Math.random() * 1000);
    // SAFETY: Electron's d.ts types only a subset of WebContents events;
    // custom ipcRenderer channel names are valid events at runtime, so the
    // casts here only silence the incomplete event-name union and listener
    // signature. The listener receives (event, reqId, allow) at runtime.
    const closeResultEvent = Ipc.DetailCloseResult as unknown as "zoom-changed";
    return new Promise<boolean>((resolve) => {
      let settled = false;
      // SAFETY: single reference so removeListener gets the same function
      // identity that wc.on received (listener equality is by reference).
      const onResult = (_e: unknown, reqId: number, allow: boolean) => {
        if (reqId === reqIdCurrent) settle(Boolean(allow), "page answer");
      };
      // SAFETY: the listener is wider than the d.ts zoom-changed signature;
      // the cast keeps a single function reference for add/remove identity.
      const onResultAny = onResult as unknown as (event: unknown) => void;
      const settle = (allow: boolean, reason: string) => {
        if (settled) return;
        settled = true;
        wc.removeListener(closeResultEvent, onResultAny);
        this.closingDetail = false;
        if (!allow) {
          console.log(
            `[plugins] beforeClose denied for ${d.pluginId}: ${reason}`,
          );
        }
        resolve(allow);
      };
      // SAFETY: listener arity (3) is intentionally wider than the d.ts
      // zoom-changed signature; extra runtime args are simply ignored.
      wc.on(closeResultEvent, onResultAny);
      const timer = setTimeout(() => {
        settle(true, "timeout (closed per safe policy)");
      }, BEFORE_CLOSE_TIMEOUT_MS);
      timer.unref?.();
      try {
        const frameId = d.frameId;
        if (frameId) {
          wc.sendToFrame(frameId, Ipc.EvtDetailBeforeClose, reqIdCurrent);
        } else {
          wc.send(Ipc.EvtDetailBeforeClose, reqIdCurrent);
        }
      } catch {
        clearTimeout(timer);
        settle(true, "frame gone (closed per safe policy)");
      }
    });
  }

  /** Store a focus/scroll snapshot from the top frame, forwarded to the detail iframe. */
  saveFocusState(state: unknown): void {
    const d = this.activeDetail;
    if (!d) return;
    const wc = this.getWin()?.webContents;
    if (!wc) return;
    try {
      const frameId = d.frameId;
      if (frameId) {
        wc.sendToFrame(frameId, Ipc.DetailSaveFocus, state);
      } else {
        wc.send(Ipc.DetailSaveFocus, state);
      }
    } catch {
      /* frame gone */
    }
  }

  /** Window re-shown with an active detail view: ask the page to resume. */
  resumeDetail(): void {
    const d = this.activeDetail;
    if (!d) return;
    const wc = this.getWin()?.webContents;
    if (!wc) return;
    try {
      const frameId = d.frameId;
      if (frameId) {
        wc.sendToFrame(frameId, Ipc.EvtDetailResume);
      } else {
        wc.send(Ipc.EvtDetailResume);
      }
    } catch {
      /* frame gone; nothing to resume */
    }
  }

  /**
   * Blur while a detail view is open.
   *
   * Per the editor-state retention plan, blur is NOT a close: the window
   * blur-hides but the detail iframe (and its in-memory form state) must
   * survive so the user can resume exactly where they left off. The window
   * itself is hidden by the blur handler in launcher-window.ts.
   */
  onDetailBlur(): void {
    const d = this.activeDetail;
    if (d) this.lastActive.set(d.pluginId, Date.now());
  }

  /** Ref-counted blur-hide lock while a permission card is unanswered. */
  suspendBlurForPermission(): number {
    const wasSuspended = this.permSuspend;
    this.permSuspend++;
    return wasSuspended; // 0 -> this call is what suspends blur-hide
  }

  resumeBlurForPermission(): void {
    this.permSuspend = Math.max(0, this.permSuspend - 1);
  }

  /** Current external blur-hide lock count (read by the window module). */
  blurSuspendCount(): number {
    return this.permSuspend;
  }

  /** Accessor for the top frame to inspect the active detail (read-only). */
  activeDetailRef(): {
    pluginId: string;
    frameId: [number, number] | null;
  } | null {
    const d = this.activeDetail;
    if (!d) return null;
    return { pluginId: d.pluginId, frameId: d.frameId };
  }

  /** Public wrapper around the negotiation (used by the DetailBeforeClose IPC). */
  negotiateBeforeClosePublic(_d: {
    pluginId: string;
    frameId: [number, number] | null;
  }): Promise<boolean> {
    return this.negotiateBeforeClose(this.activeDetail!);
  }

  /**
   * Serve a capability call from a plugin's detail frame (window.uTools.*).
   * Goes through the same gate as sandbox calls; lazily loads the sandbox.
   */
  async detailCapability(
    pluginId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const m = this.manifests.get(pluginId);
    if (!m) throw new Error(`unknown plugin "${pluginId}"`);
    await this.ensureLoaded(m); // gate handlers attach to the manifest, but
    // the warm sandbox keeps plugin-side state consistent.
    return this.apiServer.invoke(m, method, params);
  }

  // ------------------------------------------------------------ sandbox
  private async ensureLoaded(m: Manifest): Promise<PluginSandbox> {
    const existing = this.sandboxes.get(m.id);
    if (existing && existing.isRunning) {
      this.lastActive.set(m.id, Date.now());
      return existing;
    }
    const inFlight = this.spawning.get(m.id);
    if (inFlight) return inFlight;

    const info = this.infos.get(m.id)!;
    info.status = "starting";
    info.error = undefined;
    const p = this.spawn(m);
    this.spawning.set(m.id, p);
    try {
      const sb = await p;
      this.sandboxes.set(m.id, sb);
      info.status = "running";
      this.lastActive.set(m.id, Date.now());
      return sb;
    } catch (e) {
      info.status = "error";
      // A plugin-reported "error" event is more specific than the generic
      // handshake failure; keep it when present.
      info.error = info.error ?? String((e as Error).message || e);
      throw e;
    } finally {
      this.spawning.delete(m.id);
    }
  }

  private async spawn(m: Manifest): Promise<PluginSandbox> {
    // A crashed sandbox of the same plugin must be gone first.
    const old = this.sandboxes.get(m.id);
    if (old) old.kill();

    const sb = new PluginSandbox(m.id, m.dir, {
      onEvent: (evt) => this.onSandboxEvent(m.id, evt),
      onExit: (code) => {
        const cur = this.sandboxes.get(m.id);
        if (cur === sb) {
          this.sandboxes.delete(m.id);
          const info = this.infos.get(m.id);
          if (info && info.status === "running" && !this.shutDown) {
            info.status = "error";
            info.error = `plugin process exited (code ${code ?? "?"})`;
          }
        }
      },
    });
    await sb.spawn();
    this.apiServer.attach(sb, m);
    return sb;
  }

  private onSandboxEvent(
    pluginId: string,
    evt: { method: string; params: Record<string, unknown> },
  ): void {
    const info = this.infos.get(pluginId);
    switch (evt.method) {
      case "ready":
        if (info && info.status === "starting") info.status = "running";
        break;
      case "error": {
        const message = String(evt.params.message ?? "plugin error");
        if (info) {
          info.status = "error";
          info.error = message;
        }
        this.toast(`插件「${info?.name ?? pluginId}」: ${message}`);
        break;
      }
      case "toast":
        this.toast(String(evt.params.msg ?? ""));
        break;
      case "log":
        console.log(`[plugin:${pluginId}]`, String(evt.params.msg ?? ""));
        break;
      case "mainMessage": {
        // Notes plugin: when the standalone note window is open, route
        // main.js -> detail messages there instead of the main launcher's
        // inline iframe (which has no notes detail mounted).
        if (pluginId === "notes") {
          if (isNoteWindowOpen()) {
            // Send directly to the note window's webContents.
            // SAFETY: the note window is a top-level frame (not an iframe
            // inside the launcher), so wc.send reaches its only frame.
            const nw = getNoteWindow();
            if (nw && !nw.isDestroyed()) {
              nw.webContents.send(Ipc.EvtDetailMessage, {
                pluginId: "notes",
                data: evt.params.data,
              });
            }
            break;
          }
        }
        // Forward to the detail view only when it belongs to this plugin.
        // Messages racing ahead of the iframe's onLoad are QUEUED, never
        // dropped (see detailQueue).
        const d = this.activeDetail;
        if (!d || d.pluginId !== pluginId) break;
        if (d.ready) {
          this.forwardDetailMessage(pluginId, evt.params.data);
        } else if (this.detailQueue.length < 100) {
          this.detailQueue.push({ pluginId, data: evt.params.data });
        }
        break;
      }
      default:
        break;
    }
  }

  private reapIdle(): void {
    if (this.shutDown) return;
    const now = Date.now();
    for (const [id, sb] of Array.from(this.sandboxes)) {
      if (this.activeDetail?.pluginId === id) continue; // keep detail host warm
      const last = this.lastActive.get(id) ?? now;
      if (now - last > IDLE_REAP_MS) {
        console.log(`[plugins] reaping idle sandbox "${id}"`);
        void sb.exitAndKill();
        const info = this.infos.get(id);
        if (info) {
          info.status = "idle";
          info.error = undefined;
        }
        this.sandboxes.delete(id);
        this.lastActive.delete(id);
      }
    }
  }

  // ------------------------------------------------------- permissions
  private async requestDirGrant(
    pluginId: string,
    pluginName: string,
    dir: string,
    purpose: string,
  ): Promise<boolean> {
    const requestId = this.nextRequestId++;
    const win = this.getWin();
    if (!win) return false;
    if (!win.isVisible()) win.show(); // the card must be visible to be answered
    // Keep the window on screen until the user answers (or the timeout
    // fires): a hidden permission card would stall the plugin forever.
    const wasSuspended = this.suspendBlurForPermission();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingGrants.delete(requestId);
        if (wasSuspended === 0) this.resumeBlurForPermission();
        resolve(false); // unanswered => deny
      }, PERM_PROMPT_TIMEOUT_MS);
      this.pendingGrants.set(requestId, {
        resolve,
        timer,
        pluginId,
        offeredDir: dir,
      });
      win.webContents.send(Ipc.EvtPermissionRequest, {
        requestId,
        pluginId,
        pluginName,
        target: dir,
        purpose,
        kind: "dir",
      });
    });
  }

  /** Renderer answered a permission card. */
  permissionReply(requestId: number, granted: boolean): void {
    const p = this.pendingGrants.get(requestId);
    if (!p) return;
    this.pendingGrants.delete(requestId);
    clearTimeout(p.timer);
    if (granted) authorizeDir(p.pluginId, p.offeredDir);
    this.resumeBlurForPermission();
    p.resolve(granted);
  }

  // ----------------------------------------------------------- helpers
  private toast(msg: string): void {
    if (!msg) return;
    this.getWin()?.webContents.send(Ipc.EvtToast, { msg });
  }

  /** Re-run discovery (after install/uninstall). Kills live sandboxes. */
  rescan(): PluginInfo[] {
    for (const s of this.sandboxes.values()) s.kill();
    this.sandboxes.clear();
    this.spawning.clear();
    this.activeDetail = null;
    this.init();
    return this.list();
  }

  /** Install from a folder or a .zip (Windows: Expand-Archive). */
  async install(
    fromPath: string,
  ): Promise<{ ok: boolean; error?: string; pluginId?: string }> {
    const src = path.resolve(String(fromPath ?? ""));
    let extracted: string | null = null;
    try {
      let pluginDir: string;
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        pluginDir = src;
      } else if (st.isFile() && src.toLowerCase().endsWith(".zip")) {
        extracted = fs.mkdtempSync(
          path.join(app.getPath("temp"), "utools-plug-"),
        );
        await this.extractZip(src, extracted);
        const sub = fs
          .readdirSync(extracted, { withFileTypes: true })
          .find((e) => e.isDirectory());
        pluginDir = sub ? path.join(extracted, sub.name) : extracted;
      } else {
        return {
          ok: false,
          error: "path must be a plugin folder or a .zip file",
        };
      }

      const { manifest, issues } = validatePluginFolder(pluginDir, false);
      for (const i of issues) {
        if (i.level === "error") return { ok: false, error: i.message };
      }
      if (!manifest) return { ok: false, error: "invalid plugin manifest" };

      const dest = path.join(pluginsRoot(), manifest.id);
      if (fs.existsSync(dest))
        fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(pluginsRoot(), { recursive: true });
      fs.cpSync(pluginDir, dest, { recursive: true });
      this.rescan();
      return { ok: true, pluginId: manifest.id };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    } finally {
      if (extracted) fs.rmSync(extracted, { recursive: true, force: true });
    }
  }

  private extractZip(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // PowerShell is available on every Windows install we target.
      const ps = [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ].join(" ");
      const proc = spawn("powershell", ps.split(" "), { windowsHide: true });
      let err = "";
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(err || `powershell exit ${code}`)),
      );
    });
  }

  uninstall(pluginId: string): { ok: boolean; error?: string } {
    const info = this.infos.get(pluginId);
    if (!info) return { ok: false, error: "unknown plugin" };
    if (info.builtin)
      return { ok: false, error: "built-in plugins cannot be uninstalled" };
    const sb = this.sandboxes.get(pluginId);
    if (sb) sb.kill();
    this.sandboxes.delete(pluginId);
    try {
      rmDirSafe(info.dir);
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e) };
    }
    this.init();
    return { ok: true };
  }

  /**
   * Show a plugin folder in Explorer.
   *
   * Builtin plugins live INSIDE app.asar in packaged builds: Electron's fs
   * patch makes such a path look like it exists, but Explorer cannot open a
   * virtual path and Windows answers with "找不到路径". In that case we
   * reveal app.asar itself and explain what happened.
   */
  reveal(pluginId: string): { ok: boolean; error?: string; note?: string } {
    const dir = this.dirOf(pluginId);
    if (!dir) return { ok: false, error: "插件不存在" };
    if (isInsideAsar(dir)) {
      const asar = path.join(process.resourcesPath, "app.asar");
      if (fs.existsSync(asar)) shell.showItemInFolder(asar);
      return {
        ok: true,
        note: "内置插件打包在 app.asar 内，已定位到该文件（同名用户插件可覆盖内置）",
      };
    }
    const manifestFile = path.join(dir, "uTLS.json");
    if (fs.existsSync(manifestFile)) shell.showItemInFolder(manifestFile);
    else shell.openPath(dir);
    return { ok: true };
  }
}

/** True when a path lives inside an .asar archive (virtual, not a real dir). */
function isInsideAsar(p: string): boolean {
  return p.split(path.sep).some((seg) => seg.endsWith(".asar"));
}

// ---------------------------------------------------------------- module
let manager: PluginManager | null = null;

export function createPluginManager(
  getWin: () => BrowserWindow | null,
): PluginManager {
  manager = new PluginManager(getWin);
  return manager;
}

export function getPluginManager(): PluginManager | null {
  return manager;
}
