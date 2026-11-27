/**
 * 章节正文的**字符偏移坐标系** —— 高亮、书签、跳转全靠它，只此一份。
 *
 * ## 为什么要专门一个文件
 * 「正文里第 N 个字符」这句话在本仓此前有**三种互不相同的算法**：
 *  ① `scrollToChapterPos()`：`p.textContent.length` **累加**（段落之间不补分隔符）；
 *  ② 选区菜单 `selPos`：`content.textContent.indexOf(选中文字)` —— 而 `content` 是**整块**
 *     `.rd-content`，**含标题**，且 `indexOf` 命中的是**首次出现**的位置；
 *  ③ 高亮（本次）需要「段落可寻址」的偏移。
 * 三者不一致 ⇒ 「高亮在 A 段、书签跳到 B 段」这类问题查起来毫无头绪。本文件统一为：
 *
 * ```
 * text = paragraphs.join(CHAPTER_PARA_SEP)      // 段落之间**有一个分隔符**
 * text 中第 k 个字符的下标 = 本仓的 chapterPos     // 0-based，闭开区间 [start, end)
 * ```
 *
 * ## ★ 不含标题（与 Legado 的换算关系）
 * 上游 `BookHighlight.chapterPos` 是**含标题**的布局偏移，渲染时用
 * `bodyStart() = highlightBodyPos(chapterPos, layoutTitleLength, …)` 换算成**正文**偏移
 * （`BookHighlight.kt:76-79`；`ReadBook.kt:390-391` 就是这么用的）。
 * 我们的 DOM 里标题是**独立元素**（`<h3 class="rd-chapter">`），正文段落里没有它 ⇒
 * **本仓的 `chapterPos` 直接采用「正文偏移」**，落库时写 `layoutTitleLength = 0`
 * （= 「本次布局的正文里含 0 个标题字符」，是**如实**的值，不是占位）。
 * 这样：① 我们的数据自洽（`bodyStart()` 是恒等）；② **导入 Legado 备份时**，
 * 它自己的 `layoutTitleLength` 会被 `highlightBodyPos()` 正确减掉，直接落进我们的坐标系。
 *
 * ## ★ 转换（简繁）与坐标的关系
 * 上游是在 `ContentProcessor` 里**先转换、再排版** ⇒ `chapterPos` 落在**转换后**的文本上。
 * 本仓照同一口径：偏移落在**当前显示的那份文本**上（`displayParagraphs`）。
 * 代价是「切换简繁后老高亮可能位移」—— 上游同样不重映射。
 * 缓解：`reanchor()` 用存下来的 `bookText` 做一次**同段落内**的文本比对纠偏（同步、便宜）。
 */

/** 段落分隔符。**改动它等于改动所有人的 chapterPos**，动之前先想清楚迁移。 */
export const CHAPTER_PARA_SEP = '\n';

export interface ChapterTextLayout {
  /** `paragraphs.join(CHAPTER_PARA_SEP)` */
  text: string;
  /** `starts[i]` = 第 i 段在 `text` 里的起始偏移（长度 = paragraphs.length） */
  starts: number[];
  /** 每段自己的长度（= `paragraphs[i].length`），便于段内校验 */
  lengths: number[];
}

export function buildChapterText(paragraphs: readonly string[]): ChapterTextLayout {
  const starts: number[] = new Array(paragraphs.length);
  const lengths: number[] = new Array(paragraphs.length);
  let acc = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const p = paragraphs[i] ?? '';
    starts[i] = acc;
    lengths[i] = p.length;
    acc += p.length + (i === paragraphs.length - 1 ? 0 : CHAPTER_PARA_SEP.length);
  }
  return { text: paragraphs.join(CHAPTER_PARA_SEP), starts, lengths };
}

/** `(段下标, 段内偏移)` → 正文偏移 */
export function paraPosToBody(starts: readonly number[], para: number, char: number): number {
  const base = starts[para];
  if (base === undefined) return 0;
  return base + Math.max(0, char);
}

/**
 * Legado 高亮坐标（**含标题**的布局偏移）→ 本仓正文偏移。
 *
 * 上游 `BookHighlight.chapterPos/chapterPosEnd` 的坐标系里，章首有一段标题
 * （`layoutTitleLength` 个字符，通常 = 标题长度 + 换行）。本仓正文不含标题，
 * 所以导入 Legado 数据渲染前必须减掉它，否则高亮会整体后移 titleLen 个字符。
 *
 * `layoutTitleLength <= 0`（本仓自己落库的数据）⇒ 恒等，不影响现有行为。
 */
export function highlightBodyPos(
  layoutPos: number,
  layoutTitleLength: number,
  maxLen?: number,
): number {
  const pos = Number.isFinite(layoutPos) ? layoutPos : 0;
  const titleLen = Number.isFinite(layoutTitleLength) ? Math.max(0, layoutTitleLength) : 0;
  const body = Math.max(0, pos - titleLen);
  return maxLen === undefined ? body : Math.min(body, Math.max(0, maxLen));
}

/**
 * 正文偏移 → `(段下标, 段内偏移)`。
 *
 * 分会落在分隔符上（例如偏移正好指向段尾的 `\n`）：此时归到**前一段的末尾**
 * （闭区间语义），让「偏移落在哪一段」永远有答案、且是**离它最近的前一段**。
 */
export function bodyPosToPara(
  layout: ChapterTextLayout,
  offset: number,
): { para: number; char: number } {
  const { starts, lengths } = layout;
  if (starts.length === 0) return { para: 0, char: 0 };
  const pos = Math.max(0, offset);
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] ?? 0) <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const char = Math.min(pos - (starts[found] ?? 0), lengths[found] ?? 0);
  return { para: found, char };
}

export type Range = readonly [number, number];

/**
 * 归一化一组区间：裁剪到 `[0, len]`、丢掉空区间、合并**真重叠**。
 *
 * 为什么必须做：① 两个高亮重叠时若各自渲染，DOM 会嵌套出重复文本（视觉上「字变粗/变重」）；
 * ② 选区端点可能落在段落分隔符上，`start === end` 的区间渲染出来是零宽 `<span>`，
 * 白占 DOM 还会让「点它删除」失效。
 *
 * ★ **相接（`cur.start === last.end`）刻意不合并**：合并了就无法区分「一条长划线」与
 * 「两条紧挨着的划线」，用户点上去也就无法决定该删哪一条。所以判据是严格 `<`。
 * ★ **反选的区间（`start > end`）按交换处理**，不丢弃 —— 丢弃会让「划了但界面上什么都没有」，
 * 交换至少语义正确（`[min, max]`）。
 */
export function normalizeRanges(ranges: readonly Range[], len: number): Array<[number, number]> {
  const list = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(len, Math.max(a, b))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const cur of list) {
    const last = out[out.length - 1];
    if (last && cur[0] < last[1]) {
      if (cur[1] > last[1]) last[1] = cur[1];
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

export interface TextSegment {
  text: string;
  /** true = 这一段要渲染成高亮 */
  hl: boolean;
  /** 该段在入参 `text` 里的起始偏移（渲染 `<span>` 时用来反查是哪个高亮） */
  at: number;
}

/** 把一段文本按（**已归一化**的）区间切成 `普通/高亮` 交替的片段 */
export function segmentText(text: string, ranges: readonly Range[]): TextSegment[] {
  const norm = normalizeRanges(ranges, text.length);
  if (norm.length === 0) {
    return text ? [{ text, hl: false, at: 0 }] : [];
  }
  const out: TextSegment[] = [];
  let cursor = 0;
  for (const [a, b] of norm) {
    if (a > cursor) out.push({ text: text.slice(cursor, a), hl: false, at: cursor });
    out.push({ text: text.slice(a, b), hl: true, at: a });
    cursor = b;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hl: false, at: cursor });
  return out;
}

/**
 * 把区间裁成**不含首尾空白**。
 *
 * ★ 为什么必须有：菜单上显示、以及落库的 `bookText` 是 `selection.toString().trim()` 过的，
 * 而选区端点常常带上换行/空格（拖选很容易多吃一个空格）。两者**不一致**的后果不是「差一点」：
 * `reanchor()` 会判定「这个位置上不是我要的文字」，于是按 `bookText` 去找 —— 重定位到
 * **别处**，划线就画错字了。所以区间与文字必须**同源**：区间先裁，文字再由区间切出来。
 */
export function trimRange(text: string, start: number, end: number): [number, number] {
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  while (s < e && /\s/.test(text[s] ?? '')) s += 1;
  while (e > s && /\s/.test(text[e - 1] ?? '')) e -= 1;
  return [s, e];
}

/**
 * 「同段落内」文本纠偏：偏移与 `bookText` 对不上时，在**本位置附近**找一次 `bookText`。
 *
 * 触发场景（都是真实的）：切换简繁转换后偏移位移；上游/别处导入的高亮换算后差一两个字；
 * 段落被引擎重新分段（`reSegment`）。
 *
 * ★★ **只在 `±window` 的窗口里找，且取离原位置最近的那次出现**。
 * 早先写的是 `text.indexOf(bookText)` —— 那是**全章第一次**出现的位置，可能远在几百字之外，
 * 结果是「划线跑到了另一处一模一样的句子上」，比不纠偏还糟（实测：探针里 `第1章` 就是这么被挪走的）。
 * 找不到就**原样返回**（宁可位置略有偏差，也不要把用户的划线弄丢）。
 */
export function reanchor(
  text: string,
  start: number,
  end: number,
  bookText: string,
  window = 256,
): [number, number] {
  if (!bookText) return [start, end];
  if (text.slice(start, end) === bookText) return [start, end];
  const from = Math.max(0, start - window);
  const to = Math.min(text.length, end + window);
  const seg = text.slice(from, to);
  let best = -1;
  let idx = seg.indexOf(bookText);
  while (idx >= 0) {
    const abs = from + idx;
    if (best < 0 || Math.abs(abs - start) < Math.abs(best - start)) best = abs;
    idx = seg.indexOf(bookText, idx + 1);
  }
  if (best >= 0) return [best, best + bookText.length];
  // 空白不敏感兜底：手机端 `bookText/content` 的段落缩进（`\n　　`）与我们正文的段落分隔不一致，
  // 精确比较必然失败。去掉空白后再找一次，仍限定在本位置 ±window 内、取最近的一次。
  const compact = (ch: string) => !/[\s\u3000]/.test(ch);
  const q = [...bookText].filter(compact).join('');
  if (!q) return [start, end];
  let buf = '';
  const map: number[] = [];
  for (let i = from; i < to; i += 1) {
    const ch = text[i] ?? '';
    if (compact(ch)) {
      buf += ch;
      map.push(i);
    }
  }
  let k = buf.indexOf(q);
  if (k < 0) return [start, end];
  let bestAbs = map[k] ?? start;
  let next = buf.indexOf(q, k + 1);
  while (next >= 0) {
    const abs = map[next] ?? bestAbs;
    if (Math.abs(abs - start) < Math.abs(bestAbs - start)) bestAbs = abs;
    next = buf.indexOf(q, next + 1);
  }
  return [bestAbs, Math.min(text.length, bestAbs + bookText.length)];
}

/**
 * `#726` 高亮/书签的**整章文本锚定**：先走本地窗口纠偏，失败再做一次「唯一命中」兜底。
 *
 * 为什么需要：阅读模式开启/关闭会把整章段落整体替换（引擎段落 ↔ 抽取段落），
 * 段落下标与整章偏移都会**整体变化**，`reanchor` 的 ±256 窗口在这种位移面前必然找不到。
 *
 * 为什么必须「唯一命中」才采用：`#146` 已经踩过 `text.indexOf(bookText)` 的坑 ——
 * 全章第一次出现的位置可能远在几百字外，会把划线挪到另一处相同句子上（实测 `第1章` 被挪走）。
 * 所以：整章里只出现一次才移动；出现 0 次或 ≥2 次一律**原样返回**（宁可略偏，也不悄悄挪错）。
 */
export function anchorRange(
  text: string,
  start: number,
  end: number,
  snippet: string,
  window = 256,
): [number, number] {
  const local = reanchor(text, start, end, snippet, window);
  if (!snippet || text.slice(local[0], local[1]) === snippet) return local;
  const first = text.indexOf(snippet);
  if (first < 0) return local;
  const second = text.indexOf(snippet, first + 1);
  if (second >= 0) return local;
  return [first, first + snippet.length];
}

/**
 * 把**整章**坐标的区间裁剪成**某一段内**的局部区间（渲染时逐段用）。
 *
 * 跨段高亮（拖选跨了好几段）在每一段里都要显示 —— 所以这里是「裁剪」而不是「归属」：
 * 一个横跨段 1~2 的高亮，在段 1 的尾部与段 2 的头部各有一段局部区间。
 * 完全落在本段之外的区间返回空数组（该段不用渲染高亮）。
 */
export function localRangesForPara(
  layout: ChapterTextLayout,
  ranges: readonly Range[],
  para: number,
): Array<[number, number]> {
  const base = layout.starts[para];
  const len = layout.lengths[para];
  if (base === undefined || len === undefined) return [];
  const from = base;
  const to = base + len;
  const out: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (e > s) out.push([s - base, e - base]);
  }
  return out;
}

/**
 * DOM 选区 → 正文偏移。
 *
 * 依赖渲染时给每个 `<p>` 加的 `data-p="段下标"`。两个端点**都必须落在正文段落内**：
 * 起点或终点落在标题（`.rd-chapter`）上 ⇒ 返回 `null`（对齐上游：`createHighlight` 里
 * `if (startLine.isTitle || endLine.isTitle) return null`，`ContentTextView.kt:874-876`）。
 * 跨段落选择是允许的（上游还要求跨**页**不行，我们没有分页概念，这个限制自然消失）。
 *
 * ⚠️ 只返回 `null` 而不说原因，会造成「点了没反应、控制台一片安静」——
 * 需要排查时用 {@link domRangeToBodyEx}，它带失败原因。
 */
export function domRangeToBody(
  layout: ChapterTextLayout,
  root: HTMLElement,
  range: { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number },
): [number, number] | null {
  return domRangeToBodyEx(layout, root, range).range;
}

/** {@link domRangeToBody} 的可诊断版本：失败时带 `why`（供**留痕**用，见铁律 3） */
export function domRangeToBodyEx(
  layout: ChapterTextLayout,
  root: HTMLElement,
  range: { startContainer: Node; startOffset: number; endContainer: Node; endOffset: number },
): { range: [number, number] | null; why?: string } {
  const s = locate(layout, root, range.startContainer, range.startOffset, 'start');
  if (!s.ok) return { range: null, why: s.why };
  const e = locate(layout, root, range.endContainer, range.endOffset, 'end');
  if (!e.ok) return { range: null, why: e.why };
  if (e.pos <= s.pos) {
    return {
      range: null,
      why: `end<=start（start=${s.pos} para=${s.para}/${s.char} · end=${e.pos} para=${e.para}/${e.char}）`,
    };
  }
  return { range: [s.pos, e.pos] };
}

type LocateResult =
  | { ok: true; pos: number; para: number; char: number }
  | { ok: false; why: string };

function locate(
  layout: ChapterTextLayout,
  root: HTMLElement,
  node: Node,
  offset: number,
  which: 'start' | 'end',
): LocateResult {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  if (!el) return { ok: false, why: `${which}：端点所在元素为空（nodeType=${node.nodeType}）` };
  if (!el.closest) return { ok: false, why: `${which}：端点元素没有 closest（tag=${el.tagName}）` };
  const paraEl = el.closest('p[data-p]') as HTMLElement | null;
  if (!paraEl) {
    return { ok: false, why: `${which}：端点不在任何 p[data-p] 里（tag=${el.tagName} cls=${el.className || '-'}）` };
  }
  if (!root.contains(paraEl)) return { ok: false, why: `${which}：段落不在正文容器内` };
  const para = Number(paraEl.getAttribute('data-p'));
  if (!Number.isInteger(para) || para < 0) {
    return { ok: false, why: `${which}：data-p 非法（${paraEl.getAttribute('data-p')}）` };
  }
  if (para >= layout.starts.length) {
    return { ok: false, why: `${which}：段下标 ${para} 超出布局（共 ${layout.starts.length} 段）` };
  }
  /**
   * `#825` 分页：一个段落可能被切成多片渲染，每片带 `data-p-start`（片在段内的起始字符）。
   * 片内量出的 `char` 是**相对本片**的 ⇒ 必须加回 `data-p-start` 才是段内偏移。
   * 滚动模式没有这个属性 ⇒ `pStart = 0`，与旧行为完全一致。
   */
  const pStart = Math.max(0, Number(paraEl.getAttribute('data-p-start') ?? 0) || 0);
  const charInPara = (n: number): number => Math.min(pStart + n, layout.lengths[para] ?? (pStart + n));
  // 段内偏移用 Range 量：它天然处理「文本节点被浏览器的断行/内联元素切开」这类情况
  let char = charInPara(layout.lengths[para] ?? 0);
  try {
    const r = document.createRange();
    r.setStart(paraEl, 0);
    r.setEnd(node, offset);
    char = charInPara(r.toString().length);
  } catch (err) {
    // 端点不在同一棵树里 ⇒ 保守取整段（调用方还会用 bookText 纠偏）
    return {
      ok: true,
      pos: paraPosToBody(layout.starts, para, char),
      para,
      char,
    };
  }
  char = Math.min(char, layout.lengths[para] ?? char);
  return { ok: true, pos: paraPosToBody(layout.starts, para, char), para, char };
}
