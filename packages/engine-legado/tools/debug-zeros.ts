/**
 * 0条源诊断：跑 search，对「返回 0 条」的源输出
 * 最终 URL / 状态码 / 响应前 300 字符 / bookList + name 规则，便于逐源适配。
 * 运行：cd packages/engine-legado && npx tsx tools/debug-zeros.ts [名称关键词...]
 * 不带参数 = 跑全部采样源里的 0 条源。
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
  type EngineContext,
  type JsSandboxPool,
  type UnifiedRequest,
} from '@yuedu/core';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `#651` 语料只剩 `data/seed/bookSource.json`（原 `tests/` 已整体删除） */
const CORPUS_FILE = path.resolve(here, '../../../data/seed/bookSource.json');
const filterWords = process.argv.slice(2);

const noopSandbox: JsSandboxPool = { async eval() { throw new Error('no'); } };

const raws: Array<{ raw: Record<string, unknown>; file: string }> = (() => {
  const arr = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf-8'));
  const list: unknown[] = Array.isArray(arr) ? arr : [arr];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((raw, i) => ({ raw, file: `seed[${i}]` }));
})();

const candidates = raws
  .filter(({ raw: s }) => detectBookSource(s) && (s['searchUrl'] || (s['ruleSearch'] as any)?.searchUrl || (s['ruleSearch'] as any)?.bookList))
  .slice(0, 30);

const engine = new LegadoEngine();
const http = createHttpClient({ 'User-Agent': 'Mozilla/5.0 (compatible; yuedu-regression/0.1)' });
let idx = 0;

async function worker() {
  while (idx < candidates.length) {
    const i = idx++;
    const { raw: s, file } = candidates[i] as { raw: any; file: string };
    const name = String(s.bookSourceName || s.bookSourceUrl || `?${i}`);
    if (filterWords.length && !filterWords.some((w) => name.includes(w) || file.includes(w))) continue;
    const compiled = compileBookSource(s);
    if (!compiled.ok || !compiled.rule) continue;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const ctx: EngineContext = {
      reqId: `${name}@d`, sourceId: String(s.bookSourceUrl || name), signal: ac.signal,
      http, sandbox: noopSandbox, trace: createTraceSink(),
      variables: createVariableStore(), storage: createMemoryKeyValueStore(),
    };
    try {
      const res = await engine.search(compiled.rule, { action: 'search', keyword: '武侠', page: 1 }, ctx);
      if (res.items.length > 0) { console.log(`[OK ${res.items.length}] ${name}`); continue; }
      // 0 条 → 深挖：最终 URL（引擎写入 baseUrl 变量）+ 响应开头
      const finalUrl = String(ctx.variables.get('baseUrl') ?? '');
      let bodyHead = '';
      let status = 0;
      if (finalUrl) {
        try {
          const r2 = await http.request(finalUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; yuedu-regression/0.1)' } });
          status = r2.status;
          bodyHead = (typeof r2.body === 'string' ? r2.body : Buffer.from(r2.body as ArrayBuffer).toString('utf-8')).slice(0, 220).replace(/\s+/g, ' ');
        } catch { bodyHead = '(二次请求失败)'; }
      }
      console.log(`\n===== 0条: ${name} (${file})`);
      console.log(`  URL[${status}]: ${finalUrl.slice(0, 150)}`);
      console.log(`  body: ${bodyHead}`);
      console.log(`  bookList: ${String(s.ruleSearch?.bookList ?? '').slice(0, 120)}`);
      console.log(`  name规则: ${String(s.ruleSearch?.name ?? '').slice(0, 100)}`);
    } catch (e) {
      console.log(`[ERR] ${name}: ${(e as Error).message.slice(0, 100)}`);
    } finally {
      clearTimeout(t);
    }
  }
}

await Promise.all(Array.from({ length: 5 }, () => worker()));
