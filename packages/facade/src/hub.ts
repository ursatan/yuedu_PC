/**
 * EngineHub —— 统一门面（M3）
 *
 * 职责：
 *  1. 持有 EngineRegistry（detect/compile/invoke 复用 core 的）。
 *  2. 管理「已导入的源」（SourceStore）：raw + 编译后的 rule + 用户可调的 state。
 *  3. 在**所有** action 上强制 SourceState（总开关 / 搜索 / 发现）—— 任务 #11 的统一落点。
 *  4. 多源聚合搜索：并发跑 + 逐源流式产出 EngineEvent（喂 SSE）。
 *
 * 对上层（server/web）只暴露 EngineHub，不暴露任何具体引擎。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  EngineRegistry,
  createHttpClient,
  acquireConcurrentSlot,
  parseConcurrentRate,
  type HttpClientScopeOptions,
  type TaskClass,
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  resolveSourceState,
  EngineError,
  type RuleEngine,
  type CookieStore,
  type EngineContext,
  type HttpClient,
  type HttpResponse,
  type KeyValueStore,
  LOGIN_HEADER_PREFIX,
  LOGIN_INFO_PREFIX,
  type JsSandboxPool,
  type EngineEvent,
  type UnifiedRequest,
  type UnifiedListResult,
  type UnifiedDetail,
  type UnifiedContent,
  type UnifiedPlay,
  type SourceState,
  type EngineAction,
  type UnifiedLoginResult,
  type UiActionRequest,
  type UiActionResult,
  type WebRendererHook,
  isChallengePage,
  // `#743` P0：封面解密阻塞埋点（facade 只有 hub 这条路径会跑源 JS 解密）
  recordBlock,
  // `#771` 冻结定向探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）
  probePoint,
  // `#779` content 动作的纯计算求值预算（默认 20s；`YUEDU_JS_CONTENT_TIMEOUT_MS` 可回退）
  contentComputeEvalTimeoutMs,
  // `D2`：`decode{}` 对象/JSON 形式的图片解密规范（封面/正文图的闸门判据与之统一）
  parseImageDecodeSpec,
  // `#786` 脚本资源在 WAF 后**先读本地镜像**，不再拉起 Chromium 打开 `.js`
  readJsMirror,
} from '@yuedu/core';
import {
  deriveId,
  parseImportText,
  sameSourceRaw,
  type ImportFormatHint,
  type ImportParseResult,
  type ImportPreview,
  type ImportPreviewItem,
  type ImportRow,
} from './importer';
import { SourceStore, sourceIdentity, type HubSource } from './source-store';
import { takeTruncatedSince, truncatedMark } from '@yuedu/core';
import { noopSandbox } from './sandbox';

export interface HubOptions {
  /** JS 沙箱，默认 noop（M4 替换 worker 池） */
  sandbox?: JsSandboxPool;
  /** JS 渲染器（可选）：Electron 桥接时注入，java.webView 走真渲染。
   *  `#453`：可接收 `opts.sourceId`（渲染层据此选该源的常驻浏览器会话）；只写 `(url) => …` 也可赋值。 */
  webRenderer?: WebRendererHook;
  /**
   * `#676` `java.webView(html, url, js)` 的宿主实现（见 `EngineContext.renderHtmlScript`）。
   * 实现方（server）用真浏览器三段 CDP：navigate(base) → setDocumentContent → evaluate(returnByValue)。
   */
  renderHtmlScript?: (html: string, baseUrl: string, js: string, sourceId: string) => Promise<string>;
  /**
   * `#727` `java.getVerificationCode(imageUrl)` 的人工输入通道（见 `EngineContext.verificationCode`）。
   * `sourceId` 由 hub 注入（实现方据此复用该源的常驻 Chromium、把 Cookie 收回该源 CookieStore）。
   * 超时/用户取消/关窗必须 reject。
   */
  verificationCode?: (imageUrl: string, sourceId: string) => Promise<string>;
  /**
   * `#481` **反爬自动重放**（可选）：引擎请求撞 403/503 且响应体带 WAF 特征时，
   * hub 用它（通常 = CDP 常驻会话渲染）重放该 URL，把渲染 HTML 当作本次响应；
   * 返回的 cookies 由实现方回收进源 CookieJar（hub 不管持久化）。
   * 返回 null = 重放失败/不可用（原响应原样返回）。
   */
  /**
   * `#496` 第三参 `ctx.background`：**后台任务**（书架定时更新等，用户没在操作）发起的请求。
   * 实现方据此**不要拉起有头浏览器**（后台不该弹窗），直接返回 null 让本轮静默跳过。
   */
  antibotReplay?: (url: string, sourceId: string, ctx?: { background?: boolean }) => Promise<{ html: string } | null>;
  /**
   * `#519` **预判「这个 URL 直连必被 WAF 拦」**（实现方注入；server 侧用「该 host 最近
   * 成功渲染过」作判据）。返回 true ⇒ 跳过那次注定 403 的 HTTP 往返，直接走重放。
   * 不注入 = 行为不变（先请求、撞 WAF 再重放）。
   */
  antibotPreflight?: (url: string, sourceId: string) => boolean;
  /**
   * `#658` **该源「过闸那只浏览器」的 UA**（可选；server 侧在验证清关后收割）。
   *
   * 为什么必须让引擎跟着换 UA：Cloudflare 的 `cf_clearance` **与 UA 绑定**。实测 138阅读网：
   * 源 header 写的是移动 UA（`Android 10; K … Mobile Safari`），而验证窗里过闸的是桌面 Chrome
   * ⇒ 收割回来的 `cf_clearance` 带着也没用，每次请求仍 403 ⇒ 又被当成「需要人工」去弹验证窗，
   * 用户看到的就是「已经过闸了却总弹内置浏览器、正文 403」。
   * 所以：**过闸用的 UA 优先于源 header 的 UA**（只有存在清关会话时才注入）。
   */
  sessionUaOf?: (sourceId: string) => string | undefined;
  /** 注入到每次请求的默认 HTTP 头（UA 等） */
  httpHeaders?: Record<string, string>;
  /** 单次请求超时毫秒 */
  timeoutMs?: number;
  /** http 工厂，默认 createHttpClient。测试可注入 mock。
   *  `#200`：可接收作用域参数（任务类别 + 并发池），用于流量护栏分层限额。 */
  httpFactory?: (opts?: HttpClientScopeOptions) => HttpClient;
  /** 共享键值存储（跨请求持久）：宿主可注入文件版（core 的 createFileKeyValueStore）；
   *  缺省内存版。源变量 / 发现页输入（infoMap）等都存在这里，**绝不能每请求新建**。 */
  storage?: KeyValueStore;
  /**
   * `#373` **单个动作的总超时**（毫秒），默认 120s。
   *
   * 为什么必须有：`await out` 原本是**无限等待** —— 慢源（如某些 RSS 影视源的分类页
   * 串行抓几十个请求）或异常源会把一次 `/api/run` 挂到天荒地老；前端心跳（15s × 连续 3 次
   * 失败）等不到响应就把服务判成「已离线」，用户看到的就是「点一个源卡住 → 整个服务离线 →
   * 只能手动重启」。加总超时闸后，卡死的动作最多 2 分钟会**以明确错误收场**
   * （`NETWORK@request`，detail.input 带 `runTimeout` 标记），前端能显示错误、用户能切源重试，
   * 不再需要重启服务。
   *
   * ⚠️ 超时只是**响应不再等**：底层引擎任务（worker 求值 / fetch）会继续跑到自然结束，
   * 其结果被丢弃、sourceVariable/内存缓存照常回写（`syncSourceState` 不受影响）。
   */
  runTimeoutMs?: number;
}

/** 极小的不依赖具体引擎的事件通道，用于并发聚合时的流式 yield */
class Channel<T> {
  private q: T[] = [];
  private waiters: Array<(v: T | null) => void> = [];
  private done = false;
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.q.push(v);
  }
  end(): void {
    this.done = true;
    const w = this.waiters.shift();
    if (w) w(null);
  }
  pull(): Promise<T | null> {
    if (this.q.length) return Promise.resolve(this.q.shift()!);
    if (this.done) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }
}

// 源 id 派生与导入解析均在 ./importer（Web 端与服务端共用同一套规则，避免预览/入库不一致）

export type AggregateEvent = EngineEvent;

/** 源校验结果（复刻 Legado CheckOutcome + 分组标签） */
/**
 * `#693` 分段结果**带上「这一段到底拿到了什么」**（对齐 Legado 调试信息流的观感）：
 * 只给一个 ✓ 看不出规则好坏 —— 搜索要看到条数、目录要看到章数、正文要看到字数/直链。
 */
/**
 * `#696` **调试信息流的一行**（规则工坊「全链试跑」的信息流，对齐 Legado `Debug.log`）。
 *
 * 只带**给人看**的最小集合：时间戳 + 文本 + 级别。
 * 结构化现场（`rule` / `input` / `output`）留在 `TraceEntry` 里走「错误详情」那条路 ——
 * 两者的读者不同（人看信息流定位到哪一步，程序读 trace 组装错误），混起来两头都不好用。
 */
export interface VerifyLogLine {
  /** epoch ms（前端自己减起点算 `[mm:ss.mmm]`，避免跨机时钟/网络抖动影响行间隔） */
  at: number;
  msg: string;
  level?: 'info' | 'warn' | 'error';
}
/** `#696` 信息流回调（`verifySource` 的 `onLog`） */
export type LogHook = (e: VerifyLogLine) => void;

/**
 * `#697` 一次 run 的**可选钩子**（便利方法末位参数）：
 *  · `log` 信息流（`#696`）；
 *  · `onPartial` 详情/目录分段回调（`#512`）；
 *  · `signal` **外部中断**（`#480` 机制，`#697` 把它接到全链试跑的「换源/关页即取消」上）。
 */
export interface RunHooks {
  log?: LogHook;
  onPartial?: (d: UnifiedDetail) => void;
  signal?: AbortSignal;
  /**
   * `#698` **跳过浏览缓存**（`#480` 的 home/category 120s 缓存）。
   *
   * 试跑必须看**真实的一次执行**：命中缓存时引擎根本不会解析，信息流里自然一条
   * `┌获取列表 / └列表大小` 都没有，段位耗时还会显示 `1ms` —— 用户会以为「源没跑」。
   * 实测就踩到了：先手动 curl 一次把分类缓存热了，浏览器里再跑就只有 8 行日志。
   */
  noCache?: boolean;
}
/** `RunHooks` → `run()` 的 external 参数（空钩子给 undefined，保持零开销） */
function runExt(h?: RunHooks): {
  onLog?: LogHook;
  onPartial?: (d: UnifiedDetail) => void;
  signal?: AbortSignal;
  noCache?: boolean;
} | undefined {
  if (!h) return undefined;
  const out = {
    ...(h.log ? { onLog: h.log } : {}),
    ...(h.onPartial ? { onPartial: h.onPartial } : {}),
    ...(h.signal ? { signal: h.signal } : {}),
    ...(h.noCache ? { noCache: true } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

export interface VerifyStage {
  ok: boolean;
  error?: string;
  /** 结果摘要（如 `12 条` / `35 章` / `正文 5231 字`） */
  detail?: string;
  /** 本段耗时毫秒（Legado 调试流逐段记时，不是只有总时间） */
  ms?: number;
}
export interface VerifyOutcome {
  ok: boolean;
  message: string;
  /** 响应耗时毫秒（Legado respondTime） */
  respondTime: number;
  /**
   * 分段结果。`#472` 新增 `exploreInfo/exploreToc/exploreContent`（**发现链路深校验**：
   * 发现卡片 → 详情 → 目录 → 正文，与搜索链路对偶；旧实现发现只到「分类有卡片」为止）。
   */
  stages: Partial<
    Record<'domain' | 'search' | 'explore' | 'exploreInfo' | 'exploreToc' | 'exploreContent' | 'info' | 'toc' | 'content', VerifyStage>
  >;
}

/** 字典查词用的占位 sourceId（字典不属于任何书源；见 `dictLookup`） */
const DICT_PSEUDO_SOURCE = '__dict__';

/**
 * `#769` **detail（详情 + 目录）动作预算 = 75s**（其余动作仍用 `HubOptions.timeoutMs`）。
 *
 * 起因：速读谷 `suduguu.com` 页 1 的 999 章求值期间进程多次 5s 级冻结（`#477` 家族），
 * 60s 预算被吃光后页 2 只剩 1000ms ⇒ 必然超时 ⇒ 目录停在 999 章（旧代码静默返回）。
 * 给后续页最小 15s（引擎 `TOC_PAGE_MIN_TIMEOUT_MS`）还不够 —— 行动本身的硬预算也得留出这段，
 * 否则 `ctx.signal`（= 行动超时）会先于页 2 结束就中断。
 * 只放宽 detail：搜索/发现/正文的预算口径不动（它们的慢是另一类问题，不能被顺带放宽）。
 */
const DETAIL_ACTION_BUDGET_MS = 75_000;

/**
 * **`#199` 从 `home` 的返回里挑出「第一个可请求的分类」。**
 *
 * ## 为什么需要它
 * 多数源的 `home` **只返回分类清单**（`filters[].options[]`，`items` 为空）——
 * 前端 `stores/discover.ts` 的发现链正是**两步**（`home` 拿分类 → `category{filters}` 拿第一页列表）。
 * 旧校验只打 `home` 并断言 `items > 0` ⇒ 这类源被误判「发现失效」。
 *
 * ## 口径对齐上游
 * `CheckSourceService.kt:362-364`：`exploreKinds().firstOrNull { !it.url.isNullOrBlank() }?.url`
 * ⇒ **只取有 url 的项**。所以必须跳过：
 *  · `header: true`（`BookSourcePart.url` 为空 / `type:"text"` 的分组标题，如「地区」大标题）；
 *  · `kind` 非 `url` 的交互控件（`toggle` / `select` / `button`）——它们要靠 `$input` 回传，
 *    直接把 `value` 当分类请求会拿到空结果。
 *  · `value` 为空的项（同上：url 为空）。
 *
 * 导出为纯函数是为了能单测 —— 这个挑选规则很容易在重构时被改坏，而坏掉时
 * 症状是「好源突然全被判校验失败」，很难从界面看出来。
 */
export function pickFirstExploreUrl(
  filters: ReadonlyArray<{
    key: string;
    options: ReadonlyArray<{ name?: unknown; value?: unknown; header?: boolean; kind?: string }>;
  }> | undefined,
): { key: string; value: string; name?: string } | null {
  for (const g of filters ?? []) {
    if (!g || typeof g.key !== 'string' || g.key === '') continue;
    for (const o of g.options ?? []) {
      if (!o || o.header === true) continue;
      // ★ `kind` 缺省视为 url：`FilterOption` 只有在是非 url 控件时才会写 kind
      if (o.kind !== undefined && o.kind !== '' && o.kind !== 'url') continue;
      const v = typeof o.value === 'string' ? o.value.trim() : '';
      if (v === '') continue;
      /**
       * `#694` 顺带把**分类显示名**带出来：工坊时间轴此前只能显示分类 URL
       * （`分类 https://liz04.com/api/v1/topic/lizhi-pic…`，被截断后完全看不出是哪个分类）。
       * 分类名的字段是 `name`（`FilterOption.name`），不是 `title`。
       */
      const n = typeof o.name === 'string' ? o.name.trim() : '';
      return n ? { key: g.key, value: v, name: n } : { key: g.key, value: v };
    }
  }
  return null;
}

/** `#518` 成功重放 HTML 的缓存时长（与失败冷却同量级；正文页内容不会分钟级变化） */
const ANTIBOT_HTML_TTL_MS = 10 * 60_000;
/** 成功缓存条目上限（正文页 ~20KB ⇒ 200 条约 4MB，足够覆盖一本书的回看） */
const ANTIBOT_HTML_MAX = 200;
/** 失败冷却：同一 URL 重放失败后 10 分钟内不再尝试（防打爆渲染额度） */
const ANTIBOT_RETRY_COOLDOWN_MS = 10 * 60_000;
/** `#660` 「这个 host 已过闸」的有效期（也是复用可见页的隐含前提） */
const ANTIBOT_CLEARED_HOST_TTL_MS = 30 * 60_000;

/** `#660` 取 host（用于按 host 记录清关状态）；解析失败给空串（不记录，不影响主流程） */
function hostKeyOf(url: string): string {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * `#642` **本轮撞到、但没能过去的挑战/拦截页**（一次 `run` 内最多记 5 条）。
 *
 * 为什么需要它（`#11` 立案）：撞 CF 之后重放失败 ⇒ 旧实现**静默回退**成原始挑战页，
 * 引擎照常解析 ⇒ 列表 0 条。用户看到的是「这个源没内容」，实际是「站点没让你进门」。
 * 记下来附在响应上（形如 `netTruncated`），服务端据此**开内嵌验证窗**并回 `needVerification`，
 * 前端弹浮层让用户过一次验证（`#482` 已有完整链路，缺的只是这一跳）。
 */
export interface ChallengeHit {
  url: string;
  /** 命中的特征（`isChallengePage` 的 via，或「重放未过盾」） */
  via: string;
  /** 触发那一刻的状态码（preflight 合成拦截时是 403） */
  status: number;
}

/**
 * 挑战页判据会用的「拦截状态码」：`#642` 之前只看 403/503，CF 硬拦截实际常回 404/429/1020。
 * `#705` 补 **468**：SafeLine（雷池 WAF）人机校验页的专有状态码（厂长资源 `www.cz4k.com` 实测，
 * 全站含首页都回 468 + `/.safeline/static/` 挑战页）——不在表里时它走「任意状态」以外的分支，
 * 一个都不命中 ⇒ 拦截页被当正文 ⇒ 列表静默 0 条。
 */
/**
 * `#731` **401 也是 WAF 状态码**（用户实测：阿里云 WAF 回 401 + 1055 字节人机页）。
 *
 * 只加状态码还不够 —— 必须同时命中 `isChallengePage` 的特征（见 `detectWafHit`）：
 * 登录失效一类的 **401 JSON** 没有 WAF 特征，不会被误判成挑战页。
 */
const CHALLENGE_STATUS = new Set([401, 403, 404, 429, 468, 503, 1020]);

/**
 * `#731` **WAF/挑战页判据的唯一实现**（纯函数，便于回归锁）。
 *
 * 三种命中路径：
 *  ① 最终 URL 落在 `waf/verify/captcha/challenge` 路径段（重定向型 WAF，见 `#643`）；
 *  ② `401/403/429/503` + **弱特征**（含阿里云 WAF 专有串）；
 *  ③ 任意状态 + `isChallengePage` 的高特异特征（CF / DDoS-Guard / SafeLine / 阿里云 WAF）。
 *
 * ★ 只看前 2KB（挑战页特征都在头部）；401 JSON 的 `{"code":401,...}` 不会命中任何特征。
 */
export function detectWafHit(input: { status: number; body: string; finalUrl?: string }): {
  hit: boolean;
  via?: string;
  redirectPath?: string;
} {
  const headText = String(input.body ?? '').slice(0, 2048);
  const status = Number(input.status ?? 0);
  const weak =
    /just a moment|cloudflare|安全验证|人机验证|请开启.?javascript|访问验证|captcha|__wafcaptcha|acw_sc__v2|aliyungf_tc|aliyun|访问频率太高|请输入验证码/i.test(
      headText,
    );
  const strong = /just a moment|cf_chl|challenge-platform|cf-browser-verification/i.test(headText);
  const chal = isChallengePage(headText);
  const byStatus = CHALLENGE_STATUS.has(status) && chal.challenge;
  const finalPath = (() => {
    try {
      return new URL(String(input.finalUrl ?? '')).pathname;
    } catch {
      return '';
    }
  })();
  const wafRedirect = /(?:^|\/)(?:waf|verify|captcha|challenge)(?:\/|$)/i.test(finalPath);
  if (wafRedirect) return { hit: true, ...(chal.via ? { via: chal.via } : {}), redirectPath: finalPath };
  if (headText.length === 0) return { hit: false };
  const statusGate = (status === 401 || status === 403 || status === 429 || status === 503) && weak;
  if (!statusGate && !strong && !byStatus) return { hit: false };
  return { hit: true, ...(chal.via ? { via: chal.via } : {}) };
}

export class EngineHub {
  readonly registry = new EngineRegistry();
  readonly sources = new SourceStore();
  /**
   * `#480` **浏览类结果缓存**（home / category）：TTL 120s · 容量 800（超限整表清）。
   * key = `action|sourceId|page|filters`；失效 = 源编辑 / 删除时整表清（低频，简单可靠）。
   */
  private browseCache = new Map<string, { at: number; data: unknown }>();
  /** 清空浏览缓存（源编辑 / 删除 / 导入覆盖时调 —— 规则变了旧结果不能再用） */
  private invalidateBrowseCache(): void {
    this.browseCache.clear();
  }
  private sandbox: JsSandboxPool;
  private webRenderer?: WebRendererHook;
  /** `#676` java.webView(html,url,js) 的宿主通道（见 HubOptions.renderHtmlScript） */
  private renderHtmlScriptHook?: (html: string, baseUrl: string, js: string, sourceId: string) => Promise<string>;
  /** `#727` java.getVerificationCode 的人工输入通道（见 HubOptions.verificationCode） */
  private verificationCodeHook?: (imageUrl: string, sourceId: string) => Promise<string>;
  /** `#481` 反爬自动重放 hook（实现方注入，见 HubOptions.antibotReplay） */
  private antibotReplay?: (url: string, sourceId: string, ctx?: { background?: boolean }) => Promise<{ html: string } | null>;
  /** `#519` 预判 hook（见 HubOptions.antibotPreflight） */
  private antibotPreflight?: (url: string, sourceId: string) => boolean;
  /** `#658` 过闸会话的 UA（见 HubOptions.sessionUaOf） */
  private sessionUaOf?: (sourceId: string) => string | undefined;
  /** `#481` 每 URL 重放去重（10 分钟内同一 URL 只重放一次 —— 防 WAF 页把渲染额度打爆） */
  private antibotTried = new Map<string, number>();
  /**
   * `#518` **成功重放的 HTML 缓存**（key = `sourceId|url`）。
   *
   * 为什么必须有它（用户真机实测立案）：旧实现只有 `antibotTried` 这一道
   * 「每 URL 10 分钟最多重放一次」的护栏，而它把**成功**的那次也记了进去 ⇒
   * 同一章节页的**第二次**请求（回看已读章节 / 点「刷新正文」）直接返回原始 403，
   * 连渲染都不再尝试。表现就是「往后读新章节一路正常，往回读同一章必 403，刷新也没用」——
   * 用户据此怀疑「为什么新章节能拉、旧章节不能」，质疑完全正确：不是源站，是我们自己的闸门。
   */
  private antibotHtml = new Map<string, { html: string; at: number }>();
  /**
   * `#660` **host 级「已经过闸」时间**（key = host，value = 最近一次重放成功的时间）。
   *
   * 用途：**已清关的 host 不再受「每 URL 10 分钟只重放一次」的冷却限制**。
   * 用户实测 138阅读网：正读着书，某章 403 ⇒ 复用/导航可见页本可以立刻取到，
   * 却被 `冷却中，10 分钟内不再重放` 挡回 ⇒ 正文直接失败、还要重过一次闸。
   * 清关会话在手时，重试是**便宜的**（直接读可见页，几乎不花时间），没有理由冷却。
   */
  private antibotClearedHosts = new Map<string, number>();
  /**
   * `#668` **清关的粒度细化到「host + 首段路径」**（`/list/…` 与 `/420/…` 分开记）。
   *
   * 为什么：`#519` 的预检是 host 级 —— 目录页清关过就跳过正文页的直连，多数情况正确，
   * 但正文页有时**并不需要盾**（直连就能拿），被跳过后白等一轮渲染。
   * 现在：段级命中才算「这个路径族确定要重放」；host 级只在**该 host 已有多段命中**时兜底
   * （≥3 段 ⇒ 认定为「整站都有盾」）。
   */
  private antibotClearedSegs = new Map<string, Set<string>>();

  /**
   * `#668` **记一笔「这个 URL 族过了闸」**（host + 首段路径）。
   * 供内部重放成功时调用，也供 server 侧（`antibotPassPage` 成功）调用 —— 清关状态**只有这一份**。
   */
  markCleared(url: string): void {
    const host = hostKeyOf(url);
    if (!host) return;
    this.antibotClearedHosts.set(host, Date.now());
    if (this.antibotClearedHosts.size > 200) this.antibotClearedHosts.clear();
    let seg = '';
    try {
      seg = (new URL(String(url)).pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase();
    } catch {
      seg = '';
    }
    if (!seg) return;
    const set = this.antibotClearedSegs.get(host) ?? new Set<string>();
    set.add(seg);
    this.antibotClearedSegs.set(host, set);
    if (this.antibotClearedSegs.size > 200) this.antibotClearedSegs.clear();
  }

  /**
   * `#668` **预检：这个 URL 是否"确定要重放、别浪费一次直连"**。
   *
   * 判据（从严到宽）：① 同 host 同首段路径清关过 ⇒ true（最准）；
   * ② 该 host 已有 ≥3 个不同路径段清关过 ⇒ true（认定整站有盾）。
   * 只清关过别的段 ⇒ false（让它先直连一次，别为了省事多花一轮渲染）。
   */
  isClearedFor(url: string): boolean {
    const host = hostKeyOf(url);
    if (!host) return false;
    const at = this.antibotClearedHosts.get(host);
    if (!at || Date.now() - at >= ANTIBOT_CLEARED_HOST_TTL_MS) return false;
    let seg = '';
    try {
      seg = (new URL(String(url)).pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase();
    } catch {
      seg = '';
    }
    const set = this.antibotClearedSegs.get(host);
    if (seg && set?.has(seg)) return true;
    return (set?.size ?? 0) >= 3;
  }

  private httpHeaders: Record<string, string>;
  private timeoutMs: number;
  private httpFactory: (opts?: HttpClientScopeOptions) => HttpClient;
  /** `#373` 单个动作的总超时（毫秒），默认 120s —— 见 HubOptions.runTimeoutMs */
  private runTimeoutMs: number;
  /** 源变量（Legado「设置源变量」）：source.getVariable() 读取，按 sourceId 持久（进程内 + storage 落盘） */
  private sourceVariables = new Map<string, string>();
  /**
   * cache 的**内存层**（Legado `CacheManager.putMemory`/`getFromMemory` 的等价物：进程级 LruCache）。
   *
   * 为什么不放 storage：`putMemory` 的语义就是**不落盘**（进程重启即失）。但它必须**跨请求**存活 ——
   * 语料实测 📂小说阅读 在 `ruleBookInfo.init` 里 `cache.putMemory('articleid', id)`，
   * 到 `ruleToc.chapterUrl` 的 `{{cache.getFromMemory('articleid')}}` 里读（详情 → 目录是两次请求）。
   * 所以由 hub 在 `makeContext` 注入、请求结束回写（与 `sourceVariables` 同一节奏）。
   *
   * ⚠️ **全局一份，不按源隔离**（对齐上游：`CacheManager` 的 LRU 是进程级单例）。
   * qyyuapi 系的激活信息（`XHaccount` / `XHtime` / `xhJson`）就是靠这层跨源共享。
   *
   * 持久层（`cache.put/get`）不在这里：它走 ctx.storage（`cache:global`），由引擎 prime/persist。
   */
  private globalMemCache: string | undefined;
  /** 共享存储（宿主可注入文件版实现以获得跨重启持久；缺省内存版） */
  private storage: KeyValueStore;
  /** 源级 Cookie（登录态）：sourceId → {name: value}；server 侧持久化 */
  private sourceCookies = new Map<string, Record<string, string>>();
  /**
   * 登录信息（账号/密码…，Legado `BaseSource.getLoginInfoMap()`）。
   * 免浏览器的 API 登录源靠它：`source.getLoginInfoMap().get("账号")`。
   */
  private sourceLoginInfo = new Map<string, Map<string, string>>();

  constructor(opts: HubOptions = {}) {
    this.sandbox = opts.sandbox ?? noopSandbox;
    this.webRenderer = opts.webRenderer;
    this.renderHtmlScriptHook = opts.renderHtmlScript;
    this.verificationCodeHook = opts.verificationCode;
    this.antibotReplay = opts.antibotReplay;
    this.antibotPreflight = opts.antibotPreflight;
    this.sessionUaOf = opts.sessionUaOf;
    this.httpHeaders = opts.httpHeaders ?? {};
    this.timeoutMs = opts.timeoutMs ?? 60_000; // 对齐 Legado callTimeout=60s（HttpHelper.kt:62；30s 曾把慢站判死）
    this.httpFactory = opts.httpFactory ?? ((o) => createHttpClient(this.httpHeaders, o));
    this.storage = opts.storage ?? createMemoryKeyValueStore();
    this.runTimeoutMs = opts.runTimeoutMs ?? 120_000;
  }

  registerEngine(engine: RuleEngine<unknown, unknown>): this {
    this.registry.register(engine);
    return this;
  }

  /** 导入一份源配置：自动 detect + compile + 入库。返回 id/kind/state。 */
  importSource(
    raw: unknown,
    opts: { preferred?: string; id?: string; state?: SourceState; name?: string } = {},
  ): { id: string; kind: string; name?: string; state: Required<SourceState> } {
    const engine = this.registry.detect(raw, opts.preferred);
    const result = engine.compile(raw);
    if (!result.ok || result.rule === undefined) {
      throw new EngineError('RULE_PARSE', 'validate', {
        engine: engine.kind,
        sourceId: String(opts.id ?? ''),
        input: result.issues,
        trace: [],
      });
    }
    const id = opts.id ?? deriveId(raw, engine.kind);
    const name = opts.name ?? (raw as Record<string, unknown>)['bookSourceName']
      ?? (raw as Record<string, unknown>)['sourceName'] // RSS 订阅源的主名字段（RssSource.kt）
      ?? (raw as Record<string, unknown>)['name']
      ?? (raw as Record<string, unknown>)['apiUrl']
      ?? id;
    // state 优先级：调用方显式传入 > 源自带 state > Legado 原生布尔字段
    // （Legado BookSource 只有 enabled / enabledExplore / enabledCookieJar 三个开关——
    //  数据集里 119 个源声明 enabledExplore:false，此前被忽略 → 这些源仍出现在发现页
    //  并被执行 explore 请求）
    const rawEnabled = (raw as Record<string, unknown>)['enabled'];
    const rawEnabledExplore = (raw as Record<string, unknown>)['enabledExplore'];
    const rawState = (raw as Record<string, unknown>)['state'] as SourceState | undefined;
    const mergedState: SourceState = {
      ...(typeof rawEnabled === 'boolean' ? { enabled: rawEnabled } : {}),
      ...(typeof rawEnabledExplore === 'boolean' ? { exploreEnabled: rawEnabledExplore } : {}),
      ...rawState,
      ...opts.state,
    };
    this.sources.add({ id, kind: engine.kind, name: name as string | undefined, raw, rule: result.rule, state: mergedState });
    return { id, kind: engine.kind, name: name as string | undefined, state: resolveSourceState(mergedState) };
  }

  /**
   * 导入**预览**：解析 + 引擎编译 dry-run + 去重判定，**不写任何状态**。
   *
   * 为什么编译也要在这里跑：解析得出来 ≠ 能入库。源缺 bookSourceUrl / 规则结构不对时
   * `importSource` 会抛 RULE_PARSE —— 如果只在 commit 时才报，用户会看到「预览 29 条、导入 0 条」。
   * 因此把编译失败也计入 `errors`（带原因），预览即最终结果。
   *
   * `#351` 三分类：库里同 id 的条目按**内容是否等价**（`sameSourceRaw`，判据唯一实现）
   * 再拆成 `updatable`（内容变了 ⇒ 会覆盖更新）与 `duplicates`（内容一致 ⇒ 什么都不会变）。
   * UI 据此默认只勾选「新增 + 更新」。
   *
   * 大数据集（数千源、20~30MB）优化：逐条编译是预览的主要成本，故只对前 `COMPILE_SAMPLE`
   * 条做完整编译校验；超出部分仅做了结构解析，先计为可入库，导入时 `importRows` 会逐条编译，
   * 保证最终正确。这样即使粘贴 30MB 文本，预览也能在毫秒级返回，不会卡住服务。
   */
  previewImport(
    input: string | unknown,
    opts: { format?: ImportFormatHint; defaultGroup?: string } = {},
  ): ImportPreview {
    const parsed: ImportParseResult = parseImportText(input, opts);
    const valid: ImportPreviewItem[] = [];
    const updatable: ImportPreviewItem[] = [];
    const duplicates: Array<ImportPreviewItem & { existingName?: string }> = [];
    const errors = [...parsed.errors];

    const COMPILE_SAMPLE = 500;
    const budget = parsed.rows.length > COMPILE_SAMPLE ? COMPILE_SAMPLE : parsed.rows.length;

    parsed.rows.forEach((row, i) => {
      // `#640` 先做老 id 兼容（身份相同 ⇒ 沿用库里原 id），再判「新增/更新/重复」
      const id = this.reuseExistingId(row.id, row.raw);
      const item: ImportPreviewItem = { index: i, id, kind: row.kind, name: row.name, group: row.group };
      const exist = this.sources.get(id);
      if (exist) {
        // 同 id：内容等价 ⇒ 重复（什么都不会变）；内容不同 ⇒ 更新（会覆盖）
        if (sameSourceRaw(row.raw, exist.raw)) duplicates.push({ ...item, existingName: exist.name });
        else updatable.push(item);
        return;
      }
      if (i < budget) {
        const engine = this.registry.get(row.kind);
        if (!engine) {
          errors.push({ index: i + 1, reason: `没有 ${row.kind} 引擎，无法导入「${row.name}」` });
          return;
        }
        const c = engine.compile(row.raw);
        if (!c.ok || c.rule === undefined) {
          const first = (c.issues?.[0] as { message?: string } | undefined)?.message ?? '规则编译失败';
          errors.push({ index: i + 1, reason: `${row.name}：${first}` });
          return;
        }
        valid.push(item);
      } else {
        // 超出采样预算：结构已通过解析，先计为可入库；导入时再逐条编译
        valid.push(item);
      }
    });

    const noteParts = [
      // 显式选了与内容不符的格式时，解析层给的「你该选哪个」提示优先展示
      parsed.hint,
      parsed.rows.length > COMPILE_SAMPLE
        ? `已对前 ${COMPILE_SAMPLE} 条做完整编译校验，其余 ${parsed.rows.length - COMPILE_SAMPLE} 条仅做了结构解析（导入时会逐条编译，确保最终正确）`
        : undefined,
    ].filter((s): s is string => !!s);
    const note = noteParts.length ? noteParts.join('；') : undefined;

    return {
      format: parsed.format,
      parsedTotal: parsed.parsedTotal,
      valid,
      updatable,
      duplicates,
      errors,
      preview: parsed.preview,
      rowCount: parsed.rows.length,
      note,
    };
  }

  /**
   * 批量入库（`rows` 来自 previewImport 的 rows，或再次 parseImportText 的结果）。
   *
   * ## `#351` 自选导入
   * `onlyIndexes`（可选）：**只处理 `rows` 里这些下标的行**（预览页复选框选中的行）。
   * 不传 = 全量（旧行为）。传了之后：
   *  · 不在 `onlyIndexes` 里的行**完全不碰**（既不 insert 也不 overwrite）⇒ 用户「可移除」的语义；
   *  · 命中已存在的 id ⇒ **覆盖更新**（用户勾了它就是要让新版本生效）；
   *  · 命中不存在的 id ⇒ 新增。
   * ⇒ 前端不需要再传 `dedupe`：「勾不勾」本身就是逐条的决定（用户要求
   *   「新增的新增，更新的更新，已有重复的覆盖」= 选中即生效）。
   *
   * ★ 为什么用**下标**不用 id：`importRows` 收到的 `rows` 与 `previewImport` 的
   *   `rows` 是同一份文本解析出来的**同序**结果（两端都调 `parseImportText`），
   *   下标天然对齐；而**同一份文本里可以有两条同 id 的源**（合集文件常见，
   *   `deriveId` 只认 `bookSourceUrl`）—— 用 id 当勾选键那两行会联动，
   *   用户没法只留其中一条。
   *
   * `dedupe`（`skip`/`overwrite`）保留给**不传 `onlyIndexes`** 的旧调用（CLI / 测试 / 兼容）。
   */
  importRows(
    rows: ImportRow[],
    opts: { dedupe?: 'skip' | 'overwrite'; onlyIndexes?: readonly number[] } = {},
  ): {
    inserted: number;
    updated: number;
    skipped: number;
    failed: number;
    results: Array<{ id: string; ok: boolean; name?: string; error?: string; action?: 'inserted' | 'updated' | 'skipped' }>;
  } {
    const dedupe = opts.dedupe ?? 'skip';
    const selected = opts.onlyIndexes ? new Set(opts.onlyIndexes) : null;
    const results: Array<{ id: string; ok: boolean; name?: string; error?: string; action?: 'inserted' | 'updated' | 'skipped' }> = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx]!;
      // 自选导入：没被勾选的行直接跳过（且**不计入 skipped 统计** —— 那是「用户选的重复」的口径，
      // 未勾选是「用户没选」，混在一起会让「已跳过 N 条」莫名变大）
      if (selected && !selected.has(idx)) continue;
      // `#640` 老 id 兼容：身份（bookSourceUrl）相同 ⇒ 沿用库里原 id
      const rowId = this.reuseExistingId(row.id, row.raw);
      const exist = this.sources.get(rowId);
      // 显式选中某行 ⇒ 已存在就覆盖（不再受全局 dedupe 约束）
      const willOverwrite = exist ? (selected ? true : dedupe === 'overwrite') : false;
      if (exist && !willOverwrite) {
        skipped++;
        results.push({ id: rowId, ok: true, name: row.name, action: 'skipped' });
        continue;
      }
      try {
        // 覆盖导入保留用户已改的开关（Legado 导入不改动 enabled 的直觉语义）
        const r = this.importSource(row.raw, {
          id: rowId,
          preferred: row.kind,
          ...(exist ? { state: exist.state } : {}),
        });
        if (exist) {
          updated++;
          results.push({ id: r.id, ok: true, name: r.name, action: 'updated' });
        } else {
          inserted++;
          results.push({ id: r.id, ok: true, name: r.name, action: 'inserted' });
        }
      } catch (e) {
        failed++;
        results.push({ id: rowId, ok: false, name: row.name, error: String(e instanceof Error ? e.message : e).slice(0, 160) });
      }
    }
    return { inserted, updated, skipped, failed, results };
  }

  /**
   * 从目录批量导入（每个 .json 一份源）。
   *
   * ## `#640`：**不再按文件名 `_` 前缀过滤**
   * 原实现是 `!f.startsWith('_')`（本意：跳过 `_index.json` 这类汇总/回归产物），
   * 但 `safeSourceId` 会把**表外字符折成 `_`** ⇒ 中文 `bookSourceUrl` 派生的文件名
   * 天然就是 `____.json` 这种形状 ⇒ **真实源被当成汇总文件静默丢弃**。
   * 实测本仓 `data/sources/book-482` 里有 5 个这样的源从未被加载
   * （`________.json` 七猫四合一本地版、`_____VIP5.0.json` 大灰狼聚合、
   *  `_____2.json` 光遇聚合、90 个下划线的 木里聚合、`____.json` 明月书阁）。
   *
   * 现在改为「**内容即判据**」：能解析且能编译入库的才是源；
   * `_index.json`（`{total,unique,categories}`）与 `_regression_*.json`
   * （`{phase,total,detectOk,…}`）没有源身份字段，`importSource` 编译必抛 ⇒ 自然跳过。
   */
  loadDir(dir: string): Array<{ id: string; kind: string; name?: string }> {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const out: Array<{ id: string; kind: string; name?: string }> = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push(this.importSource(raw, { id: f.replace(/\.json$/, '') }));
      } catch {
        // 坏文件 / 汇总文件 / 非源 JSON：跳过，不阻断其它源
      }
    }
    return out;
  }

  /**
   * `#640` **老 id 兼容**：`deriveId` 给「含 URL 表外字符」的 `bookSourceUrl` 加了指纹之后，
   * 库里的老条目 id 仍是老形态（无指纹）⇒ 只按新派生查重会让用户「再导一次就多一条」。
   * 这里按**源身份**（`bookSourceUrl`）兜一层：身份相同就沿用它原来的 id。
   */
  private reuseExistingId(id: string, raw: unknown): string {
    if (this.sources.has(id)) return id;
    const found = this.sources.idForIdentity(sourceIdentity(raw));
    return found && this.sources.has(found) ? found : id;
  }

  /** 列出源（可按 kind / enabled 过滤） */
  listSources(filter?: { kind?: string; enabled?: boolean }): HubSource[] {
    return this.sources.list(filter);
  }

  /** 用户修改开关（Web/CLI 调用） */
  setSourceState(id: string, partial: SourceState): HubSource | undefined {
    return this.sources.setState(id, partial);
  }

  /**
   * 校验失败落标记（对齐 App 端习惯）：
   *  - bookSourceComment 追加 `//error:<message>`（同一行多次校验去重，只保留最近一条）
   *  - bookSourceGroup 追加「校验失败」标签（Legado 分组是逗号分隔多值，追加便于筛选）
   */
  private markVerifyFailure(id: string, message: string): void {
    const s = this.sources.get(id);
    if (!s) return;
    const raw = { ...(s.raw as Record<string, unknown>) };
    const errTag = `//error:${message.slice(0, 200)}`;
    const oldComment = typeof raw['bookSourceComment'] === 'string' ? (raw['bookSourceComment'] as string) : '';
    const stripped = oldComment.replace(/\/\/error:[^\n]*/g, '').replace(/\s+$/, '');
    raw['bookSourceComment'] = (stripped ? stripped + '\n' : '') + errTag;
    const oldGroup = typeof raw['bookSourceGroup'] === 'string' ? (raw['bookSourceGroup'] as string) : '';
    if (!oldGroup.split(',').some((g) => g.trim() === '校验失败')) {
      raw['bookSourceGroup'] = oldGroup ? oldGroup + ',校验失败' : '校验失败';
    }
    try {
      this.replaceSource(id, raw);
    } catch {
      // 规则编译失败时保留原 raw（标记以原样回写原始 JSON，不重编译）
      (s as { raw: unknown }).raw = raw;
    }
  }

  /** 校验通过后清除历史失败标记（注释去 //error 行、分组去「校验失败」标签） */
  private clearVerifyMark(id: string): void {
    const s = this.sources.get(id);
    if (!s) return;
    const raw = { ...(s.raw as Record<string, unknown>) };
    const oldComment = typeof raw['bookSourceComment'] === 'string' ? (raw['bookSourceComment'] as string) : '';
    const oldGroup = typeof raw['bookSourceGroup'] === 'string' ? (raw['bookSourceGroup'] as string) : '';
    const hasMark = oldComment.includes('//error:') || oldGroup.split(',').some((g) => g.trim() === '校验失败');
    if (!hasMark) return;
    raw['bookSourceComment'] = oldComment.replace(/\s*\/\/error:[^\n]*/g, '').replace(/^\n+/, '');
    raw['bookSourceGroup'] = oldGroup
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g && g !== '校验失败')
      .join(',');
    try {
      this.replaceSource(id, raw);
    } catch {
      (s as { raw: unknown }).raw = raw;
    }
  }

  /**
   * 编辑源：用新的 raw 替换并重新 detect + compile（M5 源编辑）。
   * id 保持不变；编译失败抛 RULE_PARSE，调用方可回滚显示。
   */
  replaceSource(
    id: string,
    raw: unknown,
  ): { id: string; kind: string; name?: string; state: Required<SourceState> } {
    const old = this.sources.get(id);
    if (!old) throw new EngineError('SOURCE_NOT_FOUND', 'validate', { engine: '-', sourceId: id, trace: [] });
    const engine = this.registry.detect(raw, old.kind);
    const result = engine.compile(raw);
    if (!result.ok || result.rule === undefined) {
      throw new EngineError('RULE_PARSE', 'validate', {
        engine: engine.kind,
        sourceId: id,
        input: result.issues,
        trace: [],
      });
    }
    const name =
      (raw as Record<string, unknown>)['bookSourceName']
      ?? (raw as Record<string, unknown>)['name']
      ?? (raw as Record<string, unknown>)['apiUrl']
      ?? old.name;
    this.sources.replace(id, raw, result.rule, engine.kind, name as string | undefined);
    this.invalidateBrowseCache(); // `#480` 规则变了，旧浏览结果不能再命中
    return { id, kind: engine.kind, name: name as string | undefined, state: old.state };
  }

  /** 删除源（M5 源管理） */
  removeSource(id: string): boolean {
    const ok = this.sources.remove(id);
    if (ok) this.invalidateBrowseCache(); // `#480`
    return ok;
  }

  /**
   * **彻底清理某个源的运行时数据**（删源时调用 —— 交接文档 §4.8d 缺口 A）。
   *
   * ## 清哪些（键名已逐个核实）
   * · 内存态：`sourceVariables` / `sourceLoginInfo` / `sourceCookies`；
   * · 持久态：`LOGIN_INFO_PREFIX<id>`（登录信息）、`LOGIN_HEADER_PREFIX<id>`（登录头），
   *   外加 `extraKeys`（引擎的源级键 `source-var:` / `source-kv:`，
   *   由 `sourceStorageKeys()` 提供 —— 见其注释：不让调用方拼字符串，否则前缀会漂移）。
   *
   * ⚠️ **cache 不清**：`CacheManager` 是全局的（`cache:global` 持久层 + `globalMemCache` 内存层），
   * 删一个源不该影响别的源还在用的缓存（上游删源也不清 CacheManager）。
   *
   * ## 为什么必须有
   * 旧实现删源只做 `sources.remove(id)`（一句 `map.delete`）⇒ 上面这些**全部残留**，
   * 症状是「删掉源、过几天重新导入同一个源，**旧登录态与变量复活**」。
   *
   * ## 与「回收站」的关系（用户 2026-09-25 决策）
   * 源定义仍走**软删除**（墓碑 + 「恢复已删除」可选中恢复），但**数据不还原** ——
   * 恢复后需重新登录/重新设置。所以这里清数据是**预期行为**，不是副作用。
   *
   * @param extraKeys 引擎侧源级键（服务端传 `sourceStorageKeys(id)`）；省略则只清登录类数据
   * @returns 实际执行过 delete 的键列表（便于验证与留痕）
   */
  async purgeSourceData(sourceId: string, extraKeys: string[] = []): Promise<string[]> {
    // ① 内存态：不清这层，本进程内后续请求仍能读到「已删除源」的旧值
    this.sourceVariables.delete(sourceId);
    this.sourceLoginInfo.delete(sourceId);
    this.sourceCookies.delete(sourceId);
    // ② 持久态
    const keys = [`${LOGIN_INFO_PREFIX}${sourceId}`, `${LOGIN_HEADER_PREFIX}${sourceId}`, ...extraKeys];
    const cleared: string[] = [];
    for (const k of keys) {
      try {
        await this.storage.delete(k);
        cleared.push(k);
      } catch {
        /* 单键失败不阻断其余 —— 返回列表里少了哪个一目了然（不静默） */
      }
    }
    return cleared;
  }

  /**
   * 批量静态校验（M5）：对全部已导入源跑引擎的 validate，返回逐源结果。
   * validate 未实现的引擎视为通过（issues 为空）。
   */
  validateAll(): {
    total: number;
    okCount: number;
    failedCount: number;
    results: Array<{ id: string; kind: string; name?: string; ok: boolean; issues: unknown[] }>;
  } {
    const results: Array<{ id: string; kind: string; name?: string; ok: boolean; issues: unknown[] }> = [];
    for (const s of this.sources.list()) {
      const engine = this.registry.get(s.kind);
      const issues = engine?.validate ? engine.validate(s.rule) : [];
      const ok = issues.every((i) => i.level !== 'error');
      results.push({ id: s.id, kind: s.kind, name: s.name, ok, issues });
    }
    return {
      total: results.length,
      okCount: results.filter((r) => r.ok).length,
      failedCount: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /**
   * @param background `#496` 后台任务标记（书架定时更新等）⇒ 撞 WAF 时**不起有头**，
   *   由 `antibotReplay(url, sourceId, { background })` 透传给实现方。
   * @param challenges `#642` 本轮「撞了挑战页但没过去」的收集槽（只有 `run()` 传；
   *   其它通路传 undefined ⇒ 零开销、零行为变化）。
   */
  private makeContext(
    sourceId: string,
    scope?: HttpClientScopeOptions,
    externalSignal?: AbortSignal,
    background = false,
    challenges?: ChallengeHit[],
    /**
     * `#696` 本次 run 的 trace 订阅（调试信息流）。
     * 只有「全链试跑」会传 —— 引擎侧 `dlog()` 写的每一条都从这里流出去。
     */
    onTrace?: (e: { at: number; msg?: string; level?: 'info' | 'warn' | 'error' }) => void,
    /** `#769` 本动作的行动预算（毫秒）；缺省 = `HubOptions.timeoutMs`（detail 用 75s，见常量注释） */
    budgetMs?: number,
    /** `#779` 本动作的纯计算求值预算（毫秒）；只有 content 传（默认 20s），缺省 = worker 池默认 10s */
    jsComputeTimeoutMs?: number,
  ): EngineContext {
    // `#769` 行动预算：detail = 75s（目录多页 + 首屏冻结），其余 = timeoutMs
    const budget = Math.max(1, budgetMs ?? this.timeoutMs);
    const variables = createVariableStore();
    // 注入源变量（Legado source.getVariable() 读取）
    const sv = this.sourceVariables.get(sourceId);
    if (sv !== undefined) variables.set('sourceVariable', sv);
    /**
     * `#658` 过闸会话的 UA 注入（见 HubOptions.sessionUaOf）。
     * 只在**有清关会话**时存在；引擎的 `getSourceHeaders` 见到它就覆盖源 header 的 UA ——
     * 因为 `cf_clearance` 与 UA 绑定，不换 UA 等于白拿 Cookie。
     */
    const sessionUa = this.sessionUaOf?.(sourceId);
    if (sessionUa) variables.set('__sessionUa', sessionUa);
    // 注入 cache 内存层（`cache.putMemory` 的落点；全局一份，持久层由引擎从 storage prime）
    const mc = this.globalMemCache;
    if (mc !== undefined) variables.set('__memCache', mc);
    // ★ `#321` 源级限频：源 `concurrentRate` 非空 ⇒ 给本次 run 的 `ctx.http` 包一层
    //   「拿名额再发请求」。上游对每次 AnalyzeUrl 请求都过 `ConcurrentRateLimiter.withLimit`
    //   （AnalyzeUrl.kt:449/:577）；这里一处包闸即覆盖三引擎的直连请求与 worker `java.ajax`
    //   （引擎把 `ctx.http` 传入求值器的 http 钩子）。等待发生在**占流量闸门槽位之前**，
    //   不会占着全局/域名槽位干等。L1 同步路径（curl）不在此列——见 concurrent-rate.ts 头注释。
    const rawRate = (this.sources.get(sourceId)?.raw as { concurrentRate?: unknown } | undefined)?.concurrentRate;
    /**
     * `#428`（`D12`=A，用户 2026-10-12 拍板）**按源忽略 TLS 校验**的**唯一接线点**。
     *
     * 源的 `state.allowInsecureTls`（源管理里的开关，缺省 false）为真 ⇒ 给本次 run 的每个请求
     * 注入该选项（`core` 侧据此换用 `rejectUnauthorized:false` 的 dispatcher，
     * 见 `net-agent.insecureTlsDispatcher`）。
     * ★ 在这里接线而不是让引擎各自传：三引擎 + worker `java.ajax` 全部经 `ctx.http`，
     *   一处包住即全覆盖（与上面的 `concurrentRate` 同一手法）。
     */
    const insecureTls = this.sources.get(sourceId)?.state?.allowInsecureTls === true;
    const baseHttp = this.httpFactory(scope);
    const innerHttp: HttpClient = insecureTls
      ? { request: (url, opts) => baseHttp.request(url, { ...opts, allowInsecureTls: true }) }
      : baseHttp;
    const http0: HttpClient = parseConcurrentRate(rawRate)
      ? {
          request: async (url, opts) => {
            await acquireConcurrentSlot(sourceId, rawRate);
            return innerHttp.request(url, opts);
          },
        }
      : innerHttp;
    /**
     * `#481` **反爬自动重放**：撞 403/503 且响应体带 WAF 特征（cloudflare 挑战页 /
     * 人机验证 / 请开启 JavaScript…）⇒ 调宿主注入的 `antibotReplay`（= CDP 常驻会话渲染）
     * 把渲染 HTML 当作本次响应；cookie 回收由 hook 实现方负责（server 侧 merge 进源 CookieJar）。
     * 护栏：每 URL 10 分钟只重放一次（防 WAF 页打爆渲染额度）；重放失败/不可用 ⇒ 原响应原样返回。
     *
     * `#642` 重放失败时**不再静默**：把「这个 URL 没过去」记进 `challenges`（见 ChallengeHit），
     * 由 `run()` 附在响应上 ⇒ 服务端开内嵌验证窗、前端弹浮层（`#482` 链路）。
     */
    const antibot = this.antibotReplay;
    /** `#519` 见 HubOptions.antibotPreflight */
    const preflight = this.antibotPreflight;
    /**
     * **脚本资源**（jsLib / exploreUrl）：URL 以 `.js` / `.mjs` / `.cjs` 结尾。
     *
     * 引擎下载脚本时同样会撞 WAF，于是走到 `tryReplay` —— 但浏览器打开脚本 URL 只会渲染出
     * 一层「文本阅读器」文档（`<html>…<pre>源码</pre>…`）。若把这层 DOM 当脚本正文返回，
     * 预编译就是 `Unexpected token '<'`，而且这份 HTML 还会被写进 jsLib 镜像/持久层，
     * 让后续每次启动都复用污染内容（MYCOMIC / Komiic / 热辣漫画 三源实测）。
     * 所以脚本请求只接受**原文**，渲染结果是 HTML 文档时必须丢弃。
     */
    const isScriptRequest = (u: string): boolean => {
      try {
        return /\.(?:m?js|cjs)$/i.test(new URL(u).pathname);
      } catch {
        return /\.(?:m?js|cjs)(?:[?#]|$)/i.test(u);
      }
    };
    /** 渲染结果是不是 HTML/XML 文档（而不是脚本原文）；`<!--` 这类合法 JS 注释开头不算 */
    const isMarkupBody = (s: unknown): boolean => {
      const t = String(s ?? '').trimStart().slice(0, 200).toLowerCase();
      return t.startsWith('<!doctype html') || t.startsWith('<html') || t.startsWith('<?xml');
    };
    /** 脚本请求 + 渲染成 HTML ⇒ 记一条日志并丢弃（不写成功缓存、不触发人工验证窗） */
    const rejectScriptHtml = (u: string, html: unknown, from: string): boolean => {
      if (!isScriptRequest(u) || !isMarkupBody(html)) return false;
      console.warn(
        `[hub] ${from}把脚本渲染成了 HTML 文档（非脚本原文），已丢弃：${sourceId} · ${String(u).slice(0, 100)}`,
      );
      return true;
    };
    /**
     * `#642` 记一条「撞了挑战页且没过去」。去重 + 上限 5 条：一次 run 只会拿第一条去开验证窗，
     * 其余只是日志证据（有的源一次发现页要请求好几个 URL）。
     */
    const noteChallenge = (url: string, via: string, status: number): void => {
      if (!challenges || challenges.length >= 5) return;
      const u = String(url ?? '');
      if (challenges.some((c) => c.url === u)) return;
      challenges.push({ url: u, via, status });
      console.warn(`[hub] 挑战页未过盾 ⇒ 需人工验证：${sourceId} · ${via} · ${u.slice(0, 100)}`);
    };
    const http: HttpClient = !antibot
      ? http0
      : {
          request: async (url, opts) => {
            /**
             * **重放 + 成功缓存 + 失败冷却**（`#481` / `#518` / `#519` 的唯一实现）。
             * `fallback` = 没有重放机会时要返回的「原响应」（preflight 分支下是合成的 403 占位）。
             * @param via 已判定的挑战特征；preflight 分支没有响应体可扫，故可省。
             */
            const tryReplay = async (fallback: HttpResponse, via?: string): Promise<HttpResponse> => {
              const key = `${sourceId}|${url}`;
              /**
               * 收窄复查用的特征：`via` 不是已知特征名（如 preflight 合成拦截）时得到空串 ⇒
               * `isChallengePage(html, '')` 走全量判据（见 core 的 onlyVia 说明）。
               */
              const chalVia = via ?? isChallengePage(String(fallback.body ?? '')).via;
              const giveUp = (why: string): HttpResponse => {
                // `#731` 一条链路一条日志的最后一格：识别为 WAF → 尝试过闸 → **仍失败**
                console.warn(`[hub] WAF 仍失败（${why}）：${sourceId} · ${String(url).slice(0, 90)}`);
                /**
                 * 脚本（jsLib / exploreUrl）不是「需要人工验证的页面」：
                 * 把它记进 challenges 只会让前端/服务端打开验证窗并导航到 `.js` URL
                 * （用户实测：chromium 停在 `qyyuapi.com/sy/js/…` 上）。脚本失败按原响应返回，
                 * 交给引擎的镜像兜底 / 「请手动下载」提示。
                 */
                if (!isScriptRequest(String(url))) {
                  noteChallenge(url, chalVia || `挑战/拦截页（${why}）`, Number(fallback.status ?? 0));
                }
                return fallback;
              };
              /**
               * **脚本资源（jsLib / exploreUrl / rule*.js）：本地镜像优先于浏览器重放**。
               *
               * 浏览器打开 `.js` 只会渲染出「文本阅读器」DOM，下面 `rejectScriptHtml` 必然丢弃
               * ⇒ 重放除了拉起一次 Chromium（3~6s、窗口在用户屏幕上闪一下）没有任何产出。
               * 用户 2026-11-26 实测：qyyuapi 系每个 `rule*.js` 都在 chromium 里打开过。
               *
               * 所以脚本请求先在 `data/jslib-mirror` 找（网络已经失败过一次了，与「网络优先 →
               * 镜像兜底」的既有顺序一致）；命中就直接当 200 返回，拉都不拉浏览器。
               * 未命中仍走原来的重放（有的环境 renderer 能返回脚本原文），失败再交引擎提示手动下载。
               */
              if (isScriptRequest(String(url))) {
                const mirror = readJsMirror(String(url), { reason: 'WAF/403（脚本）' });
                if (mirror) {
                  console.log(
                    `[hub] 脚本走本地镜像（跳过浏览器重放）：${sourceId} · ${String(url).slice(0, 110)}`,
                  );
                  return { ...fallback, status: 200, headers: {}, body: mirror.text, stream: undefined } as HttpResponse;
                }
              }
              /**
               * `#518` **先查成功缓存**：同一章节页在 TTL 内再次被请求（回看 / 刷新正文）时，
               * 直接返回上次渲染好的 HTML —— 不再被「只重放一次」挡成 403，也不用再等
               * 6.5s 的 CF 挑战。
               */
              const cached = this.antibotHtml.get(key);
              if (cached) {
                /**
                 * `#668` **命中也要校验内容**：TTL 内站点可能改版/重新立起闸，
                 * 缓存里那份如果已经是挑战页（或空壳），再返回它等于「用旧结果骗自己」。
                 * 判据复用 core 的 `isChallengePage`（唯一实现）。
                 */
                const fresh = Date.now() - cached.at < ANTIBOT_HTML_TTL_MS;
                const bad = !cached.html || cached.html.length < 500 || isChallengePage(cached.html).challenge;
                if (fresh && !bad && !rejectScriptHtml(String(url), cached.html, 'antibot-replay 缓存')) {
                  return { ...fallback, status: 200, headers: {}, body: cached.html, stream: undefined } as HttpResponse;
                }
                this.antibotHtml.delete(key);
              }
              const last = this.antibotTried.get(key);
              /**
               * `#660` 已清关的 host 不受「每 URL 10 分钟冷却」限制（原因见 antibotClearedHosts 注释）。
               * 冷却本来是为了「别把 WAF 页打爆渲染额度」；清关后重试只读可见页，额度几乎不花。
               */
              const hostClearedAt = this.antibotClearedHosts.get(hostKeyOf(url));
              const hostCleared = !!hostClearedAt && Date.now() - hostClearedAt < ANTIBOT_CLEARED_HOST_TTL_MS;
              if (!hostCleared && last && Date.now() - last < ANTIBOT_RETRY_COOLDOWN_MS) {
                return giveUp('冷却中，10 分钟内不再重放');
              }
              // 占位：同一 URL 的并发请求不要各起一次渲染（成功后立刻删除，语义见下）
              this.antibotTried.set(key, Date.now());
              if (this.antibotTried.size > 500) this.antibotTried.clear();
              try {
                const hit = await antibot(url, sourceId, { background });
                if (!hit?.html) {
                  console.warn(`[hub] antibot-replay 无结果（渲染返回空）：${sourceId} · ${String(url).slice(0, 100)}`);
                  return giveUp('渲染返回空');
                }
                if (rejectScriptHtml(String(url), hit.html, 'antibot-replay ')) {
                  // 不是「需要人工验证」的页面，别把 .js URL 丢进验证窗；让引擎按原响应走镜像兜底
                  this.antibotTried.delete(key);
                  return fallback;
                }
                // 低频事件 ⇒ 直接留痕到日志（铁律 3：兜底必须留痕）
                console.log(`[hub] antibot-replay：${sourceId} · ${String(url).slice(0, 120)} · 渲染 ${hit.html.length} 字节`);
                /**
                 * ★ **成功 ⇒ 解除失败冷却 + 写成功缓存**（`#518`）。
                 * 旧实现把成功也留在 `antibotTried` 里 ⇒ 「成功过的 URL 10 分钟内不许再渲染」
                 * ⇒ 回看/刷新必 403。
                 */
                this.antibotTried.delete(key);
                this.antibotHtml.set(key, { html: hit.html, at: Date.now() });
                // `#660` 记一笔「这个 host 过闸了」⇒ 后续同 host 的 URL 不再被冷却挡住
                this.markCleared(url);
                if (this.antibotHtml.size > ANTIBOT_HTML_MAX) {
                  const oldest = this.antibotHtml.keys().next().value;
                  if (oldest !== undefined) this.antibotHtml.delete(oldest);
                }
                /**
                 * `#642` 渲染回来了、但**仍是挑战页**（自定义 hook 没做这一步复查时）：
                 * 照旧把 HTML 交给引擎（不假装成功也不吞掉），只是额外记一笔「还没过盾」。
                 * ★ 复查必须收窄到「当初命中的那条特征」（`#564`）：过盾后的正文常残留
                 *   CF 的 `challenge-platform` 脚本引用，全量复查会把**成功**判成失败。
                 */
                if (chalVia && isChallengePage(hit.html, chalVia).challenge) {
                  noteChallenge(url, chalVia, 200);
                }
                return { ...fallback, status: 200, headers: {}, body: hit.html, stream: undefined } as HttpResponse;
              } catch (e) {
                // ⚠️ 不能静默：首版 catch{} 吞掉了渲染失败，表现为「点击源没有任何响应」
                console.warn(
                  `[hub] antibot-replay 失败：${sourceId} · ${String(url).slice(0, 100)} · ${e instanceof Error ? e.message : e}`,
                );
                return giveUp(`重放异常：${e instanceof Error ? e.message : String(e)}`);
              }
            };

            /**
             * `#519` **已清关 host 直接渲染**：跳过那次必然 403 的 HTTP 往返。
             * 实证（13txt）：Node `fetch` 与 curl 同 URL/UA/Cookie 时前者恒 403（TLS 指纹）
             * ⇒ 对这类 host，先发 HTTP 只是白付 ~200ms。
             */
            if (preflight?.(String(url), sourceId) === true) {
              if (process.env['YUEDU_ANTIBOT_DEBUG']) {
                console.log(`[antibot-preflight] 跳过 HTTP 直连：${String(url).slice(0, 100)}`);
              }
              return tryReplay({ status: 403, headers: {}, body: '', url: String(url) });
            }

            const resp = await http0.request(url, opts);
            if (process.env['YUEDU_ANTIBOT_DEBUG']) {
              console.log(
                `[antibot-check] ${resp.status} bodyLen=${typeof resp.body === 'string' ? resp.body.length : typeof resp.body} stream=${resp.stream ? 'y' : 'n'} url=${String(url).slice(0, 80)}`,
              );
            }
            /**
             * 判据（`#481`，13txt.net 实测校准）：CF 挑战页有三种形态 —— 403 / 503 / **200+JS 关卡**。
             *  · 403/503 + 弱特征（captcha/安全验证等普通词也认）⇒ 重放；
             *  · 任意状态 + **CF 专属强特征** ⇒ 重放；
             *  · `#642` **拦截状态码 + 高特异挑战特征** ⇒ 重放（见下）。
             * 只看前 2KB（挑战页特征都在头部）。
             */
            const headText = String(resp.body ?? '').slice(0, 2048);
            /**
             * `#731` 判据统一走纯函数 `detectWafHit`（`#642` 的「拦截状态码 + 高特异特征」、
             * `#643` 的「最终 URL 落在 waf/verify 路径」两格都已收进去，401 + 阿里云 WAF 也认）。
             * `chal` 只用于「过盾后复查」与日志里的特征名，不再在这里手写状态门组合。
             */
            const chal = isChallengePage(headText);
            const det = detectWafHit({
              status: Number(resp.status ?? 0),
              body: String(resp.body ?? ''),
              finalUrl: String(resp.url ?? url),
            });
            /**
             * **脚本的「403 空体」也要过闸**：qyyuapi 系 jsLib 对 Node/curl 常直接回
             * `403 + 0 字节`（TLS 指纹，无任何挑战页特征），`detectWafHit` 认不出来；
             * 但浏览器能正常加载（热辣漫画 / 漫画柜 / Komiic / 拷贝漫画 / MYCOMIC 五源实测）。
             * 脚本只可能是 JS：这类 403 直接交给过闸重放，拿回响应原文后再写镜像。
             * 非脚本 URL 维持原判据（空体 403 不重放，避免误把普通鉴权失败打进浏览器）。
             */
            const scriptBlocked = !det.hit && isScriptRequest(String(url)) && !headText && Number(resp.status) === 403;
            if (!det.hit && !scriptBlocked) return resp;
            // 一条链路一条日志：识别为 WAF ⇒（下面 tryReplay 的 antibot-replay / 验证窗）⇒ 仍失败
            console.warn(
              `[hub] 识别为 WAF（status=${resp.status}${det.via ? ` · ${det.via}` : ''}${det.redirectPath ? ` · ${det.redirectPath}` : ''}）⇒ 尝试静默过闸：${sourceId} · ${String(url).slice(0, 90)}`,
            );
            if (det.redirectPath && !chal.challenge) {
              // 低频事件留痕：内容判据没认出，是**最终 URL**认出来的（下次别再漏这一格）
              console.log(`[hub] 撞 WAF 验证页（按最终 URL 判定）：${sourceId} · ${det.redirectPath.slice(0, 90)}`);
            }
            return tryReplay(resp, chal.challenge ? chal.via : 'WAF 验证页（重定向）');
          },
        };
    return {
      reqId: `${sourceId}@${Date.now()}`,
      sourceId,
      // ★ `#480`：ctx.signal = 「行动预算超时 ∪ 外部中断」—— 客户端断连（用户切走）时引擎在途
      //   抓取立即停止（HttpClient 全部接 signal，见 net/index.ts）。AbortSignal.any 是 Node ≥20。
      //   `#769`：预算是按动作给的（detail 75s / 其余 timeoutMs），单次请求的下限不能反过来突破它。
      signal: externalSignal
        ? AbortSignal.any([AbortSignal.timeout(budget), externalSignal])
        : AbortSignal.timeout(budget),
      // 行动预算的**绝对截止时刻**：引擎据此把每个请求的超时压进剩余预算（见 EngineContext.deadlineAt）
      deadlineAt: Date.now() + budget,
      // `#779` content 的纯计算求值预算（不传 ⇒ 引擎不覆盖，worker 池默认 10s）
      ...(jsComputeTimeoutMs ? { jsComputeTimeoutMs } : {}),
      http,
      sandbox: this.sandbox,
      // `#453`（D13 = A+B）：把**源身份**随渲染请求下发 —— 渲染层据此选中该源的常驻浏览器会话。
      // ★ 这里是唯一注入点：`sourceId` 本就在作用域里，三引擎 / worker 池的 `webRenderer(url, opts)`
      //   调用一个字都不用改（聚合 / 换源各自的 ctx 也会自动带上正确的 sourceId）。
      webRenderer: this.webRenderer ? (url, opts) => this.webRenderer!(url, { ...opts, sourceId }) : undefined,
      // `#676` java.webView(html,url,js) → 宿主真浏览器（同样把 sourceId 带上，复用该源的会话）
      renderHtmlScript: this.renderHtmlScriptHook
        ? (h: string, b: string, j: string) => this.renderHtmlScriptHook!(h, b, j, sourceId)
        : undefined,
      /** `#727` java.getVerificationCode → 宿主拉起/复用该源浏览器并等人工输入（sourceId 同处注入） */
      verificationCode: this.verificationCodeHook
        ? (imageUrl: string) => this.verificationCodeHook!(imageUrl, sourceId)
        : undefined,
      /**
       * `#658` **渲染撞盾 ⇒ 走宿主的过闸通道**（发现页/详情页带 `{"webView":true}` 的源）。
       *
       * 反爬重放（`antibotReplay`）原本只挂在 `ctx.http` 上 —— `webView` 渲染那条路绕过 HTTP，
       * 撞了 Cloudflare 也不会重放、更不会开验证窗（刺猬书库 / Aff 实测）。这里把它接到渲染出口。
       *
       * 复用 HTTP 侧同一套护栏：成功缓存（`antibotHtml`，TTL 内直接给上次渲染好的 HTML）、
       * 每 URL 冷却（`antibotTried`，防 WAF 页打爆渲染额度）、后台任务不起有头（由
       * `antibotReplay` 实现方决定，见 `#496`）。
       */
      renderChallenge: antibot
        ? async (url, _html, via) => {
            /**
             * `#667` **键必须与 HTTP 路径一致**（`${sourceId}|${url}`）。
             * 之前这里只用 `url` ⇒ 两条路的 `antibotHtml`/`antibotTried` 互不命中：
             * 同一 URL 会被重放两次（一次从 webView 来、一次从 HTTP 来），
             * 而且跨源同 URL 还会互相污染缓存。
             */
            const key = `${sourceId}|${url}`;
            const cached = this.antibotHtml.get(key);
            if (cached && Date.now() - cached.at < ANTIBOT_HTML_TTL_MS) {
              if (rejectScriptHtml(String(url), cached.html, 'render-challenge 缓存')) {
                this.antibotHtml.delete(key);
              } else {
                return cached.html;
              }
            }
            const last = this.antibotTried.get(key);
            const clearedAt = this.antibotClearedHosts.get(hostKeyOf(key));
            const hostCleared = !!clearedAt && Date.now() - clearedAt < ANTIBOT_CLEARED_HOST_TTL_MS;
            if (!hostCleared && last && Date.now() - last < ANTIBOT_RETRY_COOLDOWN_MS) return undefined;
            this.antibotTried.set(key, Date.now());
            if (this.antibotTried.size > 500) this.antibotTried.clear();
            if (via) console.warn(`[hub] 无头渲染撞盾（${via}）⇒ 走有头重放：${sourceId} · ${key.slice(0, 100)}`);
            try {
              /**
               * `#731` **传纯 `url`，不是缓存键 `key`**：`key` 是 `${sourceId}|${url}` 的复合标识，
               * 传给 `antibotReplay` 会被当成导航地址 ⇒ Chromium 报
               * `Cannot navigate to invalid URL`、窗口停在空白页（用户 3000 日志的真实现象）。
               * `key` 只用于本地的 `antibotHtml` / `antibotTried` 缓存。
               */
              const hit = await antibot(url, sourceId, { background });
              if (!hit?.html) return undefined;
              if (rejectScriptHtml(String(url), hit.html, 'render-challenge ')) {
                this.antibotTried.delete(key);
                return undefined;
              }
              this.antibotHtml.set(key, { html: hit.html, at: Date.now() });
              this.markCleared(url);
              return hit.html;
            } catch (e) {
              console.warn(`[hub] render-challenge 重放失败：${sourceId} · ${key.slice(0, 100)} · ${e instanceof Error ? e.message : e}`);
              return undefined;
            }
          }
        : undefined,
      trace: createTraceSink(onTrace ? { onEntry: onTrace } : {}),
      variables,
      // ★ 共享同一个 storage 实例：源变量 / 发现页输入（infoMap）等「按源状态」必须跨请求存活。
      //   （此前每请求 new 一个内存 store → 状态请求结束即丢：切换分组后再点二级控件又跳回默认）
      storage: this.storage,
      cookies: this.makeCookieStore(sourceId),
      ...(this.sourceLoginInfo.has(sourceId) ? { loginInfo: this.sourceLoginInfo.get(sourceId)! } : {}),
    };
  }

  /**
   * 把一次求值写进 ctx 的「按源状态」回写到 hub 的**内存映射**，供**下次请求**的
   * `makeContext` 注入（storage 落盘由引擎侧 `persistSourceVariable` 完成）。
   *
   * ⚠️ **唯一实现**：`run()` 与 `login()` 两条通路共用（`#354`）。
   *   · `run()`   —— 搜索/详情/目录/正文/发现（七猫分组、发现页交互控件都靠它）；
   *   · `login()` —— 源登录/按钮动作（禁漫天堂「切换国际线路」只改源变量）。
   *
   * 为什么 `login()` 也必须回写：登录按钮动作**只改源变量**（`source.setVariable`）。
   * 引擎虽已把它落盘到 storage，但 `makeContext` 注入的是**内存映射**（`this.sourceVariables`）。
   * 修前 `login()` 直接 `return engine.login(...)` 不回写 ⇒ 同一进程内下一次请求的
   * `makeContext` 注入的是旧值；虽然引擎 `primeSourceVariable` 会从 storage 读回覆盖，
   * 但那是「依赖下游补救」——一旦下游某路径不 prime（或 storage 读失败），
   * 用户就会看到「选了线路但分类没变」。两条通路写同一份状态必须同一处（铁律：同一判据别写两处）。
   */
  private syncSourceStateFrom(ctx: EngineContext, sourceId: string): void {
    try {
      const cur = ctx.variables.get('sourceVariable');
      if (typeof cur === 'string' && cur && cur !== this.sourceVariables.get(sourceId)) {
        this.sourceVariables.set(sourceId, cur);
      }
      // cache 内存层回写（`cache.putMemory` 的写入要在下一次请求可见；与上面同一节奏）
      // ⚠️ 全局一份（不按源）：对齐 Legado `CacheManager` 的进程级 LRU 语义
      const mc = ctx.variables.get('__memCache');
      if (typeof mc === 'string' && mc !== this.globalMemCache) {
        this.globalMemCache = mc;
      }
    } catch {
      /* 同步内存映射失败不影响本次响应（下次请求顶多少一次注入） */
    }
  }

  /** 源级 Cookie 存储（引擎请求头注入 + java cookie 桩透传） */
  private makeCookieStore(sourceId: string): CookieStore {
    /**
     * ★★ `#483`：**每次取实时 map，不在闭包里抓快照**。
     *
     * 旧实现 `const map = this.sourceCookies.get(sourceId) ?? {}` 在「该源还没有 cookie」时抓到
     * 一个**游离**的 `{}`（未登记进 `sourceCookies`）；随后 `#481` 反爬重放回收的 cookie 走
     * `mergeSourceCookies` ⇒ 那里也 `?? {}` 拿到**另一个**对象并登记 ⇒ 本 store 永远看不到它
     * （137 阅读网实测：日志「回收 cookie 4 条」一直在打，但下一次请求依旧撞 CF 挑战页）。
     * 改成惰性登记：一进来就确保 `sourceCookies` 里有该源的对象，之后所有写入都落在它上面。
     */
    const live = (): Record<string, string> => {
      let m = this.sourceCookies.get(sourceId);
      if (!m) {
        m = {};
        this.sourceCookies.set(sourceId, m);
      }
      return m;
    };
    return {
      get: (k: string) => live()[k] ?? '',
      set: (k: string, v: string) => {
        live()[k] = v;
      },
      remove: (k: string) => {
        delete live()[k];
      },
      clear: () => {
        // 对齐 Legado CookieStore.removeCookie(sourceKey)：整体清空（source.removeLoginHeader())
        const m = live();
        for (const k of Object.keys(m)) delete m[k];
      },
      header: () =>
        Object.entries(live())
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
    };
  }

  /** 导入 Cookie 串（"a=b; c=d" 或 JSON map），返回是否成功 */
  setSourceCookies(sourceId: string, cookieStr: string): boolean {
    if (!this.sources.has(sourceId)) return false;
    const map: Record<string, string> = {};
    const t = cookieStr.trim();
    if (t.startsWith('{')) {
      try {
        Object.assign(map, JSON.parse(t) as Record<string, string>);
      } catch {
        return false;
      }
    } else {
      for (const pair of t.split(';')) {
        const i = pair.indexOf('=');
        if (i > 0) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    }
    this.sourceCookies.set(sourceId, map);
    return true;
  }

  /** 合并导入 cookie（登录窗口抓回的场景：只增补，不清掉已有的） */
  mergeSourceCookies(sourceId: string, cookies: Record<string, string>): boolean {
    if (!this.sources.has(sourceId)) return false;
    const map = this.sourceCookies.get(sourceId) ?? {};
    for (const [k, v] of Object.entries(cookies ?? {})) {
      if (!k) continue;
      map[k] = String(v ?? '');
    }
    this.sourceCookies.set(sourceId, map);
    return true;
  }

  /** 读取 Cookie 串（Cookie 头格式） */
  getSourceCookies(sourceId: string): string {
    const map = this.sourceCookies.get(sourceId);
    if (!map) return '';
    return Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** 导出全部源 Cookie（持久化用）：sourceId → Cookie 头串 */
  // ---- 登录信息（账号/密码）与登录调度 ----

  /**
   * 保存登录信息（Legado `BaseSource.putLoginInfo`）。
   * **合并**语义：UI 每次只提交表单里那几个字段，不能把之前存的其它键冲掉
   * （Legado `getLoginData` = 已存 loginInfo ⊕ 本次表单值）。
   *
   * `#753` B2：子进程登录回来后的**内存态采纳**用 `persist:false` ——
   * 登录信息已由子进程以 `kv-write` 发起、主进程执行落盘；这里再写一次就是第二个写入者
   * （同一键两次写，虽然值相同，但违背「同一键只有一条写入发起路径」）。
   * 默认仍为 `true`，所有既有调用点行为不变。
   */
  setSourceLoginInfo(
    sourceId: string,
    info: Record<string, unknown>,
    opts?: { persist?: boolean },
  ): boolean {
    if (!this.sources.has(sourceId)) return false;
    const map = new Map(this.sourceLoginInfo.get(sourceId) ?? []);
    for (const [k, v] of Object.entries(info ?? {})) {
      if (v == null) continue;
      // 空串也是合法值（Legado：没文本时存空字符串，而不是删除 loginInfo）
      map.set(k, String(v));
    }
    const persist = opts?.persist !== false;
    if (map.size) {
      this.sourceLoginInfo.set(sourceId, map);
      if (persist) {
        void this.storage.set(`${LOGIN_INFO_PREFIX}${sourceId}`, JSON.stringify(Object.fromEntries(map)));
      }
    } else {
      this.sourceLoginInfo.delete(sourceId);
      if (persist) void this.storage.delete(`${LOGIN_INFO_PREFIX}${sourceId}`);
    }
    return true;
  }

  /** 从持久层读登录信息（跨进程重启后也能读到；引擎 primeSourceState 走同一份存储） */
  async loadSourceLoginInfo(sourceId: string): Promise<Record<string, string>> {
    try {
      const raw = await this.storage.get(`${LOGIN_INFO_PREFIX}${sourceId}`);
      if (!raw) return {};
      const o = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o ?? {})) if (v != null) out[k] = String(v);
      return out;
    } catch {
      return {};
    }
  }

  /** 读登录头（Legado `BaseSource.getLoginHeader`） */
  async loadSourceLoginHeader(sourceId: string): Promise<string> {
    try {
      return (await this.storage.get(`${LOGIN_HEADER_PREFIX}${sourceId}`)) ?? '';
    } catch {
      return '';
    }
  }

  /**
   * 清除登录态（Legado 登录对话框工具栏「清除登录信息」）：
   * 登录信息 + 登录头 + Cookie 三者一起清。
   */
  async clearSourceLogin(sourceId: string): Promise<boolean> {
    if (!this.sources.has(sourceId)) return false;
    this.sourceLoginInfo.delete(sourceId);
    try {
      await this.storage.delete(`${LOGIN_INFO_PREFIX}${sourceId}`);
      await this.storage.delete(`${LOGIN_HEADER_PREFIX}${sourceId}`);
    } catch {
      /* ignore */
    }
    this.sourceCookies.set(sourceId, {});
    return true;
  }

  getSourceLoginInfo(sourceId: string): Record<string, string> {
    return Object.fromEntries(this.sourceLoginInfo.get(sourceId) ?? []);
  }

  exportSourceLoginInfo(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [id, map] of this.sourceLoginInfo) out[id] = Object.fromEntries(map);
    return out;
  }

  /**
   * 源登录：把 loginUrl（三种形态）交给对应引擎执行。
   * 引擎不支持 login 时返回 action='none'。
   */
  async login(
    sourceId: string,
    opts: {
      info?: Record<string, unknown>;
      action?: string;
      /**
       * LoginUiV2：上一次渲染返回的会话状态（`loginAction(action,state,form)` 的第二参）。
       * 引擎不解释其内容 —— 前端原样存、原样回传（Legado `SourceLoginV2Delegate.stateJson`）。
       */
      loginState?: string;
      /** LoginUiV2：表单快照（`{key: value}` 的 JSON 串）——动作脚本的第三参 */
      loginForm?: string;
    } = {},
  ): Promise<UnifiedLoginResult> {
    const s = this.sources.get(sourceId);
    if (!s) return { ok: false, action: 'none', message: '源不存在' };
    // 表单值先落盘：引擎 primeSourceState 会把它读成 `result` / `source.getLoginInfoMap()`
    if (opts.info) this.setSourceLoginInfo(sourceId, opts.info);
    const engine = this.registry.get(s.kind) as
      | (RuleEngine<unknown, unknown> & { login?: RuleEngine<unknown, unknown>['login'] })
      | undefined;
    if (!engine?.login) {
      return { ok: false, action: 'none', message: `引擎 ${s.kind} 不支持登录` };
    }
    const req = {
      action: 'detail',
      ...(opts.action ? { loginAction: opts.action } : {}),
      // v2 的会话状态 / 表单快照：**不要**走 opts.info（那会按 v1 语义直接落盘 loginInfo）
      ...(opts.loginState != null ? { loginState: opts.loginState } : {}),
      ...(opts.loginForm != null ? { loginForm: opts.loginForm } : {}),
    } as UnifiedRequest;
    const ctx = this.makeContext(sourceId);
    /**
     * `#412`（用户实测）：**登录流程也必须给 toast 收集槽** —— 与 `run()` 完全同一份约定
     * （见上面 `ctx.toastSink = toasts` 的注释）。
     *
     * 真因：RSS 引擎的 `makeRssEnv.onToast` 只写 `ctx.toastSink`（并打一条 `[rss-toast]` 日志），
     * 而 legado 引擎的登录会**显式传**自己的 toasts 数组 —— 于是这条缺失只在 RSS 侧暴露：
     * cmd 窗口打印了 `[rss-toast] · 源 … ✅ 已切换：无尽`，而登录对话框只能显示兜底文案
     * 「按钮动作已执行」（用户原话：「toast 信息未正确显示，反而 cmd 窗口信息正确显示了」）。
     */
    const loginToasts: string[] = [];
    ctx.toastSink = loginToasts;
    const out = await engine.login(s.rule, req, ctx);
    // `#354`：登录按钮动作可能只改**源变量**（禁漫天堂「切换国际线路」）⇒ 与 run() 同节奏回写内存映射。
    this.syncSourceStateFrom(ctx, sourceId);
    return out;
  }

  exportSourceCookies(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, map] of this.sourceCookies) {
      // `#483`：空 jar 不落盘（makeCookieStore 会惰性登记 `{}`，别把空串写进 cookies.json）
      if (!map || Object.keys(map).length === 0) continue;
      out[id] = Object.entries(map)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    }
    return out;
  }

  /**
   * `#621` 导出全部源变量（`sourceId → 变量 JSON 串`），供**备份**用。
   *
   * 与 `exportSourceCookies` 对称：都是「敏感但换了设备就没了」的东西。
   * 上游对应 `appDb.cacheDao.getRuntimeSourceCaches()`（备份到 `runtimeSourceCache.json`，
   * 且**必须**用口令加密 —— `Backup.kt` 在无口令时直接抛错）。
   *
   * 只导出非空值：`setSourceVariable(id, '')` 会留下空串（`hub.ts` 的落盘逻辑不清键），
   * 空串进备份只会让恢复端多写一次同样的空值。
   */
  exportSourceVariables(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, value] of this.sourceVariables) {
      if (!value) continue;
      out[id] = value;
    }
    return out;
  }

  /**
   * 设置源变量（Legado「设置源变量」；source.getVariable() 读取）。
   * `#753` B2：`persist:false` = 只更新内存（登录由子进程求值时，落盘由子进程 `kv-write` 发起）。
   */
  setSourceVariable(sourceId: string, value: string, opts?: { persist?: boolean }): boolean {
    if (!this.sources.has(sourceId)) return false;
    this.sourceVariables.set(sourceId, value);
    if (opts?.persist !== false) {
      void this.storage.set(`source-var:${sourceId}`, value); // 落盘（与引擎 source.setVariable 共用同一键）
    }
    return true;
  }

  /** 读取源变量 */
  getSourceVariable(sourceId: string): string {
    return this.sourceVariables.get(sourceId) ?? '';
  }

  // -----------------------------------------------------------------------
  // 源校验（复刻 Legado CheckSourceService，2026-09-06 对照源码实现）
  // 流程：域名存活 → 搜索 → 发现 → 详情 → 目录 → 正文；失败写「xx失效」分类。
  // 与 Legado 的差异：结果不写回源分组（只返回），由调用方决定是否落库。
  // -----------------------------------------------------------------------

  /** 域名存活：TCP connect bookSourceUrl 的 host:port（Legado isDomainReachable：1.6s） */
  private checkDomainReachable(url: string, timeoutMs = 1600): Promise<boolean> {
    return new Promise((resolve) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        resolve(false);
        return;
      }
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      const socket = net.createConnection({ host: u.hostname, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  /**
   * 单源完整校验。
   * @param opts.checkKeyword 默认「我的」（Legado CheckSource.keyword）；
   *   源的 ruleSearch.checkKeyWord 非空且不含 http/::/++/-- 时优先（Legado getCheckKeyword）。
   */
  /**
   * `#698` **订阅源（rss）试跑**：照上游 `Debug.kt` 的 RSS 分支，只跑 **列表 + 内容页** 两段。
   *
   * 为什么不能复用书源那条链（用户 2026-10-31 指出）：
   *  · 上游 RSS 调试就两个解析段（`︾开始解析分类页` → `︽列表页解析完成` → `︾开始解析内容页` →
   *    `︽内容页解析完成`），**没有详情页/目录页** —— 点卡片直接进正文（`ReadRssActivity`）；
   *  · 书源那条链每一段都建立在 `ruleExplore / ruleBookInfo / ruleToc` 上，
   *    订阅源根本没有这些字段 ⇒ 早先版本会「四步全未执行」还报 `ok`（假通过）。
   *
   * 段位键与书源保持同一套命名（`search`/`explore` + `content`/`exploreContent`），
   * 这样前端只需要按源类型换「段名与顺序」，不用维护两套时间轴。
   */
  private async verifyRss(
    sourceId: string,
    opts: Parameters<EngineHub['verifySource']>[1] = {},
  ): Promise<VerifyOutcome> {
    const s = this.sources.get(sourceId);
    if (!s) throw new EngineError('SOURCE_NOT_FOUND', 'validate', { engine: '-', sourceId, trace: [] });
    const rule = (s.rule ?? {}) as Record<string, unknown>;
    const start = Date.now();
    const stages: VerifyOutcome['stages'] = {};
    let ok = true;
    const failed: string[] = [];

    const say = (msg: string, level?: 'warn' | 'error'): void => {
      if (!opts.onLog) return;
      try {
        opts.onLog({ at: Date.now(), msg, ...(level ? { level } : {}) });
      } catch {
        /* 信息流故障不影响校验 */
      }
    };
    const emit = (stage: keyof VerifyOutcome['stages']): void => {
      try {
        const v = stages[stage];
        if (v) opts.onStage?.(stage, v);
      } catch {
        /* ignore */
      }
    };
    const pass = (stage: keyof VerifyOutcome['stages'], detail?: string, ms?: number): void => {
      stages[stage] = { ok: true, ...(detail ? { detail } : {}), ...(typeof ms === 'number' ? { ms } : {}) };
      emit(stage);
    };
    const fail = (stage: keyof VerifyOutcome['stages'], error: string): void => {
      stages[stage] = { ok: false, error };
      ok = false;
      failed.push(error);
      emit(stage);
    };
    const since = (from: number): number => Date.now() - from;
    const hooks: RunHooks = {
      ...(opts.onLog ? { log: opts.onLog } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      // 试跑要真实执行（不走 120s 浏览缓存），否则信息流里一条列表回执都没有
      noCache: true,
    };
    const scope = { taskClass: opts.taskClass ?? 'instant' };

    const ruleContent = typeof rule['ruleContent'] === 'string' ? rule['ruleContent'].trim() : '';
    const ruleDescription = typeof rule['ruleDescription'] === 'string' ? rule['ruleDescription'].trim() : '';

    /** 内容页那一段（列表之后唯一的一段） */
    const contentStage = async (stage: 'content' | 'exploreContent', item: unknown): Promise<void> => {
      /**
       * 上游 `Debug.kt:341-350`：`ruleDescription` 有值 ⇒ **不解析内容页**
       * （描述本身就是正文）。这不是失败，也不是「未执行」，而是一条结论。
       */
      if (ruleDescription) {
        say('⇒存在描述规则，不解析内容页');
        return;
      }
      if (!ruleContent) say('⇒内容规则为空，默认获取整个网页');
      say('︾开始解析内容页');
      const t0 = Date.now();
      try {
        const c = (await this.content(sourceId, JSON.stringify(item ?? {}), undefined, scope, hooks)) as {
          paragraphs?: string[];
          html?: string;
          media?: { url?: string };
        };
        const paras = c.paragraphs ?? [];
        if (!paras.length && !c.html && !c.media?.url) {
          say('︽内容页解析完成（0 段、无直链、无 HTML）', 'error');
          fail(stage, '内容页解析失败（取到页面但正文为空）');
          return;
        }
        say('︽内容页解析完成');
        if (c.html) pass(stage, `HTML 正文 · ${c.html.length} 字符`, since(t0));
        else if (c.media?.url) pass(stage, '播放直链 m3u8/mp4', since(t0));
        else {
          const chars = paras.reduce((n, p) => n + String(p ?? '').length, 0);
          pass(stage, `${paras.length} 段 · ${chars} 字`, since(t0));
        }
      } catch (e) {
        say('︽内容页解析完成（失败）', 'error');
        fail(stage, '内容页解析失败:' + String(e instanceof Error ? e.message : e).slice(0, 120));
      }
    };

    // 2. 搜索链（上游 `Debug.kt:386-393`：没有 searchUrl 直接报「搜索URL为空」）
    if (opts.checkSearch ?? true) {
      const searchUrl = typeof rule['searchUrl'] === 'string' ? rule['searchUrl'].trim() : '';
      if (!searchUrl) {
        say('⇒搜索URL为空（该订阅源未配置 searchUrl）', 'error');
        fail('search', '搜索URL为空（订阅源未配置 searchUrl）');
      } else {
        const typed = typeof opts.keyword === 'string' ? opts.keyword.trim() : '';
        const keyword = typed || '我的';
        say(`⇒开始搜索关键字:${keyword}`);
        say('︾开始解析搜索页');
        try {
          const tSearch = Date.now();
          const r = await this.search(sourceId, keyword, 1, scope, hooks);
          if (r.items.length === 0) {
            // 上游原话（`Debug.kt:334`）：列表解析成功但为空
            say('⇒列表页解析成功，为空', 'error');
            fail('search', '搜索失效');
          } else {
            say('︽列表页解析完成');
            pass('search', `${r.items.length} 条（关键词「${keyword}」）`, since(tSearch));
            await contentStage('content', (r.items[0] as { payload?: unknown })?.payload);
          }
        } catch (e) {
          say('︽列表页解析失败', 'error');
          fail('search', '搜索失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
        }
      }
    }

    // 6. 发现链（分类列表 → 内容页）
    const hasDiscovery = String(rule['sortUrl'] ?? '').trim() !== '' || String(rule['sourceUrl'] ?? '').trim() !== '';
    if ((opts.checkDiscovery ?? true) && hasDiscovery) {
      const tExplore = Date.now();
      try {
        let items: Array<{ payload?: unknown }> = [];
        if (opts.explorePick && opts.explorePick.value) {
          /**
           * 顺序必须与上游一致（`Debug.kt:361-362`）：**先 `⇒开始访问分类页` 再 `︾开始解析分类页`**。
           * 自动挑分类那条分支也一样 —— 挑 URL 的 `home` 不算「访问分类页」，不能让它把两行挤乱。
           */
          say(`⇒开始访问分类页:${opts.explorePick.value}`);
          say('︾开始解析分类页');
          const c = await this.category(sourceId, { [opts.explorePick.key]: opts.explorePick.value }, 1, scope, hooks);
          items = c.items as Array<{ payload?: unknown }>;
          if (items.length === 0) {
            say('︽列表页解析完成（该分类 0 条）', 'error');
            fail('explore', '发现失效（该分类 0 条）');
          } else {
            say('︽列表页解析完成');
            const name = opts.explorePick.name?.trim();
            pass('explore', `${items.length} 条（分类${name ? `「${name}」` : '（指定）'}）`, since(tExplore));
          }
        } else {
          const r = await this.home(sourceId, 1, scope, hooks);
          const picked = pickFirstExploreUrl(r.filters);
          if (!picked) {
            say('︽列表页解析完成（home 没返回任何可请求的分类）', 'error');
            fail('explore', '发现规则为空（home 没返回任何可请求的分类）');
          } else {
            say(`⇒开始访问分类页:${picked.value}`);
            say('︾开始解析分类页');
            const c = await this.category(sourceId, { [picked.key]: picked.value }, 1, scope, hooks);
            items = c.items as Array<{ payload?: unknown }>;
            if (items.length === 0) {
              say('︽列表页解析完成（0 条）', 'error');
              fail('explore', '发现失效');
            } else {
              say('︽列表页解析完成');
              const label = picked.name ?? String(picked.value).slice(0, 40);
              pass('explore', `${items.length} 条（分类「${label}」）`, since(tExplore));
            }
          }
        }
        if (items.length) await contentStage('exploreContent', items[0]?.payload);
      } catch (e) {
        say('︽列表页解析失败', 'error');
        fail('explore', '发现失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
      }
    }

    const outcome: VerifyOutcome = {
      ok,
      message: ok ? '校验成功' : '校验失败:' + failed.join('，'),
      respondTime: Date.now() - start,
      stages,
    };
    if (opts.markOnError) {
      try {
        if (!ok) this.markVerifyFailure(sourceId, failed.join(',') || outcome.message);
        else this.clearVerifyMark(sourceId);
      } catch {
        /* 标记失败不影响结论 */
      }
    }
    return outcome;
  }

  async verifySource(
    sourceId: string,
    opts: {
      keyword?: string;
      checkDomain?: boolean;
      checkSearch?: boolean;
      checkDiscovery?: boolean;
      checkInfo?: boolean;
      checkCategory?: boolean;
      checkContent?: boolean;
      /**
       * `#472` **发现链路深校验**：发现分类出卡片后继续 详情→目录→正文（对偶搜索链路）。
       * 默认关（保持既有语义：发现只验到「分类有卡片」）。开了以后
       * `exploreInfo/exploreToc/exploreContent` 三段分别落结果。
       */
      checkDiscoveryDeep?: boolean;
      /**
       * `#692` **指定发现分类**（规则工坊「发现全链」：用户点哪个分类胶囊就跑哪条）。
       *
       * 上游/本仓默认行为是「打第一个有 url 的分类」（`pickFirstExploreUrl`），
       * 工坊里用户只想验自己正在写的那一条 ⇒ 允许直接指定 `{key, value}`，
       * 给了它就**跳过 home 与自动挑选**（少一次请求，且结果对应到用户选的分类）。
       */
      explorePick?: { key: string; value: string; name?: string };
      /** 校验失败时：源注释追加 //error 信息 + 分组追加「校验失败」标签（用于筛选） */
      markOnError?: boolean;
      /** `#200` 走哪一档流量限额：单个校验 = instant（默认）；批量校验 = batch */
      taskClass?: TaskClass;
      /**
       * `#695` 每落一段就回调一次（全链试跑流式化）。
       * 顺序即执行顺序；同一段只会回调一次。回调抛异常被吞掉，不影响校验结论。
       */
      onStage?: (stage: keyof VerifyOutcome['stages'], stageResult: VerifyStage) => void;
      /**
       * `#696` 调试信息流（对齐 Legado `Debug.log`）：每一条「执行回执」回调一次。
       * 来源有两处：① 这里打的编排行（`⇒开始访问…` / `︾开始解析…` / `︽…完成`）；
       * ② 引擎内部的字段级回执（`┌获取书名` / `└光阴之外`、`≡获取成功:<url>` …）经 `ctx.trace` 流出。
       */
      onLog?: LogHook;

      /**
       * `#697` **外部中断**：客户端断开（换源/关页）⇒ 服务端 abort ⇒ 透传到每次 `run`，
       * 在途的抓取立即停止（`#480` 机制），不再「界面已停但引擎还在跑」。
       */
      signal?: AbortSignal;
    } = {},
  ): Promise<VerifyOutcome> {
    const s = this.sources.get(sourceId);
    if (!s) throw new EngineError('SOURCE_NOT_FOUND', 'validate', { engine: '-', sourceId, trace: [] });
    const rule = (s.rule ?? {}) as Record<string, unknown>;
    const ruleSearch = (rule['ruleSearch'] ?? {}) as Record<string, unknown>;
    const isJsSource = typeof rule['mainJs'] === 'string' && rule['mainJs'] !== '';
    /**
     * `#697` **订阅源（rss）是另一套规则形状**：没有 `exploreUrl` / `ruleSearch`，
     * 分类来自 `sortUrl`（`名称::url` 多行），搜索来自 `searchUrl`。
     * 旧实现只认书源字段 ⇒ 订阅源「发现全链」被整段跳过，界面显示
     * 「✅ 全链通过 · 0ms，4 步全未执行」——**通过是假的**，其实什么都没跑。
     */
    const isRss = s.kind === 'rss';
    /**
     * `#698` **订阅源有自己的一条调试链**（上游 `Debug.kt` 的 RSS 分支）：
     *   `⇒开始访问分类页/搜索关键字` → `︾开始解析分类页/搜索页` → 列表回执
     *   → `︽列表页解析完成` → `︾开始解析内容页` → 内容（HTML 全文）→ `︽内容页解析完成`
     *
     * **没有详情页、没有目录页** —— 上游 RSS 点卡片是直接进正文（`ReadRssActivity`），
     * 本仓阅读器虽走「详情→目录→正文」，但**试跑**是照上游调试口径走的，
     * 所以这里单独实现，不进书源那条链（那里每一段都带着 `ruleExplore/ruleBookInfo/ruleToc` 的假设）。
     */
    if (isRss) return this.verifyRss(sourceId, opts);

    const scope = { taskClass: opts.taskClass ?? 'instant' } as const;
    const start = Date.now();
    const stages: VerifyOutcome['stages'] = {};
    let ok = true;
    const failedNames: string[] = [];
    /**
     * `#696` 信息流一行。时间戳在这里统一打（引擎那份用自己的 `TraceEntry.at`，同一个进程时钟）。
     * 编排行与引擎行**混在同一个序列里**，前端按 `at` 排 —— 这就是 Legado 那条时间轴的形态。
     */
    const say = (msg: string, level?: 'warn' | 'error'): void => {
      if (!opts.onLog) return;
      try {
        opts.onLog({ at: Date.now(), msg, ...(level ? { level } : {}) });
      } catch {
        /* 信息流故障不影响校验 */
      }
    };
    /**
     * `#697` **订阅源的日志措辞按上游 `Debug.kt` 的 RSS 分支**（`︾开始解析分类页` / `︽列表页解析完成`
     * / `︾开始解析内容页`），书源继续用「搜索页/发现页/正文页」。
     * 一套编排、两套词 —— 因为用户对着上游日志排查时，词不对就找不到对应代码。
     */
    const w = (bookText: string, rssText: string): string => (isRss ? rssText : bookText);
    /**
     * `#695` **逐段回传**（全链试跑流式化）：每落一段就通知调用方，
     * 服务端据此推 SSE、前端边跑边渲染时间轴 —— 否则发现全链 20s 里界面只知道「正在跑…」。
     * ★ 回调里的异常**绝不能**影响校验本身（调用方是 IO/序列化代码，炸了也只是一帧没发出去）。
     */
    const emitStage = (stage: keyof VerifyOutcome['stages'], s: VerifyStage | undefined): void => {
      if (!s) return;
      try {
        opts.onStage?.(stage, s);
      } catch {
        /* ignore：流式通道的故障不该改变校验结论 */
      }
    };
    const fail = (stage: keyof VerifyOutcome['stages'], error: string) => {
      stages[stage] = { ok: false, error };
      ok = false;
      failedNames.push(error);
      emitStage(stage, stages[stage]);
    };
    const pass = (stage: keyof VerifyOutcome['stages'], detail?: string, ms?: number) => {
      stages[stage] = { ok: true, ...(detail ? { detail } : {}), ...(typeof ms === 'number' ? { ms } : {}) };
      emitStage(stage, stages[stage]);
    };
    /** 量一段的耗时（Legado 调试流逐段记时） */
    const t = (): number => Date.now();
    const since = (from: number): number => Date.now() - from;
    /** SOURCE_DISABLED / SOURCE_NOT_FOUND = 用户开关问题，视为跳过而非失败 */
    const isSkippable = (e: unknown) =>
      e instanceof EngineError && (e.code === 'SOURCE_DISABLED' || e.code === 'SOURCE_NOT_FOUND');

    try {
      // 1. 域名存活（Legado checkDomain 默认关）
      if (opts.checkDomain === true) {
        try {
          if (await this.checkDomainReachable(String(rule['bookSourceUrl'] ?? ''))) pass('domain');
          else fail('domain', '域名失效');
        } catch (e) {
          fail('domain', '域名失效:' + String(e instanceof Error ? e.message : e));
        }
        if (!ok) {
          return { ok, message: '校验失败:' + failedNames.join(','), respondTime: Date.now() - start, stages };
        }
      }

      // 2. 搜索（Legado checkSearch 默认开）
      if (opts.checkSearch ?? true) {
        const rawCheck = typeof ruleSearch['checkKeyWord'] === 'string' ? (ruleSearch['checkKeyWord'] as string) : '';
        /**
         * `#694` **关键词优先级要对齐上游两个不同入口**：
         *  · **自动校验**（源管理「校验」/批量）不传 `opts.keyword` ⇒ 走
         *    `BookSource.getCheckKeyword(default)`（`BookSource.kt:216-224`：`checkKeyWord` 合法就用它，否则用 default）；
         *  · **调试页**（工坊「全链试跑」）以用户输入为准 —— 上游 `BookSourceDebugActivity.kt:103-107`
         *    只是把 `checkKeyWord` 当作「我的」按钮的**默认文案**，点一下才用它搜，输入框始终是自由的。
         *
         * 旧实现无条件让 `checkKeyWord` 覆盖 `opts.keyword`：工坊里输入「剑来」实际搜的是源的
         * 「我在末世变废为宝」，时间轴还把错的那个词报出来（detail 里也照抄），属**静态误导**。
         */
        const validCheck =
          rawCheck && !rawCheck.includes('http') && !rawCheck.includes('::') && !rawCheck.includes('++') && !rawCheck.includes('--')
            ? rawCheck
            : '';
        const typed = typeof opts.keyword === 'string' ? opts.keyword.trim() : '';
        const checkKeyword = typed || validCheck || '我的';
        const hasSearchRule = typeof rule['searchUrl'] === 'string' && rule['searchUrl'] !== ''
          || (ruleSearch['searchUrl'] !== undefined && ruleSearch['searchUrl'] !== null);
        if (!hasSearchRule && !isJsSource) {
          /**
           * `#697` 订阅源：上游 `Debug.kt:388-393` 是 `⇒搜索URL为空`（**不是**「搜索失效」），
           * 因为「没配搜索」与「配了但搜不到」是两回事，修法也不同。
           */
          if (isRss) {
            say('⇒搜索URL为空（该订阅源未配置 searchUrl）', 'error');
            fail('search', '搜索URL为空（订阅源未配置 searchUrl）');
          } else {
            fail('search', '搜索链接规则为空');
          }
        } else {
          try {
            const tSearch = t();
            say(`⇒开始搜索关键字:${checkKeyword}`);
            say(w('︾开始解析搜索页', '︾开始解析搜索页'));
            const r = await this.search(sourceId, checkKeyword, 1, scope, { log: opts.onLog, signal: opts.signal, noCache: true });
            if (r.items.length === 0) {
              say(w('︽未获取到书籍（搜索页解析完成，但列表 0 条）', '⇒列表页解析成功，为空'), 'error');
              fail('search', '搜索失效');
            } else {
              say(w('︽搜索页解析完成', '︽列表页解析完成'));
              pass('search', `${r.items.length} 条（关键词「${checkKeyword}」）`, since(tSearch));
              // 3. 详情（Legado：取搜索第一本继续）
              if (opts.checkInfo ?? true) {
                try {
                  const first = r.items[0] as { payload?: unknown };
                  const tInfo = t();
                  say('︾开始解析详情页');
                  /**
                   * 详情→目录的分段边界。引擎会在「书籍信息就绪、目录尚未解析」时回调 `onPartial`
                   * （`#512`），这是唯一能把两行打在**正确位置**的时机。
                   * ⚠️ 但不是每个引擎都实现了它（如 maccms）⇒ 用 `markInfoDone` 兜底：
                   * 只能保证「有这两行」，位置退化成详情返回之后（仍排在 `︽目录页解析完成` 之前）。
                   */
                  let infoDone = false;
                  const markInfoDone = (): void => {
                    if (infoDone) return;
                    infoDone = true;
                    say('︽详情页解析完成');
                    say('︾开始解析目录页');
                  };
                  const d = (await this.detail(
                    sourceId,
                    JSON.stringify(first?.payload ?? {}),
                    undefined,
                    scope,
                    { log: opts.onLog, onPartial: markInfoDone, signal: opts.signal },
                  )) as {
                    chapters?: unknown[];
                    title?: string;
                  };
                  markInfoDone();
                  pass('info', String(d.title ?? r.items[0]?.title ?? '').slice(0, 24) || '取到详情', since(tInfo));
                  // 4. 目录
                  if (opts.checkCategory ?? true) {
                    if (!d.chapters || d.chapters.length === 0) {
                      say('︽目录页解析完成（0 章）', 'error');
                      fail('toc', '搜索目录失效');
                    } else {
                      say('︽目录页解析完成');
                      /**
                       * `#694` 目录**没有独立耗时**：它就在详情那一次响应里（`detail` 动作一次带回
                       * `chapters`），旧实现照抄 `since(tInfo)` ⇒ 时间轴出现「详情 1360ms / 目录 1360ms」，
                       * 四段加起来 3641ms 跟汇总的 2282ms 自相矛盾。不传 ms，由界面标「随详情返回」。
                       */
                      pass('toc', `${d.chapters.length} 章（随详情返回）`);
                      // 5. 正文（Legado checkContent 默认开）
                      if (opts.checkContent ?? true) {
                        try {
                          const tContent = t();
                          say(w('︾开始解析正文页', '︾开始解析内容页'));
                          const ch = d.chapters[0] as { payload?: unknown } | undefined;
                          const c = (await this.content(
                            sourceId, JSON.stringify(ch?.payload ?? {}), undefined, scope,
                            { log: opts.onLog, signal: opts.signal },
                          )) as {
                            paragraphs?: string[];
                            media?: { url?: string };
                            html?: string;
                          };
                          /**
                           * `#692` **影视/音频源的「正文」是播放直链**（`media.url`），没有段落
                           * —— 实测荔枝短剧：`paragraphs=0` 而 `media.url` 是 m3u8，
                           * 旧判据（`paragraphs.length > 0`）会让这类源**永远在最后一段判红**，
                           * 而它其实是通的。⇒ 段落或直接链任一非空即算通过。
                           */
                          /**
                           * `#697` **正文有三种合法形态**：段落（小说）/ 直链（音视频）/ **HTML 文档**（订阅源）。
                           * 旧判据只认前两种 ⇒ 订阅源明明取到了 `html`（AI24 实测：`paragraphs:[]` 但
                           * `html` 是整篇带样式的文档）仍被判「正文失效」。
                           * 对齐 `UnifiedContent` 契约：`html` 与 `paragraphs` **互斥**，非空即有效。
                           */
                          if ((!c.paragraphs || c.paragraphs.length === 0) && !c.media?.url && !c.html) {
                            say(w('︽正文页解析完成（0 段、无直链）', '︽内容页解析完成（0 段、无直链、无 HTML）'), 'error');
                            fail('content', '搜索正文失效');
                          } else if (c.media?.url) {
                            say(w('︽正文页解析完成', '︽内容页解析完成'));
                            pass('content', '播放直链 m3u8/mp4', since(tContent));
                          } else if (!c.paragraphs || c.paragraphs.length === 0) {
                            say(w('︽正文页解析完成', '︽内容页解析完成'));
                            pass('content', `HTML 正文 · ${(c.html ?? '').length} 字符`, since(tContent));
                          }
                          else {
                            say(w('︽正文页解析完成', '︽内容页解析完成'));
                            const chars = (c.paragraphs ?? []).reduce((n, p) => n + String(p ?? '').length, 0);
                            pass('content', `${(c.paragraphs ?? []).length} 段 · ${chars} 字`, since(tContent));
                          }
                        } catch (e) {
                          if (!isSkippable(e)) fail('content', '搜索正文失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
                        }
                      }
                    }
                  }
                } catch (e) {
                  if (!isSkippable(e)) fail('info', '详情失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
                }
              }
            }
          } catch (e) {
            if (!isSkippable(e)) fail('search', '搜索失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
          }
        }
      }

      // 6. 发现（`#199`）
      // ★ 上游 `CheckSourceService.kt:361-370` 是**两步**：
      //   `exploreKinds().firstOrNull { !it.url.isNullOrBlank() }?.url` → `exploreBookAwait(source, url)`
      //   —— 也就是「先拿分类清单，再打**第一个有 url 的分类**」。
      //   旧实现只打 `home` 并断言 `items > 0`，而多数源的 `home` **只返回分类清单**
      //   （`filters[].options[]`，items 为空）⇒ 发现页好用的源被误判「校验失败」，
      //   再被 `markOnError` 打上「//error」注释 + 分组标签。
      /**
       * `#697` 发现门的判据按源类型分叉：
       *  · 书源：`exploreUrl` 非空（原判据）；
       *  · 订阅源：`sortUrl`（分类清单）或 `sourceUrl`（单 URL 源）非空 —— 上游
       *    `Debug.kt:361-370` 对 RSS 用的就是 `sortUrls()` / `sourceUrl`，与 `exploreUrl` 无关。
       */
      const hasDiscoveryRule = isRss
        ? String(rule['sortUrl'] ?? '').trim() !== '' || String(rule['sourceUrl'] ?? '').trim() !== ''
        : typeof rule['exploreUrl'] === 'string' && rule['exploreUrl'] !== '';
      if ((opts.checkDiscovery ?? true) && hasDiscoveryRule) {
        // `#472` 深校验用卡：home 直接给卡片 > 分类第一张
        let deepExploreCard: { payload?: unknown } | undefined;
        const tExplore = t();
        try {
          /**
           * `#692` 用户显式指定了分类 ⇒ 直接打它（不再 home + 自动挑第一个）。
           * 语义与下面分支一致：只认 `items.length > 0`，空则记「发现失效」。
           */
          say(w('︾开始解析发现页', '︾开始解析分类页'));
          if (opts.explorePick && opts.explorePick.value) {
            say(w(`⇒开始访问发现页:${opts.explorePick.value}`, `⇒开始访问分类页:${opts.explorePick.value}`));
            const c = await this.category(
              sourceId, { [opts.explorePick.key]: opts.explorePick.value }, 1, scope,
              { log: opts.onLog, signal: opts.signal },
            );
            if (c.items.length === 0) {
              say(w('︽发现页解析完成（该分类 0 条）', '︽列表页解析完成（该分类 0 条）'), 'error');
              fail('explore', '发现失效（该分类 0 条）');
            }
            else {
              // `#694` 带分类显示名（前端点胶囊时把 `name` 一起送上来）
              const pickName = opts.explorePick.name?.trim();
              pass('explore', `${c.items.length} 条（分类${pickName ? `「${pickName}」` : '（指定）'}）`, since(tExplore));
              deepExploreCard = c.items[0] as { payload?: unknown } | undefined;
            }
          } else {
          say(w('⇒开始访问发现页:home', '⇒开始访问列表页:home'));
          const r = await this.home(sourceId, 1, scope, { log: opts.onLog, signal: opts.signal, noCache: true });
          if (r.items.length > 0) {
            say(w('︽发现页解析完成（home 直接给卡片）', '︽列表页解析完成（home 直接给卡片）'));
            pass('explore', `${r.items.length} 条（home 直接给卡片）`, since(tExplore));
            deepExploreCard = r.items[0] as { payload?: unknown } | undefined;
          } else {
            // 挑第一个「url 类」分类（跳过 header 标题项与 toggle/select 控件，
            // 与上游 `!it.url.isNullOrBlank()` 同一口径）
            const picked = pickFirstExploreUrl(r.filters);
            if (!picked) {
              say(w('︽发现页解析完成（home 没返回任何可请求的分类）', '︽列表页解析完成（没有可用分类）'), 'error');
              fail('explore', '发现规则为空（home 没返回任何可请求的分类）');
            } else {
              say(w(`⇒开始访问发现页:${picked.value}`, `⇒开始访问分类页:${picked.value}`));
              const c = await this.category(
                sourceId, { [picked.key]: picked.value }, 1, scope, { log: opts.onLog, signal: opts.signal },
              );
              if (c.items.length === 0) {
                say(w('︽发现页解析完成（0 条）', '︽列表页解析完成（0 条）'), 'error');
                fail('explore', '发现失效');
              }
              else {
                say(w('︽发现页解析完成', '︽列表页解析完成'));
                // `#694` 显示分类名（拿不到才退回 URL，截 40 字防撑爆时间轴）
                const label = picked.name ?? String(picked.value).slice(0, 40);
                pass('explore', `${c.items.length} 条（分类「${label}」）`, since(tExplore));
                deepExploreCard = c.items[0] as { payload?: unknown } | undefined;
              }
            }
          }
          }
        } catch (e) {
          if (!isSkippable(e)) fail('explore', '发现失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
        }

        /**
         * `#472` **发现链路深校验**（对偶搜索链路的 info/toc/content）：
         * 从 `category` 拿到卡片后，第一张卡 → 详情 → 目录 → 正文逐段落结果。
         * 每段独立 try/catch —— 目录失败不该掩盖「详情其实通了」。
         * 卡片来源优先级：`home.items`（home 直接给卡片的源，如部分 RSS 聚合）> 上面的
         * `category.items`（正常走分类的源）。两处都没有 ⇒ 不落 exploreInfo 段（浅校验已记 explore 失败）。
         */
        if (opts.checkDiscoveryDeep === true && (opts.checkInfo ?? true)) {
          const deepCard: unknown = deepExploreCard?.payload;
          if (deepCard !== undefined && deepCard !== null) {
            try {
              const tExploreInfo = t();
              say('︾开始解析详情页');
              // 同搜索链：`onPartial` 是正确时机，`markInfoDone` 兜引擎没实现它的情形
              let infoDone = false;
              const markInfoDone = (): void => {
                if (infoDone) return;
                infoDone = true;
                say('︽详情页解析完成');
                say('︾开始解析目录页');
              };
              const d = (await this.detail(
                sourceId,
                JSON.stringify(deepCard),
                undefined,
                scope,
                { log: opts.onLog, onPartial: markInfoDone, signal: opts.signal },
              )) as {
                chapters?: unknown[];
                title?: string;
              };
              markInfoDone();
              pass('exploreInfo', String(d.title ?? '').slice(0, 24) || '取到详情', since(tExploreInfo));
              if (opts.checkCategory ?? true) {
                if (!d.chapters || d.chapters.length === 0) {
                  say('︽目录页解析完成（0 章）', 'error');
                  fail('exploreToc', '发现目录失效');
                } else {
                  say('︽目录页解析完成');
                  // `#694` 同搜索链：目录随详情响应返回，没有独立耗时（旧实现把详情的耗时再报一遍）
                  pass('exploreToc', `${d.chapters.length} 章（随详情返回）`);
                  if (opts.checkContent ?? true) {
                    try {
                      const tExploreContent = t();
                      say(w('︾开始解析正文页', '︾开始解析内容页'));
                      const ch = d.chapters[0] as { payload?: unknown } | undefined;
                      const c2 = (await this.content(
                        sourceId, JSON.stringify(ch?.payload ?? {}), undefined, scope,
                        { log: opts.onLog, signal: opts.signal },
                      )) as {
                        paragraphs?: string[];
                        media?: { url?: string };
                        html?: string;
                      };
                      // `#692` 同搜索链：影视/音频源的正文 = `media.url`（没有段落）
                      // `#694` 计时必须从**这一段自己**起算（旧实现沿用详情的起点 ⇒ 报出累计值）
                      const ms2 = since(tExploreContent);
                      if ((!c2.paragraphs || c2.paragraphs.length === 0) && !c2.media?.url && !c2.html) {
                        say(w('︽正文页解析完成（0 段、无直链）', '︽内容页解析完成（0 段、无直链、无 HTML）'), 'error');
                        fail('exploreContent', '发现正文失效');
                      } else if (c2.media?.url) {
                        say(w('︽正文页解析完成', '︽内容页解析完成'));
                        pass('exploreContent', '播放直链 m3u8/mp4', ms2);
                      } else if (!c2.paragraphs || c2.paragraphs.length === 0) {
                        // 订阅源：正文是 HTML 文档（`paragraphs` 与 `html` 互斥）
                        say(w('︽正文页解析完成', '︽内容页解析完成'));
                        pass('exploreContent', `HTML 正文 · ${(c2.html ?? '').length} 字符`, ms2);
                      } else {
                        say(w('︽正文页解析完成', '︽内容页解析完成'));
                        const chars2 = (c2.paragraphs ?? []).reduce((n: number, p) => n + String(p ?? '').length, 0);
                        pass('exploreContent', `${(c2.paragraphs ?? []).length} 段 · ${chars2} 字`, ms2);
                      }
                    } catch (e) {
                      if (!isSkippable(e)) fail('exploreContent', '发现正文失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
                    }
                  }
                }
              }
            } catch (e) {
              if (!isSkippable(e)) fail('exploreInfo', '发现详情失效:' + String(e instanceof Error ? e.message : e).slice(0, 120));
            }
          }
        }
      }
    } catch (e) {
      ok = false;
      failedNames.push(String(e instanceof Error ? e.message : e));
    }

    const outcome: VerifyOutcome = {
      ok,
      message: ok ? '校验成功' : '校验失败:' + failedNames.join('，'),
      respondTime: Date.now() - start,
      stages,
    };
    // 纯网络类失败不打标（超时/连接失败属环境问题，源本身可能可用——
    // 之前会把可访问源误标「校验失败」，用户需手动清标）
    const onlyNetwork = !ok && failedNames.length > 0 && failedNames.every((m) => isNetworkFailureText(m));
    // 校验失败标记（对齐 App 端习惯：注释追加 //error、分组追加「校验失败」标签便于筛选）
    if (!ok && opts.markOnError && !onlyNetwork) {
      try {
        this.markVerifyFailure(sourceId, failedNames.join(',') || outcome.message);
      } catch {
        // 标记失败不影响校验结果
      }
    }
    // 校验通过 → 清除历史失败标记（标记可逆，修好的源自动归位）
    if (ok && opts.markOnError) {
      try {
        this.clearVerifyMark(sourceId);
      } catch {
        /* ignore */
      }
    }
    return outcome;
  }

  /**
   * 批量在线校验（复刻 Legado check_source MCP 工具：单批≤50，并发受限）。
   */
  async verifySources(
    sourceIds: string[],
    opts: Parameters<EngineHub['verifySource']>[1] & { concurrency?: number; markOnError?: boolean } = {},
  ): Promise<Array<{ id: string; outcome: VerifyOutcome | { ok: false; message: string; respondTime: number; stages: {} } }>> {
    const concurrency = Math.min(50, Math.max(1, opts.concurrency ?? 3));
    const queue = sourceIds.slice(0, 50);
    const out: Array<{ id: string; outcome: VerifyOutcome | { ok: false; message: string; respondTime: number; stages: {} } }> = [];
    const { concurrency: _c, ...perSource } = opts;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < queue.length) {
        const id = queue[idx++] as string;
        try {
          // `#200`：批量校验是**后台任务** ⇒ 用 batch 档限额（45 并发 / RPS 8）
          out.push({ id, outcome: await this.verifySource(id, { ...perSource, taskClass: 'batch' }) });
        } catch (e) {
          out.push({ id, outcome: { ok: false, message: String(e instanceof Error ? e.message : e), respondTime: 0, stages: {} } });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return out;
  }

  /** 统一的 action 分发：先查源、再强制 SourceState、再路由到引擎对应方法 */
  /**
   * 图片二次解密（Legado imageDecode / coverDecodeJs）：
   * 源声明了解密规则时对图片 bytes 跑 JS；未声明/失败返回 null（调用方回传原图）。
   */
  async decodeImage(
    sourceId: string,
    opts: { url: string; bytes: Uint8Array; isCover?: boolean },
  ): Promise<Uint8Array | null> {
    const s = this.sources.get(sourceId);
    if (!s) return null;
    const engine = this.registry.get(s.kind) as
      | (RuleEngine<unknown, unknown> & {
          decodeImage?: (
            rule: unknown,
            req: { url: string; bytes: Uint8Array; isCover?: boolean },
            ctx: EngineContext,
          ) => Promise<Uint8Array | null>;
        })
      | undefined;
    if (!engine?.decodeImage) return null;
    /**
     * `#743` P0 埋点：封面二次解密此前是**完全盲区**（无计时）。它跑源 JS（可能含
     * 位图/字体/加解密）在主线程同步求值，代理一屏几十张封面时是真实的阻塞源。
     * 独立 `k=cover-decode`，与 `dom-select`/`l1-eval` 分开统计。
     */
    const t0 = Date.now();
    // `#771`：`decodeImage` 是 async（内部可能跨 await），这里只能用 `probePoint`。
    // 若冻结时 `last=img:decode` 且 `d=0` ⇒ 停在引擎侧的同步求值里（看 `open` 是否为空），
    // 或停在 await（网络/worker）上 —— 需结合 `main ΔcpuU` 判断。
    probePoint('img:decode');
    try {
      return await engine.decodeImage(s.rule, opts, this.makeContext(sourceId));
    } finally {
      recordBlock('cover-decode', Date.now() - t0, `${opts.isCover ? 'cover ' : ''}${opts.url.slice(0, 110)}`);
      probePoint('img:decode');
    }
  }

  /**
   * `#769` 该源**是否声明了**对应的图片解密规则（`/api/proxy` 的闸门判据）。
   *
   * 为什么需要：没有规则的图（语料里是绝大多数）`decodeImage` 只会返回 null，但服务端
   * `queuedDecodeImage` 仍会把它排进串行链并等 `foregroundGate.waitIdle()`（上限 5s）——
   * 交互请求在飞时封面响应被**白白推迟最多 5s**（再叠加 `#477` 主线程冻结）。
   * 实测速读谷（`coverDecodeJs` 为空）：同一批封面直连 184~644ms，用户日志里 `/api/proxy` 9~18s。
   * 判据与 `decodeImage` 的取值完全一致（封面 `coverDecodeJs` / 正文图 `ruleContent.imageDecode`）。
   */
  hasImageDecodeRule(sourceId: string, isCover = true): boolean {
    const s = this.sources.get(sourceId);
    if (!s) return false;
    const rule = s.rule as { coverDecodeJs?: unknown; ruleContent?: { imageDecode?: unknown } } | undefined;
    const code = (isCover ? rule?.coverDecodeJs : rule?.ruleContent?.imageDecode) ?? '';
    // `D2`：字符串（旧写法）/ 对象 / JSON 字符串三态都认，判据与 `decodeImage` 共用
    return parseImageDecodeSpec(code) !== null;
  }

  /**
   * `#583` **源脚本 UI 动作求值**（Legado 图片选项 `click` / `callBackJs`）。
   *
   * 与 `run` 的区别：这里**不抓页面、不解析规则**，只把一段源脚本放进**该源的真实环境**
   * （jsLib / 源变量 / 登录头 / Cookie / 请求栈）里跑；返回它要弹出的面板地址。
   *
   * 为什么不复用 `run`：`run` 的动作白名单是 `EngineAction`，而这条通道的入参是
   * 「一段 JS + 事件名」，与列表/详情/正文的语义无关（硬塞进 `content` 会重抓整章正文）。
   */
  async evalUiAction(sourceId: string, req: UiActionRequest): Promise<UiActionResult> {
    const s = this.sources.get(sourceId);
    if (!s) throw new EngineError('SOURCE_NOT_FOUND', 'validate', { engine: '-', sourceId, trace: [] });
    if (!resolveSourceState(s.state).enabled) {
      throw new EngineError('SOURCE_DISABLED', 'validate', { engine: s.kind, sourceId, rule: 'enabled', trace: [] });
    }
    const engine = this.registry.get(s.kind);
    if (!engine?.evalUiAction) {
      throw new EngineError('UNSUPPORTED_ACTION', 'validate', {
        engine: s.kind,
        sourceId,
        rule: 'evalUiAction',
        trace: [],
      });
    }
    const ctx = this.makeContext(sourceId, { taskClass: 'instant', pool: 'detail' });
    const toasts: string[] = [];
    ctx.toastSink = toasts;
    const out = await engine.evalUiAction(s.rule, req, ctx);
    this.syncSourceStateFrom(ctx, sourceId);
    return out;
  }

  /**
   * **字典查词**（用户 4-5）。
   *
   * 字典是**跨源**能力（Legado `DictRule` 独立于书源），所以不入 `sources` 表：
   * 直接把规则传给 legado 引擎执行（`urlRule` 取正文 → `showRule` 求值）。
   * `ctx` 用占位 sourceId（`__dict__`）—— `makeContext` 对未知 id 也是安全的（只是没有源变量/Cookie）。
   */
  async dictLookup(input: {
    word: string;
    urlRule: string;
    showRule?: string;
    header?: string;
    baseUrl?: string;
  }): Promise<{ text: string; url: string }> {
    const engine = this.registry.get('legado') as unknown as
      | {
          dictLookup?: (
            ctx: EngineContext,
            i: { word: string; urlRule: string; showRule?: string; header?: string; baseUrl?: string },
          ) => Promise<{ text: string; url: string }>;
        }
      | undefined;
    if (!engine?.dictLookup) {
      throw new EngineError('UNSUPPORTED_ACTION', 'validate', {
        engine: 'legado',
        sourceId: DICT_PSEUDO_SOURCE,
        rule: 'dictLookup',
        trace: [],
      });
    }
    return engine.dictLookup(this.makeContext(DICT_PSEUDO_SOURCE), input);
  }

  async run(
    action: EngineAction,
    sourceId: string,
    req: UnifiedRequest,
    /**
     * `#200` 流量护栏作用域：`taskClass` 决定用哪一档限额（即时 30 并发/RPS 5 ；
     * 后台批量 45 并发/RPS 8）；并发池由 action 推导（`content` ⇒ 正文池，其余 ⇒ 详情池）。
     * @param external `#480`（2026-10-16）**外部中断信号**：服务端把「HTTP 客户端已断连」
     *   （用户在 Web 端切源/切分类，前端 abort 了旧请求）传进来 ⇒ ctx.signal 变成
     *   「预算超时 ∪ 外部中断」——在途的引擎抓取**立即停止**。此前客户端断连后服务端仍把
     *   整条抓取跑完（12s 超时×重试），流量槽/带宽/域名池全被死请求占着 ⇒「请求越堆越多」。
     */
    scope?: { taskClass?: TaskClass },
    /** `#496` `background`：后台任务标记（书架定时更新等）⇒ 撞 WAF 时**不起有头** */
    external?: {
      signal?: AbortSignal;
      background?: boolean;
      /** `#512` 详情分阶段回调（SSE 用）：info 就绪即回调，目录随后才返回 */
      onPartial?: (d: UnifiedDetail) => void;
      /** `#696` 调试信息流：引擎每写一条 `TraceEntry.msg` 就回调一次（只有工坊全链试跑用） */
      onLog?: LogHook;
      /** `#698` 跳过浏览缓存（试跑要真实执行，见 `RunHooks.noCache`） */
      noCache?: boolean;
    },
  ): Promise<UnifiedListResult | UnifiedDetail | UnifiedContent | UnifiedPlay> {
    const s = this.sources.get(sourceId);
    if (!s) throw new EngineError('SOURCE_NOT_FOUND', 'validate', { engine: '-', sourceId, trace: [] });

    const st = s.state;
    if (!st.enabled) {
      throw new EngineError('SOURCE_DISABLED', 'validate', { engine: s.kind, sourceId, rule: 'enabled', trace: [] });
    }
    if (action === 'search' && !st.searchEnabled) {
      throw new EngineError('SOURCE_DISABLED', 'validate', { engine: s.kind, sourceId, rule: 'searchEnabled', trace: [] });
    }
    if ((action === 'home' || action === 'category') && !st.exploreEnabled) {
      throw new EngineError('SOURCE_DISABLED', 'validate', { engine: s.kind, sourceId, rule: 'exploreEnabled', trace: [] });
    }

    const engine = this.registry.get(s.kind);
    if (!engine) throw new EngineError('SOURCE_INVALID', 'validate', { engine: s.kind, sourceId, trace: [] });

    /**
     * `#480` **浏览类结果缓存**（home / category，GET 语义）：用户在发现页来回切分类、切源回看，
     * 同一 (源, 分类, 页) 在 TTL 内重复请求直接命中 —— 远程调用量砍掉一大半，回看秒出。
     *  · TTL 120s：站点内容变化节奏远慢于浏览操作；命中后 `page.hasMore` 等翻页语义不变。
     *  · 失效：`replaceSource` / `removeSource` / 源导入时整表清空（低频操作，简单可靠）。
     *  · 不缓存 search/detail/content/play：search 有源变量副作用，detail/content payload 大
     *    且正文/目录常带时效（最新章节），play 与清晰度选择交互。
     */
    /**
     * `#653` **缓存键必须带 `extra`**（两个真实后果，都踩过）：
     *  · `extra.categoriesOnly` 的 home 结果**没有推荐位**，若与普通 home 共用键，
     *    会把「空 items」写进缓存 ⇒ 发现页 120s 内看不到任何卡片；
     *  · `extra.refreshCategories` 本意是「忽略缓存重拉」，共用键会直接命中旧结果
     *    （实测刷新 4ms 返回旧分类）⇒ 显式刷新时**完全不读也不写**。
     */
    const extraKey = JSON.stringify(req.extra ?? {});
    const bypass = req.extra?.['refreshCategories'] === true;
    const cacheKey =
      !bypass && !external?.noCache && (action === 'home' || action === 'category')
        ? `${action}|${sourceId}|${req.page ?? 1}|${JSON.stringify(req.filters ?? {})}|${extraKey}`
        : null;
    if (cacheKey) {
      const hit = this.browseCache.get(cacheKey);
      if (hit && Date.now() - hit.at < 120_000) {
        return hit.data as UnifiedListResult;
      }
    }

    const fn = (engine as unknown as Record<string, unknown>)[action];
    if (typeof fn !== 'function') {
      throw new EngineError('UNSUPPORTED_ACTION', 'validate', { engine: s.kind, sourceId, rule: action, trace: [] });
    }
    /**
     * `#642` **本轮「撞了挑战页但没过去」的收集槽**（`#11`：挑战页升级 needVerification）。
     *
     * 由 `ctx.http` 的重放闸填（见 makeContext 里的 `noteChallenge`），请求结束后附到响应上
     * ⇒ 服务端 `openVerification` 开内嵌验证窗并回 `needVerification` ⇒ 前端弹浮层。
     * 空数组是常态（绝大多数请求不撞盾），响应形状不变。
     */
    const challenges: ChallengeHit[] = [];
    // `#200`：正文走正文池、其余走详情池 —— 两池独立计数，正文洪峰不挤掉交互请求
    // `#769`：**只有 detail（详情 + 目录）**放宽行动预算；搜索/发现/正文不动。
    const actionBudgetMs = action === 'detail' ? Math.max(this.timeoutMs, DETAIL_ACTION_BUDGET_MS) : this.timeoutMs;
    /**
     * `#779` **content 的纯计算求值预算**（默认 20s，`YUEDU_JS_CONTENT_TIMEOUT_MS` 可覆盖/回退）。
     *
     * 与上面的行动预算互不相干：它管的是 worker 里**一次纯计算求值**的硬超时（哔咔 content
     * 40 张图批量计算撞池默认 10s ⇒ `JS_TIMEOUT@parse`）。判据用 `action`（不是规则文本）；
     * detail/搜索/发现/正文以外一律不传 ⇒ 池默认 10s 保持不变。
     */
    const actionJsComputeMs = action === 'content' ? contentComputeEvalTimeoutMs() : undefined;
    const ctx = this.makeContext(
      sourceId,
      {
        taskClass: scope?.taskClass ?? 'instant',
        pool: action === 'content' ? 'content' : 'detail',
      },
      external?.signal,
      external?.background === true,
      challenges,
      external?.onLog
        ? (e) => {
            // 只转发**带 msg** 的条目：stage 计时的条目（begin/end）是结构化现场，不进信息流
            if (!e.msg) return;
            try {
              external.onLog!({ at: e.at, msg: e.msg, ...(e.level ? { level: e.level } : {}) });
            } catch {
              /* 信息流推送失败不影响本次 run */
            }
          }
        : undefined,
      actionBudgetMs,
      actionJsComputeMs,
    );
    /**
     * `java.toast` / `java.longToast` 的**原话收集槽**。
     *
     * 为什么要挂在 ctx 上：源脚本弹 toast 与阶段无关 —— 搜索/详情/目录/正文/登录任何一步都可能
     * （语料里大量源用 toast 报「未登录」「解析失败」「已切换线路」，而这些动作往往**不改任何字段**，
     * 也就是说 toast 是**唯一反馈**）。引擎侧 L1 与 worker 两条路径都写 `ctx.toastSink`。
     * 请求结束后附在响应上（`toasts`）回传前端逐条弹。
     */
    const toasts: string[] = [];
    ctx.toastSink = toasts;
    // `#512` 详情分阶段回调透传给引擎（只有 SSE 请求会带；普通请求零影响）
    if (external?.onPartial) ctx.onPartial = external.onPartial;
    // ★ `#152` 水位：必须在引擎开跑**之前**取（运行期间的截断才算「本次」的）
    const runMark = truncatedMark();    const out = (fn as (rule: unknown, r: UnifiedRequest, c: EngineContext) => Promise<unknown>).call(engine, s.rule, req, ctx) as
      Promise<UnifiedListResult | UnifiedDetail | UnifiedContent | UnifiedPlay>;
    /**
     * 引擎可能通过 `source.setVariable()` 改了源变量（七猫分组等）：请求结束后同步回 hub 的
     * 内存映射，供**下次请求**的 makeContext 注入（storage 落盘由引擎侧 persistSourceVariable 完成）。
     *
     * ⚠️ **必须用 `then(ok, fail)` 双分支，不能用 `void out.finally(…)`**（2026-09-26 修）：
     * `.finally()` 会**派生一个新 promise**，原 promise 拒绝时它**也拒绝** —— 而这里把它 `void`
     * 丢掉了，于是**每一次单源失败都会产生一条 unhandledRejection**。
     * 用户实测日志原文：`[yuedu] unhandledRejection: EngineError: NETWORK@request`，
     * 栈顶就是 `at LegadoEngine.runList`（源侧网络抖动「连接被重置」时必然出现）。
     * 双分支写法既不丢同步语义，也不会派生一个没人接的拒绝。
     */
    const syncSourceState = (): void => this.syncSourceStateFrom(ctx, sourceId);
    void out.then(syncSourceState, syncSourceState);
    /**
     * `#373` **动作总超时闸**：`await out` 原本是无限等待，慢源/异常源把一次
     * `/api/run` 挂死几分钟 ⇒ 前端心跳（15s × 3）等不到响应判「服务离线」⇒ 用户只能重启。
     * 闸的语义：超时后**响应以明确错误收场**（`NETWORK@request`，detail.input.runTimeout），
     * 底层任务继续跑到自然结束（结果被丢弃；sourceVariable/内存缓存回写不受影响）。
     * 留痕（铁律 3）：hub 层 warn 一条带源身份/动作/耗时上限的日志，与 `#195` 的
     * 每源每动作错误日志互补。
     */
    let runTimer: ReturnType<typeof setTimeout> | undefined;
    let res: UnifiedListResult | UnifiedDetail | UnifiedContent | UnifiedPlay;
    try {
      res = await Promise.race([
        out,
        new Promise<never>((_, reject) => {
          runTimer = setTimeout(() => {
            console.warn(
              `[hub] 动作总耗时超 ${this.runTimeoutMs}ms 上限，提前返回错误（底层任务继续）：` +
                `${s.kind} · sourceId=${sourceId} · action=${action}`,
            );
            reject(
              new EngineError('NETWORK', 'request', {
                engine: s.kind,
                sourceId,
                /**
                 * `#608`：`input` **必须是字符串**。
                 *
                 * 前端 `apps/web/src/api.ts:626` 只对 `typeof detail.input === 'string'` 取值，
                 * 所以这里原本给的对象 `{runTimeout:true,…}` 会被前端**整段丢掉** ——
                 * 用户只看到「请求失败」，完全看不出是「预算用尽」（qyyuapi 系实测如此）。
                 *
                 * 语义上这不是网络错误（站点可能好得很，只是这一串请求累计太慢 / 反复重下），
                 * 但保留 `NETWORK` 码是为不破坏前端与基线的既有分类；真正的判据写进文本。
                 *
                 * 与上游的差异（值得写进文案，因为它解释「为什么 App 里能等下去」）：
                 * 上游只有**单请求** `callTimeout=60s`，没有「一次动作」的总预算，
                 * 所以慢源在 App 里会一直转圈直到站点回应。
                 */
                input:
                  `动作总预算 ${Math.round(this.runTimeoutMs / 1000)}s 已用尽（action=${action}）——` +
                  `这不是站点没响应，而是这一串请求累计太慢（常见：慢站点 + 远端 js 反复重下）。` +
                  `上游 Legado 没有行动预算（只有单请求 60s 超时），同样源在 App 里会继续等；` +
                  `本仓为了让请求有界设了这道闸。需要更久可调大 YUEDU_RUN_TIMEOUT_MS（毫秒）。`,
                trace: [],
              }),
            );
          }, this.runTimeoutMs);
        }),
      ]);
    } finally {
      if (runTimer) clearTimeout(runTimer);
    }
    // 只在本轮真有脚本原话时附加字段（不给所有响应都挂一个空数组）
    if (toasts.length) (res as { toasts?: string[] }).toasts = toasts;
    /**
     * `#642` **撞了挑战页 ⇒ 附 marker 并跳过浏览缓存**。
     *
     * 为什么要跳过缓存：这一轮拿到的不是真内容（是站点拦截页），缓存它会让用户
     * 过完验证回来还命中旧的空结果；而不缓存只是多付一次请求。
     */
    if (challenges.length) {
      (res as { netChallenge?: { count: number; via: string; urls: string[] } }).netChallenge = {
        count: challenges.length,
        via: challenges[0]!.via,
        urls: challenges.map((c) => c.url).slice(0, 3),
      };
    }
    // `#480` 浏览类结果入缓存（成功结果；命中判定见 run 开头）。容量超限整表清（LRU 简化）。
    /**
     * `#643` **空列表不入缓存**（aff `www.asianfanfics.com` 实测，`#642` 判据漏的第三形态）。
     *
     * 现象：该源分类走 `…,{"webView":true}` ⇒ 请求根本不经过 `ctx.http` 的撞盾闸
     * （渲染层直接给 HTML），所以 `challenges` 永远是空数组 ⇒ `#642` 的「撞盾不缓存」兜不住。
     * 而渲染层那次拿到的是 CF 的 `<title>Just a moment…</title>` ⇒ `items: []` 被**钉进缓存 120s**：
     * 之后盾过了、用户再点分类，13ms 直接命中空结果（实测 13ms / 0 请求），像「源彻底坏了」。
     *
     * 修法收在**结果形态**上而不是再枚举原因：`items.length === 0` 一律不缓存。
     * 代价 = 空分类每次多付一次请求（本来就是失败态，重复请求才有机会自愈）。
     */
    const cachedItems = (res as { items?: unknown }).items;
    const isEmptyList = Array.isArray(cachedItems) && cachedItems.length === 0;
    // `#653`：`categoriesOnly` 的 home 没有推荐位，存进去只会白占内存（键还独立）
    if (cacheKey && !challenges.length && !isEmptyList && req.extra?.['categoriesOnly'] !== true) {
      if (this.browseCache.size >= 800) this.browseCache.clear();
      this.browseCache.set(cacheKey, { at: Date.now(), data: res });
    }
    /**
     * `#152`：本轮期间「文本响应被体积护栏截断」的汇总。
     *
     * 为什么用水位而不是直接读全局计数：进程里同时还有图片代理等其它请求在跑，
     * 全局数会把无关截断也算进来；水位只取**本次运行窗口内**新增的登记（多报不漏报，语义如实）。
     * 为什么只登记**文本**类：媒体截断有自己的如实通路（/api/proxy 的 Content-Range 改写）。
     * 前端拿到后要与「站点返回空」区分显示 —— 截断意味着「内容可能不完整」，不是「源坏了」。
     */


    const trunc = takeTruncatedSince(runMark);
    if (trunc.list.length) {
      const urls = [...new Set(trunc.list.map((t: { url: string }) => t.url))];
      (res as { netTruncated?: { count: number; urls: string[] } }).netTruncated = {
        count: trunc.list.length,
        urls: urls.slice(0, 3).concat(urls.length > 3 ? ['…'] : []) as string[],
      };
    }
    return res;
  }

  // ---- 便利方法：自动填好 action + 构造 req ----
  // `#696` 末位 `log`：调试信息流回调（只有「全链试跑」这类需要逐行回执的调用方会传；
  // 不传 ⇒ ctx.trace 不挂 onEntry，行为与之前完全一致）。
  search(
    sourceId: string, keyword: string, page = 1, scope?: { taskClass?: TaskClass }, hooks?: RunHooks,
  ): Promise<UnifiedListResult> {
    return this.run('search', sourceId, { action: 'search', keyword, page }, scope, runExt(hooks)) as Promise<UnifiedListResult>;
  }
  home(sourceId: string, page = 1, scope?: { taskClass?: TaskClass }, hooks?: RunHooks): Promise<UnifiedListResult> {
    return this.run('home', sourceId, { action: 'home', page }, scope, runExt(hooks)) as Promise<UnifiedListResult>;
  }
  category(
    sourceId: string,
    filters?: Record<string, string>,
    page = 1,
    // ★ `#199`：scope 必须能传进来 —— 校验走 `taskClass: 'batch'`（限 RPS），
    //   漏了它就等于让校验请求走 instant 档，批量校验时会把限流绕开。
    scope?: { taskClass?: TaskClass },
    hooks?: RunHooks,
  ): Promise<UnifiedListResult> {
    return this.run('category', sourceId, { action: 'category', page, filters }, scope, runExt(hooks)) as Promise<UnifiedListResult>;
  }
  detail(
    sourceId: string,
    itemId: string,
    extra?: Record<string, unknown>,
    scope?: { taskClass?: TaskClass },
    /**
     * `#696` 详情要两个钩子：
     *  · `log` 信息流；
     *  · `onPartial` —— 引擎在「书籍信息就绪、目录尚未解析」时回调，**这是唯一能把
     *    `︽详情页解析完成` / `︾开始解析目录页` 打在正确位置的分界点**（否则这两行只能等
     *    整个 detail 返回才补打，会排在目录日志后面，反而看不出先后）。
     */
    hooks?: RunHooks,
  ): Promise<UnifiedDetail> {
    return this.run('detail', sourceId, { action: 'detail', id: itemId, extra }, scope, runExt(hooks)) as Promise<UnifiedDetail>;
  }
  content(
    sourceId: string,
    itemId: string,
    extra?: Record<string, unknown>,
    scope?: { taskClass?: TaskClass },
    hooks?: RunHooks,
  ): Promise<UnifiedContent> {
    return this.run('content', sourceId, { action: 'content', id: itemId, extra }, scope, runExt(hooks)) as Promise<UnifiedContent>;
  }
  play(sourceId: string, extra: Record<string, unknown>): Promise<UnifiedPlay> {
    return this.run('play', sourceId, { action: 'play', extra }) as Promise<UnifiedPlay>;
  }

  /**
   * 多源聚合搜索：并发跑所有「已启用 + 启用搜索」的源，
   * 逐源流式产出 EngineEvent（items / done），可直接喂 SSE。
   */
  async *aggregateSearch(
    keyword: string,
    opts: { kinds?: string[]; groups?: string[]; concurrency?: number; page?: number; limit?: number;
            /** `#273` 源白名单：给了就**只搜这几个**（idle 懒加载 / 单源翻页用 —— 点哪个源搜哪个，不惊动整池） */
            sourceIds?: string[];
            /**
             * `B6` **跳过的源**（`dead` 且未过 3 天跳过期的源）。
             * 与 `sourceIds` 正交：白名单仍保留 `limit` 语义（不因排除而变成白名单模式）。
             */
            skipIds?: string[];
            /**
             * `#292` **中止信号** —— 调用方（服务端 SSE 路由）在客户端断开时 abort。
             *
             * ## 为什么必须有（不是可选优化）
             * 此前「客户端关掉弹窗 ⇒ 服务端继续把 30 个源全跑完」。原因：消费者 `break` 出
             * `for await` 只是**不再取事件**，而 worker 是 `void Promise.all(workers)` 起出去的
             * 独立异步循环，`break` 根本碰不到它们 ⇒ 队列里剩下的源照跑不误（继续占带宽、
             * 占引擎 CPU，并且**干扰紧接着发起的下一次搜索**——用户实测「关掉再点另一个源搜索、
             * 感觉很卡」）。有了 `signal` 后：**未开始**的源立刻不搜，正在跑的那一批（≤ concurrency）
             * 跑完即停。想连「正在跑的那一批」也立刻断，需要把 signal 一路透传到引擎的 HTTP 层，
             * 那是引擎契约的改动，本期不做（如实说明，不假装已彻底取消）。
             */
            signal?: AbortSignal;
            onEvent?: (e: EngineEvent) => void } = {},
  ): AsyncGenerator<EngineEvent> {
    const page = opts.page ?? 1;
    const limit = Math.max(1, opts.concurrency ?? 4);
    // 分组匹配：raw 的 bookSourceGroup/group（逗号/中文逗号/& 分隔的多分组）含任一所选分组即命中
    const srcGroups = (s: { raw: unknown }): string[] => {
      const raw = (s.raw ?? {}) as Record<string, unknown>;
      const g = raw['bookSourceGroup'] ?? raw['group'];
      return String(g ?? '')
        .split(/[,，&]/)
        .map((t) => t.trim())
        .filter(Boolean);
    };
    let pool = this.sources
      .list({ enabled: true })
      .filter((s) => s.state.searchEnabled && (!opts.kinds || opts.kinds.includes(s.kind)))
      .filter((s) => !opts.groups || opts.groups.length === 0 || opts.groups.some((x) => srcGroups(s).includes(x)))
      // `#273` 白名单在 kinds/groups 之后过滤（白名单是调用方从候选里挑出来的，交集必须保留）
      .filter((s) => !opts.sourceIds || opts.sourceIds.includes(s.id))
      // `B6` 死源跳过：在 kinds/groups/白名单之后、`limit` 截断之前排除，不占首屏名额
      .filter((s) => !opts.skipIds || !opts.skipIds.includes(s.id));
    // 演示/生产都能用的熔断：限制单次聚合扫描的源数量，避免成百上千个死源拖垮首屏
    // ⚠️ `#273` 白名单模式跳过 limit：调用方明确点名了源（通常 1 个），再截断反直觉
    if (!opts.sourceIds?.length && opts.limit && opts.limit > 0) pool = pool.slice(0, opts.limit);

    const queue = pool.slice();
    const ch = new Channel<EngineEvent>();
    const scannedIds = pool.map((s) => s.id);
    const okIds: string[] = [];
    const failedMap: Record<string, string> = {};

    /**
     * 事件投递**绝不能把 worker 带崩**。
     *
     * 为什么（2026-09-26 修）：`opts.onEvent` 在服务端是**写 SSE 响应流**。客户端断开
     * （网络重置/切页）时写流会抛，而它原先在 worker 的 `catch`/`finally` 块里**没有保护** ⇒
     * worker 拒绝 ⇒ `Promise.all` 拒绝 ⇒ 既产生 unhandledRejection，又让下面的
     * `ch.end()` **永不执行**（SSE 流挂死，前端一直转圈）。
     */
    const emit = (evt: EngineEvent): void => {
      try {
        opts.onEvent?.(evt);
      } catch {
        /* 客户端可能已断开：吞掉即可，流仍由 ch.end() 正常收尾 */
      }
      ch.push(evt);
    };

    const worker = async (): Promise<void> => {
      while (queue.length) {
        // `#292` 中止信号：客户端断开 ⇒ 未开始的源立刻不再搜（已发出的那一批仍会跑完）
        if (opts.signal?.aborted) break;
        const s = queue.shift()!;
        let ok = false;
        try {
          const r = await this.search(s.id, keyword, page);
          ok = true;
          okIds.push(s.id);
          /**
           * 源脚本的 toast 随流下发（`run` 已把它收集在 `r.toasts`）。
           *
           * 为什么必须补这一步：聚合搜索是 **SSE 流**，不走 `/api/run` 的请求-响应通道，
           * 若只把 `toasts` 挂在结果对象上，前端永远看不到它 —— 而搜索阶段恰恰是
           * toast 最密集的地方（「未检测到登录状态」「今日搜索次数已用完」…）。
           * 顺序：先 toast 再 items（提示先于结果，符合阅读顺序）。
           */
          for (const t of (r as { toasts?: string[] }).toasts ?? []) {
            emit({ type: 'toast', sourceId: s.id, text: t });
          }
          emit({ type: 'items', sourceId: s.id, items: r.items });
        } catch (e) {
          // 单源失败不影响其它源；记录失败原因，推给前端做诊断
          const msg = e instanceof Error ? e.message : String(e);
          failedMap[s.id] = msg;
          emit({ type: 'trace', sourceId: s.id, entry: { stage: 'parse', rule: msg, at: Date.now() } });
        } finally {
          emit({ type: 'done', sourceId: s.id, ok });
        }
      }
    };

    const workers = Array.from({ length: Math.min(limit, pool.length) }, worker);
    void Promise.all(workers)
      // worker 内部已各自 try/catch；这里再兜一层，保证 `scan`/`end` **一定**发出（否则 SSE 挂死）
      .catch((e: unknown) => {
        failedMap['__aggregate'] = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        ch.push({ type: 'scan', scanned: scannedIds, ok: okIds, failed: failedMap });
        ch.end();
      });

    while (true) {
      const e = await ch.pull();
      if (e === null) break;
      yield e;
    }
  }
}

/** 纯网络类失败文本判别（超时/连接/DNS）——校验打标时跳过，避免误标可访问源 */
function isNetworkFailureText(msg: string): boolean {
  return /timeout|timed out|aborted|fetch failed|NETWORK|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|网络/.test(
    msg,
  );
}
