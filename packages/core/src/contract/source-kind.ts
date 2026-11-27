/**
 * 源格式归属识别 —— **唯一实现**（Web / 服务端 / 各引擎共用）。
 *
 * ## 为什么要有这个文件（2026-10-07，`#312`）
 * 同一条判据此前在**两处各写了一遍**，且已经漂移：
 *   · `@yuedu/engine-legado` 的 `detectBookSource` —— 要求「有主键 **且** 有
 *     searchUrl/ruleSearch/ruleBookInfo/ruleToc 之一」；
 *   · `@yuedu/facade` 的 `looksLegado` —— 只要求「有 bookSourceUrl **或** bookSourceName
 *     或 ruleSearch 或 ruleBookInfo」，**不要求主键**。
 * ⇒ 同一个源在「导入层」与「引擎层」可能得到**相反**结论；且两边都会误杀**纯发现源**
 *   （只有 `exploreUrl`、没有搜索侧规则的源）—— 实测报「不是 Legado 书源」而导入失败。
 *
 * ## 上游口径（逐字核实，别凭印象改）
 * `BookSourceImport.kt:122-126`：
 * ```kotlin
 * private fun BookSource.requireBookSourceUrl() {
 *     if (bookSourceUrl.isNullOrBlank()) throw NoStackTraceException("不是书源")
 * }
 * ```
 * 官方测试 `BookSourceImportTest.kt`：
 *   · `{"bookSourceUrl":"https://example.com/one","bookSourceName":"One"}` —— **没有任何规则字段**
 *     ⇒ 判**有效**；
 *   · `{"bookSourceName":"Missing URL"}` ⇒ 判「不是书源」。
 * ⇒ **上游的唯一判据就是「主键非空」**，「必须有搜索规则」是本仓的自我发明。
 *
 * ## 本文件为什么能放进契约出口
 * 零 `import`、无副作用、纯函数 —— 与同目录放行的 `source-share-passphrase.ts` 同一性质
 * （判据见 `contract/index.ts` 文件头）。⚠️ 往这里加东西前先自证依赖闭包仍是空的。
 */

/**
 * 判定一份配置是不是 Legado 书源。
 *
 * @param raw 待判定的原始对象（数组 / 非对象一律 false）
 *
 * ⚠️ MacCMS（`apiUrl`）与 ZYFun（`rule`）**不需要在这里排他** —— 它们都没有
 * `bookSourceUrl` 主键，第一条判据就把它们排掉了；它们各自的识别函数会认领
 * （`detectRssSource` / `looksMaccms` 也一律「有 bookSourceUrl 则不算自己」）。
 * 反过来，在这里用 `apiUrl` 排他会造出**谁都不认**的源（实测：`{apiUrl, bookSourceUrl}`
 * 两个识别函数同时返回 false）。
 */
export function isLegadoBookSource(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const url = (raw as Record<string, unknown>)['bookSourceUrl'];
  // 上游 `isNullOrBlank()` 语义：空串与纯空白都算「没有主键」
  return typeof url === 'string' && url.trim() !== '';
}
