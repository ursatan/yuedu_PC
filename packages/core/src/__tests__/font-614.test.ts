/**
 * `#614` 字体反爬（`queryTTF` / `queryBase64TTF` / `replaceFont` 的算法部分）
 *
 * ## 离线怎么验
 * 不下载真字体（测试不能依赖网络，也不能把几 MB 的 ttf 塞进仓库），而是用
 * `fixtures/ttf-fixture.ts` **自己造两只字体**：glyf 逐字节相同、cmap 互换。
 * 于是 `replaceFont('一丁', 错误, 正确)` 必须得到 `'丁一'` ——
 * 这条断言成立就证明实现是**按轮廓串匹配**（按字形索引会原样返回 '一丁'）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTtf, replaceFont } from '../font';
import { SHAPE_A, TTF_CORRECT, TTF_OBFUSCATED, buildTtf } from './fixtures/ttf-fixture';

/** 正确字体：一(4E00) → 轮廓 A；丁(4E01) → 轮廓 B */
const correct = TTF_CORRECT;
/** 错误字体：glyf 完全相同、cmap 互换（= 站点字体反爬） */
const obfuscated = TTF_OBFUSCATED;

test('#614 parseTtf：能建出 Unicode ⇄ 轮廓索引 与 反向表', () => {
  const f = parseTtf(correct);
  assert.equal(f.numGlyphs, 3);
  assert.equal(f.glyfIdOf(0x4e00), 1);
  assert.equal(f.glyfIdOf(0x4e01), 2);
  assert.equal(f.glyfIdOf(0x9999), 0, '找不到 ⇒ 0（上游语义）');
  assert.ok(f.glyfOf(0x4e00)?.length, '有轮廓串');
  assert.equal(f.unicodeOfGlyf(f.glyfOf(0x4e01)!), 0x4e01, '反查回原码位');
  assert.equal(f.unicodeOfGlyf('不存在的轮廓串'), 0);
  assert.equal(f.unicodeOfGlyf(null), 0);
});

test('#614 replaceFont：cmap 被打乱的字体 → 按轮廓串还原真实文字（核心断言）', () => {
  const err = parseTtf(obfuscated);
  const corr = parseTtf(correct);
  // 站点发的是「一丁」，但它自己的字体把它显示成「丁一」⇒ 我们要还原回真实文本
  assert.equal(replaceFont('一丁', err, corr), '丁一');
  // 反过来也成立（对称性检查：说明不是硬编码某一路）
  assert.equal(replaceFont('丁一', err, corr), '一丁');
  // 空白字符不参与替换
  assert.equal(replaceFont('一 丁\n', err, corr), '丁 一\n');
  // 字体为 null ⇒ 原样返回（上游第一行 return text）
  assert.equal(replaceFont('一丁', null, corr), '一丁');
  assert.equal(replaceFont('一丁', err, undefined), '一丁');
});

test('#614 replaceFont(filter)：错误字体里没有轮廓的字 ⇒ 删掉 / 保留', () => {
  const err = parseTtf(obfuscated);
  const corr = parseTtf(correct);
  // 0x4E02 在两只字体里都没有 ⇒ 轮廓 null
  assert.equal(replaceFont('一X丁', err, corr, true), '丁一', 'filter=true 删掉无轮廓字符');
  assert.equal(replaceFont('一X丁', err, corr, false), '丁X一', 'filter=false 原样留着');
});

test('#614 parseTtf：坏数据要**说清原因**（不能静默返回空映射）', () => {
  assert.throws(() => parseTtf(new Uint8Array(4)), /太短|不是有效字体/);
  // OTTO（CFF 轮廓）⇒ 明确不支持，而不是「字体处理无效」
  const otto = buildTtf([[0x4e00, 1]], [undefined, SHAPE_A]);
  otto[0] = 0x4f;
  otto[1] = 0x54;
  otto[2] = 0x54;
  otto[3] = 0x4f;
  assert.throws(() => parseTtf(otto), /CFF/);
  // sfntVersion 乱掉
  const bad = buildTtf([[0x4e00, 1]], [undefined, SHAPE_A]);
  bad[0] = 0x12;
  assert.throws(() => parseTtf(bad), /不是 TTF\/OTF/);
});

test('#614 空字形（无轮廓）不进反向表，但映射仍在（与上游一致）', () => {
  // glyph 1 是空字形（loca 相邻相等）⇒ glyfOf 恒 null
  const f = parseTtf(buildTtf([[0x4e00, 1]], [undefined, undefined]));
  assert.equal(f.glyfIdOf(0x4e00), 1);
  assert.equal(f.glyfOf(0x4e00), null);
  assert.equal(f.mappedCount, 0, '空字形不进 unicode→轮廓 表');
});
