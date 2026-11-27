/**
 * `#651` 源库回归锁：**单一存储**（`data/yuedu.db` 的 `sources` / `sources_trash`）。
 *
 * 锁的都是本轮真实翻过的车：
 *  · 同一 `bookSourceUrl` 被存成两条（速读谷 / 📚木里聚合）—— 现在由 `identity` 唯一索引挡住；
 *  · 删除后「raw 一起丢」—— 现在整行搬进回收站，`restore` 必须原样回来；
 *  · 迁移时「文件源 vs 覆盖层」谁赢 —— 书架 `books.origin` 引用文件源 id，所以文件源必须赢；
 *  · 坏行不能拖垮整库加载 —— 跳过并计数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SourceDb } from '@yuedu/core';
import { SourceDbLayer } from '../source-db';
import type { EngineHub } from '@yuedu/facade';
import { migrateLegacySources } from '../source-migrate';

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `yuedu-src-${tag}-`));
}

function open(dir: string): SourceDb {
  return SourceDb.open({ file: path.join(dir, 'sources.db') }).db;
}

const src = (url: string, name: string) => ({ bookSourceUrl: url, bookSourceName: name, ruleSearch: { bookList: '.x' } });

test('① 写读：id 与 identity 两个入口都能取到同一行', () => {
  const db = open(tmpDir('crud'));
  db.upsert({ id: 'a1', raw: src('https://a.com', '甲') });
  assert.equal(db.count(), 1);
  assert.equal(db.get('a1')?.name, '甲');
  assert.equal(db.getByIdentity('https://a.com')?.id, 'a1');
  db.close();
});

test('② 同一 bookSourceUrl 不能再存第二个 id（唯一性由库强约束）', () => {
  const db = open(tmpDir('dup'));
  db.upsert({ id: 'a1', raw: src('https://a.com', '甲') });
  assert.throws(
    () => db.upsert({ id: 'a1_', raw: src('https://a.com', '甲副本') }),
    /源身份冲突/,
    '同身份换 id 必须报错，否则又会出现「同源两条」',
  );
  // 同一个 id 覆盖是允许的（编辑规则）
  db.upsert({ id: 'a1', raw: src('https://a.com', '甲改名') });
  assert.equal(db.count(), 1);
  assert.equal(db.get('a1')?.name, '甲改名');
  db.close();
});

test('③ 没有身份字段的源（空 identity）可以多条共存', () => {
  const db = open(tmpDir('empty'));
  db.upsert({ id: 'n1', raw: { foo: 1 } });
  db.upsert({ id: 'n2', raw: { foo: 2 } });
  assert.equal(db.count(), 2, '两条空身份互不冲突（部分唯一索引 WHERE identity <> ""）');
  db.close();
});

test('④ 开关只改三列，不重写 raw；未给的字段保持原值', () => {
  const db = open(tmpDir('state'));
  db.upsert({ id: 'a1', raw: src('https://a.com', '甲'), state: { enabled: true, searchEnabled: true, exploreEnabled: false } });
  assert.equal(db.setState('a1', { enabled: false }), true);
  const row = db.get('a1')!;
  assert.deepEqual(row.state, { enabled: false, searchEnabled: true, exploreEnabled: false });
  assert.equal(row.name, '甲', 'raw 未被改动');
  db.close();
});

test('⑤ 删除 → 回收站（带 raw）→ 恢复 → 永久删除', () => {
  const db = open(tmpDir('trash'));
  db.upsert({ id: 'a1', raw: src('https://a.com', '甲') });
  const row = db.get('a1')!;

  db.moveToTrash(row);
  assert.equal(db.count(), 0);
  const t = db.trashList();
  assert.equal(t.length, 1);
  assert.equal(t[0]!.id, 'a1');
  assert.deepEqual(t[0]!.raw, row.raw, '回收站必须带完整 raw（否则恢复不了）');

  // 恢复 = 从回收站搬回正表
  db.upsert({ id: t[0]!.id, raw: t[0]!.raw, kind: t[0]!.kind });
  db.dropTrash('a1');
  assert.equal(db.count(), 1);
  assert.equal(db.trashList().length, 0);

  // 永久删除
  db.moveToTrash(db.get('a1')!);
  assert.equal(db.purgeAll(), 1);
  assert.equal(db.trashList().length, 0);
  db.close();
});

test('⑥ 导出是 Legado 兼容的 JSON 数组', () => {
  const db = open(tmpDir('export'));
  db.upsert({ id: 'a1', raw: src('https://a.com', '甲') });
  db.upsert({ id: 'b1', raw: src('https://b.com', '乙') });
  const arr = JSON.parse(db.exportJson()) as Array<{ bookSourceUrl: string }>;
  assert.equal(arr.length, 2);
  assert.ok(arr.every((x) => typeof x.bookSourceUrl === 'string'), '导出的是 raw 数组（与上游 Backup.kt 同形）');
  db.close();
});

test('⑦ 坏行（raw 不是合法 JSON）跳过并计数，不拖垮整库', () => {
  const dir = tmpDir('broken');
  const file = path.join(dir, 'sources.db');
  const db = SourceDb.open({ file }).db;
  db.upsert({ id: 'ok1', raw: src('https://ok.com', '好') });
  db.close();

  // 绕过 API 直接塞一行坏 raw（模拟磁盘损坏 / 外部工具写坏）
  const raw = new DatabaseSync(file);
  raw.prepare('INSERT INTO sources(id, identity, name, kind, raw) VALUES(?,?,?,?,?)').run('bad', '', '坏', 'legado', '{not json');
  raw.close();

  const db2 = SourceDb.open({ file }).db;
  const { rows, broken } = db2.loadWithStats();
  assert.equal(rows.length, 1);
  assert.equal(broken, 1, '坏行必须被看见（静默少几条最坑）');
  db2.close();
});

test('⑧ 迁移：同一 identity 以目录源为准（书架引用的是它的 id），覆盖层那条合并掉', () => {
  const dir = tmpDir('migrate');
  const bookDir = path.join(dir, 'book-482');
  fs.mkdirSync(bookDir, { recursive: true });
  // 目录源：id = 文件名
  fs.writeFileSync(path.join(bookDir, 'https___www.shudugu.org.json'), JSON.stringify(src('https://www.shudugu.org', '速读谷')));
  fs.writeFileSync(path.join(bookDir, 'other.json'), JSON.stringify(src('https://other.com', '别的')));
  // 汇总文件（没有书源身份）：必须按坏文件跳过
  fs.writeFileSync(path.join(bookDir, '_index.json'), JSON.stringify({ total: 2, unique: 2 }));

  const overlay = path.join(dir, 'imported-sources.json');
  fs.writeFileSync(
    overlay,
    JSON.stringify({
      version: 1,
      sources: [
        // 与目录源同 identity、不同 id —— 就是用户实测的「同源两条」
        { id: 'https___www.shudugu.org_', kind: 'legado', name: '速读谷', raw: src('https://www.shudugu.org', '速读谷') },
        { id: 'user-1', kind: 'legado', name: '只有我导入的', raw: src('https://user-only.com', '只有我导入的') },
      ],
      states: { 'https___www.shudugu.org': { enabled: false, searchEnabled: true, exploreEnabled: true } },
      trash: [{ id: 'gone', name: '删掉的', kind: 'legado', raw: src('https://gone.com', '删掉的'), deletedAt: 123, fileBacked: false }],
      removed: [],
    }),
  );

  const db = open(dir);
  const res = migrateLegacySources({ db, dirs: [bookDir], overlayFile: overlay });
  assert.equal(res.files, 2);
  assert.equal(res.overlay, 2);
  assert.equal(res.merged, 1, '速读谷同身份被合并一条');
  assert.equal(db.count(), 3, '速读谷 + 别的 + 只有我导入的');
  assert.equal(db.get('https___www.shudugu.org')?.name, '速读谷');
  assert.equal(db.get('https___www.shudugu.org_'), undefined, '覆盖层那份被合并掉');
  assert.equal(db.get('https___www.shudugu.org')?.state.enabled, false, '覆盖层里的开关要跟着搬过来');
  assert.equal(db.trashList().length, 1);

  // 幂等：再跑一次什么都不做
  const again = migrateLegacySources({ db, dirs: [bookDir], overlayFile: overlay });
  assert.equal(again.skipped, true);
  assert.equal(db.count(), 3);
  db.close();
});

test('⑨ 落盘层：remember 排队 → persist 一次事务；forget 进回收站；restore 回 hub', () => {
  const dir = tmpDir('layer');
  const db = open(dir);
  // 最小假 hub（本层只用到 sources.has/get 与 importSource）
  const sources = new Map<string, { id: string; kind: string; name?: string; raw: unknown; state: { enabled: boolean; searchEnabled: boolean; exploreEnabled: boolean }; addedAt: number }>();
  const hub = {
    sources,
    importSource(raw: unknown, opts: { id: string; preferred?: string; state?: unknown; name?: string }) {
      const rec = raw as Record<string, unknown>;
      const name = opts.name ?? String(rec['bookSourceName'] ?? opts.id);
      sources.set(opts.id, {
        id: opts.id,
        kind: opts.preferred ?? 'legado',
        name,
        raw,
        state: { enabled: true, searchEnabled: true, exploreEnabled: true },
        addedAt: Date.now(),
      });
      return { id: opts.id, kind: 'legado', name };
    },
  } as unknown as EngineHub;

  const layer = new SourceDbLayer(db, hub);
  hub.importSource(src('https://a.com', '甲'), { id: 'a1' });
  layer.remember('a1');
  layer.persist();
  assert.equal(db.count(), 1);

  const snap = { kind: 'legado', name: '甲', raw: src('https://a.com', '甲') };
  sources.delete('a1');
  layer.forget('a1', snap);
  assert.equal(db.count(), 0);
  assert.equal(layer.trashList().length, 1);
  assert.equal(layer.trashList()[0]!.fileBacked, false, '库里没有「文件源」这个概念了');

  assert.equal(layer.restoreSome(['a1']), 1);
  assert.equal(sources.has('a1'), true, '恢复要真的回到 hub');
  assert.equal(db.count(), 1, '恢复要真的回到库');
  assert.equal(layer.trashList().length, 0);

  layer.purgeSome(layer.removedIds());
  db.close();
});

/**
 * `#757` E：源库连接必须是 **WAL + synchronous=NORMAL**。
 *
 * 判据来源（实测 `data/yuedu.db` 副本、F 盘、100 次单行 UPDATE）：
 * FULL（默认）p50 17.1ms、p90 25.7ms；NORMAL p50 0.31ms ——「点一下源开关 = 主线程停 17ms」。
 * `synchronous` 是**连接级**设置，外部另开连接查不到 ⇒ 用 `SourceDb.pragma()` 钉住。
 */
test('⑩ 源库连接使用 WAL + synchronous=NORMAL（单行开关更新不再每次 fsync）', () => {
  const db = open(tmpDir('pragma'));
  assert.equal(db.pragma('journal_mode').toLowerCase(), 'wal');
  assert.equal(db.pragma('synchronous'), '1', '1=NORMAL；若变回 2(FULL) 则单行写又回到 17ms 级');
  db.close();
});
