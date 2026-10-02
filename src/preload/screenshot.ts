import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("screenCapture", {
  finish(selection: { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }) {
    ipcRenderer.send("ocr-screen-selection", selection);
  },
  cancel() {
    ipcRenderer.send("ocr-screen-cancel");
  },
});
