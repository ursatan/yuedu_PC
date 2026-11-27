/**
 * 引擎契约
 *
 * 【插件化的核心就在这个文件】
 *
 * 关键点：TRule 是泛型，每个引擎私有。
 * facade（统一门面）层对 TRule 完全无感 ——
 * 它只负责「拿到一份配置 → 问每个引擎 detect() 认不认 → 交给认领的那个」。
 *
 * 这就是「引擎互不污染」的落地方式：
 * Legado 的 ruleSearch / ruleToc 这些私有字段，永远不会出现在 MacCMS 的类型里。
 */

import type {
  EngineAction,
  UnifiedRequest,
  UnifiedListResult,
  UnifiedDetail,
  UnifiedContent,
  UnifiedPlay,
  UnifiedLoginResult,
  UiActionRequest,
  UiActionResult,
} from './types';
import type { TraceSink } from '../trace';

// ---------------------------------------------------------------------------
// 注入给引擎的能力（具体实现在 core 的 net / sandbox / store 模块）
// ---------------------------------------------------------------------------

/**
 * `#699` **一次重定向跳**（网络层自己跟链时记下来）。
 *
 * 为什么需要：`fetch(url, {redirect:'follow'})` 只把**最终**响应交回来，中间那几跳的
 * 3xx 状态码与 `Location` 全被 undici 吞掉 ⇒ 信息流里没法复刻上游的
 * `≡检测到重定向(301)` / `┌重定向后地址` / `└…`（`Debug.kt` 的 `AnalyzeUrl` 分支）。
 * 现在改成「自己跟」：每跳留一条记录，`status` 是**真实**的状态码，`location` 是原始
 * `Location` 头，`url` 是解析（相对→绝对）后的目标。
 */
export interface HttpRedirect {
  /** 这一跳的状态码：301 / 302 / 303 / 307 / 308 */
  status: number;
  /** 发出这一跳请求的地址（重定向前） */
  url: string;
  /** 原始 `Location` 头（站点写什么就是什么，可能是相对路径，也可能是没转义的 UTF-8） */
  location: string;
  /** `Location` 按当前地址解析后的绝对目标（实际去请求的那个） */
  target: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** 响应体。按 charset 解码后的字符串，或二进制 */
  body: string | ArrayBuffer;
  /** 最终 URL（跟随重定向后） */
  url: string;
  /**
   * `#699` 跟随重定向的**完整跳跃链**（按发生顺序；没发生重定向则缺省/空数组）。
   *
   * 语义边界：只在 `redirect !== 'manual'` 时有值 —— `manual` 是「源脚本自己拦截 3xx」
   * （`java.get/post` 的 `followRedirects(false)`），那一档就**不该**替它跟。
   */
  redirects?: HttpRedirect[];
  /**
   * 响应体是否被**网络护栏**截断（超过 `YUEDU_NET_MAX_BODY_MB`）。
   *
   * 为什么要透出：截断是"省带宽/防 NAT 打满"的必要手段（媒体源整包可达数十 MB），
   * 但**绝不能静默**——上层据此可判「媒体过大，只取到前 N MB」而不是给出错误的数据。
   */
  truncated?: boolean;
  /**
   * `#424` **流式响应体**（仅 `responseType: 'stream'` 时给）。
   *
   * 为什么需要：音视频是「边下边播」的，而 `arraybuffer` 通路必须**整包读进内存**
   * 且要过体积护栏（`YUEDU_NET_MAX_BODY_MB`×4 = 32MB）⇒ 大 mp4 被静默截断
   * （用户实测：`/api/proxy` 日志「体积护栏截断 → content-range 改写」、嗅探播不了）。
   * `stream` 分支**不缓冲**，由调用方（server 的 `/api/proxy`）直接管道给客户端。
   *
   * ⚠️ 该分支下 `body` 是**空的**（占位，保持既有类型不变）—— 读 `stream`。
   */
  stream?: ReadableStream<Uint8Array>;
}

export interface HttpRequestOptions {
  /**
   * `PROPFIND` / `MKCOL` 是 **`#208` WebDAV 需要的**（列出目录 / 建目录）。
   * 为什么敢直接扩这个联合类型：网络层只在一处读它 —— 判定「是否幂等可重试」
   * （`GET`/`HEAD` 且无 body 才重试），新增的方法**都不是** GET/HEAD ⇒ 天然不重试，行为不变。
   */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PROPFIND' | 'MKCOL';
  headers?: Record<string, string>;
  /** `Uint8Array` 是 `#208` WebDAV 上传二进制（备份 zip）加的；底层 `fetch` 本来就接受 ArrayBufferView */
  body?: string | URLSearchParams | FormData | Uint8Array;
  /** 超时毫秒 */
  timeout?: number;
  /** 响应编码，Legado 里很常见（gbk / gb2312） */
  charset?: string;
  /**
   * 重定向策略（缺省 `follow`）。
   *
   * `manual`（`#387c`）用于 **`java.get` / `java.post`**：上游 `JsExtensions.kt:591/618/645`
   * 对这三个 API 一律 `followRedirects(false)`（注释原话「js实现重定向拦截」）——
   * 源脚本用 `statusCode()` 自己判 3xx 再决定跟不跟。
   *
   * ⚠️ Node/undici 下 `manual` **保留真实 3xx 状态码与 `Location`**（实测 301 + location；
   * 不是浏览器那种 opaque redirct/status 0），所以这条策略在本环境可直接用。
   */
  redirect?: 'follow' | 'manual';
  /** 返回二进制（图片 / 字体 / 压缩包） */
  responseType?: 'text' | 'arraybuffer' | 'stream';
  signal?: AbortSignal;
  /**
   * 本次请求的响应体上限（字节）。不传则用护栏默认（文本 8MB / arraybuffer 4 倍）。
   * 用于「这条明确知道要整包」的场景（如导出/快照，见 `SNAPSHOT` 用法）。
   */
  maxBodyBytes?: number;
  /**
   * 排队优先级（只在**并发槽位不够、需要排队**时起作用）。
   *
   * `low` = 后台资源（封面/图片等「可以晚一点」的批量取图），**让位**给默认的 `high`。
   * 语义边界（别用错）：
   *   · 有**空槽**时低优先照样立刻拿到槽位 ⇒ 不影响吞吐，只影响**排队顺序**；
   *   · `high` 是默认值，所以引擎的解析请求（`/api/run` 的 search/detail/toc/content）
   *     不需要改任何代码就自动优先 —— 用户正盯着转圈的那条路。
   *
   * 为什么需要（2026-09-26 实测）：护栏的 `globalSem`(6)/`hostSem`(2) 是**模块级单例**，
   * 图片代理与引擎**共用**同一组槽位且是 FIFO ⇒ 发现页几十张封面会把后来的 detail 顶在队尾。
   * 受控 A/B：封面洪峰中 detail 多等 **+820ms（+23%）**；浏览器侧（同源 6 连接）**+1784ms（+47%）**。
   */
  priority?: 'high' | 'low';
  /**
   * `#200` **本次请求属于哪个并发池**（不传则跟随 `createHttpClient` 的默认池，默认 `detail`）。
   *
   * 语义：`detail` = 搜索/详情/目录/发现；`content` = 正文。
   * 两池**独立计数、互不抢占** —— 正文抓取再凶也不该把「用户正盯着的详情/目录」挤掉。
   */
  pool?: 'detail' | 'content';
  /**
   * `#428`（`D12`=A，用户 2026-10-12 拍板）**按源忽略 TLS 校验**。
   *
   * 只为「站点证书过期/自签名，但用户仍要用这个源」这一种情形开的口子：
   * 单请求级别传 `rejectUnauthorized:false` 的 dispatcher（见 `net-agent.insecureTlsDispatcher`），
   * **绝不**改全局 dispatcher。接线点**只有** `facade/hub.ts` 的 `makeContext`
   * （源侧显式开了 `allowInsecureTls` 才传）与 `apps/server` 的 `/api/proxy`。
   *
   * ⚠️ 开了它 = 该源的请求不再校验服务端身份（可被中间人替换）—— 界面必须给风险提示。
   */
  allowInsecureTls?: boolean;
  /**
   * `#742` **IP 直连**（对齐上游 `UrlOption.dnsIp` / `AnalyzeUrlNetworkOptions.buildScopedDns`）：
   * `IP,IP2` 多值按顺序尝试；**只换「域名→地址」这一步**，Host 头与 TLS SNI/证书校验仍按 URL 域名。
   * 缺省/非法值 ⇒ 系统解析（零行为变化）。
   */
  dnsIp?: string;
  /**
   * `#708` **本次请求是否计入域名熔断**（缺省 true）。
   *
   * 为什么要能关：`Reload()`（源作者写在外链 jsLib 里）每次取脚本前都先 `java.head(url)` 拿
   * etag，而这类外链主机（qyyuapi 系）的 HEAD 本身很慢、经常超时。HEAD 失败**不影响**后续
   * GET 的可用性（etag 本仓根本不用于重验），却会把该域名计入「连续 6 次失败 ⇒ 暂停 40s」
   * —— 于是几个 HEAD 探针就能把同一域名下**本可成功**的 GET（sortUrl/loginUrl）一起打死。
   * 关掉只对「非必需的探测请求」生效（目前只有 worker `java.head`），GET/POST 仍照常计数。
   */
  countBreaker?: boolean;
  /**
   * `#780` **域名熔断已开启时，本次请求是否仍照常发出**（缺省 false = 照旧等冷却/直接失败）。
   *
   * 只给 `/api/proxy?cover=1` 用：封面失败只是缺图，预算已有界（10s），
   * 不值得让整屏封面在熔断冷却期内全部秒失败。开启后：
   *   · 不等冷却（`acquireTraffic` 跳过熔断等待）；
   *   · 走**独立的域名/池闸门**（不受熔断期 `limit=0` 影响），仍受全局并发与 RPS 约束；
   *   · 通常与 `countBreaker:false` 成对使用（失败不喂熔断，也不清零连续失败）。
   * 正文图 / 重试不传此开关 ⇒ 行为与从前完全一致。
   */
  bypassBreaker?: boolean;
}

export interface HttpClient {
  request(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

/** JS 沙箱 —— 跑书源里的 <js> / {{}} / mainJs */
export interface JsSandboxPool {
  /**
   * 在沙箱里执行一段脚本，返回最后一个表达式的值。
   * 每次调用是独立的上下文（不共享全局变量），
   * 这一点对齐 Legado：JsSourceEngine 每次调用都 buildScope。
   */
  eval<T = unknown>(opts: {
    code: string;
    /** 注入到 JS 作用域的变量 */
    bindings?: Record<string, unknown>;
    timeoutMs?: number;
    /** 宿主 RPC：worker 内 java.ajax/webView/getString 回宿主异步执行（仅 worker 池支持） */
    rpc?: (method: string, args: unknown) => Promise<unknown>;
    /**
     * 顶层声明提升名单（宿主用 `scanDecls` 扫出，worker 按名字挂到 globalThis）。
     *
     * 为什么需要：Legado 用 Rhino，**函数声明即全局属性**，所以源脚本大量写 `this.foo()`；
     * V8 的 `eval` 里声明落在 eval 自己的作用域 → `this.foo` 取不到。名单由宿主算（正则只此一份），
     * worker 只管挂载，避免两处正则漂移。
     */
    hoistFns?: string[];
    /** 同上，`var` 声明（语句赋值，需在 eval 之后挂） */
    hoistVars?: string[];
    /**
     * `#611` step3 / `#624`：jsLib 文本（与 code **分开**下发）。
     *
     * 上游 `SharedJsScope.evaluateJsLib` 把 jsLib 求值进**独立 bindings**，规则求值
     * `bindings.chainTo(sharedScope)`（父可读 / 写落本层）。宿主旧行为是把 lib 拼进
     * code 同一 eval 作用域 ⇒ lib 与 code 的顶层声明互相覆盖（源库 `function Map`
     * 顶掉宿主内置就是这条链，`#595`/`#601`）。给了 `lib` 且 `chain=true` 时，
     * worker 把 lib 编译成独立作用域工厂（对齐 L1 的 `libScopeFactory`）。
     */
    lib?: string;
    /** `lib` 里的函数声明名（宿主 `scanDecls` 扫出，worker 按名挂到 lib 作用域） */
    libFns?: string[];
    /** `lib` 里的 var 声明名（用于「同名 var 预置」防绑定被遮蔽） */
    libVars?: string[];
    /** `#611` step3：chainTo 作用域模式（默认由宿主 `YUEDU_JS_CHAINSCOPE` 决定） */
    chain?: boolean;
    /**
     * `#624`：在 `node:vm` 独立上下文里求值（process/require/Buffer 对脚本不可见）。
     * 默认由宿主 `YUEDU_JS_VM` 决定（默认开）；`=0` 回退 worker 全局（旧行为）。
     */
    vm?: boolean;
  }): Promise<T>;
}

/** 变量存储（Legado 的 @put: / @get:，跨阶段传递） */
export interface VariableStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  /** 导出全部，用于跨阶段传递 */
  dump(): Record<string, unknown>;
  load(vars: Record<string, unknown>): void;
}

/** 键值存储（Cookie / 登录态 / 用户变量，按 sourceId 隔离） */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 渲染器钩子（WebView 替代）：url → 渲染后的 HTML。
 *  分层实现见 `apps/server/src/renderer.ts`（远端服务 / 桌面桥 / 常驻会话 / 无头 Chromium / 静态抓取）。
 *  `#453`：`opts.sourceId` 由 hub 的 `makeContext` 统一注入 —— 渲染层据此优先用**该源的常驻浏览器会话**
 *  （登录态 / cookie / TLS 指纹都在里面），引擎侧调用点无需改动。 */
export type WebRendererHook = (
  url: string,
  opts?: {
    js?: string;
    sourceRegex?: string;
    delayMs?: number;
    headers?: Record<string, string>;
    sourceId?: string;
    /**
     * `#731` 这次渲染的**目的**（`#393` 的 `BrowserOpenKind`）：
     *  · `cookie`（`java.startBrowserAwait` / `java.webView`）⇒ 宿主必须保证「有会话」，
     *    建不出会话就抛明确错误，而不是给空串（否则脚本静默走失败分支）；
     *  · `show` 是 fire-and-forget，保持「拿不到就回落」的老行为。
     */
    kind?: 'show' | 'cookie';
  },
) => Promise<string>;

/** 流式事件（多源聚合搜索时，先返回的先推给前端） */
export type EngineEvent =
  | { type: 'trace'; sourceId: string; entry: unknown }
  | { type: 'items'; sourceId: string; items: UnifiedListResult['items'] }
  | { type: 'done'; sourceId: string; ok: boolean }
  /**
   * 源脚本 `java.toast` / `java.longToast` 的原话（聚合搜索的 SSE 流里逐条下发）。
   *
   * 为什么聚合搜索需要专门的事件：它**不走** `/api/run` 那条请求-响应通道
   * （前端拿到的是 SSE 事件流，`toasts` 字段无处安放），而搜索恰恰是 toast 最密集的阶段之一
   * （「未检测到登录状态」「今日搜索次数已用完」这类提示全在这里）。
   */
  | { type: 'toast'; sourceId: string; text: string }
  /** 聚合扫描汇总（流末尾发出）：scanned=总扫描数，ok=成功源，failed=失败源+原因 */
  | { type: 'scan'; scanned: string[]; ok: string[]; failed: Record<string, string> };

// ---------------------------------------------------------------------------
// 引擎上下文
// ---------------------------------------------------------------------------

/**
 * 源桩（`bindings["source"]`）需要的**最小**上下文（`#553`）。
 *
 * 为什么单独抽出来、而不是要求完整 `EngineContext`：源桩只需要「变量 / 登录信息 / Cookie」，
 * 而**试跑探针**（`diag/probe.ts`）没有 http / sandbox / trace —— 若签名要完整上下文，
 * 探针只能 `as unknown as` 硬塞，之后谁在桩里用 `ctx.http` 就会在探针里静默 `undefined`
 * （正是「假装有」的典型形态）。给最小接口 ⇒ 缺什么编译期就报什么。
 *
 * `EngineContext` 结构性满足本接口（无需转换）。
 */
export interface SourceStubCtx {
  variables: VariableStore;
  /** 登录信息（`getLoginInfoMap()` 的覆盖层，优先于 `variables['__loginInfo']`） */
  loginInfo?: Map<string, string>;
  /** 源级 Cookie（`putLoginHeader` 会把 Cookie 落进来） */
  cookies?: CookieStore;
}

/** 源级 Cookie 存储（登录态） */
export interface CookieStore {
  get(key: string): string;
  set(key: string, value: string): void;
  /** 删除 cookie（响应 Set-Cookie 带 Max-Age=0 / 过期时间时） */
  remove?(key: string): void;
  /** 清空该源的全部 cookie（Legado `CookieStore.removeCookie(sourceKey)`，登出/移除登录头用） */
  clear?(): void;
  /** 整串 Cookie 头（a=b; c=d），空则空串 */
  header(): string;
}

export interface EngineContext {
  /** 本次请求 ID，日志串联用 */
  reqId: string;
  /** 源 ID（Legado 是 bookSourceUrl / sourceUrl） */
  sourceId: string;
  /** 中断信号 */
  signal: AbortSignal;
  /**
   * 本次行动的**截止时刻**（epoch ms），可选。
   *
   * 为什么要它：`signal` 是「中断信号」，但引擎里没有任何地方会去「等」它 —— 只有把请求
   * 超时压到**剩余预算**内，服务端才能在自己的预算里结束并如实报错。否则一次行动会远跑过
   * 预算（旧实现单请求最坏 25s×2=50s），客户端先超时退出，服务端还在跑：
   * 既拿不到错误原因，也无法区分「站点慢」与「引擎挂住」。
   */
  deadlineAt?: number;
  http: HttpClient;
  sandbox: JsSandboxPool;
  /**
   * `#779` **本行动的纯计算 JS 求值预算（毫秒）**（不传 = worker 池默认 10s）。
   *
   * 只由 hub 按 `action === 'content'` 注入（默认 20s，可用 `YUEDU_JS_CONTENT_TIMEOUT_MS`
   * 覆盖；`0` = 回退）。引擎把它原样透传给 `createHybridJsEvaluator({ computeTimeoutMs })`。
   * 与 `deadlineAt`（行动总预算，detail 75s / 其余 60s）是两件事：后者管 HTTP 与整次行动，
   * 本值只管「一次纯计算求值」的 worker 硬超时。含 HTTP 的脚本仍走 `syncTimeoutMs + 5s`。
   */
  jsComputeTimeoutMs?: number;
  trace: TraceSink;
  variables: VariableStore;
  storage: KeyValueStore;
  /** 源级 Cookie 存储（登录态），可选；引擎注入到请求头与 java cookie 桩 */
  cookies?: CookieStore;
  /**
   * 登录信息（账号/密码等，Legado `BaseSource.getLoginInfoMap()`）——
   * 源脚本 `source.getLoginInfoMap().get("账号")` 读取，用于**免浏览器**的 API 登录。
   */
  loginInfo?: Map<string, string>;
  /** JS 渲染器（WebView 替代）：url → 渲染后的 HTML。
   *  opts.js = 页面内注入脚本（Legado webJs，仅 CDP 渲染层支持）；
   *  opts.sourceRegex = 子资源 URL 正则（Legado sourceRegex）。 */
  webRenderer?: WebRendererHook;
  /**
   * `#676` **`java.webView(html, url, js)` 的宿主实现**（上游 `JsExtensions.kt:279-304`）。
   *
   * 语义：把 `html` 当文档、以 `url` 为 origin、执行 `js`，返回 **js 的返回值**。
   * 必须由宿主用真浏览器实现（`Page.navigate` → `Page.setDocumentContent` → `Runtime.evaluate`）——
   * 文档没有站点 origin 时，源脚本里的相对路径 XHR 会被浏览器拒发。
   */
  renderHtmlScript?: (html: string, baseUrl: string, js: string) => Promise<string>;

  /**
   * `#727` **`java.getVerificationCode(imageUrl)` 的人工输入通道**（Legado `JsExtensions.kt:442-449`）。
   *
   * 语义：宿主拉起/复用该源的常驻 Chromium，把验证码画面显示给用户，等用户输入后
   * **把浏览器里的 Cookie 回收进该源 CookieStore**，并把用户输入的验证码原样返回给脚本。
   *
   * 边界（实现方必须遵守，否则 worker 会被永久卡住）：
   *   · 必须有界（默认 60s，可用 `YUEDU_VERIFY_CODE_TIMEOUT_MS` 覆盖）；
   *   · 用户取消 / 关闭窗口 / 浏览器不可用 ⇒ **reject**（worker 的同步 RPC 会原样抛出）；
   *   · 不能用空串「成功」返回 —— 脚本会把空验证码提交上去，表现得像密码错误。
   */
  verificationCode?: (imageUrl: string) => Promise<string>;

  /**
   * `#658` **渲染撞盾时的回传钩子**：`webRenderer` 拿到的是过闸/验证页 ⇒ 引擎把它交给宿主，
   * 由宿主决定「有头重放 / 开内嵌验证窗」（返回更好的 HTML 就用它；返回空 ⇒ 引擎照旧用原页面）。
   *
   * ## 为什么必须有它（`#643` §3.1 记下、本轮合上的缺口）
   * 宿主的反爬重放是挂在 **`ctx.http`** 上的（响应体撞盾 ⇒ 有头重放 + 验证窗）。而带
   * `{"webView":true}` 的源走 `ctx.webRenderer` —— **根本不经过 `ctx.http`** ⇒ 撞了 Cloudflare
   * 也永远不会触发重放/验证窗。实测：
   *  · 刺猬书库（`webView:true`）发现页：`[render] 渲染结果仍是过闸/验证页（Cloudflare（Just a moment））`
   *    然后就到此为止 —— 没有重放、没有验证窗，用户只能看到源自己写的「被 Cloudflare 拦截」提示；
   *  · Aff（同为 webView）也是这一段，只能靠首页那次 HTTP 请求偶然触发 antibot。
   * 138 阅读网这类**没有** webView 的源反而能弹浏览器 —— 因为它走 HTTP，撞盾就被重放接管了。
   *
   * @param url 渲染的页面地址
   * @param html 渲染结果（已判定为挑战页）
   * @param via 挑战页判据（Cloudflare / WAF …），日志用
   */
  renderChallenge?: (url: string, html: string, via?: string) => Promise<string | undefined>;
  /** 流式回调，可选 */
  emit?: (evt: EngineEvent) => void;
  /**
   * `java.toast` / `java.longToast` 收集器（可选）。
   *
   * 为什么必须挂在 ctx 上、而不是逐调用点传参：源脚本弹 toast 与**阶段无关** ——
   * 搜索 / 详情 / 目录 / 正文 / 登录任何一步都可能弹（语料里大量源用 toast 报
   * 「未登录」「解析失败」「已切换线路」）。早期只有登录流程传了 sink
   * ⇒ 其余四个阶段的 toast **全部静默丢弃**，用户只看到「点了没反应」。
   *
   * 宿主传一个数组进来，引擎（L1）与 worker 沙箱各把每条文本按序 push；
   * 请求结束后宿主把数组回传前端，逐条弹 Android 风格 Toast。
   */
  toastSink?: string[];
  /**
   * `#512` **详情/目录分阶段推送**：`detail` 在「书籍信息就绪、目录尚未开始解析」时回调一次。
   *
   * 为什么需要它：目录往往是详情页最耗时的部分（一次额外抓取 + 数百上千章逐章求值），
   * 而书名/作者/简介/封面在目录阶段**之前**就求值完了 —— 旧实现把两者塞进同一个返回值，
   * 前端只能等目录才能渲染，用户看到的就是「详情页空白好几秒」。
   * 只有走 SSE 的详情请求会传它；普通 JSON 请求为 `undefined` ⇒ 引擎行为零变化。
   */
  onPartial?: (d: UnifiedDetail) => void;
}

// ---------------------------------------------------------------------------
// 引擎接口
// ---------------------------------------------------------------------------

export interface CompileResult<TRule> {
  ok: boolean;
  rule?: TRule;
  /** 编译期发现的问题（不致命，但提示用户） */
  issues: ValidationIssue[];
}

export interface ValidationIssue {
  level: 'error' | 'warn' | 'info';
  /** JSON 路径，例如 ruleSearch.name */
  path?: string;
  message: string;
}

/**
 * 所有引擎都要实现的接口。
 *
 * 注意所有方法都是可选的（除了 kind / detect / compile），
 * 因为不同引擎能力不同：MacCMS 没有 content，Legado 小说源没有 play。
 * 调用方用 capabilities 判断，或者直接判断方法是否存在。
 */
export interface RuleEngine<TRule = unknown, TRaw = unknown> {
  /** 引擎标识：'legado' | 'maccms' | 'zyfun' | ... */
  readonly kind: string;
  readonly version: string;
  readonly capabilities: EngineAction[];

  /** 这份配置你能不能认领？facade 靠它分发 */
  detect(raw: TRaw): boolean;

  /**
   * `#652` **声明「只靠 kind 提示认领」**（默认 `false`）。
   *
   * 背景：`detect` 是自动识别判据，但**内置演示引擎**刻意 `detect() => false`
   * （「不自动认领任何源；仅通过 preferred 显式注册」）。而 `#652` 修的是另一半：
   * 库里 `kind` 列存错时不能让源永久装不起来 ⇒ `detect(raw, preferred)` 现在**先问 preferred 认不认**。
   * 这两条要同时成立，就得让「只靠提示认领」的引擎显式声明自己 —— 而不是所有引擎都退回去
   * 无条件信任 `kind`（那正是 `#652` 的病根）。
   */
  readonly preferredOnly?: boolean;

  /** 预编译（解析规则字符串、缓存正则），避免每次请求重复解析 */
  compile(raw: TRaw): CompileResult<TRule>;

  /** 静态校验，给编辑界面用 */
  validate?(rule: TRule): ValidationIssue[];

  home?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult>;
  category?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult>;
  search?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult>;
  detail?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedDetail>;
  content?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedContent>;
  play?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedPlay>;

  /**
   * 源登录（Legado BaseSource.login()：执行 loginUrl 的 JS；或返回需打开的登录页 URL）。
   * 返回 ok=false 且 action='browser' 时，调用方应交给桌面端/前台浏览器完成。
   */
  login?(rule: TRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedLoginResult>;

  /**
   * 图片字节二次解密（Legado ContentRule.imageDecode / BaseSource.coverDecodeJs）。
   * 源未声明解密规则或解密失败时返回 null（调用方回传原图）。
   */
  decodeImage?(
    rule: TRule,
    req: { url: string; bytes: Uint8Array; isCover?: boolean },
    ctx: EngineContext,
  ): Promise<Uint8Array | null>;

  /**
   * `#583` **源脚本 UI 动作**（Legado 图片选项 `click` / `ruleContent.callBackJs` 的宿主出口）。
   *
   * 为什么必须在引擎里跑：`click` 片段调的是**源 jsLib 的函数**（`qmC_OpenComment` …），
   * 里面还有 `java.ajax` 签名请求与 `source.get/put`。浏览器侧没有这套环境。
   * 实现见 `engine-legado`：与 `detail/content` 共用同一份 `makeEnv`（同一套 jsLib / 源桩 / 请求头）。
   *
   * 返回的 `browserUrl` 来自 `java.showBrowser` / `startBrowser` —— 即「源要求打开的页面」。
   */
  evalUiAction?(rule: TRule, req: UiActionRequest, ctx: EngineContext): Promise<UiActionResult>;

  dispose?(): void;
}
