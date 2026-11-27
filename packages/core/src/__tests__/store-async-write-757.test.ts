/**
 * `#757` E **写盘异步**的回归锁。
 *
 * 锁住四条纪律（都是本轮改动的判据，不是「跑得起来」）：
 *  ① **读取侧可见性**：`set` 后立刻 `get` 必须读到（内存为真源，落盘异步）；
 *  ② **合并/去抖**：同一窗口内连续写只落最后一次，且有 `coalesced` 计数；
 *  ③ **原子落盘**：临时文件 + rename，落盘后不留 `.tmp-*`，`.bak` 是上一版；
 *  ④ **退出 flush**：`flushSync()` 必须当场把最终态写进文件（不能等 300ms 防抖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileKeyValueStore } from '../store';

function tmpFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu-kv-757-'));
  return { dir, file: join(dir, 'kv.json') };
}

const diskJson = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;

test('读取以内存为准：set 后立刻 get 可见（此时磁盘还没写）', async () => {
  const { dir, file } = tmpFile();
  const store = createFileKeyValueStore(file, { debounceMs: 200 });
  try {
    await store.set('source-var:a', '即时可见');
    assert.equal(await store.get('source-var:a'), '即时可见');
    // 防抖窗口内文件尚未创建 ⇒ 证明读不是靠磁盘
    assert.deepEqual(store.stats().pending, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同键连续写只落最后一次 + 计数（queued ≤ 2，coalesced 远大于 1）', async () => {
  const { dir, file } = tmpFile();
  const store = createFileKeyValueStore(file, { debounceMs: 50 });
  try {
    for (let i = 0; i < 100; i += 1) await store.set('source-var:a', String(i));
    await store.flush();
    assert.equal(diskJson(file)['source-var:a'], '99');
    const st = store.stats();
    assert.equal(st.writes, 100);
    assert.equal(st.errors, 0);
    assert.ok(st.queued <= 2, `应合并成 1~2 次落盘，实际 ${st.queued}`);
    assert.ok(st.coalesced >= 90, `coalesced 应接近 99，实际 ${st.coalesced}`);
    assert.equal(st.writer, 'on', '默认应使用写线程（主线程只 postMessage）');
    assert.equal(st.inFlight, 0);
    assert.equal(st.pending, 0);
    assert.ok(st.lastBytes > 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('原子落盘：不留 .tmp-w/.tmp-m，第二次 flush 生成 .bak（上一版）', async () => {
  const { dir, file } = tmpFile();
  const store = createFileKeyValueStore(file, { debounceMs: 30 });
  try {
    await store.set('k', 'v1');
    await store.flush();
    const tmpLeft1 = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(tmpLeft1, [], '落盘后不应残留临时文件');
    assert.equal(diskJson(file).k, 'v1');

    await store.set('k', 'v2');
    await store.flush();
    assert.equal(diskJson(file).k, 'v2');
    assert.equal(diskJson(`${file}.bak`).k, 'v1', '.bak 必须是上一版');
    const tmpLeft2 = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(tmpLeft2, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flushSync（退出路径）：不等待防抖窗口，当场把最终态写进文件', async () => {
  const { dir, file } = tmpFile();
  const store = createFileKeyValueStore(file, { debounceMs: 5000 });
  try {
    await store.set('source-var:exit', '最终值');
    // 5s 防抖窗口内直接 flushSync ⇒ 必须已经落盘
    store.flushSync();
    assert.equal(diskJson(file)['source-var:exit'], '最终值');
    assert.equal(store.stats().pending, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('落盘失败不空转：flush 有界返回、dirty 立回、errors 计数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu-kv-757-'));
  // 让 store 的父目录实际是一个**文件** ⇒ mkdir/write 必失败
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x');
  const file = join(blocker, 'kv.json');
  const store = createFileKeyValueStore(file, { debounceMs: 20 });
  try {
    await store.set('k', 'v');
    const t0 = Date.now();
    await store.flush();
    assert.ok(Date.now() - t0 < 3000, '持续失败时 flush 必须尽快返回，不能无限等');
    const st = store.stats();
    assert.ok(st.errors > 0, '失败必须计数');
    assert.equal(st.pending, 1, '未落盘的数据必须保持 dirty（下次写还会重试）');
    assert.equal(await store.get('k'), 'v', '内存态不受落盘失败影响');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flush 后立刻新建实例能读到（重启可见性）', async () => {
  const { dir, file } = tmpFile();
  const store = createFileKeyValueStore(file, { debounceMs: 30 });
  await store.set('login-info:s1', '{"u":"p"}');
  await store.flush();
  store.close();
  const reopened = createFileKeyValueStore(file, { debounceMs: 30 });
  try {
    assert.equal(await reopened.get('login-info:s1'), '{"u":"p"}');
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
