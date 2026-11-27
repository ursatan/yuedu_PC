/**
 * `#341`（2026-10-08）：`java.getString(rule, null)` 的 **null 第二参**把求值打到**空内容**上。
 *
 * 症状（用户报障「📖Lofter 正文空白」）：分类列表 title/pubDate 正常，但每条文章的
 * link = `post/detail.api?...,{"method":"POST","body":"targetblogid=&postid="}` ——
 * **两个参数全空** ⇒ content 阶段 HTTP 400（`NETWORK@request`）⇒ 正文空白。
 *
 * 链路（vitest 隔离实验逐层锁定）：
 *   1. Lofter jsLib 的取值函数 `function S(e,s){ const {java} = this; return String(java.getString(e, s ?? null)) }`
 *      —— **第二参缺省时传 null**（Legado 生态惯用写法，模拟上游默认参数）；
 *   2. L1 java stub 旧判定 `if (mContent !== undefined)` ⇒ **null 也算「传了」**；
 *   3. ⇒ 走规则桥 `new AnalyzeRule(env).setContent(null)` ⇒ **在空内容上求值**
 *      ⇒ `$.post.blogId` 这类 JSONPath 恒空。
 *
 * 上游依据（逐行核实，不猜测）：`AnalyzeRule.kt:322`
 * ```kotlin
 * val content = mContent ?: this.content
 * ```
 * **mContent 为 null ⇒ 用当前实例内容** —— null 与「未传」同义，不是「以 null 为文档」。
 *
 * 修复：L1 `makeJavaStub.getString` 与 ruleApi 四桥（getString/getStringList/getElements/getElement）
 * 的判定改为 `mContent != null`；worker 侧 `getString` 补上第二参（旧签名只有单参，
 * 显式传 content 在 worker 被静默丢弃——同一判据族，顺手对齐，防「L1 与 worker 分岔」）。
 *
 * 回归锁：jsLib `S` + `java.getString(e, null)` 必须在**当前 item** 上求值成功。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraceSink, createVariableStore, type EngineContext } from '@yuedu/core';
import { makeRssEnv } from './env';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

/** 与 Lofter jsLib 同构的最小 jsLib：S = java.getString(e, s??null)（第二参缺省传 null） */
const JS_LIB = `
function S(e,s){
  const {java} = this;
  return String(java.getString(e,s??null))
}
`;

/** 与 Lofter ruleLink 默认分支同构：S() 从当前 item 上下文取 JSONPath */
const RULE_LINK = `@js:
try{
  let url = S('$.post.blogId');
  let id = S('$.post.id') || S('$.id');
  result = 'https://api.test/detail,{"method":"POST","body":"targetblogid=' + url + '&postid=' + id + '"}';
}catch(e){
  java.log(e)
}
result`;

function makeCtx(): EngineContext {
  const variables = createVariableStore();
  const store = new Map<string, string>();
  return {
    reqId: 'test',
    sourceId: 'rss-test',
    signal: new AbortController().signal,
    http: { async request() { throw new Error('本组用例零网络'); } },
    sandbox: { async eval() { return undefined; } }, // 本机 worker 池不可用 ⇒ L1（与 worker 同语义，见 #341 修复）
    trace: createTraceSink(),
    variables,
    storage: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
    toastSink: [],
  } as unknown as EngineContext;
}

test('#341：java.getString(e, null) 的 null 必须=「未传」，在当前上下文求值（旧实现在空内容上求值恒空）', async () => {
  const rule = compileRssSource({
    sourceUrl: 'https://api.test',
    sourceName: '#341 回归源',
    jsLib: JS_LIB,
    ruleLink: RULE_LINK,
  } as RssSourceRaw);
  const item = { post: { blogId: 111, id: 222 }, name: 'x' };

  const env = makeRssEnv(makeCtx(), rule, 'https://api.test/list');
  const link = await env.jsEval
    ? (env.jsEval as (code: string, b: Record<string, unknown>) => Promise<string>)(
        String(rule.ruleLink).replace(/^@js:/, ''),
        { $: item, result: item, baseUrl: 'https://api.test/list' },
      )
    : '';

  assert.ok(
    /targetblogid=111&postid=222/.test(String(link)),
    `S() 应从当前 item 取到 blogId/id，实际：${String(link).slice(0, 160)}`,
  );
});
