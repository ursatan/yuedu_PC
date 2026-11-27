/**
 * `#556` 发现规则探针的单测。
 *
 * 锁的四件事（都是用户 2026-10-21 评审里点名的）：
 *  ① **形态判定**：`@js:`/`<js>` / JSON 数组 / `名称::URL` 文本 —— 判错就会拿错通路，
 *     于是「试跑通过、真跑 0 分类」；
 *  ② **自动纠正只修语法**：全角标点、`::` 误用、缺逗号、尾逗号、括号未闭合；
 *     **不碰**语义（不替用户把 `名称::URL` 文本重写成 JSON 数组）；
 *  ③ **`host` 未定义必须照实报**：语料里 `url: host + '/x'` 在真跑里同样是 ReferenceError，
 *     探针若偷偷补个 host，就等于给出「试跑能过」的假结论；
 *  ④ **分类表的校验**：无 title / 无 url（分组标题）/ 相对 URL 都要说出来。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoCorrectExploreRule,
  classifyExploreRule,
  probeExplore,
} from '../diag/explore-probe';

test('① 形态判定：js / json / text / empty 四种', () => {
  assert.equal(classifyExploreRule(''), 'empty');
  assert.equal(classifyExploreRule('   '), 'empty');
  assert.equal(classifyExploreRule(undefined), 'empty');
  assert.equal(classifyExploreRule('@js: JSON.stringify([{title:"A",url:"/a"}])'), 'js');
  assert.equal(classifyExploreRule('<js>return []</js>'), 'js');
  assert.equal(classifyExploreRule('  [{"title":"A","url":"/a"}]'), 'json');
  assert.equal(classifyExploreRule('{title:"A",url:"/a"}'), 'json');
  assert.equal(classifyExploreRule('完结::/wanjie/&&都市::/dushi/'), 'text');
  assert.equal(classifyExploreRule('https://x.test/list?page={{page}}'), 'text');
});

test('② 自动纠正：全角标点 + :: 误用 + 漏逗号 + 尾逗号', () => {
  // 键名带引号：这样「修完能被 JSON.parse 直接吃下」才有客观判据。
  // 键名**不带**引号的写法（`{title:"A"}`）是合法 JS 但非法 JSON，引擎靠 eval 回落，
  // 所以那不是「语法错」——自动纠正不该去给它加引号（见 ②c）。
  const bad = '[{"title"： "完结小说"，"url": "/wanjie/"} {"title":: "都市小说", "url": "/dushi/"},]';
  const { text, fixes } = autoCorrectExploreRule(bad);
  const codes = fixes.map((f) => f.code);
  assert.ok(codes.includes('wide-colon'), `应有全角冒号修正：${JSON.stringify(fixes)}`);
  assert.ok(codes.includes('wide-comma'));
  assert.ok(codes.includes('double-colon'));
  assert.ok(codes.includes('missing-comma'));
  assert.ok(codes.includes('trailing-comma'));
  // 修完必须是合法 JSON（这是「可自动纠正」的唯一客观判据）
  const parsed = JSON.parse(text) as { title: string; url: string }[];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.title, '完结小说');
  assert.equal(parsed[1]!.url, '/dushi/');
});

test('②b 自动纠正：括号未闭合补齐，且不碰字符串内部的括号', () => {
  const bad = '[{"title":"A","url":"https://x.test/[id]"},{"title":"B","url":"/b"}';
  const { text, fixes } = autoCorrectExploreRule(bad);
  assert.ok(fixes.some((f) => f.code === 'unbalanced'));
  assert.doesNotThrow(() => JSON.parse(text));
  // 字符串里的 `[id]` 不能被当成括号计数（否则会多补一个 ]）
  assert.equal(text, '[{"title":"A","url":"https://x.test/[id]"},{"title":"B","url":"/b"}]');
});

test('②c 合法文本不该被改动（自动纠正不重排格式）', () => {
  const ok = '[{"title":"A","url":"/a"},{"title":"B","url":"/b"}]';
  const { text, fixes } = autoCorrectExploreRule(ok);
  assert.equal(text, ok);
  assert.equal(fixes.length, 0);
});

test('③ JSON 数组形态：解析成分类表并报相对 URL', async () => {
  const r = await probeExplore({ raw: '[{"title":"完结","url":"/wanjie/"},{"title":"都市","url":"/dushi/"}]' });
  assert.equal(r.kind, 'json');
  assert.equal(r.ok, true);
  assert.equal(r.kinds.length, 2);
  assert.equal(r.clickable, 2);
  assert.ok(r.problems.some((p) => p.code === 'RELATIVE_URL'));
});

test('③b 分组标题（无 url）不算可点分类，且提示出来', async () => {
  const r = await probeExplore({ raw: '[{"title":"地区"},{"title":"都市","url":"/dushi/"}]' });
  assert.equal(r.kinds[0]!.header, true);
  assert.equal(r.clickable, 1);
  assert.ok(r.problems.some((p) => p.code === 'NO_URL'));
});

test('③c 缺 title 要报 NO_TITLE', async () => {
  const r = await probeExplore({ raw: '[{"url":"/a"}]' });
  assert.ok(r.problems.some((p) => p.code === 'NO_TITLE'));
});

test('④ @js: 脚本 return 数组：真跑出分类', async () => {
  const r = await probeExplore({ raw: '@js: [{title:"A",url:"/a"},{title:"B",url:"/b"}]' });
  assert.equal(r.kind, 'js');
  assert.equal(r.ok, true);
  assert.equal(r.kinds.length, 2);
});

test('④b @js: 脚本 return JSON 串：同样解析', async () => {
  const r = await probeExplore({ raw: '@js: JSON.stringify([{title:"A",url:"/a"}])' });
  assert.equal(r.ok, true);
  assert.equal(r.kinds.length, 1);
  assert.equal(r.kinds[0]!.title, 'A');
});

test('④c `host` 未定义必须照实报错（不替它编一个）', async () => {
  const r = await probeExplore({ raw: '@js: [{title:"A",url: host + "/a"}]' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /host/);
  assert.equal(r.kinds.length, 0);
});

test('⑤ 文本形态 `名称::URL`：按 && / 换行切分', async () => {
  const r = await probeExplore({ raw: '完结::/wanjie/&&都市::/dushi/' });
  assert.equal(r.kind, 'text');
  assert.equal(r.kinds.length, 2);
  assert.equal(r.kinds[0]!.title, '完结');
  assert.equal(r.kinds[0]!.url, '/wanjie/');
  // ★ 文本形态的 `::` 是**正确分隔符**，不能被当成「误用」报错或修掉
  assert.equal(r.problems.filter((p) => p.code === 'double-colon').length, 0);
});

test('⑤c 文本形态：全角 `：：` 才算错，且只修它', async () => {
  const { text, fixes } = autoCorrectExploreRule('完结：：/wanjie/', 'text');
  assert.equal(text, '完结::/wanjie/');
  assert.deepEqual(fixes.map((f) => f.code), ['wide-colon']);
  // 正确写法原样返回
  const ok = autoCorrectExploreRule('完结::/wanjie/&&都市::/dushi/', 'text');
  assert.equal(ok.text, '完结::/wanjie/&&都市::/dushi/');
  assert.equal(ok.fixes.length, 0);
});

test('⑤b 文本里没有 :: 的行是不可点标题', async () => {
  const r = await probeExplore({ raw: '热门\n都市::/dushi/' });
  assert.equal(r.clickable, 1);
  assert.equal(r.kinds[0]!.header, true);
});

test('⑥ 语法坏掉的 JSON：既报错也给可修标记', async () => {
  const r = await probeExplore({ raw: '[{title： "A", url: "/a"}]' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === 'wide-colon' && p.fixable));
  assert.ok(r.error);
});

test('⑦ 空 exploreUrl：不是错误，只是没有发现页', async () => {
  const r = await probeExplore({ raw: '' });
  assert.equal(r.kind, 'empty');
  assert.match(String(r.error), /没有发现页/);
});
