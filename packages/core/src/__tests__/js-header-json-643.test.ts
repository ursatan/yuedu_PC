/**
 * `#643` **`java.post/get/head/ajaxAll` 第三参「头」可以是 JSON 字符串**。
 *
 * 上游（`JsExtensions.kt` 的 `post`/`get`/`head`）签名是
 * `fun post(urlStr: String, body: String?, headers: String?)`，内部走
 * **`GSON.fromJsonObject<MutableMap<String,String>>(headers)`** —— 也就是说源传的是
 * **一个 JSON 字符串**，不是对象。
 *
 * 我们此前把第三参直接当 `Record<string, unknown>` 用 ⇒ 字符串被静静忽略。
 * 症状：源明明写了 Referer / Content-Type，出口请求里一个都没有，且**不报错**。
 *
 * 实测（`#643` uu书库 `www.uushuk.com` 目录翻页）：源写
 * `java.post(url, 'data=' + enc, '{"Content-Type":"…","Referer":"https://…/book/3UWK.html"}')`
 * → 修复前出口头 `[User-Agent,Accept,Accept-Language,content-type]`（Referer 丢），
 * → 修复后 `[User-Agent,Accept,Accept-Language,Content-Type,Referer]`。
 *
 * 本测试**不打桩**：起独立进程的真 HTTP 服务，断言服务端收到的头（沿用
 * `js-ajax-headers.test.ts` 的形态 —— `syncHttp` 用 `execFileSync` 会阻塞事件循环，
 * 服务必须在独立进程里）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

const ECHO_SRC = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const out = process.env.ECHO_OUT;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  // ⚠️ 必须在 end 里写日志：在 createServer 回调里直接 append 时 body 还没收完，
  // 记下来的 body 恒为 ''（第一版就栽在这里，断言 body 的两条全红）。
  req.on('end', () => {
    if (out) appendFileSync(out, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + '\\n');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, body }));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

let child: ChildProcess | undefined;
let dir = '';
let logFile = '';
let base = '';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yuedu-jsheader-'));
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

function seen(): Array<{ method: string; url: string; headers: Record<string, string>; body: string }> {
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; url: string; headers: Record<string, string>; body: string });
}

function ev() {
  return createJsEvaluator({ variables: createVariableStore() });
}

test('#643 java.post 第三参是 JSON 字符串时，头必须真的发出去（上游 GSON 语义）', async () => {
  const script = `java.post(${JSON.stringify(`${base}/p1`)}, 'data=abc', '{"Content-Type":"application/x-www-form-urlencoded","Referer":"https://e.test/book/1.html"}')`;
  await ev()(script, {});
  const req = seen().at(-1)!;
  assert.equal(req.method, 'POST', `应 POST，实际 ${req.method}`);
  assert.equal(req.headers['referer'], 'https://e.test/book/1.html', `Referer 丢了：${JSON.stringify(req.headers)}`);
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(req.body, 'data=abc');
});

test('#643 java.post 第三参是**对象**时行为不变（源作者两种写法都支持）', async () => {
  const script = `java.post(${JSON.stringify(`${base}/p2`)}, 'x=1', {"Referer":"https://e.test/obj","X-Obj":"1"})`;
  await ev()(script, {});
  const h = seen().at(-1)!.headers;
  assert.equal(h['referer'], 'https://e.test/obj');
  assert.equal(h['x-obj'], '1');
});

test('#643 java.get 第二参是 JSON 字符串头时同样生效（不止 post）', async () => {
  const script = `java.get(${JSON.stringify(`${base}/g1`)}, '{"X-Token":"tk","Referer":"https://e.test/g"}')`;
  await ev()(script, {});
  const h = seen().at(-1)!.headers;
  assert.equal(h['x-token'], 'tk', `X-Token 丢了：${JSON.stringify(h)}`);
  assert.equal(h['referer'], 'https://e.test/g');
});

test('#643 头字符串不是合法 JSON 时不抛错（头是可选装饰，不能因此整条规则失败）', async () => {
  const script = `java.post(${JSON.stringify(`${base}/p3`)}, 'y=2', 'not-a-json')`;
  await ev()(script, {});
  const req = seen().at(-1)!;
  assert.equal(req.method, 'POST');
  assert.equal(req.body, 'y=2', '体必须照常发出');
});

/**
 * `#643` **默认 UA**：上游 `java.post` 走 `Jsoup.connect()`，jsoup 自带浏览器 UA；
 * 我们此前一律「源给什么就发什么」⇒ 无 UA 时 undici 填 `user-agent: node`。
 * uu书库实测：`node` UA → 403 错误信封（不重定向）；浏览器 UA → 307 到 WAF 验证页。
 */
test('#643 源没给 UA 时，java.post 必须带浏览器 UA（上游 jsoup 默认语义）', async () => {
  await ev()(`java.post(${JSON.stringify(`${base}/ua1`)}, 'x=1')`, {});
  const h = seen().at(-1)!.headers;
  assert.match(String(h['user-agent'] ?? ''), /Mozilla\/5\.0.*Chrome\//, `UA 不对：${h['user-agent']}`);
  assert.notEqual(h['user-agent'], 'node', '不能把 undici 的 node UA 发给站点');
});

test('#643 源显式给了 UA 时一字不改（jsoup header() 可覆盖默认值）', async () => {
  await ev()(`java.post(${JSON.stringify(`${base}/ua2`)}, 'x=1', '{"User-Agent":"MyReader/1.0"}')`, {});
  const h = seen().at(-1)!.headers;
  assert.equal(h['user-agent'], 'MyReader/1.0', `显式 UA 被覆盖了：${h['user-agent']}`);
});

test('#643 java.get / head / ajax 也都补默认 UA（不止 post 一条出口）', async () => {
  for (const [p, src] of [
    ['g-ua', `java.get(${JSON.stringify(`${base}/ua3`)})`],
    ['h-ua', `java.head(${JSON.stringify(`${base}/ua4`)})`],
    ['a-ua', `java.ajax(${JSON.stringify(`${base}/ua5`)})`],
  ] as Array<[string, string]>) {
    await ev()(src, {});
    const h = seen().at(-1)!.headers;
    assert.match(String(h['user-agent'] ?? ''), /Mozilla\/5\.0/, `${p}: UA 缺失 → ${h['user-agent']}`);
  }
});
