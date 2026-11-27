/**
 * 阶段 1.5（`#143`）**离线可见 + 服务端恢复后自动重传**的回归锁 —— `utils/server-sync.ts` 新增部分。
 *
 * 为什么这些用例必须存在：这两件事都**不会报错**，只会「用户以为存上了、其实没同步」
 * 或「服务端回来了却一直不推」。四类各锁：
 *  ① `reportServerReachableNow` ⇒ `isServerOffline()` 且**只在变化时**通知一次（否则界面每 15s 无谓重渲染）；
 *     （自动通道 `reportServerReachable` 自 `#178` 起多了「连续 3 次失败才翻面」的去抖，
 *      阈值由 `sync-reachability.test.ts` 单独锁 —— 这里只管「通知次数」这一条性质。）
 *  ② `markPending` / `clearPending` ⇒ 通知订阅者（界面角标靠它刷新）；
 *  ③ `registerSyncTarget` + `pendingTargets` ⇒ 只列出**打了标记**的实体；
 *  ④ `resyncAll` ⇒ 每个待同步实体各调一次 `resync`，**离线时提前中断**（别把后面几个都撞一遍）。
 *
 * ⚠️ `targets` / `serverOffline` / 订阅者都是**模块级状态**：每个用例用**各自的 localKey**，
 * 且结尾把可达性复位（否则污染后面的用例）。
 *
 * 运行：`pnpm --filter @yuedu/web test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearPending,
  isServerOffline,
  markPending,
  onSyncStateChange,
  pendingTargets,
  registerSyncTarget,
  reportServerReachableNow,
  resyncAll,
} from '../src/utils/server-sync';

function fakeStorage() {
  const m = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = ls;
  return { ls, m };
}

const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * ① 这里验的是**「只在变化时通知」**这个性质，与「几次失败才翻面」无关。
 *
 * ⚠️ `#178` 起`reportServerReachable`（自动通道）带**连续 3 次失败才翻面**的去抖，
 * 所以本用例改用 `reportServerReachableNow`（立即通道，用户主动探活那条路）——
 * 去抖的阈值另由 `sync-reachability.test.ts` 单独锁，两条性质互不干扰。
 */
test('① 可达性只在**变化时**通知一次（避免心跳把界面刷爆）', async () => {
  fakeStorage();
  reportServerReachableNow(true); // 复位（模块级状态）
  let n = 0;
  const off = onSyncStateChange(() => { n += 1; });

  assert.equal(isServerOffline(), false, '复位后应为在线');
  reportServerReachableNow(false);
  assert.equal(isServerOffline(), true, '置为不可达');
  assert.equal(n, 1, '变化 ⇒ 通知 1 次');
  reportServerReachableNow(false);
  assert.equal(n, 1, '重复置同一个值**不再**通知');

  reportServerReachableNow(true);
  assert.equal(isServerOffline(), false, '恢复可达');
  assert.equal(n, 2, '再次变化 ⇒ 再通知 1 次');
  off();
  reportServerReachableNow(false);
  assert.equal(n, 2, '取消订阅后不再收到');
  reportServerReachableNow(true); // 复位
});

test('② markPending / clearPending 会通知订阅者（界面角标据此刷新）', async () => {
  fakeStorage();
  let n = 0;
  const off = onSyncStateChange(() => { n += 1; });
  markPending('t2-pending');
  assert.equal(n, 1, '打标记 ⇒ 通知');
  clearPending('t2-pending');
  assert.equal(n, 2, '清标记 ⇒ 通知');
  off();
});

test('③ pendingTargets 只列出**打了标记**的实体', async () => {
  const { ls } = fakeStorage();
  registerSyncTarget({
    localKey: 't3-a', pendingKey: 't3-a-pending', label: '书架',
    resync: async () => ({ ok: true, offline: false }),
  });
  registerSyncTarget({
    localKey: 't3-b', pendingKey: 't3-b-pending', label: '书签',
    resync: async () => ({ ok: true, offline: false }),
  });
  ls.setItem('t3-a-pending', '1'); // 只有 a 待同步

  const labels = pendingTargets().map((t) => t.label);
  assert.deepEqual(labels, ['书架'], `只应列出「书架」，实得 ${JSON.stringify(labels)}`);

  // 未登记过的 key 不会凭空出现（防止「注册表空着也报有 N 项待同步」）
  ls.setItem('t3-unknown-pending', '1');
  assert.deepEqual(pendingTargets().map((t) => t.label), ['书架'], '未登记的 pending 标记不计入');

  clearPending('t3-a-pending');
  assert.deepEqual(pendingTargets(), [], '清掉标记后不再列出');
});

test('④ resyncAll：逐个重推；**离线时提前中断**（不把后面几个都撞一遍）', async () => {
  const { ls } = fakeStorage();
  const called: string[] = [];
  registerSyncTarget({
    localKey: 't4-a', pendingKey: 't4-a-pending', label: 'A',
    resync: async () => { called.push('A'); return { ok: false, offline: true }; },
  });
  registerSyncTarget({
    localKey: 't4-b', pendingKey: 't4-b-pending', label: 'B',
    resync: async () => { called.push('B'); return { ok: true, offline: false }; },
  });
  ls.setItem('t4-a-pending', '1');
  ls.setItem('t4-b-pending', '1');

  const out = await resyncAll();
  assert.deepEqual(called, ['A'], `A 离线后应立即中断，实得 ${JSON.stringify(called)}`);
  assert.equal(out.length, 1, '返回明细只有实际跑过的那一项');
  assert.equal(out[0]?.offline, true, '并如实报告 offline');
});

test('④b resyncAll：某个实体**抛非离线错误**时不拖住其它实体（但要留痕）', async () => {
  const { ls } = fakeStorage();
  const called: string[] = [];
  registerSyncTarget({
    localKey: 't5-a', pendingKey: 't5-a-pending', label: 'A抛错',
    resync: async () => { called.push('A'); throw new Error('接口改了'); },
  });
  registerSyncTarget({
    localKey: 't5-b', pendingKey: 't5-b-pending', label: 'B',
    resync: async () => { called.push('B'); return { ok: true, offline: false }; },
  });
  ls.setItem('t5-a-pending', '1');
  ls.setItem('t5-b-pending', '1');

  const warn = console.warn;
  const logs: unknown[] = [];
  console.warn = (...a: unknown[]) => void logs.push(a);
  try {
    const out = await resyncAll();
    await wait();
    assert.deepEqual(called.sort(), ['A', 'B'], 'A 抛错后 B 仍要被尝试');
    assert.equal(out.length, 2, '两项都有明细');
    assert.equal(out.find((o) => o.label === 'A抛错')?.ok, false, 'A 记为失败');
    assert.equal(out.find((o) => o.label === 'B')?.ok, true, 'B 记为成功');
    assert.ok(logs.length > 0, '非离线错误必须留痕（铁律 3：不静默兜底）');
  } finally {
    console.warn = warn;
  }
});
