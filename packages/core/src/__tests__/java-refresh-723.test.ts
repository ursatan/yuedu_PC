/**
 * `#723` 第 4 批 JS 面回归锁（`js.refreshBook*` / `getSource` / `getTag` / `canOpenSourceUi` / `getVerificationCode`）。
 *
 * 上游依据（`f:\legado\app\src\main\java\io\legado\app\help\JsExtensions.kt`）：
 *  · `:127-128` `getSource(): BaseSource?` / `getTag(): String?`（`BookSource.getTag()` = `bookSourceName`）
 *  · `:157-167` `refreshBookInfo/Toc/Content` 只是 `EventBus.post(REFRESH_*, true)`，返回 Unit、不抛
 *  · `:442-449` `getVerificationCode` 弹框**阻塞等人输入**（无交互通道时必须明确失败）
 *  · `:1299` `canOpenSourceUi` 是 **private** ⇒ 本仓作为可注入能力暴露（缺省 false）
 *
 * 两条路径（L1 / worker）同判据：本锁同时覆盖 `createJsEvaluator` 与 `createHybridJsEvaluator`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { needBrowserFromError } from '../login-flow';
import { SOURCE_FIELDS_KEY } from '../selector/types';

type Ev = (code: string, bindings?: Record<string, unknown>) => unknown;

const KINDS: Array<'info' | 'toc' | 'content'> = ['info', 'toc', 'content'];

test('#723 L1：refreshBookInfo/Toc/Content 不抛、回调收到对应事件、返回空串', () => {
  const seen: Array<'info' | 'toc' | 'content'> = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    onRefreshBook: (k) => seen.push(k),
  }) as Ev;
  for (const [i, kind] of KINDS.entries()) {
    const fn = ['refreshBookInfo', 'refreshBookToc', 'refreshContent'][i] as string;
    assert.equal(ev(`java.${fn}()`, {}), '');
    assert.equal(seen.at(-1), kind, `${fn} 应发 ${kind} 事件`);
  }
  assert.deepEqual(seen, KINDS);
});

test('#723 L1：getSource 返回注入的源桩、getTag 返回源名；未注入时 getSource 仍可用（不 TypeError）', () => {
  const stub = { getKey: () => 'https://x.test', bookSourceName: '测试源' };
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    getSource: () => stub,
    getTag: () => '测试源',
  }) as Ev;
  assert.equal(ev('java.getTag()', {}), '测试源');
  assert.equal(ev('java.getSource().getKey()', {}), 'https://x.test');
  // 缺省：无源兜底桩（可调用、值为空）
  const bare = createJsEvaluator({ variables: createVariableStore() }) as Ev;
  assert.equal(bare('String(java.getSource().getKey())', {}), '');
  assert.equal(bare('String(java.getTag())', {}), '');
});

test('#723 L1：canOpenSourceUi 缺省 false，注入 true 后为真', () => {
  const bare = createJsEvaluator({ variables: createVariableStore() }) as Ev;
  assert.equal(bare('java.canOpenSourceUi()', {}), false);
  const on = createJsEvaluator({
    variables: createVariableStore(),
    canOpenSourceUi: () => true,
  }) as Ev;
  assert.equal(on('java.canOpenSourceUi()', {}), true);
});

test('#723 L1：getVerificationCode 无注入时明确抛错；注入同步钩子时返回用户输入的 code', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() }) as Ev;
  assert.throws(
    () => ev('java.getVerificationCode("https://x.test/captcha.png")', {}),
    /需要浏览器交互/,
  );
  // 登录流程的定性判据：L1 无法等人工输入 ⇒ 仍应判为「需浏览器」
  assert.equal(
    needBrowserFromError('java.getVerificationCode 需要浏览器交互（L1 同步求值通道无法等待人工输入；该脚本应交给 worker 池执行）'),
    true,
  );

  // `#727` 注入同步钩子（宿主自备弹窗/测试）⇒ 原样返回 code，并把 URL 传过去
  let seenUrl = '';
  const withHook = createJsEvaluator({
    variables: createVariableStore(),
    verificationCode: (u) => {
      seenUrl = u;
      return 'AB12';
    },
  }) as Ev;
  assert.equal(withHook('java.getVerificationCode("https://x.test/captcha.png")', {}), 'AB12');
  assert.equal(seenUrl, 'https://x.test/captcha.png');

  // `#727` 超时/取消不算「需要浏览器」（浏览器已经拉起过，再开登录窗只会白等）
  assert.equal(needBrowserFromError('java.getVerificationCode 验证码超时（60s 未收到输入）'), false);
  assert.equal(needBrowserFromError('java.getVerificationCode 验证码输入已取消（用户关闭了验证码窗口）'), false);
});

test('#723 worker：refreshBook* 不抛；canOpenSourceUi 回宿主；getTag 取源字段；getVerificationCode 走宿主通道', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const seen: Array<'info' | 'toc' | 'content'> = [];
  let seenUrl = '';
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    onRefreshBook: (k) => seen.push(k),
    canOpenSourceUi: () => true,
    // `#727` worker 的人工输入通道：同步 RPC 会等这个异步结果
    verificationCodeAsync: async (u) => {
      seenUrl = u;
      return 'W9X8';
    },
  }) as (code: string, bindings?: Record<string, unknown>) => Promise<unknown>;
  const bindings = { [SOURCE_FIELDS_KEY]: { bookSourceName: '测试源', bookSourceUrl: 'https://x.test' } };

  assert.equal(await ev('java.refreshBookInfo()', bindings), '');
  assert.equal(await ev('java.refreshBookToc()', bindings), '');
  assert.equal(await ev('java.refreshContent()', bindings), '');
  // 刷新事件是 rpcNoWait（fire-and-forget）；给宿主一个 tick 收尾再断言
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen.sort(), ['content', 'info', 'toc']);

  assert.equal(await ev('java.canOpenSourceUi()', bindings), true);
  assert.equal(await ev('String(java.getTag())', bindings), '测试源');
  // `#727` 注入通道 ⇒ 返回用户输入的验证码（不是抛「需浏览器」）
  assert.equal(await ev('java.getVerificationCode("https://x.test/captcha.png")', bindings), 'W9X8');
  assert.equal(seenUrl, 'https://x.test/captcha.png');

  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

test('#727 worker：未注入通道时 getVerificationCode 明确失败（不会静默返回空串）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
  }) as (code: string, bindings?: Record<string, unknown>) => Promise<unknown>;
  await assert.rejects(
    () => ev('java.getVerificationCode("https://x.test/captcha.png")', {}),
    /需要浏览器交互|未提供验证码输入通道/,
  );
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
