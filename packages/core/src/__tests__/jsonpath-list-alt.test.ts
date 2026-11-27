/**
 * `#309` JSONPath **列表**规则：`||` 备选链的短路判据 —— 「只有数组才算命中」。
 *
 * ## 缺陷与依据（不猜测）
 * 上游 `AnalyzeByJSonPath.getList`（`AnalyzeByJSonPath.kt:132-137`）用
 * `ctx.read<List<Any>>(rule)`：目标不是数组时 Jayway **抛异常**，catch 后函数落到末尾
 * `return result`（空 ArrayList）。而 `||` 的短路判据是
 * `if (!temp.isNullOrEmpty())`（同文件 :146-151）⇒ 空就不短路 ⇒ 继续试下一个备选。
 *
 * 本仓此前是 `Array.isArray(r) ? r : r == null ? [] : [r]` ⇒ 「命中对象」被包成 1 条
 * ⇒ `||` 在错的备选上短路 ⇒ 真备选永不尝试 ⇒ 元素上再取字段规则必然为空
 * ⇒ 逐条丢弃 ⇒ 列表 0 条。
 *
 * 真实症状（2026-10-07 实测复现）：源「影视聚合(资源站)」（`data/imported-sources.json`）
 * `ruleArticles = "$.data||$.list"`，CMS 响应 `{code:1, data:{…}, list:[20 条]}` ⇒
 * `SELECTOR_MISS@parse · 列表规则解析为 0 条`。
 *
 * ## 防空转（两条对偶）
 * 只证明「`data:{}` 时能落到 `$.list`」是不够的 —— 把 `jsonGetList` 直接改成
 * 「永远返回空」也能让它过。所以同时断言**相反方向**：
 *  ① `data` 是数组 ⇒ 必须取 `data`（不是 `list`，也不是空）；
 *  ② `data` 是对象但规则只有 `$.list` ⇒ 照常取 `list`（没被牵连）。
 * 二者与 ①/② 不落同一分支结果，方向相反。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jsonGetList, jsonGetString, jsonGetStringList } from '../selector/jsonpath';
import { createVariableStore } from '../store';

const env = { variables: createVariableStore() } as never;

test('jsonGetList：`||` 前段命中**对象**（非数组）时视为未命中，落到后段', () => {
  const doc = JSON.stringify({ code: 1, data: {}, list: [{ t: 'A' }, { t: 'B' }] });
  const got = jsonGetList('$.data||$.list', doc, env);
  assert.equal(got.length, 2, '应落到 $.list 取到 2 条（旧实现被 data{} 短路 ⇒ 0 条）');
  assert.deepEqual((got as Array<{ t: string }>).map((x) => x.t), ['A', 'B']);
});

test('jsonGetList【对偶①】`||` 前段是真数组时，必须**取前段**而不是后段/空', () => {
  const doc = JSON.stringify({ code: 1, data: [{ t: 'X' }, { t: 'Y' }, { t: 'Z' }], list: [{ t: 'L' }] });
  const got = jsonGetList('$.data||$.list', doc, env);
  assert.equal(got.length, 3, '真命中数组就该短路在 data 上');
  assert.deepEqual((got as Array<{ t: string }>).map((x) => x.t), ['X', 'Y', 'Z']);
});

test('jsonGetList【对偶②】单段规则 `$.list` 不受影响（对象在别处不牵连）', () => {
  const doc = JSON.stringify({ code: 1, data: { list: [{ t: 'A' }] }, list: [{ t: 'B' }, { t: 'C' }] });
  assert.equal(jsonGetList('$.list', doc, env).length, 2);
  // `$.data` 命中对象 ⇒ 单段规则同样应为空（与上游 read<List> 抛异常同语义）
  assert.equal(jsonGetList('$.data', doc, env).length, 0);
});

test('jsonGetList：`&&`/`%%` 组合不因本次收紧而改变（回归）', () => {
  const doc = JSON.stringify({ a: [{ t: '1' }], b: [{ t: '2' }] });
  assert.equal(jsonGetList('$.a&&$.b', doc, env).length, 2, '&& 取并集');
  assert.equal(jsonGetList('$.a%%$.b', doc, env).length, 2, '%% 取交集（逐条交替）');
});

/* ---------------------------------------------------------------------------
 * `#415` 字符串面同一条纪律：`||` 的短路判据是「首个**非空**备选」。
 *
 * 真源取证（LOFTER `ruleTitle`）：图集帖 `postView.title` 命中**空串**，
 * 真正有正文的是后面的 `postView.digest`。旧实现把「命中空串」当命中并 break
 * ⇒ title 恒空 ⇒ `parseRssByRule` 逐条丢弃 ⇒ `SELECTOR_MISS@parse · 0 条`。
 * ------------------------------------------------------------------------- */

test('#415 jsonGetString：`||` 前段命中**空串**时不是命中，必须落到后段', () => {
  const doc = JSON.stringify({ postData: { postView: { title: '', digest: '<p>正文摘要</p>' } } });
  assert.equal(jsonGetString('$.postData.postView.title', doc, env), '', '单段：命中空串就是空');
  assert.equal(
    jsonGetString('$.postData.postView.title||$.postData.postView.digest', doc, env),
    '<p>正文摘要</p>',
    '旧实现被空串短路 ⇒ 恒空（LOFTER 图集帖全部被丢弃）',
  );
});

test('#415【对偶】前段**非空**时仍短路在前段，且不拼接后段（无前导换行）', () => {
  const doc = JSON.stringify({ a: 'AAAA', b: 'BBBB' });
  assert.equal(jsonGetString('$.a||$.b', doc, env), 'AAAA');
  assert.deepEqual(jsonGetStringList('$.a||$.b', doc, env), ['AAAA'], '|| 只返回胜出备选，不 flat 累积');
});

test('#415【对偶】三备选全空 ⇒ 空串（不得把后段真实值漏掉的反向）', () => {
  const doc = JSON.stringify({ a: '', b: '', c: '第三段' });
  assert.equal(jsonGetString('$.a||$.b||$.c', doc, env), '第三段');
  assert.equal(jsonGetString('$.a||$.b', doc, env), '', '全空就是空，不编造');
});

test('#415【对偶】无 `||` 的单段规则与 `&&`/`%%` 组合不受影响（回归）', () => {
  const doc = JSON.stringify({ a: ['1', '2'], b: ['3'] });
  assert.deepEqual(jsonGetStringList('$.a', doc, env), ['1', '2']);
  assert.equal(jsonGetList('$.a&&$.b', doc, env).length, 3, '&& 取并集');
});
