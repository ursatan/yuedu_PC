/**
 * `D5` **书源导入的分片执行 + 失败聚合**（纯逻辑，便于单测）。
 *
 * ## 为什么要有这个模块
 * 源合集动辄上千条，一次 `hub.importRows(全部)` 是**同步长任务**：导入期间事件循环被占，
 * 前端拿不到任何进度（还会把别的接口一起拖住）。这里把它拆成**固定大小的片**，
 * 每片之间让出事件循环并回报 `{done,total,failed[],stage}` ⇒ 前端能画进度条。
 *
 * ## 为什么分片不会改变导入语义
 * `hub.importRows` 的判定（新增/覆盖/跳过）只取决于**同一批里已处理的行**；
 * 分片按**原始行下标升序**顺序处理，片与片之间串行 ⇒ 与一次性提交等价。
 *   · 有 `selectedRows` ⇒ 等价于 `onlyIndexes`：**选中的已存在源要覆盖** ⇒ 片内用 `overwrite`；
 *   · 无 `selectedRows` ⇒ 沿用调用方给的 `dedupe`（旧行为 `skip`）。
 * 同一份文本里同 id 的两行即使落在不同片，第二片仍能看到第一片的结果 ⇒ 行为一致。
 */

/** 只要求能定位一条源（`id` / `name`），与 `@yuedu/facade` 的导入行结构兼容 */
export interface ImportJobRow {
  id: string;
  name?: string;
}

/** `hub.importRows` 的单批返回（字段照抄 facade，避免重复定义） */
export interface ImportRowsBatch {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  results: Array<{ id: string; ok: boolean; name?: string; error?: string; action?: 'inserted' | 'updated' | 'skipped' }>;
}

/** 进度通道：`GET /api/sources/import/:jobId` 直接透出这部分 */
export interface ImportJobProgress {
  /** 已处理行数（含跳过/失败） */
  done: number;
  /** 本次要处理的总行数 */
  total: number;
  /** 失败的**原始行下标**（供前端「只重试失败行」二次提交） */
  failed: Array<{ index: number; id?: string; name?: string; error: string }>;
  stage: 'import' | 'persist' | 'done';
}

export interface ImportJobResult extends ImportJobProgress {
  inserted: number;
  updated: number;
  skipped: number;
  failedCount: number;
  /** 全部单行结果（路由据此把源逐个 remember / 落库） */
  results: ImportRowsBatch['results'];
}

export interface RunImportInChunksOptions<R extends ImportJobRow> {
  rows: readonly R[];
  /** 只处理这些原始行下标（不传 = 全量） */
  selectedRows?: readonly number[];
  dedupe?: 'skip' | 'overwrite';
  /** 每片行数（默认 100；单测可传小值） */
  chunkSize?: number;
  /** 真正的入库动作（路由传 `hub.importRows`） */
  importer: (rows: R[], opts: { dedupe: 'skip' | 'overwrite' }) => ImportRowsBatch;
  /** 片间让出事件循环（默认 `setImmediate`） */
  yieldFn?: () => Promise<void>;
  /** 进度回调（每片结束后调用一次） */
  onProgress?: (progress: ImportJobProgress) => void;
}

const DEFAULT_CHUNK_SIZE = 100;

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * 按片执行导入并聚合失败行。**同步 importer + 片间 await** ⇒ 事件循环能喘气。
 * 任何一片整体抛错时，把该片每一行都记成失败（不中断其余片）。
 */
export async function runImportInChunks<R extends ImportJobRow>(
  opts: RunImportInChunksOptions<R>,
): Promise<ImportJobResult> {
  const { rows, importer } = opts;
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const yieldFn = opts.yieldFn ?? defaultYield;

  // 与原 `onlyIndexes` 语义对齐：**按原始行下标升序**，去重并剔除越界值
  const selected = opts.selectedRows
    ? [...new Set(opts.selectedRows)]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length)
        .sort((a, b) => a - b)
    : null;
  const indexes = selected ?? rows.map((_, i) => i);
  const total = indexes.length;
  // 有勾选 ⇒ 选中即覆盖（与 `importRows` 的 `onlyIndexes` 分支一致）
  const dedupe: 'skip' | 'overwrite' = selected ? 'overwrite' : opts.dedupe ?? 'skip';

  const failed: ImportJobProgress['failed'] = [];
  const results: ImportRowsBatch['results'] = [];
  const sums = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  let done = 0;

  for (let start = 0; start < indexes.length; start += chunkSize) {
    const chunkIndexes = indexes.slice(start, start + chunkSize);
    const chunkRows = chunkIndexes.map((i) => rows[i]!);
    try {
      const batch = importer(chunkRows, { dedupe });
      sums.inserted += batch.inserted;
      sums.updated += batch.updated;
      sums.skipped += batch.skipped;
      sums.failed += batch.failed;
      batch.results.forEach((r, j) => {
        results.push(r);
        if (!r.ok) {
          failed.push({
            index: chunkIndexes[j]!,
            ...(r.id ? { id: r.id } : {}),
            ...(r.name ? { name: r.name } : {}),
            error: r.error ?? '导入失败',
          });
        }
      });
    } catch (e) {
      // 整片抛错（极端情况）：该片逐行记失败，其余片继续
      const msg = String(e instanceof Error ? e.message : e).slice(0, 160);
      sums.failed += chunkIndexes.length;
      for (const [j, index] of chunkIndexes.entries()) {
        const row = chunkRows[j];
        failed.push({
          index,
          ...(row?.id ? { id: row.id } : {}),
          ...(row?.name ? { name: row.name } : {}),
          error: msg,
        });
      }
    }
    done += chunkIndexes.length;
    opts.onProgress?.({ done, total, failed, stage: 'import' });
    await yieldFn();
  }

  return {
    done,
    total,
    failed,
    stage: 'done',
    inserted: sums.inserted,
    updated: sums.updated,
    skipped: sums.skipped,
    failedCount: sums.failed,
    results,
  };
}
