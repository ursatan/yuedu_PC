import { Script } from 'node:vm';

/**
 * JS 语法/运行错误的**可定位化**（L1 与 worker 两条路径共用同一套逻辑）。
 *
 * 为什么需要：规则求值抛出的 V8 原生信息只有一句 `Invalid or unexpected token`，
 * 既不知道是**哪条规则**、也不知道**哪一行**——实测排查 10 个源的 `RULE_PARSE@parse`
 * 时只能靠 `YUEDU_DEBUG_JS_FAIL` 落盘原文，成本极高。
 *
 * 做法：语法错时用 `vm.Script(src)` **复现一次编译**，把 V8 给出的
 * `文件名:行号 / 出错行原文 / 尖号` 摘出来拼进 message（只在失败路径执行，无热路径开销）。
 *
 * ⚠️ 两份实现必须一致：
 *  - 宿主（TS）：`explainJsError`（本文件）
 *  - worker（raw source，注入 WORKER_SRC）：`JS_ERROR_EXPLAIN_SOURCE`
 *   —— worker 里不能 import 宿主代码，只能注入源码（与 `URL_PREP_SOURCE` 同一套路）。
 * 两者的行为一致性由 `core/src/__tests__/js-error-explain.test.ts` 锁定。
 */

/** 需要补诊断信息的 V8 语法错消息（对齐 Node/V8 的常见文案） */
export const JS_SYNTAX_ERROR_RE =
  /Invalid or unexpected token|Unexpected token|Unexpected identifier|Unexpected number|Unexpected string|Unexpected end of input|missing \) after|missing \} after|Unterminated|Invalid shorthand|Invalid left-hand|Invalid regular expression/i;

/** 从 vm.Script 的失败里摘出「出错行 + 尖号」；拿不到就返回空串 */
function syntaxLocation(src: string): string {
  try {
    // 静态 import（不是 require）：tsx/ESM 下没有全局 require，
    // 用 `require('node:vm')` 会静默落到 catch → 明明能定位却什么都没拿到（本文件首轮实现就踩了）。
    // 若源码本身没问题（例如运行时错误被误判），这里不会抛，直接返回空
    new Script(String(src), { filename: 'yuedu-rule.js' });
    return '';
  } catch (se) {
    const lines = String((se as Error)?.stack ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.includes('yuedu-rule.js')) {
        return lines
          .slice(i, i + 3)
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' | ');
      }
    }
    return '';
  }
}

/**
 * **运行期**错误的出错行：V8 对 eval 源码的栈帧形如 `<anonymous>:12:7`
 * （实测 `new Function('eval(src)')` 里抛错时，行号就是 src 的行号），
 * 用它把出错那一行原文 + 尖号摘出来。
 */
function runtimeLocation(src: string, stack?: string): string {
  const m = /<anonymous>:(\d+):(\d+)/.exec(String(stack ?? ''));
  if (!m) return '';
  const line = Number(m[1]);
  const col = Number(m[2]);
  const lines = String(src).split('\n');
  const text = lines[line - 1];
  if (text === undefined) return '';
  const caret = `${' '.repeat(Math.max(0, col - 1))}^`;
  return `${line}:${col} | ${text.trim().slice(0, 160)} | ${caret}`;
}

/**
 * 给错误信息补「出错位置 + 代码片段」。
 *
 *  · 语法错：用 `vm.Script` 复现编译拿「文件名:行号 + 原文 + 尖号」；
 *  · 运行期错（TypeError/ReferenceError…）：从错误自身栈里的 `<anonymous>:行:列` 定位到
 *    **eval 源码的那一行**——这是 `Cannot read properties of undefined` 类问题唯一能自证的线索
 *    （实测可乐小说 `document.documentElement.nodeName` 就是这么定位的）。
 *  · 拿不到位置时**原样返回**（不改变 NETWORK 等类别文案，避免影响 isNetworkError 判定）。
 */
export function explainJsError(msg: string, src: string, stack?: string): string {
  const snippet = String(src).slice(0, 240).replace(/\s+/g, ' ');
  if (JS_SYNTAX_ERROR_RE.test(msg)) {
    const where = syntaxLocation(src);
    return `${msg}｜${where ? `出现在 ${where}｜` : ''}片段=${snippet}`;
  }
  const at = runtimeLocation(src, stack);
  return at ? `${msg}｜运行期 ${at}｜片段=${snippet}` : msg;
}

/** worker 侧的同逻辑源码（ES5 安全、**不含反引号**——WORKER_SRC 是模板字符串） */
export const JS_ERROR_EXPLAIN_SOURCE = String.raw`
/** 见 core/selector/js-error.ts：语法错/运行期错补「出错位置 + 片段」（与宿主 explainJsError 同逻辑） */
function __yueduExplainJsError(msg, src, stack) {
  var re = /Invalid or unexpected token|Unexpected token|Unexpected identifier|Unexpected number|Unexpected string|Unexpected end of input|missing \) after|missing \} after|Unterminated|Invalid shorthand|Invalid left-hand|Invalid regular expression/i;
  var snippet = String(src).slice(0, 240).replace(/\s+/g, ' ');
  if (!re.test(msg)) {
    // 运行期错：从 '<anonymous>:行:列' 定位到 eval 源码的出错行
    var m = /<anonymous>:(\d+):(\d+)/.exec(String(stack || ''));
    if (!m) return msg;
    var ln = Number(m[1]);
    var col = Number(m[2]);
    var arr = String(src).split('\n');
    var text = arr[ln - 1];
    if (text === undefined) return msg;
    var pad = '';
    for (var p = 0; p < Math.max(0, col - 1); p++) pad += ' ';
    return msg + '｜运行期 ' + ln + ':' + col + ' | ' + text.trim().slice(0, 160) + ' | ' + pad + '^' + '｜片段=' + snippet;
  }
  var where = '';
  try {
    var vm = require('node:vm');
    new vm.Script(String(src), { filename: 'yuedu-rule.js' });
  } catch (se) {
    var lines = String((se && se.stack) || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('yuedu-rule.js') >= 0) {
        where = lines.slice(i, i + 3).map(function (l) { return l.trim(); }).filter(Boolean).join(' | ');
        break;
      }
    }
  }
  return msg + '｜' + (where ? '出现在 ' + where + '｜' : '') + '片段=' + snippet;
}
`;
