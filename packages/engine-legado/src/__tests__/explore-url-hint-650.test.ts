/**
 * `#650` 探索页 `Malformed URL: undefined/...` 的**诊断 hint**（®️爱丽丝书屋（大侠修））。
 *
 * 症状：发现页只有一条 `ERROR:Malformed URL: undefined/all/order/hits+desc.html`。
 * 真因：源的 exploreUrl 用 `{{GetUL()}}` 拼前缀，`GetUL()` 读 `source.getVariable().sourl`；
 * 变量袋没这个键时模板展开成**字面量** `undefined`。而源的初始化守卫写成
 * `v === null && typeof v !== 'object' && Array.isArray(v)` —— **永假**，默认值永远写不进去。
 *
 * 本文件锁两件事：
 *  ① `undefined`/`null` 开头的地址要给出可执行的 hint（下次不必从头查）；
 *  ② 没有这个特征的消息**不许**被加 hint（避免噪声，也避免掩盖真错误）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exploreFailHint } from '../engine';

test('#650 ①：undefined 开头的地址 ⇒ 提示源变量未初始化', () => {
  const h = exploreFailHint('Malformed URL: undefined/all/order/hits+desc.html');
  assert.match(h, /源变量未初始化/);
  assert.match(h, /sourl/, '要指出具体是哪类变量（GetUL/sourl）');
  assert.match(h, /恒假/, '要指出源的初始化守卫写法问题');
});

test('#650 ②：null 开头同样命中', () => {
  assert.match(exploreFailHint('Malformed URL: null'), /源变量未初始化/);
});

test('#650 ③：其它错误不染指', () => {
  assert.equal(exploreFailHint('Malformed URL: ftp://x'), '');
  assert.equal(exploreFailHint('Reload is not defined'), '');
  assert.equal(exploreFailHint(''), '');
});

/** 同一条源的**登录脚本**：`sgv.urls.length = 0`，而变量袋里没有 `urls` ⇒ 同一个根因 */
test('#657 ①：`Cannot set properties of undefined` 也要给出源变量 hint', () => {
  const h = exploreFailHint("Cannot set properties of undefined (setting 'length')");
  assert.match(h, /源变量未初始化/);
  assert.match(h, /urls/, '要指向具体缺的键');
});
