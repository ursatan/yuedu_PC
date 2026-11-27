/**
 * 回归锁：**`content` 请求里 `book.type` 必须存在**（Legado 传的是完整 Book）。
 *
 * 背景：`Book.type` 是**位标记**（`BookType.kt`：`video 4 / text 8 / audio 32 / image 64 /
 * webFile 128 / notShelf 1024`），与源自身的 `bookSourceType`（0~4）是两套编号，
 * 由 `BookSource.getBookType()` 从后者推出（`BookSourceExtensions.kt:131-139`）。
 * 源脚本大量用它做正文分流，典型写法就是下面这条（📷🔞HentaiCosplay 原文）：
 *
 * ```js
 * if (book.type == 64 || book.type == 1088) {   // 1088 = image(64) | notShelf(1024)
 *     …从页面里抠 <amp-img> 拼成 <img src="…">…
 * } else {
 *     java.startBrowser(path, book.name);       // 走浏览器，只回一个 URL
 *     path
 * }
 * ```
 *
 * 本仓此前**只有 `detail` 设过 `env.bookData`**，`content` 从没设过 ⇒ `book.type` 恒
 * `undefined` ⇒ 分流恒落 else ⇒ 用户实测「本话图片加载为空」（拿到的还是
 * `result.indexOf("source")` 为 -1 时切出来的垃圾串，连一个像样的 URL 都不是）。
 *
 * ★ 锁的是**引擎给不给 `book.type`**（这条不依赖站点还活着），不是某个站点的页面结构：
 *   页面用固定偏移合成（脚本里写死的 `+25`），与线上取图逻辑同形态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

/** 脚本里的固定偏移：`pathStart = idx("<amp-img") + 8 + 25` ⇒ 属性段必须正好 25 字符 */
const PAD = ' data-x="123456789" src="';
assert.equal(PAD.length, 25, 'PAD 长度变化会让下面的取图断言失去意义');

const IMGS = ['https://cdn.test/p/1.webp', 'https://cdn.test/p/2.webp', 'https://cdn.test/p/3.webp'];
/** 每张图之间 > 200 字符（脚本里 `index = pathStart + 200` 跳步） */
const PAGE =
  '<html><body><div class="ch"><a href="/ch/1">第1话</a></div>' +
  IMGS.map((u) => `<amp-img${PAD}${u}" width="800" height="1200" layout="responsive"></amp-img>` + 'z'.repeat(260)).join('') +
  '</body></html>';

/** 与线上同形态的正文规则：`book.type` 是图片 ⇒ 抠图；否则走浏览器只回一个标记串 */
const RULE_JS = [
  '@js:',
  'if(book.type==64||book.type==1088){',
  '  let results = [];',
  '  let searchTerm = "<amp-img";',
  '  let index = 0;',
  '  while (index < result.length) {',
  '    let imgPathIndex = result.indexOf(searchTerm, index);',
  '    if (imgPathIndex === -1) break;',
  '    let pathStart = imgPathIndex + searchTerm.length+25;',
  '    let path = result.slice(pathStart, result.indexOf("\\"",pathStart));',
  '    results.push(path);',
  '    index = pathStart + 200;',
  '  }',
  '  result=[]',
  '  results.map(i=>result.push("<img src=\\""+i+"\\">"))',
  '  result.join("")',
  '}else{',
  '  "NO_TYPE"',
  '}',
].join('\n');

function makeSrc(bookSourceType: number, contentRule: string, tocRule?: string) {
  const out = compileBookSource({
    bookSourceUrl: 'https://k.test/',
    bookSourceName: 'book.type 回归源',
    bookSourceType,
    searchUrl: 'https://k.test/search?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: tocRule
      ? { chapterList: tocRule, chapterName: 'name', chapterUrl: 'url' }
      : { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: contentRule },
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

function makeCtx(): EngineContext {
  return {
    reqId: 'bt',
    sourceId: 'bt',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body: PAGE, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

async function runContent(type: number, contentRule: string) {
  const rule = makeSrc(type, contentRule);
  const engine = new LegadoEngine();
  const ctx = makeCtx();
  const d = await engine.detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'https://k.test/book/1', name: 'T' }) },
    ctx,
  );
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  return engine.content(rule as never, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
}

/**
 * 读 `book.type` 的值：⚠️ **不能让脚本直接返回 `String(book.type)`** —— 图片源的正文结果
 * 会再走一遍「图片抽取」（`paragraphs` 里只剩 URL），纯数字文本会被抽没（实测拿到 `''`）。
 * ⇒ 把值编进一个 `<img src>` 里，抽取后 paragraphs[0] 就是它。
 */
async function readTypeViaContent(type: number): Promise<string> {
  const c = await runContent(type, '@js: "<img src=\\"t" + book.type + "\\">"');
  // 相对地址会被补全成 `https://k.test/ch/t64` ⇒ 只看后缀
  return String(c.paragraphs[0] ?? '').replace(/^.*\//, '');
}

/** 另一条读法：走目录脚本（章名是纯文本，不受正文 kind 抽取影响） */
async function readTypeViaToc(type: number): Promise<string> {
  const rule = makeSrc(type, 'class.x@text', '@js: [{name: "t" + book.type, url: "/ch/1"}]');
  const d = await new LegadoEngine().detail(
    rule as never,
    { action: 'detail', id: JSON.stringify({ bookUrl: 'https://k.test/book/1', name: 'T' }) },
    makeCtx(),
  );
  return d.chapters?.[0]?.title ?? '';
}

test('#592 content 的 book 桩必须带 type：图片源(2) ⇒ 64', async () => {
  assert.equal(await readTypeViaContent(2), 't64', 'content 里图片源的 book.type 应为 64');
  assert.equal(await readTypeViaToc(2), 't64', 'detail/目录里也应带 type（源脚本常在这里读它）');
});

test('#592 图片源：正文规则按 book.type 走「抠图」分支 ⇒ 拿到三张图', async () => {
  const c = await runContent(2, RULE_JS);
  const joined = c.paragraphs.join('\n');
  assert.doesNotMatch(joined, /NO_TYPE/, '不该走 else 分支');
  assert.deepEqual(c.paragraphs, IMGS, '应逐张拿到页面里的图片 URL');
});

/** 防空转：证明上面的断言真的依赖 `type`（不是脚本恒走 if 支） */
test('#592 防空转：文本源(0) ⇒ type 8 ⇒ 同一脚本走 else 分支', async () => {
  const c = await runContent(0, RULE_JS);
  assert.match(c.paragraphs.join(''), /NO_TYPE/, '文本源不该被当成图片源抠图');
});

test('#592 其余源类型的 type 取值（audio 32 / video 4 / file 136 / text 8）', async () => {
  assert.equal(await readTypeViaToc(1), 't32');
  assert.equal(await readTypeViaToc(4), 't4');
  // 上游 `BookSourceType.file -> BookType.text or BookType.webFile`
  assert.equal(await readTypeViaToc(3), 't136');
  assert.equal(await readTypeViaToc(0), 't8');
});
