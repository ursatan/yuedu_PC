/**
 * 「只有 `##替换##`、没有选择器」的规则 —— 对齐 Legado `AnalyzeRule.kt:343`。
 *
 * Legado：`if (rule.isNotBlank() || sourceRule.replaceRegex.isEmpty())` 才做 mode 求值；
 * 规则体为空且有 replaceRegex 时 **跳过求值**，把当前 result（元素/对象）`toString()` 后过替换正则
 * （`result is List<*>` 走逐项 `item.toString()`，见 `AnalyzeRule.kt:263-271`）。
 *
 * 语料实测（`tmp/probe-clean-census.mts`，484 源）：该形态约 21 处**字段规则**，典型是
 *   `ruleSearch.bookUrl = '##href="//m.qidian.com/chapter/(\\d+)/0/"##{{ho}}/book/$1/###'`
 * 我们此前有两处偏差：① 无条件 dispatch（空规则 → 空串）；② 替换前的 `typeof result === 'string'`
 * 前置条件让**元素/对象类结果静默跳过替换**（66书吧因此 bookUrl 为空 → 详情/目录全空）。
 *
 * `##replace##` 自身的语义（`replaceFirst` 不匹配返 `""`、正则编译失败返 `replacement`）
 * 对齐 `AnalyzeRule.kt:541-557`。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml } from '../index';

const LIST_HTML = `<!doctype html><html><body>
<div class="y-list__content">
  <div class="y-list__item">
    <h2>青葫剑仙</h2>
    <a href="//m.qidian.com/chapter/1034567/0/">详情</a>
  </div>
</div>
</body></html>`;

/** 造一个「以某元素为内容」的 AnalyzeRule（对齐引擎逐条求值字段的方式） */
function ruleOn(html: string, element?: unknown, extraVars: Record<string, string> = {}) {
  const variables = createVariableStore();
  for (const [k, v] of Object.entries(extraVars)) variables.set(k, v);
  const env = { baseUrl: 'https://66shuba.com/', variables, jsEval: createJsEvaluator({ variables }) };
  const dom = parseHtml(html, 'https://66shuba.com/');
  const content = element ?? dom.root;
  return new AnalyzeRule(env).setContent(content as never, 'https://66shuba.com/');
}

const itemOf = (html: string) => parseHtml(html, 'https://66shuba.com/').root.querySelector('div.y-list__item') as Element;

// ⚠️ 语料原文是 `##href="//m.qidian.com/chapter/(\\d+)/0/"##{{ho}}/book/$1/###`，
//    `{{ho}}` 由源自身的脚本绑定（与本条修复无关），这里用字面 host 聚焦「元素 → outerHtml → 替换」机制。
test('无选择器 + 替换：对元素 outerHtml 做替换，取到书号（语料原文 66书吧 bookUrl）', async () => {
  const rule = '##href="//m.qidian.com/chapter/(\\d+)/0/"##https://m.qidian.com/book/$1/###';
  const out = await ruleOn(LIST_HTML, itemOf(LIST_HTML)).getString(rule);
  assert.equal(out, 'https://m.qidian.com/book/1034567/');

  const sync = ruleOn(LIST_HTML, itemOf(LIST_HTML)).syncGetString(rule);
  assert.equal(sync, 'https://m.qidian.com/book/1034567/', '同步路径必须同结果');
});

test('无选择器 + 替换：属性形态（18禁漫辞晨 chapterName）', async () => {
  const html = '<div class="c" data-ct="第12话 剑来">x</div>';
  const el = parseHtml(html, 'https://x.test/').root.querySelector('div.c') as Element;
  const out = await ruleOn(html, el).getString('##data\\-ct\\="(.*?)"##$1###');
  assert.equal(out, '第12话 剑来');
});

test('无选择器 + 替换：字符串内容（正文清洗）不得被 mode 求值干扰', async () => {
  // 正文阶段 content 就是响应体字符串（不是元素）——只有字符串内容才做纯文本替换
  const variables = createVariableStore();
  const env = { baseUrl: 'https://x.test/', variables, jsEval: createJsEvaluator({ variables }) };
  const r = new AnalyzeRule(env).setContent('<p>正文</p>');
  // `##<p>##` 拆成 ['', '<p>', ''] → 两段式**全局**替换（Legado `##match##replace` 替换全部），</p> 保留
  assert.equal(await r.getString('##<p>##'), '正文</p>');
});

test('有选择器 + 替换：两条分支都要走（回归护栏）', async () => {
  const out = await ruleOn(LIST_HTML, itemOf(LIST_HTML)).getString('a@href##/chapter/(\\d+)/0/##$1##');
  assert.equal(out, '1034567');
});

test('replaceFirst 不匹配 → 空串（对齐 AnalyzeRule.kt:553-555）', async () => {
  const out = await ruleOn(LIST_HTML, itemOf(LIST_HTML)).getString('##href="//nowhere.example/(\\d+)"##$1###');
  assert.equal(out, '');
});

test('全局替换（两段 ##）不匹配时保留原文', async () => {
  // `a@href##zzz##` 拆成 ['a@href','zzz'] → replaceRegex='zzz'、replacement='' → 全局替换
  const out = await ruleOn(LIST_HTML, itemOf(LIST_HTML)).getString('a@href##zzz##');
  assert.ok(out.includes('chapter'), `不匹配应保留原文：${out}`);
});
