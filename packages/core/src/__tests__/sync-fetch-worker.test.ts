/**
 * `#160` 回归锁：**缺省同步 HTTP 不再依赖子进程**（worker 版），且 curl 仍是可用兜底。
 *
 * 为什么这些用例必须存在：`java.ajax` 的同步传输是**所有源的公共底座** ——
 * 它一坏，症状是「站点返回空 / RULE_PARSE」，看起来像源侧或解析缺陷（`#159` 就是被它骗过）。
 *
 * ## ⚠️ 测试脚手架的关键：被请求的 HTTP 服务必须跑在**另一个线程**
 * 同步传输会 `Atomics.wait` **阻塞主线程**（这正是「同步」的语义）⇒ 若把测试用的
 * `node:http` 服务放在主线程，它**永远无法应答**（第一版就这么写的：除了「不可达」那两条，
 * 其余全部超时失败）。所以服务放在一个 `worker_threads` 里，主线程只负责发请求。
 *
 * 覆盖：状态码 / 响应头 / **多条 Set-Cookie**（必须分开，合并会被 Expires 里的逗号破坏）/
 * 响应体 / 空值头必须原样发出（缺陷类AI 的教训）/ POST body / 超时返回 status 0 且**不串数据** /
 * 404 **不是**错误 / 50KB 大响应体不错位 / 连发不串。
 *
 * 运行：`pnpm --filter @yuedu/core test`
 */
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canUseWorkerSyncFetch, defaultSyncFetch, disposeSyncFetchWorker, workerSyncFetch } from '../net/sync-fetch-worker';
import type { SyncHttpRequest } from '../selector/js';

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * 把「被请求的服务」放进 worker。⚠️ 源码是模板串 ⇒ **注释里不能出现反引号**。
 */
const SERVER_SRC = `
const { parentPort } = require('node:worker_threads');
const { createServer } = require('node:http');
const seen = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += String(c); });
  req.on('end', () => {
    seen.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
    const url = req.url || '';
    if (url === '/slow') { setTimeout(() => { try { res.destroy(); } catch (e) {} }, 1500); return; }
    if (url === '/404') { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('nope'); return; }
    if (url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(50000)); return; }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'x-echo-ua': String(req.headers['user-agent'] || ''),
      'set-cookie': ['sid=abc; Path=/', 'theme=dark; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/'],
    });
    res.end(JSON.stringify({ ok: true, got: body }));
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ type: 'port', port: server.address().port }));
parentPort.on('message', (m) => { if (m && m.type === 'dump') parentPort.postMessage({ type: 'dump', seen }); });
`;

interface TestServer {
  origin: string;
  /** 取回服务端收到的请求（主线程阻塞期间的消息会在恢复后投递） */
  dump: () => Promise<Captured[]>;
  close: () => void;
}

async function startServer(): Promise<TestServer> {
  const w = new Worker(SERVER_SRC, { eval: true });
  const waitFor = <T,>(type: string): Promise<T> =>
    new Promise((resolve) => {
      const onMsg = (m: { type?: string } & Record<string, unknown>): void => {
        if (m?.type !== type) return;
        w.off('message', onMsg);
        resolve(m as unknown as T);
      };
      w.on('message', onMsg);
    });
  const portMsg = await waitFor<{ port: number }>('port');
  return {
    origin: `http://127.0.0.1:${portMsg.port}`,
    dump: async () => {
      const p = waitFor<{ seen: Captured[] }>('dump');
      w.postMessage({ type: 'dump' });
      return (await p).seen;
    },
    close: () => void w.terminate(),
  };
}

const req = (url: string, extra: Partial<SyncHttpRequest> = {}): SyncHttpRequest => ({
  method: 'GET',
  url,
  headers: {},
  timeoutMs: 5000,
  ...extra,
});

test('#160：本机支持 worker 版（能力探测为真）', () => {
  assert.equal(canUseWorkerSyncFetch(), true, 'Node ≥22 应有 SharedArrayBuffer + Atomics.wait + worker_threads');
});

test('#160：状态码 / 响应头 / 响应体 / 多条 Set-Cookie', async () => {
  const s = await startServer();
  try {
    const r = workerSyncFetch(req(`${s.origin}/api`, { headers: { 'user-agent': 'Legado/3.0', accept: '*/*' } }));
    assert.equal(r.status, 200, `状态码应为 200，实得 ${r.status}`);
    assert.match(r.headers['content-type'] ?? '', /application\/json/, `content-type 透传：${r.headers['content-type']}`);
    assert.equal(r.headers['x-echo-ua'], 'Legado/3.0', '请求头真的发出去了');
    assert.equal(r.body.includes('"ok":true'), true, `响应体应解析出来，实得 ${r.body.slice(0, 80)}`);
    // ★ 两条 Set-Cookie 必须**分开**返回（合并会被 Expires 里的逗号截断）
    assert.equal(r.setCookie.length, 2, `应取到 2 条 Set-Cookie，实得 ${JSON.stringify(r.setCookie)}`);
    assert.match(r.setCookie[1] ?? '', /Expires=Wed, 21 Oct 2099/, '第二条的 Expires 里的逗号必须完整保留');
  } finally {
    s.close();
  }
});

test('#160：空值头必须**原样发出**（curl 的 `-H Name:` 会把它删掉，缺陷类AI）', async () => {
  const s = await startServer();
  try {
    workerSyncFetch(req(`${s.origin}/empty-header`, { headers: { authorization: '', 'qm-params': 'sign=1' } }));
    const h = (await s.dump())[0]?.headers ?? {};
    assert.ok('authorization' in h, `空值头 authorization 必须存在，实得 ${JSON.stringify(Object.keys(h))}`);
    assert.equal(h['authorization'], '', '且值必须是空串');
    assert.equal(h['qm-params'], 'sign=1', '其它头不受影响');
  } finally {
    s.close();
  }
});

test('#160：POST body 真的发出去（源脚本的搜索/登录依赖它）', async () => {
  const s = await startServer();
  try {
    const r = workerSyncFetch(req(`${s.origin}/post`, { method: 'POST', body: 'kw=%E5%89%91&page=1' }));
    assert.equal(r.status, 200);
    assert.match(r.body, /kw=%E5%89%91/, '服务端应收到 body 并回显');
    const seen = await s.dump();
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.body, 'kw=%E5%89%91&page=1');
  } finally {
    s.close();
  }
});

test('#160：404 是**正常响应**（不是错误）—— 上层要按状态码分支', async () => {
  const s = await startServer();
  try {
    const r = workerSyncFetch(req(`${s.origin}/404`));
    assert.equal(r.status, 404, `应如实返回 404，实得 ${r.status}`);
    assert.equal(r.body, 'nope', '404 的 body 也要拿到');
  } finally {
    s.close();
  }
});

test('#160：超时 ⇒ status 0 + 空 body（且**作废 worker**，下一次不串数据）', async () => {
  const s = await startServer();
  try {
    const t0 = Date.now();
    const r = workerSyncFetch(req(`${s.origin}/slow`, { timeoutMs: 600 }));
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, `超时应返回 status 0，实得 ${r.status}`);
    assert.equal(r.body, '', '超时的 body 必须为空串');
    assert.ok(ms < 4000, `不应等太久（实测 ${ms}ms）`);
    // ★ 防空转：紧接着打一个正常请求，必须拿到**它自己的**结果（作废/重建逻辑对不对就看这条）
    const ok = workerSyncFetch(req(`${s.origin}/after-timeout`));
    assert.equal(ok.status, 200, `超时之后必须能正常请求，实得 ${ok.status}`);
    assert.match(ok.body, /"ok":true/, '而且拿到的是**这次**的响应体，不是上一次的残留');
  } finally {
    s.close();
  }
});

test('#160：大响应体（50KB）完整回传（共享内存切片不能错位）', async () => {
  const s = await startServer();
  try {
    const r = workerSyncFetch(req(`${s.origin}/big`));
    assert.equal(r.body.length, 50_000, `响应体长度应完整，实得 ${r.body.length}`);
  } finally {
    s.close();
  }
});

test('#160：连发 5 次不串数据（每次都是自己的结果）', async () => {
  const s = await startServer();
  try {
    const echoed: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = workerSyncFetch(req(`${s.origin}/n${i}`, { headers: { 'x-i': String(i) } }));
      assert.equal(r.status, 200);
      assert.match(r.body, /"ok":true/, `第 ${i} 次拿到的应是本次响应体`);
      echoed.push(r.headers['x-echo-ua'] ?? null);
    }
    /**
     * `x-echo-ua` 是服务端回显的 `user-agent`（undici 会给每个请求加 `user-agent: node`）
     * ⇒ **只要 5 次完全相同**就说明没有读到别人的残留；不写死 'node'（避免绑 Node 版本）。
     */
    assert.equal(new Set(echoed).size, 1, `5 次的回显应一致（说明没串数据），实得 ${JSON.stringify(echoed)}`);
    const seen = await s.dump();
    assert.deepEqual(seen.map((x) => x.url), ['/n0', '/n1', '/n2', '/n3', '/n4'], '服务端应按顺序收到 5 个不同路径');
    assert.equal(seen[4]?.headers['x-i'], '4', '第 5 次带的是自己的 x-i');
  } finally {
    s.close();
  }
});

test('#160：不可达地址 ⇒ status 0 + 空 body（不抛、不挂死）', async () => {
  const t0 = Date.now();
  const r = workerSyncFetch(req('http://127.0.0.1:1/nope', { timeoutMs: 3000 }));
  assert.equal(r.status, 0, `连不上应 status 0，实得 ${r.status}`);
  assert.equal(r.body, '');
  assert.ok(Date.now() - t0 < 6000, '不应挂死');
});

test('#160：缺省传输 = worker（`YUEDU_SYNC_FETCH` 未设时不走 curl）', async () => {
  const s = await startServer();
  const saved = process.env.YUEDU_SYNC_FETCH;
  delete process.env.YUEDU_SYNC_FETCH;
  try {
    const r = defaultSyncFetch(req(`${s.origin}/default`));
    assert.equal(r.status, 200, `缺省传输应能正常工作，实得 ${r.status}`);
    assert.match(r.body, /"ok":true/);
  } finally {
    if (saved === undefined) delete process.env.YUEDU_SYNC_FETCH;
    else process.env.YUEDU_SYNC_FETCH = saved;
    s.close();
    disposeSyncFetchWorker();
  }
});
