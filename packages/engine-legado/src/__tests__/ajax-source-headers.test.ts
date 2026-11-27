/**
 * 引擎级：源的 `header` 规则 → `java.ajax` 请求头（端到端）。
 *
 * core 的 `js-ajax-headers.test.ts` 证明了「给了 getSourceHeaders，头就真发出去」；
 * 本文件证明**引擎把源规则接到了那个钩子上**——即 `makeEnv` 里
 * `rule.header`（JSON 形态与 `@js:` 形态）真的成了 `java.ajax` 的请求头。
 *
 * 为什么必须验到这一层：只改 core 的钩子而忘了在 engine 里注入，测试也会全绿，
 * 但线上「星空小说那类要签名头的源」依旧拿不到数据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegadoEngine } from '../index';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
} from '@yuedu/core';

const noopSandbox: JsSandboxPool = { async eval() { throw new Error('no sandbox'); } };
/** 引擎正常请求走 mock；本测试只关心 java.ajax（走 curl），不应触碰它 */
const noopHttp: HttpClient = { async request() { throw new Error('正常请求通道不应用于本测试'); } };

function makeCtx(): EngineContext {
  return {
    reqId: 't', sourceId: 'src', signal: new AbortController().signal,
    http: noopHttp, sandbox: noopSandbox, trace: createTraceSink(),
    variables: createVariableStore(), storage: createMemoryKeyValueStore(),
  };
}

const ECHO_SRC = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const out = process.env.ECHO_OUT;
const server = createServer((req, res) => {
  if (out) appendFileSync(out, JSON.stringify({ method: req.method, url: req.url, headers: req.headers }) + '\\n');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: { tag: req.headers['x-from-rule'] || 'none' } }));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

let child: ChildProcess | undefined;
let dir = '';
let logFile = '';
let base = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yuedu-eng-ajax-'));
  logFile = join(dir, 'echo.log');
  writeFileSync(logFile, '');
  const script = join(dir, 'echo.mjs');
  writeFileSync(script, ECHO_SRC);
  child = spawn(process.execPath, [script], {
    env: { ...process.env, ECHO_OUT: logFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('回显服务启动超时')), 15_000);
    child!.stdout!.on('data', (b: Buffer) => {
      const n = Number(String(b).trim().split('\n')[0]);
      if (n) { clearTimeout(t); resolve(n); }
    });
    child!.on('error', reject);
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  child?.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seen(): Array<{ method: string; url: string; headers: Record<string, string> }> {
  return readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const engine = new LegadoEngine();

/** exploreUrl 里发一次 java.ajax，并把回包内容带进分类名——既验请求头，也验请求真完成 */
function makeSrc(header: string): NonNullable<ReturnType<typeof engine.compile>['rule']> {
  const spec = `${base}/probe,{"headers":{"X-Url-Level":"u"}}`;
  const out = engine.compile({
    bookSourceUrl: 'https://x.com',
    bookSourceName: 'ajax头测试源',
    bookSourceType: 0,
    searchUrl: 'https://x.com/s?q={{key}}',
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    header,
    exploreUrl: [
      '@js:',
      `var body = java.ajax(${JSON.stringify(spec)});`,
      'var tag = (JSON.parse(body).data || {}).tag || "?";',
      'JSON.stringify([{ title: "tag:" + tag, url: "/c/{{page}}.html" }]);',
    ].join('\n'),
  });
  assert.ok(out.ok && out.rule, `compile 应通过：${out.issues?.map((i) => i.message).join('；')}`);
  return out.rule!;
}

test('源 header（JSON 形态）成为 java.ajax 的请求头', async () => {
  const rule = makeSrc(JSON.stringify({ 'X-From-Rule': 'yes-json' }));
  const r = await engine.home(rule, { action: 'home' }, makeCtx());
  const req = seen().at(-1);
  assert.ok(req, '应发出一次 java.ajax');
  assert.equal(req.headers['x-from-rule'], 'yes-json');
  assert.equal(req.headers['x-url-level'], 'u', 'URL 级头同时保留');
  // 回包被脚本读到 → 证明请求真的完成了（不是「头对了但请求没发出去」）
  assert.equal(r.filters?.[0]?.options[0]?.name, 'tag:yes-json');
});

test('源 header（@js: 形态）求值后成为 java.ajax 的请求头', async () => {
  const rule = makeSrc('@js:\nJSON.stringify({ "X-From-Rule": "yes-js" });');
  const r = await engine.home(rule, { action: 'home' }, makeCtx());
  assert.equal(seen().at(-1)?.headers['x-from-rule'], 'yes-js');
  assert.equal(r.filters?.[0]?.options[0]?.name, 'tag:yes-js');
});

test('源 header 求值失败时不阻断 java.ajax（降级为空头 + 默认 UA）', async () => {
  const rule = makeSrc('@js:\nthrow new Error("boom");');
  const r = await engine.home(rule, { action: 'home' }, makeCtx());
  const req = seen().at(-1);
  assert.ok(req, 'header 求值失败也要能发请求');
  assert.equal(req.headers['x-from-rule'], undefined);
  assert.ok(String(req.headers['user-agent'] ?? '').length > 0, '至少有默认 UA');
  assert.equal(r.filters?.[0]?.options[0]?.name, 'tag:none');
});

/**
 * 缺陷类BN 回归锁：**java.ajax 的源级 header 脚本里必须能拿到 `source`**。
 *
 * 此前这条路径只绑了 `baseUrl` ⇒ 落到 core 的默认 source 桩（`getKey() → ''`）。
 * 语料里的源普遍是这种写法（⚡📂星空小说）：
 * ```js
 * if(/…zonghengxiaoshuo…/.test(source.getKey())){ application = "com.xk.qreader"; }
 * headers = { "application-id": application, … };   // application 从没被赋值 ⇒ ReferenceError
 * ```
 * 于是**整条 header 脚本失败**（退回默认 UA）⇒ 站点 401 ⇒ exploreUrl 脚本里
 * `JSON.parse(html).data` 取 undefined，用户看到的是「exploreUrl 脚本执行失败」。
 * ⇒ 断言必须落在「头真的带上了脚本算出来的值」，而不是「没抛错」。
 */
test('源 header 脚本里能用 source.getKey()（隐式全局赋值 + 源键）', async () => {
  const rule = makeSrc(
    '@js:\n' +
      'if(/x\\.com/.test(source.getKey())){ application = "com.xk.qreader"; }\n' +
      'JSON.stringify({ "X-From-Rule": application, "X-Key": source.getKey() });',
  );
  const r = await engine.home(rule, { action: 'home' }, makeCtx());
  const req = seen().at(-1);
  assert.equal(
    req?.headers['x-from-rule'],
    'com.xk.qreader',
    'source.getKey() 拿不到值 ⇒ 分支不命中 ⇒ application 未赋值 ⇒ 整条 header 脚本失败',
  );
  assert.equal(req?.headers['x-key'], 'https://x.com', 'source.getKey() = bookSourceUrl（Legado BaseSource 语义）');
  assert.equal(r.filters?.[0]?.options[0]?.name, 'tag:com.xk.qreader');
});
