/**
 * `#740` 纯 Web 端验证码浮层：认领互斥 / 提交成功 / 取消释放 / 超时文案 + 接线锁。
 *
 * 交互硬约束（项目记忆）：浮层**只能通过关闭按钮 / Esc 关闭，点外部不关闭**；
 * 关闭必须是 `DELETE`（脚本收到「验证码输入已取消」，不能静默悬挂）。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  claimVerifyCode,
  verifyCodeCancel,
  verifyCodeSubmit,
} from '../src/api';
import {
  pickClaimTarget,
  verifyCodeGoneText,
  verifyCodeSecondsLeft,
  verifyCodeStatusText,
  type VerifyCodeMeta,
} from '../src/utils/verify-code';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const meta = (patch: Partial<VerifyCodeMeta> = {}): VerifyCodeMeta => ({
  id: 'vc-1',
  sourceId: 'src-A',
  imageUrl: 'https://a.test/captcha.png',
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  state: 'waiting',
  ...patch,
});

/** 记录请求并返回给定 JSON/状态码 */
function stubJson(status: number, body: unknown): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

test('#740 认领互斥：桌面端已认领的请求不选；Web 端认领被 409 拒绝', async () => {
  const desktopOwned = meta({ id: 'vc-desktop', claimedBy: 'desktop' });
  assert.equal(pickClaimTarget([desktopOwned], '', 'web'), null, '另一端已认领 ⇒ 不弹窗');
  assert.equal(pickClaimTarget([meta({ id: 'vc-web', claimedBy: 'web' })], '', 'web')?.id, 'vc-web', '同端可继续显示（刷新幂等）');
  assert.equal(pickClaimTarget([meta()], 'vc-1', 'web'), null, '正在显示的同一个不再重复弹');

  const calls = stubJson(409, { ok: false, error: 'CLAIMED', claimedBy: 'desktop', message: '桌面端已打开该验证码窗口' });
  const r = await claimVerifyCode('vc-desktop', 'web');
  assert.equal(r.ok, false);
  assert.equal(r.claimedBy, 'desktop');
  assert.equal(calls[0]!.url, '/api/verify-code/vc-desktop/claim');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { consumer: 'web' });
});

test('#740 认领成功：20x 返回 ok 才弹窗（先到先得）', async () => {
  const calls = stubJson(200, { ok: true, claimedBy: 'web' });
  const r = await claimVerifyCode('vc-1', 'web');
  assert.deepEqual(r, { ok: true, claimedBy: 'web' });
  assert.equal(calls.length, 1);
});

test('#740 提交成功：POST 验证码；ok:true 才收起浮层', async () => {
  const calls = stubJson(200, { ok: true });
  const r = await verifyCodeSubmit('vc-1', ' AB12 ');
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0]!.url, '/api/verify-code/vc-1');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { code: ' AB12 ' });
});

test('#740 提交失败（已结束）是业务结果：ok:false + 服务端文案', async () => {
  stubJson(410, { ok: false, error: 'NOT_PENDING', message: '验证码请求已结束' });
  const r = await verifyCodeSubmit('vc-1', '1234');
  assert.equal(r.ok, false);
  assert.equal(r.message, '验证码请求已结束');
});

test('#740 取消释放：关闭浮层 = DELETE（脚本收到「已取消」）', async () => {
  const calls = stubJson(200, { ok: true, cancelled: true });
  await verifyCodeCancel('vc-1');
  assert.equal(calls[0]!.url, '/api/verify-code/vc-1');
  assert.equal(calls[0]!.init?.method, 'DELETE');
});

test('#740 超时 / 取消 / 浏览器不可用都有明确文案（不能只剩「加载中」）', () => {
  const expired = Date.now() - 1000;
  assert.match(verifyCodeStatusText({ state: 'timeout', expiresAt: expired }), /验证码超时/);
  assert.match(verifyCodeStatusText({ state: 'cancelled', expiresAt: expired }), /已取消/);
  assert.match(verifyCodeStatusText({ state: 'failed', expiresAt: expired }), /不可用/);
  assert.match(
    verifyCodeStatusText({ state: 'failed', expiresAt: expired, error: '未找到可用的完整浏览器' }),
    /未找到可用的完整浏览器/,
    '服务端 error 优先（脚本看到的是同一句原文）',
  );
  assert.match(verifyCodeGoneText(expired), /验证码超时/, 'entry 已被删且已到点 ⇒ 按超时说');
  assert.match(verifyCodeGoneText(Date.now() + 60_000), /已结束/, '未到点却 404 ⇒ 已提交/已取消');
  assert.equal(verifyCodeSecondsLeft(expired), 0);
  assert.ok(verifyCodeSecondsLeft(Date.now() + 30_000) > 20);
});

/* ── 接线锁（web 包没有 jsdom，按既有约定读源码断言） ── */
const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const OVERLAY = read('src/components/VerifyCodeOverlay.vue');
const APP = read('src/App.vue');

test('#740 浮层只能「关闭按钮 / Esc」关闭，点外部不关闭', () => {
  assert.doesNotMatch(OVERLAY, /@click\.self/, '遮罩不得点击关闭（项目硬约束）');
  assert.match(OVERLAY, /pushEscLayer\(/, '必须入 Esc 栈');
  assert.match(OVERLAY, /data-vc-close/, '必须有关闭按钮');
  assert.match(OVERLAY, /verifyCodeCancel\(/, '关闭必须 DELETE（释放认领 + 取消语义）');
  assert.match(OVERLAY, /status/, '必须有状态文案');
});

test('#740 App 只用 consumer=web 认领，且桌面端不重复轮询', () => {
  assert.match(APP, /verifyCodePending\('web'\)/, 'Web 端带 consumer=web');
  assert.match(APP, /claimVerifyCode\(target\.id, 'web'\)/, '先认领再弹窗');
  assert.match(APP, /pickClaimTarget\(/, '认领目标走纯判据');
  assert.match(APP, /isDesktop\(\)/, '桌面端由主进程开窗 ⇒ Web 不再轮询');
  assert.match(APP, /1500/, '1.5s 级轮询');
});

test('#740 与 CF 挑战浮层是两条独立通道（不复用、不互相改坏）', () => {
  const cf = read('src/components/VerificationOverlay.vue');
  assert.match(cf, /verificationStream\(/, 'CF 通道仍走 SSE');
  assert.doesNotMatch(OVERLAY, /verificationStream\(/, '验证码浮层不得复用 CF 通道');
  assert.match(APP, /<VerificationOverlay/);
  assert.match(APP, /<VerifyCodeOverlay/);
});
