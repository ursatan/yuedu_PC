/**
 * `#208` ④ 整库备份 / 恢复单测（zip 真打真解 + HTTP 打桩）。
 *
 * ★ 防空转约定：每个「拒绝/回落」用例旁都有能通过的对照。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { emptyShelfBook, openUserStore, type HttpResponse, type ShelfBook, type UserDataStore } from '@yuedu/core';
import type { HttpRequestOptions } from '@yuedu/core';
import { readZipEntry } from '@yuedu/facade';
import { WebDavConfigStore } from '../webdav-sync';
import {
  BACKUP_ENTRY_NAME,
  backupFileName,
  buildBackupZip,
  isBackupName,
  listBackups,
  pruneBackups,
  restoreBackup,
  uploadBackup,
} from '../webdav-backup';

const CFG = {
  url: 'https://dav.example.com/dav',
  username: 'u',
  password: 'p',
  dir: 'legado',
  authEncoding: 'utf-8',
} as const;

function tmpFile(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `wdbk-${tag}-`)), 'webdav.json');
}

/** 打桩 WebDAV：根目录下放若干文件，支持 PUT/GET/PROPFIND/DELETE */
function stubRoot(
  files: Record<string, Uint8Array> = {},
  opts: { failPut?: boolean; failDelete?: string[]; mtimes?: Record<string, number> } = {},
) {
  const store = new Map<string, Uint8Array>(Object.entries(files));
  const calls: Array<{ method?: string; url: string; body?: unknown }> = [];
  const root = 'https://dav.example.com/dav/legado/';
  const defaultMtime = 1_790_000_000_000;
  const http = {
    request: async (url: string, o: HttpRequestOptions = {}): Promise<HttpResponse> => {
      const method = o.method ?? 'GET';
      calls.push({ method, url, body: o.body });
      if (method === 'MKCOL') return { status: 201, headers: {}, body: '', url };
      if (method === 'PROPFIND') {
        const depth = o.headers?.['Depth'] ?? '1';
        if (depth === '0') return { status: 207, headers: {}, body: '<d:multistatus xmlns:d="DAV:"/>', url };
        const items = [...store.entries()]
          .map(
            ([name, b]) => `<d:response><d:href>/dav/legado/${encodeURIComponent(name)}</d:href><d:propstat><d:prop>
            <d:displayname>${name}</d:displayname><d:getcontentlength>${b.length}</d:getcontentlength>
            <d:getlastmodified>${new Date(opts.mtimes?.[name] ?? defaultMtime).toUTCString()}</d:getlastmodified>
            <d:getcontenttype>application/zip</d:getcontenttype><d:resourcetype/>
          </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          )
          .join('\n');
        return { status: 207, headers: {}, body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items}</d:multistatus>`, url };
      }
      if (method === 'GET') {
        const name = decodeURIComponent(url.slice(root.length));
        const b = store.get(name);
        if (!b) return { status: 404, headers: {}, body: '', url };
        // `buffer` 的静态类型是 `ArrayBufferLike`（含 SharedArrayBuffer）⇒ 显式取一段得到真正的 ArrayBuffer
        const ab = new ArrayBuffer(b.length);
        new Uint8Array(ab).set(b);
        return { status: 200, headers: {}, body: ab, url };
      }
      if (method === 'PUT') {
        if (opts.failPut) return { status: 500, headers: {}, body: 'no space', url };
        const name = decodeURIComponent(url.slice(root.length));
        const body = o.body instanceof Uint8Array ? o.body : new TextEncoder().encode(String(o.body ?? ''));
        store.set(name, body);
        return { status: 201, headers: {}, body: '', url };
      }
      if (method === 'DELETE') {
        const name = decodeURIComponent(url.slice(root.length));
        if (opts.failDelete?.includes(name)) return { status: 500, headers: {}, body: 'locked', url };
        store.delete(name);
        return { status: 204, headers: {}, body: '', url };
      }
      return { status: 405, headers: {}, body: '', url };
    },
  };
  return { http, store, calls };
}

async function memStore(books: ShelfBook[]): Promise<UserDataStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdbk-store-'));
  const { store } = await openUserStore({ dir, kind: 'json' });
  for (const b of books) await store.upsertBook(b);
  return store;
}

function book(over: Partial<ShelfBook> = {}): ShelfBook {
  return { ...emptyShelfBook(), type: 8, ...over };
}

/* ── 命名与产物 ──────────────────────────────────────────────────── */

test('#208 备份文件名：backup<yyyy-MM-dd>.zip（上游格式，本地日期）', () => {
  assert.equal(backupFileName(new Date(2026, 9, 6, 23, 59)), 'backup2026-10-06.zip');
  assert.equal(backupFileName(new Date(2026, 0, 1, 0, 0)), 'backup2026-01-01.zip', '月/日补零');
  // 对照：判「是不是备份」只看前缀（上游 getBackupNames 就是这么筛的）
  assert.equal(isBackupName('backup2026-10-06.zip'), true);
  assert.equal(isBackupName('backup2026-10-06-我的电脑.zip'), true, '带设备名后缀也算');
  assert.equal(isBackupName('books/a.json'), false);
  assert.equal(isBackupName('mybackup.zip'), false, '前缀必须真的是开头');
});

test('#208 备份产物：zip 里恰好一个条目，解出来是能 parse 的快照', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  const { zip, books } = await buildBackupZip(store);
  assert.equal(books, 1);
  const raw = readZipEntry(zip, BACKUP_ENTRY_NAME);
  const snap = JSON.parse(new TextDecoder('utf-8').decode(raw)) as { version: number; books: unknown[] };
  assert.equal(snap.version, 1);
  assert.equal(snap.books.length, 1);
  // 对照：条目名不对 ⇒ 明确报错（不是返回空）
  assert.throws(() => readZipEntry(zip, '别的.json'), /没有这个条目/);
});

/* ── 上传与列表 ──────────────────────────────────────────────────── */

test('#208 上传备份：PUT 到根目录、Content-Type 是 zip、记下书数与字节数', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  const cfgStore = new WebDavConfigStore(tmpFile('up'));
  cfgStore.put({ ...CFG });
  const stub = stubRoot();

  const r = await uploadBackup(store, cfgStore, { http: stub.http, now: new Date(2026, 9, 6).getTime() });
  assert.equal(r.fileName, 'backup2026-10-06.zip');
  assert.equal(r.books, 1);
  assert.ok(r.bytes > 0);
  const put = stub.calls.find((c) => c.method === 'PUT');
  assert.equal(put?.url, 'https://dav.example.com/dav/legado/backup2026-10-06.zip');
  assert.ok(stub.store.has('backup2026-10-06.zip'));
});

test('#208 列备份：只留 backup 前缀、按时间倒序；目录与非备份文件被过滤', async () => {
  const cfgStore = new WebDavConfigStore(tmpFile('list'));
  cfgStore.put({ ...CFG });
  const zip = new Uint8Array([1, 2, 3]);
  const stub = stubRoot({ 'backup2026-10-06.zip': zip, 'backup2026-10-05.zip': zip, 'readme.txt': zip });
  const list = await listBackups(cfgStore, { http: stub.http });
  assert.deepEqual(
    list.map((x) => x.name),
    ['backup2026-10-06.zip', 'backup2026-10-05.zip'],
    'readme.txt 不该进列表',
  );
  assert.equal(list[0]?.size, 3);
});

test('#208 未配置 ⇒ 明确报错（三个入口一致）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲' })]);
  const none = new WebDavConfigStore(tmpFile('none'));
  await assert.rejects(() => uploadBackup(store, none, { http: stubRoot().http }), /还没配置/);
  await assert.rejects(() => listBackups(none, { http: stubRoot().http }), /还没配置/);
  await assert.rejects(() => restoreBackup(store, none, 'backup2026-10-06.zip', { http: stubRoot().http }), /还没配置/);
});

/* ── 恢复 ────────────────────────────────────────────────────────── */

test('#208 恢复：解 zip → 非累加导入（**删掉的书能回来**、已有的被覆盖）', async () => {
  // 先造一份「有 2 本书」的备份
  const src = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 7 }),
    book({ bookUrl: 'b', name: '丙', author: '丁' }),
  ]);
  const { zip } = await buildBackupZip(src);

  // 目标库：a 的进度落后、b 被删了、另有一本 c（恢复不该动它 —— importSnapshot 不删数据）
  const dst = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 1 }),
    book({ bookUrl: 'c', name: '戊', author: '己' }),
  ]);
  const cfgStore = new WebDavConfigStore(tmpFile('restore'));
  cfgStore.put({ ...CFG });
  const stub = stubRoot({ 'backup2026-10-06.zip': zip });

  const r = await restoreBackup(dst, cfgStore, 'backup2026-10-06.zip', { http: stub.http });
  assert.equal(r.fileName, 'backup2026-10-06.zip');
  // ★ 计数是真信号：b 是「新增」，a 是「覆盖」—— 用它证明走的确实是**非累加**管线
  assert.equal(r.counts.books.added, 1, 'b 被迎回来');
  assert.equal(r.counts.books.updated, 1, 'a 被覆盖成备份里的进度');
  assert.equal(r.counts.books.kept, 0);

  const a = await dst.getBook('a');
  assert.equal(a?.durChapterIndex, 7, '★ 非累加：已有的书被覆盖成备份里的进度（不是「取更旧/更新」）');
  const b = await dst.getBook('b');
  assert.ok(b, '★ 删掉的书回来了 —— 这正是「恢复」与「合并导入」的区别');
  assert.ok(await dst.getBook('c'), '恢复不删除现有数据（importSnapshot 只写不删）');
});

test('#208 恢复：名字不像备份 ⇒ 400 级错误；zip 里没有快照条目 ⇒ 说清为什么', async () => {
  const store = await memStore([]);
  const cfgStore = new WebDavConfigStore(tmpFile('bad'));
  cfgStore.put({ ...CFG });

  await assert.rejects(
    () => restoreBackup(store, cfgStore, 'readme.txt', { http: stubRoot().http }),
    /不是备份文件/,
  );

  // 一个「是 zip 但没有快照条目」的包（比如别的东西压出来的）
  // `#621`：解包迁到 `backup-build.readBackupArchive`，文案改成「备份里没有 yuedu-snapshot.json
  // + 手机端格式不同」—— 判据（必须说清为什么解不开）不变，故同步这条断言。
  const { zipSingleFile } = await import('@yuedu/facade');
  const other = zipSingleFile('other.json', new TextEncoder().encode('{}'));
  await assert.rejects(
    () => restoreBackup(store, cfgStore, 'backup2026-10-06.zip', { http: stubRoot({ 'backup2026-10-06.zip': other }).http }),
    /没有 yuedu-snapshot\.json/,
  );

  // 完全不是 zip 的字节 ⇒ 也要说清（不能抛一堆二进制错误）
  await assert.rejects(
    () =>
      restoreBackup(store, cfgStore, 'backup2026-10-06.zip', {
        http: stubRoot({ 'backup2026-10-06.zip': new TextEncoder().encode('这不是zip') }).http,
      }),
    /不是一份有效的备份 zip/,
  );
});

test('#208 上传失败（网盘没空间）⇒ 把错误抛出来（不静默说「已备份」）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲' })]);
  const cfgStore = new WebDavConfigStore(tmpFile('fail'));
  cfgStore.put({ ...CFG });
  await assert.rejects(() => uploadBackup(store, cfgStore, { http: stubRoot({}, { failPut: true }).http }), /HTTP 500|no space|未知错误/);
});

/* ── `B7` ③ 恢复方式：合并 / 覆盖 ─────────────────────────────────── */

test('B7 ③ 恢复 merge：只补缺失、不覆盖已有（与默认 overwrite 成对照）', async () => {
  const src = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 7 }),
    book({ bookUrl: 'b', name: '丙', author: '丁' }),
  ]);
  const { zip } = await buildBackupZip(src);

  // 目标库：a 的进度落后（合并时**不该被覆盖**）、b 缺（合并时**该补上**）、c 本机独有
  const dst = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 1 }),
    book({ bookUrl: 'c', name: '戊', author: '己' }),
  ]);
  const cfgStore = new WebDavConfigStore(tmpFile('merge'));
  cfgStore.put({ ...CFG });
  const stub = stubRoot({ 'backup2026-10-06.zip': zip });

  const r = await restoreBackup(dst, cfgStore, 'backup2026-10-06.zip', { http: stub.http, mode: 'merge' });
  assert.equal(r.counts.books.added, 1, 'b 被补上');
  assert.equal(r.counts.books.updated, 0, '★ 合并：a 不该被备份里的旧进度覆盖');
  assert.equal(r.counts.books.kept, 1, 'a 原样保留');
  assert.equal((await dst.getBook('a'))?.durChapterIndex, 1, '★ a 的本机进度没被动');
  assert.ok(await dst.getBook('b'), 'b 补上了');
  assert.ok(await dst.getBook('c'), 'c 不动');

  // 对照：同一份备份 + 同样目标库 ⇒ 默认覆盖把 a 推回 7
  const dst2 = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 1 }),
    book({ bookUrl: 'c', name: '戊', author: '己' }),
  ]);
  const r2 = await restoreBackup(dst2, cfgStore, 'backup2026-10-06.zip', { http: stub.http });
  assert.equal(r2.counts.books.updated, 1, '默认 overwrite：a 被覆盖');
  assert.equal((await dst2.getBook('a'))?.durChapterIndex, 7);
});

/* ── `B7` ④ 备份轮转 ─────────────────────────────────────────────── */

test('B7 ④ 轮转：默认只保留最新 1 份；非备份文件绝不被删', async () => {
  const cfgStore = new WebDavConfigStore(tmpFile('prune1'));
  cfgStore.put({ ...CFG });
  const zip = new Uint8Array([1, 2, 3]);
  const stub = stubRoot(
    { 'backup2026-10-06.zip': zip, 'backup2026-10-05.zip': zip, 'backup2026-10-04.zip': zip, 'readme.txt': zip },
    {
      mtimes: {
        'backup2026-10-06.zip': 1_790_100_000_000,
        'backup2026-10-05.zip': 1_790_000_000_000,
        'backup2026-10-04.zip': 1_789_900_000_000,
        'readme.txt': 1_790_200_000_000,
      },
    },
  );

  const r = await pruneBackups(cfgStore, undefined, { http: stub.http });
  assert.equal(r.keep, 1, '★ 默认 1：只保留最新');
  assert.deepEqual(r.kept, ['backup2026-10-06.zip']);
  assert.deepEqual(r.deleted, ['backup2026-10-05.zip', 'backup2026-10-04.zip']);
  assert.equal(stub.store.has('backup2026-10-06.zip'), true);
  assert.equal(stub.store.has('backup2026-10-05.zip'), false);
  assert.equal(stub.store.has('readme.txt'), true, '★ 非 backup 前缀的文件不能被轮转删掉');
});

test('B7 ④ 轮转：保留份数夹紧到 1~10；单份删失败不阻断其余', async () => {
  const cfgStore = new WebDavConfigStore(tmpFile('prune2'));
  cfgStore.put({ ...CFG });
  const zip = new Uint8Array([1]);
  const files = {
    'backup2026-10-06.zip': zip,
    'backup2026-10-05.zip': zip,
    'backup2026-10-04.zip': zip,
    'backup2026-10-03.zip': zip,
  };
  const mtimes = {
    'backup2026-10-06.zip': 1_790_100_000_000,
    'backup2026-10-05.zip': 1_790_000_000_000,
    'backup2026-10-04.zip': 1_789_900_000_000,
    'backup2026-10-03.zip': 1_789_800_000_000,
  };

  // keep=2，第二老的那份删不掉 ⇒ 只删最老的那份，删失败的那份留着
  const stub = stubRoot(files, { mtimes, failDelete: ['backup2026-10-04.zip'] });
  const r = await pruneBackups(cfgStore, '2', { http: stub.http });
  assert.equal(r.keep, 2, '字符串 "2" 也要能归一成 2');
  assert.deepEqual(r.kept, ['backup2026-10-06.zip', 'backup2026-10-05.zip']);
  assert.deepEqual(r.deleted, ['backup2026-10-03.zip'], '单份失败不阻断其余');
  assert.equal(stub.store.has('backup2026-10-04.zip'), true, '删不掉就留着（下次备份再清）');

  // 夹紧：0 / 负数 ⇒ 1；超过 10 ⇒ 10
  assert.equal((await pruneBackups(cfgStore, 0, { http: stubRoot(files, { mtimes }).http })).keep, 1);
  assert.equal((await pruneBackups(cfgStore, -3, { http: stubRoot(files, { mtimes }).http })).keep, 1);
  assert.equal((await pruneBackups(cfgStore, 99, { http: stubRoot(files, { mtimes }).http })).keep, 10);
  assert.equal((await pruneBackups(cfgStore, '随便什么', { http: stubRoot(files, { mtimes }).http })).keep, 1);
  // 对照：份数足够大 ⇒ 一份都不删
  const all = await pruneBackups(cfgStore, 10, { http: stubRoot(files, { mtimes }).http });
  assert.deepEqual(all.deleted, []);
  assert.equal(all.kept.length, 4);
});

test('B7 ④ 轮转：未配置 ⇒ 明确报错（与备份/恢复同一口径）', async () => {
  const none = new WebDavConfigStore(tmpFile('prune-none'));
  await assert.rejects(() => pruneBackups(none, 1, { http: stubRoot().http }), /还没配置/);
});
