/**
 * 二进制内容缓存（blob）回归测试（Phase 1.2）
 *
 * 重点验证四件事：
 * 1. **路径安全**：key 任意（含 `../`、`/`、中文）都不能写到 `blobs/` 之外 —— 落盘名走 sha256。
 * 2. **索引自愈**：索引说有、磁盘没有（被外部清理/同步工具删了）→ 读返回 null 并修掉索引。
 * 3. **LRU 摸盘**：`get()` 刷新 mtime，容量淘汰时保留"最近用过"的。
 * 4. **索引持久化**：重开后仍能列出/命中。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBlobStore } from '../user-store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuedu-blob-'));
}
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 忽略 */
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** 与实现同款落盘路径计算（用于断言分片目录与"没写到外面"） */
function fileFor(dir: string, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return join(dir, 'blobs', hash.slice(0, 2), hash);
}

test('blob：文本与二进制的存取往返', () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    assert.equal(blob.dir, join(dir, 'blobs'));

    blob.put('txt', '第一话正文');
    assert.equal(blob.getText('txt'), '第一话正文');
    assert.deepEqual([...blob.get('txt')!], [...Buffer.from('第一话正文', 'utf-8')]);

    const bin = new Uint8Array([0, 1, 2, 255, 254]);
    blob.put('bin', bin);
    assert.deepEqual([...blob.get('bin')!], [0, 1, 2, 255, 254]);

    assert.equal(blob.get('missing'), null);
    assert.equal(blob.getText('missing'), null);
    assert.equal(blob.has('txt'), true);
    assert.equal(blob.has('missing'), false);
  } finally {
    cleanup(dir);
  }
});

test('blob：stat/list/totalSize/delete', () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('a:1', 'aaa', 'text/plain');
    blob.put('a:2', 'bbbb');
    blob.put('b:1', 'ccccc');

    const st = blob.stat('a:1')!;
    assert.equal(st.size, 3, 'size 应来自磁盘');
    assert.equal(st.type, 'text/plain');
    assert.equal(blob.stat('a:1')!.type, 'text/plain');
    assert.equal(blob.stat('missing'), null);

    assert.equal(blob.totalSize(), 3 + 4 + 5);
    assert.equal(Object.keys(blob.list()).length, 3);
    assert.deepEqual(Object.keys(blob.list('a:')).sort(), ['a:1', 'a:2']);
    assert.deepEqual(Object.keys(blob.list('b:')), ['b:1']);

    assert.equal(blob.delete('a:1'), true);
    assert.equal(blob.delete('a:1'), false, '重复删应返回 false');
    assert.equal(blob.has('a:1'), false);
    assert.equal(blob.totalSize(), 4 + 5);
  } finally {
    cleanup(dir);
  }
});

test('blob：覆盖写同一 key 不会残留旧内容', () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('k', 'short');
    blob.put('k', 'much-longer-content');
    assert.equal(blob.getText('k'), 'much-longer-content');
    assert.equal(blob.stat('k')!.size, Buffer.byteLength('much-longer-content'));
    assert.equal(Object.keys(blob.list()).length, 1, '同一 key 只应有一条索引');
    // 分片目录里也只应有一个文件
    const shard = readdirSync(join(dir, 'blobs'));
    const files = shard.flatMap((sub) => readdirSync(join(dir, 'blobs', sub)));
    assert.equal(files.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('blob：key 任意字符都不越界（落盘名走 sha256 分片）', () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    const nasty = ['../evil', '../../etc/passwd', 'a/b', 'a\\b', '中文/路径', '..', 'C:\\Windows\\x', ''];
    for (const k of nasty) blob.put(k, 'x');

    for (const k of nasty) {
      const f = fileFor(dir, k);
      assert.ok(existsSync(f), `key=${JSON.stringify(k)} 应落在 blobs/ 分片目录内`);
      assert.ok(f.startsWith(join(dir, 'blobs')), `key=${JSON.stringify(k)} 的落盘路径必须在 blobs/ 内`);
      assert.equal(blob.getText(k), 'x', `key=${JSON.stringify(k)} 应能读回`);
    }
    // 上级目录不应被写入任何东西
    assert.equal(existsSync(join(dir, '..', 'evil')), false, '不得写出 blobs/ 之外');
    // 分片目录名必须是 2 位十六进制
    for (const sub of readdirSync(join(dir, 'blobs'))) {
      assert.match(sub, /^[0-9a-f]{2}$/);
    }
  } finally {
    cleanup(dir);
  }
});

test('blob：索引自愈 —— 文件被外部删除后读返回 null 并修索引', () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('gone', 'x');
    assert.equal(blob.has('gone'), true);
    rmSync(fileFor(dir, 'gone'), { force: true });

    assert.equal(blob.has('gone'), false, 'has 要同时看索引与磁盘');
    assert.equal(blob.get('gone'), null, '文件不在应返回 null');
    assert.equal(blob.list()['gone'], undefined, '读失败应顺手把索引项删掉');
  } finally {
    cleanup(dir);
  }
});

test('blob：索引持久化（重开后仍可列出与命中）', () => {
  const dir = tempDir();
  try {
    const first = createBlobStore(dir);
    first.put('persist', 'hello');
    first.close(); // 强制 flush 索引

    const second = createBlobStore(dir);
    assert.equal(second.has('persist'), true, '重开后索引应还在');
    assert.equal(second.getText('persist'), 'hello');
    assert.equal(Object.keys(second.list()).length, 1);
    second.close();
  } finally {
    cleanup(dir);
  }
});

test('blob：sweep 按最久未访问淘汰（LRU），且 get 会刷新访问时间', async () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('A', 'aaa'); // 3 字节
    await sleep(15);
    blob.put('B', 'bbbb'); // 4 字节
    await sleep(15);
    blob.put('C', 'ccccc'); // 5 字节
    await sleep(15);
    // 访问 A → A 变成"最近使用"，B 成为最旧
    assert.equal(blob.getText('A'), 'aaa');

    const res = blob.sweep({ maxBytes: 6 });
    assert.equal(blob.has('A'), true, '最近访问过的 A 应保留');
    assert.equal(blob.has('B'), false, '最旧的 B 应被淘汰');
    assert.equal(blob.has('C'), false, 'C 也被淘汰（容量仍不够）');
    assert.equal(blob.totalSize(), 3, '剩余应只有 A');
    assert.equal(res.removed, 2);
    assert.equal(res.freedBytes, 4 + 5);
  } finally {
    cleanup(dir);
  }
});

test('blob：sweep 按年龄清理，未超龄的不动', async () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('old', 'x');
    await sleep(40);
    blob.put('fresh', 'y');

    const res = blob.sweep({ maxAgeMs: 20 });
    assert.equal(blob.has('old'), false, '超过 maxAgeMs 应被清掉');
    assert.equal(blob.has('fresh'), true, '新写入的不应被清');
    assert.equal(res.removed, 1);
  } finally {
    cleanup(dir);
  }
});

test('blob：sweep 空策略不做任何删除', () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('k', 'v');
    const res = blob.sweep({});
    assert.deepEqual(res, { removed: 0, freedBytes: 0 });
    assert.equal(blob.has('k'), true);
  } finally {
    cleanup(dir);
  }
});

test('blob：mtime 可观测（stat 返回磁盘大小）', async () => {
  const dir = tempDir();
  try {
    const blob = createBlobStore(dir);
    blob.put('k', 'abc');
    const t1 = blob.stat('k')!.mtime;
    await sleep(10);
    assert.equal(blob.getText('k'), 'abc');
    const t2 = blob.stat('k')!.mtime;
    assert.ok(t2 > t1, 'get 之后 mtime 应被刷新（LRU 依据）');
    // 磁盘上的真实大小与索引一致
    assert.equal(statSync(fileFor(dir, 'k')).size, blob.stat('k')!.size);
  } finally {
    cleanup(dir);
  }
});
