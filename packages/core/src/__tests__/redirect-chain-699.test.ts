/**
 * `#699` 回归锁：**网络层自己跟重定向，并把每一跳的 3xx 码交上来**。
 *
 * ## 为什么改（不是「为了多打一行日志」）
 * `fetch(url, {redirect:'follow'})` 只把**最终**响应交回来：中间每一跳的状态码与
 * `Location` 全被 undici 吞掉。上游 Legado 走 okhttp，调试信息流里能看到
 * ```
 * [00:02.275] ≡检测到重定向(301)
 * [00:02.276] ┌重定向后地址
 * [00:02.277] └https://www.suduguu.com/wanjie/
 * ```
 * 我们此前只能打一句「请求地址 ≠ 落地地址，3xx 码底层 fetch 不透出」——排「站点换域名」
 * 这类问题时，看不到**跳了几次、每次什么码**（301 永久迁移 / 302 临时 / 307 保方法）。
 *
 * ## 判据（本文件锁死的 8 条）
 * 1. 单跳 301：`redirects` 一条，`status/location/target` 都是真的，`url` 是落地地址；
 * 2. 两跳：顺序即发生顺序；
 * 3. `redirect: 'manual'`：**一跳都不跟**（上游 `followRedirects(false)`），`redirects` 为空；
 * 4. 303 + POST ⇒ 变 GET 且**不带请求体**；
 * 5. 307 + POST ⇒ **保方法保体**；
 * 6. 301/302 + POST ⇒ 变 GET（浏览器/undici 的历史兼容行为）；
 * 7. 中间跳的 `Set-Cookie` 并进最终响应（否则上层 jar 收不到放行 cookie）；
 * 8. 同源后续跳带上中间跳种的 cookie；**跨源摘掉凭据头**（cookie / authorization）；
 * 9. 跳数超过 20 ⇒ `TOO_MANY_REDIRECTS`（与 undici 上限一致，不准悄悄放宽）。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test, { after, before } from 'node:test';

import { createHttpClient } from '../index';

let server: Server;
let base = '';
/** 第二个源（跨源用：端口不同 = 不同源） */
let serverB: Server;
let baseB = '';
/** 服务端收到的请求快照（方法 / 路径 / 关键头 / 体） */
const seen: Array<{ port: number; method: string; path: string; cookie?: string; auth?: string; body: string }> = [];

function snapshot(port: number, req: import('node:http').IncomingMessage, body: string) {
  seen.push({
    port,
    method: req.method ?? '',
    path: req.url ?? '',
    cookie: req.headers.cookie,
    auth: req.headers.authorization,
    body,
  });
}

before(async () => {
  serverB = createServer((req, res) => {
    snapshot(baseB ? Number(new URL(baseB).port) : 0, req, '');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('B-FINAL');
  });
  await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', () => r()));
  baseB = `http://127.0.0.1:${(serverB.address() as { port: number }).port}`;

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += String(d);
    });
    req.on('end', () => {
      const port = Number(new URL(base).port);
      snapshot(port, req, body);
      const url = req.url ?? '/';
      // 单跳
      if (url === '/one') {
        res.writeHead(301, { location: '/final' });
        res.end('MOVED');
        return;
      }
      // 两跳
      if (url === '/two') {
        res.writeHead(302, { location: '/one' });
        res.end('MOVED');
        return;
      }
      // 303 + POST ⇒ GET
      if (url === '/see-other') {
        res.writeHead(303, { location: '/final' });
        res.end('MOVED');
        return;
      }
      // 307 保方法保体
      if (url === '/temp') {
        res.writeHead(307, { location: '/final' });
        res.end('MOVED');
        return;
      }
      // 302 + POST ⇒ GET
      if (url === '/found-post') {
        res.writeHead(302, { location: '/final' });
        res.end('MOVED');
        return;
      }
      // 中间跳种 cookie，最终页不再下发
      if (url === '/gate') {
        res.writeHead(302, { location: '/final', 'set-cookie': 'gate=YES; Path=/' });
        res.end('MOVED');
        return;
      }
      // 同源跳：检查后续跳是否带上 gate
      if (url === '/hop-cookie') {
        res.writeHead(302, { location: '/cookie-echo', 'set-cookie': 'step=1; Path=/' });
        res.end('MOVED');
        return;
      }
      if (url === '/cookie-echo') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`cookie=${req.headers.cookie ?? ''}`);
        return;
      }
      // 跨源跳：把 cookie / authorization 递过去看有没有被摘掉
      if (url === '/cross') {
        res.writeHead(302, { location: `${baseB}/landing` });
        res.end('MOVED');
        return;
      }
      // 无限跳
      if (url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end('MOVED');
        return;
      }
      // 3xx 但没有 Location（站点拿 3xx 当错误信封）⇒ 必须原样交回，不能当重定向跟
      if (url === '/no-location') {
        res.writeHead(302);
        res.end('NO-LOCATION');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`FINAL:${req.method}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => serverB.close(() => r()));
});

test('#699 ① 单跳 301：交回真实状态码 / Location / 落地地址', async () => {
  const http = createHttpClient();
  const res = await http.request(`${base}/one`);
  assert.equal(res.status, 200);
  assert.match(String(res.body), /^FINAL:GET$/);
  assert.equal(res.url, `${base}/final`, '最终 URL 必须是一跳之后那个');
  assert.equal(res.redirects?.length, 1, `应记录 1 跳，实际：${JSON.stringify(res.redirects)}`);
  const hop = res.redirects![0]!;
  assert.equal(hop.status, 301, '状态码必须是真的 301（不再「不透出」）');
  assert.equal(hop.location, '/final', 'Location 原文（相对就是相对）');
  assert.equal(hop.url, `${base}/one`, '这一跳的请求地址');
  assert.equal(hop.target, `${base}/final`, '解析后的绝对目标');
});

test('#699 ② 两跳：顺序 = 发生顺序', async () => {
  const http = createHttpClient();
  const res = await http.request(`${base}/two`);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.redirects?.map((h) => `${h.status} ${new URL(h.url).pathname} -> ${new URL(h.target).pathname}`),
    ['302 /two -> /one', '301 /one -> /final'],
  );
});

test('#699 ③ redirect:manual ⇒ 一跳都不跟（java.get/post 的 followRedirects(false)）', async () => {
  const http = createHttpClient();
  const res = await http.request(`${base}/one`, { redirect: 'manual' });
  assert.equal(res.status, 301, 'manual 档必须停在 3xx');
  assert.equal(res.headers['location'], '/final');
  assert.equal(res.redirects?.length ?? 0, 0, 'manual 档不该有重定向链');
  assert.match(String(res.body), /^MOVED$/);
});

test('#699 ④ 303 + POST ⇒ 变 GET 且不带体', async () => {
  const http = createHttpClient();
  seen.length = 0;
  const res = await http.request(`${base}/see-other`, { method: 'POST', body: 'a=1' });
  assert.equal(res.status, 200);
  const last = seen[seen.length - 1]!;
  assert.equal(last.path, '/final');
  assert.equal(last.method, 'GET', '303 之后必须变 GET');
  assert.equal(last.body, '', '变 GET 之后不能再带请求体');
});

test('#699 ⑤ 307 + POST ⇒ 保方法保体', async () => {
  const http = createHttpClient();
  seen.length = 0;
  const res = await http.request(`${base}/temp`, { method: 'POST', body: 'a=1' });
  assert.equal(res.status, 200);
  const last = seen[seen.length - 1]!;
  assert.equal(last.method, 'POST', '307 的语义就是保方法');
  assert.equal(last.body, 'a=1', '307 必须带原请求体');
});

test('#699 ⑥ 302 + POST ⇒ 变 GET（浏览器/undici 的历史兼容行为）', async () => {
  const http = createHttpClient();
  seen.length = 0;
  const res = await http.request(`${base}/found-post`, { method: 'POST', body: 'a=1' });
  assert.equal(res.status, 200);
  const last = seen[seen.length - 1]!;
  assert.equal(last.method, 'GET');
  assert.equal(last.body, '');
});

test('#699 ⑦ 中间跳的 Set-Cookie 必须并进最终响应（否则上层 jar 收不到）', async () => {
  const http = createHttpClient();
  const res = await http.request(`${base}/gate`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['set-cookie'] ?? ''), /gate=YES/, '302 上种的 cookie 要留在响应头里');
});

test('#699 ⑧ 同源后续跳带上刚种的 cookie；跨源摘掉凭据头', async () => {
  const http = createHttpClient();
  const sameRes = await http.request(`${base}/hop-cookie`);
  assert.match(String(sameRes.body), /step=1/, '同源第二跳应带上第一跳种的 cookie');

  seen.length = 0;
  const crossRes = await http.request(`${base}/cross`, {
    headers: { Cookie: 'sid=secret', authorization: 'Bearer x' },
  });
  assert.equal(crossRes.status, 200);
  assert.equal(crossRes.url, `${baseB}/landing`);
  const land = seen.find((x) => x.path === '/landing');
  assert.ok(land, '跨源目标应收到请求');
  assert.equal(land!.cookie, undefined, '跨源不得把 cookie 递过去');
  assert.equal(land!.auth, undefined, '跨源不得把 authorization 递过去');
});

test('#699 ⑨ 3xx 但没有 Location ⇒ 当最终响应交回（不跟、不报错）', async () => {
  const http = createHttpClient();
  const res = await http.request(`${base}/no-location`);
  assert.equal(res.status, 302);
  assert.match(String(res.body), /^NO-LOCATION$/);
  assert.equal(res.redirects?.length ?? 0, 0);
});

test('#699 ⑩ 跳数超 20 ⇒ TOO_MANY_REDIRECTS（上限与 undici 一致）', async () => {
  const http = createHttpClient();
  await assert.rejects(
    () => http.request(`${base}/loop`),
    (e: unknown) => /TOO_MANY_REDIRECTS/.test(String((e as Error)?.message ?? e)),
  );
});
