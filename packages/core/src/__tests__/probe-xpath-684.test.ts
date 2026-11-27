/**
 * `#684` **物料源码查看器要能吃下所有规则类型**（用户实测报障）。
 *
 * 用户给的规则：`//div[@data-xpch="card-list"]//article`，在查看器里「匹配失败」。
 * 真因**不在 XPath**（`AnalyzeRule` 直跑能出 2 条），而是探针的「值模式」用
 * `lastIndexOf('@')` 切末段取值 —— 切进了 **XPath 谓词** `[@data-xpch="…"]` 里：
 *
 * ```
 * head = '//div['                                   ← 非法 XPath ⇒ 抛异常
 * tail = 'data-xpch="card-list"]//article'
 * ```
 *
 * 同一类问题在 CSS 属性选择器上也存在：`.item[href="/x"] a@text`。
 * 修法：只在**括号外**找 `@`；另外把 XPath 的两种取值尾段（`/text()`、`/@attr`）也认出来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeSelector } from '../diag/probe';

const HTML =
  '<div data-xpch="card-list" class="grid">'
  + '<article data-xpch="card-drama"><h3>高三爱情故事</h3>'
  + '<a href="/drama/dj-1" data-xpch="btn">详情</a></article>'
  + '<article data-xpch="card-drama"><h3>交换游戏</h3>'
  + '<a href="/drama/dj-2" data-xpch="btn">详情</a></article>'
  + '</div>';

const probe = async (selector: string, content = HTML): Promise<{ hits: number; first: string; err: string }> => {
  const r = await probeSelector({ selector, content, valueMode: true, sampleLimit: 5, sampleMax: 400 });
  return { hits: r.hitCount, first: String(r.samples[0] ?? ''), err: String(r.error ?? '') };
};

test('X-① 带谓词的 XPath（`//div[@a="b"]//article`）不再报「探针失败」', async () => {
  const p = await probe('//div[@data-xpch="card-list"]//article');
  assert.equal(p.err, '', `不该有错误，实际：${p.err}`);
  assert.equal(p.hits, 2);
  assert.match(p.first, /^<article /);
});

test('X-② 单双引号谓词、`/article` 子级、`@css:` 前缀都一致', async () => {
  for (const sel of [
    "//div[@data-xpch='card-list']/article",
    '//div[@data-xpch="card-list"]/article',
    '@css:div[data-xpch="card-list"] article',
    'div[data-xpch="card-list"] article',
  ]) {
    const p = await probe(sel);
    assert.equal(p.hits, 2, `${sel} 应命中 2 条（err=${p.err}）`);
  }
});

test('X-③ XPath 取值尾段：`/text()` 与 `/@attr` 要回值，不是 0 命中', async () => {
  const text = await probe('//article//h3/text()');
  assert.equal(text.hits, 2, `err=${text.err}`);
  assert.equal(text.first, '高三爱情故事');

  const attr = await probe('//article/@data-xpch');
  assert.equal(attr.hits, 2, `err=${attr.err}`);
  assert.equal(attr.first, 'card-drama');
});

test('X-④ CSS 属性选择器里的 `@` 也不能被当取值分隔符', async () => {
  const content = '<div class="item"><a href="/x" title="甲乙">书名</a></div>';
  // 属性选择器内含 `@`，末段的 `@text` 才是取值
  const p = await probe('.item a[href="/x"]@text', content);
  assert.equal(p.err, '', `err=${p.err}`);
  assert.equal(p.hits, 1);
  assert.equal(p.first, '书名');
});

test('X-⑤ 纯 jsoup 选择器、JS 规则、JSON 规则都还能用（不要让上面两处修法打坏别的模式）', async () => {
  assert.equal((await probe('article')).hits, 2, 'jsoup 选择器');
  // JS 规则返回的是「一个值」（脚本计算结果），不是元素个数 ⇒ 看值本身
  const js = await probe('@js:result.split("<article").length-1');
  assert.deepEqual([js.hits, js.first], [1, '2'], `JS 规则应回值 2，实际 ${JSON.stringify(js)}`);
  const json = await probe('$.data[*].name', '{"data":[{"name":"A"},{"name":"B"}]}');
  assert.deepEqual([json.hits, json.first], [2, 'A'], 'JSON 规则');
});

test('X-⑥ 用户原文那种**写坏**的谓词：不许崩、也不许说「未识别的错误」', async () => {
  /**
   * 用户贴的是 `//div[@//data-xpch/="card-list"]//article`（谓词里多写了 `//` 与 `/`）。
   * 这是**规则本身**的笔误，能一眼改；旧实现落到 `UNKNOWN`「未识别的错误」，
   * 等于让用户去翻 trace（`xpath` 库抛的是 `Position 10: Expected nodeTest after axisSpecifier attribute`，
   * 旧正则匹配不到）。
   */
  const r = await probeSelector({ selector: '//div[@//data-xpch/="card-list"]//article', content: HTML, valueMode: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SELECTOR_MISS', `应归到「选择器本身不成立」，实际 ${r.code}`);
  assert.match(String(r.error), /选择器本身不成立/, `错误标题要能直接看懂：${r.error}`);
  assert.match(String(r.error), /Position 10|nodeTest/, '要把库的原始位置信息带上（便于定位是第几个字符）');
});

test('X-⑦ 切分产物求值失败时，退回引擎整条求值（别把整次探针判死）', async () => {
  /**
   * 值模式按文本切 `head@tail` 只是启发式：head 非法时旧实现直接抛 ⇒ 外层 catch 判「探针失败」。
   * 现在 head 抛错就退回 `getStringList(整条)`——那才是规则的真实语义。
   * `:has()` 是我们支持的伪类，这里用它证明「切分成功时仍走逐项取值」（不误退回）。
   */
  const ok = await probeSelector({
    selector: 'div[data-xpch="card-list"]:has(article) article@data-xpch',
    content: HTML,
    valueMode: true,
    sampleLimit: 5,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.samples, ['card-drama', 'card-drama']);
});

