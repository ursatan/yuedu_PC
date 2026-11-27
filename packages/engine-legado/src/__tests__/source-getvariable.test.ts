/**
 * `source.getVariable()` —— **源码里从未设置过时必须是空串 `''`**（`#148` 回归锁）。
 *
 * ## 为什么一个字符的差异值得单独一个文件
 * 上游 `BaseSource.kt:336-338`：
 * ```kotlin
 * fun getVariable(): String { return CacheManager.get("sourceVariable_${getKey()}") ?: "" }
 * ```
 * 而**大量源的第一句**就是：
 * ```js
 * try { $$$ = JSON.parse(source.getVariable()); if ($$$ == null) throw new Error(); … }
 * catch (e) { $$$ = original; put($$$); }        // ← 首次运行靠这里初始化出 url/name
 * ```
 * ⇒ 上游返回 `''` 时 `JSON.parse('')` **抛错** → 走 `catch` → `$$$ = original`（完整默认对象）。
 * 我们若返回 `'{}'`，解析**成功**、`catch` **永不触发**，而源自己的回填只补 `usedIndexes/weekIndex/…`
 * （**没有 `url`、没有 `name`**）⇒ `$$$.url === undefined` ⇒ 拼出 `undefined/albums?…` 这类 URL
 * ⇒ 发现页 `items=0`，且**不报任何错**。
 *
 * 实测留痕（禁漫天堂 `action:'home'`）：`{"name":"[▶ undefined ◀]"…}`、
 * `{"name":"全部","value":"undefined/albums?o=mr&page={{page}}"}`。
 *
 * ★ 本文**两侧都锁**：① 未设置 ⇒ `''`（空串，不是 `'{}'`）；② `setVariable` 之后读回同一个值
 * （只锁第一条的话，把 `getVariable` 直接写死 `''` 也能过）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
} from '@yuedu/core';
import { LegadoEngine } from '../engine';

const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('sandbox 不可用（L1 引擎不用它）');
  },
};

function makeCtx(): EngineContext {
  return {
    reqId: 't',
    sourceId: 'getvar',
    signal: new AbortController().signal,
    http: {
      async request(url: string) {
        return { status: 200, headers: {}, body: '<html><body><h1>x</h1></body></html>', url };
      },
    } satisfies HttpClient,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

const engine = new LegadoEngine();
const compile = (raw: Record<string, unknown>) => {
  const r = engine.compile(raw);
  assert.ok(r.ok && r.rule, 'compile 应通过');
  return r.rule;
};
const detailReq = { action: 'detail', id: JSON.stringify({ bookUrl: 'https://t.test/book/1' }) } as never;

/** 用 `ruleBookInfo.name` 当「求值探针」：把 `getVariable()` 的结果带出来 */
function sourceWithNameJs(js: string) {
  return compile({
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '源变量默认值',
    ruleBookInfo: { name: `@js:${js}` },
  });
}

test('① 从未设置过 ⇒ getVariable() 是**空串**（不是 "{}"）', async () => {
  const rule = sourceWithNameJs(`JSON.stringify({ v: source.getVariable(), isEmpty: source.getVariable() === '' })`);
  const r = await engine.detail(rule, detailReq, makeCtx());
  const got = JSON.parse(r.title) as { v: string; isEmpty: boolean };
  assert.equal(got.v, '', `必须是空串，实际 ${JSON.stringify(got.v)}`);
  assert.equal(got.isEmpty, true, '★ 返回 "{}" 会让源的 try/catch 兜底永不触发（#148 的真因）');
});

test('② 防空转：`JSON.parse(getVariable())` 在**未设置**时应当抛错（源的 catch 分支靠它）', async () => {
  const rule = sourceWithNameJs(
    `var fell = false; try { JSON.parse(source.getVariable()); } catch (e) { fell = true; } JSON.stringify({ fell: fell })`,
  );
  const r = await engine.detail(rule, detailReq, makeCtx());
  assert.equal((JSON.parse(r.title) as { fell: boolean }).fell, true, '必须走 catch —— 那是源初始化 $$$ 的唯一入口');
});

test('③ 反向：setVariable 之后读回**同一个值**（不能为了 ① 就把 getVariable 写死成空串）', async () => {
  const rule = sourceWithNameJs(
    `source.setVariable(JSON.stringify({ url: 'https://x.test' })); var s = source.getVariable(); JSON.stringify({ v: s, url: JSON.parse(s).url })`,
  );
  const r = await engine.detail(rule, detailReq, makeCtx());
  const got = JSON.parse(r.title) as { v: string; url: string };
  assert.equal(got.url, 'https://x.test', 'setVariable 的写入必须读得回来');
  assert.notEqual(got.v, '', '写过之后不该还是空串');
});
