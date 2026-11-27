/**
 * 回归锁 `D11`：**jsoup 元素描述符必须被当成「元素」而不是「JSON 对象」**。
 *
 * ## 缺陷形态（18AV 实测，2026-10-12）
 * `ruleArticles` 是 `<js>… webr.select('.posts>.post') </js>`，返回 **24 个本仓 org.jsoup 仿真的元素描述符**
 * （`{outerHTML, innerHTML, text, attrs}`，见 `selector/jsoup-dom.ts`）。它们**不是 DOM 节点**（无 `nodeType`）
 * ⇒ 旧 `isJsonValue()` 判成「JSON 对象」⇒ 引擎逐条 `setContent(item)` 后求 `ruleTitle='.con a@text'`
 * **恒空** ⇒ 每条都被「title 空白即丢弃」滤掉 ⇒ **列表 0 条**
 * （用户症状：18AV「分类下没有内容卡片」；真页面里 `<div class="posts"><div class="post">` 结构完全正常）。
 *
 * 修法：`isNode` 之外再认一类 `isElementDescriptor`（非节点 + `outerHTML` 非空），
 * 在 `isJsonValue` 里排除、在 `asNodes` 里还原成真 DOM 节点（`outerHTML` 重新 parse）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';

/** 18AV 列表页里的一条 `<div class='post'>`（结构逐字取自真页面） */
const POST_HTML =
  `<div class='post'>` +
  `<a target="_top" href="https://mjv006.com/zh/chinese_content/336505/JUR-710.html">` +
  `<img src='https://fchost1.eemmhh01.com/s/censored/423439_JUR-710.jpg' class='thumb'></a>` +
  `<div class='con'><h3 itemprop='name headline'><a target="_top" href="https://mjv006.com/zh/chinese_content/336505/JUR-710.html">` +
  `[中字]JUR-710 标题文本</a></h3><div class='meta'>2026/10/12</div></div></div>`;

/** 与 L1 `makeElementList` / worker `mkList` 同形的描述符（**没有 nodeType**） */
function descriptor(outerHTML: string): Record<string, unknown> {
  return { outerHTML, innerHTML: outerHTML.replace(/^<[^>]+>|<\/[^>]+>$/g, ''), text: '', attrs: {} };
}

function ruleWith(content: unknown): AnalyzeRule {
  const variables = createVariableStore();
  const env = { baseUrl: 'https://mjv006.com/zh/chinese_list/all/1.html', variables, jsEval: createJsEvaluator({ variables }) };
  return new AnalyzeRule(env).setContent(content as never);
}

test('D11：元素描述符当内容时，CSS 规则（.con a@text）必须取到文本 —— 旧实现走 JSONPath 恒空', async () => {
  const r = ruleWith(descriptor(POST_HTML));
  assert.equal(await r.getString('.con a@text'), '[中字]JUR-710 标题文本', '18AV ruleTitle 的真实形态');
  assert.equal(await r.getString('img@src'), 'https://fchost1.eemmhh01.com/s/censored/423439_JUR-710.jpg');
});

test('D11：描述符数组——逐条 setContent 求字段（引擎逐条取 title 的方式）', async () => {
  const list = [descriptor(POST_HTML), descriptor(POST_HTML.replaceAll('JUR-710', 'JUR-715'))];
  const titles: string[] = [];
  for (const item of list) {
    titles.push(await ruleWith(item).getString('.con a@text'));
  }
  assert.deepEqual(titles, ['[中字]JUR-710 标题文本', '[中字]JUR-715 标题文本'], '24 条不能被滤成 0 条');
});

test('D11 对偶：没有 outerHTML 的普通 JSON 对象仍走 JSONPath（不得被误判成元素）', async () => {
  const r = ruleWith({ data: { title: 'JSON 标题', outerHTMLish: '<div>x</div>' } });
  assert.equal(await r.getString('$.data.title'), 'JSON 标题', 'JSON 分支必须保持原样');
});