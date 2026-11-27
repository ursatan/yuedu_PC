/**
 * 网络层（Node-only）
 *
 * 实现 contract/engine.ts 的 HttpClient：基于全局 fetch。
 * 支持：方法 / 自定义头 / 请求体 / 超时中断 / charset 解码（gbk/gb2312）/ 重定向跟随 /
 * 二进制响应（responseType: 'arraybuffer'）。
 *
 * ── 网络护栏（缺陷类T，2026-09-21 新增）─────────────────────────────────────────────
 * **背景（用户实测报告）**：跑全量基线时「占满全部网络资源 → 同局域网其它设备卡死无法上网」，
 * 且伴随服务端 60s 超时暴增。取证后确认三条独立成因：
 *   ① 此前是**裸 `fetch()`**：没有 Agent、没有连接上限、没有并发上限 —— undici 默认对单 origin
 *      的连接数不设上限，一次扇出就能开上百个 socket → **路由器 NAT/连接表被打满**，
 *      同局域网所有设备一起受影响（这就是「其它设备上不了网」的机制，不是"带宽被下满"那么简单）；
 *   ② **无界扇出**：`engine.detail` 的目录多页分支用 `Promise.all(nextUrls.map(fetchPage))`，
 *      源返回 N 个下一页就并发 N 个请求；
 *   ③ **整包下载媒体**：音视频源的 `java.get(媒体URL)` 会把整个 MP3/MP4 拉下来（可达数十 MB），
 *      而我们只需要 URL/元信息 —— 这是真正的"带宽被吃满"的主因。
 *
 * **护栏内容**（全部可用环境变量调整；默认值即"安全默认"）：
 *   | 环境变量 | 默认 | 作用 |
 *   |---|---|---|
 *   | `YUEDU_NET_MAX_CONCURRENT` | 6 | 全局同时在飞的请求数上限（socket 上限） |
 *   | `YUEDU_NET_MAX_PER_HOST` | 2 | 单主机同时在飞上限（避免打单站） |
 *   | `YUEDU_NET_LINK_MBPS` | 100 | 用户线路带宽（Mbps）；护栏取 **30%** |
 *   | `YUEDU_NET_MAX_BPS` | — | 直接指定字节/秒上限，覆盖上面那条 |
 *   | `YUEDU_NET_MAX_BODY_MB` | 8 | 单个响应体上限（超过则截断 + 留痕） |
 *   | `YUEDU_NET_RETRY` | 1 | **幂等请求**（GET/HEAD 无 body）在**连接阶段瞬时失败**时的重试次数 |
 *
 * 为什么默认按「线路 100Mbps 的 30%」而不是写死字节数：用户要求「不超过 30%」，
 * 而"30% 的绝对带宽"取决于用户线路（100M/500M/1000M 差 10 倍）。所以给两个旋钮：
 * 有线路参数就设 `YUEDU_NET_LINK_MBPS`，没有就直接设 `YUEDU_NET_MAX_BPS`。
 *
 * ── post8 大规模「连接超时」归因（2026-09-21 第二轮，护栏的补强）────────────────────
 * 现象：全量基线里 **209 个源（跨 209 个不同主机）全部在 10.1–10.6s 失败于 `连接超时`**，
 * 而 post7 同一批源正常。指纹非常明确 —— `10s` 正是 undici 的 `connectTimeout` 默认值，
 * 且不同主机"同时"连不上 ⇒ **本机侧**，不是 209 个站点同时坏（用户同时观察到整局域网冻结，同因）。
 * 取证：
 *   · DNS 负载探针（`tmp/probe-dns-load.mjs`）：200 并发下 p95 仅 **509ms**、6.5% 失败，
 *     降到 6 并发立刻恢复（p50 15ms）⇒ **DNS 只是次要放大器，不是 10s 级主因**；
 *   · 本机存在 `http_proxy=127.0.0.1:62931`（curl 会走它，Node 的 `fetch` **不读代理环境变量**
 *     → 直连），且部分域名 DNS 被污染（`hddj.tv` 解析到 Facebook 的 IP）；这些站点**经代理也是 502**，
 *     属真不可达，但与"209 主机同时 10s 超时"不是一类；
 *   · 护栏生效后同批真回归样本（post7 通过 → post8b 连接超时，135 个里抽 20 个）：
 *     **0/24 → 22/24 通过**（原 `data/baseline/recheck-cto2.json`；该文件已随 2026-11-25 基线清理删除，
 *     现行保留批次为 `bn*` / `r21..r28` / `bz*`）。
 * 结论：主因是**自身并发把本机连接能力（NAT/端口表）打满**；无界扇出让它一旦越线就整轮越线。
 * 加固：① 护栏把 socket 数封顶（结构上不可能再打满）；② **幂等请求连接阶段自动重试一次**
 * （把瞬时 10s 超时变成可恢复）；③ `netStats` 增加**错误分类计数**，`/api/diag` 一眼可判；
 * ④ 暴露"本机有代理 env 但 Node 不读"这一环境事实，避免再把它误判成站点侧。
 */

import type { HttpClient, HttpRedirect, HttpRequestOptions, HttpResponse } from '../contract/engine';
import { Semaphore } from './semaphore';
import {
  type PoolKind,
  type TaskClass,
  type TaskScope,
  type TrafficLease,
  acquireTraffic,
  createTaskScope,
  noteGlobalPeak,
  noteTrafficResult,
  releaseTraffic,
  resetTraffic,
  trafficConfig,
  trafficFailCooldown,
} from './traffic';
import { recordTruncatedFetch } from './truncated-log';
import { withDefaultUserAgent } from './user-agent';
// `#372`：TLS 证书链 AIA 自动补全（缺中间证书的站点，浏览器能开、Node 默认打不开）
import { CHAIN_INCOMPLETE_TLS_CODES, aiaAgentFor, cachedAiaAgent } from './tls-aia';
import { dnsIpDispatcherFor, parseDnsIpList, urlHostnameOf } from './dns-ip';
import { parseGatekeeperCfg, parseGatekeeperGuide, solveGatekeeperPowAsync } from './gatekeeper';
// `D11`：闸页（年满18岁声明）静默过闸 —— 判据唯一实现在 ./gate-pass（引擎出口 / java.* 出口共用）
import { planAgeGatePass, planCookieGatePass, planJumpPowGate } from './gate-pass';
import { installHardenedDispatcher, insecureTlsDispatcher } from './net-agent';
// `#476`：同步阻塞埋点（`/api/diag` 的 `blocks` 直接点名）——PoW 求解此前**没有**埋点，
// 是「stall 有、blocks 无」的盲区之一（2026-10-15 用户实测排查踩到）
import { recordBlock } from '../diag/block-stats';
/** `#439` 字符集判定/解码的唯一实现（本文件的文本分支与 `/api/proxy` 共用） */
import { decodeText } from './charset';

/**
 * `#332` 用户侧修复：**模块加载即安装加固 dispatcher**（关 `autoSelectFamily`）。
 *
 * 本机双栈 DNS + IPv6 出口不通时，Node 默认的 Happy Eyeballs 会「四地址整体并行等 10s」
 * ⇒ 全部连接超时。此前只能靠探针带 `NODE_OPTIONS=--no-network-family-autoselection` 规避，
 * **用户侧（正常启动的服务端 / 桌面端）没有这条 env ⇒ 症状仍在**。
 * 这里把它做成引擎自带默认（详见 `net-agent.ts`）。
 */
installHardenedDispatcher();

/**
 * 网络错误 → 可读原因（#85 错误分级）。
 *
 * 为什么必须做：基线实测 557 源里 **42 个**报 `NETWORK@request: fetch failed` —— 这句
 * 「fetch failed」把四种完全不同的情况混成一句，导致「站点侧不可控」的误判反复出现。
 * 实测归因（`scripts/dbg-net.mjs --class fetchfailed`）：
 *   · `ENOTFOUND/ENOENT`（域名已失效）· `CERT_HAS_EXPIRED` / `ERR_TLS_CERT_ALTNAME_INVALID`
 *   · `ECONNREFUSED` / `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT`
 * 这些**都是站点侧**，但只有把原因写出来才能一眼判定，而不是去查引擎。
 */
const NET_ERROR_REASONS: Record<string, string> = {
  ENOTFOUND: 'DNS 解析失败（域名可能已失效）',
  ENOENT: 'DNS 解析失败（域名可能已失效）',
  EAI_AGAIN: 'DNS 暂时不可用（可重试）',
  ECONNREFUSED: '连接被拒绝（端口未开放）',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_HEADERS_TIMEOUT: '响应头超时',
  UND_ERR_BODY_TIMEOUT: '响应体超时',
  UND_ERR_SOCKET: '连接中断',
  CERT_HAS_EXPIRED: 'TLS 证书已过期（站点证书问题）',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配（站点证书问题）',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 自签名证书（站点证书问题）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证（站点证书问题）',
  ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED: 'TLS 证书签名算法不受支持',
  EPROTO: 'TLS/协议错误',
  ERR_INVALID_URL: 'URL 非法',
  ERR_NETWORK_CHANGED: '网络中断/切换',
  ERR_INTERNET_DISCONNECTED: '本机网络断开',
  ENETUNREACH: '网络不可达',
  ECONNABORTED: '连接被中止',
};

/**
 * 可读原因后面的**可操作提示**（只在最需要的几类上加，避免文案噪音）。
 *
 * 重点是「连接超时」：它的公认可读解释是"站点慢"，但 post8 实测里它的主导成因是**本机侧**
 * （连接能力被打满 / 需要走代理而 Node 不走 / DNS 被污染），不加提示就会反复误判成站点问题。
 */
const NET_ERROR_HINTS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT:
    '本机未在 10s 内建立连接（常见成因：本机连接数被占满、DNS 被污染、或该站需走代理而 Node 的 fetch 不读系统代理）',
  ETIMEDOUT: '本机未在 10s 内建立连接（常见成因：本机连接数被占满、DNS 被污染、或该站需走代理而 Node 的 fetch 不读系统代理）',
  EAI_AGAIN: 'DNS 服务器暂时不可用，稍后重试即可（多为本机/路由器 DNS 被自身请求量压住）',
  ENOTFOUND: '域名解析不出地址（域名失效，或本机 DNS 被污染/被拦截）',
};

/** 取出底层错误码（fetch 会把真实 code 放在 `cause.code`） */
function netErrCode(e: unknown): string {
  const err = e as { cause?: { code?: string }; code?: string } | null;
  return err?.cause?.code ?? err?.code ?? '';
}

/** 把 fetch 抛出的错误转成一行可读原因（保留原始 code 便于再分类） */
export function describeNetworkError(e: unknown, timeoutMs?: number): string {
  const err = e as Error & { cause?: { code?: string; message?: string }; code?: string };
  const code = err?.cause?.code ?? err?.code ?? '';
  const hint = code ? NET_ERROR_HINTS[code] : undefined;
  const withHint = (reason: string): string => (hint ? `${reason}（${hint}）` : reason);
  if (code && NET_ERROR_REASONS[code]) return withHint(NET_ERROR_REASONS[code] as string);
  const msg = String(err?.cause?.message ?? err?.message ?? e);
  if (/abort/i.test(err?.name ?? '') || /aborted/i.test(msg)) {
    return timeoutMs ? `请求超时（>${timeoutMs}ms）` : '请求被中断/超时';
  }
  // 把内层 cause 的文本也带出来（否则只剩一句 "fetch failed"）
  const causeMsg = String(err?.cause?.message ?? '');
  if (/fetch failed/i.test(msg) && causeMsg) return `请求失败（${causeMsg}）`;
  return code ? `${code}${msg && msg !== code ? `：${msg}` : ''}` : msg;
}

/* ────────────────────────────── 护栏实现 ────────────────────────────── */

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

export interface NetGuardConfig {
  /** 全局同时在飞上限（= socket 上限） */
  maxConcurrent: number;
  /** 单主机同时在飞上限 */
  maxPerHost: number;
  /** 全局字节/秒上限（令牌桶速率） */
  maxBytesPerSec: number;
  /** 单响应体上限（字节）；超过则截断并留痕 */
  maxBodyBytes: number;
  /** 幂等请求在连接阶段瞬时失败时的重试次数 */
  maxRetries: number;
}

/** 护栏配置（可在运行时被 `configureNetGuard` 覆盖；测试与内嵌实例用它） */
let guardConfig: NetGuardConfig | null = null;

/**
 * 组装默认护栏：线路 100Mbps 的 **45%**（★ 2026-10-02 用户按参考设置上调：
 * 「上行/下行带宽占据不超 45%」，原为 30%），可用环境变量 `YUEDU_NET_LINK_MBPS` / `YUEDU_NET_MAX_BPS` 调整。
 */
export function defaultNetGuardConfig(): NetGuardConfig {
  const linkMbps = envInt('YUEDU_NET_LINK_MBPS', 100);
  const fortyFivePercentBps = Math.max(16 * 1024, Math.floor(((linkMbps * 1_000_000) / 8) * 0.45));
  return {
    maxConcurrent: envInt('YUEDU_NET_MAX_CONCURRENT', 6),
    maxPerHost: envInt('YUEDU_NET_MAX_PER_HOST', 2),
    maxBytesPerSec: envInt('YUEDU_NET_MAX_BPS', fortyFivePercentBps),
    maxBodyBytes: envInt('YUEDU_NET_MAX_BODY_MB', 8) * 1024 * 1024,
    maxRetries: envInt('YUEDU_NET_RETRY', 1),
  };
}

/** 当前生效的护栏（首次访问时按环境变量初始化） */
export function netGuardConfig(): NetGuardConfig {
  guardConfig ??= defaultNetGuardConfig();
  return guardConfig;
}

/** 覆盖护栏（测试/特殊实例用）。传 `null` 恢复按环境变量重建。 */
export function configureNetGuard(cfg: Partial<NetGuardConfig> | null): NetGuardConfig {
  guardConfig = cfg === null ? defaultNetGuardConfig() : { ...netGuardConfig(), ...cfg };
  return guardConfig;
}

/**
 * 本机**网络环境事实**（诊断用，`/api/diag` 会带上它）。
 *
 * 为什么需要：本机 `http_proxy/https_proxy` 指向一个本地代理（curl 走它），而
 * **Node 的 `fetch` 不读这些环境变量**（Node 22 没有 `--use-env-proxy`）—— 于是"curl 通"
 * 完全不能证明"引擎通"（反之亦然）。post8 归因时我用 curl 成功得出过"网络没问题"的结论，
 * 这个推论在**代理不一致**的前提下是不成立的 —— 把它显式暴露出来，避免后人重犯。
 */
export function netEnvFacts(env: Record<string, string | undefined> = process.env): {
  /** 本机代理环境变量（`http_proxy`/`https_proxy`/`no_proxy`），未设置则为空 */
  proxyEnv: Record<string, string>;
  /** Node 的 fetch 是否会被配置为走该代理（当前实现：否，见上） */
  fetchUsesProxy: boolean;
  /** 是否处于"有代理但不走"的易误判状态 */
  proxyMismatch: boolean;
} {
  const keys = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
  const proxyEnv: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v) proxyEnv[k] = v.replace(/\/\/[^@/]*@/, '//***@'); // 去掉可能的账号密码
  }
  const hasProxy = Boolean(proxyEnv['http_proxy'] ?? proxyEnv['HTTP_PROXY'] ?? proxyEnv['https_proxy'] ?? proxyEnv['HTTPS_PROXY']);
  return { proxyEnv, fetchUsesProxy: false, proxyMismatch: hasProxy };
}

/**
 * 并发计数器已抽到 `./semaphore`（`#200` 起被 v1 护栏与 v2 流量护栏共用，避免循环依赖）。
 * 这里**再导出**以保持既有引用路径 —— `__tests__/net-priority.test.ts` 从本文件 import。
 *
 * （原有设计说明见 `./semaphore` 的模块注释：两级优先 + 各自 FIFO，低优先只在排队时让位。）
 */
export { Semaphore };

/** 全局在飞 */
const globalSem = new Semaphore(() => netGuardConfig().maxConcurrent);
/** 单主机在飞（按 host 隔离；条目不回收，量级 = 语料主机数，可忽略） */
const hostSems = new Map<string, Semaphore>();
function hostSem(host: string): Semaphore {
  let s = hostSems.get(host);
  if (!s) {
    s = new Semaphore(() => netGuardConfig().maxPerHost);
    hostSems.set(host, s);
  }
  return s;
}

/**
 * 全局令牌桶：**唯一**的带宽闸门。
 *
 * 语义：取到令牌才允许把这段字节读进来。速率 = `maxBytesPerSec`，桶容量 = 速率的 1/4
 * （下限 64KB）——容量不能太大，否则「一秒钟的突发」就能把线路打满，失去限速意义。
 */
class TokenBucket {
  private tokens = 0;
  private last = Date.now();
  private waiters: Array<{ need: number; resolve: () => void }> = [];

  private refill(): void {
    const now = Date.now();
    const rate = netGuardConfig().maxBytesPerSec;
    this.tokens = Math.min(capacityOf(rate), this.tokens + ((now - this.last) / 1000) * rate);
    this.last = now;
  }

  async take(bytes: number): Promise<void> {
    const rate = netGuardConfig().maxBytesPerSec;
    // 单块就超过桶容量时按容量放行（否则永远取不满 → 死等）；下一块会自然被限速
    const need = Math.min(bytes, capacityOf(rate));
    for (;;) {
      this.refill();
      if (this.tokens >= need) {
        this.tokens -= need;
        return;
      }
      const miss = need - this.tokens;
      const waitMs = Math.max(5, Math.ceil((miss / rate) * 1000));
      await new Promise<void>((resolve) => {
        this.waiters.push({ need, resolve });
        setTimeout(() => {
          const i = this.waiters.findIndex((w) => w.resolve === resolve);
          if (i >= 0) {
            this.waiters.splice(i, 1);
            resolve();
          }
        }, waitMs);
      });
    }
  }
}
function capacityOf(rate: number): number {
  return Math.max(64 * 1024, Math.floor(rate / 4));
}
const bucket = new TokenBucket();

/**
 * 网络护栏统计（诊断/测试用；`/api/diag`、`scripts/baseline.mjs` 与回归测试都读它）。
 *
 * `err*` 四个计数器是 **post8 归因的直接产物**：那轮 209 个主机全报 `连接超时`，
 * 但当时没有任何分类计数，只能靠事后翻 JSON 统计。现在跑完一轮 `/api/diag` 就能一眼判：
 * 如果 `errConnectTimeout` 成规模，先怀疑**本机连接能力/环境**，而不是站点。
 */
export const netStats = {
  /** 实际发出的 HTTP 尝试次数（含重试） */
  requests: 0,
  peakInFlight: 0,
  inFlight: 0,
  bytes: 0,
  truncated: 0,
  throttledMs: 0,
  /** 连接阶段瞬时失败后的重试次数 */
  retries: 0,
  /** 重试后最终成功的次数 */
  retryRecovered: 0,
  /** `#372` AIA 证书链补全重试次数（>0 = 遇到过缺中间证书的站点且已自动兜住） */
  aiaRetries: 0,
  /** 最终失败于「10s 内没建立连接」（本机侧或站点侧都可能，需结合计数面判） */
  errConnectTimeout: 0,
  /** 最终失败于 DNS 解析 */
  errDns: 0,
  /** 最终失败于连接被重置/中断 */
  errReset: 0,
  /** 最终失败于整体超时（我们自己的 AbortController） */
  errTimeout: 0,
  errOther: 0,
};
export function resetNetStats(): void {
  // `#200`：诊断计数与流量护栏状态一起重置（`/api/diag?reset=1` 语义要完整）
  resetTraffic();
  netStats.requests = 0;
  netStats.peakInFlight = 0;
  netStats.inFlight = 0;
  netStats.bytes = 0;
  netStats.truncated = 0;
  netStats.throttledMs = 0;
  netStats.retries = 0;
  netStats.retryRecovered = 0;
  netStats.aiaRetries = 0;
  netStats.errConnectTimeout = 0;
  netStats.errDns = 0;
  netStats.errReset = 0;
  netStats.errTimeout = 0;
  netStats.errOther = 0;
}

/** 把最终失败按错误码归类计数（供事后一眼判"哪一类"） */
function bumpErrCounter(code: string, aborted: boolean): void {
  if (aborted) {
    netStats.errTimeout++;
    return;
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') netStats.errConnectTimeout++;
  else if (code === 'ENOTFOUND' || code === 'ENOENT' || code === 'EAI_AGAIN') netStats.errDns++;
  else if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ECONNABORTED') netStats.errReset++;
  else netStats.errOther++;
}

/**
 * 可重试的错误码 —— 只收**连接阶段**的瞬时故障。
 *
 * 刻意**不含**：`ENOTFOUND`（域名真的不存在，重试无意义）、TLS 证书类（确定性失败）、
 * `ECONNREFUSED`（端口没开，重试只会白等）、以及我们自己的 abort（时间预算已耗尽）。
 */
const RETRYABLE_NET_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN']);

function warnOnce(key: string, msg: string): void {
  const seen = (warnOnce as unknown as { seen?: Set<string> }).seen ?? ((warnOnce as unknown as { seen?: Set<string> }).seen = new Set<string>());
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(`[net-guard] ${msg}`);
}

/**
 * `#470c` 留痕：媒体响应体被**主动丢弃**（不按文本读，见 `fetchOnce` 里的 `#470c` 闸门）。
 * 按 **host** 去重（一个 CDN 只报一次），否则每首歌/每个分片都会刷一行。
 */
function warnMediaBodySkip(url: string, ctype: string): void {
  // ⚠️ 刻意**不用 `new URL(...)`**：本函数会被 L1 求值链间接调用，而 L1 期间 `globalThis.URL`
  // 会被换成 Rhino 垫片（自递归抛 RangeError）——见仓库纪律「会被 eval 内调用的模块别用全局构造器」。
  // 去重只需要 host，字符串切一下足够。
  const host = url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || url;
  warnOnce(`media-body-skip:${host}`, `媒体响应体不按文本读取（已主动丢弃，避免拉整包撞体积护栏）：${ctype} @ ${url.slice(0, 100)}`);
}

/**
 * 读响应体：**流式**读取 + 令牌桶限速 + 体积上限。
 *
 * `#470` 抽出为独立导出：`/api/proxy` 改为「先拿响应头、再按 Content-Type 分岔」——
 * 音视频（`audio/*|video/*`，上游说了算，不再依赖 URL 扩展名）直接管道；
 * 其余（图片/文本/HLS 清单）在**服务端**把流转回缓冲，必须走这同一份护栏
 * （令牌桶限速 + 8/32MB 截断 + `netStats` 计数），否则代理流量就逃逸出护栏了。
 */
export async function readStreamLimited(
  body: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
  url: string,
  /**
   * `#747` **响应体的总读取预算（毫秒）** —— 0/缺省 = 不设限（与从前一致）。
   *
   * `timeout` 只覆盖到「响应头到手」，头一到 core 就返回、并发槽即释放；**慢镜像的体
   * 则可以无限期挂着**（实测 `s3.go2778.com` 单图 43~60s，用户日志「已 10s、已 20s…」）。
   * 这些挂住的请求会持续占着浏览器的同源连接与用户视野里的「加载中」，还会把图片洪峰
   * 拉长成持续的 CPU 压力（图片解密是主线程同步 JS）⇒ 目录解析被挤到 9~18s。
   * 图片调用方传 10s，到点取消流并抛 `BODY_DEADLINE`（快速失败，客户端走占位图）。
   */
  deadlineMs?: number,
): Promise<{ buf: Uint8Array; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineMs && deadlineMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      // 取消会立刻让挂起的 `reader.read()` 以 done 结束（不必再 race 一个 reject Promise）
      reader.cancel().catch(() => {});
    }, deadlineMs);
    timer.unref?.();
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const t0 = Date.now();
      await bucket.take(value.length);
      netStats.throttledMs += Date.now() - t0;
      const room = maxBodyBytes - total;
      if (value.length >= room) {
        chunks.push(value.subarray(0, Math.max(0, room)));
        total += Math.max(0, room);
        truncated = true;
        // 截断即停：**不再继续读**（这才是省带宽的关键 —— 媒体大包不该整包拉下来）
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (timedOut) {
    const err = new Error(`响应体读取超时（${deadlineMs}ms，${total}B 后放弃）：${url.slice(0, 120)}`);
    (err as Error & { code?: string }).code = 'BODY_DEADLINE';
    throw err;
  }
  netStats.bytes += total;
  if (truncated) {
    netStats.truncated++;
    warnOnce(
      `body:${new URL(url, 'http://x').host}`,
      `响应体超过上限 ${(maxBodyBytes / 1048576).toFixed(0)}MB，已截断（${url.slice(0, 120)}）——` +
        `如需完整响应请调大 YUEDU_NET_MAX_BODY_MB`,
    );
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { buf: out, truncated };
}

/** Response 便捷封装：无 body（204/HEAD 等）直接空缓冲，否则走 `readStreamLimited` */
async function readBodyLimited(res: Response, maxBodyBytes: number, url: string): Promise<{ buf: Uint8Array; truncated: boolean }> {
  const body = res.body;
  if (!body) return { buf: new Uint8Array(0), truncated: false };
  return readStreamLimited(body, maxBodyBytes, url);
}

/**
 * `#372`：fetchOnce 的单次请求体（原 `fetch(...)` 调用抽出来）。
 * `aiaAgent` 提供时走带 ca 的 dispatcher（undici Agent），否则与从前完全一致。
 */
/**
 * `#699` 跟随重定向的**跳数上限**。取 20 与 fetch 规范 / undici 默认一致 ——
 * 我们只是把「谁去跟」从 undici 挪到自己手里，**上限不能顺手改**，
 * 否则同一个站点在 `redirect:'follow'` 与这里的表现会分叉。
 */
const MAX_REDIRECT_HOPS = 20;

/**
 * `#742` `dnsIp` 多值切换的错误码白名单：只有「没连上」才换下一个 IP。
 * 拿到响应（含 401/403/5xx）一律视为「这条线路通了」，不再换 —— 与上游 OkHttp
 * 只在 `IOException`（连接/握手）时换地址一致。
 */
const DNS_IP_SWITCHABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** 哪些 3xx 是要跟的（300/304/305/306 不是「换个地址再取一次」） */
function isFollowableRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * `#699` 一跳重定向之后**用什么方法**（fetch 规范 §HTTP-redirect fetch）：
 *  · `303` 一律变 `GET`（`HEAD` 保持 `HEAD`）；
 *  · `301`/`302` 且原方法是 `POST` ⇒ 变 `GET`（浏览器/undici 的历史兼容行为，绝大多数站点依赖它）；
 *  · `307`/`308` **方法不变**（这俩状态码存在的意义就是「保方法保体」）。
 */
function redirectMethod(status: number, method: string): string {
  if (method === 'HEAD') return 'HEAD';
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

/** 同源判定（协议+主机+端口）；跨源时按规范要摘掉凭据头 */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * `Location` → 绝对地址。
 *
 * 站点写什么的都有：绝对 URL、`/path`、`?page=2`、带空格的中文、甚至 `//host/path`。
 * 「带空格/中文」的绝对 URL 直接 `new URL()` 能过（会自己编码），但**相对**里带空格时
 * 某些实现会抛 ⇒ 统一兜一层：失败就返回原串（宁可请求失败也不吞掉站点给的地址）。
 */
function resolveRedirectTarget(location: string, base: string): string {
  const raw = location.trim();
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

/** 从一条 `Set-Cookie` 里取 `name=value`（其余属性不管）；`Max-Age<=0` 视为删除，返回 null */
function cookiePairOf(setCookie: string): { name: string; value: string; expired: boolean } | null {
  const first = setCookie.split(';')[0]?.trim() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  // 过期判定：Max-Age<=0 或 Expires 落在过去（删除 cookie 也是重定向链里常见的一步）
  let expired = false;
  for (const attr of setCookie.split(';').slice(1)) {
    const [k, v] = attr.split('=').map((x) => (x ?? '').trim());
    const key = (k ?? '').toLowerCase();
    if (key === 'max-age' && Number(v) <= 0) expired = true;
    if (key === 'expires' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t) && t <= Date.now()) expired = true;
    }
  }
  return { name, value, expired };
}

/**
 * **「安全跳转」PoW-Cookie 闸页静默过闸（`#888`）** —— 判据见 `./gate-pass#planJumpPowGate`。
 *
 * 与类CD 那条的区别：Cookie 是**页面脚本算出来的**（FNV-1a PoW），而且拿到 Cookie 后要去
 * **另一个 URL**（`?mod=jump&jpp=…`）才出内容，不是在原地址 reload。
 *
 * 幂等：算出来的 Cookie 并进 `set-cookie` 交给上层 `harvestCookies`，后续请求直接带；
 * 重放仍是闸页 ⇒ **原响应原样返回** + 留痕（绝不伪装成功）。
 * 求解本身是纯计算（毫秒级），不发额外网络请求。
 */
async function maybePassJumpPowGate(
  url: string,
  resp: HttpResponse,
  opts: HttpRequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  if ((opts.method ?? 'GET').toUpperCase() !== 'GET' || opts.responseType === 'arraybuffer') return resp;
  const text = typeof resp.body === 'string' ? resp.body : '';
  const gate = planJumpPowGate(text, resp.url || url);
  if (!gate) return resp;
  const finalUrl = resp.url || url;
  const host = (() => {
    try {
      return new URL(finalUrl).host;
    } catch {
      return finalUrl.slice(0, 40);
    }
  })();
  const [gk, gv] = gate.cookie.split('=');
  const existing = String(opts.headers?.['Cookie'] ?? opts.headers?.['cookie'] ?? '').trim();
  const kept = existing
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith(`${gk}=`));
  const cookieHeader = [...kept, `${gk}=${gv}`].join('; ');
  try {
    const retry = await fetchOnce(
      gate.target,
      { ...opts, headers: { ...opts.headers, Cookie: cookieHeader } },
      AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    );
    const body = typeof retry.body === 'string' ? retry.body : '';
    if (!body.trim() || planJumpPowGate(body, gate.target)) {
      warnOnce(
        `jgate:${host}`,
        `安全跳转闸页重放仍未拿到内容（${gk}=非 ${gate.nonce}）⇒ 该站可能换了算法，请用「登录窗口」人工过一次`,
      );
      return resp;
    }
    // 算出来的 Cookie + 站点自己下发的，一并交给上层回收
    const sc = `${gk}=${gv}; Path=/`;
    retry.headers['set-cookie'] = retry.headers['set-cookie'] ? `${retry.headers['set-cookie']}\n${sc}` : sc;
    warnOnce(`jgate:${host}`, `已静默过「安全跳转」PoW 闸页（${gk}，nonce=${gate.nonce}）：${gate.target.slice(0, 120)}`);
    warnOnce(`jgate-ok:${host}`, `闸页已过：${host}`);
    return retry;
  } catch (e) {
    warnOnce(`jgate:${host}`, `安全跳转闸页重放异常，原响应原样返回：${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return resp;
  }
}

/**
 * `#699` **网络层自己跟重定向**（`redirect !== 'manual'` 时）。
 *
 * 为什么要放弃 undici 的 `follow`：它只把**最终**响应交回来，中间每一跳的 3xx 码与
 * `Location` 全部吞掉。后果不是「少一行日志」——
 *  · 信息流没法复刻上游 `≡检测到重定向(301)` / `┌重定向后地址` / `└…`；
 *  · 排「站点改域名」这类问题时，只能看到「源写 uushuk.com、落地 rrssk.com」这一条结果，
 *    看不到**中途跳了几次、每次是哪个状态码**（决定是永久迁移还是临时跳转）。
 *
 * 语义必须与 undici 的 `follow` **逐条对齐**（否则等于偷偷改了网络行为）：
 *  · 跳数上限 20；
 *  · 303 ⇒ GET；301/302 + POST ⇒ GET；307/308 保方法保体（见 `redirectMethod`）；
 *  · 跨源重定向摘掉 `authorization` / `cookie` / `proxy-authorization`；
 *  · 中间跳的 `Set-Cookie` **并进最终响应的 `set-cookie`** —— 上层是拿这个头回收进源 jar 的
 *    （`harvestCookies`），自己跟链时若不并，站点在 302 上下发的 cookie 就永远丢了。
 *    同源后续跳也会把这批 cookie 带上（跨源不带上，与浏览器沙箱一致）。
 *  · 中间响应体一律 `cancel()` —— 不读不取消会一直占着连接（3xx 也带 body）。
 */
async function fetchOnceInner(
  url: string,
  opts: HttpRequestOptions,
  signal: AbortSignal,
  aiaAgent?: unknown,
  /** `#742`：`dnsIp` 直连 dispatcher（作用于整条重定向链；作用域只认原始域名） */
  dnsIpDispatcher?: unknown,
): Promise<{ res: Response; redirects: HttpRedirect[]; setCookies: string[] }> {
  if ((opts.redirect ?? 'follow') === 'manual') {
    // `java.get/post` 的 `followRedirects(false)`（上游 `JsExtensions.kt:591`）：源脚本自己判 3xx
    return { res: await rawFetchOnce(url, opts, signal, aiaAgent, dnsIpDispatcher), redirects: [], setCookies: [] };
  }
  const redirects: HttpRedirect[] = [];
  /** 中间跳下发的 cookie（name → value），只用于**同源**后续跳与最终合并 */
  const jar = new Map<string, string>();
  /** 中间跳的原始 `Set-Cookie`（按到达顺序，最终并进响应头） */
  const setCookies: string[] = [];
  let curUrl = url;
  let curOpts = opts;
  for (let hop = 0; ; hop++) {
    const res = await rawFetchOnce(curUrl, curOpts, signal, aiaAgent, dnsIpDispatcher);
    const hopSetCookie =
      (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const location = isFollowableRedirect(res.status) ? (res.headers.get('location') ?? '').trim() : '';
    // 不是重定向 / 3xx 但没 Location（站点拿 3xx 当错误信封）⇒ 这就是最终响应
    if (!location) return { res, redirects, setCookies };
    if (hop >= MAX_REDIRECT_HOPS) {
      try {
        await res.body?.cancel();
      } catch {
        /* 已断开 */
      }
      throw new Error(`TOO_MANY_REDIRECTS: 超过 ${MAX_REDIRECT_HOPS} 跳（${url.slice(0, 120)}）`);
    }
    const target = resolveRedirectTarget(location, curUrl);
    redirects.push({ status: res.status, url: curUrl, location, target });
    for (const sc of hopSetCookie) {
      setCookies.push(sc);
      const pair = cookiePairOf(sc);
      if (!pair) continue;
      if (pair.expired) jar.delete(pair.name);
      else jar.set(pair.name, pair.value);
    }
    try {
      // 中间响应体不读也要取消，否则连接被这条 3xx 占着
      await res.body?.cancel();
    } catch {
      /* 已断开 */
    }
    const method = (curOpts.method ?? 'GET').toUpperCase();
    const nextMethod = redirectMethod(res.status, method);
    const crossOrigin = !sameOrigin(curUrl, target);
    const nextHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(curOpts.headers ?? {})) {
      const key = k.toLowerCase();
      // 跨源摘凭据（fetch 规范的 `CORS non-wildcard request-header name` 处置）
      if (crossOrigin && (key === 'authorization' || key === 'cookie' || key === 'proxy-authorization')) continue;
      nextHeaders[k] = v;
    }
    if (!crossOrigin && jar.size) {
      // 同源：把中间跳种下的 cookie 带上（跨源不带 —— 那等于把上一个域的凭据递给新域）
      const existing = String(nextHeaders['Cookie'] ?? nextHeaders['cookie'] ?? '').trim();
      const kept = existing
        ? existing
            .split(';')
            .map((x) => x.trim())
            .filter((x) => x && !jar.has(x.split('=')[0]!.trim()))
        : [];
      const merged = [...kept, ...[...jar.entries()].map(([k, v]) => `${k}=${v}`)].join('; ');
      delete nextHeaders['cookie'];
      if (merged) nextHeaders['Cookie'] = merged;
    }
    curOpts = {
      ...opts,
      method: nextMethod as HttpRequestOptions['method'],
      headers: nextHeaders,
      ...(nextMethod === method ? {} : { body: undefined }),
    };
    curUrl = target;
  }
}

async function rawFetchOnce(
  url: string,
  opts: HttpRequestOptions,
  signal: AbortSignal,
  aiaAgent?: unknown,
  /** `#742`：强制 dispatcher（`dnsIp` 直连），优先级高于 `allowInsecureTls` 与 AIA */
  forcedDispatcher?: unknown,
): Promise<Response> {
  const method = opts.method ?? 'GET';
  /**
   * `#644` **GET / HEAD 不能有请求体**（其它方法照常带上）。
   *
   * 上游 `AnalyzeUrl.kt:302-320` 的 `when (method)`：**POST 分支**取 `body` 填 `fieldMap`，
   * `else`（GET / HEAD）分支**压根不看 `body`**，转而去拆 URL 的 query。
   * 我们此前把 `body` 原样递给 fetch ⇒ undici 直接抛
   * `Request with GET/HEAD method cannot have body.`，整条规则连带失败
   * （木里聚合 `公益密钥版` 实测：源在 URL 选项里同时写了 method 与 body）。
   *
   * ⚠️ 判据只能是「GET/HEAD 丢弃」，不能写成「只有 POST 保留」：
   * WebDAV 的备份上传走 **PUT + zip 二进制体**（`WebDavClient.upload`），
   * 写成「只有 POST」会让请求**静默变成空体**（`B7` 端到端探针实测：远端存下 0 字节 zip）。
   */
  const body = method === 'GET' || method === 'HEAD' ? undefined : (opts.body as BodyInit | undefined);
  const init: RequestInit & { dispatcher?: unknown } = {
    method,
    /**
     * `#643` **默认 UA**：上游 `java.get/post/head/connect` 走 `Jsoup.connect()`，
     * jsoup 自带浏览器 UA；`java.ajax` 由 `AnalyzeUrl` 补 `source.getUserAgent()`。
     * 我们此前一律「源给什么就发什么」⇒ 源没写 UA 时 undici 填 `user-agent: node`，
     * 站点据此回 403 错误信封而不是挑战页 ⇒ 撞盾判据整格失效（uu书库翻页实例）。
     * 显式给了 UA 的一字不动（详见 `net/user-agent.ts`）。
     */
    headers: withDefaultUserAgent(opts.headers),
    body,
    /**
     * `#699` **底层 fetch 恒为 `manual`**：跟随这件事已经上移到 `fetchOnceInner` 自己做了。
     *
     * 为什么不干脆交给 undici 的 `follow`：它只回最终响应，中间那几跳的 3xx 码与 `Location`
     * 拿不到（见 `fetchOnceInner` 头注）。而 `rawFetchOnce` 是「只发一次」的原语 ——
     * 它必须把 3xx **原样**交回来，跟不跟由上层决定：
     *  · `opts.redirect === 'manual'`（`java.get/post`，上游 `followRedirects(false)`）⇒ 不跟；
     *  · 其余 ⇒ `fetchOnceInner` 自己按 fetch 规范一跳一跳跟（上限 20、方法改写、跨源摘凭据）。
     *
     * 注意这是 **fetch 内部**的策略，跟 `HttpRequestOptions.redirect` 不是同一层的东西 ——
     * 后者表达的是「这次请求要不要跟随」，前者只是「这一发别替我决定」。
     */
    redirect: 'manual',
    signal,
  };
  /**
   * `#742` `dnsIp` 直连的 dispatcher **最高优先**：它内部已把 `#428` 的
   * `rejectUnauthorized:false` 合并进自己的 `connect`，被覆盖就等于 IP 直连失效。
   * 其后保持原顺序（`#428` 优先于 AIA：过期证书既不受 AIA 补全影响，也不该被 AIA 的 ca 覆盖）。
   */
  if (forcedDispatcher) init.dispatcher = forcedDispatcher;
  else if (opts.allowInsecureTls) init.dispatcher = insecureTlsDispatcher();
  else if (aiaAgent) init.dispatcher = aiaAgent;
  return fetch(url, init);
}

/** 单次 HTTP 尝试（不含闸门与重试） */
async function fetchOnce(url: string, opts: HttpRequestOptions, signal: AbortSignal): Promise<HttpResponse> {
  const cfg = netGuardConfig();
  /**
   * 出口留痕开关（`YUEDU_DEBUG_HTTP=1`）：打印**真正发出去**的 method / URL / 头 / 体前 300 字。
   *
   * 为什么需要它：一次「站点返回 400 / 空信封」的排障，光看引擎打印的 URL 与源规则里的 body
   * 是推不出结论的 —— 请求在「规则 → prepareUrl → toRequest → 补 Content-Type / 表单编码 →
   * fetch」这条链上被改过好几手，**只有出口那一眼是真的**。
   * 实测（2026-09-27，🏷QB女生 正文 0 段）：源里写的 POST 体用 curl 手发是 200，
   * 引擎发出去是 `{"ret":400,"errMsg":"invalid Request Param"}` —— 必须看出口才知道差在哪。
   */
  if (process.env.YUEDU_DEBUG_HTTP === '1') {
    console.warn(
      `[http] → ${opts.method ?? 'GET'} ${url}\n     头: ${JSON.stringify(opts.headers ?? {})}\n     体: ${
        opts.body ? String(opts.body).replace(/\s+/g, ' ').slice(0, 300) : '(无)'
      }`,
    );
  }
  // `#372` TLS 证书链 AIA 补全：缺中间证书的站点（浏览器自动补全所以能开、Node 不补所以打不开）
  // 首次报「链不完整」类错误 ⇒ 取（或现场补）per-host 的带 ca Agent ⇒ 重试一次。
  // · 已补全过的 host 直接走缓存 Agent（首请求就命中，连原始失败都不发生）；
  // · 补不出来（无 AIA / 下载失败）⇒ 抛**原始错误**，行为与从前完全一致（可回退）；
  // · `CERT_HAS_EXPIRED` / 域名不匹配不在补全范围（没有「补」的意义），照旧报错。
  /**
   * `#699` `fetchOnceInner` 现在回三样：最终响应 + 重定向跳跃链 + 中间跳的 `Set-Cookie`。
   * 三样都要往上带 —— `redirects` 进信息流（`≡检测到重定向(301)` 那对），
   * `setCookies` 并进响应头供 `harvestCookies` 回收（不并就等于丢掉站点在 302 上种的 cookie）。
   */
  let fetched: Awaited<ReturnType<typeof fetchOnceInner>> | undefined;
  /**
   * `#742` **`dnsIp` 直连**（对齐上游 `buildScopedDns`，见 `net/dns-ip.ts` 头注）：
   *  · 只在源显式给了合法 `dnsIp` 时生效 —— 缺省路径一行未动；
   *  · 多值 `IP,IP2` **按顺序**尝试：只有「连不上」类错误才换下一个（TLS/HTTP 错误照旧抛，
   *    否则会把站点的 401/403 误当成线路问题而重试）；
   *  · 作用域只认**原始链接的域名**：重定向到别的域名照旧走系统解析（上游同语义）。
   */
  const dnsIpCandidates = opts.dnsIp ? parseDnsIpList(opts.dnsIp).ips : [];
  if (dnsIpCandidates.length) {
    const host = urlHostnameOf(url);
    let lastErr: unknown = null;
    for (let i = 0; i < dnsIpCandidates.length; i++) {
      const ip = dnsIpCandidates[i];
      if (!ip) continue;
      try {
        fetched = await fetchOnceInner(
          url,
          opts,
          signal,
          undefined,
          dnsIpDispatcherFor(host, ip, opts.allowInsecureTls === true),
        );
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const code = netErrCode(e);
        if (i === dnsIpCandidates.length - 1) throw e;
        // 只切「连接层」失败；拿到响应就算成功（哪怕 4xx/5xx）
        if (!DNS_IP_SWITCHABLE.has(code)) throw e;
        warnOnce(`dnsIp:${host}:${ip}`, `[dnsIp] ${host} → ${ip} 连接失败（${code}），按列表切换下一个 IP`);
      }
    }
    if (lastErr) throw lastErr;
    if (!fetched) throw new Error('dnsIp 直连失败（无可用地址）');
  } else {
    const preAgent = cachedAiaAgent(url);
    if (preAgent) {
      netStats.aiaRetries++;
      fetched = await fetchOnceInner(url, opts, signal, preAgent);
    } else {
      try {
        fetched = await fetchOnceInner(url, opts, signal);
      } catch (e) {
        const code = netErrCode(e);
        if (!CHAIN_INCOMPLETE_TLS_CODES.has(code)) throw e;
        const agent = await aiaAgentFor(url, (msg) => warnOnce(`aia:${new URL(url).host}`, msg));
        if (!agent) throw e;
        netStats.aiaRetries++;
        fetched = await fetchOnceInner(url, opts, signal, agent);
      }
    }
  }
  if (!fetched) throw new Error('请求未产生响应');
  const res = fetched.res;
  /** 重定向链（没跳过则是空数组）；`manual` 档恒空 —— 那是源脚本自己要拦的 */
  const redirects = fetched.redirects;
  const redirectField = redirects.length ? { redirects } : {};

  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  // Set-Cookie 可能有多条（forEach 会按规范逗号合并，而 Expires 里也有逗号）——
  // 用 getSetCookie() 取原始多值，换行分隔供 cookie jar 逐条解析
  const setCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  /**
   * `#699` **中间跳的 `Set-Cookie` 一并带上**（顺序：先到达的先写，最终响应最后写 ⇒
   * 同名的以后者为准，与「逐跳处理」的语义一致）。
   * 不并的后果很具体：站点在 `302` 上下发「放行/会话」cookie、最终页不再下发，
   * 自己跟链之后上层 `harvestCookies` 就再也看不到它了 —— 下一次请求又得从头撞一遍。
   */
  const mergedSetCookies = [...fetched.setCookies, ...(setCookies ?? [])];
  if (mergedSetCookies.length) headers['set-cookie'] = mergedSetCookies.join('\n');

  const finalUrl = res.url || url;
  /**
   * `#424` **流式分支：不缓冲**（音视频边下边播）。
   *
   * 必须在 `readBodyLimited` **之前**返回 —— 一旦进了缓冲通路就必然过体积护栏
   * （`arraybuffer` 32MB）⇒ 大 mp4 被截断（用户实测「响应体超过上限 32MB，已截断」）。
   * `body` 给空 ArrayBuffer 占位，保持 `HttpResponse` 既有类型不变；调用方读 `stream`。
   */
  if (opts.responseType === 'stream') {
    if (!res.body) throw new Error(`STREAM_NO_BODY: 上游无响应体（${finalUrl.slice(0, 120)}）`);
    return {
      status: res.status,
      headers,
      body: new ArrayBuffer(0),
      url: finalUrl,
      ...redirectField,
      stream: res.body as ReadableStream<Uint8Array>,
    };
  }
  /**
   * ★ `#470c` **媒体二进制一律不按文本读**（唯一闸门，2026-10-15 用户第 3 次实测后定位）。
   *
   * 实证：枫叶音乐盒的**章节地址本身就是** `fy-musicbox-api.mu-jie.cc/meting/?server=netease&type=url&id=…`，
   * 它回 **302**（body 268B，`Location` 指向 CDN mp3）；而 **content 阶段的主抓取**（`fetchRuleUrl`）
   * 默认**跟随重定向** ⇒ 把整首音频（实测 10.85MB）当**文本**拉回来 ⇒ 撞文本通道 8MB 护栏
   * （用户可见 `[net-guard] 响应体超过上限 8MB，已截断` + `[legado] 首个被截断 URL：…/meting/…`）。
   *
   * `#470①` 只改了 `/api/proxy`、`#470②` 只改了 `followPlayPage`（该源不调 `startBrowser`，
   * `__browserUrls` 为空 ⇒ **根本不在那条链路上**）——两处都没覆盖这条主抓取，所以症状复现。
   *
   * 判据与处置：**最终** `Content-Type` 是 `audio/*|video/*` 且**非** `mpegurl`
   * （`audio/mpegurl`、`application/vnd.apple.mpegurl` 是 HLS **文本清单**，必须照常读）
   * ⇒ 立刻 `cancel()` 丢掉响应体，返回**空 body + 保留 status/headers/url**。
   * 语义安全性：媒体二进制当文本读本来就毫无用处（`java.get(meting)` 只用 `header("Location")`），
   * 空 body 只会让「拿二进制去 JSON.parse / 选择器」这类无意义用法不再产出垃圾，且不再触发 8MB 告警。
   */
  if (opts.responseType !== 'arraybuffer' && res.status < 400) {
    const finalType = String(headers['content-type'] ?? '');
    if (/^(audio|video)\//i.test(finalType) && !/mpegurl/i.test(finalType)) {
      try {
        await (res.body as ReadableStream<Uint8Array> | null)?.cancel();
      } catch {
        /* 已断开 ⇒ 忽略 */
      }
      warnMediaBodySkip(finalUrl, finalType);
      return { status: res.status, headers, body: '', url: finalUrl, ...redirectField };
    }
  }
  // 体积上限：`arraybuffer`（媒体/二进制）场景给足 4 倍（但要**显式** opt-in），文本类用默认
  const maxBody = opts.maxBodyBytes ?? (opts.responseType === 'arraybuffer' ? cfg.maxBodyBytes * 4 : cfg.maxBodyBytes);
  const { buf, truncated } = await readBodyLimited(res, maxBody, finalUrl);
  // ★ `#152`：**文本类**截断登记（媒体/arraybuffer 走 /api/proxy 的 Content-Range 通路，不重复报）——
  //   供一次引擎请求结束后随结果回传前端，让「被截断」与「站点返回空」在界面上分得开。
  if (truncated && opts.responseType !== 'arraybuffer') recordTruncatedFetch(finalUrl, buf.byteLength);

  if (opts.responseType === 'arraybuffer') {
    // `out` 是**恰好 total 字节**的新分配缓冲（无多余容量），可直接取底層 ArrayBuffer
    return {
      status: res.status,
      headers,
      body: buf.buffer as ArrayBuffer,
      url: finalUrl,
      ...redirectField,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /**
   * 字符集自动检测（对齐浏览器/Legado okhttp 语义）：
   *   ① 显式（`opts.charset`）→ ② Content-Type charset → ③ 页面 `<meta charset>` 嗅探 → ④ UTF-8
   * 大量中文老站（GBK/GB2312）Content-Type 不带 charset，只在本页 meta 里声明——
   * 不做检测会整页乱码（选择器/CSS 全失效）。
   *
   * `#439`：判据本体下沉到 `./charset.ts`（**唯一实现**），与 `/api/proxy` 的文本通路共用 ——
   * 代理侧走 `arraybuffer`（要拿原始字节），core 这条文本分支**不执行**，此前那边漏了同一句
   * 「先按上游字符集解码」⇒ GBK 页经代理整页 `����`（详见 `charset.ts` 头注）。
   */
  const bodyText = decodeText(buf, headers['content-type'] ?? '', opts.charset ?? '');
  return {
    status: res.status,
    headers,
    body: bodyText,
    url: finalUrl,
    ...redirectField,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** `#200` 创建 HTTP 客户端时可选的作用域参数 */
export interface HttpClientScopeOptions {
  /** 任务类别：`instant`（默认，交互请求）· `batch`（后台批量校验/抓取） */
  taskClass?: TaskClass;
  /** 默认并发池（可用 `opts.pool` 按请求覆盖） */
  pool?: PoolKind;
  /** 复用外部任务作用域（**一次 `/api/run` = 一个作用域**，跨多个请求共享任务配额） */
  scope?: TaskScope;
}

/** `YUEDU_GUARD_V2=0` 可回退到 v1 护栏（窄改 + 可回退） */
export function guardV2Enabled(): boolean {
  return (process.env.YUEDU_GUARD_V2 ?? '1') !== '0';
}

/**
 * ★ `#151`：gatekeeper 站点挑战的**自动解证**（403 + JSON `challenge_required` ⇒ PoW ⇒ 重试原请求一次）。
 *
 * 挑战形态与解法见 `./gatekeeper.ts` 头注释（2026-10-10 对 `cn.baozimhcn.com` 实测取证，
 * Node 侧全自动通过、总耗时 ~1s；「腾讯云 WAF 403 硬拦截页」如得间 `wechat.idejian.com`
 * **没有**放行通路，不触发本流程，原样返回）。
 *
 * 设计要点：
 * - 解证期间的 3 个子请求用 `fetchOnce` **直连**（不走闸门）——本函数运行在 request 的
 *   lease 槽位**之内**，再 acquire 会自己等自己（死锁/白排队）。同站 3 个小请求、
 *   每个带 12s 超时 + 受外部 signal 约束，不构成护栏要防的刷量形态。
 * - cookie：局部 jar = 调用方拼好的 Cookie 头起底 ⊕ 解证全程 Set-Cookie；解证通过后
 *   用**合并后的 jar** 重试原请求，并把全部 Set-Cookie 合并进重试响应的 `set-cookie`
 *   ⇒ 上层 `harvestCookies` 把「放行 cookie」自然回收进源 jar（下次请求不用再解）。
 * - 任何一步失败 ⇒ `warnOnce` 留痕（铁律 3）+ **原 403 响应原样返回**——不吞错、
 *   不伪装成功，上层报错链路照旧（该报 `RULE_PARSE` 还是 `NETWORK` 照旧）。
 */
async function maybeSolveGatekeeper(
  url: string,
  resp: HttpResponse,
  opts: HttpRequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  if (resp.status !== 403 || opts.responseType === 'arraybuffer') return resp;
  const text = typeof resp.body === 'string' ? resp.body : Buffer.from(resp.body).toString('utf-8');
  const guideUrl = parseGatekeeperGuide(resp.status, resp.headers['content-type'], text);
  if (!guideUrl) return resp; // 别的 403（含 WAF 硬拦截页）与本法无关

  // ★ `#384`：origin 取**最终响应**的（`resp.url` = 跟随重定向后的 URL）——
  //    包子漫画（优）`cn.bzmgcn.com` 会 302 → `cn.cnbzmg.com`，挑战 JSON 来自重定向后的站；
  //    用原始 URL 的 origin 去解析 challenge_url/verifyUrl ⇒ 在错误主机上解证 ⇒ binding 失败
  //    （warnOnce 按 host 去重，第二次起静默，症状就是「莫名其妙仍 403」）。
  const origin = new URL(resp.url || url).origin;
  const host = new URL(url).host;
  const fail = (msg: string): HttpResponse => {
    warnOnce(`gk:${host}`, `挑战未通过（原 403 原样返回）：${msg}`);
    return resp;
  };
  try {
    // 局部 cookie jar：底 = 调用方已拼的 Cookie 头；增量 = 解证全程 Set-Cookie
    const jar = new Map<string, string>();
    const initCookie = String(opts.headers?.['Cookie'] ?? opts.headers?.['cookie'] ?? '');
    for (const kv of initCookie.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    const absorbed: string[] = [];
    const absorb = (setCookie: string | undefined) => {
      if (!setCookie) return;
      for (const sc of setCookie.split('\n')) {
        absorbed.push(sc);
        const pair = sc.split(';')[0] ?? '';
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    };
    const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const subSignal = () => AbortSignal.any([signal, AbortSignal.timeout(12000)]);

    // ① GET 挑战页（种下初始绑定 cookie + 内联求解配置）
    const pageUrl = new URL(guideUrl, origin).toString();
    const pageResp = await fetchOnce(pageUrl, { method: 'GET', headers: { ...opts.headers, Cookie: cookieHeader() } }, subSignal());
    absorb(pageResp.headers['set-cookie']);
    if (pageResp.status !== 200) return fail(`挑战页 ${pageResp.status}`);
    const pageText = typeof pageResp.body === 'string' ? pageResp.body : Buffer.from(pageResp.body).toString('utf-8');
    const cfg = parseGatekeeperCfg(pageText);
    if (!cfg) return fail('挑战页里解析不出求解配置（形态可能已变）');

    // ② 本地解 PoW（`#476`：**让出版** —— 旧同步紧循环会把主线程冻住数秒，见 solveGatekeeperPowAsync 注释）
    const pow = await solveGatekeeperPowAsync(cfg);
    // 埋点记的是**单次最长连续哈希块**（不是总耗时）⇒ 若这一条仍出现数秒，说明让出链断了
    recordBlock('gk-pow', pow?.maxChunkMs ?? 0, `bits=${cfg.difficultyBits} attempts=${pow?.attempts ?? '-'}`);
    if (!pow) return fail(`PoW ${cfg.difficultyBits}bit 未在预算内解出`);

    // ③ POST verify —— ★ 必须带 same-origin 的 Origin + Referer（缺 ⇒ binding_mismatch，实测）
    const verifyUrl = new URL(cfg.verifyUrl, origin).toString();
    const vResp = await fetchOnce(
      verifyUrl,
      {
        method: 'POST',
        headers: {
          ...opts.headers,
          Cookie: cookieHeader(),
          'Content-Type': 'application/json',
          Origin: origin,
          Referer: pageUrl,
        },
        body: JSON.stringify({ challenge_id: cfg.challengeId, ticket: cfg.ticket, nonce: pow.nonce }),
      },
      subSignal(),
    );
    absorb(vResp.headers['set-cookie']);
    const vText = typeof vResp.body === 'string' ? vResp.body : Buffer.from(vResp.body).toString('utf-8');
    let verdict: { status?: string } = {};
    try {
      verdict = JSON.parse(vText) as { status?: string };
    } catch {
      /* 保持空 verdict ⇒ 走失败分支 */
    }
    if (vResp.status !== 200 || verdict.status !== 'passed') {
      return fail(`verify ${vResp.status} ${vText.slice(0, 80)}`);
    }

    // ④ 用合并后的 cookie 重试一次。★ `#384`：重试 **`resp.url`（最终响应 URL）** 而不是原 `url`——
    //    fetch 跟随**跨主机**重定向时会剥掉 Cookie 头（fetch 规范剔除敏感头），而包子漫画（优）
    //    主站 `cn.bzmgcn.com` 是纯 nginx 302 → 镜像 `cn.cnbzmg.com`：解证在镜像上通过、clearance
    //    也绑在镜像上，但按原 URL 重试 = 302 一跳后 cookie 全丢 ⇒ 镜像又回 challenge_required 403。
    //    直接打最终 URL 就没有重定向这一跳（clearance 是对镜像签的，直打必通）；
    //    非重定向场景 `resp.url === url`，行为不变。
    const retryResp = await fetchOnce(
      resp.url || url,
      { ...opts, headers: { ...opts.headers, Cookie: cookieHeader() } },
      subSignal(),
    );
    if (retryResp.status === 403) return fail('重试原请求仍 403');
    const extra = absorbed.join('\n');
    if (extra) {
      retryResp.headers['set-cookie'] = retryResp.headers['set-cookie']
        ? `${retryResp.headers['set-cookie']}\n${extra}`
        : extra;
    }
    warnOnce(`gk:${host}`, `PoW ${pow.attempts} 次通过，自动重试 ⇒ ${retryResp.status}`);
    return retryResp;
  } catch (e) {
    return fail(`解证流程异常：${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

/**
 * `D11`（B 半）闸页静默过闸 —— **引擎自己的请求出口**（`createHttpClient.request`）。
 *
 * 与 core 的 java.* 出口（`selector/js.ts` 的 L1 `syncHttp` / worker `hostRpc('http')`）
 * **同一判据**（`./gate-pass` 的 `planAgeGatePass`），只是这里的响应形状是 `HttpResponse`。
 * 覆盖面：ruleExplore / ruleToc / ruleContent 等**非 JS 规则**的抓取。
 *
 * 与 `maybeSolveGatekeeper` 同款约束：子请求用 `fetchOnce` 直连（本函数已在 lease 槽位内，
 * 再 acquire 会自己等自己）；cookie 用局部 jar（调用方 Cookie 头 ⊕ 过闸 Set-Cookie），
 * 并把增量 Set-Cookie **并进最终响应** ⇒ 上层 `harvestCookies` 自然回收进源 jar，
 * 下一次请求不用再过闸。任何一步失败 ⇒ 原响应原样返回 + `warnOnce` 留痕（不伪装成功）。
 */
async function maybePassAgeGate(
  url: string,
  resp: HttpResponse,
  opts: HttpRequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const method = (opts.method ?? 'GET').toUpperCase();
  if (method !== 'GET' || opts.responseType === 'arraybuffer') return resp;
  const text = typeof resp.body === 'string' ? resp.body : '';
  const finalUrl = resp.url || url;
  const gate = planAgeGatePass(text, finalUrl);
  if (!gate) return resp;

  const host = (() => {
    try {
      return new URL(finalUrl).host;
    } catch {
      return finalUrl.slice(0, 40);
    }
  })();
  const subSignal = () => AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  const jar = new Map<string, string>();
  for (const kv of String(opts.headers?.['Cookie'] ?? opts.headers?.['cookie'] ?? '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const absorbed: string[] = [];
  const absorb = (setCookie: string | undefined): void => {
    if (!setCookie) return;
    for (const sc of setCookie.split('\n')) {
      absorbed.push(sc);
      const pair = sc.split(';')[0] ?? '';
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const cookieHeader = (): string => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  try {
    // ① GET 声明页里的过闸目标（站点在此下发放行 cookie，实测 `YES_Eighteen=IamOverEighteenYearsOld`）
    const gateResp = await fetchOnce(gate.target, { method: 'GET', headers: { ...opts.headers, Cookie: cookieHeader() } }, subSignal());
    absorb(gateResp.headers['set-cookie']);
    // ② 带放行 cookie 重放原请求
    const retry = await fetchOnce(finalUrl, { ...opts, headers: { ...opts.headers, Cookie: cookieHeader() } }, subSignal());
    const body = typeof retry.body === 'string' ? retry.body : '';
    // 「重放仍为空」或「重放仍是闸页」都算失败（否则会把闸页当成功结果交给规则 ⇒ 列表 0 条）
    if (!body.trim() || planAgeGatePass(body, finalUrl)) {
      warnOnce(`gate:${host}`, `识别到闸页但重放未拿到内容（过闸目标 ${gate.target}）⇒ 请用「登录窗口」人工过闸后再刷新`);
      return resp;
    }
    const extra = absorbed.join('\n');
    if (extra) {
      retry.headers['set-cookie'] = retry.headers['set-cookie'] ? `${retry.headers['set-cookie']}\n${extra}` : extra;
    }
    warnOnce(`gate:${host}`, `已静默过闸（年满18岁声明页 → ${gate.target}）并重放成功：${finalUrl.slice(0, 120)}`);
    return retry;
  } catch (e) {
    warnOnce(`gate:${host}`, `闸页过闸异常，原响应原样返回：${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return resp;
  }
}

/**
 * **类CD（2026-10-26）「JS 下发的 Cookie 闸页」静默过闸**（判据见 `./gate-pass#planCookieGatePass`）。
 *
 * 与 `maybePassAgeGate` 并列：那个是「声明页 → GET 目标 → 站点下发放行 Cookie」，
 * 这个是「空壳页用 document.cookie 自写放行 Cookie + reload」。
 * 我们不跑页面脚本，所以直接把脚本要写的 `k=v` 放进 Cookie 头重放一次。
 *
 * 返回的响应把该 Cookie **并进 `set-cookie`** ⇒ 上层 `harvestCookies` 自然回收进源 jar，
 * 后续请求不用再撞一次（幂等；重放仍是空壳 ⇒ 原响应原样返回 + 留痕，绝不伪装成功）。
 */
async function maybePassCookieGate(
  url: string,
  resp: HttpResponse,
  opts: HttpRequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  if ((opts.method ?? 'GET').toUpperCase() !== 'GET' || opts.responseType === 'arraybuffer') return resp;
  const text = typeof resp.body === 'string' ? resp.body : '';
  const gate = planCookieGatePass(text);
  if (!gate) return resp;
  const finalUrl = resp.url || url;
  const host = (() => {
    try {
      return new URL(finalUrl).host;
    } catch {
      return finalUrl.slice(0, 40);
    }
  })();
  const [gk, gv] = gate.cookie.split('=');
  const existing = String(opts.headers?.['Cookie'] ?? opts.headers?.['cookie'] ?? '').trim();
  // 同名 Cookie 以新值为准（旧值是被拦下的那次请求用的，必然是错的）
  const kept = existing
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${gk}=`));
  const cookieHeader = [...kept, `${gk}=${gv}`].join('; ');
  try {
    const retry = await fetchOnce(
      finalUrl,
      { ...opts, headers: { ...opts.headers, Cookie: cookieHeader } },
      AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    );
    const body = typeof retry.body === 'string' ? retry.body : '';
    if (!body.trim() || planCookieGatePass(body)) {
      warnOnce(
        `cgate:${host}`,
        `JS Cookie 闸页重放仍未拿到内容（写入 ${gk}）⇒ 该站可能需要完整浏览器执行脚本，请用「登录窗口」人工过一次`,
      );
      return resp;
    }
    const sc = `${gk}=${gv}; Path=/`;
    retry.headers['set-cookie'] = retry.headers['set-cookie'] ? `${retry.headers['set-cookie']}\n${sc}` : sc;
    warnOnce(`cgate:${host}`, `已静默过 JS Cookie 闸页（${gk}）并重放成功：${finalUrl.slice(0, 120)}`);
    return retry;
  } catch (e) {
    warnOnce(`cgate:${host}`, `JS Cookie 闸页重放异常，原响应原样返回：${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return resp;
  }
}

export function createHttpClient(  _defaultHeaders: Record<string, string> = {},
  scopeOpts: HttpClientScopeOptions = {},
): HttpClient {
  const cls: TaskClass = scopeOpts.taskClass ?? 'instant';
  const defaultPool: PoolKind = scopeOpts.pool ?? 'detail';
  // 一次任务一个作用域（任务总并发 / 任务 RPS 跨该任务的多个请求累计）
  const scope: TaskScope = scopeOpts.scope ?? createTaskScope(cls);
  return {
    async request(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
      const classLimits = trafficConfig()[cls];
      // ★ `#200`：超时/重试改用**任务类别**的取值（即时 12s/2 次 · 批量 15s/2 次），
      //   调用方显式传了 `opts.timeout` 仍以调用方为准（引擎把行动预算压进单个请求时用得上）。
      const timeoutMs = opts.timeout ?? classLimits.timeoutMs;
      const controller = new AbortController();
      const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      /**
       * `#691` **外部 signal 必须并进来**（此前 `opts.signal` 声明了却没人消费 ——
       * 只有内部超时能中断请求）。
       *
       * 用户实测（花花短剧）：切走源之后，服务端还挂着一串
       * `[stall] … req GET /api/proxy?…@337s` —— 浏览器早就放弃那些 `<img>` 了，
       * 但服务端**不知道**，上游取流继续跑满 20s 超时，期间一直占着并发槽与在飞登记。
       * 现在 `/api/proxy` 把「客户端断开」转成 abort，经这条链路真正断到 fetch。
       */
      const external = opts.signal;
      const onExternalAbort = (): void => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', onExternalAbort, { once: true });
      }
      const cfg = netGuardConfig();
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        host = url.slice(0, 40);
      }
      // 排队优先级：低优先只影响**排队顺序**，有空槽时照样立刻放行（见 Semaphore 注释）
      const prio: 'high' | 'low' = opts.priority === 'low' ? 'low' : 'high';
      const pool: PoolKind = opts.pool ?? defaultPool;

      // ── 闸门：v2（域名/任务/全局三层，`#200`）或 v1（全局 + 单主机两层）────────────
      let lease: TrafficLease | null = null;
      let hostGate: Semaphore | null = null;
      if (guardV2Enabled()) {
        lease = await acquireTraffic(scope, host, pool, {
          priority: prio,
          timeoutMs,
          // `#780`：封面请求在熔断期间照常发出（不等待冷却、走独立闸门）
          ...(opts.bypassBreaker === true ? { bypassBreaker: true } : {}),
        });
      } else {
        hostGate = hostSem(host);
        // 两级闸门：先全局（socket 上限），再单主机（不打单站）——顺序固定避免死锁
        await globalSem.acquire(prio);
        try {
          await hostGate.acquire(prio);
        } catch (e) {
          globalSem.release();
          throw e;
        }
      }
      netStats.inFlight++;
      netStats.peakInFlight = Math.max(netStats.peakInFlight, netStats.inFlight);
      try {
        // ── 幂等请求的**连接阶段重试**（post8 归因补强）──────────────────────────────
        // 背景：本机连接能力被占满时，undici 会在 10s 后报 `UND_ERR_CONNECT_TIMEOUT`，
        // 而这类失败**多为瞬时**（连接表/路由器状态一恢复就好，实测同一批源几分钟后 92% 通过）。
        // 只对幂等请求（GET/HEAD 且无 body）重试，且**只重试连接阶段**的瞬时错误码；
        // 重试在**同一个闸门槽位内**做（不额外占 socket，重试期间也不放行新请求）。
        const method = (opts.method ?? 'GET').toUpperCase();
        const canRetry = (method === 'GET' || method === 'HEAD') && !opts.body;
        // ★ `#200`：重试次数取**任务类别**的配置（即时/批量同为 2），v1 回退时用旧 cfg。
        const retries = guardV2Enabled() ? classLimits.retries : cfg.maxRetries;
        const maxAttempts = canRetry ? 1 + Math.max(0, retries) : 1;
        let lastWrapped: Error | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          netStats.requests++;
          try {
            const out = await fetchOnce(url, opts, controller.signal);
            if (attempt > 1) netStats.retryRecovered++;
            // `#200`：成功 ⇒ 清零该域名的连续失败计数（熔断器恢复）
            // `#708`：非必需探测（如 Reload 的 HEAD）不计入熔断，见 HttpRequestOptions.countBreaker
            if (opts.countBreaker !== false) noteTrafficResult(host, { ok: true });
            // ★ `#151`：gatekeeper 挑战自动解证（403+JSON `challenge_required` ⇒ PoW ⇒ 重试一次）；
            //   非 403 / 非该形态的响应原样透传（见 maybeSolveGatekeeper 头注释）
            const gk = await maybeSolveGatekeeper(url, out, opts, controller.signal);
            // ★ `D11`：闸页（年满18岁声明）静默过闸（判据见 ./gate-pass；非闸页原样透传）
            const cg = await maybePassCookieGate(url, await maybePassAgeGate(url, gk, opts, controller.signal), opts, controller.signal);
            // ★ `#888`：「安全跳转」PoW-Cookie 闸页（算 Cookie → 带 jpp 跳转）
            return await maybePassJumpPowGate(url, cg, opts, controller.signal);
          } catch (e) {
            // 网络失败必须**带上可读原因**（别让上层只看到 `fetch failed`）——见 describeNetworkError 注释
            const reason = describeNetworkError(e, timeoutMs);
            const wrapped = new Error(reason) as Error & { cause?: unknown; code?: string };
            wrapped.cause = e;
            wrapped.code = 'NETWORK';
            lastWrapped = wrapped;

            const aborted = controller.signal.aborted || /abort/i.test((e as Error)?.name ?? '');
            const code = netErrCode(e);
            // `#200`：超时计入熔断（连续 6 次 ⇒ 暂停该域名 40s）
            // `#708`：HEAD 这类「非必需探测」不计入（否则会把同域名下能成功的 GET 一起打死）
            if (guardV2Enabled() && opts.countBreaker !== false) {
              noteTrafficResult(host, { ok: false, timedOut: aborted || code === 'ETIMEDOUT' });
            }
            const retryable = !aborted && RETRYABLE_NET_CODES.has(code);
            if (retryable && attempt < maxAttempts) {
              netStats.retries++;
              // 抖动退避：250–500ms（避免同一批源在同一时刻一起重试，又形成一次脉冲）
              await new Promise<void>((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
              continue;
            }
            bumpErrCounter(code, aborted);
            // `#200`：失败后**强制冷却**（参考设置 200ms），别立刻再打同一台
            if (guardV2Enabled()) {
              const cd = trafficFailCooldown(cls);
              if (cd > 0) await new Promise<void>((resolve) => setTimeout(resolve, cd));
            }
            throw wrapped;
          }
        }
        throw lastWrapped ?? new Error('请求失败');
      } finally {
        if (timer) clearTimeout(timer);
        // 摘掉外部 signal 监听（长跑的进程里这些监听会累积）
        opts.signal?.removeEventListener('abort', onExternalAbort);
        if (lease) {
          releaseTraffic(lease);
          noteGlobalPeak(netStats.inFlight);
        } else {
          hostGate?.release();
          globalSem.release();
        }
        netStats.inFlight--;
      }
    },
  };
}

/**
 * URL 绝对化：相对地址基于 baseUrl 解析；绝对地址原样返回；空串回退 baseUrl。
 * 对齐 Legado NetworkUtils.getAbsoluteURL（处理 data: 与相对路径）。
 *
 * `#374`：实现拆到零依赖叶子 `./url-resolve`（media-extract 前端复用需要绕开
 * 本文件的 node-only 依赖链），这里 re-export 保持既有导入面不变。
 */
export { resolveUrl, encodeUrlForCurl, siteDomainOf, isLoginHeaderSite } from './url-resolve';
/** `#439` 字符集判定/解码（唯一实现）—— `/api/proxy` 的文本通路要用 */
export { detectResponseCharset, decodeBytes, decodeText } from './charset';

export { findChromium, findFullChromium, isHeadlessShell, buildDumpDomArgs, syncRenderHtml, asyncRenderHtml, renderLayerInfo } from './render';

// `#200` 流量护栏 v2（域名/任务/全局三层 + 熔断）——对外暴露给 facade/server 与测试
export {
  type ClassLimits,
  type BreakerConfig,
  type PoolKind,
  type TaskClass,
  type TaskScope,
  type TrafficConfig,
  type TrafficLease,
  type TrafficSnapshot,
  acquireTraffic,
  configureTraffic,
  createTaskScope,
  defaultTrafficConfig,
  domainBreakerState,
  noteTrafficResult,
  releaseTraffic,
  resetTraffic,
  trafficConfig,
  trafficSnapshot,
} from './traffic';
export { RateGate } from './semaphore';
export {
  parseConcurrentRate,
  acquireConcurrentSlot,
  setConcurrentRate,
  updateConcurrentRate,
  concurrentRateState,
  concurrentRateSnapshot,
  resetConcurrentRate,
  type ConcurrentRateSpec,
} from './concurrent-rate';
export type { SyncRenderOptions } from './render';
export { prepareUrl, prepareRequest, splitUrlOptions, optionToRequest, applyUrlRuleJs, stripOptionalUrlSegments, URL_PREP_SOURCE } from './url-prep';
export { javaFormEncode, isFormEncoded, encodeFormBody, looksJsonOrXml, withFormEncodedBody } from './form-body';
export type { PreparedUrl, PreparedRequest, UrlOptionLike } from './url-prep';
export { harvestHosts, hostMatches, pickLoginCookies } from './login-hosts';
export type { HarvestCookie } from './login-hosts';
export { recordTruncatedFetch, takeTruncatedSince, truncatedMark, __resetTruncatedLogForTest } from './truncated-log';
export type { TruncatedFetch } from './truncated-log';
export {
  leadingZeroBits,
  parseGatekeeperCfg,
  parseGatekeeperGuide,
  solveGatekeeperPow,
  solveGatekeeperPowAsync,
} from './gatekeeper';
export type { GatekeeperCfg, GatekeeperGuide, GatekeeperPow } from './gatekeeper';
export { applySystemProxy, systemProxyState, validateProxyUrl, __resetSystemProxyForTest } from './system-proxy';
export {
  jsMirrorEnabled,
  jsMirrorRoot,
  jsMirrorRelPath,
  jsMirrorAbsPath,
  readJsMirror,
  writeJsMirror,
  /** 拒收「浏览器文本阅读器 DOM」当脚本（`.js` 撞 WAF 被重放后的污染；引擎/镜像/文件层共用） */
  isMarkupDocumentBody,
  isRenderedTextDocument,
  jsMirrorEtag,
  // `#732` 网络优先：连续失败到阈值 ⇒ 一次「请手动下载」提示（设置页 / `/api/diag` 共用）
  jsMirrorHintThreshold,
  noteJsMirrorFailure,
  noteJsMirrorSuccess,
  listJsMirrorHints,
  __resetJsMirrorHintsForTest,
  __resetJsMirrorWarningsForTest,
} from './jslib-mirror';
export type { JsMirrorHit, JsMirrorMeta, JsMirrorHint } from './jslib-mirror';
/** `D11`：闸页（年满18岁声明）静默过闸的判据 + 会话 Cookie 前置条件（引擎出口与 java.* 出口共用） */
export { planAgeGatePass, planCookieGatePass, planJumpPowGate, isAgeGatePage, sessionCookieOverride, applySessionCookie } from './gate-pass';
export type { AgeGatePlan } from './gate-pass';
/** `#332`：默认 dispatcher 加固（关 autoSelectFamily ⇒ 双栈环境快速回落 IPv4） */
export { installHardenedDispatcher, hardenedDispatcher, __resetHardenedDispatcherForTest } from './net-agent';
/** `#467`：源 header 规则求值（extractInlineJs + 求值 + 归一 + memo/防重入）唯一实现，两引擎 + /api/proxy 共用 */
export {
  SOURCE_HEADERS_VAR_KEY,
  SOURCE_HEADERS_RUNNING_KEY,
  normalizeHeaderMap,
  parseStaticSourceHeader,
  isScriptSourceHeader,
  evaluateSourceHeaderRule,
  evaluateSourceHeaderRuleAsync,
  readSourceHeaderMemo,
  writeSourceHeaderMemo,
  createSourceHeaderResolver,
} from './source-headers';
export type { EvaluateSourceHeaderOptions, SourceHeaderResolver, SourceHeaderResolverOptions } from './source-headers';
