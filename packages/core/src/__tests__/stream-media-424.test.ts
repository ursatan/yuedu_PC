/**
 * `#424` 音视频**流式**通路（边下边播）。
 *
 * ## 缺陷形态（用户实测，逆次元_动漫）
 * 「页面内自己就能播、嗅探反而不能」。真因：嗅探地址走 `/api/proxy`，而该路由是
 * 「一次性 arraybuffer 全量」+ 体积护栏（`YUEDU_NET_MAX_BODY_MB`×4 = **32MB**）
 * ⇒ 大 mp4 被**静默截断**（cmd: `[net-guard] 响应体超过上限 32MB，已截断`）⇒ 播不了。
 *
 * ## 修法
 * `HttpRequestOptions.responseType = 'stream'`：**不缓冲**（在 `readBodyLimited` **之前**返回
 * undici 的 web ReadableStream），由 server 直接管道给客户端；`body` 给空 ArrayBuffer 占位
 * 以保持既有类型不变。
 *
 * ## 本锁
 * 自起一个 40MB 的上游（支持 Range），断言：
 *  ① `stream` 模式能拿到**全部** 40MB（远大于 32MB 护栏）；
 *  ② `arraybuffer` 模式在同样数据上**确实会截断**（对照 —— 证明本锁不是空转）；
 *  ③ 206 的 `content-range` 原样透出（拖动/续取要靠它）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpClient } from '../net';

const SIZE = 40 * 1024 * 1024;

function startUpstream(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range)) ?? [];
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : SIZE - 1;
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${SIZE}`,
          'content-length': String(end - start + 1),
          'accept-ranges': 'bytes',
        });
        res.end(Buffer.alloc(end - start + 1, 0x41));
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(SIZE), 'accept-ranges': 'bytes' });
      res.end(Buffer.alloc(SIZE, 0x41));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/big.mp4`, close: () => srv.close() });
    });
  });
}

test('#424 stream：媒体不缓冲、不受 32MB 护栏限制（边下边播的根因）', async () => {
  const up = await startUpstream();
  try {
    const http = createHttpClient();
    const r = await http.request(up.url, { responseType: 'stream' });
    assert.equal(r.status, 200);
    assert.ok(r.stream, 'stream 模式必须给出可读流');
    let n = 0;
    const reader = (r.stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value?.length ?? 0;
    }
    assert.equal(n, SIZE, `必须完整拿到 ${SIZE} 字节（旧 arraybuffer 通路 32MB 就截断）`);
  } finally {
    up.close();
  }
});

test('#424【对照】arraybuffer 通路在同样数据上确实会截断（本锁不是空转）', async () => {
  const up = await startUpstream();
  try {
    const http = createHttpClient();
    const r = await http.request(up.url, { responseType: 'arraybuffer' });
    const len = (r.body as ArrayBuffer).byteLength;
    assert.equal(r.truncated, true, '大媒体走缓冲通路必然被护栏截断');
    assert.ok(len < SIZE && len > 0, `截断后仍是部分字节：${len}`);
  } finally {
    up.close();
  }
});

test('#424 stream：206 区段的 content-range 原样透出（拖动/续取靠它）', async () => {
  const up = await startUpstream();
  try {
    const http = createHttpClient();
    const r = await http.request(up.url, { responseType: 'stream', headers: { Range: 'bytes=1000000-1999999' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes 1000000-1999999/${SIZE}`);
    let n = 0;
    const reader = (r.stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value?.length ?? 0;
    }
    assert.equal(n, 1_000_000);
  } finally {
    up.close();
  }
});