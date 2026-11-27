/**
 * 0 结果源批量诊断 v2：包装 http 客户端，打印最终请求 URL / 状态码 / 响应开头。
 * 用法：npx tsx tools/debug-zero2.ts [数量=15] [起始=0]
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

const COUNT = Number(process.argv[2] ?? 15);
const OFFSET = Number(process.argv[3] ?? 0);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const ROOT = path.resolve(here, '../../..');

const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/verify-summary.json'), 'utf-8'));
const zeroIds = summary.failures
  .filter((f: { message: string }) => /^校验失败:搜索失效(，|$)/.test(f.message))
  .map((f: { id: string }) => f.id)
  .slice(OFFSET, OFFSET + COUNT);

const noop: JsSandboxPool = { async eval() { throw new Error('no'); } };

function makeLoggingHttp(inner: HttpClient): HttpClient {
  return {
    request(url: string, opts?: any) {
      return inner.request(url, opts).then(
        (res: any) => {
          const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
          (globalThis as any).__lastRes = { url, status: res.status, head: body.slice(0, 150).replace(/\n/g, ' ') };
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

for (const id of zeroIds) {
  const file = path.join(ROOT, 'data/sources/book-482', id + '.json');
  if (!fs.existsSync(file)) {
    console.log(id, ': 文件不存在');
    continue;
  }
  const s: any = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const ctx: EngineContext = {
    reqId: 'd',
    sourceId: id,
    signal: AbortSignal.timeout(15000),
    http: makeLoggingHttp(createHttpClient({ 'User-Agent': 'test' })),
    sandbox: noop,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  const eng = new LegadoEngine();
  const compiled = compileBookSource(s);
  if (!compiled.ok) {
    console.log(id, ': compile fail');
    continue;
  }
  try {
    const r = await eng.search(compiled.rule!, { action: 'search', keyword: '我的', page: 1 }, ctx);
    if (r.items.length > 0) {
      console.log('[有结果]', id, '→', r.items.length, '条（并发/环境差异）');
      continue;
    }
    const last = (globalThis as any).__lastRes;
    console.log('\n===== 0条:', id);
    console.log('  bookList:', String(s.ruleSearch?.bookList ?? '').replace(/\n/g, ' ').slice(0, 100));
    if (last) console.log('  请求:', last.status, last.url.slice(0, 120), '\n  响应头:', last.head);
    else console.log('  （未捕获响应——可能请求失败或未发出）');
  } catch (e: any) {
    console.log('\n===== ERR:', id, '::', String(e.message).slice(0, 70), (e as any).__dbgUrl ? String((e as any).__dbgUrl).slice(0, 100) : '');
  }
}
