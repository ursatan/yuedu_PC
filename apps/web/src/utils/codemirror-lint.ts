/**
 * 「**未闭合括号**」检查（`#162`）—— 纯函数，不依赖 CodeMirror，便于单测。
 *
 * ## 为什么自己写（而不是直接用 `jsonParseLinter`）
 * 用户要的是「lint 提示**未闭合括号**」，而规则字段里写的是 **JS**（`@js:` / `<js>` 那些），
 * 而 `jsonParseLinter` 只懂 JSON。所以分工是：
 *  · `lang="json"` 的 JSON 源码 tab → 用 `@codemirror/lang-json` 的 `jsonParseLinter`（精确到行列）；
 *  · 其它字段（JS 规则）→ 用本文件的括号平衡扫描器。
 * 好处是两边都**只报它们真正懂的东西**，不会出现「用 JSON 解析器去骂 JS 规则」。
 *
 * ## 刻意的取舍（都写出来，免得后人当成 bug）
 *  · **只查括号**，不做语法分析 —— 规则字段本来就是片段（`@js:` 后面接一段表达式），
 *    拿完整语言解析器去校验会**整片标红**，反而没用了。
 *  · 跳过 `//`、`/* *​/` 注释与 `'`/`"`/`` ` `` 字符串（含转义）。
 *  · **正则字面量**用「上一个有效字符」的启发式判断（`(`,`=`,`:`,`,`,`[`,`!`,`&`,`|`,`?`,`{`,`}`,`;`
 *    之后或行首的 `/` 视为正则开始）—— 这是 JS 词法分析的通行做法，能挡掉 `/\//` 这类
 *    会让朴素扫描器错位的写法。剩下的极端写法（如 `a / b` 被误当正则）最坏结果也只是
 *    **少报一个**，不会误报。
 *  · 类型不匹配（如 `[)`）时**报开括号**并把它出栈 —— 否则一个错会级联出一串错，用户看到一屏红。
 */
/**
 * ## 严重级别：**必须显式给 `severity`**
 * `@codemirror/lint` 对**没写 `severity`** 的诊断默认按 `"info"` 处理 ⇒ 渲染成
 * `.cm-lint-marker-info` / `.cm-lintRange-info`（不是 `-error`）。
 * 后果：任何按 `-error` 找的诊断（含我们的真浏览器探针）都读不到，
 * 看起来像「linter 根本没跑」——（`#162` 验收时就撞了：结构读数 `mk:1` 而 `-error` 计数 0）。
 * 未闭合括号是**硬语法错**，与 JSON 侧的 `jsonParseLinter` 保持一致用 `error`。
 */
export interface BracketDiagnostic {
  from: number;
  to: number;
  message: string;
  severity: 'error';
}

const OPEN_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** 这些字符之后的 `/` 是**正则开始**（而不是除号） */
const REGEX_PRECEDERS = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * 扫描一段文本里的**括号不平衡**。
 * 返回的 `from`/`to` 是**代码单元下标**（与 CodeMirror 的 `EditorState.doc` 坐标一致）。
 */
export function findUnclosedBrackets(text: string): BracketDiagnostic[] {
  const out: BracketDiagnostic[] = [];
  const stack: Array<{ ch: string; at: number }> = [];
  let prev = ''; // 上一个「有效」字符（跳过空白）—— 判正则用
  let i = 0;

  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];

    // ---- 行注释 ----
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // ---- 块注释 ----
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // ---- 正则字面量（启发式）----
    if (c === '/' && (prev === '' || REGEX_PRECEDERS.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        const d = text[j] as string;
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break; // 正则不跨行 ⇒ 说明前面那个其实是除号，按普通字符走
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; break; }
        j++;
      }
      if (j <= text.length && text[j - 1] === '/') { i = j; prev = '/'; continue; }
    }
    // ---- 字符串 ----
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      prev = quote;
      continue;
    }
    // ---- 括号 ----
    if (OPEN_OF[c]) {
      stack.push({ ch: c, at: i });
      prev = c;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack[stack.length - 1];
      if (top && OPEN_OF[top.ch] === c) {
        stack.pop();
      } else if (top) {
        out.push({ from: top.at, to: top.at + 1, message: `括号「${top.ch}」没有闭合`, severity: 'error' });
        stack.pop();
      } else {
        out.push({ from: i, to: i + 1, message: `多余的闭合括号「${c}」`, severity: 'error' });
      }
      prev = c;
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  // 栈里剩下的就是**真正没闭合**的那些（按出现顺序报，位置更直观）
  for (const s of stack) out.push({ from: s.at, to: s.at + 1, message: `括号「${s.ch}」没有闭合`, severity: 'error' });
  return out;
}
