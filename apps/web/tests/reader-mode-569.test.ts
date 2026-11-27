/**
 * `#569` 阅读模式抽取回归锁（用 jsdom 注入 `document`，与线上同一份实现）。
 *
 * 锁的是「**会不会抽错**」而不是「像素好不好看」：
 *  ① 正文在 `<article>` 里 ⇒ 选中它，导航/侧栏/广告/评论必须消失；
 *  ② 正文埋在多层 `div` 外壳里 ⇒ 不能选中空壳（`descend` 下钻）；
 *  ③ 纯导航页 / 字数不足 ⇒ 返回 `null`，让调用方回落原文（**绝不` 输出空白正文）**；
 *  ④ `on*` 属性与 `javascript:` 链接必须被清掉（壳层 iframe 是 allow-scripts）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { extractReaderContent, readerModeDocument, type ReaderModeResult } from '../src/utils/reader-mode';

function docOf(html: string): Document {
  return new JSDOM(html).window.document;
}

const RICH_PAGE = `<!doctype html><html><head><title>文章标题 - 某某网</title></head><body>
  <header class="site-header"><a href="/">首页</a><a href="/news">新闻</a></header>
  <nav><a href="/a">A</a><a href="/b">B</a></nav>
  <div class="ad-box">广告位广告位广告位</div>
  <div class="layout">
    <div class="wrapper">
      <article>
        <h1>这是正文标题</h1>
        ${'<p>这是一段足够长的正文内容，用来验证正文抽取能拿到正确的容器。'.repeat(12)}</p>
        <p onclick="alert(1)">第二段正文 <a href="javascript:alert(2)">恶意链接</a> <a href="/next" target="_blank">正常链接</a></p>
        <img src="/pic.jpg" data-src="/lazy.jpg">
      </article>
    </div>
    <aside class="sidebar"><a href="/x">侧栏1</a><a href="/y">侧栏2</a></aside>
    <div class="comment-list">评论评论评论</div>
  </div>
  <footer>版权</footer>
</body></html>`;

test('#569 阅读模式：选中正文容器，噪声全部消失', () => {
  const r = extractReaderContent(RICH_PAGE, { document: docOf(RICH_PAGE) });
  assert.ok(r, '应抽出正文');
  assert.equal(r.title, '这是正文标题', 'h1 优先于 title');
  assert.ok(r.html.includes('这是一段足够长的正文内容'), '正文在');
  for (const noise of ['广告位', '侧栏', '评论评论', '首页', '版权']) {
    assert.ok(!r.html.includes(noise), `噪声必须被删掉：${noise}`);
  }
  assert.ok(r.textLength >= 200, `字数应达标：${r.textLength}`);
});

test('#569 阅读模式：清理 on* 与 javascript: 链接（壳层 allow-scripts）', () => {
  const r = extractReaderContent(RICH_PAGE, { document: docOf(RICH_PAGE) });
  assert.ok(r);
  assert.ok(!/\bonclick=/i.test(r.html), 'on* 属性必须清掉');
  assert.ok(!/javascript:/i.test(r.html), 'javascript: 链接必须清掉');
  assert.ok(!/target="_blank"/i.test(r.html), 'target 必须清掉（否则甩出壳层）');
  assert.ok(r.html.includes('/next'), '正常链接要保留');
  assert.ok(r.html.includes('data-src="/lazy.jpg"'), '懒加载属性要保留（资源桥要用）');
});

test('#569 阅读模式：外层空壳要下钻到真实正文', () => {
  const html = `<html><head><title>t</title></head><body>
    <div id="app"><div class="page"><div class="content">
      <p>${'真实正文内容。'.repeat(60)}</p>
    </div></div></div>
    <div class="nav"><a href="/a">a</a><a href="/b">b</a></div>
  </body></html>`;
  const r = extractReaderContent(html, { document: docOf(html) });
  assert.ok(r);
  // 不能把 #app 整个当正文（那样会把 .nav 也带进来）
  assert.ok(!r.html.includes('href="/a"'), `不应包含导航：${r.html.slice(0, 200)}`);
  assert.ok(r.html.includes('真实正文内容'));
});

test('#569 阅读模式：抽不出就返回 null（调用方回落原文）', () => {
  const navOnly = `<html><head><title>目录</title></head><body><nav><a href="/1">1</a><a href="/2">2</a></nav></body></html>`;
  assert.equal(extractReaderContent(navOnly, { document: docOf(navOnly) }), null);
  assert.equal(extractReaderContent('', { document: docOf('<html></html>') }), null);
  // 字数低于阈值 ⇒ null（minTextLength 可配）
  const short = `<html><body><article><p>短</p></article></body></html>`;
  assert.equal(extractReaderContent(short, { document: docOf(short) }), null);
});

test('#569 readerModeDocument：标题转义后拼成最小文档', () => {
  const res: ReaderModeResult = { title: 'A&B <x>', html: '<p>正文</p>', textLength: 2, paragraphs: ['正文'] };
  const out = readerModeDocument(res);
  assert.ok(out.includes('A&amp;B &lt;x&gt;'));
  assert.ok(out.includes('<article class="rd-article">'));
});

test('#712 阅读模式：书籍正文抽出段落（图片给 [图] 占位、噪声不进段落）', () => {
  const r = extractReaderContent(RICH_PAGE, { document: docOf(RICH_PAGE) });
  assert.ok(r);
  // 段落是独立于 html 的第二出口：书籍正文走文本分支时用它，样式/划词/分页全部接管
  assert.ok(r.paragraphs.length >= 2, `应抽出多段：${JSON.stringify(r.paragraphs)}`);
  assert.ok(r.paragraphs.some((p) => p.includes('这是一段足够长的正文内容')), '正文段落要在');
  assert.ok(r.paragraphs.includes('[图]'), '图片必须有 [图] 占位（与引擎同口径）');
  // 标题会被单独显示（文本分支用 `displayTitle`、网页型用 `rd-article-title`）⇒ 正文里不能再来一遍
  assert.ok(!r.paragraphs.includes('这是正文标题'), '正文里不能重复章节标题');
  const all = r.paragraphs.join('\n');
  for (const noise of ['广告位', '侧栏', '评论评论', '首页', '版权']) {
    assert.ok(!all.includes(noise), `噪声不得进段落：${noise}`);
  }
});
