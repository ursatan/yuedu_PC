/**
 * 列表项（`UnifiedItem`）里那几个**「契约上没有、但引擎会写进 payload」**的字段读取器。
 *
 * ## 为什么需要这个文件（本轮修掉的真缺陷）
 * `UnifiedItem`（`packages/core/src/contract/types.ts:92-110`）只有
 * `id / kind / title / cover / subtitle / summary / tags / layout / payload / raw` ——
 * **没有 `author`**，也没有 `lastChapter`。
 * 但引擎在 list 阶段会按 Legado `BookList.kt` 逐条求值，把 `author` / `lastChapter`
 * **塞进 `payload`** 带走（payload 的契约就是「传给下一阶段的最小上下文」，见 types.ts:102-107）。
 *
 * ⇒ 于是出现了一个**不报错的静默错误**：
 * ```vue
 * <CoverImage :author="String(it.author ?? '')" />   <!-- 永远 '' -->
 * ```
 * 类型上 `it` 常被当 `Record<string, unknown>` 传，`it.author` 不存在也**不会报错**，
 * 只是恒为空串 ⇒ 默认封面上永远画不出作者。
 * （这个错误在本轮之前同时存在于 3 处：`DiscoverView` 网格 + 列表、`SearchView`。）
 *
 * ## 为什么抽成共享函数而不是每页各写一遍
 * 「作者 = `payload.author`」是**跨三个页面的一条事实**。散着写就会重演
 * 「同一份真相分散在多处 → 改一处漏两处」的老问题（本仓铁律：同一语义只此一份实现）。
 */
import type { UnifiedItem } from '@yuedu/core/contract';

type Loose = Partial<UnifiedItem> & Record<string, unknown>;

/** `payload` 解包成 `Record<string, unknown>`（payload 可以是任何结构，别假设类型） */
function payloadOf(it: Loose | null | undefined): Record<string, unknown> {
  const p = it?.payload;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

/** 取字符串字段；非字符串一律当空（上游列表阶段的脏数据不少，不编造） */
function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 作者 —— 引擎在 list 阶段写入 `payload.author`（取自 `ruleExplore/ruleSearch.author`）。
 *
 * ⚠️ 源没给就**留空**，不拿 `subtitle` 顶替（`DiscoverView.vue:399-403` 记着这条教训：
 * `subtitle = 作者 || 更新至`，顶替会让「最新章节」被填进作者位，两行一起错位）。
 */
export function itemAuthor(it: Loose | null | undefined): string {
  return str(payloadOf(it), 'author');
}

/** 最新章节 —— `payload.lastChapter`（③ 行用；同样只在 payload 里） */
export function itemLastChapter(it: Loose | null | undefined): string {
  return str(payloadOf(it), 'lastChapter');
}

/**
 * 列表项的**身份键**（`v-for` 的 `:key` 用）—— `#176`。
 *
 * ## 为什么不能直接用数组下标（用户 2026-10-01 实测的 bug 根因）
 * 「切换分类，加载图片时会看到之前图片残留」—— 切分类时 `items` **整体替换**，
 * 但下标 `0,1,2…` 两批数据**完全一样** ⇒ Vue 认为「还是这批节点」，只更新属性、
 * **不重建 DOM** ⇒ 封面 `<img>` 实例被复用。旧图在新 `src` 解码完成前一直留在屏幕上
 * （浏览器行为：换 `src` 不会立刻卸载旧图，要等新图 `decode()` 完）。
 *
 * 这与「虚拟列表 DOM 复用」是同一类问题的两种表现：只要节点被复用，旧内容就有机会闪出来。
 * `CoverImage` 里的 `loading` 态从**组件内部**堵住了这一半（不挂 `src` ⇒ 旧图被卸载）；
 * 这里改 key 从**源头**让换分类时节点真的重建，堵住另一半。
 *
 * ## 为什么不用 `it.id` 单字段
 * `UnifiedItem.id` 由引擎生成，不同源的生成规则不一定一致（有可能撞）；
 * 而 `payload` 里的 `bookUrl` / `vodId` 才是**内容身份**（对应 Legado 的 `Book.tableId`）。
 * 优先用这几个稳定字段，退化时再拼上标题 —— 宁可 key 长一点，也不要复用错节点。
 */
export function itemIdentity(it: Loose | null | undefined): string {
  if (!it) return '';
  const p = payloadOf(it);
  // 内容身份字段：Legado 的 bookUrl、MacCMS 的 vod_id/url 都落在这里（见 `stores/reader.ts` 的 itemKey）
  for (const k of ['bookUrl', 'vodId', 'vod_id', 'url', 'link', 'id']) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) return `${String(it.kind ?? '')}|${v.trim()}`;
  }
  // 引擎给的 id 兜底（仍带上标题，避免同一 id 覆盖不同内容）
  const engineId = typeof it.id === 'string' ? it.id.trim() : '';
  if (engineId) return `${String(it.kind ?? '')}|${engineId}|${String(it.title ?? '')}`;
  // 什么都没有：只key 标题 + 序号由调用方补，宁可重复也不复用错节点
  return `${String(it.kind ?? '')}|${String(it.title ?? '')}`;
}
