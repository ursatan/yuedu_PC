/**
 * TLS 证书链 AIA（Authority Information Access）自动补全 —— `#372`（`#377③` 修两处缺陷）。
 *
 * ## 背景（用户 2026-10-09 报障）
 * 部分站点（如 `51acgs.com` 一族）证书**缺中间证书**：浏览器会自动按 AIA 扩展
 * 下载缺失的中间证书补全链 ⇒ 「浏览器能开」；Node 的 TLS 层（undici fetch）**不做
 * AIA 补全** ⇒ 引擎报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 一类错误。
 * 这不是「站点坏了」，是我们少做了浏览器都在做的那一步。
 *
 * ## `#377③` 为什么 `#372` 对百草露（`m.baicaolu.com`）**没生效**（实测复现）
 * 该站是 Let's Encrypt **新目录树的链**：`leaf → YE1 → Root YE → ISRG Root X2`（根）。
 * `#372` 有两个缺陷，任一都足以让补全白做：
 *  ① **只追一层**：循环体只遍历 **leaf 自己的** AIA URIs（LE 只给 1 条 `ye1.i.lencr.org`）
 *     ⇒ 拿到 YE1 就停；而 YE1 的 issuer 是 `Root YE`，仍不在系统根 ⇒ 重试照样失败。
 *     修：**递归追链** —— 每下载一张就解析**它自己的** AIA 继续往下追，直到某张证书的
 *     issuer 已在系统根（或超深度/无 AIA）。
 *  ② **`ca` 覆盖了系统信任库**：`new Agent({connect:{ca:pems}})` 会把 Node 的
 *     `rootCertificates` **整体替换**掉 ⇒ 就算链追全了，Node 也找不到顶端根（症状正是
 *     用户看到的 `UNABLE_TO_GET_ISSUER_CERT`）。修：`ca = [...tls.rootCertificates, ...pems]`。
 *
 * ## 修法（对整类生效）
 * 首次请求报**链不完整**类错误 ⇒ 用 `tls.connect({ rejectUnauthorized:false })` 拿 leaf
 * ⇒ 读 leaf 的 `infoAccess`（AIA）⇒ 下载中间证书（DER→PEM）⇒ **再看新证书的 AIA 继续
 * 追**（上限 {@link AIA_MAX_DEPTH}）⇒ 缓存 per-host 的 undici `Agent`
 * （`connect.ca = 系统根 ⧺ 追到的链`）⇒ 重试。
 * 补全成功后该 host 后续请求全部走带 ca 的 Agent（进程级缓存，直到 leaf 过期）。
 *
 * ## 刻意不做
 * · `CERT_HAS_EXPIRED` —— 过期证书没有「补」的意义，照旧报错（NET_ERROR_REASONS 文案不变）；
 * · `ERR_TLS_CERT_ALTNAME_INVALID` —— 域名不匹配补不了，照旧报错；
 * · 关掉校验（`rejectUnauthorized:false` 直连）—— 那是开中间人风险，不是补全。
 *
 * ## 与 fetchOnce 的关系
 * `fetchOnce` 捕获链不完整类错误后调 {@link aiaAgentFor}；拿到 Agent 就用它自带
 * 的 `dispatcher` 重试一次（`#372` 计数见 `netStats.aiaRetries`）。拿不到（无 AIA /
 * AIA 下载失败 / 超时）⇒ 抛**原始错误**，行为与从前完全一致（可回退性）。
 */

import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';

/** 触发 AIA 补全的 TLS 错误码 —— 「链不完整」一族（过期/域名不匹配刻意排除，见模块头注释） */
export const CHAIN_INCOMPLETE_TLS_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

interface CachedAgent {
  agent: Agent;
  /** leaf 证书过期时刻（毫秒）——到点丢弃重新补全，防止拿过期中间证书继续用 */
  expires: number;
}

const agentCache = new Map<string, CachedAgent>();
/** 并发去重：同一 host 同时只跑一次补全（首次报错风暴只触发一次 tls.connect） */
const inflight = new Map<string, Promise<Agent | null>>();

const AIA_TIMEOUT_MS = 8_000;

/** 该 host 已补全过的 Agent（含未过期检查）；没有返回 null。fetchOnce 据此决定重试。 */
export function cachedAiaAgent(url: string): Agent | null {
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    host = u.host;
  } catch {
    return null;
  }
  const hit = agentCache.get(host);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    agentCache.delete(host);
    return null;
  }
  return hit.agent;
}

/**
 * 取（或现场补全）该 URL host 的带 ca Agent。失败返回 null（调用方抛原始错误）。
 * 并发安全：同 host 的并发调用共享同一次补全。
 */
export function aiaAgentFor(url: string, log: (msg: string) => void): Promise<Agent | null> {
  const cached = cachedAiaAgent(url);
  if (cached) return Promise.resolve(cached);
  let host = '';
  let hostname = '';
  let port = 443;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return Promise.resolve(null);
    host = u.host;
    hostname = u.hostname;
    port = u.port ? Number(u.port) : 443;
  } catch {
    return Promise.resolve(null);
  }
  const p = inflight.get(host);
  if (p) return p;
  const job = buildAgent(host, hostname, port, log).finally(() => inflight.delete(host));
  inflight.set(host, job);
  return job;
}

async function buildAgent(host: string, hostname: string, port: number, log: (msg: string) => void): Promise<Agent | null> {
  try {
    const leaf = await fetchPeerLeaf(hostname, port);
    if (!leaf?.raw) {
      log(`[${host}] AIA 补全失败：取不到 leaf 证书（保持原错误）`);
      return null;
    }
    const pems = await collectChain(leaf.raw, log);
    if (!pems.length) {
      log(`[${host}] AIA 补全失败：证书未提供可用的 CA Issuers 地址（保持原错误）`);
      return null;
    }
    // ★ `#377③` `ca` **必须带上系统根**：该选项会**替换** Node 的 `rootCertificates`
    //  ⇒ 只给中间证书时，链顶端的根（如 ISRG Root X2）找不到 ⇒ 依旧
    //    `UNABLE_TO_GET_ISSUER_CERT`（百草露实测就是这个症状）。
    const ca = [...tls.rootCertificates, ...pems];
    const expires = Date.parse(leaf.valid_to ?? '') || Date.now() + 7 * 86_400_000;
    const agent = new Agent({ connect: { ca } });
    agentCache.set(host, { agent, expires });
    // 缓存防病态增长：只收「链不完整」的 host，正常量级极小；超限整表清空（下次按需重建）
    if (agentCache.size > 64) agentCache.clear();
    log(`[${host}] TLS 证书链不完整，已按 AIA 自动补全 ${pems.length} 张中间证书并重试`);
    return agent;
  } catch (e) {
    log(`[${host}] AIA 补全失败（保持原错误）：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** AIA 最多追几层（leaf→中间→中间…；LE 新链要 2 层，给 4 层余量防病态环） */
const AIA_MAX_DEPTH = 4;

/**
 * `#377③` **递归追链**：从 leaf 开始，逐张读 AIA（`CA Issuers - URI`）下载 issuer，
 * 直到某张证书的 issuer 已在**系统根**（无需再补）或超深度/无 AIA。返回补到的
 * 中间证书 PEM 列表（可能 0 张 = 无需补全或补不到）。
 *
 * ⚠️ `X509Certificate.infoAccess` 是**字符串**（`"CA Issuers - URI:http://..."`，
 *   多条逗号分隔），与 `PeerCertificate.infoAccess`（对象 map）形态不同 —— `#377③`
 *   踩过：按对象取键恒 undefined ⇒ 追链恒在第 0 层停（补全静默失效）。
 */
async function collectChain(leafDer: Buffer, log: (msg: string) => void): Promise<string[]> {
  const rootSubjects = new Set<string>();
  for (const pem of tls.rootCertificates) {
    try {
      rootSubjects.add(normDn(new X509Certificate(pem).subject));
    } catch {
      /* 忽略无法解析的根 */
    }
  }
  const pems: string[] = [];
  let current: Buffer | null = leafDer;
  for (let depth = 0; depth < AIA_MAX_DEPTH && current; depth += 1) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(current);
    } catch {
      break;
    }
    // 该证书的 issuer 已在系统根 ⇒ 链已完整，无需再追
    if (rootSubjects.has(normDn(cert.issuer))) break;
    const uri = aiaIssuerUris(cert).find((u) => /^https?:\/\//i.test(u));
    if (!uri) break;
    const der = await downloadDer(uri);
    if (!der) {
      log(`证书链补全：AIA 地址下载失败 ${uri}（第 ${depth + 1} 层）`);
      break;
    }
    pems.push(derToPem(der));
    current = der;
  }
  return pems;
}

/** 从 `X509Certificate.infoAccess`（字符串）抽 `CA Issuers - URI` 列表 */
export function aiaIssuerUris(cert: { infoAccess?: string | null }): string[] {
  const out: string[] = [];
  const text = String(cert.infoAccess ?? '');
  const re = /CA Issuers\s*-\s*URI\s*:\s*([^,\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!);
  return out;
}

/** DN 归一化（多行、各 RDN 顺序可能不同 ⇒ 逐行 trim + 排序后拼接，仅用于「是不是同一个」比较） */
export function normDn(dn: string): string {
  return dn
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort()
    .join('|');
}

/** `tls.connect` 拿 leaf 证书（rejectUnauthorized:false 仅用于**读取**证书，不用于发请求） */
function fetchPeerLeaf(hostname: string, port: number): Promise<PeerCertificate | null> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false },
      () => {
        // ⚠️ getPeerCertificate(true) 返回 isserCertificate 链表，但补全场景下链本来就
        // 不完整（issuerCertificate 常为空）⇒ 只取 leaf 本体足够（raw = DER）。
        const leaf = sock.getPeerCertificate(false);
        sock.end();
        resolve(leaf && Object.keys(leaf).length ? leaf : null);
      },
    );
    sock.setTimeout(AIA_TIMEOUT_MS, () => sock.destroy(new Error(`AIA 探测超时（>${AIA_TIMEOUT_MS}ms）`)));
    sock.on('error', reject);
  });
}

/** 下载中间证书（DER）。用 undici 的 fetch（http URI 居多；https 失败即放弃，不递归补全） */
async function downloadDer(uri: string): Promise<Buffer | null> {
  try {
    const res = await undiciFetch(uri, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(AIA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // DER 证书以 0x30 0x82 开头（ASN.1 SEQUENCE）；HTML 报错页直接放弃
    return buf.length > 64 && buf[0] === 0x30 && buf[1] === 0x82 ? buf : null;
  } catch {
    return null;
  }
}

/** DER → PEM（base64 每 64 字符换行；tls.connect 的 ca 选项标准形态） */
export function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}
