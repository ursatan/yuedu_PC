/**
 * 「未闭合括号」扫描器（`#162`）回归锁。
 *
 * 这个函数的**误报比漏报更糟**：规则字段动辄上百字符，一旦字符串或正则里的括号被当成真括号，
 * 用户会看到一屏红点，然后**学会忽略这个提示** —— 提示就等于没了。
 * 所以本文件里**一半以上的用例是「不该报」**（字符串 / 行注释 / 块注释 / 正则 / 模板串）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findUnclosedBrackets } from '../src/utils/codemirror-lint';

const msgs = (s: string) => findUnclosedBrackets(s).map((d) => d.message);

test('① 平衡的文本一律不报', () => {
  assert.deepEqual(findUnclosedBrackets('a(b[c]{d})'), []);
  assert.deepEqual(findUnclosedBrackets(''), []);
  assert.deepEqual(findUnclosedBrackets('@js: if (a) { return [1, 2]; }'), []);
  // 真实的 Legado 规则片段（含两级嵌套）
  assert.deepEqual(findUnclosedBrackets("@js:\nvar u = String(book.tocUrl);\nvar m = u.match(/id=(\\d+)/);\nJSON.stringify({ id: m ? m[1] : '' });"), []);
});

test('② 未闭合的开括号：报在**它的位置**上', () => {
  const d = findUnclosedBrackets('@js: if (a) {');
  assert.equal(d.length, 1);
  assert.equal(d[0]!.message, '括号「{」没有闭合');
  assert.equal('@js: if (a) {'.slice(d[0]!.from, d[0]!.to), '{', 'from/to 必须精确指向那个括号');
});

test('③ 多余的闭括号：**有几个报几个**（不合并成一个）', () => {
  // ⚠️ 第一版我把这里写成只报一条 —— 是想错了：`a))` 确实是**两个**多余括号，
  //    合并成一个反而让用户不知道该删哪一个。
  assert.deepEqual(msgs('a)'), ['多余的闭合括号「)」']);
  assert.deepEqual(msgs('a))'), ['多余的闭合括号「)」', '多余的闭合括号「)」']);
});

test('④ 类型不匹配：**每一处不匹配各报一条**，且不会级联出一屏', () => {
  // `a([)]`：`)` 与栈顶 `[` 不匹配 ⇒ 报 `[` 并出栈；`]` 与新的栈顶 `(` 不匹配 ⇒ 报 `(`。
  // 两条 vs 一屏红：长度与「不匹配的点数」成正比（这里是 2 个点），不是与嵌套深度成正比。
  const d = findUnclosedBrackets('a([)]');
  assert.deepEqual(d.map((x) => x.message), ['括号「[」没有闭合', '括号「(」没有闭合']);
  assert.ok(d.length <= 2, '不能级联（这不是 3 条以上）');
});

test('⑤ 防空转：字符串 / 注释 / 正则 / 模板串里的括号**不该报**', () => {
  assert.deepEqual(msgs('"("'), [], '双引号字符串里的括号');
  assert.deepEqual(msgs("'['"), [], '单引号字符串里的括号');
  assert.deepEqual(msgs('`{`'), [], '模板串里的括号');
  assert.deepEqual(msgs('// (\n'), [], '行注释里的括号');
  assert.deepEqual(msgs('/* ( [ { */'), [], '块注释里的括号');
  assert.deepEqual(msgs('var re = /\\(/;'), [], '正则里的括号（靠「上一个有效字符」启发式识别）');
  assert.deepEqual(msgs('a.replace(/\\)/g, ")")'), [], '正则 + 字符串混在一起');
});

test('⑥ 字符串里的转义不会把扫描带偏', () => {
  // `"\\"` 是一个「转义的反斜杠」结尾的字符串 ⇒ 后面那个 ( 是**括号**，必须报
  const d = findUnclosedBrackets('var s = "\\\\";\nfoo(');
  assert.equal(d.length, 1);
  assert.equal(d[0]!.message, '括号「(」没有闭合');
});

test('⑦ 消息里带的是**开**括号的字符（用户要照着改的是那一个）', () => {
  assert.deepEqual(msgs('{[('), ['括号「{」没有闭合', '括号「[」没有闭合', '括号「(」没有闭合']);
});
