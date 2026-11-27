/**
 * `#432` **滚轮转发桥**的回归锁 —— 与 `html-layer-bridge.test.ts` 同款：直接**执行**壳层
 * 生成的那段脚本（最小假 DOM / 假 parent），断言行为。
 *
 * ## 缺陷背景（用户报障：正文页「鼠标放内容区滚不动，必须在内容区与滚动条之间的窄带才滚」）
 * 正文 iframe 是 `sandbox="allow-scripts"`（**无** `allow-same-origin`）⇒ 不透明 origin 的
 * **独立文档**；滚轮投递给它自己，而**滚动链不跨文档边界** ⇒ iframe 没得滚时外层 `.se-body`
 * 收不到。桥负责：目标链上都没有可滚祖先时，把 `deltaY` 报给父页（父页滚 `.se-body`）；
 * **有**可滚祖先时**不介入**（视频页/播放列表这类自带内层滚动条的页面不能被抢走）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWheelBridge } from '../src/utils/html-shell';

interface Ev { deltaY: number; deltaMode?: number; target: unknown; prevented: boolean; preventDefault: () => void }

/** 造一个假元素（`canScroll` 只读 nodeType / computed overflowY / 三个几何量） */
function fakeEl(opts: { overflowY?: string; scrollTop?: number; scrollHeight?: number; clientHeight?: number }) {
  return {
    nodeType: 1,
    parentNode: null as unknown,
    overflowY: opts.overflowY ?? 'visible',
    scrollTop: opts.scrollTop ?? 0,
    scrollHeight: opts.scrollHeight ?? 0,
    clientHeight: opts.clientHeight ?? 0,
  };
}

function makeEv(target: unknown, deltaY: number, deltaMode?: number): Ev {
  const e: Ev = {
    deltaY,
    ...(deltaMode ? { deltaMode } : {}),
    target,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  return e;
}

function runBridge(opts: { docScrollHeight?: number; docClientHeight?: number } = {}) {
  const msgs: unknown[] = [];
  const parent = { postMessage: (m: unknown) => msgs.push(m) };
  const listeners: ((e: Ev) => void)[] = [];
  // `document.scrollingElement` = iframe 视口（`#432` 起正文 iframe 是「定高自滚」，能滚的是它）
  const scrollingElement = fakeEl({
    overflowY: 'visible',
    clientHeight: opts.docClientHeight ?? 0,
    scrollHeight: opts.docScrollHeight ?? 0,
  });
  const document = { documentElement: fakeEl({}), scrollingElement };
  const window = {
    innerHeight: 600,
    addEventListener: (type: string, fn: (e: Ev) => void) => {
      if (type === 'wheel') listeners.push(fn);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const saved = { window: g.window, document: g.document, parent: g.parent, getComputedStyle: g.getComputedStyle };
  /** 假全局必须先装好再跑脚本；且**分发事件时也要在装好的状态下**
   *  （监听器体里读的是全局 `getComputedStyle` —— 提前还原会让它变 `undefined` ⇒
   *   被脚本自己的 try/catch 吞掉 ⇒ 「什么都没发生」，实测踩过）*/
  const install = () => {
    g.window = window;
    g.document = document;
    g.parent = parent;
    g.getComputedStyle = (el: { overflowY?: string }) => ({ overflowY: el?.overflowY ?? 'visible' });
  };
  const restore = () => Object.assign(g, saved);
  install();
  try {
    // eslint-disable-next-line no-new-func
    new Function(buildWheelBridge())();
  } finally {
    restore();
  }
  const emit = (e: Ev) => {
    install();
    try {
      listeners.forEach((fn) => fn(e));
    } finally {
      restore();
    }
  };
  return { msgs, emit };
}

test('#432 滚轮桥：链条上没有可滚祖先 ⇒ 报给父页并 preventDefault', () => {
  const { msgs, emit } = runBridge();
  const e = makeEv(fakeEl({}), 120);
  emit(e);
  assert.deepEqual(msgs, [{ yueduWheel: 120 }], '必须把 deltaY 报给父页（父页去滚 .se-body）');
  assert.equal(e.prevented, true, '已转发 ⇒ 必须 preventDefault（否则同一次滚轮被双重消费）');
});

test('#432 滚轮桥：链条上有可滚祖先 ⇒ 不介入（让浏览器原生滚它）', () => {
  const { msgs, emit } = runBridge();
  const scroller = fakeEl({ overflowY: 'auto', scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
  const target = fakeEl({});
  target.parentNode = scroller;
  const e = makeEv(target, 120);
  emit(e);
  assert.deepEqual(msgs, [], '内层还能往下滚 ⇒ 不得抢走滚轮');
  assert.equal(e.prevented, false);
});

test('#432 滚轮桥：内层已到底 ⇒ 交回父页（滚动链语义）', () => {
  const { msgs, emit } = runBridge();
  const scroller = fakeEl({ overflowY: 'auto', scrollTop: 1600, scrollHeight: 2000, clientHeight: 400 });
  const target = fakeEl({});
  target.parentNode = scroller;
  const e = makeEv(target, 120);
  emit(e);
  assert.deepEqual(msgs, [{ yueduWheel: 120 }], '到底了 ⇒ 应链到外层');
  assert.equal(e.prevented, true);
});

test('#432 滚轮桥：deltaMode=1（行）按 16px/行 归一', () => {
  const { msgs, emit } = runBridge();
  const e = makeEv(fakeEl({}), 3, 1);
  emit(e);
  assert.deepEqual(msgs, [{ yueduWheel: 48 }]);
});

test('#432 滚轮桥：deltaY=0 不动（横向滚轮/触控板噪声不转发）', () => {
  const { msgs, emit } = runBridge();
  const e = makeEv(fakeEl({}), 0);
  emit(e);
  assert.deepEqual(msgs, []);
  assert.equal(e.prevented, false);
});

test('#432 滚轮桥：**本文档视口能滚 ⇒ 不转发**（iframe 定高自滚，正文必须原生滚）', () => {
  const { msgs, emit } = runBridge({ docScrollHeight: 5000, docClientHeight: 400 });
  const e = makeEv(fakeEl({}), 120);
  emit(e);
  assert.deepEqual(msgs, [], 'iframe 自己滚得动 ⇒ 不得抢走滚轮（否则正文反而滚不动）');
  assert.equal(e.prevented, false);
});

test('#432 滚轮桥：0 高的「假滚动条」不吞滚轮（LOFTER 正文里的遮罩层）', () => {
  const { msgs, emit } = runBridge();
  const ghost = fakeEl({ overflowY: 'auto', clientHeight: 0, scrollHeight: 900 });
  const target = fakeEl({});
  target.parentNode = ghost;
  const e = makeEv(target, 120);
  emit(e);
  assert.deepEqual(msgs, [{ yueduWheel: 120 }], '0 高元素不算可滚祖先 ⇒ 应转发给父页');
});

test('#432 滚轮桥：脚本里不得出现反引号（srcdoc 拼接纪律）', () => {
  assert.ok(!buildWheelBridge().includes('`'), '壳层脚本文本不能含反引号');
});