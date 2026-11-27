/**
 * `#445` `getString` 收尾的实体解码 —— **结果是 HTML 标记时必须不做**。
 *
 * ## 真站取证（91 吃瓜正文）
 * `<js>` 段用 `org.jsoup` 的 `el.outerHtml()` 产出片段，属性内引号被**正确**序列化成 `&quot;`；
 * 而收尾**无条件** `unescapeHtml4` 又把它还原成**裸 `"`** ⇒ 下游浏览器把
 * `data-config="{"live":…}"` 的**属性在第一个内层引号处截断**（JSON 取不到、
 * 站点播放器容器渲染不出来）。同一形态会伤到**一切「属性值自带引号」的节点**。
 *
 * 判据：标记形态（`<tag` / `</tag` / `<!--`）⇒ 原样返回（浏览器自己会解码实体）；
 * 其余（标题/简介/URL/数值）⇒ 仍按 Legado `unescapeHtml4` 语义解码。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml } from '../index';

function ruleOn(html: string) {
  const variables = createVariableStore();
  const env = { baseUrl: 'https://x.test/', variables, jsEval: createJsEvaluator({ variables }) };
  // 与 clean-only-rule.test 同款：以「解析出的 root」为内容（字符串内容走文档语义，选择器落到 doc 上）
  return new AnalyzeRule(env).setContent(parseHtml(html, 'https://x.test/').root as never, 'https://x.test/');
}

test('#445 真站形态（91 吃瓜）：`<js>` 产出「属性自带引号」的标记 ⇒ 收尾不得解码', async () => {
  const body = '<html><body><div class="dplayer" data-config="{&quot;video&quot;:{&quot;url&quot;:&quot;https://a.test/x.m3u8?k=v&amp;t=1&quot;,&quot;type&quot;:&quot;hls&quot;}}"></div></body></html>';
  const rule = '<js>var d=org.jsoup.Jsoup.parse(result);d.select(".dplayer").outerHtml();</js>';
  const out = await ruleOn(body).getString(rule);
  assert.match(out, /&quot;video&quot;/, '属性内引号必须仍是实体（否则浏览器解析时属性被截断、JSON 取不到）');
  assert.ok(!out.includes('"video"'), '绝不能出现裸引号包裹的 JSON（属性会在此被浏览器截断）');
  assert.match(out, /x\.m3u8\?k=v&amp;t=1/, '属性里的 `&` 同理保持实体形态');
});

test('#445 HTML 结果：`<js>` 段产出的整段标记同样不解码', async () => {
  const body = '<html><body><p>a&amp;b</p><span data-x="&quot;q&quot;"></span></body></html>';
  const out = await ruleOn(body).getString('<js>var d=org.jsoup.Jsoup.parse(result);d.select("body").outerHtml();</js>');
  assert.match(out, /&quot;q&quot;/, '标记里的实体保持原样');
  assert.match(out, /a&amp;b/, '文本节点里的实体也保持原样（由浏览器解码）');
});

test('#445 对偶：非标记结果（简介/标题）仍按 Legado 语义解码实体', async () => {
  const html = '<div class="intro">标题&lrm;续&nbsp;行</div>';
  const out = await ruleOn(html).getString('.intro@text');
  // `@text` 走 Legado `formatText`（把 nbsp 归一成空格）⇒ 这里只锁「实体被解开」这一件事
  assert.equal(out, '标题\u200E续 行', '纯文本必须解码（51漫画简介 `&lrm;` 那条锁不能回退）');
  assert.ok(!out.includes('&lrm;'));
});

test('#445 对偶：URL 里的 &amp; 仍被解开（Legado 同语义，语料依赖）', async () => {
  const html = '<a href="https://x.test/p?a=1&amp;b=2">go</a>';
  const out = await ruleOn(html).getString('a@href');
  assert.equal(out, 'https://x.test/p?a=1&b=2');
});
