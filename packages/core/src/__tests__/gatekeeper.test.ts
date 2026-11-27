/**
 * `#151` gatekeeper 挑战自动解证的回归锁。
 *
 * fixture 来自 **2026-10-10 对 `cn.baozimhcn.com` 的真实取证**
 * （`.tmp-228/gk-page.html` / 验证页内联 cfg / 403 指引 JSON），不是凭空编的。
 * 探针级端到端已实证：Node 全自动 ⑥ 步通过、重试原请求 200（180KB 真页面）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { createServer } from 'node:http';

import {
  leadingZeroBits, parseGatekeeperCfg, parseGatekeeperGuide, solveGatekeeperPow, solveGatekeeperPowAsync,
} from '../net/gatekeeper';

/** 真实 403 指引（实测原样） */
const GUIDE_BODY = '{"challenge_url":"/__gatekeeper_challenge/start?return=%2F","error":"challenge_required"}';

/** 真实验证页内联 cfg（截取自实测页面；ticket 略长，保留原样以锁提取正则） */
const CFG_SNIPPET =
  'g.start({challengeId:"a9ef00364eab3681361e9e18c7607feaea1cf17221d6674e437e1257838718b5",' +
  'ticket:"AhCYjqnXBKD-CoDd2wGp7wA2Tqs2gTYenhjHYH_q6hzxciHWZ05DfhJXg4cYtStMhzv8BNnOWSShIDExz",' +
  'verifyUrl:"/__gatekeeper_challenge/verify",' +
  'workerUrl:"/__gatekeeper_challenge/assets/1b225ffd/worker.js",difficultyBits:16,lifeMs:180000,computeMs:120000,submitMs:15000});';

/* ── parseGatekeeperGuide：从严判据（防误触发） ─────────────────────────── */

test('#151 指引识别：403 + JSON challenge_required ⇒ 取 challenge_url', () => {
  assert.equal(parseGatekeeperGuide(403, 'application/json; charset=utf-8', GUIDE_BODY), '/__gatekeeper_challenge/start?return=%2F');
});

test('#151 指引识别：其余形态一律不触发（WAF 硬拦截页 / 200 / 非 JSON / 大 body）', () => {
  const wafPage =
    '<!DOCTYPE html><html><head><title>WAF拦截页面</title></head><body>您的请求已中断</body></html>';
  assert.equal(parseGatekeeperGuide(403, 'text/html', wafPage), null, '腾讯云 WAF 硬拦截页（得间现状）不触发');
  assert.equal(parseGatekeeperGuide(200, 'application/json', GUIDE_BODY), null, '非 403 不触发');
  assert.equal(parseGatekeeperGuide(403, 'text/html', GUIDE_BODY), null, 'content-type 非 JSON 不触发');
  assert.equal(parseGatekeeperGuide(403, 'application/json', '{"error":"other"}'), null, 'error 不对不触发');
  assert.equal(parseGatekeeperGuide(403, 'application/json', 'x'.repeat(600)), null, '异常大的 body 不触发');
});

/* ── parseGatekeeperCfg：真实验证页样本 ────────────────────────────────── */

test('#151 cfg 提取：真实页面片段 ⇒ 四要素齐全 + bits=16', () => {
  const cfg = parseGatekeeperCfg(CFG_SNIPPET);
  assert.ok(cfg, '应能提取');
  assert.equal(cfg?.challengeId, 'a9ef00364eab3681361e9e18c7607feaea1cf17221d6674e437e1257838718b5');
  assert.equal(cfg?.verifyUrl, '/__gatekeeper_challenge/verify');
  assert.equal(cfg?.difficultyBits, 16);
  assert.ok(cfg?.ticket.startsWith('AhCYjqnXBKD-'));
});

test('#151 cfg 提取：缺要素 / bits 越界 ⇒ null（不硬猜）', () => {
  assert.equal(parseGatekeeperCfg(CFG_SNIPPET.replace(/ticket:"[^"]*"/, '')), null, '缺 ticket');
  assert.equal(parseGatekeeperCfg(CFG_SNIPPET.replace(/difficultyBits:16/, 'difficultyBits:32')), null, 'bits>24 ⇒ 拒解（不是给人算的量级）');
  assert.equal(parseGatekeeperCfg('<html>无关页面</html>'), null);
});

/* ── solveGatekeeperPow：低 bits 定长输入 + 独立可验证 ──────────────────── */

test('#151 PoW：解出的 nonce 独立可验证（SHA-256 前导零 ≥ bits）', () => {
  const cfg = { challengeId: 'deadbeef', ticket: 't', verifyUrl: '/v', difficultyBits: 10 };
  const r = solveGatekeeperPow(cfg);
  assert.ok(r, '10bit 平均 1024 次，必解出');
  const digest = crypto.createHash('sha256').update(`gatekeeper-pow-v1:deadbeef:${r?.nonce}`).digest();
  assert.ok(leadingZeroBits(digest) >= 10, `解出值必须真满足前导零 ≥10（实得 ${leadingZeroBits(digest)}）`);
  assert.ok(Number(r?.nonce) < 1 << 14, `nonce 应在期望量级（实得 ${r?.nonce}）`);
});

test('#151 PoW：与 worker.js 同款语义 —— nonce 从 "0" 起十进制递增', () => {
  // bits=0 ⇒ 第 0 个 nonce("0") 恒成立 ⇒ 锁「从 0 起步」
  const r = solveGatekeeperPow({ challengeId: 'x', ticket: 't', verifyUrl: '/v', difficultyBits: 1 });
  assert.ok(r);
  assert.equal(r?.attempts >= 1, true);
});

test('#151 leadingZeroBits：已知向量（对拍 worker.js 语义）', () => {
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 1])), 23, '两个 0 字节 + 0b…01 ⇒ 16+7（worker.js 对 0 字节也走满 8 位，不提前停）');
  assert.equal(leadingZeroBits(new Uint8Array([0xff])), 0, '最高位是 1 ⇒ 0');
  assert.equal(leadingZeroBits(new Uint8Array([0x0f])), 4, '0b00001111 ⇒ 4');
  assert.equal(leadingZeroBits(new Uint8Array([0xf0])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x00])), 8);
});

/* ── #384：跨主机 302 —— 挑战在重定向后的主机上，重试必须打最终 URL ─────────
 * 真实形态（2026-10-10 包子漫画（优）取证）：主站 `cn.bzmgcn.com` 是纯 nginx 302 →
 * 镜像 `cn.cnbzmg.com`，403 指引 JSON 来自**镜像**。两个坑：
 * ① 解证的 origin 必须取最终响应的（resp.url），按原始 URL 解证 = 错主机 binding 失败；
 * ② fetch 跟随**跨主机**重定向会剥掉 Cookie 头（fetch 规范剔除敏感头）⇒ 解证通过后
 *    按原 URL 重试 = 302 一跳后 clearance 全丢 ⇒ 镜像又回 challenge_required。
 *    重试必须直接打 `resp.url`（clearance 本来就绑定镜像，直打必通）。
 * 本锁用两个本地 server 复刻整条链（127.0.0.1 不同端口 = 不同 origin，重定向剥
 * Cookie 的行为与真实跨主机一致），没有这条锁 ①② 都会静默回归。 */

test('#384 跨主机 302：origin 取 resp.url + 重试打 resp.url（clearance 绑定重定向后的主机）', async () => {
  const { createHttpClient } = await import('../net/index.js');
  const hits: { url: string; cookie: string }[] = [];
  const b = createServer((req, res) => {
    hits.push({ url: req.url ?? '', cookie: String(req.headers.cookie ?? '') });
    if (req.url === '/target') {
      if (req.headers.cookie?.includes('gk_clearance=')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('OK-page');
        return;
      }
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"challenge_url":"/__gatekeeper_challenge/start?return=%2Ftarget","error":"challenge_required"}');
      return;
    }
    if (req.url?.startsWith('/__gatekeeper_challenge/start')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'gk_browser=abc; Path=/' });
      res.end(CFG_SNIPPET.replace('difficultyBits:16', 'difficultyBits:10'));
      return;
    }
    if (req.url?.startsWith('/__gatekeeper_challenge/verify')) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'gk_clearance=pass; Path=/',
      });
      res.end('{"status":"passed"}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const a = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(b.address() as { port: number }).port}/target` });
    res.end();
  });
  const listen = (s: ReturnType<typeof createServer>) =>
    new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  await listen(b);
  await listen(a);
  try {
    const portA = (a.address() as { port: number }).port;
    const portB = (b.address() as { port: number }).port;
    const http = createHttpClient();
    const resp = await http.request(`http://127.0.0.1:${portA}/target`, {
      headers: { 'User-Agent': 'test-agent' },
    });
    assert.equal(resp.status, 200, '解证后应自动重试成功');
    assert.equal(resp.body, 'OK-page');
    assert.ok(String(resp.url).includes(`:${portB}/target`), `最终 URL 应是重定向后的主机（实得 ${resp.url}）`);
    const targetHits = hits.filter((h) => h.url === '/target');
    assert.equal(targetHits.length, 2, 'B 的 /target 应被请求两次：初次 403 + 解证后重试');
    assert.ok(targetHits[1]?.cookie.includes('gk_clearance=pass'), '重试必须带上解证所得 clearance');
    assert.equal(targetHits[0]?.cookie ?? '', '', '初次 403 的请求不该带 clearance');
    if (process.env.YUEDU_GK_DEBUG) console.warn('[hits]', JSON.stringify(hits, null, 1));
  } finally {
    b.close();
    a.close();
  }
});

/**
 * `#476`（2026-10-15 用户实测「卡得没法用」）：**PoW 必须在求解期间让出主线程**。
 *
 * 病根：`solveGatekeeperPow` 是主线程紧循环（实测日志 `PoW 25163 次通过`），期间事件循环
 * 完全停摆 —— 而 `/api/diag` 的 `blocks` 里**没有**这一项，所以此前一直看不到真凶。
 * 这条锁**用「定时器能不能在求解过程中触发」当判据**（不看求解耗时，看是否让出）：
 * 旧同步版必然 `ticks === 0`（定时器根本没机会跑）。
 */
test('`#476` 让出版 PoW：求解期间定时器仍能触发（主线程未被冻住）', async () => {
  const cfg = { ...parseGatekeeperCfg(CFG_SNIPPET)!, difficultyBits: 18 };
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 5);
  const t0 = Date.now();
  const pow = await solveGatekeeperPowAsync(cfg, 2000);
  clearInterval(timer);
  assert.ok(pow, 'difficultyBits=18 应在预算内解出');
  assert.ok(pow.attempts > 2000, `应发生多次让出（attempts=${pow.attempts}）`);
  assert.ok(
    ticks >= 2,
    `求解期间定时器必须能触发（ticks=${ticks}，耗时 ${Date.now() - t0}ms）—— 旧同步版会冻住主线程`,
  );
});
