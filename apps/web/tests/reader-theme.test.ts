/**
 * `#145` 阅读主题的确定性部分（档位 → 颜色集 → CSS 变量）回归锁。
 *
 * 这里只测**纯函数**（不碰 DOM / 不碰 Vue）—— 浏览器侧的行为由探针
 * `scripts/probe-145-reader-theme.mjs` 验，两者互补。
 *
 * 重点锁三类**容易静默错**的东西：
 *  ① `themeMode` 4 档 → 3 套颜色的映射（「跟随系统」必须由系统偏好落到 day/night，**不新增第 4 套**）；
 *  ② 旧值迁移（`'dark'` / `'sepia'`）—— 迁移错了用户看到的主题会突然变；
 *  ③ 单位换算（`lineSpacingExtra` 是**增量**不是总行高、`letterSpacing` 是 em、
 *     `titleSize = 0` 是**哨兵**不是「0px」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  READER_COLORS,
  READER_THEME_MODES,
  boldWeight,
  cssFontFamily,
  isReaderThemeMode,
  normalizeThemeMode,
  readerColorSet,
  readerContentVars,
} from '../src/styles/reader-theme';

test('档位表：4 档，取值与顺序照抄上游 arrays.xml:71-76 的 theme_mode', () => {
  assert.equal(READER_THEME_MODES.length, 4, 'theme_mode 数组有 4 项');
  assert.deepEqual(
    READER_THEME_MODES.map((m) => m.value),
    ['0', '1', '2', '3'],
    '顺序必须是 跟随系统 / 亮色 / 暗色 / 墨水屏',
  );
  for (const m of READER_THEME_MODES) {
    assert.ok(m.label.length > 0 && m.hint.length > 0, `${m.value} 档要有 label 与 hint`);
  }
});

test('颜色集：3 套，取值逐条等于 Config() 的 Kotlin 默认值（ReadBookConfig.kt:870-885）', () => {
  assert.deepEqual(READER_COLORS.day, { bg: '#EEEEEE', text: '#3E3D3B', accent: '#E53935' });
  assert.deepEqual(READER_COLORS.night, { bg: '#000000', text: '#ADADAD', accent: '#FE4D55' });
  assert.deepEqual(READER_COLORS.eink, { bg: '#FFFFFF', text: '#000000', accent: '#000000' });
  // 墨水屏必须是纯黑白（上游就是为此存在）
  assert.equal(READER_COLORS.eink.bg, '#FFFFFF');
  assert.equal(READER_COLORS.eink.text, '#000000');
});

test('readerColorSet：4 档 → 颜色集，「跟随系统」只做 day/night 二选一（不新增第 4 套）', () => {
  assert.equal(readerColorSet('1', false), 'day');
  assert.equal(readerColorSet('1', true), 'day', '显式亮色不受系统偏好影响');
  assert.equal(readerColorSet('2', false), 'night');
  assert.equal(readerColorSet('2', true), 'night', '显式暗色不受系统偏好影响');
  assert.equal(readerColorSet('3', false), 'eink', '墨水屏与系统偏好无关');
  assert.equal(readerColorSet('3', true), 'eink');
  // 跟随系统：由系统偏好决定（对应上游 AppConfig.isNightTheme）
  assert.equal(readerColorSet('0', true), 'night', '跟随系统 + 系统是深色 ⇒ 夜间');
  assert.equal(readerColorSet('0', false), 'day', '跟随系统 + 系统是浅色 ⇒ 白天');
  // 全表覆盖：任何 (档位, 系统偏好) 组合都必须落到 3 套之一
  for (const m of READER_THEME_MODES) {
    for (const dark of [true, false]) {
      assert.ok(
        ['day', 'night', 'eink'].includes(readerColorSet(m.value, dark)),
        `${m.value}/${dark} 必须落到某套已知颜色`,
      );
    }
  }
});

test('normalizeThemeMode：旧值迁移与脏值兜底（迁移错了用户主题会突然变）', () => {
  // 旧值：'dark' → '2'，'sepia' → '1'（**不是等价映射**，见模块注释）
  assert.equal(normalizeThemeMode('dark'), '2');
  assert.equal(normalizeThemeMode('sepia'), '1');
  // 新值原样透传
  for (const v of ['0', '1', '2', '3']) assert.equal(normalizeThemeMode(v), v);
  // 脏值 → 契约默认值 '0'
  for (const bad of [undefined, null, '', 'sepia-dark', 2, {}, [], NaN]) {
    assert.equal(normalizeThemeMode(bad), '0', `脏值 ${JSON.stringify(bad)} 应回落 '0'`);
  }
  // 数字 0~3 是**脏值**（上游存的是字符串）—— 别顺手「帮忙」转换
  assert.equal(normalizeThemeMode(0), '0');
  assert.equal(normalizeThemeMode(1), '0', '数字 1 不是 "1"，必须回落默认');
});

test('isReaderThemeMode：只认四个字符串', () => {
  assert.equal(isReaderThemeMode('3'), true);
  assert.equal(isReaderThemeMode(3), false);
  assert.equal(isReaderThemeMode('4'), false);
});

test('boldWeight：0/1/2 三档映射，不是布尔', () => {
  assert.equal(boldWeight(0), 400);
  assert.equal(boldWeight(1), 700);
  assert.equal(boldWeight(2), 300, '2 是「细体」不是「更粗」');
  assert.equal(boldWeight(undefined), 400, '脏值回落正常');
  assert.equal(boldWeight('1'), 700, '字符串 "1" 也应识别（JSON 往返可能变字符串）');
});

test('cssFontFamily：总带通用回退（浏览器里没有上游那个字体名）', () => {
  const f = cssFontFamily('楷体');
  assert.ok(f.startsWith('楷体,'), '保留用户字体名');
  assert.ok(/sans-serif$/.test(f), '必须有通用回退，否则可能整段变衬线/方块');
  assert.ok(f.includes('system-ui'));
});

test('readerContentVars：单位换算的三处关键点', () => {
  const v = readerContentVars({
    textSize: 20,
    titleSize: 0,
    textBold: 1,
    letterSpacing: 0.1,
    lineSpacingExtra: 12,
    paragraphSpacing: 2,
    paragraphIndent: '　　',
    textFont: '',
    titleFont: '',
  });
  assert.equal(v['--rd-fs'], '20px', '字号直接 px（Android textSize 就是 px 语义）');
  // ★ lineSpacingExtra 是「行高之外的增量」⇒ 不能直接当 line-height
  assert.equal(v['--rd-lh'], 'calc(1em + 12px)', 'lineSpacingExtra 必须是增量语义');
  assert.equal(v['--rd-ls'], '0.1em', 'letterSpacing 是 em');
  assert.equal(v['--rd-indent'], '2em', '两个全角空格 → 2em');
  assert.equal(v['--rd-fw'], '700');
  // ★ titleSize = 0 是哨兵 ⇒ 跟随正文，不能变成 0px
  assert.equal(v['--rd-title-fs'], 'inherit', 'titleSize=0 必须回落到 inherit，不是 0px');
  // 字体为空 = 系统默认 ⇒ 不写变量（让 CSS 继承）
  assert.equal(v['--rd-font'], undefined);
  assert.equal(v['--rd-title-font'], 'inherit', '标题字体空 = 跟随正文');
});

test('readerContentVars：标题字号 > 0 时才单独设置；脏值被 clamp 住', () => {
  const v = readerContentVars({
    textSize: 999, // 越界
    titleSize: 26,
    textBold: 0,
    letterSpacing: -5, // 越界（负太多）
    lineSpacingExtra: -1, // 越界（负数）
    paragraphSpacing: -3,
    paragraphIndent: '', // 无缩进
    textFont: '思源宋体',
    titleFont: '思源黑体',
  });
  assert.equal(v['--rd-fs'], '80px', '字号上限 80 兜底');
  assert.equal(v['--rd-title-fs'], '26px', 'titleSize>0 时单独生效');
  assert.equal(v['--rd-ls'], '-0.2em', '字距下限 -0.2em');
  assert.equal(v['--rd-lh'], 'calc(1em + 0px)', '行距增量不能为负');
  assert.equal(v['--rd-ps'], '0px');
  assert.equal(v['--rd-indent'], '0em', '空缩进 = 0');
  assert.equal(v['--rd-font'], cssFontFamily('思源宋体'));
  assert.equal(v['--rd-title-font'], cssFontFamily('思源黑体'));
});

test('readerContentVars：极端输入不抛错（缺字段 / null / 超长缩进）', () => {
  const v = readerContentVars({
    textSize: null as unknown as number,
    titleSize: undefined as unknown as number,
    textBold: undefined as unknown as number,
    letterSpacing: undefined as unknown as number,
    lineSpacingExtra: NaN,
    paragraphSpacing: NaN,
    paragraphIndent: '　　　　　　　　　　', // 10 个全角空格
    textFont: null as unknown as string,
    titleFont: null as unknown as string,
  });
  assert.equal(v['--rd-fs'], '20px', '缺字号回落上游默认 20');
  assert.equal(v['--rd-lh'], 'calc(1em + 12px)', 'NaN 行距回落 12');
  assert.equal(v['--rd-indent'], '8em', '缩进上限 8em（防超长缩进把首行挤没）');
  assert.equal(v['--rd-font'], undefined, 'null 字体等同空');
});
