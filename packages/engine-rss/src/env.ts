/**
 * RSS 引擎的求值环境（第二批：RssParserByRule 规则引擎）
 *
 * 为什么单独一个文件：`AnalyzeRule`（core/selector）需要 `AnalyzeEnv`（JS 求值器、
 * 变量作用域、URL 绝对化），engine-legado 的 `makeEnv` 与书源上下文强耦合且不导出。
 * RSS 源规则（语料 236/331 个带 ruleArticles，其中 149 个的字段规则含 JS/{{}}）
 * 需要一份**精简但同源**的 env 构造 —— 求值器、worker 池路由、规则桥全部用
 * core 的同一套实现（createJsEvaluator / createHybridJsEvaluator），
 * 只有 source 桩按 RssSource 字段裁剪。
 *
 * URL 构建对齐上游（2026-10-06 精读，全部有源码依据）：
 *  - `RssViewModel.getSingleUrl`（sortUrl）：① `<js>`/`@js:` 前缀**先执行**（结果非空才替换）；
 *    ② 含 `::` 取后段；③ 空回落 sourceUrl —— 顺序不能反（第一批只做了 ②，JS 型 19 源必挂）。
 *  - `Rss.getArticlesAwait` → `AnalyzeUrl(sortUrl, page, key, baseUrl=sourceUrl)`：
 *    `{{}}` 内嵌求值（`{{page}}`/`{{key}}`/`{{java.base64Encode(...)}}`/规则 `{{$..x}}`）。
 *  - searchUrl 同走 AnalyzeUrl（无 `::` 逻辑）。
 */

import { createHash } from 'node:crypto';

import {
  AnalyzeRule,
  createJsEvaluator,
  createHybridJsEvaluator,
  isRuleExpr,
  jsonGetString,
  resolveUrl,
  splitUrlOptions,
  optionToRequest,
  // `#382`：URL 中缀 `@js:`/`<js>` 求值（上游 AnalyzeUrl.analyzeJs 全文扫描语义，core 唯一实现）
  applyUrlRuleJs,
  // `#344`：jsLib 三形态归一（JSON 映射表 / 单 URL / 内联 JS）—— core 唯一实现
  resolveJsLibText,
  // `#381`：映射表/单 URL 的 URL 收集（primeJsLib 预下载用）
  jsLibUrls,
  // `#708`：外链脚本取数的「重试 + 总预算」——与 worker 的 `java.importScript` 同一份策略
  fetchScriptTextRetry,
  SCRIPT_FETCH_POLICY,
  // `#732`：外链脚本本地镜像 / 离线缓存（jsLib · loginUrl · sortUrl 的共同出口；网络优先、镜像兜底）
  readJsMirror,
  writeJsMirror,
  noteJsMirrorFailure,
  /** 拒收「浏览器文本阅读器 DOM」当脚本（`.js` 撞 WAF 被重放时的污染） */
  isMarkupDocumentBody,
  isRenderedTextDocument,
  type ScriptFetchAttempt,
  curlSyncFetch,
  type AnalyzeEnv,
  type EngineContext,
  type JsSandboxPool,
  makeRuleBridge,
  /** `#314`：`BaseSource` 登录信息族（BookSource 与 RssSource **共用**）的唯一实现 */
  makeSourceLoginStub,
  // `#331`：source.putConcurrent → 运行期改限频（上游 updateConcurrentRate 同名语义）
  updateConcurrentRate,
  // `#467`：源 header 规则求值（脚本形态 + 归一 + memo/防重入）的唯一实现（两引擎 + /api/proxy 共用）
  createSourceHeaderResolver,
  evaluateSourceHeaderRule,
  parseStaticSourceHeader,
  readSourceHeaderMemo,
  type SourceHeaderResolver,
} from '@yuedu/core';
import type { RssSourceRule } from './model/rss-source';

/** 兜底留痕（对齐铁律 3：静默兜底 = 形同问题的温床；同 key 只打一次防刷屏） */
const warned = new Set<string>();
export function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.log(`[rss] ${msg}`);
}

/** jsLib 远程下载缓存（进程内；上游 `SharedJsScope` 也是按 md5(url) 缓存） */
const jsLibCache = new Map<string, string>();

/** 测试专用：读进程内 jsLib 缓存（判断「网络内容 / 镜像兜底 / 都没拿到」三种结局） */
export function __jsLibCacheForTest(): Map<string, string> {
  return jsLibCache;
}

/**
 * `#708` **失败负缓存 + 在飞去重**（与 `engine-legado` 的 `jsLibFailedAt` 同语义）。
 *
 * 为什么必须有：Movieffm 这类源的 `loginUrl`/`sortUrl` 每个动作都会重建 env 并 prime 一次；
 * 外链主机慢时，一次用户操作里的 home/category 并发 prime 会对**同一个 URL** 叠出 6 次 12s
 * 超时 ⇒ 直接触发「同域名连续 6 次失败 ⇒ 全局熔断 40s」⇒ 后续 sortUrl/loginUrl 全被误伤。
 * 失败负缓存把「一次行动里反复打同一个死站」挡住，在飞去重让并发调用只发一次网络请求。
 */
const jsLibFailedAt = new Map<string, number>();
const JSLIB_FAIL_TTL_MS = 5 * 60_000;
const jsLibInFlight = new Map<string, Promise<void>>();
/** 跨进程持久层（与 `engine-legado` 同一前缀/键算法 ⇒ 两引擎共用一份下载结果） */
const JSLIB_STORE_PREFIX = 'jslib:';
function jsLibStoreKey(url: string): string {
  return JSLIB_STORE_PREFIX + createHash('md5').update(String(url), 'utf-8').digest('hex');
}

/**
 * `#344` jsLib 归一 —— 走 core `resolveJsLibText`（唯一实现），下载器用共用同步取文。
 * 支持三形态：JSON 映射表 / 单 URL / 内联 JS（上游 `SharedJsScope.kt:231-276`）。
 */
function resolveJsLib(lib?: string | null): string | undefined {
  const s = String(lib ?? '').trim();
  if (!s) return undefined;
  const fetchJs = (url: string): string | null => {
    const hit = jsLibCache.get(url);
    if (hit !== undefined) {
      if (isMarkupDocumentBody(hit)) jsLibCache.delete(url);
      else return hit;
    }
    /**
     * `#732` **网络优先、镜像兜底**（用户 2026-11-02 反转顺序）：
     * 同步 curl 先按原行为发请求；失败（异常 / 非 2xx / 空体）才查镜像。
     */
    let failure = '';
    try {
      const r = curlSyncFetch({ url, method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (compatible; yuedu/0.1)' }, timeoutMs: 20000 });
      if (r && r.status >= 200 && r.status < 300 && r.body) {
        if (isMarkupDocumentBody(r.body)) {
          // 浏览器重放把 `.js` 渲染成 HTML 文档时不能当脚本缓存（`Unexpected token '<'`）
          failure = '响应是 HTML 文档（非脚本原文）';
        } else {
          jsLibCache.set(url, r.body);
          writeJsMirror(url, r.body);
          return r.body;
        }
      } else {
        failure = r && r.status ? `HTTP ${r.status} 空响应` : '请求超时或空响应';
      }
    } catch (e) {
      failure = `连接错误：${(e as Error)?.message ?? e}`;
    }
    const mirror = readJsMirror(url, { reason: failure });
    if (mirror) {
      jsLibCache.set(url, mirror.text);
      return mirror.text;
    }
    noteJsMirrorFailure(url, failure);
    return null;
  };
  const out = resolveJsLibText(s, fetchJs);
  if (out === undefined) {
    warnOnce(`jslib-fail:${s.slice(0, 40)}`, `jsLib 解析/下载失败，按无 jsLib 处理：${s.slice(0, 80)}`);
  }
  return out;
}

/**
 * `#381` jsLib **异步预下载**（prime）—— 在引擎各 public 入口（home/category/search/detail/
 * content/login）**先于 `makeRssEnv`** 执行，把映射表/单 URL 形态的 jsLib 用 **ctx.http**
 * （统一栈：注入 HttpClient / UA / 代理 / Cookie 回收）拉进 `jsLibCache`。
 *
 * 为什么必须预下载：`resolveJsLib` 的同步下载器是 **curl 子进程**（curlSyncFetch）——
 * 本机/受限环境起不了子进程（实测 EBUSY，#197 同因）⇒ 同步下载恒失败 ⇒ qyyuapi 五源
 * 的 `Get`/`Reload`（common.js / jsLib.js 里定义）全部未定义 ⇒ 分类退化 RULE_PARSE。
 * 上游 `SharedJsScope` 是**异步**下载（协程），本仓同步求值面拿不到异步结果 ⇒ 唯一解法
 * 就是「入口先 prime、求值面只读缓存」——缓存仍是同一份（单实现），curl 只作兜底。
 */
export async function primeJsLib(ctx: EngineContext, rule: RssSourceRule): Promise<void> {
  const urls = jsLibUrls(String(rule.raw.jsLib ?? ''));
  if (!urls.length) return;
  await Promise.all(
    urls.map(async (u) => {
      const mem = jsLibCache.get(u);
      if (mem !== undefined) {
        if (isMarkupDocumentBody(mem)) jsLibCache.delete(u);
        else return;
      }
      /**
       * `#708` **并发去重**：同一个 URL 的多个 prime（home/category/search 并发）共享一次网络请求。
       * 否则慢主机上 6 次并发超时就会越过熔断阈值，把**别的**请求也一起熔断。
       */
      const running = jsLibInFlight.get(u);
      if (running) return running;
      const run = (async (): Promise<void> => {
        /**
         * `#732` **网络优先**（用户 2026-11-02 反转了原「镜像优先」）：先正常发请求；
         * 只有失败才查本地镜像兜底，两者都失败才报错并累计「请手动下载」提示。
         */
        // ① 持久层（跨进程；与 engine-legado 共用 `jslib:<md5>`）—— 原行为，属网络结果的缓存
        try {
          const stored = await ctx.storage.get(jsLibStoreKey(u));
          if (typeof stored === 'string' && stored && !isRenderedTextDocument(stored)) {
            jsLibCache.set(u, stored);
            return;
          }
          if (typeof stored === 'string' && stored) {
            console.warn(`[rss] jsLib 持久层内容是 HTML 文档（非脚本原文），忽略并回源：${u.slice(0, 90)}`);
          }
        } catch {
          /* 存储读失败按「没有」处理，继续走网络 */
        }
        // ② 失败负缓存（5 分钟内不再重试；视为「网络已知失败」⇒ 直接进镜像兜底）
        const failedAt = jsLibFailedAt.get(u);
        const knownFailed = failedAt !== undefined && Date.now() - failedAt < JSLIB_FAIL_TTL_MS;
        // jsLib 里的 URL 常含**中文路径**（qyyuapi.com/dy/js/剧迷/jsLib.js）——
        // encodeURI 只编码非 ASCII 与空格，不破坏结构；已编码的 % 序列原样保留。
        const url = encodeURI(u);
        let text = '';
        let failure = knownFailed ? '网络失败负缓存（5 分钟内不再重试）' : '';
        let attempts = 0;
        if (!knownFailed) {
          /**
           * `#708` 与 worker `java.importScript` 用**同一份策略**（`SCRIPT_FETCH_POLICY`）：
           * 单次 20s、最多 3 次、总预算 45s；4xx 不重试。旧实现走 `ctx.http` 默认 12s 且不重试，
           * 实测 qyyuapi 的 jsLib/common.js 在 12~40s 之间抖动 ⇒ 首次必死 ⇒ 熔断误伤后续请求。
           */
          const outcome = await fetchScriptTextRetry(async (timeoutMs): Promise<ScriptFetchAttempt> => {
            const resp = await ctx.http.request(url, {
              method: 'GET',
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              },
              timeout: timeoutMs,
            });
            const body = typeof resp.body === 'string' ? resp.body : Buffer.from(resp.body).toString('utf-8');
            return { text: body, code: resp.status };
          });
          text = outcome.text;
          attempts = outcome.attempts;
          failure = outcome.failure || (text.trim() ? '' : '内容为空');
          if (text.trim() && isMarkupDocumentBody(text)) {
            // 浏览器重放把 `.js` 渲染成 HTML 文档：不能当脚本缓存，按网络失败走镜像兜底
            failure = '响应是 HTML 文档（非脚本原文）';
            text = '';
          }
        }
        if (text.trim()) {
          // 网络成功 ⇒ 用网络内容 + 回写镜像（失败计数清零；不因镜像存在而改用旧镜像）
          jsLibCache.set(u, text);
          jsLibFailedAt.delete(u);
          writeJsMirror(u, text);
          try {
            await ctx.storage.set(jsLibStoreKey(u), text);
          } catch {
            /* 落盘失败只是下次要重下，不影响本次 */
          }
          if (attempts > 1) {
            console.log(`[rss] jsLib 第 ${attempts} 次尝试成功（预算 ${SCRIPT_FETCH_POLICY.totalBudgetMs}ms）：${u.slice(0, 110)}`);
          }
          return;
        }
        jsLibFailedAt.set(u, Date.now());
        // ③ 网络失败 ⇒ **镜像兜底**（`readJsMirror` 会打「镜像兜底命中（原因：…）」）
        const mirror = readJsMirror(u, { reason: failure });
        if (mirror) {
          jsLibCache.set(u, mirror.text);
          return;
        }
        // ④ 两者都失败 ⇒ 明确报错 + 连续失败计数（到阈值提示「请手动下载」，同 URL 只提示一次）
        noteJsMirrorFailure(u, failure);
        /**
         * 失败必须带上每次的原因（超时/DNS/4xx/空体）——旧日志只有一句「异常」，
         * #636 卡两轮就是因为「12s 超时」和「站点回空」在日志里长得一样。
         */
        warnOnce(`jslib-prime:${u}`, `jsLib 预下载失败（本地镜像未命中；网络：${failure}），按无该库处理：${u}`);
      })();
      const wrapped = run.finally(() => {
        jsLibInFlight.delete(u);
      });
      jsLibInFlight.set(u, wrapped);
      return wrapped;
    }),
  );
}

/** 源 header 留痕：channel（core 给）→ 带源身份的一行（同 key 只打一次）。 */
function headerWarn(rule: RssSourceRule): (channel: 'shape' | 'eval' | 'static', detail: string) => void {
  const who = `源 ${rule.sourceName}(${rule.sourceUrl})`;
  return (channel, detail) => {
    if (channel === 'static') {
      warnOnce(`header:${rule.sourceUrl}`, `${who} 的 ${detail}，本引擎暂不解析（按无自定义头请求）`);
    } else if (channel === 'shape') {
      warnOnce(`header-shape:${rule.sourceUrl}`, `${who} 的 ${detail}（按无自定义头请求）`);
    } else {
      warnOnce(`header-eval:${rule.sourceUrl}`, `${who} 的 ${detail}（按无自定义头请求）`);
    }
  };
}

/** 源级默认请求头（**纯 JSON** 形态）：RSS 源的 header 97/131 是纯 JSON。脚本形态见 `parseHeaderRule`。 */
export function parseSourceHeaders(rule: RssSourceRule): Record<string, string> {
  const raw = rule.header?.trim();
  if (!raw) return {};
  const parsed = parseStaticSourceHeader(raw);
  if (parsed) return parsed;
  // 注：脚本形态（@js:/<js>）在「无 memo 的出口回落」里也会走这条留痕 —— 保持 #464 前既有口径
  warnOnce(`header:${rule.sourceUrl}`, `源 ${rule.sourceName}(${rule.sourceUrl}) 的 header 非 JSON，本引擎暂不解析（按无自定义头请求）`);
  return {};
}

/**
 * 源级请求头的**解析入口**（`#467` 起判据本体在 core `evaluateSourceHeaderRule`，
 * 对齐上游 `BaseSource.getHeaderMap`：`extractInlineJs(header)?.let { evalJS(it) } ?: header`）。
 *
 * 求值由调用方注入（`evalJs`）：引擎侧用 `jsEvalSync`（与 JS 规则段同一求值器，含 jsLib 前导），
 * 这样源里 `getUrl()` / `getKey()` / `token` 这些 **jsLib 全局**才拿得到。
 */
export function parseHeaderRule(
  rule: RssSourceRule,
  evalJs: (code: string) => unknown,
): Record<string, string> {
  return evaluateSourceHeaderRule({ raw: rule.header, evalJs, warn: headerWarn(rule) });
}

/** 绑到一次请求（ctx.variables）的取头器：memo + 防重入 + 同步/异步两路径（core 唯一实现）。 */
function makeHeaderResolver(
  ctx: EngineContext,
  rule: RssSourceRule,
  /** 同步求值器（L1，安全网）；通常延迟创建（见 makeRssEnv）。 */
  evalJs: (code: string) => unknown,
): SourceHeaderResolver {
  return createSourceHeaderResolver({
    variables: ctx.variables,
    getRaw: () => rule.header,
    evalJs,
    warn: headerWarn(rule),
  });
}

/**
 * 请求出口用的源级头（**同步**读 memo；没有 memo 时回落纯 JSON 解析 —— **绝不跑脚本**，
 * 否则 header 脚本里的 `java.ajax` 会在请求出口递归）。`fetchText` / 渲染层出口都从这里取。
 */
export function sourceHeadersFromCtx(ctx: EngineContext, rule: RssSourceRule): Record<string, string> {
  return readSourceHeaderMemo(ctx.variables) ?? parseSourceHeaders(rule);
}

/**
 * RSS 源的 `source` 桩（对齐上游 BaseSource JS 可用面，按 RSS 源实际用到的方法裁剪）：
 * 字段展开 + key/getKey + get/put + getVariable/setVariable/putVariable + getHeaderMap + getComment，
 * **外加 `BaseSource` 的登录信息族**（`getLoginInfoMap` / `getLoginInfo` / `putLoginInfo` /
 * `getLoginHeader( Map )` / `putLoginHeader` / `removeLoginHeader` / `removeLoginInfo`）。
 * get/put 与 getVariable 两套命名空间分开（对齐 BaseSource.kt:336-356 的两套 CacheManager 键），
 * 落点为本次请求的 variables（跨请求持久化待与书源统一时接入，本批请求内一致即可）。
 *
 * ★ 登录信息族**必须展开 `makeSourceLoginStub(ctx)`**（`#314`）：上游 `BaseSource.kt:257`
 *   `getLoginInfoMap()` 是 BookSource / RssSource 的**公共能力**，订阅源脚本第一行就在用它
 *   （语料 `影视聚合(资源站)` 的 `sortUrl` 脚本：`let loginInfo = source.getLoginInfoMap();`）。
 *   本引擎此前整块没有这个方法 ⇒ `is not a function` ⇒ **整个分类脚本崩、分类退化成「整源」**
 *   （用户 2026-10-07 报障的根因，探针实测 `tmp/probe-rss-login.log`）。
 */
export function makeRssSourceStub(
  ctx: EngineContext,
  rule: RssSourceRule,
  sourceHeaders: () => Record<string, string>,
): Record<string, unknown> {
  const kvKey = 'rss-cache';
  const readCache = (): Record<string, string> => {
    try {
      return JSON.parse((ctx.variables.get(kvKey) as string | undefined) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };
  const writeCache = (o: Record<string, string>): void => ctx.variables.set(kvKey, JSON.stringify(o));
  return {
    ...rule,
    ...rule.raw,
    ...makeSourceLoginStub(ctx),
    sourceUrl: rule.sourceUrl,
    sourceName: rule.sourceName,
    sourceGroup: rule.sourceGroup ?? '',
    sourceComment: rule.sourceComment ?? '',
    key: rule.sourceUrl,
    getKey: () => rule.sourceUrl,
    get: (k: unknown) => readCache()[String(k)] ?? '',
    put: (k: unknown, v: unknown) => {
      const o = readCache();
      o[String(k)] = String(v ?? '');
      writeCache(o);
    },
    getVariable: () => (ctx.variables.get('sourceVariable') as string | undefined) ?? '',
    /**
     * ★ **bean 属性形态**（`#317`）：上游 Rhino 把 Java bean getter 暴露成同名属性
     *   （`BaseSource.getVariable(): String` = `CacheManager.get(...) ?: ""` ⇒ **空串**，
     *   `BaseSource.kt:337`）⇒ 源脚本写 `source.variable` **等价于** `source.getVariable()`。
     *   本仓桩只有方法 ⇒ `source.variable` 是 `undefined` ⇒ `String(source.variable) || "默认"`
     *   这类**防空写法**失效（`String(undefined)` = `"undefined"` 是 truthy）。
     *   语料实证：`24凹凸`/`凹凸吧` 的搜索分类 `wd={{String(source.variable) || "美女"}}`
     *   被我们渲染成 `wd=undefined`（真跑取证）。getter 保持活性（`setVariable` 后再读是新值）。
     */
    get variable() {
      return (ctx.variables.get('sourceVariable') as string | undefined) ?? '';
    },
    setVariable: (v: unknown) => ctx.variables.set('sourceVariable', String(v ?? '')),
    putVariable: (v: unknown) => ctx.variables.set('sourceVariable', String(v ?? '')),
    getHeaderMap: () => sourceHeaders(),
    getComment: () => rule.sourceComment ?? '',
    // ⚙️ `#331`：`putConcurrent(value)` 上游 = `updateConcurrentRate(getKey(), value)`
    // （BaseSource.kt:401 → ConcurrentRateLimiter）——运行期改限频，RssSource 与 BookSource 同能力。
    putConcurrent: (v: unknown) => {
      updateConcurrentRate(ctx.sourceId, v);
      return true;
    },
    /** Legado `BaseSource.hasLogin()`：`loginUrl` / `loginUi` 有其一即为「可登录源」 */
    hasLogin: () => !!String(rule.loginUrl ?? '').trim() || !!String(rule.loginUi ?? '').trim(),
  };
}

/**
 * `#463①` 每个在飞请求的源级头**异步预求值** promise（worker 池路径）。
 * WeakMap ⇒ ctx 销毁即回收，无泄漏。多个 env（如 resolveSingleUrl 先建一个）按序串成链：
 * 后一个 prime 等前一个落地（无论成败都写 memo）再读 memo —— 不会把「别人求值中」误判成重入。
 */
const headerPrimes = new WeakMap<EngineContext, Promise<void>>();

function trackHeaderPrime(ctx: EngineContext, run: Promise<Record<string, string>>): void {
  const prev = headerPrimes.get(ctx) ?? Promise.resolve();
  const next = prev.then(() => run, () => run).then(() => undefined);
  headerPrimes.set(ctx, next);
}

/** 请求出口发请求前 await：等源级头异步预求值落地（无 prime ⇒ 立即过）。 */
export function whenSourceHeadersPrimed(ctx: EngineContext): Promise<void> {
  return headerPrimes.get(ctx) ?? Promise.resolve();
}

/**
 * `#600` **源变量就绪**（幂等：每个 ctx 只做一次）。
 *
 * ## 为什么需要（两层原因叠在一起）
 * ① **RSS 引擎此前根本没有源变量的持久层** —— `source-var:<id>` 的 prime/persist 只写在
 *    `engine-legado` 里（`primeSourceState`/`persistSourceState`，包内私有）。所以本引擎
 *    `source.getVariable()` **恒为空串**，哪怕磁盘上早就有值。
 * ② 聚合类源（qyyuapi 系 9 个）的 jsLib / header / sortUrl 全靠 `Get()` ——
 *    `Get()` 的实现就是 `JSON.parse(source.getVariable())`。空串 ⇒ `JSON.parse('')` 抛
 *    ⇒ header 与分类脚本全崩（全量基线 2026-10-24：`#600`）。
 * 而源变量的唯一初始化入口是 `loginUrl` 那段脚本（`eval(String(Reload('.../loginUrl.js')))`，
 * 内部 `$$$ = JSON.parse(source.getVariable()); catch { $$$ = original; put($$$); }`）。
 *
 * ## 三步（顺序不能反）
 * ① 读持久层 `source-var:<id>`（与 legado **同一个键**，两引擎共用一份数据）；
 * ② 仍为空 且 `loginUrl` 是**语句**形态 ⇒ 跑一次（表单式见下）；
 * ③ 拿到值就**落盘**，否则下次又是空的。
 *
 * ## 为什么「表单式」不自动跑
 * `loginUrl` 定义了 `function login(` 的是「表单 + 用户点登录」形态（Legado `SourceLogin` 由 UI
 * 触发），且常依赖 `getLoginInfo()` 里用户填的账号密码 —— 自动跑只会写进一份空登录态。
 */
const SOURCE_VAR_KEY = (sourceId: string): string => `source-var:${sourceId}`;

const varInitPrimed = new WeakMap<EngineContext, Promise<void>>();

export function primeSourceVariable(ctx: EngineContext, rule: RssSourceRule): Promise<void> {
  const memo = varInitPrimed.get(ctx);
  if (memo) return memo;
  const run = (async (): Promise<void> => {
    const who = `源 ${rule.sourceName}(${rule.sourceUrl})`;
    // ① 持久层
    let cur = String(ctx.variables.get('sourceVariable') ?? '');
    if (!cur.trim()) {
      try {
        const stored = await ctx.storage.get(SOURCE_VAR_KEY(ctx.sourceId));
        if (stored) {
          ctx.variables.set('sourceVariable', stored);
          cur = stored;
        }
      } catch {
        /* 存储失败按「没有」处理（不阻断请求） */
      }
    }
    if (cur.trim()) return;
    // ② loginUrl 初始化（仅语句形态）
    const code = String(rule.loginUrl ?? '').trim();
    if (!code) return;
    if (/function\s+login\s*\(/.test(code)) return;
    const env = makeRssEnv(ctx, rule, rule.sourceUrl, undefined, { noHeaderPrime: true });
    try {
      await env.jsEval(code, { source: env.sourceData ?? {}, baseUrl: rule.sourceUrl });
    } catch (e) {
      warnOnce(
        `varinit:${rule.sourceUrl}`,
        `${who} 的 loginUrl 初始化失败：${e instanceof Error ? e.message : String(e)}（源变量仍为空，Get() 会缺值）`,
      );
      return;
    }
    // ③ 落盘
    const v = String(ctx.variables.get('sourceVariable') ?? '');
    if (!v.trim()) {
      warnOnce(
        `varinit-empty:${rule.sourceUrl}`,
        `${who} 的 loginUrl 跑完仍没写源变量（Get() 会缺值；该源可能需要先手动登录一次）`,
      );
      return;
    }
    try {
      await ctx.storage.set(SOURCE_VAR_KEY(ctx.sourceId), v);
    } catch {
      /* 落盘失败不影响本次结果，只是下次要重跑 loginUrl */
    }
  })();
  varInitPrimed.set(ctx, run);
  return run;
}

// `describeRuleNode` 已移到 `@yuedu/core` 的 `selector/rule-bridge.ts`（`#313`）：
// 它此前在本文件与 `engine-legado/engine.ts` 各写一遍（**逐字相同**的重复）。

/**
 * 构造 AnalyzeEnv（求值器走 core 同一套：L1 同步 + hybrid worker 池路由）。
 * `baseUrl` = sortUrl（每次请求更新 —— envRef 引用当前 env，toAbsolute 惰性取 baseUrl）。
 */
export function makeRssEnv(
  ctx: EngineContext,
  rule: RssSourceRule,
  baseUrl: string,
  /**
   * RSS 文章实体字段（`rssArticle`）—— 上游 `AnalyzeRule(rssArticle, rssSource)` 的 ruleData。
   * 只在正文阶段有值（列表阶段还没有单篇文章）。
   */
  rssData?: Record<string, unknown>,
  /**
   * `#600`：**不启动**源级头的异步 prime。
   *
   * 只给 {@link primeSourceVariable} 用 —— 它要「先把源变量初始化好，再让 header 脚本求值」，
   * 而初始化本身需要建一个 env 来跑 loginUrl。若这个 env 也去 prime header，就会形成
   * 「primeSourceVariable → makeRssEnv → primeSourceVariable」的自我递归。
   */
  opts?: { noHeaderPrime?: boolean },
): AnalyzeEnv {
  /**
   * 源级请求头（源 `header` 规则 ⊕ `@js:` 求值）——memo/防重入的判据本体在 core
   * （`createSourceHeaderResolver`，`#467`），并有两条求值路径：
   *   · **异步 prime**（`#463①`，V6 治本）：env 建成后用 **hybrid（worker 池）**求值器跑一次，
   *     请求出口 `await whenSourceHeadersPrimed(ctx)` 后读 memo ⇒ 主线程零脚本开销；
   *   · **同步安全网**：同步上下文（规则脚本内 `source.getHeaderMap()`）在 prime 落地前
   *     首次取用时，用 L1 求值器延迟求值（与 `#464` 行为一致）。
   * 防重入：header 脚本内部若再触发取头（`java.ajax` / `this.getHeaderMap()`）⇒ 空表，
   * 不无限递归（标志在 `ctx.variables`，worker 经 RPC 回宿主取头时也同一份）。
   *
   * 求值器**延迟创建**：它由 `syncEvalOpts` 建，而 `syncEvalOpts` 又引用本函数 ⇒ 建早了就循环。
   */
  let syncEvalLazy: ReturnType<typeof createJsEvaluator> | null = null;
  const headerResolver = makeHeaderResolver(ctx, rule, (code) => {
    if (!syncEvalLazy) syncEvalLazy = createJsEvaluator(syncEvalOpts);
    return syncEvalLazy(code, {
      baseUrl: rule.sourceUrl,
      ...(envRef?.sourceData ? { source: envRef.sourceData } : {}),
    });
  });
  const sourceHeaders = (): Record<string, string> => headerResolver.get();
  const javaExtra: Record<string, unknown> = {
    putVariable: (k: string, v: string) => ctx.variables.set(k, v),
  };
  let envRef: AnalyzeEnv | undefined;
  const evalRuleFull = (r: string, value: unknown): string => {
    const rr = r.trim();
    if (value != null && typeof value === 'object' && /^(\$\.|\$\[)/.test(rr)) {
      return jsonGetString(rr, value, { baseUrl, variables: ctx.variables, jsEval: () => '' });
    }
    if (envRef && value != null && value !== '') {
      try {
        return new AnalyzeRule(envRef).setContent(value, baseUrl).syncGetString(rr);
      } catch {
        return '';
      }
    }
    return '';
  };
  const onToast = (m: string): void => {
    const text = String(m ?? '').trim();
    if (!text) return;
    (ctx.toastSink)?.push(text);
    console.log(`[rss-toast] · 源 ${rule.sourceName}(${ctx.sourceId}) ${text}`);
  };
  /**
   * `java.upLoginData(data)` → 记进 `ctx.variables`，登录流程再随结果回传给前端的登录表单。
   *
   * 上游语义（`SourceLoginJsExtensions.kt:35-37` → `handleUpUiData`）：**只实时更新登录界面字段值**，
   * 不落库（18AV「🌐获取网址」`fabuye()` 取到最新域名后 `java.upLoginData({'网址': surl})`）。
   * 此前 core **整条 API 未实现**（Proxy 兜底空函数）⇒ 脚本静默空转，用户看到「toast 说已填写、输入框仍空」。
   */
  const onUpLoginData = (data: unknown): void => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (k && v != null) out[k] = String(v);
    }
    if (Object.keys(out).length) ctx.variables.set('__upLoginData', JSON.stringify(out));
  };
  /**
   * 「脚本要求打开浏览器」记录（`java.startBrowser` / `startBrowserAwait` / `webView`）。
   *
   * ★ 为什么 RSS 侧必须有（`#387`，用户实测 ˃̶͈ ꇴ ˂̶͈）：订阅源 `loginUi` 的**按钮行**
   * 语义就是 `java.startBrowser(url, '密钥')` ——「打开页面拿密钥，回来填进输入框」。
   * 此前只有 `onToast` 接了、这条通道**整个没接** ⇒ 按钮点了既不弹窗也不报错，
   * login 只回 `ok:true / action:'server'` ⇒ 界面显示「按钮动作已执行」，
   * 用户看到的是「4 个按钮都只弹一个登录成功提示」。
   *
   * 与 `engine-legado` 的 `onBrowserOpen` **同一语义**（两槽都要写）：单值槽供登录流程读，
   * 列表槽供「一次请求内多次要求开浏览器」不互相覆盖。
   */
  const onBrowserOpen = (u: string, kind?: 'show' | 'cookie'): void => {
    if (!u) return;
    ctx.variables.set('__browserUrl', u);
    /**
     * `#393` 记下这次是**哪种目的**（类型 = core `selector/js.ts` 的 `BrowserOpenKind`；
     * 它没走 core 桶导出，这里用同形字面量，编译期仍会与 core 的选项类型对齐）：
     *  · `cookie` = 脚本在等浏览器里的结果（`startBrowserAwait`）⇒ 必须本机真浏览器；
     *  · `show`   = 打开给人看（`startBrowser`，如「密钥」/「书源更新」按钮）⇒ 应用内浏览器就够，
     *               而且**只有应用内**才点得动页面里的「导入书源」。
     * ⚠️ 只要有一次 await 通道 ⇒ 整次登录按 cookie 处理（保守，不猜）。
     */
    if (kind === 'cookie') ctx.variables.set('__browserNeedCookie', '1');
    const prev = ctx.variables.get('__browserUrls');
    const list = Array.isArray(prev) ? (prev as string[]) : [];
    if (!list.includes(u)) list.push(u);
    ctx.variables.set('__browserUrls', list);
  };
  const syncEvalOpts = {
    variables: ctx.variables,
    cookies: ctx.cookies,
    // `#344`：jsLib 归一（JSON 映射表 ⇒ 逐个下载其 JS；单 URL ⇒ 下载；内联 ⇒ 原样）。
    // 旧实现把映射表 JSON 当脚本 eval ⇒ `Unexpected token ':'`（剧迷/Movieffm/西瓜卡通）。
    // 下载用 core 的共用同步取文（curl），进程内缓存，仅首次阻塞。
    lib: resolveJsLib(rule.raw.jsLib),
    javaExtra,
    evalRule: evalRuleFull,
    onToast,
    onUpLoginData,
    onBrowserOpen,
    getSourceHeaders: sourceHeaders,
    sourceLabel: `${rule.sourceName || '(无名)'}(${ctx.sourceId})`,
  };
  const env: AnalyzeEnv = {
    baseUrl,
    variables: ctx.variables,
    javaExtra,
    sourceData: makeRssSourceStub(ctx, rule, sourceHeaders),
    ...(rssData ? { rssData } : {}),
    jsEvalSync: createJsEvaluator(syncEvalOpts),
    jsEval: createHybridJsEvaluator({
      ...syncEvalOpts,
      // `#779` content 动作的纯计算求值预算（hub 只对 `action==='content'` 注入 20s；
      // 其余动作缺省 ⇒ 不覆盖，沿用 worker 池默认 10s）
      ...(ctx.jsComputeTimeoutMs ? { computeTimeoutMs: ctx.jsComputeTimeoutMs } : {}),
      pool: ctx.sandbox as JsSandboxPool,
      renderer: ctx.webRenderer,
      /**
       * 规则桥 —— **唯一实现**在 `@yuedu/core` 的 `selector/rule-bridge.ts`（`#313`）。
       * 此前本文件与 `engine-legado/engine.ts` 各写一份，加第三个 op 时当场漂移。
       */
      ruleBridge: makeRuleBridge({
        env: () => envRef,
        baseUrl,
        warn: (m) => warnOnce('rule-bridge', m),
      }),
      http: async (r) => {
        /**
         * `#708` **把 worker 点名的超时透到 HttpClient**（本引擎此前漏了这一步，与 legado 漂移）。
         *
         * 后果（用户 Movieffm 日志实证）：worker 的 `java.head` 固定 8s、`java.importScript`
         * 每次尝试 20s，但这条 wrapper 一律落到网络层的 class 默认 **12s** ⇒
         * `[rpc-http] HEAD … 请求超时（>12000ms）` 与 loginUrl「3 次尝试全空」。
         * 仍不得超过本次行动的剩余预算（`ctx.deadlineAt`），否则整体超时语义会被打穿。
         */
        const asked = Number(r.timeout);
        const remain = ctx.deadlineAt ? Math.max(1_000, ctx.deadlineAt - Date.now()) : 60_000;
        const timeout = Number.isFinite(asked) && asked > 0 ? Math.min(asked, remain) : Math.min(60_000, remain);
        const resp = await ctx.http.request(r.url, {
          method: r.method,
          headers: r.headers,
          ...(r.body !== undefined ? { body: r.body } : {}),
          timeout,
          // `#387c`：worker 侧 `java.get/post` 要求不跟随重定向（manual）——必须透到 HttpClient
          ...(r.redirect ? { redirect: r.redirect } : {}),
          // `#708`：HEAD 是 Reload 的可选 etag 探测，失败不得把同域名下能成功的 GET 一起熔断
          countBreaker: r.method !== 'HEAD',
        });
        const body = typeof resp.body === 'string' ? resp.body : Buffer.from(resp.body).toString('utf-8');
        return { status: resp.status, headers: resp.headers, body };
      },
    }),
    toAbsolute: (u) => resolveUrl(envRef?.baseUrl ?? baseUrl, u),
    putVariable: (k, v) => ctx.variables.set(k, v),
  };
  envRef = env;
  /**
   * ★ **请求出口在规则求值之前就要用源级头**（`fetchText` 发请求、渲染层回落）。
   *
   * `#463①`（V6 看门狗治本）：这里改为**异步预求值** —— 用 hybrid 求值器（worker 池）
   * 跑 header 脚本并落 memo，`fetchText` 发请求前 `await whenSourceHeadersPrimed(ctx)`。
   * 旧实现是在**主线程同步**跑这条脚本（L1）：header 脚本里的 `java.ajax` 是同步语义，
   * 看门狗实测过 47s 的主线程阻塞（`recover ms=47015`，在飞全是 category）⇒ 整条 UI 停摆。
   * 纯 JSON/空头形态在 core prime 里只落一个 memo 微任务，零实质开销；
   * worker 池不可用时 hybrid 自动回落 L1（语义与 `#464` 一致，只是换成异步时机）。
   */
  /**
   * `#600`：**源变量初始化必须早于 header 求值**。
   *
   * 聚合类源（qyyuapi 系 9 个）的 header 脚本里写 `{{Get('url')}}`/`Cache.get(Get('url')+'ck')`，
   * 而 `Get()` 读的是**源变量**（`source.getVariable()` ⇒ `$$$`）；源变量只在 `loginUrl`
   * 那段脚本里 `put($$$)` 初始化。此前 header prime 先跑 ⇒ `$$$` 还是空串 ⇒
   * `JSON.parse('')` 抛 ⇒ 整条 header/sortUrl 链崩（`#600`）。
   * ⇒ 用 `primeSourceVariable` 把两者串起来（它幂等，prepare 里也会先 await 一次）。
   */
  if (!opts?.noHeaderPrime) {
    trackHeaderPrime(
      ctx,
      primeSourceVariable(ctx, rule).then(() =>
        headerResolver.prime((code) =>
          env.jsEval(code, {
            baseUrl: rule.sourceUrl,
            ...(env.sourceData ? { source: env.sourceData } : {}),
          }),
        ),
      ),
    );
  }
  return env;
}

/**
 * URL 内嵌 `{{}}` 求值（对齐 legado 引擎 interpUrl / AnalyzeUrl.evalJS）：
 * `{{page}}`/`{{key}}`/`{{java.base64Encode(...)}}` 走 JS（page/key/baseUrl 绑定），
 * `{{$..x}}`/`{{@css:}}` 规则形态走 AnalyzeRule（isRuleExpr 判别，不猜测）。
 */
async function interpUrl(
  tpl: string,
  vars: { page: number; key?: string },
  env: AnalyzeEnv,
): Promise<string> {
  const matches = [...tpl.matchAll(/\{\{([\w\W]*?)\}\}/g)];
  if (!matches.length) return tpl;
  let out = '';
  let last = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    out += tpl.slice(last, idx);
    last = idx + m[0].length;
    const param = (m[1] as string).trim();
    let v: unknown;
    if (isRuleExpr(param)) {
      v = await new AnalyzeRule(env).setContent('').getString(param);
    } else {
      v = await env.jsEval(param, {
        $: '',
        result: '',
        key: vars.key ?? '',
        page: vars.page,
        baseUrl: env.baseUrl ?? '',
        source: env.sourceData ?? {},
      });
    }
    out += v == null ? '' : String(v);
  }
  out += tpl.slice(last);
  return out;
}

/**
 * feed 请求（`#328`）：URL + options 三元组（method/body/headers/charset）。
 * 上游 sortUrl/searchUrl 走 `AnalyzeUrl`，`url,{"method":"POST","body":…}` 尾巴
 * 的 method/body **本来就生效**（Lofter 的 tagPosts.api 必须 POST，GET 打出业务层
 * 500 ⇒ 列表恒 0 条）。本仓第一批只「剥离 + 留痕」，与上游语义不符 ⇒ 改为复用
 * core url-prep 的唯一实现（splitUrlOptions + optionToRequest，与 legado 引擎同一份判据）。
 */
export interface FeedRequest {
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  body?: string;
  headers?: Record<string, string>;
  charset?: string;
  /**
   * `#408` URL 选项 `type`（如 `data:;base64,<b64>,{"type":"18av"}`）。
   *
   * 上游 `AnalyzeUrl.kt:461-463`：`if (type != null) return StrResponse(url, HexUtil.encodeHexStr(getByteArrayAwait()))`
   * —— **有 `type` 时响应体不是文本，而是「原始字节的 hex 串」**，且在 WebView / charset 解码之前返回。
   * `data:;base64,…` 的 base64 由 HTTP 层（undici fetch 原生支持 data: URL）解出字节，
   * 源规则再 `java.hexDecodeToString(result)` 还原（18AV 的 base64 是**路径**，还原后自己拼 `surl()` 再请求）。
   */
  type?: string;
}

/**
 * 列表/搜索 URL 构建（对齐 RssViewModel.getSingleUrl + AnalyzeUrl）：
 * ① `<js>`/`@js:` 先执行（结果非空才替换）；② `::` 取后段（仅 sortUrl 分类语法）；
 * ③ 后段仍可是 `@js:` 型 → 再执行（AnalyzeUrl 对 JS URL 的语义）；
 * ④ `{{}}` 求值（page/key 绑定）；⑤ `,{options}` 尾巴 → method/body/headers/charset（core 唯一实现）；
 * ⑥ 相对 URL 以 sourceUrl 为基准补全（AnalyzeUrl baseUrl 语义）。
 *
 * 渲染层选项（webView/webJs/type）仍不生效 —— 属 `#305` 渲染层能力边界，留痕不静默。
 */
export async function buildFeedRequest(
  tpl: string,
  rule: RssSourceRule,
  env: AnalyzeEnv,
  opts: { page: number; key?: string; stripSortPrefix?: boolean },
): Promise<FeedRequest> {
  let raw = tpl.trim();
  if (!raw) return { url: rule.sourceUrl };
  const runJs = async (code: string, cur: unknown): Promise<string | null> => {
    try {
      // ⚠️ bindings **不传 java**：java 由求值器注入（makeJavaStub 的 Proxy，含 ajax/toast/base64Encode…），
      // 传 env.javaExtra 会遮蔽它 —— 实测 sortUrl JS 报 `java.ajax is not a function`（2026-10-06 冒烟）。
      // `cur`：上游 analyzeJs 的累积 result（`evalJS(code, result)`），跨 JS 段 / `@result` 拼接用。
      const result = await env.jsEval(code, {
        source: env.sourceData ?? {},
        baseUrl: env.baseUrl ?? '',
        page: opts.page,
        key: opts.key ?? '',
        result: cur == null ? '' : String(cur),
      });
      return result != null && String(result).trim() ? String(result).trim() : null;
    } catch (e) {
      // 上游 sortUrl JS 失败 → result 空 → AnalyzeUrl 对 `<js>…` 原文再跑也失败 = 请求失败。
      // 留原文继续会打出 `<js>…` 开头的垃圾 URL（实测教训），显式报错比静默跑错好。
      throw new Error(`sortUrl JS 执行失败（源 ${rule.sourceName}）：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // `#382`：`@js:`/`<js>` **全文扫描**（上游 AnalyzeUrl.analyzeJs 语义，core 唯一实现）。
  // 旧实现 jsPrefixOf 只认 `startsWith` ⇒ qyyuapi 聚合源 `Movieffm@js:`…`` 这种
  // 「分类名前缀 + 中缀 JS 标记」形态不触发求值 ⇒ 整条 `Movieffm@js:`…`` 被当 URL 请求 ⇒ URL 非法。
  raw = await applyUrlRuleJs(raw, (code: string, cur: string) => runJs(code, cur));
  if (opts.stripSortPrefix && raw.includes('::')) {
    raw = raw.split('::')[1]!.trim();
    // `::` 后段仍可能是 `@js:` 型（AnalyzeUrl 语义）
    raw = await applyUrlRuleJs(raw, (code: string, cur: string) => runJs(code, cur));
  }
  raw = await interpUrl(raw, opts, env);
  // `,{options}` 尾巴：拆分与映射都用 core url-prep（与 legado 引擎同一份判据，别自写）
  const split = splitUrlOptions(raw.trim());
  const opt = optionToRequest(split.option, {});
  if (split.option && typeof split.option === 'object') {
    // `#408` `type` 不再列入「不处理的渲染层字段」：它是**响应体编码开关**（见 FeedRequest.type），
    // 已在下方随 url 一起透出；只剩 webView/webJs 属 `#305` 渲染层能力边界。
    const ignored = ['webView', 'webJs'].filter((k) => split.option?.[k] != null && split.option[k] !== '');
    if (ignored.length) {
      warnOnce(`urlopt:${rule.sourceUrl}`, `源 ${rule.sourceName}(${rule.sourceUrl}) 的 URL options 含渲染层字段 ${ignored.join('/')}，本引擎暂不处理（#305 能力边界）`);
    }
  }
  let url = split.url;
  // javascript: / 相对补全（上游 AnalyzeUrl baseUrl=sourceUrl → NetworkUtils.getAbsoluteURL）：
  // 绝对 URL / data: URL 原样；javascript: 返回空（上游同）；其余按相对补全
  if (/^javascript:/i.test(url)) return { url: '' };
  if (!/^https?:\/\//i.test(url) && !/^data:/i.test(url)) {
    url = resolveUrl(rule.sourceUrl, url);
  }
  const charset = typeof split.option?.charset === 'string' && split.option.charset.trim() ? split.option.charset.trim() : undefined;
  // `#408` `type`（响应体 hex 开关）—— 上游 `AnalyzeUrl.kt:280 type = option.getType()`，非空即生效
  const type = typeof split.option?.type === 'string' && split.option.type.trim() ? split.option.type.trim() : undefined;
  return {
    url,
    ...(opt.method !== 'GET' ? { method: opt.method } : {}),
    ...(opt.body != null && opt.body !== '' ? { body: opt.body } : {}),
    ...(Object.keys(opt.headers).length ? { headers: opt.headers } : {}),
    ...(charset ? { charset } : {}),
    ...(type ? { type } : {}),
  };
}

/** 兼容包装：只回 URL（历史公共契约；`#304` detail 回源等 GET 路径继续用） */
export async function buildFeedUrl(
  tpl: string,
  rule: RssSourceRule,
  env: AnalyzeEnv,
  opts: { page: number; key?: string; stripSortPrefix?: boolean },
): Promise<string> {
  return (await buildFeedRequest(tpl, rule, env, opts)).url;
}
