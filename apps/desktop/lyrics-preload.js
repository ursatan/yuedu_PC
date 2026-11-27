/**
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * 浮条预加载桥（仅 Electron）。同一扇窗两种形态：
 * · `lyrics`：朗读当前句（既有 `onUpdate/command/close`）；
 * · `reading`：小窗·条形档，额外暴露 `floatCommand` / `hover`。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yueduLyrics', {
  /** 主进程下发 `{ mode, state, reading, prefs }` → 返回退订函数 */
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('yuedu:float-update', handler);
    return () => ipcRenderer.off('yuedu:float-update', handler);
  },
  /** 歌词形态：上一句 / 播放暂停 / 下一句 */
  command: (cmd) => ipcRenderer.send('yuedu:lyrics-command', cmd),
  /** 歌词形态：只关悬浮窗，不退出应用，也不停止朗读 */
  close: () => ipcRenderer.send('yuedu:lyrics-close'),
  /** 条形档：速度 / 穿透 / 切档 / 退出（主进程按当前形态处理） */
  floatCommand: (cmd) => ipcRenderer.send('yuedu:float-command', cmd),
  /** 条形档：鼠标进入/离开右上角控制区（穿透时临时接收点击） */
  hover: (active) => ipcRenderer.send('yuedu:float-hover', active === true),
  /**
   * 拖动：发送屏幕坐标增量（主进程按当前形态钳制后 `setBounds`）。
   * 不依赖 `-webkit-app-region`，避免 drag 区吞鼠标事件导致按钮点不到。
   */
  moveBy: (dx, dy) => ipcRenderer.send('yuedu:float-move', { dx, dy }),
  /**
   * 歌词形态自定义缩放：贴边拖动时发边与增量（透明无边框窗没有系统缩放边框，
   * 主进程按形态/锁定状态决定是否受理）。
   */
  resizeBy: (edge, dx, dy) => ipcRenderer.send('yuedu:float-resize', { edge, dx, dy }),
  /** 浮条设置面板：外观/拖动开关（与设置页共用同一份 prefs） */
  setPrefs: (patch) => ipcRenderer.send('yuedu:float-patch', patch),
  /** 设置面板开合 ⇒ 主进程按实测面板高度临时加高（歌词窗只有三行高，装不下面板） */
  panel: (open, height) => ipcRenderer.send('yuedu:float-panel', { open: open === true, height: Number(height) || 0 }),
  /** 原生取色器需要窗口可聚焦；选完立刻恢复 focusable:false */
  focusable: (on) => ipcRenderer.send('yuedu:float-focusable', on === true),
  /** 长句换行后的真实内容高度 ⇒ 主进程按它调整窗口（多行完整可见，不截断） */
  fitHeight: (h) => ipcRenderer.send('yuedu:float-height', h === undefined ? 0 : h),
});
