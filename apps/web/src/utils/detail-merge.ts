/**
 * `#750` 详情对象的**合并语义**（从 `stores/reader.ts` 抽出的纯函数，便于回归锁）。
 *
 * 上游怎么做的（逐条核对）：
 *  · `BookInfo.kt:68-148` —— 详情规则求值后**直接在同一个 `Book` 对象上赋值**：
 *    书名/作者「非空才覆盖」（`if (it.isNotEmpty() && …) book.xxx = it`），
 *    封面同理（`if (it.isNotEmpty()) book.coverUrl = …`）⇒ **空值不会把已有值抹掉**；
 *  · `BookInfoViewModel.kt:157-176` —— 进详情时先把列表拿到的 `Book`（含列表封面）
 *    `bookData.postValue`，再用 `loadBookInfo` 原地刷新 ⇒ 详情页首帧看到的是列表封面，
 *    刷新后换成详情封面（上游本来就允许替换）。
 *
 * 本仓的对应契约：
 *  · `openDetail` 先放一个「卡片种子」`{ title, cover }`（**没有 id**）；
 *  · 流式 `detail` 的首帧（`onPartial`）与终帧可能字段不全；
 *  · ⚠️ 旧实现 `if (!prev?.id || !n.id || prev.id !== n.id) return n` 会让**卡片种子**
 *    （无 id）被整体替换 ⇒ 详情封面为空时封面直接消失（`#750` 用户实测的空白形态之一）。
 *
 * 现在的判据：**只有「两边都有 id 且不同」才是换书**；其余都按「新值优先、缺失回落旧值」。
 */

/** 只声明本文件用到的字段；其余原样透传（保持调用方 `ReaderDetail` 的完整形状） */
type DetailRecord = Record<string, unknown> & {
  id?: string;
  title?: string;
  subtitle?: string;
  summary?: string;
  author?: string;
  intro?: string;
  cover?: string;
  tags?: string[];
  meta?: Record<string, string>;
  chapters?: unknown[];
};

/** 兼容别名：`author = subtitle`、`intro = summary`（引擎契约 → 界面字段） */
export function normalizeDetail<T extends object>(d: T): T {
  const o = d as DetailRecord;
  return { ...o, author: o.author ?? o.subtitle, intro: o.intro ?? o.summary } as T;
}

/** 同书合并：新值优先，缺失项回落到旧值；换书（id 不同）一律用新对象 */
export function mergeDetail<T extends object>(prev: T | null, next: T): T {
  const n = normalizeDetail(next);
  if (!prev) return n;
  const p = prev as DetailRecord;
  const out = { ...n } as DetailRecord;
  if (p.id && out.id && p.id !== out.id) return n;
  for (const k of ['title', 'subtitle', 'author', 'summary', 'intro', 'cover'] as const) {
    if (!out[k] && p[k]) out[k] = p[k];
  }
  if (!(out.tags as string[] | undefined)?.length && (p.tags as string[] | undefined)?.length) out.tags = p.tags;
  if (!(out.meta && Object.keys(out.meta as object).length) && p.meta) out.meta = p.meta;
  if (!(out.chapters as unknown[] | undefined)?.length && (p.chapters as unknown[] | undefined)?.length) out.chapters = p.chapters;
  return out as T;
}
