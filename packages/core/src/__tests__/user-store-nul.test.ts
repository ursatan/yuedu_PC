/**
 * 缺陷类BU 回归锁：**含 `\u0000` 的字符串必须能完整往返**（`user-store/sqlite.ts`）。
 *
 * ## 为什么值得单独一个文件
 * 这条缺陷的症状是**静默截断**：无异常、无日志、`WHERE k = ?` 还照样命中 —— 只有把值读回来
 * 逐字符比对才看得见。而且它**不是理论风险**：本仓 `itemKey()` 的分隔符就是 `\u0000`。
 *
 * 实测根因（node v22.22.2 · `DatabaseSync`）：
 * ```
 * 写入 52 字符（含 NUL）→ 读回 22 字符（截到 NUL 前）；用原值查询仍命中 ⇒ 写入完整、只有读回被切
 * ```
 * 修法：`sqlite.ts` 的 `all`/`one` 统一把 **TEXT 列 `CAST(... AS BLOB)`** 读回再还原成字符串。
 *
 * ## 为什么两个实现都要断言
 * 与 `user-store.test.ts` 同一条理由：JSON 是回落实现，两者**语义必须一致** ——
 * 「SQLite 上能存、JSON 上丢一半」这种差异会让用户换台机器就丢数据。
 * （JSON 实现天然没有这个问题，这里跑一遍是为了**钉住它以后也不许退化**，例如有人做了
 *  `value.split('\0')[0]` 之类的"清理"。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyBookHighlight,
  emptyBookmark,
  emptyReplaceRule,
  emptyShelfBook,
  emptyShelfChapter,
  type ShelfBook,
} from '../contract/user-data';
import { createJsonUserStore, createSqliteUserStore, hasSqliteSupport, type UserDataStore } from '../user-store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuedu-nul-'));
}

const NUL = '\u0000';
/** 本仓 `itemKey()` 的真实形态：`sourceId \0 id` */
const COMPOSITE_KEY = `https://src.example.com${NUL}https://src.example.com/book/1`;
/** 尾部也放一个 NUL + 中段再放一个：截断修复若只处理「第一个 NUL 之前」会漏掉这些情况 */
const TRICKY = `头${NUL}中${NUL}尾`;

function book(bookUrl: string): ShelfBook {
  return { ...emptyShelfBook(), bookUrl, origin: 'https://src.example.com', name: TRICKY };
}

test('前置：本测试用的样本**确实含 NUL**（否则整套断言会退化成空转）', () => {
  assert.ok(COMPOSITE_KEY.includes(NUL), '主键必须含 NUL —— 这是 itemKey() 的真实形态');
  assert.equal(TRICKY.split(NUL).length - 1, 2, 'TRICKY 必须含 **两个** NUL（只修"第一个 NUL 之前"会漏）');
  assert.ok(TRICKY.endsWith('尾'), '末尾也要有字符 —— 截断修复若丢掉尾部会立刻暴露');
});

async function nuConformance(store: UserDataStore, label: string): Promise<void> {
  /* ① 书架：主键与普通字段都含 NUL ⇒ 读回必须逐字符相同 */
  await store.upsertBook(book(COMPOSITE_KEY));
  const got = await store.getBook(COMPOSITE_KEY);
  assert.ok(got, `${label}：应能按含 NUL 的主键取到书`);
  assert.equal(got!.bookUrl, COMPOSITE_KEY, `${label}：主键必须完整（截断会让书架的书互相串）`);
  assert.equal(got!.name, TRICKY, `${label}：含多个 NUL 的普通字段也要完整`);

  /* ② 列表路径（走 `SELECT *` + WHERE/ORDER BY，最容易只修一半） */
  const list = await store.listBooks({});
  assert.equal(list.length, 1, `${label}：列表应有 1 本`);
  assert.equal(list[0]!.bookUrl, COMPOSITE_KEY, `${label}：列表里的主键也要完整`);

  /* ③ **更新** 路径：不能因为主键含 NUL 而匹配不上（`ON CONFLICT` 是另一条 SQL） */
  await store.upsertBook({ ...book(COMPOSITE_KEY), author: `作者${NUL}甲` });
  const afterUpdate = await store.getBook(COMPOSITE_KEY);
  assert.equal(afterUpdate?.author, `作者${NUL}甲`, `${label}：更新后再读，含 NUL 的字段仍完整`);
  assert.equal((await store.listBooks({})).length, 1, `${label}：更新不应变成"插入了第二条"`);

  /* ④ 目录（外键子表：`SELECT * FROM chapters WHERE bookUrl = ?` 也走同一防护） */
  await store.replaceChapters(COMPOSITE_KEY, [
    { ...emptyShelfChapter(COMPOSITE_KEY, 0), url: `c${NUL}0`, title: `第${NUL}1${NUL}章` },
  ]);
  const chs = await store.listChapters(COMPOSITE_KEY);
  assert.equal(chs.length, 1, `${label}：目录应有 1 章`);
  assert.equal(chs[0]!.url, `c${NUL}0`, `${label}：章节 url 完整`);
  assert.equal(chs[0]!.title, `第${NUL}1${NUL}章`, `${label}：章节标题完整`);

  /* ⑤ 叶子表 + 其它实体（书签/高亮/净化规则各走自己的 SQL） */
  await store.upsertBookmark({ ...emptyBookmark(1), bookName: `书${NUL}名`, content: TRICKY });
  assert.equal((await store.listBookmarks())[0]?.content, TRICKY, `${label}：书签 content 完整`);
  await store.upsertHighlight({ ...emptyBookHighlight(2), bookUrl: COMPOSITE_KEY, note: TRICKY });
  const hls = await store.listHighlights(COMPOSITE_KEY);
  assert.equal(hls.length, 1, `${label}：高亮可按含 NUL 的 bookUrl 过滤`);
  assert.equal(hls[0]!.note, TRICKY, `${label}：高亮 note 完整`);
  await store.upsertReplaceRule({ ...emptyReplaceRule(3), name: `规则${NUL}名`, pattern: TRICKY });
  const rules = await store.listReplaceRules();
  assert.equal(rules[0]?.pattern, TRICKY, `${label}：净化规则 pattern 完整`);

  /* ⑥ **数字列不能被防护改坏**（只 CAST TEXT 列，INTEGER 必须仍是 number） */
  assert.equal(typeof got!.durChapterIndex, 'number', `${label}：INTEGER 列仍应是 number，不能被读成 BLOB`);
  assert.equal(typeof got!.type, 'number', `${label}：type 位掩码仍是 number`);
}

test('SQLite：含 NUL 的字段完整往返（缺陷类BU）', async (t) => {
  if (!hasSqliteSupport()) {
    t.skip('当前 Node 无 node:sqlite');
    return;
  }
  const dir = tempDir();
  const store = await createSqliteUserStore({ dir });
  try {
    await nuConformance(store, 'SQLite');
    /* ⑦ 重开库再读一遍：确认不是"只在内存里对"（WAL 落盘后再读仍完整） */
    await store.close();
    const reopened = await createSqliteUserStore({ dir });
    try {
      assert.equal((await reopened.getBook(COMPOSITE_KEY))?.name, TRICKY, 'SQLite：重开库后仍完整');
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('JSON 回落实现：同一套断言同样通过（语义一致）', async () => {
  const dir = tempDir();
  const store = await createJsonUserStore({ dir });
  try {
    await nuConformance(store, 'JSON');
    await store.close();
    const reopened = await createJsonUserStore({ dir });
    try {
      assert.equal((await reopened.getBook(COMPOSITE_KEY))?.name, TRICKY, 'JSON：重开文件后仍完整');
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
