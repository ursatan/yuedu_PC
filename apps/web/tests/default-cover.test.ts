/**
 * `#793` 默认封面自定义图片的**纯逻辑回归锁**。
 *
 * 这里只测 node 能跑的部分（不碰 IndexedDB / canvas / Vue）：
 * · 优先级：真实封面 > 自定义默认 > 内置占位；
 * · 损坏图回落：标记还在、对象地址为空 ⇒ 内置图；
 * · 清除后回默认：偏好留空 ⇒ 内置图。
 * 浏览器侧的落盘/压缩/预加载由 `utils/default-cover.ts` 负责（有真环境才能验）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILT_IN_DEFAULT_COVER_PATH,
  DEFAULT_COVER_MAX_BYTES,
  DEFAULT_COVER_MARKER,
  coverLayerOf,
  isCustomDefaultCoverPath,
  resolveDefaultCoverBg,
  validateDefaultCoverFile,
} from '../src/utils/default-cover-core';

const BUILTIN = BUILT_IN_DEFAULT_COVER_PATH;

test('validateDefaultCoverFile：png/jpg/webp 可过，体积/类型/空文件被拒', () => {
  assert.equal(validateDefaultCoverFile({ name: 'a.png', type: 'image/png', size: 1024 }), null);
  assert.equal(validateDefaultCoverFile({ name: 'a.JPG', type: 'image/jpeg', size: 1024 }), null);
  assert.equal(validateDefaultCoverFile({ name: 'a.webp', type: 'image/webp', size: 1024 }), null);
  // 系统给的 MIME 可能为空 ⇒ 退回扩展名
  assert.equal(validateDefaultCoverFile({ name: 'a.webp', type: '', size: 1024 }), null);
  assert.equal(validateDefaultCoverFile({ name: 'a.png', type: 'image/png', size: 0 }), 'empty');
  assert.equal(validateDefaultCoverFile({ name: 'a.png', type: 'image/png', size: DEFAULT_COVER_MAX_BYTES + 1 }), 'size');
  assert.equal(validateDefaultCoverFile({ name: 'a.gif', type: 'image/gif', size: 1024 }), 'type');
  assert.equal(validateDefaultCoverFile({ name: 'a.txt', type: '', size: 1024 }), 'type');
});

test('isCustomDefaultCoverPath：只认标记串，普通 URL / 内置路径都不算自定义', () => {
  assert.equal(isCustomDefaultCoverPath(DEFAULT_COVER_MARKER), true);
  assert.equal(isCustomDefaultCoverPath(` ${DEFAULT_COVER_MARKER} `), true);
  assert.equal(isCustomDefaultCoverPath(BUILTIN), false);
  assert.equal(isCustomDefaultCoverPath('https://a/b.png'), false);
  assert.equal(isCustomDefaultCoverPath(null), false);
});

test('优先级：有真实封面时，自定义默认图不能覆盖它', () => {
  // 真实封面存在 + 未强制默认 + 没加载失败 ⇒ real（与是否设了自定义默认图无关）
  assert.equal(coverLayerOf('https://a/real.png', false, false), 'real');
  // 强制默认封面（上游 useDefaultCover）= 用户显式要求覆盖真实封面
  assert.equal(coverLayerOf('https://a/real.png', true, false), 'default');
  // 真实封面加载失败 ⇒ 才回落默认层
  assert.equal(coverLayerOf('https://a/real.png', false, true), 'default');
  // 本来就没有真实封面 ⇒ 默认层（里面再分自定义/内置）
  assert.equal(coverLayerOf('', false, false), 'default');
  assert.equal(coverLayerOf(null, false, false), 'default');
});

test('自定义默认图生效；读不出来（图片损坏）时回落内置图', () => {
  const custom = 'blob:http://localhost/abc';
  assert.equal(resolveDefaultCoverBg(DEFAULT_COVER_MARKER, BUILTIN, custom), custom);
  // 损坏/丢失：标记还在但对象地址为空 ⇒ 内置默认封面（不是白块，也不抛错）
  assert.equal(resolveDefaultCoverBg(DEFAULT_COVER_MARKER, BUILTIN, ''), BUILTIN);
  // 非标记的普通路径（含内置路径 / 用户填的 URL）原样使用
  assert.equal(resolveDefaultCoverBg('https://a/b.png', BUILTIN, custom), 'https://a/b.png');
  assert.equal(resolveDefaultCoverBg(BUILTIN, BUILTIN, custom), BUILTIN);
});

test('清除后回默认：偏好留空 / 恢复默认写内置路径，两者都落到内置封面', () => {
  const custom = 'blob:http://localhost/abc';
  // 清除 = 偏好置 null
  assert.equal(resolveDefaultCoverBg(null, BUILTIN, ''), BUILTIN);
  // 恢复默认 = 显式写回契约默认值
  assert.equal(resolveDefaultCoverBg(BUILTIN, BUILTIN, ''), BUILTIN);
  // 即便内存里还残留旧对象地址，路径已不是标记 ⇒ 不会误用自定义图
  assert.equal(resolveDefaultCoverBg(null, BUILTIN, custom), BUILTIN);
});
