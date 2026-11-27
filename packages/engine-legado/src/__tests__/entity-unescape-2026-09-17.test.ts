/**
 * 回归锁：HTML 分发源包的实体还原（2026-09-17）。
 *
 * 实测依据（松鹤庭沐·言璃版）：`exploreUrl` 以 `&lt;js&gt;` 开头时，
 * 引擎不把它当内联脚本 → 把整段脚本文本当 URL 请求（`https://so.html5.qq.com/&lt;js&gt;var%20U=…`）
 * → 分类条 0 项。还原后：**121 分类 + 点击分类 20 条内容**。
 *
 * 同时锁定「必须窄」：jsLib / ruleContent 不得还原（前者把 `&quot;` 变成引号会破坏 JS 字符串，
 * 后者可能故意用实体本身做正则匹配）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileBookSource } from '../model/book-source';

function compile(over: Record<string, unknown>) {
  const out = compileBookSource({
    bookSourceUrl: 'https://e.test/',
    bookSourceName: '实体还原测试源',
    bookSourceType: 0,
    searchUrl: 'https://e.test/s?q={{key}}',
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule as unknown as Record<string, unknown>;
}

test('exploreUrl 的 &lt;js&gt; 必须还原为 <js>（否则分类条恒空且会去请求脚本文本）', () => {
  const rule = compile({ exploreUrl: '&lt;js&gt;\nJSON.stringify([{title:"男频",url:"https://e.test/l?g=1&amp;page={{page}}"}]);' });
  const ex = String(rule['exploreUrl']);
  assert.ok(ex.startsWith('<js>'), `应以 <js> 开头：${ex.slice(0, 30)}`);
  assert.ok(ex.includes('&page='), `URL 里的 &amp; 应还原：${ex.slice(0, 120)}`);
  assert.ok(!ex.includes('&lt;'), '不得残留 &lt;');
});

test('ruleExplore / ruleBookInfo 等规则字段也要还原', () => {
  const rule = compile({
    ruleBookInfo: { name: 'h1@text', intro: '&lt;br&gt;简介' },
    ruleExplore: { bookList: '.x', name: 'a@text' },
  });
  const info = rule['ruleBookInfo'] as Record<string, string>;
  assert.equal(info['intro'], '<br>简介', '实体应还原');
});

test('jsLib 与 ruleContent 不得还原（防止破坏 JS 字符串与「匹配实体」的正则）', () => {
  const rule = compile({
    jsLib: 'var s = "a&quot;b"; var n = 1 &lt; 2;',
    ruleContent: { content: '@css:.c@html@js:result.replace(/&amp;/g,"&")' },
  });
  assert.ok(String(rule['jsLib']).includes('&quot;'), `jsLib 不得还原：${String(rule['jsLib'])}`);
  assert.ok(String(rule['jsLib']).includes('&lt;'), 'jsLib 不得还原');
  const content = (rule['ruleContent'] as Record<string, string>)['content'] ?? '';
  assert.ok(content.includes('/&amp;/g'), `ruleContent 的正则不得被改坏：${content}`);
});
