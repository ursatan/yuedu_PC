/**
 * `#565` **详情字段的 init 预处理链**（用户实测「🄼黄金屋 -」）。
 *
 * 背景：该源的 `ruleBookInfo.name/author/intro/lastChapter/coverUrl` 全是
 * `@js:JSON.parse(result).x`，而 `result` 是 **init 从详情页 og:meta 挖出来又
 * stringify 的 JSON**（引擎 `BookInfo.kt:58`：`setContent(analyzeRule.getElement(it))`）。
 * 探针此前没有 init 链 ⇒ 这些字段是对着**整页 HTML** 做 `JSON.parse` ⇒ 必抛错
 * ⇒ 用户看到「规则错」的假象（实际规则没错，是少了预处理这一棒）。
 *
 * 本文件锁四件事：
 *  ① init 的结果**替换**后续字段的求值内容（值要真的是 init 挖出来的那个）；
 *  ② 没有 init 链时同一条规则必失败（证明这链不是装饰）；
 *  ③ init 抛错 / 解出空 ⇒ **沿用原内容**（引擎同口径，不报错、不换内容）；
 *  ④ 四个返回分支（string/elements/list/scope）都回显 `initApplied`。
 *
 * ⚠️ init 规则用**真实源的形状**（IIFE：`(function(){…return JSON.stringify(…)})()`）——
 * V8 的 eval 不接受顶层 `return`，Legado 源的 `<js>` 块本来就写成 IIFE。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeField } from '../diag/probe';

/** 黄金屋详情页的最小真实形状（og: meta 命名按实抓保留） */
const HJW_DETAIL = `<!DOCTYPE html><html><head>
<title>《择天记》_黄金屋</title>
<meta property="og:novel:book_name" content="择天记">
<meta property="og:novel:author" content="猫腻">
<meta property="og:novel:category" content="玄幻">
<meta property="og:novel:status" content="连载中">
<meta property="og:novel:latest_chapter_name" content="第一章 国教学院">
<meta property="og:novel:description" content="一段简介">
<meta property="og:image" content="https://www.huangjinwu.org/cover/ztj.jpg">
</head><body><h1 class="book-title">择天记</h1><div id="intro">一段简介</div></body></html>`;

/** 黄金屋 init 的真实形状（挖 og:meta ⇒ stringify；source.put 段略，探针无源上下文） */
const HJW_INIT = `<js>
(function(){
var h=String(result==null?'':result);
var re=/property="(og[^"]*)"\\s+content="([^"]*)"/g,mm,ogm={};
while((mm=re.exec(h))!==null){if(!ogm[mm[1]])ogm[mm[1]]=mm[2]}
function og(k){return ogm['og:novel:'+k]||ogm['og:'+k]||''}
var name=og('book_name'),author=og('author'),cat=og('category'),st=og('status');
var last=og('latest_chapter_name');
var cover=ogm['og:image']||'';
return JSON.stringify({'name':name,'author':author,'kind':cat+(st?'·'+st:''),'coverUrl':cover,'lastChapter':last});
})()
</js>`;

/* ---------------- ① init 链生效：值来自 init，不是整页 ---------------- */

test('I-① name：`@js:JSON.parse(result).name` 在 init 结果上求值（黄金屋实测）', async () => {
  const r = await probeField({
    rule: '@js:JSON.parse(result).name',
    content: HJW_DETAIL,
    field: 'ruleBookInfo.name',
    initRule: HJW_INIT,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value, '择天记');
  assert.equal(r.initApplied, true, '要回显「这次先跑过 init」');
  // init 规则原文回显**截断到 120 字**（防把 55KB jsLib 级的规则整条回灌前端）
  assert.match(r.initRule ?? '', /^<js>/, '回显要是 init 规则的开头');
  assert.equal(r.initRule?.length, 120, '超过 120 字要截断');
});

test('I-② coverUrl：init 里的绝对 URL 原样取出（isUrl 不破坏）', async () => {
  const r = await probeField({
    rule: '@js:JSON.parse(result).coverUrl',
    content: HJW_DETAIL,
    field: 'ruleBookInfo.coverUrl',
    isUrl: true,
    initRule: HJW_INIT,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'https://www.huangjinwu.org/cover/ztj.jpg');
  assert.equal(r.initApplied, true);
});

test('I-③ kind：init 里的拼接字段（cat+st）也照解', async () => {
  const r = await probeField({
    rule: '@js:JSON.parse(result).kind',
    content: HJW_DETAIL,
    field: 'ruleBookInfo.kind',
    initRule: HJW_INIT,
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, '玄幻·连载中');
});

/* ---------------- ② 没有 init 链 ⇒ 同一条规则必失败（证明链的必要性） ---------------- */

test('I-④ 不传 initRule：对整页 HTML 做 JSON.parse ⇒ 抛错（用户看到的「规则错」假象）', async () => {
  const r = await probeField({
    rule: '@js:JSON.parse(result).name',
    content: HJW_DETAIL,
    field: 'ruleBookInfo.name',
  });
  assert.equal(r.ok, false, '没有 init 链，这条规则在整页 HTML 上必然跑不通');
  assert.ok(!r.initApplied, '没传 initRule 就没有 initApplied');
});

/* ---------------- ③ init 抛错 / 空 ⇒ 沿用原内容（引擎同口径） ---------------- */

test('I-⑤ init 抛错 ⇒ 沿用原内容（不报错；字段对着整页求值）', async () => {
  const r = await probeField({
    rule: 'h1@text',
    content: HJW_DETAIL,
    field: 'ruleBookInfo.name',
    initRule: '<js>(function(){ throw new Error("boom") })()</js>',
  });
  assert.equal(r.ok, true, 'init 抛错不能连坐字段试跑');
  assert.equal(r.value, '择天记', '要落在**原页面**的 h1 上');
  assert.ok(!r.initApplied, '没应用 init 就不该回显');
});

test('I-⑥ init 解出空串 ⇒ 不换内容（空 init 等于没有）', async () => {
  const r = await probeField({
    rule: 'h1@text',
    content: HJW_DETAIL,
    field: 'ruleBookInfo.name',
    initRule: '<js>(function(){ return "" })()</js>',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, '择天记');
  assert.ok(!r.initApplied);
});

/* ---------------- ④ 四个分支都回显 initApplied ---------------- */

test('I-⑦ elements 模式：init 产出的 HTML 上匹配', async () => {
  const r = await probeField({
    rule: 'a@text',
    content: '<div>原页面</div>',
    mode: 'elements',
    initRule: '<js>"<a href=\'/b1\'>第一章</a><a href=\'/b2\'>第二章</a>"</js>',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hitCount, 2);
  assert.equal(r.initApplied, true);
});

test('I-⑧ list 模式：init 产出的 JSON 上取列表', async () => {
  const r = await probeField({
    rule: '$.tags[*]',
    content: '<div>原页面</div>',
    mode: 'list',
    initRule: '<js>JSON.stringify({tags:["仙侠","爽文"]})</js>',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.values, ['仙侠', '爽文']);
  assert.equal(r.initApplied, true);
});

test('I-⑨ scope 模式：init 产出的列表页上逐项求值', async () => {
  const r = await probeField({
    rule: '.name@text',
    content: '<div>原页面</div>',
    scopeRule: '.item',
    scopeLimit: 2,
    field: 'ruleSearch.name',
    initRule: '<js>"<div class=\'item\'><span class=\'name\'>甲</span></div><div class=\'item\'><span class=\'name\'>乙</span></div>"</js>',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.values, ['甲', '乙']);
  assert.equal(r.initApplied, true);
});
