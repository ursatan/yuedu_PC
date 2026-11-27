/**
 * 规则解析编排器（对齐 Legado AnalyzeRule.kt）
 *
 * 这是「引擎的引擎」：把一条规则串，按 SourceRule 拆分，逐级应用 CSS / XPath /
 * JSONPath / Regex / JS 后端，处理 @put / {{}} / @get / ## 清洗 / && || %% 组合符，
 * 最终产出 字符串 / 节点列表 / 字符串列表。
 *
 * 六大模式的分发、双层容器解析、组合符语义，全部对照 /f/legado 源码实现，不猜测。
 */

import type { AnalyzeEnv } from './types';
import { SOURCE_FIELDS_KEY, BOOK_FIELDS_KEY, CHAPTER_FIELDS_KEY, RSS_FIELDS_KEY, DOCUMENT_THUNK, RULE_CONTENT_KEY, JSON_CTX_KEY } from './types';
import { splitSourceRule, resolvePlaceholders, resolvePlaceholdersSync, splitClean, isRuleExpr, getVarValue } from './rule-analyzer';
import { cssGetString, cssGetElements } from './css';
import { xpathGetString, xpathGetElements } from './xpath';
import { jsonGetString, jsonGetList, jsonGetObject } from './jsonpath';
import { regexGetString, regexGetElements, regexGetElement, compileKotlinRegex } from './regex';
import { attachJsonMapMethods } from './json-map';
import { selectJsoupFrom } from './jsoup-select';
import { parseHtml } from '../dom';
import { unescapeHtml4 } from './html-format';

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as Node).nodeType === 'number';
}

/**
 * 本仓 `org.jsoup` 仿真的**元素描述符**（`{outerHTML, innerHTML, text, attrs}`，见
 * `selector/jsoup-dom.ts`：L1 的 `makeElementList` / worker 的 `mkList` 都是这个形状）。
 *
 * ★ **为什么必须有它**（`D11` 实测，18AV）：这东西**语义上是元素**，但不是 DOM 节点（没有 `nodeType`）
 * ⇒ 旧判据把它当「JSON 对象」⇒ `setContent(item)` 走 JSONPath 分支 ⇒ 逐条 `ruleTitle='.con a@text'`
 * **恒空** ⇒ 24 条全被丢（title 空白即丢弃）⇒ **列表 0 条**（用户症状「分类下没有内容卡片」）。
 * 真实形态：18AV `ruleArticles` 是 `<js>… webr.select('.posts>.post') </js>`，返回 24 个描述符；
 * 页面里 `<div class="posts"><div class="post">` 结构明明是标准的。
 *
 * 判据**从严**：非 DOM 节点 + `outerHTML` 是非空字符串。JSON 数据里出现非空 `outerHTML` 字段的概率极低。
 */
function isElementDescriptor(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !isNode(v) &&
    typeof (v as { outerHTML?: unknown }).outerHTML === 'string' &&
    (v as { outerHTML: string }).outerHTML !== ''
  );
}

/** 把元素描述符还原成真 DOM 节点（`outerHTML` 重新 parse，与 `asNodes` 的字符串分支同一语义） */
function descriptorToNode(v: unknown): Element {
  return parseHtml(String((v as { outerHTML: string }).outerHTML)).root;
}

/**
 * `#403` `{{}}` 占位符内容**是不是一条源规则**（而非 JS 表达式）。
 *
 * 逐字对齐上游 `AnalyzeRule.kt:837-842` 的 `isRule()`：
 *   `@` 开头（JS 首个字符不可能是 `@`，除非装饰器，故规定为规则）/ `$.` / `$[` / `//`。
 *
 * 上游在 `makeUpRule` 里据此分流（`AnalyzeRule.kt:795-799`）：是规则 ⇒ `getString(规则)`
 * （支持 `@@` 前缀、`##` 正则替换、jsonpath）；否则 `evalJS(表达式)`。
 * 本仓此前**一律 jsEval** ⇒ `{{@@h1@text##\[.*?\]}}` 求值语法错、保留原文，
 * 残留的 `##` 再被 `splitClean` 的扁平兜底切开 ⇒ 整段 JS 被截断（`Unexpected end of input`，秀人集v26）。
 */
function isMakeUpRule(expr: string): boolean {
  const s = expr.trim();
  return s.startsWith('@') || s.startsWith('$.') || s.startsWith('$[') || s.startsWith('//');
}

/**
 * 内容是否该按 **JSON 后端**求值（决定 `detectMode` 的 `isContentJson`，
 * 它一旦为真 ⇒ **任何规则都被当成 JSONPath**，CSS/XPath 规则全数静默返空）。
 *
 * 权威语义（Legado `AnalyzeRule.setContent:104-107`）：
 *     `isJSON = when (content) { is Node -> false; else -> content.toString().isJson() }`
 * 即「**先字符串化，再判是不是 JSON**」；只有 DOM Node 例外。
 *
 * ⚠️ 我们此前写的是「`typeof v === 'object'` → true」，对**字符串包装对象**判错
 * （2026-09-23 修，缺陷类AK）。包装对象是引擎里的常态：
 *   · `src` 绑定 = `bridgeDom(content)` = `strWithJsoup(html)` = `new String(html)` + jsoup 方法；
 *   · `java.ajax` 的返回 = `new String(body)` + `.body()/.code()`。
 * 它们的 `typeof` 是 `'object'` 但语义是**字符串**。
 *
 * 实测症状（🎨51漫画「单章目录 0 章」）：源的目录回退分支写
 *     `[{ title: book.name, url: java.getString(".btn-read@href", src) }]`
 * `java.getString(rule, mContent)` → `new AnalyzeRule(env).setContent(mContent)`，
 * `mContent` 是 HTML 的 String 包装 ⇒ 旧实现判成 JSON ⇒ `.btn-read@href` 走 JSONPath ⇒ **恒空**
 * ⇒ 章节 url 为空、标题也为空 ⇒ 被 `if (!ct) continue` 全滤掉 ⇒ 目录 0 章。
 * 引擎内探针实测（`tmp/probe-51-bridge.mts`）：同一份 HTML，
 *   原始字符串 → `"/comic/10944/chapter/28643"` ✅；String 包装 → `""` ❌。
 */
function isJsonValue(v: unknown): boolean {
  if (v == null) return false;
  if (isNode(v) || isElementDescriptor(v)) return false; // `D11`：jsoup 元素描述符是**元素**，不是 JSON
  // 字符串包装（bridgeDom / StrResponse）：**按原文判**，不能按 typeof 判
  if (v instanceof String) return isJsonText(String(v));
  // 元素数组不是 JSON（Legado：Elements.toString() = outerHTML，以 `<` 起头）
  if (Array.isArray(v) && v.some((x) => isNode(x) || isElementDescriptor(x))) return false;
  if (typeof v === 'object') return true;
  if (typeof v === 'string') return isJsonText(v);
  return false;
}

function isJsonText(s: string): boolean {
  const t = s.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function asNodes(v: unknown): Element[] {
  if (process.env['YUEDU_DEBUG_DETAIL']) {
    // #110 取证（覆盖**所有**分支）：打印每个进入 asNodes 的「非 DOM 值」+ 调用栈。
    // 上一版只插在 `<body>` 兜底分支却没命中 ⇒ 说明送进来的字符串**已经带 HTML 标签**，
    // 所以要看全部入口，找出「谁把一个 URL 变成了 `<html>…<body>URL</body></html>`」。
    const t = typeof v;
    const isNodeLike = (t === 'object' || t === 'function') && v !== null && 'nodeType' in (v as object);
    if (v != null && !isNodeLike) {
      let len = -1;
      let head = '';
      try {
        const s = String(v);
        len = s.length;
        head = JSON.stringify(s.slice(0, 80));
      } catch {
        head = '(无法字符串化)';
      }
      // eslint-disable-next-line no-console
      console.log(
        `[asNodes] typeof=${t} len=${len} head=${head} :: ` +
          String(new Error().stack ?? '')
            .split('\n')
            .slice(2, 6)
            .map((l) => l.trim().replace(/^at /, ''))
            .join(' <- '),
      );
    }
  }
  if (v == null) return [];
  // `D11`：jsoup 元素描述符 → 真 DOM 节点（否则会被当 JSON 对象，CSS 规则恒空）
  if (Array.isArray(v)) {
    return v.map((x) => (isNode(x) ? (x as Element) : isElementDescriptor(x) ? descriptorToNode(x) : null)).filter((x): x is Element => x !== null);
  }
  if (isNode(v)) return [v as Element];
  if (isElementDescriptor(v)) return [descriptorToNode(v)];
  if (typeof v === 'string') {
    if (v.trim().startsWith('<') || /<[a-zA-Z]/.test(v)) {
      return [parseHtml(v).root];
    }
    if (process.env['YUEDU_DEBUG_DETAIL']) {
      // #110 取证：把「非 HTML 的普通字符串」包成 `<body>` 再 parse，是引擎里**唯一**会把
      // 一个 URL 变成 `HTMLHtmlElement` 的路径。实测灯读文学（挂账 #110）的 `java.ajax` 实参
      // 就是这种元素（`<html><head></head><body>https://cdn…</body></html>`），随后被
      // `__yueduAbsolute` 当相对路径拼成 `…/book/htmlhead/headbodyhttps://cdn…` → 站点报错。
      // 这里打调用栈，抓出「谁把 URL 传进来的」。
      // eslint-disable-next-line no-console
      console.log(
        `[asNodes-wrap] len=${v.length} head=${JSON.stringify(String(v).slice(0, 90))} :: ` +
          String(new Error().stack ?? '')
            .split('\n')
            .slice(2, 7)
            .map((l) => l.trim().replace(/^at /, ''))
            .join(' <- '),
      );
    }
    return [parseHtml(`<body>${v}</body>`).root];
  }
  // JSON 对象被当成字符串处理（对齐 Jsoup.parse(json.toString())）
  return [parseHtml(String(v)).root];
}

function asJson(v: unknown): unknown {
  if (v == null) return null;
  if (isNode(v)) return null;
  /**
   * ⚠️ **String 包装对象必须先取出字符串**（2026-09-22 修，缺陷类AB）。
   * `java.ajax` 返回的 StrResponse 是 `new String(body)` + `.body()/.code()` 等方法，
   * `typeof` 为 `'object'` —— 旧逻辑 `typeof v === 'object' → return v` 直接原样返回，
   * 于是 `$.content`/`$.title` 之类在**包装对象**上找字段 → 恒空。
   * 实测：① 宜搜小说正文（`<js>…java.ajax()</js>$.content<js>…</js>` 段间传递）、
   * 51漫画目录（`<js>…JSON.stringify(d)</js>$[*]` → 目录 0 章）都是这个形态。
   */
  if (v instanceof String) {
    try {
      return JSON.parse(String(v));
    } catch {
      return String(v);
    }
  }
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  /**
   * `#581` **元素按 Legado `result.toString()` = `outerHtml`**（不是 textContent）。
   *
   * 用户报障 🎨笔趣漫画「正文加载失败：本话图片加载为空」：源 `ruleContent` 是
   * `java.getElements(".rd-article-wr img")` 返回**元素集合**（并就地改 `src`）。
   * 旧实现节点取 `textContent` —— `<img>` 的 textContent 是空串 ⇒ raw 变成 `"\n"`×N
   * （worker 路径则是 `[object Object]`×N）⇒ 正文抽不到 `<img>` ⇒ 0 段。
   * Legado 的 `getString` 走 `result.toString()`，jsoup 元素 = outerHtml；对齐后
   * raw 直接是 `<img src="…">` 串，`extractFromRaw` 的 `IMG_ATTR_RES` 能取到 `data-original`。
   *
   * ⚠️ 元素描述符（worker 跨线程返回的 `{outerHTML,…}`，无 nodeType）必须同款处理，
   * 否则 worker 路径仍会 `String(obj)` → `[object Object]`。
   */
  if (isNode(v)) return (v as Element).outerHTML ?? '';
  if (isElementDescriptor(v)) {
    const html = (v as { outerHTML?: unknown }).outerHTML;
    return typeof html === 'string' ? html : '';
  }
  // JS 段返回数组（Legado getStringList 语义：nextTocUrl 等处常见 URL 数组）→ 逐项连接
  if (Array.isArray(v)) return v.map((x) => asString(x)).join('\n');
  return String(v);
}

/**
 * `$n` 组片段取值（对齐 Legado `makeUpRule` 的组引用分支，`AnalyzeRule.kt:783-792`）：
 *  - `result` 是数组且索引在范围内 ⇒ 该组（`$0` = 整匹配 —— 见 `AnalyzeByRegex.kt:19`）；
 *  - `result` 是数组但索引越界 ⇒ **空串**（上游 `if (this.size > regType)` 不成立时不插入）；
 *  - `result` 不是数组（没有上一级正则结果）⇒ `null`，调用方保留字面量 `$n`
 *    （上游 `?: infoVal.insert(0, ruleParam[index])`）。
 */
function groupRefValue(result: unknown, index: number): string | null {
  if (!Array.isArray(result)) return null;
  if (index >= result.length) return '';
  const v = result[index];
  return v == null ? '' : asString(v);
}

/** `@webjs` 降级留痕（同一脚本只打一次，避免逐章刷屏） */
const webJsWarned = new Set<string>();
function warnWebJsOnce(js: string, why: string): void {
  const key = js.slice(0, 80);
  if (webJsWarned.has(key)) return;
  webJsWarned.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[@webjs degraded] ${why} :: ${js.replace(/\s+/g, ' ').slice(0, 120)}`);
}

/**
 * 实体解码（`getString` 的收尾步骤，对齐 Legado `AnalyzeRule.getString(..., unescape = true)`）。
 *
 * ⚠️ 此前这里是一张 **只有 6 个实体**的小表（amp/lt/gt/quot/apos/nbsp）——
 * 于是 `&emsp;`/`&lrm;`/`&thinsp;`/`&#8230;` 全部原样漏进简介与正文
 * （2026-09-22 用户实测：51漫画简介里出现字面量 `&lrm;`）。
 * 现在直接调 `unescapeHtml4`（commons-text 权威表，253 条命名实体 + 数字实体，**程序化生成**
 * 见 `scripts/gen-html-entities.mjs`），与 Legado 的 `StringEscapeUtils.unescapeHtml4` 同源。
 */
function unescapeHtml(s: string): string {
  return unescapeHtml4(s);
}

/**
 * `#445` `getString` 收尾的实体解码 —— **结果是 HTML 标记时不做**（留给下游渲染层去解）。
 *
 * ## 为什么必须分岔（真站取证：91 吃瓜正文）
 * `<js>` 段用 `org.jsoup` 的 `el.outerHtml()` 产出片段，属性内引号被**正确**序列化成
 * `&quot;`；而收尾**无条件** `unescapeHtml4` 又把它还原成**裸 `"`**
 * ⇒ `data-config="{"live":…}"` 在浏览器侧**属性被第一个内层引号截断**、JSON 取不到
 * （站点的播放器容器因此渲染不出播放器；同一形态会伤到**一切「属性值自带引号」的节点**）。
 *
 * ## 判据与影响面
 *  · **标记形态**（`<tag` / `</tag` / `<!--`）⇒ 原样返回：HTML 是给 WebView/iframe 的，
 *    浏览器**自己会解码实体**；提前解码只会把「结构」当成「文本」破坏掉。
 *  · 其余（标题/简介/URL/数值）⇒ 仍按 Legado `StringEscapeUtils.unescapeHtml4` 语义解码
 *    （`&nbsp;`/`&lrm;`/数字实体…，见 `html-format.ts`）。
 *  · URL 里的 `&amp;` 属「其余」⇒ 仍被解开（Legado 同语义，语料依赖此行为）。
 */
function decodeResultEntities(out: string): string {
  return /<[a-zA-Z!/]/.test(out) ? out : unescapeHtml(out);
}


/**
 * 对任意 result 应用 `##替换##`（对齐 Legado AnalyzeRule.kt:263-271）。
 *
 * Legado 分两支：列表 → **逐项** `item.toString()` 后替换并保持列表；其余 → `result.toString()` 后替换。
 * 此前我们用 `typeof result === 'string'` 做前置条件 → **元素/对象类域的替换被静默跳过**
 * （实测 66书吧 ruleSearch.bookUrl = `##href="//m.qidian.com/chapter/(\\d+)/0/"##{{ho}}/book/$1/###`
 * 取不到书号 → 详情/目录全空）。语料：该形态约 21 处字段规则。
 */

/**
 * Legado 的 `result.toString()`（替换入参，`AnalyzeRule.kt:263-271`）：
 * 字符串 → 自身；列表 → 逐项；**元素的 toString = outerHtml**（不是 textContent）。
 *
 * ⚠️ 不能复用 `asString`：它对节点取 textContent（供 getString 收尾用），
 * 而替换路径靠 outerHtml 才能匹配到 attr（实测 66书吧 bookUrl）。
 */
function legadoToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => legadoToString(x)).join('\n');
  if (isNode(v)) {
    const el = v as Element & { outerHTML?: string };
    return typeof el.outerHTML === 'string' ? el.outerHTML : (el.textContent ?? '');
  }
  return String(v);
}

/**
 * `#673` 规则是否是一个**裸属性名**（`href` / `src` / `title` / `data-id` …）。
 *
 * 用来做「选择器 0 命中 ⇒ 按上游语义当属性名再取一次」的回落判据。故意收窄：
 * 只要出现 CSS/JS/JSONPath/正则的任一记号（`.` `#` `[` `@` `>` `*` 空格 `{` `$` `(`）就**不**回落 ——
 * 宁可漏回落，也不要把真正的选择器/表达式误当属性名（那会静默返回空串）。
 */
/**
 * `#673` 从**任意形态的元素**上取属性——裸属性名回落用。
 *
 * 为什么要三种形态（实测 63书阁 `chapterUrl: "href"`）：
 *   ① 宿主 jsdom 元素 ⇒ `getAttribute()`；
 *   ② **jsoup 桥元素**（`@js:` 列表规则经 worker 回来后 rehydrate 的形态）⇒ 只有 `attr()`；
 *   ③ worker 描述符（`__desc`）⇒ `attrs` 是纯对象。
 * 只写 ① 会让 ②③ 静默返回空串 —— 而空串在引擎里会触发「章节 URL 回落成目录页 URL」，
 * 表现成「目录正常、正文全空」，与规则写错难以区分。
 */
function attrOfNode(n: unknown, name: string): string {
  if (!n || typeof n !== 'object') return '';
  const o = n as {
    getAttribute?: (k: string) => unknown;
    attr?: (k: string) => unknown;
    attrs?: unknown;
    __desc?: { attrs?: unknown };
  };
  if (typeof o.getAttribute === 'function') {
    const v = o.getAttribute(name);
    if (v != null && v !== '') return String(v);
  }
  if (typeof o.attr === 'function') {
    const v = o.attr(name);
    if (v != null && v !== '') return String(v);
  }
  const bag = (o.__desc?.attrs ?? o.attrs) as unknown;
  if (bag && typeof bag === 'object') {
    const v = (bag as Record<string, unknown>)[name];
    if (v != null && v !== '') return String(v);
  }
  /**
   * ④ **当前元素没有该属性时，看「后代里第一个带该属性的元素」**。
   *
   * 实测（63书阁 `chapterList` 选中 `<ul class=mt0>` 的 `<li>`，而 `chapterUrl: "href"`）：
   * 真实结构是 `<li><a href="/142/10484.html">第1章 …</a></li>` —— `href` 在**子元素 `a`** 上。
   * 上游 `getResultLast` 的 `element.attr("href")` 在这种结构下同样为空（App 端这条源
   * 的正文也是空的），但用户要的是「能读」：裸属性名本来就该是「这条记录的链接」，
   * 而「链接在子 `a` 上」是列表项的常见形态（li/tr/div > a）。
   *
   * 只在**当前元素确实没有该属性**时才找后代，且只取页面里第一个（jsoup 的 `[href]`），
   * 不会把「有 href 的 li」误改。
   */
  const q = (o as { querySelector?: (sel: string) => { getAttribute?: (k: string) => unknown } | null }).querySelector;
  if (typeof q === 'function') {
    try {
      const child = q.call(n, `[${name}]`);
      const v = child?.getAttribute?.(name);
      if (v != null && v !== '') return String(v);
    } catch {
      /* 属性名不是合法 CSS 时忽略（如 data:xxx） */
    }
  }
  return '';
}

export function isBareAttrName(rule: string): boolean {
  const t = rule.trim();
  if (!t || t.length > 40) return false;
  if (!/^[a-zA-Z][-a-zA-Z0-9_:]*$/.test(t)) return false;
  // 上游 `getResultLast` 的四个关键字分支（走到这里说明不是它们，纯保险）
  return !/^(text|html|all|ownText|textNodes)$/.test(t);
}

function applyCleanResult(result: unknown, clean: { replaceRegex: string; replacement: string; replaceFirst: boolean }): unknown {
  if (Array.isArray(result)) return result.map((x) => applyClean(legadoToString(x), clean));
  return applyClean(legadoToString(result), clean);
}
function applyClean(s: string, clean: { replaceRegex: string; replacement: string; replaceFirst: boolean }): string {  if (!clean.replaceRegex) return s;
  let regex: RegExp;
  try {
    regex = compileKotlinRegex(clean.replaceRegex);
  } catch {
    return s;
  }
  // 清洗需替换全部匹配（对齐 Legado replaceAll）；replaceFirst 才只替换首个
  const globalRegex = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
  if (clean.replaceFirst) {
    const m = regex.exec(s);
    if (!m) return '';
    return m[0].replace(regex, clean.replacement);
  }
  return s.replace(globalRegex, clean.replacement);
}

/** {{expr}} 内容是否本身是一条规则（对齐 Legado SourceRule.isRule:834-839）
 *  —— 实现已移到 rule-analyzer.ts（那边切段时也要用它，不能反向 import 本文件），此处仅再导出。 */
export { isRuleExpr };

/** Elements API 桥：给 jsdom Element 挂 Legado JS 常用方法（attr/select/text/…）。
 *  直接在元素对象上扩展（jsdom Element 可扩展）；列表时方法作用于全部元素。 */
/**
 * `#673` **任意节点**的桥（元素 / 文本 / 注释都行）——给 `nextSibling()` 这类返回 `Node` 的 API 用。
 *
 * 为什么需要（用户实测 媚色MM `RULE_PARSE@parse`）：
 * ```js
 * var viewCount = result.selectFirst("i.fa-eye");
 * viewCount = viewCount != null ? viewCount.nextSibling().text().trim() : "0";
 * ```
 * jsoup 里 `Element.nextSibling()` 返回的是 **`Node`**（源码 `<i class="fa-eye"></i> 1234` 的下一个
 * 兄弟是 **TextNode**）。而本仓桥此前**根本没有 `nextSibling`**（core 全域 0 处实现）⇒
 * `viewCount.nextSibling is not a function` ⇒ 详情 `RULE_PARSE@parse`。
 *
 * 文本节点也要能被 `.text()` —— jsoup `TextNode.text()` 是存在的（返回 coreValue，不 trim），
 * 源脚本普遍再自己 `.trim()`。这里照抄这个语义：`text()` 给原文，不做 trim。
 */
function bridgeAnyNode(n: unknown): unknown {
  if (!n || typeof n !== 'object') return n == null ? null : String(n);
  const nt = (n as { nodeType?: number }).nodeType;
  if (nt === 1) return bridgeDom(n);
  const nodeValue = String((n as { nodeValue?: string | null }).nodeValue ?? '');
  const self: Record<string, unknown> = {
    nodeType: nt ?? 0,
    nodeValue,
    /** jsoup `TextNode.text()` / `Node.toString()` 的等价物 */
    text: () => nodeValue,
    textNodes: () => [],
    ownText: () => nodeValue,
    html: () => nodeValue,
    outerHtml: () => nodeValue,
    toString: () => nodeValue,
    val: () => nodeValue,
    data: () => nodeValue,
    attr: () => '',
    hasAttr: () => false,
    child: () => null,
    children: () => [],
    childNodes: () => [],
    select: () => [],
    selectFirst: () => null,
    size: () => 0,
    nextSibling: () => bridgeAnyNode((n as { nextSibling?: unknown }).nextSibling),
    previousSibling: () => bridgeAnyNode((n as { previousSibling?: unknown }).previousSibling),
    parent: () => bridgeAnyNode((n as { parentNode?: unknown }).parentNode),
    parentNode: () => bridgeAnyNode((n as { parentNode?: unknown }).parentNode),
  };
  return self;
}

function bridgeDom(v: unknown): unknown {
  // 对齐 Legado：JS 段的字符串 result 需「双重人格」——
  //  ①当字符串用（result.replace/match/split——String 原型方法）
  //  ②当 Elements 用（result.toArray()/select()/attr()——jsoup API）
  // 实现：String 包装 + defineProperty 挂 jsoup 方法（内部 Elements 按需 parse）
  const raw = v instanceof String ? String(v) : v;
  /**
   * `#360` **JSON 文本不包 String 包装，原样给字符串**。
   *
   * ★ 反例（实测，苹果MCS「暂无播放源」的根因）：本仓为了给字符串挂 jsoup API
   *   （`result.select() / .attr() / .toArray()`）一律 `new String(html)` ⇒
   *   **`typeof result === 'object'`**。而 Rhino 里 `bindings["result"] = content`
   *   （`AnalyzeRule.kt:903`）是**真字符串** ⇒ `typeof result === 'string'`。
   *   源脚本 `if (typeof result === 'object') d = result; else d = JSON.parse(result).list[0]`
   *   于是**永远走 object 分支**，把 API 信封（`{code,msg,list:[…]}`）当成条目对象
   *   ⇒ `d.vod_play_url` 为空 ⇒ 脚本自己吐「暂无播放源」。App 端正常、我们不正常，
   *   差别就在 `typeof`。
   *
   * ★ 为什么只对 JSON 文本解包：jsoup API 是 **HTML 的语义**，在 `{"a":1}` 上挂
   *   `select()` 本身就是错的（`strWithJsoup` 注释里 `parseHtml('{"a":1}')` 那个坑
   *   是同一件事的另一半）。HTML 文本保持原行为，不动已验证的回归面。
   */
  if (typeof raw === 'string') return isJsonText(raw) ? raw : strWithJsoup(raw);
  const val =
    Array.isArray(raw) && !raw.some((x) => isNode(x))
      ? (raw as unknown[]).every((x) => typeof x === 'string')
        ? /**
         * ⚠️ **字符串数组不能 parseHtml 成 DOM**（2026-09-24 修；挂账 `#110` 的根因）。
         *
         * 此前这里写的是 `raw.map((x) => parseHtml(String(x)).root)` —— 把
         * `['https://cdn.zhongyue001.com/xxx.js']` 变成 `[<html><head></head><body>https://…</body></html>]`。
         * 而 `bridgeList()` 是**就地改写**（target 往往就是 `els[0]`），于是脚本拿到的 `result`
         * 就是那个**元素**：`String(元素)` = outerHTML，再经 `__yueduPrepareUrl` 的页码替换
         * （`<html><head></head><body>` → `htmlhead/headbody`）与绝对化拼前缀，最终请求
         * `…/book/htmlhead/headbodyhttps://cdn…` ⇒ 站点返回空 ⇒ 「详情通了但目录 0 章」。
         * 实测 TRACE：`java.ajax` 实参 `ctor=HTMLHtmlElement len=138`，调用栈落在
         * `_AnalyzeRule.getElementsInner`（灯读文学的 `ruleBookInfo.init` 段）。
         *
         * Legado 语义：`List<String>` 就是**字符串列表**（脚本按数组用），
         * **只有真正的 `Elements`/`Element` 才 parse**（下一次按需桥接）。
         */
        (raw as unknown[]).map((x) => String(x ?? ''))
        : raw // 元素是对象？（JSON 数组）→ 保留数组，走下面的 Map/List 方法
      : raw;
  const nodes = Array.isArray(val) ? val.filter((x) => isNode(x)) : isNode(val) ? [val as Element] : [];
  if (nodes.length === 0) {
    /**
     * ⚠️ **JSON 对象数组必须保留内容**（2026-09-22 修，缺陷类V）。
     *
     * 此前对「非空但不是 DOM 节点」的数组无条件 `bridgeList([])` —— 把 `[{id,…},{id,…}]`
     * 直接换成**空列表**（`length` 为 undefined、`[0]` 为 undefined、`size()` 返回 0）。
     *
     * 症状（用户可见）：🎨快看漫画的目录规则
     *   `<js>java.setContent(cache.get('kkmh')); result = java.getElements('$.data[*].comicList[*]')</js>`
     * 永远取到 0 条 → **「详情通了但目录 0 章」**。实测该源 NUXT 里 `data[0].comicList` 有 26 条，
     * 而 `java.getElements(...)` 拿到的是空列表（引擎内探针实测 `innerLen: 2` → `bridged: isArr=false, size=0`）。
     *
     * 对齐 Legado：`Mode.Json -> getAnalyzeByJSonPath(result).getList(rule)`
     * （`AnalyzeRule.kt:440`）把 GSON 对象列表**原样**交给脚本 —— JSONPath 这一支里
     * 没有「DOM 元素」的语义，不能拿 jsoup 的 Elements 桥接去套。
     */
    if (Array.isArray(val)) {
      const list = val as unknown[];
      return attachJsonMapMethods(list.length > 0 ? list : bridgeList([]));
    }
    // 普通对象（JSON 内容）：Legado 的 result 是 GSON LinkedTreeMap，源脚本会用
    // `result.get("k")` / `size()` / `keySet()` 等 **Java Map API**（实测点众阅读 kind 规则）
    // → 挂非枚举的 Map 方法；worker 侧用同一份注入源码再挂一次。
    return attachJsonMapMethods(v);
  }
  /**
   * ⚠️ **多元素结果必须是「真数组」**（2026-09-25 修；🎨🔞禁漫天堂「目录只剩一章」的根因）。
   *
   * 此前这里无条件 `bridgeList(nodes)`，而 `bridgeList()` 把 jsoup 列表方法**挂在 `arr[0]` 上并返回它**
   * —— 于是脚本拿到的 `result` 是**第 0 个元素**（`result.size()` 却返回真实条数，两者自相矛盾）。
   * 目录规则几乎都以 `<js> … result </js>` 结尾（原样把上一段结果交下去），于是
   * **N 个章节元素 → 1 个**：实测 `/album/1232836` 有 73 话，引擎只出 1 章且标题恒为「第1话」。
   *
   * Legado 语义（`AnalyzeByJSoup.getElements`）：每段产出的都是 `org.jsoup.select.Elements`
   * （`ArrayList<Element>`，**真数组**），`bindings["result"]` 就是这个列表 ⇒ 原样返回仍是 N 项。
   *
   * 单元素走原路径（`bridgeList`）保持 jsoup `Element` 语义不变 —— 降回归面；
   * 多元素才用 `bridgeElementList`（真数组 + Elements 方法 + `toString()` 拼全部 outerHTML）。
   */
  if (nodes.length === 1) return bridgeList(nodes as Element[]);
  return bridgeElementList(nodes as Element[]);
}

/** 从原型链上取原生实现，**绕过同名自有属性**。
 *
 *  为什么需要：`bridgeList` 是**就地改写**（`target` 往往就是 `els[0]` 这个 jsdom 节点），
 *  一旦把 `remove` 这类原生方法名写成自有的 jsoup 语义函数，闭包里再 `e.remove()`
 *  调到的就是自己 → 无限递归（栈溢出 / 被 catch 吞成静默 no-op）。
 *  所以桥接里凡是**要调用同名原生能力**的地方，都必须走原型链取原始实现。 */
function nativeProtoMethod(el: Element, name: string): ((...a: unknown[]) => unknown) | undefined {
  // ⚠️ **从原型开始找，跳过自有属性**：桥接就在元素自身上写同名函数，
  // 若从 `el` 自身开始找，拿到的还是我们的 jsoup 函数 → 依旧自递归（这个坑踩过一次）。
  let p: object | null = Object.getPrototypeOf(el) as object | null;
  while (p) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d && typeof d.value === 'function') return d.value as (...a: unknown[]) => unknown;
    p = Object.getPrototypeOf(p) as object | null;
  }
  return undefined;
}

/**
 * 给「元素 / 元素列表 / 字符串」桥接 jsoup API（Legado `Elements` / `Element` 常用子集）。
 *
 * 三个入口（`strWithJsoup` / `bridgeList` / `bridgeElementList`）共用这一份实现，
 * 避免方法面三处漂移。方法集合按**语料实测频次**选取（`.get(` 262、`.select(` 163、`.attr(` 100、
 * `.text(` 83、`.size(` 74、`.first(` 33、`.remove(` 32…）。
 *
 * ⚠️ **只挂语料真的用得上的名字，且不得覆盖原生 DOM 属性**（2026-09-17 实测教训）：
 * 桥接是**就地改写节点对象**，所以把原生名（`children`/`tagName`/`getElementsByTagName`）
 * 覆盖成 jsoup 函数后，① 闭包内再调同名原生方法 → 自递归 → `Maximum call stack size exceeded`；
 * ② 其它子系统（`css.ts` 的 `tag.`/`children` 分支）拿到同一个节点时读到的是**函数**而不是集合
 * → 静默空值。这三个名字语料使用次数均为 **0**，已删除；`remove` 保留但走 `nativeProtoMethod`。
 */
function attachJsoupMethods<T extends Record<string, unknown>>(
  target: T,
  elsArg: Element[] | (() => Element[]),
): T {
  /**
   * 元素源**惰性化**（2026-09-21 修，缺陷类 R）。
   *
   * 为什么必须惰性：字符串 result 的桥接（`strWithJsoup`）此前**立刻** `parseHtml(html)`，
   * 而 jsdom 每次 parse 会**常驻约 1MB**（`tmp/probe-leak5.mts`：强 GC 后仍留存 959KB/次）。
   * `bindings()` 对**每个 JS 段**的 result 都要桥接 → 每次求值泄漏 ~2MB（`$`/`result` 各一次）。
   * 实测后果：📂书文小说（1500+ 章、目录 16 页）在详情阶段把 2GB 堆打爆
   * （`Reached heap limit`）；而绝大多数脚本只把 result 当**字符串**用（replace/match/indexOf），
   * 根本用不到 jsoup 方法 —— 解析纯属浪费 + 泄漏。
   * 现改为**首次真正调用 jsoup 方法时才解析**，且同一包装内只解析一次。
   */
  let cached: Element[] | null = null;
  const els: () => Element[] =
    typeof elsArg === 'function' ? () => (cached ??= elsArg()) : () => elsArg;
  const def = (k: string | symbol, fn: (...a: unknown[]) => unknown) => {
    try {
      Object.defineProperty(target, k, { value: fn, writable: true, configurable: true });
    } catch {
      /* 只读属性（如 Element.tagName）跳过 */
    }
  };
  // jsoup 专有伪类（:eq/:gt/:lt/:contains/:matches）由兼容层接管（nwsapi 对 :contains 恒不匹配）
  const q = (sel: unknown): Element[] => selectJsoupFrom(els(), String(sel));
  /**
   * `#531` **`attr` / `text` 的写形态**（jsoup `Element.attr(k,v)` / `Element.text(String)`）。
   *
   * 为什么必须补：这里是「`result` / `$` 字符串包装 + 桥接出的 jsdom 节点」这一面，
   * 此前只实现了**读**形态 ⇒ 源脚本的写操作被**静默丢弃**。实测（找书啦·求书互助 `ruleToc`）：
   * 阶段一 `r.attr('data-rid', …) / r.attr('data-no', …)` 全被丢掉，阶段二 `chapterUrl`
   * 的 `result.attr('data-rid')` 恒为空 ⇒ 章节目录每个 URL 都退化成 `…#reply-`。
   * 与 `#528` 给 `JsoupDom` 侧补的写形态是同一个 API 面（本文件是**第三处**实现，故必须同补）。
   */
  def('attr', (n: unknown, v?: unknown) => {
    if (v === undefined) return els()[0]?.getAttribute(String(n)) ?? '';
    markDomTouched(); // 改了 DOM ⇒ 本请求内停用共享（与 removeAttr/addClass 同一条纪律）
    for (const e of els()) e.setAttribute(String(n), String(v));
    return target;
  });
  def('text', (v?: unknown) => {
    if (v === undefined) return els().map((e) => (e.textContent ?? '').trim()).join('\n');
    markDomTouched();
    for (const e of els()) e.textContent = String(v);
    return target;
  });
  def('eachText', () => els().map((e) => (e.textContent ?? '').trim()));
  def('html', () => els()[0]?.innerHTML ?? '');
  /**
   * `#646` jsoup `Elements.outerHtml()` = **遍历全部元素依次拼接**（上游 `Elements.outerHtml()`：
   * `for (Element el : this) accum.append(el.outerHtml());`，无分隔符）。
   *
   * 旧实现 `els()[0]?.outerHTML` 只给第一个 ⇒ 源规则最后一句 `String(clean.outerHtml())`
   * 把整章截成一段。实测 搬山人小说网：规则内部 `段落=135`，引擎输出 **1 段 / 51 字**。
   * worker 侧同一处（`worker-pool.ts` 的 `def('outerHtml')`）同步修。
   *
   * ⚠️ 同族的 `html()` 上游也是拼接全部 innerHtml；暂未改（本轮只按实测证据改 outerHtml），
   *    若后续发现「Elements.html() 只给第一个」的实际故障，按同一判据补。
   */
  def('outerHtml', () => els().map((e) => e.outerHTML ?? '').join(''));
  def('data', (k: unknown) => els()[0]?.getAttribute(`data-${String(k)}`) ?? '');
  def('select', (sel: unknown) => bridgeDom(q(sel)));
  def('selectFirst', (sel: unknown) => bridgeDom(q(sel)[0]));
  def('get', (i: unknown) => bridgeDom(els()[Number(i)]));
  def('eq', (i: unknown) => bridgeDom(els()[Number(i)]));
  /**
   * `#531` jsoup `Element.clone()` / `child(index)` —— 与 `#528` 在 `JsoupDom` 侧补的两条**同名同义**。
   *
   * `clone()`：深拷贝出**独立元素**（不插回父树）—— 找书啦 `ruleToc` 的净化套路就是
   * 「`h1.clone()` → 在**副本**上删徽标 → 读副本文本」（不能删原节点）。
   * `child(i)`：第 `i` 个**子元素**（越界 null）—— `Jsoup.parseBodyFragment(...).body().child(0)`。
   *
   * 为什么这条必须补：本面此前没有这两条 ⇒ 找书啦整条目录规则在 L1 直接抛
   * `h1.clone is not a function`（目录 0 章）。worker 路径同面见 worker-pool.ts 的 `mkList`。
   */
  def('clone', () => {
    const e0 = els()[0];
    return e0 ? bridgeDom(e0.cloneNode(true)) : null;
  });
  def('child', (i: unknown) => {
    const e0 = els()[0];
    if (!e0) return null;
    // ⚠️ `children` 是**子元素**集合（不含文本节点），越界返回 null（jsoup 语义）
    const c = (e0.children as HTMLCollection | undefined)?.[Number(i)] ?? null;
    return c ? bridgeDom(c) : null;
  });
  /**
   * `#673` **jsoup 的 Node 导航面**（`nextSibling` / `previousSibling` / `parent` / …）。
   *
   * 这三类此前**一条都没有**（core 全域 grep `nextSibling` 为 0 处），而源脚本用得很自然：
   * ```js
   * result.selectFirst("i.fa-eye").nextSibling().text().trim()   // 媚色MM 的 viewCount
   * ```
   * 报错形如 `viewCount.nextSibling is not a function` ⇒ 详情整段 `RULE_PARSE@parse`。
   *
   * 语义照 jsoup：
   *   · `nextSibling()` / `previousSibling()` 返回 **Node**（可能是文本/注释节点 ⇒ 走 bridgeAnyNode）；
   *   · `nextElementSibling()` / `previousElementSibling()` 只取**元素**（跳过文本节点）；
   *   · `parent()` 返回父节点（Element）。
   * 注意：`siblingElements()` 是 jsoup `Elements`（真数组 + 列表方法），走 bridgeDom 的数组分支。
   */
  const firstEl = (): Element | null => els()[0] ?? null;
  /**
   * ★ **必须走原型链读原生 getter**，不能直接 `el.nextSibling`。
   *
   * `bridgeList()` 的 target **就是 `els()[0]` 那个元素本身**，而下面 `def('nextSibling', …)`
   * 会在它身上 `defineProperty` 覆盖原生 getter。于是函数体里再写 `el.nextSibling` 读到的是
   * **我们刚定义的函数自己**（不是兄弟节点）⇒ `bridgeAnyNode(函数)` ⇒ `typeof !== 'object'`
   * ⇒ 返回 `String(fn)` ⇒ 源脚本拿到一串 `"() => bridgeAnyNode("` 文本，
   * 而 `.text()` 自然 `is not a function`（实测探针：`sib=string`、`sibStr=() => bridgeAnyNode(`）。
   */
  const nativeProp = (el: Element | null, prop: string): unknown => {
    if (!el) return null;
    let o: object | null = Object.getPrototypeOf(el) as object | null;
    while (o) {
      const d = Object.getOwnPropertyDescriptor(o, prop);
      if (d && typeof d.get === 'function') return d.get.call(el);
      if (d && 'value' in d) return d.value;
      o = Object.getPrototypeOf(o) as object | null;
    }
    return null;
  };
  def('nextSibling', () => bridgeAnyNode(nativeProp(firstEl(), 'nextSibling')));
  def('previousSibling', () => bridgeAnyNode(nativeProp(firstEl(), 'previousSibling')));
  def('nextElementSibling', () => {
    let n = nativeProp(firstEl(), 'nextSibling') as { nodeType?: number; nextSibling?: unknown } | null;
    let guard = 0;
    while (n && n.nodeType !== 1 && guard++ < 200) n = nativeProp(n as unknown as Element, 'nextSibling') as typeof n;
    return n && n.nodeType === 1 ? bridgeDom(n) : null;
  });
  def('previousElementSibling', () => {
    let n = nativeProp(firstEl(), 'previousSibling') as { nodeType?: number; previousSibling?: unknown } | null;
    let guard = 0;
    while (n && n.nodeType !== 1 && guard++ < 200) n = nativeProp(n as unknown as Element, 'previousSibling') as typeof n;
    return n && n.nodeType === 1 ? bridgeDom(n) : null;
  });
  def('parent', () => {
    const p = nativeProp(firstEl(), 'parentElement') as Element | null;
    return p ? bridgeDom(p) : null;
  });
  def('parentNode', () => {
    const p = nativeProp(firstEl(), 'parentNode');
    return p ? bridgeAnyNode(p) : null;
  });
  def('siblingElements', () => {
    const e0 = firstEl();
    if (!e0?.parentElement) return bridgeDom([]);
    return bridgeDom([...e0.parentElement.children].filter((c) => c !== e0));
  });
  def('size', () => els().length);
  def('isEmpty', () => els().length === 0);
  def('parents', () => bridgeDom(els().map((e) => e.parentElement).filter((e): e is HTMLElement => !!e)));
  def('next', () => bridgeDom(els().map((e) => e.nextElementSibling).filter((e): e is Element => !!e)));
  def('prev', () => bridgeDom(els().map((e) => e.previousElementSibling).filter((e): e is Element => !!e)));
  def('toArray', () => els().map((e) => bridgeDom(e)));
  def('first', () => bridgeDom(els()[0]));
  def('last', () => bridgeDom(els()[els().length - 1]));
  def('hasClass', (c: unknown) => !!els()[0]?.classList.contains(String(c)));
  def('remove', () => {
    markDomTouched(); // 动过 DOM → 本请求内停用共享（见 markDomTouched 注释）
    for (const e of els()) {
      try {
        const rm = nativeProtoMethod(e, 'remove');
        if (rm) rm.call(e);
      } catch {
        /* 已脱离文档的节点 remove 可能抛错 —— 忽略 */
      }
    }
    return target;
  });
  def('removeAttr', (n: unknown) => {
    markDomTouched();
    for (const e of els()) e.removeAttribute(String(n));
    return target;
  });
  def('addClass', (c: unknown) => {
    markDomTouched();
    for (const e of els()) e.classList.add(String(c));
    return target;
  });
  def('removeClass', (c: unknown) => {
    markDomTouched();
    for (const e of els()) e.classList.remove(String(c));
    return target;
  });
  // Legado 语义：String(element) = outerHTML（源脚本 `String(e).includes('xxx')` 过滤依赖）
  def('toString', () => els()[0]?.outerHTML ?? '');
  def(Symbol.toPrimitive as unknown as string, () => els()[0]?.outerHTML ?? '');
  return target;
}

/** 字符串 + jsoup API 双人格包装（replace/match/split 走 String 原型；toArray/select 走挂载方法） */
function strWithJsoup(html: string, els?: Element[]): unknown {
  // ⚠️ 传 **thunk**（不是数组）：字符串场景下 jsoup 方法常常用不到，
  //    提前 parseHtml 会每次求值泄漏 ~1MB（见 attachJsoupMethods 的惰性说明）。
  const w = attachJsoupMethods(
    new String(html) as unknown as Record<string, unknown>,
    els ? () => els : () => [parseHtml(html).root],
  );
  // ⚠️ **字符串人格必须还原**（2026-09-17 实测，三个源同一根因）：
  // `attachJsoupMethods` 里统一写的是**元素语义**（`toString` = `els[0].outerHTML`），
  // 但字符串包装为了提供 jsoup 方法会把这段文本 `parseHtml()` 一遍 →
  // `String(包装)` 就变成 `parseHtml('{"a":1}').root.outerHTML`
  // = `<html><head></head><body>{"a":1}</body></html>`。
  // 后果：源脚本 `JSON.parse(result)` 拿到 HTML（枫叶音乐盒/绿柠小说报
  // `Unexpected token '<'`）、`&&` 拼接与模板串把纯文本包成整页 HTML（腾讯漫画章节名）。
  // Legado 语义：**字符串就是字符串**；只有 Element / Elements 的 toString() 才是 outerHTML。
  const asString = () => html;
  for (const k of ['toString', 'valueOf'] as const) {
    try {
      Object.defineProperty(w, k, { value: asString, writable: true, configurable: true });
    } catch {
      /* 忽略 */
    }
  }
  try {
    Object.defineProperty(w, Symbol.toPrimitive, { value: asString, writable: true, configurable: true });
  } catch {
    /* 忽略 */
  }
  return w;
}

/** 给元素列表（可为空）挂 jsoup 风格 API，返回首个元素（方法作用于整列表） */
function bridgeList(arr: Element[]): unknown {
  const primary = (arr[0] ?? ({} as unknown)) as unknown as Record<string, unknown>;
  // ⚠️ **不得「已桥接过就早返回」**（2026-09-17 实测）：jsoup 方法把 `els` 捕获进闭包，
  // 而同一个节点既可能代表「单个元素」也可能代表「元素列表的首元素」。早返回会让
  // `doc.select('p')` 拿到**上一次**那批元素：实测 `remove()` 之后
  // `doc.select('p').size()` 仍返回 2（闭包里的旧数组），而同一份 DOM 上
  // `doc.select('p').toArray()` 只有 1 个 —— 两种说法不一致，源脚本的过滤/删除逻辑静默走错。
  // 每次桥接都用当前 `els` 重新定义（`configurable: true`，覆盖安全）。
  // 空列表：primary 是新建空对象——直接挂方法（下游 .toArray()/.size() 返回空语义）
  // 非空但非 Node（不应发生）：原样返回
  if (arr.length > 0 && typeof (primary as unknown as { nodeType?: number }).nodeType !== 'number') return primary;
  return attachJsoupMethods(primary, arr);
}

/**
 * Legado java.getElement 语义：返回**全部元素**的可迭代列表（源脚本 Array.from(java.getElement(...))
 * 依赖 iterable），同时挂 Elements 方法（attr/text/html/size/…）。
 */
function bridgeElementList(arr: Element[]): unknown {
  const list = arr.map((e) => bridgeDom(e)) as unknown as Record<string, unknown> & unknown[];
  attachJsoupMethods(list, arr);
  // jsoup `Elements.toString()` = 全部元素的 outerHTML 拼接（与单元素的「首个 outerHTML」不同）
  try {
    Object.defineProperty(list, 'toString', {
      value: () => arr.map((e) => e.outerHTML ?? '').join(''),
      writable: true,
      configurable: true,
    });
  } catch {
    /* 忽略 */
  }
  return list;
}

/**
 * 实体桩：Legado 里 book/chapter/rssArticle 是实体对象，源脚本会 book.getVariable()、
 * chapter.title 等混合使用（当字段读、当函数调）。给「可调用 + 可无限下钻」的空桩：
 * 任何属性访问返回嵌套桩、任何调用返回空串——不炸规则，语义为空。
 * `real` 里的字段优先（引擎在 detail/toc/content 阶段注入 bookUrl/name 等——
 * 源脚本 `book.bookUrl + path` 拼章节链接依赖真实值，空串会把链接拼错）。
 */
function entityStub(real?: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(real ?? {}) };
  const nest = (): unknown => {
    const f = function () {
      return '';
    } as unknown as Record<string, unknown>;
    return new Proxy(f, {
      get: (_t, prop: string | symbol) => {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined; // 防 thenable 误判
        if (prop === 'toString' || prop === (Symbol.toPrimitive as unknown) || prop === 'valueOf') return () => '';
        return nest() as Record<string, unknown>;
      },
      apply: () => '',
    });
  };
  const top = nest() as Record<string, unknown>;
  return new Proxy(top, {
    get: (t, prop: string | symbol) => {
      if (typeof prop !== 'symbol') {
        if (prop in data) return data[prop];
        /**
         * `#682` **JavaBean getter 兜底**：Legado 的实体（Book / BookChapter / BookSource / RssArticle）
         * 都是 Kotlin data class，JVM 为每个 `var` 生成 `getXxx()`，源脚本可以 `source.getBookSourceUrl()`、
         * `book.getBookUrl()` 这样调。这里把「有对应字段」的 `getXxx()` 变成**返回该字段的函数**；
         * 没有对应字段的（`book.getVariable()` 之类）仍回可调用空桩（返回空串，不炸规则）。
         */
        const gm = /^get([A-Z][A-Za-z0-9]*)$/.exec(prop);
        if (gm) {
          const name = (gm[1] ?? '').charAt(0).toLowerCase() + (gm[1] ?? '').slice(1);
          if (name in data) {
            const v = data[name];
            return () => v;
          }
        }
      }
      return (t as Record<string, unknown>)[prop as string];
    },
    // Legado 里 book/source 是**活对象**：JS 赋值会真正落到实体上（如 preUpdateJs 的
    // `book.bookUrl = ...` 换域名、`book.canUpdate = false`）。写回 real 供引擎后续阶段读取。
    set: (_t, prop: string | symbol, value: unknown) => {
      if (typeof prop === 'symbol') return true;
      data[prop] = value;
      if (real) real[prop] = value;
      return true;
    },
  });
}

/**
 * env 级「**当前求值实例**」槽（Symbol 避免与源脚本的字段撞名）。
 *
 * 为什么必须有它 —— Legado 每次 `evalJS` 都把 `java` 绑成**当前那个 AnalyzeRule 实例**
 * （`bindings["java"] = this`，`AnalyzeRule.kt:895`），所以源脚本里
 * `java.setContent(x); … ; java.getElements(rule)` 的两次调用**落在同一个实例**上，
 * setContent 设的文档就是 getElements 读的文档。
 *
 * 我们的 `java` 桥是 env 级共享的（Proxy fallback 查 `env.javaExtra`，见 `makeJavaStub`），
 * 而同一个 env 里会构造**多个** AnalyzeRule（字段求值、`java.getString(rule, content)` 的临时 ar…），
 * 构造时的 `Object.assign` 让「最后一个构造的」赢 —— 于是脚本里的 `setContent` 与 `getElements`
 * 可能落在**不同实例**，`setContent` 形同没设。
 *
 * 实测（🎨快看漫画目录规则，2026-09-22）：
 *   `<js>java.setContent(cache.get('kkmh')); result = java.getElements('$.data[*].comicList[*]')</js>`
 * 无论缓存内容多完整（`cache.get('kkmh')` 实测返回 20405 字符的 NUXT JSON，
 * 手工 `JSON.parse` 能得到 `data[0].comicList` 26 条），`java.getElements` 恒为空列表
 * —— 因为它基于另一个实例的 content 求值。用户可见症状 = **「详情通了但目录 0 章」**。
 *
 * 做法：每次求值（`getString/syncGetString/…` 六个入口）进入时把本实例写进槽、退出时恢复，
 * `ruleApi` 的方法改成**调用时**从槽取实例（取不到才回落到构造它的那个实例）。
 */
const CURRENT_RULE = Symbol('yuedu.currentAnalyzeRule');
type EnvWithCurrentRule = AnalyzeEnv & { [CURRENT_RULE]?: AnalyzeRule };

/**
 * env 级「**同一次请求内已解析的 DOM**」共享槽（Symbol 避免与源脚本字段撞名）。
 *
 * 为什么必须有（2026-09-24，挂账 `#93` 核查的结论）：
 * 一次 `search()/detail()/content()` 调用里会构造**很多** AnalyzeRule，而
 * `java.getString(rule, mContent)` / `java.getElements(rule, mContent)` 这类「带 mContent 的调用」
 * 每次都 `new AnalyzeRule(env).setContent(mContent)` —— **同一份页面文本被反复解析**。
 *
 * 实测（`tmp/probe-93-hotspot.mts` + `YUEDU_TRACE_PARSE_HTML=1`，24 源）：
 *   231 次 parseHtml 里 **42 次是同一份内容**（sha1 相同），且重复的多是**整页**
 *   ⇒ **重复解析的输入字节占全部解析字节的 46%**；而 DOM 解析本身占进程 CPU **40.7%**。
 *   最极端的：一份 5787 字符的搜索结果页在**一个源的一次请求**里被解析了 **8 次**。
 *
 * 这与架构红线 R1「一次解析只产出一棵 DOM 树」相悖，所以修在缓存层而不是换解析器
 * （`JSDOM.fragment()` 实测快 23~43×，但**语义不等价**：无 `documentElement`、文档级 XPath 失效、
 *  head/body 会被压平 ⇒ 只能覆盖「短串包装且不依赖文档级能力」这一小撮，见 `tmp/probe-93-fragment.mts`）。
 *
 * ⚠️ **安全阀**（源脚本动过 DOM 就退回老行为）见 `markDomTouched()`。
 * ⚠️ **生命周期** = env 的生命周期 = 一次引擎调用（`makeEnv` 每次新建 env），请求结束即释放。
 */
const SHARED_DOM = Symbol('yuedu.sharedDom');
/** 源脚本动过 DOM ⇒ 本请求内停用共享（否则改过的树会被下一个实例看到） */
const DOM_TOUCHED = Symbol('yuedu.domTouched');
interface SharedDomEntry {
  src: string;
  nodes: Element[];
}
type EnvWithSharedDom = AnalyzeEnv & {
  [SHARED_DOM]?: SharedDomEntry[];
  [DOM_TOUCHED]?: boolean;
};

/**
 * 当前正在求值的 env（仅 `withCurrent*` 期间有效）。
 *
 * 为什么需要：DOM 桥的**变更方法**（`remove/removeAttr/addClass/removeClass`）定义在
 * `attachJsoupMethods()` 里，那里拿不到 env；而变更一定会发生在**规则求值期间**，
 * 所以用这个槽做「求值期当前 env」指针（`CURRENT_RULE` 是存在 env 上的，反查不到）。
 */
let ACTIVE_ENV: EnvWithSharedDom | null = null;

/**
 * 源脚本改了 DOM → **本请求内不再共享 DOM**，退回「谁用谁解析」（= 改动前行为）。
 *
 * 为什么必须这样兜底：共享一份 DOM 会让「A 实例删掉的节点」对 B 实例也消失，
 * 而 Legado 的语义是每个 `setContent` 各自一棵树。语料里只有 **6 个源**
 * 用到 `remove()/removeAttr()`（AO3镜像/悦读小说/晋江/就去看网/光遇聚合/七猫四合一），
 * 让它们完全走老路径，代价可忽略、正确性有保障。
 */
function markDomTouched(): void {
  if (!ACTIVE_ENV) return;
  ACTIVE_ENV[DOM_TOUCHED] = true;
  ACTIVE_ENV[SHARED_DOM] = [];
}

/** 共享槽容量（条目数）。默认 2：够覆盖「同一页面被多实例反复解析」，又不会多份大 DOM 常驻。 */
function sharedDomMaxEntries(): number {
  const n = Number(process.env.YUEDU_DOM_CACHE_MAX ?? 2);
  return Number.isFinite(n) && n > 0 ? Math.min(8, Math.floor(n)) : 2;
}

/**
 * 共享槽单条上限（字符数）。默认 1MB。
 *
 * 为什么要有上限：jsdom 的 DOM 体积约为 HTML 的 **90×**（6.19MB 页面 ⇒ 常驻约 530MB，见 `#115`）。
 * 共享会把这条 DOM 的寿命**延长到请求结束**，对巨型页面来说得不偿失（实测重复的多在 6~73KB，
 * 1MB 已完全覆盖）。要放宽就设 `YUEDU_DOM_CACHE_MAX_CHARS`。
 */
function sharedDomMaxChars(): number {
  const n = Number(process.env.YUEDU_DOM_CACHE_MAX_CHARS ?? 1_048_576);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1_048_576;
}

/**
 * 共享槽的**键**：只对「文本型」内容生效，并区分**原始字符串**与 **String 包装对象**。
 *
 * 为什么要区分子类型：`asNodes()` 对两者走**不同分支** ——
 *   · 原始字符串 → HTML 形态走 `parseHtml(v)`，纯文本走 `parseHtml('<body>'+v+'</body>')`；
 *   · `String` 包装对象（`strWithJsoup` 的产物，`typeof` 是 object）→ 一律走末尾的
 *     `parseHtml(String(v))`。
 * 实测（`📂VIP中文`）：源里 `java.getString(rule, result)` 传的就是**包装对象**，
 * 同一份 5787 字符的页面因此被解析 **7 次** —— 只认 `typeof v === 'string'` 会漏掉这一大类。
 * （两者的 DOM 实际等价，但既然分支不同就不共用一个键，宁可不省也不冒语义风险。）
 */
function sharedKey(v: unknown): string | null {
  if (typeof v === 'string') return `p:${v}`;
  if (v instanceof String) return `w:${String(v)}`;
  return null;
}

export class AnalyzeRule {
  private content: unknown = null;
  private isJson = false;
  private madeUpActive = false;
  private baseUrl?: string;
  /**
   * **内容 → DOM 的实例级缓存**（2026-09-23 加；挂账 `#115`）。
   *
   * 为什么必须有：`asNodes()` 此前**每次调用都 `parseHtml(content)`**，而 jsdom 解析一份
   * 6.19MB 页面**单次常驻约 530MB，且强 GC 不回收**（`dom/index.ts:22` 实测小页面 959KB/次）。
   * 实测 ⚡📂云起书院（8015 章，目录页 6.19MB，16124 个 `<a>`）：
   *   detail 的 6 条字段规则**各 parse 一次** ⇒ heap 60 → 604 → 1126 → 1655 → 2186MB → **OOM**
   *   TRACE：`asNodes (analyze.ts:72) <- dispatchString (1116) <- getStringInner (928)`
   *
   * Legado 的语义是 **`setContent` 时解析一次、之后所有规则复用同一 Document**
   * （`AnalyzeRule.kt` 的 getAnalyzeByCSS/JSoup 都基于同一个 sourceRule）。
   *
   * 命中条件：**同一实例 + 同一份内容**（`src === v`；字符串按值比较，元素/数组按引用）。
   * ⚠️ **只留一个槽**是有意的：缓存会同时持有源文本与 DOM，多槽等于多份 DOM 常驻；
   *    交替求值两份内容时会各 miss 一次，代价可接受（内存优先）。
   * `setContent` 会清空缓存。
   */
  private domCache: { src: unknown; nodes: Element[] } | null = null;

  constructor(private readonly env: AnalyzeEnv) {
    // Legado `bindings["java"] = this`：把本实例的规则桥挂到 env.javaExtra，
    // java Proxy 的 fallback 会查到这里。
    // ⚠️ `Object.assign` 只保证**方法存在**（否则 `java.getElements` 是 undefined → NOT_A_FUNCTION）；
    //    「谁是 self」不再由它决定 —— 那由 `CURRENT_RULE` 槽在**求值时**决定（见其注释）。
    if (env.javaExtra) Object.assign(env.javaExtra, this.ruleApi());
  }

  /** 求值期间把「当前实例」设为 this（同步）；退出恢复，支持嵌套。 */
  private withCurrent<T>(fn: () => T): T {
    const env = this.env as EnvWithCurrentRule;
    const prev = env[CURRENT_RULE];
    env[CURRENT_RULE] = this;
    // 一并维护 `ACTIVE_ENV`：DOM 桥的变更方法（remove/removeAttr/…）靠它回写「动过 DOM」标记
    const prevEnv = ACTIVE_ENV;
    ACTIVE_ENV = env as EnvWithSharedDom;
    try {
      return fn();
    } finally {
      env[CURRENT_RULE] = prev;
      ACTIVE_ENV = prevEnv;
    }
  }

  /** 同上，异步版（必须有：槽要在 `await` 完成之后才恢复，否则异步求值期间槽已被还原）。 */
  private async withCurrentAsync<T>(fn: () => Promise<T>): Promise<T> {
    const env = this.env as EnvWithCurrentRule;
    const prev = env[CURRENT_RULE];
    env[CURRENT_RULE] = this;
    const prevEnv = ACTIVE_ENV;
    ACTIVE_ENV = env as EnvWithSharedDom;
    try {
      return await fn();
    } finally {
      env[CURRENT_RULE] = prev;
      ACTIVE_ENV = prevEnv;
    }
  }

  /** 规则桥（java.getElements/getStringList/setContent/getElement/getString 的同步实现） */
  /**
   * 取「内容」对应的 DOM 节点，**同一实例内复用同一份解析结果**（见 `domCache` 注释）。
   *
   * 只对「会触发 parse」的形态走缓存；元素 / 元素数组本就零解析，缓存只是顺手，
   * 语义与 `asNodes` 完全一致（`nodesOf` 内部就是调它）。
   */
  private nodesOf(v: unknown): Element[] {
    const c = this.domCache;
    if (c && c.src === v) return c.nodes;
    // ② 共享槽（同一次引擎调用内、跨实例）：见 `SHARED_DOM` 注释
    const shared = this.sharedNodes(v);
    if (shared) {
      this.domCache = { src: v, nodes: shared };
      return shared;
    }
    const nodes = asNodes(v);
    this.domCache = { src: v, nodes };
    this.rememberShared(v, nodes);
    return nodes;
  }

  /**
   * 从**共享槽**取已解析的 DOM（命中返回副本，未命中返回 null）。
   *
   * 为什么只对字符串生效：元素 / 元素数组本就零解析（`asNodes` 直接透传），
   * 而字符串才走 `parseHtml`。
   * 为什么返回**副本**：调用方会就地改动返回的数组（`css.ts` 的 `elements.unshift(temp)`
   * 这类「含自身匹配」补位），直接给出缓存数组会被污染。
   */
  private sharedNodes(v: unknown): Element[] | null {
    const key = sharedKey(v);
    if (key == null) return null;
    const env = this.env as EnvWithSharedDom;
    if (env[DOM_TOUCHED]) {
      if (process.env.YUEDU_DEBUG_DOM_CACHE) console.log('[dom-cache] 停用（本请求动过 DOM）');
      return null;
    }
    const list = env[SHARED_DOM];
    if (!list?.length) {
      if (process.env.YUEDU_DEBUG_DOM_CACHE) console.log(`[dom-cache] miss(空槽) len=${key.length}`);
      return null;
    }
    const i = list.findIndex((e) => e.src === key);
    if (i < 0) {
      if (process.env.YUEDU_DEBUG_DOM_CACHE) {
        console.log(`[dom-cache] miss(不匹配) len=${key.length} 槽内=${list.map((e) => e.src.length).join(',')}`);
      }
      return null;
    }
    if (process.env.YUEDU_DEBUG_DOM_CACHE) console.log(`[dom-cache] HIT len=${key.length}`);
    const [hit] = list.splice(i, 1);
    list.unshift(hit as SharedDomEntry); // LRU：命中提到最前
    return (hit as SharedDomEntry).nodes.slice();
  }

  /** 把刚解析出的 DOM 存进共享槽（LRU 裁剪）。见 `sharedDomMaxEntries/MaxChars`。 */
  private rememberShared(v: unknown, nodes: Element[]): void {
    const key = sharedKey(v);
    if (key == null) return;
    if (!nodes.length) return;
    if (key.length > sharedDomMaxChars()) return;
    const env = this.env as EnvWithSharedDom;
    if (env[DOM_TOUCHED]) return;
    const list = (env[SHARED_DOM] ??= []);
    if (list.some((e) => e.src === key)) return;
    list.unshift({ src: key, nodes: nodes.slice() });
    const max = sharedDomMaxEntries();
    if (list.length > max) list.length = max;
  }

  private ruleApi(): Record<string, unknown> {
    /**
     * **调用时**解析「当前求值实例」——不是构造时闭包的那个 `this`。
     * 取不到槽才回落到 `this`（脚本在求值之外被调用，或宿主直接持有该 java 面时）。
     */
    const selfOf = (): AnalyzeRule => (this.env as EnvWithCurrentRule)[CURRENT_RULE] ?? this;
    return {
      setContent: (content: unknown, baseUrl?: string) => {
        selfOf().setContent(content, baseUrl);
        return content;
      },
      getString: (rule: string, mContent?: unknown, isUrl?: boolean) => {
        const s = selfOf();
        const ar = mContent != null ? new AnalyzeRule(s.env).setContent(mContent, s.baseUrl) : s;
        return ar.syncGetString(String(rule ?? ''), isUrl);
      },
      getStringList: (rule: string, mContent?: unknown) => {
        const s = selfOf();
        const ar = mContent != null ? new AnalyzeRule(s.env).setContent(mContent, s.baseUrl) : s;
        return ar.syncGetStringList(String(rule ?? ''));
      },
      getElements: (rule: string, mContent?: unknown) => {
        const s = selfOf();
        const ar = mContent != null ? new AnalyzeRule(s.env).setContent(mContent, s.baseUrl) : s;
        // 桥接 jsoup API（toArray/select/attr…）——源脚本 list.toArray() 依赖
        return bridgeDom(ar.syncGetElements(String(rule ?? '')));
      },
      getElement: (rule: string, mContent?: unknown) => {
        const s = selfOf();
        const ar = mContent != null ? new AnalyzeRule(s.env).setContent(mContent, s.baseUrl) : s;
        /**
         * 上游依据（`#313` 收尾逐行核实）：`AnalyzeRule.kt:895` `bindings["java"] = this`
         *   ⇒ 源脚本里的 `java` **就是 `AnalyzeRule` 本体**，所以
         *   `java.getElement(rule)` == `AnalyzeRule.getElement(rule)`（`:384-414`）：
         *     · Css / XPath → `getElements(rule)` = **整个 Elements 列表**（`:405-406`，不是第一个！）
         *     · Json        → `getObject(rule)`  = **原值**（对象 / 标量 / 数组都能命中，`:404`）
         *     · Regex       → 单值；Js → `evalJS` 的结果
         *   ⇒ **不能统一按「元素列表」处理**：Json 命中的对象/数组必须原样交给脚本。
         *
         * 旧实现的错法（两侧一致地错，所以更难发现）：这里与 worker 侧都用 `getElements`
         *   （= `getList`，**只认数组**）⇒ `java.getElement('$.某对象')` 静默返回空；
         *   而且即使命中数组，也会被 `bridgeDom` 包成"元素列表"，于是
         *   `java.getElement('$.data').field` 这类写法取不到字段。
         *
         * 语料面（179 源）：真正的 `java.getElement(` 共 14 处 / 12 源 ——
         *   13 处 Json 目标全是数组（`$.novels` / `$.series` / `$.illusts` / `$.data.list[*]`），
         *   1 处 Css（起点小说 `.first()`）。回归锁：`__tests__/java-rule-bridge.test.ts` §`#313`。
         */
        const { list, value } = ar.syncGetElementTyped(String(rule ?? ''));
        // 列表型（Css/XPath）：桥接 jsoup API（toArray/select/attr…）——源脚本 list.toArray() 依赖
        if (list) return bridgeElementList((value as unknown[]).filter(isNode) as Element[]);
        // 单值但本身是 DOM 节点（Js 段返回元素）：仍给「单元素列表」
        if (isNode(value)) return bridgeElementList([value as Element]);
        // Json / Regex / Js 的单值：交给 `bridgeDom` —— 它已经实现好三种语义
        // （JSON 数组→挂 Map/List 方法、普通对象→挂 Map 方法、字符串→挂 jsoup 方法）。
        // ★ **不要在这里自己判「对象 vs 数组」再决定怎么包**：那是把同一套判据再写一遍，
        //   旧实现就是 `bridgeDom(all)`（all 是 `[obj]` 数组）⇒ 对象被当成"元素列表"交出去，
        //   源里 `java.getElement('$.data').字段` 取不到值（`#313`）。
        return bridgeDom(value);
      },
    };
  }

  /**
   * getString 的同步变体（java.getString / java.getElements 桥专用）。
   * 与 async getString 同逻辑：Js 段走 env.jsEvalSync（L1 同步），其余后端本就是同步函数。
   */
  syncGetString(ruleStr: string, isUrl = false): string {
    return this.withCurrent(() => this.syncGetStringInner(ruleStr, isUrl));
  }

  /** `syncGetString` 的实现体（外层包装负责把 `java.*` 绑到本次求值实例，见 `CURRENT_RULE`） */
  private syncGetStringInner(ruleStr: string, isUrl = false): string {
    if (!ruleStr) return '';
    let madeUpActive = false;
    // ⚠️ 复合段（含 {{}}/@get 且会走 pieces 分支）**不在 pre-pass 处理**：那会把 {{}} 提前吃掉，
    //    导致 splitSourceRule 认不出 Mode.Regex，规则被误当 CSS 选择器（见 hasCompositeSegment 注释）。
    if (
      ruleStr.includes('{{') &&
      ruleStr.includes('}}') &&
      !/^\s*\{\{[\w\W]*\}\}\s*$/.test(ruleStr) &&
      !this.hasCompositeSegment(ruleStr)
    ) {
      const after = resolvePlaceholdersSync(
        ruleStr,
        this.content,
        this.placeEvalSync(this.content),
        (k) => (this.env.variables.get(k) as string | undefined) ?? '',
        (r, v) => jsonGetString(r, asJson(v), this.env),
        // `#387b`：整段 JS 规则（`@js:` / `<js>`）的 `{{}}` 是**拼进 JS 源码**的 ⇒ 非原始值不拼
        this.isJsRuleText(ruleStr) ? { nonPrimitive: 'drop' } : undefined,
      );
      if (after !== ruleStr) {
        madeUpActive = true;
        ruleStr = after;
        if (!/\{\{|@get:|@put:|##/.test(ruleStr)) {
          return isUrl ? this.absolutize(ruleStr) : ruleStr;
        }
      }
    }
    void madeUpActive;
    const ruleList = splitSourceRule(ruleStr, this.isJson);
    let result: unknown = this.content;
    for (const seg of ruleList) {
      for (const [k, v] of Object.entries(seg.putMap)) {
        this.putVar(k, this.syncGetString(v, false));
      }
      if (seg.mode === 'Get') {
        result = getVarValue(this.env.variables, seg.rawRule);
        continue;
      }
      if (seg.pieces) {
        let made = '';
        for (const p of seg.pieces) {
          if (p.type === 'text') made += p.value;
          else if (p.type === 'get') made += getVarValue(this.env.variables, p.value);
          else if (p.type === 'group') made += groupRefValue(result, p.index) ?? p.raw;
          else if (isRuleExpr(p.value)) made += this.syncGetString(p.value, false);
          else {
            const v = this.syncEval(p.value, this.bindings(result));
            made += v == null ? '' : asString(v);
          }
        }
        const madeClean = splitClean(made);
        result = madeClean.rule;
        if (madeClean.replaceRegex && typeof result === 'string') result = applyClean(result, madeClean);
        continue;
      }
      const resolved = resolvePlaceholdersSync(
        seg.rawRule,
        result,
        this.placeEvalSync(result),
        (k) => (this.env.variables.get(k) as string | undefined) ?? '',
        // ★ `#387b` 的关键一处：这一次调用**先**把 `{{}}` 拼进 `seg.rawRule`（下面 `prepared` 就成空转）
        //   ⇒ JS 段必须在这里就用 drop，否则函数源码先被拼进来，第二道再判也来不及。
        undefined,
        seg.mode === 'Js' ? { nonPrimitive: 'drop' } : undefined,
      );
      const clean = splitClean(resolved);
      if (seg.mode === 'Js') {
        // `#387b`：JS 源码位 —— 非原始值（函数/对象）**不拼入**（拼进去必然语法错，见 PlaceholderOpts）
        const prepared = resolvePlaceholdersSync(
          clean.rule,
          result,
          this.placeEvalSync(result),
          (k) => (this.env.variables.get(k) as string | undefined) ?? '',
          undefined,
          { nonPrimitive: 'drop' },
        );
        try {
          result = this.syncEval(prepared, this.bindings(result));
        } catch (e) {
          const t = prepared.trim();
          if (/^\.\.[\w-]+|^\$\$?\.\.[\w-]+|^\$\.?[\w-]+(\.[\w-]+|\[\d+\])*$/.test(t) && /\.\.|^[\$]/.test(t) && !/\(|=|;|\s\+\s/.test(t)) {
            result = jsonGetString(t, result, this.env);
          } else {
            throw e;
          }
        }
      } else if (seg.mode === 'WebJs') {
        // 同步路径没有渲染通道（webJsRender 是异步）⇒ 空串 + 留痕
        warnWebJsOnce(clean.rule, '同步求值路径无渲染通道');
        result = '';
      } else if (clean.rule.trim() !== '' || !clean.replaceRegex) {
        // 对齐 Legado AnalyzeRule.kt:343 `if (rule.isNotBlank() || sourceRule.replaceRegex.isEmpty())`：
        // 规则体为空 且 有 replaceRegex 时 **不做 mode 求值** —— 保留当前 result（元素/对象）
        // 交给替换正则（Legado 用 result.toString()，元素即 outerHtml）。
        // 典型语料：`##href="//m.qidian.com/chapter/(\\d+)/0/"##{{ho}}/book/$1/###`（ruleSearch.bookUrl）
        result = this.dispatchString(seg.mode, clean.rule, result, false);
      }
      if (clean.replaceRegex) result = applyCleanResult(result, clean);
    }
    let out = typeof result === 'string' ? result : asString(result);
    out = decodeResultEntities(out);
    if (isUrl) return this.absolutize(out);
    return out;
  }

  /**
   * 直接执行 JS 片段，带 Legado 全套 bindings（book/source/java/$/title/chapter/baseUrl…）。
   * 用于 preUpdateJs 这类「没有规则、只有脚本」的场景（Legado: evalJS(preUpdateJs)）。
   * 注意 book/source 是**活对象**：脚本内赋值会经 entityStub 的 set 陷阱写回 env.bookData/sourceData。
   */
  async runJs(code: string, extra?: Record<string, unknown>): Promise<unknown> {
    return this.env.jsEval(code, { ...this.bindings(this.content), ...(extra ?? {}) });
  }

  /**
   * 这条规则是否会落到「复合段」（`pieces`）——即 Legado 的 `Mode.Regex` 段
   * （含 `{{}}`/`@get:{k}` 且首个占位符在 0 位或前缀不含 `##`；见 `splitSourceRule`）。
   *
   * ⚠️ **2026-09-21 修（缺陷类 Q 的第二半）**：pre-pass 一旦把 `{{}}` 提前替换掉，
   * 后续 `splitSourceRule` 就**再也看不到 `{{}}`** → 复合段消失 → 规则退化成普通 CSS 段。
   * 而 Legado 的 `mode` 是 **SourceRule 构造时**（替换前）定的，替换后仍保持 `Mode.Regex`
   * —— `getString` 对 `Mode.Regex` 走 `else -> rule`（**结果就是替换后的文本本身**）。
   * 实测（📂书文小说）`tocUrl = '{{baseUrl}}##$##d1.html'`：
   *   · 修前：`{{baseUrl}}` 被抹空 → 退化成 `##$##d1.html` → 结果 = **正文内容 + "d1.html"**；
   *   · 只修 bindings 后：替换成 `…/77343/##$##d1.html` → 被当 CSS 选择器 → 结果 = `"d1.html"`；
   *   · 两半都修：复合段自己替换，替换后按 `else -> rule` 取**文本本身** → `…/77343/d1.html` ✓
   * 所以：**规则会落复合段时，pre-pass 必须让路**（复合段内部已按 makeUpRule 语义替换）。
   */
  private hasCompositeSegment(ruleStr: string): boolean {
    return splitSourceRule(ruleStr, this.isJson).some((s) => s.pieces);
  }

  /**
   * 这条规则是不是**整段 JS 规则**（`@js:` / `<js>` 起头）—— `#387b`。
   *
   * 为什么需要这个判据：`{{expr}}` 插值有**两种性质完全不同的去处** ——
   *  · 拼进**结果文本**（CSS/URL 模板/复合段）：值就是用户要的字符串，任何非空值都该拼；
   *  · 拼进 **JS 源码**（`@js:` / `<js>` 段）：值必须是一段**合法 JS**，否则整条规则连脚本都跑不到。
   * 第二类里「非原始值」（函数 `String()` 出来是函数源码、对象是 `[object Object]`）**必然非法**
   * ⇒ 一律不拼（见 `PlaceholderOpts.nonPrimitive='drop'`）。
   *
   * ⚠️ 判据必须**唯一**：`splitSourceRule` 已经把 `@js:` / `<js>` 切成 `mode='Js'` 的段，
   * 这里只是「一眼看出整条规则是不是就是那段 JS」（pre-pass 在切分**之前**跑，拿不到 Segment）。
   */
  private isJsRuleText(ruleStr: string): boolean {
    return /^\s*(?:@js:|<js>)/i.test(ruleStr);
  }

  /**
   * `{{expr}}` 占位符的求值器（**带全套 bindings**）——pre-pass（makeUpRule）专用。
   *
   * ⚠️ **2026-09-21 修（缺陷类 Q）**：pre-pass 此前直接把**裸求值器** `env.jsEval` 交给
   * `resolvePlaceholders`，而裸求值器只有 `variables`，没有 `bindings()` 里那些名字
   * （`baseUrl` / `book` / `chapter` / `source` / `title` / `$` / `result` / `page` / `key` …）。
   * JS 里这些名字求值为 `undefined` → `resolvePlaceholders` 对 `v == null` 的处理是
   * **替换成空串**（`if (v == null) out += ''`）→ 占位符被**静默抹掉**。
   *
   * 实测（📂书文小说）：`ruleBookInfo.tocUrl = '{{baseUrl}}##$##d1.html'` 的 `{{baseUrl}}` 被抹成空，
   * 规则退化为 `'##$##d1.html'` → 求值结果成了**正文内容 + "d1.html"** → 目录请求打到非章节页
   * → 源脚本解密失败 → 正文 0 段。语料该形态共 **82 处**（`book` 30 · `baseUrl` 24 · `source` 10 ·
   * `result` 8 · `chapter` 7 · `title` 2 · `page` 1，涉及 14+ 源，如 `{{book.name}}`、`{{title}}`、
   * `{{baseUrl.match(/(\d+)/)[1]}}`）。
   *
   * Legado 的 `makeUpRule` 走 `evalJS(expr, result)`（同一条 JS 上下文，bindings 齐全），故此处必须一致。
   */
  private placeEval(running: unknown): (code: string, extra: Record<string, unknown>) => unknown {
    return (code, extra) => {
      // `#403` 对齐上游 makeUpRule（`AnalyzeRule.kt:795-799` + `isRule:837-842`）：
      // `{{}}` 内容以 `@` / `$.` / `$[` / `//` 开头 = **源规则**（不是 JS）⇒ 走 getString
      // （支持 `@@` 前缀、`##` 替换、jsonpath）。旧实现一律 jsEval ⇒ `{{@@h1@text##\[.*?\]}}`
      // 求值语法错 → 保留原文 → 残留 `##` 被 splitClean 扁平兜底切开 ⇒ JS 截断「Unexpected end of input」。
      if (isMakeUpRule(code)) return this.getString(code, false);
      return this.env.jsEval(code, { ...this.bindings(running), ...extra });
    };
  }

  /**
   * `placeEval` 的同步变体。
   *
   * ⚠️ 同步求值器**不可用时抛错**（`resolvePlaceholdersSync` 会捕获并**保留原文**），
   * 而不是像旧代码那样 `?? (() => '')` —— 后者会把所有 `{{}}` 静默抹成空串，
   * 正是缺陷类 Q 的最恶劣形态（无报错、值全丢）。
   */
  private placeEvalSync(running: unknown): (code: string, extra: Record<string, unknown>) => unknown {
    const fn = this.env.jsEvalSync;
    // ⚠️ 抛错必须发生在**被调用时**，不能在这里直接 `throw` —— 本函数是作为**实参**传给
    //    `resolvePlaceholdersSync` 的（`resolvePlaceholdersSync(..., this.placeEvalSync(result), ...)`），
    //    直接抛会逃出它的 try/catch，把「保留原文」变成「整条规则抛错」。
    return (code, extra) => {
      // `#403` 与异步 `placeEval` 同判据（同一判据只写一处，见 isMakeUpRule）
      if (isMakeUpRule(code)) return this.syncGetString(code, false);
      if (!fn) throw new Error('同步求值器不可用 —— 占位符保留原文（不静默抹空）');
      return fn(code, { ...this.bindings(running), ...extra });
    };
  }

  /**
   * URL 绝对化：空值不绝对化（否则 `resolveUrl(基址,'')` 会把空属性变成站点根——Legado 直接过滤空项）。
   *
   * ⚠️ **跨行的 `,{options}` 尾巴不得被截断**（2026-09-22 修，用户实测回归）。
   *
   * URL 规则常把 Legado 的 **UrlOption** 写在**下一行**，例如 ⚡📂绿柠小说的搜索书名页：
   * ```
   * https://android.goreadnovels.com/getBooksList,{
   *   "body": "bids={{$.bid}}",
   *   "method": "POST"
   * }
   * ```
   * 旧实现 `v.split('\n').find(…)` **只取第一行** → 值被截成 `…getBooksList,{`
   * ⇒ 详情请求退化成 GET（`body`/`method` 全丢）→ 站点返回的不是详情数据 → **所有字段空**
   * → `bid` 空 → 目录 0 章、正文空（用户对比 post7 基线发现的回归）。
   *
   * 对齐 Legado：`NetworkUtils.getAbsoluteURL(base, url)` 只判断「是否已是绝对地址」，
   * **不做切行**；`,{options}` 交给后续 `AnalyzeUrl` 统一解析（它本身允许跨行 JSON）。
   * 所以：**含 `,{` 的多行值整体返回**（保住选项），其余仍按「首行非空」处理（保持历史行为）。
   */
  private absolutize(v: string): string {
    const lines = v.split('\n').filter((s) => s.trim() !== '');
    const first = lines[0] ?? '';
    if (!first.trim()) return '';
    if (lines.length > 1 && /,\s*\{/.test(v)) return v.trim();
    return this.env.toAbsolute ? this.env.toAbsolute(first) : first;
  }

  /** 同步 JS 段求值：优先 jsEvalSync（L1）；未配置时同步桥里跳过（返回 undefined） */
  private syncEval(code: string, bindings: Record<string, unknown>): unknown {
    const fn = this.env.jsEvalSync;
    if (!fn) return undefined;
    return fn(code, bindings);
  }

  /** getElements 的同步变体（java.getElements 桥专用） */
  syncGetElements(ruleStr: string): unknown[] {
    return this.withCurrent(() => this.syncGetElementsInner(ruleStr));
  }

  /**
   * `java.getElement` 桥专用：与异步 `getElementTyped` **同值同形**（返回 `{list, value}`）。
   *
   * `list = true` ⇒ `value` 是列表（末段 Css/XPath，上游 `getElements`）；
   * `list = false` ⇒ `value` 是单值（末段 Json/Regex/Js，上游 `getObject` / `evalJS`）。
   * ★ 桥必须拿到这个标记才能正确分流 —— 「Css 的列表」与「Json 的数组」长得一样。
   */
  syncGetElementTyped(ruleStr: string): { list: boolean; value: unknown } {
    return this.withCurrent(() => {
      const out = this.syncGetElementsInner(ruleStr, true);
      return { list: this.lastIsList, value: this.lastIsList ? out : out[0] };
    });
  }

  /**
   * `syncGetElements` / `syncGetElement` 的实现体（外层包装见 `CURRENT_RULE`）。
   *
   * @param rawJson 与异步版**同义**：`true` 走 `jsonGetObject`（对齐上游 `getElement` →
   *   `getObject`：对象也算命中），`false` 走 `jsonGetList`（对齐 `getElements`：只认数组）。
   *
   * ⚠️ `#313` 之前同步版**没有**这个分岔 —— L1 的 `java.getElement` 桥与 worker 侧
   *   （`ruleBridge` 只发 `op='elements'`）**一致地**用了 `getList`。
   *   「两条路径一致」本身不足以证明「对」：那条被一致执行的是**上游没有**的语义，
   *   表现为「`java.getElement('$.某对象')` 静默返回空」。所以这次是**两侧一起改**。
   */
  private syncGetElementsInner(ruleStr: string, rawJson = false): unknown[] {
    if (!ruleStr) return [];
    let reverse = false;
    if (ruleStr.startsWith('-')) {
      reverse = true;
      ruleStr = ruleStr.slice(1);
    } else if (ruleStr.startsWith('+')) {
      ruleStr = ruleStr.slice(1);
    }
    const ruleList = splitSourceRule(ruleStr, this.isJson, true);
    let result: unknown = this.content;
    for (const seg of ruleList) {
      // 末段模式标记（`#313`）：只有 Css/XPath 在上游 `getElement` 里返回**整个列表**。
      // ⚠️ 循环内可能发生嵌套求值（`syncGetString` / `placeEval` 会再进本函数）⇒ 该字段会被内层
      //    覆盖，因此循环结束后还要按「末段」重算一次（见下方 `lastSeg`）。
      this.lastIsList = seg.mode === 'Default' || seg.mode === 'XPath';
      for (const [k, v] of Object.entries(seg.putMap)) {
        this.putVar(k, this.syncGetString(v, false));
      }
      if (seg.mode === 'Get') {
        result = getVarValue(this.env.variables, seg.rawRule);
        continue;
      }
      if (seg.pieces) {
        let made = '';
        for (const p of seg.pieces) {
          if (p.type === 'text') made += p.value;
          else if (p.type === 'get') made += getVarValue(this.env.variables, p.value);
          else if (p.type === 'group') made += groupRefValue(result, p.index) ?? p.raw;
          else if (isRuleExpr(p.value)) made += this.syncGetString(p.value, false);
          else {
            const v = this.syncEval(p.value, this.bindings(result));
            made += v == null ? '' : asString(v);
          }
        }
        const madeClean = splitClean(made);
        const res = asString(result);
        // 单值入口（getElement）只取首个匹配；列表入口（getElements）取全部匹配
        const madeGroups = rawJson ? regexGetElement(madeClean.rule, res) : regexGetElements(madeClean.rule, res);
        /**
         * `#721` **正则列表必须保留捕获组**（上游 `AnalyzeByRegex.getElements` 返回 `List<List<String>>`）。
         * 旧实现把每组 `join('')` 成单个字符串 ⇒ 下游 `chapterName: '$2'` 取不到第 2 组
         * （⚡📂️快眼小说 / ⚡📂若夏 的目录整段失效）。单值入口（rawJson）维持拼接后的字符串。
         */
        result = rawJson ? madeGroups.map((g) => (Array.isArray(g) ? g.join('') : '')) : madeGroups;
        if (madeClean.replaceRegex && typeof result === 'string') result = applyClean(result, madeClean);
        continue;
      }
      const resolved = resolvePlaceholdersSync(
        seg.rawRule,
        result,
        this.placeEvalSync(result),
        (k) => (this.env.variables.get(k) as string | undefined) ?? '',
        // ★ `#387b` 的关键一处：这一次调用**先**把 `{{}}` 拼进 `seg.rawRule`（下面 `prepared` 就成空转）
        //   ⇒ JS 段必须在这里就用 drop，否则函数源码先被拼进来，第二道再判也来不及。
        undefined,
        seg.mode === 'Js' ? { nonPrimitive: 'drop' } : undefined,
      );
      const clean = splitClean(resolved);
      if (seg.mode === 'Js') {
        // `#387b`：JS 源码位 —— 非原始值（函数/对象）**不拼入**（拼进去必然语法错，见 PlaceholderOpts）
        const prepared = resolvePlaceholdersSync(
          clean.rule,
          result,
          this.placeEvalSync(result),
          (k) => (this.env.variables.get(k) as string | undefined) ?? '',
          undefined,
          { nonPrimitive: 'drop' },
        );
        result = this.syncEval(prepared, this.bindings(result));
      } else if (seg.mode === 'WebJs') {
        // 同步路径没有渲染通道（webJsRender 是异步）⇒ 空串 + 留痕，与异步路径同一语义
        warnWebJsOnce(clean.rule, '同步求值路径无渲染通道');
        result = '';
      } else if (seg.mode === 'Regex') {
        const res = asString(result);
        const groups = rawJson ? regexGetElement(clean.rule, res) : regexGetElements(clean.rule, res);
        // `#721`：列表入口保留捕获组（List<List<String>>，上游 getElements），供下游 `$n` 逐项引用
        result = rawJson ? groups.map((g) => (Array.isArray(g) ? g.join('') : '')) : groups;
      } else if (seg.mode === 'Json') {
        // rawJson ⇒ `jsonGetObject`（上游 `getElement` → `getObject` = ctx.read 原文，对象也算命中）；
        // 否则 `jsonGetList`（只认数组）。
        result = rawJson
          ? jsonGetObject(clean.rule, asJson(result))
          : jsonGetList(clean.rule, asJson(result), this.env);
      } else if (seg.mode === 'XPath') {
        result = xpathGetElements(clean.rule, this.nodesOf(result), this.env);
      } else {
        result = cssGetElements(clean.rule, this.nodesOf(result), this.env);
      }
      if (clean.replaceRegex && typeof result === 'string') result = applyClean(result, clean);
    }
    // 按「末段」重算一次（循环内的嵌套求值可能覆盖过这个字段）
    const lastSeg = ruleList[ruleList.length - 1];
    this.lastIsList = lastSeg?.mode === 'Default' || lastSeg?.mode === 'XPath';
    // ★ 上游 `getElement`（`#313`）两条语义分流：Css/XPath → 整个列表；其余 → **单值**。
    //   单值模式不能走 `toList()`（会把「本身就是数组的结果」摊平 ⇒ 只拿到首元素）。
    if (rawJson) return this.lastIsList ? toList(result) : [result];
    const out = toList(result);
    return reverse ? out.reverse() : out;
  }

  /** getStringList 的同步变体 */
  syncGetStringList(ruleStr: string): string[] {
    return this.withCurrent(() => this.syncGetStringListInner(ruleStr));
  }

  /** `syncGetStringList` 的实现体（外层包装见 `CURRENT_RULE`） */
  private syncGetStringListInner(ruleStr: string): string[] {
    const s = this.syncGetString(ruleStr, false);
    return s.split('\n').map((x) => x.trim()).filter(Boolean);
  }

  setContent(content: unknown, baseUrl?: string): this {
    this.content = content;
    // 内容变了 → 上一份解析结果作废（见 domCache 注释：缓存只对「同一份内容」有意义）
    this.domCache = null;
    if (baseUrl) this.baseUrl = baseUrl;
    this.isJson = isJsonValue(content);
    return this;
  }

  // ---- 单条规则串求值，返回字符串（最常用入口） ----
  async getString(ruleStr: string, isUrl = false): Promise<string> {
    return this.withCurrentAsync(() => this.getStringInner(ruleStr, isUrl));
  }

  /** `getString` 的实现体（外层包装见 `CURRENT_RULE`） */
  private async getStringInner(ruleStr: string, isUrl = false): Promise<string> {
    if (!ruleStr) return '';
    this.madeUpActive = false;
    // makeUpRule（对齐 Legado）：非整段 JS 规则中的 {{...}} 内嵌规则先按当前内容求值替换。
    // 整段 {{js}} 是 JS 执行本身，交给下方 Js 段处理，不在此预解析。
    let madeUp = false;
    // 同 sync：复合段让路（见 hasCompositeSegment 注释）
    if (
      ruleStr.includes('{{') &&
      ruleStr.includes('}}') &&
      !/^\s*\{\{[\w\W]*\}\}\s*$/.test(ruleStr) &&
      !this.hasCompositeSegment(ruleStr)
    ) {
      const after = await resolvePlaceholders(
        ruleStr,
        this.content,
        this.placeEval(this.content),
        (k) => (this.env.variables.get(k) as string | undefined) ?? '',
        (r, v) => jsonGetString(r, asJson(v), this.env),
        // `#387b`：整段 JS 规则（`@js:` / `<js>`）的 `{{}}` 是**拼进 JS 源码**的 ⇒ 非原始值不拼
        // （pre-pass 先跑一遍、Js 段再跑一遍，两处必须同策略，否则前者就把脚本打坏）
        this.isJsRuleText(ruleStr) ? { nonPrimitive: 'drop' } : undefined,
      );
      if (after !== ruleStr) { madeUp = true; this.madeUpActive = true; }
      ruleStr = after;
      // 内嵌全部解析完且无剩余段标记 → 结果即字面量拼接串（Legado makeUpRule 拼接语义）
      // ⚠️ **JS 段标记也属于「未解析完」**（2026-09-16 修）：`@js:` 规则的脚本体里经常出现
      // `{{}}`（例如 `@js:` + `"https://x?id={{$.comic_id}}," + JSON.stringify(opt)`）。
      // 若不排除，`{{}}` 替换掉之后本行会误判为「纯字面量拼接串」而**提前 return 脚本原文**
      // —— 再经 `toAbsolute()` 编码就变成 `base + '@js:t=%22...'` 这种垃圾相对 URL。
      // 实测症状：全免漫画搜索结果的 bookUrl 是规则原文 → 详情页把规则当书名显示、目录为空。
      if (madeUp && !/(?:\{\{|@get:|@put:|@js:|<js>|##)/.test(ruleStr)) {
        return isUrl && this.env.toAbsolute ? this.env.toAbsolute(ruleStr) : ruleStr;
      }
    }
    const ruleList = splitSourceRule(ruleStr, this.isJson);
    let result: unknown = this.content;
    for (const seg of ruleList) {
      // @put:{...}：键写入变量作用域，值为规则串先求值
      for (const [k, v] of Object.entries(seg.putMap)) {
        const val = await this.getString(v, false);
        this.putVar(k, val);
      }
      // @get:{key} 整段（Legado getRuleType）：走**与 `java.get(k)` 同一条链**
      // （`AnalyzeRule.kt:810-812` 的 `getRuleType -> get(param)`；链末环是「按源持久变量」）—— 见 `getVarValue`。
      if (seg.mode === 'Get') {
        result = getVarValue(this.env.variables, seg.rawRule);
        continue;
      }
      // 复合段（Legado makeUpRule）：依序拼接 text/@get/{{}} 片段，再对拼接结果分离 ##。
      // getString 里 Regex 段 = 拼接文本本身（Legado: `else -> rule`）。
      if (seg.pieces) {
        let made = '';
        for (const p of seg.pieces) {
          if (p.type === 'text') made += p.value;
          else if (p.type === 'get') made += getVarValue(this.env.variables, p.value);
          else if (p.type === 'group') made += groupRefValue(result, p.index) ?? p.raw;
          else if (isRuleExpr(p.value)) made += await this.getString(p.value, false);
          else {
            const v = await this.env.jsEval(p.value, this.bindings(result));
            made += v == null ? '' : asString(v);
          }
        }
        const madeClean = splitClean(made);
        result = madeClean.rule;
        if (madeClean.replaceRegex && typeof result === 'string') result = applyClean(result, madeClean);
        continue;
      }
      const resolved = await resolvePlaceholders(
        seg.rawRule,
        result,
        this.placeEval(result),
        (k) => (this.env.variables.get(k) as string | undefined) ?? '',
        // ★ `#387b` 的关键一处：这一次调用**先**把 `{{}}` 拼进 `seg.rawRule`（下面 `prepared` 就成空转）
        //   ⇒ JS 段必须在这里就用 drop，否则函数源码先被拼进来，第二道再判也来不及。
        undefined,
        seg.mode === 'Js' ? { nonPrimitive: 'drop' } : undefined,
      );
      const clean = splitClean(resolved);

      if (seg.mode === 'Js') {
        // 对齐 Legado makeUpRule：<js> 段内的 {{}}/@get 先按当前内容替换进脚本文本，再整段执行
        // `#387b`：JS 源码位 —— 非原始值（函数/对象）**不拼入**（拼进去必然语法错，见 PlaceholderOpts）
        const prepared = await resolvePlaceholders(
          clean.rule,
          result,
          this.placeEval(result),
          (k) => (this.env.variables.get(k) as string | undefined) ?? '',
          undefined,
          { nonPrimitive: 'drop' },
        );
        try {
          result = await this.env.jsEval(prepared, this.bindings(result));
        } catch (e) {
          // 对齐 Legado：JS 求值失败且内容形如 JsonPath（$..x / $.x）时按规则解析回退
          const t = prepared.trim();
          if (/^\.\.[\w-]+|^\$\$?\.\.[\w-]+|^\$\.?[\w-]+(\.[\w-]+|\[\d+\])*$/.test(t) && /\.\.|^[\$]/.test(t) && !/\(|=|;|\s\+\s/.test(t)) {
            result = jsonGetString(t, result, this.env);
          } else {
            throw e;
          }
        }
      } else if (seg.mode === 'WebJs') {
        // 需要真浏览器：走渲染通道，不可用/失败 ⇒ 空串 + `@webjs degraded` 留痕（不抛整段）
        result = await this.webJsResult(clean.rule, result);
      } else if (clean.rule.trim() !== '' || !clean.replaceRegex) {
        // 同步版说明：Legado AnalyzeRule.kt:343——规则体为空且有 replaceRegex 时跳过 mode 求值
        result = this.dispatchString(seg.mode, clean.rule, result, false);
      }
      if (clean.replaceRegex) result = applyCleanResult(result, clean);
    }
    let out = typeof result === 'string' ? result : asString(result);
    out = decodeResultEntities(out);
    if (isUrl) return this.absolutize(out);
    return out;
  }

  // ---- 返回元素 / 对象列表（用于 bookList / 目录 容器解析） ----
  /**
   * `@put:{k:v}` 写入（Legado `AnalyzeRule.putRule` → `put()`）。
   * 宿主注入 `env.putVariable` 时可做**持久落点**（跨请求 `@get:{k}` 也能读到）；
   * 未注入则退化为仅本次请求可见。
   */
  private putVar(key: string, value: string): void {
    if (this.env.putVariable) this.env.putVariable(key, value);
    else this.env.variables.set(key, value);
  }

  async getElements(ruleStr: string): Promise<unknown[]> {
    return this.withCurrentAsync(() => this.getElementsInner(ruleStr));
  }

  /**
   * 末段规则是否「列表型」（`Css` / `XPath`）——由 `getElementsInner` 每次求值后填写。
   *
   * ★ 为什么需要这个标记（`#313`，2026-10-07 逐行核对上游 `AnalyzeRule.getElement` :384-414）：
   * 上游 `getElement` 各模式的返回值**不是一回事**：
   * ```
   * Mode.Json   -> ...getObject(rule)      // 原值：对象/标量/数组都能命中
   * Mode.Regex  -> AnalyzeByRegex.getElement(...)   // 单值
   * Mode.Js     -> evalJS(rule, result)             // 单值（脚本返回数组就是数组）
   * Mode.XPath  -> ...getElements(rule)    // ★ 整个列表
   * else (Css)  -> ...getElements(rule)    // ★ 整个列表
   * ```
   * ⇒ Css/XPath 必须返回**列表**；Json/Regex/Js 返回**单值**。
   * 统一取 `[0]` 会让 Css 退化成「只要第一个匹配」——那是静默丢结果。
   *
   * ⚠️ 本仓的「Css」在 `RuleMode` 里写作 **`'Default'`**（`@css:` 与裸选择器、`@@` 前缀都归它，
   *   见 `rule-analyzer.ts:detectMode`），**没有 `'Css'` 这个成员** —— 别照上游的 `Mode.Css` 猜。
   */
  private lastIsList = false;

  /**
   * 取**单个元素 / 原始值** —— 对齐 Legado `AnalyzeRule.getElement`（`AnalyzeRule.kt:384-414`）。
   *
   * ★ 与 `getElements` 的差别有**两处**（上游逐行核实，别再以为只有一处）：
   *
   * ① `Mode.Json` 分支：
   *   · `getElements` → `getAnalyzeByJSonPath(result).getList(rule)`（`AnalyzeByJSonPath.kt:132`）
   *     —— `ctx.read<List<Any>>`，目标**非数组就抛异常** → 空列表；
   *   · `getElement`  → `getAnalyzeByJSonPath(result).getObject(rule)`（同文件 :128）
   *     —— `ctx.read(rule)` 原文，**对象 / 标量 / 数组都能命中**。
   * ② 返回形态（`#313` 补）：
   *   · `Css` / `XPath` → 上游返回 `getElements(rule)` = **整个 Elements 列表**（`:405-406`），
   *     **不是第一个元素** —— 所以这里必须返回列表，不能 `[0]`；
   *   · `Json` / `Regex` / `Js` → 上游返回单值（`:397-404`）。
   *
   * ⚠️ 为什么 Json 必须分成两个入口（`#309` 实测，属「修 `jsonGetList` 时打断的调用点」）：
   *   `ruleBookInfo.init` 的上游求值入口是 **`getElement`** ——
   *   `BookInfo.kt:58-62`：`infoRule.init?.let { analyzeRule.setContent(analyzeRule.getElement(it)) }`。
   *   本仓此前写的是 `getElements(initRule)[0]`，早先靠 `jsonGetList` 里「非数组包成 1 条」
   *   蒙对；`jsonGetList` 收紧为「只认数组」后立刻暴露：
   *   语料 23 个带 `init` 的源中，🥝猕猴桃漫画（`$.data`）与松鹤庭沐·言璃版（`$.data.bookInfo`）
   *   两个源 init 恒空 → 后续 `name/author/tocUrl` 退化成对**原始响应**求值 → 详情空、目录 0 章（静默）。
   *   （回归锁：`packages/engine-legado/src/__tests__/toc-init-isolation.test.ts`）
   */
  async getElement(ruleStr: string): Promise<unknown> {
    return this.withCurrentAsync(async () => (await this.getElementTyped(ruleStr)).value);
  }

  /**
   * 与 `getElement` 同值，但**附带「是否列表型」标记**。
   *
   * 用途：规则桥（`java.getElement` 的 worker 侧）要把结果序列化回 worker ——
   * 列表型要转成元素描述符数组让 worker 重建「带 jsoup 方法的活列表」，
   * 单值型要原样返回。没有这个标记就分不清「Css 的列表」与「Json 的数组」。
   */
  async getElementTyped(ruleStr: string): Promise<{ list: boolean; value: unknown }> {
    return this.withCurrentAsync(async () => {
      const out = await this.getElementsInner(ruleStr, true);
      return { list: this.lastIsList, value: this.lastIsList ? out : out[0] };
    });
  }

  /**
   * `getElements` / `getElement` 的实现体（外层包装见 `CURRENT_RULE`）。
   *
   * @param rawJson 仅 `Mode.Json` 分支生效：`true` 走 `jsonGetObject`（`ctx.read` 原文，
   *   对象也算命中，对齐上游 `getElement`）；`false` 走 `jsonGetList`（只认数组，对齐上游 `getElements`）。
   */
  private async getElementsInner(ruleStr: string, rawJson = false): Promise<unknown[]> {
    if (!ruleStr) return [];
    // 对齐 Legado BookList/BookChapterList：列表规则前缀 `-` = 结果倒序，`+` = allInOne 标志（均剥离后解析）
    let reverse = false;
    if (ruleStr.startsWith('-')) {
      reverse = true;
      ruleStr = ruleStr.slice(1);
    } else if (ruleStr.startsWith('+')) {
      ruleStr = ruleStr.slice(1);
    }
    const ruleList = splitSourceRule(ruleStr, this.isJson, true);
    let result: unknown = this.content;
    for (const seg of ruleList) {
      // 末段模式标记（`#313`）：只有 Css/XPath 在上游 `getElement` 里返回**整个列表**，
      // 其余（Json/Regex/Js/Get/复合段）都是单值。每段覆盖，循环结束时即为末段的值。
      this.lastIsList = seg.mode === 'Default' || seg.mode === 'XPath';
      for (const [k, v] of Object.entries(seg.putMap)) {
        this.putVar(k, await this.getString(v, false));
      }
      // @get:{key} 整段：直接取变量值
      if (seg.mode === 'Get') {
        result = getVarValue(this.env.variables, seg.rawRule);
        continue;
      }
      // 复合段（elements 路径，对齐 Legado getStringList/getElement）：
      // Regex 段 → 对拼接文本做正则抽取。
      if (seg.pieces) {
        let made = '';
        for (const p of seg.pieces) {
          if (p.type === 'text') made += p.value;
          else if (p.type === 'get') made += getVarValue(this.env.variables, p.value);
          else if (p.type === 'group') made += groupRefValue(result, p.index) ?? p.raw;
          else if (isRuleExpr(p.value)) made += await this.getString(p.value, false);
          else {
            const v = await this.env.jsEval(p.value, this.bindings(result));
            made += v == null ? '' : asString(v);
          }
        }
        const madeClean = splitClean(made);
        const res = asString(result);
        // 单值入口（getElement）只取首个匹配；列表入口（getElements）取全部匹配
        const madeGroups = rawJson ? regexGetElement(madeClean.rule, res) : regexGetElements(madeClean.rule, res);
        /**
         * `#721` **正则列表必须保留捕获组**（上游 `AnalyzeByRegex.getElements` 返回 `List<List<String>>`）。
         * 旧实现把每组 `join('')` 成单个字符串 ⇒ 下游 `chapterName: '$2'` 取不到第 2 组
         * （⚡📂️快眼小说 / ⚡📂若夏 的目录整段失效）。单值入口（rawJson）维持拼接后的字符串。
         */
        result = rawJson ? madeGroups.map((g) => (Array.isArray(g) ? g.join('') : '')) : madeGroups;
        if (madeClean.replaceRegex && typeof result === 'string') result = applyClean(result, madeClean);
        continue;
      }
      // `#398`（对齐上游，`AnalyzeRule.kt` 逐行核对）：makeUpRule（{{}} 替换）只在
      // getString(:328/:343) / getStringList(:224/:251) / **getElement**(:396) 里调；
      // **getElements(:453-497) 的循环没有该调用** ⇒ 列表规则（rawJson=false）的
      // **Js 段不做 {{}} 替换**，脚本原样交给求值器 —— `{{TD()}}` 会被 JS 引擎按嵌套块
      // `{ {TD()} }` 执行：**副作用保留、返回值丢弃**（˃̶͈ ꇴ ˂̶͈ 的 TD() 故意返回字符串
      // `` `turn` ``，替换进去 = `turn is not defined`，整条列表规则死掉 ⇒ 发现页全空）。
      // getElement（rawJson=true）上游**有** makeUpRule ⇒ 维持替换（#387b 的 drop 语义）。
      // ⚠️ 非 Js 段的 {{}} 两路都维持既有替换行为（改动面最小）。
      const jsNoMakeUp = seg.mode === 'Js' && !rawJson;
      const resolved = jsNoMakeUp
        ? seg.rawRule
        : await resolvePlaceholders(
              seg.rawRule,
              result,
              this.placeEval(result),
              (k) => (this.env.variables.get(k) as string | undefined) ?? '',
              // ★ `#387b` 的关键一处：这一次调用**先**把 `{{}}` 拼进 `seg.rawRule`（下面 `prepared` 就成空转）
              //   ⇒ JS 段必须在这里就用 drop，否则函数源码先被拼进来，第二道再判也来不及。
              undefined,
              seg.mode === 'Js' ? { nonPrimitive: 'drop' } : undefined,
            );
      const clean = splitClean(resolved);

      if (seg.mode === 'Js') {
        // `#387b`/`#398`：getElement 路径仍要替换（上游有 makeUpRule）；替换后 JS 源码位
        // 非原始值（函数/对象）不拼入（拼进去必然语法错，见 PlaceholderOpts）。
        const prepared = jsNoMakeUp
          ? clean.rule
          : await resolvePlaceholders(
              clean.rule,
              result,
              this.placeEval(result),
              (k) => (this.env.variables.get(k) as string | undefined) ?? '',
              undefined,
              { nonPrimitive: 'drop' },
            );
        try {
          result = await this.env.jsEval(prepared, this.bindings(result));
        } catch (e) {
          // 对齐 Legado：JS 求值失败且内容形如 JsonPath（$..x / $.x）时按规则解析回退
          const t = prepared.trim();
          if (/^\.\.[\w-]+|^\$\$?\.\.[\w-]+|^\$\.?[\w-]+(\.[\w-]+|\[\d+\])*$/.test(t) && /\.\.|^[\$]/.test(t) && !/\(|=|;|\s\+\s/.test(t)) {
            result = jsonGetString(t, result, this.env);
          } else {
            throw e;
          }
        }
      } else if (seg.mode === 'WebJs') {
        // 需要真浏览器：走渲染通道，不可用/失败 ⇒ 空串 + `@webjs degraded` 留痕（不抛整段）
        result = await this.webJsResult(clean.rule, result);
      } else if (seg.mode === 'Regex') {
        const res = asString(result);
        const groups = rawJson ? regexGetElement(clean.rule, res) : regexGetElements(clean.rule, res);
        // `#721`：列表入口保留捕获组（List<List<String>>，上游 getElements），供下游 `$n` 逐项引用
        result = rawJson ? groups.map((g) => (Array.isArray(g) ? g.join('') : '')) : groups;
      } else if (seg.mode === 'Json') {
        // rawJson ⇒ `jsonGetObject`（上游 `getElement` → `getObject` = ctx.read 原文，对象也算命中）
        result = rawJson
          ? jsonGetObject(clean.rule, asJson(result))
          : jsonGetList(clean.rule, asJson(result), this.env);
      } else if (seg.mode === 'XPath') {
        result = xpathGetElements(clean.rule, this.nodesOf(result), this.env);
      } else {
        result = cssGetElements(clean.rule, this.nodesOf(result), this.env);
      }
      if (clean.replaceRegex && typeof result === 'string') {
        result = applyClean(result, clean);
      }
    }
    // 按「末段」重算一次（循环内的嵌套求值可能覆盖过这个字段）
    const lastSeg = ruleList[ruleList.length - 1];
    this.lastIsList = lastSeg?.mode === 'Default' || lastSeg?.mode === 'XPath';
    // ★ 上游 `getElement`（`#313`）两条语义分流：Css/XPath → 整个列表；其余 → **单值**。
    //   单值模式不能走 `toList()`（会把「本身就是数组的结果」摊平 ⇒ 只拿到首元素，
    //   而上游 `getObject` 是原样返回整个数组）。
    if (rawJson) return this.lastIsList ? toList(result) : [result];
    const out = toList(result);
    return reverse ? out.reverse() : out;
  }

  // ---- 返回字符串列表（少数字段需要，如标签） ----
  async getStringList(ruleStr: string): Promise<string[]> {
    return this.withCurrentAsync(() => this.getStringListInner(ruleStr));
  }

  /** `getStringList` 的实现体（外层包装见 `CURRENT_RULE`） */
  private async getStringListInner(ruleStr: string): Promise<string[]> {
    const s = await this.getString(ruleStr, false);
    // 容忍 JS 段返回 JSON 数组字符串（部分源 JSON.stringify(urls)）——Legado 里 JS 直接返回数组即列表
    const t = s.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const arr = JSON.parse(t) as unknown;
        if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
      } catch {
        /* 非 JSON，走换行切分 */
      }
    }
    return s.split('\n').map((x) => x.trim()).filter(Boolean);
  }

  private bindings(running: unknown): Record<string, unknown> {
    // `$` 与 `result` 在 Legado 里是**同一个值**（AnalyzeRule 的绑定面只放一次），
    // 此前桥接两次 —— 字符串场景下就是两次 parseHtml（每次 ~1MB，见缺陷类 R）。
    const bridged = bridgeDom(running);
    return {
      $: bridged,
      result: bridged,
      baseUrl: this.baseUrl,
      src: bridgeDom(this.content),
      // Legado 里 book/chapter/rssArticle 是实体对象；源脚本常读 book.xxx / chapter.title。
      // env.bookData/chapterData 有真实实体字段时优先（如 book.bookUrl 拼章节链接），
      // 其余字段走可下钻空桩（未知字段返空串）。
      book: entityStub(this.env.bookData),
      chapter: entityStub(this.env.chapterData),
      // rssArticle：RSS 正文规则的 ruleData 就是文章实体（见 AnalyzeEnv.rssData 注释）
      rssArticle: entityStub(this.env.rssData),
      // Legado AnalyzeRule.kt:898,903,905,907 —— source/title/nextChapterUrl/fromBookInfo
      source: entityStub(this.env.sourceData),
      // 可克隆字段快照：让「会发同步 HTTP 的脚本」能进 worker（L1 的 execFileSync 阻塞事件循环）。
      // 混合求值器只在脚本**不写**这些实体时才用快照（写了就留 L1，保证写回语义）。
      ...(this.env.sourceFields ? { [SOURCE_FIELDS_KEY]: this.env.sourceFields } : {}),
      // 三个实体**始终**给快照（缺数据就给 {}）——worker 侧用「空字段 + 下钻桩」重建，
      // 与 `entityStub(undefined)` 语义一致；否则 chapter 常因无数据而漏发 → 整条链回 L1。
      [BOOK_FIELDS_KEY]: this.env.bookData ?? {},
      [CHAPTER_FIELDS_KEY]: this.env.chapterData ?? {},
      [RSS_FIELDS_KEY]: this.env.rssData ?? {},
      // worker 规则桥预置内容（RULE_CONTENT_KEY 注释）：上游 `java.getElements()` 无 mContent
      // 读实例当前 content（AnalyzeRule.kt:895 bindings["java"]=this）；worker 里不预置就恒空。
      // 只带字符串型（String 包装也算）——元素/数组型内容走不到这条 RPC 且不可克隆；
      // 空串不带（worker 侧缺省就是空串）。
      ...(this.content != null &&
      (typeof this.content === 'string' || this.content instanceof String) &&
      String(this.content) !== ''
        ? { [RULE_CONTENT_KEY]: String(this.content) }
        : {}),
      title: (this.env.chapterData?.['title'] as string | undefined) ?? undefined,
      nextChapterUrl: (this.env.variables.get('nextChapterUrl') as string | undefined) || undefined,
      fromBookInfo: this.env.fromBookInfo ?? false,
      page: this.env.variables.get('page') || undefined,
      key: this.env.variables.get('key') || undefined,
      // `document` 的惰性工厂（挂账 #92）：求值器把它定义成 globalThis 上的 getter，
      // **只有脚本真的读 `document`** 时才解析内容（见 DOCUMENT_THUNK 注释与 js.ts 的 l1Eval）。
      [DOCUMENT_THUNK]: () => this.documentOf(running),
      // `#628` JSON 上下文标记：内容已解析成对象 ⇒ `document`（渲染页 DOM）与内容无关，
      // 不该因「jsLib 里出现 document」把整条规则锁死在 L1。见 JSON_CTX_KEY 头注。
      ...(this.isJson ? { [JSON_CTX_KEY]: true } : {}),
    };
  }

  /**
   * 给脚本用的 `document`（挂账 `#92`）。
   *
   * ## 为什么需要
   * 站点会在页面里塞**浏览器环境探针**，把结果算进签名。实测 🏷🎨腾讯漫画 正文页
   * （`ac.qq.com`）连续抓 15 次有 **3 次**出现：
   * ```
   * window["no"+"nce"] = "60cb…" + (+eval("!!document.getElementsByTagName('html')")).toString() + …
   * ```
   * 规则必须 `eval` 这段**页面自带**的代码才能拿到正确的 nonce，进而解密 `DATA`。
   * 我们（以及 Legado 的 Rhino）沙箱里都没有 `document` ⇒ ReferenceError `document is not defined`
   * ⇒ 整条正文规则失败 —— 这正是「腾讯漫画正文**非确定性**失败」的真因（约 1/5 的请求踩中）。
   *
   * ## 语义
   * 返回**当前内容真实的 jsdom Document**（不是伪造对象）：浏览器里
   * `document.getElementsByTagName('html')` 非空 ⇒ `!!` 为 `true`，jsdom 同构 ⇒ 取值一致。
   * 为什么定位在 L1：jsdom 在宿主进程里；worker 内既无 DOM 也无 jsdom，
   * 所以引用 `document` 的脚本由 `HOST_DOCUMENT_RE` 强制留 L1（见 js.ts 的路由守卫）。
   *
   * ## 惰性 + 复用
   * 只有脚本读 `document` 才会走到这里；解析走 `nodesOf()` ⇒ 命中 `SHARED_DOM` 共享槽
   * （缺陷类AS），同一份内容不会因为「要看一眼 document」而多解析一次。
   */
  private documentOf(running: unknown): Document | null {
    const c = running ?? this.content;
    if (c == null) return null;
    if (typeof c === 'object') {
      const n = c as Node;
      if (typeof (n as { nodeType?: unknown }).nodeType === 'number') {
        // 已是节点：Document 直接用，元素/文本取 ownerDocument
        return n.nodeType === 9 ? (n as unknown as Document) : n.ownerDocument;
      }
    }
    const nodes = this.nodesOf(c);
    return nodes[0]?.ownerDocument ?? null;
  }

  /**
   * `@webjs:` 规则求值（对齐 Legado `AnalyzeRule.getWebJsResult`，:180-199）。
   *
   * 需要真浏览器（CDP）：走 `env.webJsRender`（引擎注入 `ctx.renderHtmlScript`）。
   * 渲染器不可用 / 抛错 ⇒ **降级为空串 + 留痕**，不抛整段 —— 「一处能力不支持」不该把
   * 整条字段规则链炸掉（语料 🔊听友M 的 `ruleContent.content` 就是这个形态）。
   */
  private async webJsResult(js: string, result: unknown): Promise<string> {
    const render = this.env.webJsRender;
    if (!render) {
      warnWebJsOnce(js, '没有渲染通道（ctx.renderHtmlScript 未注入）');
      return '';
    }
    try {
      const out = await render(asString(result), this.baseUrl ?? '', js);
      return out == null ? '' : String(out);
    } catch (e) {
      warnWebJsOnce(js, `渲染失败：${e instanceof Error ? e.message : String(e)}`);
      return '';
    }
  }

  private dispatchString(mode: string, rule: string, running: unknown, _isUrl: boolean): string {
    switch (mode) {
      case 'Json':
        return jsonGetString(rule, asJson(running), this.env, false);
      case 'XPath':
        return xpathGetString(rule, this.nodesOf(running), this.env, false);
      case 'Regex':
        return regexGetString(rule, asString(running), this.env, false);
      default: // Default (CSS)
        {
          // JSON 内容（Legado isJson）：字面 URL/文本中的 {$.path} 内嵌按内容展开
          // （对齐 AnalyzeByJSonPath.innerRule("{$.")，如 chapterUrl: https://x/{$.bookId}.txt）
          if (this.isJson && /\{\$[^}]*\}/.test(rule)) {
            let changed = false;
            const expanded = rule.replace(/\{\$([^}]*)\}/g, (_m, p: string) => {
              try {
                const v = jsonGetString('$' + p, asJson(running), this.env);
                if (v == null) return _m;
                changed = true;
                return String(v);
              } catch {
                return _m;
              }
            });
            if (changed) return expanded;
          }
          const nodes = this.nodesOf(running);
          try {
            const out = cssGetString(rule, nodes, this.env, false);
            /**
             * `#673` **裸属性名回落**（用户实测 63书阁：目录 34 章，但每章正文都返回空）。
             *
             * 上游语义（`AnalyzeByJSoup.kt:509-517` 的 `SourceRule`）：**只有**以 `@CSS:` 开头的规则
             * 才走 CSS 分支，其余走 `getResultList`（按 `@` 分段，**最后一段一律当属性名**，
             * 见 `:280` 的 `else -> element.attr(lastRule)`）。所以 `chapterUrl: "href"` 在 App 里
             * 等价 `attr("href")`。
             *
             * 本仓把裸词当选择器 ⇒ `select("href")` 0 命中 ⇒ 空 ⇒ 章节 URL 回落成**目录页 URL**
             * ⇒ 正文取到的是目录页 html ⇒ 段落 0（实测 63书阁 `[content] reqUrl=…/dir/220108/`）。
             *
             * ⚠️ 有意分叉：上游是「无条件当属性」，这里只在**选择器 0 命中**时回落 ——
             *    因为 `title`/`style`/`link` 这类词既是属性名又是真实标签名，无条件当属性会
             *    打断现有依赖 `<title>` 的源。0 命中才回落是上游语义的**超集**，不动已验证面。
             */
            if (out === '' && nodes.length > 0 && isBareAttrName(rule)) {
              const attr = attrOfNode(nodes[0], rule);
              if (attr) return attr;
            }
            // 无元素上下文（JSON/字面量场景）时 CSS 无从选择——规则文本即字面量
            if (out === '' && nodes.length === 0) return rule;
            return out;
          } catch (e) {
            // makeUpRule 拼接出的字面量含选择器非法字符时按文本返回（Legado isRule 回退）
            if (this.madeUpActive && /Invalid selector|not a valid selector/i.test(String(e instanceof Error ? e.message : e))) {
              return rule;
            }
            throw e;
          }
        }
    }
  }
}

function toList(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

// 便捷工厂：直接用规则 + content 拿到字符串
export async function analyzeString(
  rule: string,
  content: unknown,
  env: AnalyzeEnv,
  opts: { isUrl?: boolean; baseUrl?: string } = {},
): Promise<string> {
  return new AnalyzeRule(env).setContent(content, opts.baseUrl).getString(rule, opts.isUrl);
}
