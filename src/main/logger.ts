import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const MAX_BYTES = 5 * 1024 * 1024;
let logDir = "";
let logFile = "";

export function initLogger(): void {
  logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, "app.log");
  rotate();
}

function rotate(): void {
  try {
    if (!fs.existsSync(logFile) || fs.statSync(logFile).size < MAX_BYTES) return;
    for (let i = 3; i >= 1; i--) {
      const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const to = `${logFile}.${i}`;
      if (fs.existsSync(to)) fs.unlinkSync(to);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch { /* logging must never stop startup */ }
}

function safe(value: unknown): string {
  const text = value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value);
  const user = process.env.USERPROFILE;
  return user ? text.split(user).join("%USERPROFILE%") : text;
}

export function log(level: "INFO" | "WARN" | "ERROR", module: string, ...parts: unknown[]): void {
  try {
    if (!logFile) return;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${module.padEnd(10)} ${parts.map(safe).join(" ")}\n`;
    fs.appendFileSync(logFile, line, "utf8");
  } catch { /* best effort */ }
}

export function logsDirectory(): string { return logDir || path.join(app.getPath("userData"), "logs"); }
