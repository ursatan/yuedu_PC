/**
 * Legado RssSource 模型 —— 字段与上游逐条对齐（不猜测）
 *
 * 上游：`F:\legado\app\src\main\java\io\legado\app\data\entities\RssSource.kt`
 * 主构造器 **45 个字段**（2026-10-06 逐条清点）：
 *   sourceUrl(PK) · sourceName · sourceIcon · sourceGroup · sourceComment · enabled ·
 *   variableComment · jsLib · enabledCookieJar · concurrentRate · header · loginUrl ·
 *   loginUi · loginCheckJs · coverDecodeJs · sortUrl · singleUrl · articleStyle ·
 *   ruleArticles · ruleNextPage · ruleTitle · rulePubDate · ruleDescription · ruleImage ·
 *   ruleLink · ruleContent · nextContentUrl · contentWhitelist · contentBlacklist ·
 *   shouldOverrideUrlLoading · style · enableJs · loadWithBaseUrl · injectJs · preloadJs ·
 *   startHtml · startStyle · startJs · showWebLog · lastUpdateTime · customOrder · type ·
 *   preload · cacheFirst · searchUrl
 *
 * detect 依据（书源 BookSource **没有**这些字段）：ruleArticles / sortUrl /
 * articleStyle / singleUrl / nextContentUrl / startHtml / shouldOverrideUrlLoading。
 * 语料实测（330 个 RSS 源）：236 有 ruleArticles、212 有 sortUrl、0 个有 sourceKind 字段。
 */

/** 上游 RssSource 主构造器的 JSON 形态（45 字段，null 表示可缺省） */
export interface RssSourceRaw {
  sourceUrl: string;
  sourceName: string;
  sourceIcon?: string | null;
  sourceGroup?: string | null;
  sourceComment?: string | null;
  enabled?: boolean;
  variableComment?: string | null;
  jsLib?: string | null;
  /** 上游默认 true（@ColumnInfo defaultValue="0" 但主构造器 = true） */
  enabledCookieJar?: boolean | null;
  concurrentRate?: string | null;
  header?: string | null;
  loginUrl?: string | null;
  loginUi?: string | null;
  loginCheckJs?: string | null;
  coverDecodeJs?: string | null;
  sortUrl?: string | null;
  singleUrl?: boolean;
  /** 列表样式 0/1/2/3/4（0 默认） */
  articleStyle?: number;
  ruleArticles?: string | null;
  ruleNextPage?: string | null;
  ruleTitle?: string | null;
  rulePubDate?: string | null;
  ruleDescription?: string | null;
  ruleImage?: string | null;
  ruleLink?: string | null;
  ruleContent?: string | null;
  /** 正文下一页（保存型字段，运行期 AnalyzeUrl 会写它） */
  nextContentUrl?: string | null;
  contentWhitelist?: string | null;
  contentBlacklist?: string | null;
  shouldOverrideUrlLoading?: string | null;
  style?: string | null;
  /** 上游默认 true */
  enableJs?: boolean;
  /** 上游默认 true */
  loadWithBaseUrl?: boolean;
  injectJs?: string | null;
  preloadJs?: string | null;
  startHtml?: string | null;
  startStyle?: string | null;
  startJs?: string | null;
  showWebLog?: boolean;
  lastUpdateTime?: number;
  customOrder?: number;
  /** 类型 0网页 / 1图片 / 2视频（上游默认 0） */
  type?: number;
  preload?: boolean;
  cacheFirst?: boolean;
  searchUrl?: string | null;
  /** 导入清单可能带的杂项字段（comment / bookSourceUrl 误装等），原样保留不参与 detect */
  [extra: string]: unknown;
}

/** detect：是否 RSS 订阅源（对齐语料实测特征；书源字段不冲突） */
export function detectRssSource(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  // 显式书源特征优先排除（BookSource 的主键名不同：bookSourceUrl）
  if (typeof o.bookSourceUrl === 'string' && o.bookSourceUrl) return false;
  if (typeof o.sourceUrl !== 'string' || !o.sourceUrl) return false;
  return (
    typeof o.ruleArticles === 'string' ||
    typeof o.sortUrl === 'string' ||
    typeof o.articleStyle === 'number' ||
    o.singleUrl === true ||
    typeof o.nextContentUrl === 'string' ||
    typeof o.startHtml === 'string' ||
    typeof o.shouldOverrideUrlLoading === 'string'
  );
}

/** 编译后的规则（默认值对齐上游主构造器）。
 *  注：**id 不在这里派生** —— facade 的 `deriveId` 已认 `sourceUrl` 候选（第二位），
 *  与文件源「文件名即 id」同一套 `safeSourceId`，引擎内不再实现第二份（#247 同判据两处必漂移）。 */
export interface RssSourceRule {
  sourceUrl: string;
  sourceName: string;
  sourceIcon: string;
  sourceGroup: string | null;
  sourceComment: string | null;
  enabled: boolean;
  header: string | null;
  enabledCookieJar: boolean;
  sortUrl: string | null;
  singleUrl: boolean;
  articleStyle: number;
  ruleArticles: string | null;
  ruleNextPage: string | null;
  ruleTitle: string | null;
  rulePubDate: string | null;
  ruleDescription: string | null;
  ruleImage: string | null;
  ruleLink: string | null;
  ruleContent: string | null;
  /**
   * **封面解密 JS**（上游 `RssSource.coverDecodeJs`，`BaseSource` 字段）。
   *
   * `#434` 补齐：订阅源的封面也可以是**密文**（实测 91视频 `image` 是完整绝对 URL、
   * 经 `/api/proxy` 回 200，但内容是 AES 密文）⇒ 引擎必须能跑这段脚本才有封面。
   * 语义 = Legado `ImageUtils.decode`：入参 `result`（图片字节，InputStream）/`src`（图片 URL），
   * 返回解密后的 ByteArray（见 `RssEngine.decodeImage`）。
   *
   * ⚠️ 上游 RSS 源**没有**正文图解密字段（那是 BookSource `contentRule.imageDecode`）
   * ⇒ RSS 侧只有这**一条**解密通路。
   */
  coverDecodeJs: string | null;
  /** 正文下一页（保存型字段，运行期 AnalyzeUrl 会写它）——本仓只在正文追页时**读** */
  nextContentUrl: string | null;
  /** 0网页 / 1图片 / 2视频 */
  type: number;
  searchUrl: string | null;
  /**
   * 登录（上游 `RssSource.kt:40-44` 继承自 `BaseSource`）—— **订阅源登录是一等功能**
   * （`#314`）：`RssSourceDao.kt:85` 专查有 `loginUrl` 的订阅源、`RssAdapter.kt:68` 挂「登录」菜单、
   * `RssSortActivity.kt:303`（分类/排序界面）也按 `loginUrl` 显示入口。
   * ⚠️ 此前本仓编译出的 RssSourceRule **没有这两个字段** ⇒ 引擎读不到 → 登录能力整块缺。
   */
  loginUrl: string | null;
  loginUi: string | null;
  /**
   * **单 URL 源**（上游 `RssSource.singleUrl`）—— `#317` 新增，**它是能力位、不是 webView**。
   *
   * 上游语义（逐行核实，别按名字猜）：
   *   · `RssFragment.openRss:183` → `if (rssSource.singleUrl) viewModel.getSingleUrl(...)` →
   *     `ReadRssActivity.start(..., url)` ⇒ **把该源当成「一篇文章」直接打开**，**从不请求列表**；
   *   · `RssViewModel.getSingleUrl:48-70`：`sortUrl` 非空 → `<js>`/`@js:` 先求值；含 `::` 取第二段；
   *     否则整段；`sortUrl` 空 ⇒ 用 `sourceUrl`；
   *   · `ReadRssViewModel:127`：`ruleContent.isNullOrBlank() || rssSource?.singleUrl == true` ⇒ `loadUrl`（正文走 webView）。
   * ⇒ 本仓对应实现 = 列表恒 **1 篇**（link = 上面求出的 url）、正文走既有 `renderArticle` 通路。
   */
  singleUrlOnly: boolean;
  /**
   * webView 专属字段的**能力注记**（`#317`）——
   * ⚠️ **它不是整源门控**。上游没有「有 webView 字段 ⇒ 不支持该源」这个概念：
   *   · `startHtml`（webView 起始页）只用于 `ReadRssActivity.loadStartHtml`（打开**文章**时）；
   *   · `shouldOverrideUrlLoading`（页面内跳转拦截）只影响 webView 内的导航；
   *   · `injectJs`/`preloadJs` 只在渲染正文时注入。
   *   四者**都不影响列表解析**。旧实现（`#307`）把「无 ruleArticles 且有这些字段之一」判
   *   `webViewOnly` 并**整源拒绝** ⇒ 连 `📖Lofter`（有完整 `ruleArticles`，只因带 `startHtml`）
   *   都被整源拒掉。`#317` 按上游拆开：列表照常解析，只在响应里**注记**能力边界。
   */
  webViewFeatures: {
    startHtml: boolean;
    shouldOverrideUrlLoading: boolean;
    injectJs: boolean;
    preloadJs: boolean;
  };
  raw: RssSourceRaw;
}

/** 源唯一键规范化提示：实际派生统一走 facade `deriveId`（认 sourceUrl 候选），此处不实现。 */

/** 编译：归一默认值（全部对齐上游主构造器默认） */
export function compileRssSource(raw: RssSourceRaw): RssSourceRule {
  const sourceUrl = (raw.sourceUrl ?? '').trim();
  return {
    sourceUrl,
    sourceName: (raw.sourceName ?? '').trim(),
    sourceIcon: raw.sourceIcon ?? '',
    sourceGroup: raw.sourceGroup ?? null,
    sourceComment: raw.sourceComment ?? null,
    enabled: raw.enabled !== false,
    header: raw.header ?? null,
    enabledCookieJar: raw.enabledCookieJar !== false,
    sortUrl: raw.sortUrl?.trim() || null,
    singleUrl: raw.singleUrl === true,
    articleStyle: typeof raw.articleStyle === 'number' ? raw.articleStyle : 0,
    ruleArticles: raw.ruleArticles?.trim() || null,
    ruleNextPage: raw.ruleNextPage?.trim() || null,
    ruleTitle: raw.ruleTitle?.trim() || null,
    rulePubDate: raw.rulePubDate?.trim() || null,
    ruleDescription: raw.ruleDescription?.trim() || null,
    ruleImage: raw.ruleImage?.trim() || null,
    ruleLink: raw.ruleLink?.trim() || null,
    ruleContent: raw.ruleContent?.trim() || null,
    // 封面解密 JS（`#434`）：与 legado 的 `coverDecodeJs` 同名同义
    coverDecodeJs: raw.coverDecodeJs?.trim() || null,
    nextContentUrl: raw.nextContentUrl?.trim() || null,
    type: typeof raw.type === 'number' ? raw.type : 0,
    searchUrl: raw.searchUrl?.trim() || null,
    // 登录字段（`#314`）：上游 RssSource 继承 BaseSource 的 loginUrl/loginUi
    loginUrl: raw.loginUrl?.trim() || null,
    loginUi: raw.loginUi?.trim() || null,
    // 单 URL 源（`#317`）——上游 `singleUrl` 的语义见接口上的注释。
    singleUrlOnly: raw.singleUrl === true,
    // webView 专属字段：**注记**（不门控）。旧实现（`#307`）把这里当成整源门控，
    // 依据只读到上游的一半（`ReadRssViewModel.initData` 的 loadUrl 分支），
    // 漏了「`singleUrl` 分支在 `RssFragment.openRss` 里根本不进列表」与
    // 「`startHtml`/`shouldOverrideUrlLoading` 只作用于渲染层」⇒ 误拒了带 `startHtml` 的列表源。
    webViewFeatures: {
      startHtml: !!raw.startHtml,
      shouldOverrideUrlLoading: !!raw.shouldOverrideUrlLoading,
      injectJs: !!raw.injectJs,
      preloadJs: !!raw.preloadJs,
    },
    raw,
  };
}
