/**
 * `#386` 引擎接入系统代理的回归锁。
 *
 * e2e 用**本地真代理**：undici ProxyAgent 对 `http:` 目标 + `http:` 代理走
 * **absolute-form 明文转发**（proxy-agent.js `Http1ProxyWrapper` 分支，已查证源码），
 * 所以测试桩就是一个普通 HTTP server —— 收到 `GET http://127.0.0.1:<origin>/...`
 * 这种绝对形式请求行就转发给 origin。锁住三件事：
 * ① 开（显式地址）⇒ global fetch 真的过代理（origin 只被代理命中）；
 * ② 开（环境变量模式）⇒ `http_proxy` 生效；
 * ③ 关 ⇒ 恢复直连（代理不再收到请求）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import http from 'node:http';
import net from 'node:net';

import { applySystemProxy, systemProxyState, validateProxyUrl, __resetSystemProxyForTest } from '../net/system-proxy';

const listen = (s: Server): Promise<void> => new Promise((ok) => s.listen(0, '127.0.0.1', ok));
const portOf = (s: Server): number => (s.address() as { port: number }).port;

/**
 * 迷你转发代理。undici ProxyAgent 默认 `proxyTunnel: true` ⇒ **连 http 目标也走
 * CONNECT 隧道**（已查证 6.28.1 源码），所以桩必须处理 `connect` 事件：
 * 回 200 后把 socket 原样.pipe 到目标端口。
 */
function makeForwardProxy(): { server: Server; hits: () => number } {
  let hits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // absolute-form 分支（ProxyAgent `tunnelProxy:true` 时不走；留作防御）
    hits++;
    const target = req.url ?? '';
    if (!/^https?:\/\//.test(target)) {
      res.writeHead(400).end('proxy expects absolute-form url');
      return;
    }
    http
      .get(target, { headers: { host: new URL(target).host } }, (up) => {
        res.writeHead(up.statusCode ?? 502, { 'content-type': up.headers['content-type'] });
        up.pipe(res);
      })
      .on('error', () => res.writeHead(502).end('proxy upstream error'));
  });
  server.on('connect', (req, socket) => {
    hits++;
    const [host, port] = (req.url ?? '').split(':');
    const up = net.connect(Number(port) || 80, host ?? '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  return { server, hits: () => hits };
}

test('#386 语法预检：非法 URL / 非 http 协议 ⇒ 人话报错；空 = 环境变量模式合法', () => {
  assert.equal(validateProxyUrl('http://127.0.0.1:7890').ok, true);
  assert.equal(validateProxyUrl('').ok, true, '空 = 环境变量模式');
  assert.equal(validateProxyUrl('not a url').ok, false);
  assert.match(validateProxyUrl('socks5://127.0.0.1:1080').error ?? '', /http\/https/);
});

test('#386 apply(true, url)：global fetch 真过代理；apply(false) 恢复直连', async () => {
  __resetSystemProxyForTest();
  const origin = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('from-origin'));
  const { server: proxy, hits } = makeForwardProxy();
  await listen(origin);
  await listen(proxy);
  try {
    const originUrl = `http://127.0.0.1:${portOf(origin)}/x`;
    // 开：请求必须经代理（代理转发一次命中 origin）
    const on = applySystemProxy(true, `http://127.0.0.1:${portOf(proxy)}`);
    assert.equal(on.ok, true, on.error ?? 'apply 应成功');
    assert.equal(systemProxyState().enabled, true);
    const r = await fetch(originUrl);
    assert.equal(await r.text(), 'from-origin');
    assert.equal(hits(), 1, '请求应经过代理（absolute-form 转发）');
    // 关：恢复直连，代理不再收到请求
    const off = applySystemProxy(false);
    assert.equal(off.ok, true);
    assert.equal(systemProxyState().enabled, false);
    await fetch(originUrl);
    assert.equal(hits(), 1, '关闭后不应再经过代理');
  } finally {
    applySystemProxy(false);
    origin.close();
    proxy.close();
  }
});

test('#386 apply(true, 空地址)：吃 http_proxy 环境变量（EnvHttpProxyAgent）', async () => {
  __resetSystemProxyForTest();
  const origin = createServer((_req, res) => res.writeHead(200).end('via-env'));
  const { server: proxy, hits } = makeForwardProxy();
  await listen(origin);
  await listen(proxy);
  const prev = process.env.http_proxy;
  process.env.http_proxy = `http://127.0.0.1:${portOf(proxy)}`;
  try {
    const on = applySystemProxy(true, '');
    assert.equal(on.ok, true, on.error ?? 'env 模式 apply 应成功');
    const r = await fetch(`http://127.0.0.1:${portOf(origin)}/y`);
    assert.equal(await r.text(), 'via-env');
    assert.ok(hits() >= 1, 'env 代理应被命中');
  } finally {
    if (prev === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = prev;
    applySystemProxy(false);
    origin.close();
    proxy.close();
  }
});

test('#386 apply(true, 非法地址) ⇒ ok=false 且 dispatcher 不被破坏（直连仍可用）', async () => {
  __resetSystemProxyForTest();
  const origin = createServer((_req, res) => res.writeHead(200).end('direct-ok'));
  await listen(origin);
  try {
    const bad = applySystemProxy(true, 'socks5://127.0.0.1:1080');
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /http\/https/);
    assert.equal(systemProxyState().enabled, false, '失败不污染生效状态');
    const r = await fetch(`http://127.0.0.1:${portOf(origin)}/z`);
    assert.equal(await r.text(), 'direct-ok', '直连通路不受失败 apply 影响');
  } finally {
    origin.close();
  }
});
