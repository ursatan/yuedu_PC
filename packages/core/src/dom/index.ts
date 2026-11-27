/**
 * DOM 层（架构红线 R1：一次解析只产出一棵 DOM 树）
 *
 * 四种选择器（CSS / XPath / JSON / JS）全部操作同一棵树。
 * 这里用 jsdom 作为唯一 DOM 后端；后续若换 linkedom / 浏览器，只需改这里。
 */

import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
// `#771` 冻结探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）
import { probeEnter, probeLeave } from '../diag/freeze-probe';

export interface DomHandle {
  /** 文档对象（XPath 求值用） */
  document: Document;
  /** 根元素（CSS 选择器入口） */
  root: Element;
  /** 释放资源（jsdom 在 Node 下无需显式释放，预留接口） */
  dispose?(): void;
}

/**
 * `parseHtml` 调用计数（诊断 + 回归测试用）。
 *
 * 为什么要它：jsdom 每次 parse **常驻约 1MB**（`tmp/probe-leak5.mts` 实测 959KB/次，强 GC 后仍在），
 * 所以「热路径里有没有多余的 parse」必须可断言 —— 缺陷类 R（字符串桥接提前解析）就是靠它锁住的：
 * 只用字符串方法的脚本**必须 0 次**解析，真调 jsoup 方法时才允许解析（且只解析一次）。
 */
export const parseHtmlStats = {
  count: 0,
  /**
   * 累计解析耗时（ms）。与 `process.cpuUsage()` 对照即可算出
   * 「DOM 解析占了多少 CPU」—— `#93`（fragment 快路）就是靠它决定做不做的。
   * 单次 `performance.now()` 相比一次 12ms 级的 parse 完全可忽略。
   */
  totalMs: 0,
  /**
   * 输入长度分桶。`JSDOM.fragment()` **语义上与 `new JSDOM()` 不等价**
   * （无 `documentElement`、Fragment 不在 document 上 ⇒ 文档级 XPath 失效），
   * 所以「有多少比例的 parse 是**短串包装**（只取文本/属性、不需要文档级能力）」
   * 才是它能覆盖的上限。见 `tmp/probe-93-fragment.mts`。
   */
  buckets: { tiny: 0, small: 0, medium: 0, large: 0 },
  /** 与 `buckets` 同键的累计耗时（ms）——「时间花在哪种规模的页面上」比总数更有用 */
  bucketMs: { tiny: 0, small: 0, medium: 0, large: 0 },
  /** 单次最长耗时（ms）与对应输入长度：定位「一个巨型页面拖垮整轮」 */
  maxMs: 0,
  maxLen: 0,
};

/** 输入长度 → 桶名（阈值按实测分布定：短串包装 / 常规页面 / 超大页面） */
function bucketOf(len: number): keyof typeof parseHtmlStats.buckets {
  if (len <= 1_000) return 'tiny';
  if (len <= 65_536) return 'small';
  if (len <= 1_048_576) return 'medium';
  return 'large';
}

/**
 * ★ `#188`：`<a/>` 形态的**自闭合差值** —— jsdom（HTML5 规范）vs jsoup（上游解析器）。
 *
 * 症状：⚡📂33文学正文恒 1 段（App 端正常）—— 站点正文页里有个写坏的 `<a/>`
 * （`<a href=...>303文学<a/>www.…(第1/2页)<br/>正文…`）。HTML5 规范**忽略**非 void 元素
 * 的自闭合斜杠 ⇒ `<a/>` 开一个新 `<a>`，**后面全部正文被吞进 `<a>` 元素** ⇒
 * 容器的「直接子文本节点」只剩提示行（`@textNodes` = 直接子 TextNode，见上游
 * `AnalyzeByJSoup.kt:239-251`）⇒ 正文空。jsoup 则**尊重** `/>` ⇒ `<a/>` 是空元素，
 * 正文留在容器里 ⇒ App 正常。
 *
 * 修法：parse 前把「非 void 元素的自闭合写法」展开成显式空元素（`<a/>` → `<a></a>`），
 * 让 jsdom 的解析结果与 jsoup 一致。三条护栏：
 *  ① `<script>`/`<style>`/`<textarea>` 原文与 HTML 注释**整块跳过**（JS 里 `/>` 是除法/正则）；
 *  ② **void 元素**（`<br/>`/`<img/>`/`<input/>`…）**不动** —— 展开成 `<br></br>` 会让
 *     HTML5 的 `</br>` 处理规则**多插一个 `<br>`**（换行翻倍）；
 *  ③ 快速路径：不含 `/>` 的输入零开销。
 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);
/** 原样保留的块：脚本/样式/文本域（内容是代码，不是标记）与 HTML 注释 */
const PASSTHROUGH_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<textarea\b[^>]*>[\s\S]*?<\/textarea\s*>|<!--[\s\S]*?-->/gi;
/** 自闭合开标签：`<tag attrs.../>`（属性里允许带引号串，引号内可以有 `>` 吗——不能，HTML5 同样不允许） */
const SELF_CLOSING_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\s*\/>/g;

function expandSelfClosing(html: string): string {
  if (!html.includes('/>')) return html;
  let out = '';
  let last = 0;
  for (const m of html.matchAll(PASSTHROUGH_RE)) {
    out += expandSelfClosingIn(html.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  out += expandSelfClosingIn(html.slice(last));
  return out;
}

function expandSelfClosingIn(html: string): string {
  return html.replace(SELF_CLOSING_RE, (whole, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (VOID_TAGS.has(name)) return whole; // void：保持原样（护栏 ②）
    return `<${tag}${attrs}></${tag}>`;
  });
}

/**
 * `#703` **丢掉「没有对应开标签的 `</p>`」** —— 又一处 jsoup 与 HTML5 规范的差异。
 *
 * ## 实测缺陷（精华书阁手机版 V2 详情页）
 * 站点把标题写成 `<p><a href="/15281/"><h2>剑来</h2></a></p>` —— `<h2>` 是块级元素，
 * 按 HTML5 规范**会隐式关掉那个 `<p>`**；随后那个 `</p>` 就成了「无匹配开标签」的游离标签。
 *  · **parse5/jsdom（规范）**：给它补一个空 `<p></p>`（规范明确要求：无 p 在栈上时就地造一个再关上）；
 *  · **jsoup（上游）**：`InBody.endTagP` 在没有开着的 p 时 `return false`，落到 `anyOtherEndTag`
 *    —— 找不到匹配元素就**直接忽略**，不造任何节点。
 *
 * 后果不是「多一个空标签」这么轻：多出来的那个 `<p>` 会让**后面所有 `p:nth-of-type(n)` 整体错位一格**。
 * 该源正是这么写的：作者 = `p:nth-of-type(2)`、分类 = `p:nth-of-type(3)`、最新 = `p:nth-of-type(6)`。
 * 实测（修复前）：作者 → 空、分类 → `作者：烽火戏诸侯`、最新 → `更新：2026-10-27 …`，**每个都偏了正好一行**。
 *
 * ## 做法
 * 解析前把这类「游离 `</p>`」删掉（等价于 jsoup 的忽略）。只删 `</p>`、只删**确定无主**的那一个，
 * 其余一个字节都不动：
 *  · 维护一个「开标签栈」，只用来回答一个问题：**此刻栈上还有 `p` 吗**；
 *  · 块级开标签（`div` / `h1`~`h6` / `ul` / `table` …）按规范先把 `p` 关掉（否则会误判 p 还开着）；
 *  · 拿不准的情况**一律不删**（宁可与今天一样，也不要凭空吃掉一个合法的 `</p>`）；
 *  · `<script>` / `<style>` / `<textarea>` / 注释整块跳过（那里的 `</p>` 只是字符串）。
 */
/** 会隐式关闭 `<p>` 的块级开标签（HTML5 「close a p element」的那份清单） */
const P_CLOSING_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
/** 一个标签：注释 / 开标签 / 闭标签（属性里允许引号串） */
const TAG_RE = /<!--[\s\S]*?-->|<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/**
 * 预扫描：删掉「无主」的 `</p>`（返回值可能**就是原串**，调用方不要假设必然变化）。
 * 导出的唯一目的是给回归测试与探针用。
 */
export function stripOrphanPEnd(html: string): string {
  // 快路径：一个 `</p>` 都没有就直接返回（绝大多数页面走这里，零开销）
  if (!/<\/p\s*>/i.test(html)) return html;
  if (html.length > 4 * 1024 * 1024) return html; // 超大文档不做这层（代价与收益不划算）
  const stack: string[] = [];
  let out = '';
  let last = 0;
  let dropped = 0;
  /** 跳过块（脚本/样式/注释）：里面的 `</p>` 是字符串，不是标记 */
  const skipRanges: Array<[number, number]> = [];
  for (const m of html.matchAll(PASSTHROUGH_RE)) {
    skipRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  let skipIdx = 0;
  for (const m of html.matchAll(TAG_RE)) {
    const at = m.index ?? 0;
    // 落在跳过块里 ⇒ 原样保留（并把它当透明，不改栈）
    while (skipIdx < skipRanges.length && skipRanges[skipIdx]![1] <= at) skipIdx++;
    const inSkip = skipIdx < skipRanges.length && at >= skipRanges[skipIdx]![0] && at < skipRanges[skipIdx]![1];
    if (inSkip) continue;
    const whole = m[0];
    if (whole.startsWith('<!--')) continue;
    const isEnd = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    if (!name) continue;
    if (!isEnd) {
      if (P_CLOSING_TAGS.has(name)) {
        // 块级开标签先把还开着的 p 关掉（`<p>` 自己也在这份清单里：`<p>a<p>b` 关掉前一个 p）
        const pi = stack.lastIndexOf('p');
        if (pi !== -1) stack.length = pi;
      }
      if (!VOID_TAGS.has(name) && !/\/>\s*$/.test(whole)) stack.push(name);
      continue;
    }
    if (name === 'p') {
      const pi = stack.lastIndexOf('p');
      if (pi === -1) {
        // 无主的 `</p>`：jsoup 忽略 ⇒ 我们也删掉（只删这个标签本身，前后空白不动）
        out += html.slice(last, at);
        last = at + whole.length;
        dropped += 1;
      } else {
        stack.length = pi; // 关掉 p（连同它上面的内联元素一起）
      }
      continue;
    }
    const idx = stack.lastIndexOf(name);
    if (idx !== -1) stack.length = idx;
  }
  if (!dropped) return html;
  out += html.slice(last);
  return out;
}

export function parseHtml(html: string, baseUrl?: string): DomHandle {
  /**
   * `#188`：jsdom 按解析器语义归一（见上方 `expandSelfClosing` 的注释），单一出口 ⇒ 所有源受益。
   * `#703` 再加一层「游离 `</p>`」归一（见 `stripOrphanPEnd`）：jsoup 忽略它、parse5 会补一个空 `<p>`，
   * 而那个空 `<p>` 会让后面所有 `p:nth-of-type(n)` 整体错位一格。
   */
  const normalized = expandSelfClosing(stripOrphanPEnd(html));
  // 诊断钩子（YUEDU_TRACE_PARSE_HTML=1）：jsdom 每次 parse 会**常驻约 1MB**（见
  // tmp/probe-leak5.mts 实测：强 GC 后仍留存 959KB/次），因此**谁在热路径里反复 parse**
  // 是内存问题的第一现场。打开它即可打印调用栈（只在显式开启时执行）。
  if (process.env.YUEDU_TRACE_PARSE_HTML) {
    const s = String(html);
    const stack = String(new Error().stack ?? '')
      .split('\n')
      .slice(2, 11)
      .map((l) => l.trim().replace(/^at /, ''))
      .join(' <- ');
    // `dig`（前 12 位 sha1）用来**判定「同一份内容被重复解析」**：
    // 只看 `len + 前 40 字符` 会把「同 class 的不同元素」误判成重复（实测踩过）。
    const dig = createHash('sha1').update(s).digest('hex').slice(0, 12);
    console.log(`[parseHtml] len=${s.length} dig=${dig} head=${JSON.stringify(s.slice(0, 40))} :: ${stack}`);
  }
  parseHtmlStats.count++;
  const t0 = performance.now();
  // `#771`：jsdom 构造是**纯同步 CPU**（每 MB 级 HTML 十几 ms 起），单次冻结的常见落点之一
  probeEnter('dom:parse');
  let dom: JSDOM;
  try {
    dom = new JSDOM(normalized, {
      url: baseUrl ?? 'about:blank',
      // 不执行任何脚本，避免副作用 / 注入
      pretendToBeVisual: false,
    });
  } finally {
    probeLeave();
  }
  parseHtmlStats.totalMs += performance.now() - t0;
  const bucket = bucketOf(String(html).length);
  parseHtmlStats.buckets[bucket]++;
  const took = performance.now() - t0;
  parseHtmlStats.bucketMs[bucket] += took;
  if (took > parseHtmlStats.maxMs) {
    parseHtmlStats.maxMs = took;
    parseHtmlStats.maxLen = String(html).length;
  }
  const doc = dom.window.document;
  return { document: doc, root: doc.documentElement as Element };
}

/**
 * XML 解析（部分 RSS / 接口为 XML）。jsdom 的 XML 支持有限，
 * 仅用于标签/属性/文本读取场景；XPath 1.0 足够覆盖。
 */
export function parseXml(xml: string): DomHandle {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const doc = dom.window.document;
  return { document: doc, root: doc.documentElement as Element };
}
