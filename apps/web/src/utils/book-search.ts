/**
 * 书内全文搜索（`#146` 第三步）—— 纯逻辑层。
 *
 * 对齐上游 `ui/book/searchContent/`：遍历章节 → 每章取正文 → 找全部命中 → 每处产出一个结果，
 * 片段取**关键词左右各 20 个字符**（`SearchContentViewModel.getResultAndQueryIndex` 的 `length = 20`）。
 *
 * ## ★ 两个**刻意不照抄**的地方（写在前面，免得后来者以为漏了）
 * 1. **不提供「净化替换」开关**。上游 `SearchContentViewModel` 有 `replaceEnabled` 并在正文上跑
 *    `ContentProcessor.getContent(useReplace = …)`；但**本仓引擎还没有净化规则的任何应用点**
 *    （已核实：全仓只有 `store.listReplaceRules()` 与端点，没有消费处）⇒ 给了这个开关就是
 *    「一个不起作用的设置」。等 `#144` 的 `replaceRules` 落地再加。
 * 2. **不联网抓未缓存的章节**。这一条其实**与上游一致**：`SearchContentActivity.startContentSearch()`
 *    只对 `cacheChapterNames`（磁盘上已有正文的章节）检索，其余 `return@forEach` 跳过。
 *    差别只在于「缓存」的判定：上游看章节文件，我们看 IndexedDB（`utils/chapter-cache.ts`）。
 *
 * ## 简繁转换怎么办（对齐上游的「搜转换后的正文」）
 * 上游搜的是 `ContentProcessor.getContent(...)` 的输出，也就是**排版用的那份文本**；本仓的排版文本
 * 是**显示层**（简繁转换后）。所以这里**不转查询词，而是转正文**：调用方对每个已缓存章节用
 * 与正文渲染**同一个** `convertChineseBatch()` 转换后再搜。
 * 两个好处：① 与上游同口径；② 命中位置落在**显示层坐标系**里 ⇒ 点击结果能**精确跳转**
 * （若去转查询词，位置就落回原文坐标，开着简繁时跳转会偏）。
 */

import { CHAPTER_PARA_SEP, buildChapterText } from './chapter-text';

/** 片段里关键词前后各留多少字符（照抄上游 `length = 20`） */
export const SEARCH_PAD = 20;

/**
 * 单章最多的命中数（护栏）。
 *
 * 上游没有这个上限 —— 在一个 5 万字章节里搜「的」会产出上千条结果、把列表和内存打爆。
 * 触发上限时**不是静默截断**：调用方会拿到 `truncated` 标记并在界面上如实说明。
 */
export const MAX_HITS_PER_CHAPTER = 200;

export interface SearchHit {
  /** 章节下标（跳转与分组用） */
  chapterIndex: number;
  /** 章节名（用于展示；调用方可覆盖成简繁转换后的） */
  chapterTitle: string;
  /**
   * 命中处在**正文偏移坐标系**里的位置（= 上游 `SearchResult.queryIndexInChapter`）。
   * ⚠️ 用本仓统一坐标系（`paragraphs.join('\n')`），这样跳转能直接复用 `scrollToChapterPos`。
   */
  chapterPos: number;
  /** 片段（关键词左右各 `SEARCH_PAD` 字） */
  text: string;
  /** 关键词在片段里的起始下标（渲染高亮用；上游同名 `queryIndexInResult`） */
  queryIndexInResult: number;
  /** 命中的是哪个查询词（原文 or 简繁转换后的），便于排查「为什么能/不能搜到」 */
  query: string;
}

export interface ChapterSearchResult {
  hits: SearchHit[];
  /** 该章命中数触到 `MAX_HITS_PER_CHAPTER` 而被截断 */
  truncated: boolean;
}

/** 章节正文 → 搜索用的整章纯文本（与高亮/跳转同一个坐标系，见 `chapter-text.ts`） */
export function chapterTextOf(paragraphs: readonly string[]): string {
  return buildChapterText(paragraphs).text;
}

/**
 * 找出 `query` 在 `content` 里的**全部**起始位置。
 *
 * - 普通模式：`indexOf` 循环（与上游 `searchPosition` 一致）
 * - 正则模式：`RegExp(query, 'g')`；★ **零宽匹配必须手动推进 `lastIndex`**，
 *   否则 `/^/g` 这类模式会**死循环**（Kotlin 的 `findAll` 没这个问题，JS 有）
 * - 正则非法：返回 `null` 而**不是**空数组 —— 调用方要能区分「正则写错了」与「真的没命中」，
 *   前者必须给用户提示（上游在这里 `catch` 后静默返回空，属于「静默兜底」，铁律 3 不允许）
 */
export function findPositions(content: string, query: string, isRegex = false): number[] | null {
  const out: number[] = [];
  if (!query || !content) return out;
  if (isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query, 'g');
    } catch {
      return null;
    }
    let m = re.exec(content);
    while (m) {
      out.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex += 1; // 零宽匹配：防死循环
      if (out.length >= MAX_HITS_PER_CHAPTER) break;
      m = re.exec(content);
    }
    return out;
  }
  let i = content.indexOf(query);
  while (i >= 0) {
    out.push(i);
    if (out.length >= MAX_HITS_PER_CHAPTER) break;
    i = content.indexOf(query, i + query.length);
  }
  return out;
}

/**
 * 取命中处的片段：关键词左右各 `pad` 个字符（照抄上游 `getResultAndQueryIndex`）。
 * 两端按正文边界夹紧；`queryIndexInResult` 是关键词在新片段里的起始下标。
 */
export function snippetAt(
  content: string,
  index: number,
  queryLength: number,
  pad = SEARCH_PAD,
): { text: string; queryIndexInResult: number } {
  let from = index - pad;
  let to = index + queryLength + pad;
  if (from < 0) from = 0;
  if (to > content.length) to = content.length;
  return { text: content.slice(from, to), queryIndexInResult: index - from };
}

/**
 * 在单章正文里搜索，产出结果列表。
 *
 * ⚠️ 传进来的 `content` **必须与界面显示的是同一份文本**（开着简繁时就是转换后的那份）——
 * 否则 `chapterPos` 落到另一个坐标系，点结果跳转会偏（见文件头「简繁转换怎么办」）。
 */
export function searchChapterContent(opts: {
  content: string;
  query: string;
  chapterIndex: number;
  chapterTitle: string;
  isRegex?: boolean;
}): { result: ChapterSearchResult; regexError: boolean } {
  const { content, query, chapterIndex, chapterTitle, isRegex = false } = opts;
  const hits: SearchHit[] = [];
  let truncated = false;
  let regexError = false;
  if (query) {
    const positions = findPositions(content, query, isRegex);
    if (positions === null) {
      regexError = true;
    } else {
      if (positions.length >= MAX_HITS_PER_CHAPTER) truncated = true;
      for (const pos of positions) {
        const { text, queryIndexInResult } = snippetAt(content, pos, query.length);
        hits.push({ chapterIndex, chapterTitle, chapterPos: pos, text, queryIndexInResult, query });
      }
    }
  }
  return { result: { hits, truncated }, regexError };
}

/** 按页码/位置给全书的搜索结果排序（章内顺序 = 正文顺序） */
export function sortHits(hits: readonly SearchHit[]): SearchHit[] {
  return [...hits].sort((a, b) => a.chapterIndex - b.chapterIndex || a.chapterPos - b.chapterPos);
}

/** 拼接片段时用的分隔符（与 `chapter-text.ts` 一致，导出给测试与调用方显式使用） */
export const SEARCH_TEXT_SEP = CHAPTER_PARA_SEP;
