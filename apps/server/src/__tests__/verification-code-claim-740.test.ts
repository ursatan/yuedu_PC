/**
 * `#740` **认领互斥**：Web 浮层与桌面端窗口不会同时打开同一个验证码请求。
 *
 * 只测纯逻辑（不拉真浏览器）：`__setVerifyCodeDeps` 把开 tab / 收割 Cookie 换成桩。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __resetVerifyCodeDeps,
  __setVerifyCodeDeps,
  cancelVerificationCode,
  claimVerificationCode,
  normalizeVerifyCodeConsumer,
  pendingVerificationCodes,
  requestVerificationCode,
  setVerificationCodeSink,
  submitVerificationCode,
} from '../verification-code';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fakeTab = () => ({
  capture: async () => ({ frame: 'data:image/jpeg;base64,AAAA', width: 0, height: 0 }),
  ua: async () => 'Mozilla/5.0 (Test)',
  reload: async () => undefined,
  close: async () => undefined,
});

async function waitPending(n = 1, ms = 2000): Promise<ReturnType<typeof pendingVerificationCodes>> {
  const t0 = Date.now();
  for (;;) {
    const p = pendingVerificationCodes();
    if (p.length === n) return p;
    if (Date.now() - t0 > ms) throw new Error(`等待 pending=${n} 超时（当前 ${p.length}）`);
    await sleep(10);
  }
}

test.beforeEach(() => {
  __resetVerifyCodeDeps();
  setVerificationCodeSink(() => undefined);
  __setVerifyCodeDeps({ startTab: async () => fakeTab(), harvest: async () => ({}) });
});

test('#740 consumer 归一：缺省/脏值按 desktop（老桌面端不带参数也不回退）', () => {
  assert.equal(normalizeVerifyCodeConsumer(undefined), 'desktop');
  assert.equal(normalizeVerifyCodeConsumer(''), 'desktop');
  assert.equal(normalizeVerifyCodeConsumer('WEB'), 'web');
  assert.equal(normalizeVerifyCodeConsumer('desktop'), 'desktop');
  assert.equal(normalizeVerifyCodeConsumer('xx'), 'desktop');
});

test('#740 认领互斥：先认领者独占，另一端 pending 不再下发、认领被拒', async () => {
  const p = requestVerificationCode('src-C', 'https://c.test/captcha.png');
  const meta = (await waitPending(1))[0]!;

  // 未认领：两端都能看到（老桌面端无 consumer 参数也照旧看到）
  assert.equal(pendingVerificationCodes().length, 1, '缺省 consumer（desktop）应看到未认领的');
  assert.equal(pendingVerificationCodes('web').length, 1);

  // Web 先认领
  assert.deepEqual(claimVerificationCode(meta.id, 'web'), { ok: true, claimedBy: 'web' });
  assert.equal(pendingVerificationCodes('web').length, 1, '认领方仍能看到（继续显示/刷新后恢复）');
  assert.equal(pendingVerificationCodes('desktop').length, 0, '另一端不得再看到 ⇒ 不会双开窗口');
  assert.equal(pendingVerificationCodes().length, 0, '缺省 consumer 同样被过滤');

  // 桌面端晚到 ⇒ 拒
  const denied = claimVerificationCode(meta.id, 'desktop');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'CLAIMED');
  assert.equal(denied.claimedBy, 'web');

  // 同端重复认领幂等（网页刷新后接着显示同一张）
  assert.deepEqual(claimVerificationCode(meta.id, 'web'), { ok: true, claimedBy: 'web' });

  // 收尾：提交后 entry 删除 ⇒ 认领释放
  assert.equal((await submitVerificationCode(meta.id, '1234')).ok, true);
  assert.equal(await p, '1234');
  assert.equal(pendingVerificationCodes('web').length, 0);
  assert.equal(claimVerificationCode(meta.id, 'desktop').error, 'NOT_PENDING', '提交后认领信息随 entry 释放');
});

test('#740 取消释放：桌面端认领后用户关窗 ⇒ 取消，下一次请求可被任意端认领', async () => {
  const p1 = requestVerificationCode('src-D', 'https://d.test/1.png');
  const m1 = (await waitPending(1))[0]!;
  assert.equal(claimVerificationCode(m1.id, 'desktop').ok, true);
  assert.equal(cancelVerificationCode(m1.id), true);
  await assert.rejects(p1, /验证码输入已取消/);
  assert.equal(pendingVerificationCodes('desktop').length, 0);

  const p2 = requestVerificationCode('src-D', 'https://d.test/2.png');
  const m2 = (await waitPending(1))[0]!;
  // 前一个的认领没有残留 ⇒ Web 端可以正常认领
  assert.deepEqual(claimVerificationCode(m2.id, 'web'), { ok: true, claimedBy: 'web' });
  assert.equal((await submitVerificationCode(m2.id, '5678')).ok, true);
  assert.equal(await p2, '5678');
});

test.after(() => {
  __resetVerifyCodeDeps();
  setVerificationCodeSink(() => undefined);
});
