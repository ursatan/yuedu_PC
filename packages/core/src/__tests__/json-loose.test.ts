/**
 * 宽松 JSON 解析回归（2026-09-16）
 *
 * 背景：源规则里的 `,{...}` 选项 / `header` 普遍是手写 JSON。旧实现用
 * `eval('(' + s + ')')` 兜底 → JS 会**吃掉未知转义的反斜杠**，`\d` 变 `d`，
 * 正则 `/(\d+)/` 静默退化成 `/(d+)/`（实测把悦读小说的 POST body 变成 `bookId=d`
 * → 站点返回 `[]` → 目录 0 章）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLoose, parseJsonLooseObject } from '../json-loose';
import { URL_PREP_SOURCE, splitUrlOptions } from '../net/url-prep';

/** 用 String.raw 写出「文件里真实存在的文本」（`\d` 是两个字符：反斜杠 + d） */
const YUEDU_OPTS = String.raw`{"method": "POST","body": "bookId={{baseUrl.match(/(\d+)/)[1]}}"}`;

test('parseJsonLoose: 非法转义 \\d 必须保留反斜杠（悦读小说 body 用例）', () => {
  const o = parseJsonLooseObject(YUEDU_OPTS);
  assert.ok(o, '应解析成功');
  assert.equal(o!.method, 'POST');
  const body = String(o!.body);
  assert.ok(body.includes('\\d'), `反斜杠被吃掉：${body}`);
  assert.equal(body, String.raw`bookId={{baseUrl.match(/(\d+)/)[1]}}`);
});

test('parseJsonLoose: 标准 JSON 走快路径，标准转义语义不变', () => {
  assert.deepEqual(parseJsonLoose('{"a":"x\\ny"}'), { a: 'x\ny' });
  assert.deepEqual(parseJsonLoose('{"a":1,"b":[true,null]}'), { a: 1, b: [true, null] });
});

test('parseJsonLoose: 无引号键值 / 单引号 / 尾逗号 / 注释 / 值里含冒号', () => {
  assert.deepEqual(parseJsonLoose('{comic_id:$..comic_id}'), { comic_id: '$..comic_id' });
  assert.deepEqual(parseJsonLoose("{u:'a.0@href'}"), { u: 'a.0@href' });
  assert.deepEqual(parseJsonLoose('{ a: 1, b: "2", }'), { a: 1, b: '2' });
  assert.deepEqual(parseJsonLoose('{ // c\n a: 1 }'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{u:http://x/y?a=1}'), { u: 'http://x/y?a=1' });
});

test('parseJsonLoose: 非对象 / 非法输入 → undefined', () => {
  assert.equal(parseJsonLooseObject('[1,2]'), undefined);
  assert.equal(parseJsonLooseObject('not json'), undefined);
  assert.equal(parseJsonLooseObject(''), undefined);
});

test('注入源码里的 __yueduFixEscapes 与宿主实现同语义', () => {
  const fn = new Function(`${URL_PREP_SOURCE}; return __yueduFixEscapes;`)() as (s: string) => string;
  const fixed = fn(YUEDU_OPTS);
  assert.ok(fixed.includes('\\d'), `反斜杠被吃掉：${fixed}`);
  // 修完仍是「非法 JSON 转义」（\d 在 JSON 里不合法）→ 由宽松解析器接手，且反斜杠要保住
  assert.equal(String(parseJsonLooseObject(fixed)!.body), String.raw`bookId={{baseUrl.match(/(\d+)/)[1]}}`);
  // 标准转义保持原样（不重复转义）
  assert.equal(fn('{"a":"x\\ny"}'), '{"a":"x\\ny"}');
});

test('splitUrlOptions: URL 尾部的 ,{options} 也要保住反斜杠（宿主路径）', () => {
  const r = splitUrlOptions(String.raw`https://a.test/x,{"method":"POST","body":"b={{m.match(/(\d+)/)[1]}}"}`);
  assert.equal(r.url, 'https://a.test/x');
  assert.equal(r.option?.method, 'POST');
  assert.ok(String(r.option?.body).includes('\\d'), `反斜杠被吃掉：${String(r.option?.body)}`);
  // 标准 JSON 尾仍走快路径
  assert.deepEqual(splitUrlOptions('https://a.test/x,{"method":"POST"}').option, { method: 'POST' });
});
