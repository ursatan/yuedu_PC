/**
 * `$n` 捕获组引用回归锁（对齐 Legado `AnalyzeRule.kt:744-792`）。
 *
 * 上游语义：
 *  · `splitRegex` 只扫描**首个 `##` 之前**的文本（`:748`），命中 `\$\d{1,2}` 就把 mode 改成
 *    Regex；`##正则##$1` 的 `$1` 在**替换串**里，是 `String.replace` 语义（不是组引用）；
 *  · `makeUpRule`（`:783-792`）：`result` 是列表且索引在范围内 ⇒ 取该组；列表越界 ⇒ **空串**；
 *    `result` 不是列表 ⇒ 保留字面量 `$n`；
 *  · 列表入口 `getElements` 的元素是 `List<String>`（`AnalyzeByRegex.kt:39-51`），
 *    `$0` 是整匹配（`:19`）。
 *
 * 语料实测（`data/yuedu.db` 763 源，只读扫描）：`$n` 出现在规则体（非 JS 段）共 3 源 5 处 ——
 * ⚡📂️快眼小说（`chapterName: $2##…` / `chapterUrl: $1`）与 ⚡📂若夏（`$2$3` / `…$1`），
 * 两者的 `chapterList` 都是正则。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';
import { splitSourceRule } from '../selector/rule-analyzer';

function ruleOn(content: unknown) {
  const variables = createVariableStore();
  const env = { baseUrl: 'https://x.test/', variables, jsEval: createJsEvaluator({ variables }) };
  return new AnalyzeRule(env as never).setContent(content as never, 'https://x.test/');
}

test('$1：上一级正则结果的第 1 组', async () => {
  const out = await ruleOn(['整匹配', '/book/1', '第一章']).getString('$1');
  assert.equal(out, '/book/1');
});

test('$2 / $2$3：多组拼接（⚡📂若夏 chapterName 原文形态）', async () => {
  assert.equal(await ruleOn(['m', '1', '第一章', '（VIP）']).getString('$2$3'), '第一章（VIP）');
});

test('$0：整匹配（用户口径；上游 getElements 的组 0 即整段匹配）', async () => {
  assert.equal(await ruleOn(['整匹配', '组1']).getString('$0'), '整匹配');
});

test('越界索引 $9：上一级是列表但越界 ⇒ 空串（上游 `if (this.size > regType)` 不成立）', async () => {
  assert.equal(await ruleOn(['整匹配', '组1']).getString('$9'), '');
});

test('无上一级列表 ⇒ 保留字面量 $9（上游 `?: insert(ruleParam)`）', async () => {
  assert.equal(await ruleOn('<p>hi</p>').getString('$9'), '$9');
});

test('复合段里的 $1：字面文本 + 组引用拼接', async () => {
  assert.equal(await ruleOn(['整匹配', 'url1']).getString('https://a.test/$1.html'), 'https://a.test/url1.html');
});

test('`##正则##$1` 非回归：替换串里的 $1 仍按 String.replace 语义展开，不变成组引用', async () => {
  // 规则体为空 + 纯替换：`abc`.replace(/(a)(b)/g, '$2$1') ⇒ 'bac'
  const out = await ruleOn('abc').getString('##(a)(b)##$2$1');
  assert.equal(out, 'bac');
});

test('切段锁：`##` 之后的 $1 不建 group 片段（替换串保持原文）', () => {
  const [seg] = splitSourceRule('$2##(x)##$1');
  assert.equal(seg?.mode, 'Regex');
  const types = (seg?.pieces ?? []).map((p) => p.type);
  assert.deepEqual(types, ['group', 'text'], `实际片段：${JSON.stringify(seg?.pieces)}`);
  const text = (seg?.pieces ?? []).map((p) => (p.type === 'text' ? p.value : '')).join('');
  assert.equal(text, '##(x)##$1');
});
