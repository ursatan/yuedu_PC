/**
 * engine-legado 离线测试（不依赖网络）
 *
 * 覆盖 M1（Legado L1 选择器引擎）验收项：
 *   1) CSS 选择器：@attr 属性指令、## 清洗、&& || 组合符
 *   2) JSONPath 选择器：|| 降级
 *   3) 引擎全链路：search → detail → content（用 mock HttpClient 注入本地 fixture）
 *
 * 跑法：pnpm --filter @yuedu/engine-legado test
 * 或：  pnpm -r test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AnalyzeRule,
  parseHtml,
  createVariableStore,
  createTraceSink,
  createJsEvaluator,
  type AnalyzeEnv,
  type EngineContext,
  type HttpClient,
  type HttpResponse,
} from '@yuedu/core';
import { LegadoEngine, type CompiledBookSource } from './index';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => readFileSync(join(here, '__tests__', 'fixtures', f), 'utf-8');

const listHtml = load('list.html');
const detailHtml = load('detail.html');
const contentHtml = load('content.html');
const listJson = load('list.json');

// ---- 选择器引擎单元测试用的 env ----
function makeEnv(): AnalyzeEnv {
  const variables = createVariableStore();
  return {
    baseUrl: 'http://fake.test',
    variables,
    jsEval: createJsEvaluator({ variables }),
  };
}

// ---- 引擎用的 mock 基础设施 ----
function makeHttp(): HttpClient {
  return {
    async request(url: string): Promise<HttpResponse> {
      let body = '';
      if (url.includes('/search')) body = listHtml;
      else if (url.includes('/b/')) body = detailHtml;
      else if (url.includes('/ch/')) body = contentHtml;
      return { status: 200, headers: {}, body, url };
    },
  };
}

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't',
    sourceId: 'fake.test',
    signal: new AbortController().signal,
    http,
    sandbox: { async eval<T = unknown>() { return undefined as T; } },
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: { async get() { return null; }, async set() {}, async delete() {} },
  };
}

const source: CompiledBookSource = {
  bookSourceName: '测试书源',
  bookSourceUrl: 'http://fake.test',
  searchUrl: 'http://fake.test/search?q={{key}}',
  ruleSearch: {
    bookList: '.item',
    name: '.name',
    author: '.author',
    coverUrl: '.cover@src',
    intro: '.intro',
    bookUrl: '.name@href',
  },
  ruleBookInfo: {
    name: '.title',
    author: '.author',
    coverUrl: '.cover@src',
    intro: '.intro',
  },
  ruleToc: {
    chapterList: '.toc li',
    chapterName: 'a',
    chapterUrl: 'a@href',
  },
  ruleContent: {
    content: '#chapter',
  },
};

// =====================================================================
// 1) CSS 选择器：@attr / ## / && || %%
// =====================================================================
test('CSS：@attr 属性指令', async () => {
  const env = makeEnv();
  const root = parseHtml(listHtml).root;
  const items = await new AnalyzeRule(env).setContent(root).getElements('.item');
  assert.equal(items.length, 2);
  assert.equal(await new AnalyzeRule(env).setContent(items[0]!).getString('.name'), '雪中悍刀行');
  assert.equal(await new AnalyzeRule(env).setContent(items[0]!).getString('.name@href'), '/b/xuezhong.html');
  assert.equal(await new AnalyzeRule(env).setContent(items[0]!).getString('.cover@src'), '/c/xuezhong.jpg');
});

test('CSS：## 清洗（压掉内部空白）', async () => {
  const env = makeEnv();
  const root = parseHtml(listHtml).root;
  const items = await new AnalyzeRule(env).setContent(root).getElements('.item');
  const intro = await new AnalyzeRule(env).setContent(items[0]!).getString('.intro##\\s+');
  assert.equal(intro, '北凉世子的江湖');
});

test('CSS：|| 取首个非空', async () => {
  const env = makeEnv();
  const root = parseHtml(listHtml).root;
  const items = await new AnalyzeRule(env).setContent(root).getElements('.item');
  // .missing 取不到，降级到 .name
  assert.equal(
    (await new AnalyzeRule(env).setContent(items[0]!).getString('.missing || .name')),
    '雪中悍刀行',
  );
});

test('CSS：&& 顺序拼接', async () => {
  const env = makeEnv();
  const root = parseHtml(listHtml).root;
  const items = await new AnalyzeRule(env).setContent(root).getElements('.item');
  const combined = await new AnalyzeRule(env).setContent(items[0]!).getString('.name && .author');
  assert.ok(combined.includes('雪中悍刀行'));
  assert.ok(combined.includes('烽火戏诸侯'));
});

// =====================================================================
// 2) JSONPath 选择器：|| 降级
// =====================================================================
test('JSONPath：基础取值 + || 降级', async () => {
  const env = makeEnv();
  const json = JSON.parse(listJson);
  const ar = new AnalyzeRule(env).setContent(json);
  assert.equal(await ar.getString('$.data.books[0].bookName'), '雪中悍刀行');
  // title 字段不存在 → 降级到 bookName
  assert.equal(
    await ar.getString('$.data.books[0].title || $.data.books[0].bookName'),
    '雪中悍刀行',
  );
  assert.equal((await ar.getElements('$.data.books')).length, 2);
});

// =====================================================================
// 3) {{}} 变量插值（JS 求值器返回表达式值）
// =====================================================================
test('{{}} 插值：JS 求值器返回表达式值', () => {
  const env = makeEnv();
  const v = env.jsEval('key', { $: '', key: '雪中悍刀行', page: 1 });
  assert.equal(v, '雪中悍刀行');
});

// =====================================================================
// 4) 引擎全链路：search → detail → content
// =====================================================================
test('引擎：detect / compile', () => {
  const engine = new LegadoEngine();
  assert.equal(engine.detect(source), true);
  // MacCMS 这种不是书源
  assert.equal(engine.detect({ apiUrl: 'http://x' }), false);
  // 编译非书源应失败
  assert.equal(engine.compile({ apiUrl: 'http://x' }).ok, false);
  // 编译正常书源成功
  assert.equal(engine.compile(source).ok, true);
});

test('#312：纯发现源（只有 exploreUrl，无搜索侧规则）必须被认作 Legado 书源', () => {
  const engine = new LegadoEngine();
  const discoverOnly = {
    bookSourceUrl: 'https://d.example.com',
    bookSourceName: '无搜索源',
    exploreUrl: 'https://d.example.com/list?page={{page}}',
    ruleExplore: { bookList: '.item', name: '.t' },
  };
  // 旧判据要求「有主键**且**有 searchUrl/ruleSearch/ruleBookInfo/ruleToc 之一」
  // ⇒ 这个源被判「不是 Legado 书源」而导入失败（`#312`）。
  assert.equal(engine.detect(discoverOnly), true, '上游只要求主键非空（BookSourceImport.requireBookSourceUrl）');
  assert.equal(engine.compile(discoverOnly).ok, true, '编译必须通过（否则导入层放行、引擎层报错）');
  // 对偶①：缺主键仍必须判否（上游 BookSourceImportTest 的「Missing URL」用例）
  assert.equal(engine.detect({ bookSourceName: '没有URL' }), false);
  // 对偶②：MacCMS 仍必须判否（判据没有被放宽成「什么都认」）
  assert.equal(engine.detect({ apiUrl: 'http://x' }), false);
});

test('引擎：search → detail → content 全链路（mock http）', async () => {
  const engine = new LegadoEngine();
  const compiled = engine.compile(source);
  assert.ok(compiled.ok);
  const rule = compiled.rule!;
  const ctx = makeCtx(makeHttp());

  // ---- search ----
  const list = await engine.search(
    rule,
    { action: 'search', keyword: '雪中', page: 1 },
    ctx,
  );
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]!.title, '雪中悍刀行');
  // bookUrl 经 toAbsolute 绝对化
  assert.equal(
    (list.items[0]!.payload as Record<string, string>).bookUrl,
    'http://fake.test/b/xuezhong.html',
  );

  // ---- detail ----
  const detail = await engine.detail(
    rule,
    { action: 'detail', id: (list.items[0]!.payload as Record<string, string>).bookUrl },
    ctx,
  );
  assert.equal(detail.title, '雪中悍刀行');
  assert.equal(detail.subtitle, '烽火戏诸侯');
  assert.ok(detail.chapters && detail.chapters.length === 3);
  assert.equal(detail.chapters![0]!.title, '第一章 竹林听雨');
  assert.equal(
    (detail.chapters![0]!.payload as Record<string, string>).chapterUrl,
    'http://fake.test/ch/1.html',
  );

  // ---- content ----
  const content = await engine.content(
    rule,
    { action: 'content', id: (detail.chapters![0]!.payload as Record<string, string>).chapterUrl },
    ctx,
  );
  // #chapter 是单块文本（4 个 <p> 被拼成一段），至少包含首句
  assert.ok(content.paragraphs.length >= 1);
  assert.match(content.paragraphs.join(''), /北凉/);
});

// ---------------------------------------------------------------------------
// `#334` 正文页状态码闸门：4xx/5xx 不再当正文下发（与 engine-rss 同一条整类修复）
// ---------------------------------------------------------------------------

/** 只给 `/ch/` 返回指定状态码（正文页），其余照旧 200 —— 保证「闸门只拦正文页」 */
function makeHttpWithContentStatus(status: number): HttpClient {
  return {
    async request(url: string): Promise<HttpResponse> {
      let body = '';
      if (url.includes('/search')) body = listHtml;
      else if (url.includes('/b/')) body = detailHtml;
      else if (url.includes('/ch/')) body = contentHtml;
      return { status: url.includes('/ch/') ? status : 200, headers: {}, body, url };
    },
  };
}

async function contentOf(status: number) {
  const engine = new LegadoEngine();
  const compiled = engine.compile(source);
  const rule = compiled.rule!;
  const ctx = makeCtx(makeHttpWithContentStatus(status));
  const list = await engine.search(rule, { action: 'search', keyword: '雪中', page: 1 }, ctx);
  const detail = await engine.detail(
    rule,
    { action: 'detail', id: (list.items[0]!.payload as Record<string, string>).bookUrl },
    ctx,
  );
  return engine.content(
    rule,
    { action: 'content', id: (detail.chapters![0]!.payload as Record<string, string>).chapterUrl },
    ctx,
  );
}

test('#334 content：正文页 HTTP 404 ⇒ 抛 NETWORK（不把错误页当正文）', async () => {
  await assert.rejects(
    () => contentOf(404),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'NETWORK', `应为 NETWORK，实际 ${String(e)}`);
      assert.match(String((e as { detail?: { rule?: string } }).detail?.rule ?? ''), /404/);
      return true;
    },
  );
});

test('#334 对偶（防空转）：正文页 200 ⇒ 照常解析出正文（上面那条链路本来就通）', async () => {
  const c = await contentOf(200);
  assert.ok(c.paragraphs.length >= 1, '200 时应正常出正文');
  assert.match(c.paragraphs.join(''), /北凉/);
});
