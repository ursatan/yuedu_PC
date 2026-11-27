/**
 * `#223` 样式预设的「按当前颜色集重定向」—— 这是「预设点了没反应」的真修复体。
 *
 * 判据设计成**双向**：
 *  · 「当前槽被写了」—— 证明改到了用户看得见的那一套；
 *  · 「另外两槽没被动」—— 证明不是把三套全刷一遍（那样切主题就看不出预设的区别了）。
 * 只断言第一条的话，「无脑写满三个槽」也能过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { redirectPresetColors } from '../src/utils/read-style-presets';
import type { ReadStyleOverride } from '../src/contract';

const PRESET = {
  bgStr: '#DDC090', bgStrNight: '#3C3F43', bgStrEInk: '#FFFFFF',
  textColor: '#3E3422', textColorNight: '#DCDFE1', textColorEInk: '#000000',
  textAccentColor: '#834E00', textAccentColorNight: '#FE4D55', textAccentColorEInk: '#000000',
  bgAlpha: 100,
} as unknown as ReadStyleOverride;

test('#223 ① 白天：写白天槽（与上游 `isNightTheme=false` 分支一致）', () => {
  const out = redirectPresetColors(PRESET, 'day');
  assert.equal(out.bgStr, '#DDC090');
  assert.equal(out.textColor, '#3E3422');
  assert.equal(out.bgAlpha, 100, '非颜色键原样透传');
});

test('#223 ② ★ 夜间主题：写夜间槽 —— 这正是「点了没反应」的修掉之处', () => {
  const out = redirectPresetColors(PRESET, 'night');
  assert.equal(out.bgStrNight, '#3C3F43', '夜间下必须写 bgStrNight，而不是 bgStr');
  assert.equal(out.textColorNight, '#DCDFE1');
  assert.equal(out.textAccentColorNight, '#FE4D55');
});

test('#223 ②-b ★★ 另外两槽**必须缺席**（这是踩过的坑）', () => {
  // 早先实现是 `out = { ...patch }` ⇒ patch 里自带的白天值也被写进去
  // ⇒ 夜间点一次预设，用户的白天配色被**悄悄改掉**。
  // 「缺席 ≠ 清空」：commit 只写 patch 里有的键，所以不写就是「不碰」。
  const out = redirectPresetColors(PRESET, 'night') as Record<string, unknown>;
  for (const k of ['bgStr', 'bgStrEInk', 'textColor', 'textColorEInk', 'textAccentColor', 'textAccentColorEInk']) {
    assert.equal(k in out, false, `夜间预设不该带出 ${k}（带了就会改掉用户另一套配色）`);
  }
  assert.equal(out.bgAlpha, 100, '非颜色键照常透传');
});

test('#223 ③ 墨水屏：写 E-Ink 槽', () => {
  const out = redirectPresetColors(PRESET, 'eink');
  assert.equal(out.bgStrEInk, '#FFFFFF');
  assert.equal(out.textColorEInk, '#000000');
});

test('#223 ④ 预设只给一套色时，当前槽**回退到那套**（而不是变空）', () => {
  const only = { bgStr: '#FFFFFF', textColor: '#000000' } as ReadStyleOverride;
  assert.equal(redirectPresetColors(only, 'night').bgStrNight, '#FFFFFF');
  assert.equal(redirectPresetColors(only, 'eink').textColorEInk, '#000000');
});

test('#223 ⑤ 不写 undefined / null 的颜色键（否则会「把颜色清空」）', () => {
  const out = redirectPresetColors({ bgStr: '#123456' } as ReadStyleOverride, 'night');
  assert.equal('textColorNight' in out, false, '没给的颜色不该被写出来');
  assert.equal(out.bgStrNight, '#123456');
});

/* ---------------- `#249` 背景图片：三套槽 + 「明确无图」 ---------------- */

test('#249 ① 背景图片按颜色集重定向（白天选的图不该跑到夜间槽）', () => {
  const p = { bgStr: '#FFF', bgImgPath: '护眼漫绿' } as ReadStyleOverride;
  const night = redirectPresetColors(p, 'night');
  assert.equal(night.bgImgPathNight, '护眼漫绿', '夜间应取白天的值回填（预设只存一套的常见情形）');
  assert.equal('bgImgPathEInk' in night, false, '★ 没给墨水屏就不写（缺席≠清空）');
  assert.equal(redirectPresetColors(p, 'day').bgImgPath, '护眼漫绿', '白天原样');
});

test('#249 ② 背景图的 null 是「明确无图」，**必须写进去**（与颜色的 null 语义相反）', () => {
  // ★ 这是本轮最容易写错的一处：颜色组的 null 意思是「不覆盖」，而用户点「清除背景图片」
  //   产出的是 null，意思是「这槽给我空着」。混为一谈 ⇒ 清除按钮点了没反应。
  const day = redirectPresetColors({ bgImgPath: null } as ReadStyleOverride, 'day');
  assert.equal('bgImgPath' in day, true, '★ 白天槽应被写成 null');
  assert.equal(day.bgImgPath, null);
  const night = redirectPresetColors({ bgImgPath: null } as ReadStyleOverride, 'night');
  assert.equal(night.bgImgPathNight, null, '夜间同理（回退到白天的 null）');
});

test('#249 ③ 背景图不在 patch 里时，一个槽都不写（不凭空造键）', () => {
  const out = redirectPresetColors({ textSize: 30 } as ReadStyleOverride, 'day');
  assert.equal('bgImgPath' in out, false);
  assert.equal('bgImgPathNight' in out, false);
  assert.equal(out.textSize, 30, '非颜色键照常透传');
});
