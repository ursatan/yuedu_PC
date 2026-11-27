<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSourcesStore } from '../stores/sources';
import { useSearchStore } from '../stores/search';
import { hasSourceGroup, matchSourceGroup, sourceGroupOptions } from '../source-groups';
import SourceGroupFilter from '../components/SourceGroupFilter.vue';
// `#280` 引擎/类型筛选统一组件（弹层样式与 SourceGroupFilter 一致）
import FilterDropdown from '../components/FilterDropdown.vue';
// `#280` 筛选框字段口径（名称/URL/注释/分组）唯一实现
import { matchSourceQuery, SOURCE_QUERY_PLACEHOLDER } from '../utils/source-query';
import WorkshopEditor from '../WorkshopEditor.vue';
// `#429` 站点探查：抓页 → 扫脚本/全局变量/锚点/媒体 → 拆隐藏通道 → 手动解码链。
// 纯分析逻辑全部在 utils/site-recon.ts（可单测）；这里只做接线 + 渲染。
import {
  analyzeScripts, analyzeAnchors, scanGlobals, findDecodeParams, scanMedia,
  splitHiddenChannel, decodeRadixXor, prettyJson, buildReconMarkdown,
  base64ToBytes, utf8ToBytes, isLikelyBase64, resolveUrl,
} from '../utils/site-recon';
// `#443` 图片密文解密规则生成：站点 JS 抽候选 key/iv → 真图试解（魔数判据）→ 产出 coverDecodeJs。
// 纯逻辑全部在 utils/image-decode.ts（可单测）；这里只做接线 + 渲染。
import {
  extractKeyCandidates, detectAesCbcKeyIv, buildCoverDecodeJs, formatCandidates,
  type KeyCandidate,
} from '../utils/image-decode';

// `#550` 失败归因表（与源医生同一份判据；纯字符串匹配，无 LLM、无网络）
import { diagnoseFailure } from '@yuedu/core/diagnose'; // 纯字符串匹配，**不走 core 全量**（否则 jsdom/node:vm 进浏览器包）
/**
 * `#692` 全链试跑要用到：`runAction`（读 home 拿分类胶囊）与流式校验（跑完整链）。
 * `#695` 改用 `verifySourceStream`：逐段返回，界面边跑边出时间轴。
 */
import { runAction, verifySourceStream, type VerifyLogLine, type VerifyOpts, type VerifyOutcome } from '../api';

const route = useRoute();
const router = useRouter();
const st = useSourcesStore();
const ss = useSearchStore();

/** `#550` 调试诊断卡：把 dbgError / 结果形状（tocError、0 章…）翻成「原因 + 下一步」 */
const debugDiagnosis = computed(() => {
  let result: unknown;
  if (ss.dbgOutput) {
    try {
      result = JSON.parse(ss.dbgOutput);
    } catch {
      result = undefined;
    }
  }
  return diagnoseFailure({ error: ss.dbgError, result });
});

const pickedId = computed(() => (route.query.id as string) || '');
const picked = computed(() => st.sources.find((s) => s.id === pickedId.value) ?? st.draftInfo);

/** `#268`：占位源（编辑中未保存的新源）—— 源列表最前 */
const draftPicked = computed(() => !!st.draft && pickedId.value === st.draftInfo?.id);

/** `#268` 新建源下拉（左栏展示区上方；点选项 ⇒ 起草 + 占位进列表 + 编辑器加载空模板） */
const newOpen = ref(false);
const NEW_ENGINES = [
  { kind: 'legado' as const, label: 'legado 源', icon: '📚' },
  { kind: 'maccms' as const, label: 'CMS 源', icon: '🎬' },
  { kind: 'rss' as const, label: 'RSS 订阅源', icon: '📰' }, // `#365`
];
function startNew(kind: 'legado' | 'maccms' | 'rss'): void {
  newOpen.value = false;
  st.startDraft(kind);
  activeSection.value = 'json';
  void router.replace({ query: { ...route.query, id: 'draft:' + kind } });
}

/**
 * 左栏筛选（筛选框 + 分组）—— **状态放在 store 里**（`st.wsQuery` / `st.wsGroup`）。
 *
 * ⚠️ **不能用组件 `ref`**：工坊是路由页面，切走（如点书院）再回来**组件实例会重建**，
 * `ref` 就被清空了 —— 这正是用户报的「规则工坊筛选框输入的文字，切换界面后被清空」。
 * 之所以不复用源管理页的 `st.srcQuery`：两个页面目的不同（那边管全部源，这边挑一个源来编辑），
 * 共用会让「在源管理里筛过的词」跑到工坊里来。
 */
const listQuery = computed({
  get: () => st.wsQuery,
  set: (v: string) => { st.wsQuery = v; },
});
const srcGroup = computed({
  get: () => st.wsGroup,
  set: (v: string) => { st.wsGroup = v; },
});

// 左栏分区 tab（按引擎加载；点击 → 中栏编辑器切到对应分区）
interface SectionTab { id: string; name: string }
const legadoSections: SectionTab[] = [
  { id: 'json', name: 'JSON' },
  { id: 'basic', name: '基本' },
  { id: 'search', name: '搜索' },
  { id: 'explore', name: '发现' },
  { id: 'detail', name: '详情' },
  { id: 'toc', name: '目录' },
  { id: 'content', name: '正文' },
  { id: 'review', name: '段评' },
];
/**
 * `#654` CMS 分区：**「进阶」已并入「CMS 参数」并删除**（用户实测「进阶和 CMS 参数重复」）。
 * 左栏 id 必须与 `WorkshopEditor.MACCMS_TABS` 的 id 一致，否则点了左栏编辑器不跟着切
 * （`watch([pickedId, sections])` 只负责把失效的 activeSection 拉回 json）。
 */
const maccmsSections: SectionTab[] = [
  { id: 'json', name: 'JSON' },
  { id: 'basic', name: '基本' },
  { id: 'cms', name: 'CMS 参数' },
];
/** `#330` RSS 订阅源分区 —— 与 `WorkshopEditor.RSS_TABS` 同 id（对齐上游 RssSourceEditActivity 四分区） */
const rssSections: SectionTab[] = [
  { id: 'json', name: 'JSON' },
  { id: 'basic', name: '基本' },
  { id: 'start', name: '启动' },
  { id: 'list', name: '列表' },
  { id: 'webview', name: 'WEB_VIEW' },
];
const sections = computed<SectionTab[]>(() => {
  if (!picked.value) return [];
  if (picked.value.kind === 'maccms') return maccmsSections;
  if (picked.value.kind === 'legado') return legadoSections;
  if (picked.value.kind === 'rss') return rssSections;
  return [{ id: 'json', name: 'JSON' }];
});
const activeSection = ref('json');
watch([pickedId, sections], () => {
  if (!sections.value.some((s) => s.id === activeSection.value)) activeSection.value = 'json';
});

/**
 * 引擎池 —— `#237`：选了引擎后，**分组下拉的池子与计数都必须跟着换**
 * （否则就是本仓反复出现的「下拉里列着 maccms 的分组、点进去 0 条」）。
 * ⚠️ 不受搜索词 / 源类型影响：每一项的计数要等于「切过去能看到多少条」。
 */
const enginePool = computed(() => (st.wsEngine ? st.sources.filter((s) => s.kind === st.wsEngine) : st.sources));

/** `#280` 类型下拉选项：全部行 + 计数 > 0 的类型（FilterDropdown 的 options 形状） */
const wsTypeOpts = computed(() => [
  { value: '', label: '全部类型', count: enginePool.value.length },
  ...wsTypeCounts.value.filter((t) => t.count > 0).map((t) => ({ value: t.value, label: t.label, count: t.count })),
]);
/** `#280` 引擎下拉选项：全部引擎行 + st.engineOptions（不含 demo，工坊口径不变） */
const wsEngineOpts = computed(() => [
  { value: '', label: '全部引擎', count: st.sources.length },
  ...st.engineOptions,
]);

/**
 * `#280` **分组计数按类型下钻**：legado 下选了类型 ⇒ 池子先按类型过滤 ⇒
 * 每组计数 = 「该类型下该分组的命中」，无该类型源的分组不进 options。
 * （与源管理/发现页同一口径；maccms 恒 video 不受影响。）
 */
const wsGroupPool = computed(() =>
  st.wsEngine === 'legado' && st.wsSourceType
    ? enginePool.value.filter((s) => st.typeOf(s) === st.wsSourceType)
    : enginePool.value,
);

/** 分组下拉 —— 池子**跟随引擎 + 类型**（`#237` + `#280` 类型下钻） */
const wsGroupOptions = computed(() => sourceGroupOptions(wsGroupPool.value, { includeUngrouped: true }));

/** 源类型计数（`#237`）—— 与 `filtered` 同一个池子 `enginePool` */
const wsTypeCounts = computed(() => st.sourceTypeCounts(enginePool.value));

/**
 * `#237` 换引擎后已选分组可能整个消失 ⇒ **清回「全部分组」**。
 * `#280` 换**类型**同样会让分组池下钻 ⇒ 已选分组可能消失 ⇒ 一并清。
 * 不清的话下拉里挂着一个不存在的分组名、列表空着，而界面看不出原因。
 * 判据用 `hasSourceGroup`（与源管理/发现页同一实现，见 source-groups.ts）。
 */
watch(wsGroupOptions, () => {
  if (srcGroup.value && !hasSourceGroup(wsGroupOptions.value, srcGroup.value)) st.wsGroup = '';
});

const filtered = computed(() => {
  // 顺序：引擎 → 源类型（仅 legado）→ 分组（语义见 source-groups.ts）→ 搜索词
  let list = enginePool.value;
  // ★ 用户口径「引擎下分类型的，如 legado 源」—— maccms 恒 video，筛了没意义
  if (st.wsEngine === 'legado' && st.wsSourceType) list = list.filter((s) => st.typeOf(s) === st.wsSourceType);
  if (srcGroup.value) list = list.filter((s) => matchSourceGroup(s, srcGroup.value));
  // `#280` 筛选框字段口径 = 名称/URL/注释/分组（唯一实现见 utils/source-query.ts）
  list = list.filter((s) => matchSourceQuery(s, listQuery.value));
  return list;
});

// 调试台：源锁定为当前源
const debugSourceId = computed({
  get: () => (pickedId.value || ss.dbgSourceId),
  set: (v: string) => { ss.dbgSourceId = v; },
});

/**
 * `#697` 离开工坊（切路由 / 关页）⇒ 取消在跑的试跑：
 * abort 会让 SSE 断开 ⇒ 服务端 `ac.abort()` ⇒ 引擎在途抓取停止。
 * 不这么做的话「关掉页面，后台还在跑整条链」会白占流量槽（用户实测过）。
 */
onUnmounted(() => {
  abortChain();
});

onMounted(async () => {
  await st.loadMeta();
  // `#268`：导航栏「+」/ 源管理「新建源」带着 `?new=kind` 跳进来 ⇒ 起占位草稿
  // （`#365` 增加 rss：编辑器 RSS 四分区 tab `#330` 早已就绪，缺的只是入口）
  const nk = route.query.new as string | undefined;
  if (nk === 'legado' || nk === 'maccms' || nk === 'rss') {
    if (!st.draft) st.startDraft(nk);
    void router.replace({ query: { ...route.query, new: undefined, id: 'draft:' + nk } });
  } else if (!pickedId.value && st.sources.length) {
    void router.replace({ query: { ...route.query, id: st.sources[0]!.id } });
  }
  if (!ss.dbgKeyword) ss.dbgKeyword = '剑来';
});

function pick(id: string) {
  void router.replace({ query: { ...route.query, id } });
}
function jumpSection(id: string) {
  activeSection.value = id;
}
/* `#692` 「▶ 试跑」按钮已从编辑器移除（各字段自带试跑），这里的 onDebug 随之删除。 */
function onRenamed(newId: string) {
  // `#268`：占位源保存成功 ⇒ 真源已入库（保存时取的名字），清掉草稿
  st.clearDraft();
  void router.replace({ query: { ...route.query, id: newId } });
  void st.loadMeta(true);
}

/* ==================================================================
 * `#429` 站点探查（右侧调试区底部折叠区块）
 * ================================================================== */

/* ==================================================================
 * `#692` 本源试跑：**搜索全链 / 发现全链** 两条链（取代旧的单动作下拉）
 *
 * 旧右栏是「动作下拉 + keyword」，而 home/category 返回的是同一坨 JSON、
 * detail/content 又缺参数直接报错 —— 对「我正在写这条规则对不对」毫无帮助。
 * 现在一次只跑**一条完整链**（搜索：搜索→详情→目录→正文；发现：发现→详情→目录→正文），
 * 逐段回 ✓/✗ + 错误，就是 Legado 调试里那条信息流。
 * 后端能力本来就有（`hub.verifySource` 的 stages），只是此前一次请求把两条链都打了。
 * ================================================================== */
type ChainTab = 'search' | 'discover';
const chainTab = ref<ChainTab>('search');
const runKeyword = ref('');
/** 发现链接 / 分类 value（留空 ⇒ 后端按「第一个有 url 的分类」跑） */
const runExploreValue = ref('');
const chainRunning = ref(false);
const chainResult = ref<VerifyOutcome | null>(null);
const chainError = ref('');
/**
 * `#696` 调试信息流（对齐 Legado 书源调试）：`[00:02.275] ≡获取成功:/wanjie/` 那种逐行回执。
 * 与上面 4 段「时间轴」是两个层次 —— 时间轴回答「哪一段挂了」，信息流回答「为什么」。
 */
const chainLog = ref<VerifyLogLine[]>([]);
/**
 * `#697` **当前这次试跑的取消器**。换源 / 关页 / 再点一次试跑都会 abort：
 * 断开 SSE ⇒ 服务端 `ac.abort()` ⇒ 引擎在途抓取立即停止（不是只停界面）。
 */
let chainAbort: AbortController | null = null;
/** 取消正在跑的试跑（幂等） */
function abortChain(): void {
  if (chainAbort) {
    try {
      chainAbort.abort();
    } catch {
      /* 已 aborted */
    }
    chainAbort = null;
  }
  chainRunning.value = false;
}
/** 信息流容器（跑的时候自动滚到底，别让人追着看） */
const logBox = ref<HTMLElement | null>(null);
/**
 * 长行折叠：简介/正文那两行动辄上千字，全展开会把整条信息流挤成一个屏 ——
 * 默认折成 3 行，点「展开」看全文（阅读器仍看得到完整正文，这里只求「看得见结构」）。
 */
const expandedLog = ref<Set<number>>(new Set());
function toggleLogRow(i: number): void {
  const next = new Set(expandedLog.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  expandedLog.value = next;
}

/** `[mm:ss.mmm]`，相对**首行**（服务端时间戳，不受前端接收抖动影响） */
const logBase = computed(() => chainLog.value[0]?.at ?? 0);
const logLines = computed(() =>
  chainLog.value.map((l) => ({
    ...l,
    ts:
      '[' +
      (() => {
        const ms = Math.max(0, l.at - logBase.value);
        const m = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        const milli = ms % 1000;
        return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
      })() +
      ']',
  })),
);
/** 源的 `ruleSearch.checkKeyWord`（胶囊上要显示它的真实值） */
const checkKeyword = ref('');
/** home 返回的、带 url 的分类（胶囊） */
const exploreCats = ref<Array<{ key: string; value: string; title: string }>>([]);
const exploreLoading = ref(false);
const exploreErr = ref('');

const STAGE_NAME: Record<string, string> = {
  search: '搜索', info: '详情', toc: '目录', content: '正文',
  explore: '发现', exploreInfo: '详情', exploreToc: '目录', exploreContent: '正文',
};
const SEARCH_FLOW = ['search', 'info', 'toc', 'content'] as const;
const DISCOVER_FLOW = ['explore', 'exploreInfo', 'exploreToc', 'exploreContent'] as const;
/**
 * `#698` **订阅源只有两段**（对齐上游 `Debug.kt` 的 RSS 分支）：列表 + 内容页。
 * 上游点卡片直接进正文（`ReadRssActivity`），没有详情页/目录页 ——
 * 所以给订阅源单独一套「段名 + 顺序」，书源那套四段不动。
 */
const RSS_SEARCH_FLOW = ['search', 'content'] as const;
const RSS_DISCOVER_FLOW = ['explore', 'exploreContent'] as const;
const STAGE_NAME_RSS: Record<string, string> = {
  search: '搜索列表',
  explore: '分类列表',
  content: '内容页',
  exploreContent: '内容页',
};
/** 当前源是不是订阅源（决定试跑信息流用几段、叫什么） */
const isRssSource = computed(() => picked.value?.kind === 'rss');

/**
 * 信息流：没跑到的段显示「—」；上游短路后后面的段本来就不会有结果。
 * `#695` 流式下再加一态 `running`：正在跑、这一段还没回来（显示「…」），
 * 不能显示成「未执行」——那会让「跑到第 2 段」看起来像「第 3、4 段被跳过」。
 */
const chainFlow = computed(() => {
  const r = chainResult.value;
  const order = isRssSource.value
    ? chainTab.value === 'search'
      ? RSS_SEARCH_FLOW
      : RSS_DISCOVER_FLOW
    : chainTab.value === 'search'
      ? SEARCH_FLOW
      : DISCOVER_FLOW;
  const nameOf = (k: string): string => (isRssSource.value ? (STAGE_NAME_RSS[k] ?? k) : (STAGE_NAME[k] ?? k));
  if (!r) {
    return order.map((k) => ({ key: k, name: nameOf(k), state: 'pending' as const, ok: false, error: '', detail: '', ms: undefined }));
  }
  return order.map((k) => {
    const st = r.stages[k as keyof typeof r.stages];
    return {
      key: k,
      name: nameOf(k),
      state: st
        ? st.ok
          ? ('pass' as const)
          : ('fail' as const)
        : chainRunning.value
          ? ('running' as const)
          : ('skipped' as const),
      ok: !!st?.ok,
      error: st && !st.ok ? String(st.error ?? '') : '',
      detail: st?.detail ?? '',
      ms: st?.ms,
    };
  });
});

/** 切到「发现全链」时才去读分类（避免每次切源都白打一次 home） */
async function loadExploreCats(): Promise<void> {
  if (!pickedId.value || pickedId.value.startsWith('draft:')) {
    exploreCats.value = [];
    return;
  }
  exploreLoading.value = true;
  exploreErr.value = '';
  try {
    /**
     * 分类名的字段名是 **`name` 不是 `title`**（`UnifiedFilter.options[]` 的契约，
     * 实测荔枝短剧 58 个分类全是 `{name,value,layout}`；写成 title 会全部显示 undefined）。
     */
    const r = (await runAction(pickedId.value, 'home', {})) as {
      filters?: Array<{
        key?: string;
        options?: Array<{ value?: string; name?: string; title?: string; header?: boolean; kind?: string }>;
      }>;
    };
    /**
     * `#697` 胶囊只留 **前 3 个「有 url」的分类**：
     *  · 判据与后端 `pickFirstExploreUrl` 同一口径 —— 跳过标题项（`header`）、跳过空 value、
     *    跳过 `kind` 非 `url` 的控件（`toggle`/`select`/`button` 要把值靠 `$input` 回传，
     *    直接当分类请求必然 0 条）。**`kind` 缺省视为 url**（`FilterOption` 只在非 url 时才写 kind）。
     *  · 上限 3：工坊右栏只有一列宽度，6 个胶囊会换两行把试跑按钮挤下去。
     */
    const CAT_MAX = 3;
    const out: Array<{ key: string; value: string; title: string }> = [];
    for (const f of r.filters ?? []) {
      for (const o of f.options ?? []) {
        if (o.header === true) continue;
        if (o.kind !== undefined && o.kind !== '' && o.kind !== 'url') continue;
        const v = typeof o.value === 'string' ? o.value.trim() : '';
        if (!v) continue;
        out.push({
          key: String(f.key ?? 'explore'),
          value: v,
          title: String(o.name ?? o.title ?? v).slice(0, 18),
        });
        if (out.length >= CAT_MAX) break;
      }
      if (out.length >= CAT_MAX) break;
    }
    exploreCats.value = out;
    if (!out.length) exploreErr.value = '该源 home 没有返回可请求的分类（只认有 url 的分类项）';
  } catch (e) {
    exploreErr.value = String(e instanceof Error ? e.message : e).slice(0, 120);
    exploreCats.value = [];
  } finally {
    exploreLoading.value = false;
  }
}

function onDiscoverTab(): void {
  chainTab.value = 'discover';
  if (!exploreCats.value.length && !exploreLoading.value) void loadExploreCats();
}

/**
 * `#695` 跑一条全链，**逐段返回**（流式）。抽成一个函数是因为搜索/发现两条链
 * 除了 opts 之外完全一样；以前两份 try/catch 已经漂过一次（一条忘了收窄 `checkDiscovery`）。
 *
 * 关键点：先把 `chainResult` 置成「空壳」（`stages: {}`），每收到一段就补进去 ⇒
 * 时间轴边跑边长；跑完再用完整结论覆盖（拿到 `respondTime` / `message`）。
 * 失败时**保留已到的段**（这正是流式的价值：12s 拿到「详情」再卡 8s 失败，也能看出卡在哪）。
 */
async function runChain(opts: VerifyOpts): Promise<void> {
  const id = pickedId.value;
  if (!id || id.startsWith('draft:')) {
    chainError.value = '先保存这个源（占位源还没入库）';
    return;
  }
  // 上一次还在跑 ⇒ 先取消（同一时刻只允许一条链，否则两份帧交错进同一个信息流）
  abortChain();
  const ac = new AbortController();
  chainAbort = ac;
  chainRunning.value = true;
  chainError.value = '';
  chainResult.value = null;
  const shell: VerifyOutcome = { ok: true, message: '', respondTime: 0, stages: {} };
  chainLog.value = [];
  expandedLog.value = new Set();
  try {
    shell.ok = true;
    chainResult.value = shell;
    const outcome = await verifySourceStream(
      id,
      opts,
      (stage, stageResult) => {
        if (ac.signal.aborted) return;
        const cur = chainResult.value;
        if (!cur) return;
        chainResult.value = { ...cur, stages: { ...cur.stages, [stage]: stageResult } };
      },
      // `#696` 信息流逐行追加 + 跟着滚到底
      (line) => {
        if (ac.signal.aborted) return;
        chainLog.value = [...chainLog.value, line];
        void nextTick(() => {
          const el = logBox.value;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },
      ac.signal,
    );
    if (ac.signal.aborted) return; // 已被取消：结论作废，别把半截结果盖上「通过」
    chainResult.value = outcome;
  } catch (e) {
    if (ac.signal.aborted) return; // 用户取消 ⇒ 静默（不是错误）
    const cur = chainResult.value;
    const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
    // 已到半程的段留着，只把错误贴出来（否则「跑到第 3 段才炸」会被抹成一片空白）
    chainResult.value = cur && Object.keys(cur.stages).length ? { ...cur, ok: false, message: msg } : null;
    chainError.value = msg;
  } finally {
    if (chainAbort === ac) chainAbort = null;
    if (!ac.signal.aborted) chainRunning.value = false;
  }
}

/** 搜索全链（keyword 为空 ⇒ 用输入框里的） */
async function runSearchChain(preset?: string): Promise<void> {
  const kw = (preset ?? runKeyword.value).trim();
  if (preset) runKeyword.value = preset;
  await runChain({
    keyword: kw || undefined,
    checkSearch: true,
    checkDiscovery: false,
    checkDiscoveryDeep: false,
  });
}

/** 发现全链（指定分类 ⇒ 只打那一条；留空 ⇒ 后端挑第一个有 url 的分类） */
async function runDiscoverChain(pick?: { key: string; value: string; title?: string }): Promise<void> {
  if (!pickedId.value || pickedId.value.startsWith('draft:')) {
    chainError.value = '先保存这个源（占位源还没入库）';
    return;
  }
  if (pick) runExploreValue.value = pick.value;
  const typed = runExploreValue.value.trim();
  /**
   * `#694` 把分类**显示名**一起送上去——时间轴只显示 `分类「热血」`，
   * 不再是一串被截断的分类 URL（`分类 https://liz04.com/api/v1/topic/lizhi-pic…`）。
   * 手输的 value 若正好命中某个胶囊，也用它的名字。
   */
  const known = exploreCats.value.find((c) => c.value === typed);
  const usePick = pick
    ? { key: pick.key, value: pick.value, ...(pick.title ? { name: pick.title } : {}) }
    : typed
      ? { key: exploreCats.value[0]?.key ?? 'explore', value: typed, ...(known ? { name: known.title } : {}) }
      : undefined;
  await runChain({
    checkSearch: false,
    checkDiscovery: true,
    checkDiscoveryDeep: true, // 发现链要继续走 详情→目录→正文，否则只验到「分类有卡片」
    ...(usePick ? { explorePick: usePick } : {}),
  });
}

/**
 * 换源 ⇒ **取消正在跑的试跑 + 清空上一条链的一切**。
 * `#697` 修的是用户实测的 bug：「切换其他源，调试信息流还保留着上次试跑信息」——
 * 旧代码只清了 `chainResult/chainError`，漏了 `chainLog`，于是新源点开就看到上个源的日志。
 */
watch(pickedId, () => {
  abortChain();
  chainResult.value = null;
  chainError.value = '';
  chainLog.value = [];
  expandedLog.value = new Set();
  exploreCats.value = [];
  checkKeyword.value = '';
  if (!pickedId.value || pickedId.value.startsWith('draft:')) return;
  void (async () => {
    try {
      const j = (await (await fetch(`/api/sources/${encodeURIComponent(pickedId.value)}`)).json()) as {
        raw?: { ruleSearch?: { checkKeyWord?: string } };
      };
      checkKeyword.value = String(j.raw?.ruleSearch?.checkKeyWord ?? '').trim();
    } catch {
      /* 取不到就不显示这个胶囊 */
    }
    if (chainTab.value === 'discover') void loadExploreCats();
  })();
});

const reconOpen = ref(false);

/* ------------------------------------------------------------------
 * `#691` **封面解密诊断**（可视化）：同一张图「直连」与「经代理 cover=1」各取 4 字节，
 * 用魔数判断「站点到底有没有加密」「我们的 coverDecodeJs 有没有生效」。
 *
 * 为什么做成可视化：这两个结论在浏览器里**长得一模一样**（都是乱码横条 / 都是默认封面），
 * 只能看字节。用户上一轮就是因为分不清这两件事，来回改了三遍规则。
 * ------------------------------------------------------------------ */
interface CoverProbe {
  url: string;
  direct?: { ok: boolean; size: number; magic: string; kind: string; ms: number; note?: string };
  viaProxy?: { ok: boolean; size: number; magic: string; kind: string; ms: number; cached: boolean; note?: string };
}
const coverUrl = ref('');
const coverBusy = ref(false);
const coverProbe = ref<CoverProbe | null>(null);

function magicKind(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'JPEG';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'PNG';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'WEBP';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'GIF';
  return '未知（像密文）';
}
function hex4(bytes: Uint8Array): string {
  return [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchCoverBytes(url: string, withCover: boolean): Promise<{ ok: boolean; size: number; magic: string; kind: string; ms: number; cached: boolean; note?: string }> {
  const p = new URLSearchParams({ u: url });
  if (pickedId.value) p.set('sid', pickedId.value);
  if (withCover) p.set('cover', '1');
  const t0 = performance.now();
  const r = await fetch(`/api/proxy?${p.toString()}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return {
    ok: r.ok,
    size: buf.length,
    magic: hex4(buf),
    kind: magicKind(buf),
    ms: Math.round(performance.now() - t0),
    cached: r.headers.get('x-yuedu-cover-cache') === 'hit',
    ...(r.ok ? {} : { note: `HTTP ${r.status}` }),
  };
}

/**
 * 跑一次诊断：先直连（不带 cover=1，等于「站点原样返回什么」），再走代理解密。
 * 直连失败不算错（很多图床有防盗链，浏览器直连本来就会 403）—— 结论看**魔数**。
 */
async function probeCover(): Promise<void> {
  const url = coverUrl.value.trim();
  if (!url || coverBusy.value) return;
  coverBusy.value = true;
  coverProbe.value = { url };
  try {
    try {
      coverProbe.value.direct = await fetchCoverBytes(url, false);
    } catch (e) {
      coverProbe.value.direct = { ok: false, size: 0, magic: '', kind: '取不到', ms: 0, note: String(e).slice(0, 60) };
    }
    try {
      coverProbe.value.viaProxy = await fetchCoverBytes(url, true);
    } catch (e) {
      coverProbe.value.viaProxy = { ok: false, size: 0, magic: '', kind: '取不到', ms: 0, cached: false, note: String(e).slice(0, 60) };
    }
  } finally {
    coverBusy.value = false;
  }
}

/** 一句话结论（用户要的是「所以现在到底行不行」） */
const coverVerdict = computed(() => {
  const p = coverProbe.value;
  if (!p?.viaProxy) return '';
  const isImg = (k: string): boolean => /JPEG|PNG|WEBP|GIF/.test(k);
  if (!p.viaProxy.ok) return `代理取图失败（${p.viaProxy.note ?? 'HTTP 错误'}）——先确认 URL 与源的 Referer/UA`;
  if (isImg(p.viaProxy.kind)) {
    return p.direct && isImg(p.direct.kind)
      ? '站点本来就是明文图，代理只是转发（不需要 coverDecodeJs）'
      : '✅ 解密已生效（直连是密文、代理是图片 ⇒ coverDecodeJs 链路正常）';
  }
  return p.direct && !isImg(p.direct.kind)
    ? '❌ 站点是加密的，但源没有 coverDecodeJs（或规则跑失败）——补解密规则'
    : '⚠️ 代理返回的不是图片：检查该源的 coverDecodeJs / 是否需要 Referer';
});
/** 探查面板的源（复用调试台同一 computed —— 与下方「单源调试」锁定同一个源） */
const debugSource = computed(() => st.sources.find((s) => s.id === debugSourceId.value) ?? null);

const reconUrl = ref('');
const reconPageUrl = ref('');
const reconRaw = ref('');
const reconStatus = ref<number | null>(null);
const reconBytes = ref<number | null>(null);
const reconContentType = ref('');
const reconBusy = ref(false);
const reconError = ref('');
let reconLastAuto = '';

/** 切源时把 URL 默认填成该源的 sourceUrl（用户改过的就不覆盖） */
watch(debugSource, (s) => {
  const u = s?.url ?? '';
  if (!reconUrl.value.trim() || reconUrl.value === reconLastAuto) {
    reconUrl.value = u;
    reconLastAuto = u;
  }
}, { immediate: true });

type ReconTab = 'overview' | 'scripts' | 'globals' | 'anchors' | 'media' | 'hidden' | 'decode' | 'imgdec' | 'api';
const reconTab = ref<ReconTab>('overview');
const RECON_TABS: Array<{ id: ReconTab; name: string }> = [
  { id: 'overview', name: '概览' },
  { id: 'scripts', name: '脚本' },
  { id: 'globals', name: '全局变量' },
  { id: 'anchors', name: '锚点' },
  { id: 'media', name: '媒体' },
  { id: 'hidden', name: '隐藏通道' },
  { id: 'decode', name: '解码链' },
  { id: 'imgdec', name: '图片解密' },
  { id: 'api', name: 'API 探测' },
];

const hasRecon = computed(() => !!reconRaw.value);
// 全部纯函数派生（见 utils/site-recon.ts）
const reconScripts = computed(() => analyzeScripts(reconRaw.value));
const reconGlobals = computed(() => scanGlobals(reconRaw.value));
const reconDecodeParams = computed(() => findDecodeParams(reconRaw.value));
const reconAnchors = computed(() => analyzeAnchors(reconRaw.value));
const reconMedia = computed(() => scanMedia(reconRaw.value, reconPageUrl.value));
const reconHidden = computed(() => splitHiddenChannel(reconUrl.value.trim()));
const reconPretty = computed(() => prettyJson(reconRaw.value));

/** 抓取：走既有服务端转发端点 `/api/proxy`（按源注入 Referer/UA/Cookie），结果当文本处理 */
async function reconFetch(urlOverride?: string): Promise<void> {
  const u = (urlOverride ?? reconUrl.value).trim();
  if (!u) { reconError.value = '请先填 URL'; return; }
  const sid = debugSourceId.value;
  const q = `/api/proxy?u=${encodeURIComponent(u)}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`;
  reconBusy.value = true;
  reconError.value = '';
  reconRaw.value = '';
  try {
    const res = await fetch(q, { headers: { accept: 'text/html,application/xhtml+xml,application/json,*/*' } });
    const text = await res.text();
    reconStatus.value = res.status;
    const cl = Number(res.headers.get('content-length'));
    reconBytes.value = Number.isFinite(cl) && cl > 0 ? cl : new TextEncoder().encode(text).length;
    reconContentType.value = String(res.headers.get('content-type') ?? '');
    reconPageUrl.value = u;
    reconRaw.value = text;
    reconTab.value = 'overview';
  } catch (e) {
    reconError.value = '抓取失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    reconBusy.value = false;
  }
}

/* ---------------- 解码链（手动台，只读分析，不发请求） ---------------- */
/** 默认填真实逆出的 18AV 样例，方便直接对照 */
const dToken = ref('');
const dRadix = ref(21);
const dSep = ref('v');
const dXor = ref(12);
const dKey = ref('');
const dIv = ref('');
const aesBusy = ref(false);
const aesOut = ref('');
const aesErr = ref('');
const aesOk = ref<boolean | null>(null);

const xorResult = computed(() => decodeRadixXor(dToken.value, dRadix.value, dSep.value, dXor.value));
/** 第①步（进制+异或）产物是否像 base64（决定能不能喂给 AES） */
const xorIsB64 = computed(() => isLikelyBase64(xorResult.value.text));

async function runAes(): Promise<void> {
  aesBusy.value = true;
  aesErr.value = '';
  aesOut.value = '';
  aesOk.value = null;
  try {
    const cipher = base64ToBytes(xorResult.value.text);
    const keyBytes = utf8ToBytes(dKey.value);
    if (keyBytes.length !== 16 && keyBytes.length !== 24 && keyBytes.length !== 32) {
      throw new Error(`key 必须是 16/24/32 字节（UTF-8 后当前 ${keyBytes.length} 字节）`);
    }
    const ivBytes = utf8ToBytes(dIv.value);
    if (ivBytes.length !== 16) throw new Error(`iv 必须是 16 字节（UTF-8 后当前 ${ivBytes.length} 字节）`);
    const ck = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, ck, cipher);
    aesOut.value = new TextDecoder().decode(plain);
    aesOk.value = true;
  } catch (e) {
    aesOk.value = false;
    aesErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    aesBusy.value = false;
  }
}

/* ---------------- API 探测（复用 /api/proxy） ---------------- */
const probeUrl = ref('');
const probeMethod = ref<'GET' | 'POST'>('GET');
const probeBody = ref('');
const probeStatus = ref<number | null>(null);
const probeOut = ref('');
const probeErr = ref('');
const probeBusy = ref(false);

async function runProbe(urlOverride?: string): Promise<void> {
  const u = (urlOverride ?? probeUrl.value).trim();
  if (!u) { probeErr.value = '请先填 URL'; return; }
  const sid = debugSourceId.value;
  const q = `/api/proxy?u=${encodeURIComponent(u)}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`;
  probeBusy.value = true;
  probeErr.value = '';
  probeOut.value = '';
  probeStatus.value = null;
  try {
    const init: RequestInit = probeMethod.value === 'POST'
      ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: probeBody.value }
      : {};
    const res = await fetch(q, init);
    probeStatus.value = res.status;
    probeOut.value = await res.text();
  } catch (e) {
    probeErr.value = '请求失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    probeBusy.value = false;
  }
}

/* ---------------- 结论块（可复制 markdown） ---------------- */
const reconMd = computed(() => buildReconMarkdown({
  url: reconPageUrl.value || reconUrl.value.trim(),
  status: reconStatus.value ?? undefined,
  bytes: reconBytes.value ?? undefined,
  contentType: reconContentType.value,
  scripts: hasRecon.value ? reconScripts.value : undefined,
  globals: hasRecon.value ? reconGlobals.value : undefined,
  decodeParams: hasRecon.value ? reconDecodeParams.value : undefined,
  anchors: hasRecon.value ? reconAnchors.value : undefined,
  media: hasRecon.value ? reconMedia.value : undefined,
  hidden: reconHidden.value,
  finalText: (aesOut.value || xorResult.value.text) || undefined,
}));
const reconCopied = ref(false);
async function copyRecon(): Promise<void> {
  try {
    await navigator.clipboard.writeText(reconMd.value);
    reconCopied.value = true;
    setTimeout(() => { reconCopied.value = false; }, 1500);
  } catch (e) {
    reconError.value = '复制失败：' + (e instanceof Error ? e.message : String(e));
  }
}

/* ---------------- `#443` 图片解密规则生成（抽候选 key/iv → 真图试解 → 产出 coverDecodeJs） ---------------- */

const imgJsUrl = ref('');
const imgCipherUrl = ref('');
const imgBusy = ref(false);
const imgErr = ref('');
const imgCands = ref<KeyCandidate[]>([]);
const imgHit = ref<{ key: string; iv: string; magic: string } | null>(null);
const imgRule = ref('');
const imgCopied = ref(false);

/** 已抓页面的外部脚本绝对地址（给 JS 地址输入框做候选） */
const reconScriptUrls = computed(() =>
  reconScripts.value.external.map((u) => resolveUrl(u, reconPageUrl.value)),
);

/** 分析：抓 JS 抽候选 → 抓密文图 → 试解。全部走既有 /api/proxy（按源注入 Referer/UA/Cookie）。 */
async function analyzeImage(): Promise<void> {
  imgBusy.value = true;
  imgErr.value = '';
  imgCands.value = [];
  imgHit.value = null;
  imgRule.value = '';
  try {
    const jsUrl = imgJsUrl.value.trim();
    const cipherUrl = imgCipherUrl.value.trim();
    if (!jsUrl || !cipherUrl) throw new Error('请先填 JS 地址与密文图片地址');
    const sid = debugSourceId.value;
    const withSid = (u: string): string =>
      `/api/proxy?u=${encodeURIComponent(u)}${sid ? `&sid=${encodeURIComponent(sid)}` : ''}`;

    const jr = await fetch(withSid(jsUrl), { headers: { accept: 'text/javascript,*/*' } });
    if (!jr.ok) throw new Error('JS 抓取失败 HTTP ' + jr.status);
    const js = await jr.text();
    const cands = extractKeyCandidates(js);
    imgCands.value = cands;
    if (!cands.length) throw new Error('JS 里未抽到候选 key/iv（可能不是「字符串表 + charCode 连接」形态）');

    /**
     * ⚠️ 密文图 **不带 sid** 取：带 sid 时 `/api/proxy` 会用该源已配的 `coverDecodeJs`
     * 把图**解好再回传** ⇒ 我们拿到明文、试解必然失败（这正是本工具要复现的那条链路）。
     */
    const ir = await fetch(`/api/proxy?u=${encodeURIComponent(cipherUrl)}`);
    if (!ir.ok) throw new Error('图片抓取失败 HTTP ' + ir.status);
    const cipher = new Uint8Array(await ir.arrayBuffer());

    const hit = await detectAesCbcKeyIv(cipher, cands);
    if (!hit) throw new Error('全部候选试解失败（可能非 AES-CBC/PKCS7 或 key 不在 JS 里，见技能文档）');
    imgHit.value = { key: hit.key, iv: hit.iv, magic: hit.magic };
    imgRule.value = buildCoverDecodeJs(hit.key, hit.iv);
  } catch (e) {
    imgErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    imgBusy.value = false;
  }
}

async function copyImgRule(): Promise<void> {
  try {
    await navigator.clipboard.writeText(imgRule.value);
    imgCopied.value = true;
    setTimeout(() => { imgCopied.value = false; }, 1500);
  } catch (e) {
    imgErr.value = '复制失败：' + (e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="workshop">
    <!-- 左：新建源 + 源信息卡 + 源列表 + 分区 tab -->
    <div class="ws-left">
      <!-- `#268` 新建源入口：在左侧展示区上方（宽度与左栏一致、略窄） -->
      <div class="ws-newbar" style="position: relative">
        <button class="btn sm primary" style="width: 100%" @click="newOpen = !newOpen">＋ 新建源</button>
        <div v-if="newOpen" class="ws-newmenu">
          <button
            v-for="e in NEW_ENGINES" :key="e.kind"
            class="ws-newitem" @click="startNew(e.kind)"
          >{{ e.icon }} {{ e.label }}</button>
        </div>
      </div>

      <!-- 当前源信息卡 -->
      <div class="card" style="padding: 12px 14px">
        <template v-if="picked">
          <div class="ws-head">
            <span class="tag acc">{{ picked.kind }}</span>
            <b :title="picked.id">{{ picked.name || picked.id }}</b>
          </div>
          <div class="ws-meta" v-if="picked.group">{{ picked.group }}</div>
          <div class="ws-meta mono" v-if="!draftPicked" style="font-size: 11px">{{ picked.id.slice(0, 44) }}</div>
          <div class="ws-meta" v-else style="color: var(--orange, #d08700)">未保存的新源 —— 填好后点「保存」入库</div>
        </template>
        <div v-else class="empty">左侧选择一个源开始。</div>
      </div>

      <!-- 源列表（分组筛选 + 关键词筛选；二者状态都在 store 里，跨路由不丢） -->
      <div class="card src-panel">
        <div style="padding: 10px 10px 0">
          <!-- `#280` 引擎/类型筛选改统一组件 FilterDropdown（原原生 select 弹层是系统样式）。
               源类型**只在选了 legado** 时出现：maccms 源恒为 video（服务端硬事实），筛了没意义。 -->
          <div class="ws-filters">
            <FilterDropdown
              v-model="st.wsEngine"
              :options="wsEngineOpts"
              label="引擎"
              empty-text="暂无引擎"
              full
            />
            <FilterDropdown
              v-if="st.wsEngine === 'legado'"
              v-model="st.wsSourceType"
              :options="wsTypeOpts"
              label="类型"
              empty-text="该引擎下暂无类型"
              full
            />
          </div>

          <!-- 与发现页左栏**同一个组件**（用户 2026-09-28）；`#280` all-count 随类型下钻的池子 -->
          <SourceGroupFilter
            v-model="srcGroup"
            :options="wsGroupOptions"
            :all-count="wsGroupPool.length"
            :shown-count="filtered.length"
            label="源"
          />
          <input v-model="listQuery" class="disc-search" style="width: 100%" :placeholder="SOURCE_QUERY_PLACEHOLDER" />
        </div>
        <div class="ws-list">
          <!-- `#268` 占位源置顶（用户要求「源列表增加 ·legado/·maccms 新建源 占位」） -->
          <div
            v-if="st.draft" class="ws-item on"
            @click="pick('draft:' + st.draft.kind)"
          >
            <span class="tag">{{ st.kindIcon(st.draft.kind) }} {{ st.draft.kind }}</span>
            <span class="ws-name">{{ st.draftInfo?.name }}</span>
            <span class="tag orange">新</span>
          </div>
          <div
            v-for="s in filtered" :key="s.id"
            class="ws-item" :class="{ on: s.id === pickedId }"
            @click="pick(s.id)"
          >
            <span class="tag">{{ st.kindIcon(s.kind) }} {{ s.kind }}</span>
            <span class="ws-name">{{ s.name || s.id }}</span>
            <span v-if="!s.state.enabled" class="tag red">停</span>
          </div>
          <div v-if="!filtered.length" class="empty">没有匹配的源</div>
        </div>
      </div>

      <!-- 分区 tab（不同引擎加载不同 tab） -->
      <div class="card" style="padding: 8px">
        <div class="sec-label">编辑分区</div>
        <div class="sec-tabs">
          <button
            v-for="s in sections" :key="s.id"
            class="sec-tab" :class="{ on: activeSection === s.id }"
            @click="jumpSection(s.id)"
          >{{ s.name }}</button>
        </div>
      </div>
    </div>

    <!-- 中：嵌入编辑器 -->
    <div class="ws-mid">
      <WorkshopEditor
        v-if="picked"
        :key="pickedId"
        :source="picked"
        :initial-raw="st.draft?.raw"
        :tab="activeSection"
        @saved="st.loadMeta(true)"
        @renamed="onRenamed"
      />
      <div v-else class="card empty">左侧选择一个源开始编辑。</div>
    </div>

    <!-- 右：本源试跑（两条全链）+ 图片工具（`#692`） -->
    <div class="ws-right card">
      <!-- 标题固定不动（sticky）：滚信息流时始终知道「在跑哪个源」 -->
      <div class="chain-head">
        <h2>本源试跑</h2>
        <div class="chain-src">跑在：<b>{{ picked ? (picked.name || picked.id) : '（左侧先选一个源）' }}</b></div>
      </div>

      <div class="chain-tabs">
        <button class="chain-tab" :class="{ on: chainTab === 'search' }" @click="chainTab = 'search'">搜索全链</button>
        <button class="chain-tab" :class="{ on: chainTab === 'discover' }" @click="onDiscoverTab()">发现全链</button>
      </div>

      <!-- 搜索全链 -->
      <div v-if="chainTab === 'search'" class="chain-body">
        <input
          v-model="runKeyword" class="chain-in"
          placeholder="搜索关键词" @keydown.enter="runSearchChain()"
        />
        <button class="btn sm primary" :disabled="chainRunning || !pickedId" @click="runSearchChain()">
          {{ chainRunning ? '全链试跑中…' : '全链试跑' }}
        </button>
        <!--
          `#693` 胶囊只显示**真实可用的关键词**：源配了 `checkKeyWord` 就显示那个值（如「仙逆」），
          没配就**不显示**（旧版显示「校验关键字（checkKeyWord）（未配置）」这种占位文案，
          既不能点也没信息，纯噪音）。「我的」是兜底关键词，恒显示。
        -->
        <div class="chain-caps">
          <button
            v-if="checkKeyword" class="cap" :disabled="chainRunning"
            :title="`用源的校验关键字「${checkKeyword}」跑`" @click="runSearchChain(checkKeyword)"
          >{{ checkKeyword }}</button>
          <button class="cap" :disabled="chainRunning" @click="runSearchChain('我的')">我的</button>
        </div>
      </div>

      <!-- 发现全链 -->
      <div v-else class="chain-body">
        <input
          v-model="runExploreValue" class="chain-in mono"
          placeholder="发现链接 / 分类 value（留空 = 第一个分类）" @keydown.enter="runDiscoverChain()"
        />
        <button class="btn sm primary" :disabled="chainRunning || !pickedId" @click="runDiscoverChain()">
          {{ chainRunning ? '全链试跑中…' : '全链试跑' }}
        </button>
        <div class="chain-caps">
          <span v-if="exploreLoading" class="chain-hint">读取分类…</span>
          <template v-else-if="exploreCats.length">
            <button
              v-for="c in exploreCats" :key="c.key + c.value"
              class="cap" :disabled="chainRunning"
              :title="`跑分类：${c.value}`" @click="runDiscoverChain(c)"
            >{{ c.title }}</button>
          </template>
          <span v-else class="chain-hint">{{ exploreErr || '该源 home 没有返回可请求的分类' }}</span>
        </div>
      </div>

      <!--
        `#697` **合并成一块「试跑信息」**：结论 + 4 段时间轴 + 逐行回执，同一张卡、同一个滚动区。
        原先「汇总/时间轴」和「调试信息流」是两块独立区域（各自标题、各自边框），
        同一件事被切成两半，跑完还得上下扫两遍才对得上「哪一段对应哪几行日志」。
      -->
      <div class="chain-flow">
        <div v-if="chainRunning" class="chain-hint">
          正在跑{{ chainTab === 'search' ? '搜索' : '发现' }}全链…（逐段返回，可随时换源取消）
        </div>
        <div v-if="chainResult || chainLog.length" class="try-box">
          <div class="try-head">
            <span class="try-title">试跑信息</span>
            <span class="try-meta">
              {{ chainLog.length }} 行<template v-if="!chainRunning && chainResult"> · {{ chainResult.respondTime }}ms</template>
            </span>
          </div>
          <template v-if="chainResult">
            <div v-if="!chainRunning" class="chain-sum" :class="chainResult.ok ? 'ok' : 'bad'">
              {{ chainResult.ok ? '✅ 全链通过' : '❌ 全链失败' }} · {{ chainResult.respondTime }}ms
              <span class="chain-msg-inline">{{ chainResult.message }}</span>
            </div>
            <div class="chain-timeline">
              <div
                v-for="(row, i) in chainFlow" :key="row.key"
                class="tl-row" :class="row.state"
              >
                <span class="tl-dot">{{ row.state === 'pass' ? '✓' : row.state === 'fail' ? '✗' : '·' }}</span>
                <div class="tl-main">
                  <div class="tl-head">
                    <b>{{ i + 1 }}. {{ row.name }}</b>
                    <span v-if="typeof row.ms === 'number'" class="tl-ms">{{ row.ms }}ms</span>
                    <span v-else-if="row.state === 'skipped'" class="tl-ms">未执行</span>
                    <span v-else-if="row.state === 'running'" class="tl-ms">…</span>
                    <!-- `#694` 目录没有独立请求（数据随详情响应返回）⇒ 不再报一个和详情一样的耗时 -->
                    <span v-else-if="row.state === 'pass'" class="tl-ms" title="这一段没有独立请求，数据随上一步的响应返回">随详情</span>
                    <span v-else class="tl-ms">—</span>
                  </div>
                  <div v-if="row.detail" class="tl-detail">{{ row.detail }}</div>
                  <div v-if="row.error" class="tl-err">{{ row.error }}</div>
                </div>
              </div>
            </div>
          </template>
          <!-- 逐行回执（对齐 Legado 书源调试）：`[mm:ss.mmm]` + 标记符 -->
          <div v-if="chainLog.length" ref="logBox" class="chain-log">
            <div
              v-for="(l, i) in logLines" :key="i"
              class="cl-row" :class="l.level ?? 'info'"
            >
              <span class="cl-ts">{{ l.ts }}</span>
              <span class="cl-msg" :class="{ clamp: l.msg.length > 220 && !expandedLog.has(i) }">{{ l.msg }}</span>
              <button
                v-if="l.msg.length > 220" class="cl-more"
                @click="toggleLogRow(i)"
              >{{ expandedLog.has(i) ? '收起' : `展开 ${l.msg.length} 字` }}</button>
            </div>
          </div>
        </div>
        <div v-if="chainError" class="err-text">{{ chainError }}</div>
        <div v-if="!chainLog.length && !chainRunning && !chainResult" class="chain-hint">
          选一条链，点「全链试跑」（或点下面的胶囊）。
        </div>
      </div>

      <!-- 图片工具（原「站点探查」）：只留封面/图片解密这一件事 -->
      <section class="recon">
        <button class="recon-head" @click="reconOpen = !reconOpen">
          <span class="recon-caret" :class="{ on: reconOpen }">▶</span>
          <span>图片工具</span>
          <span class="recon-hint">{{ reconOpen ? '收起' : '封面/图片解密' }}</span>
        </button>

        <div v-if="reconOpen" class="recon-body">
          <div class="recon-in" style="display: flex; align-items: center; gap: 6px">
            <span class="recon-hint">源</span>
            <b style="font-size: 11.5px">{{ picked ? (picked.name || picked.id) : '（左侧先选一个源）' }}</b>
          </div>

          <!-- ① 封面解密诊断：直连 vs 代理，看魔数下结论 -->
          <div class="cv-probe">
            <div class="cv-probe-head">
              <span>封面解密诊断</span>
              <span class="recon-hint">直连是密文、代理是图片 ⇒ 解密正常</span>
            </div>
            <input
              v-model="coverUrl" class="recon-in mono"
              placeholder="粘贴一张封面 URL（发现页卡片上右键复制图片地址）"
              @keydown.enter="probeCover()"
            />
            <button class="btn sm" :disabled="coverBusy || !coverUrl.trim()" @click="probeCover()">
              {{ coverBusy ? '诊断中…' : '测这张图' }}
            </button>
            <template v-if="coverProbe">
              <div class="cv-row">
                <span class="cv-k">直连</span>
                <span v-if="coverProbe.direct" class="cv-v">
                  <b :class="['cv-badge', /JPEG|PNG|WEBP|GIF/.test(coverProbe.direct.kind) ? 'ok' : 'bad']">{{ coverProbe.direct.kind }}</b>
                  <code>{{ coverProbe.direct.magic || '—' }}</code>
                  <span class="recon-hint">{{ coverProbe.direct.size }}B · {{ coverProbe.direct.ms }}ms</span>
                </span>
              </div>
              <div class="cv-row">
                <span class="cv-k">代理(cover=1)</span>
                <span v-if="coverProbe.viaProxy" class="cv-v">
                  <b :class="['cv-badge', /JPEG|PNG|WEBP|GIF/.test(coverProbe.viaProxy.kind) ? 'ok' : 'bad']">{{ coverProbe.viaProxy.kind }}</b>
                  <code>{{ coverProbe.viaProxy.magic || '—' }}</code>
                  <span class="recon-hint">
                    {{ coverProbe.viaProxy.size }}B · {{ coverProbe.viaProxy.ms }}ms
                    <em v-if="coverProbe.viaProxy.cached">· 缓存命中</em>
                  </span>
                </span>
              </div>
              <div class="cv-verdict">{{ coverVerdict }}</div>
            </template>
          </div>

          <!--
            ② **解码链**（＝原「图片解密规则生成」）：封面解密诊断告诉你「该不该解」，
            这一块告诉你「用什么解」—— 从站点 JS 抽候选 key/iv，拿一张真密文图试解
            （判据是图片魔数），产出可直接粘进源 `coverDecodeJs` 的规则。
            目标只有一个：**生成封面/图片解密规则**，所以其余探查能力都撤了。
          -->
          <div class="recon-sec">
            <div class="recon-note">
              站点把图片加密、靠自己的 JS 解密后才渲染时用：填站点 JS 地址 + 一张密文图，
              自动抽 key/iv 并试解（魔数判据），产出 <b>coverDecodeJs</b>。
            </div>
            <label class="recon-full">JS 地址
              <input v-model="imgJsUrl" class="recon-in mono" list="imgJsList" placeholder="https://…/js/xxx.js" />
            </label>
            <datalist id="imgJsList">
              <option v-for="u in reconScriptUrls" :key="u" :value="u"></option>
            </datalist>
            <label class="recon-full">密文图片地址
              <input v-model="imgCipherUrl" class="recon-in mono" placeholder="https://…/xxx.jpeg" />
            </label>
            <button class="btn sm primary" :disabled="imgBusy" @click="analyzeImage">
              {{ imgBusy ? '分析中…' : '分析并生成规则' }}
            </button>
            <div v-if="imgErr" class="err-text">{{ imgErr }}</div>
            <template v-if="imgCands.length">
              <div class="recon-title">候选 key/iv（⟲ = charCode 串还原）</div>
              <pre class="recon-pre">{{ formatCandidates(imgCands) }}</pre>
            </template>
            <template v-if="imgHit">
              <div class="recon-kv"><b>命中</b><span>{{ imgHit.magic }} · AES-CBC/PKCS7</span></div>
              <div class="recon-kv"><b>key</b><span class="mono">{{ imgHit.key }}</span></div>
              <div class="recon-kv"><b>iv</b><span class="mono">{{ imgHit.iv }}</span></div>
              <div class="recon-title">
                生成的 coverDecodeJs
                <button class="btn sm" style="margin-left: auto" @click="copyImgRule">{{ imgCopied ? '已复制' : '复制' }}</button>
              </div>
              <pre class="recon-pre">{{ imgRule }}</pre>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
/**
 * `#691` **三列钉成同一个高度**（用户要求：「源编辑区高度固定为目前的最大高度，左侧源列表撑高 ⇒
 * 编辑分区自适应下移，左侧总高和编辑区总高相同」）。
 *
 * 以前是 `align-items: start` + 编辑区 `max-height` ⇒ 编辑区**随内容长短变高变矮**，
 * 左侧的「编辑分区」按钮组跟着上下跳；切一个源整页抖一次。
 * 现在用 `height: var(--ws-h)` 把三列一起钉住，各列**内部滚动**：
 *  · 左栏列表（`.ws-list`）自己滚，编辑分区按钮组贴在左栏底部（不再被长列表顶下去）；
 *  · 中栏编辑器自己滚（`.we` 里已有 `overflow:auto`）。
 * 高度取 `calc(100vh - 132px)`：顶栏 + 页面 padding 之后的可用高度（原 `-120px`，
 * 实测会让最底部动作条压到视口外一点，统一按 132 收）。
 */
.workshop {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 300px;
  gap: 14px;
  align-items: stretch;
  --ws-h: calc(100vh - 132px);
  min-height: var(--ws-h);
}
.ws-left {
  display: flex; flex-direction: column; gap: 12px;
  height: var(--ws-h); min-height: 0;
}
/* 左栏只有「源列表」这块吃掉剩余高度（其余是固定高的小卡片） */
.ws-left .src-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ws-left .src-panel .ws-list { flex: 1; min-height: 0; overflow: auto; }
/* `#268` 新建源按钮条（展示区上方；比左栏略窄） */
.ws-newbar { margin: 0 6px; }
.ws-newmenu {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
  background: var(--bg-1); border: 1px solid var(--line2); border-radius: 8px;
  box-shadow: var(--shadow); padding: 4px; display: flex; flex-direction: column; gap: 2px;
}
.ws-newitem {
  text-align: left; padding: 7px 10px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-1); font-size: 12.5px; cursor: pointer;
  font-family: var(--font);
}
.ws-newitem:hover { background: var(--bg-3); color: var(--text-0); }
/**
 * `#693` **去掉 `max-height: 340px`**：左栏高度已由 `.ws-left` 钉死、列表由 `flex:1` 撑开，
 * 这条历史限高会让「源列表」固定在 340px ⇒ 下方留一大块空白（用户截图里那块）。
 */
.src-panel { display: flex; flex-direction: column; max-height: none; }
.ws-list { flex: 1; overflow: auto; padding: 8px; }
/* `#281` 引擎 + 源类型筛选**纵向排列、满宽**（用户：与分组筛选组件宽度相同） */
.ws-filters { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.ws-item {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 9px; border-radius: 8px; cursor: pointer;
  font-size: 12px; color: var(--text-1);
}
.ws-item:hover { background: var(--bg-3); }
.ws-item.on { background: var(--brand-soft); color: #fff; }
.ws-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-head { display: flex; align-items: center; gap: 8px; }
.ws-head b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
.mono { font-family: var(--mono); color: var(--cy); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec-label { font-size: 11px; color: var(--faint); letter-spacing: 1px; padding: 2px 6px; }
.sec-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 6px 6px; }
.sec-tab {
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 7px;
  color: var(--muted); font-size: 12px; padding: 4px 10px; cursor: pointer;
  font-family: var(--font);
}
.sec-tab:hover { color: var(--text-0); border-color: var(--line2); }
.sec-tab.on { background: rgba(108, 124, 255, 0.16); border-color: var(--acc-dim); color: #fff; }
/* `#691` 中/右两栏与左栏同高（钉死，不随内容变化；内部各自滚动） */
.ws-mid { min-width: 0; display: flex; flex-direction: column; height: var(--ws-h); min-height: 0; overflow: auto; }
/* `#692` 编辑器本身撑满中栏：字段少的源也不会只占半截（内容少时高度不变） */
.ws-mid > * { flex: 1; min-height: 0; }
/* `#696` 右栏改成 flex 列：让「调试信息流」占满剩余高度（原先整栏滚动 ⇒ 信息流只剩一条缝） */
.ws-right { position: sticky; top: 0; height: var(--ws-h); overflow: hidden; display: flex; flex-direction: column; }

/* ── `#692` 本源试跑（两条全链） ────────────────────────────── */
.chain-head { position: sticky; top: 0; z-index: 2; background: var(--bg-1); padding: 12px 14px 6px; }
.chain-head h2 { margin: 0; font-size: 13px; }
.chain-src { margin-top: 4px; font-size: 11px; color: var(--muted); }
.chain-tabs { display: flex; gap: 6px; padding: 0 14px 8px; }
.chain-tab {
  flex: 1; padding: 6px 8px; font-size: 11.5px; cursor: pointer; font-family: var(--font);
  background: var(--bg-2); color: var(--muted); border: 1px solid var(--line); border-radius: 7px;
}
.chain-tab.on { background: rgba(108, 124, 255, 0.16); border-color: var(--acc-dim); color: #fff; }
.chain-body { display: flex; flex-direction: column; gap: 6px; padding: 0 14px 10px; }
.chain-in {
  width: 100%; padding: 6px 8px; font-size: 11.5px; border-radius: 6px;
  background: var(--bg-0); border: 1px solid var(--line); color: var(--text-0); font-family: var(--font);
}
.chain-caps { display: flex; flex-wrap: wrap; gap: 5px; }
.chain-caps .cap {
  padding: 3px 9px; font-size: 11px; border-radius: 999px; cursor: pointer;
  background: var(--bg-2); border: 1px solid var(--line); color: var(--text-1); font-family: var(--font);
}
.chain-caps .cap:hover:not(:disabled) { border-color: var(--acc-dim); color: var(--text-0); }
.chain-caps .cap:disabled { opacity: 0.45; cursor: not-allowed; }
.chain-hint { font-size: 11px; color: var(--muted); line-height: 1.5; }
/* `#696` 信息流吃掉「试跑区剩下的高度」：外层 flex:1 + 内层 flex:1 + min-height:0 三件套 */
.chain-flow {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  display: flex; flex-direction: column; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--border);
}
.chain-sum { font-size: 12px; font-weight: 600; }
.chain-sum.ok { color: #4ade80; }
.chain-sum.bad { color: #f87171; }
.chain-msg { font-size: 11px; color: var(--muted); line-height: 1.5; word-break: break-all; }
/*
 * `#693` 信息流：做成**时间轴**（一段一节点：结果 + 耗时 + 拿到了什么），
 * 对齐 Legado 调试信息流的观感 —— 只有 ✓ 看不出规则好坏，要看到条数/章数/字数。
 */
.chain-timeline { display: flex; flex-direction: column; }
.tl-row { display: flex; gap: 8px; position: relative; padding-bottom: 8px; }
/* 竖线（除最后一段） */
.tl-row:not(:last-child)::before {
  content: ''; position: absolute; left: 8px; top: 18px; bottom: 0; width: 1px; background: var(--line);
}
.tl-dot {
  flex: none; width: 17px; height: 17px; border-radius: 50%; font-size: 10.5px; line-height: 17px;
  text-align: center; font-weight: 700; background: var(--bg-2); border: 1px solid var(--line); color: var(--muted);
}
.tl-row.pass .tl-dot { background: rgba(34, 197, 94, 0.2); border-color: rgba(34, 197, 94, 0.5); color: #4ade80; }
.tl-row.fail .tl-dot { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.5); color: #f87171; }
.tl-main { flex: 1; min-width: 0; padding-top: 1px; }
.tl-head { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; }
.tl-head b { color: var(--text-0); font-weight: 600; }
.tl-ms { margin-left: auto; font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
.tl-detail { font-size: 11px; color: var(--muted); line-height: 1.5; word-break: break-all; }
.tl-err { font-size: 11px; color: #fca5a5; line-height: 1.45; word-break: break-all; }
.tl-row.pending { opacity: 0.5; }
/* `#695` 流式：正在跑、这一段还没回来（脉冲提示「在等它」） */
.tl-row.running .tl-dot { border-color: rgba(56, 189, 248, 0.5); color: #38bdf8; animation: tl-pulse 1.1s ease-in-out infinite; }
.tl-row.running .tl-ms { color: #38bdf8; }
@keyframes tl-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.tl-row.skipped .tl-detail, .tl-row.skipped .tl-head b { color: var(--muted); }
/*
 * `#697` 试跑信息（合并块）：结论 + 4 段 + 逐行回执装在同一张卡里。
 * 整块 `flex:1` 吃掉右栏剩余高度，**日志自己滚**（结论与段位不跟着滚走）。
 */
.try-box {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  background: rgba(255, 255, 255, 0.015);
}
.try-head { flex: none; display: flex; align-items: baseline; gap: 8px; }
.try-title { font-size: 11.5px; font-weight: 600; color: var(--text-0); }
.try-meta { margin-left: auto; font-size: 10px; color: var(--muted); font-family: var(--mono); }
.chain-msg-inline { margin-left: 6px; font-size: 10.5px; font-weight: 400; color: var(--muted); }
.chain-timeline { flex: none; }
/* 逐行回执：等宽、可滚、`[mm:ss.mmm]` 灰掉不抢戏 */
.chain-log {
  flex: 1 1 auto; min-height: 100px; overflow: auto; background: var(--bg-0);
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px;
  font-family: var(--mono); font-size: 10.5px; line-height: 1.55;
  /* 顶部一条虚线，视觉上把「段位结论」和「逐行回执」分开，但仍是同一张卡 */
  border-top-style: dashed;
}
.cl-row { display: flex; gap: 6px; white-space: pre-wrap; word-break: break-all; color: #a5f3fc; }
.cl-ts { flex: none; color: #64748b; }
.cl-msg { flex: 1; min-width: 0; }
.cl-row.warn .cl-msg { color: #fbbf24; }
.cl-row.error .cl-msg { color: #f87171; }
/* 长行折叠（简介/正文）：3 行封顶 + 「展开 N 字」 */
.cl-msg.clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.cl-more {
  flex: none; align-self: flex-start; margin-left: 4px; padding: 0 4px; font-size: 9.5px;
  background: transparent; border: 1px solid var(--line); border-radius: 4px;
  color: var(--muted); cursor: pointer; font-family: var(--font);
}
.cl-more:hover { color: var(--text-0); border-color: var(--acc-dim); }
/* 图片工具那块留在底部，不参与伸缩 */
.ws-right > .recon { flex: none; }
.ws-channels { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.dbg-out {
  background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px; font-size: 11px; overflow: auto; max-height: 420px;
  color: #a5f3fc; font-family: var(--mono); white-space: pre-wrap;
}
/* `#429` 站点探查面板（右栏 300px 窄宽友好：换行 + 局部滚动） */
.recon { border-top: 1px solid var(--line2); margin-top: 6px; }
.recon-head {
  width: 100%; display: flex; align-items: center; gap: 6px;
  background: transparent; border: none; color: var(--text-0);
  font-family: var(--font); font-size: 12.5px; cursor: pointer; padding: 10px 14px; text-align: left;
}
.recon-head:hover { color: #fff; }
.recon-caret { display: inline-block; transition: transform 0.16s; color: var(--muted); font-size: 10px; }
.recon-caret.on { transform: rotate(90deg); }
.recon-hint { margin-left: auto; font-size: 10.5px; color: var(--faint); }
.recon-body { padding: 0 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.recon-in {
  width: 100%; box-sizing: border-box; background: var(--bg-2);
  border: 1px solid var(--line2); border-radius: 7px; color: var(--text-0);
  font-family: var(--font); font-size: 11.5px; padding: 6px 8px;
}
textarea.recon-in { resize: vertical; line-height: 1.4; }
.recon-tabs { display: flex; flex-wrap: wrap; gap: 4px; }
.recon-tab {
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 7px;
  color: var(--muted); font-size: 11px; padding: 3px 8px; cursor: pointer; font-family: var(--font);
}
.recon-tab:hover { color: var(--text-0); }
.recon-tab.on { background: rgba(108, 124, 255, 0.16); border-color: var(--acc-dim); color: #fff; }
.recon-sec { display: flex; flex-direction: column; gap: 6px; }
.recon-title {
  font-size: 11px; color: var(--faint); letter-spacing: 0.5px;
  display: flex; align-items: center; gap: 6px;
}
.recon-kv { display: flex; gap: 6px; font-size: 11.5px; color: var(--text-1); align-items: baseline; }
.recon-kv b { color: var(--faint); font-weight: 500; flex: 0 0 auto; }
.recon-kv span { word-break: break-all; }
.recon-empty { font-size: 11.5px; color: var(--muted); padding: 6px 0; }
.recon-note {
  font-size: 11px; line-height: 1.55; color: var(--muted);
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 7px; padding: 7px 8px;
}
.recon-note b { color: var(--cy, #67e8f9); font-weight: 500; }
.recon-item { display: flex; flex-direction: column; gap: 2px; }
.recon-meta { font-size: 10.5px; color: var(--faint); font-family: var(--mono); }
.recon-pre {
  background: var(--bg-0); border: 1px solid var(--border); border-radius: 7px;
  padding: 8px; font-size: 10.5px; color: var(--text-1); font-family: var(--mono);
  white-space: pre-wrap; word-break: break-all; overflow: auto; max-height: 260px; margin: 0;
}
.recon-url {
  font-size: 10.5px; color: var(--cy, #67e8f9); font-family: var(--mono);
  white-space: normal; word-break: break-all; overflow-wrap: anywhere;
}
.recon-param { font-size: 11.5px; color: var(--text-0); }
.recon-param code { color: var(--orange, #d08700); font-family: var(--mono); }
.recon-gv { display: flex; gap: 6px; font-size: 11px; }
.recon-gv code { flex: 0 0 auto; color: var(--cy, #67e8f9); font-family: var(--mono); }
.recon-val { color: var(--muted); word-break: break-all; }
.recon-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.recon-chip {
  font-size: 10.5px; color: var(--text-1); background: var(--bg-2);
  border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; word-break: break-all;
}
.recon-chip i { color: var(--faint); font-style: normal; font-family: var(--mono); }
.recon-media { display: flex; gap: 6px; align-items: baseline; font-size: 11px; }
.recon-media .tag { flex: 0 0 auto; }
.recon-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
/* `#691` 封面解密诊断 */
.cv-probe { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed var(--line2, #333); border-radius: 8px; }
.cv-probe-head { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; font-weight: 600; }
.cv-row { display: flex; gap: 6px; align-items: center; font-size: 11px; }
.cv-k { flex: none; width: 74px; color: var(--muted); }
.cv-v { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
.cv-badge { padding: 1px 6px; border-radius: 4px; font-size: 10.5px; font-weight: 600; }
.cv-badge.ok { background: rgba(34, 197, 94, 0.18); color: #4ade80; }
.cv-badge.bad { background: rgba(239, 68, 68, 0.18); color: #f87171; }
.cv-verdict { font-size: 11.5px; line-height: 1.5; color: var(--text-0); }
.recon-grid label, .recon-full { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--faint); }
.recon-row { display: flex; gap: 6px; align-items: center; }
.recon-report {
  border-top: 1px dashed var(--line2); margin-top: 6px; padding-top: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
@media (max-width: 1400px) {
  .workshop { grid-template-columns: 220px minmax(0, 1fr); }
  .ws-right { grid-column: 1 / -1; position: static; max-height: none; }
}
/* `#550` 调试诊断卡 */
.diag-card { border: 1px solid var(--border); border-left: 3px solid var(--acc); border-radius: 8px; padding: 9px 11px; background: var(--bg-2); font-size: 12px; }
.diag-card.error { border-left-color: var(--red); }
.diag-card.warn { border-left-color: var(--orange); }
.diag-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.diag-code { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.diag-title { font-weight: 600; color: var(--text-0); }
.diag-cause { color: var(--muted); line-height: 1.6; }
.diag-next { margin: 6px 0 0; padding-left: 18px; color: var(--text-0); line-height: 1.7; }
</style>
