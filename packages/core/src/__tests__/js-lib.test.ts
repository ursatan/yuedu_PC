/**
 * `#344`：jsLib 三形态解析（唯一实现 `core/src/selector/js-lib.ts`）。
 *
 * 症状（用户 2026-10-08 报障，剧迷 / Movieffm / 西瓜卡通 三个 RSS 源）：
 * `RULE_PARSE@request: <源>@js:`{{Get('url')}}/…` · Unexpected token ':'`，
 * 片段是 `"剧迷":"https://qyyuapi.com/dy/js/剧迷/jsLib.js",` —— 即 **jsLib 是 JSON 映射表**，
 * 被当成 JS 源码执行 ⇒ 语法错。
 *
 * 上游依据（逐行核实）：`SharedJsScope.kt:231-276`
 *   · `parseJsLibMap`：`jsLib.isJsonObject()` ⇒ 按「库名→URL」映射表；
 *   · `evaluateJsLib`：map 的每个 value **是绝对 URL** 才下载其 JS 并 eval（非 URL 跳过）；
 *   · 非 JSON 对象 ⇒ 整段当 JS 源码 eval。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsLibMap, isAbsUrl, jsLibUrls, resolveJsLibText } from '../selector/js-lib';

test('parseJsLibMap：JSON 对象 → 映射表；非对象/坏 JSON ⇒ null', () => {
  const m = parseJsLibMap('{ "剧迷":"https://qyyuapi.com/dy/js/剧迷/jsLib.js", "通用":"https://qyyuapi.com/js/common.js" }');
  assert.deepEqual(m, {
    '剧迷': 'https://qyyuapi.com/dy/js/剧迷/jsLib.js',
    '通用': 'https://qyyuapi.com/js/common.js',
  });
  // 内联 JS / 数组 / 坏 JSON 都不是 map
  assert.equal(parseJsLibMap('function S(){}'), null);
  assert.equal(parseJsLibMap('[1,2,3]'), null);
  assert.equal(parseJsLibMap('{ bad json'), null);
  assert.equal(parseJsLibMap(''), null);
});

test('isAbsUrl：仅 http/https 算绝对 URL', () => {
  assert.equal(isAbsUrl('https://a/b.js'), true);
  assert.equal(isAbsUrl('http://a/b.js'), true);
  assert.equal(isAbsUrl('  https://a/b.js  '), true);
  assert.equal(isAbsUrl('//a/b.js'), false);
  assert.equal(isAbsUrl('function f(){}'), false);
});

test('jsLibUrls：映射表取全部 URL 值；单 URL 取自身；内联返回空', () => {
  assert.deepEqual(
    jsLibUrls('{"a":"https://x/a.js","b":"not-a-url","c":"https://x/c.js"}'),
    ['https://x/a.js', 'https://x/c.js'],
  );
  assert.deepEqual(jsLibUrls('https://x/single.js'), ['https://x/single.js']);
  assert.deepEqual(jsLibUrls('function f(){}'), []);
});

test('resolveJsLibText：映射表 ⇒ 逐个下载并拼接（非 URL 值跳过）', () => {
  const fetched: string[] = [];
  const out = resolveJsLibText(
    '{"剧迷":"https://qyyuapi.com/dy/js/剧迷/jsLib.js","本地":"var x=1","通用":"https://qyyuapi.com/js/common.js"}',
    (url) => {
      fetched.push(url);
      return `/* ${url} */`;
    },
  );
  assert.deepEqual(fetched, ['https://qyyuapi.com/dy/js/剧迷/jsLib.js', 'https://qyyuapi.com/js/common.js']);
  assert.equal(out, '/* https://qyyuapi.com/dy/js/剧迷/jsLib.js */\n/* https://qyyuapi.com/js/common.js */');
});

test('resolveJsLibText：单 URL ⇒ 下载；内联 JS ⇒ 原样（不调下载器）', () => {
  let called = 0;
  const single = resolveJsLibText('https://x/a.js', () => {
    called++;
    return 'DOWNLOADED';
  });
  assert.equal(single, 'DOWNLOADED');
  assert.equal(called, 1);

  called = 0;
  const inline = resolveJsLibText('function S(){return 1}', () => {
    called++;
    return 'X';
  });
  assert.equal(inline, 'function S(){return 1}');
  assert.equal(called, 0);
});

test('resolveJsLibText：空 ⇒ undefined；下载失败 ⇒ 跳过该库（不全挂）', () => {
  assert.equal(resolveJsLibText('', () => 'x'), undefined);
  assert.equal(resolveJsLibText(null, () => 'x'), undefined);
  assert.equal(resolveJsLibText(undefined, () => 'x'), undefined);
  const out = resolveJsLibText('{"a":"https://x/a.js","b":"https://x/b.js"}', (u) => (u.endsWith('a.js') ? 'A' : null));
  assert.equal(out, 'A'); // b 下载失败只跳过
});

test('★ 判别式：旧行为（整段 JSON 当 JS）会抛 Unexpected token ":"；新实现不抛且产出库文本', () => {
  const jsLib = '{ "剧迷":"https://qyyuapi.com/dy/js/剧迷/jsLib.js" }';
  // 旧行为演示：整段当 JS 求值必抛
  assert.throws(() => {
    // eslint-disable-next-line no-new-func
    new Function(jsLib);
  }, /Unexpected token/);
  // 新行为：解析成映射表并产出下载到的库文本
  const out = resolveJsLibText(jsLib, () => 'function Get(k){return k}');
  assert.equal(out, 'function Get(k){return k}');
});
