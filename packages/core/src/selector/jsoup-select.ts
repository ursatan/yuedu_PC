/**
 * jsoup 选择器兼容层（Legado 的 CSS 规则全部经 jsoup，不是标准 CSS）。
 *
 * 为什么必须自己实现：jsdom 的 nwsapi 对这些 jsoup 专有伪类的处理是**最坏形态**——
 *   · `:eq/:gt/:lt/:matches/:matchesOwn/:containsOwn` → **抛** `SyntaxError: Unknown pseudo-class`
 *     （行为可见，至少不是静默）；
 *   · `:contains(...)` → **语法接受、恒不匹配**（实测 `li:contains(苹果)` 返回 0 条，不报错）
 *     → 「正文下一页找 `:contains(下一页)`」这类规则**静默少内容**，是最难发现的一类。
 * 语料实测：`:contains` 19 源 / 38 次、`:eq` 10 源 / 25 次、`:matchesOwn` 1 源 / 37 次、
 * `:matches` 2 源 / 30 次、`:gt` 1 源；其中 **15 处文本伪类嵌在 `:has(...)` 里**。
 *
 * 语义全部照 jsoup 源码抄（不自由发挥）：
 *   · `:eq(n)/:gt(n)/:lt(n)`（`QueryParser` → `Evaluator.IndexEquals/…`）：
 *     **以 `elementSiblingIndex()`（父元素下的元素兄弟序号，0 基）为准**，不是「匹配结果集里的下标」！
 *     因此可以**精确改写为标准 CSS**：`elementSiblingIndex()==n` ⟺ `:nth-child(n+1)`（CSS 的
 *     nth-child 也是按元素兄弟、但 1 基）。索引必须是非负数字，否则 jsoup 抛 SelectorParseException。
 *     `:lt` 还额外要求 `root != element`（选择起点自身永不匹配）——改成 CSS 后天然满足（查询只搜后代）。
 *   · `:contains(text)/:containsOwn(text)`：搜索串**去空白折叠**后与元素文本**双双小写**再 contains；
 *     参数按 jsoup 那样只做反斜杠 unescape（**不剥引号**：`:contains('万字')` 在 jsoup 里就是找
 *     含引号的字面量，照抄）。
 *   · `:matches(re)/:matchesOwn(re)`：`Pattern.compile(regex)` **无标志**（`helper/Regex.compile`）→
 *     **区分大小写**；匹配用 `matcher().find()`（非整串锚定）。
 *   · `:has(inner)`：nwsapi 原生支持，**只有**当 inner 里含文本伪类时才由本层接管（递归求值）。
 */

/** 文本类伪类（必须在 JS 里过滤，CSS 无法表达） */
const TEXT_PSEUDO_RE = /:(?:contains|containsOwn|matches|matchesOwn)\s*\(/;
/** 索引类伪类（可改写为 :nth-child） */
const INDEX_PSEUDO_RE = /:(?:eq|gt|lt)\s*\(/;
/** 属性选择器里的 jsoup 专有运算符（`~=` 正则 / `!=` 取反）—— CSS 里没有等价语义 */
const ATTR_OP_RE = /\[[^\]]*(?:~=|!=)/;

/** 选择器里是否含任何 jsoup 专有伪类（用于快速判断走不走本层） */
export function hasJsoupPseudo(selector: string): boolean {
  return INDEX_PSEUDO_RE.test(selector) || TEXT_PSEUDO_RE.test(selector);
}

/** 该选择器是否必须走 JS 过滤路径（索引类可纯 CSS 改写，不需要） */
export function needsJsoupFilter(selector: string): boolean {
  return TEXT_PSEUDO_RE.test(selector) || ATTR_OP_RE.test(selector);
}

/**
 * 属性选择器「未加引号的值」兼容（缺陷类别 **类BP**）。
 *
 * 为什么必须做：jsoup **允许**属性选择器的值不加引号，标准 CSS **不允许**。
 *   上游出处（jsoup 1.16.2 `select/QueryParser.byAttribute()`，逐字）：
 *     TokenQueue cq = new TokenQueue(tq.chompBalanced('[', ']'));
 *     String key = cq.consumeToAny(AttributeEvals);   // "=", "!=", "^=", "$=", "*=", "~="
 *     cq.consumeWhitespace();
 *     if (cq.matchChomp("=")) eval = new Evaluator.AttributeWithValue(key, cq.remainder());
 *   值一律取 `cq.remainder()` = 运算符之后**到 `]` 为止的全部字符**（中间不消费空白、不剥引号）
 *   ⇒ `[property=og:novel:book_name]` 里的冒号**不是**分隔符，jsoup 完全接受。
 *   nwsapi 则要求未加引号的值必须是 CSS 标识符 ⇒ 值含 `:`/`.`/空格等即抛
 *   `Error: Invalid selector meta[property=og:novel:book_name]`（哔哩轻小说搜索 JS 规则实测）。
 *
 * 修法：只给**未加引号**的值补引号（已加引号的原样保留）。值内含 `|` 时拆成
 * `:is([a=v1],[a=v2])`（历史行为，勿改：语料里 `[href~=^javascript:|^#]` 这类写法依赖它）。
 *
 * ⚠️ 本函数只解决「nwsapi 能不能解析」。`~=` / `!=` 的**比较语义**差异由 `parseJsoupAttrOp`
 * 用 JS 求值解决（类BQ）—— 因此这里见到 `~=` 一律**不碰**（见下）。
 */
export function quoteAttrValues(sel: string): string {
  return sel.replace(/\[([\w-]+)([~^$*|]?)=([^\[\]"']+)\]/g, (m, name: string, op: string, val: string) => {
    // 类BQ：`~=` 的值是**正则**，交给 parseJsoupAttrOp 求值。这里绝不能动 ——
    // 一按 `|` 拆就把正则的「交替」语义拆没了（如 `[href~=^#|javascript:]`）。
    // （`!=` 因 `!` 不在运算符字符集里，天然不会被本正则命中。）
    if (op === '~') return m;
    const v = val.trim();
    if (v.startsWith('"') || v.startsWith("'")) return m;
    if (v.includes('|')) {
      const parts = v.split('|').filter(Boolean).map((x) => `[${name}${op}="${x}"]`);
      return parts.length > 1 ? `:is(${parts.join(',')})` : parts[0] ?? m;
    }
    return `[${name}${op}="${v}"]`;
  });
}

/**
 * jsoup **专有属性运算符** —— 标准 CSS 没有等价语义，必须用 JS 求值（缺陷类别 **类BQ**）。
 *
 * 上游出处（jsoup 1.16.2，逐字）：
 *   · `QueryParser.byAttribute()`：`cq.matchChomp("~=")` → `cp.remainder()` 原样作 Pattern
 *     （`new Evaluator.AttributeWithValueMatching(key, Pattern.compile(cq.remainder()))`）
 *   · `Evaluator.AttributeWithValueMatching.matches()`：
 *       `return element.hasAttr(key) && pattern.matcher(element.attr(key)).find();`
 *     ⇒ **正则、find（非整串）、大小写敏感、attr 不做 trim**。
 *     CSS 的 `~=` 却是「空白分词后某一项精确等于」⇒ 语义完全不同。
 *     实测语料：`[href~=\S]`（就去看网）、`[property~=category|status|update_time]`（44 次）、
 *     `[src~=(?i)\.png]`、`[property~=category$]`（带锚点）—— 交给 CSS 全是**静默空**。
 *   · `Evaluator.AttributeWithValueNot.matches()`：`return !value.equalsIgnoreCase(element.attr(key));`
 *     ⇒ 取反、**不检查 hasAttr**（无该属性者反而匹配）、attr 不 trim；CSS 无 `!=`（nwsapi 直接抛）。
 *
 * 返回 null ⇒ 不是这两种运算符，交回 CSS 原生执行。
 */
function parseJsoupAttrOp(inner: string): Filter | null {
  const m = /^\s*([\w:.-]+)\s*(~=|!=)([\s\S]*)$/.exec(inner);
  if (!m) return null;
  const key = m[1] as string;
  const op = m[2] as string;
  let raw = m[3] as string;
  // jsoup `AttributeKeyPair`：**首尾同为同一种引号**才剥（`'a"` 不剥）
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (raw.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    raw = raw.slice(1, -1);
  }
  if (op === '!=') {
    const v = raw.trim().toLowerCase();
    return (el) => (el.getAttribute(key) ?? '').toLowerCase() !== v;
  }
  let re: RegExp;
  try {
    // 无标志 Pattern：内联 `(?i)` 等由 compileJsoupRegex 提取成 JS flags（与 :matches 同一策略）
    re = compileJsoupRegex(raw);
  } catch {
    throw new Error(`Pattern syntax error in [${key}~=${raw}]`);
  }
  return (el) => el.hasAttribute(key) && re.test(el.getAttribute(key) ?? '');
}

/** jsoup `StringUtil.normaliseWhitespace`：空白折叠为单个空格并 trim */
function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 逐字符扫描的「代码位」判定：跳过引号内与 `[]` 属性选择器内的内容 */

/**
 * `:eq(n)` → `:nth-child(n+1)`；`:gt(n)` → `:nth-child(n+2)`；`:lt(n)` → `:nth-child(-n+n)`。
 * （CSS 位置从 1 开始：0 基下标 i 对应位置 i+1）
 */
export function rewriteIndexPseudos(selector: string): string {
  if (!INDEX_PSEUDO_RE.test(selector)) return selector;
  let out = '';
  let i = 0;
  let quotes = '';
  let brackets = 0;
  while (i < selector.length) {
    const ch = selector[i] as string;
    if (quotes) {
      out += ch;
      if (ch === '\\') {
        out += selector[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quotes) quotes = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quotes = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '[') brackets++;
    if (ch === ']') brackets = Math.max(0, brackets - 1);
    if (brackets === 0 && ch === ':') {
      const m = /^:(eq|gt|lt)\(\s*(\d+)\s*\)/.exec(selector.slice(i));
      if (m) {
        const n = Number(m[2]);
        const css =
          m[1] === 'eq'
            ? `:nth-child(${n + 1})` // 精确位置（0 基序号 n ⟺ CSS 1 基位置 n+1）
            : m[1] === 'gt'
              ? `:nth-child(n+${n + 2})` // 位置 ≥ n+2 ⟺ 序号 > n
              : `:nth-child(-n+${n})`; // 位置 ≤ n ⟺ 序号 < n
        out += css;
        i += m[0].length;
        continue;
      }
      // 数字非法（负数/非数字）→ jsoup 抛 SelectorParseException，这里同样抛，别静默放行
      const bad = /^:(eq|gt|lt)\(([^)]*)\)/.exec(selector.slice(i));
      if (bad) {
        throw new Error(`Index must be numeric: ${bad[0]}`);
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 编译 jsoup/Java 风格正则。
 *
 * ⚠️ Java 允许**内联标志**（`(?i)` / `(?s)` / `(?m)` 前缀，以及 `(?i:...)` 分组），
 * 而 JS（Node 22 前）不支持 → 直接用 `new RegExp` 会抛 `Invalid group`。
 * 语料里确有 `:matches((?i)…)` 写法，所以把内联标志**提取为外部 flags**；
 * `(?i:...)` 分组降级为 `(?:...)` 并把标志提到整体（略宽于 Java 的作用域，已在注释留痕）。
 */
function compileJsoupRegex(raw: string): RegExp {
  let pattern = raw;
  let flags = '';
  const lead = /^\(\?([ims]+)\)/.exec(pattern);
  if (lead) {
    flags += lead[1] as string;
    pattern = pattern.slice(lead[0].length);
  }
  const inline = /\(\?([ims]+):/.exec(pattern);
  if (inline) {
    flags += inline[1] as string;
    pattern = pattern.replace(/\(\?[ims]+:/g, '(?:');
  }
  const uniq = Array.from(new Set(flags.split(''))).join('');
  return new RegExp(pattern, uniq);
}

/** 取出配平的括号内容：返回 [内容, 结束下标+1] */
function readParens(s: string, openIdx: number): [string, number] {
  let depth = 0;
  let quotes = '';
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i] as string;
    if (quotes) {
      if (ch === '\\') i++;
      else if (ch === quotes) quotes = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quotes = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return [s.slice(openIdx + 1, i), i + 1];
    }
  }
  return [s.slice(openIdx + 1), s.length];
}

/** 取出配平的 `[...]` 内容：返回 [内容, 结束下标+1] */
function readBrackets(s: string, openIdx: number): [string, number] {
  let depth = 0;
  let quotes = '';
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i] as string;
    if (quotes) {
      if (ch === '\\') i++;
      else if (ch === quotes) quotes = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quotes = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return [s.slice(openIdx + 1, i), i + 1];
    }
  }
  return [s.slice(openIdx + 1), s.length];
}

/** jsoup `TokenQueue.unescape`：只处理反斜杠转义，**不动引号** */
function unescapeJsoup(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** 元素全文本（jsoup `Element.text()` ≈ 后代文本按空白折叠） */
function textOf(el: Element): string {
  return normWs(el.textContent ?? '');
}

/** 元素自有文本（jsoup `Element.ownText()`：仅直接子文本节点） */
function ownTextOf(el: Element): string {
  let out = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) out += n.nodeValue ?? '';
  }
  return normWs(out);
}

type Filter = (el: Element) => boolean;

/** 顶层切分组合子（后代/子/相邻/兄弟），返回 [组合子, 片段] 列表 */
function splitSteps(sel: string): Array<{ comb: ' ' | '>' | '+' | '~'; part: string }> {
  const out: Array<{ comb: ' ' | '>' | '+' | '~'; part: string }> = [];
  let buf = '';
  let pending: ' ' | '>' | '+' | '~' = ' ';
  /** 上一个 token 是显式组合子（此时后续空格不再解释为「后代」） */
  let explicit = false;
  let quotes = '';
  let brackets = 0;
  let parens = 0;
  const flush = (): void => {
    const part = buf.trim();
    buf = '';
    if (part) out.push({ comb: pending, part });
    if (part) explicit = false;
    pending = ' ';
  };
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i] as string;
    if (quotes) {
      buf += ch;
      if (ch === '\\') {
        buf += sel[i + 1] ?? '';
        i++;
      } else if (ch === quotes) quotes = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quotes = ch;
      buf += ch;
      continue;
    }
    if (ch === '[') brackets++;
    if (ch === ']') brackets = Math.max(0, brackets - 1);
    if (ch === '(') parens++;
    if (ch === ')') parens = Math.max(0, parens - 1);
    if (brackets === 0 && parens === 0) {
      if (ch === '>' || ch === '+' || ch === '~') {
        flush();
        pending = ch;
        explicit = true;
        continue;
      }
      if (/\s/.test(ch)) {
        if (buf.trim()) flush();
        else if (!explicit) pending = ' ';
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return out;
}

/** 从一个片段里剥离文本伪类，返回 [CSS 片段, 过滤器] */
function stripTextPseudos(part: string): { css: string; filters: Filter[] } {
  // 无事可做 ⇒ 只做「未加引号值补引号」（类BP）后原样返回
  if (!TEXT_PSEUDO_RE.test(part) && !ATTR_OP_RE.test(part)) return { css: quoteAttrValues(part), filters: [] };
  const filters: Filter[] = [];
  let css = '';
  let i = 0;
  while (i < part.length) {
    const ch = part[i] as string;
    if (ch === '[') {
      // 属性选择器：`~=` / `!=`（jsoup 专有语义，类BQ）抽出成过滤器，其余整段照抄
      // （内部可能有 ':'，如 [href^="http:"]；`~=` 的值是正则，不能补引号）
      const [inner, end] = readBrackets(part, i);
      const op = parseJsoupAttrOp(inner);
      if (op) {
        filters.push(op);
      } else {
        css += part.slice(i, end);
      }
      i = end;
      continue;
    }
    if (ch === ':') {
      const m = /^:(contains|containsOwn|matches|matchesOwn|has)\(/.exec(part.slice(i));
      if (m) {
        const kind = m[1] as string;
        const [raw, end] = readParens(part, i + m[0].length - 1);
        if (kind === 'has') {
          // inner 里含文本伪类或 jsoup 专有属性运算符时才接管；否则留给 nwsapi 原生 :has()
          if (TEXT_PSEUDO_RE.test(raw) || ATTR_OP_RE.test(raw)) {
            const inner = raw.trim();
            filters.push((el) => collectHas(el, inner).length > 0);
          } else {
            css += part.slice(i, end);
          }
        } else if (kind === 'contains' || kind === 'containsOwn') {
          const needle = normWs(unescapeJsoup(raw)).toLowerCase();
          const pick = kind === 'contains' ? textOf : ownTextOf;
          filters.push((el) => pick(el).toLowerCase().includes(needle));
        } else {
          // :matches / :matchesOwn —— jsoup 用无标志 Pattern + matcher().find()
          let re: RegExp;
          try {
            re = compileJsoupRegex(raw);
          } catch {
            // 正则语法错：jsoup 抛 ValidationException，这里抛更直白的信息
            throw new Error(`Pattern syntax error in :${kind}(${raw})`);
          }
          const pick = kind === 'matches' ? textOf : ownTextOf;
          filters.push((el) => re.test(pick(el)));
        }
        i = end;
        continue;
      }
    }
    css += ch;
    i++;
  }
  // 类BP：留在 CSS 里的属性选择器（非 `~=`）统一补引号，nwsapi 才不抛 Invalid selector
  return { css: quoteAttrValues(css).trim() || '*', filters };
}

/** `:has(inner)` 递归求值（支持 jsoup 的相对首组合子 `>` / `+` / `~`） */
function collectHas(el: Element, inner: string): Element[] {
  const s = rewriteIndexPseudos(inner.trim());
  const lead = /^[>+~]/.exec(s)?.[0] as '>' | '+' | '~' | undefined;
  if (lead === '>') return Array.from(el.children).filter((c) => matchesAny(c, s.slice(1)));
  if (lead === '+') {
    const nx = el.nextElementSibling;
    return nx && matchesAny(nx, s.slice(1)) ? [nx] : [];
  }
  if (lead === '~') {
    const out: Element[] = [];
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (matchesAny(n, s.slice(1))) out.push(n);
    return out;
  }
  return selectJsoup(el, s);
}

/** 单元素是否匹配选择器（含 jsoup 伪类） */
function matchesAny(el: Element, selector: string): boolean {
  // 补引号（类BP）在 stripTextPseudos 内部完成 —— 因为它要先抽出 `~=`/`!=` 再给其余值补引号
  const { css, filters } = stripTextPseudos(rewriteIndexPseudos(selector.trim()));
  if (css !== '*' && !el.matches(css)) return false;
  return filters.every((f) => f(el));
}

/**
 * 供 CSS 引擎的「自身匹配」分支使用（jsoup 的 select 从根自身开始遍历，需显式补 self）。
 * 容错：非法选择器（含非数字 `:eq(x)`）返回 false —— 由调用方决定是否整体兜底。
 */
export function matchesJsoup(el: Element, selector: string): boolean {
  try {
    return matchesAny(el, selector);
  } catch {
    return false;
  }
}

function dedupe(list: Element[]): Element[] {
  const seen = new Set<Element>();
  const out: Element[] = [];
  for (const el of list) {
    if (seen.has(el)) continue;
    seen.add(el);
    out.push(el);
  }
  return out;
}

/**
 * `#644` **根节点自身是否命中选择器**。
 *
 * jsoup 的 `Element.select(query)` = `Selector.select(query, this)`，内部
 * `NodeTraversor.traverse(root)` **从 root 自己开始** ⇒ 根节点匹配也算命中。
 * DOM 的 `querySelectorAll` 只搜后代，不等价 —— 必须在外面补这一格。
 *
 * 判据刻意收窄成「**裸标签选择器**」（`html` / `body` / `div`…）：
 *  · 组合选择器（`div p` / `.a .b`…）在 jsoup 里是「**从根自身开始的组合**」，
 *    语义与本处补 self 的等价性要逐级递推，本轮不做（留挂账）；
 *  · **只对真元素判定**（`nodeType === 1`）——字符串包装没有 nodeType，
 *    这样「只调字符串方法」的场景**不会被迫 parseHtml**（那段每次求值约 2MB，见 `#198`）。
 */
const BARE_TAG_RE = /^[a-zA-Z][\w-]*$/;
function rootMatches(root: Element, css: string): boolean {
  if ((root as unknown as { nodeType?: number })?.nodeType !== 1) return false;
  if (!BARE_TAG_RE.test(String(css ?? '').trim())) return false;
  try {
    return root.matches(css);
  } catch {
    return false;
  }
}

/**
 * `#703` **祖先感知的作用域查询** —— jsoup `Element.select` 的真实语义，nwsapi 做不到。
 *
 * ## 缺陷（用户实测：精华书阁手机版 V2，`@css:` 规则全空）
 * 该源的行内规则写成**从文档根开始的完整路径**（语料里很常见）：
 * ```
 * ruleSearch.name     = @css:html > body > div.searchbook > div.bookinfo > h4.bookname a@text
 * ruleBookInfo.author = @css:html > body > div.cover > div.block > … > p:nth-of-type(2)@text
 * ```
 * 列表规则 `@css:div.searchbook` 能命中 13 项，**但每一项的书名/作者/封面全是空** ⇒ 整源「搜索失效」。
 *
 * 根因在「作用域」这一层的语义差：
 *  · **jsoup**（上游 Legado 用的）：候选集限定在 `root` 子树内，但**祖先链是整棵文档树**的
 *    （`Collector.collect(evaluator, root)` 只遍历子树，而 `ImmediateParentRun` 等求值器
 *    用 `element.parent()` 一路向上，**可以走到 root 之外**）⇒ `html > body > div.searchbook > …`
 *    在「root = div.searchbook」时照样命中。
 *  · **DOM/nwsapi**（本仓此前用的 `root.querySelectorAll(sel)`）：把 root 当**作用域根**，
 *    选择器里的 `html`/`body` 必须在 root 之内才可能匹配 ⇒ 恒 0。
 *
 * 实测（`tmp/probe703-css.mts`，真实搜索页）：
 * ```
 * doc.querySelectorAll(完整路径)      = 13
 * item.querySelectorAll(完整路径)     = 0     ← 本仓旧行为
 * item.querySelectorAll('div.bookinfo > h4.bookname a') = 1
 * ```
 *
 * ## 做法
 * 对**已连接**的元素根，先在整个文档上求值一次（缓存），再按子树过滤 —— 这与 jsoup 的
 * 候选集语义**完全等价**（jsoup 也不会命中 root 之外的兄弟节点）。
 *
 * 性能：文档级查询按 `(doc, selector)` 缓存；过滤用「每个匹配项沿祖先链入桶」的预处理
 * （一次 O(匹配数 × 深度)），此后对同一 root 的取用是 O(1)。1000 章 × 同一选择器也不会变成 O(N²)。
 *
 * ⚠️ 只对 `nodeType === 1` 且 `isConnected` 的元素生效。脚本里 `document.createElement`
 * 造出来的游离节点退回子树查询（文档查询根本看不到它们，过滤只会得到空）。
 */
/**
 * 文档级结果**不缓存**：DOM 是会变的（源脚本 `Elements.remove()` 会回写文档、渲染层会插节点），
 * 缓存一条 `(doc, selector) → 结果` 很容易拿到已删除的节点。实测回归：`#333` 的两条用例
 * 就是「删完再查还是旧结果」。
 */
function underRoot(all: Element[], root: Element): Element[] {
  const out: Element[] = [];
  // ⚠️ `root.contains(root)` 是 true（DOM 规范），必须显式排掉自己：
  // 「根自身是否算命中」是 `rootMatches`（`#644`，只对裸标签）管的，别在这里顺手放开 ——
  // 放开会让 `element.select('.x')` 在 root 自己也匹配时多出一条（实测 `#523` 的值重复成两行）。
  for (const m of all) if (m !== root && root.contains(m)) out.push(m);
  return out;
}

/** `root` 作用域内的全部匹配（祖先感知；游离节点退回子树查询） */
function queryAllUnder(root: Element, css: string): Element[] {
  const nodeType = (root as unknown as { nodeType?: number }).nodeType;
  if (nodeType === 9) {
    try {
      return Array.from((root as unknown as Document).querySelectorAll(css));
    } catch {
      return [];
    }
  }
  const doc = root.ownerDocument;
  if (nodeType !== 1 || !doc || !root.isConnected) {
    // 游离元素 / 字符串包装：文档查询看不见它，只能查子树
    try {
      return Array.from(root.querySelectorAll(css));
    } catch {
      return [];
    }
  }
  /**
   * 快路径：先按**子树**查（与加这层之前完全一致）。
   *
   * 为什么要先查一遍再考虑祖先：绝大多数规则（`.bookinfo h4 a` / `ul.chapter > li`…）
   * 在子树内就能命中，此时结果与「文档级 + 过滤」**完全相同**，没必要付整篇查询的钱。
   * 实测（`tmp/probe703-perf.mts`，1000 项 × 全路径选择器）：子树 83ms / 每项重查文档 **4867ms**。
   */
  let scoped: Element[] = [];
  try {
    scoped = Array.from(root.querySelectorAll(css));
  } catch {
    scoped = [];
  }
  if (scoped.length) return scoped;
  /**
   * 慢路径：子树 0 命中 ⇒ 这条选择器可能**引用了 root 之外的祖先**（`html > body > …`）。
   * 整篇求值一次再按子树过滤 —— 这正是 jsoup 的候选集语义（候选在子树内，祖先看全树）。
   *
   * ⚠️ **不做缓存**：DOM 会变（源脚本 `Elements.remove()` 回写文档），缓存一条
   * `(doc, selector) → 结果` 很容易拿到已删除的节点（实测 `#333` 两条用例就是「删完再查还是旧的」）。
   */
  let all: Element[] = [];
  try {
    all = Array.from(doc.querySelectorAll(css));
  } catch {
    return [];
  }
  return underRoot(all, root);
}

/**
 * jsoup 语义的 `select`：`root` 的**后代**中匹配者（与 `Element.select` 一致，不含自身）。
 * 无 jsoup 伪类时与 `root.querySelectorAll` 完全等价（零额外开销 / 零行为变化）。
 *
 * ★ **更正（`#644`）**：上面那句「不含自身」是**错的**，jsoup 的 `Element.select` 是
 * **从 `root` 自己开始遍历**（`Collector.collect` 走 `NodeTraversor.traverse(root)`，
 * 根节点本身也是候选）⇒ 真 jsoup 里 `doc.select("html")` 命中 1 个。
 * 而我们套的是 DOM `root.querySelectorAll()`，它**只搜后代、永不含自身**
 * ⇒ `@css:html` 恒 0（搬山人正文规则正是靠这一句判「网页拿到了没」）。
 *
 * 修法：`querySelectorAll` 的结果**前面补上「自身是否命中」**（见 rootMatches）。
 * 只在无 jsoup 伪类时走（另一条路自己逐级走，同样补了自身，见下面 `si === 0` 分支）。
 */
export function selectJsoup(root: Element, selector: string): Element[] {
  const sel = selector.trim();
  if (!sel) return [];
  const rewritten = rewriteIndexPseudos(sel);
  // 快路径无需抽 `~=`/`!=`（needsJsoupFilter 已排除），只需补引号（类BP）
  if (!needsJsoupFilter(rewritten)) {
    const q = quoteAttrValues(rewritten);
    // `#703` 祖先感知（jsoup 语义）：不能用 `root.querySelectorAll` —— 它会把 root 当作用域根，
    // `html > body > …` 这类「从文档根写起」的规则在行内求值时恒 0
    const list = queryAllUnder(root, q);
    return rootMatches(root, q) ? [root, ...list] : list;
  }

  let cur: Element[] = [root];
  const steps = splitSteps(rewritten);
  for (let si = 0; si < steps.length; si++) {
    const st = steps[si] as { comb: ' ' | '>' | '+' | '~'; part: string };
    const { css, filters } = stripTextPseudos(st.part);
    const comb = si === 0 ? ' ' : st.comb;
    let picked: Element[];
    // `#644`：第一步的「后代」要**带上 root 自己**（jsoup `Element.select` 语义）
    if (comb === ' ') {
      // `#703` 同样要祖先感知：第一步的 `css` 可能就是 `html > body > div.x`
      picked = cur.flatMap((e) => (rootMatches(e, css) ? [e, ...queryAllUnder(e, css)] : queryAllUnder(e, css)));
    }
    else if (comb === '>') picked = cur.flatMap((e) => Array.from(e.children).filter((c) => c.matches(css)));
    else if (comb === '+') picked = cur.map((e) => e.nextElementSibling).filter((x): x is Element => !!x && x.matches(css));
    else {
      picked = cur.flatMap((e) => {
        const out: Element[] = [];
        for (let n = e.nextElementSibling; n; n = n.nextElementSibling) if (n.matches(css)) out.push(n);
        return out;
      });
    }
    cur = filters.length ? dedupe(picked).filter((el) => filters.every((f) => f(el))) : dedupe(picked);
  }
  return cur;
}

/** 多根场景（规则桥里 `els.flatMap(...)`）：等价于对每个根做一次 jsoup select */
export function selectJsoupFrom(roots: Element[], selector: string): Element[] {
  if (!roots.length) return [];
  const rewritten = rewriteIndexPseudos(selector.trim());
  // 类BP：Elements 桥的 `doc.select('meta[property=og:x]')` 走的就是这条路径 ⇒ 快路径也要补引号
  if (!needsJsoupFilter(rewritten)) {
    return roots.flatMap((e) => Array.from(e.querySelectorAll(quoteAttrValues(rewritten))));
  }
  return dedupe(roots.flatMap((e) => selectJsoup(e, selector)));
}
