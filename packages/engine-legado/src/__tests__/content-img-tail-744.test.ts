/**
 * `#744` 回归锁：**图片源正文的 `<img src>` 选项尾巴必须完整保留**。
 *
 * 真实现象（哔咔漫画〔自包含〕，`bookSourceType=2`，`ruleContent.imageStyle=FULL`）：
 * 源 `picac_img` 产出 `http://<CF IP>/static/…jpg,{"method":"GET","headers":{"Host":"storage-b…"}}`，
 * 引擎此前在「图片源」分支把 `,{…}` 尾巴**整个丢掉** ⇒ 前端 `imgSrc` 拿不到 `Host`
 * ⇒ `/api/proxy` 按 `Host: <IP>` 建连 ⇒ CF 回 `403 error code: 1003`，正文全裂。
 *
 * 用 `@js:result`（= 原样吃响应体，不过 DOM 解析）喂 `<img>` 串，最贴近真实源：
 * 哔咔 `ruleContent` 也是 `<js>` 自己拼字符串，**没有** DOM 序列化那一层。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

function makeCtx(body: string): EngineContext {
  return {
    reqId: 'img-tail-744',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        const isChapter = /\/ch\//.test(url);
        return {
          status: 200,
          headers: { 'content-type': isChapter ? 'text/plain' : 'text/html' },
          body: isChapter ? body : '<html><body><div class="ch"><a href="/ch/1">第1章</a></div></body></html>',
          url,
        };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

async function runContent(body: string) {
  const out = compileBookSource({
    bookSourceUrl: 'https://k.test',
    bookSourceName: '图片尾巴测试源',
    bookSourceType: 2,
    searchUrl: 'https://k.test/search?q={{key}}',
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '{{baseUrl}}' },
    ruleToc: { chapterList: '.ch', chapterName: 'a@text', chapterUrl: 'a@href' },
    // `@js:result` = 响应体原样返回（与哔咔 `<js>` 拼串同形态，不经 DOM 序列化）
    ruleContent: { content: '@js:result', imageStyle: 'FULL' },
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  const engine = new LegadoEngine();
  const ctx = makeCtx(body);
  const d = await engine.detail(out.rule!, { action: 'detail', id: JSON.stringify({ bookUrl: 'https://k.test/book/1' }) }, ctx);
  const ch0 = d.chapters?.[0];
  assert.ok(ch0, '应有章节');
  return engine.content(out.rule!, { action: 'content', id: JSON.stringify(ch0.payload) }, ctx);
}

const PICA_TAIL = ',{"method":"GET","timeout":30000,"headers":{"Host":"storage-b.picacomic.com"}}';

test('#744 图片源：`src` 的裸引号选项尾巴完整保留（不截断、不丢弃）', async () => {
  // 源里是真的裸双引号（不是 &quot;），属性会「提前收尾」——引擎必须取到最后一个 `"`
  const imgs = `<img src="http://104.21.91.145/static/a.jpg${PICA_TAIL}"><img src="http://104.21.80.1/static/b.jpg${PICA_TAIL}">`;
  const c = await runContent(imgs);
  assert.equal(c.paragraphs.length, 2);
  assert.equal(
    c.paragraphs[0],
    'http://104.21.91.145/static/a.jpg' + PICA_TAIL,
    '尾巴必须原样跟着 URL（前端 imgSrc 靠它取 Host / dnsIp）',
  );
  assert.equal(c.paragraphs[1], 'http://104.21.80.1/static/b.jpg' + PICA_TAIL);
});

test('#744 对偶：无尾巴 ⇒ 行为完全不变（纯 URL 段落）', async () => {
  const c = await runContent('<img src="https://img.test/p1.jpg"><img data-src="https://img.test/p2.jpg">');
  assert.deepEqual(c.paragraphs, ['https://img.test/p1.jpg', 'https://img.test/p2.jpg']);
});

test('#744 对偶：懒加载 `data-src` 优先级不变（`src` 占位符且无尾巴 ⇒ 取 data-src）', async () => {
  const c = await runContent('<img src="/static/web/images/loading.png" data-src="https://img.test/real.jpg">');
  assert.deepEqual(c.paragraphs, ['https://img.test/real.jpg']);
});

test('#744 相对地址 + 尾巴 ⇒ 只对主 URL 补全，尾巴原样保留', async () => {
  const c = await runContent(`<img src="/a.jpg${PICA_TAIL}">`);
  assert.equal(c.paragraphs[0], 'https://k.test/a.jpg' + PICA_TAIL);
});

test('#744 `{"dnsIp":…}` 形态的尾巴同样保留（域名直连 + IP 建连）', async () => {
  const tail = ',{"dnsIp":"104.19.53.76"}';
  const c = await runContent(`<img src="https://storage-b.picacomic.com/a.jpg${tail}">`);
  assert.equal(c.paragraphs[0], 'https://storage-b.picacomic.com/a.jpg' + tail);
});
