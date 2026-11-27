/**
 * Rhino / V8 **语法宽松度差异**兼容层（本轮 `#639`，2026-10-26）。
 *
 * ## 为什么需要它
 * 上游 legado 的 JS 引擎是 `org.htmlunit.corejs`（Rhino 分支），本仓是 V8（Node `new Function`）。
 * 两者对「参数名 + 同名 `let`/`const`」的判定**不同**：
 *
 * ```js
 * function GetUrl(path, params, sourceUrl) {
 *   let sourceUrl = sourceUrl || "https://ocean.shuqireader.com";  // ← 与形参同名
 * }
 * ```
 *  · Rhino：`let` 是**块级**声明，只是遮蔽形参 ⇒ **合法**，作者在原站跑得好好的；
 *  · V8  ：`SyntaxError: Identifier 'sourceUrl' has already been declared`。
 *
 * ## 后果为什么是「整源瘫痪」而不只是「少一个函数」
 * jsLib 是**每次求值前的前导代码**（上游 `AnalyzeRule.getJSLib` / `SharedJsScope.getScope`）。
 * 它编不出来 ⇒ 宿主 jsLib 预编译失败退逐次编译 ⇒ 逐次编译**仍然带上这段文本** ⇒
 * **每一条** `{{…}}` 插值、每一条 `@js:` 规则一起抛错。
 * 实测（🏷书旗小说 `https___ocean.shuqireader.com_1`，搜索 0 条）：
 * ```
 * [js] jsLib 预编译失败，回退逐次编译路径： Identifier 'sourceUrl' has already been declared
 * [url-interp-ERR] SyntaxError: Identifier 'sourceUrl' has already been declared
 * [url-out] …&q={{key}}&page={{page}}&size=10…   ← 模板原样发出，站点只回「parameter is missing」
 * ```
 * 症状（搜索 0 / 发现空 / 目录 0）看起来全是「规则写错」或「站点改版」，极难归因 —— 与
 * `#606`（jsLib 下载失败被误判成源缺陷）是同一类「基础设施故障伪装成源缺陷」。
 *
 * ## 为什么只放宽「参数同名」这一类
 * 语料实测（`tmp/probe-jslib-compat.mjs`，746 源 / 111 带内联 jsLib）：V8 编不过 **29 条**，
 * 其中 **27 条是 JSON 映射表形态 jsLib**（`{"crypto":"https://…"}`，由
 * `resolveJsLibText` 负责下载拼接，探针误判为语法错），**只有 2 条**是真语法差异：
 *   · 🏷书旗小说 `function GetUrl(…, sourceUrl){ let sourceUrl = … }`
 *   · 🏷长佩文学 `function AESencrypt(text, key, iv){ let key = …; let iv = … }`
 * 两条都是「形参与同名 `let`」。而「同一作用域 `let` 重复声明」Rhino 同样报错 ⇒ **不该放宽**
 * （那是源作者的真 bug，替它圆过去会掩盖问题，违反「不替源圆谎」纪律）。
 *
 * ## `let` → `var` 是否改变语义
 * 参数重声明为 `var` 在 sloppy 模式是**合法 no-op**：`var x = x || def` 读到的就是形参值。
 *  · 书旗 `GetUrl(path, params)` 只传 2 参 ⇒ 形参 `undefined` ⇒ 取默认域名；
 *  · 长佩 `var key = "u0LR…"` 直接覆盖形参，函数体随后用的就是它。
 * 两处结果与 Rhino 逐字一致。唯一的理论差异：块结束后形参被 `var` 永久覆盖（原 `let` 会还原），
 * 但这 2 个源在块后都不再读该名字（已逐行核对）。
 *
 * ## 成本与可回退
 * 只在 `opts.lib` 存在时做一次 `new Function` **编译检查**（不执行），结果按文本 memo；
 * 编译通过（109/111 源）时**零改写**。`YUEDU_JS_RHINO_COMPAT=0` 可整体关闭。
 */

/** 已检查且**无需改写**的文本（只存引用，不复制；111 个内联 jsLib 里 109 个落这里） */
const okSeen = new Set<string>();
/** 已改写的结果：src → 改写文本（语料里只有 2 个源，量级极小） */
const rewrites = new Map<string, string>();

/** 只在「有 let/const」时才值得做编译检查，省掉绝大多数源的 try/catch */
const HAS_BLOCK_DECL = /\b(?:let|const)\s+[A-Za-z_$]/;

function compiles(src: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(src);
    return true;
  } catch {
    return false;
  }
}

function compileError(src: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(src);
    return null;
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 该名字是否出现在某个形参表里（`(name)` / `(a, name` / `(a = 1, name = 2)` …） */
function isParamName(src: string, name: string): boolean {
  const n = escapeRe(name);
  // 前后都要限定：`(name` / `, name` 开头，`)` / `,` / `=` 结尾
  return new RegExp(`[(,]\\s*${n}\\s*[,)=]`).test(src);
}

/**
 * 把与形参同名的 `let`/`const` 声明降级为 `var`，使 Rhino 能编的 jsLib 在 V8 也能编。
 *
 * 返回**可安全使用**的文本：无法归因的错误一律返回原文（让调用方按原样报错，不掩盖真因）。
 */
export function relaxLetParamShadow(src: string, label = 'jsLib'): string {
  if (!src || !HAS_BLOCK_DECL.test(src)) return src;
  if (process.env['YUEDU_JS_RHINO_COMPAT'] === '0') return src;
  if (okSeen.has(src)) return src;
  const rewritten = rewrites.get(src);
  if (rewritten !== undefined) return rewritten;

  let code = src;
  const trail: string[] = [];
  for (let i = 0; i < 8; i++) {
    const err = compileError(code);
    if (!err) {
      if (!trail.length) {
        okSeen.add(src);
        return src;
      }
      // 留痕（铁律 4：兜底不能静默）—— 这是「源作者的写法只有 Rhino 认」的取证点
      console.warn(
        `[js] ${label} 含 Rhino 可用但 V8 非法的「形参同名 let/const」，已按 var 语义放行：` +
          `${trail.map((n) => `let ${n}→var ${n}`).join(', ')}`,
      );
      rewrites.set(src, code);
      return code;
    }
    const m = /Identifier '([\w$]+)' has already been declared/.exec(err);
    if (!m) break;
    const name = m[1] as string;
    /**
     * 只有「该名字确实是某个函数的形参」才放宽 —— 其余重声明（同作用域两个 `let x`）
     * Rhino 也报错，属于源自己的 bug，不替它圆。
     */
    if (!isParamName(code, name)) break;
    const re = new RegExp(`\\b(let|const)(\\s+)(${escapeRe(name)})\\b`, 'g');
    const next = code.replace(re, (_m, _kw, ws, n) => `var${ws}${n}`);
    if (next === code) break;
    code = next;
    trail.push(name);
  }
  // 改不好 ⇒ 返回原文（保持旧行为，不制造「半修好」的假象）
  const out = compiles(code) ? code : src;
  if (out === src) okSeen.add(src);
  else rewrites.set(src, out);
  return out;
}
