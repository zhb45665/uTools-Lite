import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface AppSettings {
  hotkey: string;
  rememberSize: { width: number; height: number } | null;
  hasLaunchedBefore: boolean;
}

const DEFAULTS: AppSettings = {
  hotkey: "Alt+Space",
  rememberSize: { width: 720, height: 460 },
  hasLaunchedBefore: false,
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
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.cache[key];
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.cache[key] = value;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf8");
    } catch (e) {
      console.error("[store] failed to persist settings", e);
    }
  }

  get all(): AppSettings {
    return { ...this.cache };
  }
}
