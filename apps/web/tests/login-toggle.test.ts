/**
 * `loginUi` 开关行（`toggle`）取值口径的回归锁。
 *
 * ## 缺陷类别（用户实测 2026-10-12）
 * 「18AV：勾选了启动页，点击源还是落的分类」。真因：Legado `RowUi.Toggle.chars` 是
 * `[关, 开]` 两个字，**存的/源脚本读的都是那个字符**；而本仓旧实现一律折算成 `'true'/'false'`，
 * 于是落盘 `"启动页":"true"` ⇒ 源脚本 `info['启动页'] != '✅'` 恒真 ⇒ `startHtml` 返回空
 * ⇒ 前端回落常规分类列表。
 *
 * 取证：`GET /api/sources/https___mjv006.com/login-info` 实测回 `"启动页":"true"`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isToggleOn, toggleOffValue, toggleOnValue, toggleValueFor } from '../src/utils/login-toggle';

/** 18AV 语料原文（`loginUi` 里的那一行） */
const AV18 = { chars: ['🔳', '✅'] };

test('#426 toggle · `chars` = [关, 开] ⇒ 落盘的是**字符**（不是 true/false）', () => {
  assert.equal(toggleOnValue(AV18), '✅');
  assert.equal(toggleOffValue(AV18), '🔳');
  assert.equal(toggleValueFor(AV18, true), '✅', '勾选必须落 chars[1] —— 源脚本按它判定');
  assert.equal(toggleValueFor(AV18, false), '🔳');
});

test('#426 toggle · `default: "✅"` 这种初始态必须显示为**已勾选**', () => {
  // `loadPlan` 用 `default` 预填 `info[名称]`；勾选态判定要认它
  assert.equal(isToggleOn(AV18, '✅'), true);
  // 反向：关值 / 空 / 未定义
  assert.equal(isToggleOn(AV18, '🔳'), false);
  assert.equal(isToggleOn(AV18, ''), false);
  assert.equal(isToggleOn(AV18, undefined), false);
});

test('#426 toggle · 老数据 `"true"` 仍判为开（迁移：再提交一次即被改写成 chars[1]）', () => {
  assert.equal(isToggleOn(AV18, 'true'), true, '不认它 ⇒ 用户会看到「明明勾了却显示没勾」');
  assert.equal(toggleValueFor(AV18, isToggleOn(AV18, 'true')), '✅', '提交即自愈');
});

test('#426 toggle · 不写 `chars` 的源回落 true/false（零回归）', () => {
  assert.equal(toggleOnValue({}), 'true');
  assert.equal(toggleOffValue({}), 'false');
  assert.equal(toggleValueFor({}, true), 'true');
  assert.equal(isToggleOn({}, 'true'), true);
  assert.equal(isToggleOn({}, 'false'), false);
  // 空串字符视为「没写」
  assert.equal(toggleOnValue({ chars: ['', ''] }), 'true');
  assert.equal(toggleOffValue({ chars: ['', ''] }), 'false');
});

test('#426 toggle · v2 `value` 形态（源脚本给的行）同样按 chars 判', () => {
  const v2 = { chars: ['off', 'on'], value: 'on' };
  assert.equal(isToggleOn(v2, v2.value), true);
  assert.equal(isToggleOn(v2, 'off'), false);
});