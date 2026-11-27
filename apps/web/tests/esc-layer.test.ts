/**
 * `#459` **Esc 层级栈**的行为锁 + 三个浮层的接线锁。
 *
 * ## 用户原话（2026-10-14）
 * 「目前的阅读浮层，播放器浮层，详情浮层，等界面都会因为鼠标点击界面外部而关闭，
 *   修正：只能通过关闭按钮，Esc 按键（**只关闭/退出当前**）关闭；点击浮层界面外部不关闭。」
 *
 * 两层证据：
 *  · 行为 —— 直接用最小 `window` 垫片驱动栈（web 包没有 jsdom，见 `in-app-browser.test.ts` 的约定）；
 *  · 接线 —— 源码断言三个浮层：不再有 `@click.self` 关自己、且都入栈 `pushEscLayer`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

/* ── 最小 window 垫片：只够 `pushEscLayer` 用（addEventListener 捕获阶段的 keydown） ── */
type KeyListener = (e: Record<string, unknown>) => void;
const listeners: KeyListener[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, cb: KeyListener) => {
    if (type === 'keydown') listeners.push(cb);
  },
};

/** 构造一个 Escape 事件（记录是否被 prevent/stop，target 可指定为输入框） */
function esc(target: unknown = null): { e: Record<string, unknown>; prevented: () => boolean; stopped: () => boolean } {
  let p = false;
  let s = false;
  return {
    e: {
      key: 'Escape',
      target,
      preventDefault: () => { p = true; },
      stopPropagation: () => { s = true; },
    },
    prevented: () => p,
    stopped: () => s,
  };
}

function dispatch(e: Record<string, unknown>): void {
  for (const l of listeners) l(e);
}

const { pushEscLayer, escLayerDepth } = await import('../src/utils/esc-layer');

test('#459 Esc 只交给栈顶那一层（后开的先关，其余不受影响）', () => {
  const closed: string[] = [];
  const popA = pushEscLayer(() => closed.push('A'));
  assert.equal(listeners.length, 1, '全局只应挂**一个** keydown 监听（不再各浮层各挂一个）');
  const popB = pushEscLayer(() => closed.push('B'));
  assert.equal(listeners.length, 1, '多次入栈也不再多挂监听');
  assert.equal(escLayerDepth(), 2);

  const first = esc();
  dispatch(first.e);
  assert.deepEqual(closed, ['B'], '只关最上层');
  assert.ok(first.prevented(), '必须 preventDefault');
  // ⚠️ 刻意**不** stopPropagation：子对话框的 Esc 监听还要能跑（见 esc-layer 顶部说明）
  assert.ok(!first.stopped(), '不得 stopPropagation（否则子对话框的 Esc 失效）');

  popB();
  dispatch(esc().e);
  assert.deepEqual(closed, ['B', 'A'], '上层出栈后轮到下一层');

  popA();
  assert.equal(escLayerDepth(), 0);
  dispatch(esc().e); // 空栈：不应抛错
  assert.deepEqual(closed, ['B', 'A'], '空栈时无事发生');
});

test('#459 出栈函数幂等；非 Esc / 输入框焦点不触发', () => {
  const closed: string[] = [];
  const pop = pushEscLayer(() => closed.push('X'));
  pop();
  pop(); // 幂等
  assert.equal(escLayerDepth(), 0);

  pushEscLayer(() => closed.push('Y'));
  dispatch({ key: 'Enter', target: null, preventDefault: () => {}, stopPropagation: () => {} });
  assert.deepEqual(closed, [], '非 Esc 不关');
  dispatch(esc({ tagName: 'INPUT', isContentEditable: false }).e);
  assert.deepEqual(closed, [], '焦点在输入框 ⇒ 让给它自己');
  dispatch(esc({ tagName: 'TEXTAREA', isContentEditable: false }).e);
  assert.deepEqual(closed, [], '多行输入同理');
  dispatch(esc({ tagName: 'DIV', isContentEditable: true }).e);
  assert.deepEqual(closed, [], '可编辑区同理');
  dispatch(esc().e);
  assert.deepEqual(closed, ['Y'], '普通元素上仍然生效');
});

/* ── 接线锁：三个浮层 ── */
const READER = read('src/components/ReaderOverlay.vue');
const PLAYER = read('src/components/PlayerOverlay.vue');
const VDETAIL = read('src/components/VDetailOverlay.vue');

test('#459 三个浮层都不再「点外部关闭」', () => {
  assert.doesNotMatch(PLAYER, /class="pl-mask" @click\.self/, '播放浮层：遮罩不得再关自己');
  assert.doesNotMatch(VDETAIL, /class="vd-mask" @click\.self/, '详情浮层：遮罩不得再关自己');
  // 阅读浮层原来靠 `@mousedown/@click` 的 onMaskClick；模板上不该再挂这两个 handler
  assert.doesNotMatch(READER, /<div class="se-mask"[\s\S]{0,200}@click="onMaskClick"/, '阅读浮层：根遮罩不得再关自己');
});

test('#459 三个浮层都按「打开/关闭」入出 Esc 栈，且不再互相探测 DOM', () => {
  for (const [name, src] of [['ReaderOverlay', READER], ['PlayerOverlay', PLAYER], ['VDetailOverlay', VDETAIL]] as const) {
    assert.match(src, /import \{[^}]*pushEscLayer[^}]*\} from '\.\.\/utils\/esc-layer'/, `${name} 必须用共享 Esc 栈`);
    assert.match(src, /pushEscLayer\(/, `${name} 必须真的入栈`);
    // 精确到「守卫语句」形态（注释里提旧写法是允许的，正是要留档的教训）
    assert.doesNotMatch(src, /if \(document\.querySelector\('\.(pl|se|vd)-mask'\)\) return/, `${name} 不得再靠探测 DOM 让位`);
  }
  // 关闭按钮必须还在（「只能通过关闭按钮 / Esc 关闭」的前提）
  // `#872`：按钮已改走 `closeFromButton()`（小窗态先退小窗），断言对齐真实控件；
  // 同时锁住它仍落到同一个「退当前最上层」语义，避免以后只改字面量就悄悄断了关闭链。
  assert.match(READER, /<button class="btn mini rd-small-keep" data-small-close @click="closeFromButton\(\)">关闭<\/button>/);
  assert.match(READER, /function closeFromButton\(\)[^{]*\{[\s\S]{0,160}closeTopLayer\(\);/);
  assert.match(PLAYER, /<button class="btn mini" @click="p\.close\(\)">关闭<\/button>/);
  assert.match(VDETAIL, /<button class="btn mini" @click="vod\.closeDetail\(\)">关闭<\/button>/);
});
