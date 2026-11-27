/**
 * `#679` 规则里两个「容易看着像但口径完全不同」的东西：
 *
 * ① **组合符** `&&` / `||` / `%%`：上游 `AnalyzeByJSoup.getStringList`（:66-126）
 *    逐段求值后按类型合并 —— `&&` 顺序拼接、`||` 第一个非空就停、`%%` 交错。
 *    用户实测 `li>a@text&&li>a@href` 在查看器里回了 16 条**全是 href**，`||` 回 8 条 href
 *    —— 引擎是对的，错在探针的值模式把整条复合规则按最后一个 `@` 切了。
 *
 * ② **索引语法** `[...]` / `!` / `.`：上游 `ElementsSingle.findIndexSet`
 *    （`AnalyzeByJSoup.kt:401-510`）默认 `split = '.'`（包含），
 *    `[!…]` 是排除、`[-1:0]` 可让列表反向。本仓三处写错：
 *    · 默认 split 写成 `' '`（不过滤）⇒ `[-1]` 回全部；
 *    · 区间三元组 start/end 写成同一个值 ⇒ `[0:2]` 只回 1 条；
 *    · `[!…]` 跳过空格后没重读当前字符 ⇒ 落进「整条当选择器」⇒ 恒空；
 *    · 反向区间用 `i += step` ⇒ 死循环（`Set maximum size exceeded`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { createVariableStore } from '../store';
import { probeSelector } from '../diag/probe';

const HTML =
  '<div class="menu"><ul class="clear">'
  + '<li><a href="/a1/">玄幻小说</a></li>'
  + '<li><a href="/a2/">仙侠小说</a></li>'
  + '<li><a href="/a3/" title="更多分类">···</a></li>'
  + '</ul></div>';

function makeRule(): AnalyzeRule {
  const env = {
    variables: createVariableStore(),
    jsEval: (() => '') as never,
    jsEvalSync: (() => '') as never,
    toAbsolute: (u: string) => u,
  } as never;
  return new AnalyzeRule(env).setContent(HTML, 'https://x/');
}

/* ------------------------- ① 组合符 ------------------------- */

test('C-① `&&` = 各段顺序拼接（text 3 + href 3 = 6，不去重）', async () => {
  const v = await makeRule().getStringList('li>a@text&&li>a@href');
  assert.deepEqual(v, ['玄幻小说', '仙侠小说', '···', '/a1/', '/a2/', '/a3/']);
});

test('C-② `||` = 取第一个非空段（后面的段不求值）', async () => {
  const v = await makeRule().getStringList('li>a@text||li>a@href');
  assert.deepEqual(v, ['玄幻小说', '仙侠小说', '···']);
});

test('C-③ `%%` = 各段交错合并（文字/链接成对）', async () => {
  const v = await makeRule().getStringList('li>a@text%%li>a@href');
  assert.deepEqual(v, ['玄幻小说', '/a1/', '仙侠小说', '/a2/', '···', '/a3/']);
});

test('C-④ 探针值模式：复合规则不能再按最后一个 `@` 切（`#679` 用户实测 16 条全 href）', async () => {
  const and = await probeSelector({ selector: 'li>a@text&&li>a@href', content: HTML, valueMode: true, sampleLimit: 50 });
  assert.equal(and.hitCount, 6);
  assert.deepEqual(and.samples, ['玄幻小说', '仙侠小说', '···', '/a1/', '/a2/', '/a3/'], '不能变成 6 条 href（更不能翻倍）');
  assert.match(String(and.note), /顺序拼接/, '要说明三个组合符的口径');

  const or = await probeSelector({ selector: 'li>a@text||li>a@href', content: HTML, valueMode: true, sampleLimit: 50 });
  assert.deepEqual(or.samples, ['玄幻小说', '仙侠小说', '···']);

  const pct = await probeSelector({ selector: 'li>a@text%%li>a@href', content: HTML, valueMode: true, sampleLimit: 50 });
  assert.deepEqual(pct.samples, ['玄幻小说', '/a1/', '仙侠小说', '/a2/', '···', '/a3/']);
});

/* ------------------------- ② 索引语法 ------------------------- */

test('I-① `[-1]` 取最后一项（默认 split 是「包含」，不是「不过滤」）', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.li[-1]@text'), ['···']);
});

test('I-② `[0:2]` 区间两端都含', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.li[0:2]@text'), ['玄幻小说', '仙侠小说', '···']);
});

test('I-③ `[!0:1]` 排除前两项', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.li[!0:1]@text'), ['···']);
});

test('I-④ `[-1:0]` 让列表反向（旧实现在这里死循环）', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.li[-1:0]@text'), ['···', '仙侠小说', '玄幻小说']);
});

test('I-⑤ `[0:2:2]` 步长', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.li[0:2:2]@text'), ['玄幻小说', '···']);
});

test('I-⑥ 阅读原生写法 `!`（排除）与 `.`（选择）', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.li!1@text'), ['玄幻小说', '···']);
  assert.deepEqual(await makeRule().getStringList('tag.li.1@text'), ['仙侠小说']);
});

test('I-⑦ 属性选择器 `a[href]` 不能被当成索引（否则恒空）', async () => {
  assert.deepEqual(await makeRule().getStringList('tag.a[href]@text'), ['玄幻小说', '仙侠小说', '···']);
  assert.deepEqual(await makeRule().getStringList('[title]@text'), ['···']);
});
