/**
 * Legado 引擎（一期 L1 + L2-lite）
 *
 * 实现 contract/engine.ts 的 RuleEngine 接口：
 *   search / home（发现） / detail（详情+目录） / content（正文）
 *
 * 管道：request → parse（选择器引擎） → normalize（统一模型）。
 * 规则解析全部走 @yuedu/core 的 AnalyzeRule（对齐 Legado AnalyzeRule.kt）。
 */

import {
  AnalyzeRule,
  isRuleExpr,
  parseJsonLooseObject,
  makeStrResponse,
  readStrResponse,
  type AnalyzeEnv,
  createHybridJsEvaluator,
  createJsEvaluator,
  // `#344` jsLib 三形态归一（JSON 映射表 / 单 URL / 内联 JS）—— core 唯一实现
  resolveJsLibText,
  /** `#643` 渲染层产出的 DOM 也要过一遍撞盾判据（aff 的 CF 挑战页实测） */
  isChallengePage,
  /**
   * `#636`：`Reload()`/`importScript` 与这里的 jsLib 预下载必须用**同一套「瞬时错误」判词**
   * （唯一实现在 `core/selector/js-file.ts`）—— 两处各写一份正则就是漂移的开始。
   */
  isTransientScriptFetchError,
  // `#732` 外链脚本本地镜像 / 离线缓存（jsLib 与 java.importScript 的共同出口；网络优先、镜像兜底）
  readJsMirror,
  writeJsMirror,
  noteJsMirrorFailure,
  /** 拒收「浏览器文本阅读器 DOM」当脚本（`.js` 撞 WAF 被重放时的污染，见 `#732` 后续） */
  isMarkupDocumentBody,
  isRenderedTextDocument,
  resolveUrl,
  // `AnalyzeUrl.isLoginHeaderSite`（新版本）：登录头只发给源同站请求
  isLoginHeaderSite,
  // `#579` `<1,2,3>` 页码模式（与规则工坊 URL 探针同一份实现）
  pickPagePattern,
  jsonGetString,
  EngineError,
  resolveSourceState,
  EXPLORE_INPUT_KEY,
  EXPLORE_ACTION_KEY,
  /**
   * `#617` 详情页 URL 正则判定；`#625` 起**唯一实现搬到 core**（`source-match.ts`）——
   * 引擎这里「搜索响应 URL ⇒ 当详情页」与「URL ⇒ 反查书源」必须同一个判据，
   * 两处各写一份就是漂移的开始（`#588` 的教训）。
   */
  matchBookUrlPattern,
  LOGIN_HEADER_PREFIX,
  LOGIN_INFO_PREFIX,
  makeInfoMapBinding,
  cloneableFieldsOf,
  SOURCE_FIELDS_KEY,
  INFOMAP_ENTRIES_KEY,
  INFOMAP_RAW_KEY,
  type RuleEngine,
  type EngineAction,
  type CompileResult,
  type EngineContext,
  type UnifiedRequest,
  type UnifiedListResult,
  type UnifiedDetail,
  type UnifiedContent,
  type UnifiedChapter,
  type UnifiedItem,
  type ValidationIssue,
  type HttpResponse,
  type UnifiedLoginResult,
  type UnifiedPlay,
  type UiActionRequest,
  type UiActionResult,
  type ContentUiMark,
  recordBlock,
  normalizeIntro,
  formatIntro,
  unescapeHtml4,
  encodeFormBody,
  looksJsonOrXml,
  parseLoginUiV2Render,
  parseLoginUiV2Action,
  asImageStreamResult,
  // `#759` 单张图片解密下移 worker（默认开；`YUEDU_IMAGE_DECODE_WORKER=0` 回旧行为）
  imageDecodeBindings,
  // `D2` 标准参数 `decode{}`：对象/JSON 形式 + 服务端 AES-CBC（key 不下发前端）
  parseImageDecodeSpec,
  decryptImageWithSpec,
  // `#782` 冷规则首图改在 worker 探测（主线程零阻塞），探测样本单独记账
  planImageDecode,
  recordImageDecodeProbeCost,
  abortImageDecodeProbe,
  recordImageDecodeL1Cost,
  shouldRetryImageDecodeInL1,
  makeRuleBridge,
  /**
   * `#553`：`bindings["source"]` 源桩的**唯一实现**（`core/source-stub.ts`）——
   * 之前长在本文件里且未导出，`#551` 的试跑探针只好另写半套 ⇒ 两份必然漂移。
   * （`makeSourceLoginStub` 现已由它内部展开，本文件不再直接引用。）
   */
  makeSourceStub,
  /** `source.get/put` 的内存副本槽名（prime/persist 也用它，必须与桩同一常量） */
  SOURCE_KV_SLOT,
  persistSourceLogin,
  /** `#314`：JSON 绑定的 Java-Map 方法补齐（登录信息空表的同形兜底用） */
  attachJsonMapMethods,
  /**
   * `#346` 媒体直链提取与 `media` 组装 —— **下沉 core 的唯一实现**（此前是本文件局部函数）。
   * 订阅源（`type===2`）同样需要这条通路 ⇒ 两个引擎共用，避免同一判据两份实现漂移。
   */
  collectMediaCandidates,
  toMedia,
  inferPlayFormat,
  MEDIA_EXT_RE,
  /** `#374`：候选直链先反向转义（`https:\/\/` → `https://`）再判扩展名 */
  unescapeJsUrl,
  /** `#331`：source.putConcurrent → 运行期改限频（上游 updateConcurrentRate 同名语义） */
  updateConcurrentRate,
  /** `#315`：登录执行流程共享件（早退 / 表单闸门 / 拼脚本 / 错误定性 —— 判据唯一实现） */
  loginPlanEarlyResult,
  loginFormGate,
  buildLoginScript,
  needBrowserFromError,
  notAFunctionFromError,
  /** `#423`「只渲染登录界面」伪动作（打开对话框的只读渲染） */
  LOGIN_UI_RENDER_ACTION,
  /**
   * `#383`：URL 规则里的 JS 段求值 —— **唯一实现**（上游 `AnalyzeUrl.analyzeJs` 全文扫描）。
   * ⚠️ 别再在本文件写 `startsWith('@js:')`：上游 `JS_PATTERN` 是 `Matcher.find()` 全文扫描，
   * `@js:` 在 URL **任意位置**都触发（qyyuapi 五源 `sortUrl` 真实形态 = `Movieffm@js:`…``）。
   */
  applyUrlRuleJs,
  /** `#405②` 剥离 `{,...}` 可选段（非 Legado 语法，源作者约定）—— core 唯一实现 */
  stripOptionalUrlSegments,
  /** `D11`：闸页（年满18岁声明）识别 —— 过闸失败时给「为什么空」的可操作线索 */
  isAgeGatePage,
  /** `#467`：源 header 规则求值唯一实现（memo/防重入；RSS 引擎与 /api/proxy 同一份） */
  createSourceHeaderResolver,
  evaluateSourceHeaderRuleAsync,
  /** `#606`：交给 curl 之前的 URL percent-encode（非 ASCII → UTF-8，对齐 okHttp `HttpUrl`） */
  encodeUrlForCurl,
  /** `#607`：jsLib 里需要下载的 URL（映射表取全部 value / 单 URL 取自身） */
  jsLibUrls,
  /** `#771` 冻结探针（默认关）：给目录循环/组装段打点，定位 5s 停摆落在哪一段 */
  probeEnter,
  probeLeave,
  probePoint,
} from '@yuedu/core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as iconv from 'iconv-lite';
import { detectBookSource, compileBookSource } from './model/book-source';
import {
  parseConcMode,
  resolveTocConc,
  TOC_ADAPT_MIN_CHAPTERS,
  type TocConcDecision,
} from './model/toc-concurrency';
import { classifyLoginUrl, extractInlineJs, normalizeLoginField, parseLoginUiText, type LoginField } from './model/login';
import type {
  CompiledBookSource,
  RuleSearch,
  RuleBookInfo,
  RuleToc,
  RuleContent,
} from './model/book-source';

const UA = 'Mozilla/5.0 (compatible; EngineHub/0.1)';

/** 解析源选项 `timeout`（毫秒）。Legado `parseRequestTimeoutMillis`（AnalyzeUrlNetworkOptions.kt:12-23）：
 *  接受数值/数字字符串，仅 `1..Int.MAX_VALUE` 有效，其余（0/负数/非数字）忽略。 */
function toValidTimeoutMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 2_147_483_647) return null;
  return n;
}

/**
 * 单次请求超时（= OkHttp **callTimeout** 语义：整请求截止；core 用 AbortController 落地）。
 *
 * ① 缺省 60s：**Legado HttpHelper.kt:59-62** —— connect/write 15s、read 60s、callTimeout 60s。
 *    post3 基线证明 25s 太紧：retry=0（Legado 语义）后没有第二次窗口，25~50s 的慢站从
 *    「重试侥幸成功」变成硬失败（search 308→291、TIMEOUT 71→90）。60s 让慢站回到可成功区间。
 * ② 源选项 `timeout`：Legado 把它落到 **readTimeout**（AnalyzeUrl.kt:268-271），
 *    并派生 `callTimeout = max(60s, read×2)`（AnalyzeUrlNetworkOptions.kt:77-84 derivedCallTimeoutMillis）。
 *    我们只有单一整请求超时 → 取派生后的 callTimeout。语料 484 源用 0 处，属潜在字段（#84）。
 * ③ 剩余预算：`ctx.deadlineAt`（宿主行动预算的绝对截止）。没有它，行动会远跑过预算 ——
 *    客户端先超时退出、服务端还在跑（post2 基线 68 处 TIMEOUT 落在客户端预算边界即此形态）。
 * ④ 下限：默认 1s（避免「预算刚好用尽」时算出 0/负数，让请求变成必然失败）。
 *    目录**后续页**例外：给 `TOC_PAGE_MIN_TIMEOUT_MS`（`#769`）—— 页 1 求值被冻结时
 *    行动剩余预算可能只剩 1s，而站点页 2 本身只要 ~0.3s；把下限压在 1s 等于必然丢页。
 */
function requestTimeout(ctx: { deadlineAt?: number }, explicit?: unknown, floorMs = 1_000): number {
  const fromSource = toValidTimeoutMs(explicit);
  const cap = fromSource == null ? 60_000 : Math.max(60_000, fromSource * 2);
  if (!ctx.deadlineAt) return cap;
  return Math.max(floorMs, Math.min(cap, ctx.deadlineAt - Date.now()));
}

/**
 * `#769` **目录后续页的最小独立预算 = 15s**。
 *
 * 实测（速读谷 `suduguu.com` 2026-11-04）：页 1（999 章）求值期间进程多次 5s 级冻结
 * （`[stall] stall ms=5054` / `recover ms=7736` / 累计 36.85s），把 detail 动作的 60s 预算吃光
 * ⇒ `requestTimeout` 按 `deadlineAt` 把页 2 裁到 **1000ms**（下界）⇒ 站点回包要 ~300ms
 * 但排队/抖动后超时 ⇒ `tocError=下一页抓取失败（Error: 请求超时（>1000ms)）`、目录停在 999 章。
 * 站点本身是秒开（直连页 2 TTFB 196ms / 总 211ms）⇒ 这是**我们侧的预算**问题，不是站慢。
 *
 * 为什么 15s 不是 60s：真正卡住的是页 1 之前的主线程冻结（`#477`）；给页 2 一个能扛过
 * 「一次 5s 冻结 + 一次网络抖动」的窗口即可，同时不让坏站把整次详情拖到失控。
 * 与之配套：`EngineHub` 对 detail 动作的预算放宽到 75s（仍由 `ctx.signal` 兜住取消）。
 */
const TOC_PAGE_MIN_TIMEOUT_MS = 15_000;

function emptyList(page = 1): UnifiedListResult {
  return { items: [], page: { page, pageCount: 0, total: 0, hasMore: false } };
}

/**
 * `#607` **jsLib 落盘**（对齐上游 `SharedJsScope` 的 `ACache`）。
 *
 * ## 真因（2026-10-24，包子漫画/G站漫画）
 * 上游 `evaluateJsLib` 把下载到的 js **写进 ACache 磁盘缓存**（`aCache.put(fileName, js)`），
 * 所以一个源**一辈子只慢一次**。本仓此前只有**进程内 `Map`** ⇒ 服务重启后又要重下；
 * 而 qyyuapi 站点此刻单个 js 要 60s（实测 `curl (28) after 60011ms with 508 bytes received`
 * —— 收到 508 字节后彻底卡住）⇒ 两个库 = 120s，**正好吃光行动总预算**，
 * 后续规则连 `Reload` 都没定义 ⇒ 报 `data is not defined` / `Reload is not defined`。
 * 症状看起来像「jsLib 时序不对」，其实是「下载慢 + 不持久」。
 *
 * ## 做法
 * 入口处（`primeSourceState` 之后）**异步**把 jsLib 灌进三处：内存 → 磁盘 → 网络。
 * 用 `ctx.http`（异步，不阻塞事件循环）而不是同步 curl，并按剩余预算裁剪超时。
 * 同步求值面（`resolveLib`）只在内存里取 —— 没有就退化成短超时 curl 兜底，
 * 绝不再让「一个库 60s」把整次行动拖死。
 */
const JSLIB_STORE_PREFIX = 'jslib:';

/** 上游 `MD5Utils.md5Encode(value)` —— 磁盘缓存键（与 ACache 的文件名同算法） */
function md5Hex(s: string): string {
  return createHash('md5').update(String(s), 'utf-8').digest('hex');
}

/** 本进程内「哪个源有哪些库没加载成功」（给错误信息加可操作的 hint 用） */
const jsLibFailuresBySource = new Map<string, string[]>();

/** `#607`：某源 jsLib 的失败清单（错误包装时追加 hint；没有 ⇒ 空数组） */
export function jsLibFailuresOf(sourceId: string): string[] {
  return jsLibFailuresBySource.get(sourceId) ?? [];
}

/**
 * `#607`：给 `X is not defined` 这类错误补一句**可操作的 hint**。
 *
 * 为什么需要：jsLib 没加载成功时，源规则报的是 `Reload is not defined` / `data is not defined`
 * —— 看起来像「源的规则写错了」或「jsLib 时序不对」，实际是「库没下下来」。
 * 排查时被迫从「为什么 Reload 未定义」开始，绕很远（`#607` 就是这么被误判成时序问题的）。
 */
function withJsLibHint(ctx: EngineContext, msg: string): string {
  return withJsLibHintById(ctx.sourceId, msg);
}

/** 同上，但没有 ctx 的调用点（如 `parseExploreKinds`）用源 id 直接查 */
function withJsLibHintById(sourceId: string | undefined, msg: string): string {
  if (!/is not defined/.test(msg)) return msg;
  const fails = sourceId ? jsLibFailuresOf(sourceId) : [];
  if (!fails.length) return msg;
  const names = fails.map((u) => u.split('/').slice(-2).join('/')).join('、');
  return `${msg}（该源 jsLib 未加载成功：${names} —— 源内 Get/Map/Reload 等会未定义；` +
    `先查这些地址能否访问，或清缓存后重试）`;
}

/**
 * `#650` **`Malformed URL: undefined/...` 的 hint**（实测：®️爱丽丝书屋（大侠修）探索页）。
 *
 * 那条源的 `exploreUrl` 用 `{{GetUL()}}` 拼站源前缀，而 `GetUL()` = `JSON.parse(source.getVariable()).sourl`。
 * 变量袋里没有 `sourl` 时模板展开成**字面量** `undefined` ⇒ `undefined/all/order/hits+desc.html`
 * ⇒ `assertHttpUrl` 抛（这条抛错是上游 jsoup 语义，见 `selector/js.ts` 的注释，**不能**改成静默——
 * 源作者靠它做兜底分支）。
 *
 * 真因在源：它的初始化守卫写成 `v === null && typeof v !== 'object' && Array.isArray(v)`
 * —— 逻辑**永假**，所以「补默认站源」那一步永远不会执行。引擎不替它编变量
 * （那会覆盖用户已登录的站源），只把真因写进日志，免得下次又从头查一遍。
 */
export function exploreFailHint(msg: string): string {
  /**
   * 形态一（`#650`）：地址以 `undefined` 开头 —— 模板 `{{GetUL()}}` 展开成了字面量。
   * 形态二（`#657` 同一条源的登录脚本）：`Cannot set properties of undefined (setting 'length')`
   * —— `sgv.urls.length = 0`，而 `sgv = JSON.parse(source.getVariable())` 里没有 `urls`。
   * 两条的**根因是同一个**：源的变量袋没被初始化，而它自己的守卫写法恒假。
   */
  if (/Malformed URL:\s*(undefined|null)/i.test(msg)) {
    return '｜疑似源变量未初始化：脚本拼出的地址以 undefined 开头（如 {{GetUL()}} 依赖 source.getVariable().sourl）'
      + ' ⇒ 该源需先「初始化/登录」写入变量，或修它自己的初始化守卫（常见写法 `v===null && Array.isArray(v)` 恒假）';
  }
  /**
   * 形态三（`#672` 哔咔漫画〔自包含〕）：`Unexpected end of JSON input`。
   * 源脚本写 `JSON.parse(java.ajax(url))`，而 `java.ajax` 失败时**返回空串**（上游同语义）⇒
   * `JSON.parse('')` 抛这句。用户日志里紧邻着
   * `[rpc-http] ⚠️ GET https://picaapi.picacomic.com/categories 失败（已按空 body 继续）：连接超时`
   * —— 真因是那次请求没成功，不是规则写错。不点明的话，人会去改规则（改不好）。
   */
  if (/Unexpected end of (JSON )?input/i.test(msg)) {
    return '｜源脚本 JSON.parse 了空响应：它自己那次 java.ajax 没拿到内容（超时/被挡）'
      + ' ⇒ 看同段日志的 `[rpc-http] … 失败` 行确认是哪条请求；网络/线路恢复后重试即可';
  }
  if (/Cannot set properties of (undefined|null)/i.test(msg)) {
    return '｜疑似源变量未初始化：`JSON.parse(source.getVariable())` 取到的对象缺键（如 `urls`）'
      + ' ⇒ 先执行该源的「初始化/获取站源」，或修它的初始化守卫（常见写法恒假 ⇒ 默认值永远写不进去）';
  }
  return '';
}

export async function primeJsLibCached(ctx: EngineContext, lib: string | undefined): Promise<void> {  const urls = jsLibUrls(String(lib ?? ''));
  if (!urls.length) return;
  /**
   * 预算：给 jsLib 的时间不超过「剩余预算 - 5s」，且单库最多 **60s**（`#636`：实测中位 2~6s、
   * 偶发 >12s，25s 的总额度在一次超时后就没了重试空间）。只有第一次成功前要付这个代价。
   */
  const remain = ctx.deadlineAt ? Math.max(5_000, ctx.deadlineAt - Date.now() - 5_000) : 60_000;
  const perLib = Math.max(5_000, Math.min(remain, 60_000));
  const failures: string[] = [];
  await Promise.all(
    urls.map(async (u) => {
      if (jsLibCache.has(u)) return;
      // ① 磁盘（上游 ACache 等价物，跨进程）—— 原行为，属网络结果的缓存
      try {
        const stored = await ctx.storage.get(JSLIB_STORE_PREFIX + md5Hex(u));
        // 旧版本可能把「浏览器文本阅读器 DOM」当脚本落盘（`.js` 撞 WAF 被重放时），按未命中回源
        if (typeof stored === 'string' && stored && !isRenderedTextDocument(stored)) {
          jsLibCache.set(u, stored);
          return;
        }
        if (typeof stored === 'string' && stored) {
          // eslint-disable-next-line no-console
          console.warn(`[legado] jsLib 持久层内容是 HTML 文档（非脚本原文），忽略并回源：${u.slice(0, 90)}`);
        }
      } catch {
        /* 存储读失败按「没有」处理，继续走网络 */
      }
      // ② 负缓存（5 分钟内不再重试，避免一次行动里反复打同一个死站）⇒ 阴性时走镜像兜底
      const failedAt = jsLibFailedAt.get(u);
      if (failedAt !== undefined && Date.now() - failedAt < JSLIB_FAIL_TTL_MS) {
        const cachedMirror = readJsMirror(u, { reason: '网络失败负缓存（5 分钟内不再重试）' });
        if (cachedMirror) {
          jsLibCache.set(u, cachedMirror.text);
          return;
        }
        failures.push(u);
        return;
      }
      // ③ 网络（异步！不像同步 curl 那样堵住事件循环，也不会让别的源陪着等）
      /**
       * `#636` **给足超时 + 重试**（2026-10-26 基线最大一簇：qyyuapi 系 14~20 源全挂）。
       *
       * 病根（实测，**交错重复**取样后确认）：这个外链所在主机**本身就慢且抖**——
       * 同一 URL 连打 8 次：中位 **2~6s**，最慢 12s+；偶尔整段挂死。
       * 而 `ctx.http.request` 不给 `timeout` 时走网络层的 class 默认 **12s**
       * （`net/index.ts:855` 的 `classLimits.timeoutMs`）⇒ 抖动一次就判死 ⇒
       * 降级成「没有 jsLib」⇒ `Reload is not defined` ⇒ 该源所有规则全挂。
       *
       * ⚠️ 排查过程中我先误判过两次（一次疑 UA、一次疑中文路径编码），
       * 交错重复取样后**都被推翻**：两个 UA、原文/编码 URL 都能成功。
       * 所以这里只做**有证据**的两件事：给足单次超时、失败重试。
       *
       * 因此：① 每次尝试超时 = 剩余预算（上限 20s）；② 瞬时错误最多重试 3 次（300/800ms 退避）；
       * ③ 404 这类**确定性**错误不重试；④ 成功即落盘，只有**第一次**要付这个代价。
       */
      /** 判词唯一实现见 `core/selector/js-file.ts` 的 `isTransientScriptFetchError`（`#636`） */
      const isTransient = isTransientScriptFetchError;
      const t0 = Date.now();
      const libDeadline = Date.now() + perLib;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const left = libDeadline - Date.now();
        if (left < 3_000) break;
        try {
          const resp = await Promise.race([
            /**
             * ★ `#636` **这里不能 `encodeUrlForCurl`**（2026-10-26 实测，决定性对照）。
             *
             * 同一个 `https://qyyuapi.com/sy/js/包子漫画/jsLib.js`：
             *  · **原文**（路径保留中文）⇒ 200 · 47,266 字节 · 4.3~9.4s（两次都是）
             *  · 经 `encodeUrlForCurl` 转成 `%E5%8C%85…` ⇒ **挂死**，22s 超时（两次都是）
             * ⚠️ 这里保留 `encodeUrlForCurl`：**原来的「转义导致挂死」结论是噪声**
             * （交错 4 轮：原文 3/4、编码 4/4 都能取到 47,266 字节）。转义对带空格/非法字符的
             * 路径更安全，所以不改。
             */
            ctx.http.request(encodeUrlForCurl(u), {
              method: 'GET',
              /**
               * UA：统一用引擎的 `UA` 常量。
               *
               * ⚠️ 排查时我一度以为「`yuedu/0.1` 被 Cloudflare 吊住」，交错重复取样后**推翻**：
               * 两个 UA 都是 3~4/4 成功、中位 ~5s。这里换 UA 只是**统一特例**，不是性能修复。
               */
              headers: { 'User-Agent': UA },
              timeout: Math.min(20_000, left),
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`jsLib 下载超时（>${Math.min(20_000, left)}ms）`)), left).unref?.(),
            ),
          ]);
          const body = typeof resp.body === 'string' ? resp.body : Buffer.from(resp.body ?? []).toString('utf-8');
          if (isMarkupDocumentBody(body)) {
            // 浏览器重放把 `.js` 渲染成 HTML 文档（文本阅读器）时绝不能当脚本缓存（`Unexpected token '<'`）
            throw new Error(`HTTP ${resp.status} / 响应是 HTML 文档（非脚本原文） ${body.length}B`);
          }
          if (resp.status >= 200 && resp.status < 300 && body) {
            jsLibCache.set(u, body);
            jsLibFailedAt.delete(u);
            // `#732` 网络成功 ⇒ 回写本地镜像（下次离线可用；成功时绝不改用旧镜像）
            writeJsMirror(u, body);
            try {
              await ctx.storage.set(JSLIB_STORE_PREFIX + md5Hex(u), body);
            } catch {
              /* 落盘失败只是下次要重下，不影响本次 */
            }
            if (attempt > 1) {
              // eslint-disable-next-line no-console
              console.log(`[legado] jsLib 第 ${attempt} 次重试成功：${u.slice(0, 90)}`);
            }
            return;
          }
          throw new Error(`HTTP ${resp.status} / body ${body.length}B`);
        } catch (e) {
          lastErr = e;
          if (attempt < 3 && isTransient(e)) {
            await new Promise<void>((r) => setTimeout(r, attempt === 1 ? 300 : 800).unref?.());
            continue;
          }
          break;
        }
      }
      {
        const e = lastErr;
        jsLibFailedAt.set(u, Date.now());
        // `#732` 网络重试全失败 ⇒ **镜像兜底**（命中即用，日志写「兜底 + 原因」）
        const reason = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
        const mirror = readJsMirror(u, { reason });
        if (mirror) {
          jsLibCache.set(u, mirror.text);
          return;
        }
        // 镜像也未命中 ⇒ 明确失败 + 连续失败计数（到阈值提示「请手动下载」，同 URL 只提示一次）
        noteJsMirrorFailure(u, reason || '内容为空');
        failures.push(u);
        warnOnce(
          'jslib-prime',
          u,
          `jsLib 预下载失败（本地镜像未命中；按无该库继续，源内 Get/Map/Reload 会未定义）：${u.slice(0, 110)}` +
            ` · 耗时 ${Date.now() - t0}ms · ${reason}`,
        );
      }
    }),
  );
  if (failures.length) jsLibFailuresBySource.set(ctx.sourceId, failures);
  else jsLibFailuresBySource.delete(ctx.sourceId);
}

/** 远程 jsLib 缓存（Legado 支持 jsLib 为 URL：下载一次，进程内缓存） */
const jsLibCache = new Map<string, string>();

/**
 * jsLib 下载**失败**的负缓存（URL → 失败时刻）。
 *
 * 为什么需要（`#606` 第 2 层，2026-10-24）：成功才写 `jsLibCache`，所以失败的 URL 每次
 * `resolveLib` 都会重新下载 —— 而 `resolveLib` 在一次请求里会被调多次（`makeEnv` 4 次，
 * 埋点实测 `jsLib-curl n=4 t=76112ms`）：两个 URL × 20s × 多次 ⇒ **单请求阻塞 40~76 秒**，
 * 把整个 worker/eval 拖到超时。上游失败也只影响当次（ACache 未命中就再下），但它
 * 没有本仓这种「一次请求内重复建 env」的放大。
 *
 * 有效期 5 分钟：既挡住放大，又能在站点恢复后自动重试（不做永久负缓存）。
 */
const jsLibFailedAt = new Map<string, number>();
const JSLIB_FAIL_TTL_MS = 5 * 60_000;

/**
 * curl 失败原因的**一句摘要**（`#606` 排查用）。
 *
 * `execFileSync` 的错误只看 `message` 等于没信息（永远是 `Command failed: curl …`）：
 * 真正的判据在 `status`（curl 退出码：**28 = 超时**、6 = DNS 解析失败、7 = 连接被拒）
 * 与 `stderr`。把它们摘出来，下次「jsLib 拉不到」就能一眼分清是网络慢还是地址错。
 */
function summarizeCurlError(e: unknown): string {
  const err = e as { status?: unknown; stderr?: unknown; code?: unknown; message?: unknown } | null;
  const parts: string[] = [];
  if (typeof err?.status === 'number') parts.push(`curl exit=${err.status}（28=超时 6=DNS 7=连接失败）`);
  else if (err?.code != null) parts.push(`spawn ${String(err.code)}`);
  const rawErr = err?.stderr;
  const errText =
    typeof rawErr === 'string'
      ? rawErr.trim()
      : Buffer.isBuffer(rawErr)
        ? rawErr.toString('utf-8').trim()
        : '';
  if (errText) parts.push(errText.slice(-220));
  if (!parts.length) parts.push(String(err?.message ?? e).slice(0, 200));
  return parts.join(' | ');
}

/**
 * jsLib 归一（`#344` 收敛到 core 唯一实现 `resolveJsLibText`）。
 *
 * 支持三种形态（上游 `SharedJsScope.kt:231-276`）：
 *  ① **JSON 对象映射表** `{"剧迷":"https://…/jsLib.js","通用":"https://…/common.js"}`
 *     ⇒ 逐个 value 下载其 JS 并拼接（旧实现把整段 JSON 当脚本 ⇒ `Unexpected token ':'`）；
 *  ② 单个绝对 URL ⇒ 下载；
 *  ③ 内联 JS 源码 ⇒ 原样。
 *
 * ⚠️ 下载是**同步**的（jsEval 构造是同步的，上游 `okHttpClient` 也是阻塞式）⇒ 首次会阻塞
 *    事件循环，用 `recordBlock` 埋点留痕。
 */
function resolveLib(lib?: string): string | undefined {
  if (!lib) return lib;
  const fetchJs = (url: string): string | null => {
    const hit0 = jsLibCache.get(url);
    if (hit0 !== undefined) {
      // 进程内也可能先被污染（重放返回阅读器 DOM）⇒ 丢掉后按未命中重新取
      if (isMarkupDocumentBody(hit0)) jsLibCache.delete(url);
      else return hit0;
    }
    const failedAt = jsLibFailedAt.get(url);
    if (failedAt !== undefined && Date.now() - failedAt < JSLIB_FAIL_TTL_MS) {
      // `#732` 网络已判死 ⇒ 镜像兜底（没有镜像才当无该库）
      const cachedMirror = readJsMirror(url, { reason: '网络失败负缓存（5 分钟内不再重试）' });
      if (cachedMirror) {
        jsLibCache.set(url, cachedMirror.text);
        return cachedMirror.text;
      }
      return null;
    }
    const t0 = Date.now();
    /**
     * ★ **URL 必须 percent-encode 再交给 curl**（`#606`，2026-10-24）。
     *
     * qyyuapi 系源的 jsLib 映射表里路径带**中文**：
     * `{"G站漫画":"https://qyyuapi.com/sy/js/G站漫画/jsLib.js","通用":"https://qyyuapi.com/js/common.js"}`。
     * 上游 `SharedJsScope.evaluateJsLib` 用 okHttp 下载，而 okHttp 的 `Request.url(String)` 走
     * `HttpUrl.get()` —— **非 ASCII 一律按 UTF-8 percent-encode**，所以上游天然能取到。
     * curl 不会自动编码：实测同一条 URL 原样给 curl ⇒ `http_code=000`（0 字节）；
     * `encodeURI` 之后 ⇒ 200 / 42618 字节。不编码的后果是**两个库都拉空**
     * ⇒ jsLib 里的 `Get`/`Map`/`Reload` 全未定义 ⇒ `Reload is not defined`（G站漫画等 4 源）。
     *
     * 判据本身在 `net/url-resolve.ts` 的 `encodeUrlForCurl`（与 `curlSyncFetch` 同一份）：
     * 按 okHttp `HttpUrl.canonicalize` 走 —— 保留合法 `%XX`、编码非 ASCII 与空格。
     */
    const target = encodeUrlForCurl(url);
    try {
      /**
       * 超时 **8s**（`#607` 起，原本 60s）。
       *
       * 分工变了：正常路径由 `primeJsLibCached`（**异步**、按剩余预算裁剪、落盘）负责；
       * 这里只是「prime 没跑到/被跳过」时的**同步兜底**，绝不能再用 60s —— 实测 qyyuapi 死站
       * `curl (28) after 60011ms with 508 bytes received`，两个库就是 120s，把行动预算吃光后
       * 规则连 `Reload` 都没定义（`#607` 的误导性症状就是从这里来的）。
       * 8s 足够覆盖「健康站点」（实测 2~8s），慢站交给异步 prime 去等。
       */
      // `#732` **网络优先**：curl 成功（且非空）⇒ 用网络内容 + 回写镜像，不因镜像存在而跳过请求
      const body = execFileSync(
        'curl',
        ['-sS', '-L', '--max-time', '8', '-A', 'Mozilla/5.0 (compatible; yuedu/0.1)', target],
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      );
      if (!String(body).trim()) throw new Error('HTTP 200 空响应');
      if (isMarkupDocumentBody(body)) throw new Error('HTTP 响应是 HTML 文档（非脚本原文）');
      jsLibCache.set(url, body);
      jsLibFailedAt.delete(url);
      writeJsMirror(url, body);
      return body;
    } catch (e) {
      /**
       * 下载失败**不静默**（铁律 4）：jsLib 拉空会让该源所有 js 规则「函数未定义」，
       * 症状长得像规则写错，排查成本极高（`#606` 就是这样被误判成源缺陷的）。
       */
      jsLibFailedAt.set(url, Date.now()); // 负缓存：5 分钟内不再重试（挡住一次请求内的重复下载）
      const reason = summarizeCurlError(e);
      // `#732` 网络失败 ⇒ **镜像兜底**（命中即用；日志写「兜底 + 原因」）
      const mirror = readJsMirror(url, { reason });
      if (mirror) {
        jsLibCache.set(url, mirror.text);
        return mirror.text;
      }
      // 两者都失败 ⇒ 连续失败计数（到阈值提示「请手动下载」，同 URL 只提示一次）
      noteJsMirrorFailure(url, reason || '内容为空');
      warnOnce(
        'jslib-fetch',
        url,
        `jsLib 远端下载失败（本地镜像未命中；按无该库继续，源内 Get/Map/Reload 等会未定义）：${url.slice(0, 120)}` +
          ` · 耗时 ${Date.now() - t0}ms · ${reason}`,
      );
      return null; // 跳过该库，不让单个源拖死
    } finally {
      // 埋点：jsLib 远程下载也是同步 curl，会阻塞事件循环（仅首次）
      recordBlock('jsLib-curl', Date.now() - t0, url);
    }
  };
  const out = resolveJsLibText(lib, fetchJs);
  /**
   * `#636` **留痕（按需开）**：jsLib 是「URL 映射表」时，最终拼出来的文本到底含哪几个库、
   * 里面有没有 `function Get` —— 这一簇源的失败症状（`Get is not defined`）就是「少了一个库」，
   * 而原来的日志只在**下载失败**时说话，成功但拼错/只拼一半时完全静默。
   */
  if (process.env['YUEDU_DEBUG_JSLIB']) {
    // eslint-disable-next-line no-console
    console.log(
      `[jslib] in=${String(lib).slice(0, 30).replace(/\s+/g, ' ')}… → out=${out?.length ?? 'undefined'}` +
        ` · 含Get=${/function\s+Get\s*\(/.test(out ?? '')} · 含Reload=${/function\s+Reload\s*\(/.test(out ?? '')}`,
    );
  }
  // 下载全失败 ⇒ 当无 jsLib 处理（与旧行为一致：resolveLib 返回 undefined）
  return out === undefined ? undefined : out;
}

/**
 * **有界并发 map**（缺陷类T 的一部分，2026-09-21）。
 *
 * 为什么不能再用 `Promise.all(items.map(fn))`：源可能一次给出几十个下一页 URL，
 * 无界扇出会同时开几十个 socket → 路由器 NAT/连接表被打满 → **同局域网其它设备一起断网**
 * （用户实测报告）。这里给扇出加显式上限，与网络护栏（全局并发 6 / 单主机 2）配合。
 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T, i);
      }
    }),
  );
  return out;
}

/**
 * 内层异常的类型 + 栈（剔除引擎自身的包装帧）。
 *
 * EngineError 只带 code/stage，原始异常的**栈与出错行**原本全丢 —— 实测归因 #103 的
 * 「可乐小说 nodeName」时，接口返回里连一个有效帧都没有，只能靠不断加探针。
 * 现在统一附 `detail.cause`，从 API 一次就能看到「哪一行、谁抛的」。
 */
function causeOf(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const frames = String(e.stack ?? '')
    .split('\n')
    .slice(1) // 去掉首行（message 已单独给出）
    .filter((l) => !/LegadoEngine\.|engine-legado|engine\.ts|server-bundle/.test(l))
    .slice(0, 6)
    .join('\n');
  return frames ? `${e.name}: ${e.message}\n${frames}` : `${e.name}: ${e.message}`;
}

// `describeRuleNode` 已移到 `@yuedu/core` 的 `selector/rule-bridge.ts`（`#313`）：
// 它此前在本文件与 `engine-rss/env.ts` 各写一遍（**逐字相同**的重复），
// 与规则桥一起收敛成唯一实现 —— 三处各写一遍，在那次加 op='object' 时当场漂移。

function makeEnv(
  ctx: EngineContext,
  baseUrl?: string,
  lib?: string,
  src?: Record<string, unknown>,
  /**
   * `java.toast` / `java.longToast` 收集器（可选）。
   *
   * 不传时回落到 `ctx.toastSink`（宿主在 ctx 上注入的全局收集器）—— 这样**搜索/详情/目录/正文**
   * 这四个阶段不需要逐个改调用点也能收齐脚本原话（旧实现只有登录流程传了这个参数，
   * 其余阶段的 toast 全部静默丢弃）。两处都缺省时只打日志（见 onToast）。
   */
  toastSink?: string[],
): AnalyzeEnv {
  // java 规则桥合并点（AnalyzeRule 实例构造时写入 ruleApi；java Proxy fallback 查这里）
  const javaExtra: Record<string, unknown> = {
    // 发现页交互 API（Legado JsExtensions）——服务端语义下均为空实现：
    //  · refreshExplore()：App 里通知 UI 重算 kinds；我们每次 home 请求都会重跑 exploreUrl 脚本，
    //    用户的交互选择经 filters[$input] 持久化后即时生效，故等价于已完成刷新。
    //  · searchBook(kw, tag)：App 里跳转到搜索页；Web 端由前端决定跳转，引擎不产生副作用。
    refreshExplore: () => '',
    /**
     * `java.put(k, v)` 的**持久落点**（跨阶段可读的关键）。
     *
     * ⚠️ **此前这个钩子一直没被设置**（2026-09-22 修，缺陷类AH）：
     * `java.put` 的实现读的是 `hooks.javaExtra['putVariable']`（见 core `selector/js.ts` 的 `put`），
     * 而我们只设了 `env.putVariable`（那是给 `@put:{k:v}` 用的，走 `analyze.ts`）。
     * 结果：**脚本里的 `java.put` 只写进本请求的 `variables`，永不落盘** ⇒ 跨阶段必丢。
     *
     * 实测（🏷七猫[官方]v3.1）：tocUrl 脚本用 `java.put('headers', …)` 存签名头，
     * 正文脚本用 `java.get('headers')` 取回拼到 ajax 的 options 尾巴上。
     * 因为没持久化，正文那次 ajax **一个签名头都没带** → 站点回
     * `{"errors":{"code":"44010120","title":"验签失败"}}` → `.data` 不存在 → `RULE_PARSE@parse`。
     * 留痕证据：`[js.put] headers persist=undefined`（共 6 次调用，全部丢弃）。
     *
     * 与 `env.putVariable` 指向**同一个函数**，两条写入路径（`@put:` 与 `java.put`）落点一致。
     * worker 侧同一条钩子被 `javaScope.put` 复用（core `js.ts` 的 `hostRpc('javaVarPut')`），
     * 所以 L1 与 worker 也一致。
     */
    putVariable: (k: string, v: string) => putSharedVariable(ctx, k, v),
    searchBook: () => '',
  };
  // evalRule 完整规则求值：对当前上下文值建临时 AnalyzeRule（java=规则桥可继续嵌套）。
  // envRef 自引用：env 对象随后构造完成（evalRule 惰性解引用）。
  let envRef: AnalyzeEnv | undefined;
  const evalRuleFull = (rule: string, value: unknown): string => {
    const r = rule.trim();
    if (value != null && typeof value === 'object' && /^(\$\.|\$\[)/.test(r)) {
      return jsonGetString(r, value, { baseUrl, variables: ctx.variables, jsEval: () => '' });
    }
    if (envRef && value != null && value !== '') {
      try {
        return new AnalyzeRule(envRef).setContent(value, baseUrl).syncGetString(r);
      } catch {
        return '';
      }
    }
    return '';
  };
  // 「脚本要求打开浏览器」记录（java.startBrowser / startBrowserAwait / webView）→
  // 登录流程用它把登录页交给前端打开（人工/验证码）。不记录会退化成静默失败。
  const onBrowserOpen = (u: string, kind?: 'show' | 'cookie'): void => {
    if (!u) return;
    // ① 单值槽：登录流程读它（保持原语义 —— 最后一个胜出）
    ctx.variables.set('__browserUrl', u);
    // `#393` 目的（类型 = core `selector/js.ts` 的 `BrowserOpenKind`）：'cookie' = 脚本在等浏览器里的
    // 结果 ⇒ 真浏览器；'show' = 打开给人看 ⇒ 应用内浏览器（也只有应用内才点得动「导入书源」）。
    if (kind === 'cookie') ctx.variables.set('__browserNeedCookie', '1');
    /**
     * ② 列表槽（2026-09-25 新增）：**一次请求内可能多次要求开浏览器**，
     * 而媒体兜底需要**全部**候选，不能被后一个覆盖。
     * 实测 🎬茶杯狐狸正文规则 `java.startBrowserAwait(pUrl, title)` —— pUrl 就是
     * 从正文页 `"url_next"` 抽出来的播放页地址，是「未取到媒体地址」唯一的线索来源。
     */
    const prev = ctx.variables.get('__browserUrls');
    const list = Array.isArray(prev) ? (prev as string[]) : [];
    if (!list.includes(u)) list.push(u);
    ctx.variables.set('__browserUrls', list);
  };
  const onToast = (m: string, long: boolean): void => {
    const text = String(m ?? '').trim();
    if (!text) return;
    // sink 优先级：**显式传入**（登录流程 → 随登录结果回传）> `ctx.toastSink`（宿主全局收集）。
    // 两级都缺省时不静默 —— 下面那行 console 是排障现场（服务端无 UI）。
    (toastSink ?? ctx.toastSink)?.push(text);
    // ★ `#196`：同时打日志并带上**源身份**（服务端无 UI，console 是唯一现场）。
    //   不带源身份时「🖼 图解码失败: TypeError: Packages.android.graphics.Paint is not a constructor」
    //   这类 toast 看不出是哪个源触发的（用户 2026-10-02 指出）——重名源靠 id 区分。
    console.log(`[legado-toast]${long ? '(long)' : ''} · 源 ${sourceLabel} ${text}`);
  };
  /**
   * `java.upLoginData(data)` → 记进 `ctx.variables`，登录流程随结果回传前端回填表单。
   * 与 `engine-rss` **同一条**语义与落点（上游 `SourceLoginJsExtensions.kt:35-37` →
   * `SourceLoginDialog.handleUpUiData`：只实时改 UI、不落库）。
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
   * 源级默认请求头 —— `java.ajax/connect/post/get/getStrResponse/ajaxAll` 的基底。
   *
   * 对齐 Legado `AnalyzeUrl(url, baseUrl, source)`：请求头 = **源 `header` 规则** ⊕ **登录头**
   * （`getHeaderMap(hasLoginHeader = true)` 在源 header 之后 putAll）+ 源 Cookie（由 core 补）。
   *
   * 为什么要有这个：此前 `java.ajax` 只把 URL 自带的 `,{headers}` 发出去，源 `header` 规则
   * （App 版 UA / application-id / 签名头）**一个都没发** → 星空小说这类「接口要签名头」的源
   * 在发现页必然拿不到数据。这是与 Legado 最实质的一处差距。
   *
   * 特性：
   *  · **惰性**——脚本不发 HTTP 就零开销；
   *  · **按请求 memo**——makeEnv 每次请求新建，同一次请求内多次 ajax 不重复求值；
   *  · **同步求值**——`@js:` 用 jsEvalSync（与 JS 规则段同一求值器）；
   *  · **防重入**——header 规则里若自己调了 `java.ajax`，内层返回空头而不是无限递归。
   */
  /**
   * 源级头的 memo/防重入/脚本求值判据本体在 core（`#467` 唯一实现，两引擎 + `/api/proxy`
   * 共用）；本处只保留 Legado 书源的**装配差异**：默认 UA 基底 + 登录头覆盖。
   */
  const headerResolver = createSourceHeaderResolver({
    variables: ctx.variables,
    getRaw: () => (typeof src?.['header'] === 'string' ? String(src['header']).trim() : ''),
    evalJs: (code) => {
      /**
       * ⚠️ **必须绑定 `source`**（2026-09-27 修，缺陷类BN）。
       *
       * 只绑 `baseUrl` 时求值器落到 core 的**默认 source 桩**（`getKey() → ''`）。
       * 后果不是「某个头少了个值」，而是**整条 header 脚本炸**：源普遍写成
       * ```js
       * if(/xmxsapp/.test(source.getKey())){ application = "com.xm.freader"; }
       * headers = { "application-id": application, ... }   // ← 读一个从没被赋值的名字
       * ```
       * `getKey()` 恒空 ⇒ 分支全不命中 ⇒ `application` 从未赋值 ⇒ **读它就 ReferenceError**
       * （赋值才会隐式建全局；读取未声明变量在 Rhino 与 JS 里**都**报错）。
       * 实测（⚡📂星空小说）：header 整条失败 → 默认 UA → 站点 **401** →
       * 发现页只剩一个 `ERROR:` 选项（用户看到的是"exploreUrl 脚本失败"，真因在 header）。
       */
      const e = envRef;
      return e?.jsEvalSync?.(code, {
        baseUrl: e.baseUrl,
        ...(e.sourceData ? { source: e.sourceData } : {}),
      });
    },
    warn: (channel, detail, cause) => {
      // 旧实现口径：求值抛错 / 静态 JSON 畸形 ⇒ 留痕；脚本返回值非对象（shape）⇒ 静默。
      if (channel === 'shape') return;
      // 附首个栈帧：源 header 脚本常调 jsLib 里的函数，只有 message 时无法定位是哪一层
      // （实测：晋江文学 header 失败只报 "this.getHeaderMap is not a function"，看不出调用链）
      const frame =
        (cause instanceof Error ? (cause.stack ?? '').split('\n').find((l) => /\bat\b/.test(l)) : undefined) ?? '';
      warnOnce(
        'header',
        `${baseUrl}`,
        // `#657`：带上源 id —— 用户贴的日志只有这一句话，没有源身份 ⇒ 无法知道是哪条源的
        // header 脚本产出非法 JSON（排查只能盲猜）。
        `[源 ${ctx.sourceId} @ ${baseUrl}] header 规则异常（java.ajax 源级请求头），已退化为默认 UA：${detail}${frame ? ` |${frame.trim()}` : ''}`,
      );
    },
  });
  const getSourceHeaders = (url?: string): Record<string, string> => {
    // ① 默认 UA 基底 → ② 源 header 规则（memo，防重入时为 {}）→ ③ 登录头覆盖同名项
    const out: Record<string, string> = { 'User-Agent': UA, ...headerResolver.get() };
    /**
     * 登录头（`source.putLoginHeader`）的对齐口径（2026-11-02，f:\legado @330e606）：
     *  · `AnalyzeUrl.kt:139-141`：`getHeaderMap(hasLoginHeader && isLoginHeaderSite(mUrl))`
     *    ⇒ **只给源同站请求**（封面/图床 CDN 跨域不带认证头，避免被风控 + 不外泄登录态）；
     *  · `BaseSource.getHeaderMap(hasLoginHeader = false)`：**无 URL 的取头**
     *    （脚本 `source.getHeaderMap()`、worker RPC）默认**不含**登录头。
     * 所以这里只有「拿到 URL 且判定同站」才合并登录头；无 URL ⇒ 保持上游默认（不含）。
     */
    const lh = ctx.variables.get('__loginHeader');
    if (typeof lh === 'string' && lh && url && isLoginHeaderSite(url, src?.['bookSourceUrl'] as string | undefined)) {
      try {
        const o = JSON.parse(lh) as Record<string, unknown>;
        for (const [k, v] of Object.entries(o ?? {})) if (v != null) out[k] = String(v);
      } catch {
        /* 非 JSON 忽略 */
      }
    }
    /**
     * ④ `#658` **过闸会话的 UA 最高优先**（存在才生效）。
     *
     * Cloudflare 的 `cf_clearance` 与 UA 绑定：验证窗里用桌面 Chrome 过的闸，源 header 却声明
     * 移动 UA ⇒ 带着 clearance 也 403。实测 138阅读网：cookie jar 里 `cf_clearance=…-1793144207`
     * 明明在，正文仍 `HTTP 403`，然后被判定「需要人工」又弹一次内置浏览器 —— 死循环。
     * 所以这里让「过闸那只浏览器」的 UA 覆盖源 header 的 UA，并留痕说明为什么换。
     */
    const sessionUa = ctx.variables.get('__sessionUa');
    if (typeof sessionUa === 'string' && sessionUa) {
      const prev = String(out['User-Agent'] ?? '');
      if (prev !== sessionUa) {
        warnOnce(
          'ua',
          ctx.sourceId ?? '',
          `[源 ${ctx.sourceId ?? ''}] 该源有已过闸的浏览器会话 ⇒ User-Agent 改用会话 UA（原 ${prev.slice(0, 48)}）`,
        );
        out['User-Agent'] = sessionUa;
      }
    }
    return out;
  };
  /**
   * `#196` 源身份标签（给 java-bridge 等留痕用）——格式 `源名(源id)`。
   *
   * 为什么必须带 id：**展示名会重名**（语料里就有多例），光有名定位不到具体源；
   * id = `bookSourceUrl` 的规范化形态（`https://m.weibo.cn` → `https___m.weibo.cn`）。
   */
  const sourceLabel = `${String(src?.['bookSourceName'] ?? '') || '(无名)'}(${ctx.sourceId})`;
  const srcStub = makeSourceStub(ctx, src, {
    sourceHeaders: getSourceHeaders,
    // `putConcurrent(v)` 上游 = updateConcurrentRate(getKey(), v)（BaseSource.kt:401）；
    // 桩本身不改限频表，落点由调用方注入（试跑探针不注入 ⇒ 不会顺手改本进程限频）
    onPutConcurrent: (v) => updateConcurrentRate(ctx.sourceId, v),
  });
  /**
   * `#723` `java.refreshBookInfo/Toc/Content`：上游只是 `EventBus.post(REFRESH_*, true)`
   * （通知 App 重拉详情/目录/正文）。服务端没有阅读界面 ⇒ 记为变量袋标记 + 留痕，
   * 上层（apps/server / 客户端）可据此决定是否重拉；脚本侧语义保持「调用即成功、不抛」。
   */
  const onRefreshBook = (kind: 'info' | 'toc' | 'content'): void => {
    const label = kind === 'info' ? '详情' : kind === 'toc' ? '目录' : '正文';
    ctx.variables.set(`__refresh_book_${kind}`, '1');
    warnOnce(
      'refresh-book',
      `${ctx.sourceId}|${kind}`,
      `[源 ${sourceLabel}] 脚本请求刷新${label}（服务端无阅读界面 ⇒ 已记 __refresh_book_${kind}=1，由上层决定重拉）`,
    );
  };
  const syncEvalOpts = {
    variables: ctx.variables,
    cookies: ctx.cookies,
    lib: resolveLib(lib),
    javaExtra,
    evalRule: evalRuleFull,
    onBrowserOpen,
    onToast,
    onUpLoginData,
    onRefreshBook,
    // `java.getSource()` 返回源桩；`java.getTag()` = `BookSource.getTag()` = bookSourceName
    getSource: () => srcStub,
    getTag: () => String(src?.['bookSourceName'] ?? ''),
    // 上游 `canOpenSourceUi` 默认 true（仅用户开启「阻止源网页跳转」时才 false）；本仓有前端浏览器通道
    canOpenSourceUi: () => true,
    getSourceHeaders,
    sourceLabel,
  };
  const env: AnalyzeEnv = {
    baseUrl,
    variables: ctx.variables,
    javaExtra,
    /**
     * `#722` `@webjs:` 规则模式（Legado `AnalyzeRule.getWebJsResult`）需要**真浏览器**：
     * 复用 `#676` 已注入的 CDP 通道（`Page.navigate` → `setDocumentContent` → `Runtime.evaluate`）。
     * 宿主没注入 ⇒ `env.webJsRender` 缺省 ⇒ `analyze.ts` 降级空串 + `@webjs degraded` 留痕（不抛）。
     */
    ...(ctx.renderHtmlScript
      ? { webJsRender: (h: string, b: string, j: string) => ctx.renderHtmlScript!(h, b, j) }
      : {}),
    // Legado bindings["source"] = source（规则字段 + BaseSource 方法桩）
    sourceData: srcStub,
    // 同 source 的**可克隆字段快照**：让含 java.ajax 的脚本能进 worker 池执行
    // （L1 的 execFileSync 同步阻塞事件循环 → 并发雪崩，见 roadmap Phase 0.1）
    ...(srcStub ? { sourceFields: cloneableFieldsOf(srcStub) ?? undefined } : {}),
    jsEvalSync: createJsEvaluator(syncEvalOpts),
    // `#636` 临时留痕：确认按源门控的判据在真链路上取到什么（只读原始 jsLib，无副作用）
    ...(process.env['YUEDU_DEBUG_JSLIB']
      ? {
          // eslint-disable-next-line no-console
          __jslibDebug: console.log(
            `[jslib:opt] raw jsLib len=${String(lib ?? '').length} urls=${jsLibUrls(String(lib ?? '')).length}`,
          ),
        }
      : {}),
    jsEval: createHybridJsEvaluator({
      variables: ctx.variables,
      cookies: ctx.cookies,
      /**
       * `#676` `java.webView(html, url, js)` 的宿主通道（worker 的同步 RPC 会等这个异步结果）。
       * 不做就只剩 `WEBVIEW_UNSUPPORTED` —— 爱看吧这类「注入脚本 + 同步 XHR」的源正文永远空。
       */
      ...(ctx.renderHtmlScript
        ? { renderHtmlJsAsync: (h: string, b: string, j: string) => ctx.renderHtmlScript!(h, b, j) }
        : {}),
      /**
       * `#727` `java.getVerificationCode(imageUrl)`：worker 的同步 RPC 会等宿主异步结果。
       * 宿主拉起/复用该源 Chromium、桌面端内置窗口人工输入 → Cookie 回灌 → 返回 code。
       * L1（`syncEvalOpts`）**不传**：主线程同步等 60s 会冻住服务端（见 js.ts 的说明）。
       */
      ...(ctx.verificationCode ? { verificationCodeAsync: (u: string) => ctx.verificationCode!(u) } : {}),
      lib: resolveLib(lib),
      // `#779` content 动作的纯计算求值预算（hub 只对 `action==='content'` 注入 20s；
      // 其余动作缺省 ⇒ 不覆盖，沿用 worker 池默认 10s）
      ...(ctx.jsComputeTimeoutMs ? { computeTimeoutMs: ctx.jsComputeTimeoutMs } : {}),
      /**
       * `#636` 第二层：**jsLib 是「远程 URL 表」的源 ⇒ lib 名字镜像到 realm 全局**。
       *
       * 判据 = `jsLibUrls(原始 jsLib)` 非空（如 qyyuapi 系：`{"包子漫画":"https://…/jsLib.js"}`）。
       * 为什么只对这些源开：这类源的公共函数库是**远程下发的多文件**（`jsLib.js` + `common.js` +
       * 规则外链），源作者的架构就假设「lib 作用域 = 全局」—— 外链脚本把函数挂到全局后
       * 闭包里调 `Get` 必须能解析到（实测有栈：`Get is not defined`，见 rounds/2026-10-26-10）。
       * 内联 jsLib 的普通源**不开**：`#611 step3` 的隔离锁（lib 声明不进全局）继续生效。
       */
      libGlobalNames: jsLibUrls(String(lib ?? '')).length > 0,
      javaExtra,
      // `#196`：L1 回落路径也要带源身份（hybrid 的 L1 实例会透传）
      sourceLabel,
      // java.getString(ruleStr) 桥：完整规则求值（JSONPath 快路径 + CSS/JS/正则走 AnalyzeRule）
      evalRule: evalRuleFull,
      // L4：worker 池（server 注入，带品牌标记才启用；测试桩自动回落 L1 进程内求值）
      pool: ctx.sandbox as import('@yuedu/core').JsSandboxPool & { __yueduWorkerPool?: boolean },
      // WebViewProvider：java.webView/startBrowserAwait 走真渲染（桌面端注入）
      renderer: ctx.webRenderer,
      // 「脚本要求打开浏览器」记录（登录流程据此把登录页交前端打开）
      onBrowserOpen,
      // java.toast / java.longToast 收集（登录按钮的反馈通路；L1 回落路径同样生效）
      onToast,
      // java.upLoginData —— 登录脚本要求实时更新界面字段值（随登录结果回传前端回填）
      onUpLoginData,
      // `#723` java.refreshBookInfo/Toc/Content（worker 经 rpc('refreshBook') 回宿主）
      onRefreshBook,
      // `#723` java.getSource/getTag/canOpenSourceUi（L1 与 worker 同一份语义）
      getSource: () => srcStub,
      getTag: () => String(src?.['bookSourceName'] ?? ''),
      canOpenSourceUi: () => true,
      // java.ajax 等的源级默认请求头（源 header 规则 ⊕ 登录头；Cookie 由 core 补）
      getSourceHeaders,
      /**
       * **规则桥**（`java.setContent/getElements/getElement/getStringList`，挂账 `#108`）。
       *
       * worker 里这四个方法经 `rpc('rule')` 回到这里求值 —— 宿主才持有 jsdom 与 `AnalyzeRule`。
       * 用**同一份 `AnalyzeRule`**（同一个 envRef）⇒ 与 L1 的 `ruleApi()` 语义一致，
       * 不会出现「同一规则 L1 与 worker 结果不同」的漂移。
       *
       * 失败**不静默**：`warnOnce` 留痕（否则又是「目录 0 章但日志干净」的形状）。
       */
      /**
       * 规则桥（`java.setContent/getElements/getElement/getStringList`）——
       * **唯一实现**在 `@yuedu/core` 的 `selector/rule-bridge.ts`（`#313`）。
       * 此前本文件与 `engine-rss/env.ts` 各写一份（连 `describeRuleNode` 都逐字重复），
       * 那次给桥加第三个 op（`'object'`）时三处类型当场对不上 —— 收敛成一处才是解法。
       */
      ruleBridge: makeRuleBridge({
        env: () => envRef,
        baseUrl,
        warn: (m) => warnOnce('rule-bridge', `${baseUrl}`, m),
      }),
      // worker 里的 java.ajax/post/get/head/getStrResponse：经 RPC 回宿主时走**注入的 HttpClient**
      // （代理 / 统一超时 / UA / mock 全生效），并把响应 Set-Cookie 回收进源 CookieStore。
      // L1 同步路径做不到这点（execFileSync 无法 await Promise），故那条路仍用 curl + core 的
      // onResponse 回写 Cookie —— 两条路都补齐了登录态落库，区别只在「是否走注入的 HTTP 栈」。
      http: async (r) => {
        /**
         * `#636` 第二层：**worker 侧可以点名超时**（`r.timeout`）。
         *
         * 之前这里一律用 `requestTimeout(ctx)`（= 本行动**还剩多少预算**，实测给到过 52s）：
         * `Reload()` 里那句 `java.head(url)`（只为拿 etag）就把整个搜索预算吃掉，
         * 真正要下载的脚本只剩 1s ⇒ 全部 `请求超时（>1000ms）`。
         * 现在：给了 `r.timeout` 就用它，但**仍然不许超过剩余预算**（不然会误伤整体超时语义）。
         */
        const asked = Number(r.timeout);
        const timeout = Number.isFinite(asked) && asked > 0 ? Math.min(asked, requestTimeout(ctx)) : requestTimeout(ctx);
        const resp = await ctx.http.request(r.url, {
          method: r.method,
          headers: r.headers,
          ...(r.body !== undefined ? { body: r.body } : {}),
          timeout,
          /**
           * `#742` worker 侧 `java.ajax` 的 URL 选项 `dnsIp`（IP 直连）必须在这里**落到 HttpClient**：
           * 这条注入的 `http` 是 worker 沙箱里唯一的 HTTP 出口，它此前只挑常用字段透传，
           * `dnsIp` 落到这里就断了 ⇒ 发现页/登录照样走被污染的 DNS（实测 home 63s + 空响应）。
           */
          ...(typeof r.dnsIp === 'string' && r.dnsIp.trim() ? { dnsIp: r.dnsIp } : {}),
          // `#387c`：worker 侧 `java.get/post` 要求不跟随重定向（manual）——必须透到 HttpClient
          ...(r.redirect ? { redirect: r.redirect } : {}),
          // `#708`：`Reload()` 的 HEAD 只是 etag 探测，失败不该把同域名下能成功的 GET 一起熔断
          countBreaker: r.method !== 'HEAD',
        });
        harvestCookies(ctx, resp);
        // HttpResponse.body 可能是 ArrayBuffer（二进制模式）；脚本按字符串用 → UTF-8 解码
        const body = typeof resp.body === 'string' ? resp.body : Buffer.from(resp.body).toString('utf-8');
        return { status: resp.status, headers: resp.headers, body };
      },
    }),
    // 绝对化基准 = **当前页 URL**（env.baseUrl 会随每次请求更新；Legado 用 redirectUrl 绝对化）
    toAbsolute: (u) => resolveUrl(envRef?.baseUrl ?? baseUrl, u),
    // `@put:{k:v}` 的持久落点（Legado AnalyzeRule.putRule → put()）
    putVariable: (k, v) => putSharedVariable(ctx, k, v),
  };
  envRef = env;
  return env;
}

/** 网络类错误判别（站点失联/超时/TLS）——包装层不得误报为规则错误 */
/**
 * 「这是网络层失败」的判定 —— 决定报 `NETWORK@request` 还是 `RULE_PARSE@parse`。
 *
 * 为什么必须认 `code` 与我们自己的中文文案：`core/src/net/index.ts` 的 `createHttpClient`
 * 会把失败包成 `Error`，**message 是 `describeNetworkError()` 的中文归因**、`code = 'NETWORK'`。
 * 而旧实现只扫 `cause.code` + 一层英文/errno 正则 → 我们自己的文案**一条都不匹配**，
 * 于是「DNS 解析失败（域名可能已失效）」被归成 `RULE_PARSE@parse`：
 * 用户看到的是「解析错误」，真因是网络 —— 与 #85 要消灭的误导性归因同类。
 */
function isNetworkError(e: unknown): boolean {
  const err = e as { message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } };
  const parts: string[] = [String(err?.message ?? e)];
  if (err?.cause) parts.push(String(err.cause.message ?? err.cause));
  parts.push(String(err?.code ?? ''), String(err?.cause?.code ?? ''));
  return /fetch failed|ENOTFOUND|ENOENT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|certificate|CERT_|TLS|socket hang up|aborted|NETWORK|DNS 解析失败|证书|连接超时|连接被拒|连接被重置|连接被中断|请求超时|请求被中断/i.test(
    parts.join(' | '),
  );
}

/**
 * 反混淆解包：部分站点把真实页面整体 base64 编码塞进 <script>，用
 * `document.writeln(atob(...))` 输出——非 JS 客户端只能拿到壳（规则选择器全落空）。
 * 壳判据成立时自动解出真实页面，语义等价浏览器执行 writeln 后的 DOM：
 *   ① 存在 `var x="base64大blob"`（≥500 字符）且页面含 atob；
 *   ② 解码结果是完整 HTML 文档；
 *   ③ 壳页 <script> 外的可见文本极少（正常页面不会整体包进 script）。
 * 另一变体（book4 目录 API）：整个响应就是一个 `x="base64"` 赋值——解码（再 URL 解码）
 * 后是 JSON/文本则替换。两种形态均为「浏览器能看、客户端拿壳」的站点自混淆。
 */
function unwrapWritelnShell(html: string): string {
  // 变体 B：纯 JS 赋值壳 `x="BASE64"` + 少量 atob 解码脚本（book4 目录 API：
  // 尾部自带 JSON.parse(decodeURIComponent(atob(dstr)))——解码方式站点自证）
  if (!html.includes('document.wr') && html.includes('atob')) {
    const bare = /([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z0-9+/=]{500,})"/.exec(html);
    if (bare) {
      const rest = html.replace(bare[0] as string, '').replace(/<[^>]*>/g, '').trim();
      if (rest.length < 400) {
        try {
          const dec = Buffer.from(bare[2] as string, 'base64').toString('utf-8');
          const plain = /%[0-9A-Fa-f]{2}/.test(dec) ? decodeURIComponent(dec) : dec;
          if (/^[\{\["]/.test(plain)) return plain;
        } catch {
          /* 解不开保持原样 */
        }
      }
    }
    return html;
  }
  if (!html.includes('document.wr') || !html.includes('atob')) return html;
  const m = html.match(/([A-Za-z_$][\w$]*)\s*=\s*"([A-Za-z0-9+/=]{500,})"/);
  if (!m) return html;
  let dec: string;
  try {
    dec = Buffer.from(m[2] as string, 'base64').toString('utf-8');
  } catch {
    return html;
  }
  if (!/^\s*(<!DOCTYPE|<html|<body)/i.test(dec) || !/<\/html>/i.test(dec)) return html;
  const visible = html
    .replace(/<script[\w\W]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  if (visible.length > 800) return html;
  return dec;
}

/** 把响应体解析为内容（惰性：字符串一律原样保留，DOM/JSON 由规则按需解析，R1）
 *  对齐 Legado：<js> 段的 result 是原始响应串；Json/CSS 规则按需 parse。
 *  例外：writeln(atob) 壳页自动解包（浏览器语义，见 unwrapWritelnShell）。 */
function parseResponse(resp: { body: string | ArrayBuffer; url: string }): { content: unknown } {
  if (typeof resp.body !== 'string') {
    const text = Buffer.from(resp.body as ArrayBuffer).toString('utf-8');
    return { content: unwrapWritelnShell(text) };
  }
  return { content: unwrapWritelnShell(resp.body) };
}

/** 按目标字符集把单个字符百分号编码（GBK 站搜索词对齐 Legado encodeParams 语义） */
function percentEncode(ch: string, charset: string): string {
  const bytes = iconv.encode(ch, charset);
  let out = '';
  for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/** {{}} 内嵌规则先按当前内容求值替换进 URL/脚本文本（Legado makeUpRule 对 Js 段/URL 同样生效）：
 *  `$.` 开头按 JsonPath 对内容求值，其余按 JS 求值（key/page 绑定可用） */
async function resolveInnerRules(
  code: string,
  content: unknown,
  env: AnalyzeEnv,
  baseUrl: string,
  keyword: string,
  page: number,
): Promise<string> {
  const matches = [...code.matchAll(/\{\{([\w\W]*?)\}\}/g)];
  if (!matches.length) return code;
  let out = '';
  let last = 0;
  for (const m of matches) {
    const whole = m[0];
    const expr = (m[1] ?? '').trim();
    const idx = m.index ?? 0;
    out += code.slice(last, idx);
    last = idx + whole.length;
    if (!expr) {
      out += whole;
      continue;
    }
    let v: unknown;
    try {
      if (expr.startsWith('$')) {
        v = content == null || content === '' ? '' : jsonGetString(expr, content, env);
      } else {
        v = await env.jsEval(expr, baseBindings(env, { $: content ?? '', key: keyword, page, baseUrl }));
      }
    } catch {
      out += '';
      continue;
    }
    out += v == null ? '' : String(v);
  }
  out += code.slice(last);
  return out;
}

/**
 * 求值 `loginUi` 动态脚本（`@js:` / `<js>`）得到行数组。
 * 对齐 Legado `BaseSource.getLoginInfoMap()` 里的 evalJS：
 *   `${getLoginJs()}\n$loginUiJs`，bindings 预置 `result = {}`（脚本可能用 `result = JSON.stringify(rows)`）。
 *
 * ⚠️ **求值失败必须留痕 + 把原因带回对话框**（`#411`，铁律 4）。
 *   旧实现 `catch { return [] }` 是**纯静默**：18AV 的 `loginUi` 第一条就调
 *   `java.importScript(...).match(...)[1]`，而本仓 java 桩缺 `importScript`
 *   ⇒ TypeError ⇒ 行数组为空 ⇒ 对话框只剩「打开登录窗口」，日志里**一个字都没有**
 *   —— 与「源本来就没写 loginUi」的症状完全不可分辨。
 */
async function resolveLoginFields(
  plan: { js: string; uiRaw: string },
  env: AnalyzeEnv,
  sourceLabel: string,
): Promise<{ fields: LoginField[]; error?: string }> {
  const uiJs = extractInlineJs(plan.uiRaw) ?? '';
  if (!uiJs) return { fields: [] };
  const code = `${plan.js ? `${plan.js}\n` : ''}${uiJs}`;
  let out: unknown;
  try {
    out = await env.jsEval(code, { result: {}, source: env.sourceData, baseUrl: env.baseUrl });
  } catch (e) {
    const msg = errText(e);
    warnOnce('loginui-eval', sourceLabel, `loginUi 脚本求值失败（登录对话框拿不到行）：${msg}`);
    return { fields: [], error: msg };
  }
  const fields =
    typeof out === 'string'
      ? parseLoginUiText(out)
      : Array.isArray(out)
        ? out.map(normalizeLoginField).filter((x): x is LoginField => !!x)
        : [];
  if (fields.length) return { fields };
  // 「跑通了但一行都没产出」也是一种缺陷（与「站点没给行」同症状）——留痕并带上产出片段
  const produced = typeof out === 'string' ? out : JSON.stringify(out ?? null);
  const msg = `loginUi 脚本未产出任何行（返回类型 ${typeof out}，前 120 字：${String(produced ?? '').slice(0, 120)}）`;
  warnOnce('loginui-empty', sourceLabel, msg);
  return { fields: [], error: msg };
}

/** 列表为空时给前端一个「为什么空」的线索（对齐用户诉求：不要静默空卡片） */
function emptyHintOf(body: unknown): string | undefined {
  const t = typeof body === 'string' ? body : body instanceof ArrayBuffer ? Buffer.from(body).toString('utf-8') : '';
  const s = t.trim();
  if (!s) return '站点返回空响应（可能是网络被拦、需要登录或源已失效）';
  /**
   * `D11`：闸页（年满18岁声明）。core 的 HTTP 出口（引擎出口 / `java.ajax` 出口）会**静默过闸并重放**，
   * 走到这里 = 过闸**没有成功**（站点拒了放行 or 网络异常）。必须给可操作的出路，
   * 否则用户只看到「列表 0 条」，与「选择器不匹配」分不开。
   */
  if (isAgeGatePage(s)) return '站点返回「年满18岁声明」闸页（自动过闸未成功）⇒ 点该源「登录」打开登录窗口人工过闸后刷新';
  if (s.length > 400) return undefined; // 正常大小的页面：不猜（多为选择器不匹配）
  if (s.startsWith('<')) return undefined; // 像 HTML：不猜
  return `站点返回：${s.slice(0, 200)}`;
}

/** options 尾巴解析：严格 JSON 优先，失败回退 JS 对象字面量（Legado 源常见 `body:` 无引号键写法） */
/**
 * 解析 `,{...}` 请求选项（method/body/headers/charset）。
 *
 * ⚠️ 兜底**不能是 jsEval**（2026-09-16 修）：JS 字符串字面量会吃掉未知转义的反斜杠，
 * 把 `body:"bookId={{baseUrl.match(/(\d+)/)[1]}}"` 的 `\d` 变成 `d` → 正则退化成 `/(d+)/`
 * → body 变成 `bookId=d` → 站点返回 `[]` → 目录 0 章（实测源：悦读小说）。
 * 改用 core 的 `parseJsonLoose`：标准 JSON → 修非法转义 → 宽松 tokenizer（无引号键/值）。
 */
function parseOptionsTolerant(str: string): Record<string, unknown> | undefined {
  return parseJsonLooseObject(str);
}

/** 规整请求头（支持 JSON 字符串 / @js: 表达式） */
/** 丢弃无效 header 值：空串 / JS 求值残留的 undefined、null——
 *  okhttp 语义：永不发送空 UA；空 UA 会被部分 nginx 直接 400 */
/**
 * 规整源 `header` 规则产出的头。
 *
 * ⚠️ **必须保留「值为空串」的头**（2026-09-17 实锤，接口鉴权类失败的真因）：
 * 旧实现用 `if (s && ...)` 把空值头一起丢掉，而**签名 API 的服务端会按收到的字段集重算签名**
 * —— 少几个「存在但为空」的头，字段集就与源脚本签名时不一致 → 站点判定签名无效。
 *
 * 实测（星空小说 `https://api-bc.zonghengxiaoshuo.com`，同一 URL 同一 sign，只差三个空值头）：
 *   丢弃空值头 → `401 {"Status":"Unauthorized"}`
 *   补回空值头 → `200` + 9452 字节真实书单
 * Legado 的 `getHeaderMap()` 是原样 putAll，不过滤空值。
 *
 * 只丢弃 **null / undefined 字面量**（JSON 里显式 null，或字符串 "null"/"undefined" 这类
 * JS 未赋值痕迹）；空串是源作者的**有意声明**，必须发出。
 */
function cleanHeaders(h: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    const s = typeof v === 'string' ? v : String(v);
    if (s === 'undefined' || s === 'null') continue;
    out[k] = s;
  }
  return out;
}

/** 错误对象 → 一行可读文本（源脚本抛出的常常是字符串/Proxy 值，不是 Error） */
function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/**
 * 每个「源 + 阶段」只警告一次。
 * 用途：引擎里若干 `catch` 出于健壮性必须兜底（如 header 规则失败退化为 UA），
 * 但**静默兜底 = 无从排查**。兜底要保留，同时必须留痕。
 */
const warnedKeys = new Set<string>();
function warnOnce(stage: string, key: string, msg: string): void {
  const id = `${stage}|${key}`;
  if (warnedKeys.has(id)) return;
  warnedKeys.add(id);
  console.warn(`[legado] ${msg}`);
}

/**
 * `#696` **Legado 调试信息流的一行**（对齐上游 `Debug.log(msg)`，`Debug.kt:66-93`）。
 *
 * 上游那套日志的形制是固定的：`┌标题` / `└值` 成对、`≡` 表示网络事实、`◇` 汇总、
 * `︾` 开始解析某页 / `︽` 完成、`⇒` 开始访问某地址。它不是给人「读」的散文，
 * 而是**规则的执行回执** —— 用户看它主要是确认三件事：
 *  ① 规则到底对哪个页面求值（URL / 是否被重定向）；
 *  ② 每个字段取到了什么（空的就该去修那条规则）；
 *  ③ 走到哪一步停的（哪一步之后没有输出了，问题就在那一步）。
 *
 * 落点：`ctx.trace.push({ msg })`（宿主订阅 trace 即可流式推给前端，
 * 出错时同一批条目还会进 `EngineError.trace`）。**日志绝不允许影响解析** ⇒ 整体 try/catch。
 */
function dlog(ctx: EngineContext | undefined, msg: string, level?: 'warn' | 'error'): void {
  if (!ctx) return;
  try {
    ctx.trace.push({ stage: 'parse', msg, ...(level ? { level } : {}) });
  } catch {
    /* 调试通道故障不能改变解析结果 */
  }
}

/** `#696` 字段名 → 上游信息流里的中文标签（`BookInfo.kt:67-137` / `BookList.kt:219-285`） */
const FIELD_LABEL: Record<string, string> = {
  name: '书名',
  author: '作者',
  kind: '分类',
  wordCount: '字数',
  lastChapter: '最新章节',
  intro: '简介',
  coverUrl: '封面链接',
  tocUrl: '目录链接',
  bookUrl: '详情页链接',
};

/**
 * `#696` 打「┌获取X / └值」这一对（上游就是这么两行，缺一不可：
 * 只有标题行说明规则抛错了；只有值行看不出这是哪个字段）。
 * 值超长时（简介/正文）截断 —— 上游原样打印，但 Web 端一次 SSE 帧塞几千字没有意义。
 */
function dlogField(ctx: EngineContext | undefined, label: string, value: unknown, maxLen = 300): void {
  if (!ctx) return;
  const raw = value === undefined || value === null ? '' : String(value);
  const v = raw.length > maxLen ? `${raw.slice(0, maxLen)}…(共 ${raw.length} 字)` : raw;
  dlog(ctx, `┌获取${label}`);
  dlog(ctx, `└${v}`);
}

/** 截一行里的长串（URL 尤其长：带签名/`data:;base64,` 的能上 400 字，全打出来信息流就没法看了） */
function clip(v: string, maxLen: number): string {
  return v.length > maxLen ? `${v.slice(0, maxLen)}…(${v.length}字)` : v;
}


/**
 * 规则求值的**标准绑定**（对齐 Legado `AnalyzeUrl.kt:377-394` 的 evalJS bindings：
 * java / baseUrl / page / key / result / book / source）。
 *
 * ⚠️ **为什么要有这个函数**（2026-09-17 实测教训）：
 * 求值点原先各自手写 bindings，导致**绑定面不一致** —— 同一个 `@js:` 规则在 A 处能拿到
 * `source`、在 B 处却只能拿到空桩（`defaultSourceStub.key === ''`）。
 * 后果不是报错而是**静默错值**：源 header 里 `if(/zonghengxiaoshuo/.test(source.getKey()))`
 * 恒假 → 变量未赋值 → 整条 header 规则抛错 → 被 catch 吞掉 → **只发 UA，签名字段全丢**
 * → 站点回 `{"Status":"Unauthorized"}`（星空小说实测）。这类「接口鉴权失败」长期被误判成
 * 「站点侧不可控」，真因是引擎绑定面不齐。
 */
function baseBindings(env: AnalyzeEnv, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    baseUrl: env.baseUrl ?? '',
    book: env.bookData ?? {},
    source: env.sourceData ?? {},
    ...(extra ?? {}),
  };
}

/**
 * 主抓取通路的源级头解析（**异步 hybrid 求值器**）——`#467` 起判据本体在 core
 * （`evaluateSourceHeaderRuleAsync`，与 RSS prime / `/api/proxy` 同一份）。
 * 与 {@link getSourceHeaders}（java.ajax 的同步面）共用 memo 落点（`ctx.variables`），
 * 但这条通路不读 memo —— 每次请求都重新求值（上游主通路本就每次构造 AnalyzeUrl）。
 */
async function resolveHeaders(header: string | undefined, env: AnalyzeEnv): Promise<Record<string, string>> {
  const base: Record<string, string> = { 'User-Agent': UA };
  if (!header) return base;
  const ruleHeaders = await evaluateSourceHeaderRuleAsync({
    raw: header,
    // 绑定 baseUrl + **source**（对齐 Legado AnalyzeUrl initBind）
    evalJs: (code) => env.jsEval(code, baseBindings(env, { result: {} })),
    warn: (channel, detail) => {
      // 旧口径：只对脚本求值抛错留痕；形状/静态不符静默退化为 UA
      if (channel !== 'eval') return;
      warnOnce('header', env.baseUrl ?? '', `源 header 规则求值失败，已退化为默认 UA：${detail}`);
    },
  });
  return { ...base, ...cleanHeaders(ruleHeaders) };
}

/** 插值 URL 模板：{{key}} / {{page}} 等（含 JS 求值） */
async function interpUrl(
  tpl: string,
  keyword: string,
  page: number,
  env: AnalyzeEnv,
  source?: Record<string, unknown>,
  content?: unknown,
  /** `{{<规则>}}` 的规则求值器（Legado makeUpRule 的 isRule 分支）——省略时统一按 JS 求值 */
  evalRule?: (rule: string) => Promise<string>,
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
    // Legado AnalyzeRule.SourceRule.makeUpRule:791-808 —— `{{}}` 里若是**规则**
    // （`@`/`$.`/`$[`/`//` 开头，isRule）先走规则求值，否则才当 JS 表达式。
    // ⚠️ 旧实现一律走 jsEval：`$..comic_id` 在 JS 里是语法错误 → 恒为空串，
    // 于是 `tocUrl: "…?comic_id={{$..comic_id}}"` 解析成 `…?comic_id=`（武芊漫画目录只剩 1 条）。
    let v: unknown;
    if (evalRule && isRuleExpr(param)) {
      v = await evalRule(param);
    } else {
      // Legado AnalyzeUrl.kt:377-394 evalJS 的 bindings：java/baseUrl/page/key/result/book/source
      // ⚠️ `$`/`result` 必须绑当前内容（2026-09-16 修）——否则 `{{$.x}}` 恒为空。
      v = await env.jsEval(param, {
        $: content ?? '',
        result: content ?? '',
        key: keyword,
        page,
        baseUrl: env.baseUrl ?? (env.variables.get('baseUrl') as string | undefined) ?? '',
        book: env.bookData ?? {},
        // 兜底 source（连 source 都没传的极端路径）：给**同样形态**的登录信息空表
        // （方括号 + .get 都能用），而不是旧实现的 JS `Map`（方括号恒 undefined）。
        source: source ?? env.sourceData ?? { getKey: () => '', getVariable: () => '', getLoginInfoMap: () => attachJsonMapMethods({}) },
      });
    }
    out += v == null ? '' : String(v);
  }
  out += tpl.slice(last);
  return out;
}

/** 正文/图片/媒体页内容提取（供首页与分页循环复用） */
type ContentKind = 'text' | 'image' | 'media';
// `#346`：`MEDIA_EXT_RE` / `parseMediaCandidate` / `absMediaUrl` / `toMedia` 已下沉
// `@yuedu/core` 的 `content/media-extract.ts`（订阅源同形态也要用，避免两份判据漂移）。

/**
 * 从单个 `<img …>` 标签里取图片 URL —— **对齐 Legado `HtmlFormatter.formatImagePattern`**。
 *
 * 分支顺序**就是优先级**（Legado 用正则 alternation 表达，从左到右先命中先赢）：
 *   ① `src` 的值是 `{…}` 未展开模板（`src="{$.url}.jpg"`）→ 取它
 *   ② **`data-src` / `data-original` / `data-srcset`** → 取它
 *   ③ `src`（双引号形态）
 *   ④ 其它 `data-*` / `src`
 *
 * ⚠️ 为什么必须有（2026-09-23 修，缺陷类AM）：**懒加载图站点的 `<img>` 里
 * `src` 是占位符、真实图在 `data-src`**，而属性顺序是 `src=` 在前。
 * 我们此前用的正则 `/<img[^>]*?(?:data-src|data-original|src)\s*=\s*["']([^"']+)["']/gi`
 * 里 `[^>]*?` 是**懒惰**的 —— 引擎从左往右扫，一碰到 `src=` 就命中并捕获**占位符**，
 * 于是 data-src 永远轮不到。
 * 实测（🎨51漫画正文，`ruleContent.content = ".comics@img@html"`）：
 * 章节页每个 `<img src="/static/web/images/loading.png" data-src="https://xi.dzuxta.cn/…jpeg?auth_key=…">`
 * 占位符全站同一张 ⇒ 去重后**正文只剩 1 张占位图**（用户可见症状：正文只有一张 lazy 占位图片）。
 * 站点侧对照：同一页面 `data-src` 有 11 张真实图（`…-1.jpeg` … `…-11.jpeg`）。
 */
const IMG_ATTR_RES: readonly RegExp[] = [
  // ① src 含 {…} 未展开模板
  /\ssrc\s*=\s*['"]([^'"{}]*\{(?:[^{}]|\{[^}>]+\})+\})['"]/i,
  // ② 懒加载属性（优先级高于 src —— 这是本条修复的核心）
  /\sdata-(?:src|original|srcset)\s*=\s*['"]([^'">]+)['"]/i,
  // ③ 普通 src（双引号）
  /\ssrc\s*=\s*"([^">]+)"/i,
  // ④ 任意 data-* 或 src（单引号/空值兜底）
  /\s(?:data-[^=>]*|src)=\s*['"]([^'">]*)['"]/i,
];
function extractImgUrl(tag: string): string {
  /**
   * `#744` **裸引号选项尾巴**：`src="http://<IP>/a.jpg,{"headers":{"Host":"storage-b…"}}"`。
   *
   * 源（哔咔 `picac_img`）把 URL 选项 JSON 用**裸双引号**拼进 `src`，内部的 `"` 会让
   * ③ `\ssrc\s*=\s*"([^">]+)"` 在 `{` 后第一个引号处截断 ⇒ 拿到 `http://<IP>/a.jpg,{`
   * （尾巴不完整 ⇒ 前端 `imgSrc` 拆不出来 ⇒ 丢了 `Host` ⇒ 代理按 IP 建连，CF `error code 1003`）。
   * ⇒ 与 `mapImgTags`（`#583`）同一判据：取「`src="` 之后到标签内**最后一个** `"`」；
   * 只在**含选项尾巴**（`,{`）时才走这条，其余属性优先级不变（懒加载 `data-src` 不受影响）。
   */
  const qm = /\ssrc\s*=\s*"/i.exec(tag);
  if (qm) {
    const q1 = (qm.index ?? 0) + qm[0].length;
    const q2 = tag.lastIndexOf('"');
    if (q2 > q1) {
      const v = tag.slice(q1, q2);
      if (v.includes(',{')) return v;
    }
  }
  for (const re of IMG_ATTR_RES) {
    const m = re.exec(tag);
    if (m && m[1]) return m[1];
  }
  return '';
}

/**
 * `#583` **源自绘图片按钮**：`<img src="data:image/svg+xml;base64,<svg>,{"style":"text","type":"qmpl","click":"…"}"`
 *
 * 七猫 jsLib 的 `qmC_AppendComments` 在每段末尾追加这样一张图（`style:"text"` = 行内小图，
 * `FULL` = 整宽条），点它要跑源 jsLib 里的 `qmC_OpenComment`。这类图**不是正文插图**——
 * 旧路径把它当普通图片换成 `[图]`，于是用户「段评/本章说/神评/书评一个都看不到」。
 *
 * 判据只用「src 尾巴是不是 `,{…}` 且 JSON 里有 click/type/style」：
 * 普通插图（含 data URL 插图）不带这段选项 JSON，不会误判（`#583` 不影响其它源）。
 *
 * ⚠️ src 里的选项 JSON 用的是**裸双引号**（`JSON.stringify` 没转义）⇒ 属性在解析器眼里
 * 会在 `{` 后第一个引号处断开。所以这里**不能用 DOM 解析**，按「整段 `<img …>` 到最后一个
 * `>`」抓取、再按**最后一个 `,{`** 切分（与前端壳层 `buildImageOptionBridge` 同一判据）。
 */
export function parseOptionImageSrc(src: string): { src: string; opt: Record<string, unknown> } | null {
  const at = String(src ?? '').lastIndexOf(',{');
  if (at < 0) return null;
  const head = src.slice(0, at);
  if (!head.trim()) return null;
  let opt: unknown;
  try {
    opt = JSON.parse(src.slice(at + 1));
  } catch {
    return null;
  }
  if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null;
  const o = opt as Record<string, unknown>;
  if (!o['click'] && !o['type'] && !o['style']) return null;
  return { src: head, opt: o };
}

/**
 * 逐个扫 `<img …>`：回调返回替换文本，返回 null 表示「保持原样」。
 *
 * 不用正则的理由（`#583` 实测）：选项 JSON 是**裸引号**，任何 `"([\s\S]*?)"` 都会在第一个内部
 * 引号处提前收尾；而贪婪版又会跨多个 `<img>` 一路吃到最后一个标签。按**字符串索引**扫最稳。
 */
function mapImgTags(raw: string, fn: (tag: string, src: string) => string | null): { out: string; hits: number } {
  let out = '';
  let i = 0;
  let hits = 0;
  const lower = raw.toLowerCase();
  for (;;) {
    const start = lower.indexOf('<img', i);
    if (start < 0) {
      out += raw.slice(i);
      break;
    }
    const end = raw.indexOf('>', start);
    if (end < 0) {
      out += raw.slice(i);
      break;
    }
    const tag = raw.slice(start, end + 1);
    const m = /\bsrc\s*=\s*"/i.exec(tag);
    let src = '';
    if (m) {
      const q1 = (m.index ?? 0) + m[0].length;
      const q2 = tag.lastIndexOf('"');
      if (q2 > q1) src = tag.slice(q1, q2);
    }
    const rep = fn(tag, src);
    if (rep != null) hits++;
    out += raw.slice(i, start) + (rep ?? tag);
    i = end + 1;
  }
  return { out, hits };
}

/** `#583` 选项 `type` → 可读标签（源作者约定；未知类型给空串，前端只显示图片） */
const UI_MARK_LABELS: Record<string, string> = {
  qmpl: '段评',
  'qmpl-chapter-preview': '本章说',
  'qmpl-god': '神评',
  'qm-review': '书评',
};

function extractFromRaw(
  raw: string,
  base: string,
  kind: ContentKind,
  literal?: string,
): { paragraphs: string[]; media?: UnifiedContent['media']; uiMarks?: ContentUiMark[] } {
  if (kind === 'image') {
    const urls = new Set<string>();
    // 逐个 `<img …>` 标签抽取（属性优先级见 IMG_ATTR_RES），而不是在整段上找「第一个出现的属性」
    const tagRe = /<img\b[^>]*>/gi;
    let im: RegExpExecArray | null;
    while ((im = tagRe.exec(raw))) {
      const u = extractImgUrl(im[0]);
      if (u) urls.add(u);
    }
    if (urls.size === 0) {
      // 救援：整段就是**单个媒体直链** → 产出 media 而不是一张坏图。
      // 实测：红牛资源 `bookSourceType=2`（图片）但 content 规则返回一个 m3u8 直链。
      // Legado 靠 `BookType` 分流阅读器，我们按**内容形态**兜底（前端据 media 直接起播放器）。
      const sole = raw.trim();
      const naked = (sole.split(',{')[0] ?? sole).trim();
      if (/^https?:\/\/\S+$/i.test(naked) && MEDIA_EXT_RE.test(naked)) {
        return { paragraphs: [], media: toMedia(sole, base) };
      }
      for (const line of raw.split(/\s+/)) {
        if (/^(https?:\/\/|data:image)/.test(line)) urls.add(line);
      }
    }
    const paragraphs = [...urls].map((u0) => {
      const comma = u0.indexOf(',{');
      const head = comma >= 0 ? u0.slice(0, comma) : u0;
      /**
       * `#744` **图片 URL 的 `,{…}` 选项尾巴必须保留**（上游同样保留：Legado 的图片加载器
       * 就是 `AnalyzeUrl` 拆尾巴，Glide 的 `getGlideUrl` 只带上 `url + headerMap`）。
       *
       * 实测（哔咔正文 40 张图）：源产出 `http://<CF IP>/static/…jpg,{"headers":{"Host":"storage-b…"}}`
       * 这类「IP 进 URL + Host 头」。此前这里把尾巴**整个丢掉** ⇒ 前端 `imgSrc` 拿不到 `Host`
       * ⇒ 只能把裸 `http://<IP>/…` 交给 `/api/proxy`（Host 头 = IP）⇒ CF 回
       * `403 error code: 1003`（实测 6428ms/2788ms/3938ms）；保留尾巴后改写成
       * `https://storage-b…/…jpg + dnsIp=<该 IP>` ⇒ **200 image/jpeg 269525/251754/250525 字节**。
       */
      const tail = comma >= 0 ? u0.slice(comma) : '';
      const abs = /^(https?:\/\/|data:image)/i.test(head) ? head : resolveUrl(base, head) ?? head;
      return abs + tail;
    });
    return { paragraphs };
  }
  if (kind === 'media') {
    // 统一走「按可信度排序」的候选收集（见 collectMediaCandidates 注释）——
    // 原来只认 `<audio|video|source src>` + 「第一个绝对 URL」，后者在真实播放页上
    // 通常命中 css/js/图片 CDN，必然取错（用户看到「未取到媒体地址」）。
    const cands = collectMediaCandidates(raw, literal);
    // 备选一并下发：排序是启发式的，哪条真能放只有前端知道（见 toMedia 注释）
    return { paragraphs: [], media: toMedia(cands[0] ?? '', base, cands.slice(1)) };
  }
  // 阅读层清理：块级标签边界 → 换行，图片 → 占位，剥离其余标签。
  // ⚠️ **开标签也要算边界**（不只闭标签）：HTML 允许块级元素省略闭合标签，站点正文里
  // `…。<p>街上…<p>当今…` 这种「裸 `<p>` 分隔」非常常见（实测绿柠小说 `downloadchapter` 的
  // `Content` 解密后就是这种形态）—— 只认 `</p>` 会让整章被并成**一段**（前端显示成一坨）。
  /**
   * `#583` **先摘出「选项图按钮」，再做文本清理**：
   *  · 选项图（`<img …,{…click…}>`）替换成**哨兵** `\u0001<idx>\u0001` ⇒ 不会被下面的
   *    `<img>`→`[图]` 吃掉，也不会污染正文（按钮改由 `uiMarks` 下发，仍是文本阅读模式）；
   *  · 普通插图照旧走 `[图]`（既有行为不变）。
   *
   * ⚠️ 为什么不用 `html`（第一版方案已被用户 2026-10-23 复测否决）：下发 html 会把整章切到
   * `<iframe srcdoc>`，阅读样式/划词工具/高亮/分页全部失效。用户只要「正文照旧 + 评论按钮」。
   */
  const uiButtons: Array<{ img: string; click: string; type: string; style: 'text' | 'full'; label: string }> = [];
  let textRaw = raw;
  if (/<img\b/i.test(raw)) {
    textRaw = mapImgTags(raw, (_tag, src) => {
      const p = parseOptionImageSrc(src);
      if (!p) return null; // 普通插图不在这里处理
      const type = String(p.opt['type'] ?? '');
      const style = String(p.opt['style'] ?? '').toLowerCase() === 'text' ? 'text' : 'full';
      uiButtons.push({ img: p.src, click: String(p.opt['click'] ?? ''), type, style, label: UI_MARK_LABELS[type] ?? '' });
      return `\u0001${uiButtons.length - 1}\u0001`;
    }).out;
  }
  /**
   * `#643` **对齐上游正文「净化 + 实体解码」两步**（`BookContent.kt:252-255`）：
   * ```kotlin
   * content = HtmlFormatter.formatKeepImg(content, rUrl)     // 内含 (&nbsp;)+ → ' ' + 删标签
   * if (content.indexOf('&') > -1) content = StringEscapeUtils.unescapeHtml4(content)
   * ```
   * 我们这条链是自研的（要支持 `[图]` 占位与 `uiMarks` 按钮），但**两步都不能少**：
   *
   * ① `(&nbsp;)+` → 空格：上游 `HtmlFormatter.nbspRegex` 在**删标签之前**就合并，
   *    所以 `&nbsp;&nbsp;&nbsp;&nbsp;正文` 这种「用实体做缩进」的正文才不会留一堆字面量。
   *    ⚠️ 只在有实体时才跑，避免给每章多一次全量 replace。
   * ② `unescapeHtml4`：**删完标签之后**解码剩余实体（`&amp;`/`&ldquo;`/`&hellip;`…）。
   *    必须在删标签之后 —— 否则 `&lt;` 解出的 `<` 会被当成标签删掉。
   *
   * 实测（`#643` 笔趣阁·恋爱呀 `https___m.lianaiya.com_`）：修补前整章 2478 字里
   * **160 处字面 `&nbsp;`** 直接显示在阅读区；修补后为 0（正则 `\u00a0` 再用一次收尾）。
   */
  const entityNormalized = /&(?:nbsp|ensp|emsp);/i.test(textRaw)
    ? textRaw.replace(/(&nbsp;)+/g, ' ').replace(/(&ensp;|&emsp;)/g, ' ')
    : textRaw;
  const readable = entityNormalized
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|h[1-6]|li|blockquote|dd|dt)\b[^>]*>/gi, '\n')
    .replace(/<img[^>]*?alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => `[图:${alt}]`)
    .replace(/<img[^>]*>/gi, '[图]')
    .replace(/<[^>]+>/g, '');
  /** 上游 `BookContent.kt:253-255`：`&` 还在才解码（`unescapeHtml4` 自身也有这个短路） */
  const decoded = readable.indexOf('&') >= 0 ? unescapeHtml4(readable) : readable;
  const paragraphs: string[] = [];
  const uiMarks: ContentUiMark[] = [];
  /** 把一个哨兵按钮记到段落下标（`-1` = 章末） */
  const pushMark = (idx: number, para: number): void => {
    const b = uiButtons[idx];
    if (!b) return;
    uiMarks.push({
      para,
      img: b.img,
      click: b.click,
      ...(b.type ? { type: b.type } : {}),
      style: b.style,
      ...(b.label ? { label: b.label } : {}),
    });
  };
  for (const rawLine of decoded.split('\n')) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;
    const ids: number[] = [];
    const text = line.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => {
      ids.push(Number(i));
      return '';
    }).trim();
    /**
     * **整行只有按钮**（源把整宽条单独 push 成一行）：
     *  · 本章说 / 书评 ⇒ 挂在**章末**（`-1`）；
     *  · 神评 ⇒ 跟在**上一段**后面（源写法是 `lines[i] += '\n' + god`）。
     */
    if (!text) {
      for (const id of ids) {
        const type = uiButtons[id]?.type ?? '';
        const atEnd = type === 'qmpl-chapter-preview' || type === 'qm-review';
        pushMark(id, atEnd ? -1 : paragraphs.length ? paragraphs.length - 1 : -1);
      }
      continue;
    }
    paragraphs.push(text);
    const para = paragraphs.length - 1;
    for (const id of ids) pushMark(id, para);
  }
  /**
   * ★ **文本源里的「裸媒体直链」→ 升级为 `media`**（2026-09-24，B 项）。
   *
   * 为什么必须按**内容形态**兜底：视频源常被标成 `bookSourceType=0`（文本）——
   * 用户实测 🎬🔞麻豆传媒AI 就是这种，`ruleContent.content` 直接产出一个 m3u8 代理直链：
   * `https://mdcmai4.xyz/api/v1/m3u8/proxy?path=…/f55a885a….m3u8`
   * 按 type 分流的话它只会变成**一段文本**（前端当正文显示一串 URL），`media` 永远为空
   * ⇒ 用户看到「未取到媒体地址」。这与图片源那条救援注释（红牛资源 type=2 却返回 m3u8）
   * 是同一个判断：**类型标记不可信，看内容形态**。
   *
   * 保守条件（避免把正常正文误判成媒体）：整章**只有一段**、是**单个不含空白的 http(s) 串**、
   * 且带媒体扩展名（`MEDIA_EXT_RE`，含 query 里的 `.m3u8`）。
   */
  if (paragraphs.length === 1) {
    const sole = (paragraphs[0] ?? '').trim();
    if (!/\s/.test(sole) && /^https?:\/\//i.test(sole) && MEDIA_EXT_RE.test(sole)) {
      const media = toMedia(sole, base);
      if (media) return { paragraphs: [], media };
    }
  }
  return { paragraphs, ...(uiMarks.length ? { uiMarks } : {}) };
}

/** 分页上限（目录/正文）：防源规则异常导致无限追页 */
const MAX_TOC_PAGES = 200;
const MAX_CONTENT_PAGES = 30;

/**
 * 响应 Set-Cookie 回收进源级 Cookie 存储（对齐 okhttp CookieJar / Legado CookieStore）：
 * 登录与反爬流程常靠「响应下发 cookie → 后续请求自动带上」，此前只发不收 → 会话拿不到。
 * 带 Max-Age=0 / 1970 过期时间的条目视为删除。
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

/** 数 Cookie 条数（`a=b; c=d` → 2） */
function countCookies(header: string): number {
  return header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes('=')).length;
}

/**
 * `java.upLoginData(map)` 的收集结果（键 = 登录界面行 `name`）—— 随登录结果回传前端回填表单。
 * 落点与语义见 `makeEnv` 的 `onUpLoginData`；`engine-rss` 用同一条判据（两引擎同一上游 API）。
 */
function loginDataUpdate(ctx: EngineContext): Record<string, string> {
  const raw = String(ctx.variables.get('__upLoginData') ?? '');
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 字节数组归一（图片解密返回值可能是 Array/Uint8Array/Buffer；其它类型视为无效） */
function toBytesOrNull(v: unknown): Uint8Array | null {
  if (v == null) return null;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => Number(x) & 0xff));
  if (typeof v === 'string') return null; // 字符串不是图片字节
  return null;
}

/**
 * Legado String.isTrue()（StringExtensions.kt:76）：空/"null" → nullIsTrue(false)；
 * 其余只要不是 false/no/not/0/0.0 就算 true（章节的 isVip/isPay/isVolume 判定）
 */
function legadoIsTrue(v: string | null | undefined, nullIsTrue = false): boolean {
  if (v == null || v.trim() === '' || v === 'null') return nullIsTrue;
  return !/^(?:false|no|not|0|0\.0)$/i.test(v.trim());
}

/** 封面 URL 有效性：规则未匹配时常产出「站点根 + #」这类垃圾值（如 https://x.com/#）——
 *  过滤为 undefined，让 UI 显示占位而不是加载无意义图片 */
function validCover(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const s = u.trim();
  if (!/^https?:\/\//i.test(s)) return undefined;
  if (/#$/.test(s) || /^https?:\/\/[^/]+\/#$/.test(s)) return undefined;
  return s;
}

function mapKind(t: number | undefined): UnifiedItem['kind'] {
  switch (t) {
    case 1:
      return 'audio';
    case 2:
      return 'image';
    case 3:
      return 'file';
    case 4:
      return 'video';
    default:
      return 'book';
  }
}

/**
 * `#592` **Legado `Book.type` 位标记**（`BookType.kt`）—— 与本仓的 `bookSourceType`（0~4）是
 * **两套编号**，别混用。源脚本大量用它做正文分流（典型写法 `book.type == 64`）。
 */
const BOOK_TYPE = { video: 4, text: 8, audio: 32, image: 64, webFile: 128 } as const;
/**
 * `#592` 源类型 ⇒ `Book.type`，照抄 `BookSource.getBookType()`
 * （`BookSourceExtensions.kt:131-139`）：
 * `file -> text or webFile`(136) · `image -> 64` · `audio -> 32` · `video -> 4` · 其余 `text`(8)。
 *
 * 为什么必须有：Legado 的 `content` 请求带的是**完整 Book**，`type` 早在「加入书架/搜索」
 * 时就按源类型写好并落库；本仓的 `content` 是独立 action，此前**从未设过 `env.bookData`**
 * ⇒ 源脚本里的 `book.type` 恒为 `undefined` ⇒ 分流判断全部落进 else 支。
 * 实测 📷🔞HentaiCosplay：正文规则 `if(book.type==64||book.type==1088){ 抽 <amp-img> }
 * else { java.startBrowser(path, book.name); path }` ⇒ 恒走 else ⇒ 只返回一个（还是
 * `indexOf("source")` 为 -1 时切出来的）垃圾 URL ⇒ 用户看到「本话图片加载为空」。
 */
function bookTypeOf(rule: { bookSourceType?: unknown }): number {
  switch (Number(rule.bookSourceType ?? 0)) {
    case 1:
      return BOOK_TYPE.audio;
    case 2:
      return BOOK_TYPE.image;
    case 3:
      return BOOK_TYPE.text | BOOK_TYPE.webFile;
    case 4:
      return BOOK_TYPE.video;
    default:
      return BOOK_TYPE.text;
  }
}

/** 从文本里找媒体直链（视频源的播放地址可能出现在正文文本/JS 片段里） */
const MEDIA_URL_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd|flv|mkv)(?:\?[^\s"'<>]*)?/i;
function findMediaUrl(text: string): string {
  return MEDIA_URL_RE.exec(text)?.[0] ?? '';
}

// `#346`：`inferPlayFormat` / `collectMediaCandidates` / `unescapeJsUrl` / `MEDIA_KEY_RE`
// 已下沉 `@yuedu/core` 的 `content/media-extract.ts`（订阅源同形态也要用，避免两份判据漂移）。

function splitTags(s: string): string[] {  // 净化：源里 kind 规则可能误匹配到长文本（如简介）——丢弃过长/含句读的脏段，最多 8 个
  return s
    .split(/[,，;；|\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= 12 && !/[。！？!?.…]/.test(x))
    .slice(0, 8);
}

/**
 * 组装一条列表卡片（`SearchBook` → `UnifiedItem`）。
 *
 * 为什么抽出来：`#617` 让「详情页直出」与普通列表**共用同一套字段语义** —— 尤其是
 * `payload.name`。`#588` 的教训是 payload 少一个 `name` 就会让详情页把 bookUrl 当书名显示
 * （详情阶段 `ruleBookInfo.name` 为空时**不覆盖**已有书名，见 `BookInfo.kt:68-73`），
 * 两处各写一份必然漂移。
 */
function makeListItem(o: {
  id: string;
  bookSourceType: unknown;
  title: string;
  cover?: string;
  author?: string;
  lastChapter?: string;
  /** 已归一化（`formatIntro` / `normalizeIntro`）的简介 */
  intro?: string;
  /** 原始 kind 串（`splitTags` 前） */
  kindStr?: string;
  bookUrl: string;
  raw: unknown;
}): UnifiedItem {
  return {
    id: o.id,
    kind: mapKind(o.bookSourceType as number | undefined),
    title: o.title,
    cover: validCover(o.cover),
    // 契约：`subtitle` = 「作者 / 备注 / 更新至」⇒ 没作者时回落「更新至」
    subtitle: o.author || o.lastChapter || undefined,
    summary: o.intro || undefined,
    tags: o.kindStr ? splitTags(o.kindStr) : undefined,
    layout: 'grid-card',
    payload: {
      bookUrl: o.bookUrl,
      name: o.title,
      ...(o.author ? { author: o.author } : {}),
      ...(o.lastChapter ? { lastChapter: o.lastChapter } : {}),
    },
    raw: o.raw,
  };
}

/**
 * `#617` **`bookUrlPattern` 命中判定** —— 对齐上游 `BookList.kt:63`
 * `if (baseUrl.matches(it.toRegex()))`。
 *
 * ⚠️ **Kotlin 的 `String.matches` 是「整串匹配」**，不是「包含」⇒ JS 侧必须用
 * `^(?:…)$` 包一层。不包的话 `https://xx.com/book/\d+` 会把
 * `https://xx.com/book/123/extra` 也判命中（上游不会）。
 *
 * 返回值区分四种状态，是为了「兜底必须留痕」（铁律 4）：正则写坏在语料里确实存在
 * （`📚书山聚合` / `💸📚光遇聚合` 这类聚合源的 pattern 含未转义的 `\d`/分组），
 * 上游会让 `PatternSyntaxException` 冒泡把整条搜索打挂；我们**不**跟着崩 —— 退化成普通
 * 搜索并在调用点 `warnOnce` 留痕（行为更保守，且不影响其它源）。
 */
function readPayload(id: unknown): Record<string, string> {
  if (id == null) return {};
  if (typeof id === 'string') {
    try {
      const o = JSON.parse(id);
      if (o && typeof o === 'object') return o as Record<string, string>;
    } catch {
      /* not json */
    }
    return { bookUrl: id };
  }
  return id as Record<string, string>;
}

/**
 * 解析 exploreUrl → 分类列表（对齐 Legado BookSourceExtensions.exploreKinds:43-99 + ExploreKind）：
 *  1. @js:/<js> 前缀 → 求值（bindings: infoMap），结果**可能是真数组**（脚本 return arr）
 *     或字符串（脚本 return JSON.stringify(arr) / 规则字面量）
 *  2. 数组/JSON 数组串 → [{title,url,style,type,...}]（GSON 语义：单引号、无引号键也吃）
 *  3. 否则按 && 或换行切分，每行「名称::URL」
 *  4. 保留 Legado 的版式信息：`style.layout_flexGrow` / `layout_flexBasisPercent`；
 *     `type:"text"` 或 url 为空 = 分组标题（ExploreAdapter 渲染为不可点标签，按 style 占位）
 */
interface ExploreKind {
  title: string;
  url?: string;
  /** Legado ExploreKind.type：url（默认，可点分类）/ text / button / toggle / select */
  type?: string;
  /** FlexChildStyle 的子集（Android flexbox 布局 → Web 用 percent 换算列宽） */
  layout?: { flexGrow?: number; flexBasisPercent?: number };
  /** toggle/select 的候选值（Legado ExploreKind.chars） */
  chars?: string[];
  /** 初始值（Legado ExploreKind.default） */
  default?: string;
  /** button 的点击动作 JS（Legado ExploreKind.action） */
  action?: string;
}

/**
 * `#640` **JSON 字符串里的裸控制字符转义**（`exploreUrl` 数组字面量的实测坑）。
 *
 * ## 现场（用户实测「八叉书库 未加载分类」）
 * `exploreUrl` 是一段 JSON 数组字面量，其中某个分类的 url 模板带了**真实换行**：
 * ```json
 * {"title":"完本小说","url":"/completed/{{\n\tvar pjstr = 'index.html';\n\tpjstr}}"}
 * ```
 * 裸 `\n` / `\t` 出现在 JSON 字符串里**不合法** ⇒ `JSON.parse` 抛
 * `Bad control character in string literal`；退化到 `jsEval('(' + text + ')')` 也语法错；
 * 再退化到「按行切分」⇒ 每一行都没有 `::` ⇒ 每个 kind 都是**无 url 的标题**。
 * 于是「无任何可点分类」⇒ 引擎按旧行为把**整段 JSON 文本当 URL** 去请求
 * （`GET https://bcshuku.com/[{"title":"分类",…}]` → 404）⇒ 前端显示「未加载分类」。
 *
 * ## 为什么这是「对齐上游」而不是替源圆谎
 * 上游 `BookSourceExtensions.exploreKinds` 走 `GSON.fromJsonArray`，GSON 的 lenient
 * `JsonReader` **接受字符串里的裸控制字符**（它只在 `strictness=STRICT` 时才拒）。
 * 同一份源在 Legado 里能出分类、在我们这里不能 ⇒ 是我们的解析比上游严，应当放宽。
 *
 * 只处理**字符串字面量内部**的 `\n` `\r` `\t` 与其它 `<0x20` 字符：
 * 字符串外的换行是合法空白，动了会改变语义（例如本来靠换行切分的文本）。
 */
function escapeRawControlCharsInJson(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const code = text.charCodeAt(i);
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (esc) {
      esc = false;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    if (code < 0x20) {
      out +=
        ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 分类项归一：字符串 / {title,url,...} 均可 */function normalizeKind(raw: unknown): ExploreKind | undefined {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    const idx = s.indexOf('::');
    return idx > 0 ? { title: s.slice(0, idx).trim(), url: s.slice(idx + 2).trim() || undefined } : { title: s };
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const title = o['title'] == null ? '' : String(o['title']);
  const urlRaw = o['url'];
  const style = (o['style'] ?? undefined) as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const flexGrow = style ? num(style['layout_flexGrow']) : undefined;
  const flexBasisPercent = style ? num(style['layout_flexBasisPercent']) : undefined;
  const type = o['type'] == null ? undefined : String(o['type']);
  const charsRaw = o['chars'];
  const chars = Array.isArray(charsRaw)
    ? charsRaw.filter((c) => c != null).map((c) => String(c))
    : undefined;
  const def = o['default'];
  const action = o['action'];
  if (!title && !urlRaw) return undefined;
  return {
    title,
    url: urlRaw == null || urlRaw === '' ? undefined : String(urlRaw),
    ...(type && type !== 'url' ? { type } : {}),
    ...(flexGrow !== undefined || flexBasisPercent !== undefined
      ? { layout: { ...(flexGrow !== undefined ? { flexGrow } : {}), ...(flexBasisPercent !== undefined ? { flexBasisPercent } : {}) } }
      : {}),
    ...(chars && chars.length ? { chars } : {}),
    ...(def != null && def !== '' ? { default: String(def) } : {}),
    ...(typeof action === 'string' && action.trim() ? { action: action.trim() } : {}),
  };
}

async function parseExploreKinds(
  tpl: string,
  env: AnalyzeEnv,
  infoMap: Map<string, string>,
  /** source 绑定（脚本常写 `source.getVariable()` 读分组/历史——七猫「选择分组」就靠它） */
  srcStub?: Record<string, unknown>,
  /** `#607`：源 id —— 只在「jsLib 没加载成功」时给错误补 hint 用 */
  sourceId?: string,
): Promise<ExploreKind[]> {
  if (!tpl) return [];
  let value: unknown = tpl;
  const jsM = /^@js:([\w\W]*)$/i.exec(tpl) ?? /^<js>([\w\W]*?)(?:<\/js>)?$/i.exec(tpl);
  if (jsM) {
    try {
      // 脚本可能直接 return 数组（不 stringify）——保留结构化值，别中途 String() 掉。
      //
      // ⚠️ **必须走混合求值器（env.jsEval），不能走 jsEvalSync**（Phase 0.1）：
      // exploreUrl 是「会发 java.ajax」的重灾区，而 L1 的 java.ajax 用 execFileSync
      // **同步阻塞 Node 事件循环** → 并发一高请求就排队等 curl（实测并发 2→10 时正文通过率 27%→4%）。
      // 走 env.jsEval 时这类脚本会被路由进 worker 池：worker 内的同步 RPC 只阻塞 worker 线程，
      // 宿主异步执行后回填，脚本的同步语义不变而主线程解放。
      //
      // infoMap / source 都是 Proxy，不可结构化克隆 → 用**描述符**传纯快照过去，
      // worker 侧重建为「方法齐全、读写经 RPC 回流宿主」的等价对象：
      //   · infoMap 方括号赋值 / put()  → infoMapSet RPC → 宿主那份持久 Map（切分组后分类才变）
      //   · source.setVariable()/getVariable() → sourceCall RPC → 宿主 ctx.variables
      const code = jsM[1] as string;
      const bindings: Record<string, unknown> = {
        $: '',
        infoMap: makeInfoMapBinding(infoMap),
        [INFOMAP_RAW_KEY]: infoMap,
        [INFOMAP_ENTRIES_KEY]: Object.fromEntries(infoMap),
        key: '',
        page: 1,
        /**
         * `#579` Legado `BookSourceExtensions.exploreKinds` 的 bindings 里**一定有 `baseUrl`**。
         * 缺它时源脚本 `java.connect(baseUrl, header)` 拿到 `undefined` ⇒ core `assertHttpUrl`
         * 抛 `Malformed URL:` ⇒ 用户看到分类只有一条 `ERROR:Malformed URL:`（📚聚合书库）。
         */
        baseUrl: env.baseUrl ?? '',
      };
      if (srcStub) {
        bindings['source'] = srcStub;
        const fields = cloneableFieldsOf(srcStub);
        if (fields) bindings[SOURCE_FIELDS_KEY] = fields;
      }
      value = await env.jsEval(code, bindings);
    } catch (e) {
      // 对齐 Legado BookSourceExtensions.exploreKinds 的 onFailure：
      // 脚本报错时**不静默返回空**，而是产出一条 `ERROR:...` 分类（ExploreKind.type 缺省 = url，
      // 但 url 为空 → 前端渲染为不可点标签）。静默吞错会让用户看到「分类列表空的」却无从排查
      // ——番茄系聚合源 `[a,b]=>` 语法不兼容就是这么暴露出来的。
      /**
       * `#607`：这里也要补 jsLib 失败 hint。发现页脚本大量依赖 jsLib（qyyuapi 系第一条就是
       * `Reload(...)`），jsLib 没下下来时错误是 `Reload is not defined` —— 用户看到的是
       * 「发现页只有一条 ERROR 分类」，完全看不出真因。hint 只能在这里加，因为这条路径
       * **不经过** EngineError 的 RULE_PARSE 包装（它把错误变成一条分类条目）。
       */
      const msg = withJsLibHintById(sourceId, e instanceof Error ? e.message : String(e));
      const urlHint = exploreFailHint(msg);
      console.warn(`[legado] exploreUrl 脚本执行失败（source=${srcStub?.['bookSourceName'] ?? '?'}）：${msg}${urlHint}`);
      return [{ title: `ERROR:${msg}`, type: 'text' }];
    }
  }
  if (value && typeof (value as Promise<unknown>).then === 'function') {
    try {
      value = await (value as Promise<unknown>);
    } catch {
      return [];
    }
  }
  // ① 真数组（脚本 return [...] 或 <js> 求值结果）
  if (Array.isArray(value)) {
    return value.map(normalizeKind).filter((k): k is ExploreKind => !!k);
  }
  const ruleStr = value == null ? '' : String(value).trim();
  if (!ruleStr) return [];
  // ② JSON / JS 对象字面量数组串（GSON 宽松：单引号、无引号键、尾逗号、**字符串内裸控制字符**）
  //
  // `#640`：这里必须与上游 `BookSourceExtensions.exploreKinds` 同判据 ——
  //   上游是「`ruleStr.isJsonArray()` 为真 ⇒ 只走 GSON，失败就产 `ERROR:…` 分类」，
  //   **不会**降级成文本切分。我们此前降级成切分 ⇒ 每个 kind 都无 url ⇒
  //   引擎再把**整段 JSON 文本当 URL** 请求（八叉书库实测：`GET /[{"title":…}]` → 404
  //   → 前端只显示「未加载分类」，真因完全不可见）。
  if (ruleStr.startsWith('[')) {
    const parsed = (() => {
      try {
        const arr = JSON.parse(ruleStr) as unknown;
        if (Array.isArray(arr)) return arr;
      } catch {
        /* 落到宽松层 */
      }
      try {
        const arr = JSON.parse(escapeRawControlCharsInJson(ruleStr)) as unknown;
        if (Array.isArray(arr)) return arr;
      } catch {
        /* 落到 JS 字面量层（单引号 / 无引号键） */
      }
      return null;
    })();
    if (parsed) return parsed.map(normalizeKind).filter((k): k is ExploreKind => !!k);
    try {
      const arr = await env.jsEval(`(${ruleStr})`, {});
      if (Array.isArray(arr)) return arr.map(normalizeKind).filter((k): k is ExploreKind => !!k);
    } catch {
      /* 都失败 ⇒ 按上游 onFailure 产 ERROR 分类，别静默 */
    }
    const msg = 'exploreUrl 是 JSON 数组但解析失败（已试严格 / 宽松 / JS 字面量三层）';
    console.warn(`[legado] ${msg}（source=${srcStub?.['bookSourceName'] ?? '?'}）`);
    return [{ title: `ERROR:${msg}`, type: 'text' }];
  }
  // ③ 文本切分：「名称::URL」按 && / 换行
  return ruleStr
    .split(/&&|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('::');
      if (idx <= 0) return { title: line } as ExploreKind;
      return { title: line.slice(0, idx).trim(), url: line.slice(idx + 2).trim() || undefined } as ExploreKind;
    })
    .filter((k) => k.title && (k.url || /[/{]/.test(k.title))); // 无 :: 但形如 URL 模板的行保留（旧测试语义）
}

// ---------------------------------------------------------------------------
// 发现页交互输入态（Legado infoMap）：按源持久化，作为 exploreUrl 脚本的 infoMap 绑定
// ---------------------------------------------------------------------------

/**
 * 源变量（Legado `BaseSource.variable`）：`source.getVariable()/setVariable()` 读写，
 * **按源持久化**。很多源（如七猫）把「发现页分组/搜索历史」存这里——不持久化就会
 * 出现「切换分组后分类列表不变」。
 */
function sourceVarKey(sourceId: string): string {
  return `source-var:${sourceId}`;
}

/**
 * `source.get/put` 的落盘键 —— Legado `BaseSource.put/get` 用的**独立命名空间**
 * （`CacheManager` 键 `v_<源key>_<键>`，见 `BaseSource.kt:345-356`）。
 *
 * ⚠️ 与 `source-var:`（= `getVariable/setVariable` 的那个 JSON 串）**不是一回事**，
 * 两者必须分开存：语料里同一个源可以同时用 `source.setVariable(...)` 与 `source.put('k', …)`
 * （🏷七猫四合一本地版就是：`source.put('qm_device'/'qm_token')` 缓存设备与登录态）。
 */
function sourceKvKey(sourceId: string): string {
  return `source-kv:${sourceId}`;
}

/**
 * `cache` 持久层的落盘键 —— **Legado `CacheManager` 是全局的**（`appDb.cacheDao`，不按源隔离：
 * 任何源 `cache.put(k, v)`，别的源 `cache.get(k)` 都能读到）。值是一个全局缓存 bag：
 * JSON `{键: {v, dl}}`（格式与读写实现都在 core 的 `makeCacheOps`，**只有那一份**）。
 *
 * 为什么必须全局：qyyuapi 系的激活链路正是跨源共享 ——「XH发布页」登录写入
 * `XHaccount` / `XHtime` / `xhJson`，同系所有源在 `user_Check` 里读同一份缓存。
 * 按源隔离时这条路直接断掉（各源永远读不到激活码 ⇒ 只出兜底 1 条）。
 *
 * 注：`source-var:` / `source-kv:` 仍按源隔离（上游 `sourceVariable_<key>` / `v_<key>_<k>`
 * 也是按源的），只有 `cache` 是全局。
 */
const GLOBAL_CACHE_KEY = 'cache:global';
/**
 * 详情阶段的**字段级**调试留痕（`YUEDU_DEBUG_DETAIL=1` 时开启）。
 *
 * 为什么需要它：引擎自带的 `ctx.trace` 是 **stage 级**（`detail` 一条记录），
 * 而「详情静默空」类缺陷（`#103`/`#110`/`#111`/`#112`）恰恰卡在**字段之间**：
 * `init` 的返回值有没有成为后续字段的文档？某个字段的规则到底求值出什么？
 * 没有这层留痕只能靠改源码打 console，成本极高（实测 #110 就卡在这）。
 *
 * 输出形如：`[detail] <源尾24> init: rule=… raw=object/1023 ⇒ out={"last_chapter":…`
 * —— `raw` 的 **typeof/长度** 是关键：它能一眼看出「`init` 返回的是 StrResponse 对象而不是字符串」。
 */
function makeDetailDebug(sourceId: string): (label: string, rule: string, raw: unknown, out: unknown) => void {
  const tag = sourceId.slice(-24);
  return (label, rule, raw, out) => {
    const rawDesc = raw === undefined ? '-' : `${typeof raw}/${String(raw).length}`;
    const outStr = String(out ?? '').replace(/\s+/g, ' ');
    // eslint-disable-next-line no-console
    console.log(
      `[detail] ${tag} ${label}: rule=${rule.replace(/\s+/g, ' ').slice(0, 64)} ` +
        `raw=${rawDesc} ⇒ out=${outStr.slice(0, 70)}${outStr.length > 70 ? '…' : ''}`,
    );
  };
}

/**
 * **源级持久数据的全部 storage 键**（删源清理用 —— 见交接文档 §4.8d 缺口 A）。
 *
 * 为什么必须由本模块导出、而不是让调用方自己拼字符串：这些前缀属于**引擎的存储布局**。
 * 调用方（`hub` / 服务端）硬编码就会漂移，而漂移的表现是「清理看起来执行了，但数据还在」
 * —— 静默残留是最难发现的一类问题。这里与上面的 `*Key()` 函数**同一来源**。
 *
 * ⚠️ **不含 `cache`**：`CacheManager` 是**全局**的（见 `GLOBAL_CACHE_KEY`），删一个源
 * 不该把别的源还在用的缓存一起清掉；清缓存走 App 的「清除缓存」那条独立路径。
 * ⚠️ 不含登录信息/登录头（`LOGIN_INFO_PREFIX` / `LOGIN_HEADER_PREFIX`，定义在 core、由 hub 自己清）。
 * 调用方（服务端）把本函数的返回值作为**额外键**传给 `hub.purgeSourceData()`。
 */
export function sourceStorageKeys(sourceId: string): string[] {
  return [sourceVarKey(sourceId), sourceKvKey(sourceId)];
}

/**
 * `@put:{k:v}` 的变量落点（Legado `AnalyzeRule.putRule` → `put()`）。
 *
 * Legado 的 `put` 会写进 chapter/book/ruleData 的**内存变量表**（随 Book 对象存活），
 * 因此 `ruleBookInfo` 里 put 的键，`ruleToc` / `ruleContent` 阶段（甚至后续另一次请求）
 * 都能用 `@get:{k}` 读到。我们是无状态服务，等价落点只有**按源持久化的源变量**，
 * 所以这里同时做两件事：
 *   ① 写进本次请求的 `variables`（本请求内立即生效，`@get:{k}` / `{{}}` 都能用）
 *   ② 并入源变量 JSON（跨阶段、跨请求可读；与 `source.setVariable` 同一份存储）
 * 语料里 4 个源正是跨请求用法（如 17k小说 ruleSearch put → ruleBookInfo get）。
 */
function putSharedVariable(ctx: EngineContext, key: string, value: string): void {
  /**
   * `YUEDU_DEBUG_DETAIL=1`：`@put:{k:v}` / `java.put(k,v)` 的写入留痕。
   *
   * 为什么必须有：跨阶段的「变量为空」类症状（如七猫官方正文 `java.get('bid')` 为空）
   * 无法区分两种情况 —— ① **没写**（`@put` 所在的字段/阶段没跑到）；② **写了但读不到**（落点不一致）。
   * 只有把写入点打出来才能定案。
   */
  if (process.env['YUEDU_DEBUG_DETAIL']) {
    // eslint-disable-next-line no-console
    console.log(`[put] reqId=${String(ctx.reqId ?? '-')} ${key} = ${String(value).slice(0, 60)}`);
  }
  ctx.variables.set(key, value);
  try {
    const raw = ctx.variables.get('sourceVariable');
    /**
     * ⚠️ `raw === ''` 要当成**空袋**（不能直接 `JSON.parse('')` —— 那会抛错 ⇒ 袋建不出来
     * ⇒ **跨请求的 `@get:{k}` / `java.get(k)` 全断**，也就是 `#111` 咪咕阅读那条老路）。
     * 之所以现在才有这个分支：过去 `primeSourceVariable` 在「没持久化过」时会预置 `'{}'`，
     * 掩盖了空串这一支；`#148` 把那个预置去掉之后，这里必须自己认空串。
     */
    const obj: Record<string, unknown> =
      typeof raw === 'string' && raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    obj[key] = value;
    ctx.variables.set('sourceVariable', JSON.stringify(obj));
  } catch {
    /* 源变量不是合法 JSON（源脚本自己写的）→ 只保留 ①，不破坏原值 */
  }
}

/**
 * 把持久化的源变量预置进本次请求的 variables（供同步的 `source.getVariable` 读取）。
 *
 * ★★ **`#148`：没持久化过时「不预置」，而不是预置 `'{}'`。**
 *
 * 上游 `BaseSource.getVariable()`（`BaseSource.kt:336-338`）在没存过时返回**空串**：
 * `CacheManager.get("sourceVariable_${getKey()}") ?: ""`。这个差别**不是风格问题** ——
 * 语料里大量源的第一句就是
 * ```js
 * try { $$$ = JSON.parse(source.getVariable()); if ($$$ == null) throw new Error(); …补几个键… }
 * catch (e) { $$$ = original; put($$$); }     // ← 首次运行靠这里拿到「带 url/name 的完整默认对象」
 * ```
 * 预置 `'{}'` 会让 `JSON.parse` **成功**、`catch` **永不触发**，而源自己的补键列表里**没有 `url`**，
 * 于是 `$$$.url === undefined`，拼出 `undefined/albums?…` 这种 URL ⇒ 发现页 `items=0`、**不报任何错**。
 * 实测见 `__tests__/source-getvariable.test.ts` 与 `#148` 的复现记录。
 *
 * ⚠️ 空串在这里是**有意义的值**（`persistSourceVariable` 只在非空时落盘，见那边的判据）。
 */
async function primeSourceVariable(ctx: EngineContext): Promise<void> {
  try {
    const v = await ctx.storage.get(sourceVarKey(ctx.sourceId));
    if (process.env['YUEDU_DEBUG_DETAIL']) {
      // eslint-disable-next-line no-console
      console.log(`[prime] reqId=${String(ctx.reqId ?? '-')} src=${ctx.sourceId.slice(-22)} sv=${String(v ?? '').slice(0, 80)}`);
    }
    // 只在**真的存过**时预置；没存过就保持「未设置」⇒ `source.getVariable()` 拿到空串（对齐上游）
    if (typeof v === 'string' && v !== '') ctx.variables.set('sourceVariable', v);
  } catch {
    /* 读不到 ⇒ 同样保持未设置（上游 CacheManager.get 失败也是得到 null → `?: ""`） */
  }
}

/** 把本次请求里 source.setVariable 的写入落盘 */
async function persistSourceVariable(ctx: EngineContext): Promise<void> {
  try {
    const v = ctx.variables.get('sourceVariable');
    if (process.env['YUEDU_DEBUG_DETAIL']) {
      // eslint-disable-next-line no-console
      console.log(`[persist] reqId=${String(ctx.reqId ?? '-')} src=${ctx.sourceId.slice(-22)} sv=${String(v ?? '').slice(0, 80)}`);
    }
    if (typeof v === 'string' && v) await ctx.storage.set(sourceVarKey(ctx.sourceId), v);
  } catch {
    /* 存储失败不影响本次结果 */
  }
}

/**
 * 请求前把「按源状态」全部预置进 `ctx.variables`（源脚本同步读取用）：
 *  · `sourceVariable` → `source.getVariable()`
 *  · `__loginInfo`    → `source.getLoginInfo()` / `getLoginInfoMap()`
 *  · `__loginHeader`  → `source.getLoginHeader()`，并由 fetchRuleUrl 注入到请求头
 * 三者都必需：很多源在**普通请求的规则脚本**里读登录信息/登录头（如签名），
 * 不只是登录那一刻（Legado：`getHeaderMap(hasLoginHeader = true)` 每个请求都合）。
 */
async function primeSourceState(ctx: EngineContext): Promise<void> {
  await primeSourceVariable(ctx);
  // cache 持久层（**全局**，见 GLOBAL_CACHE_KEY）：注入 `__srcCache` 供脚本**同步**读写
  // （cache.get/put 是同步 API，不能 await）
  try {
    const c = await ctx.storage.get(GLOBAL_CACHE_KEY);
    ctx.variables.set('__srcCache', c && c !== '{}' ? c : '{}');
  } catch {
    ctx.variables.set('__srcCache', '{}');
  }
  // `source.get/put` 的持久层（Legado `CacheManager` 的 `v_<源key>_<键>`）——与 `source-var:` 分开
  try {
    const kv = await ctx.storage.get(sourceKvKey(ctx.sourceId));
    ctx.variables.set(SOURCE_KV_SLOT, kv && kv !== '{}' ? kv : '{}');
  } catch {
    ctx.variables.set(SOURCE_KV_SLOT, '{}');
  }
  try {
    const stored = await ctx.storage.get(LOGIN_INFO_PREFIX + ctx.sourceId);
    const fromStore = stored ? (JSON.parse(stored) as Record<string, unknown>) : {};
    // 宿主注入的 ctx.loginInfo 作为覆盖层（hub 与 storage 一致；测试/旧路径只给 ctx）
    const fromCtx = ctx.loginInfo ? Object.fromEntries(ctx.loginInfo) : {};
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...fromStore, ...fromCtx })) if (v != null) merged[k] = String(v);
    ctx.variables.set('__loginInfo', JSON.stringify(merged));
  } catch {
    ctx.variables.set('__loginInfo', '{}');
  }
  try {
    const header = await ctx.storage.get(LOGIN_HEADER_PREFIX + ctx.sourceId);
    ctx.variables.set('__loginHeader', header ?? '');
  } catch {
    ctx.variables.set('__loginHeader', '');
  }
}

/** 请求后落盘：源变量 + 登录信息（source.putLoginInfo）+ 登录头（source.putLoginHeader）+ 源级 cache */
async function persistSourceState(ctx: EngineContext): Promise<void> {
  await persistSourceVariable(ctx);
  /**
   * cache 持久层落盘（**全局**，见 GLOBAL_CACHE_KEY）。
   *
   * ⚠️ **空 bag 也要写**（`'{}'`）：否则 `cache.delete(k)` 只清了内存那份，storage 里还留着旧值，
   * 下次请求 prime 又"复活"—— 🔞Linpx 的 `cache.delete` 语义就废了。
   * `__srcCache` 为 undefined 表示本次请求没经过 prime（如直接调引擎工具函数）→ 不写，避免造垃圾键。
   */
  try {
    const c = ctx.variables.get('__srcCache');
    if (typeof c === 'string' && c) await ctx.storage.set(GLOBAL_CACHE_KEY, c);
  } catch {
    /* 存储失败不影响本次结果 */
  }
  // `source.put` 的落盘（与 `source.setVariable` 的 `source-var:` 分开，见 sourceKvKey 注释）。
  // 与 `__srcCache` 同一纪律：空表也要写（否则脚本里 `source.put(k,'')` 清了值，storage 里
  // 旧值下次 prime 又"复活"）；`__sourceKV` 为 undefined 表示本次没 prime → 不写，避免造垃圾键。
  try {
    const kv = ctx.variables.get(SOURCE_KV_SLOT);
    if (typeof kv === 'string' && kv) {
      await ctx.storage.set(sourceKvKey(ctx.sourceId), kv);
      if (process.env['YUEDU_DEBUG_DETAIL']) {
        // eslint-disable-next-line no-console
        console.log(`[source-kv] 落盘 src=${ctx.sourceId.slice(-22)} ${kv.slice(0, 160)}`);
      }
    }
  } catch {
    /* 存储失败不影响本次结果 */
  }
  // `#314`：登录信息 / 登录头落盘收敛到 core 的唯一实现（rss 引擎用同一份，见 source-login.ts）
  await persistSourceLogin(ctx);
}

/**
 * 登录信息（Legado `BaseSource.getLoginInfo`/`putLoginInfo`/`removeLoginInfo`）。
 * 值是 JSON 对象字符串（`loginUi` 表单的 name→值）。Legado 用 AES 加密存本地，
 * 我们落在宿主注入的 storage 里（进程内 + 文件版落盘）。
 */
async function loadLoginInfo(ctx: EngineContext): Promise<Record<string, string>> {
  try {
    const raw = await ctx.storage.get(LOGIN_INFO_PREFIX + ctx.sourceId);
    if (!raw) return {};
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (v != null) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

/** 登录头（Legado `BaseSource.getLoginHeader`）：`putLoginHeader` 写入的请求头 JSON */
async function loadLoginHeader(ctx: EngineContext): Promise<Record<string, string>> {
  try {
    const raw = await ctx.storage.get(LOGIN_HEADER_PREFIX + ctx.sourceId);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (v != null) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

/** 交互输入态的存储键（同源共享；storage 由宿主注入，跨进程持久） */
function exploreInputKey(sourceId: string): string {
  return `explore-input:${sourceId}`;
}

/** 读取源的交互输入态（损坏/缺失 → 空 Map） */
async function loadExploreInput(ctx: EngineContext): Promise<Map<string, string>> {
  try {
    const raw = await ctx.storage.get(exploreInputKey(ctx.sourceId));
    if (!raw) return new Map();
    const o = JSON.parse(raw) as Record<string, unknown>;
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(o ?? {})) if (v != null) m.set(k, String(v));
    return m;
  } catch {
    return new Map();
  }
}

async function saveExploreInput(ctx: EngineContext, map: Map<string, string>): Promise<void> {
  try {
    await ctx.storage.set(exploreInputKey(ctx.sourceId), JSON.stringify(Object.fromEntries(map)));
  } catch {
    /* 存储失败不影响本次求值 */
  }
}

/**
 * 交互控件的初值播种（对齐 Legado ExploreAdapter：type=select/toggle 渲染时
 * `infoMap[title] = kind.default ?: chars[0]`）——源脚本常写 `infoMap["频道"] || "默认"`，
 * 播种后下一次求值即可读到用户/默认选择。
 */
function seedInputDefaults(kinds: ExploreKind[], infoMap: Map<string, string>): boolean {
  let changed = false;
  for (const k of kinds) {
    if (k.type !== 'select' && k.type !== 'toggle') continue;
    if (infoMap.get(k.title)) continue;
    const v = k.default ?? k.chars?.[0];
    if (v != null && v !== '') {
      infoMap.set(k.title, v);
      changed = true;
    }
  }
  return changed;
}

/** 解析请求里的输入态（filters[EXPLORE_INPUT_KEY] = JSON 串），合并进持久 Map */
function mergeInputFromRequest(filters: Record<string, string> | undefined, infoMap: Map<string, string>): boolean {
  const raw = filters?.[EXPLORE_INPUT_KEY];
  if (!raw) return false;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v == null) continue;
      const s = String(v);
      if (infoMap.get(k) !== s) {
        infoMap.set(k, s);
        changed = true;
      }
    }
    return changed;
  } catch {
    return false;
  }
}

export class LegadoEngine implements RuleEngine<CompiledBookSource, unknown> {
  readonly kind = 'legado';
  readonly version = '0.1.0';
  readonly capabilities: EngineAction[] = ['home', 'category', 'search', 'detail', 'content', 'play', 'login'];
  /** preUpdateJs 去重（同一个请求上下文只执行一次；对齐 Legado 每次更新目录执行一次） */
  private readonly preUpdateRan = new WeakSet<object>();

  detect(raw: unknown): boolean {
    return detectBookSource(raw);
  }

  compile(raw: unknown): CompileResult<CompiledBookSource> {
    const r = compileBookSource(raw);
    return { ok: r.ok, rule: r.rule, issues: r.issues as ValidationIssue[] };
  }

  validate(rule: CompiledBookSource): ValidationIssue[] {
    return compileBookSource(rule).issues as ValidationIssue[];
  }

  // ---- 列表类（搜索 / 发现） ----
  async search(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    return this.runList(rule, 'search', req, ctx);
  }

  async home(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    return this.runList(rule, 'home', req, ctx);
  }

  /** 分类：req.filters['explore'] = home 返回的选中分类 URL（exploreKinds 语义） */
  async category(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    return this.runList(rule, 'home', req, ctx, req.filters?.['explore']);
  }

  private async runList(
    rule: CompiledBookSource,
    mode: 'search' | 'home',
    req: UnifiedRequest,
    ctx: EngineContext,
    exploreTplOverride?: string,
  ): Promise<UnifiedListResult> {
    // 源开关：被禁用 / 禁用发现 → 返回空（facade 也会在主拦截层跳过）
    // rule.state（hub 合并态，已含源自带 enabledExplore）优先；rule.enabledExplore 作引擎层防线
    // （对齐 BookSourceDao.kt:87 `enabledExplore = 1` —— Legado 只有 enabled / enabledExplore 开关）
    const st = resolveSourceState(
      rule.state ??
        (typeof rule.enabledExplore === 'boolean' ? { exploreEnabled: rule.enabledExplore } : undefined),
    );
    if (!st.enabled) return emptyList(req.page ?? 1);
    if (mode === 'search' && !st.searchEnabled) return emptyList(req.page ?? 1);
    if (mode === 'home' && (!st.exploreEnabled || rule.enabledExplore === false)) return emptyList(req.page ?? 1);
    const timer = ctx.trace.begin('parse', mode, req.keyword ?? req.filters);
    try {
      await primeSourceState(ctx); // 源变量 + 登录信息 + 登录头（源脚本同步读取用）
      await primeJsLibCached(ctx, rule.jsLib); // #607：jsLib 落盘（内存→磁盘→网络），避免每次都同步 curl 60s
      const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, rule);
      // 发现页交互输入态：请求携带（filters[$input]）→ 合并持久 → 供 exploreUrl 脚本作 infoMap 绑定
      const infoMap = await loadExploreInput(ctx);
      const inputChanged = mergeInputFromRequest(req.filters, infoMap);
      if (inputChanged) await saveExploreInput(ctx, infoMap);
      // 交互动作（Legado ExploreKind.action）：对齐 ExploreAdapter —— 改值后**先执行控件脚本**
      // （脚本会继续写 infoMap，如七猫「选择分组」的 IIFE），再重跑 exploreUrl 脚本
      const actionScript = req.filters?.[EXPLORE_ACTION_KEY];
      if (actionScript) {
        try {
          const srcStub = makeSourceStub(ctx, rule as unknown as Record<string, unknown>);
          const actBindings: Record<string, unknown> = {
            infoMap: makeInfoMapBinding(infoMap),
            [INFOMAP_RAW_KEY]: infoMap,
            [INFOMAP_ENTRIES_KEY]: Object.fromEntries(infoMap),
            source: srcStub,
            java: env.javaExtra,
            baseUrl: env.baseUrl,
          };
          const actFields = cloneableFieldsOf(srcStub);
          if (actFields) actBindings[SOURCE_FIELDS_KEY] = actFields;
          // 控件脚本常写 infoMap（方括号 / Map API）→ 走混合求值：
          // 含 java.ajax 时进 worker（不阻塞事件循环），写入经 RPC 回流宿主那份 Map（下方 save 照常生效）
          await env.jsEval(actionScript, actBindings);
          await saveExploreInput(ctx, infoMap);
          await persistSourceState(ctx); // 控件脚本常写源变量（source.setVariable）
        } catch {
          /* 控件脚本失败不阻断分类刷新（Legado：仅记日志） */
        }
      }
      let tpl: string;
      if (mode === 'search') {
        tpl = rule.searchUrl || rule.ruleSearch?.searchUrl || '';
      } else {
        // 发现（exploreKinds 语义，对齐 Legado BookSourceExtensions + ExploreAdapter）：
        //   exploreUrl 可为 @js:/<js> 构造、JSON/JS 对象字面量数组、或「名称::url」按 &&/换行切分
        //   · 只要有**可点分类**（url 非空）就返回 filters（1 个也渲染分类条——Legado
        //     ExploreAdapter.upKindList 总是渲染 kinds，点击才加载内容；我们此前把「单分类」
        //     自动加载掉了，分类条不显示）
        //   · 交互型 kind（select/toggle/text/button）连同 chars/default/action 一起透传，
        //     用户选择经 filters[$input] 回传并**按源持久化**，作为脚本的 infoMap 绑定
        const exploreRaw = rule.exploreUrl || rule.ruleExplore?.bookList || '';
        if (exploreTplOverride) {
          tpl = exploreTplOverride;
        } else {
          /**
           * `#672` **exploreUrl 脚本写 infoMap ⇒ 求值后落盘**（对齐上游 `InfoMap.save()` +
           * `ExploreAdapter.kt:685` 的 `saveNow()`）。
           *
           * 上游 `infoMap.save()` 只置 `needSave` 标志，真正的写缓存在「列表加载完」那一步做。
           * 我们此前彻底没有这一步 ⇒ 源脚本对 infoMap 的写入只在**本次求值内**有效：
           * 切分组、勾选项后重跑脚本时读到的还是旧值（用户会看到「选了没反应」）。
           * 用**快照对比**判断「这轮有没有改」，比要求每个绑定各自上报更简单，也覆盖 worker 路径
           * （worker 的写入经 `infoMapSet` RPC 已回流到这份 Map）。
           */
          const infoMapBefore = JSON.stringify(Object.fromEntries(infoMap));
          const kinds = await parseExploreKinds(exploreRaw, env, infoMap, makeSourceStub(ctx, rule as unknown as Record<string, unknown>), ctx.sourceId);
          if (JSON.stringify(Object.fromEntries(infoMap)) !== infoMapBefore) {
            await saveExploreInput(ctx, infoMap);
          }
          const clickable = kinds.filter((k) => k.url);
          // 脚本报错（ERROR:… 分类）时也要把 filters 返回给前端 —— 否则「分类空」无从排查。
          // 此时无任何可点分类，前端只会看到一个不可点标签。
          const hasErrorKind = kinds.some((k) => k.title.startsWith('ERROR:'));
          if (clickable.length > 0 || hasErrorKind) {
            // 交互控件初值播种（对齐 ExploreAdapter 渲染时的 infoMap[title] = default ?: chars[0]）
            if (seedInputDefaults(kinds, infoMap)) await saveExploreInput(ctx, infoMap);
            const result: UnifiedListResult = {
              items: [],
              page: emptyList(req.page ?? 1).page,
              filters: [
                {
                  name: '分类',
                  key: 'explore',
                  options: kinds.map((k) => ({
                    name: k.title,
                    value: k.url ?? '',
                    // 分组标题（url 为空且非交互型，如「地区」大标题）：不可点，UI 渲染为标签。
                    // 交互型（text/button/toggle/select）无 url 但**不是**标题，交给控件渲染。
                    ...(k.url || (k.type && k.type !== 'url') ? {} : { header: true }),
                    ...(k.type ? { kind: k.type } : {}),
                    ...(k.layout ? { layout: k.layout } : {}),
                    ...(k.chars ? { chars: k.chars } : {}),
                    ...(k.default ? { default: k.default } : {}),
                    ...(k.action ? { action: k.action } : {}),
                  })),
                },
              ],
            };
            timer.end(result);
            return result;
          }
          if (kinds.length === 0) {
            // exploreUrl 存在但无有效分类（纯模板/解析失败）——按模板直接列书（保持旧行为）
            if (!exploreRaw) {
              const result = emptyList(req.page ?? 1);
              timer.end(result);
              return result;
            }
          }
          tpl = clickable[0]?.url || exploreRaw;
        }
      }
      if (!tpl) {
        throw new EngineError('SOURCE_INVALID', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: mode === 'search' ? 'searchUrl' : 'exploreUrl',
          input: rule.bookSourceName,
          trace: ctx.trace.tail(20),
          retryable: false,
        });
      }
      const keyword = req.keyword ?? '';
      const page = req.page ?? 1;

      const { resp, scriptUrl } = await this.fetchRuleUrl(ctx, env, rule, tpl, { keyword, page });
      const { content } = parseResponse(resp);
      // Legado 给脚本的 baseUrl 是 `analyzeUrl.url`（**未编码**原始串，见 scriptUrl 注释）
      ctx.variables.set('baseUrl', scriptUrl ?? resp.url);
      env.baseUrl = scriptUrl ?? resp.url;

      /**
       * ## `#617` **精确搜索 / 详情页直出**（对齐 Legado `BookList.kt:62-78`）
       *
       * 上游语义（搜索分支，`isSearch == true`）：
       * ```kotlin
       * if (isSearch) bookSource.bookUrlPattern?.let {
       *     if (baseUrl.matches(it.toRegex())) {          // baseUrl = res.url（实际响应 URL）
       *         getInfoItem(...)                          // 复用**已抓到的 body** 走 ruleBookInfo
       *         return bookList
       *     }
       * }
       * ```
       * 也就是说：`bookUrlPattern` 命中时，这次「搜索」拿回来的**本身就是详情页** ⇒
       * 不走 `ruleSearch.bookList` 列表规则，直接用 `ruleBookInfo` 解出**单本**。
       *
       * 语料覆盖（`data/sources/book-482`，2026-10-25 统计）：**106/485** 源带该字段
       * （文本 91 / 图片 15）。典型形态：
       *  · 搜索接口直接回一本书的详情 JSON —— 🏷晋江 `app-cdn.jjwxc.net/androidapi/novelbasicinfo`、
       *    📂小米阅读 `reader.browser.miui.com/api/v2/book/\d+`、🔊听友M `tingyou.fm/albums/\d+`；
       *  · 搜索 URL 就是书页（重定向后落在书页）—— 🏷飞卢 `b.faloo.com/f/\d+.html`、
       *    📂露露书屋 `m.lulushuwu.com/\d+_\d+/`、⚡📂笔趣阁 `m.biquge365.net/shu/\d+/`。
       * 这些源过去一律被当列表页解析 ⇒ `getElements(bookList)` 拿不到条目 ⇒ **0 条**。
       *
       * ⚠️ **必须复用已抓到的 `content`**，不能转调 `this.detail()` 重抓：搜索 URL 常是
       * POST（`/search.html,{"method":"POST","body":...}`），用 GET 重抓拿不到同一份内容，
       * 而且白多一次请求。上游 `getInfoItem(..., body, baseUrl, ...)` 正是把 body 传进去的。
       *
       * ⚠️ `bookUrl` 取 **`resp.url`（实际响应 URL）**：上游在「跟随过跳转」时用 `res.url`，
       * 未跳转时用构造串 `analyzeUrl.url`；两者在 GET 搜索页场景通常相同，而 `resp.url`
       * 保证后续 `detail()` 能以 GET 重抓到同一个页面。
       */
      if (mode === 'search') {
        const patState = matchBookUrlPattern(rule.bookUrlPattern, resp.url);
        /**
         * 排障开关（`YUEDU_DEBUG_BOOKURLPATTERN=1`）—— 与其它 `YUEDU_DEBUG_*` 同风格。
         *
         * 「我的源配了 `bookUrlPattern` 却没走精确搜索」是**只看源文件无法判断**的问题：
         * 判据是「搜索响应 URL」是否整串匹配，而用户看不到响应 URL（源码只写搜索 URL），
         * 且跳转后两者不同。这一行把三者并排打出来（pattern / 实际响应 URL / 判定）。
         */
        if (process.env['YUEDU_DEBUG_BOOKURLPATTERN'] === '1') {
          console.log(`[bup] ${ctx.sourceId} ${patState} pattern=${String(rule.bookUrlPattern).slice(0, 90)} resp=${resp.url.slice(0, 130)}`);
        }
        if (patState === 'invalid') {
          warnOnce(
            'bookurlpattern',
            ctx.sourceId,
            `bookUrlPattern 不是合法正则，已退化为普通列表搜索：${String(rule.bookUrlPattern).slice(0, 80)}`,
          );
        }
        if (patState === 'hit') {
          const single = await this.parseDetailPageAsItem(ctx, env, rule, content, scriptUrl ?? resp.url, resp.url);
          if (single) {
            const hitResult: UnifiedListResult = {
              items: [single],
              page: { page, pageCount: 1, total: 1, hasMore: false },
            };
            await persistSourceState(ctx);
            timer.end(hitResult);
            return hitResult;
          }
          // 书名没取到 ⇒ 与上游一致：返回**空列表**（不落到列表规则 —— 那会把详情页
          // 当列表页再解析一遍，产出垃圾条目）。
          const empty: UnifiedListResult = {
            items: [],
            page: { page, pageCount: 0, total: 0, hasMore: false },
            hint: 'bookUrlPattern 命中详情页但未解析出书名（检查 ruleBookInfo.name）',
          };
          await persistSourceState(ctx);
          timer.end(empty);
          return empty;
        }
      }

      // 对齐 Legado BookList.kt:84-88：搜索 → ruleSearch；发现 → ruleExplore.bookList
      // 为空（或整个 ruleExplore 缺失）时**整体回落 ruleSearch**（含 name/bookUrl/coverUrl
      // 等字段级规则）。此前只回落 bookList、info 仍取半空 ruleExplore → 字段全空 → 条目全被
      // `if (!title) continue` 跳过（腾讯漫画等 ruleExplore 只有分组信息的源发现页 0 条）。
      const exploreBlank =
        mode !== 'search' && !String(rule.ruleExplore?.bookList ?? '').trim();
      const listRule =
        mode === 'search'
          ? rule.ruleSearch?.bookList || rule.ruleExplore?.bookList
          : exploreBlank
            ? rule.ruleSearch?.bookList
            : rule.ruleExplore?.bookList || rule.ruleSearch?.bookList;
      const info: RuleSearch | RuleBookInfo = mode === 'search'
        ? rule.ruleSearch ?? {}
        : exploreBlank
          ? rule.ruleSearch ?? {}
          : rule.ruleExplore && Object.keys(rule.ruleExplore).length
            ? rule.ruleExplore
            : rule.ruleSearch ?? {};

      // setContent 的第二参就是脚本里的 `baseUrl` 绑定（analyze.ts 的 bindings()）→ 用**未编码**的 scriptUrl
      const ar = new AnalyzeRule(env).setContent(content, scriptUrl ?? resp.url);
      // `#696` 对齐 `BookList.kt:97-100`：先报「取列表」，再报条数
      dlog(ctx, '┌获取书籍列表');
      const items0 = await ar.getElements(listRule ?? '');
      /**
       * ## `#617 ①b` **列表为空 + 源未配 `bookUrlPattern` ⇒ 按详情页解析**
       * （对齐 Legado `BookList.kt:100-110`）
       *
       * ```kotlin
       * if (collections.isEmpty() && bookSource.bookUrlPattern.isNullOrEmpty()) {
       *     Debug.log(…, "└列表为空,按详情页解析")
       *     getInfoItem(...)
       * }
       * ```
       * 注意这是**互补条件**：配了 pattern 的源已经被上面的精确分支处理掉（未命中就认输，
       * 见 `#617①`），没配 pattern 的源才走这条「列表空 ⇒ 当详情页试试」的兜底。
       *
       * 为什么值得补：语料里有一批源「搜索接口直接回一本书的详情页」却**没有**填 pattern，
       * 过去一律按列表规则解析 ⇒ `getElements` 空 ⇒ 用户看到「搜索 0 条」，而 App 能出书。
       * 代价可控：只在**列表为空**时多跑几段 `ruleBookInfo` 规则；解不出书名就照旧返回空
       * （`getInfoItem` 同样 `if (book.name.isNotBlank())` 才收），不会凭空造条目。
       */
      if (items0.length === 0 && matchBookUrlPattern(rule.bookUrlPattern, resp.url) === 'none') {
        dlog(ctx, '└列表为空,按详情页解析');
        const fb = await this.parseDetailPageAsItem(ctx, env, rule, content, scriptUrl ?? resp.url, resp.url);
        if (fb) {
          const fbResult: UnifiedListResult = {
            items: [fb],
            page: { page, pageCount: 1, total: 1, hasMore: false },
          };
          await persistSourceState(ctx);
          timer.end(fbResult);
          return fbResult;
        }
      }
      const items: UnifiedItem[] = [];
      // `#696` 列表条数（Legado `BookList.kt:130`：取完列表就先报大小，再逐本解析字段）
      if (items0.length > 0) dlog(ctx, `└列表大小:${items0.length}`);
      for (const item of items0) {
        const ia = new AnalyzeRule(env).setContent(item, scriptUrl ?? resp.url);
        const title = await ia.getString(info.name ?? '');
        if (!title) {
          /**
           * `#696` **书名取不到必须留痕**：上游 `getSearchItem` 是先打印 `┌获取书名/└空`
           * 再由调用方决定收不收；我们过去直接 `continue` ⇒ 用户只看到「0 条」，
           * 而真相是「列表摸到 20 个元素，20 个的书名规则全空」。这两条修法完全不同
           * （改列表规则 vs 改书名规则）。
           */
          if (items.length === 0) {
            dlogField(ctx, FIELD_LABEL.name!, '');
            dlog(ctx, '└该条目书名为空，已跳过（检查列表项的书名规则）', 'warn');
          }
          continue;
        }
        // Legado BookList.kt:281-284：bookUrl 按 isUrl 求值，**为空时回落当前（搜索/发现）页 URL**
        const bookUrl = (await ia.getString(info.bookUrl ?? '', true)) || resp.url;
        const kindStr = await ia.getString(info.kind ?? '');
        const author = (await ia.getString(info.author ?? '')) || undefined;
        /**
         * `lastChapter` / `wordCount`：Legado `BookList.kt` 对**每个列表项**都会求值它们。
         *
         * ⚠️ 我们此前**完全没求值**（列表阶段只求了 name/bookUrl/kind/author/coverUrl/intro），
         * 于是两类问题：
         *  ① 卡片上「更新至…」永远不显示（值丢了）；
         *  ② **更要命：这些字段里的副作用也不会发生** —— 源常把「传数据」塞进字段的 JS 里，
         *     而字段值本身用不上。实测 🔊潇社音乐（2026-09-26 用户报「目录 0」）：
         *     `ruleSearch.lastChapter = "@js:java.put('json',JSON.stringify(result));''"`，
         *     目录规则再 `java.get('json')` 取回来当章节列表。列表阶段不求值 lastChapter ⇒
         *     `json` **从未写入** ⇒ 目录恒为 0 章。铁证：开 `YUEDU_DEBUG_DETAIL=1` 后
         *     `[put]` 留痕**一条都没有**（能区分「没写」与「写了读不到」）。
         * 这类「借字段副作用传数据」的写法在语料里不止一个源，所以按**类别**补齐。
         */
        const lastChapter = info.lastChapter ? await ia.getString(info.lastChapter) : '';
        const wordCount = info.wordCount ? await ia.getString(info.wordCount) : ''; // `#696` 也留痕（原仅副作用）
        const cover = await ia.getString(info.coverUrl ?? '', true);
        // Legado `BookList.kt:260`：列表项简介**一律** formatIntro（没有 `<useweb>` 例外——
        // 那个例外只在详情 `BookInfo.kt:125` 有）。列表卡片空间小，剥掉 HTML 才不会撑破布局。
        const intro = formatIntro(await ia.getString(info.intro ?? ''));
        /**
         * `#696` 只打印**第一本**的字段（上游 `BookList.kt:219` 的 `log` 参数就是 `index == 0`）——
         * 一页 20 本各打 8 行会把信息流淹掉，而第一本足以证明「这套字段规则通不通」。
         */
        if (items.length === 0) {
          dlogField(ctx, FIELD_LABEL.name!, title);
          dlogField(ctx, FIELD_LABEL.author!, author);
          dlogField(ctx, FIELD_LABEL.kind!, kindStr);
          dlogField(ctx, FIELD_LABEL.wordCount!, wordCount);
          dlogField(ctx, FIELD_LABEL.lastChapter!, lastChapter);
          dlogField(ctx, FIELD_LABEL.intro!, intro);
          dlogField(ctx, FIELD_LABEL.coverUrl!, cover);
          dlogField(ctx, FIELD_LABEL.bookUrl!, bookUrl);
        }
        items.push(
          makeListItem({
            id: String(items.length),
            bookSourceType: rule.bookSourceType,
            title,
            cover,
            author,
            lastChapter,
            intro,
            kindStr,
            bookUrl,
            raw: item,
          }),
        );
      }
      // `#696` 书籍总数（Legado `BookList.kt:149`）
      dlog(ctx, `◇书籍总数:${items.length}`);

      /**
       * `#672` **「0 张卡片」必须留痕**（用户实测 花都动漫 / 爱看吧：网站能正常访问、列表 0 条、无任何错误）。
       *
       * 这两条的真因都是**站点改版**，与引擎无关：
       *   · 花都动漫：详情路径从 `/voddetail/12345.html` 变成 `/voddetail12345.html`，
       *     而源脚本的守卫是 `if (href.indexOf('/voddetail/') < 0) continue` ⇒ 每项都被跳过 ⇒ 返回空数组；
       *   · 爱看吧：列表从 `ul.box > li` 改成 `div.box > div.row > div.col > dl` ⇒ `class.box@tag.li` 0 命中。
       * 但旧实现**一点痕迹都不留**（items=0、error 为空），人只能怀疑「网络/引擎坏了」。
       * 现在打一行：页面多大、用的是哪条列表规则 —— 够判断「取到页了但选择器不匹配」。
       */
      if (items.length === 0) {
        const pageLen = typeof content === 'string' ? content.length : 0;
        if (pageLen > 500) {
          console.warn(
            `[list] 列表解出 0 条（页面 ${pageLen} 字节，列表规则=${String(info.bookList ?? '').replace(/\s+/g, ' ').slice(0, 90)}）`
              + ` ⇒ 取到页但没命中：多半是站点改版，用规则工坊的「试跑物料」核对选择器 · ${ctx.sourceId ?? ''}`,
          );
        }
      }
      const result: UnifiedListResult = {
        items,
        page: { page, pageCount: 0, total: 0, hasMore: items.length > 0 },
        ...(items.length ? {} : { hint: emptyHintOf(resp.body) }),
      };
      await persistSourceState(ctx);
      timer.end(result);
      return result;
    } catch (e) {
      timer.end(undefined, e);
      /**
       * ★ **失败路径也要落盘「按源状态」**（`#606` 第 4 层，2026-10-24）。
       *
       * 这里包含**全局** cache（`cache:global` / `__srcCache`）—— 也就是 `java.importScript` /
       * `cacheFile` 下载到的**远端 js 文本**（qyyuapi 系的 `common.js` 180KB / `jsLib.js` 42KB /
       * `searchUrl.js`）。上游把这些放在 **ACache 磁盘缓存**里，下载即写，**与业务成败无关**；
       * 本仓旧实现在成功 return 前才 `persistSourceState` ⇒ 一次 RULE_PARSE 就让刚下好的几万字全丢，
       * 下次请求从零再下（实测单请求 60~76s，绝大部分是重复下载）。
       * 落盘失败不能掩盖原始错误 ⇒ 单独 try/catch。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 存储失败不改变本次错误的定性 */
      }
      if (e instanceof EngineError) throw e;
      if (isNetworkError(e)) {
        throw new EngineError('NETWORK', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          input: String(e instanceof Error ? e.message : e),
          trace: ctx.trace.tail(20),
          cause: causeOf(e),
          retryable: true,
        });
      }
      throw new EngineError('RULE_PARSE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        input: withJsLibHint(ctx, String(e instanceof Error ? e.message : e)),
        trace: ctx.trace.tail(20),
        cause: causeOf(e),
        retryable: false,
      });
    }
  }

  /**
   * `#617` **把「已经抓到的这一页」当详情页解出一本**（上游 `BookList.getInfoItem`）。
   *
   * 两条调用路径共用：
   *  ① `bookUrlPattern` 命中搜索响应 URL（`BookList.kt:62-78`）；
   *  ② 列表为空且源未配 pattern（`BookList.kt:100-110`）。
   *
   * 三处刻意对齐上游的细节：
   *  · **复用传入的 `content`/`baseUrl`**，不自己发请求（搜索 URL 常是 POST，GET 重抓会拿错）；
   *  · `init` 先行替换求值内容（`BookInfo.kt:58`），String 包装对象要取字符串；
   *  · **字段隔离边界**：只隔离 kind/lastChapter/intro/coverUrl/wordCount，
   *    `name`/`author` 不隔离（源规则写错就该显式失败，别掩盖成「字段为空」）。
   *
   * @returns 书名非空才返回条目；否则 undefined（上游 `book.name.isNotBlank()` 才收）
   */
  private async parseDetailPageAsItem(
    ctx: EngineContext,
    env: AnalyzeEnv,
    rule: CompiledBookSource,
    content: unknown,
    baseUrl: string,
    bookUrl: string,
  ): Promise<UnifiedItem | undefined> {
    const infoRules: RuleBookInfo = rule.ruleBookInfo || {};
    env.bookData = { bookUrl, type: bookTypeOf(rule) };
    const br = new AnalyzeRule(env).setContent(content, baseUrl);

    const initRule = typeof infoRules.init === 'string' ? infoRules.init.trim() : '';
    if (initRule) {
      try {
        const iv0 = await br.getElement(initRule);
        const iv: unknown =
          iv0 == null ? '' : typeof iv0 === 'string' || iv0 instanceof String ? String(iv0) : iv0;
        if (iv !== '' && iv != null) br.setContent(iv, baseUrl);
      } catch {
        /* init 失败沿用原内容（同 detail：只记日志不阻断） */
      }
    }

    const field = async (label: string, r: string, isUrl = false): Promise<string> => {
      const rs = (r ?? '').trim();
      if (!rs) return '';
      try {
        return await br.getString(r, isUrl);
      } catch (e) {
        warnOnce(
          `bookurlpattern:${label}`,
          ctx.sourceId,
          `详情页直出字段「${label}」求值失败，已留空（不影响其它字段）：${errText(e)}`,
        );
        return '';
      }
    };

    const title = await br.getString(infoRules.name ?? '');
    if (!title) return undefined;
    const author = await br.getString(infoRules.author ?? '');
    // wordCount 暂无展示位，但**必须求值**：源常把「传数据」塞进字段的 JS 里
    // （`#` 列表阶段同款处理，实测 🔊潇社音乐 靠 `lastChapter` 的 java.put 传目录数据）。
    await field('wordCount', infoRules.wordCount ?? '');
    return makeListItem({
      id: '0',
      bookSourceType: rule.bookSourceType,
      title,
      cover: await field('coverUrl', infoRules.coverUrl ?? '', true),
      author: author || undefined,
      lastChapter: await field('lastChapter', infoRules.lastChapter ?? ''),
      // 详情页直出时简介用 `normalizeIntro`（`<usehtml>` / `<useweb>` 原样保留，
      // 对齐 `BookInfo.kt:123-133`）；列表口径才是无条件 `formatIntro`。
      intro: normalizeIntro(await field('intro', infoRules.intro ?? '')),
      kindStr: await field('kind', infoRules.kind ?? ''),
      bookUrl,
      raw: content,
    });
  }

  // ---- 详情 + 目录 ----
  /** 统一请求构造器（对齐 Legado AnalyzeUrl）：
   *  url,{options} 尾巴（宽松解析）→ @js/<js> 整段构造（{{}} 内嵌规则先按内容替换）→ 插值 →
   *  相对路径补全 → 非ASCII/charset 百分号编码 → POST 默认 content-type → 发请求 */
  /**
   * **跟随一层**：把「脚本要求打开的 URL」当播放页抓一次，在其 HTML 里找媒体直链。
   *
   * 这是 A 项「视频源分层解析」的第②层（第①层＝页面内已有直链，由 `collectMediaCandidates`
   * 覆盖；第③层无头嗅探 / 第④层弹窗兜底不在本轮）。调用点在 content 组装里，**仅当 media 为空**。
   *
   * 候选来源：`onBrowserOpen` 累积的 `__browserUrls`（`java.startBrowser` / `startBrowserAwait`）。
   * 实测 🎬茶杯狐狸：`ruleContent` 自己用正则从正文页抽出 `"url_next"` 再交给 `startBrowserAwait`
   * ⇒ 播放页地址本来就在手里，**根本不需要嗅探**。
   *
   * 为什么限制这么死：
   *   · `startBrowser` 也用于「让用户手动过验证/登录」—— 那种页面跟随抓取必然失败，
   *     所以失败一律静默（只留痕），绝不能把正文或整条规则带崩；
   *   · 只跟随**一层**且最多 2 个候选，避免套娃抓取与多开窗造成的请求放大；
   *   · 跳过与当前正文页相同的 URL（自环）。
   */
  private async followPlayPage(
    ctx: EngineContext,
    env: AnalyzeEnv,
    rule: CompiledBookSource,
    selfUrl: string,
    content: unknown,
  ): Promise<UnifiedContent['media'] | undefined> {
    const rawList = ctx.variables.get('__browserUrls');
    const cands = (Array.isArray(rawList) ? (rawList as unknown[]) : [])
      .map((x) => String(x ?? '').trim())
      .filter((u) => /^https?:\/\//i.test(u) && u !== selfUrl);
    if (!cands.length) return undefined;
    for (const u of cands.slice(-2)) {
      // `#374`：候选**自身就是媒体直链**时不能当页面抓 —— 茶杯狐狸的 `url_next`
      // 就是一条裸 m3u8/mp4 直链（用户实测把 `result=pUrl` 后可直接转播放）。
      // 旧逻辑对直链也走 fetchRuleUrl ⇒ 抓回来的是媒体二进制/播放器空壳，
      // `collectMediaCandidates` 必 miss ⇒ 静默 `follow-play-miss`，功能形同虚设。
      if (MEDIA_EXT_RE.test(unescapeJsUrl(u)) || /\/m3u8|hls|\.mp4|\.m3u8/i.test(u)) {
        warnOnce('follow-play', u, `播放页候选即媒体直链，直接采用：${u.slice(0, 110)}`);
        return toMedia(u, u);
      }
      /**
       * `#470②`：**无扩展名候选先轻探测**（只看响应头、不拉响应体）。
       * 命中任一即**直接采用**，不再 `fetchRuleUrl` 整包抓（旧行为会跟随 302 把整首音频
       * 当文本拉回来 ⇒ 撞文本通道 8MB 护栏，用户可见 `[net-guard] … 已截断`）：
       *   ① 3xx 且 `Location` 是媒体直链（`meting?type=url` 的形态）；
       *   ② 候选自身 `Content-Type` 是 `audio/*|video/*`（无扩展名的 CDN 直链形态）。
       * ⚠️ `mpegurl` 类（`audio/mpegurl` / `vnd.apple.mpegurl`）**故意排除**：那是 HLS
       * 播放列表文本，必须留给原路径抓回正文（否则会把 m3u8 当媒体直链跳过文本规则）。
       * 探测失败（网络异常）静默回退原路径 ⇒ 零回归。
       */
      try {
        const pb = await this.fetchRuleUrl(ctx, env, rule, u, { content, probe: true });
        const hdr = (k: string): string => {
          for (const [hk, hv] of Object.entries(pb.resp.headers ?? {})) {
            if (hk.toLowerCase() === k) return String(hv ?? '');
          }
          return '';
        };
        const code = pb.resp.status;
        const ctype = hdr('content-type');
        const loc = hdr('location');
        if (code >= 300 && code < 400 && loc) {
          const abs = (() => {
            try {
              return new URL(loc, u).toString();
            } catch {
              return loc;
            }
          })();
          if (MEDIA_EXT_RE.test(unescapeJsUrl(abs)) || /\/m3u8|\.mp4|\.m3u8|\.mp3|\.m4a/i.test(abs)) {
            warnOnce('follow-play', u, `候选 3xx(${code}) → 媒体直链，直接采用：${abs.slice(0, 110)}`);
            return toMedia(abs, u);
          }
        } else if (/^(audio|video)\//i.test(ctype) && !/mpegurl/i.test(ctype)) {
          warnOnce('follow-play', u, `候选本身即媒体（${ctype}），直接采用：${u.slice(0, 110)}`);
          return toMedia(u, u);
        }
      } catch {
        /* 探测失败 ⇒ 静默回退到下方原路径 */
      }
      try {
        const built = await this.fetchRuleUrl(ctx, env, rule, u, { content });
        const html = String(parseResponse(built.resp).content ?? '');
        const all = collectMediaCandidates(html);
        // 优先带媒体扩展名的直链；其次认「无扩展名但明显是流媒体」的形态
        const hit = all.find((x) => MEDIA_EXT_RE.test(x)) ?? all.find((x) => /m3u8|\/hls\/|\.mp4/i.test(x));
        if (hit) {
          warnOnce('follow-play', u, `播放页跟随成功：${u.slice(0, 110)} → ${hit.slice(0, 110)}`);
          return toMedia(hit, built.resp.url);
        }
        warnOnce('follow-play-miss', u, `播放页跟随到页面但未找到媒体直链（可能需要第③层嗅探）：${u.slice(0, 110)}`);
      } catch (e) {
        warnOnce('follow-play-fail', u, `播放页跟随失败（静默回退，不影响正文）：${u.slice(0, 110)} | ${errText(e)}`);
      }
    }
    return undefined;
  }

  private async fetchRuleUrl(
    ctx: EngineContext,
    env: AnalyzeEnv,
    rule: CompiledBookSource,
    rawUrl: string,
    interp: { keyword?: string; page?: number; content?: unknown; probe?: boolean; timeoutFloorMs?: number } = {},
  ) {
    const keyword = interp.keyword ?? '';
    const page = interp.page ?? 1;
    /**
     * `#470②` **探测模式**（唯一调用方 = `followPlayPage`）：**只看响应头、不拉响应体**。
     *
     * 要解决的实证缺陷：无扩展名的音频直链（netease `m*.music.126.net/…/da77d1d623bb`）
     * 与 `meting?type=url` 这种「302 到 CDN」的地址，被 `followPlayPage` 当「播放页」用
     * 普通 `fetchRuleUrl` 抓 ⇒ **跟随 302 把 10.85MB 音频当文本拉回来**（实测
     * `meting` 302 只 268B，follow 后 200 / `audio/mpeg` / 10.85MB）⇒ 撞文本通道 8MB 护栏
     * ⇒ `[net-guard] 响应体超过上限 8MB，已截断` + `[legado] … 首个被截断 URL：…/meting/…`。
     * 探测用 `redirect:'manual'`（拿 3xx 与 `Location`）+ `responseType:'stream'`
     * （core 在 `readBodyLimited` **之前**早退 ⇒ 一个字节都不缓冲），拿到头后立刻 `cancel()`。
     */
    const probe = interp.probe === true;
    // {{$.x}} 内嵌规则的内容载体：字符串 JSON 先解析成对象
    let contentObj: unknown = interp.content;
    if (typeof contentObj === 'string') {
      try {
        contentObj = JSON.parse(contentObj);
      } catch {
        /* HTML/其它文本保持原样 */
      }
    }

    let tplUrl = rawUrl.trim();
    /**
     * `,{options}` 尾巴的解析（对齐 Legado `AnalyzeUrl.kt:800` 的 `paramPattern = \s*,\s*(?=\{)`）。
     *
     * ⚠️ **必须在「插值之后」调用**（2026-09-23 修，缺陷类AJ）。
     * Legado 的顺序写在 `AnalyzeUrl.initUrl():167-175`：
     *     `analyzeJs()`（`@js:`/`<js>`）→ `replaceKeyPageJs()`（`{{ }}` / 页数）→ `analyzeUrl()`
     * 而切尾巴在最后一步 `analyzeUrl()` 里，源码注释原文：
     * 「replaceKeyPageJs 已经替换掉额外内容，此处 url 是基础形式，可以直接切首个 ',' 之前字符串」。
     * 我们此前把切尾巴提到了**插值之前** ⇒ 任何「模板本身含 `,{`」的源都被切坏。
     * 实测（⚡📂️独阅读网）：explore 选项值 = `{{ URL("/bookcity/get_rank_book_list", {…}) }}`，
     * `URL(` 的**第二个实参** `, {…}` 被当成 URL 选项尾巴切走 ⇒ 模板只剩
     * `{{ URL("/bookcity/get_rank_book_list"`（**没有闭合 `}}`**）⇒ 正则零匹配、`interpUrl` 原样返回
     * ⇒ 请求发成 `…/%7B%7B%20URL(%22/bookcity/get_rank_book_list%22`（**无任何 ERR 留痕 = 静默失败**）
     * ⇒ 站点回错误信封 ⇒ 脚本 `decrypt` 抛 `wrong final block length` ⇒ `RULE_PARSE@parse`。
     *
     * 切法也照 Legado：取 `\s*,\s*(?=\{)` 的**首个**匹配（不是 `lastIndexOf`）——
     * 与 Legado 一致才不会对同一份源得出不同结果。
     * ⚠️ **尾巴可能被百分号编码**（实测点众阅读 bookUrl 尾巴 =
     * `%7B%22method%22:%20%22post%22,%20body:%20%22c404…%22%7D`）：定位到尾巴后**整体
     * decodeURIComponent** 再解析（Legado 收到的尾巴本就是原始 JSON）；编码形态下 `,{`
     * 字面量不存在，故先粗还原 `%7B`/`%7D`/`%22` 再定位。
     */
    let reqOpts: Record<string, unknown> | undefined;
    const cutUrlOptionsTail = (raw: string): { url: string; opts?: Record<string, unknown> } => {
      const firstTail = (s: string): { head: string; tail?: string } => {
        // `\s*,\s*\{` 与 Legado 的 `\s*,\s*(?=\{)` 等价（这里把 `{` 一起吃掉，便于取 tail）
        const m = /\s*,\s*\{/.exec(s);
        if (!m) return { head: s };
        return { head: s.slice(0, m.index), tail: s.slice(m.index + m[0].length - 1) };
      };
      let found = firstTail(raw);
      if (!found.tail && /%7B/i.test(raw)) {
        // 编码形态下 `,{` 不存在 → 粗还原后再定位
        found = firstTail(raw.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/%22/g, '"'));
      }
      if (!found.tail) return { url: raw };
      let optStr = found.tail;
      if (/%[0-9A-Fa-f]{2}/.test(optStr)) {
        try {
          optStr = decodeURIComponent(optStr);
        } catch {
          /* 非法转义保持原样，交给宽松解析 */
        }
      }
      const url = found.head.trim();
      if (process.env['YUEDU_DEBUG_DETAIL']) {
        // eslint-disable-next-line no-console
        console.log(`[url-tail] ${url.slice(0, 120)} | opts=${optStr.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
      return { url, opts: parseOptionsTolerant(optStr) };
    };

    // source = 规则字段 + BaseSource 方法桩（与 AnalyzeRule 的 source 绑定同一实现）
    const srcStub = makeSourceStub(ctx, rule as unknown as Record<string, unknown>)!;

    let url: string;
    /**
     * `#383`：URL 规则里的 JS 段求值 —— **判据唯一实现 = core `applyUrlRuleJs`**。
     *
     * 上游 `AnalyzeUrl.kt:167-193` 的 `analyzeJs()` 用 `JS_PATTERN = /<js>…<\/js>|@js:…/`
     * 配 `Matcher.find()` **全文扫描**：`@js:` 出现在 URL 的**任意位置**都触发，
     * 命中点之前的前缀除非写 `@result` 否则被丢弃（`Movieffm` 分类名前缀就是这么消失的）。
     *
     * ⚠️ 旧判据 `raw.startsWith('@js:')` 只认**整串开头** ⇒ qyyuapi 五源的
     * `Movieffm@js:`…`` 中缀形态整条被当普通 URL ⇒ 请求发成非法地址（与 `#382` rss 侧同款缺陷，
     * 那里已用 `applyUrlRuleJs` 修掉；legado 侧是同一缺陷类的**漏网分支**）。
     */
    const hasJsSegment = /@js:|<js>/i.test(tplUrl);
    if (hasJsSegment) {
      // `{{}}` 内嵌规则先按当前内容求值替换进 JS 源码（Legado makeUpRule 对 Js 段同样生效）
      const preparedTpl = await resolveInnerRules(tplUrl, contentObj, env, rule.bookSourceUrl ?? '', keyword, page);
      const v = await applyUrlRuleJs(preparedTpl, async (code, currentResult) => {
        const prepared = await resolveInnerRules(code, contentObj, env, rule.bookSourceUrl ?? '', keyword, page);
        const out = await env.jsEval(prepared, {
          $: contentObj ?? '',
          // 上游 `AnalyzeUrl.evalJS` 的 `result` 绑定 = 当前累积值（供 `@result` 回填）
          result: currentResult,
          key: keyword,
          page,
          searchWord: keyword,
          baseUrl: rule.bookSourceUrl,
          source: srcStub,
        });
        return out == null ? null : String(out);
      });
      // JS 构造的 URL 自带 `,{options}` 尾巴（脚本返回 `url + ',' + JSON.stringify(opts)`）——
      // ⚠️ 只能对**求值结果**切，绝不能先切：JS 源码里常有 `,{` 字面量
      //    （`url + ',{"method":"POST","body":' + JSON.stringify(body)`），
      //    先切会把 JS **从字符串中间截断** → `Invalid or unexpected token`
      //    （实测回归：番茄听书[官方] 搜索 20 → 0）。
      //    与 `{{ }}` 分支同一时机（Legado：`analyzeJs()` 先跑，`analyzeUrl()` 后切）。
      const cutJs = cutUrlOptionsTail(v == null ? '' : String(v).trim());
      url = cutJs.url;
      reqOpts = cutJs.opts;
    } else {
      // `{{<规则>}}` 片段（如 `{{$..comic_id}}`）按规则求值——Legado makeUpRule 的 isRule 分支
      const evalRuleForUrl =
        contentObj === undefined
          ? undefined
          : async (r: string): Promise<string> =>
              (await new AnalyzeRule(env).setContent(contentObj, env.baseUrl).getString(r, false)) ?? '';
      if (process.env['YUEDU_DEBUG_DETAIL']) {
        // eslint-disable-next-line no-console
        console.log(`[url-in] ${tplUrl.replace(/\s+/g, ' ').slice(0, 150)}`);
      }
      try {
        url = (await interpUrl(tplUrl, keyword, page, env, srcStub, contentObj, evalRuleForUrl)).trim();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log(`[url-interp-ERR] ${errText(e).slice(0, 200)}`);
        url = tplUrl;
      }
      if (process.env['YUEDU_DEBUG_DETAIL']) {
        // eslint-disable-next-line no-console
        console.log(`[url-out] ${url.replace(/\s+/g, ' ').slice(0, 150)}`);
      }
      /**
       * ★ **尾巴在插值之后切**（Legado `AnalyzeUrl.initUrl` 的顺序）。
       * 这句必须在 `interpUrl` 之后：`{{ }}`/`@js:` 的求值结果**才**可能含 `,{options}`
       * （典型的登录态源：jsLib 的 `URL()` 返回 `BASEURL+path,{"method":"POST",…}`）。
       * 详见 `cutUrlOptionsTail` 的长注释（缺陷类AJ）。
       */
      const cutAfterInterp = cutUrlOptionsTail(url);
      url = cutAfterInterp.url;
      reqOpts = cutAfterInterp.opts;
    }
    // URL 选项 `js`：**用它改写/构造 URL**（Legado `AnalyzeUrl.kt:274-278`）——
    //     `option.getJs()?.let { jsStr -> evalJS(jsStr, url)?.toString()?.let { url = it } }`
    // 绑定面照 `AnalyzeUrl.evalJS`（`:377-394`）：`result` = 当前 URL（源里常见 `'...+result+'...`），
    // 外加 baseUrl / key / page / source / book / java（由 AnalyzeRule 统一提供）。
    //
    // ⚠️ 语义细节：**返回 null/undefined 时 URL 必须保持原样** —— 语料里大量 `js` 是纯副作用脚本
    // （`java.toast('正在加载详情页…')` 大美书网/猫眼看书），它们不返回 URL；
    // 旧实现直接忽略 `js` 选项，等于「用 JS 构造 URL」的源（晋江 `book?result:toReview(...)`）
    // 一律请求到错误地址。语料 5 源使用 URL 选项 `js`。
    const optJs = typeof reqOpts?.['js'] === 'string' ? (reqOpts['js'] as string).trim() : '';
    if (optJs && optJs !== 'null') {
      try {
        const out = await new AnalyzeRule(env).runJs(optJs, { result: url });
        if (out != null) {
          const next = String(out).trim();
          if (next) url = next;
        }
      } catch (e) {
        // 兜底但留痕（静默兜底 = 无从排查）：保留原 URL，请求照发，让站点自己报错
        warnOnce('url-js', url, `URL 选项 js 求值失败（保留原 URL）：${errText(e)}`);
      }
    }
    /**
     * `#579` `<1,2,3>` 页码模式（Legado `pagePattern`）—— 必须在**相对地址绝对化之前**替换，
     * 否则 `new URL()` 会把 `<,index_1.html>` 编码成 `%3C,index_1.html%3E` ⇒ 站点 404。
     * 与规则工坊 URL 探针共用 `core` 的 `pickPagePattern`（唯一实现）。
     */
    url = pickPagePattern(url, page).s;
    /**
     * `#405②` **剥离 `{,...}` 可选段**（非 Legado 语法，源作者约定）——必须在 baseUrl 补全**之前**，
     * 否则整段被当成路径一部分。咚漫 `exploreUrl`：`https://…/genre{,/error.html}#LOVE`。
     * 上游无此语法 ⇒ 字面量 ⇒ 站点 404（实测 `…/genre` = 200）。见 core `stripOptionalUrlSegments`。
     */
    url = stripOptionalUrlSegments(url);
    if (url && !/^https?:\/\//i.test(url)) {
      url = resolveUrl(rule.bookSourceUrl, url) ?? url;
    }
    /**
     * **脚本可见的 URL**（Legado `AnalyzeUrl.url`）—— 即「尚未做百分号编码」的那个串。
     *
     * 为什么必须与请求用的 URL 分开（2026-09-22 用户实测 ① 宜搜小说正文空）：
     * 源在正文脚本里用 `baseUrl.match(/chapter_name=(.*$)/)` 取出章节名**去算签名**，
     * 而 Legado 给脚本的 `baseUrl` 是**原始串**（`BookContent.kt:63` 传 `analyzeUrl.url`，
     * 编码只发生在 OkHttp 出站层）。我们此前把 `resp.url`（已被下面这行编码过）当 `baseUrl`
     * ⇒ 脚本拿到 `%E7%AC%AC%E4%B8%80%E7%AB%A0…` 去算 md5 ⇒ 站点解码后重算不一致
     * ⇒ 回 `{"errorlog":"非法身份"}` ⇒ **正文恒空**。
     * 站点侧对照（同一算法，只改签名用的名字形态）：
     *   · 用原始名算 snk → HTTP 200 / 16628 字节 ✅
     *   · 用编码名算 snk → `非法身份` ❌
     *
     * ## `#639` 尾巴必须**留在**脚本可见的 URL 里（2026-10-26）
     *
     * 上游给目录/详情脚本的 `baseUrl` 不是 `AnalyzeUrl.url`，而是 **`book.tocUrl` / `book.bookUrl`
     * 的原样值（含 `,{…}` 选项尾巴）**：
     * ```kotlin
     * // BookInfo.kt:157 —— 规则输出原样存，不剥尾巴
     * book.tocUrl = analyzeRule.getString(infoRule.tocUrl, isUrl = true)
     * // WebBook.kt:355 —— 目录阶段把它整个作为 baseUrl 绑定
     * BookChapterList.analyzeChapterList(baseUrl = book.tocUrl, redirectUrl = res.url, body = res.body)
     * ```
     * 我们此前传的是**剥掉尾巴**的 url ⇒ 依赖「从 baseUrl 里解析选项 JSON」的源拿不到数据。
     *
     * 真站取证（书旗听书本地源（同人）`https___ocean.shuqireader.com`，用户实测第 4 条）：
     * `tocUrl = "data:;base64,ODg1NDY3MA==,{"type":"audio","bookId":"8854670"}"`，
     * ruleToc 第一句就是 `var sqTocJsonAt = String(baseUrl).indexOf("{")` /
     * `sqTocInfo = JSON.parse(baseUrl.substring(sqTocJsonAt))`，靠它取 `bookId` 再去请求
     * `/webapi/bcspub/openapi/book/chapterlist`（**真正的目录**）。
     * 尾巴一旦被剥：`sqTocInfo` 恒空 ⇒ 内层 ajax 不跑 ⇒ `src` 还是占位页 ⇒
     * `data.chargeContUrlPrefix` 读 undefined ⇒ **目录 0 章**。
     *
     * 用 `JSON.stringify(reqOpts)` 重排而非保留原文本：源都是 `JSON.parse` 取字段，
     * 键序/空白不参与语义（原始文本已在上一步 `separateUrlTail` 里解析掉了）。
     */
    const tailJson = reqOpts ? JSON.stringify(reqOpts) : '';
    const scriptUrl = tailJson ? `${url},${tailJson}` : url;
    /**
     * URL 里的非 ASCII 字符百分号编码。
     *
     * ★ `#197` 修复（2026-10-02）：**先判 charset，再决定用哪个编码器**。
     *
     * 旧实现是「先无条件按 UTF-8 编码一次，再按 charset 编码一次」——但第一步跑完，
     * URL 里只剩 ASCII（`我` 已变成 `%E6%88%91`，全是 ASCII 字符）⇒ 第二步的正则
     * `[^\x21-\x7E]` **匹配不到任何东西** ⇒ charset 分支是**死代码**。
     *
     * 后果（本机实测）：GBK 站的关键词被按 UTF-8 发出去 ⇒ 站点解出乱码 ⇒ **搜索恒 0 条**。
     * 飞卢小说为例（同一 URL，只改编码方式）：
     *   · `k=%CE%D2%B5%C4`（「我的」的 GBK）  ⇒ HTTP 200，命中搜索结果 **30** 项 ✅
     *   · `k=%E6%88%91%E7%9A%84`（UTF-8）     ⇒ HTTP 200，命中 **0** 项 ❌
     * 语料里声明非 UTF-8 charset 的源共 **44** 个（34 gbk + 10 gb2312，其中 43 个在 `searchUrl`）。
     *
     * 语义对齐上游 `AnalyzeUrl.encodeParams(params, charset, isQuery = true)`（`:315-327`）：
     * charset 为空 ⇒ UTF-8；`escape` ⇒ 不编码；其余 ⇒ 用该字符集编码。
     * （差异如实记：上游只编码 **query 部分**、路径原样；本仓对整串非 ASCII 处理。）
     */
    const reqCharset = typeof reqOpts?.['charset'] === 'string' ? (reqOpts['charset'] as string).toLowerCase() : '';
    const useCharset = !!reqCharset && reqCharset !== 'escape' && !/^(utf-?8|ascii)$/i.test(reqCharset);
    url = url.replace(/[^\x21-\x7E]/g, (ch) => (useCharset ? percentEncode(ch, reqCharset) : encodeURIComponent(ch)));

    const optMethod = typeof reqOpts?.['method'] === 'string' ? (reqOpts['method'] as string).toUpperCase() : 'GET';
    /**
     * POST 体：**字符串体**原样插值；**对象/数组体先 `JSON.stringify`**。
     *
     * 后者是 Legado 的权威语义（`UrlOption.getBody()`：非字符串体走 `JsonUtils.toJson(body)`），
     * 我们此前只认字符串体 ⇒ **对象体被静默丢弃 ⇒ POST 发成「无体」**。
     *
     * 实测（2026-09-27 第十七批，`🏷QB女生` / `🏷QQ浏览器` 的 `ruleToc.chapterUrl`）：
     * 端点 `novel.html5.qq.com/be-api/content/ads-read` 要求
     * `{"Scene":"chapter","ContentAnchorBatch":[{"BookID":"…","ChapterSeqNo":[1]}]}`：
     *   · 引擎（体被丢）→ **HTTP 400 `{"ret":400,"errMsg":"invalid Request Param"}`** ⇒ 2170 章正文**全空**
     *   · 同一 URL + 体用 curl 手发 → **200** + `{"ret":0,…,"Content":[{"ChapterInfo":{…` ✅
     * ⇒ 归因**不是站点问题**。语料 6 源命中（`ruleToc.chapterUrl` 2 · `ruleToc.chapterList` 1 ·
     * `ruleBookInfo.tocUrl` 1 · `exploreUrl` 2）。
     *
     * 插值（`interpUrl`）照做：体里的 `{{…}}` 在部分形态下**尚未**在上一阶段被替换
     * （例如体是顶层选项、而 URL 本体不含 `{{}}`）。
     */
    const rawBody = reqOpts?.['body'];
    let optBody =
      typeof rawBody === 'string'
        ? await interpUrl(rawBody, keyword, page, env, srcStub, contentObj)
        : rawBody !== null && typeof rawBody === 'object'
          ? await interpUrl(JSON.stringify(rawBody), keyword, page, env, srcStub, contentObj)
          : undefined;
    if (optBody !== undefined && reqCharset && reqCharset !== 'escape' && !/^(utf-?8|ascii)$/i.test(reqCharset)) {
      optBody = optBody.replace(/[^\x21-\x7E]/g, (ch) => percentEncode(ch, reqCharset));
    }
    const optHeaders =
      reqOpts?.['headers'] && typeof reqOpts['headers'] === 'object' ? (reqOpts['headers'] as Record<string, string>) : undefined;
    const headers = { ...(optHeaders ?? {}), ...(await resolveHeaders(rule.header, env)) };
    /**
     * 「源是否**显式**声明了 Content-Type」——必须在下面自动补之前判定
     * （Legado `AnalyzeUrl.kt:286` 的 `headerMap["Content-Type"].isNullOrEmpty()`）。
     *
     * ⚠️ 有意偏离 Legado 一处：那里是**大小写敏感**的 `headerMap["Content-Type"]` 字面查表，
     * 我们按大小写不敏感判定 —— 源里写 `content-type` 的情况同样应视为「作者已声明」，
     * 否则会把它本已按 JSON/自定义格式写好的体再编码一遍（Legado 在该形态下是拼运气）。
     */
    const hasExplicitContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    /**
     * POST 表单体编码（Legado `AnalyzeUrl.kt:284-289` + `encodeParams`）——见上方 `javaFormEncode` 注释。
     *
     * 条件与 Legado 一致：**POST** 且体**非 JSON 非 XML** 且**源未显式设 Content-Type**。
     * `checkEncoded` 对应 Legado 的 `charset.isNullOrEmpty()`：默认（无 charset）要"已编码段跳过"，
     * 避免源里已经写好的 `%XX` 被二次编码。
     * ⚠️ 源指定了非 UTF-8 的 `charset` 时**不走这里**（那份语义是逐字节换字符集，
     * 由上面的 `percentEncode` 分支负责）—— 语料中该形态罕见，遇到时留痕。
     */
    if (optMethod === 'POST' && optBody !== undefined && !hasExplicitContentType && !looksJsonOrXml(optBody)) {
      if (!reqCharset || /^utf-?8$/i.test(reqCharset)) {
        // 与 core（L1 `syncHttp` / worker 宿主 `http` 分支）**共用同一份实现**，防三处漂移
        optBody = encodeFormBody(optBody, !reqCharset);
      } else {
        warnOnce('form-charset', url, `POST 表单体指定了 charset=${reqCharset}，跳过表单编码（保留原样）`);
      }
    }
    if (optMethod === 'POST' && optBody !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = /^\s*[\{\[]/.test(optBody) ? 'application/json' : 'application/x-www-form-urlencoded';
    }
    // 登录头注入（Legado `AnalyzeUrl.kt:139-141`：`getHeaderMap(hasLoginHeader && isLoginHeaderSite(mUrl))`
    // —— 在源 header 之后 putAll，所以**覆盖**源 header 的同名项；值来自 source.putLoginHeader() 持久化的 JSON）。
    // ⚠️ **只注入源同站请求**：封面/图床/CDN 常托管在第三方域，跨域携带 Cookie/Authorization
    // 会被对方风控拦（实测常见 403），且等于把登录态发给了第三方。
    const loginHeaderRaw = ctx.variables.get('__loginHeader');
    if (
      typeof loginHeaderRaw === 'string' &&
      loginHeaderRaw &&
      isLoginHeaderSite(url, rule.bookSourceUrl)
    ) {
      try {
        const lh = JSON.parse(loginHeaderRaw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(lh ?? {})) if (v != null) headers[k] = String(v);
      } catch {
        /* 非 JSON 忽略 */
      }
    }
    // 源级 Cookie（登录态）自动注入
    if (ctx.cookies) {
      const ck = ctx.cookies.header();
      if (ck && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) headers['Cookie'] = ck;
    }
    // Legado `AnalyzeUrl.kt:443-445`：**URL 选项带 `type`** 时，响应体不是文本，
    // 而是「原始字节的 hex 串」——
    //     `if (type != null) return StrResponse(url, HexUtil.encodeHexStr(getByteArrayAwait()))`
    // 且该分支在 WebView / executeStrRequest **之前**返回（有 type 就永不渲染、永不按 charset 解码）。
    //
    // 典型用法（七猫官方正文）：目录把章节页造成 `data:;base64,<cid/content_md5>,{"type":"qm"}`，
    // 正文脚本 `java.hexDecodeToString(result)` 再把 hex 还原成 `<cid>/<content_md5>` 去取密文。
    // 不实现这条，`hexDecodeToString` 收到的就是明文（含 `/`）→ hutool decodeHex 抛
    // `Illegal hexadecimal character`（我们旧实现是 Node 的「遇非法字符截断」，更隐蔽）。
    // 语料 17 源使用 URL 选项 `type`（qm/qtqd/jjwx/ywc/gycatalog…）。
    const typeOptRaw = reqOpts?.['type'];
    /**
     * `#578` **判据是「`type` 出现过」而不是「非空串」**（对齐上游 `if (type != null)`）。
     *
     * 用户报障 📷🔞HentaiCosplay「目录解析失败：Illegal hexadecimal character "/" at index 0」：
     * 源把 tocUrl 造成 `data:;base64,<url>,{"type":""}`（**显式空 type**）。
     * 上游 `type != null` 对空串成立 ⇒ 仍走「字节→hex」⇒ 脚本 `java.hexDecodeToString(result)` 可解；
     * 我们旧判据 `trim() !== ''` 把空串当「无 type」⇒ 按文本返回解码后的 URL
     * （以 `/` 开头）⇒ hex 解码必然在首字符抛错。
     * 全库 3 个 `"type":""` 源都是 Legado 源（hentai-cosplay / porn-images 同族 / 起点 explore），
     * 上游行为就是 hex，本改动是**向 App 对齐**，不影响非空 type 与无 type 两条路。
     */
    const bodyAsHex = typeOptRaw != null;
    /**
     * `YUEDU_DEBUG_DETAIL=1`：**所有规则驱动请求**的留痕（method / url / header 键 / body 头部）。
     *
     * 与 `[ajax]`/`[ajax:L1]` 互补：那两条只覆盖**源脚本里**的 `java.ajax`，而
     * 搜/详情/目录/正文的**引擎侧请求**（`fetchRuleUrl`）此前完全不可见 ——
     * 排查「请求发成了 GET / body 丢了」（实测 ⑥ 点众发现页分类 items=0）时只能猜。
     * 只打 header **键名**与 body 前 120 字，避免把 token/密码写进日志。
     */
    if (process.env['YUEDU_DEBUG_DETAIL']) {
      // eslint-disable-next-line no-console
      console.log(
        `[req] ${optMethod} ${url.slice(0, 150)} | hdr=[${Object.keys(headers).join(',')}]` +
          `${optBody !== undefined ? ` | body=${optBody.slice(0, 120)}` : ''}`,
      );
    }
    const httpOpts = {
      headers,
      method: (optMethod === 'POST' ? 'POST' : 'GET') as 'GET' | 'POST',
      ...(optBody !== undefined ? { body: optBody } : {}),
      ...(reqCharset ? { charset: reqCharset } : {}),
      ...(bodyAsHex ? { responseType: 'arraybuffer' as const } : {}),
      // `#742` 源选项 `dnsIp`（IP 直连）：**只换域名→地址**，Host/SNI 仍按 URL 域名
      ...(typeof reqOpts?.['dnsIp'] === 'string' && (reqOpts['dnsIp'] as string).trim()
        ? { dnsIp: reqOpts['dnsIp'] as string }
        : {}),
      // `#470②`：探测模式 = 「不跟随重定向（拿真实 3xx + Location）+ 不缓冲响应体」
      ...(probe ? { redirect: 'manual' as const, responseType: 'stream' as const } : {}),
      // 60s 上限（Legado callTimeout，HttpHelper.kt:62）+ 源选项 timeout 派生值，
      // 且**不得超过本次行动的剩余预算** —— 否则客户端先超时、服务端还在跑（见 EngineContext.deadlineAt）
      timeout: requestTimeout(ctx, reqOpts?.['timeout'], interp.timeoutFloorMs),
      /**
       * `#769` **把行动的中断信号真正交给 HTTP 层**：此前 `ctx.signal` 在引擎里没有任何消费者，
       * 于是「目录后续页给了 15s 下限」会绕过行动预算（detail 75s）继续跑。
       * core 的 `opts.signal`（`#691`）会并进内部 controller ⇒ 到点立刻 abort 在途请求。
       */
      signal: ctx.signal,
    };
    let resp: HttpResponse;
    // WebView 分支（对齐 AnalyzeUrl.kt:255-500）：
    //   · 选项尾巴 `,{"webView":true}`（或 `,{"webJs":"…"}`）→ 走渲染器（取 JS 执行后的 DOM）；
    //   · `webJs` / 选项内 `js` → 注入脚本（仅 CDP 渲染层支持，dump-dom 层忽略并记录）；
    //   · POST + webView：Legado 先做 POST 再把 html 交给 WebView——服务端退化为直接渲染 URL。
    const wantWebView =
      (typeof reqOpts?.['webView'] === 'string'
        ? !/^(false|0)$/i.test(String(reqOpts['webView']))
        : Boolean(reqOpts?.['webView'])) || typeof reqOpts?.['webJs'] === 'string';
    const webJs = typeof reqOpts?.['webJs'] === 'string' ? (reqOpts['webJs'] as string) : '';
    // Legado 的 retry 语义（OkHttpUtils.kt:29-44 `newCallResponse`）：
    //   · 次数 = UrlOption.retry，**默认 0**（`AnalyzeUrl.kt:121 retry=0`，`getRetry()` 缺省 0）；
    //   · 仅当响应**非 2xx/3xx** 时才重试；网络异常（`await()` 抛 IOException）**直接抛出，不重试**。
    // 旧实现正好相反：网络异常无条件重试一次、HTTP 错误状态不重试。后果是**单请求最坏 25s×2=50s**，
    // 超过任何客户端预算 → 客户端先超时、服务端还在跑 → 「超时」既无法归因也不可复现
    // （实测：557 源基线里 68 处网络 TIMEOUT，多数落在客户端预算边界）。语料 484 源里 `retry` 使用 0 处，
    // 即**全部源都应走默认 0 次**。
    const retryTimes = Math.max(0, Math.trunc(Number(reqOpts?.['retry'] ?? 0) || 0));
    /**
     * **类CF（`#639`）** `data:` URI 短路（上游 `AnalyzeUrl.kt:680-693` `getByteArrayIfDataUri`）：
     * ```kotlin
     * val dataUriRegex = Regex("^data:.*?;base64,(.*)")   // AppPattern.kt:20
     * private fun getByteArrayIfDataUri(): ByteArray? {
     *     if (!urlNoQuery.startsWith("data:")) return null
     *     return Base64.decode(regex.find(urlNoQuery)!!.groupValues[1], Base64.DEFAULT)
     * }
     * ```
     * **命中就完全不发网络** —— 这段字节直接当响应体（`type` 存在时再由上面的分支转成 hex）。
     *
     * ⚠️ **只在字节路径短路**（`bodyAsHex`，即 URL 选项有 `type`）：上游 `getByteArrayIfDataUri`
     * 只被 `getByteArrayAwait` / `getInputStreamAwait` 调用；**字符串路径 `executeStrRequest`
     * 没有任何 data: 判断**，照旧走 OkHttp。把短路放宽到所有 data: URL 会改变
     * 「无 type 的 data:」的行为（`#588` / `#578` 那两条回归锁就是这么发现的）。
     *
     * 为什么要实现：源把「数据」直接编进 URL（`data:;base64,<bookId>`）当**占位**，
     * 真正的取数写在规则里的 `java.ajax(...)`；引擎只要给出一个「有体」的响应即可。
     * 我们的 `fetch('data:...')` 直接抛（Node 不支持 data scheme）⇒ 目录阶段整体失败
     * （书旗听书本地源（同人）：`tocUrl = "data:;base64,ODg1NDY3MA==,{"type":"audio","bookId":"8854670"}"`）。
     */
    const dataUriBody = ((): Buffer | null => {
      // 与上游 `getByteArrayIfDataUri` 的调用面严格一致：**只有字节路径**（有 `type` 选项）。
      // 字符串路径不去碰 data:（上游 `executeStrRequest` 无此判断）——放宽会改变
      // 「无 type 的 data:」语义，`#588`/`#578` 的回归锁会立刻失败。
      if (!bodyAsHex) return null;
      const m = /^data:.*?;base64,(.*)/.exec(url);
      if (!m) return null;
      try {
        return Buffer.from(m[1] ?? '', 'base64');
      } catch {
        return null;
      }
    })();
    for (let attempt = 0; ; attempt++) {
      // 有 `type` → 走「字节 → hex」通道，Legado 里此分支先于 WebView 返回（不做渲染）
      if (dataUriBody && !probe) {
        // 直接给 hex：`type != null` 在上游就是 `HexUtil.encodeHexStr(getByteArrayAwait())`，
        // 一个函数调用出结果，不必先塞二进制再走下面的 hex 转换。
        resp = { status: 200, headers: {}, body: dataUriBody.toString('hex'), url };
      } else if (!bodyAsHex && wantWebView && ctx.webRenderer) {
        // `#658` 用 let：撞盾时宿主过闸通道（renderChallenge）可能换一份更好的 HTML 进来
        let html = await ctx.webRenderer(url, webJs ? { js: webJs } : undefined);
        /**
         * `#643` **渲染层拿到的是过闸/验证页时必须留痕**（aff `www.asianfanfics.com` 实测）。
         *
         * 该源的 `exploreUrl` 全是 `…,{"webView":true}`（11 个分类都带），`bookList` 规则
         * `div.border-b.border-border` 在**真页面上是有的**；问题在更前面一步：
         * 站点挂了 Cloudflare，我们的 dump-dom 渲染器（`buildDumpDomArgs`，刻意不加
         * `--virtual-time-budget`，见 render.ts 的 hash 路由注释）拿到的是
         * `<title>Just a moment...</title>`（28KB，`challenge` 出现 17 次），SPA 根本没加载。
         *
         * ⇒ 列表 0 条，而**没有任何提示**：用户看到的是「卡片没了」，归因只能靠手抓 HTML。
         * 上游没有等价日志（它的 WebView 是真 Chrome，CF 的非交互挑战通常自己能过），
         * 这里是**本仓自有增强**：只加一条 warn，不改行为（不抛错、不重试）。
         */
        /**
         * `#667` **空结果也要进过闸通道**（`#664` 之后这是常态）。
         *
         * `#664` 让渲染层在「只拿到挑战页」时返回 `''`（避免上层把挑战页当成功、再渲染一次）。
         * 但这里原来的条件是 `if (html)` —— 空串直接跳过钩子 ⇒ `resp.status = 0` ⇒
         * 引擎当成网络失败报 `NETWORK@request`，而**过闸/验证窗一次都不会被触发**。
         * 判据改成「没有 HTML，或者 HTML 是挑战页」。
         */
        {
          const ch = isChallengePage(html);
          if (!html || ch.challenge) {
            console.warn(
              `[render] ${html ? `渲染结果仍是过闸/验证页（${ch.via ?? '未知'}）` : '渲染无结果（挑战页已被渲染层判失败）'}⇒ 列表大概率为空：${ctx.sourceId ?? ''} · ${url.slice(0, 110)}`,
            );
            /**
             * `#658` **交给宿主的过闸通道**（先前这一步只留痕，然后就放弃了）。
             *
             * 无头渲染撞盾时，真正的解法是「有头重放 + 必要时让用户人工过验证」——那是宿主
             * `antibotReplay` 的职责，而它挂在 `ctx.http` 上、**管不到 webView 这条路**。
             * 这里把渲染结果回传：宿主返回非空 HTML 就用它（并记一条 trace），返回空 ⇒ 行为与
             * 修前完全一致（不抛错、不重试）。后台任务由宿主自行决定不起有头（`#496`）。
             */
            const hook = ctx.renderChallenge;
            if (hook) {
              try {
                const passed = await hook(url, html, ch.via ?? '');
                if (passed && passed !== html) {
                  ctx.trace?.push?.({ stage: 'request', rule: 'renderChallenge', input: url, output: `过闸返回 ${passed.length} 字节（${ch.via ?? ''}）` });
                  html = passed;
                }
              } catch (e) {
                // 兜底留痕但不影响主流程（与既有「渲染失败不阻断」同口径）
                console.warn(`[render] 过闸通道失败：${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        }
        resp = { status: html ? 200 : 0, headers: {}, body: html, url };
      } else {
        resp = await ctx.http.request(url, httpOpts);
      }
      harvestCookies(ctx, resp);
      const ok = resp.status >= 200 && resp.status < 400;
      if (ok || attempt >= retryTimes) break;
    }
    // `#470②` 探测模式：头已到手，立刻丢弃上游流（否则连接挂着不释放），只留 status/headers
    if (probe && resp.stream) {
      try {
        await resp.stream.cancel();
      } catch {
        /* 已断开 ⇒ 忽略 */
      }
      const rest = { ...resp } as Record<string, unknown>;
      delete rest['stream'];
      resp = { ...rest, body: '' } as unknown as HttpResponse;
    }
    // `type` 分支的正文：原始字节的 hex 串（Legado `HexUtil.encodeHexStr(bytes)`）
    if (bodyAsHex && typeof resp.body !== 'string') {
      resp = { ...resp, body: Buffer.from(resp.body as ArrayBuffer).toString('hex') };
    }
    /**
     * **类CE（`#639`）** URL 选项 `bodyJs`：**响应体后处理**，不是「生成请求体」。
     *
     * ★ 上游依据 `AnalyzeUrl.kt:548-551`（在拿到响应之后、loginCheckJs 之前）：
     * ```kotlin
     * } else if (bodyJs != null) {
     *     val body = evalJS(bodyJs!!, it.body).toString()   // result 绑定 = 原始响应体
     *     StrResponse(it.raw, body)                          // 返回值**替换**响应体
     * }
     * ```
     * 即：`bodyJs` 的**返回值**成为新的响应体；`result` / `java` / `page` / `key` / `source` 等
     * 按 `AnalyzeUrl.evalJS`（`:395-419`）绑定。
     *
     * ## 为什么必须实现（真站取证：书旗听书本地源（同人），用户实测第 4 条）
     * 该源把「取数」塞进 bodyJs，URL 只是个**缓存壳**：
     * ```js
     * var probeUrl = "https://ocean.shuqireader.com/robots.txt";   // 故意选一个稳定 404 的壳
     * url = probeUrl + "?sqPage=" + p + '&sqRefresh=' + sqStamp + ',' +
     *       JSON.stringify({ bodyJs: "var p=1;…; sqListenDiscovery('default','multi',p,false);" });
     * ```
     * `sqListenDiscovery()`（jsLib）自己带签名发真请求，末了 `return JSON.stringify(result)`。
     * 上游：壳返回 404 也没关系，bodyJs 的返回值把响应体换掉 ⇒ 分类页拿到真书单。
     * 我们旧实现**只认 `body` 不认 `bodyJs`** ⇒ 把 404 外壳
     * `{"timestamp":…,"path":"/robots.txt","status":404,"error":"Not Found"}` 直接交给规则解析
     * ⇒ 用户看到的就是「站点返回 robots.txt 404」（其实是**我们回给用户的壳**，不是站点故障）。
     *
     * ## 边界
     *  · `type` 分支（hex）在上游先 return，永不到 bodyJs ⇒ 这里同样跳过；
     *  · WebView 分支上游也在同一 `else` 之外 ⇒ 只对普通 HTTP 响应生效；
     *  · 探测模式（`probe`，只看响应头）跳过，避免重复触发源脚本副作用（与 loginCheckJs 同规矩）；
     *  · 求值失败**保留原始响应体** + 留痕（静默兜底会让下一个排查者重新走一遍本注释）。
     */
    const bodyJsOpt = typeof reqOpts?.['bodyJs'] === 'string' ? (reqOpts['bodyJs'] as string).trim() : '';
    if (!probe && !bodyAsHex && !wantWebView && bodyJsOpt && bodyJsOpt !== 'null' && typeof resp.body === 'string') {
      try {
        const out = await new AnalyzeRule(env).runJs(bodyJsOpt, { result: resp.body });
        const text = out == null ? '' : String(out);
        if (process.env['YUEDU_DEBUG_DETAIL']) {
          // eslint-disable-next-line no-console
          console.log(`[bodyjs] 返回 ${text.length} 字: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
        }
        resp = { ...resp, body: text };
      } catch (e) {
        warnOnce('bodyjs', url, `URL 选项 bodyJs 求值失败（保留原始响应体）：${errText(e)}`);
      }
    }
    // Legado WebBook：每个请求出口都跑 loginCheckJs（「检测书源是否已登录」）
    // `#470②` 探测模式**跳过**：探测只为看响应头，不该重复触发源脚本副作用（loginCheckJs 可能发请求）
    if (!probe) resp = await this.applyLoginCheck(ctx, env, rule, resp, url);
    // 网络护栏把超大响应体截断了 → **必须留痕**（缺陷类T）：否则上层只会看到
    // 「JSON.parse 失败 / 选择器取空」这类看不出原因的症状，被误判成站点或规则问题。
    if (resp.truncated) {
      warnOnce(
        'net-truncated',
        ctx.sourceId,
        `有响应体被网络护栏截断（上限见 YUEDU_NET_MAX_BODY_MB）；` +
          `如需整包请调大该环境变量。首个被截断 URL：${url.slice(0, 140)}`,
      );
    }
    /**
     * `#696` **网络事实回执**（上游每处 `≡获取成功:<url>`，如 `BookList.kt:53` / `BookInfo.kt:39`；
     * 重定向那一对见 `Rss.kt:250-253`）。
     *
     * 为什么它最值钱：`#643` 的「aff 0 卡片」「uu书库 只第一页」最后都卡在**请求层**
     * （撞盾 / 被重定向到验证页 / UA 分流），而信息流里只有 `发现失效` —— 看不出是网络还是规则。
     *
     * `#699` **每跳都打，带真实状态码**：网络层已改成自己跟链（`net/index.ts` 的
     * `fetchOnceInner`），`resp.redirects` 里是 `{status, url, location, target}` 的完整序列。
     * 上游形制（`Debug.kt` 的 `AnalyzeUrl` 分支）就是「一跳一对」：
     * ```
     * ≡检测到重定向(301)
     * ┌重定向后地址
     * └https://www.suduguu.com/wanjie/
     * ```
     * 为什么值钱：「301 永久迁移」与「302 临时跳」对源维护是两件事
     * （前者该改 `bookSourceUrl`，后者可能只是被风控弹到验证页），只看落地地址分不出来。
     * 探测模式（只看响应头、不读体）不打 —— 它不是「获取成功」。
     */
    if (!probe) {
      const landed = resp.url || url;
      for (const hop of resp.redirects ?? []) {
        // ⚠️ 不能借 `dlogField`：它会补一个「获取」前缀（`┌获取重定向后地址`），
        //    上游这一步是 `┌重定向后地址`（`WebBook.kt:584`）—— 形式要逐字对上才好对照。
        dlog(ctx, `≡检测到重定向(${hop.status})`);
        dlog(ctx, '┌重定向后地址');
        dlog(ctx, `└${clip(hop.target, 240)}`);
      }
      /**
       * 兜底：有落地地址变化却**没有**跳跃链 —— 只可能来自 `redirect:'manual'` 之外的
       * 非标准通路（如代理/桩返回改写过的 `url`）。此时如实说明「拿不到码」，
       * 不编数字；正常路径（`redirects` 非空）不会走到这里。
       */
      if ((resp.redirects?.length ?? 0) === 0 && resp.url && resp.url !== url) {
        dlog(ctx, '≡检测到重定向（该通路未提供 3xx 码）');
        dlog(ctx, '┌重定向后地址');
        dlog(ctx, `└${clip(landed, 240)}`);
      }
      dlog(ctx, `≡获取成功:${clip(landed, 240)}`);
    }
    return { resp, url, scriptUrl };
  }

  /**
   * loginCheckJs 响应拦截器（Legado WebBook.kt:75/149/227/327/454 —— search / explore /
   * bookInfo / toc / content 五处出口）。`result` 绑定是 StrResponse（url()/body()/code()/headers()）。
   *
   * 返回语义（对照 Legado `runCatching { … evalJS(checkJs, it) as StrResponse }`）：
   *   - StrResponse  → 替换响应（url / body / code 三处生效）
   *   - 返回 code=500 → Legado 视作「检测失败」信号（`if (it.code() == 500) throw throwable`）→ 抛 ANTI_BOT
   *   - 其它任何返回值（含字符串）→ **保留原响应**
   *     ⚠️ 这里刻意比 Legado 宽容：Legado 对非 StrResponse 会 ClassCastException 并让整个请求失败；
   *     而语料里不少源把「环境探测」脚本塞在 loginCheckJs 里（末表达式是 `java.getStrResponse(...)`
   *     / `java.log(...)` 之类的非响应值），照搬严格语义会把**本来能用的源**打挂。
   *     （曾经把字符串当新 body → 页面被替成 '' → 全源 RULE_PARSE，已回退。）
   *   - 脚本抛错     → 保留原响应 + trace（源大多自带 try/catch；一次检测脚本炸掉整个请求得不偿失）
   */
  private async applyLoginCheck(
    ctx: EngineContext,
    env: AnalyzeEnv,
    rule: CompiledBookSource,
    resp: HttpResponse,
    reqUrl: string,
  ): Promise<HttpResponse> {
    const raw = typeof rule.loginCheckJs === 'string' ? rule.loginCheckJs.trim() : '';
    if (!raw || raw === 'null') return resp;
    const body = typeof resp.body === 'string' ? resp.body : '';
    const sr = makeStrResponse(resp.url, body, resp.status, resp.headers);
    let out: unknown;
    try {
      out = await new AnalyzeRule(env).runJs(raw, { result: sr });
    } catch (e) {
      ctx.trace.push({
        stage: 'request',
        rule: 'loginCheckJs',
        input: reqUrl,
        output: '已忽略，保留原响应',
        error: e instanceof Error ? e.message : String(e),
        ms: 0,
      });
      return resp;
    }
    const parts = readStrResponse(out);
    if (parts) {
      if (parts.code === 500) {
        // Legado 的「未登录/验证未通过」信号 —— 让上层看到明确诊断而不是「0 章」
        throw new EngineError('ANTI_BOT', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: 'loginCheckJs',
          input: reqUrl,
          trace: ctx.trace.tail(20),
          retryable: false,
        });
      }
      const nextBody = typeof resp.body === 'string' ? parts.body : resp.body;
      return { ...resp, url: parts.url || resp.url, body: nextBody, status: parts.code || resp.status };
    }
    // 非 StrResponse 的返回值一律忽略（见函数头注释：宽容策略，避免探测脚本打挂可用源）
    return resp;
  }

  async detail(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedDetail> {
    const timer = ctx.trace.begin('parse', 'detail', req.id);
    try {
      await primeSourceState(ctx);
      await primeJsLibCached(ctx, rule.jsLib); // #607：jsLib 落盘（内存→磁盘→网络），避免每次都同步 curl 60s
      const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, rule);
      const payload = readPayload(req.id);
      let bookUrl = payload.bookUrl ?? (typeof req.id === 'string' ? req.id : '');
      if (!bookUrl) {
        throw new EngineError('SOURCE_INVALID', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: 'bookUrl',
          input: req.id,
          trace: ctx.trace.tail(20),
          retryable: false,
        });
      }
      /**
       * `#588` **book.name 必须能回落到 payload 里的书名**（HentaiCosplay「目录 0」的根治点）。
       *
       * 病征链（用户 10-23 实测「未取到目录（源没有产出章节）」、无 tocError）：
       * 该源搜索规则把 bookUrl 造成 `data:;base64,<href>,{"type":""}` ⇒ detail 抓到的是
       * href 的 hex（#578 已对齐上游 `type != null` 语义）⇒ `init` 的
       * `baseUrl.slice(0,4)==="http"` 不成立 ⇒ 走 else 返回**空** ⇒ 书名/封面/tocUrl 全空；
       * 目录脚本 `[{name: book.name, url: …}]` 的章名于是为空 ⇒ 被
       * `if (!ct) continue` 静默滤掉 ⇒ **0 章且不报错**（正是最难分的形状）。
       *
       * 上游语义：Legado 的 `Book.name` 来自**搜索结果**，详情 init 只在非空时覆盖
       * （`BookInfo.kt:68-73`）；而我们前端 `runAction(src,'detail',{id})` **从不传
       * `req.title`**（只传 id 里的 payload）⇒ `book.name` 恒 undefined。
       * 修法：`req.title` 优先，回落 **payload.name/title**（搜索/发现组装的 payload 一直
       * 带着 `name`；书架流的 payload 也是从搜索沉淀的）⇒ 与上游「书名来自搜索」对齐。
       */
      const payloadBookName =
        typeof (payload as { name?: unknown }).name === 'string'
          ? String((payload as { name: string }).name)
          : typeof (payload as { title?: unknown }).title === 'string'
            ? String((payload as { title: string }).title)
            : undefined;
      // book 实体桩（源脚本 book.bookUrl 拼章节链接依赖；Legado bindings["book"] = book）
      // `#592` 带上 `type`（见 {@link bookTypeOf}）：目录脚本里读 `book.type` 的源也靠它。
      env.bookData = { bookUrl, name: (req as { title?: string }).title ?? payloadBookName, type: bookTypeOf(rule) };

      // Legado WebBook.kt:281-293 runPreUpdateJs：目录更新前脚本。
      // 该 AnalyzeRule 实例**不带 content**（Legado 新建 AnalyzeRule(book, source, preUpdateJs=true)），
      // 故这里在详情页请求之前执行；失败只记日志、不阻断目录。
      {
        const preUpdateJs = typeof (rule.ruleToc || {}).preUpdateJs === 'string' ? ((rule.ruleToc || {}).preUpdateJs as string).trim() : '';
        if (preUpdateJs && preUpdateJs !== 'null' && !this.preUpdateRan.has(ctx)) {
          this.preUpdateRan.add(ctx);
          try {
            env.javaExtra = Object.assign(env.javaExtra ?? {}, {
              // Legado：refreshTocUrl/reGetBook 会重跑详情/搜索更新 tocUrl；
              // 我们每次 detail 都是新鲜抓取（且同页解析无重复加载必要，对齐 isFromBookInfo 跳过分支）→ 空实现
              refreshTocUrl: () => '',
              reGetBook: () => '',
            });
            env.fromBookInfo = true; // Legado bindings["fromBookInfo"]
            // 走 AnalyzeRule.runJs：带 book/source/java 等全套 bindings（Legado evalJS(preUpdateJs)）
            await new AnalyzeRule(env).runJs(preUpdateJs);
          } catch {
            // Legado 同样只记日志（AppLog.put）
          }
          // 脚本可改写 book.bookUrl（换域名，如爱丽丝书屋）——book 是活对象，改写生效
          const rewritten = typeof env.bookData?.bookUrl === 'string' ? env.bookData.bookUrl.trim() : '';
          if (rewritten && rewritten !== bookUrl) bookUrl = rewritten;
        }
      }

      // 详情页（bookUrl 支持 ,{options} 尾巴与 js 构造，统一走请求构造器）
      const { resp, scriptUrl } = await this.fetchRuleUrl(ctx, env, rule, bookUrl, {});
      /**
       * **原始响应内容**（未过 `ruleBookInfo.init`）。
       *
       * 为什么必须单独留一份：Legado 里 `BookInfo` 与 `BookChapterList` 是**两个独立阶段**，
       * 各自持有自己的内容 —— 详情页规则跑 `ruleBookInfo.init`，目录阶段则重新取
       * `book.tocUrl.ifEmpty { book.bookUrl }` 的响应再跑 `ruleToc.init`。
       * 我们早期让目录阶段复用 init 改写后的内容，导致「init 与 chapterList 是同一段解密脚本」
       * 的源二次解密必然失败（实测：全免漫画 chapterList 对已解密的 JSON 再取 `$.data` → 0 章）。
       */
      const rawContent: unknown = parseResponse(resp).content;
      let content: unknown = rawContent;
      // Legado 给脚本的 baseUrl 是 `analyzeUrl.url`（**未编码**原始串，见 scriptUrl 注释）
      ctx.variables.set('baseUrl', scriptUrl ?? resp.url);
      env.baseUrl = scriptUrl ?? resp.url;
      env.bookData = { ...env.bookData, bookUrl };

      const info: RuleBookInfo = rule.ruleBookInfo || {};
      const ar = new AnalyzeRule(env).setContent(content, scriptUrl ?? resp.url);
      const dbg = process.env['YUEDU_DEBUG_DETAIL'] ? makeDetailDebug(ctx.sourceId) : undefined;
      // Legado BookInfo.kt:58 —— init 规则先行执行，其返回值替换后续规则的求值内容
      // （book4 类源：init 从页面挖出 book={...} JSON 返回，后续 $.author/$.dir 全对这个 JSON 求值）
      const initRule = typeof info.init === 'string' ? info.init.trim() : '';
      if (initRule) {
        try {
          /**
           * ⚠️ **必须走 `getElement`，不能走 `getElements()[0]`**（`#309`：修 JSONPath 列表规则时打断的调用点）。
           *
           * 上游 `BookInfo.kt:58-62` 就是 `setContent(analyzeRule.getElement(it))` ——
           * `getElement` 走 `getAnalyzeByJSonPath.getObject(rule)` = `ctx.read(rule)`（`AnalyzeByJSonPath.kt:128`），
           * **对象/标量都能命中**；而 `getElements` 走 `getList` = `ctx.read<List<Any>>`，**非数组抛异常 → 空**。
           *
           * 实测影响面（语料 23 个带 `init` 的源，`tmp/scan-init.txt`）：
           *   · 🥝猕猴桃漫画 `init = "$.data"`、松鹤庭沐·言璃版 `init = "$.data.bookInfo"` —— **两个源直接坏**：
           *     init 恒空 → `name/author/tocUrl` 退化成对**原始响应**求值 → 详情空、目录 0 章（静默）。
           *   · 其余 21 个是 JS/CSS 形态，两条入口行为一致（`toList` 对非数组只做一层包装）。
           * 回归锁：`src/__tests__/toc-init-isolation.test.ts`（`$.comic_name` 那条）。
           */
          const initRaw = await ar.getElement(initRule);
          /**
           * ⚠️ **必须字符串化 String 包装对象**（2026-09-22 修，#110 用户可见）。
           *
           * 对齐 Legado：`BookInfo.kt:62` 是 `analyzeRule.setContent(analyzeRule.getElement(it))`，
           * 而 Legado 的 `java.ajax(...)` 返回 **String** —— 所以那里的 init 值天然是字符串。
           *
           * 我们的 `java.ajax` 返回 **StrResponse**（`new String(body)` + `.body()/.code()` 等方法，
           * 见 `makeStrResponse`）。它是一个 **String 包装对象**：直接 `setContent(对象)` 之后，
           * 后续 `$.book_info.id` 之类的 JSONPath 会在这个"对象"上找 `book_info` → 取不到 → **静默空**。
           *
           * 实测（⚡📂灯读文学）：`init` 是 `$.data.book_info_link\n@js:java.ajax(result)`，
           * 拿到的 CDN JSON 里 `book_info.id = 10663`，但 `tocUrl` 求值出 `.../chapter/index?bid=`
           * （**bid 空**）→ 目录页拿到「小说已下架」→ 目录 0 章。
           * 单元层 `{{$.book_info.id}}` 在同结构 JSON 上本来能取到 10663（`tmp/probe-jsonpath.mts` ⑥）。
           *
           * ⚠️ 边界：只有 **String/String 包装** 才取字符串内容；**真正的对象**（如 🔞Linpx 的
           * `@js:objParse(...)` 返回 JS 对象）必须原样保留 —— 它本身就是后续规则的 JSON 文档。
           */
          const initVal: unknown =
            initRaw == null
              ? ''
              : typeof initRaw === 'string' || initRaw instanceof String
                ? String(initRaw)
                : initRaw;
          dbg?.('init', initRule, initRaw, initVal);
          /**
           * 调试补充（仅 `YUEDU_DEBUG_DETAIL`）：把 init 的**第一段**单独求值一次。
           *
           * 为什么需要：init 常见形态是「取一个 URL（段1）+ java.ajax 它（段2）」，
           * 而「请求发去了错误的 URL」这种故障，光看段2 的返回值看不出是哪一段坏了。
           * 实测（#110 灯读文学）：段2 请求的是
           * `https://s30007.zhongyue001.com/book/htmlhead/headbodyhttps://cdn.…` ——
           * **绝对 URL 被拼上了前缀**，所以段1 必须单独看一眼。
           */
          if (dbg && initRule.includes('@js:')) {
            const firstSeg = initRule.split('@js:')[0]?.trim() ?? '';
            if (firstSeg && firstSeg !== initRule) {
              dbg('init:段1(isUrl=true)', firstSeg, undefined, ar.syncGetString(firstSeg, true));
              dbg('init:段1(isUrl=false)', firstSeg, undefined, ar.syncGetString(firstSeg, false));
              // 段2 里 `result` 到底是什么？（复合规则的段间传递是本条的关键）
              const probeRule = `${firstSeg}\n@js:JSON.stringify({t: typeof result, len: String(result).length, head: String(result).slice(0, 130)})`;
              dbg('init:段2看到的result', probeRule, undefined, ar.syncGetString(probeRule));
            }
          }
          if (initVal !== '' && initVal != null) {
            content = initVal;
            ar.setContent(initVal, scriptUrl ?? resp.url);
          }
        } catch (e) {
          // init 失败沿用原内容（后续规则仍按页面解析）
          dbg?.('init', initRule, undefined, `(抛错，沿用原内容) ${errText(e)}`);
        }
      }
      const title = await ar.getString(info.name ?? '');
      /**
       * **书名回填到 book 实体**（2026-09-23 修，缺陷类AL）。
       *
       * 对齐 Legado 的数据流：`BookChapterList.kt:200` 用的 AnalyzeRule 是
       * `AnalyzeRule(book, bookSource, …)` —— 传进去的 `book` 是**已被 BookInfo 填好字段**的实体。
       * 所以目录规则里的 `<js>… book.name …</js>` 拿到的是**刚解析出的书名**。
       *
       * 我们此前只在**抓详情页之前**设过 `env.bookData = { bookUrl, name: req.title }`
       * （上面 2088 行附近），而 `req.title` 在真实调用里几乎总是空的（搜索/发现页给的 payload
       * 用的是 `name` 键），于是目录脚本里 `book.name` 恒为 `undefined`。
       *
       * 实测症状（🎨51漫画「单章目录 0 章」）：源的目录回退分支
       * `[{ title: book.name, url: java.getString(".btn-read@href", src) }]` 产出
       * `{"url":""}`（**连 `title` 键都没有** —— `JSON.stringify` 丢掉 undefined），
       * 而 `toc.chapterName = "$.title"` 求值为空 ⇒ 被 `if (!ct) continue` 滤掉 ⇒ 0 章。
       * 引擎内探针实测的中间态就是 `el={"url":""}`。
       */
      if (title) env.bookData = { ...(env.bookData ?? {}), name: title };

      /**
       * 详情字段的**逐字段隔离**（对齐 Legado `BookInfo.kt:84-152` 的 try/catch 边界）。
       *
       * Legado 只把 **kind / wordCount / lastChapter / intro / coverUrl** 各自包在 try/catch 里
       * （`name` / `author` / `init` **不包**），字段内部报错**只让该字段为空**，不影响其它字段，
       * 也不让整条详情失败。我们此前没有隔离 → **任一字段抛错就让整个详情挂掉**。
       * 实测（🎨快看漫画）：`ruleBookInfo.wordCount` 的 @js 里 `result.match(/__NUXT__…/)` 返回 null
       * → `[0]` 抛错 → 整条详情失败；而书名/作者/简介/最新章节本来都取到了（用户可见症状＝"详情空"）。
       *
       * ⚠️ 边界必须与 Legado 一致：**不要把 name/author 也包进来** —— 那会把"源规则彻底写错"
       * 掩盖成"字段为空"，与参考实现的行为分叉（宁可显式失败）。
       */
      const field = async (label: string, ruleStr: string, isUrl = false): Promise<string> => {
        const rs = (ruleStr ?? '').trim();
        if (!rs) return '';
        try {
          const v = await ar.getString(ruleStr, isUrl);
          dbg?.(`field:${label}`, ruleStr, undefined, v);
          return v;
        } catch (e) {
          warnOnce(
            `bookinfo:${label}`,
            ctx.sourceId,
            `详情字段「${label}」求值失败，已留空（不影响其它字段）：${errText(e)}`,
          );
          return '';
        }
      };
      const kindStr = await field('kind', info.kind ?? '');
      /**
       * 简介归一化（Legado `BookInfo.kt:123-133`）：
       * `<usehtml>` / `<md>` / `<useweb>` 开头 → **原样保留**（UI 负责渲染，如 ②米读小说那张 HTML 卡片）；
       * 其余 → `formatIntro`（剥标签、块级标签还原换行、`&nbsp;` 变空格）。
       * 修的是用户实测 ④（51漫画 `.comic-cate-intor@html` → 简介里留着一整段 `<div class=…>`）
       * 与 ⑤（多源简介换行被吞）。
       */
      const introStr = normalizeIntro(await field('intro', info.intro ?? ''));
      const coverStr = await field('coverUrl', info.coverUrl ?? '', true);
      const lastChapterStr = await field('lastChapter', info.lastChapter ?? '');
      const wordCountStr = await field('wordCount', info.wordCount ?? '');
      /**
       * `#696` 作者：本来在 `baseDetail` 对象里 `await ar.getString(...)`，提到这里只是为了
       * 按上游的**打印顺序**（书名→作者→分类→字数→最新章节→简介→封面→目录链接，
       * `BookInfo.kt:67-137`）回执。求值时机不变（仍在目录阶段之前、用的还是详情页那个 `ar`）。
       */
      const authorStr = (await ar.getString(info.author ?? '')) || '';
      dlogField(ctx, FIELD_LABEL.name!, title);
      dlogField(ctx, FIELD_LABEL.author!, authorStr);
      dlogField(ctx, FIELD_LABEL.kind!, kindStr);
      dlogField(ctx, FIELD_LABEL.wordCount!, wordCountStr);
      dlogField(ctx, FIELD_LABEL.lastChapter!, lastChapterStr);
      dlogField(ctx, FIELD_LABEL.intro!, introStr);
      dlogField(ctx, FIELD_LABEL.coverUrl!, coverStr);

      const toc: RuleToc = rule.ruleToc || {};

      // tocUrl 二次请求（Legado：tocUrl 非空且 ≠ bookUrl 时单独抓目录页；支持 js/插值/options）
      // `$.x` / `$[x]` 形式：先按规则对（init 后的）内容求值出真实 URL——对齐 AnalyzeUrl 的 RuleUrlModel
      const tocUrlRule = typeof info.tocUrl === 'string' ? info.tocUrl.trim() : '';
      // Legado：tocUrl 按**规则链**求值（BookInfo.kt: analyzeRule.getString(tocUrl, isUrl=true)）——
      // 支持 css@attr##正则##替换、$.jsonpath、@js/<js>；仅当整串就是 URL/模板时走模板路径
      let tocUrlResolved = tocUrlRule;
      // ⚠️ **2026-09-21 修（缺陷类 Q 的引擎侧一半）**：旧守卫「以 `{{` 起头就跳过规则链」把
      // `{{baseUrl}}##$##d1.html` 这类**以占位符起头、但带 `##` 替换段**的规则误判成「纯 URL 模板」，
      // 于是整串（含 `##`）被当 URL 去请求 → 目录页 404/拿到详情页 → 章节 URL 脏 → 正文解密失败。
      // 判据修正：**含 `##` 一律按规则链求值**（纯 URL 模板不会带 `##`）。
      // 语料同族 9 处：📂书文小说 `{{baseUrl}}##$##d1.html` · ⚡📂第九中文网 `##$##1_desc.html` ·
      // ⚡📂清风小说网 `##$##1/desc.html` · ⚡📂笔趣阁 `##/$##_1/` · ⚡📂心动小说 `##(.*?)www(.*)##$1m$2` …
      //
      // ★★ **类BS（2026-09-28 修）**：以 `http(s)://` 或 `/` 起头、**却含 `interpUrl` 处理不了的占位符**
      //    的规则也必须走规则链 —— `interpUrl` **只认 `{{}}`**（见本文件 :899 的 `/\{\{[\w\W]*?\}\}/g`），
      //    所以 URL 中间的 `@get:{…}` / `@put:{…}` / `@js:` / `<js>` 会被**原样发出**。
      //    实测（⚡📂️咪咕阅读，`ruleSearch.wordCount = '@put:{bid:$.bookId}'` 先 put、详情再取）：
      //    ```text
      //    规则 = https://n.cmread.com/nap/p/catalogForWap.jsp?cm=0000&bid=@get:{bid}&order=0&bid=@get:{bid}&order=0
      //    实测 = [detail] field:tocUrl out= 规则原文（`@get:{bid}` 未替换）；[url-in] == [url-out]
      //    ⇒ 站点拿不到 bid ⇒ 目录 0 章（`#111` 的原文档把它记成「bid 从哪 put 的待查」，是误判：
      //      `[put] bid = 354235511` 本来就正常）
      //    ```
      //    ⚡📂17k小说 `https://h5.17k.com/list/@get:{id}.html` 同族。语料 **2 源**。
      //    Legado 对照：`BookInfo.kt:157` 是**无条件** `analyzeRule.getString(tocUrl, isUrl = true)`，
      //    而 `AnalyzeRule.kt:699-730` 用 `evalPattern` 把规则串里**任意位置**的占位符都切成 token 求值。
      //    ⚠️ 刻意**不含 `{{` 起头**的规则：那类交给 `interpUrl` 更稳妥（它的 bindings 更全）；
      //    且**纯 URL 走 `getString` 会返回空串**（已锁进 `tocurl-rule-chain.test.ts`）——这是守卫存在的理由。
      //
      // ★★ **`#149`（2026-09-29 修）**：把 **`@js:` / `<js>`** 也纳入 —— URL 形状的 tocUrl 里带
      //    JS 片段的形态**确实存在**，且过去被这道守卫原样下发（`<js>…` 被当成 URL 的一部分）。
      //    ⚠️ 原先排除它的理由是「实测走规则链会返回**空串**」——**那个实测是拿 `<js>""</js>`
      //    这种人造样例做的**（JS 返回空串 ⇒ 空 URL，属**正确**行为），并不能推广到真实形态。
      //    2026-09-29 用语料里三条**真实规则**复测（`tmp/probe-149-tocurl-js.mts`）：
      //      · ⚡📂魔丸小说 `/api/book/chapters?source={{$.data.source}}…\n<js>…base64Encode(result)…</js>`
      //        ⇒ 解出 `data:;base64,…`（base64 内是**已把 `{{}}` 替换好的**原始 URL）✅
      //      · 🎨拷贝漫画 `https://api.mangacopy.com/api/v3/comic/{{$..path_word}}\n<js>…</js>`
      //        ⇒ 解出 `…/comic/abc-def/group/default/chapters?limit=100&offset=0` ✅
      //      · ⚡📂若夏 `//*[@property='og:novel:read_url']/@content@js:result.replace('/book/','/chapter/')`
      //        ⇒ 解出 `/chapter/7788/` ✅（这条原本也被误判成「纯 URL」）
      //    语料合计 **3 源**（`tmp/scan-149-candidates.mjs` 按此形态筛）。
      //    对照仍成立：纯 URL（无这些标记）走 `getString` 依旧是空串 ⇒ **不进本分支**。
      //
      // ★★ **2026-10-16 对齐上游（爱奇小说网_ST「App 能取目录、我们不能」）**：
      //    上游 `AnalyzeRule.kt:672` —— **`/` 开头的规则一律是 XPath**（「特征很明显，无需识别标头」），
      //    `tocUrl=/index.html` 走 XPath 求值 ⇒ 根下无该子元素 ⇒ **空** ⇒
      //    `getString(isUrl=true)` 的回退（`AnalyzeRule.kt:387` `str.isBlank() ⇒ baseUrl`）⇒
      //    `book.tocUrl = baseUrl`（详情页）+ `book.tocHtml = body`（BookInfo.kt:159 直接拿详情页取目录）
      //    ⇒ **App 能拿到目录**。我们此前把「`/` 开头且无占位标记」当**纯 URL** 原样请求了站点首页
      //    ⇒ 目录 0 章。⇒ 把 `/` 开头从「纯 URL」判据中移除（它进规则链；求值空 ⇒ 用详情页，
      //    与上游 `if (book.tocUrl.isEmpty()) book.tocUrl = baseUrl` 同语义，代码下方已实现）。
      const tocUrlNeedsRuleChain =
        /^(https?:\/\/|\/)/.test(tocUrlRule) && /@get:\{|@put:\{|@js:|<js>/i.test(tocUrlRule);
      const tocUrlIsRuleText =
        tocUrlRule.includes('##') ||
        tocUrlNeedsRuleChain ||
        tocUrlRule.startsWith('/') || // ★ 上游：`/` 开头 = XPath 规则，不是 URL 字面量
        !/^(https?:\/\/|\{\{)/.test(tocUrlRule);
      if (tocUrlRule && tocUrlRule !== 'null' && tocUrlIsRuleText) {
        try {
          tocUrlResolved = (await ar.getString(tocUrlRule, false)).trim();
          dbg?.('tocUrl', tocUrlRule, undefined, tocUrlResolved);
          tocUrlResolved = tocUrlResolved ? (resolveUrl(resp.url, tocUrlResolved) ?? tocUrlResolved) : '';
        } catch (e) {
          dbg?.('tocUrl', tocUrlRule, undefined, `(抛错) ${errText(e)}`);
          tocUrlResolved = '';
        }
      } else if (tocUrlRule) {
        dbg?.('tocUrl', tocUrlRule, undefined, tocUrlRule);
      }
      // `#696` `┌获取目录链接` / `└…`（上游 `BookInfo.kt:158-165`：目录链接为空 ⇒ 用详情页本身）
      dlogField(ctx, FIELD_LABEL.tocUrl!, tocUrlResolved || '（同详情页）');
      /**
       * ★ **把解析后的 tocUrl 回填到 `book`**（缺陷类AU，2026-09-24）。
       *
       * Legado `BookInfo.kt:157-158`：
       * ```kotlin
       * book.tocUrl = analyzeRule.getString(infoRule.tocUrl, isUrl = true)
       * if (book.tocUrl.isEmpty()) book.tocUrl = baseUrl
       * ```
       * 也就是说 `book.tocUrl` 是 **Book 的标准字段**，目录/正文章节的 `@js` 规则可以读它。
       * 我们此前只在需要抓目录页时**局部**算出 `tocUrlResolved`，从未回填 `env.bookData`
       * ⇒ 依赖它的源全部静默走错分支。实测（🔊书音M，音频源）：
       * ```js
       * var u=(typeof book!=='undefined'&&book&&book.tocUrl)?String(book.tocUrl):String(baseUrl||'');
       * var m=u.match(/id=(\d+)/); var wid=m?m[1]:'';        // ← book.tocUrl 缺失 ⇒ wid=''
       * …'act=wapseries&id='+wid+'&mod=movie&movieId={{$.id}}…'   // 请求 URL 变成 `id=`
       * ```
       * ⇒ 站点回 `{"code":0,"data":[],"message":"参数错误"}` ⇒ **正文 0 段 / 「未取到媒体地址」**。
       * 回填后 `id=116759` 正常，章节链接可解。
       *
       * ⚠️ **必须回填「实际使用的 URL」而不是 `tocUrlResolved` 原文**：当 `ruleBookInfo.tocUrl` 是
       * `https://…&id={{$.data.detail.id}}&…` 这种**模板**时，`tocUrlResolved` 保持**未替换**的原文
       * （模板展开发生在 `fetchRuleUrl` 内部），拿它去 `match(/id=(\d+)/)` 一个数字都取不到
       * —— 本修复的第一版就踩了这个坑（`id=` 仍为空）。所以放在**抓取之后**用 `tocBaseUrl`。
       *
       * ⚠️ 顺序：必须在**章节循环之前**（`chapterUrl` 脚本要用）。
       */
      // ⚠️ 目录阶段的起点是**原始响应**（不是 init 改写后的 content）——理由见 rawContent 注释。
      // Legado BookChapterList 会重新取 `tocUrl || bookUrl` 的响应；我们已有同一份响应体，无需二次网络请求。
      let tocContent: unknown = rawContent;
      let tocBaseUrl = scriptUrl ?? resp.url;
      if (tocUrlResolved && tocUrlResolved !== 'null' && tocUrlResolved !== bookUrl) {
        try {
          const built = await this.fetchRuleUrl(ctx, env, rule, tocUrlResolved, { content });
          tocContent = parseResponse(built.resp).content;
          tocBaseUrl = built.scriptUrl ?? built.resp.url;
          ctx.variables.set('baseUrl', tocBaseUrl);
          env.baseUrl = tocBaseUrl;
        } catch {
          // 目录页抓取失败回退详情页找章节
        }
      }
      // ★ 见上方注释块：把**实际使用的目录页 URL** 回填到 `book.tocUrl`（Legado BookInfo.kt:157-158）。
      //   放在抓取之后 —— 模板形态（`{{$.x}}`）只有到这里才是展开后的真 URL。
      env.bookData = { ...(env.bookData ?? {}), tocUrl: tocBaseUrl || resp.url };

      /**
       * ## 目录阶段（`#161`：**必须与详情字段隔离**）
       *
       * 上游依据：`BookInfo.kt`（书籍信息）与 `BookChapterList.kt`（目录）在 Legado 里是
       * **两次独立调用**（`WebBook.kt:200 getBookInfoAwait` / `WebBook.kt:295 getChapterListAwait`
       * 各自返回自己的 `Result`）⇒ **目录挂了只影响目录**，`book` 实体上已经写好的
       * 书名/封面/简介/字数照样可用。
       *
       * 我们此前把两段写在同一层 try 里 ⇒ 目录规则一抛错，整条 `detail` 变
       * `RULE_PARSE@parse`、字段一个都不下发。用户可见症状＝**「详情空 + 目录 0」**，
       * 完全看不出「字段其实已经取到了」。
       * 实测（🔞Linpx 系列小说，2026-09-29 `tmp/r161/server.log`）：
       * ```text
       * [detail] … field:wordCount: rule=textCount ⇒ out=12102      ← 字段全有值
       * [detail] … tocUrl: rule=catalogUrl ⇒ out=…/pixiv/series/16165083/cache
       * [ajax] ← 200 len=14 | {"error":true}                        ← 系列内某篇已被作者删除
       * ⇒ 接口 error=RULE_PARSE@parse、chapters=0                    ← 上面的 12102 字被一起吞了
       * ```
       * 源侧那一步确实是它自己的 TypeError（`#147` 已定性），但那**不该殃及详情字段**。
       *
       * 因此这里把**整个目录段**（含 `collect` / `nextTocUrl` / 去重 / `formatJs`）包成
       * 一个可失败的单元：失败 ⇒ `chapters` 返回**空数组**、书籍信息照常、原因写进
       * `result.tocError` 并 `warnOnce` 留痕（铁律 4：兜底必须留痕，**不静默**）。
       *
       * ⚠️ 与上游的一处**刻意分叉**：Legado 在 `chapterList.isEmpty()` 时抛
       * `TocEmptyException`（`BookChapterList.kt:121-123`），我们**不**把「0 章」当失败 ——
       * 语料里 0 章有成因（站点改版、需要登录、长尾缺陷…），把它变成错误会改变全量基线的
       * 成败口径（那是 `#150` 的工作面）。这里只收「**抛异常**」这一种。
       *
       * ⚠️ 段落本身**不保留半截结果**（对齐上游：`analyzeChapterList` 一抛就是整体失败）——
       * 半截目录看起来像完整目录，比「空 + 明确原因」更危险。
       */
      /**
       * `#768` **页 2+ 失败不许静默**：页 1 的章照常返回，但「后面还有页没采到」必须留痕。
       *
       * 实测（2026-11-04 速读谷 `https___www.suduguu.com_`）：用户先拉哔咔 40 张封面、再点
       * 《灵境行者》详情 ⇒ 页 1 求值墙钟 30.54s、界面只有 999 章（真实目录 999+51=1050）。
       * 原实现两处 `catch → break / return null` **一个字都不打**，于是「页 2 有没有发、为什么没发」
       * 完全无从判断（`#767` 报告 §6 就是这么卡住的）。
       */
      let tocWarn = '';
      const parseChapters = async (): Promise<UnifiedChapter[] | undefined> => {
        // Legado BookChapterList.kt:53-60：chapterList 前导 `-` = 目录倒序（源站新章在前，需反转）；
        // `+` = 强制正序（虚拟前缀，直接剥掉）
        let listRule = typeof toc.chapterList === 'string' ? toc.chapterList.trim() : '';
        if (!listRule) return undefined;
        let reverse = false;
        if (listRule.startsWith('-')) {
          reverse = true;
          listRule = listRule.slice(1).trim();
        } else if (listRule.startsWith('+')) {
          listRule = listRule.slice(1).trim();
        }
        if (!listRule) return undefined;

        const out: UnifiedChapter[] = [];
        const collect = async (pageContent: unknown, pageBase: string) => {
          const ca = new AnalyzeRule(env).setContent(pageContent, pageBase);
          // `#696` 对齐 `BookChapterList.kt:206-208`：`┌获取目录列表` / `└列表大小:N`（逐页各一对）
          dlog(ctx, '┌获取目录列表');
          const els = await ca.getElements(listRule);
          dlog(ctx, `└列表大小:${els.length}`);
          /**
           * `YUEDU_DEBUG_DETAIL=1`：**目录段留痕**。
           *
           * 为什么必须有：「目录 0 章」有两种完全不同的成因，只看结果分不出 ——
           *   ① 段链取到 0 个元素（选择器/JS 没命中）；
           *   ② 取到了 N 个元素，但 `chapterName` 求值为空 → 被下面的 `if (!ct) continue` 全滤掉。
           * 实测（🎨51漫画）：站点已改版，单章漫画没有「章节目录」JSON-LD 脚本 → 源的 `<js>` 走
           * 回退分支 `[{title: book.name, url: java.getString(".btn-read@href", src)}]`。
           * 不给留痕就只能看见「0 章」而无法区分上面两种。
           */
          if (process.env['YUEDU_DEBUG_DETAIL']) {
            // eslint-disable-next-line no-console
            console.log(
              `[toc] els=${els.length} base=${String(pageBase).slice(0, 90)} rule=${listRule.replace(/\s+/g, ' ').slice(0, 110)}`,
            );
          }
          /**
           * `#480-a` 目录章节求值**有界并发流水线**（2026-10-17）。
           *
           * 为什么：逐章串行 `await` 每章 2~5 次 worker 往返（爱淘 1310 章 ≈ 7.2s）；
           * 微基准证明单次求值本身极便宜（0.06~0.43ms），大头是**串行等待**。
           *
           * ⚠️ 并发必须有界（实测教训）：第一版 `Promise.all` 把 1310×6 个 eval 全量入队，
           * eval 的 10s「纯计算」预算**从提交时刻计时**，池排队等待被算进去 ⇒ 假超时雪崩
           * （JS_TIMEOUT + 拖死后续 category 120s）。有界 8 in-flight 滚动补位：
           * 池 4 worker 吃满、排队深度 ≤8、单 eval 预算不受影响。
           */
          /**
           * `#480-b` 8 → 16：实测（真 worker 池基准，1310 章 × 2 次 JS）并发度在 **16** 时最优
           * （1.54s → 1.41s）；24 反而回退（1.67s）——队列过深把 eval 的排队时间又堆回去。
           * 仍必须**有界**（教训见上：无界 Promise.all 会假超时雪崩）。
           */
          /**
           * `#509` **L1 源必须串行**（用户实测：七猫 712 章目录触发 stall 34s / l1-eval 1216 次）。
           *
           * 为什么 `#480-b` 的 16 并发对 L1 是**负优化**：L1 求值是**同步**的
           * （`createJsEvaluator` 里 `execFileSync`/`new Function` 同步跑完才返回），
           * 所以 16 章 × 最多 6 字段 ≈ **96 个 in-flight 的 Promise 根本不会并行** ——
           * 它们只是在同一根主线程上排队，额外付出「建 96 个闭包 + 调度 + 微任务」的开销，
           * 且**每个 eval 的等待时间被计入**（实测单次 31ms，而 bench 同样的脚本只有 3ms）。
           * 串行反而更快，而且 stall 看门狗看到的是「连续的短求值」而不是「雪崩式排队」。
           *
           * worker 源保持 16（那是真并行，`#480-b` 的 1.54s→1.41s 数据仍成立）。
           */
          /**
           * `#509` 并发度 **16 → 4**（用户实测：七猫 712 章目录 trigger stall 34s / 1216 次 l1-eval）。
           *
           * 为什么降：`#480-b` 的 16 是按 **worker 源**测的（真并行，1.54s→1.41s）；但 **L1 求值是
           * 同步的**（`new Function` + `execFileSync` 当场跑完）⇒ 16 章 × 最多 6 字段 ≈ 96 个
           * in-flight 的 Promise **不会并行**，只是在同一根主线程排队，额外付出闭包/调度开销，
           * 且每个 eval 的排队等待被计入（实测单次 31ms，而 bench 同脚本仅 3ms）。
           *
           * 取 4 而非 1：worker 源仍保留一定并行（4 实测 ≈ 1.6s vs 16 的 1.41s，差 0.2s 可接受），
           * L1 源的 in-flight 从 96 降到 24，调度雪崩消失。可用 `YUEDU_TOC_CONC` 覆盖（调优/回退）。
           */
          /**
           * `#630` **并发度按路由自适应**（`#509` 的 4 不再一刀切）。
           *
           * 判据（`tmp/probe-toc-conc-630.mts`，七猫 1612 章，池 size 4；两组独立测量一致）：
           *  · **worker 路由**（真并行）：空闲机 4 ⇒ 2.23s、16 ⇒ 1.80s、32 ⇒ 1.60s；
           *    本轮配对复测（同进程交替跑，排除冷启动）4 ⇒ 3.09/2.61 ms/章、16 ⇒ 2.61/2.46 ms/章
           *    ⇒ **16 从不差于 4，最好时快 15%**；32 收益已递减 ⇒ 取 **16**。
           *  · **L1 路由**（同步求值，主线程排队）：**提高并发是负优化**，且随并发单调恶化 ——
           *    l1-eval 累计 4 ⇒ 11.8s、16 ⇒ 20.7s、32 ⇒ 26.7s（第二轮 14.6s ⇒ 26.7s 同向）；
           *    墙钟 4 ⇒ 14.2s、16 ⇒ 23.3s、32 ⇒ 29.0s。主线程被占用 2~5 倍，
           *    正是 `#480-a` 当年 stall 34s 的机制 ⇒ **保持 4**。
           *
           * 怎么知道走哪条路：不从规则文本猜（L1 判据散在 4 个分支、会猜错），
           * 而是**跑第 0 章做探测**，读混合求值器的 `__yueduRouteStats` 增量（js.ts 埋点）。
           *
           * ## 安全限制（四条，缺一不可）
           *  ① **显式 `YUEDU_TOC_CONC` ⇒ 完全禁用自适应**，照用旧值（调优/回退通道）；
           *  ② **章数 < 32 不探测**：探测本身要花一次单章求值，短目录不划算 ⇒ 用保守默认；
           *  ③ **拿不到统计**（无混合求值器 / 纯 L1 环境）、或**该章没有 JS 求值**（两个计数都没动，
           *     判定不了）⇒ 按 L1 处理，取 4（最保守）；
           *  ④ **硬顶 `YUEDU_TOC_CONC_MAX`（默认 16）**：即使将来调高 worker 档，也不许超过它，
           *     防止「收益递减但调度开销继续涨」的区间被打开。
           */
          const concMode = parseConcMode(process.env['YUEDU_TOC_CONC']);

          const perChapter: Array<{ ct: string; volRaw: string; urlRaw: string; tagRaw: string; vipRaw: string; payRaw: string }> = new Array(els.length);
          let tocCursor = 0;
          /** 求值**单章**（`#630` 探测要用，必须只跑一章）。 */
          const tocEvalOne = async (i: number): Promise<void> => {
            if (process.env['YUEDU_DBG_TOCNODE'] && i === 0) {
              const n0 = els[0] as unknown as Record<string, unknown> | undefined;
              // eslint-disable-next-line no-console
              console.log('[dbg-tocnode]', JSON.stringify({
                keys: n0 ? Object.keys(n0).slice(0, 10) : null,
                tag: n0?.['tagName'],
                getAttribute: typeof n0?.['getAttribute'],
                attr: typeof n0?.['attr'],
                hasDesc: !!n0?.['__desc'],
                nid: n0?.['__nid'],
                ctor: n0?.constructor?.name,
                hrefAttr: typeof n0?.['attr'] === 'function' ? (n0['attr'] as (k: string) => unknown)('href') : null,
                descAttrs: JSON.stringify((n0?.['__desc'] as { attrs?: unknown } | undefined)?.attrs ?? null).slice(0, 200),
                outerHead: String(n0?.['outerHTML'] ?? '').slice(0, 80),
              }));
            }
            const ea = new AnalyzeRule(env).setContent(els[i] as object, pageBase);
            // `#771`：章循环打点（跨 await，只能用 probePoint；若冻结时 `last=toc:eval` 且 d=0，
            // 说明停摆发生在 6 个 getString 的 await/事件循环里，而不是任何同步段内部）
            probePoint('toc:eval');
            const [ct, volRaw, urlRaw, tagRaw, vipRaw, payRaw] = await Promise.all([
              ea.getString(toc.chapterName ?? ''),
              ea.getString(toc.isVolume ?? ''),
              ea.getString(toc.chapterUrl ?? ''),
              ea.getString(toc.updateTime ?? ''),
              ea.getString(toc.isVip ?? ''),
              ea.getString(toc.isPay ?? ''),
            ] as const);
            perChapter[i] = { ct, volRaw, urlRaw, tagRaw, vipRaw, payRaw };
          };
          const tocEvalWorker = async (): Promise<void> => {
            let sinceYield = 0;
            for (;;) {
              const i = tocCursor++;
              if (i >= els.length) return;
              await tocEvalOne(i);
              /**
               * `#633` **协作让出**：快路（纯表达式）是**同步**执行 —— 上千章连着跑会把主线程
               * 按死几秒（实测 `[stall] ms=5206`，同时别的请求/SSE 全部卡住）。
               * 每 24 章 `setImmediate` 让一次：把最长阻塞压到「24 章 × 单章耗时」
               * （实测 24×0.33ms ≈ 8ms；满载时 ~24×4ms ≈ 100ms），远低于看门狗阈值。
               * 成本：1612 章多 67 次 setImmediate，合计 < 2ms。
               */
              if (++sinceYield >= 24) {
                sinceYield = 0;
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
            }
          };

          const tocT0 = Date.now();
          let decision: TocConcDecision;
          let probeMs = 0;
          if (concMode.kind === 'fixed' || els.length < TOC_ADAPT_MIN_CHAPTERS) {
            // 固定模式（默认）/ 短目录：都不探测（判定规则见 `model/toc-concurrency.ts`）
            decision = resolveTocConc({ mode: concMode, chapters: els.length });
          } else {
            /**
             * 探测（**仅 `YUEDU_TOC_CONC=auto`**）：先跑第 0 章（游标随之进到 1），看它落在哪条路。
             * ⚠️ 必须用 `tocEvalOne`（**单章**）而不是 `tocEvalWorker`（那是整条流水线，会把全部
             * 章节串行跑完 ⇒ 自适应退化成 conc=1，实测比固定 16 慢一倍）；
             * 也必须**串行**跑完再读计数 —— 并发跑会混进别的章的计数。
             */
            const stats = (env.jsEval as unknown as { __yueduRouteStats?: { l1: number; worker: number; fast?: number } })
              ?.__yueduRouteStats;
            const before = stats ? { l1: stats.l1, worker: stats.worker, fast: stats.fast ?? 0 } : null;
            const probeT0 = Date.now();
            await tocEvalOne(tocCursor++);
            probeMs = Date.now() - probeT0;
            decision = resolveTocConc({
              mode: concMode,
              chapters: els.length,
              probe: stats && before
                ? {
                    l1: stats.l1 - before.l1,
                    worker: stats.worker - before.worker,
                    fast: (stats.fast ?? 0) - (before.fast ?? 0),
                  }
                : undefined,
              maxWorkerConc: process.env['YUEDU_TOC_CONC_MAX'],
            });
          }
          const TOC_EVAL_CONC = decision.conc;
          if (process.env['YUEDU_DEBUG_DETAIL']) {
            // eslint-disable-next-line no-console
            console.log(
              `[toc] 选档：${decision.reason} ⇒ conc=${TOC_EVAL_CONC}（章数 ${els.length}，探测 ${probeMs}ms）`,
            );
          }
          const routeBefore = (() => {
            const s = (env.jsEval as unknown as { __yueduRouteStats?: { l1: number; worker: number; fast?: number } })
              ?.__yueduRouteStats;
            return s ? { l1: s.l1, worker: s.worker, fast: s.fast ?? 0 } : null;
          })();
          await Promise.all(
            Array.from({ length: Math.max(0, Math.min(TOC_EVAL_CONC, els.length - tocCursor)) }, tocEvalWorker),
          );
          /**
           * **目录段耗时（常开一行）**：用户报「目录 20~30s」时，cmd 窗口里要能直接看到
           * 目录本身到底花了多少、当前并发档、**以及走的哪条求值路**（L1 同步 / worker 并行）。
           * 阈值 300ms：短目录不刷屏，长目录每本书一行（ 后目录常 <300ms，只在慢时打印）。
           */
          {
            const tocMs = Date.now() - tocT0;
            if (tocMs >= 300) {
              const s = (env.jsEval as unknown as { __yueduRouteStats?: { l1: number; worker: number; fast?: number } })
                ?.__yueduRouteStats;
              // 路由增量：`l1+N` 大 ⇒ 主线程同步求值（并发再高也没用）；`worker+N` 大 ⇒ 真并行
              const route = routeBefore && s
                ? `l1=${s.l1 - routeBefore.l1} worker=${s.worker - routeBefore.worker} fast=${(s.fast ?? 0) - (routeBefore.fast ?? 0)}`
                : 'route=?';
              // eslint-disable-next-line no-console
              console.log(
                `[toc] ${els.length} 章目录 ${(tocMs / 1000).toFixed(2)}s · conc=${TOC_EVAL_CONC} · ${decision.route} · ${route}` +
                  (probeMs ? ` · 探测 ${probeMs}ms` : ''),
              );
            }
          }
          // `#771`：结果组装是**纯同步**的（940 章逐条建对象），独立成一段便于区分「求值慢」与「组装慢」
          probeEnter('toc:assemble');
          try {
          for (const r of perChapter) {
            const ct = r.ct;
            if (!ct) {
              if (process.env['YUEDU_DEBUG_DETAIL']) {
                // eslint-disable-next-line no-console
                console.log(
                  `[toc] 元素 title 为空被滤掉 | nameRule=${String(toc.chapterName ?? '')} | el=${(() => {
                    try {
                      return JSON.stringify(r);
                    } catch {
                      return String(r);
                    }
                  })()
                    .replace(/\s+/g, ' ')
                    .slice(0, 200)}`,
                );
              }
              continue;
            }
            // 卷判定要先于 url（Legado：卷没有真实 url，用 title+index 占位）
            const isVolume = legadoIsTrue(r.volRaw);
            // Legado BookChapterList: bookChapter.url = getString(urlRule)（isUrl=false 取**原始**值，
            // 空值判断才成立）；绝对化统一在抓取时按 redirectUrl 解析 → 这里用当前目录页 pageBase
            let rawUrl = r.urlRaw.trim();
            let chapterUrl: string;
            if (!rawUrl) {
              // Legado BookChapterList.kt:262-276：url 缺失时卷用「标题+序号」占位（Legado 靠
              // url.startsWith(title) 识别卷），普通章节用 baseUrl 兜底——占位符不再做绝对化
              chapterUrl = isVolume ? `${ct}${out.length}` : pageBase;
            } else {
              chapterUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : (resolveUrl(pageBase, rawUrl) ?? rawUrl);
            }
            const tag = r.tagRaw.trim();
            out.push({
              title: ct,
              // payload 带上 title：content 阶段 `chapter.title` / `title` 绑定（Legado AnalyzeRule.kt:902-903）
              payload: { chapterUrl, title: ct, ...(isVolume ? { isVolume: true } : {}) },
              order: out.length + 1,
              ...(isVolume ? { isVolume: true } : {}),
              ...(legadoIsTrue(r.vipRaw) ? { isVip: true } : {}),
              ...(legadoIsTrue(r.payRaw) ? { isPay: true } : {}),
              ...(tag ? { tag } : {}),
            });
          }
          } finally {
            probeLeave();
          }
        };
        await collect(tocContent, tocBaseUrl);

        // Legado BookChapterList：nextTocUrl 用 getStringList 求值（①单 URL → 链式追页；
        // ②URL 数组/多行 → 并发抓取全部页），每项按**当前页**绝对化并去重（对齐 getStringList(isUrl=true)）
        const nextTocRule = typeof toc.nextTocUrl === 'string' ? toc.nextTocUrl.trim() : '';
        if (nextTocRule && nextTocRule !== 'null') {
          const seen = new Set<string>([tocBaseUrl]);
          const fetchPage = async (nextUrl: string, fromContent: unknown): Promise<{ content: unknown; base: string } | null> => {
            try {
              const built = await this.fetchRuleUrl(ctx, env, rule, nextUrl, {
                content: fromContent,
                // `#769` 后续页不被「页 1 已吃光的剩余预算」裁到 1s（见 TOC_PAGE_MIN_TIMEOUT_MS）
                timeoutFloorMs: TOC_PAGE_MIN_TIMEOUT_MS,
              });
              return { content: parseResponse(built.resp).content, base: built.scriptUrl ?? built.resp.url };
            } catch (e) {
              tocWarn = `下一页抓取失败：${nextUrl}（${errText(e)}）`;
              return null;
            }
          };
          let pageContent = tocContent;
          let pageBase = tocBaseUrl;
          for (let i = 0; i < MAX_TOC_PAGES; i++) {
            let list: string[] = [];
            try {
              list = await new AnalyzeRule(env).setContent(pageContent, pageBase).getStringList(nextTocRule);
            } catch (e) {
              tocWarn = `nextTocUrl 求值失败（${String(pageBase).slice(0, 90)}）：${errText(e)}`;
              break;
            }
            const urls = list
              .map((u) => (resolveUrl(pageBase, u.trim()) ?? u.trim()))
              .filter((u) => u && u !== 'null' && !seen.has(u));
            if (!urls.length) break;
            urls.forEach((u) => seen.add(u));

            if (urls.length === 1) {
              // 单页链式：抓下一页 → 继续找它的下一页
              const page = await fetchPage(urls[0] as string, pageContent);
              if (!page) break;
              pageContent = page.content;
              pageBase = page.base;
              env.baseUrl = pageBase;
              ctx.variables.set('baseUrl', pageBase);
              await collect(pageContent, pageBase);
            } else {
              // 多页并发（Legado：else 分支 flow 并发解析）
              // ⚠️ **必须有界**（缺陷类T）：源可能一次给出几十个下一页 URL，`Promise.all` 会
              // 同时开几十个 socket → 路由器 NAT/连接表被打满，**同局域网其它设备一起断网**
              // （2026-09-21 用户实测报告）。上限取 4：与网络护栏（全局 6 / 单主机 2）相乘仍在安全区。
              const pages = await mapLimited(urls, 4, (u) => fetchPage(u, pageContent));
              let added = 0;
              for (const pg of pages) {
                if (!pg) continue;
                const before = out.length;
                await collect(pg.content, pg.base);
                added += out.length - before;
              }
              if (!added) break;
            }
          }
        }
        /**
         * `#643` **「规则在、命中 0 条」必须回空数组，不能回 `undefined`**。
         *
         * 两者在下游完全不同（见 `UnifiedDetail.chapters` / `tocError` 契约注释）：
         *  · `listRule` 为空 ⇒ `undefined` = **源没配目录规则**（合法的"无目录"形态）；
         *  · 规则在但取到 0 条 ⇒ **必须** `[]` = "配了、但没解析出章节"。
         *
         * 旧实现两者都返 `undefined` ⇒ `JSON.stringify` 直接把 `chapters` 键**丢掉**
         * ⇒ 前端收到的是一个**没有 chapters 字段**的详情，既不能显示"目录 0 章"，
         * 也不会走 `tocEmptyHint`/`tocError` 的解释分支 —— 用户看到的就是一页没有目录的详情，
         * 与「源没配目录」完全无法区分。
         *
         * 实测（`#643` 搬山人 `https___www.banshanren.com`）：站点把目录项从
         * `<li class="volume_chapter">` 改成裸 `<li>`，源的 `.chapter_list li.volume_chapter`
         * 命中 0 条 ⇒ 响应里**连 `chapters` 键都没有**。改为 `[]` 后前端可如实提示。
         */
        if (!out.length) {
          // `#696` 上游 `BookChapterList.kt`：目录空 ⇒ 信息流里直接给结论（否则用户只看到「0 章」）
          dlog(ctx, '≡没有正文章节（目录规则命中 0 条，或章名规则全为空）', 'error');
          return [];
        }

        // —— Legado BookChapterList.kt:124-137 对齐 ——
        // ① 无 `-` 前缀先整体 reverse；② LinkedHashSet 去重（index 此时尚未赋值全为 0，
        //    判等等价 url+title+isVolume）；③ book.reverseToc 默认 false → 再 reverse。
        // 两次 reverse 夹一次去重，净效果：
        //   无 `-`：保持解析顺序，每章保留**后出现**的那份（「最新章节预览块 + 完整目录」
        //          场景正确落在完整目录上——目录重复/多匹配的根源就是缺这步去重）；
        //   带 `-`：反转为正序，保留**先出现**的那份。
        const dedupKey = (ch: UnifiedChapter) =>
          `${ch.title}\u0000${(ch.payload as { chapterUrl?: string } | undefined)?.chapterUrl ?? ''}\u0000${ch.isVolume ? 1 : 0}`;
        let ordered = reverse ? out : [...out].reverse();
        {
          const seen = new Set<string>();
          ordered = ordered.filter((ch) => {
            const k = dedupKey(ch);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        ordered.reverse(); // book.getReverseToc() = false（默认）→ 恒 reverse
        out.length = 0;
        for (const ch of ordered) out.push(ch); // 逐个 push（万级章节避免 spread 栈深限制）

        // Legado BookChapterList.kt:139-157：formatJs 逐章格式化标题
        // bindings: index（从 1 开始）/ gInt / title / chapter（章节对象）
        const formatJs = typeof toc.formatJs === 'string' ? toc.formatJs.trim() : '';
        if (formatJs) {
          for (let i = 0; i < out.length; i++) {
            const ch = out[i] as UnifiedChapter;
            try {
              const ret = await env.jsEval(formatJs, {
                index: i + 1,
                gInt: 0,
                title: ch.title,
                chapter: { ...ch, title: ch.title, url: (ch.payload as { chapterUrl?: string })?.chapterUrl },
              });
              const t = ret == null ? '' : String(ret).trim();
              if (t) ch.title = t;
            } catch {
              // 单章格式化失败不影响其他章节（Legado 同样只记日志）
            }
          }
        }
        out.forEach((ch, i) => {
          ch.order = i + 1;
        });
        // `#696` 目录总数（Legado `BookChapterList.kt:134`）
        dlog(ctx, `◇目录总数:${out.length}`);
        return out;
      };
      /**
       * `#512` **info 先落地**（用户建议：目录最耗时，详情拿到就渲染）。
       *
       * 上面 2716-2775 已把 `title / coverStr / introStr / kindStr / lastChapterStr / wordCountStr`
       * 全部求值完毕；目录是**之后的独立阶段**（另建 AnalyzeRule、另抓 tocUrl）。所以这里先把
       * 「只有 info」的详情推给调用方，再继续跑目录 —— SSE 场景前端可立即渲染详情头部。
       *
       * ⚠️ `subtitle`（作者）原先在 return 里 `await`，现在提前到目录之前：它用的 `ar` 是
       * **详情页那份** AnalyzeRule，目录阶段另建实例（见 parseChapters 内注释），不会被改写，
       * 求值结果与旧实现一致。
       * `onPartial` 为 undefined 时这里只多一次对象构造，行为完全不变。
       */
      const baseDetail: UnifiedDetail = {
        id: bookUrl,
        kind: mapKind(rule.bookSourceType),
        // 书名回落链（对齐 Legado BookInfo.kt:68-73）：ruleBookInfo.name 为空**不覆盖**已有书名。
        // 已有书名来自搜索/发现阶段的 payload.name（见 list 阶段注释）。
        // ⚠️ 末位**不能是 bookUrl** —— 大量源没有 ruleBookInfo（或 name 规则为空），
        // 旧实现会让详情页把 bookUrl（常是 chapterList API 链接）当书名显示，用户实测的
        // 「详情页书名变链接 / 阅读页章节名变链接」全都源于此。bookUrl 仅作最后兜底。
        title: title || payload.name || payload.title || bookUrl,
        cover: validCover(coverStr),
        subtitle: authorStr || undefined,
        summary: introStr || undefined,
        tags: kindStr ? splitTags(kindStr) : undefined,
        meta: {
          ...(lastChapterStr ? { 最新章节: lastChapterStr } : {}),
          ...(wordCountStr ? { 字数: wordCountStr } : {}),
        },
        // 封面二次解密（Legado coverDecodeJs）：前端需走服务端代理
        ...(parseImageDecodeSpec(rule.coverDecodeJs) ? { coverDecode: true } : {}),
        raw: content,
      };
      if (ctx.onPartial) {
        try {
          ctx.onPartial(baseDetail);
        } catch {
          /* 推送失败（SSE 已断）不影响主流程：目录该算还是算，完整结果照常返回 */
        }
      }

      // ── 目录失败隔离（`#161`，理由见上方注释块）──────────────────────────────
      let chapters: UnifiedChapter[] | undefined;
      let tocError = '';
      try {
        chapters = await parseChapters();
      } catch (e) {
        tocError = errText(e);
        chapters = [];
        warnOnce(
          'toc:detail',
          ctx.sourceId,
          `目录阶段失败，已保留书籍信息并返回空目录（Legado 里 BookInfo 与 BookChapterList 是两次独立调用，` +
            `目录失败不该抹掉详情字段）：${tocError}`,
        );
      }

      // `#768`：页 2+ 失败 ⇒ 已有章照常返回，但把原因带进 `tocError`（UI 只在目录为空时展示空态，
      // 非空目录不受影响；工作坊诊断 / shelf-updater 能看到「目录可能不全」）。
      if (tocWarn && !tocError) {
        tocError = tocWarn;
        warnOnce('toc:next', ctx.sourceId, `后续目录页失败，已返回已解析章节（目录可能不全）：${tocWarn}`);
      }

      // `#512` 完整结果 = 已推送的 info + 目录（结构不变，普通 JSON 请求与旧实现一致）
      const result: UnifiedDetail = {
        ...baseDetail,
        chapters,
        // 目录阶段失败原因（`#161`）：**仅失败时出现**。目录为空时 UI 必须展示它，
        // 否则用户仍分不清「源没配目录规则（静默空）」和「目录解析炸了（有原因）」。
        // `#768`：页 2+ 失败也走这里（目录可能不全，不是整体失败）。
        ...(tocError ? { tocError } : {}),
      };
      /**
       * 落盘源状态（**含 `@put:{k:v}` / `java.put(k,v)` / `source.setVariable` 的写入**）。
       *
       * ⚠️ **本阶段此前漏了这一步**（2026-09-22 修，缺陷类AG）：
       * `putSharedVariable()` 只把值写进**本次请求**的 `variables`，真正落盘靠 `persistSourceState`。
       * detail 有 `prime` 没有 `persist` ⇒ 详情阶段写的 `bid` 到正文阶段就没了。
       * 实测（🏷七猫[官方]v3.1）：`BookInfo.name = "title@put:{bid:id}"` 在详情阶段确实执行
       * （`[put] bid = 203436`），但 `data/kv.json` 里该源的 `source-var:` 仍是 `{}`；
       * 正文脚本 `java.get("bid")` 拿到空串 → 请求 URL 变成 `.../chapter/content?&id=&chapterId=630355`
       * → 站点返回不含 `data` → `RULE_PARSE@parse`。
       * 失败路径也要落盘：已经发生的写入是**真实副作用**，不该因为后续字段/目录出错而丢弃。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 落盘失败不影响本次结果 */
      }
      timer.end(result);
      return result;
    } catch (e) {
      timer.end(undefined, e);
      /**
       * 落盘源状态（**含 `@put:{k:v}` / `java.put(k,v)` / `source.setVariable` 的写入**）。
       *
       * ⚠️ **本阶段此前漏了这一步**（2026-09-22 修，缺陷类AG）：
       * `putSharedVariable()` 只把值写进**本次请求**的 `variables`，真正落盘靠 `persistSourceState`。
       * detail 有 `prime` 没有 `persist` ⇒ 详情阶段写的 `bid` 到正文阶段就没了。
       * 实测（🏷七猫[官方]v3.1）：`BookInfo.name = "title@put:{bid:id}"` 在详情阶段确实执行
       * （`[put] bid = 203436`），但 `data/kv.json` 里该源的 `source-var:` 仍是 `{}`；
       * 正文脚本 `java.get("bid")` 拿到空串 → 请求 URL 变成 `.../chapter/content?&id=&chapterId=630355`
       * → 站点返回不含 `data` → `RULE_PARSE@parse`。
       * 失败路径也要落盘：已经发生的写入是**真实副作用**，不该因为后续字段/目录出错而丢弃。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 落盘失败不影响本次结果 */
      }
      if (e instanceof EngineError) throw e;
      if (isNetworkError(e)) {
        throw new EngineError('NETWORK', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          input: String(e instanceof Error ? e.message : e),
          trace: ctx.trace.tail(20),
          cause: causeOf(e),
          retryable: true,
        });
      }
      throw new EngineError('RULE_PARSE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        input: withJsLibHint(ctx, String(e instanceof Error ? e.message : e)),
        trace: ctx.trace.tail(20),
        cause: causeOf(e),
        retryable: false,
      });
    }
  }

  // ---- 登录（Legado BaseSource.login / getLoginJs） ----
  /**
   * 源登录。三种形态（见 model/login.ts）：
   *   - 登录页 URL / JSON 配置 → `action:'browser'` + url（由桌面端开登录窗收 Cookie）
   *   - 需要 WebView 的脚本     → `action:'browser'` + needBrowser（服务端跑不了，明说）
   *   - 纯 HTTP 脚本            → 服务端直接执行（Legado BaseSource.kt:160-175 的调用方式）
   *
   * Legado 执行语义：
   *   `$loginJs; if (typeof login=='function') { login.apply(this); } else { throw('Function login not implements!!!') }`
   * 登录信息（账号/密码）走 `source.getLoginInfoMap()`（ctx.loginInfo 注入）。
   */
  /**
   * 登录（对齐 Legado `SourceLoginDialog` + `BaseSource.login()`）。
   *
   * 形态与动作（实测 484 源：loginUrl 100 / loginUi 37，其中 LoginUiV2 **0 覆盖**故不实现）：
   *  1. `url` / `config-url` → **打开登录页**人工/安全验证（`showBrowser`）；
   *  2. `ui`                → `loginUi` 驱动：text/password 收进 loginInfo，
   *                           button/toggle 的 action 决定「打开页面」还是「跑脚本」；
   *  3. `js`                → 直接执行 `loginJs + login.apply(this)`（可能内部走 WebView）。
   *
   * 关键绑定（Legado `runScriptWithContext`）：
   *  · `result` = 登录信息 map（= 已存 loginInfo ⊕ 本次提交的表单值）
   *  · `source` = 源对象（`getLoginInfoMap()/putLoginInfo()/putLoginHeader()/removeLoginHeader()…`）
   *  · `java`   = 登录扩展（cookie / startBrowserAwait / open / getVerificationCode …）
   *
   * 表单优先：有 text/password 行且**没提交过值**时先返回 `action:'form'`（Legado 先渲染
   * 登录对话框、点「确定」才跑脚本）。`req.loginAction` 非空表示点击了某个按钮。
   */
  async login(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedLoginResult> {
    const r = rule as unknown as Record<string, unknown>;
    const plan = classifyLoginUrl(r['loginUrl'], r['loginUi']);
    const loginAction = String(req.loginAction ?? '').trim();

    // `#315`：形态早退（none / url / config-url）走 core 共享件（与 rss 引擎同一条）
    const early = loginPlanEarlyResult(plan, '源');
    if (early) return early;

    // toast 收集器：脚本里 java.toast / java.longToast 的文本按序收集，随结果回传前端弹出。
    // （禁漫天堂的登录按钮只靠 toast 反馈——切换分流/线路不改 Cookie，没有 toast 用户就等于「点了没反应」）
    const toasts: string[] = [];
    /**
     * `#887` **先 prime jsLib，再 makeEnv**（顺序不能反）。
     *
     * 复现证据（`rounds/2026-11-27-04`）：`POST /api/sources/:id/login` 期间主线程 stall
     * 5103/5034ms，`blocks` 里是 `jsLib-curl n=2 m=5141`、`freeze={open=expr:fast}`。
     * 真因：`makeEnv` 会 `resolveLib` 解析 `jsLib`，而它的**同步兜底**是 `execFileSync curl`
     * （最长 8s/个库）；login 这里旧顺序是「makeEnv → primeSourceState → primeJsLibCached」，
     * 于是 prime 还没跑、缓存是冷的，同步 curl 就上了主线程。
     * 其余动作（search/home/category/detail/content）都是 prime 在前 ⇒ 只有登录这条路径会卡。
     */
    await primeSourceState(ctx);
    await primeJsLibCached(ctx, rule.jsLib); // #607：jsLib 落盘（内存→磁盘→网络），避免同步 curl
    const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, r, toasts);
    env.bookData = { bookUrl: rule.bookSourceUrl ?? '', name: '' };
    env.fromBookInfo = true;
    // 有效登录信息 = storage ⊕ 宿主注入的 ctx.loginInfo（primeSourceState 已合并到变量里）。
    // ⚠️ 不能直接 loadLoginInfo（只读 storage）——测试/宿主只给 ctx.loginInfo 时会被判成「没填过」。
    const existing: Record<string, string> = (() => {
      try {
        const raw = ctx.variables.get('__loginInfo');
        return typeof raw === 'string' && raw ? (JSON.parse(raw) as Record<string, string>) : {};
      } catch {
        return {};
      }
    })();

    // ── LoginUiV2（`loginUi = {"version":2}`）────────────────────────────────────────
    // 逐条对齐 Legado `BaseSource.evalLoginUiV2/evalLoginActionV2` + `SourceLoginV2Delegate`：
    //   · 渲染：`${loginJs}\nloginUi(JSON.parse(String(__loginState)))` → `{"rows":[…]}`（走 parseRender 全套校验）
    //   · 动作：`${loginJs}\nloginAction(String(__loginAction), JSON.parse(String(__loginState)), JSON.parse(String(__loginForm)))`
    //     → 四命令 `state` / `error` / `login` / `close`（未知键忽略，与 Legado 同）
    //   ⚠️ v1 的「跑完脚本就算成功」在 v2 不成立：**成功与否由命令与是否还有 error 决定**。
    if (plan.uiV2) {
      if (!plan.js) {
        return {
          ok: false,
          action: 'server',
          uiV2: true,
          message: '登录UI v2 缺少 loginUi/loginAction 脚本（loginUrl 里需定义 loginUi(state) 与 loginAction(action,state,form)）',
        };
      }
      const stateIn = String(req.loginState ?? '').trim() || '{}';
      const formIn = String(req.loginForm ?? '').trim() || '{}';
      const v2 = new AnalyzeRule(env);
      const renderRows = async (st: string) => {
        const raw = await v2.runJs(`${plan.js}\nloginUi(JSON.parse(String(__loginState)))`, {
          __loginState: st,
          result: existing,
        });
        return parseLoginUiV2Render(raw == null ? '' : String(raw));
      };

      if (loginAction) {
        let raw: unknown;
        try {
          raw = await v2.runJs(
            `${plan.js}\nloginAction(String(__loginAction), JSON.parse(String(__loginState)), JSON.parse(String(__loginForm)))`,
            { __loginAction: loginAction, __loginState: stateIn, __loginForm: formIn, result: existing },
          );
        } catch (e) {
          const msg = errText(e);
          return {
            ok: false,
            action: 'server',
            uiV2: true,
            loginState: stateIn,
            needBrowser: needBrowserFromError(msg),
            ...(toasts.length ? { toasts } : {}),
            message: `登录UI v2 动作「${loginAction}」执行失败：${msg}`,
          };
        }
        const cmd = parseLoginUiV2Action(raw == null ? '' : String(raw));
        if (cmd.malformed) {
          return {
            ok: false,
            action: 'server',
            uiV2: true,
            loginState: stateIn,
            ...(toasts.length ? { toasts } : {}),
            message: '登录UI v2 动作返回了无效命令（state/error/login 需为对象，close 需为布尔）',
          };
        }
        // `login` 命令 → 落盘登录信息（Legado `source.putLoginInfo(loginJson)`；失败即中断）
        if (cmd.loginJson) ctx.variables.set('__loginInfo', cmd.loginJson);
        const nextState = cmd.stateJson ?? stateIn;
        let rows: LoginField[] | null = null;
        if (cmd.stateJson) {
          try {
            rows = await renderRows(nextState);
          } catch (e) {
            warnOnce('login-v2-render', rule.bookSourceUrl ?? '', `登录UI v2 重渲染失败：${errText(e)}`);
            rows = null;
          }
        }
        await persistSourceState(ctx);
        const afterInfo = await loadLoginInfo(ctx);
        const errs = cmd.error ?? {};
        if (cmd.close) {
          return {
            ok: true,
            action: 'server',
            uiV2: true,
            close: true,
            loginState: nextState,
            ...(rows ? { fields: rows } : {}),
            hasLoginInfo: Object.keys(afterInfo).length > 0,
            ...(toasts.length ? { toasts } : {}),
            message: toasts.at(-1) ?? '登录流程已关闭',
          };
        }
        return {
          ok: Object.keys(errs).length === 0,
          action: 'server',
          uiV2: true,
          loginState: nextState,
          ...(rows ? { fields: rows } : {}),
          ...(Object.keys(errs).length ? { fieldErrors: errs } : {}),
          hasLoginInfo: Object.keys(afterInfo).length > 0,
          ...(toasts.length ? { toasts } : {}),
          message:
            Object.keys(errs).length > 0
              ? '请修正标红的字段后重试'
              : (toasts.at(-1) ?? '已执行'),
        };
      }

      // 无动作 = 打开对话框时的初始渲染（Legado `SourceLoginV2Delegate.render`）
      try {
        const rows = await renderRows(stateIn);
        if (!rows) {
          return {
            ok: false,
            action: 'form',
            uiV2: true,
            loginState: stateIn,
            ...(toasts.length ? { toasts } : {}),
            message: '登录UI v2 渲染结果格式错误（rows 缺失 / 行非法 / key 或 action 重复）',
          };
        }
        return {
          ok: true,
          action: 'form',
          uiV2: true,
          loginState: stateIn,
          fields: rows,
          hasLoginInfo: Object.keys(existing).length > 0,
          ...(toasts.length ? { toasts } : {}),
        };
      } catch (e) {
        return {
          ok: false,
          action: 'form',
          uiV2: true,
          loginState: stateIn,
          ...(toasts.length ? { toasts } : {}),
          message: `登录UI v2 渲染出错：${errText(e)}`,
        };
      }
    }

    // ① loginUi 行：静态数组直接用；`@js:` 动态脚本要求值（Legado evalJS("loginJs + loginUiJs")）
    let fields: LoginField[] = plan.fields;
    /**
     * `#411`：动态 loginUi 求值失败的**原因**。非空 ⇒ 行数组必然为空 ⇒ 必须让用户看见
     * （旧实现是纯静默：「打开登录窗口」+ 空表单，日志也干净）。
     */
    let uiError = '';
    if (plan.uiIsScript) {
      const resolved = await resolveLoginFields(plan, env, `${String(rule.bookSourceName ?? '') || '(无名)'}(${ctx.sourceId})`);
      fields = resolved.fields;
      uiError = resolved.error ?? '';
    }
    /** 把「登录界面为什么没渲染出来」并进结果 message（`#411`：对话框必须显示原因） */
    const withUiNote = (m: string): string =>
      (uiError ? `${m}｜登录界面（loginUi）脚本求值失败：${uiError}` : m);
    /**
     * `#423` **只渲染登录界面**：打开对话框的 `GET /login` 用它拿行数组。
     * 早退在**一切脚本之前**（含 v2 动作）⇒ 读接口零副作用（判据见 core `LOGIN_UI_RENDER_ACTION`）。
     */
    if (loginAction === LOGIN_UI_RENDER_ACTION) {
      return { ok: true, action: 'form', fields, message: withUiNote('登录界面已渲染') };
    }
    const formFields = fields.filter((f) => f.type === 'text' || f.type === 'password');
    const buttonFields = fields.filter((f) => f.type === 'button' || f.type === 'toggle');

    // ② 没有 loginUrl 脚本（只有 loginUi 表单）→ 保存即完成（表单值供源规则 getLoginInfo 使用）
    if (!plan.js) {
      if (formFields.length && !Object.keys(existing).length) {
        return { ok: false, action: 'form', fields, message: withUiNote('请填写登录信息（该源无登录脚本，值供规则内 getLoginInfo() 使用）') };
      }
      return {
        ok: true,
        action: 'form',
        fields,
        hasLoginInfo: Object.keys(existing).length > 0,
        message: withUiNote('已保存登录信息'),
      };
    }
    // ③ 动态 loginUi 求值失败 ⇒ 没有行可渲染。仍继续跑登录脚本（有些源点「登录」不需要 UI），
    //    但把原因带回前端（`#411`：不许静默退化成「只剩打开登录窗口」）。
    if (uiError && !fields.length) {
      warnOnce('loginui-fallback', ctx.sourceId, `登录界面脚本求值失败，已退化为「直接执行登录脚本」：${uiError}`);
    }

    // ③ 表单未填写且本次不是按钮动作 → 先要表单（`#315` 表单闸门走 core 共享件）
    const gate = loginFormGate(fields, { loginAction, hasLoginInfo: Object.keys(existing).length > 0 });
    if (gate) return gate;

    const before = ctx.cookies?.header() ?? '';
    const beforeHeader = await loadLoginHeader(ctx);
    // Legado：按钮点击跑 `loginJs + action`；「确定」跑 `loginJs + login.apply(this)`（`#315` core 共享件）
    const code = buildLoginScript(plan.js, loginAction);
    const resultMap: Record<string, string> = { ...existing };
    try {
      await new AnalyzeRule(env).runJs(code, {
        result: resultMap,
        ...(loginAction ? {} : {}),
      });
    } catch (e) {
      const cookie = ctx.cookies?.header() ?? '';
      const gained = cookie && cookie !== before;
      const errMsg = e instanceof Error ? e.message : String(e);
      /**
       * `#469①`：源**没有 `login()` 函数**时，core 的 `buildLoginScript` 抛
       * `Function login not implements!!!`（与上游 Legado 一致）。用户 2026-10-15 定了语义：
       * **有数据存数据、有登录就存 Cookie，然后关登录界面** —— 「保存并登录」不该因为源里
       * 没写 `login()` 就报错卡住对话框（四季书屋实测）。
       * ⇒ 这条**特定错误**改判为「保存并关闭」：返回 `ok` + 友好文案
       * （前端「无 action 的成功」分支会据此关窗，见 `SourceLoginDialog.post`）。
       */
      if (!loginAction && /login not implements/i.test(errMsg)) {
        return {
          ok: true,
          action: 'server',
          ...(fields.length ? { fields } : {}),
          ...(toasts.length ? { toasts } : {}),
          hasLoginInfo: Object.keys(existing).length > 0,
          ...(cookie ? { cookie, count: countCookies(cookie) } : {}),
          wroteLoginState: false,
          message: withUiNote('该源没有 login() 登录脚本：已保存现有登录信息（如有）并关闭'),
        };
      }
      // ⚠️ 「需浏览器」只在**错误本身**指向 WebView/浏览器 API 时成立（`#315` core 共享件）。
      const browserBlocked = needBrowserFromError(errMsg);
      const notAFunction = notAFunctionFromError(errMsg);
      return {
        ok: false,
        action: 'server',
        needBrowser: browserBlocked,
        ...(fields.length ? { fields } : {}),
        ...(cookie ? { cookie, count: countCookies(cookie) } : {}),
        ...(toasts.length ? { toasts } : {}),
        hasLoginInfo: Object.keys(existing).length > 0,
        message: withUiNote(
          `登录脚本执行失败：${errMsg}` +
            (gained ? '（脚本中途写入了 Cookie，可尝试继续使用）' : '') +
            (browserBlocked ? '；脚本确实调用了 WebView 交互 API，需桌面端 + 人工操作' : '') +
            (notAFunction && !browserBlocked
              ? '；脚本引用了本环境未提供的函数——如果源作者依赖自定义函数（非 Legado java.* API），该源登录脚本可能已失效'
              : ''),
        ),
      };
    }

    // 脚本写完的「登录信息 / 登录头」落盘（Legado putLoginInfo/putLoginHeader 都是持久化）
    await persistSourceState(ctx);

    // ④ 脚本若调用过 startBrowser/startBrowserAwait/webView → 说明它要**真浏览器**
    //    （人工登录 / 验证码）。服务端渲染只能拿到静态结果，所以把 URL 交回前端打开。
    const browserUrl = String(ctx.variables.get('__browserUrl') ?? '');
    if (browserUrl) {
      const upd = loginDataUpdate(ctx);
      return {
        ok: false,
        action: 'browser',
        url: browserUrl,
        needBrowser: true,
        // `#393` 目的：'show'（startBrowser，打开给人看）⇒ 应用内浏览器；'cookie' ⇒ 本机真浏览器。
        browserKind: ctx.variables.get('__browserNeedCookie') ? 'cookie' : 'show',
        ...(fields.length ? { fields } : {}),
        ...(Object.keys(upd).length ? { loginData: upd } : {}),
        ...(toasts.length ? { toasts } : {}),
        message: '登录脚本要求打开浏览器（人工登录 / 安全验证）：已提供登录页地址，请在浏览器完成后再回来「重新检测」',
      };
    }

    // ⑤ 登录脚本可能改了 loginInfo（source.putLoginInfo）与登录头（source.putLoginHeader）
    const afterInfo = await loadLoginInfo(ctx);
    const beforeKeys = Object.keys(existing).length;
    const loginHeader = await loadLoginHeader(ctx);
    const cookieChanged = (ctx.cookies?.header() ?? '') !== before;
    const headerChanged = JSON.stringify(loginHeader) !== JSON.stringify(beforeHeader);
    const cookie = ctx.cookies?.header() ?? '';
    const count = countCookies(cookie);
    // 「按钮动作」语义：源脚本的 button 行（如禁漫天堂「切换分流线路」「切换国际线路」）只改
    // **源变量**，既不写 Cookie 也不写登录头。若按「登录态有没有变」判 ok，这些按钮永远被判失败，
    // 用户看到的是「登录脚本执行成功，但登录态与登录前一致」这种误导性文案 —— 实际按钮已生效。
    // 对齐 Legado：button 点击 = 跑脚本 + 弹 toast，跑完就算完成。
    const actionOk = !!loginAction;
    const ok = actionOk || (count > 0 && cookieChanged) || headerChanged || Object.keys(afterInfo).length > beforeKeys;
    // `#397`：登录态 **delta** —— 只认「本次运行新写了什么」。`hasLoginInfo`/`count` 是**当前状态**
    //（源之前写过的 loginInfo、会话 jar 里已有的 Cookie 都会让它们为真）⇒ 前端拿它们判
    // 「按钮动作是不是真登录」会把「书源更新」这类纯动作按钮误报成「✅ 登录成功」。
    // loginInfo 比较**键序无关**（putLoginInfo 重写同样内容不应算「写了」）。
    const fpInfo = (info: Record<string, string>): string =>
      Object.keys(info).sort().map((k) => `${k}\u0001${info[k]}`).join('\u0002');
    const infoChanged = fpInfo(afterInfo) !== fpInfo(existing);
    const wroteLoginState = cookieChanged || headerChanged || infoChanged;
    const upd = loginDataUpdate(ctx);
    return {
      ok,
      action: 'server',
      needBrowser: plan.needBrowser && !ok && buttonFields.length === 0 && loginAction === '',
      ...(fields.length ? { fields } : {}),
      ...(Object.keys(upd).length ? { loginData: upd } : {}),
      ...(cookie ? { cookie, count } : {}),
      ...(Object.keys(loginHeader).length ? { loginHeader: JSON.stringify(loginHeader) } : {}),
      ...(toasts.length ? { toasts } : {}),
      hasLoginInfo: Object.keys(afterInfo).length > 0,
      wroteLoginState,
      ...(ok
        ? actionOk && !cookieChanged && !headerChanged
          ? { message: withUiNote(toasts.at(-1) ?? (plan.uiRaw ? '按钮动作已执行（改了源变量，未涉及 Cookie）' : '已执行')) }
          : uiError
            ? { message: `登录界面（loginUi）脚本求值失败：${uiError}` }
            : {}
        : {
            message: withUiNote(
              count === 0 && !headerChanged
                ? '登录脚本执行成功，但没有产生 Cookie / 登录头（可能站点用 Token 且需桌面端 WebView 交互）'
                : '登录脚本执行成功，但登录态与登录前一致（可能未真正登录或凭据为空）',
            ),
          }),
    };
  }

  // ---- 图片二次解密（Legado ImageUtils.decode）----
  /**
   * 图片字节解密：ContentRule.imageDecode（正文图，isCover=false）/ coverDecodeJs（封面，isCover=true）。
   * Legado ImageUtils.kt:21-40：JS 以 `result`（字节）与 `src`（图片 URL）为入参，返回解密后的 ByteArray；
   * 规则为空 → 原图；执行/解密失败 → null（调用方回传原图，不让 500 打断阅读）。
   *
   * ★ `result` 的类型**按上游分两种**（`OkHttpStreamFetcher.kt:129-146`）：
   * 封面传 `byteStream()`（**InputStream** ⇒ 源脚本用 `result.readAllBytes()`），
   * 正文图传 `bytes()`（**ByteArray** ⇒ 源脚本用 `result[0]`）。
   * 两种形态本仓都用 `asImageStreamResult`（下标 + 流方法全在），
   * 否则 🥝猕猴桃漫画 / 漫蛙这类封面源会因 `readAllBytes is not a function` 静默解密失败。
   */
  async decodeImage(
    rule: CompiledBookSource,
    req: { url: string; bytes: Uint8Array; isCover?: boolean },
    ctx: EngineContext,
  ): Promise<Uint8Array | null> {
    const code = (req.isCover ? rule.coverDecodeJs : rule.ruleContent?.imageDecode) ?? '';
    /**
     * `D2`：普通字符串仍是旧语义（JS 自己解密并返回字节）；
     * `{js, ivPrefixBytes, keyEncoding}`（对象或 JSON 字符串）= 标准参数：
     * JS 只返回 **key**，IV 取图片前缀，剩余密文交给服务端 `node:crypto` 做 AES-CBC。
     */
    const spec = parseImageDecodeSpec(code);
    if (!spec) return null;
    /**
     * `#889` **先 prime jsLib，再建 env**（与 `#887` 同一个病根，只是换了个入口）。
     *
     * `decodeImage` 由 `hub.decodeImage` 调用，而那里每次都是 **`makeContext(sourceId)` 新建 ctx**
     * （不经过任何 action）⇒ 若进程刚起、第一件事是刷封面（书架首屏 / 封面洪峰），
     * `jsLibCache` 是冷的，`makeEnv → resolveLib` 的**同步 curl 兜底**会直接压在主线程上（≤8s/库）。
     * 实测同类形态在登录路径上是 5.1s 的 `[stall]`（`rounds/2026-11-27-04`），这里入口不同、机制一致。
     */
    await primeJsLibCached(ctx, rule.jsLib);
    const js = spec.js;
    /** 注入 JS 环境的参数（`iv` 直接给前缀字节，省得脚本自己 slice） */
    const specBindings: Record<string, unknown> = {
      ...(spec.ivPrefixBytes
        ? { ivPrefixBytes: spec.ivPrefixBytes, iv: req.bytes.subarray(0, spec.ivPrefixBytes) }
        : {}),
      ...(spec.keyEncoding ? { keyEncoding: spec.keyEncoding } : {}),
    };
    /**
     * `#759`：能用 worker 时只下发**裸字节描述符**（worker 重建 InputStream 方法）；
     * 不能用时仍按旧行为在宿主 L1 跑（`result` = 挂了流方法的同一数组）。
     * 每次重跑都新建 env：worker 失败/超时时不能复用已被上一轮 mutated 的求值器状态。
     */
    const libText = String(rule.jsLib ?? '');
    const runDecode = async (useWorker: boolean, probe = false): Promise<Uint8Array | null> => {
      const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, rule);
      env.bookData = { bookUrl: rule.bookSourceUrl ?? '', name: '' };
      const started = Date.now();
      const out = await new AnalyzeRule(env).runJs(
        js,
        useWorker
          ? imageDecodeBindings(req.bytes, req.url, specBindings)
          : { result: asImageStreamResult(req.bytes), src: req.url, ...specBindings },
      );
      // `auto` 的成本样本：L1（同步 ⇒ 墙钟≈CPU）或 #782 的 worker 探测（往返墙钟）
      if (!useWorker) recordImageDecodeL1Cost(js, libText, Date.now() - started);
      else if (probe) recordImageDecodeProbeCost(js, libText, Date.now() - started);
      if (spec.ivPrefixBytes) {
        // 标准参数：`js` 只返回 key ⇒ key 留在服务端，AES-CBC 用 node:crypto 完成
        const keyMaterial = typeof out === 'string' ? out : toBytesOrNull(out);
        return keyMaterial === null ? null : decryptImageWithSpec(req.bytes, spec, keyMaterial);
      }
      return toBytesOrNull(out);
    };
    try {
      const plan = planImageDecode(js, libText, req.bytes.length);
      /**
       * worker 任一侧抛错（崩溃 / 硬超时 / worker 环境缺能力）⇒ 回落宿主同步实现。
       * 旧实现本来就是宿主同步，所以最坏情况只是「慢」，不会出现「密文当原图」的错图。
       */
      let bytes: Uint8Array | null;
      try {
        bytes = await runDecode(plan.useWorker, plan.probe);
      } catch (e) {
        if (plan.probe) abortImageDecodeProbe(js, libText);
        if (!plan.useWorker || !shouldRetryImageDecodeInL1(e)) throw e;
        warnOnce(
          'image-decode-worker-retry',
          rule.bookSourceUrl ?? '',
          `图片解密 worker 失败/超时，回落宿主执行（最坏只慢）：src=${req.url.slice(0, 120)} | ${errText(e)}`,
        );
        bytes = await runDecode(false);
      }
      // 规则「跑通了但没吐出字节」也是缺陷（例如脚本最后一个表达式是赋值/undefined）——
      // 症状与「站点图片本来就这样」完全一样，必须留痕。
      if (!bytes || !bytes.length) {
        warnOnce('image-decode', rule.bookSourceUrl ?? '', `图片解密脚本未返回字节（回原图）：src=${req.url.slice(0, 120)}`);
      }
      return bytes;
    } catch (e) {
      /**
       * ⚠️ **不许静默**（铁律 3）：以前这里 `catch { return null }`，
       * 于是「解密脚本抛错 → 回原图」的表现是**图片看起来是错乱的横条**，
       * 而日志里一个字都没有 —— 与「站点图片本来就没打乱」的症状不可分辨。
       * 现在至少打一次 warn（含首帧调用栈，用来区分「脚本自身写错」和「引擎缺 Java 类」）。
       */
      const stack = String((e as Error).stack ?? '')
        .split('\n')
        .slice(1, 4)
        .map((l) => l.trim().replace(/^at /, ''))
        .join(' <- ');
      warnOnce(
        'image-decode',
        rule.bookSourceUrl ?? '',
        `图片解密失败，已回退原图（图片可能表现为错乱的横条）：src=${req.url.slice(0, 120)} | ${errText(e)} | ${stack}`,
      );
      return null;
    }
  }

  /**
   * 播放（视频类书源，bookSourceType=4）：Legado 里视频源的「正文」就是播放页——
   * 正文规则/`content` JS 从播放页里解析出 m3u8/mp4 直链（如电源先生解析 `player_aaaa` 配置），
   * 客户端直接播放该地址。因此这里**复用 content 管线**取直链，而不是另做一套解析。
   */
  async play(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedPlay> {
    const timer = ctx.trace.begin('parse', 'play', req.id);
    try {
      const content = await this.content(rule, req, ctx);
      const fromMedia = content.media?.url ?? '';
      const fromText = fromMedia ? '' : findMediaUrl(content.paragraphs.join('\n'));
      const url = fromMedia || fromText;
      if (!url) {
        throw new EngineError('RULE_PARSE', 'parse', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: rule.ruleContent?.content ?? 'content',
          input: '未从播放页解析出媒体地址（m3u8/mp4/mpd/flv）',
          trace: ctx.trace.tail(20),
          retryable: false,
        });
      }
      const out: UnifiedPlay = {
        url,
        format: inferPlayFormat(url),
        ...(content.media?.headers ? { headers: content.media.headers } : {}),
        // content 阶段算出的备选原样透传（播放页同样存在「多条线路」的形态）
        ...(content.media?.alternatives ? { alternatives: content.media.alternatives } : {}),
      };
      timer.end(out);
      return out;
    } catch (e) {
      timer.end(undefined, e);
      /**
       * ★ **失败路径也要落盘「按源状态」**（`#606` 第 4 层，2026-10-24）。
       *
       * 这里包含**全局** cache（`cache:global` / `__srcCache`）—— 也就是 `java.importScript` /
       * `cacheFile` 下载到的**远端 js 文本**（qyyuapi 系的 `common.js` 180KB / `jsLib.js` 42KB /
       * `searchUrl.js`）。上游把这些放在 **ACache 磁盘缓存**里，下载即写，**与业务成败无关**；
       * 本仓旧实现在成功 return 前才 `persistSourceState` ⇒ 一次 RULE_PARSE 就让刚下好的几万字全丢，
       * 下次请求从零再下（实测单请求 60~76s，绝大部分是重复下载）。
       * 落盘失败不能掩盖原始错误 ⇒ 单独 try/catch。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 存储失败不改变本次错误的定性 */
      }
      if (e instanceof EngineError) throw e;
      throw new EngineError('RULE_PARSE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        input: withJsLibHint(ctx, String(e instanceof Error ? e.message : e)),
        trace: ctx.trace.tail(20),
        cause: causeOf(e),
        retryable: false,
      });
    }
  }

  /**
   * **字典查词**（用户 4-5；照 Legado `DictRule.search` 实现）。
   *
   * Legado 的语义只有两步（`DictRule.kt:44-56`）：
   * ```kotlin
   * val analyzeUrl = AnalyzeUrl(urlRule, key = word)          // ① urlRule 里用 {{key}} 取词
   * val body = analyzeUrl.getStrResponseAwait().body
   * if (showRule.isBlank()) return body!!                      // ② 没写 showRule 就原样返回
   * return AnalyzeRule().getString(showRule, mContent = body)  // ③ 否则按规则在响应体上取
   * ```
   * 所以我们**不需要**一个「字典源」实体：把 `urlRule` 当成一次普通的规则驱动请求
   * （复用 `fetchRuleUrl` ⇒ URL 选项/编码/表单体/Referer 阶梯/超时全都一致），
   * `showRule` 交给同一个 `AnalyzeRule`（CSS / JSONPath / `@js:` 都支持）。
   *
   * ⚠️ 字典是**跨源**能力，与具体书源无关 ⇒ `ctx.sourceId` 用占位串（`__dict__`），
   * 但 `header`/`baseUrl` 由调用方传入（有些词典站点要 Referer/UA）。
   */
  async dictLookup(
    ctx: EngineContext,
    input: { word: string; urlRule: string; showRule?: string; header?: string; baseUrl?: string },
  ): Promise<{ text: string; url: string }> {
    const word = String(input.word ?? '').trim();
    const urlRule = String(input.urlRule ?? '').trim();
    if (!word) throw new EngineError('RULE_PARSE', 'parse', { engine: 'legado', sourceId: ctx.sourceId, rule: 'dict.key', input: '词典名不能为空', trace: ctx.trace.tail(20), retryable: false });
    if (!urlRule) throw new EngineError('RULE_PARSE', 'parse', { engine: 'legado', sourceId: ctx.sourceId, rule: 'dict.urlRule', input: 'URL 规则不能为空', trace: ctx.trace.tail(20), retryable: false });
    const baseUrl = String(input.baseUrl ?? '').trim() || 'https://dict.local';
    const compiled = compileBookSource({
      bookSourceUrl: baseUrl,
      bookSourceName: '字典',
      bookSourceType: 0,
      searchUrl: 'https://dict.local/?q={{key}}',
      ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
      ...(input.header ? { header: String(input.header) } : {}),
    });
    if (!compiled.ok || !compiled.rule) {
      throw new EngineError('SOURCE_INVALID', 'validate', { engine: 'legado', sourceId: ctx.sourceId, rule: 'dict', input: '字典规则编译失败', trace: ctx.trace.tail(20), retryable: false });
    }
    const rule = compiled.rule;
    const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, rule);
    const { resp } = await this.fetchRuleUrl(ctx, env, rule, urlRule, { keyword: word });
    const body = String(resp.body ?? '');
    const show = String(input.showRule ?? '').trim();
    const url = String(resp.url ?? '');
    if (!show) return { text: body, url };
    const text = await new AnalyzeRule(env).setContent(body, url).getString(show, false);
    return { text: String(text ?? ''), url };
  }

  // ---- 正文 ----
  async content(rule: CompiledBookSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedContent> {
    const timer = ctx.trace.begin('parse', 'content', req.id);
    try {
      await primeSourceState(ctx);
      await primeJsLibCached(ctx, rule.jsLib); // #607：jsLib 落盘（内存→磁盘→网络），避免每次都同步 curl 60s
      const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, rule);
      const payload = readPayload(req.id);
      const chapterUrl = payload.chapterUrl ?? (typeof req.id === 'string' ? req.id : '');
      // Legado：卷章节（isVolume）没有真实正文页——直接返回空内容，不发请求
      // （否则会去打 title+index 这种伪 URL，产出 NETWORK/RULE_PARSE 噪声）
      if (payload.isVolume) {
        const empty: UnifiedContent = { paragraphs: [], ...(payload.title ? { title: String(payload.title) } : {}) };
        timer.end(empty);
        return empty;
      }
      if (!chapterUrl) {
        throw new EngineError('SOURCE_INVALID', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: 'chapterUrl',
          input: req.id,
          trace: ctx.trace.tail(20),
          retryable: false,
        });
      }
      // 章节实体（Legado bindings["chapter"] / ["title"]，AnalyzeRule.kt:902-903）——
      // ContentRule.title 用 `title`、正文规则用 `chapter.title` 都靠它。
      // 放在请求**之前**：loginCheckJs 也吃 chapter 绑定（Legado AnalyzeUrl(..., chapter = bookChapter)）
      env.chapterData = { ...(payload as Record<string, unknown>), title: (payload.title as string) ?? '', url: chapterUrl };

      /**
       * `#592` **book 实体桩在 `content` 里也必须存在**（Legado 传的是完整 Book）。
       * 此前本仓只有 `detail` 设过 `env.bookData` ⇒ `content` 的源脚本里 `book` 是空的，
       * `book.type` ⇒ `undefined` ⇒ 按 `book.type` 分流的正文规则**恒走 else 支**
       * （📷🔞HentaiCosplay 的图片因此全空，详见 {@link bookTypeOf} 的说明）。
       * 值照 Legado：类型由源类型推出，其余字段取 payload（书架/搜索都会带）。
       */
      env.bookData = {
        bookUrl: typeof payload.bookUrl === 'string' && payload.bookUrl ? payload.bookUrl : (rule.bookSourceUrl ?? ''),
        name: String(payload.name ?? payload.title ?? ''),
        type: bookTypeOf(rule),
      };

      // 源类型分流（原本在抓取之后才算，提前到这里：「正文规则为空」分支要用）
      const srcType = Number(rule.bookSourceType ?? 0);
      const isImageKind = srcType === 2;
      const isMediaKind = srcType === 1 || srcType === 3 || srcType === 4;
      const c: RuleContent = rule.ruleContent || {};
      const contentRuleStr = typeof c.content === 'string' ? c.content.trim() : '';
      /**
       * ★ **`ruleContent.content` 为空 → 正文就是章节链接**（Legado `WebBook.kt:429-432`，缺陷类BK）：
       *
       * ```kotlin
       * val contentRule = bookSource.getContentRule()
       * if (contentRule.content.isNullOrEmpty()) {
       *     Debug.log(bookSource.bookSourceUrl, "⇒正文规则为空,使用章节链接:${bookChapter.url}")
       *     return bookChapter.url
       * }
       * ```
       * 语义要点：**根本不发正文页请求**，直接把 `bookChapter.url` 当作正文返回。
       * 「章节链接本身就是媒体直链」的音乐/音频源全靠这条（实测 🔊潇社音乐：
       * `ruleContent` 是空对象、`ruleToc.chapterUrl` 就是 `…/47994081035470.mp3`）——
       * 我们此前照常去抓那个 mp3（拿到二进制）→ 空规则求值为 `''` → `{paragraphs:[]}` ⇒ 前端
       * 「未取到媒体地址（源未返回 media，正文里也没有媒体直链）」。
       *
       * 实现上把「章节链接」当作 raw 内容喂给同一套抽取器（`extractFromRaw`）：
       * 媒体类源 → `media.url`；图片类源 → 一段图片地址；文本源 → 一段 URL 文本
       * （★ 与 Legado 一致：Legado 就是把这个字符串当 content 交给 UI，不做类型特判）。
       */
      if (!contentRuleStr || contentRuleStr === 'null') {
        const absChapterUrl = ((): string => {
          const u = chapterUrl.trim();
          if (/^https?:\/\//i.test(u)) return u;
          const toc = typeof env.bookData?.tocUrl === 'string' ? env.bookData.tocUrl : '';
          return resolveUrl(toc || rule.bookSourceUrl || '', u) ?? u;
        })();
        const kind: ContentKind = isImageKind ? 'image' : isMediaKind ? 'media' : 'text';
        const ex = extractFromRaw(absChapterUrl, absChapterUrl, kind);
        const out: UnifiedContent = { paragraphs: ex.paragraphs };
        if (ex.media) out.media = ex.media;
        if (payload.title) out.title = String(payload.title);
        timer.end(out);
        return out;
      }

      // 正文页（chapterUrl 支持 ,{options} 尾巴与 js 构造，统一走请求构造器）
      const { resp, scriptUrl } = await this.fetchRuleUrl(ctx, env, rule, chapterUrl, {});
      /**
       * `#334` 正文页状态码闸门：拿到 4xx/5xx 直接抛 NETWORK，**不再把错误页当正文**。
       *
       * 上游（OkHttpUtils.kt:38）对非 2xx 只重试不抛，body 照交给规则（规则通常取空 ⇒ 空白正文）。
       * 但本仓不少源的 `@js:` 兜底写 `return raw` ⇒ **整页 404 JSON 直出**，用户完全看不出是 404。
       * 只拦 `content()` 这一条路径（列表/发现/登录的非 2xx body 仍按上游语义交给规则解析）。
       */
      if (Number(resp.status) >= 400) {
        throw new EngineError('NETWORK', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: `正文页 HTTP ${Number(resp.status)}`,
          input: String(resp.url || chapterUrl),
          trace: ctx.trace.tail(20),
          retryable: true,
        });
      }
      const { content } = parseResponse(resp);
      // Legado 给脚本的 baseUrl 是 `analyzeUrl.url`（**未编码**原始串，见 scriptUrl 注释）
      ctx.variables.set('baseUrl', scriptUrl ?? resp.url);
      env.baseUrl = scriptUrl ?? resp.url;

      // 图片源（漫画，bookSourceType=2）：契约 UnifiedContent——每段是一个图片 URL。
      // 音频(1)/文件(3)/视频(4)源：章节即一个媒体直链（Legado content 规则返回播放 URL）
      // （`srcType` / `isImageKind` / `isMediaKind` / `c` 已在函数上方的「空规则分支」前算好）
      /**
       * `YUEDU_DEBUG_DETAIL=1`：正文阶段的 baseUrl 留痕。
       * 「正文空」的头号原因就是**脚本拿到的 baseUrl 与预期不符**（编码形态/被 redirect 换掉）——
       * 实测 ① 宜搜小说：脚本用 baseUrl 里的章节名算签名，拿到编码名就会 `非法身份`。
       */
      if (process.env['YUEDU_DEBUG_DETAIL']) {
        // eslint-disable-next-line no-console
        console.log(
          `[content] baseUrl=${String(scriptUrl ?? resp.url).slice(0, 200)} | reqUrl=${String(resp.url).slice(0, 120)}`,
        );
      }
      const ar = new AnalyzeRule(env).setContent(content, scriptUrl ?? resp.url);
      // media 类源：规则本身就是字面 URL（无规则标记）时直接采用，不送规则求值器（CSS 会抛 Invalid selector）
      const ruleStr = contentRuleStr;
      const literalUrl = (isImageKind || isMediaKind) && (/^https?:\/\/[^@\s]*$/.test(ruleStr) || /^\/(?!\/)[^@\s]*$/.test(ruleStr));
      const raw = literalUrl ? ruleStr : await ar.getString(ruleStr);

      const kind: ContentKind = isImageKind ? 'image' : isMediaKind ? 'media' : 'text';
      const first = extractFromRaw(raw, resp.url, kind, literalUrl ? ruleStr : undefined);
      let paragraphs = first.paragraphs;
      let media = first.media;

      // Legado nextContentUrl：正文多页——循环追页合并（尾页无「下一页」即止，上限保护）
      const nextContentRule = typeof c.nextContentUrl === 'string' ? c.nextContentUrl.trim() : '';
      if (nextContentRule && nextContentRule !== 'null' && !media) {
        const seen = new Set<string>([resp.url]);
        let pageContent = content;
        let pageBase = resp.url;
        for (let i = 0; i < MAX_CONTENT_PAGES; i++) {
          let list: string[] = [];
          try {
            // Legado BookContent：getStringList(nextContentUrl, isUrl=true)（数组/多行均可）
            list = await new AnalyzeRule(env).setContent(pageContent, pageBase).getStringList(nextContentRule);
          } catch {
            break;
          }
          const urls = list
            .map((u) => (resolveUrl(pageBase, u.trim()) ?? u.trim()))
            .filter((u) => u && u !== 'null' && !seen.has(u));
          if (!urls.length) break;
          urls.forEach((u) => seen.add(u));
          let added = 0;
          for (const nextUrl of urls) {
            try {
              const built = await this.fetchRuleUrl(ctx, env, rule, nextUrl, { content: pageContent });
              pageContent = parseResponse(built.resp).content;
              pageBase = built.resp.url;
              const ar2 = new AnalyzeRule(env).setContent(pageContent, pageBase);
              const raw2 = await ar2.getString(typeof c.content === 'string' ? c.content.trim() : '');
              const page = extractFromRaw(raw2, pageBase, kind, undefined);
              if (page.paragraphs.length) {
                paragraphs = paragraphs.concat(page.paragraphs);
                added++;
              }
            } catch {
              /* 单页失败跳过 */
            }
          }
          if (!added) break;
        }
      }

      // 净化规则（对齐 Legado BookContent：replaceRegex 作为完整规则对正文求值，典型 `正则##替换`）
      if (c.replaceRegex && c.replaceRegex.trim()) {
        try {
          const purified = await new AnalyzeRule(env)
            .setContent(paragraphs.join('\n'), scriptUrl ?? resp.url)
            .getString(c.replaceRegex);
          paragraphs = purified.split('\n').map((s) => s.trim()).filter(Boolean);
        } catch {
          // 净化规则出错不阻断正文
        }
      }

      // Legado BookContent.kt:176-198：ContentRule.title —— 有些站点章节标题只能在正文页取到。
      // 命中 AppPattern.imgRegex（`(.*)((?:data|https?):[\s\S]+)$`）时前半是标题、后半是章节配图。
      let chapterTitle: string | undefined;
      const titleRule = typeof c.title === 'string' ? c.title.trim() : '';
      if (titleRule) {
        try {
          const t = (await ar.getString(titleRule)).trim();
          const m = /([\s\S]*?)((?:data|https?):[\s\S]+)$/.exec(t);
          if (m) {
            const head = (m[1] ?? '').trim();
            if (head) chapterTitle = head; // 前半为空时保留目录里的标题（对齐 Legado）
          } else if (t) {
            chapterTitle = t;
          }
        } catch {
          // 标题取不到不阻断正文
        }
      }

      // Legado BookContent.kt:128-165：ContentRule.subContent —— 副内容
      // （在线文本 → 追加正文；音频 → 歌词；视频 → 弹幕；值为 http 开头先抓该地址）
      const subRule = typeof c.subContent === 'string' ? c.subContent.trim() : '';
      let subContent: string | undefined;
      if (subRule) {
        try {
          let sub = (await ar.getString(subRule)).trim();
          if (/^https?:\/\//i.test(sub)) {
            const subResp = await this.fetchRuleUrl(ctx, env, rule, sub, { content });
            sub = String(parseResponse(subResp.resp).content ?? '').trim();
          }
          subContent = sub || undefined;
        } catch {
          // 副文失败不阻断正文
        }
      }
      if (subContent && kind === 'text') {
        paragraphs = paragraphs.concat(subContent.split('\n').map((s) => s.trim()).filter(Boolean));
      }

      // Legado ReadBook.kt:491-496：ContentRule.imageStyle（忽略大小写）；
      // 图片/漫画类书源未声明时默认 FULL（最大宽度）
      const styleRaw = String(c.imageStyle ?? '').trim().toUpperCase();
      const imageStyle =
        styleRaw === 'FULL' || styleRaw === 'SINGLE' || styleRaw === 'TEXT' || styleRaw === 'DEFAULT'
          ? (styleRaw as 'DEFAULT' | 'FULL' | 'TEXT' | 'SINGLE')
          : isImageKind
            ? 'FULL'
            : undefined;

      /**
       * ★ **播放页 → 跟随一层**（2026-09-25，A 项「视频源分层解析」第②层）。
       *
       * 背景：很多视频源不把直链放进正文产物，而是给出**播放页 URL**（或由脚本交给
       * `java.startBrowser(Await)` 去开窗）。实测 🎬茶杯狐狸 `ruleContent`：
       * ```
       * var pUrl = result.match(/"url_next":"([^"]*)"/)[1].replace(/\\/g, '');
       * java.startBrowserAwait(pUrl, title);      // ← 播放页地址就在这儿
       * "请刷新查看内容";                          // ← 规则最终只返回这句提示
       * ```
       * 于是 `media` 必然为空 ⇒ 用户看到「未取到媒体地址」/「请刷新查看内容」。
       *
       * 做法：把「**本请求内**脚本要求打开的 URL」（`onBrowserOpen` 累积的 `__browserUrls`）
       * 当候选，**仅在 media 为空时跟随一层** —— 抓该页，在返回 HTML 里再找媒体直链。
       *
       * 约束（防误伤，见 `followPlayPage` 注释）：只跟随一层、最多 2 个候选、跳过自环、
       * 失败静默但留痕。第③层（无头嗅探）与第④层（弹窗兜底）不在本轮范围。
       */
      if (!media?.url) {
        const followed = await this.followPlayPage(ctx, env, rule, resp.url, content);
        if (followed) media = followed;
      }

      // 图片二次解密（Legado ContentRule.imageDecode）：浏览器无法跑源 JS → 前端需走服务端代理
      const needsDecode = !!parseImageDecodeSpec(c.imageDecode);

      /**
       * `#583` **源自绘 UI 按钮**（七猫段评气泡 / 本章说 / 神评 / 书评）：正文文本里带
       * `<img …,{…click…}>` ⇒ 由 `extractFromRaw` 抽成 `uiMarks` 随内容下发（段落文本不变）。
       *
       * ⚠️ 第一版是「额外下发 `html` 走 iframe」，被用户 2026-10-23 复测否决：
       * 书籍正文因此丢了阅读样式 / 划词工具 / 高亮 / 分页。现在正文仍是 `paragraphs`，
       * 按钮只在对应段落末尾渲染。
       */
      /**
       * `#696` 正文回执（上游 `BookContent.kt:202-205`）：
       * `┌获取章节名称` / `└第1章 …` → `┌获取正文内容` / `└<正文>`。
       * 正文按 1200 字截断（上游原样全打，Web 端一帧塞几千字既慢又看不出重点；
       * 真要看全文去看阅读器，信息流只负责证明「这段规则通了」）。
       */
      dlogField(ctx, '章节名称', chapterTitle ?? (typeof payload.title === 'string' ? payload.title : ''), 120);
      dlogField(
        ctx,
        '正文内容',
        media?.url ? `[直链] ${media.url}` : paragraphs.join('\n'),
        1200,
      );
      const result: UnifiedContent = {
        paragraphs,
        nextPayload: undefined,
        ...(media ? { media } : {}),
        ...(chapterTitle ? { title: chapterTitle } : {}),
        ...(subContent ? { subContent } : {}),
        ...(imageStyle ? { imageStyle } : {}),
        ...(needsDecode ? { imageDecode: true } : {}),
        ...(first.uiMarks ? { uiMarks: first.uiMarks } : {}),
      };
      /**
       * 落盘源状态（**含 `@put:{k:v}` / `java.put(k,v)` / `source.setVariable` 的写入**）。
       *
       * ⚠️ **本阶段此前漏了这一步**（2026-09-22 修，缺陷类AG）：
       * `putSharedVariable()` 只把值写进**本次请求**的 `variables`，真正落盘靠 `persistSourceState`。
       * detail 有 `prime` 没有 `persist` ⇒ 详情阶段写的 `bid` 到正文阶段就没了。
       * 实测（🏷七猫[官方]v3.1）：`BookInfo.name = "title@put:{bid:id}"` 在详情阶段确实执行
       * （`[put] bid = 203436`），但 `data/kv.json` 里该源的 `source-var:` 仍是 `{}`；
       * 正文脚本 `java.get("bid")` 拿到空串 → 请求 URL 变成 `.../chapter/content?&id=&chapterId=630355`
       * → 站点返回不含 `data` → `RULE_PARSE@parse`。
       * 失败路径也要落盘：已经发生的写入是**真实副作用**，不该因为后续字段/目录出错而丢弃。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 落盘失败不影响本次结果 */
      }
      timer.end(result);
      return result;
    } catch (e) {
      timer.end(undefined, e);
      /**
       * 落盘源状态（**含 `@put:{k:v}` / `java.put(k,v)` / `source.setVariable` 的写入**）。
       *
       * ⚠️ **本阶段此前漏了这一步**（2026-09-22 修，缺陷类AG）：
       * `putSharedVariable()` 只把值写进**本次请求**的 `variables`，真正落盘靠 `persistSourceState`。
       * detail 有 `prime` 没有 `persist` ⇒ 详情阶段写的 `bid` 到正文阶段就没了。
       * 实测（🏷七猫[官方]v3.1）：`BookInfo.name = "title@put:{bid:id}"` 在详情阶段确实执行
       * （`[put] bid = 203436`），但 `data/kv.json` 里该源的 `source-var:` 仍是 `{}`；
       * 正文脚本 `java.get("bid")` 拿到空串 → 请求 URL 变成 `.../chapter/content?&id=&chapterId=630355`
       * → 站点返回不含 `data` → `RULE_PARSE@parse`。
       * 失败路径也要落盘：已经发生的写入是**真实副作用**，不该因为后续字段/目录出错而丢弃。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 落盘失败不影响本次结果 */
      }
      if (e instanceof EngineError) throw e;
      if (isNetworkError(e)) {
        throw new EngineError('NETWORK', 'request', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          input: String(e instanceof Error ? e.message : e),
          trace: ctx.trace.tail(20),
          cause: causeOf(e),
          retryable: true,
        });
      }
      throw new EngineError('RULE_PARSE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        input: withJsLibHint(ctx, String(e instanceof Error ? e.message : e)),
        trace: ctx.trace.tail(20),
        cause: causeOf(e),
        retryable: false,
      });
    }
  }

  /**
   * `#583` **源脚本 UI 动作求值**（Legado 图片选项 `click` / `ruleContent.callBackJs`）。
   *
   * ## 为什么需要（缺陷类别）
   * 七猫把段评/本章说/书评做成**正文里的图片按钮**：图片的 `src` 尾巴挂一段
   * `{"style":"text","type":"qmpl","click":"qmC_OpenComment(…)"}`。点击要执行的是
   * **源 jsLib 的函数**（内部再 `java.ajax` 拉评论、`java.showBrowser` 弹面板）——
   * 浏览器侧没有这套环境，只能在引擎里跑。
   *
   * ## 实现纪律
   * · **同一份环境**：与 `detail/content` 共用 `makeEnv` + `makeSourceStub`
   *   （jsLib / 源变量 / 登录头 / 请求头 / worker 分流全部一致，不另写半套）。
   * · **bindings 对齐上游**（Legado `WebView` 里执行源 JS 的绑定）：`java` / `source` /
   *   `book` / `chapter` / `baseUrl` / `result` / `event`（`callBackJs` 按它分支）。
   * · `java.showBrowser` 的出口是 `onBrowserOpen`（`__browserUrl`）—— 与登录流程同一记录点，
   *   `browserUrl` 原样回传前端（data URL 或 http）。
   * · 脚本里的 `source.put / java.put` **要落盘**（`qm_c_device` / token 缓存靠它），故 persist。
   */
  async evalUiAction(
    rule: CompiledBookSource,
    req: UiActionRequest,
    ctx: EngineContext,
  ): Promise<UiActionResult> {
    const code = String(req.code ?? '').trim();
    if (!code) throw new EngineError('RULE_PARSE', 'validate', {
      engine: this.kind,
      sourceId: ctx.sourceId,
      input: 'code',
      trace: [],
      retryable: false,
    });
    const timer = ctx.trace.begin('parse', 'uiAction', req.event ?? 'click');
    try {
      await primeSourceState(ctx);
      await primeJsLibCached(ctx, rule.jsLib); // #607：jsLib 落盘（内存→磁盘→网络），避免每次都同步 curl 60s
      ctx.variables.delete('__browserUrl');
      const env = makeEnv(ctx, rule.bookSourceUrl, rule.jsLib, rule);
      const srcStub = makeSourceStub(ctx, rule as unknown as Record<string, unknown>);
      /**
       * ⚠️ **不要在这里绑 `java`**：`env.javaExtra` 只是几个 hook（putVariable / refreshExplore…），
       * 拿它覆盖求值器的完整 `java` 桩会让 `java.showBrowser` / `java.ajax` 全消失
       * （七猫点击动作的第一跳就是 `typeof java.showBrowser === 'function'`，直接 false）。
       * 求值器默认给的 `java` 桩已经合并了 `javaExtra`（core `makeJavaStub` 的 Proxy）。
       */
      const bindings: Record<string, unknown> = {
        source: srcStub,
        baseUrl: rule.bookSourceUrl,
        result: '',
        event: String(req.event ?? ''),
        title: String(req.bookName ?? ''),
        book: { bookUrl: String(req.bookUrl ?? ''), name: String(req.bookName ?? '') },
        chapter: { url: String(req.chapterUrl ?? ''), title: '' },
      };
      // worker 侧重建 source 需要**可克隆字段快照**（同 runList 的控件脚本路径）
      const srcFields = cloneableFieldsOf(srcStub);
      if (srcFields) bindings[SOURCE_FIELDS_KEY] = srcFields;
      const value = await env.jsEval(code, bindings);
      // 源脚本常把设备指纹/令牌缓存在 source.put 里 ⇒ 必须落盘，否则下次点击重新注册
      try {
        await persistSourceState(ctx);
      } catch {
        /* 落盘失败不影响本次动作 */
      }
      const out: UiActionResult = {
        value: value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value),
        ...(String(ctx.variables.get('__browserUrl') ?? '')
          ? { browserUrl: String(ctx.variables.get('__browserUrl')) }
          : {}),
        ...(ctx.toastSink?.length ? { toasts: [...ctx.toastSink] } : {}),
      };
      timer.end(out);
      return out;
    } catch (e) {
      timer.end(undefined, e);
      /**
       * ★ **失败路径也要落盘「按源状态」**（`#606` 第 4 层，2026-10-24）。
       *
       * 这里包含**全局** cache（`cache:global` / `__srcCache`）—— 也就是 `java.importScript` /
       * `cacheFile` 下载到的**远端 js 文本**（qyyuapi 系的 `common.js` 180KB / `jsLib.js` 42KB /
       * `searchUrl.js`）。上游把这些放在 **ACache 磁盘缓存**里，下载即写，**与业务成败无关**；
       * 本仓旧实现在成功 return 前才 `persistSourceState` ⇒ 一次 RULE_PARSE 就让刚下好的几万字全丢，
       * 下次请求从零再下（实测单请求 60~76s，绝大部分是重复下载）。
       * 落盘失败不能掩盖原始错误 ⇒ 单独 try/catch。
       */
      try {
        await persistSourceState(ctx);
      } catch {
        /* 存储失败不改变本次错误的定性 */
      }
      if (e instanceof EngineError) throw e;
      throw new EngineError('RULE_PARSE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        input: withJsLibHint(ctx, String(e instanceof Error ? e.message : e)),
        trace: ctx.trace.tail(20),
        cause: causeOf(e),
        retryable: false,
      });
    }
  }
}
