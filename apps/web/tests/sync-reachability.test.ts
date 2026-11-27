/**
 * `#178` 离线判定的**去抖** —— 回归锁。
 *
 * ## 要防的那个 bug（用户 2026-10-01 实测）
 * 「多次出现：服务离线 · 627 源 ⚠ 离线（本地可用）」。
 *
 * ## 先说清这不是「服务端掉线」
 * 实测连续 20 次 `GET /api/engines` **全 200** ⇒ 服务端一直在。
 * 是前端把「**任何一次**请求失败」直接翻译成「已离线」并立刻显示。
 * 而服务端是**单进程 Node**：跑大搜索 / 封面解密时，`/api/engines` 这种轻请求
 * 会排在后面；旧的 4s 超时 + 「单次失败即翻面」⇒ 界面就闪一次离线。
 *
 * ## 为什么这个能锁住（而不是靠肉眼看界面）
 * 去抖的正确性是**状态机性质**：「要连续失败 N 次才翻面，单次失败不翻，
 * 一次成功立刻翻回」。这个性质可以直接断言，不需要等真的断网。
 * ⚠️ 反过来，如果只写「断网后显示离线」这一条，**去抖写错了也测不出来**
 *   —— 那正是本轮要避免的假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  configureOfflineDebounce,
  isServerOffline,
  onSyncStateChange,
  reportServerReachable,
  reportServerReachableNow,
  resetReachabilityStreak,
} from '../src/utils/server-sync';

/**
 * ⚠️ **这组用例必须串行**：`node:test` 的顶层 `test()` **可以并发执行**
 *（`concurrency` 默认 true），而这里验的 `serverOffline` / `failStreak` 是
 * `server-sync.ts` 的**模块级单例** —— 若并发，A 用例把 `serverOffline` 置成 true 后，
 * B 用例第一次 `report(false)` 就走进「已经离线了 ⇒ 不通知」的分支，断言全乱。
 * ⇒ 显式 `{ concurrency: false }`。
 */
const serial = { concurrency: false };

/**
 * 每个用例都要干净的状态 —— 模块级单例，用例间必须重置。
 *
 * ⚠️ `changes` **必须用计数器对象**再读，不能 `let n = 0` 后`return { changes: n }`
 *   —— 那样返回的是**数值副本**，回调自增的是另一个变量，断言永远读到 0。
 *   （首版就这么写的，7 条里挂 2 条，现象极像「状态机没生效」，实际是测试自己写错了。）
 */
/**
 * `#462` 起判据是**双条**（次数 + 持续时长）。
 * 本文件这些用例测的是**次数**那一半 ⇒ 把时长门槛设成 0（否则要真等 30s）。
 * 时长那一半由下方 `★ 短停摆不许翻面` 用例单独覆盖。
 */
function fresh(): { count: () => number; un: () => void } {
  configureOfflineDebounce({ minSpanMs: 0 });
  resetReachabilityStreak();
  reportServerReachableNow(true);   // 先确保在线（这一步本身不计数）
  const box = { n: 0 };
  const un = onSyncStateChange(() => { box.n += 1; });
  return { count: () => box.n, un };
}

test('★ 初始在线；连续失败 3 次才显示离线', () => {
  const { count, un } = fresh();
  try {
    assert.equal(isServerOffline(), false, '起始应为在线');

    reportServerReachable(false);
    assert.equal(isServerOffline(), false, '★ 失败 1 次**不能**翻成离线（这就是闪现的根因）');
    reportServerReachable(false);
    assert.equal(isServerOffline(), false, '★ 失败 2 次仍不能翻');

    reportServerReachable(false);
    assert.equal(isServerOffline(), true, '失败到第 3 次才显示离线');
    // 期间只该在真正翻面时通知一次（不翻面就别 notify，否则界面照样闪）
    assert.equal(count(), 1, `整个过程只应通知 1 次，实得 ${count()}`);
  } finally { un(); }
}, serial);

test('★ 成功立刻恢复（不必等第 3 次）—— 误报代价全在「显示离线」这一侧', () => {
  const { un } = fresh();
  try {
    reportServerReachable(false);
    reportServerReachable(false);
    reportServerReachable(false);
    assert.equal(isServerOffline(), true);
    reportServerReachable(true);
    assert.equal(isServerOffline(), false, '一次成功就应翻回在线');
  } finally { un(); }
}, serial);

test('★ 中间成功会清零计数（失败-成功-失败 不该累计成离线）', () => {
  const { un } = fresh();
  try {
    reportServerReachable(false);
    reportServerReachable(false);
    reportServerReachable(true);          // 中间成功 ⇒ 计数清零
    reportServerReachable(false);
    reportServerReachable(false);
    assert.equal(isServerOffline(), false, '清零后再失败 2 次仍不该离线（总共 4 次失败但分成两段）');
  } finally { un(); }
}, serial);

test('★ `#462` 短停摆不许翻面；持续够久照样翻（时间判据那一半）', async () => {
  const { un } = fresh(); // fresh 里把时长门槛设为 0 了，这里换成 60ms 以便真跑
  try {
    configureOfflineDebounce({ afterFailures: 3, minSpanMs: 60 });
    resetReachabilityStreak();
    reportServerReachable(true);
    reportServerReachable(false);
    reportServerReachable(false);
    reportServerReachable(false); // 三次几乎同时 ⇒ 首失距今 ~0ms
    assert.equal(isServerOffline(), false,
      '★ 连失 3 次但首失距今不足门槛 ⇒ 仍显示在线（正对用户那批 [stall] stall ms=5xxx 的整秒级停摆）');
    await new Promise((r) => setTimeout(r, 80));
    reportServerReachable(false); // 已过 60ms ⇒ 判据满足
    assert.equal(isServerOffline(), true, '持续够久后必须翻面 —— 真掉线不能因为这条时间判据而被漏掉');
  } finally { un(); }
}, serial);

test('★ 手动探活跳过去抖（用户主动点的要立刻如实反映）', () => {
  const { un } = fresh();
  try {
    reportServerReachableNow(false);
    assert.equal(isServerOffline(), true, '手动失败 ⇒ 立刻离线（不等 3 次）');
  } finally { un(); }
}, serial);

test('★ 手动探活会清零自动计数（手动 1 次不该替心跳凑够 3 次）', () => {
  const { un } = fresh();
  try {
    reportServerReachable(false);
    reportServerReachable(false);         // 心跳已失败 2 次
    reportServerReachableNow(false);      // 手动再失败 1 次 —— 但这是**独立信号**
    assert.equal(isServerOffline(), true, '手动失败本身如实显示离线');
    reportServerReachableNow(true);       // 手动探活成功 ⇒ 计数已清零
    reportServerReachable(false);         // 心跳又失败 1 次
    assert.equal(isServerOffline(), false,
      '★ 手动探活后心跳只失败 1 次 ⇒ 不该离线（计数若没清零，这里会是 true）');
  } finally { un(); }
}, serial);

test('★ 已离线时继续失败不重复通知（避免界面反复重绘）', () => {
  const { count, un } = fresh();
  try {
    reportServerReachable(false);
    reportServerReachable(false);
    reportServerReachable(false);        // 翻面，通知第 1 次
    assert.equal(count(), 1, `第 3 次失败应通知 1 次，实得 ${count()}`);
    reportServerReachable(false);
    reportServerReachable(false);
    assert.equal(count(), 1, `已经在离线了，不该再通知，实得 ${count()}`);
  } finally { un(); }
}, serial);

test('★ 已经在线时连续报成功也不通知（没有意义的变化不要惊动界面）', () => {
  const { count, un } = fresh();
  try {
    reportServerReachable(true);
    reportServerReachable(true);
    assert.equal(count(), 0, `状态没变就不该通知，实得 ${count()}`);
  } finally { un(); }
}, serial);