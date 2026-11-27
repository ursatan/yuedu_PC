/**
 * 用户数据存储回归测试（Phase 1.2）
 *
 * ## 为什么用「同一套断言跑两个实现」
 * SQLite 是主实现、JSON 是回落实现。两者必须**语义一致**（D1/D2/D3 决策、级联删除、TTL 语义），
 * 否则「没有 SQLite 的机器」上用户会遇到完全不同的行为。
 * 因此断言写在 `conformance(store, opts)` 里，两个实现各跑一遍。
 *
 * ## 最不能省的几条断言
 * 1. **刷新书籍信息不得清空目录**（`INSERT OR REPLACE` + `ON DELETE CASCADE` 的经典陷阱）
 * 2. **D1**：同名同作者只留一条，被顶掉那本的目录**一并消失**
 * 3. **删书连带删目录**（SQLite 靠外键、JSON 实现靠手写等价物）
 * 4. **批量写入分批让出事件循环**（`DatabaseSync` 是同步 API，否则会假死）
 */
import test from 'node:test';
import { fileNameFromLocalBookUrl, normalizeLocalBookOriginName } from '../local-book';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BookType,
  emptyBookReadConfig,
  emptyShelfBook,
  emptyShelfChapter,
  type ShelfBook,
  type ShelfChapter,
} from '../contract/user-data';
import {
  createJsonUserStore,
  createSqliteUserStore,
  hasSqliteSupport,
  openUserStore,
  UserStoreOpenError,
  USER_STORE_SCHEMA_VERSION,
  type UserDataStore,
} from '../user-store';

/** 建临时数据目录（放系统 temp，避免污染仓库） */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuedu-userstore-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 上 SQLite 文件偶尔仍被占用 → 忽略，temp 会被系统回收 */
  }
}

const T0 = 1_700_000_000_000;

/** 造一本可控的书 */
function makeBook(over: Partial<ShelfBook> = {}): ShelfBook {
  return {
    ...emptyShelfBook(T0),
    bookUrl: 'https://src.test/book/1',
    origin: 'https://src.test',
    originName: '测试源',
    name: '测试书',
    author: '测试作者',
    kind: '玄幻',
    coverUrl: 'https://src.test/c.jpg',
    intro: '简介',
    type: BookType.text,
    totalChapterNum: 3,
    ...over,
  };
}

function makeChapters(bookUrl: string, n: number): ShelfChapter[] {
  return Array.from({ length: n }, (_, i) => ({
    ...emptyShelfChapter(bookUrl, i),
    url: `${bookUrl}#ch${i}`,
    title: `第${i + 1}章`,
    bookUrl,
    index: i,
    baseUrl: bookUrl,
  }));
}

interface ConformanceOpts {
  /** 该实现的批量写入是否会真正让出事件循环（sqlite=true / json=false） */
  expectYields: boolean;
}

/** 断言跑完后的最终计数（交给调用方做"重开后仍在"的校验） */
interface FinalCounts {
  books: number;
  chaptersOfFirstBook: number;
}

/* ------------------------------------------------------------------ *
 * 共用断言
 * ------------------------------------------------------------------ */

async function conformance(store: UserDataStore, opts: ConformanceOpts): Promise<FinalCounts> {
  /* ---- 书架基本读写：34 个字段要能原样往返 ---- */
  const book = makeBook({
    readConfig: { ...emptyBookReadConfig(), imageStyle: 'FULL', dailyChapters: 5 },
    variable: JSON.stringify({ a: 1 }),
    wordCount: '12万字',
    canUpdate: false,
    group: 1,
    order: 7,
    // `#141`：影视进度（秒）也是契约字段，两个实现都必须原样往返
    progressSec: 95.5,
    durationSec: 2400,
  });
  await store.upsertBook(book);
  const got = await store.getBook(book.bookUrl);
  assert.ok(got, '写入后应能读回');
  assert.deepEqual(got, book, '36 个字段（含 null、位掩码、JSON 列、影视进度）必须原样往返');
  assert.equal(await store.countBooks(), 1);

  /* ---- ⚠️ 关键：同一本书再写一次（模拟"刷新书籍信息"）不得清空目录 ---- */
  const toc3 = await store.replaceChapters(book.bookUrl, makeChapters(book.bookUrl, 3));
  assert.equal(toc3.written, 3);
  assert.equal(await store.countChapters(book.bookUrl), 3, '目录应写入 3 章');
  await store.upsertBook({ ...book, latestChapterTitle: '第3章', latestChapterTime: T0 + 1 });
  assert.equal(
    await store.countChapters(book.bookUrl),
    3,
    '刷新书籍信息后目录必须还在（INSERT OR REPLACE 会触发 ON DELETE CASCADE 清空目录）',
  );
  assert.equal((await store.getBook(book.bookUrl))?.latestChapterTitle, '第3章', '更新字段应生效');

  /* ---- 目录字段往返 + 顺序 ---- */
  const chapters = await store.listChapters(book.bookUrl);
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0]!.title, '第1章');
  assert.equal(chapters[0]!.url, `${book.bookUrl}#ch0`);
  assert.equal(chapters[0]!.isVolume, false);
  assert.equal(chapters[2]!.index, 2, '按 index 升序');
  assert.equal(chapters[0]!.resourceUrl, null, '可空字段的 null 要保留');
  assert.equal(chapters[0]!.start, null);

  /* ---- 阅读进度：轻量更新只动 6 个字段 ---- */
  assert.equal(
    await store.saveProgress(book.bookUrl, {
      durChapterIndex: 2,
      durChapterPos: 128,
      durChapterTime: T0 + 1000,
      durChapterTitle: '第3章',
    }),
    true,
  );
  const afterProgress = (await store.getBook(book.bookUrl))!;
  assert.equal(afterProgress.durChapterIndex, 2);
  assert.equal(afterProgress.durChapterPos, 128);
  assert.equal(afterProgress.durChapterTitle, '第3章');
  assert.equal(afterProgress.name, '测试书', '进度更新不得影响其它字段');
  assert.equal(afterProgress.latestChapterTitle, '第3章', '进度更新不得影响 latestChapterTitle');
  assert.equal(afterProgress.readConfig?.imageStyle, 'FULL', '进度更新不得影响 readConfig');
  assert.equal(await store.saveProgress('https://nope.test/x', { durChapterIndex: 1, durChapterPos: 0 }), false);

  /* ---- D1：同名同作者只留一条，被顶掉那本的目录一并消失 ---- */
  // 先造一本**不同书名**的，能共存，并给它目录
  const other = makeBook({ bookUrl: 'https://src2.test/book/9', origin: 'https://src2.test', name: '另一本', author: '另作者' });
  await store.upsertBook(other);
  await store.replaceChapters(other.bookUrl, makeChapters(other.bookUrl, 5));
  assert.equal(await store.countBooks(), 2, '不同书名应能共存');
  assert.equal(await store.countChapters(other.bookUrl), 5);

  // 再写入第三本，书名/作者与 other 相同 → 应顶掉 other（含其 5 章目录）
  const otherDup = makeBook({ bookUrl: 'https://src2.test/book/99', origin: 'https://src2.test', name: '另一本', author: '另作者' });
  await store.upsertBook(otherDup);
  assert.equal(await store.countBooks(), 2, 'D1：同名同作者只留一条');
  assert.equal(await store.getBook(other.bookUrl), null, '被顶掉的那本应查不到');
  assert.equal(await store.countChapters(other.bookUrl), 0, '被顶掉那本的目录应级联删除');
  assert.ok(await store.getBook(otherDup.bookUrl), '新那本应存在');
  assert.equal(await store.countChapters(otherDup.bookUrl), 0, '新那本不应继承旧目录');

  /* ---- D1 例外：书名与作者都为空时不应互相顶掉 ---- */
  const empty1 = makeBook({ bookUrl: 'https://e.test/1', name: '', author: '' });
  const empty2 = makeBook({ bookUrl: 'https://e.test/2', name: '', author: '' });
  await store.upsertBook(empty1);
  await store.upsertBook(empty2);
  assert.ok(await store.getBook(empty1.bookUrl), '空书名占位行不应被另一行顶掉');
  assert.ok(await store.getBook(empty2.bookUrl));
  assert.equal(await store.countBooks(), 4);

  /* ---- 删书连带删目录 ---- */
  assert.equal(await store.deleteBook(otherDup.bookUrl), true);
  assert.equal(await store.countBooks(), 3);
  assert.equal(await store.deleteBook(otherDup.bookUrl), false, '重复删应返回 false');

  /* ---- 删除墓碑：跨端一致删除（用户 2026-11-08） ----
   * 「服务端没有这条」无法区分「没推过」与「被删了」⇒ 删除必须留下带时间戳的墓碑，
   * 另一端的陈旧副本（durChapterTime < deletedAt）再 PUT 上来时要被**拒绝**，否则已删的书/历史会复活。 */
  const tombUrl = 'https://tomb.test/book/1';
  const delAt = T0 + 10_000;
  await store.upsertBook(makeBook({ bookUrl: tombUrl, name: '墓碑书', author: '墓碑作者', durChapterTime: T0 }));
  assert.equal(await store.deleteBook(tombUrl, delAt), true);
  assert.equal(await store.getBook(tombUrl), null);
  const tombAfterDelete = await store.listBookTombstones();
  assert.equal(
    tombAfterDelete.find((t) => t.bookUrl === tombUrl)?.deletedAt,
    delAt,
    '删除必须留下带删除时刻的墓碑',
  );
  assert.equal(
    (await store.listBookTombstones(delAt)).some((t) => t.bookUrl === tombUrl),
    false,
    'since 过滤：大于该时刻的墓碑才返回（删除时刻本身算「已包含」）',
  );
  // 陈旧副本复活写入 ⇒ 拒绝
  await store.upsertBook(makeBook({ bookUrl: tombUrl, name: '墓碑书', author: '墓碑作者', durChapterTime: T0 + 5_000 }));
  assert.equal(await store.getBook(tombUrl), null, 'durChapterTime < deletedAt 的 upsert 必须被墓碑拒绝');
  assert.ok(
    (await store.listBookTombstones()).some((t) => t.bookUrl === tombUrl),
    '被拒绝的写入不得把墓碑清掉（否则下一次又能复活）',
  );
  // 用户确实在删除之后重新加入/重新播放 ⇒ 允许并清墓碑
  await store.upsertBook(makeBook({ bookUrl: tombUrl, name: '墓碑书', author: '墓碑作者', durChapterTime: T0 + 20_000 }));
  assert.ok(await store.getBook(tombUrl), '比墓碑更新的写入应被接受（重新加入书架/重新起播）');
  assert.equal(
    (await store.listBookTombstones()).some((t) => t.bookUrl === tombUrl),
    false,
    '较新的写入应清掉墓碑',
  );
  // 复位：这行不能留在 books 里（文件后半段有「全部书的排序」断言）
  await store.deleteBook(tombUrl);

  /* ---- D3：group / type 是位掩码筛选 ---- */
  await store.upsertBook(makeBook({ bookUrl: 'https://v.test/1', name: '影片', author: 'A', type: BookType.video, group: 0b100 }));
  await store.upsertBook(makeBook({ bookUrl: 'https://v.test/2', name: '影片2', author: 'B', type: BookType.video | BookType.audio, group: 0b1000 }));
  assert.equal((await store.listBooks({ type: BookType.video })).length, 2, 'type 位掩码：两本都含 video 位');
  assert.equal((await store.listBooks({ type: BookType.audio })).length, 1, '只有第二本含 audio 位');
  assert.equal((await store.listBooks({ type: BookType.image })).length, 0);
  assert.equal((await store.listBooks({ group: 0b100 })).length, 1, 'group 位掩码筛选');
  assert.equal((await store.listBooks({ search: '影片2' })).length, 1, '名称模糊搜索');
  assert.equal((await store.listBooks({ search: '影片' })).length, 2);
  assert.equal((await store.listBooks({ search: 'B' })).length, 1, '作者模糊搜索');

  /* ---- 排序 / 分页 ---- */
  // ⚠️ 两实现的字符串排序必须是**同一种 collation**：SQLite 默认 BINARY = UTF-16 码元序，
  //    所以这里断言的是**精确顺序**而不是"看起来有序"（用 localeCompare 断言会把拼音序误当标准，
  //    掩盖两个实现行为不一致的问题）。
  assert.deepEqual(
    (await store.listBooks({ sort: 'name' })).map((b) => b.name),
    ['', '', '影片', '影片2', '测试书'],
    'name 排序按码元序（BINARY），两个实现必须一致',
  );
  assert.equal((await store.listBooks({ sort: 'manual' })).length, 5, 'manual 排序不应丢行');
  assert.deepEqual(
    (await store.listBooks({ sort: 'updateTime' })).map((b) => b.lastCheckTime),
    [...(await store.listBooks({ sort: 'updateTime' })).map((b) => b.lastCheckTime)].sort((a, b) => b - a),
    'updateTime 应倒序',
  );
  assert.equal((await store.listBooks({ limit: 1 })).length, 1, 'limit 生效');
  assert.equal((await store.listBooks({ limit: 2, offset: 1 })).length, 2, 'offset 生效');
  assert.equal((await store.listBooks({ limit: 2, offset: 100 })).length, 0, '越界应返回空');

  /* ---- 书签 ---- */
  await store.upsertBookmark({
    time: 1000, bookName: '测试书', bookAuthor: '测试作者', chapterIndex: 1,
    chapterPos: 10, chapterName: '第2章', bookText: '正文', content: '备注',
  });
  await store.upsertBookmark({
    time: 2000, bookName: '测试书', bookAuthor: '测试作者', chapterIndex: 2,
    chapterPos: 20, chapterName: '第3章', bookText: '正文2', content: '',
  });
  const marks = await store.listBookmarks('测试书');
  assert.equal(marks.length, 2);
  assert.equal(marks[0]!.time, 2000, '按时间倒序');
  assert.deepEqual(marks[1], {
    time: 1000, bookName: '测试书', bookAuthor: '测试作者', chapterIndex: 1,
    chapterPos: 10, chapterName: '第2章', bookText: '正文', content: '备注',
  });
  assert.equal((await store.listBookmarks()).length, 2, '不传书名返回全部');
  assert.equal(await store.deleteBookmark(1000), true);
  assert.equal(await store.deleteBookmark(1000), false);
  assert.equal((await store.listBookmarks()).length, 1);

  /* ---- 高亮（含 layoutTitleLength 哨兵 -1） ---- */
  await store.upsertHighlight({
    time: 3000, bookUrl: book.bookUrl, chapterUrl: `${book.bookUrl}#ch1`, bookName: '测试书',
    bookAuthor: '测试作者', chapterIndex: 1, chapterPos: 5, chapterPosEnd: 15,
    layoutTitleLength: -1, chapterName: '第2章', bookText: '选中的文字', style: '{"bold":true}', note: '笔记',
  });
  const hl = await store.listHighlights(book.bookUrl);
  assert.equal(hl.length, 1);
  assert.equal(hl[0]!.layoutTitleLength, -1, '哨兵 -1 必须保留（不能变成 0）');
  assert.equal(hl[0]!.chapterPosEnd, 15);
  assert.equal(hl[0]!.style, '{"bold":true}');
  assert.equal(await store.deleteHighlight(3000), true);

  /* ---- 净化规则 ---- */
  await store.upsertReplaceRule({
    id: 1, name: '去广告', group: null, pattern: '广告.*', replacement: '',
    scope: null, scopeTitle: false, scopeSource: false, scopeContent: true,
    excludeScope: null, isEnabled: true, isRegex: true, timeoutMillisecond: 3000, order: -2147483648,
  });
  const rules = await store.listReplaceRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.order, -2147483648, 'Int.MIN_VALUE 必须完整保留（不能截断）');
  assert.equal(rules[0]!.group, null);
  assert.equal(rules[0]!.scopeContent, true, '默认值 true 要能往返');
  assert.equal(await store.deleteReplaceRule(1), true);

  /* ---- 字典规则（`#189`）：5 个字段原样往返，主键 = 字典名 ---- */
  await store.upsertDictRule({
    name: '汉典', urlRule: 'https://x/{{key}}', showRule: '$.a@text',
    enabled: true, sortNumber: 3,
  });
  await store.upsertDictRule({
    name: '海词中文', urlRule: '', showRule: '', enabled: false, sortNumber: 0,
  });
  const dicts = await store.listDictRules();
  assert.equal(dicts.length, 2, '字典规则两条都要在（主键不同）');
  // 按 sortNumber 升序 ⇒ 0 在前
  assert.equal(dicts[0]!.name, '海词中文');
  assert.equal(dicts[0]!.enabled, false, 'enabled=false 必须往返（不能默认 true）');
  assert.equal(dicts[1]!.urlRule, 'https://x/{{key}}');
  // 同名 upsert = 覆盖（不是新增两条）
  await store.upsertDictRule({ name: '汉典', urlRule: 'u2', showRule: 's2', enabled: false, sortNumber: 9 });
  const dicts2 = await store.listDictRules();
  assert.equal(dicts2.length, 2, '同名覆盖不得新增行');
  assert.equal(dicts2.find((d) => d.name === '汉典')?.urlRule, 'u2');
  assert.equal(await store.deleteDictRule('汉典'), true);
  assert.equal(await store.deleteDictRule('不存在'), false, '删不存在的返回 false');

  /* ---- 分组 ---- */
  await store.upsertBookGroup({
    groupId: 1, groupName: '我的分组', cover: null, order: 0,
    enableRefresh: true, show: true, bookSort: -1, onlyUpdateRead: false,
  });
  const groups = await store.listBookGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.bookSort, -1, 'bookSort=-1 表示跟随全局');
  assert.equal(groups[0]!.cover, null);
  assert.equal(await store.deleteBookGroup(1), true);

  /* ---- D2：阅读时长按书名聚合 + 多作者合并 ---- */
  await store.addReadTime('dev1', '测试书', 1000, '作者甲', T0 + 10_000);
  await store.addReadTime('dev1', '测试书', 500, '作者甲', T0 + 20_000);
  await store.addReadTime('dev1', '测试书', 200, '作者乙', T0 + 30_000);
  // 同名但不同设备 → 两条独立记录（主键含 deviceId）
  await store.addReadTime('dev2', '测试书', 7000, '作者丙', T0 + 40_000);
  const recs = await store.listReadRecords();
  assert.equal(recs.length, 2, 'D2：按 (deviceId, bookName) 聚合');
  const dev1 = recs.find((r) => r.deviceId === 'dev1')!;
  assert.equal(dev1.readTime, 1700, '同一设备同名书累加时长');
  assert.equal(dev1.lastRead, T0 + 30_000);
  const shows = await store.listReadRecordShows();
  assert.equal(shows.length, 1, '跨设备按书名合并为一条');
  assert.equal(shows[0]!.readTime, 8700, '跨设备时长求和');
  assert.equal(shows[0]!.lastRead, T0 + 40_000, '跨设备取最近');
  assert.equal(shows[0]!.author, '作者丙、作者乙、作者甲', '多作者去重排序后顿号连接');

  /* ---- KV 缓存：TTL 语义 ---- */
  await store.cacheSet('forever', 'v0');
  assert.equal(await store.cacheGet('forever', 9_999_999_999_999), 'v0', 'deadline=0 永不过期');
  await store.cacheSet('short', 'v1', 1000, 1_000_000);
  assert.equal(await store.cacheGet('short', 1_000_500), 'v1', '未过期应命中');
  assert.equal(await store.cacheGet('short', 1_002_000), null, '已过期应返回 null');
  assert.equal(await store.cacheGet('short', 1_002_000), null, '过期后条目应被删除');
  await store.cacheSet('json', '{"a":1}');
  assert.equal(await store.cacheGet('json'), '{"a":1}', 'JSON 字符串应原样存取');
  assert.equal(await store.cacheGet('missing'), null, '不存在的键返回 null');
  await store.cacheSet('typed', 'x', 5000, 1_000_000);
  assert.equal(await store.cacheSweep(1_000_100), 0, '未过期项不应被 sweep');
  assert.equal(await store.cacheGet('typed', 1_000_100), 'x');
  assert.equal(await store.cacheSweep(1_006_000), 1, 'sweep 应清掉过期项');
  assert.equal(await store.cacheGet('typed', 1_006_000), null);
  assert.equal(await store.cacheDelete('forever'), true);
  assert.equal(await store.cacheDelete('forever'), false);
  await store.cacheSet('p:a', '1');
  await store.cacheSet('p:b', '2');
  await store.cacheSet('q:c', '3');
  assert.equal((await store.cacheList('p:')).length, 2, 'prefix 过滤');

  /* ---- 全局偏好：合并式写入 ---- */
  const def = await store.getReaderPrefs();
  assert.equal(def.themeMode, '0', '未写过的偏好应返回契约默认值');
  assert.equal(await (await store.setReaderPrefs({ themeMode: '2', chineseConverterType: 1 })).themeMode, '2');
  const p2 = await store.setReaderPrefs({ autoReadSpeed: 20 });
  assert.equal(p2.themeMode, '2', '部分更新不得丢掉已设字段');
  assert.equal(p2.chineseConverterType, 1);
  assert.equal(p2.autoReadSpeed, 20);
  assert.equal(p2.replaceEnableDefault, true, '未触及的字段保持默认');

  /* ---- 批量写入：数量正确 + 分批让出事件循环 ---- */
  const baseCount = await store.countBooks();
  const bulk = Array.from({ length: 2500 }, (_, i) =>
    makeBook({ bookUrl: `https://bulk.test/${i}`, name: `批量书${i}`, author: `作者${i}` }),
  );
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 1);
  const res = await store.upsertBooks(bulk);
  clearInterval(timer);
  assert.equal(res.written, 2500);
  assert.equal(await store.countBooks(), baseCount + 2500);
  if (opts.expectYields) {
    assert.ok(res.yields > 0, `批量写入应分批让出事件循环（yields=${res.yields}）`);
    assert.ok(ticks > 0, `批量写入期间事件循环应仍能跑定时器（实际 ticks=${ticks}）`);
  } else {
    assert.equal(res.yields, 0, 'JSON 回落实现是同步内存写，不报告 yield');
  }

  /* ---- 目录批量替换：全量语义（旧的必须清掉） ---- */
  const bigToc = makeChapters(book.bookUrl, 1200);
  assert.equal((await store.replaceChapters(book.bookUrl, bigToc)).written, 1200);
  assert.equal(await store.countChapters(book.bookUrl), 1200);
  await store.replaceChapters(book.bookUrl, bigToc.slice(0, 10));
  assert.equal(await store.countChapters(book.bookUrl), 10, '全量替换应清掉旧章节');

  return { books: baseCount + 2500, chaptersOfFirstBook: 10 };
}

/* ------------------------------------------------------------------ *
 * 跑两个实现
 * ------------------------------------------------------------------ */

test('SQLite 实现：完整一致性断言 + 重开持久化', async () => {
  const dir = tempDir();
  try {
    const store = await createSqliteUserStore({ dir });
    assert.equal(store.kind, 'sqlite');
    const counts = await conformance(store, { expectYields: true });
    // 重开验证持久化（顺带验证 WAL/连接可正常关闭重开）
    await store.close();
    const again = await createSqliteUserStore({ dir });
    assert.equal(await again.countBooks(), counts.books, '重开后书架应还在');
    assert.equal(await again.countChapters('https://src.test/book/1'), counts.chaptersOfFirstBook, '重开后目录应还在');
    assert.equal((await again.getReaderPrefs()).themeMode, '2', '重开后偏好应还在');
    assert.equal(await again.cacheGet('p:a', 9_999_999_999_999), '1', '重开后缓存应还在');
    assert.equal((await again.cacheList('p:')).length, 2, '重开后前缀查询应还在');
    assert.equal((await again.listReadRecordShows())[0]!.readTime, 8700, '重开后阅读时长应还在');
    await again.close();
  } finally {
    cleanup(dir);
  }
});

test('JSON 回落实现：同一套断言同样通过（语义一致）', async () => {
  const dir = tempDir();
  try {
    const store = await createJsonUserStore({ dir });
    assert.equal(store.kind, 'json');
    const counts = await conformance(store, { expectYields: false });
    await store.close();
    const again = await createJsonUserStore({ dir });
    assert.equal(await again.countBooks(), counts.books, '重开后书架应还在');
    assert.equal(await again.countChapters('https://src.test/book/1'), counts.chaptersOfFirstBook);
    assert.equal((await again.getReaderPrefs()).themeMode, '2');
    await again.close();
  } finally {
    cleanup(dir);
  }
});

/* ------------------------------------------------------------------ *
 * 入口与诊断
 * ------------------------------------------------------------------ */

test('openUserStore：默认走 SQLite，schema 版本已写入', async () => {
  const dir = tempDir();
  try {
    const r = await openUserStore({ dir });
    assert.equal(r.store.kind, 'sqlite');
    assert.equal(r.degraded, false);
    assert.equal(r.reason, undefined);
    await r.store.close();
    assert.ok(await hasSqliteSupport(), '本机 Node 应支持 node:sqlite');
    // v2：`books` 增加本仓扩展列 `payload`（Phase 1.4，见 contract/user-data.ts 同名字段）
    // v3：`books` 增加本仓扩展列 `readStyle`（`#164` 每本书的阅读样式覆盖）
    // v4：`books` 增加本仓扩展列 `progressSec`/`durationSec`（`#141` 影视播放进度/时长）
    // v5：`dict_rules` 表（`#189`）；v6：`highlightRules` 表（`#262` 高亮规则）
    // v7：阅读统计三表 `read_session` / `book_read_stat` / `user_read_stat`（`#863`）
    assert.equal(USER_STORE_SCHEMA_VERSION, 7);
  } finally {
    cleanup(dir);
  }
});

test('openUserStore：kind=json 强制回落并标记 degraded', async () => {
  const dir = tempDir();
  try {
    const r = await openUserStore({ dir, kind: 'json' });
    assert.equal(r.store.kind, 'json');
    assert.equal(r.degraded, true);
    assert.match(String(r.reason), /json/);
    await r.store.close();
  } finally {
    cleanup(dir);
  }
});

test('openUserStore：数据库版本高于代码时回落（而不是整体不可用）', async () => {
  const dir = tempDir();
  try {
    const first = await createSqliteUserStore({ dir });
    await first.close();
    // 手工抬高 user_version，模拟"用新版建过库"
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
    };
    const db = new DatabaseSync(join(dir, 'yuedu.db'));
    db.exec('PRAGMA user_version = 99');
    db.close();

    // 显式要 sqlite → 必须直接抛错，便于排查
    await assert.rejects(
      () => createSqliteUserStore({ dir }),
      (e: unknown) => e instanceof UserStoreOpenError && /版本更新/.test(String((e as Error).message)),
    );
    // 默认入口 → 回落，服务仍可用
    const r = await openUserStore({ dir });
    assert.equal(r.degraded, true, '版本不兼容时应回落到 JSON');
    await r.store.close();
  } finally {
    cleanup(dir);
  }
});

test('JSON 实现：单文件落盘，close() 强制 flush', async () => {
  const dir = tempDir();
  try {
    const store = await createJsonUserStore({ dir });
    await store.upsertBook(makeBook({ bookUrl: 'https://flush.test/1' }));
    await store.close();
    const doc = JSON.parse(readFileSync(join(dir, 'user-data.json'), 'utf-8')) as { version: number; books: unknown[] };
    assert.equal(doc.version, 1);
    assert.equal(doc.books.length, 1);
  } finally {
    cleanup(dir);
  }
});


/**
 * `payload` 扩展字段往返（Phase 1.4；见 `contract/user-data.ts` 的同名字段注释）。
 *
 * 为什么单独锁它：这个字段**不是 Legado 的**，而 SQLite 实现是**列白名单**式读写
 * （`BOOK_COLUMNS` / `bookParams` / `rowToBook` **三处都要改**）—— 漏一处就是
 * 「写入看似成功、读回来 undefined」的静默丢失。而它一丢，书架里的书就**打不开了**
 * （缺引擎定位上下文）。JSON 实现是对象整体存取、自动兼容 ⇒ 本用例同时验证**两实现语义一致**。
 */
test('payload 扩展字段：两实现都能往返（更新其它字段后也不丢）', async () => {
  for (const mk of [createSqliteUserStore, createJsonUserStore]) {
    const dir = tempDir();
    try {
      const store = await mk({ dir });
      const url = 'https://src.test/book/payload';
      const payload = JSON.stringify({ bookUrl: url, name: '书一', author: '作者' });
      await store.upsertBook({ ...emptyShelfBook(), bookUrl: url, name: '书一', author: '作者', payload });
      const a = await store.getBook(url);
      assert.equal(a?.payload, payload, `${store.kind}：payload 必须原样往返（丢失 = 书架里的书打不开）`);

      // 再 upsert 一次（走 ON CONFLICT DO UPDATE / 对象覆盖分支），payload 不能被别的字段冲掉
      await store.upsertBook({ ...a!, durChapterIndex: 3 });
      const b = await store.getBook(url);
      assert.equal(b?.payload, payload, `${store.kind}：更新其它字段后 payload 仍要在`);
      assert.equal(b?.durChapterIndex, 3, `${store.kind}：其它字段也要正常写入`);
      await store.close();
    } finally {
      cleanup(dir);
    }
  }
});

/**
 * **schema 迁移 v1 → v2**：用户数据目录里已经有 v1 的 `yuedu.db`，升级后必须能自动补上
 * `books.payload` 列，且**老数据一条都不能丢**（`CREATE TABLE IF NOT EXISTS` 不会给已有表补列，
 * 这正是需要 `ALTER TABLE` 的原因）。
 *
 * 做法：建库 → 手工把库「回退」成 v1（删列 + 版本号写回 1）→ 重新打开 → 断言列已补、数据仍在、新列可读写。
 */
test('schema 迁移 v1 → v2：老库自动补 payload 列且不丢数据', async () => {
  if (!(await hasSqliteSupport())) return;
  const dir = tempDir();
  try {
    const s1 = await createSqliteUserStore({ dir });
    await s1.upsertBook({ ...emptyShelfBook(), bookUrl: 'https://src.test/old', name: '老书', author: 'a' });
    await s1.close();

    // 把库回退成 v1（模拟升级前的用户库）
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'yuedu.db'));
    db.exec('ALTER TABLE books DROP COLUMN payload');
    db.exec('PRAGMA user_version = 1');
    db.close();

    // 重新打开：应自动 ALTER 补列
    const s2 = await createSqliteUserStore({ dir });
    const b = await s2.getBook('https://src.test/old');
    assert.equal(b?.name, '老书', '迁移不得丢老数据');
    assert.equal(b?.payload, null, '新列默认 null');
    await s2.upsertBook({ ...b!, payload: '{"k":1}' });
    assert.equal((await s2.getBook('https://src.test/old'))?.payload, '{"k":1}', '迁移后新列可正常读写');
    await s2.close();
  } finally {
    cleanup(dir);
  }
});

/* ===================== `#228` 本地书文件名反推 =====================
 * 这条不是「锦上添花」：`originName` 为空时服务端 `localBookPath('')` 会抛「文件名越界」，
 * 而那句 throw 在 try 之外 ⇒ Fastify 兜成 **500**（实测：`originName:""` 打 content = 500）。
 */
test('#228 三种 bookUrl 形态都能反推出文件名', () => {
  assert.equal(fileNameFromLocalBookUrl('loc_book\0{"fileName":"测试.txt"}'), '测试.txt', '真实 NUL（Fastify 解码后）');
  assert.equal(fileNameFromLocalBookUrl('loc_book%00{"fileName":"测试.txt"}'), '测试.txt', '字面 %00（未解码）');
  assert.equal(fileNameFromLocalBookUrl('loc_book://测试.txt'), '测试.txt', '服务端默认形态');
});

test('#228 拿不到就回空串，**不抛也不猜**（坏数据不许变成新的 500）', () => {
  assert.equal(fileNameFromLocalBookUrl(''), '');
  assert.equal(fileNameFromLocalBookUrl('https://example.com/a.txt'), '', '非本地书');
  assert.equal(fileNameFromLocalBookUrl('loc_book'), '', '只有前缀');
  assert.equal(fileNameFromLocalBookUrl('loc_book\0{坏 JSON'), '', 'payload 解析失败 ⇒ 空串');
  assert.equal(fileNameFromLocalBookUrl('loc_book\0{"fileName":123}'), '', 'fileName 不是字符串 ⇒ 空串');
});

/* ===================== `#217` 写时归一（originName 与 bookUrl 自洽） =====================
 * 「同一判据写两处必然漂移」——`originName` 的自洽性是**一条**不变量，就该有**一个**实现。
 * 归一函数是它；服务端所有写书路径都调它。
 */
test('#217 空 originName 由 bookUrl 反推（三种形态都要认）', () => {
  const base = { ...emptyShelfBook(0), name: '书' };
  assert.equal(normalizeLocalBookOriginName({ ...base, bookUrl: 'loc_book\0{"fileName":"a.txt"}' }).originName, 'a.txt', '真实 NUL');
  assert.equal(normalizeLocalBookOriginName({ ...base, bookUrl: 'loc_book%00{"fileName":"b.txt"}' }).originName, 'b.txt', '字面 %00');
  assert.equal(normalizeLocalBookOriginName({ ...base, bookUrl: 'loc_book://c.txt' }).originName, 'c.txt', '旧形态');
});

test('#217 归一的三条边界：非空不动 / 推不出留空 / 非本地书不碰', () => {
  const base = { ...emptyShelfBook(0), name: '书' };
  // ① 已有非空值 ⇒ 原样返回（哪怕与 bookUrl 不一致：显式写入的值优先级最高）
  const explicit = normalizeLocalBookOriginName({ ...base, bookUrl: 'loc_book\0{"fileName":"a.txt"}', originName: '用户显式写的.txt' });
  assert.equal(explicit.originName, '用户显式写的.txt', '不允许被 bookUrl 纠正');

  // ② 推不出 ⇒ 留空（不猜、不抛）
  assert.equal(normalizeLocalBookOriginName({ ...base, bookUrl: 'loc_book\0{坏 JSON' }).originName, '', '坏 payload 留空');

  // ③ 非本地书 ⇒ `originName`（= 源名）必须原样保留，绝不能被 bookUrl 反推污染
  const net = normalizeLocalBookOriginName({ ...base, bookUrl: 'https://src.test/a', originName: '某某源' });
  assert.equal(net.originName, '某某源', '网络书的源名不受影响');
  // 网络书 + 空 originName ⇒ 仍是空（不伪造源的显示名）
  assert.equal(normalizeLocalBookOriginName({ ...base, bookUrl: 'https://src.test/a' }).originName, '');
});

test('#217 归一返回**新对象**，不改入参（调用点可能共享引用）', () => {
  const src = { ...emptyShelfBook(0), bookUrl: 'loc_book%00{"fileName":"a.txt"}', originName: '' };
  const out = normalizeLocalBookOriginName(src);
  assert.equal(out.originName, 'a.txt');
  assert.equal(src.originName, '', '入参不得被就地改写');
  assert.notEqual(out, src, '返回的是副本');
});
