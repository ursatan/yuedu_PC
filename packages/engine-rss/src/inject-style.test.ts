/**
 * `#308` 源 `style` 注入 —— `injectSourceStyle` 的回归锁。
 *
 * ## 依据（上游逐行核实）
 * `ReadRssViewModel.clHtml`（`ReadRssViewModel.kt:258-287`）里的样式注入分支；
 * 调用点 `ReadRssActivity.kt:406`：`viewModel.clHtml(content, rssSource?.style)`
 * —— **只有正文内容这条 LiveData 注入**（`urlLiveData` 走 `loadUrl`、`htmlLiveData` 是 startHtml，
 * 两条都不注入），所以本仓只在 `content()` 的三个出口调用它。
 *
 * ## 为什么值得锁
 * 语料 **15 个 rss 源**靠它（`tmp/scan-style.txt`），含用户报的 `24凸凹吧`(737 字符) 与
 * `影视聚合(资源站)`(510 字符) —— 注入位置错一点，表现是「正文出来了但版式全丢」，
 * 这种缺陷肉眼很难归因（看起来像站点变了）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { injectSourceStyle } from './engine';

test('已有 `</style>` ⇒ 插在**第一个** `</style>` 之后（上游 indexOf 语义，不是最后一个）', () => {
  const html = '<html><head><style>a{color:red}</style></head><body>x</body></html>';
  const out = injectSourceStyle(html, 'b{color:blue}');
  assert.equal(out, '<html><head><style>a{color:red}</style><style>b{color:blue}</style></head><body>x</body></html>');
});

test('多个 `</style>` ⇒ 只认第一个（第二个必须在它之后）', () => {
  const html = '<head><style>1</style><style>2</style></head>';
  const out = injectSourceStyle(html, 'NEW');
  const iNew = out.indexOf('<style>NEW</style>');
  const iFirst = out.indexOf('</style>');
  const iSecond = out.indexOf('</style>', iFirst + 8);
  assert.ok(iNew > iFirst && iNew < iSecond, `注入点必须落在两个 </style> 之间：${out}`);
});

test('没有 `</style>` 但有 `</head>` ⇒ 插在 `</head>` 之前', () => {
  const html = '<html><head><title>t</title></head><body>x</body></html>';
  const out = injectSourceStyle(html, 'p{margin:0}');
  assert.equal(out, '<html><head><title>t</title><style>p{margin:0}</style></head><body>x</body></html>');
});

test('既无 `</style>` 也无 `</head>`（片段形态）⇒ 插到最前面', () => {
  const out = injectSourceStyle('<div class="player">播放器</div>', 'video{width:100%}');
  assert.equal(out, '<style>video{width:100%}</style><div class="player">播放器</div>');
});

test('style 为空/纯空白 ⇒ 原样返回（不做任何插入）', () => {
  const html = '<head><style>a</style></head>';
  assert.equal(injectSourceStyle(html, ''), html);
  assert.equal(injectSourceStyle(html, '   '), html);
  assert.equal(injectSourceStyle(html, undefined), html);
});

test('【有意偏离上游】style 值**自带** `<style>` 标签时不再包一层（否则整段 CSS 失效）', () => {
  // 语料实证：「饭团动漫」的 style 值就是 `<style>\n.ad-warning {…`（源包打包时写进了值里）
  const html = '<html><head></head><body>x</body></html>';
  const out = injectSourceStyle(html, '<style>\n.ad-warning{color:red}\n</style>');
  assert.ok(!out.includes('<style><style>'), `不能出现嵌套 <style>：${out}`);
  assert.ok(out.includes('.ad-warning{color:red}'), 'CSS 本身要保留');
  // 对偶：不自带标签的值**必须**被包一层 —— 证明上面不是「一律不包」
  const out2 = injectSourceStyle(html, '.ad-warning{color:red}');
  assert.ok(out2.includes('<style>.ad-warning{color:red}</style>'), `普通值必须被包：${out2}`);
});

test('注入的样式必须落在「用户内容里已有样式」的**后面**（同权重时后者生效）', () => {
  const out = injectSourceStyle('<head><style>img{width:10px}</style></head>', 'img{width:100%}');
  assert.ok(out.indexOf('img{width:10px}') < out.indexOf('img{width:100%}'), '源样式要能覆盖内容里的默认样式');
});
