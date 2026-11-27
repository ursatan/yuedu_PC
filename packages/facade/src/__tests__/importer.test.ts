/**
 * 导入源：格式识别 + 解析 + 预览 + 批量入库（含去重策略）。
 *
 * 关键保证：
 *  1. 「解析出来 ≠ 能入库」—— 编译不过的条目必须进 errors（带原因），不让用户看到
 *     「预览 29 条、导入 0 条」；
 *  2. 预览与入库用同一套 id 派生规则（deriveId），重复判定才可信；
 *  3. TVBox 只认 MacCMS 接口，其余类型如实报错跳过，不假装成功。
 *
 * ⚠️ facade 不依赖任何具体引擎包（保持引擎无关性），因此这里用 mock 引擎。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineHub } from '../hub';
import { detectImportFormat, parseImportText, deriveId, safeSourceId, sameSourceRaw } from '../importer';
import type { RuleEngine } from '@yuedu/core';

/** mock：认领带 bookSourceUrl 的源，规则队列为空时判为编译失败（模拟 legado 的「不是 Legado 书源」） */
function mockLegado(): RuleEngine<unknown, unknown> {
  return {
    kind: 'legado',
    version: 't',
    capabilities: ['search'],
    detect: (raw: unknown) => typeof (raw as Record<string, unknown>)?.['bookSourceUrl'] === 'string',
    compile: (raw: unknown) => {
      const ok = typeof (raw as Record<string, unknown>)?.['ruleSearch'] === 'object';
      return ok ? { ok: true, rule: raw, issues: [] } : { ok: false, rule: undefined, issues: [{ level: 'error', message: '不是 Legado 书源' }] };
    },
    async search() {
      return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
    },
  } as unknown as RuleEngine<unknown, unknown>;
}

/** mock：认领带 apiUrl 的源 */
function mockMaccms(): RuleEngine<unknown, unknown> {
  return {
    kind: 'maccms',
    version: 't',
    capabilities: ['search'],
    detect: (raw: unknown) => typeof (raw as Record<string, unknown>)?.['apiUrl'] === 'string',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async search() {
      return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
    },
  } as unknown as RuleEngine<unknown, unknown>;
}

function makeHub(): EngineHub {
  const hub = new EngineHub();
  hub.registerEngine(mockLegado());
  hub.registerEngine(mockMaccms());
  return hub;
}

const LEGADO_A = {
  bookSourceUrl: 'https://a.example.com',
  bookSourceName: '源A',
  bookSourceGroup: '原创',
  ruleSearch: { bookList: '.x', name: '.y', bookUrl: 'a@href' },
};

test('detectImportFormat: Legado / MacCMS 两种形态；首条是占位/噪声时按样本投票', () => {
  assert.equal(detectImportFormat([LEGADO_A]), 'legado');
  assert.equal(detectImportFormat([{ name: '影视A', apiUrl: 'https://v.example.com/api.php/provide/vod/' }]), 'maccms');
  // 首条是占位/噪声时按样本投票，而不是被首条带偏
  assert.equal(detectImportFormat([{ foo: 1 }, { foo: 2 }, LEGADO_A]), 'legado');
});

test('#312：纯发现源（只有 exploreUrl，无搜索侧规则）在导入层必须认作 Legado', () => {
  const discoverOnly = {
    bookSourceUrl: 'https://d.example.com',
    bookSourceName: '无搜索源',
    exploreUrl: 'https://d.example.com/list?page={{page}}',
    ruleExplore: { bookList: '.item', name: '.t' },
  };
  assert.equal(detectImportFormat([discoverOnly]), 'legado', '导入层不得因「没有搜索规则」而改判其它格式');
  // 防空转：只判「格式对」不够 —— 必须真的进了 rows，且不报「不是 Legado 书源」
  const r = parseImportText(JSON.stringify([discoverOnly]), { defaultGroup: '我的' });
  assert.equal(r.rows.length, 1, '必须真的进 rows');
  assert.equal(r.errors.length, 0, '不得报错');
  assert.equal(r.rows[0]!.name, '无搜索源');
});

test('#312：缺主键但有 bookSourceName/ruleSearch 的源 —— 导入层与引擎层必须**一致地**拒绝', () => {
  // 旧实现的两处判据在这里**给出相反结论**（这就是「同一判据写两遍必然漂移」的实例）：
  //   · facade 的 looksLegado 认它（有 bookSourceName）⇒ 导入层放行；
  //   · 引擎的 detectBookSource 要求主键     ⇒ 编译报「不是 Legado 书源」。
  //   ⇒ 用户看到「预览说有、导入却报错」。
  // 现在两边都调契约层的唯一判据 ⇒ 在导入层就如实报「缺主键」。
  const noKey = { bookSourceName: '没有URL', ruleSearch: { bookList: '.x' } };
  const r = parseImportText(JSON.stringify([noKey]), { defaultGroup: '我的' });
  assert.equal(r.rows.length, 0, '不得进 rows');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.reason, /bookSourceUrl/, '要如实报缺主键');
  // 对偶：补上主键后必须正常进 rows（证明拒绝的理由是「缺主键」，而不是把源整体判死了）
  const withKey = { ...noKey, bookSourceUrl: 'https://n.example.com' };
  const r2 = parseImportText(JSON.stringify([withKey]), { defaultGroup: '我的' });
  assert.equal(r2.rows.length, 1, '补上主键就必须通过');
  assert.equal(r2.errors.length, 0);
});

test('parseImportText: Legado 数组 → 行 + 默认分组；缺 bookSourceUrl 计入错误', () => {
  const r = parseImportText(JSON.stringify([LEGADO_A, { bookSourceName: '没有URL' }]), { defaultGroup: '我的' });
  assert.equal(r.format, 'legado');
  assert.equal(r.parsedTotal, 2);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.name, '源A');
  assert.equal(r.rows[0]!.group, '原创', '源自带分组优先于默认分组');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.reason, /bookSourceUrl/);
});

test('parseImportText: 默认分组只补空缺', () => {
  const r = parseImportText(JSON.stringify([{ ...LEGADO_A, bookSourceGroup: '' }]), { defaultGroup: '补上' });
  assert.equal(r.rows[0]!.group, '补上');
});

test('parseImportText: 「name,apiUrl」文本清单 → 批量 CMS 源（非 JSON）', () => {
  const text = [
    '量子影视,https://v.example.com/api.php/provide/vod/',
    '番茄工厂,https://fanqie.example.com/api.php/provide/vod/',
    '# 这是注释行，应被忽略',
    '坏行没有逗号',
    '空URL,not-a-url',
  ].join('\n');
  const r = parseImportText(text);
  assert.equal(r.format, 'maccms', '清单被识别为 CMS');
  assert.equal(r.parsedTotal, 2, '只统计合法数据行（注释/坏行不计入）');
  assert.equal(r.rows.length, 2, '两条合法 CMS 行入库');
  assert.equal(r.rows[0]!.name, '量子影视');
  assert.equal(r.rows[0]!.kind, 'maccms');
  assert.equal(r.rows[0]!.id, 'https___v.example.com_api.php_provide_vod_');
  assert.equal(r.errors.length, 0, '坏行被 tryCmsLines 过滤，不计入错误');
});

test('parseImportText: 不像清单的纯文本 → 如实报「非 JSON 也非 CMS 清单」', () => {
  const r = parseImportText('随便一段中文不是 json 也没有逗号网址');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.reason, /JSON|CMS 文本清单/);
});

test('parseImportText: XML/RSS 文本如实拒绝（本版本没有 RSS 引擎）', () => {
  const r = parseImportText('<?xml version="1.0"?><rss><channel></channel></rss>');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.reason, /RSS/);
});

test('parseImportText: 非 JSON 也非 CMS 清单 → 如实报「既不是 JSON 也不是清单」', () => {
  const r = parseImportText('{ "bookSourceUrl": }');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.reason, /JSON|CMS 文本清单/);
});

test('previewImport + importRows：预览不计入、重复按 id 判定、skip/overwrite 两种策略', () => {
  const hub = makeHub();
  const text = JSON.stringify([
    LEGADO_A,
    { ...LEGADO_A, bookSourceUrl: 'https://b.example.com', bookSourceName: '源B' },
  ]);

  // 预览不写状态
  const p1 = hub.previewImport(text);
  assert.equal(p1.valid.length, 2);
  assert.equal(p1.duplicates.length, 0);
  assert.equal(hub.sources.size(), 0, '预览不得入库');

  const r1 = hub.importRows(parseImportText(text).rows, { dedupe: 'skip' });
  assert.deepEqual([r1.inserted, r1.updated, r1.skipped, r1.failed], [2, 0, 0, 0]);

  // 再导入一次 → 全部重复
  const p2 = hub.previewImport(text);
  assert.equal(p2.valid.length, 0);
  assert.equal(p2.duplicates.length, 2);
  assert.equal(p2.duplicates[0]!.existingName, '源A');
  const r2 = hub.importRows(parseImportText(text).rows, { dedupe: 'skip' });
  assert.deepEqual([r2.inserted, r2.updated, r2.skipped], [0, 0, 2]);
  const r3 = hub.importRows(parseImportText(text).rows, { dedupe: 'overwrite' });
  assert.deepEqual([r3.inserted, r3.updated, r3.skipped], [0, 2, 0]);
});

test('previewImport：编译不过的条目进 errors 而不是 valid（不会「预览 29、导入 0」）', () => {
  const hub = makeHub();
  // 有 bookSourceUrl，但没有 ruleSearch → 引擎判「不是 Legado 书源」
  const broken = { bookSourceUrl: 'https://x.example.com', bookSourceName: '空规则源' };
  const p = hub.previewImport(JSON.stringify([broken, LEGADO_A]));
  assert.equal(p.valid.length, 1);
  assert.equal(p.valid[0]!.name, '源A');
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0]!.reason, /不是 Legado 书源/);
});

test('previewImport: 覆盖导入保留用户已有的开关状态', () => {
  const hub = makeHub();
  hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows);
  hub.setSourceState('https___a.example.com', { searchEnabled: false });
  hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows, { dedupe: 'overwrite' });
  assert.equal(hub.sources.get('https___a.example.com')!.state.searchEnabled, false);
});

test('派生 id 必须是路由安全串（带 / 的 id 会让 /api/sources/:id/* 全部 404）', () => {
  assert.equal(safeSourceId('https://a.example.com/'), 'https___a.example.com_');
  assert.equal(deriveId({ bookSourceUrl: 'https://a.example.com' }, 'legado'), 'https___a.example.com');
  const row = parseImportText(JSON.stringify([LEGADO_A])).rows[0]!;
  assert.doesNotMatch(row.id, /[/:]/, 'id 不得含斜杠/冒号');
  assert.equal(row.id, 'https___a.example.com');
  // 中文域名/路径也应落到安全字符集
  assert.equal(safeSourceId('https://书.测试/x?q=1'), 'https____.___x_q_1');
});

test('导入源与同名文件源（id = 文件名）重复判定一致，不会重复入库', () => {
  const hub = makeHub();
  // 文件源：hub.loadDir 用文件名当 id → `https___a.example.com`
  hub.importSource(LEGADO_A, { id: 'https___a.example.com' });
  const r = hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows, { dedupe: 'skip' });
  assert.deepEqual([r.inserted, r.skipped], [0, 1], '同一个站不该出现两条');
  assert.equal(hub.sources.size(), 1);
});

// ===================== `#351` 导入预览三分类 + 自选导入 =====================

test('#351 sameSourceRaw：键序不同视为相同，值变了视为不同', () => {
  // 键序不同（粘贴/文件/URL 途径下常见）⇒ 必须判「相同」，否则预览满屏假「更新」
  assert.equal(sameSourceRaw({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameSourceRaw({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), true);
  // 数组**保持顺序**（规则数组顺序有语义）
  assert.equal(sameSourceRaw({ r: [1, 2] }, { r: [2, 1] }), false);
  // 值变了 ⇒ 不同
  assert.equal(sameSourceRaw({ a: 1 }, { a: 2 }), false);
  // null 是显式值，与「没有该键」不同
  assert.equal(sameSourceRaw({ a: null }, {}), false);
  // ★ 值为 undefined 的键**仍然占位**：判据是「键集是否一致」，不是「JSON 输出是否一致」。
  //   实测 `JSON.stringify({a:undefined})==='{}'` 但 `Object.keys` 里有 'a' ⇒ 与 {} 不同。
  assert.equal(sameSourceRaw({ a: undefined }, {}), false);
  // 两边同为 undefined ⇒ 相同（对称性，避免「总判不同」的伪实现也过）
  assert.equal(sameSourceRaw({ a: undefined }, { a: undefined }), true);
  // 继承属性不算（Object.keys 只取自有键）
  assert.equal(sameSourceRaw(Object.create({ a: 1 }), {}), true);
});

test('#351 previewImport 三分类：库里没有=新增 / 同 id 异内容=更新 / 同 id 同内容=重复', () => {
  const hub = makeHub();
  // 先入库源A（原始内容）
  hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows);

  const changedA = { ...LEGADO_A, bookSourceComment: '改过了' };       // 同 id（bookSourceUrl 未变）、内容变了
  const sameAKeyShuffled = { bookSourceName: '源A', bookSourceGroup: '原创', bookSourceUrl: 'https://a.example.com', ruleSearch: (LEGADO_A as Record<string, unknown>)['ruleSearch'] };
  const brandNew = { ...LEGADO_A, bookSourceUrl: 'https://new.example.com', bookSourceName: '全新源' };

  const p = hub.previewImport(JSON.stringify([changedA, sameAKeyShuffled, brandNew]));
  assert.equal(p.valid.length, 1, '只有「全新源」算新增');
  assert.equal(p.valid[0]!.name, '全新源');
  assert.equal(p.updatable.length, 1, '改了内容 = 更新');
  assert.equal(p.updatable[0]!.id, deriveId(changedA, 'legado'));
  assert.equal(p.duplicates.length, 1, '键序不同但内容等价 = 重复');
  assert.equal(p.duplicates[0]!.id, deriveId(sameAKeyShuffled, 'legado'));
  // ★ index = 该条在 rows 里的**原始下标**（勾选提交的键；前端展示顺序 ≠ 这里）
  assert.equal(p.updatable[0]!.index, 0, 'changedA 是第 0 条');
  assert.equal(p.duplicates[0]!.index, 1, 'sameAKeyShuffled 是第 1 条');
  assert.equal(p.valid[0]!.index, 2, 'brandNew 是第 2 条');
  // 预览不写状态
  assert.equal(hub.sources.size(), 1);
});

test('#351 importRows onlyIndexes：未勾选的行完全不碰（可移除）', () => {
  const hub = makeHub();
  hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows);
  const changedA = { ...LEGADO_A, bookSourceComment: '改过了' };
  const brandNew = { ...LEGADO_A, bookSourceUrl: 'https://new.example.com', bookSourceName: '全新源' };
  const rows = parseImportText(JSON.stringify([changedA, brandNew])).rows;

  // 只选「全新源」（下标 1）⇒ 下标 0 的更新那条完全不动
  const r1 = hub.importRows(rows, { onlyIndexes: [1] });
  assert.deepEqual([r1.inserted, r1.updated, r1.skipped], [1, 0, 0]);
  assert.equal(hub.sources.size(), 2);
  const aAfter = hub.sources.get('https___a.example.com');
  assert.notEqual((aAfter!.raw as Record<string, unknown>)['bookSourceComment'], '改过了', '未勾选的行不得被覆盖');

  // 只选「更新的那条」（下标 0）⇒ 已存在 ⇒ 覆盖（传 onlyIndexes 时不看全局 dedupe）
  const r2 = hub.importRows(rows, { onlyIndexes: [0] });
  assert.deepEqual([r2.inserted, r2.updated, r2.skipped], [0, 1, 0], '显式选中已存在 ⇒ 覆盖');
  const aAfter2 = hub.sources.get('https___a.example.com');
  assert.equal((aAfter2!.raw as Record<string, unknown>)['bookSourceComment'], '改过了');

  // 一个都没勾 ⇒ 一条都不动，且不产生 skipped（未勾选 ≠ 用户选的重复）
  const r3 = hub.importRows(rows, { onlyIndexes: [] });
  assert.deepEqual([r3.inserted, r3.updated, r3.skipped, r3.failed], [0, 0, 0, 0]);
});

test('#351 同一份文本里两条同 id 的源能被**逐行**勾选（下标是唯一键，id 不是）', () => {
  const hub = makeHub();
  hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows);

  // 合集文件常见：同一个站出现两次，两条 raw 同 id（deriveId 只认 bookSourceUrl）但内容不同
  const v1 = { ...LEGADO_A, bookSourceComment: '第一次' };
  const v2 = { ...LEGADO_A, bookSourceComment: '第二次' };
  const rows = parseImportText(JSON.stringify([v1, v2])).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, rows[1]!.id, '前提：两条同 id');

  const p = hub.previewImport(JSON.stringify([v1, v2]));
  assert.equal(p.updatable.length, 2, '两条都进「更新」');
  assert.deepEqual(p.updatable.map((x) => x.index), [0, 1], '★ 下标不同 ⇒ 能分别勾选');
  assert.equal(new Set(p.updatable.map((x) => x.id)).size, 1, '★ 而 id 相同 ⇒ 用 id 当勾选键就会联动');

  // 只保留「第二次」⇒ 落库的必须是第二次的内容
  hub.importRows(rows, { onlyIndexes: [1] });
  const after = hub.sources.get('https___a.example.com');
  assert.equal((after!.raw as Record<string, unknown>)['bookSourceComment'], '第二次');
});

/**
 * ★ 这条锁的是**三分类同时出现**时的 `index` 取值：前端「默认勾新增+更新、不勾重复」
 *   的实现依赖 `verdict !== 'dup'` 去筛 `index`。若 `duplicates` 条目不参与
 *   `index`（例如漏赋、或与 valid/updatable 各编一套号），前端就**永远选不中重复行**、
 *   也判断不出该不该默认勾 —— 实测踩到过（反集实现下的「全选无效」）。
 */
test('#351 三分类并存时 index 齐全且互不重叠（重复行也在自己的下标上）', () => {
  const hub = makeHub();
  hub.importRows(parseImportText(JSON.stringify([LEGADO_A])).rows);

  const dup = { ...LEGADO_A };                                  // 同 id 同内容 ⇒ 重复
  const upd = { ...LEGADO_A, bookSourceComment: '改了' };        // 同 id 异内容 ⇒ 更新
  const nw = { ...LEGADO_A, bookSourceUrl: 'https://n.example.com', bookSourceName: '新' }; // 新增
  const p = hub.previewImport(JSON.stringify([dup, upd, nw]));

  assert.equal(p.duplicates.length, 1);
  assert.equal(p.updatable.length, 1);
  assert.equal(p.valid.length, 1);

  const all = [...p.valid, ...p.updatable, ...p.duplicates].map((x) => x.index).sort((a, b) => a - b);
  assert.deepEqual(all, [0, 1, 2], '三类各自带 index，合起来正好覆盖 0..2');
  assert.equal(new Set(all).size, 3, '互不重叠（重复两个源会共用下标）');
  // 默认勾选集（前端 defaultChecked 的等价实现）= 去掉重复
  const defChecked = [...p.valid, ...p.updatable].map((x) => x.index).sort((a, b) => a - b);
  assert.deepEqual(defChecked, [1, 2], '默认勾「更新 + 新增」，不含重复行的下标 0');
});

test('#351 importRows 不传 onlyIndexes 时保持旧行为（dedupe=skip 跳过 / overwrite 覆盖）', () => {
  const hub = makeHub();
  const rows = parseImportText(JSON.stringify([LEGADO_A])).rows;
  hub.importRows(rows);
  assert.deepEqual(
    [hub.importRows(rows, { dedupe: 'skip' }).inserted, hub.importRows(rows, { dedupe: 'skip' }).skipped],
    [0, 1],
  );
  assert.equal(hub.importRows(rows, { dedupe: 'overwrite' }).updated, 1);
});

// ===================== `#640` 源 id 折叠碰撞 / 文件名过滤丢源 =====================

/**
 * 用户实测：两个源只有 `bookSourceUrl` 的中文不同（`APP小说接口` / `APP短剧接口`），
 * 导入时被识别成同一个、更新，导入一个把另一个覆盖掉。
 * 根因 = `safeSourceId` 把表外字符**逐个折成 `_`**（多对一），两者都得到 `APP____`。
 */
test('#640 只差中文字符的两个 bookSourceUrl 不得撞成同一个 id', () => {
  const A = { bookSourceUrl: 'APP小说接口', bookSourceName: '听小说APP[小说_官方本地解密]', ruleSearch: { bookList: '$.data' } };
  const B = { bookSourceUrl: 'APP短剧接口', bookSourceName: '听小说APP[短剧_官方本地解密]', ruleSearch: { bookList: '$.data' } };
  const a = deriveId(A, 'legado');
  const b = deriveId(B, 'legado');
  assert.notEqual(a, b, `两个不同的源派生出同一个 id：${a}`);
  assert.match(a, /^[\w.-]+$/, 'id 必须路由安全（不含 / : 等）');
  assert.match(b, /^[\w.-]+$/, 'id 必须路由安全（不含 / : 等）');
  // id 必须是 raw 的**纯函数**：同一份源重复派生结果不变，否则去重失效（比碰撞更糟）
  assert.equal(deriveId({ ...A }, 'legado'), a);
  assert.equal(deriveId({ bookSourceUrl: 'APP小说接口' }, 'legado'), a, '规则变了但 url 没变 ⇒ id 不变');
});

test('#640 纯 URL 字符集的候选 id 保持原样（482 个存量源「文件名即 id」不被改写）', () => {
  assert.equal(deriveId({ bookSourceUrl: 'https://a.example.com' }, 'legado'), 'https___a.example.com');
  assert.equal(
    deriveId({ bookSourceUrl: 'https://a.example.com/x?y=1#z' }, 'legado'),
    'https___a.example.com_x_y_1_z',
  );
  assert.equal(safeSourceId('https://书.测试/x?q=1'), 'https____.___x_q_1', 'safeSourceId 本身语义不变（折叠仍会发生）');
});

test('#640 两个源同批导入 ⇒ 入库 2 条，不再互相覆盖', () => {
  const hub = makeHub();
  const A = { bookSourceUrl: 'APP小说接口', bookSourceName: '听小说(小说)', ruleSearch: { bookList: '$.data' } };
  const B = { bookSourceUrl: 'APP短剧接口', bookSourceName: '听小说(短剧)', ruleSearch: { bookList: '$.data' } };
  const parsed = parseImportText(JSON.stringify([A, B]));
  const p = hub.previewImport(JSON.stringify([A, B]));
  assert.deepEqual([p.valid.length, p.updatable.length, p.duplicates.length], [2, 0, 0], '两条都应是「新增」而不是「更新」');
  const r = hub.importRows(parsed.rows);
  assert.deepEqual([r.inserted, r.updated, r.skipped], [2, 0, 0]);
  assert.equal(hub.sources.size(), 2);
});

/**
 * `#640` 另一半：`loadDir` 用 `!f.startsWith('_')` 过滤文件（本意跳过 `_index.json` 汇总），
 * 但中文 url 派生的文件名天然是 `____.json` 形状 ⇒ 真实源被静默丢弃。
 * 实测本仓有 5 个这样的源从未加载（七猫四合一本地版 / 大灰狼聚合 / 光遇聚合 / 木里聚合 / 明月书阁）。
 */
test('#640 loadDir 不得丢弃「文件名以下划线开头」的真实源，且仍跳过汇总文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-loaddir-'));
  try {
    fs.writeFileSync(path.join(dir, '____.json'), JSON.stringify({ bookSourceUrl: '明月书阁', ruleSearch: { bookList: '$.x' } }));
    fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify({ total: 482, unique: 482, categories: {} }));
    const hub = makeHub();
    const loaded = hub.loadDir(dir);
    assert.deepEqual(loaded.map((x) => x.id), ['____'], '真实源必须加载，汇总文件必须跳过');
    assert.equal(hub.sources.size(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#640 老 id（无指纹）已在库 ⇒ 再导同一份源仍判「重复」，不会多出一条', () => {
  const hub = makeHub();
  const A = {
    bookSourceUrl: 'https://八叉书库.luoyacheng.ip-ddns.com',
    bookSourceName: '🌈八叉书库',
    ruleSearch: { bookList: '$.x' },
  };
  // 老形态 id：库里已有（文件源 / imported-sources.json 的历史条目）
  const legacy = 'https_______.luoyacheng.ip-ddns.com';
  hub.importSource(A, { id: legacy });
  const p = hub.previewImport(JSON.stringify([A]));
  assert.equal(p.valid.length, 0, '不得再报「新增」');
  assert.equal(p.duplicates.length, 1, '应按源身份认出老条目 ⇒ 重复');
  assert.equal(p.duplicates[0]!.id, legacy, '沿用库里原 id，不改成带指纹的新 id');
  const r = hub.importRows(parseImportText(JSON.stringify([A])).rows);
  assert.deepEqual([r.inserted, r.skipped], [0, 1]);
  assert.equal(hub.sources.size(), 1);
});

/**
 * RSS 订阅源导入（用户实测）：显式选「Legado 书源」时以前只报「缺少 bookSourceUrl」，
 * 现在必须点名「这是 RSS 订阅源，请选择 RSS 订阅源或自动识别」；选对格式则正常解析。
 */
test('RSS 订阅源：显式选错格式要说清该选哪个，选对则能解析且分组走 sourceGroup', () => {
  const rss = [{ sourceUrl: 'https://r.example.com/feed', sourceName: '订阅A', ruleArticles: '//entry' }];
  assert.equal(detectImportFormat(rss), 'rss', '自动识别必须认成 rss（书源 detect 不带 bookSourceUrl）');

  const wrong = parseImportText(JSON.stringify(rss), { format: 'legado' });
  assert.equal(wrong.rows.length, 0);
  assert.match(wrong.errors[0]!.reason, /是 RSS 订阅源/);
  assert.match(wrong.errors[0]!.reason, /请选择「RSS 订阅源」或「自动识别」/);
  assert.match(wrong.hint ?? '', /更像「RSS 订阅源」/);

  const ok = parseImportText(JSON.stringify(rss), { format: 'rss', defaultGroup: '新闻' });
  assert.equal(ok.rows.length, 1);
  assert.equal(ok.rows[0]!.kind, 'rss');
  assert.equal(ok.rows[0]!.name, '订阅A');
  assert.equal(ok.rows[0]!.group, '新闻');
  assert.equal((ok.rows[0]!.raw as Record<string, unknown>)['sourceGroup'], '新闻', '默认分组要写进 RSS 引擎读的 sourceGroup');
  assert.equal(ok.hint, undefined, '选对格式时不得出现「格式不符」提示');
});
