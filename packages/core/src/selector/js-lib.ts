/**
 * jsLib 三形态解析 + 归一（`#344`）—— **唯一实现**，两引擎共用。
 *
 * ## 上游语义（Legado 源码逐行核实，不猜）
 * `SharedJsScope.kt:231-276`：
 * ```kotlin
 * private fun evaluateJsLib(jsLib, scope, …) {
 *   val jsMap = parseJsLibMap(jsLib)      // ① jsLib 本身是 JSON **对象** ⇒ 当「库名→URL」映射表
 *   if (jsMap != null) {
 *     jsMap.values.forEach { value ->
 *       if (value.isAbsUrl()) {            // ② 每个 value 若**是绝对 URL** ⇒ 下载其 JS 并 eval 到同一 scope
 *         val js = aCache.getAsString(fileName) ?: 下载并缓存
 *         RhinoScriptEngine.eval(js, scope, …)
 *       }                                  // ③ value 非 URL ⇒ **跳过**（不 eval，不报错）
 *     }
 *   } else {
 *     RhinoScriptEngine.eval(jsLib, scope, …)   // ④ jsLib 不是 JSON 对象 ⇒ 直接当 JS 源码
 *   }
 * }
 * private fun parseJsLibMap(jsLib): Map<String,String>? {
 *   if (!jsLib.isJsonObject()) return null          // 注意：**对象**才判 map，数组不算
 *   return runCatching { GSON.fromJson<Map<String,String>>(jsLib) }.getOrNull()
 * }
 * ```
 * 同文件 `remove()`（:134）也走 `parseJsLibMap(jsLib)?.values` 清理缓存 ⇒ 这条「对象=映射表」
 * 判据在上游是**成对使用**的，不是孤例。
 *
 * ## 本仓为什么必须支持（`#344` 实测）
 * 用户报障源（`qyyuapi.com/dy/hx/V2.1.d.json` 的剧迷 / Movieffm / 西瓜卡通）：
 * `jsLib = { "剧迷":"https://qyyuapi.com/dy/js/剧迷/jsLib.js", "通用":"https://qyyuapi.com/js/common.js" }`
 * —— 是**映射表**，不是 JS。旧实现把整段 json 当脚本 eval ⇒ `Unexpected token ':'`
 * （报错片段正是 `"剧迷":"…jsLib.js",` 那一行，`yuedu-rule.js:2`）。
 * 修好后这些源里 `{{Get('url')}}` 之类的库函数才能定义。
 *
 * ## ⚠️ 三种形态的判别顺序（别写反）
 * 1. 先 trim；空 ⇒ `undefined`（无 jsLib）。
 * 2. **内部** 尝试 JSON 对象解析 ⇒ 命中转映射表分支（逐个 value 处理）。
 * 3. 否则看**整体**是否单个绝对 URL ⇒ 下载（单 URL 是「表」退化成一键的特例，上游也走
 *    `isAbsUrl` 下载，只是它要求先包成 map；本仓允许裸 URL 同样下载，兼容更多源写法）。
 * 4. 否则 ⇒ 内联 JS 源码，原样返回。
 */

/** JSON 对象形态的 jsLib 映射表（键=库名、值=URL 或源码）；非对象/解析失败 ⇒ null */
export function parseJsLibMap(jsLib: string): Record<string, string> | null {
  const s = jsLib.trim();
  if (!s.startsWith('{')) return null; // 上游 isJsonObject：只有对象才是 map（数组/裸串不算）
  try {
    const v = JSON.parse(s) as unknown;
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** 是否绝对 URL（上游 `isAbsUrl`：http/https 起头） */
export function isAbsUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** 收集 jsLib 里需要下载的 URL（映射表形态取所有 value；单 URL 形态取自身） */
export function jsLibUrls(jsLib: string): string[] {
  const s = jsLib.trim();
  if (!s) return [];
  const map = parseJsLibMap(s);
  if (map) return Object.values(map).filter(isAbsUrl);
  return isAbsUrl(s) ? [s] : [];
}

/**
 * 把 jsLib 归一成**可直接 eval 的 JS 源文本**。
 *
 * @param jsLib   源的 jsLib 原文（可为空）
 * @param fetchJs 同步取 JS 文本的下载器（URL ⇒ 源码；返回 null/抛出 = 下载失败，跳过该库）
 * @returns 拼接好的 JS 源（多库按映射表顺序 `\n` 连接）；无 jsLib ⇒ undefined
 *
 * ★ 拼接顺序必须稳定（JSON 对象键序在现代 JS 里保持插入序）—— 上游 `values.forEach` 同序。
 * ★ 单个库下载失败**只跳过它**（上游抛异常会中断整表，但那会让所有源都挂；本仓按「尽力而为」
 *   取更稳的行为，且把失败留给调用方留痕）。
 */
export function resolveJsLibText(
  jsLib: string | null | undefined,
  fetchJs: (url: string) => string | null,
): string | undefined {
  const s = String(jsLib ?? '').trim();
  if (!s) return undefined;
  const map = parseJsLibMap(s);
  if (map) {
    const parts: string[] = [];
    for (const value of Object.values(map)) {
      // 上游：value 非 URL ⇒ 跳过（不 eval、不报错）
      if (!isAbsUrl(value)) continue;
      const js = fetchJs(value);
      if (js) parts.push(js);
    }
    return parts.length ? parts.join('\n') : undefined;
  }
  if (isAbsUrl(s)) {
    const js = fetchJs(s);
    return js ?? undefined;
  }
  return s; // 内联 JS 源码
}
