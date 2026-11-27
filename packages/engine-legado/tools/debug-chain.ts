/**
 * 目录/正文/详情段失败源诊断：跑通 search→detail→(toc)→content 链，
 * 在卡点打印规则 + 最终请求 URL/状态/响应开头。
 * 用法：npx tsx tools/debug-chain.ts <bucket=toc|content|info> [数量=12] [起始=0]
 */
import { LegadoEngine } from '../src/index';
import { compileBookSource } from '../src/model/book-source';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  createHttpClient,
  type EngineContext,
  type JsSandboxPool,
  type HttpClient,
} from '@yuedu/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BUCKET = process.argv[2] ?? 'toc';
const COUNT = Number(process.argv[3] ?? 12);
const OFFSET = Number(process.argv[4] ?? 0);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ROOT = path.resolve(here, '../../..');

const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/verify-summary.json'), 'utf-8'));
const ids = summary.failures
  .filter((f: { message: string }) => {
    const m = String(f.message);
    if (BUCKET === 'info') return m.includes('详情失效:RULE_PARSE');
    if (BUCKET === 'toc') return m.includes('目录失效');
    if (BUCKET === 'content') return m.includes('正文失效');
    return false;
  })
  .map((f: { id: string }) => f.id)
  .slice(OFFSET, OFFSET + COUNT);

const noop: JsSandboxPool = { async eval() { throw new Error('no'); } };

function makeLoggingHttp(inner: HttpClient): HttpClient {
  return {
    request(url: string, opts?: any) {
      return inner.request(url, opts).then(
        (res: any) => {
          const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
          (globalThis as any).__lastRes = { url, status: res.status, head: body.slice(0, 160).replace(/\n/g, ' ') };
          return res;
        },
        (e: any) => {
          (globalThis as any).__lastRes = { url, status: 'FETCH_FAIL', head: String(e?.message ?? e).slice(0, 100) };
          throw e;
        },
      );
    },
  };
}

const takeHead = () => {
  const last = (globalThis as any).__lastRes as { url: string; status: number; head: string } | undefined;
  (globalThis as any).__lastRes = undefined;
  return last ? `${last.status} ${last.url.slice(0, 110)}\n      响应: ${last.head.slice(0, 130)}` : '(无请求发出)';
};

for (const id of ids) {
  const file = path.join(ROOT, 'data/sources/book-482', id + '.json');
  if (!fs.existsSync(file)) continue;
  const s: any = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const ctx: EngineContext = {
    reqId: 'd',
    sourceId: id,
    signal: AbortSignal.timeout(20000),
    http: makeLoggingHttp(createHttpClient({ 'User-Agent': 'okhttp/3.12.0' })),
    sandbox: noop,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  const eng = new LegadoEngine();
  const compiled = compileBookSource(s);
  if (!compiled.ok) continue;
  try {
    const r = await eng.search(compiled.rule!, { action: 'search', keyword: '我的', page: 1 }, ctx);
    if (!r.items.length) {
      console.log(`[skip] ${id} : 搜索现在 0 条（已属其它桶）`);
      continue;
    }
    const first = r.items[0]!;
    const d = await eng.detail(compiled.rule!, { action: 'detail', id: JSON.stringify(first.payload) }, ctx);
    if (BUCKET === 'info') {
      console.log(`\n[info] ${id}: detail 现在能跑（${d.chapters?.length ?? 0} 章）？title=${String(d.title).slice(0, 20)}`);
      continue;
    }
    const chs = d.chapters ?? [];
    if (!chs.length) {
      console.log(`\n===== 目录0章: ${id}`);
      console.log(`  tocUrl规则: ${String(s.ruleBookInfo?.tocUrl ?? '(空=当前页)').slice(0, 80)}`);
      console.log(`  chapterList: ${String(s.ruleToc?.chapterList ?? '').replace(/\n/g, ' ').slice(0, 100)}`);
      console.log(`  chapterName: ${String(s.ruleToc?.chapterName ?? '').slice(0, 60)}`);
      console.log(`  最后请求: ${takeHead()}`);
      continue;
    }
    if (BUCKET === 'toc') {
      console.log(`[修好了] ${id} : ${chs.length} 章`);
      continue;
    }
    const c = await eng.content(compiled.rule!, { action: 'content', id: JSON.stringify(chs[0]!.payload) }, ctx);
    const paras = c.paragraphs ?? [];
    if (paras.length) {
      console.log(`[修好了] ${id} : 正文 ${paras.length} 段`);
      continue;
    }
    console.log(`\n===== 正文0段: ${id}`);
    console.log(`  content规则: ${String(s.ruleContent?.content ?? '').replace(/\n/g, ' ').slice(0, 100)}`);
    console.log(`  nextContentUrl: ${String(s.ruleContent?.nextContentUrl ?? '').slice(0, 60)}`);
    console.log(`  最后请求: ${takeHead()}`);
  } catch (e: any) {
    console.log(`\n===== ERR ${id}: ${String(e.message).slice(0, 70)}\n  最后请求: ${takeHead()}`);
  }
}
