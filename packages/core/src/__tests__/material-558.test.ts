/**
 * `#558` 物料取页链 + 物料格式化。
 *
 * 链的顺序是用户口径（不是我们发明的）：
 *   详情：用户给地址 → 发现首个有地址分类的首地址 → 搜索（默认 key，第 1 页）→ 首个 bookUrl
 *   目录：用户给地址 → 详情页 tocUrl → 没有 tocUrl 就共用详情页地址
 *   正文：用户给地址 → 目录里首章地址
 *
 * 这里全部用**假网页 + 假 fetch** 跑：不联网、不起服务，链条每一步都能单独验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMaterial, DEFAULT_MATERIAL_KEYWORD } from '../diag/material-chain';
import { formatMaterial } from '../diag/material-format';

/* ------------------------------- 假站点 ------------------------------- */

const LIST_HTML = `<div class="item"><a href="/167/"><img src="/c1.jpg"/></a>`
  + `<div class="itemtxt"><h3><a href="/167/">我的模拟长生路</a></h3>`
  + `<p><a href="/zuozhe/?tag=x">作者：愤怒的乌贼</a></p></div></div>`
  + `<div class="item"><h3><a href="/3748/">人在美利坚</a></h3></div>`;

const DETAIL_HTML = `<div class="book"><h1>我的模拟长生路</h1>`
  + `<a class="toc" href="/167/list.html">查看目录</a></div>`;

const TOC_HTML = `<ul id="list"><li><a href="/167/1.html">第1章 起点</a></li>`
  + `<li><a href="/167/2.html">第2章 终点</a></li></ul>`;

const CONTENT_HTML = `<div id="content"><p>正文第一段</p></div>`;

/** 假 fetch：按 URL 后缀返回固定页面，并记下取过哪些地址（链条顺序也要能验） */
function fakeSite(pages: Record<string, string>, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const hit = Object.entries(pages).find(([k]) => url === k || url.endsWith(k));
    return hit ? { content: hit[1], status: 200, baseUrl: url } : { error: 'HTTP 404' };
  };
}

const SRC = {
  bookSourceUrl: 'https://t.test',
  searchUrl: '/s?key={{key}}',
  /**
   * ⚠️ 这里必须是**单引号**写法：`{{page == 1 ? "" : page + ".html"}}` 里含有双引号，
   * 用双引号包字符串就不是合法 JSON 了（真实源正是在 `<js>` 里用单引号拼的）。
   */
  exploreUrl: `[{title:"完结小说", url:'/wanjie/{{page == 1 ? "" : page + ".html"}}'}]`,
  ruleSearch: { bookList: '.item', name: 'h3 a@text', bookUrl: 'h3 a@href' },
  ruleExplore: { bookList: 'div.item', bookUrl: 'h3@a@href' },
  ruleBookInfo: { tocUrl: '.toc@href' },
  ruleToc: { chapterList: '#list li', chapterUrl: 'a@href' },
};

/** `{{key}}` 会做 URL 编码 ⇒ 假站点按编码后的地址登记 */
const SEARCH_URL = `https://t.test/s?key=${encodeURIComponent(DEFAULT_MATERIAL_KEYWORD)}`;

const PAGES = {
  'https://t.test/wanjie/': LIST_HTML,
  [SEARCH_URL]: LIST_HTML,
  'https://t.test/167/': DETAIL_HTML,
  'https://t.test/167/list.html': TOC_HTML,
  'https://t.test/167/1.html': CONTENT_HTML,
};

/* ------------------------------- 详情链 ------------------------------- */

test('M-① 详情：用户给了地址 ⇒ 直接取，不走发现/搜索', async () => {
  const calls: string[] = [];
  const r = await resolveMaterial({
    target: 'detail',
    url: 'https://t.test/167/',
    source: SRC,
    fetch: fakeSite(PAGES, calls),
  });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://t.test/167/');
  assert.equal(calls.length, 1, '只该取一次');
  assert.equal(r.kind, 'html');
  assert.deepEqual(r.chain.map((s) => s.step), ['entry', 'fetch']);
});

test('M-② 详情：不给地址 ⇒ 发现首个分类首页 → 首个 bookUrl → 详情页（相对地址补全）', async () => {
  const calls: string[] = [];
  const r = await resolveMaterial({ target: 'detail', source: SRC, fetch: fakeSite(PAGES, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://t.test/167/', '应落在详情页而不是列表页');
  assert.match(r.content, /查看目录/);
  const steps = r.chain.map((s) => s.step);
  assert.deepEqual(steps, ['explore', 'fetch', 'bookUrl', 'fetch']);
  // 分类地址里的 `{{page == 1 ? "" : …}}` 必须算过（首页不带页码）
  assert.equal(r.chain[0]?.url, 'https://t.test/wanjie/');
  assert.equal(r.chain[2]?.value, 'https://t.test/167/');
});

test('M-③ 详情：没有发现规则 ⇒ 回落到搜索（默认 key），取第 1 页首个 bookUrl', async () => {
  const calls: string[] = [];
  const src = { ...SRC, exploreUrl: '' };
  const r = await resolveMaterial({ target: 'detail', source: src, fetch: fakeSite(PAGES, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://t.test/167/');
  assert.equal(r.chain[0]?.step, 'search');
  assert.match(String(r.chain[0]?.url), new RegExp(`key=${encodeURIComponent(DEFAULT_MATERIAL_KEYWORD)}`));
  assert.equal(r.keyword, DEFAULT_MATERIAL_KEYWORD);
});

test('M-④ 详情：列表页取不到 bookUrl 时退回列表页，但必须在 errors 里说清', async () => {
  const src = { ...SRC, exploreUrl: '', ruleSearch: { bookList: '.item' } }; // 故意没有 bookUrl 规则
  const r = await resolveMaterial({ target: 'detail', source: src, fetch: fakeSite(PAGES) });
  assert.equal(r.url, SEARCH_URL, '退回搜索页');
  assert.match(r.errors.join('\n'), /没有「书籍地址」规则/);
});

/* ------------------------------- 目录链 ------------------------------- */

test('M-⑤ 目录：从详情取 tocUrl 再取页', async () => {
  const calls: string[] = [];
  const r = await resolveMaterial({ target: 'toc', source: SRC, fetch: fakeSite(PAGES, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://t.test/167/list.html');
  assert.match(r.content, /第1章 起点/);
  assert.ok(r.chain.some((s) => s.step === 'tocUrl'), '要记录 tocUrl 这一步');
});

test('M-⑥ 目录：源没写 tocUrl ⇒ 与详情页共用同一地址（不重复取页）', async () => {
  const calls: string[] = [];
  const src = { ...SRC, ruleBookInfo: {} };
  const r = await resolveMaterial({ target: 'toc', source: src, fetch: fakeSite(PAGES, calls) });
  assert.equal(r.url, 'https://t.test/167/');
  assert.match(r.content, /查看目录/, '共用详情页内容');
  assert.equal(calls.filter((u) => u === 'https://t.test/167/').length, 1, '详情页只该取一次');
});

test('M-⑦ 目录：用户给了地址 ⇒ 直接取', async () => {
  const r = await resolveMaterial({
    target: 'toc',
    url: 'https://t.test/167/list.html',
    source: SRC,
    fetch: fakeSite(PAGES),
  });
  assert.equal(r.url, 'https://t.test/167/list.html');
  assert.deepEqual(r.chain.map((s) => s.step), ['entry', 'fetch']);
});

/* ------------------------------- 正文链 ------------------------------- */

test('M-⑧ 正文：从目录取首章地址（相对地址补全成绝对）', async () => {
  const r = await resolveMaterial({ target: 'content', source: SRC, fetch: fakeSite(PAGES) });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://t.test/167/1.html');
  assert.match(r.content, /正文第一段/);
  assert.equal(r.chain.find((s) => s.step === 'chapterUrl')?.value, 'https://t.test/167/1.html');
});

test('M-⑨ 正文：目录侧没有章节规则 ⇒ 退回目录页并说明', async () => {
  const src = { ...SRC, ruleToc: {} };
  const r = await resolveMaterial({ target: 'content', source: src, fetch: fakeSite(PAGES) });
  assert.equal(r.url, 'https://t.test/167/list.html');
  assert.match(r.errors.join('\n'), /章节/);
});

/* ------------------------------- 取页失败 ------------------------------- */

test('M-⑩ 取页失败要如实报（不能返回空内容还说自己 ok）', async () => {
  const r = await resolveMaterial({ target: 'detail', url: 'https://t.test/none', source: SRC, fetch: fakeSite(PAGES) });
  assert.equal(r.ok, false);
  assert.equal(r.content, '');
  assert.match(r.errors.join('\n'), /取页失败/);
});

/* ------------------------------- 格式化 ------------------------------- */

test('F-① JSON：只重排缩进，键值一个不少', () => {
  const r = formatMaterial('{"a":1,"b":[2,3]}');
  assert.equal(r.kind, 'json');
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(r.text), { a: 1, b: [2, 3] });
  assert.match(r.text, /\n {2}"a": 1/);
});

test('F-② 像 JSON 但解析不了（GSON 单引号）⇒ 原样不动并说明', () => {
  const src = "{'a': 'b'}";
  const r = formatMaterial(src);
  assert.equal(r.text, src);
  assert.equal(r.changed, false);
  assert.match(String(r.note), /保持原样/);
});

test('F-③ HTML：按层级缩进，`<pre>` 内容原样，`<script>` 内的字符串字面量不被改坏', () => {
  const html = '<html><body><div class="a">文字</div><script>var s = "<div>x</div>";</script><pre>  keep\n  me  </pre></body></html>';
  const r = formatMaterial(html);
  assert.equal(r.kind, 'html');
  assert.match(r.text, /\n +<div class="a">/, '块级标签前断行（并按层级缩进）');
  /**
   * `#681` 起 HTML 走 `js-beautify`：`<script>` 会**被当成 JS 重排**（这是我们要的 —— 好看），
   * 但它做的是分词后重新拼空白，**不会动字符串字面量里的内容**。
   * 所以断言从「整块原样」改成「JS 里的 `"<div>x</div>"` 一字不改且引号完整」。
   */
  assert.ok(r.text.includes('var s = "<div>x</div>";'), `脚本里的字符串字面量必须一字不改：${r.text}`);
  assert.ok(r.text.includes('<pre>  keep\n  me  </pre>'), 'pre 区块必须原样（content_unformatted）');
  /**
   * ⚠️ 只断言「包含」是不够的：`split` 用带捕获组的正则时，**保护区块会被复制一份**，
   * 复制出来的那份同样「包含」原文 ⇒ 断言照样绿（实测踩过）。必须数出现次数。
   */
  assert.equal((r.text.match(/<script>/g) ?? []).length, 1, '脚本区块不能被复制');
  assert.equal((r.text.match(/<pre>/g) ?? []).length, 1, 'pre 区块不能被复制');
});

test('F-④ 文本：折叠多余空行，行内单换行保留', () => {
  const r = formatMaterial('第一行\n第二行\n\n\n\n第三行');
  assert.equal(r.kind, 'text');
  assert.equal(r.text, '第一行\n第二行\n\n第三行');
});

test('F-⑤ HTML 缩进：嵌套块级按层级缩进，空元素不多缩一层（`#677`）', () => {
  /**
   * 用户实测：「格式化后还是没有缩进，看不出来层级关系」——
   * 旧实现只断行、不缩进。缩进按标签开闭维护深度，`<img>`/`<br>` 这类空元素不算开标签
   * （否则它后面每一行都会多缩一层，越排越歪）。
   */
  const r = formatMaterial('<html><body><ul><li><a href="/1">第1章</a></li></ul></body></html>');
  const lines = r.text.split('\n');
  assert.ok(lines.some((l) => /^ {4}<ul>/.test(l)), `ul 应在 body 内（4 空格）：${r.text}`);
  assert.ok(lines.some((l) => /^ {6}<li>/.test(l)), `li 应在 ul 内（6 空格）：${r.text}`);

  const r2 = formatMaterial('<div><img src="a.jpg"><p>x</p></div>');
  const p = r2.text.split('\n').find((l) => l.includes('<p>')) ?? '';
  assert.ok(p.startsWith('  ') && !p.startsWith('    '), `img 之后的 p 应与 img 同级（只缩一层）：${r2.text}`);
});

/* `#681` 起 HTML/CSS/JS 走 `js-beautify`（见 `material-format.ts` 头注的实测对比） */

test('F-⑥ CSS：选择器与声明各自成行', () => {
  const r = formatMaterial('.a{color:red;background:url(x.png)}@media (max-width:600px){.b{display:none}}', 'css');
  assert.equal(r.kind, 'css');
  assert.match(r.text, /\.a \{\n {2}color: red;/);
  assert.match(r.text, /@media \(max-width:600px\) \{\n {2}\.b \{/);
});

test('F-⑦ JS：**语法不完整的片段也能排**（源规则常是 `return …` 结尾的片段）', () => {
  const r = formatMaterial('var list=[];const push=(t,u)=>{list.push({title:t,url:u})};return JSON.stringify(list)', 'js');
  assert.equal(r.kind, 'js');
  assert.match(r.text, /const push = \(t, u\) => \{\n {2}list\.push/);
  assert.match(r.text, /return JSON\.stringify\(list\)/, '顶层 return 不该导致失败');
});

test('F-⑧ 容错：坏输入不抛异常、内容不被改坏', () => {
  // 缺右括号
  const bad = formatMaterial('var a = {b:1', 'js');
  assert.match(bad.text, /var a = \{/, '不抛且尽量排');
  // `</div>` 出现在 JS 字符串里：不能被当成 HTML 标签
  const html = formatMaterial('<div><script>var s = "</div>";</script></div>');
  assert.ok(html.text.includes('var s = "</div>";'), `字符串里的 </div> 不能被当标签：${html.text}`);
  // 不闭合标签
  assert.doesNotThrow(() => formatMaterial('<div><ul><li>a<li>b</div>'));
});

test('F-⑨ 护栏：深层嵌套导致体积膨胀 ⇒ 原样返回并说明', () => {
  const deep = '<div>'.repeat(3000) + 'x' + '</div>'.repeat(3000);
  const r = formatMaterial(deep);
  assert.equal(r.text, deep, '膨胀时保持原样，别把界面卡住');
  assert.match(String(r.note), /膨胀/, '要说明为什么没动');
});
