/**
 * 高亮样式的换算锁（`#256` 一期，`#258` 补齐高级通道）。
 *
 * ⚠️ **本文件能锁什么、锁不住什么**（先写清楚，免得后人以为「跑绿了就没事」）：
 *  · 锁得住：「样式对象 → CSS 声明」的语义（哪条通道产出哪个属性、空值/0 的回落、
 *    旧数据兼容、形状 class 的取值）；
 *  · 锁不住：「这条声明有没有被 CSS 真的消费」以及「改样式后**正文里那条高亮**真的变了」
 *    —— 那两件事由真浏览器探针 `scripts/probe-256-highlight.mjs` / `probe-258-highlight-advanced.mjs`
 *    读 `computedStyle` 负责（`#145` 就栽在「变量没人消费」上：单测全绿、界面上毫无变化）。
 *
 * ## `#258` 新增的几条**语义锁**（不是「覆盖率的补充」，是防止后人「顺手改合理」）
 *  · ⑧ 着重号与下划线**互斥**，且判据是 `underline == null`（不是「下划线会不会真画出来」）；
 *  · ④ 删除线**不走 `text-decoration`**（改走 `background-image`）⇒ 颜色不被下划线串掉；
 *  · ⑨ `shadow` 字段缺失回落**默认值**（3/2/2）而不是 0（0 在 Android 侧根本不画）；
 *  · ⑪ `fontFamily` 白名单之外一律判「没设置」（防用户数据 → CSS 注入）；
 *  · ⑫ `strike: true`（`#256` 的布尔形态）必须仍能解析（否则老数据静默丢删除线）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HIGHLIGHT_FONT_OPTIONS,
  HIGHLIGHT_PRESETS,
  HIGHLIGHT_STYLE_DEFAULT,
  HIGHLIGHT_STYLE_EMPTY,
  highlightClass,
  highlightStyleVars,
  isHighlightStyleEmpty,
  normalizeHighlightStyle,
  parseHighlightStyle,
  serializeHighlightStyle,
  visibleHighlightStyle,
} from '../src/utils/highlight-style';

/* ---------------- ① 旧数据兼容（最容易造成「静默丢用户数据」的地方） ---------------- */

test('① `#146`~`#255` 落库的旧形态 `underline: "wavy"`（字符串）必须仍能解析出线型', () => {
  const s = parseHighlightStyle('{"fill":"rgba(255,193,7,.28)","underline":"wavy"}');
  assert.equal(s.fill, 'rgba(255,193,7,.28)');
  assert.equal(s.underline?.kind, 'wavy', '旧数据的字符串线型必须被认出来');
  // 旧数据没给 color/width/distance ⇒ 给 null（= 跟随文字色 / 用默认值），不是 0
  assert.equal(s.underline?.color, null);
  assert.equal(s.underline?.width, null);
  assert.equal(s.underline?.distance, null);
});

test('①-防空转：先证明「不兼容会怎样」—— 非法线型字符串不能变成一条实线（那会骗人）', () => {
  // 若实现把「看不懂的字符串」一律当 solid，用户的波浪线会静默变实线
  assert.equal(parseHighlightStyle('{"underline":"squiggly"}').underline, null);
});

test('① 坏 JSON / 非对象 / 数组 一律回落空样式，不抛异常（一条坏数据不能炸掉整章渲染）', () => {
  for (const bad of ['', 'not json', '[]', 'null', '"str"', '{"fill":123}']) {
    const s = parseHighlightStyle(bad as string);
    assert.equal(isHighlightStyleEmpty(s), true, `坏输入 ${JSON.stringify(bad)} 应回落成空样式`);
  }
});

/* ---------------- ② 往返 ---------------- */

test('② 序列化 → 解析 往返保真（二期加字段时这条会红，提醒同步 parse/serialize）', () => {
  const s = normalizeHighlightStyle({
    fill: 'rgba(255,241,118,.5)',
    fillShape: 'pill',
    textColor: '#d32f2f',
    underline: { kind: 'dotted', color: '#1976d2', width: 2.5, distance: 6 },
    strike: true,
    bold: true,
    italic: true,
  });
  assert.deepEqual(parseHighlightStyle(serializeHighlightStyle(s)), s);
});

test('② 归一化：越界值收进上游区间，认不出的形状/线型回落默认', () => {
  const s = normalizeHighlightStyle({
    fillShape: 'hexagon' as never,
    underline: { kind: 'zigzag' as never, width: 99, distance: -5 },
  });
  assert.equal(s.fillShape, 'rectangle');
  assert.equal(s.underline?.kind, 'solid');
  assert.equal(s.underline?.width, 10, '上游 MAX_WIDTH = 10');
  assert.equal(s.underline?.distance, 0, '上游 MIN_DISTANCE = 0');
});

/* ---------------- ③ 「空」的判据 ---------------- */

test('③ 「空样式」是逐通道判的，不是「JSON 是不是空串」（上游 `HighlightStyle.isEmpty`）', () => {
  assert.equal(isHighlightStyleEmpty(parseHighlightStyle('')), true);
  assert.equal(isHighlightStyleEmpty(parseHighlightStyle('{"bold":false,"strike":false}')), true);
  assert.equal(isHighlightStyleEmpty(parseHighlightStyle('{"bold":true}')), false);
  assert.equal(isHighlightStyleEmpty(parseHighlightStyle('{"fillShape":"pill"}')), true, '只改形状不算「有样式」');
});

test('③ ★ 空样式**渲染时**回落到默认样式（老数据里 style 为空串时，才不会变成「什么都没有」）', () => {
  const v = visibleHighlightStyle(parseHighlightStyle(''));
  assert.equal(v.fill, HIGHLIGHT_STYLE_DEFAULT.fill);
  assert.ok(v.underline, '默认样式带一条下划线 —— 墨水屏白底上纯底色看不出，这是 #146 的老理由');
  // 防空转：不空的样式**不能被默认样式覆盖**
  const mine = parseHighlightStyle('{"textColor":"#388e3c"}');
  assert.equal(visibleHighlightStyle(mine).textColor, '#388e3c');
  assert.equal(visibleHighlightStyle(mine).fill, null, '用户只要文字色时，不该被塞一个默认底色');
});

/* ---------------- ④ 样式 → CSS ---------------- */

test('④ 各通道产出对应的 CSS 声明', () => {
  const v = highlightStyleVars(parseHighlightStyle(JSON.stringify({
    fill: 'rgba(79,195,247,.5)',
    textColor: '#d32f2f',
    bold: true,
    italic: true,
    strike: true,
    underline: { kind: 'wavy', color: '#e53935', width: 2, distance: 5 },
  })));
  // ★ `#258` 起底色写的是 `background-color`（不是 `background` 简写）：
  //   删除线改用 `background-image` 层画（见下），简写会把那一层**冲掉**
  assert.equal(v['background-color'], 'rgba(79,195,247,.5)');
  assert.equal(v['color'], '#d32f2f');
  assert.equal(v['font-weight'], '700');
  assert.equal(v['font-style'], 'italic');
  // ★★ `#258` 起**删除线不再走 `text-decoration`** ⇒ 这里只剩 `underline` 一条。
  //   这条断言正是「删除线与下划线解耦」的锁（改回去就红）。
  assert.equal(v['text-decoration-line'], 'underline');
  assert.equal(v['text-decoration-style'], 'wavy');
  assert.equal(v['text-decoration-color'], '#e53935');
  assert.equal(v['text-decoration-thickness'], '2px');
  // ★ `text-underline-offset` 必须**单独**一条：CSS 的 `text-decoration` 简写不接受它
  //   （本仓 `#164` 在全局下划线上踩过同一个坑，见 apps/web/tests/read-style.test.ts）
  assert.equal(v['text-underline-offset'], '5px');
  assert.ok(!('text-decoration' in v), '不能产出 text-decoration 简写（会把 offset 吃掉）');
  // 删除线：一层 `linear-gradient`，`currentColor` = 跟随文字色（上游 `Deco(color=0)` ⇒ fallbackColor）
  assert.equal(v['background-image'], 'linear-gradient(currentColor, currentColor)');
  assert.equal(v['background-size'], '100% 1.5px', '1.5px = 上游 defaultStrokeWidth');
  assert.equal(v['background-position'], '0 50%');
  assert.equal(v['background-repeat'], 'no-repeat');
});

test('④ ★★ 删除线的颜色**独立于下划线**（`#258` 解耦；若谁改回 text-decoration，这条会红）', () => {
  // 灰删除线 + 红波浪下划线：两条线颜色/线型完全不同 —— CSS 的 `text-decoration-*` 做不到
  // （它整条线共用一套），所以删除线改走 background-image。上游本就是各画各的
  // （`HighlightDraw.kt:189-241`，下划线用 underline.color、strike 用 strike.color）。
  const v = highlightStyleVars(parseHighlightStyle(JSON.stringify({
    strike: { color: '#9e9e9e' },
    underline: { kind: 'wavy', color: '#e53935', width: 1, distance: 2 },
  })));
  assert.equal(v['text-decoration-color'], '#e53935', '下划线用自己的红色');
  assert.equal(v['text-decoration-style'], 'wavy', '下划线用自己的波浪');
  assert.equal(v['background-image'], 'linear-gradient(#9e9e9e, #9e9e9e)', '删除线用自己的灰色');
  // 防空转：**只有删除线**时不该产出任何 text-decoration（证明上面那条不是「碰巧」）
  const v2 = highlightStyleVars(parseHighlightStyle('{"strike":{"color":"#9e9e9e"}}'));
  assert.equal(v2['text-decoration-line'], undefined);
  assert.equal(v2['background-image'], 'linear-gradient(#9e9e9e, #9e9e9e)');
});

test('④ ★ `width <= 0` ⇒ 不画下划线（上游 `TextLine.kt:288` 的判据），不是画 0px 的线', () => {
  const v = highlightStyleVars(parseHighlightStyle('{"underline":{"kind":"solid","width":0}}'));
  assert.equal(v['text-decoration-line'], undefined);
  // 防空转：width > 0 时必须真的画（证明上一条不是「怎么都不画」）
  const v2 = highlightStyleVars(parseHighlightStyle('{"underline":{"kind":"solid","width":1}}'));
  assert.equal(v2['text-decoration-line'], 'underline');
});

test('④ ★★ 高亮的下划线**只由这条高亮自己的样式决定** —— 不与「阅读样式的全局下划线」混用', () => {
  // 只有底色、没有任何下划线通道 ⇒ 一条 text-decoration 都不该产出。
  // 若哪天有人把 `GlobalReaderPrefs.underlineMode/underlineColor/underlineWidth/underlineDistance`
  // 接进来当默认值，这条会红（那正是用户 `#256` 点名不许的「混用」）。
  const v = highlightStyleVars(parseHighlightStyle('{"fill":"rgba(255,241,118,.5)"}'));
  assert.equal(v['background-color'], 'rgba(255,241,118,.5)');
  for (const k of Object.keys(v)) {
    assert.ok(!k.startsWith('text-decoration'), `不该产出 ${k}：下划线开关只在「这条高亮」自己的样式里`);
  }
});

/* ---------------- ⑤ 形状 ---------------- */

test('⑤ 形状 class：默认矩形、6 种各有其 class，缺省/非法都落在 rectangle', () => {
  assert.deepEqual(highlightClass({ fillShape: undefined }), ['rd-hl-shape-rectangle']);
  // `#258` 起 6 种齐（上游 BaseSource 的 FillShape 枚举也是 6 个：RECTANGLE/ROUNDED/MARKER/HALF/BASELINE/PILL）
  for (const shape of ['rectangle', 'rounded', 'pill', 'marker', 'half', 'baseline'] as const) {
    assert.ok(highlightClass({ fillShape: shape }).includes(`rd-hl-shape-${shape}`), shape);
  }
});

/* ---------------- ⑥ 预设 ---------------- */

test('⑥ 预设 7 条（`#258` 起与上游 `HighlightStyles.presets` 数量一致），且没有空预设', () => {
  assert.equal(HIGHLIGHT_PRESETS.length, 7, '上游 HighlightStyles.presets 是 7 条');
  for (const p of HIGHLIGHT_PRESETS) {
    assert.ok(p.label, '每条预设都要有名字（模板用它做 title）');
    assert.equal(isHighlightStyleEmpty(p.style), false, `预设「${p.label}」是空的 ⇒ 点了没反应`);
  }
  // ★ 上游第 7 条 = `emphasis = Deco(0xFFE53935)`（着重号），`#258` 起真的做进去了
  const last = HIGHLIGHT_PRESETS[6];
  assert.ok(last.style.emphasis, '第 7 条必须是着重号（上游 presets[6]）');
  // ★ 上游第 3 条 = `fillShape = HALF` —— `#256` 时因为没实现 HALF 才临时用 marker，
  //   `#258` 起必须**归位**（否则用户点「绿底」看到的是马克笔、不是下半）
  assert.equal(HIGHLIGHT_PRESETS[2].style.fillShape, 'half', '上游 presets[2] 是 HALF');
  assert.ok(!HIGHLIGHT_PRESETS.some((p) => p.style.fillShape === 'marker'), '不该再有临时顶替的 marker');
});

test('⑥ 默认样式本身是「非空」的（否则新建的高亮会看不见）', () => {
  assert.equal(isHighlightStyleEmpty(HIGHLIGHT_STYLE_EMPTY), true);
  assert.equal(isHighlightStyleEmpty(HIGHLIGHT_STYLE_DEFAULT), false);
});

/* ---------------- ⑦ `#258` 六种形状：half / baseline 只能用 background-image 画 -------- */

test('⑦ ★ half / baseline 两条形状产出「一条带」而不是铺满（`background-color` 做不到）', () => {
  const half = highlightStyleVars({ fill: '#f00', fillShape: 'half' });
  assert.match(half['background-image']!, /^linear-gradient\(to bottom, transparent 0 30%, #f00 30%\)$/);
  assert.equal(half['background-color'], undefined, 'half 不能同时给 background-color（那就铺满了）');
  assert.equal(half['background-size'], '100% 100%');

  const base = highlightStyleVars({ fill: '#f00', fillShape: 'baseline' });
  assert.match(base['background-image']!, /transparent 0 82%, #f00 82% 96%, transparent 96%/);
  assert.equal(base['background-color'], undefined);

  // 防空转：**矩形**必须仍走 background-color（证明上面两条不是「所有形状都这样」）
  const rect = highlightStyleVars({ fill: '#f00', fillShape: 'rectangle' });
  assert.equal(rect['background-color'], '#f00');
  assert.equal(rect['background-image'], undefined);
});

test('⑦ ★ 删除线 + half 底色共存时是**两层** image，且删除线在上层（先写的在上）', () => {
  const v = highlightStyleVars({ fill: '#f00', fillShape: 'half', strike: { color: '#000' } });
  // ⚠️ 不能用 `split(', ')` 数层数：`linear-gradient(a, b)` 自己就含 `, `（第一版就是这么错的）
  assert.equal(
    v['background-image'],
    'linear-gradient(#000, #000), linear-gradient(to bottom, transparent 0 30%, #f00 30%)',
    '删除线在前（= 上层），底色带在后',
  );
  // size/position/repeat 必须与 image 层**一一对应**（少一个就整条 CSS 失效）；
  // 这三个属性的值里不含逗号 ⇒ 可以安全按 `, ` 数层数
  assert.equal(v['background-size'], '100% 1.5px, 100% 100%');
  assert.equal(v['background-position'], '0 50%, 0 0');
  assert.equal(v['background-repeat'], 'no-repeat, no-repeat');
});

/* ---------------- ⑧ 着重号与下划线**互斥**（上游语义，照抄不「优化」） ---------------- */

test('⑧ ★★ 有下划线通道时**不画**着重号（上游 `TextColumn.kt:95` 的 `takeIf { it.underline == null }`）', () => {
  const both = highlightStyleVars({
    emphasis: { color: '#e53935' },
    underline: { kind: 'solid', color: null, width: 1, distance: 0 },
  });
  assert.equal(both['text-emphasis-style'], undefined, '有下划线 ⇒ 着重号不画（两者都在字下，会重叠）');

  const only = highlightStyleVars({ emphasis: { color: '#e53935' } });
  assert.equal(only['text-emphasis-style'], 'dot');
  assert.equal(only['text-emphasis-color'], '#e53935');
  assert.equal(only['text-emphasis-position'], 'under right', '中文着重号在字下');

  // ★ 判据是 **`underline == null`**，不是「下划线会不会真的画出来」：
  //   上游只要**有** underline 对象就不画着重号 —— 哪怕 `width = 0`（本仓此时代码不画下划线）。
  //   这条是「别顺手把判据改合理」的锁。
  const zeroWidth = highlightStyleVars({
    emphasis: { color: '#e53935' },
    underline: { kind: 'solid', color: null, width: 0, distance: 0 },
  });
  assert.equal(zeroWidth['text-emphasis-style'], undefined, 'width=0 ⇒ 不画下划线，但着重号**也不画**（上游语义）');
  assert.equal(zeroWidth['text-decoration-line'], undefined);

  // 防空转：`color: null` ⇒ 跟随文字色（不是「没有颜色」= 不画）
  const follow = highlightStyleVars({ emphasis: {} });
  assert.equal(follow['text-emphasis-color'], 'currentColor');
});

/* ---------------- ⑨ 文字阴影 / 外发光 ---------------- */

test('⑨ shadow → `text-shadow`；缺字段用上游默认值（3/2/2），**不是 0**', () => {
  const full = highlightStyleVars({ shadow: { radius: 5, dx: -3, dy: 4, color: '#1e88e5' } });
  assert.equal(full['text-shadow'], '-3px 4px 5px #1e88e5');

  // ★★ 只给颜色时，radius/dx/dy 必须回落到默认（3/2/2）：
  //   若错误地回落成 0，`text-shadow: 0 0 0 #000` 在 Android 侧**根本不画**（`setShadowLayer` 要求 radius>0）
  //   ⇒ 用户「开了阴影没反应」，且从 JSON 里看不出问题。
  const onlyColor = highlightStyleVars({ shadow: { color: 'red' } });
  assert.equal(onlyColor['text-shadow'], '2px 2px 3px red');

  // 外发光 = dx/dy 归 0（上游没有单独的 glow 通道）
  const glow = highlightStyleVars({ shadow: { radius: 6, dx: 0, dy: 0, color: '#ffd54f' } });
  assert.equal(glow['text-shadow'], '0px 0px 6px #ffd54f');

  // 防空转：没有 shadow ⇒ 一条 text-shadow 都不产出
  assert.equal(highlightStyleVars({ bold: true })['text-shadow'], undefined);
});

test('⑨ 归一化：shadow 区间**逐条对齐上游**（radius 0..10、dx/dy -10..10）', () => {
  const s = normalizeHighlightStyle({ shadow: { radius: 99, dx: -99, dy: 99 } });
  assert.equal(s.shadow?.radius, 10, '上游 Shadow.normalized 的 MAX');
  assert.equal(s.shadow?.dx, -10);
  assert.equal(s.shadow?.dy, 10);
  const neg = normalizeHighlightStyle({ shadow: { radius: -5 } });
  assert.equal(neg.shadow?.radius, 0, '上游 MIN = 0');
});

/* ---------------- ⑩ 方框着重框 ---------------- */

test('⑩ box → `border` + **`box-decoration-break: clone`**（跨行时每行都要画完整框）', () => {
  const v = highlightStyleVars({ box: { color: '#388e3c' } });
  assert.equal(v['border'], '1.5px solid #388e3c', '1.5px = 上游 defaultStrokeWidth');
  // ★ 默认值 `slice` 在跨行时只画首尾两侧，而上游是**按行内 run 各画一个整框**
  //   （`HighlightDraw.kt:243-261` 每行调用一次）⇒ 必须 clone
  assert.equal(v['box-decoration-break'], 'clone');
  assert.equal(v['-webkit-box-decoration-break'], 'clone');

  // `color: null` ⇒ 跟随文字色（上游 fallbackColor）
  assert.equal(highlightStyleVars({ box: {} })['border'], '1.5px solid currentColor');

  // 防空转：没有 box ⇒ 没有 border
  assert.equal(highlightStyleVars({ fill: '#f00' })['border'], undefined);
});

/* ---------------- ⑪ 字体（本仓扩展字段）+ 注入防线 ---------------- */

test('⑪ fontFamily → `font-family`；**白名单之外一律判为没设置**（防 CSS 注入）', () => {
  assert.equal(highlightStyleVars({ fontFamily: 'serif' })['font-family'], 'serif');
  const kai = HIGHLIGHT_FONT_OPTIONS.find((o) => o.label === '楷体')!.value;
  assert.equal(highlightStyleVars({ fontFamily: kai })['font-family'], kai);

  // ★★ 这个样式来自「每条高亮的 JSON」⇒ 任意字符串直接拼进 CSS 就是一条注入通道
  const evil = 'serif; } body { display: none';
  assert.equal(normalizeHighlightStyle({ fontFamily: evil }).fontFamily, null, '不在白名单 ⇒ 判为没设置');
  assert.equal(highlightStyleVars({ fontFamily: evil })['font-family'], undefined);
  assert.equal(parseHighlightStyle(JSON.stringify({ fontFamily: evil })).fontFamily, null);
  // 上游 `fontPath`（本机文件路径）也不该被当字体族写进 CSS
  assert.equal(parseHighlightStyle('{"fontPath":"/sdcard/fonts/x.ttf"}').fontFamily, null);
});

/* ---------------- ⑫ `#258` 新字段的往返与旧数据兜底 ---------------- */

test('⑫ 新字段（box/emphasis/shadow/fontFamily/strike色）往返保真', () => {
  const s = normalizeHighlightStyle({
    fill: 'rgba(255,241,118,.5)',
    fillShape: 'baseline',
    strike: { color: '#9e9e9e' },
    box: { color: '#388e3c' },
    emphasis: { color: null },
    shadow: { radius: 4, dx: 1, dy: -1, color: 'rgba(0,0,0,.5)' },
    fontFamily: 'monospace',
  });
  assert.deepEqual(parseHighlightStyle(serializeHighlightStyle(s)), s);
});

test('⑫ ★★ `#256` 落库的 `strike: true`（布尔）必须仍解析成「有删除线」', () => {
  // 不兼容 ⇒ 用户已有的删除线在升级后**整条消失**（与 underline 从字符串变对象是同一个坑）
  const s = parseHighlightStyle('{"strike":true}');
  assert.deepEqual(s.strike, { color: null }, 'true ⇒ 跟随文字色（不是 null）');
  assert.equal(isHighlightStyleEmpty(s), false, '有删除线的样式不能算「空」');
  assert.equal(highlightStyleVars(s)['background-image'], 'linear-gradient(currentColor, currentColor)');
  // 归一化后落库就是新形态（**升级**，不是丢数据）
  assert.equal(serializeHighlightStyle(s), '{"fill":null,"fillShape":"rectangle","textColor":null,"underline":null,"strike":{"color":null},"box":null,"emphasis":null,"shadow":null,"fontFamily":null,"bold":false,"italic":false}');

  // 防空转：`false` / 缺失 / 非法都必须是「没有删除线」
  for (const bad of ['{"strike":false}', '{}', '{"strike":"yes"}', '{"strike":0}']) {
    assert.equal(parseHighlightStyle(bad).strike, null, bad);
  }
});

test('⑫ 新通道也算「有样式」（`isEmpty` 逐通道判，别漏掉新加的）', () => {
  for (const one of [
    { box: {} }, { emphasis: {} }, { shadow: {} }, { fontFamily: 'serif' }, { strike: true },
  ]) {
    assert.equal(isHighlightStyleEmpty(one), false, JSON.stringify(one));
    // ★ 防空转的另一半：这些通道**不能**被 `visibleHighlightStyle` 当成空而塞上默认底色
    //   （用 `ok(!…)` 而不是 `equal(…, null)`：非空样式是**原样返回**，`fill` 是 `undefined` 而非 `null`）
    assert.ok(!visibleHighlightStyle(one as never).fill, JSON.stringify(one));
  }
  assert.equal(isHighlightStyleEmpty({ strike: false, box: null, shadow: null }), true);
});

test('⑫ highlightClass 也认新通道（`rd-hl-box` / `rd-hl-emphasis` / …）', () => {
  assert.ok(highlightClass({ box: {} }).includes('rd-hl-box'));
  assert.ok(highlightClass({ shadow: {} }).includes('rd-hl-shadow'));
  assert.ok(highlightClass({ fontFamily: 'serif' }).includes('rd-hl-font'));
  assert.ok(highlightClass({ strike: { color: '#000' } }).includes('rd-hl-strike'));
  assert.ok(highlightClass({ emphasis: {} }).includes('rd-hl-emphasis'));
  // ★ 有下划线时着重号 class 也不该有（与 ⑧ 同一条互斥语义，class 与 vars 不能各说各话）
  assert.ok(!highlightClass({ emphasis: {}, underline: { kind: 'solid' } }).includes('rd-hl-emphasis'));
});
