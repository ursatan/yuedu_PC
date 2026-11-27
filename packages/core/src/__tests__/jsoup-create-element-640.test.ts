/**
 * `#640` `new org.jsoup.nodes.Element(tag)` + `appendChild`（源里「拼卡片」套路）。
 *
 * ## 现场（用户实测「刺猬书库 RULE_PARSE@parse · Cannot read properties of undefined
 * (reading 'Element')」）
 * 该源 jsLib 的 `mkCard()` 用 jsoup 的 **DOM 构造 API** 拼卡片：
 * ```js
 * var div = new org.jsoup.nodes.Element('div');
 * var h3  = new org.jsoup.nodes.Element('h3');
 * h3.appendChild(a); div.appendChild(h3);
 * return div;                       // ← 返回元素，交给 new org.jsoup.select.Elements().add()
 * ```
 * 子规则则是相对卡片的 CSS：`name: h3 a@text` / `coverUrl: img@src`。
 *
 * 三处缺口（任缺其一都是「0 条」或整条规则崩）：
 *  1. `org.jsoup.nodes` 在桩里是 undefined ⇒ 读 `.Element` 直接抛错（用户看到的那条）；
 *  2. 元素上没有 `appendChild` ⇒ 卡片永远是空壳；
 *  3. `outerHTML` 存的是**创建时快照** ⇒ 引擎把节点还原成 DOM 时拿到 `<div></div>`
 *     ⇒ 子规则全空（这条最隐蔽：不报错、只是列表 0 条）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createJsEvaluator, createVariableStore } from '../index';

function ev(lib = '') {
  const variables = createVariableStore();
  return createJsEvaluator({ variables, lib } as never) as unknown as (
    code: string,
    bindings: Record<string, unknown>,
  ) => Promise<unknown>;
}

test('#640 `new org.jsoup.nodes.Element(tag)` 可用，且 appendChild 后 outerHTML 是实时值', async () => {
  const out = await ev()(
    `(function(){
      var div = new org.jsoup.nodes.Element('div');
      var h3 = new org.jsoup.nodes.Element('h3');
      var a = new org.jsoup.nodes.Element('a');
      a.attr('href', '/b/1'); a.text('书名甲');
      h3.appendChild(a); div.appendChild(h3);
      var before = div.outerHTML;
      var im = new org.jsoup.nodes.Element('img'); im.attr('src', 'http://x/1.jpg');
      div.appendChild(im);
      return JSON.stringify({ before: before, after: div.outerHTML, s: String(div) });
    })()`,
    {},
  );
  const r = JSON.parse(String(out)) as { before: string; after: string; s: string };
  assert.match(r.before, /<h3><a href="\/b\/1">书名甲<\/a><\/h3>/, `before=${r.before}`);
  assert.match(r.after, /<img src="http:\/\/x\/1\.jpg">/, `after=${r.after}`);
  assert.notEqual(r.before, r.after, 'outerHTML 必须是实时读（appendChild 之后要看得到新子节点）');
  assert.equal(r.after, r.s, 'toString() 与 outerHTML 同源');
});

test('#640 卡片元素的 CSS 子规则能取到内容（模拟 bookList 返回元素数组后的取值）', async () => {
  // 直接把「JS 造出来的卡片」交给 AnalyzeRule：与引擎 asNodes → descriptorToNode → cssGetString 同路径
  const out = await ev()(
    `(function(){
      var div = new org.jsoup.nodes.Element('div');
      var h3 = new org.jsoup.nodes.Element('h3');
      var a = new org.jsoup.nodes.Element('a');
      a.attr('href', '/b/2'); a.text('书名乙');
      h3.appendChild(a); div.appendChild(h3);
      return div;
    })()`,
    {},
  );
  assert.equal(typeof out, 'object');
  const { AnalyzeRule } = await import('../index');
  const variables = createVariableStore();
  // 与引擎同一路径：把 item（卡片元素）设成内容，再按相对 CSS 取值
  const rule = new AnalyzeRule({ baseUrl: 'https://x.test/', variables, jsEval: ev() } as never).setContent(
    out as never,
    'https://x.test/',
  );
  const name = await rule.getString('h3 a@text');
  assert.equal(name, '书名乙', 'appendChild 造出来的子节点必须能被相对 CSS 选到');
  // 绝对化由引擎注入的 `env.toAbsolute` 负责（本用例只验「造出来的子节点能被选到」）
  const href = await rule.getString('h3 a@href');
  assert.equal(href, '/b/2');
});
