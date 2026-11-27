/**
 * `#210` 定时更新书架 + 崩溃日志——**纯逻辑**单测。
 *
 * 覆盖的都是「改坏了会静默出事故」的分支：
 * - 配置归一（文件被手改坏 ⇒ 回落默认值，不能让调度器起不来）；
 * - 可更新过滤（本地书 / 未收藏行 / 手动关更新混进去 = 打无效请求）；
 * - 目录对比（Legado 语义：新增 = 新长 - 旧长，负数归 0；卷名不算「最新章」）；
 * - ShelfUpdater 整轮（依赖注入假 store/hub，不动真网络）；
 * - 崩溃 ring（环形上限；**recordCrash 绝不能抛**）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShelfBook, UnifiedDetail } from '@yuedu/core';
import { BookType } from '@yuedu/core';
import {
  DEFAULT_UPDATE_CONFIG,
  ShelfUpdater,
  detailIdFromBookUrl,
  diffToc,
  isUpdatableBook,
  normalizeConfig,
} from '../shelf-updater';
import { listCrashLogs, recordCrash, recentCrashes } from '../crash-log';

/* ---------------- 配置归一 ---------------- */

test('normalizeConfig：空文件/非对象 ⇒ 全默认', () => {
  assert.deepEqual(normalizeConfig(undefined).config, DEFAULT_UPDATE_CONFIG);
  assert.deepEqual(normalizeConfig('garbage').config, DEFAULT_UPDATE_CONFIG);
  assert.deepEqual(normalizeConfig(null).config, DEFAULT_UPDATE_CONFIG);
});

test('normalizeConfig：intervalMin 越界钳制到 [5,1440]，非数字回落', () => {
  assert.equal(normalizeConfig({ intervalMin: 1 }).config.intervalMin, 5);
  assert.equal(normalizeConfig({ intervalMin: 99999 }).config.intervalMin, 1440);
  assert.equal(normalizeConfig({ intervalMin: 17.6 }).config.intervalMin, 18);
  const r = normalizeConfig({ intervalMin: 'abc', enabled: 'yes' });
  assert.deepEqual(r.config, DEFAULT_UPDATE_CONFIG);
  assert.equal(r.warnings.length, 2, '两处脏值都要告警（不静默）');
});

test('normalizeConfig：合法值原样通过', () => {
  const r = normalizeConfig({ enabled: false, intervalMin: 30 });
  assert.deepEqual(r.config, { enabled: false, intervalMin: 30 });
  assert.equal(r.warnings.length, 0);
});

/* ---------------- 可更新过滤 ---------------- */

function book(p: Partial<ShelfBook>): ShelfBook {
  return {
    bookUrl: 'https://x/b/1',
    origin: 'https://src.example',
    originName: '某源',
    name: '书一',
    type: BookType.text,
    canUpdate: true,
    totalChapterNum: 10,
    ...p,
  } as ShelfBook;
}

test('isUpdatableBook：本地书/未收藏/关更新/缺源都不查', () => {
  assert.equal(isUpdatableBook(book({})), true);
  assert.equal(isUpdatableBook(book({ origin: 'loc_book' })), false, '本地书');
  assert.equal(isUpdatableBook(book({ canUpdate: false })), false, '用户关了更新');
  assert.equal(isUpdatableBook(book({ type: BookType.text | BookType.notShelf })), false, '观影历史行');
  assert.equal(isUpdatableBook(book({ type: BookType.local | BookType.text })), false, 'local 位双保险');
  assert.equal(isUpdatableBook(book({ origin: '' })), false, '没有源没法查');
  assert.equal(isUpdatableBook(book({ bookUrl: '' })), false, '没有主键没法查');
});

/* ---------------- 目录对比 ---------------- */

test('diffToc：Legado 语义——新增 = 新长-旧长，负数归 0；卷名不算最新章', () => {
  assert.deepEqual(diffToc(10, [{ title: 'a', payload: 1 }, { title: 'b', payload: 2 }, { title: 'c', payload: 3 }]), {
    added: 0,
    total: 3,
    latestTitle: 'c',
  });
  assert.deepEqual(diffToc(1, [{ title: 'a', payload: 1 }, { title: 'b', payload: 2 }]), {
    added: 1,
    total: 2,
    latestTitle: 'b',
  });
  // 目录变小（源抽风/换源重排）：不显示负数
  assert.equal(diffToc(99, [{ title: 'a', payload: 1 }]).added, 0);
  // 全是卷名 ⇒ 最新章为 null
  assert.equal(diffToc(0, [{ title: '卷一', payload: 1, isVolume: true }]).latestTitle, null);
});

/* ---------------- detailIdFromBookUrl（#302） ---------------- */

test('detailIdFromBookUrl：encodeItemKey 主键还原出引擎 id（%25→% 先转义、%00→NUL 后反转）', () => {
  const NUL = String.fromCharCode(0);
  // maccms 影视行：主键 = sourceId + NUL + payload JSON（源 API 本身带下划线形态，含字面 % 的要原样保住）
  const maccms = `https___www.hongniuzy2.com_api.php_provide_vod_at_josn_%00{"vod_id":"194493"}`;
  assert.equal(detailIdFromBookUrl(maccms), '{"vod_id":"194493"}');
  // legado 书行：主键含字面 %（bookUrl 里有 %XX），必须先 %00 还原再 %25 还原（顺序反了会把 %00 假还原）
  const legado = `s1%00https://x/a%2520b`;
  assert.equal(detailIdFromBookUrl(legado), `https://x/a%20b`);
  // 历史裸 URL 行（没有 NUL 分隔符）原样返回
  assert.equal(detailIdFromBookUrl('https://src.example/book/1'), 'https://src.example/book/1');
  // 双向可逆自查：encode(decode(encode(k))) 形态不漂移
  const raw = `src${NUL}https://x/a%b`;
  const enc = raw.split('%').join('%25').split(NUL).join('%00');
  assert.equal(detailIdFromBookUrl(enc), 'https://x/a%b');
});

/* ---------------- 整轮（依赖注入） ---------------- */

function makeDeps(books: ShelfBook[], detailOf: (b: ShelfBook) => UnifiedDetail, opts?: { failSave?: boolean }) {
  const saved: (Partial<ShelfBook> & { bookUrl: string })[] = [];
  const crashes: string[] = [];
  const deps = {
    dataDir: mkdtempSync(join(tmpdir(), 'yuedu210-')),
    listBooks: async () => books,
    saveBook: async (b: Partial<ShelfBook> & { bookUrl: string }) => {
      if (opts?.failSave) throw new Error('disk on fire');
      saved.push(b);
    },
    fetchDetail: async (sourceId: string, bookUrl: string) => {
      const b = books.find((x) => x.bookUrl === bookUrl);
      assert.ok(b, 'fetchDetail 必须拿书行里的 origin/bookUrl 调用');
      assert.equal(sourceId, b.origin);
      return detailOf(b);
    },
    recordCrash: (m: string) => crashes.push(m),
    gapMs: 0,
  };
  return { deps, saved, crashes };
}

const detail = (n: number, extra: Partial<UnifiedDetail> = {}): UnifiedDetail =>
  ({
    id: 'x',
    kind: 'book',
    title: 't',
    chapters: Array.from({ length: n }, (_, i) => ({ title: `第${i + 1}章`, payload: i })),
    ...extra,
  }) as UnifiedDetail;

test('ShelfUpdater：有新增 ⇒ 书行记 added/total/latest，成功清 updateError 位', async () => {
  const books = [book({ totalChapterNum: 10, type: BookType.text | BookType.updateError })];
  const { deps, saved } = makeDeps(books, (b) => detail(b.totalChapterNum + 3));
  const u = new ShelfUpdater(deps);
  assert.equal(await u.runPass('manual'), true);
  const s = u.status();
  assert.equal(s.running, false);
  assert.equal(s.results[0]!.added, 3);
  assert.equal(s.updatedNames.length, 1);
  const patch = saved.find((x) => x.bookUrl === books[0]!.bookUrl)!;
  assert.equal(patch.totalChapterNum, 13);
  assert.equal(patch.lastCheckCount, 3);
  assert.equal(patch.latestChapterTitle, '第13章');
  assert.equal(patch.type, BookType.text, '失败位被清掉');
});

test('ShelfUpdater：目录没取到 ⇒ fail + 打 updateError 位 + 原因留痕（不静默）', async () => {
  const books = [book({})];
  const { deps, saved } = makeDeps(books, () => detail(0, { tocError: 'TOC@parse' }));
  const u = new ShelfUpdater(deps);
  await u.runPass('manual');
  assert.equal(u.status().results[0]!.status, 'fail');
  assert.match(u.status().results[0]!.error!, /TOC@parse/);
  assert.equal(saved[0]!.type, BookType.text | BookType.updateError, '失败位被置上');
});

test('ShelfUpdater：拉请求抛错 ⇒ 该本 fail、整轮继续（一本烂源不拖死书架）', async () => {
  const books = [book({ name: '烂源书', bookUrl: 'https://x/b/bad' }), book({ name: '好书', bookUrl: 'https://x/b/good' })];
  const deps = {
    ...makeDeps(books, () => detail(1)).deps,
    fetchDetail: async (_s: string, bookUrl: string) => {
      if (bookUrl.endsWith('bad')) throw new Error('DNS fail');
      return detail(5);
    },
  };
  const u = new ShelfUpdater(deps);
  await u.runPass('manual');
  const st = u.status();
  assert.equal(st.results.length, 2);
  assert.equal(st.results.find((r) => r.name === '烂源书')?.status, 'fail');
  assert.equal(st.results.find((r) => r.name === '好书')?.status, 'ok');
  assert.match(st.lastError!, /1\/2 本失败/);
});

test('ShelfUpdater：整轮全挂 ⇒ 升级崩溃留痕', async () => {
  const books = [book({}), book({ bookUrl: 'https://x/b/2' })];
  const { deps, crashes } = makeDeps(books, () => detail(0, { tocError: 'dead' }));
  const u = new ShelfUpdater(deps);
  await u.runPass('manual');
  assert.equal(crashes.length, 1, '全部失败必须 recordCrash');
  assert.match(u.status().lastError!, /全部失败/);
});

test('ShelfUpdater：并发自锁——一轮在跑时再触发返回 false', async () => {
  const books = [book({})];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const deps = {
    ...makeDeps(books, () => detail(1)).deps,
    fetchDetail: async () => {
      await gate;
      return detail(1);
    },
  };
  const u = new ShelfUpdater(deps);
  const p1 = u.runPass('manual');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await u.runPass('manual'), false, '第二轮必须被拒');
  assert.equal(u.status().running, true, '状态要如实显示在跑');
  release();
  await p1;
  assert.equal(u.status().running, false);
});

test('ShelfUpdater：setConfig 落盘 + 重读一致（坏文件回落默认）', async () => {
  const { deps } = makeDeps([], () => detail(0));
  const u = new ShelfUpdater(deps);
  const r = u.setConfig({ enabled: false, intervalMin: 15 });
  assert.deepEqual(r.config, { enabled: false, intervalMin: 15 });
  const file = join(deps.dataDir, 'shelf-update.json');
  assert.equal(existsSync(file), true, '配置必须立刻落盘（#238：不赌防抖）');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).intervalMin, 15);
  // 手改坏再读 ⇒ 默认值 + 告警
  writeFileSync(file, '{broken');
  const r2 = u.loadConfig();
  assert.deepEqual(r2.config, DEFAULT_UPDATE_CONFIG);
});

/* ---------------- 崩溃 ring / 文件 ---------------- */

test('recordCrash：ring 上限 50、返回条目、绝不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu210c-'));
  for (let i = 0; i < 55; i++) recordCrash('record', new Error(`e${i}`), dir);
  const all = recentCrashes(50);
  assert.equal(all.length, 50);
  assert.match(all[all.length - 1]!.message, /e54/, '最新一条在尾部');
  assert.match(all[0]!.message, /e5/, '最老的 5 条被挤出环形');
  assert.ok(existsSync(join(dir, `crash-${new Date().getFullYear()}-` + String(new Date().getMonth() + 1).padStart(2, '0') + '.log')));
  // 非对象/undefined 也不能抛
  assert.doesNotThrow(() => recordCrash('record', undefined, dir));
  assert.doesNotThrow(() => recordCrash('record', '纯文本错误', undefined));
});

test('listCrashLogs：只列 crash-*.log，按名倒序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu210l-'));
  writeFileSync(join(dir, 'crash-2026-10.log'), 'x');
  writeFileSync(join(dir, 'crash-2026-09.log'), 'y');
  writeFileSync(join(dir, 'other.txt'), 'z');
  const files = listCrashLogs(dir);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.name, 'crash-2026-10.log');
});
