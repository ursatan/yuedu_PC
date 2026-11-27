/**
 * `#257` 净化规则的 **`@js:` 替换** —— 逐匹配求值 + Java 组引用语义。
 *
 * ## 上游语义（逐条读源码核实，勿凭印象改）
 * 应用点 `ContentProcessor.kt:176-196`（正文）与 `BookChapter.getDisplayTitle():137-160`（标题）；
 * 求值主体 `RegexExtensions.kt:32-96`；绑定对象 `RegexJsExtensions.kt`（= `JsEncodeUtils`）；
 * 返回值归一 `RhinoScriptEngine.unwrapReturnValue():237-244`。
 *
 * ① **只在 `isRegex=true` 时生效**：`isRegex=false` 走的是 `String.replace(pattern, replacement)`
 *    （`ContentProcessor.kt:190`）—— **不求值 JS**，`@js:...` 会被**原样插进正文**。
 *    这是上游行为（写这种规则的作者多半是搞错了），本仓**照抄**，另加 `warnOnce` 提醒。
 * ② **逐匹配求值**：`matcher.find()` 循环里，每命中一次就求值一次，而不是整段求值一次。
 * ③ **绑定四个名字**：`result` = `matcher.group()`（**整个匹配**，不是某分组）、
 *    `chapter`（`BookChapter?`）、`book`（`ReplaceBook?`）、`java`（`RegexJsExtensions` 实例）。
 * ④ ★★ **`ScriptBindings()` 建在循环体内** ⇒ **每个匹配一份全新的作用域**。
 *    所以规则里那种「不给声明直接赋值」的写法（`zk = {...}`、`R = result`、`xx = !/^o/.test(result)`）
 *    是**每个匹配各自一份**，既不污染别的规则，也不会跨匹配串味 —— 本仓必须复刻。
 * ⑤ ★★ **`java` 实例是「每条规则一次」而不是「每个匹配一次」**：`RegexExtensions.kt:43`
 *    的 `val reJsExtensions by lazy { ... }` 在 `replace()` 函数体内 ⇒ 同一条规则的**所有匹配共享**
 *    那个 `RuleData` ⇒ `java.put('k', v)` 写下的值，**同一规则的下一个匹配能用 `java.get` 读到**。
 *    （注意：`reJsExtensions` 虽然写在 `while` 外面、`by lazy` 也算得准，但它不是 per-match。）
 * ⑥ ★★ **返回值要再走一次「组引用展开」**：上游拿到 JS 结果后做
 *    `jsResult.quoteReplacementJs()` 再交给 `Matcher.appendReplacement`
 *    （`RegexExtensions.kt:57-60`）。而 `quoteReplacementJs`（`StringExtensions.kt:177-190`）
 *    **只把 `\` 双写、故意不动 `$`** ⇒ 因为 `appendReplacement` 会把 `\\` 还原成 `\`、
 *    把 `$N`/`${name}` 换成**当前匹配的分组**。
 *    ⇒ 净效果：**JS 结果里的 `\` 是字面量，而 `$N` 是组引用**。
 *    用户库里就有规则依赖这一点：`'一个目录'` 的脚本结尾是
 *    `result = "第".concat("$1","章 ")` —— 那个 `$1` 是**给 Java 展开的**，不是 JS 的。
 *    ⚠️ 若只把 JS 结果当普通字符串塞回去，正文里会出现字面量 `第$1章 `：**看起来「差不多对」的静默错误**。
 * ⑦ **返回 `undefined` / `null` ⇒ 插入字面量 `"null"`**：`unwrapReturnValue` 把 Rhino 的 `Undefined`
 *    归一成 Kotlin `null`，紧接着 `RegexExtensions.kt:59` 调的是 Kotlin 的 `Any?.toString()`
 *    ⇒ 得到字符串 `"null"`（**不是** `"undefined"`、也不是空串）。照抄 + `warnOnce` 提醒。
 *    ⚠️ **数字未对齐（已核实的残差）**：Rhino 的 JS 数字是 `Double`，`1+2` 走到 `Any.toString()`
 *    会是 `"3.0"`；本仓 `String(3)` = `"3"`。本机**没有 JVM**，无法核实 Rhino 的装箱细节
 *    ⇒ 如实登记为「未对齐」，不去猜。实测用户库 21 条 `@js:` 规则**没有一条**返回数字
 *    （全是字符串/字符串方法的结果）。
 * ⑧ **出错 ⇒ 该条规则本次不生效**：上游 `catch (e: Exception)` 只打日志 + toast，
 *    `mContent` 保持替换前不变（`ContentProcessor.kt:196-203`）⇒ 本仓同样「跳过并留痕」，**绝不静默改成原文**。
 *
 * ## 本仓的**已知差异**（刻意，且都留痕）
 * - **不能中断**：上游用协程 `select/onTimeout` 3 秒掐断，本仓 JS 单线程中断不了
 *   （与 `replace-rules.ts` 里正则超时的限制同类）。用户脚本里若写了死循环，页面会卡住 ——
 *   这是**已知残差**，不是「忘了做」。
 * - **`java` 只实现同步可实现的子集**：`log` / `logType` / `get` / `put` / `t2s` / `s2t` 是真的；
 *   `JsEncodeUtils` 里的加解密族（`md5Encode`、`createSymmetricCrypto`、`digestHex`、`HMac*`…）
 *   需要**同步**密码学实现（浏览器只有异步的 `crypto.subtle`）⇒ 调用时**抛带说明的错误**，
 *   该规则被跳过并留痕。**不做假实现**。（实测用户库 21 条 `@js:` 规则**一条都没用 `java`**。）
 * - **`t2s` / `s2t` 依赖已加载的简繁词典**：本仓词典是**按需异步加载**的（`chinese-convert.ts`
 *   文件头写了为什么不能静态引：+1.4MB）。所以这两个方法只在词典**已经**加载过时可用，
 *   否则抛带说明的错误（同样留痕），而不是静默返回原文。
 * - **沙箱用的是 `with(Proxy)` + 内层 IIFE**（不是 `node:vm`，因为应用点在前端）：
 *   未声明的名字会落到那个 per-match 的 Proxy 上（对齐上游 ④），**不污染 `globalThis`**；
 *   脚本自己声明的 `var` / `function` 则在更内层的 IIFE 变量环境里（**声明可见、且不跨匹配残留**）；
 *   `globalThis` 上的东西（`console` / `Math` / `JSON` / `Date`…）仍可读 —— 与上游给脚本的
 *   权限量级相当（上游脚本连 `java` 都能用），这是**用户的规则跑在用户自己的机器上**的信任模型。
 *   ⚠️ 若页面 CSP 禁了 `eval`，则所有 `@js:` 规则统一跳过并留痕（不静默）。
 * - **净化设置页的「预览」里 `chapter` / `book` 是 `null`**：上游 `ReplacePreview.kt:85-96` 同样传
 *   `null`，但它在求值前用 `containsContextReference()` **显式拒绝**直接属性访问、给一句明确提示；
 *   本仓此时会抛 `TypeError` ⇒ 该规则在预览里被跳过（并留痕），预览显示的是**原文**。
 *   差别只在「提示得清楚与否」，不影响正文（正文那条路径有真对象）。
 */
import { warnOnce } from './warn-once';
import { peekChineseConverter } from './chinese-convert';

/** `@js:` 前缀（上游 `RegexExtensions.kt:38`） */
const JS_PREFIX = '@js:';

/**
 * ★★ **分组「未参与匹配」时插入的文本 = `null`**（Android 的 `Matcher.appendReplacement` 行为）。
 *
 * 这条**取决于平台**，两个独立来源都指向同一结论：
 *  · JDK/OpenJDK 的 `appendReplacement` 里有 `if (start(refNum) != -1 && end(refNum) != -1)` 保护
 *    ⇒ 未参与的分组**什么都不加**（等价空串）；
 *  · **GNU Classpath 与 Android 的实现直接 `buffer.append(group(c - '0'))`**
 *    ⇒ `group()` 返回 `null`，拼出来就是字面量 **`null`**
 *    （原话：*"In JDK, if a group has not been captured, it is replaced with `""`;
 *    In android, it is replaced with the string 'null'"*）。
 * **Legado 是 Android 应用** ⇒ 本仓对齐 Android，即插入 `null`。
 *
 * ⚠️ 这是**刻意**与「JS 的 `$N`」不同的地方（JS 插空串）。
 * 影响面已实测：拿已抓的真实章节页当语料、跑用户库里 27 条启用的非 `@js:` 规则、
 * 共 274 次匹配 ⇒ **「未参与分组」出现 0 次**（见 `tmp/257/diff.mts`）。
 */
const NULL_GROUP = 'null';

export function isJsReplacement(replacement: string): boolean {
  return replacement.startsWith(JS_PREFIX);
}

/** 去掉 `@js:` 前缀（上游 `replacement.substring(4)`） */
export function jsScriptOf(replacement: string): string {
  return replacement.slice(JS_PREFIX.length);
}

/**
 * ★★ 展开替换串里的**组引用**，语义照抄 Java `Matcher.appendReplacement`
 * （`java.util.regex.Matcher#appendExpandedReplacement`）。
 *
 * - `$N`：分组；`$0` = **整个匹配**（⚠️ **JS 的 `String.replace` 不认 `$0`** ⇒ 直接用 JS 的字符串替换
 *   会把 `$0` 当字面量留在正文里。用户库里 `'#26 拆分🔻段落'` 正是 `replacement = '$0\n'`）。
 * - `${name}`：命名分组（JS 是 `$<name>`，两套语法不同 ⇒ 不能把替换串直接交给 JS）。
 * - **贪心但「只吃到仍是合法组号为止」**：`Matcher` 文档原文 ——
 *   *"Only the numerals '0' through '9' are considered as possible components of a group number"*
 *   ⇒ 只有 2 个分组时 `$10` = 第 1 组 + 字面量 `0`。
 * - `$` 后面既不是数字也不是 `{` ⇒ **抛错**（Java 抛 `Illegal group reference`）。
 *   同理一个孤零零的 `$`（串尾）也抛。
 * - **分组未参与匹配 ⇒ 插 `null`**（见 `NULL_GROUP` 的说明）。
 * - `\` **不是转义符**：上游会先把 JS 结果里的 `\` 双写、再由 `appendReplacement` 还原成 `\`
 *   ⇒ 净效果是「`\` 就是字面量」。所以这里的扫描里 `\` 一律原样输出（对应上游 `quoteReplacementJs`）。
 *
 * @param groups 第 0 项 = 整个匹配，其后依次是各分组
 *               （**未参与的分组请传 `'null'`** —— 由调用方按 Android 语义归一）
 * @param named  命名分组表（正则里没有命名分组时传 `undefined`）
 */
export function expandJavaReplacement(
  replacement: string,
  groups: readonly string[],
  named?: Record<string, string | undefined> | undefined,
): string {
  const groupCount = groups.length - 1;
  let out = '';
  let i = 0;
  while (i < replacement.length) {
    const c = replacement[i];
    if (c !== '$') {
      out += c;
      i += 1;
      continue;
    }
    const next = replacement[i + 1];
    if (next === undefined) throw new Error('Illegal group reference: group index is missing');
    if (next === '{') {
      const end = replacement.indexOf('}', i + 2);
      if (end < 0) throw new Error("named capturing group is missing trailing '}'");
      const name = replacement.slice(i + 2, end);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        throw new Error(`capturing group name {${name}} does not start with a Latin letter`);
      }
      if (!named || !(name in named)) throw new Error(`No group with name {${name}}`);
      out += named[name] === undefined ? NULL_GROUP : named[name];
      i = end + 1;
      continue;
    }
    if (next < '0' || next > '9') throw new Error('Illegal group reference');
    let refNum = next.charCodeAt(0) - 48;
    let j = i + 2;
    while (j < replacement.length) {
      const d = replacement[j];
      if (d < '0' || d > '9') break;
      const grown = refNum * 10 + (d.charCodeAt(0) - 48);
      if (grown > groupCount) break; // 再吃一位就不是合法组号了 ⇒ 停下（剩下的数字当字面量）
      refNum = grown;
      j += 1;
    }
    if (refNum > groupCount) throw new Error(`No group ${refNum}`);
    out += groups[refNum] ?? NULL_GROUP;
    i = j;
  }
  return out;
}

/** 供 `replace-rules.ts` 用的「未参与分组 ⇒ `null`」归一（Android 语义） */
export function normalizeGroupValue(v: string | undefined): string {
  return v === undefined ? NULL_GROUP : v;
}

/**
 * 从 `String.prototype.replace` 的函数型回调参数里解出分组信息。
 *
 * 回调签名是 `(match, p1…pn, offset, input, groups?)` —— 末尾那个 `groups` 对象
 * **只在正则含命名分组时**才存在（所以不能按固定位置取）。
 * 未参与的可选分组在 JS 里是 `undefined` ⇒ 立刻按 Android 语义归一成 `'null'`。
 */
export function parseReplaceCallbackArgs(args: readonly unknown[]): JsMatchArgs {
  const match = String(args[0] ?? '');
  let end = args.length;
  let named: Record<string, string | undefined> | undefined;
  const last = args[args.length - 1];
  if (last !== null && typeof last === 'object') {
    named = last as Record<string, string | undefined>;
    end -= 1;
  }
  if (typeof args[end - 1] === 'string') end -= 1; // 整体输入串
  if (typeof args[end - 1] === 'number') end -= 1; // offset
  const groups: string[] = [match];
  for (let i = 1; i < end; i += 1) groups.push(normalizeGroupValue(args[i] as string | undefined));
  return { match, groups, named };
}

/* -------------------------------------------------------------------------- */
/* `java` 绑定（上游 `RegexJsExtensions`：`JsEncodeUtils` + 5 个工具方法）        */
/* -------------------------------------------------------------------------- */

/** 上游 `JsEncodeUtils` 里**需要同步密码学**、本仓未实现的方法（调用即抛，带说明） */
const JAVA_CRYPTO_METHODS = [
  'md5Encode',
  'md5Encode16',
  'digestHex',
  'digestBase64Str',
  'HMacHex',
  'HMacBase64',
  'createSymmetricCrypto',
  'createAsymmetricCrypto',
  'createSign',
  'aesDecodeToByteArray',
  'aesDecodeToString',
  'aesDecodeArgsBase64Str',
  'aesBase64DecodeToByteArray',
  'aesBase64DecodeToString',
  'aesEncodeToByteArray',
  'aesEncodeToString',
  'aesEncodeToBase64ByteArray',
  'aesEncodeToBase64String',
  'aesEncodeArgsBase64Str',
  'desDecodeToString',
  'desBase64DecodeToString',
  'desEncodeToString',
  'desEncodeToBase64String',
  'tripleDESDecodeStr',
  'tripleDESDecodeArgsBase64Str',
  'tripleDESEncodeBase64Str',
  'tripleDESEncodeArgsBase64Str',
] as const;

/** 一条规则的 `java` 绑定：**所有匹配共享**（见文件头 ⑤），故变量表建在闭包里 */
export interface JavaExtensions {
  log(msg: unknown): unknown;
  logType(any: unknown): void;
  t2s(text: string): string;
  s2t(text: string): string;
  get(key: string): string;
  put(key: string, value: unknown): string;
  [k: string]: unknown;
}

function createJavaExtensions(ruleName: string): JavaExtensions {
  const vars = new Map<string, string>();
  const tag = `[java:@js:${ruleName}]`;
  const log = (msg: unknown): unknown => {
    console.log(tag, msg);
    return msg;
  };
  const need = (what: string): never => {
    throw new Error(
      `java.${what} 在 Web 端未实现（本仓只实现同步可做的子集：log/logType/get/put/t2s/s2t）。`
        + '加解密族需要同步密码学实现，浏览器只提供异步 crypto.subtle ⇒ 未做（见 utils/js-replace.ts 文件头）',
    );
  };
  const conv = (dir: 1 | 2, text: string): string => {
    const fn = peekChineseConverter(dir);
    if (!fn) {
      throw new Error(
        `java.${dir === 1 ? 't2s' : 's2t'} 需要简繁词典（本仓按需异步加载）——`
          + '当前词典尚未加载，故无法在同步的 @js: 里使用',
      );
    }
    return fn(text);
  };
  const ext: JavaExtensions = {
    log,
    logType(any: unknown): void {
      if (any == null) return void log('null');
      const ctor = (any as { constructor?: { name?: string } }).constructor;
      return void log(ctor?.name ?? typeof any);
    },
    t2s: (text: string) => conv(1, text),
    s2t: (text: string) => conv(2, text),
    get(key: string): string {
      return vars.get(key) ?? '';
    },
    put(key: string, value: unknown): string {
      const s = String(value);
      vars.set(key, s);
      return s;
    },
  };
  for (const name of JAVA_CRYPTO_METHODS) {
    ext[name] = () => need(name);
  }
  return ext;
}

/* -------------------------------------------------------------------------- */
/* 求值沙箱                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 生成「带 per-match 作用域」的求值函数。
 *
 * 为什么是 `with (proxy) { return (function(){ return eval("<脚本源码>") })() }`
 * 而不是 `new Function(..., src)`、也不是把 `eval` 直接放在 `with` 里：
 *
 * ① **必须拿到「完成值」**（completion value）：用户规则大量写成
 *    `if (cond) ... else result = "第".concat(...)` —— 末句是个**表达式语句**，
 *    Rhino 的 `eval` 返回它的值；而 `new Function` 的 body 只 `return` 显式返回值
 *    ⇒ 直接包 body 会让这些规则**全都返回 undefined**。
 * ② **必须是宽松模式**：规则里满是 `zk = {...}` 这种**不声明就赋值**的写法，严格模式会抛
 *    ReferenceError。（`new Function` 的 body 默认非严格，正好绕开模块级 `"use strict"`。）
 * ③ **per-match 全新作用域**（上游 ④）：`has` 恒真的 Proxy ⇒ 未声明的名字落到 Proxy 上，
 *    既不污染 `globalThis`，也不跨匹配残留；读不到的名字再回落到 `globalThis`（`Math`/`JSON`/`console`…）。
 * ④ ★★ **中间那层 IIFE 是必需的，不是可有可无的包装**（`#257` 实测）：
 *    `with` 的对象环境会被插在**最内层**，而脚本里 `function`/`var` 声明进的是
 *    **变量环境**（VariableEnvironment）= 外层那个 `new Function` 的函数环境 —— 比 `with` **更靠外**。
 *    于是名字解析先撞上 `has` 恒真的 Proxy ⇒ **脚本自己声明的函数/变量全被 shadow 成 `undefined`**。
 *    真实症状：用户库里启用中的 `'#04 星号修复#JS'` 脚本自己写了 `function M(x){...}`，
 *    求值时报 `M is not a function` ⇒ 整条规则被跳过（回归脚本 `scripts/probe-257-shadow-scope.mts` 的 A 组）。
 *    套一层 IIFE 后，脚本的变量环境变成 IIFE 的函数环境（**比 `with` 更内层**）
 *    ⇒ 解析顺序变成「IIFE 的声明 → Proxy → 全局」：
 *      · 脚本自己声明的 `function M` / `var v` / `const c` ⇒ 在 IIFE 里找到 ⇒ **可见、可调用**；
 *      · 未声明就赋值的 `zk = 1` ⇒ 前两层都没有 ⇒ 落到 Proxy ⇒ **per-match 隔离成立**；
 *      · `result` / `java` ⇒ 落到 Proxy 拿绑定；
 *      · `globalThis` 上的 `Math` / `JSON` ⇒ Proxy 回落到全局。
 *    另有附带好处：IIFE 的函数环境**每次调用都是新的** ⇒ `var` / 函数声明天然不跨匹配残留。
 *
 * ★ **两个踩过的坑（都不是「性能优化」，是正确性）**：
 *  a) **脚本必须「烘进」函数体**，**不能**用参数传进去：
 *     `with` 的 `has` 对一切名字都返回 true ⇒ 连**运行器自己的参数**都会被 shadow 成 `undefined`
 *     ⇒ `eval(undefined)` ⇒ 一切返回 `undefined`。
 *     （第一版就是这样：22 个用例里 14 个红，症状是「脚本没有返回值」。）
 *  b) **`eval` 必须放行**（`has` 返回 false）—— 让 `eval` 解析到**全局**那个 `eval` 绑定，
 *     从而保证是**直接 eval**：直接 eval 会继承当前（含 `with` 的）词法环境，脚本里才看得见
 *     `result` / `java`。若 `eval` 也从 Proxy 取，就不再是直接 eval，脚本会看不到作用域。
 *
 * 按**脚本源码**缓存编译结果（同一条规则每章都要跑，没必要每章重编译）。
 */
type Runner = (scope: object) => unknown;

const runnerCache = new Map<string, Runner | null>();
let runnerDisabled = false;

function getRunner(script: string): Runner | null {
  const hit = runnerCache.get(script);
  if (hit !== undefined) return hit;
  if (runnerDisabled) return null;
  let fn: Runner | null;
  try {
    fn = new Function(
      '__scope',
      `with (__scope) { return (function () { return eval(${JSON.stringify(script)}); })(); }`,
    ) as Runner;
  } catch (e) {
    fn = null;
    warnOnce(
      'js-replace:no-eval',
      `[js-replace] 本页禁用了 eval（CSP？）⇒ 所有 @js: 净化规则一律跳过（正文保持原样）：${
        String((e as Error)?.message ?? e).slice(0, 160)
      }`,
    );
    runnerDisabled = true; // 一次失败就够，别每条规则都试一遍
  }
  runnerCache.set(script, fn);
  return fn;
}

function makeScope(bindings: Record<string, unknown>): object {
  return new Proxy(bindings, {
    /**
     * 恒 true ⇒ `with` 里的一切名字都先落到这里（这是「per-match 作用域」的关键）。
     *
     * ⚠️ 这正是为什么**外面必须再套一层 IIFE**（见 `getRunner` 的 ④）——
     * 对**脚本自己声明**的名字，`with` 这一层必须「让路」给更内层的 IIFE 变量环境。
     * 让路的方式不是改 `has`（改成「只认自有属性」会让「未声明就赋值」漏到 `globalThis`，
     * 实测见 `scripts/probe-257-shadow-scope.mts` 的 A 组），而是**把声明放得比 `with` 更内层**。
     *
     * ★★ **`eval` 必须放行（返回 false）** —— 这是踩过的坑：
     * 若 `eval` 也从这个 Proxy 解析，那么 `eval(src)` 就**不再是直接 eval**（规范：直接 eval 要求
     * `eval` 解析到全局环境的绑定；从对象环境记录里取到的一律按**间接 eval**处理）
     * ⇒ 间接 eval **看不到 `with` 这条作用域链** ⇒ 脚本里的 `result` / `java` 全是 undefined
     * ⇒ 规则要么抛错被跳过、要么返回 `undefined` ⇒ 正文里出现字面量 `null`。
     * ⚠️ 这个缺陷的表现是「测试通过但什么都没做」（用例期望的正是「原样文本」）⇒ 典型假通过。
     * 同理跳过 `Symbol.unscopables`（symbol 键一律不管，别让 `with` 去查它）。
     */
    has: (_t, key) => typeof key !== 'symbol' && key !== 'eval',
    get: (t, key) => {
      if (typeof key === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(t, key)) return (t as Record<string, unknown>)[key];
      const g = globalThis as unknown as Record<string, unknown>;
      return key in g ? g[key] : undefined;
    },
    set: (t, key, v) => {
      if (typeof key === 'symbol') return false;
      (t as Record<string, unknown>)[key] = v;
      return true;
    },
    deleteProperty: (t, key) => {
      if (typeof key === 'symbol') return false;
      delete (t as Record<string, unknown>)[key];
      return true;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 对外：给 `applyReplaceRules` 用的求值器                                       */
/* -------------------------------------------------------------------------- */

export interface JsBindings {
  ruleId: number;
  ruleName: string;
  /** 上游 `chapter`（`BookChapter`）；本仓给最小对象或 null */
  chapter?: unknown;
  /** 上游 `book`（`ReplaceBook`）；本仓给最小对象或 null */
  book?: unknown;
}

/** 一次匹配求值所需的分组信息（由调用方从 `String.replace` 回调里解出来） */
export interface JsMatchArgs {
  /** 整个匹配（= `groups[0]`，上游 `matcher.group()`） */
  match: string;
  /** 第 0 项 = 整个匹配，其后是各分组 */
  groups: readonly string[];
  /** 命名分组（正则没有命名分组时为 undefined） */
  named?: Record<string, string | undefined>;
}

/**
 * 造一条规则的 `@js:` 求值器。
 *
 * 返回的函数**抛异常**表示「本条规则本次失败」⇒ 调用方按上游语义跳过该规则、正文保持不变
 * （并已在此处 `warnOnce` 点名）。**绝不返回「猜测的」文本**。
 */
export function createJsEvaluator(b: JsBindings): (script: string, m: JsMatchArgs) => string {
  const java = createJavaExtensions(b.ruleName);
  const warn = (what: string, detail: string): void => {
    warnOnce(
      `js-replace:${what}:${b.ruleId}`,
      `净化规则「${b.ruleName}」的 @js: 脚本${what === 'eval' ? '求值失败' : '出错'} ⇒ 本条本次不生效（正文保持原样）：${detail}`,
    );
  };
  return (script: string, m: JsMatchArgs): string => {
    const runner = getRunner(script);
    if (!runner) throw new Error('本页禁用了 eval（CSP）');
    const scope = makeScope({
      result: m.match,
      chapter: b.chapter ?? null,
      book: b.book ?? null,
      java,
    });
    let raw: unknown;
    try {
      raw = runner(scope);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      warn('eval', msg);
      throw new Error(msg);
    }
    /**
     * 上游 `RhinoScriptEngine.unwrapReturnValue():237-244` 把 Rhino 的 `Undefined` 归一成 Kotlin `null`，
     * 紧接着 `RegexExtensions.kt:59` 调的是 Kotlin 的 `Any?.toString()` ⇒ 得到字面量 **`"null"`**
     * （**不是** `"undefined"`、**不是**空串）⇒ 这里必须把 JS 的 `undefined` 一并映射成 `'null'`。
     * 照抄，只补一条留痕（否则用户只会看到正文里莫名多出 `null`）。
     */
    if (raw === undefined || raw === null) {
      warnOnce(
        `js-replace:null:${b.ruleId}`,
        `净化规则「${b.ruleName}」的 @js: 脚本没有返回值（undefined/null）——`
          + '上游此时会往正文插入字面量 `null`，本仓照抄；请检查脚本末句是否是表达式',
      );
      return 'null';
    }
    const jsOut = String(raw);
    try {
      return expandJavaReplacement(jsOut, m.groups, m.named);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      warn('group', msg);
      throw new Error(msg);
    }
  };
}
