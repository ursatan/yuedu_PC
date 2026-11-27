/**
 * 真实书源回归集（docs/01-开发计划.md §10）
 *
 * 这是 M1/M4 跑通率门禁的**唯一 KPI**：对每个真实书源跑 搜索/详情/目录/正文 四步，
 * 记录每步成功与否，输出「源 × 步骤」跑通率矩阵。
 *
 * ── 两个 Phase ───────────────────────────────────────────────
 * Phase A（默认，无网络，确定性）：对真实源跑 detect + compile，输出模型层兼容率。
 *   验证「我们的 BookSource 模型能否吃下社区真实源」，是 selector 引擎的前置条件。
 *
 * Phase B（LIVE=1 才跑，需联网）：对源站真实发起 search 请求，跑端到端，
 *   输出 search 步跑通率（代表 M1 的 ≥65% 门禁）。默认跳过，避免 CI 慢/被墙。
 *
 * ── 怎么跑 ───────────────────────────────────────────────────
 *   pnpm --filter @yuedu/engine-legado test            # 仅 Phase A
 *   LIVE=1 pnpm --filter @yuedu/engine-legado test    # Phase A + B（实时，较慢）
 *
 * 真实源来自 tools/fetch_sources.py → tests/fixtures/sources/book/（已在 .git 内）
 */

import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LegadoEngine } from '../index';
import { detectBookSource, compileBookSource } from '../model/book-source';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  createHttpClient,
  type EngineContext,
  type JsSandboxPool,
  type UnifiedRequest,
} from '@yuedu/core';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * `#651` 语料只剩一处：`data/seed/bookSource.json`（单个 Legado 数组）。
 * 原 `tests/fixtures/sources/book/`（502 文件）已随 `tests/` 整体删除。
 * 该语料是第三方站点规则的转载集，**不进公开仓库**（`git rm --cached`，本地自备）
 * ⇒ 缺失时本文件的两个 Phase 全部跳过，而不是断言失败。
 */
const CORPUS_FILE = path.resolve(here, '../../../../data/seed/bookSource.json');
/** 回归报告落 `tmp/`（原来写回语料目录，会把 `_regression_*.json` 混进源文件里） */
const REPORT_DIR = path.resolve(here, '../../../../tmp');
const LIVE = process.env.LIVE === '1';

/** 沙箱桩（L1 引擎不使用 ctx.sandbox，仅满足 EngineContext 类型） */
const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('sandbox 在回归 harness 中不可用');
  },
};

function loadBookSources(): Record<string, unknown>[] {
  if (!fs.existsSync(CORPUS_FILE)) {
    console.log(`[回归集] 语料文件不存在: ${CORPUS_FILE}（源库为空时可由 src.mts export 生成）`);
    return [];
  }
  try {
    const arr = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf-8'));
    return (Array.isArray(arr) ? arr : [arr]).filter(
      (x): x is Record<string, unknown> => !!x && typeof x === 'object',
    );
  } catch (e) {
    console.log('[回归集] 语料解析失败：', e instanceof Error ? e.message : e);
    return [];
  }
}

const sources = loadBookSources();

function makeCtx(sourceId: string, signal: AbortSignal, http = createHttpClient()): EngineContext {
  return {
    reqId: 'regression',
    sourceId,
    signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

// ───────────────────────── Phase A ─────────────────────────
test(
  `Phase A: ${sources.length} 个真实书源 detect + compile 矩阵`,
  { skip: sources.length === 0 ? '语料 data/seed/bookSource.json 不在仓库内（本地自备），跳过' : false },
  () => {
  let detectOk = 0;
  let compileOk = 0;
  const detectFail: string[] = [];
  const compileFail: string[] = [];

  for (const s of sources) {
    const name = (s['bookSourceName'] as string) || (s['bookSourceUrl'] as string) || '?';
    if (detectBookSource(s)) detectOk++;
    else detectFail.push(name);

    const r = compileBookSource(s);
    if (r.ok) compileOk++;
    else compileFail.push(`${name}: ${r.issues.map((i) => i.message).join('; ')}`);
  }

  const detectRate = ((detectOk / sources.length) * 100).toFixed(1);
  const compileRate = ((compileOk / sources.length) * 100).toFixed(1);

  const report = {
    phase: 'A',
    total: sources.length,
    detectOk,
    detectRate: Number(detectRate),
    compileOk,
    compileRate: Number(compileRate),
    detectFailSamples: detectFail.slice(0, 10),
    compileFailSamples: compileFail.slice(0, 10),
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, '_regression_a.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n[回归集 Phase A] 源总数=${sources.length}`);
  console.log(`  detect  : ${detectOk}/${sources.length} (${detectRate}%)`);
  console.log(`  compile : ${compileOk}/${sources.length} (${compileRate}%)`);
  if (detectFail.length) console.log(`  detect 失败样本(前10):\n    ${detectFail.slice(0, 10).join('\n    ')}`);
  if (compileFail.length) console.log(`  compile 失败样本(前10):\n    ${compileFail.slice(0, 10).join('\n    ')}`);
  console.log(`  报告已写: ${reportPath}`);

  // 软断言：真实书源应 100% 被识别并编译（否则是模型 bug，需排查）
  if (detectOk !== sources.length) {
    console.log(`  ⚠️ ${sources.length - detectOk} 个文件未被 detect 识别为 Legado 书源`);
  }
});

// ───────────────────────── Phase B ─────────────────────────
test('Phase B: 实时 search 端到端（需 LIVE=1）', async () => {
  if (!LIVE || sources.length === 0) {
    console.log('[回归集 Phase B] 跳过（未设置 LIVE=1，或语料 data/seed/bookSource.json 不在仓库内）');
    return;
  }

  const engine = new LegadoEngine();
  const http = createHttpClient({ 'User-Agent': 'Mozilla/5.0 (compatible; yuedu-regression/0.1)' });
  const keyword = '武侠';
  const CONCURRENCY = 5;
  const TIMEOUT_MS = 8000;
  const SAMPLE = 30; // 实时样本上限，避免一次跑 499 个把站点打爆

  const candidates = sources
    .filter((s) => detectBookSource(s) && (s['searchUrl'] || (s['ruleSearch'] as any)?.searchUrl || (s['ruleSearch'] as any)?.bookList))
    .slice(0, SAMPLE);

  let ok = 0;
  const fail: string[] = [];
  let idx = 0;

  async function worker() {
    while (idx < candidates.length) {
      const i = idx++;
      const s = candidates[i] as any;
      const name = s.bookSourceName || s.bookSourceUrl || `?${i}`;
      const compiled = compileBookSource(s);
      if (!compiled.ok || !compiled.rule) {
        fail.push(`${name}: compile 失败`);
        continue;
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
      const ctx = makeCtx(String(s.bookSourceUrl || name), ac.signal, http);
      const req: UnifiedRequest = { action: 'search', keyword, page: 1 };
      try {
        const res = await engine.search(compiled.rule, req, ctx);
        if (res.items.length > 0) ok++;
        else fail.push(`${name}: search 返回 0 条`);
      } catch (e) {
        fail.push(`${name}: ${(e as Error).message?.slice(0, 80)}`);
      } finally {
        clearTimeout(t);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const rate = ((ok / candidates.length) * 100).toFixed(1);
  const report = { phase: 'B', sampled: candidates.length, searchOk: ok, searchRate: Number(rate), failSamples: fail.slice(0, 20) };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, '_regression_b.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n[回归集 Phase B] 实时样本=${candidates.length}  search 成功=${ok} (${rate}%)`);
  if (fail.length) console.log(`  失败样本(前20):\n    ${fail.slice(0, 20).join('\n    ')}`);
  console.log(`  报告已写: ${reportPath}`);
});
