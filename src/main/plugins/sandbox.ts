import fs from "node:fs";
import path from "node:path";
import { app, utilityProcess, UtilityProcess } from "electron";

/**
 * Host-side wrapper around one plugin's utilityProcess.
 *
 * - structured-clone RPC over the built-in parent port
 * - every request has a timeout (3s default, 5s handshake)
 * - on crash: all pending requests reject, the manager flips to "error"
 *
 * Message shapes (both directions):
 *   { t: "req", id, method, params }
 *   { t: "res", id, result }
 *   { t: "err", id, error }
 *   { t: "evt", method, params }
 */

export type PluginEvent = {
  method: string;
  params: Record<string, unknown>;
};

export interface SandboxCallbacks {
  onEvent: (evt: PluginEvent) => void;
  onExit: (code: number | null) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SpawnedSandbox {
  /** id of this host-side instance (matches ready handshake). */
  sandboxToken: string;
  sandbox: PluginSandbox;
}

/**
 * Locate the sandbox bootstrap:
 *  - dev:  <repo>/plugin-host/bootstrap.js (repo-root relative to dist/main/plugins)
 *  - packaged: the asarUnpacked copy next to app.asar (fork() cannot load from asar)
 */
function bootstrapPath(): string {
  if (app.isPackaged && typeof process.resourcesPath === "string") {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "plugin-host",
      "bootstrap.js",
    );
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return path.join(__dirname, "../../../plugin-host/bootstrap.js");
}

const BOOTSTRAP = bootstrapPath();

/**
 * True when `p` is a real filesystem directory. Paths INSIDE an .asar
 * (e.g. app.asar\plugins\foo) report true to fs.existsSync via Electron's
 * fs patch — but they are virtual and cannot be used as a child's cwd.
 */
function isRealDir(p: string): boolean {
  if (p.split(path.sep).some((seg) => seg.endsWith(".asar"))) return false;
  return fs.existsSync(p);
}

/**
 * Diagnostics: the packaged app's stdout is invisible, so sandbox spawn
 * details (child stdout/stderr, exit, handshake timing) are mirrored to
 * <userData>/sandbox-spawn.log to make "handshake failed" debuggable.
 */
function spawnLog(...parts: unknown[]): void {
  try {
    const line = `[${new Date().toISOString()}] ` + parts.join(" ") + "\n";
    fs.appendFileSync(
      path.join(app.getPath("userData"), "sandbox-spawn.log"),
      line,
    );
  } catch {
    /* best effort */
  }
}

export class PluginSandbox {
  private proc: UtilityProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private methodHandlers = new Map<
    string,
    (params: any) => unknown | Promise<unknown>
  >();
  private closed = false;

  constructor(
    readonly pluginId: string,
    private pluginDir: string,
    private cb: SandboxCallbacks,
  ) {}

  /** Fork the sandbox and wait for the `ready` handshake (5s timeout). */
  async spawn(): Promise<void> {
    // Builtin plugins live INSIDE app.asar in packaged builds — the folder is
    // not a real directory, so it cannot be the child's cwd (spawn fails
    // silently and the handshake times out). Fall back to the unpacked
    // plugin-host dir, which always exists on the real filesystem.
    const cwd = isRealDir(this.pluginDir)
      ? this.pluginDir
      : path.dirname(BOOTSTRAP);
    const t0 = Date.now();
    spawnLog(
      `fork ${this.pluginId} cwd=${cwd} bootstrap=${BOOTSTRAP} pluginDir=${this.pluginDir}`,
    );
    this.proc = utilityProcess.fork(BOOTSTRAP, [], {
      cwd,
      env: {
        ...process.env,
        UTL_PLUGIN_ID: this.pluginId,
        UTL_PLUGIN_DIR: this.pluginDir,
      },
    });

    this.proc.stdout?.on("data", (d: Buffer) =>
      spawnLog(`${this.pluginId} out: ${String(d).trim()}`),
    );
    this.proc.stderr?.on("data", (d: Buffer) =>
      spawnLog(`${this.pluginId} err: ${String(d).trim()}`),
    );
    this.proc.on("message", (msg: any) => this.onMessage(msg));
    this.proc.on("exit", (code) => {
      spawnLog(`${this.pluginId} exit code=${code} after ${Date.now() - t0}ms`);
      // Fail the ready handshake early if the process died before ready.
      if (this.onceReady) {
        const once = this.onceReady;
        this.onceReady = null;
        once(false);
      }
      this.settleAll(new Error(`plugin process exited (code ${code ?? "?"})`));
      this.proc = null;
      this.cb.onExit(code ?? 0);
    });
    this.proc.on("error", (type, location, report) => {
      console.error(`[sandbox:${this.pluginId}] process error`, type, location);
      spawnLog(
        `${this.pluginId} process error: ${type} @ ${location}: ${String(report).slice(0, 2000)}`,
      );
    });

    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.onceReady = null;
        resolve(false);
      }, 5000);
      this.onceReady = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
    });
    const ok = await ready;
    spawnLog(
      `${this.pluginId} handshake ${ok ? "OK" : "FAILED"} after ${Date.now() - t0}ms`,
    );
    if (!ok) {
      this.kill();
      throw new Error(
        this.loadError ||
          "plugin ready handshake failed (timeout or early exit)",
      );
    }
  }

  private onceReady: ((ok: boolean) => void) | null = null;
  private loadError: string | null = null;

  /** Send a request to the plugin and await the reply. */
  call(method: string, params: unknown, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.closed) {
        reject(new Error(`sandbox "${this.pluginId}" is not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`plugin request "${method}" timed out (${timeoutMs}ms)`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.postMessage({ t: "req", id, method, params: params ?? {} });
    });
  }

  /** Send a one-way event to the plugin. */
  post(method: string, params: unknown = {}): void {
    if (this.proc && !this.closed) {
      this.proc.postMessage({ t: "evt", method, params });
    }
  }

  /** Register a handler for plugin -> host requests (capability calls). */
  onMethod(
    method: string,
    handler: (params: any) => unknown | Promise<unknown>,
  ): void {
    this.methodHandlers.set(method, handler);
  }

  /** Ask the plugin to run onExit, then kill the process. */
  async exitAndKill(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.call("exit", {}, 1500);
    } catch {
      /* timeout or dead — kill anyway */
    }
    this.kill();
  }

  kill(): void {
    this.closed = true;
    this.settleAll(new Error(`sandbox "${this.pluginId}" was terminated`));
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* already dead */
      }
      this.proc = null;
    }
  }

  get isRunning(): boolean {
    return !!this.proc && !this.closed;
  }

  // ------------------------------------------------------------- internals
  private onMessage(msg: any): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.result);
      }
    } else if (msg.t === "err") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.reject(new Error(msg.error || "plugin rpc error"));
      }
    } else if (msg.t === "evt") {
      if (msg.method === "ready") {
        this.onceReady?.(true);
        this.onceReady = null;
      } else if (msg.method === "error" && this.onceReady) {
        // Plugin reported a load/runtime error before ready: fail the
        // handshake fast with the specific message (no 5s stall).
        this.loadError = String(msg.params?.message ?? "plugin error");
        this.onceReady(false);
        this.onceReady = null;
      }
      this.cb.onEvent({ method: msg.method, params: msg.params ?? {} });
    } else if (msg.t === "req") {
      // Plugin -> host capability request (fs / clipboard / net / data.dir).
      // This branch is what makes main.readFile/writeFile/copyText/... work at
      // all: without it every capability call from a sandbox hung until its
      // own timeout and then failed.
      void this.dispatchRequest({
        id: msg.id,
        method: msg.method,
        params: msg.params,
      });
    }
  }

  /** Dispatch a plugin -> host request (capability gate) to the manager. */
  async dispatchRequest(msg: {
    id: number;
    method: string;
    params: any;
  }): Promise<void> {
    const handler = this.methodHandlers.get(msg.method);
    try {
      if (!handler) {
        this.reply(msg.id, undefined, `unknown method "${msg.method}"`);
        return;
      }
      const result = await handler(msg.params ?? {});
      this.reply(msg.id, result === undefined ? {} : result);
    } catch (e) {
      this.reply(msg.id, undefined, String((e as Error).message || e));
    }
  }

  private reply(id: number, result?: unknown, error?: string): void {
    if (!this.proc) return;
    if (error) this.proc.postMessage({ t: "err", id, error });
    else this.proc.postMessage({ t: "res", id, result });
  }

  private settleAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.closed = true;
  }
}
