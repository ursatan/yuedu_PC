/**
 * `#682` **实体 / 源桩的 JavaBean getter 面**：`source.getBookSourceUrl()` 这类写法。
 *
 * 为什么必须有（用户实测 黄果短剧🔞）：
 *  · Legado 的实体（Book / BookChapter / BookSource / RssArticle）都是 **Kotlin data class**，
 *    JVM 会为每个 `var` 生成 `getXxx()`，Rhino 里源脚本可以直接调；
 *  · 本仓只给了**字段**（`source.bookSourceUrl`），方法面缺 ⇒ 脚本写
 *    `try{root=String(source.getBookSourceUrl())}catch(e){root=''}` 时**静默拿到空串**
 *    （`entityStub` 的「可下钻空桩」把未知属性变成可调用、返回空串，不报错、也不提示）；
 *  · 黄果短剧的「线路域名」因此取不到 ⇒ 详情 URL 回落到**当前页 baseUrl**
 *    （`…/ai-duanju/1/video/10841/`）⇒ 站点 404 页「页面不存在或已下架」，
 *    顺带「选集」全错（它拼的是 `root + /video/<id>/<ep>/`）。
 *
 * 语料实测：`source.getXxx()` 共 556 处、113 个源
 * （getVariable 261 / getLoginInfoMap 144 / getKey 68 / getLoginHeader 35 / … / getBookSourceUrl 3）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { makeProbeEnv } from '../diag/probe';
import { makeSourceStub } from '../source-stub';

const SOURCE_URL = 'https://l205.arj2ftl0.cc';

function mk(sourceData?: Record<string, unknown>): AnalyzeRule {
  const { env } = makeProbeEnv({ content: '<div>x</div>', baseUrl: SOURCE_URL, vars: {} } as never);
  if (sourceData) (env as { sourceData?: Record<string, unknown> }).sourceData = sourceData;
  return new AnalyzeRule(env).setContent('<div>x</div>', SOURCE_URL);
}

test('B-① 脚本里 `source.getBookSourceUrl()` 要拿到源的 bookSourceUrl（不能是空串）', async () => {
  const out = await mk({ bookSourceUrl: SOURCE_URL }).getString('@js:source.getBookSourceUrl()');
  assert.equal(out, SOURCE_URL, '取不到 ⇒ 源脚本里的「线路域名」会回落到当前页 URL');
});

test('B-② 字段式写法 `source.bookSourceUrl` 仍然可用（两种写法都要支持）', async () => {
  assert.equal(await mk({ bookSourceUrl: SOURCE_URL }).getString('@js:source.bookSourceUrl'), SOURCE_URL);
});

test('B-③ 未知 getter 仍回空串、不抛异常（可下钻空桩语义不变）', async () => {
  assert.equal(await mk({ bookSourceUrl: SOURCE_URL }).getString('@js:source.getNotExistField()'), '');
  assert.equal(await mk().getString('@js:source.getBookSourceUrl()'), '', '没有 sourceData 时仍为空串');
});

test('B-④ 宿主源桩：BaseSource 的 JavaBean getter 面', () => {
  // 最小 ctx：源桩只需要一个 variables 作用域（put/get 的落点）
  const vars = new Map<string, unknown>();
  const ctx = { variables: { get: (k: string) => vars.get(k), set: (k: string, v: unknown) => void vars.set(k, v) } } as never;
  const stub = makeSourceStub(ctx, {
    bookSourceUrl: SOURCE_URL,
    bookSourceName: '测试源',
    bookSourceGroup: '影视',
    loginUrl: 'https://x/login',
    header: '{"User-Agent":"ua"}',
    jsLib: 'var a=1;',
  }) as Record<string, unknown>;
  assert.equal((stub['getBookSourceUrl'] as () => string)(), SOURCE_URL);
  assert.equal((stub['getBookSourceName'] as () => string)(), '测试源');
  assert.equal((stub['getBookSourceGroup'] as () => string)(), '影视');
  assert.equal((stub['getLoginUrl'] as () => string)(), 'https://x/login');
  assert.equal((stub['getHeader'] as () => string)(), '{"User-Agent":"ua"}');
  assert.equal((stub['getJsLib'] as () => string)(), 'var a=1;');
  // 原有的 put/get 命名空间不受影响（与 JavaBean getter 是两套东西）
  assert.equal((stub['get'] as (k: string) => string)('nope'), '');
});
