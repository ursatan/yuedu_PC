/**
 * `java.toast` / `java.longToast` 的**全链路接管**回归锁。
 *
 * ## 为什么必须有这组测试
 * 旧实现有两处**静默丢弃**，用户侧表现为「点了没反应」：
 *  ① worker 沙箱里 `toast/longToast` 是 `() => undefined`（而绝大多数源走 worker）；
 *  ② 引擎只在登录流程传了 `toastSink`，搜索/详情/目录/正文四个阶段的 toast 全部丢失。
 * 语料里大量源的反馈**只有 toast**（动作不改任何字段）⇒ 丢了就等于功能不可用。
 *
 * ## 断言的是「宿主收到了什么」
 * 两条路径（L1 进程内 / worker 池）都必须回调到宿主的 `onToast`，且顺序与 long 标记正确。
 * worker 用例额外断言 `java.ajax` 走了**注入的宿主 HTTP**（证明路由确实进了 worker，
 * 否则这条测试可能退化成在测 L1 —— L1 的 `java.ajax` 用 `execFileSync`，不会调注入的 http）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

interface Seen {
  msg: string;
  long: boolean;
}

test('L1 路径：java.toast / java.longToast 回调宿主', () => {
  const seen: Seen[] = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    onToast: (msg, long) => {
      seen.push({ msg, long });
    },
  });
  const out = String(ev('java.toast("短提示"); java.longToast("未登录，请先登录"); 1;', {}));
  assert.equal(out, '1');
  assert.deepEqual(
    seen,
    [
      { msg: '短提示', long: false },
      { msg: '未登录，请先登录', long: true },
    ],
    '两条 toast 都必须按序回调，且 long 标记正确',
  );
});

test('worker 路径：java.toast 经同步 RPC 回宿主（不再静默丢弃）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const seen: Seen[] = [];
  const httpCalls: string[] = [];
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    onToast: (msg, long) => {
      seen.push({ msg, long });
    },
    http: async (r) => {
      httpCalls.push(r.url);
      return { status: 200, headers: {}, body: '{}' };
    },
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  // 含 java.ajax ⇒ 必须走 worker（HTTP_API_RE 判定）；toast 紧随其后，覆盖「rpc 在飞之后仍要送达」
  const code = [
    'java.ajax("https://api.test/toast-rpc");',
    'java.toast("worker 短提示");',
    'java.longToast("worker 长提示");',
    '1;',
  ].join('\n');

  const out = String(await Promise.resolve(ev(code, {})));
  assert.equal(out, '1');
  assert.equal(httpCalls.length, 1, 'java.ajax 必须走注入的宿主 HTTP ⇒ 证明脚本确实在 worker 里跑');
  assert.deepEqual(
    seen,
    [
      { msg: 'worker 短提示', long: false },
      { msg: 'worker 长提示', long: true },
    ],
    'worker 的 toast 必须经 RPC 回到宿主（旧实现是 () => undefined）',
  );
});

test('空文本 / null 不得产生 toast（源脚本常 toast 变量，可能是空）', () => {
  const seen: Seen[] = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    onToast: (msg, long) => {
      seen.push({ msg, long });
    },
  });
  String(ev('java.toast(""); java.toast(null); java.longToast(undefined); 1;', {}));
  assert.deepEqual(seen, [], '空/未定义文本应被过滤，避免弹出空气泡');
});

/* ---------------------- `java.upLoginData`（同一类宿主回调桥） ----------------------
 * 上游 `SourceLoginJsExtensions.kt:35-37` → 对话框 `handleUpUiData`：脚本要求**实时更新登录界面
 * 字段值**（只改 UI、不落库）。此前 core **整条 API 未实现**（Proxy 兜底 `() => ''`）⇒ 静默空转。
 * 用户 2026-10-15 实测 18AV「🌐获取网址」：`java.upLoginData({'网址': surl})` 之后 toast 说
 * 「已填写最新网址」而输入框仍空 —— 就是这条断了。
 */
test('L1 路径：java.upLoginData 回调宿主（拿到脚本给的那份 map）', () => {
  const seen: unknown[] = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    onUpLoginData: (d) => {
      seen.push(d);
    },
  });
  const out = String(ev('let i={}; i["网址"]="https://new.site/"; java.upLoginData(i); 1;', {}));
  assert.equal(out, '1');
  assert.deepEqual(seen, [{ 网址: 'https://new.site/' }], '脚本给的 map 必须原样到宿主');
});

test('worker 路径：java.upLoginData 经同步 RPC 回宿主', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const seen: unknown[] = [];
  const httpCalls: string[] = [];
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    onUpLoginData: (d) => {
      seen.push(d);
    },
    http: async (r) => {
      httpCalls.push(r.url);
      return { status: 200, headers: {}, body: '{}' };
    },
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const code = ['java.ajax("https://api.test/up-login-rpc");', 'java.upLoginData({ 网址: "https://w.site/" });', '1;'].join('\n');
  const out = String(await Promise.resolve(ev(code, {})));
  assert.equal(out, '1');
  assert.equal(httpCalls.length, 1, 'java.ajax 走注入的宿主 HTTP ⇒ 证明脚本确实在 worker 里跑');
  assert.deepEqual(seen, [{ 网址: 'https://w.site/' }], 'worker 的 upLoginData 必须经 RPC 回宿主');
});

/* ---------------------- `java.head/get/...` 的坏地址闸门 ----------------------
 * 上游 `Jsoup.connect(urlStr)`（`JsExtensions.kt:526-620`）对空串/相对地址/未知 scheme 一律抛
 * `IllegalArgumentException`，源作者靠它做**兜底分支**（18AV `fabuye()`：head 抛了才写默认域名）。
 * 我们此前静默返回假响应 ⇒ catch 永不触发（用户实测「点击未打开页面」）。
 */
test('坏地址必须抛（上游 Jsoup.connect 语义）：空串 / 相对路径 / data:', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  for (const bad of ['', 'undefined', '/relative/path', 'data:text/html,<p>x</p>']) {
    assert.throws(
      () => ev(`java.head(${JSON.stringify(bad)}, {}, 1000)`, {}),
      /Malformed URL/,
      `java.head(${JSON.stringify(bad)}) 必须抛（源脚本的 catch 兜底依赖它）`,
    );
    assert.throws(
      () => ev(`java.get(${JSON.stringify(bad)}, {})`, {}),
      /Malformed URL/,
      `java.get(${JSON.stringify(bad)}) 必须抛`,
    );
  }
});
