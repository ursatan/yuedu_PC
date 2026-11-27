/**
 * `#146` 简繁转换的回归锁。
 *
 * 这里**用真词典**（`opencc-js`）—— 转换质量本身就是被测对象，mock 掉就等于没测。
 * 重点锁四件事：
 *  ① 两个方向的**词组**转换生效（`twp` 变体），不是只换字 ——「軟體→软件」而不是「软体」；
 *  ② `type=0` / 脏值 ⇒ **原样返回**（绝不静默转换）；
 *  ③ 空串 / 空数组 / 加载失败 ⇒ **不抛**（对齐上游：转换失败照原文显示）；
 *  ④ 批量转换与逐条转换**结果一致**（别为了性能在批量路径里少转几条）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHINESE_CONVERT_OPTIONS,
  convertChinese,
  convertChineseBatch,
  isChineseConvertOn,
  normalizeChineseConvertType,
} from '../src/utils/chinese-convert';

test('选项表：三档，取值与契约 ChineseConvertType 一致（0 不转换 / 1 繁→简 / 2 简→繁）', () => {
  assert.deepEqual(
    CHINESE_CONVERT_OPTIONS.map((o) => o.value),
    [0, 1, 2],
  );
  assert.equal(CHINESE_CONVERT_OPTIONS[1]?.label, '繁体 → 简体');
  assert.equal(CHINESE_CONVERT_OPTIONS[2]?.label, '简体 → 繁体');
});

test('isChineseConvertOn / normalizeChineseConvertType：脏值一律当「不转换」', () => {
  assert.equal(isChineseConvertOn(1), true);
  assert.equal(isChineseConvertOn(2), true);
  for (const v of [0, undefined, null, '', '1', 3, -1, NaN, {}]) {
    assert.equal(isChineseConvertOn(v), false, `${JSON.stringify(v)} 不该被当成「要转换」`);
  }
  assert.equal(normalizeChineseConvertType('1'), 0, "字符串 '1' 是脏值（契约存的是数字）");
  assert.equal(normalizeChineseConvertType(2), 2);
});

test('type=0 或空文本 ⇒ 原样返回', async () => {
  assert.equal(await convertChinese('漢語 繁體', 0), '漢語 繁體');
  assert.equal(await convertChinese('', 1), '');
  assert.equal(await convertChinese('漢語', undefined), '漢語');
});

test('繁 → 简：词组转换生效（不是只换字）', async () => {
  const got = await convertChinese('軟體 伺服器 網路 硬碟 計程車', 1);
  assert.equal(
    got,
    '软件 服务器 网络 硬盘 出租车',
    '必须是 twp 的词组结果；若得到「软体 伺服器 网路 硬碟 计程车」说明配置退化成字级了',
  );
  // 字级也应正确
  assert.equal(await convertChinese('漢語', 1), '汉语');
  assert.equal(await convertChinese('圖書館', 1), '图书馆');
  // 标点/数字/英文原样保留
  assert.equal(await convertChinese('第 3 章：ABC — 結束。', 1), '第 3 章：ABC — 结束。');
});

test('简 → 繁：词组转换生效（台灣用语）', async () => {
  const got = await convertChinese('软件 服务器 网络 硬盘 出租车', 2);
  assert.equal(
    got,
    '軟體 伺服器 網路 硬碟 計程車',
    '必须是 twp 的词组结果；若得到「軟件 服務器 網絡 硬盤 出租車」说明配置退化成字级了',
  );
  assert.equal(await convertChinese('汉语', 2), '漢語');
});

test('批量转换：与逐条转换结果一致，且空元素原样保留', async () => {
  const src = ['漢語 繁體', '', '軟體 伺服器', '第 3 章'];
  const batch = await convertChineseBatch(src, 1);
  const one = [];
  for (const s of src) one.push(await convertChinese(s, 1));
  assert.deepEqual(batch, one, '批量与逐条必须一致（否则批量路径少转了）');
  assert.equal(batch[1], '', '空段落保持空（不要把空串变成别的东西）');
  assert.equal(batch.length, src.length, '长度不变（正文按段落渲染，长度变了会错位）');
});

test('批量：type=0 / 空数组 ⇒ 原样返回，且不抛', async () => {
  const src = ['漢語', '繁體'];
  assert.deepEqual(await convertChineseBatch(src, 0), src);
  assert.deepEqual(await convertChineseBatch([], 1), []);
  // 返回的是**副本**（避免调用方误改入参）
  const out = await convertChineseBatch(src, 0);
  assert.notEqual(out, src, '应返回副本而不是同一个数组引用');
});
