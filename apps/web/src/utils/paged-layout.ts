/**
 * `#825` **分页几何**：按测量切页，不用 CSS 多列。
 *
 * ## 为什么不再用 `column`
 * `#811` 之前的分页是「整章塞进一个 CSS 多列容器 + 改 `scrollLeft`」。这条路在桌面端不稳：
 * 任何高度扰动（字体晚到、页眉展开/收起、窗口 resize、图片加载完）都会让浏览器**整章重排**，
 * 列宽/位移随之失效 —— 用户实测「翻一两页就失灵」。而且滚动回调里为了拿到列数必须重量，
 * 重量又写 inline 列宽 ⇒ 自触发重排 ⇒ 主线程打满。
 *
 * 现在改成 Legado 那套：**把正文按字符区间切成「页」，渲染层只画当前页（及前后各一页）**。
 * 翻页只改页码 + 换渲染切片，**零测量、零重排**。
 *
 * ## 测量怎么做（一次批量布局 + 按页二分）
 * ① 把整章段落（含标题）一次性塞进**离屏测量盒**（宽 = 页宽、高不限），读一次 `getBoundingClientRect`
 *    ⇒ 每个块的 `top/bottom` 都拿到了（块高 = bottom − top，块间距 = 下一块 top − 上一块 bottom）。
 *    这一步只有**一次**整章布局。
 * ② 之后按「页」贪心装箱：放得下就整块放；放不下才在段内二分切点（每次二分只测**一个段落**，
 *    成本与章长无关）。切点做标点回溯（行首禁则 / 行尾禁则）。
 * ③ 段中续片（`cont`）渲染时不缩进（`text-indent: 0`），测量时也用同一口径 —— 两边的换行才一致。
 *
 * ## 边界
 * · 图文混排：图片段落按原高度算（图片没加载完时高度不确定，见 `measureChapterPages` 的说明）；
 * · 长英文单词 / 中文标点：交给浏览器断行（测量与渲染同一个宽度），我们只纠正「行首标点」；
 * · 章末行为不变：到最后一页由调用方接下一章（本模块不跨章）。
 */

/** 一页里的一个渲染切片 */
export interface PageChunk {
  /** 段下标；`-1` = 章标题块 */
  para: number;
  /** 段内起始字符（含） */
  start: number;
  /** 段内结束字符（不含） */
  end: number;
  /** 段中续片（不缩进） */
  cont: boolean;
}

/** 章标题块（会算进第 1 页） */
export interface TitleBlock {
  text: string;
  /** 额外 class（高亮规则的标题样式） */
  className?: string;
  /** 额外 inline style（`readerTitleVars` + 高亮样式变量） */
  style?: Record<string, string>;
}

export interface MeasureInput {
  /** 章标识（进签名；换章必须重建） */
  chapterKey: string;
  paragraphs: readonly string[];
  title?: TitleBlock | null;
  /** 页 **border-box** 宽（与渲染的 `.rd-content` 一致） */
  width: number;
  /** 页可用 **content-box** 高（= 可视高 − 上下 padding） */
  height: number;
  /** 正文排版变量（`readerStyleVars`）—— 必须与渲染**同一份** */
  styleVars: Record<string, string>;
  /** 正文继承到的字体族（测量盒挂在 body 上，拿不到组件内的继承链 ⇒ 显式传） */
  fontFamily?: string;
  /** 中断令牌：取消后立刻返回 `null`，**不会**把半成品交给调用方 */
  signal?: AbortSignal;
  /** 每切若干页让出一帧（默认 6） */
  yieldEvery?: number;
}

export interface PagedLayout {
  pages: PageChunk[][];
  /** 版式签名（宽高 + 排版量 + 章 id + 文本指纹）；调用方用它跳过重复重建 */
  signature: string;
  /** 实测耗时（ms） */
  ms: number;
}

const EPS = 0.5;
/** 行首禁则：这些字符**不能**出现在一页的第一位（切点要往前退） */
const NO_LINE_START = new Set('，。！？；：、）】》」』’”·…—～%,.!?;:)]}');
/** 行尾禁则：这些字符**不能**留在一页的最后一位（切点要把它们挪到下一页） */
const NO_LINE_END = new Set('（【《「『‘“([{');

const MEASURE_ATTR = 'data-paged-measure';

/** 让出一帧（后台标签页 rAF 会被节流 ⇒ 兜底 50ms，避免重建永远卡住） */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = (): void => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 50);
  });
}

function px(v: string | undefined, dflt: number): number {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 正文字符指纹（FNV-1a）。
 *
 * ⚠️ 只记「段数 + 总字数」不够：**替换规则 / 简繁转换可能等长替换**（把「他」换成「她」），
 * 长度完全一样，签名就会误判「没变」而沿用旧切点。
 */
function textHash(paragraphs: readonly string[], title: string): number {
  let h = 0x811c9dc5;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
  };
  for (const p of paragraphs) feed(p);
  feed(title);
  return h >>> 0;
}

/** 版式签名：只收**影响排版**的量（配色变了不该重建） */
export function pagedSignature(input: MeasureInput): string {
  const keys = [
    '--rd-fs', '--rd-lh', '--rd-ls', '--rd-ps', '--rd-indent', '--rd-fw', '--rd-font',
    '--rd-pt', '--rd-pr', '--rd-pb', '--rd-pl',
    '--rd-title-fs', '--rd-title-font', '--rd-title-mt', '--rd-title-mb', '--rd-title-lh', '--rd-title-display',
  ];
  const vars = keys.map((k) => `${k}=${input.styleVars[k] ?? ''}`).join(';');
  let chars = 0;
  for (const p of input.paragraphs) chars += p.length;
  return [
    input.chapterKey,
    Math.round(input.width * 100) / 100,
    Math.round(input.height * 100) / 100,
    input.paragraphs.length,
    chars,
    textHash(input.paragraphs, input.title?.text ?? ''),
    (input.title?.text ?? '').length,
    input.fontFamily ?? '',
    vars,
  ].join('|');
}

/** 建离屏测量盒。**不复用 `.se-body` / `.rd-content` 的 class**（scoped 属性拿不到，见头注释） */
function createMeasureBox(input: MeasureInput): HTMLElement {
  const box = document.createElement('div');
  box.setAttribute(MEASURE_ATTR, '1');
  box.setAttribute('aria-hidden', 'true');
  const s = box.style;
  s.position = 'fixed';
  s.left = '-10000px';
  s.top = '0';
  s.width = `${Math.max(1, Math.round(input.width))}px`;
  s.boxSizing = 'border-box';
  s.height = 'auto';
  s.maxWidth = 'none';
  s.margin = '0';
  s.padding = '0';
  s.visibility = 'hidden';
  s.pointerEvents = 'none';
  s.contain = 'layout style';
  s.zIndex = '0';
  // 排版量：与组件里 `.rd-content` 的 CSS **同一组变量**（值都在 styleVars 里）
  s.fontSize = 'var(--rd-fs, 20px)';
  s.lineHeight = 'var(--rd-lh, calc(1em + 12px))';
  s.letterSpacing = 'var(--rd-ls, 0.1em)';
  s.fontWeight = 'var(--rd-fw, 400)';
  // 与 `.rd-content` 的 `font-family: var(--rd-font, inherit)` **同一口径**：
  // 传进来的 `fontFamily` 只是「没配 `--rd-font` 时的继承值」，不能直接盖掉 `--rd-font`。
  if (input.fontFamily) {
    s.fontFamily = `var(--rd-font, ${input.fontFamily})`;
  } else {
    s.fontFamily = 'var(--rd-font, inherit)';
  }
  // 正文左右边距要算进来（宽 = border-box，内容盒宽由它决定）
  s.paddingLeft = 'var(--rd-pl, 16px)';
  s.paddingRight = 'var(--rd-pr, 16px)';
  for (const [k, v] of Object.entries(input.styleVars)) box.style.setProperty(k, v);
  document.body.appendChild(box);
  return box;
}

function makePara(text: string, cont: boolean): HTMLElement {
  const p = document.createElement('p');
  p.textContent = text;
  p.style.margin = '0 0 var(--rd-ps, 2px)';
  p.style.textIndent = cont ? '0' : 'var(--rd-indent, 2em)';
  p.style.textDecoration = 'var(--rd-ul-body, none)';
  p.style.textUnderlineOffset = 'var(--rd-ul-body-offset, 0px)';
  return p;
}

function makeTitle(t: TitleBlock): HTMLElement {
  const h = document.createElement('h3');
  h.textContent = t.text;
  if (t.className) h.className = t.className;
  for (const [k, v] of Object.entries(t.style ?? {})) h.style.setProperty(k, v);
  const s = h.style;
  // 与 `.rd-chapter` / `.rd-book-title` 的实际计算值保持一致：
  //   · 字号 / 字体族都走 `--rd-title-*`（`titleSize = 0` 时是 `inherit` ⇒ 跟随正文，
  //     测量盒的父级字号/字体就是正文那一组，所以 `inherit` 在这里等价于 `.rd-content` 内的继承）；
  //   · 其余量逐条照抄 `.rd-book-title` 的 `var(--rd-title-*, 默认)`。
  s.fontSize = 'var(--rd-title-fs, inherit)';
  s.fontFamily = 'var(--rd-title-font, inherit)';
  s.color = 'var(--rd-title-color, inherit)';
  s.display = 'var(--rd-title-display, block)';
  s.textAlign = 'var(--rd-title-align, left)';
  s.marginTop = 'var(--rd-title-mt, 0px)';
  s.marginBottom = 'var(--rd-title-mb, 0px)';
  s.lineHeight = 'var(--rd-title-lh, inherit)';
  s.textDecoration = 'var(--rd-ul-title, none)';
  s.textUnderlineOffset = 'var(--rd-ul-title-offset, 0px)';
  return h;
}

/** 把一个段落切片量一次（测量盒只放这一段 —— 一次小布局，代价与章长无关） */
function sliceHeight(box: HTMLElement, text: string, cont: boolean): number {
  const p = makePara(text, cont);
  box.replaceChildren(p);
  const r = p.getBoundingClientRect();
  return Math.max(0, r.height);
}

/**
 * 在 `[s, len)` 里二分出「能塞进 `avail` 高的最长前缀」。
 *
 * 高度对字符数单调不减 ⇒ 可以二分。返回 `s` 表示一个字都放不下。
 */
function findSplit(
  box: HTMLElement,
  text: string,
  s: number,
  avail: number,
  cont: boolean,
): number {
  if (avail <= 0) return s;
  let lo = s;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sliceHeight(box, text.slice(s, mid), cont) <= avail + EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 切点微调：行首禁则 / 行尾禁则 / 代理对不能劈开 */
function fixSplit(text: string, s: number, c: number): number {
  if (c <= s) return c;
  let t = Math.min(c, text.length);
  if (t >= text.length) return text.length;
  // 代理对（emoji / 生僻字）：切在低位代理前一位
  const code = text.charCodeAt(t);
  if (code >= 0xdc00 && code <= 0xdfff) t -= 1;
  // 行首禁则：下一页第一个字符不能是收尾标点 ⇒ 把切点往前退
  for (let k = 0; k < 4 && t > s + 1 && NO_LINE_START.has(text[t] ?? ''); k += 1) t -= 1;
  // 行尾禁则：本页最后一个字符不能是开引号/开括号 ⇒ 把它推到下一页
  for (let k = 0; k < 3 && t > s + 1 && NO_LINE_END.has(text[t - 1] ?? ''); k += 1) t -= 1;
  return t > s ? t : Math.min(c, text.length);
}

/**
 * 测量整章 → 页切片。
 *
 * @returns 取消（`signal` 触发）或尺寸非法时返回 `null`；调用方**不得**用半成品。
 */
export async function measureChapterPages(input: MeasureInput): Promise<PagedLayout | null> {
  const t0 = performance.now();
  const { width, height, paragraphs } = input;
  if (!(width > 1) || !(height > 1)) return null;

  const box = createMeasureBox(input);
  try {
    /* ---------- ① 一次批量布局：标题 + 整章段落 ---------- */
    const blocks: HTMLElement[] = [];
    /** 与 `blocks` 平行：段下标（`-1` = 标题块） */
    const blockPara: number[] = [];
    const frag = document.createDocumentFragment();
    if (input.title) {
      const h = makeTitle(input.title);
      blocks.push(h);
      blockPara.push(-1);
      frag.appendChild(h);
    }
    for (let k = 0; k < paragraphs.length; k += 1) {
      const p = makePara(paragraphs[k]!, false);
      blocks.push(p);
      blockPara.push(k);
      frag.appendChild(p);
    }
    box.appendChild(frag);
    if (input.signal?.aborted) return null;

    // 唯一一次整章布局：先读盒子的 rect（把布局冲出来），再逐块读（只读不写，不会反复重排）
    const boxRect = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const padT = px(cs.paddingTop, 0);
    const contentTop = boxRect.top + padT;

    const fullH: number[] = new Array(blocks.length);
    const gaps: number[] = new Array(blocks.length); // gaps[k] = 第 k 块与第 k−1 块之间的间距
    let prevBottom = 0;
    for (let k = 0; k < blocks.length; k += 1) {
      const r = blocks[k]!.getBoundingClientRect();
      const top = r.top - contentTop;
      const bottom = r.bottom - contentTop;
      fullH[k] = Math.max(0, bottom - top);
      gaps[k] = k === 0 ? Math.max(0, top) : Math.max(0, top - prevBottom);
      prevBottom = bottom;
    }
    // 标题被设置隐藏（`titleMode=2` ⇒ `display:none`）时 rect 全 0 ⇒ 整块剔除，别占一个空页
    const hiddenTitle = !!input.title && box.firstElementChild !== null
      && blocks[0]!.getBoundingClientRect().width === 0 && blocks[0]!.getBoundingClientRect().height === 0;
    const firstBlock = hiddenTitle ? 1 : 0;

    /* ---------- ② 贪心装箱 ---------- */
    const pages: PageChunk[][] = [];
    let page: PageChunk[] = [];
    let used = 0;
    let i = firstBlock;
    let s = 0;
    const remainH = new Map<number, number>();
    // 每装箱 N 页让出一帧（默认 6 ≈ 一次 30~60ms 的切片 + 一次 rAF，翻页前不会卡住输入）
    const yieldEvery = Math.max(1, input.yieldEvery ?? 6);
    let sinceYield = 0;
    let guard = 0;

    const flush = (): void => { pages.push(page); page = []; used = 0; };

    while (i < blocks.length) {
      if (input.signal?.aborted) return null;
      if (++guard > 500_000) break; // 防御：任何意外都不许死循环
      const paraId = blockPara[i]!;
      const paraText = paraId < 0 ? (input.title?.text ?? '') : (paragraphs[paraId] ?? '');
      const len = paraText.length;
      const cont = s > 0;
      let h = cont ? remainH.get(i) : fullH[i]!;
      if (h === undefined) {
        h = sliceHeight(box, paraText.slice(s), true);
        remainH.set(i, h);
      }
      const gap = page.length > 0 && !cont ? gaps[i] ?? 0 : 0;
      const avail = height - used - gap;

      // 整块（或整段剩余）能放下
      if (h <= avail + EPS) {
        page.push({ para: paraId, start: s, end: len, cont });
        used += gap + h;
        i += 1;
        s = 0;
        continue;
      }
      // 页里已经没有空间了 ⇒ 换页（空页必须硬塞一块，保证前进）
      if (avail <= 1 && page.length > 0) {
        flush();
        continue;
      }
      // 段内二分切点
      const c = fixSplit(paraText, s, findSplit(box, paraText, s, avail, cont));
      if (c >= len) {
        // 取整误差导致「二分说放不下、实际到段尾」：按整段放
        page.push({ para: paraId, start: s, end: len, cont });
        used += gap + h;
        i += 1;
        s = 0;
        continue;
      }
      if (c <= s) {
        if (page.length === 0) {
          // 极端情况：一页连一行都放不下 ⇒ 至少放一个字，避免死循环
          page.push({ para: paraId, start: s, end: Math.min(len, s + 1), cont });
          flush();
          s += 1;
          continue;
        }
        flush();
        continue;
      }
      page.push({ para: paraId, start: s, end: c, cont });
      flush();
      s = c;
      // 下一段续片的实际高度（换行会变，必须重量）
      remainH.set(i, sliceHeight(box, paraText.slice(s), true));

      sinceYield += 1;
      if (sinceYield >= yieldEvery) {
        sinceYield = 0;
        await nextFrame();
        if (input.signal?.aborted) return null;
      }
    }
    if (page.length > 0) flush();

    return {
      pages: pages.length > 0 ? pages : [[{ para: 0, start: 0, end: 0, cont: false }]],
      signature: pagedSignature(input),
      ms: performance.now() - t0,
    };
  } finally {
    box.remove();
  }
}
