/**
 * 回归锁：**正文段落切分** —— 块级标签的「开标签」也算段落边界。
 *
 * 实测（绿柠小说 `downloadchapter.do` 的 `Content` 解密后）：
 *   `今日，京城乌云滚滚，大雨倾盆。<p>街上商铺大门紧闭…<p>当今圣上多情…`
 * 站点用**省略闭合**的裸 `<p>` 分隔段落（HTML5 允许）。旧实现只把 `</p>`/`<br>` 转换行，
 * 于是整章被并成**一段**（前端显示成一坨）。
 *
 * 对齐 HTML 渲染语义：`<br>` 与块级标签（p/div/section/article/h1-6/li/blockquote/dd/dt）的
 * **开或闭**标签都产生换行边界；空行会被过滤（不会产出空段落）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://p.test';

function makeSrc(content: string) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '段落切分回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
    ruleContent: { content },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

function makeCtx(body: string) {
  const ctx: EngineContext = {
    reqId: 'para',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, _o?: HttpRequestOptions): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
  return ctx;
}

/** 正文规则直接返回 HTML 片段（`@js:` 里用 JSON 转义，避免被当选择器解析） */
async function paragraphsOf(html: string): Promise<string[]> {
  const rule = makeSrc(`@js: ${JSON.stringify(html)}`);
  const out = await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c` }) },
    makeCtx(html),
  );
  return out.paragraphs;
}

test('裸 <p>（无闭合）必须切成多段（实测绿柠小说形态）', async () => {
  const ps = await paragraphsOf('第一段。<p>第二段。<p>第三段。');
  assert.deepEqual(ps, ['第一段。', '第二段。', '第三段。'], JSON.stringify(ps));
});

test('<br> 与标准闭标签同样算边界；空行不产出空段落', async () => {
  const ps = await paragraphsOf('甲<br>乙<p></p><div>丙</div>\n\n丁');
  assert.deepEqual(ps, ['甲', '乙', '丙', '丁'], JSON.stringify(ps));
});

test('行内标签不影响段落数（只有块级边界才切）', async () => {
  const ps = await paragraphsOf('<p>带<strong>加粗</strong>与<a href="#">链接</a>的一段</p><p>另一段</p>');
  assert.deepEqual(ps, ['带加粗与链接的一段', '另一段'], JSON.stringify(ps));
});
