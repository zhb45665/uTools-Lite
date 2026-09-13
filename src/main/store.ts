import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface AppSettings {
  schemaVersion: number;
  hotkey: string;
  rememberSize: { width: number; height: number } | null;
  hasLaunchedBefore: boolean;
  launchAtLogin: boolean;
  theme: "system" | "light" | "dark";
}

const DEFAULTS: AppSettings = {
  schemaVersion: 1,
  hotkey: "Alt+Space",
  rememberSize: { width: 720, height: 460 },
  hasLaunchedBefore: false,
  launchAtLogin: false,
  theme: "system",
};

/**
 * Minimal JSON settings store (zero native deps).
 * Stored at %APPDATA%/utools-lite/settings.json
 */
export class SettingsStore {
  private file: string;
  private cache: AppSettings;

  constructor() {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "settings.json");
    this.cache = this.load();
  }

  private load(): AppSettings {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const size = parsed.rememberSize;
      return {
        ...DEFAULTS,
        hotkey: typeof parsed.hotkey === "string" ? parsed.hotkey : DEFAULTS.hotkey,
        rememberSize: size && Number.isFinite(size.width) && Number.isFinite(size.height)
          ? { width: Math.max(520, Math.min(1400, size.width!)), height: Math.max(360, Math.min(1000, size.height!)) }
          : DEFAULTS.rememberSize,
        hasLaunchedBefore: parsed.hasLaunchedBefore === true,
        launchAtLogin: parsed.launchAtLogin === true,
        theme: ["system", "light", "dark"].includes(String(parsed.theme))
          ? parsed.theme as AppSettings["theme"] : DEFAULTS.theme,
      };
    } catch (e) {
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
        console.error("[store] invalid settings; defaults restored", e);
      }
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    const backup = `${this.file}.previous`;
    try {
      fs.writeFileSync(temp, JSON.stringify(this.cache, null, 2), { encoding: "utf8", mode: 0o600 });
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, backup);
      fs.renameSync(temp, this.file);
    } catch (e) {
      try { fs.unlinkSync(temp); } catch { /* ignore */ }
      console.error("[store] failed to persist settings", e);
    }
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.cache[key];
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.cache[key] = value;
    this.persist();
  }

  get all(): AppSettings {
    return { ...this.cache };
  }
}
