/**
 * 语法错可定位化：**宿主（TS）与 worker（注入源码）两份实现必须逐字同结果**。
 *
 * 为什么需要这条锁：worker 里不能 import 宿主代码，只能把源码字符串注入 `WORKER_SRC`
 * （同 `URL_PREP_SOURCE` 套路）——两份实现一旦漂移，就会出现「同一份源在 L1 报得清楚、
 * 走 worker 却只有一句 V8 原文」这种最难查的路径差异。这里用同一批输入比对两边输出。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { JS_ERROR_EXPLAIN_SOURCE, explainJsError } from '../selector/js-error';

const req = createRequire(import.meta.url);
/** 把注入给 worker 的那段源码求值出来（worker 是 CommonJS，所以要把 require 传进去） */
const workerExplain = new Function('require', `${JS_ERROR_EXPLAIN_SOURCE}\nreturn __yueduExplainJsError;`)(req) as (
  msg: string,
  src: string,
  stack?: string,
) => string;

const CASES: Array<{ name: string; msg: string; src: string; stack?: string }> = [
  {
    name: '尾部 ## 残留（真实踩坑形态）',
    msg: 'Invalid or unexpected token',
    src: 'result\n.replace("••","")\n.replace(/[\\\\(\\\\{（｛【].*/g,\'\')\n##(章)([^\\s]+)(\\s·)##$1 $2$3',
  },
  { name: 'Unexpected end of input', msg: 'Unexpected end of input', src: 'var a=1;\nfoo(' },
  { name: 'Unexpected token .', msg: "Unexpected token '.'", src: '.replace(/,/,\'\')' },
  {
    name: '非法正则',
    msg: 'Invalid regular expression: /[/: Unterminated character class',
    src: 'var a = /[/;',
  },
  { name: '运行时错（无栈 → 不该被改写）', msg: "Cannot read properties of undefined (reading 'match')", src: 'foo.match(1)' },
  { name: '网络错（不该被改写）', msg: 'DNS 解析失败（域名可能已失效）', src: 'java.ajax("https://x.test")' },
  {
    // 实测形态：可乐小说 searchUrl 里 document.documentElement.nodeName 读到 undefined
    name: '运行时错 + 栈 → 补出错行',
    msg: "Cannot read properties of undefined (reading 'nodeName')",
    src: 'var document = { documentElement: null };\nvar t = document.documentElement.nodeName;\nt;',
    stack: "TypeError: Cannot read properties of undefined (reading 'nodeName')\n    at eval (eval at <anonymous> (x:1:1), <anonymous>:2:34)\n    at x:1:1",
  },
];

test('宿主 explainJsError 与 worker 注入实现逐字同结果', () => {
  for (const c of CASES) {
    assert.equal(workerExplain(c.msg, c.src, c.stack), explainJsError(c.msg, c.src, c.stack), `两侧结果不一致：${c.name}`);
  }
});

test('语法错必须补出「出错位置 + 片段」；非语法错（无栈）原样返回', () => {
  const bad = CASES[0]!;
  const out = explainJsError(bad.msg, bad.src);
  assert.ok(out.startsWith(bad.msg), `应保留原始 message：${out}`);
  assert.ok(out.includes('yuedu-rule.js'), `应给出行号定位：${out}`);
  assert.ok(out.includes('片段='), `应给出代码片段：${out}`);
  assert.ok(out.includes('##(章)'), `片段要包含真正的出错文本：${out}`);

  for (const c of CASES.slice(4, 6)) {
    assert.equal(explainJsError(c.msg, c.src), c.msg, `${c.name} 不得被改写（会影响错误分类）`);
  }
});

test('运行期错带栈时必须补出「出错行 + 尖号」', () => {
  const c = CASES[6]!;
  const out = explainJsError(c.msg, c.src, c.stack);
  assert.ok(out.startsWith(c.msg), `应保留原始 message：${out}`);
  assert.ok(out.includes('运行期 2:34'), `应给出行:列：${out}`);
  assert.ok(out.includes('document.documentElement.nodeName'), `应给出出错行原文：${out}`);
});

test('片段长度受限（避免把整条规则塞进错误信息）', () => {
  const long = `var a=;\n${'x'.repeat(5000)}`;
  const out = explainJsError('Unexpected token ;', long);
  assert.ok(out.length < 600, `错误信息不得膨胀，实际 ${out.length}`);
});
