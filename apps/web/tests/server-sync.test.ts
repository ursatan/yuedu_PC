/**
 * 阶段 1.4（`#66`）**同步策略**的回归锁 —— `utils/server-sync.ts`。
 *
 * 为什么这些用例必须存在：策略的每一条都是**数据安全**约定（用户 2026-09-28 拍板），
 * 写错了不会报错，只会「静默丢数据」或「服务端旧数据覆盖新改动」。四类各锁：
 *  ① 服务端非空 ⇒ **服务端为准**（覆盖本地缓存）；
 *  ② 服务端空 + 本地有 ⇒ **一次性搬迁**（本地保留）；
 *  ③ 离线 ⇒ **保持本地、不抛错**；
 *  ④ 上次没推成功（pendingSync）⇒ **以本地为准重传**，且要删掉服务端多出来的。
 * 外加两类（2026-09-28 第二十八批新增）：
 *  ⑤ `pushDiff` 增量推送 —— 书架有数百条、翻章就写，全量对齐会打出请求风暴；
 *  ⑥ **未对齐前不许推送**的闸门 —— 否则启动瞬间的本地写入会覆盖服务端。
 *
 * ⚠️ **每个用例必须用各自的 `localKey`**：`snapshots` / `pulled` 是模块级状态，
 * 共用同一个 key 会让用例互相污染（依赖执行顺序 ⇒ 单独跑就挂）。
 *
 * 运行：`pnpm --filter @yuedu/web test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pull, reconcile, pushDiff, createPusher, isOffline } from '../src/utils/server-sync';
import { UserDataError } from '../src/user-data';
import type { SyncPlan } from '../src/utils/server-sync';

/** 最小 localStorage 桩（Node 里没有） */
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

interface Row {
  id: number;
  name: string;
}

let keySeq = 0;

/** 造一个受控的 plan：`server` 数组代表服务端的当前状态，写操作直接改它 */
function makePlan(server: Row[], opts: { offline?: boolean; key?: string } = {}) {
  const calls: string[] = [];
  const k = opts.key ?? `k${++keySeq}`;
  const boom = () => {
    if (opts.offline) throw new UserDataError('connect ECONNREFUSED', 0);
  };
  const plan: SyncPlan<Row> = {
    localKey: k,
    pendingKey: `${k}-pending`,
    async list() {
      calls.push('list');
      boom();
      return server.map((r) => ({ ...r }));
    },
    async put(item) {
      calls.push(`put:${item['id']}`);
      boom();
      const row = item as unknown as Row;
      const i = server.findIndex((r) => r.id === row.id);
      if (i >= 0) server[i] = row;
      else server.push(row);
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      boom();
      const i = server.findIndex((r) => r.id === Number(id));
      if (i >= 0) server.splice(i, 1);
    },
    toRemote: (x) => ({ id: x.id, name: x.name }),
    idOf: (x) => String(x.id),
  };
  return { plan, calls, key: k };
}

test('① 服务端非空 ⇒ 以服务端为准（本地缓存被覆盖）', async () => {
  fakeStorage();
  const { plan } = makePlan([{ id: 1, name: '服务端' }, { id: 2, name: '服务端2' }]);
  const r = await pull(plan, [{ id: 9, name: '本地旧数据' }]);
  assert.equal(r.source, 'server');
  assert.deepEqual(r.items, [{ id: 1, name: '服务端' }, { id: 2, name: '服务端2' }]);
});

test('② 服务端空 + 本地有 ⇒ 一次性搬迁（本地保留，服务端被写入）', async () => {
  fakeStorage();
  const server: Row[] = [];
  const { plan } = makePlan(server);
  const local: Row[] = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const r = await pull(plan, local);
  assert.equal(r.source, 'migrated');
  assert.deepEqual(r.items, local, '搬迁后本地不变');
  assert.deepEqual(server, local, '服务端应被写入本地那份');
});

test('③ 离线 ⇒ 保持本地、不抛错（服务端没起是常态）', async () => {
  fakeStorage();
  const { plan } = makePlan([], { offline: true });
  const r = await pull(plan, [{ id: 1, name: 'A' }]);
  assert.equal(r.source, 'offline');
  assert.equal(r.items, null, '离线时返回 null ⇒ 调用方保持本地不动');
});

test('④ pendingSync ⇒ 以本地为准重传，并删掉服务端多出来的', async () => {
  const { ls } = fakeStorage();
  const server: Row[] = [
    { id: 2, name: '服务端多出来的（应被删）' },
    { id: 1, name: '服务端旧值' },
  ];
  const { plan, calls, key } = makePlan(server);
  ls.setItem(`${key}-pending`, '1');
  const r = await pull(plan, [{ id: 1, name: '本地新值' }]);
  assert.equal(r.source, 'resynced');
  assert.deepEqual(r.items, [{ id: 1, name: '本地新值' }]);
  assert.deepEqual(server, [{ id: 1, name: '本地新值' }], '本地为准：服务端被本地覆盖且多余项被删');
  assert.ok(calls.includes('remove:2'), `应删掉服务端多出来的 id=2，实际调用：${calls.join(',')}`);
  assert.equal(ls.getItem(`${key}-pending`), null, '重传成功应清掉 pendingSync 标记');
});

test('reconcile：写入侧的「本地 + 推服务端」——put 全量 + 删多余', async () => {
  fakeStorage();
  const server: Row[] = [{ id: 5, name: '将被删' }];
  const { plan } = makePlan(server);
  await pull(plan, []); // 先对齐（否则会被闸门拦下，见 ⑥）
  const r = await reconcile(plan, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(server, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
});

test('reconcile：离线 ⇒ 返回 offline=true 并**留下 pendingSync**（不抛错）', async () => {
  const { ls } = fakeStorage();
  const { plan, key } = makePlan([], { offline: true });
  await pull(plan, []); // 离线也会放行闸门（见 ⑥）
  const r = await reconcile(plan, [{ id: 1, name: 'A' }]);
  assert.equal(r.offline, true);
  assert.equal(ls.getItem(`${key}-pending`), '1', '必须留标记，否则下一次启动会把本地改动丢掉');
});

test('reconcile：**非离线错误必须照常抛**（不许静默兜底 —— 铁律 3）', async () => {
  fakeStorage();
  const k = `kboom${++keySeq}`;
  const plan: SyncPlan<Row> = {
    localKey: k,
    pendingKey: `${k}-pending`,
    async list() {
      return [];
    },
    async put() {
      throw new UserDataError('GROUP_ID_REQUIRED', 400); // 4xx：请求本身有问题
    },
    async remove() {},
    toRemote: (x) => ({ id: x.id }),
    idOf: (x) => String(x.id),
  };
  await pull(plan, []);
  await assert.rejects(() => reconcile(plan, [{ id: 1, name: 'A' }]), /GROUP_ID_REQUIRED/);
});

test('isOffline 只认 status=0（HTTP 报错不能当「服务端不可用」）', () => {
  assert.equal(isOffline(new UserDataError('x', 0)), true);
  assert.equal(isOffline(new UserDataError('x', 400)), false);
  assert.equal(isOffline(new Error('boom')), false);
});

/* ------------------------------------------------------------------ *
 * ⑤ 增量推送（书架/书签用）—— 全量对齐会打出请求风暴，见 pushDiff 注释
 * ------------------------------------------------------------------ */

test('⑤ pushDiff：无变化 ⇒ 一个请求都不发（这是它存在的唯一理由）', async () => {
  fakeStorage();
  const server: Row[] = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const { plan, calls } = makePlan(server);
  await pull(plan, []); // 对齐 ⇒ 快照 = 服务端现状
  calls.length = 0;
  const r = await pushDiff(plan, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [], `无变化时不该有任何请求，实际：${calls.join(',')}`);
});

test('⑤ pushDiff：只推变化的那一条 + 删掉本地已移除的', async () => {
  fakeStorage();
  const server: Row[] = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const { plan, calls } = makePlan(server);
  await pull(plan, []);
  calls.length = 0;

  // A 改名 + 删掉 B
  const r = await pushDiff(plan, [{ id: 1, name: 'A2' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.sort(), ['put:1', 'remove:2'].sort(), `实际：${calls.join(',')}`);
  assert.deepEqual(server, [{ id: 1, name: 'A2' }]);

  // 再推一次同样的内容 ⇒ 应当没有请求（快照已推进）
  calls.length = 0;
  await pushDiff(plan, [{ id: 1, name: 'A2' }]);
  assert.deepEqual(calls, [], `第二次应无请求，实际：${calls.join(',')}`);
});

test('⑤ pushDiff：离线 ⇒ 留 pendingSync 且不抛错', async () => {
  const { ls } = fakeStorage();
  const { plan, key } = makePlan([], { offline: true });
  await pull(plan, []);
  const r = await pushDiff(plan, [{ id: 1, name: 'A' }]);
  assert.equal(r.offline, true);
  assert.equal(ls.getItem(`${key}-pending`), '1');
});

test('⑤ createPusher：连续多次 kick 会**合并**成有界次数（防请求风暴）', async () => {
  fakeStorage();
  const server: Row[] = [{ id: 1, name: 'A' }];
  const { plan, calls } = makePlan(server);
  await pull(plan, []);
  calls.length = 0;
  const local: Row[] = [{ id: 1, name: 'A' }];
  const kick = createPusher(plan, () => local, '测试实体');

  // 连打 50 次（模拟「翻 50 章」）
  for (let i = 0; i < 50; i++) {
    local[0] = { id: 1, name: `A${i}` };
    kick();
  }
  await new Promise((r) => setTimeout(r, 30));
  // 防重入 ⇒ 首轮 + 最多一次补跑，不该是 50 次
  assert.ok(calls.length > 0, '至少应该推一次（最后一次的状态）');
  assert.ok(calls.length <= 3, `50 次 kick 应被合并成极少数请求，实际 ${calls.length} 次：${calls.join(',')}`);
  assert.deepEqual(server, [{ id: 1, name: 'A49' }], '最终必须落到**最后一次**的状态（不能漏）');
});

/* ------------------------------------------------------------------ *
 * ⑥ 「未对齐前不许推送」的闸门 —— 否则启动瞬间的本地写入会覆盖服务端
 * ------------------------------------------------------------------ */

test('⑥ pushDiff：**没 pull 过**就直接推 ⇒ 跳过且一个请求都不发（防覆盖服务端）', async () => {
  fakeStorage();
  const server: Row[] = [{ id: 1, name: '服务端的数据' }];
  const { plan, calls } = makePlan(server);
  const r = await pushDiff(plan, [{ id: 2, name: '启动瞬间的本地写入' }]);
  assert.equal(r.skipped, true);
  assert.deepEqual(calls, [], `不该发任何请求，实际：${calls.join(',')}`);
  assert.deepEqual(server, [{ id: 1, name: '服务端的数据' }], '服务端必须原封不动');
});

test('⑥ reconcile：**没 pull 过**也照样跳过（同一个闸门）', async () => {
  fakeStorage();
  const server: Row[] = [{ id: 1, name: '服务端的数据' }];
  const { plan, calls } = makePlan(server);
  const r = await reconcile(plan, [{ id: 2, name: '本地' }]);
  assert.equal(r.skipped, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(server, [{ id: 1, name: '服务端的数据' }]);
});

test('⑥ pull 之后闸门放行；离线 pull 也放行（否则离线期间的改动永远同步不出去）', async () => {
  fakeStorage();
  const online = makePlan([{ id: 1, name: 'A' }]);
  await pull(online.plan, []); // 对齐
  const r1 = await pushDiff(online.plan, [{ id: 1, name: 'A' }]);
  assert.equal(r1.skipped, undefined, 'pull 之后应放行');
  assert.equal(r1.ok, true);

  const offline = makePlan([], { offline: true });
  await pull(offline.plan, [{ id: 1, name: 'A' }]); // 离线
  const r2 = await pushDiff(offline.plan, [{ id: 1, name: 'A' }]);
  assert.equal(r2.skipped, undefined, '离线 pull 之后也应放行');
  assert.equal(r2.offline, true, '放行后仍会因为离线而失败并留标记');
});

test('#191 合并语义：服务端非空 + 本地独有 ⇒ 合并（服务端 + 本地独有），本地独有立即补推', async () => {
  fakeStorage();
  // ⚠️ 2026-11-08 修订：这里的「本地独有」历史上**包含**了「另一端已删、本端缓存还在」的陈旧副本，
  // 它们被立即补推 ⇒ 删除的行复活（用户实测：单条删除，第二天又出现）。
  // 修复放在 `reader.hydrateShelf`：调 pull **之前**先按服务端墓碑剔除陈旧条目，
  // 所以到这一层 local 里只剩真正的新增。本用例锁的是 pull 本身的「加法」合并语义，不负责删除判定，
  // 跨端删除用例见 watch-history-delete.test.ts 的「跨端：一端删除单条历史…」。
  const { plan, calls } = makePlan([{ id: 1, name: '服务端' }]);
  const local: Row[] = [
    { id: 1, name: '服务端' },
    { id: 9, name: '本地新增（离线加的）' },
  ];
  const r = await pull(plan, local, { mergeLocal: true });
  assert.deepEqual(
    (r.items ?? []).map((x) => x.id).sort((a, b) => Number(a) - Number(b)),
    [1, 9],
    '本地独有的那条必须保住（不能被服务端为准覆盖）',
  );
  assert.ok(calls.includes('put:9'), '本地独有的必须立即补推上服务端');
  assert.equal(r.source, 'migrated');
});

test('#191 防空转：默认（不传 mergeLocal）仍是「服务端为准」，本地独有被覆盖', async () => {
  fakeStorage();
  const { plan } = makePlan([{ id: 1, name: '服务端' }]);
  const r = await pull(plan, [{ id: 1, name: '服务端' }, { id: 9, name: '本地独有' }]);
  assert.equal(r.source, 'server');
  assert.deepEqual((r.items ?? []).map((x) => x.id), [1], '默认语义不得悄悄变成合并');
});

test('#191 合并是「加法」：已删条目不会因本地还有而复活（删除只走显式动作）', async () => {
  fakeStorage();
  // 服务端 1 条；本地 0 条（用户在别处删了）⇒ 合并后仍应只有服务端的
  const { plan } = makePlan([{ id: 1, name: '服务端' }]);
  const r = await pull(plan, [], { mergeLocal: true });
  assert.deepEqual((r.items ?? []).map((x) => x.id), [1]);
  assert.equal(r.source, 'server', '本地为空时走普通路径（不假装是 migrated）');
});
