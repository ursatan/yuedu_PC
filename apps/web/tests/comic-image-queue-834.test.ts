/**
 * `#834` 漫画图片队列回归锁。
 *
 * 为什么值得单测（而不是只在浏览器里看）：
 *  · **并发上限**错了 ⇒ 一话几十张图同时发，浏览器同源 6 连接被占满，正文接口一起卡；
 *  · **去重**错了 ⇒ 快速来回滚动会把同一张图重复打进代理，服务端 per-host=2 更堵；
 *  · **退避重试**错了 ⇒ 坏图会立刻连打 3 次，把本来只是慢的图打成限流。
 * 这些在页面上只表现为「图慢慢出来」，肉眼很难判断对错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ComicImageQueue, type ComicImgDim, type ComicLoadHandle } from '../src/utils/comic-image-queue';

interface FakeCall {
  url: string;
  resolve: (d: ComicImgDim) => void;
  reject: (e: Error) => void;
  aborted: boolean;
}

/** 可编程的假加载器：每次调用都挂起，由测试决定成功/失败 */
function fakeLoad(): { calls: FakeCall[]; load: (url: string) => ComicLoadHandle } {
  const calls: FakeCall[] = [];
  const load = (url: string): ComicLoadHandle => {
    let resolveFn: (d: ComicImgDim) => void = () => {};
    let rejectFn: (e: Error) => void = () => {};
    const promise = new Promise<ComicImgDim>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const call: FakeCall = { url, resolve: resolveFn, reject: rejectFn, aborted: false };
    calls.push(call);
    return {
      promise,
      abort: () => { call.aborted = true; call.reject(new Error('abort')); },
    };
  };
  return { calls, load };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('#834 在飞 ≤ 3：5 个请求只启动 3 张，完成一张才补位', async () => {
  const { calls, load } = fakeLoad();
  const q = new ComicImageQueue({ maxInflight: 3, load, retryDelaysMs: [0, 0], timeoutMs: 10 });
  for (let i = 0; i < 5; i += 1) q.request(String(i), ['u' + i]);

  assert.equal(calls.length, 3, '前 3 张应在飞');
  assert.equal(q.inflightCount(), 3);

  calls[0]!.resolve({ w: 10, h: 20 });
  await flush();
  assert.equal(calls.length, 4, '空出一个槽位后第 4 张才启动');
  assert.equal(q.statusOf('0'), 'ok');
  assert.deepEqual(q.dimOf('0'), { w: 10, h: 20 });
  assert.equal(q.urlOf('0'), 'u0');
});

test('#834 同一张重复请求不重复下载（排队/在飞/已完成都不再发）', async () => {
  const { calls, load } = fakeLoad();
  const q = new ComicImageQueue({ maxInflight: 3, load, retryDelaysMs: [0], timeoutMs: 10 });
  q.request('a', ['u']);
  q.request('a', ['u']);
  q.request('a', ['u']);
  assert.equal(calls.length, 1);

  calls[0]!.resolve({ w: 1, h: 1 });
  await flush();
  q.request('a', ['u']);
  assert.equal(calls.length, 1, '已完成的不应重新请求');
});

test('#834 失败按退避换候选地址（代理 → 直连），成功后落 ok', async () => {
  const { calls, load } = fakeLoad();
  const q = new ComicImageQueue({ maxInflight: 1, load, retryDelaysMs: [10, 20], timeoutMs: 10 });
  q.request('a', ['proxy', 'direct']);
  assert.equal(calls[0]!.url, 'proxy');

  calls[0]!.reject(new Error('timeout'));
  await sleep(25);
  assert.equal(calls.length, 2, '退避后应换直连再试');
  assert.equal(calls[1]!.url, 'direct');

  calls[1]!.resolve({ w: 700, h: 1200 });
  await flush();
  assert.equal(q.statusOf('a'), 'ok');
  assert.deepEqual(q.dimOf('a'), { w: 700, h: 1200 });
  assert.equal(q.urlOf('a'), 'direct');
});

test('#834 候选全失败 ⇒ err；手动 retry 从第一个候选重来', async () => {
  const { calls, load } = fakeLoad();
  const q = new ComicImageQueue({ maxInflight: 1, load, retryDelaysMs: [0, 0], timeoutMs: 10 });
  q.request('a', ['p', 'd']);
  calls[0]!.reject(new Error('1'));
  await flush();
  calls[1]!.reject(new Error('2'));
  await flush();
  assert.equal(q.statusOf('a'), 'err');

  q.retry('a', ['p2', 'd2']);
  assert.equal(q.statusOf('a'), 'loading');
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.url, 'p2');
});

test('#834 reset 会 abort 在飞请求，迟到的成功不写回状态', async () => {
  const { calls, load } = fakeLoad();
  const q = new ComicImageQueue({ maxInflight: 2, load, retryDelaysMs: [0], timeoutMs: 10 });
  q.request('a', ['u']);
  assert.equal(q.statusOf('a'), 'loading');
  q.reset();
  assert.equal(calls[0]!.aborted, true, '在飞请求应被 abort');
  calls[0]!.resolve({ w: 1, h: 1 });
  await flush();
  assert.equal(q.statusOf('a'), 'idle', '换章后迟到的成功不得复活旧状态');
});

test('#834 状态变更按 key 回报，供组件写回响应式表', async () => {
  const { calls, load } = fakeLoad();
  const seen: string[] = [];
  const q = new ComicImageQueue({
    maxInflight: 1, load, retryDelaysMs: [0], timeoutMs: 10,
    onUpdate: (u) => seen.push(`${u.key}:${u.status}`),
  });
  q.request('7', ['u']);
  calls[0]!.resolve({ w: 3, h: 4 });
  await flush();
  assert.deepEqual(seen, ['7:queued', '7:loading', '7:ok']);
});
