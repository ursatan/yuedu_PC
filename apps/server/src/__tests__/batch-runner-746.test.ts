/**
 * `#746` B1 护栏锁：批处理子进程的**超时 / 崩溃重启 / 单写者回传**。
 *
 * 不起真 hub（那要 20s+），用一个 20 行的假子进程把三条护栏单独钉死：
 *  ① 正常任务能拿到结果；
 *  ② 任务超时 ⇒ 拒绝 + 杀进程 + **下一次任务自动重启**；
 *  ③ 子进程崩溃 ⇒ 在飞任务拒绝 + 下一次任务自动重启；
 *  ④ `kv-write` 只回到主进程回调（子进程不落盘 —— 回调即「主进程」）。
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
  if (mode === 'hang') return;
  if (mode === 'crash') process.exit(7);
  if (mode === 'kv') {
    process.send({ t: 'kv-write', key: 'k1', value: 'v1' });
    process.send({ t: 'result', id: m.id, ok: true, result: { echoed: 'kv' }, ms: 1 });
    return;
  }
  if (mode === 'fail') {
    process.send({ t: 'result', id: m.id, ok: false, error: 'boom', ms: 1 });
    return;
  }
  process.send({ t: 'result', id: m.id, ok: true, result: m.payload, ms: 1 });
});
process.on('disconnect', () => process.exit(0));
`;

function makeChild(): { entry: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-batch-746-'));
  const entry = path.join(dir, 'fake-child.mjs');
  fs.writeFileSync(entry, CHILD, 'utf8');
  return { entry, dir };
}

test('正常任务：结果原样回主进程', async () => {
  const { entry, dir } = makeChild();
  const runner = createBatchRunner({ entry, log: () => {} });
  try {
    const out = await runner.run('validate-all', { mode: 'echo', n: 42 });
    assert.deepEqual(out, { mode: 'echo', n: 42 });
    assert.equal(runner.status().jobs, 1);
    assert.equal(runner.status().spawns, 1);
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('子进程失败任务：ok=false 转成 reject（不吞错）', async () => {
  const { entry, dir } = makeChild();
  const runner = createBatchRunner({ entry, log: () => {} });
  try {
    await assert.rejects(() => runner.run('verify', { mode: 'fail' }), /boom/);
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单写者：kv-write 只回调主进程', async () => {
  const { entry, dir } = makeChild();
  const writes: Array<[string, string | null]> = [];
  const runner = createBatchRunner({ entry, log: () => {}, onKvWrite: (k, v) => writes.push([k, v]) });
  try {
    const out = await runner.run('patrol', { mode: 'kv' });
    assert.deepEqual(out, { echoed: 'kv' });
    assert.deepEqual(writes, [['k1', 'v1']]);
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('超时护栏：拒绝 + 杀进程 + 下次任务自动重启', async () => {
  const { entry, dir } = makeChild();
  const runner = createBatchRunner({ entry, log: () => {} });
  try {
    await assert.rejects(() => runner.run('verify', { mode: 'hang' }, 300), /超时/);
    assert.equal(runner.status().timeouts, 1);
    const out = await runner.run('validate-all', { mode: 'echo', ok: 1 });
    assert.deepEqual(out, { mode: 'echo', ok: 1 });
    assert.ok(runner.status().spawns >= 2, '超时后必须重启子进程');
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('崩溃护栏：在飞任务拒绝 + 下次任务自动重启', async () => {
  const { entry, dir } = makeChild();
  const runner = createBatchRunner({ entry, log: () => {} });
  try {
    await assert.rejects(() => runner.run('verify', { mode: 'crash' }), /退出/);
    assert.equal(runner.status().exits, 1);
    const out = await runner.run('patrol', { mode: 'echo', ok: 2 });
    assert.deepEqual(out, { mode: 'echo', ok: 2 });
    assert.ok(runner.status().spawns >= 2, '崩溃后必须重启子进程');
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
