/**
 * `#747` 回归锁：`readStreamLimited` 的**响应体读取预算**（`deadlineMs` 第 4 参数）。
 *
 * 为什么有这条：`/api/proxy` 的 `timeout` 只覆盖到「响应头到手」，头一到 core 就返回、
 * 并发槽即释放；**慢镜像的响应体过去没有预算**（实测 `s3.go2778.com` 单图 43~60s）。
 * 挂住的体持续占用浏览器同源连接，把图片洪峰拉长成持续 CPU 压力，挤占目录解析。
 * 修法：图片调用方传 10s，到点 `cancel()` 流并抛 `BODY_DEADLINE`（快速失败）。
 *
 * 锁四件事：
 * 1. 不传 `deadlineMs` ⇒ 行为与从前逐字一致（含超限截断）；
 * 2. 体在预算内读完 ⇒ 正常返回，**不误判超时**；
 * 3. 体挂住超过预算 ⇒ 抛错误、`code === 'BODY_DEADLINE'`（不是无限等）；
 * 4. 慢但能读完（预算内）⇒ 正常返回。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { readStreamLimited } from '../index';

const chunk = (s: string) => new TextEncoder().encode(s);

/** 让一轮微任务/IO 走完（假时钟推进定时器后，用它让挂起的 `reader.read()` 落地） */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 立刻吐完所有块并关闭的流 */
function doneStream(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(chunk(p));
      controller.close();
    },
  });
}

/** 吐一块后**永不关闭**（模拟慢镜像把响应体挂住） */
function hangingStream(first: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk(first));
      // 故意不 close ⇒ 挂起的 read() 只能靠 cancel() 结束
    },
    cancel() {
      /* 允许取消 */
    },
  });
}

/** 每 `gapMs` 吐一块，最后关闭 */
function slowStream(parts: string[], gapMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0;
      const tick = () => {
        if (i >= parts.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunk(parts[i] as string));
        i++;
        setTimeout(tick, gapMs);
      };
      tick();
    },
  });
}

test('不传 deadlineMs：行为不变（完整读完 + 超限截断）', async () => {
  const full = await readStreamLimited(doneStream(['abc', 'def']), 1024, 'http://t/full');
  assert.equal(full.buf.length, 6);
  assert.equal(new TextDecoder().decode(full.buf), 'abcdef');
  assert.equal(full.truncated, false);

  // 10 字节 / 上限 4 ⇒ 截断到 4，仍是旧行为
  const cut = await readStreamLimited(doneStream(['0123456789']), 4, 'http://t/cut');
  assert.equal(cut.buf.length, 4);
  assert.equal(cut.truncated, true);
});

test('deadlineMs 内读完：正常返回，不误判超时', async () => {
  const got = await readStreamLimited(doneStream(['hello']), 1024, 'http://t/fast', 500);
  assert.equal(got.buf.length, 5);
  assert.equal(got.truncated, false);
});

test('响应体挂住超过预算：抛 BODY_DEADLINE（快速失败，不无限等）', async (t) => {
  // `#872`：用假时钟推进 deadline，消除时序敏感 —— 真实 30ms 定时器在满载机器上会被
  // 事件循环饿到几百毫秒（实测单跑本条 233ms），全量并发时还会因 unref 计时器 + 挂起
  // 的 read 无 ref 句柄而被父进程取消。显式 tick 后结果与机器负载无关。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = readStreamLimited(hangingStream('partial'), 1024, 'http://t/hang', 30);
  await flush(); // 首块读走，循环挂到第二次 read()
  t.mock.timers.tick(30); // deadline 到点：cancel() 结束挂起的 read
  await assert.rejects(pending, (e: Error & { code?: string }) => {
    assert.equal(e.code, 'BODY_DEADLINE');
    assert.match(e.message, /响应体读取超时/);
    assert.match(e.message, /30ms/);
    return true;
  });
});

test('慢但预算内读完：正常返回', async (t) => {
  // `#872`：同一条流也改假时钟推进 —— 真实 10ms×3 在满载下会漂到接近 1000ms 预算
  // （实测单跑 973ms），再并发就会误抛 BODY_DEADLINE。每次只推进 10ms（远小于预算）。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = readStreamLimited(slowStream(['a', 'b', 'c'], 10), 1024, 'http://t/slow', 1000).finally(() => {
    settled = true;
  });
  for (let i = 0; i < 10 && !settled; i++) {
    t.mock.timers.tick(10);
    await flush();
  }
  assert.ok(settled, '假时钟推进 100ms 内流应已读完（预算 1000ms）');
  const got = await pending;
  assert.equal(new TextDecoder().decode(got.buf), 'abc');
  assert.equal(got.truncated, false);
});
