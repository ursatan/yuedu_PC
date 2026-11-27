<script setup lang="ts">
/**
 * Web 端「小窗阅读（常规 / 条形）」与「歌词窗」—— **同一套外壳，只换内容源**。
 *
 * ## 承载：只走 Document PiP
 * PiP 可脱离标签页、用户可拖边框缩放、位置由 UA 记忆。做不到（平台限制，如实）：
 * 窗口透明、去掉浏览器标题栏、点击穿透。
 * **页内浮窗/页内浮条已退役**：PiP 不可用时给一句可操作提示（toast）并关掉入口，
 * 不静默降级成页内浮窗。
 *
 * ## 形态
 * `read` 常规窗（自绘正文、竖直滚动）、`bar` 条形窗（三行整行推进）、
 * `lyrics` 同一外壳的第二种内容源（跟随朗读）。两态可在工具条里互相切换，
 * 切换时保留阅读位置（章不变 + 滚动比例/行锚点）。
 *
 * ## 复用
 * 按钮表、热区、速度、字号、字色、空态、按宽切行全部在 `reader-float-shared.ts`；
 * 本文件只负责：开窗、喂内容、恢复位置、把那套 DOM 装进 PiP。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useReaderStore } from '../stores/reader';
import { useReadAloudStore } from '../stores/read-aloud';
import type { DesktopSmallTier } from '../desktop';
import { toast } from '../toast';
import {
  BAR_H,
  BG_COLORS,
  DEFAULT_FONT_PX,
  FLOAT_CSS,
  FLOAT_EMPTY,
  FLOAT_MIN_H,
  FLOAT_MIN_W,
  FLOAT_PIP_TIPS,
  FLOAT_TOOLS,
  FONT_COLORS,
  FONT_SIZES,
  LYRICS_H,
  READER_COLUMN_FALLBACK,
  REGULAR_H,
  REGULAR_W,
  SPEED_LABEL,
  SPEED_MS,
  loadBgColor,
  loadFontColor,
  loadFontPx,
  loadLyricsNeighbors,
  loadSpeed,
  presentTool,
  saveBgColor,
  saveFontColor,
  saveFontPx,
  saveLyricsNeighbors,
  saveSpeed,
  shouldRevealDock,
  splitParagraphs,
  currentBarIndex,
  scrollRatio,
  type FloatLine,
  type FloatMode,
  type FloatTier,
  type FloatToolId,
  type FloatToolState,
} from './reader-float-shared';

const props = defineProps<{ tier: DesktopSmallTier; mode?: 'read' | 'lyrics' }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'tier', tier: FloatTier): void }>();
const r = useReaderStore();
const al = useReadAloudStore();

const isLyrics = computed(() => props.mode === 'lyrics');
/** 只有两态：常规 / 条形（`mini` 已取消，旧状态一律按常规） */
const tier = computed<FloatTier>(() => (props.tier === 'bar' ? 'bar' : 'regular'));
const mode = computed<FloatMode>(() => (isLyrics.value ? 'lyrics' : tier.value === 'bar' ? 'bar' : 'read'));

/* ------------------------------------------------------------------ *
 * 偏好（两态 + 歌词共用这一份）
 * ------------------------------------------------------------------ */
const fontPx = ref<number>(loadFontPx());
const fontColor = ref<string>(loadFontColor());
const bgColor = ref<string>(loadBgColor());
const speed = ref<number>(loadSpeed());
const neighbors = ref<boolean>(loadLyricsNeighbors());

const paragraphs = computed<string[]>(() => (r.displayParagraphs ?? r.chapter?.paragraphs ?? []) as string[]);
/**
 * 当前章标题 —— **与朗读 / 朗读控制条同一处**（`read-aloud.chapterTitle`，取自 `reader.displayTitle`，
 * 简繁转换后的显示标题）。条形首行、歌词窗标题行、常规窗页眉都用它，不再各拼一份。
 */
const chapterTitle = computed(() => al.chapterTitle);
const chapterLabel = computed(() => {
  const title = r.detail?.title || '阅读';
  return chapterTitle.value ? `${title} · ${chapterTitle.value}` : title;
});

/* ------------------------------------------------------------------ *
 * 位置（切换两态 / 字号变化时保留）
 * ------------------------------------------------------------------ */
/** 常规窗滚动比例 0..1（由 scroll 监听维护） */
let readRatio = 0;
/** 条形档当前位置：字符锚点（重切后按它重新定位，不会跳段） */
let barAnchor = 0;
let barIndex = 0;
let barLines: FloatLine[] = [];

function currentRatio(): number {
  if (mode.value === 'bar') return barLines.length ? barIndex / (barLines.length - 1) : 0;
  return readRatio;
}

/**
 * 进入条形 / 常规窗时的起始比例 = **主阅读页当前的滚动位置**。
 * 与桌面桥 `desktop.ts` 的 `floatScrollRatio()` 同一口径（都走共享 `scrollRatio()`），
 * 保证「从哪读到哪」两端一致；分页模式下 `.se-body` 不可滚 ⇒ 退化为 0（章首）。
 */
function readingStartRatio(): number {
  if (typeof document === 'undefined') return 0;
  return scrollRatio(document.querySelector<HTMLElement>('.se-body'));
}

/* ------------------------------------------------------------------ *
 * Document PiP
 * ------------------------------------------------------------------ */
type PipApi = { requestWindow?: (opts?: { width?: number; height?: number }) => Promise<Window> };
function pipApi(): PipApi | undefined {
  return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
}

interface ShellEls {
  wrap: HTMLElement;
  readview: HTMLElement;
  chap: HTMLElement;
  text: HTMLElement;
  linesView: HTMLElement;
  track: HTMLElement;
  rows: HTMLElement[];
  toc: HTMLElement;
  dock: HTMLElement;
  panel: HTMLElement;
  syncPanel: () => void;
  speedLabel: HTMLElement;
  tools: Array<{ id: FloatToolId; el: HTMLButtonElement }>;
}

let pipWin: Window | null = null;
let shell: ShellEls | null = null;
let dockOn = false;
let tocOn = false;
let panelOn = false;
let pipNoticeShown = false;
let barWidth = 700;
let timer: ReturnType<typeof setTimeout> | null = null;
let animToken = 0;
let animTimer: ReturnType<typeof setTimeout> | null = null;
let animBusy = false;
/** 当前三行内容（推进动画要从「旧内容」推到「新内容」） */
let lineState: LineState = { prev: '', cur: '', next: '', readChars: 0, showNeighbors: true };
interface LineState {
  prev: string;
  cur: string;
  next: string;
  readChars: number;
  showNeighbors: boolean;
  /** 该行是不是章节标题行（条形 / 歌词共用同一套轨道，只加一个字色类） */
  prevTitle?: boolean;
  curTitle?: boolean;
  nextTitle?: boolean;
}

function readingColumnWidth(): number {
  const el = document.querySelector('.se-body .rd-content') as HTMLElement | null;
  const w = el ? Math.round(el.getBoundingClientRect().width) : 0;
  return w >= 200 ? w : READER_COLUMN_FALLBACK;
}
function tierSize(): { w: number; h: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (isLyrics.value) return { w: Math.min(720, Math.max(320, vw - 48)), h: LYRICS_H };
  if (tier.value === 'bar') return { w: Math.min(readingColumnWidth(), Math.max(320, vw - 48)), h: BAR_H };
  return {
    w: Math.min(REGULAR_W, Math.max(FLOAT_MIN_W, vw - 16)),
    h: Math.min(REGULAR_H, Math.max(FLOAT_MIN_H, vh - 16)),
  };
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls = ''): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

/**
 * 颜色设置浮层（文字 / 背景各 5 个预设 + 自定义取色）。
 * 三态共用同一份 DOM 结构，只在打开时才出现在底部，且把视口让位给它。
 */
function buildColorPanel(doc: Document): { panel: HTMLElement; sync: () => void } {
  const panel = el(doc, 'div', 'yf-panel');
  const groups: Array<{ kind: 'font' | 'bg'; swatches: HTMLButtonElement[]; picker: HTMLInputElement }> = [];

  const make = (
    kind: 'font' | 'bg',
    caption: string,
    table: readonly { readonly v: string; readonly label: string }[],
    set: (v: string) => void,
  ): void => {
    const g = el(doc, 'div', 'yf-grp');
    const cap = el(doc, 'span', 'yf-cap');
    cap.textContent = caption;
    g.appendChild(cap);
    const swatches: HTMLButtonElement[] = [];
    table.forEach((item, i) => {
      const b = el(doc, 'button', item.v ? 'yf-sw' : 'yf-sw yf-sw-theme');
      b.type = 'button';
      b.setAttribute('data-yf-sw', `${kind}:${i}`);
      b.title = item.label;
      if (item.v) b.style.background = item.v;
      b.addEventListener('click', () => set(item.v));
      g.appendChild(b);
      swatches.push(b);
    });
    const picker = el(doc, 'input');
    picker.type = 'color';
    picker.setAttribute('data-yf-picker', kind);
    picker.title = kind === 'font' ? '自定义文字颜色' : '自定义背景颜色';
    picker.addEventListener('input', () => set(picker.value));
    g.appendChild(picker);
    panel.appendChild(g);
    groups.push({ kind, swatches, picker });
  };

  const sync = (): void => {
    for (const g of groups) {
      const table = g.kind === 'font' ? FONT_COLORS : BG_COLORS;
      const cur = g.kind === 'font' ? fontColor.value : bgColor.value;
      g.swatches.forEach((b, i) => { b.classList.toggle('on', table[i]!.v === cur); });
      g.picker.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : (g.kind === 'font' ? '#eaeaea' : '#16161a');
    }
  };

  make('font', '文字', FONT_COLORS, (v) => { fontColor.value = v; saveFontColor(v); applyView(); sync(); });
  make('bg', '背景', BG_COLORS, (v) => { bgColor.value = v; saveBgColor(v); applyView(); sync(); });
  sync();
  return { panel, sync };
}

function buildShell(doc: Document): ShellEls {
  const wrap = el(doc, 'div', `yf-wrap yf-${mode.value}`);
  const readview = el(doc, 'div', 'yf-view yf-readview');
  const body = el(doc, 'div', 'yf-body');
  const chap = el(doc, 'div', 'yf-chap');
  const text = el(doc, 'div', 'yf-text');
  body.append(chap, text);
  readview.appendChild(body);

  const linesView = el(doc, 'div', 'yf-view yf-linesview');
  const track = el(doc, 'div', 'yf-lines');
  const rows = [
    el(doc, 'p', 'yf-line-prev'),
    el(doc, 'p', 'yf-line-cur'),
    el(doc, 'p', 'yf-line-next'),
  ];
  track.append(...rows);
  linesView.appendChild(track);

  const toc = el(doc, 'div', 'yf-toc');

  const dock = el(doc, 'div', 'yf-dock');
  const speedLabel = el(doc, 'span', 'yf-speed');
  dock.appendChild(speedLabel);
  dock.appendChild(el(doc, 'span', 'yf-spacer'));
  const tools: ShellEls['tools'] = [];
  for (const t of FLOAT_TOOLS) {
    const b = el(doc, 'button');
    b.type = 'button';
    b.setAttribute('data-yf-tool', t.id);
    b.addEventListener('click', (e) => { e.preventDefault(); toolAction(t.id); });
    dock.appendChild(b);
    tools.push({ id: t.id, el: b });
  }

  const { panel, sync } = buildColorPanel(doc);
  wrap.append(readview, linesView, toc, dock, panel);
  return { wrap, readview, chap, text, linesView, track, rows, toc, dock, panel, syncPanel: sync, speedLabel, tools };
}

function pipBuild(win: Window, restoreRatio: number): void {
  const doc = win.document;
  doc.head.innerHTML = '';
  const style = doc.createElement('style');
  style.textContent = FLOAT_CSS;
  doc.head.appendChild(style);
  doc.title = isLyrics.value ? '歌词' : '小窗阅读';

  // 主题内联样式从主文档搬过来（PiP 里没有应用的 scoped CSS）
  const inline = document.documentElement.getAttribute('style');
  if (inline) doc.documentElement.setAttribute('style', inline);
  doc.documentElement.style.height = '100%';
  doc.documentElement.style.margin = '0';
  doc.body.innerHTML = '';
  doc.body.style.margin = '0';
  doc.body.style.height = '100%';
  doc.body.style.overflow = 'hidden';
  // PiP 表面本身不透明（平台限制）：直接铺主题底色
  doc.body.style.background = 'var(--bg-1, #16161a)';
  doc.body.style.color = 'var(--text-0, #eaeaea)';

  dockOn = false;
  tocOn = false;
  panelOn = false;
  lineState = { prev: '', cur: '', next: '', readChars: 0, showNeighbors: true };
  shell = buildShell(doc);
  doc.body.appendChild(shell.wrap);

  const s = shell;
  s.wrap.addEventListener('pointermove', (e) => {
    if (tocOn) return;
    // 颜色浮层落在 48px 热区之外：浮层打开时鼠标移出工具条带也不能收回
    if (panelOn) { setDock(true); return; }
    if (mode.value === 'lyrics') { setDock(true); return; } // 歌词窗：整窗悬停（唯一例外）
    setDock(shouldRevealDock(e.clientY));
  });
  s.wrap.addEventListener('pointerleave', () => { if (!panelOn) setDock(false); });
  // 点空白关闭浮层（浮层内 / 颜色按钮上不算空白）
  s.wrap.addEventListener('pointerdown', (e) => {
    if (!panelOn) return;
    const t = e.target as Element | null;
    if (t?.closest?.('.yf-panel') || t?.closest?.('[data-yf-tool="color"]')) return;
    setPanel(false);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOn) { e.preventDefault(); setPanel(false); }
  });
  s.readview.addEventListener('scroll', () => {
    const max = s.readview.scrollHeight - s.readview.clientHeight;
    readRatio = max > 0 ? s.readview.scrollTop / max : 0;
  });
  win.addEventListener('resize', onPipResize);

  barWidth = measureBarWidth();
  applyView();
  applyContent(restoreRatio);
  // 歌词窗：接上已读色进度（只在朗读中才推进）
  if (mode.value === 'lyrics') {
    resetProgress();
    if (al.isPlaying) startProgress();
  }
}

/**
 * 切行宽度 = **轨道内容盒实测宽度**（不是窗口宽度猜的）：
 * `innerWidth - 32` 在 padding 变化/出现滚动条槽时会比真实可用宽度窄，
 * 于是每行都短一截。这里直接量 `.yf-lines` 的 clientWidth 减去左右 padding。
 */
function measureBarWidth(): number {
  const s = shell;
  if (s) {
    const cs = getComputedStyle(s.track);
    const padL = parseFloat(cs.paddingLeft || '0') || 0;
    const padR = parseFloat(cs.paddingRight || '0') || 0;
    const w = s.track.clientWidth - padL - padR;
    if (w >= 120) return w;
  }
  return Math.max(200, (pipWin?.innerWidth ?? window.innerWidth) - 32);
}

let resizeRaf = 0;
function onPipResize(): void {
  if (!pipWin) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    const w = measureBarWidth();
    if (w !== barWidth) {
      barWidth = w;
      if (mode.value === 'bar') rebuildBar();
    }
  });
}

let pipPending = false;
async function openPip(restoreRatio: number): Promise<void> {
  const api = pipApi();
  if (!api?.requestWindow) {
    if (!pipNoticeShown) { pipNoticeShown = true; toast(FLOAT_PIP_TIPS.missing, 'warn', 9000); }
    emit('close');
    return;
  }
  if (pipPending) return;
  pipPending = true;
  const prev = pipWin;
  pipWin = null;
  if (prev) { try { prev.close(); } catch { /* ignore */ } }
  const size = tierSize();
  try {
    const req = api.requestWindow({ width: size.w, height: size.h });
    const win = await Promise.race<Window | null>([
      req,
      new Promise<null>((res) => { setTimeout(() => res(null), 4000); }),
    ]);
    if (!win) {
      void req.then((w) => { if (pipWin !== w) { try { w.close(); } catch { /* ignore */ } } }).catch(() => { /* ignore */ });
      if (!pipNoticeShown) { pipNoticeShown = true; toast(FLOAT_PIP_TIPS.timeout, 'warn', 9000); }
      emit('close');
      return;
    }
    pipWin = win;
    pipNoticeShown = false;
    bindPipLifecycle(win);
    pipBuild(win, restoreRatio);
  } catch (e) {
    const err = e as Error;
    const tip = err?.name === 'NotAllowedError' ? FLOAT_PIP_TIPS.blocked : FLOAT_PIP_TIPS.missing;
    if (!pipNoticeShown) { pipNoticeShown = true; toast(tip, 'warn', 9000); }
    emit('close');
  } finally {
    pipPending = false;
  }
}

function bindPipLifecycle(win: Window): void {
  win.addEventListener('pagehide', () => {
    if (pipWin !== win) return;
    pipWin = null;
    shell = null;
    clearTimer();
    emit('close');
  });
}

function closePip(): void {
  const w = pipWin;
  pipWin = null;
  shell = null;
  clearTimer();
  clearAnim();
  stopProgress();
  try { w?.close(); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * 外观 / 工具条
 * ------------------------------------------------------------------ */
function setDock(on: boolean): void {
  if (dockOn === on) return;
  dockOn = on;
  shell?.wrap.classList.toggle('yf-dock-on', on);
}

function applyView(): void {
  const s = shell;
  if (!s) return;
  const m = mode.value;
  s.wrap.className = `yf-wrap yf-${m}${dockOn ? ' yf-dock-on' : ''}${panelOn ? ' yf-panel-on' : ''}`;
  // 字号/行高一律落整数像素：小数行高会让 Chromium 走次像素排版 ⇒ 部分档位发虚
  const adj = fontPx.value - 2;
  const cur = fontPx.value + 7;
  const css = s.wrap.style;
  css.setProperty('--yf-fs', `${fontPx.value}px`);
  css.setProperty('--yf-fs-adj', `${adj}px`);
  css.setProperty('--yf-fs-cur', `${cur}px`);
  css.setProperty('--yf-lh-read', `${Math.round(fontPx.value * 1.9)}px`);
  css.setProperty('--yf-lh-adj', `${Math.round(adj * 1.5)}px`);
  css.setProperty('--yf-lh-cur', `${Math.round(cur * 1.5)}px`);
  if (fontColor.value) css.setProperty('--yf-fg', fontColor.value);
  else css.removeProperty('--yf-fg');
  if (bgColor.value) css.setProperty('--yf-bg', bgColor.value);
  else css.removeProperty('--yf-bg');
  // PiP 表面不透明，底色要同时铺到 body 上（wrap 之外那圈）
  s.wrap.ownerDocument.body.style.background = bgColor.value || 'var(--bg-1, #16161a)';
  const st: FloatToolState = { mode: m, tier: tier.value, playing: al.isPlaying, neighbors: neighbors.value };
  for (const { id, el: btn } of s.tools) {
    const def = FLOAT_TOOLS.find((t) => t.id === id)!;
    btn.hidden = !def.modes.includes(m);
    const p = presentTool(def, st);
    // 图标表里既有文字（‹‹ / A+ / ☰）也有内联 SVG（歌词三键与 PC 同一组 path）⇒ 统一走 innerHTML
    btn.innerHTML = p.icon;
    btn.title = p.title;
  }
  s.speedLabel.textContent = `速度 ${SPEED_LABEL[speed.value] ?? SPEED_LABEL[2]}`;
}

/** 开关颜色浮层：打开时保持工具条可见（浮层在 48px 带外仍可操作） */
function setPanel(on: boolean): void {
  const s = shell;
  if (!s || panelOn === on) return;
  panelOn = on;
  s.wrap.classList.toggle('yf-panel-on', on);
  s.tools.find((t) => t.id === 'color')?.el.classList.toggle('yf-tool-on', on);
  s.syncPanel();
  if (on) {
    setDock(true);
    s.wrap.style.setProperty('--yf-panelh', `${s.panel.offsetHeight || 44}px`);
  } else {
    s.wrap.style.removeProperty('--yf-panelh');
  }
  // 视口让位/复位后按原位置重排（正文按滚动比例，三行按当前行居中）
  if (mode.value === 'read') applyRead(readRatio);
  else if (lineState.cur) paint3(lineState);
}

function toolAction(id: FloatToolId): void {
  switch (id) {
    case 'toc': toggleToc(); break;
    case 'chapterPrev': void r.chOffset(-1); break;
    case 'chapterNext': void r.chOffset(1); break;
    case 'fontDown': cycleFont(-1); break;
    case 'fontUp': cycleFont(1); break;
    case 'color': setPanel(!panelOn); break;
    case 'tier': emit('tier', tier.value === 'bar' ? 'regular' : 'bar'); break;
    case 'speed': cycleSpeed(); break;
    case 'neighbors': toggleNeighbors(); break;
    case 'playPause':
      if (al.isPlaying) al.pause();
      else if (al.isPaused) al.resume();
      else al.play();
      break;
    case 'sentencePrev': al.prevParagraph(); break;
    case 'sentenceNext': al.nextParagraph(); break;
    default: break;
  }
}

function cycleFont(delta: number): void {
  const i = FONT_SIZES.indexOf(fontPx.value as 13);
  const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, (i < 0 ? 1 : i) + delta))] ?? DEFAULT_FONT_PX;
  const ratio = currentRatio();
  fontPx.value = next;
  saveFontPx(next);
  applyView();
  if (mode.value === 'read') applyRead(ratio);
  else if (mode.value === 'bar') rebuildBar();
  else applyLyrics(false);
}

function cycleSpeed(): void {
  speed.value = speed.value >= 3 ? 1 : speed.value + 1;
  saveSpeed(speed.value);
  applyView();
  schedule();
}

function toggleNeighbors(): void {
  neighbors.value = !neighbors.value;
  saveLyricsNeighbors(neighbors.value);
  applyView();
  applyLyrics(false);
}

/* ------------------------------------------------------------------ *
 * 内容
 * ------------------------------------------------------------------ */
function applyContent(restoreRatio?: number): void {
  if (mode.value === 'read') applyRead(restoreRatio);
  else if (mode.value === 'bar') rebuildBar(restoreRatio);
  else applyLyrics(false);
}

function applyRead(ratio?: number): void {
  const s = shell;
  if (!s) return;
  s.chap.textContent = chapterLabel.value;
  s.text.textContent = '';
  const ps = paragraphs.value;
  if (!ps.length) {
    const p = el(s.text.ownerDocument, 'p', 'yf-empty');
    p.textContent = FLOAT_EMPTY.read;
    s.text.appendChild(p);
  } else {
    for (const t of ps) {
      const p = el(s.text.ownerDocument, 'p');
      p.textContent = t;
      s.text.appendChild(p);
    }
  }
  if (ratio !== undefined) {
    requestAnimationFrame(() => {
      const v = s.readview;
      const max = v.scrollHeight - v.clientHeight;
      v.scrollTop = max > 0 ? Math.round(ratio * max) : 0;
      readRatio = ratio;
    });
  }
}

function locateByAnchor(): void {
  if (!barLines.length) { barIndex = 0; return; }
  let i = 0;
  for (let k = 0; k < barLines.length; k += 1) {
    if (barLines[k]!.start <= barAnchor) i = k;
    else break;
  }
  barIndex = Math.min(Math.max(0, i), barLines.length - 1);
  barAnchor = barLines[barIndex]!.start;
}

function rebuildBar(restoreRatio?: number): void {
  /**
   * 章节标题 = 条形的**第一行**（用户 2026-11-10：条形态只加载正文、没有标题）。
   * 标题行 `start = -1`：不参与正文锚点；与正文行一起走同一套三行轨道 / 按宽折行 / 4 行动画。
   */
  const body = splitParagraphs(paragraphs.value, barWidth, fontPx.value + 7);
  const title = chapterTitle.value;
  barLines = title ? [{ text: title, start: -1, title: true }, ...body] : body;
  if (restoreRatio !== undefined) {
    barIndex = currentBarIndex(barLines.length, restoreRatio);
    if (barLines.length) barAnchor = barLines[barIndex]!.start;
  } else {
    locateByAnchor();
  }
  paintBar();
  schedule();
}

function barState(): LineState {
  const prev = barLines[barIndex - 1];
  const cur = barLines[barIndex];
  const next = barLines[barIndex + 1];
  return {
    prev: prev?.text ?? '',
    cur: cur?.text ?? FLOAT_EMPTY.bar,
    next: next?.text ?? '',
    readChars: 0,
    showNeighbors: true,
    prevTitle: !!prev?.title,
    curTitle: !!cur?.title,
    nextTitle: !!next?.title,
  };
}

function paintBar(): void {
  setLines(barState(), false);
}

function schedule(): void {
  clearTimer();
  // 末行也要排一次：停满一个档位后由 tick 触发自动续章（与朗读 / 歌词的自动下一章同语义）
  if (!pipWin || mode.value !== 'bar' || !barLines.length) return;
  timer = setTimeout(tick, SPEED_MS[speed.value] || SPEED_MS[2]);
}
function clearTimer(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
function tick(): void {
  timer = null;
  if (!pipWin || mode.value !== 'bar' || !barLines.length) return;
  if (barIndex >= barLines.length - 1) {
    // 下一章正文还没到位（只剩标题行）：先等一档，别把「空章」当读完 ⇒ 否则会连跳几章
    if (!paragraphs.value.length) { schedule(); return; }
    // 触发点：末行已经完整停满一个 SPEED_MS（所以它不会被「跳过」，也不会卡死在末行）
    void advanceBarChapter();
    return;
  }
  barIndex += 1;
  barAnchor = barLines[barIndex]!.start;
  setLines(barState(), true);
  schedule();
}

/** 自动续章防重入：一次只发一个切章请求（切章成功后由 chapterIdx watcher 重排到首行） */
let barAdvancing = false;
/** 条形末行 → 下一章：走与工具条「下一章」同一个入口（跳过卷标题行、最后一章返回 undefined） */
async function advanceBarChapter(): Promise<void> {
  if (barAdvancing) return;
  if (!pipWin || mode.value !== 'bar') return;
  const from = r.chapterIdx;
  // 已是最后一章（`chOffset` 越界返回 undefined）：停在末行，不再排定时器
  const req = r.chOffset(1);
  if (!req) return;
  barAdvancing = true;
  try {
    await req;
  } finally {
    barAdvancing = false;
  }
  // 开章失败（网络 / 源报错）时 chapterIdx 不变 ⇒ 隔一档重试，别让条形死在末行
  if (pipWin && mode.value === 'bar' && r.chapterIdx === from) schedule();
}

function lyricsState(): LineState {
  const i = al.index;
  const showN = neighbors.value;
  const cur = al.currentText;
  const title = al.chapterTitle;
  const inTitle = al.speakingTitle;
  /**
   * 章节标题也进**同一条三行轨道**（用户 2026-11-10：歌词窗没有标题）：
   * · 正在念标题 ⇒ 标题就是当前行，下一行是正文第一句（不是第二句）；
   * · 标题念完、正文第一句 ⇒ 标题落到上一行（小号/半透明，带标题字色）；
   * · 之后随朗读推进自然滚出，不额外占行、不破坏 4 行动画。
   */
  const prev = !showN ? ''
    : inTitle ? ''
      : i === 0 && title ? title
        : (al.sentences[i - 1]?.text ?? '');
  const next = !showN ? ''
    : inTitle ? (al.sentences[0]?.text ?? '')
      : (al.sentences[i + 1]?.text ?? '');
  return {
    prev,
    cur: cur || FLOAT_EMPTY.lyrics,
    next,
    // 空态占位（「等待朗读…」）不是朗读文本 ⇒ 不切已读段，否则占位文案会被画成半透明；
    // 标题行也不切（标题是整行，不做「已读半透明」）
    readChars: cur && !inTitle ? al.innerPos : 0,
    showNeighbors: showN,
    prevTitle: showN && !inTitle && i === 0 && !!title,
    curTitle: inTitle && !!title,
    nextTitle: false,
  };
}

function applyLyrics(animate: boolean): void {
  setLines(lyricsState(), animate);
}

/* ------------------------------------------------------------------ *
 * 三行视口：4 行轨道推进（新行从下方推入，旧行向上移出；动画后 DOM 只留三行）
 * ------------------------------------------------------------------ */
function setCur(elCur: HTMLElement, text: string, readChars: number): void {
  elCur.textContent = '';
  if (!text) return;
  if (readChars > 0 && readChars < text.length) {
    const doc = elCur.ownerDocument;
    const a = el(doc, 'span', 'yf-read');
    a.textContent = text.slice(0, readChars);
    const b = el(doc, 'span');
    b.textContent = text.slice(readChars);
    elCur.append(a, b);
  } else {
    elCur.textContent = text;
  }
}

/** 以轨道里第 `rowIdx` 行为中心，算出 translateY（含「不裁字」钳制） */
function centerTarget(rowIdx: number): number {
  const s = shell;
  if (!s) return 0;
  const row = s.track.children[rowIdx] as HTMLElement | undefined;
  if (!row) return 0;
  const viewH = s.linesView.clientHeight;
  const trackH = s.track.offsetHeight;
  const off = row.offsetTop;
  const h = row.offsetHeight;
  let t = viewH / 2 - (off + h / 2);
  const lo = Math.min(0, viewH - trackH);
  const hi = Math.max(0, viewH - trackH);
  return Math.round(Math.min(hi, Math.max(lo, t)));
}

function trimTrack(): void {
  const s = shell;
  if (!s) return;
  while (s.track.children.length > 3) s.track.removeChild(s.track.lastElementChild!);
}

/** 标题行只多一个字色/字重类；字号/行高仍由 prev/cur/next 决定（不破坏轨道几何） */
function lineClass(base: string, isTitle?: boolean): string {
  return isTitle ? `${base} yf-line-title` : base;
}

function paint3(st: LineState): void {
  const s = shell;
  if (!s) return;
  trimTrack();
  const [r0, r1, r2] = s.rows as [HTMLElement, HTMLElement, HTMLElement];
  r0.textContent = st.prev;
  r0.className = lineClass('yf-line-prev', st.prevTitle);
  r0.style.display = st.showNeighbors ? '' : 'none';
  setCur(r1, st.cur, st.readChars);
  r1.className = lineClass('yf-line-cur', st.curTitle);
  r2.textContent = st.next;
  r2.className = lineClass('yf-line-next', st.nextTitle);
  r2.style.display = st.showNeighbors ? '' : 'none';
  s.track.classList.remove('yf-line-anim');
  s.track.style.transform = `translateY(${centerTarget(1)}px)`;
}

function clearAnim(): void {
  animToken += 1;
  if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  animBusy = false;
}

/** 推进动画时长：位移与字号/行高共用这一条时间轴（同一条 cubic-bezier） */
const ANIM_MS = 280;

/**
 * 推进：轨道临时 4 行，**位移与字号变化在同一帧开始、同一条 280ms 时间轴结束**：
 *   1) 旧 cur 缩小成 prev、新 cur 放大（CSS font-size/line-height 过渡）；
 *   2) 轨道 translateY 从「旧 cur 居中」过渡到「新 cur 居中」（CSS transform 过渡）。
 * 两者用同一 cubic-bezier ⇒ 滚动与放大同步，不再有「先滚上去、再变大」的停顿。
 * 结束后立刻压回 3 行（不累积 DOM；删掉顶行同时把 transform 加回同量，视觉不跳）。
 */
function setLines(next: LineState, animate: boolean): void {
  const s = shell;
  if (!s) return;
  if (!animate || !lineState.cur || !next.cur || !next.showNeighbors) {
    clearAnim();
    paint3(next);
    lineState = next;
    return;
  }
  clearAnim();
  const token = animToken;
  const doc = s.track.ownerDocument;
  // 起始态：DOM 仍是旧三行；临时补第 4 行（新 next）在下方，动画结束就删掉
  const ghost = el(doc, 'p', lineClass('yf-line-next', next.nextTitle));
  ghost.textContent = next.next;
  s.track.appendChild(ghost);
  // 起始位置（旧 cur 居中）已由上一次 paint3 设好；先把这一帧落定
  void s.track.offsetHeight;
  // 旧 prev / 新 next 可能是空行（高度 0，不受行高影响），先按真实高度量下来，
  // 否则「两行 prev」的假设会让首行/末行差一整行，动画结束跳一下。
  const h0 = s.rows[0]!.offsetHeight;
  const h3 = ghost.offsetHeight;
  s.track.classList.add('yf-line-anim');
  // 三行此刻装的仍是**旧内容** ⇒ 标题类按旧 `lineState` 取，不能按新状态取
  s.rows[0]!.className = lineClass('yf-line-prev', lineState.prevTitle);
  s.rows[1]!.className = lineClass('yf-line-prev', lineState.curTitle); // 旧 cur 缩小
  s.rows[2]!.className = lineClass('yf-line-cur', lineState.nextTitle); // 新 cur 放大（内容此刻才进中间位）
  animBusy = true;

  // 目标 = 动画最后一帧（4 行、字号已到终值）把新 cur 顶到视口中心所需的 translateY
  const adjH = Math.round((fontPx.value - 2) * 1.5);
  const curH = Math.round((fontPx.value + 7) * 1.5);
  const GAP = 2;
  const viewH = s.linesView.clientHeight;
  // 这里**不做边界夹紧**：动画期是 4 行轨道，比最终三行多一行，
  // 夹紧会把「新 cur 居中」的目标提前截断（歌词最大字号时会差 15px，收尾一跳）。
  const to = Math.round(viewH / 2 - (h0 + GAP + adjH + GAP + curH / 2));
  s.track.style.transform = `translateY(${to}px)`;

  const finish = (): void => {
    if (token !== animToken) return;
    animToken += 1;
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    s.track.removeEventListener('transitionend', onEnd);
    animBusy = false;
    paint3(next);
    lineState = next;
  };
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === s.track && e.propertyName === 'transform') finish();
  };
  s.track.addEventListener('transitionend', onEnd);
  animTimer = setTimeout(finish, ANIM_MS + 120);
}

/** 只更新当前句的已读分段（不动位置）；`chars` 由时间插值给出 */
function updateCurRead(chars: number = al.innerPos): void {
  const s = shell;
  if (!s || mode.value !== 'lyrics' || animBusy) return;
  if (!lineState.cur) return;
  setCur(s.rows[1]!, lineState.cur, chars);
}

/* ------------------------------------------------------------------ *
 * 已读色进度（问题：`innerPos` 只在 utterance 的**词边界事件**跳一次，
 * 而且边界报的是「正在说的这个词的起始位置」⇒ 直接拿它上色必然落后一个词）。
 * 做法：把边界当作锚点，按实测语速在两次边界之间按时间外推；
 * 边界到来时再校准，词内平滑推进，读完即变色。
 * ------------------------------------------------------------------ */
let progChars = 0;
let progPos = 0;
/** 最近一次边界的时间戳 */
let progAt = 0;
/** 字符/毫秒（由相邻边界自适应；默认约 5 字/秒） */
let progRate = 0.005;
let progTimer: ReturnType<typeof setInterval> | null = null;

function resetProgress(): void {
  progPos = al.innerPos;
  progAt = performance.now();
  progChars = al.innerPos;
  updateCurRead(progChars);
}

function startProgress(): void {
  if (progTimer) return;
  progTimer = setInterval(() => {
    if (!shell || mode.value !== 'lyrics' || !al.isPlaying) return;
    const len = al.currentText.length;
    if (!len) return;
    const est = progPos + (performance.now() - progAt) * progRate;
    const next = Math.min(len, Math.max(al.innerPos, est));
    if (next - progChars < 1) return;
    progChars = next;
    updateCurRead(progChars);
  }, 60);
}
function stopProgress(): void {
  if (progTimer) { clearInterval(progTimer); progTimer = null; }
}

/** 词边界事件（`al.innerPos` 变化）：校准语速并同步进度 */
function onBoundary(): void {
  const pos = al.innerPos;
  const now = performance.now();
  const dt = now - progAt;
  if (pos > progPos && dt > 40) {
    const r2 = (pos - progPos) / dt;
    if (r2 > 0.0002 && r2 < 0.05) progRate = progRate * 0.6 + r2 * 0.4;
  }
  // 边界通常晚于实际发音：若它落在我们已推进的位置之后，就把它当新锚点校准；
  // 若仍落后于估计，**不要**回拨锚点（否则进度会卡住等它追上来）。
  if (pos >= progChars) {
    progPos = pos;
    progAt = now;
    progChars = pos;
  }
  updateCurRead(progChars);
}

/* ------------------------------------------------------------------ *
 * 目录
 * ------------------------------------------------------------------ */
function fillToc(): void {
  const s = shell;
  if (!s) return;
  s.toc.textContent = '';
  const chapters = (r.detail?.chapters ?? []) as Array<{ title?: string; payload?: unknown }>;
  if (!chapters.length) {
    const p = el(s.toc.ownerDocument, 'p', 'yf-empty');
    p.textContent = FLOAT_EMPTY.toc;
    s.toc.appendChild(p);
    return;
  }
  chapters.forEach((ch, i) => {
    const p = el(s.toc.ownerDocument, 'p');
    p.textContent = r.tocTitleAt(i) || ch.title || `第 ${i + 1} 章`;
    if (i === r.chapterIdx) p.classList.add('cur');
    p.addEventListener('click', () => {
      tocOn = false;
      s.toc.classList.remove('on');
      setDock(false);
      if (i !== r.chapterIdx) void r.openChapter({ title: ch.title ?? '', payload: ch.payload });
    });
    s.toc.appendChild(p);
  });
}
function toggleToc(): void {
  const s = shell;
  if (!s) return;
  tocOn = !tocOn;
  s.toc.classList.toggle('on', tocOn);
  if (tocOn) { fillToc(); setDock(false); }
}

/* ------------------------------------------------------------------ *
 * 生命周期 / 联动
 * ------------------------------------------------------------------ */
onMounted(() => { void openPip(readingStartRatio()); });
onBeforeUnmount(() => { closePip(); });

// 两态切换：同一扇 PiP 重新请求尺寸（UA 原子替换），位置按比例保留
watch(() => props.tier, (_nv, ov) => {
  const wasBar = ov === 'bar';
  const ratio = wasBar ? (barLines.length ? barIndex / (barLines.length - 1) : 0) : readRatio;
  if (!pipWin) return;
  void openPip(ratio);
});

watch(() => r.chapterIdx, () => {
  barAnchor = 0;
  barIndex = 0;
  readRatio = 0;
  if (pipWin) applyContent(0);
});

watch(paragraphs, () => { if (pipWin) applyContent(mode.value === 'read' ? readRatio : undefined); });

watch(speed, () => { schedule(); });

watch(() => [al.index, al.currentText, al.speakingTitle] as const, () => {
  if (mode.value !== 'lyrics' || !shell) return;
  resetProgress();
  if (lyricsState().cur === lineState.cur) return;
  applyLyrics(true);
});

watch(() => al.innerPos, () => { onBoundary(); });

watch(() => [al.isPlaying, al.isPaused] as const, (v) => {
  if (!shell) return;
  applyView();
  if (mode.value !== 'lyrics') return;
  if (v[0]) { progAt = performance.now(); startProgress(); } else stopProgress();
});
</script>

<!-- 本组件的 UI 全部画在 Document PiP 窗口里（命令式 DOM），页面侧不留任何东西；
     这个空模板只是让 SFC 有一个合法的渲染入口。 -->
<template>
  <span style="display: none" aria-hidden="true" />
</template>

