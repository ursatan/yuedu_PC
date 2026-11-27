/**
 * 源筛选框的**字段口径**（`#280`）—— 名称 / URL / 注释 / 分组，四处共用这一份。
 *
 * 此前各页各写各的：发现页/工坊只搜 `name + id(URL)`、源管理搜 `name + id + comment`
 * 却漏了分组、搜索页源列表只搜 `name + id`（用户 `#280`：「筛选框：支持搜索：名称/URL/注释/分组」）。
 * 统一从本函数走，字段口径只写一遍。
 *
 * `group` 是 `,`/`，`/`&` 分隔的多组字符串（见 `source-groups.ts`），直接整串 includes 即可 ——
 * 用户按组名片段筛（如「官方」）本来就该命中。
 */

/** 可搜索源的最小结构（`SourceInfo` 的子集，避免把 api 类型拖进来） */
export interface QueryableSource {
  id: string;
  name?: string;
  comment?: string;
  group?: string;
}

/** 是否命中筛选词（空词 = 不筛选，恒真） */
export function matchSourceQuery(s: QueryableSource, q: string): boolean {
  const kw = q.trim().toLowerCase();
  if (!kw) return true;
  return [s.name, s.id, s.comment, s.group].some((v) => String(v ?? '').toLowerCase().includes(kw));
}

/** 筛选框占位文案（四处共用同一句，口径改动只改这里） */
export const SOURCE_QUERY_PLACEHOLDER = '搜索 名称 / URL / 注释 / 分组…';
