/**
 * 缺陷**类BT**回归锁：`@get:{k}` 与 `java.get(k)` **必须是同一条取值链**，
 * 且链末环 = **按源持久变量**（`sourceVariable` JSON 袋）。
 *
 * ## Legado 语义（权威）
 * `AnalyzeRule.kt:810-812`（`@get:{k}` 段）：
 * ```kotlin
 * regType == getRuleType -> { infoVal.insert(0, get(ruleParam[index])) }
 * ```
 * —— 调的就是 `get()`；而 `get()`（`AnalyzeRule.kt:872-888`）：
 * ```kotlin
 * return chapter?.getVariable(key)?.takeIf { it.isNotEmpty() }
 *     ?: book?.getVariable(key)?.takeIf { it.isNotEmpty() }
 *     ?: ruleData?.getVariable(key)?.takeIf { it.isNotEmpty() }
 *     ?: source?.get(key)?.takeIf { it.isNotEmpty() }   // ★ 按源持久变量
 *     ?: ""
 * ```
 *
 * ## 我们此前的缺陷（实测 ⚡📂️咪咕阅读）
 * `java.get(k)` 有「顶层 → `sourceVariable` 袋」的回落，而 `@get:{…}`（共 8 处）**只读顶层**
 * ⇒ **同进程的探针能过、服务端跨请求必空**：
 * `ruleSearch.wordCount = '@put:{bid:$.bookId}'` 先 put，详情阶段
 * `tocUrl = '…&cmd=0000&bid=@get:{bid}&order=0'` 解析成 `…&bid=&order=0` ⇒ 站点取不到目录 ⇒ 0 章。
 * 修复前服务端留痕：`[detail] tocUrl: rule=…&bid=@get:{b ⇒ out=…&bid=&order=0…`。
 *
 * ⚠️ **这个用例的构造方式很关键**：`@put` 必须写进**袋**（模拟「上一个请求」），
 * 而不是写进顶层 —— 否则测不出来（这正是探针漏掉它的原因）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml } from '../index';
import type { AnalyzeEnv } from '../index';

const HTML = '<html><body><p>x</p></body></html>';

/**
 * 造一个「上一个请求刚结束」的 env：变量只存在于 `sourceVariable` 这个 JSON 袋里，
 * 顶层**没有** `bid`（对齐 hub 每个 HTTP 动作新建 variables 的真实形态）。
 */
function makeEnv(bag: Record<string, string>, topLevel: Record<string, string> = {}): AnalyzeEnv {
  const variables = createVariableStore();
  variables.set('sourceVariable', JSON.stringify(bag));
  for (const [k, v] of Object.entries(topLevel)) variables.set(k, v);
  return {
    baseUrl: 'https://x.test/',
    variables,
    jsEval: createJsEvaluator({ variables }),
  };
}

test('类BT：`@get:{k}` 整段必须回落 `sourceVariable` 袋（跨请求取到值）', async () => {
  const r = new AnalyzeRule(makeEnv({ bid: '576873029' })).setContent(parseHtml(HTML).root);
  assert.equal(await r.getString('@get:{bid}'), '576873029');
});

test('类BT：URI 中间的 `@get:{k}` 同样要回落（类BS 在服务端真正可用的前提）', async () => {
  const r = new AnalyzeRule(makeEnv({ bid: '576873029' })).setContent(parseHtml(HTML).root);
  const url = await r.getString('https://n.cmread.test/nap/p/catalog.jsp?cm=0000&bid=@get:{bid}&order=0', false);
  assert.match(url, /bid=576873029/, `跨请求时 URL 里的 @get 也应解析，实际 = ${url}`);
  assert.ok(!url.includes('@get:'), `不得残留字面量 @get:，实际 = ${url}`);
});

test('类BT：`@get:{k}` 与 `java.get(k)` 结果必须一致（同一条链）', async () => {
  // 顶层没有 bid，只在袋里 —— 两边都必须取到同一个值
  const env = makeEnv({ bid: '576873029' });
  const r = new AnalyzeRule(env).setContent(parseHtml(HTML).root);
  const viaRule = await r.getString('@get:{bid}');
  const viaJava = await r.getString("@js:java.get('bid')");
  assert.equal(viaRule, '576873029');
  assert.equal(viaJava, '576873029');
  assert.equal(viaRule, viaJava, '`@get:{k}` 与 `java.get(k)` 是同一条链，结果必须一致');
});

test('类BT：顶层优先于袋（对齐 Legado `get()` 的顺序：先本请求，后按源持久）', async () => {
  const env = makeEnv({ bid: 'OLD' }, { bid: 'NEW' });
  const r = new AnalyzeRule(env).setContent(parseHtml(HTML).root);
  assert.equal(await r.getString('@get:{bid}'), 'NEW');
});

test('类BT：袋里的键缺失 → 空串（不抛错、不返回字面量）', async () => {
  const r = new AnalyzeRule(makeEnv({ bid: '1' })).setContent(parseHtml(HTML).root);
  assert.equal(await r.getString('@get:{missing}'), '');
});

test('类BT：袋不是合法 JSON 时按未命中处理（源脚本可能自己写坏）', async () => {
  const env = makeEnv({});
  env.variables.set('sourceVariable', '{不是 JSON');
  const r = new AnalyzeRule(env).setContent(parseHtml(HTML).root);
  assert.equal(await r.getString('@get:{bid}'), '');
});
