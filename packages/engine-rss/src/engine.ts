/**
 * RSS（Legado RssSource）引擎 —— 第二批：RssParserByRule 规则引擎
 *
 * 上游行为（2026-10-06 精读，全部有源码依据）：
 *  - 文章列表：`Rss.getArticlesAwait` → `RssParserByRule.parseXML` →
 *    **ruleArticles 为空走 `RssParserDefault`**，有规则走 AnalyzeRule 规则引擎（本批）。
 *  - sortUrl 语义（RssViewModel.getSingleUrl + AnalyzeUrl）：`<js>`/`@js:` **先执行** →
 *    `::` 取后段 → `{{}}` 求值（page/key）——见 env.ts buildFeedUrl。
 *  - 正文：`Rss.getContentAwait` 用 ruleContent 解析 link 页 + nextContentUrl 翻页；
 *    **ruleContent 为空时上游直接 webView 渲染 link**（type=0）。
 *  - `#308` 正文一律作**HTML**下发（`UnifiedContent.html`）：上游 `ReadRssActivity.initLiveData`
 *    把 description / ruleContent 结果 `clHtml()` 后 `loadDataWithBaseURL` —— 就是「组装 webView」。
 *    见 `content()` 里那段注释与契约 `UnifiedContent.html`。
 *
 * 能力边界（不做 webView / JS 渲染，能力门控必须显式可见）：
 *  - ✅ home/category/search/detail/content 的 default + 规则两条解析路径
 *  - ✅ ruleNextPage 分页（{{page}} 模板递增 / 'PAGE' / 规则解析型，见 listArticles）
 *  - ✅ `#308` 正文 HTML 原样下发（description / ruleContent / 渲染层结果）
 *  - ❌ webView 类（startHtml/shouldOverrideUrlLoading/injectJs/preloadJs）：显式 UNSUPPORTED，绝不静默跑错
 */

import {
  EngineError,
  AnalyzeRule,
  resolveUrl,
  isLoginHeaderSite,
  LOGIN_HEADER_PREFIX,
  LOGIN_INFO_PREFIX,
  classifyLoginUrl,
  extractInlineJs,
  normalizeLoginField,
  parseLoginUiText,
  readLoginInfo,
  persistSourceLogin,
  /** `#315`：登录执行流程共享件（早退 / 表单闸门 / 拼脚本 / 错误定性 —— 判据唯一实现） */
  loginPlanEarlyResult,
  loginFormGate,
  buildLoginScript,
  needBrowserFromError,
  /** `#423`「只渲染登录界面」伪动作（打开对话框的只读渲染） */
  LOGIN_UI_RENDER_ACTION,
  type LoginField,
  type RuleEngine,
  type EngineAction,
  type EngineErrorCode,
  type CompileResult,
  type EngineContext,
  type UnifiedRequest,
  type UnifiedListResult,
  type UnifiedDetail,
  type UnifiedContent,
  type UnifiedStartResult,
  type UnifiedItem,
  type UnifiedChapter,
  type UnifiedLoginResult,
  type ValidationIssue,
  type TraceEntry,
  splitUrlOptions,
  optionToRequest,
  /** `#419`：URL 中缀 `@js:` 段求值（唯一实现；正文面的 link 也要跑，见 `fetchContentPage`） */
  applyUrlRuleJs,
  /**
   * `#346` 媒体直链提取 —— **core 的唯一实现**（与 legado 引擎同一份）。
   * 订阅源 `type===2`（视频）此前**完全没有**播放通路：正文 HTML 进沙箱 iframe，
   * Chromium 无原生 HLS ⇒ 黑屏播放器 0:00（2026-10-08 麻豆传媒实测）。
   */
  mediaFromRaw,
  /**
   * `#434` **卡片描述净化**（Legado `HtmlFormatter.formatIntro` 的唯一实现）。
   * 卡片上的 `summary` 是**给卡片看的短文本**，源规则（`ruleDescription` / XML `<description>`）
   * 常直接返回 HTML 片段 ⇒ 不剥标签就会把 `<p>`、`<!-- 注释 -->` 原样显示在卡片描述里。
   * 与 `engine-legado` 列表项的 `summary: formatIntro(...)` **同一条语义**（那边早有、RSS 漏了）。
   */
  formatIntro,
  /**
   * `#434` 封面解密（`coverDecodeJs`）要把图片字节喂给源脚本 —— 上游封面走 `byteStream()`
   * （**InputStream** 语义，脚本用 `result.readAllBytes()`），只给裸 `Uint8Array` 会
   * `readAllBytes is not a function`（与 legado 侧同一坑，见 `core/selector/image-bytes.ts`）。
   */
  asImageStreamResult,
  // `#759` 单张封面解密下移 worker（默认开；`YUEDU_IMAGE_DECODE_WORKER=0` 回旧行为）
  imageDecodeBindings,
  // `#782` 冷规则首图改在 worker 探测（主线程零阻塞），探测样本单独记账
  planImageDecode,
  recordImageDecodeProbeCost,
  abortImageDecodeProbe,
  recordImageDecodeL1Cost,
  shouldRetryImageDecodeInL1,
} from '@yuedu/core';
import type { HttpRedirect, HttpResponse } from '@yuedu/core/contract';
import { compileRssSource, detectRssSource, type RssSourceRaw, type RssSourceRule } from './model/rss-source';
import { parseRssDefaultXml, type RssArticle } from './parser/rss-xml';
import { parseRssByRule } from './parser/rss-rule';
import { extractImageUrls } from './parser/html-text';
import {
  buildFeedRequest, buildFeedUrl, makeRssEnv, primeJsLib, primeSourceVariable, sourceHeadersFromCtx, warnOnce,
  whenSourceHeadersPrimed,
  type FeedRequest,
} from './env';
import { parseRssSortUrls, rssSortScript } from './sorts';

/**
 * 分类解析结果的**进程内缓存**（对齐上游 `RssSourceExtensions` 的 ACache，见 sorts.ts）。
 *
 * 为什么需要：`sortUrl` 是 `@js:` 型的源（本仓语料 5/31），那个脚本常常要去请求站点
 * （`java.ajax`）才能算出分类串 —— 每翻一页都重跑一遍既慢又容易被站点限频。
 * 键含 `sortUrl` 原文 ⇒ 用户改了规则自然失效，**不需要**额外的失效钩子。
 * ⚠️ 只缓存「脚本真的跑出了内容」的结果：失败也缓存会把一次偶发网络问题当永久事实。
 */
const sortsCache = new Map<string, Array<{ name: string; url: string }>>();

/**
 * 登录信息的**指纹**（`#314`）—— 用于分类缓存键。
 *
 * 为什么必须进键：语料里 `影视聚合(资源站)` 这类源的 `sortUrl` 脚本**按登录信息选源站**
 * （`let loginInfo = source.getLoginInfoMap(); … loginInfo["选择影视源站"] → SITE_CONFIG[i]`）。
 * 键只含 `sourceUrl + sortUrl` 时，用户切了源站再刷新分类 ⇒ 命中旧缓存 ⇒ **分类纹丝不动**
 * （正是用户 2026-10-07 报的「并没有加载新源站（登录页下拉列表对应）的分类」）。
 *
 * 键排序后拼接：同一份登录信息必须给出同一个键（`JSON.stringify` 依赖插入顺序，不稳）。
 */
function loginFingerprint(ctx: EngineContext): string {
  const info = readLoginInfo(ctx);
  const keys = Object.keys(info).sort();
  if (!keys.length) return '';
  return keys.map((k) => `${k}\u0001${info[k]}`).join('\u0002');
}

/** 章节 payload：列表阶段抓到的文章全量（content 阶段零请求即可回放） */
interface ChapterPayload extends RssArticle {
  /** 源的 feedUrl（content 缺正文时需要回源，留作后续批次） */
  feedUrl?: string;
}

const ENGINE = 'rss';

function err(code: EngineErrorCode, stage: 'request' | 'parse', sourceId: string, message: string, rule?: string, trace: TraceEntry[] = []): EngineError {
  // EngineError 的 message 由 code@stage 组成；自定义中文消息放 detail.input（排障面板可见）
  return new EngineError(code, stage, { engine: ENGINE, sourceId, rule, input: message, trace });
}

/**
 * 响应 `Set-Cookie` 回收进源级 Cookie 存储（对齐 okhttp CookieJar / Legado CookieStore）。
 *
 * ## 为什么必须有（`#344` 实测缺陷）
 * 大量站点的**反爬挑战页**是「首次访问下发挑战 cookie（如 `d652…=90aa…`）→ 带该 cookie 重放才给真页面」。
 * 此前 RSS 引擎只发不收（`engine-legado` 早已有 `harvestCookies`，RSS 漏了这一半）⇒
 * 每次请求都拿挑战页 ⇒ 列表规则解析 0 条 ⇒ 报 `SELECTOR_MISS@parse`。
 *
 * 真数据取证（次元小镇 `https://dimtown.com/vip-illustration/page/1`）：
 * ```
 * 初次         status=403 len=133    set-cookie: d652…=90aa…（挑战）
 * 带该 cookie  status=200 len=89480  含目标选择器 `.kzpost-data` ✅
 * ```
 * 即「不是选择器错、不是源坏」，是**会话 cookie 没落库**。
 *
 * 带 `Max-Age=0` / 1970 过期时间的条目视为删除（对齐上游 CookieStore.removeCookie）。
 * 与 `engine-legado` 的同名实现保持**同一语义**（同一判据只此一处，别再各写一份）。
 */
function harvestCookies(ctx: EngineContext, resp: { headers: Record<string, string> }): void {
  const raw = resp.headers['set-cookie'];
  if (!raw || !ctx.cookies) return;
  for (const line of raw.split('\n')) {
    const pair = (line.split(';')[0] ?? '').trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (/max-age=0(?!\d)|expires=thu,\s*01\s*jan\s*1970/i.test(line)) {
      ctx.cookies.remove?.(name);
      continue;
    }
    ctx.cookies.set(name, value);
  }
}

/**
 * `#698` **订阅源调试信息流的一行**（对齐上游 `Debug.log`，`Debug.kt:66-93`）。
 *
 * 为什么放引擎而不是只放在门面：上游 RSS 的调试行**几乎全是解析过程的回执**
 * （`┌获取列表 / └列表大小:32`、`┌获取标题 / └…`、内容页那份 HTML），
 * 只有门面知道「摘要」，不知道「规则对哪一段求值出了什么」。
 *
 * 落点 `ctx.trace.push({ msg })`：宿主订阅 trace 即可流式推前端；出错时同一批条目
 * 还会进 `EngineError.trace`。**日志绝不允许影响解析** ⇒ 整体 try/catch。
 */
function dlog(ctx: EngineContext | undefined, msg: string, level?: 'warn' | 'error'): void {
  if (!ctx) return;
  try {
    ctx.trace.push({ stage: 'parse', msg, ...(level ? { level } : {}) });
  } catch {
    /* 调试通道故障不能改变解析结果 */
  }
}

/**
 * `#698` 日志里显示的「请求 URL」：**上游 RSS 打的是规则求值后的 URL 原样**
 * （`Rss.kt:83` 的 `analyzeUrl.ruleUrl`，相对路径就显示相对路径）。
 * 这里：模板本身是相对路径（`/Articles`）⇒ 输出 path+search；否则输出绝对地址。
 */
function ruleUrlForLog(tpl: string, resolved: string, sourceUrl: string): string {
  try {
    const isRel = !/^https?:\/\//i.test(tpl.trim());
    if (!isRel) return resolved;
    const u = new URL(resolved);
    return `${u.pathname}${u.search}`;
  } catch {
    return resolved || sourceUrl;
  }
}

/** 截一行里的长串（内容页整篇 HTML 可能上万字；上游原样打印，Web 端要限一下） */
function clipText(v: string, maxLen: number): string {
  return v.length > maxLen ? `${v.slice(0, maxLen)}…(共 ${v.length} 字)` : v;
}

/**
 * `#699` **重定向回执**（上游 `Rss.kt:246-254` 的 `checkRedirect`，紧接在 `≡获取成功` 之前）。
 *
 * 上游只打「最后一跳」（`response.raw.priorResponse?.let`），我们打**每一跳**：
 * 单跳时与上游逐字相同；多跳时多出来的几行是真实的（每行带自己的目标），
 * 能把「301 永久迁移」与「302 被风控弹到验证页」分开 —— 这正是排查「站点换域名」要的信息。
 *
 * 数据来源：网络层 `#699` 已改成自己跟链（`net/index.ts` 的 `fetchOnceInner`），
 * `HttpResponse.redirects` 里带着每跳的 `{status, url, location, target}`。
 */
function logRedirects(ctx: EngineContext, res: { redirects?: HttpRedirect[] } | undefined): void {
  for (const hop of res?.redirects ?? []) {
    dlog(ctx, `≡检测到重定向(${hop.status})`);
    dlog(ctx, '┌重定向后地址');
    dlog(ctx, `└${clipText(hop.target, 240)}`);
  }
}

export class RssEngine implements RuleEngine<RssSourceRule, RssSourceRaw> {
  readonly kind = ENGINE;
  readonly version = '0.1.0';
  readonly capabilities: EngineAction[] = ['home', 'category', 'search', 'detail', 'content', 'start', 'login'];

  detect(raw: unknown): boolean {
    return detectRssSource(raw);
  }

  compile(raw: RssSourceRaw): CompileResult<RssSourceRule> {
    const rule = compileRssSource(raw);
    if (!rule.sourceUrl) {
      return {
        ok: false,
        issues: [{ level: 'error', path: 'sourceUrl', message: 'sourceUrl 缺失（RSS 订阅源主键）' }],
      };
    }
    const issues: ValidationIssue[] = [];
    // `#317`：webView 专属字段**只注记、不门控**（上游对它们没有「整源不支持」语义）。
    const wv = rule.webViewFeatures;
    const wvNames = [
      wv.startHtml && 'startHtml',
      wv.shouldOverrideUrlLoading && 'shouldOverrideUrlLoading',
      wv.injectJs && 'injectJs',
      wv.preloadJs && 'preloadJs',
    ].filter(Boolean) as string[];
    if (wvNames.length) {
      issues.push({
        level: 'warn',
        message: `源声明了 webView 专属字段（${wvNames.join('/')}）：本引擎不执行页面内 JS 与跳转拦截，列表/正文按非 webView 通路解析`,
      });
    }
    return { ok: true, rule, issues };
  }

  // ------------------------------------------------------------------
  // 私有：feed 列表拉取 + 解析
  // ------------------------------------------------------------------

  /**
   * 单 URL 源的 URL（`#317`，对齐上游 `RssViewModel.getSingleUrl:48-70`）。
   *
   * 上游三条分支：`sortUrl` 空 ⇒ `sourceUrl`；`<js>`/`@js:` ⇒ 先求值取结果；否则原文。
   * 拿到串后：含 `::` ⇒ 取 `::` 之后那段（即 `名称::url` 的 url）。
   *
   * ⚠️ **两处有意收窄上游的怪异行为**（都会写进测试）：
   *   ① 上游对多条目 `sortUrl` 用 `split("::")[1]` ⇒ 会连带后面的条目（`urlA\nB::urlB`）；
   *      本仓用 `parseRssSortUrls` 取**第一条的 url**（意图等价、结果干净）。
   *   ② 上游在脚本求值结果为空时**保留脚本原文当 URL**（把 `<js>…` 当地址发出去）；
   *      本仓回落 `sourceUrl`。
   */
  private async resolveSingleUrl(rule: RssSourceRule, ctx: EngineContext): Promise<string> {
    const rawSort = (rule.sortUrl ?? '').trim();
    if (!rawSort) return rule.sourceUrl;
    const script = rssSortScript(rawSort);
    if (script) {
      const env = makeRssEnv(ctx, rule, rule.sourceUrl);
      try {
        const r = await env.jsEval(script, {
          source: env.sourceData ?? {},
          baseUrl: rule.sourceUrl,
          page: 1,
          key: '',
          result: '',
        });
        const s = r == null ? '' : String(r).trim();
        if (s) return parseRssSortUrls(s, rule.sourceUrl)[0]?.[1] || rule.sourceUrl;
      } catch (e) {
        warnOnce(`singleurl:${rule.sourceUrl}`,
          `源 ${rule.sourceName || rule.sourceUrl} 的单 URL 脚本执行失败，回落源地址：${e instanceof Error ? e.message : String(e)}`);
      }
      return rule.sourceUrl;
    }
    return parseRssSortUrls(rawSort, rule.sourceUrl)[0]?.[1] || rule.sourceUrl;
  }

  /**
   * 动作入口的公共前处理（`#314`）：**prime 源级登录态**。
   *
   * 为什么必须 prime：hub 注入的 `ctx.loginInfo` 只覆盖**本次进程内**保存过的值
   * （`sourceLoginInfo` 是内存 Map，启动时不从 storage 水合，且 `makeContext` 每请求新建
   * variables store）⇒ 不 prime 就会「重启后登录态丢失」。Legado 由 `primeSourceState` 做这件事。
   * 读回后 `source.getLoginInfoMap()`（= `source-login.ts` 的 `readLoginInfo`）会与 ctx 那份合并。
   * ★ `#317`：`rule` 参数保留（签名稳定），但**不再做整源能力门控**。
   */
  private async prepare(rule: RssSourceRule, ctx: EngineContext): Promise<void> {
    // `#381`：jsLib 异步预下载（映射表/单 URL ⇒ ctx.http 拉进缓存）。必须先于任何
    // makeRssEnv —— 同步求值面的 jsLib 下载器是 curl 子进程（本机 EBUSY 恒失败），
    // 不预下载则 qyyuapi 系源 `Get`/`Reload` 未定义 ⇒ 分类退化 RULE_PARSE。
    await primeJsLib(ctx, rule);
    /**
     * `#600` 源变量初始化：`loginUrl` 里的 `put($$$)` 是**源变量**的唯一初始化点，
     * 而 jsLib 的 `Get()/Map()` 全靠它。必须早于任何 `makeRssEnv` 之外的 URL 求值
     * （`buildFeedRequest` 里的 `{{Get('url')}}`）；`prepare` 是每个 action 的统一前置。
     */
    await primeSourceVariable(ctx, rule);
    // `#317`：这里**不再**做整源门控（旧 `assertSupported` 会把带 webView 字段的源整源拒掉，
    // 含带 `startHtml` 的完整列表源）。能力边界改为注记（见 `compile` 的 `issues`）。
    try {
      const info = await ctx.storage.get(LOGIN_INFO_PREFIX + ctx.sourceId);
      if (info) ctx.variables.set('__loginInfo', info);
    } catch {
      /* 存储失败 → 仍可用宿主注入的 ctx.loginInfo（readLoginInfo 会合并两份） */
    }
    try {
      ctx.variables.set('__loginHeader', (await ctx.storage.get(LOGIN_HEADER_PREFIX + ctx.sourceId)) ?? '');
    } catch {
      ctx.variables.set('__loginHeader', '');
    }
  }

  /**
   * 登录头注入后续所有请求（对齐 Legado `AnalyzeUrl.kt:139-141`）：
   * `getHeaderMap(hasLoginHeader && isLoginHeaderSite(url))` —— **只给源同站请求**，
   * 跨域（封面/图床/CDN）不带认证头：否则被对方风控拦，且登录态外泄。
   * 无法判定域名（相对地址/畸形）时保持原行为（仍附加）。
   */
  private loginHeaders(ctx: EngineContext, url?: string, sourceUrl?: string): Record<string, string> {
    if (!url || !isLoginHeaderSite(url, sourceUrl)) return {};
    const raw = String(ctx.variables.get('__loginHeader') ?? '');
    if (!raw) return {};
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v ?? '')]));
    } catch {
      return {};
    }
  }

  /**
   * 文本抓取。`req` 可为纯 URL（GET，历史路径）或 `FeedRequest`（`#328`：
   * options 三元组生效）。头合并顺序：默认 UA < 源 header < 登录头 < URL options 头
   * （上游 AnalyzeUrl：urlOption.headers 盖在 getHeaderMap 之上，越具体越优先）。
   */
  private async fetchText(
    ctx: EngineContext,
    rule: RssSourceRule,
    req: string | FeedRequest,
    /**
     * `#334` 正文页专用的「状态码闸门」：拿到 >=400 直接抛 NETWORK，**不再把错误页当正文**。
     *
     * 为什么只在这里拦、列表/登录不拦：
     *  · 上游（OkHttpUtils.kt:38）对 4xx/5xx 只做重试、**不抛**，最终仍把 body 交给规则；
     *    规则通常取空 ⇒ 用户看到**空白**正文（可接受）。
     *  · 但本仓源的 `@js:` 兜底普遍写成 `if (!m) return raw;`（实测听友FM ruleContent 正是这样）
     *    ⇒ **整页 404 JSON 被当成正文直出** —— 比上游更糟，且用户完全看不出是 404。
     *  · 列表/发现/登录那条链路上，非 2xx body 常被规则继续解析（反爬挑战页等），
     *    拦了会把大量现有结果从「0 条」变成「NETWORK」⇒ 只拦**正文页**这一条路径。
     */
    opts?: {
      requireOk?: boolean;
      /**
       * `#699` 由 `fetchText` 自己打 `≡获取成功:<res.url>`（**落地地址**）。
       *
       * 为什么需要这个开关：列表面的 `≡获取成功` 打的是**规则 URL**（上游 `Rss.kt:83`
       * 的 `analyzeUrl.ruleUrl`，可能还是相对路径），而内容页打的是**跟随重定向后的**
       * `res.url`（`Rss.kt:211`）—— 两处口径不同，源码就是这么写的。
       * 只有 `fetchText` 手上才有 `res`，所以这一行必须在这里打。
       */
      logFetchedUrl?: boolean;
    },
  ): Promise<string> {
    const r = typeof req === 'string' ? { url: req } as FeedRequest : req;
    const buildHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (compatible; EngineHub/0.1)',
        ...sourceHeadersFromCtx(ctx, rule),
        ...this.loginHeaders(ctx, r.url, rule.sourceUrl),
        ...(r.headers ?? {}),
      };
      /**
       * `#415` **POST 体的默认 Content-Type**（Legado `AnalyzeUrl.kt:286-289`，与 `engine-legado`
       * `engine.ts` 里那条**同一条语义**，此前 RSS 引擎漏了 ⇒ 部分站点静默返回空）。
       *
       * 实测（LOFTER 真源 `https://api.lofter.com/recommend/domainPosts.json`）：
       *   · 带 `Content-Type: application/x-www-form-urlencoded` ⇒ 200 + `data.list` 9~10 条；
       *   · **不带**（本引擎旧行为）⇒ 200 但 `data.list: []` ⇒ 列表规则解析 0 条 ⇒ `SELECTOR_MISS@parse`。
       * 同一源的正文 `post/detail.api`（POST）也吃这个默认头 ⇒ 卡片点开正文空白。
       *
       * 条件与 Legado 完全一致：**POST** + 体非空 + 源**未显式**声明 Content-Type；
       * 体以 `{`/`[` 起头 ⇒ JSON，否则按表单。大小写不敏感判定（源里写 `content-type` 也算已声明）。
       */
      if (
        r.method === 'POST' && r.body != null && r.body !== '' &&
        !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
      ) {
        headers['content-type'] = /^\s*[\{\[]/.test(String(r.body)) ? 'application/json' : 'application/x-www-form-urlencoded';
      }
      // `#344`：源级 Cookie（登录态 / 反爬挑战会话）自动注入 —— 与 `engine-legado` 同一语义。
      // 此前 RSS 引擎**从不**把 `ctx.cookies` 送上请求，所以「首访下发 cookie、带 cookie 重放」
      // 的整类站点永远拿不到真页面（次元小镇实测 403 挑战页恒返回 ⇒ SELECTOR_MISS@parse）。
      if (ctx.cookies) {
        const ck = ctx.cookies.header();
        if (ck && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) headers['Cookie'] = ck;
      }
      return headers;
    };
    /**
     * `#408` **响应体 hex 通道**（URL 选项 `type`）—— 对齐上游 `AnalyzeUrl.kt:461-463`：
     *   `if (type != null) return StrResponse(url, HexUtil.encodeHexStr(getByteArrayAwait()))`
     * 该分支先于 WebView / charset 解码返回。`data:;base64,<路径>,{"type":"18av"}` 这类
     * 分类/链接 URL 靠它把 base64 解出的**字节**交给源规则（规则再 `java.hexDecodeToString` 还原）。
     * 必须取 `arraybuffer`：否则 HTTP 层按文本解码（`getByteArray` 语义丢失）。
     */
    const bodyAsHex = typeof r.type === 'string' && r.type.trim() !== '';
    /**
     * 返回类型用 `HttpResponse`（而不是就地写个结构体）：`#699` 起网络层会带
     * `redirects`（每跳 3xx），就地写死结构体等于把这个字段在类型上抹掉 ——
     * 下面 `logRedirects(ctx, res)` 会报「没有共同属性」。
     */
    const doRequest = (): Promise<HttpResponse> =>
      ctx.http.request(r.url, {
        ...(r.method ? { method: r.method } : {}),
        ...(r.body != null ? { body: r.body } : {}),
        ...(r.charset ? { charset: r.charset } : {}),
        ...(bodyAsHex ? { responseType: 'arraybuffer' as const } : {}),
        headers: buildHeaders(),
      });
    // `#463①`：发请求前等源级头的 worker 池预求值落地（脚本型 header 不再占主线程；
    // 纯 JSON/无 header 这里是已 resolve 的微任务链，零实质开销）。
    await whenSourceHeadersPrimed(ctx);
    const beforeCookie = ctx.cookies?.header() ?? '';
    let res = await doRequest();
    // `#344`：响应 Set-Cookie 回收进源 CookieStore —— 反爬挑战页「首访下发 cookie、带 cookie 重放」
    // 的整类站点（次元小镇等）靠这里过闸；只发不收 ⇒ 列表恒拿挑战页 ⇒ SELECTOR_MISS@parse。
    harvestCookies(ctx, res);
    // 「挑战页」判据：响应非 2xx 且本次**新收**到了 cookie ⇒ 用新会话重放一次（只一次，防死循环）。
    // 实测次元小镇：首访 403 len=133 + Set-Cookie；带该 cookie 重放 → 200 len=89480（含目标选择器）。
    const afterCookie = ctx.cookies?.header() ?? '';
    if (Number(res.status) >= 400 && afterCookie && afterCookie !== beforeCookie) {
      res = await doRequest();
      harvestCookies(ctx, res);
    }
    // `#699` 重定向回执（上游 `Rss.kt:83` 前紧邻 `checkRedirect`）
    logRedirects(ctx, res);
    if (opts?.logFetchedUrl) {
      dlog(ctx, `≡获取成功:${clipText(String(res.url || r.url), 240)}`);
    }
    if (opts?.requireOk && Number(res.status) >= 400) {
      throw err('NETWORK', 'request', rule.sourceUrl,
        `正文页 HTTP ${Number(res.status)}（${r.url}）—— 站点返回错误页，不再当作正文下发`,
        undefined, ctx.trace.tail(20));
    }
    // `#408` `type` 分支的正文 = **原始字节的 hex 串**（上游 `HexUtil.encodeHexStr(bytes)`）。
    // 不走文本闸门：这本来就该是二进制（data: URL 解出的路径/密文），
    // 用 `Buffer.from(...).toString('hex')` 给出小写 hex，源规则 `java.hexDecodeToString` 还原。
    if (bodyAsHex) {
      const bytes = typeof res.body === 'string' ? Buffer.from(res.body, 'utf-8') : Buffer.from(res.body as ArrayBuffer);
      return bytes.toString('hex');
    }
    if (typeof res.body !== 'string') {
      throw err('DECODE', 'request', rule.sourceUrl, '响应非文本（RSS 应为 XML 文本）');
    }
    return res.body;
  }

  private articleToItem(a: RssArticle): UnifiedItem {
    return {
      id: String(a.order),
      kind: 'article',
      title: a.title || '(无标题)',
      cover: a.image ?? undefined,
      // `#434`/`#435` 卡片字段（描述 + 副标题）必须**剥标签/去注释/去样式表内容**（`formatIntro` 唯一实现）。
      // · 源 `ruleDescription` / XML `<description>` 常返回 HTML 片段 ⇒ 原样显示会把 `<p>`、
      //   `<!-- 源注释 -->` 漏进卡片；
      // · `rulePubDate` 也可能内嵌**整页 HTML**（实测「影视聚合(资源站)」的 pubDate 规则尾部直接
      //   `{{$.vod_content}}` ⇒ 副标题里带着整篇简介 + `<style>` 全文 ⇒ 用户实测「非简介信息暴露」）。
      // ⚠️ 只净化**卡片字段**；`payload.description` / `payload.pubDate` 仍保留原文（正文 = 原 HTML）。
      summary: cleanCardText(a.description),
      subtitle: cleanCardText(a.pubDate),
      layout: a.image ? 'wide-card' : 'text-row',
      // ⚠️ payload 必须**全量**带文章字段（#322）：content() 的第一通路读 `p.description`
      //（上游 resolveRssReadLoadTarget：description 非空 ⇒ 直接当完整 HTML 用，不抓 link）。
      // 此前只挑 4 字段是 #211 时代的裁剪 —— 那时 description 只是简介文本；#308 把语义改成
      // 「description = 完整正文 HTML」后这里没跟上 ⇒ 影视聚合(资源站) 的 8KB 播放器页丢失
      // ⇒ content 落 webRenderer 渲染 ruleLink（CMS API 端点）⇒ 用户看到原始 JSON 直出。
      payload: {
        link: a.link,
        title: a.title,
        pubDate: a.pubDate,
        image: a.image,
        description: a.description,
        content: a.content,
      } satisfies Pick<RssArticle, 'link' | 'title' | 'pubDate' | 'image' | 'description' | 'content'>,
    };
  }

  /**
   * 解析源的**分类列表**（对齐上游 `RssSource.sortUrls()`，见 sorts.ts 头注）。
   *
   *  - `sortUrl` 是 `@js:`/`<js>` 型 ⇒ 执行脚本得分类串（进程内缓存）；
   *  - 否则直接用 `sortUrl` 原文；
   *  - 一律走 `parseRssSortUrls` 切分，解析不出任何条目 ⇒ 回落「无名分类 = sourceUrl」。
   *
   * ⚠️ bindings **不传 java**（与 `buildFeedUrl` 同一教训：传了会遮蔽求值器的 java Proxy，
   * 分类脚本里的 `java.ajax` 立刻变 `is not a function`）。
   */
  private async resolveSorts(
    rule: RssSourceRule,
    ctx: EngineContext,
  ): Promise<Array<{ name: string; url: string }>> {
    const script = rssSortScript(rule.sortUrl);
    if (!script) {
      return parseRssSortUrls(rule.sortUrl, rule.sourceUrl).map(([name, url]) => ({ name, url }));
    }
    const key = `${rule.sourceUrl}\u0000${rule.sortUrl}\u0000${loginFingerprint(ctx)}`;
    const hit = sortsCache.get(key);
    if (hit) return hit;
    const env = makeRssEnv(ctx, rule, rule.sourceUrl);
    let value: string | null = null;
    try {
      const r = await env.jsEval(script, {
        source: env.sourceData ?? {},
        baseUrl: rule.sourceUrl,
        page: 1,
        key: '',
        result: '',
      });
      value = r == null ? null : String(r);
    } catch (e) {
      warnOnce(`sorts:${rule.sourceUrl}`,
        `源 ${rule.sourceName || rule.sourceUrl} 的分类脚本执行失败（分类退化为「整源」）：${e instanceof Error ? e.message : String(e)}`);
      value = null;
    }
    const sorts = parseRssSortUrls(value, rule.sourceUrl).map(([name, url]) => ({ name, url }));
    if (value && value.trim()) sortsCache.set(key, sorts);
    return sorts;
  }

  /**
   * 列表拉取 + 解析（default / 规则两路）。
   *
   * 翻页（`#306` 跨页通道）：
   *  - 请求带 `nextUrl`（上一页结果给的）⇒ **直接用它**，不走模板（规则型下一页与页码无关）；
   *  - URL 含 `{{page}}` 模板 ⇒ page+1 重放；
   *  - 二者都没有 ⇒ 只能给第一页（`hasMore=false` + 留痕，不装能翻而翻不动）。
   * 结果里给出 `page.nextUrl`：规则解析出的下一页 URL（纯页码型则不给，前端继续 page+1）。
   */
  private async listArticles(
    ctx: EngineContext,
    rule: RssSourceRule,
    tpl: string,
    sortName: string,
    opts: { page: number; key?: string; stripSortPrefix?: boolean; feedUrlOverride?: string; nextUrl?: string },
  ): Promise<{ articles: RssArticle[]; hasMore: boolean; nextUrl: string | null; feedUrl: string }> {
    const env = makeRssEnv(ctx, rule, rule.sourceUrl);
    let feed: FeedRequest;
    try {
      // `#306`：跨页通道优先（下一页 URL 由上一页解析得出，纯 URL 无 options 尾巴）；
      // 模板路径走 `#328` 的 buildFeedRequest（`,{options}` 的 method/body/headers 生效）
      const override = opts.feedUrlOverride ?? opts.nextUrl;
      feed = override
        ? { url: override }
        : await buildFeedRequest(tpl, rule, env, { page: opts.page, key: opts.key, stripSortPrefix: opts.stripSortPrefix ?? true });
    } catch (e) {
      throw err('RULE_PARSE', 'request', rule.sourceUrl, e instanceof Error ? e.message : String(e), tpl);
    }
    // link 相对补全基准 = 当前 feed URL（对齐 AnalyzeRule.setBaseUrl(sortUrl)）
    env.baseUrl = feed.url;
    const body = await this.fetchText(ctx, rule, feed);
    /**
     * `#698` `≡获取成功:<url>`（上游 `Rss.kt:83` 打的是 **`analyzeUrl.ruleUrl`**，
     * 即**请求时的规则 URL**，可能是相对路径 `/Articles`；不是跟随重定向后的绝对地址）。
     * 这里按同一口径：模板是相对路径 ⇒ 只打印 path+search，与用户贴的上游日志逐字对得上。
     */
    dlog(ctx, `≡获取成功:${ruleUrlForLog(tpl, feed.url, rule.sourceUrl)}`);
    let parsed: { articles: RssArticle[]; nextUrl: string | null };
    /** `#421`：渲染层回落的结论（并进 SELECTOR_MISS 的 message —— 兜底必须留痕，不许静默） */
    let renderNote = '';
    if (rule.ruleArticles) {
      parsed = await parseRssByRule(body, feed.url, rule, env, sortName, (m) => dlog(ctx, m));
      /**
       * ★★ `#421` **JS 单页应用（SPA）回落渲染层**。
       *
       * 用户报（2026-10-12，七猫高清）：`ruleArticles=".v-item"` 恒 **0 条**。
       * 真因**不是规则过期**，而是站点改成了 SPA：`/list.html?cid=…` 的静态 HTML 只有
       * 2363 字节的空壳（`<div id="list-root"></div>` + 几个 `<script>`），卡片由页面 JS
       * 从**加密 JSON API**（`/app/movie/getList`）渲染出来 ⇒ 静态 HTML 里**根本没有** `.v-item`。
       * 同类站点（mogo 系模板）越来越多，源侧 HTML 规则必然失效。
       *
       * 处置（对齐 Legado 的 WebView 通路，只是放在**列表失败后**而不是默认走）：
       * 静态规则解析 0 条 **且**环境有渲染层（桌面端 `ctx.webRenderer`）**且** feed 是 http(s)
       * ⇒ 渲染一次真实页面（跑它的 JS / 等 XHR）再解析同一份规则。
       *
       * ★ 只在「已经失败」时触发（当前行为是直接抛 `SELECTOR_MISS`）⇒ **零回归**：
       *   能出结果的源一行都不会多跑。渲染是**可选增强**，失败只留痕、不改变错误语义。
       *
       * ★★ `#432` **接口型 feed（响应体是 JSON）不做渲染层回落**。
       *
       * 依据（LOFTER 实测 2026-10-13）：这类"feed"其实是**站点 JSON 接口**
       * （`/recommend/…json`、`/newsearch/…json`、`/newapi/tagPosts.json`…），
       * 「列表 0 条」的真因在**站点侧**（缺必需请求头 / 未登录 / 站点已下线该榜），
       * 与「页面是不是 SPA」无关。此时去 `webRenderer` 渲染一个 **JSON 端点**：
       *   · 无头浏览器只会把 JSON 当纯文本渲染（或直接失败），渲染页 ~196 字；
       *   · 用户看到的是「渲染层回落已尝试（渲染后仍是 0 条，渲染页 196 字 —— 站点可能对
       *     无头浏览器另有拦截）」—— **归因指向完全错误的方向**（它根本不是网页）；
       *   · 且白等一次真实浏览器渲染（桌面端要起 Chromium）。
       * ⇒ 判据＝响应体首个非空白字符是 `{` / `[`（与 `core` 的 `isJsonText` 同一口径，
       *   但这里只看**开头**：接口可能返回被截断/带 BOM 的 JSON）。命中则跳过回落并
       *   在 `SELECTOR_MISS` 的 message 里写明「接口型 feed」。
       */
      const bodyLooksJson = /^[\s\uFEFF]*[[{]/.test(body);
      if (!parsed.articles.length && bodyLooksJson) {
        renderNote = '响应体是 JSON（接口型 feed）⇒ 跳过渲染层回落（渲染 JSON 端点无意义）';
      } else if (!parsed.articles.length && ctx.webRenderer && /^https?:\/\//i.test(feed.url)) {
        renderNote = '渲染层回落已尝试';
        try {
          // `#463①`：脚本型 header 的 prime 在 worker 池异步跑；正常通路 fetchText 已 await 过，
          // 这里再 await 一次兜住「首请求失败/短路」边界（成本 = 已落 memo 时一次微任务）
          await whenSourceHeadersPrimed(ctx);
          const rendered = await ctx.webRenderer(feed.url, {
            ...(rule.raw.injectJs ? { js: rule.raw.injectJs } : {}),
            headers: sourceHeadersFromCtx(ctx, rule),
          });
          if (rendered && rendered !== body) {
            const parsedRendered = await parseRssByRule(rendered, feed.url, rule, env, sortName);
            if (parsedRendered.articles.length) {
              warnOnce(`spa-render:${rule.sourceUrl}`,
                `源 ${rule.sourceName || rule.sourceUrl} 的列表静态解析 0 条，改用渲染层后出 ${parsedRendered.articles.length} 条（站点为 JS 单页应用）`);
              parsed = parsedRendered;
            } else {
              renderNote = `渲染层回落已尝试（渲染后仍是 0 条，渲染页 ${rendered.length} 字 —— 站点可能对无头浏览器另有拦截）`;
            }
          } else {
            renderNote = '渲染层回落已尝试（渲染结果与静态页相同）';
          }
        } catch (e) {
          renderNote = `渲染层回落失败：${e instanceof Error ? e.message : String(e)}`;
          warnOnce(`spa-render-fail:${rule.sourceUrl}`,
            `源 ${rule.sourceName || rule.sourceUrl} 的列表 0 条且渲染层回落失败：${renderNote}`);
        }
      }
      if (!parsed.articles.length) {
        throw err('SELECTOR_MISS', 'parse', rule.sourceUrl,
          `列表规则解析为 0 条（ruleArticles=${JSON.stringify(rule.ruleArticles)}${renderNote ? `｜${renderNote}` : ''}）`, rule.ruleArticles);
      }
    } else {
      // 上游 `RssParserByRule.kt:40`：`ruleArticles` 空白 ⇒ 明说回落默认解析器
      dlog(ctx, '⇒列表规则为空, 使用默认规则解析');
      parsed = parseRssDefaultXml(body, rule.sourceUrl, sortName, rule.type);
      if (!parsed.articles.length) {
        throw err('SELECTOR_MISS', 'parse', rule.sourceUrl,
          'RSS 列表解析为 0 条（非标准 RSS 2.0 item 结构，或站点返回异常页）', feed.url);
      }
    }
    const hasPageTpl = /\{\{[^}]*\bpage\b/.test(tpl);
    // `#306`：规则解析出的下一页 URL ⇒ 走跨页通道（前端回传 nextUrl），与页码无关
    const nextUrl = hasPageTpl ? null : parsed.nextUrl;
    let hasMore = false;
    if (hasPageTpl) {
      hasMore = parsed.articles.length > 0;
    } else if (nextUrl) {
      hasMore = true;
    } else if (rule.ruleNextPage) {
      warnOnce(`nexturl:${rule.sourceUrl}`, `源 ${rule.sourceName}(${rule.sourceUrl}) 配了 ruleNextPage 但本页没解析出下一页链接（可能已是最后一页）`);
    }
    return { articles: parsed.articles, hasMore, nextUrl, feedUrl: feed.url };
  }

  // ------------------------------------------------------------------
  // actions
  // ------------------------------------------------------------------

  /**
   * 「发现页」= 源的**分类条**。
   *
   * ⚠️ 旧版这里硬编码 `[{ name: '最新', value: 'feed' }]` —— 那是**凭空注入的分类**：
   * 上游 RSS 的分类**只来自源规则**（`sortUrl` 的多条 `名称::url`，或 `@js:` 动态生成，
   * 见 `RssSourceExtensions.sortUrls()`）。对语料 24/31 个配了 `sortUrl` 的源，
   * 那个假「最新」既掩盖了真分类，又让 category 拿到整段多行 sortUrl 当 URL 用 ⇒
   * 请求打到一个含换行的非法地址 ⇒ 列表恒 0 条。
   *
   * 分类**不注入任何默认项**：源没配 `sortUrl` 时 `parseRssSortUrls` 回落到
   * 「一个无名分类 = 源地址」（上游同），前端按「单分类无名 ⇒ 不渲染分类条」处理。
   */
  async home(rule: RssSourceRule, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    await this.prepare(rule, ctx);
    // `#317` 单 URL 源：上游 `RssFragment.openRss` **不进分类列表**，直接把 URL 当一篇文章打开。
    // 本仓映射为「一个无名分类（= 那个 URL）」，前端沿用「单分类无名 ⇒ 不渲染分类条」的既有约定。
    if (rule.singleUrlOnly) {
      const url = await this.resolveSingleUrl(rule, ctx);
      return {
        items: [],
        page: { page: 1, pageCount: 1, total: 0, hasMore: false },
        filters: [{ name: '分类', key: 'explore', options: [{ name: '', value: url }] }],
      };
    }
    const sorts = await this.resolveSorts(rule, ctx);
    return {
      items: [],
      page: { page: 1, pageCount: 1, total: 0, hasMore: false },
      filters: [{ name: '分类', key: 'explore', options: sorts.map((s) => ({ name: s.name, value: s.url })) }],
    };
  }

  /**
   * `#404` **RSS 启动页**（`startHtml`）—— webView 型订阅源的入口页。
   *
   * 上游：`RssViewModel.launchRssWithHtml:82-106`（`@js:`/`<js>` 用 Rhino 求值，否则取字面量）
   * ⇒ 结果非空则 `RssFragment.openRss:198-211` **直接进 `ReadRssActivity` 的 WebView**
   * （**替换**分类列表页，非叠加）；`startStyle` 追加进 `<head>`、`startJs` 作为页面脚本
   * （`RssViewModel.loadStartHtml:292-318`）。
   *
   * 返回 `html` 为空串 = 「没有启动页」——源没配，或脚本按登录态返回空
   * （如 18AV：`source.getLoginInfoMap()['启动页'] != '✅'` 即返回空）⇒ 前端走常规分类列表。
   */
  async start(rule: RssSourceRule, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedStartResult> {
    await this.prepare(rule, ctx);
    const env = makeRssEnv(ctx, rule, rule.sourceUrl);
    const html = await this.evalStartField(rule.raw.startHtml, env, rule);
    if (!html.trim()) return { html: '' };
    const style = await this.evalStartField(rule.raw.startStyle, env, rule);
    const js = await this.evalStartField(rule.raw.startJs, env, rule);
    /**
     * `#418` 源变量随启动页一起下发 —— 启动页在浏览器沙箱 iframe 里，读不到引擎的
     * `ctx.variables`，而 `startJs` 首件事就是 `source.getVariable()`（LOFTER 用它决定
     * 是否显示「首次使用」并还原标签/合集/作者）。取不到 ⇒ 垫片按**空串**（不是 `'{}'`）预置。
     */
    const variable = String(ctx.variables.get('sourceVariable') ?? '');
    return { html, ...(style.trim() ? { style } : {}), ...(js.trim() ? { js } : {}), variable };
  }

  /**
   * 启动页字段求值：`@js:`/`<js>` ⇒ 求值；否则**字面量**（对齐上游 `launchRssWithHtml`）。
   * 脚本失败**不抛**（启动页是可选增强）—— `warnOnce` 留痕后按空处理（铁律 3：兜底必须留痕）。
   */
  private async evalStartField(
    rawField: string | null | undefined,
    env: ReturnType<typeof makeRssEnv>,
    rule: RssSourceRule,
  ): Promise<string> {
    const s = String(rawField ?? '');
    if (!s.trim()) return '';
    const script = rssSortScript(s);
    if (!script) return s; // 字面量 HTML / CSS / JS
    try {
      const r = await env.jsEval(script, {
        source: env.sourceData ?? {},
        baseUrl: rule.sourceUrl,
        result: '',
        page: 1,
        key: '',
      });
      return r == null ? '' : String(r);
    } catch (e) {
      warnOnce(`start:${rule.sourceUrl}`,
        `源 ${rule.sourceName || rule.sourceUrl} 启动页脚本执行失败，按无启动页处理：${e instanceof Error ? e.message : String(e)}`);
      return '';
    }
  }

  async category(rule: RssSourceRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    await this.prepare(rule, ctx);
    const page = req.page ?? 1;
    // `#317` 单 URL 源：列表恒 **1 篇**（标题 = 源名，link = URL），正文交给 `content` 的
    // `renderArticle` 通路（上游 `loadUrl`）。`p.link` 有值 ⇒ 既有分支天然可用。
    if (rule.singleUrlOnly) {
      const url = (req.filters?.['explore'] as string | undefined) || (await this.resolveSingleUrl(rule, ctx));
      const title = rule.sourceName || rule.sourceUrl;
      return {
        items: [{
          id: '0',
          kind: 'article',
          title,
          layout: 'text-row',
          payload: { link: url, title } satisfies Pick<RssArticle, 'link' | 'title'>,
        }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    }
    // 选中的分类（`filters.explore` = home 给出的那条 url 模板）；没选 ⇒ 第一条（对齐上游首分类默认）
    const sorts = await this.resolveSorts(rule, ctx);
    const chosen = req.filters?.['explore'] || sorts[0]?.url || rule.sourceUrl;
    const sortName = sorts.find((s) => s.url === chosen)?.name || rule.sourceName || '订阅';
    const { articles, hasMore, nextUrl } = await this.listArticles(ctx, rule, chosen, sortName, {
      page,
      nextUrl: req.nextUrl,
      // `chosen` 已是切分后的**单条 url**（不含「名称::」前缀）⇒ 不能再剥一次
      stripSortPrefix: false,
    });
    return {
      items: articles.map((a) => this.articleToItem(a)),
      page: { page, pageCount: 0, total: 0, hasMore, ...(nextUrl ? { nextUrl } : {}) },
    };
  }

  async search(rule: RssSourceRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    await this.prepare(rule, ctx);
    if (!rule.searchUrl) {
      throw err('UNSUPPORTED_ACTION', 'parse', rule.sourceUrl, '该订阅源未配置 searchUrl，不支持搜索');
    }
    const page = req.page ?? 1;
    const { articles, hasMore, nextUrl } = await this.listArticles(ctx, rule, rule.searchUrl, `搜索:${req.keyword ?? ''}`, {
      page,
      key: req.keyword ?? '',
      stripSortPrefix: false, // searchUrl 无 sortUrl 的「名称::url」语法（RssViewModel.getSingleUrl 只处理 sortUrl）
      ...(req.nextUrl ? { nextUrl: req.nextUrl } : {}),
    });
    return {
      items: articles.map((a) => this.articleToItem(a)),
      page: { page, pageCount: 0, total: 0, hasMore, ...(nextUrl ? { nextUrl } : {}) },
    };
  }

  /**
   * 详情（`detail`）—— **两种入参形态**（`#304`）
   *
   * ① **单篇文章**（前端 `fetchDetail` 传 `id: JSON.stringify(payload)`，payload 含 `link`）：
   *    上游 RSS 点文章是**直接进正文**（`ReadRssActivity`），没有「目录」这一层；本仓阅读器
   *    走「详情 → 目录 → 正文」，所以这里返回**单章目录**（chapters = [这一篇]）。
   *    ⚠️ 此前一律把 `req.id` 当 feed URL ⇒ 拿到的是 JSON 串 ⇒ 请求打 JSON ⇒ **点文章必失败**。
   * ② **feed URL / 空**：订阅源的文章列表（加书架后按「整源」阅读）。
   */
  async detail(rule: RssSourceRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedDetail> {
    await this.prepare(rule, ctx);
    const p = (typeof req.id === 'string' ? safeJsonParse(req.id) : req.id) as Partial<ChapterPayload> | null;

    // ① 单篇文章（payload 带 link）
    if (p && typeof p === 'object' && typeof p.link === 'string' && p.link) {
      const a: ChapterPayload = {
        origin: rule.sourceUrl,
        sort: '订阅',
        title: p.title ?? '',
        order: typeof p.order === 'number' ? p.order : 0,
        link: p.link,
        pubDate: p.pubDate ?? null,
        description: p.description ?? null,
        content: p.content ?? null,
        image: p.image ?? null,
        type: p.type ?? rule.type,
        feedUrl: p.feedUrl,
      };
      return {
        id: a.link,
        kind: 'article',
        title: a.title || '(无标题)',
        cover: a.image || rule.sourceIcon || undefined,
        // `#435`：与列表卡片同一口径净化（pubDate 规则可能内嵌整页 HTML）
        summary: cleanCardText(a.pubDate),
        meta: { 来源: rule.sourceName || rule.sourceUrl, 分组: rule.sourceGroup ?? '' },
        chapters: [
          {
            title: a.title || '(无标题)',
            payload: a satisfies ChapterPayload,
            order: 0,
            tag: a.pubDate ?? undefined,
          },
        ],
      };
    }

    // ② feed URL（或空 → 按第一条分类的 url 模板求值）
    const page = req.page ?? 1;
    // 整源阅读（加书架后进详情）默认用**第一条分类**的 url —— 上游订阅入口也是从第一个分类进
    const sorts = await this.resolveSorts(rule, ctx);
    const tpl = sorts[0]?.url || rule.sourceUrl;
    let feedUrl = typeof req.id === 'string' && req.id.startsWith('http') ? req.id : '';
    if (!feedUrl) {
      try {
        const envForId = makeRssEnv(ctx, rule, rule.sourceUrl);
        feedUrl = await buildFeedUrl(tpl, rule, envForId, { page, stripSortPrefix: true });
      } catch (e) {
        throw err('RULE_PARSE', 'request', rule.sourceUrl, e instanceof Error ? e.message : String(e), tpl);
      }
    }
    const { articles } = await this.listArticles(ctx, rule, tpl, '订阅', { page, feedUrlOverride: feedUrl });
    const chapters: UnifiedChapter[] = articles.map((a) => ({
      title: a.title || `(无标题 #${a.order})`,
      payload: { ...a, feedUrl } satisfies ChapterPayload,
      order: a.order,
      tag: a.pubDate ?? undefined,
    }));
    return {
      id: feedUrl,
      kind: 'article',
      title: rule.sourceName || rule.sourceUrl,
      cover: rule.sourceIcon || undefined,
      summary: rule.sourceComment ?? undefined,
      meta: { 分组: rule.sourceGroup ?? '' },
      chapters,
    };
  }

  async content(rule: RssSourceRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedContent> {
    const p = (typeof req.id === 'string' ? safeJsonParse(req.id) : req.id) as Partial<ChapterPayload> | null;
    if (!p || typeof p !== 'object') {
      throw err('RULE_PARSE', 'parse', rule.sourceUrl, '章节 payload 缺失或不是 JSON');
    }
    const body = p.content || p.description || '';
    // 图片型：正文 = 图片 URL 序列（对齐上游 type=1 走图片阅读器）
    if (p.type === 1 && body) {
      const imgs = extractImageUrls(body);
      if (p.image && !imgs.includes(p.image)) imgs.unshift(p.image);
      return { title: p.title, paragraphs: imgs, imageStyle: 'FULL' };
    }
    /**
     * `#346`（`#349` 重构）视频/音频型（上游 RSS `type === 2`）：正文是**播放地址**，不是可渲染 HTML。
     *
     * 缺陷类别（用户 2026-10-08 实测「麻豆传媒正文视频未正常加载」，黑屏播放器 0:00）：
     * 本引擎此前**没有任何媒体通路** —— `ruleContent` 产出的
     * `<video src="…index.m3u8">` 被原样塞进沙箱 iframe，而 Chromium **无原生 HLS**
     * ⇒ 播放器黑屏。上游 Legado 靠 `BookType` 分派阅读器，播放地址交给 `VideoPlayer`。
     *
     * ⚠️ 判据**不能只看 `type === 2`**：麻豆这条源 `type` 写的是 0（网页型），内容却是
     * `<video src="…m3u8">` —— 源作者没标对。按铁律「按内容形态兜底」（与 legado 引擎
     * `extractFromRaw` 的 media 兜底同一思路），对**非图片型**正文都试一次媒体提取，
     * 只在**确实提取到像样的媒体候选**时才转成 `media`，否则保持原 HTML 通路（零回归）。
     *
     * ★ `#349` 修**重复抓取**：`#346` 的实现是「先抓一次探媒体（本行），探不到再抓一次出正文」——
     * 实测一次 `content` 打 **2 个** 首页请求（`/api/diag` 的 `net.requests` 差值；旧实现在源
     * `ruleContent` 非空且 `body` 为空时 100% 双抓）。现在把「抓」提到**唯一一次**，媒体探测
     * 与正文产出共用这一份 `raw`（上游 `getContentAwait` 也只抓一次）。
     */
    const src = body || (p.link && rule.ruleContent ? await this.fetchArticleContent(ctx, rule, p) : '');
    if ((p.type ?? rule.type) !== 1 && src) {
      const base = this.htmlBase(rule, p).htmlBaseUrl ?? rule.sourceUrl;
      const m = mediaFromRaw(src, base);
      /**
       * `#352`（2026-10-08）**嗅探化：html 与 media 并存，不再丢弃 HTML**。
       *
       * 缺陷类别（用户实测两条）：旧实现 `if (m) return { media: m }` 把源规则的展示结果
       * （HTML）**整个丢掉**，前端再自动跳播放器 ⇒「改变了源规则的结果展示」。
       *
       * ## `#430`（2026-10-12 用户拍板）**取消嗅探门控：嗅探与源规则展示并行**
       *
       * 用户原话：「嗅探为补充功能，与页面源规则展示不冲突，以页面源规则展示为主，嗅探并行，
       * 可以通过嗅探起播放器播放，也可以忽略嗅探、在页面内播放」。
       * 因此**不再**用 `bodySelfPlaying`（有 `<iframe` / 调 Hls API）把页面挡在嗅探之外 ——
       * 该判据与函数已删除：**只要提得到像样的媒体候选，一律 `html + media` 并存下发**。
       *
       * 前端语义（早已按此调整）：正文 iframe 照常渲染源规则结果；`media` 只作「嗅探」信息 ——
       * 进页面先给一条提示，**10s 后收缩成悬浮按钮**（不点就完全不影响页内播放；点了才唤起
       * 播放浮窗，关闭返回正文）。故「页面自己能播」与「嗅探按钮」不再互斥。
       */
      if (m) {
        return {
          title: p.title,
          paragraphs: [],
          html: this.contentHtml(rule, src),
          media: m,
          ...this.htmlBase(rule, p),
        };
      }
      if ((p.type ?? rule.type) === 2 && !m) {
        // 源**明确**声明视频型却提不到候选 ⇒ 显式报，避免用户又看到黑屏播放器却不知为何
        throw err('SELECTOR_MISS', 'parse', rule.sourceUrl,
          `视频型订阅源（type=2）的正文里找不到可用媒体直链（ruleContent 结果 ${src.length} 字）`,
          rule.ruleContent ?? undefined, ctx.trace.tail(20));
      }
    }
    // 上游 resolveRssReadLoadTarget（ReadRssViewModel.kt:46-59）：description 非空 ⇒ **直接用**，
    // 不抓内容页 —— 本仓与之同序（内嵌正文优先）。
    //
    // ★ `#308`：这个「直接用」在上游是**当完整 HTML 交给 WebView**
    //   （`contentLiveData` → `clHtml()` → `loadDataWithBaseURL`，`ReadRssActivity.kt:401-413`），
    //   **不是**降级成纯文本段落。语料证据：影视聚合(资源站) 的 `ruleDescription` 是一整页
    //   hls.js 播放器；24凹凸吧/凹凸吧/24凹凸/24MM/凹凸/AI24 的 `ruleContent` 是
    //   `{{@@…}}` 模板 + `atob()` 拼 `<img>` 的 `<script>`。走 `htmlToParagraphs` 会把
    //   标签/样式/脚本全丢掉 ⇒ 用户看到乱码文本（用户原话：「没有正确处理，加载，显示」）。
    if (body) {
      const out: UnifiedContent = { title: p.title, paragraphs: [], html: this.contentHtml(rule, body), ...this.htmlBase(rule, p) };
      /**
       * 上游 `rssContentDebug`：`log(it)` —— 打的是 **`getContent` 的返回值**（规则结果原文），
       * 不是我们拼出来的最终文档（`contentHtml` 会注入源的 `style`，上游日志里没有那段）。
       */
      dlog(ctx, clipText(body, 2000));
      return out;
    }
    // 无内嵌正文 + ruleContent 为空 ⇒ 上游 webView 渲染 link（`resolveRssReadLoadTarget` 的 Url 分支）。
    // `#305`：本仓渲染层（`ctx.webRenderer`）存在时**真去渲染**；不存在（纯服务端无头环境）才显式报。
    if (!rule.ruleContent) {
      if (!ctx.webRenderer || !p.link) {
        throw err('UNSUPPORTED_ACTION', 'parse', rule.sourceUrl,
          ctx.webRenderer
            ? '文章缺少 link，无法渲染内容页'
            : '文章无内嵌正文且源为 webView 型阅读（ruleContent 为空），当前环境未启用渲染层，无法渲染内容页',
          undefined, ctx.trace.tail(20));
      }
      const html = await this.renderArticle(ctx, rule, p.link);
      if (p.type === 1) {
        const imgs = extractImageUrls(html);
        if (p.image && !imgs.includes(p.image)) imgs.unshift(p.image);
        return { title: p.title, paragraphs: imgs, imageStyle: 'FULL' };
      }
      return { title: p.title, paragraphs: [], html: this.contentHtml(rule, html), ...this.htmlBase(rule, p) };
    }
    if (!p.link) {
      throw err('RULE_PARSE', 'parse', rule.sourceUrl, '文章缺少 link，无法抓取内容页');
    }
    // ★ `#349`：`src` 已是上面**唯一一次**抓取的结果（`body` 为空时就是它抓的）——
    //   这里直接复用，不再二次 `fetchArticleContent`。
    if (p.type === 1) {
      const imgs = extractImageUrls(src);
      if (p.image && !imgs.includes(p.image)) imgs.unshift(p.image);
      return { title: p.title, paragraphs: imgs, imageStyle: 'FULL' };
    }
    const out: UnifiedContent = { title: p.title, paragraphs: [], html: this.contentHtml(rule, src), ...this.htmlBase(rule, p) };
    // 同上：打规则结果原文（`src`），不是注入样式后的最终文档
    dlog(ctx, clipText(src, 2000));
    return out;
  }

  /**
   * `#446` **正文 HTML 的拼装**：`style` 注入 ∩ `injectJs` 在 `</body>` 前执行。
   *
   * ## 为什么要执行 `injectJs`（用户实测：千白羽详情页「外观设置」按钮点了没反应）
   * 上游 `ReadRssActivity` 在 **`onPageFinished`** 里 `evaluateJavascript(injectJs)` ——
   * 即「DOM 已就绪、规则页脚本已跑完」时执行源作者的后处理脚本。语料实证：千白羽把
   * **详情页面板的构造函数**放在 `injectJs` 里（作者原注释：
   * 「BUGFIX 2026-09：详情页外观面板专用桥接函数。必须使用 `window.detailBuildPanel`，
   * 避免与启动页 `startJs` 的 `buildPanel()` 全局同名冲突」），而详情页脚本里的
   * `bgPanel()` 就是调 `window.detailBuildPanel()`。
   *
   * 旧实现只把 `injectJs` 交给**列表渲染层**（`renderArticle`），正文面**从不执行**它 ⇒
   * `bgPanel()` 一调就 `TypeError: window.detailBuildPanel is not a function` ⇒ 按钮全死
   * （用 jsdom 跑真实正文 HTML 复现：`#bp` 面板 className/innerHTML 点前点后完全不变）。
   *
   * ## 位置（判据唯一，别写两处）
   * 插在**最后一个 `</body>` 之前** = 页面自身脚本（含 `ruleContent` 里那句 `__p8page()`）
   * 之后 ⇒ 与上游 `onPageFinished` 的先后关系一致（`injectJs` 里那句「`__p8page` 缺失时
   * 给可见提示」正是靠这个顺序才成立）。无 `</body>` 的片段形态直接追加到末尾。
   */
  private contentHtml(rule: RssSourceRule, src: string): string {
    const html = injectSourceStyle(src, rule.raw.style);
    const parts: string[] = [];
    /**
     * `#449` **`shouldOverrideUrlLoading` 下发到页面**（用户口径：「为什么是 D13 的事？现在不能支持么？」）。
     *
     * 上游：WebView 每次导航前调这段 JS（`url` 在作用域里），**返回 true = 拦截**、由源自己
     * `java.open('rss',url)` 交源规则重新解析。它是**源作者自己写的 URL 模式判据**，比壳层的
     * 「同站」启发式精确得多（语料 240 源里 9 个声明了它，千白羽那个还特判 `mod=attachment`
     * 与 `webnote.cc/p/<id>`）。
     *
     * 形态必须**两种都容**：语料里既有「自执行 IIFE 表达式」（千白羽，返回值即判定），
     * 也有「纯语句列表」（靠副作用调 `java.open`）。⇒ 用 `eval(源码)` 求值：
     *  · 表达式形态 ⇒ 返回值直接当判定；
     *  · 语句形态 ⇒ 返回值是 undefined，但**副作用已发生** ⇒ 由壳层导航桥的 `java.open` 探针兜住
     *    （两者取「或」，见 `buildNavBridge` 的 `shouldOverride`）。
     * 这样既不吃掉任一形态，也不会把纯语句源码塞进 `return ` 里造成整段语法错误。
     *
     * ⚠️ 位置与 `injectJs` 同一处（`</body>` 前）：页面自身脚本之后、DOM 就绪。
     */
    const sou = (rule.raw.shouldOverrideUrlLoading ?? '').trim();
    if (sou) {
      const lit = JSON.stringify(sou).replace(/<\//g, '<\\/');
      parts.push(
        '<script>window.__yueduShouldOverride=function(url){try{return eval(' + lit + ');}catch(e){return false;}};<\/script>',
      );
    }
    const js = (rule.raw.injectJs ?? '').trim();
    if (js) parts.push('<script>' + js + '<\/script>');
    if (!parts.length) return html;
    const tag = parts.join('');
    const i = html.toLowerCase().lastIndexOf('</body>');
    return i < 0 ? html + tag : html.slice(0, i) + tag + html.slice(i);
  }

  /**
   * `#308` 正文 HTML 的相对地址基准。
   *
   * 对齐上游 `ReadRssActivity.initLiveData`（:407-411）：
   *  · `url = getAbsoluteURL(it.origin, it.link).substringBefore("@js")`
   *  · `baseUrl = if (loadWithBaseUrl == false) null else url`
   * ⇒ 源里显式关掉时才不设基准，否则用「文章绝对地址（去掉 `@js` 尾巴）」。
   *
   * ⚠️ 额外加一条**本仓必需**的守卫：基准必须是 `http(s)` 绝对地址才下发。
   * 原因：legado 订阅源里存在把 `sourceUrl` 写成 `<js></js>` 的源（如「影视聚合(资源站)」，
   * 真地址由 `sortUrl` 脚本算出来）—— 把这种字符串当 `<base>` 会让页面内**相对地址全部解析错**。
   * 这类源的 `ruleLink` 本来就是绝对地址，不设基准反而正确。
   */
  private htmlBase(rule: RssSourceRule, p: Partial<ChapterPayload>): { htmlBaseUrl?: string } {
    if (rule.raw.loadWithBaseUrl === false) return {};
    const link = p.link ?? '';
    const abs = link ? resolveUrl(rule.sourceUrl, link) : rule.sourceUrl;
    const url = abs.split('@js')[0] ?? abs;
    return /^https?:\/\//i.test(url) ? { htmlBaseUrl: url } : {};
  }

  /**
   * 抓内容页 + ruleContent 解析 + nextContentUrl 追页（对齐 Rss.kt:112-169,216-242）
   *
   *  - 请求：`AnalyzeUrl(link, baseUrl=origin)`（源级 header 注入）；
   *  - 解析：`AnalyzeRule(ruleData=rssArticle).setContent(body).setBaseUrl(getAbsoluteURL(origin, link))`；
   *  - 追页：`nextContentUrl` 且源/文章 type 均为 0 ⇒ getStringList(isUrl=true)
   *    —— 单条走链式追页（visited 去重 + 上限），多条并发；结果按 `join("\n")` 拼接。
   */
  private async fetchArticleContent(
    ctx: EngineContext,
    rule: RssSourceRule,
    p: Partial<ChapterPayload>,
  ): Promise<string> {
    const MAX_PAGES = 20;
    // `#334`：首页 4xx/5xx ⇒ 直接抛（错误页不当正文）；追页失败则跳过、不中断整篇
    const first = await this.fetchContentPage(ctx, rule, p, p.link!, true);
    const chunks = [first.chunk];
    if (first.nexts.length === 1) {
      // 链式追页（上游 while + visited 去重）
      const visited = new Set([p.link!]);
      let next = first.nexts[0]!;
      while (next && visited.add(next) && chunks.length < MAX_PAGES) {
        const page = await this.fetchContentPage(ctx, rule, p, next);
        chunks.push(page.chunk);
        next = page.nexts[0] ?? '';
        if (!next) break;
      }
    } else if (first.nexts.length > 1) {
      // 并发追页（上游 mapAsync(threadCount)）
      const rest = first.nexts.slice(0, MAX_PAGES - 1);
      const pages = await Promise.all(rest.map((u) => this.fetchContentPage(ctx, rule, p, u)));
      for (const pg of pages) chunks.push(pg.chunk);
    }
    return chunks.join('\n');
  }

  /**
   * webView 型阅读：渲染内容页（`#305`）
   *
   * 上游 `ReadRssActivity` 用 `VisibleWebView` 打开 link，并按
   * `style`（CSS）/`injectJs`（页面脚本）注入 —— 本仓渲染层只接受 `js`/`sourceRegex`/`delayMs`/`headers`，
   * 所以 `style` 在这里**塞进返回的 HTML**（上游是 webView 里加样式表，效果等价）。
   */
  private async renderArticle(ctx: EngineContext, rule: RssSourceRule, link: string): Promise<string> {
    if (!ctx.webRenderer) return '';
    // `#463①`：等脚本型 header 的异步 prime 落地（独立 getContent / 前置请求短路的兜底）
    await whenSourceHeadersPrimed(ctx);
    const html = await ctx.webRenderer(link, {
      ...(rule.raw.injectJs ? { js: rule.raw.injectJs } : {}),
      headers: sourceHeadersFromCtx(ctx, rule),
    });
    // 走与正文同一套注入（位置对齐上游 clHtml）—— 旧实现是把 `<style>` **拼在 `<!doctype>` 前面**，
    // 浏览器能容忍但位置不对（`#308` 统一到 `injectSourceStyle`）
    return injectSourceStyle(html, rule.raw.style);
  }

  /** 单页：抓 → ruleContent 解析 → nextContentUrl 列表（绝对化基准 = 当前页 URL） */
  private async fetchContentPage(
    ctx: EngineContext,
    rule: RssSourceRule,
    p: Partial<ChapterPayload>,
    url: string,
    /** `#334` 首页 true（404 直接报错）；追页 false（单页失败跳过，不中断整篇） */
    requireOk = false,
  ): Promise<{ chunk: string; nexts: string[] }> {
    const env = makeRssEnv(ctx, rule, url, { ...p } as Record<string, unknown>);
    /**
     * `#341`②：link 的 `,{options}` 尾巴（method/body/headers）必须先解析再请求 ——
     * 上游 `RssParserByRule` 的正文请求走 `AnalyzeUrl(url)` 构造（选项三元组生效）。
     * Lofter 的 detail link = `https://api...detail.api?product=…,{"method":"POST","body":"targetblogid=…&postid=…"}`，
     * 旧实现**原文整串当 URL** ⇒ API 收到畸形 URL 恒 **HTTP 400** ⇒ 正文空白
     * （①修好后 postid 已能填上，这里不修仍 400 —— 两层缺陷同症状）。
     * `optionToRequest` 的注释明说它就是为本引擎这条 `,{options}` 链准备的（别处已在用）。
     *
     * ★★ `#419`（用户报 18AV「正文加载失败：`Illegal hexadecimal character "<"`」）—— 两处补齐
     * （同一句 `AnalyzeUrl(url)` 语义在**列表面**由 `buildFeedRequest` 做了、正文面漏了）：
     *  ① **先跑 URL 里的 `@js:` 段**（core `applyUrlRuleJs` 是唯一实现）。18AV 的正文 link 形如
     *    `https://site/xx.html@js:'data:;base64,<路径字节>,{"type":"18av"}'`：不跑 JS 就整串当 URL 发出去
     *    ⇒ 站点回一张 HTML 错误页 ⇒ `java.hexDecodeToString("<html…")` 抛
     *    「Illegal hexadecimal character "<"」（真机复现的正是这条错误）。
     *  ② **透传 URL 选项 `type`**（响应体字节 hex 通道，`#408`）。漏传 ⇒ `bodyAsHex=false`
     *    ⇒ 拿到文本而不是 hex ⇒ 源规则 `java.hexDecodeToString` 必然失败。
     *    （列表面 `buildFeedRequest` 早已透传；两条路径必须同一口径。）
     */
    const runJs = async (code: string, cur: string): Promise<string> => {
      const r = await env.jsEval(code, {
        source: env.sourceData ?? {},
        baseUrl: env.baseUrl ?? url,
        page: 1,
        key: '',
        result: cur == null ? '' : String(cur),
      });
      return r == null ? '' : String(r);
    };
    const linkRaw = await applyUrlRuleJs(url, (code, cur) => runJs(code, cur));
    const parsedLink = splitUrlOptions(linkRaw);
    const opt = optionToRequest(parsedLink.option);
    const optType = typeof parsedLink.option?.type === 'string' && parsedLink.option.type.trim() ? parsedLink.option.type.trim() : undefined;
    const optCharset = typeof parsedLink.option?.charset === 'string' && parsedLink.option.charset.trim() ? parsedLink.option.charset.trim() : undefined;
    const body = await this.fetchText(
      ctx,
      rule,
      {
        url: parsedLink.url,
        ...(opt.method !== 'GET' ? { method: opt.method } : {}),
        ...(opt.body != null ? { body: opt.body } : {}),
        ...(Object.keys(opt.headers).length ? { headers: opt.headers } : {}),
        ...(optCharset ? { charset: optCharset } : {}),
        ...(optType ? { type: optType } : {}),
      } as FeedRequest,
      {
        ...(requireOk ? { requireOk: true } : {}),
        /**
         * `#699` `≡获取成功` 交给 `fetchText` 打：上游 `Rss.kt:211` 正文面打的是**落地地址**
         * `res.url`（列表面打的才是规则 URL）。只有 `fetchText` 里拿得到 `res` ——
         * 这里若还用 `parsedLink.url`，重定向站点会打出「获取成功:<旧域名>」的怪象
         * （实测 凹凸吧 `tuao.cc` 301 → `24ao.cc`）。
         */
        logFetchedUrl: true,
      },
    );
    // 上游 analyzeContentPage：setBaseUrl(getAbsoluteURL(rssArticle.origin, baseUrl))
    const base = resolveUrl(rule.sourceUrl, parsedLink.url || url);
    const ar = new AnalyzeRule(env).setContent(body, base);
    const chunk = await ar.getString(rule.ruleContent!);
    let nexts: string[] = [];
    if (rule.type === 0 && (p.type ?? 0) === 0 && rule.nextContentUrl) {
      // 上游 getStringList(nextContentUrl, isUrl = true)：本仓 getStringList 无 isUrl ⇒ 自行绝对化
      const list = await ar.getStringList(rule.nextContentUrl);
      nexts = list.map((u) => (u ? resolveUrl(base, u) : '')).filter(Boolean);
      // 上游 `Rss.kt:235-239`：`┌获取正文下一页链接` / `└` + 逗号连接
      dlog(ctx, '┌获取正文下一页链接');
      dlog(ctx, `└${nexts.join('，')}`);
    }
    return { chunk, nexts };
  }

  /**
   * `#434` **图片字节二次解密**（Legado `ImageUtils.decode` / `BaseSource.coverDecodeJs`）。
   *
   * 移植自 `engine-legado.decodeImage`（判据逐条对齐，不另写一套）：
   * 源声明 `coverDecodeJs` ⇒ 以 `result`（图片字节）/`src`（图片 URL）为入参跑脚本，
   * 返回解密后的 ByteArray；规则为空 ⇒ 原图（返回 `null`）；执行/解密失败 ⇒ `null`（调用方回传原图）。
   *
   * ★ **为什么 RSS 引擎必须有**：订阅源的封面也可以是**密文** —— 实测 91视频的 `image`
   * 是完整绝对 URL、经 `/api/proxy` 回 200，但内容是 AES 密文（magic ≠ JPEG）。
   * 此前 `hub.decodeImage` 对 RSS 源恒 `null` ⇒ 代理原样回传密文 ⇒ `<img>` 解不出
   * ⇒ 用户看到「内容卡片无封面」。
   *
   * `result` 必须用 {@link asImageStreamResult}（**InputStream 语义**）：上游封面走
   * `byteStream()`、源脚本用 `result.readAllBytes()` —— 只给裸 `Uint8Array` 会
   * `readAllBytes is not a function` 而静默解密失败。
   */
  async decodeImage(
    rule: RssSourceRule,
    req: { url: string; bytes: Uint8Array; isCover?: boolean },
    ctx: EngineContext,
  ): Promise<Uint8Array | null> {
    // 上游 RSS 源只有封面一条解密通路（正文图解密是 BookSource 的 `contentRule.imageDecode`）
    const js = (rule.coverDecodeJs ?? '').trim();
    if (!js || js === 'null') return null;
    // `#889` 同 `engine-legado.decodeImage`：封面解密是**独立入口**（`hub.decodeImage` 每次新建 ctx），
    // 冷进程首图必须先异步 prime jsLib，否则 `makeRssEnv` 里的同步下载会卡住主线程。
    await primeJsLib(ctx, rule);
    /**
     * `#759` 判据与 engine-legado 逐条对齐（两条引擎不得各写一套）：
     * worker 可用 ⇒ 下发裸字节描述符；否则旧 L1 行为。重跑一律新建 env。
     */
    const runDecode = async (useWorker: boolean, probe = false): Promise<Uint8Array | null> => {
      const env = makeRssEnv(ctx, rule, req.url);
      const started = Date.now();
      const out = await new AnalyzeRule(env).runJs(
        js,
        useWorker
          ? imageDecodeBindings(req.bytes, req.url)
          : { result: asImageStreamResult(req.bytes), src: req.url },
      );
      if (!useWorker) recordImageDecodeL1Cost(js, '', Date.now() - started);
      else if (probe) recordImageDecodeProbeCost(js, '', Date.now() - started);
      return toBytesOrNull(out);
    };
    try {
      // RSS 编译后的规则不带 jsLib 原文（由 env 从源缓存解析）⇒ 这里只能按脚本本体判
      const plan = planImageDecode(js, '', req.bytes.length);
      let bytes: Uint8Array | null;
      try {
        bytes = await runDecode(plan.useWorker, plan.probe);
      } catch (e) {
        if (plan.probe) abortImageDecodeProbe(js, '');
        if (!plan.useWorker || !shouldRetryImageDecodeInL1(e)) throw e;
        warnOnce(
          `image-decode-worker-retry:${rule.sourceUrl}`,
          `封面解密 worker 失败/超时，回落宿主执行（最坏只慢）：src=${req.url.slice(0, 120)} | ${
            e instanceof Error ? `${e.name}: ${e.message}` : String(e)
          }`,
        );
        bytes = await runDecode(false);
      }
      // 「跑通了但没吐出字节」也是缺陷（症状与「站点图片本来就这样」一样）——必须留痕（铁律 3）
      if (!bytes || !bytes.length) {
        warnOnce(
          `image-decode:${rule.sourceUrl}`,
          `封面解密脚本未返回字节（回原图）：src=${req.url.slice(0, 120)}`,
        );
      }
      return bytes;
    } catch (e) {
      const stack = String((e as Error).stack ?? '')
        .split('\n')
        .slice(1, 4)
        .map((l) => l.trim().replace(/^at /, ''))
        .join(' <- ');
      warnOnce(
        `image-decode:${rule.sourceUrl}`,
        `封面解密失败，已回退原图（封面可能显示为乱码/空白）：src=${req.url.slice(0, 120)} | ${
          e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        } | ${stack}`,
      );
      return null;
    }
  }

  /**
   * 源登录（对齐 Legado `BaseSource.login()`；订阅源同样带 `loginUrl` / `loginUi`）。
   *
   * 上游依据：`RssSource.kt:40-44` 继承 `loginUrl`/`loginUi`/`loginCheckJs`；
   * `RssSourceDao.kt:85` 专查有 `loginUrl` 的订阅源；`RssAdapter.kt:68` 给订阅源列表挂「登录」菜单；
   * `RssSortActivity.kt:303`（分类/排序界面）也按 `loginUrl` 显示登录入口
   * ⇒ **订阅源登录是一等功能**，不是书源专有。
   *
   * 形态判定复用 core 的 `classifyLoginUrl`（与书源引擎**同一条**判据；`#314` 下沉到 core，
   * 此前只存在于 engine-legado 包内 ⇒ rss 要么抄一份、要么反向依赖 legado 包）。
   * 本仓 RSS 语料实测（31 源）：`loginUrl` 9 个、`loginUi` 7 个；分布 `none 22 / ui 7 / url 2`。
   *
   * 能力边界（显式可见，绝不静默跑错）：
   *  · ✅ `ui` 行（text / password / select / toggle / button）+ `loginUrl` 里的 `login()` 脚本；
   *  · ✅ `url` / `config-url` → 把登录页交回前端打开；
   *  · ❌ **LoginUiV2**（`loginUi = {"version":2}`）本引擎暂不实现 —— 本仓 RSS 语料 **0 例**，
   *    给显式提示 + `warnOnce` 留痕（不做「看着像成功」的假通过）。
   */
  async login(rule: RssSourceRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedLoginResult> {
    await this.prepare(rule, ctx);
    const plan = classifyLoginUrl(rule.loginUrl, rule.loginUi);
    const loginAction = String(req.loginAction ?? '').trim();

    // `#315`：形态早退（none / url / config-url）走 core 共享件（与 legado 引擎同一条）
    const early = loginPlanEarlyResult(plan, '订阅源');
    if (early) return early;
    if (plan.uiV2) {
      warnOnce(`login-v2:${rule.sourceUrl}`,
        `订阅源 ${rule.sourceName || rule.sourceUrl} 用 LoginUiV2（loginUi={"version":2}），本引擎暂不支持（本仓 RSS 语料 0 例）`);
      return { ok: false, action: 'server', uiV2: true, message: '该订阅源使用 LoginUiV2 登录界面，本引擎暂不支持' };
    }

    const env = makeRssEnv(ctx, rule, rule.sourceUrl);
    // `#347`：`loginUi` 是 `@js:`/`<js>` 动态脚本时，行数组要**求值**才拿得到
    // （静态数组才由 classifyLoginUrl 直接解析）。Lofter 实测：不求值 ⇒ 登录对话框 0 行 ⇒ 空白。
    let fields: LoginField[] = plan.fields;
    /** `#411`：动态 loginUi 求值失败的原因（空 ⇒ 无错）；非空必须让对话框看见 */
    let uiError = '';
    if (plan.uiIsScript) {
      const resolved = await resolveLoginFields(plan, env);
      fields = resolved.fields;
      uiError = resolved.error ?? '';
    }
    /** 把「登录界面为什么没渲染出来」并进结果 message（`#411`：不许静默空表单） */
    const withUiNote = (m: string): string =>
      (uiError ? `${m}｜登录界面（loginUi）脚本求值失败：${uiError}` : m);
    /**
     * `#423` **只渲染登录界面**：打开对话框的 `GET /login` 用它拿行数组。
     * 早退在**一切脚本之前** ⇒ 读接口零副作用（判据见 core `LOGIN_UI_RENDER_ACTION`）。
     */
    if (loginAction === LOGIN_UI_RENDER_ACTION) {
      return { ok: true, action: 'form', fields, message: withUiNote('登录界面已渲染') };
    }
    const existing = readLoginInfo(ctx);
    const beforeHeader = String(ctx.variables.get('__loginHeader') ?? '');
    const beforeCookie = ctx.cookies?.header() ?? '';
    // toast 由 `makeRssEnv` 的 onToast 收进 ctx.toastSink（源脚本的按钮动作常只靠 toast 反馈）
    const toasts = (): string[] => (ctx.toastSink ?? []).slice();
    /**
     * `java.upLoginData(data)` 的收集结果 —— **脚本要求实时更新登录界面字段值**
     * （上游 `SourceLoginJsExtensions.kt:35-37` → 对话框 `handleUpUiData`；只改 UI、不落库）。
     * 服务端没有 UI ⇒ 随登录结果回传 `loginData`，由前端回填到表单（用户 2026-10-15 实测
     * 18AV「🌐获取网址」：脚本写了值、界面没回填 —— 真因是 core 此前**整条 API 未实现**）。
     */
    const loginDataUpdate = (): Record<string, string> => {
      const raw = String(ctx.variables.get('__upLoginData') ?? '');
      if (!raw) return {};
      try {
        const o = JSON.parse(raw) as unknown;
        return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {};
      } catch {
        return {};
      }
    };

    // ① 只有表单、没有 loginUrl 脚本 → 「保存即完成」（表单值供规则里的 getLoginInfo() 使用）
    if (!plan.js) {
      return {
        ok: true,
        action: 'form',
        fields,
        hasLoginInfo: Object.keys(existing).length > 0,
        message: withUiNote('已保存登录信息'),
      };
    }

    // ② 有表单行且尚未填写、且本次不是按钮动作 → **先要表单**（`#315` 表单闸门走 core 共享件；
    //    对齐 legado 引擎同款闸门：Legado `getLoginData` 为空则落回登录 UI，不先给表单直接跑
    //    login() ⇒ 脚本拿不到输入）。⚠️ 必须带 `fields` 回前端，否则对话框仍是空的（`#347`）。
    const gate = loginFormGate(fields, { loginAction, hasLoginInfo: Object.keys(existing).length > 0 });
    if (gate) return gate;

    // ③ 跑 `loginUrl` 的 login()（Legado：`${getLoginJs()}\nlogin.apply(this)`；按钮动作则跑该 action；
    //    `#315` 拼脚本走 core 共享件）
    const code = buildLoginScript(plan.js, loginAction);
    try {
      await new AnalyzeRule(env).runJs(code, { result: { ...existing } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /**
       * `#469①`：源**没有 `login()` 函数**时，core 的 `buildLoginScript` 抛
       * `Function login not implements!!!`（与上游 Legado 一致）。但用户 2026-10-15 明确语义：
       * **有数据存数据、有登录就存 Cookie，然后关登录界面** —— 「保存并登录」不该因为源里
       * 没写 `login()` 就报错、把对话框卡住（四季书屋实测）。
       * ⇒ 把这条**特定错误**当「保存并关闭」：返回 `ok` + 友好文案
       * （前端在「无 action 的成功」分支会据此关窗，见 `SourceLoginDialog.post`）。
       */
      if (!loginAction && /login not implements/i.test(msg)) {
        const upd0 = loginDataUpdate();
        return {
          ok: true,
          action: 'server',
          ...(fields.length ? { fields } : {}),
          ...(Object.keys(upd0).length ? { loginData: upd0 } : {}),
          ...(toasts().length ? { toasts: toasts() } : {}),
          hasLoginInfo: Object.keys(existing).length > 0,
          wroteLoginState: false,
          message: withUiNote('该源没有 login() 登录脚本：已保存现有登录信息（如有）并关闭'),
        };
      }
      const browserBlocked = needBrowserFromError(msg);
      const upd = loginDataUpdate();
      return {
        ok: false,
        action: 'server',
        needBrowser: browserBlocked,
        ...(fields.length ? { fields } : {}),
        ...(Object.keys(upd).length ? { loginData: upd } : {}),
        ...(toasts().length ? { toasts: toasts() } : {}),
        hasLoginInfo: Object.keys(existing).length > 0,
        message: withUiNote(
          `登录脚本执行失败：${msg}` +
            (browserBlocked ? '；脚本调用了 WebView 交互 API，需桌面端 + 人工操作' : ''),
        ),
      };
    }

    // ③ 脚本可能改了 loginInfo（`source.putLoginInfo`）/ 登录头（`source.putLoginHeader`）→ 落盘
    await persistSourceLogin(ctx);

    /**
     * ④ 脚本若调用过 `startBrowser` / `startBrowserAwait` / `webView` → **它要真浏览器**
     * （人工登录 / 拿密钥 / 验证码）。服务端渲染拿不到人工结果，所以把 URL 交回前端打开。
     *
     * ★ `#387`（用户实测 ˃̶͈ ꇴ ˂̶͈「密钥」按钮）：订阅源 `loginUi` 的按钮行动作
     * 就是 `java.startBrowser(url, '密钥')` —— 语义是「打开页面拿密钥，回来填进输入框」。
     * 此前 RSS 侧**完全没读这条通道** ⇒ 5 个按钮一律回 `ok:true / action:'server'`
     * ⇒ 前端显示「按钮动作已执行」而**窗口不弹**（用户原话：「4 个按钮都只有一个登录成功提示」）。
     *
     * ⚠️ 顺序与 `engine-legado` 一致：**先判浏览器**再算 ok —— 否则 `ok:true` 会把它盖掉。
     * 返回 `ok:false` 是对的（登录尚未完成，人工操作在窗口里进行）。
     */
    const browserUrl = String(ctx.variables.get('__browserUrl') ?? '');
    if (browserUrl) {
      const upd = loginDataUpdate();
      return {
        ok: false,
        action: 'browser',
        url: browserUrl,
        needBrowser: true,
        // `#393` 目的：'show'（startBrowser，打开给人看）⇒ 应用内浏览器；'cookie' ⇒ 本机真浏览器。
        browserKind: ctx.variables.get('__browserNeedCookie') ? 'cookie' : 'show',
        ...(fields.length ? { fields } : {}),
        ...(Object.keys(upd).length ? { loginData: upd } : {}),
        ...(toasts().length ? { toasts: toasts() } : {}),
        hasLoginInfo: Object.keys(existing).length > 0,
        message: '登录脚本要求打开浏览器（人工登录 / 拿密钥 / 安全验证）：请在打开的页面完成后再回来',
      };
    }

    const afterInfo = readLoginInfo(ctx);
    const cookie = ctx.cookies?.header() ?? '';
    const headerChanged = String(ctx.variables.get('__loginHeader') ?? '') !== beforeHeader;
    // `#397`：登录态 **delta** —— 只认「本次运行新写了什么」，不认当前状态
    //（hasLoginInfo/count 是状态：源之前写过的「密钥」loginInfo、会话 jar 里已有的 Cookie
    //  都会让它们为真 ⇒ 「书源更新」这类纯动作按钮被误报成「✅ 登录成功」）。
    // loginInfo 比较**键序无关**（putLoginInfo 重写同样内容不应算「写了」）。
    const cookieChanged = cookie !== beforeCookie;
    // loginInfo 比较**键序无关**（putLoginInfo 重写同样内容不应算「写了」）——与 loginFingerprint 同口径
    const fpInfo = (info: Record<string, string>): string =>
      Object.keys(info).sort().map((k) => `${k}\u0001${info[k]}`).join('\u0002');
    const infoChanged = fpInfo(afterInfo) !== fpInfo(existing);
    const wroteLoginState = headerChanged || cookieChanged || infoChanged;
    // 「按钮动作」= 跑通即算完成：源脚本的 button 行常常只改**源变量**，既不写 Cookie 也不写登录头，
    // 按「登录态有没有变」判会把它们永远判失败（对齐 legado 引擎的同款结论）。
    const ok = !!loginAction || headerChanged || cookie !== beforeCookie || Object.keys(afterInfo).length > 0;
    const upd = loginDataUpdate();
    return {
      ok,
      action: 'server',
      ...(fields.length ? { fields } : {}),
      ...(Object.keys(upd).length ? { loginData: upd } : {}),
      ...(cookie ? { cookie, count: cookie.split(';').filter((x) => x.trim()).length } : {}),
      ...(toasts().length ? { toasts: toasts() } : {}),
      hasLoginInfo: Object.keys(afterInfo).length > 0,
      wroteLoginState,
      message: withUiNote(
        ok
          ? loginAction
            ? toasts().at(-1) ?? '按钮动作已执行'
            : '已执行登录脚本'
          : '登录脚本执行成功，但没有产生 Cookie / 登录头（可能站点用 Token 且需桌面端 WebView 交互）',
      ),
    };
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * `#434`/`#435` **卡片字段净化**（`summary` / `subtitle` 共用；空 ⇒ `undefined`）。
 *
 * 走 core 的 `formatIntro`（Legado `HtmlFormatter.formatIntro` 的唯一实现）：
 * 剥标签、去 HTML 注释、块级标签还原换行；`#435` 起还会**整段删掉 `<style>`/`<script>` 的内容**
 * （上游只删标签、留下 CSS 源码 ⇒ 卡片上会直接显示 `*{margin:0;…}`，见 `html-format.ts` 的注释）。
 */
function cleanCardText(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  return formatIntro(s) || undefined;
}

/**
 * `#434` 源脚本返回值 → 图片字节（`null` = 不是字节，调用方回传原图）。
 * 与 `engine-legado` 的同名函数**逐字相同**：`Uint8Array` 直接用；数组按字节钳位；
 * **字符串不是图片字节**（返回 null，避免把 base64 串当字节）。
 */
function toBytesOrNull(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => Number(x) & 0xff));
  if (typeof v === 'string') return null;
  return null;
}

/**
 * `#347` 求值 `loginUi` 动态脚本（`@js:` / `<js>`）得到登录行数组。
 * 与 `engine-legado` 的 `resolveLoginFields` **同一语义**（对齐 Legado
 * `BaseSource.getLoginInfoMap()` 里的 evalJS：`${getLoginJs()}\n$loginUiJs`，
 * bindings 预置 `result = {}`——脚本可能用 `result = JSON.stringify(rows)`）。
 *
 * ## 为什么 RSS 侧必须有（用户 2026-10-08 实测 📖Lofter「登录界面未正确加载」）
 * Lofter 的 `loginUi` 是一大段 `<js>` DSL：
 * ```
 * let s = source.getVariable();
 * let mockData = JSON.parse(s || '{"users":[],"collections":[],...}');
 * let all = [{ "name":"默认启动页", "type":"button", "action":`source.put("start","")…`,
 *              "viewName":`…`, "style":{...} }, ...];
 * JSON.stringify(all)
 * ```
 * `classifyLoginUrl` 把 `<js>` 形态判成 `uiIsScript=true`、`fields=[]`（静态数组才解析字段），
 * 而本引擎此前**从不求值这段脚本** ⇒ 登录对话框拿到 0 行 ⇒ 界面空白。
 * `engine-legado` 早就有这个分支（`plan.uiIsScript` → `resolveLoginFields`），RSS 侧漏了。
 *
 * 求值失败**不抛**（登录行拿不到只应是「界面空」，不该把整个 login 请求打挂），
 * 但必须把 `error` 带回调用方 ⇒ 由它并进结果 `message`（`#411`：对话框要看得见原因，
 * 而不是只留一行服务端日志 —— 18AV 的 `loginUi` 第一条就是
 * `java.importScript('https://unpkg.com/artplayer/dist/artplayer.js').match(...)[1]`）。
 */
async function resolveLoginFields(
  plan: { js: string; uiRaw: string },
  env: import('@yuedu/core').AnalyzeEnv,
): Promise<{ fields: LoginField[]; error?: string }> {
  const uiJs = extractInlineJs(plan.uiRaw) ?? '';
  if (!uiJs) return { fields: [] };
  const code = `${plan.js ? `${plan.js}\n` : ''}${uiJs}`;
  let out: unknown;
  try {
    out = await env.jsEval(code, {
      result: {},
      source: env.sourceData,
      baseUrl: env.baseUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnOnce(`login-ui:${env.baseUrl}`, `订阅源 loginUi 脚本求值失败（登录行按空处理）：${msg}`);
    return { fields: [], error: msg };
  }
  const fields =
    typeof out === 'string'
      ? parseLoginUiText(out)
      : Array.isArray(out)
        ? out.map(normalizeLoginField).filter((x): x is LoginField => !!x)
        : [];
  if (fields.length) return { fields };
  // 「跑通了但一行都没产出」与「脚本抛错」对用户是同一个症状（空对话框）——一起留痕并回传
  const produced = typeof out === 'string' ? out : JSON.stringify(out ?? null);
  const msg = `loginUi 脚本未产出任何行（返回类型 ${typeof out}，前 120 字：${String(produced ?? '').slice(0, 120)}）`;
  warnOnce(`login-ui-empty:${env.baseUrl}`, `订阅源 ${msg}`);
  return { fields: [], error: msg };
}


/**
 * `#308` 把源的 `style` 字段注入正文 HTML —— **逐字对齐上游 `clHtml`**
 * （`ReadRssViewModel.kt:258-287`；调用点 `ReadRssActivity.kt:406`：
 * `val html = viewModel.clHtml(content, rssSource?.style)`）。
 *
 * ## 为什么必须做（不是加戏）
 * `clHtml` 里样式注入占了大半篇幅，而语料里 **15 个源**依赖它（`tmp/scan-style.txt`，全是 rss 源），
 * 且都是版式基础 —— 恰含用户 2026-10-07 报的两个源：
 *   · `24凸凹吧`（同族还有 凹凸吧 / 24凹凸 / 24MM / 凹凸 / AI24）`style` 737 字符，含 `body`/介绍区/图集版式；
 *   · `影视聚合(资源站)` `style` 510 字符，含 `.container{max-width}` 等。
 * 不注入 ⇒ 用户看到的正是他报的「没有正确处理，加载，显示」（正文出来了但版式全丢）。
 * 其余：`摄影图库`(149) · `次元小镇`(78) · `饭团动漫`(361) · `MISSAVT`(30) · `Lucky X`(37) ·
 * `91视频`(46，iframe 高度) · `麻豆传媒`(37) · `Lofter`(1340)。
 *
 * ## 上游的插入位置（逐字）
 * ```kotlin
 * val styleEndIndex = htmlBuilder.indexOf("</style>")
 * if (styleEndIndex >= 0) insert(styleEndIndex + 8, "<style>$style</style>")
 * else { val headEnd = htmlBuilder.indexOf("</head>")
 *        if (headEnd >= 0) insert(headEnd, "<style>$finalStyle</style>")
 *        else insert(0, ...) }
 * ```
 * ⇒ ① 内容里已有 `</style>`：插在**第一个** `</style>` **之后**（`style` 非空才插）；
 *    ② 没有 `</style>`：插在第一个 `</head>` **之前**；③ 连 `</head>` 都没有：插到**最前面**。
 *
 * ## ⚠️ 有意偏离上游一处（有据可查，非猜测）
 * 上游无条件包一层 `<style>…</style>`。但语料里「饭团动漫」的 `style` 值**自带** `<style>` 标签
 * （`<style>\n.ad-warning {…` —— 一个源包打包时把标签写进值里了），照抄会得到
 * `<style><style>.ad-warning{…}</style>` —— **`<style>` 元素的内容按原文处理、不解析标签**，
 * 于是整段 CSS 变成一段字面文本、**完全失效**。这里检测到值已自带 `<style` 就不重复包。
 */
export function injectSourceStyle(html: string, style?: string | null): string {
  const css = (style ?? '').trim();
  if (!css) return html;
  const tag = /^<style[\s>]/i.test(css) ? css : `<style>${css}</style>`;
  const end = html.indexOf('</style>');
  if (end >= 0) return html.slice(0, end + 8) + tag + html.slice(end + 8);
  const head = html.search(/<\/head>/i);
  if (head >= 0) return html.slice(0, head) + tag + html.slice(head);
  return tag + html;
}
