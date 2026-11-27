/**
 * `#437` **横向滚动桥**的回归锁（滚轮纵向 → 横向 + 按住鼠标拖动）。
 *
 * ## 缺陷背景
 * 源作者的启动页/正文里，分类条常写成移动端形态：
 * `overflow-x:auto` + `::-webkit-scrollbar{display:none}` + `-webkit-overflow-scrolling:touch`
 * ⇒ 手机上手指一划能滚，**桌面上既没有触摸、又隐藏了滚动条** ⇒ 后面的分类永远看不到
 * （用户实测千百羽论坛「千百羽官方站/网盘/链接被遮挡」）。
 * 两种修法（换行 / 拖动）里选**不改作者布局**的那种：把滚轮与拖动补上。
 *
 * ⚠️ 判据：只在该容器**确实还能横向滚**时吃事件；滚到头必须**还给**纵向滚动（不抢页面）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWheelBridge } from '../src/utils/html-shell';

interface Ev {
  deltaY: number;
  deltaMode?: number;
  target: unknown;
  prevented: boolean;
  preventDefault: () => void;
  shiftKey?: boolean;
  button?: number;
  clientX?: number;
}

/** 假元素：`scrollLeft` 可写且**会钳位**（真 DOM 语义 —— 用来验「滚到头就放行」） */
function fakeEl(o: { overflowX?: string; overflowY?: string; scrollLeft?: number; scrollWidth?: number; clientWidth?: number }) {
  const el = {
    nodeType: 1,
    parentNode: null as unknown,
    style: {} as Record<string, string>,
    scrollLeft: o.scrollLeft ?? 0,
    scrollWidth: o.scrollWidth ?? 0,
    clientWidth: o.clientWidth ?? 0,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    overflowX: o.overflowX ?? 'visible',
    overflowY: o.overflowY ?? 'visible',
  };
  // 钳位：`scrollLeft` 只能落在 [0, scrollWidth-clientWidth]
  let v = el.scrollLeft;
  Object.defineProperty(el, 'scrollLeft', {
    get: () => v,
    set: (n: number) => {
      v = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, n));
    },
    configurable: true,
  });
  return el;
}

function run(opts: { docScrollable?: boolean } = {}) {
  const msgs: unknown[] = [];
  const parent = { postMessage: (m: unknown) => msgs.push(m) };
  const wheel: ((e: Ev) => void)[] = [];
  const mouse: Record<string, ((e: Ev) => void)[]> = { mousedown: [], mousemove: [], mouseup: [] };
  const scrollingElement = fakeEl({
    scrollHeight: opts.docScrollable ? 5000 : 0,
    clientHeight: opts.docScrollable ? 400 : 400,
  });
  const document = {
    documentElement: fakeEl({}),
    scrollingElement,
    addEventListener: (t: string, fn: (e: Ev) => void) => {
      (mouse[t] ??= []).push(fn);
    },
  };
  const window = { innerHeight: 600, addEventListener: (t: string, fn: (e: Ev) => void) => { if (t === 'wheel') wheel.push(fn); } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const saved = { window: g.window, document: g.document, parent: g.parent, getComputedStyle: g.getComputedStyle };
  const install = () => {
    g.window = window;
    g.document = document;
    g.parent = parent;
    g.getComputedStyle = (el: { overflowX?: string; overflowY?: string }) => ({
      overflowX: el?.overflowX ?? 'visible',
      overflowY: el?.overflowY ?? 'visible',
    });
  };
  const restore = () => Object.assign(g, saved);
  install();
  try {
    // eslint-disable-next-line no-new-func
    new Function(buildWheelBridge())();
  } finally {
    restore();
  }
  const fire = (kind: 'wheel' | keyof typeof mouse, e: Ev) => {
    install();
    try {
      (kind === 'wheel' ? wheel : mouse[kind]).forEach((fn) => fn(e));
    } finally {
      restore();
    }
  };
  return { msgs, fire, scrollingElement };
}

const ev = (target: unknown, extra: Partial<Ev> = {}): Ev => ({
  deltaY: 120,
  target,
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
  ...extra,
});

test('#437 滚轮纵向 → 横向滚动容器：吃掉事件并横向滚（不再报给父页）', () => {
  const { msgs, fire } = run();
  const strip = fakeEl({ overflowX: 'auto', scrollWidth: 900, clientWidth: 300, scrollLeft: 0 });
  const e = ev(strip);
  fire('wheel', e);
  assert.equal(strip.scrollLeft, 120, '纵向滚轮必须转成横向滚动');
  assert.equal(e.prevented, true, '已消费 ⇒ preventDefault');
  assert.deepEqual(msgs, [], '不能被当成「纵向滚不动」再报给父页');
});

test('#437 已滚到头 ⇒ 放行给纵向逻辑（还给父页，不抢）', () => {
  const { msgs, fire } = run();
  const strip = fakeEl({ overflowX: 'auto', scrollWidth: 900, clientWidth: 300 });
  strip.scrollLeft = 600; // 已在最右（600 = 900-300）
  const e = ev(strip);
  fire('wheel', e);
  assert.equal(strip.scrollLeft, 600, '不能再滚');
  assert.deepEqual(msgs, [{ yueduWheel: 120 }], '滚到头 ⇒ 交回父页滚纵向');
});

test('#437 shift+滚轮 不劫持（浏览器的原生横向滚动手势）', () => {
  const { msgs, fire } = run();
  const strip = fakeEl({ overflowX: 'auto', scrollWidth: 900, clientWidth: 300 });
  const e = ev(strip, { shiftKey: true });
  fire('wheel', e);
  assert.equal(strip.scrollLeft, 0, '保持原生行为');
  assert.deepEqual(msgs, [{ yueduWheel: 120 }]);
});

test('#437 按住鼠标拖动横向容器（4px 阈值内不算拖动 ⇒ 点击不受影响）', () => {
  const { fire } = run();
  const strip = fakeEl({ overflowX: 'auto', scrollWidth: 900, clientWidth: 300 });
  // 按下
  fire('mousedown', ev(strip, { button: 0, clientX: 200 }));
  // 移动 2px：低于阈值 ⇒ 不滚、不 preventDefault（点击语义保住）
  const near = ev(strip, { clientX: 198 });
  fire('mousemove', near);
  assert.equal(strip.scrollLeft, 0, '阈值内不动');
  assert.equal(near.prevented, false, '阈值内不得 preventDefault（否则点击失效）');
  // 移动 60px ⇒ 拖动生效（向左拖 = 内容右移）
  fire('mousemove', ev(strip, { clientX: 140 }));
  assert.equal(strip.scrollLeft, 60);
  // 松开后不再跟随
  fire('mouseup', ev(strip, {}));
  fire('mousemove', ev(strip, { clientX: 20 }));
  assert.equal(strip.scrollLeft, 60, '松开后必须停止拖动');
});

test('#437 非横向容器 / 普通元素：行为与 `#432` 完全一致（零回归）', () => {
  const { msgs, fire } = run();
  const plain = fakeEl({ overflowY: 'auto', scrollHeight: 2000, clientHeight: 400 });
  const e = ev(plain);
  fire('wheel', e);
  assert.deepEqual(msgs, [{ yueduWheel: 120 }], '纵向可滚容器仍按 #432 语义交给父页');
});