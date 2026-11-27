/**
 * `#201` 用户数据**导入/合并**回归测试
 *
 * 覆盖 `user-store/import.ts`。与 `user-store.test.ts` 同一套路：**同一套断言跑两个实现**
 * （sqlite 主实现 + json 回落），两者语义必须一致。
 *
 * ## 为什么这些断言不能省
 * 导入是**唯一会批量改写用户数据**的入口，且用户是拿它**换设备恢复**用的 ——
 * 出错代价是「数据倒退且不可恢复」。所以四条底线各占一组断言：
 * 1. **默认不覆盖**（备份比线上旧时不得把新数据打回去）
 * 2. **永不删除**（快照里没有 ≠ 要删；删只能由用户显式操作）
 * 3. **防空转**：不能只断言「导入没报错」，必须断言**目标字段真的按规则变了/没变**
 * 4. **老备份兼容**（未知字段丢弃、缺主键跳过）—— 备份文件的字段集可能与当前契约不同
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyBookmark,
  emptyGlobalReaderPrefs,
  emptyShelfBook,
  emptyShelfChapter,
  type GlobalReaderPrefs,
} from '../contract/user-data';
import {
  createJsonUserStore,
  createSqliteUserStore,
  hasSqliteSupport,
  importSnapshot,
  type UserDataStore,
} from '../user-store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuedu-import-'));
}
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 上文件偶尔仍被占用 → 交给系统回收 */
  }
}

const T0 = 1_700_000_000_000;

async function withStore(fn: (store: UserDataStore) => Promise<void>): Promise<void> {
  const dir = tempDir();
  const json = await createJsonUserStore({ dir });
  try {
    await fn(json);
  } finally {
    await json.close().catch(() => {});
    cleanup(dir);
  }
  if (await hasSqliteSupport()) {
    const dir2 = tempDir();
    const sql = await createSqliteUserStore({ dir: dir2 });
    try {
      await fn(sql);
    } finally {
      await sql.close().catch(() => {});
      cleanup(dir2);
    }
  }
}

test('#201 默认合并：已有条目**原样保留**（不被旧备份打回），缺的补上', async () => {
  await withStore(async (store) => {
    // 服务端：一本已存在（书名是「线上新名」），一本没有
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://a', name: '线上新名', durChapterTime: T0 + 5000 });
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://b', name: '只有线上有', durChapterTime: T0 });

    const r = await importSnapshot(store, {
      books: [
        { bookUrl: 'u://a', name: '备份旧名', durChapterTime: T0 },   // 冲突：默认不动
        { bookUrl: 'u://c', name: '备份独有', durChapterTime: T0 },   // 新增
      ],
    });

    assert.equal(r.books.added, 1, '新增 1 条');
    assert.equal(r.books.kept, 1, '冲突 1 条被保留');
    assert.equal(r.books.updated, 0, '默认模式不得改动任何已有条目');

    // ★ 防空转：断言**值真的没被改**（只数 added/kept 是假通过 —— 万一实现把 a 也覆盖了，计数对不上就会被发现，
    //   但这里再直接读一次值，把「保留」钉死）
    const a = await store.getBook('u://a');
    assert.equal(a?.name, '线上新名', '已存在条目必须保持线上的值（备份是旧的）');
    assert.equal(a?.durChapterTime, T0 + 5000, '阅读时间戳也不得被备份倒推');
    // 新增那条真的进去了
    const c = await store.getBook('u://c');
    assert.equal(c?.name, '备份独有', '快照里独有的书必须补进来');
    // 服务端独有的那条**仍在**（合并只做加法）
    assert.ok(await store.getBook('u://b'), '服务端独有条目不得消失');
    assert.equal(await store.countBooks(), 3);
  });
});

test('#201 覆盖同名：冲突项以快照为准（但仍不删除任何条目）', async () => {
  await withStore(async (store) => {
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://a', name: '线上新名' });
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://b', name: '线上独有' });

    const r = await importSnapshot(
      store,
      { books: [{ bookUrl: 'u://a', name: '备份旧名' }] },
      { overwrite: true },
    );

    assert.equal(r.books.updated, 1);
    assert.equal(r.books.added, 0);
    const a = await store.getBook('u://a');
    assert.equal(a?.name, '备份旧名', '覆盖模式下冲突项必须变成快照的值');
    // ★ 防空转反向断言：覆盖 ≠ 删除 —— 快照里没提到的 b 必须还在
    assert.ok(await store.getBook('u://b'), '覆盖模式同样不得删除快照外的数据');
    assert.equal(await store.countBooks(), 2);
  });
});

test('#201 永不删除：快照为空 ⇒ 服务端数据一条不少（防空转：先证明服务端非空）', async () => {
  await withStore(async (store) => {
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://keep1', name: 'k1' });
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://keep2', name: 'k2' });
    await store.upsertBookmark({ ...emptyBookmark(T0), time: T0, bookName: 'k1' });
    assert.equal(await store.countBooks(), 2, '前置：服务端本来有 2 本（防空转）');

    const r = await importSnapshot(store, { books: [], bookmarks: [] }, { overwrite: true });

    assert.equal(r.books.added + r.books.updated + r.books.kept + r.books.skipped, 0);
    assert.equal(await store.countBooks(), 2, '导入空快照后条数不变');
    assert.equal((await store.listBookmarks()).length, 1, '书签也不得被清空');
  });
});

test('#201 阅读记录：合并口径取「时长更大者」（累加型数据不能一律不动）', async () => {
  await withStore(async (store) => {
    await store.addReadTime('dev1', '书甲', 10_000, '作者', T0);
    await store.addReadTime('dev1', '书乙', 1_000, '作者', T0);

    const r = await importSnapshot(store, {
      readRecords: [
        { deviceId: 'dev1', bookName: '书甲', author: '作者', readTime: 4_000, lastRead: T0 },      // 更小 ⇒ 留
        { deviceId: 'dev1', bookName: '书乙', author: '作者', readTime: 9_000, lastRead: T0 + 1 },  // 更大 ⇒ 取
        { deviceId: 'dev1', bookName: '书丙', author: '作者', readTime: 2_000, lastRead: T0 },      // 没有 ⇒ 新增
      ],
    });
    assert.equal(r.readRecords.updated, 1, '只有「更大者」那一条被改动');
    assert.equal(r.readRecords.kept, 1, '更小的那条保留服务端值');
    assert.equal(r.readRecords.added, 1);

    const byName = new Map((await store.listReadRecords()).map((x) => [x.bookName, x]));
    assert.equal(byName.get('书甲')?.readTime, 10_000, '★ 不得把 10000 覆盖成 4000（导入不能倒退时长）');
    assert.equal(byName.get('书乙')?.readTime, 9_000, '更快的那条要取');
    assert.equal(byName.get('书丙')?.readTime, 2_000, '缺的要新增');
  });
});

test('#201 偏好：合并只填「服务端仍是默认值」的字段；已改过的不被备份覆盖', async () => {
  await withStore(async (store) => {
    const def = emptyGlobalReaderPrefs();
    // 服务端把 textSize 改成非默认（模拟用户在本机调过字号）
    const nonDefaultSize = def.textSize + 7;
    await store.setReaderPrefs({ textSize: nonDefaultSize });
    assert.equal((await store.getReaderPrefs()).textSize, nonDefaultSize, '前置：服务端确实改过（防空转）');

    const r = await importSnapshot(store, {
      prefs: {
        textSize: def.textSize, // 备份是默认值 —— 绝不该把服务端的改动打回去
        chineseConverterType: 1, // 服务端仍是默认 0 ⇒ 应该被填充
      } as unknown as Partial<GlobalReaderPrefs>,
    });

    assert.equal(r.prefs.policy, 'fill-default');
    assert.equal(r.prefs.fields, 1, '只有「服务端为默认值」的那个字段被填');
    const cur = await store.getReaderPrefs();
    assert.equal(cur.textSize, nonDefaultSize, '★ 用户改过的设置不得被备份覆盖');
    assert.equal(cur.chineseConverterType, 1, '默认值字段应被备份填充');
  });
});

test('#201 老备份兼容：未知字段丢弃、缺主键跳过、目录只补新增', async () => {
  await withStore(async (store) => {
    await store.upsertBook({ ...emptyShelfBook(T0), bookUrl: 'u://a', name: '甲' });
    await store.replaceChapters('u://a', [
      { ...emptyShelfChapter('u://a', 0), url: 'u://a/1', title: '老目录' },
    ]);

    const r = await importSnapshot(store, {
      // 快照里带未来字段（模拟字段集不同的老/新备份）+ 一条缺主键的垃圾
      books: [
        { bookUrl: '', name: '没有主键' },
        { bookUrl: 'u://a', name: '甲', 这个字段不该进库: 1 },
      ],
      chapters: {
        'u://a': [
          { url: 'u://a/1', title: '备份里的旧标题' }, // 已存在 ⇒ 默认不覆盖
          { url: 'u://a/2', title: '新章' },           // 新增
        ],
      },
    });

    assert.equal(r.books.skipped, 1, '缺主键的条目必须跳过（不是写入）');
    assert.equal(r.books.kept, 1);
    assert.equal(r.chapters.added, 1);
    assert.equal(r.chapters.kept, 1);

    const chs = await store.listChapters('u://a');
    assert.equal(chs.length, 2, '目录：老的一条 + 新的一条');
    assert.equal(chs.find((c) => c.url === 'u://a/1')?.title, '老目录', '已存在的章默认不被备份覆盖');
    assert.equal(chs.find((c) => c.url === 'u://a/2')?.title, '新章');

    const a = await store.getBook('u://a');
    assert.equal(a?.name, '甲');
    assert.ok(!('这个字段不该进库' in (a as unknown as Record<string, unknown>)), '快照里的未知字段不得写进存储');
  });
});

test('#201 计数汇总口径：一次完整导入的逐实体计数可核对', async () => {
  await withStore(async (store) => {
    const r = await importSnapshot(store, {
      version: 1,
      books: [{ bookUrl: 'u://1', name: '一' }, { bookUrl: 'u://2', name: '二' }],
      chapters: { 'u://1': [{ url: 'u://1/1', title: '章' }] },
      bookmarks: [{ ...emptyBookmark(T0), time: T0, bookName: '一' }],
      highlights: [],
      replaceRules: [{ id: 7, name: 'r', pattern: 'a', replacement: '' }],
      dictRules: [{ name: '汉典', urlRule: 'u', showRule: 's', enabled: true, sortNumber: 0 }],
      bookGroups: [{ groupId: 3, groupName: 'g' }],
      readRecords: [{ deviceId: 'd', bookName: '一', author: '', readTime: 1, lastRead: T0 }],
      prefs: { chineseConverterType: 1 },
    });
    assert.equal(r.books.added, 2);
    assert.equal(r.chapters.added, 1);
    assert.equal(r.bookmarks.added, 1);
    assert.equal(r.replaceRules.added, 1);
    assert.equal(r.dictRules.added, 1);
    assert.equal(r.bookGroups.added, 1);
    assert.equal(r.readRecords.added, 1);
    assert.equal(r.prefs.policy, 'fill-default');
    // 真的落库了（不是只统计）
    assert.equal(await store.countBooks(), 2);
    assert.equal((await store.listDictRules()).length, 1);
    assert.equal((await store.listBookGroups()).length, 1);
  });
});
