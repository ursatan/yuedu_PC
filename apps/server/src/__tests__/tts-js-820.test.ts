/**
 * `#820` `@js:` 沙箱边界单测。
 *
 * 用户拍板「允许 `@js:` 但默认折叠」⇒ 允许**不等于**放任：这里逐条锁死
 * 「没有 process/require/fetch、不能 eval/new Function、死循环会被超时打断」。
 * 这些断言是**产品承诺**，改动沙箱时先改这里、再改实现。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTtsJsEvaluator, evalTtsJs, TTS_JS_DEFAULT_TIMEOUT_MS } from '../tts-js';

const bindings = { speakText: '你好', speakSpeed: 1 };

test('裸表达式取 completion value（与上游 eval 语义一致）', () => {
  const r = evalTtsJs("'https://a.test/t?x='+encodeURIComponent(speakText)", bindings);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'https://a.test/t?x=%E4%BD%A0%E5%A5%BD');
});

test('顶层 return 兼容（包 IIFE 重试）', () => {
  const r = evalTtsJs("return 'https://a.test/' + speakSpeed", bindings);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'https://a.test/1');
});

test('jsLib 与主脚本同上下文（前导函数可调用）', () => {
  const r = evalTtsJs('mk(speakText)', bindings, { jsLib: 'function mk(t){ return "https://x/" + t; }' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'https://x/你好');
});

test('java 纯函数可用（base64 / md5 / hex）', () => {
  const r = evalTtsJs('java.base64("a") + "|" + java.md5("a").slice(0, 8) + "|" + java.hexEncodeToString("a")', bindings);
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value, /^YQ==\|0cc175b9\|61$/);
});

test('沙箱边界：没有 process / require / fetch / Buffer', () => {
  const r = evalTtsJs('typeof process + "," + typeof require + "," + typeof fetch + "," + typeof Buffer', bindings);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'undefined,undefined,undefined,undefined');
});

test('沙箱边界：java.ajax 不提供（网络只能由宿主 HTTP 层发）', () => {
  const r = evalTtsJs('typeof java.ajax', bindings);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'undefined');
});

test('沙箱边界：eval / new Function 被 codeGeneration 挡住', () => {
  const a = evalTtsJs('new Function("return 1")()', bindings);
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.code, 'TTS_JS_ERROR');
  const b = evalTtsJs('eval("1+1")', bindings);
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.code, 'TTS_JS_ERROR');
});

test('死循环被硬超时打断（不是把服务卡死）', () => {
  const r = evalTtsJs('while(true){}', bindings, { timeoutMs: 100 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'TTS_JS_TIMEOUT');
    assert.match(r.message, /100ms/);
  }
  assert.equal(TTS_JS_DEFAULT_TIMEOUT_MS, 2000);
});

test('语法错误 / 运行时错误都归一为 TTS_JS_ERROR（带可读原因）', () => {
  const syn = evalTtsJs('function (', bindings);
  assert.equal(syn.ok, false);
  if (!syn.ok) assert.equal(syn.code, 'TTS_JS_ERROR');
  const run = evalTtsJs('notDefinedAnywhere', bindings);
  assert.equal(run.ok, false);
  if (!run.ok) {
    assert.equal(run.code, 'TTS_JS_ERROR');
    assert.match(run.message, /notDefinedAnywhere/);
  }
});

test('每次求值互相隔离（java 变量表不跨请求）', () => {
  const one = evalTtsJs('java.put("k","v"); "ok"', bindings);
  assert.equal(one.ok, true);
  const two = evalTtsJs('java.get("k")', bindings);
  assert.equal(two.ok, true);
  if (two.ok) assert.equal(two.value, '');
});

test('createTtsJsEvaluator 绑定 jsLib（供 core buildTtsRequest 直接用）', () => {
  const ev = createTtsJsEvaluator({ jsLib: 'function u(t){return "https://j/"+t;}', timeoutMs: 500 });
  const r = ev('u(speakText)', bindings);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'https://j/你好');
});
