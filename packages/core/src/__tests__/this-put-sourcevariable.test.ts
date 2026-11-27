/**
 * 回归锁：**`this.put(obj)` 单参 = 保存整份源变量**（qyyuapi 系 jsLib 的 `put(data)` 语义）。
 *
 * ## 为什么这是一条「类级」缺陷
 *
 * qyyuapi 五个漫画源（MYCOMIC / Komiic / 热辣 / 漫画柜 / 拷贝）的 jsLib 全部这么写：
 * ```js
 * // common.js
 * function put(data) {
 *   const { java, source, cookie, cache } = this;
 *   return source.setVariable(JSON.stringify(data, null, '\t'));
 * }
 * // 站点 jsLib
 * return this.put(original);   /  this.put($$$);
 * ```
 * 即 `this.put` 就是库自己的 `put(data)`：**单参传整份对象**，落点是 `source.setVariable`。
 *
 * 本仓 `makeThisScope.put` 只按二元 `put(k, v)` 解释 ⇒ `String(obj) = "[object Object]"`、
 * `String(undefined) = "undefined"` ⇒ 经 `putSharedVariable` 把源变量写成
 * `{"[object Object]":"undefined"}` ⇒ `Get('url')` 取不到站点 ⇒ 分类 URL 变成
 * `undefined/comics`（用户可见症状：**用过一次就坏**）。
 *
 * 锁住的行为：
 * 1. 单参对象 → `sourceVariable` 是它的 JSON（且**不**出现 `[object Object]` 键）；
 * 2. 单参 JSON 字符串 → 原样保存；
 * 3. 双参 `put(k, v)` 行为不变（本请求变量表 + 持久钩子）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/** 与引擎的源桩同形：`getVariable()` 读的就是 variables 里的 sourceVariable */
function sourceStub(variables: ReturnType<typeof createVariableStore>) {
  return { getVariable: () => String(variables.get('sourceVariable') ?? '') };
}

test('this.put(obj) 保存整份源变量（五个 qyyuapi 漫画源的 this.put(original)）', () => {
  const variables = createVariableStore();
  const source = sourceStub(variables);
  const ev = createJsEvaluator({ variables });

  ev('this.put({ url: "https://mycomic.com", urls: ["https://mycomic.com"] })', { source });

  assert.equal(
    variables.get('sourceVariable'),
    JSON.stringify({ url: 'https://mycomic.com', urls: ['https://mycomic.com'] }),
    '单参对象必须整份写进 sourceVariable',
  );
  assert.equal(variables.get('[object Object]'), undefined, '不得再把对象字符串化成键名');
  assert.equal(
    String(ev('JSON.parse(source.getVariable()).url', { source })),
    'https://mycomic.com',
    '源脚本的 Get(e,f) = JSON.parse(source.getVariable())[e] 必须取得到 url',
  );
});

test('this.put(jsonText) 原样保存（库自己传 JSON 串的形态）', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  ev('this.put(\'{"a":1}\')', {});
  assert.equal(variables.get('sourceVariable'), '{"a":1}');
});

test('this.put(k, v) 双参行为不变（本请求变量 + 持久钩子）', () => {
  const variables = createVariableStore();
  const persisted: Array<[string, string]> = [];
  const ev = createJsEvaluator({
    variables,
    javaExtra: { putVariable: (k: string, v: string) => persisted.push([k, v]) },
  });

  ev('this.put("k", "v")', {});

  assert.equal(variables.get('k'), 'v');
  assert.deepEqual(persisted, [['k', 'v']], '双参仍走 javaExtra.putVariable（与 java.put / @put 同落点）');
  assert.equal(variables.get('sourceVariable'), undefined, '双参不得误写整份源变量');
});
