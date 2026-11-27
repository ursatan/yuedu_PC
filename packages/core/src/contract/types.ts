/**
 * 统一数据模型
 *
 * 【这是整个项目最重要的一层】
 * 上层（Web 页面 / 服务端接口）只认这里的类型，完全不知道底层是 Legado 还是 MacCMS。
 * 新增引擎时，只要把它的产出转成这些类型，前端一行代码都不用改。
 *
 * kind 的取值直接对齐 Legado BookSourceType:
 *   0=文本 1=音频 2=图片 3=文件 4=视频
 * 注意：Legado 书源本身就能产出 video，所以这个统一模型不是硬凑的抽象。
 */

/** 引擎支持的动作 */
export type EngineAction =
  | 'home' // 首页 / 发现
  | 'category' // 分类筛选
  | 'search' // 搜索
  | 'detail' // 详情（书籍信息 / 目录 / 影视详情）
  | 'content' // 正文
  | 'play' // 播放地址解析
  | 'start' // `#404` RSS 启动页（startHtml，webView 型源）
  | 'login'; // 源登录（loginUrl / loginUi）

/**
 * `#404` **RSS 启动页**（`startHtml`）求值结果。
 *
 * 上游 `RssViewModel.launchRssWithHtml:82-106`：`startHtml` 是 `@js:`/`<js>` 时先用 Rhino
 * 求值、否则取字面量；结果**非空** ⇒ `RssFragment.openRss:198-211` 直接进
 * `ReadRssActivity` 的 WebView（**替换**分类列表页，非叠加）。`startStyle` 追加进 `<head>`、
 * `startJs` 作为页面脚本执行。`html` 为空串 = 源没有启动页（或条件未满足）⇒ 前端走常规列表。
 */
export interface UnifiedStartResult {
  html: string;
  style?: string;
  js?: string;
  /**
   * `#418` **源变量快照**（`source.getVariable()` 的当前值）—— 启动页在浏览器沙箱 iframe 里
   * 跑，拿不到引擎的 `ctx.variables`，而 `startJs` 一上来就读它（LOFTER：`Host.getVariable()`
   * 决定是否显示「首次使用」按钮，并还原用户配的标签/合集/作者）。
   * 由 `start` 动作带回、垫片预置（`buildStartPageJavaShim` 的 `variable`）。
   * 缺省 = 从未设置过 ⇒ 垫片里是**空串**（对齐 `BaseSource.getVariable()` 的语义，不是 `'{}'`）。
   */
  variable?: string;
}

/** 管道阶段 —— 出错时用来定位「死在哪一步」 */
export type PipelineStage =
  | 'validate' // 校验配置
  | 'preScript' // 前置脚本（Legado 的 header/jsLib 求值）
  | 'request' // 发请求
  | 'parse' // 解析列表 / 详情
  | 'clean' // 字段清洗（## / 替换规则）
  | 'paginate' // 分页
  | 'normalize'; // 归一化成 UnifiedItem

/** 统一请求 —— 所有引擎收的参数长得一模一样 */
export interface UnifiedRequest {
  action: EngineAction;
  keyword?: string; // search 用
  page?: number; // 从 1 开始
  filters?: Record<string, string>; // category 用（分类/地区/年份...）
  id?: string; // detail / content / play 用
  extra?: Record<string, unknown>; // 引擎私有透传
  /**
   * loginUi 按钮动作（Legado `SourceLoginDialog.handleButtonClick`）：
   * 点击 loginUi 里的 button/toggle 行时，引擎执行 `loginJs + '\n' + loginAction`
   * （bindings 含 `result` = 登录信息 map、`source`、`java`）。
   * 若 action 是绝对 URL，前端应直接打开页面而不是回传（对齐 `openUrl(action)`）。
   */
  loginAction?: string;
  /**
   * **LoginUiV2 的会话状态**（`loginUi(state)` / `loginAction(action,state,form)` 的 `state`）。
   * 由引擎返回、前端原样回传；引擎不解释其内容（Legado 同）。空/缺省时按 `{}` 处理。
   */
  loginState?: string;
  /**
   * **LoginUiV2 的表单快照**（`{key: value}` 的 JSON 字符串）——动作脚本的第三个参数。
   * v1 不用（v1 的值走 `result` = loginInfo map）。
   */
  loginForm?: string;
  /**
   * `#306` **跨页通道**：上一页结果里 `UnifiedListResult.page.nextUrl` 的**原样回传**。
   *
   * 为什么需要它：有一类源（RSS 的 `ruleNextPage` 规则型、书源的「下一页链接」型）下一页是
   * **从页面里解析出的 URL**，与页码无关 —— 只靠 `page + 1` 重放模板会**反复拿同一页**
   * （本仓此前对这类源只能 `hasMore=false` 留痕降级，等于「能看第一页、翻不动」）。
   * 引擎给出 `nextUrl` ⇒ 前端回传 ⇒ 引擎**直接用它**，不走模板。
   */
  nextUrl?: string;
}

/** 前端渲染用的版式标识 —— 新增引擎不改 UI 的关键 */
export type ItemLayout = 'grid-card' | 'wide-card' | 'text-row';

/**
 * 源的启用状态（总开关 + 搜索 + 发现）。
 * 用于「每个源都可独立启用/禁用、启用搜索/禁用搜索、启用发现/禁用发现」。
 *
 * 设计要点：
 * - 默认全开（enabled/searchEnabled/exploreEnabled 缺省均视为 true），
 *   这样旧源 / 导入源无需逐个字段也能正常工作。
 * - 这是「源管理状态」，不是源解析规则本身；Web 导入/编辑时由用户自主修改并持久化。
 * - 引擎层做防御性短路（被禁用时返回空结果），facade 层做主拦截（完全不调度被禁源）。
 */
export interface SourceState {
  /** 总开关，默认 true */
  enabled?: boolean;
  /** 是否启用搜索，默认 true */
  searchEnabled?: boolean;
  /** 是否启用发现（home / category），默认 true */
  exploreEnabled?: boolean;
  /**
   * `#428`（`D12`=A，用户 2026-10-12 拍板）**该源是否忽略 TLS 校验**。
   *
   * ★ **本字段是上面「缺省全开」的唯一例外：缺省 = `false`（保持校验，安全默认）**。
   * 只为「站点证书过期/自签名，用户仍要用这个源」这一种情形：引擎的规则请求与 `/api/proxy`
   * 在开启后改用 `rejectUnauthorized:false` 的 dispatcher（core `net-agent.insecureTlsDispatcher`）。
   *
   * ⚠️ 开了它 = 该源的请求不再校验服务端身份（可被中间人替换）；**界面必须给风险提示**。
   * 存在 SourceState（源管理状态）而**不是**源 raw：raw 会随导出/导入到处跑，
   * 这是「本机行为开关」，不该污染要共享的源文件（同 hub 里置顶名单的取舍理由）。
   */
  allowInsecureTls?: boolean;
}

/** 把任意 SourceState（含 undefined）归一成确定性布尔。★ `allowInsecureTls` 反着来：缺省 false */
export function resolveSourceState(s?: SourceState | null): Required<SourceState> {
  return {
    enabled: s?.enabled !== false,
    searchEnabled: s?.searchEnabled !== false,
    exploreEnabled: s?.exploreEnabled !== false,
    // 安全默认：没显式开就是「校验」（与上面三条相反，见字段注释）
    allowInsecureTls: s?.allowInsecureTls === true,
  };
}

/**
 * `B6` 书源体检五态（体检结果的**唯一口径**，服务端算、前端展示与排序共用）。
 *
 * - `ok` 正常：全部环节通过，响应时间未超阈值
 * - `slow` 较慢：全部通过但响应时间 ≥ `SOURCE_SLOW_RESPOND_MS`
 * - `degraded` 部分可用：搜索通过、其它环节（发现/详情/目录/正文）有失败
 * - `broken` 失效：搜索/发现等核心环节失败（规则或站点不可用，但域名还在）
 * - `dead` 死亡：域名不可达，或连续失败 ≥ `SOURCE_DEAD_FAILURE_LIMIT` 次
 */
export type SourceHealthState = 'ok' | 'slow' | 'degraded' | 'broken' | 'dead';

/** 慢速源判定阈值（ms） */
export const SOURCE_SLOW_RESPOND_MS = 2500;
/** 连续失败达到该次数即判 `dead` */
export const SOURCE_DEAD_FAILURE_LIMIT = 3;
/** `dead` 源的跳过期（3 天）；过期后重新参与体检/搜索/换源 */
export const SOURCE_DEAD_SKIP_MS = 3 * 24 * 60 * 60 * 1000;
/** 从未体检过的源用于排序的中性质量分（避免未体检源被压到最底） */
export const SOURCE_NEUTRAL_QUALITY = 50;

/** 单个源的体检结果（服务端持久化到 `data/source-health.json`） */
export interface SourceHealth {
  state: SourceHealthState;
  /** 质量分 0~100（由五态 + 响应时间 + 失败环节数推导） */
  quality: number;
  /** 最近一次体检时间（ms epoch） */
  checkedAt: number;
  /** 最近一次体检总耗时（ms） */
  respondTime: number;
  /** 连续未通过次数（通过一次即清零） */
  consecutiveFailures?: number;
  /** `state==='dead'` 时的跳过截止时间（ms epoch） */
  deadUntil?: number;
  /** 失败原因摘要（中文，便于源管理列表直接展示） */
  message?: string;
}

/**
 * 排序用「有效质量分」：未体检 → 中性分；`dead` 仍在跳过期 → 0；
 * `dead` 已过期 → 中性分（重新参与排序，等下一次体检复评）。
 */
export function effectiveSourceQuality(health?: SourceHealth | null, now = Date.now()): number {
  if (!health) return SOURCE_NEUTRAL_QUALITY;
  if (health.state === 'dead') {
    return health.deadUntil != null && health.deadUntil > now ? 0 : SOURCE_NEUTRAL_QUALITY;
  }
  const q = Number(health.quality);
  return Number.isFinite(q) ? Math.max(0, Math.min(100, q)) : SOURCE_NEUTRAL_QUALITY;
}

/** `dead` 是否仍在跳过期内（体检、搜索、换源都据此排除） */
export function isSourceHealthDeadActive(health?: SourceHealth | null, now = Date.now()): boolean {
  return !!health && health.state === 'dead' && health.deadUntil != null && health.deadUntil > now;
}

/** 统一列表项 —— 小说 / 影视 / 文章共用一套 */
export interface UnifiedItem {
  id: string;
  kind: 'book' | 'video' | 'article' | 'audio' | 'image' | 'file';
  title: string;
  cover?: string;
  subtitle?: string; // 作者 / 备注 / 更新至
  summary?: string; // 简介
  tags?: string[];
  layout: ItemLayout;

  /**
   * 传给下一阶段的最小上下文（引擎私有）。
   * 例如 Legado 的书籍详情页 URL、MacCMS 的 vod_id。
   * 前端不用管里面是什么，原样回传即可。
   */
  payload: unknown;

  raw?: unknown; // 原始条目，仅调试面板用
}

/** 筛选器（分类栏） */
export interface FilterOption {
  name: string;
  value: string;
  /**
   * 分组标题（Legado exploreKinds 里 url 为空 / type:"text" 的项，如「地区」大标题）：
   * 只做展示，点击无意义。
   */
  header?: boolean;
  /** 交互类型（Legado ExploreKind.type）：url / text / button / toggle / select。
   *  非 url 项由 UI 渲染成控件，其当前值经 `EXPLORE_INPUT_KEY` 回传（见下）。 */
  kind?: string;
  /**
   * Legado FlexChildStyle 子集（Android flexbox → Web 列宽/占位）：
   * layout_flexBasisPercent=1 → 整行；0.25 → 一行 4 个；0.5 → 一行 2 个。
   */
  layout?: { flexGrow?: number; flexBasisPercent?: number };
  /** toggle / select 的候选值（Legado ExploreKind.chars）——点一次换下一个 */
  chars?: string[];
  /** 初始值（Legado ExploreKind.default）；UI 未选过时用它将输入态播种进引擎 */
  default?: string;
  /** button 的点击动作脚本（Legado ExploreKind.action，如 java.searchBook(...) / java.refreshExplore()） */
  action?: string;
}

/**
 * 发现页「交互输入态」在请求里的键名（Legado `infoMap` 的等价物）。
 *
 * 语义：`req.filters[EXPLORE_INPUT_KEY]` = JSON 字符串形式的 `{ [控件名]: 值 }`，
 * 引擎按**源**持久化，并在下一次求值 `exploreUrl` 脚本时作为 `infoMap` 绑定注入
 * （对齐 Legado `exploreInfoMapList[bookSourceUrl]` + `SourceExploreAdapter` 的
 * `infoMap[title] = value` 写回 + `AnalyzeUrl` 的 `bindings["infoMap"]`）。
 *
 * 例：`{ explore: '/list-3/{{page}}.html', $input: '{"频道":"男生频道"}' }`
 */
export const EXPLORE_INPUT_KEY = '$input';

/**
 * 登录信息（Legado `BaseSource.putLoginInfo`）：`loginUi` 表单里的 text/password 值，
 * 或登录脚本通过 `source.putLoginInfo(...)` 写入。按源持久化。
 * 引擎把它作为 `ctx.loginInfo` 注入，`source.getLoginInfoMap()` 读它。
 */
export const LOGIN_INFO_PREFIX = 'login-info:';

/**
 * 登录头（Legado `BaseSource.putLoginHeader`）：登录脚本写入的请求头 JSON（常含 `Cookie`）。
 * 按源持久化；后续**所有**请求自动带上（对齐 `getHeaderMap(hasLoginHeader = true)`）。
 */
export const LOGIN_HEADER_PREFIX = 'login-header:';

/**
 * 发现页「交互动作」在请求里的键名（Legado `ExploreKind.action` 的等价物）。
 *
 * 语义：`req.filters[EXPLORE_ACTION_KEY]` = 本次交互控件对应的 action 脚本；
 * 引擎在合并 `$input` 之后、重跑 `exploreUrl` 脚本之前执行它（bindings 含 `infoMap`）。
 *
 * 为什么必须有这一步：Legado `ExploreAdapter` 里 select/toggle 改变值后会执行
 * `kind.action`（如七猫的 `选择分组` 控件用一段 IIFE 依据分组重算 infoMap），
 * 不执行 action 的话「切换分组后分类/标签列表不变」。
 */
export const EXPLORE_ACTION_KEY = '$action';
export interface FilterGroup {
  name: string; // 「分类」「地区」「年份」
  key: string; // 提交时放到 req.filters[key]
  options: FilterOption[];
}

/** `#152`：本次引擎请求期间「文本响应被体积护栏截断」的汇总（没有截断时不出现在响应上） */
export interface NetTruncatedInfo {
  /** 截断次数 */
  count: number;
  /** 被截断的 URL（去重，最多 3 条，多的用「…」收尾）——排障时对得上是哪个接口 */
  urls: string[];
}

/** 统一列表结果 */
export interface UnifiedListResult {
  items: UnifiedItem[];
  page: {
    page: number;
    pageCount: number; // 总页数，未知填 0
    total: number; // 总数，未知填 0
    hasMore: boolean;
    /**
     * `#306` **下一页 URL**（跨页通道）：`hasMore` 为真时，若下一页**不是**「page+1 重放
     * 同一模板」（如从页面里解析出的链接），引擎在这里给出 URL，前端翻页时**原样回传**
     * `UnifiedRequest.nextUrl`。没有（纯页码递增）则不给 —— 前端继续用 `page + 1`。
     */
    nextUrl?: string;
  };
  filters?: FilterGroup[];
  /**
   * 结果为空时「为什么空」的线索（站点返回的短文本/状态文案）。
   * 例：七猫 API 返回 `{"Status":"Unauthorized"}` → 前端显示「站点返回：…」，
   * 让用户能区分「源失效/需登录」和「解析规则不匹配」，而不是看一个静默空卡片。
   */
  hint?: string;
  /** `#152`：本次请求有文本响应被截断（可能列表不完整）⇒ 前端要与「站点返回空」区分显示 */
  netTruncated?: NetTruncatedInfo;
}

/** 详情结果 */
export interface UnifiedDetail {
  id: string;
  kind: UnifiedItem['kind'];
  title: string;
  cover?: string;
  subtitle?: string;
  summary?: string;
  tags?: string[];
  meta?: Record<string, string>; // 作者/状态/字数/导演/主演...
  /** 目录（小说章节 / 剧集列表） */
  chapters?: UnifiedChapter[];
  /**
   * **目录阶段的失败原因**（`#161`）。
   *
   * 上游 Legado 的 `BookInfo.kt`（书籍信息）与 `BookChapterList.kt`（目录）是**两次独立调用**：
   * 目录挂了只影响目录，已经解析出来的书名/封面/简介/字数照样下发。
   * 我们此前把两者写在同一个 `detail()` 里共用一个 try ⇒ **目录规则一抛错，整条详情变
   * `RULE_PARSE`，字段一个都不下发**，用户看到的是「详情空 + 目录 0」，完全看不出「字段其实取到了」。
   *
   * 现在目录失败会被隔离：`chapters` 返回空数组、书籍信息照常，失败原因写在本字段（**不静默**）。
   * UI 应在目录为空时展示它，否则用户仍然分不清「源没配目录规则」和「目录解析炸了」。
   */
  tocError?: string;
  /** 封面声明了二次解密规则（Legado coverDecodeJs）→ 前端走服务端代理拉封面 */
  coverDecode?: boolean;
  raw?: unknown;
  /** `#152`：本次请求有文本响应被截断（详情/目录可能不完整）⇒ 前端要与「站点返回空」区分显示 */
  netTruncated?: NetTruncatedInfo;
}

export interface UnifiedChapter {
  title: string;
  /** 传给 content 用的标识，引擎私有 */
  payload: unknown;
  order?: number;
  /**
   * 卷标题行（对齐 Legado BookChapter.isVolume / TocRule.isVolume）。
   * 卷没有正文页，UI 应作为分节标题展示且不可点击；引擎对卷章节直接返回空内容、不发请求。
   */
  isVolume?: boolean;
  /** VIP 章节（TocRule.isVip） */
  isVip?: boolean;
  /** 付费章节（TocRule.isPay） */
  isPay?: boolean;
  /** 章节备注原文（TocRule.updateTime：更新时间 / 字数等，对齐 Legado BookChapter.tag） */
  tag?: string;
}

/** 正文结果 */
export interface UnifiedContent {
  title?: string;
  /** 段落数组。图片/漫画类型时，每段是一个图片 URL */
  paragraphs: string[];
  /**
   * `#308` **正文 HTML**（完整文档或片段）—— 与 `paragraphs` **互斥**，非空时前端必须渲染它。
   *
   * ## 为什么必须有这个字段（上游依据，不猜测）
   * 上游订阅源的正文**不是纯文本**：`ReadRssViewModel.initLiveData` 拿到
   * `CachedContent`（= 文章 `description`）或 `RuleContent`（= `ruleContent` 的求值结果）后，
   * 一律走 `viewModel.clHtml(content, style)` 拼装（注入 `preloadJs` 的 `JS_URL` + 样式表），
   * 再 `currentWebView.loadDataWithBaseURL(baseUrl, html, "text/html", "utf-8", url)`
   * —— 即**当作完整 HTML 文档交给 WebView 执行**（`ReadRssActivity.kt:399-431`）。
   * `ruleContent` 为 `@js:`/`<js>`/模板时同理：结果就是一段 HTML。
   *
   * ## 为什么不能降级成 `paragraphs`（真实代价）
   * 语料里这类规则**本身就是 HTML 文档**，且大量依赖 `<script>`：
   *  · 「影视聚合(资源站)」的 `ruleDescription` 是一整页播放器（hls.js + `<video>` + 选集脚本）；
   *  · 「24凹凸吧 / 凹凸吧 / 24凹凸 / 24MM / 凹凸 / AI24」的 `ruleContent` 是
   *    `{{@@h1@all}}…{{@@#imgData@value}}` + 一段 `atob()` 拼 `<img>` 的 `<script>`。
   * 走旧的 `htmlToParagraphs()` 会把标签、样式、脚本**全部丢掉** ——
   * 用户看到的是「一堆乱码文本」而不是播放器/图集（这正是用户报的「没有正确处理，加载，显示」）。
   *
   * ⚠️ 前端渲染它必须用**能执行脚本**的容器（`<iframe srcdoc>`），`v-html` **不执行** `<script>`。
   */
  html?: string;
  /**
   * `#308` `html` 的相对地址基准（对齐上游 `loadWithBaseUrl`：源里为 `false` 时不设）。
   * 有了它，HTML 里的相对 `src`/`href` 才能解析到源站。
   */
  htmlBaseUrl?: string;
  /** 下一页的 payload，没有则为空（表示已到最后一页） */
  nextPayload?: unknown;
  /**
   * 副内容（对齐 Legado ContentRule.subContent）：歌词 / 弹幕 / 追加正文。
   * 音频类源通常是歌词，视频类是弹幕，文本类已在引擎里拼接到 paragraphs 之后。
   */
  subContent?: string;
  /**
   * 图片展示样式（对齐 Legado ContentRule.imageStyle / Book.imgStyle*，ReadBook.kt:491-496）：
   * FULL = 整宽连续（图片类源空白时默认）· SINGLE = 单图逐屏 · TEXT = 用 [图] 占位不加载 · DEFAULT = 跟随用户设置
   */
  imageStyle?: 'DEFAULT' | 'FULL' | 'TEXT' | 'SINGLE';
  /** `#152`：本次请求有文本响应被截断（正文可能缺后半段）⇒ 前端要与「正文本身就这么短」区分显示 */
  netTruncated?: NetTruncatedInfo;
  /**
   * `#583` **源脚本 UI 按钮**（段评 / 本章说 / 神评 / 书评）。
   * 与 `paragraphs` **并存**：正文仍按段落渲染，按钮挂在对应段落末尾（见 {@link ContentUiMark}）。
   */
  uiMarks?: ContentUiMark[];
  /**
   * 该源的图片声明了二次解密规则（Legado ContentRule.imageDecode）。
   * 浏览器无法执行源 JS → 前端必须走服务端 `/api/proxy?u=…&sid=…` 拉图（服务端解密后再回传）。
   */
  imageDecode?: boolean;
  /**
   * 媒体源（音频/视频/文件类书源）：章节即一个可播放/下载的直链。
   *
   * `#352`/`#430` **总是与 `html` 并存（嗅探语义）**：只要正文里提得到像样的媒体候选，
   * 引擎就**同时**下发 `html`（源规则的展示结果，原样渲染不许变）与 `media` ——
   * 前端把 `media` 当「嗅探」信息：进页面先提示、**10s 后收缩成悬浮按钮**，
   * 点击才唤起播放浮窗（新开界面、不替换原页面）。不能像旧实现那样只给 `media`
   * （那会丢掉 HTML ⇒ 改变了源规则的结果展示）。
   *
   * ⚠️ `#430` 起**去掉了 `bodySelfPlaying` 门控**（用户拍板「嗅探与源规则展示并行，
   * 也可以忽略嗅探、在页面内播放」）⇒ 页面自带 hls.js / `<iframe>` 播放页**同样**下发 `media`。
   */
  media?: {
    url: string;
    /** 需要透传给播放器的请求头（防盗链 Referer 等，来自规则的 url,{options}） */
    headers?: Record<string, string>;
    /**
     * 媒体格式（对齐 `inferPlayFormat`）：交给前端选择播放器内核。
     * - `audio` → 音频播放器
     * - `mp4` / `m3u8` → 视频播放器
     * - `unknown` → 未知，前端按直链兜底
     */
    format?: 'm3u8' | 'mp4' | 'audio' | 'unknown';
    /**
     * **备选直链**（按可信度排序，`url` 之后的候选）。
     *
     * 为什么必须下发而不是只挑一个：同一个播放页上往往同时存在多个「看起来像直链」的地址
     * （广告位、预告、清晰度线路），排序只能靠启发式，**必然有取错的时候**。
     * 而前端是唯一能判定「真的放不出来」的一方（`<audio>`/`<video>` 的 error 事件）。
     * 只给一个候选 ⇒ 取错就只能报「加载失败」，用户无从下手。
     *
     * 前端语义：**按序尝试**，`url` 失败后才用备选（成功即停）。
     */
    alternatives?: string[];
  };
}

/** 播放结果（影视） */
/**
 * 登录结果（Legado BaseSource.login() / loginUrl / loginUi 的归一产物）
 *
 * 源有三类登录形态，这里统一收口：
 *   - 纯 URL / JSON 配置 → `action: 'browser'`，由桌面端打开登录窗收集 Cookie
 *   - 纯 HTTP 的 JS（java.post/cookie 等）→ `action: 'server'`，服务端直接跑
 *   - 依赖 WebView 的 JS（java.startBrowserAwait 等）→ `action: 'browser'`，服务端跑不了
 */
export interface UnifiedLoginResult {
  /** 登录是否成功（脚本跑通且拿到可用 Cookie / 或已交给浏览器） */
  ok: boolean;
  /**
   * 登录形态：
   *  - `server`    → 服务端跑了登录脚本
   *  - `browser`   → 需要打开登录页（人工/安全验证）
   *  - `form`      → 有 `loginUi` 表单，需要用户先填写（Legado 登录对话框）
   *  - `none`      → 该源无登录配置
   */
  action: 'server' | 'browser' | 'form' | 'none';
  /** 需要真实浏览器（java.startBrowserAwait / startBrowser / webView / 验证码） */
  needBrowser?: boolean;
  /**
   * `#393` 打开页面的**目的** —— 决定前端用哪种浏览器（判据唯一来源在 core `selector/js.ts`
   * 的 `BrowserOpenKind`；引擎按 `java.startBrowser` / `startBrowserAwait` 分别标注）。
   *  - `show`   → 只给人看（拿密钥 / 发布页 / 源作者内联的 `data:` 更新页，可能带「导入书源」按钮）
   *               ⇒ **应用内极简浏览器**（前进/后退/刷新，且接得住 `legado://` 导入链接）。
   *  - `cookie` → 脚本在等浏览器里的结果（`startBrowserAwait` / `webView` / 登录页）
   *               ⇒ 必须本机真浏览器（服务端 Chromium + CDP 回传 Cookie）；应用内 iframe 取不到跨域 cookie。
   *
   * 缺省按 `cookie` 处理（保守：宁可多开一次真浏览器，也不要拿不到登录态让用户白登录）。
   */
  browserKind?: 'show' | 'cookie';
  /** 可直接打开的登录页（action=browser 且源给了 URL 时） */
  url?: string;
  /** loginUi 表单行（action=form 时；type=text/password 需填写，button/toggle 是动作） */
  fields?: LoginField[];
  /**
   * `java.upLoginData(map)` 要求**实时更新登录界面字段值**（键 = 行 name）——
   * 前端把它回填进对应的输入框（**只改 UI，不落库**，与上游 `handleUpUiData` 同义）。
   *
   * 上游语义：`SourceLoginJsExtensions.kt:35-37` → `SourceLoginDialog.handleUpUiData`。
   * 实测用例（用户 2026-10-15，18AV 订阅源「🌐获取网址」）：
   * ```js
   * java.longToast('已填写最新网址\n'+surl);
   * let Info={}; Info['网址'] = surl; java.upLoginData(Info);
   * ```
   * 此前 core 未实现该 API（Proxy 兜底空函数）⇒ 用户看到「toast 说已填写、输入框仍空」。
   */
  loginData?: Record<string, string>;
  /**
   * 本次结果是否来自 **LoginUiV2**（`loginUi = {"version":2}`）。
   * v2 的 `fields` 是**每次渲染**由源脚本 `loginUi(state)` 产出的行，前端据此整表重绘。
   */
  uiV2?: boolean;
  /** v2：下一次动作要回传的会话状态（前端原样留存，别解释） */
  loginState?: string;
  /** v2：字段级错误（`key → 文案`）；key 不在表单里时按 toast 展示（Legado 同） */
  fieldErrors?: Record<string, string>;
  /** v2：源脚本要求关闭登录对话框（`{"close":true}`） */
  close?: boolean;
  /** 登录后该源的 Cookie 串（a=b; c=d） */
  cookie?: string;
  /** Cookie 条数 */
  count?: number;
  /** 登录头（Legado `putLoginHeader` 写入的 JSON，含 Cookie 等，后续请求自动附带） */
  loginHeader?: string;
  /** 是否已保存登录信息（loginUi 表单值 / 脚本写入） */
  hasLoginInfo?: boolean;
  /**
   * `#397` **本次运行是否新写了登录态**（Cookie 变化 / 登录头变化 / loginInfo 内容变化）。
   *
   * 为什么必须与 `hasLoginInfo`/`count` 区分：那两个是**当前状态**（源之前可能就写过 ——
   * ˃̶͈ ꇴ ˂̶͈ 的 TD()/setzt() 每次按钮都重写「密钥」loginInfo）⇒ 拿它们判「这次是不是真登录」
   * 会把「书源更新」这类纯动作按钮误报成「✅ 登录成功」。前端判「按钮动作是否真的登录」
   * 只认这个字段（旧服务端缺省时回退旧判据）。
   */
  wroteLoginState?: boolean;
  /** 脚本异常 / 未实现 login() 时的说明（中文，直接展示） */
  message?: string;
  /**
   * 登录脚本执行期间 `java.toast` / `java.longToast` 弹出的文本（按顺序）。
   *
   * 为什么必须回传：很多源的登录 UI 按钮（如禁漫天堂「切换分流线路」）**只有 toast 反馈**，
   * 不改 Cookie 也不改登录头。服务端早期把 toast 静默丢弃 → 用户点按钮「毫无反应」，
   * 误以为功能坏了。前端拿到后逐条弹出，等价于 Legado App 里的 Toast。
   */
  toasts?: string[];
}

/** `loginUi` 的一行（Legado `RowUi` 子集，见 engine-legado/model/login.ts） */
export interface LoginField {
  /** 显示名（v1 里也是 loginInfo 的存储键） */
  name: string;
  /** text / password / button / label / toggle / select */
  type: string;
  /**
   * **LoginUiV2 的存储键**（Legado `RowUi.key`）——v2 里 `name` 只是显示名、`key` 才是值存的键；
   * v1 表单没有这个字段（v1 用 `name` 当键）。
   */
  key?: string;
  action?: string;
  chars?: string[];
  default?: string;
  hint?: string;
  value?: string;
  options?: string[];
  countdown?: number;
  style?: { flexGrow?: number; flexBasisPercent?: number };
}

/**
 * `#583` **源脚本 UI 动作求值**（Legado `java.showBrowser` / 正文图片选项 `click` / `callBackJs`）。
 *
 * ## 为什么要专门一个契约
 * 有一类源把界面**自己画进正文**：七猫在每段末尾追加
 * `<img src="data:image/svg+xml;base64,…,{\"type\":\"qmpl\",\"click\":\"qmC_OpenComment(…)\"}">`
 * —— 图片只是「按钮皮」，点它要跑**源 jsLib 里的函数**（该函数再 `java.ajax` 拉评论、
 * 最后 `java.showBrowser(base, html)` 弹面板）。
 *
 * 浏览器侧不能执行源 jsLib（那是引擎侧的 JS 环境），所以链路必须是：
 *   前端收到点击 → 把 `click` 片段交服务端 → 引擎在**源真实环境**里求值 →
 *   把 `java.showBrowser` 记录的地址回传前端 → 前端用页内浏览器打开。
 * 这正是 Legado「图片选项 click」的等价物；本契约描述中间那一步。
 */
export interface UiActionRequest {
  /** 要执行的源脚本片段（`click` 的 JS 原文；或 `callBackJs` 全文） */
  code: string;
  /**
   * Legado `eventListener` 的事件名（`clickBookName` / `clickCustomButton`）。
   * 只有 `callBackJs` 需要它（源脚本靠 `event == …` 分支）。
   */
  event?: string;
  /** 书籍身份（`book.bookUrl`；callBackJs 会用它在 URI 里找 `id`） */
  bookUrl?: string;
  /** 书名（`book.name`；书评面板标题用） */
  bookName?: string;
  /** 章节地址（`chapter.url`） */
  chapterUrl?: string;
}

/** `#583` 源脚本 UI 动作的求值结果 */
export interface UiActionResult {
  /** 脚本要求打开的地址（`java.showBrowser` / `startBrowser`；data URL 或 http） */
  browserUrl?: string;
  /** 脚本最后一个表达式的值（`qmRun` 的 RPC 回填用） */
  value?: string;
  /** 脚本执行期间的 toast（源常用 toast 作为唯一反馈） */
  toasts?: string[];
}

/**
 * `#583` **正文里的「源脚本 UI 按钮」**（七猫：段评气泡 / 本章说 / 神评 / 书评）。
 *
 * ## 为什么不是 `html`（用户 2026-10-23 复测否决了第一版）
 * 第一版遇到选项图就下发 `UnifiedContent.html`，前端走 `<iframe srcdoc>`——
 * 书籍正文因此**丢掉了阅读样式、划词工具、高亮、分页**。源只是想在正文里插几个按钮，
 * 不该把整章降级成网页。
 *
 * 现在只把「按钮」抽出来：正文仍是 `paragraphs`（阅读器原样渲染），按钮以本结构随内容下发，
 * 前端在对应段落末尾渲染成图片（`img` 无文本节点 ⇒ 划词/高亮的字符偏移**一字不差**）。
 *
 * 与 `paragraphs` 的关系：`para` 是段落下标；`-1` = **章末**（本章说 / 书评这类独立条目）。
 */
export interface ContentUiMark {
  /** 归属段落下标（`paragraphs` 下标）；`-1` = 章末 */
  para: number;
  /** 按钮图片（源给的 data URL，已去掉 `,{…}` 选项尾巴） */
  img: string;
  /** 点击要执行的源脚本（选项 JSON 里的 `click`） */
  click: string;
  /** 源约定类型（`qmpl` / `qmpl-chapter-preview` / `qmpl-god` / `qm-review` …） */
  type?: string;
  /**
   * 图片版式（源选项 `style`）：
   * · `text` = 行内小图（段评气泡，跟在段落末尾）；
   * · `full` = 整宽条（本章说 / 神评 / 书评，段后独立一行）。
   */
  style?: 'text' | 'full';
  /** 可读标签（`title` / 无障碍；源没给类型时为空） */
  label?: string;
}

export interface UnifiedPlay {
  /** 解析后的直链 */
  url: string;
  /** 需要透传给播放器的请求头（Referer / User-Agent） */
  headers?: Record<string, string>;
  /** 播放类型，交给播放器决定怎么放 */
  format?: 'm3u8' | 'mp4' | 'audio' | 'unknown';
  /** 备选直链（同 `UnifiedContent.media.alternatives`：前端按序尝试，成功即停） */
  alternatives?: string[];
  /** `#152`：本次请求有文本响应被截断（可能影响已解析出的直链集合） */
  netTruncated?: NetTruncatedInfo;
}
