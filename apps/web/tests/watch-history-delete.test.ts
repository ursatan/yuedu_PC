/**
 * 观影历史删除语义回归（数据 bug：删除后刷新/重开详情会复活）。
 *
 * 两条不变量：
 *  1. `clearHistory` / `removeWatch` 必须**同删 shelf 里的 notShelf 行**（那是历史在服务端的副本），
 *     且**不动收藏行**（收藏行的 notShelf 为 false）；
 *  2. 设置页「清空观影历史」必须走 `reader.clearHistory()` ——
 *     只清本地 `yuedu-watch-history` 的话，下次启动 `hydrateShelf` 会从 shelf 回填 ⇒ 复活。
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPinia, setActivePinia } from 'pinia';
import { BookType, emptyShelfBook, encodeItemKey, type BookTombstone, type ShelfBook as ContractShelfBook } from '@yuedu/core/contract';
import { useReaderStore, type ShelfBook } from '../src/stores/reader';

/** Node 测试环境没有 localStorage；reader store 初始化会读它 */
const memory = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  get length() { return memory.size; },
  clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null,
  key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => { memory.delete(k); },
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
};

beforeEach(() => {
  memory.clear();
  setActivePinia(createPinia());
});

function videoRow(key: string, notShelf: boolean): ShelfBook {
  return {
    key,
    sourceId: 'testsrc',
    payload: { id: key },
    title: key,
    kind: 'video',
    notShelf,
    updatedAt: 1,
  } as unknown as ShelfBook;
}

test('clearHistory：删除 shelf 里的 notShelf 历史行，保留收藏行', () => {
  const r = useReaderStore();
  r.shelf.push(videoRow('hist', true));
  r.shelf.push(videoRow('fav', false));
  r.watchHistory.push({ key: 'hist', sourceId: 'testsrc', payload: { id: 'hist' }, title: 'hist', updatedAt: 1 } as never);

  r.clearHistory();

  assert.equal(r.watchHistory.length, 0, '本地观看历史必须清空');
  assert.deepEqual(r.shelf.map((b) => b.key), ['fav'], 'notShelf 行（服务端副本）必须同删，收藏行必须保留');
});

test('removeWatch：只删该条历史行，不动收藏行', () => {
  const r = useReaderStore();
  r.shelf.push(videoRow('hist', true));
  r.shelf.push(videoRow('fav', false));
  r.watchHistory.push({ key: 'hist', sourceId: 'testsrc', payload: { id: 'hist' }, title: 'hist', updatedAt: 1 } as never);
  // 真实调用方传的是列表里的引用（reactive 代理），这里保持一致
  const e = r.watchHistory[0]!;

  r.removeWatch(e);

  assert.equal(r.watchHistory.length, 0);
  assert.deepEqual(r.shelf.map((b) => b.key), ['fav']);
});

test('设置页「清空观影历史」必须走 store.clearHistory（不能只清本地缓存）', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/views/SettingsView.vue', import.meta.url)), 'utf8');
  const start = src.indexOf('function clearWatch()');
  const end = src.indexOf('function clearShelf()');
  assert.ok(start > 0 && end > start, 'SettingsView 里应能找到 clearWatch / clearShelf');
  const fn = src.slice(start, end);
  assert.match(fn, /reader\.clearHistory\(\)/, '清空观影历史必须删服务端副本（走 store）');
  assert.doesNotMatch(fn, /localStorage\.removeItem\(/, '只清 localStorage 会在下次 hydrate 时被回填');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 跨端一致删除（用户 2026-11-08 澄清：是**单条**删除，第二天又出现）
 *
 * 复现的机制（修复前）：另一端陈旧的 localStorage 在启动 `hydrateShelf` 时，
 * `pull({ mergeLocal: true })` 把「服务端没有的本地独有行」**立即 PUT 补推** ⇒
 * 已删除的行回到服务端，随后所有端又从 shelf 的 notShelf 行回填 history ⇒ 复活。
 * 修复：服务端记**墓碑**（bookUrl + deletedAt），启动时先拉墓碑、把比墓碑更旧的行剔除，
 * 且服务端拒绝 `durChapterTime < deletedAt` 的写入（双保险）。
 * ══════════════════════════════════════════════════════════════════════════ */

const SHELF_LOCAL_KEY = 'yuedu-bookshelf';
const WATCH_LOCAL_KEY = 'yuedu-watch-history';

/** 契约形态的一行影视（notShelf=true 即「观影历史」的服务端副本） */
function contractVideo(key: string, updatedAt: number): ContractShelfBook {
  return {
    ...emptyShelfBook(updatedAt),
    bookUrl: encodeItemKey(key),
    origin: 'testsrc',
    name: key,
    type: BookType.video | BookType.notShelf,
    durChapterTime: updatedAt,
  };
}

/** 本地 shelf 的陈旧副本（与 store 的 ShelfBook 同形） */
function staleShelf(key: string, updatedAt: number): ShelfBook {
  return { key, sourceId: 'testsrc', payload: { id: key }, title: key, kind: 'video', notShelf: true, updatedAt } as unknown as ShelfBook;
}

function staleWatch(key: string, updatedAt: number): unknown {
  return { key, sourceId: 'testsrc', payload: { id: key }, title: key, updatedAt };
}

/** 极简假服务端：只覆盖书架 + 墓碑四条路径，且**照抄**真实服务端的「删除优先」写入校验 */
function installFakeServer(): { books: ContractShelfBook[]; deleted: BookTombstone[]; calls: string[] } {
  const books: ContractShelfBook[] = [];
  const deleted: BookTombstone[] = [];
  const calls: string[] = [];
  const json = (body: unknown) =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
  (globalThis as { fetch?: unknown }).fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://test.local');
    const method = (init?.method ?? 'GET').toUpperCase();
    const p = url.pathname.replace(/^\/api\/user/, '');
    calls.push(`${method} ${p}${url.search}`);
    if (p === '/books' && method === 'GET') return json(books);
    if (p === '/books/deleted' && method === 'GET') return json({ deleted });
    if (p === '/books' && method === 'PUT') {
      const b = JSON.parse(String(init?.body)) as ContractShelfBook;
      const t = deleted.find((x) => x.bookUrl === b.bookUrl);
      // 「删除优先」：比墓碑更旧的写入一律忽略（真实服务端在 `writeBookOne` 里做同一件事）
      if (t && (b.durChapterTime ?? 0) < t.deletedAt) return json({ ok: true, ignored: true });
      if (t) deleted.splice(deleted.indexOf(t), 1);
      const i = books.findIndex((x) => x.bookUrl === b.bookUrl);
      if (i >= 0) books[i] = b;
      else books.push(b);
      return json({ ok: true });
    }
    if (p === '/books' && method === 'DELETE') {
      const bookUrl = url.searchParams.get('bookUrl') ?? '';
      const i = books.findIndex((x) => x.bookUrl === bookUrl);
      if (i >= 0) books.splice(i, 1);
      // 墓碑时间用**服务端时钟**（客户端传不可信）
      deleted.push({ bookUrl, deletedAt: Date.now() });
      return json({ ok: true });
    }
    return json({ error: `unhandled ${method} ${p}` });
  };
  return { books, deleted, calls };
}

/** 模拟一台设备启动：清空 localStorage（可选塞入陈旧缓存）→ 新 Pinia → 启动对齐 */
async function bootDevice(seed?: { shelf?: unknown[]; watch?: unknown[] }): Promise<Awaited<ReturnType<ReturnType<typeof useReaderStore>['hydrateShelf']>>> {
  memory.clear();
  if (seed?.shelf) memory.set(SHELF_LOCAL_KEY, JSON.stringify(seed.shelf));
  if (seed?.watch) memory.set(WATCH_LOCAL_KEY, JSON.stringify(seed.watch));
  setActivePinia(createPinia());
  return useReaderStore().hydrateShelf();
}

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('跨端：一端删除单条历史后，另一端陈旧缓存既不会复活它、也不会把它 PUT 回服务端', async () => {
  const server = installFakeServer();
  const key = 'hist-1';
  const T0 = 1000;
  server.books.push(contractVideo(key, T0));

  // ── 设备 A：正常对齐 → 删除这一条历史 ──
  await bootDevice();
  const a = useReaderStore();
  assert.equal(a.watchHistory.length, 1, 'A 端应先看到服务端这条历史');
  a.removeWatch(a.watchHistory[0]!);
  await waitFor(() => server.books.length === 0);
  assert.equal(server.books.length, 0, 'A 端删除必须真的落到服务端');
  assert.ok(server.deleted.some((t) => t.bookUrl === encodeItemKey(key)), '服务端必须留下墓碑');

  // ── 设备 B：localStorage 里还是删除前的陈旧副本（等价于「第二天打开 PC 端」） ──
  const before = server.calls.length;
  await bootDevice({ shelf: [staleShelf(key, T0)], watch: [staleWatch(key, T0)] });
  const b = useReaderStore();
  assert.equal(b.shelf.length, 0, '另一端陈旧书架行必须被墓碑清掉');
  assert.equal(b.watchHistory.length, 0, '另一端陈旧观影历史必须被清掉');
  assert.equal(server.books.length, 0, '已删行不得被重新 PUT 回服务端');
  assert.equal(server.deleted.length, 1, '墓碑不应被陈旧写入清掉');
  assert.ok(
    !server.calls.slice(before).some((c) => c.startsWith('PUT')),
    `启动同步不应再上传任何行（实际调用：${server.calls.slice(before).join(' | ')}）`,
  );
});

test('墓碑不误杀：删除之后重新加入/重新观看（行时间更晚）应保留，并清掉墓碑', async () => {
  const server = installFakeServer();
  const key = 're-added';
  server.deleted.push({ bookUrl: encodeItemKey(key), deletedAt: 1000 });

  await bootDevice({ shelf: [staleShelf(key, 2000)], watch: [staleWatch(key, 2000)] });
  const d = useReaderStore();
  await waitFor(() => server.books.length === 1);
  assert.equal(d.shelf.length, 1, '比墓碑更新的行是用户的重新加入/重新观看，不得误删');
  assert.equal(d.watchHistory.length, 1);
  assert.equal(server.books.length, 1, '较新的行应被上传');
  assert.equal(server.deleted.length, 0, '较新的写入应清掉墓碑（否则以后永远加不回来）');
});
