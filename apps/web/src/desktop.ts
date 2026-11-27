/**
 * `#209` 桌面端（Electron 外壳）能力桥。
 *
 * ## 三层各自的职责（照 `porting-roadmap.md` §1 的架构事实）
 * · **主进程**（`apps/desktop/main.js`）：托盘 / 全局快捷键 / 读本地文件 / 注册表 / 开机自启；
 * · **preload**（`apps/desktop/preload.js`）：把上面那些收成白名单，挂到 `window.yuedu`；
 * · **本文件**：界面侧的唯一出口 —— 浏览器里 `window.yuedu` 不存在 ⇒ 全部降级为「不支持」。
 *
 * ## 两条纪律
 * ① **能藏就藏**：浏览器下整个「桌面端」设置分区都不渲染（`isDesktop()`）。
 *    给一堆点了没反应的按钮 = `#298c` 那类「能点但不能用」的缺陷；
 * ② **不猜能力**：文件关联 / 开机自启是否可用**由主进程报**（`supported`），
 *    界面不按「是不是打包版」自己推断 —— 推断出来的口径迟早和真实情况不一致。
 *
 * ## 双击打开为什么不在这里读文件
 * 渲染进程**没有**本地文件系统权限（`contextIsolation: true`），文件字节是主进程读好送过来的。
 * 而**入库主键必须由前端算**（`#202` 不变量 ①）⇒ 前端收到的必须是「文件名 + 字节」，
 * 用完 `utils/local-book-key.ts` 与书架导入**同一条式子**算 key，再走同一个上传函数。
 */
import { watch } from 'vue';
import { useReaderStore } from './stores/reader';
import { useReadAloudStore } from './stores/read-aloud';
import { importLocalBookFile } from './user-data';
import { localBookUrlOf } from './utils/local-book-key';
import { encodeItemKey } from './utils/user-map';
// `#347` 深链统一派发器（处理逻辑在 ReaderOverlay.onLegadoUrl，本文件只投递）
import { dispatchSchemeImport } from './utils/scheme-import';
// `D7` 桌面歌词状态上报（独立纯逻辑模块：换章后句数相同也要重绘，见文件头注）
import { startLyricsPublisher, type DesktopLyricsPayload } from './utils/desktop-lyrics';
import { scrollRatio } from './components/reader-float-shared';
import { toast } from './toast';

/* ------------------------------------------------------------------ *
 * 与主进程的约定（字段名两边必须一致；改了这里要同步 preload.js/main.js）
 * ------------------------------------------------------------------ */

export interface DesktopPrefs {
  closeToTray: boolean;
  /** 本地服务端口（默认 3100；环境变量 PORT 优先） */
  serverPort?: number;
  /** 数据目录覆盖（空串 = 默认 userData/yuedu-data；只切目录，不复制旧数据） */
  dataDir?: string;
  minimizeToTray: boolean;
  shortcutEnabled: boolean;
  shortcut: string;
  trayHintShown: boolean;
  /* ---- 浮窗（仅 Electron）：歌词 / 常规 / 条形三态共用一份外观 ---- */
  lyricsEnabled: boolean;
  floatFontSize: number;
  floatTextColor: string;
  floatBgColor: string;
  floatBgOpacity: number;
  floatShowNeighbors: boolean;
  floatDragLocked: boolean;
  floatLyricsX?: number | null;
  floatLyricsY?: number | null;
  /* ---- 浮窗两态几何（不暴露给设置页；只记录对应形态） ---- */
  floatRegularX?: number | null;
  floatRegularY?: number | null;
  floatRegularW?: number | null;
  floatRegularH?: number | null;
  floatBarX?: number | null;
  floatBarY?: number | null;
  floatBarW?: number | null;
  floatBarH?: number | null;
  floatSpeed?: number;
  /** 仅条形：默认穿透 */
  floatClickThrough?: boolean;
  /** 仅常规：默认不穿透（穿透会漏滚轮、无法选字） */
  floatRegularClickThrough?: boolean;
}

/** B18 小窗模式的三个档：常规 420×320 / 迷你 240×180 / 条形阅读 */
export type DesktopSmallTier = 'regular' | 'mini' | 'bar';

/** B18 小窗运行态（由主进程回报；`small`/`tier` **不持久化**，重启回正常窗） */
export interface DesktopSmallState {
  ok: boolean;
  available?: boolean;
  small: boolean;
  tier: DesktopSmallTier;
  width: number | null;
  height: number | null;
  /** 当前档位的标准尺寸 */
  tierWidth: number;
  tierHeight: number;
  /** 两档标准尺寸（UI 文案用） */
  smallWidth: number;
  smallHeight: number;
  miniWidth: number;
  miniHeight: number;
  barWidth?: number;
  barHeight?: number;
  barSpeed?: number;
  barClickThrough?: boolean;
  normalMinWidth: number;
  normalMinHeight: number;
  reason?: string;
}

/** 浮窗阅读正文（与 `desktop-lib.normalizeFloatReadingState` 对齐） */
export interface DesktopBarReading {
  title: string;
  chapterLabel: string;
  lines: string[];
  total: number;
  index: number;
  updatedAt: number;
  /** 当前章标题（常规态头部 / 条形首行） */
  chapterTitle?: string;
  /**
   * 未切分的正文段：由浮窗渲染层按**窗口真实宽度**折行。
   * Web PiP 与桌面端因此用同一套「按宽折行」口径，而不是各自写死 46 字。
   */
  paragraphs?: string[];
  /** 目录标题（桌面浮窗自己画目录，点击回传 chapterOpen） */
  chapters?: string[];
  /** 当前章下标（目录高亮） */
  chapterIdx?: number;
  /** 进入浮窗时的阅读位置 0~1（常规/条形恢复位置用） */
  ratio?: number;
}

export interface DesktopShortcutState {
  accelerator: string;
  enabled: boolean;
  /** `globalShortcut.register()` 的返回值 */
  ok: boolean;
  /** `globalShortcut.isRegistered()` 的**独立复核** —— 与 `ok` 不一致时说明系统行为异常 */
  held: boolean;
  reason: string;
}

export interface DesktopStatus {
  prefs: DesktopPrefs;
  prefsWarnings: string[];
  prefsFile: string;
  tray: { ok: boolean; reason?: string; icon?: string };
  shortcut: DesktopShortcutState;
  autoLaunch: { supported: boolean; openAtLogin: boolean; exePath?: string; reason?: string };
  fileAssoc: { supported: boolean; registered: boolean | null; exePath?: string; command?: string | null; progIds?: string[]; reason?: string };
  /** `#347` 导入链接协议（`yuedu://` / `legado://`）注册状态（逐 scheme 明细在 `schemes`） */
  protocolAssoc: { supported: boolean; registered: boolean | null; exePath?: string; reason?: string; schemes?: { scheme: string; hasUrlProtocol: boolean; command: string | null; registered: boolean }[] };
  singleInstance: { allowedMulti: boolean; lost: boolean };
  /** B18 小窗模式运行态 */
  small: DesktopSmallState;
  /** 本地服务**生效**配置（端口/数据目录可能被环境变量覆盖，主进程如实回报） */
  server?: {
    port: number;
    urlBase: string;
    dataDir: string;
    sourceDb: string;
    envPort: number | null;
    envDataDir: string | null;
  };
  paths: { exe: string; portableExe: string | null; userData: string | null; repoRoot: string };
  versions: { electron?: string; chrome?: string; node: string };
}

/** 主进程读好的一个本地书文件（`data` 经结构化克隆过来是 `Uint8Array`） */
export interface ShellOpenFile {
  ok: true;
  name: string;
  path: string;
  bytes: number;
  data: Uint8Array | ArrayBuffer;
}

/** 桌面歌词窗需要的朗读状态（字段与 `apps/desktop/desktop-lib.normalizeLyricsState` 对齐） */
export type DesktopLyricsState = DesktopLyricsPayload;

export interface DesktopOpResult {
  ok: boolean;
  supported?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** 单条注册表操作的结果（失败时 `detail` 是 `reg.exe` 的原话，直接给用户看） */
export interface FileAssocOp {
  op: string;
  key: string;
  name: string | null;
  ok: boolean;
  code: number;
  detail: string;
}

export interface FileAssocOpResult extends DesktopOpResult {
  enabled?: boolean;
  exePath?: string;
  total?: number;
  done?: number;
  failed?: number;
  results?: FileAssocOp[];
}

export interface AutoLaunchOpResult extends DesktopOpResult {
  openAtLogin?: boolean;
  exePath?: string;
  reason?: string;
}

interface YueduBridge {
  isDesktop: true;
  login(sourceId: string, url: string, bookSourceUrl?: string): Promise<{ ok: boolean; cookie?: string; error?: string }>;
  ensureServer(): Promise<{ ok: boolean }>;
  rendererReady(): void;
  desktopStatus(): Promise<DesktopStatus>;
  getDesktopPrefs(): Promise<{ prefs: DesktopPrefs; warnings: string[]; file: string }>;
  setDesktopPrefs(patch: Partial<DesktopPrefs>): Promise<{ ok: boolean; error?: string; prefs: DesktopPrefs; warnings: string[]; shortcut: DesktopShortcutState }>;
  /** 选择数据目录（只返回路径；切换由设置页确认后走 setDesktopPrefs） */
  pickDataDir?(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
  openLocalBook(): Promise<{ ok: boolean; sent?: number; canceled?: boolean; failed?: { name: string; error: string }[]; error?: string }>;
  setFileAssoc(enable: boolean): Promise<FileAssocOpResult>;
  setProtocolAssoc(enable: boolean): Promise<FileAssocOpResult>;
  getProtocolAssoc(): Promise<{ supported: boolean; registered: boolean | null; reason?: string; exePath?: string; schemes?: { scheme: string; hasUrlProtocol: boolean; command: string | null; registered: boolean }[] }>;
  setAutoLaunch(enable: boolean): Promise<AutoLaunchOpResult>;
  toggleWindow(visible: boolean): Promise<{ ok: boolean; visible: boolean }>;
  /** `D4` F11 全屏：切换主窗口全屏并回报生效值 */
  toggleFullscreen(): Promise<{ ok: boolean; fullscreen?: boolean; error?: string }>;
  /* ---- B18 小窗模式 ---- */
  getSmallState?(): Promise<DesktopSmallState>;
  // ★ 旧外壳（release-812 及更早）只暴露 getMiniState / toggleMini / onMiniState，
  //   这里声明成可选：调用方必须先 feature-detect，不能直接 `bridge().toggleSmall(...)`。
  toggleSmall?(mode?: boolean): Promise<DesktopSmallState>;
  setSmallTier?(tier: DesktopSmallTier): Promise<DesktopSmallState>;
  onSmallState?(cb: (state: DesktopSmallState) => void): () => void;
  getMiniState?(): Promise<DesktopSmallState>;
  toggleMini?(mode?: boolean): Promise<DesktopSmallState>;
  onMiniState?(cb: (state: DesktopSmallState) => void): () => void;
  /* ---- 浮窗（818+：歌词 / 常规 / 条形共用一扇独立窗） ---- */
  getFloatState?(): Promise<FloatStatePayload>;
  toggleFloat?(mode?: 'regular' | 'bar'): Promise<FloatStatePayload>;
  setFloatMode?(mode: 'regular' | 'bar'): Promise<FloatStatePayload>;
  closeFloat?(): Promise<FloatStatePayload>;
  onFloatState?(cb: (state: FloatStatePayload) => void): () => void;
  /* ---- B18 条形档 ---- */
  floatReading?(state: DesktopBarReading): void;
  /** 浮窗工具条动作（目录 / 章节 / 跳转）→ 主窗阅读页执行 */
  onFloatCommand?(cb: (cmd: { cmd: string; value?: unknown }) => void): () => void;
  getFloatSettings?(): Promise<{ ok: boolean; barSpeed: number; barSpeedMs: number; barClickThrough: boolean }>;
  /* ---- 桌面朗读歌词（仅 Electron；浏览器里没有这组方法） ---- */
  lyricsState(state: DesktopLyricsState): void;
  onLyricsCommand(cb: (cmd: 'prev' | 'toggle' | 'next' | 'chapterPrev' | 'chapterNext') => void): () => void;
  onLyricsEnabled(cb: (enabled: boolean) => void): () => void;
  onOpenFiles(cb: (files: ShellOpenFile[]) => void): () => void;
  onSchemeUrl(cb: (url: string) => void): () => void;
  onNavigate(cb: (path: string) => void): () => void;
}

declare global {
  interface Window {
    yuedu?: YueduBridge;
  }
}

/* ------------------------------------------------------------------ *
 * 桥的取用
 * ------------------------------------------------------------------ */

/** 是否跑在桌面端外壳里（浏览器里为 `false` ⇒ 界面据此隐藏整个桌面端分区） */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.yuedu?.isDesktop === true;
}

/** 拿桥；非桌面端返回 `null`（调用方必须先 `isDesktop()` 判断，不要硬编 `window.yuedu!`） */
function bridge(): YueduBridge | null {
  return typeof window !== 'undefined' && window.yuedu?.isDesktop === true ? window.yuedu : null;
}

export const getDesktopStatus = (): Promise<DesktopStatus> | null => bridge()?.desktopStatus() ?? null;
export const getDesktopPrefs = () => bridge()?.getDesktopPrefs() ?? null;
export const setDesktopPrefs = (patch: Partial<DesktopPrefs>) => bridge()?.setDesktopPrefs(patch) ?? null;
export const pickDataDir = () => bridge()?.pickDataDir?.() ?? Promise.resolve(null);
export const openLocalBookDialog = () => bridge()?.openLocalBook() ?? null;
export const setFileAssoc = (on: boolean): Promise<FileAssocOpResult> | null => bridge()?.setFileAssoc(on) ?? null;
/** `#347` 导入链接协议注册（`yuedu://` / `legado://`） */
export const setProtocolAssoc = (on: boolean): Promise<FileAssocOpResult> | null => bridge()?.setProtocolAssoc(on) ?? null;
export const getProtocolAssoc = () => bridge()?.getProtocolAssoc() ?? null;
export const setAutoLaunch = (on: boolean): Promise<AutoLaunchOpResult> | null => bridge()?.setAutoLaunch(on) ?? null;
export const toggleMainWindow = (visible: boolean) => bridge()?.toggleWindow(visible) ?? null;

/* ---- B18 小窗模式（仅 Electron；Web 端走 Document PiP / 页内浮条） ---- */

/** 旧外壳不支持新方法时给界面一个「明确的失败态」，绝不冒 TypeError（P0） */
function outdatedSmallState(reason: string): DesktopSmallState {
  return {
    ok: false,
    available: false,
    small: false,
    tier: 'regular',
    width: null,
    height: null,
    tierWidth: 420,
    tierHeight: 320,
    smallWidth: 420,
    smallHeight: 320,
    miniWidth: 240,
    miniHeight: 180,
    barWidth: 920,
    barHeight: 140,
    normalMinWidth: 420,
    normalMinHeight: 320,
    reason,
  };
}

let shellOutdatedNotified = false;
function notifyShellOutdated(): void {
  if (shellOutdatedNotified) return;
  shellOutdatedNotified = true;
  toast('当前桌面端外壳版本较旧，不包含浮窗阅读；请重新构建桌面端后再试。', 'warn', 14000);
}

/**
 * 主进程 `float-*` 的回报（与 `apps/desktop/main.js` 的 `floatStatePayload` 对齐）。
 * `lyrics` 形态在旧 small 语义里没有对应档 ⇒ 按「不在小窗」处理。
 */
interface FloatStatePayload {
  ok: boolean;
  available?: boolean;
  open: boolean;
  mode: 'lyrics' | 'regular' | 'bar';
  width: number | null;
  height: number | null;
  regularWidth: number;
  regularHeight: number;
  barWidth: number;
  barHeight: number;
  speed?: number;
  clickThrough?: boolean;
  normalMinWidth: number;
  normalMinHeight: number;
  reason?: string;
}

/**
 * 浮窗态 → 旧 small 态。
 *
 * ★ 为什么要这层映射：`ReaderOverlay.vue`（当前被冻结）仍调用 `toggleSmallMode` 等旧封装，
 *   而 818 起的 preload 只暴露 `float-*`。若这里直接回 `desktop-shell-outdated`，
 *   主机上就会出现「歌词窗能用、小窗打不开」——正是这次实机反馈。
 *   迷你档已取消：任何非 bar 的档都归到 regular，不再谎报 240×180。
 */
function floatToSmallState(s: FloatStatePayload): DesktopSmallState {
  const tier: DesktopSmallTier = s.mode === 'bar' ? 'bar' : 'regular';
  const open = s.open === true;
  return {
    ok: s.ok !== false,
    available: s.available !== false,
    small: open,
    tier,
    width: s.width,
    height: s.height,
    tierWidth: tier === 'bar' ? s.barWidth : s.regularWidth,
    tierHeight: tier === 'bar' ? s.barHeight : s.regularHeight,
    smallWidth: s.regularWidth,
    smallHeight: s.regularHeight,
    miniWidth: s.regularWidth,
    miniHeight: s.regularHeight,
    barWidth: s.barWidth,
    barHeight: s.barHeight,
    barSpeed: s.speed,
    barClickThrough: s.clickThrough,
    normalMinWidth: s.normalMinWidth,
    normalMinHeight: s.normalMinHeight,
    reason: s.reason,
  };
}

export const getSmallState = (): Promise<DesktopSmallState> | null => {
  const b = bridge();
  if (!b) return null;
  if (typeof b.getSmallState === 'function') return b.getSmallState();
  if (typeof b.getFloatState === 'function') return b.getFloatState().then(floatToSmallState);
  if (typeof b.getMiniState === 'function') return b.getMiniState();
  return null;
};

/** `mode` 省略 = 切换；true=进入浮窗·常规；false=退出浮窗 */
export const toggleSmallMode = (mode?: boolean): Promise<DesktopSmallState> | null => {
  const b = bridge();
  if (!b) return null;
  if (typeof b.toggleSmall === 'function') return b.toggleSmall(mode);
  // 818+：新外壳只有 float API；旧调用名在**这一层**翻译，不要求冻结的 ReaderOverlay 改调用点
  if (typeof b.toggleFloat === 'function' && typeof b.closeFloat === 'function') {
    const p = mode === false ? b.closeFloat() : b.toggleFloat('regular');
    return p.then(floatToSmallState);
  }
  // 中间版本可能只有 toggleMini（旧语义：只有 240×180 小窗）
  if (typeof b.toggleMini === 'function') {
    notifyShellOutdated();
    return b.toggleMini(mode);
  }
  notifyShellOutdated();
  return Promise.resolve(outdatedSmallState('desktop-shell-outdated'));
};

/** 小窗两档切换：regular（420×320） ⇄ bar（条形阅读）；mini 已取消 ⇒ 归到 regular */
export const setSmallWindowTier = (tier: DesktopSmallTier): Promise<DesktopSmallState> | null => {
  const b = bridge();
  if (!b) return null;
  if (typeof b.setSmallTier === 'function') return b.setSmallTier(tier);
  if (typeof b.setFloatMode === 'function') {
    return b.setFloatMode(tier === 'bar' ? 'bar' : 'regular').then(floatToSmallState);
  }
  if (tier === 'mini' && typeof b.toggleMini === 'function') {
    notifyShellOutdated();
    return b.toggleMini(true);
  }
  notifyShellOutdated();
  return Promise.resolve(outdatedSmallState('desktop-shell-outdated'));
};

/** 主进程几何/形态变化后广播（浮窗 ✕ 退出也走这里）；浏览器里返回空退订 */
export const onSmallStateChange = (cb: (state: DesktopSmallState) => void): (() => void) => {
  const b = bridge();
  if (!b) return () => {};
  if (typeof b.onSmallState === 'function') return b.onSmallState(cb);
  if (typeof b.onFloatState === 'function') return b.onFloatState((s) => cb(floatToSmallState(s)));
  if (typeof b.onMiniState === 'function') return b.onMiniState(cb);
  return () => {};
};

/**
 * B18 条形档：把当前章节正文行推给浮窗（与歌词窗共用同一扇 OS 级置顶窗）。
 * 旧外壳没有这个方法 ⇒ 不发送、也不抛错；界面会按 `available:false` 给出提示。
 */
export const publishBarReading = (state: DesktopBarReading): void => {
  const b = bridge();
  if (!b || typeof b.floatReading !== 'function') return;
  try { b.floatReading(state); } catch { /* 旧外壳/窗口正在销毁 */ }
};

/**
 * `D4` F11 全屏切换。
 *
 * 桌面端走主进程的 `BrowserWindow#setFullScreen`（能盖住标题栏/任务栏，与系统全屏一致）；
 * **非桌面 Web 端**没有桥 ⇒ 回退到浏览器 Fullscreen API（在 iframe/不支持时静默失败，不抛给调用方）。
 * 返回切换后的「是否全屏」仅作参考，调用方不必依赖（桌面端以主进程实时值为准）。
 */
export async function toggleFullscreen(): Promise<boolean> {
  const b = bridge();
  if (b) {
    try {
      const r = await b.toggleFullscreen();
      return r.ok !== false && r.fullscreen === true;
    } catch {
      return false;
    }
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await document.documentElement.requestFullscreen();
    return true;
  } catch {
    // 浏览器拒绝（无用户手势 / iframe 权限 / 不支持）⇒ 不打扰用户
    return false;
  }
}

/**
 * 歌词窗点了「关闭」⇒ 主进程把开关落盘为 false 并回报。
 * 设置页据此同步勾选框（否则页面开着时仍显示「开」，用户以为还能弹出来）。
 * 浏览器里没有桥 ⇒ 返回空退订函数，调用方不用判空。
 */
export const onLyricsEnabledChange = (cb: (enabled: boolean) => void): (() => void) =>
  bridge()?.onLyricsEnabled(cb) ?? (() => {});

/* ------------------------------------------------------------------ *
 * 「双击打开」→ 导入 → 阅读
 * ------------------------------------------------------------------ */

/**
 * 把一个已读好的文件导入并打开。
 *
 * 与书架「导入本地书」按钮的差别**只有一处**：这里没有编码选择（走服务端自动探测）。
 * ★ 这是**有代价**的：无 BOM 的 GBK 与 Big5 存在互相误判可能（`#234`）——
 *   认错就是整本乱码且不报错。所以探测失败/乱码时，界面要给出「改用书架导入并手动选编码」的出路
 *   （见下面的提示文案），而不是让用户以为「这本书就是坏的」。
 */
async function importAndOpen(file: ShellOpenFile): Promise<{ url: string; label: string }> {
  const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data as ArrayBuffer);
  /**
   * `File` 要的是 `BlobPart`，而 TS 把 `Uint8Array` 的 buffer 类型放宽成 `ArrayBufferLike`
   * （可能是 `SharedArrayBuffer`）⇒ 直接传会报 TS2322。
   * 这里用一次**有依据的**断言而不是 `new Uint8Array(bytes)` 再拷一份：
   * 字节经 Electron 的 IPC（结构化克隆）过来，**必定是渲染进程自己新拥有的非共享 ArrayBuffer**
   * —— 而本地书可以有上百 MB，为了躲类型报错再整份拷一遍是实打实的浪费。
   */
  const blobPart = bytes as unknown as ArrayBufferView<ArrayBuffer>;
  const domFile = new File([blobPart], file.name, { type: 'application/octet-stream' });
  const url = localBookUrlOf(file.name);
  const r = await importLocalBookFile(domFile, url);
  return { url, label: `${r.book.name || file.name} · ${r.chapterCount} 章${r.summary?.tocRuleName ? `（${r.summary.tocRuleName}）` : ''}` };
}

/** 收到主进程送来的文件（双击 txt/epub、托盘菜单「打开本地书籍」，两者同一条路） */
export async function handleShellOpenFiles(files: ShellOpenFile[]): Promise<void> {
  if (!files?.length) return;
  const reader = useReaderStore();
  const ok: string[] = [];
  const bad: string[] = [];
  const urls: string[] = [];
  for (const f of files) {
    try {
      const r = await importAndOpen(f);
      ok.push(r.label);
      urls.push(r.url);
    } catch (e) {
      bad.push(`${f.name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // 导入是**服务端落库**，本地缓存要重新对齐（与书架导入后做的是同一件事）
  try {
    await reader.hydrateShelf();
  } catch (e) {
    console.warn('[desktop] 导入后对齐书架失败：', e);
  }
  if (bad.length) toast(`有 ${bad.length} 个文件没能导入：${bad.join('；')}`, 'warn', 12000);
  if (!ok.length) return;
  toast(`已导入 ${ok.length} 本本地书：${ok.join('；')}`, 'info', 10000);

  // 双击的语义是「打开它」⇒ 导入成功后直接续读第一本（与书架点封面的行为一致）
  const first = urls[0];
  const book = reader.bookShelf.find((b) => b.key && encodeItemKey(b.key) === first);
  if (book) {
    await reader.openShelfBook(book, { read: true });
  } else {
    // 防空转：要说清「导入成功但没找到它」，而不是静默什么也不发生
    toast('导入成功，但书架里暂时没找到这本书（去书架页刷新看看）', 'warn', 10000);
  }
}

/** 界面上的「打开本地书籍（txt / epub）…」按钮 → 走主进程的文件对话框 */
export async function pickAndOpenLocalBook(): Promise<void> {
  const b = bridge();
  if (!b) return;
  const r = await b.openLocalBook();
  if (!r || r.canceled) return;
  if (!r.ok) {
    toast(`打开失败：${r.error || '未知原因'}`, 'warn', 10000);
    return;
  }
  if (r.failed?.length) toast(`有 ${r.failed.length} 个文件打不开：${r.failed.map((f) => `${f.name}（${f.error}）`).join('；')}`, 'warn', 12000);
}

/* ------------------------------------------------------------------ *
 * 桌面朗读歌词：把**现有**朗读 store 的状态上报，不另造播放器
 * ------------------------------------------------------------------ */

/**
 * 只做三件事：① 把 `index` / `innerPos` / 前后句 / 播放态发给主进程；
 * ② 接歌词窗的上一句/播放暂停/下一句命令；③ 40ms 节流（与参照项目一致）。
 *
 * 这里**不创建窗口、不做 UI**：歌词窗是 `apps/desktop/lyrics.html` 的独立 BrowserWindow，
 * 浏览器里 `bridge()` 为 null ⇒ 整段不会执行，Web 端不出现任何入口。
 */
function initLyricsPublisher(b: YueduBridge): void {
  const al = useReadAloudStore();
  // 依赖含「当前句前后文本」⇒ 换章后句数相同也会重绘（纯逻辑与单测在 utils/desktop-lyrics.ts）
  startLyricsPublisher(
    () => ({ state: al.state, index: al.index, innerPos: al.innerPos, sentences: al.sentences }),
    (p) => b.lyricsState(p),
  );

  b.onLyricsCommand((cmd) => {
    if (cmd === 'prev') al.prevParagraph();
    else if (cmd === 'next') al.nextParagraph();
    else if (cmd === 'chapterPrev') al.prevChapter();
    else if (cmd === 'chapterNext') al.nextChapter();
    else if (cmd === 'toggle') {
      if (al.state === 'playing') al.pause();
      else al.resume();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 浮窗阅读正文：把**现有**阅读 store 的章节数据推给独立浮窗
 * ------------------------------------------------------------------ */

/** 目录上限：一次 IPC 只传标题；超长目录截断，避免每章几千条标题反复过桥 */
const FLOAT_TOC_MAX = 2000;

/** 主窗正文滚动位置（0~1）；浮窗进入时据此恢复，不另存一份进度 */
function floatScrollRatio(): number {
  if (typeof document === 'undefined') return 0;
  return scrollRatio(document.querySelector<HTMLElement>('.se-body'));
}

/**
 * 桌面浮窗（常规 / 条形）的正文与目录数据源。
 *
 * ★ 为什么在这里而不是 `ReaderOverlay.vue`：后者本轮被冻结；而浮窗需要的
 *   「段落 + 章标题 + 目录 + 阅读位置」本来就在 reader store 里，桌面桥是唯一的
 *   Electron 专属出口，放这里不碰阅读器渲染逻辑。
 * ★ 浮窗正文流的**唯一** publisher：`ReaderOverlay` 里那份 46 字/行的旧实现已删除，
 *   浮窗渲染层始终按真实窗宽折行（与 Web PiP 同一套算法）。
 */
function initFloatReadingPublisher(b: YueduBridge): void {
  const r = useReaderStore();
  const al = useReadAloudStore();
  let open = false;
  let mode: 'lyrics' | 'regular' | 'bar' = 'lyrics';
  let lastIdx = -1;
  let lastKey = '';
  /** 开窗 / 切形态瞬间的主窗阅读位置：下一次 publish 用它起算，而不是当成换章归零 */
  let enterRatio: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (force = false): void => {
    // 浮窗阅读打开，或桌面歌词正在使用（歌词标题行/目录也要同一份数据）
    if (!open && !al.active) return;
    const paragraphs = Array.isArray(r.displayParagraphs) ? r.displayParagraphs : [];
    const allChapters = r.detail?.chapters ?? [];
    const chapters: string[] = [];
    for (let i = 0; i < allChapters.length && i < FLOAT_TOC_MAX; i += 1) {
      chapters.push(String(r.tocTitleAt(i) || ''));
    }
    const idx = Number.isFinite(r.chapterIdx) ? Math.max(0, r.chapterIdx) : 0;
    // 换章时从章首开始；开窗/切形态沿用快照的主窗位置；同一章后续推送沿用当前滚动位置
    const freshChapter = idx !== lastIdx;
    const ratio = enterRatio !== null ? enterRatio : freshChapter ? 0 : floatScrollRatio();
    const first = paragraphs[0] || '';
    const last = paragraphs[paragraphs.length - 1] || '';
    const key = [open, mode, al.active, idx, r.displayTitle, paragraphs.length, first, last, chapters.length].join('\u0001');
    if (!force && key === lastKey) return;
    enterRatio = null;
    lastKey = key;
    lastIdx = idx;
    publishBarReading({
      title: r.detail?.title || '阅读',
      chapterLabel: chapters.length ? `${idx + 1}/${chapters.length}` : '',
      chapterTitle: r.displayTitle || '',
      paragraphs: paragraphs.slice(0, 600).map((s) => String(s || '').slice(0, 2000)),
      chapters: chapters.map((s) => s.slice(0, 120)),
      chapterIdx: idx,
      ratio,
      // 旧字段保留：老外壳/旧渲染层仍能按行渲染
      lines: [],
      total: paragraphs.length,
      index: 0,
      updatedAt: Date.now(),
    });
  };

  const schedulePublish = (force = false): void => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; publish(force); }, 0);
  };

  watch(
    () => [
      open,
      mode,
      al.active,
      r.chapterIdx,
      r.displayTitle,
      Array.isArray(r.displayParagraphs) ? r.displayParagraphs.length : 0,
      Array.isArray(r.displayParagraphs) ? r.displayParagraphs[0] || '' : '',
      r.detail?.chapters?.length ?? 0,
    ],
    () => schedulePublish(),
  );

  const applyFloatState = (s: FloatStatePayload): void => {
    const nextOpen = s.open === true;
    const nextMode: 'lyrics' | 'regular' | 'bar' = s.mode === 'bar' || s.mode === 'regular' ? s.mode : 'lyrics';
    const changed = nextOpen !== open || nextMode !== mode;
    open = nextOpen;
    mode = nextMode;
    if (!changed) return;
    /**
     * 开窗 / 切形态 ⇒ 快照主窗当前阅读位置并强制重推一次：新形态要重新按宽折行，
     * 条形档从「现在读到的地方」起算（换章才归零，见 `publish()`）。
     */
    enterRatio = nextOpen ? floatScrollRatio() : null;
    lastKey = '';
    schedulePublish(true);
  };
  if (typeof b.getFloatState === 'function') {
    void b.getFloatState().then(applyFloatState).catch(() => {});
  }
  if (typeof b.onFloatState === 'function') b.onFloatState(applyFloatState);

  if (typeof b.onFloatCommand === 'function') {
    b.onFloatCommand((raw) => {
      const cmd = raw && typeof raw === 'object' ? raw : { cmd: String(raw || '') };
      if (cmd.cmd === 'chapterPrev') { void r.chOffset(-1); return; }
      if (cmd.cmd === 'chapterNext') { void r.chOffset(1); return; }
      if (cmd.cmd === 'chapterOpen') {
        const i = Math.round(Number(cmd.value));
        const ch = i >= 0 ? (r.detail?.chapters ?? [])[i] : null;
        if (ch) void r.openChapter({ title: ch.title ?? '', payload: ch.payload });
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * 启动时接线
 * ------------------------------------------------------------------ */

let inited = false;

/**
 * 在应用挂载**之后**调用（要用 pinia / router）。
 *
 * ★ 顺序很关键：**先挂监听、再通知主进程就绪**（`rendererReady()`）——
 *   反过来的话主进程可能在我们还没监听时就把文件发出去，那批双击就被丢了。
 *
 * ★ `opts.navigate`：托盘菜单「桌面端设置…」要跳路由。**router 由调用方注入**（`main.ts`）
 *   而不是本文件 `import './router'` —— 否则会形成
 *   `router/index.ts → layouts/MainLayout.vue → desktop.ts → router/index.ts` 的循环，
 *   开发态（vite dev，非打包后的单文件）在模块初始化顺序不利时会抛
 *   `Cannot access 'MainLayout' before initialization` 而白屏。
 */
export function initDesktopBridge(opts: { navigate?: (path: string) => void } = {}): void {
  const b = bridge();
  if (!b || inited) return;
  inited = true;

  b.onOpenFiles((files) => {
    void handleShellOpenFiles(files).catch((e) => {
      console.error('[desktop] 处理双击打开失败：', e);
      toast(`打开本地书失败：${e instanceof Error ? e.message : String(e)}`, 'warn', 12000);
    });
  });

  /**
   * `#347` 点导入链接唤起（`yuedu://` / `legado://`）⇒ 投递到统一派发器。
   * ★ 不在本文件判型/开对话框 —— 处理逻辑只有一份（`ReaderOverlay.onLegadoUrl`），
   *   由 `dispatchSchemeImport` 桥接（见 `utils/scheme-import.ts` 顶部注释）。
   */
  b.onSchemeUrl((url) => dispatchSchemeImport(url));

  // 托盘菜单「桌面端设置…」⇒ 走调用方注入的 router（本文件不直接依赖 router，见函数头注）
  b.onNavigate((p) => { opts.navigate?.(p); });

  // 桌面朗读歌词：只上报既有朗读状态，不新建播放器/窗口
  initLyricsPublisher(b);

  // 桌面浮窗阅读（常规/条形）：正文 / 章标题 / 目录 / 章节动作
  initFloatReadingPublisher(b);

  b.rendererReady();
}
