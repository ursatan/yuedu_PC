/**
 * `#387c` 回归锁：`java.get` / `java.post` **不得跟随重定向**（上游 `followRedirects(false)`）。
 *
 * ## 上游依据（逐行）
 * `F:\legado\app\src\main\java\io\legado\app\help\JsExtensions.kt`
 * ```
 * :591  get (urlStr, headers, timeout)  → Jsoup.connect(…).followRedirects(false)
 * :618  head(urlStr, headers, timeout)  → 同上
 * :645  post(urlStr, body, headers…)    → 同上     // 注释原话：「js实现重定向拦截」
 * ```
 * ⇒ 源脚本用 `statusCode()` **自己判 3xx** 再决定跟不跟。语料用法（3 源 / 12 处）：
 * ```
 * java.get(url,{…}) … if (/^30/.test(response.statusCode())) { …跟 Location… }   // 📂m.miduxs
 * ```
 *
 * ## 我们此前是「一律跟随」→ 两个真实后果
 * ① 📂`˃̶͈ ꇴ ˂̶͈`（RSS）`ruleArticles` 里的 `TD()`：
 *    `java.get('http://gedem.uaa.cn.mt/')` 期望 **301**（该站点裸域就是 301）——
 *    跟随之后拿到 200 ⇒ 走 `code !== 301` 的失败分支 ⇒ 弹「校验失败」+ `💔访问出错💔`，
 *    并且**把 `{"密钥：":"密钥🔐已清"}` 写进 loginInfo（抹掉用户的密钥）**。
 * ② 📂m.miduxs / 📂97k.cc 的「JS 拦截 3xx」写法恒不成立。
 *
 * ## 判据（对偶，缺一即假通过）
 *  - `java.get` / `java.post` ⇒ 停在 3xx（能看见状态码与 Location）；
 *  - `java.ajax` ⇒ **200**（上游走 `AnalyzeUrl` / `HttpHelper.kt:68 .followRedirects(true)`，必须仍跟随）。
 *
 * ## ⚠️ 站点必须起在**另一个进程**
 * 同步传输（worker 内 fetch / 子进程 curl）会**阻塞本进程事件循环**（`Atomics.wait` / 同步等待），
 * 若 HTTP 服务就在本进程内，请求永远等不到应答 ⇒ **自锁**（实测：同进程版本每次都 3~15s 后 status=0）。
 * 所以这里 spawn 一个子进程起站点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 子进程站点源码：`/a` → 301 `/b`；`/p`(POST) → 302；其余 → 200 'FINAL'。打印端口后常驻。 */
const SITE_SRC = [
  "const http = require('node:http');",
  'const s = http.createServer((req, res) => {',
  "  if (req.url === '/a') { res.writeHead(301, { location: '/b' }); res.end('MOVED'); return; }",
  "  if (req.url === '/p') { res.writeHead(302, { location: '/done' }); res.end('MOVED'); return; }",
  "  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('FINAL');",
  '});',
  "s.listen(0, '127.0.0.1', () => { console.log(String(s.address().port)); });",
].join('\n');

async function startSite(): Promise<{ base: string; stop: () => void }> {
  const child = spawn(process.execPath, ['-e', SITE_SRC], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('站点子进程未在 10s 内报端口')), 10_000);
    child.stdout?.on('data', (d: Buffer) => {
      const p = String(d).trim();
      if (/^\d+$/.test(p)) {
        clearTimeout(timer);
        resolve(p);
      }
    });
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

function makeEv() {
  return createJsEvaluator({ variables: createVariableStore() } as never) as (
    code: string,
    b: Record<string, unknown>,
  ) => unknown;
}

test('#387c：java.get 不跟随重定向（statusCode 看得见 301）；java.ajax 仍跟随（对偶）', async () => {
  const site = await startSite();
  try {
    const ev = makeEv();
    // ① 目标：java.get 必须停在 301（源脚本靠这个判据实现「JS 拦截跳转」）
    assert.equal(
      String(ev(`String(java.get('${site.base}/a', {}).statusCode())`, {})),
      '301',
      'java.get 必须不跟随重定向（上游 followRedirects(false)）',
    );
    // ② 301 的 Location 必须能读到（不然源脚本跟不了跳转）
    assert.equal(
      String(ev(`String(java.get('${site.base}/a', {}).headers()['location'] || '')`, {})),
      '/b',
      '301 的 Location 必须能读到',
    );
    // ③ 对偶：java.ajax 走上游 AnalyzeUrl 语义（followRedirects(true)）⇒ 必须拿到最终 200
    assert.equal(
      String(ev(`String(java.ajax('${site.base}/a').statusCode())`, {})),
      '200',
      'java.ajax 必须仍然跟随重定向（HttpHelper.kt:68 followRedirects(true)）',
    );
    assert.equal(
      String(ev(`String(java.ajax('${site.base}/a').body()).trim()`, {})),
      'FINAL',
      'java.ajax 的 body 必须是跳转后的最终页',
    );
    // ④ `java.head`（#387 补齐上游 JsExtensions.head）= HEAD + followRedirects(false)，且**不取 body**
    assert.equal(
      String(ev(`String(java.head('${site.base}/a', {}).statusCode())`, {})),
      '301',
      'java.head 必须不跟随重定向（上游 JsExtensions.kt:600-620）',
    );
  } finally {
    site.stop();
  }
});

test('#387c 对偶：java.post 同样不跟随重定向', async () => {
  const site = await startSite();
  try {
    const ev = makeEv();
    assert.equal(
      String(ev(`String(java.post('${site.base}/p', 'a=1', {}).statusCode())`, {})),
      '302',
      'java.post 必须不跟随重定向',
    );
  } finally {
    site.stop();
  }
});

/**
 * ⚠️ 第二条通道：**worker 里的 `java.get` 不经 L1 的 `syncHttp`**，而是
 * `httpRpcSpec → rpc('http') → 宿主的 http 选项 → ctx.http.request`（引擎 HttpClient）。
 * 这条链上 `redirect` 必须一路透传，否则「worker 路径跟随、L1 路径不跟随」——
 * 同一份源在两种求值路径下行为不同（这一族 bug 的温床）。
 */
test('#387c worker→宿主 http 分支：get/post/head 必须带 redirect=manual，ajax 不得带（对偶）', async () => {
  const seen: Array<{ url: string; redirect?: string }> = [];
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async (r: { url: string; redirect?: 'follow' | 'manual' }) => {
      seen.push({ url: r.url, ...(r.redirect ? { redirect: r.redirect } : {}) });
      return { status: 301, headers: {}, body: '' };
    },
  }) as (code: string, b: Record<string, unknown>) => unknown | Promise<unknown>;
  await ev("java.get('http://x.test/a', {})", {});
  await ev("java.post('http://x.test/b', 'k=1', {})", {});
  await ev("java.head('http://x.test/c', {})", {});
  await ev("java.ajax('http://x.test/d')", {});
  const at = (p: string) => seen.find((s) => s.url.includes(p));
  const getCall = at('/a');
  const postCall = at('/b');
  const headCall = at('/c');
  const ajaxCall = at('/d');
  assert.ok(getCall, `java.get 必须走到宿主 http（实际 ${JSON.stringify(seen)}）`);
  assert.equal(getCall.redirect, 'manual', 'java.get 必须透传 redirect=manual');
  /**
   * ★★ 这两条**同时是「worker java 桩重复键」的运行时锁**（2026-10-11 实测）：
   *    该桩一度同时存在两份 `ajax`/`connect`/`post`，**后写覆盖前写** ⇒ 给前一份加
   *    `noRedirect` 是**死代码**（改一处不生效）。任何一次「同一键写两处」都会在这里红。
   */
  assert.ok(postCall, 'java.post 必须走到宿主 http');
  assert.equal(postCall.redirect, 'manual', 'java.post 必须透传 redirect=manual（上游 followRedirects(false)）');
  assert.ok(headCall, 'java.head 必须走到宿主 http（#387：补齐上游 JsExtensions.head）');
  assert.equal(headCall.redirect, 'manual', 'java.head 必须透传 redirect=manual');
  assert.ok(ajaxCall, 'java.ajax 也必须走宿主 http');
  assert.equal(ajaxCall.redirect, undefined, 'java.ajax 不得带 manual（上游 AnalyzeUrl 是 follow）');
});
