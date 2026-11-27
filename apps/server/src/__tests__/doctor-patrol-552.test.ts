/**
 * `#552` 离线巡检调度的回归锁。
 *
 * 钉的是「**静默**」这一类失败 —— 巡检这类后台任务最坏的形态不是报错，
 * 是**永远什么都不报**（用户以为它在工作，其实每轮都被当成首轮）。
 *  · 首轮不播报（核心判据）但**必须落盘** ⇒ 否则每次重启都是首轮 ⇒ **永久不播报**；
 *  · 无变化的轮次不弹，但**必须留日志**（`log` 断言）⇒ 否则「跑没跑」不可知；
 *  · 重入 / since 游标 / 关闭开关都要有明确行为，不能是「看起来没事」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoctorPatrol, patrolEnabled, PATROL_FILE, type DoctorPatrolDeps } from '../doctor-patrol';
import type { ValidationIssue } from '@yuedu/core';

type Row = { id: string; name?: string; kind: string; raw: Record<string, unknown>; issues: ValidationIssue[] };

function deps(rows: () => Row[], opts: { dir?: string; chunk?: number } = {}): DoctorPatrolDeps & { logs: string[]; clock: { t: number } } {
  const logs: string[] = [];
  const clock = { t: 1_700_000_000_000 };
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'patrol-'));
  return {
    collect: () => rows(),
    dataDir: dir,
    log: (m) => logs.push(m),
    now: () => (clock.t += 10),
    ...(opts.chunk ? { chunk: opts.chunk } : {}),
    logs,
    clock,
  };
}

/**
 * 一个 **error 级** lint 缺陷的源。
 *
 * ⚠️ 造数必须用 lint 真的会判的形态 —— 实测（`#552`）：
 *  · `jsLib` 里的解构箭头/语法错 **不报**（`#542` 的纪律：只判「整串就是 JS」的
 *    `<js>…</js>` / 整字段 `@js:`，jsLib 不在其列）；
 *  · `ruleToc.chapterList: '<js>a\u200bb</js>'`（零宽字符）⇒ **L002 + L008 error** ✓
 *  · `ruleToc.chapterList: '@js:((("'` ⇒ **L008 error** ✓
 * 用 jsLib 造数会得到 0 条 error —— 那是**造数错了**，不是巡检坏了（我第一版就栽在这）。
 */
const bad = (id: string, name = `源-${id}`): Row => ({
  id,
  name,
  kind: 'legado',
  raw: { bookSourceUrl: `https://${id}.com`, ruleToc: { chapterList: '<js>a​b</js>' } },
  issues: [],
});
/** 结构校验 error（离线 `engine.validate` 那一路）—— 与 lint 的码要能区分（STRUCT: 前缀） */
const badStruct = (id: string, path = 'bookSourceUrl'): Row => ({
  id,
  name: `源-${id}`,
  kind: 'legado',
  raw: { bookSourceName: id },
  issues: [{ level: 'error', path, message: '源地址为空' }],
});
const good = (id: string, name = `源-${id}`): Row => ({
  id,
  name,
  kind: 'legado',
  raw: { bookSourceUrl: `https://${id}.com`, ruleToc: { chapterList: '.chapter' } },
  issues: [],
});

test('① 首轮：建基线 + 落盘 + 不播报（36 个存量不能当新发现弹出去）', async () => {
  const d = deps(() => [bad('a'), bad('b'), good('c')]);
  const p = createDoctorPatrol(d);
  const snap = await p.run();
  assert.ok(snap);
  assert.equal(snap.sources, 3);
  assert.equal(snap.issues.length, 2, 'a/b 是 error 级');
  const v = p.view();
  assert.equal(v.snapshot?.issues.length, 2);
  assert.equal(v.delta?.baseline, true);
  assert.equal(v.toast, null, '首轮不弹');
  assert.ok(existsSync(join(d.dataDir, PATROL_FILE)), '基线必须落盘（否则重启后又变首轮）');
  assert.ok(
    d.logs.some((l) => l.includes('首轮建基线') && l.includes('不播报')),
    `不弹的轮次也必须留日志，实际：${JSON.stringify(d.logs)}`,
  );
});

test('② ★ 跨重启：新实例从磁盘读回基线 ⇒ 第二轮不是首轮，新增才会被报', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
  const p1 = createDoctorPatrol(deps(() => [bad('a')], { dir }));
  await p1.run(); // 首轮：a 是存量
  assert.equal(p1.view().delta?.baseline, true);

  // 模拟重启：全新实例、同一 dataDir
  const d2 = deps(() => [bad('a'), bad('b')], { dir }); // b 是新坏的
  const p2 = createDoctorPatrol(d2);
  await p2.run();
  const v = p2.view();
  assert.equal(v.delta?.baseline, false, '★ 读回基线后就不是首轮了（否则永远不播报）');
  assert.deepEqual(
    v.delta?.added.map((i) => i.id),
    ['b'],
    '只报新增的 b，存量的 a 不重复报',
  );
  assert.match(v.toast?.text ?? '', /1 个源规则异常/);
  assert.equal(v.toast?.level, 'warn');
});

test('③ 恢复：error 全没了 ⇒ toast 为 ok（修好了要给正反馈）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
  await createDoctorPatrol(deps(() => [bad('a')], { dir })).run();
  const d2 = deps(() => [good('a')], { dir });
  const p2 = createDoctorPatrol(d2);
  await p2.run();
  const v = p2.view(); // ⚠️ 必须复用同一个实例：新建实例会从磁盘读「刚存的那轮」当基线 ⇒ delta 为空
  assert.deepEqual((v.delta?.fixed ?? []), ['a']);
  assert.equal(v.toast?.level, 'ok');
  assert.match(v.toast?.text ?? '', /已修复/);
});

test('④ 反例：一轮都没变化 ⇒ 不弹，但仍要留日志（可观测）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
  await createDoctorPatrol(deps(() => [bad('a')], { dir })).run();
  const d2 = deps(() => [bad('a')], { dir });
  const p2 = createDoctorPatrol(d2);
  await p2.run();
  const v = p2.view();
  assert.deepEqual(v.delta?.added, []);
  assert.deepEqual(v.delta?.persisted, ['a']);
  assert.equal(v.toast, null, '没有变化就不该打扰用户');
  assert.ok(
    d2.logs.some((l) => l.includes('巡检 #1')),
    '跑过了必须留痕',
  );
});

test('⑤ since 游标：已消费过就不再给 toast（否则每 5 分钟弹同一条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
  await createDoctorPatrol(deps(() => [bad('a')], { dir })).run();
  const d2 = deps(() => [bad('a'), bad('b')], { dir });
  const p2 = createDoctorPatrol(d2);
  await p2.run();
  const at = p2.view().at!;
  assert.equal(p2.view().fresh, true);
  assert.ok(p2.view().toast, '首次消费要有 toast');
  assert.equal(p2.view(at).fresh, false, 'since == at ⇒ 已消费');
  assert.equal(p2.view(at).toast, null);
  assert.equal(p2.view(at + 1).fresh, false);
});

test('⑥ 重入：并发 run 共享同一轮（后来者拿**本轮**结果，不是 null/旧快照）', async () => {
  const d = deps(() => [bad('a')], { chunk: 1 });
  const p = createDoctorPatrol(d);
  const [s1, s2, s3] = await Promise.all([p.run(), p.run(), p.run()]);
  assert.ok(s1 && s2 && s3, '并发调用都得拿到本轮快照（返回 null/旧值会让调用方误判「没问题」）');
  assert.equal(s1, s2);
  assert.equal(s2, s3);
  assert.equal(p.view().runs, 1, 'runs 只该 +1（只跑了一次）');
});

test('⑦ 分片：chunk=1 时结果仍完整（让出事件循环不能吃掉数据）', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => (i % 2 ? bad(`b${i}`) : good(`g${i}`)));
  const d = deps(() => rows, { chunk: 1 });
  const p = createDoctorPatrol(d);
  const snap = await p.run();
  assert.equal(snap?.sources, 40);
  assert.equal(snap?.issues.length, 20, '20 个坏源一个都不能少');
});

test('⑧ 关闭开关：start 不排期，且 view 显式带 disabled（别让「没数据」看起来像坏了）', async () => {
  const before = process.env['YUEDU_DOCTOR_PATROL'];
  process.env['YUEDU_DOCTOR_PATROL'] = '0';
  try {
    assert.equal(patrolEnabled(), false);
    const d = deps(() => [bad('a')]);
    const p = createDoctorPatrol(d);
    const h = p.start();
    h.stop();
    assert.equal(p.view().disabled, true);
    assert.equal(p.view().running, false);
    assert.ok(d.logs.some((l) => l.includes('已关闭')), '关了也要说一声');
  } finally {
    if (before === undefined) delete process.env['YUEDU_DOCTOR_PATROL'];
    else process.env['YUEDU_DOCTOR_PATROL'] = before;
  }
});

test('⑨ 结构校验的 error 也进播报（码带 STRUCT: 前缀，与 lint 的 L00x 区分）', async () => {
  const d = deps(() => [badStruct('s1')]);
  const p = createDoctorPatrol(d);
  const snap = await p.run();
  assert.equal(snap?.issues.length, 1);
  assert.ok(snap?.issues[0]?.codes.some((c) => c.startsWith('STRUCT:bookSourceUrl')), '结构缺陷码要能一眼区分来源');
});

test('⑩ 坏基线文件 ⇒ 当没有基线重建，不炸（形态校验兜底）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, PATROL_FILE), '{ 这不是快照', 'utf-8');
  const d = deps(() => [bad('a')], { dir });
  const p = createDoctorPatrol(d);
  const snap = await p.run();
  assert.ok(snap, '坏文件不能让巡检整体失败');
  assert.equal(p.view().delta?.baseline, true, '坏文件 ⇒ 退化成首轮（安全侧）');
  rmSync(dir, { recursive: true, force: true });
});
