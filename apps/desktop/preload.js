/**
 * SPDX-License-Identifier: GPL-3.0-only
 * 桌面朗读歌词桥（`lyricsState` / `onLyricsCommand` / `onLyricsEnabled`）
 * 设计参考：byl669/legado-lyrics-overlay（GPL-3.0）
 * 修改：只保留「状态下发 + 上一句/播放暂停/下一句 + 关闭」四类消息的白名单。
 *
 * 预加载脚本：向 Web 应用暴露受控的桌面端能力。
 *
 * 分两块：① 登录窗（既有）；② `#209` 桌面端专属（托盘 / 全局快捷键 / 文件关联 / 开机自启）。
 * ★ 所有能力都经 `contextBridge` 收在白名单里 —— 页面拿不到 `require`、拿不到 ipcRenderer 本体，
 *   只能调下面这些具名方法（渲染进程被源里的恶意脚本影响时，能做的也只有这些）。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 把「事件订阅」包成返回退订函数的形式（调用方在组件卸载时能干净地退订） */
function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld('yuedu', {
  /** 是否桌面端环境 */
  isDesktop: true,

  /* ---- 登录窗（既有） ---- */
  /** 仅桌面端可用：打开登录窗，完成登录后返回 Cookie 串（"a=b; c=d"） */
  login: (sourceId, url, bookSourceUrl) => ipcRenderer.invoke('yuedu:login', { sourceId, url, bookSourceUrl }),
  /** 离线页兜底：确保服务在跑 */
  ensureServer: () => ipcRenderer.invoke('yuedu:ensure-server'),

  /* ---- `#209` 桌面端 ---- */

  /**
   * ★ 渲染进程握手。主进程**攒着**「双击打开」的书文件不发给未就绪的页面
   * （页面启动时要先对齐用户数据，那几百毫秒里发过来会丢），
   * 所以界面挂好监听后**必须**调一次这个，主进程才开始发。
   */
  rendererReady: () => ipcRenderer.send('yuedu:renderer-ready'),

  /** 一次性取回桌面端真实状态：托盘 / 快捷键（含独立复核）/ 开机自启 / 文件关联 / 路径版本 */
  desktopStatus: () => ipcRenderer.invoke('yuedu:desktop-status'),
  getDesktopPrefs: () => ipcRenderer.invoke('yuedu:desktop-prefs-get'),
  /** 只传要改的项；非法值由主进程归一后**如实回报**告警，不会静默吞掉 */
  setDesktopPrefs: (patch) => ipcRenderer.invoke('yuedu:desktop-prefs-set', patch),
  /** 选择数据目录（只返回路径，不直接切换） */
  pickDataDir: () => ipcRenderer.invoke('yuedu:desktop-pick-data-dir'),

  /** 打开系统文件对话框挑 txt/epub → 交回主进程走「双击打开」同一条导入路径 */
  openLocalBook: () => ipcRenderer.invoke('yuedu:open-local-book'),
  /** 注册/注销文件关联（HKCU，当前用户，不劫持默认程序）；开发态会返回 supported:false + 原因 */
  setFileAssoc: (enable) => ipcRenderer.invoke('yuedu:file-assoc-set', enable),
  /**
   * `#347` 注册/注销**导入链接协议**（`yuedu://` / `legado://`）。
   * 缺它 ⇒ 分享页里点链接时系统不知道该唤起谁（用户看到「点了没反应」）。
   */
  setProtocolAssoc: (enable) => ipcRenderer.invoke('yuedu:protocol-assoc-set', enable),
  /** 只读查询协议注册状态（两个 scheme 是否都指向本 exe） */
  getProtocolAssoc: () => ipcRenderer.invoke('yuedu:protocol-assoc-get'),
  /** 开机自启；开发态同样返回 supported:false + 原因 */
  setAutoLaunch: (enable) => ipcRenderer.invoke('yuedu:auto-launch-set', enable),
  /** 显示/隐藏主窗口（`visible=false` 收进托盘） */
  toggleWindow: (visible) => ipcRenderer.invoke('yuedu:toggle-window', visible),
  /**
   * `D4` F11 切换主窗口全屏（界面全局 keydown 调它）。
   * Web 端没有这个桥 ⇒ 前端回退到浏览器 Fullscreen API。
   */
  toggleFullscreen: () => ipcRenderer.invoke('yuedu:fullscreen'),

  /* ---- 浮窗阅读（常规 / 条形）：独立无边框窗，主窗 hide + 浮窗显示 ---- */
  /** 取当前浮窗运行态（`{open, mode, width, height, speed, clickThrough…}`） */
  getFloatState: () => ipcRenderer.invoke('yuedu:float-get'),
  /** `mode` 省略 = 切换；'regular' = 常规；'bar' = 条形；false = 退出 */
  toggleFloat: (mode) => ipcRenderer.invoke('yuedu:float-open', mode),
  /** 浮窗内切形态：'regular' | 'bar' */
  setFloatMode: (mode) => ipcRenderer.invoke('yuedu:float-mode', mode),
  /** 退出浮窗阅读（浮窗 hide + 主窗 show） */
  closeFloat: () => ipcRenderer.invoke('yuedu:float-close'),
  /** 主进程几何/形态变化后广播（点 ✕ 退出、切形态等场景也要让界面跟着变） */
  onFloatState: (cb) => subscribe('yuedu:float-state', cb),
  /** 阅读页把当前章节正文流推给浮窗（常规 = 分片正文；条形 = 轨道行） */
  floatReading: (state) => ipcRenderer.send('yuedu:float-reading', state),
  /** 浮窗内点击目录/章节/跳转 → 主窗阅读页执行 */
  onFloatCommand: (cb) => subscribe('yuedu:float-command', cb),

  /* ---- 桌面朗读歌词（仅 Electron；Web 端没有这组桥） ---- */
  /**
   * 把主窗口现有朗读状态上报给主进程（`index` / `innerPos` / 前后句 / 播放态）。
   * 主进程只在「开关开 + 正在播 + 有内容 + 主窗口失焦 + 未锁屏」时显示歌词窗。
   */
  lyricsState: (state) => ipcRenderer.send('yuedu:lyrics-state', state),
  /** 歌词窗按钮（上一句/播放暂停/下一句）→ 主窗口的朗读 store 执行 */
  onLyricsCommand: (cb) => subscribe('yuedu:lyrics-command', cb),
  /** 歌词窗上点「关闭」后主进程回告开关已落盘为 false */
  onLyricsEnabled: (cb) => subscribe('yuedu:lyrics-enabled', cb),

  /** 主进程送来「要打开的本地书」（双击 txt/epub 或托盘菜单挑的）→ 返回退订函数 */
  onOpenFiles: (cb) => subscribe('yuedu:open-files', cb),
  /**
   * `#347` 主进程送来「一键导入深链」（点 `yuedu://…` / `legado://…` 唤起）→ 返回退订函数。
   * 载荷 = 原始 URL 字符串；判型在渲染进程（`utils/scheme-import.ts`）。
   */
  onSchemeUrl: (cb) => subscribe('yuedu:scheme-url', cb),
  /** 主进程要求界面跳到某个路由（托盘菜单「桌面端设置…」） */
  onNavigate: (cb) => subscribe('yuedu:navigate', cb),

  /* ---- `#453` 内嵌真浏览器（WebContentsView 常驻池） ---- */

  /**
   * 把真浏览器嵌进界面：`{ key|sourceId, url, bounds }`。
   * `bounds` 是**相对窗口内容区**的 CSS 像素（主进程会再夹一次，越界也不会跑到看不见的地方）。
   * 拿不到 `WebContentsView`（Electron < 30）时回 `{ok:false, error:'NOT_SUPPORTED'}` ⇒ 界面走 iframe 回落。
   */
  webviewOpen: (opts) => ipcRenderer.invoke('yuedu:webview-open', opts),
  /** 只调位置/尺寸（窗口缩放、布局变化时调；不重新加载） */
  webviewAttach: (opts) => ipcRenderer.invoke('yuedu:webview-attach', opts),
  /** 收起（挂回后台，**不销毁**：TTL 内再打开仍是同一个页面与登录态） */
  webviewDetach: (opts) => ipcRenderer.invoke('yuedu:webview-detach', opts),
  /** 导航：`{url}` 或 `{action:'back'|'forward'|'reload'}` */
  webviewNav: (opts) => ipcRenderer.invoke('yuedu:webview-nav', opts),
  /** 页面内执行脚本（代点按钮 / 取数据） */
  webviewExec: (opts) => ipcRenderer.invoke('yuedu:webview-exec', opts),
  /** `#568` P3 站点定制：给当前 view 注入 CSS/JS（每次导航后由前端重新解析地址再调） */
  webviewInject: (opts) => ipcRenderer.invoke('yuedu:webview-inject', opts),
  /** 只读状态：能否进退 / 当前 URL / 是否已挂进主窗口 */
  webviewStatus: (opts) => ipcRenderer.invoke('yuedu:webview-status', opts),
  /** 关掉某会话的 view（partition 保留，登录态不丢） */
  webviewClose: (opts) => ipcRenderer.invoke('yuedu:webview-close', opts),
  /**
   * `#456` **只读**该会话 partition 里的 cookie（`[{name,value,domain,path}]`）。
   * 桌面端内嵌 view 的 cookie 与服务端 CDP 浏览器**是两个进程**，服务端 harvest 读不到这边
   * ⇒ 回传由渲染进程做（读出来后 POST `/api/sources/:id/login/cookies`）。
   */
  webviewCookies: (opts) => ipcRenderer.invoke('yuedu:webview-cookies', opts),
  /**
   * 页内事件（**只报不判**）：`{key, type:'navigate'|'open'|'navigated'|'title', url?, disposition?}`。
   * 主进程在 `will-navigate` / 新窗口一律先拦下 —— 同站判据由渲染进程用 `source-site.ts` 的
   * `sameSite()` 回判（同一判据全仓只有一份），判同站再 `webviewNav` 放行。
   */
  onWebviewEvent: (cb) => subscribe('yuedu:webview-ev', cb),
});
