/**
 * TXT 本地书解析（`#202`，`#212` 扩充分章净化 / 超长拆分 / 每章字数）
 *
 * 对应上游 `model/localBook/TextFile.kt`（623 行）。**移植的是判据，不是逐行照抄** ——
 * 上游为 Android 的「边读边缓存的字节流 + 8MB 手工缓冲」写得很绕（`txtBuffer`/`bufferStart`/
 * `bufferEnd` 三处手工管理），在我们这里直接**整篇解码成字符串**再按**字符偏移**切，等价且不易出错。
 *
 * ## 与上游的四处差异（都写明了为什么，不是简化偷懒）
 * 1. **偏移是「字符」不是「字节」**：上游用字节偏移（它按字节流读取）。我们每次读正文都重新
 *    读文件 + 整篇解码 ⇒ 字符偏移没有歧义，也**避免多字节编码切在字节中间**的经典 bug。
 *    `ShelfChapter.start/end` 字段语义随之明确为「字符偏移」。
 * 2. **`tocUrl` 净化只做受支持的纯表达式子集**（上游 `replacement()` 会 `eval` 用户 JS 改写标题）：
 *    本仓的本地书导入**不执行文件内容里的脚本**（安全边界，见 `sanitize.ts`）。
 *    ★ `#212` 起支持 `@replace` / `@trim` 这套正则净化语法；不支持的表达式**保留原标题**并留痕。
 * 3. **超长章节自动拆分**（`#212`，上游 `getSplitLongChapter()`，阈值 `maxLengthWithToc`）：拆出的
 *    子章标题为「原标题(1)(2)…」，原章退化为 `isVolume=true` 的卷名 —— 与上游语义一致。
 * 4. **不做字数统计的二次修正**（上游 `getWordCount()` 会拿旧目录的字数覆盖新目录）。
 *    导入即全量替换目录，没有「旧目录」可用。
 *
 * ## 分章口径（照上游，逐条可核对）
 * - 章节 `start` = **标题结束**的位置（正文不含标题，避免与阅读器标题重复）；
 * - 章节 `end` = **下一个标题开始**的位置；最后一章 `end` = 全文长度；
 * - 标题之间**内容为空**的章节 ⇒ 判定为**卷名**（`isVolume`，阅读器要跳过它取正文）；
 * - 第一个标题**之前**若有非空内容 ⇒ 作为「前言」章（`start=0`），同时把这段当 `intro`（超 600 字截断）。
 */

import { decodeBuffer, detectCharset, type BookCharset } from './encoding';
import { parseSanitize, warnOnceSanitize, type SanitizeOp } from './sanitize';
import { DEFAULT_ENABLED_TXT_TOC_RULES, type TxtTocRule } from './toc-rules';

/** 一条解析出来的章节（对契约 `ShelfChapter` 的最小子集） */
export interface ParsedChapter {
  title: string;
  isVolume: boolean;
  /** 起始字符偏移（标题之后） */
  start: number;
  /** 结束字符偏移（下一个标题之前） */
  end: number;
  wordCount: string;
}

export interface ParsedTxt {
  charset: BookCharset;
  /** 命中的目录规则名（`''` = 没命中任何规则，按固定长度切） */
  tocRuleName: string;
  tocRule: TxtTocRule | null;
  chapters: ParsedChapter[];
  /** 总字数（字符数） */
  wordCount: number;
  /** 首章之前的内容（上游 `book.intro`；超 600 字截断） */
  intro: string;
}

/** 上游 `TextFile.maxLengthWithNoToc = 10 * 1024`（没有标题时每章最大长度） */
const MAX_LENGTH_WITH_NO_TOC = 10 * 1024;
/** 上游 `overRuleCount = 2`：后面的规则必须**多出 2 条以上**才替换当前最优 */
const OVER_RULE_COUNT = 2;

/** 上游 `StringUtils.wordCountFormat`：>1 万字用「万」并保留 1 位小数 */
export function wordCountFormat(words: number): string {
  if (!(words > 0)) return '';
  if (words > 10000) return `${(words / 10000).toFixed(1)}万字`;
  return `${words}字`;
}

/** 上游 `TextFile.maxLengthWithToc = 102400`（超长章节拆分阈值，字符口径） */
export const MAX_LENGTH_WITH_TOC = 102400;

/**
 * 替换串里的 `$0`/`$N` 组引用展开（Android `Matcher.appendReplacement` 同款语义）。
 *
 * ⚠️ JS 原生 `String.replace` 的替换串**不认 `$0`**（`$0` 会当字面量留在标题里），
 * 所以不能把 `to` 直接交给 `String.replace`，必须自己展开。
 *
 * 口径（与 `apps/web/src/utils/js-replace.ts` 的 `expandJavaReplacement` 一致；
 * 这里只做**本地书净化**需要的子集：`$0`~`$9`，不支持 `${name}` 命名分组）：
 * - `$0` = 整个匹配；`$N` = 第 N 个分组；
 * - 组号**贪心但只吃到仍是合法组号为止**（只有 2 组时 `$10` = `$1` + 字面量 `0`）；
 * - 超范围的组号 / 串尾孤立 `$` ⇒ **抛错** ⇒ 由调用方跳过该条净化并留痕（不改标题，也不留半个结果）。
 *
 * @param to     替换串（含 `$` 引用）
 * @param groups 第 0 项 = 整个匹配，其后依次是各分组
 */
export function expandGroupRefs(to: string, groups: readonly string[]): string {
  const groupCount = groups.length - 1;
  let out = '';
  let i = 0;
  while (i < to.length) {
    const c = to[i]!;
    if (c !== '$') {
      out += c;
      i += 1;
      continue;
    }
    const next = to[i + 1];
    if (next === undefined) throw new Error('Illegal group reference: group index is missing');
    if (next < '0' || next > '9') {
      out += next; // `$` 后面不是数字 ⇒ 当字面量（宽容处理，不抛）
      i += 2;
      continue;
    }
    let ref = next.charCodeAt(0) - 48;
    let j = i + 2;
    while (j < to.length) {
      const d = to[j]!;
      if (d < '0' || d > '9') break;
      const grown = ref * 10 + (d.charCodeAt(0) - 48);
      if (grown > groupCount) break;
      ref = grown;
      j += 1;
    }
    if (ref > groupCount) throw new Error(`No group ${ref}`);
    out += groups[ref] ?? '';
    i = j;
  }
  return out;
}

/**
 * 数一个正则源码里的**捕获组**个数（`(?:`/`(?=`/`(?<name>` 不计）。
 *
 * 不用 `exec` 试探：正则可能不匹配空串，`exec('')` 会返回 `null` ⇒ 数出 0 个组 ⇒ `$1` 全废。
 * 这里做**词法扫描**（识别 `\` 转义与字符类 `[...]`），三层嵌套足够处理净化表达式这种短串。
 */
function captureGroupCount(src: string): number {
  let n = 0;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      i += 1; // 跳过转义的下一字符
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      const next = src[i + 1];
      if (next === '?') {
        // `(?:` `(?=` `(?!` `(?<=` `(?<!` 都是非捕获；`(?<name>` 是命名捕获 ⇒ 算一个
        const n2 = src[i + 2];
        if (n2 === '<' && src[i + 3] !== '=' && src[i + 3] !== '!') n += 1;
        continue;
      }
      n += 1;
    }
  }
  return n;
}

/**
 * 把一条目录规则的净化表达式编译成「标题 → 新标题」的函数。
 *
 * 返回 `null` 表示「该规则**没有**可用的净化」（空表达式）或「表达式不支持」——
 * 两者对调用方都是**原样返回标题**，区别只在后者要留痕（`warnOnce`）。
 */
function compileSanitizer(rule: TxtTocRule): ((title: string) => string) | null {
  const ops = parseSanitize(rule.replacement);
  if (ops === null) {
    // 不支持 ⇒ 明确留痕（铁律 3：「不支持」不能被静默当成「不做」）
    warnOnceSanitize(`unsupported-sanitize:${rule.name}:${rule.replacement.slice(0, 40)}`, (k) =>
      console.warn(`[local-book] 目录净化表达式不受支持，将原样保留标题：${k}`),
    );
    return null;
  }
  if (!ops.length) return null;
  const compiled: Array<{ op: SanitizeOp; re?: RegExp; groupCount: number }> = ops.map((op) => {
    if (op.kind !== 'replace') return { op, groupCount: 0 };
    try {
      const re = new RegExp(op.src!, 'g');
      return { op, re, groupCount: captureGroupCount(op.src!) };
    } catch {
      return { op, groupCount: 0 }; // 语法错 ⇒ 下面统一按「不支持」处理
    }
  });
  if (compiled.some((c) => c.op.kind === 'replace' && !c.re)) {
    warnOnceSanitize(`bad-sanitize-regex:${rule.name}`, (k) =>
      console.warn(`[local-book] 目录净化正则编译失败，将原样保留标题：${k}`),
    );
    return null;
  }
  return (title: string): string => {
    let out = title;
    for (const { op, re, groupCount } of compiled) {
      if (op.kind === 'trim') out = out.trim();
      else {
        out = out.replace(re!, (...args: unknown[]) => {
          const groups = args.slice(0, groupCount + 1).map((x) => String(x ?? ''));
          return expandGroupRefs(op.to ?? '', groups);
        });
      }
    }
    return out;
  };
}

/** 用规则里剥出来的 flags 构造正则（默认 `gm`，与上游 `Pattern.MULTILINE` + 全程 find 一致） */
function toRegex(rule: TxtTocRule): RegExp | null {
  try {
    const flags = `g${rule.flags.includes('m') || rule.flags === '' ? 'm' : ''}${rule.flags.includes('i') ? 'i' : ''}`;
    return new RegExp(rule.rule, flags);
  } catch {
    return null; // 语法错的规则**跳过**（上游同样 continue，不中断整本书）
  }
}

interface MatchInfo {
  /** 标题原文 */
  title: string;
  /** 标题起始字符位置 */
  start: number;
  /** 标题结束字符位置 */
  end: number;
}

/**
 * 跑一条规则，返回它认为的「章节标题」位置列表。
 *
 * `sanitize` 非空时，标题先过净化（上游 `replacement()`）；净化后为**空串**的匹配
 * **整条丢弃**（上游 `takeIf { it.isNotEmpty() } ?: continue` 同款语义）。
 * ⚠️ 我们只对**我们支持的净化语法**走这条丢弃逻辑 —— 「表达式不支持」时 `compileSanitizer`
 * 返回 `null`，此时**不做净化也不丢弃**（避免把「我们不支持」误判成「用户要丢掉」）。
 */
function runRule(text: string, rule: TxtTocRule, sanitize: ((t: string) => string) | null): MatchInfo[] {
  const re = toRegex(rule);
  if (!re) return [];
  const out: MatchInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // 空匹配必须手动前进，否则死循环
      continue;
    }
    let title = m[0].trim();
    if (sanitize) {
      title = sanitize(title);
      if (!title) continue; // 净化成空 ⇒ 丢掉这一条（照上游）
    }
    out.push({ title, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 挑目录规则（上游 `getTocRule()`）。
 *
 * 打分口径逐条照抄：
 * - `csNum` = 有效章节数（第一次匹配，或距上次标题内容 > 1000 字的匹配）；
 * - `numE` = 「距上次内容 < 100 字」的匹配数（上游认为这种多半是把**卷**错认成章）；
 * - 入选条件：`csNum >= numE * 3`（正常章节数不该少于卷数的 3 倍）**且** `csNum > maxNum + 2`；
 * - `csNum > 70` 直接采用（前 70 章都对，说明规则合适）。
 */
export function pickTocRule(text: string, rules: TxtTocRule[] = DEFAULT_ENABLED_TXT_TOC_RULES): TxtTocRule | null {
  let maxNum = -1;
  let best: TxtTocRule | null = null;
  for (const rule of rules) {
    const re = toRegex(rule);
    if (!re) continue;
    let m: RegExpExecArray | null;
    let start = 0;
    let csNum = 0;
    let numE = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const contentLength = m.index - start;
      if (start === 0 || contentLength > 1000) {
        if (m[0].trim()) csNum++;
        start = m.index + m[0].length;
      } else if (contentLength < 100) {
        numE++;
      }
    }
    if (csNum >= numE * 3 && csNum > maxNum + OVER_RULE_COUNT) {
      maxNum = csNum;
      best = rule;
      if (maxNum > 70) break;
    }
  }
  return best;
}

/**
 * 把**超长章节**按长度拆开（`#212`，上游 `getSplitLongChapter()` 的等价物）。
 *
 * 上游语义（`TextFile.kt:369`）：章长 > `maxLengthWithToc` 时，
 * 原章**退化为 `isVolume=true` 的卷名**（`end = start`、`title` 保留），
 * 其正文区间再用「无规则分章」`analyze(start, end)` 切成若干节，
 * 子章标题统一改成 `原标题(1)`、`原标题(2)`…（上游 `"$lastTitle(${index + 1})"`）。
 *
 * ⚠️ 上游 `analyze(start, end)` 用**固定 10KB**（`maxLengthWithNoToc`）切，我们同样用
 * `MAX_LENGTH_WITH_NO_TOC`（`buildChaptersByLength` 的同一口径），保证「拆出的子章大小」
 * 与「整篇没有标题时的兜底分章」一致 —— 两条路径不该有两套阈值。
 */
function splitLongChapters(text: string, chapters: ParsedChapter[]): ParsedChapter[] {
  const out: ParsedChapter[] = [];
  for (const ch of chapters) {
    const len = ch.end - ch.start;
    // 卷名（无正文）不参与拆分；未超阈值原样保留
    if (ch.isVolume || len <= MAX_LENGTH_WITH_TOC) {
      out.push(ch);
      continue;
    }
    const title = ch.title;
    // 原章 → 卷名（照上游：end 收到 start、isVolume=true）
    out.push({ title, isVolume: true, start: ch.start, end: ch.start, wordCount: '' });
    // 正文区间按 10KB 切（与无规则兜底同一口径；尽量切在换行处，避免断行断字）
    let pos = ch.start;
    let n = 1;
    while (pos < ch.end) {
      let end = Math.min(pos + MAX_LENGTH_WITH_NO_TOC, ch.end);
      if (end < ch.end) {
        const nl = text.indexOf('\n', end);
        if (nl >= 0 && nl - end < MAX_LENGTH_WITH_NO_TOC) end = nl;
      }
      out.push({
        title: `${title}(${n})`,
        isVolume: false,
        start: pos,
        end,
        wordCount: wordCountFormat(end - pos),
      });
      pos = end;
      n += 1;
      if (n > 10000) break; // 病态输入保护
    }
  }
  return out;
}

/** 按标题位置列表组装章节（含前言 / 卷判定 / 字数），并拆分超长章节 */
function buildChapters(
  text: string,
  marks: MatchInfo[],
  splitLong = false,
): { chapters: ParsedChapter[]; intro: string; wordCount: number } {
  const chapters: ParsedChapter[] = [];
  const intro = text.slice(0, marks[0]?.start ?? text.length);
  let wordCount = 0;

  // 前言：第一个标题前有非空内容才算一章（照上游 `analyze()` 的「序章」分支）
  if (marks.length && intro.trim()) {
    chapters.push({
      title: '前言',
      isVolume: false,
      start: 0,
      end: marks[0]!.start,
      wordCount: wordCountFormat(intro.length),
    });
    wordCount += intro.length;
  } else if (!marks.length) {
    // 没命中任何规则：内容整篇当前言，下面走「按长度硬切」
    wordCount += intro.length;
  }

  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    const start = cur.end;
    const end = next ? next.start : text.length;
    const body = text.slice(start, end);
    wordCount += body.length;
    chapters.push({
      title: cur.title || '无标题章节',
      // ★ 卷判定：标题与下一个标题之间**没有内容** ⇒ 这一条是卷名（上游同一判据）
      isVolume: body.trim().length === 0,
      start,
      end,
      wordCount: wordCountFormat(body.length),
    });
  }
  const finalChapters = splitLong ? splitLongChapters(text, chapters) : chapters;
  return { chapters: finalChapters, intro: intro.length > 600 ? intro.slice(0, 600) : intro, wordCount };
}

/** 没命中任何规则时的兜底分章（上游 `analyze()` 无规则分支：每 10KB 且尽量切在换行处） */
function buildChaptersByLength(text: string): { chapters: ParsedChapter[]; intro: string; wordCount: number } {
  const chapters: ParsedChapter[] = [];
  let pos = 0;
  let block = 1;
  while (pos < text.length) {
    let end = Math.min(pos + MAX_LENGTH_WITH_NO_TOC, text.length);
    if (end < text.length) {
      const nl = text.indexOf('\n', end);
      if (nl >= 0 && nl - end < MAX_LENGTH_WITH_NO_TOC) end = nl;
    }
    const body = text.slice(pos, end);
    chapters.push({
      title: `第${block}节(${chapters.length + 1})`,
      isVolume: false,
      start: pos,
      end,
      wordCount: wordCountFormat(body.length),
    });
    pos = end;
    block++;
    if (chapters.length > 100000) break; // 病态输入保护（正常书不会有 10 万节）
  }
  return { chapters, intro: text.slice(0, 600), wordCount: text.length };
}

/**
 * 解析一份 txt。`charsetHint` 非空时**强制使用**它（用户手动指定编码的场景）。
 * `splitLongChapter` 为真时拆超长章节（`#212`；对应上游 `book.getSplitLongChapter()` 开关）。
 *
 * 返回的 `start`/`end` 是**字符偏移**，与 `readTxtContent()` 的入参口径一致。
 */
export function parseTxt(buf: Uint8Array, charsetHint?: string | null, splitLongChapter = false): ParsedTxt {
  const charset = charsetHint ? detectCharsetOf(buf, charsetHint) : detectCharset(buf);
  const text = decodeBuffer(buf, charset);
  const rule = pickTocRule(text);
  const sanitize = rule ? compileSanitizer(rule) : null;
  const hasMarks = rule ? runRule(text, rule, sanitize) : [];
  const built = hasMarks.length
    ? buildChapters(text, hasMarks, splitLongChapter)
    : buildChaptersByLength(text);
  return {
    charset,
    tocRuleName: hasMarks.length && rule ? rule.name : '',
    tocRule: hasMarks.length ? rule : null,
    chapters: built.chapters,
    wordCount: built.wordCount,
    intro: built.intro,
  };
}

/** 用户显式指定了编码名 ⇒ 用它（但要过一遍 `TextDecoder` 认不认） */
function detectCharsetOf(_buf: Uint8Array, hint: string): BookCharset {
  const h = hint.toLowerCase();
  if (h === 'utf8' || h === 'utf-8') return 'utf-8';
  if (h.includes('16le')) return 'utf-16le';
  if (h.includes('16be')) return 'utf-16be';
  if (h.includes('big5')) return 'big5';
  if (h.includes('ascii')) return 'ascii';
  return 'gb18030';
}

/**
 * 取某一章的正文（按**字符偏移**切，再按上游 `padRegex` 把开头的空白换成两格缩进）。
 *
 * 上游 `TextFile.getContent()` 末尾：`.replace("^[\\n\\s]+".toRegex(), "　　")` ——
 * 目的只是让首行有缩进，不是格式化全文（正文里的换行原样保留，由阅读器按行渲染）。
 */
export function readTxtContent(buf: Uint8Array, charset: string | null | undefined, start: number, end: number): string {
  const text = decodeBuffer(buf, charset);
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return text.slice(s, e).replace(/^[\n\s]+/, '　　');
}

/**
 * 从文件名猜书名/作者（上游 `LocalBook.analyzeNameAuthor`，4 条正则依次试）。
 *
 * ⚠️ 上游还支持用户自定义 JS 规则（`AppConfig.bookImportFileName`）。本仓**不执行用户脚本**
 *   （安全边界），只做这 4 条内置模式 + 清洗。
 */
export function analyzeFileName(fileName: string, config?: { importNameRule?: string }): { name: string; author: string } {
  void config; // 预留：将来若支持用户规则，在这里接
  const temp = fileName.replace(/\.[^.]+$/, '');
  const patterns: RegExp[] = [
    /(.*?)《([^《》]+)》.*?作者：(.*)/,
    /(.*?)《([^《》]+)》(.*)/,
    /(^)(.+) 作者：(.+)$/,
    /(^)(.+) by (.+)$/,
  ];
  for (const p of patterns) {
    const m = p.exec(temp);
    if (m) {
      const name = m[2] ?? '';
      const author = cleanAuthor(`${m[1] ?? ''}${m[3] ?? ''}`);
      if (name) return { name, author };
    }
  }
  const name = cleanName(temp);
  const rest = temp.replace(name, '');
  const author = cleanAuthor(rest);
  return { name, author: author.length === temp.length ? '' : author };
}

/** 上游 `AppPattern.nameRegex = /\s+作\s*者.*|\s+\S+\s+著/` */
function cleanName(name: string): string {
  return name.replace(/\s+作\s*者.*|\s+\S+\s+著/, '').trim();
}

/** 上游 `AppPattern.authorRegex = /^\s*作\s*者[:：\s]+|\s+著/` */
function cleanAuthor(author: string): string {
  return author.replace(/^\s*作\s*者[:：\s]+|\s+著/, '').trim();
}
