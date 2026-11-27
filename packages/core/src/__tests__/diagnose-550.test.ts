/**
 * `#550` 失败归因表回归锁（D/E 的判据）。
 *
 * 每条 code 一个正例；另有「结果形状」四例（tocError / 0 条 / 0 章 / 0 段 / CF 页）
 * 与「健康结果不报」的反例 —— 只测正例会退化成「永远报警」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseFailure, DIAGNOSE_CODES } from '../diag/diagnose';

const codeOf = (error: string): string | undefined => diagnoseFailure({ error })?.code;

test('错误字符串 → code 逐条对拍（表里每一行都要能被命中）', () => {
  const cases: Array<[string, string]> = [
    ['SOURCE_DISABLED: source off', 'SOURCE_DISABLED'],
    ['SOURCE_NOT_FOUND', 'SOURCE_INVALID'],
    ['SOURCE_INVALID: bookUrl', 'SOURCE_INVALID'],
    ['JS_TIMEOUT after 10000ms', 'JS_TIMEOUT'],
    ['Malformed arrow function parameter list', 'JS_SYNTAX'],
    ['Invalid or unexpected token', 'JS_SYNTAX'],
    ['SELECTOR_MISS@parse: .item', 'SELECTOR_MISS'],
    ['EMPTY_CONTENT', 'EMPTY_CONTENT'],
    ['HTTP 403', 'HTTP_403'],
    ['request failed: 403 Forbidden', 'HTTP_403'],
    ['HTTP 429 Too Many Requests', 'HTTP_429'],
    ['fetch failed: ENOTFOUND', 'NETWORK'],
    // `#688` 规则 JS 的类型用错 ≠ 引擎缺口：橙果短剧正文规则在**取元素路径**下 result 是元素集合
    ['result.match is not a function', 'JS_RUNTIME'],
    ["Cannot read properties of undefined (reading 'text')", 'JS_RUNTIME'],
    // 引擎真缺 API 时仍归 UNSUPPORTED（新规则只认 `result.xxx`，不认别的对象）
    ['doc.selectFirst is not a function', 'UNSUPPORTED'],
  ];
  for (const [err, want] of cases) assert.equal(codeOf(err), want, `${err} 应归到 ${want}`);
  // 表自洽：DIAGNOSE_CODES 每项都有正例
  const hit = new Set(cases.map(([, c]) => c));
  for (const c of DIAGNOSE_CODES) assert.ok(hit.has(c), `${c} 缺正例`);
});

test('结果形状归因：tocError / 0 条 / 0 章 / 0 段 / CF 页 / 无内容', () => {
  const toc = diagnoseFailure({ result: { tocError: 'SELECTOR_MISS@parse' } });
  assert.equal(toc?.code, 'SELECTOR_MISS');
  assert.ok(toc?.title.startsWith('目录失败'), `tocError 要带目录前缀：${toc?.title}`);
  assert.ok((toc?.next[0] ?? '').includes('目录'), 'tocError 的第一步应是「先修目录」');

  assert.equal(diagnoseFailure({ result: { items: [] } })?.code, 'SEARCH_EMPTY');
  assert.equal(diagnoseFailure({ result: { chapters: [] } })?.code, 'TOC_EMPTY');
  assert.equal(diagnoseFailure({ result: { paragraphs: [] } })?.code, 'CONTENT_EMPTY');
  assert.equal(diagnoseFailure({ result: { content: '<title>Just a moment...</title>' } })?.code, 'CF_PAGE');
  assert.equal(diagnoseFailure({ result: { error: 'HTTP 403' } })?.code, 'HTTP_403');
});

test('反例：健康结果 / 空输入不报（防「永远报警」）', () => {
  assert.equal(diagnoseFailure({ result: { items: [{ name: 'A' }], chapters: [{ title: '第1章' }], paragraphs: [{ text: '正文' }] } }), null);
  assert.equal(diagnoseFailure({ result: { content: '<p>正常正文</p>' } }), null);
  assert.equal(diagnoseFailure({}), null);
  assert.equal(diagnoseFailure({ error: '' }), null);
});

test('未知错误给兜底（不吞掉），且明确要 trace', () => {
  const d = diagnoseFailure({ error: 'something weird happened' });
  assert.equal(d?.code, 'UNKNOWN');
  assert.ok((d?.next.join(' ') ?? '').includes('trace'));
});
