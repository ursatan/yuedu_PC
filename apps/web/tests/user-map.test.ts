/**
 * 「本仓前端模型 ↔ 服务端契约」字段映射的回归锁 —— `utils/user-map.ts`。
 *
 * 为什么需要：映射写错**不会报错**，只会「某字段同步后变空/变错」。
 * 两类断言各自解决一个具体风险：
 *
 *  ① **逐字段对照**：`bookUrl` 用哪个键、`durChapterTitle` 到底是「读到的那一章」还是
 *     「最新章节」（契约里 `latestChapterTitle` 才是后者 —— 弄反了书架会显示别的书的进度）。
 *  ② **往返稳定**（`toRemote(fromRemote(x)) === x`）：`pushDiff` 靠「契约 JSON 是否相同」
 *     判断「这一条要不要推」。往返不稳定的映射会让**每次写都重推全表**（请求风暴），
 *     而单测里看不出来 —— 所以必须显式锁住。
 *
 * 运行：`pnpm --filter @yuedu/web test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BookType, emptyBookReadConfig } from '@yuedu/core/contract';
import {
  bookTypeToKind, contractToBookmark, contractToShelfBook, decodeItemKey, encodeItemKey,
  jsonToPayload, kindToBookType, payloadToJson, bookmarkToContract, shelfBookToContract,
} from '../src/utils/user-map';
import type { Bookmark, ShelfBook } from '../src/stores/reader';

const KEY = 'https://example.com/book/1\u0000https://example.com/book/1';
/** 转义后的主键（契约 `bookUrl` 就是这个形态） */
const ENC = 'https://example.com/book/1%00https://example.com/book/1';

const local: ShelfBook = {
  key: KEY,
  sourceId: 'https://source.example.com',
  payload: { bookUrl: 'https://example.com/book/1' },
  title: '测试书',
  author: '作者甲',
  cover: 'https://img.example.com/c.jpg',
  kind: 'book',
  lastChapter: { title: '第 3 章', payload: { chapterUrl: 'https://example.com/c/3' } },
  lastIdx: 2,
  updatedAt: 1_700_000_000_000,
  group: 4,
  latestChapterTime: 1_690_000_000_000,
  totalChapterNum: 100,
  canUpdate: true,
  lastCheckCount: 2,
};

test('★ 主键转义（类BU）：`\u0000` 不能进持久层，且转义必须可逆、无歧义', () => {
  // 实测：node:sqlite 读回时在第一个 NUL 处截断 ⇒ 复合主键必须转义后才能当契约 bookUrl
  assert.equal(encodeItemKey(KEY), ENC);
  assert.equal(decodeItemKey(ENC), KEY);
  assert.ok(!encodeItemKey(KEY).includes('\u0000'), '转义后不得再含 NUL');

  // 无歧义：字面量 `%00` 与真正的 NUL 不能撞
  const literal = 'a%00b';
  const withNul = 'a\u0000b';
  assert.notEqual(encodeItemKey(literal), encodeItemKey(withNul));
  assert.equal(decodeItemKey(encodeItemKey(literal)), literal);
  assert.equal(decodeItemKey(encodeItemKey(withNul)), withNul);
  // 已有 `%` 也不能被二次转义
  assert.equal(decodeItemKey(encodeItemKey('a%25b')), 'a%25b');
  assert.equal(decodeItemKey(encodeItemKey('100%')), '100%');
});

test('书架 → 契约：关键字段各就各位（尤其两个「chapter」不能弄反）', () => {
  const c = shelfBookToContract(local, KEY);
  assert.equal(c.bookUrl, ENC, '主键 = itemKey 转义后（本仓唯一标识）');
  assert.equal(c.origin, local.sourceId);
  assert.equal(c.name, '测试书');
  assert.equal(c.author, '作者甲');
  assert.equal(c.coverUrl, 'https://img.example.com/c.jpg');
  assert.equal(c.kind, null, 'Legado 的「分类信息」本仓不存 ⇒ null');
  assert.equal(c.type, BookType.text);
  assert.equal(c.group, 4);
  assert.equal(c.totalChapterNum, 100);
  assert.equal(c.lastCheckCount, 2);
  // ★ 两个易混点
  assert.equal(c.durChapterTitle, '第 3 章', '`lastChapter` 是**读到的那一章** ⇒ durChapterTitle');
  assert.equal(c.durChapterIndex, 2, '`lastIdx` ⇒ durChapterIndex');
  assert.equal(c.durChapterTime, 1_700_000_000_000, '`updatedAt` ≈ durChapterTime（最近阅读时间）');
  assert.equal(c.latestChapterTitle, null, '`latestChapterTitle`（**最新**章标题）本仓不存 —— 不能拿 lastChapter 顶');
  assert.equal(c.latestChapterTime, 1_690_000_000_000);
  assert.equal(c.payload, '{"bookUrl":"https://example.com/book/1"}', 'payload 是 JSON 字符串（本仓扩展字段）');
});

test('书架 → 契约 → 本仓：**往返稳定**（否则每次写都会重推全表）', () => {
  const c1 = shelfBookToContract(local, KEY);
  const back = contractToShelfBook(c1);
  assert.equal(back.key, KEY);
  assert.deepEqual(back.payload, { bookUrl: 'https://example.com/book/1' });
  assert.equal(back.lastIdx, 2);
  assert.equal(back.updatedAt, 1_700_000_000_000);
  assert.equal(back.kind, 'book');

  const c2 = shelfBookToContract(back, back.key as string);
  assert.deepEqual(c2, c1, '往返后契约形态必须逐字段相同（pushDiff 的去重判据）');
});

test('kind ↔ BookType 位掩码：双向对齐，且 type 是**位掩码**不是字符串', () => {
  assert.equal(kindToBookType('video'), BookType.video);
  assert.equal(kindToBookType('image'), BookType.image);
  assert.equal(kindToBookType('audio'), BookType.audio);
  assert.equal(kindToBookType('book'), BookType.text);
  assert.equal(kindToBookType(undefined), BookType.text, '缺省按文本');

  assert.equal(bookTypeToKind(BookType.video), 'video');
  assert.equal(bookTypeToKind(BookType.image), 'image');
  assert.equal(bookTypeToKind(BookType.audio), 'audio');
  assert.equal(bookTypeToKind(BookType.text), 'book');
  assert.equal(bookTypeToKind(undefined), 'book');
  // 叠加位（Legado 的 updateError 会与主类型并存）：按主类型位判定，不造本仓没有的模型
  assert.equal(bookTypeToKind(BookType.text | BookType.updateError), 'book');
  // 用等价算术而不是 `&`（JS 位运算 32 位）：大位值也必须正确
  assert.equal(bookTypeToKind(BookType.video + BookType.local), 'video');
});

test('payload：对象 ↔ JSON 字符串，坏数据**必须留痕**且不抛', () => {
  assert.equal(payloadToJson(undefined), null);
  assert.equal(payloadToJson(null), null);
  assert.equal(payloadToJson({ a: 1 }), '{"a":1}');

  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.equal(payloadToJson(cyclic), null, '循环引用 ⇒ null（不抛，但要 console.warn）');

  assert.deepEqual(jsonToPayload(null), {});
  assert.deepEqual(jsonToPayload(''), {});
  assert.deepEqual(jsonToPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(jsonToPayload('{坏 JSON'), {}, '解析失败 ⇒ {}（不抛，但要 console.warn）');
});

test('书签：契约就是 **8 个字段**，且本仓的 sourceId 不能塞进去', () => {
  const b: Bookmark = {
    time: 1_700_000_000_123,
    sourceId: 'https://source.example.com',
    bookName: '测试书',
    bookAuthor: '作者甲',
    chapterIndex: 2,
    chapterPos: 120,
    chapterName: '第 3 章',
    bookText: '第 3 章',
    content: '选中的一句话',
  };
  const c = bookmarkToContract(b);
  assert.equal(Object.keys(c).length, 8, '契约 Bookmark 恰好 8 个字段（照 Bookmark.kt 逐条提取）');
  assert.deepEqual(c, {
    time: 1_700_000_000_123,
    bookName: '测试书',
    bookAuthor: '作者甲',
    chapterIndex: 2,
    chapterPos: 120,
    chapterName: '第 3 章',
    bookText: '第 3 章',
    content: '选中的一句话',
  });

  // 往回：sourceId 契约里没有 ⇒ 置空，由 hydrateBookmarks 从本地缓存回填
  const back = contractToBookmark(c);
  assert.equal(back.sourceId, '');
  assert.equal(back.time, b.time);
  // 回填后必须能再往返成同一份契约（pushDiff 的去重判据）
  assert.deepEqual(bookmarkToContract({ ...back, sourceId: b.sourceId }), c);
});

test('书架：契约里没有对应项的字段**不得**被塞进别的字段（否则会污染 UI 文本）', () => {
  const c = shelfBookToContract(local, KEY);
  // 这些字段是「本仓有、契约没有」的：progressSec / durationSec / lastChapter.payload。
  // 逐个确认它们没被塞进任何契约字段里（尤其 bookText / content / variable 这类会显示给用户的）。
  const json = JSON.stringify(c);
  assert.ok(!json.includes('chapterUrl'), 'lastChapter.payload 不能出现在契约里（它在 localStorage 缓存里）');
  assert.equal(c.variable, null, 'variable 是**源脚本**的命名空间，不能借用');
  assert.equal(c.intro, null);
  assert.equal(c.charset, null);
  assert.equal(c.readConfig, null);
});

test('#141 影视进度与 notShelf 位：契约往返必须双向无损（丢了就在对齐时静默消失）', () => {
  const v: ShelfBook = {
    key: 'vid::1',
    sourceId: 'demo-vod',
    payload: { vodId: 1 },
    title: '某剧集',
    kind: 'video',
    notShelf: true,                      // 观影历史行（看过但没收藏）
    lastChapter: { title: '第 3 集', payload: { ep: 3 } },
    updatedAt: 1700000000000,
    progressSec: 731.5,
    durationSec: 2700,
  };
  const c = shelfBookToContract(v, v.key!);
  // notShelf 走 type 位（Legado BookType.notShelf = 0b100_0000_0000），kind 的主类型位不丢
  assert.equal(c.type & BookType.notShelf, BookType.notShelf, 'notShelf 位必须进 type');
  assert.equal(c.type & BookType.video, BookType.video, 'video 主类型位保留');
  assert.equal(c.progressSec, 731.5);
  assert.equal(c.durationSec, 2700);
  assert.equal(c.durChapterTitle, '第 3 集');
  const back = contractToShelfBook(c);
  assert.equal(back.notShelf, true);
  assert.equal(back.kind, 'video');
  assert.equal(back.progressSec, 731.5);
  assert.equal(back.durationSec, 2700);
  assert.equal(back.lastChapter?.title, '第 3 集');
  // 收藏行（无 notShelf）往返后位不误加
  const shelved = shelfBookToContract({ ...v, notShelf: undefined }, v.key!);
  assert.equal(shelved.type & BookType.notShelf, 0, '没置 notShelf 就不得误加位');
  assert.equal(contractToShelfBook(shelved).notShelf, false);
});

/**
 * `#260`：**本书级净化开关**走 `readConfig` 列（上游 `Book.ReadConfig.useReplaceRule`）。
 *
 * 这条锁住两件容易做错的事：
 *  ① **三态不能塌成两态** —— `null`（跟随全局）与 `false`（本书显式关闭）行为完全不同，
 *     往返时把 `null` 读成 `false` 会让「我没设过」变成「我关了」，用户查不出原因；
 *  ② 服务端空列读回的是 `emptyBookReadConfig()`（**契约默认值对象**，不是字面 `null`）
 *     ⇒ 映射层必须归一成 `null`，否则界面会显示成「本书显式设为…」而其实用户从没设过。
 */
test('#260 本书级净化开关：readConfig 列往返保持三态，且契约默认值要归一成「跟随全局」', () => {
  const base = { key: 'k1', sourceId: 'src-a', payload: { id: 1 }, title: '测试书' } as ShelfBook;

  // ① 从没设过 ⇒ 整列为 null（不是 `{}`，也不是 `{useReplaceRule:null}`）
  const none = shelfBookToContract(base, 'k1');
  assert.equal(none.readConfig, null, '没设过 ⇒ 列 null');
  assert.equal(contractToShelfBook(none).useReplaceRule, null, '读回是 null = 跟随全局');

  // ② 显式 false ⇒ 三态里的第三态，必须原样回来
  const off = shelfBookToContract({ ...base, key: 'k2', useReplaceRule: false }, 'k2');
  assert.equal(off.readConfig?.useReplaceRule, false);
  assert.equal(off.readConfig?.reverseToc, false, '其余 18 个字段用契约默认值占位（本仓没有数据源）');
  assert.equal(contractToShelfBook(off).useReplaceRule, false, 'false 必须保住，不能塌成 null');

  // ③ 显式 true
  const on = shelfBookToContract({ ...base, key: 'k3', useReplaceRule: true }, 'k3');
  assert.equal(contractToShelfBook(on).useReplaceRule, true);

  // ④ ★ 防空转：服务端空列的形状是 `emptyBookReadConfig()`（useReplaceRule 默认就是 null）
  const fromEmptyColumn = contractToShelfBook({ ...none, readConfig: emptyBookReadConfig() });
  assert.equal(fromEmptyColumn.useReplaceRule, null, '契约默认值 null 要归一成「跟随全局」');
});
