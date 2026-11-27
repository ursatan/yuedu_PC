/**
 * `#633` 纯表达式快路的回归锁。
 *
 * 为什么必须有：快路是「在宿主用模板缓存直接跑脚本」，一旦边界判断松了口子，
 * 就会把「需要绑定 / jsLib / 控制流」的脚本也吞进来 ⇒ 静默算错（比慢更糟）。
 * 这里逐条锁住：**能算的算对、不能算的一律拒绝**，且拒绝时调用方仍走原路由。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFastExprRunner, tokenizeFastExpr } from '../selector/fast-expr';

const java = {
  base64Encode: (s: string) => Buffer.from(s, 'utf8').toString('base64'),
  md5Encode: (s: string) => `md5(${s})`,
};

const QM_TOC = `var cid='1784902';var cmd5='9d0c1e';
'data:;base64,'+java.base64Encode(cid+'/'+cmd5)+',{"type":"qm"}';`;

test('#633 七猫目录 chapterUrl（真实形态）算得对', () => {
  const run = createFastExprRunner();
  const r = run(QM_TOC, java);
  assert.equal(r.ok, true);
  assert.equal(
    (r as { value: unknown }).value,
    `data:;base64,${Buffer.from('1784902/9d0c1e', 'utf8').toString('base64')},{"type":"qm"}`,
  );
});

test('#633 同模板不同字面量 ⇒ 共用编译产物（缓存命中）且值正确', () => {
  const run = createFastExprRunner();
  const a = run(`var cid='1'; 'x'+cid;`, java);
  const b = run(`var cid='2'; 'x'+cid;`, java);
  assert.equal((a as { value: unknown }).value, 'x1');
  assert.equal((b as { value: unknown }).value, 'x2');
  const stats = (run as unknown as { stats: () => { hits: number; misses: number } }).stats();
  assert.equal(stats.misses, 1, '模板相同 ⇒ 只编译一次');
  assert.ok(stats.hits >= 1);
});

test('#633 数字字面量与转义', () => {
  const run = createFastExprRunner();
  assert.equal((run(`var n=12; n+1;`, java) as { value: unknown }).value, 13);
  assert.equal((run(`'a\\'b' + "c";`, java) as { value: unknown }).value, "a'bc");
  assert.equal((run(`'l1\\nl2';`, java) as { value: unknown }).value, 'l1\nl2');
});

test('#633 必须拒绝：绑定 / 全局 / lib 函数 / 控制流 / 副作用 java', () => {
  const run = createFastExprRunner();
  const bad = [
    `result.match(/x/)`, // 绑定
    `$('a').text()`, // 绑定
    `window.location.href`, // 全局
    `document.title`, // 全局
    `java.ajax('http://x')`, // 副作用 java
    `java.getString('a')`, // 依赖上下文
    `if (1) { 'x' }`, // 控制流
    `for (var i=0;i<3;i++) i`, // 控制流
    `function f(){ return 1 }`, // 函数
    `unknownLibFn('a')`, // lib 函数
    `'a'.replace(/a/, 'b')`, // regex 参数（含 `/`）
    `var a='1'; a[0]`, // 动态下标
    `eval('1')`, // eval
    `var s='x'; s.length > 0 ? s : ''`, // 三元（`?` 不在白名单）
  ];
  for (const code of bad) {
    const r = run(code, java);
    assert.equal(r.ok, false, `不该放行：${code}`);
  }
});

test('#633 只有 var 声明、没有表达式 ⇒ 拒绝（拿不到完成值）', () => {
  const run = createFastExprRunner();
  assert.equal(run(`var a='1';`, java).ok, false);
});

test('#633 tokenize 不把字符串里的分号/花括号当成语法', () => {
  const tk = tokenizeFastExpr(`'a;b{c}'`);
  assert.ok(tk);
  assert.equal(tk?.values[0], 'a;b{c}');
  assert.equal(tk?.norm, '__L0');
});
