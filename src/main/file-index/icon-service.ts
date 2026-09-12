/**
 * Real Windows file/app icons, zero npm dependencies.
 *
 * A resident PowerShell process compiles a tiny C# helper (Add-Type, JIT —
 * no build tools, no native modules) that shells out to Win32
 * SHGetFileInfo and renders the associated shell icon to a 32x32 PNG.
 * Line protocol over stdin/stdout:
 *
 *   in:  <absolute path>\n
 *   out: <base64 PNG>\n   or   NULL\n
 *
 * Notes:
 * - .lnk shortcuts resolve to the target icon (with shortcut arrow), exactly
 *   like Explorer does.
 * - Electron 33 has no icon module (checked: absent from electron.d.ts),
 *   hence the PowerShell route. Works in dev and packaged alike.
 * - Any failure (no PowerShell, compile error, extraction miss) resolves
 *   null and the UI falls back to the emoji hint. The service may restart
 *   up to twice; afterwards it is disabled for the session.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SVC_VERSION = "v4";
const MAX_CACHE = 2000;
const MAX_RESTARTS = 2;
const REQUEST_TIMEOUT_MS = 8000;

const CSHARP_SOURCE =
  'using System;\nusing System.IO;\nusing System.Runtime.InteropServices;\nusing System.Drawing;\nusing System.Drawing.Imaging;\n\npublic static class IconSvc\n{\n    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]\n    struct SHFILEINFO\n    {\n        public IntPtr hIcon;\n        public int iIcon;\n        public uint dwAttributes;\n        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;\n        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;\n    }\n\n    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]\n    static extern IntPtr SHGetFileInfo(string path, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbSize, uint uFlags);\n\n    [DllImport("user32.dll")]\n    static extern bool DestroyIcon(IntPtr hIcon);\n\n    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]\n    static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);\n\n    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]\n    static extern IntPtr SHGetFileInfo(IntPtr pidl, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbSize, uint uFlags);\n\n    [DllImport("ole32.dll")]\n    static extern void CoTaskMemFree(IntPtr pv);\n\n    const uint SHGFI_PIDL = 0x000000008;\n    const uint SHGFI_ICON = 0x000000100;\n    const uint SHGFI_LARGEICON = 0x000000000;\n    const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;\n\n    static byte[] Extract(string path)\n    {\n        // Store / builtin (UWP) apps have no file path: their launch target is\n        // shell:AppsFolder\\<AppID>, so resolve it to a PIDL first.\n        if (path.StartsWith("shell:", StringComparison.OrdinalIgnoreCase))\n            return ExtractFromShellPath(path);\n        if (!System.IO.File.Exists(path))\n            return null;\n        SHFILEINFO shfi = new SHFILEINFO();\n        uint size = (uint)Marshal.SizeOf(typeof(SHFILEINFO));\n        SHGetFileInfo(path, 0, ref shfi, size, SHGFI_ICON | SHGFI_LARGEICON);\n        IntPtr hIcon = shfi.hIcon;\n        if (hIcon == IntPtr.Zero)\n        {\n            SHGetFileInfo(path, 0x20, ref shfi, size, SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES);\n            hIcon = shfi.hIcon;\n        }\n        if (hIcon == IntPtr.Zero) return null;\n        try { return RenderPng(hIcon); }\n        finally { DestroyIcon(hIcon); }\n    }\n\n    static byte[] RenderPng(IntPtr hIcon)\n    {\n        using (var ico = Icon.FromHandle(hIcon))\n        using (var full = ico.ToBitmap())\n        using (var bmp32 = new Bitmap(full, 32, 32))\n        using (var ms = new MemoryStream())\n        {\n            bmp32.Save(ms, ImageFormat.Png);\n            return ms.ToArray();\n        }\n    }\n\n    // shell:AppsFolder\\<AppID> -> PIDL -> shell icon (what Explorer shows).\n    static byte[] ExtractFromShellPath(string shellPath)\n    {\n        IntPtr pidl;\n        uint attrs;\n        int hr = SHParseDisplayName(shellPath, IntPtr.Zero, out pidl, 0, out attrs);\n        if (hr != 0 || pidl == IntPtr.Zero) return null;\n        try\n        {\n            SHFILEINFO shfi = new SHFILEINFO();\n            uint size = (uint)Marshal.SizeOf(typeof(SHFILEINFO));\n            IntPtr r = SHGetFileInfo(pidl, 0, ref shfi, size, SHGFI_PIDL | SHGFI_ICON | SHGFI_LARGEICON);\n            if (r == IntPtr.Zero || shfi.hIcon == IntPtr.Zero) return null;\n            try { return RenderPng(shfi.hIcon); }\n            finally { DestroyIcon(shfi.hIcon); }\n        }\n        finally { CoTaskMemFree(pidl); }\n    }\n\n    public static void Main()\n    {\n        Console.InputEncoding = System.Text.Encoding.UTF8;\n        Console.OutputEncoding = System.Text.Encoding.UTF8;\n        var tr = Environment.GetEnvironmentVariable("UTL_ICON_TRACE") == "1" ? new System.IO.StreamWriter("C:/Users/zhb45/AppData/Local/Temp/utools-lite/icon-trace.txt", false) : null;\n        string line;\n        while ((line = Console.ReadLine()) != null)\n        {\n            System.DateTime st = System.DateTime.Now;\n            if (tr != null) { tr.WriteLine("REQ [" + line + "]"); tr.Flush(); }\n            byte[] data = null;\n            try\n            {\n                if (!string.IsNullOrWhiteSpace(line))\n            {\n                var task = System.Threading.Tasks.Task.Run(() => Extract(line));\n                if (task.Wait(3000)) data = task.Result;\n            }\n            }\n            catch { data = null; }\n            if (tr != null) { tr.WriteLine((data == null ? "NULL" : "OK " + data.Length) + " " + (System.DateTime.Now - st).TotalMilliseconds + "ms"); tr.Flush(); }\n            Console.WriteLine(data == null ? "NULL" : Convert.ToBase64String(data));\n        }\n    }\n}\n';

let child: ChildProcess | null = null;
let reader: Interface | null = null;
let dead = false;
let restarts = 0;
let lastLineAt = Date.now();
const cache = new Map<string, string | null>();
const waiters = new Map<string, Array<(url: string | null) => void>>();
const queue: string[] = [];

function csFile(): string {
  const dir = path.join(tmpdir(), "utools-lite");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `icon-service-${SVC_VERSION}.cs`);
}

function launch(): void {
  if (child || dead) return;
  if (process.platform !== "win32") {
    dead = true;
    failAll();
    return;
  }
  try {
    const cs = csFile();
    if (!existsSync(cs)) writeFileSync(cs, CSHARP_SOURCE, "utf8");
    const cmd = `Add-Type -Path '${cs}' -ReferencedAssemblies 'System.Drawing'; [IconSvc]::Main()`;
    child = spawn(
      "powershell",
      ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", cmd],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const stdout = child.stdout;
    if (!stdout) {
      onChildGone();
      return;
    }
    reader = createInterface({ input: stdout });
    reader.on("line", onServiceLine);
    child.on("error", () => onChildGone());
    child.on("exit", () => onChildGone());
  } catch {
    child = null;
    onChildGone();
  }
}

function onChildGone(): void {
  const wasAlive = child !== null;
  child = null;
  reader = null;
  if (dead) return;
  if (wasAlive && restarts < MAX_RESTARTS) {
    restarts++;
    queue.length = 0;
    for (const list of waiters.values()) for (const r of list) r(null);
    waiters.clear();
    setTimeout(launch, 500);
    return;
  }
  dead = true;
  for (const list of waiters.values()) for (const r of list) r(null);
  waiters.clear();
  queue.length = 0;
}

function failAll(): void {
  dead = true;
  for (const list of waiters.values()) for (const r of list) r(null);
  waiters.clear();
  queue.length = 0;
}

function onServiceLine(line: string): void {
  lastLineAt = Date.now();
  const p = queue.shift();
  if (p === undefined) return; // stray line; ignore
  const url = line && line !== "NULL" ? "data:image/png;base64," + line : null;
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(p, url);
  const list = waiters.get(p);
  waiters.delete(p);
  if (list) for (const r of list) r(url);
}

/**
 * Resolve the real shell icon of a file/app as a data URL.
 * Resolves null when unavailable (UI then falls back to the emoji hint).
 */
export function getIconUrl(p: string): Promise<string | null> {
  const hit = cache.get(p);
  if (hit !== undefined) return Promise.resolve(hit);
  if (p.includes("\n") || p.includes("\r")) return Promise.resolve(null);
  launch();
  if (dead) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    const list = waiters.get(p);
    if (list) list.push(finish);
    else waiters.set(p, [finish]);
    queue.push(p);
    try {
      child?.stdin?.write(p + "\n");
    } catch {
      finish(null);
    }
    setTimeout(() => {
      // Global health watchdog: if the service has not produced a single
      // line for >10s while requests are still queued (AV suspension / a
      // hung Win32 call), kill it so onChildGone restarts it. This request
      // falls back to the emoji; the next search retries (nothing was cached).
      if (queue.length > 0 && Date.now() - lastLineAt > 10000 && child) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }
      finish(null);
    }, REQUEST_TIMEOUT_MS);
  });
}

/** Start the service early (hides the ~1s PowerShell boot from first search). */
export function warmupIcons(): void {
  launch();
}

/**
 * Pre-fetch icons for the given paths (fire-and-forget, FIFO through the
 * service). Called at startup with every Start Menu app so the icons are
 * already in the in-memory cache by the time the user searches — app icons
 * then render instantly, first keystroke included.
 */
export function preloadIcons(paths: string[]): void {
  if (paths.length === 0) return;
  launch();
  for (const p of paths) {
    void getIconUrl(p).catch(() => null);
  }
}

/** Terminate the service (app quit). */
export function killIcons(): void {
  dead = true;
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  child = null;
}
