/**
 * 回归锁：`java.startBrowser` 的**fire-and-forget**语义 + worker 硬超时只算**纯计算**。
 *
 * 两处真因（均从 Legado 源码核对 + 557 源基线实测确认）：
 *
 * ① `startBrowser` 被实现成了「等一次渲染」
 *    Legado `JsExtensions.kt:352-359 startBrowser` → `SourceVerificationHelp.kt:348-373`
 *    → `appCtx.startActivity<WebViewActivity>{…}`：**发射即返回（Unit），不等待页面**。
 *    等结果的是另一个 API（`startBrowserAwait`，同文件 :364-391，返回 StrResponse）。
 *    我们的旧实现让 startBrowser 去 await 渲染 → 源只想「开个浏览器」，却付了整轮渲染的代价；
 *    在 worker 里那次 RPC 是 **Atomics.wait 同步阻塞**，把 10s JS 预算吃光 → `JS_TIMEOUT`
 *    （实测：麻豆传媒AI 正文规则 `@js: … java.startBrowser(url,'') …`，单并发可稳定复现）。
 *
 * ② 硬超时把「宿主 RPC 等待」也算成了 CPU 时间
 *    Legado 在 Rhino 里跑脚本**没有 CPU 上限**，`java.ajax` 慢是正常的（语料里
 *    `startBrowserAwait` 66 次 / 18 源）。我们的 10s 上限存在的唯一目的是打断死循环，
 *    而死循环永远不会发起 RPC（worker 单线程同步执行）→ RPC 在飞时应当暂停计时。
 *    否则「站点慢」会被误报成 `JS_TIMEOUT`（实测：武芊漫画（优+）详情）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

type Ev = (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

function makeEv(opts: {
  /** `#393` 第二参 = **打开目的**（`show` 展示型 / `cookie` 要浏览器里的结果） */
  onBrowserOpen?: (u: string, kind?: string) => void;
  renderer?: (u: string) => Promise<string>;
  http?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
}) {
  const pool = createWorkerSandboxPool({
    size: 1,
    ...(opts.timeoutMs ? { defaultTimeoutMs: opts.timeoutMs } : {}),
  });
  let renderCalls = 0;
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    ...(opts.onBrowserOpen ? { onBrowserOpen: opts.onBrowserOpen } : {}),
    ...(opts.renderer
      ? {
          renderer: (url: string) => {
            renderCalls++;
            return opts.renderer!(url);
          },
        }
      : {}),
    http: async (r: { url: string }) =>
      ((await opts.http?.(r.url)) ?? { status: 200, headers: {}, body: '' }) as never,
  }) as Ev;
  return { ev, pool, renderCalls: () => renderCalls };
}

test('① java.startBrowser 必须**立即返回**，不得等待渲染（Legado startActivity 语义）', async () => {
  const opened: Array<[string, string | undefined]> = [];
  const { ev, renderCalls } = makeEv({
    onBrowserOpen: (u, kind) => opened.push([u, kind]),
    // 故意给一个「很慢」的渲染器：旧实现会 await 它，从而吞掉 JS 预算
    renderer: () => new Promise((r) => setTimeout(() => r('<html>rendered</html>'), 2_000)),
  });

  const t0 = Date.now();
  const out = await Promise.resolve(
    ev("java.startBrowser('https://b.test/page', '验证'); 'done'", {}),
  );
  const ms = Date.now() - t0;

  assert.equal(String(out), 'done', '脚本必须继续执行完（返回值不是渲染结果）');
  assert.deepEqual(
    opened,
    [['https://b.test/page', 'show']],
    `必须登记「要打开浏览器」及其**目的**（#393）：${JSON.stringify(opened)}`,
  );
  assert.equal(renderCalls(), 0, 'startBrowser 不得触发渲染（那是 startBrowserAwait 的语义）');
  assert.ok(ms < 1_000, `必须立即返回，实际 ${ms}ms`);
});

test('①b java.startBrowserAwait 仍必须**等待并返回 StrResponse**（两种语义不能混）', async () => {
  const opened: Array<[string, string | undefined]> = [];
  const { ev, renderCalls } = makeEv({
    onBrowserOpen: (u, kind) => opened.push([u, kind]),
    renderer: async () => '<html><body><p id="x">甲</p></body></html>',
  });

  // 语料实锤：startBrowserAwait 的返回值一律用 `.body()` 访问（11/11 处，如晋江文学/书山聚合）
  const out = await Promise.resolve(
    ev("var r = java.startBrowserAwait('https://b.test/await', '标题'); r.body().includes('甲') && String(r).includes('甲') ? 'ok' : 'miss'", {}),
  );
  assert.equal(String(out), 'ok', '等待语义必须拿到渲染结果（StrResponse.body() 且 String(r) 同值）');
  assert.equal(renderCalls(), 1, 'startBrowserAwait 必须真的渲染一次');
  assert.deepEqual(
    opened,
    [['https://b.test/await', 'cookie']],
    '等待路径同样要登记浏览器 URL，且**目的必须是 cookie**（#393）—— 前端据此才开真浏览器',
  );
});

/**
 * `#393` 的**关键落点**在 worker 通道：`java.*` 的 kind 从 worker `rpc(...)` 一路传到
 * 宿主的 `onBrowserOpen`。而 `startBrowser`（`rpcNoWait('browser')`）与
 * `startBrowserAwait`/`webView`（`rpc('render')`）走的是**两条不同的 RPC 通道**
 * ⇒ 任一条漏传 kind，前端就会选错浏览器（这类「改一处不生效」本仓踩过多次）。
 */
test('①c java.webView 属渲染类 ⇒ 目的必须是 cookie（worker 两条 RPC 通道都要带 kind，#393）', async () => {
  const opened: Array<[string, string | undefined]> = [];
  const { ev } = makeEv({
    onBrowserOpen: (u, kind) => opened.push([u, kind]),
    renderer: async () => '<html><body>甲</body></html>',
  });
  await Promise.resolve(ev("java.webView('https://b.test/v')", {}));
  assert.deepEqual(
    opened,
    [['https://b.test/v', 'cookie']],
    `webView 是渲染类（源常靠它带登录态取页）⇒ cookie：${JSON.stringify(opened)}`,
  );
});

test('② 宿主 RPC 的等待时间不计入 JS 硬超时（慢 java.ajax 不得报 JS_TIMEOUT）', async () => {
  const { ev } = makeEv({
    timeoutMs: 400, // 纯计算预算 400ms
    http: async () => {
      await new Promise((r) => setTimeout(r, 900)); // 慢于预算的「站点」
      return { status: 200, headers: {}, body: 'SLOW_OK' };
    },
  });

  const out = await Promise.resolve(ev("java.ajax('https://slow.test/x')", {}));
  assert.equal(String(out), 'SLOW_OK', '慢请求必须正常返回，而不是被硬超时打断');
});

test('②b 死循环仍必须被硬超时打断（暂停计时不能把兜底也一起关掉）', async () => {
  const { ev } = makeEv({ timeoutMs: 400 });
  const err = await Promise.resolve(ev('while(true){}', {}))
    .then(() => undefined)
    .catch((e: unknown) => e as { message?: string });
  assert.ok(err, '死循环必须被硬中断（否则 worker 永久占住）');
  assert.match(String(err.message), /JS_TIMEOUT|timeout|timed out/i, `应报超时：${String(err.message)}`);
});
