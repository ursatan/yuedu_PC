/**
 * `#600` **RSS 引擎的源变量持久层 + loginUrl 初始化**。
 *
 * ## 背景（全量基线 2026-10-24，qyyuapi 系 9 个源）
 * 这些聚合源的 jsLib / header / sortUrl 到处是 `Get('url')`，而 `Get()` 的实现是
 * `JSON.parse(source.getVariable())`。两条原因叠在一起让它恒空：
 *  ① **RSS 引擎此前没有源变量的持久层**（`source-var:<id>` 的 prime/persist 只写在
 *     `engine-legado` 里，包内私有）⇒ 磁盘上就算有值也读不到；
 *  ② 源变量的唯一初始化入口是 `loginUrl`（`eval(String(Reload('.../loginUrl.js')))` 里
 *     `put($$$)`），而它从来没被自动跑过。
 * ⇒ `JSON.parse('')` 抛 ⇒ header/sortUrl 全崩。
 *
 * 对偶（防空转）：每个用例都有「不该发生的那一半」——
 *  · 已有持久值时**不能再跑** loginUrl（否则每次请求都重跑源脚本）；
 *  · 表单式 `function login()` **不能**自动跑（那需要用户填的账号密码）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVariableStore, type EngineContext } from '@yuedu/core';
import { primeSourceVariable } from './env';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

const SOURCE_ID = 'rss-600';

/** 够用的 EngineContext（storage 走内存 Map；本组用例只跑纯脚本，零网络） */
function makeCtx(store: Record<string, string> = {}): { ctx: EngineContext; store: Map<string, string> } {
  const st = new Map<string, string>(Object.entries(store));
  const ctx = {
    reqId: 'test',
    sourceId: SOURCE_ID,
    signal: new AbortController().signal,
    http: {
      async request() {
        throw new Error('本组用例不应发请求（loginUrl 是纯脚本形态）');
      },
    },
    sandbox: { async eval() { return undefined; } }, // 起不了子进程 ⇒ hybrid 回落 L1
    variables: createVariableStore(),
    storage: {
      get: async (k: string) => st.get(k) ?? null,
      set: async (k: string, v: string) => void st.set(k, v),
      delete: async (k: string) => void st.delete(k),
    },
    toastSink: [],
  } as unknown as EngineContext;
  return { ctx, store: st };
}

function ruleOf(extra: Record<string, unknown>) {
  return compileRssSource({
    sourceUrl: 'https://q.test/feed',
    sourceName: '聚合测试',
    ...extra,
  } as RssSourceRaw);
}

test('#600 语句形态 loginUrl：跑一次，把源变量写进 variables 且落盘', async () => {
  const { ctx, store } = makeCtx();
  const rule = ruleOf({ loginUrl: 'source.setVariable(JSON.stringify({url:"https://q.test"}));' });
  await primeSourceVariable(ctx, rule);
  const live = String(ctx.variables.get('sourceVariable') ?? '');
  assert.ok(live.includes('q.test'), `源变量应已初始化：${live}`);
  assert.ok(
    String(store.get(`source-var:${SOURCE_ID}`) ?? '').includes('q.test'),
    '源变量必须落盘（否则下次请求又是空的）',
  );
});

test('#600 持久层已有值：直接读回，**不重跑** loginUrl', async () => {
  const { ctx } = makeCtx({ [`source-var:${SOURCE_ID}`]: '{"url":"https://stored.test"}' });
  const rule = ruleOf({ loginUrl: 'source.setVariable("SHOULD_NOT_RUN");' });
  await primeSourceVariable(ctx, rule);
  const live = String(ctx.variables.get('sourceVariable') ?? '');
  assert.equal(live, '{"url":"https://stored.test"}', `应读持久层的值：${live}`);
  assert.ok(!live.includes('SHOULD_NOT_RUN'), '已有值时必须跳过 loginUrl');
});

test('#600 表单式 loginUrl（function login）不自动跑', async () => {
  const { ctx, store } = makeCtx();
  const rule = ruleOf({ loginUrl: 'function login(){ source.setVariable("RAN"); return true; }' });
  await primeSourceVariable(ctx, rule);
  assert.equal(String(ctx.variables.get('sourceVariable') ?? ''), '', '表单式不该被自动执行（缺账号密码）');
  assert.equal(store.get(`source-var:${SOURCE_ID}`) ?? '', '', '也不该落盘空值');
});
