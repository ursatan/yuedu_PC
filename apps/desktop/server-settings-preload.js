/**
 * `--server-only` 服务壳设置小窗的 preload。
 *
 * 只暴露「壳级配置 + 音频缓存」这两组 IPC —— 业务设置仍在 Web 设置页。
 * 页面是 `file://`，所以不能直接 fetch 本地服务（CORS）；音频缓存请求统一由主进程转发。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yueduShell', {
  get: () => ipcRenderer.invoke('yuedu:shell-get'),
  restart: () => ipcRenderer.invoke('yuedu:shell-restart'),
  setPort: (port) => ipcRenderer.invoke('yuedu:shell-set-port', port),
  pickDataDir: () => ipcRenderer.invoke('yuedu:desktop-pick-data-dir'),
  setDataDir: (dir) => ipcRenderer.invoke('yuedu:shell-set-data-dir', dir),
  setAutoLaunch: (on) => ipcRenderer.invoke('yuedu:shell-set-auto-launch', on),
  setLogs: (on) => ipcRenderer.invoke('yuedu:shell-set-logs', on),
  openDataDir: () => ipcRenderer.invoke('yuedu:shell-open-data-dir'),
  openLog: () => ipcRenderer.invoke('yuedu:shell-open-log'),
  close: () => ipcRenderer.invoke('yuedu:shell-settings-close'),
  audioStats: () => ipcRenderer.invoke('yuedu:audio-stats'),
  audioPrune: () => ipcRenderer.invoke('yuedu:audio-prune'),
  audioOrphans: () => ipcRenderer.invoke('yuedu:audio-orphans'),
  audioPurgeOrphans: (keys) => ipcRenderer.invoke('yuedu:audio-purge-orphans', keys),
  audioSetQuota: (maxBytes) => ipcRenderer.invoke('yuedu:audio-config', maxBytes),
  audioClear: () => ipcRenderer.invoke('yuedu:audio-clear'),
});
