/**
 * `#453` 内嵌真浏览器池的**纯逻辑单测**（不 require('electron')）。
 *
 * 跑法：`pnpm --filter @yuedu/desktop test`（= `node --test tests/`）。
 *
 * ⚠️ 这组测试证明的是「**决策**对不对」：键怎么归、partition 怎么隔离、谁该被回收、bounds 怎么夹。
 * 「view 真的画在窗口里 / 焦点与输入法对不对」只有真机手测能证明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import lib from '../lib-webview-pool.js';

const { normalizeKey, partitionFor, clampBounds, WebViewPool } = lib;

/* ---------------- 会话键 ---------------- */

test('normalizeKey：与服务端同口径（src:<id> / anon），源 id 与键都能喂', () => {
  assert.equal(normalizeKey('src:abc'), 'src:abc', '已归一原样用');
  assert.equal(normalizeKey('anon'), 'anon');
  assert.equal(normalizeKey('abc'), 'src:abc', '裸源 id ⇒ 加前缀');
  assert.equal(normalizeKey(' abc '), 'src:abc', '必须 trim（否则会出现两个键指向同一源）');
  assert.equal(normalizeKey(''), 'anon');
  assert.equal(normalizeKey(undefined, 'x'), 'src:x', '键为空时退回 sourceId');
  assert.equal(normalizeKey(undefined, ''), 'anon');
  assert.equal(normalizeKey('src:abc', 'ignored'), 'src:abc', '键优先于 sourceId');
});

test('partitionFor：每键一个持久 partition（登录态/storage 不许串），且不含路径分隔符', () => {
  assert.equal(partitionFor('src:abc'), 'persist:src_abc');
  assert.equal(partitionFor('anon'), 'persist:anon');
  assert.notEqual(partitionFor('src:abc'), partitionFor('src:abd'), '不同源必须不同 partition');
  assert.equal(partitionFor('a/b:c'), 'persist:a_b_c');
  assert.equal(partitionFor(''), 'persist:anon');
});

/* ---------------- bounds ---------------- */

test('clampBounds：越界坐标/超尺寸都要夹回容器内（view 不许跑到看不见的地方）', () => {
  const box = { width: 1000, height: 800 };
  assert.deepEqual(clampBounds({ x: 0, y: 0, width: 1000, height: 800 }, box), { x: 0, y: 0, width: 1000, height: 800 });
  // 右下越界 ⇒ 尺寸被裁到剩下多少算多少
  assert.deepEqual(clampBounds({ x: 900, y: 700, width: 500, height: 500 }, box), { x: 900, y: 700, width: 100, height: 100 });
  // 负坐标 ⇒ 归 0
  assert.deepEqual(clampBounds({ x: -50, y: -20, width: 300, height: 200 }, box), { x: 0, y: 0, width: 300, height: 200 });
  // 小数取整（Electron 的 bounds 要整数）
  assert.deepEqual(clampBounds({ x: 10.6, y: 20.4, width: 100.2, height: 50.9 }, box), { x: 11, y: 20, width: 100, height: 51 });
  // 缺字段：尺寸退回容器、坐标退回 0
  assert.deepEqual(clampBounds({}, box), { x: 0, y: 0, width: 1000, height: 800 });
  // 容器未知（还没测量）⇒ 不裁尺寸，只保证非负
  assert.deepEqual(clampBounds({ width: -5, height: 7 }, null), { x: 0, y: 0, width: 0, height: 7 });
});

/* ---------------- 池：TTL + LRU + pinned ---------------- */

/** 可控时钟，让 TTL 判定可测（不用真等 5 分钟） */
function makePool(over = {}) {
  let t = 1000;
  const pool = new WebViewPool({ ttlMs: 1000, max: 2, now: () => t, ...over });
  return { pool, tick: (ms) => { t += ms; } };
}

test('WebViewPool：非 pinned 超 TTL 就该被回收，pinned 永不回收', () => {
  const { pool, tick } = makePool();
  pool.acquire('src:a');
  pool.acquire('src:b', { pinned: true });
  assert.deepEqual(pool.evictPlan(), [], '刚建的都不该回收');
  tick(1001);
  assert.deepEqual(pool.evictPlan(), ['src:a'], '只有到期的非 pinned 被计划回收');
  assert.equal(pool.size(), 2, 'evictPlan 只给计划，不自己动手（销毁由 main.js 做）');
});

test('WebViewPool：超过 max 时按最久未用回收（LRU），刚用过的留着', () => {
  const { pool, tick } = makePool();
  pool.acquire('src:a');
  tick(10);
  pool.acquire('src:b');
  tick(10);
  pool.acquire('src:c'); // 超 max=2
  assert.deepEqual(pool.evictPlan(), ['src:a'], 'a 最久未用 ⇒ 先回收');
  // 再摸一下 a（模拟又一次渲染）⇒ 计数与时间都刷新，它就不该再是第一个被回收的
  pool.acquire('src:a');
  assert.deepEqual(pool.evictPlan(), ['src:b']);
});

test('WebViewPool：pinned 不占 LRU 名额（挂进主窗口的 view 不许被后台渲染挤掉）', () => {
  const { pool, tick } = makePool();
  pool.acquire('src:shown', { pinned: true });
  tick(5);
  pool.acquire('src:r1');
  tick(5);
  pool.acquire('src:r2');
  assert.deepEqual(pool.evictPlan(), [], '两个非 pinned 正好占满 max，pinned 不参与计数');
  tick(5);
  pool.acquire('src:r3');
  assert.deepEqual(pool.evictPlan(), ['src:r1'], '只挤掉非 pinned 的最久未用');
});

test('WebViewPool：peek / setPinned / forget 与键归一一致（喂源 id 也认）', () => {
  const { pool } = makePool();
  pool.acquire('abc'); // ⇒ src:abc
  assert.ok(pool.peek('src:abc'));
  assert.ok(pool.peek('abc'), '同一个键的两种写法必须指向同一条记录');
  pool.setPinned('abc', true);
  assert.equal(pool.peek('src:abc').pinned, true);
  assert.equal(pool.forget('abc'), true);
  assert.equal(pool.size(), 0);
});
