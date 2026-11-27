/**
 * 规则切分与模式识别
 *
 * 对照源码：
 *   - AnalyzeRule.splitSourceRule  / 内部类 SourceRule.init   （JS/模式识别）
 *   - RuleAnalyzer.splitRule                                （&& || %% 平衡组切分）
 *   - AppPattern.JS_PATTERN / evalPattern                   （<js>/{{}} 切分）
 *
 * 关键约束（源码里有，但极易写错）：
 *   - && || %% 不能破坏 [] / () 内的分隔符（平衡组感知）。
 *   - <js>...</js> 与 @js: 是 JS 段；其余按前缀/内容识别模式。
 *   - @put:{...} 在 SourceRule.init 阶段就剥离，键写入 putMap，值稍后作为规则求值。
 */

import type { RuleMode } from './types';

// <js>...</js> | @js:...   （大小写不敏感，对齐 AppPattern.JS_PATTERN）
const JS_RE = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
// @webjs:...（>=5 字符）
const WEBJS_RE = /@webjs:([\w\W]{5,})/gi;
// @put:{...}   （对齐 AppPattern.putPattern）
const PUT_RE = /@put:(\{[^}]+\})/gi;
// {{...}} 或 @get:{...}   （对齐 AppPattern.evalPattern，带捕获组供复合段用）
const EVAL_RE = /@get:\{([^}]+)\}|\{\{[\w\W]*?\}\}/gi;
// `$n` 组引用（对齐 `AnalyzeRule.kt:1030` 的 `regexPattern = "\\$\\d{1,2}"`）
const GROUP_REF_RE = /\$(\d{1,2})/g;

/** 复合段片段（对齐 Legado SourceRule 的 ruleType/ruleParam 拆分） */
export type RulePiece =
  | { type: 'text'; value: string }
  | { type: 'js'; value: string }      // {{expr}}
  | { type: 'get'; value: string }     // @get:{key}
  | { type: 'group'; index: number; raw: string };  // $n：取上一级正则结果的第 n 组（`$0` = 整匹配）

export interface Segment {
  mode: RuleMode;
  /** 剥离 @CSS:/@@/@XPath:/@Json: 前缀、并去掉 @put 后的规则文本 */
  rawRule: string;
  /** @CSS: 模式：整个规则当“最后 @ 之前是 CSS 选择器，之后是属性” */
  isCss: boolean;
  putMap: Record<string, string>;
  /**
   * M4 复合段片段（对齐 Legado makeUpRule）：存在时整段 mode='Regex'，
   * 求值 = 依序拼接各片段（文本 / @get 变量 / {{}} JS / `$n` 组引用），再对拼接结果分离 ##。
   */
  pieces?: RulePiece[];
}

/**
 * 平衡组感知的切分：按 seps 拆分，但 [] () 内的分隔符不生效。
 * 返回各段 + 组合类型（'&&' | '||' | '%%' | ''）。
 * 这是 RuleAnalyzer.splitRule 的直译（JS 版用单遍扫描实现其语义）。
 */
export function splitRule(rule: string, seps: string[]): { parts: string[]; type: string } {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let type = '';
  const n = rule.length;
  let i = 0;
  while (i < n) {
    const c = rule[i] as string;
    if (c === '[' || c === '(') {
      depth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ']' || c === ')') {
      depth = Math.max(0, depth - 1);
      cur += c;
      i++;
      continue;
    }
    if (depth === 0) {
      let matched = false;
      for (const sep of seps) {
        if (rule.startsWith(sep, i)) {
          parts.push(cur);
          cur = '';
          type = sep;
          i += sep.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    cur += c;
    i++;
  }
  parts.push(cur.trim());
  return { parts, type };
}

/**
 * 复合段片段化（对齐 Legado splitSourceRule 的 evalMatcher 循环 + splitRegex）：
 * 字面文本 → text 片段；@get:{k} → get；{{expr}} → js；`$n` → group。
 *
 * `$n` 规则（`AnalyzeRule.kt:744-771 splitRegex`）：
 *  - 只扫描**首个 `##` 之前**的文本（`ruleStrArray[0]`）——`##正则##$1` 的 `$1` 属**替换串**
 *    （JS `String.replace` 语义），必须保持字面量，不能变成组引用；
 *  - `$n` 其余部分（含 `##…` 尾巴）原样作为 text 片段。
 */
function buildPieces(rule: string): RulePiece[] {
  const pieces: RulePiece[] = [];
  const re = new RegExp(EVAL_RE.source, 'gi');
  let start = 0;
  let m: RegExpExecArray | null;
  const addText = (s: string) => {
    if (!s) return;
    const hashAt = s.indexOf('##');
    const head = hashAt >= 0 ? s.slice(0, hashAt) : s;
    const tail = hashAt >= 0 ? s.slice(hashAt) : '';
    const gre = new RegExp(GROUP_REF_RE.source, 'g');
    let gs = 0;
    let gm: RegExpExecArray | null;
    while ((gm = gre.exec(head))) {
      if (gm.index > gs) pieces.push({ type: 'text', value: head.slice(gs, gm.index) });
      pieces.push({ type: 'group', index: Number(gm[1]), raw: gm[0] });
      gs = gre.lastIndex;
    }
    if (head.length > gs) pieces.push({ type: 'text', value: head.slice(gs) });
    if (tail) pieces.push({ type: 'text', value: tail });
  };
  while ((m = re.exec(rule))) {
    if ((m.index ?? 0) > start) addText(rule.slice(start, m.index));
    if (m[1] !== undefined) pieces.push({ type: 'get', value: m[1] });
    else pieces.push({ type: 'js', value: (m[0] as string).slice(2, -2) });
    start = re.lastIndex;
  }
  if (rule.length > start) addText(rule.slice(start));
  return pieces;
}

/**
 * 宽松解析 `@put:{...}` 的键值对（对齐 Legado `AnalyzeRule.splitPutRule` 的两级回落：
 * 先 GSONStrict、失败再宽松 GSON）。
 *
 * ⚠️ **不能只依赖 `JSON.parse`**（2026-09-16 修，Task #74）：语料里 34 处 `@put:` **全部**是非
 * 标准 JSON —— 无引号键（`{n:"..."}`），甚至键值都无引号（`{comic_id:$..comic_id}`）。
 * `JSON.parse` 抛错后旧实现直接 `catch` 丢弃 → **@put 静默失效** → 后续 `@get:{k}` 恒为空串。
 * 实测症状：武芊漫画 chapterUrl 的 `comic_id=` 为空、全免漫画正文取不到图片。
 */
export function parsePutPairs(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = json.startsWith('{') && json.endsWith('}') ? json.slice(1, -1) : json;
  let i = 0;
  const n = body.length;
  /** 去掉包裹引号；带引号时走 JSON.parse 还原转义 */
  const unquote = (s: string): string => {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"')) {
      try {
        return String(JSON.parse(t));
      } catch {
        return t.slice(1, -1);
      }
    }
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    return t;
  };
  while (i < n) {
    // 跳过空白与分隔逗号（含多行 JSON 里的换行/制表）
    while (i < n && /[\s,]/.test(body[i]!)) i++;
    if (i >= n) break;
    // —— 键：到第一个未入引号的 ':' 为止 ——
    let key = '';
    while (i < n) {
      const c = body[i]!;
      if (c === '"' || c === "'") {
        const q = c;
        key += c;
        i++;
        while (i < n && body[i] !== q) {
          if (body[i] === '\\' && i + 1 < n) {
            key += body[i]! + body[i + 1]!;
            i += 2;
            continue;
          }
          key += body[i]!;
          i++;
        }
        if (i < n) {
          key += body[i]!;
          i++;
        }
        continue;
      }
      if (c === ':') break;
      key += c;
      i++;
    }
    if (i < n && body[i] === ':') i++;
    // —— 值：到下一个顶层逗号为止（引号内的逗号不算）——
    let val = '';
    while (i < n) {
      const c = body[i]!;
      if (c === '"' || c === "'") {
        const q = c;
        val += c;
        i++;
        while (i < n && body[i] !== q) {
          if (body[i] === '\\' && i + 1 < n) {
            val += body[i]! + body[i + 1]!;
            i += 2;
            continue;
          }
          val += body[i]!;
          i++;
        }
        if (i < n) {
          val += body[i]!;
          i++;
        }
        continue;
      }
      if (c === ',') break;
      val += c;
      i++;
    }
    const k = unquote(key);
    if (k) out[k] = unquote(val);
  }
  return out;
}

/** 剥离 @put:{...}，把键值对收集到 putMap */
function extractPut(rule: string): { rule: string; putMap: Record<string, string> } {
  const putMap: Record<string, string> = {};
  const cleaned = rule.replace(PUT_RE, (_m, json: string) => {
    // 先试标准 JSON（引号/转义最规范），失败再走宽松解析
    try {
      Object.assign(putMap, JSON.parse(json) as Record<string, string>);
      return '';
    } catch {
      Object.assign(putMap, parsePutPairs(json));
      return '';
    }
  });
  return { rule: cleaned, putMap };
}

/**
 * 模式识别（对齐 SourceRule.init）。
 * isContentJson：当前 content 是否为 JSON（决定 `$.` 等是否走 Json 模式）。
 */
export function detectMode(
  ruleStr: string,
  isContentJson: boolean,
): { mode: RuleMode; rule: string; isCss: boolean } {
  let mode: RuleMode = 'Default';
  let rule = ruleStr;
  // 前缀大小写不敏感（对齐 Legado startsWith(x, ignoreCase=true)：@JSON:/@json: 等写法都存在）
  const isCss = /^@css:/i.test(rule);
  if (isCss) {
    mode = 'Default';
    // @CSS: 前缀在 CSS 后端内部再剥离（需要 lastIndexOf('@') 语义）
  } else if (rule.startsWith('@@')) {
    mode = 'Default';
    rule = rule.slice(2);
  } else if (/^@xpath:/i.test(rule)) {
    mode = 'XPath';
    rule = rule.slice(7);
  } else if (/^@json:/i.test(rule)) {
    mode = 'Json';
    rule = rule.slice(6);
  } else if (isContentJson || rule.startsWith('$.') || rule.startsWith('$[')) {
    mode = 'Json';
  } else if (rule.startsWith('/')) {
    mode = 'XPath';
  }
  return { mode, rule, isCss };
}

/**
 * `{{expr}}` 内容是否本身是一条规则（对齐 Legado `SourceRule.isRule:834-839`）。
 * 权威定义放这里（rule-analyzer 不能反向 import analyze.ts，会成环）；analyze.ts 再导出同名符号。
 */
export function isRuleExpr(s: string): boolean {
  return s.startsWith('@') || s.startsWith('$.') || s.startsWith('$[') || s.startsWith('//');
}

/**
 * 把规则串切成 Segment 列表（对齐 AnalyzeRule.splitSourceRule）。
 * <js>/@js: → Js 段；@webjs: → WebJs 段；其余文本 → 经 detectMode 识别模式。
 *
 * `allInOne`（对齐 `AnalyzeRule.splitSourceRule` 的 `allInOne` 实参，:593-605）：
 * 规则以 `:` 起头时**整条按 Regex 模式**解析（`:` 本身剥掉）。上游 `getElement`/`getElements`
 * 传 true；`getString`/`getStringList` 传 false。语料的 `chapterList` 正则形态就用这个前缀
 * （`⚡📂️快眼小说` = `:正文卷…&&href="([^"]+)">([^<]+)`），此前本仓把它当 CSS 伪类选择器 ⇒ 0 条。
 */
export function splitSourceRule(ruleStr: string, isContentJson = false, allInOne = false): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  let allInOneRegex = false;
  if (allInOne && ruleStr.startsWith(':')) {
    allInOneRegex = true;
    start = 1;
  }

  /**
   * 文本段入列：先剥 @put，再判「整段即 @get/{...} 或 {{...}}」——
   * 对齐 Legado 的 getRuleType / jsRuleType 专属段（M4 补齐）。
   */
  const pushRuleText = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const { rule, putMap } = extractPut(t);
    // `allInOne`：与上游 `SourceRule(tmp, Mode.Regex)` 一致 —— 整段按 makeUpRule 片段求值
    if (allInOneRegex) {
      segments.push({ mode: 'Regex', rawRule: rule, isCss: false, putMap, pieces: buildPieces(rule) });
      return;
    }
    const getM = /^@get:\{([^}]+)\}$/i.exec(rule);
    if (getM) {
      segments.push({ mode: 'Get', rawRule: getM[1] ?? '', isCss: false, putMap });
      return;
    }
    const jsM = /^\{\{([\w\W]*?)\}\}$/.exec(rule);
    // 捕获组内不得再含 {{/}} —— 否则是锚定回溯吞了多个 {{}} 对（如 {{a}} {{b}}），应落复合段
    if (jsM && !(jsM[1] as string).includes('{{') && !(jsM[1] as string).includes('}}')) {
      const inner = String(jsM[1]);
      // ★ 对齐 Legado `makeUpRule` 的 jsRuleType 分支（:791-808）：`{{...}}` 里的文本
      //   **本身是一条规则**时（`isRule`：以 `@` / `$.` / `$[` / `//` 起头）必须当**规则**求值
      //   —— 可带 `##替换##` 尾巴、`@css:`/`@@`/`@xpath:` 前缀等；只有真 JS 表达式才 evalJS。
      //   实测（⚡📂英文小说（英））：正文规则是 `{{@css:.text-content1 .c-en@text||.text-content1@text}}`，
      //   旧实现把 `@css:…` 当 JS 编译 → `Invalid or unexpected token` → 正文全空。
      //   语料该形态共 21 处（`@` 前缀 12 + JSONPath 起头 9，如 `{{@@h1@text}}`、`{{@@meta[…]@content##…##…}}`）。
      if (isRuleExpr(inner)) {
        pushRuleText(inner);
        return;
      }
      segments.push({ mode: 'Js', rawRule: inner, isCss: false, putMap });
      return;
    }
    // 复合段（对齐 Legado splitSourceRule）：含 @get/{{}} 片段且前缀不含 ## →
    // mode 转 Regex，求值时按片段拼接（makeUpRule 语义）。
    // 条件对齐：mode != Js/Regex（先探测默认模式）&& (evalStart==0 || 前缀无 ##)
    const pre = detectMode(rule, isContentJson);
    const evalRe = new RegExp(EVAL_RE.source, 'gi');
    const first = evalRe.exec(rule);
    /**
     * ★ 纯 `$n` 规则（无 `{{}}`/`@get`）：上游 `splitRegex` 在**首个 `##` 之前**见到 `$n`
     * 就把 mode 改成 Regex（`AnalyzeRule.kt:750-753`），`getString` 的 Regex 分支是
     * `else -> rule` ⇒ 结果就是 makeUpRule 替换后的文本。
     * 语料实测 3 源 5 处（⚡📂️快眼小说 / ⚡📂若夏 的 `chapterName`/`chapterUrl`）——
     * 其 `chapterList` 是正则，条目内容 = 捕获组列表，`$2` 取第 2 组。
     */
    const hasGroupRef = /\$[0-9]{1,2}/.test(rule.split('##')[0] ?? '');
    if (
      hasGroupRef ||
      (first && pre.mode !== 'Js' && (first.index === 0 || !rule.slice(0, first.index).includes('##')))
    ) {
      segments.push({ mode: 'Regex', rawRule: rule, isCss: false, putMap, pieces: buildPieces(rule) });
      return;
    }
    segments.push({ mode: pre.mode, rawRule: pre.rule, isCss: pre.isCss, putMap });
  };

  const jsRe = new RegExp(JS_RE.source, 'gi');
  const webRe = new RegExp(WEBJS_RE.source, 'gi');

  // 先按 <js>/@js: 切
  let m: RegExpExecArray | null;
  while ((m = jsRe.exec(ruleStr))) {
    if (jsRe.lastIndex > (m.index ?? 0) + m[0].length) {
      // 防御
    }
    if ((m.index ?? 0) > start) {
      pushRuleText(ruleStr.slice(start, m.index));
    }
    const code = m[1] ?? m[2] ?? '';
    segments.push({ mode: 'Js', rawRule: code, isCss: false, putMap: {} });
    start = jsRe.lastIndex;
  }
  let tail = ruleStr.slice(start);

  // 再按 @webjs: 切（@webjs 在剩余文本里）
  while ((m = webRe.exec(tail))) {
    if ((m.index ?? 0) > start) {
      // webRe 在 tail 上跑，但 pushText 吃的是原始 ruleStr 片段，这里仅处理 tail
    }
    if ((m.index ?? 0) > 0) {
      pushRuleText(tail.slice(0, m.index));
    }
    segments.push({ mode: 'WebJs', rawRule: m[1] ?? '', isCss: false, putMap: {} });
    tail = tail.slice((m.index ?? 0) + m[0].length);
    webRe.lastIndex = 0;
  }
  if (tail.trim()) {
    pushRuleText(tail);
  }
  return segments;
}

/**
 * `{{}}` 插值结果的处置策略（`#387b`）。
 *
 * - `stringify`（默认）：任何非空值都 `String(v)` 拼进去 —— 适用于「结果是一段文本」的规则
 *   （CSS/JsonPath/URL 模板）。
 * - `drop`：**非原始值（函数/对象）一律不拼**（等价于 Legado `makeUpRule` 的 `null -> Unit` 分支）。
 *   专用于「把 `{{}}` 拼进 **JS 源码文本**」的场景：函数 `String()` 出来是**函数源码**
 *   （`()=>{…}`）、对象是 `[object Object]`，**两者都不可能是一段合法 JS** ⇒ 拼进去必然
 *   `Invalid or unexpected token`，整条规则连脚本都跑不到。
 *
 * 为什么这是**严格改进**（不会把「本来能跑」的弄坏）：这两类值在 JS 源码位**当前也一定失败**
 * （语法错），drop 只是把它变成「不插值 + 脚本照跑」。实测语料（`#387b`）：
 * `@js:`/`<js>` 段内含 `{{}}` 的规则 **183 处 / 109 源**，其中 `{{eval(String(source.loginUrl))}}`
 * 这种「只想跑副作用、值本身没用」的写法一旦落到函数上就整条死掉。
 */
export interface PlaceholderOpts {
  /** 非原始值（object/function/symbol）的处置；缺省 `stringify`（保持原行为，零回归） */
  nonPrimitive?: 'stringify' | 'drop';
}

/**
 * 解析 {{}} / @get:{} 占位符，返回替换后的规则文本。
 *  - {{expr}} → 作为 JS 求值（bindings.$ = runningValue），非字符串结果转字符串。
 *  - @get:{key} → 从变量作用域读 key。
 * runningValue 用于给 $ 绑定（JSON 上下文里的 {{$.x}}）。
 * 异步：evalFn 可返回 Promise（L4 worker 求值器），逐个 await 后拼接。
 * @param opts 见 `PlaceholderOpts`（JS 源码位必须传 `{ nonPrimitive: 'drop' }`）
 */
export async function resolvePlaceholders(
  rawRule: string,
  runningValue: unknown,
  evalFn: (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>,
  getVar: (key: string) => string,
  jsonFn?: (rule: string, value: unknown) => unknown,
  opts?: PlaceholderOpts,
): Promise<string> {
  if (!EVAL_RE.test(rawRule)) return rawRule;
  EVAL_RE.lastIndex = 0;
  const matches = [...rawRule.matchAll(EVAL_RE)];
  if (matches.length === 0) return rawRule;
  let out = '';
  let last = 0;
  for (const m of matches) {
    const whole = m[0];
    const idx = m.index ?? 0;
    out += rawRule.slice(last, idx);
    last = idx + whole.length;
    if (whole.startsWith('@get:')) {
      out += getVar(whole.slice(6, -1));
      continue;
    }
    // {{...}}：`$` 开头且提供了 jsonFn 时按 JsonPath 对内容求值（Legado makeUpRule 语义），否则按 JS
    const expr = whole.slice(2, -2).trim();
    let v: unknown;
    let failed = false;
    try {
      if (jsonFn && expr.startsWith('$')) {
        v = jsonFn(expr, runningValue);
      } else {
        v = await evalFn(expr, { $: runningValue });
      }
    } catch {
      failed = true; // 内嵌求值失败保留原文（Legado：frv 为空时不替换）
    }
    if (failed) {
      out += whole;
      continue;
    }
    out += spliceValue(v, opts, expr);
  }
  out += rawRule.slice(last);
  return out;
}

/**
 * 「把 `{{expr}}` 的求值结果拼进规则文本」的**唯一实现**（同步/异步两条路径共用）。
 *
 * ⚠️ 同一判据只写一处（`#247`）：异步版与同步版此前各写一遍，`drop` 策略若只加一边，
 * 「同一条规则走 L1 与走 worker 结果不同」——那正是这一族 bug 的温床。
 */
function spliceValue(v: unknown, opts: PlaceholderOpts | undefined, expr: string): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  // 非原始值：函数源码 / [object Object] 都不可能是合法 JS ⇒ JS 源码位直接不拼
  if (opts?.nonPrimitive === 'drop') {
    if (process.env['YUEDU_DEBUG_DETAIL']) {
      // eslint-disable-next-line no-console
      console.log(
        `[placeholder:drop] 非原始值不拼入：{{${expr.slice(0, 60)}}} ⇒ ${typeof v}` +
          '（对齐 Legado makeUpRule 的 null->Unit；函数源码/对象串会直接把脚本打成语法错）',
      );
    }
    return '';
  }
  return String(v);
}



/**
 * resolvePlaceholders 的同步变体（java.getElements 等同步规则桥专用）。
 * evalFn 返回 Promise 时该项保留原文（无法同步取值——同步桥里 JS 段应走 jsEvalSync）。
 * @param opts 见 `PlaceholderOpts`（JS 源码位必须传 `{ nonPrimitive: 'drop' }`）
 */
export function resolvePlaceholdersSync(
  rawRule: string,
  runningValue: unknown,
  evalFn: (code: string, bindings: Record<string, unknown>) => unknown,
  getVar: (key: string) => string,
  jsonFn?: (rule: string, value: unknown) => unknown,
  opts?: PlaceholderOpts,
): string {
  if (!EVAL_RE.test(rawRule)) return rawRule;
  EVAL_RE.lastIndex = 0;
  return rawRule.replace(EVAL_RE, (whole) => {
    if (whole.startsWith('@get:')) {
      return getVar(whole.slice(6, -1));
    }
    const expr = whole.slice(2, -2).trim();
    let v: unknown;
    try {
      if (jsonFn && expr.startsWith('$')) {
        v = jsonFn(expr, runningValue);
      } else {
        v = evalFn(expr, { $: runningValue });
      }
    } catch {
      return whole;
    }
    // `#387b`：JS 源码位（drop 策略）——与异步版走**同一个** spliceValue（同一判据只写一处）
    if (opts?.nonPrimitive === 'drop') return spliceValue(v, opts, expr);
    // 默认（stringify）行为保持不变：对象保留原文（同步桥拿不到「对象 ⇒ 文本」的可靠形态）
    if (v == null || typeof v === 'object') return typeof v === 'string' ? v : whole;
    if (typeof v === 'object') return whole;
    if (v == null) return '';
    return String(v);
  });
}

/**
 * 平衡组感知的组合符切分（&& || %%），[] () 内的分隔符不生效。
 * CSS / XPath / JsonPath / Regex 后端共用。
 */
export function splitCombinator(rule: string): { parts: string[]; type: string } {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let type = '';
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i] as string;
    if (c === '[' || c === '(') {
      depth++;
      cur += c;
      continue;
    }
    if (c === ']' || c === ')') {
      depth = Math.max(0, depth - 1);
      cur += c;
      continue;
    }
    if (depth === 0) {
      let matched = false;
      for (const sep of ['&&', '||', '%%']) {
        if (rule.startsWith(sep, i)) {
          parts.push(cur.trim());
          cur = '';
          type = sep;
          i += sep.length - 1;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return { parts, type };
}

/** ## 三段（+可选第四段）清洗拆分（对齐 SourceRule.makeUpMode 末尾 :820-831）
 *
 *  Legado 用的是**扁平** `rule.split("##")`；我们做「边界感知」的等价扫描，理由与代价都有实证：
 *
 *  ⚠️ 旧实现只按「括号配平」判断，结果在真实规则上**误判**成「不配平」→ `##` 永不切分 →
 *  替换段被当成 JS 一起求值 → `RULE_PARSE@parse:Invalid or unexpected token`
 *  （实测 10 个源 detail 全挂：顶点小说#6 / VIP中文 / 书群小说 / 星星小说 / 大唐小说 /
 *   全本同人小说网 / 九九藏书 / 书荒小说 / 追书网 / 英文小说）。
 *  真凶是**正则里的转义括号**：`[\(\{（｛【]` 里 `\(`、`\{` 被当成真括号 → 深度 +2 再也回不来。
 *
 *  现在的扫描规则（三条都必要）：
 *   ① **转义感知**：`\x` 整对跳过（正则里的 `\(` `\{` `\[` 不算分组）；
 *   ② **字符类感知**：`[...]` 内部只认 `]` 与转义，里面的 `(` `{` `'` 都是字面量（如 `/[(]/`）；
 *   ③ **字符串字面量感知**：`'…'` / `"…"` / `` `…` `` 内部不算分组（如 `.replace("(", "")`）。
 *
 *  **兜底**：三条感知都没找到分隔符、但原文确实含 `##` 时，回退成 Legado 的扁平 split
 *  —— 保证「Legado 会切开的，我们一定也切开」，绝不因扫描器保守而漏切。
 */
export function splitClean(rule: string): {
  rule: string;
  replaceRegex: string;
  replacement: string;
  replaceFirst: boolean;
} {
  const seg: string[] = [];
  let cur = '';
  let brackets = 0; // [ ]
  let parens = 0; // ( ) { }
  let quote = ''; // ' " `
  let i = 0;
  while (i < rule.length) {
    const c = rule[i] as string;
    if (c === '\\') {
      cur += c + (rule[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (brackets > 0) {
      // 字符类内部：只有 ] 有意义
      if (c === ']') brackets--;
      cur += c;
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      i++;
      continue;
    }
    if (c === '[') {
      brackets++;
      cur += c;
      i++;
      continue;
    }
    if (c === '(' || c === '{') {
      parens++;
      cur += c;
      i++;
      continue;
    }
    if (c === ')' || c === '}') {
      parens = Math.max(0, parens - 1);
      cur += c;
      i++;
      continue;
    }
    if (parens === 0 && c === '#' && rule[i + 1] === '#') {
      seg.push(cur);
      cur = '';
      i += 2; // 跳过两个 #
      continue;
    }
    cur += c;
    i++;
  }
  seg.push(cur);
  /**
   * 兜底：**只有扫描器自身状态被破坏**（引号/字符类/括号未闭合）时，才退回 Legado 的扁平切分。
   *
   * ⚠️ 扫描**干净结束**且没找到顶层 `##` = 「这条规则确实没有替换段」，此时绝不能扁平切 ——
   * JS 段里的 `##` 可能合法地出现在正则字符类中（`[^##]`），扁平切会把 JS 从 `[^` 处截断
   * ⇒ `Invalid regular expression: missing /`（实测 软件库-岚揍云 ruleArticles 第 64 行）。
   * 扁平切只用于「扫描不可信」的场景（如未闭合引号 `.replace("a##x##y`）。
   */
  const scannerBroken = quote !== '' || brackets !== 0 || parens !== 0;
  const parts = seg.length > 1 || !scannerBroken ? seg : rule.split('##');
  const replaceFirst = parts.length > 3;
  return {
    rule: (parts[0] ?? '').trim(),
    replaceRegex: (parts[1] ?? '').trim(),
    replacement: (parts[2] ?? '').trim(),
    replaceFirst,
  };
}

/* ------------------------------------------------------------------ *
 * `@get:{k}` 的取值链 —— **唯一实现**（`java.get(k)` 也走这一份）
 * ------------------------------------------------------------------ */

/**
 * 取变量值：**本请求 `variables` 顶层 → 按源持久变量 `sourceVariable`（JSON 袋）**。
 *
 * ## 为什么必须有这一份（缺陷类BT，2026-09-28 修）
 * Legado 里 **`@get:{k}` 与 `java.get(k)` 是同一条链** ——
 * `AnalyzeRule.kt:810-812` 的 `regType == getRuleType -> get(ruleParam[index])` 调的就是 `get()`，
 * 而 `get()`（`AnalyzeRule.kt:872-888`）的末环是 **`source?.get(key)`（按源持久变量）**。
 *
 * 我们此前只在 `java.get` 那一侧做了「顶层未命中就翻 `sourceVariable` 袋」的回落（`js.ts`），
 * 而 `@get:{…}`（整段段与复合段片段共 6 处）**只读顶层** ⇒
 * **同进程内能过、跨请求（服务端两次 `/api/run`）必空**：
 * `@put` 当次写进顶层，`persistSourceState` 只把值落进 `sourceVariable` 这个 JSON 串，
 * 下一个请求的 `variables` 里只有那一个字符串 ⇒ 顶层没有 `k` ⇒ 取到空串。
 *
 * 实测（⚡📂️咪咕阅读）：`ruleSearch.wordCount = '@put:{bid:$.bookId}'` → 详情阶段
 * `tocUrl = '…&bid=@get:{bid}&order=0'` 解析成 `…&bid=&order=0` ⇒ 站点取不到目录 ⇒ 0 章。
 * 探针（搜索+详情同进程）**测不出来**，只有走服务端两次请求才暴露 —— 这类「取数路径不一致」
 * 必须按「**同一条链只留一份实现**」处理，别在两个文件里各写一遍。
 */
export function getVarValue(variables: { get: (k: string) => unknown }, key: string): string {
  const direct = variables.get(key);
  if (direct != null && String(direct) !== '') return String(direct);
  try {
    const raw = variables.get('sourceVariable');
    if (typeof raw === 'string' && raw) {
      const v = (JSON.parse(raw) as Record<string, unknown>)[key];
      if (v != null && String(v) !== '') return String(v);
    }
  } catch {
    /* 源变量不是合法 JSON（源脚本自己写的）→ 按未命中处理 */
  }
  return '';
}
