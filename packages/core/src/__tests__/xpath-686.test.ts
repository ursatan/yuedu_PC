/**
 * `#686` **XPath 支持边界**（用户问「是否支持完整 XPath / `@//css/` 这类前缀」）。
 *
 * 结论（实测 + 语料通检）：
 * - XPath 走 jsdom 的 `document.evaluate` = **XPath 1.0 完整实现**（谓词、轴、函数、`text()`、`/@attr`、联合 `|`）；
 * - 前缀只认上游那四种：`@css:`（jsoup/CSS，大小写不敏感）· `@xpath:` · `@json:` / `$.` `$[` · 无前缀 = jsoup；
 *   **不存在 `@//css/` 这种写法**（会当普通 jsoup 选择器 ⇒ 0 命中）；
 * - XPath 的 `@` **只有属性轴**一种含义（`/@href`）：写成 jsoup 风格尾缀 `@text` / `@html` 语法错，
 *   本仓额外兼容（超集），见 `splitXpathTail`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { makeProbeEnv } from '../diag/probe';

const HTML =
  '<div data-xpch="episode-grid"><a href="/play/1">第1集</a><a href="/play/2">第2集</a><a href="/play/3">第3集</a></div>'
  + '<div data-xpch="other"><a href="/o/1">别的</a></div>';

const mk = () => {
  const { env } = makeProbeEnv({ content: HTML, baseUrl: 'https://x/', vars: {} } as never);
  return new AnalyzeRule(env).setContent(HTML, 'https://x/');
};

const els = async (rule: string): Promise<number> => {
  const r = (await mk().getElements(rule)) as unknown;
  return Array.isArray(r) ? r.length : r == null ? 0 : 1;
};
const val = async (rule: string): Promise<string> => (await mk().getString(rule)).replace(/\s+/g, ' ').trim();

test('X-① 用户那条（修正谓词后）：`//div[@data-xpch="episode-grid"]/a` 命中 3 个', async () => {
  assert.equal(await els('//div[@data-xpch="episode-grid"]/a'), 3);
  assert.equal(await val('//div[@data-xpch="episode-grid"]/a'), '第1集 第2集 第3集');
});

test('X-② `@xpath:` / `@css:` 前缀与无前缀三种写法结果一致', async () => {
  assert.equal(await val('@xpath://div[@data-xpch="episode-grid"]/a'), '第1集 第2集 第3集');
  assert.equal(await val('@css:div[data-xpch="episode-grid"] a'), '第1集 第2集 第3集');
  assert.equal(await val('div[data-xpch="episode-grid"] a'), '第1集 第2集 第3集');
});

test('X-③ `@//css/…` 不是合法前缀（别指望它生效）', async () => {
  // 上游只认 `@CSS:`；`@//css/` 会被当普通 jsoup 选择器 ⇒ 0 命中
  assert.equal(await val('@//css/div a'), '');
  assert.equal(await els('@//css/div a'), 0);
});

test('X-④ XPath 属性轴 `/@href` 与文本轴 `/text()`：都不能被「尾缀切分」误伤', async () => {
  assert.equal(await val('//div[@data-xpch="episode-grid"]/a/@href'), '/play/1 /play/2 /play/3');
  assert.equal(await val('//div[@data-xpch="episode-grid"]/a/text()'), '第1集 第2集 第3集');
});

test('X-⑤ 严格 XPath：`//…/a@text` 这类 jsoup 尾缀**不兼容**，报错要给改法（`#687` 撤回了 `#686` 的宽容）', async () => {
  /**
   * `#686` 一度把 `@text` / `@html` 尾缀当 jsoup 风格来自动兼容；`#687` 按用户要求撤回：
   * 标准 XPath 只有 `/text()` 与 `/@href`，`@text` 是 CSS/jsoup 侧的语法，串味会让人写错还以为对。
   * 但报错必须能照做 —— 原来只有库原文 `Unparsed tokens: @ text`。
   */
  await assert.rejects(
    () => mk().getString('//div[@data-xpch="episode-grid"]/a@text'),
    /XPath 语法错[\s\S]*\/text\(\)/,
    '要直接告诉用户改成 /text()',
  );
  await assert.rejects(
    () => mk().getString('//div[@data-xpch="episode-grid"]/a@href'),
    /XPath 语法错[\s\S]*\/@href/,
    '属性要告诉用户改成 /@href',
  );
  // 标准写法才行
  assert.equal(await val('//div[@data-xpch="episode-grid"]/a/text()'), '第1集 第2集 第3集');
});

test('X-⑥ XPath 1.0 语义：`//a[1]` 是「每个父节点下的第一个 a」，不是「全局第一个」', async () => {
  assert.equal(await els('//a[1]'), 2, '两个 div 各有一个首个 a');
  assert.equal(await val('//a[1]'), '第1集 别的');
  assert.equal(await val('//a[last()]'), '第3集 别的');
});

test('X-⑦ 写坏的谓词仍给可读报错（`[@//attr/="v"]` 这类笔误）', async () => {
  await assert.rejects(
    () => mk().getString('//div[@//data-xpch/="episode-grid"]/a'),
    /Expected nodeTest|Unparsed tokens/,
    '要带上库给的位置信息，便于定位是第几个字符写错',
  );
});

test('X-⑧ `/a` 是**直接子元素**、`//a` 是**任意后代** —— 用户实测「/a 匹配不到、//a 能匹配」就是这条', async () => {
  /**
   * 用户的选集页结构是「grid 里还套了一层容器再放 a」：
   * `<div data-xpch="episode-grid"><div class="wrap"><a …>…</a></div></div>`
   * 这时 `/a`（直接子）必然是 0，`//a`（后代）才有 —— 这是标准 XPath 语义，不是引擎 bug。
   */
  const nested = '<div data-xpch="episode-grid"><div class="wrap"><a href="/p/1">第1集</a></div></div>';
  const { env } = makeProbeEnv({ content: nested, baseUrl: 'https://x/', vars: {} } as never);
  const a = () => new AnalyzeRule(env).setContent(nested, 'https://x/');
  assert.equal(await a().getString('//div[@data-xpch="episode-grid"]/a'), '', '直接子元素：0');
  assert.equal(await a().getString('//div[@data-xpch="episode-grid"]//a//text()'), '第1集');
  const els = (await a().getElements('//div[@data-xpch="episode-grid"]//a')) as unknown;
  assert.equal(Array.isArray(els) ? els.length : 0, 1);
});
