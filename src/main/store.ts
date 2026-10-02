import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { readState, writeState } from "./database";

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
      let parsed = readState<Partial<AppSettings>>("app", "settings");
      if (!parsed) {
        parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<AppSettings>;
        writeState("app", "settings", parsed);
      }
      const size = parsed.rememberSize;
      return {
        ...DEFAULTS,
        hotkey:
          typeof parsed.hotkey === "string" ? parsed.hotkey : DEFAULTS.hotkey,
        rememberSize:
          size && Number.isFinite(size.width) && Number.isFinite(size.height)
            ? // Cap at a size comfortably below any work area: the launcher is a
              // compact floating card, and the credential workspace expands via
              // setCredentialWindow (not via rememberSize). A persisted
              // full-screen size (e.g. from a pre-guard maximize bug) must not
              // survive a restart — clamp it back to the compact range.
              {
                width: Math.max(520, Math.min(1200, size.width!)),
                height: Math.max(360, Math.min(800, size.height!)),
              }
            : DEFAULTS.rememberSize,
        hasLaunchedBefore: parsed.hasLaunchedBefore === true,
        launchAtLogin: parsed.launchAtLogin === true,
        theme: ["system", "light", "dark"].includes(String(parsed.theme))
          ? (parsed.theme as AppSettings["theme"])
          : DEFAULTS.theme,
      };
    } catch (e) {
      if (fs.existsSync(this.file)) {
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* best effort */
        }
        console.error("[store] invalid settings; defaults restored", e);
      }
      return { ...DEFAULTS };
    }
  }

  private persist(): void {
    try {
      writeState("app", "settings", this.cache);
    } catch (e) {
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
