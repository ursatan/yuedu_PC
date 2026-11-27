/**
 * `B7` 回归锁：请求体判据只能是「GET / HEAD 丢弃」，**不是**「只有 POST 保留」。
 *
 * ## 缺陷（`B7` 端到端探针发现）
 * `#644` 为防止 `Request with GET/HEAD method cannot have body`，曾写成
 * `method === 'POST' ? body : undefined`。但 WebDAV 的备份上传走 **PUT + zip 二进制体**
 * （`WebDavClient.upload`）⇒ 请求体被静默丢掉，远端存下 **0 字节 zip**，
 * 恢复时必然报「不是一份有效的备份 zip」。
 *
 * 判据只该拒绝 fetch 规范不允许带体的 GET/HEAD；PUT/PATCH/DELETE 的原样发出。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createHttpClient } from '../net';

test('B7：PUT 必须带请求体；GET 仍不带体（真实 HTTP 栈，非 POST 不能被丢弃）', async () => {
  const got: Array<{ method?: string; body: Buffer }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ method: req.method, body: Buffer.concat(chunks) });
      res.writeHead(201, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const client = createHttpClient();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await client.request(`http://127.0.0.1:${port}/upload`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: bytes,
    });
    assert.equal(got.length, 1);
    assert.equal(got[0]!.method, 'PUT');
    assert.deepEqual([...got[0]!.body], [1, 2, 3, 4, 5], '★ PUT 的字节体必须真的发出去');

    // 对照：POST 照常带体（证明上面不是「碰巧收到空」）
    await client.request(`http://127.0.0.1:${port}/post`, { method: 'POST', body: 'a=1' });
    assert.equal(got[1]!.body.toString(), 'a=1');

    // 对照：GET 仍不带体（`#644` 的原判据继续保持）
    await client.request(`http://127.0.0.1:${port}/get`, { method: 'GET' });
    assert.equal(got[2]!.body.length, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
