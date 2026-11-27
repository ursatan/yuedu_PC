/**
 * `#644` 两处出口语义：**① GET / HEAD 不得带请求体** 与 **② CSS 选择含根自身**。
 *
 * ## ① GET + body（木里聚合 `公益密钥版` 实测）
 * 上游 `AnalyzeUrl.kt:302-320` 的 `when (method)`：**POST 分支**才取 `body` 填 `fieldMap`，
 * `else`（GET / HEAD）分支**压根不看 `body`**（改去拆 URL 的 query）。
 * 我们此前把 `body` 原样递给 fetch ⇒ undici 直接抛
 * `Request with GET/HEAD method cannot have body.`，整条规则连带失败
 * （源作者这么写时，App 端是「默默丢掉 body」，不会报错）。
 *
 * ## ② CSS 含根（搬山人正文规则实测）
 * 源里写 `java.getElements("@css:html")` 判「网页拿到了没」。真 jsoup 的
 * `Element.select` 从 **root 自己**开始遍历（`Collector.collect` + `NodeTraversor`）
 * ⇒ `doc.select("html")` 命中 1。我们套的 DOM `querySelectorAll` **只搜后代** ⇒ 恒 0
 * ⇒ 源抛「没有取得网页，请刷新本章」，看起来像「站点挂了」其实是**我们少一格**。
 *
 * ★ 二者都是「**照抄上游判据就对了**」的典型，别在这里发明新语义。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalyzeRule } from '../selector/analyze';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

const PAGE =
  '<html><head><title>页面标题</title></head>' +
  '<body><div id="x" class="box">正文甲</div><p class="c">第二段</p></body></html>';
const BASE = 'https://e.test/';
const ev = () => createJsEvaluator({ variables: createVariableStore() });

/** 最小 `AnalyzeEnv`（`env()` 每次新建，避免用例之间串变量） */
function env(): never {
  const e = {
    variables: createVariableStore(),
    source: { getVariable: () => '', getKey: () => 'e' },
    javaExtra: {},
    sourceId: 'e',
    baseUrl: BASE,
    toAbsolute: (u: string) => u,
  } as unknown;
  return e as never;
}

test('#644 ②：CSS 选择要含根自身（select(html) 命中 1 个）', async () => {
  const ar = new AnalyzeRule(env()).setContent(PAGE, BASE);
  const els = (await ar.getElements('@css:html')) as unknown[];
  assert.equal(els.length, 1, `select(html) 应命中根元素，实际 ${els.length}`);
});

test('#644 ②b：纯后代选择器不受影响（不重复计数）', async () => {
  for (const [rule, want] of [
    ['@css:p', 1],
    ['@css:body', 1],
    ['@css:div', 1],
    ['@css:section', 0],
  ] as const) {
    const ar = new AnalyzeRule(env()).setContent(PAGE, BASE);
    const els = (await ar.getElements(rule)) as unknown[];
    assert.equal(els.length, want, `${rule} 应为 ${want}，实际 ${els.length}`);
  }
});

/** 起一个真 HTTP 回显服务（子进程）—— `syncHttp` 走 `execFileSync` 会阻塞事件循环，服务必须独立进程 */
const ECHO_SRC = `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const out = process.env.ECHO_OUT;
const s = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    appendFileSync(out, JSON.stringify({ m: req.method, h: req.headers, b }) + '\\n');
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
});
s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));
`;

let child: ChildProcess | undefined;
let logFile = '';
let base = '';

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu-644-'));
  logFile = join(dir, 'echo.log');
  writeFileSync(logFile, '');
  const script = join(dir, 'echo.mjs');
  writeFileSync(script, ECHO_SRC);
  child = spawn(process.execPath, [script], {
    env: { ...process.env, ECHO_OUT: logFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('回显服务启动超时')), 15_000);
    child!.stdout!.on('data', (b: Buffer) => {
      const n = Number(String(b).trim().split('\n')[0]);
      if (n) { clearTimeout(timer); resolve(n); }
    });
    child!.on('error', reject);
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  child?.kill();
});

function lastReq(): { m: string; h: Record<string, string>; b: string } {
  const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1)!);
}

test('#644 ①：URL 选项给了 body 但 method 是 GET ⇒ 请求体必须被忽略', async () => {
  const src = `java.get(${JSON.stringify(`${base}/g?a=1`)}, '{"method":"GET","body":"a=1"}')`;
  await ev()(src, {});
  const req = lastReq();
  assert.equal(req.m, 'GET', '方法仍是 GET');
  assert.equal(req.b, '', 'GET 不得带请求体（上游 GET 分支不取 body）');
});

test('#644 ①b：HEAD + body 同样忽略请求体', async () => {
  await ev()(`java.head(${JSON.stringify(`${base}/h`)}, '{"method":"HEAD","body":"a=1"}')`, {});
  assert.equal(lastReq().b, '');
});

test('#644 ①c：POST 的请求体照常发出（别修过头）', async () => {
  await ev()(`java.post(${JSON.stringify(`${base}/p`)}, 'a=1', '{"Content-Type":"application/x-www-form-urlencoded"}')`, {});
  const req = lastReq();
  assert.equal(req.m, 'POST');
  assert.equal(req.b, 'a=1');
});

test('#644 ④：默认 UA —— 源没给 UA 时不得出现 `node`', async () => {
  await ev()(`java.get(${JSON.stringify(`${base}/ua`)})`, {});
  const ua = String(lastReq().h['user-agent'] ?? '');
  assert.match(ua, /^Mozilla\/5\.0/, `应为浏览器 UA，实际=${JSON.stringify(ua)}`);
});
