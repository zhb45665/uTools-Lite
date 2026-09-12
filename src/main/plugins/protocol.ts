import fs from "node:fs";
import path from "node:path";
import { protocol } from "electron";

/**
 * plugin:// scheme -> static file serving from a plugin folder.
 *
 *   plugin://<pluginId>/<file>   e.g. plugin://notes/detail.html
 *
 * The scheme must be declared privileged BEFORE app ready (standard URLs,
 * so path parsing behaves normally). File requests are confined to the
 * plugin's own directory (path traversal is rejected).
 */

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

export function registerPluginScheme(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: "plugin",
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
            },
        },
    ]);
}

export function registerPluginProtocol(
    resolveDir: (pluginId: string) => string | null,
): void {
    protocol.handle("plugin", async (request) => {
        try {
            const url = new URL(request.url);
            const pluginId = url.hostname;
            const dir = resolveDir(pluginId);
            if (!dir) {
                return new Response("plugin not found", { status: 404 });
            }

            let file = decodeURIComponent(url.pathname).replace(/^\/+/, "");
            if (!file) file = "detail.html";

            const root = path.resolve(dir);
            const resolved = path.resolve(root, file);
            if (resolved !== root && !resolved.startsWith(root + path.sep)) {
                return new Response("forbidden", { status: 403 });
            }

            const data = await fs.promises.readFile(resolved);
            const mime =
                MIME[path.extname(resolved).toLowerCase()] ??
                "application/octet-stream";
            return new Response(new Uint8Array(data), {
                status: 200,
                headers: { "content-type": mime },
            });
        } catch {
            return new Response("not found", { status: 404 });
        }
    });
}
