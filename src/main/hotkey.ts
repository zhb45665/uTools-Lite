import { globalShortcut } from "electron";

let current: string | null = null;

/**
 * Register the global launcher hotkey.
 * Returns true on success. On failure (key already taken) returns false and
 * the caller should surface a hint to the user.
 */
export function registerHotkey(
  accelerator: string,
  onToggle: () => void,
): boolean {
  if (accelerator === current) return true;
  try {
    const ok = globalShortcut.register(accelerator, onToggle);
    if (ok) {
      if (current) globalShortcut.unregister(current);
      current = accelerator;
      return true;
    }
    return false;
  } catch (e) {
    console.error("[hotkey] register failed", accelerator, e);
    return false;
  }
}

export function unregisterHotkey(): void {
  if (current) {
    globalShortcut.unregister(current);
    current = null;
  }
}

export function getCurrentHotkey(): string | null {
  return current;
}
