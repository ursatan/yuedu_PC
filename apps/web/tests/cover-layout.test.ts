/**
 * `#177` 生成封面的**竖排逐字布局** —— 回归锁。
 *
 * ## 为什么要锁这些数字（而不是截图对比）
 * 上游 `coverTitleColumnOffsets`（`CoverImageView.kt:100-135`）里有一堆魔数：
 * `0.2`（起始 Y 占比）、`0.8`（提前换列阈值）、`0.9`（强制换列/压缩阈值）、
 * `textHeight/5`（最后两字压缩量）。任何一个被「顺手优化」掉，封面就会变形，
 * 但**不会报错、不会崩**，只看截图很容易漏。
 * ⇒ 把它们锁成可断言的数值，并**用 Kotlin 源码逐条对表**（每条断言的注释里写了出处行号）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  COVER_AUTHOR_BOTTOM,
  COVER_CHAR_GAP,
  COVER_COLUMN_GAP,
  coverAuthorLayout,
  coverHorizontalLayout,
  coverTitleColumnStartY,
  coverTitleColumns,
  coverTitleLayout,
} from '../src/styles/ui-theme';

/** 常用画布：宽 300高 450（本仓卡片 2:3，见 ui-theme 的说明） */
const W = 300;
const H = 450;

test('★ coverTitleColumnOffsets：短书名只有一列', () => {
  // 4 个字、字号 300/7≈42.9、行高≈51.4 ⇒ 远达不到 0.8*H=360
  const th = (W / 7) * 1.2;
  const cols = coverTitleColumns(4, H, th);
  assert.equal(cols.length, 1, `4 个字应只有 1 列，实得 ${cols.length}`);
  assert.deepEqual(cols[0], [0, th, th * 2, th * 3], '第 k 个字的偏移 = k 倍行高');
});

test('★ coverTitleColumns：越过 0.8*H（且剩 >2 字）就换列', () => {
  // 造一个字高10px 的场景：0.8*100=80、0.9*100=90 ⇒ 第9字越过 0.8 且剩 >2 ⇒ 换列
  const cols = coverTitleColumns(20, 100, 10);
  assert.ok(cols.length > 1, `20 字/高100 应有多列，实得 ${cols.length}`);
  // 第一列不该超过 0.8*H + 一行（换列发生在越线那一刻）
  assert.ok(cols[0].length <= 9, `首列字数应≤9，实得 ${cols[0].length}`);
  //所有字都要被分配出去，一个都不能丢
  assert.equal(cols.reduce((n, c) => n + c.length, 0), 20, '总字数必须守恒');
});

test('★ coverTitleColumns：总字数守恒（绝不丢字/重复）', () => {
  for (const [n, h, th] of [[1, 100, 10], [7, 200, 14], [40, 450, 51], [100, 450, 20]] as const) {
    const cols = coverTitleColumns(n, h, th);
    assert.equal(cols.reduce((s, c) => s + c.length, 0), n, `${n}字/${h}px 的总字数应守恒`);
  }
});

test('★ coverTitleColumns：非法输入返回空而不是崩', () => {
  assert.deepEqual(coverTitleColumns(0, 100, 10), []);
  assert.deepEqual(coverTitleColumns(-1, 100, 10), []);
  assert.deepEqual(coverTitleColumns(5, 0, 10), []);
  assert.deepEqual(coverTitleColumns(5, 100, 0), []);
});

test('★ coverTitleColumnStartY：各列**底部对齐**（短列往下压）', () => {
  // 上游 :94-98 —— `top + max(0, maxColumnBottom - columnBottom)`
  assert.equal(coverTitleColumnStartY(20, 100, 100), 20, '最长列⇒ 从 top 开始');
  assert.equal(coverTitleColumnStartY(20, 100, 60), 60, '短 40⇒ 下压 40');
  // ⚠️ 底比max 还长时不能往上顶（上游用 coerceAtLeast(0)）
  assert.equal(coverTitleColumnStartY(20, 60, 100), 20, '不可能发生，但要防负偏移');
});

test('★ coverTitleLayout：列 x = 0.2*宽 + 字号*COVER_COLUMN_GAP*列序', () => {
  const l = coverTitleLayout('一二三四五六七八九十十一十二', W, H, 7);
  const ts = W / 7;
  l.columns.forEach((c, i) => {
    assert.ok(Math.abs(c.x - (W * 0.2 + ts * COVER_COLUMN_GAP * i)) < 1e-9,
      `第 ${i} 列 x 应 = 0.2*宽 + 字号*${COVER_COLUMN_GAP}*${i}`);
  });
  // ★ 步进系数必须 > 1：竖排字是方形、字宽=字号 ⇒ 步进=字号 ⇒ 列间净空为 0，
  //   描边会互相吃掉（用户 2026-10-01：「字与字上下左右应有适当间距」）。
  assert.ok(COVER_COLUMN_GAP > 1, '列步进系数必须 > 1，否则列间没有净空');
});

test('★ coverTitleLayout：渲染行高比分列行高多 COVER_CHAR_GAP（防描边吃字距）', () => {
  // 回归锁的是**这次缺陷的根因**（用户 2026-10-01 实测「竖排：下方文字遮挡上方文字」）：
  // 分列按上游 textSize*1.2，渲染必须按 textSize*(1.2+GAP) —— 两者不可混用。
  const l = coverTitleLayout('一二三四五六七八九十十一十二', W, H, 7);
  assert.ok(Math.abs(l.renderLineHeight - l.textSize * (1.2 + COVER_CHAR_GAP)) < 1e-9,
    `渲染行高应 = 字号*(1.2+${COVER_CHAR_GAP})，实际 ${l.renderLineHeight}`);
  assert.ok(l.renderLineHeight > l.textHeight,
    '渲染行高必须**大于**分列行高，否则渲染行距会比决策行距紧 ⇒ 描边粘连复发');
  // ★ 净空下限：外圈描边外扩 ≈0.11em ⇒ 低于 0.10em 内圈也会粘连。
  //   0.16→0.12 是 `#186` 二轮用户在「描边粘连」与「字距偏松」之间的拍板取舍。
  assert.ok(COVER_CHAR_GAP >= 0.1, `净空 ${COVER_CHAR_GAP} 过小，描边会粘连（下限 0.10）`);
});

test('★ coverAuthorLayout：作者列也要有渲染行高（与书名列同口径）', () => {
  const a = coverAuthorLayout('江余舟', W, H);
  assert.ok(Math.abs(a.renderLineHeight - a.textSize * (1.2 + COVER_CHAR_GAP)) < 1e-9,
    '作者列的渲染行高与书名列必须同一口径，否则作者那列的字会粘连');
});

test('★ 竖排：列末不能撞进作者列（x + 半字宽 < 0.8*宽 - 半字宽）', () => {
  // 步进从 1.0 提到 1.18 的**副作用收益**：长书名列数上限从 6 降到 5，
  // 最后一列的描边不再压到作者那一列上（上游那个步进会撞）。
  const l = coverTitleLayout('南风寻秋弃子掉马京圈财闰童命将他宠坏', W, H, 9);
  const last = l.columns[l.columns.length - 1];
  assert.ok(last, '本样本应至少有一列');
  const halfTitle = l.textSize / 2;
  const halfAuthor = (W / 10) / 2;
  assert.ok(last.x + halfTitle + halfTitle <= W * 0.8 - halfAuthor,
    `末列 x=${last.x} 与作者列 x=${W * 0.8} 会相撞`);
});

test('★ coverTitleLayout：底部对齐（渲染坐标系）—— 各列渲染列底必须相等', () => {
  // ★ `#186` 修正后的不变量：决策按 textHeight、渲染按 renderLineHeight，
  //   列顶必须补偿 `字数×(renderLineHeight - textHeight)`，
  //   否则**字多的列往下多坠**（`#181` 加字距时悄悄破坏了对齐）。
  const l = coverTitleLayout('一二三四五六七八九十十一十二', W, H, 7);
  if (l.columns.length < 2) return; // 字数太少只有一列，本条不适用
  const bottoms = l.columns.map((c) => c.y + c.chars.length * l.renderLineHeight);
  const b0 = bottoms[0];
  for (const [i, b] of bottoms.entries()) {
    assert.ok(Math.abs(b - b0) < 1e-6,
      `第 ${i} 列渲染列底 ${b.toFixed(2)} 应与第 0 列 ${b0.toFixed(2)} 对齐`);
  }
  // 渲染列底 = 0.2H + 最长列字数×渲染步进（y 公式直接保证）
  const tallest = l.columns[0].chars.length;
  const expect = H * 0.2 + tallest * l.renderLineHeight;
  assert.ok(Math.abs(bottoms[0] - expect) < 1e-6,
    `渲染列底应为 ${expect.toFixed(2)}（0.2H+最长列字数×步进），实得 ${bottoms[0].toFixed(2)}`);
  // em 底（字形实际下沿的近似）= 列盒底 − 半行距，必须 ≤ 0.9H（分列容量按渲染步进算的结果）
  const half = (l.renderLineHeight - l.textHeight) / 2;
  const emBottom = bottoms[0] - half;
  assert.ok(emBottom <= H * 0.9 + 1e-6,
    `最长列 em 底 ${emBottom.toFixed(1)} 越过 0.9H=${(H * 0.9).toFixed(1)}`);
});

test('★ #186 二轮：7 字书名（2:3 卡）必须分两列，末字 em 底不得越过 0.9H', () => {
  // 用户实测截图：「斗罗之诸天卡牌」「我为人间斩太岁」（7 字）在旧容量下排 1 列，
  // 渲染列底 ≈0.98H ⇒ 压过默认封面 0.930H 的装饰横线。发现页 grid 卡 ≈146×219。
  const l = coverTitleLayout('斗罗之诸天卡牌', 146, 219, 7);
  assert.ok(l.columns.length >= 2,
    `7 字书名应分成 ≥2 列（渲染感知容量），实得 ${l.columns.length} 列`);
  for (const [i, c] of l.columns.entries()) {
    const emBottom = c.y + c.chars.length * l.renderLineHeight - (l.renderLineHeight - l.textHeight) / 2;
    assert.ok(emBottom <= 219 * 0.9 + 1e-6,
      `第 ${i} 列 em 底 ${emBottom.toFixed(1)} 越过 0.9H=${(219 * 0.9).toFixed(1)}`);
  }
});

test('★ #186 渲染列底不得压过默认封面下方的装饰横线（2:3 零裁切时线在 0.930H）', () => {
  // 内置默认封面 600×900 实测：下方三条装饰线在 0.930 / 0.938 / 0.955（距顶）
  for (const [text, div] of [['一二三四五六七八九十十一十二', 7], ['南风寻秋弃子掉马京圈财闰童命将他宠坏', 9]] as const) {
    const l = coverTitleLayout(text, W, H, div);
    for (const [i, c] of l.columns.entries()) {
      const bottom = c.y + c.chars.length * l.renderLineHeight;
      assert.ok(bottom <= H * 0.93 + 1e-6,
        `[${div}] 第 ${i} 列渲染列底 ${bottom.toFixed(1)} 越过 0.930H=${(H * 0.93).toFixed(1)}`);
    }
    const a = coverAuthorLayout('废飞凋', W, H);
    const abottom = a.y + a.chars.length * a.renderLineHeight;
    assert.ok(abottom <= H * 0.93 + 1e-6,
      `[${div}] 作者列底 ${abottom.toFixed(1)} 越过 0.930H=${(H * 0.93).toFixed(1)}`);
  }
});

test('★ coverTitleLayout：字符按列顺序正确切分（逐字推进 nameIndex）', () => {
  const text = '一二三四五六七八九十';
  const l = coverTitleLayout(text, W, H, 7);
  assert.equal(l.columns.map((c) => c.chars.join('')).join(''), text,
    '各列字符拼起来必须**逐字等于**原书名（顺序也不能错）');
});

test('★ coverAuthorLayout：x = 0.8*宽，字号 = 宽/10（上游 :407/:411）', () => {
  const a = coverAuthorLayout('江余舟', W, H);
  assert.ok(Math.abs(a.x - W * 0.8) < 1e-9, '作者 x 应 = 0.8*宽');
  assert.ok(Math.abs(a.textSize - W / 10) < 1e-9, '作者字号应 = 宽/10');
});

test('★ coverAuthorLayout：y = max(0.92*高 - 字数*渲染行高, 0.3*高)（#186：0.95 会压过默认封面装饰线）', () => {
  const text = '江余舟';
  const textSize = W / 10;
  const renderLineHeight = textSize * (1.2 + COVER_CHAR_GAP);
  const expect = Math.max(H * 0.92 - 3 * renderLineHeight, H * 0.3);
  const a = coverAuthorLayout(text, W, H);
  assert.ok(Math.abs(a.y - expect) < 1e-9, `作者 y 应 = ${expect.toFixed(2)}，实得 ${a.y.toFixed(2)}`);
  // ★ 底线常量必须 < 0.930（内置默认封面最上一条下方装饰横线的位置）
  assert.ok(COVER_AUTHOR_BOTTOM < 0.93, `COVER_AUTHOR_BOTTOM=${COVER_AUTHOR_BOTTOM} 必须 < 0.93`);
  assert.ok(COVER_AUTHOR_BOTTOM > 0.9, '也别收得太高 —— 0.9 以下会压进书名列的换列区');
});

test('★ coverAuthorLayout：作者过长时被截断，列底（整行盒口径）不越 0.92*高', () => {
  const a = coverAuthorLayout('一'.repeat(60), W, H);
  assert.ok(a.chars.length < 60, '超长作者应被截断');
  assert.equal(a.truncated, 60 - a.chars.length, 'truncated 计数要对得上');
  // ★ #186：渲染列底 = y + 字数×渲染行高，必须 ≤ 0.92H（装饰线 0.930H 之上）
  const bottom = a.y + a.chars.length * a.renderLineHeight;
  assert.ok(bottom <= H * 0.92 + 1e-6,
    `作者列底 ${bottom.toFixed(1)} 不应超过 0.92H=${(H * 0.92).toFixed(1)}`);
});

test('★ #186 coverHorizontalLayout：竖版容器字号与旧 CSS 口径一致（宽/档位），不受高度约束影响', () => {
  // 2:3（112×168）：旧实现 font-size = 100cqw/7 = 16 ⇒ 新函数必须给出同值，否则竖版横排观感回退
  const l = coverHorizontalLayout(112, 168, 5);
  assert.ok(Math.abs(l.titleSize - 112 / 7) < 1e-9,
    `2:3 下 titleSize 应 = 宽/7 = ${(112 / 7).toFixed(2)}，实得 ${l.titleSize.toFixed(2)}`);
  const l9 = coverHorizontalLayout(112, 168, 12);
  assert.ok(Math.abs(l9.titleSize - 112 / 9) < 1e-9, '长书名（≥10字）应落到 /9 档');
});

test('★ #186 coverHorizontalLayout：16:10 宽扁容器按高度约束缩字号，4 行必须放得下', () => {
  const W2 = 260, H2 = 162.5; // minmax(260px,1fr) 的横屏卡片
  const l = coverHorizontalLayout(W2, H2, 5);
  // 4 行 × 1.34 行高 + 顶距 ≤ 0.92H（作者基线区之上）
  const used = l.titleTop + 4 * 1.34 * l.titleSize;
  assert.ok(used <= H2 * 0.92 + 1e-6,
    `4 行总高 ${used.toFixed(1)} 超过可用 ${(H2 * 0.92).toFixed(1)}（titleSize=${l.titleSize.toFixed(2)}）`);
  assert.ok(l.titleSize < W2 / 7, '宽扁下必须比「宽/7」小，否则就是高度约束没生效');
  // 作者字号同样受高度约束
  assert.ok(l.authorSize <= H2 * 0.16 / 1.6 + 1e-9, '作者字号不应超过预留行高');
});

test('★ #186 coverHorizontalLayout：非法输入返回 0（组件据以外退到 CSS 兜底）', () => {
  const l = coverHorizontalLayout(0, 0, 5);
  assert.equal(l.titleSize, 0);
  assert.equal(l.titleTop, 0);
});

test('★ coverAuthorLayout：极短画布上y 被兜到 0.3*高（不会跑到顶外）', () => {
  const a = coverAuthorLayout('一二三四五六七八九十', W, 60);
  assert.ok(a.y >= 60 * 0.3 - 1e-9, `y 应≥ 0.3*高，实得 ${a.y}`);
});

test('边界：封面尺寸为 0 时不崩、不返回 NaN 坐标', () => {
  const l = coverTitleLayout('测试书名', 0, 0, 7);
  assert.deepEqual(l.columns, [], '宽高为 0 ⇒ 无列');
  const a = coverAuthorLayout('作者', 0, 0);
  assert.ok(Number.isFinite(a.y) && Number.isFinite(a.x), '坐标不能是 NaN/Infinity');
});

test('★ 横排不受影响：本轮只改竖排，横排仍交给 CSS', () => {
  // 断言「同一份布局函数对横排无副作用」：divisor 变化只影响字号，不影响结构完整性
  const a = coverTitleLayout('一二三四五六七八九十', W, H, 7);
  const b = coverTitleLayout('一二三四五六七八九十', W, H, 9);
  assert.ok(b.textSize < a.textSize, '÷9 的字号必须小于 ÷7');
  assert.equal(
    a.columns.map((c) => c.chars.join('')).join(''),
    b.columns.map((c) => c.chars.join('')).join(''),
    '两档字号下字符切分必须一致（只有字号变）',
  );
});

/* ---- `#186` 源码级护栏：封面元素的占位底色禁止 `background` 简写 ----
 * `background` 简写会把 `background-size`/`background-position` 重置为 `auto`/`0% 0%`。
 * `CoverImage` 的底图缩放靠 scoped 的 `.cv-gen[data-v-x] { background-size: cover }`（特异性 0,2,0），
 * 页面侧同类特异性的规则（`.item-card .cover` 等）**谁靠后谁赢** ⇒ 一旦写成简写，
 * 默认封面就退回原始尺寸绘制（只露左上角）。这类缺陷不报错、截图上一眼难定位 ⇒ 锁源码。 */
test('★ #186 回归锁：封面占位底色必须用 background-color 长写（简写重置 background-size）', () => {
  const cases: Array<[string, string]> = [
    ['../src/styles/theme.css', '.poster {'],
    ['../src/styles/theme.css', '.item-card .cover {'],
    ['../src/views/DashboardView.vue', '.poster { position'],
    ['../src/views/ShelfView.vue', '.book-card .poster {'],
    ['../src/views/VideoLibView.vue', '.poster { position'],
  ];
  for (const [file, sel] of cases) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    const at = css.indexOf(sel);
    assert.ok(at >= 0, `${file} 里应能找到 \`${sel}\`（选择器被改名就同步改本清单）`);
    // ⚠️ 用**花括号计数**找规则体结束，不能 indexOf('}')——
    //   规则内的注释可能嵌 `{ ... }`（本文件就有一处），会被提前截断造成假失败。
    const open = css.indexOf('{', at);
    let depth = 1;
    let end = open;
    while (depth > 0 && end < css.length) {
      end += 1;
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') depth -= 1;
    }
    const body = css.slice(at, end);
    assert.ok(!/(^|[^-])background\s*:/.test(body),
      `${file} 的 \`${sel}\` 里出现了 background 简写 ⇒ 会重置 background-size（默认封面只显示左上角）`);
    assert.ok(/background-color\s*:/.test(body),
      `${file} 的 \`${sel}\` 应保留 background-color 长写（占位底色）`);
  }
});