import type { LauncherApi, UToolsApi } from "../preload/launcher";

declare global {
  interface Window {
    /** Main launcher frame only. */
    launcher: LauncherApi;
    /** Plugin detail frame (plugin://) only. */
    uTools: UToolsApi;
  }
}
