/**
 * `#542` 规则 lint 表的回归锁（P2-c）。
 *
 * 每条规则都要**正例 + 反例**：只测正例会退化成「永远报警」（`#521` 的 443 个假语法错教训）。
 * 特别锁住本轮修掉的三个误报形态：
 *  · `@js:` 后接 `##regex` 是**合法**的（不是「@js: 不在最后」）；
 *  · `rule##regex`（单个 `##`、无替换）是**合法**的（不能按奇偶判）；
 *  · 纯 JS 串里的 `{{` 是 JS 大括号（不是占位符未闭合）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource, jsChunksOf, LINT_RULES } from '../diag/rule-lint';

const base = { bookSourceUrl: 'https://t.test', bookSourceName: 'lint 测试源' };
const ids = (raw: Record<string, unknown>): string[] => lintSource({ ...base, ...raw }).map((f) => f.ruleId);

test('L001 解构参数缺括号：正例报、修好的不报', () => {
  assert.ok(ids({ ruleExplore: { bookList: '@js:var s=[]; sort.map([a,b]=>{ s.push(a) })' } }).includes('L001'));
  assert.ok(!ids({ ruleExplore: { bookList: '@js:var s=[]; sort.map(([a,b])=>{ s.push(a) })' } }).includes('L001'));
  // fix 必须是**字节级**可替换（search 在原文里能命中）
  const f = lintSource({ ...base, ruleExplore: { bookList: '@js:sort.map([a,b]=>1)' } }).find((x) => x.ruleId === 'L001');
  assert.ok(f?.fix, 'L001 应带可自动修补丁');
  assert.ok('@js:sort.map([a,b]=>1)'.includes(f!.fix!.search), 'fix.search 必须能在原文命中');
});

test('L002 不可见字符：零宽空格报、正常文本不报', () => {
  assert.ok(ids({ ruleContent: { content: '@js:var a = "\u200B1"; a' } }).includes('L002'));
  assert.ok(!ids({ ruleContent: { content: '@js:var a = "1"; a' } }).includes('L002'));
});

test('L003 `@js:` 后缀：以 @attr 结尾报；接 `##regex` 合法不报', () => {
  assert.ok(ids({ ruleToc: { chapterUrl: 'a@href@js:result@text' } }).includes('L003'));
  // ⚠️ 误报形态：`@js: result##.*作者：`（JS 结果再做正则清洗）是合法的
  assert.ok(!ids({ ruleExplore: { author: '1@text||span.1@text @js: result##.*作者：' } }).includes('L003'));
  // JS 正文里出现 `@text` 字样也不该报
  assert.ok(!ids({ ruleToc: { chapterUrl: "a@href@js:var s='@text'; s" } }).includes('L003'));
});

test('L006 占位符缺闭合：选择器里 `{{` 多于 `}}` 报；纯 JS 的 `{{` 不报', () => {
  assert.ok(ids({ searchUrl: 'https://t.test/s?q={{key}' }).includes('L006'));
  assert.ok(!ids({ searchUrl: 'https://t.test/s?q={{key}}' }).includes('L006'));
  // ⚠️ 误报形态：JS 里的 `{ {`（对象/块）不是占位符
  assert.ok(!ids({ ruleContent: { content: '@js:var o = {{a:1}.a}; o' } }).includes('L006'));
});

test('L007 POST body：对象字面量报；字符串/String()/变量不报', () => {
  assert.ok(ids({ ruleSearch: { bookUrl: 'https://t.test/s,{"method":"POST","body":{"a":1}}' } }).includes('L007'));
  assert.ok(!ids({ ruleSearch: { bookUrl: 'https://t.test/s,{"method":"POST","body":"a=1"}' } }).includes('L007'));
  assert.ok(!ids({ ruleSearch: { bookUrl: 'https://t.test/s,{"method":"POST","body":String(x)}' } }).includes('L007'));
  assert.ok(!ids({ ruleSearch: { bookUrl: 'https://t.test/s,{"method":"POST","body":payload}' } }).includes('L007'));
});

test('L008 JS 语法错：坏片段报（带行号或片段）；合法不报；中缀 @js: 不编译', () => {
  const bad = lintSource({ ...base, ruleToc: { chapterList: '@js:var a = (' } }).find((f) => f.ruleId === 'L008');
  assert.ok(bad, '未闭合括号必须报');
  assert.ok(!ids({ ruleToc: { chapterList: '@js:var a = 1 + 2; a' } }).includes('L008'));
  // ⚠️ 中缀 `@js:`（URL 前缀 + JS 表达式）**不编译**：否则 68 个正常源被报假语法错
  assert.ok(!ids({ ruleToc: { chapterList: 'https://t.test/{{$.id}},{"method":"GET"}' } }).includes('L008'));
  assert.deepEqual(jsChunksOf('https://t/api?x=1@js:result'), [], '中缀 @js: 不抽 JS 片段');
});

test('L009 严格模式必填：legado 缺字段报 info；rss/vod 不套书源模板', () => {
  const f = lintSource({ ruleSearch: { name: 'x' } }, 'legado').filter((x) => x.ruleId === 'L009');
  assert.ok(f.length > 0, 'legado 缺 bookSourceUrl/Name 必须报');
  assert.ok(f.every((x) => x.severity === 'info'), '必填项只报 info（不少源有意缺搜索）');
  assert.equal(lintSource({ sourceUrl: 'https://rss.test', ruleArticles: 'x' }, 'rss').filter((x) => x.ruleId === 'L009').length, 0);
});

test('L010/L011 路由与入口：L1 强留 / 搜索无占位 各一条 info', () => {
  assert.ok(
    ids({ jsLib: 'var j = new JavaImporter(); j.importPackage(Packages.java.util.concurrent);', ruleToc: { chapterList: 'a' } }).includes('L010'),
  );
  assert.ok(!ids({ ruleToc: { chapterList: 'a' } }).includes('L010'));
  assert.ok(ids({ searchUrl: 'https://t.test/search/all' }).includes('L011'));
  assert.ok(!ids({ searchUrl: 'https://t.test/search?q={{key}}' }).includes('L011'));
});

test('lint 表自洽：id 唯一、每条规则都有标题与修法', () => {
  const seen = new Set<string>();
  for (const r of LINT_RULES) {
    assert.ok(!seen.has(r.id), `id 重复：${r.id}`);
    seen.add(r.id);
    assert.ok(r.title && r.hint, `${r.id} 缺标题/修法`);
  }
});
