/**
 * `#640` **XPath 前导 `//` 必须相对求值**（对齐上游 JsoupXpath `JXNode.sel`）。
 *
 * ## 现场（用户实测「八叉书库 列表标题全串在一起」）
 * 该源条目规则是
 * `bookList: //div[@class="one-row"]/div[@class="col-md-3 …"]` +
 * `name: //div[@class='caption']/a/@title`
 * 列表确实拿到 20 个条目，但**每一项的标题都是整页 20 个标题用 `\n` 拼起来的一长串**
 * （作者 / 最后章节同款）。
 *
 * ## 根因
 * 我们用 `document.evaluate(rule, root, …)`，按 DOM XPath 1.0 规范**前导 `//` 是绝对路径**
 * （从文档根开始，context node 不参与）⇒ 每个条目都拿到全文档的 caption。
 * 上游是 `jxNode.sel(xPath)`（JsoupXpath），从**该节点**出发 ⇒ 只拿条目内部的 caption。
 *
 * ## 判据
 *  · 首层规则（root = 文档/根元素）：`//x` 与 `.//x` 结果**必须一致**（加 `.` 不能改变首层行为）；
 *  · 条目内子规则：`//x` 只能命中**本条目**内部；
 *  · 相对路径 / 绝对路径（`/html`）不得被改写。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHtml } from '../index';
import { xpathGetElements, xpathGetString, xpathGetStringList } from '../selector/xpath';

const HTML = `<html><body>
  <div class="list">
    <div class="item"><div class="cap"><a title="书A" href="/a"><h2>A</h2></a><span>作者A</span></div></div>
    <div class="item"><div class="cap"><a title="书B" href="/b"><h2>B</h2></a><span>作者B</span></div></div>
  </div>
</body></html>`;

function root(): Element {
  return (parseHtml as unknown as (h: string, u: string) => { root: Element })(HTML, 'https://x.test/').root;
}

test('#640 条目内 `//` 子规则只命中本条目（不得把整页同名节点拼进来）', () => {
  const items = xpathGetElements('//div[@class="item"]', [root()], {} as never);
  assert.equal(items.length, 2, 'bookList 首层仍要拿到 2 个条目');
  const titles = items.map((it) => xpathGetString('//div[@class="cap"]/a/@title', [it], {} as never));
  assert.deepEqual(titles, ['书A', '书B'], `条目字段被整页数据污染：${JSON.stringify(titles)}`);
  const authors = items.map((it) => xpathGetString('//span/text()', [it], {} as never));
  assert.deepEqual(authors, ['作者A', '作者B']);
});

test('#640 首层规则加 `.` 前后结果一致（零行为变化）', () => {
  const a = xpathGetStringList('//div[@class="item"]', [root()], {} as never);
  const b = xpathGetStringList('.//div[@class="item"]', [root()], {} as never);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b, '首层 `//x` 与 `.//x` 在根节点上必须等价');
});

test('#640 相对 / 绝对路径不受改写影响', () => {
  const r = root(); // `parseHtml(...).root` 是 `<html>` 元素（nodeType=1）
  assert.equal(xpathGetString('./body/div[@class="list"]/div[1]//a/@title', [r], {} as never), '书A');
  assert.equal(xpathGetString('/html/body/div/div[1]//a/@title', [r], {} as never), '书A');
});
