/**
 * `#607`：jsLib **落盘**（对齐上游 `SharedJsScope` 的 ACache）。
 *
 * ## 锁什么
 * 上游把下载到的 jsLib 写进 ACache（`aCache.put(fileName, js)`）⇒ 一个源**只慢一次**。
 * 本仓此前只有进程内 `Map` ⇒ 每次重启都要重下；而慢站（qyyuapi 实测 `curl (28) after 60011ms
 * with 508 bytes received`）单个库就能吃满行动预算，后续规则报 `Reload is not defined`，
 * 看起来像「jsLib 时序不对」。
 *
 * 三条判据：
 *  ① 磁盘命中 ⇒ **不发网络请求**（第二次开源必须秒开）；
 *  ② 网络成功 ⇒ 写磁盘（键 = `jslib:<md5(url)>`，与上游 ACache 文件名同算法）；
 *  ③ 网络失败 ⇒ 记负缓存 + 留痕，且**不写磁盘**（不能把「一次失败」固化成「永久空」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { primeJsLibCached, jsLibFailuresOf } from './engine';
import type { EngineContext } from '@yuedu/core';

const md5 = (s: string): string => createHash('md5').update(s, 'utf-8').digest('hex');

function makeCtx(opts: {
  sourceId: string;
  storage: Map<string, string>;
  onRequest: (url: string) => { status: number; body: string };
  requestCount: { n: number };
}): EngineContext {
  return {
    reqId: `req-${opts.sourceId}`,
    sourceId: opts.sourceId,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    http: {
      request: async (url: string) => {
        opts.requestCount.n += 1;
        const r = opts.onRequest(String(url));
        return { status: r.status, headers: {}, body: r.body };
      },
    },
    sandbox: {} as never,
    trace: { push() {}, tail: () => [] } as never,
    variables: { get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] } as never,
    storage: {
      get: async (k: string) => opts.storage.get(k) ?? null,
      set: async (k: string, v: string) => {
        opts.storage.set(k, v);
      },
      delete: async (k: string) => {
        opts.storage.delete(k);
      },
    } as never,
  } as unknown as EngineContext;
}

test('首次：走网络并写磁盘（键 jslib:<md5(url)>，与上游 ACache 同算法）', async () => {
  const storage = new Map<string, string>();
  const requestCount = { n: 0 };
  const url = 'https://js.test/first.js';
  const ctx = makeCtx({
    sourceId: 'src-first',
    storage,
    requestCount,
    onRequest: () => ({ status: 200, body: 'function A(){return 1}' }),
  });
  await primeJsLibCached(ctx, JSON.stringify({ lib: url }));
  assert.equal(requestCount.n, 1, '首次必须真的下载');
  assert.equal(storage.get(`jslib:${md5(url)}`), 'function A(){return 1}', '必须落盘');
  assert.deepEqual(jsLibFailuresOf('src-first'), [], '成功时不该有失败记录');
});

test('磁盘命中：不发网络请求（慢站第二次必须秒开）', async () => {
  const storage = new Map<string, string>();
  const requestCount = { n: 0 };
  /* 用一个**没在内存里**的 URL，才能证明「是磁盘救的」，而不是进程内 Map 命中 */
  const url = 'https://js.test/from-disk.js';
  storage.set(`jslib:${md5(url)}`, 'function B(){return 2}');
  const ctx = makeCtx({
    sourceId: 'src-disk',
    storage,
    requestCount,
    onRequest: () => ({ status: 200, body: 'should-not-be-called' }),
  });
  await primeJsLibCached(ctx, JSON.stringify({ lib: url }));
  assert.equal(requestCount.n, 0, '磁盘命中不得再发请求');
});

test('网络失败：不写磁盘（不能把一次失败固化成永久空）+ 记失败清单', async () => {
  const storage = new Map<string, string>();
  const requestCount = { n: 0 };
  const url = 'https://js.test/down.js';
  const ctx = makeCtx({
    sourceId: 'src-fail',
    storage,
    requestCount,
    onRequest: () => ({ status: 502, body: '' }),
  });
  await primeJsLibCached(ctx, JSON.stringify({ lib: url }));
  assert.equal(requestCount.n, 1);
  assert.equal(storage.has(`jslib:${md5(url)}`), false, '失败不得写缓存');
  assert.deepEqual(jsLibFailuresOf('src-fail'), [url], '失败清单供错误 hint 使用');
});

test('映射表形态：多个 value 各自下载（上游 values.forEach 同语义）', async () => {
  const storage = new Map<string, string>();
  const requestCount = { n: 0 };
  const a = 'https://js.test/a.js';
  const b = 'https://js.test/b.js';
  const ctx = makeCtx({
    sourceId: 'src-map',
    storage,
    requestCount,
    onRequest: (u) => ({ status: 200, body: `/*${u}*/` }),
  });
  await primeJsLibCached(ctx, JSON.stringify({ A: a, B: b }));
  assert.equal(requestCount.n, 2, '两个库各下一次');
  assert.equal(storage.get(`jslib:${md5(a)}`), `/*${a}*/`);
  assert.equal(storage.get(`jslib:${md5(b)}`), `/*${b}*/`);
});

test('内联 JS（非 URL）不触发下载', async () => {
  const storage = new Map<string, string>();
  const requestCount = { n: 0 };
  const ctx = makeCtx({
    sourceId: 'src-inline',
    storage,
    requestCount,
    onRequest: () => ({ status: 200, body: 'x' }),
  });
  await primeJsLibCached(ctx, 'function inline(){return 1}');
  assert.equal(requestCount.n, 0);
});
