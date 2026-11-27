/**
 * 阅读浮窗（Web）—— **唯一实现**：外壳 CSS / 工具条按钮表 / 热区判定 / 速度档位 /
 * 字号档位 / 字色表 / 空态文案 / 按宽切行。
 *
 * ## 本轮的形态（Web）
 * · **只保留两态**：`read` 常规窗、`bar` 条形窗，**都走 Document PiP**；
 *   页内浮窗/页内浮条整套退役（PiP 不可用时由承载层给明确提示，不静默降级）。
 * · `lyrics` 不是第三种态，而是同一外壳的**第二种内容源**（跟随朗读）。
 * · 承载层（`ReaderMiniBar.vue`）只做「开窗 / 换内容源 / 恢复位置」，不再写按钮、热区、样式。
 */
import floatGeometry from '../../../desktop/float-geometry.json';

export type FloatMode = 'read' | 'bar' | 'lyrics';
/** Web 只有两态（常规 / 条形）；`mini` 已取消 */
export type FloatTier = 'regular' | 'bar';

/* ------------------------------------------------------------------ *
 * 几何下限 —— 唯一真源 `apps/desktop/float-geometry.json`
 * ------------------------------------------------------------------ *
 * 桌面主进程 `desktop-lib.js` `require` 的是**同一个文件**，Web 也在这里派生 ⇒
 * 改下限只改 json，两端同步。★ 不要写 180/120 字面量。
 */
export const FLOAT_MIN_W: number = floatGeometry.minWidth;
export const FLOAT_MIN_H: number = floatGeometry.minHeight;
/** 工具条热区高度（用户要求统一 48，原来 44/48 两套漂移） */
export const DOCK_REVEAL_H: number = floatGeometry.headZoneHeight;

/** 常规窗默认尺寸（可被用户拖动缩放，下限见 FLOAT_MIN_W/H） */
export const REGULAR_W = 420;
export const REGULAR_H = 320;
/** 条形窗高度（宽度 = 正文栏宽） */
export const BAR_H = 140;
/** 三行歌词窗高度（前后句关掉时仍固定，避免窗口反复跳） */
export const LYRICS_H = 136;
/** 正文栏宽取不到时的兜底（条形窗宽度） */
export const READER_COLUMN_FALLBACK = 920;

/* ------------------------------------------------------------------ *
 * 偏好（两态 + 歌词共用这一份）
 * ------------------------------------------------------------------ */
export const FLOAT_KEYS = {
  speed: 'yuedu.reader.float.speed',
  fontPx: 'yuedu.reader.float.fontPx',
  fontColor: 'yuedu.reader.float.fontColor',
  /** 浮窗背景（壳底色，不是页面主题） */
  bgColor: 'yuedu.reader.float.bgColor',
  /** 歌词「显示前后句」：语义与桌面 `lyricsShowNeighbors` 一致，默认开 */
  lyricsNeighbors: 'yuedu.reader.lyrics.showNeighbors',
} as const;

export const FONT_SIZES = [13, 15, 17, 19, 21] as const;
export const DEFAULT_FONT_PX = 15;

/**
 * 字色 / 背景色表 —— 唯一真源 `apps/desktop/float-geometry.json`。
 * 桌面浮窗（`lyrics.js`）也通过主进程拿到同一张表，不再两端各写五组十六进制。
 * `''` = 跟随主题（Web 不写 `--yf-fg`；桌面映射为各自的默认底色）。
 */
export const FONT_COLORS: ReadonlyArray<{ v: string; label: string }> = floatGeometry.palette.text;
export const BG_COLORS: ReadonlyArray<{ v: string; label: string }> = floatGeometry.palette.bg;

/** 速度档位（毫秒/行） */
export const SPEED_MS: Record<number, number> = { 1: 4200, 2: 2600, 3: 1600 };
export const SPEED_LABEL: Record<number, string> = { 1: '慢', 2: '中', 3: '快' };

export function loadFontPx(): number {
  const n = Number(localStorage.getItem(FLOAT_KEYS.fontPx));
  return (FONT_SIZES as readonly number[]).includes(n) ? n : DEFAULT_FONT_PX;
}
export function saveFontPx(v: number): void {
  try { localStorage.setItem(FLOAT_KEYS.fontPx, String(v)); } catch { /* ignore */ }
}
export function loadFontColor(): string {
  // 预设之外还允许「自定义取色」的任意 #rrggbb，刷新后不能又退回主题色
  const v = localStorage.getItem(FLOAT_KEYS.fontColor);
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : '';
}
export function saveFontColor(v: string): void {
  try { localStorage.setItem(FLOAT_KEYS.fontColor, v); } catch { /* ignore */ }
}
export function loadBgColor(): string {
  const v = localStorage.getItem(FLOAT_KEYS.bgColor);
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v : '';
}
export function saveBgColor(v: string): void {
  try { localStorage.setItem(FLOAT_KEYS.bgColor, v); } catch { /* ignore */ }
}
export function loadSpeed(): number {
  const n = Number(localStorage.getItem(FLOAT_KEYS.speed));
  return n === 1 || n === 3 ? n : 2;
}
export function saveSpeed(v: number): void {
  try { localStorage.setItem(FLOAT_KEYS.speed, String(v)); } catch { /* ignore */ }
}
export function loadLyricsNeighbors(): boolean {
  return localStorage.getItem(FLOAT_KEYS.lyricsNeighbors) !== '0';
}
export function saveLyricsNeighbors(on: boolean): void {
  try { localStorage.setItem(FLOAT_KEYS.lyricsNeighbors, on ? '1' : '0'); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * 空态文案（只有这一份；承载层不再各写一句）
 * ------------------------------------------------------------------ */
export const FLOAT_EMPTY = {
  read: '正文加载中…',
  bar: '（正文加载中…）',
  lyrics: '（等待朗读…）',
  toc: '目录加载中…',
} as const;

/** PiP 不可用时的**可操作提示**（不再静默降级成页内浮窗） */
export const FLOAT_PIP_TIPS = {
  missing: '小窗阅读需要 Document PiP：请用 Chrome/Edge 116+ 打开本页后重试，或改用桌面端小窗。',
  blocked: '浏览器要求由页面内的按钮触发小窗：请从「阅读界面 → 更多 → 小窗阅读」重新点开。',
  timeout: '浏览器没有响应小窗请求：请确认未被弹窗拦截，然后从「更多 → 小窗阅读」重试。',
} as const;

/* ------------------------------------------------------------------ *
 * 工具条（唯一按钮表：图标 / 顺序 / 标题 / 形态归属都只写一次）
 * ------------------------------------------------------------------ *
 * 顺序按用户要求：目录 / 上一章 / 下一章 / A− / A+ / 文字颜色 / 切换（常规↔条形）。
 * 条形额外保留「速度」；歌词额外保留「显示前后句 + 播放/上一句/下一句」。
 */
export type FloatToolId =
  | 'toc' | 'chapterPrev' | 'chapterNext'
  | 'fontDown' | 'fontUp' | 'color' | 'tier'
  | 'speed' | 'neighbors'
  | 'playPause' | 'sentencePrev' | 'sentenceNext';

export interface FloatToolDef {
  id: FloatToolId;
  icon: string;
  title: string;
  /** 出现于哪些内容形态（read/bar/lyrics） */
  modes: readonly FloatMode[];
}

/**
 * 歌词控制图标 —— **与 PC 端同一组 path**（`apps/desktop/lyrics.html` 的按钮 +
 * `lyrics.js` 切换播放/暂停时的 innerHTML），不再用近似字符（`◀ / ▶` 与 PC 对不上）。
 */
const ICON_SENTENCE_PREV = '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zm3.5 7 10.5 7V5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_SENTENCE_NEXT = '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l10.5-7z"/></svg>';

export const FLOAT_TOOLS: readonly FloatToolDef[] = [
  { id: 'toc', icon: '☰', title: '目录', modes: ['read', 'bar', 'lyrics'] },
  // 上一章 / 下一章：沿用 PC 端 `‹‹ / ››`（用户 2026-11-14 要求三态统一）
  { id: 'chapterPrev', icon: '‹‹', title: '上一章', modes: ['read', 'bar', 'lyrics'] },
  { id: 'chapterNext', icon: '››', title: '下一章', modes: ['read', 'bar', 'lyrics'] },
  { id: 'fontDown', icon: 'A−', title: '字号减小', modes: ['read', 'bar', 'lyrics'] },
  { id: 'fontUp', icon: 'A+', title: '字号增大', modes: ['read', 'bar', 'lyrics'] },
  { id: 'color', icon: '🎨', title: '文字颜色', modes: ['read', 'bar', 'lyrics'] },
  { id: 'tier', icon: '▤', title: '切换条形阅读', modes: ['read', 'bar'] },
  { id: 'speed', icon: '⏱', title: '滚动速度', modes: ['bar'] },
  { id: 'neighbors', icon: '👁', title: '显示前后句：开', modes: ['lyrics'] },
  // 歌词：上一句 → 暂停/继续 → 下一句（与 PC 端 lyrics.html 的按钮顺序一致）
  { id: 'sentencePrev', icon: ICON_SENTENCE_PREV, title: '上一句', modes: ['lyrics'] },
  { id: 'playPause', icon: ICON_PAUSE, title: '暂停朗读', modes: ['lyrics'] },
  { id: 'sentenceNext', icon: ICON_SENTENCE_NEXT, title: '下一句', modes: ['lyrics'] },
];

export interface FloatToolState {
  mode: FloatMode;
  tier: FloatTier;
  playing: boolean;
  neighbors: boolean;
}

/** 动态图标/标题（其余按钮静态） */
export function presentTool(def: FloatToolDef, s: FloatToolState): { icon: string; title: string } {
  if (def.id === 'tier') {
    return s.tier === 'bar'
      ? { icon: '▭', title: '切回常规窗' }
      : { icon: '▤', title: '切换条形阅读' };
  }
  if (def.id === 'playPause') {
    return s.playing ? { icon: ICON_PAUSE, title: '暂停朗读' } : { icon: ICON_PLAY, title: '继续朗读' };
  }
  if (def.id === 'neighbors') {
    return s.neighbors
      ? { icon: '👁', title: '显示前后句：开' }
      : { icon: '◌', title: '显示前后句：关' };
  }
  return { icon: def.icon, title: def.title };
}

/* ------------------------------------------------------------------ *
 * 浮现热区
 * ------------------------------------------------------------------ *
 * 两态统一：**按 Y 判定、横向不限**（整条工具条横向全宽，按钮所在 48px 高度带都算热区），
 * 鼠标在带内任意横向移动都不会收回。
 * 唯一显式例外：歌词窗「整窗悬停」——由承载层直接调用 `showDock(true)`。
 */
export function shouldRevealDock(offsetY: number): boolean {
  return offsetY <= DOCK_REVEAL_H;
}

/* ------------------------------------------------------------------ *
 * 按宽切行（唯一的折行实现；不再有固定字符数）
 * ------------------------------------------------------------------ *
 * · 逐字累加 `measureText`，超出容器宽就断行；
 * · 断点优先回退到最近标点/空格（但不会把这一行切空）；
 * · 每个行记录 `start`（在拼接全文中的字符偏移），字号/宽度变化后按锚点重定位；
 * · **一个字符都不会丢**：单字超宽也整字带入该行。
 */
export interface FloatLine {
  text: string;
  /** 在拼接全文中的字符偏移；**章节标题行 = -1**（标题不属于正文，不参与锚点定位） */
  start: number;
  /** 章节标题行（条形 / 歌词共用同一套三行轨道，只换字重与字色以示区分） */
  title?: boolean;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  try {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
  } catch { measureCtx = null; }
  return measureCtx;
}
const FONT_STACK = '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
const BREAK_CHARS = '，。！？；：、,.!?;:)]}」』”’ ';

export function measureWidth(text: string, px: number): number {
  const c = ctx();
  if (!c) return text.length * px;
  c.font = `650 ${px}px ${FONT_STACK}`;
  return c.measureText(text).width;
}

/**
 * 把若干段落按容器宽度折成行。
 * @param paragraphs 段落原文（段间按空格拼接，与 `start` 偏移一致）
 * @param maxW 可用宽度（像素）
 * @param px 当前字号（当前行字号）
 */
export function splitParagraphs(paragraphs: readonly string[], maxW: number, px: number): FloatLine[] {
  const src = paragraphs.filter((s) => s && s.trim()).join(' ');
  if (!src) return [];
  const lines: FloatLine[] = [];
  let from = 0;
  while (from < src.length) {
    let width = 0;
    let i = from;
    let lastBreak = -1;
    for (; i < src.length; i += 1) {
      const w = measureWidth(src[i]!, px);
      if (width + w > maxW && i > from) break;
      width += w;
      if (BREAK_CHARS.includes(src[i]!)) lastBreak = i;
    }
    // 断点优先：回退到最近标点/空格（不回退到行首，避免空行）
    if (i < src.length && lastBreak >= from && i - lastBreak <= Math.ceil((i - from) / 3)) i = lastBreak + 1;
    const text = src.slice(from, i);
    if (text) lines.push({ text, start: from });
    from = i;
    // 跳过拼接用的空格（不额外产生空行）
    while (from < src.length && src[from] === ' ') from += 1;
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * 阅读位置 → 条形档行号（**两端唯一口径**）
 * ------------------------------------------------------------------ *
 * 桌面桥（`desktop.ts` 推 `ratio`、`lyrics.js` 按比例定位）与 Web PiP
 * （`ReaderMiniBar.vue` 打开条形档）都调下面两个函数，不再各写一份取整。
 */
/** 滚动容器的当前滚动比 0..1；容器不可滚（如分页模式 `.se-body` 为 hidden）时返回 0 */
export function scrollRatio(el: HTMLElement | null | undefined): number {
  if (!el) return 0;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.max(0, Math.min(1, el.scrollTop / max)) : 0;
}

/** 滚动比 → 条形档当前行号；行数 ≤ 0 时返回 0 */
export function currentBarIndex(lineCount: number, ratio: number): number {
  if (lineCount <= 0) return 0;
  const r = Math.max(0, Math.min(1, ratio));
  return Math.round(r * (lineCount - 1));
}

/* ------------------------------------------------------------------ *
 * 外壳样式（只有这一份；PiP 里以 `<style>` 注入）
 * ------------------------------------------------------------------ */
export const FLOAT_CSS = `
  .yf-wrap { position: relative; height: 100%; box-sizing: border-box; overflow: hidden;
    background: var(--yf-bg, var(--bg-1, #16161a)); color: var(--text-0, #eaeaea);
    --yf-fs: 15px; --yf-fs-adj: 13px; --yf-fs-cur: 22px;
    --yf-lh-read: 29px; --yf-lh-adj: 20px; --yf-lh-cur: 33px;
    --yf-sbw: 15px; --yf-gap: 5px;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .yf-view { display: none; height: 100%; box-sizing: border-box; }

  /* 正文（常规窗）：滚动容器必须是**有确定高度**的 view —— body 高度 auto 会被 wrap 裁掉 ⇒ 无滚动条 */
  .yf-wrap.yf-read .yf-readview { display: block; overflow-y: auto; overscroll-behavior: contain;
    padding: 22px var(--yf-gap) 16px; scrollbar-gutter: stable; }
  /* 颜色浮层打开时给正文让出底部空间（不遮挡可读区域） */
  .yf-wrap.yf-panel-on .yf-readview { height: calc(100% - var(--yf-panelh, 0px)); }
  .yf-wrap.yf-panel-on .yf-linesview { height: calc(100% - var(--yf-panelh, 0px)); }
  .yf-body { font-size: var(--yf-fs); line-height: var(--yf-lh-read, 29px);
    color: var(--yf-fg, var(--text-0, #eaeaea)); }
  .yf-chap { font-size: 13px; color: var(--muted, #9a9aa2); margin: 0 0 10px; }
  .yf-text p { margin: 0 0 0.9em; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  .yf-empty { color: var(--muted, #9a9aa2); }

  /* 三行视口（条形 / 歌词共用）：轨道绝对定位，按实测行高把「当前行」垂直居中 */
  .yf-wrap.yf-bar .yf-linesview, .yf-wrap.yf-lyrics .yf-linesview { display: block; position: relative; overflow: hidden; }
  .yf-lines { position: absolute; left: 0; right: 0; top: 0; display: flex; flex-direction: column;
    gap: 2px; padding: 0 12px 0 var(--yf-gap); will-change: transform; }
  .yf-lines p { margin: 0; flex: 0 0 auto; text-align: center;
    white-space: normal; word-break: break-word; overflow-wrap: anywhere; }
  /* 推进动画：位移与字号/行高变化跑同一条 280ms 时间轴（同一曲线，同帧开始） */
  .yf-lines.yf-line-anim { transition: transform 280ms cubic-bezier(.33, .05, .24, 1); }
  .yf-lines.yf-line-anim p { transition: font-size 280ms cubic-bezier(.33, .05, .24, 1),
    line-height 280ms cubic-bezier(.33, .05, .24, 1), opacity 280ms ease; }
  .yf-line-prev, .yf-line-next { font-size: var(--yf-fs-adj, 13px); line-height: var(--yf-lh-adj, 20px);
    color: var(--yf-fg, var(--text-0, #eaeaea)); opacity: .5; }
  .yf-line-cur { font-size: var(--yf-fs-cur, 22px); line-height: var(--yf-lh-cur, 33px); font-weight: 650;
    color: var(--yf-fg, var(--text-0, #eaeaea)); }
  .yf-line-cur .yf-read { opacity: .55; }
  .yf-line-ghost { visibility: hidden; }
  /* 章节标题行（条形 / 歌词同一套轨道）：不改行高，只换字重与字色 */
  .yf-lines p.yf-line-title { font-weight: 700; color: var(--float-accent, #7aa2f7); }

  /* 工具条：横向全宽、48px 高度带；默认隐藏，带内移动不收回 */
  .yf-dock { position: absolute; left: 0; right: 0; top: 0; z-index: 3; box-sizing: border-box;
    height: ${DOCK_REVEAL_H}px; display: flex; align-items: center; flex-wrap: wrap; gap: 3px;
    padding: 0 8px; background: linear-gradient(rgba(8,10,14,.82), rgba(8,10,14,.48));
    backdrop-filter: blur(10px); opacity: 0; pointer-events: none; transition: opacity .18s ease; }
  .yf-wrap.yf-dock-on .yf-dock { opacity: 1; pointer-events: auto; }
  .yf-speed { font-size: 11px; color: var(--muted, #9a9aa2); margin-right: 2px; display: none; }
  .yf-wrap.yf-bar .yf-speed { display: inline; }
  .yf-spacer { flex: 1 1 auto; }
  .yf-dock button { width: 22px; height: 22px; min-width: 22px; padding: 0; border-radius: 6px;
    border: 1px solid transparent; background: transparent; color: inherit; font-size: 12px; line-height: 1;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .yf-dock button:hover { background: rgba(255,255,255,.12); }
  .yf-dock button[hidden] { display: none; }
  .yf-dock button.yf-tool-on { background: rgba(255,255,255,.22); }
  /* 歌词控制图标是内联 SVG（与 PC 端同一组 path），按 13px 居中渲染 */
  .yf-dock button svg { width: 13px; height: 13px; display: block; fill: currentColor; }

  /* 颜色设置浮层（三态同一份）：贴底浮出，高度由内容决定；打开时视口自动让位 */
  .yf-panel { position: absolute; left: 0; right: 0; bottom: 0; z-index: 5; box-sizing: border-box;
    display: none; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 7px 10px;
    background: rgba(8, 10, 14, .92); border-top: 1px solid rgba(255,255,255,.14);
    backdrop-filter: blur(10px); }
  .yf-wrap.yf-panel-on .yf-panel { display: flex; }
  .yf-panel .yf-grp { display: flex; align-items: center; gap: 4px; }
  .yf-panel .yf-cap { font-size: 11px; color: var(--muted, #9a9aa2); margin-right: 2px; }
  .yf-panel .yf-sw { width: 16px; height: 16px; min-width: 16px; padding: 0; border-radius: 50%;
    border: 1px solid rgba(255,255,255,.38); cursor: pointer; box-sizing: border-box; }
  .yf-panel .yf-sw.on { outline: 2px solid var(--float-accent, #7aa2f7); outline-offset: 1px; }
  /* 「跟随主题」= 半黑半白示意（不写死某个主题色） */
  .yf-panel .yf-sw.yf-sw-theme { background: linear-gradient(135deg, #2b2d33 0 50%, #d9dbe1 50% 100%); }
  .yf-panel input[type='color'] { width: 22px; height: 18px; padding: 0; border-radius: 4px;
    border: 1px solid rgba(255,255,255,.32); background: transparent; cursor: pointer; }
  .yf-panel input[type='color']::-webkit-color-swatch-wrapper { padding: 1px; }
  .yf-panel input[type='color']::-webkit-color-swatch { border: none; border-radius: 3px; }

  .yf-toc { position: absolute; inset: 0; z-index: 4; display: none; overflow-y: auto;
    background: var(--yf-bg, var(--bg-1, #16161a)); color: var(--text-0, #eaeaea); padding: 10px;
    scrollbar-gutter: stable; }
  .yf-toc.on { display: block; }
  .yf-toc p { margin: 0; padding: 7px 8px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .yf-toc p:hover { background: rgba(255,255,255,.08); }
  .yf-toc p.cur { background: rgba(255,255,255,.14); font-weight: 650; }
`;
