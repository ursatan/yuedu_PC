/**
 * `#753` B2 护栏锁：**版本闸 / 重载通知 / Cookie 写回**。
 *
 * 与 `batch-runner-746.test.ts` 同一套「假子进程」手法（不起真 hub），只钉 B2 新增的三条：
 *  ① 结果版本 ≠ 当前版本 ⇒ 直接丢弃（旧快照结果不能覆盖新状态）；
 *  ② `notifySourcesChanged` 递增版本并给子进程推 `reload`；
 *  ③ `cookie-write` 只回调主进程（单写者）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBatchRunner } from '../batch-runner';

const CHILD = `
process.on('message', (m) => {
  if (!m || m.t !== 'job') return;
  const mode = m.payload && m.payload.mode;
  if (mode === 'cookie') {
    process.send({ t: 'cookie-write', sourceId: 's1', cookies: { a: '1' } });
    process.send({ t: 'result', id: m.id, ok: true, result: { ok: 1 }, ms: 1, version: m.version });
    return;
  }
  if (mode === 'stale') {
    // 故意回一个旧版本，模拟「任务跑到一半源库被改了」
    setTimeout(() => process.send({
      t: 'result', id: m.id, ok: true, result: { old: 1 }, ms: 1, version: m.version - 1,
    }), 50);
    return;
  }
  process.send({ t: 'result', id: m.id, ok: true, result: { v: m.version }, ms: 1, version: m.version });
});
process.on('disconnect', () => process.exit(0));
`;

function makeChild(): { entry: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-batch-753-'));
  const entry = path.join(dir, 'fake-child.mjs');
  fs.writeFileSync(entry, CHILD, 'utf8');
  return { entry, dir };
}

test('B2 版本闸：结果版本不一致直接丢弃（stale +1）', async () => {
  const { entry, dir } = makeChild();
  const runner = createBatchRunner({ entry, log: () => {} });
  try {
    await assert.rejects(() => runner.run('patrol', { mode: 'stale' }), /过期/);
    assert.equal(runner.status().stale, 1, '陈旧结果必须记一次 stale');
    // 下一次任务带当前版本 → 正常
    const out = await runner.run('patrol', { mode: 'echo' });
    assert.deepEqual(out, { v: runner.currentVersion() });
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B2 源变更：版本号递增，下一次任务带新版本', async () => {
  const { entry, dir } = makeChild();
  const runner = createBatchRunner({ entry, log: () => {} });
  try {
    const before = runner.currentVersion();
    const after = runner.notifySourcesChanged('测试变更');
    assert.equal(after, before + 1);
    const out = await runner.run('patrol', { mode: 'echo' });
    assert.deepEqual(out, { v: after });
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B2 单写者：cookie-write 只回调主进程', async () => {
  const { entry, dir } = makeChild();
  const writes: Array<[string, Record<string, string> | null]> = [];
  const runner = createBatchRunner({
    entry,
    log: () => {},
    onCookieWrite: (id, cookies) => writes.push([id, cookies]),
  });
  try {
    const out = await runner.run('login', { mode: 'cookie' });
    assert.deepEqual(out, { ok: 1 });
    assert.deepEqual(writes, [['s1', { a: '1' }]]);
    // `#765` 实测补的观测字段：子进程每发一次 cookie-write 计数 +1（第二个任务不发就不涨）
    assert.equal(runner.status().cookieWrites, 1, '一次 cookie-write ⇒ cookieWrites=1');
    await runner.run('login', { mode: 'echo' });
    assert.equal(runner.status().cookieWrites, 1, '无 cookie-write ⇒ 计数不变');
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
