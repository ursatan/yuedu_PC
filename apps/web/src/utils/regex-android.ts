/**
 * ★★ `#252` **把「Android(ICU) 正则」翻译成 JS 正则** —— 用户净化规则的正确性前提。
 *
 * ## 为什么要这个模块（真因，有据可查）
 * 社区净化规则（本仓用户库里 51 条就是这样一批）是**按 Legado 的行为**写的，
 * 而 Legado 跑在 Android 上：`java.util.regex.Pattern` **基于 ICU**，其简写类是 **Unicode 感知**的：
 *   · Android/ICU：`\w` = `[\p{Alphabetic}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}\u200c\u200d]`
 *     （`\d` = `\p{Nd}`，`\s` = `\p{White_Space}` —— 都按 Unicode）
 *   · **JS：`\w`/`\d` 恒为 ASCII**（`[A-Za-z0-9_]` / `[0-9]`），且没有开关能改
 * ⇒ 依赖 `\w` 的规则在 JS 里会**反向命中**：`[^\n\w…]{4,}`、`[^\w「」…●]+$` 这类「吃掉标点/垃圾」
 *   的表达式，因为**中文不是 `\w`** 而把**整段正文**当成垃圾吃掉 —— 这就是用户报的
 *   「开启净化后章节正文大量被截断丢失」（第 9 章 1089 字只剩 120 字，实测）。
 *
 * ## 本模块做四件事
 * ① **简写类 Unicode 化**：`\w`/`\W`/`\d`/`\D`/`\s`/`\S`/`\h`（ICU 的水平空白）→ `\p{...}` 等价物；
 * ② **词边界 Unicode 化**（`#259`）：`\b`/`\B` —— JS 恒 ASCII，而 ICU 的 `\b` 跟着 `\w` 走（见下方常量注释）；
 * ③ **内联标志**：Java 的 `(?i)` / `(?m)` / `(?s)` 在 JS 里是**非法分组**（整条规则编译失败 ⇒ 静默失效）。
 *    开头的转成 JS flags；**中间出现的**（Java 语义是「从该点起生效」，JS 无法等价）⇒ 去掉并留痕；
 * ④ **u 模式兼容**：`\p{...}` 需要 `u` 标志，而 `u` 模式下 `\<` `\>` `\-` 这类「非法身份转义」会炸
 *    ⇒ 顺手还原成普通字符。
 *
 * ⚠️ 编译失败**绝不静默**：返回 `null` 由调用方 `warnOnce` 点名，绝不退化成 ASCII 语义还装作生效
 *    （`#252` 的教训：静默 = 用户以为净化开了，实际规则在吞正文）。
 * ⚠️ 已知未覆盖（后期迭代，已在 `replace-rules.ts` 文件头登记）：`(?x)`、`\p{...}` 里的 ICU 专属属性名、
 *    `\b{...}`（Java 9+ 的字素簇边界，本仓原样保留并留痕）。
 *    （`@js:` 替换**不在这个清单里** —— 它不属于「正则折算」，由 `utils/js-replace.ts` 单独实现。）
 *    （`\b`/`\B` **也不在了** —— `#259` 已折算，见 {@link UNI_WORD_BOUNDARY}。）
 */
import { warnOnce } from './warn-once';

/** ICU `\w` 的等价集合（Android 上中文、日文、韩文都算词字符 —— 这正是截断 bug 的关键） */
const W = '\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200C\\u200D';
/** ICU `\h`（水平空白）的等价集合 */
const H = '\\t\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000';

/**
 * ★★ `#259` **ICU 写法的 `\b`（Unicode 词边界）的等价展开**。
 *
 * ## 为什么 Android 的 `\b` 是 Unicode 的（三条独立证据；别按「Java 默认 ASCII」的印象改回去）
 * ① **OpenJDK `Pattern` 的 Javadoc 明写 `\b` 的定义基于 `\w`**，不是另有一套字符集：
 *    「A word boundary: at the beginning or at the end of a line if a word character (`\w`)
 *      appears there; or between a word (`\w`) and a non-word character (`\W`), in either order.」
 *    ⇒ **`\b` 跟着 `\w` 走**。
 * ② **Android 的 `java.util.regex.Pattern` 底层是 ICU，其 `\w` 是 Unicode 的**：
 *    Android 官方文档原文「Note that these built-in classes don't just cover the traditional ASCII
 *    range. For example, `\w` is equivalent to the character class [\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{Nd}]」；
 *    ICU 49+ 起的定义是 `[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\u200c\u200d]`（= 上面那个 `W`）。
 *    ⚠️ 与 **Java SE 的默认**不同（Java SE 的 `\w` = `[a-zA-Z_0-9]`，要 `UNICODE_CHARACTER_CLASS`
 *    才是 Unicode）—— 但 **Legado 跑在 Android 上**，所以按 ICU 算。
 * ③ **本仓 `#252` 的实测**：44 条社区规则依赖「`\w` 含中文」，否则《病宠成瘾》第 9 章 1089 字只剩 120 字。
 *    既然 `\w` 是 Unicode，按 ① 的 Javadoc 定义，`\b` 也是。
 *
 * ## 为什么必须折算（JS 的 `\b` 恒为 ASCII）
 * JS 的 `\w` = `[A-Za-z0-9_]` 且**没有开关能改** ⇒ `\b` 只在 ASCII 词字符旁成立。
 * ★ 实测（2026-10-04，用户库共 102 条规则）**46 条**用了 `\b`/`\B`，在中文语料上行为**相反**，两类典型：
 *  · `\b中\b`：ICU 下「a中b」**不是**边界（a/中/b 全是词字符）⇒ 不匹配；
 *    JS ASCII 下「a中b」的 `a|中` 与 `中|b` **都是**边界 ⇒ 会匹配。（方向相反）
 *  · `，\b`（用户库 `#19`/`#25` 各出现 ~70 次，是「拆分长句」的核心）：ICU 下逗号后紧跟汉字**成立**
 *    （逗号非词、汉字是词）；JS ASCII 下汉字不是词 ⇒ **不成立** ⇒ 那两条规则基本失效。
 * ★ 偏差方向是「**该匹配的没匹配到**」（规则不生效），**不是吞字** —— 吞字是 `#252` 的 `\w` 问题。
 *
 * ## 展开式
 * `\b`  = 「前是词字符 XOR 后是词字符」；`\B` = 它的取反。用两个零宽断言交替表达。
 * ⚠️ 必须用**负向**断言（`(?<=X)` / `(?![X])`）而不是正向的 `(?<![X])` 反过来用：
 *   行首（`i=0`）没有前字符 ⇒ `(?<!X)` 成立、`(?<=X)` 失败，这正好是 `\b` 要的语义；
 *   行尾同理。若写成 `(?=[^W])` 就会在**串尾**误判（那里没有字符可匹配）。
 * ⚠️ **不用 `\b{g}` 之类的替代品**：JS 的正则语法里没有 Unicode 词边界，只能这样展开。
 * ⚠️ **导出仅供对照校验**（`scripts/probe-259-word-boundary.mts` 要把它们换回 `\b`/`\B` 做 A/B，
 *    量「折算带来的命中差异与性能开销」）。业务代码不该直接用这两个串。
 */
export const UNI_WORD_BOUNDARY = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
/** `\B`：两个「同是词字符」或「同是非词字符」的位置（含行首/行尾紧邻非词字符处） */
export const UNI_NON_WORD_BOUNDARY = `(?:(?<=[${W}])(?=[${W}])|(?<![${W}])(?![${W}]))`;

export interface AndroidRegexResult {
  /** 编译成功则为可用的正则（**已带 `g`** —— 上游是替换全部匹配） */
  re: RegExp | null;
  /** 编译 / 转译过程中的说明（调用方用于留痕；空数组 = 完全等价） */
  notes: string[];
  /** 最终使用的 JS flags（调试用） */
  flags: string;
}

/** Java 内联标志组（排除 `(?:` `(?=` `(?!` `(?<=` `(?<!` 这些 JS 也认的） */
const INLINE_FLAG = /\(\?([a-zA-Z]+)\)/g;

/**
 * 把一条规则的模式串编译成 JS 正则。
 *
 * @param pattern 规则里的 `pattern`（**Java/ICU 语法**）
 * @param isRegex 规则是不是正则模式（否 ⇒ 调用方应走字面替换，不该进这里）
 */
export function compileAndroidRegex(pattern: string, isRegex = true): AndroidRegexResult {
  const notes: string[] = [];
  if (!isRegex) return { re: null, notes: ['isRegex=false ⇒ 走字面替换'], flags: '' };

  // ① 内联标志：开头的转 flags；中间的（Java 语义「从该点起」）去掉并留痕
  const flags = new Set<string>(['g', 'u']);
  let src = pattern.replace(INLINE_FLAG, (m, f: string, off: number) => {
    if (off === 0) {
      for (const c of f) {
        if (c === 'i' || c === 'm' || c === 's') flags.add(c);
        else if (c === 'U') notes.push('(?U) Unicode 字符类：本仓对 \\w/\\d/\\s 一律按 Unicode 处理，等价');
        else notes.push(`内联标志 (?${c}) 本仓不支持 ⇒ 已忽略`);
      }
      return '';
    }
    notes.push(`中间出现的内联标志 (?${f})（Java 语义是「从该点起生效」）⇒ 本仓去掉后按无标志处理`);
    return '';
  });

  // ② 简写类 Unicode 化（必须在**字符类内外**分别处理：`[^\w]` 里写 `[^\p{...}]`，类外写 `[...]`）
  src = translateClasses(src, notes);

  try {
    return { re: new RegExp(src, [...flags].join('')), notes, flags: [...flags].join('') };
  } catch (e) {
    // ③ u 模式编译失败 ⇒ **退回 ASCII 版本**（至少规则能跑），但必须留痕
    notes.push(`Unicode 化后编译失败（${String((e as Error)?.message ?? e).slice(-160)}）⇒ 退回原始模式（ASCII 语义）`);
    try {
      const fb = new Set<string>(['g', ...[...flags].filter((f) => f !== 'u')]);
      return { re: new RegExp(pattern.replace(INLINE_FLAG, ''), [...fb].join('')), notes, flags: [...fb].join('') };
    } catch {
      return { re: null, notes: [...notes, '退回原始模式仍然编译失败 ⇒ 该规则不生效'], flags: '' };
    }
  }
}

/**
 * 逐字符扫描：区分「字符类内 / 外」，把 ICU 简写类换成 `\p{...}`；顺便折算词边界 `\b`/`\B`。
 *
 * 为什么不用正则替换：必须知道 `\w` 在不在 `[...]` 里（两处写法不同）、
 * `\b` 在类内是**退格字符**（语义完全不同），还要躲开 `\\w`（转义过的反斜杠 + 字母 w，
 * 是字面量，不是简写类）。
 */
function translateClasses(src: string, notes: string[]): string {
  let out = '';
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const n = src[i + 1];
      if (n === undefined) { out += ch; i += 1; continue; }
      if (n === 'w' || n === 'W') {
        const neg = n === 'W';
        if (inClass) {
          if (neg) { notes.push('字符类内的 \\W 无法等价转换为 Unicode ⇒ 保留 ASCII 语义'); out += '\\W'; }
          else out += W;
        } else out += neg ? `[^${W}]` : `[${W}]`;
        i += 2; continue;
      }
      if (n === 'd' || n === 'D') {
        out += n === 'D' ? '\\P{Nd}' : '\\p{Nd}';
        i += 2; continue;
      }
      if (n === 's' || n === 'S') {
        out += n === 'S' ? '\\P{White_Space}' : '\\p{White_Space}';
        i += 2; continue;
      }
      if (n === 'h' || n === 'H') {
        // ICU 的 \h（水平空白）；JS 没有 ⇒ 展开成字符集合
        if (inClass) { out += n === 'H' ? '\\P{White_Space}' : H; }
        else out += n === 'H' ? `[^${H}]` : `[${H}]`;
        i += 2; continue;
      }
      /**
       * ★★ `#259` `\b` / `\B`：ICU 是 **Unicode 词边界**，JS 恒 ASCII ⇒ 展开成零宽断言。
       *
       * ⚠️ **字符类内不算**（两种字母分开说，别混）：
       *    · `[\b]` = **退格字符 U+0008**（不是边界）—— 实测 `new RegExp('[\\b]', 'u')` 合法，
       *      与 ICU 同义 ⇒ 原样保留。若哪天有人把类内的也折成断言，`[\b]` 会直接变成语法错误。
       *    · `[\B]`（大写）= 「非词边界」，在字符类里**没有对应语义**。实测 JS `u` 模式下
       *      `new RegExp('[\\B]', 'u')` 抛 `Invalid escape`；不带 `u` 则被当成**字面字母 B**
       *      （Annex B 身份转义）—— **语义是错的**，所以它必须靠下面 catch 的「编译失败 ⇒ 回退 + 留痕」
       *      被点名，绝不能静默变成 `B`。
       *      ⚠️ ICU/Java 侧对 `[\B]` 的行为**本机无 java 可验 ⇒ 不写结论**；这里是按 JS 的既有事实处理。
       *    （实测用户库 102 条规则里类内 `\b`/`\B` 均 **0 处**，但这两条判断必须留着 —— 见单测。）
       * ⚠️ `\b{...}`（Java 9+ 的字素簇边界）**不折算**：JS 没有等价物，硬折会静默改变语义。
       *    原样保留 + 留痕；它在 JS `u` 模式下会编译失败 ⇒ 走下面 catch 的「回退 + 留痕」，仍然不静默。
       */
      if (n === 'b' || n === 'B') {
        if (inClass) {
          notes.push(n === 'b'
            ? '字符类内的 \\b 是退格字符 U+0008（不是词边界，JS 与 ICU 同义）⇒ 原样保留'
            : '字符类内的 \\B 无对应语义：JS u 模式下是非法转义 ⇒ 原样保留，靠编译失败回退并留痕（别当成字面字母 B）');
          out += ch + n; i += 2; continue;
        }
        if (src[i + 2] === '{') {
          notes.push('\\b{...}（字素簇边界）本仓不支持 ⇒ 原样保留（该规则可能在 u 模式下编译失败）');
          out += ch + n; i += 2; continue;
        }
        notes.push(`词边界 ${ch}${n === 'B' ? 'B' : 'b'} 按 ICU 折算（Unicode 词边界；JS 默认是 ASCII 边界）`);
        out += n === 'B' ? UNI_NON_WORD_BOUNDARY : UNI_WORD_BOUNDARY;
        i += 2; continue;
      }
      /**
       * u 模式（`\p{...}` 必需）下**只允许**对 SyntaxCharacter 做身份转义：
       * `^ $ \ . * + ? ( ) [ ] { } | /`（这些**必须保留反斜杠** —— 否则 `\[` 会变成字符类开头，
       * 直接 `Lone quantifier brackets`）。
       * 其余非字母数字的身份转义（`\–` `\×` `\ꁘ` `\<`，在 ICU/Java 合法、JS u 模式下是
       * `SyntaxError`）⇒ 去掉反斜杠。
       * ⚠️ 字母/数字开头的是**真转义**（`\w` `\d` `\p` `\u` `\1`）⇒ 一律保留。
       *   （`\b`/`\B` 不会走到这里 —— 上面已单独处理：类外折算、类内原样。）
       */
      if (/[A-Za-z0-9]/.test(n) || '^$\\.*+?()[]{}|/'.includes(n)) { out += ch + n; i += 2; continue; }
      out += n; i += 2; continue;
    }
    if (ch === '[') { inClass = true; out += ch; i += 1; continue; }
    if (ch === ']') { inClass = false; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
}

/** 给调用方用的便捷入口：编译 + 自动留痕（`#252`：静默失效正是本 bug 的温床） */
export function compileRuleRegex(rule: { id: number; name?: string; pattern: string; isRegex: boolean }): RegExp | null {
  const r = compileAndroidRegex(rule.pattern, rule.isRegex);
  if (r.notes.length) {
    warnOnce(
      `replace-rule:rx:${rule.id}`,
      `净化规则「${rule.name ?? rule.id}」的正则做了折算：${r.notes.join('；')}`,
    );
  }
  if (!r.re) {
    warnOnce(
      `replace-rule:bad:${rule.id}`,
      `净化规则「${rule.name ?? rule.id}」的正则无法编译 ⇒ 该规则不生效：${r.notes.join('；')}`,
    );
  }
  return r.re;
}
