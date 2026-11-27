/**
 * `#750` 封面「同书升级 vs 换书」判据回归锁。
 *
 * 七猫官方实测：列表 `ruleSearch.coverUrl = image_link` 给
 * `…_288x384.jpg`；详情 `ruleBookInfo.coverUrl = book.image_link` 给
 * `…_600x800.jpg?f=webp&q=60` —— 同一本书、两个地址。
 * 上游 `BookInfo.kt:142-148` 在**非空时替换** `book.coverUrl`；显示层
 * `CoverImageView.load()` 用 Glide `.placeholder(defaultDrawable)` ⇒ 换 URL 时
 * **旧图立刻被默认图替换**，于是「封面没了再加载」。
 *
 * 本仓的改进：同书升级时保留已显示的旧图当占位（失败也保留）；
 * 换书仍必须清空（`#176`：切分类不能残留上一本封面）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverSwapMode } from '../src/utils/img';

test('#750 同书、封面已显示 ⇒ keep-old（旧图占位，新图到达再换）', () => {
  assert.equal(coverSwapMode('src\u0000书名', 'src\u0000书名', '/api/proxy?u=288'), 'keep-old');
});

test('#750 换书（owner 不同）⇒ reset（绝不残留上一本封面）', () => {
  assert.equal(coverSwapMode('src\u0000A', 'src\u0000B', '/api/proxy?u=A'), 'reset');
});

test('#750 换源（同书名、sourceId 不同）⇒ reset', () => {
  assert.equal(coverSwapMode('srcA\u0000同名', 'srcB\u0000同名', '/api/proxy?u=x'), 'reset');
});

test('#750 身份未知（标题为空）⇒ reset（宁闪不可错书）', () => {
  assert.equal(coverSwapMode('', 'src\u0000书名', '/api/proxy?u=x'), 'reset');
  assert.equal(coverSwapMode('src\u0000书名', '', '/api/proxy?u=x'), 'reset');
});

test('#750 旧图还没成功显示 ⇒ reset（没有可占位的图）', () => {
  assert.equal(coverSwapMode('src\u0000书名', 'src\u0000书名', ''), 'reset');
});
