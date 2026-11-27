import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  hasSourceGroup, matchSourceGroup, sourceGroupOptions,
  type SourceGroupOption,
} from '../source-groups';
import {
  getEngines, getSourcesPayload, setSourceState, deleteSource, validateAll,
  createSource, verifySource, verifyBatch, restoreRemoved, clearRemoved, purgeRemoved, setSourceOrder,
  type SourceInfo, type EngineInfo, type SrcState, type ValidateSummary, type TrashItem,
} from '../api';
// `#280` 筛选框字段口径（名称/URL/注释/分组）唯一实现
import { matchSourceQuery } from '../utils/source-query';
// `B6` 质量分排序（未体检 = 中性分；`dead` 未过期 = 0）
import { effectiveSourceQuality } from '@yuedu/core/contract';

/** 源/引擎全局状态：源管理、规则工坊、首页共用一份，跨路由不丢。 */
export const useSourcesStore = defineStore('sources', () => {
  const sources = ref<SourceInfo[]>([]);
  const engines = ref<EngineInfo[]>([]);
  const loaded = ref(false);
  /** 被界面删掉、磁盘上仍有文件的源 id（「恢复已删除」按钮据此显示） */
  const removedIds = ref<string[]>([]);
  /** `#645` 回收站：两种源都在这里（有名字/时间），恢复入口**永远显示**（空了也能点进去看说明） */
  const trashItems = ref<TrashItem[]>([]);

  // 列表筛选（对齐 Legado 书源管理）
  const srcQuery = ref('');
  const srcGroup = ref('');
  const srcKind = ref('all');
  const srcSort = ref('default');
  const srcOnlyEnabled = ref(false);
  const srcOnlyError = ref(false);

  /**
   * **规则工坊**左栏的筛选 —— 与上面那组（源管理页）**刻意分开**。
   *
   * 为什么不共用：两个页面目的不同（源管理＝管全部源；工坊＝挑一个源来编辑），
   * 共用会让「在源管理里筛过的词」跟着跑到工坊，用户会认为「工坊记错了」。
   * 但**必须放在 store 里**：工坊是路由页面，切走（如点书院）再回来组件会重建，
   * 放在组件 `ref` 里就被清空了（2026-09-28 用户实测）。
   */
  const wsQuery = ref('');
  const wsGroup = ref('');

  /* ---------------- `#237` 源类型 / 引擎筛选 ---------------- */
  /** 引擎显示名（用户口径：legado / CMS） */
  const ENGINE_LABELS: Record<string, string> = { legado: 'Legado 书源', maccms: 'CMS 影视' };

  /** 源类型选项 —— 文案照抄用户口径（文本 / 音频 / 图片 / 文件 / 视频） */
  const SOURCE_TYPES = [
    { value: 'text', label: '文本' },
    { value: 'audio', label: '音频' },
    { value: 'image', label: '图片' },
    { value: 'file', label: '文件' },
    { value: 'video', label: '视频' },
  ] as const;
  type SourceType = (typeof SOURCE_TYPES)[number]['value'];

  /**
   * 发现页（书院 / 影院）左栏的源类型筛选。
   * ★ 与 `srcKind`（那是**引擎**分类，给源管理页用）**刻意分开**：
   *   混用会让「在源管理筛了 maccms」连带影响发现页 —— 两个页面的目的不同。
   */
  const discSourceType = ref<'' | SourceType>('');

  /** 规则工坊左栏的引擎筛选 */
  const wsEngine = ref('');

  /* ---------------- `#268` 新建源（占位草稿） ----------------
   * 三处入口（导航栏「+」/ 工坊左栏展示区上方 / 源管理「导入源」后）都只做一件事：
   * `startDraft(kind)` 或带 `?new=kind` 跳工坊 ⇒ 工坊 `onMounted` 起草。
   * 占位**不落服务端**：编辑器里改的是前端草稿，「保存」那一刻才 POST /api/sources 真正入库；
   * 不满足保存条件（如缺 bookSourceUrl / apiUrl）由服务端报错 ⇒ 编辑器弹错误提示。
   */
  type NewSourceKind = 'legado' | 'maccms' | 'rss';  const DRAFT_PREFIX = 'draft:';
  const draft = ref<{ kind: NewSourceKind; raw: Record<string, unknown> } | null>(null);
  function startDraft(kind: NewSourceKind): void {
    draft.value = kind === 'maccms'
      ? { kind, raw: { name: '·maccms 新建源', apiUrl: '', api: '' } }
      : kind === 'rss'
        /**
         * `#365` 新建 RSS 订阅源占位模板（`#460` 补齐**类型与字段序**）。
         *
         * ★ 带 `ruleArticles: ''`（空串）—— `detectRssSource` 判据 = sourceUrl 非空 +
         *   特征字段之一（ruleArticles/sortUrl/articleStyle/singleUrl/...），空串也算
         *   特征命中；`saveAsNew` 走 `createSource(raw)` **不带 preferred**，没这条
         *   特征会被自动识别判「不是 RSS」拒收。
         *
         * ★★ `#460` 用户实测（2026-10-15）：「新建 RSS 源，生成的 JSON 和导入的
         *   『源仓库(官方纯净)』不一样 —— 我设了源类型 0 但（默认）JSON 里没这项，
         *   而且 true/false 变成了字符串」。
         *   真因：模板**只有 3 个字符串键** ⇒ 表单里填 `true`/`0` 时 `field()` 的 setter
         *   看到「字段原本不存在」就按字符串写回（见 `WorkshopEditor.vue` 的 `#330` 注释）。
         *   类型污染的后果是**功能级**的（不是观感）：`rss-source.ts` 编译读
         *   `raw.singleUrl === true`（字符串 `"true"` ⇒ false，能力位失效）、
         *   `typeof raw.articleStyle === 'number'`（`"2"` ⇒ 静默回落 0）、`type` 同理。
         *   ⇒ 模板按 **上游 `RssSource` 主构造器顺序**给足「有默认值的字段」且**类型正确**，
         *     新建源从第一步起就与正式源同形（`legado` 的 `RssSource.kt` = 唯一口径）。
         */
        ? {
            kind,
            raw: {
              sourceUrl: '',
              sourceName: '·rss 新建源',
              enabled: true,
              enabledCookieJar: true,
              singleUrl: false,
              articleStyle: 0,
              ruleArticles: '',
              enableJs: true,
              loadWithBaseUrl: true,
              showWebLog: false,
              lastUpdateTime: 0,
              customOrder: 0,
              type: 0,
              preload: false,
              cacheFirst: false,
            },
          }
      : {
          kind,
          /**
           * `#268` 新建 legado 书源占位模板（`#461` 补齐**类型与字段序**，与 RSS 同一条口径）。
           *
           * ★ 必须带一个规则对象：`detectBookSource`（含本仓 `#312` 收紧后的判据）要求
           *   `bookSourceUrl` 之外还有 searchUrl / ruleSearch / ruleBookInfo / ruleToc 之一，
           *   否则整条判「不是 Legado 书源」⇒ 保存被 RULE_PARSE 拦下（`#268` 探针 N4 实测）。
           *   空 `ruleSearch` 只是 warn「缺少搜索入口」，不挡保存。
           *
           * ★★ `#461` 与 RSS 草稿同一个缺陷、同一处方：原先模板只有**三个字符串键**
           *   ⇒ 表单里填 `true`/`0` 被 setter 写成字符串（`"true"` / `"0"`）、
           *   `bookSourceType`/`customOrder`/`weight` 等**连键都没有**。
           *   类型污染的后果同样是功能级的：`enabled` / `enabledExplore` 在
           *   `importSource` 里被读成 state（`typeof rawEnabled === 'boolean'`，字符串直接不生效）。
           *
           * ⇒ 字段集与**顺序**照上游 `BookSource.kt` 主构造器（只取「非 null 默认值」的字段；
           *   `F:\yuedu_PC\legado\...\data\entities\BookSource.kt:34-103`）：
           *   bookSourceUrl → bookSourceName → bookSourceType → customOrder → enabled →
           *   enabledExplore → enabledCookieJar → lastUpdateTime → weight → eventListener →
           *   customButton → ruleSearch。
           *   ⚠️ **刻意不收 `respondTime: 180000`**：上游那个默认值是**运行期度量**（响应耗时），
           *   不是源作者字段 —— 新建源带它只会误导（要收就是「发明」）。
           */
          raw: {
            bookSourceUrl: '',
            bookSourceName: '·legado 新建源',
            bookSourceType: 0,
            customOrder: 0,
            enabled: true,
            enabledExplore: true,
            enabledCookieJar: true,
            lastUpdateTime: 0,
            weight: 0,
            eventListener: false,
            customButton: false,
            ruleSearch: {},
          },
        };
  }
  function clearDraft(): void {
    draft.value = null;
  }
  const isDraftId = (id: string): boolean => id.startsWith(DRAFT_PREFIX);
  /** 占位源的列表/编辑器视图（`SourceInfo` 形状；`raw` 由编辑器经 `initialRaw` 取） */
  const draftInfo = computed<SourceInfo | null>(() => {
    if (!draft.value) return null;
    // `#365` rss 用上游 RssSource 的 sourceName（与 legado 的 bookSourceName / maccms 的 name 各不同）
    const nameKey = draft.value.kind === 'maccms' ? 'name' : draft.value.kind === 'rss' ? 'sourceName' : 'bookSourceName';
    return {
      id: DRAFT_PREFIX + draft.value.kind,
      kind: draft.value.kind,
      name: String(draft.value.raw[nameKey] ?? ''),
      // `#428`：草稿源的开关初值 —— `allowInsecureTls` 是安全开关，初值恒 false
      state: { enabled: true, searchEnabled: true, exploreEnabled: true, allowInsecureTls: false },
      addedAt: 0,
    };
  });
  /**
   * 规则工坊的源类型筛选。
   * ★ 用户口径：「引擎下分类型的，如 legado 源」—— maccms 源恒为 `video`
   *   （服务端 `sourceTypeOf` 的硬事实），给个恒定筛选项没意义 ⇒ 界面上**只在 legado 下出现**。
   */
  const wsSourceType = ref<'' | SourceType>('');

  /**
   * `#279` 源管理页的源类型筛选（引擎下拉之后那一级；口径同工坊 `wsSourceType`）：
   * maccms 源恒为 `video`（服务端 `sourceTypeOf` 硬事实），筛了没意义 ⇒ 只在 legado 下生效。
   */
  const srcSourceType = ref<'' | SourceType>('');

  /** 引擎选项（从已加载的源里取实际出现过的；`demo` 排除 —— 它是内置演示源，不算真源） */
  const engineOptions = computed(() => {
    const seen = new Map<string, number>();
    for (const x of sources.value) {
      if (x.kind === 'demo') continue;
      seen.set(x.kind, (seen.get(x.kind) ?? 0) + 1);
    }
    return [...seen.entries()]
      .map(([value, n]) => ({ value, label: ENGINE_LABELS[value] ?? value, count: n }))
      .sort((a, b) => a.value.localeCompare(b.value));
  });

  /**
   * 某个池子里的各源类型计数（供下拉右侧显示数量）。
   * ★ 计数与过滤**必须同池** —— 否则又是本仓反复出现的「下拉里有这个分组、选中却 0 条」。
   */
  function sourceTypeCounts(pool: ReadonlyArray<{ sourceType?: string }>): Array<{ value: SourceType; label: string; count: number }> {
    return SOURCE_TYPES.map((t) => ({ ...t, count: pool.filter((s) => (s.sourceType ?? 'text') === t.value).length }));
  }

  /** 源类型的**唯一判定**（缺省 = text，与服务端 `sourceTypeOf` 的 default 分支一致） */
  function typeOf(s: { sourceType?: string }): SourceType {
    const t = String(s.sourceType ?? 'text');
    return (SOURCE_TYPES.some((x) => x.value === t) ? t : 'text') as SourceType;
  }

  /** 切引擎后已选源类型不再适用 ⇒ 清掉（否则下拉里挂着却 0 条） */
  watch(wsEngine, () => {
    wsSourceType.value = '';
  });

  /**
   * `#239` **发现页当前 kind** —— 视图每切一个发现页写进来。
   *
   * 存在的唯一理由：影院（maccms）**不显示**源类型筛选（那一栏对它是恒等筛选，
   * 见服务端 `sourceTypeOf` 的 maccms 分支），但**已选的值必须清掉** ——
   * 否则「书院里选了图片 → 切到影院」会带着一个看不见却仍在生效的条件，
   * 把影院列表筛成 0 条，而界面上没有任何控件能告诉用户为什么空了。
   * （这正是本仓反复强调的「下拉里挂着却 0 条」的隐形版本：**控件都不见了**。）
   */
  const discKind = ref('');
  watch(discKind, (k) => {
    if (k === 'maccms' || k === 'rss') discSourceType.value = '';
  });

  /**
   * 分组清单的**池子**：源管理页的口径 = 「当前引擎（+ 已选源类型）下的源」。
   *
   * ⚠️ **这里必须按 `srcKind` 先过滤**（2026-09-28 用户实测报的缺陷）：
   * 分组清单最初遍历的是**全部源** ⇒ 点了「maccms 51」之后，右侧下拉里
   * 仍列着 legado 的几十个分组，点进去一条都看不到
   * （正是本仓反复强调的「下拉里有这个分组、选中却 0 条」）。
   * 口径与发现页左栏一致：**按分类过滤，但不受搜索词 / 仅启用 / 仅报错影响** ——
   * 这样每一项的计数就是「切过去能看到多少条」。
   *
   * `#280` **再按源类型下钻**：选了类型（仅 legado 生效）⇒ 分组计数 = 「该类型下该分组的命中」，
   * 没有该类型源的分组自然不进 options（池子里没有就列不出来）—— 用户原话：
   * 「若类型筛选有选择，则计数应为该类型下，该分组的命中；无此类型源的分组不显示」。
   */
  const srcGroupPool = computed(() => {
    let pool = srcKind.value === 'all' ? sources.value : sources.value.filter((s) => s.kind === srcKind.value);
    if (srcKind.value === 'legado' && srcSourceType.value) pool = pool.filter((s) => typeOf(s) === srcSourceType.value);
    return pool;
  });
  /**
   * 源管理页的分组下拉项 —— **与书院/影院/规则工坊同源**（`source-groups.ts`）。
   *
   * 2026-09-29 用户实测 ①：源管理页此前用的是「纯字符串清单」，于是
   * ① 少「未分组」（没有分组的源无法被单独筛出来）② 每一项没有计数
   * ⇒ 与其它三个页面**看起来不是一个东西**。改为同一份 `sourceGroupOptions(pool, { includeUngrouped })`。
   *
   * ⚠️ 池子用 `srcGroupPool`（= 已按 `srcKind` 过滤）而不是全量 `sources`：
   * 否则「全部分组」的计数会把别的分类的源也算进去（见 `srcGroupPool` 的注释）。
   */
  const srcGroupOptions = computed<SourceGroupOption[]>(() =>
    sourceGroupOptions(srcGroupPool.value, { includeUngrouped: true }),
  );
  // ★ `#237`：规则工坊的分组下拉已**移到 `WorkshopView` 本地**（池子要跟随引擎筛选，
  //   放在 store 里就得把「引擎」也传进来 ⇒ 两处池子口径容易漂移）。
  //   保留两份的代价是「一处改了另一处没改」，已删除 store 这份，只留视图内那份。

  /**
   * 分类一变，已选分组可能整个消失 ⇒ **清掉它**。
   * 不清的话列表会空着，而界面上看不出「为什么一条都没有」（分组名还挂在下拉里）。
   *
   * ★ 判据用 `hasSourceGroup`（`source-groups.ts`）而不是内联 `some(...)`：语义只留一份。
   *   注意它对「未分组」哨兵**没有特殊照顾** —— 哨兵只在池子里确实有未分组源时才入列
   *   （见 `sourceGroupOptions`），所以池子换了之后它若消失，同样应当被清回「全部分组」；
   *   这与上一条规则是同一个道理（否则又是「选中却 0 条」）。
   */
  watch(srcKind, () => {
    // `#279`：引擎一变，已选源类型多半失效 ⇒ 清掉（否则下拉里挂着却 0 条）
    srcSourceType.value = '';
    if (!hasSourceGroup(srcGroupOptions.value, srcGroup.value)) srcGroup.value = '';
  });
  // `#280`：类型一变，分组池随之下钻 ⇒ 已选分组可能整个消失 ⇒ 清回「全部分组」
  watch(srcSourceType, () => {
    if (!hasSourceGroup(srcGroupOptions.value, srcGroup.value)) srcGroup.value = '';
  });

  const kindCounts = computed(() => {
    const m = new Map<string, number>();
    for (const s of sources.value) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
    return [...m.entries()].map(([k, n]) => ({ key: k, n })).sort((a, b) => b.n - a.n);
  });

  const shownSources = computed(() => {
    let list = sources.value.slice();
    // `#280` 筛选框字段口径 = 名称/URL/注释/分组（唯一实现见 utils/source-query.ts）
    list = list.filter((s) => matchSourceQuery(s, srcQuery.value));
    if (srcKind.value !== 'all') list = list.filter((s) => s.kind === srcKind.value);
    // `#279` 源类型（同工坊口径：maccms 恒 video ⇒ 只在 legado 引擎下生效）
    if (srcKind.value === 'legado' && srcSourceType.value) list = list.filter((s) => typeOf(s) === srcSourceType.value);
    // 分组匹配走唯一实现（多组分隔符 / 「未分组」哨兵的语义只写一遍，见 source-groups.ts）
    if (srcGroup.value) list = list.filter((s) => matchSourceGroup(s, srcGroup.value));
    if (srcOnlyEnabled.value) list = list.filter((s) => s.state.enabled);
    if (srcOnlyError.value) list = list.filter((s) => (s.comment ?? '').includes('//error'));
    const by = srcSort.value;
    if (by === 'name') list.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, 'zh'));
    else if (by === 'group') list.sort((a, b) => String(a.group ?? '').localeCompare(String(b.group ?? ''), 'zh') || (a.name ?? a.id).localeCompare(b.name ?? b.id, 'zh'));
    else if (by === 'customOrder') list.sort((a, b) => (a.customOrder ?? 0) - (b.customOrder ?? 0));
    else if (by === 'respondTime') list.sort((a, b) => (a.respondTime ?? Infinity) - (b.respondTime ?? Infinity));
    else if (by === 'addedAt') list.sort((a, b) => b.addedAt - a.addedAt);
    // `B6` 质量分（高→低；同分按名称稳定排序）
    else if (by === 'quality') {
      list.sort(
        (a, b) =>
          effectiveSourceQuality(b.health) - effectiveSourceQuality(a.health) ||
          (a.name ?? a.id).localeCompare(b.name ?? b.id, 'zh'),
      );
    }
    return list;
  });

  /**
   * 可搜索源计数（顶栏「可搜索 N」）。
   * `#293` 加上 `hasSearch` 判据：源**没有搜索规则**时，`searchEnabled` 是默认值 true 并不代表
   * 它真能搜 —— 只按开关统计会让这个数字虚高（用户点进去发现一堆源搜不出东西）。
   */
  const eligible = computed(() => sources.value.filter((s) => s.state.enabled && s.state.searchEnabled && s.hasSearch !== false).length);
  const allActions = computed(() => {
    const set = new Set<string>();
    for (const e of engines.value) for (const c of e.capabilities) set.add(c);
    return [...set];
  });

  async function loadMeta(force = false) {
    if (loaded.value && !force) return;
    engines.value = await getEngines();
    const payload = await getSourcesPayload();
    sources.value = payload.sources;
    removedIds.value = payload.removed;
    trashItems.value = payload.trash;
    loaded.value = true;
  }

  /** 恢复已删除：`ids` 给定 ⇒ 只恢复所选（`#269`）；不给 ⇒ 全部恢复 */
  async function doRestoreRemoved(ids?: string[]): Promise<number> {
    const r = await restoreRemoved(ids);
    await loadMeta(true);
    return r.cleared;
  }

  /** `#269` 恢复全部 */
  async function doClearRemoved(): Promise<number> {
    const r = await clearRemoved();
    await loadMeta(true);
    return r.cleared;
  }

  /** `#645` 永久删除所选回收站条目（用户源 raw 丢弃；文件源文件不删、不再加载） */
  async function doPurgeRemoved(ids: string[]): Promise<number> {
    const r = await purgeRemoved(ids);
    await loadMeta(true);
    return r.purged;
  }

  async function toggle(id: string, field: keyof SrcState, val: boolean) {
    const s = sources.value.find((x) => x.id === id);
    if (!s) return;
    const r = await setSourceState(id, { [field]: val });
    s.state = r.state;
  }

  async function batch(field: keyof SrcState, val: boolean) {
    await Promise.all(sources.value.map((s) => setSourceState(s.id, { [field]: val })));
    for (const s of sources.value) s.state = { ...s.state, [field]: val };
  }

  async function doValidate(): Promise<ValidateSummary> {
    return await validateAll();
  }

  async function doCreate(parsed: unknown, preferred: string): Promise<{ id: string; kind: string; name?: string }> {
    const r = await createSource(parsed, preferred);
    await loadMeta(true);
    return r;
  }

  async function verifyOne(id: string) {
    /**
     * `#694` **不要传 `keyword`**：自动校验走上游 `BookSource.getCheckKeyword(default)`
     * （`BookSource.kt:216-224`：源配了合法 `checkKeyWord` 就用它，否则用 default '我的'）。
     * 传 `keyword: '我的'` 会被当成「用户显式输入」而**压掉 checkKeyWord**，
     * 让原本靠校验关键词才能搜到内容的源突然判失败。
     */
    const r = await verifySource(id, { markOnError: true });
    await loadMeta(true); // 失败标记写回了源分组/注释 → 刷新列表
    return r;
  }

  async function doBatchVerify(limit: number) {
    const r = await verifyBatch({ limit, concurrency: 4, markOnError: true }); // `#694` 同上：关键词交给源的 checkKeyWord
    await loadMeta(true);
    return r;
  }

  async function remove(id: string) {
    await deleteSource(id);
    await loadMeta(true);
  }

  /**
   * 源**置顶 / 置底**（`#166`）+ **多源置顶**（`#238`）。
   *
   * ## 判定置顶态：读服务端的 `pinned`，不再自己猜
   * `#236`~`#237` 的做法是「`customOrder` **严格小于其余所有源** ⇒ 它就是置顶的那个」。
   * 那个判据**只可能有一个源成立** ⇒ 用户 2026-10-03 实测报「点多个源置顶，
   * 刷新后只有最后置顶的那个在顶端，其他的还是普通向上箭头」，就是这条判据在起作用
   * （更早的那几个其实也在最前面，只是图标没认出来）。
   * 现在 `pinned` 由服务端的**有序名单**给出（见服务端 `#238` 的注释），前端只负责显示。
   */
  function isPinned(id: string): boolean {
    return sources.value.find((x) => x.id === id)?.pinned === true;
  }

  /**
   * `#238` 这个源在置顶名单里排第几（1 = 最顶）；不在名单里返回 0。
   *
   * 数据从哪来：`pinned` 是布尔，**顺序**要靠 `customOrder` 反推
   * （服务端按 `base - n + i` 分配 ⇒ 越小越靠前），
   * 这样不必让前端再存一份名单，两边也不会漂移。
   * 置顶源只有 1~3 个（用户手动点的），排序成本可忽略。
   */
  function pinRank(id: string): number {
    const pinned = sources.value.filter((s) => s.pinned).sort((a, b) => (a.customOrder ?? 0) - (b.customOrder ?? 0));
    return pinned.findIndex((s) => s.id === id) + 1;
  }

  /** `#238` 切换置顶：已置顶 ⇒ 取消（排回置顶前的位置，服务端有原值）；未置顶 ⇒ 置顶（排到最顶） */
  async function togglePin(id: string): Promise<void> {
    await setOrder(id, isPinned(id) ? 'reset' : 'top');
  }

  /**
   * `#238` **就地更新**，不再全量重拉。
   *
   * ## 为什么原来慢
   * 原实现每次置顶后 `await loadMeta(true)` —— 那是重新拉**全部 570 个源**的元数据
   * （几百 KB 的 JSON + 重新渲染整张表）。用户实测「点置顶，过了一小会儿才动起来」，
   * 延迟就来自这里。
   *
   * ## 现在怎么做
   * 服务端返回 `customOrder`（受影响源的新值）与 `pinned`（完整名单，索引 0 = 最顶）
   * ⇒ 前端只改**名单里那几个源**的行数据，列表的 `computed` 排序自然重排。
   * 570 个源里动 1~3 个，交互是即时的。
   */
  async function setOrder(id: string, position: 'top' | 'bottom' | 'reset') {
    const r = await setSourceOrder(id, position);
    const pinned = r.pinned ?? null;
    if (pinned) {
      const set = new Set(pinned);
      // 名单里所有源都要按新顺序重排 customOrder：服务端算的是
      // `base - n + i`（base = 非置顶源的最小值），这里照同样的规则在本地推一遍。
      const others = sources.value
        .filter((s) => !set.has(s.id))
        .map((s) => Number(s.customOrder ?? 0))
        .filter((n) => Number.isFinite(n));
      const base = Math.min(0, ...others);
      for (let i = 0; i < pinned.length; i += 1) {
        const row = sources.value.find((s) => s.id === pinned[i]);
        if (row) row.customOrder = base - pinned.length + i;
      }
      // 非置顶源的 pinned 要落回 false（取消置顶的那个就是其中之一）
      for (const s of sources.value) s.pinned = set.has(s.id);
    } else {
      // 服务端没回名单（老 bundle）⇒ 至少把点过的那个源更新掉
      const row = sources.value.find((s) => s.id === id);
      if (row) {
        row.customOrder = r.customOrder;
        if (position === 'reset') row.pinned = false;
      }
    }
    /**
     * ★ 顺带把「源管理」的排序切成**手动排序值**。
     *
     * 为什么必须做：源管理的默认排序是 `'default'`（即服务端给的顺序，**不看 `customOrder`**）
     * ⇒ 只改 `customOrder` 的话列表**纹丝不动**，用户看到的是「点了置顶没反应」。
     * 用户刚表达的就是「我要调顺序」这个意图，切到按 `customOrder` 排是**顺着他**的，
     * 而且下拉框会自己显示成「手动排序值」，能解释为什么顺序变了。
     */
    srcSort.value = 'customOrder';
    /**
     * ★ `#282` 置顶跨页统一（前端半边）：发现页/规则工坊/跨源搜索的源列表消费的都是
     * **数组顺序**（服务端 facade `listSources` 已统一按 customOrder asc 排）—— 上面只改了
     * 行数据的 `customOrder` 字段、没动数组序 ⇒ 其它**已加载过**的页面不刷新永远旧序。
     * 这里把数组同步重排成与服务端同口径（customOrder asc；V8 sort 稳定 ⇒ 同值保原序），
     * 置顶/置底/取消在**所有页即时生效**，不用刷新。
     */
    sources.value = [...sources.value].sort(
      (a, b) => Number(a.customOrder ?? 0) - Number(b.customOrder ?? 0),
    );
  }

  function exportSources(filter: 'all' | 'ok' | 'failed') {
    const url = `/api/sources/export?filter=${filter}&kind=legado`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /**
   * 真源：排除内置演示源 `demo`（服务端每次启动无条件注入 `{id:'demo'}`，只用于本地 UI 验证）。
   * 空库引导用它判断「用户一个源都还没导入」—— 用 `sources.length` 会被演示源顶成 1 而永不触发。
   */
  const realSources = computed(() => sources.value.filter((x) => x.kind !== 'demo'));

  function kindIcon(kind: string): string {
    const map: Record<string, string> = { book: '📚', video: '🎬', article: '📰', audio: '🎧', demo: '🧪' };
    return map[kind] ?? '•';
  }

  return {
    sources, realSources, engines, loaded,
    srcQuery, srcGroup, srcKind, srcSort, srcOnlyEnabled, srcOnlyError,
    srcSourceType, // `#279` 源管理页源类型筛选
    srcGroupOptions, srcGroupPool, kindCounts, shownSources, eligible, allActions,
    // 规则工坊左栏（与源管理页的那组刻意分开，见 wsQuery 注释）
    wsQuery, wsGroup,
    // `#268` 新建源占位草稿
    draft, draftInfo, startDraft, clearDraft, isDraftId,
    // `#237` 源类型 / 引擎筛选
    SOURCE_TYPES, discSourceType, discKind, wsEngine, wsSourceType, engineOptions, sourceTypeCounts, typeOf,
    removedIds,
    trashItems,
    loadMeta, toggle, batch, doValidate, doCreate, verifyOne, doBatchVerify, remove, exportSources, kindIcon,
    doRestoreRemoved,
    doClearRemoved,
    doPurgeRemoved,
    // `#166`：源置顶 / 置底（改上游 `customOrder`）；`#236` 追加 togglePin / isPinned；`#238` 改读服务端名单
    setOrder,
    togglePin,
    isPinned,
    pinRank,
  };
});
