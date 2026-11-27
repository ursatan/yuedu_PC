/**
 * `#273` 跨源搜索 · 结果归并 —— **纯函数层**（参考 `F:\OmniFlow` `aggregate-search.ts`，
 * 语义对齐但结构贴合本仓：本仓引擎在服务端，归并发生在**前端 store** 消费 SSE 事件之后）。
 *
 * ## 两层归并（与 OmniFlow 同构）
 * ① **per-src 隔离**：每个源的结果存在自己的 `pages` 里（原始 items，**不跨源合并**）——
 *    单源视图平铺展示，卡片数永远和该源返回数一致；
 * ② **聚合视图**：各源各页 flat 后按 `dedupId` 合并（同作品补封面/简介、`sources` 追加），
 *    排序 = sources 数降序（被越多源收录越靠前）→ updatedAt 降序，再截断 maxHits。
 *
 * ## dedup key 为什么不是 md5
 * OmniFlow 用 `md5(kind|norm)` 只是为了 URL 紧凑；本仓 dedupId 只当 Map key +
 * 本地反查用，不需要进 URL ⇒ 直接用字符串 `` `${kind}\u0001${norm}` ``（NUL 分隔防拼撞），
 * 少一个哈希依赖、调试时肉眼可读。
 */

/** 归并卡里「某源上的一个条目」引用 —— 本仓详情调用的主键是 **payload**（不是字符串 itemId） */
export interface SourceHitRef {
  sourceId: string;
  /** 该源上的原始标题（同一作品在不同源可能带前后缀，详情页跳转用原始 payload 不受影响） */
  title: string;
  /** 引擎 list 阶段产物 —— `reader.openDetail` / `vod.openDetail` 的第二参就吃它 */
  payload: unknown;
  cover?: string;
}

/** 聚合视图的一张卡（同作品跨源合并） */
export interface MergedHit {
  dedupId: string;
  /** 首个命中的原始标题（各源标题可能不同，展示取第一个） */
  title: string;
  kind: string;
  cover?: string;
  summary?: string;
  /** 各源 tags 的去重并集（保序） */
  tags: string[];
  sources: SourceHitRef[];
  updatedAt: number;
  /** `#511` 作者（引擎写在 `payload.author`）——匹配度评分用（作者命中也是相关性信号） */
  author?: string;
}

/**
 * `#511` **搜索匹配度评分**（对齐 Legado `SearchModel.getSort` 的档位语义）。
 *
 * Legado 在拿到各源结果后按「书名与关键词的贴合程度」给每条打 sort 分，再降序展示：
 *   完全相等 > 前缀 > 包含 > 被包含 > 都不沾；作者相等/包含再加分；标题离关键词越远扣分。
 * 我们此前只按「来源数 + 更新时间」排 —— 于是「只有一个源命中的最佳匹配」会被
 * 「几个源都有、但标题只是擦边」的结果压到后面（用户实测：搜「夜无疆」时最佳匹配置不了顶）。
 *
 * 用**归一化标题**比较（`normalizeTitleForDedup`：去空格/标点/集号），
 * 避免「斗罗大陆 1」和「斗罗大陆」因为空格/符号落到不同档位。
 * 长度惩罚封顶 99：只做同档位内的微调，**不跨越档位**（否则长标题会挤掉前缀命中）。
 */
export function searchRelevance(title: string, author: string, keyword: string): number {
  const kw = normalizeTitleForDedup(keyword);
  const t = normalizeTitleForDedup(title);
  if (!kw || !t) return 0;
  let score = 0;
  if (t === kw) score += 1000;
  else if (t.startsWith(kw)) score += 800;
  else if (t.includes(kw)) score += 600;
  else if (kw.includes(t)) score += 400;
  const a = normalizeTitleForDedup(author);
  if (a) {
    if (a === kw) score += 300;
    else if (a.includes(kw)) score += 200;
  }
  score -= Math.min(Math.abs(t.length - kw.length), 99);
  return score;
}

/** 单源原始条目 = 引擎 `UnifiedItem`（这里只声明用到的字段，其余原样保留在 payload 引用里） */
export type RawSearchItem = Record<string, unknown>;

const strim = (s: unknown): string => (s === null || s === undefined ? '' : String(s).trim());

/**
 * 规范化标题（照抄 OmniFlow `aggregate-search.ts:99-107`，注释同源）：
 * 去空格/括号/标点/「第N集·话·期·章·节 / EPn / En」这类**集号**——它们会把同一作品误拆成多条；
 * 保留「第一季 / 动画版」这类真正区分作品的词缀。统一小写。
 */
export function normalizeTitleForDedup(title: string): string {
  return strim(title)
    .replace(/[\s\u3000_—…·\-—]+/g, '')
    .replace(/[《》【】[\]()（）"'「」『』<>〈〉]/g, '')
    .replace(/[：:，,。.！!？?；;、/\\|]+/g, '')
    .replace(/(第[一二三四五六七八九十百千万0-9]+[集话期章节])|([Ee][Pp][0-9]+)|([Ee][0-9]+)/g, '')
    .toLowerCase();
}

/** dedup key：`(kind, 规范化标题)`。规范化后为空时回落 trim 原文（标题本身是标点的极端情况） */
export function dedupIdOf(kind: string, rawTitle: string): string {
  const norm = normalizeTitleForDedup(rawTitle) || strim(rawTitle);
  return `${strim(kind) || 'book'}\u0001${norm}`;
}

/** 从原始 item 取必要字段（本仓 items 事件的条目形状见引擎 `UnifiedItem`） */
function refOf(sourceId: string, it: RawSearchItem): SourceHitRef {
  return {
    sourceId,
    title: strim(it['title']),
    payload: it['payload'] ?? {},
    cover: it['cover'] ? String(it['cover']) : undefined,
  };
}

/**
 * `#286`（换源对话框「校验作者」）：条目上的作者 —— 引擎在列表阶段写进
 * `payload.author`（legado `engine.ts` 搜索/发现两处都带；maccms 无作者字段 ⇒ 空串）。
 * 与 `utils/list-item.ts` 的 `itemAuthor` 同一出处，但这里只依赖 RawSearchItem 形状，
 * 不把视图工具拖进纯函数层。
 */
export function itemAuthorKey(it: RawSearchItem): string {
  const p = it['payload'];
  const a = p && typeof p === 'object' ? (p as Record<string, unknown>)['author'] : undefined;
  return strim(a);
}

/**
 * `#278` 全量原始条数按 kind 统计：Σ 所有源所有页的原始 items（**不 dedup**）。
 *
 * 为什么要有它：聚合「组数」是 dedup 后的口径 —— 漫画源搜「我的」返回 135 条**分话/重复**
 * 条目时，`第N话` 等集号被 `normalizeTitleForDedup` 剥掉 ⇒ 135 条塌缩成极少新组
 * （用户实测 #278：「腾讯漫画单源命中 135 条，聚合漫画还是 26 组」——归并链路本身没丢数据，
 * 是两个口径没同时展示）。组数 + 原始条数并排展示，「点击单源动态加载的数据计入全量」才看得见。
 */
export function rawCountByKind(
  perSrc: Record<string, { pages?: RawSearchItem[][] } | RawSearchItem[]>,
): Record<string, number> {
  const m: Record<string, number> = {};
  for (const scope of Object.values(perSrc)) {
    const pages = Array.isArray(scope) ? [scope] : scope?.pages ?? [];
    for (const page of pages) {
      for (const it of page) {
        // 与 aggregatePerSrc 同一 kind 缺省规则，保证分组头两组数字口径对得上
        const kind = strim(it['kind']) || 'book';
        m[kind] = (m[kind] ?? 0) + 1;
      }
    }
  }
  return m;
}

/**
 * `#618` **搜索分档**（对齐 Legado `SearchModel.kt:139-171` 的 `mergeItems` 四档）：
 * ```
 * equalData    name == key || author == key      ← 完全命中
 * tagsData     kind?.contains(key)              ← 标签/分类命中
 * containsData name.contains(key) || author.contains(key)
 * otherData    其余（**只在非精确搜索时保留**；`precision=true` 丢档）
 * ```
 * 上游是「先分四档，档内按 `origins.size` 降序，再按档拼接」——
 * 也就是说**相关性优先于来源数**。这与 `#511` 的诉求（最佳匹配要置顶）同向，
 * 所以这里把它做成**主排序键**，`#511` 的 relevance 评分退为档内次级。
 *
 * `keyword` 为空（如打开对话框时的「全部」）⇒ 一律 0 档，退化成「来源数优先」的旧口径。
 */
export function searchTier(title: string, author: string, tags: string[], keyword: string): number {
  const k = strim(keyword);
  if (!k) return 0;
  const t = strim(title);
  const a = strim(author);
  if (t === k || a === k) return 0;
  if (tags.some((tag) => tag.includes(k))) return 1;
  if (t.includes(k) || a.includes(k)) return 2;
  return 3;
}

/**
 * 聚合视图：per-src 各页 flat → dedupId 合并 → 排序（sources 数 ↓，updatedAt ↓）→ 截断。
 * 入参兼容两种 scope 形状：`{ pages: RawItem[][] }`（搜索 store）或裸 `RawItem[]`（换源对话框单页）。
 *
 * `#286` `opts.authorAware`：dedup key 追加作者段 —— 「同名书但作者不是一个人」不再被并进
 * 同一张卡（换源场景的关键判据）。作者取 `payload.author`；缺作者的条目各自成卡（不与有作者的合并）。
 *
 * `#618` 两处对齐上游 `SearchModel.mergeItems`：
 *  · **聚合搜索视图默认开 `authorAware`**（上游去重键恒为 `name + author`，不分场景）——
 *    此前只有换源对话框开，聚合视图会把「同名不同作者」并成一张卡；
 *  · 排序改为 **档位优先**（{@link searchTier}）→ 档内来源数 ↓ → relevance ↓ → updatedAt ↓；
 *    `opts.precision` 对应上游「精确搜索」偏好：丢掉第 3 档（完全不沾关键词的条目）。
 *
 * `B6` `opts.sourceQuality`：质量分**只做次要排序键**（档位/匹配度/来源数之后，updatedAt 之前），
 * 不压过原有相关性；同一张卡内多个源引用按质量分降序（决定详情默认落在哪个源）。
 */
export function aggregatePerSrc(
  perSrc: Record<string, { pages?: RawSearchItem[][] } | RawSearchItem[]>,
  maxHits = 200,
  opts: {
    authorAware?: boolean;
    keyword?: string;
    precision?: boolean;
    /** `B6` 源的排序用质量分（缺省按 0 —— 调用方不传时排序与旧版一致） */
    sourceQuality?: (sourceId: string) => number;
  } = {},
): MergedHit[] {
  const merges = new Map<string, MergedHit>();
  for (const [sourceId, scope] of Object.entries(perSrc)) {
    const pages = Array.isArray(scope) ? [scope] : scope?.pages ?? [];
    for (const page of pages) {
      for (const it of page) {
        const title = strim(it['title']);
        if (!title) continue;
        const kind = strim(it['kind']) || 'book';
        const author = itemAuthorKey(it);
        if (opts.precision && searchTier(title, author, tagsOf(it), opts.keyword ?? '') === 3) continue;
        const authorSeg = opts.authorAware ? `\u0002${author.toLowerCase()}` : '';
        const id = dedupIdOf(kind, title) + authorSeg;
        const ref = refOf(sourceId, it);
        const hit = merges.get(id);
        if (!hit) {
          merges.set(id, {
            dedupId: id,
            title,
            kind,
            author: author || undefined,
            cover: ref.cover,
            summary: it['summary'] ? String(it['summary']) : undefined,
            tags: tagsOf(it),
            sources: [ref],
            updatedAt: Date.now(),
          });
        } else {
          if (!hit.cover && ref.cover) hit.cover = ref.cover;
          if (!hit.summary && it['summary']) hit.summary = String(it['summary']);
          // 去重键 = sourceId + 原始标题（同源同标题的两条 = 引擎翻页重叠，不重复列）
          if (!hit.sources.some((s) => s.sourceId === sourceId && s.title === ref.title)) hit.sources.push(ref);
          hit.updatedAt = Date.now();
        }
      }
    }
  }
  /**
   * 排序键（`#511` + `#618` 合成）：**档位** → 匹配度 → 来源数 → 更新时间。
   *
   * `#511`（匹配度必须靠前）：用户搜「夜无疆」时，只有 1 个源有这本书（最佳匹配），
   * 但「来源数优先」会让 3 个源都擦边命中的无关条目压到它上面 —— 那正是用户报的
   * 「最佳匹配应排首位」。
   * `#618`：上游 `mergeItems` 的四档是更粗的相关性分级，档位必须排在来源数之前
   * （否则「3 个源擦边」仍会压过「1 个源完全同名」）。档内再按 `#511` 的细分评分，
   * 以及结果顺序 → 上游按 `origins.size` 降序 —— 三者不冲突，只是粒度从粗到细。
   */
  const kw = opts.keyword ?? '';
  const q = opts.sourceQuality ?? (() => 0);
  // 同卡内多源引用按质量分降序（稳定兜底 title/sourceId），让「换源/详情」默认落到体检更好的源
  for (const h of merges.values()) {
    h.sources.sort(
      (a, b) => q(b.sourceId) - q(a.sourceId) || a.title.localeCompare(b.title, 'zh') || a.sourceId.localeCompare(b.sourceId),
    );
  }
  const tierOf = (h: MergedHit): number => searchTier(h.title, h.author ?? '', h.tags, kw);
  // 卡级质量 = 该卡最高质量源（只在「档位/匹配度/来源数」完全打平时才起作用）
  const cardQuality = (h: MergedHit): number => {
    let best = 0;
    for (const s of h.sources) best = Math.max(best, q(s.sourceId));
    return best;
  };
  const hits = [...merges.values()].sort(
    (a, b) =>
      tierOf(a) - tierOf(b) ||
      (kw ? searchRelevance(b.title, b.author ?? '', kw) - searchRelevance(a.title, a.author ?? '', kw) : 0) ||
      b.sources.length - a.sources.length ||
      // `B6` 质量分仅作同档次要键（不压过相关性；见函数注释）
      cardQuality(b) - cardQuality(a) ||
      b.updatedAt - a.updatedAt,
  );
  return hits.length > maxHits ? hits.slice(0, maxHits) : hits;
}

/** 条目的 tags（去重保序）：聚合卡的 tags 是各源并集，分档判定用得到 */
function tagsOf(it: RawSearchItem): string[] {
  return Array.isArray(it['tags']) ? [...new Set((it['tags'] as unknown[]).map((t) => String(t)))] : [];
}
