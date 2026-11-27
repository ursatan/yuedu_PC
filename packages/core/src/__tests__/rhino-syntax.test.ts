import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRhinoSyntax, createJsEvaluator } from '../selector/js';

/**
 * Rhino → V8 语法兼容：Legado 源里 `[a, b] => ...`（数组解构形参**不加括号**）
 * 在 Rhino 能跑、V8 语法错。实测番茄系聚合源整篇 exploreUrl 因此报
 * `Malformed arrow function parameter list`，分类列表为空。
 */
test('normalizeRhinoSyntax: 裸数组解构形参补括号', () => {
  assert.equal(normalizeRhinoSyntax('[a, b] => a + b'), '([a, b]) => a + b');
  assert.equal(
    normalizeRhinoSyntax('[["男频","1"]].map([title, id] => title + id)'),
    '[["男频","1"]].map(([title, id]) => title + id)',
  );
});

test('normalizeRhinoSyntax: 已带括号 / 数组字面量不受影响', () => {
  assert.equal(normalizeRhinoSyntax('([a, b]) => a'), '([a, b]) => a');
  assert.equal(normalizeRhinoSyntax('list.map((x) => x + 1)'), 'list.map((x) => x + 1)');
  assert.equal(normalizeRhinoSyntax('const a = [1, 2]; a.map(f)'), 'const a = [1, 2]; a.map(f)');
});

test('normalizeRhinoSyntax: 字符串 / 模板串 / 注释里的内容不改写', () => {
  assert.equal(normalizeRhinoSyntax('// [a,b] => x'), '// [a,b] => x');
  assert.equal(normalizeRhinoSyntax('const s = "[a,b] => x"'), 'const s = "[a,b] => x"');
  assert.equal(normalizeRhinoSyntax('const t = `[a,b] => x`'), 'const t = `[a,b] => x`');
});

test('实测脚本形态：整篇跑通并产出分类（含 .map([k,v]=>)）', () => {
  const variables = new Map<string, unknown>();
  const evalSync = createJsEvaluator({ variables: variables as never });
  const code = `
let out = [];
push = (t, u) => out.push({ title: t, url: u });
[["男频","1"],["女频","0"]].map([title, id] => {
  push(title, 'https://x/' + id);
});
JSON.stringify(out);
`;
  const r = JSON.parse(String(evalSync(code, { $: '', page: 1 }))) as Array<{ title: string }>;
  assert.deepEqual(r.map((x) => x.title), ['男频', '女频']);
});
