/**
 * 回归锁：2026-09-17（第二轮）修的两处**类别性**引擎缺陷。
 *
 * 都不是「某个源的问题」，而是对**所有源**生效的引擎能力缺口，且都表现为
 * **静默错值 / 静默兜底** —— 最难排查的那一类，也是「反复出现形同问题」的根源。
 *
 * 【类 1】DOM 桥接自指（`core/src/selector/analyze.ts`）
 *   `bridgeList` 是**就地改写 jsdom 节点**，把原生成员名覆盖成 jsoup 函数后：
 *   ① 闭包内再调同名原生方法 → 自递归 → `Maximum call stack size exceeded`
 *      （实测：腾讯漫画详情、蛋文库搜索）
 *   ② `css.ts` 的 `tag.` / `children` 分支拿到**同一节点**时读到函数而非集合 → 静默空值
 *   ③ `remove()` 调到自己 → 递归被 catch 吞 → **静默 no-op**（语料 32 处调用全无效）
 *   语料实测 `children` / `tagName` / `getElementsByTagName` 使用次数均为 **0** → 删除这三个握手；
 *   `remove` 改走原型链原生实现 `nativeProtoMethod`。
 *
 * 【类 2】规则求值绑定面不一致（`engine-legado/src/engine.ts`）
 *   `resolveHeaders`（源 `header` 规则）原先只绑 `baseUrl`，源脚本拿到的 `source` 是空桩
 *   （`key === ''`）→ `if(/zonghengxiaoshuo/.test(source.getKey()))` 恒假 → 变量未赋值 →
 *   整条 header 规则抛错 → 被 catch 吞 → **只发 UA、签名字段全丢** → 站点回
 *   `{"Status":"Unauthorized"}`。这类「接口鉴权失败」此前被误判为「站点侧不可控」。
 *   统一走 `baseBindings()`，并给兜底加 `warnOnce` 留痕。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const HTML = '<html><body><div id="box"><p class="a">甲</p><p class="b">乙</p><i class="c">丙</i></div></body></html>';

/* ── 类 1：DOM 桥接 ──────────────────────────────────────────────────── */

/** 走 AnalyzeRule 的真实绑定路径拿到**被桥接的节点**（等价于源脚本里的 `$` / `result`）。 */
async function bridgedRoot(): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const env = {
    baseUrl: 'https://api.test/',
    variables: createVariableStore(),
    jsEval: async (_code: string, b: Record<string, unknown>) => {
      captured = b['result'] as Record<string, unknown>;
      return 'ok';
    },
    jsEvalSync: () => 'ok',
    toAbsolute: (u: string) => u,
  } as never;
  await new AnalyzeRule(env).setContent(HTML, 'https://api.test/').getString('@js:result', false);
  assert.ok(captured, '必须捕获到被桥接的 result 绑定');
  return captured;
}

type JsoupNode = Record<string, unknown> & {
  select: (s: string) => JsoupNode;
  size: () => number;
  remove: () => unknown;
};

test('类1① 桥接后 children 不得被覆盖成函数（css.ts 的 tag./children 分支依赖集合语义）', async () => {
  const b = await bridgedRoot();
  const div = (b['select'] as (s: string) => JsoupNode)('div');
  assert.notEqual(typeof div['children'], 'function', 'children 被 jsoup 函数覆盖了 → 上层会读到函数而非集合');
  assert.equal(typeof div['children'], 'object', `children 必须是集合：${typeof div['children']}`);
});

test('类1② 桥接后的节点仍能调用原生 getElementsByTagName（此前自递归 → 栈溢出）', async () => {
  const b = await bridgedRoot();
  const div = (b['select'] as (s: string) => JsoupNode)('div');
  assert.doesNotThrow(() => {
    const got = (div['getElementsByTagName'] as (t: string) => ArrayLike<unknown>)('p');
    assert.equal(got.length, 2, '原生查询必须返回 2 个 p（不得被 jsoup 函数覆盖成自递归）');
  }, '节点上不得再挂同名 jsoup 函数');
});

test('类1③ remove() 必须真的移除节点（此前是静默 no-op）', async () => {
  const b = await bridgedRoot();
  const root = b as unknown as JsoupNode;
  assert.equal(root.select('p').size(), 2, '前置：应有 2 个 p');
  root.select('p.b').remove();
  assert.equal(root.select('p').size(), 1, 'remove 后应只剩 1 个 p（此前 remove 调到自己 → 静默无效）');
});

/* ── 类 2：源 header 规则绑定面 ──────────────────────────────────────── */

const BASE = 'https://fix.test';

function makeSrc(over: Record<string, unknown> = {}) {
  const raw = {
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '绑定面回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ...over,
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

function makeCtx(): { ctx: EngineContext; reqs: Array<{ url: string; headers: Record<string, string> }> } {
  const reqs: Array<{ url: string; headers: Record<string, string> }> = [];
  const ctx: EngineContext = {
    reqId: 'bind',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse> {
        reqs.push({ url, headers: { ...(opts?.headers ?? {}) } });
        const body = '<html><body><div class="item"><a href="/book/1">书名</a></div></body></html>';
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, reqs };
}

test('类2 源 header 规则必须拿到真实 source（签名头不得静默丢失）', async () => {
  // 复刻 星空小说 header 的**真实形态**：隐式全局赋值 + 依赖 source.getKey()
  const rule = makeSrc({
    header: ['@js:', 'if(/fix\\.test/.test(source.getKey())){', '  application = "com.xk.qreader";', '}', 'else {', '  application = "";', '}', 'JSON.stringify({ "application-id": application, sign: "S" });'].join('\n'),
  });
  const { ctx, reqs } = makeCtx();
  const eng = new LegadoEngine();
  await eng.search(rule, { action: 'search', keyword: 'x' }, ctx);

  const first = reqs[0];
  assert.ok(first, '必须发出搜索请求');
  assert.equal(
    first.headers['application-id'],
    'com.xk.qreader',
    `源 header 规则必须能读 source.getKey()；实际头：${JSON.stringify(first.headers)}`,
  );
  assert.equal(first.headers['sign'], 'S', '签名头必须出现在请求上');
  assert.ok(first.headers['User-Agent'], '默认 UA 必须保留');
});

test('类2c 值为空串的请求头必须原样发出（签名 API 按字段集重算签名）', async () => {
  // 实测依据（星空小说 api-bc.zonghengxiaoshuo.com）：同一 URL 同一 sign，
  // 只差 AUTHORIZATION/reg/qm-params 三个空值头 → 401 Unauthorized ↔ 200 有数据。
  const rule = makeSrc({
    header: '@js:JSON.stringify({ "application-id": "com.xk.qreader", sign: "S", AUTHORIZATION: "", reg: "", "qm-params": "" })',
  });
  const { ctx, reqs } = makeCtx();
  await new LegadoEngine().search(rule, { action: 'search', keyword: 'x' }, ctx);
  const h = reqs[0]?.headers ?? {};
  for (const k of ['AUTHORIZATION', 'reg', 'qm-params']) {
    assert.ok(k in h, `空值头 ${k} 必须出现在请求上（否则服务端签名校验字段集不一致）：${JSON.stringify(h)}`);
    assert.equal(h[k], '', `${k} 应为空串`);
  }
  assert.equal(h['application-id'], 'com.xk.qreader', '非空头必须保留');
});

test('类2b header 规则抛错时必须留痕（不得静默退化为 UA）', async () => {
  const rule = makeSrc({ header: '@js:throw new Error("boom")' });
  const { ctx, reqs } = makeCtx();
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  try {
    await new LegadoEngine().search(rule, { action: 'search', keyword: 'x' }, ctx);
  } finally {
    console.warn = orig;
  }
  assert.ok(reqs[0], '请求仍要发出（兜底保留）');
  assert.ok(
    warns.some((w) => w.includes('header') && w.includes('boom')),
    `header 规则失败必须 warn 留痕，实际：${JSON.stringify(warns)}`,
  );
});
