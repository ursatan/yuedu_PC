/**
 * 同步 HTTP 的 **`worker_threads` 实现**（`#160`）—— **不依赖任何子进程**。
 *
 * ## 为什么需要它
 * `java.ajax` 在源脚本里是**同步语义**（`var s = java.ajax(u); JSON.parse(s)`），所以 L1 求值器
 * 需要一个「同步取回网络响应」的手段。原实现是 `execFileSync('curl')`，代价：
 *  1. **环境决定能力**：本机只要起不了子进程（沙箱 / 杀软 / 受限环境），**所有** `java.ajax` 恒返回空串，
 *     而症状伪装成「站点返回空 / RULE_PARSE」（`#159` 让它喊出来了，但没解决）；
 *  2. 每次都 fork 一个进程（Windows 上尤其贵），并**阻塞事件循环**（`recordBlock('curl')` 埋点就是它）。
 *
 * ## 原理（已用 20 行实验验证）
 * 主线程 `Atomics.wait` **阻塞等待**（Node 允许在主线程 wait，浏览器不允许）；
 * worker 内用 `fetch` 异步取回来，把结果写进 **`SharedArrayBuffer`**，最后 `Atomics.notify`。
 * ⚠️ 结果**不能经 `postMessage` 回传** —— 主线程阻塞期间收不到 message（这是整个方案的关键点）。
 * 请求参数走 `postMessage`（投递不需要主线程处理事件循环）。
 *
 * ## 与 `curlSyncFetch` 的语义差异（有意为之，且更好）
 * | 项 | curl | 本实现 |
 * |---|---|---|
 * | 空值头（`{'AUTHORIZATION':''}`） | `-H 'Name:'` 是**删除该头**，必须写 `-H 'Name;'` 绕（缺陷类AI） | `fetch` 原样发出，**不需要绕** |
 * | 重定向 | `-L` 跟随 | `redirect: 'follow'` |
 * | 代理 | curl 读 `http_proxy` | undici **直连**（与引擎侧 `HttpClient` 一致） |
 * | 失败 | 抛错 → 分类留痕 | 返回 `status:0` + 空 body，`err` 只进调试日志 |
 *
 * ## 兜底与开关（`#749` D2 收口后）
 * `YUEDU_SYNC_FETCH`：`worker`（默认）· `curl`（人工强制旧行为）。
 *
 * ⚠️ **`execFileSync curl` 默认不再参与自动回退**：它是**主线程子进程**（历史 `curl` 阻塞 max 20s、
 * 且 `spawn` 在受限环境恒失败），把它挂在 worker 失败之后，等于「异步失败 ⇒ 同步再冻一次」。
 * 现在 worker 链路失败（发布超时）只在同一机制内**重建 worker 重试一次**；仍失败则：
 *   · `YUEDU_CURL_FALLBACK=1`（人工开关）⇒ 起 curl；
 *   · 否则 ⇒ 返回空响应（status 0）+ **一次性**留痕 + `/api/diag` 计数（不静默）。
 *
 * 本机没有 `SharedArrayBuffer` / `Atomics.wait` / `worker_threads` 时同理：默认返回空响应，
 * 只有 `YUEDU_CURL_FALLBACK=1` 才回落 curl。
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { SyncHttpRequest, SyncHttpResponse } from '../selector/js';
import { curlSyncFetch } from '../selector/js';
// `#476`：`Atomics.wait` 主线程同步阻塞的埋点（见本文件 wait 处注释）
import { recordBlock } from '../diag/block-stats';
// `#773`：这条 `Atomics.wait` 此前**没有 marker**（`recordBlock` 在 wait 返回后才记）⇒
// `[stall]` 只能给出 `d=0 open=`（看不出主线程在等什么）。补 enter/leave + 慢等待日志。
import { isFreezeProbeEnabled, probeEnter, probeLeave } from '../diag/freeze-probe';
// `#749` D2：`curl` 兜底默认关闭的取舍计数（`/api/diag` 的 `l1.curl`）
import { noteCurlFallback } from '../diag/l1-stats';
import { withDefaultUserAgent } from './user-agent';

/** SAB 布局：`[0..255]` 元数据 · `[4096..+64K)` 头部 JSON · 其后为响应体 */
const META_BYTES = 256;
const HEAD_OFF = 4096;
const HEAD_CAP = 64 * 1024;
const BODY_OFF = HEAD_OFF + HEAD_CAP;
/** 元数据槽位（Int32Array 下标） */
const M_STATUS = 0;
const M_BODY_LEN = 1;
const M_HEAD_LEN = 2;
/** 完成标志：worker 写完所有数据后置 1 并 notify（这就是「发布点」） */
const M_FLAG = 3;
const M_GEN = 4;

const DEFAULT_MAX_BODY = 8 * 1024 * 1024;

function maxBodyBytes(): number {
  const mb = Number(process.env.YUEDU_NET_MAX_BODY_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : DEFAULT_MAX_BODY;
}

/**
 * `#742` worker 是 `{ eval: true }` ⇒ `require('undici')` 会按**进程 cwd** 解析：
 * 实测在 `apps/server` 与仓库根都是 `Cannot find module 'undici'`（pnpm 严格布局，
 * 依赖只在 `packages/core/node_modules`）。所以**宿主侧先解析出绝对路径**再嵌进 worker 源码。
 *
 * 拿不到（如桌面 bundle 里 undici 已被内联、磁盘上没有 node_modules）⇒ **不启用直连**，
 * 该请求按原来的系统 DNS 走（行为零变化，只少一条加速路径），并留一条日志。
 * 可用 `YUEDU_UNDICI_PATH` 显式指定。
 */
const UNDICI_PATH = ((): string => {
  const explicit = process.env.YUEDU_UNDICI_PATH?.trim();
  if (explicit) return explicit;
  try {
    return createRequire(import.meta.url).resolve('undici');
  } catch {
    return '';
  }
})();

/**
 * worker 源码。⚠️ 用模板串承载 ⇒ **注释里不能出现反引号**（会被外层模板串截断，本仓踩过）。
 */
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const { Buffer } = require('node:buffer');
const UNDICI_PATH = ${JSON.stringify(UNDICI_PATH)};
const META_BYTES = ${META_BYTES};
const HEAD_OFF = ${HEAD_OFF};
const HEAD_CAP = ${HEAD_CAP};
const BODY_OFF = ${BODY_OFF};
const M_STATUS = ${M_STATUS}, M_BODY_LEN = ${M_BODY_LEN}, M_HEAD_LEN = ${M_HEAD_LEN}, M_FLAG = ${M_FLAG}, M_GEN = ${M_GEN};

parentPort.on('message', async (m) => {
  const { sab, gen, method, url, headers, body, timeoutMs, noRedirect, binary, dnsIp } = m;
  const meta = new Int32Array(sab, 0, META_BYTES / 4);
  const head = new Uint8Array(sab, HEAD_OFF, HEAD_CAP);
  const bodyU8 = new Uint8Array(sab, BODY_OFF);
  // #614：binary 时要原始字节（字体/图片），不能 r.text() 解码（非法字节变 U+FFFD，不可逆）
  let status = 0, out = '', raw = null, hdrs = {}, setCookie = [], err = '';
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));
    // #387c：noRedirect（java.get/post/head）→ manual。Node/undici 下 manual 保留真实 3xx + Location
    const init = { method, redirect: noRedirect ? 'manual' : 'follow', signal: ac.signal, headers };
    if (body !== undefined && body !== null && body !== '') init.body = body;
    // #742 IP direct（源码选项 dnsIp）：只换「域名→地址」，Host 头与 TLS SNI 仍由 URL 决定。
    // ⚠️ undici 用**宿主解析好的绝对路径** require（worker eval 按 cwd 解析会找不到模块，
    // 那会让所有带 dnsIp 的同步请求静默失败 = 空响应）。没有路径时退回系统 DNS，行为不变。
    var dnsList = [];
    var makeDnsAgent = null;
    var dnsErr = function (e) { return String((e && e.cause && e.cause.code) || (e && e.code) || ''); };
    var dnsSwitchableCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];
    // 默认用全局 fetch；IP 直连时换成**同一份 undici 的 fetch**（Agent 必须与 fetch 同模块，
    // 否则 dispatcher 可能被忽略）。拿不到 undici 就保持全局 fetch + 不做直连。
    var fetchImpl = fetch;
    if (dnsIp) {
      if (!UNDICI_PATH) {
        console.warn('[syncfetch:worker] 源选项 dnsIp=' + String(dnsIp) + ' 未生效：未解析到 undici 绝对路径（可用 YUEDU_UNDICI_PATH 指定）；本请求按系统 DNS 走');
      } else {
      var netMod = require('node:net');
      var dnsMod = require('node:dns');
      // 绝对路径，避免 worker(eval) 按 cwd 解析失败的坑（见宿主 UNDICI_PATH 注释）
      var undiciMod = require(UNDICI_PATH);
      if (typeof undiciMod.fetch === 'function') fetchImpl = undiciMod.fetch;
      // ⚠️ 模板串里别写反斜杠转义：会被外层模板吃掉，worker 直接 "missing ) after argument list"
      var stripBracket = function (x) {
        var s = String(x);
        if (s.charAt(0) === '[') s = s.slice(1);
        if (s.charAt(s.length - 1) === ']') s = s.slice(0, -1);
        return s;
      };
      var schemeIdx = String(url).indexOf('://');
      var rest = schemeIdx >= 0 ? String(url).slice(schemeIdx + 3) : String(url);
      var cut = rest.search(/[/?#]/);
      var targetHost = stripBracket(cut >= 0 ? rest.slice(0, cut) : rest).toLowerCase();
      dnsList = String(dnsIp).split(',').map(function (x) { return stripBracket(x.trim()); }).filter(function (x) { return x && netMod.isIP(x); });
      makeDnsAgent = function (ip) {
        var family = netMod.isIP(ip);
        var lookup = function (h, o, cb) {
          if (String(h).toLowerCase() === targetHost) {
            if (o && o.all) return cb(null, [{ address: ip, family: family }]);
            return cb(null, ip, family);
          }
          return dnsMod.lookup(h, o, cb);
        };
        return new undiciMod.Agent({ autoSelectFamily: false, connect: { lookup: lookup } });
      };
      }
    }
    var r = null;
    var lastDnsErr = null;
    var ipTries = dnsList.length ? dnsList : [null];
    for (var ipTry = 0; ipTry < ipTries.length; ipTry++) {
      try {
        var initWithIp = Object.assign({}, init, ipTries[ipTry] && makeDnsAgent ? { dispatcher: makeDnsAgent(ipTries[ipTry]) } : {});
        r = await fetchImpl(url, initWithIp);
        break;
      } catch (e) {
        lastDnsErr = e;
        if (ipTry === ipTries.length - 1 || dnsSwitchableCodes.indexOf(dnsErr(e)) < 0) throw e;
      }
    }
    clearTimeout(timer);
    if (!r) throw lastDnsErr;
    status = r.status;
    if (binary) raw = new Uint8Array(await r.arrayBuffer());
    else out = await r.text();
    hdrs = {};
    for (const [k, v] of r.headers) hdrs[k] = v;
    setCookie = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  } catch (e) {
    err = String((e && (e.name + ': ' + e.message)) || e);
  }
  const bb = binary ? Buffer.from(raw || new Uint8Array(0)) : Buffer.from(out || '', 'utf8');
  const bl = Math.min(bb.length, bodyU8.length);
  bodyU8.set(bb.subarray(0, bl));
  const hb = Buffer.from(JSON.stringify({ headers: hdrs, setCookie, err, truncated: bb.length > bl }), 'utf8');
  const hl = Math.min(hb.length, head.length);
  head.set(hb.subarray(0, hl));
  Atomics.store(meta, M_STATUS, status);
  Atomics.store(meta, M_BODY_LEN, bl);
  Atomics.store(meta, M_HEAD_LEN, hl);
  Atomics.store(meta, M_GEN, gen);
  Atomics.store(meta, M_FLAG, 1);
  Atomics.notify(meta, M_FLAG);
});
`;

interface Slot {
  worker: Worker;
  sab: SharedArrayBuffer;
  meta: Int32Array;
  body: Uint8Array;
  head: Uint8Array;
}

let slot: Slot | null = null;
let gen = 0;
let disabled = false;
let warnedDisabled = false;

/** 能不能用 worker 版（本机能力探测；`disabled` 记录「试过但失败了」） */
export function canUseWorkerSyncFetch(): boolean {
  if (disabled) return false;
  try {
    return (
      typeof SharedArrayBuffer === 'function' &&
      typeof Atomics === 'object' &&
      typeof Atomics.wait === 'function' &&
      typeof Worker === 'function'
    );
  } catch {
    return false;
  }
}

function makeSlot(): Slot {
  const sab = new SharedArrayBuffer(BODY_OFF + maxBodyBytes());
  const worker = new Worker(WORKER_SRC, { eval: true });
  // ★ 别拖住进程退出（服务端 Ctrl+C / 测试结束时要能正常退）
  worker.unref();
  worker.on('error', (e) => {
    console.warn('[syncfetch:worker] worker 异常，后续回落 curl：', String(e?.message ?? e));
    cleanup();
    disabled = true;
  });
  worker.on('exit', () => { slot = null; });
  return {
    worker,
    sab,
    meta: new Int32Array(sab, 0, META_BYTES / 4),
    body: new Uint8Array(sab, BODY_OFF),
    head: new Uint8Array(sab, HEAD_OFF, HEAD_CAP),
  };
}

function cleanup(): void {
  const s = slot;
  slot = null;
  try { void s?.worker.terminate(); } catch { /* ignore */ }
}

/** 供测试/收尾调用：停掉常驻 worker */
export function disposeSyncFetchWorker(): void {
  cleanup();
}

/**
 * `#749` worker 版的返回：除 `SyncHttpResponse` 外带一个**内部标记**。
 *
 * 为什么需要区分：`status 0` 有两种完全不同的成因 ——
 *   · **站点/网络失败**（worker 正常出版，`err` 在头部 JSON 里）：重试同一 URL 是源脚本的事；
 *   · **worker 链路失败**（发布超时 / worker 崩了）：这才允许「重建 worker 再试一次」。
 * 混为一谈会让「站点 502」被盲目重打一次，凭空多等一个超时。
 */
export interface WorkerSyncFetchResult extends SyncHttpResponse {
  /** true = 本次是**链路失败**（worker 未发布结果），不是站点返回的失败 */
  yueduLinkFail?: true;
}

/**
 * 同步取回一次 HTTP 响应（`SyncHttpRequest` → `SyncHttpResponse`，与 `curlSyncFetch` 同形状）。
 *
 * ⚠️ 超时后**整个 worker 与 SAB 一起作废重建**：超时意味着 worker 可能还在写，
 * 复用它会让**下一次请求读到上一次的结果**（静默串数据，比慢一点糟得多）。
 */
export function workerSyncFetch(req: SyncHttpRequest): WorkerSyncFetchResult {
  if (!slot) slot = makeSlot();
  const s = slot;
  gen += 1;
  const myGen = gen;
  Atomics.store(s.meta, M_FLAG, 0);
  Atomics.store(s.meta, M_HEAD_LEN, 0);
  Atomics.store(s.meta, M_BODY_LEN, 0);
  Atomics.store(s.meta, M_STATUS, 0);
  s.worker.postMessage({
    sab: s.sab,
    gen: myGen,
    method: req.method,
    url: req.url,
    headers: withDefaultUserAgent(req.headers as unknown as Record<string, string> | undefined),
    // `#644`：只有 POST 带体（上游 GET/HEAD 分支不取 body，见 net/index.ts 同条注释）
    ...(req.method === 'POST' && req.body !== undefined ? { body: req.body } : {}),
    timeoutMs: req.timeoutMs,
    // `#387c`：不跟随重定向（java.get/post/head 的 followRedirects(false)）—— worker 内换成 redirect:'manual'
    ...(req.noRedirect ? { noRedirect: true } : {}),
    // `#614` 要原始字节（字体/图片）：SAB 里本来就是字节，只是**别解码**
    ...(req.binary ? { binary: true } : {}),
    // `#742` IP 直连（源码选项 dnsIp）
    ...(req.dnsIp ? { dnsIp: req.dnsIp } : {}),
  });
  // 等 worker 发布结果（+5s 余量：worker 内自己有 timeoutMs 的 abort，正常不会先到）
  // `#476` 埋点：这条 `Atomics.wait` 是**主线程同步阻塞**、时长 = 该 HTTP 请求的时长
  // （最长 `timeoutMs + 5s`，即十几秒）——此前**没有埋点**，是「有 stall、没 blocks」的盲区。
  // 记 kind `sync-http`（与 curl 路径的 `curl` 区分：那条是子进程、这条是主线程 wait）。
  const waitT0 = Date.now();
  const waitLimit = Math.max(1000, req.timeoutMs) + 5000;
  // `#773`：包住整段等待（含重建 worker 的边界），冻结时就能看到 `open=sync:wait`。
  probeEnter('sync:wait');
  let wait: string;
  try {
    wait = Atomics.wait(s.meta, M_FLAG, 0, waitLimit) as string;
  } finally {
    probeLeave();
  }
  const waitedMs = Date.now() - waitT0;
  recordBlock('sync-http', waitedMs, `${req.method} ${req.url.slice(0, 90)}`);
  // `#773` 取证（仅探针开启时说话）：把「等多久 / 上限多少 / 等谁的 URL」落到日志。
  if (waitedMs >= 500 && isFreezeProbeEnabled()) {
    console.log(`[sync-wait] waited=${waitedMs}ms limit=${waitLimit}ms timeout=${req.timeoutMs ?? '-'} ${req.method} ${req.url.slice(0, 120)}`);
  }
  if (wait === 'timed-out' || Atomics.load(s.meta, M_FLAG) !== 1) {
    cleanup(); // 作废，避免读到上一次的数据
    if (process.env.YUEDU_DEBUG_SYNCFETCH) {
      console.error('[syncfetch:worker] 超时', req.method, req.url, 'wait=', wait);
    }
    return { status: 0, headers: {}, setCookie: [], body: '', yueduLinkFail: true };
  }
  const status = Atomics.load(s.meta, M_STATUS);
  const bodyLen = Atomics.load(s.meta, M_BODY_LEN);
  const headLen = Atomics.load(s.meta, M_HEAD_LEN);
  let parsed: { headers?: Record<string, string>; setCookie?: string[]; err?: string; truncated?: boolean } = {};
  try {
    parsed = JSON.parse(Buffer.from(s.head.subarray(0, headLen)).toString('utf8')) as typeof parsed;
  } catch {
    parsed = {};
  }
  const body = req.binary ? '' : Buffer.from(s.body.subarray(0, bodyLen)).toString('utf8');
  // `#614`：二进制请求把 SAB 里的原始字节原样带回（**不经过任何解码**）
  const bytes = req.binary ? new Uint8Array(s.body.subarray(0, bodyLen)) : undefined;
  if (parsed.err && process.env.YUEDU_DEBUG_SYNCFETCH) {
    console.error('[syncfetch:worker] 请求失败', req.method, req.url, parsed.err);
  }
  if (parsed.truncated) {
    // 截断必须留痕：否则表现成「正文少了后半段」而看不出原因（对齐 net-guard 的 net-truncated）
    console.warn(`[syncfetch:worker] 响应超过上限已截断（${maxBodyBytes()} 字节）：${req.url.slice(0, 120)}`);
  }
  return {
    status: parsed.err ? 0 : status,
    headers: parsed.headers ?? {},
    setCookie: parsed.setCookie ?? [],
    body,
    ...(bytes ? { bytes } : {}),
    // ★ `#152`：worker 侧的截断标记原本到这里就被丢掉（只剩 console.warn）—— 透传给 syncHttp 登记
    ...(parsed.truncated ? { truncated: true } : {}),
  };
}

/** 空响应（与 worker 的失败形状一致；调用方按 status 0 + 空 body 处理） */
function emptySyncResponse(): SyncHttpResponse {
  return { status: 0, headers: {}, setCookie: [], body: '' };
}

/** `YUEDU_CURL_FALLBACK=1` 才允许 `execFileSync curl`（默认**不参与**自动回退，见文件头注） */
function curlFallbackEnabled(): boolean {
  return process.env.YUEDU_CURL_FALLBACK === '1';
}

let warnedCurlBlocked = false;

/**
 * 测试钩子（仓库既有 `__reset*ForTest` 约定）：
 *  · `__setSyncFetchDisabledForTest(true)` 模拟「本机不支持 worker / worker 已坏」；
 *  · `__setWorkerSyncFetchForTest(fn)` 直接替掉 worker 请求实现，用来构造**链路失败**
 *    （真造一次要等 `timeout + 5s` 的 Atomics 超时，单测里不值当）。
 */
let workerSyncFetchImpl: (req: SyncHttpRequest) => WorkerSyncFetchResult = workerSyncFetch;

export function __setSyncFetchDisabledForTest(v: boolean): void {
  if (v) {
    cleanup();
    disabled = true;
  } else {
    disabled = false;
    warnedDisabled = false;
    warnedCurlBlocked = false;
  }
}

export function __setWorkerSyncFetchForTest(fn: ((req: SyncHttpRequest) => WorkerSyncFetchResult) | null): void {
  workerSyncFetchImpl = fn ?? workerSyncFetch;
}

/**
 * 链路失败 / 环境不支持的统一出口：
 * 人工开关开了才起 curl，否则**空响应 + 一次性留痕 + diag 计数**（不静默）。
 */
function onFallback(reason: 'worker-unavailable' | 'worker-link-fail' | 'worker-threw', req: SyncHttpRequest): SyncHttpResponse {
  if (curlFallbackEnabled()) {
    noteCurlFallback(reason, 'curl');
    return curlSyncFetch(req);
  }
  noteCurlFallback(reason, 'blocked');
  if (!warnedCurlBlocked) {
    warnedCurlBlocked = true;
    console.warn(
      `[syncfetch] 同步 HTTP 走不了 worker（${reason}）⇒ **不回落 curl**（默认关闭，避免主线程子进程冻结）。` +
        `本次返回空响应；确需 curl 请显式设 YUEDU_CURL_FALLBACK=1。`,
    );
  }
  return emptySyncResponse();
}

/**
 * **缺省同步传输**：worker 优先；worker 链路失败 ⇒ **同机制内重建重试一次**；
 * `execFileSync curl` 只在 `YUEDU_SYNC_FETCH=curl` 或 `YUEDU_CURL_FALLBACK=1` 下才会被调用。
 */
export function defaultSyncFetch(req: SyncHttpRequest): SyncHttpResponse {
  const mode = (process.env.YUEDU_SYNC_FETCH ?? 'worker').toLowerCase();
  // 人工强制旧路径：唯一「无需再设 YUEDU_CURL_FALLBACK」的 curl 入口（显式即知情）
  if (mode === 'curl') return curlSyncFetch(req);
  if (!canUseWorkerSyncFetch()) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn('[syncfetch] 本机不支持 worker_threads/SharedArrayBuffer ⇒ 默认不回落 curl（见 YUEDU_CURL_FALLBACK）');
    }
    return onFallback('worker-unavailable', req);
  }
  /**
   * 第一次：正常 worker 请求。`yueduLinkFail` 只在**worker 没发布结果**（超时/崩溃）时置位；
   * 站点 5xx / 网络错误仍走「status 0 + 头部 err」的既有语义，不重试。
   */
  let first: WorkerSyncFetchResult;
  try {
    first = workerSyncFetchImpl(req);
  } catch {
    // worker 抛错（构造失败 / postMessage 失败等）⇒ 本轮禁用，避免反复撞同一堵墙
    disabled = true;
    return onFallback('worker-threw', req);
  }
  if (!first.yueduLinkFail) return first;
  // 链路失败：worker 已 cleanup，下一次调用会重建；**再试一次**（异步 HTTP，仍在 worker 线程）
  try {
    const second = workerSyncFetchImpl(req);
    if (!second.yueduLinkFail) return second;
  } catch {
    /* 重试抛错按第二次链路失败处理 */
  }
  return onFallback('worker-link-fail', req);
}
