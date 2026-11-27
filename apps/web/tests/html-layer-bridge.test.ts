/**
 * `#377①` **视口居中桥**的回归锁 —— 与 `html-live-bridge.test.ts` 同款：直接**执行**
 * 壳层生成的那段脚本（最小假 DOM / 假 MutationObserver / 假 parent），断言行为。
 *
 * ## 缺陷背景（用户报障：yckceo 列表页「生成」弹层落在文档中段，需滚动才看到）
 * iframe 被撑到**内容全高**（`htmlFrameH`，实测 4875px）⇒ 站点脚本（layui `layer.open`）
 * 用文档高度算「垂直居中」⇒ `top=(4875-500)/2=2187.5px`。空 iframe 里没有「父页可见窗口」
 * 信息，只能由父页回灌「可见带顶部 Y」。桥负责：① 浮层出现 ⇒ 报文；② 收 `{yueduVpTop}`
 * ⇒ 写 `--yuedu-vp-top`（由 `LAYER_FIX_CSS` 的 `transform` 消费）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLayerViewportBridge } from '../src/utils/html-shell';

interface Msg { yueduLayer?: { count: number } }

/**
 * 假环境里跑桥脚本：`setLayerCount(n)` 模拟站点弹出/关闭浮层后 scan 的结果；
 * `postFromParent({yueduVpTop})` 模拟父页回灌；`vp()` 读回 `--yuedu-vp-top`。
 */
function runBridge(opts: { count?: number } = {}) {
  const msgs: Msg[] = [];
  const state = { count: opts.count ?? 0 };
  const props: Record<string, string> = {};
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const documentElement = {
    style: {
      setProperty: (k: string, v: string) => {
        props[k] = v;
      },
    },
  };
  const document = {
    documentElement,
    querySelectorAll: (sel: string) => {
      assert.ok(sel.includes('.layui-layer'), '桥必须观察 .layui-layer（layui 浮层容器）');
      return { length: state.count };
    },
  };
  const observers: { cb: () => void }[] = [];
  class MutationObserver {
    constructor(cb: () => void) {
      observers.push({ cb });
    }
    observe() {}
    disconnect() {}
  }
  // 定时器不真跑：收集 interval 回调，由 tick() 手动触发（桥用 setInterval(scan,600) 兜底）
  const intervals: (() => void)[] = [];
  const setIntervalFake = (fn: () => void) => {
    intervals.push(fn);
    return { unref: () => {} };
  };
  const parent = { postMessage: (m: Msg) => msgs.push(m) };
  const win = {
    addEventListener: (t: string, fn: (e: { data: unknown }) => void) => {
      if (t === 'message') listeners.push(fn);
    },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window', 'document', 'parent', 'MutationObserver', 'setInterval',
    buildLayerViewportBridge(),
  );
  fn(win, document, parent, MutationObserver, setIntervalFake);
  const kick = () => observers.forEach((o) => o.cb());
  const tick = () => intervals.forEach((f) => f());
  return {
    msgs,
    kick,
    tick,
    /** 模拟父页回灌 */
    postFromParent(data: unknown) {
      listeners.forEach((fn) => fn({ data }));
    },
    /** 读回写入的 CSS 变量值 */
    vp: () => props['--yuedu-vp-top'],
    /** 模拟浮层数变化 */
    setLayerCount(n: number) {
      state.count = n;
    },
  };
}

test('视口桥 · 浮层出现 ⇒ 报文 {yueduLayer:{count}} + 首帧兜底 vp=0', () => {
  const b = runBridge({ count: 0 });
  assert.equal(b.msgs.length, 0, '无浮层 ⇒ 不打扰父页');
  // 站点弹出 layui 弹层
  b.setLayerCount(1);
  b.kick();
  assert.equal(b.msgs.length, 1, '浮层出现才发一次');
  assert.equal(b.msgs[0]!.yueduLayer!.count, 1);
  assert.equal(b.vp(), '0px', '父页回灌前先贴 iframe 顶（不再被丢到文档中段）');
});

test('视口桥 · 父页回灌 {yueduVpTop} ⇒ 写 --yuedu-vp-top（transform 消费）', () => {
  const b = runBridge({ count: 1 });
  b.postFromParent({ yueduVpTop: 1234 });
  assert.equal(b.vp(), '1234px');
  // 非数字/字段缺失 ⇒ 不误改（保持上一次值）
  b.postFromParent({ yueduVpTop: undefined });
  assert.equal(b.vp(), '1234px');
  // 其它桥的报文（yueduLiveMedia）不得干扰
  b.postFromParent({ yueduLiveMedia: { items: [], cur: '' } });
  assert.equal(b.vp(), '1234px');
});

test('视口桥 · 浮层数不变不重发；从有到无不再报（关掉不乱发）', () => {
  const b = runBridge({ count: 0 });
  b.setLayerCount(2);
  b.kick();
  assert.equal(b.msgs.length, 1);
  b.kick();
  b.tick();
  assert.equal(b.msgs.length, 1, '数量没变 ⇒ 不重复发');
  b.setLayerCount(0);
  b.kick();
  assert.equal(b.msgs.length, 1, '浮层关闭 ⇒ count=0 不报（父页无需处理）');
});

test('视口桥 · 脚本纪律：无反引号、无字面 script 闭合标签', () => {
  const text = buildLayerViewportBridge();
  assert.ok(!text.includes('`'), 'srcdoc 拼接纪律');
  assert.ok(!text.includes('</scr' + 'ipt>'), '字面闭合标签会切断 SFC/HTML');
});
