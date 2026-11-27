/**
 * `#310` 源的**能力事实**（`hasSearch` / `hasExplore`）—— 唯一实现。
 *
 * ## 为什么单独成一个模块
 * 这两个值此前是 `publicSource()` 里的内联三元表达式：**没法单测**（`publicSource` 还依赖
 * `hub.getSourceLoginInfo`），于是「订阅源到底能不能搜」只能靠真机点一次。`#310` 的缺陷
 * 恰恰就出在这一行 —— 抽出来才能把它钉成断言。
 *
 * ## 两者都是**事实**，不是**用户开关**
 *  · `hasSearch`/`hasExplore` = 源里**有没有这条规则**（服务端算好给前端）。
 *  · `searchEnabled`/`exploreEnabled` = **用户要不要**用（`s.state`）。
 * 两者**正交**：前端 `apps/web/src/utils/source-gate.ts` 拿这两组值合成「能不能用」。
 * ⚠️ 别把用户开关算进来 —— 那会让「改了开关」和「源本来没有规则」两种完全不同的原因
 *    在 UI 上长得一模一样（本仓 `#247` 的原话：同一判据写两遍必然漂移）。
 */

/** 取 `raw` 里的非空字符串（缺失/类型不对 ⇒ undefined，不抛） */
function str(raw: Record<string, unknown>, k: string): string | undefined {
  return typeof raw[k] === 'string' ? (raw[k] as string) : undefined;
}

/**
 * `#293` / `#310` **是否具备搜索能力**（源列表「搜索」滑块、🔍 按钮、发现页 ⌕、
 * 聚合搜索与换源搜索的源列表，全部以它为准 —— 没有搜索规则的源点了也没结果，入口不该出现）。
 *
 * ## 各 kind 的判据（逐字对齐引擎取模板的表达式，不另立标准）
 *  · **`legado`**：`tpl = rule.searchUrl || rule.ruleSearch?.searchUrl || ''`
 *    —— 引擎就是这么取搜索请求模板的（`engine-legado/src/engine.ts:1986`），空模板 ⇒ 搜不出东西。
 *  · **`rss`**（`#310` 补上）：`rule.searchUrl`（上游 `RssSource.searchUrl`，`RssSource.kt:116`）。
 *    ⚠️ 此前这一支落到 `else → true` ⇒ **没有 `searchUrl` 的订阅源被当成「能搜」**：
 *    它出现在聚合搜索/换源搜索的源列表里、发现页也给它搜索按钮，点下去只拿到
 *    `UNSUPPORTED_ACTION · 该订阅源未配置 searchUrl，不支持搜索`（`engine-rss/src/engine.ts:271`）。
 *  · **`maccms` / `demo` 等**：恒可搜 —— 它们的搜索请求由引擎按站点形态拼，不依赖源里的 url。
 */
export function computeHasSearch(kind: string, raw: Record<string, unknown>): boolean {
  if (kind === 'legado') {
    return Boolean(
      (str(raw, 'searchUrl') ?? '').trim()
      || String(((raw['ruleSearch'] ?? {}) as Record<string, unknown>)['searchUrl'] ?? '').trim(),
    );
  }
  if (kind === 'rss') {
    // `RssSource.searchUrl` —— 与 `engine-rss` 取模板的表达式一致（`rule.searchUrl`）
    return Boolean((str(raw, 'searchUrl') ?? '').trim());
  }
  return true;
}

/**
 * **是否具备发现能力** —— 对齐 Legado `BookSourcePart.hasExploreUrl`
 * （`exploreUrl is not null and trim(exploreUrl) <> ''`）与 DAO「发现」查询的
 * `enabledExplore = 1 and hasExploreUrl = 1`。`ruleExplore` 只是解析规则，没有 `exploreUrl`
 * 的源在 Legado 发现页里根本不出现。
 *
 * ⚠️ 与 `exploreEnabled`（**用户开关**）正交，见文件头。
 *
 * ## ★ RSS 恒为 `true`
 * 上游 `RssSource`（`RssSource.kt:15-117`，45 个字段）**没有** `enabledExplore`
 * （那是 `BookSource.kt:52` 的），所以订阅源**没有发现开关** —— 前端因此不为它渲染滑块。
 * 但「没有开关」不等于「不能发现」：订阅源的发现页内容由 `sortUrl` 分类表驱动（`#307`）。
 * 这里返回 `true` 是**事实描述**（订阅源没有「缺少发现能力」这回事），由前端
 * `hasExploreSwitch(kind)` 决定「不给它滑块」。
 */
export function computeHasExplore(kind: string, raw: Record<string, unknown>): boolean {
  if (kind === 'legado') return Boolean((str(raw, 'exploreUrl') ?? '').trim());
  return true;
}

/**
 * `#335` **是不是「网页型订阅源」**（上游走 `loadUrl` / webView 直接把 URL 当一篇文章打开）。
 *
 * ## 判据：只认 `singleUrl === true`，与引擎**逐字同一条**
 * `engine-rss/src/model/rss-source.ts:194` ⇒ `singleUrlOnly: raw.singleUrl === true`；
 * 引擎 `home` 对它不进分类列表（回一个无名分类 = 那个 URL），`category` 对它**恒回 1 篇**
 * （标题 = 源名，link = URL），正文交给 webView 渲染 —— 它**不是**「坏掉的 feed」。
 *
 * ⚠️ **不要**再加「且无 `ruleArticles`」这类第二条件：那会与引擎分岔
 * （`#310`/`#313` 教训：同一判据写两处必然漂移；单边改对 = 造新缺陷）。
 *
 * ## 为什么前端必须知道
 * 这类源点开就是一张网页（全版本汇总 / 源仓库 / XH发布页）。走「分类 → 卡片 → 详情 → 正文」
 * 这条链会在正文处撞上 `UNSUPPORTED`（无内嵌正文且 `ruleContent` 空），用户看到的是报错。
 * 正解是**直接以源地址打开阅读页**（`#335` 的「极简浏览器」通路）。
 */
export function computeWebViewOnly(kind: string, raw: Record<string, unknown>): boolean {
  if (kind !== 'rss') return false;
  return raw['singleUrl'] === true;
}

/**
 * `#404` **订阅源有没有「启动页」**（`startHtml`）。
 *
 * ## 判据：静态「`raw.startHtml` 非空」—— 对上游「求值后非空」的**近似**
 * 上游 `RssViewModel.launchRssWithHtml:82-106` 是**求值后**再判空；静态无法预知脚本结果
 * （18AV 的 startHtml 会按登录态返回空串）。所以：
 *  · 本判据只用于**前端是否去请求启动页**（有 `startHtml` 才值得调 `/api/run action=start`）；
 *  · **最终是否真的展示**以引擎 `start` 动作返回的 `html` 是否非空为准（真值源）。
 * ⚠️ 不要把它当能力门控（源带 `startHtml` 也可能永远返回空）——与 `webViewOnly` 同族注记。
 */
export function computeHasStartPage(kind: string, raw: Record<string, unknown>): boolean {
  if (kind !== 'rss') return false;
  return Boolean((str(raw, 'startHtml') ?? '').trim());
}
