/**
 * 列表阶段**逐条字段求值**的回归锁（2026-09-26）。
 *
 * ## 背景（用户实测「🔊潇社音乐：目录 0」）
 * 该源把整条搜索结果塞进 `ruleSearch.lastChapter` 的 JS 里：
 *   `lastChapter = "@js:java.put('json', JSON.stringify(result));''"`
 * 目录规则再 `java.get('json')` 取回来，**把结果对象当章节列表**。
 * ⇒ 列表阶段若不求值 `lastChapter`，`json` 永远不会被写入 ⇒ 目录恒为 **0 章**。
 * 铁证：开 `YUEDU_DEBUG_DETAIL=1` 后 `[put]` 留痕**一条都没有** ——
 * 这条留痕机制本身就是为了区分「没写」与「写了读不到」（见 `putSharedVariable` 注释）。
 *
 * 本测试锁住「按类别补齐」后的行为：
 *   ① `lastChapter` 必须被求值 ⇒ 它的**副作用**（`java.put`）必须发生；
 *   ② 契约里 `subtitle` = 「作者 / 备注 / **更新至**」⇒ 没作者时回落 lastChapter；
 *   ③ 值随 payload 带走（详情页没配 ruleBookInfo.lastChapter 时也能用）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const BASE = 'https://list.test';

function makeCtx(): { ctx: EngineContext; variables: ReturnType<typeof createVariableStore> } {
  const variables = createVariableStore();
  const ctx: EngineContext = {
    reqId: 'list-fields',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body><div class="item"><a href="/b/1">书名一</a></div></body></html>',
          url,
        };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables,
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, variables };
}

test('列表阶段必须求值 lastChapter：副作用（java.put）要发生，且值回落 subtitle', async () => {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '列表字段测试',
    bookSourceType: 1,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: {
      bookList: '.item',
      name: 'a@text',
      bookUrl: 'a@href',
      // ⚠️ 这一句的**返回值**是空串（`''`），真正的目的是 `java.put` 的副作用
      lastChapter: "@js:java.put('json', JSON.stringify({ sid: '1340133' }));''",
      // 故意不配 author ⇒ 验证 subtitle 回落「更新至」
    },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);

  const { ctx, variables } = makeCtx();
  const r = await new LegadoEngine().search(out.rule!, { action: 'search', keyword: 'x', page: 1 }, ctx);
  assert.equal(r.items.length, 1);
  const it = r.items[0]!;

  assert.equal(
    variables.get('json'),
    '{"sid":"1340133"}',
    'lastChapter 的 java.put 必须真的执行 —— 否则依赖它的目录阶段读不到数据（潇社音乐就是 0 章）',
  );
  assert.equal(
    'lastChapter' in (it.payload as Record<string, unknown>),
    false,
    'lastChapter 的返回值是空串（本用例刻意如此）⇒ 该键不该出现在 payload 里',
  );
  assert.equal(it.subtitle, undefined, 'lastChapter 为空串时 subtitle 应保持 undefined（不写空串噪音）');
});

test('列表阶段求值 lastChapter：有值时回落 subtitle 并随 payload 带走', async () => {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '列表字段测试2',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: {
      bookList: '.item',
      name: 'a@text',
      bookUrl: 'a@href',
      // 用 `@js:` 返回字面量（裸字符串会被当 CSS 选择器，那是 Legado 的规则语义）
      lastChapter: "@js:'更新至 第12章'",
    },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  const { ctx } = makeCtx();
  const r = await new LegadoEngine().search(out.rule!, { action: 'search', keyword: 'x', page: 1 }, ctx);
  const it = r.items[0]!;
  assert.equal(it.subtitle, '更新至 第12章', '契约里 subtitle = 作者/备注/更新至 ⇒ 没作者时回落 lastChapter');
  assert.equal((it.payload as { lastChapter?: string }).lastChapter, '更新至 第12章', '值要随 payload 带走');
});
