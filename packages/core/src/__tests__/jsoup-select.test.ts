/**
 * 回归锁：jsoup 选择器兼容层（`core/src/selector/jsoup-select.ts`）。
 *
 * 为什么必须有这层：Legado 的 CSS 规则是 **jsoup 语法**，而我们的 DOM 后端是 jsdom(nwsapi)。
 * 对 jsoup 专有伪类，nwsapi 的反应是两种坏法：
 *   · `:eq/:gt/:lt/:matches/:matchesOwn/:containsOwn` → 抛 `Unknown pseudo-class`（可见，尚可）；
 *   · **`:contains(...)` → 语法接受、恒不匹配**（实测 `li:contains(苹果)` 返回 0 条且不报错）
 *     → `:contains(下一页)` 这类规则**静默少内容**，最坏的一种。
 *
 * 语义全部照 jsoup 源码（见模块头注释的出处），测试里用**能区分「兄弟索引」与「匹配集下标」**的
 * DOM 结构来锁死 `:eq/:gt/:lt` —— 这两种解释在多数源上结果相同，只有交错标签时才分叉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  matchesJsoup,
  needsJsoupFilter,
  quoteAttrValues,
  rewriteIndexPseudos,
  selectJsoup,
  selectJsoupFrom,
} from '../selector/jsoup-select';

function root(html: string): Element {
  return new JSDOM(`<body>${html}</body>`).window.document.body as unknown as Element;
}
const texts = (els: Element[]) => els.map((e) => (e.textContent ?? '').trim());
/** 元素自有文本（仅直接子文本节点），用于 :containsOwn / :matchesOwn 断言 */
const ownText = (el: Element) =>
  Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.nodeValue ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// :eq / :gt / :lt —— jsoup 语义 = elementSiblingIndex()（**不是**匹配结果集里的下标）
// ---------------------------------------------------------------------------

test(':eq(n) 以「父元素下的元素兄弟序号」为准（与「匹配集下标」分叉的判别用例）', () => {
  // span 是兄弟 0；两个 p 分别是兄弟 1 / 2 → 元素兄弟序号 2 的 p 是**第二个** p？
  // 不：p 们的序号是 1 和 2 → `p:eq(1)` 命中「序号=1」的那个 p（即第一个 p）
  const r = root('<div><span>x</span><p>甲</p><p>乙</p></div>');
  assert.deepEqual(texts(selectJsoup(r, 'div p:eq(1)')), ['甲'], '兄弟序号语义');
  assert.deepEqual(texts(selectJsoup(r, 'div p:eq(2)')), ['乙']);
  assert.deepEqual(texts(selectJsoup(r, 'div p:eq(0)')), [], '序号 0 是 span，不是 p');
});

test(':gt(n) / :lt(n) 同样是兄弟序号比较', () => {
  const r = root('<dl><a>1</a><a>2</a><a>3</a><a>4</a><a>5</a></dl>');
  assert.deepEqual(texts(selectJsoup(r, 'dl>a:gt(2)')), ['4', '5'], '序号 > 2');
  assert.deepEqual(texts(selectJsoup(r, 'dl>a:lt(2)')), ['1', '2'], '序号 < 2');
  assert.deepEqual(texts(selectJsoup(r, 'dl>a:gt(10)')), [], '越界为空（实测语料 #list dl>a:gt(10)）');
});

test('非数字索引按 jsoup 抛错（不静默返回空）', () => {
  assert.throws(() => rewriteIndexPseudos('a:eq(x)'), /Index must be numeric/, 'jsoup: Index must be numeric');
  assert.throws(() => rewriteIndexPseudos('a:eq(-1)'), /Index must be numeric/, '负数同样非法');
});

test(':eq 改写不碰属性选择器里的冒号', () => {
  const out = rewriteIndexPseudos('a[href^="http:"]:eq(1)');
  assert.equal(out, 'a[href^="http:"]:nth-child(2)', out);
});

// ---------------------------------------------------------------------------
// :contains / :containsOwn —— 去空白折叠 + 双方小写（jsoup ContainsText）
// ---------------------------------------------------------------------------

test(':contains 大小写不敏感 + 空白折叠', () => {
  const r = root('<li>苹果 Apple</li><li>香 蕉</li><li>橙子</li>');
  assert.deepEqual(texts(selectJsoup(r, 'li:contains(apple)')), ['苹果 Apple'], '小写也要命中（jsoup 大小写不敏感）');
  assert.deepEqual(texts(selectJsoup(r, 'li:contains(苹果)')), ['苹果 Apple']);
  assert.deepEqual(texts(selectJsoup(r, 'li:contains(香 蕉)')), ['香 蕉'], '空白折叠（"香 蕉" 单空格）');
});

test(':contains 参数只做反斜杠 unescape、**不剥引号**（照 jsoup）', () => {
  const r = root(`<li>字数 12</li><li>'字数' 带引号</li>`);
  assert.deepEqual(texts(selectJsoup(r, "li:contains('字数')")), ["'字数' 带引号"], "jsoup 不剥引号 → 只命中真的含引号者");
  assert.deepEqual(texts(selectJsoup(r, 'li:contains(字数)')), ['字数 12', "'字数' 带引号"]);
});

test(':containsOwn 只看自有文本，不含后代', () => {
  const r = root('<div><p>子文本</p>父文本</div>');
  const hit = selectJsoup(r, 'div:containsOwn(父文本)');
  assert.equal(hit.length, 1, '自有文本命中');
  assert.equal(ownText(hit[0] as Element), '父文本', 'own 文本不含后代');
  assert.deepEqual(selectJsoup(r, 'div:containsOwn(子文本)'), [], '后代文本不算 own');
  assert.equal(selectJsoup(r, 'div:contains(子文本)').length, 1, '而 :contains 看全文本，应命中');
});

// ---------------------------------------------------------------------------
// :matches / :matchesOwn —— jsoup 用无标志 Pattern + find()（**区分大小写**）
// ---------------------------------------------------------------------------

test(':matches 区分大小写（jsoup Regex.compile 无 CASE_INSENSITIVE）', () => {
  const r = root('<li>Apple</li><li>apple</li>');
  assert.deepEqual(texts(selectJsoup(r, 'li:matches(A.pl)')), ['Apple'], '大写 A 只命中首项');
  assert.deepEqual(texts(selectJsoup(r, 'li:matches((?i)apple)')), ['Apple', 'apple'], '源自带 (?i) 才忽略大小写');
});

test(':matchesOwn 只匹配自有文本', () => {
  const r = root('<div><span>AAA</span>BBB</div>');
  const hit = selectJsoup(r, 'div:matchesOwn(B+)');
  assert.equal(hit.length, 1);
  assert.equal(ownText(hit[0] as Element), 'BBB');
  assert.deepEqual(selectJsoup(r, 'div:matchesOwn(A+)'), [], '后代文本不参与');
});

// ---------------------------------------------------------------------------
// :has 嵌套文本伪类（语料 15 处，如 div:has(a:contains(下一页))）
// ---------------------------------------------------------------------------

test(':has 内部含 :contains 时由本层求值（nwsapi 对此恒空）', () => {
  const r = root('<div id="a"><a>下一页</a></div><div id="b"><a>上一页</a></div>');
  const hit = selectJsoup(r, 'div:has(a:contains(下一页))');
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.getAttribute('id'), 'a');
});

test(':has 内部只含标准 CSS 时交给 nwsapi（零改动零开销）', () => {
  const r = root('<div id="a"><b>x</b></div><div id="b">y</div>');
  const hit = selectJsoup(r, 'div:has(b)');
  assert.equal(hit[0]?.getAttribute('id'), 'a');
});

// ---------------------------------------------------------------------------
// 组合链 / 多根 / 等价性
// ---------------------------------------------------------------------------

test('组合链：后代 + 子 + 文本过滤混用', () => {
  const r = root('<div id="list"><p>甲 目录</p><p>乙 目录</p><span>丙 目录</span></div>');
  assert.deepEqual(texts(selectJsoup(r, '#list p:contains(目录)')), ['甲 目录', '乙 目录']);
  assert.deepEqual(texts(selectJsoup(r, '#list > span:contains(丙)')), ['丙 目录']);
});

test('selectJsoupFrom：多根去重且保持顺序', () => {
  const r = root('<div class="a"><p>x</p></div><div class="a"><p>x</p></div>');
  const roots = Array.from(r.querySelectorAll('div.a'));
  const out = selectJsoupFrom(roots, 'p:contains(x)');
  assert.equal(out.length, 2, '两根各命中一次，不得重复计数');
});

test('无 jsoup 伪类时与 querySelectorAll 完全等价（不得引入行为变化）', () => {
  const r = root('<ul class="u"><li>1</li><li>2</li></ul>');
  for (const sel of ['.u li', 'ul > li:first-child', 'li:nth-child(2)', 'li:not(.x)']) {
    const a = texts(selectJsoup(r, sel));
    const b = texts(Array.from(r.querySelectorAll(sel)));
    assert.deepEqual(a, b, `${sel} 必须等价`);
    assert.equal(needsJsoupFilter(sel), false, `${sel} 不该走 JS 过滤路径`);
  }
});

test('matchesJsoup：自身匹配也支持 jsoup 伪类（css.ts 补 self 用）', () => {
  const r = root('<div class="c">甲</div>');
  const el = r.querySelector('div.c') as Element;
  assert.equal(matchesJsoup(el, 'div:contains(甲)'), true);
  assert.equal(matchesJsoup(el, 'div:contains(乙)'), false);
  assert.equal(matchesJsoup(el, 'span'), false);
});

// ---------------------------------------------------------------------------
// 类BP：属性选择器的值**未加引号**（jsoup 允许 / 标准 CSS 拒绝）
//
// 上游出处（jsoup 1.16.2 `select/QueryParser.byAttribute()`）：
//   TokenQueue cq = new TokenQueue(tq.chompBalanced('[', ']'));
//   String key = cq.consumeToAny(AttributeEvals);   // "=" "!=" "^=" "$=" "*=" "~="
//   cq.consumeWhitespace();
//   if (cq.matchChomp("=")) eval = new Evaluator.AttributeWithValue(key, cq.remainder());
// ⇒ 值 = `cq.remainder()`：运算符之后**到 `]` 为止的全部字符**，冒号等不是分隔符。
// 症状（修前）：`Error: Invalid selector meta[property=og:novel:book_name]`
//   —— 哔哩轻小说搜索 `@js:` 规则里 `doc.select('meta[property=og:novel:book_name]')` 整段失败。
// ---------------------------------------------------------------------------

/** 属性选择器常见于 <head>，故从 documentElement 起选 */
function metaRoot(html: string): Element {
  return new JSDOM(html).window.document.documentElement as unknown as Element;
}

const META_HTML =
  '<html><head>' +
  '<meta property="og:novel:book_name" content="书名">' +
  '<meta property="og:title" content="标题">' +
  '<meta property="og:image" content="http://x/y.jpg">' +
  '</head><body></body></html>';

test('类BP：nwsapi 本身会抛 —— 锁死「缺陷真实存在」（判别对/错两种实现）', () => {
  const r = metaRoot(META_HTML);
  assert.throws(
    () => r.querySelectorAll('meta[property=og:novel:book_name]'),
    /Invalid selector/,
    '前提：未加引号的值含冒号时，标准 CSS 解析器必须抛错',
  );
});

test('类BP：selectJsoup 给未加引号的值补引号 ⇒ 含冒号的值可选中（不再抛错）', () => {
  const r = metaRoot(META_HTML);
  const els = selectJsoup(r, 'meta[property=og:novel:book_name]');
  assert.equal(els.length, 1, '应命中 1 个 meta');
  assert.equal(els[0]!.getAttribute('content'), '书名');
  // 与「手写引号」的等价写法结果一致
  assert.deepEqual(
    els.map((e) => e.getAttribute('content')),
    selectJsoup(r, 'meta[property="og:novel:book_name"]').map((e) => e.getAttribute('content')),
  );
});

test('类BP：Elements 桥路径（selectJsoupFrom）同样生效 —— 源脚本 doc.select(\'…\') 走的是这条', () => {
  const r = metaRoot(META_HTML);
  const out = selectJsoupFrom([r], 'meta[property=og:novel:book_name]');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.getAttribute('content'), '书名');
});

test('类BP：matchesJsoup 也不因未加引号的值而失效（自身匹配分支）', () => {
  const r = metaRoot(META_HTML);
  const el = r.querySelector('meta[property="og:novel:book_name"]') as Element;
  assert.equal(matchesJsoup(el, 'meta[property=og:novel:book_name]'), true);
  assert.equal(matchesJsoup(el, 'meta[property=og:title]'), false);
});

test('类BP：quoteAttrValues 只动「未加引号」的值，已加引号/无反斜杠语义一律不碰', () => {
  assert.equal(quoteAttrValues('meta[property=og:title]'), 'meta[property="og:title"]');
  assert.equal(quoteAttrValues('[href^=http]'), '[href^="http"]');
  assert.equal(quoteAttrValues('[property$=og:title]'), '[property$="og:title"]');
  // 已加引号 ⇒ 原样（幂等）
  assert.equal(quoteAttrValues('meta[property="og:title"]'), 'meta[property="og:title"]');
  assert.equal(quoteAttrValues("meta[property='og:title']"), "meta[property='og:title']");
  // 无属性选择器 ⇒ 原样
  assert.equal(quoteAttrValues('div.a > p:contains(甲)'), 'div.a > p:contains(甲)');
  // 值内含 | ⇒ 拆成 :is(...)（历史行为，语料 [href~=^javascript:|^#] 依赖它）
  assert.equal(
    quoteAttrValues('[href*=a|b]'),
    ':is([href*="a"],[href*="b"])',
  );
});

test('类BP：含冒号值的属性选择器可嵌在组合器/伪类里一起用', () => {
  const r = metaRoot('<html><head></head><body><div class="w"><p data-k="a:b">甲</p></div></body></html>');
  assert.deepEqual(texts(selectJsoup(r, 'div.w p[data-k=a:b]')), ['甲']);
  assert.deepEqual(texts(selectJsoup(r, 'p[data-k=a:b]:eq(0)')), ['甲'], '与索引伪类共存');
  assert.deepEqual(texts(selectJsoup(r, 'div:has(p[data-k=a:b]) p')), ['甲'], '与 :has 共存');
});

// ---------------------------------------------------------------------------
// 类BQ：属性选择器的 `~=` 是**正则 find**（jsoup），不是 CSS 的「空白分词精确匹配」
//
// 上游出处（jsoup 1.16.2）：
//   · QueryParser.byAttribute(): `cq.matchChomp("~=")` → Pattern.compile(cq.remainder())
//   · Evaluator.AttributeWithValueMatching.matches():
//       return element.hasAttr(key) && pattern.matcher(element.attr(key)).find();
//   · Evaluator.AttributeWithValueNot.matches():
//       return !value.equalsIgnoreCase(element.attr(key));   // 不检查 hasAttr
// 实测语料：`~=` 共 **100 处 / 59 源**，其中 89 处含正则元字符
//   （`\S`、`(?i)\.png`、`/read/\d+`、`category$`、`a|b`）⇒ 交给 CSS 全是静默空。
// ---------------------------------------------------------------------------

test('类BQ：`~=` 是「属性值包含」而非「空白分词等于」——判别 CSS 分词语义的关键用例', () => {
  const r = metaRoot('<html><head><meta property="og:title" content="标题"></head><body></body></html>');
  // 原始 nwsapi：CSS `~=` 要求 property 是「空白分词后恰好等于 title」 ⇒ og:title 不匹配（静默空）
  assert.equal(r.querySelectorAll('[property~=title]').length, 0, '前提：CSS 分词语义下应为 0');
  // jsoup：正则 title 在 "og:title" 里 find 得到 ⇒ 命中
  assert.equal(selectJsoup(r, '[property~=title]').length, 1);
  assert.equal(matchesJsoup(r.querySelector('meta') as Element, '[property~=title]'), true);
});

test('类BQ：`~=` 支持正则交替/可选/锚点（语料真实写法）', () => {
  const r = metaRoot(
    '<html><head>' +
      '<meta property="og:novel:category" content="都市">' +
      '<meta property="og:novel:lastest_chapter_name" content="第1章">' +
      '<meta property="og:novel:latest_chapter_name" content="第2章">' +
      '<meta property="og:description" content="简介">' +
    '</head><body></body></html>',
  );
  const prop = (els: Element[]) => els.map((e) => e.getAttribute('property'));
  // 交替：category|status|update_time（语料 44 次）
  assert.deepEqual(prop(selectJsoup(r, '[property~=category|status|update_time]')), ['og:novel:category']);
  // `|` 必须留在正则里，不能被「补引号」那步按 | 拆开
  assert.equal(needsJsoupFilter('[property~=category|status]'), true, '`~=` 必须走 JS 过滤路径');
  // 可选 `s?`：同时命中 lastest / latest（语料 13 次）
  assert.deepEqual(prop(selectJsoup(r, '[property~=las?test_chapter_name]')), [
    'og:novel:lastest_chapter_name',
    'og:novel:latest_chapter_name',
  ]);
  // 锚点 `$`
  assert.deepEqual(prop(selectJsoup(r, '[property~=description$]')), ['og:description']);
  // 大小写敏感（无标志的正则）
  assert.deepEqual(prop(selectJsoup(r, '[property~=CATEGORY]')), [], 'jsoup 用无标志 Pattern ⇒ 大小写敏感');
});

test('类BQ：`~=` 的其它语料形态 —— 内联 (?i)、转义 \\S、带冒号与分号的值、路径正则', () => {
  const r = root(
    '<img src="A.PNG"><img src="b.gif">' +
      '<a href="javascript:void(0)">js</a><a href="#top">hash</a><a href="/read/12.html">n</a>' +
      '<div style="width:100%;color:red">d</div>',
  );
  const srcs = selectJsoup(r, '[src~=(?i)\\.png]').map((e) => e.getAttribute('src'));
  assert.deepEqual(srcs, ['A.PNG'], 'Java 内联 (?i) 提为 JS 的 i 标志');
  assert.equal(selectJsoup(r, '[href~=/read/\\d+]').length, 1, '路径正则');
  assert.deepEqual(
    selectJsoup(r, '[href~=^#|javascript:]').map((e) => e.textContent),
    ['js', 'hash'],
    '交替 + 锚点，且 `|` 未被拆开',
  );
  assert.equal(selectJsoup(r, '[href~=\\S]').length, 3, '\\S 转义：所有非空 href');
  assert.equal(selectJsoup(r, '[style~=width:100%;]').length, 1, '值里含冒号/分号/百分号');
});

test('类BQ：`!=` 按 jsoup 语义取反，且**不要求属性存在**（CSS 无此运算符）', () => {
  const r = root('<p data-x="a">甲</p><p data-x="b">乙</p><p>丙</p>');
  assert.deepEqual(texts(selectJsoup(r, 'p[data-x!=a]')), ['乙', '丙'], '无该属性者也匹配（jsoup 不查 hasAttr）');
  assert.deepEqual(texts(selectJsoup(r, 'p[data-x!=A]')), ['乙', '丙'], 'equalsIgnoreCase ⇒ 大小写不敏感');
  assert.throws(() => r.querySelectorAll('p[data-x!=a]'), /Invalid selector/, '前提：CSS 无 `!=` ⇒ nwsapi 抛错');
});

test('类BQ：`~=` 与组合器 / 索引伪类 / 补引号 共存', () => {
  const r = root('<div class="w"><a href="/read/1.html">一</a><a href="/x">二</a></div>');
  assert.deepEqual(texts(selectJsoup(r, 'div.w a[href~=/read/\\d+]')), ['一']);
  assert.deepEqual(texts(selectJsoup(r, 'a[href~=/read/\\d+]:eq(0)')), ['一'], '与 :eq 共存');
  // 同一片段里既有「未加引号值」（类BP）又有 `~=`（类BQ）
  const r2 = root('<p class="c" data-a="x:y">甲</p>');
  assert.deepEqual(texts(selectJsoup(r2, 'p[data-a=x:y][data-a~=x]')), ['甲'], '两类修复共存');
});
