/**
 * `#163` 界面主题的**纯函数**回归锁（不碰 DOM / 不碰 Vue —— 浏览器侧行为由探针 `probe-163-ui-theme.mjs` 验）。
 *
 * 重点锁四类**容易静默错**的东西：
 *  ① **判槽**（`themeMode` + 系统偏好 → 日槽还是夜槽）—— 上游 `AppConfig.kt:172-178` 的三分支里
 *     **`"3"`（墨水屏）→ false** 这条最容易被漏（按直觉会以为墨水屏算夜间）；
 *  ② **hex 解析** —— 上游存的是 **ARGB 8 位**（alpha 在前），按 RGBA 解析会把颜色整个错位；
 *  ③ **封面文字清洗** —— `keepPunctuation=false` 要去掉 **Unicode 标点类 `\p{P}`**，
 *     但**不能**把「符号类」（`★`/`→` 这类 `\p{S}`）一起删了（上游的 bdRegex 就是 `\p{P}`，不是 `\p{P}|\p{S}`）；
 *  ④ **默认主题派生** —— 「深色（本仓）」必须把界面锁在暗色，否则「跟随系统 + 系统浅色」
 *     会让整个界面突然变亮（一次没人要求的视觉变更）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyGlobalReaderPrefs, emptyUiCoverConfig, type UiThemeConfig } from '@yuedu/core/contract';

import {
  contrastOn,
  coverParamsFor,
  coverTextColors,
  coverTitleDivisor,
  effectiveUiTheme,
  isLightColor,
  normalizeCoverText,
  parseHex,
  relLuminance,
  uiNightActive,
  uiThemeVars,
  useDefaultCover,
  toRrGgBb,
  wallpaperCss,
} from '../src/styles/ui-theme';

const D = emptyGlobalReaderPrefs();

/** 上游 themeConfig.json 的「默认」套（日间、亮底） */
const LIGHT: UiThemeConfig = { ...D.uiDayTheme, ...pick(D.uiThemes, '默认') };
/** 上游「黑白」（夜间、暗底） */
const BLACKWHITE: UiThemeConfig = { ...D.uiDayTheme, ...pick(D.uiThemes, '黑白') };
/** 本仓自有「深色（本仓）」（夜间、暗底） */
const DARK: UiThemeConfig = pick(D.uiThemes, '深色（本仓）')!;

function pick(list: UiThemeConfig[], name: string): UiThemeConfig | undefined {
  return list.find((t) => t.themeName === name);
}

/* ---------------- hex 解析（ARGB 的坑） ---------------- */

test('parseHex：6 位是普通 RGB；8 位按上游语义当 ARGB（alpha 在前）', () => {
  assert.deepEqual(parseHex('#795548'), { r: 0x79, g: 0x55, b: 0x48, a: 1 });
  // 上游 applyConfig 写出的是 "#${Color.hexString}" —— ARGB。若按 RGBA 解析，r=0xff g=0xc0…整个错位
  const argb = parseHex('#ffc0edc6');
  assert.equal(argb.a, 1);
  assert.equal(argb.r, 0xc0);
  assert.equal(argb.g, 0xed);
  assert.equal(argb.b, 0xc6);
  assert.deepEqual(parseHex('#f00'), { r: 0xff, g: 0, b: 0, a: 1 }, '3 位是 CSS 短写法');
  assert.deepEqual(parseHex('不是颜色'), { r: 0, g: 0, b: 0, a: 1 }, '脏值落回黑，不抛错');
  assert.deepEqual(parseHex(''), { r: 0, g: 0, b: 0, a: 1 }, '空串落回黑（契约可空）');
});

test('isLightColor / relLuminance：上游四套预设的明暗判定正确', () => {
  assert.equal(isLightColor('#F5F5F5'), true, '默认/典雅蓝的底是亮的');
  assert.equal(isLightColor('#0B0D12'), false, '本仓深色的底是暗的');
  assert.equal(isLightColor('#424242'), false, '黑白的底是暗的（0.26 亮度）');
  assert.equal(isLightColor('#EEEEEE'), true, '底栏 #EEEEEE 是亮的');
  assert.ok(relLuminance(parseHex('#FFFFFF')) > relLuminance(parseHex('#424242')));
});

/* ---------------- 判槽（AppConfig.kt:172-178 逐分支） ---------------- */

test('uiNightActive：照抄 AppConfig.isNightTheme 的 getter（含「墨水屏不算夜间」这条）', () => {
  assert.equal(uiNightActive('1', true), false, '"1" 亮色 → 永远 false');
  assert.equal(uiNightActive('2', false), true, '"2" 暗色 → 永远 true');
  assert.equal(uiNightActive('3', true), false, '"3" 墨水屏 → false（AppConfig.kt:175，最易漏的一条）');
  assert.equal(uiNightActive('0', true), true, '"0" 跟随系统 + 系统深色 → true');
  assert.equal(uiNightActive('0', false), false, '"0" 跟随系统 + 系统浅色 → false');
  assert.equal(uiNightActive('', true), true, '其它/脏值 → 跟随系统（else 分支）');
});

test('effectiveUiTheme：墨水屏强制黑白，不取日/夜槽（ThemeConfig.kt:398-406 的 EInk 分支）', () => {
  const t = effectiveUiTheme('3', true, LIGHT, BLACKWHITE);
  assert.equal(t.backgroundColor, '#FFFFFF', 'E-Ink 分支 background = 白');
  assert.equal(t.themeName, '', '派生的墨水屏不是一套用户主题（别出现在主题列表里）');
  assert.equal(effectiveUiTheme('2', false, LIGHT, BLACKWHITE).themeName, '黑白', '"2" → 夜槽');
  assert.equal(effectiveUiTheme('1', true, LIGHT, BLACKWHITE).themeName, '默认', '"1" → 日槽');
});

/* ---------------- 主题 → CSS 变量 ---------------- */

test('「深色（本仓）」：界面必须保持暗色，且核心变量与原 theme.css 字面值一致', () => {
  const v = uiThemeVars(DARK);
  assert.equal(isLightColor(v['--bg-0']!), false, '--bg-0 必须是暗底');
  assert.equal(v['--bg-0'], '#0B0D12', '页面底 = 原 --bg-0 字面值');
  assert.equal(v['--bg-1'], '#11141B', '侧栏/顶栏底 = 原 --bg-1 字面值（bottomBackground 的映射）');
  assert.equal(v['--brand'], '#4F8CFF', '主色 = 原 --brand 字面值');
  assert.equal(v['--text-0'], '#E8ECF1', '文本用暗色那组（即 theme.css 原值），默认观感不变');
  assert.equal(v['--ui-page-bg'], 'var(--bg-0)', '没壁纸时页面底就是 --bg-0');
  assert.equal(v['--ui-wallpaper'], 'none');
});

test('亮色主题：文本自动换到亮底那组，边框由文字色派生（不再是写死的白色系）', () => {
  const v = uiThemeVars(LIGHT);
  assert.equal(isLightColor(v['--bg-0']!), true);
  assert.equal(v['--text-0'], '#1B1E24', '亮底 → 深色文字');
  assert.ok(!v['--border']!.includes('255, 255, 255'), '边框若仍是白系，亮底上会整个看不见');
  // 卡片必须比页面「浮」一层：亮底上更暗、暗底上更亮 —— 用亮度判断，别比较字符串
  assert.ok(
    relLuminance(parseHex(v['--bg-2']!)) < relLuminance(parseHex(v['--bg-0']!)),
    '亮底主题：--bg-2 应比页面底更暗',
  );
});

test('暗色主题：卡片比页面底更亮（方向不能反）', () => {
  const v = uiThemeVars(DARK);
  assert.ok(relLuminance(parseHex(v['--bg-2']!)) > relLuminance(parseHex(v['--bg-0']!)));
  assert.ok(relLuminance(parseHex(v['--bg-3']!)) > relLuminance(parseHex(v['--bg-2']!)));
});

test('--on-brand 跟着主色的明暗走（主色被换成亮色时按钮文字不能再是 #fff）', () => {
  assert.equal(uiThemeVars(DARK)['--on-brand'], '#FFFFFF', '深色主题主色 #4F8CFF 上用白字');
  const brightPrimary: UiThemeConfig = { ...DARK, primaryColor: '#FFEB3B' };
  assert.equal(uiThemeVars(brightPrimary)['--on-brand'], '#0B0D12', '亮黄主色上必须用深字');
  assert.equal(contrastOn('#FFFFFF'), '#0B0D12');
});

test('toRrGgBb：喂给 <input type="color"> 前必须剥掉 alpha（该控件不吃 8 位）', () => {
  assert.equal(toRrGgBb('#ffc0edc6'), '#c0edc6', 'ARGB 8 位 → 剥 alpha');
  assert.equal(toRrGgBb('#4F8CFF'), '#4f8cff', '6 位原样（统一小写）');
  assert.equal(toRrGgBb(''), '#888888', '空串给灰，别给空值让取色器清空');
  assert.equal(toRrGgBb(null), '#888888');
});

test('底栏沉浸 / 壁纸：transparentNavBar 让侧栏透底，壁纸让页面底透明', () => {
  const withWall: UiThemeConfig = { ...DARK, backgroundImgPath: 'https://example.com/bg.jpg', transparentNavBar: true };
  const v = uiThemeVars(withWall);
  assert.equal(v['--nav-bg'], 'transparent', '沉浸导航 → 侧栏/顶栏不铺底色');
  assert.equal(v['--ui-page-bg'], 'transparent', '有壁纸 → 页面底透明（否则壁纸被盖住，永远看不见）');
  assert.equal(v['--ui-wallpaper'], 'url("https://example.com/bg.jpg")');
  assert.match(v['--ui-wallpaper-blur']!, /^(\d+)px$/);
  // 默认主题：不沉浸、不透明
  assert.equal(uiThemeVars(DARK)['--nav-bg'], '#11141B');
  assert.equal(uiThemeVars(DARK)['--ui-page-bg'], 'var(--bg-0)');
});

test('wallpaperCss：只放行预设 / http(s) / data:image —— file: 与 javascript: 必须拒掉', () => {
  assert.equal(wallpaperCss(null), 'none');
  assert.equal(wallpaperCss(''), 'none');
  assert.equal(wallpaperCss('wp-ink'), 'linear-gradient(160deg, #232946 0%, #121629 60%, #0b0d12 100%)', '内置预设按 id 命中');
  assert.equal(wallpaperCss('http://x/a.png'), 'url("http://x/a.png")');
  assert.equal(wallpaperCss('data:image/png;base64,AAA'), 'url("data:image/png;base64,AAA")');
  assert.equal(wallpaperCss('file:///C:/x.png'), 'none', 'file: 既加载不了也不该加载');
  assert.equal(wallpaperCss('javascript:alert(1)'), 'none', '拒绝脚本型 scheme');
  assert.equal(wallpaperCss('wp-不存在'), 'none', '未知 id 当作没有，别把它塞进 url()');
});

test('blur 护栏：负数/超界/脏值都要钳到 0~40px（不能把 NaN 写进 CSS）', () => {
  assert.equal(uiThemeVars({ ...DARK, backgroundImgBlur: -5 })['--ui-wallpaper-blur'], '0px');
  assert.equal(uiThemeVars({ ...DARK, backgroundImgBlur: 999 })['--ui-wallpaper-blur'], '40px');
  assert.equal(uiThemeVars({ ...DARK, backgroundImgBlur: Number.NaN })['--ui-wallpaper-blur'], '0px');
});

/* ---------------- 封面（BookCover.kt / CoverImageView.kt） ---------------- */

test('normalizeCoverText：照抄上游 —— 去的是 Unicode 标点类 \\p{P}，不是符号类 \\p{S}', () => {
  assert.equal(normalizeCoverText('斗破苍穹（全集）', false), '斗破苍穹全集', '全角括号是 \\p{P}，会被去掉');
  assert.equal(normalizeCoverText('斗破苍穹（全集）', true), '斗破苍穹（全集）', 'keepPunctuation=true 原样保留');
  assert.equal(normalizeCoverText(' 一拳超人！', false), '一拳超人', '首尾空白要裁（上游两处都是 .trim()）');
  assert.equal(normalizeCoverText('★和→与°', false), '★和→与°', '符号类 \\p{S} 不在 \\p{P} 里，必须保留');
  assert.equal(normalizeCoverText('《书名·上》', false), '书名上', '间隔号 · 属于 \\p{P}（Po）');
  assert.equal(normalizeCoverText(null, false), '', '上游返回 null，这里收敛成空串（消费端好判空）');
  assert.equal(normalizeCoverText('　全角空白　', false), '全角空白', '全角空白也要被 trim 掉');
});

test('coverParamsFor：日夜槽各取各的，横排/保留标点/强制默认封面是全局的', () => {
  const cfg = {
    ...emptyUiCoverConfig(),
    coverShowName: true,
    coverShowAuthor: false,
    coverShowNameN: false,
    coverShowAuthorN: true,
    defaultCoverPath: 'https://a/day.png',
    defaultCoverDarkPath: 'https://a/night.png',
  };
  assert.deepEqual(coverParamsFor(cfg, false), { showName: true, showAuthor: false, bgImage: 'https://a/day.png' });
  assert.deepEqual(coverParamsFor(cfg, true), { showName: false, showAuthor: true, bgImage: 'https://a/night.png' });
  assert.equal(coverParamsFor({ ...cfg, coverHorizontal: true }, false).showName, true, '横排不影响 showName 的取值');
  // 空 URL 时回落到内置默认封面（上游 Legado 的 image_cover_default.jpg）
  assert.equal(coverParamsFor(emptyUiCoverConfig(), false).bgImage, '/assets/default-cover.jpg');
});

test('useDefaultCover：强制开关优先；真实封面为空也走默认封面', () => {
  const off = emptyUiCoverConfig();
  assert.equal(useDefaultCover('https://a.png', off), false, '有真实封面且未强制 → 不用默认');
  assert.equal(useDefaultCover('', off), true, '没封面 → 用默认');
  assert.equal(useDefaultCover('   ', off), true, '纯空白封面地址 → 用默认');
  assert.equal(useDefaultCover('https://a.png', { ...off, useDefaultCover: true }), true, '强制开关优先级最高');
});

/* ---------------- 生成封面的文字配色（本轮修掉的「浅底白字看不见」） ---------------- */

test('coverTextColors：深浅双圈描边 —— 底图明暗未知时任意一侧都兜得住', () => {
  // ★ 本轮的真缺陷：旧实现写死 `color: rgba(255,255,255,.94)` 白字 + 黑投影，
  //   而内置默认封面 assets/default-cover.jpg 是**浅色宣纸底** ⇒ 白字完全看不见。
  // 修法不是「换成另一个写死的颜色」，而是深浅各一圈（底图明暗判断不出来）。
  for (const t of D.uiThemes) {
    const c = coverTextColors(t.accentColor, t.backgroundColor);
    // ⚠️ `relLuminance` 只看 RGB、不管 alpha ⇒ 这里判「圈的色极性」，
    //   alpha 必须**单独**断言（否则「透明度 0 = 隐形描边」这种假通过会被放过）
    assert.ok(relLuminance(parseHex(c.strokeDark)) < 0.1, `主题「${t.themeName}」深圈必须够深（实得 ${c.strokeDark}）`);
    assert.ok(relLuminance(parseHex(c.strokeLight)) > 0.7, `主题「${t.themeName}」浅圈必须够亮（实得 ${c.strokeLight}）`);
    assert.ok(c.alpha > 0.5, `描边要有实际可见度（alpha=${c.alpha}，0 = 隐形）`);
    // ★ 防空转：色极性写死就等于「没接线」——断言两圈确实是一黑一白，不是同一个值
    assert.notEqual(c.strokeDark, c.strokeLight, '深浅两圈必须是不同色');
  }
  // 外圈必须比内圈宽（CSS text-shadow 靠偏移量分层，宽度相同就只剩一圈）
  const w = coverTextColors(DARK.accentColor, DARK.backgroundColor);
  const px = (em: string): number => parseFloat(em) * 100;
  assert.ok(px(w.strokeWidthOuter) > px(w.strokeWidth), `外圈(${w.strokeWidthOuter}) 要宽于内圈(${w.strokeWidth})`);
  // ★ 防空转：字面不能被「一律退回黑白」吞掉 —— 强调色本身够艳时要保留用户选的颜色
  assert.equal(w.fill, toRrGgBb(DARK.accentColor), '强调色与主题底色拉得开 ⇒ 原样保留');
  // 同色系（accent 与底色几乎一样）⇒ 字面必须退回黑/白，否则「描边是描边、字还是糊的」
  const same = coverTextColors('#20242C', '#0B0D12');
  assert.equal(same.fill, '#FFFFFF', '字面与主题底色太接近 ⇒ 退回纯白');
  const sameLight = coverTextColors('#F0F0F2', '#F5F5F5');
  assert.equal(sameLight.fill, '#0B0D12', '亮底同色系 ⇒ 退回纯黑');
});

test('coverTitleDivisor：长书名降一档 —— 阈值按本仓 3:4 竖版封面解（上游 4:3 解出的是 9）', () => {
  assert.equal(coverTitleDivisor(1), 7);
  assert.equal(coverTitleDivisor(9), 7, '9 字仍是 /7');
  assert.equal(coverTitleDivisor(10), 9, '10 字起降档（本仓 高/宽=1.5 的解）');
  assert.equal(coverTitleDivisor(40), 9, '再长也不更小（上游只有 7/9 两档）');
  // ★ 代数自证：上游条件 (n-2)*h > H*0.7，高/宽=1.5、h=W/7 ⇒ n > 2 + 1.5*0.7*7 = 9.35 ⇒ n≥10
  const W = 100, ratio = 1.5, largeTextHeight = W / 7;
  const small = [...Array(30).keys()].map((i) => i + 1).filter(
    (n) => (n - 2) * largeTextHeight > W * ratio * 0.7 || (n - 3) * largeTextHeight > W * ratio * 0.6,
  );
  assert.equal(small[0], 10, '按 3:4 竖版代入，首个触发降档的字数是 10（与函数一致，不是拍脑袋）');
  // 对照：若按上游 4:3（高/宽=1.3333）代入，首个触发是 9 —— 说明差异来自比例而非抄错
  const small43 = [...Array(30).keys()].map((i) => i + 1).filter(
    (n) => (n - 2) * largeTextHeight > W * (4 / 3) * 0.7 || (n - 3) * largeTextHeight > W * (4 / 3) * 0.6,
  );
  assert.equal(small43[0], 9, '上游 4:3 比例下是 9 —— 与文档注释里的说明一致');
});
