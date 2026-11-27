/**
 * **`#639`（2026-10-26）**：Rhino 合法 / V8 非法的「形参同名 `let`/`const`」必须放行。
 *
 * ## 真站取证（🏷书旗小说 `https___ocean.shuqireader.com_1`，用户实测第 4 条）
 * jsLib 里：
 * ```js
 * function GetUrl(path, params, sourceUrl) {
 *   const { java, source } = this;
 *   let sourceUrl = sourceUrl || "https://ocean.shuqireader.com";
 * ```
 * 上游 htmlunit-core-js：`let` 是**块级**声明 ⇒ 只是遮蔽形参，**合法**；
 * V8：`SyntaxError: Identifier 'sourceUrl' has already been declared`。
 *
 * 后果不是「少一个函数」而是**整源瘫痪**（jsLib 是每次求值的前导代码）：
 * ```
 * [js] jsLib 预编译失败，回退逐次编译路径： Identifier 'sourceUrl' has already been declared
 * [url-interp-ERR] SyntaxError: Identifier 'sourceUrl' has already been declared
 * [url-out] …&q={{key}}&page={{page}}&size=10…   ← 模板原样发出 ⇒ 站点只回 parameter is missing
 * ```
 *
 * 断言分三层：
 *   ① 改写后**能编且语义不变**（`var x = x || def` 读到的就是形参值）；
 *   ② **不越界**：同作用域两个 `let x`（Rhino 也报错，属源自己 bug）原样返回，不替它圆；
 *   ③ **不吞别的语法错**：`let a = ;` 这类原样返回，上层照旧报错。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { relaxLetParamShadow } from '../selector/js-compat';

/** 编译并执行一段「函数声明集合」，返回该函数（验语义用） */
function runFn(src: string, name: string): (...args: unknown[]) => unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${src}\nreturn ${name};`)() as (...args: unknown[]) => unknown;
}

test('形参同名 let：放行且语义与 Rhino 一致（形参有值用它，没有则取默认）', () => {
  const lib = [
    'function GetUrl(path, params, sourceUrl) {',
    '  let sourceUrl = sourceUrl || "https://ocean.shuqireader.com";',
    '  return sourceUrl + path;',
    '}',
  ].join('\n');

  // 未处理时 V8 编不过（这是本用例存在的前提，写进断言防「上游 V8 变宽松后测试失去意义」）
  assert.throws(() => new Function(lib), /already been declared/);

  const fixed = relaxLetParamShadow(lib, '测试');
  assert.notEqual(fixed, lib);
  const fn = runFn(fixed, 'GetUrl');
  assert.equal(fn('/api/x', ''), 'https://ocean.shuqireader.com/api/x'); // 2 参调用 ⇒ 默认域名
  assert.equal(fn('/api/x', '', 'https://other.test'), 'https://other.test/api/x'); // 3 参 ⇒ 用传入值
});

test('形参同名 let：多个碰撞名一次清完（🏷长佩文学 AESencrypt(text, key, iv)）', () => {
  const lib = [
    'function AESencrypt(text, key, iv) {',
    '  let key = "u0LRrbu$Enm84koA";',
    '  let iv = "$h$b3!iGzsYnnshj";',
    '  return key + iv + text;',
    '}',
  ].join('\n');
  const fixed = relaxLetParamShadow(lib, '测试');
  const fn = runFn(fixed, 'AESencrypt');
  assert.equal(fn('T', 'ignored', 'ignored'), 'u0LRrbu$Enm84koA$h$b3!iGzsYnnshjT');
});

test('不越界：同作用域两个 let x（Rhino 也报错）原样返回', () => {
  const bad = 'let x = 1;\nlet x = 2;\n';
  assert.equal(relaxLetParamShadow(bad, '测试'), bad);
});

test('不吞错：别的语法错原样返回，交给上层按原样报', () => {
  const bad = 'let a = ;\n';
  assert.equal(relaxLetParamShadow(bad, '测试'), bad);
});

test('零改写：正常 jsLib 原样返回（引用相同，不走改写分支）', () => {
  const ok = 'function Get(p){ return java.ajax(baseUrl + p); }\nlet cache = {};\n';
  assert.equal(relaxLetParamShadow(ok, '测试'), ok);
});

test('可回退：YUEDU_JS_RHINO_COMPAT=0 时一律原样返回', () => {
  const lib = 'function f(a){ let a = a || 1; return a; }\n';
  const prev = process.env['YUEDU_JS_RHINO_COMPAT'];
  process.env['YUEDU_JS_RHINO_COMPAT'] = '0';
  try {
    assert.equal(relaxLetParamShadow(lib, '测试'), lib);
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_RHINO_COMPAT'];
    else process.env['YUEDU_JS_RHINO_COMPAT'] = prev;
  }
});
