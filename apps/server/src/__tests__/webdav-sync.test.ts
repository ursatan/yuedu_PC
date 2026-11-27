/**
 * `#208` WebDAV 配置持久化 + 阅读进度同步（服务端侧）单测。
 *
 * 打桩 HTTP（PROPFIND/MKCOL/GET/PUT 全在本地），**不联网、不碰用户 3000**。
 * ★ 防空转约定：每个「跳过/拒绝」用例旁都有能通过的对照。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  emptyShelfBook,
  openUserStore,
  type HttpResponse,
  type ShelfBook,
  type UserDataStore,
} from '@yuedu/core';
import type { HttpRequestOptions } from '@yuedu/core';
import { WebDavConfigStore, syncBookProgress, type SyncReport } from '../webdav-sync';

const T0 = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');

/** 每个用例一个独立临时目录（**不能**放仓库 tmp/ —— 那会卡死 SQLite migrate，见 `_probe-env.mjs`） */
function tmpFile(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `webdav-${tag}-`));
  return path.join(dir, 'webdav.json');
}

const CFG = {
  url: 'https://dav.example.com/dav',
  username: 'u',
  password: 'p',
  dir: 'legado',
  authEncoding: 'utf-8',
} as const;

/* ── 打桩 WebDAV 服务器 ──────────────────────────────────────────── */

interface RemoteFile {
  body: string;
  lastModify: number;
}

function makeServer(opts: { files?: Record<string, RemoteFile>; failGet?: string[]; failPut?: string[] } = {}) {
  const files = new Map<string, RemoteFile>(Object.entries(opts.files ?? {}));
  const calls: Array<{ method?: string; url: string; body?: unknown }> = [];
  const base = 'https://dav.example.com/dav/legado/bookProgress/';

  const listing = (): string => {
    const items = [...files.entries()]
      .map(
        ([name, f]) => `<d:response>
        <d:href>/dav/legado/bookProgress/${encodeURIComponent(name)}</d:href>
        <d:propstat><d:prop>
          <d:displayname>${name}</d:displayname>
          <d:getcontentlength>${f.body.length}</d:getcontentlength>
          <d:getlastmodified>${new Date(f.lastModify).toUTCString()}</d:getlastmodified>
          <d:getcontenttype>application/json</d:getcontenttype>
          <d:resourcetype/>
        </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
      </d:response>`,
      )
      .join('\n');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items}</d:multistatus>`;
  };

  const http = {
    request: async (url: string, o: HttpRequestOptions = {}): Promise<HttpResponse> => {
      const method = o.method ?? 'GET';
      calls.push({ method, url, body: o.body });
      if (method === 'MKCOL') return { status: 201, headers: {}, body: '', url };
      if (method === 'PROPFIND') {
        const depth = o.headers?.['Depth'] ?? '1';
        return { status: 207, headers: {}, body: depth === '0' ? '<d:multistatus xmlns:d="DAV:"/>' : listing(), url };
      }
      if (method === 'GET') {
        const name = decodeURIComponent(url.slice(base.length));
        if (opts.failGet?.includes(name)) return { status: 500, headers: {}, body: 'boom', url };
        const f = files.get(name);
        if (!f) return { status: 404, headers: {}, body: '', url };
        return { status: 200, headers: {}, body: f.body, url };
      }
      if (method === 'PUT') {
        const name = decodeURIComponent(url.slice(base.length));
        if (opts.failPut?.includes(name)) return { status: 500, headers: {}, body: 'boom', url };
        files.set(name, { body: String(o.body ?? ''), lastModify: T0 });
        return { status: 201, headers: {}, body: '', url };
      }
      return { status: 405, headers: {}, body: '', url };
    },
  };
  return { http, files, calls, base };
}

async function memStore(books: ShelfBook[]): Promise<UserDataStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webdav-store-'));
  const { store } = await openUserStore({ dir, kind: 'json' });
  for (const b of books) await store.upsertBook(b);
  return store;
}

function book(over: Partial<ShelfBook> = {}): ShelfBook {
  return { ...emptyShelfBook(), type: 8, ...over };
}

/* ── 配置持久化 ──────────────────────────────────────────────────── */

test('#208 配置：未配置 ⇒ configured=false；put 之后**重启仍在**，且 state 里**没有密码**', () => {
  const file = tmpFile('fresh');
  const s1 = new WebDavConfigStore(file);
  assert.equal(s1.state().configured, false);
  assert.equal(s1.getConfig(), null);

  s1.put({ ...CFG });
  const again = new WebDavConfigStore(file);
  assert.equal(again.state().configured, true);
  // ★ 密码绝不能出现在对外状态里
  assert.equal(again.state().config.password, '');
  assert.equal(again.state().config.hasPassword, true);
  assert.equal(JSON.stringify(again.state()).includes('"p"'), false, '序列化后的 state 里不该出现明文密码');

  // 对照：磁盘上是有密码的（否则下次同步就没法认证了）
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as { config: { password: string } };
  assert.equal(onDisk.config.password, 'p');
});

test('#208 配置：del 清空；文件坏掉 ⇒ 当作未配置（不抛不崩）', () => {
  const file = tmpFile('del');
  const s = new WebDavConfigStore(file);
  s.put({ ...CFG });
  s.del();
  assert.equal(s.state().configured, false);
  assert.equal(fs.existsSync(file), false);

  const broken = tmpFile('broken');
  fs.writeFileSync(broken, '{ 不是 json', 'utf-8');
  assert.equal(new WebDavConfigStore(broken).state().configured, false, '坏配置不能让同步功能崩掉');

  // 对照：账号缺失的「看起来像配置」的文件 ⇒ 也算未配置
  const noUser = tmpFile('nouser');
  fs.writeFileSync(noUser, JSON.stringify({ config: { ...CFG, username: '' } }), 'utf-8');
  assert.equal(new WebDavConfigStore(noUser).state().configured, false);
});

/* ── 进度同步 ────────────────────────────────────────────────────── */

test('#208 同步：远端为空 ⇒ 全部上传（首次同步把本地进度铺上去）', async () => {
  // ★ `durChapterTime` 必须显式给成同一个值：`emptyShelfBook()` 默认取 `Date.now()`，
  // 两本书创建差 1ms 就会让 `listBooks` 的默认排序（lastRead = durChapterTime 倒序）反转，
  // 下面的 `uploaded` 断言变成「时有时无」的抖动（连跑 3 次：过/败/败）。平局 + 稳定排序 = 确定性。
  const store = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 3, durChapterPos: 5, durChapterTime: T0 }),
    book({ bookUrl: 'b', name: '丙', author: '丁', durChapterIndex: 1, durChapterPos: 0, durChapterTime: T0 }),
  ]);
  const cfgStore = new WebDavConfigStore(tmpFile('first'));
  cfgStore.put({ ...CFG });
  const srv = makeServer();

  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.equal(r.books, 2);
  assert.equal(r.remoteFiles, 0);
  assert.deepEqual(r.uploaded, ['a', 'b']);
  assert.deepEqual(r.adopted, []);
  assert.equal(r.errors.length, 0);
  // 上传后 syncTime 被记下来（下次同步就不会把刚传上去的再拉一遍）
  assert.equal((await store.getBook('a'))?.syncTime, T0);
  assert.equal(srv.files.size, 2);
  assert.equal(srv.files.get('甲_乙.json')?.body.includes('"durChapterIndex":3'), true);
});

test('#208 同步：远端更远 ⇒ 采用远端（本地被往前推），且**不会**把落后的本地传回去', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 3, durChapterPos: 5 })]);
  const cfgStore = new WebDavConfigStore(tmpFile('adopt'));
  cfgStore.put({ ...CFG });
  const srv = makeServer({
    files: {
      '甲_乙.json': {
        body: JSON.stringify({
          name: '甲',
          author: '乙',
          durChapterIndex: 9,
          durChapterPos: 20,
          durChapterTime: T0 - 1000,
          durChapterTitle: '第九章',
        }),
        lastModify: T0,
      },
    },
  });

  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.deepEqual(r.adopted, ['a']);
  assert.equal(r.downloaded, 1);
  const after = await store.getBook('a');
  assert.equal(after?.durChapterIndex, 9);
  assert.equal(after?.durChapterPos, 20);
  assert.equal(after?.durChapterTitle, '第九章');
  // ★ 时间取两侧较新的（远端 T0-1000、本地创建时间更晚 ⇒ 不该被倒退）
  assert.ok((after?.durChapterTime ?? 0) >= T0 - 1000);
  // 采用远端后本地 == 远端 ⇒ 不需要再上传
  assert.deepEqual(r.uploaded, [], '本地已被推到远端的位置，再传一次是纯粹浪费');
});

test('#208 同步：本地更远 ⇒ 上传本地（把落后的远端带齐）—— 反方向的对照', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 12, durChapterPos: 1 })]);
  const cfgStore = new WebDavConfigStore(tmpFile('push'));
  cfgStore.put({ ...CFG });
  const srv = makeServer({
    files: {
      '甲_乙.json': {
        body: JSON.stringify({ name: '甲', author: '乙', durChapterIndex: 2, durChapterPos: 0, durChapterTime: T0, durChapterTitle: null }),
        lastModify: T0,
      },
    },
  });

  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.deepEqual(r.adopted, []);
  assert.deepEqual(r.uploaded, ['a']);
  const after = await store.getBook('a');
  assert.equal(after?.durChapterIndex, 12, '本地不能被远端拉回去');
  assert.equal(JSON.parse(srv.files.get('甲_乙.json')?.body ?? '{}').durChapterIndex, 12, '远端被带齐到 12');
});

test('#208 同步：syncTime 哨兵 —— 远端没比上次同步更新 ⇒ 不下载', async () => {
  const store = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 3, durChapterPos: 5, syncTime: T0 }),
  ]);
  const cfgStore = new WebDavConfigStore(tmpFile('sentinel'));
  cfgStore.put({ ...CFG });
  // 远端 lastModify == T0，而本地 syncTime == T0 ⇒ 上游判据 `lastModify <= syncTime` ⇒ 跳过
  const srv = makeServer({
    files: {
      '甲_乙.json': {
        body: JSON.stringify({ name: '甲', author: '乙', durChapterIndex: 99, durChapterPos: 0, durChapterTime: T0, durChapterTitle: null }),
        lastModify: T0,
      },
    },
  });

  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.equal(r.downloaded, 0, '没更新的文件不该再下一遍');
  assert.equal((await store.getBook('a'))?.durChapterIndex, 3, '本地进度不受影响');

  // 对照：把远端的修改时间往后挪一秒 ⇒ 立刻下载并采用
  const srv2 = makeServer({
    files: {
      '甲_乙.json': {
        body: JSON.stringify({ name: '甲', author: '乙', durChapterIndex: 99, durChapterPos: 0, durChapterTime: T0, durChapterTitle: null }),
        lastModify: T0 + 1000,
      },
    },
  });
  const r2 = await syncBookProgress(store, cfgStore, { http: srv2.http, now: T0 + 1000 });
  assert.equal(r2.downloaded, 1);
  assert.deepEqual(r2.adopted, ['a']);
  assert.equal((await store.getBook('a'))?.durChapterIndex, 99);
});

test('#208 同步：远端文件写坏 ⇒ 记进 errors、本地**一个字都不改**（不做「尽力修复」）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 3, durChapterPos: 5 })]);
  const cfgStore = new WebDavConfigStore(tmpFile('bad'));
  cfgStore.put({ ...CFG });
  const srv = makeServer({ files: { '甲_乙.json': { body: '这不是 json', lastModify: T0 } } });

  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]?.error ?? '', /不是有效的进度文件/);
  const after = await store.getBook('a');
  assert.equal(after?.durChapterIndex, 3);
  assert.equal(after?.durChapterPos, 5);
});

test('#208 同步：某一本书下载失败 ⇒ **不中断**，其它书照常同步', async () => {
  const store = await memStore([
    book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 1 }),
    book({ bookUrl: 'b', name: '丙', author: '丁', durChapterIndex: 2 }),
  ]);
  const cfgStore = new WebDavConfigStore(tmpFile('partial'));
  cfgStore.put({ ...CFG });
  // ★ 「丙_丁」那份必须是**合法**进度、且**落后于本地**（这样它会被上传）⇒ 用它的上传证明「没被连累」
  const srv = makeServer({
    files: {
      '甲_乙.json': { body: '{}', lastModify: T0 },
      '丙_丁.json': {
        body: JSON.stringify({ name: '丙', author: '丁', durChapterIndex: 0, durChapterPos: 0, durChapterTime: T0, durChapterTitle: null }),
        lastModify: T0,
      },
    },
    failGet: ['甲_乙.json'],
  });

  const r: SyncReport = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.equal(r.errors.length, 1, '只有下载失败的那本进 errors');
  assert.equal(r.errors[0]?.bookUrl, 'a');
  assert.match(r.errors[0]?.error ?? '', /下载进度失败/);
  // ★ 阳性对照：另一本照常走完了「下载 → 判定 → 上传」
  assert.deepEqual(r.uploaded, ['b'], '一本失败不该连累另一本');
  assert.equal(JSON.parse(srv.files.get('丙_丁.json')?.body ?? '{}').durChapterIndex, 2, '远端被带齐到本地的进度');
});

test('#208 同步：上传失败也只记 errors（不抛）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 1 })]);
  const cfgStore = new WebDavConfigStore(tmpFile('putfail'));
  cfgStore.put({ ...CFG });
  const srv = makeServer({ failPut: ['甲_乙.json'] });
  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0 });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]?.error ?? '', /上传进度失败/);
});

test('#208 同步：未配置 / 开关关闭 ⇒ 明确报错（而不是静默什么都不做）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  const srv = makeServer();

  const unconfigured = new WebDavConfigStore(tmpFile('none'));
  await assert.rejects(() => syncBookProgress(store, unconfigured, { http: srv.http }), /还没配置/);

  const off = new WebDavConfigStore(tmpFile('off'));
  off.put({ ...CFG }, false);
  assert.equal(off.syncProgressEnabled(), false);
  await assert.rejects(() => syncBookProgress(store, off, { http: srv.http }), /已关闭/);
});

test('#208 同步：远端目录列不出来 ⇒ **整体**报错（这种失败没法只对某一本书生效）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  const cfgStore = new WebDavConfigStore(tmpFile('listdir'));
  cfgStore.put({ ...CFG });
  const http = {
    request: async (url: string) => ({ status: 500, headers: {}, body: 'boom', url }) as HttpResponse,
  };
  await assert.rejects(() => syncBookProgress(store, cfgStore, { http }), /列不出远端进度目录/);
});

test('#208 同步：downloadOnly 只拉不传', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 1 })]);
  const cfgStore = new WebDavConfigStore(tmpFile('pullonly'));
  cfgStore.put({ ...CFG });
  const srv = makeServer({
    files: {
      '甲_乙.json': {
        body: JSON.stringify({ name: '甲', author: '乙', durChapterIndex: 7, durChapterPos: 3, durChapterTime: T0, durChapterTitle: null }),
        lastModify: T0,
      },
    },
  });
  const r = await syncBookProgress(store, cfgStore, { http: srv.http, now: T0, downloadOnly: true });
  assert.deepEqual(r.adopted, ['a']);
  assert.deepEqual(r.uploaded, [], 'downloadOnly 不该有 PUT');
  assert.equal(srv.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal((await store.getBook('a'))?.durChapterIndex, 7);
});

/* ── `B7` ④ 备份保留份数（配置持久化的一部分） ─────────────────────── */

test('B7 ④ 保留份数：默认 1、夹紧 1~10，restart 后仍在', () => {
  const file = tmpFile('keep-clamp');
  const s = new WebDavConfigStore(file);
  assert.equal(s.state().backupKeep, 1, '★ 默认 1（只保留最新）');
  assert.equal(s.backupKeepCount(), 1);

  s.put({ ...CFG });
  s.setBackupKeep(3);
  const again = new WebDavConfigStore(file);
  assert.equal(again.state().backupKeep, 3, '重启后仍在（落盘）');
  assert.equal(again.state().configured, true);
  // 对照：只改份数不该动配置本身
  assert.equal(again.state().config.hasPassword, true);

  again.setBackupKeep(0);
  assert.equal(again.backupKeepCount(), 1, '0 ⇒ 夹到 1');
  again.setBackupKeep(-5);
  assert.equal(again.backupKeepCount(), 1, '负数 ⇒ 夹到 1');
  again.setBackupKeep(99);
  assert.equal(again.backupKeepCount(), 10, '超过 10 ⇒ 夹到 10');
  again.setBackupKeep(2.9);
  assert.equal(again.backupKeepCount(), 2, '小数向下取整');

  // 对照：只改配置/开关时**沿用**旧份数（不冲成默认 1）
  again.put({ ...CFG }, false);
  assert.equal(again.state().backupKeep, 2);
  assert.equal(again.state().syncProgress, false);
});

test('B7 ④ 保留份数：手改坏的值不会让功能崩掉（回落到默认 1）', () => {
  const file = tmpFile('keep-bad');
  fs.writeFileSync(
    file,
    JSON.stringify({ config: { ...CFG }, backupKeep: '不是数字' }),
    'utf-8',
  );
  const s = new WebDavConfigStore(file);
  assert.equal(s.state().configured, true, '配置本身仍然有效');
  assert.equal(s.state().backupKeep, 1, '坏值回落默认 1，而不是崩溃/NaN');

  // 对照：合法值照常读出来（证明上面的回落不是「永远读不到数字」的空转）
  const good = tmpFile('keep-good');
  fs.writeFileSync(good, JSON.stringify({ config: { ...CFG }, backupKeep: 4 }), 'utf-8');
  assert.equal(new WebDavConfigStore(good).state().backupKeep, 4);
});
