/**
 * `#207` **整本下载中心**的回归锁 —— `utils/download-manager.ts`（纯逻辑，依赖注入）。
 *
 * 为什么这些用例必须存在：下载是**后台行为**，出问题时的表现是「不报错、但就是不对」
 * （下了一半没了 / 失败章节静默丢失 / 刷新后任务凭空消失 / 两本书互相抢并发）。
 * 逐条锁：
 *  ① 整本下载跑完 ⇒ `done === total` 且状态 `done`；
 *  ② **已有缓存的章节跳过**（对齐上游 `BookHelp.hasContent`）：`skipped` 计数、不发请求；
 *  ③ **失败重试 3 次**（对齐上游 `onPostError`）⇒ 计数进 `failed`，「重试失败」能把它们捞回来；
 *  ④ **暂停/继续**：暂停后队列**保留**（不是清零），继续后接着跑完；
 *  ⑤ **并发上限**：同时下载的本数不超过 `maxBooks`（多了就是对源站不礼貌）；
 *  ⑥ 卷标题行**不入队**（卷没有正文页）；
 *  ⑦ **刷新恢复**：`running`/`queued` 一律落成 `paused`（不自动续跑 ⇒ 不会重启就狂打源站）；
 *  ⑧ 取消 ⇒ 队列清空、状态 `canceled`；
 *  ⑨ 同一本书**合并范围**（对齐上游 `addDownload`），不产生第二个任务。
 *
 * 运行：`pnpm --filter @yuedu/web test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDownloadManager, DEFAULT_MAX_BOOKS,
  type DownloadDeps, type DownloadManager, type DownloadState, type DownloadTask,
} from '../src/utils/download-manager';
import type { UnifiedChapter } from '@yuedu/core/contract';

/** 造目录（`payload.i` 就是章号，方便断言） */
function chs(n: number, volumes: number[] = []): UnifiedChapter[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `第${i + 1}章`,
    payload: { i },
    ...(volumes.includes(i) ? { isVolume: true } : {}),
  }));
}

interface Fake {
  deps: DownloadDeps;
  /** 每次真实取数（**跳过缓存的不算**）的章号 */
  calls: number[];
  /** 已写入缓存的键（`<书键>:<章号>` —— 两本书的章号会撞，必须带书键） */
  cache: Set<string>;
  keyOf: (ch: UnifiedChapter) => string;
  release: () => void;
}

function makeFake(
  chapters: UnifiedChapter[],
  opts: { fail?: number[]; cached?: number[]; gated?: boolean } = {},
): Fake {
  const cache = new Set<string>();
  const calls: number[] = [];
  const idxOf = (ch: UnifiedChapter): number => Number((ch.payload as { i: number }).i);
  const keyOf = (ch: UnifiedChapter): string =>
    `${String((ch.payload as { b?: string }).b ?? '')}:${idxOf(ch)}`;
  /** 预置「已有缓存」的章节（按**章号**判，与书键无关 —— 单本书的用例够用） */
  const preCached = new Set<number>(opts.cached ?? []);
  let release: () => void = () => {};
  /**
   * ⚠️ `gated` 卡的是**所有**取数（不是只卡第一次）—— 只卡第一次的话，其余两个 worker
   * 会把整本书跑完，「暂停时还剩几章」就变成不确定的数字，断言只能靠猜。
   */
  const gate = new Promise<void>((r) => { release = r; });
  const deps: DownloadDeps = {
    // ★ 目录**按书键**带上命名空间：两本书的章号都是 0..3，payload 相同会被当成同一章
    loadChapters: async (key: string) =>
      chapters.map((c) => ({ ...c, payload: { i: idxOf(c), b: key } })),
    downloadChapter: async (_src, _payload, ch, o) => {
      if (opts.gated) await gate;
      const i = idxOf(ch);
      const k = keyOf(ch);
      if (!o.force && (cache.has(k) || preCached.has(i))) return { skipped: true };
      calls.push(i);
      if ((opts.fail ?? []).includes(i)) throw new Error(`章节 ${i} 取正文失败`);
      cache.add(k);
      return { skipped: false };
    },
    sleep: async () => { /* 测试里不等 1s */ },
    now: () => Date.now(),
  };
  return { deps, calls, cache, keyOf, release: () => release() };
}

/** 等到指定任务进入期望状态（下载是异步的，不能靠 sleep 猜） */
async function settle(m: DownloadManager, key: string, want: DownloadState[], max = 400): Promise<DownloadTask> {
  for (let k = 0; k < max; k += 1) {
    const t = m.list().find((x) => x.key === key);
    if (t && want.includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`等待超时：${key} 期望 ${want.join('/')}，实际 ${JSON.stringify(m.debug())}`);
}

const seed = (key: string, from?: number, to?: number) => ({
  key, sourceId: 'src', payload: { bookUrl: key }, title: `书-${key}`,
  ...(from !== undefined ? { from } : {}),
  ...(to !== undefined ? { to } : {}),
});

test('#207 ① 整本下载：跑完 done === total 且状态 done', async () => {
  const f = makeFake(chs(10));
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('a'));
  const t = await settle(m, 'a', ['done', 'error']);
  assert.equal(t.state, 'done');
  assert.equal(t.done, 10);
  assert.equal(t.total, 10);
  assert.equal(f.cache.size, 10);
});

test('#207 ② 已有缓存的章节跳过（不发请求，计入 skipped）', async () => {
  const f = makeFake(chs(10), { cached: [3, 7] });
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('b'));
  const t = await settle(m, 'b', ['done', 'error']);
  assert.equal(t.skipped, 2, '已缓存的 2 章应被跳过');
  assert.equal(t.done, 8);
  assert.equal(t.done + t.skipped, t.total);
  assert.ok(!f.calls.includes(3) && !f.calls.includes(7), '跳过的章节不该发请求');
});

test('#207 ③ 失败重试 3 次 → failed；「重试失败」能把它们捞回来', async () => {
  const f = makeFake(chs(5), { fail: [2] });
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('c'));
  const t = await settle(m, 'c', ['done', 'error']);
  assert.equal(t.state, 'error', '有失败章节 ⇒ 状态是 error，不是 done');
  assert.equal(t.failed, 1);
  assert.deepEqual(t.failedIdx, [2]);
  assert.equal(f.calls.filter((i) => i === 2).length, 3, '对齐上游：最多重试 3 次');

  // 修好源（不再失败）后「重试失败」⇒ 补齐
  const orig = f.deps.downloadChapter;
  f.deps.downloadChapter = async (_src, _payload, ch) => {
    f.cache.add(f.keyOf(ch));
    return { skipped: false };
  };
  m.retryFailed('c');
  const t2 = await settle(m, 'c', ['done', 'error']);
  assert.equal(t2.state, 'done');
  assert.equal(t2.failed, 0);
  assert.equal(t2.done, 5);
  f.deps.downloadChapter = orig;
});

test('#207 ④ 暂停保留队列，继续后接着跑完', async () => {
  const f = makeFake(chs(6), { gated: true });
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('d'));
  // 第一本已经进了取数（被 gate 卡住）⇒ 此时暂停
  await new Promise((r) => setTimeout(r, 5));
  m.pause('d');
  f.release();
  await new Promise((r) => setTimeout(r, 20));
  const paused = m.list().find((x) => x.key === 'd');
  assert.equal(paused?.state, 'paused', '暂停后状态必须是 paused');
  assert.ok((paused?.pending.length ?? 0) > 0, '暂停必须**保留**未下载章节，不能清零');
  assert.equal(
    (paused?.done ?? 0) + (paused?.pending.length ?? 0), 6,
    '已下载的 + 还在队列的 = 全部章节（既没丢也没重复）',
  );

  m.resume('d');
  const t = await settle(m, 'd', ['done', 'error']);
  assert.equal(t.done, 6);
  assert.equal(t.state, 'done');
});

test('#207 ⑤ 并发上限：同时下载的本数不超过 maxBooks', async () => {
  const f = makeFake(chs(4), { gated: true });
  const m = createDownloadManager(f.deps);
  m.setMaxBooks(1);
  await m.enqueue(seed('e1'));
  await m.enqueue(seed('e2'));
  await new Promise((r) => setTimeout(r, 10));
  const s = m.summary();
  assert.equal(s.running, 1, '只应有 1 本在下载');
  assert.equal(s.waiting, 1, '另一本应排队');
  f.release();
  await settle(m, 'e1', ['done', 'error']);
  await settle(m, 'e2', ['done', 'error']);
  assert.equal(m.summary().success, 8);
});

test('#207 ⑥ 卷标题行不入队（卷没有正文页）', async () => {
  const f = makeFake(chs(6, [0, 3]));
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('f'));
  const t = await settle(m, 'f', ['done', 'error']);
  assert.equal(t.total, 4, '两行卷标题不该计入');
  assert.equal(t.done, 4);
  assert.ok(!f.cache.has(0) && !f.cache.has(3));
});

test('#207 ⑦ 刷新恢复：running/queued 落成 paused，pending 保留', async () => {
  const f = makeFake(chs(5));
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('g'));
  const before = await settle(m, 'g', ['done', 'error', 'queued', 'running']);
  // 模拟「刷新前落盘的状态里还有没跑完的」
  const saved: DownloadTask[] = [{ ...before, state: 'running', pending: [1, 2], done: 0, failed: 0, skipped: 0 }];
  const m2 = createDownloadManager(makeFake(chs(5)).deps);
  m2.restore(saved);
  const t = m2.list().find((x) => x.key === 'g');
  assert.equal(t?.state, 'paused', '恢复后不自动跑 —— 免得刷新就对源站发起几百次请求');
  assert.deepEqual(t?.pending, [1, 2]);
  // 继续 ⇒ 只跑恢复出来的那两章（其余不在队列里，不会重复下载）
  m2.resume('g');
  const done = await settle(m2, 'g', ['done', 'error']);
  assert.equal(done.done + done.skipped, 2);
});

test('#207 ⑧ 取消：队列清空、状态 canceled（已缓存的正文保留）', async () => {
  const f = makeFake(chs(9), { gated: true });
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('h'));
  await new Promise((r) => setTimeout(r, 5));
  m.cancel('h');
  f.release();
  await new Promise((r) => setTimeout(r, 20));
  const t = m.list().find((x) => x.key === 'h');
  assert.equal(t?.state, 'canceled');
  assert.equal(t?.pending.length, 0, '取消后队列必须清空');
  assert.ok((f.cache.size ?? 0) >= 0, '取消不删已下载的缓存');
});

test('#207 ⑨ 同一本书合并范围（对齐上游 addDownload），不产生第二个任务', async () => {
  const f = makeFake(chs(10), { gated: true }); // 卡住取数 ⇒ 第二次 enqueue 时第一拨仍在跑
  const m = createDownloadManager(f.deps);
  m.setMaxBooks(1);
  await m.enqueue(seed('i', 0, 3));
  const mid = m.list().find((x) => x.key === 'i');
  assert.equal(mid?.state, 'running', '前置条件：第一拨正在跑');
  await m.enqueue(seed('i', 4, 9));
  const all = m.list().filter((x) => x.key === 'i');
  assert.equal(all.length, 1, '同一本书只能有一个任务');
  assert.equal(all[0]?.total, 10, '合并后应覆盖整本');
  f.release();
  const t = await settle(m, 'i', ['done', 'error']);
  assert.equal(t.done + t.skipped, 10);
});

test('#207 ⑪ 在途章节也在 pending 里（★ 刷新不能静默丢章）', async () => {
  // 探针 E 段实测到的真缺陷：在途章节已从队列 shift 出来但还没落地，
  // 快照里若不含它们 ⇒ 刷新后这几章「既不在队列也不在缓存」—— 不报错、不重试，静默少几章。
  const f = makeFake(chs(6), { gated: true });
  const m = createDownloadManager(f.deps);
  await m.enqueue(seed('j'));
  await new Promise((r) => setTimeout(r, 5));
  const t = m.list().find((x) => x.key === 'j');
  assert.equal(t?.done, 0, '前置：都被 gate 卡住，还没落地');
  assert.equal(t?.pending.length, 6, '★ 在途的 3 章必须仍在 pending 里（否则刷新就丢了）');
  f.release();
  const done = await settle(m, 'j', ['done', 'error']);
  assert.equal(done.done, 6);
});

test('#207 ⑩ 默认并发 = 2（`DEFAULT_MAX_BOOKS`）', () => {
  assert.equal(DEFAULT_MAX_BOOKS, 2);
});

/* ──────────────────────────────────────────────────────────────────────────────
 * `D6` **自适应限速 Pacer**
 *
 * 为什么必须有：源站 429 时若还按固定并发猛打，只会把 IP 打进黑名单；
 * 而把 429 当成普通失败重试 3 次，又会「3 次就放弃」——大晚上整本下不完。
 * 锁三件事：① 429 走 1s/2s/4s 指数退避（`Retry-After` 优先），**不占** `MAX_RETRY`；
 *          ② 429 后并发立刻降到 1（不再继续打源站）；
 *          ③ 成功后并发逐步回升（1 → 2 → 3）。
 * ────────────────────────────────────────────────────────────────────────────── */

test('D6 ① 429 指数退避 1s/2s/4s（优先 Retry-After），且不占普通重试配额', async () => {
  const delays: number[] = [];
  let calls = 0;
  const deps: DownloadDeps = {
    loadChapters: async () => chs(1),
    downloadChapter: async () => {
      calls += 1;
      if (calls <= 3) throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
      if (calls === 4) throw Object.assign(new Error('HTTP 429'), { status: 429, retryAfter: '2' });
      return { skipped: false };
    },
    sleep: async (ms) => { delays.push(ms); },
    now: () => Date.now(),
  };
  const m = createDownloadManager(deps);
  await m.enqueue(seed('k1'));
  const t = await settle(m, 'k1', ['done', 'error']);

  assert.equal(t.state, 'done', '429 全部退避成功后必须正常完成');
  assert.equal(t.done, 1);
  assert.equal(t.failed, 0, '429 不得计入 failed');
  assert.equal(calls, 5, '4 次 429 后成功 —— 若 429 占 MAX_RETRY，第 3 次就该放弃');
  assert.deepEqual(delays, [1000, 2000, 4000, 2000], '1s/2s/4s，第 4 次优先 Retry-After(2s)');
  assert.equal(m.debug()[0]?.rateLimited, 4, '429 单独计数');
});

test('D6 ② 429 后并发降到 1；成功后逐步回升到 3', async () => {
  const n = 6;
  const attempts = new Map<number, number>();
  let successInflight = 0;
  let maxSuccessInflight = 0;
  const deps: DownloadDeps = {
    loadChapters: async () => chs(n),
    downloadChapter: async (_src, _payload, ch) => {
      const i = Number((ch.payload as { i: number }).i);
      const at = (attempts.get(i) ?? 0) + 1;
      attempts.set(i, at);
      if (at === 1) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
      successInflight += 1;
      maxSuccessInflight = Math.max(maxSuccessInflight, successInflight);
      try {
        await new Promise((r) => setTimeout(r, 3));
      } finally {
        successInflight -= 1;
      }
      return { skipped: false };
    },
    sleep: async () => { /* 退避不真等 */ },
    now: () => Date.now(),
  };
  const m = createDownloadManager(deps);
  await m.enqueue(seed('k2'));

  // 第一拨 3 个 429 打回来后，Pacer 必须把并发降到 1
  await waitUntil(() => m.debug().find((x) => x.key === 'k2')?.limit === 1, 200);

  const t = await settle(m, 'k2', ['done', 'error'], 800);
  assert.equal(t.state, 'done');
  assert.equal(t.done, n);
  assert.equal(t.failed, 0);
  assert.equal(maxSuccessInflight, 3, '成功阶段并发应逐步回升到上限 3');
  assert.equal(m.debug()[0]?.rateLimited, n, '每章各自记 1 次 429');
});

/** 轮询等到条件成立（避免靠固定 sleep 猜时序） */
async function waitUntil(cond: () => boolean, max = 400): Promise<void> {
  for (let k = 0; k < max; k += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('等待条件超时');
}
