/**
 * 回归锁：`java.connect()` 的 **StrResponse 面** + `java.md5Encode16`（`#361`）。
 *
 * ## 起因（真源真按钮）
 * qyyuapi 系（剧迷 / Movieffm / 西瓜卡通 / 袋鼠影视 / 爱动漫网）点登录页按钮报
 * 「登录脚本执行失败」。真语料 A/B（jsLib 注入后跑 `loginUi` 全部 29 个按钮）：
 *   · 28/29 通过，**唯一失败是 `update()`**：`java.connect(...).raw is not a function`；
 *   · `update()` 里是 `String(java.connect(Get('url')).raw().request().url())` —— 取源站真实 host。
 *
 * 根因是**类级**的，不是这一颗源：
 *
 *  · **类① `java.connect` 把 StrResponse 又包了一层。**
 *    `syncHttpSpec` 的返回值**已经是**完整 StrResponse（字符串本体 + body/code/statusCode/url/raw），
 *    `connect` 却 `new String(body)` 再包一层、只手工补 `body/code/headers`
 *    ⇒ `raw()` 丢失 ⇒ 任何 `.raw().request()` / `.statusCode()` / `.isSuccessful()` 写法全炸。
 *    修法 = **不写第二份**：直接透传 `syncHttpSpec` 的结果（与 ajax/post/get 同一形态）。
 *
 *  · **类② `java.md5Encode16` 缺失**（上游 `JsEncodeUtils.kt:26-29` @JavascriptInterface）。
 *    缺了不会抛（java Proxy 兜底返回空串），但**静默错值**：语料 45 处用它当缓存键
 *    （`cache.put(java.md5Encode16(Get('url') + "headers"), …)`）⇒ 键全塌成同一个 ⇒
 *    跨源串味 + 自己的头读不回来。语义 = `md5Encode(str).substring(8, 24)`（**不是** 16 位 hex）。
 *
 * ⚠️ 两处 java 桩（L1 `selector/js.ts` 与 worker `sandbox/worker-pool.ts`）需同步维护，
 * 所以这里**两条路径都断言**（历史教训：单边改 ⇒ L1 与 worker 分岔）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** L1 求值（与线上同一份 createJsEvaluator） */
async function l1(code: string): Promise<unknown> {
  const jsEval = createJsEvaluator({ variables: createVariableStore() } as never);
  return jsEval(code, { result: '' } as never);
}

/**
 * worker 求值：**必须真的进池**（否则回落 L1 也会通过 ⇒ 测试空转）。
 * 脚本里带一句 `java.ajax(...)` 才会被路由进 worker 池；宿主 `http` 给固定响应。
 */
async function worker(code: string): Promise<unknown> {
  const pool = createWorkerSandboxPool({ size: 1 });
  let evals = 0;
  const counted = new Proxy(pool as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool: counted,
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const out = await Promise.resolve(ev(`java.ajax('https://h.test/ping');\n${code}`, { result: '' }));
    assert.ok(evals > 0, 'worker 用例必须真的走池（否则测试空转）');
    return out;
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

const MD5_A = createHash('md5').update('a').digest('hex');

test('#361 类①：java.connect(...) 返回完整 StrResponse（raw/url/statusCode 都在）', async () => {
  const code = `
    var r = java.connect('https://example.invalid/x');
    JSON.stringify({
      hasRaw: typeof r.raw === 'function',
      hasUrl: typeof r.url === 'function',
      hasCode: typeof r.code === 'function',
      hasStatus: typeof r.statusCode === 'function',
      hasBody: typeof r.body === 'function',
      reqUrl: typeof r.raw === 'function' ? String(r.raw().request().url()) : 'NO_RAW',
    });
  `;
  const out = JSON.parse(String(await l1(code))) as Record<string, unknown>;
  assert.equal(out['hasRaw'], true, 'connect 必须有 raw()（update() 依赖 .raw().request().url()）');
  assert.equal(out['hasUrl'], true);
  assert.equal(out['hasCode'], true);
  assert.equal(out['hasStatus'], true);
  assert.equal(out['hasBody'], true);
  assert.equal(out['reqUrl'], 'https://example.invalid/x');
});

test('#361 类②：java.md5Encode16 = md5Encode 的 substring(8,24)（L1）', async () => {
  const a = String(await l1('java.md5Encode16("a")'));
  const b = String(await l1('java.md5Encode("a")'));
  assert.equal(b, MD5_A);
  assert.equal(a, MD5_A.slice(8, 24), `md5Encode16 应为 32 位 hex 的第 8~23 位：${a}`);
  assert.equal(a.length, 16);
  // 对偶：不是「16 位 hex」（那是 md5Encode 的前 16 位）—— 两种实现必须可分
  assert.notEqual(a, MD5_A.slice(0, 16));
});

test('#361 两路一致：worker 桩同样有 md5Encode16 与 connect().raw()', async () => {
  const code = `
    var r = java.connect('https://example.invalid/y');
    JSON.stringify({
      m16: java.md5Encode16('a'),
      m32: java.md5Encode('a'),
      hasRaw: typeof r.raw === 'function',
    });
  `;
  const out = JSON.parse(String(await worker(code))) as Record<string, unknown>;
  assert.equal(out['m32'], MD5_A);
  assert.equal(out['m16'], MD5_A.slice(8, 24), 'worker 的 md5Encode16 必须与 L1 同语义');
  assert.equal(out['hasRaw'], true, 'worker 的 connect 也要有 raw()（历史：worker 侧先补齐过）');
});
