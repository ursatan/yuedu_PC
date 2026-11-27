/**
 * `#476` TTY 日志卸载层回归锁（node:test 风格，与 stall-watch.test.ts 一致）。
 * 集成行为（worker 真往控制台写）会污染测试输出，这里锁三件事：
 *  1. 装/不装的判据（非 TTY 必须零行为变化 —— electron/管道场景）；
 *  2. 装上后 process.stdout/stderr.write 走卸载层且内容落文件、回调仍被异步调用；
 *  3. 幂等：重复安装不叠加 shim。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installOffloadedLogSink, shouldInstallLogSink } from '../log-sink';

test('log-sink 闸门：非 TTY 不装 / 开关关断不装 / TTY 装', () => {
  assert.equal(shouldInstallLogSink({}, false, false), false);
  assert.equal(shouldInstallLogSink({ YUEDU_LOG_SINK: '0' }, true, true), false);
  assert.equal(shouldInstallLogSink({}, true, false), true);
  assert.equal(shouldInstallLogSink({}, false, true), true);
});

test('installOffloadedLogSink：内容落文件、回调异步、重复安装幂等', async (t) => {
  const savedOutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const savedErrTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');

  // 强制 TTY 判定（gate 只看这两个布尔）
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  const file = join(tmpdir(), `yuedu-log-sink-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);

  const sink = installOffloadedLogSink({ file });
  assert.ok(sink, 'TTY 下必须装上');
  assert.equal(installOffloadedLogSink({ file }), sink, '二次安装必须幂等返回同一实例');
  t.after(async () => {
    // dispose 还原 write + 关流（WriteStream 不关会让测试进程退不出）
    await sink!.dispose();
    if (savedOutTty) Object.defineProperty(process.stdout, 'isTTY', savedOutTty);
    if (savedErrTty) Object.defineProperty(process.stderr, 'isTTY', savedErrTty);
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  });

  const marker = `MARKER-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let called = false;
  process.stdout.write(`${marker}\n`, () => { called = true; });
  assert.equal(called, false, 'write 回调不能同步触发（必须异步）');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, true, 'write 回调必须被调用');

  // worker ACK 往返后 pending 应回落到接近 0
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(sink!.stats().pending < 4096, `待写应收空，实际 pending=${sink!.stats().pending}`);

  // 文件侧必须有完整内容（QuickEdit 暂停也不丢的那半边）
  const txt = readFileSync(file, 'utf8');
  assert.ok(txt.includes(marker), '全量日志必须落 server.log');
});
