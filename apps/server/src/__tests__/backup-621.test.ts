/**
 * `#621` 备份可勾选项 + AES 单测。
 *
 * ★ 防空转约定：每个「拒绝 / 跳过」用例旁边都有一条**能通过**的对照
 * （否则「抛错了」可能只是因为整个功能没通）。
 *
 * 掺假的地方：`cookies` / `源变量` 用假 provider 注入（真实现要 `hub`）；
 * 其余全部走**真的** `openUserStore` + 真的 zip + 真的 AES。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { emptyShelfBook, openUserStore, type ShelfBook, type UserDataStore } from '@yuedu/core';
import { readZip, listZipEntries } from '@yuedu/facade';
import {
  BACKUP_OPTIONS,
  BackupOptionError,
  COOKIE_ENTRY,
  SNAPSHOT_ENTRY,
  SOURCE_VAR_ENTRY,
  UNSUPPORTED_BACKUP_OPTIONS,
  buildBackup,
  defaultBackupOptions,
  filterSnapshotByIncluded,
  normalizeBackupOptions,
  readBackupArchive,
  type BackupSnapshot,
} from '../backup-build';
import { decryptBackupText } from '../backup-aes';
import { importSnapshot } from '@yuedu/core';

const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime();
const dec = new TextDecoder();

function book(over: Partial<ShelfBook> = {}): ShelfBook {
  return { ...emptyShelfBook(), type: 8, ...over };
}

async function memStore(books: ShelfBook[] = []): Promise<UserDataStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk621-'));
  const { store } = await openUserStore({ dir, kind: 'json' });
  for (const b of books) await store.upsertBook(b);
  return store;
}

/** 解出一份备份的条目名 → 文本 */
function entriesOf(zip: Uint8Array): Map<string, string> {
  const m = readZip(zip);
  const out = new Map<string, string>();
  for (const [k, v] of m) out.set(k, dec.decode(v));
  return out;
}

/* ── 勾选项本身 ─────────────────────────────────────────────────── */

test('#621 默认勾选 = 书架/书签/规则/阅读记录/设置；目录与两个敏感项默认不勾', () => {
  const d = defaultBackupOptions();
  assert.deepEqual([...d].sort(), ['annotations', 'bookshelf', 'history', 'rules', 'settings']);
  assert.equal(d.has('chapters'), false, '目录体量大，默认不带');
  assert.equal(d.has('cookies'), false, '敏感项默认不带（需要口令）');
  assert.equal(d.has('sourceVariables'), false);
  // 只读元数据不许出现「假选项」：每个 id 都必须有说明
  for (const o of BACKUP_OPTIONS) assert.ok(o.desc.length > 4, `${o.id} 缺说明`);
  // 本仓确实没有的项要登记理由，而不是偷偷做一个空选项
  assert.equal(UNSUPPORTED_BACKUP_OPTIONS.length >= 3, true);
  for (const u of UNSUPPORTED_BACKUP_OPTIONS) assert.ok(u.why.length > 4, `${u.upstreamKey} 缺理由`);
});

test('#621 选项校验：未知 id / 空数组 / 目录无书架 都抛错（且不静默变成默认值）', () => {
  assert.throws(() => normalizeBackupOptions(['bookshlf']), /未知的备份内容：bookshlf/);
  assert.throws(() => normalizeBackupOptions([]), /至少要勾选一项/);
  assert.throws(() => normalizeBackupOptions(['chapters']), /必须同时勾「书架与分组」/);
  // 对照：合法组合能过，且 chapters+bookshelf 一起是允许的
  assert.deepEqual([...normalizeBackupOptions(['bookshelf', 'chapters'])].sort(), ['bookshelf', 'chapters']);
  // 全不传 ⇒ 默认值（不是空集合）
  assert.equal(normalizeBackupOptions(undefined).size, 5);
});

/* ── 勾选项真的影响产物 ─────────────────────────────────────────── */

test('#621 只勾「书签与标注」⇒ 快照里没有 books（勾选项不是摆设）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  await store.upsertBookmark({ bookName: '甲', bookAuthor: '乙', chapterIndex: 0, chapterPos: 0, chapterName: '第一章', bookText: '', content: '', time: 1_790_000_000_001 } as never);

  const r = await buildBackup(store, ['annotations'], { now: NOW });
  assert.deepEqual(r.included, ['annotations']);
  const texts = entriesOf(r.zip);
  const snap = JSON.parse(texts.get(SNAPSHOT_ENTRY)!) as BackupSnapshot;
  assert.equal(snap.books, undefined, '没勾书架就不该有 books');
  assert.equal(snap.bookmarks?.length, 1);
  assert.equal(snap.prefs, undefined);

  // 对照：默认勾选时 books 一定在
  const def = await buildBackup(store, undefined, { now: NOW });
  const defSnap = JSON.parse(entriesOf(def.zip).get(SNAPSHOT_ENTRY)!) as BackupSnapshot;
  assert.equal(defSnap.books?.length, 1);
  assert.equal(defSnap.bookmarks?.length, 1);
});

test('#621 条目清单与 zip 实际条目一致（entries 报告不是编的）', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  const r = await buildBackup(store, ['bookshelf'], { now: NOW });
  const actual = listZipEntries(r.zip).map((e) => e.name);
  assert.deepEqual(actual, r.entries.map((e) => e.name));
  assert.equal(r.entries.every((e) => e.encrypted === false), true, '主快照是明文');
});

/* ── 敏感项 + AES ───────────────────────────────────────────────── */

const COOKIES = { 'src-1': 'sid=abc; cf_clearance=xyz' };

test('#621 勾了 Cookie 却没口令 ⇒ 抛错（对齐上游文案），且**没有产物**', async () => {
  const store = await memStore();
  await assert.rejects(
    () => buildBackup(store, ['bookshelf', 'cookies'], { now: NOW, cookies: () => COOKIES }),
    (e: unknown) => e instanceof BackupOptionError && e.code === 'PASSWORD_REQUIRED_COOKIES',
  );
  // 对照：给了口令就能备
  const ok = await buildBackup(store, ['bookshelf', 'cookies'], {
    now: NOW,
    password: 'p@ss',
    cookies: () => COOKIES,
  });
  assert.ok(entriesOf(ok.zip).has(COOKIE_ENTRY));
});

test('#621 Cookie 条目是密文（不含明文），且能与上游 AES 参数互通解回', async () => {
  const store = await memStore();
  const r = await buildBackup(store, ['bookshelf', 'cookies'], {
    now: NOW,
    password: 'p@ss',
    cookies: () => COOKIES,
  });
  const text = entriesOf(r.zip).get(COOKIE_ENTRY)!;
  assert.ok(!text.includes('cf_clearance'), '密文里不该出现明文 token');
  assert.ok(!text.trim().startsWith('{'), '不该是明文 JSON');
  // 用上游同参数解密（`backup-aes` 已与 openssl 逐字节对齐）⇒ 还原
  assert.deepEqual(JSON.parse(decryptBackupText(text, 'p@ss')), COOKIES);
  // 条目报告要标明它是加密的
  assert.equal(r.entries.find((e) => e.name === COOKIE_ENTRY)?.encrypted, true);
});

test('#621 源变量同理（敏感项两条路都要通，别只做 cookie）', async () => {
  const store = await memStore();
  await assert.rejects(
    () => buildBackup(store, ['bookshelf', 'sourceVariables'], { now: NOW, sourceVariables: () => ({ s: '{"a":1}' }) }),
    (e: unknown) => e instanceof BackupOptionError && e.code === 'PASSWORD_REQUIRED_SOURCE_VARS',
  );
  const r = await buildBackup(store, ['bookshelf', 'sourceVariables'], {
    now: NOW,
    password: 'k',
    sourceVariables: () => ({ s: '{"a":1}' }),
  });
  assert.deepEqual(JSON.parse(decryptBackupText(entriesOf(r.zip).get(SOURCE_VAR_ENTRY)!, 'k')), { s: '{"a":1}' });
});

test('#621 勾了敏感项但本机没数据 ⇒ 跳过并在 skippedSensitive 里说明（不静默）', async () => {
  const store = await memStore();
  const r = await buildBackup(store, ['bookshelf', 'cookies'], { now: NOW, password: 'p', cookies: () => ({}) });
  assert.equal(entriesOf(r.zip).has(COOKIE_ENTRY), false);
  assert.deepEqual(r.skippedSensitive.map((s) => s.id), ['cookies']);
  assert.match(r.skippedSensitive[0]!.why, /没有已保存的 Cookie/);
});

/* ── 读取 / 兼容 ────────────────────────────────────────────────── */

test('#621 读取：口令错 ⇒ BAD_PASSWORD（绝不返回空对象，否则等于清空登录态）', async () => {
  const store = await memStore();
  const r = await buildBackup(store, ['bookshelf', 'cookies'], {
    now: NOW,
    password: 'right',
    cookies: () => COOKIES,
  });
  assert.throws(
    () => readBackupArchive(r.zip, 'wrong'),
    (e: unknown) => e instanceof BackupOptionError && e.code === 'BAD_PASSWORD',
  );
  // 对照：口令对 ⇒ 解回原值
  assert.deepEqual(readBackupArchive(r.zip, 'right').cookies, COOKIES);
  // 有密文但完全没给口令 ⇒ 明确说「需要口令」，不当作没有
  assert.throws(
    () => readBackupArchive(r.zip),
    (e: unknown) => e instanceof BackupOptionError && e.code === 'PASSWORD_REQUIRED',
  );
});

test('#621 旧备份（无 included，`#208` ④ 产出）仍可读，included 按快照字段推断', async () => {
  const store = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  // 手搓一份「旧格式」快照（没有 included 字段）打进 zip
  const { createZip } = await import('@yuedu/facade');
  const legacySnap = {
    version: 1,
    exportedAt: NOW,
    books: [book({ bookUrl: 'a', name: '甲', author: '乙' })],
    bookmarks: [],
    highlights: [],
    replaceRules: [],
    highlightRules: [],
    bookGroups: [],
    readRecords: [],
    prefs: {},
  };
  const zip = createZip([{ name: SNAPSHOT_ENTRY, data: new TextEncoder().encode(JSON.stringify(legacySnap)) }], {
    mtime: new Date(NOW),
  });
  const r = readBackupArchive(zip);
  assert.equal(r.legacy, true);
  assert.ok(r.included.includes('bookshelf'));
  assert.ok(r.included.includes('annotations'));
  assert.ok(r.included.includes('settings'));
  assert.equal(r.included.includes('chapters'), false, '没有 chapters 字段就不该推断成带了目录');
  // 对照：新备份 legacy = false
  const fresh = await buildBackup(store, ['bookshelf'], { now: NOW });
  assert.equal(readBackupArchive(fresh.zip).legacy, false);
});

test('#621 不是备份的 zip / 没有快照条目 ⇒ 明确报错（含「手机端格式不同」的提示）', async () => {
  const { createZip } = await import('@yuedu/facade');
  const zip = createZip([{ name: 'other.json', data: new TextEncoder().encode('{}') }]);
  assert.throws(
    () => readBackupArchive(zip),
    (e: unknown) => e instanceof BackupOptionError && e.code === 'NO_SNAPSHOT',
  );
  assert.throws(() => readBackupArchive(new Uint8Array([1, 2, 3])), /不是一份有效的备份 zip/);
});

test('#621 filterSnapshotByIncluded：声明之外的字段一律丢掉（防手改备份串改数据）', () => {
  const snap = {
    version: 1,
    exportedAt: NOW,
    included: ['annotations'],
    books: [book({ bookUrl: 'a' })],
    bookmarks: [{ time: 1 }],
    prefs: { fontSize: 99 },
  } as unknown as BackupSnapshot;
  const out = filterSnapshotByIncluded(snap, ['annotations']);
  assert.equal(out.books, undefined);
  assert.equal(out.prefs, undefined);
  assert.deepEqual(out.bookmarks, [{ time: 1 }]);
});

/* ── 端到端：备份 → 恢复，且**未勾选的实体不受影响** ───────────── */

test('#621 端到端：只备份书签的恢复不会动书架（included 的核心价值）', async () => {
  const src = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 3 })]);
  await src.upsertBookmark({ bookName: '甲', bookAuthor: '乙', chapterIndex: 0, chapterPos: 0, chapterName: '第一章', bookText: '', content: '', time: 1_790_000_000_001 } as never);
  const r = await buildBackup(src, ['annotations'], { now: NOW });

  // 目标库：一本书（进度不同）+ 一条自己的书签
  const dst = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙', durChapterIndex: 9 })]);
  const read = readBackupArchive(r.zip);
  const payload = filterSnapshotByIncluded(read.snapshot, read.included);
  assert.equal('books' in payload, false, '这份备份声明里没有书架');
  await importSnapshot(dst, payload as never, { overwrite: true });

  const bk = await dst.getBook('a');
  assert.equal(bk?.durChapterIndex, 9, '未勾选书架 ⇒ 进度不能被旧备份改回去');
  assert.equal((await dst.listBookmarks()).length, 1, '书签被恢复进来');
});

test('#621 端到端：勾了书架 + 目录的恢复能把书与目录带过去', async () => {
  const src = await memStore([book({ bookUrl: 'a', name: '甲', author: '乙' })]);
  await src.replaceChapters('a', [
    { bookUrl: 'a', url: 'a/1', name: '第一章', index: 0 } as never,
    { bookUrl: 'a', url: 'a/2', name: '第二章', index: 1 } as never,
  ]);
  const r = await buildBackup(src, ['bookshelf', 'chapters'], { now: NOW });
  const dst = await memStore();
  const read = readBackupArchive(r.zip);
  await importSnapshot(dst, filterSnapshotByIncluded(read.snapshot, read.included) as never, { overwrite: true });
  assert.equal((await dst.countBooks()), 1);
  assert.equal((await dst.listChapters('a')).length, 2);
});
