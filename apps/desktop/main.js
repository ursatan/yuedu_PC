/**
 * SPDX-License-Identifier: GPL-3.0-only
 * 桌面浮窗（`createFloatWindow` / `syncLyricsWindow` / `installLyricsPowerWatch`）
 * 设计参考：byl669/legado-lyrics-overlay（GPL-3.0）
 *   app/src/main/java/io/legado/app/service/ReadAloudLyricsWindow.kt
 * 修改：Android `TYPE_APPLICATION_OVERLAY` 悬浮窗 → Electron 独立无边框透明置顶 BrowserWindow；
 *   显隐门槛收敛到 `desktop-lib.lyricsShouldShow()` 单一出口；位置落桌面偏好而非系统悬浮窗参数。
 *
 * 悦读桌面端（Electron 封装）
 * 启动流程：探测内置服务(3000) → 未启动则拉起 bundle server → 就绪后开窗加载。
 * 加固：服务日志落盘 server.log；加载失败显示离线页并自动重试；崩溃自动重启服务。
 *
 * ## `#209`（PC 端专属）在本文件里加了四件事
 * · **托盘**：托盘菜单 + 「点 X 收进托盘」/「最小化到托盘」两个开关 + 首次气泡提示；
 * · **全局快捷键**：切换主窗口显隐，**注册失败如实上报**（托盘菜单上直接挂一条，不只写日志）；
 * · **文件关联**：双击 txt/epub 打开 → 单实例转发 → 交渲染进程按既有不变量导入并阅读；
 *   HKCU 注册/注销，**刻意不劫持 .txt/.epub 的默认打开程序**；
 * · **开机自启**：`setLoginItemSettings`（便携版必须指向 `PORTABLE_EXECUTABLE_FILE`）。
 *
 * ★ 可分判定的**纯逻辑**（偏好归一 / argv 取文件 / 注册表计划 / 托盘菜单结构）全在
 *   `./desktop-lib.js`，由 `tests/desktop-lib.test.mjs` 真跑（`node --test`）。
 *   原因：本机（Agent 沙箱）**起不了 Electron**（无桌面会话，进程秒退无输出）⇒
 *   把「能证的部分」与「只能靠真机证的部分」分开，别把前者也变成不可验证的黑盒。
 *
 * ## `#453`（D13 = A+B）在本文件里加的一件事：**内嵌真浏览器**
 * · 常驻 `WebContentsView` 池（按会话键 / partition 隔离）：渲染桥不再「每次现起现停」，
 *   登录态与 cookie 留得住；界面还能把它挂进主窗口当内嵌浏览器用（跳转 / 返回走 Chromium 原生）。
 * · 池的**决策**（键归一 / partition 命名 / TTL+LRU / bounds 夹取）在 `./lib-webview-pool.js`（可单测）。
 * · 拿不到 `WebContentsView`（Electron < 30）⇒ 全部回落（前端 iframe + 此处一次性窗口渲染）。
 * · `will-navigate` / `setWindowOpenHandler` **只拦不判**：同站判据只有前端 `source-site.ts` 一份。
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, ipcMain, session, shell,
  Tray, Menu, nativeImage, globalShortcut, dialog,
  // 桌面朗读歌词：屏幕工作区与锁屏/休眠事件（老版本/测试桩可能为 undefined）
  screen, powerMonitor,
  // `#453`：内嵌真浏览器（Electron ≥30 才有；老版本为 undefined ⇒ 一律走回落分支）
  WebContentsView,
} = require('electron');
const lib = require('./desktop-lib');
const viewpoolLib = require('./lib-webview-pool');
// 启动期崩溃落盘（桌面端黑屏时排查用）
process.on('uncaughtException', (e) => {
  try { require('node:fs').appendFileSync(path.join(os.tmpdir(), 'yuedu-main-crash.log'), new Date().toISOString() + ' ' + String(e && e.stack || e) + String.fromCharCode(10)); } catch { /* ignore */ }
});
process.on('unhandledRejection', (e) => {
  try { require('node:fs').appendFileSync(path.join(os.tmpdir(), 'yuedu-main-crash.log'), new Date().toISOString() + ' [rejection] ' + String(e && e.stack || e) + String.fromCharCode(10)); } catch { /* ignore */ }
});
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');

/**
 * 本地服务端口：环境变量 `PORT` 最高优先；否则用桌面偏好 `serverPort`（默认 3100）。
 * 必须**运行期**解析：端口可由设置页修改，模块顶层只能先放一个占位默认值。
 */
let PORT = Number(process.env.PORT) || 3100;
let URL_BASE = `http://127.0.0.1:${PORT}`;
/**
 * 服务壳模式判定（唯一发布形态：一份 `YueDu.exe`）：
 * · 正式入口：`YueDu.exe --server-only`（由首次运行自建的「悦读服务」快捷方式传入）；
 * · 开发/调试：`electron . --server-only`。
 * `packagedMode` 是**历史兼容**：2026-11-24 的独立服务端打包目标曾用
 * `extraMetadata.yueduShellMode='server'` 写进打包后的 package.json；该目标已于
 * 2026-11-27 退场，这里保留读取只为兼容旧安装包，新包不再产生该字段。
 */
let packagedMode = '';
try {
  // 用 fs 读而不是 require：package.json 由 electron-builder 注入 extraMetadata，且不列进 build.files
  packagedMode = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).yueduShellMode || '');
} catch { /* 读不到就按普通桌面端 */ }
const SERVER_ONLY = lib.isServerOnlyArgv(process.argv)
  || packagedMode === 'server'
  || (typeof app.commandLine?.hasSwitch === 'function' && app.commandLine.hasSwitch('server-only'));
/** 形态默认端口：PC 客户端 3100 / 独立服务端 3000（偏好里的 0 表示「跟随形态默认」） */
const DEFAULT_PORT = lib.defaultPortForMode(SERVER_ONLY);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
/**
 * 桌面歌词的开关优先级（便携端可用，见 `desktop-lib.resolveLyricsEnabled`）：
 * `YUEDU_LYRICS` > 便携 exe 同目录的 `lyrics-off.txt`/`lyrics-on.txt` > 桌面偏好 > 默认 false。
 * 这里**不缓存**结果：env 与旗标文件都可能在运行中被改，每次重算并打一行来源日志。
 */
let lyricsGate = { enabled: false, source: 'default', forced: false, conflict: false, reason: '', dir: '' };
/** 用户在本轮点了歌词窗「关闭」⇒ 即使外部配置强制开，也不再弹（重启后恢复） */
let lyricsDismissed = false;
/** `msg(e)`：错误转一行可读文本（本文件里到处要它，避免各写一遍 `e && e.message`） */
const msg = (e) => String((e && e.message) || e || '未知错误');
// 惰性求值：普通 node 直接 require 本文件时 app 为 undefined（语法检查场景）
let __logFile;
function logFile() {
  if (!__logFile) {
    try { __logFile = path.join(app.getPath('userData'), 'server.log'); } catch { __logFile = path.join(__dirname, 'server.log'); }
  }
  return __logFile;
}
let serverProc = null;
let mainWindow = null;
/** 真退出标记：`close` 拦截必须放行（否则点「退出」只会把窗口再收进托盘） */
let quitting = false;

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(logFile(), line); } catch { /* ignore */ }
  process.stdout.write(line);
}

/* =========================================================================
 * 桌面偏好（托盘/快捷键开关）—— 文件位置与 cookies 同策略
 * ========================================================================= */

/**
 * 偏好落盘位置：`YUEDU_DESKTOP_PREFS` 覆盖 > 打包态 `userData` > 开发态仓库 `data/`。
 *
 * 为什么打包态用 `userData` 而不是 exe 同目录：electron-builder 的 `portable` 目标
 * 每次启动都把程序解压到**新的随机 %TEMP% 目录**（`process.execPath` 指向临时目录），
 * 往那儿写等于每次开机配置都清零。`app.getPath('userData')` 在便携版下仍是
 * `%APPDATA%\<productName>`（持久）。依据：electron-builder issue #8739 的实测日志。
 */
let __prefsFile;
function desktopPrefsFile() {
  if (!__prefsFile) {
    const override = process.env.YUEDU_DESKTOP_PREFS;
    if (override) __prefsFile = override;
    else if (app.isPackaged) __prefsFile = path.join(app.getPath('userData'), 'desktop-prefs.json');
    else __prefsFile = path.join(REPO_ROOT, 'data', 'desktop-prefs.json');
  }
  return __prefsFile;
}

let prefs = { ...lib.DEFAULT_PREFS };
let prefsWarnings = [];
/** 本次启动前偏好文件是否存在（服务壳首次运行要给可发现的设置入口） */
let firstRun = false;

function loadPrefs() {
  prefsWarnings = [];
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(desktopPrefsFile(), 'utf8'));
  } catch (e) {
    // ENOENT = 第一次运行，**不是**错误，不要打扰用户；其余（JSON 坏了/权限）必须说
    if (!e || e.code !== 'ENOENT') prefsWarnings.push(`读取桌面端设置失败（${msg(e)}）⇒ 本次用默认值`);
    else firstRun = true;
  }
  const n = lib.normalizePrefs(raw);
  prefs = n.prefs;
  // 端口也要跟着偏好走（env PORT 仍然最高优先）
  applyServerAddress();
  // 归一告警 + 读取告警都留痕（铁律 3：静默兜底 = 反复出现形同问题的温床）
  prefsWarnings = [...prefsWarnings, ...n.warnings];
  // 外部配置（env / 便携旗标）在偏好之上再生效；来源日志见 [lyrics]
  resolveLyricsGate();
  refreshGateWarning();
  for (const w of prefsWarnings) log('[desktop-prefs]', w);
}

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(desktopPrefsFile()), { recursive: true });
    fs.writeFileSync(desktopPrefsFile(), JSON.stringify(prefs, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    log('[desktop-prefs] 写入失败', desktopPrefsFile(), msg(e));
    return { ok: false, error: msg(e) };
  }
}

/**
 * 便携旗标文件所在目录。
 *
 * 便携版每次启动都解压到随机 `%TEMP%`（`process.execPath` 指向临时目录），
 * 所以**必须**用 electron-builder 注入的 `PORTABLE_EXECUTABLE_FILE` 找用户双击的原始 exe；
 * 开发态回落到仓库根，方便本地 `lyrics-off.txt` 自测。
 * （仓库没有 `portable.txt → 数据同目录` 的既有约定，这里不新造数据目录，只读旗标。）
 */
function lyricsFlagDir() {
  const p = process.env.PORTABLE_EXECUTABLE_FILE;
  if (p) {
    try { return path.dirname(p); } catch { /* 坏路径 ⇒ 回落 */ }
  }
  if (app.isPackaged) {
    try { return path.dirname(app.getPath('exe')); } catch { /* 回落 */ }
  }
  return REPO_ROOT;
}

/**
 * 重算歌词开关的优先级链并留一行来源日志（用户自查「为什么没弹窗」就看这行）。
 * 结果放 `lyricsGate`，**不写回** `prefs.lyricsEnabled` —— 持久化的用户选择要保住：
 * 删掉旗标/环境变量后，设置页里原来的开关仍然有效。
 */
function resolveLyricsGate() {
  const dir = lyricsFlagDir();
  const has = (name) => {
    try { return fs.existsSync(path.join(dir, name)); } catch { return false; }
  };
  const r = lib.resolveLyricsEnabled({
    envRaw: process.env.YUEDU_LYRICS,
    flagOff: has(lib.LYRICS_FLAG_FILES.off),
    flagOn: has(lib.LYRICS_FLAG_FILES.on),
    prefsEnabled: prefs.lyricsEnabled === true,
  });
  lyricsGate = { ...r, dir };
  log(`[lyrics] source=${r.source} enabled=${r.enabled}${r.reason ? ` (${r.reason})` : ''}${r.conflict ? ' [conflict]' : ''}`);
  return lyricsGate;
}

/** 外部配置生效时给设置页一句可自查的提示（并进 `prefsWarnings`） */
function lyricsGateWarning() {
  if (!lyricsGate.forced) return null;
  if (lyricsGate.conflict) return '桌面歌词：同时发现 lyrics-off.txt 与 lyrics-on.txt ⇒ 已按关闭处理（删掉其中一个即可）';
  return `桌面歌词已被外部配置${lyricsGate.enabled ? '强制开启' : '强制关闭'}（${lyricsGate.reason}；目录 ${lyricsGate.dir}）`;
}

/** 重算告警里的「外部配置」那一条：不重复累积，也不让旧结论留着骗人 */
function refreshGateWarning() {
  prefsWarnings = prefsWarnings.filter((w) => !/^桌面歌词(已被外部配置|：同时发现)/.test(w));
  const w = lyricsGateWarning();
  if (w) prefsWarnings.push(w);
}

/** 发给界面/歌词窗的开关值：外部配置 + 本轮「关闭」都要算进去 */
function lyricsEnabled() {
  return lyricsGate.enabled === true && !lyricsDismissed;
}

/** 界面拿到的偏好：`lyricsEnabled` 用**生效值**（而不是持久化值），否则开关会骗人 */
function prefsForUi() {
  return { ...prefs, lyricsEnabled: lyricsEnabled() };
}

/* =========================================================================
 * 桌面朗读歌词（Electron 独立置顶窗）
 *
 * 参照 `byl669/legado-lyrics-overlay`（GPL-3.0）的
 * `ReadAloudLyricsWindow`：数据口径（当前句 + 句内进度）、单一显隐出口
 * `canShow()`、文字恒不透明只让背景带 alpha。Android 的
 * `TYPE_APPLICATION_OVERLAY` 在这里换成 Electron 的 `transparent + alwaysOnTop`
 * BrowserWindow；不引入任何第三方悬浮窗依赖。
 * ========================================================================= */

/** 歌词窗渲染进程；按需创建，隐藏不销毁（位置与 DOM 都留着，回来更快） */
let lyricsWin = null;
let lyricsReady = false;
/** 渲染进程上报的朗读状态（白名单结构，见 desktop-lib.normalizeLyricsState） */
let lyricsState = lib.normalizeLyricsState(null);
/** 锁屏/休眠期间强制隐藏；`powerMonitor` 不可用时保持 false */
let lyricsLocked = false;
let floatGeoTimer = null;
/** 歌词设置面板开合（面板装不进三行高，敞着时主进程临时加高） */
const FLOAT_PANEL_EXTRA_H = 168;
let floatPanelOpen = false;
/** 面板打开时渲染层实测的高度（字号变化要沿用它，否则面板下半截会被裁） */
let floatPanelExtra = 0;
/** 渲染层实测的歌词内容高度（长句换行后大于静态三行估算；0 = 还没量过） */
let floatFitHeight = 0;
/** 渲染层实测的条形内容高度（三行按宽折行后的真实高度；0 = 还没量过） */
let floatBarFitHeight = 0;
/** 程序性 setBounds 期间不要回写位置，否则「重置位置」刚清成 null 又被写成默认坐标 */
let lyricsApplyingBounds = false;

/**
 * 同一扇浮窗的两种形态（用户 2026-11-08 授权合并）：
 * · `lyrics`  —— 朗读时显示「上一句 / 当前句 / 下一句」（既有行为，不回归）；
 * · `reading` —— 小窗·条形档，显示阅读正文流（不朗读）。
 * 位置 / 穿透 / 滚动速度 / 关闭交互是同一套；内容源只切换。
 */
/* ---- 浮窗（独立无边框窗）：歌词 / 常规 / 条形三个内容源，共用一扇窗 ----
 * 用户 2026-11-09 拍板：取消「迷你」，常规态也不再拿主窗变形 ⇒
 * 进入浮窗阅读 = 主窗 hide() + 浮窗显示；退出 = 浮窗 hide() + 主窗 show()，
 * 主窗几何全程不被碰（所以不需要快照/恢复/透明度遮闪那一整套）。 */
let floatMode = 'lyrics';
/** 阅读浮窗是否打开（regular / bar）；lyrics 形态不受它控制 */
let floatOpen = false;
/** 阅读正文流（常规 / 条形共用，阅读页推送，主进程只做白名单归一与转发） */
let floatReading = lib.normalizeFloatReadingState(null);
/**
 * 歌词形态是否被用户手动拉过尺寸（未锁定期间「以用户尺寸为准，不再按内容自动量高」）。
 * 复位点：锁定窗口 / 切走歌词形态 / 退出浮窗 —— 之后重新按内容量高。
 */
let floatLyricsUserSized = false;
/**
 * 上次真正落到窗口上的穿透值与最小尺寸。
 * Windows 上对**已可见**窗口重复调 `setIgnoreMouseEvents` / `setMinimumSize` 会触发
 * 非客户区重算（表现为窗口顶端多出一条原生标题样式的横条），因此值不变就不再调。
 */
let floatIgnoreApplied = null;
/** 常规态「进工具条热区 ⇒ 强落可交互」的节流时间戳（见 `yuedu:float-hover`） */
let floatHoverHealAt = 0;
let floatMinApplied = '';

/** 正常窗的原生标题栏控件（浮窗是独立无边框窗，自己画工具条） */
const TITLE_BAR_OVERLAY_NORMAL = Object.freeze({ color: '#16161A', symbolColor: '#E6E6E6', height: 32 });

/** 浮窗需要的外观/行为字段（三态共用一份；只作用于背景的 alpha 与文字颜色/字号） */
function floatPrefsPayload() {
  // ★ 只有条形档允许「点击穿透」：常规态要滚动正文、歌词态要拖动/点按钮，
  //   一旦整窗 `setIgnoreMouseEvents(true)`，滚轮与滚动条都收不到（用户实测：
  //   点锁定后正文滚不动）。常规/歌词的顶部 🔒 改为「锁窗口拖动」，不再碰穿透。
  const clickThrough = floatMode === 'bar' && prefs.floatClickThrough === true;
  return {
    fontSize: prefs.floatFontSize,
    textColor: prefs.floatTextColor,
    bgColor: prefs.floatBgColor,
    bgOpacity: prefs.floatBgOpacity,
    showNeighbors: prefs.floatShowNeighbors === true,
    dragLocked: prefs.floatDragLocked === true,
    speed: prefs.floatSpeed,
    speedMs: lib.BAR_SPEED_MS[prefs.floatSpeed] || lib.BAR_SPEED_MS[2],
    // 色板与 Web 同源（float-geometry.json）：渲染层不再自带一份十六进制表
    palette: lib.FLOAT_PALETTE,
    clickThrough,
    // Linux 的 `forward` 不可靠 ⇒ 渲染层据此禁用穿透开关（平台分叉，只此一处）
    clickThroughSupported: process.platform !== 'linux',
  };
}

function lyricsWorkArea(bounds, x, y) {
  try {
    const display = bounds && screen?.getDisplayMatching
      ? screen.getDisplayMatching(bounds)
      : screen?.getDisplayNearestPoint
        ? screen.getDisplayNearestPoint({ x: Number(x) || 0, y: Number(y) || 0 })
        : screen?.getPrimaryDisplay?.();
    if (display?.workArea) return display.workArea;
  } catch { /* 无桌面会话/测试桩 */ }
  return { x: 0, y: 0, width: 1280, height: 800 };
}

/** 条形档宽度：阅读面板最大 920；主窗从未被缩过，直接拿它的宽度即可 */
function floatPreferredWidth() {
  const b = safeBounds(mainWindow);
  return Math.min(lib.FLOAT_BAR_SIZE.width, Math.max(lib.FLOAT_BAR_MIN_SIZE.width, b?.width ?? lib.FLOAT_BAR_SIZE.width));
}

/** 当前浮窗形态的目标矩形（歌词/常规 = 居中或记忆位置；条形 = 阅读宽度 / 底部居中） */
function floatBoundsForMode() {
  const current = lyricsWin && !lyricsWin.isDestroyed() ? lyricsWin.getBounds() : null;
  const wa = lyricsWorkArea(current, current?.x, current?.y);
  if (floatMode === 'regular') return lib.floatRegularBoundsFromPrefs(prefs, wa);
  if (floatMode === 'bar') return lib.floatBarBoundsFromPrefs(prefs, wa, floatPreferredWidth());
  return lib.lyricsBoundsFromPrefs(prefs, wa);
}

/**
 * 唯一落穿透值的入口（值不变不重复调）：Windows 上对已可见窗口反复
 * `setIgnoreMouseEvents` 会触发分层/非客户区重算，是顶部横条的嫌疑路径之一。
 *
 * `force` 只给「窗口刚重新亮相」这种极少数时机用：值没变也重落一次。窗口隐藏期间
 * 若 Windows 侧留下了 `WS_EX_TRANSPARENT`，常规态就会「工具条能浮现但整条点不动」
 * ——forward 转发的是 move（hover 照常有），click 却被整窗吞掉；靠这一步兜住。
 */
function setFloatIgnore(ignore, force) {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  const v = ignore === true;
  if (!force && floatIgnoreApplied === v) return;
  // forward 只在该形态真的可能要转发 move 时才开：条形档（穿透时可 hover 收回交互）。
  // 常规/歌词恒可交互，没有转发需求 —— 一直挂着全局鼠标钩子只会多一条被系统吞点击的路径。
  const forward = v || floatMode === 'bar';
  try {
    lyricsWin.setIgnoreMouseEvents(v, { forward });
    if (floatIgnoreApplied !== v) {
      log(`[float] 穿透 ${floatIgnoreApplied === null ? '(默认)' : floatIgnoreApplied} → ${v} forward=${forward} mode=${floatMode}${force ? ' force' : ''}`);
    }
    floatIgnoreApplied = v;
  } catch { /* 旧 Electron 忽略 */ }
}

/** 穿透只对条形档生效；常规/歌词恒为可交互（否则正文滚轮、按钮都收不到） */
function applyFloatClickThrough(options) {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  setFloatIgnore(floatMode === 'bar' && prefs.floatClickThrough === true, options?.force === true);
}

function sendFloatUpdate(extra) {
  try {
    if (!lyricsWin || lyricsWin.isDestroyed() || !lyricsReady) return;
    lyricsWin.webContents.send('yuedu:float-update', {
      mode: floatMode,
      state: lyricsState,
      reading: floatReading,
      prefs: floatPrefsPayload(),
      ...(extra || {}),
    });
  } catch { /* 窗口正在销毁 */ }
}

/**
 * 歌词窗的「内容基准高」：静态三行估算与渲染层实测取大。
 * 长句换行后实测更高 ⇒ 不许被静态值缩回去（面板加高也以此为基础）。
 */
function lyricsBaseHeight() {
  const base = lib.lyricsWindowHeight(prefs.floatFontSize, prefs.floatShowNeighbors === true);
  return floatFitHeight > base ? floatFitHeight : base;
}

/**
 * 字号 / 「前后句显隐」变化 ⇒ 歌词窗高度跟着变：底边保持不动、向上长，
 * 保证三行文字刚好装下（Web 侧小窗同一口径）。返回是否真的改了几何。
 */
function refreshLyricsWindowHeight(prevFontSize, prevShowNeighbors) {
  if (floatMode !== 'lyrics' || !lyricsWin || lyricsWin.isDestroyed()) return false;
  // 未锁定且用户手动拉过尺寸 ⇒ 以用户尺寸为准，字号/前后句变化也不再改窗高
  if (floatLyricsUserSized && prefs.floatDragLocked !== true) return false;
  const changed = prefs.floatFontSize !== prevFontSize
    || (prefs.floatShowNeighbors === true) !== (prevShowNeighbors === true);
  if (!changed) return false;
  // 字号 / 前后句显隐变了 ⇒ 上一次的实测高作废（行高已变，它不再对应当前内容）；
  // 先按静态三行估算改窗，渲染层收到新外观后会把真实内容高再报一次。
  floatFitHeight = 0;
  try {
    const b = lyricsWin.getBounds();
    // 设置面板敞着时改字号：加高量要保留，否则面板下半截会被裁掉
    const extra = floatPanelOpen
      ? (floatPanelExtra > 0 ? floatPanelExtra : FLOAT_PANEL_EXTRA_H)
      : 0;
    const height = lyricsBaseHeight() + extra;
    lyricsApplyingBounds = true;
    lyricsWin.setBounds({ x: b.x, y: Math.max(0, b.y + b.height - height), width: b.width, height });
    setTimeout(() => { lyricsApplyingBounds = false; }, 300);
    return true;
  } catch { return false; }
}

/** 把偏好里的位置落到窗口上（重置位置 / 改分辨率后调用） */
function applyFloatPosition() {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  const bounds = floatBoundsForMode();
  lyricsApplyingBounds = true;
  try { lyricsWin.setBounds(bounds); } catch { /* ignore */ }
  setTimeout(() => { lyricsApplyingBounds = false; }, 300);
}

/** 保证浮窗存在并切到指定形态（`lyrics` / `regular` / `bar`） */
function ensureFloatWindow(mode) {
  floatMode = mode === 'regular' || mode === 'bar' ? mode : 'lyrics';
  applyFloatWindowSize();
  if (lyricsWin && !lyricsWin.isDestroyed()) return lyricsWin;
  return createFloatWindow();
}

/**
 * 常规/条形可缩放；歌词恒为 `resizable:false`。
 *
 * 歌词的「手动调宽高」不走系统缩放：浮窗是透明无边框窗，Windows 上 `GWL_STYLE`
 * 里连 `WS_THICKFRAME` 都没有（实测 STYLE=0x14000000）⇒ 原生的缩放边框根本不存在，
 * 置 `resizable:true` 也拉不动，反而会在已可见窗口上触发一次原生框架重算
 * （顶部「悦读 · 浮条」横条的嫌疑路径）。所以歌词改由渲染层贴边发增量、
 * 主进程 `yuedu:float-resize` 自己 `setBounds`（见该 IPC）。
 */
function applyFloatWindowSize() {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  const wantResizable = floatMode !== 'lyrics';
  const min = floatMode === 'lyrics'
    ? { width: 320, height: 48 }
    : floatMode === 'bar'
      ? lib.FLOAT_BAR_MIN_SIZE
      : lib.FLOAT_MIN_SIZE;
  try {
    /**
     * ★ 只在值真的变化时才调 `setResizable` / `setMinimumSize`。
     * 这两者在 Windows 上都会让已可见的窗口重算一次原生框架（非客户区），
     * 首次切形态时顶部冒出的「悦读 · 浮条」横条就是这类重算留下的残影；
     * 第二次切换时值已相同 ⇒ 不再发生，横条消失。
     */
    let current = null;
    try { current = lyricsWin.isResizable(); } catch { current = null; }
    if (current !== wantResizable) lyricsWin.setResizable(wantResizable);
    const key = `${min.width}x${min.height}`;
    if (floatMinApplied !== key) {
      lyricsWin.setMinimumSize(min.width, min.height);
      floatMinApplied = key;
    }
  } catch { /* ignore */ }
}

/** 把当前形态的几何写进对应前缀（退出/切形态前必须调用） */
function persistFloatGeometryNow() {
  const b = safeBounds(lyricsWin);
  if (!b) return;
  if (floatMode === 'regular') {
    prefs.floatRegularX = b.x;
    prefs.floatRegularY = b.y;
    prefs.floatRegularW = b.width;
    prefs.floatRegularH = b.height;
  } else if (floatMode === 'bar') {
    prefs.floatBarX = b.x;
    prefs.floatBarY = b.y;
    prefs.floatBarW = b.width;
    prefs.floatBarH = b.height;
  } else {
    // 歌词形态宽高由内容高度决定，只记位置
    prefs.floatLyricsX = b.x;
    prefs.floatLyricsY = b.y;
  }
  savePrefs();
}

function scheduleFloatGeometrySave() {
  if (floatGeoTimer) clearTimeout(floatGeoTimer);
  floatGeoTimer = setTimeout(() => {
    floatGeoTimer = null;
    if (lyricsWin && !lyricsWin.isDestroyed()) persistFloatGeometryNow();
  }, 250);
}

function createFloatWindow() {
  if (!screen) return null; // 普通 node/测试桩：没有桌面会话就绝不建窗
  try {
    const preview = floatBoundsForMode();
    lyricsWin = new BrowserWindow({
      ...preview,
      title: '悦读 · 浮窗',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      // ★ 按目标形态给 resizable：常规/条形可缩放；歌词恒不可缩放（改用贴边增量缩放）
      resizable: floatMode !== 'lyrics',
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      // 不抢焦点：用户在其他应用里操作时，点浮窗按钮也不应把主窗口/前台应用顶走。
      // ★ 唯一例外：若实测某个 Windows 版本在 focusable:false 时不派发滚轮，只对
      //   `regular` 临时 setFocusable(true)（目前未触发，见 tests/main-smoke.test.mjs）。
      focusable: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'lyrics-preload.js'),
        backgroundThrottling: false,
      },
    });
    lyricsWin.setAlwaysOnTop(true, 'screen-saver');
    lyricsReady = false;
    // 新窗的穿透/最小尺寸都没应用过，缓存要作废（否则旧值会让 apply* 误判为「值没变」）
    floatIgnoreApplied = null;
    floatMinApplied = '';
    /**
     * ★ 趁窗口还没显示（`showInactive()` 之前）把最小尺寸/穿透落下去：
     * 这两步是「首次可见帧」的原生状态来源；did-finish-load 晚于 show，只做兜底。
     * 注：实测（release-825 隔离实例）在**已可见**的无边框透明窗上补调
     * setMinimumSize / setIgnoreMouseEvents(false) / setResizable 不会产生非客户区
     * （ncTop/ncH 恒 0、contentBounds==bounds），所以「常规态顶部横条」不能归因到这里；
     * 这里只是让首帧状态更确定。
     */
    applyFloatWindowSize();
    applyFloatClickThrough();
    lyricsWin.loadFile(path.join(__dirname, 'lyrics.html')).catch((e) => log('[float] 页面加载失败：', msg(e)));
    lyricsWin.webContents.on('did-finish-load', () => {
      lyricsReady = true;
      applyFloatWindowSize();
      applyFloatClickThrough();
      sendFloatUpdate();
    });
    // 拖动/缩放后落盘（250ms 防抖；程序性 setBounds 不算用户操作）。
    // ★ 同一扇窗三种形态：歌词记 `floatLyricsX/Y`，常规/条形各记自己的 X/Y/W/H。
    // ★ 歌词形态未锁定时被用户拉起尺寸 ⇒ 记下来，之后不再按内容自动量高（见 float-height）。
    for (const ev of ['move', 'resize']) {
      lyricsWin.on(ev, () => {
        if (lyricsApplyingBounds) return;
        if (ev === 'resize' && floatMode === 'lyrics' && prefs.floatDragLocked !== true) {
          floatLyricsUserSized = true;
        }
        scheduleFloatGeometrySave();
      });
    }
    lyricsWin.on('closed', () => { lyricsWin = null; lyricsReady = false; });
    return lyricsWin;
  } catch (e) {
    lyricsWin = null;
    lyricsReady = false;
    log('[float] 创建失败：', msg(e));
    return null;
  }
}

/**
 * 首次按「保存几何」亮相后，补一次原生重算。
 *
 * 实测（release-825、OS 真鼠标、单实例）：带 `floatRegularW/H`（302×908）启动时，
 * 常规态工具条**每个**按钮都是 `pointerdown=0 / pointerup+1 / click=0`、无任何 IPC；
 * 只要一次 `setBounds`（哪怕随后改回原尺寸）就恢复。干净偏好（默认 420×320）不复现。
 * 相同 bounds 会被 Electron 直接跳过、不产生 `SetWindowPos`，所以用 1px 往返逼出重算。
 * 只在**从隐藏到显示**的那一帧做，之后不再动（避免用户拖动时被拉回）。
 */
function reassertFloatBounds(win, target) {
  try {
    lyricsApplyingBounds = true;
    win.setBounds({ ...target, width: target.width + 1 });
    win.setBounds(target);
  } catch { /* ignore */ }
  // 同步放开：这里两次 setBounds 都是程序性；而事件异步派发时读到的已是最终 target，
  // 让它们照常走防抖落盘也不会写错值（早期用 300ms 定时器会吞掉紧随其后的用户拖动）
  lyricsApplyingBounds = false;
}

/**
 * 唯一的显隐出口：暂停/主窗口回焦/锁屏/关开关都只改条件，最后都走这里。
 * 不再在多个事件里各写一份 `show()/hide()`。
 */
function syncLyricsWindow() {
  /**
   * 阅读浮窗（常规 / 条形）：浮窗此时**不是歌词**，而是阅读正文。
   * 它不受歌词开关 / 朗读状态 / 主窗焦点约束 —— 进入浮窗已停朗读，这是「继续看书」的形态。
   */
  if (floatOpen) {
    const win = ensureFloatWindow(floatMode === 'bar' ? 'bar' : 'regular');
    if (!win || win.isDestroyed()) return;
    const target = floatBoundsForMode();
    try {
      const b = win.getBounds();
      if (!win.isVisible() || b.x !== target.x || b.y !== target.y || b.width !== target.width || b.height !== target.height) {
        lyricsApplyingBounds = true;
        win.setBounds(target);
        setTimeout(() => { lyricsApplyingBounds = false; }, 300);
      }
    } catch { /* ignore */ }
    const wasHidden = !win.isVisible();
    // 每次重新亮相都强落一次（常规/歌词恒 false）：见 setFloatIgnore 的 force 说明。
    // ★ 必须排在 showInactive 之前：这是一扇无边框透明窗，在**可见态**改 EXSTYLE 会触发
    //   非客户区重算，历史上表现为窗口顶端冒出带标题的原生横条（44805b8）；隐藏态应用不碰可见窗。
    applyFloatClickThrough({ force: wasHidden });
    if (wasHidden) {
      win.showInactive();
      reassertFloatBounds(win, target);
    }
    sendFloatUpdate();
    return;
  }

  // 退出阅读浮窗：同一扇窗换回歌词形态（隐藏后由下面的歌词门槛决定是否再出现）
  if (floatMode !== 'lyrics') {
    floatMode = 'lyrics';
    floatPanelOpen = false; // 阅读形态没有设置面板；换回歌词时按「面板关着」算高度
    floatPanelExtra = 0;
    floatFitHeight = 0; // 歌词实测高度只对上一次歌词内容有效，回来重新量
    applyFloatWindowSize();
    applyFloatClickThrough();
    try { if (lyricsWin && !lyricsWin.isDestroyed() && lyricsWin.isVisible()) lyricsWin.hide(); } catch { /* ignore */ }
  }

  const shouldShow = lib.lyricsShouldShow({
    enabled: lyricsEnabled(),
    active: lyricsState.active,
    hasContent: lyricsState.hasContent,
    screenLocked: lyricsLocked,
    floatReading: floatOpen,
  });
  if (!shouldShow) {
    floatPanelOpen = false; // 窗都藏了 ⇒ 面板开合状态一并复位（下次显示按三行高度）
    try {
      if (lyricsWin && !lyricsWin.isDestroyed() && lyricsWin.isVisible()) lyricsWin.hide();
    } catch { /* ignore */ }
    return;
  }
  const win = lyricsWin && !lyricsWin.isDestroyed() ? lyricsWin : createFloatWindow();
  if (!win || win.isDestroyed()) return;
  const wasHidden = !win.isVisible();
  // 从阅读形态切回歌词时，穿透可能还停在 true ⇒ 歌词形态必须始终可点。
  // 与阅读分支同理：先在隐藏态落穿透，再 showInactive，避免在可见窗上碰 EXSTYLE。
  applyFloatClickThrough({ force: wasHidden });
  if (wasHidden) {
    win.showInactive();
    reassertFloatBounds(win, win.getBounds());
  }
  sendFloatUpdate();
}

/** 锁屏/休眠隐藏 + 恢复后按状态回来（Windows 上 powerMonitor 可用；测试桩没有就跳过） */
function installLyricsPowerWatch() {
  if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
  const setLocked = (v) => { lyricsLocked = v; syncLyricsWindow(); };
  powerMonitor.on('lock-screen', () => setLocked(true));
  powerMonitor.on('unlock-screen', () => setLocked(false));
  powerMonitor.on('suspend', () => setLocked(true));
  powerMonitor.on('resume', () => setLocked(false));
}

/* =========================================================================
 * 浮窗阅读（独立无边框窗，两态：常规 / 条形）
 *
 * 与旧的「主窗变形」根本区别（用户 2026-11-09 拍板）：
 *  ① 进入 = 主窗 `hide()` + 浮窗显示；退出 = 浮窗 `hide()` + 主窗 `show()`；
 *     主窗几何**全程不被碰** ⇒ 不需要任何几何快照 / 无闪恢复 / 渲染层小窗 CSS 注入
 *     （旧的「主窗变形」链路已整链删除）。
 *  ② 两态都是**同一扇浮窗**，只换内容源；歌词形态复用同一扇窗。
 *  ③ 形态本身不落盘：重启回正常主窗，只记两套几何。
 * ========================================================================= */

function safeBounds(win) {
  try { return win && !win.isDestroyed?.() ? win.getBounds() : null; } catch { return null; }
}

/** 浮窗运行态（不落盘形态本身：重启回正常主窗） */
function floatStatePayload() {
  const b = safeBounds(lyricsWin);
  return {
    ok: true,
    available: true,
    open: floatOpen,
    mode: floatOpen ? floatMode : 'lyrics',
    width: b?.width ?? null,
    height: b?.height ?? null,
    regularWidth: lib.FLOAT_REGULAR_SIZE.width,
    regularHeight: lib.FLOAT_REGULAR_SIZE.height,
    barWidth: lib.FLOAT_BAR_SIZE.width,
    barHeight: lib.FLOAT_BAR_SIZE.height,
    speed: prefs.floatSpeed,
    clickThrough: floatMode === 'bar' && prefs.floatClickThrough === true,
    clickThroughSupported: process.platform !== 'linux',
    normalMinWidth: lib.NORMAL_MIN_SIZE.width,
    normalMinHeight: lib.NORMAL_MIN_SIZE.height,
  };
}

/** 通过 preload 的 `onFloatState` 镜像到渲染层（渲染层不靠窗口宽度猜状态） */
function sendFloatState() {
  try {
    const w = mainWindow;
    if (w && !w.isDestroyed?.() && w.webContents && !w.webContents.isDestroyed?.()) {
      w.webContents.send('yuedu:float-state', floatStatePayload());
    }
  } catch { /* ignore */ }
}

/** 归一形态：'regular' | 'bar'；未知值按常规 */
function normalizeFloatMode(mode) {
  return mode === 'bar' ? 'bar' : 'regular';
}

/**
 * 进入浮窗阅读：主窗 hide + 浮窗显示（`mode` 默认常规）。
 * ★ 主窗几何**一点不动** —— 所以退出时只需 show()，没有快照/恢复/遮闪。
 */
function enterFloatReading(mode) {
  if (!mainWindow || mainWindow.isDestroyed?.()) {
    return { ok: false, open: false, mode: floatMode, reason: 'no-window' };
  }
  const target = normalizeFloatMode(mode);
  if (floatOpen) {
    if (target !== floatMode) return switchFloatMode(target);
    return floatStatePayload();
  }

  floatOpen = true;
  floatMode = target;
  // 离开歌词形态：歌词的实测高度/用户尺寸都不再适用（回来时按歌词形态重新算）
  floatFitHeight = 0;
  floatBarFitHeight = 0;
  floatPanelExtra = 0;
  floatLyricsUserSized = false;
  try { mainWindow.hide(); } catch { /* ignore */ }
  // ★ 窗口已可见时先藏，再改几何/风格，最后 showInactive（见 switchFloatMode 注释）
  hideFloatWindowForGeometryChange();
  syncLyricsWindow(); // 建/显浮窗、摆位置、应用穿透、推送正文

  sendFloatState();
  rebuildTrayMenu();
  return floatStatePayload();
}

/**
 * 切形态前把**已可见**的浮窗先藏起来：随后的 `setResizable` / `setMinimumSize` /
 * `setBounds` 都发生在窗口不可见时，Windows 不会为已可见窗口的原生框架重算
 * 留下一条「悦读 · 浮条」式的标题横条（实机 release-823：首次 常规→条 才有，
 * 第二次切换已无值变化所以不复现）。窗没显示时是空操作。
 */
function hideFloatWindowForGeometryChange() {
  try {
    if (lyricsWin && !lyricsWin.isDestroyed() && lyricsWin.isVisible()) lyricsWin.hide();
  } catch { /* ignore */ }
}

/** 在浮窗内切换形态（常规 ⇄ 条形） */
function switchFloatMode(mode) {
  const target = normalizeFloatMode(mode);
  if (!floatOpen) return enterFloatReading(target);
  if (target === floatMode) return floatStatePayload();

  // 切形态前先把**当前形态**的几何落盘
  persistFloatGeometryNow();
  if (floatGeoTimer) { clearTimeout(floatGeoTimer); floatGeoTimer = null; }

  // ★ 先藏窗再改几何/风格，最后由 syncLyricsWindow 里的 showInactive 重新亮相
  hideFloatWindowForGeometryChange();
  floatMode = target;
  // 形态变了 ⇒ 歌词/条形的实测高度都作废（新形态由渲染层重新上报）
  floatFitHeight = 0;
  floatBarFitHeight = 0;
  floatPanelExtra = 0;
  floatLyricsUserSized = false;
  syncLyricsWindow();

  sendFloatState();
  return floatStatePayload();
}

/** 退出浮窗阅读：浮窗 hide + 主窗 show（主窗几何从未被改，直接回来） */
function exitFloatReading() {
  if (!floatOpen) return floatStatePayload();
  persistFloatGeometryNow();
  if (floatGeoTimer) { clearTimeout(floatGeoTimer); floatGeoTimer = null; }
  floatOpen = false;

  try { if (lyricsWin && !lyricsWin.isDestroyed() && lyricsWin.isVisible()) lyricsWin.hide(); } catch { /* ignore */ }
  floatMode = 'lyrics';
  floatPanelOpen = false;
  floatPanelExtra = 0;
  floatFitHeight = 0;
  floatBarFitHeight = 0;
  floatLyricsUserSized = false; // 回到歌词形态：重新按内容量高
  applyFloatWindowSize();
  // 同一扇窗：把几何换回歌词形态（记忆位置 / 默认底部居中 + 按字号算高），
  // 否则下次歌词出现时会沿用条形态的 1000×160 大小。
  applyFloatPosition();
  applyFloatClickThrough();
  try { mainWindow.show(); } catch { /* ignore */ }
  try { mainWindow.focus(); } catch { /* ignore */ }

  syncLyricsWindow(); // 歌词若该显示会重新出现
  sendFloatState();
  rebuildTrayMenu();
  return floatStatePayload();
}

/** `mode` 省略=切换；'regular' / 'bar'=进入指定形态；false=退出 */
function toggleFloatReading(mode) {
  if (mode === false) return exitFloatReading();
  if (mode === 'regular' || mode === 'bar') return enterFloatReading(mode);
  return floatOpen ? exitFloatReading() : enterFloatReading('regular');
}

/* =========================================================================
 * 托盘
 * ========================================================================= */

let tray = null;
let trayError = '';
let trayHintInFlight = false;

function trayIconPath() {
  // 服务壳用带「S」角标的图标，任务栏里能和 PC 客户端区分开；缺图时回落通用图标
  if (SERVER_ONLY) {
    const s = path.join(__dirname, 'assets', 'tray-server.png');
    if (fs.existsSync(s)) return s;
  }
  return path.join(__dirname, 'assets', 'tray.png');
}

const TRAY_ACTIONS = {
  toggle: () => toggleMainWindow(),
  'open-ui': () => showMainWindow(),
  'open-local': () => { void openLocalBookDialog(); },
  'restart-server': () => { void restartServer('托盘菜单'); },
  'open-data-dir': () => { void shell.openPath(resolveDataDir()); },
  'auto-launch': () => {
    const on = !autoLaunchState().openAtLogin;
    const r = setAutoLaunch(on);
    if (!r.ok) notifyTray('开机自启设置失败', r.error || '未知错误');
    rebuildTrayMenu();
  },
  settings: () => openSettingsWindow(),
  quit: () => quitApp(),
};

function rebuildTrayMenu() {
  if (!tray) return;
  const spec = lib.trayMenuSpec({
    serverOnly: SERVER_ONLY,
    windowVisible: !!(mainWindow && mainWindow.isVisible()),
    shortcutEnabled: prefs.shortcutEnabled,
    shortcutOk: shortcutState.ok,
    shortcut: prefs.shortcut,
    autoLaunch: autoLaunchState().openAtLogin,
  });
  const template = spec.map((it) => {
    if (it.type === 'separator') return { type: 'separator' };
    const item = { label: it.label };
    if (it.type === 'checkbox') item.type = 'checkbox';
    if (it.type === 'checkbox') item.checked = !!it.checked;
    if (it.enabled === false) item.enabled = false;
    else item.click = TRAY_ACTIONS[it.id] || (() => log('[tray] 未处理的菜单项', it.id));
    return item;
  });
  try { tray.setContextMenu(Menu.buildFromTemplate(template)); } catch (e) { log('[tray] 菜单构建失败：', msg(e)); }
}

/** 托盘气泡（看门狗超限 / 托盘动作失败时用；托盘不存在就只落日志） */
function notifyTray(title, content) {
  log('[tray]', title, '·', content);
  if (!tray) return;
  try { tray.displayBalloon({ title, content }); } catch (e) { log('[tray] 气泡提示失败：', msg(e)); }
}

/**
 * 建托盘。
 *
 * ★ **图标缺失就直接不建托盘**（而不是建一个看不见的）：
 *   本文件会按 `closeToTray` 拦截窗口关闭 —— 若托盘不存在，用户把窗口收起来就**再也叫不回来**。
 *   宁可「没有托盘 + 窗口照常关」，也不要「有托盘逻辑但图标是空的」这个陷阱。
 *   同一原则用在 close/minimize 拦截上（见 createWindow：`!tray` 时不拦截）。
 */
function createTray() {
  if (tray) return tray;
  const icon = trayIconPath();
  if (!fs.existsSync(icon)) {
    trayError = `托盘图标不存在：${icon}`;
    log('[tray]', trayError, '⇒ 不建托盘（否则窗口收起来就找不回来了）');
    return null;
  }
  try {
    tray = new Tray(nativeImage.createFromPath(icon));
  } catch (e) {
    trayError = msg(e);
    log('[tray] 创建失败：', trayError);
    tray = null;
    return null;
  }
  tray.setToolTip(SERVER_ONLY ? '悦读服务 · YueDu' : '阅读 YueDu');
  /**
   * ★ 刻意**不绑单击 `click`**：Windows 上带 `setContextMenu` 的托盘图标，左键常常
   *   直接弹菜单（并可能同时派发 `click`）⇒ 绑了就会出现「点一下既弹菜单又切显隐」。
   *   双击是明确无歧义的「把窗口叫回来」。切显隐走菜单第一项。
   */
  tray.on('double-click', () => showMainWindow());
  rebuildTrayMenu();
  log('[tray] 就绪 · 图标', icon);
  return tray;
}

/* =========================================================================
 * 全局快捷键
 * ========================================================================= */

/** `ok` = `register()` 的返回值；`held` = `isRegistered()` 的独立复核（两个判据互为对偶） */
let shortcutState = { accelerator: '', enabled: false, ok: false, held: false, reason: '' };

function applyShortcut() {
  try { globalShortcut.unregisterAll(); } catch { /* 从没注册过也会走到这儿 */ }
  shortcutState = { accelerator: prefs.shortcut, enabled: prefs.shortcutEnabled, ok: false, held: false, reason: '' };
  if (!prefs.shortcutEnabled) {
    shortcutState.reason = '已在设置里关闭';
  } else {
    try {
      shortcutState.ok = globalShortcut.register(prefs.shortcut, () => toggleMainWindow()) === true;
      // 独立复核：register 说成功但 isRegistered 说没有 ⇒ 两者矛盾必须暴露（否则「有时灵有时不灵」）
      shortcutState.held = globalShortcut.isRegistered(prefs.shortcut) === true;
      if (!shortcutState.ok) shortcutState.reason = '注册被拒绝：该组合多半已被别的程序占用，换一个组合再试';
      else if (!shortcutState.held) shortcutState.reason = '注册返回成功但复核未持有（系统行为异常），快捷键可能时灵时不灵';
    } catch (e) {
      shortcutState.reason = '注册抛错：' + msg(e);
    }
  }
  if (shortcutState.enabled && (!shortcutState.ok || !shortcutState.held)) {
    log(`[shortcut] ${prefs.shortcut} 未生效 —— ${shortcutState.reason}`);
  }
  rebuildTrayMenu();
  return shortcutState;
}

/* =========================================================================
 * 窗口显隐（托盘 / 快捷键 / 菜单共用这三个入口）
 * ========================================================================= */

function showMainWindow() {
  // `--server-only` 没有主窗口：把界面交给系统默认浏览器（服务仍在本地监听）
  if (SERVER_ONLY) {
    if (typeof shell?.openExternal === 'function') {
      shell.openExternal(URL_BASE).catch((e) => log('[server-only] 打开界面失败：', msg(e)));
    }
    return;
  }
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  rebuildTrayMenu();
}

/** 收起窗口；`hint=true` 时首次弹一次托盘气泡（告诉用户「程序还在、去哪找」） */
function hideMainWindow(hint) {
  if (!mainWindow) return;
  mainWindow.hide();
  if (hint && tray && !prefs.trayHintShown) {
    prefs.trayHintShown = true;
    savePrefs();
    try {
      tray.displayBalloon({
        title: '阅读 YueDu 仍在运行',
        content: '窗口已收进托盘：双击托盘图标可以再打开，右键托盘图标可以退出。',
      });
    } catch (e) { log('[tray] 气泡提示失败：', msg(e)); }
  }
  rebuildTrayMenu();
}

function toggleMainWindow() {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) hideMainWindow(true);
  else showMainWindow();
}

function quitApp() {
  quitting = true;
  app.quit();
}

/* =========================================================================
 * 文件关联
 * ========================================================================= */

/** 便携版必须用原始 exe（`process.execPath` 指向解压出来的临时目录，下次就没了） */
function portableExe() {
  const p = process.env.PORTABLE_EXECUTABLE_FILE;
  try { return p && fs.existsSync(p) ? p : null; } catch { return null; }
}

function realExePath() {
  if (app.isPackaged) return portableExe() || app.getPath('exe');
  return process.execPath;
}

/**
 * 开发态**拒绝**注册（两个都拒：文件关联、开机自启）。
 *
 * 理由（不是偷懒）：注册表里会写成 `electron.exe`，双击 txt 只起一个**不带本应用**的空 Electron；
 * 开机自启同理 —— 开机后弹一个空白 Electron 比不弹更糟。要给用户的是**能用的**关联。
 */
function packagedOnlyGuard(what) {
  if (app.isPackaged) return null;
  return `开发态不注册${what}：注册表/启动项里会写成 electron.exe（双击 txt / 开机后起不来本应用）。请用打包版（release 目录里的 YueDu.exe），或命令行验证：electron . 你的书.txt`;
}

function runReg(args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn('reg.exe', args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out: '', err: msg(e) }); return; }
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => { out += String(d); });
    p.stderr?.on('data', (d) => { err += String(d); });
    p.on('error', (e) => resolve({ code: -1, out, err: msg(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 「找不到该项/该值」在不同语言的 Windows 上文案不同 ⇒ 用正则同时认中英 */
const REG_ABSENT_RE = /找不到|unable to find|无法找到/i;

/**
 * 写/删注册表。
 * ★ 一条失败就**停**：继续写下去只会留下「一半装了」的状态，比不装更难收拾。
 */
async function applyFileAssoc(enable) {
  const blocked = packagedOnlyGuard('文件关联');
  if (blocked) return { ok: false, supported: false, error: blocked };
  const exePath = realExePath();
  const plan = lib.planFileAssoc({ exePath, appName: '阅读 YueDu' });
  const ops = enable ? plan.install : plan.uninstall;
  const results = [];
  for (const op of ops) {
    const r = await runReg(lib.regArgsFor(op));
    const absent = REG_ABSENT_RE.test(r.out + r.err);
    // 卸载时「本来就没有」不算失败（用户可能从没注册过）
    const ok = r.code === 0 || (!enable && absent);
    results.push({ op: op.op, key: op.key, name: op.name ?? null, ok, code: r.code, detail: ok ? (absent && r.code !== 0 ? '该项本来就不存在' : '') : (r.err || r.out).trim().slice(0, 300) });
    if (!ok) {
      log('[file-assoc] 中止于', op.op, op.key, results[results.length - 1].detail);
      break;
    }
  }
  const failed = results.filter((x) => !x.ok);
  log(`[file-assoc] ${enable ? '注册' : '注销'} ${results.length}/${ops.length} 条，失败 ${failed.length}`);
  return { ok: failed.length === 0, supported: true, enabled: !!enable, exePath, total: ops.length, done: results.length, failed: failed.length, results };
}

/** 只**读**注册表（不写）：状态查询要能被界面/自检随便调，不能有副作用 */
async function queryFileAssoc() {
  const blocked = packagedOnlyGuard('文件关联');
  if (blocked) return { supported: false, registered: null, reason: blocked };
  const exePath = realExePath();
  const plan = lib.planFileAssoc({ exePath });
  const r = await runReg(['query', `${plan.appKey}\\shell\\open\\command`, '/ve']);
  const data = lib.parseRegQueryValue(r.out, null);
  return { supported: true, registered: data !== null && data.includes(exePath), exePath, command: data, progIds: plan.progIds };
}

/* ------------------------------------------------------------------ *
 * `yuedu://` / `legado://` 协议注册（`#347`：唤起导入链接的桌面端半边）
 * ------------------------------------------------------------------ */

/**
 * 注册/注销「一键导入」协议处理器。
 *
 * ★ 与 `applyFileAssoc` 同一套纪律（一条失败就停、卸载时「本来没有」不算失败）。
 * ★ **根因**：仓库此前只注册了**文件后缀**关联，没注册**协议** ⇒ 浏览器/分享页里点
 * `yuedu://import/bookSource?src=…` 时，Windows **根本不知道**该唤起谁 ⇒ 用户看到
 * 「链接点了没反应」。这里把 `HKCU\Software\Classes\<scheme>`（含判据值 `URL Protocol`）
 * 搭起来。
 */
async function applyProtocolAssoc(enable) {
  const blocked = packagedOnlyGuard('导入链接协议');
  if (blocked) return { ok: false, supported: false, error: blocked };
  const exePath = realExePath();
  const plan = lib.planProtocolAssoc({ exePath, appName: '阅读 YueDu' });
  const ops = enable ? plan.install : plan.uninstall;
  const results = [];
  for (const op of ops) {
    const r = await runReg(lib.regArgsFor(op));
    const absent = REG_ABSENT_RE.test(r.out + r.err);
    const ok = r.code === 0 || (!enable && absent);
    results.push({ op: op.op, key: op.key, name: op.name ?? null, ok, code: r.code, detail: ok ? (absent && r.code !== 0 ? '该项本来就不存在' : '') : (r.err || r.out).trim().slice(0, 300) });
    if (!ok) {
      log('[protocol-assoc] 中止于', op.op, op.key, results[results.length - 1].detail);
      break;
    }
  }
  const failed = results.filter((x) => !x.ok);
  log(`[protocol-assoc] ${enable ? '注册' : '注销'} ${results.length}/${ops.length} 条，失败 ${failed.length}`);
  return { ok: failed.length === 0, supported: true, enabled: !!enable, exePath, schemes: plan.schemes, total: ops.length, done: results.length, failed: failed.length, results };
}

/** 只**读**注册表（不写）：查询两个 scheme 是否都指向本 exe */
async function queryProtocolAssoc() {
  const blocked = packagedOnlyGuard('导入链接协议');
  if (blocked) return { supported: false, registered: null, reason: blocked };
  const exePath = realExePath();
  const plan = lib.planProtocolAssoc({ exePath });
  const per = [];
  for (const scheme of plan.schemes) {
    const key = `HKCU\\Software\\Classes\\${scheme}`;
    const rp = await runReg(['query', key, '/v', 'URL Protocol']);
    const hasProto = lib.parseRegQueryValue(rp.out, 'URL Protocol') !== null;
    const rc = await runReg(['query', `${key}\\shell\\open\\command`, '/ve']);
    const data = lib.parseRegQueryValue(rc.out, null);
    per.push({ scheme, hasUrlProtocol: hasProto, command: data, registered: hasProto && data !== null && data.includes(exePath) });
  }
  return { supported: true, registered: per.every((x) => x.registered), exePath, schemes: per };
}

/* ------------------------------------------------------------------ *
 * 开机自启
 * ------------------------------------------------------------------ */

function autoLaunchState() {
  const blocked = packagedOnlyGuard('开机自启');
  if (blocked) return { supported: false, openAtLogin: false, reason: blocked };
  const exe = realExePath();
  try {
    const s = app.getLoginItemSettings({ path: exe });
    return { supported: true, openAtLogin: !!s.openAtLogin, exePath: exe };
  } catch (e) {
    return { supported: false, openAtLogin: false, exePath: exe, reason: msg(e) };
  }
}

function setAutoLaunch(on) {
  const blocked = packagedOnlyGuard('开机自启');
  if (blocked) return { ok: false, supported: false, error: blocked };
  const exe = realExePath();
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: [] });
    const st = autoLaunchState();
    // ★ 写完之后**回读**：写不进去（组策略/权限）时必须说，不能让界面显示「已开启」
    if (st.openAtLogin !== !!on) {
      log('[auto-launch] 写入后回读不一致', JSON.stringify(st));
      return { ok: false, supported: true, error: '系统未接受该设置（可能被组策略或安全软件拦下）', ...st };
    }
    return { ok: true, ...st };
  } catch (e) {
    return { ok: false, supported: true, error: msg(e), ...autoLaunchState() };
  }
}

/* ------------------------------------------------------------------ *
 * 「双击打开」的落地：文件字节交给渲染进程，由前端算 bookUrl 并导入
 * ------------------------------------------------------------------ */

let rendererReady = false;
/** 渲染进程还没就绪时先存着（双击启动的那一刻页面可能还在对齐用户数据） */
let pendingOpenFiles = [];
/** `#347` 同上：深链（协议唤起）在渲染进程没就绪时也先存着，握手后补发 */
let pendingSchemeUrls = [];

function readBookFileForRenderer(filePath) {
  const name = path.basename(filePath);
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, name, error: '不是一个文件' };
    if (st.size === 0) return { ok: false, name, error: '文件是空的' };
    if (st.size > lib.MAX_BOOK_BYTES) {
      return { ok: false, name, error: `文件 ${(st.size / 1048576).toFixed(1)}MB 超过上限 ${lib.MAX_BOOK_BYTES / 1048576}MB（与服务端请求体上限相同）` };
    }
    const buf = fs.readFileSync(filePath);
    return { ok: true, name, path: filePath, bytes: buf.length, data: buf };
  } catch (e) {
    return { ok: false, name, error: msg(e) };
  }
}

function sendOpenFiles(files) {
  const good = (files || []).filter((f) => f && f.ok);
  if (!good.length) return;
  if (!mainWindow || !rendererReady) {
    pendingOpenFiles.push(...good);
    log(`[open-file] 渲染进程未就绪，暂存 ${good.length} 个文件`);
    return;
  }
  try {
    mainWindow.webContents.send('yuedu:open-files', good);
    log('[open-file] 已交渲染进程：' + good.map((f) => f.name).join('、'));
  } catch (e) {
    log('[open-file] 发送失败：', msg(e));
  }
}

function flushPendingOpenFiles() {
  if (!pendingOpenFiles.length) return;
  const files = pendingOpenFiles;
  pendingOpenFiles = [];
  sendOpenFiles(files);
}

/** 菜单「打开本地书籍…」：挑文件 → 读字节 → 交渲染进程（**走与双击同一条路**，不另开一套） */
async function openLocalBookDialog() {
  const opts = {
    title: '打开本地书籍',
    filters: [{ name: '本地书籍（txt / epub）', extensions: [...lib.BOOK_EXTS] }, { name: '全部文件', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections'],
  };
  let r;
  try {
    r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const results = r.filePaths.filter((p) => lib.isBookFile(p)).map(readBookFileForRenderer);
  const bad = results.filter((x) => !x.ok);
  if (bad.length) log('[open-file] 打不开：' + bad.map((b) => `${b.name}（${b.error}）`).join('；'));
  sendOpenFiles(results);
  return { ok: true, sent: results.length - bad.length, failed: bad.map((b) => ({ name: b.name, error: b.error })) };
}

/**
 * 启动参数里的书文件。**双击打开**在 Windows 上就是把路径塞进 argv。
 * 按「后缀 + 文件存在」筛（不按下标）的完整理由见 `desktop-lib.js` 的 `bookFilesFromArgv`。
 */
function pickBookFiles(argv) {
  return lib.bookFilesFromArgv(argv, (p) => { try { return fs.existsSync(p); } catch { return false; } });
}
const argvBookFiles = pickBookFiles(process.argv);
/** `#347` 启动参数里的「一键导入」深链（协议唤起 ⇒ Windows 把 URL 塞进 argv，与书文件同机制） */
const argvSchemeUrls = lib.schemeUrlsFromArgv(process.argv);

/**
 * 把一条深链交给渲染进程（`ReaderOverlay` 的 `onLegadoUrl` 监听 `yuedu:scheme-url`）。
 * ★ 桌面端**不判型** —— 归类在 `apps/web/src/utils/scheme-import.ts`（`#343` 唯一实现）。
 * 渲染进程未就绪时先入队（与 `sendOpenFiles` 同构）。
 */
function sendSchemeUrl(url) {
  const u = String(url || '').trim();
  if (!u) return;
  if (!mainWindow || !rendererReady) {
    pendingSchemeUrls.push(u);
    log(`[scheme-url] 渲染进程未就绪，暂存 1 条（共 ${pendingSchemeUrls.length}）`);
    return;
  }
  try {
    mainWindow.webContents.send('yuedu:scheme-url', u);
    log('[scheme-url] ⇒ 渲染进程', u.slice(0, 120));
  } catch (e) {
    log('[scheme-url] 发送失败：', msg(e));
  }
}

/** 渲染进程握手后补发暂存的深链（只发一次，发完清空） */
function flushSchemeUrls() {
  if (!pendingSchemeUrls.length) return;
  const list = pendingSchemeUrls.slice();
  pendingSchemeUrls = [];
  for (const u of list) sendSchemeUrl(u);
}

/* =========================================================================
 * 单实例：双击第二个文件时不能再起一个窗口/一份服务
 * ========================================================================= */

/**
 * `YUEDU_ALLOW_MULTI_INSTANCE=1` 时跳过单实例锁。
 * 为什么留这个口子：探针/自检要在**用户正开着桌面端**的机器上起临时实例（换 PORT + 临时数据目录），
 * 否则第二个实例会立刻退出、探针拿到一个「什么都没发生」的假结论。
 */
const ALLOW_MULTI_INSTANCE = process.env.YUEDU_ALLOW_MULTI_INSTANCE === '1';
/** `lost=true` ⇒ 已有实例在跑，本进程只负责把 argv 转交出去然后退出 */
const singleInstance = { allowedMulti: ALLOW_MULTI_INSTANCE, lost: false };

app.on('second-instance', (_e, argv, cwd) => {
  const files = pickBookFiles(argv);
  // `#347`：点导入链接时，Windows 起的是**第二个进程**并把 URL 当 argv ⇒ 与书文件同一通路
  const urls = lib.schemeUrlsFromArgv(argv);
  log(`[single-instance] 第二次启动：书文件 ${files.length} 个 · 深链 ${urls.length} 条（cwd=${cwd}）`);
  if (SERVER_ONLY) {
    // 服务壳模式不处理文件关联：只把界面叫出来（单实例锁仍与普通模式共用）
    if (files.length || urls.length) log('[server-only] 忽略书文件 / 深链（本模式不注册文件关联）');
    showMainWindow();
    return;
  }
  showMainWindow();
  if (files.length) sendOpenFiles(files.map(readBookFileForRenderer));
  for (const u of urls) sendSchemeUrl(u);
});

if (!ALLOW_MULTI_INSTANCE) {
  try {
    singleInstance.lost = app.requestSingleInstanceLock() !== true;
  } catch (e) {
    // 拿不到锁这个 API 本身有问题时，**放行**（起两个实例也好过完全起不来）
    log('[single-instance] requestSingleInstanceLock 异常：', msg(e));
  }
}
if (singleInstance.lost) {
  // 上面那个 `second-instance` 会在**已有实例**里触发；本进程转交完就退
  log('[single-instance] 已有实例在运行 ⇒ 转交文件后退出本进程');
  app.quit();
}

/* =========================================================================
 * `#453` 内嵌真浏览器（WebContentsView 常驻池）
 *
 * 为什么需要：桌面端之前的「渲染」是**每次现起现停**一只隐藏 BrowserWindow（见下方回落分支），
 * 登录态、cookie、TLS 指纹一概留不下来，页内跳转/返回也无从谈起。
 *
 * 分工：
 *  · **渲染桥**（服务端子进程请求）：按会话键复用同一只 `WebContentsView`（partition 隔离），
 *    落到隐藏 host 窗口上跑，取 `outerHTML` 回给服务端；
 *  · **内嵌浏览**（界面自己用）：把同一只 view 挂到主窗口 `contentView` 上并给 bounds，
 *    启动页 → 内容页 → 返回全走 Chromium 原生能力；
 *  · **回落**：`WebContentsView` 不存在（Electron < 30）或无会话键时，维持既有的一次性窗口渲染；
 *    前端在拿不到 view 时也维持既有 iframe 通路。
 *
 * ★ 只拦不判：`will-navigate` / `setWindowOpenHandler` 一律 `preventDefault()` 并**上报**给渲染进程，
 *   同站判据由渲染进程用 `source-site.ts` 的 `sameSite()` 回判 —— 同一判据全仓只有一份。
 * ========================================================================= */
const VIEW_SUPPORTED = typeof WebContentsView === 'function';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** 会话键 → 真 view（元数据 / 回收决策在 lib-webview-pool 里） */
const webViews = new Map();
const viewPool = new viewpoolLib.WebViewPool({ ttlMs: 5 * 60_000, max: 6 });
/** 渲染用隐藏 host 窗口（view 必须挂在某个窗口上才谈得上渲染 / 执行 JS） */
let renderHostWin = null;
let viewReaper = null;

/** 会话键归一（与 lib 同一实现；界面可能只给 sourceId） */
function webviewKey(key, sourceId) {
  return viewpoolLib.normalizeKey(key, sourceId);
}

function ensureViewReaper() {
  if (viewReaper) return;
  viewReaper = setInterval(() => {
    for (const k of viewPool.evictPlan()) destroyView(k);
  }, 60_000);
  viewReaper.unref?.();
}

/** 隐藏 host 窗口：只为了让「挂在某窗口上」成立（`show:false` + 不节流 ⇒ JS 照跑） */
function renderHost() {
  if (renderHostWin && !renderHostWin.isDestroyed()) return renderHostWin;
  renderHostWin = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  renderHostWin.on('closed', () => { renderHostWin = null; });
  return renderHostWin;
}

/** 事件上报：真浏览器里的导航 / 新窗口一律「先拦下、再交给渲染进程判」 */
function reportWebviewEvent(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('yuedu:webview-ev', payload);
  } catch { /* 界面没起来就不上报 */ }
}

function hookViewEvents(key, view) {
  const wc = view.webContents;
  wc.on('will-navigate', (e, url) => {
    e.preventDefault();
    reportWebviewEvent({ key, type: 'navigate', url: String(url || '') });
  });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    reportWebviewEvent({ key, type: 'open', url: String(url || ''), disposition });
    return { action: 'deny' };
  });
  const nav = (_e, url) => reportWebviewEvent({ key, type: 'navigated', url: String(url || '') });
  wc.on('did-navigate', nav);
  wc.on('did-navigate-in-page', nav);
  wc.on('page-title-updated', (_e, title) => reportWebviewEvent({ key, type: 'title', title: String(title || '') }));
}

/** 造一只新 view（**不带池登记** —— 登记与否由调用方决定） */
function createView(k) {
  const v = new WebContentsView({
    webPreferences: {
      partition: viewpoolLib.partitionFor(k),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  v.webContents.setUserAgent(UA_CHROME);
  hookViewEvents(k, v);
  return v;
}

function getOrCreateView(key) {
  const k = webviewKey(key);
  const cur = webViews.get(k);
  if (cur && !cur.webContents.isDestroyed()) {
    viewPool.acquire(k);
    return cur;
  }
  const v = createView(k);
  webViews.set(k, v);
  viewPool.acquire(k);
  ensureViewReaper();
  return v;
}

/** 从任何父窗口上摘下（同一个 view 只能挂在一个窗口上） */
function detachView(view) {
  try { mainWindow?.contentView?.removeChildView(view); } catch { /* 没挂过 */ }
  try { renderHostWin?.contentView?.removeChildView(view); } catch { /* 没挂过 */ }
}

/** 挂到隐藏 host 上（渲染桥用；**不 pin**：渲染完就该让位给 TTL / LRU） */
function attachToHost(view) {
  detachView(view);
  const host = renderHost();
  try { host.contentView.addChildView(view); } catch { /* 已挂 */ }
  try { view.setBounds({ x: 0, y: 0, width: 1280, height: 800 }); } catch { /* 老版本无此方法 */ }
}

/** 挂到主窗口上（界面内嵌浏览用；`pinned`：用户正看着，不许被回收） */
function attachToMain(key, view, bounds) {
  detachView(view);
  try { mainWindow?.contentView?.addChildView(view); } catch { /* 已挂 */ }
  let box = null;
  try { box = mainWindow?.getContentBounds?.() ?? null; } catch { box = null; }
  try { view.setBounds(viewpoolLib.clampBounds(bounds, box)); } catch { /* ignore */ }
  viewPool.setPinned(key, true);
}

function destroyView(key) {
  const k = webviewKey(key);
  const v = webViews.get(k);
  webViews.delete(k);
  viewPool.forget(k);
  if (!v) return false;
  detachView(v);
  try { v.webContents.close(); } catch { /* ignore */ }
  return true;
}

/** 主窗口没了 ⇒ 挂在上面的 view 全销毁（否则窗口一关就留下一堆孤儿） */
function destroyAllViews() {
  for (const k of [...webViews.keys()]) destroyView(k);
}

/* =========================================================================
 * WebViewProvider 渲染桥：server（子进程）经本地 HTTP 口请求真渲染。
 * java.webView 类源在此获得 JS 渲染后的 HTML（Legado 安卓侧等价系统 WebView）。
 * 并发限流 2 + 单次 20s 硬超时 + 渲染缓冲 1.5s（JS 拉数据后取 HTML）。
 * ========================================================================= */
const RENDER_CONCURRENCY = 2;
let renderPort = 0;
let renderActive = 0;
const renderQueue = [];

/**
 * 取一页渲染后的 `outerHTML`。
 * `#453`：给了会话键（`sessionKey` / `sourceId`）⇒ 走**常驻 view**（登录态 / cookie 都带得上）；
 * 否则维持既有的一次性隐藏窗口。
 *
 * ★ `#458` **同键必须串行**：同一只 view 上并发跑两次 `loadURL`，后一次会**打断**前一次
 *   （`did-fail-load` 的 ABORTED(-3) 被我们按"重定向中"忽略 ⇒ 前一次一直等到 20s 硬超时才回空）
 *   —— 用户实测「发现页切换分类超时」正是这个形态；不同键之间仍可并行（各自一只 view）。
 */
const keyChains = new Map();
function runForKey(key, job) {
  const prev = keyChains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  keyChains.set(
    key,
    next.catch(() => undefined).then(() => {
      if (keyChains.get(key) === next) keyChains.delete(key);
    }),
  );
  return next;
}

function renderPage(url, sessionKey) {
  const key = sessionKey ? viewpoolLib.normalizeKey(sessionKey) : '';
  const job = () => renderQueued(url, key);
  return key ? runForKey(key, job) : job();
}

/** 全局并发闸门（2）+ 单次 20s 硬超时 + 渲染缓冲 1.5s */
function renderQueued(url, key) {
  return new Promise((resolve) => {
    const run = () => {
      renderActive++;
      let settled = false;
      let cleanup = () => {};
      const finish = (html) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { cleanup(); } catch { /* ignore */ }
        renderActive--;
        const next = renderQueue.shift();
        if (next) next();
        resolve(html || '');
      };
      const timer = setTimeout(() => finish(''), 20000);
      try {
        cleanup = VIEW_SUPPORTED && key
          ? renderPageInView(url, key, finish)
          : renderPageInWindow(url, finish);
      } catch {
        finish('');
      }
    };
    if (renderActive < RENDER_CONCURRENCY) run();
    else renderQueue.push(run);
  });
}

/**
 * `#453` 路径：常驻 view（partition 隔离 + 同键复用）。
 *
 * ★ `#458` **绝不复用"正给人看"的那只 view**：`attachToHost` 会把 view 从主窗口摘下来再导航 ——
 *   对 pinned（已挂进主窗口、用户正在看/正在登录）的那只 view 做这件事 = 把用户页面抢走。
 *   后台渲染只借**同一个 partition**（cookie/登录态照旧），不借可见的那只 view：pinned 时另造一只
 *   一次性 view，渲染完立刻摘掉+关闭。
 */
function renderPageInView(url, sessionKey, done) {
  const k = webviewKey(sessionKey);
  const pinned = viewPool.peek(k)?.pinned === true;
  const view = pinned ? createView(k) : getOrCreateView(k);
  const wc = view.webContents;
  attachToHost(view);
  let bufferTimer = null;
  const onLoad = () => {
    // JS 渲染缓冲：SPA / 异步拉数据的页面常见 0.5~1.5s 才出内容
    bufferTimer = setTimeout(() => {
      wc.executeJavaScript('document.documentElement.outerHTML').then((html) => done(html)).catch(() => done(''));
    }, 1500);
  };
  const onFail = (_e, code) => { if (code === -3) return; done(''); }; // ABORTED：重定向中触发
  wc.once('did-finish-load', onLoad);
  wc.once('did-fail-load', onFail);
  wc.loadURL(url).catch(() => done(''));
  return () => {
    if (bufferTimer) clearTimeout(bufferTimer);
    try { wc.off('did-finish-load', onLoad); wc.off('did-fail-load', onFail); } catch { /* ignore */ }
    // 常驻 view **只摘监听、不销毁**（下次同源渲染直接复用）；一次性 view 用完即弃
    if (pinned) {
      try { renderHostWin?.contentView?.removeChildView(view); } catch { /* 没挂过 */ }
      try { wc.close(); } catch { /* ignore */ }
    }
  };
}

/** 回落路径（`WebContentsView` 不存在，或调用方没给会话键）：一次性隐藏窗口 */
function renderPageInWindow(url, done) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  let finished = false;
  const end = (html) => {
    if (finished) return;
    finished = true;
    try { win.destroy(); } catch { /* already gone */ }
    done(html);
  };
  win.webContents.setUserAgent(UA_CHROME);
  win.webContents.once('did-finish-load', () => {
    // JS 渲染缓冲：SPA/异步拉数据的页面常见 0.5~1.5s 才出内容
    setTimeout(() => {
      win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .then((html) => end(html))
        .catch(() => end(''));
    }, 1500);
  });
  win.webContents.once('did-fail-load', (_e, code) => {
    if (code === -3) return; // ABORTED：重定向中触发，等 did-finish-load
    end('');
  });
  win.loadURL(url).catch(() => end(''));
  return () => { try { if (!finished) win.destroy(); } catch { /* ignore */ } };
}

/** 返回 Promise<port|null>：调用方要 `await` 它 —— 服务端子进程靠 `YUEDU_RENDER_PORT` 才拿得到端口 */
function startRenderBridge() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const target = u.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) {
        res.writeHead(400).end('bad url');
        return;
      }
      // `#453`：可选会话键（服务端的 /api/sessions/render 与 renderer.ts 的 L4 都会带上）——
      // 有它就走常驻 view，登录态/cookie 复用；请求/响应形态不变。
      const sessionKey = u.searchParams.get('sessionKey') || u.searchParams.get('sourceId') || '';
      renderPage(target, sessionKey)
        .then((html) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        })
        .catch(() => {
          res.writeHead(502).end('');
        });
    });
    server.on('error', (e) => { log('[render-bridge] 监听失败：', msg(e)); resolve(null); });
    server.listen(0, '127.0.0.1', () => {
      renderPort = server.address().port;
      log('渲染桥就绪 127.0.0.1:' + renderPort);
      resolve(renderPort);
    });
    server.unref();
  });
}

/**
 * 把渲染桥端口告诉**正在跑的那个服务**（`POST /api/internal/renderer`）。
 *
 * ★ 这是补上一个**从来没被实现过**的调用：`#209` 之前 `ensureServer()` 里就写着
 *   `void registerRenderer()`，但全仓没有它的定义（`git log -S` 确认自首次提交起就没有）。
 *   后果有两层：① 复用外部服务（用户自己跑 `start-server.bat`，本仓最常见的情形）时
 *   `java.webView` 类源拿不到渲染端口；② 那句 `ReferenceError` 会把 `whenReady` 的
 *   启动链**整条打断** ⇒ 后面的 `createWindow()` 根本执行不到 ⇒ 桌面端**打不开窗口**。
 */
async function registerRenderer() {
  if (!renderPort) { log('[render-bridge] 端口未就绪，跳过注册'); return; }
  try {
    const r = await fetch(`${URL_BASE}/api/internal/renderer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: renderPort }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) {
      log(`[render-bridge] 注册失败 HTTP ${r.status}`, JSON.stringify(j));
      return;
    }
    log(`[render-bridge] 已注册到 ${URL_BASE}（renderBridgePort=${j.renderBridgePort}）`);
  } catch (e) {
    log('[render-bridge] 注册请求失败：', msg(e));
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL_BASE}/api/engines`, { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 读一个本地 JSON（身份端点等）。失败一律 null —— 调用方按「不是我们的服务」处理。 */
function getJson(pathname, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`${URL_BASE}${pathname}`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 端口解析：环境变量 `PORT` 优先，其次偏好 `serverPort`（0 = 跟随形态默认），最后形态默认。 */
function applyServerAddress() {
  const fromEnv = Number(process.env.PORT);
  const fromPrefs = Number(prefs && prefs.serverPort);
  PORT = Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : (Number.isFinite(fromPrefs) && fromPrefs >= 1024 ? fromPrefs : DEFAULT_PORT);
  URL_BASE = `http://127.0.0.1:${PORT}`;
}

/** 本客户端当前生效的数据目录（与 startServer 注入的 YUEDU_DATA_DIR 同口径）。 */
function resolveDataDir() {
  if (process.env.YUEDU_DATA_DIR) return path.resolve(process.env.YUEDU_DATA_DIR);
  if (prefs && prefs.dataDir) return path.resolve(prefs.dataDir);
  return app.isPackaged
    ? path.resolve(app.getPath('userData'), 'yuedu-data')
    : path.resolve(REPO_ROOT, 'data');
}

const expectedDataDir = resolveDataDir;

/** Windows 路径比较：忽略大小写与末尾分隔符。 */
function sameDir(a, b) {
  const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/* ------------------------------------------------------------------ *
 * 「同一数据目录只允许一个壳」的互斥锁
 *
 * Electron 的 `requestSingleInstanceLock` 只管**同一个 userData / 同一个 exe**；
 * PC 客户端与服务端 exe 的 userData 天生不同，拦不住它们指向同一数据目录。
 * 所以另加一把文件锁：锁里记 pid + 形态，pid 已死视为残留并接管。
 * ------------------------------------------------------------------ */

let shellLockFile = '';
let shellLockHeld = false;

function readShellLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function acquireShellLock(dataDir) {
  const file = lib.shellLockPath(dataDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        mode: SERVER_ONLY ? 'server' : 'desktop',
        port: PORT,
        startedAt: new Date().toISOString(),
      }));
      fs.closeSync(fd);
      shellLockFile = file;
      shellLockHeld = true;
      return { ok: true };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        // 目录不可写等：不拦启动（服务端会给出更具体的错），但必须留痕
        log('[shell-lock] 写入失败：', msg(e));
        return { ok: true, warning: msg(e) };
      }
    }
    const cur = readShellLock(file);
    const pid = Number(cur && cur.pid);
    if (pidAlive(pid)) {
      return {
        ok: false,
        holder: cur,
        message: `数据目录正被另一个悦读壳使用（${cur && cur.mode === 'server' ? '独立服务端' : 'PC 客户端'}，PID ${pid}）`,
      };
    }
    // 持有者已不在 ⇒ 残留锁，接管
    log('[shell-lock] 接管残留锁：', file, 'pid=', pid);
    try { fs.unlinkSync(file); } catch { /* 别人刚好也清了 */ }
  }
  return { ok: false, message: '无法获取数据目录锁' };
}

function releaseShellLock() {
  if (!shellLockHeld || !shellLockFile) return;
  try { fs.unlinkSync(shellLockFile); } catch { /* 已被清 */ }
  shellLockHeld = false;
  shellLockFile = '';
}

async function waitReady(maxMs = 30000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 看门狗：连续自动重启次数上限（手动重启会清零） */
const MAX_SERVER_RESTARTS = 5;
let serverRestartAttempts = 0;
let serverStableTimer = null;
/** 看门狗用尽额度后停在这里：托盘「重启服务」仍要能手动救回来 */
let serverCrashStopped = false;

function startServer() {
  // 打包态：资源在 resourcesPath（extraResources）；开发态：仓库相对路径
  const isPackaged = app.isPackaged;
  const webDist = isPackaged
    ? path.join(process.resourcesPath, 'web-dist')
    : path.join(REPO_ROOT, 'apps', 'web', 'dist');
  const env = {
    ...process.env,
    PORT: String(PORT),
    // `#225`: mark the server as shell-managed so /api/system/restart only exits
    // (the watchdog below respawns it) instead of spawning a second copy.
    YUEDU_MANAGED_BY_SHELL: '1',
    YUEDU_SERVER_DIR: __dirname,
    // Cookie 持久化：开发态入仓库 data/；打包态入 userData（便携临时目录随删随走，不能放）
    YUEDU_COOKIES_FILE: isPackaged
      ? path.join(app.getPath('userData'), 'cookies.json')
      : path.join(REPO_ROOT, 'data', 'cookies.json'),
  };
  /*
   * 数据目录按「env → 设置页覆盖 → 默认」解析（`resolveDataDir` 唯一实现）。
   * 设置页改了目录后，这里必须同步，否则会出现「界面显示 A、服务写 B」。
   */
  const dataDir = resolveDataDir();
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* 让服务端自己报缺目录的错 */ }
  env.YUEDU_DATA_DIR = dataDir;
  if (!env.YUEDU_KV_FILE) env.YUEDU_KV_FILE = path.join(dataDir, 'kv.json');
  if (fs.existsSync(webDist)) env.YUEDU_WEB_DIST = webDist;
  if (renderPort) env.YUEDU_RENDER_PORT = String(renderPort);

  // 服务日志落盘（黑屏/崩溃时可查 server.log）；壳级开关关掉时直接丢弃
  const logDisabled = prefs.logsEnabled === false;
  // 服务端自己的日志 sink 也跟着关（否则壳不落盘、服务端仍在写文件，开关会骗人）
  if (logDisabled) env.YUEDU_LOG_SINK = '0';
  const out = logDisabled ? 'ignore' : fs.openSync(logFile(), 'a');
  const spawnOpts = { cwd: REPO_ROOT, env, stdio: ['ignore', out, out], windowsHide: true, detached: false };
  // 打包态 spawn 的相对定位基 = bundle 所在目录（asar 解包目录）

  // 优先用打包好的单文件 server（esbuild ESM bundle，jsdom 内联、零外部文件依赖）。
  // 打包态无系统 node → 用 electron 自身 Node 22（ELECTRON_RUN_AS_NODE=1）。
  const bundle = isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'server-bundle.mjs')
    : path.join(__dirname, 'server-bundle.mjs');
  let proc;
  if (fs.existsSync(bundle)) {
    const nodeExe = isPackaged ? process.execPath : (process.env.YUEDU_NODE_EXE ?? 'node');
    const spawnEnv = isPackaged ? { ...spawnOpts.env, ELECTRON_RUN_AS_NODE: '1' } : spawnOpts.env;
    proc = spawn(nodeExe, [bundle], { ...spawnOpts, env: spawnEnv });
  } else {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    proc = spawn(pnpm, ['--filter', '@yuedu/server', 'start'], spawnOpts);
  }
  serverProc = proc;
  serverCrashStopped = false;
  log(`server 已启动 pid=${proc.pid}${logDisabled ? '（日志已关闭）' : ''}`);

  // 稳定运行 60s ⇒ 清零看门狗计数（避免「很久以前崩过一次」永久占用额度）
  if (serverStableTimer) clearTimeout(serverStableTimer);
  serverStableTimer = setTimeout(() => {
    serverStableTimer = null;
    serverRestartAttempts = 0;
  }, 60_000);
  serverStableTimer.unref?.();

  proc.on('exit', (code) => {
    // 已被替换 / 主动结束的旧进程：不是崩溃，不触发看门狗
    if (serverProc !== proc) { log('[server] 旧进程退出（已被替换）code=' + code); return; }
    serverProc = null;
    if (serverStableTimer) { clearTimeout(serverStableTimer); serverStableTimer = null; }
    log('server 退出码', code);
    if (quitting) return;
    // 桌面模式：窗口还开着才拉起（保住阅读会话）；服务壳模式：没有窗口也要拉起
    const wantRestart = SERVER_ONLY || BrowserWindow.getAllWindows().length > 0;
    if (!wantRestart) return;
    if (serverRestartAttempts >= MAX_SERVER_RESTARTS) {
      log(`[watchdog] 已连续自动重启 ${serverRestartAttempts} 次，停止自动重启`);
      serverCrashStopped = true;
      notifyTray('本地服务反复崩溃', `已停止自动重启（上限 ${MAX_SERVER_RESTARTS} 次）。请查看 server.log，或用托盘「重启服务」再试。`);
      rebuildTrayMenu();
      return;
    }
    serverRestartAttempts += 1;
    log(`自动重启 server…（第 ${serverRestartAttempts}/${MAX_SERVER_RESTARTS} 次）`);
    setTimeout(() => {
      if (serverProc || quitting) return;
      if (!SERVER_ONLY && BrowserWindow.getAllWindows().length === 0) return;
      startServer();
      if (!SERVER_ONLY) void registerRenderer();
    }, 3000);
  });
}

/**
 * 结束服务子进程树。
 * Windows 上 `child.kill()` 只终止直接子进程，bundle 还会拉起 batch-child / dom-worker，
 * 留着它们会占住数据目录与端口 ⇒ 统一用 `taskkill /T /F`。
 */
function killServerTree() {
  const proc = serverProc;
  if (!proc || !proc.pid) return;
  serverProc = null; // 先摘引用：exit 回调看到「已被替换」就不会当崩溃重启
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (e) {
    log('[server] 结束进程树失败：', msg(e));
    try { proc.kill(); } catch { /* 已经没了 */ }
  }
}

/** 手动重启服务：清零看门狗 → 结束进程树 → 重新拉起 → 等就绪 */
async function restartServer(reason) {
  log(`[server] 手动重启（${reason}）`);
  if (!serverProc && !serverCrashStopped) {
    // 复用的外部服务不归本壳管：不乱杀，交给用户原来的启动方式
    log('[server] 当前服务不是本壳拉起，拒绝重启');
    notifyTray('无法重启服务', '当前连接的服务不是由本壳启动的，请用原来的方式（start-server.bat / 桌面端）重启。');
    return false;
  }
  serverRestartAttempts = 0;
  killServerTree();
  await new Promise((r) => setTimeout(r, 500));
  startServer();
  if (!SERVER_ONLY) void registerRenderer();
  const ok = await waitReady(20000);
  log(`[server] 重启${ok ? '完成' : '失败'}：${URL_BASE}`);
  rebuildTrayMenu();
  if (!ok) notifyTray('服务重启失败', '服务没有在 20 秒内回来，详见 server.log。');
  return ok;
}

async function ensureServer() {
  if (await ping()) {
    /*
     * 端口上有服务 ≠ 可以直接复用：必须确认「是同一套悦读 + 同一份数据」。
     * 端口只能证明有人在听；若直接复用，用户会在毫不知情的情况下读写另一套数据。
     * 判定失败时**明确拒绝并退出**（同机只允许一种形态），而不是把另一套数据当成自己的。
     */
    const id = await getJson('/api/system/identity');
    if (!id || id.app !== 'yuedu') {
      dialog.showMessageBoxSync({
        type: 'error',
        title: '端口被占用',
        message: `端口 ${PORT} 已被其他程序占用`,
        detail: '无法确认占用者是悦读服务。请关闭该程序，或在设置中修改端口后重试。',
        buttons: ['退出'],
      });
      return false;
    }
    if (sameDir(id.dataDir, expectedDataDir())) return true;
    dialog.showMessageBoxSync({
      type: 'warning',
      title: '已有一套悦读在运行',
      message: '检测到另一套悦读服务，数据目录不同',
      detail:
        `端口：${PORT}\n` +
        `正在运行：${id.dataDir}\n` +
        `本客户端：${expectedDataDir()}\n\n` +
        '同一时间只允许一种形态运行（桌面端 / Web+server）。请退出另一套后再打开本客户端。',
      buttons: ['退出'],
    });
    return false;
  }
  startServer();
  if (!(await waitReady())) {
    log('内置服务启动失败（详见 server.log）');
  }
  return true;
}

// 离线兜底页：服务未就绪时显示，服务就绪后由**主进程**换回应用。
// ★ `#155`：从 `data:text/html` 改为**真实文件** —— data: URL 是不透明 origin，
//   页面里的 fetch 会带 `Origin: null`，逼得服务端 CORS 白名单必须留 'null'
//   （而不透明 origin 可由「父页面嵌 data: iframe」伪造 ⇒ 安全残余风险）。
//   现在页面**零脚本零请求**，轮询搬进主进程（startOfflineWatch）⇒ CORS 的 'null' 特例已删除。
// ★ `#209`：落盘位置从**仓库源码目录**改到 userData —— 原来每次启动都会在 `apps/desktop/`
//   生成一个 `offline.html`，让 `git status` 一直多一个未跟踪文件（实测确认）。
const OFFLINE_FILE = (() => {
  try { return path.join(app.getPath('userData'), 'offline.html'); } catch { return path.join(__dirname, 'offline.html'); }
})();
try {
  fs.mkdirSync(path.dirname(OFFLINE_FILE), { recursive: true });
  fs.writeFileSync(
    OFFLINE_FILE,
    `<!doctype html><html><head><meta charset="utf-8"><title>悦读 · 启动中</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.bar{width:220px;height:4px;background:#334155;border-radius:2px;margin:16px auto;overflow:hidden}
.bar i{display:block;width:40%;height:100%;background:#6366f1;border-radius:2px;animation:s 1.2s infinite}@keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
small{color:#64748b}</style></head>
<body><div class="box"><h2>悦读 · 服务启动中…</h2><div class="bar"><i></i></div>
<small>日志：apps/desktop/server.log</small></div></body></html>`,
    'utf8',
  );
} catch (e) {
  log('离线页写盘失败（offline.html）：', msg(e));
}
const OFFLINE_URL = 'file:///' + OFFLINE_FILE.replace(/\\/g, '/');

// 轮询在**主进程**做：服务就绪 ⇒ 主进程主动把窗口换回应用（页面自己不发任何请求）。
// 与旧页一致：每 2s 一次、120s 后放弃（服务真起不来时别无限打扰）。
let offlineWatch = null;
function startOfflineWatch() {
  if (offlineWatch) return;
  const t0 = Date.now();
  offlineWatch = setInterval(async () => {
    if (await ping()) {
      clearInterval(offlineWatch);
      offlineWatch = null;
      log('服务就绪 ⇒ 从离线页回到应用');
      mainWindow?.loadURL(URL_BASE).catch(() => {});
    } else if (Date.now() - t0 > 120000) {
      clearInterval(offlineWatch);
      offlineWatch = null;
      log('离线页轮询超时（120s），停止自动重试（重启应用可再试）');
    }
  }, 2000);
}
function showOffline() {
  mainWindow?.loadURL(OFFLINE_URL).catch(() => {});
  startOfflineWatch();
}

/* ---- `#463②` 启动欢迎界面（splash）----
 * 用户原话（2026-10-14）：「软件启动加载很慢，打开过程无任何显示/提示，直至打开；增加启动欢迎界面，
 * 简要显示加载信息、进度」。
 *
 * ★ 为什么必须**在 `ensureServer()` 之前**就开：主窗口是 `bootstrap()` 的最后一步才 `createWindow()`，
 *   而前面那几步（渲染桥 / **拉起 bundled server** / 托盘 / 快捷键）要好几秒 ⇒ 旧实现这段
 *   时间**屏幕上什么都没有**（用户看到的就是「双击了，半天没反应」；离线页只在窗口建好后才顶用）。
 *
 * ★ 数据用 `data:` URL **内联**（不新增 assets 文件）：主进程一份，`build.files` 无需改动，
 *   也不会因为打包漏文件而白屏（`#462` 的教训正来自打包清单）。
 */
let splashWin = null;
const SPLASH_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>悦读 · EngineHub</title>
<style>html,body{height:100%}body{font-family:system-ui,"Microsoft YaHei";background:#0f172a;color:#e2e8f0;
display:flex;align-items:center;justify-content:center;margin:0;-webkit-user-select:none;user-select:none}
.box{text-align:center;padding:0 18px}.t{font-size:15px;font-weight:600;letter-spacing:.5px}
.bar{width:232px;height:4px;background:#334155;border-radius:2px;margin:14px auto 10px;overflow:hidden}
.bar i{display:block;width:38%;height:100%;background:#6366f1;border-radius:2px;animation:s 1.2s infinite linear}
@keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
small{color:#94a3b8;font-size:12px}</style></head>
<body><div class="box"><div class="t">悦读 · EngineHub</div><div class="bar"><i></i></div>
<small id="step">正在启动…</small></div>
<script>window.__step=function(t){document.getElementById('step').textContent=t;};</script></body></html>`,
  );

/** 开 splash（自检/显式关闭时不开） */
function createSplash() {
  if (process.env.YUEDU_SELFCHECK || process.env.YUEDU_NO_SPLASH) return;
  try {
    splashWin = new BrowserWindow({
      width: 360,
      height: 148,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    splashWin.loadURL(SPLASH_HTML).catch(() => { /* 白屏也别把启动链带断 */ });
    splashWin.once('closed', () => { splashWin = null; });
  } catch (e) {
    splashWin = null;
    log('[splash] 创建失败（忽略）：', msg(e));
  }
}

/** 更新 splash 上那行「加载信息」（窗口已关/未开 ⇒ 静默跳过） */
function splashStep(text) {
  try {
    if (!splashWin || splashWin.isDestroyed()) return;
    void splashWin.webContents
      .executeJavaScript(`window.__step&&window.__step(${JSON.stringify(String(text))})`)
      .catch(() => { /* ignore */ });
  } catch {
    /* ignore */
  }
}

function closeSplash() {
  const w = splashWin;
  splashWin = null;
  try { w?.close(); } catch { /* ignore */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // 正常主窗最小尺寸；浮窗阅读是独立窗，不改主窗尺寸
    minWidth: lib.NORMAL_MIN_SIZE.width,
    minHeight: lib.NORMAL_MIN_SIZE.height,
    title: '悦读 · EngineHub',
    autoHideMenuBar: true,
    show: false,
    // 正常主窗保留原生控件（overlay）；浮窗是独立无边框窗，自己画工具条
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR_OVERLAY_NORMAL,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 主窗口收起/最小化后仍要推进朗读；Chromium 默认会节流隐藏窗口的定时器与渲染，
      // 桌面歌词的逐句进度会因此变慢甚至停住（设置页已承诺「关窗后后台朗读不中断」）。
      backgroundThrottling: false,
    },
  });
  mainWindow.loadURL(URL_BASE).catch(() => showOffline());
  // 窗口标题带数据目录尾名：用户一眼能看出这一窗在用哪份数据（三形态并存时尤其重要）
  const windowTitle = () => `悦读 · ${path.basename(resolveDataDir()) || 'data'} · ${PORT}`;
  try { mainWindow.setTitle(windowTitle()); } catch { /* 窗口已销毁时忽略 */ }
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    try { mainWindow.setTitle(windowTitle()); } catch { /* 同上 */ }
  });
  mainWindow.once('ready-to-show', () => { mainWindow.show(); closeSplash(); });
  // 加载失败（服务中途挂掉）→ 离线页轮询，服务恢复自动回到应用
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    // ★ `#155`：file:// 离线页自身的加载失败不得再触发重载（防循环）
    if (isMain && !String(url).startsWith('file://')) showOffline();
  });
  // 外链走系统浏览器（阅读站广告/跳转不污染桌面窗口）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL_BASE)) shell.openExternal(url);
    return { action: 'deny' };
  });

  /* ---- `#209` 托盘相关：关/最小化到托盘 ---- */
  /**
   * ★ 两个前提里任缺一个都不拦截：
   *   ① `tray` 不存在（图标缺失或创建失败）—— 拦了用户就找不回窗口；
   *   ② `quitting`（用户点了退出/系统注销）—— 拦了就退不掉。
   */
  mainWindow.on('close', (e) => {
    // 浮窗阅读中点「关闭」先退出浮窗再走原有 closeToTray 判定，避免被收进托盘后用户找不回窗口
    if (floatOpen && !quitting) exitFloatReading();
    if (quitting || !prefs.closeToTray || !tray) return;
    e.preventDefault();
    hideMainWindow(true);
  });
  mainWindow.on('minimize', (e) => {
    if (quitting || !prefs.minimizeToTray || !tray) return;
    e.preventDefault();
    hideMainWindow(true);
  });
  mainWindow.on('show', rebuildTrayMenu);
  mainWindow.on('hide', rebuildTrayMenu);
  // 桌面歌词的唯一触发源：主窗口焦点/显隐变化 ⇒ 走同一个 syncLyricsWindow()
  for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) {
    mainWindow.on(ev, syncLyricsWindow);
  }
  // 窗口重新加载（含离线页换回应用）后渲染进程要重新握手，否则「双击打开」会一直攒着
  mainWindow.webContents.on('did-navigate', () => {
    rendererReady = false;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    // 进程内浮窗状态随主窗一起清掉（prefs 里只保留各形态几何）
    floatOpen = false;
    floatMode = 'lyrics';
    floatPanelOpen = false;
    if (floatGeoTimer) { clearTimeout(floatGeoTimer); floatGeoTimer = null; }
    // 主窗口没了 ⇒ 歌词/条形浮窗也必须收掉（否则会变成关不掉的置顶孤儿）
    try { if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.destroy(); } catch { /* ignore */ }
    lyricsWin = null;
    lyricsReady = false;
    if (offlineWatch) { clearInterval(offlineWatch); offlineWatch = null; }
    // `#453`：主窗口没了 ⇒ 挂在上面的内嵌 view 全销毁（否则窗口一关留下一堆孤儿）
    try { destroyAllViews(); } catch { /* ignore */ }
  });
}

// 登录窗：打开源的 loginUrl，用户手动登录后点「完成」→ 收集该域 Cookie 返回
// 离线页触发：确保服务在跑（看门狗只管自己 spawn 的，复用场景失效后由此兜底）
ipcMain.handle('yuedu:ensure-server', async () => {
  if (!serverProc && !(await ping())) startServer();
  return { ok: await waitReady(8000) };
});

ipcMain.handle('yuedu:login', async (_e, payload) => {
  const { sourceId, url, bookSourceUrl } = payload || {};
  let loginTarget = url;

  // ① 先问服务端：能跑的纯 HTTP 登录脚本（loginKind=js）直接由服务端执行，桌面端不必开窗。
  //    顺带拿到服务端解析出的登录页 URL（url / config-url 形态，含源阅式 JSON 配置）。
  if (sourceId) {
    try {
      const base = `${URL_BASE}/api/sources/${encodeURIComponent(sourceId)}/login`;
      const info = await fetch(base, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
      if (info && info.url) loginTarget = info.url;
      if (info && info.kind === 'js') {
        const r = await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(30000),
        }).then((x) => x.json());
        if (r && r.ok) return { ok: true, cookie: r.cookie, via: 'server' };
        // 服务端跑不通（缺凭据/脚本报错/引擎判定需浏览器）→ 继续走浏览器窗
        log(`[login] 服务端登录未成功：${(r && r.message) || '未知'}，转浏览器窗`);
      }
    } catch (e) {
      log(`[login] 服务端登录探测失败：${e && e.message}`);
    }
  }

  // ② 需要浏览器：loginUrl 可能是 JS 函数串（Legado 支持自定义登录逻辑）——无法直接打开时退回源站首页
  if (!/^https?:\/\//i.test(loginTarget)) loginTarget = bookSourceUrl || '';
  if (!loginTarget) return { ok: false, error: 'loginUrl 非 URL 且源无 bookSourceUrl' };
  const loginWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: '登录 · 完成后点击右上角按钮',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  await loginWin.loadURL(loginTarget);
  return new Promise((resolve) => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      try {
        const targetUrl = loginWin.webContents.getURL();
        const host = new URL(targetUrl).hostname;
        const prefix = host.split('.').slice(-2).join('.'); // 例：b.faloo.com → faloo.com
        const cookies = await loginWin.webContents.session.cookies.get({});
        const cookieStr = cookies
          .filter((c) => (c.domain || '').includes(prefix))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');
        loginWin.destroy();
        resolve({ ok: true, cookie: cookieStr });
      } catch (e) {
        loginWin.destroy();
        resolve({ ok: false, error: String(e) });
      }
    };
    // 注入右上角「完成登录」悬浮按钮（同域页面内执行）
    const inject = () => {
      loginWin.webContents
        .executeJavaScript(
          `(function(){if(document.getElementById('yuedu-done'))return;` +
          `var b=document.createElement('button');b.id='yuedu-done';b.textContent='✓ 完成登录';` +
          `b.style.cssText='position:fixed;top:10px;right:10px;z-index:999999;padding:8px 16px;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)';` +
          `b.onclick=function(){window.close && 0; document.title='YUEDU_LOGIN_DONE';};` +
          `document.body.appendChild(b);})()`,
        )
        .catch(() => {});
    };
    inject();
    loginWin.webContents.on('did-navigate', inject);
    loginWin.webContents.on('page-title-updated', (_e, title) => {
      if (title === 'YUEDU_LOGIN_DONE') finish();
    });
    loginWin.on('closed', () => finish());
  });
});

/* =========================================================================
 * `#727` `java.getVerificationCode`：桌面端内置验证码窗口
 *
 * 服务端（`verification-code.ts`）负责拉起/复用该源 Chromium、抓画面、收 Cookie；
 * 这里只做两件事：
 *   ① 轮询 `/api/verify-code/pending`，有新请求就开一个**独立 BrowserWindow** 加载输入页；
 *   ② 窗口关闭 ⇒ `DELETE /api/verify-code/:id`（让 worker 立刻收到「用户取消」，不等 60s 超时）。
 *
 * ★ 与登录窗（`yuedu:login`）**完全不同**的窗口：那个用 Electron 自己的 session 打开站点；
 *   这里的页面数据来自服务端 Chromium 的截图，Cookie 也回收进**服务端源 CookieStore**。
 *   服务端侧两者共用同一只 Chromium 会话，但验证码走 `openAuxTab` 另开标签，不抢登录页。
 * ========================================================================= */
const verifyCodeWins = new Map();
let verifyCodeWatch = null;
let verifyCodePollBusy = false;

function startVerifyCodeWatch() {
  if (verifyCodeWatch || quitting) return;
  verifyCodeWatch = setInterval(() => { void pollVerifyCodes(); }, 1500);
  verifyCodeWatch.unref?.();
}

async function pollVerifyCodes() {
  if (quitting || verifyCodePollBusy) return;
  verifyCodePollBusy = true;
  try {
    await pollVerifyCodesInner();
  } finally {
    verifyCodePollBusy = false;
  }
}

async function pollVerifyCodesInner() {
  let pending = [];
  try {
    // `#740` consumer=desktop：网页端已认领的请求不再下发（避免双开窗口）
    const r = await fetch(`${URL_BASE}/api/verify-code/pending?consumer=desktop`, { signal: AbortSignal.timeout(1200) });
    const j = await r.json();
    if (j && Array.isArray(j.pending)) pending = j.pending;
  } catch {
    return; // 服务端还没起来 / 正在重启：下一拍再看
  }
  const alive = new Set(pending.map((p) => p && p.id).filter(Boolean));
  for (const [id, win] of [...verifyCodeWins]) {
    if (alive.has(id) || (win.isDestroyed && win.isDestroyed())) continue;
    // 服务端已结束（提交/取消/超时）⇒ 收起窗口（`closed` 里的 DELETE 是无害的兜底）
    try {
      if (typeof win.close === 'function') win.close();
      else win.destroy();
    } catch { /* 已关 */ }
  }
  for (const p of pending) {
    if (!p || !p.id || verifyCodeWins.has(p.id)) continue;
    // `#740` 认领成功才开窗：同一 id 已被网页端认领 ⇒ 不开（先认领者独占）
    const claimed = await claimVerifyCode(p.id);
    if (!claimed) continue;
    openVerifyCodeWindow(p);
  }
}

async function claimVerifyCode(id) {
  try {
    const r = await fetch(`${URL_BASE}/api/verify-code/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ consumer: 'desktop' }),
      signal: AbortSignal.timeout(1200),
    });
    const j = await r.json();
    return !!(j && j.ok === true);
  } catch {
    return false;
  }
}

function openVerifyCodeWindow(meta) {
  const win = new BrowserWindow({
    width: 480,
    height: 700,
    title: '验证码 · 请输入',
    autoHideMenuBar: true,
  });
  verifyCodeWins.set(meta.id, win);
  win.on('closed', () => {
    verifyCodeWins.delete(meta.id);
    // 用户关窗 = 取消这次验证码输入（服务端已结束时会返回 cancelled:false，无害）
    fetch(`${URL_BASE}/api/verify-code/${encodeURIComponent(meta.id)}`, { method: 'DELETE' }).catch(() => {});
  });
  win.loadURL(`${URL_BASE}/api/verify-code/${encodeURIComponent(meta.id)}`).catch(() => {});
}

/* =========================================================================
 * `#209` 桌面端 IPC
 * ========================================================================= */

/** 渲染进程握手：只有它说「我准备好了」，暂存的双击文件才发得出去 */
ipcMain.on('yuedu:renderer-ready', () => {
  rendererReady = true;
  flushPendingOpenFiles();
  flushSchemeUrls(); // `#347`
});

/** 一次性把桌面端能力与**当前真实状态**交出去（界面据此渲染，不自己猜） */
async function desktopStatus() {
  // 每次问状态都重算一遍：用户可以正在改旗标文件/环境变量，界面不能停在旧结论上
  resolveLyricsGate();
  refreshGateWarning();
  return {
    prefs: prefsForUi(),
    prefsWarnings,
    prefsFile: desktopPrefsFile(),
    tray: tray ? { ok: true, icon: trayIconPath() } : { ok: false, reason: trayError || '未创建' },
    shortcut: { ...shortcutState },
    autoLaunch: autoLaunchState(),
    fileAssoc: await queryFileAssoc(),
    protocolAssoc: await queryProtocolAssoc(), // `#347`
    singleInstance: { allowedMulti: singleInstance.allowedMulti, lost: singleInstance.lost },
    // 浮窗形态是**运行态**（不写盘），随桌面状态一起回给渲染层
    float: floatStatePayload(),
    // 本地服务的**生效**配置（设置页显示「现在到底跑在哪」；env 覆盖也要如实标出）
    server: {
      port: PORT,
      urlBase: URL_BASE,
      dataDir: resolveDataDir(),
      sourceDb: path.join(resolveDataDir(), 'yuedu.db'),
      envPort: Number(process.env.PORT) || null,
      envDataDir: process.env.YUEDU_DATA_DIR ? path.resolve(process.env.YUEDU_DATA_DIR) : null,
    },
    paths: { exe: process.execPath, portableExe: portableExe(), userData: (() => { try { return app.getPath('userData'); } catch { return null; } })(), repoRoot: REPO_ROOT },
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  };
}

ipcMain.handle('yuedu:desktop-status', () => desktopStatus());

ipcMain.handle('yuedu:desktop-prefs-get', () => {
  resolveLyricsGate();
  refreshGateWarning();
  return { prefs: prefsForUi(), warnings: prefsWarnings, file: desktopPrefsFile() };
});

/** 选择数据目录（只返回路径；是否切换由渲染层确认后走 prefs-set，避免误点即迁移） */
ipcMain.handle('yuedu:desktop-pick-data-dir', async () => {
  const opts = { title: '选择数据目录', properties: ['openDirectory', 'createDirectory'] };
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
});

ipcMain.handle('yuedu:desktop-prefs-set', async (_e, patch) => {
  const before = { ...prefs };
  const p = patch && typeof patch === 'object' ? patch : {};
  /**
   * 外部配置（env / 便携旗标）**高于**设置页：
   * 强制期间不采纳 `lyricsEnabled` 的改动（但保留用户原来的持久化选择，
   * 删掉旗标/环境变量后它仍然有效），并把生效值 + 告警一起回给界面。
   */
  resolveLyricsGate();
  const next = { ...prefs, ...p };
  if (lyricsGate.forced && p.lyricsEnabled !== undefined) next.lyricsEnabled = prefs.lyricsEnabled;
  const n = lib.normalizePrefs(next);
  prefs = n.prefs;
  prefsWarnings = n.warnings;
  if (p.lyricsEnabled === true && !lyricsGate.forced) lyricsDismissed = false; // 用户重新开启 ⇒ 解除本轮关闭
  resolveLyricsGate();
  refreshGateWarning();
  const saved = savePrefs();
  /**
   * 端口 / 数据目录变化 ⇒ 必须重启整套壳：
   * · 服务端要重新注入 PORT / YUEDU_DATA_DIR；
   * · 主窗口的 `URL_BASE` 也要跟着换；
   * · app 内存里的绝对路径（身份判定、日志、`/api/diag` 显示）全部要重建。
   * 直接 relaunch 比「热改 URL」少一类半生效状态（用户已选择「确认后立即重启」）。
   */
  const serverCfgChanged = prefs.serverPort !== before.serverPort || prefs.dataDir !== before.dataDir;
  if (serverCfgChanged) {
    log('[server] 端口/数据目录变更，重启外壳…');
    setTimeout(() => { quitting = true; app.relaunch(); app.quit(); }, 200);
  }
  const shortcutTouched = prefs.shortcut !== before.shortcut || prefs.shortcutEnabled !== before.shortcutEnabled;
  if (shortcutTouched) applyShortcut();
  else rebuildTrayMenu();
  // 位置被清空/改写时把窗口挪到新位置；外观/开关变化则推给浮窗并重算显隐
  const posChanged = floatMode === 'bar'
    ? (prefs.floatBarX !== before.floatBarX || prefs.floatBarY !== before.floatBarY)
    : floatMode === 'regular'
      ? (prefs.floatRegularX !== before.floatRegularX || prefs.floatRegularY !== before.floatRegularY)
      : (prefs.floatLyricsX !== before.floatLyricsX || prefs.floatLyricsY !== before.floatLyricsY);
  if (posChanged) applyFloatPosition();
  // 字号 / 前后句显隐改变 ⇒ 歌词窗高度跟着变（三行文字刚好装下；底边保持不动向上长）
  refreshLyricsWindowHeight(before.floatFontSize, before.floatShowNeighbors);
  if (floatMode === 'bar' || floatMode === 'regular') applyFloatClickThrough();
  syncLyricsWindow();
  sendFloatUpdate();
  return { ok: saved.ok !== false, error: saved.error, prefs: prefsForUi(), warnings: prefsWarnings, shortcut: { ...shortcutState } };
});

/* =========================================================================
 * `--server-only` 壳级设置（本地 `server-settings.html` + preload IPC）
 *
 * 这里只承载**壳级**配置：端口 / 数据目录 / 进程与路径 / 音频缓存 / 开机自启 / 日志开关。
 * 业务设置（书源、阅读偏好等）仍在 Web 设置页 —— 两边不重复实现。
 * ========================================================================= */

let serverSettingsWin = null;

function openSettingsWindow() {
  if (SERVER_ONLY) { openServerSettingsWindow(); return; }
  showMainWindow();
  try { mainWindow?.webContents.send('yuedu:navigate', '/settings'); } catch (e) { log('[tray] 跳设置页失败：', msg(e)); }
}

function openServerSettingsWindow() {
  if (serverSettingsWin && !serverSettingsWin.isDestroyed()) {
    serverSettingsWin.show();
    serverSettingsWin.focus();
    return serverSettingsWin;
  }
  serverSettingsWin = new BrowserWindow({
    width: 620,
    height: 720,
    title: '悦读 · 服务设置',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'server-settings-preload.js'),
    },
  });
  serverSettingsWin.loadFile(path.join(__dirname, 'server-settings.html'))
    .catch((e) => log('[settings] 打开失败：', msg(e)));
  serverSettingsWin.once('ready-to-show', () => serverSettingsWin?.show());
  // 设置小窗的「关闭」= 收回托盘，不是退出服务；真正退出只走托盘「退出服务」
  serverSettingsWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    serverSettingsWin?.hide();
  });
  serverSettingsWin.on('closed', () => { serverSettingsWin = null; });
  return serverSettingsWin;
}

/** 壳级状态（设置小窗只读展示 + 表单初值） */
function shellConfig() {
  const dataDir = resolveDataDir();
  const auto = autoLaunchState();
  return {
    mode: SERVER_ONLY ? 'server-only' : 'desktop',
    serverOnly: SERVER_ONLY,
    port: PORT,
    urlBase: URL_BASE,
    portSource: process.env.PORT ? 'env' : (Number(prefs.serverPort) >= 1024 ? 'prefs' : 'default'),
    envPort: Number(process.env.PORT) || null,
    dataDir,
    sourceDb: path.join(dataDir, 'yuedu.db'),
    logFile: logFile(),
    kvFile: path.join(dataDir, 'kv.json'),
    audioDir: path.join(dataDir, 'audio-cache'),
    pid: serverProc?.pid ?? null,
    autoLaunch: auto,
    logsEnabled: prefs.logsEnabled !== false,
    prefsFile: desktopPrefsFile(),
  };
}

/** 主进程 → 本地服务的最小 JSON 客户端（设置小窗不直接 fetch：file:// origin 会被 CORS 挡） */
function shellHttp(method, pathname, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(URL_BASE + pathname); } catch (e) { resolve({ ok: false, error: msg(e) }); return; }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      timeout: 20000,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* 非 JSON 原样给 null */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: json });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: msg(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    if (data) req.write(data);
    req.end();
  });
}

ipcMain.handle('yuedu:shell-get', () => shellConfig());

ipcMain.handle('yuedu:shell-restart', () => restartServer('设置小窗'));

ipcMain.handle('yuedu:shell-open-data-dir', async () => {
  const r = await shell.openPath(resolveDataDir());
  return { ok: !r, error: r || null };
});

ipcMain.handle('yuedu:shell-open-log', async () => {
  const r = await shell.openPath(logFile());
  return { ok: !r, error: r || null };
});

ipcMain.handle('yuedu:shell-set-port', async (_e, port) => {
  const v = Number(port);
  if (!Number.isInteger(v) || v < 1024 || v > 65535) return { ok: false, error: '端口需要 1024~65535 的整数' };
  if (process.env.PORT) return { ok: false, error: `PORT 环境变量已固定为 ${process.env.PORT}，改设置不会生效` };
  prefs.serverPort = v;
  const saved = savePrefs();
  if (!saved.ok) return { ok: false, error: saved.error || '保存失败' };
  applyServerAddress();
  const ok = await restartServer(`端口改为 ${v}`);
  return { ok, error: ok ? null : '服务没有在 20 秒内回来', config: shellConfig() };
});

ipcMain.handle('yuedu:shell-set-data-dir', async (_e, dir) => {
  const s = typeof dir === 'string' ? dir.trim() : '';
  if (!s || !path.isAbsolute(s)) return { ok: false, error: '数据目录需要绝对路径' };
  prefs.dataDir = s;
  const saved = savePrefs();
  if (!saved.ok) return { ok: false, error: saved.error || '保存失败' };
  try { fs.mkdirSync(resolveDataDir(), { recursive: true }); } catch (e) {
    return { ok: false, error: `目录不可用：${msg(e)}` };
  }
  const ok = await restartServer('数据目录变更');
  return { ok, error: ok ? null : '服务没有在 20 秒内回来', config: shellConfig() };
});

ipcMain.handle('yuedu:shell-set-auto-launch', (_e, on) => {
  const r = setAutoLaunch(!!on);
  rebuildTrayMenu();
  return { ...r, config: shellConfig() };
});

ipcMain.handle('yuedu:shell-set-logs', (_e, on) => {
  prefs.logsEnabled = !!on;
  const r = savePrefs();
  rebuildTrayMenu();
  return { ok: r.ok !== false, error: r.error, config: shellConfig() };
});

ipcMain.handle('yuedu:shell-settings-close', () => {
  try { serverSettingsWin?.close(); } catch { /* 已经关了 */ }
});

/* ---- 音频缓存（配额 / prune / 无主缓存清理）· 由主进程转给本地服务 ---- */
ipcMain.handle('yuedu:audio-stats', () => shellHttp('GET', '/api/audio/stats'));
ipcMain.handle('yuedu:audio-prune', () => shellHttp('POST', '/api/audio/prune'));
ipcMain.handle('yuedu:audio-orphans', () => shellHttp('POST', '/api/audio/orphans'));
ipcMain.handle('yuedu:audio-purge-orphans', (_e, keys) => shellHttp('POST', '/api/audio/purge-orphans', {
  bookKeys: Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [],
}));
ipcMain.handle('yuedu:audio-config', (_e, maxBytes) => shellHttp('PUT', '/api/audio/config', { maxBytes }));
ipcMain.handle('yuedu:audio-clear', () => shellHttp('POST', '/api/audio/clear', {}));

/* ---- 桌面朗读歌词：渲染进程 → 主进程 → 歌词窗 ---- */
ipcMain.on('yuedu:lyrics-state', (_e, raw) => {
  lyricsState = lib.normalizeLyricsState(raw);
  syncLyricsWindow();
  sendFloatUpdate();
});

ipcMain.on('yuedu:lyrics-command', (_e, cmd) => {
  const allowed = new Set(['prev', 'toggle', 'next', 'chapterPrev', 'chapterNext']);
  if (!allowed.has(cmd)) return;
  try { mainWindow?.webContents.send('yuedu:lyrics-command', cmd); } catch { /* 主窗口还没起 */ }
});

ipcMain.on('yuedu:lyrics-close', () => {
  /**
   * 「关闭」只关悬浮窗，朗读/应用都继续。
   * · 普通情况：把开关落盘为 false，下次从设置页再开；
   * · 外部配置强制开（`lyrics-on.txt` / `YUEDU_LYRICS=1`）：不能改外部配置，但本轮先不弹，
   *   重启后恢复（`lyricsDismissed` 只在本次进程内有效）。
   */
  lyricsDismissed = true;
  if (!lyricsGate.forced) prefs.lyricsEnabled = false;
  savePrefs();
  syncLyricsWindow();
  try { mainWindow?.webContents.send('yuedu:lyrics-enabled', false); } catch { /* ignore */ }
});

/* ---- 浮窗：阅读正文流 / 浮窗控制（常规、条形、歌词共用同一扇 BrowserWindow） ---- */
ipcMain.on('yuedu:float-reading', (_e, raw) => {
  const next = lib.normalizeFloatReadingState(raw);
  /**
   * 旧 Publisher（`ReaderOverlay` 的条形档）只发 46 字切分行；桌面桥发的是
   * 「段落 + 章标题 + 目录」。前者到达时若已有富载荷就丢弃，避免两边来回覆盖，
   * 让浮窗一直按真实窗宽折行。
   */
  const legacy = next.paragraphs.length === 0 && next.chapters.length === 0;
  const rich = floatReading.paragraphs.length > 0 || floatReading.chapters.length > 0;
  if (legacy && rich) return;
  floatReading = next;
  if (floatOpen) sendFloatUpdate();
});

ipcMain.on('yuedu:float-hover', (_e, active) => {
  if (!lyricsWin || lyricsWin.isDestroyed() || floatMode === 'lyrics') return;
  // 穿透时也要让交互区能点：hover 进工具条/面板 ⇒ 临时取消穿透；移出 ⇒ 恢复条形档的偏好值。
  // 常规态从不穿透，这里恒为 false。
  const ignore = active !== true && floatMode === 'bar' && prefs.floatClickThrough === true;
  // 进交互区 = 用户马上要点。常规态在这里**强落**一次 false（1.5s 节流）：
  // 窗口隐藏期间系统侧可能留下 WS_EX_TRANSPARENT（句柄值没变 ⇒ 普通缓存路径会直接 return），
  // 表现为工具条能浮现（forward 转发 move）但整条按钮点不动（click 被整窗吞）。
  let force = false;
  if (active === true && floatMode !== 'bar' && Date.now() - floatHoverHealAt > 1500) {
    floatHoverHealAt = Date.now();
    force = true;
  }
  setFloatIgnore(ignore, force);
});

ipcMain.on('yuedu:float-command', (_e, raw) => {
  const cmd = raw && typeof raw === 'object' ? raw : { cmd: raw };
  if (cmd.cmd === 'close') { exitFloatReading(); return; }
  if (cmd.cmd === 'mode') { switchFloatMode(cmd.value); return; }
  if (cmd.cmd === 'speed') {
    const v = Number(cmd.value);
    if (Number.isFinite(v) && v >= 1 && v <= 3) {
      prefs.floatSpeed = Math.round(v);
      savePrefs();
      sendFloatUpdate();
      sendFloatState();
    }
    return;
  }
  if (cmd.cmd === 'click-through') {
    // 只有条形档支持穿透；常规/歌词收到（旧渲染层）一律忽略，避免整窗变不可交互
    if (floatMode !== 'bar') return;
    prefs.floatClickThrough = cmd.value === true;
    savePrefs();
    applyFloatClickThrough();
    sendFloatUpdate();
    sendFloatState();
    return;
  }
  if (cmd.cmd === 'lock') {
    prefs.floatDragLocked = cmd.value === true;
    savePrefs();
    sendFloatUpdate();
    return;
  }
  if (cmd.cmd === 'reset-pos') {
    // 歌词窗工具条「重置位置」：清掉位置偏好 ⇒ 回到默认（水平居中、底部留 72）与内容高度。
    // 只在歌词形态受理；锁定态也受理 —— 锁定只拦拖动/缩放，不拦工具条上的显式动作。
    if (floatMode !== 'lyrics' || !lyricsWin || lyricsWin.isDestroyed()) return;
    prefs.floatLyricsX = null;
    prefs.floatLyricsY = null;
    // 之前手动拉过尺寸 ⇒ 复位后重新按内容量高（与「锁定」复位同一口径）
    floatLyricsUserSized = false;
    savePrefs();
    try {
      const cur = lyricsWin.getBounds();
      const wa = lyricsWorkArea(lyricsWin, cur.x, cur.y);
      const base = lib.lyricsBoundsFromPrefs(prefs, wa); // 宽 720 + 水平居中
      // 面板敞着时保留面板加高（与字号变化同一口径）
      const extra = floatPanelOpen ? (floatPanelExtra > 0 ? floatPanelExtra : FLOAT_PANEL_EXTRA_H) : 0;
      const height = lyricsBaseHeight() + extra;
      const y = Math.min(Math.max(wa.y, wa.y + wa.height - height - 72), Math.max(wa.y, wa.y + wa.height - height));
      lyricsApplyingBounds = true;
      lyricsWin.setBounds({ x: base.x, y, width: base.width, height });
      setTimeout(() => { lyricsApplyingBounds = false; }, 300);
    } catch { /* ignore */ }
    // 窗宽可能被改回默认 720 ⇒ 折行变了，让渲染层清掉高度去重、按新折行重报一次
    sendFloatUpdate({ forceFit: true });
    sendFloatState();
    return;
  }
  // 阅读动作（目录 / 章节 / 跳转）交回主窗的阅读页处理
  if (cmd.cmd === 'toc' || cmd.cmd === 'chapterPrev' || cmd.cmd === 'chapterNext' || cmd.cmd === 'chapterOpen' || cmd.cmd === 'scrollTo') {
    try { mainWindow?.webContents.send('yuedu:float-command', cmd); } catch { /* 主窗口还没起 */ }
  }
});

ipcMain.handle('yuedu:open-local-book', () => openLocalBookDialog());

ipcMain.handle('yuedu:file-assoc-set', (_e, enable) => applyFileAssoc(!!enable));

// `#347` 导入链接协议（唤起 yuedu:// / legado:// 的桌面端半边）
ipcMain.handle('yuedu:protocol-assoc-set', (_e, enable) => applyProtocolAssoc(!!enable));
ipcMain.handle('yuedu:protocol-assoc-get', () => queryProtocolAssoc());

ipcMain.handle('yuedu:auto-launch-set', (_e, enable) => setAutoLaunch(!!enable));

/** 界面上的「显示 / 隐藏主窗口」 */
ipcMain.handle('yuedu:toggle-window', (_e, visible) => {
  if (visible === false) hideMainWindow(false);
  else showMainWindow();
  return { ok: true, visible: !!(mainWindow && mainWindow.isVisible()) };
});

/**
 * `D4` F11 全屏：切换主窗口（界面全局 keydown → preload 白名单 → 这里）。
 * 不自己记账全屏状态，始终按 Electron 的实时值取反（用户用系统快捷键退出全屏后仍一致）。
 */
ipcMain.handle('yuedu:fullscreen', () => {
  const win = mainWindow;
  if (!win || win.isDestroyed?.() === true) return { ok: false, error: 'NO_WINDOW' };
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  return { ok: true, fullscreen: next };
});

/**
 * 浮窗阅读开关（阅读页工具栏 / Esc 逃生）。
 * `mode` 省略 = 切换；'regular' / 'bar' = 打开指定形态；false = 退出。
 * 成功时用 `yuedu:float-state` 广播，渲染层据此切换形态与按钮文案。
 */
ipcMain.handle('yuedu:float-get', () => floatStatePayload());
ipcMain.handle('yuedu:float-open', (_e, mode) => {
  if (!mainWindow || mainWindow.isDestroyed?.() === true) return { ok: false, open: false, mode: floatMode, reason: 'no-window' };
  try {
    return toggleFloatReading(mode === 'regular' || mode === 'bar' ? mode : mode === false ? false : undefined);
  } catch (e) {
    log('[float] 打开失败：', msg(e));
    return { ok: false, open: floatOpen, mode: floatMode, reason: msg(e) };
  }
});
ipcMain.handle('yuedu:float-mode', (_e, mode) => {
  if (!mainWindow || mainWindow.isDestroyed?.() === true) return { ok: false, open: false, mode: floatMode, reason: 'no-window' };
  try {
    return switchFloatMode(mode);
  } catch (e) {
    log('[float] 切形态失败：', msg(e));
    return { ok: false, open: floatOpen, mode: floatMode, reason: msg(e) };
  }
});
ipcMain.handle('yuedu:float-close', () => exitFloatReading());

/* =========================================================================
 * `#453` 内嵌真浏览器 IPC（`WebContentsView` 常驻池）
 *
 * 与「登录窗」那套（`yuedu:login`）分开：登录窗是**一次性把 cookie 拿回来**；
 * 这里是**把真浏览器嵌进界面**——页面在里头自己跳转 / 返回，各页脚本照常执行。
 * 拿不到 `WebContentsView`（Electron < 30）时统一回 `{ok:false, error:'NOT_SUPPORTED'}` ⇒
 * 前端维持既有 iframe 通路（回落）。
 * ========================================================================= */

/** Electron 32+ 把历史判定搬到了 navigationHistory，旧版仍是 webContents.canGoBack —— 两形态都认 */
function canGo(wc, dir) {
  try {
    const h = wc.navigationHistory;
    if (h && typeof h.canGoBack === 'function') return dir === 'back' ? h.canGoBack() : h.canGoForward();
    return dir === 'back' ? wc.canGoBack() : wc.canGoForward();
  } catch {
    return false;
  }
}

function goHistory(wc, dir) {
  const h = wc.navigationHistory;
  if (h && typeof h.goBack === 'function') return dir === 'back' ? h.goBack() : h.goForward();
  return dir === 'back' ? wc.goBack() : wc.goForward();
}

function safeUrl(wc) {
  try { return wc.getURL(); } catch { return ''; }
}

/** 把 view 挂进主窗口（内嵌显示）。bounds 是**相对窗口内容区**的 CSS 像素 */
ipcMain.handle('yuedu:webview-open', async (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId, url, bounds } = payload || {};
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'BAD_URL' };
  const k = webviewKey(key, sourceId);
  try {
    const view = getOrCreateView(k);
    attachToMain(k, view, bounds);
    view.webContents.loadURL(target).catch((e) => log('[webview] 加载失败：', msg(e)));
    return { ok: true, key: k, url: target };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
});

/** 只调整位置 / 尺寸（窗口缩放或布局变化时调，不重新加载） */
ipcMain.handle('yuedu:webview-attach', (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId, bounds } = payload || {};
  const k = webviewKey(key, sourceId);
  const view = webViews.get(k);
  if (!view) return { ok: false, error: 'NO_VIEW' };
  attachToMain(k, view, bounds);
  return { ok: true, key: k };
});

/** 收起来（挂回隐藏 host，**不销毁**：TTL 内再打开还是同一个页面 / 同一份登录态） */
ipcMain.handle('yuedu:webview-detach', (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId } = payload || {};
  const k = webviewKey(key, sourceId);
  const view = webViews.get(k);
  if (!view) return { ok: false, error: 'NO_VIEW' };
  attachToHost(view);
  viewPool.setPinned(k, false);
  return { ok: true, key: k };
});

/** 导航：`{url}` 走新地址；`{action:'back'|'forward'|'reload'}` 走原生历史 */
ipcMain.handle('yuedu:webview-nav', async (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId, url, action } = payload || {};
  const k = webviewKey(key, sourceId);
  const view = webViews.get(k);
  if (!view) return { ok: false, error: 'NO_VIEW' };
  const wc = view.webContents;
  viewPool.acquire(k); // 用户操作也算「使用」⇒ 刷新 TTL
  try {
    if (url && /^https?:\/\//i.test(String(url))) {
      await wc.loadURL(String(url));
    } else if (action === 'back' || action === 'forward') {
      if (!canGo(wc, action)) return { ok: false, error: 'NO_HISTORY' };
      goHistory(wc, action);
    } else if (action === 'reload') {
      wc.reload();
    }
    return { ok: true, key: k, url: safeUrl(wc), canGoBack: canGo(wc, 'back'), canGoForward: canGo(wc, 'forward') };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
});

/** 页面内执行脚本（源侧要「代点按钮 / 取数据」时用；返回值必须可序列化） */
ipcMain.handle('yuedu:webview-exec', async (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId, js } = payload || {};
  const k = webviewKey(key, sourceId);
  const view = webViews.get(k);
  if (!view) return { ok: false, error: 'NO_VIEW' };
  try {
    const value = await view.webContents.executeJavaScript(String(js || ''));
    return { ok: true, key: k, value };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
});

/**
 * `#568` P3 站点定制：给当前 view 注入 CSS/JS。
 *
 * 为什么是**独立 IPC** 而不是塞进 `webview-open`：页面内跳转（点链接）走 Chromium 原生导航，
 * 前端只能收到 `navigated` 事件 —— 那时地址变了，必须**按新地址重新解析**定制再注入。
 * `insertCSS` 是**追加**语义（不覆盖之前注入的），重复调用会叠加 ⇒ 每次导航只注入一次
 * （前端在 `navigated` 后调本接口；文档销毁时旧样式自然失效）。
 */
ipcMain.handle('yuedu:webview-inject', async (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId, css, js } = payload || {};
  const k = webviewKey(key, sourceId);
  const view = webViews.get(k);
  if (!view) return { ok: false, error: 'NO_VIEW' };
  const wc = view.webContents;
  try {
    const c = String(css || '');
    const j = String(js || '');
    if (c) await wc.insertCSS(c);
    if (j) await wc.executeJavaScript(j);
    return { ok: true, key: k };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
});

/* ---- 浮窗自身的交互（拖动 / 外观设置）——与设置页共用同一份 prefs ---- */
/**
 * 拖动：渲染层发屏幕坐标增量，主进程按**当前形态**钳制后 `setBounds`。
 * 不走 `-webkit-app-region: drag`：Windows 上 drag 区会吞掉鼠标事件，
 * 导致「看得见、点不到」（用户 2026-11-08 的歌词四按钮问题）。
 * 位置由 `move`/`resize` 事件按形态落盘（`floatLyricsX/Y` ⇄ `floatRegularX/Y/W/H` ⇄ `floatBarX/Y/W/H`）。
 */
ipcMain.on('yuedu:float-move', (_e, raw) => {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  // 锁定拖动只约束歌词/常规；条形态的 🔒 是「点击穿透」，穿透关掉就该能拖（用户实机反馈）
  if (floatMode !== 'bar' && prefs.floatDragLocked === true) return;
  const dx = Math.round(Number(raw && raw.dx));
  const dy = Math.round(Number(raw && raw.dy));
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
  try {
    const b = lyricsWin.getBounds();
    const wa = lyricsWorkArea(b, b.x, b.y);
    const min = floatMode === 'bar' ? lib.FLOAT_BAR_MIN_SIZE
      : floatMode === 'regular' ? lib.FLOAT_MIN_SIZE
        : null;
    const next = min
      ? lib.clampWindowBounds({ ...b, x: b.x + dx, y: b.y + dy }, wa, min)
      : lib.clampLyricsBounds({ ...b, x: b.x + dx, y: b.y + dy }, wa);
    lyricsWin.setBounds(next);
  } catch { /* ignore */ }
});

/**
 * 歌词形态自定义缩放（只在未锁定时允许）。
 *
 * 为什么不用系统缩放边框：浮窗是 `frame:false + transparent:true`，Windows 上
 * 实测 `GWL_STYLE` 里连 `WS_THICKFRAME` 都没有（STYLE=0x14000000），
 * 透明无边框窗没有可抓的原生缩放边缘 —— 只把 `resizable` 置 true 用户也拉不动。
 * 所以由渲染层贴边 pointerdown 发增量，主进程自己改几何（与拖动同一条 IPC 思路）。
 */
const FLOAT_RESIZE_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

ipcMain.on('yuedu:float-resize', (_e, raw) => {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  if (floatMode !== 'lyrics' || prefs.floatDragLocked === true) return;
  const edge = String((raw && raw.edge) || '');
  const dx = Math.round(Number(raw && raw.dx));
  const dy = Math.round(Number(raw && raw.dy));
  if (!FLOAT_RESIZE_EDGES.has(edge) || !Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
  try {
    const b = lyricsWin.getBounds();
    const wa = lyricsWorkArea(b, b.x, b.y);
    const min = { width: 320, height: 48 };
    let x = b.x;
    let y = b.y;
    let width = b.width;
    let height = b.height;
    if (edge.includes('e')) width = Math.max(min.width, b.width + dx);
    if (edge.includes('s')) height = Math.max(min.height, b.height + dy);
    if (edge.includes('w')) { width = Math.max(min.width, b.width - dx); x = b.x + b.width - width; }
    if (edge.includes('n')) { height = Math.max(min.height, b.height - dy); y = b.y + b.height - height; }
    width = Math.min(width, wa.width);
    height = Math.min(height, wa.height);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - height);
    // 用户手动改过尺寸 ⇒ 未锁定期间不再按内容自动量高（锁定后复位）
    floatLyricsUserSized = true;
    lyricsApplyingBounds = true;
    lyricsWin.setBounds({ x, y, width, height });
    setTimeout(() => { lyricsApplyingBounds = false; }, 300);
    scheduleFloatGeometrySave();
  } catch { /* ignore */ }
});

/** 浮窗设置面板只允许改这几个外观/拖动字段（其余偏好仍只走设置页） */
const FLOAT_PATCH_KEYS = [
  'floatFontSize', 'floatTextColor', 'floatBgColor', 'floatBgOpacity',
  'floatDragLocked', 'floatShowNeighbors',
];

ipcMain.on('yuedu:float-patch', (_e, raw) => {
  if (!raw || typeof raw !== 'object') return;
  const patch = {};
  for (const key of FLOAT_PATCH_KEYS) if (key in raw) patch[key] = raw[key];
  if (Object.keys(patch).length === 0) return;
  const before = { ...prefs };
  const normalized = lib.normalizePrefs({ ...prefs, ...patch });
  prefs = normalized.prefs;
  prefsWarnings = normalized.warnings;
  const saved = savePrefs();
  if (saved.ok === false) log('[float] 偏好落盘失败：', saved.error);
  // 锁定 ⇒ 复位「用户尺寸」标记：下一次内容高度上报重新按内容量高
  // （解锁/锁定本身不动 bounds，所以不会跳位置/尺寸）
  if ((before.floatDragLocked === true) !== (prefs.floatDragLocked === true) && prefs.floatDragLocked === true) {
    floatLyricsUserSized = false;
  }
  refreshLyricsWindowHeight(before.floatFontSize, before.floatShowNeighbors);
  if (floatMode === 'bar' || floatMode === 'regular') applyFloatClickThrough();
  syncLyricsWindow();
  sendFloatUpdate();
  sendFloatState();
});

/** 设置面板开合：歌词/条形窗只有几行高，面板装不下 ⇒ 按实测面板高度向上加高，关掉缩回 */
ipcMain.on('yuedu:float-panel', (_e, payload) => {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  if (floatMode !== 'lyrics' && floatMode !== 'bar') return;
  const open = payload === true || (payload && payload.open === true);
  const measured = payload && typeof payload === 'object' ? Number(payload.height) : 0;
  try {
    const wasOpen = floatPanelOpen;
    floatPanelOpen = open;
    const b = lyricsWin.getBounds();
    const wa = lyricsWorkArea(b, b.x, b.y);
    // 用渲染层实测高度（夹在合理区间），测不到时才退回固定值；记下来给字号变化复用
    const extra = Number.isFinite(measured) && measured > 0
      ? Math.min(260, Math.max(80, Math.round(measured)))
      : FLOAT_PANEL_EXTRA_H;
    floatPanelExtra = extra;
    // 未锁定且用户手动拉过尺寸 ⇒ 面板开合也不改窗高（由用户自己决定窗口多大）
    if (floatMode === 'lyrics' && floatLyricsUserSized && prefs.floatDragLocked !== true) return;
    let base;
    if (floatMode === 'bar') {
      // 基准 = 条形态实测内容高；还没上报时按当前窗高（面板敞着则先减掉面板）反推
      base = floatBarFitHeight
        || (wasOpen ? Math.max(lib.FLOAT_BAR_MIN_SIZE.height, b.height - extra) : b.height);
    } else {
      // 基准取「静态三行估算」与「实测内容高」的较大者：长句换行时开面板不该反而缩高
      base = lyricsBaseHeight();
    }
    let height = floatPanelOpen ? base + extra : base;
    if (floatMode === 'bar') height = Math.max(lib.FLOAT_BAR_MIN_SIZE.height, Math.min(600, height));
    const y = Math.max(wa.y, b.y + b.height - height);
    lyricsApplyingBounds = true;
    lyricsWin.setBounds({ x: b.x, y, width: b.width, height });
    setTimeout(() => { lyricsApplyingBounds = false; }, 300);
  } catch { /* ignore */ }
});

/**
 * 原生取色器需要窗口可聚焦（浮窗平时 `focusable:false`，点不亮系统色盘）。
 * 只在取色期间临时打开，选完/失焦立刻恢复 —— 与「常规态不抢焦点」不冲突。
 */
ipcMain.on('yuedu:float-focusable', (_e, on) => {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  try {
    lyricsWin.setFocusable(on === true);
    if (on !== true) lyricsWin.blur();
  } catch { /* ignore */ }
});

/**
 * 歌词长句按容器宽换行后，真实行数可能多于「三行」的静态估算。
 * 渲染层量完内容高度后上报 ⇒ 底边不动、向上长，保证多行完整可见（不截断）。
 * 设置面板敞着时不缩（面板自身另有一套加高逻辑）。
 */
ipcMain.on('yuedu:float-height', (_e, raw) => {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  if (floatMode !== 'lyrics' && floatMode !== 'bar') return;
  const h = Math.round(Number(raw));
  if (!Number.isFinite(h)) return;
  // 下限与各形态的最矮窗一致；上限防一条病态长句/超长标题把窗口顶到屏幕外
  const target = floatMode === 'bar'
    ? Math.max(lib.FLOAT_BAR_MIN_SIZE.height, Math.min(600, h))
    : Math.max(48, Math.min(600, h));
  if (floatMode === 'bar') {
    // 记下实测内容高：面板开合/字号变化都以它为基准
    floatBarFitHeight = target;
    if (floatPanelOpen) {
      // 面板敞着时正文区高度变了 ⇒ 窗高 = 新正文高 + 面板高（底边不动）
      const withPanel = Math.max(lib.FLOAT_BAR_MIN_SIZE.height, Math.min(600, target + floatPanelExtra));
      try {
        const b = lyricsWin.getBounds();
        if (Math.abs(b.height - withPanel) < 2) return;
        const y = Math.max(0, b.y + b.height - withPanel);
        lyricsApplyingBounds = true;
        lyricsWin.setBounds({ x: b.x, y, width: b.width, height: withPanel });
        setTimeout(() => { lyricsApplyingBounds = false; }, 300);
      } catch { /* ignore */ }
      return;
    }
  } else {
    // 记下实测内容高：面板开合/字号变化都以它为基准，避免长句时反而缩高
    floatFitHeight = target;
    // ★ 未锁定且用户手动拉过尺寸 ⇒ 以用户尺寸为准：只记住内容高，不再改窗高。
    //   （锁定窗口后 floatLyricsUserSized 复位，下一次上报重新按内容量高。）
    if (floatLyricsUserSized && prefs.floatDragLocked !== true) return;
    if (floatPanelOpen) return; // 面板敞着时由面板那套高度负责，正文高度先记着
  }
  try {
    const b = lyricsWin.getBounds();
    // 2px 死区：避免亚像素取整来回触发 setBounds
    if (Math.abs(b.height - target) < 2) return;
    // 一次设到位：直接给目标尺寸，不分成多次/多阶段调整
    const y = Math.max(0, b.y + b.height - target);
    lyricsApplyingBounds = true;
    lyricsWin.setBounds({ x: b.x, y, width: b.width, height: target });
    setTimeout(() => { lyricsApplyingBounds = false; }, 300);
  } catch { /* ignore */ }
});

/** 只读状态（能否进退 / 当前 URL / 是否已挂进主窗口） */
ipcMain.handle('yuedu:webview-status', (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId } = payload || {};
  const k = webviewKey(key, sourceId);
  const view = webViews.get(k);
  if (!view) return { ok: true, key: k, exists: false };
  const rec = viewPool.peek(k);
  return {
    ok: true,
    key: k,
    exists: true,
    url: safeUrl(view.webContents),
    pinned: !!(rec && rec.pinned),
    canGoBack: canGo(view.webContents, 'back'),
    canGoForward: canGo(view.webContents, 'forward'),
  };
});

/** 关掉某会话的 view（**不删 partition**：登录态在磁盘上，重开即复用） */
ipcMain.handle('yuedu:webview-close', (_e, payload) => {
  if (!VIEW_SUPPORTED) return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId } = payload || {};
  const k = webviewKey(key, sourceId);
  return { ok: true, key: k, closed: destroyView(k) };
});

/**
 * `#456` 读内嵌 view 所在 partition 的 cookie（**只读**，不回传服务端）。
 *
 * 为什么要单独一条：内嵌 view 的 cookie 在 Electron 的 `persist:src-<id>` partition 里，而服务端
 * 那只 CDP 浏览器读的**是另一个进程的 profile** —— 服务端的 `harvest` 端点拿不到桌面端这份，
 * 只能由渲染进程读出来再 `POST /api/sources/:id/login/cookies` 回传（域过滤/合并/落盘都在服务端）。
 * 所以主进程只负责「读出它自己拥有的 partition」这一件事，网络与业务判据不在这里重写。
 */
ipcMain.handle('yuedu:webview-cookies', async (_e, payload) => {
  if (!VIEW_SUPPORTED || typeof session?.fromPartition !== 'function') return { ok: false, error: 'NOT_SUPPORTED' };
  const { key, sourceId } = payload || {};
  const k = webviewKey(key, sourceId);
  try {
    const list = await session.fromPartition(viewpoolLib.partitionFor(k)).cookies.get({});
    return {
      ok: true,
      key: k,
      cookies: list.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
    };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
});

/* =========================================================================
 * 启动
 * ========================================================================= */

/**
 * 绿色 zip 首次运行自建两个快捷方式（用户 2026-11-25：发布形态只留 zip）。
 *
 * 为什么不做安装器：`setup.exe` 本身是**全新未签名的 hash**，SAC 大概率照样拦，
 * 套在 zip 里也一样；而「解压即用 + 首次运行自建两个入口」不新增任何 PE、
 * 不写安装目录，体验等价。入口 = `YueDu.exe` 与 `YueDu.exe --server-only`。
 *
 * 只建一次（`prefs.shortcutsCreated` 落盘）：用户自己删掉后不会每次启动又冒出来。
 * 开发态 / 非 Windows 直接跳过（不污染开发者桌面，测试桩也不会瞎调 Electron API）。
 */
function ensureGreenShortcuts() {
  if (prefs.shortcutsCreated === true) return;
  if (process.platform !== 'win32' || !app.isPackaged) return;
  let desktopDir;
  try { desktopDir = app.getPath('desktop'); } catch (e) { log('[shortcuts] 取桌面目录失败', msg(e)); return; }
  const iconPath = path.join(process.resourcesPath, 'icon-server.ico');
  let plan;
  try {
    plan = lib.planGreenShortcuts({
      exePath: process.execPath,
      desktopDir,
      iconPath: fs.existsSync(iconPath) ? iconPath : '',
    });
  } catch (e) {
    log('[shortcuts] 生成计划失败', msg(e));
    return;
  }
  let ok = 0;
  for (const s of plan) {
    try {
      // create 在目标已存在时返回 false；已存在就用 update（同样指向本 exe）
      const op = fs.existsSync(s.path) ? 'update' : 'create';
      const written = shell.writeShortcutLink(s.path, op, {
        target: s.target,
        args: s.args,
        cwd: s.cwd,
        description: s.description,
        icon: s.icon,
        iconIndex: s.iconIndex,
      });
      if (written) { ok += 1; log('[shortcuts] 已写入', s.path); }
      else log('[shortcuts] 写入失败（writeShortcutLink 返回 false）', s.path);
    } catch (e) {
      log('[shortcuts] 写入异常', s.path, msg(e));
    }
  }
  if (ok === plan.length) {
    prefs.shortcutsCreated = true;
    const r = savePrefs();
    if (!r || !r.ok) log('[shortcuts] 标记未落盘（下次启动会再建一次）：', r && r.error);
  } else {
    log(`[shortcuts] 仅成功 ${ok}/${plan.length}，未置标记，下次启动重试`);
  }
}

/**
 * ★ 每一步**各自** try/catch，且 `createWindow()` 放在最后 ——
 *   任何一项桌面能力（托盘/快捷键/注册表）出问题都**不能**让窗口不见，
 *   否则用户看到的就是「双击了，什么都没发生」（`#209` 修的那个 `registerRenderer`
 *   未定义就属于这一类：它把整条启动链打断在开窗之前）。
 */
async function bootstrap() {
  // `#463②`：**先给用户一个可见的窗口**，再去做那些要几秒的启动步骤（旧实现这段全黑）
  // `--server-only` 没有主窗口，splash 也不开（否则屏幕上会多一扇无处可去的窗）
  if (!SERVER_ONLY) createSplash();
  try { loadPrefs(); } catch (e) { log('[desktop-prefs] 读取异常：', msg(e)); }
  // 同一数据目录只允许一个壳（PC 客户端 / 独立服务端各自目录才能并存）
  const lock = acquireShellLock(resolveDataDir());
  if (!lock.ok) {
    log('[shell-lock] 获取失败：', lock.message);
    try {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: '数据目录已被占用',
        message: '同一数据目录只允许一个悦读壳运行',
        detail:
          `${lock.message}\n\n`
          + `数据目录：${resolveDataDir()}\n\n`
          + 'PC 客户端与独立服务端各自使用独立数据目录时才能同时运行；\n'
          + '只有指向同一目录时才互斥。请退出另一端，或在设置里换一个数据目录。',
        buttons: ['退出'],
      });
    } catch { /* 无桌面会话时退回日志 */ }
    app.quit();
    return;
  }
  // 绿色 zip：首次运行自建「悦读」「悦读服务」两个桌面快捷方式（PC / 服务壳都跑一次）
  try { ensureGreenShortcuts(); } catch (e) { log('[shortcuts] 未捕获异常：', msg(e)); }
  if (!SERVER_ONLY) {
    splashStep('正在启动渲染桥…');
    try { await startRenderBridge(); } catch (e) { log('[render-bridge] 启动异常：', msg(e)); }
  }
  splashStep('正在启动本地服务…');
  let serverReady = true;
  try { serverReady = await ensureServer(); } catch (e) { log('[server] 启动异常：', msg(e)); }
  // 互斥：端口上是另一套悦读 / 别的程序 ⇒ 已给出明确提示，直接退出，不要开一个空窗口
  if (serverReady === false) { app.quit(); return; }
  if (!SERVER_ONLY) {
    splashStep('正在注册渲染桥…');
    try { await registerRenderer(); } catch (e) { log('[render-bridge] 注册异常：', msg(e)); }
  }
  splashStep('正在准备托盘与快捷键…');
  try { createTray(); } catch (e) { trayError = msg(e); log('[tray] 创建异常：', trayError); }
  if (!SERVER_ONLY) {
    try { applyShortcut(); } catch (e) { log('[shortcut] 应用异常：', msg(e)); }
  }
  if (SERVER_ONLY) {
    // 服务壳模式到此为止：不建主窗口、不注册文件关联、不装歌词/验证码窗口
    log(`[server-only] 就绪：仅托盘 + 服务（${URL_BASE}）；点托盘双击/「打开界面」用系统浏览器打开`);
    if (!tray) {
      log('[server-only] 托盘不可用 —— 只能靠任务管理器结束进程');
      try {
        dialog.showMessageBoxSync({
          type: 'warning',
          title: '托盘不可用',
          message: '服务已启动，但托盘图标创建失败',
          detail: `${trayError || '未知原因'}\n\n界面地址：${URL_BASE}\n（没有托盘就无法从界面退出服务，请检查 assets/tray.png 后重试）`,
          buttons: ['知道了'],
        });
      } catch { /* 无桌面会话 */ }
    } else if (firstRun || (!prefs.dataDir && !(Number(prefs.serverPort) >= 1024))) {
      // 首次运行 / 没有任何自定义配置：托盘是唯一入口 —— 直接把「服务设置」亮出来，别让人靠猜
      log('[server-only] 首次运行或未配置：自动打开服务设置');
      openServerSettingsWindow();
      notifyTray('悦读服务已在托盘运行', '右键托盘图标 →「服务设置」可改端口与数据目录；双击托盘图标用浏览器打开界面。');
    }
    if (process.env.YUEDU_SELFCHECK) await writeSelfcheck();
    return;
  }
  splashStep('正在打开界面…');
  createWindow();
  // 桌面歌词：锁屏/休眠隐藏，恢复后按播放状态回来（失败不影响主界面）
  try { installLyricsPowerWatch(); } catch (e) { log('[lyrics] 电源监听启动异常：', msg(e)); }
  // `#727` 验证码输入窗：服务端一有 pending 就开内置窗口（失败不影响主界面）
  try { startVerifyCodeWatch(); } catch (e) { log('[verify-code] 轮询启动异常：', msg(e)); }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (argvBookFiles.length) {
    log('[open-file] 启动参数里带书文件：' + argvBookFiles.map((p) => path.basename(p)).join('、'));
    sendOpenFiles(argvBookFiles.map(readBookFileForRenderer));
  }
  // `#347`：app **未运行**时点导入链接 ⇒ 本进程带着 URL 冷启动。
  // 此刻窗口/渲染进程刚建，可能还没挂监听 ⇒ 先入队，握手后（renderer-ready）再补发。
  if (argvSchemeUrls.length) {
    log('[scheme-url] 启动参数里带深链：' + argvSchemeUrls.length + ' 条');
    for (const u of argvSchemeUrls) pendingSchemeUrls.push(u);
    if (rendererReady) flushSchemeUrls();
  }
  if (process.env.YUEDU_SELFCHECK) void writeSelfcheck();
}

/**
 * `#209` 自检出口：把所有**能在主进程里判定**的事实写成 JSON 后退出。
 * 由 `scripts/probe-209-desktop.mjs` 驱动（它还会顺带用 CDP 看渲染进程一侧 + 查服务端书架）。
 * 本机起不了 Electron ⇒ 这条路径只能在**有桌面会话**的机器上跑。
 *
 * ★ 退出前要**等渲染进程握手 + 一段宽限期**：自检的一项就是「双击 txt 会不会真的进书架」，
 *   而导入是在渲染进程里做的 —— 报告一写完就退，会把这一项测成「没发生」。
 *   宽限期由 `YUEDU_SELFCHECK_GRACE_MS` 控制（默认 4000ms，探针会调大）。
 */
async function writeSelfcheck() {
  const out = path.resolve(String(process.env.YUEDU_SELFCHECK));
  const waitStart = Date.now();
  while (!rendererReady && Date.now() - waitStart < 20000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const grace = Math.max(0, Number(process.env.YUEDU_SELFCHECK_GRACE_MS ?? 4000));
  if (grace > 0) await new Promise((r) => setTimeout(r, grace));

  let serverPing = false;
  try { serverPing = await ping(); } catch { /* 服务没起来就是 false */ }
  const held = prefs.shortcutEnabled ? globalShortcut.isRegistered(prefs.shortcut) === true : false;
  const report = {
    ok: true,
    at: new Date().toISOString(),
    /**
     * ★ 防空转断言：`process.versions.electron` 只有**真 Electron 进程**里才有值。
     * 探针（`scripts/probe-209-desktop.mjs`）必须断言它为 `true` —— 否则「报告写出来了」
     * 也可能只是有人用普通 node 跑了一遍桩，跟「桌面端能用」毫无关系。
     * （`apps/desktop/tests/main-smoke.test.mjs` 正是在普通 node 下跑本函数，它那里是 `false`。）
     */
    isElectron: !!process.versions.electron,
    packaged: app.isPackaged,
    port: PORT,
    serverPing,
    singleInstance: { allowedMulti: singleInstance.allowedMulti, lost: singleInstance.lost },
    prefsFile: desktopPrefsFile(),
    prefs,
    prefsWarnings,
    tray: tray ? { ok: true } : { ok: false, reason: trayError || '未创建' },
    // 两个判据都交出去：register() 的返回值 与 isRegistered() 的独立复核
    shortcut: { ...shortcutState, held },
    autoLaunch: autoLaunchState(),
    fileAssoc: await queryFileAssoc(),
    protocolAssoc: await queryProtocolAssoc(), // `#347`
    argvBookFiles,
    argvSchemeUrls, // `#347`：启动参数里带的深链（探针据此断「链接唤起」这一项）
    pendingOpenFiles: pendingOpenFiles.map((f) => f.name),
    rendererReady,
    windowVisible: !!(mainWindow && mainWindow.isVisible()),
    versions: { electron: process.versions.electron, node: process.versions.node },
  };
  try {
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    log('[selfcheck] 已写出 ' + out);
  } catch (e) {
    log('[selfcheck] 写盘失败：', msg(e));
  }
  // 自检模式下一律退出（探针会自己收进程；这里主动退更干净）
  setTimeout(() => quitApp(), 300);
}

if (!singleInstance.lost) {
  app.whenReady().then(async () => {
    log('app 启动');
    try { await bootstrap(); } catch (e) { log('[bootstrap] 未捕获异常：', msg(e)); }
  });
}

/**
 * ★★ `quitting` 必须在 **`before-quit`** 置位，不能只在 `will-quit`。
 *
 * Electron 的退出顺序是：`before-quit` → **逐个关窗口（每个都会发 `close`，可 preventDefault）**
 * → `will-quit` → `quit`。
 * 只在 `will-quit` 置位的话，关窗口那一步看到的 `quitting` 仍是 `false`
 * ⇒ 被 `closeToTray` 拦下 ⇒ **点了退出却退不掉**（只把窗口收进托盘）。
 * 这条由 `tests/main-smoke.test.mjs`「退出时不再拦截关闭」钉住。
 */
/** `#757` E：关闭前的 KV flush 只做一次（否则 app.quit() 会再次进本回调） */
let flushBeforeQuitDone = false;

app.on('before-quit', (e) => {
  quitting = true;
  /**
   * `#757` E：**桌面关闭前先把服务端的异步写队列 flush 掉**。
   *
   * Windows 的 `serverProc.kill()` 是 `TerminateProcess`（不走 POSIX 信号）⇒ 服务端
   * `process.on('exit')` 里的 `kvStore.flushSync()` 不会执行，300ms 防抖窗口内的
   * 源变量 / 登录信息 / 章节缓存会丢。这里改为「先 POST /api/system/flush 并等响应，再真正退出」。
   *
   * 只延后一次、最多 2s（服务端卡住不能反过来卡死用户退出）；复用的外部服务不归我们管，不等。
   * 自检探针会**不带事件参数**调用本监听（见 tests/main-smoke.test.mjs），故必须判 `e.preventDefault` 是否存在。
   */
  if (!e || typeof e.preventDefault !== 'function' || flushBeforeQuitDone || !serverProc) return;
  flushBeforeQuitDone = true;
  e.preventDefault();
  const finish = () => { try { app.quit(); } catch { /* 退都退了 */ } };
  Promise.race([
    fetch(`${URL_BASE}/api/system/flush`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2200)),
  ]).finally(finish);
});

app.on('will-quit', () => {
  quitting = true;
  if (verifyCodeWatch) { clearInterval(verifyCodeWatch); verifyCodeWatch = null; }
  if (serverStableTimer) { clearTimeout(serverStableTimer); serverStableTimer = null; }
  try { globalShortcut.unregisterAll(); } catch { /* 退都退了 */ }
  /*
   * 退出顺序的最后两步：**结束服务进程树**（含 batch-child / dom-worker）→ 托盘清理。
   * 这里不能再直接 `serverProc.kill()`：那只杀直接子进程，batch-child 会变成孤儿继续占数据目录。
   */
  killServerTree();
  releaseShellLock();
  if (tray) { try { tray.destroy(); } catch { /* 已销毁 */ } tray = null; }
});

app.on('window-all-closed', () => {
  // `--server-only` 没有主窗口：设置小窗关掉不等于退出服务
  if (SERVER_ONLY) return;
  quitApp();
});
