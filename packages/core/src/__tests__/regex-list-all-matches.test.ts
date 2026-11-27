/**
 * 正则「列表全匹配」回归锁（对齐 Legado `AnalyzeByRegex`）。
 *
 * 上游依据（`f:\legado\...\AnalyzeByRegex.kt`）：
 *  · `getElements`（:39-51）：末级 `do { 收集 group(0..n) } while (resM.find())` ⇒ **每个匹配**一条；
 *  · `getElement`（:16-22）：末级只收集**首个匹配**的 `group(0..n)`；
 *  · 中间级（:24-29 / :52-57）：`do { append(group()) } while (find())` ⇒ 所有整匹配拼接后再进下一级。
 *
 * 此前本仓 `regexGetElements` 只返回 `[首个匹配的组]` ⇒ 正则列表恒 1 条（目录/搜索少条目）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { regexGetElements, regexGetElement, regexGetString } from '../selector/regex';
import type { AnalyzeEnv } from '../selector/types';

const ENV = {} as AnalyzeEnv;

const HTML = '<a href="/1">一</a><a href="/2">二</a><a href="/3">三</a>';
const RULE = 'href="(.*?)"[^>]*>(.*?)</a>';

test('regexGetElements：末级必须返回**每一个**匹配的捕获组（捕获组 0 为整段匹配）', () => {
  const all = regexGetElements(RULE, HTML);
  assert.equal(all.length, 3, `应得 3 条，实得 ${all.length}：${JSON.stringify(all)}`);
  assert.deepEqual(all[0], ['href="/1">一</a>', '/1', '一']);
  assert.deepEqual(all[1], ['href="/2">二</a>', '/2', '二']);
  assert.deepEqual(all[2], ['href="/3">三</a>', '/3', '三']);
});

test('regexGetElement：单值入口只取**首个**匹配（与列表入口分岔）', () => {
  const one = regexGetElement(RULE, HTML);
  assert.equal(one.length, 1, 'getElement 只允许 1 条');
  assert.deepEqual(one[0], ['href="/1">一</a>', '/1', '一']);
});

test('regexGetString：首个匹配的捕获组拼接（getElement 后 toString）', () => {
  assert.equal(regexGetString(RULE, HTML, ENV, false), 'href="/1">一</a>/1一');
});

test('中间级 `&&`：先把所有整匹配拼起来，再交给下一级（列表仍取全部）', () => {
  const text = '<p>第1章</p><p>第2章</p><p>第3章</p>';
  // 第一级把所有 `第n章` 拼成 "第1章第2章第3章"；第二级在拼接结果上取全部数字
  const all = regexGetElements('第(\\d+)章&&(\\d+)', text);
  assert.equal(all.length, 3, `中间级拼接后应匹配到 3 个数字，实得 ${JSON.stringify(all)}`);
  assert.deepEqual(all.map((g) => g[1]), ['1', '2', '3']);
});

test('空匹配不会死循环（Kotlin `find()` 会前进一格，JS `exec` 需要手动前进）', () => {
  const all = regexGetElements('x*', 'bbb');
  assert.equal(all.length, 4, '长度 3 的串上 x* 有 4 个空匹配（位置 0..3），且必须能返回');
});

test('无匹配 ⇒ 空列表（单值/列表一致）', () => {
  assert.deepEqual(regexGetElements('zzz', 'abc'), []);
  assert.deepEqual(regexGetElement('zzz', 'abc'), []);
  assert.equal(regexGetString('zzz', 'abc', ENV, false), '');
});
