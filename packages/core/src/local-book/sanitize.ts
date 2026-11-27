/**
 * TXT 目录标题净化 —— **受支持的纯表达式子集**（`#212` ⑥）
 *
 * ## 为什么不是一个 JS 求值器
 * 上游 `TextFile.kt:578 evalJs()` 用 Rhino **真的跑**这段 JS：
 * ```kotlin
 * bindings["result"] = content      // 标题原文
 * bindings["index"] = index         // 第几章（从 1 起）
 * bindings["prevTitle"] = prevTitle
 * bindings["prevLength"] = prevLength
 * bindings["lastVolumeTitle"] = lastVolumeTitle.value
 * eval(jsStr, bindings)
 * ```
 * 而这段 `jsStr` **来自本地书文件自身**（`book.tocUrl` 的第二段）—— 导入的是**外来文件**。
 *
 * 本仓铁律 4：**不执行外来文件里的脚本**（`docs/live/notes-local-book.md` §四条不变量）。
 * 上游那条路等于「打开一个 txt 就执行它内嵌的代码」，我们不走。
 *
 * ## 那这条能力怎么给
 * 目录规则里的净化**绝大多数场景只是「把标题里多余的字符去掉」**（去序号前缀、
 * 去《书名》、去「最新章节」后缀…）。这类需求 **100% 可以用正则 + 组引用表达**，
 * 不需要通用求值。所以我们提供一个**只认识正则操作**的迷你语法：
 *
 * | 写法 | 语义 |
 * |---|---|
 * | `@replace:<正则>@<替换>` | 正则替换（替换串支持 `$0`/`$1`…） |
 * | `@replace:<正则>` | 同上去掉匹配（替换串为空） |
 * | `@trim` | 去首尾空白 |
 * | 空串 / `@all` | 原样返回（不做净化，等价上游 `jsStr.isNullOrBlank()` 早返回） |
 * | 多条 | 换行 / `;` 串联，依次执行 |
 *
 * > 替换串的 `$0`/`$N` 语义走 `txt.ts` 的 `expandGroupRefs`（Android `Matcher.appendReplacement`
 * > 同款：`$0` = 整个匹配 —— ⚠️ JS 原生 `String.replace` **不认 `$0`**）。
 *
 * ## 「不支持的表达式 ⇒ 不改标题」而不是「当空标题丢掉」
 * 上游 `replacement(...).takeIf { it.isNotEmpty() } ?: continue` 会把「净化成空」的章
 * **整章丢掉**（`continue`）。这对**用户自定义 JS 净化**是合理语义（用户明说了「标题空了就不要」），
 * 但对我们不合适：
 * - 我们跑不了用户的 JS ⇒ 无法区分「用户要丢掉」与「我们不支持」；
 * - 铁律 3：**不静默**。把「不支持」误判成「要丢掉」= **静默丢章节**（比改错标题更糟）。
 * ⇒ 遇到不支持的表达式：**保留原标题** + `warnOnce` 留痕。
 */

/** 净化器识别并执行的一条操作 */
export interface SanitizeOp {
  kind: 'replace' | 'trim';
  /** `replace` 用：正则源码（由调用方编译，保持「正则构造唯一实现」） */
  src?: string;
  /** `replace` 用：替换串（含 `$0`/`$N` 组引用） */
  to?: string;
}

/**
 * 解析净化表达式 ⇒ 操作列表（**纯词法，不执行任何东西**）。
 *
 * 返回 `null` 表示「这个表达式本仓不支持」⇒ 调用方应**保留原标题**并留痕。
 *
 * 支持形态（**整串匹配**，不做子串查找 —— 否则裸 `x` 会被误当成合法表达式）：
 * - 空串 / 全空白 ⇒ `[]`（identity）；
 * - `@all` ⇒ `[]`（identity，显式）；
 * - `@trim` ⇒ `[trim]`；
 * - `@replace:<re>@<to>`（第二个 `@` 可省略 ⇒ `<to>` 为空） ⇒ `[replace]`；
 * - 上述多条用 `\n` / `;` 串联 ⇒ 依次执行。
 */
export function parseSanitize(expr: string | null | undefined): SanitizeOp[] | null {
  const raw = (expr ?? '').trim();
  if (!raw) return [];
  if (raw === '@all') return [];
  const parts = raw
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ops: SanitizeOp[] = [];
  for (const p of parts) {
    if (p === '@trim') {
      ops.push({ kind: 'trim' });
      continue;
    }
    const m = /^@replace:([\s\S]+?)(?:@([\s\S]*))?$/.exec(p);
    if (m && m[1]) {
      ops.push({ kind: 'replace', src: m[1], to: m[2] ?? '' });
      continue;
    }
    return null; // 出现任何不认识的片段 ⇒ 整条不支持（宁可不动，不可误伤）
  }
  return ops;
}

/** 只报一次的告警集合（同名只报一次；调用方决定怎么写日志） */
const warned = new Set<string>();
export function warnOnceSanitize(key: string, onWarn?: (k: string) => void): void {
  if (warned.has(key)) return;
  warned.add(key);
  onWarn?.(key);
}
