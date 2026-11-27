/**
 * `#272` 主题导入的**宽容解析**（`utils/theme-transfer.ts` 的 `parseThemeInput`）。
 *
 * 用户原话：「目前的导入多了 kind: "yuedu-themes" 的要求？我直接用单主题格式的数据，
 * 显示导入失败」⇒ 单主题对象 / 多主题数组（裸形态）必须能导；两条保守线不动：
 * 备份文件仍然明确拦下（最难查的静默失败）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseThemeInput } from '../src/utils/theme-transfer';

const THEME = {
  themeName: '深色（本仓）',
  isNightTheme: true,
  primaryColor: '#4F8CFF',
  accentColor: '#A070FF',
  backgroundColor: '#0B0D12',
  bottomBackground: '#11141B',
  transparentNavBar: false,
  backgroundImgPath: null,
  backgroundImgBlur: 0,
};

test('⑴ ★ 裸单主题对象（无 kind 外壳）⇒ 正常解析', () => {
  const p = parseThemeInput(JSON.stringify(THEME));
  assert.equal(p.error, undefined);
  assert.equal(p.valid.length, 1);
  assert.equal(p.valid[0]!.themeName, '深色（本仓）');
  assert.equal(p.valid[0]!.isNightTheme, true);
});

test('⑵ ★ 裸多主题数组 ⇒ 逐条解析、逐条校验', () => {
  const p = parseThemeInput(JSON.stringify([
    THEME,
    { ...THEME, themeName: '默认', isNightTheme: false },
    { noName: true }, // 错误条
  ]));
  assert.equal(p.error, undefined);
  assert.equal(p.valid.length, 2);
  assert.equal(p.rejected.length, 1);
  assert.equal(p.rejected[0]!.index, 2, '错误条序号对齐原始输入');
  assert.ok(p.rejected[0]!.reason.length > 0);
});

test('⑶ 主题包外壳（kind: yuedu-themes）照常可用（向后兼容）', () => {
  const p = parseThemeInput(JSON.stringify({ kind: 'yuedu-themes', v: 1, exportedAt: 0, themes: [THEME] }));
  assert.equal(p.error, undefined);
  assert.equal(p.valid.length, 1);
});

test('⑷ 保守线：用户数据备份文件仍然明确拦下（不是「当成 0 套主题」）', () => {
  const p = parseThemeInput(JSON.stringify({ books: [], prefs: {}, bookGroups: [] }));
  assert.ok(p.error?.includes('备份'), p.error);
  const p2 = parseThemeInput(JSON.stringify({ kind: 'yuedu-userdata', books: [] }));
  assert.ok(p2.error?.includes('备份'), p2.error);
});

test('⑸ 防空转：坏 JSON 与「不是主题数据」都有明确原因', () => {
  assert.ok(parseThemeInput('这不是 JSON').error?.includes('不是合法的 JSON'));
  assert.ok(parseThemeInput(JSON.stringify({ foo: 1 })).error?.includes('不是主题数据'));
});
