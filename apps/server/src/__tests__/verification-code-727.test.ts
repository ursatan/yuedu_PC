/**
 * `#727` `java.getVerificationCode` 的人工输入通道（超时 / 取消 / 成功回填 Cookie / 并发不串号）。
 *
 * 不拉真浏览器：`__setVerifyCodeDeps` 把「开 tab / 收割 Cookie」换成桩（生产默认实现见
 * `verification-code.ts` 的 `defaultStartTab` / `defaultHarvest`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __resetVerifyCodeDeps,
  __setVerifyCodeDeps,
  cancelVerificationCode,
  pendingVerificationCodes,
  requestVerificationCode,
  setVerificationCodeSink,
  submitVerificationCode,
} from '../verification-code';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 每条用例都从生产默认值开始：`__setVerifyCodeDeps` 是**合并**语义，
 * 上一条用例注入的 80ms 超时会漏到下一条（曾让「同源串行」贴近 80ms 抖红）。
 */
test.beforeEach(() => {
  __resetVerifyCodeDeps();
  setVerificationCodeSink(() => undefined);
});

function fakeTab(): { capture: () => Promise<{ frame: string; width: number; height: number }>; ua: () => Promise<string>; reload: () => Promise<void>; close: () => Promise<void> } {
  return {
    capture: async () => ({ frame: 'data:image/jpeg;base64,AAAA', width: 0, height: 0 }),
    ua: async () => 'Mozilla/5.0 (Test)',
    reload: async () => undefined,
    close: async () => undefined,
  };
}

/** 等到出现 1 个等待中的请求（`requestVerificationCode` 是异步登记的） */
async function waitPending(n = 1, ms = 2000): Promise<ReturnType<typeof pendingVerificationCodes>> {
  const t0 = Date.now();
  for (;;) {
    const p = pendingVerificationCodes();
    if (p.length === n) return p;
    if (Date.now() - t0 > ms) throw new Error(`等待 pending=${n} 超时（当前 ${p.length}）`);
    await sleep(10);
  }
}

test('#727 成功：返回用户输入的验证码，并把 Cookie/UA 交给 sink', async () => {
  const harvested: Array<{ sourceId: string; urls: string[] }> = [];
  const sunk: Array<{ sourceId: string; map: Record<string, string>; ua?: string }> = [];
  __setVerifyCodeDeps({
    startTab: async () => fakeTab(),
    harvest: async (sourceId, urls) => {
      harvested.push({ sourceId, urls });
      return { sid: `S-${sourceId}` };
    },
  });
  setVerificationCodeSink((sourceId, map, ua) => sunk.push({ sourceId, map, ua }));

  const p = requestVerificationCode('src-A', 'https://a.test/captcha.png');
  const meta = (await waitPending(1))[0]!;
  assert.equal(meta.sourceId, 'src-A');
  assert.equal(meta.imageUrl, 'https://a.test/captcha.png');

  const r = await submitVerificationCode(meta.id, ' AB12 ');
  assert.equal(r.ok, true);
  assert.equal(await p, 'AB12');
  assert.equal(harvested.length, 1);
  assert.equal(harvested[0]!.sourceId, 'src-A');
  assert.deepEqual(sunk, [{ sourceId: 'src-A', map: { sid: 'S-src-A' }, ua: 'Mozilla/5.0 (Test)' }]);
  assert.equal(pendingVerificationCodes().length, 0);
});

test('#727 超时：60s（此处注入 80ms）内没输入 ⇒ reject「验证码超时」且不再 pending', async () => {
  __setVerifyCodeDeps({
    startTab: async () => fakeTab(),
    harvest: async () => ({}),
    timeoutMs: 80,
  });
  const p = requestVerificationCode('src-T', 'https://t.test/captcha.png');
  await assert.rejects(p, /验证码超时/);
  assert.equal(pendingVerificationCodes().length, 0);

  // 超时后用户再提交也是 NOT_PENDING（worker 那边早收到了 reject，不会重复消费）
  const late = await submitVerificationCode('nope', '1234');
  assert.equal(late.ok, false);
  assert.equal(late.error, 'NOT_PENDING');
});

test('#727 取消：用户关窗 ⇒ reject「验证码输入已取消」', async () => {
  __setVerifyCodeDeps({ startTab: async () => fakeTab(), harvest: async () => ({}) });
  const p = requestVerificationCode('src-C', 'https://c.test/captcha.png');
  const meta = (await waitPending(1))[0]!;
  assert.equal(cancelVerificationCode(meta.id), true);
  await assert.rejects(p, /验证码输入已取消/);
  assert.equal(pendingVerificationCodes().length, 0);
});

test('#727 并发两源：各自返回自己的验证码，Cookie 也各回各家（不串号）', async () => {
  const harvested: string[] = [];
  const sunk: Array<{ sourceId: string; map: Record<string, string> }> = [];
  __setVerifyCodeDeps({
    startTab: async (sourceId) => {
      await sleep(sourceId === 'src-B' ? 30 : 5); // B 慢一点：故意让启动顺序与提交顺序不一致
      return fakeTab();
    },
    harvest: async (sourceId) => {
      harvested.push(sourceId);
      return { [`sid_${sourceId}`]: sourceId };
    },
  });
  setVerificationCodeSink((sourceId, map) => sunk.push({ sourceId, map }));

  const pa = requestVerificationCode('src-A', 'https://a.test/captcha.png');
  const pb = requestVerificationCode('src-B', 'https://b.test/captcha.png');
  const pend = await waitPending(2);
  const a = pend.find((x) => x.sourceId === 'src-A')!;
  const b = pend.find((x) => x.sourceId === 'src-B')!;
  assert.notEqual(a.id, b.id);

  // 先提交 B 再提交 A（两个请求互不阻塞）
  assert.equal((await submitVerificationCode(b.id, 'B-CODE')).ok, true);
  assert.equal((await submitVerificationCode(a.id, 'A-CODE')).ok, true);
  assert.equal(await pa, 'A-CODE');
  assert.equal(await pb, 'B-CODE');

  const bySource = new Map(sunk.map((s) => [s.sourceId, s.map]));
  assert.deepEqual(bySource.get('src-A'), { 'sid_src-A': 'src-A' });
  assert.deepEqual(bySource.get('src-B'), { 'sid_src-B': 'src-B' });
  assert.deepEqual(harvested.sort(), ['src-A', 'src-B']);
  assert.equal(pendingVerificationCodes().length, 0);
});

test('#727 同源串行：第二个请求排队，直到第一个结束（不会两个抢同一只浏览器）', async () => {
  __setVerifyCodeDeps({ startTab: async () => fakeTab(), harvest: async () => ({}) });
  const p1 = requestVerificationCode('src-S', 'https://s.test/1.png');
  const m1 = (await waitPending(1))[0]!;
  const p2 = requestVerificationCode('src-S', 'https://s.test/2.png');
  await sleep(50);
  // 第二个还没登记（同源串行）⇒ pending 仍只有 1 个
  assert.equal(pendingVerificationCodes().length, 1);
  assert.equal((await submitVerificationCode(m1.id, 'ONE')).ok, true);
  assert.equal(await p1, 'ONE');
  const m2 = (await waitPending(1))[0]!;
  assert.equal(m2.imageUrl, 'https://s.test/2.png');
  assert.equal((await submitVerificationCode(m2.id, 'TWO')).ok, true);
  assert.equal(await p2, 'TWO');
  assert.equal(pendingVerificationCodes().length, 0);
});

test.after(() => {
  __resetVerifyCodeDeps();
  setVerificationCodeSink(() => undefined);
});
