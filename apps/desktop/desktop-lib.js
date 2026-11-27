/**
 * SPDX-License-Identifier: GPL-3.0-only
 * 桌面朗读歌词的纯判定（`normalizeLyricsState` / `lyricsShouldShow` / `lyricsBoundsFromPrefs`）
 * 设计参考：byl669/legado-lyrics-overlay（GPL-3.0）
 *   app/src/main/java/io/legado/app/service/ReadAloudLyricsWindow.kt 的 `canShow()` 五重门槛
 * 修改：门槛改为「开关 + 朗读中 + 非暂停 + 有当前句 + 主窗失焦 + 未锁屏」的显式条件，
 *   并新增位置夹取（多显示器/分辨率变化时不让窗跑到屏幕外）。
 *
 * 桌面端（Electron 外壳）的**纯逻辑**：不 `require('electron')`、不读盘、不写注册表。
 *
 * ## 为什么要单独一个文件（`#209`）
 * 本机（Agent 沙箱）**起不了 Electron**：清掉 `ELECTRON_RUN_AS_NODE` 后直接运行
 * `electron.exe .` —— 进程秒退、stdout/stderr 全空、无 CDP 端口（2026-10-06 实测三次，
 * 含换 PORT / 换数据目录 / 显式 `--remote-debugging-port`）。
 * ⇒ 「托盘建出来了没 / 快捷键真注册上了没」这类事在开发期**拿不到运行态证据**。
 *
 * 对策：把所有**可判定**的部分（偏好归一 / argv 取书文件 / 注册表计划 / 托盘菜单结构 /
 * `reg query` 输出解析）收进本文件 —— 它只用 node 内置模块，`node --test` 就能真跑。
 *
 * ⚠️ **边界必须说清**：本文件证明的是「**决策**对不对」，**不是**「Windows 真的照做了」。
 * 后者只能由 `selfcheck.mjs`（在**有桌面会话**的机器上真起 Electron）与用户手工双击取证。
 * 别把这里的绿当成端到端通过。
 */
'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * 小窗/浮窗的**统一最小宽高**（用户 2026-11-08：与 Web 端小窗一致，且只在一处定义）。
 *
 * 数字放在 `float-geometry.json`：本文件（主进程）`require`，Web 端
 * `apps/web/src/components/ReaderMiniBar.vue` 相对导入同一份 —— 两边读的是**同一个文件**，
 * 不存在「桌面改了下限、Web 还写着 180/120」的漂移。
 */
const FLOAT_GEOMETRY = require('./float-geometry.json');
const FLOAT_MIN_SIZE = Object.freeze({
  width: FLOAT_GEOMETRY.minWidth,
  height: FLOAT_GEOMETRY.minHeight,
});
/**
 * 小窗顶部**浮现热区高度**（与 Web 侧 `reader-float-shared.ts` 的 `DOCK_REVEAL_H` 同源）。
 *
 * 用户 2026-11-09：热区判定按 Y、横向不限，整条工具条的高度带都要在热区里 ——
 * 桌面前一会话用「把标题栏 padding 压到 8px」去迁就渲染层的 44px，Web 侧共享常量又是 48，
 * 三处数字各写一遍。现在只留 `float-geometry.json` 这一个值：Web 用它当阈值，
 * 桌面注入的 CSS 用它当标题栏最小高度 ⇒ 鼠标在条内任意位置都不收起。
 */
const FLOAT_HEAD_ZONE_H = FLOAT_GEOMETRY.headZoneHeight;
/** 字色 / 背景色预设表（与 Web `FONT_COLORS` / `BG_COLORS` 同源，避免两端各写五组十六进制） */
const FLOAT_PALETTE = Object.freeze({
  text: FLOAT_GEOMETRY.palette.text,
  bg: FLOAT_GEOMETRY.palette.bg,
});

/* ------------------------------------------------------------------ *
 * 支持的本地书后缀
 * ------------------------------------------------------------------ */

/**
 * ★ 只登记**引擎真支持**的（`#202` 起 txt / epub；`#212` Step4 起补 pdf / mobi / azw3）。
 *
 * 为什么每个格式都要「引擎先做出来」才登记：文件关联是**系统级承诺** —— 把没支持的格式
 * 登记进去，用户双击后会打开阅读、然后拿到一句「暂不支持 X」⇒ 比不登记更糟。
 * `#212` 后续再加格式时，这里同步加（**只有一处**，见 `notes-desktop.md` §6）。
 */
const BOOK_EXTS = Object.freeze(['txt', 'epub', 'umd', 'pdf', 'mobi', 'azw3']);
const BOOK_FILE_RE = /\.(txt|epub|umd|pdf|mobi|azw3)$/i;

/** 这个路径看起来是不是一个「阅读支持的本地书文件」 */
function isBookFile(p) {
  return typeof p === 'string' && BOOK_FILE_RE.test(p);
}

/**
 * 单个本地书的体量上限（**与 `apps/server/src/index.ts` 的 `bodyLimit` 同值**）。
 *
 * 为什么桌面端要自己判一次：双击打开时文件字节要**经 IPC 传到渲染进程**再 POST 上去，
 * 超限的文件等于把几十上百 MB 白搬一趟，最后还是被服务端 413 拒。
 * ⚠️ 这个数字与服务的 `bodyLimit` 是**同一个判据写了两遍**（必然漂移的那种），
 * 所以 `tests/desktop-lib.test.mjs` 有一条测试**直接读服务端源码**断言两者相等 ——
 * 改一处不改另一处会**红**。
 */
const MAX_BOOK_BYTES = 256 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 桌面偏好
 * ------------------------------------------------------------------ */

/**
 * 默认值。
 *
 * · `closeToTray: true` —— 「点 X 收进托盘」是阅读器的常见期待（关了窗口还要继续听/继续读），
 *   也是本项的验收口径「最小化到托盘」的一部分。**但 `app.isQuitting` 时必须真退出**（见 main.js）。
 * · `minimizeToTray: false` —— 点最小化时**默认仍进任务栏**：Windows 用户对「最小化」的预期
 *   就是任务栏，把它改成托盘会让「最小化后找不到了」变成新的困惑。想要的人自己开。
 * · `shortcut` 用 `CommandOrControl` 而不是写死 `Ctrl` —— Electron 的跨平台写法，
 *   在 Windows 上等价 `Control+Shift+Y`。
 */
/**
 * 浮窗两态（用户 2026-11-09 拍板：四态 → 两态，取消迷你档）。
 *  ① 常规：420×320（不是下限，是浮窗的一档；用户可缩到 FLOAT_MIN_SIZE 180×120）；
 *  ② 条形：920×140（≈三行歌词观感，宽度跟随阅读面板，最宽 920）。
 * ★ 两态都是**独立无边框浮窗**（不再拿主窗变形），主窗进小窗时直接 hide()。
 * ★ 两态几何分别落盘（`floatRegularX/Y/W/H` 与 `floatBarX/Y/W/H`）；
 *   形态本身**不落盘** ⇒ 重启回正常主窗。
 */
const FLOAT_REGULAR_SIZE = Object.freeze({ width: 420, height: 320 });
/**
 * 条形档。
 *
 * ★ 高度按「歌词条」观感取 140（约三行：上一行 / 当前行 / 下一行）；
 *   宽度默认 920 = 阅读面板的既有最大宽度（`ReaderOverlay` 的 `.se-panel` 是 `min(920px, 100%)`），
 *   即用户说的「宽度与阅读界面宽度相同」。进入时若主窗更窄，取主窗内容宽度。
 * ★ 条形档是独立浮窗（复用歌词窗的 OS 级置顶无边框技术），**不随主窗变形**。
 */
const FLOAT_BAR_SIZE = Object.freeze({ width: 920, height: 140 });
/**
 * 条形档最小尺寸：高度与歌词窗同一档（48）。
 * ★ 条形窗高由渲染层按「可见行真实高度」上报（`yuedu:float-height`）⇒
 *   下限必须低于三行内容高，否则多出来的高度会让视口露出第 4 行（用户实测「4 行」）。
 */
const FLOAT_BAR_MIN_SIZE = Object.freeze({ width: 320, height: 48 });
/** 正常主窗下限（与小窗无关；浮窗默认尺寸恰好同值） */
const NORMAL_MIN_SIZE = Object.freeze({ width: 420, height: 320 });

/**
 * 条形档滚动速度：1 慢 / 2 中 / 3 快（毫秒 = 每行向上滚动一次的时间）。
 * 默认 2；渲染层与设置页共用这一份映射，避免两边各写一套数字。
 */
const BAR_SPEED_MS = Object.freeze({ 1: 4200, 2: 2600, 3: 1600 });

const DEFAULT_PREFS = Object.freeze({
  /**
   * 本地服务端口。**0 = 跟随形态默认**（PC 客户端 3100 / 独立服务端 3000）；
   * 一旦用户在设置里改过，就固定用改后的值。环境变量 `PORT` 仍然最高优先。
   * 为什么要允许 0：两个壳共用同一份偏好结构，但默认端口必须按形态分开，
   * 否则「服务端 exe + YueDu.exe 同时运行」会默认抢同一个端口。
   */
  serverPort: 0,
  /**
   * 数据目录覆盖；空串 = 用默认（打包态 `userData/yuedu-data`，开发态仓库 `data/`）。
   * 改这里只切目录、不复制旧数据；旧数据留在原目录，由用户自行迁移。
   */
  dataDir: '',
  /**
   * 壳级日志开关（`server.log`）。关掉后不再把子进程 stdout/stderr 落盘；
   * 只做开/关，不做分级/轮转（需要时再扩）。
   */
  logsEnabled: true,
  closeToTray: true,
  minimizeToTray: false,
  shortcutEnabled: true,
  shortcut: 'CommandOrControl+Shift+Y',
  /** 只在**第一次**收起窗口时弹一次托盘气泡（弹第二次就是打扰） */
  trayHintShown: false,
  /**
   * 绿色 zip 首次运行自建的两个快捷方式（用户 2026-11-25：发布形态只留 zip）。
   * 只建一次并落盘；用户之后自己删掉，也不会每次启动又冒出来。
   */
  shortcutsCreated: false,
  /**
   * 桌面朗读歌词悬浮窗（`#` 本轮新增）。
   *
   * 默认 **false**：它是一扇系统级置顶窗，首次见到就弹出来比「找不到入口」更打扰；
   * 另一个依据是参照项目 `legado-lyrics-overlay` 的 `getPrefBoolean(PreferKey.readAloudLyrics)`
   * 默认也是关（用户显式开启后才出现）。入口只在 Electron 的设置页，Web 端不显示。
   */
  lyricsEnabled: false,
  /* ---- 浮窗外观：歌词 / 常规 / 条形三态共用同一份（用户 2026-11-09：「同一套主体」） ---- */
  floatFontSize: 22,
  floatTextColor: '#F2F2F2',
  /** 背景色（#RRGGBB）；透明度另由 `floatBgOpacity` 叠加，文字/图标永远不透明 */
  floatBgColor: '#0C0E12',
  /** 0~1；只作用于背景，文字/图标永远不透明 */
  floatBgOpacity: 0.72,
  /** 歌词形态：显示上一句 / 下一句 */
  floatShowNeighbors: true,
  /**
   * 拖动锁定：浮窗默认整块可拖；锁定后忽略拖动（防止误拖挡住正文）。
   * 开关在浮窗自己的设置面板里（与设置页共用同一份偏好）。
   */
  floatDragLocked: false,
  /** 歌词形态上次拖动后的屏幕坐标（DIP）；null = 主屏底部居中的默认位置 */
  floatLyricsX: null,
  floatLyricsY: null,
  /**
   * 常规形态几何（独立浮窗，不再是主窗变形）。
   * ★ 四值都可能为 null ⇒ 用默认尺寸（420×320）在当前显示器居中。
   */
  floatRegularX: null,
  floatRegularY: null,
  floatRegularW: null,
  floatRegularH: null,
  /**
   * 条形形态几何与行为。
   * ★ 条形档只有位置/尺寸/速度/穿透四项需要记住；内容与正文同步由阅读页实时推送，不落盘。
   */
  floatBarX: null,
  floatBarY: null,
  floatBarW: null,
  floatBarH: null,
  /** 1 慢 / 2 中 / 3 快（见 `BAR_SPEED_MS`） */
  floatSpeed: 2,
  /** 仅条形：默认穿透（不挡阅读），鼠标移入交互区时才临时接收点击 */
  floatClickThrough: true,
  /**
   * 仅常规：默认**不穿透**（穿透会漏滚轮、也无法选字）。
   * 与条形的 `floatClickThrough` 是两个独立开关 —— 行为语义不同，各有唯一写入方。
   */
  floatRegularClickThrough: false,
});

/** v2 偏好结构版本；`normalizePrefs` 单入口迁移，落盘一次后不再重复迁移 */
const PREFS_VERSION = 2;

/**
 * v1 → v2 键映射（用户 2026-11-09 认可）。
 * ★ 只搬「新键不存在」的项：新键优先，避免覆盖手改。
 * ★ `lyricsEnabled` 不在表内：它是设置页 UI 字段名，保持原名以免波及 Web 侧读写。
 * ★ `lyricsReadColor` 静默丢弃（已读行改用文字色降透明，强调色降级为壳内常量）。
 */
const PREFS_V1_MAP = Object.freeze({
  lyricsFontSize: 'floatFontSize',
  lyricsTextColor: 'floatTextColor',
  lyricsBgColor: 'floatBgColor',
  lyricsBgOpacity: 'floatBgOpacity',
  lyricsShowNeighbors: 'floatShowNeighbors',
  lyricsDragLocked: 'floatDragLocked',
  lyricsX: 'floatLyricsX',
  lyricsY: 'floatLyricsY',
  smallX: 'floatRegularX',
  smallY: 'floatRegularY',
  smallW: 'floatRegularW',
  smallH: 'floatRegularH',
  barX: 'floatBarX',
  barY: 'floatBarY',
  barW: 'floatBarW',
  barH: 'floatBarH',
  barSpeed: 'floatSpeed',
  barClickThrough: 'floatClickThrough',
});

/** 需要静默丢弃的旧键（删功能/改名，不算用户写坏值，不产生 warning） */
const LEGACY_SILENT_KEYS = Object.freeze(['lyricsReadColor']);

/** 迷你档几何：形态取消 ⇒ 丢弃；只有真的记过坐标才提示一句 */
const LEGACY_MINI_KEYS = Object.freeze(['miniX', 'miniY', 'miniW', 'miniH']);

const PREF_KEYS = Object.freeze(Object.keys(DEFAULT_PREFS));

/**
 * 快捷键串的**便宜的**语法检查。
 *
 * ⚠️ 这里**不冒充** `globalShortcut.register()`：「这个键能不能真注册上」只有它说了算
 * （返回 `false` 或抛错，且**与当时别的程序占没占用有关**）。本函数只挡两类
 * 「注定白写」的输入：含非法字符的、以及连一个 `+` 都没有的。
 *
 * 关于「单字符键」：Electron 文档明确要求 accelerator 至少含一个修饰键
 * （`A` / `F5` 这类**无法**注册），所以这里直接判不合法 —— 免得把一个注定失败的值写进配置文件。
 */
const ACCEL_RE = /^[A-Za-z0-9+]+$/;
const ACCEL_MAX = 64;
function normalizeAccelerator(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, '');
  if (!s || s.length > ACCEL_MAX) return null;
  if (!ACCEL_RE.test(s)) return null;
  if (!s.includes('+')) return null;
  return s;
}

/**
 * 把磁盘上的（可能被手改坏、或被旧版本写过的）偏好归一成**一定能用**的一份。
 *
 * 返回 `{ prefs, warnings }` —— `warnings` 是给用户看的原话，**不吞**（铁律 3）：
 * 一个被忽略的配置项如果不说，用户只会觉得「我明明改了却没用」。
 * 未知键**丢掉**（不原样回写）：手改错一个键名不该让它永久住在文件里。
 */
function normalizePrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];

  /**
   * v1 → v2 单入口迁移（用户 2026-11-09 认可）：
   *  · 只有 `prefsVersion` 缺失/低于 2 才搬值；落盘一次后不再重复；
   *  · **新键优先** —— 旧键只在「新键不存在」时补位，不覆盖手改；
   *  · 旧键一律从源对象删除 ⇒ 不回写、也不会被当成「未知配置项」告警；
   *  · `lyricsReadColor` 静默丢弃（功能已并入文字色降透明）；
   *  · `miniX/Y/W/H` 丢弃；真的记过坐标时给一句提示。
   */
  const src = { ...source };
  if (Number(src.prefsVersion) !== PREFS_VERSION) {
    for (const [oldKey, newKey] of Object.entries(PREFS_V1_MAP)) {
      if (!(newKey in src) && (oldKey in src)) src[newKey] = src[oldKey];
    }
    if (LEGACY_MINI_KEYS.some((k) => Number.isFinite(Number(src[k])))) {
      warnings.push('迷你档已取消 ⇒ 已忽略旧的 miniX / miniY / miniW / miniH 几何记录');
    }
  }
  for (const oldKey of Object.keys(PREFS_V1_MAP)) delete src[oldKey];
  for (const oldKey of LEGACY_SILENT_KEYS) delete src[oldKey];
  for (const oldKey of LEGACY_MINI_KEYS) delete src[oldKey];
  delete src.prefsVersion;

  const prefs = { ...DEFAULT_PREFS };

  // 布尔项从 DEFAULT_PREFS **按类型推出来**（不是再抄一份名单 —— 加了新布尔项忘了同步名单
  // 就会让新项「改了不生效」且没有任何提示，正是 `#239` 那类静默）
  for (const k of PREF_KEYS) {
    if (typeof DEFAULT_PREFS[k] !== 'boolean' || !(k in src)) continue;
    if (typeof src[k] === 'boolean') prefs[k] = src[k];
    else warnings.push(`${k} 需要 true/false，读到 ${JSON.stringify(src[k])} ⇒ 已用默认值 ${DEFAULT_PREFS[k]}`);
  }

  if ('serverPort' in src) {
    const v = Number(src.serverPort);
    // 0 = 跟随形态默认；其余必须是合法端口
    if (Number.isInteger(v) && (v === 0 || (v >= 1024 && v <= 65535))) prefs.serverPort = v;
    else warnings.push(`serverPort 需要 0（跟随形态默认）或 1024~65535 的整数，读到 ${JSON.stringify(src.serverPort)} ⇒ 已用默认值 ${DEFAULT_PREFS.serverPort}`);
  }

  if ('dataDir' in src) {
    const v = src.dataDir;
    if (typeof v !== 'string') {
      warnings.push(`dataDir 需要字符串，读到 ${JSON.stringify(v)} ⇒ 已用默认目录`);
    } else {
      const s = v.trim();
      if (!s) prefs.dataDir = '';
      else if (path.isAbsolute(s)) prefs.dataDir = s;
      else warnings.push(`dataDir 需要绝对路径，读到 ${JSON.stringify(v)} ⇒ 已用默认目录`);
    }
  }

  if ('shortcut' in src) {
    const v = normalizeAccelerator(src.shortcut);
    if (v) prefs.shortcut = v;
    else warnings.push(`快捷键 ${JSON.stringify(src.shortcut)} 不合法（要写成 Control+Shift+Y 这类带修饰键的组合）⇒ 已用默认值 ${DEFAULT_PREFS.shortcut}`);
  }

  /* ---- 浮窗：数值 / 颜色 / 坐标（不是布尔，单独校验） ---- */
  if ('floatFontSize' in src) {
    const v = Number(src.floatFontSize);
    if (Number.isFinite(v) && v >= 14 && v <= 40) prefs.floatFontSize = Math.round(v);
    else warnings.push(`floatFontSize 需要 14~40 的数字，读到 ${JSON.stringify(src.floatFontSize)} ⇒ 已用默认值 ${DEFAULT_PREFS.floatFontSize}`);
  }

  for (const [key, fallback] of [
    ['floatTextColor', DEFAULT_PREFS.floatTextColor],
    ['floatBgColor', DEFAULT_PREFS.floatBgColor],
  ]) {
    if (!(key in src)) continue;
    if (typeof src[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(src[key])) prefs[key] = src[key].toUpperCase();
    else warnings.push(`${key} 需要 #RRGGBB，读到 ${JSON.stringify(src[key])} ⇒ 已用默认值 ${fallback}`);
  }

  if ('floatBgOpacity' in src) {
    const v = Number(src.floatBgOpacity);
    if (Number.isFinite(v) && v >= 0 && v <= 1) prefs.floatBgOpacity = Math.round(v * 100) / 100;
    else warnings.push(`floatBgOpacity 需要 0~1 的数字，读到 ${JSON.stringify(src.floatBgOpacity)} ⇒ 已用默认值 ${DEFAULT_PREFS.floatBgOpacity}`);
  }

  for (const key of ['floatLyricsX', 'floatLyricsY', 'floatRegularX', 'floatRegularY', 'floatBarX', 'floatBarY']) {
    if (!(key in src)) continue;
    if (src[key] === null) { prefs[key] = null; continue; }
    const v = Number(src[key]);
    if (Number.isFinite(v)) prefs[key] = Math.round(v);
    else warnings.push(`${key} 需要数字或 null，读到 ${JSON.stringify(src[key])} ⇒ 已用默认值 null`);
  }

  /**
   * 浮窗几何下限：
   * · 常规 = `FLOAT_MIN_SIZE`（180×120，与 Web 端同一份 `float-geometry.json`）；
   * · 条形 = 320×100。
   * ★ 下限不是默认尺寸：常规默认仍 420×320，用户可手动缩到 180×120。
   */
  for (const [key, min] of [
    ['floatRegularW', FLOAT_MIN_SIZE.width],
    ['floatRegularH', FLOAT_MIN_SIZE.height],
    ['floatBarW', FLOAT_BAR_MIN_SIZE.width],
    ['floatBarH', FLOAT_BAR_MIN_SIZE.height],
  ]) {
    if (!(key in src)) continue;
    if (src[key] === null) { prefs[key] = null; continue; }
    const v = Number(src[key]);
    if (Number.isFinite(v) && v >= min && v <= 10000) prefs[key] = Math.round(v);
    else warnings.push(`${key} 需要 ${min}~10000 的数字或 null，读到 ${JSON.stringify(src[key])} ⇒ 已用默认值 null`);
  }

  if ('floatSpeed' in src) {
    const v = Number(src.floatSpeed);
    if (Number.isFinite(v) && v >= 1 && v <= 3) prefs.floatSpeed = Math.round(v);
    else warnings.push(`floatSpeed 需要 1~3（1 慢 / 2 中 / 3 快），读到 ${JSON.stringify(src.floatSpeed)} ⇒ 已用默认值 ${DEFAULT_PREFS.floatSpeed}`);
  }

  for (const k of Object.keys(src)) {
    if (!PREF_KEYS.includes(k)) warnings.push(`忽略无法识别的配置项 ${k}`);
  }
  // 结构与迁移标记一起落盘：下一次读取直接走 v2，不再重复迁移
  prefs.prefsVersion = PREFS_VERSION;
  return { prefs, warnings };
}

/* ------------------------------------------------------------------ *
 * 命令行参数 → 要打开的本地书
 * ------------------------------------------------------------------ */

/**
 * 从 `process.argv` 里挑出「双击打开」送进来的书文件。
 *
 * 为什么按「**后缀 + 文件存在**」筛，而不是按下标（`argv[1]`）取：
 * · 开发态 `electron . book.txt` ⇒ `argv = [electron.exe, '.', 'book.txt']`；
 * · 打包态（关联启动）⇒ `argv = [YueDu-portable.exe, 'D:\\x\\book.txt']`；
 * · 中间还可能夹着 `--remote-debugging-port=9333` 这类开关。
 * 三种形态的下标都不一样，**指数组位置必错**；按后缀 + 存在性筛则三种通吃。
 *
 * `--` 开头的参数一律跳过（开关）；`file://` 形式先转回路径（Windows 上 Explorer
 * 传的是普通路径，但别把其它入口送进来的 URL 形态静默丢掉）。
 *
 * @param {readonly string[]} argv
 * @param {(p: string) => boolean} exists 注入 fs.existsSync（本文件不读盘，便于单测）
 */
function bookFilesFromArgv(argv, exists) {
  const has = typeof exists === 'function' ? exists : () => true;
  const out = [];
  for (const raw of Array.isArray(argv) ? argv : []) {
    if (typeof raw !== 'string' || !raw) continue;
    let p = raw;
    if (p.startsWith('-')) continue;
    // 少数入口把路径整体带引号传进来（Windows 关联命令用 "%1" 时偶发）
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (/^file:\/\//i.test(p)) {
      try { p = fileURLToPath(p); } catch { continue; }
    }
    if (!isBookFile(p)) continue;
    if (!has(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * `yuedu://` / `legado://` 协议注册（唤起导入链接的**桌面端半边**）
 * ------------------------------------------------------------------ */

/**
 * 一键导入链接的两个 scheme。
 *
 * ★ 与上游**等价**（`AndroidManifest.xml:406-407` 双注册，都进 OnLineImportActivity）——
 * 本仓照抄：注册表里两个 scheme 都指向同一个 exe，`main.js` 把 URL **原样**转给渲染进程，
 * 由 `apps/web/src/utils/scheme-import.ts`（`#343` 唯一实现）判型。
 * ⚠️ 不在桌面端判型 —— 否则就是「同一判据写两处」必然漂移。
 */
const IMPORT_SCHEMES = Object.freeze(['yuedu', 'legado']);

/** 这个字符串看起来是不是一条「一键导入」深链 */
function isImportSchemeUrl(s) {
  return typeof s === 'string' && /^(yuedu|legado):\/\//i.test(s.trim());
}

/**
 * 从 `process.argv` 里挑出「点链接唤起」送进来的深链。
 *
 * ## 为什么 argv 里会有它们（Windows 的真实形态）
 * 协议注册的打开命令是 `"<exe>" "%1"` ⇒ 用户点 `yuedu://import/bookSource?src=…` 时，
 * Windows 把整条 URL 当**一个** argv 元素传进来（与 `bookFilesFromArgv` 同一套机制）。
 * Electron 在 Windows 上**不会**触发 `open-url`（那是 macOS 专属）⇒ **只能读 argv**。
 * 这与「双击书文件」共用 `second-instance` 通路，只是筛的东西不同（URL vs 书文件）。
 *
 * ⚠️ 两种入口可能同时出现（理论上不会，但别假设）⇒ 两个都收，各自处理。
 *
 * @param {readonly string[]} argv
 */
function schemeUrlsFromArgv(argv) {
  const out = [];
  for (const raw of Array.isArray(argv) ? argv : []) {
    if (typeof raw !== 'string' || !raw) continue;
    // 有些入口把整条 URL 带引号传进来（Windows `"%1"` 偶发，同 bookFilesFromArgv）
    let p = raw;
    if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (!isImportSchemeUrl(p)) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 注册表**计划**（纯数据，与 `planFileAssoc` 同构 ⇒ 单测能断言「到底写了什么」）。
 *
 * ## 写哪（HKCU，当前用户，**不需要管理员**）
 * ```
 * HKCU\Software\Classes\<scheme>            (默认) = "<应用名> 导入链接"
 * HKCU\Software\Classes\<scheme>            "URL Protocol" = ""     ← ★ 缺它就不是协议处理器
 * HKCU\Software\Classes\<scheme>\DefaultIcon (默认) = "<exe>,0"
 * HKCU\Software\Classes\<scheme>\shell\open\command (默认) = "<exe>" "%1"
 * ```
 * ★ `URL Protocol` 这个**值**是 Windows 判定「这是协议处理器」的唯一依据 ——
 * 少了它，键搭得再全也不会出现在「默认应用」里、点了也不唤起（本项**根因**）。
 *
 * ## 为什么与文件关联分开两个函数
 * 二者写入的键**互不相交**（`Classes\<ext>` vs `Classes\<scheme>`），
 * 卸载也必须**只拆自己搭的**；合成一个函数会让「只想要其中一个」的人拆错东西。
 *
 * @param {{exePath: string, appName?: string, schemes?: readonly string[]}} opt
 */
function planProtocolAssoc(opt) {
  const exePath = String(opt.exePath || '');
  if (!exePath) throw new Error('planProtocolAssoc: exePath 不能为空');
  const appName = String(opt.appName || '阅读 YueDu');
  const schemes = (opt.schemes && opt.schemes.length ? opt.schemes : IMPORT_SCHEMES).map((s) =>
    String(s).replace(/:.*$/, '').replace(/^\/+/, '').toLowerCase(),
  );
  const root = 'HKCU\\Software\\Classes';
  /** `"%1"` 的引号必须有：URL 里可能含 `&`/空格，少了会被切碎（同 planFileAssoc） */
  const openCmd = `"${exePath}" "%1"`;

  const install = schemes.flatMap((scheme) => {
    const key = `${root}\\${scheme}`;
    return [
      { op: 'add', key, name: null, type: 'REG_SZ', data: `${appName} 导入链接` },
      // ★ 判据值：Windows 只认它（空串即可，不能没有）
      { op: 'add', key, name: 'URL Protocol', type: 'REG_SZ', data: '' },
      { op: 'add', key: `${key}\\DefaultIcon`, name: null, type: 'REG_SZ', data: `"${exePath}",0` },
      { op: 'add', key: `${key}\\shell\\open\\command`, name: null, type: 'REG_SZ', data: openCmd },
    ];
  });
  const uninstall = schemes.map((scheme) => ({ op: 'delKey', key: `${root}\\${scheme}` }));

  return { schemes: [...schemes], install, uninstall, openCmd };
}

/* ------------------------------------------------------------------ *
 * 文件关联（HKCU，当前用户，**不劫持默认程序**）
 * ------------------------------------------------------------------ */

/**
 * ## 用的是哪套写法，为什么
 * 走「**Open with**」标准写法，**只写 `HKEY_CURRENT_USER`**（不需要管理员）：
 *
 * | 键 | 值 | 作用 |
 * |---|---|---|
 * | `…\Classes\Applications\<exe>` | `FriendlyAppName` / `DefaultIcon` / `shell\open\command` | 让本程序出现在「打开方式」列表里，并知道怎么打开它 |
 * | `…\Applications\<exe>\SupportedTypes` | `.txt` / `.epub` | 「打开方式」对话框据此把本程序列进**建议** |
 * | `…\.txt\OpenWithProgids` | `YueDu.txt = ""` | 把我们的 ProgID 挂到 .txt 的「候选打开方式」 |
 * | `…\YueDu.txt` | 显示名 + `shell\open\command` | 上面那个 ProgID 的实体 |
 *
 * ★★ **刻意不写 `HKCU\Software\Classes\.txt\(默认)`**。
 * 写它就等于**劫持所有 .txt 的默认打开程序**（用户原本可能是记事本）——
 * 一个便携版应用做这种事是越权的。要让本程序成为默认，用户在 Explorer 的
 * 「打开方式 → 始终使用此应用」里自己勾一次即可。`uninstall` 也只删**我们自己的**值/键。
 *
 * ## 便携版的坑（已核实，非推测）
 * electron-builder 的 `portable` 目标每次启动都把程序自解压到**新的随机 %TEMP% 目录**
 * （`process.execPath` 指向临时目录）。所以注册表里的路径**必须**用
 * `process.env.PORTABLE_EXECUTABLE_FILE`（electron-builder 注入的原始 exe 全路径），
 * 用 `process.execPath` 会写进一个下次就消失的临时路径。
 * 依据：electron-builder issue #8739 里维护者与用户的实测日志
 * （`app.getPath('exe')` = `…\Temp\<随机>\X.exe`）。
 *
 * @param {{exePath: string, appName?: string, exts?: readonly string[]}} opt
 */
function planFileAssoc(opt) {
  const exePath = String(opt.exePath || '');
  if (!exePath) throw new Error('planFileAssoc: exePath 不能为空');
  const appName = String(opt.appName || '阅读 YueDu');
  const exts = (opt.exts && opt.exts.length ? opt.exts : BOOK_EXTS).map((e) => String(e).replace(/^\./, '').toLowerCase());
  const exeName = path.basename(exePath);
  const root = 'HKCU\\Software\\Classes';
  const appKey = `${root}\\Applications\\${exeName}`;
  /** `"%1"` 的引号必须有：路径带空格时（Windows 常见）少了就把参数切碎 */
  const openCmd = `"${exePath}" "%1"`;

  const progIdOf = (ext) => `YueDu.${ext}`;
  const descOf = (ext) => (ext === 'epub' ? `${appName} 电子书（.epub）` : `${appName} 文本（.${ext}）`);

  const install = [
    { op: 'add', key: appKey, name: null, type: 'REG_SZ', data: appName },
    { op: 'add', key: appKey, name: 'FriendlyAppName', type: 'REG_SZ', data: appName },
    { op: 'add', key: appKey, name: 'DefaultIcon', type: 'REG_SZ', data: `"${exePath}",0` },
    { op: 'add', key: `${appKey}\\shell\\open\\command`, name: null, type: 'REG_SZ', data: openCmd },
  ];
  for (const ext of exts) {
    install.push({ op: 'add', key: `${appKey}\\SupportedTypes`, name: `.${ext}`, type: 'REG_SZ', data: '' });
    /**
     * `OpenWithProgids` 的取值习惯上是 `REG_NONE`；这里用 `REG_SZ` 空串 ——
     * 原因是 `reg.exe` 对「`REG_NONE` + 零长度数据」在不同 Windows 版本上行为不一致
     * （可能报错），而 Windows 认定「候选打开方式」**只看该值存不存在**（不看类型）。
     * 选一定写得进去的那种，宁可类型与系统自带写法有差异。
     */
    install.push({ op: 'add', key: `${root}\\.${ext}\\OpenWithProgids`, name: progIdOf(ext), type: 'REG_SZ', data: '' });
    install.push({ op: 'add', key: `${root}\\${progIdOf(ext)}`, name: null, type: 'REG_SZ', data: descOf(ext) });
    install.push({ op: 'add', key: `${root}\\${progIdOf(ext)}\\shell\\open\\command`, name: null, type: 'REG_SZ', data: openCmd });
  }

  /**
   * 卸载 = **只拆自己搭的**：
   * · 删 `Applications\<exe>`（整棵子树，都是我们建的）；
   * · 删 `OpenWithProgids` 下**我们那个值**（不是整个键 —— 别的程序也往里挂东西）；
   * · 删我们的两个 ProgID 键。
   */
  const uninstall = [
    { op: 'delKey', key: appKey },
    ...exts.flatMap((ext) => [
      { op: 'delValue', key: `${root}\\.${ext}\\OpenWithProgids`, name: progIdOf(ext) },
      { op: 'delKey', key: `${root}\\${progIdOf(ext)}` },
    ]),
  ];

  return { appKey, exts: [...exts], progIds: exts.map(progIdOf), install, uninstall, openCmd };
}

/** 把一条 op 变成 `reg.exe` 的 argv（纯数据，便于单测断言「到底写了什么」） */
function regArgsFor(op) {
  if (op.op === 'add') {
    const a = ['add', op.key];
    a.push(op.name === null || op.name === undefined ? '/ve' : '/v', ...(op.name === null || op.name === undefined ? [] : [op.name]));
    a.push('/t', op.type || 'REG_SZ', '/d', op.data === undefined || op.data === null ? '' : String(op.data), '/f');
    return a;
  }
  if (op.op === 'delValue') return ['delete', op.key, '/v', op.name, '/f'];
  if (op.op === 'delKey') return ['delete', op.key, '/f'];
  throw new Error(`未知的注册表操作：${op.op}`);
}

/**
 * 解析 `reg query` 的输出，取某个值的**数据**；取不到返回 `null`。
 *
 * ★ 为什么按 `REG_*` 列去解析、而不是抓 `ERROR` 关键字：
 * `reg.exe` 的报错文案**随系统语言变**（英文 `ERROR: The system was unable to find…`、
 * 中文 `错误: 系统找不到指定的注册表项或值。`）—— 抓关键字换个语言的机器就失灵。
 * 成功时的格式是稳定的：`    (默认)    REG_SZ    <数据>`（多列，空白分隔）。
 */
function parseRegQueryValue(stdout, name) {
  const want = name === null || name === undefined ? null : String(name);
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s{2,}(\S.*?)\s{2,}(REG_[A-Z_]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const isDefault = key === '(默认)' || key === '(Default)';
    if (want === null ? isDefault : key === want) return m[3];
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 桌面朗读歌词（纯判定）
 * ------------------------------------------------------------------ */

const LYRICS_WINDOW_SIZE = Object.freeze({ width: 720, height: 180 });

/** 便携场景的旗标文件：放在**原始便携 exe 同目录**（用户双击的那个 exe 旁边） */
const LYRICS_FLAG_FILES = Object.freeze({
  off: 'lyrics-off.txt',
  on: 'lyrics-on.txt',
});

/**
 * 解析环境变量 `YUEDU_LYRICS`：只认明确的 0/1（以及常见同义词），
 * 其余（空串 / 拼错 / 未知词）一律当作**未设置** —— 不猜用户意图。
 */
function parseLyricsEnv(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['0', 'off', 'false', 'no', 'disabled'].includes(s)) return false;
  if (['1', 'on', 'true', 'yes', 'enabled'].includes(s)) return true;
  return null;
}

/**
 * 桌面歌词开关的**优先级链**（便携端可用）：
 * ① `YUEDU_LYRICS=0|1` ② exe 同目录的 `lyrics-off.txt` / `lyrics-on.txt`
 * ③ `desktop-prefs.json` 的 `lyricsEnabled` ④ 默认 false。
 *
 * 两个旗标同时存在时**按关闭处理**（宁可少弹一个窗，也不要在用户明确留了 off 时还弹）；
 * `conflict=true` 让调用方给出可自查的告警。
 */
function resolveLyricsEnabled(input) {
  const env = parseLyricsEnv(input?.envRaw);
  const flagOff = input?.flagOff === true;
  const flagOn = input?.flagOn === true;
  const prefsEnabled = input?.prefsEnabled === true;
  if (env !== null) {
    return {
      enabled: env,
      source: 'env',
      forced: true,
      conflict: false,
      reason: `YUEDU_LYRICS=${String(input?.envRaw ?? '').trim()}`,
    };
  }
  if (flagOff || flagOn) {
    const conflict = flagOff && flagOn;
    return {
      enabled: flagOn && !flagOff,
      source: 'flag',
      forced: true,
      conflict,
      reason: conflict
        ? `同时存在 ${LYRICS_FLAG_FILES.off} 与 ${LYRICS_FLAG_FILES.on} ⇒ 按关闭处理`
        : `旗标文件 ${flagOn ? LYRICS_FLAG_FILES.on : LYRICS_FLAG_FILES.off}`,
    };
  }
  return {
    enabled: prefsEnabled,
    source: prefsEnabled ? 'prefs' : 'default',
    forced: false,
    conflict: false,
    reason: '',
  };
}


/**
 * 渲染进程上报的朗读状态 → 主进程可安全使用的白名单结构。
 *
 * 为什么在主进程再归一一次：IPC 的另一头是网页上下文，字段可能缺、可能是任意 JSON；
 * 直接塞进 `webContents.send` 会让歌词窗拿到不可渲染的值（比如 innerPos 超过句长）。
 */
function normalizeLyricsState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const text = (v) => (typeof v === 'string' ? v.slice(0, 800) : '');
  const current = text(src.current);
  const index = Number(src.index);
  const inner = Number(src.innerPos);
  return {
    active: src.active === true,
    playing: src.playing === true,
    paused: src.paused === true,
    index: Number.isFinite(index) ? Math.max(0, Math.round(index)) : 0,
    // 句内进度必须夹在**当前句长度**内，否则歌词窗的 read/unread 切分会越界
    innerPos: Number.isFinite(inner) ? Math.max(0, Math.min(current.length, Math.round(inner))) : 0,
    prev: text(src.prev),
    current,
    next: text(src.next),
    hasContent: current.trim().length > 0,
  };
}

/**
 * 唯一的显隐出口。
 *
 * ## 语义（用户 2026-11-08 拍板）：歌词窗 = 浮条的一个**功能模式**，由用户主动开关
 * 开启后，只要「朗读会话仍在（active）+ 有当前句 + 未锁屏 + 不在小窗」，浮条就显示当前句
 * —— **不再要求主窗失去焦点**。原因：开关是用户自己打开的，打开后回到主窗却看不见，
 * 只会被当成「开关坏了」；「切到别的软件才出现」是旧 Android 悬浮窗的隐式行为，不是需求。
 * 小窗模式仍然不回弹：小窗里显示的是同一份正文，再叠一扇歌词窗就是重复。
 *
 * ★ 暂停**不隐藏**（用户 2026-11-14）：暂停时 `playing=false` 但 `active` 仍为 true，
 *   窗要留在原位显示当前句（从朗读控制条点「继续」就能接着念）；只有朗读结束/停止
 *   （`active=false`，即 state 回 `idle`）才隐藏。此前用 `playing` 当门槛，一点暂停整窗消失。
 */
function lyricsShouldShow(s) {
  return !!(
    s &&
    s.enabled === true &&
    s.active === true &&
    s.hasContent === true &&
    s.screenLocked !== true &&
    // 阅读浮窗（常规/条形）与桌面歌词是**同一内容的两份投影** ⇒ 一律不弹
    s.floatReading !== true
  );
}

/** 把窗口矩形夹进显示器工作区，避免拖到副屏再拔掉后窗口跑到屏幕外 */
function clampLyricsBounds(bounds, workArea) {
  const wa = workArea && typeof workArea === 'object'
    ? workArea
    : { x: 0, y: 0, width: 1280, height: 800 };
  const width = Math.max(200, Math.round(Number(bounds?.width) || LYRICS_WINDOW_SIZE.width));
  const height = Math.max(48, Math.round(Number(bounds?.height) || LYRICS_WINDOW_SIZE.height));
  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - height);
  const x = Math.min(Math.max(Math.round(Number(bounds?.x) || 0), wa.x), maxX);
  const y = Math.min(Math.max(Math.round(Number(bounds?.y) || 0), wa.y), maxY);
  return { x, y, width, height };
}

/**
 * 歌词窗高度：**刚好三行文字能显示**（用户 2026-11-08：「窗口太大太高」）。
 *
 * 与 `lyrics.html` 的排版常量一一对应（改那边必须同步这里）：
 * · 当前行 `font-size = F`、`line-height: 1.35` ⇒ `1.35F`
 * · 前后行 `font-size = 0.62F`、`line-height: 1.35`、`min-height: 0.84F` ⇒ `0.84F`
 * · 卡片 `padding: 10px 14px 8px` ⇒ 上下共 18px
 * ⇒ `height = 1.35F + 2×0.84F + 18`（`floatShowNeighbors=false` 时只有当前行）。
 * 字号在设置页可改（14~40），窗口高度随之重算 —— 字号变了高度不变会截字。
 */
function lyricsWindowHeight(fontSize, showNeighbors) {
  const f = Math.max(12, Math.min(64, Math.round(Number(fontSize) || 22)));
  const neighbor = Math.ceil(f * 0.84);
  const current = Math.ceil(f * 1.35);
  const text = showNeighbors === false ? current : neighbor * 2 + current;
  // +18 padding；再 +2 补齐 Chromium 的亚像素行高取整（否则最后一行底边会被裁 1~2px）
  return Math.max(48, text + 20);
}

/** 首次位置：主屏底部居中（留 72px 给任务栏/呼吸区）；已有坐标则用坐标 */
function lyricsBoundsFromPrefs(prefs, workArea) {
  const wa = workArea && typeof workArea === 'object'
    ? workArea
    : { x: 0, y: 0, width: 1280, height: 800 };
  const size = {
    width: LYRICS_WINDOW_SIZE.width,
    height: lyricsWindowHeight(prefs?.floatFontSize, prefs?.floatShowNeighbors !== false),
  };
  const x = Number.isFinite(prefs?.floatLyricsX)
    ? prefs.floatLyricsX
    : wa.x + Math.round((wa.width - size.width) / 2);
  const y = Number.isFinite(prefs?.floatLyricsY)
    ? prefs.floatLyricsY
    : wa.y + wa.height - size.height - 72;
  return clampLyricsBounds({ x, y, ...size }, wa);
}

/* ------------------------------------------------------------------ *
 * 浮窗两态几何（纯判定；窗口操作在 main.js）
 * ------------------------------------------------------------------ */

/**
 * 把任意矩形夹进工作区，并保证不小于 `minSize`。
 * ★ 宽高**先夹到工作区**（副屏比迷你窗还窄的极端情况），再取 `minSize`：
 *   顺序反了会出现「宽 240、工作区只有 200 ⇒ 窗口右缘越界」。
 */
function clampWindowBounds(bounds, workArea, minSize) {
  const wa = workArea && typeof workArea === 'object'
    ? workArea
    : { x: 0, y: 0, width: 1280, height: 800 };
  const min = minSize && typeof minSize === 'object' ? minSize : FLOAT_MIN_SIZE;
  const maxW = Math.max(1, Math.round(Number(wa.width) || 1280));
  const maxH = Math.max(1, Math.round(Number(wa.height) || 800));
  const width = Math.min(maxW, Math.max(Math.round(Number(min.width) || 1), Math.round(Number(bounds?.width) || min.width)));
  const height = Math.min(maxH, Math.max(Math.round(Number(min.height) || 1), Math.round(Number(bounds?.height) || min.height)));
  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - height);
  const x = Math.min(Math.max(Math.round(Number(bounds?.x) || 0), wa.x), maxX);
  const y = Math.min(Math.max(Math.round(Number(bounds?.y) || 0), wa.y), maxY);
  return { x, y, width, height };
}

/**
 * 常规态目标矩形：有 `floatRegularX/Y/W/H` 记录就用记录，否则**在当前显示器居中**。
 * 下限 = `FLOAT_MIN_SIZE`（180×120，与 Web 端共用 `float-geometry.json`）——
 * **不是**默认尺寸 420×320，用户可以手动缩到 180×120。
 */
function floatRegularBoundsFromPrefs(prefs, workArea) {
  const size = FLOAT_REGULAR_SIZE;
  const width = Number.isFinite(prefs?.floatRegularW) ? prefs.floatRegularW : size.width;
  const height = Number.isFinite(prefs?.floatRegularH) ? prefs.floatRegularH : size.height;
  const wa = workArea && typeof workArea === 'object'
    ? workArea
    : { x: 0, y: 0, width: 1280, height: 800 };
  const x = Number.isFinite(prefs?.floatRegularX)
    ? prefs.floatRegularX
    : wa.x + Math.round((wa.width - width) / 2);
  const y = Number.isFinite(prefs?.floatRegularY)
    ? prefs.floatRegularY
    : wa.y + Math.round((wa.height - height) / 2);
  return clampWindowBounds({ x, y, width, height }, wa, FLOAT_MIN_SIZE);
}

/**
 * 条形态目标矩形（独立浮窗）。
 *
 * · 默认宽度 = `preferredWidth`（主窗内容宽度，最宽 920 —— 阅读面板本来就只有 920）；
 *   没有主窗宽度时用 `FLOAT_BAR_SIZE.width`。**用户拖拽/缩放过宽高后以落盘值为准**。
 * · 默认位置：当前屏底部居中（和歌词窗同一套「不挡正文」的落点）。
 * · 下限 `FLOAT_BAR_MIN_SIZE`（320×100），宽高都夹进工作区。
 */
function floatBarBoundsFromPrefs(prefs, workArea, preferredWidth) {
  const wa = workArea && typeof workArea === 'object'
    ? workArea
    : { x: 0, y: 0, width: 1280, height: 800 };
  const wantedWidth = Number.isFinite(preferredWidth) && preferredWidth > 0
    ? preferredWidth
    : FLOAT_BAR_SIZE.width;
  const width = Number.isFinite(prefs?.floatBarW) ? prefs.floatBarW : Math.round(wantedWidth);
  const height = Number.isFinite(prefs?.floatBarH) ? prefs.floatBarH : FLOAT_BAR_SIZE.height;
  const x = Number.isFinite(prefs?.floatBarX)
    ? prefs.floatBarX
    : wa.x + Math.round((wa.width - width) / 2);
  const y = Number.isFinite(prefs?.floatBarY)
    ? prefs.floatBarY
    : wa.y + wa.height - height - 72;
  return clampWindowBounds({ x, y, width, height }, wa, FLOAT_BAR_MIN_SIZE);
}

/**
 * 阅读页推送的正文流（常规 / 条形共用）→ 主进程可安全转发的白名单结构。
 * 和 `normalizeLyricsState` 同理：IPC 另一头是网页上下文，字段可能缺或超长。
 */
function normalizeFloatReadingState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const lines = Array.isArray(src.lines)
    ? src.lines
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 400)
        .map((s) => s.slice(0, 300))
    : [];
  const total = Number.isFinite(Number(src.total)) ? Math.max(lines.length, Math.round(Number(src.total))) : lines.length;
  const rawIndex = Number(src.index);
  const index = Number.isFinite(rawIndex) ? Math.max(0, Math.min(lines.length - 1, Math.round(rawIndex))) : 0;
  // 未切分段落：浮窗按窗口真实宽度折行（与 Web PiP 同一口径，渲染层不再写死 46 字）
  const paragraphs = Array.isArray(src.paragraphs)
    ? src.paragraphs
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .slice(0, 600)
        .map((s) => s.slice(0, 2000))
    : [];
  // 目录只传标题：条数设上限，避免几千章的书每翻一章就过一次大 IPC
  const chapters = Array.isArray(src.chapters)
    ? src.chapters
        .slice(0, 2000)
        .map((s) => (typeof s === 'string' ? s.slice(0, 120) : ''))
    : [];
  const rawIdx = Number(src.chapterIdx);
  const chapterIdx = chapters.length
    ? Math.max(0, Math.min(chapters.length - 1, Number.isFinite(rawIdx) ? Math.round(rawIdx) : 0))
    : -1;
  const rawRatio = Number(src.ratio);
  const ratio = Number.isFinite(rawRatio) ? Math.max(0, Math.min(1, rawRatio)) : 0;
  return {
    title: text(src.title, 120),
    chapterLabel: text(src.chapterLabel, 80),
    chapterTitle: text(src.chapterTitle, 120),
    lines,
    paragraphs,
    chapters,
    chapterIdx,
    ratio,
    total,
    index,
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * 托盘菜单（结构可断言，点击回调由 main.js 挂）
 * ------------------------------------------------------------------ */

/**
 * `--server-only`：只做「服务 + 托盘」的壳（不建主窗口、不注册文件关联）。
 * 纯 argv 判定，便于单测；Electron 的 `app.commandLine.hasSwitch` 由 main.js 兜底。
 */
function isServerOnlyArgv(argv) {
  if (!Array.isArray(argv)) return false;
  return argv.some((a) => a === '--server-only' || a === '--server-only=1' || a === '--server-only=true');
}

/**
 * 托盘菜单的**结构**（纯数据）。
 *
 * `toggle` 的文案跟着窗口当前可见状态走 —— 菜单是用户唯一的「窗口去哪了」答案，
 * 写成固定的「显示主窗口」在窗口已经显示时就是错的。
 */
function trayMenuSpec(state) {
  const s = state || {};
  // `--server-only` / 独立服务端 exe：没有主窗口，菜单只留「服务壳」该有的东西
  if (s.serverOnly) {
    return [
      { id: 'open-ui', label: '打开界面' },
      { id: 'restart-server', label: '重启服务' },
      { id: 'settings', label: '服务设置…' },
      { id: 'open-data-dir', label: '打开数据目录' },
      { id: 'auto-launch', label: '开机自启', type: 'checkbox', checked: !!s.autoLaunch },
      { type: 'separator' },
      { id: 'quit', label: '退出服务' },
    ];
  }
  const visible = !!s.windowVisible;
  const items = [
    { id: 'toggle', label: visible ? '隐藏主窗口' : '显示主窗口' },
    { id: 'open-local', label: '打开本地书籍（txt / epub）…' },
    { type: 'separator' },
  ];
  if (s.shortcutEnabled && !s.shortcutOk) {
    // ★ 注册失败必须**在托盘上就说**：托盘是常驻入口，用户多半看不到日志
    items.push({ id: 'shortcut-broken', label: `⚠ 全局快捷键未生效（${s.shortcut || ''}）`, enabled: false });
  }
  items.push(
    { id: 'restart-server', label: '重启服务' },
    { id: 'open-data-dir', label: '打开数据目录' },
    { id: 'auto-launch', label: '开机自启', type: 'checkbox', checked: !!s.autoLaunch },
    { id: 'settings', label: '桌面端设置…' },
    { type: 'separator' },
    { id: 'quit', label: '退出阅读' },
  );
  return items;
}

/* ------------------------------------------------------------------ *
 * 服务壳：形态默认端口 + 数据目录互斥锁
 * ------------------------------------------------------------------ */

/** 两种形态的默认端口：PC 客户端 3100，独立服务端 3000（与 Web+server 对齐） */
function defaultPortForMode(serverOnly) {
  return serverOnly ? 3000 : 3100;
}

/**
 * 「同一数据目录只允许一个壳」的锁文件（放在数据目录里，随目录一起迁移）。
 * 命名刻意避开服务端的 `server.pid`：两者语义不同（壳 vs 服务进程）。
 */
const SHELL_LOCK_FILE = '.yuedu-shell.lock.json';

function shellLockPath(dataDir) {
  return path.join(String(dataDir || ''), SHELL_LOCK_FILE);
}

/* ------------------------------------------------------------------ *
 * 绿色 zip 的两个入口（用户 2026-11-25：只发布 zip，解压即用）
 * ------------------------------------------------------------------ */

/**
 * 「悦读」与「悦读服务」两个快捷方式（后者带 `--server-only`）。
 * 同一份 exe、零额外下载；写 .lnk 的动作在 main.js（`shell.writeShortcutLink`）。
 */
const GREEN_SHORTCUTS = Object.freeze([
  { key: 'reader', name: '悦读', args: '' },
  { key: 'server', name: '悦读服务', args: '--server-only' },
]);

/**
 * 生成 `shell.writeShortcutLink` 的参数（纯函数，可单测）。
 * · `icon`：服务入口优先用随包的 `resources/icon-server.ico`，两个图标才分得开；缺省回落到 exe 自身。
 * · `cwd` 固定为 exe 所在目录 —— 快捷方式后续被手动加相对参数时不会跑偏。
 */
function planGreenShortcuts({ exePath, desktopDir, iconPath } = {}) {
  if (!exePath) throw new Error('planGreenShortcuts: exePath 必填');
  if (!desktopDir) throw new Error('planGreenShortcuts: desktopDir 必填');
  const exe = String(exePath);
  return GREEN_SHORTCUTS.map((s) => ({
    key: s.key,
    name: s.name,
    path: path.join(String(desktopDir), `${s.name}.lnk`),
    target: exe,
    args: s.args,
    cwd: path.dirname(exe),
    description: s.args ? '悦读服务：本地服务 + 托盘（不开主窗口）' : '悦读：本地阅读',
    icon: s.args && iconPath ? String(iconPath) : exe,
    iconIndex: 0,
  }));
}

module.exports = {
  BOOK_EXTS,
  MAX_BOOK_BYTES,
  DEFAULT_PREFS,
  PREF_KEYS,
  isBookFile,
  normalizeAccelerator,
  normalizePrefs,
  bookFilesFromArgv,
  planFileAssoc,
  // `#347` 唤起导入链接的桌面端半边（协议注册 + argv 取深链）
  IMPORT_SCHEMES,
  isImportSchemeUrl,
  schemeUrlsFromArgv,
  planProtocolAssoc,
  regArgsFor,
  parseRegQueryValue,
  trayMenuSpec,
  isServerOnlyArgv,
  defaultPortForMode,
  SHELL_LOCK_FILE,
  shellLockPath,
  // 绿色 zip 的两个入口（悦读 / 悦读服务）
  GREEN_SHORTCUTS,
  planGreenShortcuts,
  // 桌面朗读歌词（纯判定；Electron 侧的建窗/显隐在 main.js）
  LYRICS_WINDOW_SIZE,
  LYRICS_FLAG_FILES,
  parseLyricsEnv,
  resolveLyricsEnabled,
  normalizeLyricsState,
  lyricsShouldShow,
  clampLyricsBounds,
  lyricsWindowHeight,
  lyricsBoundsFromPrefs,
  // 浮窗两态（纯判定；Electron 侧的窗口操作在 main.js）
  NORMAL_MIN_SIZE,
  FLOAT_REGULAR_SIZE,
  FLOAT_BAR_SIZE,
  FLOAT_BAR_MIN_SIZE,
  FLOAT_MIN_SIZE,
  FLOAT_HEAD_ZONE_H,
  FLOAT_PALETTE,
  BAR_SPEED_MS,
  PREFS_VERSION,
  clampWindowBounds,
  floatRegularBoundsFromPrefs,
  floatBarBoundsFromPrefs,
  normalizeFloatReadingState,
};
