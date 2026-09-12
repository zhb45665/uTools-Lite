// 以"无 DEBUG"环境启动 electron-builder 构建 NSIS 安装包。
//
// 背景：builder-util 有个边界 bug——当 DEBUG 环境变量为空时，
// debug("electron-builder").enabled 返回 undefined（而非 false），
// DebugLogger 构造器的默认参数 `isEnabled = true` 被触发，
// 导致每次构建都在 release/ 下写出 builder-debug.yml（含 NSIS 脚本
// 全文的超长行），污染产物目录。
// 给 DEBUG 赋一个不匹配的命名空间，.enabled 会返回真正的 false，dump 关闭；
// 若开发者已显式设置 DEBUG（构建调试场景），则保持原样。
if (!process.env.DEBUG) {
  process.env.DEBUG = "electron-builder-off";
}
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync("electron-builder", ["--win"], {
  cwd: root,
  stdio: "inherit",
  // Windows 下经 cmd 解析 node_modules/.bin/electron-builder.cmd
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
