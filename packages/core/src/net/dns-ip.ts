/**
 * `UrlOption.dnsIp` 的**唯一消费实现**（对齐上游 Legado）。
 *
 * ## 上游语义（`f:\legado`，2026-11 版）
 *  · `AnalyzeUrl.kt:291` 把选项里的 `dnsIp` 读进 `dnsIp`；`:649-652` 解析成地址列表；
 *  · `AnalyzeUrlNetworkOptions.kt:50-64` `buildScopedDns(targetHost, addresses, fallback)`：
 *    返回一个 **OkHttp `Dns`**——只对**本次链接的目标域名**回给定 IP，其它域名（含重定向/CDN）
 *    一律走 `fallback.lookup(hostname)`；
 *  · `:120-122` 把它装进 `OkHttpClient.newBuilder().dns(...)`。
 *
 * 也就是说上游**不改 Host、不改 SNI**：TLS 的 `servername` 与 `Host` 头仍由 URL 域名决定，
 * 只把「域名 → 地址」这一步换掉（等价 `curl --resolve host:443:IP`）。证书校验照域名做。
 *
 * ## 本仓实现
 * undici 的等价位是 `Agent({ connect: { lookup } })`：`lookup` 对**目标域名**返回指定 IP，
 * 其它域名回落 `dns.lookup`。`fetch` 的 URL 一字不动 ⇒ Host / SNI / 证书校验全部按域名。
 *
 * 三条硬约束（与 `#428` 同款纪律）：
 *  · **只在 `dnsIp` 存在且合法时生效**（缺省行为零变化）；
 *  · **绝不改全局 dispatcher**（只按请求传 `dispatcher`）；
 *  · **非法值必须回落系统解析并留痕**（不静默、不抛错——上游对非法值直接抛错，
 *    但本仓出口在「网络失败 ⇒ 空 body」链上，抛错会变成 0 条列表，留痕更有用）。
 */
import { Agent, type Dispatcher } from 'undici';
import dns from 'node:dns';
import net from 'node:net';

export interface DnsIpParseResult {
  /** 合法地址（按源给的顺序，**第一个优先**） */
  ips: string[];
  /** 非法项（原样保留，供日志） */
  invalid: string[];
}

const warnedInvalid = new Set<string>();

function warnInvalid(value: string): void {
  if (warnedInvalid.has(value)) return;
  if (warnedInvalid.size > 200) warnedInvalid.clear();
  warnedInvalid.add(value);
  console.warn(`[dnsIp] 非法地址已忽略并回退系统解析：${value.slice(0, 80)}`);
}

/**
 * 解析 `dnsIp`：支持 `IP,IP2` 多值（上游 `parseDnsIpAddresses` 同判据：逗号切分、去空白）。
 * IPv6 允许 `[::1]` 包裹形态（上游 `parseIpLiteral` 也去括号）。**不做域名解析**——只认字面量。
 */
export function parseDnsIpList(value: unknown): DnsIpParseResult {
  const raw = typeof value === 'string' ? value : '';
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const ips: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    let v = part;
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    if (v.startsWith('[') || v.endsWith(']')) {
      invalid.push(part);
      continue;
    }
    const family = net.isIP(v);
    if (!family || v.includes('%')) {
      invalid.push(part);
      continue;
    }
    if (!ips.includes(v)) ips.push(v);
  }
  for (const bad of invalid) warnInvalid(bad);
  return { ips, invalid };
}

/** 从 URL 取主机名（**不用 `new URL`**：L1 求值期全局 URL 会被 shim 劫持，见 `js.ts` 的注释） */
export function urlHostnameOf(url: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/(\[[^\]]*\]|[^\/?#:]+)/.exec(String(url ?? ''));
  if (!m) return '';
  const h = m[1] ?? '';
  return (h.startsWith('[') ? h.slice(1, -1) : h).toLowerCase();
}

/** `lookup` 回调的宽松类型（Node 的 `net.connect` 会按 `options.all` 变形态） */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * 作用域化 `lookup`：**只**把 `targetHost` 换成本次给的 IP，其它域名原样回落。
 * 与上游 `buildScopedDns` 逐条一致（大小写不敏感比较）。
 */
export function makeScopedDnsIpLookup(targetHost: string, ip: string): (
  hostname: string,
  options: dns.LookupOptions | number,
  callback: LookupCallback,
) => void {
  const key = String(targetHost ?? '').toLowerCase();
  const family = net.isIP(ip);
  return (hostname, options, callback) => {
    if (String(hostname ?? '').toLowerCase() === key) {
      const opts = typeof options === 'number' ? { family: options } : (options ?? {});
      if ((opts as dns.LookupOptions & { all?: boolean }).all) {
        callback(null, [{ address: ip, family }]);
        return;
      }
      callback(null, ip, family);
      return;
    }
    dns.lookup(hostname, options as dns.LookupOptions, callback as unknown as (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family: number,
    ) => void);
  };
}

/** 进程内按 `host|ip|insecure` 缓存 Agent（同一次行动里同一 IP 的多次请求复用连接池） */
const agents = new Map<string, Dispatcher>();

export function dnsIpDispatcherFor(host: string, ip: string, insecureTls = false): Dispatcher {
  const key = `${String(host).toLowerCase()}|${ip}|${insecureTls ? 1 : 0}`;
  const hit = agents.get(key);
  if (hit) return hit;
  if (agents.size > 64) agents.clear();
  const agent = new Agent({
    // 与 `net-agent.ts` 的加固默认值一致：单地址直连不需要 Happy Eyeballs
    autoSelectFamily: false,
    connect: {
      lookup: makeScopedDnsIpLookup(host, ip) as unknown as net.LookupFunction,
      // `#428`：只有源显式开了 allowInsecureTls 才关校验；本 dispatcher 与它合并成一个
      ...(insecureTls ? { rejectUnauthorized: false } : {}),
    },
  });
  agents.set(key, agent);
  return agent;
}

/** 测试专用：丢弃已建 Agent */
export function __resetDnsIpDispatchersForTest(): void {
  agents.clear();
  warnedInvalid.clear();
}
