/**
 * 缺陷类T —— 网络护栏（2026-09-21，用户实测报告后新增）。
 *
 * 背景：跑全量基线时「占满全部网络带宽 → 同局域网其它设备卡死无法上网」，同时服务端超时暴增。
 * 成因三条：① 裸 `fetch()` 无连接/并发上限（undici 单 origin 不限连接 → NAT/连接表被打满）；
 * ② 目录多页 `Promise.all` 无界扇出；③ 媒体源整包下载（数十 MB）。
 *
 * 本测试锁四件事（全部用**本地 HTTP 服务**，不碰外网）：
 * 1. 全局并发上限；2. 单主机并发上限；3. 令牌桶限速（实测 B/s ≤ 上限）；4. 响应体上限（截断 + 留痕标记）。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test, { after, before } from 'node:test';

import {
  createHttpClient,
  configureNetGuard,
  netStats,
  netEnvFacts,
  resetNetStats,
  defaultNetGuardConfig,
  configureTraffic,
  defaultTrafficConfig,
  domainBreakerState,
  resetTraffic,
} from '../index';

let server: Server;
let base = '';
/** 服务端同时在飞的请求数（用来验证「上限真的生效」） */
let inFlight = 0;
let peakInFlight = 0;
/** 服务端累计写出的字节（用来验证限速） */
let servedBytes = 0;

before(async () => {
  server = createServer((req, res) => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const bytes = Number(url.searchParams.get('bytes') ?? '10');
    const chunk = Buffer.alloc(Math.min(bytes, 64 * 1024), 0x61);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    let sent = 0;
    const push = () => {
      if (sent >= bytes) {
        servedBytes += sent;
        inFlight--;
        res.end();
        return;
      }
      const n = Math.min(chunk.length, bytes - sent);
      sent += n;
      // 分片写出：让「限速」有可观测的时间维度
      res.write(chunk.subarray(0, n)) ? setTimeout(push, 1) : res.once('drain', push);
    };
    push();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  configureNetGuard(null);
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

/** 每例前重置计数（`lastPeak` 用来按「本次窗口」比较） */
function resetCounters() {
  inFlight = 0;
  peakInFlight = 0;
  servedBytes = 0;
  resetNetStats();
}

test('① 全局并发上限：同时在飞不超过 maxConcurrent', async () => {
  // `#200`：v2 流量护栏上线后，「全局/单主机」两级是 **v1 保留路径** ⇒ 本测试显式关掉 v2
  // （v2 的域名/任务/全局三层限额由 `traffic-guard.test.ts` 覆盖）。
  const prevV2 = process.env.YUEDU_GUARD_V2;
  process.env.YUEDU_GUARD_V2 = '0';
  configureNetGuard({ maxConcurrent: 2, maxPerHost: 10, maxBytesPerSec: 50 * 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024 });
  resetCounters();
  const http = createHttpClient();
  const jobs = Array.from({ length: 10 }, () => http.request(`${base}/x?bytes=64`));
  const res = await Promise.all(jobs);
  assert.equal(res.length, 10);
  assert.ok(peakInFlight <= 2, `峰值并发应 ≤2，实际 ${peakInFlight}`);
  assert.ok(netStats.peakInFlight <= 2, `护栏自记峰值应 ≤2，实际 ${netStats.peakInFlight}`);
  if (prevV2 === undefined) delete process.env.YUEDU_GUARD_V2;
  else process.env.YUEDU_GUARD_V2 = prevV2;
});

test('② 单主机并发上限：同一 host 被单独限流', async () => {
  const prevV2 = process.env.YUEDU_GUARD_V2;
  process.env.YUEDU_GUARD_V2 = '0'; // 同上：单主机限流是 v1 保留路径
  configureNetGuard({ maxConcurrent: 10, maxPerHost: 2, maxBytesPerSec: 50 * 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024 });
  resetCounters();
  const http = createHttpClient();
  await Promise.all(Array.from({ length: 8 }, () => http.request(`${base}/y?bytes=64`)));
  assert.ok(peakInFlight <= 2, `单主机峰值应 ≤2，实际 ${peakInFlight}`);
  if (prevV2 === undefined) delete process.env.YUEDU_GUARD_V2;
  else process.env.YUEDU_GUARD_V2 = prevV2;
});

test('③ 带宽上限（令牌桶）：实测吞吐不得超过上限（±50% 容差）', async () => {
  const cap = 200 * 1024; // 200KB/s
  configureNetGuard({ maxConcurrent: 4, maxPerHost: 4, maxBytesPerSec: cap, maxBodyBytes: 8 * 1024 * 1024 });
  resetCounters();
  const http = createHttpClient();
  const t0 = Date.now();
  const res = await http.request(`${base}/big?bytes=${600 * 1024}`); // 600KB
  const elapsed = (Date.now() - t0) / 1000;
  assert.equal(typeof res.body, 'string');
  const len = (res.body as string).length;
  assert.ok(len >= 590 * 1024, `正文应完整（未被截断）: ${len}`);
  const bps = len / elapsed;
  assert.ok(bps <= cap * 1.5, `吞吐 ${(bps / 1024).toFixed(0)}KB/s 超过上限 ${cap / 1024}KB/s 的 1.5 倍`);
  assert.ok(elapsed > 1.5, `600KB @200KB/s 至少应耗时 ~1.5s，实际 ${elapsed.toFixed(2)}s`);
});

test('④ 响应体上限：超限截断 + 标记 truncated（不静默）', async () => {
  configureNetGuard({ maxConcurrent: 4, maxPerHost: 4, maxBytesPerSec: 50 * 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024 });
  resetCounters();
  const http = createHttpClient();
  const res = await http.request(`${base}/huge?bytes=${2 * 1024 * 1024}`, { maxBodyBytes: 256 * 1024 });
  assert.equal(res.truncated, true, '应标记 truncated');
  const len = (res.body as string).length;
  assert.ok(len <= 256 * 1024 && len >= 255 * 1024, `应恰好截到 256KB，实际 ${len}`);
  assert.equal(netStats.truncated, 1);
});

test('⑤ 默认护栏：按「线路 100Mbps 的 **45%**」推导，且并发/体积都有默认值', () => {
  configureNetGuard(null);
  const cfg = defaultNetGuardConfig();
  assert.equal(cfg.maxConcurrent, 6);
  assert.equal(cfg.maxPerHost, 2);
  // ★ 2026-10-02 用户按参考设置上调：30% → **45%**（100Mbps 的 45% = 5.625MB/s）
  assert.equal(cfg.maxBytesPerSec, Math.floor((100 * 1_000_000) / 8 * 0.45));
  assert.equal(cfg.maxBodyBytes, 8 * 1024 * 1024);
});

/* ── ⑥⑦⑧⑨ 连接阶段重试 / 错误分类计数 / 代理环境事实（post8 归因补强，2026-09-21）────────── */

/**
 * 造一个「连接刚建立就断开」的服务器：用于验证**连接阶段的瞬时失败会不会被重试**。
 * `dropAll=false` → 只断第 1 条连接（第二次就正常，模拟"瞬时"）；`true` → 全断（模拟持续故障）。
 */
async function makeFlaky(dropAll: boolean): Promise<{ url: string; conns: () => number; close: () => Promise<void> }> {
  let conns = 0;
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });
  srv.on('connection', (sock) => {
    conns++;
    if (dropAll || conns === 1) sock.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/flaky`,
    conns: () => conns,
    close: async () => {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

const LOOSE = { maxConcurrent: 4, maxPerHost: 4, maxBytesPerSec: 50 * 1024 * 1024, maxBodyBytes: 8 * 1024 * 1024 };

test('⑥ 幂等 GET：连接阶段瞬时失败自动重试一次并恢复（post8「209 主机同时 10s 连接超时」的补强）', async () => {
  configureNetGuard({ ...LOOSE, maxRetries: 1 });
  resetCounters();
  const f = await makeFlaky(false);
  try {
    const http = createHttpClient();
    const res = await http.request(f.url);
    assert.equal(res.status, 200, '重试后应成功');
    assert.equal(netStats.retries, 1, `应发生 1 次重试，实际 ${netStats.retries}`);
    assert.equal(netStats.retryRecovered, 1, '重试应被记为"恢复成功"');
    assert.equal(netStats.requests, 2, `总尝试次数应为 2，实际 ${netStats.requests}`);
    assert.equal(netStats.errReset + netStats.errConnectTimeout, 0, '恢复成功则不应计入失败分类');
    assert.ok(f.conns() >= 2, '服务端应看到 ≥2 条连接（第一次被断、第二次成功）');
  } finally {
    await f.close();
  }
});

test('⑦ 非幂等请求（POST 带 body）**不重试**：避免重复提交副作用', async () => {
  configureNetGuard({ ...LOOSE, maxRetries: 3 });
  resetCounters();
  const f = await makeFlaky(true);
  try {
    const http = createHttpClient();
    await assert.rejects(() => http.request(f.url, { method: 'POST', body: 'a=1' }));
    assert.equal(netStats.requests, 1, `POST 不得重试，实际尝试 ${netStats.requests} 次`);
    assert.equal(netStats.retries, 0);
  } finally {
    await f.close();
  }
});

test('⑧ 连接被拒（ECONNREFUSED）不重试，且落进错误分类计数', async () => {
  configureNetGuard({ ...LOOSE, maxRetries: 1 });
  resetCounters();
  // 先占一个端口再释放 → 拿到"一定没人监听"的端口号
  const tmp = createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  const port = (tmp.address() as { port: number }).port;
  await new Promise<void>((r) => tmp.close(() => r()));

  const http = createHttpClient();
  await assert.rejects(() => http.request(`http://127.0.0.1:${port}/nobody`));
  assert.equal(netStats.requests, 1, 'ECONNREFUSED 是确定性失败，不该重试');
  assert.equal(netStats.errOther, 1, `应计入 errOther，实际 ${JSON.stringify(netStats)}`);
});

test('⑨ netEnvFacts：暴露"有代理 env 但 Node 的 fetch 不读它"的易误判状态（并脱敏凭据）', () => {
  // ⚠️ 注入 env 而不是改 `process.env`：Windows 的环境变量名**大小写不敏感**
  //    （`http_proxy` 与 `HTTP_PROXY` 是同一个键），先设后删会把它自己删掉 —— 实测踩过。
  const f = netEnvFacts({ http_proxy: 'http://user:secret@127.0.0.1:1234' });
  assert.equal(f.proxyMismatch, true, '有代理 env 时必须标记 mismatch');
  assert.equal(f.fetchUsesProxy, false, '当前实现不读代理 env');
  assert.ok(!JSON.stringify(f.proxyEnv).includes('secret'), `凭据必须脱敏：${JSON.stringify(f.proxyEnv)}`);

  const none = netEnvFacts({});
  assert.equal(none.proxyMismatch, false);
  assert.deepEqual(none.proxyEnv, {});
});

/**
 * ★ `#470c`（2026-10-15 用户第 3 次实测）：**媒体二进制不按文本读**。
 *
 * 实证：枫叶音乐盒的章节地址 = `…/meting/?server=netease&type=url&id=…`，回 **302** 指向 CDN mp3；
 * content 阶段的主抓取默认跟随重定向 ⇒ 整首音频（10.85MB）当**文本**拉 ⇒ 撞文本通道 8MB 护栏
 * （`[net-guard] 响应体超过上限 8MB，已截断`）。`#470①`（代理）与 `#470②`（followPlayPage）
 * 都不在这条链路上 ⇒ 症状复现。本闸门放在 `fetchOnce`：**最终** `Content-Type` 是
 * `audio/*|video/*` 且非 `mpegurl` ⇒ 主动丢弃响应体（返回空 body，保留 status/headers/url）。
 */
test('`#470c` 媒体响应体不按文本读：返回空 body 且不触发截断告警', async () => {
  const media = createServer((_req, res) => {
    // 30MB 音频（远超文本通道 8MB 上限）：旧实现必然截断 + 告警
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(30 * 1024 * 1024) });
    res.end(Buffer.alloc(30 * 1024 * 1024, 0x00));
  });
  await new Promise<void>((r) => media.listen(0, '127.0.0.1', r));
  const port = (media.address() as { port: number }).port;
  try {
    const c = createHttpClient();
    const res = await c.request(`http://127.0.0.1:${port}/song`, {});
    assert.equal(res.body, '', '音频体必须被主动丢弃（空 body）');
    assert.equal(res.truncated, undefined, '不得走 8MB 截断通道（那正是用户看到的告警）');
    assert.equal(res.headers['content-type'], 'audio/mpeg', 'headers 必须保留（脚本靠它判类型）');
    assert.equal(res.status, 200);

    // 对偶①：HLS **文本清单**必须照常读回（`mpegurl` 是文本，不能当媒体二进制丢掉）
    const hls = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:5,\nseg0.ts\n');
    });
    await new Promise<void>((r) => hls.listen(0, '127.0.0.1', r));
    const hp = (hls.address() as { port: number }).port;
    try {
      const r2 = await c.request(`http://127.0.0.1:${hp}/index.m3u8`, {});
      assert.ok(String(r2.body).includes('#EXTM3U'), `m3u8 清单必须照常返回文本（实得 ${JSON.stringify(r2.body)}）`);
    } finally {
      hls.close();
    }
  } finally {
    media.close();
  }
});

/* ══ `#708`：HEAD 等非必需探测不得计入域名熔断（否则误伤同域 GET） ══
 *
 * 实证（用户 Movieffm 日志）：`Reload()` 每次先 `java.head(e)` 取 etag —— 旧实现把 HEAD
 * 超时也计进熔断计数；外链主机慢时，几次 HEAD 超时 + GET 超时叠到 6 次 ⇒ 域名熔断 40s
 * ⇒ 后续 sortUrl/loginUrl 全被误伤（日志 `[net-guard] 域名熔断 … 还需 33s`），而 HEAD 的
 * etag 本仓从不用于重验 —— HEAD 失败说明不了「GET 也不可用」。
 *
 * 场景：造一个对 HEAD 必超时、对 GET 正常应答的本地服务器，配置小阈值熔断，验证：
 *  · `countBreaker:false` 的 HEAD 超时后，同域 GET 不受影响（熔断不触发）；
 *  · 对照：默认 HEAD（countBreaker=true）会把域名直接熔断（证明选项真的生效）。
 */
test('`#708` countBreaker:false 的 HEAD 超时不触发域名熔断；默认 HEAD 会', async () => {
  const prevV2 = process.env.YUEDU_GUARD_V2;
  process.env.YUEDU_GUARD_V2 = '1'; // 熔断只在 v2 护栏下生效 ⇒ 本测试必须锁定 v2
  try {
    // 小阈值：连续 2 次失败即熔断 120ms（数值与生产不同，语义相同）
    const baseCfg = defaultTrafficConfig();
    configureTraffic({
      ...baseCfg,
      globalMaxConcurrent: 50,
      globalRps: 10_000,
      domainTotal: 10,
      domainPool: 4,
      breaker: { consecutiveFailures: 2, cooldownMs: 5000, halfOpenConcurrency: 1, recoverStepMs: 30 },
      instant: { ...baseCfg.instant, perDomainPool: 4, taskConcurrent: 10, taskRps: 10_000, failCooldownMs: 0 },
      batch: { ...baseCfg.batch, perDomainPool: 4, taskConcurrent: 10, taskRps: 10_000, failCooldownMs: 0 },
    });

    // 只对 HEAD 挂起、GET 正常应答的服务器
    const srv = createServer((req, res) => {
      if (req.method === 'HEAD') {
        // 故意不返回：HEAD 永远超时（模拟 Reload 取 etag 卡住的外链主机）
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    // 熔断按 `new URL(url).host` 计数 —— 本机实测时 host 带端口，不能只写 `127.0.0.1`
    const host = `127.0.0.1:${port}`;
    try {
      const http = createHttpClient();
      assert.equal(domainBreakerState(host).open, false, '初始不应熔断');

      // ① 非必需 HEAD（countBreaker:false）超时两次 ⇒ 不得熔断，GET 照常成功
      for (let i = 0; i < 2; i++) {
        await assert.rejects(
          () => http.request(`${baseUrl}/probe`, { method: 'HEAD', timeout: 120, countBreaker: false }),
          /超时/,
        );
      }
      assert.equal(domainBreakerState(host).open, false, '非必需 HEAD 失败不得触发熔断（否则 GET 被误伤）');
      const ok = await http.request(`${baseUrl}/probe`, { timeout: 2000 });
      assert.equal(ok.status, 200, '同域 GET 必须不受 HEAD 超时影响');

      // ② 对照：默认 HEAD（countBreaker=true）两次超时 ⇒ 域名熔断
      for (let i = 0; i < 2; i++) {
        await assert.rejects(
          () => http.request(`${baseUrl}/probe2`, { method: 'HEAD', timeout: 120 }),
          /超时/,
        );
      }
      assert.equal(domainBreakerState(host).open, true, '默认 HEAD 仍计入熔断（选项必须真的生效）');
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  } finally {
    if (prevV2 === undefined) delete process.env.YUEDU_GUARD_V2;
    else process.env.YUEDU_GUARD_V2 = prevV2;
    resetTraffic();
  }
});
