/**
 * `java.security.MessageDigest` **按 Java 公共契约**的回归锁（2026-10-24，全量基线 r2）。
 *
 * 背景：🍅番茄短剧·漫剧(APP) / 🍅番茄漫画(APP) 的 jsLib 写
 * `getInstance('MD5').update(bytes).digest()`，而本仓此前只实现了 `digest(input?)` 一个方法
 * ⇒ `d.update is not a function`（2 源）。
 *
 * 上游依据：legado 里这是**真 Java 类**（Rhino 直通），所以整组方法都在：
 * `update(b) / update(byte[]) / update(byte[],off,len) / digest() / digest(byte[]) /
 * digest(byte[],off,len) / reset() / getAlgorithm() / getDigestLength() / clone()`。
 * 移植时按 JDK 契约对齐 —— 尤其两条**易漏的 Java 语义**：
 *  · `digest()` 返回后**自动 reset**（再 digest() 得到空输入摘要）；
 *  · `digest(input)` = 先 `update(input)` 再 `digest()`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { makeMessageDigestNs } from '../selector/java-bridge';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

type DigestApi = {
  update: (input?: unknown, off?: unknown, len?: unknown) => void;
  digest: (input?: unknown, off?: unknown, len?: unknown) => Uint8Array;
  reset: () => void;
  getAlgorithm: () => string;
  getDigestLength: () => number;
  clone: () => DigestApi;
};

const ns = makeMessageDigestNs() as unknown as {
  getInstance: (a: unknown) => DigestApi;
  isEqual: (a: unknown, b: unknown) => boolean;
};

test('update 累积 + digest() 取摘要（番茄系 jsLib 的写法）', () => {
  const d = ns.getInstance('MD5');
  d.update('ab');
  d.update('c');
  assert.equal(hex(d.digest()), md5('abc'));
});

test('digest(input) = 先 update 再 digest（Java 重载语义）', () => {
  assert.equal(hex(ns.getInstance('MD5').digest('abc')), md5('abc'));
});

test('digest() 之后自动 reset（Java 的隐式行为）', () => {
  const d = ns.getInstance('MD5');
  d.update('abc');
  assert.equal(hex(d.digest()), md5('abc'));
  assert.equal(hex(d.digest()), md5(''), 'digest 后再 digest 必须是空输入摘要');
});

test('reset() 清空累积；getAlgorithm / getDigestLength 对齐 Java', () => {
  const d = ns.getInstance('SHA-256');
  d.update('abc');
  d.reset();
  assert.equal(hex(d.digest()), createHash('sha256').digest('hex'));
  assert.equal(d.getAlgorithm(), 'SHA-256');
  assert.equal(d.getDigestLength(), 32);
});

test('update(byte[], off, len) 与 clone()（复制累积状态）', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const d = ns.getInstance('MD5');
  d.update(bytes, 1, 3); // 取 [2,3,4]
  const copy = d.clone();
  assert.equal(hex(d.digest()), hex(copy.digest()), 'clone 应复制同一累积状态');
});

test('isEqual：等长同值 true，其余 false（含长度不同）', () => {
  assert.equal(ns.isEqual([1, 2], [1, 2]), true);
  assert.equal(ns.isEqual([1, 2], [1, 3]), false);
  assert.equal(ns.isEqual([1, 2], [1, 2, 3]), false);
});
