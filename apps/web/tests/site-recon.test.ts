/**
 * **站点探查**（`utils/site-recon.ts`）的回归锁 —— 这套流程是「人工逆加密链」的沉淀，
 * 每一段都是一条独立口径，测试逐段锁住，避免以后改正则/改拆分时悄悄失真。
 *
 * 覆盖：内联脚本 & 媒体/iframe 扫描、疑似解码参数、`@js:`/`,{options}` 拆分、
 * 进制 + 异或解码（用真实站点样例自检：108 字符、以 `=` 结尾的标准 base64）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeScripts,
  analyzeAnchors,
  scanGlobals,
  findDecodeParams,
  scanMedia,
  splitHiddenChannel,
  decodeRadixXor,
  resolveUrl,
  isLikelyBase64,
  prettyJson,
  buildReconMarkdown,
} from '../src/utils/site-recon';

/** 一段含 `mvarr['10_1']=[[…]]` 的 HTML：内联脚本 + 外部脚本 + iframe + m3u8 视频 */
const HTML = [
  '<html><head><script src="/static/app.js"></script></head>',
  '<body class="wrap main main">',
  '<div id="player" class="box main">',
  '<iframe src="/play.php?u=abc"></iframe>',
  '<script>',
  'var mvarr={};',
  "mvarr['10_1']=[[1,2],[3,4]];",
  'hcdeedg252=22;',
  'var cfg={"type":"18av"};',
  '</script>',
  '<video><source src="https://cdn.x.com/a/b/2000kb/hls/index.m3u8"></video>',
  '</body></html>',
].join('\n');

const PAGE = 'https://s.example/film/x.html';

test('脚本 · 内联脚本（含 mvarr 特征）与外部 script src 分别识别', () => {
  const s = analyzeScripts(HTML);
  assert.equal(s.external.length, 1);
  assert.equal(s.external[0], '/static/app.js');
  assert.equal(s.inline.length, 1);
  assert.ok(s.inline[0]!.preview.includes("mvarr['10_1']"), '内联预览应包含特征片段');
  assert.ok(s.inline[0]!.length > 0);
});

test('脚本 · 带 src 的空体脚本**不进**内联列表', () => {
  const s = analyzeScripts('<script src="a.js"></script><script>b()</script>');
  assert.deepEqual(s.external, ['a.js']);
  assert.equal(s.inline.length, 1);
});

test('媒体 · iframe / m3u8 / play.php 命中，相对地址按页面 URL 补全', () => {
  const hits = scanMedia(HTML, PAGE);
  const iframe = hits.find((h) => h.kind === 'iframe');
  assert.ok(iframe, '应命中 iframe');
  assert.equal(iframe!.url, 'https://s.example/play.php?u=abc');
  const m3u8 = hits.find((h) => h.kind === 'm3u8');
  assert.ok(m3u8, '应命中 m3u8');
  assert.equal(m3u8!.url, 'https://cdn.x.com/a/b/2000kb/hls/index.m3u8');
  const play = hits.find((h) => h.kind === 'play');
  assert.ok(play, '应命中 play.php');
});

test('媒体 · resolveUrl：blob/data 原样，相对按 base 补全，无 base 原样', () => {
  assert.equal(resolveUrl('blob:https://x/a', PAGE), 'blob:https://x/a');
  assert.equal(resolveUrl('/a/b.m3u8', PAGE), 'https://s.example/a/b.m3u8');
  assert.equal(resolveUrl('./a/b.m3u8', PAGE), 'https://s.example/film/a/b.m3u8');
  assert.equal(resolveUrl('/a/b.m3u8', ''), '/a/b.m3u8');
});

test('全局变量 · 扫 var/let/const 声明（值截断，同名只留首次）', () => {
  const g = scanGlobals(HTML);
  assert.ok(g.some((x) => x.name === 'mvarr'));
  assert.ok(g.some((x) => x.name === 'cfg' && x.value.includes('18av')));
});

test('全局变量 · 疑似解码参数挑出只出现一次的数字赋值 hcdeedg252=22', () => {
  const p = findDecodeParams(HTML);
  assert.deepEqual(p, [{ name: 'hcdeedg252', value: '22' }]);
  // 出现多次的名字不该被当成参数
  assert.ok(!p.some((x) => x.name === 'mvarr'));
});

test('锚点 · class / id 频次（class 按空白切分，取前 N）', () => {
  const a = analyzeAnchors(HTML);
  const main = a.classes.find((c) => c.value === 'main');
  assert.equal(main?.count, 3, 'main 出现 3 次（wrap/main/main + box/main）');
  assert.ok(a.ids.some((c) => c.value === 'player' && c.count === 1));
});

test('隐藏通道 · 拆 @js: 段与 ,{options} 尾巴', () => {
  const h = splitHiddenChannel('https://x.com/play.html@js:\'data:;base64,QUJD\',{"type":"18av"}');
  assert.equal(h.base, 'https://x.com/play.html');
  assert.equal(h.js, "'data:;base64,QUJD'");
  assert.equal(h.optionsRaw, '{"type":"18av"}');
  assert.deepEqual(h.options, { type: '18av' });
  assert.equal(h.optionsOk, true);
});

test('隐藏通道 · 只有 ,{options} 尾巴（无 @js:）', () => {
  const h = splitHiddenChannel('https://x.com/a.html,{"method":"POST","body":"a=1"}');
  assert.equal(h.base, 'https://x.com/a.html');
  assert.equal(h.js, undefined);
  assert.deepEqual(h.options, { method: 'POST', body: 'a=1' });
});

test('隐藏通道 · 纯 URL 无尾巴：base 原样、无 js/options', () => {
  const h = splitHiddenChannel('https://x.com/a.html?v=1');
  assert.equal(h.base, 'https://x.com/a.html?v=1');
  assert.equal(h.js, undefined);
  assert.equal(h.optionsRaw, undefined);
});

test('隐藏通道 · 尾巴 JSON 非法时 optionsOk=false 且给 error', () => {
  const h = splitHiddenChannel('https://x.com/a.html,{not json}');
  assert.equal(h.optionsOk, false);
  assert.ok(h.optionsError);
});

/** 真实站点样例（18AV）：radix=21、xor=12、分隔符 'v' */
const TOKEN =
  '40v2kv2bv3gv61v35v5cv54v3fv44v4hv2bv31v36v4gv2bv4ev47v2iv4cv1iv2fv2gv50v4bv2iv5cv35v4cv4kv30v3ev5gv47v44v32v54v60v39v4hv5gv5iv39v32v5fv5gv44v32v4ev5bv36v5hv41v44v2kv2iv42v5iv1iv30v2bv37v5hv5kv38v4ev32v45v5jv4dv5iv3av5jv4jv5iv61v5hv4hv4ev3bv5dv5gv3av61v2gv4jv3fv4bv5kv49v49v5dv3bv44v5bv4kv4av46v54v33v3bv34v30v5gv5fv35v4fv27';

test('解码链 · 进制+异或：真实样例得到恰好 108 字符、以 = 结尾的 base64', () => {
  const r = decodeRadixXor(TOKEN, 21, 'v', 12);
  assert.equal(r.badParts.length, 0, '所有段都应能按进制 21 解析');
  assert.equal(r.text.length, 108, '必须恰好 108 个字符');
  assert.ok(r.text.endsWith('='), '解码结果应以 = 结尾（base64 填充）');
  assert.ok(isLikelyBase64(r.text), '应是标准 base64');
});

test('解码链 · 进制/分隔符选错时，badParts 暴露「哪一步出错」', () => {
  const r = decodeRadixXor('zz$yy', 21, 'v', 12);
  // 分隔符 'v' 不存在 ⇒ 整串一段；'zz$yy' 在 21 进制下不是合法数（parseInt 只吃掉合法前缀）
  assert.ok(r.error, '应给出错误提示');
  // 用逗号分隔时，'zz' 在 21 进制下非法（z 合法，但…）—— 这里直接验证 badParts 机制生效
  const r2 = decodeRadixXor('40v!!v2k', 21, 'v', 12);
  assert.deepEqual(r2.badParts, ['!!']);
});

test('base64 · isLikelyBase64 判据', () => {
  assert.equal(isLikelyBase64('QUJD'), true);
  assert.equal(isLikelyBase64('QUJDRA=='), true); // 两位填充
  assert.equal(isLikelyBase64('not base64!'), false);
  assert.equal(isLikelyBase64(''), false);
});

test('概览 · prettyJson 美化 JSON；非 JSON 原样', () => {
  assert.deepEqual(prettyJson('{"a":1}'), { isJson: true, pretty: '{\n  "a": 1\n}' });
  assert.equal(prettyJson('<html>').isJson, false);
});

test('结论块 · buildReconMarkdown 汇总各段摘要', () => {
  const s = analyzeScripts(HTML);
  const md = buildReconMarkdown({
    url: PAGE,
    status: 200,
    bytes: 1234,
    contentType: 'text/html',
    scripts: s,
    globals: scanGlobals(HTML),
    decodeParams: findDecodeParams(HTML),
    anchors: analyzeAnchors(HTML),
    media: scanMedia(HTML, PAGE),
    hidden: splitHiddenChannel('https://x.com/a.html@js:1,{"type":"18av"}'),
    finalText: 'ABCD=',
  });
  assert.match(md, /# 站点探查：https:\/\/s\.example\/film\/x\.html/);
  assert.match(md, /HTTP 状态：200/);
  assert.match(md, /hcdeedg252 = 22/);
  assert.match(md, /\[m3u8\] https:\/\/cdn\.x\.com/);
});