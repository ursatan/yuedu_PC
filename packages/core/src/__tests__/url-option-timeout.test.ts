/**
 * URL 选项 `,{ "timeout": N }` 的透传回归（Legado `UrlOption` 语义）。
 *
 * 背景：`syncHttpSpec` 此前只把选项里的 `dnsIp` 转给 `syncHttp`，`timeout` 被静默丢弃
 * ⇒ 源写 `java.ajax(url + ',{"timeout":8000}')` 仍按默认 15s 走。
 *
 * 本文件用注入的 `syncFetch`（L1 同步传输桩）直接断言**传输层收到的 timeoutMs**：
 *  · 带 `timeout` 选项 ⇒ 用选项值；
 *  · 不带选项（或选项非法）⇒ 保持原有默认 15s（不可被「透传」改短）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsEvaluator } from '../selector/js';
import type { SyncHttpRequest, SyncHttpResponse } from '../selector/js';
import { createVariableStore } from '../store';

const DEFAULT_TIMEOUT_MS = 15_000;

function makeRecorder(): {
  ev: ReturnType<typeof createJsEvaluator>;
  seen: SyncHttpRequest[];
} {
  const seen: SyncHttpRequest[] = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    cookies: { get: () => '', set: () => undefined, header: () => '' },
    syncFetch: (req: SyncHttpRequest): SyncHttpResponse => {
      seen.push(req);
      return { status: 200, headers: {}, setCookie: [], body: 'ok' };
    },
  });
  return { ev, seen };
}

test('带 timeout 选项：java.ajax / java.post 都按选项值设置超时', async () => {
  const { ev, seen } = makeRecorder();
  await ev(`java.ajax(${JSON.stringify('https://a.test/x,{"timeout":8000}')})`, {});
  assert.equal(seen.at(-1)!.timeoutMs, 8_000);

  await ev(`java.post(${JSON.stringify('https://a.test/y,{"timeout":3000}')}, "a=1")`, {});
  const post = seen.at(-1)!;
  assert.equal(post.method, 'POST');
  assert.equal(post.timeoutMs, 3_000);
});

test('不带 timeout 选项：保持默认超时（不因透传被改短）', async () => {
  const { ev, seen } = makeRecorder();
  await ev(`java.ajax(${JSON.stringify('https://a.test/x')})`, {});
  assert.equal(seen.at(-1)!.timeoutMs, DEFAULT_TIMEOUT_MS);

  // 只有 headers 选项时同样走默认值
  await ev(`java.ajax(${JSON.stringify('https://a.test/x,{"headers":{"X-A":"1"}}')})`, {});
  assert.equal(seen.at(-1)!.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('timeout 选项非法（0 / 非数字）：回落到默认超时', async () => {
  const { ev, seen } = makeRecorder();
  await ev(`java.ajax(${JSON.stringify('https://a.test/x,{"timeout":0}')})`, {});
  assert.equal(seen.at(-1)!.timeoutMs, DEFAULT_TIMEOUT_MS);

  await ev(`java.ajax(${JSON.stringify('https://a.test/x,{"timeout":"abc"}')})`, {});
  assert.equal(seen.at(-1)!.timeoutMs, DEFAULT_TIMEOUT_MS);
});
