/**
 * `#617` **精确搜索 / 详情页直出**（`bookUrlPattern`）—— 2026-10-25。
 *
 * 上游依据 `model/webBook/BookList.kt:62-78`：
 * ```kotlin
 * if (isSearch) bookSource.bookUrlPattern?.let {
 *     if (baseUrl.matches(it.toRegex())) {   // baseUrl = res.url（实际响应 URL）
 *         getInfoItem(...)                   // 复用已抓到的 body 走 ruleBookInfo
 *         return bookList
 *     }
 * }
 * ```
 * 语义要点（本文件逐条锁死）：
 *  ① 命中 ⇒ **单本**直出，且**复用已抓到的响应体**（不重抓 —— 搜索 URL 常是 POST）；
 *  ② 不命中 ⇒ 完全走原列表规则（回归护栏）；
 *  ③ 命中判定是 **Kotlin `String.matches` = 整串匹配**，不是「包含」；
 *  ④ 正则写坏 ⇒ 退化为普通搜索 + 留痕，**不**把搜索打挂；
 *  ⑤ 命中但解不出书名 ⇒ 空列表 + hint，**不**回落到列表规则产出垃圾条目；
 *  ⑥ 只在**搜索**生效（`isSearch`），发现/分类不受影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
  type UnifiedRequest,
} from '@yuedu/core';
import { LegadoEngine } from '../engine';

const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('sandbox 不可用（L1 引擎不用它）');
  },
};

/** 记录请求次数/URL 的假网络：**响应 URL 由测试指定**（模拟跳转落点或 API 端点） */
function mockHttp(body: string, respUrl: string, seen: string[] = []): HttpClient {
  return {
    async request(url: string) {
      seen.push(url);
      return { status: 200, headers: {}, body, url: respUrl };
    },
  };
}

function makeCtx(http: HttpClient, sourceId = 'bup-617'): EngineContext {
  return {
    reqId: 't',
    sourceId,
    signal: new AbortController().signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

const engine = new LegadoEngine();
const compile = (raw: Record<string, unknown>) => {
  const r = engine.compile(raw);
  assert.ok(r.ok && r.rule, `compile 应通过：${JSON.stringify(r.issues ?? [])}`);
  return r.rule;
};

const LIST_HTML = `<ul class="list">
  <li><a href="/book/1">书一</a><span class="author">作者甲</span></li>
  <li><a href="/book/2">书二</a><span class="author">作者乙</span></li>
</ul>`;

const DETAIL_HTML = `<html><body>
  <h1 class="name">执子之剑</h1>
  <span class="author">鸠也</span>
  <p class="intro">简介文本</p>
  <img class="cover" src="/img/1.jpg">
  <span class="last">第12话</span>
  <span class="tags">热血,冒险</span>
</body></html>`;

/** 搜索接口直接回一本书的详情页（典型形态：晋江 / 小米阅读 / 听友M） */
function detailOutSource(pattern = 'https://t\\.test/book/\\d+') {
  return {
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '精确搜索',
    searchUrl: 'https://t.test/search?q={{key}}',
    bookUrlPattern: pattern,
    ruleSearch: { bookList: '.list > li', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: {
      name: '.name@text',
      author: '.author@text',
      intro: '.intro@text',
      coverUrl: '.cover@src',
      lastChapter: '.last@text',
      kind: '.tags@text',
    },
  };
}

const searchReq = { action: 'search', keyword: '执子之剑', page: 1 } as unknown as UnifiedRequest;

test('#617 ① bookUrlPattern 命中 ⇒ 单本直出，且**复用已抓响应**（只发 1 次请求）', async () => {
  const seen: string[] = [];
  const http = mockHttp(DETAIL_HTML, 'https://t.test/book/123', seen);
  const r = await engine.search(compile(detailOutSource()), searchReq, makeCtx(http));

  assert.equal(r.items.length, 1, `应只出 1 本，实际 ${r.items.length}`);
  const it = r.items[0]!;
  assert.equal(it.title, '执子之剑', '书名取自 ruleBookInfo');
  assert.equal(it.subtitle, '鸠也', '作者取自 ruleBookInfo');
  assert.equal(it.summary, '简介文本', '简介取自 ruleBookInfo');
  assert.ok(String(it.cover).includes('1.jpg'), `封面应取到：${it.cover}`);
  assert.deepEqual(it.tags, ['热血', '冒险'], '标签走 splitTags');
  const payload = it.payload as Record<string, string>;
  assert.equal(payload['name'], '执子之剑', 'payload.name 必须带（#588：否则详情页把链接当书名）');
  assert.equal(payload['bookUrl'], 'https://t.test/book/123', 'bookUrl = 实际响应 URL');
  assert.equal(payload['author'], '鸠也');
  assert.equal(payload['lastChapter'], '第12话');

  // ★ 关键：只发一次请求（复用 body，不转调 detail() 重抓）
  assert.equal(seen.length, 1, `不得重抓，实际请求 ${seen.length} 次：${JSON.stringify(seen)}`);
  assert.ok(seen[0]!.includes('/search'), `首次请求应是搜索 URL：${seen[0]}`);
});

test('#617 ② 未命中 ⇒ 完全走原列表规则（回归护栏）', async () => {
  const seen: string[] = [];
  const http = mockHttp(LIST_HTML, 'https://t.test/search?q=abc', seen);
  const r = await engine.search(compile(detailOutSource()), searchReq, makeCtx(http));

  assert.equal(r.items.length, 2, '应走列表规则出 2 条');
  assert.deepEqual(
    r.items.map((x) => x.title),
    ['书一', '书二'],
  );
  // 列表项的 bookUrl 走 isUrl 求值 → 绝对化
  assert.ok(String((r.items[0]!.payload as Record<string, string>)['bookUrl']).endsWith('/book/1'));
  assert.equal(seen.length, 1);
});

test('#617 ③ 判定是**整串匹配**（Kotlin String.matches），不是「包含」', async () => {
  // pattern 能匹配 `…/book/123`，但响应 URL 是 `…/book/123/extra` ⇒ 上游不命中
  const http = mockHttp(LIST_HTML, 'https://t.test/book/123/extra');
  const r = await engine.search(compile(detailOutSource()), searchReq, makeCtx(http));
  assert.equal(r.items.length, 2, '多出的路径段不应被判命中（走列表）');
});

test('#617 ④ 正则写坏 ⇒ 退化为普通搜索 + 留痕，不把搜索打挂', async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  };
  try {
    const http = mockHttp(LIST_HTML, 'https://t.test/book/123');
    // 未闭合分组 = 非法正则
    const r = await engine.search(compile(detailOutSource('https://t.test/(book')), searchReq, makeCtx(http));
    assert.equal(r.items.length, 2, '非法正则时应按普通列表搜索出结果');
    assert.ok(
      warns.some((w) => w.includes('bookUrlPattern') && w.includes('不是合法正则')),
      `应有留痕，实际 warns=${JSON.stringify(warns.slice(0, 3))}`,
    );
  } finally {
    console.warn = orig;
  }
});

test('#617 ⑤ 命中但解不出书名 ⇒ 空列表 + hint，不回落列表规则', async () => {
  const src = detailOutSource();
  src.ruleBookInfo = { ...src.ruleBookInfo, name: '.not-exist@text' };
  const http = mockHttp(DETAIL_HTML, 'https://t.test/book/123');
  const r = await engine.search(compile(src), searchReq, makeCtx(http));
  assert.equal(r.items.length, 0, '不应回落到列表规则（那会把详情页当列表页解出垃圾条目）');
  assert.ok(String(r.hint ?? '').includes('未解析出书名'), `hint 应说明原因：${r.hint}`);
});

test('#617 ⑥ 只在搜索生效：发现/分类路径不受 bookUrlPattern 影响', async () => {
  const src = {
    ...detailOutSource(),
    exploreUrl: '全部::https://t.test/list',
  };
  // 分类请求的响应 URL 同样**命中** pattern，但 mode=home ⇒ 不该走单本分支
  const http = mockHttp(LIST_HTML, 'https://t.test/book/123');
  const r = await engine.category(
    compile(src),
    { action: 'category', filters: { explore: 'https://t.test/list' } } as unknown as UnifiedRequest,
    makeCtx(http),
  );
  assert.equal(r.items.length, 2, '发现/分类仍是列表解析（上游 isSearch 才判 pattern）');
});

test('#617 ⑦ bookUrlPattern 为 NONE/空 ⇒ 视作未配置（不与普通搜索冲突）', async () => {
  for (const p of ['', 'NONE', undefined]) {
    const src = { ...detailOutSource(), bookUrlPattern: p as string | undefined };
    const http = mockHttp(LIST_HTML, 'https://t.test/book/123');
    const r = await engine.search(compile(src), searchReq, makeCtx(http));
    assert.equal(r.items.length, 2, `pattern=${JSON.stringify(p)} 时应走普通列表`);
  }
});

/**
 * `#617 ①b` 上游 `BookList.kt:100-110`：**列表为空 且 源没配 pattern** ⇒ 按详情页解析。
 * 与 ① 是**互补条件**：配了 pattern 的源未命中就认输（不回落到这条兜底）。
 */
test('#617 ①b 列表规则空 + 未配 pattern ⇒ 按详情页解析出 1 本', async () => {
  const src = {
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '空列表回退',
    searchUrl: 'https://t.test/search?q={{key}}',
    // 列表规则命中不到任何元素（搜索页本身就是详情页）
    ruleSearch: { bookList: '.no-such-list > li', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: '.name@text', author: '.author@text', intro: '.intro@text' },
  };
  const http = mockHttp(DETAIL_HTML, 'https://t.test/search?q=abc');
  const r = await engine.search(compile(src), searchReq, makeCtx(http));
  assert.equal(r.items.length, 1, `应回退为详情页解析出 1 本，实际 ${r.items.length}`);
  assert.equal(r.items[0]!.title, '执子之剑');
  assert.equal(r.items[0]!.subtitle, '鸠也');
});

test('#617 ①b 反向：配了 pattern 但未命中 ⇒ **不**走这条兜底（认输返回空）', async () => {
  const src = {
    ...detailOutSource(),
    // 列表规则同样命中不到东西
    ruleSearch: { bookList: '.no-such-list > li', name: 'a@text', bookUrl: 'a@href' },
  };
  const http = mockHttp(DETAIL_HTML, 'https://t.test/search?q=abc'); // 响应 URL 不匹配 pattern
  const r = await engine.search(compile(src), searchReq, makeCtx(http));
  assert.equal(r.items.length, 0, '配了 pattern 的源未命中时应认输（上游条件 isNullOrEmpty）');
});

test('#617 ①b 列表为空且无 ruleBookInfo ⇒ 仍返回空（不凭空造条目）', async () => {
  const src = {
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '空列表无详情规则',
    searchUrl: 'https://t.test/search?q={{key}}',
    ruleSearch: { bookList: '.no-such-list > li', name: 'a@text', bookUrl: 'a@href' },
  };
  const http = mockHttp(DETAIL_HTML, 'https://t.test/search?q=abc');
  const r = await engine.search(compile(src), searchReq, makeCtx(http));
  assert.equal(r.items.length, 0);
});

