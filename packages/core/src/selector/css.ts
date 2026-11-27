/**
 * CSS 选择器后端（对齐 Legado AnalyzeByJSoup.kt + ElementsSingle）
 *
 * 实现要点（全部对照源码，不猜测）：
 *   - @ 递归分级分隔符（默认模式）。
 *   - @CSS: 模式：只认最后一个 @，前段整体当一个 CSS 选择器，后段为属性（§5.2）。
 *   - 属性指令：text / textNodes / ownText / html / all / 任意 attr（§5.5）。
 *   - ElementsSingle 简写索引 DSL：tag.div.-1:10:2 / tag.div!0:3 / tag.div[-1,3:-2:-10,2]（§5.7）。
 *   - && || %% 组合符（§5.4）。
 *
 * 说明：本后端操作“单一 DOM 树”（架构红线 R1），由调用方保证。
 */

import type { AnalyzeEnv } from './types';
import { splitCombinator } from './rule-analyzer';
// quoteAttrValues 原在本文件，2026-09-28 迁到 jsoup-select.ts 作为**单一实现**（类BP）——
// 因为 Elements 桥的 `doc.select('[property=og:x]')` 不经过本文件，两处实现会漂移。
import { matchesJsoup, quoteAttrValues, selectJsoup } from './jsoup-select';
// `#771` 冻结探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）
import { probeEnter, probeLeave } from '../diag/freeze-probe';

// ---- 文本归一（对齐 Jsoup Element.text() 的 whitespace 归并） ----
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Legado AnalyzeByJSoup.getResultLast 的关键字（有专门语义）；
 * 其余单 token 规则一律当**属性名**（element.attr(rule)）——isVolume:"isv"、chapterUrl:"href"、
 * isVip:"@class" 这类简写都靠它（Legado 里 attr() 取不到就跳过）。
 */
const GET_RESULT_KEYWORD_RE = /^(text|textNodes|ownText|html|all)$/;
/** 单 token 规则：可当作属性名 / 关键字的形态（不含 CSS 组合符、类、伪类等） */
const SINGLE_TOKEN_RE = /^@?[A-Za-z_][\w-]*$/;

function ownText(el: Element): string {
  let out = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3 /* TEXT_NODE */) out += n.textContent ?? '';
  });
  return normalizeWs(out);
}

function getElementsContainingOwnText(root: Element, text: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    if (ownText(el).includes(text)) out.push(el);
    Array.from(el.children).forEach((c: Element) => walk(c));
  };
  walk(root);
  return out;
}

// ---- ElementsSingle 简写索引 DSL（§5.7） ----
interface IndexState {
  split: string; // '!' 排除 | '.' 选择 | ' ' 全选
  beforeRule: string; // 选择器前缀
  /** 单索引 | `[start, end, step]`（`start`/`end` 为 `null` 表示省略，按 0 / len-1 展开） */
  indexes: Array<number | [number | null, number | null, number]>;
  indexDefault: number[];
}

function findIndexSet(rule: string): IndexState {
  const rus = rule.trim();
  /**
   * ★ `#679` **默认 split 必须是 `'.'`（包含），不是 `' '`（不过滤）**。
   *
   * 上游 `ElementsSingle.split` 的默认值就是 `'.'`（`AnalyzeByJSoup.kt:293`），
   * 而 `findIndexSet` 里 `[...]` 语法一旦遇到 `[` 就**直接 return**，
   * 走不到末尾的 `split = ' '` 重置（:508-509）⇒ 于是 `[...]` 天然是「包含」语义。
   *
   * 我们之前把它初始化成 `' '`：`li[-1]` 解析出 indexes=[-1]，但 split 是 `' '`
   * ⇒ 既不排除也不选择 ⇒ **原样返回 3 个元素**（用户实测 `class.clear@tag.li[-1]` 回 3 条，
   * 上游应只回最后 1 条）。没有索引的规则在两条出口处都会显式写 `' '`，不受影响。
   */
  const st: IndexState = { split: '.', beforeRule: rus, indexes: [], indexDefault: [] };
  if (rus.length === 0) return st;

  const head = rus[rus.length - 1] === ']';
  let len = rus.length;
  let l = '';
  let curMinus = false;
  const curList: Array<number | null> = [];

  if (head) {
    len--; // 跳过 ']'
    while (len-- >= 0) {
      let rl = rus[len] as string;
      if (rl === ' ') continue;
      if (rl >= '0' && rl <= '9') {
        l = rl + l;
        continue;
      }
      if (rl === '-') {
        curMinus = true;
        continue;
      }
      const curInt: number | null = l === '' ? null : curMinus ? -parseInt(l, 10) : parseInt(l, 10);
      if (rl === ':') {
        curList.push(curInt);
      } else {
        if (curList.length === 0) {
          if (curInt === null) break; // 是 jsoup 选择器而非索引
          st.indexes.push(curInt);
        } else {
          /**
           * ★ `#679` **区间三元组是 `(start, end, step)`**，别写反。
           *
           * 上游：`Triple(curInt, curList.last(), if (curList.size == 2) curList.first() else 1)`
           * （`AnalyzeByJSoup.kt:444-450`）。逆向扫描时 `curInt` 是**左端**，
           * `curList` 最后一个是**右端**，两个元素时第一个是**间隔**。
           *
           * 旧实现写成 `push([curInt ?? 0, curInt ?? …, step])` —— start/end 都是 `curInt`
           * ⇒ `li[0:2]` 退化成 `[0,0,1]`，只选出第 1 个（用户实测「区间只回 1 条」的同类现象）。
           * null 表示「该端省略」，展开时按 0 / len-1 处理（见 `elementsSingle`）。
           */
          const startX = curInt;
          const endX = curList.length ? (curList[curList.length - 1] ?? null) : null;
          const stepX = curList.length === 2 ? (curList[0] ?? 1) : 1;
          st.indexes.push([startX, endX, stepX]);
          curList.length = 0;
        }
        /**
         * ★ `#679` `[!0:1]`（**排除**写法）：上游在这里把 `rl` **重新读成前一个非空格字符**
         * （`do { rl = rus[--len] } while (len > 0 && rl == ' ')`，`AnalyzeByJSoup.kt:456-461`），
         * 紧接着的 `if (rl == '[')` 才能命中并 `return`（返回时 split 保持 `'!'`）。
         * 旧实现只把 `len` 往回挪、**没有重读 `rl`** ⇒ 下面的 `if (rl === '[')` 判的还是 `'!'`
         * ⇒ 落到 `break` ⇒ 变成「不过滤、整条当选择器」⇒ `tag.li[!0:1]` 恒空。
         */
        if (rl === '!') {
          st.split = '!';
          let guard = 0;
          do {
            rl = rus[--len] as string;
          } while (len > 0 && rl === ' ' && guard++ < 10_000);
        }
        if (rl === '[') {
          st.beforeRule = rus.substring(0, len);
          return st;
        }
        if (rl !== ',') break;
      }
      l = '';
      curMinus = false;
    }
    /**
     * 从 while 里 `break` 出来的（不是索引列表，而是 `a[href]` 这种**属性选择器**）
     * ⇒ 对齐上游「落到末尾重置」：不过滤、前缀就是整条规则。
     */
    st.split = ' ';
    st.beforeRule = rus;
    return st;
  }

  // 阅读原生写法：逆向遍历
  while (len-- >= 0) {
    const rl = rus[len] as string;
    if (rl === ' ') continue;
    if (rl >= '0' && rl <= '9') {
      l = rl + l;
      continue;
    }
    if (rl === '-') {
      curMinus = true;
      continue;
    }
    if (rl === '!' || rl === '.' || rl === ':') {
      st.indexDefault.push(curMinus ? -parseInt(l, 10) : parseInt(l, 10));
      if (rl !== ':') {
        st.split = rl;
        st.beforeRule = rus.substring(0, len);
        return st;
      }
    } else {
      break;
    }
    l = '';
    curMinus = false;
  }
  st.split = ' ';
  st.beforeRule = rus;
  return st;
}

function elementsSingle(temp: Element, rule: string): Element[] {
  const { split, beforeRule, indexes, indexDefault } = findIndexSet(rule);

  let elements: Element[];
  if (beforeRule === '') {
    elements = Array.from(temp.children);
  } else {
    const rules = beforeRule.split('.');
    switch (rules[0]) {
      // ⚠️ jsoup 的 getElementsByClass/getElementsByTag/Collector.collect/select **都从 root 自身开始遍历**
      // （含自身匹配）——linkedom 的 getElementsBy* / querySelectorAll 只搜后代，故这里显式补 self。
      // 否则 `tag.a@href` 作用在 <a> 行上恒为空（超高频写法）。
      case 'children':
        elements = Array.from(temp.children);
        break;
      case 'class': {
        const cls = rules[1] ?? '';
        elements = Array.from(temp.getElementsByClassName(cls));
        if (cls && typeof temp.classList?.contains === 'function' && temp.classList.contains(cls)) elements.unshift(temp);
        break;
      }
      case 'tag': {
        const tag = (rules[1] ?? '').toLowerCase();
        elements = Array.from(temp.getElementsByTagName(tag));
        if (tag && (temp.localName ?? '').toLowerCase() === tag) elements.unshift(temp);
        break;
      }
      case 'id': {
        const id = rules[1] ?? '';
        const selfMatch = id && (temp.getAttribute('id') ?? '') === id ? temp : null;
        const found = selfMatch ? null : temp.querySelector('#' + id);
        elements = selfMatch ? [selfMatch] : found ? [found as Element] : [];
        break;
      }
      case 'text':
        elements = getElementsContainingOwnText(temp, rules[1] ?? '');
        break;
      default: {
        elements = safeQSA(temp, beforeRule);
        if (matchesJsoup(temp, beforeRule)) elements.unshift(temp);
      }
    }
  }

  const len = elements.length;
  if (len === 0) return [];

  // 计算索引集合
  const indexSet = new Set<number>();
  const lastIdx = (indexes.length === 0 ? indexDefault.length : indexes.length) - 1;
  if (indexes.length === 0) {
    for (let ix = lastIdx; ix >= 0; ix--) {
      const it = indexDefault[ix] as number;
      if (it >= 0 && it < len) indexSet.add(it);
      else if (it < 0 && len >= -it) indexSet.add(it + len);
    }
  } else {
    for (let ix = lastIdx; ix >= 0; ix--) {
      const item = indexes[ix];
      if (Array.isArray(item)) {
        const [startX, endX, stepX] = item;
        let start = startX ?? 0;
        if (start < 0) start += len;
        let end = endX ?? len - 1;
        if (end < 0) end += len;
        if ((start < 0 && end < 0) || (start >= len && end >= len)) continue;
        if (start >= len) start = len - 1;
        else if (start < 0) start = 0;
        if (end >= len) end = len - 1;
        else if (end < 0) end = 0;
        if (start === end || stepX >= len) {
          indexSet.add(start);
          continue;
        }
        const step = stepX > 0 ? stepX : -stepX < len ? stepX + len : 1;
        /**
         * ★ `#679` **反向区间要 `i -= step`**（上游 `start downTo end step step`）。
         *
         * 旧实现两个分支都 `i += step`：`end < start` 时（`li[-1:0]`「让列表反向」，
         * 上游注释明写支持）`i >= end` 恒真 ⇒ **死循环**，实测直接
         * `RangeError: Set maximum size exceeded`。之前没炸是因为区间三元组本身被写坏
         * （start/end 都是 curInt ⇒ 恒走 `start === end` 的短路）。
         */
        const stp = step > 0 ? step : 1;
        if (end > start) {
          for (let i = start; i <= end; i += stp) indexSet.add(i);
        } else {
          for (let i = start; i >= end; i -= stp) indexSet.add(i);
        }
      } else {
        const it = item as number;
        if (it >= 0 && it < len) indexSet.add(it);
        else if (it < 0 && len >= -it) indexSet.add(it + len);
      }
    }
  }

  if (split === '!') {
    const kept = elements.filter((_, i) => !indexSet.has(i));
    return kept;
  }
  if (split === '.') {
    const picked: Element[] = [];
    indexSet.forEach((i) => {
      if (i >= 0 && i < len) picked.push(elements[i] as Element);
    });
    return picked;
  }
  return elements;
}

// ---- 属性指令（对齐 getResultLast） ----
/**
 * 末段取值的**唯一**实现（对齐上游 `AnalyzeByJSoup.getResultLast`，:236-295）。
 *
 * ★ `#678` 导出给选择器探针用：查看器的「值模式」必须和引擎**同一口径**。
 * 之前探针自己拿 `getString(tail)` 求值 ⇒ 把 `h3@a` 的末段当**选择器**，回了文字
 * （引擎里 `h3@a` 是 `attr("a")` ⇒ **空**）。用户一眼看出不对：「不是应该 h3@a@text 才匹配到文字么」。
 */
export function getResultLast(elements: Element[], lastRule: string): string[] {
  const textS: string[] = [];
  switch (lastRule) {
    case 'text':
      for (const el of elements) {
        const t = normalizeWs(el.textContent ?? '');
        if (t) textS.push(t);
      }
      break;
    case 'textNodes':
      for (const el of elements) {
        const tn: string[] = [];
        el.childNodes.forEach((n) => {
          if (n.nodeType === 3) {
            const t = (n.textContent ?? '').trim();
            if (t) tn.push(t);
          }
        });
        if (tn.length) textS.push(tn.join('\n'));
      }
      break;
    case 'ownText':
      for (const el of elements) {
        const t = ownText(el);
        if (t) textS.push(t);
      }
      break;
    case 'html': {
      const clone = elements.map((e) => e.cloneNode(true) as Element);
      clone.forEach((e) => {
        e.querySelectorAll('script').forEach((s) => s.remove());
        e.querySelectorAll('style').forEach((s) => s.remove());
      });
      clone.forEach((e) => {
        const h = e.outerHTML;
        if (h) textS.push(h);
      });
      break;
    }
    case 'all':
      for (const el of elements) {
        const h = el.outerHTML;
        if (h) textS.push(h);
      }
      break;
    default:
      for (const el of elements) {
        const url = el.getAttribute(lastRule) ?? '';
        if (!url || textS.includes(url)) continue;
        textS.push(url);
      }
  }
  return textS;
}

// ---- 内部：递归 getElements（@ 分级） ----
function getElementsRec(temp: Element, rule: string): Element[] {
  const rs = rule.split('@');
  let els: Element[] = [temp];
  for (const rl of rs) {
    const next: Element[] = [];
    for (const et of els) next.push(...elementsSingle(et, rl));
    els = next;
  }
  return els;
}

function combineElementLists(lists: Element[][], type: string): Element[] {
  if (type === '%%' && lists.length) {
    const out: Element[] = [];
    const max = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) {
      for (const l of lists) if (i < l.length) out.push(l[i] as Element);
    }
    return out;
  }
  return lists.flat();
}

/** CSS 模式：取 Element 列表（用于 bookList / 目录 容器） */
/** CSS 规则体预处理：
 *  - :matches( → :is(（jsdom 只认新名）
 *  - Legado 默认模式选择器前缀：class.X → .X（X 可含空格 = 多类复合，jsoup getElementsByClass 语义）
 *    id.X → #X · tag.X → X（首段或组合器/括号后生效） */
function normalizeCssBody(body: string): string {
  return body
    .replace(/:matches\(/gi, ':is(')
    .replace(/(^|[\s>+,(\[])class\.([\w\-]+(?:\s+[\w\-]+)*)/g, (_m, p: string, names: string) =>
      p + names.split(/\s+/).map((c) => '.' + c).join(''))
    .replace(/(^|[\s>+,(\[])id\.([\w-]+)/g, '$1#$2')
    .replace(/(^|[\s>+,(\[])tag\.([\w-]+)/g, '$1$2');
}

/** 提取尾部 :eq(N)（jsoup/jQuery 语法，jsdom 不认）→ { sel, eq }；eq=null 表示无 */
function extractEq(sel: string): { sel: string; eq: number | null } {
  const m = sel.match(/:eq\((\d+)\)\s*$/i);
  if (!m) return { sel, eq: null };
  return { sel: sel.slice(0, m.index), eq: Number(m[1]) };
}

/** jsdom 容错查询：非法选择器返回空（源可走 || 兜底规则），不炸整源 */
function safeQSA(root: Element, sel: string): Element[] {
  try {
    // jsoup 专有伪类（:eq/:gt/:lt/:contains/:matches/:has+文本）由兼容层接管——
    // nwsapi 对 `:contains` 是**语法接受、恒不匹配**（静默空），必须自己算
    return selectJsoup(root, sel);
  } catch {
    return [];
  }
}

export function cssGetElements(rule: string, roots: Element[], _env: AnalyzeEnv): Element[] {
  const isCss = rule.startsWith("@CSS:") || rule.startsWith("@css:");
  const { sel: ruleBody, eq } = extractEq(quoteAttrValues(normalizeCssBody(isCss ? rule.slice(5).trim() : rule)));
  const { parts, type } = splitCombinator(ruleBody);
  const lists: Element[][] = [];
  for (const part of parts) {
    if (!part) continue;
    let el: Element[];
    if (isCss) {
      const lastAt = part.lastIndexOf('@');
      const sel = lastAt === -1 ? part : part.slice(0, lastAt);
      el = roots.flatMap((r) => safeQSA(r, sel));
      if (eq !== null && parts.length === 1) el = [el[eq]].filter((x): x is Element => !!x);
    } else {
      el = roots.flatMap((r) => getElementsRec(r, part));
    }
    if (el.length) {
      lists.push(el);
      if (type === '||') break;
    }
  }
  return combineElementLists(lists, type);
}

/**
 * CSS 模式：取字符串列表（每段按 getResultLast 取属性）
 *
 * 属性指令（@ 之后的最后一段）语义对齐 Legado AnalyzeByJSoup：
 *   - 无 @  → 默认取元素文本（text）
 *   - @text / @textNodes / @ownText / @html / @all → 对应取文本/HTML
 *   - @任意字符串 → 取该属性（href / src / ...）
 * 非 @CSS: 模式下，@ 之前的段为逐级下降选择器（.a@.b@href → a 内找 b 取 href）。
 */
/**
 * `#771` 冻结探针（默认关）：CSS/jsoup 选择是**同步**的，一个目录页上会被调用
 * 章数×字段数次（七猫 940×6），包一层标记即可把「停摆落在选择器里」与「落在 await 里」分开。
 */
export function cssGetStringList(rule0: string, roots: Element[], _env: AnalyzeEnv): string[] {
  probeEnter('css:get');
  // `#773` 临时取证（默认关）：把「哪条规则、几个根、几毫秒、出几个值」打出来。
  // 目录页上本函数按 章数×字段数 调用（sudu guu 999 章实测 9193 次），不定位到规则就压不下来。
  const trace = process.env.YUEDU_CSS_TRACE === '1';
  const t0 = trace ? performance.now() : 0;
  try {
    const out = cssGetStringListInner(rule0, roots, _env);
    if (trace) {
      console.log(`[css-op] rule=${JSON.stringify(rule0.slice(0, 60))} roots=${roots.length} out=${out.length} ${(performance.now() - t0).toFixed(1)}ms`);
    }
    return out;
  } finally {
    probeLeave();
  }
}

function cssGetStringListInner(rule0: string, roots: Element[], _env: AnalyzeEnv): string[] {
  // Legado RuleAnalyzer.trim()：规则开头的 `@`/空白先剥掉（`@href` → `href`、`@text` → `text`）。
  // 不剥的话 `rs = '@href'.split('@')` 会产生空下降段 → 落到「取子元素」的兜底，取到子节点属性（错值）。
  const isCssRule = rule0.startsWith('@CSS:') || rule0.startsWith('@css:');
  const rule = isCssRule ? rule0 : rule0.replace(/^[@\s]+/, '');
  // Legado 语义（AnalyzeByJSoup.getResultList/getResultLast）：
  // 规则最后一个 @ 段（无 @ 则整条）是「关键字」或「属性名」——
  //   · 关键字 text/textNodes/ownText/html/all → 内建语义
  //   · 其余一律 element.attr(token)  ← chapterUrl:"href" / isVolume:"isv" / isVip:"@class"
  // 单 token 且非关键字时优先按属性取；取不到再按旧行为（当选择器取文本）兜底，避免回归。
  const token = rule.trim();
  if (roots.length > 0 && SINGLE_TOKEN_RE.test(token)) {
    const name = token.replace(/^@+/, '');
    if (GET_RESULT_KEYWORD_RE.test(name)) return getResultLast(roots, name).filter((s) => s !== '');
    if (name === 'outerHtml') return getResultLast(roots, 'all').filter((s) => s !== ''); // 非 Legado 关键字，宽松兼容
    const attrs = getResultLast(roots, name).filter((s) => s !== '');
    if (attrs.length) return attrs;
    // 属性为空 → 继续走下面的 CSS 选择器路径（tag 名之类的历史行为）
  }
  const isCss = rule.startsWith("@CSS:") || rule.startsWith("@css:");
  const { sel: ruleBody, eq } = extractEq(quoteAttrValues(normalizeCssBody(isCss ? rule.slice(5).trim() : rule)));
  if (ruleBody === '') return roots.map((r) => r.textContent ?? '').filter(Boolean);
  const { parts, type } = splitCombinator(ruleBody);
  const results: string[][] = [];
  for (const part of parts) {
    if (!part) continue;
    let textS: string[];
    if (isCss) {
      const lastAt = part.lastIndexOf('@');
      const sel = lastAt === -1 ? part : part.slice(0, lastAt);
      const prop = lastAt === -1 ? 'text' : part.slice(lastAt + 1);
      let els = roots.flatMap((r) => safeQSA(r, sel));
      if (eq !== null && parts.length === 1) els = [els[eq]].filter((x): x is Element => !!x);
      textS = getResultLast(els, prop);
    } else {
      const rs = part.split('@');
      const property = rs.length > 1 ? (rs[rs.length - 1] as string) : 'text';
      const descent = rs.length > 1 ? rs.slice(0, -1) : rs;
      let els: Element[] = [...roots];
      for (const ds of descent) {
        const next: Element[] = [];
        for (const et of els) next.push(...elementsSingle(et, ds));
        els = next;
      }
      textS = getResultLast(els, property);
    }
    if (textS.length) {
      results.push(textS);
      if (type === '||') break;
    }
  }
  if (type === '%%' && results.length) {
    const out: string[] = [];
    const max = Math.max(...results.map((r) => r.length));
    for (let i = 0; i < max; i++) for (const r of results) if (i < r.length) out.push(r[i] as string);
    return out;
  }
  return results.flat();
}

/** CSS 模式：取单个字符串（多段用 \n 连接，对齐 AnalyzeByJSoup.getString） */
export function cssGetString(rule: string, roots: Element[], env: AnalyzeEnv, isUrl = false): string {
  // cssGetStringList 内部已做 :matches( → :is( 预处理
  const list = cssGetStringList(rule, roots, env);
  if (list.length === 0) return '';
  if (isUrl) {
    const first = list.find((s) => s.trim() !== '');
    return env.toAbsolute ? env.toAbsolute(first ?? '') : first ?? '';
  }
  return list.length === 1 ? list[0] as string : list.join('\n');
}
