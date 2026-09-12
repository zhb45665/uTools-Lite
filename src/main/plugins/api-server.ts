import fs from "node:fs";
import path from "node:path";
import { clipboard, shell, dialog } from "electron";
import { suspendBlurHide, resumeBlurHide } from "../launcher-window";
import { Manifest, pluginDataDir } from "./manifest";
import { writeAtomic } from "./atomic-file";
import {
  assertInside,
  checkFsAccess,
  isInsideAuthorizedDir,
  resolvePluginPath,
} from "./permissions";

/**
 * The host-side capability gate: the ONLY place in the app that serves a
 * plugin's fs / clipboard / net / shell requests.
 *
 * - manifest permission check first (undeclared => rejected)
 * - fs: private data dir is free; authorized dirs pass; anything else
 *   prompts the user via an inline card
 * - net: proxied through Node's global fetch, body returned as text
 */

export interface GateContext {
  /** Ask the user to authorize a directory (inline card). Resolves true on grant. */
  requestDirGrant: (
    pluginId: string,
    pluginName: string,
    dir: string,
    purpose: string,
  ) => Promise<boolean>;
}

const FETCH_TIMEOUT_MS = 15000;
const MAX_BODY = 1024 * 1024;

export class ApiServer {
  private handlers = new Map<
    string,
    (m: Manifest, p: any) => unknown | Promise<unknown>
  >();

  constructor(private ctx: GateContext) {
    this.handlers.set("fs.read", async (m, p) => {
      const target = await this.guardFs(m, p?.path, "访问");
      return { content: await fs.promises.readFile(target, "utf8") };
    });
    this.handlers.set("fs.write", async (m, p) => {
      const target = await this.guardFs(m, p?.path, "写入");
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, String(p?.content ?? ""), "utf8");
      return { ok: true };
    });
    this.handlers.set("fs.list", async (m, p) => {
      const target = await this.guardFs(m, p?.path, "列出");
      return { entries: await this.listEntries(target) };
    });
    this.handlers.set("fs.writeAtomic", async (m, p) => {
      const target = await this.guardFs(m, p?.path, "写入");
      await writeAtomic(
        target,
        String(p?.content ?? ""),
        p?.exclusive === true,
      );
      return { ok: true };
    });
    this.handlers.set("password.backupSave", async (m, p) => {
      if (m.id !== "password" || !m.permissions.includes("fs"))
        throw new Error("backup capability unavailable");
      const content = String(p?.encrypted ?? "");
      const blob = JSON.parse(content);
      if (
        !blob?.kdf ||
        !blob?.iv ||
        !blob?.tag ||
        typeof blob?.data !== "string"
      )
        throw new Error("invalid encrypted backup");
      suspendBlurHide();
      try {
        const result = await dialog.showSaveDialog({
          title: "保存加密备份",
          defaultPath: `utools-vault-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: "加密密码本", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        if (
          path
            .resolve(result.filePath)
            .toLowerCase()
            .startsWith(
              path.resolve(pluginDataDir(m.id)).toLowerCase() + path.sep,
            )
        )
          throw new Error("请选择密码本数据目录之外的位置保存备份");
        await writeAtomic(result.filePath, content);
        return { saved: true };
      } finally {
        resumeBlurHide();
      }
    });
    this.handlers.set("password.backupPick", async (m) => {
      if (m.id !== "password" || !m.permissions.includes("fs"))
        throw new Error("backup capability unavailable");
      suspendBlurHide();
      try {
        const result = await dialog.showOpenDialog({
          title: "选择加密备份",
          properties: ["openFile"],
          filters: [{ name: "加密密码本", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePaths[0]) return { canceled: true };
        const file = result.filePaths[0];
        if ((await fs.promises.stat(file)).size > 10 * 1024 * 1024)
          throw new Error("备份文件过大");
        return {
          encrypted: await fs.promises.readFile(file, "utf8"),
          name: path.basename(file),
        };
      } finally {
        resumeBlurHide();
      }
    });
    this.handlers.set("clipboard.read", (m) => this.clipboardRead(m));
    this.handlers.set("clipboard.write", (m, p) => this.clipboardWrite(m, p));
    this.handlers.set("net.fetch", (m, p) => this.netFetch(m, p));
    this.handlers.set("shell.openPath", (m, p) => this.shellOpen(m, p));
    this.handlers.set("data.dir", (m) => ({ dir: pluginDataDir(m.id) }));
    this.handlers.set("perm.request", (m, p) => this.permRequest(m, p));
  }

  /**
   * Wire one sandbox's plugin -> host requests to this gate.
   */
  attach(
    sandbox: {
      onMethod: (m: string, h: (p: any) => unknown | Promise<unknown>) => void;
    },
    manifest: Manifest,
  ): void {
    const m = manifest;
    for (const [method, handler] of this.handlers) {
      sandbox.onMethod(method, (p) => handler(m, p));
    }
  }

  /**
   * Invoke a capability directly (used for detail-frame uTools.* calls).
   * Same gate as the sandbox: manifest permissions + dir authorization.
   */
  async invoke(
    manifest: Manifest,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`unknown capability "${method}"`);
    return handler(manifest, params ?? {});
  }

  // ----------------------------------------------------------------- fs
  /**
   * Async fs guard: manifest check -> data dir / authorized dir check ->
   * interactive grant prompt. Returns the resolved absolute path, or throws.
   */
  private async guardFs(
    m: Manifest,
    rawPath: unknown,
    opLabel: string,
  ): Promise<string> {
    if (!m.permissions.includes("fs")) {
      throw new Error(`plugin "${m.id}" has no "fs" permission`);
    }
    const abs = resolvePluginPath(m.id, String(rawPath ?? ""));
    const verdict = checkFsAccess(m.id, abs);
    if (verdict.ok) return abs;
    const granted = await this.ctx.requestDirGrant(
      m.id,
      m.name,
      verdict.offerDir,
      `插件需要${opLabel}目录`,
    );
    if (!granted) {
      throw new Error(`user denied access to ${verdict.offerDir}`);
    }
    return assertInside(verdict.offerDir, abs);
  }

  private async listEntries(
    target: string,
  ): Promise<{ name: string; dir: boolean; size: number }[]> {
    const dirents = await fs.promises.readdir(target, { withFileTypes: true });
    const out: { name: string; dir: boolean; size: number }[] = [];
    for (const e of dirents) {
      let size = 0;
      if (!e.isDirectory()) {
        try {
          size = (await fs.promises.stat(path.join(target, e.name))).size;
        } catch {
          /* ignore */
        }
      }
      out.push({ name: e.name, dir: e.isDirectory(), size });
    }
    out.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    return out;
  }

  // ---------------------------------------------------------- clipboard
  private async clipboardRead(m: Manifest): Promise<{ text: string }> {
    if (!m.permissions.includes("clipboard")) {
      throw new Error(`plugin "${m.id}" has no "clipboard" permission`);
    }
    return { text: clipboard.readText() };
  }

  private async clipboardWrite(m: Manifest, p: any): Promise<{ ok: true }> {
    if (!m.permissions.includes("clipboard")) {
      throw new Error(`plugin "${m.id}" has no "clipboard" permission`);
    }
    clipboard.writeText(String(p?.text ?? ""));
    return { ok: true };
  }

  // ----------------------------------------------------------------- net
  private async netFetch(
    m: Manifest,
    p: any,
  ): Promise<{ status: number; body: string }> {
    if (!m.permissions.includes("net")) {
      throw new Error(`plugin "${m.id}" has no "net" permission`);
    }
    const url = String(p?.url ?? "");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`only http(s) URLs are allowed, got "${url}"`);
    }
    const opts: any =
      p?.options && typeof p.options === "object" ? p.options : {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: typeof opts.method === "string" ? opts.method : "GET",
        headers: opts.headers,
        body: typeof opts.body === "string" ? opts.body : undefined,
        signal: controller.signal,
      });
      const body = await res.text();
      return { status: res.status, body: body.slice(0, MAX_BODY) };
    } finally {
      clearTimeout(timer);
    }
  }

  // --------------------------------------------------------------- shell
  private async shellOpen(
    m: Manifest,
    p: any,
  ): Promise<{ ok: boolean; error?: string }> {
    const target = resolvePluginPath(m.id, String(p?.path ?? ""));
    const err = await shell.openPath(target);
    if (err) return { ok: false, error: err };
    return { ok: true };
  }

  // --------------------------------------------------------- explicit ask
  private async permRequest(
    m: Manifest,
    p: any,
  ): Promise<{ granted: boolean }> {
    const target = String(p?.target ?? "");
    const kind = p?.kind === "net" ? "net" : "dir";
    if (kind === "dir") {
      const abs = resolvePluginPath(m.id, target);
      if (isInsideAuthorizedDir(m.id, abs) || checkFsAccess(m.id, abs).ok) {
        return { granted: true };
      }
      const dir = path.dirname(abs);
      const granted = await this.ctx.requestDirGrant(
        m.id,
        m.name,
        dir,
        String(p?.purpose ?? "插件申请目录访问"),
      );
      return { granted };
    }
    // net: P2 grants on manifest declaration (domain whitelist is P3).
    return { granted: m.permissions.includes("net") };
  }
}
