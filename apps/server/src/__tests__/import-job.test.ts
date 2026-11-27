/**
 * `D5` 书源导入的**分片执行 + 失败聚合**（纯逻辑单测）。
 *
 * 线的行为（不 mock 网络）：`POST /api/sources/import` 返回 jobId，前端轮询
 * `{done,total,failed[],stage}` 画进度条。这里锁分片/聚合两层：
 *  ① 行被按 `chunkSize` 切片（片间让出事件循环），`done` 单调递增到 `total`；
 *  ② 失败行带**原始行下标**（前端「重试失败行」要按它二次提交）；
 *  ③ 选中导入 ⇒ 片内按 `overwrite`（与 `importRows(onlyIndexes)` 的「选中即覆盖」一致）；
 *  ④ 整片抛错不中断其余片。
 *
 * 运行：`pnpm --filter @yuedu/server test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runImportInChunks, type ImportJobRow, type ImportRowsBatch } from '../import-job';

interface Row extends ImportJobRow {
  i: number;
}

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `源${i}`, i }));
}

/** 假 importer：按 id 尾数决定结果；记录每次收到的行 */
function makeImporter(failOn: (row: Row) => string | null, calls: Array<{ ids: string[]; dedupe: string }> = []) {
  return (chunk: Row[], opts: { dedupe: 'skip' | 'overwrite' }): ImportRowsBatch => {
    calls.push({ ids: chunk.map((r) => r.id), dedupe: opts.dedupe });
    const batch: ImportRowsBatch = { inserted: 0, updated: 0, skipped: 0, failed: 0, results: [] };
    for (const row of chunk) {
      const err = failOn(row);
      if (err) {
        batch.failed += 1;
        batch.results.push({ id: row.id, ok: false, name: row.name, error: err });
      } else if (row.i % 2 === 0) {
        batch.inserted += 1;
        batch.results.push({ id: row.id, ok: true, name: row.name, action: 'inserted' });
      } else {
        batch.skipped += 1;
        batch.results.push({ id: row.id, ok: true, name: row.name, action: 'skipped' });
      }
    }
    return batch;
  };
}

test('D5 ①: 按 chunkSize 切片，done 递增到 total，结果聚合正确', async () => {
  const calls: Array<{ ids: string[]; dedupe: string }> = [];
  const progress: Array<{ done: number; total: number; failedLen: number }> = [];
  const importer = makeImporter((r) => (r.i === 3 || r.i === 7 ? '源规则缺失' : null), calls);

  const out = await runImportInChunks({
    rows: rows(10),
    chunkSize: 3,
    importer,
    yieldFn: async () => {},
    onProgress: (p) => progress.push({ done: p.done, total: p.total, failedLen: p.failed.length }),
  });

  assert.deepEqual(calls.map((c) => c.ids.length), [3, 3, 3, 1], '10 行 / 每片 3 ⇒ 4 片');
  assert.deepEqual(calls.map((c) => c.dedupe), ['skip', 'skip', 'skip', 'skip'], '无勾选 ⇒ 沿用 dedupe（默认 skip）');
  assert.deepEqual(progress.map((p) => p.done), [3, 6, 9, 10], 'done 必须单调到 total');
  assert.equal(out.done, 10);
  assert.equal(out.total, 10);
  assert.equal(out.inserted, 5);
  assert.equal(out.skipped, 3);
  assert.equal(out.failedCount, 2);
  assert.deepEqual(
    out.failed.map((f) => [f.index, f.id, f.error]),
    [
      [3, 's3', '源规则缺失'],
      [7, 's7', '源规则缺失'],
    ],
    '失败行必须带原始行下标（供前端只重试失败行）',
  );
  assert.equal(out.results.length, 10, '每行都应有单行结果');
});

test('D5 ②: 选中导入 ⇒ 片内 overwrite，且按下标升序切片', async () => {
  const calls: Array<{ ids: string[]; dedupe: string }> = [];
  const out = await runImportInChunks({
    rows: rows(6),
    selectedRows: [4, 1, 4, 99, -1], // 乱序 + 重复 + 越界
    chunkSize: 2,
    importer: makeImporter(() => null, calls),
    yieldFn: async () => {},
  });

  assert.deepEqual(calls.map((c) => c.ids), [['s1', 's4']], '去重/排序/剔除越界后只剩 1、4');
  assert.deepEqual(calls.map((c) => c.dedupe), ['overwrite'], '选中即覆盖（与 importRows(onlyIndexes) 一致）');
  assert.equal(out.total, 2);
  assert.equal(out.done, 2);
  assert.equal(out.failedCount, 0);
});

test('D5 ③: 整片 importer 抛错 ⇒ 该片逐行记失败，其余片继续', async () => {
  const progress: number[] = [];
  const out = await runImportInChunks({
    rows: rows(6),
    chunkSize: 2,
    importer: (chunk) => {
      if (chunk[0]!.i === 2) throw new Error('磁盘写入失败');
      return {
        inserted: chunk.length, updated: 0, skipped: 0, failed: 0,
        results: chunk.map((r) => ({ id: r.id, ok: true, action: 'inserted' as const })),
      };
    },
    yieldFn: async () => {},
    onProgress: (p) => progress.push(p.done),
  });

  assert.deepEqual(progress, [2, 4, 6], '抛错片也要推进 done（不能卡死进度条）');
  assert.equal(out.failedCount, 2, '抛错片的 2 行都记失败');
  assert.deepEqual(out.failed.map((f) => f.index), [2, 3]);
  assert.match(out.failed[0]!.error, /磁盘写入失败/);
  assert.equal(out.inserted, 4, '其余片照常入库');
});
