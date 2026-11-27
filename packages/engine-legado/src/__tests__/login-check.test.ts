/**
 * loginCheckJs 响应拦截器测试（对齐 Legado WebBook.kt:75/149/227/327/454）
 *
 * Legado 在 search / explore / bookInfo / toc / content 五处请求出口都会执行
 * `evalJS(loginCheckJs, strResponse)`，`result` 绑定是 `io.legado.app.help.http.StrResponse`。
 * 源用它做三件事：① 响应二次解密（点众阅读）；② 壳页解包 / WAF 处理（聚合书库、爱丽丝书屋）；
 * ③ 登录态检测（露西弗俱乐部、禁漫天堂）。
 *
 * 本套用**假站点**覆盖：解密改写 / 壳页重建 / headers 视图 / content 出口 /
 * 空返回保留 / 抛错不阻断 / code=500 → ANTI_BOT / 未声明时不执行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse, TraceEntry } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://lc.test';

function makeCtx(pages: Record<string, string>, headers: Record<string, string> = {}): { ctx: EngineContext; traces: TraceEntry[] } {
  const traces: TraceEntry[] = [];
  const ctx: EngineContext = {
    reqId: 'lc-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        const body = pages[url] ?? pages['*'] ?? '<html><body></body></html>';
        return { status: 200, headers: { 'content-type': 'text/html', ...headers }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink({ onEntry: (e) => traces.push(e) }),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return { ctx, traces };
}

function makeSrc(over: Record<string, unknown> = {}) {
  const raw = {
    bookSourceUrl: BASE,
    bookSourceName: '登录检测测试源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/1/' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    ...over,
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

const SEARCH_HTML =
  '<html><body><div id="enc">__ENC__</div>' +
  '<ul class="list"><li class="item"><a href="/book/1/">书一</a></li></ul></body></html>';

const DECODED_LIST = '<ul class="list"><li class="item"><a href="/book/9/">解码出来的书</a></li></ul>';

test('① 响应解密：loginCheckJs 返回新 StrResponse → 引擎用解密后的 body 解析', async () => {
  const b64 = Buffer.from(DECODED_LIST, 'utf-8').toString('base64');
  const rule = makeSrc({
    // 点众阅读式写法：Packages.io.legado.app.help.http.StrResponse(result.url(), decrypt(result.body()))
    loginCheckJs: `var b = result.body();
if (b.indexOf('__ENC__') >= 0) {
  result = Packages.io.legado.app.help.http.StrResponse(result.url(), java.base64Decode("${b64}"));
}
result;`,
  });
  const { ctx } = makeCtx({ '*': SEARCH_HTML });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.title, '解码出来的书', '登录检测脚本解密后的正文生效');
  assert.equal((out.items[0]!.payload as Record<string, unknown>)['bookUrl'], `${BASE}/book/9/`);
});

test('② 壳页重建：`String(result)` 可取到正文（url/body 兼容属性式与调用式两种写法）', async () => {
  const rule = makeSrc({
    loginCheckJs: `java.put('seenUrl', String(result.url));
java.put('seenBody', String(result.body).slice(0, 12));
result;`,
  });
  const { ctx } = makeCtx({ '*': SEARCH_HTML });
  await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(ctx.variables.get('seenUrl'), `${BASE}/s?q=%E6%88%91`);
  assert.equal(ctx.variables.get('seenBody'), SEARCH_HTML.slice(0, 12));
});

test('③ headers() 视图：可读 set-cookie / 大小写不敏感', async () => {
  const rule = makeSrc({
    loginCheckJs: `var ck = String(result.headers().get('set-cookie'));
java.put('ck', ck);
java.put('ckUpper', String(result.headers().get('Set-Cookie')));
java.put('ckSize', result.headers().size());
result;`,
  });
  const { ctx } = makeCtx({ '*': SEARCH_HTML }, { 'set-cookie': 'sid=abc; Path=/' });
  await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(ctx.variables.get('ck'), 'sid=abc; Path=/');
  assert.equal(ctx.variables.get('ckUpper'), 'sid=abc; Path=/', '大小写不敏感（okhttp Headers.get 语义）');
  assert.equal(String(ctx.variables.get('ckSize')), '2');
});

test('④ content 出口同样执行：正文页被脚本改写后进入正文管道', async () => {
  const rule = makeSrc({
    loginCheckJs: `result = Packages.io.legado.app.help.http.StrResponse(result.url(), '<div class="con"><p>解密后的正文一</p><p>解密后的正文二</p></div>');
result;`,
  });
  const { ctx } = makeCtx({ '*': '<html><body><div class="con">原始正文</div></body></html>' });
  const out = await new LegadoEngine().content(
    rule as never,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c/1`, title: '第一章' }) },
    ctx,
  );
  assert.deepEqual(out.paragraphs, ['解密后的正文一', '解密后的正文二']);
});

test('⑤ chapter/title 绑定在 loginCheckJs 里可用（Legado AnalyzeUrl 带 chapter）', async () => {
  const rule = makeSrc({
    loginCheckJs: `java.put('ct', String(chapter.title));
result;`,
  });
  const { ctx } = makeCtx({ '*': '<html><body><div class="con">正文</div></body></html>' });
  await new LegadoEngine().content(
    rule as never,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c/7`, title: '第七章' }) },
    ctx,
  );
  assert.equal(ctx.variables.get('ct'), '第七章');
});

test('⑥ 脚本返回空 → 保留原响应（不破坏未用到该特性的分支）', async () => {
  const rule = makeSrc({ loginCheckJs: `java.log('noop');` });
  const { ctx } = makeCtx({ '*': SEARCH_HTML });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.title, '书一');
});

test('⑦ 脚本抛错 → 保留原响应，trace 记录（不让检测脚本炸掉整个请求）', async () => {
  const rule = makeSrc({ loginCheckJs: `throw new Error('检测脚本自身异常')` });
  const { ctx, traces } = makeCtx({ '*': SEARCH_HTML });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(out.items.length, 1, '请求结果不受影响');
  const hit = traces.find((t) => t.rule === 'loginCheckJs');
  assert.ok(hit, 'trace 里有 loginCheckJs 记录');
  assert.match(String(hit!.error), /检测脚本自身异常/);
});

test('⑧ 返回 code=500 → 抛 ANTI_BOT（Legado 的「未登录/验证未通过」信号）', async () => {
  const rule = makeSrc({
    loginCheckJs: `result = Packages.io.legado.app.help.http.StrResponse(result.url(), '请先登录', 500);
result;`,
  });
  const { ctx } = makeCtx({ '*': SEARCH_HTML });
  await assert.rejects(
    () => new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx),
    (e: { code?: string; detail?: { rule?: string } }) => e.code === 'ANTI_BOT' && e.detail?.rule === 'loginCheckJs',
  );
});

test('⑧b 末表达式是字符串/空值 → 保留原响应（环境探测脚本常见，不得把 body 换掉）', async () => {
  // 真实案例：兽人小说站 / Linpx 的 loginCheckJs 末行是 `java.getStrResponse(null, null)`，
  // 我们桩返回 ''；曾据此把 body 换成 '' → 页面全空 → 整源 RULE_PARSE。
  const rule = makeSrc({ loginCheckJs: `var s = result.body();\njava.log(s.length);\n''` });
  const { ctx } = makeCtx({ '*': SEARCH_HTML });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(out.items.length, 1, '原响应必须保留');
  assert.equal(out.items[0]!.title, '书一');
});

test('⑧c java.startBrowserAwait 返回 StrResponse 兼容对象（Legado JsExtensions.kt:364）', async () => {
  const rule = makeSrc({
    // 降级为静态抓取时也应返回「可当响应替换」的对象（霹雳书屋式写法）
    loginCheckJs: `if (result.code() === 200) {
  result = Packages.io.legado.app.help.http.StrResponse(result.url(), result.body());
}
result;`,
  });
  const { ctx } = makeCtx({ '*': SEARCH_HTML });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(out.items.length, 1);
});

test('⑨ 未声明 loginCheckJs 时不执行（零开销路径）', async () => {
  const rule = makeSrc();
  const { ctx, traces } = makeCtx({ '*': SEARCH_HTML });
  const out = await new LegadoEngine().search(rule as never, { action: 'search', keyword: '我' }, ctx);
  assert.equal(out.items.length, 1);
  assert.equal(traces.filter((t) => t.rule === 'loginCheckJs').length, 0);
});
