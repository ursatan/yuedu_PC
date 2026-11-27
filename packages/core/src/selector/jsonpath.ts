/**
 * JSONPath 选择器后端（对齐 Legado AnalyzeByJSonPath.kt）
 *
 * 使用 jsonpath-plus（Jayway 语义近似，R5 风险已记录，待回归集对齐）。
 * 组合符 && || %% 在 splitRule 后逐段处理（§5.4）。
 */

import { JSONPath as jsonpath } from 'jsonpath-plus';
import { splitCombinator } from './rule-analyzer';
import type { AnalyzeEnv } from './types';

/**
 * 路径归一（对齐 Legado 的 Jayway JsonPath 语义）。
 *
 * ## ① 缺根前缀 `$`（`#639`，2026-10-26）
 * Jayway 允许**省略根标识**：`.[?(@.bookName)]`、`[*]`、`store.book` 都合法（内部补 `$`）。
 * jsonpath-plus 不补 ⇒ 这些路径**静默返回 0 条**，症状与「站点没数据」完全一致。
 *
 * 真站取证（书旗听书本地源（同人）`https___ocean.shuqireader.com`，用户实测第 4 条）：
 *   `ruleExplore.bookList = ".[?(@.bookName)]||.[?(@.title)]"`，bodyJs 交出 4061 字真书单
 *   `[{"bookId":"8877673","bookName":"全民：亡灵召唤师…"}, …]`
 *   · `.[?(@.bookName)]`      → **0 条**（旧）
 *   · `$.[?(@.bookName)]`     → 2 条
 *   · `[*]`                   → **0 条**（旧）
 *   · `$[*]`                  → 3 条
 * 同一份 body、同一套实现，只差一个 `$` —— 纯归一问题。
 *
 * ## ② `$.[` 不是递归下降
 * ⚠️ jsonpath-plus 把 **`$.[`** 当成 `$..`（递归下降）—— `$.[*]` 于是返回「所有后代节点」，
 * 而 Legado/Jayway 里 `$.[*]` 等价于 `$[*]`（只取根数组元素）。
 * 实测（绿柠小说 `ruleToc.chapterList = "$.[*]"`）：我们得到 **2444** 个节点，真实章节只有 **188**
 * —— 章节数错，且下游逐元素解析暴涨 13 倍（每元素一次 HTML 解析 → 内存雪崩/OOM）。
 * 只修「根处」的 `$.[`：`$..[...]`（真递归）与 `$.a[0]` 不受影响。
 */
function normalizeJsonPath(path: string): string {
  let p = path;
  // ① 省略 `$` 的写法照 Jayway 补齐（`@` 开头的相对路径不动）
  if (p && !p.startsWith('$') && !p.startsWith('@')) {
    p = p.startsWith('.') || p.startsWith('[') ? `$${p}` : `$.${p}`;
  }
  // ② 根处的 `$.[` → `$[`（jsonpath-plus 的递归下降陷阱）
  return p.startsWith('$.[') ? `$[${p.slice(3)}` : p;
}

/**
 * 文档归一化（对齐 Legado `AnalyzeByJSonPath.kt:18-22`）：
 * ```kotlin
 * fun parse(json: Any): ReadContext = when {
 *     is String -> JsonPath.parse(json)   // 字符串按 JSON 文本解析
 *     else -> JsonPath.parse(json)
 * }
 * ```
 * 两种形态必须在这里解析，否则 JSONPath 会在「字符串/包装对象」上找字段 → **恒空**：
 *  1. **JSON 字符串**：复合规则的段间传递就是这种形态 —— 段 1 是 `<js>`，段 2 是 `$.content`
 *     （实测 ① 宜搜小说正文规则 `<js>…java.ajax(url)</js>$.content<js>…</js>`；
 *      51漫画目录规则 `<js>…JSON.stringify(d)</js>$[*]` → 目录恒 0 章）。
 *  2. **String 包装对象**：`java.ajax` 返回的 StrResponse 是 `new String(body)` + 若干方法 ——
 *     `typeof` 是 `'object'`，旧逻辑直接原样交给 jsonpath → 同样恒空。
 *     这也是 ① 的第二层原因（段 1 的返回值就是 StrResponse）。
 *
 * ⚠️ 只在「看起来是 JSON」时才 parse：HTML/纯文本文档照旧原样传入（jsonpath 自然取不到值），
 * 与旧行为一致，也避免无谓的异常。
 */
function normalizeJsonDoc(v: unknown): unknown {
  let text: string | undefined;
  if (typeof v === 'string') text = v;
  else if (v instanceof String) text = String(v);
  if (text === undefined) return v;
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return v;
    }
  }
  return v;
}

function safeRead(path: string, json: unknown): unknown {
  try {
    return jsonpath({ path: normalizeJsonPath(path), json: json as object, wrap: false });
  } catch {
    return undefined;
  }
}

/** 把 {$.path} 形式的嵌入式 JSONPath 替换成实际取值（对齐 innerRule("{$.")） */
function expandEmbedded(rule: string, json: unknown): string {
  return rule.replace(/\{\$\.[^}]*\}/g, (token) => {
    const v = safeRead(token.slice(1, -1), json);
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export function jsonGetList(rule: string, valueIn: unknown, _env: AnalyzeEnv): unknown[] {
  const value = normalizeJsonDoc(valueIn);
  const { parts, type } = splitCombinator(rule);
  const lists: unknown[][] = [];
  for (const part of parts) {
    if (!part) continue;
    const r = safeRead(part, value);
    /**
     * ⚠️ **只有数组才算命中** —— 命中对象/标量一律当「没命中」（返回空）。
     *
     * 依据（上游逐行核实，不猜测）：`AnalyzeByJSonPath.getList`（`AnalyzeByJSonPath.kt:132-137`）
     * 走的是 `ctx.read<List<Any>>(rules[0])` —— Jayway 在目标不是数组时**抛异常**，
     * 被 catch 后函数直接落到末尾 `return result`（**空 ArrayList**）。
     * 而 `||` 的短路判据是 `if (!temp.isNullOrEmpty())`（同文件 :146-151）——
     * 空 ⇒ 不短路 ⇒ **继续试下一个备选**。
     *
     * 本仓此前写的是 `Array.isArray(r) ? r : r == null ? [] : [r]`，把「命中对象」包成 1 条
     * ⇒ `||` 在**错的备选**上短路 ⇒ 后面 `$.list` 永远不会被尝试 ⇒ 该元素再取
     * `ruleTitle="$.vod_name"` 必然为空 ⇒ 逐条被丢弃 ⇒ 列表 0 条。
     * 实测（2026-10-07，`#309`）：真实源「影视聚合(资源站)」`ruleArticles="$.data||$.list"`，
     * 响应是 `{code:1, data:{list:[…]}, list:[…]}` 形状时**整源归零**，报
     * `SELECTOR_MISS@parse · 列表规则解析为 0 条`；改成「非数组 = 未命中」后正常出 20 条。
     *
     * ★ 注意：`jsonGetStringList` 的 `[r]` 包装是**对的**，别顺手改 ——
     *   上游 `getStringList` 对非 List 走的是 `result.add(obj.toString())`（:96-104），
     *   两条路径的上游语义本来就不同。
     */
    const arr = Array.isArray(r) ? r : [];
    if (arr.length) {
      lists.push(arr);
      if (type === '||') break;
    }
  }
  if (type === '%%' && lists.length) {
    const out: unknown[] = [];
    const max = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  }
  return lists.flat();
}

/**
 * 取**原始值**（对齐 Legado `AnalyzeByJSonPath.getObject`，`AnalyzeByJSonPath.kt:128-130`）—— `#309`：
 * ```kotlin
 * internal fun getObject(rule: String): Any { return ctx.read(rule) }
 * ```
 *
 * ★ 与 `jsonGetList` 是**两条不同的上游路径**，别合：
 *   · `getList`   = `ctx.read<List<Any>>(rule)` —— 非数组**抛异常** → 空列表（见 `jsonGetList` 注释）；
 *   · `getObject` = `ctx.read(rule)`         —— **对象 / 标量 / 数组都能命中**。
 *
 * ★ 上游这里**不做 `&&`/`||`/`%%` 分段**（`getObject` 就一行 `ctx.read`），本函数同样不分段：
 *   `||` 原样进 `ctx.read` → 读不到 → `undefined`，与上游「抛异常 → 上游调用方无 catch」
 *   的净效果一致（都是「这条 init 不生效」）。分段只在 `getList`/`getStringList` 里做。
 *
 * 用途：`ruleBookInfo.init` 的求值入口是 `getElement`（`BookInfo.kt:58-62`），它走的就是这条。
 * 语料实证（2026-10-07，`tmp/scan-init.txt`）：23 个源的 `init` 里 2 个是 JSONPath 取**对象**
 * （🥝猕猴桃漫画 `$.data`、松鹤庭沐·言璃版 `$.data.bookInfo`）—— 误用 `jsonGetList` 会让它们恒空。
 */
export function jsonGetObject(rule: string, valueIn: unknown, _env?: AnalyzeEnv): unknown {
  const value = normalizeJsonDoc(valueIn);
  const expanded = expandEmbedded(rule, value);
  const r = safeRead(expanded, value);
  // 内嵌 {$.x} 展开成了字面量（如 `https://x/{$.id}.txt`）——不再是路径，回退用展开后的文本
  if (r == null && expanded !== rule) return expanded;
  return r;
}

/**
 * JSONPath 取值为**字符串**时的文本化（对齐 Legado `AnalyzeByJSonPath`）。
 *
 * ⚠️ 取到对象/数组时必须 `JSON.stringify`，**不能 `String()`**（2026-09-16 修）：
 * `String({})` 得到 `"[object Object]"`，数据全丢。实测症状——全免漫画
 * `ruleToc.chapterList` 的 `<js>` 里写 `String(java.getString("$.data"))` 再 base64+AES 解密，
 * 因为拿到的是 `"[object Object]"`，解密必然失败 → 目录为空（站点数据实测可正常解出 50 章）。
 * Legado 对 Map/List 结果走 `GSON.toJson`，语义即「返回 JSON 文本」。
 */
function jsonValueToText(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'object') {
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  }
  return String(x);
}

export function jsonGetStringList(rule: string, valueIn: unknown, _env: AnalyzeEnv): string[] {
  const value = normalizeJsonDoc(valueIn);
  const { parts, type } = splitCombinator(rule);
  const results: string[][] = [];
  for (const part of parts) {
    if (!part) continue;
    const expanded = expandEmbedded(part, value);
    const r = safeRead(expanded, value);
    let strs: string[];
    if (r == null) {
      // 内嵌 {$.x} 展开后是字面量（如 chapterUrl https://x/{$.id}.txt）——不再当路径求值
      strs = expanded !== part ? [expanded] : [];
    } else {
      strs = Array.isArray(r) ? r.map(jsonValueToText) : [jsonValueToText(r)];
    }
    /**
     * ★★ `#415` **`||` 的短路判据是「首个非空备选」，不是「首个有产出备选」**。
     *
     * 依据（本仓对上游的既定口径，见 `jsonGetList` 的 `#309` 注释与
     * `docs/archive/01-开发计划-snapshot-20260928.md` §5.4「`||` 首个非空即 break」）：
     * `||` 必须在**取不到非空文本**时继续试下一个备选。
     *
     * 缺陷形态（LOFTER 真源实测，2026-10-12）：`ruleTitle` 是长 `||` 链
     * `$.postData.postView.title||…||$.postData.postView.digest||…`。图集类帖子的
     * `postView.title` **命中空串** —— 旧实现把「命中空串」当成命中并 `break`
     * ⇒ 后面的 `digest`（真正有正文的那条）**永远不被尝试**
     * ⇒ 每条 item 的 title 都是空 ⇒ `parseRssByRule` 逐条丢弃
     * ⇒ `SELECTOR_MISS@parse · 列表规则解析为 0 条`（用户症状）。
     *
     * 与 `jsonGetList` 的 `#309` 修正**同一条纪律**（那里是「命中对象/标量 ≠ 命中数组」，
     * 这里是「命中空串 ≠ 命中非空」）——两个 `||` 后端判据必须一致，否则同类缺陷各修一半。
     *
     * ⚠️ `||` 分支**只返回胜出备选**（不累积）——若把 `['', digest]` 一起 flat，
     * `jsonGetString` 会按「多于一条」用 `\n` 拼接，多出一个前导换行。
     */
    if (type === '||') {
      const nonEmpty = strs.filter((s) => s.trim() !== '');
      if (nonEmpty.length) return nonEmpty;
      continue; // 命中但全空 ⇒ 视为未命中，继续下一个备选
    }
    if (strs.length) results.push(strs);
  }
  if (type === '%%' && results.length) {
    const out: string[] = [];
    const max = Math.max(...results.map((l) => l.length));
    for (let i = 0; i < max; i++) for (const l of results) if (i < l.length) out.push(l[i] as string);
    return out;
  }
  return results.flat();
}

export function jsonGetString(
  rule: string,
  value: unknown,
  env: AnalyzeEnv,
  isUrl = false,
): string {
  const list = jsonGetStringList(rule, value, env);
  if (list.length === 0) return '';
  if (isUrl) {
    const first = list.find((s) => s.trim() !== '');
    return env.toAbsolute ? env.toAbsolute(first ?? '') : first ?? '';
  }
  return list.length === 1 ? list[0] as string : list.join('\n');
}
