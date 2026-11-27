<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReaderStore, itemKey } from '../stores/reader';
import { useAudioStore, type AudioChapter } from '../stores/audio';
// 视频播放浮窗（Legado 视频类源的目录即播放列表 —— 用户要求「点目录项直接切播放页」）
import { usePlayerStore } from '../stores/player';
// `#326` hls.js 以静态资产注入 RSS 正文 iframe：源作者的播放器脚本（如饭团动漫）
// 依赖 window.Hls，但生成的 HTML 没引 hls.js；Chromium 又没有原生 HLS。
// 用 vite 的 ?url 导入拿到构建产物地址（带内容 hash，进 dist/assets）。
import hlsAssetUrl from 'hls.js/dist/hls.min.js?url';
import RichIntro from './RichIntro.vue';
// `#584+` 详情页封面：与发现页/书架同一份「占位 / 真图 / 加载失败」逻辑
import CoverImage from './CoverImage.vue';
// `#352`：内嵌 MediaPlayer 已移除 —— 媒体统一「嗅探按钮 → 播放浮窗」（stores/player.ts），
// 不再在正文里内嵌小播放器，也不再自动跳转（那会替换掉源规则的展示结果）。
// 「加入书架」对话框（用户实测 ①-3：选现有分组 / 就地新建分组）
import AddToShelfDialog from './AddToShelfDialog.vue';
// `#164`：阅读样式面板 —— 与「设置 → 阅读」**同一个组件**（这里 target="book" 改当前书）
import ReadStylePanel from './ReadStylePanel.vue';
// `#203`：朗读（TTS）浮条 —— 逻辑在 stores/read-aloud.ts，本组件只显示状态 + 转发动作
import ReadAloudBar from './ReadAloudBar.vue';
import { useReadAloudStore } from '../stores/read-aloud';
// 小窗顶部热区高度：与浮条/桌面注入 CSS 共用 `float-geometry.json` 的同一数值
import { DOCK_REVEAL_H } from './reader-float-shared';
// 全局 Toast（操作反馈：已加书签 / 目录已更新 / 缓存进度…）
import { toast } from '../toast';
import { useSourcesStore } from '../stores/sources';
// `#583+` 详情页「分组」行：书架位掩码判据的唯一实现
import { isInGroup } from '../shelf-groups';
// `#335` 页内导航：取一个 http(s) 地址并补壳（极简浏览器的「取页」唯一实现）
// `#574`：顺带拿**原始 HTML**（站点定制弹窗的左栏要显示它，不重复取页）
import { fetchWebPage } from '../utils/web-doc';
// `#207` 整本下载中心：阅读器的「⬇ 缓存」与书架的「⬇ 下载整本」是**同一个任务**
import { useDownloadsStore } from '../stores/downloads';
// 字典（4-5）：规则 + 查词（执行在服务端 `/api/dict/query`，见 stores/dict.ts）
import { useDictStore } from '../stores/dict';
// 字典结果渲染前处理：相对地址补全 / 图片走代理 / 链接新标签 / 发音按钮接管（用户 2026-09-28）
// （内含 `sanitizeHtml` 的最小消毒，见该文件顶部注释：**先消毒再 decorate**，白名单不放宽）
import { decorateDictHtml, dictResultIsPlain, playDictAudio, playDictGif } from '../utils/dict-html';
// `#326` 正文 iframe 壳拼装唯一实现（跨域通路桥 + hls.js 注入；探针也用这一份，防复制漂移）
import { buildHtmlDoc, serverOriginOf } from '../utils/html-shell';
// `#408`：WebView 型正文页（`ruleContent` 合成页）的 `playu` RPC 走「解析页 → 直链」同一实现
// `#583`：源自绘 UI 的点击动作（图片选项 click / callBackJs）在**引擎侧**求值
import { resolveMediaPage, evalSourceUi } from '../api';
import { findChapterIndexByUrl } from '../utils/chapter-link';
// `#489` 目录「未缓存」云朵标记：一次游标扫出该书已缓存的章节键（见 utils/chapter-cache.ts）
import {
  cachedChapterKeys, chapterCacheUsageOf, chapterKey,
  onChapterCacheChange, type ChapterCacheChange,
} from '../utils/chapter-cache';
// 音频缓存：按 `chapterUrl` 查服务端真实文件（P1 独立目录，见 apps/server/src/audio-cache.ts）
import { fetchAudioCacheStatus } from '../utils/audio-cache';
// `#489` 本地书（loc_book）豁免：上游 `isLocalBook ⇒ cached`（正文在本机，不显示云朵）
import { isLocalBookSource } from '../utils/book-fetch';
// 阅读主题档位表（`#145`：4 档，照抄上游 arrays.xml 的 theme_mode）
import { READER_THEME_MODES } from '../styles/reader-theme';
// `#146` 划线高亮：正文偏移坐标系（**只此一份**，说明见该文件顶部）
import {
  bodyPosToPara, buildChapterText, domRangeToBodyEx, highlightBodyPos, localRangesForPara, anchorRange,
  segmentText, trimRange,
} from '../utils/chapter-text';
// `#144` 净化规则：选区菜单「替换」直接新建一条规则（对齐 Legado 的菜单 Replace 项）
import { useReplaceRulesStore } from '../stores/replaceRules';
import type { ReplaceRule, HighlightRule, ContentUiMark } from '@yuedu/core/contract';
// `#260`：**三处共用的**替换规则编辑对话框（设置页 / 选区「替换」/ 起效列表点击，唯一一份字段表）
import ReplaceRuleDialog from './ReplaceRuleDialog.vue';
// `#260`：起效的替换规则列表（对齐上游 `EffectiveReplacesDialog`）
import EffectiveReplacesDialog from './EffectiveReplacesDialog.vue';
import ManualReplaceRulesDialog from './ManualReplaceRulesDialog.vue';
// `#620` 导出本书（txt / epub）—— 取正文走本地缓存优先，净化复用阅读链路同一份实现
import ExportBookDialog from './ExportBookDialog.vue';
import BookMemosDialog from './BookMemosDialog.vue';
// `#343` 唤起导入链接（legado:// 与 yuedu://）归类/判型的唯一实现
import { dispatchSchemeImport } from '../utils/scheme-import';
/* `#448` 正文内跳转的「同站 / 像不像页面」判据 —— 与发现页启动页分流**共用同一份**（utils/source-site.ts） */
import { sameSite, sourceSiteUrlOf, looksLikePageUrl } from '../utils/source-site';
// `#343` 源导入对话框（书源/订阅源唤起导入 ⇒ 走预览，不静默）
import SourceSwitchDialog from './SourceSwitchDialog.vue';
// `#583` 源脚本要求打开的面板（`java.showBrowser` 的 data URL）用应用内浏览器承载
import InAppBrowser from './InAppBrowser.vue';
// `#256` 高亮样式对话框（点已有高亮 → 动作栏「样式」）
import HighlightStyleDialog from './HighlightStyleDialog.vue';
// `#262` 高亮规则：管理列表 + 编辑器（上游 HighlightRuleActivity / HighlightRuleEditDialog）
import HighlightRulesDialog from './HighlightRulesDialog.vue';
import HighlightRuleEditDialog from './HighlightRuleEditDialog.vue';
import { useHighlightRulesStore } from '../stores/highlight-rules';
// ⚠️ 匹配器必须走深路径：@yuedu/core 根出口连着 user-store（node:sqlite），进浏览器 bundle 会炸 build
import { matchHighlightRules } from '@yuedu/core/highlight-rule-matcher';
import { emptyHighlightRule } from '@yuedu/core/contract';
// `#374` NAV 嗅探：媒体直链提取走 core 的**唯一实现**（窄子路径，同上理由——
// media-extract 自 `#374` 起依赖链已收敛到零依赖叶子，可安全进浏览器 bundle）
// `#376`：LIVE 桥报文的 format 也用同一实现补（桥内不抄第二份判据）
import { inferPlayFormat, mediaFromRaw, unwrapPlayerUrl } from '@yuedu/core/media-extract';
// `#221`：页眉 / 页脚的模板解析（纯函数在契约层，UI 只负责取值与渲染）
import {
  encodeItemKey,
  readTipDefaultTemplate,
  renderReaderInfoTemplate,
  type ReaderInfoValues,
  type ReadSessionMode,
} from '@yuedu/core/contract';
import ReaderTipBar from './ReaderTipBar.vue';
import PdfPages from './PdfPages.vue';
// `#568`/`#569` P3 站点定制 + 阅读模式
import SiteCustomizeDialog from './SiteCustomizeDialog.vue';
import { readerModeDocument, extractReaderContent, canExtractBookHtml } from '../utils/reader-mode';
import { fetchSiteCustomize, onSiteCustomizeChange } from '../site-customize';
import { hostOfUrl, readerModeAppliesTo, siteCustomizeHeadHtml, type SiteCustomize } from '@yuedu/core/site-customize';
import {
  READER_TOOLS,
  loadToolPins,
  saveToolPins,
  type ReaderToolId,
} from '../utils/reader-toolbar';
// `#814` 自动滚动速度档位：与「设置 → 阅读」共用同一个 ref（见该文件顶部）
import { autoScrollSpeed, setAutoScrollSpeed, AUTO_SCROLL_MIN_SPEED, AUTO_SCROLL_MAX_SPEED } from '../utils/auto-scroll';
// B8 自动翻页档位（4/8/12/20/30 秒；开关是会话态）
import { AUTO_PAGE_SECONDS, autoPageInterval, setAutoPageInterval } from '../utils/auto-page';
// B8 屏幕常亮（Screen Wake Lock；默认关，只在阅读浮层打开期间生效）
import { keepAwakePref, setReaderAwake } from '../utils/keep-awake';
// 高亮样式（上游 `HighlightStyle.kt`；`#256` 起是「独立一套配置」——与阅读样式的全局下划线无关）
import {
  HIGHLIGHT_STYLE_EMPTY,
  highlightClass, highlightStyleVars, parseHighlightStyle, serializeHighlightStyle,
  visibleHighlightStyle,
  type HighlightStyleView,
} from '../utils/highlight-style';
// `#459` Esc 层级栈：一次 Esc 只退最上面那层（阅读/播放/详情三浮层共用一份实现）
import { pushEscLayer } from '../utils/esc-layer';

const r = useReaderStore();
const st = useSourcesStore();
/**
 * `#513` **当前书源名称**（详情页 / 正文页 / 播放页展示，点击跳规则工坊）。
 *
 * 取 `sources` store（发现页/搜索页打开详情时已 loadMeta）；拿不到时回退 sourceId ——
 * 宁可显示 id 也不显示空白，用户至少能看出「这本书来自哪个源」。
 */
const curSourceName = computed(() => {
  const id = r.sourceId;
  if (!id) return '';
  return st.sources.find((x) => x.id === id)?.name || id;
});
/**
 * `#513` 跳规则工坊并打开该源编辑页（`/workshop?id=<sourceId>`）。
 * 先关阅读浮层：它是 overlay，不关会盖住工坊页面。
 */
function openSourceWorkshop(): void {
  const id = r.sourceId;
  if (!id) return;
  r.close();
  void router.push({ name: 'workshop', query: { id } });
}
/**
 * `#516` 详情页「本书正文缓存用量」：章数 + 估算占用（只统计这本书的章节键）。
 *
 * 口径与「🧹 清缓存」完全一致（目录每章 `chapterKey`）；非书架书同样适用 ——
 * 不依赖 `books` 里的详情本地化副本，直接用内存里这份目录算键。
 */
const bookCacheUsage = ref<{ items: number; bytes: number } | null>(null);
let bookUsageSeq = 0;
async function refreshBookCacheUsage(): Promise<void> {
  const sid = r.sourceId;
  const book = r.currentKey;
  const chs = (r.detail?.chapters ?? []).filter((c) => !c.isVolume);
  const my = ++bookUsageSeq;
  if (!sid || !chs.length) {
    bookCacheUsage.value = { items: 0, bytes: 0 };
    return;
  }
  const u = await chapterCacheUsageOf(chs.map((c) => chapterKey(sid, c.payload)));
  // 期间换了书/目录换了 ⇒ 这次结果作废（同目录云朵扫描的守卫口径）
  if (my !== bookUsageSeq || r.sourceId !== sid || r.currentKey !== book) return;
  bookCacheUsage.value = u;
}
function fmtCacheBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
/** 详情页才统计（正文页不显示这个按钮，避免每次翻章都全库扫一遍） */
watch(
  () => [r.currentKey, r.detail?.chapters?.length, !!r.chapter] as const,
  () => {
    if (r.chapter) {
      bookCacheUsage.value = null;
      return;
    }
    void refreshBookCacheUsage();
  },
  { immediate: true },
);

/** `#516` 详情页「清理本书缓存」：有则清、无则提示跳过（用户要求） */
async function onClearBookCache(): Promise<void> {
  const n = await r.clearCurrentBookCache();
  toast(n > 0 ? `已清理本书 ${n} 章缓存` : '本地没有这本书的缓存，已跳过', 'info');
  // 清完立刻刷新用量（缓存变更事件也会让目录云朵恢复）
  await refreshBookCacheUsage();
}
const dl = useDownloadsStore();
const audio = useAudioStore();
const player = usePlayerStore();
const rr = useReplaceRulesStore();
// `#262` 高亮规则：渲染期匹配（按 pattern 自动高亮）+ 管理对话框
const hr = useHighlightRulesStore();
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
// `#849` 「仿真」档 = 真卷曲：几何/光栅器在 utils/page-curl（降级链也在那里）
import PageCurl from '../utils/page-curl/PageCurl.vue';
import { paintTextPage, paintBackOf, type CurlPageStyle } from '../utils/page-curl/texture';
// B18 小窗模式：桌面端走主进程单窗变形（PC 侧两态收敛由桌面那一路做）；
// Web 端常规 / 条形与歌词**只走 Document PiP**（页内浮条、页内浮窗已退役；PiP 不可用时明确提示、不降级）
import {
  isDesktop, getSmallState, toggleSmallMode, setSmallWindowTier, onSmallStateChange,
  getDesktopPrefs, setDesktopPrefs,
} from '../desktop';
import type { DesktopSmallTier } from '../desktop';
import ReaderMiniBar from './ReaderMiniBar.vue';
const router = useRouter();

// `#262`：进阅读页拉一次规则（loaded 守卫不重拉；导入/保存后 store 内部已更新）
void hr.refresh();

// 图片/封面统一走服务端代理（防盗链 + 解密 + 动图透传）——见 utils/img.ts
import { imgSrc } from '../utils/img';
// `#834` 漫画图片客户端队列（预取窗口 / 在飞 ≤3 / 退避重试；服务端 per-host 配额不动）
import { ComicImageQueue, type ComicImgDim, type ComicImgStatus } from '../utils/comic-image-queue';
// `#224` 翻页动画档位归一（`PageAnim.kt:9-17`；坏值回落「不动画」）
import { normalizePageAnim } from '../utils/reader-view-mode';
// `#825` 分页：测量切页 + 只渲染当前页（及前后各一页）
import { usePagedChapter } from '../composables/usePagedChapter';
import { measureChapterPages, type MeasureInput, type PageChunk } from '../utils/paged-layout';
// B1 阅读统计：只落前端本地日桶（不进服务端；存储取舍见 utils/read-stats.ts 头注释）
import { addReadingMs } from '../utils/read-stats';
// P1 `#863` 会话流水（服务端主存；visual/listen/auto 各自独立会话）
import {
  CHECKPOINT_INTERVAL_MS,
  ReadSessionTracker,
  clearCheckpoint,
  flushSessionQueue,
  reportSession,
  saveCheckpoint,
  takeCheckpoint,
  type ReadSessionMeta,
} from '../utils/read-session';
// 漫画模式：kind=image 时段落即图片 URL，整宽渲染
const isComic = computed(() => r.detail?.kind === 'image');
// 图片展示样式（引擎按 Legado imageStyle 归一：FULL 整宽 / SINGLE 单图逐屏 / TEXT 占位 / DEFAULT 跟随）
const comicStyle = computed(() => (r.chapter?.imageStyle ?? 'FULL').toUpperCase());
const showImages = computed(() => comicStyle.value !== 'TEXT');

/**
 * `#212` Step4：PDF 章判定。
 *
 * ★ 判据 = 「`kind === 'image'` **且** 本章 paragraphs 全是 PDF 页标记地址」。
 *   **不靠 `originName` 后缀**：前端拿不到文件名（本地书详情只给 title/author），
 *   且后缀判断会与「服务端已切好章」这一事实重复判定 ⇒ 一旦两边不一致就是
 *   「进了漫画分支但全是破图」。
 */
const isPdfChapter = computed(() => {
  if (r.detail?.kind !== 'image') return false;
  const ps = r.chapter?.paragraphs ?? [];
  return ps.length > 0 && ps.every((p) => typeof p === 'string' && p.includes('/pdf-page?'));
});
/** 本章要渲染的页码（从标记地址里解析 `page=N`）；解析不出的项直接丢（不会渲染成破图） */
const pdfPageNumbers = computed<number[]>(() => {
  if (!isPdfChapter.value) return [];
  return (r.chapter?.paragraphs ?? [])
    .map((p) => {
      const m = /[?&]page=(\d+)/.exec(String(p));
      return m ? Number.parseInt(m[1]!, 10) : -1;
    })
    .filter((n) => n >= 0);
});
/** 整本 PDF 的取数地址：从第一个页标记里取 `bookUrl`（与服务端 `localBookPdfPageUrl` 同参） */
const pdfFileUrl = computed<string>(() => {
  const first = String(r.chapter?.paragraphs?.[0] ?? '');
  const m = /[?&]bookUrl=([^&]+)/.exec(first);
  return m ? `/api/local-books/file?bookUrl=${m[1]!}` : '';
});


// 图片/封面/媒体一律走服务端代理（`imgSrc`，见 utils/img.ts）：
//  · 防盗链靠**源自己的 Referer/UA/Cookie**（服务端按源 header 规则解析）；
//  · 源声明的图片二次解密（Legado imageDecode / coverDecodeJs）由服务端按 `sid` 决定，
//    前端不再自己判断 `imageDecode`（少一处会漂移的分支）；
//  · 动图（gif/webp/avif）原字节透传 + 按魔数纠正 content-type。
// ⚠️ 图片兜底映射必须按 **图片 URL** 索引，不能按数组下标：
// 按下标时换章/换书后旧下标仍命中上一章（甚至另一本漫画）的代理 URL →
// 「新章节显示旧图片、新图只能追加在后面」的串位 bug。
const imgOverride = ref<Record<string, string>>({});
// 翻页动画（`PageAnim.kt:9-17`）：0 覆盖 / 1 滑动 / 2 仿真 / 3 滚动 / 4 无动画
//
// ★ `#224` 现在 `pageAnim` 有了**真实去处**（分页模式的翻页效果）；
//   契约 `user-data.ts` 里那段「暂缓 / 不做：pageAnim」的注释本轮随之作废（已在契约里改掉）。
/** 归一后的翻页动画档位（坏值回落 3 = 不动画），模板与 class 都读它 */
const pageAnim = computed(() => normalizePageAnim(r.readStyle?.pageAnim));
/**
 * 章节**进场**动画 class（滚动模式下近似上游分页动画；`#223` 起保留）。
 *
 * ⚠️ 分页模式下**不用**它 —— 那边是「翻一页」的动画，由 `.se-paged-<档位>` 负责。
 * 两套不能同时挂：进场动画是 `transform + opacity`，翻页动画动的是页轨道的 `translateX`，
 * 一起用会让「翻页看着像整章在动」。
 */
const pageAnimClass = computed(() => {
  if (isPaged.value) return '';
  /**
   * 用户 2026-11-10：**无限滚动下不播进场动画**。
   * 那种「像滑入的正文载入动画」是本章 `.rd-content` 按 `chapterIdx` 重挂时 `rd-anim-*` 重播；
   * 无限滚动里换章是**滚动交接**造成的（用户只是在滚），不是翻页/点目录 ⇒ 只保留分页与
   * 手动切章路径的动画。
   */
  if (infiniteActive.value) return '';
  const v = pageAnim.value;
  if (v === 0) return 'rd-anim-cover';
  if (v === 1) return 'rd-anim-slide';
  if (v === 2) return 'rd-anim-sim';
  if (v === 4) return 'rd-anim-none';
  return '';
});

/* ===================================================================================
 * `#825` **分页模式**
 *
 * 上游 Legado 的阅读器本来就是**分页的自定义 View**（`ReadView.kt:898 isScroll = pageAnim() == 3`
 * ⇒「滚动」只是它五档里的一档）；`#224` 起本仓 Web 阅读浮层补上「页」这个概念。
 *
 * ## 实现路线（`#825` 重建）
 * 页的边界由 `utils/paged-layout.ts` **离屏测量**得出（字符区间切片），渲染层只挂当前页 ±1。
 * 翻页 = 改 `curPage` + 换切片 + `translateX` 过渡，**零测量、零重排**。
 *
 * ⚠️ 不再用 CSS multi-column：列几何是浏览器算的且**整章一起重排**（字体晚到 / resize /
 * 页眉高度变化 / 图片加载完都会让列宽与位移失效，用户实测「翻一两页就失灵」），
 * 而且列数只能从 DOM 反读 ⇒ 测量与渲染互相绑定。`#811` 只掐掉了「滚动回调里写 inline 列宽」
 * 那条自激回路，方案本身仍不可靠。
 *
 * ## 与滚动模式的互斥点（一处一处列清，避免以后改样式时踩回去）
 * · `overflow-y` 必须从 `auto` 变 `hidden`（分页时纵向由页高管，见 `.se-body.se-paged`）
 * · 页眉/页脚仍 `sticky`（列容器内不动），但**自动隐藏的判据要换成「翻过页」**（滚动距离是 0）
 * · 进度计算不能再用「容器底 − 内容顶」⇒ 改成「当前页 / 总页数」
 */
const isPaged = computed(() => r.viewMode === 'paged');
/**
 * `#810` **分页布局真正生效**的判据（`isPaged` 只是「用户偏好」）。
 *
 * ## 为什么要与 `isPaged` 分开（用户实机复现的根因之一）
 * `.se-body` 同时承载「详情页」和「正文页」（见模板：详情区在同一个 `.se-body` 里）。
 * 若只按偏好挂 `se-paged`，**重启后 viewMode 仍是 paged** 时，详情页也会进入列布局：
 * `overflow-y: hidden` 把详情下半截裁掉、只能横向滚 —— 用户看到「详情页出现分页水平滚动条」，
 * 且「开始阅读/目录」在视口外，整个界面像卡死。
 * ⇒ **只有 `r.chapter` 存在（真的在阅读）时才应用分页几何**；详情页始终按滚动布局。
 *
 * ⚠️ 所有**几何/翻页/列测量**都必须读这个，而不是 `isPaged`；
 * 只有「用户偏好是否分页」的提示文案（样式面板开关、自动滚动禁用）才继续读 `isPaged`。
 */
const pagedActive = computed(() => isPaged.value && !!r.chapter && !isComic.value && !isPdfChapter.value && !isHtmlChapter.value);

/**
 * 当前页（1 起）与总页数。
 *
 * `#825`：总页数不再「由浏览器列数算出来」，而是 `paged-layout` 测量切页的结果派生；
 * 翻页只改 `curPage`（见 `gotoPage`）。
 */
const curPage = ref(1);
/**
 * `#825` 分页状态机：**测量切页**（不再用 CSS 多列）。
 *
 * 组件只提供「页尺寸 + 排版变量 + 章文本」，页由 `utils/paged-layout.ts` 量出来；
 * 翻页只改 `curPage`（零测量、零重排）。重建/取消/签名缓存都在 composable 里。
 */
const paged = usePagedChapter();
/** 顶层解构：模板里直接 `pagedReady` / `pagedPages`（嵌套 ref 在模板里不会被自动解包） */
const pagedPages = paged.pages;
const pagedReady = paged.ready;
/** 总页数（派生自布局结果；没有布局时恒为 1） */
const pageCount = paged.pageCount;

/** 分页视口 / 正文格的限宽 —— 与滚动模式 `.rd-content` 的 `max-width: 918px` 同一口径 */
const PAGED_VIEW_MAX_W = 918;
/**
 * 底部翻页条（`.se-paged-nav`，绝对定位、浮在正文上）占掉的高度。
 *
 * ★ 必须**从测量高度里扣掉**：否则每页最后两三行会被翻页条盖住（用户看到的是「字没了」）。
 * 渲染侧的 `.rd-content` 仍是整页高 ⇒ 测量比渲染矮 34px 只会在页尾留一条空白，不改变换行。
 */
const PAGED_NAV_RESERVE = 34;

/** 取 `--rd-*` 的像素值（拿不到就回落上游默认值，与 `styles/reader-theme.ts` 的 `var(--x, N)` 一致） */
function varPx(vars: Record<string, string>, key: string, dflt: number): number {
  const n = Number.parseFloat(vars[key] ?? '');
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * `#825` 生成测量输入：**宽高从真实容器量**，排版量直接复用 `readerStyleVars`
 * （与渲染同一份，签名才可信）。拿不到容器 / 没章时返回 `null`。
 */
function buildPagedInput(): MeasureInput | null {
  const el = pageBodyEl.value;
  if (!el || !r.chapter) return null;
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const padX = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  const padY = (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.paddingBottom) || 0);
  const viewW = Math.max(1, Math.min(PAGED_VIEW_MAX_W, Math.round(rect.width - padX)));
  const viewH = Math.max(1, Math.round(rect.height - padY));
  const vars = r.readerStyleVars as Record<string, string>;
  // `.rd-content` 的上下 padding 由排版档位决定 ⇒ 从可用高里扣掉（测量盒只给 content-box 高）
  const pt = varPx(vars, '--rd-pt', 6);
  const pb = varPx(vars, '--rd-pb', 6);
  return {
    chapterKey: `${r.sourceId ?? ''}|${r.chapterIdx}|${r.chapter.title ?? ''}`,
    paragraphs: r.displayParagraphs ?? [],
    title: {
      text: r.displayTitle || '',
      className: highlightClass(titleRuleStyle.value).join(' '),
      style: { ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle.value) },
    },
    width: viewW,
    height: Math.max(1, viewH - pt - pb - PAGED_NAV_RESERVE),
    styleVars: vars,
    fontFamily: cs.fontFamily,
  };
}

/**
 * 重建（120ms 节流）。
 *
 * ★ 只在「首次进入 / 布局签名变化」时真正量；翻页路径**从不**调它。
 */
let rebuildTimer = 0;
/** 重建期间容器又变过尺寸 ⇒ 这一轮结束再补一次（否则「边量边拖窗口」会留下旧几何） */
let rebuildWhileBusy = false;
/** `document.fonts.ready` 是否已兑现 / 已完成的布局是不是在它之后量的（避免无谓的二次全量重建） */
let fontsReadyDone = false;
let builtAfterFonts = false;

function schedulePagedRebuild(delay = 120, force = false): void {
  if (!pagedActive.value) return;
  // 正在量的时候不要再排一个（会打断当前这轮、两头都慢）；只记一个「完成后再来一次」
  if (paged.measuring.value) { rebuildWhileBusy = true; return; }
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
  rebuildTimer = window.setTimeout(() => {
    rebuildTimer = 0;
    void runPagedRebuild(force);
  }, delay);
}

/** 真正跑一次重建：记住锚点段 ⇒ 重建后回到它所在的页（改字号/拖窗口时不会跳回第 1 页） */
async function runPagedRebuild(force = false): Promise<boolean> {
  if (!pagedActive.value) { paged.reset(); return false; }
  const input = buildPagedInput();
  if (!input) return false;
  const pageAtStart = curPage.value;
  const anchor = paged.firstChunkOfPage(pageAtStart);
  const ok = await paged.rebuild(input, force);
  if (ok && fontsReadyDone) builtAfterFonts = true;
  if (rebuildWhileBusy) {
    rebuildWhileBusy = false;
    if (pagedActive.value) schedulePagedRebuild(0);
  }
  if (!ok) return false; // 被取消（切模式/换章）—— 旧结果绝不覆盖新章
  const n = pageCount.value;
  // ★ 用户在**测量期间自己翻了页** ⇒ 尊重用户当前页码（只夹范围），绝不按旧锚点把人家拉回去。
  //   `#811` 实测症状就是「翻一两页就回到第 1 页」：一轮晚到的重建按「开始量时」的锚点收尾。
  if (curPage.value !== pageAtStart) {
    curPage.value = Math.min(Math.max(1, curPage.value), n);
  } else if (anchor) {
    // 用「片起点」而不是「段下标」：跨页段的段头在前一页，只按段下标会退回一页
    curPage.value = Math.min(Math.max(1, paged.pageOfChunk(anchor.para, anchor.start)), n);
  } else {
    curPage.value = Math.min(Math.max(1, curPage.value), n);
  }
  void nextTick(updateProgress);
  // `#845` 排队中的书签跳转：这一轮把页表建好了 ⇒ 现在落位（覆盖上面按锚点回位的结果）
  applyPendingPagedJump();
  // 页表就绪（含字号/尺寸变化后的重建）⇒ 若正停在章首/章末页，顺手预热邻章纹理
  scheduleCurlNeighborWarm(120);
  return true;
}

/** 闪一下某一段（跳转反馈；分页下只闪当前页里能看见的那一片） */
function flashPara(idx: number): void {
  // 分页时轨道里同时挂着前后页 ⇒ 必须限定「当前页」，否则会闪到看不见的邻页副本
  const scope = pagedActive.value
    ? pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-page.se-paged-current')
    : pageBodyEl.value;
  const el = scope?.querySelector<HTMLElement>(`.rd-content p[data-p="${idx}"]`);
  if (!el) return;
  el.classList.add('rd-flash');
  window.setTimeout(() => el.classList.remove('rd-flash'), 1600);
}

/**
 * `#845` **布局没就绪时排队的书签跳转**。
 *
 * 缺陷形态（验收实测，字号 32→44 · 15→25 页）：改字号后**第一次**点书签停在第 1 页，
 * 再点一次才到第 5 页（旧构建连点 3 次 3/3 都停第 1 页）。
 *
 * 真因不是「页码夹取」本身，而是 `jumpBookmark` 会先 `r.openChapter(ch)`——
 * 即便点的是**当前章**，`chapter.value` 也会被换成新对象 ⇒ `watch(() => r.chapter)`
 * 先 `curPage = 1` + `paged.reset()`（页表清空），再 `schedulePagedRebuild(0)`；
 * 于是同一时刻有两轮重建：书签这一轮 await 的 `rebuild()` 被另一轮 `cancel()` 掉，
 * 返回 `false`，此时页表是空的 ⇒ `pageOfChunk` 只能回落到 1，而且**原来不会重试**。
 *
 * 所以跳转要把「目标段 + 段内偏移」排队，谁最后把页表建好，谁在收尾时落位；
 * 这样无论哪一轮赢，落点都由同一套 `pageOfChunk(para, start)` 口径算出。
 */
let pendingPagedJump: { idx: number; start: number } | null = null;

/** 页表就绪 ⇒ 把排队中的书签落位（由 `runPagedRebuild` 的**成功收尾**调用，只做一次） */
function applyPendingPagedJump(): void {
  const pend = pendingPagedJump;
  if (!pend) return;
  if (!pagedActive.value || paged.pages.value.length === 0) return;
  pendingPagedJump = null;
  const n = pageCount.value;
  gotoPage(Math.min(Math.max(1, paged.pageOfChunk(pend.idx, pend.start)), n));
  void nextTick(() => flashPara(pend.idx));
}

/**
 * 分页下跳到「某段 + 段内偏移所在页」。
 *
 * ★ 两条纪律（`#844` 验收实测）：
 * 1. **一律先等这一轮重建**：字号刚改 / 换章 / 正在 `measuring` 时，`pages` 还是上一份页表，
 *    直接查会夹到第 1 页（「改字号后第一次点书签停在第 1 页，再点才到第 5 页」）；
 *    `rebuild()` 命中签名缓存会立刻返回，签名变了才会真重建 —— 所以无条件 await 代价可忽略。
 * 2. **用 `pageOfChunk(para, start)` 而不是 `pageOfPara`**：书签记的是「段 + 段内偏移」，
 *    长段跨页时只按段头会落到段开头那一页（「para55 偏移 +900 期望第 6 页、实际第 5 页」）。
 *
 * `#845`：await 拿到 `false` / 空页表时**不再夹成第 1 页结束**，改为留在队列里等下一次成功收尾
 * （见 `pendingPagedJump`）。
 */
async function jumpToParaPaged(idx: number, start = 0): Promise<void> {
  pendingPagedJump = { idx, start };
  const built = await runPagedRebuild(false);
  if (built && paged.pages.value.length > 0) {
    applyPendingPagedJump();
    return;
  }
  // 这一轮被更晚的重建取代了（换章 / 改字号刚 reset 过）⇒ 让它建完再落位；不要再叠加一轮
  if (pagedActive.value && !paged.measuring.value) schedulePagedRebuild(0);
}

/**
 * `#830` 翻页动画的「角色派发」。
 *
 * 四种档位是**四套几何**（见样式块 `.se-paged-*`），几何要按「哪一页在动」区分：
 *   · `se-pg-in`  = 这一翻的**落点页**（新当前页）
 *   · `se-pg-out` = 这一翻的**起点页**（旧当前页）
 * 角色只在**一次翻页的动画窗口内**存在（`flip` 清空后回到普通页），
 * 这样样式表能给不同的页挂不同的 transition / animation，而不是「一套 transform 换参数」。
 *
 * ## 为什么用 timer 清 `flip`
 * 角色 class 不会自己消失（Vue 不重渲染就不会变）；留着会让**下一次换章的预渲染页**
 * 带着旧动画规格。一个动画窗口结束就清掉，class 随之回落到普通页。
 * ⚠️ 清掉时**不改任何页的 inline `transform`**（页码早就是终态）⇒ 不触发重排/测量。
 */
/**
 * `#848` 翻页动画的方向轴：**「滚动」档位是纵向（从下往上）**，其余档位仍水平。
 *
 * 用户实机反馈：「滚动」档位现在跟「滑动」一样从右往左，应该是从下往上滚动。
 * 页轨道本来就是「按页码差 ±100% 位移」，换轴只需换 `translateY` —— 零测量、零重排。
 */
const pagedVertical = computed(() => pageAnim.value === 3);
function pageTransform(dx: number): string {
  return `${pagedVertical.value ? 'translateY' : 'translateX'}(${dx * 100}%)`;
}

const FLIP_MS: Record<number, number> = { 0: 240, 1: 330, 2: 320, 3: 300, 4: 0 };
const flip = ref<{ from: number; to: number; dir: -1 | 1 } | null>(null);
let flipTimer = 0;
function clearFlip(): void {
  if (flipTimer) { window.clearTimeout(flipTimer); flipTimer = 0; }
  flip.value = null;
}
function markFlip(from: number, to: number, dir: -1 | 1): void {
  const ms = FLIP_MS[pageAnim.value] ?? 0;
  if (ms <= 0) { clearFlip(); return; }
  flip.value = { from, to, dir };
  if (flipTimer) window.clearTimeout(flipTimer);
  flipTimer = window.setTimeout(() => { flip.value = null; flipTimer = 0; }, ms + 40);
}

/**
 * 跳到第 p 页（1 起）。
 *
 * ★★ **翻页路径上零测量、零同步重排**（`#825` 的核心纪律）：
 * 这里只改 `curPage`，渲染层按页码换切片，`transform` 由 CSS 过渡 ——
 * 不读任何布局、不写 inline 尺寸。
 */
function gotoPage(p: number): void {
  if (!pagedActive.value) { curPage.value = 1; return; }
  const n = Math.min(Math.max(1, p), pageCount.value);
  if (n === curPage.value) return;
  curPage.value = n;
  scrolledDown.value = n > 1; // 页眉自动隐藏的判据：翻过页就收起（滚动模式下才有「滚下去」）
  // 翻页后同步一次阅读进度（否则进度条要等下一次滚动才动）
  void nextTick(updateProgress);
}

/**
 * 分页下的**翻页动作**（点正文两侧 / 键盘 ←→ 都走这里）。
 *
 * @param dir `-1` 上一页 · `1` 下一页
 * @returns 是否真的翻了（用于「翻不动」时的视觉反馈）
 */
function turnPage(dir: -1 | 1): boolean {
  if (!pagedActive.value) return false;
  const target = curPage.value + dir;
  if (target < 1) return false;
  if (target > pageCount.value) return false;
  // `#849` 「仿真」档 = 真卷曲（其余四档、漫画、PDF、滚动、朗读一律走原来的几何）
  if (pageAnim.value === 2 && !reducedMotionNow()) {
    if (curlOn.value) {
      // 上一次还没翻完：只排队一次（连点不丢最后一下，也不会叠加纹理）
      curlPendingDir = dir;
      return true;
    }
    if (startPageCurl(dir, target)) return true;
    // 容器/页表还拿不到 ⇒ 退回原来的近似动画，不改变既有行为
  }
  // `#830` 先派发角色再改页码：同一帧里页面既拿到 `se-pg-in/out`，也拿到新的 `dx`
  markFlip(curPage.value, target, dir);
  gotoPage(target);
  return true;
}

/* ════════════════════════════════════════════════════════════════════════
 * `#849` 「仿真」档 = **真卷曲**（几何/光栅器在 `utils/page-curl`）
 *
 * 三条纪律：
 * ① **翻页完成后才改 `curPage`**：卷曲期间 DOM 停在旧页（canvas 在上面画「纸面 + 底板」），
 *    动画结束的同一 tick 里撤覆盖层 + `gotoPage(target)` ⇒ Vue 只 flush 一次，不闪；
 * ② **卷曲过程中零测量、零重排**：纹理用现成的 `PageChunk` 切片重绘，页表**不重建**；
 *    只在起手那一帧读一次容器矩形与 `getComputedStyle`（纯读、不写样式 ⇒ 不触发重排）；
 * ③ 降级链留在 `PageCurl` 内部（WebGL → Canvas2D → CSS 透视 → 无动画）；
 *    系统开了「减少动效」时直接走原来的瞬切（不启动卷曲）。
 *
 * ⚠️ 组件**常驻挂载**（首次翻页后不再卸载）：WebGL 引擎的构造/着色器编译只在第一次付代价，
 * 每翻一页重建一次会把主线程卡出十几毫秒的抖动。
 * ════════════════════════════════════════════════════════════════════════ */
const curlOn = ref(false);
/** 组件是否已挂载（首次翻页前为 false；之后一直留着，靠 `visibility` 隐藏） */
const curlMounted = ref(false);
const curlProgress = ref(0);
const curlDir = ref<1 | -1>(1);
const curlWidth = ref(0);
const curlHeight = ref(0);
const curlDpr = ref(1);
const curlFront = shallowRef<HTMLCanvasElement | null>(null);
const curlBack = shallowRef<HTMLCanvasElement | null>(null);
const curlNext = shallowRef<HTMLCanvasElement | null>(null);
/** 网格密度：Web 锁 20×10、桌面 32×16 */
const curlGrid = computed<[number, number]>(() => (isDesktop() ? [32, 16] : [20, 10]));

/** 卷曲时长（与原「仿真」档的 0.32s 同步，见 `FLIP_MS[2]`） */
const CURL_MS = 320;
/** 纹理缓存上限：当前页 + 前后各一页 */
const CURL_CACHE_MAX = 3;
interface CurlTex { sig: string; front: HTMLCanvasElement }
const curlCache = new Map<number, CurlTex>();
let curlRaf = 0;
let curlStartAt = 0;
let curlTargetPage = 0;
let curlToken = 0;
/** 卷曲期间的「下一次翻页」：最多排队一次 */
let curlPendingDir: -1 | 1 | 0 = 0;
let curlWarmTimer = 0;
/** 跨章卷曲在途（旧章画面冻在覆盖层上，等新章页表就绪再播；见 `beginCurlHop`） */
let curlHop: { dir: -1 | 1 } | null = null;

/** 「仿真」档的手势拖拽状态（pointerdown 起、越过 10px 死区才真正起卷） */
interface CurlDragState {
  pointerId: number;
  startX: number;
  startY: number;
  dir: -1 | 1;
  started: boolean;
  /** 章边界：页表里没有目标页，松手后才走跨章卷曲 */
  edge: boolean;
  /** 章边界但**预载纹理已就绪**：拖拽过程直接起卷（跟手），松手后补切章 */
  hop: boolean;
  lastX: number;
  lastAt: number;
  velocity: number;
}
let curlDrag: CurlDragState | null = null;
/** 最近一次拖拽结束时刻：紧随其后的 click 不能再触发一次翻页 */
let curlDragEndAt = 0;

function reducedMotionNow(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function num(v: string | undefined, dflt: number): number {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : dflt;
}

/** 从**真实渲染的那一页**取排版参数（与 `.rd-content` 完全同一份，不另写一套默认值） */
function curlStyleOf(view: HTMLElement): { style: CurlPageStyle; sig: string } | null {
  const pageEl = view.querySelector<HTMLElement>('.se-paged-page');
  const content = pageEl?.querySelector<HTMLElement>('.rd-content');
  if (!pageEl || !content) return null;
  const cs = getComputedStyle(content);
  const pEl = content.querySelector<HTMLElement>('p:not(.rd-p-cont)')
    ?? content.querySelector<HTMLElement>('p');
  const pcs = pEl ? getComputedStyle(pEl) : null;
  const titleEl = content.querySelector<HTMLElement>('.rd-book-title');
  const tcs = titleEl ? getComputedStyle(titleEl) : null;
  const bg = getComputedStyle(pageEl).backgroundColor;
  const vars = r.readerStyleVars as Record<string, string>;
  const fontSize = num(cs.fontSize, 20);
  // 缩进/段距按 CSS 变量算：页上第一个 `<p>` 可能是续片（`rd-p-cont` ⇒ text-indent: 0），
  // 直接读它的 `text-indent` 会把整页缩进写成 0。
  const indentEm = Number.parseFloat(vars['--rd-indent'] ?? '');
  const style: CurlPageStyle = {
    background: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : undefined,
    color: cs.color,
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    fontSize,
    lineHeight: num(cs.lineHeight, fontSize + 12),
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : num(cs.letterSpacing, 0),
    paddingLeft: num(cs.paddingLeft, 16),
    paddingRight: num(cs.paddingRight, 16),
    paddingTop: num(cs.paddingTop, 6),
    paddingBottom: num(cs.paddingBottom, 6),
    paragraphSpacing: num(vars['--rd-ps'], pcs ? num(pcs.marginBottom, 2) : 2),
    indent: Number.isFinite(indentEm) ? fontSize * indentEm : (pcs ? num(pcs.textIndent, fontSize * 2) : fontSize * 2),
    paintTitle: !!tcs && tcs.display !== 'none',
  };
  if (tcs && tcs.display !== 'none') {
    style.titleSize = num(tcs.fontSize, fontSize + 7);
    style.titleColor = tcs.color;
    style.titleFontFamily = tcs.fontFamily;
    style.titleWeight = tcs.fontWeight;
    style.titleLineHeight = num(tcs.lineHeight, (style.titleSize ?? fontSize) * 1.25);
    style.titleAlign = tcs.textAlign === 'center' ? 'center' : tcs.textAlign === 'right' ? 'right' : 'left';
    style.titleMarginTop = num(tcs.marginTop, 0);
    style.titleMarginBottom = num(tcs.marginBottom, 0);
  }
  return { style, sig: JSON.stringify(style) };
}

/** 章节 + 尺寸 + 排版量的复合签名：换章/改字号/换窗口尺寸后旧纹理全部作废 */
function curlSig(base: string, geo: { w: number; h: number; dpr: number }): string {
  return `${r.sourceId ?? ''}|${r.chapterIdx}|${pagedPages.value.length}|${geo.w}x${geo.h}@${geo.dpr}|${base}`;
}

function curlTextureOf(
  pageNo: number,
  geo: { w: number; h: number; dpr: number },
  style: CurlPageStyle,
  sig: string,
): HTMLCanvasElement | null {
  const hit = curlCache.get(pageNo);
  if (hit && hit.sig === sig) return hit.front;
  const chunks = pagedPages.value[pageNo - 1];
  if (!chunks || chunks.length === 0) return null;
  const hasTitle = chunks.some((c) => c.para < 0);
  const tex = paintTextPage({
    width: geo.w,
    height: geo.h,
    dpr: geo.dpr,
    paragraphs: r.displayParagraphs ?? [],
    chunks,
    title: hasTitle ? r.displayTitle || '' : null,
    style,
  });
  curlCache.set(pageNo, { sig, front: tex });
  while (curlCache.size > CURL_CACHE_MAX) {
    const first = curlCache.keys().next();
    if (first.done) break;
    curlCache.delete(first.value);
  }
  return tex;
}

/**
 * 建纹理并把覆盖层亮起（**不启动动画**）：点击翻页、手势拖拽、跨章卷曲共用这一步。
 * 返回 false 表示当前页表/样式还拿不到纹理（例如章边界），调用方走各自的兜底。
 */
function prepareCurl(dir: -1 | 1, target: number): boolean {
  const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
  if (!view) return false;
  const st = curlStyleOf(view);
  if (!st) return false;
  const rect = view.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w < 40 || h < 40) return false;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const geo = { w, h, dpr };
  const sig = curlSig(st.sig, geo);
  // 正面 = 被翻走的那一页；底板 = 翻完后露出的那一页（回翻时两者互换）
  const sheetPage = dir === 1 ? curPage.value : target;
  const underPage = dir === 1 ? target : curPage.value;
  const front = curlTextureOf(sheetPage, geo, st.style, sig);
  const next = curlTextureOf(underPage, geo, st.style, sig);
  if (!front || !next) return false;

  curlWidth.value = w;
  curlHeight.value = h;
  curlDpr.value = dpr;
  curlFront.value = front;
  curlBack.value = paintBackOf(front, { background: st.style.background });
  curlNext.value = next;
  curlDir.value = dir;
  curlTargetPage = target;
  curlProgress.value = dir === 1 ? 0 : 1;
  curlMounted.value = true;
  curlOn.value = true;
  return true;
}

/** smoothstep 驱动进度；`onDone(token)` 仅在本次动画仍有效时回调 */
function runCurlAnim(from: number, to: number, ms: number, onDone: (token: number) => void): void {
  const token = ++curlToken;
  curlStartAt = performance.now();
  if (curlRaf) cancelAnimationFrame(curlRaf);
  const tick = (now: number): void => {
    if (token !== curlToken) return;
    const t = Math.min(1, Math.max(0, (now - curlStartAt) / Math.max(1, ms)));
    const e = t * t * (3 - 2 * t); // 起手不急、收尾不撞
    curlProgress.value = from + (to - from) * e;
    if (t >= 1) { onDone(token); return; }
    curlRaf = requestAnimationFrame(tick);
  };
  curlRaf = requestAnimationFrame(tick);
}

/** 起手翻页：建纹理后按 CURL_MS 走到终态，交给 `PageCurl` 逐帧驱动 */
function startPageCurl(dir: -1 | 1, target: number): boolean {
  if (!prepareCurl(dir, target)) return false;
  runCurlAnim(dir === 1 ? 0 : 1, dir === 1 ? 1 : 0, CURL_MS, (token) => finishPageCurl(token));
  return true;
}

/** 卷曲收尾：**先撤覆盖层再改页码**，同一 tick 完成 ⇒ 不闪、不重排 */
function finishPageCurl(token: number): void {
  if (token !== curlToken) return;
  if (curlRaf) { cancelAnimationFrame(curlRaf); curlRaf = 0; }
  const target = curlTargetPage;
  curlOn.value = false;
  gotoPage(target);
  const pend = curlPendingDir;
  curlPendingDir = 0;
  if (pend) {
    const t = curPage.value + pend;
    if (t >= 1 && t <= pageCount.value) { startPageCurl(pend, t); return; }
  }
  scheduleCurlWarm();
  scheduleCurlNeighborWarm();
}

function abortCurl(): void {
  curlToken += 1;
  if (curlRaf) { cancelAnimationFrame(curlRaf); curlRaf = 0; }
  curlOn.value = false;
  curlPendingDir = 0;
  curlHop = null;
  curlDrag = null;
}

/**
 * 预热相邻页纹理（`setTimeout` 而非 `requestIdleCallback`：后者在后台标签页可能几秒不跑）。
 * 只画缓存，不动 DOM、不碰页表。
 */
function scheduleCurlWarm(): void {
  if (curlWarmTimer) window.clearTimeout(curlWarmTimer);
  curlWarmTimer = window.setTimeout(() => {
    curlWarmTimer = 0;
    if (!pagedActive.value || pageAnim.value !== 2 || curlOn.value) return;
    const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
    if (!view) return;
    const st = curlStyleOf(view);
    if (!st) return;
    const rect = view.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 40 || h < 40) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const geo = { w, h, dpr };
    const sig = curlSig(st.sig, geo);
    for (const p of [curPage.value + 1, curPage.value - 1]) {
      if (p >= 1 && p <= pageCount.value) curlTextureOf(p, geo, st.style, sig);
    }
  }, 220);
}

/**
 * 跨章拖拽的**相邻章首屏/末屏**预载（用户 2026-11-09：跨章要能拖拽、跟手）。
 *
 * ## 为什么内容预载还不够
 * `reader` store 会提前把后面几章**正文**取进内存/IndexedDB（`PRELOAD_MAX=8`），但**页表只量当前章**
 * （`usePagedChapter` 只持有当前章的 `pages`）。于是章边界拖拽时拿不到「下一章首页」的切片，
 * 只能等切章 + 重新排版完再播动画（旧实现的 `beginCurlHop`）。
 *
 * 这里在**落到章首/章末页时**提前把相邻章的页表量出来，只留首屏（dir=1）或末屏（dir=-1）的纹理；
 * 拖拽起卷直接用这张纹理当正面/底板，松手后照常切章，等新章页表就绪再补完动画。
 * 与 Legado 上游同构：`prevChapter/nextChapter` 是**已排好版**的 `TextChapter`，
 * `nextPage()/prevPage()` 跨章时直接拿邻章首页/末页（见 `docs/ref/2026-11-07-reader-pagination-scroll-comic-research.md`）。
 */
interface CurlNeighborPage {
  chIdx: number;
  sig: string;
  geo: { w: number; h: number; dpr: number };
  tex: HTMLCanvasElement;
}
let curlNeighborNext: CurlNeighborPage | null = null;
let curlNeighborPrev: CurlNeighborPage | null = null;
let curlNeighborTimer = 0;

function dropCurlNeighbor(): void {
  curlNeighborNext = null;
  curlNeighborPrev = null;
  if (curlNeighborTimer) { window.clearTimeout(curlNeighborTimer); curlNeighborTimer = 0; }
}

/** 落到章首/章末页后延迟预热（留一帧给翻页收尾；不与在途卷曲抢纹理） */
function scheduleCurlNeighborWarm(delay = 80): void {
  if (!canCurlAnim() || curlOn.value || curlHop) return;
  if (curlNeighborTimer) window.clearTimeout(curlNeighborTimer);
  curlNeighborTimer = window.setTimeout(() => {
    curlNeighborTimer = 0;
    void warmCurlNeighbors();
  }, delay);
}

async function warmCurlNeighbors(): Promise<void> {
  if (!canCurlAnim() || curlOn.value || curlHop || !paged.ready.value) return;
  if (curPage.value >= pageCount.value) void warmCurlNeighbor(1);
  if (curPage.value <= 1) void warmCurlNeighbor(-1);
}

/** 量相邻章页表 → 只画首屏/末屏纹理（正文走 store 的预载，通常内存/磁盘命中） */
async function warmCurlNeighbor(dir: -1 | 1): Promise<void> {
  const fromIdx = r.chapterIdx;
  const targetIdx = readableNeighborIdx(dir);
  if (targetIdx === null) return;
  const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
  if (!view) return;
  const st = curlStyleOf(view);
  if (!st) return;
  const rect = view.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w < 40 || h < 40) return;
  const geo = { w, h, dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)) };
  const sig = `${curlSig(st.sig, geo)}|n${targetIdx}`;
  const slot = dir === 1 ? curlNeighborNext : curlNeighborPrev;
  if (slot && slot.sig === sig) return;
  const base = buildPagedInput();
  if (!base) return;
  let sec: Awaited<ReturnType<typeof r.loadNeighborChapter>>;
  try {
    sec = await r.loadNeighborChapter(targetIdx);
  } catch {
    return; // 卷标题 / 网络失败：保留旧缓存，拖拽时按原兜底走
  }
  if (!sec.paragraphs.length) return;
  const layout = await measureChapterPages({
    ...base,
    chapterKey: `${r.sourceId ?? ''}|${targetIdx}|${sec.title}`,
    paragraphs: sec.paragraphs,
    title: { ...base.title, text: sec.title },
  });
  if (!layout || !layout.pages.length) return;
  // 测量期间可能已换章 / 翻离边界 / 退出仿真档 ⇒ 结果作废（绝不覆盖正在用的纹理）
  if (!canCurlAnim() || curlOn.value || r.chapterIdx !== fromIdx) return;
  if (dir === 1 ? curPage.value < pageCount.value : curPage.value > 1) return;
  const chunks = dir === 1 ? layout.pages[0] : layout.pages[layout.pages.length - 1];
  if (!chunks?.length) return;
  const hasTitle = chunks.some((c) => c.para < 0);
  const tex = paintTextPage({
    width: w,
    height: h,
    dpr: geo.dpr,
    paragraphs: sec.paragraphs,
    chunks,
    title: hasTitle ? sec.title : null,
    style: st.style,
  });
  const entry: CurlNeighborPage = { chIdx: targetIdx, sig, geo, tex };
  if (dir === 1) curlNeighborNext = entry;
  else curlNeighborPrev = entry;
}

/** 取当前有效的预载纹理（章节/版式/尺寸任一变化都会失配 ⇒ 返回 null 走旧兜底） */
function curlNeighborOf(dir: -1 | 1): CurlNeighborPage | null {
  const c = dir === 1 ? curlNeighborNext : curlNeighborPrev;
  if (!c) return null;
  const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
  if (!view) return null;
  const st = curlStyleOf(view);
  if (!st) return null;
  const rect = view.getBoundingClientRect();
  const geo = {
    w: Math.max(1, Math.round(rect.width)),
    h: Math.max(1, Math.round(rect.height)),
    dpr: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
  };
  return c.sig === `${curlSig(st.sig, geo)}|n${c.chIdx}` ? c : null;
}

/**
 * 章边界**拖拽起卷**：正面/底板直接取「当前页 + 预载的邻章首屏/末屏」，
 * 不等切章完成 ⇒ 拖拽过程中就有卷曲、跟手。
 */
function prepareCurlHopDrag(dir: -1 | 1): boolean {
  if (!canCurlAnim()) return false;
  const nb = curlNeighborOf(dir);
  const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
  const st = view ? curlStyleOf(view) : null;
  if (!nb || !view || !st) return false;
  const geo = nb.geo;
  const sig = curlSig(st.sig, geo);
  const cur = curlTextureOf(curPage.value, geo, st.style, sig);
  if (!cur) return false;
  curlWidth.value = geo.w;
  curlHeight.value = geo.h;
  curlDpr.value = geo.dpr;
  curlDir.value = dir;
  if (dir === 1) {
    curlFront.value = cur; // 当前章末页被翻走
    curlBack.value = paintBackOf(cur, { background: st.style.background });
    curlNext.value = nb.tex; // 下一章首屏已在底下
    curlProgress.value = 0;
  } else {
    curlFront.value = nb.tex; // 上一章末屏作为被翻回来的那一页
    curlBack.value = paintBackOf(nb.tex, { background: st.style.background });
    curlNext.value = cur; // 当前章首页在底下
    curlProgress.value = 1;
  }
  curlTargetPage = 0;
  curlMounted.value = true;
  curlOn.value = true;
  curlHop = { dir }; // 标记「跨章在途」：换章 watcher 不得撤掉覆盖层
  return true;
}

/**
 * 跨章卷曲「起手」：先把**旧章当前页**冻在覆盖层上（此刻新章还没取到）。
 * dir=1 时旧页当正面（进度 0 铺满）；dir=-1 时旧页当底板（进度 1 铺满）。
 */
function beginCurlHop(dir: -1 | 1): boolean {
  if (!canCurlAnim() || curlOn.value || curlHop) return false;
  const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
  if (!view) return false;
  const st = curlStyleOf(view);
  if (!st) return false;
  const rect = view.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (w < 40 || h < 40) return false;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const geo = { w, h, dpr };
  const cur = curlTextureOf(curPage.value, geo, st.style, curlSig(st.sig, geo));
  if (!cur) return false;

  curlWidth.value = w;
  curlHeight.value = h;
  curlDpr.value = dpr;
  curlDir.value = dir;
  curlProgress.value = dir === 1 ? 0 : 1;
  if (dir === 1) {
    curlFront.value = cur;
    curlBack.value = paintBackOf(cur, { background: st.style.background });
    curlNext.value = null;
  } else {
    curlFront.value = null;
    curlBack.value = null;
    curlNext.value = cur;
  }
  curlTargetPage = 0;
  curlMounted.value = true;
  curlOn.value = true;
  curlHop = { dir };
  return true;
}

/** 新章页表就绪后：补另一页纹理，再用**同一套**卷曲动画收尾（不是无动画直跳） */
function animateCurlHop(dir: -1 | 1, target: number): void {
  if (!curlHop) return;
  const view = pageBodyEl.value?.querySelector<HTMLElement>('.se-paged-view');
  const st = view ? curlStyleOf(view) : null;
  if (!view || !st) { cancelCurlHop(); gotoPage(target); return; }
  const rect = view.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const geo = { w, h, dpr };
  const tex = curlTextureOf(target, geo, st.style, curlSig(st.sig, geo));
  if (!tex) { cancelCurlHop(); gotoPage(target); return; }
  curlWidth.value = w;
  curlHeight.value = h;
  curlDpr.value = dpr;
  if (dir === 1) {
    curlNext.value = tex;
  } else {
    curlFront.value = tex;
    curlBack.value = paintBackOf(tex, { background: st.style.background });
  }
  curlTargetPage = target;
  curlHop = null; // 进入动画阶段：换章 watcher 可以正常收尾
  // ★ 拖拽跨章时进度可能已过半：**从当前进度补完**，不再从 0/1 重头播（否则会「弹回去再翻」）
  const from = Math.min(1, Math.max(0, curlProgress.value));
  const to = dir === 1 ? 1 : 0;
  runCurlAnim(from, to, Math.max(140, CURL_MS * Math.abs(to - from)), (token) => finishPageCurl(token));
}

function cancelCurlHop(): void {
  curlHop = null;
  abortCurl();
}

function canCurlAnim(): boolean {
  return pagedActive.value && pageAnim.value === 2 && !reducedMotionNow();
}

// —— 「仿真」档手势拖拽：与点击共用正文区，所以先给死区、只认横向，并压掉拖后 click ——

/**
 * 用户 2026-11-10：**落点是否在可划选的正文文字上**（此时浏览器显示 I-beam）。
 *
 * 为什么需要它：仿真翻页的拖拽监听挂在整块正文上，`pointerdown` 一按就把选区 `removeAllRanges()`
 * 并接管指针 ⇒ 正文里的文字永远选不中。判据用 `caretRangeFromPoint`（Chromium/WebKit）：
 * 落点的插入符落在**文本节点**、且落点就在插入符旁边的**字符盒**里 ⇒ 这一下按在字上，
 * 应当交给浏览器做划选；页边、页底留白、行尾空白以外的区域 ⇒ 不是 I-beam，拖拽仍归卷曲。
 *
 * ⚠️ 只对鼠标生效：触屏没有 I-beam，手指拖拽本来就该翻页。
 *
 * ⚠️ `caretRangeFromPoint` 会把「页边留白 / 页底留白 / 行尾空白」**吸附到最近的文字节点**，
 * 只看 `nodeType === TEXT_NODE` 会把这些空白也判成 I-beam ⇒ 整页几乎无处可起卷（探针实测：
 * 页底留白、左右 16px 页边全被拦）。所以还必须校验落点是否真的在**插入符附近那个字符盒**里，
 * 垂直方向按行高补足上下 half-leading（I-beam 覆盖整条行盒）。
 */
function hitReaderText(x: number, y: number): boolean {
  const d = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const range = d.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.nodeValue ?? '';
  // 空文本节点（缩进/换行）不产生 I-beam，不能当成「按在字上」
  if (!/\S/.test(text)) return false;
  const el = node.parentElement;
  if (!el || !el.closest('.rd-content, .se-paged-view, .se-body')) return false;
  if (getComputedStyle(el).userSelect === 'none') return false;
  // 取插入符旁边那个字符的盒子（偏移在末尾时退一格）
  const off = range.startOffset;
  const idx = /\S/.test(text[off] ?? '') ? off : Math.max(0, off - 1);
  const charRange = document.createRange();
  charRange.setStart(node, Math.min(idx, Math.max(0, text.length - 1)));
  charRange.setEnd(node, Math.min(idx + 1, text.length));
  const rc = charRange.getBoundingClientRect();
  if (!rc.width && !rc.height) return false;
  const lh = parseFloat(getComputedStyle(el).lineHeight);
  // 行高 > 字高时，上下各补 half-leading；再留 2px 取整容差
  const padY = Math.max(3, (Number.isFinite(lh) ? (lh - rc.height) / 2 : 0) + 2);
  // 水平只留小半字宽：行尾空白再往右就交给拖拽翻页
  const padX = Math.max(4, rc.height * 0.35);
  return x >= rc.left - padX && x <= rc.right + padX && y >= rc.top - padY && y <= rc.bottom + padY;
}

function onCurlPointerDown(e: PointerEvent): void {
  if (!canCurlAnim() || curlOn.value || curlHop) return;
  if (!e.isPrimary) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const t = e.target as HTMLElement | null;
  // 链接/表单/媒体等交互元素上不抢手势
  if (t?.closest('a, button, input, textarea, select, [contenteditable="true"], .rd-media')) return;
  /**
   * ★ 用户 2026-11-10：「一压鼠标就没法选字」。按在正文文字上（I-beam）且**当前没有选区**时
   * 直接放行，让浏览器原生划选接管（不预置 curl、不抢指针、不清选区）。
   * 已经有选区时再拖 = 用户划完了想继续翻页（用户明确要求「划选结束后再拖仍然能翻页」）⇒
   * 撤掉选区后照常起卷。
   */
  if (e.pointerType === 'mouse' && hitReaderText(e.clientX, e.clientY)) {
    const sel = window.getSelection();
    const hasSelection = !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
    if (!hasSelection) return;
    try { sel?.removeAllRanges(); } catch { /* 无选区 */ }
  }
  curlDrag = {
    pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
    dir: 1, started: false, edge: false, hop: false,
    lastX: e.clientX, lastAt: performance.now(), velocity: 0,
  };
}

function onCurlPointerMove(e: PointerEvent): void {
  const d = curlDrag;
  if (!d || d.pointerId !== e.pointerId) return;
  const dx = e.clientX - d.startX;
  const dy = e.clientY - d.startY;
  if (!d.started) {
    // 10px 死区：普通的点按（点击翻页）不受影响；纵向滑动也不当成翻页
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    d.dir = dx < 0 ? 1 : -1;
    d.started = true;
    const target = curPage.value + d.dir;
    // 章边界：页表里没有目标页。**预载了邻章首屏/末屏就直接起卷（跟手）**；
    // 没预载才退回旧行为（拖出去只记账，松手后再播完整动画）。
    if (target < 1 || target > pageCount.value) {
      if (!prepareCurlHopDrag(d.dir)) { d.edge = true; return; }
      d.hop = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已释放 */ }
      try { window.getSelection()?.removeAllRanges(); } catch { /* 无选区 */ }
      return;
    }
    if (!prepareCurl(d.dir, target)) { d.edge = true; return; }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指针已释放 */ }
    try { window.getSelection()?.removeAllRanges(); } catch { /* 无选区 */ }
  }
  if (d.edge) return;
  const w = Math.max(1, curlWidth.value);
  const p = Math.min(1, Math.max(0, Math.abs(dx) / w));
  curlProgress.value = d.dir === 1 ? p : 1 - p;
  const now = performance.now();
  const dt = now - d.lastAt;
  if (dt > 0) d.velocity = (e.clientX - d.lastX) / dt;
  d.lastX = e.clientX;
  d.lastAt = now;
  if (e.cancelable) e.preventDefault();
}

function onCurlPointerUp(e: PointerEvent): void {
  const d = curlDrag;
  if (!d || d.pointerId !== e.pointerId) return;
  curlDrag = null;
  if (!d.started) return;
  curlDragEndAt = performance.now();
  if (d.edge) {
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) >= 40) {
      if (d.dir === 1) void nextChapterPastEnd();
      else void prevChapterToEnd();
    }
    return;
  }
  const p = curlProgress.value;
  // 已翻过的比例（两个方向同一口径）；再叠一个「甩」的判据，短促快拖也能翻过去
  const pulled = d.dir === 1 ? p : 1 - p;
  const fling = d.dir === 1 ? -d.velocity : d.velocity;
  const done = pulled > 0.28 || (fling > 0.6 && pulled > 0.06);
  if (d.hop) {
    if (done) {
      // 覆盖层保持当前进度（不闪断）：切章 + 重新排版完成后由 `animateCurlHop` 从这里补完
      if (d.dir === 1) void nextChapterPastEnd(true);
      else void prevChapterToEnd(true);
    } else {
      // 没拖到位：弹回本页（邻章纹理丢弃，页码不动）
      runCurlAnim(p, d.dir === 1 ? 0 : 1, Math.max(120, CURL_MS * pulled), () => {
        curlHop = null;
        curlOn.value = false;
      });
    }
    return;
  }
  if (done) {
    runCurlAnim(p, d.dir === 1 ? 1 : 0, Math.max(140, CURL_MS * (1 - pulled)), (token) => finishPageCurl(token));
  } else {
    // 没拖到位：按原路弹回，页码不动
    runCurlAnim(p, d.dir === 1 ? 0 : 1, Math.max(120, CURL_MS * pulled), () => {
      curlOn.value = false;
    });
  }
}

// 换章 / 换源：**跨章卷曲自己引起的换章除外**（旧页 canvas 要盖着新章等页表就绪）
watch(
  () => [r.chapterIdx, r.sourceId],
  () => {
    curlCache.clear();
    dropCurlNeighbor();
    if (!curlOn.value || curlHop) return;
    abortCurl();
    scheduleCurlNeighborWarm(360);
  },
);

// 换档 / 退出分页：任何在途动画（含跨章）立刻作废，否则旧页 canvas 会盖住新章节
watch(
  () => [pageAnim.value, pagedActive.value],
  () => {
    curlDrag = null;
    dropCurlNeighbor();
    if (curlOn.value) { curlHop = null; abortCurl(); }
    scheduleCurlNeighborWarm(360);
  },
);

// 落到章首/章末页 ⇒ 预热相邻章首屏/末屏纹理（拖拽跨章要「起卷就有画面」）
watch(
  () => [curPage.value, pageCount.value],
  () => scheduleCurlNeighborWarm(),
);

/** 末页再往后 ⇒ 接下一章（滚动模式里 `fillViewport` 已有等价逻辑，分页是同一条边界） */
async function nextChapterPastEnd(fromDrag = false): Promise<void> {
  const lastIdx = (r.detail?.chapters?.length ?? 0) - 1;
  if (!(r.chapter && r.chapterIdx < lastIdx)) {
    if (fromDrag && curlHop) cancelCurlHop();
    return;
  }
  // `fromDrag`：拖拽已经在 `prepareCurlHopDrag` 里起卷并置好 `curlHop`，这里不得重入拦截
  if (curlHop && !fromDrag) return;
  const hop = curlHop ? true : beginCurlHop(1);
  const p = r.chOffset(1);
  if (!p) { if (hop) cancelCurlHop(); return; }
  if (!hop) { await p; return; } // 非仿真档：与旧逻辑一致（直接切章）
  await p;
  await nextTick();
  if (r.detailErr) { cancelCurlHop(); return; }
  paged.cancel();
  let built = await runPagedRebuild();
  if (!built) built = await runPagedRebuild();
  if (!built || !pagedActive.value) { cancelCurlHop(); return; }
  animateCurlHop(1, 1); // 下一章落点 = 首页
}

/**
 * 在途「切上一章并落末页」的目标章下标（`null` = 没有在途）。
 *
 * ★ 为什么必须排队：`chOffset(-1)` 只是把 `chapterIdx` 改掉并**异步**取正文。
 * 若立刻量页，量的是**旧章**（`chapter` 还没换）⇒ `gotoPage(pageCount)` 拿到旧页数；
 * 等新正文到位后页码又被重置成 1 —— 用户看到的就是「点上一页没反应 / 跳到上一章第一页」。
 * 所以记住目标章，等 `openChapter` 的 Promise 落地后再量、再落末页；期间显示加载态。
 */
const pendingTailFor = ref<number | null>(null);

/**
 * `#244` / `#829` **首页往前 ⇒ 进上一章的末页**。
 *
 * ## 上游语义（`F:\legado` 已核对）
 * · `TextPageFactory.moveToPrev()`：`pageIndex <= 0` 且 `hasPrevChapter()` ⇒
 *   `ReadBook.moveToPrevChapter(toLast = true)`，其中 `durChapterPos = prevTextChapter.lastReadLength`
 *   ⇒ 落点是**上一章的最后一页**（不是上一章首页）。
 * · 第 1 章首页再往前 ⇒ `moveToPrevChapter` 因 `durChapterIndex == 0` 返回 false，
 *   界面由 `PageDelegate.hasPrev()` 弹 Snackbar「没有上一页」⇒ **明确提示，不静默**。
 *   本仓对应「左边闪一下 + toast 已是第一页」。
 * · 上一章还没排完版时上游直接 `return false`（`prevChapter.isCompleted == false`）；
 *   本仓按用户要求改成「显示加载态 + 排队，加载完自动落末页」，不吞掉这次翻页。
 *
 * ## 根因（本轮修复）
 * ① 翻页胶囊的「‹」写了 `:disabled="curPage <= 1"` ⇒ 第 N 章首页时按钮直接变灰，
 *    `@click` 根本不会触发（不是章边界判断写错，而是**按钮把章边界也当成页边界**禁掉了）。
 * ② 即便触发，旧实现 `chOffset(-1) → nextTick → 量页` 量的是**尚未换掉的旧章**，
 *    新章正文异步到达后又被重置为第 1 页 ⇒ 净效果仍是「没反应」。
 * ③ `#832`：重建失败 / 阅读模式在加载中被切走时不再静默 `return` —— 给出明确 toast
 *    （「点了没反应」是用户报障的原始症状，静默分支不能留）。
 */
async function prevChapterToEnd(fromDrag = false): Promise<void> {
  if (!r.chapter) return;
  // `fromDrag`：拖拽已经在 `prepareCurlHopDrag` 里起卷并置好 `curlHop`
  if (curlHop && !fromDrag) return;
  if (r.chapterIdx <= 0 || pendingTailFor.value !== null) {
    if (r.chapterIdx <= 0) {
      edgeFlash.value = -1;
      window.setTimeout(() => { edgeFlash.value = 0; }, 260);
      toast('已是第一页', 'info');
    }
    if (fromDrag && curlHop) cancelCurlHop();
    return;
  }
  // 仿真档：先把旧章首页冻在覆盖层上，等上一章页表就绪后再播卷曲（不留「无动画直跳」）
  const hop = curlHop ? true : beginCurlHop(-1);
  const p = r.chOffset(-1); // `openChapter` 会**同步**改 `chapterIdx`，正文异步到达
  const target = r.chapterIdx;
  if (!p) {
    if (hop) cancelCurlHop();
    // `#832` 上游在第 1 章首页明确提示「没有上一页」⇒ 这里也不能静默
    edgeFlash.value = -1;
    window.setTimeout(() => { edgeFlash.value = 0; }, 260);
    toast('没有上一章', 'info');
    return;
  }
  pendingTailFor.value = target; // 加载态 + 防重入（重复点不会叠请求）
  await p;                       // 成功 / 失败都会 resolve（失败写 `detailErr`）
  if (pendingTailFor.value !== target) { if (hop) cancelCurlHop(); return; } // 期间切了模式 / 换了章
  if (r.chapterIdx !== target || r.detailErr) {
    pendingTailFor.value = null;
    if (hop) cancelCurlHop();
    toast(r.detailErr ? '上一章加载失败，请重试' : '上一章不可读', 'warn');
    return;
  }
  await nextTick();
  // 正文已到位：先把可能还在量的「旧章布局」作废，再按新章量（命中签名会秒过）
  paged.cancel();
  let built = await runPagedRebuild();
  if (!built) built = await runPagedRebuild(); // 被更晚的一次重建取代 ⇒ 再收一次，避免把旧页数当末页
  if (pendingTailFor.value !== target || r.chapterIdx !== target) { if (hop) cancelCurlHop(); return; }
  pendingTailFor.value = null;
  // `#832` 不允许「点了没反应」：重建失败 / 模式已切走都要有明确反馈
  if (!pagedActive.value) { if (hop) cancelCurlHop(); toast('阅读模式已切换，本次「上一章」翻页已取消', 'info'); return; }
  if (!built) { if (hop) cancelCurlHop(); toast('上一章排版失败，请再点一次', 'warn'); return; }
  // 落点 = 上一章最后一页（页数此时必须是新章的）；仿真档用同一套卷曲收尾
  if (hop) animateCurlHop(-1, pageCount.value);
  else gotoPage(pageCount.value);
}

/**
 * 「上一页」按钮 / 点正文左侧的**共同**入口（与 `onPageNextClick` 对称）。
 * ★ 不能是 `turnPage(-1) || prevChapterToEnd()`：`||` 两侧都会求值，会「翻页的同时切章」。
 */
function onPagePrevClick(): void {
  if (turnPage(-1)) return;
  void prevChapterToEnd();
}

/**
 * 「下一页」按钮 / 点正文右侧的**共同**入口。
 *
 * 为什么要一个函数而不是模板里 `turnPage(1) || nextChapterPastEnd()`：
 * `turnPage` 返回 `boolean`（用来告诉调用方「翻不动」），
 * 而 `||` 表达式**每次都会求值右侧**（`turnPage` 为真时也会调 `nextChapterPastEnd`）
 * ⇒ 会出现「翻到第 2 页的同时跳到下一章」。这类错误模板不报错、只在真机上偶发。
 */
function onPageNextClick(): void {
  if (turnPage(1)) return;
  void nextChapterPastEnd();
}

// 正文图：**主路走服务端代理**（防盗链 Referer + 源图片解密 + 动图原样透传），
// 代理仍失败才回退直连（例如服务端不可用时至少还能试一下裸连），最后隐藏。
const srcOf = (p: string) => imgOverride.value[p] ?? imgSrc(p, { sourceId: r.sourceId });
function onImgError(p: string, ev: Event) {
  if (!imgOverride.value[p]) {
    imgOverride.value[p] = p; // 代理失败 → 回退直连
  } else {
    (ev.target as HTMLImageElement).style.visibility = 'hidden';
  }
}

// 换章后滚动容器回到顶部（否则新章内容从上次的滚动位置开始 → 看起来像「新图接在旧图后面」）
// 同时清掉**按下标索引**的图片状态（换章后下标含义全变了）并重算进度
//
// ★ `#224` **它就是 `.se-body`（= 分页模式的正文格）**，两个 ref 指向同一个 DOM 节点。
//   之所以不合并成一个：`bodyEl` 记的是「正文块」（选区定位 / 朗读跟随 / 章内工具条都按它算），
//   `pageBodyEl` 记的是「分页容器」（量页宽/页高喂给 `buildPagedInput()`）。
//   语义不同、以后可能拆开，但**现在**共用一个元素 —— 模板上写 `:ref="setBodyEl"`（回调 ref），
//   一次赋值同步两个，避免模板写两个 ref 绑同一节点那种「谁后绑谁赢」的坑。
const bodyEl = ref<HTMLElement | null>(null);
/** `#224` **分页模式的正文格** = `.se-body`。只在分页时量它的宽高（喂 `buildPagedInput()`），滚动模式不碰。 */
const pageBodyEl = ref<HTMLElement | null>(null);
/** 模板用的 ref 回调：一次赋值同步到两个语义 ref */
function setBodyEl(el: unknown): void {
  const e = (el as HTMLElement | null) ?? null;
  const changed = pageBodyEl.value !== e;
  bodyEl.value = e;
  pageBodyEl.value = e;
  // `#825` 分页：DOM 刚拿到时布局还没定 ⇒ 排队一次重建（`schedulePagedRebuild` 内部节流/去重）。
  // `#811`：详情页不再挂分页几何 ⇒ 只有「真的在阅读」才排队重量
  if (changed && e && pagedActive.value) schedulePagedRebuild(0);
}
/* ==================== `#833` 滚动模式「无限滚动」 ==================== */

/**
 * 触底**提前量**：约 1 屏（内部常量，不对用户暴露）。
 * 上游 Legado 是「页边界」触发 + 等量位移补偿；`reader` 项目向下留 480px。
 * 我们按容器高度算，滚到章末前就开始接下一章，避免「触底才加载」的白屏。
 */
const INF_BOTTOM_SCREENS = 1;
/** 顶部**提前量**（px）：距章首 200px 内开始接上一章（`reader` 是 12px，这里留更大余量） */
const INF_TOP_PX = 200;
/** 失败后的冷却（ms）：就地显示重试按钮，冷却期内滚动不再自动重试 */
const INF_RETRY_COOLDOWN = 20000;

/** 拼接用的相邻章（已净化、纯文本；HTML/媒体章不拼接，给「打开本章」入口） */
interface InfSection {
  idx: number;
  title: string;
  paragraphs: string[];
  subContent: string;
  /** 源按钮 / 本章说（`-1` = 章末条）：拼接段也要渲染，交接前后都不卸载（用户 2026-11-10） */
  uiMarks: ContentUiMark[];
}

/** 当前章**之前 / 之后**已拼上来的章节（各最多一章，交接后重新加载下一章） */
const infPrev = ref<InfSection | null>(null);
const infNext = ref<InfSection | null>(null);
const infPrevLoading = ref(false);
const infNextLoading = ref(false);
const infPrevErr = ref('');
const infNextErr = ref('');
/** 到全书首尾（没有可读的相邻章）——就地提示，不反复触发 */
const infPrevEdge = ref(false);
const infNextEdge = ref(false);
let infPrevRetryAt = 0;
let infNextRetryAt = 0;
/** 用户先离开顶部、再回到顶部才允许向上加载（`reader` 的 armed 机制） */
let infArmedUp = false;
/**
 * ★ `#835` **最近一次滚动方向**（1 下 / -1 上）。
 *
 * 交接只允许沿用户正在滚的方向发生：旧实现是 `if (下一章) {...} else if (上一章) {...}`，
 * 于是「向上交接后旧章变成下一章」时，上一章的判定被 `infNext` 永久挡住 ⇒
 * 用户继续往上滚、到上一章章首后**再也拼不出更早的章**（探针实测卡在 scrollTop=0）。
 * 反过来若两个分支都无条件判，短章在交界处会来回互相交接。
 * 用方向闸门：向下滚只判「接下一章」，向上滚只判「接上一章」。
 */
let infLastSt = 0;
let infScrollDir = 0;
/** 代次：换章 / 关开关 / 切视图 ⇒ 在途相邻章结果作废 */
let infGen = 0;
/** 交接中（把拼接章变成「当前章」），期间不再触发新一轮加载 */
const infAdopting = ref(false);
/**
 * 交接标记：`chapter` watcher 看到它时**不清零滚动位置**（换章是交接造成的，不是用户手动切章）。
 * 具体落点由 `infAdopt` 在**新正文渲染完之后**按段落锚点校正（见 `measureAnchor`），
 * 所以这里只留一个「正在交接」的身份，不再存偏移量。
 */
const infAdoptTarget = ref<{ idx: number } | null>(null);

/** 无限滚动只在「滚动视图 + 纯文本正文」下生效；分页 / 漫画 / 网页 / PDF / 媒体都不参与 */
const infiniteActive = computed(
  () => r.viewMode === 'scroll' && r.infiniteScroll && !!r.chapter
    && !isPaged.value && !isComic.value && !isPdfChapter.value && !isHtmlChapter.value && !isMedia.value,
);

/** 相邻可读章（跳过卷标题行）；没有则 `null` */
function infNeighborIdx(dir: -1 | 1): number | null {
  const chs = r.detail?.chapters ?? [];
  let i = r.chapterIdx + dir;
  while (i >= 0 && i < chs.length && chs[i]?.isVolume) i += dir;
  return i >= 0 && i < chs.length ? i : null;
}

/** 清空拼接状态（换章 / 切视图 / 关开关 / 卸载） */
function infResetState(): void {
  infGen++;
  infPrev.value = null;
  infNext.value = null;
  infPrevLoading.value = false;
  infNextLoading.value = false;
  infPrevErr.value = '';
  infNextErr.value = '';
  infPrevEdge.value = false;
  infNextEdge.value = false;
  infPrevRetryAt = 0;
  infNextRetryAt = 0;
  infArmedUp = false;
  infLastSt = 0;
  infScrollDir = 0;
  infAdoptTarget.value = null;
  infAdopting.value = false;
}

/**
 * 加载一章相邻正文并拼到当前章前/后。
 *
 * 向上（dir = -1）插入会**前插**，必须先记录「保留的当前章」在视口里的 top，
 * 插入完成后按差值拨 `scrollTop`（等价上游 `pageOffset ± pageHeight` 的补偿）——
 * 否则内容会整体下移，看起来像「跳走」。
 */
async function infLoad(dir: -1 | 1): Promise<void> {
  if (!infiniteActive.value) return;
  const slot = dir === 1 ? infNext : infPrev;
  const loading = dir === 1 ? infNextLoading : infPrevLoading;
  const err = dir === 1 ? infNextErr : infPrevErr;
  const edge = dir === 1 ? infNextEdge : infPrevEdge;
  const retryAt = dir === 1 ? infNextRetryAt : infPrevRetryAt;
  if (slot.value || loading.value) return;
  if (edge.value) return;
  if (err.value && Date.now() < retryAt) return;
  const target = infNeighborIdx(dir);
  if (target === null) {
    edge.value = true;
    return;
  }
  const gen = infGen;
  const body = pageBodyEl.value;
  const cur = body?.querySelector<HTMLElement>('[data-inf-current]');
  const beforeTop = cur ? cur.getBoundingClientRect().top : 0;
  loading.value = true;
  err.value = '';
  try {
    const sec = await r.loadNeighborChapter(target);
    if (gen !== infGen || !infiniteActive.value) return;
    /**
     * ★ `#835` **插入与「加载占位条消失」必须在同一拍**：占位条在拼接段上方，
     * 若它晚一拍消失，前插后的布局会变两次（段落下移一次、占位条消失再上移一次），
     * 于是补偿要写两次 `scrollTop` —— 第二次发生在用户已开始滚动之后，看起来就是「回跳」。
     * 现在 `slot` 与 `loading` 同一个 tick 更新 ⇒ 只量一次、只补一次。
     */
    slot.value = sec;
    loading.value = false;
    await nextTick();
    if (gen !== infGen) return;
    if (dir === -1) {
      const body2 = pageBodyEl.value;
      const cur2 = body2?.querySelector<HTMLElement>('[data-inf-current]');
      if (body2 && cur2) {
        const delta = cur2.getBoundingClientRect().top - beforeTop;
        if (Math.abs(delta) >= 1) body2.scrollTop += delta;
      }
    }
  } catch (e) {
    if (gen !== infGen) return;
    const code = (e as Error & { code?: string }).code;
    if (dir === 1) infNextRetryAt = Date.now() + INF_RETRY_COOLDOWN;
    else infPrevRetryAt = Date.now() + INF_RETRY_COOLDOWN;
    err.value = code === 'INF_NOT_TEXT'
      ? '该章不是纯文本正文（网页 / 媒体），无法拼接'
      : '加载失败：' + String(e instanceof Error ? e.message : e);
  } finally {
    if (gen === infGen) loading.value = false;
  }
}

/** 就地重试（清冷却 + 清错误，再走同一加载路径） */
function infRetry(dir: -1 | 1): void {
  if (dir === 1) { infNextErr.value = ''; infNextRetryAt = 0; } else { infPrevErr.value = ''; infPrevRetryAt = 0; }
  void infLoad(dir);
}

/**
 * 把**已经拼上来**的相邻章交接成「当前章」（更新目录高亮 / 进度 / 页眉）。
 *
 * 为什么要交接而不是永久靠拼接：`chapter` 是阅读器唯一真相源（进度、朗读、高亮、目录全读它）。
 * 交接用 `scrollTop` 落点保持视觉位置；朗读进行中**不交接**（否则会打断当前句）。
 */
async function infAdopt(dir: -1 | 1): Promise<void> {
  if (infAdopting.value || infAdoptTarget.value) return;
  if (al.active) return; // 朗读中不切章
  const sec = dir === 1 ? infNext.value : infPrev.value;
  if (!sec) return;
  const ch = (r.detail?.chapters ?? [])[sec.idx];
  if (!ch) return;
  // 交接落点用**段落锚点**而非 section 顶部：拼接段把章标题放在 section 内，交接后标题
  // 回到 `.se-body` 的 h3 上，按 section 顶部对齐会差一个标题高度（实测 ~60px）。
  const measureAnchor = (idx: number): { offset: number; anchorIdx: number; anchorTopRel: number } => {
    const body = pageBodyEl.value;
    const secEl = body?.querySelector<HTMLElement>('[data-inf-idx="' + idx + '"]');
    if (!body || !secEl) return { offset: -1, anchorIdx: -1, anchorTopRel: 0 };
    const bodyRect = body.getBoundingClientRect();
    const secTop = secEl.getBoundingClientRect().top - bodyRect.top + body.scrollTop;
    const viewTop = bodyRect.top + 1;
    let anchorIdx = -1;
    let anchorTopRel = 0;
    for (const p of Array.from(secEl.querySelectorAll<HTMLElement>('p[data-inf-p]'))) {
      const pr = p.getBoundingClientRect();
      if (pr.bottom > viewTop) {
        anchorIdx = Number(p.dataset.infP ?? -1);
        anchorTopRel = pr.top - bodyRect.top;
        break;
      }
    }
    return { offset: Math.max(0, body.scrollTop - secTop), anchorIdx, anchorTopRel };
  };
  /**
   * ★ `#835` **锚点必须在换 DOM 之前量**（此刻这一章在 DOM 里只有「拼接段」这一份，
   * 量的就是用户真正看到的位置）。
   *
   * 旧实现把 `measureAnchor()` 放在 `openChapter` + `nextTick` 之后 —— 那一刻新章已经是
   * 「当前章」，而旧的拼接段还没撤 ⇒ **同一章在 DOM 里同时存在两份**，
   * `body.querySelector('[data-inf-idx="N"]')` 命中的是排在新章后面的那份副本，
   * `secTop` / `anchorIdx` 整体偏移了整整一章的高度。探针实测：当前章 16,700px 高时
   * `anchorIdx` 从 0 变成 ~57、`scrollTop` 被写到 44,565（章末附近），
   * 且随后两轮校正继续与用户滚动对抗 ⇒ 实机上就是「滚不动 / 跳回交界」。
   */
  const m = measureAnchor(sec.idx);
  // 交接也是一次「换章」：作废所有在途相邻章结果，并清掉首尾判定（新章要重新判定）
  infGen++;
  const gen = infGen;
  // 触发交接这一刻的 scrollTop：openChapter 是异步的，用户可能还在滚，
  // 换 DOM 前把这段「用户真实滚动增量」算进锚点目标里，避免补偿把用户刚滚的那几行拉回去。
  const stAtTrigger = pageBodyEl.value?.scrollTop ?? 0;
  /**
   * ★ 交接时**把旧章留在另一侧**（旧章正文已经在内存里，不用再拉一次）：
   *  · 向上交接（dir=-1）⇒ 旧章变成新的「下一章」，用户刚读到的那段下面仍有正文托底；
   *  · 向下交接（dir=1）⇒ 旧章变成新的「上一章」，往回滚不用重新加载。
   */
  const oldSec: InfSection | null = r.chapter
    ? {
      idx: r.chapterIdx,
      title: r.displayTitle ?? r.chapter.title ?? '',
      paragraphs: [...r.displayParagraphs],
      subContent: r.chapter.subContent ?? '',
      // 「本章说」跟着旧章一起留在拼接段里：交接后它仍在 DOM 上，不会消失再出现
      uiMarks: r.chapter.uiMarks ?? [],
    }
    : null;
  // 向下交接后用户是往下读的，先撤掉「向上已武装」，避免立刻把刚离开的章又拼回头上；
  // 向上交接保留武装（用户接下来很可能继续往上读）。
  if (dir === 1) infArmedUp = false;
  infAdopting.value = true;
  infAdoptTarget.value = { idx: sec.idx };
  let slotsCleared = false;
  const clearSlots = (): void => {
    if (slotsCleared) return;
    slotsCleared = true;
    infPrev.value = null;
    infNext.value = null;
    infPrevErr.value = '';
    infNextErr.value = '';
    infPrevLoading.value = false;
    infNextLoading.value = false;
    infPrevEdge.value = false;
    infNextEdge.value = false;
    infPrevRetryAt = 0;
    infNextRetryAt = 0;
  };
  try {
    await r.openChapter(ch, { cache: 'read' });
    if (gen !== infGen) { clearSlots(); return; }
    await nextTick();
    if (gen !== infGen) { clearSlots(); return; }
    if (r.chapterIdx !== sec.idx) {
      // 开章失败：清掉落点并如实提示（不留「滚到底什么都不发生」的死角）
      clearSlots();
      infAdoptTarget.value = null;
      toast('相邻章加载失败，请重试', 'warn');
      return;
    }
    // 用户在「等 openChapter」这段时间里自己滚了多少（此刻 DOM 还是拼接布局，scrollTop 有效）
    const userDelta = (pageBodyEl.value?.scrollTop ?? stAtTrigger) - stAtTrigger;
    /**
     * ★ **「换当前章」与「撤拼接段 + 旧章补到另一侧」放在同一拍**（两次 `nextTick`
     * 都在同一个微任务链里，中间不 paint）：
     *  换章前：旧章(当前) + 新章(拼接段)；
     *  换章后：新章(当前) + 旧章(拼接段)。
     * 两个时刻**总高度不变** ⇒ `scrollTop` 不会被 `maxScroll` 夹住，也不会有
     * 「同一章两份」在屏幕上被画出来（旧实现在这里留了最多 800ms 的转换等待窗口，
     * 用户截图里的错乱就是那段时间两份副本 + 标题位置错乱）。
     */
    clearSlots();
    if (oldSec && oldSec.idx !== sec.idx) {
      if (dir === -1) infNext.value = oldSec;
      else infPrev.value = oldSec;
    }
    await nextTick();
    if (gen !== infGen) return;
    const b2 = pageBodyEl.value;
    if (!b2 || m.anchorIdx < 0) return;
    const pEl = b2.querySelector<HTMLElement>(`.rd-content[data-inf-current] p[data-p="${m.anchorIdx}"]`);
    if (!pEl) return;
    /**
     * ★ 补偿**只写一次**，且在**同一个微任务链里**（清完拼接段 → 立刻落位，中间不 paint）：
     *  · 不再等简繁转换：转换只改字形不改段数，等待窗口反而让错误位置被画出来；
     *  · 不再做 rAF 跟帧校正：在 rAF 里反复写 `scrollTop` 会跟用户滚动对抗，
     *    正是实机「滚上去又跳回来」的来源（`#224` M2 同型）。
     * 目标位置 = 交接前视口顶部那一段，减去交接等待期间用户自己滚过的距离。
     */
    const dy = (pEl.getBoundingClientRect().top - b2.getBoundingClientRect().top) - (m.anchorTopRel - userDelta);
    if (Math.abs(dy) >= 2) b2.scrollTop += dy;
  } finally {
    infAdopting.value = false;
    infAdoptTarget.value = null;
    // 交接完成后再判一次边界：新章可能很短（一屏内）⇒ 接着预取它的邻章
    if (gen === infGen && infiniteActive.value) void nextTick(infOnScroll);
  }
}

/** 用「下一章占多数 / 上一章占多数」判断是否该交接；只做视口几何，不做测量 */
function infMaybeAdopt(): void {
  if (!infiniteActive.value || infAdopting.value || infAdoptTarget.value) return;
  if (al.active) return;
  const body = pageBodyEl.value;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const band = Math.min(120, rect.height * 0.25);
  // 只看用户正在滚的那一侧（见 `infScrollDir` 的说明：防止短章在交界处来回互拉）
  if (infScrollDir >= 0 && infNext.value) {
    const el = body.querySelector<HTMLElement>('[data-inf-idx="' + infNext.value.idx + '"]');
    // 下一章已经占到视口顶部 1/4 ⇒ 用户确实读进来了，交接
    if (el && el.getBoundingClientRect().top <= rect.top + band) { void infAdopt(1); return; }
  }
  if (infScrollDir <= 0 && infPrev.value) {
    const el = body.querySelector<HTMLElement>('[data-inf-idx="' + infPrev.value.idx + '"]');
    // 上一章已经占到视口 40% 以上 ⇒ 交接（不要求 scrollTop 归零，短章也能正确触发）
    if (el && el.getBoundingClientRect().bottom >= rect.top + rect.height * 0.4) void infAdopt(-1);
  }
}

/** 滚动回调里的无限滚动判定（只在滚动模式、且没有在途交接时跑） */
function infOnScroll(): void {
  if (!infiniteActive.value || infAdopting.value || infAdoptTarget.value) return;
  const body = pageBodyEl.value;
  if (!body) return;
  const st = body.scrollTop;
  const d = st - infLastSt;
  if (d > 1) infScrollDir = 1;
  else if (d < -1) infScrollDir = -1;
  infLastSt = st;
  if (st > INF_TOP_PX) infArmedUp = true;
  infMaybeAdopt();
  if (!infPrev.value && infArmedUp && st <= INF_TOP_PX) void infLoad(-1);
  if (!infNext.value && body.scrollHeight - st - body.clientHeight <= body.clientHeight * INF_BOTTOM_SCREENS) void infLoad(1);
}

/**
 * ★ `#230` **滚动容器 = `.se-scroll`（「页眉 + 正文 + 页脚」这一段）**。
 *
 * 用户 2026-10-03 的原话：「标题栏独立，这个滚动条应该是页面的：即(页眉+正文+页脚)的」，
 * 并且「阅读界面宽度不应直接最大，回到 `#222` 对宽度的修改之前」。
 * ⇒ 结构：`.se-panel`（浮层，**窄卡片、不滚**）= 标题栏 + `.se-scroll`；
 * `.se-scroll` 才是滚动容器，页眉/页脚在它里面做 `sticky`。
 *
 * ⚠️ `#229` 曾把滚动容器放到 `.se-panel`（那时标题栏也在里面，页眉吸顶要用 `--se-head-h` 偏移）；
 *  标题栏移出去后**那个变量不再需要** ⇒ 已删（少一处会过期的测量）。
 */
const scrollEl = ref<HTMLElement | null>(null);
// ★ `#224` `pageBodyEl` 已在上面与 `bodyEl` 一起声明（同一元素、两个语义 ref，见那里的注释）

watch(
  () => r.chapter,
  () => {
    // `#833` 无限滚动「交接」：这次换章是滚动接续造成的 ⇒ **不归零滚动位置**，
    // 而是落到拼接章内的等效偏移（否则用户在下一章中段会被拨回章首）。
    // `#841` 漫画三章拼接同理：滚进邻章时也是交接，锚点补偿由 `comicAdopt` 自己做。
    const adopt = infAdoptTarget.value;
    const comicAdopt = comicAdoptTarget.value;
    const adoptHere = (!!adopt && adopt.idx === r.chapterIdx) || (!!comicAdopt && comicAdopt.idx === r.chapterIdx);
    if (!adoptHere) infResetState();
    if (!adoptHere) {
      if (scrollEl.value) scrollEl.value.scrollTop = 0;
      // ★ `#251`：真正的滚动容器是正文格，换章必须把它也拨回顶部
      if (pageBodyEl.value) pageBodyEl.value.scrollTop = 0;
    }
    // `#825` 换章 ⇒ 回到第 1 页并重建（新章的段落/标题全变了）。
    // ★ `reset()` 先 abort 在途重建：它属于**旧章**，绝不能把旧章的页覆盖到新章上。
    curPage.value = 1;
    paged.reset();
    if (pagedActive.value) schedulePagedRebuild(0);
    // `#834` 换章 ⇒ 旧索引含义全变：取消在飞的漫画图请求并清空状态（含预取宽高）。
    // `#841` 但「三章拼接的滚动交接」是接续 ⇒ 状态 key 带章号、窗口内继续复用，不能清。
    if (!(!!comicAdopt && comicAdopt.idx === r.chapterIdx)) {
      comicQueue.reset();
      comicStatus.value = {};
      comicDims.value = {};
      comicUrl.value = {};
      resetComicMerge();
    }
    comicLastSt = pageBodyEl.value?.scrollTop ?? 0;
    comicLastDir = 0;
    hideSelMenu();
    hideHlMenu(); // `#256`：换章 ⇒ 动作栏指的那条高亮可能已经不在本章了
    selText.value = '';
    void nextTick(() => {
      updateProgress();
      // 交接后新章可能本身不足一屏（或正好在章末）⇒ 立即补一次边界判定
      if (infiniteActive.value) infOnScroll();
      // `#834` 新章的 `.rd-imgwrap` 已渲染 ⇒ 重新挂预取观察器（含三章拼接段）
      setupComicObserver();
      // `#841` 换章后补齐两侧邻章（显式翻章才需要；交接那边自己补）
      if (!(!!comicAdopt && comicAdopt.idx === r.chapterIdx)) {
        void loadComicNeighbor(-1);
        void loadComicNeighbor(1);
      }
    });
  },
);
// 媒体模式：音频/视频/文件类书源，章节即一个媒体直链
/**
 * ⚠️ **不能只看 `detail.kind`**（2026-09-25 修，用户报「🎬🔞麻豆传媒AI 点目录未唤起播放器」）。
 *
 * 该源 `bookSourceType=0`（文本）⇒ `detail.kind` 是普通书籍；**但 `content` 产出的却是
 * m3u8 直链**（引擎已按「内容形态」把它归到 `media`，见 `extractFromRaw` 的媒体救援注释）。
 * 旧判断只看 kind ⇒ 整块播放器**根本不渲染**，用户点完目录什么都看不到（连错误提示都没有）。
 * 现在：`kind` 命中媒体类 **或** 本章真的带 `media.url` ⇒ 都按媒体处理 ——
 * 与引擎那条「类型标记不可信，看内容形态」是同一个原则。
 *
 * ⚠️ `#352`（2026-10-08）：**`html` 存在时正文分支优先于媒体分支**（模板条件
 * `isMedia && !html`）—— 引擎现在会 `html + media` 并存下发（嗅探语义），
 * 源规则的展示结果（HTML）必须原样渲染，`media` 只负责浮现嗅探按钮。
 */
const isMedia = computed(
  () => ['audio', 'video', 'file'].includes(r.detail?.kind ?? '') || !!r.chapter?.media?.url,
);
/**
 * 「加入书架」对话框（用户实测 ①-3）。
 * 未在书架 → 点按钮弹对话框（选分组 / 新建分组 / 取消 / 确认加入）；
 * 已在书架 → 保持原来的「移出书架」一键行为（改分组请到书架卡片的「⇄ 分组」）。
 */
const addShelfOpen = ref(false);
/**
 * `#583+` 详情页改版：同一个对话框承担两种入口 ——
 *  · `add`  ：正文标题栏「加入书架」（原有语义）；
 *  · `group`：详情页「分组」行的「设置分组」（未入架时确认后自动入架，已在架时只改分组）。
 * 落地动作仍是 `r.addToShelf(groupId)`（它自身就兼容「已在架只更新分组」）。
 */
const shelfDlgMode = ref<'add' | 'group'>('add');
function openShelfDialog(mode: 'add' | 'group'): void {
  shelfDlgMode.value = mode;
  addShelfOpen.value = true;
}
const shelfDlgTitle = computed(() => {
  if (shelfDlgMode.value === 'add') return '加入书架';
  return curShelfBook.value ? '修改分组' : '设置分组';
});
const shelfDlgConfirm = computed(() => (shelfDlgMode.value === 'add' || curShelfBook.value ? '保存' : '加入书架'));
function onAddToShelf(groupId: number): void {
  r.addToShelf(groupId);
  addShelfOpen.value = false;
}

/* ── `#583+` 详情页信息区 / 简介折叠（用户 2026-10-23 改版）──────────────── */
/** 当前书在书架里的记录（`notShelf` 的观影历史行不算） */
const curShelfBook = computed(() => r.shelf.find((b) => b.key === r.currentKey && !b.notShelf));
/** 分组名（默认「未分组」；一本书可同时属于多个组，全部列出） */
const curGroupName = computed(() => {
  const mask = curShelfBook.value?.group ?? 0;
  const names = r.groups.filter((g) => isInGroup(mask, g.groupId)).map((g) => g.groupName);
  return names.length ? names.join(' / ') : '未分组';
});
/** 设置分组对话框的预选值（取第一个命中组） */
const curGroupId = computed(() => {
  const mask = curShelfBook.value?.group ?? 0;
  return r.groups.find((g) => isInGroup(mask, g.groupId))?.groupId ?? 0;
});
const detailAuthor = computed(() => String(r.detail?.author ?? ''));
const detailLatest = computed(() => {
  const m = r.detail?.meta ?? {};
  const v = m['最新章节'] ?? m['更新至'] ?? m['最新'];
  if (v) return String(v);
  const chs = r.detail?.chapters ?? [];
  return chs.length ? String(chs[chs.length - 1]?.title ?? '') : '';
});
/**
 * 简介折叠：默认最多 200 字符；右下角「展开 / 收起」。
 * ⚠️ 富文本简介（`<useweb>`/`<usehtml>`）**不能按字符切**（会切坏标签）⇒ 用高度钳制，
 * 展开时恢复 `RichIntro` 的自适应高度。
 */
const introExpanded = ref(false);
const introRaw = computed(() => String(r.detail?.summary ?? r.detail?.intro ?? ''));
const introRich = computed(() => /^\s*<(useweb|usehtml)>/i.test(introRaw.value));
const introNeedToggle = computed(() => introRich.value || introRaw.value.length > 200);
const introShown = computed(() => {
  if (introExpanded.value || introRich.value) return introRaw.value;
  return introRaw.value.length > 200 ? introRaw.value.slice(0, 200) + '…' : introRaw.value;
});
watch(
  () => r.currentKey,
  () => {
    introExpanded.value = false;
  },
);
/**
 * `#584+` 详情页「开始阅读 / 继续阅读」：
 * · 有阅读进度（`lastReadIdx`）且该章不是卷标题 ⇒ 继续阅读；
 * · 否则从第一个非卷章节开始（`firstReadableIndex()`，与卡片「阅读」同一判据）。
 */
const canContinueReading = computed(() => {
  const chs = r.detail?.chapters ?? [];
  const i = r.lastReadIdx;
  return i >= 0 && i < chs.length && !chs[i]?.isVolume;
});
const readStartLabel = computed(() => (canContinueReading.value ? '继续阅读' : '开始阅读'));
function startReading(): void {
  const chs = r.detail?.chapters ?? [];
  const i = canContinueReading.value ? r.lastReadIdx : r.firstReadableIndex();
  const ch = chs[i];
  if (ch) void r.openChapter(ch);
}

/**
 * 用当前详情的**目录**打开视频播放浮窗（目录 ⇒ 播放列表）。
 *
 * 为什么视频不再内嵌在阅读页里（用户 2026-09-25 要求）：
 * 视频要的是「选集切换 + 大画面 + 进度条」，内嵌在详情浮层的正文区里既小又别扭；
 * 而音频那条路早就统一交给浮窗了（见下），现在把视频也统一过去 ——
 * 于是「点目录项」在三类源里行为一致：音频 → 音频浮窗，视频 → 播放浮窗，文本/漫画 → 内嵌。
 *
 * `#352`（2026-10-08）调用时机变了：**只有嗅探按钮/目录动作会调它**（旧的
 * 「正文一加载就自动转交 + `r.reset()` 退回目录态」已删 —— 用户实测那会
 * 「替换掉源规则的展示结果」且关掉播放器回不到正文）。播放浮窗是**盖在
 * 阅读浮层之上**的独立界面 ⇒ 关闭即回正文，阅读位置分毫不动。
 */
/**
 * `#643` **这本书是否已被「内容形态」确认为音频**（详情阶段的 `kind` 之外的第二判据）。
 *
 * 背景：有些听书源把 `bookSourceType` 声明成 **0（文本）**，正文阶段才产出
 * `media.format === 'audio'`（实测 `#643` 书旗听书本地源（同人）`ocean.shuqireader.com`）。
 * 而 `isAudio` 原先只认 `detail.kind === 'audio'` ⇒ 这类源会被当**视频源**分流，
 * 用户看到的就是「明明是听书，却起了视频播放器」。
 *
 * 这是 skill 4.5 那条判据的落地：「**UI 分流必须按内容形态，不能只看 kind**」。
 * 换书必须清零（否则上一本被判定为音频后，下一本文本源也会进音频浮窗）。
 */
const audioByContent = ref(false);
watch(
  () => r.it0?.payload,
  () => {
    audioByContent.value = false;
  },
);

function openPlayerAt(i: number): void {
  const d = r.detail;
  if (!d || !r.it0) return;
  const chapters = d.chapters ?? [];
  const items = chapters
    .filter((c) => !c.isVolume) // 卷标题行没有正文/播放页，与阅读器「跳过卷」一致
    .map((c) => ({ title: c.title, payload: c.payload }));
  if (!items.length) return;
  player.openSession({
    mode: 'content',
    sourceId: r.sourceId,
    title: d.title ?? '',
    ...(d.cover ? { cover: d.cover } : {}),
    items,
    index: readableIdxOf(chapters, Math.max(0, i)),
    ...(r.it0.payload ? { vodPayload: r.it0.payload } : {}),
  });
}

/**
 * `#352` **嗅探播放**：直链已在手上（`chapter.media`）。
 *
 * `#374`（用户 2026-10-09）分流为两路 ——「把播放统一到影视源播放器界面」：
 * · **常规详情**（书源/RSS 真详情、目录在手）⇒ `openPlayerAt(当前章)`：
 *   `player.openSession(mode:'content')` —— 目录整个拉进来当**选集列表**，
 *   当前章即嗅探到的媒体章；可上一集/下一集、可刷新重解析。单链接与多链接
 *   （RSS 正文页多选集）从此同一界面。resolve 失败的章由播放器面板展示错误。
 * · **`r.webDoc` 合成详情**（`openWeb`，`#370`）：目录只有该网页一章、跑 content
 *   动作会撞 UNSUPPORTED ⇒ 保持 `openDirect` 直链直放。
 * · 目录为空（openSession 会报「没有可播放的选集」）⇒ 同样回落 openDirect。
 */
function openSniffPlayer(): void {
  // `#376` **LIVE 嗅探优先** —— 页内观察桥手里有实时挂载地址（页内切过的集都在
  // items 里）：整个交给 openDirect（direct 会话 + 选集列表，resolve 直取零网络）。
  // 实时状态 > 静态快照（navSniffMedia/chapter.media 都可能已是旧集）。
  const live = liveSniff.value;
  if (live?.cur) {
    const items = live.items.map((it) => ({
      url: it.url,
      ...(it.format ? { format: it.format } : {}),
      ...(it.title ? { title: it.title } : {}),
    }));
    // cur 理论上总在 items 里（桥的 cur 就取自候选）；上限截断/竞态下可能不在 ⇒ 补进去防「选集列表没有当前集」
    let idx = items.findIndex((it) => it.url === live.cur);
    if (idx < 0) {
      const f = inferPlayFormat(live.cur);
      items.unshift({ url: live.cur, ...(f && f !== 'unknown' ? { format: f } : {}) });
      idx = 0;
    }
    const curFmt = items[idx]?.format;
    player.openDirect({
      title: r.displayTitle,
      sourceId: r.sourceId, // `#422`：带上源 id ⇒ /api/proxy 才注入源 header（防盗链）
      url: live.cur,
      ...(curFmt ? { format: curFmt } : {}),
      items,
      index: idx,
    });
    return;
  }
  // `#374`：**NAV 页内嗅探优先** —— 嗅探条显示的是当前 NAV 页的直链（`navSniffMedia`），
  // 这里就播它；NAV 页的直链是页级信息，与章级 `chapter.media` 无关 ⇒ 走 openDirect
  // 直链直放（播放器面板自带刷新重载）。判据与 `sniffUrl` 同源，防「显示 A 播 B」。
  const nav = navSniffMedia.value;
  if (nav?.url) {
    player.openDirect({
      title: r.displayTitle,
      sourceId: r.sourceId, // `#422`
      url: nav.url,
      ...(nav.format ? { format: nav.format } : {}),
      ...(nav.alternatives?.length ? { alternatives: nav.alternatives } : {}),
      ...(nav.headers?.['Referer'] ? { referer: nav.headers['Referer'] } : {}),
    });
    return;
  }
  const m = r.chapter?.media;
  if (!m?.url) return;
  /**
   * `#643` **内容形态是音频 ⇒ 切到音频浮窗**（不是视频播放器）。
   *
   * 判据三条同时成立（窄）：`format === 'audio'` + **正文没有文字段落** + 目录多于一章。
   *  · 为什么要第三条：影视源的「单篇 + 多条备选」也走这里，但它 `format` 是 `m3u8`；
   *  · 为什么要「无文字段落」：防止把「正文里插了一条背景音乐」的文本源误判成听书。
   * 命中后记进 `audioByContent`，之后点目录直接进音频浮窗（不必每次都先抓一次正文）。
   */
  if (m.format === 'audio' && !(r.chapter?.paragraphs?.length ?? 0)) {
    audioByContent.value = true;
    playChapter(r.chapterIdx);
    return;
  }
  const d = r.detail;
  const chapters = (d?.chapters ?? []).filter((c) => !c.isVolume);
  /**
   * `#439` **「单篇文章 + 多条备选直链」⇒ 备选就是剧集**（用户实测：影视聚合 / MacCMS 播放页）。
   *
   * 引擎侧（`#438`）已把「整页 hls.js 播放器」的 `vod_play_url`（`集名$直链#集名$直链#…`）
   * 拆成候选：`media.url` = 第 1 集、`media.alternatives` = 第 2…N 集。但前端此前只把
   * `alternatives` 当**兜底播放链**（一个失败换下一个）⇒ 选集条仍只有「章节数」条
   * （用户：「单集嗅探已成功，(需) 嗅探播放列表」）。
   * 这里把备选**提升为可点选集**。
   *
   * ⚠️ 判据必须**只落在「单章会话」**上（`chapters.length <= 1`）—— 用户明确要求
   *   「AGE 的当前 tab 多集进列表、书源类影视源的**目录进选集**都不要动」：
   *   · 目录型（AGE / 书源类影视源）：`chapters.length > 1` ⇒ 判据为假 ⇒ 仍走
   *     `openPlayerAt`（目录即选集）★ 一行未改；
   *   · 多集页（本判据命中）：`alternatives` 与主候选**同源同路径前缀**（MacCMS 同线路的各集），
   *     与「多线路镜像」形态不同 —— 故再要求与主候选同 `origin`，避免把线路当集。
   */
  const sameOriginAlts = (m.alternatives ?? []).filter((u) => {
    try {
      return new URL(u).origin === new URL(m.url).origin;
    } catch {
      return false;
    }
  });
  /**
   * `#441` **判据换成「会话是 RSS/WebView 型正文」**（不再是「只有一章」）。
   *
   * 用户实测「12 集只嗅探 2 集」：该会话的详情给了 **2 章** ⇒ 旧判据（`chapters ≤ 1`）为假
   * ⇒ 没走本分支 ⇒ 选集 = 那 2 章（而不是当前播放页的 12 集）。
   * 而「当前这一章」的 `content` 结果就是**这一页的播放列表**（`media.alternatives` = 各集直链）
   * —— 与它有 1 章还是 2 章无关。
   *
   * 保护面（用户明确要求不要动）：
   *  · **书源类影视源「目录即选集」** ⇒ `r.rssArticle === false`（`readFirstDirect`/`openWeb` 才置位）
   *    ⇒ 判据为假，仍走 `openPlayerAt`（目录即选集）★ 一行未改；
   *  · **AGE「当前 tab 多集」** ⇒ 那条路走的是 LIVE 观察桥（`liveSniff` 优先级更高，根本不进来）；
   *    即便走到这里，AGE 的章级 `media` 是**解析页 URL**（无同源备选）⇒ 判据为假。
   *  · **各线路集数可以不同**（用户原话）⇒ 我们列的是**当前页实际给的那条线路**（引擎只把
   *    「像媒体」的候选交出来 —— 真机实测 4 家 MacCMS：候选数 == 该源 `*m3u8` 线路的集数）。
   */
  const episodeLike = !!r.rssArticle && sameOriginAlts.length >= 1;
  if (episodeLike) {
    const urls = [m.url, ...sameOriginAlts];
    const items = urls.map((u, i) => {
      const f = inferPlayFormat(u);
      return { url: u, ...(f && f !== 'unknown' ? { format: f } : {}), title: `第${i + 1}集` };
    });
    player.openDirect({
      title: r.displayTitle,
      sourceId: r.sourceId, // `#422`
      url: m.url,
      ...(m.format ? { format: m.format } : {}),
      items,
      index: 0,
      ...(m.headers?.['Referer'] ? { referer: m.headers['Referer'] } : {}),
    });
    return;
  }
  const canSession = !r.webDoc && !!d && chapters.length > 0;
  if (!canSession) {
    player.openDirect({
      title: r.displayTitle,
      sourceId: r.sourceId, // `#422`
      url: m.url,
      ...(m.format ? { format: m.format } : {}),
      ...(m.alternatives?.length ? { alternatives: m.alternatives } : {}),
      ...(m.headers?.['Referer'] ? { referer: m.headers['Referer'] } : {}),
    });
    return;
  }
  openPlayerAt(r.chapterIdx);
}

/* ---- 音频源（bookSourceType=1）：目录即播放列表，播放交给全局浮窗播放器 ----
 *
 * 为什么不在这个浮层里放 `<audio>`：用户要求「浮窗常驻 + 切路由不停播」，
 * 而本浮层是**会被关闭的**（Esc / 点遮罩 / 关闭按钮），播放器放在里面
 * 必然出现「关掉浮层音乐就停」。所以这里只做**分流**：把详情与目录交给
 * `stores/audio.ts`（全局唯一媒体元素），浮层本身退回目录态。
 */
const isAudio = computed(() => r.detail?.kind === 'audio' || audioByContent.value);
/** 当前浮层里的书 == 浮窗正在播的书 */
const playingThis = computed(() => {
  if (!audio.book || !r.it0) return false;
  try {
    return audio.book.key === itemKey(r.sourceId, r.it0.payload);
  } catch {
    return false;
  }
});

/** 目录下标（含卷标题行）→ 播放列表下标（卷不入列表，必须重算） */
function readableIdxOf(chs: Array<{ isVolume?: boolean }>, target: number): number {
  let n = 0;
  for (let i = 0; i < chs.length && i < target; i++) if (!chs[i]!.isVolume) n += 1;
  return n;
}

function audioBookOpts() {
  const d = r.detail;
  const author = d?.subtitle ?? d?.author;
  return {
    sourceId: r.sourceId,
    payload: r.it0?.payload ?? {},
    // 音频缓存的书级键：与服务端 `audioBookKey(bookUrl)` / 目录云朵同一口径
    bookUrl: audioBookUrl(),
    title: d?.title ?? '',
    ...(d?.cover ? { cover: d.cover } : {}),
    ...(author ? { author } : {}),
    chapters: (d?.chapters ?? []) as AudioChapter[],
  };
}

/**
 * 单章播放（目录第 i 项）。
 *
 * 注：原先还有一个「▶ 播放全部」按钮（用户 2026-09-25 要求去掉）——
 * 点目录项本身就进播放器了，那个按钮只是让用户多按一次。
 */
function playChapter(i: number): void {
  if (!r.detail || !r.it0) return;
  const chs = r.detail.chapters ?? [];
  void audio.playBook({ ...audioBookOpts(), startIdx: readableIdxOf(chs, Math.max(0, i)) });
}

/**
 * 目录点击 —— 三类源行为统一（用户 2026-09-25 要求「点目录项就直接进播放器」）：
 *   · 音频源 → **音频浮窗**（直接播，不需要先点「播放全部」）
 *   · 视频源 → **视频播放浮窗**（目录即播放列表）
 *   · 其余（文本/漫画）→ 内嵌阅读
 */
function onTocClick(ch: { title?: string; payload?: unknown } | null | undefined, i: number): void {
  if (isAudio.value) {
    playChapter(i);
    return;
  }
  if (r.detail?.kind === 'video') {
    openPlayerAt(i);
    return;
  }
  // 文本/漫画：`openChapter` 要 payload 才能取正文。模板里有一处传的是**已加载的正文对象**
  // （`r.chapter`，音频浮层的防御性入口，没有 payload）—— 音频源在上面已经 return 了，
  // 走到这里却缺 payload 说明调用点不对，**不静默继续**（否则会去请求一个空 payload）。
  if (!ch) return;
  void r.openChapter({ title: ch.title ?? '', payload: ch.payload ?? {} });
}

/**
 * ③-1 **目录筛选 + 正序/倒序**（用户实测：上千章的书很需要）。
 *
 * ⚠️ 展示列表必须**带上原始下标**：`onTocClick(ch, i)` 里的 `i` 是**含卷标题行的目录下标**
 * （音频播放列表／影视选集都用它换算），一旦按筛选结果重新编号就会点错章。
 * 所以这里返回 `{ ch, i }`，模板用 `i` 而不是 `v-for` 的下标。
 *
 * 不做「只渲染前 N 条」的窗口化：实测 2170 个项目渲染只要 ~180ms（见探针 `probe-toc-render.mjs`），
 * 而窗口化会让「滚动到第 1500 章」这种操作变复杂 —— 没量到收益就不加。
 */
const tocFilter = ref('');
const tocDesc = ref(false);
/**
 * `#489` **目录「未缓存」云朵标记**（用户口径：区分章节是否已缓存到本地）。
 *
 * - 判据与「全书搜索只搜已缓存章」**同一份**：`utils/chapter-cache.ts` 的
 *   `cachedChapterKeys(sourceId)`（一次 IndexedDB 游标扫出 key 集合，不逐章查）。
 * - 刷新时机对齐上游 `ChapterListFragment`（`BookHelp.getChapterFiles` + `EventBus.SAVE_CONTENT`）：
 *   · 换书（`currentKey` 变）/ 目录章数变 ⇒ 全量重扫；扫描带代次守卫，切书后旧结果不覆盖新书；
 *   · 任何正文落盘（阅读 / 刷新 / 预缓存 / 整本下载）⇒ `chapter-cache` 事件增量加键；
 *     预缓存窗口掉出窗口的章 ⇒ 同事件删键（云朵重新出现）。
 * - 本地书（`loc_book`）正文本来就在本机 —— 上游 `isLocalBook ⇒ cached`，一律不显示云朵。
 */
const cachedKeys = ref<Set<string>>(new Set());
/**
 * 音频书缓存状态是否已就绪（对齐上游 `isAudioCacheStateReady`）：
 * 未就绪前一律按「已缓存」显示（不铺满云朵），扫完再按真实结果刷。
 */
const audioCacheReady = ref(true);
/**
 * 音频书**真实已缓存**的章节标识（`chapterUrl`，缺失时回落标题）。
 * 与服务端 `/api/audio/status` 同一口径：文件存在即已缓存，不再用正文库近似。
 */
const audioCachedKeys = ref<Set<string>>(new Set());
/** 流式源（m3u8）：P1 不缓存，云朵保留并提示「流式源不支持离线」 */
const audioUnsupportedKeys = ref<Set<string>>(new Set());
/** 章节的缓存标识（与 audio store / 服务端 status 一致） */
function audioChapterCacheId(ch: { title?: string; payload?: unknown }): string {
  const p = (ch.payload ?? {}) as { chapterUrl?: string; url?: string };
  return String(p.chapterUrl || p.url || ch.title || '');
}
/** 音频书级键：`bookUrl` 优先，缺省用 `itemKey`（与服务端 `audioBookKey` 同一口径） */
function audioBookUrl(): string {
  const p = (r.it0?.payload ?? {}) as { bookUrl?: string };
  return String(p.bookUrl || r.currentKey || '');
}
let cacheScanSeq = 0;
let cacheScanning = false;
/** 扫描期间到达的增量事件：等扫完再叠加，避免被全量结果覆盖掉 */
let scanPendingOps: ChapterCacheChange[] = [];
function applyCacheChange(keys: Set<string>, change: ChapterCacheChange): void {
  for (const k of change.add ?? []) keys.add(k);
  for (const k of change.remove ?? []) keys.delete(k);
}
async function refreshCachedKeys(): Promise<void> {
  const sid = r.sourceId;
  const book = r.currentKey;
  const audio = isAudio.value;
  const my = ++cacheScanSeq;
  cacheScanning = true;
  scanPendingOps = [];
  // 音频：扫描期间按上游「缓存态未就绪」处理 ⇒ 先不显示云朵，避免整屏闪一下
  audioCacheReady.value = !audio;
  if (!sid) {
    cachedKeys.value = new Set();
    audioCachedKeys.value = new Set();
    audioUnsupportedKeys.value = new Set();
    cacheScanning = false;
    audioCacheReady.value = true;
    return;
  }
  try {
    if (audio) {
      // 音频：一次批量查服务端真实文件（`chapterUrl`），与「正文库带 media.url」解耦
      const chapters = ((r.detail?.chapters ?? []) as Array<{ title?: string; payload?: unknown }>).map((ch) => {
        const p = (ch.payload ?? {}) as { chapterUrl?: string; url?: string };
        return { chapterUrl: String(p.chapterUrl || p.url || ''), title: String(ch.title ?? '') };
      });
      const st = await fetchAudioCacheStatus(audioBookUrl(), chapters);
      // 扫描期间换了书 / 又发起了一次扫描 ⇒ 这份结果作废（否则会覆盖新书的状态）
      if (my !== cacheScanSeq || r.sourceId !== sid || r.currentKey !== book || isAudio.value !== audio) return;
      audioCachedKeys.value = new Set(st.cached);
      audioUnsupportedKeys.value = new Set(st.unsupported);
      cachedKeys.value = new Set();
      return;
    }
    const keys = await cachedChapterKeys(sid);
    // 扫描期间换了书 / 又发起了一次扫描 ⇒ 这份结果作废（否则会覆盖新书的状态）
    if (my !== cacheScanSeq || r.sourceId !== sid || r.currentKey !== book || isAudio.value !== audio) return;
    for (const op of scanPendingOps) applyCacheChange(keys, op);
    scanPendingOps = [];
    cachedKeys.value = keys;
  } catch {
    /* 缓存不可用（隐私模式/配额满）⇒ 不显示云朵，别把目录卡住 */
  } finally {
    if (my === cacheScanSeq) {
      cacheScanning = false;
      audioCacheReady.value = true;
    }
  }
}
/** 正文缓存变更（写成功 / 掉出窗口）—— 只认当前书的键，别的书的事件不污染本集合 */
function onCacheChanged(change: ChapterCacheChange): void {
  const sid = r.sourceId;
  if (!sid) return;
  const prefix = `${sid}|`;
  const filtered: ChapterCacheChange = {
    ...(change.add?.length ? { add: change.add.filter((k) => k.startsWith(prefix)) } : {}),
    ...(change.remove?.length ? { remove: change.remove.filter((k) => k.startsWith(prefix)) } : {}),
  };
  if (!filtered.add?.length && !filtered.remove?.length) return;
  if (cacheScanning) {
    scanPendingOps.push(filtered);
    return;
  }
  const next = new Set(cachedKeys.value);
  applyCacheChange(next, filtered);
  cachedKeys.value = next;
}
const isChapterCached = (ch: { title?: string; payload: unknown }): boolean => {
  // 本地书（导入的 TXT/EPUB/PDF）正文就在本机，上游按 cached=true 处理 ⇒ 永不显示云朵
  if (isLocalBookSource(r.sourceId)) return true;
  const sid = r.sourceId;
  if (!sid) return false;
  // 音频书：按 `chapterUrl` 查服务端真实缓存文件（P1 独立目录）；未就绪前先不显示云朵
  if (isAudio.value) return !audioCacheReady.value || audioCachedKeys.value.has(audioChapterCacheId(ch));
  return cachedKeys.value.has(chapterKey(sid, ch.payload));
};
/** 云朵悬停文案：流式源（m3u8）提示不支持离线，其余就是「未缓存」 */
function cloudTitle(ch: { title?: string; payload?: unknown }): string {
  if (isAudio.value && audioUnsupportedKeys.value.has(audioChapterCacheId(ch))) return '流式源不支持离线';
  return '未缓存';
}
// 换书 / 目录章数变化 / 文本↔音频判定变化 ⇒ 全量重扫
watch(
  () => [r.currentKey, r.detail?.chapters?.length, isAudio.value] as const,
  () => {
    cachedKeys.value = new Set();
    audioCachedKeys.value = new Set();
    audioUnsupportedKeys.value = new Set();
    void refreshCachedKeys();
  },
  { immediate: true },
);
onBeforeUnmount(onChapterCacheChange(onCacheChanged));
/**
 * P1.5：播放列表里的「离线到本机」完成后要按真实文件消掉云朵。
 * 播放器那边只发一个轻量事件（store 不直接依赖阅读器），这里只在**同一本书**时重扫。
 */
function onAudioCacheChanged(ev: Event): void {
  const detail = (ev as CustomEvent<{ bookUrl?: string }>).detail;
  if (!isAudio.value) return;
  if (detail?.bookUrl && detail.bookUrl !== audioBookUrl()) return;
  void refreshCachedKeys();
}
onMounted(() => window.addEventListener('yuedu:audio-cache-changed', onAudioCacheChanged));
onBeforeUnmount(() => window.removeEventListener('yuedu:audio-cache-changed', onAudioCacheChanged));
const tocList = computed(() => {
  const chs = r.detail?.chapters ?? [];
  const kw = tocFilter.value.trim().toLowerCase();
  const idx = chs.map((ch, i) => ({ ch, i }));
  // 筛选按**显示层**的标题（`#146`：开了简繁转换时，屏幕上看到的是转换后的字，
  // 用原文去筛会出现「明明看得见却筛不到」）
  const filtered = kw ? idx.filter(({ i }) => r.tocTitleAt(i).toLowerCase().includes(kw)) : idx;
  return tocDesc.value ? filtered.slice().reverse() : filtered;
});

/**
 * 目录为空时**到底为什么空**（`#161`）。
 *
 * 三种情况在界面上必须长得不一样，否则用户只会看到一句「没有匹配「」的章节」：
 *   ① 有筛选词但没命中 → 提示换个词（原来的行为，保留）；
 *   ② 引擎报了 `tocError` → **目录解析失败 + 原因**（引擎侧已把详情字段保住并留了痕）；
 *   ③ 都没有 → 源确实没产出目录（多为源规则不匹配/站点改版）。
 *
 * ⚠️ ② 是本轮的价值：修 `#161` 之前，情况②会表现为「整条详情 RULE_PARSE、字段一个都不下发」，
 * 用户看到的是「详情空 + 目录 0」；现在详情字段留住了，**必须把原因也显示出来**，
 * 否则等于把「炸了」和「本来就没有」混成同一个静默空。
 */
/* ---------------- 主题档位（`#145`→`#163` 后调整）----------------
 * ★ 工具栏的「A-/A+/主题档位」按钮已按用户 2026-09-30 的要求移除：
 *   字号入口在「设置→阅读」，主题模式入口在「设置→外观」—— 阅读浮层不再重复这两个入口。
 *   正文的取色/排版逻辑没动（`styles/reader-theme.ts`），只是不再需要这里的按钮文案与循环切换。 */

/**
 * `#677` 目录标题栏里的「加载中…」。
 *
 * 覆盖两种用户看得见的等待：**详情/目录在拉**（`detailLoading`）与**点了目录项、
 * 正文在读**（`contentLoading`）。用户要求这两种提示合成一处，放在
 * 「目录（N 章）」与「筛选框」之间居中 —— 原来是一整块 `class="empty"` 铺在目录下面，
 * 既占高度又容易让人以为目录是空的。
 */
const tocLoadingNow = computed(() => r.contentLoading || r.detailLoading);

const tocEmptyHint = computed(() => {
  if (tocFilter.value.trim()) return `没有匹配「${tocFilter.value}」的章节`;
  const err = r.detail?.tocError;
  if (err) return `目录解析失败：${err}`;
  // `#152`：详情/目录请求期间有文本响应被体积护栏截断 ⇒ 目录可能「少了一截」甚至整个取不到。
  //  这与「站点返回空 / 源失效」是两回事（前者调大 YUEDU_NET_MAX_BODY_MB 就能好），必须分开说。
  const nt = r.detail?.netTruncated;
  if (nt?.count) return `目录为空，且本次请求有 ${nt.count} 个响应被体积护栏截断（可能不完整）`;
  return '未取到目录（源没有产出章节）';
});

/**
 * `#769` 目录**部分成功**的轻提示：`tocError` 非空但已经解析到章节 ⇒ 后续页请求失败。
 *
 * 与 `tocEmptyHint` 的区别：空目录要说明「为什么空」，而这里目录是**可读的**，只是可能少了
 * 后面若干页（速读谷实测停在 999 章）。只给一行提示、不占位、不挡阅读；悬停看引擎原话。
 * 有筛选词时不显示（避免和「没有匹配」的提示叠在一起）。
 */
const tocPartialHint = computed(() => {
  if (!r.detail?.tocError) return '';
  if (!(r.detail?.chapters?.length ?? 0)) return '';
  if (tocFilter.value.trim()) return '';
  return '目录可能不全：后续页请求失败';
});

/** 「刷新中」闸门（两个刷新动作共用 —— 同一时刻只允许一个在飞） */
const refreshing = ref(false);

/** `#620` 导出对话框（详情页标题栏「⤓ 导出」） */
const exportOpen = ref(false);
/** 书内备注（详情页入口） */
const memoOpen = ref(false);

/**
 * ① **详情页刷新 ≠ 阅读页刷新**（用户 2026-09-27 要求两者隔离）。
 *
 * 同一个浮层里有两个语义完全不同的视图，之前那个「↻ 刷新」在两个视图里都去重拉详情+目录：
 *   · **目录视图**（`r.chapter` 为空）→ 重拉**详情 + 目录**（源改了章节表/简介时用）；
 *   · **正文视图**（有 `r.chapter`）→ **只重拉当前这一章的正文**（正文取空了、站点临时抖、
 *     反爬页混进来时用）。此时若还去重拉目录，既浪费一次慢请求，又会把阅读位置搅乱。
 *
 * 两个动作**都不重置上下文**：目录刷新不动当前章节，正文刷新不动 `chapterIdx`。
 */
async function reloadDetail(): Promise<void> {
  const it = r.it0;
  if (!it || refreshing.value) return;
  refreshing.value = true;
  try {
    // **强制重拉**（用户 5-4：书架里的书平时读本地，只有点刷新才重新拉并回写本地）
    await r.loadDetail(it, { force: true });
  } finally {
    refreshing.value = false;
  }
}

/**
 * 重拉**当前章正文**：走与「点目录」完全相同的那条路径（`openChapter` 内已含
 * 图片源/媒体源/`ruleContent` 为空等全部分支），所以刷新后的行为与重新点一次这一章一致。
 */
async function reloadChapter(): Promise<void> {
  if (refreshing.value) return;
  const chs = r.detail?.chapters ?? [];
  const ch = chs[r.chapterIdx];
  if (!ch) return;
  refreshing.value = true;
  try {
    /**
     * `#670` **必须显式传 `cache: 'refresh'`**。
     *
     * 缺陷形态（用户实测 138阅读网第 3 章）：预缓存把那一章取成了空正文并落了盘，
     * 点「↻ 刷新正文」→ 这里调的是 `openChapter(ch)`，默认 `cache: 'read'` ⇒ 命中那份空缓存
     * ⇒ 直接 return ⇒ 界面毫无变化，看起来就是「刷新没用」。
     */
    await r.openChapter(ch, { cache: 'refresh' });
  } finally {
    refreshing.value = false;
  }
}

/** 头部「↻」按钮的唯一入口：按当前视图分流（文案与 title 也随之变，避免用户误判） */
/**
 * **刷新：详情与正文彻底隔离**（用户 2026-10-03）。
 *
 * 此前是一个 `onRefresh()` 按 `r.chapter` 分流 + 一个按钮（文案动态切）。
 * 问题：详情页的「换源 / 刷新详情」被收进了**只属于正文页的「更多」**，
 * 且「更多」里那枚刷新显示的是「刷新正文」⇒ 详情页看到的是错的按钮 + 错的文案。
 * ⇒ 现在是**两个独立按钮、两个独立函数**：详情页只有 `reloadDetail`，正文页只有 `reloadChapter`。
 */
async function onRefreshDetail(): Promise<void> {
  if (r.chapter) return; // 详情页专属：正文页点了等于什么都没发生
  await reloadDetail();
}
async function onRefreshContent(): Promise<void> {
  if (!r.chapter) return;
  await reloadChapter();
}
const refreshDetailLabel = computed(() => (refreshing.value ? '刷新中…' : '刷新'));
const refreshDetailHint = computed(() => '重新加载详情与目录（不动阅读位置）');
const refreshContentLabel = computed(() => (refreshing.value ? '⟳ 刷新中…' : '↻ 刷新正文'));
const refreshContentHint = computed(() => '重新加载当前章正文（不动目录与阅读位置）');

/* ===================================================================================
 * 4-1 图片加载态 / 4-2 浮动进度条 / 4-3 目录侧滑浮层 + 缓存 / 4-4 书签 / 4-5 字典
 * =================================================================================== */

/**
 * **4-1 漫画图片**：预取窗口 + 独立队列（`#834`）。
 *
 * ## 改动前摸到的三个瓶颈（对应用户实机「多张图 8~10s 才超时」）
 * ① `<img loading="lazy">` 的触发距离由浏览器定（约 1 屏）⇒ 滚到哪儿才现发请求，没有预取；
 * ② 一话几十张**没有并发闸**：浏览器同源 6 条连接 + 服务端 `maxPerHost=2`
 *    （`packages/core/src/net/index.ts:197`）一起堵，单张慢就整批等；
 * ③ 占位高度写死 240px ⇒ 长图（真实高 2000px+）一加载就把下面所有图往下顶，阅读位置跳走。
 *
 * ## 现在的做法
 * · `IntersectionObserver`（root = `.se-body`，上下各 **2 屏**）决定哪些图进预取窗口；
 * · 进窗口的图交给 `ComicImageQueue`：**在飞 ≤3**，失败退避 600ms / 1800ms 后换候选
 *   （代理 → 直连 → 代理 `retry=1`），全失败落 `err` 显示「↻ 重新加载」；
 * · 队列用 `new Image()` 预取，**先拿 `naturalWidth/Height`** ⇒ 占位按真实宽高比撑开，
 *   图入画时版面不跳（长图仍 `width:100%; height:auto`，不裁切）；
 * · DOM `<img>` 只在 `ok` 时挂载 —— 预取已进 HTTP 缓存
 *   （`/api/proxy` 回 `cache-control: public, max-age=3600`，见 `apps/server/src/index.ts:6985`）。
 *
 * ⚠️ 并发上限只作用在**漫画图片**这一条客户端链路上，**不动服务端全局 per-host**
 *   （那是正文/封面共享配额，见 `docs/ref/2026-11-07-reader-pagination-scroll-comic-research.md` Q4）。
 * ⚠️ 这里不触碰分页测量：漫画/PDF 本就 `pagedActive` 恒假（`kind=image`）。
 */
const COMIC_PREFETCH_MARGIN = '200% 0px 200% 0px';
/**
 * `#841` 相邻三章无缝列表：**只保留 ±1 章**（当前 + 前 + 后）。
 * 超出这个窗口的章，DOM、状态表、已解码位图全部释放（见 `releaseComicFarChapters`），
 * 防止「一直翻下去」把内存吃满。
 */
const COMIC_CHAPTER_SPAN = 1;

/** 队列 key = `章下标:图下标` —— 三章共用同一个队列，**不是**三倍并发 */
const comicKey = (chIdx: number, i: number): string => `${chIdx}:${i}`;

const comicStatus = ref<Record<string, ComicImgStatus>>({});
const comicDims = ref<Record<string, ComicImgDim>>({});
const comicUrl = ref<Record<string, string>>({});

const comicQueue = new ComicImageQueue({
  maxInflight: 3,
  retryDelaysMs: [600, 1800],
  timeoutMs: 12_000,
  onUpdate: (u) => {
    const [chText, iText] = u.key.split(':');
    const ch = Number(chText);
    const i = Number(iText);
    if (!Number.isFinite(ch) || !Number.isFinite(i) || i < 0) return;
    const k = comicKey(ch, i);
    if (u.status === 'idle') delete comicStatus.value[k];
    else comicStatus.value[k] = u.status;
    if (u.dim) comicDims.value[k] = u.dim;
    if (u.status === 'ok' && u.url) comicUrl.value[k] = u.url;
  },
});

/** 本章/相邻章的图片清单（标题做分隔条，不阻断滚动） */
interface ComicChunk {
  chIdx: number;
  title: string;
  images: string[];
}
const comicPrevCh = ref<ComicChunk | null>(null);
const comicNextCh = ref<ComicChunk | null>(null);
const comicPrevLoading = ref(false);
const comicNextLoading = ref(false);
/**
 * 漫画图片列表是否成立：只认**图片型**章节；`TEXT` / PDF / HTML 正文不参与。
 * ★ 分页模式（`viewMode='paged'`）虽然 `pagedActive` 恒假（漫画不进分页排版），
 *   但正文仍要按图片渲染 —— 这里**不能**再夹 `!isPaged`，否则 `comicChunks` 为空 ⇒ 一张图都不挂。
 */
const comicVisible = computed(
  () => isComic.value && !isPdfChapter.value && showImages.value && !r.chapter?.html,
);
/** 拼接是否生效：**分页模式下不拼邻章**（`#848`），只渲染当前章 */
const comicMergeOn = computed(() => !isPaged.value && comicVisible.value);
/** 漫画/图片阅读**左右铺满**（用户 2026-11-09）：去掉 `.se-body` 与 `.rd-content` 的左右留白 */
const comicFill = computed(() => comicVisible.value);
const comicChunks = computed<ComicChunk[]>(() => {
  if (!comicVisible.value) return [];
  const out: ComicChunk[] = [];
  if (comicMergeOn.value && comicPrevCh.value) out.push(comicPrevCh.value);
  out.push({ chIdx: r.chapterIdx, title: r.displayTitle, images: r.chapter?.paragraphs ?? [] });
  if (comicMergeOn.value && comicNextCh.value) out.push(comicNextCh.value);
  return out;
});

const comicStatusOf = (chIdx: number, i: number): ComicImgStatus => comicStatus.value[comicKey(chIdx, i)] ?? 'idle';
const comicUrlOf = (chIdx: number, i: number): string => comicUrl.value[comicKey(chIdx, i)] ?? '';
/** 已知尺寸 ⇒ 用真实宽高比占位；未知 ⇒ 走 CSS 默认 2/3 */
function comicWrapStyle(chIdx: number, i: number): Record<string, string> | undefined {
  const dim = comicDims.value[comicKey(chIdx, i)];
  return dim ? { aspectRatio: `${dim.w} / ${dim.h}` } : undefined;
}

/**
 * 候选地址（按尝试顺序）。
 * ① 代理：防盗链 / 解密 / 动图透传都靠它；
 * ② 直连：服务端不可用时至少还能试一下裸连（与既有 `imgOverride` 回退语义一致）；
 * ③ 代理 + `retry=1`：服务端图片预算固定 10s，`_r` 打掉浏览器缓存（同一地址重发）。
 * ⚠️ `imgSrc` 可能返回根相对地址（`/api/proxy?…`），追加参数用 `&` 而不是 `?`。
 */
function comicCandidates(p: string): string[] {
  const raw = String(p ?? '').trim();
  const proxy = imgSrc(raw, { sourceId: r.sourceId });
  const list: string[] = [];
  if (proxy) list.push(proxy);
  if (raw && raw !== proxy) list.push(raw);
  if (proxy.includes('/api/proxy')) list.push(`${proxy}&retry=1&_r=1`);
  return list;
}
function requestComicImage(chIdx: number, i: number, p: string): void {
  comicQueue.request(comicKey(chIdx, i), comicCandidates(p));
}
function retryComicImg(chIdx: number, i: number, p: string): void {
  comicQueue.retry(comicKey(chIdx, i), comicCandidates(p));
}
/** DOM `<img>` 在 `ok` 之后仍报错（缓存被挤掉等）⇒ 落 `err`，由用户点「重新加载」 */
function onComicDomError(chIdx: number, i: number): void {
  comicQueue.markError(comicKey(chIdx, i));
}

/** 最近的非卷章节下标（拼接/交接/跨章卷曲跳过卷标题行，与 `chOffset` 同一口径） */
function readableNeighborIdx(dir: -1 | 1): number | null {
  const chs = r.detail?.chapters ?? [];
  let i = r.chapterIdx + dir;
  while (i >= 0 && i < chs.length && chs[i]?.isVolume) i += dir;
  return i >= 0 && i < chs.length ? i : null;
}

/**
 * `#841` **释放 ±1 章之外的一切**（DOM 由 `comicChunks` 重建自动移除；这里清状态表，
 * 已解码位图随 `<img>` 卸载交给 GC，避免一直翻章内存无界增长）。
 */
function releaseComicFarChapters(): void {
  const cur = r.chapterIdx;
  const keep = new Set([cur - COMIC_CHAPTER_SPAN, cur, cur + COMIC_CHAPTER_SPAN]);
  for (const chunk of [comicPrevCh.value, comicNextCh.value]) {
    if (chunk && !keep.has(chunk.chIdx)) {
      if (comicPrevCh.value?.chIdx === chunk.chIdx) comicPrevCh.value = null;
      if (comicNextCh.value?.chIdx === chunk.chIdx) comicNextCh.value = null;
    }
  }
  for (const map of [comicStatus.value, comicDims.value, comicUrl.value]) {
    for (const k of Object.keys(map)) {
      const ch = Number(k.split(':')[0]);
      if (!keep.has(ch)) delete map[k];
    }
  }
}

/** 章节分隔条相对视口顶部的偏移（用于「前插上一章」后一次性补偿） */
function comicChTopRel(ch: number): number | null {
  const body = pageBodyEl.value;
  const el = body?.querySelector<HTMLElement>(`[data-ccch="${ch}"]`);
  if (!body || !el) return null;
  return el.getBoundingClientRect().top - body.getBoundingClientRect().top;
}
/**
 * 取相邻章做无缝拼接（**单飞**，与文本无限滚动的 `infLoad` 同语义：不切当前章）。
 * 只在图片型章节生效；取到的段落必须像图片地址（PDF 页标记 / 空 ⇒ 丢弃）。
 * ⚠️ 前插上一章会让当前章整体下移 ⇒ 这里**只补偿一次** `scrollTop`（不在 scroll 回调里）。
 */
async function loadComicNeighbor(dir: -1 | 1): Promise<void> {
  if (!comicMergeOn.value) return;
  const loading = dir === -1 ? comicPrevLoading : comicNextLoading;
  if (loading.value) return;
  const idx = readableNeighborIdx(dir);
  if (idx === null) return;
  const have = dir === -1 ? comicPrevCh.value : comicNextCh.value;
  if (have && have.chIdx === idx) return;
  const curAtStart = r.chapterIdx;
  const beforeTop = dir === -1 ? comicChTopRel(curAtStart) : null;
  loading.value = true;
  try {
    const sec = await r.loadNeighborChapter(idx);
    if (!comicMergeOn.value || r.chapterIdx !== curAtStart) return;
    const images = (sec.paragraphs ?? []).filter((p) => typeof p === 'string' && p && !p.includes('/pdf-page?'));
    if (!images.length) return;
    const chunk: ComicChunk = { chIdx: sec.idx, title: sec.title, images };
    if (dir === -1) comicPrevCh.value = chunk;
    else comicNextCh.value = chunk;
    releaseComicFarChapters();
    await nextTick();
    if (dir === -1 && beforeTop !== null) {
      const body = pageBodyEl.value;
      const afterTop = comicChTopRel(curAtStart);
      if (body && afterTop !== null) {
        const delta = afterTop - beforeTop;
        if (Math.abs(delta) >= 1) body.scrollTop += delta;
        comicLastSt = body.scrollTop;
      }
    }
    setupComicObserver();
  } catch {
    /* 邻章取不到 ⇒ 不阻断当前章；下次滚动会再试（有单飞去重） */
  } finally {
    loading.value = false;
  }
}

/** 换章/退出/切模式：清拼接窗口与缩放（显式翻章复位 1x） */
function resetComicMerge(): void {
  comicPrevCh.value = null;
  comicNextCh.value = null;
  comicZoom.value = 1;
  comicPointers.clear();
  comicDrag = null;
  comicPinch = null;
  comicViewerOpen.value = false;
}

let comicObserver: IntersectionObserver | null = null;
function teardownComicObserver(): void {
  comicObserver?.disconnect();
  comicObserver = null;
}
/**
 * 重新挂预取观察器。
 * · 观察目标是模板里的 `.rd-imgwrap[data-cch][data-ci]`（拼接段一起观察 ⇒ 上下交界都能预取）；
 * · `root` 用真正滚动容器 `.se-body`，`rootMargin` 用百分比（相对容器高度）；
 * · 没有 `IntersectionObserver` 的极端环境 ⇒ 退化为「全部请求」，队列仍限并发（仍是同一个队列）。
 */
function setupComicObserver(): void {
  teardownComicObserver();
  // ★ 判据用 `comicVisible`（不是 `comicMergeOn`）：分页模式不拼邻章，但当前章仍要预取图片
  if (!comicVisible.value) return;
  const root = pageBodyEl.value;
  if (!root) return;
  const byCh = new Map<number, string[]>();
  for (const c of comicChunks.value) byCh.set(c.chIdx, c.images);
  const wraps = Array.from(root.querySelectorAll<HTMLElement>('.rd-comic .rd-imgwrap[data-cch]'));
  if (!wraps.length) return;
  if (typeof IntersectionObserver === 'undefined') {
    for (const c of comicChunks.value) c.images.forEach((p, i) => requestComicImage(c.chIdx, i, p));
    return;
  }
  comicObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const t = en.target as HTMLElement;
      const ch = Number(t.dataset['cch'] ?? '-1');
      const i = Number(t.dataset['ci'] ?? '-1');
      const list = byCh.get(ch);
      const p = list?.[i];
      if (ch >= 0 && i >= 0 && typeof p === 'string' && p) requestComicImage(ch, i, p);
    }
  }, { root, rootMargin: COMIC_PREFETCH_MARGIN, threshold: 0 });
  for (const w of wraps) comicObserver.observe(w);
}

/* ==================== `#841` 相邻三章无缝拼接：滚动交接 + 一次性补偿 ==================== */

/** 交接目标（供 `watch(r.chapter)` 识别「这是滚动接续，不是用户翻章」） */
const comicAdoptTarget = ref<{ idx: number } | null>(null);
const comicAdopting = ref(false);
let comicLastSt = 0;
let comicLastDir = 0;

/** 视口顶部锚定的那张图（换 DOM 前量一次；换完按同一张图落位） */
function comicAnchor(): { ch: number; i: number; topRel: number } | null {
  const body = pageBodyEl.value;
  if (!body) return null;
  const br = body.getBoundingClientRect();
  for (const w of body.querySelectorAll<HTMLElement>('.rd-comic .rd-imgwrap[data-cch]')) {
    const rr = w.getBoundingClientRect();
    if (rr.bottom > br.top + 1) {
      return { ch: Number(w.dataset['cch']), i: Number(w.dataset['ci']), topRel: rr.top - br.top };
    }
  }
  return null;
}

/**
 * 交接：滚进邻章 ⇒ 把邻章变成当前章（**不重置滚动位置**，按锚点补偿一次）。
 * 与文本无限滚动 `infAdopt` 同型：锚点在换 DOM 前量；换章 + 重建 + 落位在同一微任务链。
 */
async function comicAdopt(dir: -1 | 1): Promise<void> {
  if (comicAdopting.value || comicZoom.value > 1) return;
  const body = pageBodyEl.value;
  if (!body) return;
  const chunk = dir === 1 ? comicNextCh.value : comicPrevCh.value;
  if (!chunk) return;
  const ch = (r.detail?.chapters ?? [])[chunk.chIdx];
  if (!ch) return;
  const oldChunk: ComicChunk = {
    chIdx: r.chapterIdx,
    title: r.displayTitle,
    images: [...(r.chapter?.paragraphs ?? [])],
  };
  const anchor = comicAnchor();
  const stAtTrigger = body.scrollTop;
  comicAdopting.value = true;
  comicAdoptTarget.value = { idx: chunk.chIdx };
  try {
    await r.openChapter(ch, { cache: 'read' });
    const userDelta = (pageBodyEl.value?.scrollTop ?? stAtTrigger) - stAtTrigger;
    if (dir === 1) {
      comicPrevCh.value = oldChunk;
      comicNextCh.value = null;
    } else {
      comicNextCh.value = oldChunk;
      comicPrevCh.value = null;
    }
    await nextTick();
    const b2 = pageBodyEl.value;
    if (b2) {
      let target: HTMLElement | null = null;
      if (anchor) {
        target = b2.querySelector<HTMLElement>(
          `.rd-comic .rd-imgwrap[data-cch="${anchor.ch}"][data-ci="${anchor.i}"]`,
        );
      }
      if (!target) target = b2.querySelector<HTMLElement>('.rd-comic .rd-imgwrap[data-cch]');
      if (target) {
        const brect = b2.getBoundingClientRect();
        const topRel = target.getBoundingClientRect().top - brect.top;
        const want = anchor ? anchor.topRel - userDelta : 0;
        const dy = topRel - want;
        if (Math.abs(dy) >= 2) b2.scrollTop += dy;
      }
    }
  } catch {
    /* 取章失败 ⇒ 留在原章（下次滚动重试） */
  } finally {
    comicAdopting.value = false;
    comicAdoptTarget.value = null;
    comicLastSt = pageBodyEl.value?.scrollTop ?? 0;
    releaseComicFarChapters();
    void nextTick(() => {
      setupComicObserver();
      void loadComicNeighbor(dir);
    });
  }
}

/** 滚动方向闸门：向下只判下一章、向上只判上一章（防交界处来回拉锯） */
function comicMaybeAdopt(): void {
  if (!comicMergeOn.value || comicAdopting.value || comicZoom.value > 1) return;
  const body = pageBodyEl.value;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const band = Math.min(120, rect.height * 0.25);
  if (comicLastDir >= 0 && comicNextCh.value) {
    const el = body.querySelector<HTMLElement>(`[data-ccch="${comicNextCh.value.chIdx}"]`);
    if (el && el.getBoundingClientRect().top <= rect.top + band) {
      void comicAdopt(1);
      return;
    }
  }
  if (comicLastDir <= 0 && comicPrevCh.value) {
    // 上拉的边界 = **当前章自己的分隔条**（它的 bottom 就是「上一章内容占到视口多少」）。
    // ⚠️ 别用上一章的分隔条：那是上一章的**开头**，永远在文档最上面，滚到顶都判不出来。
    const el = body.querySelector<HTMLElement>(`[data-ccch="${r.chapterIdx}"]`);
    if (el && el.getBoundingClientRect().bottom >= rect.top + rect.height * 0.4) void comicAdopt(-1);
  }
}

/** 与 `infOnScroll` 同一拍（`onPageScroll` 的 rAF 里调用） */
function comicOnScroll(): void {
  if (!comicMergeOn.value) return;
  const body = pageBodyEl.value;
  if (!body) return;
  const st = body.scrollTop;
  const d = st - comicLastSt;
  if (d > 1) comicLastDir = 1;
  else if (d < -1) comicLastDir = -1;
  comicLastSt = st;
  comicMaybeAdopt();
}

/* ==================== `#841` 双击 / 双指缩放（1x ↔ 3x）+ 拖拽平移 ==================== */

const COMIC_ZOOM_MAX = 3;
const comicZoom = ref(1);
const comicPointers = new Map<number, { x: number; y: number }>();
let comicDrag: { x: number; y: number; l: number; t: number } | null = null;
let comicPinch: { d0: number; z0: number } | null = null;

/**
 * 设置缩放。`anchor=true` 时（双击/按钮）按视口顶部那张图一次性回位；
 * `anchor=false`（双指连续捏合）不做回位，避免每个 move 都写 `scrollTop`。
 */
async function setComicZoom(z: number, anchor = true): Promise<void> {
  const next = Math.min(COMIC_ZOOM_MAX, Math.max(1, z));
  if (Math.abs(next - comicZoom.value) < 0.02) return;
  const before = anchor ? comicAnchor() : null;
  comicZoom.value = next;
  if (!anchor || !before) return;
  await nextTick();
  const body = pageBodyEl.value;
  if (!body) return;
  const target = body.querySelector<HTMLElement>(
    `.rd-comic .rd-imgwrap[data-cch="${before.ch}"][data-ci="${before.i}"]`,
  );
  if (!target) return;
  const brect = body.getBoundingClientRect();
  const dy = (target.getBoundingClientRect().top - brect.top) - before.topRel;
  if (Math.abs(dy) >= 2) body.scrollTop += dy;
}

/* ==================== 双击 → 满视窗大图查看器（用户 2026-11-09） ====================
 * 旧的「双击在阅读界面内 1x↔3x」会把超出部分裁掉，看不到完整图；改成浏览器式大图浮层：
 * 满视窗 + 左右各一枚切换按钮 + 底部缩略图条；关闭只撤浮层，**不改滚动位置**。 */

interface ComicViewerItem {
  chIdx: number;
  i: number;
  url: string;
}

const comicViewerOpen = ref(false);
const comicViewerList = ref<ComicViewerItem[]>([]);
const comicViewerIdx = ref(0);

/** 已加载的地址优先；还没预取到的图直接用候选表第一项，浮层里独立加载，不占阅读队列 */
function comicViewerSrc(chIdx: number, i: number, p: string): string {
  const loaded = comicUrlOf(chIdx, i);
  if (loaded) return loaded;
  return comicCandidates(p)[0] ?? '';
}

/** 打开浮层并定位到被双击的那张（`target` 可为空 ⇒ 落在本章第一张） */
function openComicViewerFrom(target: HTMLElement | null): void {
  const list: ComicViewerItem[] = [];
  let hit = 0;
  for (const c of comicChunks.value) {
    c.images.forEach((p, i) => {
      if (target && target.dataset['cch'] === String(c.chIdx) && target.dataset['ci'] === String(i)) {
        hit = list.length;
      }
      list.push({ chIdx: c.chIdx, i, url: comicViewerSrc(c.chIdx, i, p) });
    });
  }
  if (!list.length) return;
  comicViewerList.value = list;
  comicViewerIdx.value = hit;
  comicViewerOpen.value = true;
}

function comicViewerGo(delta: -1 | 1): void {
  const next = comicViewerIdx.value + delta;
  if (next < 0 || next >= comicViewerList.value.length) return;
  comicViewerIdx.value = next;
}

function closeComicViewer(): void {
  comicViewerOpen.value = false;
}

/** 浮层独占键盘：←/→ 切图，Esc 关闭（capture 阶段，先于阅读层的 Esc 栈） */
function onComicViewerKey(e: KeyboardEvent): void {
  if (!comicViewerOpen.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeComicViewer();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    e.stopPropagation();
    comicViewerGo(e.key === 'ArrowLeft' ? -1 : 1);
  }
}

watch(comicViewerOpen, async (on) => {
  if (on) {
    window.addEventListener('keydown', onComicViewerKey, true);
    await nextTick();
    document.querySelector<HTMLElement>('.rd-cv-thumb.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    return;
  }
  window.removeEventListener('keydown', onComicViewerKey, true);
});

// 缩略图条跟随当前页：切图后把选中项滚进可视区（不改变主滚动位置）
watch(comicViewerIdx, async () => {
  if (!comicViewerOpen.value) return;
  await nextTick();
  document.querySelector<HTMLElement>('.rd-cv-thumb.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
});

function onComicDblClick(e: MouseEvent): void {
  // ★ 分页模式下也要能开查看器（`comicMergeOn` 在分页模式恒假）
  if (!comicVisible.value) return;
  e.preventDefault();
  e.stopPropagation();
  const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.rd-imgwrap[data-cch]') ?? null;
  openComicViewerFrom(target);
}

function onComicPointerDown(e: PointerEvent): void {
  if (!comicMergeOn.value || comicZoom.value <= 1) return;
  comicPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const el = e.currentTarget as HTMLElement;
  if (comicPointers.size === 2) {
    const [a, b] = [...comicPointers.values()];
    comicPinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: comicZoom.value };
    comicDrag = null;
  } else if (comicPointers.size === 1) {
    comicDrag = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: pageBodyEl.value?.scrollTop ?? 0 };
  }
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* 指针已释放 */
  }
  e.preventDefault();
}

function onComicPointerMove(e: PointerEvent): void {
  if (comicZoom.value <= 1) return;
  if (comicPointers.has(e.pointerId)) comicPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (comicPinch && comicPointers.size >= 2) {
    const [a, b] = [...comicPointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    void setComicZoom(comicPinch.z0 * (d / comicPinch.d0), false);
    e.preventDefault();
    return;
  }
  if (!comicDrag) return;
  const el = e.currentTarget as HTMLElement;
  const dx = e.clientX - comicDrag.x;
  const dy = e.clientY - comicDrag.y;
  el.scrollLeft = comicDrag.l - dx;
  const body = pageBodyEl.value;
  if (body) body.scrollTop = comicDrag.t - dy;
  e.preventDefault();
}

function onComicPointerUp(e: PointerEvent): void {
  comicPointers.delete(e.pointerId);
  if (comicPointers.size < 2) comicPinch = null;
  if (comicPointers.size === 0) {
    comicDrag = null;
    return;
  }
  const [p] = [...comicPointers.values()];
  comicDrag = {
    x: p.x,
    y: p.y,
    l: (e.currentTarget as HTMLElement).scrollLeft,
    t: pageBodyEl.value?.scrollTop ?? 0,
  };
}

onMounted(() => { void nextTick(setupComicObserver); });
onBeforeUnmount(() => { teardownComicObserver(); comicQueue.reset(); window.removeEventListener('keydown', onComicViewerKey, true); });
// 浮层开/关：关闭时立即取消在飞请求（不再为看不见的图占带宽），打开时补挂一次。
// ⚠️ 必须 `reset()` 而不是 `cancelAll()`：后者保留状态表，勾住 `loading` 的图重开后
//    会因「已加载中」被去重掉，永远不再发起请求（首版踩过的坑）。
watch(() => r.open, (open) => {
  if (!open) {
    teardownComicObserver();
    comicQueue.reset();
    comicStatus.value = {};
    comicDims.value = {};
    comicUrl.value = {};
    resetComicMerge();
  } else {
    void nextTick(() => {
      setupComicObserver();
      void loadComicNeighbor(-1);
      void loadComicNeighbor(1);
    });
  }
});
// `#841` 切图片展示模式（FULL/SINGLE/TEXT）也复位缩放（对齐「切模式复位 1x」）
watch(comicStyle, () => { comicZoom.value = 1; });

/**
 * **4-2 半透明浮动进度条**。
 *  · 漫画：`章回名 · 图 x/y · 章节 x/y · 总进度 %`
 *  · 书籍：`章节名 · 章节 x/y · 总进度 %`
 * 「总进度」= `(已读完章数 + 本章内进度) / 总章数`；本章内进度：漫画按**当前图序号**，
 * 文本按**已滚过的正文比例**（用 rect 计算，不依赖 offsetParent）。
 */
const curImg = ref(1);
const readRatio = ref(0);
const totalCh = computed(() => r.detail?.chapters?.length ?? 0);
const comicImgCount = computed(() => (isComic.value ? (r.chapter?.paragraphs?.length ?? 0) : 0));

/* ============================ `#308` 正文 HTML（订阅源 / 组装型） ============================ */

/**
 * `#308` 本章是不是「HTML 正文」（订阅源、影视聚合播放器、24凹凸图集…）。
 *
 * 上游订阅源的正文**不是纯文本**：`ReadRssActivity.initLiveData` 把 description /
 * ruleContent 的结果 `clHtml()` 之后 `loadDataWithBaseURL(...)` —— 那是「组装一个网页」，
 * 页面里的 `<script>`（hls.js 播放器、`atob()` 拼图）**必须真的执行**。
 * ⇒ 这里必须用 `<iframe srcdoc>`；`v-html` 只会插 DOM，**不会执行** `<script>`。
 */
const isHtmlChapter = computed(() => !!r.chapter?.html && !r.chapter?.readerModeText);
/**
 * `#432` HTML 正文的 iframe **不再按内容高度撑开**（`htmlFrameH` 已删）。
 *
 * ## 为什么（用户 2026-10-13 实测：LOFTER 热文文章页「一直跳顶、内侧滚动条时隐时现、无法滚动」）
 * 旧做法是「内容页把 `scrollHeight` 报给父页、父页设 `height`」。可**页面自己的 CSS 用了
 * 视口单位**（LOFTER 那份 `style` 里有 `min-height:60vh`、`max-height:85vh`、
 * `.cpop{max-height:90vh}`、`.cpop-list{overflow-y:auto}` …）—— 而不透明 origin 的 iframe
 * 里 **`vh` = iframe 自己的高度**，于是「iframe 高 ⇒ 60vh 高 ⇒ scrollHeight 大 ⇒ iframe 更高」
 * 成了**自反馈**：高度来回变 ⇒ 父页滚动位置被反复钳位（观感=跳顶）、内层滚动条随高度出现/消失。
 *
 * ## 现在的做法（与浏览器一致）
 * iframe **定高 = 正文格的可见高**、由它**自己滚**（CSS 见 `.se-body.se-html`）：
 *  · `vh/dvh` 有了稳定基准 ⇒ 自反馈消失；
 *  · 只有 **一条**滚动条（iframe 自己的），不再与 `.se-body` 并排；
 *  · 滚轮由 iframe 原生消费（壳层的滚轮桥会先判「本文档能不能滚」，能滚就不转发，见 `buildWheelBridge`）。
 */
/**
 * 给 HTML 正文补上「壳」并按需注入一个高度回报脚本。
 *
 * 三件事，缺一不可：
 *  ① **补全文档**：`ruleDescription`/`ruleContent` 常给的是片段（如 24凹凸 给的是
 *     `<div>…</div>` + 一段 script）。片段直接用 `srcdoc` 也能渲染，但没有 `charset`
 *     声明 ⇒ 中文可能乱码；也没有 viewport ⇒ 移动端字号会按桌面宽度缩。这里补上。
 *  ② **注入基础样式**：对齐上游 `clHtml` 的兜底样式（`img/video` 不溢出、正文可换行），
 *     否则「大图撑破屏幕」会盖住整个阅读器。
 *  ③ **高度回报**：iframe 不会自己撑高。注入脚本把 `scrollHeight` 报给父窗口，
 *     父窗口据此设高度 —— 这比写死 `vh` 稳（播放器/图集内容高度差异极大）。
 *
 * ⚠️ 注入的脚本里**不能出现反引号**（整段是 TS 模板串，反引号会提前结束字符串）。
 */
/**
 * 给 HTML 正文补上「壳」并按需注入跨域通路桥 / hls.js / 高度回报脚本。
 *
 * 拼装逻辑在 `utils/html-shell.ts`（`#326` 抽出的唯一实现 —— 探针用同一份做端到端
 * 验证，防止「验证的拼装」与「线上拼装」复制漂移）。四件事，缺一不可：
 *  ① **补全文档**：`ruleDescription`/`ruleContent` 常给的是片段。片段直接用 `srcdoc`
 *     也能渲染，但没有 `charset` 声明 ⇒ 中文可能乱码；也没有 viewport ⇒ 移动端字号
 *     会按桌面宽度缩。这里补上。
 *  ② **注入基础样式**：对齐上游 `clHtml` 的兜底样式（`img/video` 不溢出、正文可换行），
 *     否则「大图撑破屏幕」会盖住整个阅读器。
 *  ③ **高度回报**：iframe 不会自己撑高。注入脚本把 `scrollHeight` 报给父窗口，
 *     父窗口据此设高度 —— 这比写死 `vh` 稳（播放器/图集内容高度差异极大）。
 *  ④ **跨域通路桥 + hls.js**（`#326`）：源作者的正文脚本（fetch/hls.js）在不透明
 *     origin iframe 里跑不了 —— 详见 `html-shell.ts` 文件头。
 *
 * ⚠️ 注入的脚本里不能出现反引号（整段是 TS 模板串，反引号会提前结束字符串）。
 */
/* ── `#568`/`#569` 站点定制（per-site CSS/JS）+ 阅读模式 ─────────────────────
 *
 * 配置来源 = 服务端本地表（`data/site-customize.json`，按域名）；前端只按**当前页地址**取命中项。
 * 页面地址取 `chapter.htmlBaseUrl`（正文真实来源页）—— 不是书源 URL：同一源可能跨镜像域。
 * 变更广播（保存/删除后）⇒ 重新取一次 ⇒ `htmlDoc` 重算 ⇒ iframe 用新文档重建。
 */
const pageUrl = computed(() => String(r.chapter?.htmlBaseUrl ?? ''));
const siteHost = computed(() => hostOfUrl(pageUrl.value));
const siteCfg = ref<SiteCustomize | null>(null);
const siteDlgOpen = ref(false);
let siteSeq = 0;
async function reloadSiteCfg(): Promise<void> {
  const seq = ++siteSeq;
  const u = pageUrl.value;
  if (!u) {
    siteCfg.value = null;
    return;
  }
  const hit = await fetchSiteCustomize(u);
  if (seq === siteSeq) siteCfg.value = hit;
}
watch(pageUrl, () => {
  siteCfg.value = null;
  void reloadSiteCfg();
}, { immediate: true });
onBeforeUnmount(onSiteCustomizeChange(() => void reloadSiteCfg()));

/**
 * `#574` 当前章正文的**原始 HTML**（未做阅读模式变换）。
 * 站点定制弹窗的「HTML 源码」栏要看它 —— 用户按真实 DOM 写选择器；
 * 看壳层注入的脚本/样式或被阅读模式重排过的正文都会误导判断。
 */
const rawChapterHtml = computed(() => {
  const raw = r.chapter?.html;
  return typeof raw === 'string' ? raw : '';
});

/**
 * `#712` **书籍 HTML 正文的阅读模式**：抽正文 → 降级为 `paragraphs`（文本分支）。
 *
 * ## 为什么书籍不走 iframe（与网页型相反）
 * 网页型（`r.webDoc`）的正文里有源作者的播放器/图集脚本，必须执行 ⇒ 保留 iframe。
 * 书籍正文要的是「阅读体验」：字号/行距/主题/划词/高亮/分页都长在文本分支上
 * （`#583` 用户已否决过「书籍正文走 iframe」）。⇒ 这里只把抽出的正文**写回段落**，
 * 由阅读样式体系完全接管（评估见 `docs/rounds/2026-11-02-06-book-content-reading-mode-eval.md`）。
 *
 * ## 边界
 *  · 只对**本来就有 `html`** 的章节生效（纯文本章没有可抽的）；`webDoc` 会话跳过；
 *  · 该站点必须**显式开启** `readerMode`（抽正文会丢章内播放器/源自绘 UI）；
 *  · 抽不出（字数不足/没有候选）⇒ 还原段落、继续走 iframe，**绝不给空白正文**；
 *  · `siteCfg` 为 null 只是「还没查完」——此时**不动**，避免开→关→开的来回切换。
 */
watch(
  [rawChapterHtml, siteCfg, () => r.webDoc],
  () => {
    const raw = rawChapterHtml.value;
    const cfg = siteCfg.value;
    if (!raw || r.webDoc || !cfg) return;
    // `#726` 漫画（图集）/ PDF 章不能文本化：`<img>` 会被抽成 `[图]` 占位 ⇒ 图集分支破图。
    // 判据是 `reader-mode.ts` 的 `canExtractBookHtml()`（唯一实现，单测直接覆盖）。
    if (!cfg.readerMode || !readerModeAppliesTo('book') ||
        !canExtractBookHtml({ html: raw, isComic: isComic.value, isPdf: isPdfChapter.value })) {
      r.applyReaderModeText(null);
      return;
    }
    try {
      const ex = extractReaderContent(raw);
      r.applyReaderModeText(ex?.paragraphs?.length ? ex.paragraphs : null);
    } catch {
      r.applyReaderModeText(null); // 抽取异常 ⇒ 回落 iframe（与「抽不出」同一出口）
    }
  },
  { immediate: true },
);

/**
 * `#726` 文本化后 `uiMarks`（本章说/段评）不渲染是**有意取舍**（见 `uiMarksAt`）。
 * 会给用户「按钮凭空消失」的错觉，所以本章确实有源按钮时给**一次性**轻提示（每会话一次）。
 */
let uiMarksHintShown = false;
watch(
  () => r.chapter?.readerModeText,
  (on) => {
    if (!on || uiMarksHintShown) return;
    if (!(r.chapter?.uiMarks?.length)) return;
    uiMarksHintShown = true;
    toast('阅读模式下本章的「本章说/段评」不显示（抽取后的段落与源按钮位置无法对齐）', 'info', 6000);
  },
);

const htmlDoc = computed(() =>
  buildHtmlDoc(
    // ⚠️ `#349`（2026-10-08）**撤销 `#345` 在这里的 `decorateRssHtml`**：真浏览器 A/B 实测
    // （24 系列文章页）「带 decorate」**0/13** 图、 「不带」**9/13** —— 装饰期改 `src` 会破坏
    // 站点自己的 `jquery.lazyload`（占位 `src` 被换掉 ⇒ 真图 `data-original` 永不换上）。
    // 资源改写统一交给壳里的 `buildResourceBridge`（运行时、能同时看 `src`/`data-original`/相对地址）。
    //
    // `#569` 阅读模式：先把整页抽成正文（去导航/侧栏/广告），再交给壳层补样式与桥。
    // ⚠️ 这里只处理「网页即正文」（`r.webDoc`，openWeb 会话）—— 它的脚本/播放器必须执行 ⇒ 留 iframe。
    //     `#712` 书籍 HTML 正文不走这条：它在上面被抽成 `paragraphs`（文本分支，样式体系接管）。
    (() => {
      const raw = rawChapterHtml.value;
      const cfg = siteCfg.value;
      if (!cfg?.readerMode || !r.webDoc || !readerModeAppliesTo('web') || typeof raw !== 'string') return raw;
      try {
        const ex = extractReaderContent(raw);
        return ex ? readerModeDocument(ex) : raw; // 抽不出 ⇒ 回落原文，绝不给空白正文
      } catch {
        return raw;
      }
    })(),
    {
      base: r.chapter?.htmlBaseUrl,
      sid: r.sourceId ?? '',
      origin: serverOriginOf(),
      hlsAssetUrl: hlsAssetUrl,
      // `#568` 站点定制：CSS/JS 走壳层已有的 `extraHead` 槽（与 `injectSiteCustomize` 同一份转义实现）。
      // 放在壳层脚本之后 ⇒ 用户 JS 可以读/改已注入的桥与样式。
      extraHead: siteCustomizeHeadHtml(siteCfg.value),
      // `#459` 图集类 RSS 文章**不加图高上限**（`capTallImages: false`）：
      // `#432` 把 iframe 改成定高自滚后，壳里那条 `max-height:90vh`（`#212` 为 epub 加的）
      // 从「几乎不生效」变成真生效 —— 替换元素在高度受限时**宽度会按比例被压下来**，
      // 于是竖长图只渲染出正文格的一半宽（用户 2026-10-14 报的「宽图不是 100%」）。
      // 书籍/epub 仍走缺省 `true`（`#212` 意图不变：一屏装得下一张整页插图）。
      capTallImages: !r.rssArticle,
    },
  ),
);
/* ── `#376` LIVE 嗅探（页内观察桥的消费端）────────────────────────────────
 *
 * LIVE 桥（`utils/html-shell.ts` 的 `buildLiveMediaBridge`）在沙箱 iframe 里盯着
 * video/audio/iframe 的**实际挂载地址**，变化就 `postMessage {yueduLiveMedia}`。
 * 父页在这里收 —— 解决「`navSniffMedia` 是静态快照、页内切集不跟随」（用户实测
 * 苹果MCS：页内点第 5 集，嗅探条还停在进页时那条）。
 *
 * ⚠️ 位置纪律：本区块在 `onHtmlFrameMessage`（下方）引用 `liveSniff` ⇒ 必须**先**声明；
 * 「srcdoc 重建 ⇒ 清空」的 watch **不能放这里** —— 它要 watch 的 `frameDoc` 在下方
 * NAV 区（`#335/#336`）才声明，watch 的 getter 建立时就同步求值一次 ⇒ TDZ 崩溃
 * （`#374` 实证同型坑）⇒ 清空 watch 放在 **`navSniffMedia` 区块**（NAV 之后）。
 */
interface LiveMediaItem { url: string; format?: string; title?: string }
interface LiveSniff { items: LiveMediaItem[]; cur: string }
const liveSniff = ref<LiveSniff | null>(null);
/** direct 播放浮窗开着时，页内切集 ⇒ 播放器跟随（「切集不跟随」的另一半） */
watch(
  () => liveSniff.value?.cur,
  (c) => {
    if (!c || !player.open || player.session?.mode !== 'direct') return;
    if (c === player.url) return;
    const it = (liveSniff.value?.items ?? []).find((x) => x.url === c);
    player.followDirect(c, it?.format);
  },
);
/** 桥报文 → LiveSniff（format 由父页用 core 唯一实现补；形不对的丢弃防脏数据） */
function takeLiveMedia(d: unknown): void {
  const lm = d as { items?: { u?: unknown; t?: unknown }[]; cur?: unknown } | null | undefined;
  if (!lm || !Array.isArray(lm.items)) return;
  /**
   * `#433` **入口归一化**：LIVE 桥报的是页面里**实际挂载的地址**，而不少站点把它写成
   * 「播放器页包直链」（91视频：`ifa.src="…/t2player.html?url=https://…/x.m3u8"`）。
   * 不在这里解包 ⇒ 嗅探条/播放器拿到的是 HTML 播放器页 ⇒ hls.js `manifestParsingError`
   * （引擎侧的 `unwrapPlayerUrl` 只覆盖 `mediaFromRaw`，管不到 LIVE 桥）。
   * 解包与引擎共用 core 唯一实现。
   */
  const un = (v: string): string => unwrapPlayerUrl(v) ?? v;
  const items: LiveMediaItem[] = [];
  for (const x of lm.items) {
    const raw = typeof x?.u === 'string' ? x.u : '';
    if (!raw) continue;
    const u = un(raw);
    const f = inferPlayFormat(u);
    // `#377②` 集名（桥从 data-title/title/文本抽）——选集列表用它显示，比序号友好
    const t = typeof x?.t === 'string' ? x.t.trim() : '';
    items.push({ url: u, ...(f && f !== 'unknown' ? { format: f } : {}), ...(t ? { title: t } : {}) });
  }
  const cur0 = typeof lm.cur === 'string' ? lm.cur : '';
  const cur = cur0 ? un(cur0) : '';
  liveSniff.value = { items, cur: cur || items[0]?.url || '' };
}

/* ── `#377①` 站点浮层「对齐父页可见带」────────────────────────────────────
 *
 * ## 缺陷（用户实测）
 * yckceo 列表页「生成」弹层（layui `layer.open`）落在文档中段（`top≈2188px`，实测），
 * 用户必须**滚动**才看得到。根因见 `html-shell.ts` 的 `LAYER_FIX_CSS` 注释：
 * iframe 被撑到内容全高 ⇒ 子文档 `innerHeight` = 全高 ⇒ 站点用文档高算的居中必然错位。
 *
 * ## 父页侧：算「iframe 自身视口里，可见带顶部在哪」并回灌
 * 子文档里 `position:fixed` 的浮层，其 `top` 是**相对 iframe 自身盒子**（被撑到内容全高）
 * 的坐标，不是相对父页可见窗口。所以要把「可见带顶部」换算进**同一个坐标系**：
 *
 *   iframe 顶边相对可见带顶的距离 `bandRelTop = frameRect.top - scrollerRect.top`
 *   ⇒ 要让浮层落在可见带内 `MARGIN` 处，桥里 `T` 必须满足 `bandRelTop + T = MARGIN`
 *   ⇒ `T = MARGIN - bandRelTop`（钳到 ≥0）
 *
 * 全程不用 `scrollTop`（`bandRelTop` 已含滚动效应）⇒ 滚动中/滚动后都自动正确。
 *
 * ⚠️ 用户 2026-10-09 修正：「**不是**固定到视口中间，是弹出时在**页面上方**、滚动条还没滚动
 *   时的视口内，无需固定」⇒ 目标位置 = 可见带**顶部偏内一点**（MARGIN），不做垂直居中。
 * ⚠️ 只在**真的出现过浮层**后回灌（`yueduLayer` 报文触发）—— 不给所有页面加噪声。
 */
/** 浮层目标位置：可见带顶往下留白（避免贴边 + 让过站点自己的带动画） */
const LAYER_MARGIN = 28;
function pushLayerViewportTop(): void {
  const scroller = pageBodyEl.value;
  const frame = scroller?.querySelector<HTMLIFrameElement>('.rd-html-frame');
  if (!frame?.contentWindow || !scroller) return;
  // 可见带顶（`.se-body` 盒子顶）与 iframe 顶都在屏幕坐标系里量，差即「iframe 顶边相对可见带顶」
  const bandRelTop = frame.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const vpTop = Math.max(0, Math.round(LAYER_MARGIN - bandRelTop));
  try {
    frame.contentWindow.postMessage({ yueduVpTop: vpTop }, '*');
  } catch {
    /* 跨域/已卸载：静默（退回 CSS 兜底 0） */
  }
}
/** 浮层出现标记：只有真出现过浮层才在滚动时回灌（不给所有页面加噪声） */
const layerSeen = ref(false);

/**
 * `#408` **正文页 `java` 垫片的宿主消费**（`html-shell.ts` 的 `buildContentJavaShim` 发
 * `{yueduReaderJava:{m,args,id}}`）。WebView 型订阅源（18AV）的 `ruleContent` 合成页
 * 用 `java.openVideoPlayer` / `playu` 这类**页面全局符号**播放，本仓把它们接回宿主：
 *  · `openVideoPlayer` → 开本仓播放器（HLS 由我们处理，不依赖页面自带 Artplayer）；
 *  · `openUrl` → 新标签打开（源的「外部播放器」档）；
 *  · `open` / `startBrowser` / `back`（`#446`）→ 源自绘 UI 的动作类出口：
 *    `open('rss',url)` 交订阅源重新解析（同 `readFirstDirect`）、`startBrowser` 走页内
 *    浏览器、`back` 走页内导航栈后退（见 `onReaderJavaMessage` 内注）；
 *  · `toast` → 全局提示；
 *  · `resolve`（= `playu`/`webViewGetSourceAwait`）→ 走 `#394` 的解析页二级解析，**回填** RPC。
 * 回填目标必须锁定**本组件的正文 iframe**（`contentWindow`），不能广播（避免与其它 iframe 串）。
 */
function replyReaderJava(id: number, value: string): void {
  if (!id) return;
  const frame = pageBodyEl.value?.querySelector<HTMLIFrameElement>('.rd-html-frame');
  try {
    frame?.contentWindow?.postMessage({ yueduReaderJavaResult: { id, value } }, '*');
  } catch {
    /* 已卸载 / 跨域：静默（源侧 RPC 会超时回空串） */
  }
}
function onReaderJavaMessage(msg: { m?: unknown; args?: unknown[]; id?: unknown }): void {
  const m = String(msg.m ?? '');
  const args = Array.isArray(msg.args) ? msg.args : [];
  const id = Number(msg.id ?? 0) || 0;
  if (m === 'openVideoPlayer') {
    const u = String(args[0] ?? '');
    if (u) player.openDirect({ title: String(args[1] ?? '') || r.chapter?.title || '', url: u });
  } else if (m === 'openUrl') {
    const u = String(args[0] ?? '');
    if (u) window.open(u, '_blank', 'noopener');
  } else if (m === 'open') {
    /**
     * `#446`① `java.open(kind,url,title)` —— 「用本订阅源重新解析这个 URL」。
     *
     * 千白羽论坛的**返回**按钮（`goBack()`）就是它：源里写死回论坛首页
     * （`index.php?mobile=2`）。Legado 语义 = 交给订阅源重新解析该地址 ⇒ 与发现页
     * 「卡片点文章」**同一条通路**（`readFirstDirect`：`ruleContent`/`style`/净化全部生效），
     * 而不是把 iframe 甩到站点原始页（那样源规则全失效，正是用户抱怨的点）。
     * `kind` 非 `rss`（如 `web`）⇒ 属于「另一张网页」⇒ 交给页内浏览器。
     */
    const kind = String(args[0] ?? '');
    const u = String(args[1] ?? '');
    if (!/^https?:\/\//i.test(u)) return;
    if (kind === 'rss') {
      const title = String(args[2] ?? '');
      void r.readFirstDirect(String(r.sourceId ?? ''), {
        id: u, kind: 'article', title, layout: 'text-row', payload: { link: u, title },
      });
    } else {
      void navGo(u);
    }
  } else if (m === 'startBrowser') {
    /**
     * `#446`① `java.startBrowser(url,title)` —— 源作者的注释：「详情页链接统一『一键跳转』……
     * 一律走**内置浏览器**」。⇒ 页内导航（本仓 `navGo` = 阅读页自带的「极简浏览器」，
     * 带 ←/→/⟳ 与「正文」），不再 `window.open` 把人甩出阅读页。
     */
    const u = String(args[0] ?? '');
    if (u) void navGo(u);
  } else if (m === 'back') {
    /**
     * `#446`① `history.back()` 的出口（垫片已接管，见 `buildContentJavaShim`）。
     *
     * ⚠️ 用户实测「返回按钮无效」的真因就在这条：沙箱 iframe 的 `srcdoc` 是一整次导航 ⇒
     * **`history.length` 从第一屏起就 > 1**，源里的 `goBack()`
     * （`if(history.length>1){history.back(); return}`）**立刻走这一支并 return** ⇒ 永远到不了
     * 它自己的 `java.open('rss',Rr)` 兜底。此时若宿主只是 `navBack()`，而页内导航栈还是栈底
     * （`navIdx=0`，用户根本没在页内跳过）⇒ **空转 = 用户看到的「点了没反应」**。
     *
     * ⇒ 分岔判据（与本组件页内导航条同一个「能不能后退」的口径）：
     *  · 栈里真有来路（`navIdx>0`，即用户页内跳过）⇒ `navBack()`（与 `←` 完全同一动作）；
     *  · 栈底（本章正文自己）⇒ `r.close()` —— RSS 直达阅读会话的「返回」语义就是**整关回列表**
     *    （`#399`/`#414`：订阅源没有真实详情页中间态），落点与源的意图（回它的列表页）一致。
     */
    if (navIdx.value > 0) navBack();
    else r.close();
  } else if (m === 'downloadFile') {
    /**
     * `#448`② 「下载 HTML」的**真正落盘位**（用户复测：`#447` 后 ①③④ 通了，② 仍不出文件）。
     *
     * 链路：源自绘的 ⬇️ 按钮 → `downloadThread()` → `dlSave()` → 第 ① 分支
     * `java.downloadFile(hex, url)`（Legado 的「把字节写进 App 下载目录」）。垫片把它解好
     * （hex / `data:base64` → 文本）后报文上来，**由宿主顶层文档落盘**：
     *  · 顶层文档**不在 sandbox 里** ⇒ 不受 `allow-downloads` / 不透明 origin 的下载限制
     *    （源自己那条 `<a download>` 兜底在沙箱 iframe 里会被 Chrome 丢弃）；
     *  · Web 端与桌面端同一份实现（桌面端由 Electron 的下载流程接管 → 存到下载目录/弹保存框）。
     * `args[0]` = 文件名（源用 tid 编好，垫片从 url 尾巴推出来），`args[1]` = 已解码的文本。
     */
    const name = String(args[0] ?? '') || 'download.html';
    const text = String(args[1] ?? '');
    try {
      const blob = new Blob([text], { type: 'text/html;charset=utf-8' });
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      window.setTimeout(() => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* 已撤销/已卸载：静默 */
        }
        a.remove();
      }, 8000);
      toast(`已导出文件：${name}`, 'info');
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  } else if (m === 'toast') {
    toast(String(args[0] ?? ''), 'info');
  } else if (m === 'resolve') {
    const u = String(args[0] ?? '');
    if (!u) return replyReaderJava(id, '');
    resolveMediaPage(u)
      .then((res) => replyReaderJava(id, res.ok ? res.url : ''))
      .catch(() => replyReaderJava(id, ''));
  }
}

/* ── `#583` **源脚本自绘 UI**（七猫：段评 / 本章说 / 神评 / 书评）──────────────────
 *
 * ## 链路（三段，缺一不可）
 *  ① 引擎：正文文本里带「选项图片」（`img` + `,{…click…}`）时抽成 `uiMarks`（**不发 html**，
 *     见 `engine-legado` 的 `extractFromRaw`）——正文仍是 `paragraphs`，阅读样式/划词/高亮全部保留。
 *  ② 本处：按 `uiMarks` 在段落末尾渲染按钮图片（`img` 无文本节点 ⇒ 字符偏移不变），点击取 `click`。
 *  ③ `POST /api/source-ui/eval` 在**源的真实 JS 环境**里求值（jsLib + 签名请求），
 *     拿回 `java.showBrowser` 的面板地址 ⇒ 半宽 `InAppBrowser` 打开。
 *
 * ⚠️ 订阅源/组装型的**真 HTML 正文**仍走 iframe；`buildImageOptionBridge` 只为那种页面里的
 * 选项图保留（七猫这类书籍正文不经过它）。
 *
 * 详情页的「源按钮 / 书名」走同一条通道（`event` 由服务端取源 `ruleContent.callBackJs`）——
 * 前端**不持有源 raw**，也不需要知道源脚本长什么样。
 */
const sourceUiOpen = ref<{ url: string; title: string } | null>(null);
const sourceUiBusy = ref(false);
/**
 * `#583` 正文里的源按钮（`uiMarks`）。按段落分组：`-1` = 章末（本章说 / 书评）。
 *
 * 渲染位置：`style:'text'` 的行内小图（段评）**放进 `<p>` 末尾**（跟在文字后，与原 App 一致）；
 * 整宽条（本章说 / 神评 / 书评）放在**段后**或**章末**。
 * ⚠️ `<img>` 没有文本节点 ⇒ 划词/高亮的字符偏移与 `paragraphs` **一字不差**（不能用 `<span>` 代替）。
 *
 * 用户 2026-11-10：当前章与**无限滚动拼接段**共用下面这一份分组/取用函数。
 * 相邻章的「本章说」必须跟着拼接段一起渲染 —— 否则交接那一刻它从 DOM 里消失，
 * 往回滚再交接回来又出现（用户实测的「本章说闪没 + 正文抖一下」）。
 */
function groupUiMarks(list: ContentUiMark[] | undefined): Map<number, ContentUiMark[]> {
  const map = new Map<number, ContentUiMark[]>();
  for (const m of list ?? []) {
    const arr = map.get(m.para) ?? [];
    arr.push(m);
    map.set(m.para, arr);
  }
  return map;
}
/** 段内行内小图（段评气泡） */
function textMarksOf(map: Map<number, ContentUiMark[]>, para: number): ContentUiMark[] {
  return (map.get(para) ?? []).filter((m) => m.style === 'text');
}
/** 段后整宽条（神评这类挂在段落上的条目） */
function fullMarksOf(map: Map<number, ContentUiMark[]>, para: number): ContentUiMark[] {
  return (map.get(para) ?? []).filter((m) => m.style !== 'text');
}
const uiMarksAt = computed(() => {
  // `#712` 阅读模式文本化后，段落下标来自抽取结果，与引擎 `uiMarks.para` 不再对应 ⇒ 不渲染
  // （错位渲染比不渲染更糟：点「段评」会挂到别的段落上）
  if (r.chapter?.readerModeText) return new Map<number, ContentUiMark[]>();
  return groupUiMarks(r.chapter?.uiMarks);
});
function textMarksAt(para: number): ContentUiMark[] {
  return textMarksOf(uiMarksAt.value, para);
}
function fullMarksAt(para: number): ContentUiMark[] {
  return fullMarksOf(uiMarksAt.value, para);
}
/** 章末条目（本章说 / 书评） */
const endUiMarks = computed(() => uiMarksAt.value.get(-1) ?? []);
/** 拼接段（上一章 / 下一章）的同类分组：把「本章说」一起带进拼接段，交接前后都不卸载 */
const infPrevMarks = computed(() => groupUiMarks(infPrev.value?.uiMarks));
const infNextMarks = computed(() => groupUiMarks(infNext.value?.uiMarks));
function onUiMarkClick(m: ContentUiMark): void {
  if (!m.click) return;
  void openSourceUi({ code: m.click, title: m.label || '源界面' });
}

/** 当前源记录（`customButton` / `eventListener` 两个开关由服务端 `publicSource` 下发） */
const curSource = computed(() => st.sources.find((s) => s.id === String(r.sourceId ?? '')));
const sourceUiCustomButton = computed(() => !!curSource.value?.customButton);
/** 选项 `type` → 面板标题（源作者约定的类型名；未知类型给中性标题） */
const SOURCE_UI_TITLES: Record<string, string> = {
  qmpl: '段评',
  'qmpl-chapter-preview': '本章说',
  'qmpl-god': '神评',
  'qm-review': '书评',
};
/** 当前章节地址（`callBackJs` 的 `chapter` 绑定用；取不到给空串，源脚本自己有兜底） */
function chapterUrlForUi(): string {
  const ch = r.detail?.chapters?.[r.chapterIdx ?? 0];
  const p = ch?.payload as { chapterUrl?: unknown; url?: unknown } | undefined;
  return String(p?.chapterUrl ?? p?.url ?? r.chapter?.htmlBaseUrl ?? '');
}
/** `InAppBrowser` 的「本机 ↗」出口（模板里直接用 `window` 会被当成 store 的属性） */
function openSourceUiExternal(u: string): void {
  if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener');
}
async function openSourceUi(opts: { code?: string; event?: string; title?: string }): Promise<void> {
  const sid = String(r.sourceId ?? '');
  if (!sid || sourceUiBusy.value) return;
  sourceUiBusy.value = true;
  try {
    const payload = r.it0?.payload as { bookUrl?: unknown } | undefined;
    const res = await evalSourceUi(sid, {
      ...(opts.code ? { code: opts.code } : {}),
      ...(opts.event ? { event: opts.event } : {}),
      bookUrl: String(payload?.bookUrl ?? ''),
      bookName: String(r.detail?.title ?? ''),
      chapterUrl: chapterUrlForUi(),
    });
    for (const t of res.toasts ?? []) toast(t, 'info');
    if (res.browserUrl) {
      sourceUiOpen.value = { url: res.browserUrl, title: opts.title || '源界面' };
    } else if (!res.toasts?.length) {
      toast('源没有返回可显示的界面', 'warn');
    }
  } catch (e) {
    toast(`源界面打开失败：${String(e instanceof Error ? e.message : e)}`, 'warn');
  } finally {
    sourceUiBusy.value = false;
  }
}

/** HTML 正文 iframe 的报文入口：滚轮转发 / 页内导航 / LIVE 媒体 / 浮层 / `java` 垫片 */
function onHtmlFrameMessage(e: MessageEvent): void {
  const d = e.data as {
    yueduWheel?: number;
    yueduNav?: { url?: string; kind?: string };
    yueduLiveMedia?: unknown;
    yueduLayer?: unknown;
    yueduReaderJava?: { m?: unknown; args?: unknown[]; id?: unknown };
    yueduSourceUi?: { click?: unknown; type?: unknown };
  } | null;
  /**
   * `#444` **必须按报文来源过滤**（缺陷类别：多个 overlay 都把监听器挂在 `window` 上）。
   *
   * 症状（用户 2026-10-13 报 千白羽论坛）：「点正文里的 `.json` 链接 ⇒ 阅读页里渲染了 json，
   * **同时**在阅读页下面又用内置浏览器开了一份」—— 一次点击**两处都动**。
   * 真因：本监听器（以及 `DiscoverView`/`InAppBrowser` 的两个）都不看 `e.source`
   * ⇒ 谁家的 iframe 发报文，三个宿主**全都处理**。这里只认**本组件的正文 iframe**。
   */
  if (e.source !== htmlFrame.value?.contentWindow) return;

  // `#408` WebView 型正文页的 java 垫片报文（与高度/导航同一监听器，少一个全局监听）
  if (d?.yueduReaderJava) onReaderJavaMessage(d.yueduReaderJava);
  // `#583` 正文里的「源自绘按钮」（段评气泡 / 本章说 / 神评 / 书评）被点击
  if (d?.yueduSourceUi && typeof d.yueduSourceUi.click === 'string' && d.yueduSourceUi.click) {
    const type = String(d.yueduSourceUi.type ?? '');
    void openSourceUi({ code: d.yueduSourceUi.click, title: SOURCE_UI_TITLES[type] ?? '源界面' });
  }
  /**
   * `#432` **沙箱 iframe 的滚轮转发**（见 `utils/html-shell.ts` 的 `buildWheelBridge`）。
   *
   * 不透明 origin 的 iframe 是独立文档 ⇒ iframe 自己滚不动时，滚轮**不会**链到外层
   * `.se-body`（滚动链不跨文档边界）⇒ 用户「鼠标放正文上滚不动」。
   * 桥已在子文档侧做过「目标链上有没有可滚祖先」的判定（有则不转发），这里只负责滚。
   * ⚠️ 分页模式（`isPaged`）横向翻页，纵向不是滚动语义 ⇒ 不接。
   * ⚠️ 用 `scrollBy` 而非 `scrollTop +=`：与 `scroll-behavior: smooth` 等既有设置一致。
   */
  const wh = d?.yueduWheel;
  if (typeof wh === 'number' && wh && !isPaged.value) pageBodyEl.value?.scrollBy({ top: wh });
  // `#336` 壳层导航桥报上来的跳转（链接点击 / window.open）—— 一律留在页内
  const nav = d?.yueduNav;
  if (nav?.url) {
    if (nav.kind === 'legado') {
      // `#392`：导入链接走**统一派发器**（处理器在常驻宿主 `SchemeImportHost` 注册）。
      // 原来直调本组件的 `onLegadoUrl`，而那个函数与它的对话框都受 `v-if="r.open"` 门控。
      dispatchSchemeImport(nav.url);
    } else {
      /**
       * ★ `#387d`「正文里的链接**命中了本书章节** ⇒ 那是**换集**，不是跳转」（用户实测 AGE动漫）：
       * 章节页 `.card-body` 里的选集就是 `<a href="/play/<id>/<线路>/<集>">`，与 `ruleToc` 的
       * 章节 url **同形**。此前一律走 `navGo`（整页换成该地址）⇒ 用户点「第02集」被带离当前
       * 播放页（原话：「跳转解析云播放器页面，不停留在当前页面」）；正确语义是**换章**，
       * 与目录点击同一条路（`reader.openChapter`），正文/播放区随之换集。
       *
       * 判据落在 `utils/chapter-link.ts`（唯一实现，含 scheme/尾斜杠/相对路径的归一化口径）。
       * ⚠️ 换章必须 `resetNav()`：`frameDoc` = 栈顶 doc ?? htmlDoc，栈不清就会**继续显示旧页**。
       */
      const hit = findChapterIndexByUrl(r.detail?.chapters ?? [], nav.url);
      if (hit >= 0) {
        if (hit !== r.chapterIdx) {
          const ch = r.detail?.chapters?.[hit];
          if (ch) {
            resetNav();
            void r.openChapter(ch);
          }
        }
        // 点到「当前正在看的那一集」⇒ 什么都不做（不重载、不跳转）
        return;
      }
      /**
       * `#448` **同站页面 ⇒ 交源规则重渲染**（用户实测 91吃瓜：正文下方的「相关推荐」链接点开
       * 只加载了**原页面**，源的正文规则完全没生效）。
       *
       * 判据（与上游 `shouldOverrideUrlLoading` 的**意图**对齐）：同站（当前源的站，含子域）
       * **且像页面**（排除图片/媒体/压缩包/附件）⇒ 走 `readFirstDirect`：它落到 RSS 引擎的
       * `detail` ① 形态（`req.id` 是带 `link` 的 payload）⇒ 返回**单章目录** ⇒ 再由
       * `content()` 跑源的 `ruleContent` 渲染 ⇒ 与「发现页卡片点文章」**同一条通路**。
       *  · 源的正文页规则（论坛帖/板块页、WordPress 文章、图集文章）因此全部生效；
       *  · 附带把源作者写的 `shouldOverrideUrlLoading`（`java.open('rss',url)`）的落点补齐
       *    —— 本仓该字段仍 UNSUPPORTED，这里是**按判据的默认实现**（精确到 URL 模式的那层留 `D13`）。
       * 其余（异站 / 附件等资源）⇒ 页内浏览器 `navGo`，**与原行为一致**。
       */
      const siteUrl = sourceSiteUrlOf(st.sources, String(r.sourceId ?? ''));
      /**
       * `#575` **「网页即正文」会话里的同站链接 ⇒ 页内跳转，不重开会话**。
       *
       * 用户 2026-10-23 复测：「点击链接不是界面内跳转，而是又重新加载了阅读界面/加载页面」。
       * 真因：这里对同站页面一律 `readFirstDirect` —— 它会 `openDetail + reset + 重拉正文`，
       * 整个阅读会话被重建（工具栏/目录/滚动全重置），观感就是「重新加载阅读页」。
       * 但 `r.webDoc`（`openWeb`：网页型订阅源 / 极简浏览器）**正文就是网页本身**，
       * 同站链接的正确语义 = 浏览器式前进（`navGo` 更换 srcdoc，阅读器外壳不动）。
       * `#448` 的「同站交源规则重渲染」只适用于**RSS 文章会话**（`ruleContent` 要把页面变成正文）。
       */
      if (!r.webDoc && sameSite(nav.url, siteUrl) && looksLikePageUrl(nav.url)) {
        void r.readFirstDirect(String(r.sourceId ?? ''), {
          id: nav.url, kind: 'article', title: '', layout: 'text-row', payload: { link: nav.url, title: '' },
        });
        return;
      }
      void navGo(nav.url);
    }
  }
  // `#376` LIVE 观察桥：页内媒体地址变化（切集/换线路）
  if (d && 'yueduLiveMedia' in d) takeLiveMedia(d.yueduLiveMedia);
  // `#377①` 站点浮层出现 / 数量变化 ⇒ 把「当前可见带顶部」回灌（弹层才落在用户看得到的地方）
  if (d && 'yueduLayer' in d) {
    layerSeen.value = true;
    // ⚠️ 只推一次不够：弹层出现瞬间 iframe 可能仍在重排（内容撑高 ⇒ frameTop 变了）
    // ⇒ 用一串延迟重推追平布局落定（`setTimeout` 里再量一次真几何）；用户「无需固定」
    //   ⇒ 不做常驻轮询，这几次落定后即止。
    pushLayerViewportTop();
    for (const delay of [120, 360, 800]) window.setTimeout(pushLayerViewportTop, delay);
  }
}
onMounted(() => window.addEventListener('message', onHtmlFrameMessage));
onBeforeUnmount(() => window.removeEventListener('message', onHtmlFrameMessage));

/**
 * `#347` 深链处理器注册 —— **必须在挂载时就注册**（而不是等浮层打开）：
 * 桌面端冷启动时 IPC 会在「用户还没打开任何阅读页」时就到达，那时浮层还是关的。
 *
 * ★ `#392`：这个注册**已搬到 `SchemeImportHost.vue`**（`MainLayout` 里的常驻宿主），
 * 因为它打开的那两个导入对话框原来住在本组件里、受本组件根节点的 `v-if="r.open"` 门控
 * ⇒ 「阅读页没打开时点导入链接」等于没有反应（用户实测：登录界面内置浏览器里点「导入书源」无反应）。
 * 本组件现在只把正文里的导入链接**投递**过去（`dispatchSchemeImport`）。
 */

/* ==================== `#335` / `#336` 页内导航（「极简浏览器」） ==================== */

/**
 * 为什么阅读页需要一个导航栈
 *
 * 用户实测两条：① 阅读页里点链接 ⇒ 跳**系统浏览器新标签**，人被带离阅读器；
 * ② 就算页内打开了也**没有返回的路**。上游 `ReadRssActivity` 是 WebView ⇒
 * 点击就在同一个 WebView 里前进/后退。壳层（见 `utils/html-shell.ts` 的 `buildNavBridge`）
 * 负责把跳转拦下来报给这里，这里负责「真的换页 + 记住来路」。
 *
 * ★ 栈的第 0 项是**本章正文自身**（不是一次跳转）⇒ 返回到底就是回到文章本身。
 */
interface NavEntry {
  url: string;
  title: string;
  /** 补好壳的文档（喂 iframe） */
  doc: string;
  /**
   * `#574` 站点原始 HTML（不补壳）—— 站点定制弹窗的「HTML 源码」栏用它。
   * 与 `doc` 同一次取页拿到（见 `fetchWebPage`），不额外再请求一遍。
   */
  raw: string;
}
const navStack = ref<NavEntry[]>([]);
const navIdx = ref(0);
const navLoading = ref(false);
const navErr = ref('');
/** `#444` 正文沙箱 iframe —— 只认它的报文（`onHtmlFrameMessage` 的来源过滤，见该函数头注） */
const htmlFrame = ref<HTMLIFrameElement | null>(null);

/** 实际喂给 iframe 的文档：没跳转过 ⇒ 本章正文；跳转过 ⇒ 栈里当前这一页 */
const frameDoc = computed(() => navStack.value[navIdx.value]?.doc ?? htmlDoc.value);
/** 当前页地址（第 0 项可能是正文，没有 url ⇒ 这时不显示地址、也不给「重新加载」） */
const curNavUrl = computed(() => String(navStack.value[navIdx.value]?.url ?? ''));
/**
 * `#574` 站点定制弹窗左栏显示的源码：
 *  · 页内导航过（`navIdx > 0`）⇒ 当前那一页的**原始 HTML**（`navGo` 同一次取页带回来的 `raw`）；
 *  · 栈底 / 没导航过 ⇒ 本章正文的原始 HTML。
 * ⚠️ 不能用 `frameDoc`：那是**补过壳**的文档（含我们注入的脚本与样式）。
 */
const customizeHtml = computed(() =>
  navIdx.value > 0 ? String(navStack.value[navIdx.value]?.raw ?? '') : rawChapterHtml.value,
);

/* ── `#355` 嗅探条（底部固定 · 半透明 · 10s 自动收缩为「嗅」）────────────────
 *
 * 用户 2026-10-08 要求：嗅探条放**页面底部**、**固定不随正文滚动**、**半透明**，
 * 且**浮出 10s 没操作就自动向右收缩成一个「嗅」图标**（点图标再展开）。
 *
 * ★ 为什么从「正文里的横条」改成「面板层常驻浮条」：
 *   原来它挂在 HTML 正文分支里（`.se-body` 的滚动内容内）⇒ 一滚就跟着走，
 *   而媒体直链是**整章**的属性、不是某一屏的 —— 底部固定更符合「随时能点」。
 *
 * ★ 收缩不卸载：与页眉同一条纪律（`#221`）—— 卸载会改变 scrollHeight ⇒ 滚动位置回调 ⇒
 *   可能触发「是否滚动过」判据翻转 ⇒ 闪烁。这里只用 CSS 过渡改形态，DOM 始终在。
 *
 * ★ 覆盖范围（`sniffUrl` 的唯一判据 = 引擎下发的 `chapter.media.url`）：
 *   ① 订阅源 / 影视聚合的 HTML 正文（`#352`：html + media 并存，源规则展示结果不变）；
 *   ② **书源正文**：engine-legado 对「文本源里整段就是一条裸直链」的章也下发 media
 *      （`content/media-extract.ts` 的 sole-link 救援）⇒ 同一条嗅探条同样浮出。
 *   纯音频/文件章另有正文区内的说明卡（语义不同：一个讲「浮窗播放器」、一个是下载链接），
 *   不并入本条 —— 但视频类一律走这条，避免同一动作两处入口。
 *
 * ⚠️ `#374` 位置纪律（2026-10-09 真浏览器实证的 TDZ 崩溃）：本区块**必须整体位于
 *   上方 NAV 声明区之后**——`watch(sniffUrl)` 建立时 Vue 会**立即求值一次 getter**
 *   （非 immediate 分支也要拿 oldValue），此刻还是 setup 同步段：getter 链
 *   `sniffUrl → navSniffMedia → navIdx/frameDoc/curNavUrl` 若有任何一个 const
 *   尚未声明，就是 `ReferenceError: Cannot access ... before initialization`
 *   ⇒ 渲染树中断 ⇒ 整个阅读浮层（.se-mask）静默消失（store 状态一切正常，
 *   console 里有错但用户视角是「点了没反应」）。块内顺序同理：被引用者必须在前。
 */
const SNIFF_COLLAPSE_MS = 10_000;
/**
 * `#374` NAV 页内嗅探：阅读页里**跳转过**（NAV 第 1+ 项）后，对当前页 HTML 跑
 * core 的媒体直链提取（唯一实现 `mediaFromRaw`，含「主候选必须像媒体」门槛 +
 * 绝对化 + format 推断）。命中 ⇒ 嗅探条显示**当前页**的直链（用户实测苹果MCS
 * 美剧分类：点列表切选集后嗅探仍停在章级旧链接 ⇒ 就是缺这一路）。
 *
 * 为什么只在 `navIdx > 0` 提取：第 0 项是**本章正文自身**，其媒体引擎已提取过
 * （`chapter.media`），重复提取只会引入两份判据；跳转页才是章级信息覆盖不到的盲区。
 * 引用的 `navStack`/`frameDoc`/`curNavUrl` 就是**上方** NAV 区块（`#335/#336`）——
 * 位置纪律见本区块头部的 TDZ 注释。
 */
const navSniffMedia = computed(() => {
  if (navIdx.value <= 0) return undefined;
  const doc = frameDoc.value;
  const base = curNavUrl.value;
  if (!doc || !base) return undefined;
  return mediaFromRaw(doc, base) ?? undefined;
});
/**
 * `#376` srcdoc 重建（换章 / NAV 跳转 / 返回）⇒ 旧页的 LIVE 观察结果作废：
 * 新 srcdoc 里的观察桥是新实例（天然从零开始），父页侧若不清空，嗅探条会在
 * 「新页报文没到」的窗口期挂着旧页直链。⚠️ 必须在 `frameDoc`（上方 NAV 区）之后。
 */
watch(frameDoc, () => { liveSniff.value = null; });
/**
 * ★ 排除 `file` / `audio`：这两类在正文区另有**语义不同**的入口（下载链接 / 「由浮窗播放器
 *   播放」说明），再叠一个「▶ 唤起播放器」就是同一件事两个入口、且 file 根本播不了。
 */
const sniffUrl = computed(() =>
  ['file', 'audio'].includes(String(r.detail?.kind ?? ''))
    ? ''
    // `#376` 三级优先：LIVE（页内**实时**挂载，切集即变）> NAV 静态快照提取 > 章级 media
    : (liveSniff.value?.cur || navSniffMedia.value?.url || String(r.chapter?.media?.url ?? '')));
/**
 * `#462`（`D14` = **A**）**「播放器页」线路的写明** —— 用户 2026-10-15 拍板：保持现状 + dock 写明。
 *
 * 背景（真机取证，见 logs-15 §六十八 (C)）：MacCMS 类源的一集可能有两种形态 ——
 *  · **直链**（`…/play/<token>/index.m3u8`）⇒ 整条线路都能被静态抽出，dock 能直接选集；
 *  · **播放器页**（`…/play/<token>`，**无扩展名**）⇒ `MEDIA_EXT_RE` 判据**故意**不收它
 *    （它不是媒体流，喂给 hls.js 必 `manifestParsingError`），于是 dock 只剩
 *    LIVE 桥看到的**正在播放的那一条**。
 * 用户实测两条线路因此「一条 1 条、一条 12 条」看着像 bug —— 拍板 **A**：不改判据，
 * 但要**把这件事写明**，别让用户以为是漏抽。
 */
const sniffIsPlayerPage = computed(() => {
  const u = sniffUrl.value;
  if (!u) return false;
  const bare = u.replace(/\?.*$/, '');
  return !/\.(m3u8|mp4|flv|mkv|ts|webm|mov)$/i.test(bare) && !/\/m3u8|hls|\.mp4|\/video\//i.test(bare);
});
const sniffCollapsed = ref(false);
let sniffTimer: ReturnType<typeof setTimeout> | null = null;
/** 重新计 10s（展开 / 换章都调它） */
function armSniffTimer(): void {
  if (sniffTimer) clearTimeout(sniffTimer);
  sniffTimer = null;
  if (!sniffUrl.value) return;
  sniffTimer = setTimeout(() => { sniffCollapsed.value = true; }, SNIFF_COLLAPSE_MS);
}
/** 点收缩态的「嗅」图标 ⇒ 展开并重计时 */
function expandSniff(): void {
  sniffCollapsed.value = false;
  armSniffTimer();
}
/** 手动收起（展开态的「›」）—— 与自动收缩共用一个状态位，不写第二套 */
function collapseSniff(): void {
  sniffCollapsed.value = true;
  if (sniffTimer) clearTimeout(sniffTimer);
  sniffTimer = null;
}
watch(sniffUrl, (u) => {
  sniffCollapsed.value = false; // 换章 ⇒ 重新浮出（本章的直链是新信息）
  if (!u) {
    if (sniffTimer) clearTimeout(sniffTimer);
    sniffTimer = null;
    return;
  }
  armSniffTimer();
});
onBeforeUnmount(() => {
  if (sniffTimer) clearTimeout(sniffTimer);
  sniffTimer = null;
});

function resetNav(): void {
  navStack.value = [];
  navIdx.value = 0;
  navErr.value = '';
}
/** 首次跳转前把「本章正文」压成第 0 项（它是返回链的终点，不能是空栈） */
function seedNav(): void {
  if (navStack.value.length) return;
  navStack.value = [{
    url: String(r.chapter?.htmlBaseUrl ?? ''),
    title: String(r.chapter?.title ?? ''),
    doc: htmlDoc.value,
    raw: rawChapterHtml.value,
  }];
  navIdx.value = 0;
}

async function navGo(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  navLoading.value = true;
  navErr.value = '';
  try {
    const page = await fetchWebPage(url, String(r.sourceId ?? ''));
    seedNav();
    const stack = navStack.value.slice(0, navIdx.value + 1);
    stack.push({ url, title: url, doc: page.doc, raw: page.raw });
    navStack.value = stack;
    navIdx.value = stack.length - 1;
  } catch (e) {
    // 兜底必须留痕（铁律 3）：跳转失败要让用户看见，而不是「点了没反应」
    navErr.value = String(e instanceof Error ? e.message : e);
    toast('页内跳转失败：' + navErr.value, 'error');
  } finally {
    navLoading.value = false;
  }
}
function navBack(): void {
  if (navIdx.value <= 0) return;
  navIdx.value -= 1;
}
function navForward(): void {
  if (navIdx.value >= navStack.value.length - 1) return;
  navIdx.value += 1;
}
async function navReload(): Promise<void> {
  const e = navStack.value[navIdx.value];
  if (!e?.url) return;
  navLoading.value = true;
  navErr.value = '';
  try {
    const page = await fetchWebPage(e.url, String(r.sourceId ?? ''));
    const stack = navStack.value.slice();
    stack[navIdx.value] = { ...e, doc: page.doc, raw: page.raw };
    navStack.value = stack;
  } catch (err2) {
    navErr.value = String(err2 instanceof Error ? err2.message : err2);
    toast('重新加载失败：' + navErr.value, 'error');
  } finally {
    navLoading.value = false;
  }
}

/**
 * `#392` 唤起导入（`#343`）的处理与对话框**已迁到 `SchemeImportHost.vue`**（常驻宿主）。
 *
 * ⚠️ 为什么必须搬走：本组件模板根节点是 `<div class="se-mask" v-if="r.open">`
 * —— 阅读页**没打开**时整棵子树不渲染 ⇒ 「在登录界面的内置浏览器里点『导入书源』」
 * 对话框渲染不出来（`srcImportOpen` 置真也没用）。宿主搬到 `MainLayout` 后不受门控。
 * 判据仍在 `utils/scheme-import.ts` 一份，别在别处重写。
 */

// 换章要复位导航栈，否则会沿用上一章的来路
watch(() => r.chapterIdx, () => { resetNav(); stopAutoScroll(); });
const totalPct = computed(() => {
  const n = totalCh.value;
  if (!n || !r.chapter) return 0;
  const done = Math.max(0, r.chapterIdx);
  const within = isComic.value ? (comicImgCount.value ? curImg.value / comicImgCount.value : 1) : readRatio.value;
  const pct = ((done + Math.min(1, Math.max(0, within))) / n) * 100;
  return Math.min(100, Math.max(0, pct));
});
/**
 * 总进度的**显示文本**：位数自适应。
 *
 * 为什么不能直接用整数：一本 2170 章的书，第 1 章读到底也只有 `0.046%` ——
 * 四舍五入成整数会**长时间显示 0%**，看着像坏了。所以 <1% 给两位、<10% 给一位、其余取整。
 */
const totalPctText = computed(() => {
  const p = totalPct.value;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  return `${p.toFixed(2)}%`;
});
function updateProgress(): void {
  // ★ `#251`：几何基准改用**正文格 `.se-body`**（唯一滚动容器）。
  //   旧注释说「用 .se-scroll」的前提是页眉页脚在滚动内容里 —— 三段布局后它们在容器外面，
  //   `.se-scroll` 的 bottom 会把页脚高度算进可视区，读数会偏；正文格才是「用户看到的正文窗口」。
  const el = pageBodyEl.value ?? scrollEl.value;
  if (!el || !r.chapter) return;
  // `#224` **分页模式**：整列都在视口内 ⇒ 滚动那套几何算出来恒为 1（读数不动）。
  // 改用「当前页 / 总页数」—— 这也正是分页语义下用户理解的「读到哪了」。
  if (pagedActive.value) {
    const n = pageCount.value;
    readRatio.value = n <= 1 ? 1 : Math.min(1, Math.max(0, (curPage.value - 1) / n));
    return;
  }
  if (isComic.value) {
    // `#834` 按**占位容器**计数，不能按 `.rd-comic img` —— 只有预取完成的图才挂 `<img>`，
    // 按 img 数会把「读到第几张」算小（未加载的图全被漏掉）。
    // `#841` 三章拼接后容器里同时有前/后章 ⇒ **只按当前章**统计（data-cch），
    // 视口落在下一章算本章读完、落在上一章算本章未开始。
    const top = el.getBoundingClientRect().top + 8;
    const all = Array.from(el.querySelectorAll<HTMLElement>('.rd-comic .rd-imgwrap[data-cch]'));
    const count = comicImgCount.value;
    if (!all.length || !count) { curImg.value = 1; readRatio.value = 1; return; }
    const cur = r.chapterIdx;
    let idx = count;
    const vis = all.find((w) => w.getBoundingClientRect().bottom > top);
    if (vis) {
      const ch = Number(vis.dataset['cch']);
      if (ch < cur) idx = 1;
      else if (ch > cur) idx = count;
      else idx = Number(vis.dataset['ci']) + 1;
    }
    curImg.value = Math.min(count, Math.max(1, idx));
    readRatio.value = curImg.value / count;
    return;
  }
  const content = el.querySelector<HTMLElement>('.rd-content');
  if (!content) { readRatio.value = 1; return; }
  const bodyRect = el.getBoundingClientRect();
  const cRect = content.getBoundingClientRect();
  const h = cRect.height || 1;
  readRatio.value = Math.min(1, Math.max(0, (bodyRect.bottom - cRect.top) / h));
}
let progressRaf = 0;
function onPanelScroll(): void {
  // ★ `#251`：`.se-scroll` 已改 `overflow: hidden`（自身不滚）⇒ 这个回调正常**永远不触发**，
  //   保留只为防御：万一未来布局回退成「.se-scroll 可滚」，进度条不至于静默失灵。
  //   「向下滚过 40px」的判据已移到 `onPageScroll`（读 `.se-body`，唯一滚动容器）。
  if (progressRaf) return;
  progressRaf = requestAnimationFrame(() => { progressRaf = 0; updateProgress(); });
}

/**
 * `#224` 分页时列容器（`.se-body`）的横向滚动回调。
 *
 * 与 `onPanelScroll` 分开是因为**判据不同**：
 *  · 容器滚动（`.se-scroll`）⇒ 纵向位置变了 ⇒ 判「向下滚过没有」
 *  · 列滚动（`.se-body`）⇒ 横向位置变了 ⇒ 判「翻到第几页」
 * 合成一个函数里会互相覆盖状态（这正是 `#231` 页眉闪烁那类反馈环的来源）。
 */
function onPageScroll(): void {
  const el = pageBodyEl.value;
  if (!el) return;
  // `#807`：右键菜单是光标锚定的，正文一滚就失去语境 ⇒ 直接收掉
  if (ctxMenuOpen.value) hideCtxMenu();
  // `#815`：划词菜单同理（选区在滚出视口后就点不到了）—— 两种文字菜单的关闭条件必须一致
  if (selMenuOpen.value) hideSelMenu();
  // `#377①` 站点浮层出现后：用户滚到哪，弹层就跟着待在**可见带中央**（回灌 iframe 坐标系 Y）
  if (layerSeen.value) pushLayerViewportTop();
  // ★ `#251` 滚动模式：`.se-body` 是**唯一**的滚动容器（`.se-scroll` 已 overflow:hidden）
  //   ⇒ 「向下滚过 40px」的判据改读正文格自己的 scrollTop。
  //   原来读 `.se-scroll` 的（`onPanelScroll` 里）—— 三段布局后它恒为 0，
  //   页眉的「自动隐藏」就永远不会触发。进度条几何也跟着换基准（见 `updateProgress`）。
  // ★ `#811` **这里绝对不能读 `isPaged`** —— 详情页也共用 `.se-body`，
  //   偏好还是分页时会误把详情页的竖向滚动当成「翻页」。
  if (!pagedActive.value) {
    scrolledDown.value = el.scrollTop > 40;
    if (progressRaf) return;
    progressRaf = requestAnimationFrame(() => {
      progressRaf = 0;
      updateProgress();
      // `#833` 无限滚动：与进度更新同一帧（一帧至多一次几何判定）
      infOnScroll();
      // `#841` 漫画三章拼接：同一拍做方向判定 + 交界交接
      comicOnScroll();
    });
    return;
  }
  // `#825` 分页模式**没有滚动**（`.se-body` 是 `overflow:hidden`，翻页只换切片）
  // ⇒ 落到这里就直接结束：**不许**在滚动回调里做任何测量/重排（`#811` 卡死的教训）。
}

/**
 * `#224` **点正文左右两侧翻页**。
 *
 * ## 为什么用「两侧热区」而不是点任意处
 * ① 选文（划线/高亮）也是点正文 —— 若整块都当翻页热区，**选完字会立刻翻页**。
 * ② 滚动模式里点正文是滚动的自然延续，分页模式里「点 = 翻」必须给明确的落点。
 *
 * ## 为什么要排除交互元素
 * 段落里的 `<img>`（点开看大图）、`<a>`、按钮、输入框都不能触发翻页 ——
 * `closest()` 一次判掉，比逐个 class 排除可靠（新增交互元素时不会漏）。
 */
function onPageAreaClick(e: MouseEvent): void {
  // `#811`：详情页共用 `.se-body` ⇒ 只认「真的在阅读」的分页，否则详情页点击会被当成翻页
  if (!pagedActive.value) return;
  // 手势拖拽结束后紧跟的 click 不能再触发一次翻页（拖拽本身已经决定了结果）
  if (performance.now() - curlDragEndAt < 350) return;
  // 拖动选区（划线）结束的 click 也会冒到这里 ⇒ 有选区就不翻页
  if (typeof window.getSelection === 'function' && !window.getSelection()?.isCollapsed) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('a, button, input, textarea, select, .rd-media, .rd-comic, [contenteditable="true"]')) return;
  const body = pageBodyEl.value;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / (rect.width || 1);
  // 正中间留一块**误触区**：分页里点正文最可能是想选字，不该立刻翻页
  if (ratio >= 0.38 && ratio <= 0.62) return;
  const dir: -1 | 1 = ratio < 0.38 ? -1 : 1;
  if (!turnPage(dir)) {
    /**
     * ★ `#244` 翻到边界时的行为：**两个方向都要接相邻章**。
     *
     * 原先只做了「末页往后 → 下一章」，而「首页往前」只闪一下 ⇒
     * 用户报「**无法向前翻页**」：从第 2 页往前能翻（页内），但从第 1 页往前就卡住了。
     * 键盘 `←` 已经是「到首页 ⇒ 上一章末页」，这里必须**与它一致**（否则鼠标与键盘行为分裂）。
     * 真的到全书首尾才闪提示。
     */
    const lastIdx = (r.detail?.chapters?.length ?? 0) - 1;
    if (dir === 1 && curPage.value >= pageCount.value && r.chapter && r.chapterIdx < lastIdx) {
      void nextChapterPastEnd();
    } else if (dir === -1 && curPage.value <= 1 && r.chapter) {
      void prevChapterToEnd(); // 含「第 1 章首页」：函数内闪一下 + toast 已是第一页
    } else {
      edgeFlash.value = dir;
      setTimeout(() => { edgeFlash.value = 0; }, 260);
    }
  }
}
/** 到边界的短暂提示（`±1` 表示在左/右侧闪一下，0 = 无） */
const edgeFlash = ref<-1 | 0 | 1>(0);


/** **4-3 目录 / 书签 / 标注 / 搜索侧滑浮层** */
const sidePanel = ref(false);
/** `#274` 换源对话框（原内嵌 switch-panel 已抽独立组件） */
const switchDlgOpen = ref(false);
const sideTab = ref<'toc' | 'bookmarks' | 'highlights' | 'search'>('toc');
const readStyleOpen = ref(false);
/**
 * `#203` 朗读浮条是否展开。
 *
 * ★ **默认不展开**：浮条会占掉浮层底部一条，正文可视高度变小；
 * 而「进入阅读就想被念」不是多数人的诉求（用户是主动点「🔊 朗读」才要）。
 * 一旦朗读**真的在跑**（`al.active`）就保持展开 —— 暂停/停止由用户点，
 * 不在用户操作时自动收起（自动收起会让人以为朗读停了）。
 */
const alOpen = ref(false);
const al = useReadAloudStore();
/**
 * 工具条入口的**三态**点击（每种都有明确结果，不留「点了没反应」的分支）。
 *
 * ★★ 判据必须用 `isPlaying` / `isPaused` **分别**判，不能用 `active`（= 非 idle）一把罩住。
 *   踩过的坑（用户 2026-10-02 报）：暂停后按钮文案是「⏸ 已暂停（点此继续）」，
 *   但 `active` 在 `paused` 时**也为 true** ⇒ 走进「停止」分支 ⇒
 *   **点「继续」实际是「停止」**：`finish()` 清掉句子表与位置 ⇒ 文案变回「🔊 朗读」、
 *   声音停了、位置也丢了；用户必须再点一次浮条里的「▶ 朗读」才重新开始（且从头念）。
 *   「点了没反应」与「点了做错事」同样糟，判据选错就修不到。
 *
 * · 正在念（`isPlaying`）→ **停止**（此时收起浮条会让用户失去停止入口，声音还在响）
 * · 已暂停（`isPaused`）→ **继续**（`resume()` 从 `index`/`innerPos` 续读，对齐上游
 *   `TTSReadAloudService.resumeReadAloud()` = `super.resumeReadAloud()` + `play()`）
 * · 未在念（`idle`）→ 展开浮条**并立刻开播**（用户 2026-10-02 晚 Add 3：一个动作完成两件事）
 */
async function onReadAloudEntry(): Promise<void> {
  if (al.isPlaying) {
    al.stop();
    // ★ 必须同时**收起整条**：`ReadAloudBar` 的挂载条件是 `(alOpen || al.active)`，
    //   只 `stop()` 的话 `al.active` 变 false 但 `alOpen` 仍为 true
    //   ⇒ 浮条（连右下角那枚折叠 FAB）**留在页面上** —— 声音停了，面板却还在。
    //   与浮条上「■ 停止」（`stopAndCollapse`：stop + 收起）保持**同一语义**。
    alOpen.value = false;
    return;
  }
  if (al.isPaused) {
    al.resume();
    return;
  }
  alOpen.value = true;
  // `#822`：开播前读一次设置页的 TTS 配置 —— 总开关关 / 没选引擎时仍走系统语音，
  // 开了就用用户选的 HTTP 引擎。取配置失败会静默回落系统语音（旧服务端也能读）。
  await al.refreshTtsBackend();
  al.play();
}

/**
 * ★ 用户 2026-10-02 Add 1b：**离开阅读正文时朗读要自动停止并收起**。
 *
 * ## 判据为什么不是「`r.open` 变 false」—— 那会漏掉最常见的一条
 * 离开正文有**两条**路径（`onKey` 的 Escape 分支写得很清楚）：
 *   ① `close()`  —— 关掉整个阅读浮层（`r.open` → false）
 *   ② `reset()`  —— **只退回详情/目录**（`r.open` 仍 true，只把 `chapter` 清空）
 * 只盯 `r.open` 的话，**在正文里按 Esc 会留下一条还在念、还挂着的浮条** ——
 * 而这恰恰是用户最常做的动作。⇒ 判据取 `r.chapter`（当前有没有正文），
 *   两条路径都覆盖（`close()` 也会把 `chapter` 置空）。
 *
 * ## 为什么不在各处 close()/reset() 里加一行
 * 路径不止这两条（换源、目录里选别的书、`r.reset()` 的其他调用点…），
 * 逐条加必然漏。`chapter` 由有变无是**所有离开正文路径的共同收口** ⇒ 在此拦一次。
 *
 * ## 与上游的差别（有意为之，别照抄）
 * 上游 `ReadAloud.stop()` **只发 Intent**，浮条由 `bottomDialog` 独立管理
 * ⇒ 上游「停止 ≠ 收起」（`#203` 探针取证过）。本条是 Web 端的产品决定：
 * 正文都退出了，浮条没有任何意义 ⇒ 停止 + 一起收起。
 */
watch(
  () => r.chapter,
  (nowChapter, wasChapter) => {
    if (wasChapter && !nowChapter) {
      al.stop();
      alOpen.value = false;
      // ★ 顺手清掉「当前朗读段」高亮：正文都没了，还留一条亮着会显得像坏了
      clearSpeakingHighlight();
    }
  },
);
const sideTocEl = ref<HTMLElement | null>(null);
/** 侧栏根元素（打开「搜索」tab 后把输入框聚焦用） */
const sideEl = ref<HTMLElement | null>(null);
/**
 * 「跳到的命中处」临时标记的区间（显示层坐标系）。
 *
 * 与高亮分开存：它**不是**用户数据（不落库、不可点删），2.6 秒后自动清掉。
 * 若混进 `currentChapterHighlights` 会被当成真高亮（可点、会推送服务端）—— 那是错的。
 */
const flashRange = ref<[number, number] | null>(null);
/** 打开浮层后把**当前章**滚进可视区（用户要求：选中状态 + 自动滚动到可见） */
function scrollSideToCurrent(): void {
  const el = sideTocEl.value;
  if (!el) return;
  const cur = el.querySelector<HTMLElement>('.is-cur');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

/**
 * `#294` 目录项是不是「当前章」（内联目录 + 侧栏目录**共用这一个判据**，不许各写一份）。
 *
 * · 音频书：看「正在播放的那一条」（原有语义，未改动）；
 * · 已打开正文（`r.chapter` 非空）⇒ `r.chapterIdx`（当前正文的章号）；
 * · **详情页**（从书架点「详情」进来，没打开正文）⇒ `r.lastReadIdx`（书架记录里的进度章）。
 *   ⚠️ 用户 2026-10-05 实测：「书架书籍打开详情页，目录列表：当前阅读章节应该在可视区域，
 *      且处于选中态」—— 此前只认 `chapterIdx`，而详情页恒为 -1 ⇒ 一章都不高亮、也不滚动。
 */
function isCurChapter(i: number): boolean {
  // ⚠️ 必须写 `.value`：这段判据原来直接写在 `:class` 表达式里，模板中 ref **会自动解包**；
  //   搬进 `<script setup>` 的函数后就**不会**了 —— `isAudio` / `playingThis` 是 ComputedRef
  //   **对象**，永远为真 ⇒ 所有章节都落进音频分支 ⇒ `audio.index === …` 对谁都不成立 ⇒
  //   **一章都不高亮**（连原本正常的音频模式也一起坏掉）。上一轮就是这么把 `#294` 做成了哑弹：
  //   `vue-tsc` 不会报（条件恒真是合法 TS），只有真浏览器探针能抓到。
  if (isAudio.value) return playingThis.value && audio.index === readableIdxOf(r.detail?.chapters ?? [], i);
  return (r.chapter ? r.chapterIdx : r.lastReadIdx) === i;
}

/** `#294` 详情页**内联目录**容器（要滚动的是它自己，不是整个详情页） */
const detailTocEl = ref<HTMLElement | null>(null);
/**
 * `#294` 把详情页内联目录里的当前章滚进可视区。
 *
 * ⚠️ **不能用 `scrollIntoView`**：那会把**所有**可滚动祖先一起滚（`.se-scroll` 也跟着动）
 * ⇒ 详情页一打开就自己往下跳一段，观感像「页面自己跑了」。这里只改列表自己的 `scrollTop`
 * （用 getBoundingClientRect 差值算目标偏移，避开 offsetParent 不确定的问题）。
 */
function scrollDetailTocToCurrent(): void {
  const el = detailTocEl.value;
  if (!el) return;
  const cur = el.querySelector<HTMLElement>('.is-cur');
  if (!cur) return;
  const cr = cur.getBoundingClientRect();
  const lr = el.getBoundingClientRect();
  const delta = cr.top - lr.top - (el.clientHeight - cr.height) / 2;
  el.scrollTop = Math.max(0, el.scrollTop + delta);
}
/** 目录/进度变化 ⇒ 重新把当前章滚进视野（`r.detail` 到位那一拍 DOM 还没渲染，故等 nextTick） */
watch(
  [() => r.detail?.chapters?.length, () => r.chapter, () => r.lastReadIdx, () => r.chapterIdx],
  () => { void nextTick(scrollDetailTocToCurrent); },
);
function openSide(tab: 'toc' | 'bookmarks' | 'highlights' | 'search' = 'toc'): void {
  sideTab.value = tab;
  sidePanel.value = true;
  void nextTick(() => {
    if (tab === 'toc') scrollSideToCurrent();
  });
}
/** 「更新目录」：重拉详情+目录；书架里的书会顺带刷新本地化的目录信息（章节数/更新时间） */
async function updateToc(): Promise<void> {
  await reloadDetail();
  toast('目录已更新', 'ok');
}

/** **4-3 离线缓存对话框**（`#207`：任务交给**下载中心**，进度在「下载管理」里也能看到） */
const cacheOpen = ref(false);
const cacheFrom = ref(1);
const cacheTo = ref(1);
/** 当前这本书的下载任务（同一本书只可能有一个 —— 中心按书键去重） */
const cacheJob = computed(() => (r.currentKey ? dl.jobOf(r.currentKey) : undefined));
function openCacheDialog(): void {
  cacheFrom.value = Math.max(1, r.chapterIdx + 1);
  cacheTo.value = Math.max(1, totalCh.value);
  cacheOpen.value = true;
}
async function confirmCache(): Promise<void> {
  const from = Math.max(1, Number(cacheFrom.value) || 1);
  const to = Math.max(1, Number(cacheTo.value) || 1);
  cacheOpen.value = false;
  const key = r.currentKey;
  if (!key || !r.sourceId) { toast('这本书没有源信息，无法缓存', 'warn'); return; }
  if (!dl.canDownload(r.sourceId)) { toast('本地书的正文就在本机，不需要缓存', 'info'); return; }
  const t = await dl.enqueue({
    key,
    sourceId: r.sourceId,
    payload: r.it0?.payload,
    title: r.detail?.title ?? '',
    ...(r.detail?.author ? { author: r.detail.author } : {}),
    ...(r.detail?.cover ? { cover: r.detail.cover } : {}),
    from: Math.min(from, to) - 1,
    to: Math.max(from, to) - 1,
  });
  toast(t ? `已开始后台缓存：第 ${Math.min(from, to)} ~ ${Math.max(from, to)} 章` : '加入下载队列失败', t ? 'info' : 'warn');
}
/** 跳到「下载管理」（看全局进度 / 暂停续跑 / 重试失败章） */
function goDownloads(): void {
  cacheOpen.value = false;
  void router.push('/downloads');
}

/**
 * **4-4 选中文字菜单**。
 *
 * ★★ `#255`（用户 2026-10-04）把菜单分成**一级 / 二级**：
 *   一级 = 复制 / 书签 / 字典 / 高亮 / 笔记 / 更多（最常用的六枚）
 *   二级（「更多」下拉）= 全选 / 替换 / 搜全书 / 本地字典
 *
 * 为什么必须分：Web 端横排 9 枚会撑到 **比正文还宽**（`SELMENU_HALF_W` 的左右防越界就是被它逼出来的），
 * 且越靠右的按钮越要「顺着菜单往右瞄」才找得到。
 *
 * ★ 上游对照：`res/menu/content_select_action.xml` 里带 `app:showAsAction="never"` 的条目
 *   （高亮 / 搜索正文 / 浏览器 / 分享）就是 Android 的「收进溢出菜单」语义
 *   ⇒ **上游本来就有这条分界**，本条是按用户要求重排，不是凭空发明。
 *   （上游一级是 替换/复制/书签/朗读/字典，本仓按用户口径改，理由记在此处便于日后对照。）
 *
 * ⚠️ 标签也从「划线」改成 **`高亮`** —— 内部实现本来就叫 highlight（`addHighlightFromSelection`
 *   / `HIGHLIGHT_STYLE_*`），只有按钮文案是「划线」，属历史遗留；`#256` 才做「独立配置的高亮标记」。
 */
const selMenuOpen = ref(false);
/**
 * `#255`：二级菜单（「更多」）是否展开。
 * ★ 必须跟着一级一起收（见 `hideSelMenu`），否则下次选中会**自带一个开着的下拉**。
 */
const selMoreOpen = ref(false);
/** `#255`：下拉朝向 —— `true` = 朝下（默认朝上，理由见 `toggleSelMore()`） */
const selMoreDown = ref(false);
const selText = ref('');
/** 选区起点（书签跳转用）。**现在是准确值** —— 由 `domRangeToBody()` 算出，不再是 `indexOf` 的首个命中 */
const selPos = ref(0);
/**
 * 选区的 `[起点, 终点)`（正文偏移）。
 * `null` = 选区**不是一段可高亮的正文**（落在标题上 / 漫画图 / 跨出正文容器）⇒ 「高亮」按钮要禁用。
 * 对齐上游：`ContentTextView.createHighlight()` 里 `if (startLine.isTitle || endLine.isTitle) return null`。
 */
const selRange = ref<[number, number] | null>(null);
/** 「笔记」的内联输入（不用 `window.prompt`：它会阻塞整个页面，且样式与阅读界面完全脱节） */
const noteOpen = ref(false);
const noteText = ref('');
/**
 * 选区菜单「替换」：新建一条净化规则（对齐 Legado 的菜单 Replace 项）。
 * `#260` 起**不再是本组件里的简化弹窗** —— 改用三处共用的 `ReplaceRuleDialog`
 * ⇒ `replaceDraft != null` 就是「弹窗开着」（不再需要单独的 `replaceOpen` 布尔）。
 */
const replaceDraft = ref<ReplaceRule | null>(null);
/** `#260`：起效的替换规则列表（对齐上游 `EffectiveReplacesDialog`） */
const effReplacesOpen = ref(false);
/** `#261` 手动规则集对话框 */
const manualRulesOpen = ref(false);
/** `#262` 高亮规则：管理列表 / 编辑器对话框 + 保存回调 */
const hrRulesOpen = ref(false);
const ruleEditDraft = ref<HighlightRule | null>(null);
const ruleEditCreating = ref(false);
async function saveRuleEdit(rule: HighlightRule): Promise<void> {
  const err = await hr.save(rule);
  if (err) { toast(err, 'warn'); return; }
  ruleEditDraft.value = null;
  toast('已保存高亮规则');
}
/**
 * `#256` 点已有高亮弹出的**动作栏**（对齐上游 `showHighlightActionMenu`，
 * `ReadBookActivity.kt:1148-1183`：样式 / 备注 / 创建规则 / 复制 / 删除）。
 *
 * ★ 与 `#146`~`#255` 的旧实现差别：旧的是一个「就地改样式」的面板（底色/下划线/文字 + 删除），
 *   现在改成**先选动作、再进各自的界面** —— 与上游一致，也才装得下「备注 / 创建规则 / 复制」。
 */
const hlMenuOpen = ref(false);
const hlMenuXY = ref({ x: 0, y: 0 });
/** 当前操作的那条高亮的 `time`（主键）。动作栏 / 样式对话框 / 备注框三处共用 */
const hlMenuTime = ref(0);
/** 当前那条高亮**文字**（样式对话框的预览条要拿它当样本） */
const hlMenuText = ref('');
/** 样式对话框是否打开（`#256`） */
const hlStyleOpen = ref(false);
/** 样式对话框的初值：当前那条高亮**解析后**的样式 */
const hlStyleDraft = ref<HighlightStyleView>({ ...HIGHLIGHT_STYLE_EMPTY });
/** 备注框是否打开（`#256`）+ 草稿（改的是副本，「保存」才落库） */
const hlNoteOpen = ref(false);
const hlNoteText = ref('');
/** 菜单锚点：`x` = 选区水平中心（已做左右防越界），`y` = 贴的那条边，`below` = 上方放不下改放下方 */
const selXY = ref({ x: 0, y: 0, below: false });
/** `#255`：菜单根节点（量「更多」下拉的几何用；`.rd-selmenu` 带 transform ⇒ 也是下拉的定位容器） */
const selMenuEl = ref<HTMLElement | null>(null);
function hideSelMenu(): void {
  selMenuOpen.value = false;
  noteOpen.value = false;
  selMoreOpen.value = false; // `#255`：二级下拉必须跟着一级一起收
  selMoreDown.value = false; // 朝向复位，否则下次开菜单会先以「上次的朝向」画一帧
}
/**
 * `#256`：收起**高亮动作栏**。
 *
 * ★★ 为什么必须与 `hideSelMenu()` **分开**（本轮探针抓到的真缺陷）：
 *   `onDocMouseUp` 在选区为空时会调 `showSelMenuFromSelection()` ⇒ 里面走「选区空了就收面板」
 *   那条分支调 `hideSelMenu()`。而**点一下高亮**这个动作本身就会把选区清空
 *   ⇒ 顺序是 `mousedown`(收) → `click`(开动作栏) → `mouseup` 排的 0ms 定时器（**又收掉**）
 *   ⇒ 用户看到的是「动作栏闪一下就没了」。
 *   旧探针用 `el.click()`（只派发 click、不派发 mousedown/mouseup）**绕过**了这条路径，
 *   所以 `#146` 起一直没被发现 —— 这也是本仓那条纪律的又一次验证：
 *   **浮层一律用真实鼠标事件验，`el.click()` 会把「被盖住 / 被下一次事件收掉」这类问题全绕过去。**
 */
function hideHlMenu(): void {
  hlMenuOpen.value = false;
}

/* ---------------- `#807` `D3` 正文右键菜单 ---------------- */

/**
 * 正文右键菜单（`#807` `D3`；`#815` 起与划词菜单**互斥分配**）。
 *
 * ## 为什么要互斥（用户 2026-11-06：「阅读界面，划词 → 菜单 和 右键菜单有重叠」）
 * `#807` 把「复制 / 搜全书 / 加书签」也挂进了右键菜单，而这三项**前提都是「有选区」**
 * —— 恰好和划词菜单重号：选中一段再右键 ⇒ 两套菜单同时抢同一批动作。
 *
 * ## 分配口径（一条铁律：**选区类动作只由划词菜单出**）
 * · **有选区 + 右键** ⇒ 本菜单**不接管**（不 `preventDefault`）：留给划词菜单 + 浏览器系统菜单（「复制」）；
 * · **无选区 + 右键** ⇒ 只保留非选区类动作：加书签（本段） / 朗读本段 / 切换分页·滚动；
 * · 图片 / iframe / PDF / canvas 一律不拦截（系统菜单的「图片另存为 / 在新标签打开」更合适）。
 *
 * 关：Esc（`onReaderEsc` 最上层）、在别处按下（`onDocMouseDown`）、正文滚动、换章 / 退出正文。
 */
const ctxMenuOpen = ref(false);
const ctxXY = ref({ x: 0, y: 0 });
/** 右键所在**段落**的正文起点（加书签 / 朗读都落在本段，而不是整章开头） */
const ctxPos = ref(0);
const CTX_MENU_W = 132;
/** 3 项 ≈ 3×34 + 内边距（`#815` 删掉「复制 / 搜全书」后从 206 收窄，定位才不会偏） */
const CTX_MENU_H = 128;
function hideCtxMenu(): void {
  ctxMenuOpen.value = false;
}

function onContentContextMenu(e: MouseEvent): void {
  if (!r.chapter) return;
  const t = e.target as HTMLElement | null;
  // 只在**正文容器**里接管：标题/页眉/页脚/媒体区/空白处保留浏览器系统菜单
  const content = t?.closest?.('.rd-content') as HTMLElement | null;
  if (!content) return;
  // 图片/iframe/PDF/画布保留浏览器系统菜单（漫画「另存为」、PDF 文本选择等）
  // ★ 漫画整块（`.rd-comic`，含图片间隙与章节分隔条）也保留系统菜单：这里的阅读菜单
  //   只有「加书签 / 朗读本段（禁用）/ 切换分页」——「切换分页」对图片章是**死动作**
  //   （`pagedActive` 不含 `isComic`），与 `onPageAreaClick` 里排除 `.rd-comic` 同一口径。
  if (t?.closest?.('img, iframe, canvas, .rd-pdf, .rd-comic')) return;
  /**
   * `#815` **有选区 ⇒ 不接管**：不调 `preventDefault()`，系统菜单照样弹出（「复制」用它）。
   * 选区类动作（复制 / 搜全书 / 选中加书签 / 高亮 / 笔记…）一律归划词菜单，
   * 避免两套菜单对「当前选区」各算一份偏移。
   */
  const selNow = window.getSelection();
  if (selNow && selNow.rangeCount && (selNow.toString().trim() ?? '')) return;

  e.preventDefault();
  hideSelMenu();
  hideHlMenu();
  hideCtxMenu();

  ctxPos.value = 0;
  const pEl = t?.closest?.('p[data-p]') as HTMLElement | null;
  const idx = pEl ? Number(pEl.dataset.p) : -1;
  if (idx >= 0) ctxPos.value = hlLayout.value.starts[idx] ?? 0;

  const x = Math.max(8, Math.min(e.clientX + 2, window.innerWidth - CTX_MENU_W - 8));
  const y = Math.max(8, Math.min(e.clientY + 2, window.innerHeight - CTX_MENU_H - 8));
  ctxXY.value = { x, y };
  ctxMenuOpen.value = true;
}

function ctxBookmark(): void {
  hideCtxMenu();
  selText.value = ''; // 无选区语境：书签就是「本段起点」，别沿用上一轮的选区文字
  selPos.value = ctxPos.value;
  addBookmarkFromSelection();
}
/**
 * 「朗读本段」：从本段的**点击字符偏移**开始念。
 * ★ 不新增 store 方法：`play()` 会切句并从当前句开播，
 *   立刻 `pause()` 把首句取消、把 `index` 挪到目标句再 `resume()`。
 *
 * ★★ 用户 2026-11-10：右键会跳到别的段（有时往上、有时往下）。两个根因：
 *  ① `s.start >= pos` 找的是「**起点在段首之后**」的句子。若某句从上一段末尾起句、
 *     跨进本段（上段没有句末标点，`Intl.Segmenter` 不按换行断句），包含段首的那句被跳过
 *     ⇒ 念到后一句（往下跳）。正确判据是**句子区间包含 pos**：`start + len > pos`。
 *  ② `if (i > 0)` 才 seek。点击的段落恰好映射到第 0 句时不跳，继续从暂停点/旧位置念
 *     ⇒ 往上或往下跳。**第 0 句也必须 seek**。
 *  另外从段首起播时 `innerPos` 要落在 `pos - s.start`（跨段句不能把上一段尾巴重念一遍）。
 */
async function readAloudFromParagraph(pos: number): Promise<void> {
  if (isMedia.value || isComic.value) { toast('正文是图片/媒体，无法朗读', 'warn'); return; }
  alOpen.value = true;
  if (al.isPlaying) al.stop();
  await al.refreshTtsBackend();
  al.play();
  // 配置不完整时 `play()` 会直接报错停住 ⇒ 不再做「跳到该段」的后续动作
  if (!al.isPlaying) return;
  // 包含 pos 的句子（不是「起点在 pos 之后」的句子）
  const found = al.sentences.findIndex((s) => s.start + s.text.length > pos);
  // 段落在最后一句之后（如段落末尾的标点）⇒ 从末句开始，不退回整章开头
  const i = found >= 0 ? found : Math.max(0, al.sentences.length - 1);
  const target = al.sentences[i];
  if (!target) return; // 空章：`play()` 已经如实报错了
  al.pause();
  al.index = i;
  // 从「本段第一个字」起：跨段句要跳过前面属于上一段的尾巴
  al.innerPos = Math.max(0, Math.min(pos - target.start, target.text.length));
  al.resume();
}
function ctxReadAloud(): void {
  hideCtxMenu();
  void readAloudFromParagraph(ctxPos.value);
}
function ctxToggleViewMode(): void {
  hideCtxMenu();
  r.setViewMode(isPaged.value ? 'scroll' : 'paged');
}
/** 菜单大致高度与半宽：只用来判「上方放得下吗 / 左右越界吗」，比量 DOM 稳（首帧量不到会抖） */
const SELMENU_H = 34;
const SELMENU_HALF_W = 175;
/**
 * 由**当前选区**决定菜单位置并显示。
 *
 * ★★ 调用时机是本轮修复的核心（用户 2026-09-28）：**只在鼠标松开（`mouseup`）/ 键盘选完之后**调用。
 * 修复前用 `selectionchange`（拖选**过程中**每 150ms 触发）直接弹菜单，造成三个问题：
 *  ① 菜单跟着光标在选区内跑，看着"先出现在光标下方、再跳到选区上方"；
 *  ② 鼠标拖过菜单时，菜单里的「复制/全选…」文字被**选进选区**（`user-select` 修复 + 拖选期不显示彻底解决）；
 *  ③ 松开时若落到浮层背景上，`click` 的 target 变成 `.se-mask` 自身 ⇒ 命中 `@click.self` ⇒ **阅读界面被关掉**。
 */
function showSelMenuFromSelection(): void {
  if (suppressMenu) return;
  // `#807`：右键菜单开着时不再被「松开鼠标 / 选区变化」带出选区菜单（两者互斥）
  if (ctxMenuOpen.value) return;
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (!sel || !text || !sel.rangeCount) {
    /**
     * 选区空了要收面板 —— 但**「笔记」输入展开时不能收**。
     *
     * ⚠️ 先把话说准（2026-09-30 更正）：**真实鼠标点击不会清掉选区** ——
     * `.rd-selmenu` 上挂着 `@mousedown.prevent`（见模板注释），mousedown 的默认行为被拦掉了。
     * 所以这不是「用户会遇到的问题」。
     *
     * 真正会遇到的是**程序化点击**（自动化/探针 `el.click()` 只派发 click、不派发 mousedown）
     * 以及其它会清掉选区的路径（例如浏览器把焦点移到别处）：那时 `selectionchange` 兜底
     * 会把整个面板收掉 ⇒ 「点了『笔记』，输入框还没来得及输入就没了」。
     * 划线不受影响，因为它用的是**已经存下来的 `selRange`**，不再读 DOM 选区；
     * 笔记要先把字打完，所以这一段必须留住。
     * 用户在别处按下鼠标（`onDocMouseDown`）仍会正常收掉，不会赖着不走。
     */
    if (!noteOpen.value) hideSelMenu();
    return;
  }
  const anchor = sel.anchorNode;
  const el = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as HTMLElement | null);
  const content = el?.closest?.('.rd-content');
  if (!content) { hideSelMenu(); return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  /**
   * ★ 选区 → 正文偏移：**必须按段落寻址算**，不能用 `content.textContent.indexOf(text)`。
   * 老写法有三个真问题：① `textContent` 把整块 `.rd-content`（**含标题**）拼在一起 ⇒ 偏移含标题长度；
   * ② `indexOf` 返回的是**首次出现**位置 ⇒ 选正文里重复出现的短语（「他说」这类）必然定位错；
   * ③ `textContent` 在段落之间**没有分隔符** ⇒ 与渲染时的段落结构对不上。
   * 这三点对「划线」是致命的（划歪、划到别处），对书签跳转同样是错的。
   *
   * ★★ 还要 `trimRange`：菜单/落库的文字是 trim 过的，而选区端点常多吃一个空格/换行。
   * 区间与文字**必须同源** —— 不同源的后果是 `reanchor()` 判定「这里不是我要的文字」
   * 然后跑去找别处的同一句话（实测过：高亮被挪到了另一段）。所以顺序是
   * **先裁区间，再由区间切出文字**，绝不用 `selection.toString()` 当文字来源。
   */
  const range0 = sel.getRangeAt(0);
  const layout = buildChapterText(r.displayParagraphs ?? []);
  const mapped = domRangeToBodyEx(layout, content as HTMLElement, {
    startContainer: range0.startContainer,
    startOffset: range0.startOffset,
    endContainer: range0.endContainer,
    endOffset: range0.endOffset,
  });
  const raw = mapped.range;
  const trimmed = raw ? trimRange(layout.text, raw[0], raw[1]) : null;
  selRange.value = trimmed && trimmed[1] > trimmed[0] ? trimmed : null;
  selText.value = selRange.value ? layout.text.slice(selRange.value[0], selRange.value[1]) : text;
  selPos.value = selRange.value ? selRange.value[0] : 0;
  if (!selRange.value) {
    /**
     * 铁律 3（兜底必须留痕）：选区映射不上时**必须**能查出来。
     * 否则用户看到的是「选中了字、点『划线』却点不动」，而控制台一片安静，无从下手。
     */
    console.warn(
      '[reader] 选区无法映射到正文偏移（划线/笔记不可用）：'
      + `why=${mapped.why ?? '区间为空'}`
      + ` paragraphs=${layout.starts.length}`
      + ` raw=${raw ? raw.join('~') : 'null'}`
      + ` trimmed=${trimmed ? trimmed.join('~') : 'null'}`
      + ` contentParas=${content.querySelectorAll('p[data-p]').length}`
      + ` selection=${JSON.stringify(text.slice(0, 20))}`,
    );
  }
  const cx = Math.round(rect.left + rect.width / 2);
  const x = Math.min(Math.max(cx, SELMENU_HALF_W + 8), window.innerWidth - SELMENU_HALF_W - 8);
  // 选区贴近顶部（上方放不下菜单）⇒ 改放选区下方；否则一律贴选区上方
  const below = rect.top < SELMENU_H + 12;
  selXY.value = { x, y: below ? Math.round(rect.bottom + 8) : Math.round(rect.top - 8), below };
  selMenuOpen.value = true;
}
/** 「全选」会把菜单顶到整个正文的包围盒上（位置没意义）⇒ 这段时间不重定位 */
let suppressMenu = false;
/** 鼠标左键是否还按着（拖着选字的过程中不弹菜单 —— 见 showSelMenuFromSelection 的注释） */
let pointerDown = false;
function onDocMouseDown(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('.rd-selmenu')) return; // 点菜单本身：不动（否则会先把自己收掉）
  /**
   * `#256`：同理，点**高亮动作栏**自身也不能先把它收掉 ——
   * 元素在 `mousedown` 与 `mouseup` 之间被移除时，浏览器**不再派发 `click`**
   * ⇒ 五个动作全都会「点了没反应」。
   */
  if (t?.closest?.('[data-hl-menu]')) return;
  pointerDown = true;
  hideHlMenu(); // `#256`：动作栏的关闭时机与选区菜单**不同源**（理由见 hideHlMenu）
  hideCtxMenu(); // `#807`：左键/右键在别处按下 ⇒ 先收右键菜单（右键会由 contextmenu 重新定位）
  /**
   * `#815` **互斥分配**：右键 + 已有选区 ⇒ **保留**划词菜单，不要收掉。
   * 此时右键菜单自己不会弹（`onContentContextMenu` 有选区直接返回到系统菜单），
   * 于是「选区类动作」只有划词菜单这一套 —— 两套菜单不会同时抢同一批动作。
   */
  if (e.button === 2 && (window.getSelection()?.toString().trim() ?? '')) return;
  hideSelMenu(); // 开始新的选择：先收起上一轮的菜单
}
function onDocMouseUp(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  pointerDown = false;
  // `#807`：只对左键弹选区菜单 —— 右键的 `mouseup` 也会走到这里，
  //   否则用户「选中一段 → 右键」会同时冒出选区菜单和右键菜单。
  if (e.button !== 0) return;
  if (t?.closest?.('.rd-selmenu')) return;
  // ★ 松开在**按钮/输入框**上不弹：点顶部工具栏（如「☰ 目录」）时，正文里可能还残留着上一段选区，
  //   若照弹就会出现「点了目录按钮、菜单又冒出来」的怪现象。
  if (t?.closest?.('button, a, input, select, textarea')) return;
  // ★ 等本 tick 结束再读：mouseup 当下读到的可能是**拖选过程中**的旧选区
  window.setTimeout(showSelMenuFromSelection, 0);
}
/**
 * 选区变化：**拖拽中只收不弹**；非拖拽（键盘 Shift+方向键、程序性选择）才跟随更新。
 * 节流 150ms（键盘连续选择时避免频繁 layout）。
 */
let selTimer = 0;
function onSelectionChangeThrottled(): void {
  if (pointerDown) { hideSelMenu(); return; }
  if (selTimer) return;
  selTimer = window.setTimeout(() => {
    selTimer = 0;
    if (pointerDown) { hideSelMenu(); return; }
    showSelMenuFromSelection();
  }, 150);
}
/**
 * `#370` **关闭当前最上层**（用户需求：「将详情页/阅读页两个页面进行独立，保留各页面
 * 按钮、功能、布局等不变」；书院/影院 = 点卡片进详情 → 点目录进阅读，两层各自可退）。
 *
 * · 正文层开着（`r.chapter`）⇒ 退回**详情层**（`r.reset()`：清正文、保详情/目录 ——
 *   与「返回详情」工具（`reader-toolbar.ts` `id:'back'`）同一动作）；
 * · 详情层（无正文）⇒ 才是真正整关（`r.close()` → 回发现页）；
 * · `r.webDoc`（`openWeb` 网页即正文，`#370`）⇒ 「详情」是合成的空壳 ⇒ 无层可退，直接整关。
 *
 * 入口只有**两个**（用户 2026-10-14 的口径：「只能通过关闭按钮、Esc 关闭；点击浮层界面外部不关闭」）：
 * 工具条上的「关闭」按钮 + Esc（见 `onReaderEsc`）；**点遮罩不再关闭**（`#459` 去掉）。
 * 换书路径（`openDetail`/`openShelfBook` → `reset()`）与「返回详情」工具语义不受影响。
 */
function closeTopLayer(): void {
  // #490 读过正文但没进书架的书，退出时先问一句「是否加入书架」（问过就记，不重复问）
  if (maybeAskShelf()) return;
  finishClose();
}

/** 收尾：与旧 closeTopLayer 一致（详情层 ⇒ reset 回详情；否则整关）
 *  （#399：RSS 直达 rssArticle 与 webDoc 没有真实详情页 ⇒ 整关回列表） */
function finishClose(): void {
  if (r.chapter && !r.webDoc && !r.rssArticle) r.reset();
  else r.close();
}

/**
 * #490 用户口径：「未加入书架，但是点开阅读了正文的书籍，关闭/退出阅读界面时弹出是否加入书架」。
 * 三条判据全满足才问：① 读过正文（r.chapter 在）② 不在书架（store 的 hasInShelf，
 * 它已排除 notShelf 的观影历史行）③ 本次会话没问过这本（避免「返回详情再关」问第二次）。
 */
const askShelf = ref<{ key: string; title: string } | null>(null);
const askedShelfKeys = new Set<string>();
function maybeAskShelf(): boolean {
  const key = r.currentKey;
  if (!key || !r.chapter) return false;
  if (r.hasInShelf(key)) return false;
  if (askedShelfKeys.has(key)) return false;
  askedShelfKeys.add(key);
  askShelf.value = { key, title: r.detail?.title || '这本书' };
  return true;
}
function onAskShelfYes(): void {
  askShelf.value = null;
  r.addToShelf();
  finishClose();
}
function onAskShelfNo(): void {
  askShelf.value = null;
  finishClose();
}

async function copySelection(): Promise<void> {
  try {
    await navigator.clipboard.writeText(selText.value);
    toast('已复制', 'ok');
  } catch {
    toast('复制失败（浏览器未授权剪贴板）', 'warn');
  }
  hideSelMenu();
}
/** 当前选区的视口矩形（`null` = 选区已经没了） */
function selectionRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const b = sel.getRangeAt(0).getBoundingClientRect();
  return b.width || b.height ? b : null;
}

/**
 * `#255`：开关「更多」二级下拉。
 *
 * ## 为什么朝向 / 位置必须**量过再定**（第一版在这里连着翻两次车）
 *
 * **第一次翻车**：写死「菜单挂在选区上方 ⇒ 下拉也向上」（理由是「向下会盖住刚选中的字」）。
 * 探针实测下拉顶边 = **-15px**（最上面一行被视口裁掉）。根因：菜单自身「在上/在下」用的判据是
 * `rect.top < SELMENU_H + 12` —— 那是个**估计值**（46px），于是 `selTop ∈ [46, ~160]` 这一带里
 * **菜单在上、可上方只够放菜单（34px）、放不下下拉（~112px）**。
 *
 * **第二次翻车**：改成「放不下就往下翻」之后，视口不裁了，但下拉**正好压住刚选中的那句字**
 * （探针量到 下拉 143~259 覆盖 选区 154~179）。
 *
 * ⇒ 正解是**把整个浮动组挪到选区另一侧**，而不是只翻下拉：
 *   ① 先按「下拉背离选区」渲染（菜单在上 ⇒ 下拉朝上，反之朝下）；
 *   ② 量下拉实际高度；上方连「菜单 + 下拉」都放不下、而选区**下方**还有地方 ⇒
 *      把菜单本体一起改挂到选区下方（`selXY.below = true`），下拉自然朝下
 *      ⇒ 覆盖的是选区**下面的**正文（与 Android 溢出菜单同观感），选中那句字始终露着；
 *   ③ 反向对称处理「菜单在下但下方放不下」。
 *
 * ★ 本仓一贯的取舍：**几何结论要量，不要用估计值推断**（`#224`/`#244` 的 CSS 坑同源）。
 */
async function toggleSelMore(): Promise<void> {
  if (selMoreOpen.value) { selMoreOpen.value = false; return; }
  const EDGE = 8; // 与视口留 8px，别贴着边
  /**
   * 浮动组与选区之间的**固有间隙**：菜单本体 16px（`showSelMenuFromSelection` 给的 `-8px`
   * 加上 CSS `translate(… -8px)`）+ 下拉与菜单之间的 6px。写死是因为它由两处 CSS/JS 决定，
   * 量不出来；但它与「放不放得下」相关的是**菜单与下拉的实际尺寸**，那两个还是要量。
   */
  const GAP = 16 + 6;
  selMoreDown.value = selXY.value.below; // 先按「背离选区」渲染
  selMoreOpen.value = true;
  await nextTick();
  const menuBox = selMenuEl.value?.getBoundingClientRect();
  const selRect = selectionRect();
  const dropH = selMenuEl.value?.querySelector<HTMLElement>('.rd-sel-more')?.getBoundingClientRect().height ?? 0;
  if (!menuBox || !selRect || !dropH) return;
  /** 整组（菜单 + 下拉 + 间隙）的高度 —— 判断的是它，不是下拉自己 */
  const block = GAP + menuBox.height + dropH;
  const fitsUp = selRect.top - block >= EDGE;                       // 整组都在选区上方
  const fitsDown = window.innerHeight - selRect.bottom - block >= EDGE; // 整组都在选区下方
  /**
   * ① 保持菜单原本在哪一侧；那一侧放不下、而**另一侧放得下**时才整组翻过去。
   * 两侧都放不下（窗口矮到装不下整条菜单）⇒ 保持不动 + 留痕（铁律 3），
   * 宁可压住一点正文，也不要把菜单裁到视口外 —— 裁掉的那部分**点都点不到**。
   */
  const flip = selXY.value.below ? (!fitsDown && fitsUp) : (!fitsUp && fitsDown);
  if (flip) {
    selXY.value = selXY.value.below
      ? { x: selXY.value.x, y: Math.round(selRect.top - 8), below: false }   // 整组挪到选区上方
      : { x: selXY.value.x, y: Math.round(selRect.bottom + 8), below: true }; // 整组挪到选区下方
    selMoreDown.value = selXY.value.below;
    await nextTick();
  } else if (!fitsUp && !fitsDown) {
    console.warn(
      '[reader] 「更多」下拉两侧都放不下（窗口太矮）：'
      + `block=${Math.round(block)} selTop=${Math.round(selRect.top)} selBottom=${Math.round(selRect.bottom)}`
      + ` vh=${window.innerHeight}`,
    );
  }
}
function selectAllText(): void {
  // 分页时「全选」只能选**当前页**（轨道里还有前后页；选到隐藏页会拿到看不见的文字）
  const content = pagedActive.value
    ? bodyEl.value?.querySelector('.se-paged-page.se-paged-current .rd-content')
    : bodyEl.value?.querySelector('.rd-content');
  if (!content) return;
  const range = document.createRange();
  range.selectNodeContents(content);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  suppressMenu = true;
  window.setTimeout(() => { suppressMenu = false; }, 400);
  // `#255`：全选后一级菜单**留在原地**（它现在盖在全文包围盒上、位置已无意义，
  // 但它是用户下一步操作的入口，收掉反而要多选一次）—— 只收起二级下拉，别让它悬在半空。
  selMoreOpen.value = false;
}
function addBookmarkFromSelection(): void {
  if (!r.chapter) return;
  r.addBookmark({
    chapterIndex: Math.max(0, r.chapterIdx),
    chapterPos: selPos.value,
    chapterName: r.chapter.title ?? '',
    content: selText.value,
  });
  toast('已加书签', 'ok');
  hideSelMenu();
}
function lookupSelection(): void {
  // ★ 用户 2026-09-28：打开字典窗**一条请求都不发** —— 只准备 tab，点哪个字典查哪个
  dict.prepareLookup(selText.value);
  void dict.lookupOne(dict.activeName);
  hideSelMenu();
}

/* ---------------- `#146` 划线高亮 / 笔记：渲染与交互 ---------------- */

/**
 * 本章正文的坐标布局（只在 `displayParagraphs` 变化时重算）。
 *
 * ★ 用 `displayParagraphs`（**显示层**，简繁转换后）而不是 `chapter.paragraphs`：
 * 上游是「先转换、再排版」⇒ `chapterPos` 落在转换后的文本上（见 `utils/chapter-text.ts` 顶部）。
 */
const hlLayout = computed(() => buildChapterText(r.displayParagraphs ?? []));

/**
 * 本章高亮的**实际生效区间**（整章坐标）：存下来的偏移先用 `bookText` 纠一次偏。
 *
 * 为什么要纠：切换简繁后偏移可能位移；导入的 Legado 数据换算后也可能差一两个字。
 * 不纠的话画面上就是「划线画在别的字上」，而数据其实没错 —— 最难查的一类问题。
 */
const hlRanges = computed<Array<[number, number]>>(() => {
  const layout = hlLayout.value;
  return r.currentChapterHighlights.map((h) =>
    // `#726`：阅读模式切换会让整章文本整体变化 ⇒ 本地 ±256 窗口失效时，
    // 再按 `bookText` 的唯一命中兜底（多处命中不动，见 `anchorRange` 注释）
    // 导入的 Legado 高亮 chapterPos 含标题 ⇒ 先把 `layoutTitleLength` 减掉
    anchorRange(
      layout.text,
      highlightBodyPos(h.chapterPos, h.layoutTitleLength, layout.text.length),
      highlightBodyPos(h.chapterPosEnd, h.layoutTitleLength, layout.text.length),
      h.bookText,
    ),
  );
});

/* ---------------- `#262` 高亮规则：渲染期匹配 ---------------- */

/** 当前这本书生效的规则（isEnabled + scope 子串筛选；空 = 无规则，全链零开销） */
const hrRulesForBook = computed(() =>
  hr.enabledFor(r.detail?.title ?? '', r.sourceId ?? ''),
);

/**
 * 规则在本章正文的命中区间（整章坐标）。
 *
 * ★ 上游语义（`ReadBook.kt:292-296`）：匹配**未完成**（超时/超量）时**整批丢弃**，
 *   不采用半截结果 —— 那会造成「每次翻页命中数不一样」的闪烁。
 * 本仓正文不含标题（标题是独立 DOM）⇒ titleEnd=0；`applyToTitle` 的规则单独匹配标题
 * （见 `titleRuleStyle`），`applyToBody` 走这里。
 */
const ruleMatches = computed(() => {
  const layout = hlLayout.value;
  const rules = hrRulesForBook.value.filter((x) => x.applyToBody);
  if (!rules.length || !layout.text) return [];
  const res = matchHighlightRules(
    layout.text,
    rules.map((x) => ({
      id: x.id,
      pattern: x.pattern,
      isRegex: x.isRegex,
      timeoutMillisecond: x.timeoutMillisecond,
      applyToTitle: x.applyToTitle,
      applyToBody: x.applyToBody,
    })),
    0,
  );
  if (!res.completed) return [];
  return res.matches.map((m) => ({ range: [m.start, m.end] as [number, number], ruleId: m.ruleId }));
});

/** 规则 id → 渲染样式（空 style JSON 按默认样式渲染，与手工高亮同口径） */
const ruleStyleById = computed(() => {
  const m = new Map<number, HighlightStyleView>();
  for (const x of hrRulesForBook.value) m.set(x.id, visibleHighlightStyle(parseHighlightStyle(x.style)));
  return m;
});

/** 标题的规则样式（`applyToTitle`；多规则命中取第一条 —— 标题只有一个元素，叠样式没有意义） */
const titleRuleStyle = computed<HighlightStyleView | null>(() => {
  const t = r.displayTitle;
  const rules = hrRulesForBook.value.filter((x) => x.applyToTitle);
  if (!t || !rules.length) return null;
  const res = matchHighlightRules(
    t,
    rules.map((x) => ({
      id: x.id,
      pattern: x.pattern,
      isRegex: x.isRegex,
      timeoutMillisecond: x.timeoutMillisecond,
      applyToTitle: x.applyToTitle,
      applyToBody: x.applyToBody,
    })),
    t.length,
  );
  if (!res.completed || !res.matches.length) return null;
  return ruleStyleById.value.get(res.matches[0].ruleId) ?? null;
});

/**
 * 渲染用的分段：每段切成 `普通 / 高亮` 交替的片段。
 *
 * 走「分段渲染」而不是 `innerHTML` 拼接：**不引入 HTML 注入面**（正文来自站点，是不可信输入），
 * 也让「点哪一段删哪一条」有确定的 DOM 归属。
 *
 * ★ `plain !== null` 表示**这一段没有任何高亮** ⇒ 模板直接输出纯文本、**不包 `<span>`**。
 * 理由：段落是正文的主体（长章上千段），没有高亮时还逐段包一层 span 会凭空多出上千个节点，
 * 且会把「没有高亮功能时」的正文 DOM 结构改掉 —— 别的选择器/探针会跟着受影响。
 */
const hlSegments = computed(() =>
  (r.displayParagraphs ?? []).map((text, para) => {
    // 搜索命中处的临时标记与高亮走**同一套分段**（两套区间分别渲染会互相嵌套、重复文本）
    const local = localRangesForPara(hlLayout.value, hlRanges.value, para);
    // `#262` 规则命中并入同一套分段（否则两套区间互相嵌套、重复文本）
    const ruleLocal = localRangesForPara(
      hlLayout.value,
      ruleMatches.value.map((m) => m.range),
      para,
    );
    const flashLocal = flashRange.value
      ? localRangesForPara(hlLayout.value, [flashRange.value], para)[0]
      : undefined;
    const items = segmentText(text, [...local, ...ruleLocal, ...(flashLocal ? [flashLocal] : [])]).map((s) => {
      // 该片段是否落在「本次跳转的命中处」里（用局部区间做一次重叠判定）
      const flash = !!s.hl && !!flashLocal && s.at < flashLocal[1] && s.at + s.text.length > flashLocal[0];
      if (!s.hl) return { ...s, h: null, st: null, flash };
      // 反查是哪条高亮（可能多条重叠，取最新的那条作为样式来源）
      const global = (hlLayout.value.starts[para] ?? 0) + s.at;
      const hits = r.currentChapterHighlights.filter((_, i) => {
        const [a, b] = hlRanges.value[i] ?? [0, 0];
        return global >= a && global < b;
      });
      const h = hits.length ? hits.reduce((x, y) => (y.time > x.time ? y : x)) : null;
      // ★ `#256`：空样式（`#146`~`#255` 落库的老数据写的都是 `''`）**按默认样式渲染**，
      //   否则老高亮会变成「什么都没有」（上游同样有 `visibleHighlightStyle()` 这一层）。
      if (h) return { ...s, h, st: visibleHighlightStyle(parseHighlightStyle(h.style)), flash };
      // `#262`：不是手工高亮 ⇒ 反查规则命中（规则段 `h` 恒 null ⇒ 不可点动作栏，
      // 管理在「高亮规则」对话框里 —— 与上游一致：规则命中不建 BookHighlight）
      const rm = ruleMatches.value.find((m) => global >= m.range[0] && global < m.range[1]);
      return { ...s, h: null, st: rm ? ruleStyleById.value.get(rm.ruleId) ?? null : null, flash };
    });
    const plain = items.length === 1 && !items[0].hl ? items[0].text : null;
    return { para, plain, items };
  }),
);

/**
 * `#825` 一页里的一个渲染切片。
 *
 * 与 `hlSegments` 的关系：切片是「段内字符区间」，渲染前把该段的分段按 `[start, end)` **裁一次**。
 * 高亮跨页时两边各自显示自己那一截（颜色连续、文字不重复）。
 */
type HlSegItem = (typeof hlSegments)['value'][number]['items'][number];
interface RenderChunk {
  key: string;
  /** true = 章标题块（不吃 `data-p`） */
  title: boolean;
  para: number;
  start: number;
  end: number;
  cont: boolean;
  plain: string | null;
  items: HlSegItem[] | null;
  /** 该片是这一段的最后一截 ⇒ 段末气泡 / 整宽条挂在它后面 */
  paraEnd: boolean;
}

function buildChunkView(c: PageChunk): RenderChunk {
  if (c.para < 0) {
    return { key: 't', title: true, para: -1, start: 0, end: 0, cont: false, plain: null, items: null, paraEnd: true };
  }
  const seg = hlSegments.value[c.para];
  const len = hlLayout.value.lengths[c.para] ?? 0;
  const key = `${c.para}:${c.start}-${c.end}`;
  const paraEnd = c.end >= len;
  const base = { key, title: false, para: c.para, start: c.start, end: c.end, cont: c.cont, paraEnd };
  if (!seg) return { ...base, plain: '', items: null };
  if (seg.plain !== null) return { ...base, plain: seg.plain.slice(c.start, c.end), items: null };
  const items: HlSegItem[] = [];
  for (const it of seg.items) {
    const a = Math.max(it.at, c.start);
    const b = Math.min(it.at + it.text.length, c.end);
    if (b <= a) continue;
    items.push({ ...it, text: it.text.slice(a - it.at, b - it.at), at: a });
  }
  return { ...base, plain: null, items };
}

/**
 * 只渲染当前页 ±1（`dx` = 相对当前页的位移，模板里直接 `translateX(dx * 100%)`）。
 *
 * ★ `computed` 依赖 `curPage` ⇒ **翻页时只重建这 3 页的切片**，不碰其它页、不做测量。
 */
const pagedViews = computed(() => {
  const out: Array<{ page: number; dx: number; role: '' | 'in' | 'out'; chunks: RenderChunk[] }> = [];
  if (!pagedActive.value) return out;
  const list = pagedPages.value;
  const total = list.length;
  if (total === 0) return out;
  const cur = Math.min(Math.max(1, curPage.value), total);
  const from = Math.max(0, cur - 2);
  const to = Math.min(total - 1, cur);
  // `#830` 动画角色：只给「这一翻的起点页 / 落点页」挂 class（见 `markFlip` 的注释）
  const f = flip.value;
  for (let k = from; k <= to; k += 1) {
    const page = k + 1;
    let role: '' | 'in' | 'out' = '';
    if (f) {
      if (page === f.to) role = 'in';
      else if (page === f.from) role = 'out';
    }
    out.push({ page, dx: page - cur, role, chunks: list[k]!.map(buildChunkView) });
  }
  return out;
});

/** 点在某条高亮上：弹样式菜单（不再直接删除 —— 用户 2026-09-30 Add） */
function onHighlightClick(h: { time: number } | null | undefined, ev?: MouseEvent): void {
  if (!h) return;
  openHighlightMenu(h.time, ev);
}

/** 从当前选区新建划线（`note` 为空 = 纯划线） */
function addHighlightFromSelection(note?: string): void {
  const range = selRange.value;
  if (!range || !r.chapter) {
    toast('这里不能高亮（标题或图片上不支持）', 'warn');
    return;
  }
  const h = r.addHighlight({
    chapterIndex: Math.max(0, r.chapterIdx),
    start: range[0],
    end: range[1],
    text: selText.value,
    note,
  });
  if (!h) {
    toast('选区太短，没划上', 'warn');
    return;
  }
  toast(note ? '已高亮并记下笔记' : '已高亮', 'ok');
  hideSelMenu();
}

/** 点「笔记」：先展开内联输入（不弹 `prompt`，见 `noteOpen` 的注释） */
function openNoteInput(): void {
  noteText.value = '';
  noteOpen.value = true;
  // `autofocus` 只在页面首次加载时生效，动态插入的输入框必须自己聚焦
  void nextTick(() => {
    bodyEl.value?.querySelector<HTMLInputElement>('.rd-notein-input')?.focus();
  });
}

/**
 * 选区菜单「替换」：新建一条净化规则，pattern 预填选中文本、scope 预填书名（对齐 Legado
 * `ReadBookActivity.kt:1293-1309`：`scope` = 书名 + 书源 URL 用 `;` 连起来）。
 *
 * ★ `#260`：改走**共用**的 `ReplaceRuleDialog`（原先这里是个只有 4 个字段的简化弹窗，
 *   连「排除范围 / 启用 / 超时 / 分组」都没有 ⇒ 从阅读界面建的规则缺字段、还得回设置页补）。
 */
function openReplaceFromSelection(): void {
  const text = selText.value.trim();
  if (!text) return;
  rr.ensureLoaded();
  const rule = rr.newRule();
  replaceDraft.value = {
    ...rule,
    pattern: text,
    scope: r.detail?.title ?? '',
    scopeContent: true,
    scopeTitle: false,
    isEnabled: true,
  };
  hideSelMenu();
}
/** 共用弹窗「保存」：落库 + 重跑本章（净化只在展示时做，缓存存原文） */
function onSelectionReplaceSave(x: ReplaceRule): void {
  rr.upsert(x);
  replaceDraft.value = null;
  r.reloadCurrentChapter();
  toast('已新增净化规则（本章已重跑）', 'ok');
}
function cancelQuickReplace(): void {
  replaceDraft.value = null;
}

/**
 * 点已有高亮：弹**动作栏**（`#256`，对齐上游 `showHighlightActionMenu`）。
 *
 * 锚点：以点击处为中心、右移 60px（动作栏宽约 132px），并做四边防越界。
 * ★ 与选区菜单同理 —— 位置只做「不出视口」的粗保护，没有量 DOM（动作栏很小，不值得再走一轮 `nextTick`）。
 */
function openHighlightMenu(time: number, ev?: MouseEvent): void {
  const h = r.currentHighlights.find((x) => x.time === time);
  if (!h) return;
  hlMenuTime.value = time;
  hlMenuText.value = h.bookText;
  hlStyleDraft.value = parseHighlightStyle(h.style);
  const x = ev?.clientX ?? 0;
  const y = ev?.clientY ?? 0;
  hlMenuXY.value = {
    x: Math.max(12, Math.min(window.innerWidth - 168, x - 60)),
    y: Math.max(12, Math.min(window.innerHeight - 200, y + 12)),
  };
  hlMenuOpen.value = true;
}

/* ---------------- `#256` 动作栏的五个出口 ---------------- */

/** 动作栏 →「样式」：弹共用的 `HighlightStyleDialog`（关掉动作栏，别让两层浮层叠着） */
function openHlStyle(): void {
  hlMenuOpen.value = false;
  hlStyleOpen.value = true;
}

/**
 * 样式对话框「改一下发一次」⇒ 直接写库（实时预览）。
 * ★ 写库即记成「上次样式」（`setHighlightStyle` 内），下一条新划的沿用。
 */
function onHlStyleChange(s: HighlightStyleView): void {
  hlStyleDraft.value = s;
  r.setHighlightStyle(hlMenuTime.value, serializeHighlightStyle(s));
}

/** 动作栏 →「备注」：打开备注框（草稿 = 当前那条的备注） */
function openHlNote(): void {
  const h = r.currentHighlights.find((x) => x.time === hlMenuTime.value);
  hlNoteText.value = h?.note ?? '';
  hlMenuOpen.value = false;
  hlNoteOpen.value = true;
}
function saveHlNote(): void {
  r.setHighlightNote(hlMenuTime.value, hlNoteText.value.trim());
  hlNoteOpen.value = false;
  toast(hlNoteText.value.trim() ? '已保存备注' : '已清除备注', 'ok');
}

/** 动作栏 →「复制」：复制这条高亮的正文（上游 `ACTION_HIGHLIGHT_COPY` → `sendToClip`） */
async function copyHighlightText(): Promise<void> {
  const text = hlMenuText.value;
  hlMenuOpen.value = false;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制高亮文字', 'ok');
  } catch {
    // 非安全上下文（http + 非 localhost）或用户拒绝授权 ⇒ 如实说，不假装成功
    toast('复制失败：浏览器不允许（需要 https 或手动复制）', 'warn');
  }
}

/**
 * 动作栏 →「创建规则」：`#262` 真实现（上游 `ACTION_HIGHLIGHT_RULE` 打开
 * `HighlightRuleEditDialog.create(pattern…)`）。
 * 预填：pattern = 这条高亮的文字（字面量匹配）、样式 = 这条高亮当前的样式、
 * scope = 当前书名（默认只对本书生效 —— 手工划线的语义就是「这本书的这句话」）。
 */
function createRuleFromHighlight(): void {
  const h = r.currentHighlights.find((x) => x.time === hlMenuTime.value);
  const text = hlMenuText.value;
  hlMenuOpen.value = false;
  if (!text) { toast('这条高亮没有文字，没法转规则', 'warn'); return; }
  ruleEditDraft.value = {
    ...emptyHighlightRule(Date.now()),
    name: text.slice(0, 20),
    pattern: text,
    isRegex: false,
    scope: r.detail?.title ?? null,
    style: h ? serializeHighlightStyle(visibleHighlightStyle(parseHighlightStyle(h.style))) : '',
  };
  ruleEditCreating.value = true;
}

function removeCurrentHighlight(): void {
  r.removeHighlight(hlMenuTime.value);
  hlMenuOpen.value = false;
  toast('已删除高亮', 'ok');
}

/* ---------------- `#146` 书内全文搜索：界面侧 ---------------- */

/** 打开侧栏的「搜索」tab（工具栏按钮与选区菜单都走这里） */
function openSearchTab(query?: string): void {
  if (query) r.bookSearchQuery = query;
  sideTab.value = 'search';
  sidePanel.value = true;
  void nextTick(() => {
    sideEl.value?.querySelector<HTMLInputElement>('.rd-search-input')?.focus();
  });
}
/** 用选区文字直接搜（选区菜单的「搜全书」） */
function searchSelectionInBook(): void {
  const q = selText.value.trim();
  hideSelMenu();
  if (!q) { toast('先选中要搜的文字', 'warn'); return; }
  openSearchTab(q);
  void r.runBookSearch();
}

/** 把片段切成交替的「普通 / 命中」两段（渲染时命中片段用 `<em>`） */
function hitSegments(h: { text: string; queryIndexInResult: number; query: string }): Array<{ text: string; q: boolean }> {
  const { text, queryIndexInResult: at, query } = h;
  if (!query || at < 0 || at + query.length > text.length) return [{ text, q: false }];
  return [
    { text: text.slice(0, at), q: false },
    { text: text.slice(at, at + query.length), q: true },
    { text: text.slice(at + query.length), q: false },
  ].filter((s) => s.text.length > 0);
}

/**
 * 跳到某条搜索结果。
 *
 * ★ `hit.chapterPos` 是**显示层坐标系**的偏移（搜索时用的是与正文渲染同一份转换后的文本，
 * 见 `stores/reader.ts` 的 `runBookSearch`）⇒ 可以直接交给 `scrollToChapterPos`，不会偏。
 */
async function jumpToHit(hit: { chapterIndex: number; chapterPos: number; query: string; text: string; queryIndexInResult: number }): Promise<void> {
  const ch = r.detail?.chapters?.[hit.chapterIndex];
  if (!ch) return;
  sidePanel.value = false;
  await r.openChapter(ch);
  await nextTick();
  // 命中处标一下（`.rd-flash-hl`，2.6 秒后自动消失）—— 否则用户只看到「滚到某段」，找不着是哪一句
  const start = hit.chapterPos;
  const end = start + hit.query.length;
  flashRange.value = [start, end];
  scrollToChapterPos(start);
  window.setTimeout(() => {
    if (flashRange.value && flashRange.value[0] === start) flashRange.value = null;
  }, 2600);
}
function saveNote(): void {
  const note = noteText.value.trim();
  if (!note) {
    toast('笔记是空的，只高亮的话请点「高亮」', 'warn');
    return;
  }
  addHighlightFromSelection(note);
}
/** 本地字典：**远期功能**，先明确告知（不做假实现） */
function lookupLocalDict(): void {
  toast('本地字典（离线词库）为远期功能，暂未实现', 'warn', 6000);
  hideSelMenu();
}

/**
 * 书签跳转：换到那一章并把位置滚进视区（Legado 用 chapterPos 定位）。
 *
 * `#726`：书签存的是**打开时的整章偏移**。阅读模式开关会让整章段落整体替换
 * （引擎段落 ↔ 抽取段落），偏移因此失效。这里用书签自带的 `content`（选中文本）
 * 做一次文本锚定（`anchorRange`：本地窗口 → 唯一命中兜底）；仍对不上就给出轻提示，
 * **不静默停在一个错段**（用户至少知道要重找）。
 */
async function jumpBookmark(b: { chapterIndex: number; chapterPos: number; content?: string }): Promise<void> {
  const ch = r.detail?.chapters?.[b.chapterIndex];
  if (!ch) return;
  sidePanel.value = false;
  await r.openChapter(ch);
  await nextTick();
  const snippet = b.content ?? '';
  const layout = buildChapterText(r.displayParagraphs ?? []);
  const [start] = anchorRange(layout.text, b.chapterPos, b.chapterPos + snippet.length, snippet);
  if (snippet && layout.text.slice(b.chapterPos, b.chapterPos + snippet.length) !== snippet && start === b.chapterPos) {
    toast('书签原文未在当前正文中找到（可能因阅读模式切换），已按原偏移定位', 'warn', 6000);
  }
  scrollToChapterPos(start);
}
/** 标注跳转：换到那一章并把位置滚进视区（同上做文本锚定） */
async function jumpHighlight(h: {
  chapterIndex: number; chapterPos: number; chapterPosEnd: number; bookText?: string;
}): Promise<void> {
  const ch = r.detail?.chapters?.[h.chapterIndex];
  if (!ch) return;
  sidePanel.value = false;
  await r.openChapter(ch);
  await nextTick();
  const snippet = h.bookText ?? '';
  const layout = buildChapterText(r.displayParagraphs ?? []);
  const [start, end] = anchorRange(layout.text, h.chapterPos, h.chapterPosEnd, snippet);
  scrollToChapterPos(start);
  // 临时闪一下划线区间（与正文内点击高亮一致）
  flashRange.value = [start, end];
  window.setTimeout(() => { flashRange.value = null; }, 2600);
}
function scrollToChapterPos(pos: number): void {
  // ★ 与划线共用同一套坐标系（`utils/chapter-text.ts`）：旧写法「逐段累加 textContent 长度、不补分隔符」
  //   与渲染结构对不上，会跳偏一到两段。这里改成「先算段下标、再按 `data-p` 取元素」。
  const paras = r.displayParagraphs ?? [];
  const at = paras.length ? bodyPosToPara(buildChapterText(paras), pos) : { para: 0, char: 0 };
  // `#825` 分页：没有滚动可以「滚过去」⇒ 换成**跳到该段所在页**（布局没建好就先等它）
  // `#844`：把**段内偏移**一起带过去（长段跨页时按段头会落到上一页）
  if (pagedActive.value) { void jumpToParaPaged(at.para, at.char); return; }
  const idx = at.para;
  const el = bodyEl.value;
  if (!el) return;
  const target =
    el.querySelector<HTMLElement>(`.rd-content p[data-p="${idx}"]`) ??
    el.querySelector<HTMLElement>(`.rd-content p:nth-of-type(${idx + 1})`);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('rd-flash');
  window.setTimeout(() => target.classList.remove('rd-flash'), 1600);
}

/**
 * `#203` 跟随朗读位置：滚到当前朗读句所在段。
 *
 * 与 `scrollToChapterPos` 的区别：**不闪**。
 * 闪一下是给「用户点了一下跳转」用的反馈；朗读是持续行为，每句都闪会一直晃眼。
 */
/**
 * `#203` 跟随朗读位置：滚到当前朗读句所在段。
 *
 * ## ★ 为什么不能直接 `scrollIntoView`（用户 2026-10-02 报「滚动条定位错乱」的真因）
 * 原写法对**每一句**都无条件 `scrollIntoView({block:'center'})`，实测：
 * 句 1~5 的目标段**本来就在视口内**（甚至就在视口中央附近）⇒ 浏览器**不滚动**（scrollTop 恒 0），
 * 但只要目标段落在视口**边缘**，浏览器就会把它拉回中央 ⇒ 句子推进时页面**来回抖**，
 * 读起来像「一直向下滚、下一句又跳回顶端」。
 *
 * ## 现在的做法：先判「是否真的需要滚」，再决定要不要滚
 * `isInView` 用**带安全边距**的视口判定（上下各留 12%），落在视口里就**完全不动** ——
 * 这消掉了抖动；真的滚也只滚到「刚够看见」的位置（`block:'nearest'`），
 * 而不是每次都强制居中（强制居中会让长章节每句都大幅滚动）。
 *
 * ## 与 `scrollToChapterPos` 的区别
 * 那个是「用户点了一下跳转」⇒ 需要明确的视觉反馈（`rd-flash` 闪一下）；
 * 朗读是持续行为，每句都闪会一直晃眼 ⇒ **这里不闪**，改用「当前句常亮」（`rd-speaking`）。
 */
function followReadAloud(pos: number): void {
  const paras = r.displayParagraphs ?? [];
  const at = paras.length ? bodyPosToPara(buildChapterText(paras), pos) : { para: 0, char: 0 };
  // `#825` 分页：**自动跟页** —— 当前朗读句不在当前页时，直接把渲染切到它所在的页。
  // （取舍：朗读是持续行为，若只更新页码不动内容，用户会看到「读的声音与看到的字不一致」；
  //   自动跟页最接近 Legado 的 TTS 体验。代价是朗读期间不能"翻到别处看" —— 与上游一致。）
  if (pagedActive.value) {
    if (paged.ready.value) {
      // 用「段 + 段内偏移」而不是只按段：一句话落在跨页段的**续片**上时，按段头会退到上一页
      const page = paged.pageOfChunk(at.para, at.char);
      if (page !== curPage.value) gotoPage(page);
    }
    highlightSpeakingPara(at.para);
    return;
  }
  const idx = at.para;
  const el = bodyEl.value;
  if (!el) return;
  const target =
    el.querySelector<HTMLElement>(`.rd-content p[data-p="${idx}"]`) ??
    el.querySelector<HTMLElement>(`.rd-content p:nth-of-type(${idx + 1})`);
  if (!target) return;
  // ★ 只在「目标段不在舒适可视区」时才滚（见函数头注释）
  if (!isComfortablyInView(el, target)) {
    target.scrollIntoView({ block: 'nearest' });
  }
  highlightSpeakingPara(idx);
}

/**
 * 目标元素是否已在「舒适可视区」内。
 * ★ 上下各留 `RATIO` 的安全边距：句子在视口最边缘时读起来已经吃力，
 *   留边距既避免抖动，又不至于每句都大幅滚动。
 */
const COMFORT_RATIO = 0.12;
function isComfortablyInView(scroller: HTMLElement, el: HTMLElement): boolean {
  const sr = scroller.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const padY = sr.height * COMFORT_RATIO;
  return er.top >= sr.top + padY && er.bottom <= sr.bottom - padY;
}

/** 当前朗读句的段下标（`-1` = 无）；高亮与「下一句」判定都靠它 */
const speakingPara = ref(-1);

/**
 * 高亮「当前正在读的段」—— 用户 2026-10-02 要求「当前句子应变色提醒，读完本句色恢复」。
 *
 * ## 为什么按**段**高亮而不是按句
 * 渲染结构的粒度是 `<p data-p="段号">`（见 `hlSegments`），**没有更细的句级节点**；
 * 而 `speakCurrent` 每次只提交一句，句内偏移靠 `onBoundary` 更新。
 * 要做句级高亮就得给每个句子再包一层 span（改动渲染结构 + 影响划线/选区/搜索三套逻辑）——
 * 代价远大于收益。**按段高亮 = 用户看到的正是「这一段正在被读」**，且句级定位
 * （`currentPos`）仍然精确，用于滚动定位。
 *
 * ## 为什么不用 `rd-flash`（那是跳转反馈）
 * `rd-flash` 是 1.5s 的动画，会自己消失；朗读是持续行为 ⇒ 需要**常亮 + 读完即恢复**。
 */
function highlightSpeakingPara(idx: number): void {
  // `#825`：改成**模板绑定**（`<p :class="{ 'rd-speaking': ... }">`）而不是手工加 class ——
  // 分页下段落可能不在当前页（甚至还没渲染），命令式 add/remove 会摸空。
  // 绑定后：翻页/换切片时 Vue 自动把 `rd-speaking` 落到正确的那一片上。
  if (idx === speakingPara.value) return;
  speakingPara.value = idx;
}

/** 离开正文 / 停止朗读 ⇒ 清除高亮（否则会留一条亮着却没在读的段） */
function clearSpeakingHighlight(): void {
  if (speakingPara.value < 0) return;
  highlightSpeakingPara(-1);
}

/**
 * ★ 停止朗读时也要清高亮 —— 不管是从哪儿点的「■ 停止」。
 *   判据用 `state`（`idle` = 已停）而不是某个按钮：这样设置面板里的取消、章节停、
 *   Esc 离开正文…… 全部自动覆盖（**逐路径加必然漏，漏一条就留一条亮着的段**）。
 *   `playing` 期间不做任何事。
 */
watch(
  () => al.state,
  (s) => {
    if (s === 'idle') clearSpeakingHighlight();
  },
);

/**
 * ★ 开播的**那一瞬**就要点亮当前段（不能等第一次 `follow` 事件）。
 *
 * 症状：点「🔊 朗读」后，浮条立刻出现、朗读也开始了，但**正文里没有任何高亮**，
 * 要等读到下一次 `follow` 才亮 —— 用户会以为「变色功能没生效」。
 *
 * 为什么 `follow` 那条路来不及：`ReadAloudBar` 的 watch 条件是
 * `currentParagraph` **变化**才 emit；而开播时它从 `-1` 变成 `0` 恰好算变化，
 * 但那条链路还依赖「目标段已渲染完」的首帧时机，实测经常错过。
 * 这里补一次「进入 playing 立刻按当前段点亮」，不依赖任何时序。
 */
watch(
  () => (al.isPlaying ? al.currentParagraph : -1),
  (para) => {
    if (para >= 0) highlightSpeakingPara(para);
  },
  { immediate: true },
);

/**
 * 字典结果的消毒 + 渲染前处理都在 `utils/dict-html.ts` 的 `decorateDictHtml` 里
 * （内部先调 `sanitizeHtml`）—— 这里不再单独引用消毒函数，避免两处规则漂移。
 */

const dict = useDictStore();
/** 字典窗当前 tab 的结果（模板里据此判 idle / loading / done） */
const dictActive = computed(() => dict.results.find((x) => x.name === dict.activeName) ?? null);
/**
 * 当前 tab 结果**渲染前处理过**的 HTML（用户 2026-09-28）：
 * 相对地址补全 / 图片走代理 / 链接新标签打开 / 发音按钮补回行为 —— 见 `utils/dict-html.ts` 顶部注释。
 */
const dictActiveHtml = computed(() =>
  dictActive.value ? decorateDictHtml(dictActive.value.text, dictActive.value.base) : '',
);
/**
 * 结果是「站点返回的短文本」而不是正文 HTML（未收录该词 / 站点 404 / 代理回话）。
 * 实测：查不成词的「她犹」时汉典 404，本机代理把响应换成 18 字节文案 —— 当正文渲染会莫名其妙。
 */
const dictActivePlain = computed(() => (dictActive.value ? dictResultIsPlain(dictActive.value.text) : false));
/**
 * 阅读浮层「最大化」（用户 2026-09-28）：让浮层**铺满整个界面**（不是浏览器的全屏 API，
 * 不改变窗口/不请求全屏权限）。
 *
 * ★ 关键约束（用户明确要求）：最大化后**正文区域宽度不扩张**、**底部半透明条宽度不扩张** ——
 *   所以不是简单把 panel 拉到 100%，还要给 `.se-body` 的直接子元素限宽（见样式里的 884/896px，
 *   取的就是最大化前的内容宽：`920 - 2×18`）。
 * ★ 关闭浮层时自动复原，避免"下次打开还是最大化"的意外状态。
 */
const maximized = ref(false);
function toggleMax(): void {
  maximized.value = !maximized.value;
}
watch(
  () => r.open,
  (v) => {
    if (!v) maximized.value = false;
  },
);
/**
 * `#589` 阅读界面**从详情页打开**时，界外遮罩保持详情页样式（`.5` 黑 + 10px 高斯模糊）——
 * 用户 10-23 实测「点目录开阅读界面，遮罩又变透明了」（详情页是 `se-mask-detail`，
 * 阅读态是 `rd-view` 基样式 `.6` 黑无模糊，一切换就「透」了）。
 * 判据 = 开章前一刻详情页正在显示（`r.detail` 已加载 ∧ 非 `directRead` 直达阅读）。
 * `#590` 同源 bug：阅读最大化态**传染回详情页**（返回详情时 `maximized` 没复位）——
 * 详情页标题栏本就没有最大化按钮（`#584`），状态却留着 ⇒ 一并在此复位。
 */
const readerFromDetail = ref(false);
watch(
  () => r.chapter,
  (ch, prev) => {
    if (ch && !prev) readerFromDetail.value = !!r.detail && !r.directRead;
    else if (!ch) {
      readerFromDetail.value = false;
      maximized.value = false;
    }
  },
);

/** 字典正文里的发音按钮（汉典 `<button data-audio>`）：站点自己的 JS 我们跑不了 ⇒ 自己接管点击 */
function onDictBodyClick(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  const audioEl = t?.closest?.('[data-dict-audio]');
  if (audioEl) {
    e.preventDefault();
    void playDictAudio(audioEl);
    return;
  }
  // 笔顺动画（汉典 `data-gif`）：同样由我们插入 GIF 播放，再点一次重放
  const gifEl = t?.closest?.('[data-dict-gif]');
  if (gifEl) {
    e.preventDefault();
    playDictGif(gifEl);
  }
}
/** 字典浮层的「点遮罩关闭」也要防拖选误关（同 `#459` 之前 `.se-mask` 的判据：拖选松在遮罩上会误关） */
let dictMaskDownSelf = false;
function onDictMaskDown(e: MouseEvent): void { dictMaskDownSelf = e.target === e.currentTarget; }
function onDictMaskClick(e: MouseEvent): void {
  if (dictMaskDownSelf && e.target === e.currentTarget) dict.lookupOpen = false;
  dictMaskDownSelf = false;
}

/**
 * 音频源：所有「打开正文」的入口（卡片「阅读」= readFirst、书架续读、换源）
 * 最终都会落到 `openChapter`。在这里统一改道给播放器，浮层退回目录 ——
 * 三个入口行为一致，不必在每个视图里各写一份分流。
 */
watch(
  () => [isAudio.value, r.chapter] as const,
  ([isA, ch]) => {
    if (!isA || !ch || !r.it0) return;
    playChapter(Math.max(0, r.chapterIdx));
    r.reset();
  },
);

// 翻页快捷键（浮层打开时生效）：←/→ 上下章、空格/PageDown 下一章、Esc 关闭、+/- 字号
function onKey(e: KeyboardEvent) {
  if (!r.open) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // `#808` `D9`：任何阅读按键（↑/↓、PageUp/PageDown、←/→ …）都算手动操作 ⇒ 自动滚动立即停
  if (autoScrollOn.value) stopAutoScroll();
  const lastIdx = (r.detail?.chapters?.length ?? 0) - 1;
  /**
   * ★ `#224` **分页模式**：`←/→` 改成**页内翻页**，上下章让给 `PageUp/PageDown` 与 `↑/↓`。
   *
   * ## 为什么这样分配
   * 滚动模式下 `←/→` 的语义是「上一章/下一章」（`#222` 加的）；分页模式下用户对
   * `←/→` 的直觉是「上一页/下一页」—— 让它继续跳章会**一按就跳出整章**，
   * 正好是分页要解决的问题。上下章挪到 `PageUp/PageDown`（与 `Space` 同侧，肌肉记忆一致）。
   *
   * ## 边界行为
   * 末页往后 ⇒ **接下一章**（与滚动模式「滚到底自动续章」同一条边界，不让用户卡住）。
   * 首页往前 ⇒ 上一章末页（对称，否则「往前」在每章第一页都会失灵）。
   */
  if (pagedActive.value) {
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        e.preventDefault();
        // ★ `#244`：到首页再往前 ⇒ 进**上一章末页**（与点正文左侧一致，见 `prevChapterToEnd`）
        if (!turnPage(-1)) void prevChapterToEnd();
        return;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
        e.preventDefault();
        if (!turnPage(1)) void nextChapterPastEnd();
        return;
      default:
        break;
    }
  }
  switch (e.key) {
    case 'ArrowLeft':
    case 'PageUp':
      if (r.chapter && r.chapterIdx > 0) { e.preventDefault(); r.chOffset(-1); }
      break;
    case 'ArrowRight':
    case 'PageDown':
    case ' ':
      if (r.chapter && r.chapterIdx < lastIdx) { e.preventDefault(); r.chOffset(1); }
      break;
    // `#459`：Escape 不再在这里处理 —— 交给 `utils/esc-layer` 的层级栈（见 `onReaderEsc`）。
    // 那边是**捕获阶段**的单例监听，本函数（冒泡阶段）根本收不到 Escape。
    case '+':
    case '=':
      if (r.chapter) { e.preventDefault(); r.setFont(Math.min(80, r.readerFont + 1)); }
      break;
    case '-':
    case '_':
      if (r.chapter) { e.preventDefault(); r.setFont(Math.max(8, r.readerFont - 1)); }
      break;
  }
}
/**
 * `#459` 阅读浮层的 Esc 处理 —— 一次只退**一层**，从最里往外，最后才轮到正文层/详情层（`closeTopLayer`）。
 *
 * ★ 自 `#459` 起本函数**由 `utils/esc-layer` 的层级栈调用**（不再是 `window` 上的独立监听），
 *   因此只有「本浮层是当前最上层」时才会跑 —— 播放浮层压在它上面时，一次 Esc 只关播放浮层。
 * ★ 旧实现有**两处**「一次 Esc 关两层」：① `hideSelMenu` / `sidePanel` / `cacheOpen` 三行连着
 *   执行（不 `return`）；② 本层的子对话框（净化规则 / 高亮样式…）自己没处理，于是只有本层被关掉、
 *   对话框反而留着。现在逐条 `return` + 代管子层收口。
 */
function onReaderEsc(): void {
  // ① 自带 Esc 的子对话框（它们在 window 上自己处理）：本层收手，免得一次 Esc 关两层
  if (addShelfOpen.value) return;
  // ② 由本层代管的子层（全是「整屏遮罩」型），**从里往外**逐层退，一次只退一层
  if (hlNoteOpen.value) { hlNoteOpen.value = false; return; }
  if (readStyleOpen.value) { readStyleOpen.value = false; return; }
  if (ruleEditDraft.value) { ruleEditDraft.value = null; return; }
  if (hrRulesOpen.value) { hrRulesOpen.value = false; return; }
  if (hlStyleOpen.value) { hlStyleOpen.value = false; return; }
  if (effReplacesOpen.value) { effReplacesOpen.value = false; return; }
  if (manualRulesOpen.value) { manualRulesOpen.value = false; return; }
  if (replaceDraft.value) { cancelQuickReplace(); return; }
  if (cacheOpen.value) { cacheOpen.value = false; return; }
  if (switchDlgOpen.value) { switchDlgOpen.value = false; return; }
  if (dict.lookupOpen) { dict.lookupOpen = false; return; }
  if (ctxMenuOpen.value) { hideCtxMenu(); return; } // `#807`：右键菜单是最上面一层
  if (selMenuOpen.value) { hideSelMenu(); return; }
  if (sidePanel.value) { sidePanel.value = false; return; }
  // B18：小窗模式的逃生口优先级高于「退正文层」—— Esc 先恢复正常窗，再按一次才走关闭语义
  if (smallMode.value) { void exitSmallWindow(); return; }
  // `#370`：Esc 语义与「关闭」按钮一致 —— 退当前最上层（正文层→详情层；详情层→整关）
  closeTopLayer();
}
/** 打开期间入 Esc 栈；关闭即出栈（组件常驻，不能靠 mounted/unmounted 判开关） */
let popEsc: (() => void) | null = null;
watch(
  () => r.open,
  (on) => {
    if (on && !popEsc) popEsc = pushEscLayer(onReaderEsc);
    else if (!on && popEsc) { popEsc(); popEsc = null; }
  },
  { immediate: true },
);
/* ---------------- B18 小窗模式 ----------------
 * 三态：正常窗 ⇄ 小窗·常规(420×320) ⇄ 小窗·迷你(240×180) ⇄ 小窗·条形档（浮条）。
 *  · **Electron**：常规/迷你 = 主窗单窗变形（置顶无边框）；条形档 = 与歌词窗同一扇 OS 级浮窗，
 *    主窗隐藏，正文行由本页实时推送。渲染层只镜像 `small`/`tier`。
 *  · **Web**：①②③ 与歌词优先 **Document PiP**（能脱离标签页、用户可自行拖边框改大小、
 *    位置由 UA/系统记忆），不支持/被拒时降级为页内浮窗并明确提示；条形档可在小窗内切回页内
 *    （**只有页内条形档能点击穿透**，PiP 做不到）。
 * ★ 小窗模式/档位**不写任何偏好**（用户决定：重启回正常窗，只记各档几何），这里只做展示层覆盖。
 */
const smallMode = ref(false);
const smallTier = ref<DesktopSmallTier>('regular');
const smallBusy = ref(false);
let offSmallState: (() => void) | null = null;
/** 小窗档没有顶部标题栏：鼠标进入顶部热区（高度见 DOCK_REVEAL_H）才浮现控制条（含右上角关闭） */
const smallHeadHover = ref(false);
/**
 * Web 端「小窗阅读」：与桌面端三档同口径（常规 420×320 / 迷你 240×180 / 条形 3 行）。
 * · ①②③ 与歌词优先 Document PiP（浏览器小窗）—— 这是 Web 上最接近桌面端系统级小窗的形态；
 * · 不支持（非安全上下文 / 非 Chromium / API 缺失 / requestWindow 失败）⇒ 页内浮窗降级，
 *   并在 toast + 浮窗左上角明确标出「页内浮窗」，不静默；
 * · 条形档在 PiP 里呈现，dock 的「▭」可切回页内浮条 —— 只有页内形态能点击穿透。
 */
const webSmallOpen = ref(false);
const webSmallTier = ref<DesktopSmallTier>('regular');
/** Web 端歌词浮窗 = 同一扇浮条的另一内容源（默认关闭，用户主动开启） */
const webLyricsOpen = ref(loadWebLyricsFloat());
const WEB_LYRICS_KEY = 'yuedu.reader.lyrics.float';
function loadWebLyricsFloat(): boolean {
  try { return localStorage.getItem(WEB_LYRICS_KEY) === '1'; } catch { return false; }
}

const smallEntryLabel = computed(() => '🪟 小窗阅读');
const smallEntryHint = computed(() => (
  isDesktop()
    ? '进入小窗阅读（常规 420×320）；顶部控制条可切迷你 240×180 / 条形档，Esc 退出'
    : '小窗阅读（Web）：只保留两态「常规 / 条形」，都走 Document PiP（可脱离标签页、自行拖边框缩放，位置由浏览器记忆）；小窗内顶部热区（48px，横向全宽）浮现工具条，不朗读'
));
/** 小窗内的档位切换按钮：常规 → 迷你 → 条形档（条形档切回常规由浮条自身的「↩」完成） */
const smallTierButton = computed(() => {
  if (smallTier.value === 'mini') return { icon: '▤', text: '条形', hint: '切到条形阅读（浮条，不朗读）' };
  return { icon: '⤢', text: '迷你', hint: '切到小窗·迷你 240×180（更精简）' };
});
/** 小窗阅读当前是否已开启（「更多」菜单里的状态文案用） */
const smallEntryOn = computed(() => (isDesktop() ? smallMode.value : webSmallOpen.value));
/**
 * 页内小窗 UI 是否生效。
 * 桌面端的小窗是**独立浮窗**（主窗 hide），主窗页面只保留 `smallMode` 供菜单/退出逻辑用，
 * **不能再把 `.rd-small` / 小窗专属按钮渲染进主窗** —— 否则从任务栏唤回主窗会看到
 * 「上一章 / 下一章 / 字号 / 迷你 / 退出 / 关闭」这套旧窗口变形界面（release-825 实机复现）。
 * Web 端没有独立浮窗，仍按原逻辑走页内/PiP 小窗。
 */
const inPageSmall = computed(() => smallMode.value && !isDesktop());
const smallTierHint = computed(() => smallTierButton.value.hint);

function applySmallState(s: { small: boolean; tier?: DesktopSmallTier }): void {
  const wasSmall = smallMode.value;
  smallMode.value = !!s.small;
  smallTier.value = s.tier === 'mini' || s.tier === 'bar' ? s.tier : 'regular';
  if (s.small) {
    // B18 小窗·阅读：小窗里取消朗读 —— 控制条/气泡不进小窗，进入时连正在念的也停掉。
    // （这一档是「换个窗口继续看正文」，不是听书面板；朗读入口留在正常窗。）
    if (!wasSmall && al.active) al.stop();
    alOpen.value = false;
    // 以下都是「页内小窗」的版面动作：桌面端主窗只是被 hide()，恢复时必须是正常阅读界面，
    // 不能把这些收起状态带过去（否则从任务栏唤回主窗，标题栏/侧栏还是小窗的样子）。
    if (!isDesktop()) {
      // 三档都没有顶部标题栏：控制条默认收起，鼠标进顶部热区才浮现（含右上角关闭）
      smallHeadHover.value = false;
      headHidden.value = true;
      moreOpen.value = false;
      toolSettingsOpen.value = false;
      // 小窗只有几百像素：整屏侧滑与样式浮层会把正文挤没 ⇒ 进入即收
      sidePanel.value = false;
      readStyleOpen.value = false;
    }
  } else {
    smallHeadHover.value = false;
    // 恢复正常窗：标题栏先露出来，再按既有逻辑 3 秒后自动收起
    headHidden.value = false;
    if (r.chapter) scheduleHeadHide();
  }
}

/**
 * 小窗顶部热区：按 Y 判定、横向不限（对齐 Web 浮条 `shouldRevealDock`）。
 * 高度来自 `float-geometry.json` ⇒ 与桌面壳注入的标题栏最小高度是同一个值，
 * 整条工具条（含最右 ✕）都在热区内，鼠标在条内任意位置移动都不收起。
 */
function onSmallMouseMove(e: MouseEvent): void {
  if (!inPageSmall.value) return;
  smallHeadHover.value = e.clientY <= DOCK_REVEAL_H;
}
function onSmallMouseLeave(): void {
  smallHeadHover.value = false;
}

/* ---- 条形档正文流由桌面桥 `desktop.ts` 的 float-reading publisher 统一推送 ----
 * （段落 + 章标题 + 目录 + 阅读比例；浮窗渲染层按真实窗宽折行）
 * 这里曾有一份 46 字/行的旧 publisher，主进程早已丢弃该载荷 —— 已删除，避免重复切行与空转 IPC。
 */

onMounted(() => {
  if (!isDesktop()) return;
  const p = getSmallState();
  if (p) void p.then((s) => { if (s?.ok) applySmallState(s); }).catch(() => { /* 桥不可用不打断阅读 */ });
  offSmallState = onSmallStateChange((s) => { if (s?.ok) applySmallState(s); });
});
onBeforeUnmount(() => {
  if (offSmallState) { offSmallState(); offSmallState = null; }
  closeWebSmall();
  webLyricsOpen.value = false;
});

async function toggleSmallWindow(tier: 'regular' | 'bar' = 'regular'): Promise<void> {
  if (!isDesktop()) {
    // Web：小窗阅读只走 Document PiP（不可用由浮窗 toast 明确提示，不再降级页内浮窗）；再点一次入口 = 关闭
    if (webSmallOpen.value) { closeWebSmall(); return; }
    openWebSmall(tier);
    return;
  }
  if (smallBusy.value) return;
  smallBusy.value = true;
  try {
    // 已经在小窗：同名入口 = 退出；条形入口 = 换到条形档（或从条形档退出）
    if (smallMode.value) {
      if (tier === 'bar') {
        if (smallTier.value === 'bar') { await exitSmallWindow(); return; }
      } else if (smallTier.value !== 'bar') {
        await exitSmallWindow();
        return;
      }
    }
    const p = tier === 'bar' ? setSmallWindowTier('bar') : toggleSmallMode(true);
    if (!p) { toast('小窗模式只在桌面端可用', 'warn', 6000); return; }
    const s = await p;
    if (s?.ok) {
      applySmallState(s);
      toast(tier === 'bar'
        ? '已进入条形阅读：浮条显示正文流（不朗读），鼠标移入可调速度 / 穿透 / 退回小窗'
        : '已进入小窗阅读 420×320：顶部控制条可切迷你 / 条形档，Esc 退出', 'info', 8000);
    } else {
      toast(`小窗切换失败：${s?.reason || '未知原因'}`, 'warn', 8000);
    }
  } catch (e) {
    toast(`小窗切换失败：${e instanceof Error ? e.message : String(e)}`, 'warn', 8000);
  } finally {
    smallBusy.value = false;
  }
}

/** 小窗内切档：Web 只有两态 —— 常规 ⇄ 条形（迷你已取消） */
async function switchSmallTier(): Promise<void> {
  if (!isDesktop()) {
    webSmallTier.value = webSmallTier.value === 'bar' ? 'regular' : 'bar';
    return;
  }
  if (!smallMode.value || smallBusy.value) return;
  smallBusy.value = true;
  const next: DesktopSmallTier = smallTier.value === 'mini' ? 'bar' : 'mini';
  try {
    const p = setSmallWindowTier(next);
    if (!p) return;
    const s = await p;
    if (s?.ok) {
      applySmallState(s);
      toast(next === 'bar'
        ? '已切到条形阅读：浮条显示正文流，鼠标移入可调速度 / 穿透'
        : '已切换到小窗·迷你 240×180', 'info', 5000);
    } else {
      toast(`切档失败：${s?.reason || '未知原因'}`, 'warn', 8000);
    }
  } catch (e) {
    toast(`切档失败：${e instanceof Error ? e.message : String(e)}`, 'warn', 8000);
  } finally {
    smallBusy.value = false;
  }
}

async function exitSmallWindow(): Promise<void> {
  if (!isDesktop() || !smallMode.value) return;
  try {
    const p = toggleSmallMode(false);
    if (p) { const s = await p; if (s?.ok) applySmallState(s); }
  } catch { /* 退出失败就留在小窗，至少不丢当前阅读位置 */ }
}

/** 小窗的「关闭」= 先恢复正常窗，再走原有「退当前层」语义（否则会留一个 240×180 的详情页/首页） */
async function closeFromButton(): Promise<void> {
  if (smallMode.value) await exitSmallWindow();
  closeTopLayer();
}

/* ---------------- Web：小窗阅读（只走 Document PiP，两态） ---------------- */
/** 打开 Web 小窗阅读：这是正文阅读，不是听书面板 —— 进入即停朗读、收起朗读控制条 */
function openWebSmall(tier: DesktopSmallTier): void {
  if (al.active) al.stop();
  alOpen.value = false;
  // 迷你态已取消：旧入口/旧状态一律按常规
  webSmallTier.value = tier === 'bar' ? 'bar' : 'regular';
  webSmallOpen.value = true;
}
function closeWebSmall(): void {
  webSmallOpen.value = false;
}
/** 浮窗控制区里的「切换」按钮（常规 ⇄ 条形） */
function onWebFloatTier(tier: DesktopSmallTier): void {
  webSmallTier.value = tier === 'bar' ? 'bar' : 'regular';
}

/**
 * Web 端歌词浮窗：同一扇浮条的另一内容源（`mode='lyrics'` = 朗读当前句）。
 * 默认关闭、由用户主动开启；只走 Document PiP（小窗显示，三行完整不裁切），
 * 不支持/被拒时给出可操作提示，**不降级页内浮窗**。进入小窗阅读时自动让位（同一内容不叠两份）。
 */
function toggleWebLyricsFloat(): void {
  webLyricsOpen.value = !webLyricsOpen.value;
  try { localStorage.setItem(WEB_LYRICS_KEY, webLyricsOpen.value ? '1' : '0'); } catch { /* ignore */ }
  toast(webLyricsOpen.value
    ? '已开启歌词浮窗：朗读时在浏览器小窗显示当前句'
    : '已关闭歌词浮窗', 'info', 8000);
}

/* ---------------- `#221` 页眉 / 页脚 ----------------
 * 三段信息位（左/中/右）各一个模板，取值靠 `ReaderInfoValues`；
 * 语义逐条对齐上游 `ReadTipConfig.kt` + `ReaderInfoTemplate.kt`（契约里有出处注释）。
 */

/**
 * 顶部工具栏：哪些按钮**直接显示在标题栏**，哪些收进「更多」。
 * ★ 关掉的按钮**不是消失** —— 它在「更多」菜单里照样能点到（用户 2026-10-03 的原话）。
 */
const toolPins = ref<Record<ReaderToolId, boolean>>(loadToolPins());
const moreOpen = ref(false);
const toolSettingsOpen = ref(false);
/* B18：小窗阅读入口默认收进「更多」菜单；想让它在标题栏常显时用这个开关把它钉回来
   （与 `toolPins` 分开：那条是「工具按钮是否常显」，这条是「窗口形态入口是否常显」）。 */
const MINI_PIN_KEY = 'yuedu.reader.mini.pin';
function loadMiniPin(): boolean {
  try { return localStorage.getItem(MINI_PIN_KEY) === '1'; } catch { return false; }
}
const miniPin = ref<boolean>(loadMiniPin());
function toggleMiniPin(): void {
  miniPin.value = !miniPin.value;
  try { localStorage.setItem(MINI_PIN_KEY, miniPin.value ? '1' : '0'); } catch { /* 存不下只影响下次默认 */ }
}
/** 「更多」里的小窗阅读入口：先收菜单再切（桌面进 Electron 小窗，Web 开/关浏览器小窗/页内浮窗） */
function onSmallMenuClick(): void {
  moreOpen.value = false;
  void toggleSmallWindow('regular');
}

/**
 * 桌面歌词浮窗的可发现入口（用户 2026-11-08 反馈：只在设置页深处，阅读时找不到）。
 * · 这里只切 `lyricsEnabled`（与设置页同一个落盘字段），不改朗读状态；
 * · 默认仍是 **关闭**（系统级置顶窗首次出现比「找不到入口」更打扰）；
 * · 打开后只要「朗读中 + 有当前句 + 未锁屏 + 不在小窗」就显示（见 desktop-lib.lyricsShouldShow）；
 *   语义与条形档一致：**浮条的一个功能模式**，由用户主动开关，不再要求主窗失焦。
 */
const lyricsFloatEnabled = ref(false);
async function refreshLyricsFloatPref(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const p = await getDesktopPrefs();
    if (p?.prefs) lyricsFloatEnabled.value = p.prefs.lyricsEnabled === true;
  } catch { /* 旧外壳 / 读取失败：保持关闭态，不打断阅读 */ }
}
async function toggleLyricsFloat(): Promise<void> {
  if (!isDesktop()) { toggleWebLyricsFloat(); return; }
  const next = !lyricsFloatEnabled.value;
  lyricsFloatEnabled.value = next;
  try {
    const res = await setDesktopPrefs({ lyricsEnabled: next });
    if (res && !res.ok) {
      lyricsFloatEnabled.value = !next;
      toast(`保存失败：${res.error || '未知原因'}`, 'warn', 8000);
      return;
    }
    toast(next
      ? '已开启桌面歌词浮窗：朗读中就显示当前句（暂停或进入小窗即隐藏）'
      : '已关闭桌面歌词浮窗', 'info', 8000);
  } catch (e) {
    lyricsFloatEnabled.value = !next;
    toast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'warn', 8000);
  }
}
function openMoreMenu(): void {
  moreOpen.value = !moreOpen.value;
}
function toggleToolPin(id: ReaderToolId): void {
  toolPins.value = { ...toolPins.value, [id]: !toolPins.value[id] };
  saveToolPins(toolPins.value);
}

/**
 * `#806` `D8` **标题栏悬停显隐**。
 *
 * 口径（用户 2026-11-06 拍板）：鼠标移入顶部热区 → 标题栏显示；移出 3 秒 → 收起。
 * · **只作用于正文阅读态**（`r.chapter` 非空）；详情页标题栏常显，不进这套判据；
 * · 不碰 `headerVisible`（那是页眉，判据完全独立，见上方 `headerVisible` 的注释）；
 * · `toolPins` 只决定「哪些按钮常显在标题栏」，本功能只控制**整条标题栏**的显隐，两者互不影响；
 * · 触屏没有 hover ⇒ 不启用自动隐藏（否则用户点不到按钮），触屏仍常显。
 *
 * ★ 收起只切 `opacity` / `pointer-events`，**不改高度** —— 与页眉 `.rd-tip-off` 同一条纪律：
 *   布局高度恒定就不会出现「收起 → 内容上跳 → 用户滚动 → 是否显示判据翻转」的反馈环。
 */
const HEAD_AUTOHIDE_KEY = 'yuedu.reader.toolbar.autohide';
function loadHeadAutoHide(): boolean {
  try {
    const v = localStorage.getItem(HEAD_AUTOHIDE_KEY);
    return v == null ? true : v === '1';
  } catch {
    return true; // 隐私模式/坏数据：按默认启用，存不下不影响阅读
  }
}
const headAutoHide = ref<boolean>(loadHeadAutoHide());
function saveHeadAutoHide(v: boolean): void {
  try { localStorage.setItem(HEAD_AUTOHIDE_KEY, v ? '1' : '0'); } catch { /* 不打断阅读 */ }
}
const HEAD_HIDE_DELAY = 3000;
const headHidden = ref(false);
/** 鼠标是否停在热区内 —— 3 秒定时到点时若仍停着就不收（避免「手还在上面，栏先消失」） */
const headHovering = ref(false);
let headHideTimer = 0;
function clearHeadHideTimer(): void {
  if (headHideTimer) { window.clearTimeout(headHideTimer); headHideTimer = 0; }
}
/** 立刻露出标题栏（移入热区 / 点热区 / 关闭子浮层都走这里） */
function revealHead(): void {
  clearHeadHideTimer();
  headHidden.value = false;
}
function onHeadZoneEnter(): void {
  headHovering.value = true;
  revealHead();
}
function onHeadZoneLeave(): void {
  headHovering.value = false;
  scheduleHeadHide();
}
/** 移出热区后 3s 收起；「更多」/按钮设置/加入书架还开着时先不收（否则用户点开菜单整条消失） */
function scheduleHeadHide(): void {
  clearHeadHideTimer();
  // B18：两档小窗都禁用悬停隐藏（否则小窗里标题栏一收，用户找不到退出/切档/关闭）
  if (inPageSmall.value) return;
  if (!headAutoHide.value || !r.chapter) return;
  // 触屏没有 hover：收起后用户没有「移入」这个动作，会点不到按钮 ⇒ 不启用
  if (window.matchMedia && !window.matchMedia('(hover: hover)').matches) return;
  headHideTimer = window.setTimeout(() => {
    headHideTimer = 0;
    if (!headAutoHide.value || !r.chapter) return;
    if (inPageSmall.value || headHovering.value) return; // 小窗态 / 手还在顶部：这次定时作废
    if (moreOpen.value || toolSettingsOpen.value || addShelfOpen.value) return;
    headHidden.value = true;
  }, HEAD_HIDE_DELAY);
}
function toggleHeadAutoHide(): void {
  headAutoHide.value = !headAutoHide.value;
  saveHeadAutoHide(headAutoHide.value);
  if (!headAutoHide.value) revealHead();
  else scheduleHeadHide();
}
/** 真正应用「收起」：子浮层开着 / 详情态 / 关闭开关时都不收 */
const headCollapsed = computed(() =>
  !inPageSmall.value // B18：两档小窗标题栏常显（它是唯一的退出/切档/关闭入口）
  && headAutoHide.value
  && !!r.chapter
  && headHidden.value
  && !moreOpen.value
  && !toolSettingsOpen.value
  && !addShelfOpen.value,
);
// 打开正文 / 换章 ⇒ 给用户 3 秒看标题栏；退回详情或关浮层 ⇒ 立刻恢复常显
watch(
  () => [r.open, r.chapter] as const,
  ([open, ch]) => {
    if (open && ch) scheduleHeadHide();
    else revealHead();
  },
);
onBeforeUnmount(clearHeadHideTimer);

/**
 * `#811` **逃生口：全局 `Ctrl+Shift+M` 强制切回滚动并落盘**。
 *
 * ## 为什么必须有它（用户 2026-11-06 的实机事故）
 * 「视图模式」的唯一入口在阅读页 `更多 → 样式 → 动画`。一旦分页把界面冻住
 * （或标题栏被 D8 收起 / 被 `inert` 挡住），用户**没有任何出口** ——
 * 实测只能换一本只有两页的书，趁还能响应时摸进样式面板改回来。
 *
 * ## 为什么是「捕获阶段 + 冒泡停掉」而不是再造一个按钮
 * 冻结时**任何可见层都可能是不可信的**（`inert`、`pointer-events:none`、遮罩层级）。
 * 键盘事件不依赖命中测试：`window` 的**捕获阶段**监听比所有冒泡监听（含 `onKey`
 * 与各菜单自己的 keydown）都先跑，`stopPropagation()` 后谁也拦不住。
 *
 * ## 它只做三件确定的事
 * ① 停掉 D9 自动滚动（滚动/分页语义不兼容，别让它继续写 `scrollTop`）；
 * ② 立刻把标题栏**露出且不再自动收**（`headHidden=false` + 清定时器）—— 出口本身不能隐身；
 * ③ `setViewMode('scroll')`（store 内部 `saveReaderViewMode` 落盘 ⇒ **重启后也是滚动**），
 *   再**同步**取消在途重建 + 清空页（不等 watcher，冻结时那些调度可能已经排不上）。
 * 幂等：本来就在滚动模式时，等于只做「露标题栏 + 清残留」。
 */
function forceScrollMode(): void {
  stopAutoScroll();
  revealHead(); // 清掉收起定时器 + `headHidden=false`（标题栏立刻可见）
  curPage.value = 1;
  r.setViewMode('scroll');
  paged.reset(); // `#825`：取消在途重建 + 清空页（`pagedActive` 此刻已随 viewMode 变假）
  void nextTick(updateProgress);
  toast('已切回滚动阅读（Ctrl+Shift+M 强制退出分页）', 'info');
}
function onForceScrollKey(e: KeyboardEvent): void {
  if (!r.open) return;
  // 只认 Ctrl+Shift+M（大小写都收）：不抢任何已有快捷键
  if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
  if (e.key !== 'm' && e.key !== 'M') return;
  e.preventDefault();
  e.stopPropagation();
  forceScrollMode();
}

/**
 * `#808` `D9` **自动滚动阅读**（仅滚动模式）。
 *
 * 口径（用户 2026-11-06 拍板）：
 * · 用 `requestAnimationFrame` 每帧 `scrollBy(0, speed)`；速度按「px/帧 @60fps」记录，
 *   实际按帧间隔换算 ⇒ 高刷屏不会滚得更快（验收要求「匀速」）；
 * · 用户滚轮 / 触摸 / 点击 / 按键 ⇒ **立即停**；切到分页模式 ⇒ 自动停；朗读开始 ⇒ 自动停；
 * · 到本章末尾 ⇒ 停（本轮不做「滚到底自动续章」，也不做分页定时翻页）。
 *
 * ★ `#814`：速度档位已抽到 `utils/auto-scroll.ts`，**阅读页与设置页共用同一个 ref**
 *   （旧版只写 localStorage ⇒ 设置页改完，开着的阅读页要重开才生效）。
 *   开关（`autoScrollOn`）仍是会话态 —— 它只在阅读时才有意义，不该在设置页「预置为开」。
 */
const autoScrollOn = ref(false);
let autoScrollRaf = 0;
let autoScrollLastTs = 0;
function onAutoScrollSpeedInput(e: Event): void {
  setAutoScrollSpeed(Number((e.target as HTMLInputElement).value));
}
function stopAutoScroll(): void {
  if (autoScrollRaf) { cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0; }
  autoScrollLastTs = 0;
  autoScrollOn.value = false;
}
/** 滚轮 / 触摸 / 按键都会走到这里（任何「手动操作」的意图都立即停） */
function onAutoScrollUserInput(): void {
  if (autoScrollOn.value) stopAutoScroll();
}
function tickAutoScroll(ts: number): void {
  autoScrollRaf = 0;
  if (!autoScrollOn.value) return;
  const el = pageBodyEl.value;
  if (!el || isPaged.value) { stopAutoScroll(); return; }
  // 到底（或本章不足一屏）：不再滚（本轮不做自动续章）
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
    stopAutoScroll();
    toast('已到本章末尾，自动滚动停止', 'info');
    return;
  }
  if (!autoScrollLastTs) autoScrollLastTs = ts;
  const dt = Math.min(50, ts - autoScrollLastTs); // 标签页切回时别一次滚一大段
  autoScrollLastTs = ts;
  el.scrollBy(0, autoScrollSpeed.value * (dt / (1000 / 60)));
  autoScrollRaf = requestAnimationFrame(tickAutoScroll);
}
function toggleAutoScroll(): void {
  if (autoScrollOn.value) { stopAutoScroll(); return; }
  if (isPaged.value) { toast('分页模式不支持自动滚动，请先切到滚动模式', 'warn'); return; }
  if (al.isPlaying) { toast('朗读进行中，先停止朗读再开自动滚动', 'warn'); return; }
  if (!pageBodyEl.value) { toast('正文还没准备好', 'warn'); return; }
  autoScrollOn.value = true;
  autoScrollLastTs = 0;
  autoScrollRaf = requestAnimationFrame(tickAutoScroll);
}
// 切到分页 / 离开正文 ⇒ 自动停（用户「切分页自动停」的验收点）
// ★ B8：切到滚动 ⇒ 自动翻页也停（两种「自动往下看」各自只在自己的模式里生效）
watch(isPaged, (paged) => {
  if (paged) stopAutoScroll();
  else stopAutoPage();
});
/**
 * `#814` 朗读一开始就停。
 * 旧版只在「开自动滚动」时检查 `al.isPlaying`（拒启）—— 反过来的顺序（先开滚动、再点朗读）
 * 不会停，而「朗读中」是用户列的必停入口之一。
 */
watch(() => al.isPlaying, (playing) => {
  if (!playing) return;
  stopAutoScroll();
  stopAutoPage(); // B8：开朗读 ⇒ 自动翻页停（对齐上游「互斥」）
});
onBeforeUnmount(stopAutoScroll);

/* ════════════════════════════════════════════════════════════════════════
 * B8 **自动翻页**（分页模式）
 *
 * ## 上游口径（`F:\legado`，GPL-3.0：只参考机制，独立实现）
 * · `AutoPager.kt:155-165`：定时到点就 `fillPage(NEXT)`；返回 `false` ⇒ `stop()`（**读到底自动停**）。
 * · `TextPageFactory.kt:46-64`：`moveToNext` 在章末走 `ReadBook.moveToNextChapter` ⇒
 *   **自动续下一章**，不是停在章末。
 * · `ReadBookActivity.kt:2063-2073`：开自动翻页**先 `ReadAloud.stop(this)`** ⇒ 与朗读互斥；
 *   同时 `screenTimeOut = -1L`（顺带屏幕常亮）。
 * · `ReadBookActivity.kt:745`：Activity `onPause` ⇒ `autoPageStop()`（离开前台即停）。
 *
 * ## 本仓实现（有意偏离）
 * · 只在**分页模式**（`pagedActive`）生效：滚动模式已有「自动滚动」（匀速下滑），
 *   不必再做一份「定时滚动」；漫画/PDF/HTML 也不参与分页 ⇒ 一并不可用。
 * · 档位 4/8/12/20/30 秒（用户拍板）；上游是 1~60 秒滑块。
 * · 章末续下一章、**最后一章末页自动停**（并给出提示，上游是静默停）。
 * · 计时期间**不计入阅读时长**（`statsCountable` 里排除）——上游无对应统计，本仓口径。
 * · 屏幕常亮是**独立开关**（默认关），不随自动翻页强制打开（上游会强制常亮，这里有意偏离：
 *   用户明确要求常亮默认关，且不应该被别的开关偷偷打开）。
 * ════════════════════════════════════════════════════════════════════════ */
const autoPageOn = ref(false);
let autoPageTimer = 0;

function clearAutoPageTimer(): void {
  if (autoPageTimer) { window.clearTimeout(autoPageTimer); autoPageTimer = 0; }
}

function stopAutoPage(notice = ''): void {
  clearAutoPageTimer();
  if (!autoPageOn.value) return;
  autoPageOn.value = false;
  if (notice) toast(notice, 'info');
}

function scheduleAutoPage(): void {
  clearAutoPageTimer();
  if (!autoPageOn.value) return;
  autoPageTimer = window.setTimeout(tickAutoPage, autoPageInterval.value * 1000);
}

/**
 * 到点翻一页。
 * · 本章末页 ⇒ 接下一章（对齐上游 `moveToNext`）；已经是全书最后一章 ⇒ 停。
 * · 页表重建中 ⇒ **顺延一档**，不叠加一次翻页（防止连翻丢页）。
 * · 标签页隐藏 ⇒ 停（对齐上游 `onPause → autoPageStop`）。
 */
function tickAutoPage(): void {
  autoPageTimer = 0;
  if (!autoPageOn.value) return;
  if (!pagedActive.value) { stopAutoPage(); return; }
  if (typeof document !== 'undefined' && document.hidden) { stopAutoPage(); return; }
  if (paged.measuring.value || !paged.ready.value) {
    scheduleAutoPage();
    return;
  }
  if (curPage.value >= pageCount.value) {
    const lastIdx = (r.detail?.chapters?.length ?? 0) - 1;
    if (!r.chapter || r.chapterIdx >= lastIdx) {
      stopAutoPage('已到全书末尾，自动翻页停止');
      return;
    }
    void nextChapterPastEnd();
    scheduleAutoPage();
    return;
  }
  turnPage(1);
  scheduleAutoPage();
}

function toggleAutoPage(): void {
  if (autoPageOn.value) { stopAutoPage(); return; }
  if (!pagedActive.value) {
    toast(isPaged.value ? '当前章节不支持分页（漫画/PDF/HTML），自动翻页不可用' : '自动翻页只在分页模式下可用', 'warn');
    return;
  }
  // ★ 与朗读**强制互斥**（对齐上游 `autoPage(): ReadAloud.stop()`）：
  //   连暂停态也一并停 —— 「暂停」仍占着句子表与浮条，开自动翻页时不该两套状态并行。
  if (al.active) { al.stop(); alOpen.value = false; }
  // 自动滚动不可能与自动翻页同时开（模式互斥），这里再兜一次，防止切模式瞬间的残留
  if (autoScrollOn.value) stopAutoScroll();
  autoPageOn.value = true;
  scheduleAutoPage();
}

onBeforeUnmount(() => { clearAutoPageTimer(); });

/* ── B8 屏幕常亮 ───────────────────────────────────────────────────────
 * 只在阅读浮层打开、且用户开了常亮时持有；关浮层立即释放（不把整站变成永不熄屏）。
 * 系统/浏览器回收锁（切后台）后由 `keep-awake.ts` 在回到前台时重取。
 * 开关本身已迁到「设置 → 阅读」（用户 2026-11-09），这里只保留「进阅读就申请/退阅读就释放」。 */
watch(
  () => [r.open, keepAwakePref.value] as const,
  ([open, on]) => setReaderAwake(!!open && on === true),
  { immediate: true },
);

/* ===================================================================================
 * B1 阅读统计 · **本地日桶**埋点（用户 2026-11-06 拍板）
 *
 * 口径（与看板文案一致）：
 *  · 只统计「正文已就绪」的时长 —— 目录 / 详情 / 加载中不算；
 *  · **自动滚动、自动翻页、朗读（听书）不计**（用户决策；B8 明确「自动阅读不计入」）；
 *    标签页隐藏（`document.hidden`）不计；
 *  · 受 `prefs.enableReadRecord` 门控：关掉「记录阅读时长」就连本地日桶一起停，
 *    不能出现「设置里关了、统计里还在涨」的自相矛盾；
 *  · 只写 localStorage，**不进服务端**；历史总额仍来自服务端旧 `read-records`。
 *
 * 结算策略：15s 心跳 + 状态切换时立即结算。
 * 状态切换必须**先用旧态结算、再按新态重新起表**，否则自动滚动/朗读那几分钟
 * 会被整段算进「阅读」（切态时间点正好落在两次心跳之间时误差最大）。
 */
const statsDocHidden = ref(typeof document !== 'undefined' ? document.hidden : false);
const statsCountable = computed(() => !!r.chapter
  && r.prefs.enableReadRecord !== false
  && !al.isPlaying
  && !autoScrollOn.value
  && !autoPageOn.value
  && !statsDocHidden.value);
let statsMarkMs = 0;
function settleReadStats(activeNow: boolean): void {
  const now = Date.now();
  if (statsMarkMs > 0 && now > statsMarkMs) addReadingMs(now - statsMarkMs, new Date(now));
  statsMarkMs = activeNow ? now : 0;
}
const statsTimer = window.setInterval(() => {
  if (statsMarkMs > 0) settleReadStats(true);
  p1Tick();
}, 15_000);
watch(statsCountable, (active) => settleReadStats(active), { immediate: true });
if (typeof document !== 'undefined') {
  // 用 `storage event` 之外最可靠的一条：同一页面隐藏/恢复只走 visibilitychange
  document.addEventListener('visibilitychange', () => { statsDocHidden.value = document.hidden; });
}
onBeforeUnmount(() => {
  window.clearInterval(statsTimer);
  settleReadStats(false);
});

/* ===================================================================================
 * P1 `#863` 阅读会话流水（服务端 `read_session` / 聚合三表）
 *
 * 与上面的本地日桶**并行**：日桶保留为离线兜底（D-9），会话流水是看板的新数据源。
 *
 * 会话口径（用户拍板 D-3~D-6）：
 *  · `total_ms` = 前台在线；`effective_ms` = 本模式的有效时长；
 *  · `visual` / `listen`（朗读播放中）/ `auto`（自动滚动或自动翻页）**各自独立一条会话**，
 *    切模式立即结算旧会话 ⇒ 不会出现「半段朗读被算进目视有效」；
 *  · 有效判定用**活动事件**（点击/滚动/滚轮/键盘/切章）而不是「必须翻页」——
 *    滚动阅读没有翻页；
 *  · 切书/切后台（隐藏）/关闭浮层立即结算；切章**不**结束会话，只更新断点；
 *  · `enableReadRecord` 关闭 ⇒ 不产生新会话；漫画/PDF 不统计（D-8，看板标注「文本阅读统计」）。
 */
const p1Mode = computed<ReadSessionMode>(() => {
  if (al.isPlaying) return 'listen';
  return autoScrollOn.value || autoPageOn.value ? 'auto' : 'visual';
});
const p1BookUrl = computed(() => (r.chapter ? encodeItemKey(r.currentKey) : ''));
const p1Progress = computed(() => {
  const total = r.detail?.chapters?.length ?? 0;
  return total > 0 ? Math.min(1, Math.max(0, (r.chapterIdx + 1) / total)) : 0;
});
const p1Meta = computed<ReadSessionMeta | null>(() => {
  if (!r.open || !r.chapter || !p1BookUrl.value) return null;
  if (isComic.value) return null; // D-8：P1 只统计文本阅读
  if (r.prefs.enableReadRecord === false) return null; // 总开关
  return {
    bookUrl: p1BookUrl.value,
    bookName: r.detail?.title ?? '',
    bookAuthor: r.detail?.author ?? r.detail?.subtitle ?? '',
    chapterIndex: r.chapterIdx,
    chapterTitle: String(r.chapter.title ?? ''),
    startProgress: p1Progress.value,
  };
});

let p1Tracker: ReadSessionTracker | null = null;
let p1SessionKey = '';

/** 结算当前会话：落库（失败进离线队列），并清检查点 */
function p1Stop(): void {
  const tr = p1Tracker;
  p1Tracker = null;
  p1SessionKey = '';
  if (!tr) return;
  const draft = tr.finish(Date.now());
  clearCheckpoint();
  if (draft) void reportSession(draft);
}

/**
 * 起一条会话。先看崩溃检查点：
 * 同书同模式且 10 分钟内 ⇒ 续接（`session_id` 不变）；过期/换书 ⇒ 先把检查点当已结束会话补传。
 */
function p1Start(meta: ReadSessionMeta, mode: ReadSessionMode): void {
  const key = `${meta.bookUrl}|${mode}`;
  if (p1Tracker && key === p1SessionKey) return;
  p1Stop();
  const cp = takeCheckpoint(meta.bookUrl, mode, Date.now());
  if (cp?.resumable) {
    p1Tracker = new ReadSessionTracker({
      meta,
      mode,
      sessionId: cp.draft.sessionId,
      restored: {
        startAt: cp.draft.startAt,
        totalMs: cp.draft.totalMs,
        effectiveMs: cp.draft.effectiveMs,
        readPageCount: cp.draft.readPageCount,
      },
    });
  } else {
    if (cp && cp.draft.totalMs >= 1000) void reportSession(cp.draft);
    p1Tracker = new ReadSessionTracker({ meta, mode });
  }
  p1SessionKey = key;
  p1Tracker.tick();
}

/** 状态变化后的对齐：无门槛就停；同书同模式只更新断点（切章不拆会话） */
function p1Sync(): void {
  const meta = p1Meta.value;
  if (statsDocHidden.value || !meta) {
    p1Stop();
    return;
  }
  p1Start(meta, p1Mode.value);
  p1Tracker?.setChapter(meta.chapterIndex, meta.chapterTitle, p1Progress.value);
}

function p1Tick(): void {
  p1Tracker?.tick();
}

watch([p1Meta, p1Mode, statsDocHidden], p1Sync, { immediate: true });
// 翻页计数（滚动模式没有「页」，不计）
watch(curPage, (next, prev) => {
  if (p1Tracker && pagedActive.value && next !== prev) p1Tracker.addPage();
});

const p1CheckpointTimer = window.setInterval(() => {
  if (p1Tracker) saveCheckpoint(p1Tracker.snapshot());
}, CHECKPOINT_INTERVAL_MS);

/** 活动事件：任何一条都算「人还在」；没有活动 120s 后停止累计有效 */
const P1_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchmove', 'scroll'] as const;
const onP1Activity = (): void => { p1Tracker?.markActivity(); };
for (const ev of P1_ACTIVITY_EVENTS) window.addEventListener(ev, onP1Activity, { passive: true });
/** 刷新/关标签来不及走卸载：先落检查点，下次进阅读页续接或补传 */
const onP1PageHide = (): void => {
  if (p1Tracker) saveCheckpoint(p1Tracker.snapshot());
};
window.addEventListener('pagehide', onP1PageHide);
// 进阅读页先补传上次离线/崩溃留下的会话
void flushSessionQueue();

onBeforeUnmount(() => {
  window.clearInterval(p1CheckpointTimer);
  for (const ev of P1_ACTIVITY_EVENTS) window.removeEventListener(ev, onP1Activity);
  window.removeEventListener('pagehide', onP1PageHide);
  p1Stop();
});
/** `#399` RSS 文章会话：正文页只保留「刷新正文」（其余工具都是书籍/漫画专属，对订阅源无意义） */
const RSS_ARTICLE_TOOL_IDS = new Set(['refresh']);
const pinnedTools = computed(() =>
  r.rssArticle
    ? READER_TOOLS.filter((t) => RSS_ARTICLE_TOOL_IDS.has(t.id))
    : READER_TOOLS.filter((t) => toolPins.value[t.id]),
);
/**
 * 按钮文案：只有「刷新」与「朗读」是**动态的**，其余就是「图标 + 名字」。
 * ⚠️ 朗读的三态文案必须保留（`#220`：暂停态写「已暂停（点此继续）」）——
 *    按钮从正文区挪到标题栏，**语义不能跟着丢**。
 */
function toolLabel(t: { id: ReaderToolId; icon: string; label: string }): string {
  if (t.id === 'refresh') return refreshContentLabel.value;
  if (t.id === 'readAloud') {
    if (!al.active) return `${t.icon} ${t.label}`;
    return al.isPlaying ? '⏹ 停止朗读' : '⏸ 已暂停（点此继续）';
  }
  return `${t.icon} ${t.label}`;
}

/**
 * 按钮 `title`（悬停提示）：默认就是按钮名（`t.label`）。
 *
 * ★ `#254`：**开关型**按钮（替换净化）必须把**当前状态**写进提示里 ——
 *   它被钉到标题栏时，按钮上只有「⇆ 替换净化」四个字，光看颜色（`primary`）在
 *   色弱/深色主题下都不够确定 ⇒ 提示里明说是「已开启」还是「已关闭」。
 */
function toolTitle(t: { id: ReaderToolId; icon: string; label: string }): string {
  if (t.id === 'replace') {
    /**
     * `#260`：开关是**本书级**的（上游 `Book.ReadConfig.useReplaceRule`）⇒ 提示里必须写「本书」，
     * 否则用户会按 `#254` 的老印象以为这是全局开关，关了一次却发现别的书也没净化。
     */
    const scope = r.currentBookUseReplaceRule == null ? '本书 · 跟随全局' : '本书';
    return r.replaceEnabled
      ? `${t.label}（${scope}）：已开启，点击关闭`
      : `${t.label}（${scope}）：已关闭，点击开启`;
  }
  if (t.id === 'effectiveReplaces') return '看本章真正起效的替换规则（可关闭起效 / 点开编辑）';
  return t.label;
}
function runTool(id: ReaderToolId): void {
  moreOpen.value = false;
  // `#370`：「返回详情」工具在「网页即正文」会话（openWeb 合成详情）里没有详情可回 → 整关
  if (id === 'back') { if (r.webDoc || r.rssArticle) r.close(); else r.reset(); }
  else if (id === 'switch') switchDlgOpen.value = true;
  else if (id === 'refresh') void onRefreshContent();
  else if (id === 'readAloud') void onReadAloudEntry();
  else if (id === 'search') openSearchTab();
  else if (id === 'cache') openCacheDialog();
  else if (id === 'style') readStyleOpen.value = true;
  else if (id === 'replace') toggleReplace();
  else if (id === 'effectiveReplaces') effReplacesOpen.value = true;
  else if (id === 'manualRules') manualRulesOpen.value = true;
  else if (id === 'highlightRules') hrRulesOpen.value = true;
}

/**
 * **`#260` 本书级替换净化开关**（上游 `Book.ReadConfig.useReplaceRule`）。
 *
 * ## 语义（三级回落，判据只有一份：`utils/replace-rules.ts` 的 `useReplaceRuleFor()`）
 * ① 本书设过 ⇒ 用它；② 图片/媒体书 ⇒ 默认关；③ 否则跟全局 `prefs.replaceEnableDefault`。
 * 这里点的动作 = 把**本书**设成 `!当前生效值`（写 `ShelfBook.useReplaceRule`）。
 *
 * ## 为什么书不在书架时**拒绝**而不是偷偷改全局
 * 覆盖值存在**书架条目**上（同 `readStyle`），没有条目就没有地方存。
 * 退回写全局会变成「只想对这本书关掉，结果所有书都被关了」—— 比拒绝更糟。
 * 所以如实提示（并指出全局入口在 设置 → 净化），与 `patchBookReadStyle` 的约定一致。
 *
 * ★ 写完必须 `reloadCurrentChapter()`：净化只在**展示时**做、缓存里存的是**原文**
 * ⇒ 不重跑的话界面上这一章不会变（用户会以为「点了没反应」）；`cache:'read'` 读回原文，不联网。
 */
function toggleReplace(): void {
  const next = !r.replaceEnabled;
  if (!r.setBookUseReplaceRule(next)) {
    toast('这本书不在书架，没法单独设置净化开关 —— 先「加入书架」，或改「设置 → 净化」里的全局默认', 'warn');
    return;
  }
  toast(next ? '已开启本书的替换净化' : '已关闭本书的替换净化', next ? 'ok' : 'info');
  r.reloadCurrentChapter();
}

/**
 * ★ `#227`：离开正文页 / 关掉整个浮层时，把「更多」「按钮显示设置」**一起收掉**。
 *
 * ## 根因（不是「浮层没卸载」这么简单）
 * `ReaderOverlay` 在 `MainLayout` 里是**常驻组件**（`<ReaderOverlay />`），
 * `.se-mask` 的 `v-if="r.open"` 只卸载了内部 DOM ⇒ **组件的 `ref` 状态跨「关掉→重开」保留**。
 * 于是用户点浮层外空白（走 `close()`）关掉正文页，再点「继续阅读」重开，
 * `toolSettingsOpen` 仍是 `true` ⇒ 「标题栏按钮显示设置」**又出现了**。
 * ⇒ 两个判据都要盯：`r.open`（整个浮层）与 `r.chapter`（详情 ⇄ 正文）。
 *
 * 与 `#218` 那次同源的坑：那里是「关浮层走 `reset()`，`r.open` 仍为 true」，这里是反过来的。
 */

/**
 * `#432` **阅读浮层打开时锁住背后页面的滚动**。
 *
 * ## 缺陷（用户 2026-10-13 实测截图：右缘**两条并排滚动条**、互相「乱跳」）
 * `.se-mask` 是 `position:fixed; inset:0` 的遮罩，但它**不阻止背后那个长页面**
 * （书源/分类列表）继续持有**窗口滚动条** ⇒ 视觉上「界面滚动条 + 阅读页滚动条」并排两条；
 * 且滚轮在正文滚到头之后会**链到背后的页面**把它滚走 ⇒ 观感就是「乱跳 / 无法滚动」。
 * （`.se-panel` 宽 `min(920px,100%)`，窄窗口下几乎贴满 ⇒ 与窗口滚动条只差几个像素，看得很清楚。）
 *
 * ## 处置
 * 打开时把 `documentElement` / `body` 的 `overflow` **记下原值**再置 `hidden`；
 * 关闭（或组件卸载）时**还原原值**。
 * ⚠️ 必须存原值（不能写死回 `''`）—— 其它地方可能已经设过 `overflow`。
 */
let savedDocOverflow: { html: string; body: string } | null = null;
function lockBodyScroll(): void {
  if (savedDocOverflow) return;
  savedDocOverflow = {
    html: document.documentElement.style.overflow,
    body: document.body.style.overflow,
  };
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}
function releaseBodyScrollLock(): void {
  if (!savedDocOverflow) return;
  document.documentElement.style.overflow = savedDocOverflow.html;
  document.body.style.overflow = savedDocOverflow.body;
  savedDocOverflow = null;
}

watch(() => r.open, (v) => {
  if (v) {
    lockBodyScroll();
    return;
  }
  releaseBodyScrollLock();
  stopAutoPage(); // B8：关掉阅读浮层 ⇒ 自动翻页一并停
  moreOpen.value = false;
  toolSettingsOpen.value = false;
  // `#256`：高亮那三个浮层同属「跨关开保留」的 ref 状态 ⇒ 一起收（否则重开时凭空冒出来）
  hideHlMenu();
  hlStyleOpen.value = false;
  hlNoteOpen.value = false;
});
watch(() => r.chapter, (ch) => {
  // `#815`：**任何换章**（不只是退出正文）都要收掉两种文字菜单 —— 正文一换，选区必然失效
  hideSelMenu();
  if (ch) { hideCtxMenu(); return; }
  moreOpen.value = false;
  toolSettingsOpen.value = false;
  hideHlMenu();
  hideCtxMenu(); // `#807`：退出正文 ⇒ 右键菜单一并收掉
  stopAutoScroll(); // `#808`：退出正文 ⇒ 自动滚动一并停
  stopAutoPage();   // B8：退出正文 ⇒ 自动翻页一并停
  hlStyleOpen.value = false;
  hlNoteOpen.value = false;
});

/** `{时间}`：页眉常显时间，不能只在打开时算一次 ⇒ 30s 走一格 */
const tipClock = ref(new Date());
let tipClockTimer = 0;

/**
 * `{电量}`：Web 只有部分浏览器实现了 `navigator.getBattery()`。
 * ★ 拿不到就是 `null`（渲染成空串）—— 编一个「0%」比留空更糟。
 */
const tipBattery = ref<number | null>(null);

/** 正文区是否**已经向下滚过**（页眉 `headerMode = 0` 的「自动隐藏」判据） */
const scrolledDown = ref(false);
// 翻章后回到新的一章 ⇒ 页眉重新露出（不翻页的话滚动归零也会触发，这里是双保险：
// 某些章节内容不足一屏、根本不会触发 scroll 事件）
watch(() => r.chapterIdx, () => { scrolledDown.value = false; });

/**
 * `{正文字数}`（**本仓扩展**，上游没有这个占位符/信息位）：**本章**正文字数。
 *
 * ## 口径（用户 2026-10-04 拍板：「本章正文字数」）
 *  = 去掉所有空白字符后的长度（**含标点**）—— 与常见「字数统计」一致。
 *  · **只算正文段落**，不含章节标题（否则同一章会因为标题长短而飘）；
 *  · 用 `displayParagraphs`（显示层，与正文渲染、高亮坐标**同一份**，见 `hlLayout` 的注释）
 *    ⇒ 开了简繁转换后数字跟着变，与用户眼睛看到的一致。
 *  · `\s` 本身已包含全角空格 U+3000（中文缩进常用）⇒ 不用额外补字符类。
 *
 * ⚠️ 媒体类章节（视频 / m3u8 / 文件）的 `paragraphs` **本来就是空的**（正文在 `media` 里）
 *   ⇒ 显示「0」是**对的**，不是算错。见 `stores/reader.ts` 里 `detailErr` 那段注释。
 *
 * ★ 类型门控（用户 2026-10-06 反馈，`#301`）：**只有文本类（book / article）才显示字数**；
 *   音频 / 图片（漫画）/ 文件 / 视频四类返回**空串**（占位符渲染成空，而不是误导性的「0」）。
 *   判据用 `r.detail?.kind`（契约 `UnifiedItem['kind']`：book / video / article / audio / image / file）
 *   —— 与本文件既有的 `isComic` / `isAudio` 同一数据源，不引入第二份类型真相。
 */
const chapterTextLength = computed(() => {
  const k = r.detail?.kind;
  if (k === 'video' || k === 'audio' || k === 'image' || k === 'file') return '';
  let n = 0;
  for (const p of r.displayParagraphs ?? []) n += p.replace(/\s+/gu, '').length;
  return String(n);
});

const readerInfoValues = computed<ReaderInfoValues>(() => {
  const d = tipClock.value;
  return {
    bookName: r.detail?.title ?? '',
    chapterTitle: r.displayTitle ?? '',
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    battery: tipBattery.value,
    // ⚠️ 滚动模式**没有「页」**这个概念 ⇒ 页码留空；`#222` 起分了页才填。
    //    默认值因此不用 `pageAndTotal`（那会渲染成「/  12%」），见契约里 `tipFooterRightTemplate` 的注释。
    page: '',
    totalPages: '',
    readProgress: totalPctText.value,
    chapter: String(r.chapterIdx + 1),
    totalChapters: String(totalCh.value),
    textLength: chapterTextLength.value,
  };
});

/** 渲染一段信息位：`非空自定义模板` 优先，否则用该信息位的默认模板（上游 `ReadTipConfig.effectiveTemplate`）
 *
 * ⚠️ 面板里「留空 = 用上面选的内容的默认模板」—— 但输入框清空后存的是**空串**（不是 null），
 *  `??` 会把空串当成「有模板」⇒ 该信息位永远渲染成空白，切换「内容」选项也看不到变化。
 *  这里按**去空白后是否为空**判定，空串/纯空格一律回落到默认模板。 */
function tipText(tip: number, tpl: string | null): string {
  const text = tpl && tpl.trim() ? tpl : readTipDefaultTemplate(tip);
  if (!text) return '';
  return renderReaderInfoTemplate(text, readerInfoValues.value);
}

const headerTip = computed(() => ({
  left: tipText(r.readStyle.tipHeaderLeft, r.readStyle.tipHeaderLeftTemplate),
  middle: tipText(r.readStyle.tipHeaderMiddle, r.readStyle.tipHeaderMiddleTemplate),
  right: tipText(r.readStyle.tipHeaderRight, r.readStyle.tipHeaderRightTemplate),
}));
const footerTip = computed(() => ({
  left: tipText(r.readStyle.tipFooterLeft, r.readStyle.tipFooterLeftTemplate),
  middle: tipText(r.readStyle.tipFooterMiddle, r.readStyle.tipFooterMiddleTemplate),
  right: tipText(r.readStyle.tipFooterRight, r.readStyle.tipFooterRightTemplate),
}));

/** 页眉可见性：`2` 隐藏 / `1` 始终显示 / `0` 自动（向下滚动阅读时收起） */
const headerVisible = computed(() => {
  if (!r.chapter) return false;
  const m = r.readStyle.headerMode;
  if (m === 2) return false;
  if (m === 1) return true;
  /**
   * ★★ `#811`/`#825` **分页模式下页眉常显**（`0` 档不自动隐藏）。
   *
   * 「自动隐藏」是**滚动语义**（向下滚过 40px 收起，见 `onPageScroll`）。分页模式没有纵向滚动，
   * `scrolledDown` 只是「翻到第 2 页」的副作用（`gotoPage` 写着 `n > 1`）。
   * 若在分页里按它收页眉，`.rd-tip-off` 从占位变 `display:none` ⇒ `.se-body` 可用高突变
   * ⇒ 触发一轮重建并改页高（`#811` 实测：按 → 后页码变 2/11 但视觉停在第 1 页，
   * 用户看到的就是「翻页失效」）。⇒ 页眉高度稳定 = 页高稳定，翻页才可靠。
   */
  if (pagedActive.value) return true;
  return !scrolledDown.value;
});
/** 页脚可见性：`0` 显示 / `1` 隐藏（上游 `getFooterModes`） */
const footerVisible = computed(() => !!r.chapter && r.readStyle.footerMode !== 1);

onMounted(() => {
  // ★ `#144`：进入阅读 = 阅读时长开始计时（离开/关页/翻章各自结算，见 stores/reader.ts）
  r.beginReadSession();
  tipClockTimer = window.setInterval(() => {
    tipClock.value = new Date();
  }, 30_000);
  void (async () => {
    try {
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
      if (typeof nav.getBattery !== 'function') return;
      const b = await nav.getBattery();
      tipBattery.value = Math.round((b.level ?? 0) * 100);
    } catch {
      tipBattery.value = null;
    }
  })();
  window.addEventListener('keydown', onKey);
  // `#811` 逃生口：**捕获阶段**（第三个参数 true）—— 优先于 `onKey` 与所有菜单的冒泡监听
  window.addEventListener('keydown', onForceScrollKey, true);
  document.addEventListener('selectionchange', onSelectionChangeThrottled);
  // ★ 捕获阶段监听：子元素 stopPropagation 也拦不住（选区/菜单的收放必须可靠）
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('mouseup', onDocMouseUp, true);
  window.addEventListener('scroll', hideSelMenu, true);
  window.addEventListener('resize', onReaderResize);
  // ★ `#224` 分页：**列数会因容器尺寸变化而变**（窗口改大小、最大化切换、正文边距改动）
  //   ⇒ 必须重算。`ResizeObserver` 观察列容器本身（比 window.resize 准：
  //   面板被父级改宽时 window 未必触发，但 ResizeObserver 一定触发）。
  if (typeof ResizeObserver === 'function' && pageBodyEl.value) {
    pageRO = new ResizeObserver(() => {
      // `#825`：容器尺寸变了 ⇒ 重排（`schedulePagedRebuild` 内部 120ms 节流 + 签名去重）。
      // ⚠️ `#811` **详情页不参与分页**（`pagedActive` 只在有 `r.chapter` 时为真），
      //   否则「偏好=分页 + 详情页」会让这里的测量对上 `overflow-y:hidden` 的详情容器。
      // ⚠️ 正在量时**不打断**（只记「完成后再来一次」，见 `rebuildWhileBusy`）。
      if (pagedActive.value) schedulePagedRebuild(120);
    });
    pageRO.observe(pageBodyEl.value);
  }
  // `#825` 字体晚到会让切点偏移 ⇒ `document.fonts.ready` 之后补一次**强制**重建。
  // ★ 只在「现有布局是字体到位**之前**量的」才补：否则每次进入都白跑一整轮（实测 400ms+），
  //   正好赶在用户刚翻第一两页时收尾，把页码按旧锚点拉回去。
  const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  if (fontsReady) {
    void fontsReady.then(() => {
      fontsReadyDone = true;
      if (pagedActive.value && paged.ready.value && !builtAfterFonts) schedulePagedRebuild(0, true);
    });
  }
  // `#825` 偏好切换（滚动 ↔ 分页）必须**立即**重建 / 立即取消在途重建。
  // ★ 注册在 `onMounted`（而不是 setup 顶部）：`pagedActive` 依赖下面才声明的 `isHtmlChapter`，
  //   在 setup 阶段求值会撞 TDZ。
  watch(pagedActive, (on) => {
    // `#829` 切模式时清掉在途的「上一章末页」落点（否则它会卡住后续的上一页按钮）
    pendingTailFor.value = null;
    clearFlip(); // `#830` 切模式也清掉翻页动画角色
    if (on) {
      curPage.value = 1;
      schedulePagedRebuild(0, true);
    } else {
      pendingPagedJump = null; // `#845` 离开分页 ⇒ 排队中的书签跳转作废
      paged.reset();
      curPage.value = 1;
    }
  });
});
onBeforeUnmount(() => {
  // ★ `#144`：离开阅读 = 结算时长并停表
  r.endReadSession();
  pendingTailFor.value = null; // `#829` 卸载时清掉在途落点
  // `#432`：组件卸载也要解锁背景滚动（否则整站从此滚不动）
  releaseBodyScrollLock();
  if (tipClockTimer) window.clearInterval(tipClockTimer);
  clearFlip(); // `#830` 卸载时清掉翻页动画的 timer
  infResetState(); // `#833` 卸载：作废拼接章与在途预取（避免落到已关闭的浮层）
  pageRO?.disconnect();
  pageRO = null;
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keydown', onForceScrollKey, true);
  // `#459`：Esc 的监听在 esc-layer 里（组件卸载时一并出栈，避免悬空回调）
  popEsc?.();
  popEsc = null;
  document.removeEventListener('selectionchange', onSelectionChangeThrottled);
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('mouseup', onDocMouseUp, true);
  window.removeEventListener('scroll', hideSelMenu, true);
  window.removeEventListener('resize', onReaderResize);
});

/** `#224` 窗口尺寸变化 ⇒ 重新分页（列宽变了，列数与步进都变了） */
let pageRO: ResizeObserver | null = null;

/**
 * `#825` 尺寸/排版变化 ⇒ **重排**（不是「重算列数」）。
 *
 * 锚点策略变了：旧版要拿「当前页第一个可见段落 → 列容器左缘距离」再二分回列号；
 * 现在页是**测量切出来的**，重建时 `runPagedRebuild` 直接记住「当前页第一段」，
 * 重建完按段落查页码 —— 不需要任何 rect 参与，也不会有「差几像素」。
 */
function onReaderResize(): void {
  // 滚动模式的几何完全由 CSS 三段布局 + 滚动回调自持 ⇒ 只有分页要重排
  if (!pagedActive.value) return;
  schedulePagedRebuild(120);
}

/** `#224` 视图模式切回来/切出去 ⇒ 回到第 1 页（两种模式的几何完全不同） */
watch(
  () => r.viewMode,
  async (mode) => {
    // `#811`：**判据统一走 `pagedActive`**（= 偏好是分页 **且** 真的在阅读）。
    // `#825`：切走就先取消在途重建（否则旧布局会在切回滚动之后才落地）；
    //        切进来立刻重建（`schedulePagedRebuild(0, true)`）。
    paged.cancel();
    pendingTailFor.value = null; // `#829` 切模式清掉在途落点
    clearFlip(); // `#830` 视图模式切换：结束任何在途翻页动画角色
    infResetState(); // `#833` 切视图 ⇒ 作废拼接章与在途预取
    curPage.value = 1;
    if (pageBodyEl.value) pageBodyEl.value.scrollTop = 0;
    if (mode === 'paged' && pagedActive.value) schedulePagedRebuild(0, true);
    else void nextTick(() => { updateProgress(); infOnScroll(); });
  },
);

/**
 * `#833` 开关切换：关 ⇒ 立刻回到「章末即停」的既有行为（清拼接章，不改变滚动位置）；
 * 开 ⇒ 立即按当前视口判定一次（用户可能正停在章末，不应等下一次滚动才接续）。
 */
watch(
  () => r.infiniteScroll,
  () => {
    infResetState();
    if (infiniteActive.value) void nextTick(infOnScroll);
  },
);

/**
 * `#825` 排版量 / 正文内容变化 ⇒ 重建。
 *
 * 覆盖用户能改的所有排版量（字号、行距、段距、字重、字体、四边距、标题样式），
 * 以及替换规则/简繁转换导致的正文变化（签名里带文本哈希，长度相同也能认出来）。
 * `schedulePagedRebuild` 自己节流（120ms）+ 签名去重（没变就不量）。
 */
watch(
  [
    () => r.readerStyleVars,
    () => r.displayParagraphs,
    () => r.displayTitle,
    () => r.chapterIdx,
    () => r.chapter?.title,
  ],
  () => {
    // `#829` 用户经目录/书签跳到别的章 ⇒ 放弃在途的「上一章末页」落点（否则会一直卡着防重入）
    if (pendingTailFor.value !== null && pendingTailFor.value !== r.chapterIdx) pendingTailFor.value = null;
    // `#830` 换章 / 排版变化 ⇒ 清掉翻页动画角色（新页不继承旧动画规格）
    clearFlip();
    if (pagedActive.value) schedulePagedRebuild(120);
  },
);
</script>

<template>
  <!-- `#459`：去掉「点遮罩关闭」—— 只能由「关闭」按钮 / Esc（且只退当前层）关闭 -->
  <div
    class="se-mask" v-if="r.open"
    :class="{ maxed: maximized, 'rd-view': !!r.chapter, 'se-mask-detail': !r.chapter || readerFromDetail, 'rd-small': inPageSmall, 'rd-small-mini': inPageSmall && smallTier === 'mini', 'rd-small-head-on': inPageSmall && smallHeadHover }"
    @mousemove="onSmallMouseMove($event)"
    @mouseleave="onSmallMouseLeave()"
  >
    <!-- ★ `#270` 样式作用域隔离（用户 2026-10-04）：详情态与阅读态共用这个浮层面板，
         而阅读底色/背景图/栏位色是**内联**铺在 .se-panel 上 ⇒ 改阅读样式详情页跟着变。
         现在只在**阅读态**（r.chapter 非空）挂载；详情态回落到 CSS 的 background: var(--bg-1)
         —— 对齐上游「详情是 BookInfoActivity、不吃阅读配色」的语义。
         ★ 为什么不动 DOM 结构（把详情页剥离成独立浮层）：详情/目录/缓存/媒体分流全在本组件
         （约 3500 行），剥离是大重构且全部阅读探针要回归；条件化绑定不改结构，将来真要剥离
         这层隔离照样成立。 -->
    <div
      class="se-panel"
      :style="r.chapter ? [r.readerBackdropVars, r.readerBarVars] : undefined"
      :class="{
        maxed: maximized,
        /* `#433` HTML 正文：面板给**确定高度**（见样式块 `.se-panel.rd-html-view`）——
           否则 `height:auto` 的面板与「撑满剩余高度的 iframe」互为依赖，会塌成一条。 */
        'rd-html-view': isHtmlChapter,
        'se-paged-host': pagedActive,
        'se-paged-edge-l': pagedActive && edgeFlash === -1,
        'se-paged-edge-r': pagedActive && edgeFlash === 1,
      }"
    >
      <!-- `#806` `D8`：顶部热区 —— 移入显示标题栏、移出 3 秒收起（只切 opacity，不改高度）。
           隐藏时整条 `pointer-events: none`，热区本身仍可接鼠标/点击（触屏点一下也能唤出）。 -->
      <div
        class="rd-head-dock"
        :class="{ 'rd-head-open': !headCollapsed }"
        @mouseenter="onHeadZoneEnter()"
        @mouseleave="onHeadZoneLeave()"
        @click="revealHead()"
      >
      <div class="se-head" :class="{ 'rd-head-hidden': headCollapsed }" :inert="headCollapsed ? true : undefined">
        <!-- 顶部左上角：正文视图**不放章节标题**；详情视图用固定文案「书籍详情」
             （用户 2026-10-23：原「书名-作者」去掉，书名/作者在信息区各占一行）。 -->
        <template v-if="!r.chapter">
          <strong>书籍详情</strong>
        </template>
        <!-- 5-4：书架里的书优先读**本地化**的详情/目录 ⇒ 明确告诉用户"这是本地数据、点刷新可重拉" -->
        <span v-if="r.detailFromCache" class="se-cachechip" title="详情与目录来自本地缓存；点「刷新」才会重新拉取">💾 本地数据</span>
        <!-- 加入书架：详情页已移到「分组」行（用户 2026-10-23）；正文页标题栏保留 -->
        <template v-if="r.chapter">
          <button v-if="!r.inCurrentShelf" class="btn mini" @click="openShelfDialog('add')">加入书架</button>
          <button v-else class="btn mini" @click="r.toggleShelf()">移出书架</button>
        </template>
        <span style="flex: 1"></span>
        <!-- 缓存进度（4-3 → `#207`）：后台跑，不挡阅读；任务统一由**下载中心**承载 -->
        <span v-if="cacheJob && (cacheJob.state === 'running' || cacheJob.state === 'queued')" class="rd-cachechip">
          ⬇ 缓存 {{ cacheJob.done + cacheJob.failed + cacheJob.skipped }}/{{ cacheJob.total }}<template v-if="cacheJob.failed">（失败 {{ cacheJob.failed }}）</template>
          <button class="rd-cachechip-stop" title="停止缓存" @click="dl.cancel(cacheJob.key)">✕</button>
        </span>
        <!-- ★ `#227` 详情页专属按钮：**不参与**显隐配置、**不收进「更多」**。
             `#583+` 用户 2026-10-23 改版：源名称 / 换源 / 加入书架 / 最大化 已移出标题栏
             （源与换源进信息区「来源」行；加入书架并进「分组」行），这里只留刷新 / 清缓存。 -->
        <template v-if="!r.chapter && !r.rssArticle">
          <button
            class="btn mini" data-tool-detail="refreshDetail" :title="refreshDetailHint"
            :disabled="refreshing || r.detailLoading" @click="onRefreshDetail()"
          >{{ refreshDetailLabel }}</button>
          <!-- `#516` 本书正文缓存用量（章数 + 估算占用）；口径与「🧹 清缓存」一致 -->
          <span
            v-if="bookCacheUsage" class="rd-cachechip" data-tool-detail="cacheUsage"
            title="本书正文缓存的章数与估算占用（IndexedDB 序列化后的字节数，非精确配额）"
          >💾 {{ bookCacheUsage.items }} 章 · {{ fmtCacheBytes(bookCacheUsage.bytes) }}</span>
          <!-- `#516` 只清这本书（正文 + 目录本地化），不影响其它书 -->
          <button
            class="btn mini" data-tool-detail="clearCache"
            title="清理本书的本地缓存（正文 + 目录本地化）；没有缓存时跳过"
            @click="onClearBookCache()"
          >🧹 清缓存</button>
          <!-- `#620` 导出本书（txt / epub）；取正文优先读缓存，净化复用阅读链路同一份实现 -->
          <button
            class="btn mini" data-tool-detail="exportBook"
            :disabled="!r.detail?.chapters?.length"
            :title="r.detail?.chapters?.length ? '导出 TXT / EPUB（可只导已缓存章节）' : '目录还没加载，无法导出'"
            @click="exportOpen = true"
          >⤓ 导出</button>
          <!-- 书内备注（Legado `BookMemo`；随书进入两种备份） -->
          <button
            class="btn mini" data-tool-detail="memo"
            :disabled="!r.currentKey"
            title="书内备注 / 书评 / 摘抄"
            @click="memoOpen = true"
          >📝 备注</button>
        </template>
        <!-- 可配置的按钮（**仅正文页**；哪些常显由「更多 → 按钮显示设置」决定，没常显的仍在「更多」里） -->
        <template v-else>
          <button
            v-for="t in pinnedTools" :key="t.id"
            class="btn mini"
            :class="{
              primary:
                (t.id === 'readAloud' && al.active) ||
                (t.id === 'replace' && r.replaceEnabled),
            }"
            :title="t.id === 'refresh' ? refreshContentHint : toolTitle(t)"
            :data-tool="t.id"
            :data-al-open="t.id === 'readAloud' ? '' : undefined"
            :disabled="
              (t.id === 'refresh' && (refreshing || r.detailLoading)) ||
              (t.id === 'readAloud' && (isMedia || isComic))
            "
            @click="runTool(t.id)"
          >{{ toolLabel(t) }}</button>
        </template>
        <!-- 固定（不支持显隐）：目录 / 最大化 / 关闭（**「更多」只属于正文页**） -->
        <button
          class="btn mini" v-if="r.chapter && !r.rssArticle"
          title="目录 / 书签（从右侧滑入，含正倒序与筛选）" @click="openSide('toc')"
        >☰ 目录</button>
        <!-- `#568` 站点定制：只在「当前正文有真实来源页」时出现（纯本地书/JSON 内容没有域名可配）。
             放在「最大化」之前 —— 与「刷新正文」同属「针对当前这一页」的动作区。 -->
        <button
          v-if="siteHost"
          class="btn mini" data-tool-site
          :class="{ primary: !!siteCfg && (siteCfg.css || siteCfg.js || siteCfg.readerMode) }"
          :title="siteCfg ? `站点定制（已生效：${siteHost}）` : `给 ${siteHost} 加 CSS/JS 与阅读模式`"
          @click="siteDlgOpen = true"
        >🎨 定制</button>
        <!-- 最大化（用户 2026-09-28）：浮层铺满整个界面（不是全屏 API），正文宽度不变。
             `#583+`：详情页标题栏不再提供（用户 2026-10-23），阅读界面保留。 -->
        <button
          v-if="r.chapter"
          class="btn mini" :title="maximized ? '还原窗口大小' : '最大化：铺满整个界面（正文宽度不变）'"
          @click="toggleMax()"
        >{{ maximized ? '⧉ 还原' : '⛶ 最大化' }}</button>
        <!-- B18 小窗模式（桌面三态）：正常 → 小窗·常规(420×320) → 小窗·迷你(240×180)。
             两档小窗里 `rd-small-keep` 是标题栏唯一保留的控件组：阅读导航 / 切档 / 退出 / 关闭。
             Web 端同一入口 = 页内「小窗阅读」浮窗（无系统级窗口），入口默认收在「更多」里。 -->
        <template v-if="r.chapter && !r.rssArticle">
          <!-- 小窗·阅读：小窗里不朗读，只留「换章 / 目录 / 进度 / 字号」这些阅读动作。
               迷你档由 CSS 隐藏进度与字号（240×180 只放得下换章 + 目录 + 切档 + 退出 + 关闭）。 -->
          <span v-if="inPageSmall" class="rd-small-nav rd-small-keep" data-small-nav>
            <button
              class="btn mini rd-small-navbtn" data-small-ch-prev title="上一章"
              :disabled="r.chapterIdx <= 0" @click="r.chOffset(-1)"
            >⏮</button>
            <button
              class="btn mini rd-small-navbtn" data-small-ch-next title="下一章"
              :disabled="r.chapterIdx >= totalCh - 1" @click="r.chOffset(1)"
            >⏭</button>
            <button class="btn mini rd-small-navbtn" data-small-toc title="目录 / 书签" @click="openSide('toc')">☰</button>
            <span class="rd-small-pct" data-small-progress :title="`章节 ${r.chapterIdx + 1}/${totalCh} · 总进度 ${totalPctText}`">{{ totalPctText }}</span>
            <button class="btn mini rd-small-navbtn rd-small-font" data-small-font title="字号 / 阅读样式" @click="readStyleOpen = true">A</button>
          </span>
          <button
            v-if="inPageSmall"
            class="btn mini rd-small-keep" data-small-tier
            :title="smallTierHint" :disabled="smallBusy"
            @click="switchSmallTier()"
          >{{ smallTierButton.icon }}<span class="rd-small-label"> {{ smallTierButton.text }}</span></button>
          <!-- 默认只在「更多」菜单里（用户 2026-11-08：迷你条入口收到更多菜单）；
               想让它在标题栏常显时，用「按钮显示设置」里的同名开关把它钉回来。 -->
          <button
            v-else-if="miniPin"
            class="btn mini" data-small-toggle
            :title="smallEntryHint" :disabled="smallBusy"
            @click="toggleSmallWindow()"
          >{{ smallEntryLabel }}</button>
          <button
            v-if="inPageSmall"
            class="btn mini rd-small-keep" data-small-exit
            title="退出小窗模式，恢复正常窗口（Esc 同效）"
            @click="exitSmallWindow()"
          >⤢<span class="rd-small-label"> 退出</span></button>
        </template>
        <!-- ★ `#229`：按钮与菜单包在 `position:relative` 的容器里 ——
             菜单 `right:0` 的基准就是**这枚按钮** ⇒ 右缘精确对齐。
             （挂在面板下时基准是**满宽面板**，`right:12px` 会贴到窗口最右边 —— 用户 2026-10-03 报的偏移） -->
        <span class="rd-more-wrap">
          <button v-if="r.chapter && !r.rssArticle" class="btn mini" title="更多（没常显的按钮都收在这里）" @click="openMoreMenu()">⋯ 更多</button>
          <!-- 「更多」菜单（`#221`）：**只在正文页存在** —— 详情页连这个 DOM 都不生成（`#227`）；
               `#399` RSS 文章会话也不生成（工具栏已精简，无需「按钮显示设置」） -->
          <div v-if="moreOpen && r.chapter && !r.rssArticle" class="rd-more" @mouseleave="moreOpen = false">
            <button
              v-for="t in READER_TOOLS" :key="t.id" class="rd-more-item" :data-more="t.id"
              :title="toolTitle(t)"
              :disabled="t.id === 'readAloud' && (isMedia || isComic)"
              @click="runTool(t.id)"
            >
              <span class="rd-more-icon">{{ t.icon }}</span>
              <span>{{ t.label }}</span>
              <span v-if="toolPins[t.id]" class="rd-more-pin" title="已显示在标题栏">📌</span>
              <!--
                `#254` / `#260`：替换净化是**开关**而非动作 ⇒ 必须显示当前是「开」还是「关」，
                否则用户点完不知道自己处在哪个状态（这类「看不出状态」的开关最容易误判成没生效）。
                ★ `#260` 起它是**本书级**的 ⇒ 状态写「本书 · 开 / 跟随全局」，
                  不写清就会被当成全局开关（用户关一次发现别的书也变了，或反之）。
              -->
              <span
                v-else-if="t.id === 'replace'" class="rd-more-state"
                :class="{ on: r.replaceEnabled }"
                :data-replace-state="r.replaceEnabled ? 'on' : 'off'"
                :data-replace-scope="r.currentBookUseReplaceRule == null ? 'global' : 'book'"
              >{{ r.currentBookUseReplaceRule == null ? '跟随全局' : (r.replaceEnabled ? '本书 · 开' : '本书 · 关') }}</span>
            </button>
            <!-- B18 用户 2026-11-08：小窗阅读入口从标题栏收到「更多」菜单，并把当前状态写在行尾。
                 ★ 只有一个入口（三档在浮窗内部切），不再并列两个同名功能。 -->
            <button
              class="rd-more-item" data-more-small
              :title="smallEntryHint" :disabled="smallBusy"
              @click="onSmallMenuClick()"
            >
              <span class="rd-more-icon">🪟</span>
              <span>小窗阅读</span>
              <span
                class="rd-more-state" :class="{ on: smallEntryOn }"
                :data-small-state="smallEntryOn ? 'on' : 'off'"
              >{{ smallEntryOn ? '已开启' : '关闭' }}</span>
            </button>
            <!-- 歌词浮窗入口 2026-11-08 已迁到「朗读控制条 → 设置面板」（见 ReadAloudBar
                 的「歌词浮窗」开关 +「歌词响应设置」），这里不再保留第二入口。 -->
            <button class="rd-more-item rd-more-setting" @click="moreOpen = false; toolSettingsOpen = true">
              <span class="rd-more-icon">⚙</span><span>按钮显示设置</span>
            </button>
            <!-- `#513b` 用户指定位置：源名称在「更多」菜单里「按钮显示设置」的**下方**
                 （不是点开设置面板后的最下面）。太长自动截断，悬浮显示完整；点击跳规则工坊。 -->
            <button
              v-if="curSourceName"
              class="rd-more-item"
              :title="`书源：${curSourceName}（点击打开规则工坊）`"
              @click="moreOpen = false; openSourceWorkshop()"
            >
              <span class="rd-more-icon">📚</span>
              <span style="max-width: 11em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ curSourceName }}</span>
            </button>
          </div>
        </span>
        <!-- `#370`：关闭 = 退当前最上层（正文层开着 → 回详情页；详情页 → 整关回发现页）。
             「网页即正文」会话（`r.webDoc`，openWeb 合成详情）无详情层可退 → 直接整关。 -->
        <button class="btn mini rd-small-keep" data-small-close @click="closeFromButton()">关闭</button>
      </div>
      </div>
      <!-- 按钮显隐设置（`#221`）：**只渲染正文页自己的按钮**（`#227`）——
           详情页专属的「刷新详情」不参与显隐，它不在这份名单里，也不出现在任何浮层里。
           ⚠️ 条件里带上 `r.chapter`：用户报过「关掉正文页再回来，设置浮层还挂着」，
           根因是正文页关闭走 `reset()`（`r.open` 仍为 true）⇒ 浮层不卸载。 -->
      <div v-if="toolSettingsOpen && r.chapter" class="rd-toolset-mask" @click.self="toolSettingsOpen = false">
        <div class="rd-toolset">
          <div class="rd-toolset-head">
            <strong>标题栏按钮显示设置</strong>
            <button class="rd-toolset-x" title="关闭" @click="toolSettingsOpen = false">✕</button>
          </div>
          <p class="rd-toolset-hint">关掉的按钮<b>不会消失</b> —— 它们收进「更多」菜单，照样能点到。</p>
          <!-- `#806` `D8`：标题栏整条显隐的开关（与上面的「按钮是否常显」是两件事，互不影响） -->
          <label class="rd-toolset-row rd-toolset-row-autohead">
            <span>🕶 标题栏鼠标移出 3 秒后自动收起（移入顶部即显示；触屏不启用）</span>
            <button
              class="rd-switch" :class="{ on: headAutoHide }" role="switch"
              :aria-checked="headAutoHide" data-toolset="headAutoHide"
              @click="toggleHeadAutoHide()"
            ><span class="rd-knob"></span></button>
          </label>
          <!-- B18：小窗阅读入口默认收在「更多」菜单；这个开关只决定它要不要**再显示在标题栏** -->
          <label class="rd-toolset-row">
            <span>小窗阅读</span>
            <button
              class="rd-switch" :class="{ on: miniPin }" role="switch"
              :aria-checked="miniPin" data-toolset="miniPin"
              @click="toggleMiniPin()"
            ><span class="rd-knob"></span></button>
          </label>
          <label v-for="t in READER_TOOLS" :key="t.id" class="rd-toolset-row">
            <span>{{ t.icon }} {{ t.label }}</span>
            <button
              class="rd-switch" :class="{ on: toolPins[t.id] }" role="switch"
              :aria-checked="toolPins[t.id]" :data-toolset="t.id"
              @click="toggleToolPin(t.id)"
            ><span class="rd-knob"></span></button>
          </label>
        </div>
      </div>
      <!-- ★ `#230` 滚动容器 = 「页眉 + 正文 + 页脚」这一段（**标题栏在它外面，不参与滚动**）。
           用户 2026-10-03 的要求：「标题栏独立，这个滚动条应该是页面的：即(页眉+正文+页脚)的」，
           并且**阅读界面宽度回到 `#222` 之前**（浮层恢复窄卡片，滚动条贴在浮层右缘）。 -->
      <!--
        ★★ `#249` **背景挂在 `.se-panel`**（页眉 + 正文 + 页脚三层共用），`.rd-content` 透明。
        上游等价物：`PageView.kt:329-336` 把 LayerDrawable 挂在 `vwRoot`，
        而 `ll_header`/`ll_footer` 自身无 background ⇒ 透明透图。
        ★★ `#250` 两处修正（`:style` 绑在**外层 `.se-panel`** 上，不是 `.se-scroll`）：
          ① **标题栏（`.se-head`）也铺图** —— 用户 2026-10-04：「顶端标题栏也应铺图，也应透明」。
             做法：背景层从 `.se-scroll` **上移到 `.se-panel`**（标题栏的父级），
             `.se-head` 与 `.se-scroll` 都改透明 ⇒ 图铺满「标题栏 + 页眉 + 正文 + 页脚」整个界面。
             顺带把 `--rd-bar-*` 一起挂这里（栏位在**不透明**模式下要各自铺底色）。
          ② `bgAlpha` 现在**只作用背景图片**（`--rd-bg-img-alpha`，由 `.se-panel::before` 承载），
             底色 `background` 恒不透明 —— 见 store `readerBackdropVars` 的注释。
      -->
      <div class="se-scroll" ref="scrollEl" @scroll="onPanelScroll">
      <!-- ★ 页眉（`#221`/`#231`）：**常驻渲染**，自动隐藏时只切 `visibility`（**不卸载**）。
           ★ 为什么不能 `v-if`：页眉在滚动流里（sticky 也占高度）⇒ 卸载会改变 scrollHeight
           ⇒ 浏览器回调 scrollTop ⇒ 「是否向下滚动过 40px」判据翻转 ⇒ 又卸载 ⇒ **无限闪烁**
           （用户 2026-10-03 报「滚动条在某个高度时页眉不停闪烁」）。
           ⚠️ 滞回阈值治不了这个：高度一变 scrollTop 就变。
           只有「手动隐藏」（headerMode=2）才真正不渲染 —— 那个不频繁切换、不会触发这个环。 -->
      <ReaderTipBar
        v-if="r.readStyle.headerMode !== 2" zone="header"
        :class="{ 'rd-tip-off': !headerVisible }"
        :left="headerTip.left" :middle="headerTip.middle" :right="headerTip.right"
      />
      <div
        class="se-body"
        :ref="setBodyEl"
        :class="{
          'se-paged': pagedActive,
          'se-html': isHtmlChapter,
          'se-inf-scroll': infiniteActive,
          'se-comic-merge': comicMergeOn,
          'se-comic-fill': comicFill,
          [`se-paged-${pageAnim}`]: pagedActive,
          'se-flip-fwd': pagedActive && flip?.dir === 1,
          'se-flip-back': pagedActive && flip?.dir === -1,
        }"
        @click="pagedActive ? onPageAreaClick($event) : undefined"
        @contextmenu="onContentContextMenu($event)"
        @scroll.passive="onPageScroll"
        @wheel.passive="onAutoScrollUserInput"
        @touchstart.passive="onAutoScrollUserInput"
        @pointerdown="onAutoScrollUserInput"
      >
        <div v-if="r.detailErr" class="err-text" style="margin-bottom: 8px">{{ r.detailErr }}</div>

        <!-- 正文 -->
        <template v-if="r.chapter">
          <!-- ★ `#221`：**原来这里有一条 `.rd-toolbar`（上一章 / 书名·作者 / 搜索 / 样式 / 朗读 / 下一章）**
               已按用户 2026-10-03 的要求拆走：· 上一章/下一章 ⇒ 键盘左右箭头（`#222`）
               · 书名·作者 ⇒ **页眉**（可配模板、可隐藏）· 搜索/样式/朗读 ⇒ **顶端标题栏**（可配常显或收进「更多」） -->
          <!-- `#164`：标题是正文卡片的**兄弟**节点 ⇒ 变量要单独绑一次（用不含 background 的那组）。
               `#825`：分页时标题由第 1 页的切片自己渲染（测量里已计入高度）⇒ 这里不再重复渲染。
               `#835`：无限滚动开启时这个 h3 的**位置是错的** —— 它排在「上一章拼接段」之前，
               而当前章正文排在拼接段之后 ⇒ 滚到 4-5 章交界处时本章标题在上一章顶上（用户看到
               「向上滚标题消失」）。改到正文分支里、紧跟当前章 `.rd-content` 之前渲染。 -->
          <!-- `#841` 漫画三章拼接时标题由拼接列表自己渲染（每章一条分隔条）⇒ 这里不再重复 -->
          <h3 v-if="!pagedActive && !infiniteActive && !comicMergeOn" class="rd-chapter rd-book-title" :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }" :class="highlightClass(titleRuleStyle)">{{ r.displayTitle }}</h3>
          <!-- `#352`：**html 存在时正文分支优先**（`&& !r.chapter.html`）—— 引擎对「正文里提得到
               媒体直链、但页面没自带播放器」的源会 html + media 并存下发（嗅探语义），
               源规则的展示结果必须原样渲染，媒体只浮现嗅探按钮（见 html 分支的 .rd-sniff）。 -->
          <div v-if="isMedia && !r.chapter.html" class="rd-media">
            <!-- 音频源不走这里：`openChapter` 已被改道给全局浮窗播放器（见 script 里的 watch）。
                 这一段是防御性提示 —— 万一有时序让浮层先进了正文，用户也能一键转交。 -->
            <div v-if="r.detail?.kind === 'audio'" class="rd-media-go">
              <span>🎧 音频由右下角「浮窗播放器」播放（关掉本浮层也不会中断）</span>
              <button class="btn mini primary" @click="onTocClick(r.chapter, r.chapterIdx)">▶ 在浮窗播放本章</button>
            </div>
            <!-- 文件类：直接给下载/打开入口（浏览器不播 .zip/.txt 这类） -->
            <template v-else-if="r.detail?.kind === 'file' && r.chapter.media?.url">
              <a class="btn" :href="r.chapter.media.url" target="_blank" rel="noopener">下载 / 打开文件</a>
            </template>
            <!-- `#352` 视频 / m3u8（麻豆传媒AI 这类「文本源但正文是媒体直链」）：
                 **不再自动跳转、也不内嵌播放器** —— 入口统一交给**底部嗅探条**
                 （`.rd-sniff-dock`，见模板末尾）：点击**新开**播放浮窗（盖在阅读浮层上，
                 关闭即回本章正文；旧的「自动 openPlayerAt + reset」会替换掉阅读界面，
                 用户实测回不到正文）。★ 这里不再重复放一个按钮 —— 同一动作两处入口必然漂移。 -->
            <p v-else-if="!r.chapter.media?.url" class="err-text">未取到媒体地址</p>
            <details v-if="r.chapter.subContent" class="rd-sub">
              <summary>{{ r.detail?.kind === 'video' ? '弹幕' : '歌词 / 附加内容' }}</summary>
              <pre class="rd-sub-body">{{ r.chapter.subContent }}</pre>
            </details>
            <!-- 媒体分支的标题同样是「当前章节名」，`#164` 起也吃标题样式（`marginTop` 交给 `--rd-title-mt`） -->
            <p class="rd-chapter rd-book-title" :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }" :class="highlightClass(titleRuleStyle)">{{ r.displayTitle }}</p>
          </div>
          <!-- `#212` Step4：PDF 章 —— 前端用 pdfjs 把每页画到 canvas（与漫画的 `<img>` 是**两条**通路）。
               必须排在 `isComic` **之前**：PDF 书的 `kind` 也是 `image`，否则会先落进漫画分支，
               把 `/api/local-books/pdf-page?…` 当图片地址喂给 `<img>` ⇒ 全是破图。 -->
          <div v-else-if="isPdfChapter" class="rd-content rd-pdf" :key="'pdf-' + r.chapterIdx">
            <PdfPages :file-url="pdfFileUrl" :pages="pdfPageNumbers" />
          </div>
          <!-- `#841` 相邻三章拼成**同一条**扁平图片列表（当前 + 前章 + 后章），章节标题只作分隔条、
               不阻断滚动；`TEXT` / `PDF` 不参与（前者走 `v-else` 文本、后者在上面单独分支）。
               三章共用**同一个** `ComicImageQueue`（key = `章:图`，在飞 ≤3），不是三倍并发。
               双击 1x ↔ 3x、双指捏合 ≤3x；3x 下指针拖拽平移（`.zoomed` 见样式段）。 -->
          <div
            v-else-if="isComic" class="rd-content rd-comic"
            :class="{ single: comicStyle === 'SINGLE', zoomed: comicZoom > 1 }"
            :style="[r.readerStyleVars, comicZoom > 1 ? { '--rd-comic-zoom': String(comicZoom) } : {}]"
            @dblclick="onComicDblClick"
            @pointerdown="onComicPointerDown"
            @pointermove="onComicPointerMove"
            @pointerup="onComicPointerUp"
            @pointercancel="onComicPointerUp"
          >
            <template v-if="showImages">
              <!-- `#834` 每张图包一层占位：`IntersectionObserver` 观察它（`data-cch`+`data-ci`）决定
                   是否进预取窗口；宽高比优先用预取拿到的**真实值**（`comicDims`），未知时走 CSS 默认 2/3。
                   加载指示分「排队中 / 加载中」两档（并发上限 3），失败给「↻ 重新加载」。
                   DOM `<img>` 只在 `ok` 时挂载 ⇒ 预取已完成、命中 HTTP 缓存，入画不改变版面。 -->
              <template v-for="cv in comicChunks" :key="'cc' + cv.chIdx">
                <h3
                  v-if="cv.title" class="rd-chapter rd-book-title rd-comic-divider" :data-ccch="cv.chIdx"
                  :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }" :class="highlightClass(titleRuleStyle)"
                >{{ cv.title }}</h3>
                <div
                  v-for="(p, i) in cv.images" :key="cv.chIdx + ':' + i"
                  class="rd-imgwrap" :class="comicStatusOf(cv.chIdx, i)" :style="comicWrapStyle(cv.chIdx, i)"
                  :data-cch="cv.chIdx" :data-ci="i"
                >
                  <img
                    v-if="comicStatusOf(cv.chIdx, i) === 'ok'"
                    :src="comicUrlOf(cv.chIdx, i)" decoding="async" alt=""
                    @error="onComicDomError(cv.chIdx, i)"
                  />
                  <div v-if="comicStatusOf(cv.chIdx, i) === 'err'" class="rd-imgfail">
                    <span>第 {{ i + 1 }} 张加载失败</span>
                    <button class="btn mini" @click.stop="retryComicImg(cv.chIdx, i, p)">↻ 重新加载</button>
                  </div>
                  <div v-else-if="comicStatusOf(cv.chIdx, i) === 'loading' || comicStatusOf(cv.chIdx, i) === 'queued'" class="rd-imgload">
                    <span class="rd-spin"></span>第 {{ i + 1 }}/{{ cv.images.length }} 张{{ comicStatusOf(cv.chIdx, i) === 'queued' ? '排队中…' : '加载中…' }}
                  </div>
                </div>
              </template>
            </template>
            <!-- imageStyle=TEXT：不加载图片，仅按文本占位（对齐 Legado imgStyleText） -->
            <p v-else v-for="(p, i) in r.chapter.paragraphs" :key="'t' + i" class="rd-imgtext">[图] {{ p }}</p>
            <p v-if="!r.chapter.paragraphs?.length" class="err-text">本话图片加载为空</p>
          </div>
          <!-- `#308` **HTML 正文**（订阅源 / 影视聚合播放器 / 24凹凸图集）：
               必须是 `<iframe srcdoc>` —— `v-html` 只插 DOM、**不执行 `<script>`**，
               而这类正文的播放器/图集逻辑全在脚本里（上游也是交给 WebView 执行）。
               `sandbox` 给到 `allow-scripts`（要跑脚本）但**不给** `allow-same-origin`
               ⇒ 内容页拿不到本仓的 localStorage/cookie，也不碰得到父窗口（源站内容不受信）。
               `#446` 追加 `allow-downloads`：源自绘的「生成 HTML」（⬇️）按钮在缺这个 flag 时
               会被 Chrome **静默丢弃**下载（不报错、源侧仍判成功，用户看到弹窗却没文件）。
               位置与 `InAppBrowser` 的同名授权一致。 -->
          <div v-else-if="isHtmlChapter" class="rd-content rd-html" :key="'html-' + r.chapterIdx">
            <!-- `#355` **嗅探条已挪到面板底部**（常驻浮条，不随正文滚动）—— 见模板末尾的
                 `.rd-sniff-dock`。正文 iframe 照常渲染（源规则的展示结果**不变**）；
                 AGE动漫这类自带 `<iframe>` 播放页 / hls.js 播放器的源不会附带 media ⇒ 不出现。 -->
            <!-- `#335`/`#336` 页内导航条（「极简浏览器」）：只在**真的跳过一次**之后出现。
                 理由：没跳转时它就是一行无用的空壳，而正文区是阅读页最该留白的地方；
                 一旦从正文跳走，「返回正文」就成了唯一出路，此时必须可见（#247 教训）。 -->
            <div v-if="navStack.length > 1" class="rd-navbar">
              <button class="rd-nav-btn" :disabled="navIdx <= 0" title="后退" @click="navBack">←</button>
              <button class="rd-nav-btn" :disabled="navIdx >= navStack.length - 1" title="前进" @click="navForward">→</button>
              <button class="rd-nav-btn" :disabled="!curNavUrl || navLoading" title="重新加载本页" @click="navReload">⟳</button>
              <span class="rd-nav-url" :title="curNavUrl">{{ curNavUrl }}</span>
              <span v-if="navLoading" class="rd-nav-loading">加载中…</span>
              <span v-else-if="navErr" class="rd-nav-err" :title="navErr">{{ navErr }}</span>
              <button class="rd-nav-btn rd-nav-home" :disabled="navIdx <= 0" title="回到正文" @click="navIdx = 0">正文</button>
            </div>
            <!-- `#432` **不再按内容高度撑 iframe**（原因见样式块 `.se-body.se-html` 的注释）：
                 iframe 定高（= 正文格可见高）**自滚**，页面里的 vh/dvh 才有稳定基准。 -->
            <iframe
              ref="htmlFrame"
              class="rd-html-frame" :srcdoc="frameDoc"
              sandbox="allow-scripts allow-popups allow-forms allow-presentation allow-downloads"
              allowfullscreen referrerpolicy="no-referrer" title="正文"
            ></iframe>
          </div>
          <div
            v-else-if="pagedActive" class="se-paged-view" :key="'pg-' + r.chapterIdx"
            @pointerdown="onCurlPointerDown"
            @pointermove="onCurlPointerMove"
            @pointerup="onCurlPointerUp"
            @pointercancel="onCurlPointerUp"
          >
            <!-- `#825` 只渲染当前页（及前后各一页）：翻页改页码 → 每页 `translateX` 跟着变，
                 由 CSS 过渡完成动画。**没有滚动、没有列、没有 inline 尺寸**。 -->
            <div class="se-paged-track">
              <div
                v-for="pg in pagedViews" :key="pg.page"
                class="se-paged-page"
                :class="[pg.role ? 'se-pg-' + pg.role : '', { 'se-paged-current': pg.dx === 0, 'se-paged-last': pg.page === pageCount && !!r.chapter.subContent }]"
                :style="{ transform: pageTransform(pg.dx) }"
                :data-page="pg.page"
              >
                <div class="rd-content" :class="'rd-theme-' + r.readerColorSetName" :style="r.readerStyleVars">
                  <template v-for="cv in pg.chunks" :key="cv.key">
                    <!-- 章标题只出现在第 1 页（测量时已把它算进去，见 `paged-layout.ts`） -->
                    <h3
                      v-if="cv.title" class="rd-chapter rd-book-title"
                      :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }"
                      :class="highlightClass(titleRuleStyle)"
                    >{{ r.displayTitle }}</h3>
                    <template v-else>
                      <p
                        :data-p="cv.para" :data-p-start="cv.start || undefined"
                        :class="{ 'rd-p-cont': cv.cont, 'rd-speaking': cv.para === speakingPara }"
                      ><template v-if="cv.plain !== null">{{ cv.plain }}</template><template v-else><template v-for="(s, j) in (cv.items ?? [])" :key="j"><span v-if="!s.hl">{{ s.text }}</span><span v-else class="rd-hl" :class="[...highlightClass(s.st), { 'rd-hl-flash': s.flash }]" :style="highlightStyleVars(s.st)" @click.stop="onHighlightClick(s.h, $event)">{{ s.text }}</span></template></template><img
                        v-for="(m, mi) in (cv.paraEnd ? textMarksAt(cv.para) : [])" :key="'ui-t' + cv.para + '-' + mi"
                        :src="m.img" class="rd-ui-bubble" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                      /></p>
                      <!-- 段末整宽条（神评）只跟在这一段的**最后一片**后面，不会在跨页处重复 -->
                      <img
                        v-for="(m, mi) in (cv.paraEnd ? fullMarksAt(cv.para) : [])" :key="'ui-f' + cv.para + '-' + mi"
                        :src="m.img" class="rd-ui-bar" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                      />
                    </template>
                  </template>
                  <!-- 章末附加内容（歌词 / 弹幕）只在最后一页；它没参与测量 ⇒ 最后一页允许纵向自滚 -->
                  <template v-if="pg.page === pageCount">
                    <img
                      v-for="(m, mi) in endUiMarks" :key="'ui-e' + mi"
                      :src="m.img" class="rd-ui-bar rd-ui-end" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                    />
                    <details v-if="r.chapter.subContent" class="rd-sub">
                      <summary>附加内容</summary>
                      <pre class="rd-sub-body">{{ r.chapter.subContent }}</pre>
                    </details>
                  </template>
                </div>
              </div>
            </div>
            <!--
              `#849` 「仿真」档的卷曲覆盖层。
              · 卷曲期间 DOM **停在旧页**（页码在动画结束后才变，见 `finishPageCurl`）；
              · 组件常驻挂载（首次翻页后不再卸载），静置时用 `visibility:hidden` 隐藏；
              · `progress` 由 rAF 驱动，纹理是 `PageChunk` 切片重绘（不复制 DOM）。
            -->
            <div v-if="curlMounted" class="se-paged-curl" :class="{ 'se-paged-curl--on': curlOn }" aria-hidden="true">
              <PageCurl
                :front="curlFront" :back="curlBack" :next="curlNext"
                :progress="curlProgress" :direction="curlDir"
                :width="curlWidth" :height="curlHeight" :padding="0" :dpr="curlDpr"
                :grid="curlGrid"
              />
            </div>
            <div v-if="!pagedReady || pendingTailFor !== null" class="se-paged-wait">{{ pendingTailFor !== null ? '正在加载上一章…' : '排版中…' }}</div>
          </div>
          <!--
            正文（`#145`）：颜色与排版全部来自 prefs ⇒ 只绑 vars，不在 CSS 里写死主题色。

            `#833` 无限滚动：当前章前后各**拼接**一章相邻正文（`<section class="rd-content rd-inf-sec">`）。
            · 加载到「章末附近 / 章首附近」才拉，不是一次性把全书铺开；
            · 向上插入前会按「当前章 offsetTop 差值」补偿 `scrollTop`（见 `infLoad`）；
            · 用户读进拼接章后由 `infAdopt` 交接成当前章（目录/进度/页眉随之更新）。
          -->
          <template v-else>
            <!-- 上一章：加载中 / 失败重试 / 全书开头 -->
            <div v-if="infiniteActive && (infPrevLoading || infPrevErr || infPrevEdge)" class="rd-inf-edge rd-inf-top" data-inf-top>
              <template v-if="infPrevLoading"><span class="rd-inf-dot" aria-hidden="true"></span>正在加载上一章…</template>
              <template v-else-if="infPrevErr">
                <span>{{ infPrevErr }}</span>
                <button type="button" class="rd-inf-retry" data-inf-retry-prev @click="infRetry(-1)">重试</button>
              </template>
              <template v-else>已经是全书开头</template>
            </div>
            <section
              v-if="infiniteActive && infPrev"
              class="rd-content rd-inf-sec rd-inf-prev" :class="'rd-theme-' + r.readerColorSetName"
              :data-inf-idx="infPrev.idx" :key="'infp-' + infPrev.idx" :style="r.readerStyleVars"
            >
              <h3 class="rd-chapter rd-book-title" :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }" :class="highlightClass(titleRuleStyle)">{{ infPrev.title }}</h3>
              <!-- 用户 2026-11-10：拼接段也渲染源按钮 / **本章说**（与当前章同一套摆放规则）。
                   否则交接后旧章变拼接段，「本章说」会从 DOM 里消失；往回滚再交接回来才出现。 -->
              <template v-for="(text, i) in infPrev.paragraphs" :key="i">
                <p class="rd-inf-para" :data-inf-p="i">{{ text }}<img
                  v-for="(m, mi) in textMarksOf(infPrevMarks, i)" :key="'ui-t' + i + '-' + mi"
                  :src="m.img" class="rd-ui-bubble" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                /></p>
                <img
                  v-for="(m, mi) in fullMarksOf(infPrevMarks, i)" :key="'ui-f' + i + '-' + mi"
                  :src="m.img" class="rd-ui-bar" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                />
              </template>
              <img
                v-for="(m, mi) in (infPrevMarks.get(-1) ?? [])" :key="'ui-e' + mi"
                :src="m.img" class="rd-ui-bar rd-ui-end" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
              />
              <details v-if="infPrev.subContent" class="rd-sub">
                <summary>附加内容</summary>
                <pre class="rd-sub-body">{{ infPrev.subContent }}</pre>
              </details>
            </section>

            <!-- `#835` 当前章标题：必须紧跟在本章正文之前（上一章拼接段之后），
                 否则交界处本章标题会跑到上一章内容顶部，向上滚时「标题消失」。 -->
            <h3
              v-if="infiniteActive"
              class="rd-chapter rd-book-title"
              :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }"
              :class="highlightClass(titleRuleStyle)"
              data-inf-cur-title
            >{{ r.displayTitle }}</h3>

            <div
              class="rd-content" data-inf-current :class="['rd-theme-' + r.readerColorSetName, pageAnimClass]"
              :key="'ch-' + r.chapterIdx" :style="r.readerStyleVars"
            >
            <!-- `#146`：正文按「普通/高亮」交替分段渲染（`data-p` 是选区 → 偏移的寻址依据）；
                 该段没有高亮时走 `plain`，输出纯文本、不多包 span -->
            <!-- `#583`：段落里的源按钮（段评气泡）放在 `<p>` **末尾**——没有文本节点，不影响划词偏移；
                 整宽条（神评）在段后，本章说/书评在章末。 -->
            <template v-for="seg in hlSegments" :key="seg.para">
              <p :data-p="seg.para" :class="{ 'rd-speaking': seg.para === speakingPara }"><template v-if="seg.plain !== null">{{ seg.plain }}</template><template v-else><template v-for="(s, j) in seg.items" :key="j"><span v-if="!s.hl">{{ s.text }}</span><span v-else class="rd-hl" :class="[...highlightClass(s.st), { 'rd-hl-flash': s.flash }]" :style="highlightStyleVars(s.st)" @click.stop="onHighlightClick(s.h, $event)">{{ s.text }}</span></template></template><img
                v-for="(m, mi) in textMarksAt(seg.para)" :key="'ui-t' + seg.para + '-' + mi"
                :src="m.img" class="rd-ui-bubble" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
              /></p>
              <img
                v-for="(m, mi) in fullMarksAt(seg.para)" :key="'ui-f' + seg.para + '-' + mi"
                :src="m.img" class="rd-ui-bar" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
              />
            </template>
            <img
              v-for="(m, mi) in endUiMarks" :key="'ui-e' + mi"
              :src="m.img" class="rd-ui-bar rd-ui-end" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
            />
            <!-- 副内容（ContentRule.subContent）：歌词 / 弹幕 / 附加段落 -->
            <details v-if="r.chapter.subContent" class="rd-sub">
              <summary>附加内容</summary>
              <pre class="rd-sub-body">{{ r.chapter.subContent }}</pre>
            </details>
            </div>

            <!-- 下一章：加载中 / 失败重试 / 全书结尾 -->
            <div v-if="infiniteActive && (infNextLoading || infNextErr || infNextEdge)" class="rd-inf-edge rd-inf-bottom" data-inf-bottom>
              <template v-if="infNextLoading"><span class="rd-inf-dot" aria-hidden="true"></span>正在加载下一章…</template>
              <template v-else-if="infNextErr">
                <span>{{ infNextErr }}</span>
                <button type="button" class="rd-inf-retry" data-inf-retry-next @click="infRetry(1)">重试</button>
              </template>
              <template v-else>已经是最后一章</template>
            </div>
            <section
              v-if="infiniteActive && infNext"
              class="rd-content rd-inf-sec rd-inf-next" :class="'rd-theme-' + r.readerColorSetName"
              :data-inf-idx="infNext.idx" :key="'infn-' + infNext.idx" :style="r.readerStyleVars"
            >
              <h3 class="rd-chapter rd-book-title" :style="{ ...r.readerTitleVars, ...highlightStyleVars(titleRuleStyle) }" :class="highlightClass(titleRuleStyle)">{{ infNext.title }}</h3>
              <!-- 同上一章拼接段：源按钮 / 本章说 一并渲染（用户 2026-11-10） -->
              <template v-for="(text, i) in infNext.paragraphs" :key="i">
                <p class="rd-inf-para" :data-inf-p="i">{{ text }}<img
                  v-for="(m, mi) in textMarksOf(infNextMarks, i)" :key="'ui-t' + i + '-' + mi"
                  :src="m.img" class="rd-ui-bubble" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                /></p>
                <img
                  v-for="(m, mi) in fullMarksOf(infNextMarks, i)" :key="'ui-f' + i + '-' + mi"
                  :src="m.img" class="rd-ui-bar" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
                />
              </template>
              <img
                v-for="(m, mi) in (infNextMarks.get(-1) ?? [])" :key="'ui-e' + mi"
                :src="m.img" class="rd-ui-bar rd-ui-end" :title="m.label" alt="" @click.stop="onUiMarkClick(m)"
              />
              <details v-if="infNext.subContent" class="rd-sub">
                <summary>附加内容</summary>
                <pre class="rd-sub-body">{{ infNext.subContent }}</pre>
              </details>
            </section>
          </template>

          

          <!--
            `#224` **分页翻页控件**：左右两枚按钮 + 居中页码。
            ★ 为什么常驻而不是 hover 才出：分页模式下「能不能往前翻」是**当前位置**决定的
              （第 1 页时左箭头就是灰的），常驻才能让用户一眼看到边界在哪。
            ★ 它是 `.se-body` 里的**绝对定位浮层**（不占流式布局，也不进测量）：
              正文可用高在 `buildPagedInput()` 里已扣掉 `PAGED_NAV_RESERVE`，不会被它盖住。
          -->
          <div v-if="pagedActive && !isComic" class="se-paged-nav" data-page-nav>
            <button
              class="se-paged-arrow" data-page-prev
              :title="curPage <= 1 && r.chapterIdx > 0 ? '上一页（←）：首页再往前 = 上一章末页' : '上一页（←）'"
              @click="onPagePrevClick"
            >‹</button>
            <span class="se-paged-num" data-page-label>{{ curPage }} / {{ pageCount }}</span>
            <button
              class="se-paged-arrow"
              :disabled="curPage >= pageCount && r.chapterIdx >= totalCh - 1"
              data-page-next
              :title="curPage >= pageCount ? '最后一页（往后接下一章）' : '下一页（→）'"
              @click="onPageNextClick"
            >›</button>
          </div>
        </template>

        <!-- 详情 + 目录 -->
        <!-- `#344`：`directRead`（RSS 卡片直达阅读）期间**不铺详情页** —— 只有「加载中…」
             （下面的 `v-if="r.contentLoading || r.detailLoading"` 那条），首章到位即切正文，
             避免「卡片 → 详情页 → 阅读页」的两跳观感。 -->
        <template v-else-if="r.detail && !r.directRead">
          <!-- `#583+` 详情页三区布局（用户 2026-10-23）：
               上区 = 封面(1) : 信息(2)；中区 = 简介（默认 200 字，可展开，宽 70% 居中）；下区 = 目录。
               `det-wrap` 让三区整体再向中间收 10px（用户要求离界面边缘更远一点）。 -->
          <div class="det-wrap">
          <div class="det-top">
            <div class="det-cover">
              <CoverImage
                :cover="r.detail.cover"
                :source-id="r.sourceId"
                :title="r.detail.title"
                :author="detailAuthor"
              />
            </div>
            <div class="det-fields">
              <div class="det-name-row">
                <!-- `#585` 书名也可点（Legado 约定 `clickBookName`；服务端从源 `ruleContent.callBackJs`
                     取脚本，前端不持有源 raw）。原实现**书名的绑定漏做了**，用户 10-23 实测报的。
                     `#591` 用户 10-24 复测三点：① 提示文案那一行删掉（书名的 hover tooltip 已足够）；
                     ② hover 下划线改 **dotted**（实下划线太重）；
                     ③ ★ **可点区域不许扩充到文字以外** —— 所以点击/hover 挂在**内层
                     `.det-name-text`**（`inline-block` ⇒ 盒宽 = 文字实宽）上，外层 `.det-name`
                     只负责占满剩余宽度并做超长截断（原来两者是同一个元素 ⇒
                     `flex:1 1 auto` 让「书名与 📌 按钮之间的整条空白」都可点）。 -->
                <div class="det-name">
                  <!-- `#593` 完整书名走原生 tooltip（书名不换行、超长截断 ⇒ 必须有回看途径） -->
                  <span
                    class="det-name-text"
                    :class="{ 'det-name-link': sourceUiCustomButton }"
                    :title="r.detail.title"
                    @click="sourceUiCustomButton && openSourceUi({ event: 'clickBookName', title: '书评' })"
                  >{{ r.detail.title }}</span>
                </div>
                <!-- `#583` 源的 customButton：源脚本的自定义动作（七猫：书评）；用户要求回到书名右侧 -->
                <button
                  v-if="sourceUiCustomButton" class="btn mini det-review" :disabled="sourceUiBusy"
                  title="源脚本的定制按钮（Legado customButton；七猫为书评）"
                  @click="openSourceUi({ event: 'clickCustomButton', title: '书评' })"
                >📌 书评</button>
              </div>
              <div class="det-row"><b>作者：</b><span :title="detailAuthor">{{ detailAuthor }}</span></div>
              <div class="det-row">
                <b>来源：</b>
                <button
                  v-if="curSourceName" class="det-link" :title="`书源：${curSourceName}（点击打开规则工坊）`"
                  @click="openSourceWorkshop()"
                >{{ curSourceName }}</button>
                <span v-else>—</span>
                <button class="btn mini" title="换一个源来看这本书" @click="switchDlgOpen = true">⇄ 换源</button>
              </div>
              <div class="det-row"><b>最新：</b><span class="det-ellipsis" :title="detailLatest">{{ detailLatest || '—' }}</span></div>
              <div class="det-row">
                <b>分组：</b><span :title="curGroupName">{{ curGroupName }}</span>
                <button class="btn mini" title="选择书架分组（未加入书架时确认后自动加入）" @click="openShelfDialog('group')">设置分组</button>
              </div>
              <div class="det-row">
                <b>分类：</b>
                <div v-if="r.detail.tags?.length" class="tag-row det-tags" :title="r.detail.tags.join('、')">
                  <span v-for="t in r.detail.tags" :key="t" class="tag">{{ t }}</span>
                </div>
                <span v-else>—</span>
              </div>
              <!-- 用户要求：「加入书架/删除书籍」「开始阅读/继续阅读」一行，放在分类行下方 -->
              <div class="det-actions">
                <button class="btn mini primary" :disabled="!r.detail.chapters?.length" @click="startReading()">{{ readStartLabel }}</button>
                <button v-if="!r.inCurrentShelf" class="btn mini" @click="openShelfDialog('add')">加入书架</button>
                <button v-else class="btn mini" @click="r.toggleShelf()">删除书籍</button>
              </div>
            </div>
          </div>
          <!-- 中区：简介（`#586` 用户 10-23：宽 70% ⇒ 80% 居中）。纯文本按 200 字符截断；富文本（`<useweb>`）按高度折叠。 -->
          <div v-if="introRaw" class="det-intro">
            <div class="det-intro-body" :class="{ clamped: introRich && !introExpanded }">
              <RichIntro :text="introShown" indent />
            </div>
            <button
              v-if="introNeedToggle"
              class="det-intro-toggle" data-intro-toggle
              :title="introExpanded ? '收起简介' : '展开全部简介'"
              @click="introExpanded = !introExpanded"
            >{{ introExpanded ? '收起' : '展开' }}</button>
          </div>
          <div class="rd-toc-head">
            <h3 class="rd-chapter">目录（{{ r.detail.chapters?.length ?? 0 }} 章）</h3>
            <span v-if="isAudio" class="rd-toc-tip">🎧 点任意目录项即开始播放</span>
            <span v-else-if="r.detail.kind === 'video'" class="rd-toc-tip">🎬 点任意目录项即开始播放</span>
            <span v-if="isAudio && playingThis" class="rd-toc-tip">
              ▶ 正在右下角浮窗播放 · {{ audio.index + 1 }}/{{ audio.tracks.length }}
            </span>
            <!-- `#677` 用户要求：「目录加载中」和「点目录后的加载中」都挪到**标题栏中间**
                 （「目录（N 章）」与右侧筛选框之间），居中显示。
                 原来它是一整块独立提示（`class="empty"`）铺在目录下方，既占地方又像「目录是空的」。 -->
            <div class="rd-toc-mid">
              <span v-if="tocLoadingNow" class="rd-toc-loading">加载中…</span>
            </div>
            <!-- ③-1 筛选 + 正序/倒序（右侧） -->
            <input
              v-model="tocFilter" class="rd-toc-filter" type="search"
              :placeholder="`筛选章节（共 ${r.detail.chapters?.length ?? 0}）`"
            />
            <div class="rd-order" :title="tocDesc ? '当前：倒序（最新的在前）' : '当前：正序（第 1 章在前）'">
              <span class="rd-order-label" :class="{ on: !tocDesc }">正序</span>
              <button
                class="rd-switch" :class="{ on: tocDesc }" role="switch" :aria-checked="tocDesc"
                @click="tocDesc = !tocDesc"
              ><span class="rd-knob"></span></button>
              <span class="rd-order-label" :class="{ on: tocDesc }">倒序</span>
            </div>
          </div>
          <div class="rd-toc" ref="detailTocEl">
            <template v-for="({ ch, i }) in tocList" :key="i">
              <!-- 卷标题行（TocRule.isVolume）：分节标题，无正文页 -->
              <div v-if="ch.isVolume" class="rd-ch rd-vol" :data-tip="r.tocTitleAt(i)">{{ r.tocTitleAt(i) }}</div>
              <!-- ② 长章节名会被省略号截断 ⇒ `data-tip` 悬停显示全名（全局 HoverTip，
                   只在真被截断时才弹；见 components/HoverTip.vue） -->
              <button
                v-else class="rd-ch"
                :class="{ 'is-cur': isCurChapter(i) }"
                :disabled="!isAudio && r.contentLoading" :data-tip="r.tocTitleAt(i)" @click="onTocClick(ch, i)"
              >
                <!-- 上游 `upHasCache`：当前章恒显示 ✓（不显示云朵），其余章未缓存才显示云朵 -->
                <svg v-if="isCurChapter(i)" class="ic-cached" viewBox="0 0 24 24" aria-hidden="true"><title>当前章</title><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <svg v-else-if="!isChapterCached(ch)" class="ic-cloud" viewBox="0 0 24 24" aria-hidden="true"><title>{{ cloudTitle(ch) }}</title><path d="M17.5 18.5a4 4 0 0 0 .4-7.97 5.5 5.5 0 0 0-11.3-.93A4.5 4.5 0 0 0 7 18.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span class="t">{{ r.tocTitleAt(i) }}</span>
                <span v-if="ch.tag" class="tag">{{ ch.tag }}</span>
                <span v-if="ch.isVip" class="badge vip">VIP</span>
                <span v-if="ch.isPay" class="badge pay">付费</span>
              </button>
            </template>
            <!-- 空态三分（`#161`）：见 tocEmptyHint 的注释 —— 别把「解析失败」混成「静默空」 -->
            <div v-if="!tocList.length" class="empty" :class="{ 'err-text': !!r.detail?.tocError && !tocFilter.trim() }">
              {{ tocEmptyHint }}
            </div>
            <!-- `#769` 部分成功（有章节但后续页失败）⇒ 一行轻提示，不挡阅读 -->
            <div v-if="tocPartialHint" class="toc-warn" :title="r.detail?.tocError">{{ tocPartialHint }}</div>
          </div>
          </div><!-- /det-wrap -->
        </template>

        <!-- `#677` 这块「加载中…」只在**没有目录标题栏**时兜底（详情未到手 / directRead 直达阅读）。
             详情页在时，加载提示已经挪进「目录（N 章）」标题栏中间，见 `.rd-toc-mid`。 -->
        <div v-if="(r.contentLoading || r.detailLoading) && (!r.detail || r.directRead)" class="empty">加载中…</div>
      </div>
      <!-- ★ 页脚（`#221`）：**固定悬浮**、不随正文滚动；显隐由 `footerMode` 决定。 -->
      <ReaderTipBar
        v-if="r.readStyle.footerMode !== 1" zone="footer"
        :class="{ 'rd-tip-off': !footerVisible }"
        :left="footerTip.left" :middle="footerTip.middle" :right="footerTip.right"
      />
      </div><!-- /se-scroll -->
      <!-- 4-3 **目录 / 书签侧滑浮层**（从右侧滑入） -->
      <div v-if="sidePanel" class="rd-side-mask" @click.self="sidePanel = false">
        <div class="rd-side" ref="sideEl">
          <div class="rd-side-head">
            <button class="rd-side-tab" :class="{ on: sideTab === 'toc' }" @click="sideTab = 'toc'; nextTick(scrollSideToCurrent)">
              目录（{{ totalCh }}）
            </button>
            <button class="rd-side-tab" :class="{ on: sideTab === 'bookmarks' }" @click="sideTab = 'bookmarks'">
              书签（{{ r.currentBookmarks.length }}）
            </button>
            <button class="rd-side-tab" :class="{ on: sideTab === 'highlights' }" @click="sideTab = 'highlights'">
              标注（{{ r.currentHighlights.length }}）
            </button>
            <!-- `#146` 书内搜索：结果条数即时反映在 tab 上 -->
            <button class="rd-side-tab" :class="{ on: sideTab === 'search' }" @click="sideTab = 'search'">
              搜索{{ r.bookSearchHits.length ? `（${r.bookSearchHits.length}）` : '' }}
            </button>
            <span style="flex: 1"></span>
            <button class="btn mini" :disabled="refreshing || r.detailLoading" title="重新拉取目录（书架里的书会同步更新本地目录信息）" @click="updateToc()">
              {{ refreshing ? '⟳ 更新中…' : '↻ 更新目录' }}
            </button>
            <button class="btn mini" @click="sidePanel = false">✕</button>
          </div>

          <!-- 目录 tab -->
          <template v-if="sideTab === 'toc'">
            <div class="rd-side-tools">
              <input v-model="tocFilter" class="rd-toc-filter" type="search" :placeholder="`筛选章节（共 ${totalCh}）`" />
              <div class="rd-order" :title="tocDesc ? '当前：倒序（最新的在前）' : '当前：正序（第 1 章在前）'">
                <span class="rd-order-label" :class="{ on: !tocDesc }">正序</span>
                <button class="rd-switch" :class="{ on: tocDesc }" role="switch" :aria-checked="tocDesc" @click="tocDesc = !tocDesc">
                  <span class="rd-knob"></span>
                </button>
                <span class="rd-order-label" :class="{ on: tocDesc }">倒序</span>
              </div>
            </div>
            <div class="rd-toc rd-toc-side" ref="sideTocEl">
              <template v-for="({ ch, i }) in tocList" :key="'s' + i">
                <div v-if="ch.isVolume" class="rd-ch rd-vol" :data-tip="r.tocTitleAt(i)">{{ r.tocTitleAt(i) }}</div>
                <button
                  v-else class="rd-ch"
                  :class="{ 'is-cur': isCurChapter(i) }"
                  :data-tip="r.tocTitleAt(i)"
                  @click="onTocClick(ch, i); sidePanel = false"
                >
                  <!-- 与内联目录同一判据：当前章 ✓，未缓存章云朵 -->
                  <svg v-if="isCurChapter(i)" class="ic-cached" viewBox="0 0 24 24" aria-hidden="true"><title>当前章</title><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <svg v-else-if="!isChapterCached(ch)" class="ic-cloud" viewBox="0 0 24 24" aria-hidden="true"><title>{{ cloudTitle(ch) }}</title><path d="M17.5 18.5a4 4 0 0 0 .4-7.97 5.5 5.5 0 0 0-11.3-.93A4.5 4.5 0 0 0 7 18.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <span class="t">{{ r.tocTitleAt(i) }}</span>
                  <span v-if="ch.tag" class="tag">{{ ch.tag }}</span>
                  <span v-if="ch.isVip" class="badge vip">VIP</span>
                  <span v-if="ch.isPay" class="badge pay">付费</span>
                </button>
              </template>
              <!-- 空态三分（`#161`），与详情视图同一份判据（tocEmptyHint） -->
              <div v-if="!tocList.length" class="empty" :class="{ 'err-text': !!r.detail?.tocError && !tocFilter.trim() }">
                {{ tocEmptyHint }}
              </div>
              <!-- `#769` 部分成功（与详情视图同一份轻提示） -->
              <div v-if="tocPartialHint" class="toc-warn" :title="r.detail?.tocError">{{ tocPartialHint }}</div>
            </div>
          </template>

          <!-- 书签 tab（4-4）：按书存储，字段照 Legado Bookmark 对齐 -->
          <template v-else-if="sideTab === 'bookmarks'">
            <div class="rd-bm-list">
              <div v-for="b in r.currentBookmarks" :key="b.time" class="rd-bm">
                <div class="rd-bm-head">
                  <span class="rd-bm-ch" :data-tip="b.chapterName">{{ b.chapterName }}</span>
                  <span class="rd-bm-time">{{ new Date(b.time).toLocaleString() }}</span>
                  <button class="btn mini" @click="jumpBookmark(b)">跳转</button>
                  <button class="btn mini" @click="r.removeBookmark(b.time)">删除</button>
                </div>
                <div class="rd-bm-text">{{ b.content }}</div>
              </div>
              <div v-if="!r.currentBookmarks.length" class="empty">
                还没有书签。阅读时选中文字即可加入书签。
              </div>
            </div>
          </template>

          <!-- 标注 tab（`#146`）：本书的划线高亮 / 笔记列表 -->
          <template v-else-if="sideTab === 'highlights'">
            <div class="rd-bm-list">
              <div v-for="h in r.currentHighlights" :key="h.time" class="rd-bm">
                <div class="rd-bm-head">
                  <span class="rd-bm-ch" :data-tip="h.chapterName">{{ h.chapterName }}</span>
                  <span class="rd-bm-time">{{ h.note ? '笔记' : '高亮' }}</span>
                  <button class="btn mini" @click="jumpHighlight(h)">跳转</button>
                  <button class="btn mini" @click="r.removeHighlight(h.time)">删除</button>
                </div>
                <div class="rd-bm-text">{{ h.bookText }}{{ h.note ? ` —— ${h.note}` : '' }}</div>
              </div>
              <div v-if="!r.currentHighlights.length" class="empty" style="margin-top: 12px">
                还没有标注。阅读时选中文字即可高亮或写笔记。
              </div>
            </div>
          </template>

          <!-- 搜索 tab（`#146`）：书内全文搜索，**只搜已缓存的正文**（见 stores 的 runBookSearch） -->
          <template v-else>
            <div class="rd-side-tools">
              <input
                v-model="r.bookSearchQuery" class="rd-toc-filter rd-search-input" type="search"
                placeholder="在本书里搜索正文…" @keydown.enter="r.runBookSearch()"
              />
              <label class="rd-search-regex" title="按正则表达式搜索（例：第[一二三]章）">
                <input v-model="r.bookSearchRegex" type="checkbox" /> 正则
              </label>
              <button v-if="!r.bookSearchRunning" class="btn mini primary" @click="r.runBookSearch()">搜索</button>
              <button v-else class="btn mini" @click="r.cancelBookSearch()">停止</button>
            </div>
            <div v-if="r.bookSearchRunning" class="rd-search-prog">
              搜索中 {{ r.bookSearchProgress.done }}/{{ r.bookSearchProgress.total }} 章
            </div>
            <!-- ★ 说明行**不静默**：正则写错 / 可搜章节数 / 结果被截断 / 已中止 都在这里如实说 -->
            <div v-if="r.bookSearchNote" class="rd-search-note">{{ r.bookSearchNote }}</div>
            <div class="rd-search-list">
              <button v-for="(h, i) in r.bookSearchHits" :key="i" class="rd-search-hit" @click="jumpToHit(h)">
                <span class="h">{{ h.chapterTitle }}</span>
                <span class="s"><template v-for="(seg, j) in hitSegments(h)" :key="j"><em v-if="seg.q">{{ seg.text }}</em><template v-else>{{ seg.text }}</template></template></span>
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- `#355` **嗅探条**：面板底部右侧常驻，**不随正文滚动**、半透明；
           浮出 10s 无操作 ⇒ 自动向右收缩成「嗅」图标（点图标再展开并重计时）。
           ★ 只在「本真有媒体直链」时出现（`sniffUrl`）—— 媒体是**整章**的属性，
             不是某一屏的，所以挂在面板层而不是 `.se-body` 的滚动内容里。 -->
      <div v-if="sniffUrl" class="rd-sniff-dock" :class="{ collapsed: sniffCollapsed }" data-sniff-dock>
        <template v-if="!sniffCollapsed">
          <span class="rd-sniff-txt">🎬 检测到视频直链（网页内放不出来，如 m3u8）</span>
          <!-- `#462`（`D14`=A）：播放器页形态的线路只列「正在播放的那一条」——写明原因，
               否则用户会以为「这条线路只嗅到 1 集」是漏抽（换集请走页面自身的线路/选集） -->
          <span v-if="sniffIsPlayerPage" class="rd-sniff-note" data-sniff-note title="本条是源站播放器页（不是直链本身），只能列出你正在播放的那一集；同线路其它集请在页面里的线路/选集处点">ⓘ 该线路为播放器页，仅列当前播放</span>
          <button class="btn mini primary" data-sniff-play @click="openSniffPlayer()">▶ 唤起播放器</button>
          <button class="rd-sniff-fold" title="收起" @click="collapseSniff()">›</button>
        </template>
        <button v-else class="rd-sniff-badge" title="检测到视频直链，点此唤起播放器" data-sniff-badge @click="expandSniff()">嗅</button>
      </div>
    </div>

    <!-- 阅读样式浮层（用户 2026-09-30 Add）：与目录/书签侧滑**分离**，独立弹出 -->
    <div v-if="readStyleOpen" class="rd-dlg-mask" @click.self="readStyleOpen = false">
      <div class="rd-dlg rd-dlg-style">
        <div class="rd-dlg-head">
          <strong>阅读样式</strong>
          <!-- `#247`：把「当前作用域」说清 —— 共用时说明是全局默认，本书覆盖时说明这本书已单独设过。
               ★ 两者都要显示：只报「本书覆盖」的话，共用状态下用户反而不知道自己在改全局。 -->
          <span class="rd-dlg-sub" data-style-scope>
            {{ r.prefs.shareLayout ? '共用布局（所有书生效）' : (r.hasBookReadStyle ? '当前为本书覆盖' : '本书覆盖（尚未单独设置）') }}
          </span>
          <span style="flex: 1"></span>
          <button class="btn mini" @click="readStyleOpen = false">关闭</button>
        </div>
        <!-- `#814` 自动滚动（`#808` `D9`）—— 用户 2026-11-06 实测「样式面板里找不到开关和速度滑块」：
             原来它被放进「更多 → 标题栏按钮显示设置」那一层（那是**按钮显隐**的设置，不是阅读行为），
             用户按文案去「样式」里找必然找不到。挪到这里：与字号/排版同一个面板，开卷即见。
             `#817` 再收进 `#anim` 具名插槽 —— **只在「动画」Tab 渲染**（原来与面板并列，
             每个 Tab 底部都显示，用户实机反馈「跟当前 Tab 无关的一块常驻卡」）。
             ★ 仍然是**会话开关**（关掉浮层就停），只把速度档位持久化（`utils/auto-scroll.ts`）。 -->
        <ReadStylePanel target="book">
          <template #anim="{ mode }">
            <!-- 用户 2026-11-09：动画设置按「滚动模式 / 分页模式」两个子 tab 分组；
                 「屏幕常亮」已迁到「设置 → 阅读」（两处同一份 `keepAwakePref`） -->
            <div v-if="mode === 'scroll'" class="rd-style-autoscroll">
              <div class="rd-style-autoscroll-head">
                自动滚动 <span class="rd-toolset-hint" style="margin: 0">仅滚动模式；滚轮/触摸/点击/按键/换章/朗读都会立即停</span>
              </div>
              <label class="rd-toolset-row">
                <span>开启（匀速下滚，到本章末尾自动停）</span>
                <button
                  class="rd-switch" :class="{ on: autoScrollOn }" role="switch"
                  :aria-checked="autoScrollOn" data-style-autoscroll="on"
                  :title="isPaged ? '分页模式下不可用：自动滚动只在滚动模式生效' : (autoScrollOn ? '点击停止' : '点击开始匀速下滚')"
                  @click="toggleAutoScroll()"
                ><span class="rd-knob"></span></button>
              </label>
              <label class="rd-toolset-row">
                <span>速度 {{ autoScrollSpeed }} px/帧（≈{{ Math.round(autoScrollSpeed * 60) }} px/秒）</span>
                <input
                  class="rd-autoscroll-range" type="range"
                  :min="AUTO_SCROLL_MIN_SPEED" :max="AUTO_SCROLL_MAX_SPEED" step="0.5"
                  :value="autoScrollSpeed" :disabled="isPaged" data-style-autoscroll="speed"
                  @input="onAutoScrollSpeedInput($event)"
                />
              </label>
              <!-- `#817` 分页提示**写在卡里**而不是只靠 tooltip：
                   滑块 `disabled` 后不触发 hover，`title` 提示根本不显示；
                   而「视图模式」就在本 Tab 上方 ⇒ 这里点名怎么切回去，用户一眼能自救。 -->
              <div v-if="isPaged" class="rd-style-autoscroll-note" data-style-autoscroll="paged-hint">
                当前是<b>分页</b>模式 —— 自动滚动只在滚动模式生效（切上面「视图模式 → 滚动」即可开启）。
              </div>
            </div>

            <!-- B8 自动翻页（分页模式）。口径见文件里「B8 自动翻页」那一节的上游对照注释。 -->
            <div v-else class="rd-style-autoscroll" data-style-autopage>
              <div class="rd-style-autoscroll-head">
                自动翻页 <span class="rd-toolset-hint" style="margin: 0">仅分页模式；到末页自动接下一章；读完全书自动停；与朗读互斥</span>
              </div>
              <label class="rd-toolset-row">
                <span>开启（每 {{ autoPageInterval }} 秒翻一页）</span>
                <button
                  class="rd-switch" :class="{ on: autoPageOn }" role="switch"
                  :aria-checked="autoPageOn" data-style-autopage="on"
                  :disabled="!pagedActive"
                  :title="!pagedActive ? '当前不可用：自动翻页只在分页正文里生效' : (autoPageOn ? '点击停止' : '点击开始定时翻页')"
                  @click="toggleAutoPage()"
                ><span class="rd-knob"></span></button>
              </label>
              <div class="rd-toolset-row rd-ap-row">
                <span>间隔</span>
                <div class="rd-ap-opts" role="radiogroup" data-style-autopage="interval">
                  <button
                    v-for="s in AUTO_PAGE_SECONDS" :key="s"
                    type="button" class="rd-ap-opt" :class="{ on: autoPageInterval === s }"
                    :aria-pressed="autoPageInterval === s"
                    :data-sec="s" @click="setAutoPageInterval(s)"
                  >{{ s }} 秒</button>
                </div>
              </div>
              <div v-if="!pagedActive" class="rd-style-autoscroll-note" data-style-autopage="paged-hint">
                <template v-if="isPaged">当前这一章<b>不支持分页</b>（漫画/PDF/HTML）—— 自动翻页仅在文字分页正文生效。</template>
                <template v-else>当前是<b>滚动</b>模式 —— 自动翻页只在分页模式生效（切上面「视图模式 → 分页」即可）。</template>
              </div>
            </div>

            <!-- 用户 2026-11-09：屏幕常亮已迁到「设置 → 阅读」面板（同一份 `keepAwakePref`） -->
          </template>
        </ReadStylePanel>
      </div>
    </div>

    <!-- 加入书架：选分组 / 就地新建分组（①-3） -->
    <AddToShelfDialog
      v-if="addShelfOpen"
      :title="shelfDlgTitle"
      :initial-group-id="curGroupId"
      :confirm-text="shelfDlgConfirm"
      :book-title="r.detail?.title"
      @confirm="onAddToShelf"
      @close="addShelfOpen = false"
    />

    <!-- 4-3 离线缓存对话框 -->
    <div v-if="cacheOpen" class="rd-dlg-mask" @click.self="cacheOpen = false">
      <div class="rd-dlg">
        <h3 class="rd-chapter" style="margin-top: 0">离线缓存</h3>
        <p class="rd-dlg-tip">
          把指定范围的章节正文缓存到本机（IndexedDB），之后离线/源站不稳时也能读。
          缓存后台执行，可随时停止。
        </p>
        <div class="rd-dlg-row">
          <span>第</span>
          <input v-model.number="cacheFrom" type="number" min="1" :max="totalCh" class="rd-dlg-num" />
          <span>章 至 第</span>
          <input v-model.number="cacheTo" type="number" min="1" :max="totalCh" class="rd-dlg-num" />
          <span>章（共 {{ totalCh }} 章）</span>
        </div>
        <div v-if="cacheJob && (cacheJob.state === 'running' || cacheJob.state === 'queued')" class="rd-dlg-prog">
          缓存中 {{ cacheJob.done + cacheJob.failed + cacheJob.skipped }}/{{ cacheJob.total }}<template v-if="cacheJob.failed"> · 失败 {{ cacheJob.failed }}</template>
        </div>
        <div class="rd-dlg-btns">
          <button class="btn mini" @click="cacheOpen = false">取消</button>
          <!-- `#207`：跳到下载管理看全局进度 / 暂停续跑 -->
          <button class="btn mini" title="打开下载管理（看进度、暂停/继续、重试失败的章节）" @click="goDownloads()">下载管理</button>
          <button class="btn mini primary" @click="confirmCache()">确定（开始后台缓存）</button>
        </div>
      </div>
    </div>

    <!-- `#807` `D3` 正文右键菜单：随光标定位，与选区菜单共用外观但纵向排列 -->
    <div
      v-if="ctxMenuOpen" class="rd-selmenu rd-ctxmenu" data-ctx-menu
      :style="{ left: ctxXY.x + 'px', top: ctxXY.y + 'px' }"
      @mousedown.prevent
      @contextmenu.prevent
    >
      <!-- `#815`：只剩**非选区类**动作。选区类（复制 / 搜全书 / 选中加书签…）全归划词菜单 -->
      <button title="在当前段落起点加书签" @click="ctxBookmark()">加书签</button>
      <button :disabled="isMedia || isComic" title="从本段开始朗读" @click="ctxReadAloud()">朗读本段</button>
      <button :title="isPaged ? '切到滚动模式' : '切到分页模式'" @click="ctxToggleViewMode()">{{ isPaged ? '切换滚动' : '切换分页' }}</button>
    </div>

    <!-- 4-4 选中文字菜单
         ★ `@mousedown.prevent`：点按钮时**不要清掉选区**（否则 selectionchange 先触发、菜单先消失，click 就丢了）
         ★ `user-select:none`（见样式）：鼠标拖过菜单时，菜单文字不会被选进选区 -->
    <div
      v-if="selMenuOpen" ref="selMenuEl" class="rd-selmenu" :class="{ below: selXY.below }"
      :style="{ left: selXY.x + 'px', top: selXY.y + 'px' }"
      @mousedown.prevent
    >
      <!-- ★★ `#255`：**一级只留六枚**（复制 / 书签 / 字典 / 高亮 / 笔记 / 更多），
           其余收进「更多」二级菜单。★ 与标题栏「更多」(#221) 同一条纪律：**收进去 ≠ 没有**，
           功能一个不少，只是不再平铺（平铺 9 枚会把菜单撑到比正文还宽）。 -->
      <button @click="copySelection()">复制</button>
      <button @click="addBookmarkFromSelection()">书签</button>
      <button @click="lookupSelection()">字典</button>
      <!-- `#146`：选区不是可划线正文（标题/图片/跨容器）时禁用，而不是点了没反应 -->
      <button :disabled="!selRange" :title="selRange ? '' : '标题或图片上不支持高亮'" @click="addHighlightFromSelection()">高亮</button>
      <button :disabled="!selRange" :title="selRange ? '' : '标题或图片上不支持高亮'" @click="openNoteInput()">笔记</button>
      <!--
        「更多」二级菜单。
        ★ 「更多」这枚按钮**必须是一级的直接子级** —— 第一版把它包进 `<span>`（为了给它做定位基准），
          结果「一级 = 菜单的直接 button 子级」这条判据就不认它了（探针当场抓到），
          而且 DOM 层级与实际语义（同级的第六枚）对不上。
        ★ 定位基准改用**菜单本身**（`.rd-selmenu` 有 `transform` ⇒ 天然是定位容器）：
          下拉 `right:4px` = 菜单 padding（4px）内侧 = 最后一枚按钮的右缘。
      -->
      <button
        :class="{ on: selMoreOpen }" data-sel-more
        :aria-expanded="selMoreOpen" title="更多：全选 / 替换 / 搜全书 / 本地字典"
        @click="toggleSelMore()"
      >更多 ▾</button>
      <!-- 下拉的朝向（朝上/朝下）**量过再定**，见 `toggleSelMore()` 的注释 -->
      <div
        v-if="selMoreOpen" class="rd-sel-more" :class="{ down: selMoreDown }"
        data-sel-more-menu :data-sel-more-dir="selMoreDown ? 'down' : 'up'"
      >
        <button @click="selectAllText()">全选</button>
        <button @click="openReplaceFromSelection()">替换</button>
        <button @click="searchSelectionInBook()">搜全书</button>
        <button @click="lookupLocalDict()">本地字典</button>
      </div>
      <!-- 笔记内联输入（展开后替代按钮行） -->
      <span v-if="noteOpen" class="rd-notein">
        <input
          v-model="noteText" class="rd-notein-input" placeholder="写点笔记…" autofocus
          @keydown.enter="saveNote()" @keydown.esc="noteOpen = false"
        />
        <button class="primary" @click="saveNote()">保存</button>
        <button @click="noteOpen = false">取消</button>
      </span>
    </div>

    <!--
      选区菜单「替换」：`#260` 起改用**共用的**替换规则编辑对话框
      （原先这里是本组件自带的简化弹窗：只有 查找/替换为/作用范围/3 个勾选，
       连「分组 / 排除范围 / 启用 / 超时」都没有 ⇒ 与设置页那份**字段不一致**，
       用户从阅读界面建的规则还得回设置页补字段）。
      触发：`replaceDraft != null`。
    -->
    <ReplaceRuleDialog
      v-if="replaceDraft" :rule="replaceDraft" creating
      @close="cancelQuickReplace()" @save="onSelectionReplaceSave"
    />

    <!-- `#568` 站点定制编辑器（per-site CSS/JS + 阅读模式） -->
    <SiteCustomizeDialog
      v-if="siteDlgOpen"
      :url="pageUrl"
      :current="siteCfg"
      :title="r.chapter?.title ? String(r.chapter.title) : ''"
      :html="customizeHtml"
      :source-id="r.sourceId ?? ''"
      @close="siteDlgOpen = false"
      @saved="siteCfg = $event"
    />

    <!-- `#620` 导出本书（txt / epub） -->
    <ExportBookDialog
      v-if="exportOpen && r.detail?.chapters?.length"
      :source-id="r.sourceId ?? ''"
      :book-payload="r.it0?.payload"
      :title="r.detail?.title ?? ''"
      :author="r.detail?.author"
      :intro="r.detail?.intro"
      :cover-url="r.detail?.cover"
      :chapters="r.detail?.chapters ?? []"
      @close="exportOpen = false"
    />

    <!-- 书内备注（Legado `BookMemo`） -->
    <BookMemosDialog
      v-if="memoOpen && r.currentKey"
      :book-url="r.currentKey"
      :book-name="r.detail?.title ?? ''"
      :book-author="r.detail?.author ?? ''"
      @close="memoOpen = false"
    />

    <!-- `#260` 起效的替换规则（对齐上游 `EffectiveReplacesDialog`） -->
    <EffectiveReplacesDialog v-if="effReplacesOpen" @close="effReplacesOpen = false" />
    <!-- `#261` 手动规则集 -->
    <ManualReplaceRulesDialog v-if="manualRulesOpen" @close="manualRulesOpen = false" />
    <!-- `#262` 高亮规则：管理列表 + 编辑器（选区动作栏「创建规则」也进编辑器） -->
    <HighlightRulesDialog v-if="hrRulesOpen" @close="hrRulesOpen = false" />
    <HighlightRuleEditDialog
      v-if="ruleEditDraft"
      :rule="ruleEditDraft" :creating="ruleEditCreating"
      data-hr-edit-dlg
      @close="ruleEditDraft = null"
      @save="saveRuleEdit"
    />

    <!--
      `#256` 点已有高亮弹出的**动作栏**（对齐上游 `showHighlightActionMenu`：
      样式 / 备注 / 创建规则 / 复制 / 删除）。
      ⚠️ 旧实现是「就地改样式」的面板 —— 换掉它的理由：装不下「备注 / 创建规则 / 复制」，
      且与上游的两级结构（先选动作 → 再进各自界面）不一致。
    -->
    <div
      v-if="hlMenuOpen" class="rd-hl-menu"
      :style="{ left: hlMenuXY.x + 'px', top: hlMenuXY.y + 'px' }"
      data-hl-menu @mousedown.stop
    >
      <button class="rd-hl-mi" data-hl-action="style" @click="openHlStyle()">样式</button>
      <button class="rd-hl-mi" data-hl-action="note" @click="openHlNote()">备注</button>
      <!-- `#262` 才做（上游 HighlightRule 全链路）；这里保留按钮位并如实说明，不做假实现 -->
      <button class="rd-hl-mi" data-hl-action="rule" title="把这条高亮转成自动高亮规则" @click="createRuleFromHighlight()">创建规则</button>
      <button class="rd-hl-mi" data-hl-action="copy" @click="copyHighlightText()">复制</button>
      <button class="rd-hl-mi danger" data-hl-action="delete" @click="removeCurrentHighlight()">删除</button>
    </div>

    <!-- `#256` 样式对话框（改一下就写一次库 = 实时预览，没有「确定/取消」） -->
    <HighlightStyleDialog
      v-if="hlStyleOpen"
      :style="hlStyleDraft" :text="hlMenuText"
      @change="onHlStyleChange" @close="hlStyleOpen = false"
    />

    <!-- `#256` 备注框：改的是副本，「保存」才落库；清空 = 去掉备注（高亮还在） -->
    <div v-if="hlNoteOpen" class="rd-hl-note-mask" data-hl-note @mousedown.stop @click.self="hlNoteOpen = false">
      <div class="rd-hl-note">
        <div class="rd-hl-note-head">
          <strong>备注</strong>
          <span style="flex: 1"></span>
          <button class="btn mini" data-hl-note-close @click="hlNoteOpen = false">关闭</button>
        </div>
        <p class="rd-hl-note-quote">{{ hlMenuText }}</p>
        <textarea
          v-model="hlNoteText" class="rd-hl-note-input" data-hl-note-input
          rows="4" placeholder="写给自己的备注…（清空保存 = 去掉备注，高亮保留）"
        ></textarea>
        <div class="rd-hl-note-btns">
          <button class="btn mini" @click="hlNoteOpen = false">取消</button>
          <button class="btn mini primary" data-hl-note-save @click="saveHlNote()">保存</button>
        </div>
      </div>
    </div>

    <!-- 4-5 字典查词结果：**多 tab，点一个查一个**（打开时一条请求都不发） -->
    <div v-if="dict.lookupOpen" class="rd-dict-mask" @mousedown="onDictMaskDown" @click="onDictMaskClick">
      <div class="rd-dict">
        <div class="rd-dict-head">
          <strong>查词：{{ dict.word }}</strong>
          <span style="flex: 1"></span>
          <button class="btn mini" @click="dict.lookupOpen = false">关闭</button>
        </div>
        <!-- tab 条：每条字典一个；`✓` = 已查过（点它只是切过去看，不重复请求） -->
        <div class="rd-dict-tabs">
          <button
            v-for="res in dict.results" :key="res.name" class="rd-dtab"
            :class="{ on: res.name === dict.activeName, done: res.state === 'done' }"
            :title="res.state === 'idle' ? `点此查询「${res.name}」`
              : res.state === 'loading' ? '查询中…' : '已查询，点击查看结果'"
            @click="dict.openTab(res.name)"
          >
            <span class="rd-dtab-nm">{{ res.name }}</span>
            <span v-if="res.state === 'loading'" class="rd-dtab-st">…</span>
            <span v-else-if="res.state === 'done'" class="rd-dtab-st">{{ res.err ? '!' : '✓' }}</span>
          </button>
          <span style="flex: 1"></span>
          <button
            class="rd-dtab retry" :disabled="!dict.activeName || dictActive?.state === 'loading'"
            title="重新查询当前字典（忽略已缓存的结果）" @click="dict.lookupOne(dict.activeName, true)"
          >↻</button>
        </div>
        <div class="rd-dict-body" @click="onDictBodyClick">
          <div v-if="!dict.results.length" class="empty">
            没有启用的字典。去「工具 → 字典」里新建或导入字典规则。
          </div>
          <template v-else-if="dictActive">
            <div v-if="dictActive.state === 'idle'" class="rd-dict-idle">
              点上面的字典标签开始查询（不会一次全部发起）。
            </div>
            <div v-else-if="dictActive.state === 'loading'" class="rd-dict-idle">查询中…</div>
            <template v-else>
              <div class="rd-dict-name">
                {{ dictActive.name }}
                <span class="rd-dict-ms">{{ dictActive.ms }}ms</span>
              </div>
              <div v-if="dictActive.err" class="err-text">{{ dictActive.err }}</div>
              <!-- 站点返回的是短文本（未收录该词 / 404 / 代理回话）⇒ 如实提示，别当正文渲染 -->
              <div v-else-if="dictActivePlain" class="rd-dict-note">
                <span class="rd-dict-note-h">站点返回（不是释义正文，可能是未收录该词）：</span>
                <span class="rd-dict-note-t">{{ dictActive.text }}</span>
                <div class="rd-dict-note-hint">换个更完整的词、或换一个字典 tab 再试。</div>
              </div>
              <!-- 字典站的输出是 HTML（Legado 同样按 HTML 渲染）；**先消毒再 decorate**：
                   补全相对地址、图片走代理、链接新标签打开、发音按钮由我们接管 -->
              <div v-else class="rd-dict-html" v-html="dictActiveHtml"></div>
            </template>
          </template>
        </div>
      </div>
    </div>

    <!-- `#274` 换源改独立对话框（同类限定 + 归并 + 当前源禁用）。
         ★ `#286` 修「顶端标题栏与详情页标题栏重叠」：原来挂在本注释下方的滚动容器里，
           那层是 `position:relative; z-index:1` 的**独立层叠上下文** ⇒ 弹窗遮罩（fixed z-90）
           被关在 z-1 里，而标题栏 `.se-head` 是 z-2 的兄弟层 —— 永远画在弹窗上面。
           挪到 `.se-mask` 根层（与朗读浮条同层）后，遮罩 z-90 > 面板内所有层，正常全覆盖。 -->
    <SourceSwitchDialog
      :open="switchDlgOpen"
      :kind="String(r.detail?.kind ?? 'book') === 'video' ? 'video' : 'book'"
      :current-source-id="r.sourceId"
      :keyword="r.detail?.title ?? ''"
      @close="switchDlgOpen = false"
      @pick="(p) => { switchDlgOpen = false; void r.switchBookSource(p); }"
    />

    <!-- `#203` 朗读浮条：绝对定位悬浮在阅读浮层右下角（**不占正文空间** ——
         用户 2026-10-02 纠错：原来它走正常流，占掉正文上缘一整行，设置面板还把正文压窄）。
         ★ 放在 `.se-panel` **外面**、`.se-mask` 里面：`.se-mask` 是 `position:fixed` 的整屏容器，
           浮条以它为定位上下文 ⇒ 落在浮层的右下角，不会因为面板宽度而横向溢出。
           （曾试过放进 `.se-panel` 内，但那样定位虽对、却让 Vue 在该分支下不渲染 —— 现象先记下，
             定位问题用 `right/bottom` 相对遮罩解决更稳。）
         ★ 只在**正文视图**挂载：详情/目录视图没有正文，念不了；
           漫画（图片）与音视频源同理（`isMedia` / `isComic` 由浮条入口的 v-if 一起挡掉）。
         ★ `:open` + `@update:open` 与工具条那个「🔊 朗读」双向联动：点入口 ⇒ 展开整条控制条。
             （刻意不用 `v-model` + `defineModel`：它拿到的是解包后的 boolean，父侧改值时子组件
               内部 ref 不会同步 ⇒ watch 永不 fire，实测「点了入口只出 FAB、整条不展开」。）
         ★ B18 Web：小窗阅读打开期间本条**让位**（小窗是阅读，不是听书面板；同时铺开会被当成两套控制面）。 -->
    <ReadAloudBar
      v-if="(alOpen || al.active) && !isMedia && !isComic && !webSmallOpen && !inPageSmall"
      :open="alOpen"
      :compact="inPageSmall"
      :lyrics-enabled="isDesktop() ? lyricsFloatEnabled : webLyricsOpen"
      :lyrics-desktop="isDesktop()"
      @update:open="alOpen = $event"
      @follow="followReadAloud"
      @toggle-lyrics="toggleLyricsFloat"
      @lyrics-refresh="refreshLyricsFloatPref"
    />
      <!-- B18 Web 小窗阅读：只走 Document PiP（常规 / 条形两态，可互相切换，切换保留阅读位置）；
           控制区鼠标进入顶部 48px 热区才浮现；歌词窗是同一组件的另一内容源（用户主动开启、默认关）。 -->
      <ReaderMiniBar
        v-if="webSmallOpen"
        :tier="webSmallTier"
        mode="read"
        @close="closeWebSmall()"
        @tier="onWebFloatTier"
      />
      <ReaderMiniBar
        v-if="webLyricsOpen && !webSmallOpen && al.active"
        tier="regular"
        mode="lyrics"
        @close="webLyricsOpen = false"
        @tier="() => {}"
      />
      <!-- 漫画双击 → 满视窗大图查看器（用户 2026-11-09）：左右切换 + 底部缩略图；
           关闭只撤本层，阅读滚动位置保持不变 -->
      <div
        v-if="comicViewerOpen"
        class="rd-comic-viewer"
        role="dialog" aria-modal="true" aria-label="大图查看"
        @click.self="closeComicViewer()"
        @wheel.prevent
      >
        <button class="rd-cv-close" title="关闭（Esc）" @click="closeComicViewer()">✕</button>
        <button
          class="rd-cv-nav rd-cv-prev" title="上一张（←）"
          :disabled="comicViewerIdx <= 0" @click.stop="comicViewerGo(-1)"
        >‹</button>
        <div class="rd-cv-stage">
          <img
            v-if="comicViewerList[comicViewerIdx]"
            :src="comicViewerList[comicViewerIdx].url" alt=""
            draggable="false"
          />
        </div>
        <button
          class="rd-cv-nav rd-cv-next" title="下一张（→）"
          :disabled="comicViewerIdx >= comicViewerList.length - 1" @click.stop="comicViewerGo(1)"
        >›</button>
        <div class="rd-cv-bar">
          <span class="rd-cv-count">{{ comicViewerIdx + 1 }} / {{ comicViewerList.length }}</span>
          <div class="rd-cv-strip">
            <button
              v-for="(it, k) in comicViewerList" :key="it.chIdx + ':' + it.i"
              class="rd-cv-thumb" :class="{ on: k === comicViewerIdx }"
              :title="`第 ${k + 1} 张`" @click.stop="comicViewerIdx = k"
            >
              <img :src="it.url" alt="" loading="lazy" draggable="false" />
            </button>
          </div>
        </div>
      </div>
      <!-- #490 退出「读过正文但没进书架」的书：问一句要不要加入书架 -->
    <div v-if="askShelf" class="rd-ask-mask" @click.self="onAskShelfNo">
      <div class="rd-ask" role="dialog" aria-modal="true">
        <p class="rd-ask-t">把《{{ askShelf.title }}》加入书架？</p>
        <p class="rd-ask-s">加入后可自动缓存后续章节，并能从书架继续读</p>
        <div class="rd-ask-btns">
          <button class="btn mini" @click="onAskShelfNo">否</button>
          <button class="btn mini primary" @click="onAskShelfYes">确定</button>
        </div>
      </div>
    </div>
    <!-- `#583` 源脚本要求打开的面板（`java.showBrowser` 的 data URL：段评/本章说/书评）。
         与「页内导航」区分：那是把正文换掉，这里是一层**面板**，关掉就回到原文。
         用 `InAppBrowser` 承载（它认识 data URL，并给面板里的 `qmRun` RPC 提供宿主）。 -->
    <InAppBrowser
      v-if="sourceUiOpen"
      compact
      :url="sourceUiOpen.url"
      :title="sourceUiOpen.title"
      :source-id="r.sourceId"
      @close="sourceUiOpen = null"
      @open-external="openSourceUiExternal"
    />
</div>
</template>

<style scoped>
.se-mask {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 4vh 16px;
}
/* `#583+` 详情页遮罩（用户 2026-10-23）：原来是纯透明压暗、能看清下面的页面；
   改为 50% 压暗 + 高斯模糊（`backdrop-filter` 只作用于遮罩**背后**，面板本身清晰）。 */
.se-mask.se-mask-detail {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
/* `#590` 详情页面板「直接最大高度」：不再因内容少（目录短）就缩高；
   窗口高度变小仍自适应（92vh 随视口）。`:not(.rd-view)` = 纯详情态 ——
   从详情页进阅读时（readerFromDetail）遮罩虽是详情样式，面板不钉高，
   阅读区有自己的高度逻辑（最大化另说）。 */
.se-mask.se-mask-detail:not(.rd-view) .se-panel { height: 92vh; }
/**
 * `#671` **阅读态同样钉 92vh**（用户实测）：正文少或为空时，`.se-panel` 只有 `max-height: 92vh`
 * 而高度由内容决定 ⇒ 面板缩成一小条（截图里只有约 1/6 屏），侧滑目录跟着变矮、只能看到两三章。
 * 这里给阅读态一个确定的 `height`（最大化 `.maxed` 仍用 `!important` 覆盖，不受影响）。
 */
.se-mask.rd-view .se-panel { height: 92vh; }
.se-panel {
  /* `position: relative`：**侧滑目录/缓存对话框都是本浮层的子浮层**，绝对定位以这里为边界
     （用户 A：目录不再从窗口右侧滑入，而是从阅读浮层右侧滑入） */
  position: relative;
  width: min(920px, 100%); max-height: 92vh;
  display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.18s ease;
}
/* `#806` `D8`：标题栏热区。**详情页**仍在文档流里（标题栏常显，占位是正常的）；
   阅读态改为绝对定位浮层见 `#811` 的规则块（`position: absolute`，完全不占位）。 */
.rd-head-dock { flex: none; }
.se-head {
  display: flex; gap: 8px; align-items: center;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  transition: opacity 0.22s ease;
}
.se-head.rd-head-hidden { opacity: 0; pointer-events: none; }
.se-head strong { font-size: 15px; }
.rd-head-chapter { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.rd-pos { display: inline-flex; align-items: center; gap: 6px; min-width: 0; margin: 0 auto; font-family: var(--font); }
.rd-pos-title { font-size: 13px; font-weight: 600; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.rd-pos-sub { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
/* ===== 最大化（用户 2026-09-28）：浮层铺满整个界面 =====
   ★ 只拉 panel 与标题栏；**滚动容器 `.se-body` 保持原宽度并居中** ⇒ 正文、滚动条、
     底部浮动条三者的宽度**都自动与最大化前一致**（用户要求「阅读区域不扩张」）。
   ⚠️ 一开始是给 `.se-body` 的**子元素**限宽（884/896px），但实测差了 17px：非最大化时
     `.se-body` 有 **15px 竖向滚动条占宽**（内容 882 → 正文 867），限宽子元素反而让滚动条"消失"
     变成 884。所以限制**容器**而不是它的内容 —— 滚动条仍在原位置，宽度逐像素一致。 */
/* `#468①`：最大化必须**真的铺满窗口（含底部）** —— 用户实测「面板底部没到窗口底边，
   下层『RSS 订阅发现』列表从缝隙里透出来」。静态排查已排除竞争 padding 规则 / `Transition`
   / `will-change` / `filter` 祖先 / `--bg-1` 半透明（详见下方 `.se-panel.maxed` 的说明），
   本地无法复现（浏览器代理三次未能打开阅读浮层）⇒ 按「未知规则抢权 / 视口高度未定」做保守加固：
   三件套提到 `!important` + 显式视口高。 */
.se-mask.maxed { padding: 0 !important; height: 100vh !important; }
/* `#222`：正文视图下去掉遮罩的**左右**内边距 —— 它是「浮层离窗口边 16px」用的，
   留着的话滚动容器就永远差 16px 到不了窗口右缘（实测 1440 窗口下容器 1406px）。
   ★ 只清左右：上下那 4vh 是为了让浮层不顶到窗口最上沿，保留。 */
/* ★ `#230`：`#222` 曾加过 `.se-mask.rd-view { padding-left/right: 0 }`（把浮层顶到窗口边好让滚动条贴右缘），
   按用户 2026-10-03 的要求**已撤回** —— 阅读界面恢复窄卡片 + 四周留白。 */
.se-panel.maxed { width: 100% !important; max-width: 100% !important; height: 100% !important; max-height: 100% !important; border-radius: 0; }
/* ===== `#300`（用户 2026-10-06，截图划红框）：最大化滚动模式的滚动条要贴窗口右缘 =====
   用户 2026-09-28 要过「阅读区域不扩张」，但全屏看正文时**滚动条贴在 918px 正文格右缘**，
   离窗口边一大截（用户：「视觉上不好看」）⇒ 口径改为：
   · 页眉 / 页脚：`.se-panel.maxed` 已全宽，它们无 max-width ⇒ 本来就贴边（用户认可的「目前页眉页脚的做法」）；
   · 正文格 `.se-body`：**拉满容器** ⇒ 它是滚动容器，滚动条自然贴窗口右缘；
   · **文字正文**（`.rd-content`）：限宽 918px 居中 ⇒ 文字排版宽度与之前逐像素一致；
   · **HTML 正文 / 图集 / 视频等非文字内容**：**不限宽（铺满）** —— `#468①` 用户实测：
     装正文的 iframe 在最大化下高度被 `flex:1` 撑满（`#432` 定高自滚），若同时被 918px 限宽，
     就成了「又窄又高的一列」（用户：「正文区域还是窄的，iframe 占据整个高度所以宽度缩小了」）。
     ⚠️ 旧写法 `> *`（无差别限所有直接子元素）**正是这个 bug 的来源**；别再改回去。
   ★★ **2026-10-16 更新（以本文为准）**：#468① 二次修正后**已改为「所有 `.rd-content` 统一限 918px」**
     （见下方 `.se-body:not(.se-paged) > .rd-content` 规则）⇒ 上面这条「HTML/图集铺满」**作废**。
     iframe 定高已由 `#432`（`.se-body.se-html` flex 链）解决，918px 限宽不再产生「又窄又高」。
   ⚠️ 3311 的旧教训（「限子元素差 17px」）场景不同：那是**非最大化**下想让滚动条留在 918 容器上；
   这里滚动条**本来就该出去**，正文视觉宽度 = 918（相对除去滚动条的内容区居中，偏左 ≈7px，可接受）。
   ⚠️ `:not(.se-paged)`：分页模式的列宽由 `.se-body` 自身量出（`pageBodyEl` === `.se-body`），
   容器一变宽列宽就变全屏宽 ⇒ 分页模式**维持窄格居中**，一字不动。 */
/* `#468①`（2026-10-16）：正文 918px 限宽居中**与 maximized 解耦**，且**覆盖所有 `.rd-content`**。
   · 旧写法只在 `.se-panel.maxed` 下生效 ⇒ 用户实测最大化后 `maxed` 类在其场景下丢失时限宽整条失效；
   · HTML 正文那条嵌套 flex 链
     （`.se-body.se-html`(flex) → `.rd-content.rd-html`(flex:1) → `.rd-html-frame` → iframe）
     的 flex 子项默认 `min-width:auto`（最小内容宽度保护 ≈ 300px）⇒ 盒子被反向压窄。
   ★★ 2026-10-16 **二次修正**（用户实测回执）：`.rd-content` 是**所有正文分支的公共类**，
   `.rd-html`/`.rd-comic`/`.rd-pdf` 都是**同一个元素上的附加类**。上一版误加
   `:not(.rd-html)` 恰好把「装 iframe 的容器」排除在外 ⇒ 用户报「最大化后 iframe 的父容器
   `.rd-content` 也跟随最大化、宽度没限制在 918px」。现按用户**字面方案 A**：**无条件**给
   所有 `.rd-content` 限宽 918px 居中（文字 / HTML / 图集 / PDF 统一口径）。
   ⚠️ **`#468①` 已取代上方 `#300`（2026-10-06）「HTML/图集铺满」的旧口径** —— 别再改回 `:not(...)`。
   ⚠️ `:not(.se-paged)`：分页模式的列宽由 `.se-body` 自身量出（`pageBodyEl` === `.se-body`），
   容器一变宽列宽就变全屏宽 ⇒ 分页模式**维持窄格居中**，一字不动。
   ⚠️ flex 链另补 `min-width:0`（见下方 `.rd-html` 与 `.rd-html-frame` 规则）。 */
.se-body:not(.se-paged) > .rd-content {
  /* ★ `#468b`（2026-10-16 用户截图回归）：必须显式 `width:100%` —— HTML 正文分支的
     `.se-body.se-html` 是 **column flex**，flex 子项上 `margin-left/right:auto` 会**取消
     默认的 `align-self:stretch`**（auto 外边距在交叉轴优先级高于 stretch）⇒ 交叉轴尺寸
     退化为 fit-content ⇒ `.rd-content` 塌缩到最小内容宽（≈300px 窄条，最大化/非最大化都塌，
     用户实测「RSS 阅读界面内容都是较窄的一条」）。显式给满宽后 auto margin 只做居中：
     · 未最大化：面板 920px ⇒ .se-body 内容盒 886px < 918 ⇒ **充满阅读界面**（= 改动前行为）；
     · 最大化：容器全宽 ⇒ 被 max-width 压到 **918px 居中**（`#468①` 口径不变）。 */
  width: 100%;
  max-width: 918px;
  margin-left: auto;
  margin-right: auto;
  min-width: 0;
}
/* 分页模式（最大化）：居中限宽交给 `.se-paged-view`（`max-width: 918px`），
   `.se-body` 本身不再收窄 —— 否则可用宽被扣掉两层，正文比非最大化时还窄 32px。 */
.se-kind { font-size: 12px; color: var(--muted); }
/* `flex: 1; min-height: 0`：**必须有** `min-height: 0` —— flex 子项默认 `min-height: auto`，
   正文一长就不肯收缩，底部追加的朗读浮条（`#203`）会被顶出浮层外。 */
/* ★ `#231`：左右 padding 由 18px 改成 **16px**，与页眉/页脚默认内边距（`ReadBookConfig.kt:923-924`
   的 16）一致 —— 否则页眉文字与正文文字的左右边缘差 4px，视觉上「页眉没跟正文对齐」。
   `flex:1; min-height:0` 不能少（下方追加的朗读浮条会被顶出浮层外，`#203` 踩过）。 */
.se-body { padding: 14px 16px; overflow: auto; flex: 1; min-height: 0; }
/* 用户 2026-11-09：漫画/图片阅读要**左右铺满** —— 右缘一直铺到滚动条左缘。
   去掉 `.se-body` 的左右 padding、`.rd-content` 的左右边距与 918px 限宽；
   文字 / HTML / PDF 仍按上面的统一口径（只认 `se-comic-fill`）。 */
/* 用户 2026-11-10：图片右缘**不要**贴着滚动条左缘 —— 留 1px。
   滚动容器里 `padding-right` 正好落在内容盒与原生滚动条之间，1px 就是那 1px 缝。 */
.se-body.se-comic-fill { padding-left: 0; padding-right: 1px; }
.se-body.se-comic-fill > .rd-content {
  max-width: none;
  margin-left: 0;
  margin-right: 0;
  padding-left: 0;
  padding-right: 0;
}
/* `#833` 无限滚动：关闭浏览器原生滚动锚定 —— 我们自己按「当前章 offsetTop 差值」补偿，
   两套锚定同时生效会互相抵消/过冲（`reader` 的同一条经验）。 */
.se-body.se-inf-scroll { overflow-anchor: none; }
/* `#841` 漫画三章拼接同样关原生滚动锚定：拼接/释放章会增删视口上方内容，
   浏览器锚定会先替我们改一次 `scrollTop`，再叠加我们自己的补偿 = 过冲（实测 ~1481px）。 */
.se-body.se-comic-merge { overflow-anchor: none; }
/* 拼接章之间的边界：细横线 + 呼吸感，明确「这是另一章」而不是正文缺段 */
.rd-inf-sec { border-top: 1px solid var(--line, rgba(128,128,128,0.18)); margin-top: 10px; padding-top: 10px; }
.rd-inf-sec.rd-inf-prev { margin-bottom: 10px; }
/* 拼接段必须沿用正文 `<p>` 的既有段距：任何不同的 margin 都会在交接时累积成位置漂移 */
/* 首/尾提示条（加载中 / 重试 / 全书首尾）：只占一行，不遮挡正文 */
.rd-inf-edge {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 8px 0; font-size: 12px; color: var(--muted);
}
.rd-inf-top { border-bottom: 1px dashed var(--line, rgba(128,128,128,0.18)); margin-bottom: 8px; }
.rd-inf-bottom { border-top: 1px dashed var(--line, rgba(128,128,128,0.18)); margin-top: 8px; }
.rd-inf-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #4a8cff);
  animation: rd-inf-pulse 0.9s ease-in-out infinite;
}
@keyframes rd-inf-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
.rd-inf-retry {
  border: 1px solid var(--line, rgba(128,128,128,0.3)); background: transparent;
  color: var(--fg, inherit); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer;
}
@media (prefers-reduced-motion: reduce) { .rd-inf-dot { animation: none; opacity: 0.8; } }
.rd-title { font-weight: 700; font-size: 17px; }
.sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
/* 简介的样式已移入 RichIntro（需要 pre-wrap 与 iframe 两种形态）；本类不再使用 */

.meta-grid { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
.meta-item { font-size: 12px; color: var(--muted); }
.meta-item b { color: var(--faint); margin-right: 4px; font-weight: 500; }
/* ── `#583+` 详情页顶部信息区（用户 2026-10-23：左右 1:2，封面 ×2，两边再收 10px）── */
.det-wrap { padding: 0 10px; }
.det-top { display: flex; gap: 16px; margin-bottom: 12px; align-items: stretch; }
/* `#593` 封面高度 = **右栏信息区的实高**（从书名到「开始阅读」按钮），不再钉死 260px：
   `align-items: stretch` + `height: auto` ⇒ 跟着信息区走（信息区内容多/少都对齐）；
   `min-height` 只是下限（信息区本身也有 `min-height: 260px`）。
   `CoverImage` 内部是 `height:100%` + `object-fit:cover` ⇒ 比例变化靠裁切吸收，不会拉变形。 */
.det-cover { width: 192px; height: auto; min-height: 260px; border-radius: 8px; overflow: hidden; flex: none; background: var(--bg3); }
.det-fields {
  flex: 2 1 0; min-width: 0; min-height: 260px;
  display: flex; flex-direction: column; gap: 4px; justify-content: space-between;
  font-size: 19.5px; /* 用户要求信息区字号 ×1.5（13 → 19.5） */
}
.det-name-row { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.det-name { flex: 1 1 auto; min-width: 0; font-weight: 700; font-size: 29px; line-height: 1.3; } /* `#593` 用户要 -2（31 ⇒ 29） */
/* `#591` ★ 可点/hover 只作用于**文字**：`inline-block` ⇒ 盒宽 = 文字实宽，
   不会跟着外层 `flex:1 1 auto` 撑到「书名与 📌 按钮之间的空白」上。
   `max-width:100%` + 三件套 ⇒ 超长书名截断（完整书名走外层 `.det-name` 的 title）。 */
.det-name-text { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.det-name-link { cursor: pointer; }
/* `#591` 用户要 dotted（实下划线在这个字号下太重） */
.det-name-link:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
.det-review { flex: none; margin-top: 6px; }
.det-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.det-row > b { flex: none; color: var(--faint); font-weight: 500; }
.det-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.det-row .btn.mini { font-size: 15px; padding: 2px 10px; } /* 按钮比正文小一档，避免撑破行 */
/* `#593` 信息区**每行都不换行**：分类行原本 `flex-wrap: wrap`（`.tag-row` 全局）⇒ 标签多了会被
   挤成两行、把右栏撑高（封面跟着变高）。改 nowrap + 裁掉溢出，完整分类走容器 title。 */
.det-tags { margin-top: 0 !important; gap: 6px; flex-wrap: nowrap; overflow: hidden; }
.det-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 2px; }
.det-actions .btn.mini { font-size: 15px; padding: 5px 16px; }
.det-link {
  min-width: 0; max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: none; border: 0; padding: 0; color: var(--brand, #4c8bf5);
  font-size: 19.5px; cursor: pointer; text-decoration: underline dotted;
}
.det-ellipsis { max-width: 100%; }
/* ── 中区：简介（默认 200 字 / 富文本按高度折叠 / 宽 70% 居中）────────────── */
.det-intro { width: 80%; margin: 2px auto 6px; }
.det-intro-body.clamped { max-height: 168px; overflow: hidden; }
.det-intro-toggle {
  display: block; margin: 4px 0 0 auto; background: none; border: 0;
  color: var(--brand, #4c8bf5); font-size: 12px; cursor: pointer; padding: 2px 0;
}
.rd-chapter { font-size: 13px; color: var(--muted); margin: 14px 0 8px; }
/* 目录标题行 + 音频源操作（播放全部 / 正在播放提示） */
.rd-toc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rd-toc-head .rd-chapter { margin: 14px 0 8px; }
/* `#677` 标题栏中间的加载态（左：目录（N 章）／右：筛选+正序倒序） */
.rd-toc-mid { flex: 1; display: flex; justify-content: center; min-width: 0; }
.rd-toc-loading {
  font-size: 12px; color: var(--muted);
  animation: rd-toc-pulse 1.2s ease-in-out infinite;
}
@keyframes rd-toc-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.rd-toc-tip { font-size: 11.5px; color: var(--muted); margin-left: auto; }
.rd-media-go { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; font-size: 12.5px; color: var(--muted); }
.rd-toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.rd-toolbar-bottom { margin: 16px 0 4px; padding-top: 12px; border-top: 1px solid var(--border); }
.rd-pos { font-size: 12px; color: var(--faint); margin: 0 auto; font-family: var(--mono); }
/**
 * 正文排版（`#145`）：**字号 / 行距 / 字距 / 段距 / 缩进 / 字重** 全部来自 `--rd-*` 自定义属性，
 * 由 `stores/reader.ts` 的 `readerStyleVars`（→ `styles/reader-theme.ts` 的 `readerContentVars`）
 * 从服务端 prefs 换算而来。
 *
 * ⚠️ 颜色**不在这里** —— 由 `readerStyleVars` 直接给到元素的 `color`/`background`
 * （取值照抄上游 `Config()`，见 reader-theme.ts）。这样换主题只改四处取值，不必维护 4 套 CSS class。
 * ⚠️ `--rd-lh` 是 `calc(1em + Npx)` 形式，**不是**一个 `line-height` 数值 —— 上游
 * `lineSpacingExtra` 是「行高之外的增量」，见 reader-theme.ts 的单位说明。
 */
.rd-content {
  font-size: var(--rd-fs, 20px);
  line-height: var(--rd-lh, calc(1em + 12px));
  letter-spacing: var(--rd-ls, 0.1em);
  font-weight: var(--rd-fw, 400);
  font-family: var(--rd-font, inherit);
  border-radius: 8px;
  /* `#164` 正文边距（上游 `Config.padding*` 默认 6/16/16/6 —— 逐项照抄，见契约同名字段注释） */
  padding: var(--rd-pt, 6px) var(--rd-pr, 16px) var(--rd-pb, 6px) var(--rd-pl, 16px);
  /* ⚠️ `#164` 修掉一个 `#145` 留下的真 bug：这里**曾经**还有一条同权重的
     `.rd-content p { margin: 0 0 14px; text-indent: 2em }` 写在样式表**后面**，
     把下面这条整个压掉了 ⇒ 用户改的「段距 / 缩进」**完全不生效**（且不报错）。
     删掉那条；**新增正文段样式时只改这一处**。 */
/* 站内搜索/高亮的命中词不能被下划线覆盖成看不清 —— 见 `.rd-hl` 的注释 */
}
/* ── `#308` HTML 正文（订阅源 / 组装型）─────────────────────────────
 * 上游把这类正文交给 WebView（`loadDataWithBaseURL`），所以这里同样用**独立的渲染容器**
 * （`<iframe srcdoc>`）而不是 `v-html`：`v-html` **不执行 `<script>`**，
 * 影视聚合的 hls.js 播放器与 24凹凸 的 `atob()` 拼图都会因此失效。
 *
 * ⚠️ 高度**不能**写死成百分比：`iframe` 不会自己撑开，祖先也只有 `max-height`
 *   （本仓在 `#244` 上已经为「确定高度」踩过坑）。所以走「内容页把 `scrollHeight`
 *   报给父窗口、父窗口设 `height`」—— 由 `htmlFrameH` 驱动，见脚本里的 `htmlDoc`。
 *
 * 正文自己的 padding / 字号 / 主题色**不套用**：HTML 文档自带样式，覆盖它会破坏源作者的版式
 * （上游 `clHtml` 也只是**追加**一段兜底样式，不覆盖）。
 */
/* ── `#335`/`#336` 页内导航条（极简浏览器）─────────────────────────
 * 只在跳转过一次之后出现（理由见模板处注释）。
 * ⚠️ `#352`（2026-10-08 用户实测）：旧样式 `rgba(128,128,128,.16)` 半透明底 +
 *    `color: inherit` —— 阅读页铺了背景图（深蓝）时文字/图标**几乎看不见**。
 *    它是「浏览器 chrome」不是正文 ⇒ 改为**实底深灰 + 亮字**（浏览器工具栏的常规形态），
 *   任何主题/背景图上都保持可读；不再跟随 `color: inherit`。 */
.rd-navbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: #26282c;
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e8eaed;
  font-size: 12px;
  line-height: 1.6;
  position: sticky;
  top: 0;
  z-index: 2;
}
.rd-nav-btn {
  flex: 0 0 auto;
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #e8eaed;
  cursor: pointer;
  font-size: 12px;
}
.rd-nav-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
.rd-nav-btn:disabled { opacity: 0.4; cursor: default; }
.rd-nav-url {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #bdc1c6;
  direction: ltr; /* 地址从左到右，避免被 RTL 文本流翻转 */
}
.rd-nav-loading { flex: 0 0 auto; opacity: 0.75; color: #e8eaed; }
.rd-nav-err {
  flex: 0 0 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #ff8a80;
}
/* ── `#355` 嗅探条（媒体直链 · 底部固定 · 半透明 · 10s 收缩为「嗅」）────────────
 * ① **固定在面板底部右侧**：`position:absolute` 挂在 `.se-panel`（不是 `.se-body` 的滚动
 *    内容里）⇒ 正文怎么滚它都不动 —— 媒体直链是整章的属性，不是某一屏的。
 *    `#368`：`bottom` 从 14px 抬到 **52px** —— 页脚 `ReaderTipBar` 在 `.se-scroll` 文档流里
 *    占真实高度（`#251` 三段布局；tip 行 ~20px + 默认 padding 0/10 + 可选分隔线 ≈ 31px，
 *    padding 调到 20/20 也就 ~51px），14px 时整个 dock 压在页脚右栏文字上（用户截图报障）。
 *    页脚自动隐藏只切 `visibility`（`.rd-tip-off`，高度不变）⇒ 固定 52px 在显/隐两态都稳定。
 *    `right` 14→18px 同步内收，与页脚左右 padding（13/17px）大致对齐。
 * ② **半透明**：实底遮字、全透看不见 ⇒ `rgba` + `backdrop-filter` 模糊（任何阅读主题上
 *    都看得清，又不压住正文）。
 * ③ **z-index 5**：高于正文（1）/ 标题栏（2），**低于**侧滑遮罩（6）与弹窗（7）——
 *    弹层打开时它不抢焦点（同层两处 z-index 相同的教训见 `#250`）。
 * ④ 收缩 = **换形态不卸载**：卸载会改变 scrollHeight ⇒ 滚动位置回调 ⇒ 可能触发
 *    其它「是否滚动过」判据翻转（页眉闪烁的老坑，`#221`）。 */
.rd-sniff-dock {
  position: absolute;
  right: 18px;
  bottom: 52px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 28px);
  padding: 6px 8px 6px 12px;
  border-radius: 999px;
  background: rgba(38, 40, 44, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #e8eaed;
  font-size: 12.5px;
  transform-origin: right center;
  transition: background 0.28s ease, padding 0.28s ease, transform 0.28s ease;
}
.rd-sniff-dock.collapsed {
  padding: 0;
  background: rgba(38, 40, 44, 0.6);
}
.rd-sniff-txt {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* `#462`（`D14`=A）播放器页线路的写明：次要信息，弱化但可读（不抢主文案与按钮的视线） */
.rd-sniff-note {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: #cfd3d8;
  font-size: 11.5px;
  cursor: help;
}
.rd-sniff-fold {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.rd-sniff-fold:hover { background: rgba(255, 255, 255, 0.12); }
.rd-sniff-badge {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.1);
  color: #e8eaed;
  font-size: 13px;
  cursor: pointer;
}
.rd-sniff-badge:hover { background: rgba(255, 255, 255, 0.2); }
.rd-html { padding: 0; }
/**
 * `#432` **HTML 正文：iframe 定高自滚**（不再按内容高度撑开，`htmlFrameH` 已删）。
 *
 * ## 缺陷（用户 2026-10-13：LOFTER 热文文章页「一直跳顶、内侧滚动条时隐时现、无法滚动」）
 * 旧做法是父页按 `scrollHeight` 设 iframe 高度。但不透明 origin 的 iframe 里
 * **`vh`/`dvh` 就是 iframe 自己的高度**，而这类正文的 CSS 大量用它
 * （LOFTER 那份 `style`：`min-height:60vh`、`max-height:85vh`、`.cpop{max-height:90vh}`、
 * `.cpop-list{overflow-y:auto}`、`.cb{max-height:100%;overflow-y:auto}`）⇒
 * 「iframe 变高 ⇒ 60vh 变大 ⇒ scrollHeight 变大 ⇒ iframe 更高」互为因果：高度反复变 ⇒
 * 父页 `scrollTop` 被反复钳位（跳顶）+ 那些 `overflow:auto` 的区块随高度出现/消失滚动条。
 *
 * ## 现在
 * iframe 高度 = 正文格可见高（`.se-body` 是 `flex:1; min-height:0`，高度确定），
 * 由 **iframe 自己滚**：`vh/dvh` 有稳定基准、只有一条滚动条、滚轮走原生（壳层滚轮桥会先判
 * 「本文档视口能不能滚」，能滚就不转发，见 `buildWheelBridge`）。
 * ⚠️ `.se-body` 改成 flex 列：正文标题（`.rd-chapter`）与页内导航条（`.rd-navbar`）
 * 要保持自然高度，只有 iframe 去吃剩余空间。
 *
 * ⚠️⚠️ **面板必须有确定高度**（`.se-panel.rd-html-view{height:92vh}`），否则会**塌成一条**：
 * `.se-panel` 平时是 `height:auto`（由内容定高，短章不留大片空白）。而「撑满剩余高度」的
 * 子项在 auto 高容器里 hypothetical size 就是 `flex-basis:0` ⇒ 容器高 ≈ 0 ⇒ iframe 0 高。
 * （用户 2026-10-13 实测：改成定高后所有 RSS 源正文只剩「窄窄一横条」，就是这个依赖成环。）
 */
.se-body.se-html { overflow: hidden; display: flex; flex-direction: column; }
.se-panel.rd-html-view { height: 92vh; }
/* `#468①`：横向同样必须 `min-width:0` —— flex 子项默认 `min-width:auto`（= 最小内容宽度），
   iframe 内不可断行内容会把弹性项顶到 ~300px 再也压不动，表现为「最大化后正文只剩窄一条」。 */
.se-body.se-html > .rd-html { flex: 1 1 0; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.se-body.se-html .rd-html-frame { flex: 1 1 0; min-height: 0; min-width: 0; }
.rd-html-frame {
  display: block;
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 8px;
  background: #fff; /* 源页面多为浅色底，深色主题下不留一圈突兀的深色边框 */
}
/* ── 翻页动画（`PageAnim.kt:9-17`）────────────────────────────────
 * Web 是滚动式阅读，这里用「章节内容进场动画」近似上游的分页动画：
 *   0 覆盖  = 新章从右侧盖进来（translateX + opacity）
 *   1 滑动  = 新章从右侧滑入（更平移）
 *   2 仿真  = 简化的 3D 翻页
 *   3 滚动  = 无进场动画（默认）
 *   4 无动画 = 明确不动画
 */
.rd-anim-cover { animation: rd-anim-cover 0.28s ease both; }
@keyframes rd-anim-cover {
  from { transform: translateX(32px); opacity: 0.25; }
  to   { transform: none; opacity: 1; }
}
.rd-anim-slide { animation: rd-anim-slide 0.36s ease both; }
@keyframes rd-anim-slide {
  from { transform: translateX(64px); opacity: 0; }
  to   { transform: none; opacity: 1; }
}
.rd-anim-sim { animation: rd-anim-sim 0.36s ease both; transform-origin: left center; }
@keyframes rd-anim-sim {
  from { transform: perspective(1200px) rotateY(12deg) translateX(28px); opacity: 0.2; }
  to   { transform: none; opacity: 1; }
}
.rd-anim-none { animation: none; }

/* ── `#825` 分页模式（**测量切页 + 只渲染当前页 ±1**）────────────────────────
 * ## 结构
 *   `.se-body.se-paged`   只有 `overflow:hidden`，**不再有任何 `column`**
 *     `.se-paged-view`    限宽 918 / 100% 高，裁掉窗口外的一切
 *       `.se-paged-track` 绝对定位铺满（放当前页 ±1，共 3 页）
 *         `.se-paged-page` 每页绝对铺满 + `translateX(dx * 100%)`
 *           `.rd-content`  本页正文（padding 来自 `--rd-pt/pr/pb/pl`）
 *
 * ## 为什么不再用 column（用户实测「翻一两页就失灵」的根因）
 * 列几何是浏览器算的，而且**整章一起重排**：字体晚到、窗口 resize、页眉高度变化、
 * 图片加载完 —— 任何一条都会让列宽/位移失效。`#811` 只是把「滚动回调里写 inline 列宽」
 * 这个自触发回路掐掉，方案本身仍然不可靠。
 *
 * 现在页的边界是 `utils/paged-layout.ts` **量出来的字符区间**；翻页只改页码 + 换切片，
 * 位移动画只碰 `transform`（合成器完成，不触发布局）。布局只在首次进入 / 签名变化时重建。
 */
.se-body.se-paged {
  box-sizing: border-box;
  overflow: hidden;
  /* 分页不需要滚动条（翻页是换切片，不是滚动） */
  scrollbar-gutter: auto;
}
.se-paged-view {
  position: relative;
  width: 100%;
  max-width: 918px;
  height: 100%;
  margin: 0 auto;
  overflow: hidden;
}
/* 仿真档（pageAnim=2）的横向拖拽：touch 下只放行纵向，否则浏览器会把横拖当成 pan 抢走 */
.se-body.se-paged-2 .se-paged-view { touch-action: pan-y; }
.se-paged-track { position: absolute; inset: 0; }
.se-paged-page {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  backface-visibility: hidden;
  will-change: transform;
  /* `#830` 覆盖 / 仿真动画期间两页会**重叠** ⇒ 每页必须有**不透明底**，
     否则旧页文字会透到新页上（滑动模式不重叠，但统一底色不改变观感）。
     底色取 `--rd-bar-bg`（store `readerBackdropVars` 注入 = 当前阅读底色）。 */
  background: var(--rd-bar-bg, var(--bg-1));
}
/* `#830` 背景图（若配置了）在每页上复刻一层：页面是不透明底 ⇒ 不复刻就会把面板那层
   背景图挡住。⚠️ 逐页 copy 的锚点与面板那层可能有几像素差异（已知近似，见 rounds 文档）。 */
.se-paged-page::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: var(--rd-bg-img, none);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  opacity: var(--rd-bg-img-alpha, 1);
  pointer-events: none;
}
/* 每页 = 一个完整的正文格：padding 与滚动模式同一组变量（`--rd-pt/pr/pb/pl`） */
.se-paged-page > .rd-content {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
/* ★ 前后页只是**预渲染**（用来做翻页位移），不能让它们参与框选：
   否则从本页拖出去会把隔壁页的字一起选进 `selRange`（跨页选区的端点映射必然失败）。 */
.se-paged-page:not(.se-paged-current) { user-select: none; }
.se-paged-page:not(.se-paged-current) * { user-select: none; }
/* 最后一页若带「附加内容」（歌词/弹幕），允许它在页内纵向滚动 ——
   它**没参与测量**（在正文之后追加），裁掉就等于丢内容。 */
.se-paged-page.se-paged-last > .rd-content { overflow-y: auto; }
/* 段中续片：跨页的一段**不缩进**（上一页已经缩进过了）。测量侧同一口径，见 paged-layout.ts */
.se-paged-page .rd-content p.rd-p-cont { text-indent: 0; }
/* 首次进入 / 换章时的排版提示（非常短，避免空白页） */
.se-paged-wait {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
  font-family: var(--font);
  pointer-events: none;
}

/* `#849` 仿真档卷曲覆盖层：铺满分页视口、不吃指针事件（点击继续由 `.se-body` 处理）。
   静置时 `visibility:hidden`（只藏不卸 ⇒ WebGL 引擎与着色器不再重复创建）。 */
.se-paged-curl {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  visibility: hidden;
}
.se-paged-curl--on { visibility: visible; }

/* ★ 分页必须**容器定高**（`height` 而非只有 `max-height`）：
 *   没有它，`.se-body` 拿不到确定高度，测出来的「一页多高」就是错的。
 *   链条: `.se-panel`(92vh) → `.se-scroll`(flex:1;min-height:0) → `.se-body`(flex:1) → `.se-paged-view`(100%) */
.se-paged-host {
  height: 92vh;
  max-height: 92vh;
}

/* ---- `#830` 四档翻页动画（`PageAnim.kt:9-17`）----
 * ★★ 四种是**四套几何模型**，不是「一套 translateX 换参数」：
 *   0 覆盖 = **旧页滑走、新页固定被揭开**（上游 `withClip` + `withTranslation` 的几何）
 *            · 前进：旧页 0 → -100% 滑走（带 30px 页边阴影），新页在下不动
 *            · 后退：新页 -100% → 0 滑回来盖住，旧页被 keyframes「按住」直到盖满
 *   1 滑动 = 新旧两页**一起**水平位移（同一条轨道同步平移）
 *   2 仿真 = 旧页绕书脊（左缘）旋转翻走 / 新页旋转落回（透视 + 页边阴影）
 *            ⚠️ **近似**：真卷曲需要 shader / Canvas 逐帧网格变形，代价过高；
 *            这里用「透视旋转 + 静态页边阴影」表达翻书感（见 rounds 文档的说明）
 *   3 滚动 = 线性匀速连续位移（无缓动、无阴影、无离散「翻页」观感）
 *   4 无动画 = 瞬切
 *
 * ## 性能红线（本块是唯一实现，别把几何搬回 JS）
 * · 动画期间**零测量、零重排**：`gotoPage` 只改页码，几何全交给合成器；
 * · 可动画属性只有 `transform` / `opacity`；页边阴影用**静态 `box-shadow`**（不逐帧改）；
 * · 页面按 `se-pg-in` / `se-pg-out` 角色挂不同规则，角色只在一次翻页的窗口内存在
 *   （`markFlip` 的 timer 清空，见脚本注释）⇒ 连续快速翻页时 class 会重排但不会累积；
 * · 降低动效偏好：`prefers-reduced-motion: reduce` ⇒ 统一降级为瞬切（本块末尾的媒体查询）。
 */
/* 滑动 / 滚动：所有页同时位移（区别是缓动曲线与**方向轴** —— 滑动有加减速、水平；
   滚动匀速、**纵向从下往上**，见脚本 `pagedVertical`）。
   `#848` 滑动时长在原来 0.26s 基础上 +20% 后取整为 **0.33s**（用户要求不留三位小数）；
   与 `FLIP_MS[1]` 必须同步。 */
.se-paged-1 .se-paged-page { transition: transform 0.33s cubic-bezier(0.22, 0.61, 0.36, 1); }
.se-paged-3 .se-paged-page { transition: transform 0.3s linear; }

/* 覆盖：**上游几何**（`withClip` + `withTranslation(distanceX-width)`）——
 *  旧页滑走、新页固定被「揭开」；移动页抬到上层，页边挂 ~30px 阴影。
 *  前进：旧页 0 → -100%（被揭开的是新页）；后退：新页 -100% → 0 盖回去（旧页在下按住）。
 *  ⚠️ 与「新页盖上去」的直觉相反 —— 以上游为准（Q2 调研结论）。 */
.se-paged-0.se-flip-fwd .se-paged-page.se-pg-out {
  z-index: 2;
  box-shadow: 30px 0 30px rgba(0, 0, 0, 0.28);
  transition: transform 0.24s ease-out;
}
.se-paged-0.se-flip-fwd .se-paged-page.se-pg-in { transition: none; }
.se-paged-0.se-flip-back .se-paged-page.se-pg-in {
  z-index: 2;
  box-shadow: 30px 0 30px rgba(0, 0, 0, 0.28);
  transition: transform 0.24s ease-out;
}
.se-paged-0.se-flip-back .se-paged-page.se-pg-out { animation: rd-cover-hold 0.24s linear both; }
@keyframes rd-cover-hold {
  from, to { transform: translateX(0); }
}

/* 仿真：绕书脊旋转；旋转页抬到上层，静止页在下不动 */
.se-paged-2.se-flip-fwd .se-paged-page.se-pg-out {
  z-index: 2;
  transform-origin: left center;
  box-shadow: -16px 0 30px rgba(0, 0, 0, 0.35);
  animation: rd-sim-out 0.32s cubic-bezier(0.3, 0, 0.4, 1) both;
}
.se-paged-2.se-flip-fwd .se-paged-page.se-pg-in { transition: none; }
.se-paged-2.se-flip-back .se-paged-page.se-pg-in {
  z-index: 2;
  transform-origin: left center;
  box-shadow: 12px 0 30px rgba(0, 0, 0, 0.35);
  animation: rd-sim-in 0.32s cubic-bezier(0.2, 0.5, 0.4, 1) both;
}
.se-paged-2.se-flip-back .se-paged-page.se-pg-out { animation: rd-cover-hold 0.32s linear both; }
@keyframes rd-sim-out {
  from { transform: perspective(1400px) rotateY(0deg); opacity: 1; }
  to   { transform: perspective(1400px) rotateY(-70deg); opacity: 0.92; }
}
@keyframes rd-sim-in {
  from { transform: perspective(1400px) rotateY(-70deg); opacity: 0.92; }
  to   { transform: perspective(1400px) rotateY(0deg); opacity: 1; }
}

/* 无动画：明确关掉一切过渡（含角色规则，避免被上面的选择器意外命中） */
.se-paged-4 .se-paged-page,
.se-paged-4 .se-paged-page.se-pg-in,
.se-paged-4 .se-paged-page.se-pg-out { transition: none; animation: none; }

/* `#830` 降低动效偏好 ⇒ 瞬切（用户要求「自动降级为滚动或无动画」） */
@media (prefers-reduced-motion: reduce) {
  .se-paged-page { transition: none !important; animation: none !important; }
}

/* 翻到首/末页仍要翻时的**边界提示**（点不到内容了，给一下视觉反馈） */
.se-paged-edge-l::before,
.se-paged-edge-r::before {
  content: '';
  position: absolute; top: 0; bottom: 0; width: 64px;
  background: linear-gradient(var(--edge-dir, to right), rgba(127,127,127,0.18), transparent);
  pointer-events: none; z-index: 3;
}
.se-paged-edge-l::before { left: 0; --edge-dir: to left; }
.se-paged-edge-r::before { right: 0; --edge-dir: to right; }

/* ---- 分页翻页控件（左右箭头 + 居中页码）----
 * 绝对定位浮层（`.se-body` 内、`.se-paged-view` 之外）：不占正文流，也不参与测量。
 * 正文可用高在 `buildPagedInput()` 里扣掉了 `PAGED_NAV_RESERVE`（34px），页尾留白正好给它。
 * `position: absolute` 贴在浮层底部中央（`#402` 起底部浮动条已移除，仍上让 46px 留白）。 */
.se-paged-nav {
  position: absolute;
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg-1) 88%, transparent);
  border: 1px solid var(--border-strong);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(3px);
}
.se-paged-arrow {
  width: 26px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 999px; cursor: pointer;
  background: transparent; color: var(--text-1);
  font-size: 17px; line-height: 1; font-family: var(--font);
  padding: 0;
}
.se-paged-arrow:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand); }
.se-paged-arrow:disabled { opacity: 0.3; cursor: default; }
.se-paged-num {
  min-width: 62px;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-1);
  font-variant-numeric: tabular-nums; /* 页码跳动时数字不左右抖 */
  user-select: none;
}

/* 章节标题：`titleSize = 0`（上游哨兵）时 `--rd-title-fs` 是 `inherit` ⇒ 跟随正文大小 */
.rd-chapter { font-family: var(--rd-title-font, inherit); font-size: var(--rd-title-fs, inherit); }
/**
 * **正文段落**（`#145` 排版 + `#164` 下划线）。
 *
 * ⚠️ 下划线用 `text-decoration` 而**不是** `border-bottom`：上游 `TextLine.kt` 画的是**每行**一条线，
 * `border-bottom` 只在段尾画一条（多行段落会差很多）。
 * ⚠️ `text-underline-offset` **不能**写进 `text-decoration` 简写（CSS 不接受）⇒ 单独一条，
 * 值来自 `--rd-ul-body-offset`（装配见 `styles/reader-theme.ts` 的 `readerUnderlineVars`）。
 */
.rd-content p {
  margin: 0 0 var(--rd-ps, 2px);
  text-indent: var(--rd-indent, 2em);
  text-decoration: var(--rd-ul-body, none);
  text-underline-offset: var(--rd-ul-body-offset, 0px);
}
/**
 * **当前阅读的章节标题**（与目录里那个「目录（N 章）」标题**共用** `.rd-chapter`，
 * 所以额外挂一个 `rd-book-title` 来区分 —— **只加不改**，既有按 `.rd-chapter` 的断言不受影响）。
 *
 * ⚠️ 它**不在** `.rd-content` 里面（是兄弟节点），所以 `:style` 要**单独绑一次** `readerStyleVars`
 * （见模板）。不绑的话标题拿不到 `--rd-title-*` / `--rd-ul-title*`，设置就成了「只有正文生效」。
 */
/* ⚠️ 各处 `var(--x, 默认)` 的**默认值一律取上游 `Config()` 的 Kotlin 默认值**（不取「改之前的观感」）——
   否则「设置没同步过来」和「默认值」会渲染成两个样子，而两者本该完全一致。
   代价：标题上下间距的默认值由原来的 `14px/8px` 变成上游的 `0/0`（工具栏自带 8px 下边距，不会贴死）。 */
.rd-book-title {
  color: var(--rd-title-color, inherit);
  display: var(--rd-title-display, block);
  text-align: var(--rd-title-align, left);
  margin-top: var(--rd-title-mt, 0px);
  margin-bottom: var(--rd-title-mb, 0px);
  line-height: var(--rd-title-lh, inherit);
  text-decoration: var(--rd-ul-title, none);
  text-underline-offset: var(--rd-ul-title-offset, 0px);
}
/**
 * 高亮的**底色 / 下划线 / 文字色**由 `#256` 起全部来自「这一条自己的样式」
 * （`highlightStyleVars()` 写 inline style），这里只剩**结构**:指针、形状、悬停反馈。
 *
 * ⚠️ `#146`~`#255` 那份实现把底色（`rgba(255,193,7,.28)`）与一条 `border-bottom` **硬编码**在这里
 *   ⇒ 用户在样式里怎么改都盖不住它，且「底色」与「下划线」两条通道必然打架。
 *   现在默认样式改由 `HIGHLIGHT_STYLE_DEFAULT`（`utils/highlight-style.ts`）提供，
 *   老的 `style: ''` 数据由 `visibleHighlightStyle()` 兜到默认样式 ⇒ **升级后观感不变**。
 */
.rd-hl { cursor: pointer; }
/* 悬停反馈不写死颜色（底色已被用户改过 ⇒ 写死色会跟当前样式打架）：整体压暗一点即可 */
.rd-hl:hover { filter: brightness(0.94); }
/**
 * 底色形状（对应上游 `HighlightStyle.FillShape`，`#258` 起 **6 种齐**）。
 * ⚠️ 这份数值与 `HighlightStyleDialog.vue` 里预览条的 `.hls-preview-box :deep(.rd-hl-shape-*)`
 *   **必须同步**（`scoped` 样式不能跨组件继承）—— 改形状要改两处。
 *
 * ★ 只有 `rounded` / `pill` / `marker` 靠 `border-radius` 表意；另外三种是「铺法」不同：
 *   `rectangle` = 铺满、`half` / `baseline` = 用 `background-image` 的 `linear-gradient`
 *   只铺一条带（`background-color` 做不到），所以它们在 CSS 里只需**取消圆角**
 *   （上游 `drawFillRun` 对 HALF/BASELINE 走的就是 `drawRect`，无圆角）。
 */
.rd-hl-shape-rectangle { border-radius: 0; }
.rd-hl-shape-rounded { border-radius: 3px; }
/* 胶囊：`999px` 会被浏览器**自动收窄**到「短边的一半」⇒ 细长盒子自然成胶囊，不需要 padding */
.rd-hl-shape-pill { border-radius: 999px; }
/* 马克笔：四角**不等**的圆角 + 竖直方向多出 1px（模拟笔尖扫过的痕迹，不是上游的路径绘制） */
.rd-hl-shape-marker {
  border-radius: 6px 10px 4px 12px / 10px 5px 12px 6px;
  padding: 1px 2px;
}
/* 下半 / 基线带（`#258`）：带子的位置由 inline 的 `background-image` 决定，这里只管「不要圆角」 */
.rd-hl-shape-half,
.rd-hl-shape-baseline { border-radius: 0; }
/**
 * 「本次跳转的命中处」临时标记（`#146` 书内搜索）。
 * 与高亮**同色系但更醒目**（左边框 + 更实的底），2.6 秒后由 `flashRange` 自动清掉。
 * 它不是用户数据：不落库、不可点删（点在它上面仍走「删划线」逻辑，只是那时它已经消失了）。
 * ⚠️ 它排在 `.rd-hl` 之后且权重相同 ⇒ 同名属性以它为准（inline 的 `--hl-*` 样式仍是 inline 更高）。
 */
.rd-hl-flash {
  background: rgba(255, 152, 0, 0.55);
  box-shadow: inset 2px 0 0 0 rgba(230, 81, 0, 0.95);
}
/* 书内搜索结果（侧栏第三个 tab） */
.rd-search-regex { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-1); white-space: nowrap; }
.rd-search-prog { padding: 6px 12px 0; font-size: 12px; color: var(--muted); font-family: var(--mono); }
.rd-search-note { padding: 6px 12px 0; font-size: 11.5px; color: var(--faint); }
.rd-search-list { flex: 1; overflow-y: auto; padding: 6px 8px 10px; }
.rd-search-hit {
  display: block; width: 100%; text-align: left; border: none; background: none; cursor: pointer;
  padding: 6px 8px; border-radius: 6px; color: var(--text-0); font-family: var(--font);
}
.rd-search-hit:hover { background: var(--brand-soft); }
.rd-search-hit .h { display: block; font-size: 12px; color: var(--acc-dim); margin-bottom: 2px; }
.rd-search-hit .s { display: block; font-size: 12.5px; color: var(--text-1); line-height: 1.55; word-break: break-all; }
/* 命中词：**继承片段本身的文字色**（不换成强调色 —— 靛蓝压黄底不好看，且换色后对比度不可控），
   用加粗 + 黄底 + 圆角标出，任何主题下都保证可读 */
.rd-search-hit .s em { font-style: normal; font-weight: 700; color: inherit; background: rgba(255, 193, 7, 0.42); border-radius: 2px; }
.rd-ch.rd-vol { color: var(--muted, #8a8f98); font-weight: 600; text-align: left; cursor: default; background: transparent; border-left: 3px solid var(--line, #2a2d34); padding: 6px 8px; }
/* flex 行内的省略：`.t` 必须 `min-width:0`，否则 flex 项不会小于内容宽度、ellipsis 失效 */
.rd-ch .t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* `#489` 未缓存章节的云朵标记（line 风格、弱色：不抢标题，扫一眼能看出哪些还没落地） */
.rd-ch .ic-cloud {
  flex: 0 0 auto; width: 13px; height: 13px; color: var(--muted, #8a8f98); opacity: 0.8;
}
/* 上游 `upHasCache`：当前章显示 ✓（与云朵同一位置，避免当前章被误标成「未缓存」） */
.rd-ch .ic-cached {
  flex: 0 0 auto; width: 13px; height: 13px; color: var(--accent, #4c8bf5); opacity: 0.9;
}
.rd-ch.is-cur .ic-cloud { color: var(--text-1); opacity: 0.9; }
/* #490 退出未进书架书籍时的「是否加入书架」确认条 */
.rd-ask-mask { position: absolute; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); }
.rd-ask { width: min(360px, 86%); padding: 18px 20px 14px; background: var(--bg2, #1b1e26); color: var(--text-0, #e8ecf1); border: 1px solid var(--border, #2a2d34); border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4); }
.rd-ask-t { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.rd-ask-s { margin: 0 0 14px; font-size: 12.5px; color: var(--muted, #8a8f98); line-height: 1.6; }
.rd-ask-btns { display: flex; justify-content: flex-end; gap: 8px; }
.rd-ask-btns .primary { border-color: var(--acc-dim, #4f8cff); color: var(--acc, #4f8cff); }
/* tag（源可给「字数/更新时间」这类附加信息）**最多占 42%**，超了自己省略，绝不挤掉标题 */
.rd-ch .tag {
  flex: 0 1 auto; max-width: 30%; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted, #8a8f98); font-size: 11px;
}
.rd-ch .badge { flex: none; font-size: 10px; padding: 0 4px; border-radius: 3px; margin-left: 4px; }
.rd-ch .badge.vip { background: #b8860b; color: #fff; }
.rd-ch .badge.pay { background: #a33; color: #fff; }
/* `#294` 「当前章」的选中态：只描个边在密集目录里根本认不出来（用户 2026-10-05 实测
   「应该处于选中态」）⇒ 补成「品牌色底 + 加粗 + 左侧竖条」，与源管理/发现页的选中样式同一观感。 */
.rd-ch.is-cur {
  outline: 1px solid var(--accent, #4c8bf5);
  background: var(--brand-soft, rgba(76, 139, 245, 0.14));
  color: var(--brand, #4c8bf5);
  font-weight: 700;
  box-shadow: inset 3px 0 0 0 var(--accent, #4c8bf5);
}
.rd-sub { margin-top: 14px; opacity: .85; }
.rd-sub summary { cursor: pointer; font-size: 12px; }
.rd-sub-body { white-space: pre-wrap; font-size: .9em; line-height: 1.7; }
/* `#583` 源按钮（正文里的段评气泡 / 本章说 / 神评 / 书评）
   · 气泡：行内小图，高度跟随字号（不撑行高）；
   · 整宽条：源图是 1000×120，按高度收一半左右（用户 2026-10-23：太大太高 ⇒ 收一半、文字相应缩小）。 */
.rd-ui-bubble {
  display: inline-block;
  height: 1.05em;
  width: auto;
  max-width: none;
  vertical-align: -0.18em;
  margin: 0 3px;
  cursor: pointer;
}
.rd-ui-bar {
  display: block;
  height: auto;
  max-height: 36px;
  width: auto;
  max-width: 100%;
  margin: 6px auto;
  cursor: pointer;
}
.rd-ui-end { margin-top: 10px; }
.rd-media { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
/* gap:0 + 图片 display:block —— 逐图之间不留任何细缝（此前 2px 会看到一条线） */
.rd-comic { display: flex; flex-direction: column; gap: 0; line-height: 0; font-size: 0; }
/* SINGLE：一屏一张图（滚动吸附，对齐 Legado imgStyleSingle）。
   `#834` 吸附与「至少一屏」挂到**占位容器**上：图片现在装在 `.rd-imgwrap` 里，
   旧选择器 `.rd-comic.single img` 只会把 `<img>` 自身拉高、与容器的宽高比打架。 */
.rd-comic.single { scroll-snap-type: y mandatory; }
.rd-comic.single .rd-imgwrap { min-height: 92vh; scroll-snap-align: start; }
.rd-imgtext { opacity: .7; word-break: break-all; }
.rd-comic img { width: 100%; height: auto; display: block; background: #111; min-height: 60px; vertical-align: top; }
/* `#841` 三章拼接的章节分隔条：父级 line-height:0 ⇒ 这里补回来 */
.rd-comic .rd-comic-divider { line-height: 1.5; margin: 14px 0 10px; }
/* `#841` 3x 缩放：占位容器按倍数放大（横向溢出交给 `.rd-comic` 自己滚），
   纵向仍由 `.se-body` 照常滚 —— 不改任何 scrollTop 语义，拖拽平移在 pointer 回调里做。 */
.rd-comic.zoomed { overflow-x: auto; overflow-y: hidden; touch-action: none; cursor: grab; }
.rd-comic.zoomed .rd-imgwrap { flex: 0 0 auto; width: calc(100% * var(--rd-comic-zoom, 1)); }
.rd-comic.zoomed .rd-imgwrap img { width: 100%; }
/* 双击 → 满视窗大图查看器（用户 2026-11-09）：
   铺满窗口（只留导航/缩略图所需边距），点击空白关，底部缩略图条可跳转。 */
.rd-comic-viewer {
  position: fixed;
  inset: 0;
  z-index: 9200;
  background: rgba(0, 0, 0, 0.94);
  display: flex;
  align-items: stretch;
  justify-content: center;
}
.rd-cv-stage {
  position: absolute;
  inset: 12px 76px 104px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.rd-cv-stage img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  user-select: none;
  /* 图片自己吃点击 ⇒ 点图不关；点图四周的空白才落到根节点（`@click.self`）关闭 */
  pointer-events: auto;
}
.rd-cv-close {
  position: absolute; right: 14px; top: 14px; z-index: 2;
  width: 38px; height: 38px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.12); color: #fff; border: 1px solid rgba(255, 255, 255, 0.28);
  font-size: 18px; line-height: 1; cursor: pointer;
}
.rd-cv-close:hover { background: rgba(255, 255, 255, 0.22); }
.rd-cv-nav {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
  width: 48px; height: 96px;
  background: rgba(255, 255, 255, 0.1); color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 10px;
  font-size: 30px; line-height: 1; cursor: pointer;
}
.rd-cv-nav:hover:not(:disabled) { background: rgba(255, 255, 255, 0.24); }
.rd-cv-nav:disabled { opacity: 0.28; cursor: default; }
.rd-cv-prev { left: 12px; }
.rd-cv-next { right: 12px; }
.rd-cv-bar {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  background: rgba(0, 0, 0, 0.62);
  padding: 6px 12px 10px;
  display: flex; flex-direction: column; gap: 4px;
}
.rd-cv-count { color: rgba(255, 255, 255, 0.75); font-size: 12px; line-height: 1.6; }
.rd-cv-strip { display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; height: 66px; padding-bottom: 2px; }
.rd-cv-thumb {
  flex: none; padding: 0; height: 100%; background: #111;
  border: 2px solid transparent; border-radius: 4px; cursor: pointer;
}
.rd-cv-thumb.on { border-color: var(--accent, #4c8bf5); }
.rd-cv-thumb img { height: 100%; width: auto; display: block; object-fit: contain; }
/* 正文区颜色改由内联 `readerStyleVars` 提供（见 `#145` 的 CSS 注释），此处不再有 .rd-dark / .rd-sepia */
/* ⚠️ `#164`：这里**曾**有一条 `.rd-content p { margin: 0 0 14px; text-indent: 2em }`。
   它与上面的同选择器规则**权重相同且在后**，把 `--rd-ps` / `--rd-indent` 整个压掉
   ⇒ 「段距 / 缩进」两个设置在界面上**改了没反应**（而且不报错、控制台也干净）。
   已删除。**不要**再在这里补 `.rd-content p` 的第二条规则。 */
/**
 * 目录网格。
 *
 * ⚠️ `grid-auto-rows: max-content` 是**必需的**，不是可选项（用户实测：只有 1~2 章的短目录
 * 会把目录项拉高、占满整个浮层）。成因链：
 *   ① `.rd-toc-side` 是 `flex:1` ⇒ **容器高度确定**；
 *   ② 行的默认尺寸是 `auto`，而项（`.rd-ch`）带 `overflow:hidden` ⇒ 它的**最小内容尺寸为 0**；
 *   ③ 于是行既能被**拉伸**（项少、有正剩余空间）也能被**压缩**（项多、负剩余空间）。
 * 实测两种病态（`tmp/probe-toc-short.mjs` 的受控实验：把目录折叠到 2 项）：
 *   · 2 项  ⇒ 行高 **403px**（撑满 832px 容器，就是用户报的现象）
 *   · 2170 项 ⇒ 行高 **16px**，而项的内容需要 24px ⇒ **文字被垂直裁掉**（padding 只剩 2px）
 * 加 `grid-auto-rows: max-content` 后：2 项 35px、2170 项 35px（内容 33px 完整可见）。
 * ⚠️ 单加 `align-content: start` **不管用**（实测行高仍是 16px）—— 别只改那个。
 */
.rd-toc { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); grid-auto-rows: max-content; gap: 6px; max-height: 46vh; overflow: auto; }
/* 「没有匹配的章节」要占满整行（否则被当成一个网格单元挤在角落） */
.rd-toc .empty { grid-column: 1 / -1; }
/* `#769` 「目录可能不全」轻提示：一行、占满整行、不挡章节点击 */
.rd-toc .toc-warn {
  grid-column: 1 / -1;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--muted);
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  background: transparent;
}
/**
 * 目录项：**标题优先，tag 让位**（用户实测 ①，2026-09-27）。
 *
 * 起因：📂宜搜小说 的 `ruleToc.updateTime` 是 `字数：{{$.wordCount}} 时间：{{…}}`，
 * 每章都带一条很长的 tag（`字数：3394 时间：1970/01/18 12:32`）。
 * 之前 `.rd-ch` 是 `nowrap + ellipsis` 的**单行文本流**，tag 把整行挤满 ⇒
 * **连「第3章　看见」这种 6 字标题都被截成「第3章　看…」**，用户看到的
 * 就是「不管长短全是 名称+…」。
 *
 * 现在改成 flex：`.t` 占剩余空间（`min-width:0` 才能在 flex 里触发 ellipsis）、
 * tag 最多占 42% 且自己也能省略、徽章永不收缩。短标题因此能完整显示。
 */
.rd-ch {
  display: flex; align-items: center; gap: 6px;
  text-align: left; font-size: 13px; cursor: pointer;
  background: var(--bg2); color: var(--text-1);
  border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px;
  overflow: hidden; white-space: nowrap;
}
.rd-ch:hover:not(:disabled) { border-color: var(--acc-dim); color: var(--text-0); }

/* ③-1 目录筛选 + 正序/倒序（右侧） */
.rd-toc-filter {
  width: 150px; flex: none; padding: 5px 8px; border-radius: 7px;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--font); font-size: 12px; outline: none;
}
.rd-toc-filter:focus { border-color: var(--acc-dim); }
.rd-order { display: flex; align-items: center; gap: 6px; flex: none; user-select: none; }
.rd-order-label { font-size: 11px; color: var(--faint); }
.rd-order-label.on { color: var(--text-0); font-weight: 600; }
/* 开关（手写 button+span：`<input type="range">` 在 Vue 里 v-model 不自动转数字） */
.rd-switch {
  width: 34px; height: 18px; border-radius: 999px; padding: 2px; flex: none;
  border: 1px solid var(--line); background: var(--bg-3); cursor: pointer;
  display: inline-flex; align-items: center; transition: background 0.16s, border-color 0.16s;
}
.rd-knob { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); transition: transform 0.16s, background 0.16s; }
.rd-switch.on { background: var(--brand-soft); border-color: var(--brand); }
.rd-switch.on .rd-knob { background: var(--brand); transform: translateX(16px); }
.rd-ch:disabled { opacity: 0.6; }
.switch-panel { background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-top: 10px; max-height: 40vh; overflow: auto; }
.sw-item { padding: 6px 8px; font-size: 13px; color: var(--text-1); cursor: pointer; border-bottom: 1px solid var(--border); border-radius: 6px; }
.sw-item:hover { background: var(--bg3); }
.sw-src { color: var(--faint); font-size: 11px; margin-left: 8px; font-family: var(--mono); }
/* ============ 4-1 图片加载态 ============ */
/* 未加载时给一个**按宽高比撑开的占位**（黑底 + 转圈），这样「中间还缺一张图」一眼可见，
   也不会因为「固定 240px → 长图真实高 2000px」的落差把下面的图整体顶走（`#834`）。
   真实宽高比由内联 `aspectRatio` 覆盖；未知时用 2/3（竖版漫画页的常见比例）。 */
.rd-imgwrap {
  position: relative; width: 100%; aspect-ratio: 2 / 3;
  display: flex; align-items: center; justify-content: center;
  background: #111; overflow: hidden;
}
.rd-imgwrap.ok { background: transparent; }
.rd-imgwrap img { width: 100%; height: auto; display: block; }
.rd-imgload {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: #9aa0a6; font-size: 12px; pointer-events: none;
}
.rd-imgfail {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  color: #d98b8b; font-size: 12px;
}
.rd-spin {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid #3a3f46; border-top-color: #8a8f98;
  animation: rd-spin 0.8s linear infinite;
}
@keyframes rd-spin { to { transform: rotate(360deg); } }

/* ============ 4-2 固定工具栏（`#402` 起移除底部半透明浮动进度条）============ */
/* 上方的章内工具栏**固定不动**（`.se-body` 是滚动容器 ⇒ sticky 生效） */
.rd-toolbar {
  position: sticky; top: -14px; z-index: 4;   /* -14 抵消 .se-body 的 padding-top，贴住顶部不留缝 */
  background: var(--bg-1); padding: 6px 0 8px; margin-bottom: 6px;
  border-bottom: 1px solid var(--border);
}


/* 书签高亮闪烁（跳转书签后定位） */
.rd-flash { animation: rd-flash 1.5s ease; }
@keyframes rd-flash { 0%, 100% { background: transparent; } 25% { background: var(--brand-soft); } }
/* ★ `#218` 朗读当前段：常亮（不是闪一下就消失）。
   用户 2026-10-02：「当前句子应变色提醒，读完本句色恢复」⇒ 必须**常亮**，
   `rd-flash` 那套 1.5s 自动消失的动画在这里是错的（读完就没了，等于没提醒）。
   用**左侧竖条 + 淡底色**：不遮文字（朗读时要能看清字），且与「划线高亮」视觉上可区分。 */
.rd-content p.rd-speaking {
  background: var(--brand-soft);
  box-shadow: inset 3px 0 0 var(--brand);
  border-radius: 2px;
  transition: background 0.2s, box-shadow 0.2s;
}

/* ============ 4-3 缓存进度 / 侧滑目录 / 缓存对话框 ============ */
.rd-cachechip {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: 11.5px; color: var(--text-1); background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px;
}
.rd-cachechip-stop { border: none; background: none; color: var(--muted); cursor: pointer; font-size: 11px; }
/* 5-4：「详情/目录来自本地」提示 */
.se-cachechip {
  flex: none; font-size: 10.5px; color: var(--text-1);
  background: var(--bg-3); border: 1px solid var(--border); border-radius: 999px; padding: 2px 7px;
}
/* 目录/书签浮层：**在阅读浮层内部**（父级 `.se-panel` 是 relative）⇒ 它的高度跟着浮层走，
   不再铺满整个窗口高度（用户 A：要「阅读界面的一个子浮层」的观感）。 */
.rd-side-mask { position: absolute; inset: 0; z-index: 6; background: rgba(0, 0, 0, 0.28); border-radius: var(--r); }
.rd-side {
  position: absolute; top: 0; right: 0; bottom: 0; width: min(400px, 86%);
  display: flex; flex-direction: column;
  background: var(--bg-1); border-left: 1px solid var(--border-strong);
  border-radius: 0 var(--r) var(--r) 0;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.28);
  animation: rd-slide-in 0.18s ease;
}
@keyframes rd-slide-in { from { transform: translateX(18px); opacity: 0.4; } to { transform: none; opacity: 1; } }
/* `#164`：tab 变成 4 个（目录/书签/搜索/样式）⇒ 允许换行，窄屏下不会把「✕」挤出可视区 */
.rd-side-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
/* 「样式」tab 的内容比目录长得多 ⇒ 自身滚动，别把头部顶出去 */
.rd-side-scroll { flex: 1; overflow-y: auto; padding: 8px 12px 14px; }
.rd-side-tab {
  border: none; background: none; color: var(--muted); cursor: pointer;
  font-size: 13px; padding: 4px 2px; font-family: var(--font);
}
.rd-side-tab.on { color: var(--text-0); font-weight: 700; box-shadow: inset 0 -2px 0 var(--brand); }
.rd-side-tools { display: flex; align-items: center; gap: 8px; padding: 10px 12px 4px; }
/* 侧滑目录**单列**（用户 A 要求）：宽度只有 400px，两列会把标题挤断 */
.rd-toc-side { flex: 1; min-height: 0; max-height: none; overflow: auto; padding: 6px 12px 14px; grid-template-columns: 1fr; }
.rd-bm-list { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; }
.rd-bm { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: var(--bg-2); }
.rd-bm-head { display: flex; align-items: center; gap: 6px; }
.rd-bm-ch { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--text-0); font-weight: 600; }
.rd-bm-time { flex: none; font-size: 11px; color: var(--faint); font-family: var(--mono); }
.rd-bm-text { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.rd-dlg-mask { position: absolute; inset: 0; z-index: 7; background: rgba(0, 0, 0, 0.42); display: flex; align-items: center; justify-content: center; }
.rd-dlg { width: min(520px, 92vw); background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); padding: 16px; box-shadow: var(--shadow); }
.rd-dlg-style { width: min(560px, 92vw); max-height: min(680px, 86vh); display: flex; flex-direction: column; padding: 0; }
.rd-dlg-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.rd-dlg-head strong { font-size: 15px; color: var(--text-0); }
.rd-dlg-sub { font-size: 11.5px; color: var(--muted); }
/* ★ `#231`：浮层本身有 `max-height`，但内部没有滚动区 ⇒ 「信息」Tab 项多时**溢出到浮层外**
   （用户 2026-10-03 截图：字号滑块压在正文上）。做法：让 `.rsp` 参与 flex 布局并可收缩，
   滚动交给 `.rsp-body`（Tab 行与底部说明保持固定不滚）。 */
.rd-dlg-style .rsp { padding: 12px 16px 16px; flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* `#814`：自动滚动块 —— 同底色卡，一眼能看出「这也是阅读行为设置」。
   `#817`：改为渲染在 `ReadStylePanel` 的「动画」Tab 里（`.rsp-body` 之后）⇒
   不再需要自己撑横向外边距（父级 `.rsp` 已给 16px 内边距），只留一段上间距。 */
.rd-style-autoscroll {
  flex: none; margin: 10px 0 0; padding: 10px 12px 4px;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-2);
}
.rd-style-autoscroll-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; color: var(--text-0); font-weight: 600; flex-wrap: wrap; }
/* `#817` 分页时卡内可见提示（不再只靠滑块 tooltip —— 禁用后不触发 hover） */
.rd-style-autoscroll-note { font-size: 11.5px; line-height: 1.6; color: var(--muted); padding: 2px 0 4px; }
.rd-style-autoscroll-note b { color: var(--brand); }
.rd-dlg-tip { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 0 0 12px; }
.rd-dlg-row { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.rd-dlg-num {
  width: 88px; padding: 5px 8px; border-radius: 7px; background: var(--bg-3);
  border: 1px solid var(--line); color: var(--text-0); font-family: var(--mono); font-size: 13px;
}
.rd-dlg-prog { margin-top: 10px; font-size: 12px; color: var(--text-1); font-family: var(--mono); }
.rd-dlg-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

/* ============ 4-4 选中文字菜单 ============ */
/**
 * ★★ 必须用**纯淡入**的关键帧，不能用全局 `fadein`：
 * 全局 `fadein` 的关键帧是 `from { opacity:0; transform: translateY(6px) } to { opacity:1; transform:none }`，
 * **动画期间 transform 会被关键帧覆盖** ⇒ 菜单先以「left=选区中心、top=选区上方 8px、且没有 -50%/-100% 偏移」
 * 画出来（看着就在**鼠标右侧、鼠标能点到「复制」**），0.12s 动画结束后才弹回
 * `translate(-50%, calc(-100% - 8px))` 的正确位置 —— 正是用户 2026-09-28 报的「先出现在鼠标右侧再跳到文字上方」。
 * 所以这里自己定义一个**只动 opacity** 的关键帧。
 * （通用教训：给**自带 transform** 的元素套 CSS 动画前，先看关键帧里有没有 transform。）
 */
@keyframes rd-menu-in { from { opacity: 0; } to { opacity: 1; } }
.rd-selmenu {
  position: fixed; z-index: 1030; transform: translate(-50%, calc(-100% - 8px));
  display: flex; gap: 2px; padding: 4px; border-radius: 8px;
  background: var(--bg-3); border: 1px solid var(--border-strong); box-shadow: var(--shadow);
  animation: rd-menu-in 0.1s ease;
  /* ★ 菜单本身不参与文字选择：鼠标拖过时不会把「复制/全选…」选进选区（用户报的「误选中」） */
  user-select: none;
}
/* 选区贴顶（上方放不下菜单）⇒ 改挂到选区下方 */
.rd-selmenu.below { transform: translate(-50%, 8px); }
.rd-selmenu button {
  border: none; background: none; color: var(--text-0); cursor: pointer;
  font-size: 12px; padding: 5px 9px; border-radius: 6px; font-family: var(--font);
}
.rd-selmenu button:hover:not(:disabled) { background: var(--brand-soft); color: #fff; }
/* 高亮/笔记在「标题、图片、选区跨出正文」时禁用 —— 要给用户看得出的理由，而不是点了没反应 */
.rd-selmenu button:disabled { opacity: 0.4; cursor: not-allowed; }
/* `#807` `D3`：正文右键菜单 —— 与选区菜单同一外观，但**随光标**定位（无 translate 居中）且纵向排列 */
.rd-ctxmenu { transform: none; flex-direction: column; align-items: stretch; min-width: 128px; gap: 0; }
.rd-ctxmenu button { text-align: left; padding: 7px 10px; font-size: 13px; }

/* ── `#255` 选区菜单的「更多」二级下拉 ────────────────────────── */
/* 「更多」按钮展开时保持高亮，否则用户看不出下拉是从哪儿冒出来的 */
.rd-selmenu button.on { background: var(--brand-soft); color: #fff; }
/**
 * 下拉定位基准 = **菜单自己**（`.rd-selmenu` 带 `transform` ⇒ 它是定位容器）。
 * `right:4px` 正好落在菜单 padding（4px）内侧 = 最后一枚按钮的右缘 —— 不用额外的包裹元素。
 * 默认**向上**（菜单挂在选区上方时，朝上才不会盖住刚选中的字）；
 * 实际朝向由 `toggleSelMore()` 量完视口空间后决定（`.down` = 朝下）。
 */
.rd-sel-more {
  position: absolute; right: 4px; bottom: calc(100% + 6px); z-index: 1;
  display: flex; flex-direction: column; gap: 2px; padding: 4px; min-width: 104px;
  border-radius: 8px; background: var(--bg-3); border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
}
.rd-sel-more.down { bottom: auto; top: calc(100% + 6px); }
.rd-sel-more button { text-align: left; white-space: nowrap; }
/* 「笔记」的内联输入（替代 `window.prompt`：那个会阻塞页面、样式也与阅读界面脱节） */
.rd-notein { display: flex; align-items: center; gap: 4px; padding-left: 4px; }
.rd-notein-input {
  width: 190px; padding: 4px 7px; border-radius: 6px; font-family: var(--font); font-size: 12px;
  color: var(--text-0); background: var(--bg-1); border: 1px solid var(--border-strong);
}
.rd-selmenu button.primary { background: var(--brand-soft); color: #fff; }

/* ── `#256` 高亮的动作栏（点已有高亮弹出）────────────────────────
   对齐上游 `showHighlightActionMenu`：纵向 5 项（样式 / 备注 / 创建规则 / 复制 / 删除）。
   上游是 `popupActionMenu`（纵向列表 + 危险项标红），这里保持同一形态。 */
.rd-hl-menu {
  position: fixed; z-index: 1035; min-width: 132px;
  display: flex; flex-direction: column; padding: 4px;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 10px;
  box-shadow: var(--shadow); user-select: none;
}
.rd-hl-mi {
  text-align: left; white-space: nowrap; border: none; background: none; cursor: pointer;
  color: var(--text-0); font-family: var(--font); font-size: 13px;
  padding: 7px 12px; border-radius: 6px;
}
.rd-hl-mi:hover { background: var(--brand-soft); }
.rd-hl-mi.danger { color: var(--danger, #e5534b); }

/* ── `#256` 备注框（动作栏「备注」）───────────────────────────── */
.rd-hl-note-mask {
  position: fixed; inset: 0; z-index: 1300; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px;
}
.rd-hl-note {
  width: min(420px, 94vw); background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow); padding: 12px 14px 14px;
}
.rd-hl-note-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.rd-hl-note-head strong { font-size: 15px; color: var(--text-0); }
/* 引用这条高亮的原文 —— 让用户确认「改的是哪一条」（同一章可能有好几条） */
.rd-hl-note-quote {
  margin: 0 0 8px; padding: 6px 8px; border-left: 3px solid var(--border-strong);
  background: var(--bg-2); border-radius: 4px; font-size: 12.5px; color: var(--text-1);
  max-height: 66px; overflow: auto;
}
.rd-hl-note-input {
  width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--font); font-size: 13px;
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 7px 9px;
}
.rd-hl-note-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }

/* ── 选区菜单「替换」的快速新建对话框 ─────────────────────────── */
/* `#260`：选区「替换」的弹窗已换成共用组件 `ReplaceRuleDialog.vue`
   （原先这里有一组 `.rd-dlg-replace` / `.rr-quick*` 样式 —— 那正是「第二份字段表」的证据，
   一并删掉，避免以后有人照着它再写一个简化弹窗）。 */

/* ============ 4-5 字典结果（用户要求：尺寸取原一半 + 多 tab「点一个查一个」） ============ */
.rd-dict-mask { position: absolute; inset: 0; z-index: 7; background: rgba(0, 0, 0, 0.42); display: flex; align-items: center; justify-content: center; }
.rd-dict {
  /* 原为 `min(760px, 94vw)` / `84vh` —— 用户要先按**一半**看效果 */
  width: min(380px, 92vw); max-height: 42vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.rd-dict-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
/* tab 条：横向可滚（字典多时不出框） */
.rd-dict-tabs {
  display: flex; align-items: center; gap: 4px; padding: 7px 10px 0;
  border-bottom: 1px solid var(--border); overflow-x: auto; flex: none;
}
.rd-dtab {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 9px; border: 1px solid var(--line); border-bottom: none;
  border-radius: 7px 7px 0 0; background: var(--bg-3); color: var(--text-1);
  font-size: 11.5px; font-family: var(--font); cursor: pointer; white-space: nowrap;
}
.rd-dtab:hover { color: var(--text-0); border-color: var(--acc-dim); }
.rd-dtab.on { background: var(--bg-1); color: var(--text-0); border-color: var(--border-strong); font-weight: 700; }
.rd-dtab.done .rd-dtab-st { color: var(--green, #22c55e); font-size: 12px; }
.rd-dtab .rd-dtab-st { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.rd-dtab.retry { border-radius: 7px; border-bottom: 1px solid var(--line); }
.rd-dtab.retry:disabled { opacity: 0.45; cursor: default; }
.rd-dict-body { overflow: auto; padding: 10px 12px; }
.rd-dict-idle { font-size: 12px; color: var(--muted); padding: 6px 0; }
/* 「站点返回的短文本」提示块（未收录该词 / 404 / 代理回话） */
.rd-dict-note { font-size: 12px; line-height: 1.7; color: var(--text-1); background: var(--bg-3); border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; }
.rd-dict-note-h { display: block; color: var(--muted); font-size: 11.5px; margin-bottom: 4px; }
.rd-dict-note-t { display: block; font-family: var(--mono); font-size: 11.5px; color: var(--text-0); word-break: break-all; }
.rd-dict-note-hint { margin-top: 6px; font-size: 11px; color: var(--faint); }
.rd-dict-sec { border-bottom: 1px dashed var(--border); padding-bottom: 10px; margin-bottom: 10px; }
.rd-dict-sec:last-child { border-bottom: 0; }
.rd-dict-name { font-size: 12.5px; font-weight: 700; color: var(--brand); margin-bottom: 6px; }
.rd-dict-ms { font-size: 10.5px; color: var(--faint); font-family: var(--mono); margin-left: 6px; font-weight: 400; }
.rd-dict-html { font-size: 12.5px; line-height: 1.75; color: var(--text-1); word-break: break-word; }
/* ★ `v-html` 注入的内容**没有 scoped 属性** ⇒ 它下面的选择器必须用 `:deep()`
   （否则规则整条失效；探针靠 `getComputedStyle(...).cursor === 'pointer'` 抓到过这个疏漏） */
.rd-dict-html :deep(img) { max-width: 100%; height: auto; }
.rd-dict-html :deep(h1), .rd-dict-html :deep(h2), .rd-dict-html :deep(h3) { font-size: 13.5px; margin: 10px 0 4px; color: var(--text-0); }
.rd-dict-html :deep(a) { color: var(--brand); }
/* 字典站自己的样式表不会加载（我们只渲染 HTML）⇒ 发音按钮/表格/列表要我们自己给基础样式 */
.rd-dict-html :deep(table) { border-collapse: collapse; max-width: 100%; }
.rd-dict-html :deep(td), .rd-dict-html :deep(th) { border: 1px solid var(--border); padding: 2px 6px; }
.rd-dict-html :deep(ul), .rd-dict-html :deep(ol) { padding-left: 18px; margin: 6px 0; }
.rd-dict-html :deep([data-dict-audio]) {
  display: inline-block; cursor: pointer; vertical-align: middle; margin-left: 4px;
  border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px;
  background: var(--bg-3); color: var(--text-0); line-height: 1.4;
}
.rd-dict-html :deep([data-dict-audio]:hover) { border-color: var(--acc-dim); color: var(--brand); }
.rd-dict-html :deep([data-dict-audio] svg) { width: 13px; height: 13px; fill: currentColor; vertical-align: -2px; }
/* 笔顺动画（汉典 `data-gif`）：容器可点，GIF 由我们插入（站点 JS 不跑） */
.rd-dict-html :deep([data-dict-gif]) { display: inline-block; cursor: pointer; border-radius: 6px; }
.rd-dict-html :deep([data-dict-gif]:hover) { outline: 1px dashed var(--acc-dim); outline-offset: 2px; }
.rd-dict-html :deep([data-dict-gif] img.rd-dict-gif) {
  display: block; margin: 6px 0; max-width: 100%; max-height: 180px;
  border: 1px solid var(--border); border-radius: 6px; background: #fff;
}
/* 站点图标类小图（logo/分享图标）在窄浮窗里很吵 ⇒ 限制高度，避免撑爆 */
.rd-dict-html :deep(img[src*="logo"]) { max-height: 22px; }

/* ============ `#221` 顶端标题栏：更多菜单 / 按钮显隐设置 ============ */
/* 「更多」挂在标题栏下方右对齐；`.se-panel` 是 position:relative ⇒ 定位以浮层为界 */
/* ★ `#229`：菜单的定位基准是**「⋯ 更多」按钮**（下面这个容器），不是标题栏、更不是满宽面板 ——
   之前挂在面板下时 `right:12px` 会贴到**窗口最右边**（用户 2026-10-03 报的偏移）。 */
.rd-more-wrap { position: relative; display: inline-flex; }
.rd-more {
  position: absolute; right: 0; top: 100%; z-index: 40;
  min-width: 176px; padding: 6px;
  background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 8px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.rd-more-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 6px; cursor: pointer;
  background: none; border: 0; color: var(--text-0); font-size: 13px; text-align: left;
}
.rd-more-item:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand); }
.rd-more-item:disabled { opacity: 0.45; cursor: default; }
.rd-more-icon { width: 16px; text-align: center; flex: none; }
.rd-more-pin { margin-left: auto; font-size: 10px; opacity: 0.8; }
/* `#254` 开关型菜单项的当前状态（开=品牌色，关=灰） */
.rd-more-state {
  margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted);
}
.rd-more-state.on { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
.rd-more-setting { margin-top: 4px; border-top: 1px solid var(--border); padding-top: 8px; }

/* 按钮显隐设置浮层 */
.rd-toolset-mask {
  position: absolute; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.35);
  display: flex; align-items: center; justify-content: center;
}
.rd-toolset {
  width: min(360px, 92%); max-height: 80%; overflow: auto;
  background: var(--bg-2); border: 1px solid var(--border-strong);
  border-radius: 10px; padding: 14px 16px; box-shadow: var(--shadow);
}
.rd-toolset-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.rd-toolset-head strong { flex: 1; font-size: 14px; }
.rd-toolset-x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 14px; }
.rd-toolset-hint { margin: 0 0 8px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.rd-toolset-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 7px 0; font-size: 13px; color: var(--text-0);
  border-top: 1px solid var(--border);
}
/* `#808` `D9`：自动滚动的速度滑块（宽度固定，避免长文案把行撑歪） */
.rd-autoscroll-range { width: 128px; flex: none; accent-color: var(--brand); cursor: pointer; }
/* B8 自动翻页：档位按钮组（4/8/12/20/30 秒）—— 行内换行也不撑破卡片 */
.rd-ap-row { align-items: center; }
.rd-ap-opts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.rd-ap-opt {
  padding: 4px 9px; font-size: 12px; line-height: 1.2; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-3); color: var(--text-1);
  cursor: pointer;
}
.rd-ap-opt:hover { border-color: var(--brand); color: var(--text-0); }
.rd-ap-opt.on { border-color: var(--brand); background: var(--brand); color: var(--bg-0); }
.rd-switch:disabled { opacity: .45; cursor: not-allowed; }

/* ============ `#230` 滚动容器 = 「页眉 + 正文 + 页脚」（`.se-scroll`）============
 * 用户 2026-10-03 的原话（两件事一起要求）：
 *   ① 「标题栏独立，这个滚动条应该是页面的：即(页眉+正文+页脚)的」
 *   ② 「阅读界面宽度不应直接最大，回到 `#222` 对宽度的修改之前」
 *
 * ## ① 的结构
 *   .se-panel（浮层，**不滚**）= .se-head（标题栏，独立）+ .se-scroll（**滚动容器**）
 *   .se-scroll 里 = 页眉（sticky top:0）+ .se-body + 页脚（sticky bottom:0）
 *   ⇒ 滚动条从**页眉顶**贯穿到**页脚底**；标题栏完全不参与滚动。
 *
 * ## ② 的宽度
 * `#222`/`#229` 曾把 `.se-panel` 改成**满宽**（为了把滚动条顶到窗口右缘）—— 现在按用户要求**撤回**：
 * 面板回到 `min(920px, 100%)` 的窄卡片（`.se-panel` 的基础样式），正文也**不再限宽居中**
 * （面板本身就只有 918px 可用，再加一层限宽是多余的）。
 */
/* ============ `#250` 背景作用域 = 「标题栏 + 页眉 + 正文 + 页脚」整个阅读界面============
 * ## 为什么从 `.se-scroll` 上移到 `.se-panel`
 * 用户 2026-10-04 报：「顶端标题栏也应铺图，也应透明」⇒ 图必须盖住 `.se-head`。
 * `.se-head` 是 `.se-panel` 的直接子元素、`.se-scroll` 的**兄弟** ⇒ 背景只能挂在 `.se-panel`。
 *
 * ## 三层结构（各管一件事，互不 interference）
 *   `.se-panel`      `background` = **底色**（恒不透明，`--rd-bar-bg` 由 JS 注入）
 *   `.se-panel::before` `background-image` + `opacity: var(--rd-bg-img-alpha)` = **背景图片**
 *   `.se-head` / `.se-scroll` / `.rd-content` 全部 `transparent` ⇒ 层层透出上面两层
 *
 * ## ★ 为什么图片必须独占 `::before`（不能直接 `background-image` 在 `.se-panel` 上）
 * `bgAlpha` 要**只淡图片、不淡底色**（上游 `PageView.kt:343` 只设 `bg.alpha`，
 * 而 `bgMeanColor` 那层不动）。CSS 的 `background-image` 没有独立的 alpha 通道 ——
 * 想淡它只能给元素加 `opacity`，那会**连同层文字一起淡** ⇒ 只能让图片独占一个伪元素。
 *
 * ⚠️ 伪元素是 `absolute` ⇒ 必须给 `.se-panel` 一个 `position: relative`（已有，见上），
 *   并且 `z-index: 0` + 内部内容 `z-index: 1`，否则图会盖住正文。
 * ⚠️ `overflow: hidden` 不可加：面板内的侧滑目录/对话框靠 `position: absolute` 溢出显示。
 */
.se-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  /* 透明时（无背景图）`--rd-bg-img` 未注入 ⇒ 用 `none` 兜底，绝不画空图 */
  background-image: var(--rd-bg-img, none);
  /* 上游图默认铺满（`vwRoot` 尺寸即图尺寸）；`cover` 最接近，且窗口缩放时不留边 */
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  /* ★ `bgAlpha` 的落点：只作用这一层（图片），底色与文字都不受影响 */
  opacity: var(--rd-bg-img-alpha, 1);
  pointer-events: none; /* ★ 不加会吃掉整层点击 —— 正文选不中、按钮点不动 */
}
/* 内容层抬到图之上（`#806` 起标题栏包在 `.rd-head-dock` 里 —— 层级判据跟着上移一层） */
.se-panel > .rd-head-dock,
.se-panel > .se-scroll { position: relative; z-index: 1; }
/* ★★ `#251` 标题栏必须**高于**滚动区：两个 z-index 相同（都是 1）时，**DOM 靠后的**画在上面
 * ⇒ `.se-scroll` 盖住了「更多」菜单悬垂到滚动区的下半截 —— 用户 2026-10-04 实测：
 * 「鼠标无法滑入弹出的按钮列表，鼠标一动菜单就消失，像有东西遮挡」。
 * 真因：菜单命中测试落在 `.se-scroll` 上 ⇒ `.rd-more` 的 `@mouseleave` 立刻触发 ⇒ 菜单被收起。
 * （`#250` 引入的回归 —— 当时两者同时从无定位改成 z-index:1，没注意 DOM 顺序决定同层级绘制先后。）
 * 标题栏抬到 2；侧滑遮罩（z-index 6）/按钮显隐遮罩（60）都是更靠后的兄弟 ⇒ 仍能盖住标题栏。 */
.se-panel > .rd-head-dock { z-index: 2; }

/* ============================================================================
 * `#811` **阅读态标题栏 = 绝对定位浮层**（用户 2026-11-06：「标题栏隐藏后上方有较大空白」）
 *
 * ## 之前那块空白是怎么来的
 * D8 的「收起」是 `opacity:0 + pointer-events:none` + `inert`，**高度原样保留 47px**
 * —— 这是有意防反馈环（见脚本 `headCollapsed` 上方的长注释），代价是标题栏看不见了、
 * 那块地方还占着：页眉被顶到 47px 下方，视觉上就是一条大空白。
 *
 * ## 现在的做法：不参与文档流
 * 阅读态把 `.rd-head-dock` 改成 `position:absolute; top:0; left:0; right:0`：
 *  · **收起**：盒子只有 `12px` 高 = **顶部窄带热区**（`.se-head` 自身仍是 47px、`opacity:0`，
 *    并且 `pointer-events:none` ⇒ 不会挡正文/翻页热区的任何点击）；
 *  · **展开**（`.rd-head-open`）：`height:auto`，盒子跟着标题栏长高，标题栏浮在内容之上。
 *
 * ## 为什么这不仅不产生反馈环，反而**彻底消灭**它
 * 旧方案怕的是「显隐改高度 ⇒ 正文格高度变 ⇒ scrollTop / 分页列高变 ⇒ 判据翻转」。
 * 绝对定位后标题栏**从不占任何文档流高度** ⇒ `.se-scroll` 的盒子、`.se-body` 的
 * `clientHeight` / `scrollHeight` 在收起/展开两态下**逐像素相同** ⇒ 不存在能被高度带翻的判据。
 * 热区判据也**固定在面板顶部 12px**（不跟着内容走）——
 * 「鼠标移出 → 收起 → 内容上移 → 鼠标又落进热区」这条环没有入口（内容根本不上移）。
 *
 * ## 与 `toolPins` / `headerVisible` 的关系
 *  · `toolPins`：只决定「哪几枚按钮常显在标题栏」，浮层化不改变任何按钮的可点性；
 *    唯一变化是「常显的按钮也随整条标题栏一起浮起 / 淡出」—— 这正是 D8 的口径。
 *  · `headerVisible`（页眉 `ReaderTipBar`）：**另一条独立判据**（`headerMode` / `scrolledDown`），
 *    本浮层不碰它。页眉在 `.se-scroll` 顶部，标题栏展开时会盖住它的前 47px（浮层语义，
 *    鼠标移出 3s 即恢复）；页眉自己隐藏时也**不再占位**（`.rd-tip-off` 改 `display:none`，
 *    理由见那条规则：两态高度不影响 `.se-body` 的 scrollTop）。
 *  · **详情页**（`r.chapter` 为空）**保持原文档流布局**：详情页标题栏常显，下面就是封面/信息区，
 *    浮层化只会平白遮住封面 ⇒ 规则只挂在 `.se-mask.rd-view` 下。
 *
 * ⚠️ 浮层必须**不透明**：`--rd-bar-head-bg` 默认是 `transparent`（`toolbarTransparent=true`），
 *   浮起时若还透明，底下的页眉/正文会透出来和按钮叠字。⇒ 阅读态改用 `--rd-bar-bg`
 *   （面板底色，永远不透明）；「标题栏透明」这条偏好在**详情页**保持原样。
 */
/* 用户 2026-11-10：阅读浮层是圆角，但漫画图片是直角 —— 图片左上/右上的直角会盖住
   `.se-panel` 的圆角，原生滚动条顶端也顶到圆角外（直角）。
   阅读态下 `.rd-head-dock` 绝对定位不占位，`.se-scroll` 恰好铺满整个面板 ⇒ **在这个图层上**
   做圆角裁剪：它原有的 `overflow:hidden` 本来就把子层裁到自己的盒子，补上 `border-radius`
   后裁剪形状从方角变圆角，图片与滚动条都收进面板圆角内。
   ⚠️ 只裁 `.se-scroll`，**不裁 `.rd-content` / `img` 自身** —— 给图片加圆角会把它自己的
   四角裁掉（深色背景上像描了黑边）；这里裁的是容器图层，图片内容不会被二次圆角。
   最大化（`.maxed`）时面板本身是直角，这里同步归零，否则会在方窗口里裁出四个圆缺口。 */
.se-mask.rd-view > .se-panel > .se-scroll {
  border-radius: calc(var(--r) - 1px); /* 减去面板 1px 边框，裁剪弧与边框内缘对齐 */
}
.se-mask.rd-view > .se-panel.maxed > .se-scroll { border-radius: 0; }

.se-mask.rd-view > .se-panel > .rd-head-dock {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  height: 12px; /* 收起态：只剩顶部窄带热区（展开态见下一条 height:auto） */
}
.se-mask.rd-view > .se-panel > .rd-head-dock.rd-head-open { height: auto; }
.se-mask.rd-view > .se-panel > .rd-head-dock > .se-head {
  background-color: var(--rd-bar-bg, var(--bg-1));
  border-radius: var(--r) var(--r) 0 0;
}
.se-mask.rd-view > .se-panel.maxed > .rd-head-dock > .se-head { border-radius: 0; }
/* 桌面外壳最大化时面板贴到窗口 (0,0)，标题栏右上角的「还原 / 更多 / 关闭」会落进
   WCO 窗口按钮区（高 `--wco-h`，浏览器为 0）⇒ 只把标题栏内容整体下移让出这段，
   按钮自身定位/顺序不变；普通态面板已有 4vh 顶部留白，不受影响。 */
.se-mask.rd-view > .se-panel.maxed > .rd-head-dock > .se-head {
  padding-top: calc(12px + var(--wco-h, 0px));
}

/* ---- `#250` 栏位底色：透明开关的落点 ----
 * 变量由 store 的 `readerBarVars` 注入：透明 ⇒ `transparent`；不透明 ⇒ 按各自 alpha 预混的底色。
 * 三个变量对应三个区域：标题栏 / 页眉 / 页脚（`--rd-bar-head-bg` / `-header-bg` / `-footer-bg`）。
 * ⚠️ 标题栏/页眉/页脚**原来都有各自的不透明底色**（`--bg-1` / 面板背景），
 *   不清掉的话「透明开关」打开也不会透图 —— 那是 `#249` 之后「只有页眉能透、标题栏不能」的根因。 */
.se-head { background: var(--rd-bar-head-bg, transparent); }
.se-scroll > .rd-tip-header { background: var(--rd-bar-header-bg, transparent); }
.se-scroll > .rd-tip-footer { background: var(--rd-bar-footer-bg, transparent); }

.se-scroll {
  /* `flex:1; min-height:0`：`min-height:0` 必须有 —— flex 子项默认 `min-height:auto`，
     正文一长就不肯收缩，底部会被顶出浮层外（这是 `#203` 朗读浮条踩过的同一个坑）。 */
  flex: 1; min-height: 0;
  /* ★★ `#251` `.se-scroll` **自身不再滚动**（`hidden`）：滚动职责完全交给 `.se-body`
     （见下面三段布局的注释）。`#230` 时代「滚动条从页眉顶贯穿到页脚底」的前提是
     页眉/页脚在滚动流里 —— `#251` 让它们固定不动后，滚动条只属于正文格。
     `hidden` 而不是 `visible`：三段高度和恒等于容器高，正常永远不溢出；
     万一有 1px 级别的取整误差，`visible` 会让内容顶出边框，`hidden` 不会。 */
  overflow: hidden;
  /* ★ `#250` 背景已上移到 `.se-panel` ⇒ 这里必须透明，否则会盖住图 */
  background: transparent;
}
/* ---- `#231`→`#250`→`#251` 演变史（细节见下面 `#251` 块的注释）----
 * `#231` 页眉吸顶闪烁 → 让页眉/页脚脱离滚动流；`#250` 想用 padding 预留正文空间
 * （失败：滚动容器的 padding 会随内容滚走）；`#251` 最终方案 = 页眉/页脚回归文档流
 * 占真实高度、正文格是唯一滚动容器。 */
.se-scroll {
  display: flex;
  flex-direction: column;
}
/* ---- `#251` 页眉 / 页脚：**回归文档流**（占真实高度），正文格被夹在中间 ----
 * ★★ 用户 2026-10-04 二次报告：「页眉页脚透明后，正文区域文字会透上来……
 *   四块区域应该类似块级区域，页眉和页脚中间挤着内容区域，视觉上固定不动，只有正文区域滚动。」
 *
 * ## `#250` 那版为什么没修好（教训）
 * `#250` 保留了页眉/页脚 `position: absolute`（覆盖正文），改为给 `.se-body` 预留
 * `padding-top/bottom` = 页眉/页脚高度。**这对 padding 写在滚动容器上会随内容一起滚走**：
 * 刚打开时首行确实在页眉下方，但一滚动，正文就填进页眉/页脚脚下的那 30px
 * ⇒ 透明页眉页脚后面全是正文字 —— 用户截图里「第3章」和正文叠在一起就是这个。
 * ★ 根本结论：**padding 永远造不出「固定不动的屏幕区域」**，只有布局本身可以。
 *
 * ## 现在的结构（对齐上游 `view_book_page.xml` 的 LinearLayout 语义，且更进一步）
 *   .se-scroll（flex column，**自身不滚动**）
 *     ├─ 页眉   `.rd-tip-header`  —— 文档流占真实高度（`.rd-tip` 本来就是 `flex: 0 0 auto`）
 *     ├─ 正文格 `.se-body`        —— `flex:1; min-height:0; overflow:auto`，**唯一的滚动容器**
 *     └─ 页脚   `.rd-tip-footer`  —— 文档流占真实高度
 * ⇒ 正文被 `overflow: auto` **裁剪在自己的盒子里**，物理上不可能出现在页眉/页脚底下；
 *   透明开关打开时透出的只有 `.se-panel` 的背景色/背景图（用户要的效果）。
 *
 * ## 为什么不再怕 `#231` 的闪烁反馈环
 * 那个环的前提是「页眉/页脚在**滚动容器内部**，显隐改变 scrollHeight ⇒ scrollTop 被回调」。
 * 现在滚动容器是 `.se-body`，页眉/页脚在它**外面**：自动隐藏只切 `visibility`（`.rd-tip-off`），
 * 高度不变 ⇒ `.se-body` 的 scrollTop / scrollHeight 都不动 ⇒ 环不存在。
 */
.se-scroll > .rd-tip-header,
.se-scroll > .rd-tip-footer {
  /* `.rd-tip` 已有 `flex: 0 0 auto; width: 100%`（组件自带）—— 这里显式写死语义，
     防止组件样式改动悄悄破坏三段布局 */
  flex: none;
}
/* 正文格：吃掉剩余空间（上游 `content_text_view` 的 `layout_weight=1`）；
   `overflow:auto` 让它成为**唯一**的滚动容器 ⇒ 滚动条只在正文格内，
   页眉/页脚视觉上固定不动 —— 正是用户 2026-10-04 的原话。 */
.se-scroll > .se-body { flex: 1; min-height: 0; }
/* ★★ `#811` **自动隐藏不再占位**：`display:none`（用户 2026-11-06：
   「页眉→自动隐藏，只是不显示，占位还在」—— 隐藏了就该让出空间）。
 *
 * ## 为什么现在敢从 `visibility:hidden`（保高度）改成 `display:none`
 * `#231` 那个「页眉闪烁」环的**前提**是：页眉在**滚动容器内部**，显隐改变 scrollHeight，
 * 浏览器回调 scrollTop ⇒ 「滚过 40px」判据翻转 ⇒ 又显隐。
 * `#251` 之后滚动容器已经是 `.se-body`，页眉是它的**兄弟**（在 `.se-scroll` 里、正文格外面）：
 * 页眉高度变化**不会**改变 `.se-body` 的 `scrollTop` / `scrollHeight` ⇒ 环的前提不存在。
 * 判据 `scrolledDown` 读的是 `el.scrollTop`（正文格自身），与页眉高度无关。
 *
 * ⚠️ 分页模式下页眉高度变化会改变 `.se-body` 的可用高 ⇒ 需要重建分页 ——
 *   `ResizeObserver` 会因盒子变化触发，`schedulePagedRebuild(120)` 里有签名去重（见 `buildPagedInput()`），
 *   高度没变就不会重量 ⇒ 不会自激。
 */
.rd-tip-off { display: none; }
/* ⚠️ `#222`/`#229` 遗留下来的两处「满宽」痕迹必须清掉（否则面板会被拉满、滚动条跑到窗口边）：
     · `.se-mask.rd-view { padding-left/right: 0 }` —— 去掉，浮层四周恢复 16px 边距；
     · 模板上 `.se-panel` 的 `rd-reading` class 已一并移除。 */

/* ------------------------------------------------------------------ *
 * B18 小窗·阅读紧凑布局（桌面两档都挂 `.rd-small`；Web Document PiP 不吃这套）
 *
 * 小窗·常规 420×320 / 小窗·迷你 240×180 只保留「阅读导航 / 切档 / 退出 / 关闭」：
 * 换章、目录、进度、字号在小窗里就能读正文（迷你档再隐藏进度与字号）。
 * 其余标题栏控件全部隐藏 —— 否则小屏标题栏换行，正文高度只剩几十像素。
 * ★ 不做响应式断点判定：小窗状态由主进程显式下发，窗口宽度只是结果，不当判据。
 * ------------------------------------------------------------------ */
.se-mask.rd-small { padding: 0 !important; }
.se-mask.rd-small .se-panel {
  width: 100vw;
  max-width: 100vw;
  height: 100vh;
  max-height: 100vh;
  border-radius: 0;
  border: none;
}
.se-mask.rd-small .se-head {
  gap: 4px;
  padding-left: 6px;
  padding-right: 6px;
  /* 标题/工具都被隐藏后只剩阅读导航与三枚按钮 ⇒ 靠右排，避免贴左上角 */
  justify-content: flex-end;
}
/* ★ 用户 2026-11-08：三档小窗**不要顶部标题栏**。
   控制条（含右上角「关闭」）默认完全收起；鼠标进入顶部热区（DOCK_REVEAL_H，按 Y、横向不限）才浮现。
   主进程同时把小窗的原生 titleBarOverlay 高设为 0 ⇒ 连系统标题栏也不占位。 */
.se-mask.rd-small > .se-panel > .rd-head-dock { height: 12px; z-index: 30; }
.se-mask.rd-small.rd-small-head-on > .se-panel > .rd-head-dock { height: auto; }
.se-mask.rd-small > .se-panel > .rd-head-dock > .se-head {
  opacity: 0;
  pointer-events: none;
  background: rgba(10, 12, 16, 0.88);
  border-bottom: 0;
  border-radius: 0 0 10px 10px;
}
.se-mask.rd-small.rd-small-head-on > .se-panel > .rd-head-dock > .se-head,
.se-mask.rd-small.rd-small-head-on > .se-panel > .rd-head-dock > .se-head.rd-head-hidden {
  opacity: 1 !important;
  pointer-events: auto !important;
}
/* 直接子节点里只放行 `.rd-small-keep`（阅读导航 / 切档 / 退出 / 关闭）；标题、缓存 chip、工具栏按钮全部让位 */
.se-mask.rd-small .se-head > *:not(.rd-small-keep) { display: none !important; }
/* 小窗阅读导航：图标按钮，尽量少占宽高 */
.se-mask.rd-small .rd-small-nav {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}
.se-mask.rd-small .rd-small-navbtn {
  min-width: 26px;
  height: 24px;
  padding: 0 4px;
  font-size: 12px;
  line-height: 1;
}
.se-mask.rd-small .rd-small-pct {
  padding: 0 2px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.se-mask.rd-small .se-body { padding-left: 10px; padding-right: 10px; }
/* 迷你档更激进：缩小导航/页脚字号，隐藏进度与字号入口（只留换章 / 目录 / 切档 / 退出 / 关闭） */
.se-mask.rd-small-mini .rd-small-font,
.se-mask.rd-small-mini .rd-small-pct { display: none !important; }
.se-mask.rd-small-mini .rd-small-navbtn { min-width: 24px; height: 22px; padding: 0 3px; font-size: 11px; }
.se-mask.rd-small-mini .se-head { gap: 2px; padding-left: 4px; padding-right: 4px; }
.se-mask.rd-small-mini .rd-small-label { display: none; }
/* 240×180 里页脚会吃掉 1/4 正文高度 ⇒ 迷你档直接收掉页脚（进度仍可从正常窗/页脚配置恢复） */
.se-mask.rd-small-mini .rd-tip-footer { display: none; }
/* 章节大标题按桌面宽度设计（28px+），在迷你档会把 70px 正文区挤成一行 ⇒ 等比缩小并收紧外边距 */
.se-mask.rd-small-mini .se-body .rd-chapter.rd-book-title {
  margin-top: 0 !important;
  margin-bottom: 4px !important;
  font-size: 16px !important;
  line-height: 1.3 !important;
}

/* Web 小窗阅读浮窗由 `ReaderMiniBar.vue` 自己定位（fixed + 分档几何落盘），这里不再需要容器样式 */
</style>
