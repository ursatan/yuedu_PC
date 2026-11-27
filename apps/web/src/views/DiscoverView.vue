<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDiscoverStore } from '../stores/discover';
import { useSourcesStore } from '../stores/sources';
import SourcePinButton from '../components/SourcePinButton.vue';
import { useReaderStore } from '../stores/reader';
import { useVodStore } from '../stores/vod';
import CoverImage from '../components/CoverImage.vue'; /* `#163` 封面统一出口 */
import CategoryScroller, { type CatOption } from '../components/CategoryScroller.vue';
import CatToolbar, { type ToolbarOption, type ToolbarGroup } from '../components/CatToolbar.vue';
import SourceGroupFilter from '../components/SourceGroupFilter.vue';
// `#280` 引擎/类型筛选统一组件（弹层样式与 SourceGroupFilter 一致）
import FilterDropdown from '../components/FilterDropdown.vue';
import SourceLoginDialog from '../components/SourceLoginDialog.vue';
/* `#437` 启动页外链 → **应用内浏览器**（源作者的原话：「所有外链一律走内置浏览器」） */
import InAppBrowser from '../components/InAppBrowser.vue';
// `#310` 门控判据唯一实现（与源管理页/聚合搜索/换源搜索同一份，见 utils/source-gate.ts）
import { searchUsable, isWebViewOnly } from '../utils/source-gate';
/* `#448` 站地址 / 同站判定 / 「像不像页面」—— 与阅读页正文内跳转共用**同一份**判据 */
import { sameSite, sourceSiteUrlOf } from '../utils/source-site';
// `#404` RSS 启动页（startHtml）—— 复用正文同一套 HTML 壳（buildHtmlDoc）+ 启动页 java 垫片
import { buildHtmlDoc, buildStartPageJavaShim, serverOriginOf } from '../utils/html-shell';
// `#418` 启动页 `source.setVariable()` 的落盘出口（服务端端点早就有，见 api.ts 注释）
import { setSourceVariable } from '../api';
/* `#438` 启动页里 `legado:` 导入链接走**统一派发器**（与 ReaderOverlay/InAppBrowser 同一份） */
import { dispatchSchemeImport } from '../utils/scheme-import';
// `#287` 搜索浮层（与源管理共用同一组件；范围 = 当前选中的源）
import SourceSearchDialog from '../components/SourceSearchDialog.vue';
// 源分组语义的唯一实现（与 stores/sources.ts、views/WorkshopView.vue 共用一份）
import { matchSourceGroup, sourceGroupOptions } from '../source-groups';
// `#280` 筛选框字段口径（名称/URL/注释/分组）唯一实现
import { matchSourceQuery, SOURCE_QUERY_PLACEHOLDER } from '../utils/source-query';
// 封面统一走服务端代理（防盗链 Referer + 源图片解密 + 动图原样透传）——见 utils/img.ts
import { imgSrc } from '../utils/img';
import { itemAuthor, itemIdentity, itemLastChapter } from '../utils/list-item';
// `#404` 启动页 java 垫片回传的 toast（源脚本我写的提示）走全局 toast
import { toast } from '../toast';

const route = useRoute();
const router = useRouter();
const disc = useDiscoverStore();
const st = useSourcesStore();
const reader = useReaderStore();
const vod = useVodStore();

const kind = computed(() => ((route.meta.kinds as string[]) ?? ['legado'])[0]!);
const b = computed(() => disc.bucket(kind.value));
/**
 * `#404` **RSS 启动页 srcdoc**：复用正文同一套壳（`buildHtmlDoc`）——
 *  · `startStyle` + `java` 垫片注入 `<head>` 末尾（脚本要 `java.open/base64Encode/toast`）；
 *  · `startJs` 注入 `</body>` 前。
 * 非启动页源 ⇒ 空串（模板不渲染该 iframe）。
 */
/**
 * `#437` 启动页 `localStorage` 的**宿主落盘位**（按源隔离）。
 * ⚠️ 键必须带 `v1` 版本位：将来结构变了要能整批丢弃，不能让旧快照喂坏新页面。
 */
const START_STORAGE_PREFIX = 'yuedu.startpage.v1.';
function startStorageKey(id: string): string {
  return id ? START_STORAGE_PREFIX + id : '';
}
function readStartStorage(id: string): string {
  const k = startStorageKey(id);
  if (!k) return '';
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}

const startDoc = computed(() => {
  const sp = b.value.startPage;
  if (!sp) return '';
  const extraHead = (sp.style ? '<style>' + sp.style + '</style>' : '') +
    // `#418`：`java.ajax` 要打 `/api/proxy`（需 origin + sid）、`source.getVariable()` 要预置源变量
    '<script>' + buildStartPageJavaShim({
      origin: serverOriginOf(),
      sid: b.value.sourceId,
      variable: sp.variable ?? '',
    }) + '<\/script>';
  const extraBody = sp.js ? '<script>' + sp.js + '<\/script>' : '';
  return buildHtmlDoc(sp.html, {
    base: sp.baseUrl || undefined,
    sid: b.value.sourceId,
    origin: serverOriginOf(),
    extraHead,
    extraBody,
    /**
     * `#437` **启动页存储持久化**：源作者的启动页把「书架 / 外观配置 / 自定义按钮」
     * 存在 `localStorage`（沙箱 iframe 是不透明 origin ⇒ 真 localStorage 抛异常 ⇒ 垫片只能内存态
     * ⇒ **重开源/刷新就清空**，用户实测「加入书架后重进该源，书架空」）。
     * 这里把宿主落盘的快照灌进去（同步可读），写入侧由 `yueduStartStorage` 报文回传（见下）。
     */
    storageSnapshot: readStartStorage(b.value.sourceId),
    storageKey: startStorageKey(b.value.sourceId),
  });
});
/**
 * `#404` 启动页内 `java.*` 桥的宿主消费（`buildStartPageJavaShim` 发 `{yueduStartJava}`）。
 *
 * `#418`：`java.ajax` **在沙箱页内自跑**（同步 XHR → `/api/proxy`）⇒ 宿主只管「动作类」：
 *  `open`（sort 分类 / login / search / rss 文章）、`openUrl|startBrowser`（外部链接）、
 *  `putVariable`（`source.setVariable()` 落盘）、`toast`。
 */
function onStartJavaMessage(e: MessageEvent): void {
  /**
   * `#444` **必须按报文来源过滤**（缺陷类别：多个 overlay 共用 `window` 的 message 监听）。
   *
   * 症状（用户 2026-10-13 报 千白羽论坛）：「点击链接会在打开 json 页面（当前阅读页），
   * 但**又**在阅读页下面用内置浏览器打开了链接」—— 一次点击**两处都动**。
   * 真因：本监听器挂在 `window` 上且**不看 `e.source`**；而 `ReaderOverlay` 的正文 iframe
   * （同一窗口的另一个 iframe）里的导航桥 `postMessage` 也发 `{yueduNav}` ⇒ **发现页的
   * 监听器把它也当「启动页内链接」处理了**：
   *  · 同站链接 ⇒ 又一次 `readFirstDirect`（`reset()` 把正在读的会话洗掉 ⇒ 渲染残缺/跳变）；
   *  · 异站（如 `.json` 书源）⇒ `webOpen` 打开**内置浏览器**（用户看到的「多开一个」）。
   * 修法：只认**启动页自己那个沙箱 iframe** 的报文（`e.source` 与它 `contentWindow` 同一引用；
   * opaque origin 也能比引用相等）。
   */
  if (e.source !== startFrame.value?.contentWindow) return;
  /**
   * `#437` **启动页存储回写**：沙箱页没有真 `localStorage`（不透明 origin）⇒ 垫片的写入
   * 防抖 400ms 后 postMessage 回来，由宿主按源落盘 ⇒ 下次进这个源时再灌回快照。
   * 不这样做，源作者存在 localStorage 的「书架 / 外观配置」重进就没了（用户实测「书架空」）。
   */
  const store = (e.data as { yueduStartStorage?: { key?: unknown; data?: unknown } } | null)?.yueduStartStorage;
  if (store && typeof store.key === 'string' && store.key.startsWith(START_STORAGE_PREFIX) && typeof store.data === 'string') {
    try {
      localStorage.setItem(store.key, store.data);
    } catch {
      /* 配额/隐私模式：尽力而为，不影响页面 */
    }
    return;
  }
  const msg = (e.data as { yueduStartJava?: { m?: unknown; args?: unknown[] } } | null)?.yueduStartJava;
  /**
   * `#438` **启动页里的 `<a href>` 点击**（壳层导航桥 `buildNavBridge` 发的 `{yueduNav}`）。
   *
   * 缺陷类别：`buildHtmlDoc` 对**所有**文档（含启动页）都注入导航桥，它在**捕获阶段**
   * `preventDefault + stopPropagation` 并把跳转 `postMessage` 出来；而此前只有
   * `ReaderOverlay` / `InAppBrowser` 的监听器消费这个报文 —— 发现页**不接** ⇒
   * 启动页里点帖子被桥吞掉、宿主零响应（用户实测「帖子点击无响应」）。
   *
   * 为什么不靠启动页自己的 `x8TrapInit`：作者的 trap **故意排除**主体列表容器
   * （`x8InScope` 的白名单只有侧栏/详情/导航等），列表里的 `<a>` 本来靠原生导航；
   * 我们的桥先跑（head 期注册）把这步也拦了 ⇒ 两边都不动。
   * 出口与作者意图一致（其 `x8Open` 注释：「所有外链一律走内置浏览器」）⇒ 走 `InAppBrowser`。
   * ⚠️ 浏览器已打开时不重复处理（`webOpen` 非空 ⇒ 交给 `InAppBrowser` 自己的监听器）。
   */
  const nav = (e.data as { yueduNav?: { url?: unknown; kind?: unknown } } | null)?.yueduNav;
  if (nav && typeof nav.url === 'string' && nav.url && !webOpen.value) {
    if (nav.kind === 'legado') dispatchSchemeImport(nav.url);
    else openStartPageUrl(nav.url);
    return;
  }
  if (!msg) return;
  const m = String(msg.m ?? '');
  const args = Array.isArray(msg.args) ? msg.args : [];
  if (m === 'open') {
    const type = String(args[0] ?? '');
    const payload = String(args[1] ?? '');
    const title = String(args[2] ?? '');
    if (type === 'sort') {
      try {
        disc.openSortCategories(kind.value, JSON.parse(payload) as Record<string, string>);
      } catch (err) {
        toast(`启动页分类数据无法解析：${err instanceof Error ? err.message : String(err)}`, 'warn');
      }
    } else if (type === 'login') {
      loginOpen.value = true;
    } else if (type === 'search') {
      searchOpen.value = true;
    } else if (type === 'rss') {
      // 启动页里点热文/文章：与订阅源卡片点击走同一条「直达阅读页」通路（`#344`/`#399`）
      void reader.readFirstDirect(b.value.sourceId, {
        id: payload, kind: 'article', title, layout: 'text-row', payload: { link: payload, title },
      });
    }
  } else if (m === 'toast') {
    toast(String(args[0] ?? ''), 'info');
  } else if (m === 'putVariable') {
    // `#418` `source.setVariable()` 落盘（沙箱页闭包里那份已同步更新；这里写服务端持久层）
    void setSourceVariable(b.value.sourceId, String(args[0] ?? ''));
  } else if (m === 'openUrl' || m === 'startBrowser') {
    // `java.startBrowser(url,title)` 的第 2 参数是标题；`openUrl(url,mode)` 的第 2 个是模式（当标题也无妨）
    openStartPageUrl(String(args[0] ?? ''), String(args[1] ?? ''));
  }
}
/**
 * `#437` 启动页 `java.openUrl` / `java.startBrowser` 的出口；`#440` 改为**分流**。
 *
 * 用户复测意见（2026-10-13）：「点击其他链接，目前是用内置浏览器打开，能不能像书籍那样
 * 直接在启动页内打开？或者使用阅读页打开？目前的跳转只是原样打开了链接，**没有使用任何
 * 源规则做的界面优化**，源规则对页面做的各种布局优化就没有意义了。」
 *
 * ## 为什么不能「在启动页内打开」
 * 启动页是**不透明 origin 的沙箱 iframe**（`srcdoc` + `sandbox` 无 `allow-same-origin`）
 * ⇒ iframe 自己导航到异站页面会**没有 Cookie / 没有同源**，多数站点直接拒或跳登录页。
 * 「书籍能页内打开」是因为**作者自己的 JS** 在页内渲染（`xsGet` 拉数据 + 自绘 UI），
 * 那条路本来就不经过我们。
 *
 * ## 分流（`#440`）
 *  · **同站**（当前源的站点，含子域）⇒ 交**阅读页** `reader.readFirstDirect`：
 *    与启动页 `java.open('rss')` / 卡片点文章**同一条通路** ⇒ 源的 `ruleContent` / `style` /
 *    净化全部生效（正是用户要的「源规则做的界面优化」）。
 *  · **异站**（网址导航 / 源仓库 / 更新页 …）⇒ 保留**应用内浏览器**（源规则对别的站点无意义，
 *    而且这类页常有「导入书源」按钮，必须内置才能点动）。
 */
function openStartPageUrl(u: string, title = ''): void {
  if (!/^https?:\/\//i.test(u)) return;
  if (sameSite(u, sourceSiteUrl())) {
    // 与启动页 `java.open('rss', link, title)` 同一通路（`#344`/`#399` 的直达阅读页）
    void reader.readFirstDirect(b.value.sourceId, {
      id: u, kind: 'article', title, layout: 'text-row', payload: { link: u, title },
    });
    return;
  }
  webOpen.value = { url: u, title };
}
/** `#440` 当前源的站地址 · `#448` 同站判定的**唯一实现**已抽到 `utils/source-site.ts` */
function sourceSiteUrl(): string {
  return sourceSiteUrlOf(st.sources, b.value.sourceId);
}
/** `#437` 应用内浏览器（启动页外链 / 帖子打开） */
const webOpen = ref<{ url: string; title: string } | null>(null);
/** `#437` 应用内浏览器的「↗ 本机浏览器」出口（模板里直接用 window 会取不到） */
function openExternal(u: string): void {
  if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
}
/**
 * `#239` 把当前 kind 报给 store —— 影院不显示源类型筛选时，store 据此**清掉**已选的值
 * （否则会带着一个看不见却仍生效的条件把列表筛成 0 条，见 store 里 `discKind` 的注释）。
 */
watch(kind, (k) => { st.discKind = k; }, { immediate: true });
/**
 * ⚠️ 以下三项**必须从 bucket 取**，不能是组件级 `ref`：
 * 书院(`/discovery/books`) 与影院(`/discovery/video`) 共用同一个路由组件，Vue Router **复用实例**
 * ⇒ 组件 ref 会跨页串值（用户实测：「书源里输入了筛选文字，切到影院还是书源的文字」）。
 * 放进 bucket 后天然按发现页隔离，且跨路由往返不丢（见 `DiscState.srcQuery` 注释）。
 */
const listQuery = computed({
  get: () => b.value.srcQuery,
  set: (v: string) => { b.value.srcQuery = v; },
});
/** `#287` 搜索浮层开关（范围 = 当前选中的源） */
const searchOpen = ref(false);
/**
 * `#293` 当前选中源**能不能搜** —— 发现页右栏的「⌕ 搜索」按钮以此为准
 * （用户 2026-10-05：「发现页的搜索按钮也应该是有搜索规则的源才显示，同登录按钮」）。
 *
 * `#310`（用户 2026-10-07 需求 ②③）再加两层：
 *  · **用户开关**：`searchEnabled=false`（禁用搜索）的源，发现页**也不提供**搜索按钮；
 *  · **源已启用**：源整体禁用 ⇒ 一切不可用。
 * 判据走 `utils/source-gate.ts` 的 `searchUsable`（与源管理页/聚合搜索同一份，不再各写一遍）。
 */
const curHasSearch = computed(() => {
  const id = b.value.sourceId;
  if (!id) return false;
  const s = st.sources.find((x) => x.id === id);
  return !!s && searchUsable(s);
});
/** 切到「不能搜」的源时把已打开的浮层收掉（否则会停在一个搜不出东西的会话上） */
watch(curHasSearch, (v) => { if (!v) searchOpen.value = false; });
const viewMode = computed({
  get: () => b.value.viewMode,
  // ⚠️ 必须走 store 的 `setViewMode`（它负责写 localStorage）——
  // 组件里直接 `b.viewMode = v` 的话刷新页面布局就又回去了（用户 2026-10-01 明确要求「持久化」）。
  set: (v: 'grid' | 'list' | 'wide') => { disc.setViewMode(kind.value, v); },
});
const sources = computed(() => disc.sourcesOf(kind.value));

const kindLabel = computed(() => {
  const map: Record<string, string> = { legado: '书源', maccms: '影视', rss: 'RSS' };
  return map[kind.value] ?? kind.value;
});

/**
 * `#237` 各源类型在这个 kind 下有多少个源（**计数与过滤同池** = `sources`，不给整个 `st.sources`）。
 * ★ 池子必须与 `filteredSources` 用的 `sources` 同一个 —— 否则又会出现
 *   「下拉里写着 12 个、点进去 0 条」（本仓反复出现的那类缺陷）。
 */
const discTypeCounts = computed(() => st.sourceTypeCounts(sources.value));
/**
 * `#280` 类型下拉选项：全部行 + 计数 > 0 的类型（FilterDropdown 的 options 形状）。
 * 「全部」行计数 = 池子大小（与选中后列表条数一致）。
 */
const discTypeOpts = computed(() => [
  { value: '', label: '全部类型', count: sources.value.length },
  ...discTypeCounts.value.filter((t) => t.count > 0).map((t) => ({ value: t.value, label: t.label, count: t.count })),
]);
const pageTitle = computed(() => {
  const map: Record<string, string> = { legado: '书院 · 书源发现', maccms: '影院 · 影视源发现', rss: 'RSS 订阅发现' };
  return map[kind.value] ?? `${kind.value} · 发现`;
});

/** 第一筛选组 → 横滚条。分类**只来自源规则**（exploreKinds/分类代码），不注入「全部」——
 *  影院(maccms) 同书院(legado) 一致；清空筛选的方式是「再点一次已选中的分类」（Toggle）。 */
const primaryGroup = computed(() => b.value.filters[0] ?? null);
/** 装饰清理：源常在分类名首尾放 ✲＊*·•-—_ 之类的标记，横滚条里显示出来很脏 */
const cleanName = (s: string) => s.replace(/^[\s✲＊*·•\-—_]+|[\s✲＊*·•\-—_]+$/g, '') || s;

type RawOpt = NonNullable<typeof primaryGroup.value>['options'][number];
/** 原始选项 → 分类条 chip（只有 url 型子分类才进分类条） */
function toCatOption(o: RawOpt): CatOption {
  return {
    label: cleanName(o.name),
    // 原始 name：选中态比对/交互键都用它（cleanName 会剥装饰符 → 对不上就不高亮）
    rawLabel: o.name,
    value: o.value ?? '',
    ...(o.layout ? { layout: o.layout } : {}),
  };
}
/** 原始选项 → 组件区控件（交互型） */
function toToolbarOption(o: RawOpt): ToolbarOption {
  return {
    label: cleanName(o.name),
    rawLabel: o.name,
    value: o.value ?? '',
    ...(o.kind ? { kind: o.kind } : {}),
    ...(o.layout ? { layout: o.layout } : {}),
    ...(o.chars ? { chars: o.chars } : {}),
    ...(o.default ? { default: o.default } : {}),
    ...(o.action ? { action: o.action } : {}),
  };
}

/**
 * **分组切分**（用户实测 ① 的重构核心）。
 *
 * Legado 的 `exploreKinds` 里 `url` 为空的纯标题项就是「分组标题」，其后的 url 项归它管；
 * 源没有分组标题时全部子分类同属一组（`title: ''`，行为与重构前一致）。
 *
 * 为什么要分组：部分源的 exploreUrl 产出 100+ 分类（🏷七猫[官方]v3.1 实测 50 项 / 41 个 url 项；
 * 🏷七猫四合一 33 项 / 3 个分组标题），平铺在一条横滚里既点不准也看不出层次。
 * ⚠️ 切分组**纯前端**（数据来自同一次 explore 结果）——**不重跑源脚本**（重算是交互控件的职责）。
 */
const catGroups = computed<{ title: string; options: CatOption[] }[]>(() => {
  const g = primaryGroup.value;
  if (!g) return [];
  const out: { title: string; options: CatOption[] }[] = [];
  for (const o of g.options) {
    // 交互型（select/toggle/text/button）不上分类条，进组件区
    if (o.kind && o.kind !== 'url') continue;
    // 纯标题型（url 为空且非交互）→ 分组标题
    if (o.header || (!o.value && !o.kind)) {
      out.push({ title: cleanName(o.name), options: [] });
      continue;
    }
    if (!out.length) out.push({ title: '', options: [] });
    out[out.length - 1]!.options.push(toCatOption(o));
  }
  // 丢掉没有任何子分类的空分组（只留标题会点出空条）
  const nonEmpty = out.filter((x) => x.options.length > 0);
  return nonEmpty.length ? nonEmpty : out;
});
/** 组件区控件（交互型） */
const toolbarInteractives = computed<ToolbarOption[]>(() =>
  (primaryGroup.value?.options ?? []).filter((o) => o.kind && o.kind !== 'url').map(toToolbarOption),
);
/** 组件区分组选择器（纯标题型提升上来的） */
const groupTabs = computed<ToolbarGroup[]>(() =>
  catGroups.value.map((g) => ({ title: g.title, count: g.options.length })),
);
/** 有分组标题才显示分组选择器（只有一组 = 源没分组） */
const hasGroups = computed(() => catGroups.value.length > 1 && groupTabs.value.some((g) => g.title));

const GROUP_KEY_PREFIX = 'yuedu.catgroup.v1.';
function groupCacheKey(): string {
  return GROUP_KEY_PREFIX + (b.value.sourceId?.trim() || '__default__');
}
function readSavedGroup(): string {
  try {
    return sessionStorage.getItem(groupCacheKey()) ?? '';
  } catch {
    return '';
  }
}
/**
 * 当前分组下标。持久化存**分组标题**而不是下标 ——
 * 交互控件重算后分组集合会变（下标会指到别处），按标题才能稳定还原。
 */
const activeGroupIdx = ref(0);
function pickGroup(i: number) {
  activeGroupIdx.value = i;
  try {
    sessionStorage.setItem(groupCacheKey(), catGroups.value[i]?.title ?? '');
  } catch {
    /* ignore */
  }
}
// 分组集合变化（换源 / 交互控件重算）→ 按标题恢复；标题没了就回第一组
watch(
  [() => b.value.sourceId, () => catGroups.value.map((g) => g.title).join('\u0000')],
  () => {
    const saved = readSavedGroup();
    const i = catGroups.value.findIndex((g) => g.title === saved);
    activeGroupIdx.value = i >= 0 ? i : 0;
  },
  { immediate: true },
);

/** 分类条只显示**当前分组**的子分类 */
const scrollerCats = computed<CatOption[]>(() => catGroups.value[activeGroupIdx.value]?.options ?? []);
const scrollerValue = computed<CatOption | null>(() => {
  const g = primaryGroup.value;
  if (!g || !b.value.active || b.value.active.key !== g.key) return null;
  const opt = g.options.find((o) => !o.header && o.value === b.value.active?.value);
  return opt ? { label: opt.name, rawLabel: opt.name, value: opt.value ?? '' } : null;
});
/**
 * `#307` **单分类且无名 ⇒ 不渲染分类条**。
 *
 * 上游 `RssSortActivity.upFragmentsView`（`ui/rss/article/RssSortActivity.kt:386-401`）：
 * `sortList.size == 1` 且名字为空时把 tabs **藏起来**（`tabsContainer.gone()`），标题用源名。
 * RSS 源没配 `sortUrl` 时 `parseRssSortUrls` 正好回落到「一个无名分类 = 源地址」——
 * 这里必须一样藏掉，否则会渲染出一枚**空白 chip**（旧版那枚假「最新」就是在这条路上现身的）。
 */
const soleUnnamedCat = computed(
  () => scrollerCats.value.length === 1 && !scrollerCats.value[0]!.label.trim(),
);
const activeCatLabel = computed(() => {
  const v = scrollerValue.value;
  if (!v) return '未选分类';
  // 无名分类（RSS 整源 = 一个无名分类）⇒ 工具条显示「全部」，别留一片空白
  return v.label.trim() || '全部';
});
const restGroups = computed(() => b.value.filters.slice(1));
/**
 * 分类条区域是否真有东西（分隔线只在真渲染了分类区时画，避免空分区留一条悬空线）：
 * `CategoryScroller`、它的空态占位、以及其余筛选 chips（`restGroups`）任一存在即算。
 */
const showCatZone = computed(
  () =>
    (scrollerCats.value.length > 0 && !soleUnnamedCat.value) ||
    (!b.value.loading && !!b.value.sourceId && hasToolbar.value && scrollerCats.value.length === 0) ||
    restGroups.value.length > 0,
);
/** legado 源有「分类代码」（exploreKinds）语义：分类只来自规则，无「全部」回退 */
const isLegado = computed(() => kind.value === 'legado');

/**
 * **源分组筛选**（用户实测 ①-3：把「▣书源 433」单标签改成下拉式分组筛选）。
 *
 * ⚠️ 分组语义（多组分隔符 `,`/`，`/`&`、「未分组」哨兵、计数口径）**只在 `source-groups.ts` 写一遍** ——
 * 此前这里与 `stores/sources.ts` 各有一份等价实现；2026-09-28 规则工坊要加同款下拉时，
 * 如果继续抄第三份，三处迟早分叉（正是本仓「不做第二份真相源」要避免的）。
 *
 * 计数池 = **该发现页的可选源**（`sources` = 已按 kind/启用/发现能力过滤后的池），
 * 否则会出现「下拉里有这个分组、选中却 0 条」。
 */
/**
 * `#280` **分组计数按类型下钻**：选了类型 ⇒ 池子先按类型过滤 ⇒
 * 每组计数 = 「该类型下该分组的命中」，无该类型源的分组自然不进 options。
 * （用户原话：「若类型筛选有选择，则计数应为该类型下，该分组的命中；
 * 如果该分组无此类型源，则过滤该分组，不显示」。）
 */
const groupPool = computed(() =>
  st.discSourceType ? sources.value.filter((s) => st.typeOf(s) === st.discSourceType) : sources.value,
);
const groupOptions = computed(() => sourceGroupOptions(groupPool.value, { includeUngrouped: true }));
const srcGroup = computed({
  get: () => b.value.srcGroup,
  set: (v: string) => { b.value.srcGroup = v; },
});
/** 选完分组：列表内容变了（行数/位置都可能变）→ 把已选中的源重新调进可视区 */
function onSrcGroupChange(): void {
  void nextTick(() => ensureSelectedVisible());
}

const filteredSources = computed(() => {
  let list = sources.value;
  // `#237` 源类型筛选（界面在分组筛选**上方**）—— 先类型后分组，顺序与界面一致
  if (st.discSourceType) list = list.filter((s) => st.typeOf(s) === st.discSourceType);
  if (srcGroup.value) list = list.filter((s) => matchSourceGroup(s, srcGroup.value));
  // `#280` 筛选框字段口径 = 名称/URL/注释/分组（唯一实现见 utils/source-query.ts）
  list = list.filter((s) => matchSourceQuery(s, listQuery.value));
  /**
   * `#166`：按**上游语义**排序 —— `BookSourceDao` 的每一条查询都是 `order by customOrder asc`
   * （`BookSourceDao.kt:27-101`）。「置顶」就是把某一个源的 `customOrder` 调小。
   *
   * ⚠️ 此前这里**不排序**（直接用服务端给的顺序）⇒ 置顶改了 `customOrder` 而这个列表纹丝不动，
   * 表现为「点了置顶没反应」。`Array.prototype.sort` 在现代引擎里是**稳定**的，
   * 所以同为 `customOrder: 0` 的源之间仍保持服务端给的相对顺序（不会打乱原有观感）。
   */
  return list.slice().sort((a, b) => (a.customOrder ?? 0) - (b.customOrder ?? 0));
});
const isRss = computed(() => kind.value === 'rss');
/** 空库引导里的页名（书院 / 影院 / RSS 订阅），与侧栏口径一致 */
const pageName = computed(() => (isRss.value ? 'RSS 订阅' : kind.value === 'maccms' ? '影院' : '书院'));
/**
 * `#359` **报错的可操作提示**（只加文案，**不改判据、不改引擎行为**）。
 *
 * 判据：聚合类源（qyyuapi 系）的 `Get(e)` = `JSON.parse(source.getVariable())[e]`
 * ⇒ 源变量为空时 `JSON.parse('')` 抛 `Unexpected end of JSON input`，用户只看到
 * 一句 JSON 报错，完全不知道该去哪配。这里把「去哪儿配」补上。
 *
 * ★ 只在**展示层**补 —— 引擎该抛还是抛（空变量本来就是「没配置」，不是解析缺陷）。
 */
const errHint = computed(() => {
  const e = String(b.value.err ?? '');
  if (!e) return '';
  if (/Unexpected end of JSON input|JSON\.parse|Unexpected token/i.test(e)) {
    return '这类报错通常是「源变量为空」：源脚本在做 JSON.parse(source.getVariable())，而该源还没配置变量 —— 到「源管理 → ⋯更多 → ⚙ 源变量…」填一个 JSON（键名由源作者规定，一般写在变量说明里）。';
  }
  return '';
});

/**
 * 源列表滚动位置**按发现页各自记住**。
 *
 * ⚠️ 2026-09-26 修（用户实测 ①-2：「从别处切回书院/影院，已选中的源不在可视区，要重新滚动找」）：
 * 左栏 `.src-list` 是**同一个 DOM 元素**，但切换 kind 时 `v-for` 的子节点几乎全换（key = 源 id）
 * ⇒ `scrollHeight` 变成新列表的高度 ⇒ 浏览器**把 scrollTop 钳小**
 * （影院 51 条 vs 书院 433 条，钳得最狠）。切回来时 scrollTop 停在钳后的值，观感像
 * 「列表刷新/重载了、位置丢了」。
 *
 * ★ 事实上**列表数据并没有重载**：源集合是 `computed`，只有 `st.sources` 真正变化
 * （导入新源 / 删除源 / 禁用发现等）才会变。丢的只是**滚动位置**，所以这里只补回位置。
 */
const srcListEl = ref<HTMLElement | null>(null);
const srcScrollTops = new Map<string, number>();
let lastKind = kind.value;
/** 把「已选中的源」调进可视区（最小滚动：已在视区内则完全不动） */
function ensureSelectedVisible(): void {
  const el = srcListEl.value;
  if (!el) return;
  const row = el.querySelector<HTMLElement>('.src-row.on');
  if (!row) return;
  const lr = el.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (rr.top < lr.top) el.scrollTop -= lr.top - rr.top;
  else if (rr.bottom > lr.bottom) el.scrollTop += rr.bottom - lr.bottom;
}
watch(
  () => kind.value,
  async (k) => {
    // flush:'pre' → 此刻 DOM 还是旧列表，读到的才是**离开时**的真实滚动位置
    const el = srcListEl.value;
    if (el) srcScrollTops.set(lastKind, el.scrollTop);
    lastKind = k;
    await nextTick();
    const el2 = srcListEl.value;
    if (!el2) return;
    const saved = srcScrollTops.get(k);
    if (saved === undefined) {
      // **首次进入这一页**（第一次切过来）：把已选中的源滚进可视区
      ensureSelectedVisible();
      srcScrollTops.set(k, el2.scrollTop);
    } else {
      // 来过就**原样还原**用户的浏览位置（他可能就是滚到某处看别的源，不该被顶走）
      el2.scrollTop = saved;
    }
  },
  { flush: 'pre' },
);

/**
 * 点左栏某个源。
 *
 * `#335` **网页型订阅源（`singleUrl === true`）不进「分类 → 卡片」这条链** ——
 * 它的内容就是**一张网页**（上游 WebView `loadUrl`），本仓那条链会在正文处撞
 * `UNSUPPORTED`（无内嵌正文且 `ruleContent` 空）⇒ 用户看到报错而不是网页。
 *
 * `#371`（2026-10-09，修正用户报障「该类型源目前是点击直达阅读页」）：点击源行
 * **只选中**，右侧区域重置为一张「打开网页」卡片；**点卡片**才打开阅读页 ——
 * 与普通源「点源行 → 出卡片 → 点卡片」的节奏一致（见 `resetToWebOnlyCard` 头注）。
 *
 * ★ 判据走 `utils/source-gate.ts` 的 `isWebViewOnly`（唯一实现，与服务端
 *   `source-caps.ts` / 引擎 `singleUrlOnly` 同一条），这里不另写一份。
 */
function pickSource(id: string) {
  const s = disc.sourcesOf(kind.value).find((x) => x.id === id);
  /**
   * `#362`：**先切源，再决定要不要走网页分支**。
   *
   * 旧实现在「网页型订阅源」分支里直接 `return` ⇒ `sourceId` 从未被写入
   * ⇒ ① 左侧源列表不高亮/不定位到该源（用户看不到自己点的是哪个源）；
   * ② 更硬的后果：**该源的「登录」按钮永远不出现** —— 工具栏那颗是
   * `v-if="b.sourceId && loginPlan.kind !== 'none'"`，`b.sourceId` 空 ⇒ 连入口都没有。
   * 实测源：XH发布页（带登录）/ 阅读·全版本汇总 / 源仓库(官方纯净)。
   */
  const changed = b.value.sourceId !== id;
  if (changed) disc.bucket(kind.value).sourceId = id;
  /**
   * `#404` **RSS 启动页**：源配了 `startHtml` ⇒ 先取启动页；非空则**替换**列表
   * （上游 `RssFragment.openRss:198-211`），空/失败回落常规分类列表。
   */
  if (s && s.hasStartPage) {
    void disc.loadStartPage(kind.value, id, String(s.url ?? '').trim()).then((shown) => {
      if (!shown) disc.onSourceChange(kind.value);
    });
    void refreshLoginPlan();
    return;
  }
  if (s && isWebViewOnly(s)) {
    const url = String(s.url ?? '').trim();
    if (url) {
      // `#371`：右侧重置 + 单卡片（形状与普通卡片一致，点击由 openDetail 的 `#356` 分支
      // 接住 → `reader.openWeb`）。打开逻辑不写在这里 —— 卡片自己会开。
      disc.resetToWebOnlyCard(kind.value, {
        title: String(s.name ?? '打开网页'),
        payload: { link: url },
      });
      // 网页型源**不拉分类**（`onSourceChange` 只会撞 UNSUPPORTED）——但登录计划挂在
      // `watch(sourceId)` 上，兜底路径不走它 ⇒ 这里显式刷一次（「登录按钮能点」的前提）。
      void refreshLoginPlan();
      return;
    }
    // 源地址拿不到（老 bundle）⇒ 退回原链路，不让入口凭空消失
  }
  if (!changed) return;
  disc.onSourceChange(kind.value);
}
function onPickCat(opt: CatOption) {
  const g = primaryGroup.value;
  // 分组标题**不在 `CatOption` 里** —— 2026-09-23 重构后分组标题归 `CatToolbar`（`ToolbarOption`），
  // 分类条只收 url 型子分类（见 `CategoryScroller.vue` 头注）。所以这里只需判「有没有分组上下文」。
  if (!g) return;
  if (!opt.value) return;
  // 再点一次已选中的分类 = 取消筛选回「全部内容」（替代原先注入的「全部」chip）
  const isSame = b.value.active?.key === g.key && b.value.active?.value === opt.value;
  if (isSame) {
    disc.bucket(kind.value).active = null;
    void disc.load(kind.value);
    return;
  }
  disc.selectExplore(kind.value, g.key, opt.value);
}
/** 是否存在交互型分类（select/toggle/text/button）——组件区是否显示控件与重算按钮 */
const hasInteractive = computed(() => toolbarInteractives.value.length > 0);
/** 组件区是否有内容（控件 or 分组选择器）；都没有就不渲染那一行 */
const hasToolbar = computed(() => hasInteractive.value || hasGroups.value);
/** 交互输入变更（Legado infoMap 写回 → 执行控件 action → 重算分类） */
function onCatInput(p: { name: string; value: string; action?: string }) {
  disc.setInput(kind.value, p.name, p.value, p.action);
}
/**
 * button 动作（Legado ExploreKind.action）：
 *  - `java.searchBook(...)` → 用同组 text 控件的输入跳转跨源搜索
 *  - `java.open('login', …)` → 走源登录（服务端可跑的直接执行；需浏览器时给提示）
 *  - 其他（如 `java.refreshExplore()`）→ 重算分类（并把 action 交给引擎执行以便写 infoMap）
 */
async function onCatAction(c: ToolbarOption) {
  const action = c.action ?? '';
  if (/searchBook/.test(action)) {
    /**
     * `#510-①` **关键词的权威来源 = action 自己声明的那个 infoMap 键**。
     *
     * 实测源（七猫 3.9.61）的按钮 action 是：
     *   `java.searchBook(infoMap['☃关键词:书名/作者🔖'] || '', \`${source.bookSourceName}::${source.getKey()}\`)`
     * ⇒ Legado 的惯例是「action 里显式引用哪个控件，就用哪个控件的值」。旧实现
     * `Object.values(inputs).find(有值)` 取「任意一个有值的 input」，于是同组下拉（select）/
     * 开关（toggle）的当前项（用户看到的「不选」）被当成关键词搜了出去。
     *
     * 兜底顺序：action 显式引用的 infoMap 键 → 同组第一个有值的 **text** 控件 → 不跳转。
     */
    const keyRefs = [...action.matchAll(/infoMap\[\s*['"]([^'"]+)['"]\s*\]/g)].map((m) => m[1] as string);
    const fromAction = keyRefs.map((k) => (b.value.inputs[k] ?? '').trim()).find((v) => v) ?? '';
    const textNames = toolbarInteractives.value
      .filter((o) => o.kind === 'text')
      .map((o) => o.rawLabel ?? o.label);
    const kw = fromAction || textNames.map((n) => (b.value.inputs[n] ?? '').trim()).find((v) => v) || '';
    if (kw) {
      /**
       * `#510-②` **是否只搜当前源，由 action 的第二参决定**（Legado `java.searchBook(key, sourceKey)`）：
       *  - 带 `source.getKey()`（`'源名::key'`）⇒ 用户语义是「只在这个源里搜」；
       *  - 只有 `searchBook(key)` ⇒ Legado 语义是**跨源搜索**，不该收窄。
       * 旧实现两种情况都只传 `q` ⇒ 前者的「单源」被放大成全库扫描（用户实测：对全部候选源发起）。
       */
      const onlyThisSource = /getKey\s*\(\s*\)/.test(action);
      void router.push({
        name: 'search',
        query: onlyThisSource ? { q: kw, source: b.value.sourceId } : { q: kw },
      });
      return;
    }
  }
  // Legado 惯例：发现页里的「⚙登录」按钮 action 是 java.open('login', …) → 打开登录对话框
  if (/java\.open\s*\(\s*['"]login['"]/.test(action) || /^login\s*\(\s*\)$/.test(action.trim())) {
    openLogin();
    return;
  }
  await disc.load(kind.value, action);
}

/**
 * 源登录（对齐 Legado 登录对话框）：
 *  - 按钮只在「源配了 loginUrl / loginUi」时出现（方案来自 GET /api/sources/:id/login）；
 *  - 点击打开对话框：表单填写 / 按钮动作 / 打开登录页 / 清除登录，全在对话框里完成。
 */
const loginOpen = ref(false);
/** 点「登录」时是否自动开登录窗口（url/config-url 型源：用户就是要「打开登录页」） */
const loginAutoWindow = ref(false);
const loginPlan = ref<{ kind?: string; hasCookie?: boolean; hasLoginInfo?: boolean; cookieCount?: number }>({});
const loginBadge = computed(() => {
  const p = loginPlan.value;
  if (p.hasLoginInfo) return '已登录';
  if (p.hasCookie || p.cookieCount) return '已登录';
  return '登录';
});

async function refreshLoginPlan(): Promise<void> {
  const id = b.value.sourceId;
  if (!id) {
    loginPlan.value = {};
    return;
  }
  try {
    loginPlan.value = (await (await fetch(`/api/sources/${id}/login`)).json()) as typeof loginPlan.value;
  } catch {
    loginPlan.value = {};
  }
}
watch(() => b.value.sourceId, () => void refreshLoginPlan(), { immediate: true });

/**
 * `#354` 登录对话框有动作完成后的回调（`SourceLoginDialog` 的 `changed`）：
 *  · 先刷新登录标记（原行为）；
 *  · **再重算当前源的发现分类** —— 「登录页选线路」这类源（禁漫天堂 `loginUi` 的
 *    「切换国际线路 / 东南亚线路 / 切换分流」按钮）只改**源变量**（base url + shunt），
 *    `exploreUrl` 脚本据此产出**另一套分类**（含线路名文案）。不重算的话，用户按提示
 *    「返回刷新分类」时看到的还是旧线路的分类——按钮点了、提示也弹了，但界面没变。
 *
 *  `reloadCategories` 正好是「保留交互输入态、重跑 exploreUrl 脚本」的语义
 *  （Legado `java.refreshExplore()`），与「换源重置」不同，这里不需要清输入态。
 */
async function onLoginChanged(): Promise<void> {
  await refreshLoginPlan();
  void disc.reloadCategories(kind.value);
}

/**
 * `#371` 右栏「↻ 刷新」按钮的守门：当前选中的是网页型订阅源（`isWebViewOnly`）时，
 * 右侧只有 `resetToWebOnlyCard` 放的那张单卡片 —— 没有「分类 → 卡片」链可重拉，
 * `refreshContent` 只会撞 `UNSUPPORTED`（把单卡片冲掉、弹一条错误）⇒ 直接忽略。
 */
function onRefreshContent(): void {
  const s = disc.sourcesOf(kind.value).find((x) => x.id === b.value.sourceId);
  if (s && isWebViewOnly(s)) return;
  void disc.refreshContent(kind.value);
}

function openLogin(): void {
  if (!b.value.sourceId) return;
  // 「只填了网站域名/登录页链接」的源：点登录就打开网站做人工登录或安全验证
  loginAutoWindow.value = loginPlan.value.kind === 'url' || loginPlan.value.kind === 'config-url';
  loginOpen.value = true;
}

function hostOf(id: string): string {  try {
    return new URL(id).host;
  } catch {
    return id.slice(0, 28);
  }
}
function avatarChar(name: string): string {
  return (name || '?').trim().charAt(0).toUpperCase();
}
function avatarClass(i: number): string {
  return 'av' + (i % 6);
}
/**
 * `#307` **源图标**（用户口径）：「legado 订阅源有 `sourceIcon` 项，如果设置了，应加载该地址
 * 指向图标；加载失败，或未设置：按我们目前的形式（首字母头像）」。
 *
 * 三态都在这里收口：`icon` 为空 / 曾经加载失败 ⇒ 返回空串 ⇒ 模板走首字母头像。
 * 失败态要**记下来**（否则每次重渲染都会再打一次坏 URL，控制台刷满 404）。
 */
const iconFailed = ref<Set<string>>(new Set());
function onIconError(id: string): void {
  const next = new Set(iconFailed.value);
  next.add(id);
  iconFailed.value = next;
}
function srcIcon(s: { id: string; icon?: string }): string {
  const url = String(s.icon ?? '').trim();
  return url && !iconFailed.value.has(s.id) ? url : '';
}
function syncTime(): string {
  if (!b.value.loadedAt) return '—';
  const d = new Date(b.value.loadedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
/**
 * 点卡片。
 *
 * `#335` **订阅源没有「详情页」这个中间态**（用户原话）：上游 `ReadRssActivity` 点文章
 * 就是**直接进正文**。所以 RSS 卡片一律走「直达阅读页」（`readFirst`），
 * 而不是先铺一个只有一章的详情页再让用户再点一次。
 *
 * 网页型订阅源（`singleUrl`）更彻底：卡片本身就是那张网页 ⇒ 直接按 URL 取页渲染。
 */
function openDetail(it: Record<string, unknown>) {
  /**
   * ★★ `#356` **订阅源分支必须排在最前**（2026-10-08，用户第三次提同一个现象）。
   *
   * 旧代码先判 `it.kind === 'video'` ⇒ RSS 里那些 `kind` 带 video 的卡片（影视类订阅源）
   * 被**截走**进影视详情（书院/影院的两跳语义），于是用户看到的还是
   * 「卡片 → 详情页 → 阅读页」。而 `#335` 的结论是**订阅源没有「详情页」这个中间态**
   * （上游 `ReadRssActivity` 点文章就是直接进正文）⇒ 判据顺序本身就是缺陷，不是源的问题。
   */
  if (isRss.value) {
    const link = String((it.payload as { link?: string } | undefined)?.link ?? '');
    const src = disc.sourcesOf(kind.value).find((x) => x.id === b.value.sourceId);
    if (src && isWebViewOnly(src) && /^https?:\/\//i.test(link)) {
      void reader.openWeb(b.value.sourceId, link, String(it.title ?? src.name ?? link));
      return;
    }
    // `#344`：卡片点击**直达阅读页**（跳过详情页过渡）—— RSS 源不该走「卡片→详情→阅读」两跳
    void reader.readFirstDirect(b.value.sourceId, it);
    return;
  }
  if (String(it.kind) === 'video') {
    vod.openDetail({ sourceId: b.value.sourceId, payload: it.payload ?? {}, title: String(it.title ?? ''), cover: it.cover ? String(it.cover) : undefined });
    return;
  }
  reader.openDetail(b.value.sourceId, it);
}
function readFirst(it: Record<string, unknown>) {
  // `#356`：与 `openDetail` 同一条纪律 —— 订阅源一律直达，不经过详情页
  if (isRss.value) {
    void reader.readFirstDirect(b.value.sourceId, it);
    return;
  }
  if (String(it.kind) === 'video') {
    openDetail(it);
    return;
  }
  void reader.readFirst(b.value.sourceId, it);
}
function metaLine(it: Record<string, unknown>): string {
  return [it.subtitle, it.tags && Array.isArray(it.tags) ? (it.tags as string[]).join(' ') : '']
    .filter(Boolean)
    .join(' · ');
}
/**
 * 卡片下方信息（用户口径：**①书名 ②作者 ③最新章节 + 其他信息**）。
 *
 * | | ① | ② | ③ |
 * |---|---|---|---|
 * | 书籍 | `title` | **作者** `payload.author` | **最新章节** `payload.lastChapter` + 其他信息 `tags` |
 * | 影视 | `title` | **分类**（`tags`，CMS 的 `vod_class`） | **最新集**（`subtitle`，CMS 的 `vod_remarks`） |
 *
 * ⚠️ 2026-09-27 修「作者位串位」：② 原来取 `subtitle`，而契约里
 * `subtitle = 作者 || 更新至`（见引擎 list 阶段）——源没给作者时，**最新章节会被填进作者位**，
 * 而 ③ 又因为「与 ② 重复就不显示」把它吞掉 ⇒ 两行都错位。改成取**显式字段**：
 * ② = `payload.author`、③ = `payload.lastChapter`（两个字段引擎都按 Legado `BookList.kt`
 * 逐条求值并随 payload 带走，出处见 popup 注释）。
 *
 * ⚠️ 字段为空就**留空**，不编造：语料里确有这样的源 —— 例如 ⚡📂绿柠小说 的
 * `ruleExplore` 写的是 `authorname`/`tag`，而站点现在的 `getcategorydetailinfo.do`
 * 返回的是 `author`/`tags`（**源规则字段名过期**，Legado 同样取不到）；
 * ⚡📂星空小说 的「男频推荐榜」接口**根本不返回作者**。这两类只能由源侧修。
 * 原来的 ③「原名称（书源名）」按用户要求已去掉，不再拿源名凑满行数。
 */
function latestChapterOf(it: Record<string, unknown>): string {
  return itemLastChapter(it);
}
/** 作者：引擎在列表阶段写入 `payload.author`（取自 `ruleExplore/ruleSearch.author`） */
const authorOf = itemAuthor;
function cardLine2(it: Record<string, unknown>): string {
  const tags = Array.isArray(it.tags) ? (it.tags as string[]).join(' · ') : '';
  if (String(it.kind) === 'video') return tags;           // 影视 ②：分类
  const author = authorOf(it);
  if (author) return author;
  // 源没给 author：`subtitle` 还可能是「备注」；但若它就是最新章节本身，留给 ③ 显示
  const sub = it.subtitle ? String(it.subtitle).trim() : '';
  return sub && sub !== latestChapterOf(it) ? sub : '';
}
function cardLine3(it: Record<string, unknown>): string {
  const tags = Array.isArray(it.tags) ? (it.tags as string[]).join(' · ') : '';
  const subtitle = it.subtitle ? String(it.subtitle).trim() : '';
  if (String(it.kind) === 'video') return subtitle;       // 影视 ③：最新集
  const last = latestChapterOf(it);
  // 书籍 ③：最新章节 + 其他信息（`tags` = 源 `kind` 规则给出的题材/状态等）
  return [last ? `最新：${last}` : '', tags].filter(Boolean).join(' · ');
}

/** 触底检测：内容滚动容器（.content-scroll）距底 500px 内触发下一页 */
function nearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 500;
}
function onScroll() {
  const el = contentScroll.value;
  if (el && nearBottom(el)) void loadNext();
}

/**
 * **触底翻页**（哨兵 IO 与 scroll 事件都走它）。
 *
 * ⚠️ 2026-09-24 修（用户实测：**滚动到底不自动加载，必须手点「加载下一页」**）：
 * 此前 IO 回调与 `onScroll` 都接到 `fillViewport()`，而它**第一句**就是
 * `if (el.scrollHeight > el.clientHeight + 50) break;`（已有滚动条就放弃）
 * ⇒ 只有「内容不足一屏」才会触发加载，**一旦出现滚动条就永远不翻页**。
 *
 * 对齐 OmniFlow `views/Discovery/AcademyView.vue:553`：哨兵**直接调 `loadNextPage()`** ——
 * 「首屏铺满」（`fillViewport`）与「触底翻页」（本函数）是**两条独立路径，不能合并**。
 */
let loadingNext = false;
async function loadNext(): Promise<void> {
  const b = disc.bucket(kind.value);
  if (loadingNext || b.loading || b.loadingMore || !b.hasMore || !b.items.length) return;
  loadingNext = true;
  try {
    await disc.loadMore(kind.value);
  } finally {
    loadingNext = false;
  }
}

/** 内容不足一屏时自动续载下一页直到铺满（或没有下一页）；上限 6 页防失控。
 *  解决「第 1 页只有 10 项 → 没有滚动条 → 永远不触发触底加载」的问题。 */
let filling = false;
async function fillViewport() {
  if (filling) return;
  filling = true;
  try {
    for (let guard = 0; guard < 6; guard++) {
      const el = contentScroll.value;
      const b = disc.bucket(kind.value);
      if (!el || !b.hasMore || b.loading || b.loadingMore) break;
      if (el.scrollHeight > el.clientHeight + 50) break; // 已有滚动条，交给用户滚动
      const before = b.items.length;
      await disc.loadMore(kind.value);
      const after = disc.bucket(kind.value).items.length;
      if (after === before) break; // 没有新增（护栏已把 hasMore 置 false）
    }
  } finally {
    filling = false;
  }
}
/** 触底哨兵（内容区末尾，IntersectionObserver 观测） */
const sentinel = ref<HTMLElement | null>(null);
/** 内容滚动容器（独立滚动，IO root 指向它） */
const contentScroll = ref<HTMLElement | null>(null);
/** `#444` 启动页沙箱 iframe —— 只认它的报文（`onStartJavaMessage` 的来源过滤） */
const startFrame = ref<HTMLIFrameElement | null>(null);
let boundScroll: HTMLElement | null = null;
let observer: IntersectionObserver | null = null;

onMounted(async () => {
  // 「点外面收起分组下拉」的监听随组件走了（SourceGroupFilter 自己管生命周期）
  await st.loadMeta();
  // `#307`：RSS 此前**被排除**在自动加载之外（`#156` 时引擎还没实现）—— 结果是进这一页
  // 左栏空着、也不自动选源，用户得手点一个源才动。引擎已有「分类 + 列表」能力 ⇒ 同一条 ensureLoaded。
  disc.ensureLoaded(kind.value);
  // 首屏：把已选中的源滚进可视区（源列表按 id 排序靠后时尤其明显），并把结果记为初始位置
  await nextTick();
  ensureSelectedVisible();
  srcScrollTops.set(kind.value, srcListEl.value?.scrollTop ?? 0);
  // 内容滚动容器：scroll 事件 + IO 哨兵双保险（IO root 必须是滚动容器本身，
  // 否则内容滚出容器底后对 viewport「不可见」，哨兵永不触发——上一版踩过）
  boundScroll = contentScroll.value;
  boundScroll?.addEventListener('scroll', onScroll, { passive: true });
  observer = new IntersectionObserver((entries) => {
    // `intersectionRatio > 0.05` + threshold：对齐 OmniFlow:555，避免「刚露出一像素」就狂触发
    if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.05)) void loadNext();
  }, { root: contentScroll.value ?? null, rootMargin: '600px 0px', threshold: [0.05, 0.2] });
  if (sentinel.value) observer.observe(sentinel.value);
  // `#404` 启动页 java 桥（srcdoc iframe 的 postMessage）
  window.addEventListener('message', onStartJavaMessage);
});
onBeforeUnmount(() => {
  boundScroll?.removeEventListener('scroll', onScroll);
  observer?.disconnect();
  window.removeEventListener('message', onStartJavaMessage);
});
watch(sentinel, (el) => {
  // 先 disconnect 再 observe：哨兵随 `v-if="b.items.length"` 重建，避免旧元素仍被观察
  // （对齐 OmniFlow:561 的同一处理）
  observer?.disconnect();
  if (observer && el) observer.observe(el);
}, { flush: 'post' });
watch(kind, () => {
  // `#307`：RSS 此前**被排除**在自动加载之外（`#156` 时引擎还没实现）—— 结果是进这一页
  // 左栏空着、也不自动选源，用户得手点一个源才动。引擎已有「分类 + 列表」能力 ⇒ 同一条 ensureLoaded。
  disc.ensureLoaded(kind.value);
});
/**
 * **换源 / 换分类 → 滚动条回顶**（用户实测 2026-09-24：切分类后卡片重新加载了，
 * 但 `.content-scroll` 的 `scrollTop` 仍停在底部，看起来像没换内容）。
 *
 * 为什么必须显式做：内容区是**独立滚动容器**（`overflow-y: auto`），内容清空再填充
 * **不会**让它自动归零（只有 window 级滚动才会）。
 *
 * 触发面只取「源 id + 分类（active）」：**翻页**（append 不换 active）与
 * **同分类刷新内容**都不会命中，避免把用户读到一半的位置顶掉。
 */
watch(
  () => {
    const b = disc.bucket(kind.value);
    return `${b.sourceId}|${b.active?.key ?? ''}|${b.active?.value ?? ''}`;
  },
  () => {
    const el = contentScroll.value;
    if (el) el.scrollTop = 0;
  },
  { flush: 'post' },
);
// 首屏/切源/切分类/刷新内容后：若没铺满视窗自动续载
watch(
  () => {
    const b = disc.bucket(kind.value);
    return [b.items.length, b.hasMore, b.loading] as const;
  },
  () => void fillViewport(),
);
</script>

<template>
  <div class="disc-page">
    <!-- 左栏 -->
    <div class="card left-panel">
      <div class="lp-title">{{ pageTitle }}</div>

      <!--
        `#304`（2026-10-07）：RSS 引擎已实现 ⇒ 这块**从「引擎未实现」改成「还没导入订阅源」的引导**。
        为什么还要留一块提示：RSS 源**不在随包分发的源工作集里**（发布模式不带任何源，用户自导），
        新用户进这一页左栏必然是空的 —— 不说明会被当成「加载失败 / 导入没生效」。
        只在**真的一个 RSS 源都没有**时显示（有源就不占地方）。
      -->
      <div v-if="kind === 'rss' && sources.length === 0" class="rss-note">
        <b>ⓘ 还没有 RSS 订阅源</b>
        <span>RSS 引擎已支持（列表规则 / 正文规则 / 分页）。请到<b>源管理</b>导入订阅源 JSON，
          或新建订阅源 —— 导入成功后这里就会出现。</span>
      </div>

      <!-- `#237` 源类型筛选 —— 放在**分组筛选上方**（用户 2026-10-03 的要求）。
           计数口径 = 「当前 kind 下的全部源」，与下面分组的 `all-count` 同源，
           避免出现「下拉里某类型 0 条」的项。

           ★ `#239` **只在书院（legado）出现**，影院（maccms）不出现（用户 2026-10-03：
           「影院发现页移除类型筛选，该发现页默认都是视频」）。
           理由不是「懒得做」而是**恒等筛选**：服务端 `sourceTypeOf` 对 maccms 引擎
           **硬返回 `'video'`**（`index.ts` 的 `if (engineKind === 'maccms') return 'video'`）——
           那一栏只可能有一个选项有数字，其余恒 0 ⇒ 是个纯粹的无效控件。
           同时切到影院时必须**清掉**已选类型（`watch`），否则会带着书院的「图片」
           进来，把影院列表筛成 0 条 —— 正是本仓反复出现的那类「换了页面就 0 条」。 -->
      <!-- `#280` 源类型筛选改统一组件 FilterDropdown（原原生 select 的系统弹层与其他下拉两副面孔）。
           ★ 只在书院（legado）出现，影院（maccms）不出现（服务端 `sourceTypeOf` 对 maccms 恒返回
           'video'，那一栏是恒等筛选；切到影院时 store 会清掉已选类型，见 `discKind` watch）。 -->
      <div v-if="kind === 'legado'" class="src-type-filter">
        <FilterDropdown
          v-model="st.discSourceType"
          :options="discTypeOpts"
          label="类型"
          empty-text="该引擎下暂无类型"
          full
        />
      </div>

      <!-- 源分组筛选（下拉式分组筛选；组件与规则工坊/源管理/搜索页共用）。
           `#280` all-count 用 groupPool（类型下钻后的池子），「全部分组」计数与实际列表一致 -->
      <SourceGroupFilter
        v-model="srcGroup"
        :options="groupOptions"
        :all-count="groupPool.length"
        :shown-count="filteredSources.length"
        :label="kindLabel"
        empty-text="该类型暂无分组"
        @change="onSrcGroupChange"
      />

      <input v-model="listQuery" class="disc-search src-filter" :placeholder="SOURCE_QUERY_PLACEHOLDER" />

      <!-- 分类同步按钮 -->
      <!-- `#655` 显式「刷新分类」必须**连引擎的分类缓存一起重探**（`refreshCats`）：
           只传 force 只是清前端快照，引擎那层 `cms:cats:<源>`（7 天）还在 ⇒ 点完还是老分类。 -->
      <button class="cat-sync" :disabled="b.loading || !b.sourceId" title="重新拉取分类（含 JS 动态分类与站点侧改动），并清除当前分类筛选" @click="disc.onSourceChange(kind, { refreshCats: true })">
        <span v-if="b.loading">⟳ 刷新分类中…</span>
        <span v-else>↻ 刷新分类（{{ b.filters[0]?.options.length ?? 0 }}）</span>
      </button>

      <!-- 源列表 -->
      <div ref="srcListEl" class="src-list">
        <div
          v-for="(s, i) in filteredSources" :key="s.id"
          class="src-row" :class="{ on: s.id === b.sourceId }"
          :title="s.id"
          @click="pickSource(s.id)"
        >
          <!-- `#307` 源图标：设了 sourceIcon 就加载它；为空 / 加载失败 ⇒ 首字母头像（用户口径） -->
          <img
            v-if="srcIcon(s)"
            class="avatar avatar-img"
            :src="srcIcon(s)"
            :alt="s.name || s.id"
            loading="lazy"
            @error="onIconError(s.id)"
          />
          <span v-else class="avatar" :class="avatarClass(i)">{{ avatarChar(s.name || s.id) }}</span>
          <div class="row-main">
            <div class="nm">
              {{ s.name || s.id }}
              <span v-if="!s.state.enabled" class="tag red">停</span>
            </div>
            <div class="host">{{ hostOf(s.id) }}</div>
          </div>
          <!-- `#166` 置顶（改上游 `customOrder`）；`#236` 换成组件：
               图标随「是否已置顶」变化（顶端加横线），再次点击 = 取消置顶排回原位。
               `#238`：可同时置顶多个，最后置顶的排最顶。 -->
          <SourcePinButton :id="s.id" @toggle="(id) => st.togglePin(id)" />
          <span class="cnt">{{ s.kind === 'maccms' ? 'CMS' : '源' }}</span>
        </div>
        <!-- 空库引导（`#885`）：左栏窄，竖排小字号；只有「整个源库为空」才出，
             有源只是筛选不匹配时仍走下面那句「没有匹配的源」。 -->
        <div v-if="st.loaded && !st.realSources.length" class="empty empty-guide" data-disc-empty-guide>
          <div class="eg-t">还没有任何源</div>
          <p class="eg-p">
            这是空库（<code>yuedu.db</code> 已自动创建）。{{ pageName }}要有源才能发现内容，
            请先到「源管理」导入或新建。
          </p>
          <p class="eg-warn">只导入你所在地区法律与目标站点条款允许使用的源；本站不提供任何源。</p>
          <button class="btn mini" @click="router.push('/source-mgr')">去源管理 →</button>
        </div>
        <div v-else-if="!filteredSources.length" class="empty">
          {{ isRss ? '暂无 RSS 源 —— 去源管理导入订阅源 JSON' : '没有匹配的源，去源管理导入' }}
        </div>
      </div>
    </div>

    <!-- 右栏（`card` = 圆角外边框，与书架右栏 `.bs-main` 同一口径；内边距也逐值对齐 14/16） -->
    <div class="right-col card">
      <div class="right-head">
        <h3>{{ (st.sources.find((s) => s.id === b.sourceId)?.name) || '选择左侧源开始' }}</h3>
        <!-- 登录按钮：放在源名称标签后、分类条上方（仅当该源配了 loginUrl/loginUi） -->
        <button
          v-if="b.sourceId && loginPlan.kind && loginPlan.kind !== 'none'"
          class="btn sm login-btn"
          :class="{ acc: loginBadge === '已登录' }"
          :title="'登录形态：' + loginPlan.kind"
          @click="openLogin"
        >
          {{ loginBadge === '已登录' ? '已登录' : '登录' }}
        </button>
        <!-- `#287` 搜索按钮：弹起搜索浮层（范围 = 当前选中的源；卡片与发现页同款）。
             `#293`（用户 2026-10-05）：**只有具备搜索规则的源**才显示 —— 与左边「登录」按钮
             同一套门控逻辑（有登录规则才有登录按钮）。没有搜索规则的源点了也没结果，入口不该出现。 -->
        <button
          v-if="b.sourceId && curHasSearch"
          class="btn sm"
          title="搜索这个源（弹层，结果为发现页同款封面卡片）"
          @click="searchOpen = true"
        >⌕ 搜索</button>
        <SourceSearchDialog
          :open="searchOpen"
          :scope-ids="b.sourceId ? [b.sourceId] : []"
          :scope-label="b.sourceId ? '源：' + ((st.sources.find((s) => s.id === b.sourceId)?.name) || b.sourceId) : ''"
          @close="searchOpen = false"
        />
      </div>

      <!-- 分区线：标题区 → 组件区（用户 2026-11-08；与书架 `.bs-sep` 同一视觉口径） -->
      <div class="right-sep"></div>

      <!-- ① 功能组件区：交互控件（select/toggle/text/button）+ 纯标题型分组标题提升成的分组选择器。
           分工见 CatToolbar 头注：组件区负责「切换」，分类条负责「显示当前分组的子分类」。 -->
      <CatToolbar
        v-if="hasToolbar"
        :interactives="toolbarInteractives"
        :groups="groupTabs"
        :active-group="activeGroupIdx"
        :inputs="b.inputs"
        :loading="b.loading"
        @input="onCatInput"
        @action="onCatAction"
        @pick-group="pickGroup"
        @recompute="disc.reloadCategories(kind)"
      />
      <!-- 分区线：组件区 → 分类条（没渲染组件区时不留悬空线） -->
      <div v-if="hasToolbar" class="right-sep"></div>

      <!-- ② 分类条：只显示当前分组的 url 型子分类（分组见 catGroups 注释）。
           `#307`：只有一个**无名**分类（= RSS 源没配 sortUrl 的整源场景）时不渲染 —— 对齐上游
           `upFragmentsView` 的 `tabsContainer.gone()`，避免一枚空白 chip。 -->
      <CategoryScroller
        v-if="scrollerCats.length && !soleUnnamedCat"
        :categories="scrollerCats"
        :model-value="scrollerValue"
        :scope-key="b.sourceId + '@' + activeGroupIdx"
        :empty-hint="'该分组暂无分类'"
        :pop-title="hasGroups ? (groupTabs[activeGroupIdx]?.title || '全部') : ''"
        @update:model-value="onPickCat"
      />
      <!-- 仅在「确实没有任何分类」时提示（此前条件写错，会在有分类时渲染出一个空卡片条） -->
      <div v-if="!b.loading && b.sourceId && hasToolbar && !scrollerCats.length" class="cat-scroller-placeholder card">
        <span>该源分组下暂无分类——点组件区「↻ 重算分类」重试或换一个源</span>
      </div>

      <!-- 其余筛选组（普通 chips） -->
      <div v-for="g in restGroups" :key="g.key" class="catbar rest-cats">
        <span class="cat-label">{{ g.key }}</span>
        <div
          v-for="o in g.options"
          :key="o.value || o.name"
          class="cat-chip"
          :class="{ on: b.active && b.active.key === g.key && b.active.value === o.value, 'hd': o.header }"
          @click="o.header || disc.selectExplore(kind, g.key, o.value)"
        >{{ o.name }}</div>
      </div>
      <!-- 分区线：分类条 → 内容区（工具条视作内容区的表头，跟着内容区一起固定） -->
      <div v-if="showCatZone" class="right-sep"></div>

      <!-- 工具条：当前分类 + 计数 + 视图切换 + 刷新 -->
      <div class="toolbar meta-bar" v-if="b.sourceId">
        <button class="cat-chip on">{{ activeCatLabel }}</button>
        <span class="m-cnt">共 {{ b.items.length }} 项 · 同步于 {{ syncTime() }}</span>
        <div class="seg" role="group" aria-label="内容区布局">
          <span :class="{ on: viewMode === 'grid' }" @click="viewMode = 'grid'">▦ 多列</span>
          <span :class="{ on: viewMode === 'list' }" @click="viewMode = 'list'">☰ 列表</span>
          <span :class="{ on: viewMode === 'wide' }" @click="viewMode = 'wide'">▣ 横屏</span>
          <!-- ⚠️ 「瀑布」已按用户 2026-10-01 要求移除（「移除瀑布，保留多列」）。
               它原来只是个 `seg-disabled` 占位、从没实现过 ⇒ 留着假按钮只会让人以为有这功能。
               真要做瀑布（高度不等的卡片按需摆放）再往这里加一项，别「顺手放回来」。 -->
        </div>
        <span style="flex: 1"></span>
        <button class="btn sm" :disabled="b.refreshing || b.loading" title="重新加载当前分类的内容卡片（不动分类栏）" @click="onRefreshContent">{{ b.refreshing ? "⟳ 刷新中…" : "↻ 刷新" }}</button>
      </div>

      <div v-if="b.err" class="card err-text" style="padding: 10px 14px; margin-bottom: 12px">
        <div>{{ b.err }}</div>
        <!-- `#359`：上面对 JSON 解析类报错补的可操作指引（只在展示层，不改判据） -->
        <div v-if="errHint" class="empty-hint" data-err-hint>{{ errHint }}</div>
      </div>

      <!-- 内容滚动区：仅此区域滚动，上方源信息/分类/工具条固定 -->
      <div ref="contentScroll" class="content-scroll">
      <!-- `#404` RSS 启动页（startHtml）：非空时**替换**列表页（上游 RssFragment.openRss:198-211）。
           沙箱 iframe + srcdoc（与正文同一套壳）；`sandbox` 允许脚本（源 startJs 要靠它工作）。
           ⚠️ 只给 `allow-scripts`，不给 `allow-same-origin`（保持 opaque origin，同正文沙箱纪律）。 -->
      <iframe
        v-if="startDoc"
        ref="startFrame"
        class="rss-start-frame"
        :srcdoc="startDoc"
        sandbox="allow-scripts allow-forms allow-popups"
        referrerpolicy="no-referrer"
      ></iframe>
      <!-- 内容区：多列海报 -->
      <div v-else-if="viewMode === 'grid' && b.items.length" class="poster-grid cinema-grid">
        <!-- `#176`：`:key` 必须是**内容身份**而不是数组下标。下标在切分类时两批数据完全相同
             （0,1,2…），Vue 会认为是「同一批节点」⇒ 只更新属性、不重建 DOM ⇒ 封面 `<img>`
             实例被复用，旧图在新图解码完成前一直留着（用户实测「看到之前图片残留」）。
             同款bug 的另一半由 `CoverImage` 的 `loading` 态堵住（不挂 `src` ⇒ 旧图被卸载）。 -->
        <div v-for="(it, i) in b.items" :key="itemIdentity(it)" class="pcard">
          <div class="poster-wrap" @click="openDetail(it)">
            <!-- 封面：`loading="lazy"` + `decoding="async"` + `fetchpriority="low"`。
                 ⚠️ 别把 lazy 当成「首屏就不打了」的银弹 —— 实测首屏 20 张**全部落在
                 Chromium 的懒加载阈值内**，请求数并没有减少（`probe-loadmode-browser.mjs`：
                 「现状 3s 内封面请求 20 个」与「强制 eager 20 个」相同）。它的真实收益是
                 **第二页及以下（无限滚动出来的那批）**：那些卡片远在视口外，不滚到就不拉。
                 真正把「用户点卡片时的排队」解掉的是另外两处：
                   · 服务端：`/api/proxy` 全标 `priority:'low'`（`net-priority.test.ts` 锁住语义）
                   · 浏览器：`fetchpriority="low"` 让封面在**同源 6 连接队列**里让位给 `/api/run`
                 `decoding="async"` 顺带不阻塞主线程解码。 -->
            <!-- `#163`：封面统一走 CoverImage（判空 / 强制默认封面 / 加载失败回落，三件事只在这一处实现）。
                 生成封面自己会画书名/作者 ⇒ 这里不再需要原来的 `.poster.ph` 兜底文字（信息块里有）。
                 ⚠️ 作者**不是** `it.author`：`UnifiedItem`（`packages/core/src/contract/types.ts:92-110`）
                 压根没有 `author` 字段，作者由引擎写在 `payload.author` —— 与下方 `authorOf()` 同一处。
                 传 `it.author` 会永远是空串 ⇒ 默认封面永远画不出作者。 -->
            <CoverImage class="poster" :cover="String(it.cover ?? '')" :source-id="b.sourceId" :title="String(it.title ?? '')" :author="authorOf(it)" :index="i" />
            <!-- ② 详情 / 阅读·播放 浮现在封面区域（对齐书架 / 影视库卡片） -->
            <!-- `#366` RSS 卡片：去掉「详情」按钮（#335 订阅源没有详情页语义），只留「打开」且居中 -->
            <div class="cover-actions" :class="{ solo: isRss }">
              <button v-if="!isRss" class="cover-btn ghost" @click.stop="openDetail(it)">ⓘ 详情</button>
              <button class="cover-btn primary" @click.stop="readFirst(it)">
                ▶ {{ isRss ? '打开' : String(it.kind) === 'video' ? '播放' : '阅读' }}
              </button>
            </div>
          </div>
          <!-- ② 下方信息：①书名 ②作者 ③最新章节+其他信息（影视：①影片名 ②分类 ③最新集）
               ⚠️ **无条件显示**（用户 2026-10-01 纠错：「封面」仅指封面图片本身，不含下方信息）。
               之前这里按 `cardTextHidden()` 隐藏 ①② 两行 ⇒ 「默认封面会画字」时下方就没了信息，
               而用户在意的书名/作者/最新章节恰恰只看这一处。封面上画不画字是**另一件事**，
               由 `CoverImage` 自己按上游 `CoverImageView.onDraw()` 的规则决定。
               `data-tip` 与目录/选集共用同一个全局 Tooltip（HoverTip）—— 只在文字被截断时才弹 -->
          <div class="pc-title" :data-tip="String(it.title ?? '')" @click="openDetail(it)">{{ it.title }}</div>
          <div class="pc-line2" :data-tip="cardLine2(it)">{{ cardLine2(it) }}</div>
          <div class="pc-line3" :data-tip="cardLine3(it)">{{ cardLine3(it) }}</div>
        </div>
      </div>

      <!-- 内容区：列表（`#184`：**列数自适应 1/2/3**，每列内仍是列表卡片样式）
           ⚠️ 为什么不用 CSS `columns`（瀑布式分栏）：`columns` 会把元素**先竖着填满一整列**
             再流到下一列，且**高度很难看齐**（各列底部参差）⇒ 视觉上就是「不均匀的瀑布」，
             而用户要的是「每列按列表样式」—— 也就是**按行铺满、上到下再换列**的规整网格。
             `grid-template-columns: repeat(auto-fill, minmax(Xpx, 1fr))` 正是这个语义。
           ⚠️ `minmax` 的下限是**卡片最小可用宽**（84px 封面 + 文字 + 边距 ≈ 300px）：
             定得太小 ⇒ 卡片被压扁；定得太大 ⇒ 宽屏也只排得下 1 列（正是用户抱怨的空区域）。 -->
      <div v-else-if="viewMode === 'list' && b.items.length" class="result-list">
        <div v-for="(it, i) in b.items" :key="itemIdentity(it)" class="item-card">
          <!-- `#434` 列表布局：按钮**浮到封面底部**（上下排：上「详情」下「阅读/播放」），
               与多列/横屏同款封面浮层；差别是这里封面只有 84×126 ⇒
               触发面用**整张卡片** hover（移入封面太难点中），见样式段 `.item-card:hover .cover-actions`。 -->
          <div class="cover-wrap">
            <!-- `#163`：同上（列表视图）。作者同样取 `payload.author`，不是 `it.author` —— 见上面网格处的注释 -->
            <CoverImage class="cover" :cover="String(it.cover ?? '')" :source-id="b.sourceId" :title="String(it.title ?? '')" :author="authorOf(it)" :index="i" @click="openDetail(it)" />
            <!-- `#366` RSS 卡片：去掉「详情」按钮（#335 订阅源没有详情页语义），只留「打开」且居中 -->
            <div class="cover-actions" :class="{ solo: isRss }">
              <button v-if="!isRss" class="cover-btn ghost" @click.stop="openDetail(it)">ⓘ 详情</button>
              <button class="cover-btn primary" @click.stop="readFirst(it)">
                ▶ {{ isRss ? '打开' : String(it.kind) === 'video' ? '播放' : '阅读' }}
              </button>
            </div>
          </div>
          <div class="body">
            <div class="title" @click="openDetail(it)">{{ it.title }}</div>
            <div class="sub">{{ metaLine(it) }}</div>
            <div class="summary" v-if="it.summary">{{ it.summary }}</div>
          </div>
        </div>
      </div>

      <!-- 内容区：横屏卡片（`#184` 用户 Add：「横屏（横屏卡片，多列样式，只是封面位置是横屏样式）」）
           与 `grid` 的**唯一差别就是封面比例**（16:10 横版 vs 竖版），
           下方信息区、悬浮操作条、`:key` 口径全部复用 —— 不要复制一份卡片结构出来，
           两份模板必然漂移（`#172` 的教训：同一规则写多遍就会漏）。 -->
      <div v-else-if="viewMode === 'wide' && b.items.length" class="poster-grid wide-grid">
        <div v-for="(it, i) in b.items" :key="itemIdentity(it)" class="pcard">
          <div class="poster-wrap" @click="openDetail(it)">
            <!-- 比例由外层 `.wide-grid .poster-wrap .poster` 的 aspect-ratio 给（见样式段），
                 组件自己只负责「这张封面长什么样」，不关心外层给的形状。 -->
            <CoverImage class="poster" :cover="String(it.cover ?? '')" :source-id="b.sourceId" :title="String(it.title ?? '')" :author="authorOf(it)" :index="i" />
            <!-- `#366` RSS 卡片：去掉「详情」按钮（#335 订阅源没有详情页语义），只留「打开」且居中 -->
            <div class="cover-actions" :class="{ solo: isRss }">
              <button v-if="!isRss" class="cover-btn ghost" @click.stop="openDetail(it)">ⓘ 详情</button>
              <button class="cover-btn primary" @click.stop="readFirst(it)">
                ▶ {{ isRss ? '打开' : String(it.kind) === 'video' ? '播放' : '阅读' }}
              </button>
            </div>
          </div>
          <div class="pc-title" :data-tip="String(it.title ?? '')" @click="openDetail(it)">{{ it.title }}</div>
          <div class="pc-line2" :data-tip="cardLine2(it)">{{ cardLine2(it) }}</div>
          <div class="pc-line3" :data-tip="cardLine3(it)">{{ cardLine3(it) }}</div>
        </div>
      </div>

      <div v-else-if="b.loading" class="card empty">加载中…</div>
      <div v-else-if="b.sourceId && !isRss && !b.items.length" class="card empty">
        <div>{{ isLegado && !b.active ? '该源暂未选择分类——点上方分类开始浏览（分类来自书源发现规则）' : '该分类没有内容——换一个分类或源。' }}</div>
        <!-- 引擎透出的「为什么空」：站点返回的短文本/状态（如 Unauthorized），用于区分源失效与解析不匹配 -->
        <div v-if="b.hint" class="empty-hint">{{ b.hint }}</div>
      </div>

      <!-- 触底加载下一页 -->
      <div v-if="b.items.length" ref="sentinel" class="load-more">
        <span v-if="b.loadingMore" class="tag acc">⟳ 加载下一页…</span>
        <button v-else-if="b.hasMore" class="btn sm" @click="disc.loadMore(kind)">↓ 加载下一页（共 {{ b.items.length }} 项）</button>
        <span v-else class="tag">共 {{ b.items.length }} 项 · 没有下一页了</span>
      </div>
      </div><!-- /content-scroll -->
    </div>
  <!-- `#437` 启动页外链（帖子 / 网址导航）→ 应用内浏览器：`window.open` 在丢手势后会被拦掉（用户实测「点了没反应」）
       `#453`：带上 `source-id` —— 桌面端有真 view 时由它渲染（页内跳转 / 返回走 Chromium 原生能力），
       否则维持既有 iframe 通路（行为不变）。 -->
  <InAppBrowser
    v-if="webOpen"
    :url="webOpen.url"
    :title="webOpen.title"
    :source-id="b.sourceId"
    @close="webOpen = null"
    @open-external="openExternal"
  />
  <SourceLoginDialog
    v-if="loginOpen && b.sourceId"
    :source-id="b.sourceId"
    :source-name="st.sources.find((s) => s.id === b.sourceId)?.name"
    :auto-window="loginAutoWindow"
    @close="loginOpen = false"
    @changed="onLoginChanged"
  />
  </div>
</template>

<style scoped>
.disc-page {
  display: grid; grid-template-columns: 245px 1fr; gap: 16px;
  /* ★ `minmax(0,1fr)` 必须有：只写 height 时隐式行仍是 `auto`，源列表会把行撑到内容高度
     （用户 2026-11-08 实测左栏一度高到 2.9 万 px），左右栏再也不会按 92vh 收口。 */
  grid-template-rows: minmax(0, 1fr);
  /* 固定高度：左栏/右栏分类区不动，仅内容区滚（覆盖 omni-content 的整体滚动）。
     ★ 用与书架 `.bs-layout` **同一个式子**（`min(92vh, 100vh-92px)`）——
     用户 2026-11-08：之前这里是 `100vh-92px` 硬值、左栏又被 `100vh-110px` 再压 20px，
     与书架左栏对不齐；现在两页左栏同高。 */
  height: min(92vh, calc(100vh - 92px));
  overflow: hidden;
}

/* 左栏：与书架左栏同高（撑满 `.disc-page`），组/源多时只在这段滚
   （`min-height:0` + `overflow:hidden`：flex 子项默认 `min-height:auto` 会把面板撑破） */
.left-panel { padding: 14px 12px; max-height: 100%; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.lp-title { font-size: 14px; font-weight: 700; padding: 0 4px; margin-bottom: 10px; }
/* `#156`：RSS 没有引擎时的如实说明（见模板里的 .rss-note 注释） */
.rss-note {
  display: flex; flex-direction: column; gap: 4px;
  margin: 0 2px 10px; padding: 8px 10px; border-radius: 9px;
  font-size: 12px; line-height: 1.55; color: var(--text-2);
  background: var(--bg-3); border: 1px solid var(--border-strong);
}
.rss-note b { color: var(--orange); font-weight: 700; }
/* 源分组下拉的样式已随组件走（`components/SourceGroupFilter.vue`）—— 三处共用一份 */
.src-filter { width: 100%; margin-bottom: 8px; }
/* `#237` 源类型筛选（放在分组筛选上方）；`#280` 控件本体已换 FilterDropdown；`#281` 组件内 full 模式满宽（= 分组组件），调用方不再覆盖 */
.src-type-filter { margin-bottom: 6px; }
.cat-sync {
  width: 100%; padding: 8px 10px; margin-bottom: 10px;
  background: transparent; border: 1px dashed var(--border-strong); border-radius: 9px;
  color: var(--text-1); font-size: 12.5px; cursor: pointer; font-family: var(--font);
  transition: all 0.16s;
}
.cat-sync:hover:not(:disabled) { border-color: var(--acc-dim); color: var(--text-0); }
.cat-sync:disabled { opacity: 0.5; cursor: default; }
.src-list { flex: 1; overflow: auto; padding: 2px; }
/*
 * 空库引导（`#885`）：左栏只有 ~260px，所以竖排 + 小字号；虚线框表示「这里本该有条目」。
 * 前缀 `.src-list` 是为了压过 theme.css 的全局 `.empty{padding:40px;text-align:center}`。
 */
.src-list .empty-guide {
  margin: 6px 2px; padding: 14px 12px; text-align: left;
  color: var(--text-1); border: 1px dashed var(--border-strong); border-radius: 9px; background: var(--bg-1);
}
.src-list .empty-guide .eg-t { font-size: 12.5px; font-weight: 700; color: var(--text-0); margin-bottom: 6px; }
.src-list .empty-guide .eg-p { font-size: 11.5px; line-height: 1.7; margin: 0 0 6px; }
.src-list .empty-guide .eg-p code { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.src-list .empty-guide .eg-warn { font-size: 11.5px; line-height: 1.65; color: var(--orange); margin: 0 0 10px; }
.src-list .empty-guide .btn { width: 100%; }
/*
 * 兜底（`#885`）：`.src-list` 原本 `flex:1` 吃剩余高度，窄窗把工具条排高后剩余高度会掉到个位数 px
 * （实测 4px）⇒ 整块引导被裁掉，DOM 里有、屏幕上没有。空库时给列表一个最小高度、左栏允许滚，
 * 任何窗口尺寸下这段文案都读得到。
 */
.src-list:has(.empty-guide) { min-height: 210px; }
.left-panel:has(.empty-guide) { overflow: auto; }
.src-row {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 9px; border-radius: 9px; cursor: pointer;
  border: 1px solid transparent; margin-bottom: 2px;
}
.src-row:hover { background: var(--bg-3); }
.src-row.on { background: var(--brand-soft); border-color: var(--brand); }
/* `#166` 置顶按钮：默认**淡显**（`opacity: 0`），鼠标停在行上或该行被选中时才可见 ——
   左栏只有 300px 上下，常显会挤掉源名。`.on` 也显示：选中态下用户才刚点过它。 */
.src-row .pin {
  flex: none; border: none; background: none; color: var(--faint);
  cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px;
  opacity: 0; transition: opacity .12s;
}
.src-row:hover .pin, .src-row.on .pin { opacity: 1; }
.src-row .pin:hover { color: var(--brand); }
.avatar {
  width: 34px; height: 34px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 14px; color: #fff;
}
/* `#307` 源图标态：同尺寸同圆角，只换「内容」—— 白底兜住透明/浅色图标，避免与深色行融在一起 */
.avatar-img { object-fit: contain; background: #fff; padding: 2px; }
.av0 { background: linear-gradient(135deg, #3b2a6d, #6d2a3f); }
.av1 { background: linear-gradient(135deg, #1f4d4a, #233a6e); }
.av2 { background: linear-gradient(135deg, #6d2a3f, #5d4a1e); }
.av3 { background: linear-gradient(135deg, #233a6e, #2a556d); }
.av4 { background: linear-gradient(135deg, #5a2a5c, #3b2a6d); }
.av5 { background: linear-gradient(135deg, #4a5d23, #1f4d4a); }
.row-main { flex: 1; min-width: 0; }
.nm { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host { font-size: 11px; color: var(--muted); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnt { font-size: 10px; color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 2px 7px; flex-shrink: 0; }

/* 右栏：圆角外边框 + 14/16 内边距（与书架右栏 `.bs-main` 同口径，卡片尺寸才能逐值对齐） */
.right-col {
  min-width: 0; display: flex; flex-direction: column; height: 100%; min-height: 0;
  /* `#873` 竖向是 auto 而不是 hidden：空间够时与 hidden 无差别；不够时（矮窗 + 分组多的源）
     改为右栏整体滚，避免上方列表/功能区把内容区压成 0 高度后无处可看。 */
  overflow-x: hidden; overflow-y: auto;
  padding: 14px 16px;
}
/* 分区线：标题区 → 组件区 → 分类条 → 内容区（高/色与书架 `.bs-sep` 一致） */
.right-sep { flex: none; height: 1px; background: var(--border); margin: 10px 0; }
/* 分类条自身不带边框（用户 2026-11-08）——只在本页覆盖，不动 SearchView 的同一组件 */
:deep(.cat-scroller .cs-track) { border: 0; }
/* `#873` 内容区**保底可见高度**：上方固定区再高也不能把它压到 0（矮窗用户实测「内容整块消失」）。
   空间够时 `flex:1 1 auto` 照旧吃满剩余高度；不够时它保留 140px 且自身仍可滚。 */
.content-scroll { flex: 1 1 auto; min-height: 140px; overflow: auto; }
/* `#404` RSS 启动页 iframe：填满内容区（自身的滚动交给 iframe 内部） */
.rss-start-frame { width: 100%; height: 100%; min-height: 480px; border: 0; display: block; background: #fff; }
.right-head { display: flex; align-items: center; gap: 10px; padding: 0 2px; }
.right-head h3 { margin: 0; font-size: 16px; font-weight: 700; flex: 1; min-width: 0; }
/* 登录按钮：源名称标签后、分类条上方 */
.login-btn { flex: 0 0 auto; }
.login-btn.acc { color: var(--green); border-color: var(--green); }
.cat-scroller-placeholder { padding: 10px 16px; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.empty-hint {
  margin-top: 6px; font-size: 11.5px; color: var(--muted);
  word-break: break-all; line-height: 1.6;
}
.cat-hint {
  display: flex; align-items: center; gap: 10px;
  margin: 8px 0 0; font-size: 11.5px; color: var(--muted);
}
.rest-cats { margin: 10px 0 0; }
.meta-bar { margin: 12px 0 14px; }
.m-cnt { font-size: 12px; color: var(--muted); }
/* ⚠️ `.seg-disabled` 已随「瀑布」占位按钮一起删除（`#184`）——
   它在本文件里唯一的用处就是那个「待支持」的灰按钮，现在没有禁用项了。 */

/* 多列海报（影院风：封面大图 + 标题叠加） */
.cinema-grid { grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); }
/* 圆角与书架封面**逐值对齐**（用户 2026-10-01：「发现页封面图片，使用圆角样式（和书架封面图片相同）」）：
   之前这里是裸的 `position: relative`，封面图直角 ⇒ 和书架不一致。
   ⚠️ `overflow: hidden` 是必需的：`.cv-gen`/`.cv-img` 用的是 `border-radius: inherit`，
   少了它圆角会被内部那层（生成封面的字、图片）盖不住。
   阴影/悬浮/光标也一并对齐 —— 这四项是「看起来像同一套卡片」的整体观感。 */
.poster-wrap {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  transition: transform 0.2s;
  cursor: pointer;
}
.poster-wrap:hover { transform: translateY(-4px); }
.pc-title { font-size: 13px; font-weight: 700; margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.pcard:hover .pc-title { color: #a5b1ff; }
.pc-line2 { font-size: 11px; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.pc-line3 { font-size: 10.5px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
/* 封面上的操作条（② 用户要求：按书架/影视库卡片样式，浮现在封面区域） */
.cover-actions {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; gap: 6px; padding: 8px;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.72), transparent);
  opacity: 0; transition: opacity 0.18s;
}
.pcard:hover .cover-actions { opacity: 1; }
/* `#434` **列表布局**：按钮浮到封面底部（与多列/横屏同款浮层）。
   `.cover` 的尺寸/圆角仍由全局 `.item-card .cover`（theme.css）给 ⇒ 这里只做**定位上下文**，
   并裁掉浮层溢出封面圆角的角落。
   ★ `#435` **`align-self: flex-start` 不能少**：`.item-card` 是 flex 行且默认 `align-items: stretch`
   ⇒ 外层包一层以后，`.cover-wrap` 会被**拉伸到整张卡片的高度**（简介越长它越高）
   ⇒ `bottom:0` 的浮层落到**卡片底部**而不是封面底部（用户实测：「卡片变大时按钮被撑离开封面」）。 */
.item-card .cover-wrap { position: relative; flex: none; align-self: flex-start; border-radius: 8px; overflow: hidden; }
/* 列表布局多按钮**上下排**（用户：上「详情」、下「阅读/播放」）；
   封面只有 84px 宽 ⇒ 内边距/间距收紧，按钮不被文字挤破。 */
.item-card .cover-actions { flex-direction: column; gap: 4px; padding: 6px; }
.item-card .cover-actions .cover-btn { flex: 0 0 auto; }
/* RSS 只有一个「打开」⇒ 列方向下要**水平居中且不拉伸**（否则 18px 内边距把按钮撑出封面） */
.item-card .cover-actions.solo { align-items: center; }
/* 84px 封面里 18px 内边距太宽（「▶ 打开」会被挤到边界）⇒ 收窄到 10px */
.item-card .cover-actions.solo .cover-btn { padding: 5px 10px; }
/* ★ 触发面 = **整张卡片**（用户：列表布局封面小，鼠标移入卡片即浮现，无需移入封面）。
   多列/横屏仍保持「移入封面才浮现」（上面那条 `.pcard:hover`，未动）。 */
.item-card:hover .cover-actions { opacity: 1; }
/* `#366` RSS 卡片只留一个「打开」⇒ 居中、不拉伸铺满（用户原话：只保留打开按钮，居中显示） */
.cover-actions.solo { justify-content: center; }
.cover-actions.solo .cover-btn { flex: 0 0 auto; padding: 5px 18px; }
.cover-btn {
  flex: 1; padding: 5px 0; border-radius: 7px; white-space: nowrap;
  border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.12);
  color: #fff; font-size: 11px; cursor: pointer; backdrop-filter: blur(4px);
}
.cover-btn.primary { background: var(--brand); border-color: var(--brand); }
.cover-btn:hover { filter: brightness(1.15); }

/* 列表（`#184`：列数自适应 1/2/3）
   ⚠️ **从 flex 列改成了 grid**：原来 `.result-list` 是 `display:flex; flex-direction:column`
     ⇒ 永远只有 1 列，宽屏下右侧留下大片空白（用户 2026-10-01 实测）。
     `auto-fill + minmax(300px, 1fr)` 的效果：
       · 窄（< ~320px 可用宽）⇒ 1 列（与原来一致，不会把卡片压扁）
       · 中等宽⇒ 2 列
       · 宽屏 ⇒ 3 列及以上
     每张卡片内部仍是 `.item-card` 自己的横向 flex（封面 + 文字），**逐卡样式不变**。 */
.result-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
  align-content: start;
}
/* ⚠️ grid 里 `.item-card` 不能再靠父级的 flex 撑宽 ⇒ 显式给 `min-width: 0`，
   否则 grid item 的默认 `min-width: auto` 会让长标题把列撑变形（内容溢出而不是换行）。 */
.result-list > .item-card { min-width: 0; }

/* 横屏卡片（`#184`：多列网格 + 横版封面） */
.wide-grid { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
/* ★ 唯一与 `grid` 的差别：封面比例 16:10。
   `.poster` 的默认比例是 `aspect-ratio: 2/3`（`styles/theme.css:154`），这里覆盖成横版。
   ⚠️ 比例一变，`.cv-gen` 里的生成封面文字就按**新的实测宽高**重算字号与列数
   （那是 `CoverImage` 内部 `ResizeObserver` 的事）—— 这正是「不能用固定比例算列数」的原因。
   `.poster-wrap` 只给高度（`height:0` + `padding-bottom` 那种老写法不用，宽高比交给 .poster 自己）。 */
.wide-grid .poster-wrap .poster { aspect-ratio: 16 / 10; }

@media (max-width: 1100px) {
  /* 窄窗口改上下两段：左栏限高、右栏吃掉剩余高度并继续独立滚（整页仍不滚）。
     ★ 左栏行必须写**确定值**（`min(300px, 40vh)`，与书架窄窗口同档）——
     写 `auto` 时轨道按源列表的 max-content 撑高（max-height 只裁盒子不裁轨道），
     右栏会被顶到视口外、内容区高度变 0。 */
  .disc-page { grid-template-columns: 1fr; grid-template-rows: min(300px, 40vh) minmax(0, 1fr); }
  .left-panel { max-height: 100%; }
  .right-col { height: auto; min-height: 0; }
  /* `#873` 窄窗把间距收紧一档：分组多/控件多的源在窄窗里，部分区线+工具条外距
     能吃掉半屏，收紧后同样高度下内容区多出约 30px。 */
  .right-sep { margin: 6px 0; }
  .rest-cats { margin: 6px 0 0; }
  .meta-bar { margin: 8px 0 10px; }
  :deep(.cat-toolbar) { margin-bottom: 6px; }
}

/* `#873` 矮窗（笔记本半屏/调小高度）：左栏源列表再让出一部分高度。
   `#873` 实测 1100×700 时左栏 280px + 功能区 ≈ 300px ⇒ 内容区正好 0；
   矮窗下左栏压到 `min(150px, 20vh)`、区线/工具条外距再收一档，内容区才有可见高度
   （实测数据见交付说明）。
   ⚠️ 只在「窄 + 矮」同时成立时生效，宽窗/常规高度完全不受影响。 */
@media (max-width: 1100px) and (max-height: 760px) {
  .disc-page { grid-template-rows: min(150px, 20vh) minmax(0, 1fr); }
  .right-sep { margin: 4px 0; }
  .meta-bar { margin: 6px 0; }
}
</style>
