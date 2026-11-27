/**
 * `#354` loginUi 行排版的回归锁。
 *
 * ## 为什么要锁
 * 用户报「login 界面排版乱，按钮、输入框没按 loginUi 排列」。根因：源作者用
 * `RowUi.style.layout_flexBasisPercent` 表达的排版意图**被前端完全丢弃** ——
 * 所有 button 被抽进独立的 `.lg-actions` 等宽平铺，`0.25`（一行 4 个）与 `1`（整行）
 * 渲染出来长得一样。
 *
 * 这类 bug 的特点是**不报错、不崩、控制台干净**，只是「看着乱」⇒ 靠肉眼看截图很难发现
 * 回归。判据抽到 `utils/login-layout.ts` 后，这里用真源数据把语义钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLoginRowFull, loginRowStyle } from '../src/utils/login-layout';

test('#354 flexBasisPercent 必须转成 CSS flex-basis 百分比（小数比例 ×100）', () => {
  // 一行 4 个
  assert.deepEqual(loginRowStyle({ type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.25 } }), {
    flexBasis: '25%',
    maxWidth: '25%',
    flexGrow: '1',
  });
  // 整行标题
  assert.deepEqual(loginRowStyle({ type: 'button', style: { flexGrow: 1, flexBasisPercent: 1 } }), {
    flexBasis: '100%',
    flexGrow: '1',
  });
});

test('#354 ★ maxWidth 必须跟着 basis（否则 flexGrow 会把行拉满 ⇒ 排版失效）', () => {
  // 源里 `flexBasisPercent: 0.3` 常与 `flexGrow: 1` 同时出现。只写 flex-basis 时，
  // flex-grow 会把该行撑到超出 30%（同一行的兄弟被挤走）⇒ 必须同时设 max-width。
  const s = loginRowStyle({ type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.3 } });
  assert.equal(s.flexBasis, '30%');
  assert.equal(s.maxWidth, '30%', 'grow 与 basis 并存时必须封顶');

  // 整行（100%）不需要 max-width（本来就不该被 grow 影响）
  const full = loginRowStyle({ type: 'button', style: { flexGrow: 1, flexBasisPercent: 1 } });
  assert.equal(full.maxWidth, undefined);
});

test('#354 未设 basis（上游默认 -1）时不写 flex-basis，退化为按内容宽', () => {
  assert.deepEqual(loginRowStyle({ type: 'button' }), {});
  assert.deepEqual(loginRowStyle({ type: 'button', style: { flexBasisPercent: -1 } }), {});
  // 只给 flexGrow 也要生效
  assert.deepEqual(loginRowStyle({ type: 'button', style: { flexGrow: 2 } }), { flexGrow: '2' });
});

test('#354 表单控件与说明行恒为整行（源里通常不带 style）', () => {
  assert.equal(isLoginRowFull({ type: 'text' }), true, '账号必须独占一行');
  assert.equal(isLoginRowFull({ type: 'password' }), true);
  assert.equal(isLoginRowFull({ type: 'select' }), true);
  assert.equal(isLoginRowFull({ type: 'label' }), true);
  // 带 25% 也不该被压成 1/4 行
  assert.equal(isLoginRowFull({ type: 'text', style: { flexBasisPercent: 0.25 } }), true, '表单控件无视 basis，恒整行');
});

test('#354 按钮：无 style 按内容宽；basis>=1 视为整行分隔标题', () => {
  assert.equal(isLoginRowFull({ type: 'button' }), false);
  assert.equal(isLoginRowFull({ type: 'button', style: { flexBasisPercent: 0.25 } }), false);
  assert.equal(isLoginRowFull({ type: 'button', style: { flexBasisPercent: 1 } }), true, '分隔标题占满行');
});

test('#354 ★ 禁漫天堂真源：20 行的排版分组必须与源作者的 basis 一致', () => {
  // 源数据（data/sources/book-482/https___jmcomicui.net.json 的真实 loginUi 摘要）
  const rows = [
    { name: '账号', type: 'text' },
    { name: '密码', type: 'password' },
    { name: '点击切换分流', type: 'button', style: { flexGrow: 1, flexBasisPercent: 1 } },
    { name: '切换分流线路(1-4)', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.3 } },
    { name: '切换国际线路', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.3 } },
    { name: '切换东南亚线路', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.3 } },
    { name: '获取/切换国内直连', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.3 } },
    { name: '点击切换排序', type: 'button', style: { flexGrow: 1, flexBasisPercent: 1 } },
    { name: '时间', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.25 } },
    { name: '阅读', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.25 } },
    { name: '最爱', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.25 } },
    { name: '收藏', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.25 } },
    { name: '每周必看索引', type: 'button', style: { flexGrow: 1, flexBasisPercent: 1 } },
    { name: '重置', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.2 } },
    { name: '随机', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.2 } },
    { name: '+1', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.2 } },
    { name: '-1', type: 'button', style: { flexGrow: 1, flexBasisPercent: 0.2 } },
  ];

  // 「点击切换分流」这类是**分隔标题**（button 但 basis=1）⇒ 必须占满行，不能混进按钮堆里
  assert.equal(isLoginRowFull(rows[2]!), true, '「点击切换分流」是分隔标题，必须整行');
  assert.equal(isLoginRowFull(rows[7]!), true, '「点击切换排序」同理');
  assert.equal(isLoginRowFull(rows[12]!), true, '「每周必看索引」同理');

  // 4 个排序按钮：一行 4 个（25%）
  for (const n of ['时间', '阅读', '最爱', '收藏']) {
    const r = rows.find((x) => x.name === n)!;
    assert.equal(loginRowStyle(r).flexBasis, '25%', `${n} 应占 1/4 行`);
    assert.equal(isLoginRowFull(r), false, `${n} 不该整行`);
  }
  // 4 个索引按钮：一行 5 个位（20%）
  for (const n of ['重置', '随机', '+1', '-1']) {
    const r = rows.find((x) => x.name === n)!;
    assert.equal(loginRowStyle(r).flexBasis, '20%', `${n} 应占 1/5 行`);
  }

  // 顺序不能被打乱：渲染必须按 `fields` 原序（上游 flexbox.addView 就是顺序 add）
  assert.deepEqual(
    rows.map((r) => r.name).slice(0, 3),
    ['账号', '密码', '点击切换分流'],
    '渲染顺序 = 源数组顺序（不能按 type 分组重排）',
  );
});
