import { contextBridge, ipcRenderer } from "electron";
import type { Bridge } from "../shared/types";
const bridge: Bridge = {
  saveModelDefault: (mode, model) =>
    ipcRenderer.invoke("save-model-default", mode, model),
  refreshCatalog: () => ipcRenderer.invoke("refresh-catalog"),
  snapshot: () => ipcRenderer.invoke("snapshot"),
  enqueue: (token, recipe) => ipcRenderer.invoke("enqueue", token, recipe),
  saveKey: (key) => ipcRenderer.invoke("save-key", key),
  clearKey: () => ipcRenderer.invoke("clear-key"),
  retry: (id) => ipcRenderer.invoke("retry", id),
  cancelQueued: (id) => ipcRenderer.invoke("cancel-queued", id),
  stopTracking: (id) => ipcRenderer.invoke("stop-tracking", id),
  exportAsset: (id) => ipcRenderer.invoke("export", id),
  reveal: (id) => ipcRenderer.invoke("reveal", id),
  openAsset: (id) => ipcRenderer.invoke("open", id),
};
contextBridge.exposeInMainWorld("mediaGen", bridge);
