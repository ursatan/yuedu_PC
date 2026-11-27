/**
 * `java.ajax` 的**源级请求头**（对齐 Legado `AnalyzeUrl(url, baseUrl, source)`）。
 *
 * 背景（用户上报的「发现页 JS 动态分类失败」根因之一）：
 * `java.ajax` 早期只把 URL 自带的 `,{headers}` 发出去，**源 `header` 规则一个头都没发**
 * —— 星空小说那类接口要求 `application-id` / `app-version` / 签名头，于是必然拿不到数据。
 * 而 Legado 的 `AnalyzeUrl` 会把 `source.getHeaderMap()` 作为基底带上。
 *
 * 本测试**不打桩**：起一个真实 HTTP 服务，让 `java.ajax` 真的发出去（curl），
 * 直接断言服务端收到的 header —— 任何「只改 JS 变量、没真发头」的假修都会被测出来。
 *
 * ⚠️ 两个坑（都踩过）：
 *  1. `syncHttp` 用 `execFileSync` **同步阻塞事件循环** —— 服务端必须跑在**独立进程**，
 *     否则同进程的 server 永远 accept 不到，curl 只能超时（exit 28）。
 *  2. 服务端在**回包前**就把请求写进日志文件，所以 curl 返回时日志一定已落盘，无需 sleep 等待。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/** 独立进程里的回显服务：把每次请求的 method/url/headers 以 JSON 行追加到文件 */
const ECHO_SRC = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const out = process.env.ECHO_OUT;
const server = createServer((req, res) => {
  if (out) appendFileSync(out, JSON.stringify({ method: req.method, url: req.url, headers: req.headers }) + '\\n');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, body })); });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

let child: ChildProcess | undefined;
let dir = '';
let logFile = '';
let base = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yuedu-ajax-'));
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

/** 读取累计请求记录（服务端回包前已写盘，无需等待） */
function seen(): Array<{ method: string; url: string; headers: Record<string, string> }> {
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string; headers: Record<string, string> });
}

const cookieStore = (header: string) => ({ get: () => '', set: () => undefined, header: () => header });

test('java.ajax 带上源 header 规则里的头', async () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    getSourceHeaders: () => ({ 'X-App-Id': 'com.xk.qreader', 'X-App-Version': '21500' }),
  });
  await ev(`java.ajax(${JSON.stringify(`${base}/a`)})`, {});
  const req = seen().at(-1)!;
  assert.equal(req.url, '/a');
  assert.equal(req.headers['x-app-id'], 'com.xk.qreader');
  assert.equal(req.headers['x-app-version'], '21500');
});

test('java.ajax 带上源 Cookie（脚本未显式给 Cookie 时）', async () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    cookies: cookieStore('token=abc; uid=7'),
    getSourceHeaders: () => ({ 'X-App-Id': 'x' }),
  });
  await ev(`java.ajax(${JSON.stringify(`${base}/b`)})`, {});
  assert.equal(seen().at(-1)!.headers['cookie'], 'token=abc; uid=7');
});

test('URL 自带 `,{headers}` 覆盖源 header 同名项（Legado UrlOption 语义）', async () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    getSourceHeaders: () => ({ 'X-Trace': 'from-source', 'X-Keep': 'kept' }),
  });
  // Legado 的 java.ajax 只收一个字符串，URL 选项用 `,{...}` 尾巴表达
  const spec = `${base}/c,{"headers":{"X-Trace":"from-url"}}`;
  await ev(`java.ajax(${JSON.stringify(spec)})`, {});
  const h = seen().at(-1)!.headers;
  assert.equal(h['x-trace'], 'from-url', 'URL 自带头覆盖源头');
  assert.equal(h['x-keep'], 'kept', '源头的其它键保留');
});

test('java.post 也带源 header（POST 分支同样走 AnalyzeUrl 语义）', async () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    getSourceHeaders: () => ({ 'X-App-Id': 'post-app' }),
  });
  await ev(`java.post(${JSON.stringify(`${base}/d`)}, "a=1")`, {});
  const req = seen().at(-1)!;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-app-id'], 'post-app');
  assert.equal(req.headers['content-length'], '3');
});

test('没有 getSourceHeaders 时不注入额外头（向后兼容）', async () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  await ev(`java.ajax(${JSON.stringify(`${base}/e`)})`, {});
  const h = seen().at(-1)!.headers;
  assert.equal(h['x-app-id'], undefined);
  assert.equal(h['cookie'], undefined);
});
