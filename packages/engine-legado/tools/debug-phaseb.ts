/**
 * Phase B 调试脚本：复刻回归 harness 的采样与并发，
 * 但打印每个失败的【原始错误】(EngineError.detail.input) + searchUrl，
 * 用于定位 RULE_PARSE 背后的真实规则兼容缺口。
 *
 * 运行：cd packages/engine-legado && npx tsx tools/debug-phaseb.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LegadoEngine } from '../src/index';
import { detectBookSource, compileBookSource } from '../src/model/book-source';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  createHttpClient,
  EngineError,
  type EngineContext,
  type JsSandboxPool,
  type UnifiedRequest,
} from '@yuedu/core';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * `#651` 语料只剩一处：`data/seed/bookSource.json`（单数组）。
 * 原 `tests/fixtures/sources/{book,book-482,book-1262}/` 已随 `tests/` 整体删除。
 * 用法：npx tsx tools/debug-phaseb.ts [offset] [count]
 */
const CORPUS_FILE = path.resolve(here, '../../../data/seed/bookSource.json');
const OFFSET = Number(process.argv[2] ?? 0);
const COUNT = Number(process.argv[3] ?? 30);

const noopSandbox: JsSandboxPool = { async eval() { throw new Error('no sandbox'); } };

function makeCtx(sourceId: string, signal: AbortSignal, http: ReturnType<typeof createHttpClient>): EngineContext {
  return {
    reqId: `${sourceId}@${Date.now()}`,
    sourceId,
    signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

const raws: Record<string, unknown>[] = (() => {
  const arr = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf-8'));
  return (Array.isArray(arr) ? arr : [arr]).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object',
  );
})();

const candidates = raws
  .filter((s) => detectBookSource(s) && (s['searchUrl'] || (s['ruleSearch'] as any)?.searchUrl || (s['ruleSearch'] as any)?.bookList))
  .slice(OFFSET, OFFSET + COUNT);

const engine = new LegadoEngine();
const http = createHttpClient({ 'User-Agent': 'Mozilla/5.0 (compatible; yuedu-regression/0.1)' });
const keyword = '武侠';
let idx = 0;
const lines: string[] = [];

async function worker() {
  while (idx < candidates.length) {
    const i = idx++;
    const s = candidates[i] as any;
    const name = String(s.bookSourceName || s.bookSourceUrl || `?${i}`);
    const compiled = compileBookSource(s);
    if (!compiled.ok || !compiled.rule) { lines.push(`[compile] ${name}`); continue; }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const ctx = makeCtx(String(s.bookSourceUrl || name), ac.signal, http);
    const req: UnifiedRequest = { action: 'search', keyword, page: 1 };
    try {
      const res = await engine.search(compiled.rule, req, ctx);
      lines.push(`[OK ${res.items.length}条] ${name}`);
    } catch (e) {
      const orig = e instanceof EngineError ? String(e.detail?.input ?? '') : String(e instanceof Error ? e.message : e);
      const su = String((s as any).searchUrl ?? (s as any).ruleSearch?.searchUrl ?? '').slice(0, 90).replace(/\s+/g, ' ');
      lines.push(`[FAIL] ${name}\n  err: ${orig.slice(0, 160)}\n  searchUrl: ${su}`);
    } finally {
      clearTimeout(t);
    }
  }
}

await Promise.all(Array.from({ length: 5 }, () => worker()));
console.log(lines.join('\n'));
