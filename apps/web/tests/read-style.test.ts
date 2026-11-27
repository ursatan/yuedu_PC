/**
 * 阅读样式 → CSS 的换算锁（`#164`）。
 *
 * ⚠️ **本文件能锁的东西有限**，先写清楚边界（免得后人以为「跑绿了就没事」）：
 *  · 这里只锁「**函数输出对不对**」（变量名、单位、回落、开关语义）；
 *  · 它**锁不住**「这条变量有没有被 CSS 真的消费」—— `#145` 就栽在这里：
 *    `.rd-content p` 在样式表里有**两条同权重规则**，后一条硬编码 `margin/text-indent`，
 *    把 `--rd-ps` / `--rd-indent` 整个压掉，而当时的单测与探针**都没断言排版真的生效**。
 *  · ⇒ 「生效」那一段由真浏览器探针 `scripts/probe-164-read-style.mjs` 负责（读 computed style）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyGlobalReaderPrefs, mergeReadStyle, pickReadStyle } from '@yuedu/core/contract';
import {
  READER_COLORS,
  bgColorOf,
  readStyleColors,
  readerContentVars,
  underlineOf,
  underlineColorOf,
  titleColorOf,
  textColorOf,
} from '../src/styles/reader-theme';

/** 取一份「默认全局样式」 */
const style = () => mergeReadStyle(emptyGlobalReaderPrefs(), null);

test('① 防空转：READER_COLORS 必须**派生自契约默认值**（硬编码 hex 会在这里红）', () => {
  const d = emptyGlobalReaderPrefs();
  assert.deepEqual(READER_COLORS.day, { bg: d.bgStr, text: d.textColor, accent: d.textAccentColor });
  assert.deepEqual(READER_COLORS.night, { bg: d.bgStrNight, text: d.textColorNight, accent: d.textAccentColorNight });
  assert.deepEqual(READER_COLORS.eink, { bg: d.bgStrEInk, text: d.textColorEInk, accent: d.textAccentColorEInk });
});

test('② 段距 / 缩进 / 字号 / 行距 真的进了变量（`#145` 那两个被压掉的键的源码侧锁）', () => {
  const s = { ...style(), paragraphSpacing: 17, paragraphIndent: '　', textSize: 26, lineSpacingExtra: 30 };
  const v = readerContentVars(s);
  assert.equal(v['--rd-ps'], '17px');
  assert.equal(v['--rd-indent'], '1em', '缩进按**字符个数**折 em（1 个全角空格 ⇒ 1em）');
  assert.equal(v['--rd-fs'], '26px');
  assert.equal(v['--rd-lh'], 'calc(1em + 30px)', '行距是**增量**，不是 line-height 数值');
});

test('③ 正文边距进变量，且默认值与上游一致（6/16/16/6）', () => {
  const v = readerContentVars(style());
  assert.equal(v['--rd-pt'], '6px');
  assert.equal(v['--rd-pr'], '16px');
  assert.equal(v['--rd-pb'], '6px');
  assert.equal(v['--rd-pl'], '16px');
});

test('④ 标题四项：位置 / 上下间距 / 行高**乘数**', () => {
  const v = readerContentVars({ ...style(), titleMode: 1, titleTopSpacing: 12, titleBottomSpacing: 4, titleLineSpacingExtra: 20 });
  assert.equal(v['--rd-title-align'], 'center');
  assert.equal(v['--rd-title-display'], 'block');
  assert.equal(v['--rd-title-mt'], '12px');
  assert.equal(v['--rd-title-mb'], '4px');
  // 上游 ChapterProvider.kt:308-309：(100 + v) / 100 ⇒ 20 → 1.2
  assert.equal(v['--rd-title-lh'], 'calc(var(--rd-lh) * 1.2)');

  const hidden = readerContentVars({ ...style(), titleMode: 2 });
  assert.equal(hidden['--rd-title-display'], 'none', 'titleMode=2 是「隐藏」（TextChapterLayout.kt:165）');
});

test('⑤ 下划线：关 / 宽度为 0 / 分部开关，三种都必须**不画**', () => {
  assert.equal(underlineOf({ ...style(), underlineMode: 1, underlineWidth: 0 }, 'body'), null, '宽度 0 ⇒ 不画');
  assert.equal(underlineOf(style(), 'body'), null, 'mode 0 ⇒ 不画');
  assert.equal(
    underlineOf({ ...style(), underlineMode: 1, underlineBodyEnabled: false }, 'body'),
    null,
    '正文开关关掉 ⇒ 正文不画',
  );
  assert.ok(
    underlineOf({ ...style(), underlineMode: 1, underlineBodyEnabled: false }, 'title'),
    '正文关了不影响标题（两个开关是分开的）',
  );
});

test('⑥ 下划线返回的是**三个分量**，不是一整条 text-decoration', () => {
  const u = underlineOf({ ...style(), underlineMode: 5, underlineWidth: 2, underlineDistance: 7 }, 'body');
  assert.deepEqual(u, { style: 'wavy', thickness: '2px', offset: '7px' });
  // ★ 这条是硬约束：CSS 的 `text-decoration` 简写**不接受** text-underline-offset，
  //   塞进去整条声明会被判非法而**静默失效**。所以 offset 必须单独一条。
  assert.ok(!JSON.stringify(u).includes('text-decoration'), 'offset 不许混进简写');
});

test('⑦ 双虚线（6）CSS 无对应 ⇒ 回落虚线，但**不返回 null**（有下划线只是风格不同）', () => {
  const u = underlineOf({ ...style(), underlineMode: 6 }, 'body');
  assert.equal(u?.style, 'dashed');
});

test('⑧ 颜色：null 跟随正文色；强调色按槽取；字号/脏值回落**同一槽**而不是统一回落到 day', () => {
  const s = { ...style(), titleColor: null, underlineColor: null };
  assert.equal(titleColorOf(s, 'night'), textColorOf(s, 'night'), 'titleColor=null ⇒ 跟随正文色');
  assert.equal(underlineColorOf(s, 'eink'), textColorOf(s, 'eink'));

  const night = readStyleColors({ ...style(), bgStrNight: '不是颜色' }, 'night');
  assert.equal(night.bg, READER_COLORS.night.bg, '夜间背景写坏 ⇒ 回落到**夜间**默认，而不是白天默认');
});

test('⑨ #250 bgAlpha 不再混进底色（只作用背景图层，见 PageView.kt:329-344）', () => {
  const s = style();
  // ★ 这条断言在 `#250` **被推翻重写**：旧版断言 bgAlpha=50 ⇒ 底色变 rgba(...,0.5)，
  //   那正是用户 2026-10-04 报的 bug（拖「背景透明度」⇒ 底色在淡、背景图纹丝不动）。
  //   上游 `LayerDrawable(bgMeanColor, bg)` 的第一层恒不透明，alpha 只给第二层。
  //   更细的锁（图片层透明度 / 栏位开关）见 `reader-bg-alpha.test.ts`。
  assert.equal(bgColorOf({ ...s, bgStr: '#112233', bgAlpha: 100 }, 'day'), '#112233');
  assert.equal(bgColorOf({ ...s, bgStr: '#112233', bgAlpha: 50 }, 'day'), '#112233', '底色不参与 alpha');
  assert.equal(bgColorOf({ ...s, bgStr: '#112233', bgAlpha: 0 }, 'day'), '#112233', 'alpha=0 也不淡底色');
});

test('⑩ 防空转：每本覆盖经 pickReadStyle 后过 readerContentVars，覆盖值必须生效', () => {
  const g = emptyGlobalReaderPrefs();
  const effective = mergeReadStyle(g, { textSize: 44 });
  assert.equal(readerContentVars(effective)['--rd-fs'], '44px');
  // 反向：只覆盖字号时，别的键保持全局（`{...g, ...o}` 那种写法会在这里红）
  assert.equal(readerContentVars(effective)['--rd-ps'], readerContentVars(pickReadStyle(g))['--rd-ps']);
});
