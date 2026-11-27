/**
 * `#551` 单字段试跑 + 选择器探针回归锁。
 *
 * 三条纪律钉在这里：
 *  ① **命中数必须来自引擎同一份 `AnalyzeRule`** —— 探针给出「0 命中」时，真跑引擎也必须是 0，
 *     否则就是「探针自己写了一套求值」（`#158` 的旧坑）。故用例直接对拍已知引擎行为。
 *  ② **0 命中不能静默**：必须带 `SELECTOR_MISS` 码 + 候选。
 *  ③ **纯 JS 规则的命中数是 null，不是 0** —— 给 0 会让用户以为选择器写错了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeField, probeSelector, PROBE_CODES } from '../diag/probe';

const HTML = `<div class="box"><a class="name" href="/b/1.html">雪中悍刀行</a><span class="author">烽火戏诸侯</span></div><div class="box"><a class="name" href="/b/2.html">雪中悍刀行2</a></div>`;
const JSON_TEXT = `{"data":{"books":[{"bookName":"雪中悍刀行","author":"烽火"},{"bookName":"道君","author":"跃千愁"}]}}`;

test('B-① 单值：CSS + @text 解出文本，并带真实命中数', async () => {
  const r = await probeField({ rule: '.name@text', content: HTML, field: 'ruleSearch.bookList' });
  assert.equal(r.ok, true);
  /**
   * ⚠️ Legado `getString` = `getStringList().join("\n")` —— 命中 2 个就给出**拼接串**，
   * 不是「取第一个」。这条必须锁住：改成取第一个就会与真跑不一致（`#158` 那类漂移）。
   */
  assert.equal(r.value, '雪中悍刀行\n雪中悍刀行2');
  assert.equal(r.hitCount, 2);
  assert.equal(r.length, 12); // 5 + 1(\n) + 6
  assert.equal(r.field, 'ruleSearch.bookList');
});

test('B-①b 单值字段却命中多个 ⇒ 给 hints（否则「选择器写宽了」是静默的）', async () => {
  const r = await probeField({ rule: '.name@text', content: HTML, field: 'ruleBookInfo.name' });
  assert.equal(r.ok, true, '跑通了（有值），但形状可疑 ⇒ 靠 hints 而不是 code 报');
  assert.equal(r.code, undefined);
  assert.equal(r.hints?.length, 1);
  // `#556` 措辞改成「按单值取（getString）命中了 N 个元素」：同一句话在列表容器上出现时，
  // 用户会误以为「列表写宽了」（实际列表命中多个才是对的，见 explore-556 的 elements 用例）。
  assert.match(r.hints?.[0] ?? '', /按单值取（getString）命中了 2 个元素/);
  // 命中 1 个时不该报（正常形状）
  const one = await probeField({ rule: '.author@text', content: HTML, field: 'ruleBookInfo.author' });
  assert.equal(one.hints, undefined);
});

test('B-② 单值 0 命中 ⇒ ok=false + SELECTOR_MISS（不静默返回空串）', async () => {
  const r = await probeField({ rule: '.not-exist@text', content: HTML });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SELECTOR_MISS');
  assert.equal(r.hitCount, 0);
  assert.match(r.error ?? '', /0 命中/);
});

test('B-③ 列表模式：getStringList 取全部，values 与 hitCount 同步', async () => {
  const r = await probeField({ rule: '.name@text', content: HTML, mode: 'list' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, ['雪中悍刀行', '雪中悍刀行2']);
  assert.equal(r.hitCount, 2);
});

test('B-④ 元素模式：命中数 + outerHTML 样本', async () => {
  const r = await probeField({ rule: '.box', content: HTML, mode: 'elements' });
  assert.equal(r.ok, true);
  assert.equal(r.hitCount, 2);
  assert.equal(r.samples.length, 2);
  assert.match(r.samples[0] ?? '', /^<div class="box">/);
});

test('B-⑤ JSON 内容走引擎同一条 Json 通路（不是探针自己实现的）', async () => {
  const r = await probeField({ rule: '$.data.books[0].bookName', content: JSON_TEXT });
  assert.equal(r.ok, true);
  assert.equal(r.value, '雪中悍刀行');
});

test('B-⑥ 缺输入：规则空 / 内容空各自给码，不混成 UNKNOWN', async () => {
  const noRule = await probeField({ rule: '   ', content: HTML });
  assert.equal(noRule.code, PROBE_CODES.NO_RULE);
  const noContent = await probeField({ rule: '.name' });
  assert.equal(noContent.code, PROBE_CODES.NO_CONTENT);
  const blankStr = await probeField({ rule: '.name', content: '\n  \t' });
  assert.equal(blankStr.code, PROBE_CODES.NO_CONTENT);
});

test('B-⑦ 纯 JS 规则：hitCount 恒为 null（诚实，不给假 0）', async () => {
  const r = await probeField({ rule: '<js>"A" + "B"</js>', content: HTML });
  assert.equal(r.ok, true);
  assert.equal(r.value, 'AB');
  assert.equal(r.hitCount, null, 'JS 规则没有「选中几个元素」这回事，必须 null');
});

test('B-⑧ 脚本抛错 ⇒ 复用 #550 归因表的码（探针不另编一套）', async () => {
  const r = await probeField({ rule: '@js:((("', content: HTML });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'JS_SYNTAX', '语法错必须归到 JS_SYNTAX，而不是 UNKNOWN');
});

test('B-⑨ 超长值截断但 length 报真实长度', async () => {
  const long = `<div id="c">${'x'.repeat(5_000)}</div>`;
  const r = await probeField({ rule: '#c@text', content: long });
  assert.equal(r.truncated, true);
  assert.equal(r.value.length, 2_000);
  assert.equal(r.length, 5_000);
});

test('B-⑩ XPath 写坏（谓词里多 `//`、`/`）⇒ SELECTOR_MISS，不是 UNKNOWN', async () => {
  /**
   * 原来这条锁的是 `//h1@text`（XPath 取文本应写 `/text()`）—— `#686` 起本仓**兼容**了
   * 「XPath + jsoup 风格尾缀」（`xpath.ts` 的 `splitXpathTail`，上游会报错、属超集），
   * 所以 `//h1@text` 现在能出值，不再适合当「写法错」的样本。
   *
   * 换成真正写坏的谓词：`[@//attr/="v"]`（多写 `//` 与 `/`）。这类笔误此前落到 `UNKNOWN`
   * （「未识别的错误，去看 trace」），`#551` 补进归因表；`#684` 又补了 `xpath` 库的
   * `Position N: Expected …` 形态，这里锁住归属。
   */
  const r = await probeField({ rule: '//h1[@//x/="1"]', content: '<html><body><h1>标题</h1></body></html>' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SELECTOR_MISS');
  assert.match(r.error ?? '', /XPath|Unparsed|Position|nodeTest/);
  // 正确写法能出值（同一份内容 ⇒ 证明不是内容的问题）
  const ok = await probeField({ rule: '//h1/text()', content: '<html><body><h1>标题</h1></body></html>' });
  assert.equal(ok.value, '标题');
  // `@text` 尾缀：`#687` 明确**不兼容**（标准 XPath 只有 `/text()`），但报错要给出改法
  const tail = await probeField({ rule: '//h1@text', content: '<html><body><h1>标题</h1></body></html>' });
  assert.equal(tail.ok, false);
  assert.equal(tail.code, 'SELECTOR_MISS');
  assert.match(tail.error ?? '', /XPath 语法错|text\(\)/, `要直接教用户改成 /text()：${tail.error}`);
});

/* ---------------- C. 选择器探针 ---------------- */

test('C-① 命中时不给候选（候选只在 0 命中时才有意义）', async () => {
  const r = await probeSelector({ selector: '.box', content: HTML });
  assert.equal(r.ok, true);
  assert.equal(r.hitCount, 2);
  assert.deepEqual(r.candidates, []);
});

test('C-② 0 命中 + @attr 干扰 ⇒ 候选给出「去掉 @attr」且能命中', async () => {
  // class=name 的元素没有 title 属性 ⇒ `.name@title` 0 命中，但 `.name` 有 2 个
  const r = await probeSelector({ selector: '.name@title', content: HTML });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SELECTOR_MISS');
  const hit = r.candidates.find((c) => c.selector === '.name');
  assert.ok(hit, '必须给出去掉 @attr 的候选');
  assert.equal(hit?.hitCount, 2);
  assert.match(hit?.why ?? '', /去掉末尾的 @title/);
});

test('C-③ 0 命中 + JSON 内容 ⇒ 给键路径候选（CSS 在 JSON 上必然 0 命中）', async () => {
  const r = await probeSelector({ selector: '.item', content: JSON_TEXT });
  assert.equal(r.hitCount, 0);
  assert.ok(r.candidates.length > 0, 'JSON 页必须给出 $.key 候选');
  assert.equal(r.candidates[0]?.selector, '$.data.books');
  assert.equal(r.candidates[0]?.hitCount, 2);
  assert.match(r.candidates[0]?.why ?? '', /JSON/);
  // 数组子键要顺带给 `[*]`（列表字段的惯用写法）
  assert.equal(r.candidates.find((c) => c.selector === '$.data.books[*]')?.hitCount, 2);
  // 键存在但不是数组 ⇒ 命中数走「存在性」口径（getElements 会误报 0）
  assert.equal(r.candidates.find((c) => c.selector === '$.data')?.hitCount, 1);
});

test('C-③b JSON 规则本身命中时，命中数也不能被 getElements 误报成 0', async () => {
  // `$.data` 是对象：`getElements` 回 []（实测），但键真实存在 ⇒ 探针必须报 1
  const r = await probeSelector({ selector: '$.data', content: JSON_TEXT });
  assert.equal(r.ok, true);
  assert.equal(r.hitCount, 1);
  assert.match(r.samples[0] ?? '', /"books"/);
});

test('C-④ 0 命中 + 变体不通 ⇒ 退到页面 class 频次统计（命中数真跑出来）', async () => {
  // content 用的是 span.author，但选择器写成了 .writer（页面里根本没这个词）
  const r = await probeSelector({ selector: '.writer', content: HTML });
  assert.equal(r.hitCount, 0);
  assert.ok(r.candidates.length > 0);
  assert.equal(r.candidates[0]?.selector, '.box');
  assert.equal(r.candidates[0]?.hitCount, 2);
});

test('C-⑤ 空选择器 / 空内容 ⇒ 各自的码，且候选为空', async () => {
  const a = await probeSelector({ selector: '', content: HTML });
  assert.equal(a.code, PROBE_CODES.NO_RULE);
  assert.deepEqual(a.candidates, []);
  const b = await probeSelector({ selector: '.box', content: '' });
  assert.equal(b.code, PROBE_CODES.NO_CONTENT);
});

/* ------------------------------------------------------------------ */
/* `#556` 列表容器：给元素本身，且不能套「单值字段」的判据              */
/* ------------------------------------------------------------------ */

test('B-⑨ 列表容器（elements）：逐条给命中元素的完整 HTML，且**不**报「单值」提示', async () => {
  // 一个接近真实书卡的元素（带封面/书名/作者/章节链接），刻意超过旧的 220 字截断
  const card = (i: number) =>
    `<div class="item"><a href="/${i}/"><img src="c${i}.jpg" /></a><div class="itemtxt">` +
    `<h3><a href="/${i}/">书${i}</a></h3><p><span>连载中</span><span>都市</span></p>` +
    `<p><a href="/zuozhe/?tag=x">作者：某${i}</a></p><p><i>更新时间</i>最新三章节</p>` +
    `<ul><li><i>10-1${i}</i><a href="/${i}/1.html">第${i}章</a></li><li><i>10-0${i}</i><a>第${i - 1}章</a></li></ul>` +
    `</div></div>`;
  const html = `<html><body>${Array.from({ length: 10 }, (_, i) => card(i)).join('')}</body></html>`;
  const r = await probeField({ rule: '.item', content: html, mode: 'elements', field: 'ruleSearch.bookList' });
  assert.equal(r.ok, true);
  assert.equal(r.hitCount, 10, '列表命中 10 项是**正常**的（Legado getElements）');
  assert.equal(r.samples.length, 10, '默认给全（上限 30）');
  assert.ok((r.samples[0] ?? '').length > 220, '单个元素要完整，不能被 220 字截断');
  assert.match(r.samples[0] ?? '', /<\/div>$/);
  // ★ 关键回归：列表容器上绝不能出现「单值字段」那句提示（用户 2026-10-21 的原始困惑）
  assert.equal(r.hints, undefined);
});

test('B-⑩ 列表容器：命中数超过回显上限时截断，并在 hints 里说明', async () => {
  const html = `<html><body>${Array.from({ length: 35 }, (_, i) => `<div class="item">书${i}</div>`).join('')}</body></html>`;
  const r = await probeField({ rule: '.item', content: html, mode: 'elements' });
  assert.equal(r.hitCount, 35);
  assert.equal(r.samples.length, 30);
  assert.match(r.hints?.[0] ?? '', /只回了前 30 个/);
});
