/**
 * `#633` **纯表达式快速求值**（目录/详情里那些「一条 `@js:` 只是拼字符串 + base64」的规则）。
 *
 * ## 为什么需要
 * 实测（`tmp/probe-fastpath-633.mts`，同一条 chapterUrl 脚本）：
 *  · L1（每次 `new Function` 编译）：**1.15ms/次**
 *  · 编译结果复用：**0.007ms/次**
 *  · worker 池（现在的目录真链路）：**1.24ms/次**
 * ⇒ 贵的是**编译**，不是求值。而目录里每章的 code 都不同（`{{$.id}}` 已内联成字面量）
 * ⇒ 按 code 缓存会 100% miss。所以这里按**模板**缓存：把字符串/数字字面量抽成参数，
 * 「模板相同、字面量不同」的脚本共用同一个编译产物。
 *
 * ## 安全边界（**必须全部满足**才走快路，否则返回 `notEligible`，调用方原路走）
 *  ① 长度 ≤ 2000；
 *  ② 只允许：字符串/数字字面量、`var` 声明、`+`/`(`/`)`/`.`/`,`、`java.<纯函数>`；
 *     出现 `{ } [ ] \` => / 等一律拒绝（regex 字面量、块、动态属性都不碰）；
 *  ③ 标识符只能是 **本脚本 `var` 声明的名字** 或 **`java`**；别的一律拒绝
 *     ⇒ 天然排除绑定访问（`result`/`$`/`src`）、全局（`window`/`document`）与 lib 函数；
 *  ④ `java.<X>` 的 X 必须在**纯函数白名单**里（编码/摘要/时间格式化），
 *     出现 `java.ajax` / `java.getString` 等有副作用或依赖上下文的一律拒绝；
 *  ⑤ 禁止控制流与副作用关键字（`if/for/while/return/function/new/this/...`）。
 *
 * ## 语义一致性
 *  · 最后一条语句按「表达式」返回（Rhino 的 script 完成值语义，与 `@js:` 用法一致）；
 *  · 字面量按 JSON/JS 规则解码（`\\` `\'` `\"` `\n` `\r` `\t` `\uXXXX` `\xNN`），数字用 `Number`；
 *  · 失败（语法错、白名单外的 java 方法、超长）一律 **抛给调用方 → 原路回退**，不静默给假值。
 *
 * ## 回退
 * `YUEDU_JS_FASTPATH=0` 关闭；`=verify` 则每次都跟原路对拍（只用于排查，慢）。
 */

/** 允许的 `java.*` 纯函数：无网络、无上下文依赖、无副作用。 */
const PURE_JAVA_METHODS = new Set([
  'base64Encode',
  'base64Decode',
  'md5Encode',
  'md5Encode16',
  'encodeURI',
  'timeFormat',
  'strToBytes', // 纯转换，返回数组
]);

/** 出现即拒绝（词边界匹配）：控制流 / 副作用 / 宿主对象。 */
const FORBIDDEN_WORDS = [
  'if',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'try',
  'catch',
  'finally',
  'throw',
  'return',
  'function',
  'new',
  'delete',
  'typeof',
  'instanceof',
  'in',
  'of',
  'this',
  'class',
  'async',
  'await',
  'yield',
  'import',
  'export',
  'with',
  'let',
  'const',
  'eval',
  'document',
  'window',
  'globalThis',
  'console',
  'require',
  'process',
  'Promise',
  'setTimeout',
  'setInterval',
  'fetch',
  'XMLHttpRequest',
];

const MAX_LEN = 2000;
/** 模板缓存上限（防长尾源把内存撑大）。 */
const MAX_TEMPLATES = 512;

export interface FastExprOk {
  ok: true;
  value: unknown;
}
export interface FastExprSkip {
  ok: false;
  /** 为什么没走快路（诊断/日志用） */
  why: string;
}
export type FastExprResult = FastExprOk | FastExprSkip;

const IDENT_RE = /[A-Za-z_$][\w$]*/y;

/** 解一个字符串字面量的**内容**（`'...'` 或 `"..."`，含引号）。 */
function decodeStringLiteral(raw: string): string {
  const q = raw[0];
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    i += 1;
    switch (n) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case '0':
        out += '\0';
        break;
      case 'x': {
        const hex = raw.slice(i + 1, i + 3);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case 'u': {
        if (raw[i + 1] === '{') {
          const end = raw.indexOf('}', i + 2);
          out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
          i = end;
        } else {
          const hex = raw.slice(i + 1, i + 5);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      case '\r':
        if (raw[i + 1] === '\n') i += 1;
        break;
      case '\n':
        break;
      default:
        out += n ?? '';
    }
  }
  void q;
  return out;
}

interface Tokenized {
  /** 模板：字面量被替换成 `__L0`、`__L1`… */
  norm: string;
  /** 每个占位符对应的**运行时值** */
  values: unknown[];
}

/**
 * 词法扫描 + 模板化。**不满足白名单就返回 null**（调用方原路走）。
 * 这一层是「拒绝」的地方：宁可多拒，也不要在快路上产生语义偏差。
 */
export function tokenizeFastExpr(code: string): Tokenized | null {
  if (!code || code.length > MAX_LEN) return null;
  const values: unknown[] = [];
  let norm = '';
  let i = 0;
  /** `var` 声明过的名字（这些标识符允许出现） */
  const declared = new Set<string>();
  let lastWasVar = false;

  while (i < code.length) {
    const c = code[i] as string;

    // ── 字符串字面量 ──────────────────────────────────────────────
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < code.length) {
        const ch = code[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === q) break;
        // 未闭合 / 跨行 ⇒ 不是我们能安全处理的东西
        if (ch === '\n') return null;
        j += 1;
      }
      if (j >= code.length) return null;
      const raw = code.slice(i, j + 1);
      norm += `__L${values.length}`;
      values.push(decodeStringLiteral(raw));
      i = j + 1;
      lastWasVar = false;
      continue;
    }

    // ── 数字字面量（注意别把标识符里的数字切出来）────────────────
    if (/[0-9]/.test(c) && !/[\w$]/.test(code[i - 1] ?? '')) {
      let j = i;
      while (j < code.length && /[0-9a-fA-FxX._]/.test(code[j] as string)) j += 1;
      const raw = code.slice(i, j);
      const num = Number(raw);
      if (!Number.isFinite(num)) return null;
      norm += `__L${values.length}`;
      values.push(num);
      i = j;
      lastWasVar = false;
      continue;
    }

    // ── 标识符 ───────────────────────────────────────────────────
    IDENT_RE.lastIndex = i;
    const m = IDENT_RE.exec(code);
    if (m && m.index === i) {
      const word = m[0];
      const prev = code[i - 1] ?? '';
      const isProperty = prev === '.';
      if (!isProperty) {
        if (FORBIDDEN_WORDS.includes(word)) {
          // `var` 例外：它本身是声明关键字，允许
          if (word !== 'let' && word !== 'const') return null;
        }
        if (word === 'var') {
          lastWasVar = true;
          norm += word;
          i += word.length;
          continue;
        }
        if (word === 'java') {
          // `java.<X>` —— X 必须是纯函数；`java[...]`/裸 `java` 都不允许（下面统一判）
          lastWasVar = false;
          norm += word;
          i += word.length;
          continue;
        }
        if (lastWasVar) {
          declared.add(word);
          lastWasVar = false;
          norm += word;
          i += word.length;
          continue;
        }
        if (!declared.has(word)) return null; // 绑定/全局/lib 函数一律拒绝
      }
      lastWasVar = false;
      norm += word;
      i += word.length;
      continue;
    }

    // ── `java.` 后面必须跟白名单方法 ─────────────────────────────
    if (c === '.') {
      const after = code.slice(i + 1);
      const mm = /^([A-Za-z_$][\w$]*)/.exec(after);
      // 只校验「紧跟在 java 后面」的那一处；其余属性（字符串方法）不放开（白名单没列就拒）
      if (norm.endsWith('java') && mm) {
        if (!PURE_JAVA_METHODS.has(mm[1] as string)) return null;
        norm += '.';
        i += 1;
        continue;
      }
      // 非 java 的属性访问：只允许字符串/数组的**只读**方法白名单
      if (mm) {
        const METHOD_OK = new Set([
          'toString',
          'trim',
          'length',
          'slice',
          'substring',
          'substr',
          'indexOf',
          'toUpperCase',
          'toLowerCase',
          'replace',
          'concat',
          'charAt',
          'padStart',
          'padEnd',
          'join',
          'split',
        ]);
        if (!METHOD_OK.has(mm[1] as string)) return null;
        norm += '.';
        i += 1;
        continue;
      }
      norm += '.';
      i += 1;
      continue;
    }

    // ── 其余字符：只允许这些（其余一律拒绝）──────────────────────
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      norm += c === '\n' || c === '\r' ? ' ' : c;
      i += 1;
      continue;
    }
    if (c === '+' || c === '(' || c === ')' || c === ',' || c === ';' || c === ':' || c === '=') {
      norm += c;
      // 分号之后不再是 var 声明位置
      lastWasVar = false;
      i += 1;
      continue;
    }
    return null;
  }

  if (!values.length && !norm.trim()) return null;
  return { norm, values };
}

/**
 * 把模板编译成「一条语句序列 + 末尾 return 表达式」的函数。
 *
 * 返回值语义对齐 `@js:`：**最后一条语句的完成值**（`var` 声明不算值）。
 */
function compileTemplate(norm: string, argCount: number): (...args: unknown[]) => unknown {
  // 顶层 `;` 切语句（此时字面量已全部变成 `__Ln`，不存在字符串里的 `;`）
  const parts = norm
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!parts.length) throw new Error('empty');
  const last = parts[parts.length - 1] as string;
  if (last.startsWith('var ')) throw new Error('last is var');
  const head = parts.slice(0, -1).join(';\n');
  const body = `${head}${head ? ';\n' : ''}return (${last});`;
  const params = Array.from({ length: argCount }, (_, i) => `__L${i}`);
  // eslint-disable-next-line no-new-func
  return new Function('java', ...params, body) as (...args: unknown[]) => unknown;
}

export interface FastExprRunner {
  /** 尝试快速求值；不适用返回 `{ok:false}`（调用方原路走，不影响语义）。 */
  (code: string, java: Record<string, unknown>): FastExprResult;
}

/**
 * 建一个带**模板缓存**的快速求值器。`java` 由调用方传（与 L1 同一份桩，保证语义一致）。
 */
export function createFastExprRunner(): FastExprRunner {
  const cache = new Map<string, (...args: unknown[]) => unknown>();
  let hits = 0;
  let misses = 0;

  const run = (code: string, java: Record<string, unknown>): FastExprResult => {
    const tk = tokenizeFastExpr(code);
    if (!tk) return { ok: false, why: 'ineligible' };
    let fn = cache.get(tk.norm);
    if (!fn) {
      try {
        fn = compileTemplate(tk.norm, tk.values.length);
      } catch (e) {
        return { ok: false, why: `compile: ${String(e instanceof Error ? e.message : e)}` };
      }
      misses += 1;
      if (cache.size >= MAX_TEMPLATES) cache.clear();
      cache.set(tk.norm, fn);
    } else {
      hits += 1;
    }
    try {
      return { ok: true, value: fn(java, ...tk.values) };
    } catch (e) {
      return { ok: false, why: `run: ${String(e instanceof Error ? e.message : e)}` };
    }
  };
  (run as unknown as { stats: () => { hits: number; misses: number; size: number } }).stats = () => ({
    hits,
    misses,
    size: cache.size,
  });
  return run as FastExprRunner;
}
