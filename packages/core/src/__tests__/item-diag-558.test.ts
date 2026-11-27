/**
 * `#558` 行内字段 0 命中：必须说清是**哪一种**取不到。
 *
 * 用户实测三例（速读谷自制源）在旧版都只得到同一句「作用域 10 项，每项都解出空串」，
 * 而三例的改法完全不同 ⇒ 提示等于没用。这里把三条判据锁住：
 *
 *  ① `@css:.item a img@src` —— 行内规则**自带列表容器选择器**（项内没有嵌套 `.item`）；
 *  ② `p:eq(1) a@text` —— jsoup `:eq(n)` 是**父元素兄弟序号**，不是「第 n 个同名标签」；
 *  ③ `p.1 a@text` —— `.N` 段末索引只在**段末**生效，写在复合选择器中间会被当类名；
 *  ④ 元素命中但 `@src` 取不到 —— 选择器没错，是**指令**选错。
 *
 * ★ 同时锁住「正确写法确实能解出东西」，否则只是换了一种说法的空。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeField, explainItemRule } from '../diag/probe';

/** 速读谷搜索结果项的真实结构（2026-10-21 实抓，压缩空白） */
const SEARCH_HTML = `<div class="item"><a href="/167/"><img src="https://a.test/c1.jpg" /></a>`
  + `<div class="itemtxt"><h3><a href="/167/">我的模拟长生路</a></h3>`
  + `<p><span>已完结</span><span>仙侠</span></p>`
  + `<p><a href="/zuozhe/?tag=x">作者：愤怒的乌贼</a></p>`
  + `<p><i>更新时间</i>最新三章节</p>`
  + `<ul><li><i>09-14</i><a href="/167/1.html">完本感言</a></li></ul></div></div>`
  + `<div class="item"><a href="/3748/"><img src="https://a.test/c2.jpg" /></a>`
  + `<div class="itemtxt"><h3><a href="/3748/">人在美利坚</a></h3>`
  + `<p><span>连载中</span><span>都市</span></p>`
  + `<p><a href="/zuozhe/?tag=y">作者：喜欢吃圣代</a></p>`
  + `<p><i>更新时间</i>最新三章节</p>`
  + `<ul><li><i>10-18</i><a href="/3748/1.html">第569章</a></li></ul></div></div>`;

const scopeProbe = (rule: string, scopeRule = '.item') =>
  probeField({ rule, content: SEARCH_HTML, field: 'ruleSearch.author', mode: 'list', scopeRule });

/**
 * `#703` **口径反转**：这条用例原来断言「`@css:.item a img@src` 必 0 命中、应报 CONTAINER_IN_RULE」。
 *
 * 那个结论是**修复前**的（我们当时用 `root.querySelectorAll` 求值，把 root 当作用域根，
 * 于是「容器选择器」`��.item` 既不在项内、也够不着项自身 ⇒ 恒 0）。
 * 但 `jsoup`（上游）的祖先链是整棵文档的：`.item` 正好是项的**祖先**（就是它自己），
 * 所以这条规则**本该有值**。实测：精华书阁手机版 V2 的整套 `@css:html > body > …` 行内规则
 * 全空、整源搜索 0 条，就是同一个根因。
 *
 * ⇒ 现在锁「它能解出值」，并且**不再误报** CONTAINER_IN_RULE。
 */
test('#703 D-①：容器是项祖先时 `@css:.item a img@src` 应当有值（不再误报 CONTAINER_IN_RULE）', async () => {
  const r = await scopeProbe('@css:.item a img@src');
  assert.equal(r.ok, true, `应当解出封面地址，实际：${JSON.stringify({ code: r.code, error: r.error })}`);
  // 每项解出**自己那一个** img（不是把两册的图都算进来）
  assert.deepEqual(r.values, ['https://a.test/c1.jpg', 'https://a.test/c2.jpg']);
});

test('D-① 真·解不出时仍给「去掉前缀」的写法（容器存在但选择器落空）', async () => {
  // `.item` 是项的祖先（能匹配），但 `.nope` 在项里不存在 ⇒ 仍是 0 命中 ⇒ 走同一条提示
  const r = await scopeProbe('@css:.item .nope@text');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONTAINER_IN_RULE');
  const h = (r.hints ?? []).join('\n');
  assert.match(h, /列表容器选择器/);
  assert.match(h, /\.nope@text/, '要给出可执行的新写法');
});

test('D-② :eq(n)：说清是「父元素兄弟序号」，不是「第 n 个同名标签」', async () => {
  const r = await scopeProbe('@css:.itemtxt p:eq(1) a@text');
  assert.equal(r.ok, false);
  const h = (r.hints ?? []).join('\n');
  assert.match(h, /兄弟序号/);
  assert.match(h, /不是「第 2 个同名标签」/);
});

test('D-③ `.N` 不在段末：说清被当类名，并给分段写法', async () => {
  const r = await scopeProbe('p.1 a@text');
  assert.equal(r.ok, false);
  const h = (r.hints ?? []).join('\n');
  assert.match(h, /只在\*\*该段末尾\*\*生效/);
  assert.match(h, /p\.1@a@text/, '给出分段写法');
});

test('D-④ 元素命中但取不到属性：报 PROP_EMPTY（不是选择器错）', async () => {
  // `div` 上有文本但没有 src
  const r = await scopeProbe('.itemtxt@src');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROP_EMPTY');
  assert.match((r.hints ?? []).join('\n'), /没有该属性/);
});

test('D-⑤ 三种「正确写法」都真的解得出作者（否则提示只是换个说法）', async () => {
  /**
   * ⚠️ `@css:` 模式下 `@` 只能出现一次（最后一个 `@` 之后是属性指令），
   * 所以「逐级下降」那条必须去掉 `@css:` 前缀写（`p@a@text`）——
   * 写成 `@css:p@a@text` 会被切成 sel=`p@a` ⇒ 0 命中（`#551` 已锁过的口径）。
   */
  for (const rule of ['@css:.itemtxt p:eq(2) a@text', 'p@a@text', 'p.1@a@text']) {
    const r = await scopeProbe(rule);
    assert.equal(r.ok, true, `${rule} 应命中`);
    assert.match(r.values?.[0] ?? '', /作者：/, `${rule} 第 1 项`);
  }
});

test('D-⑥ 封面：去掉容器前缀后能取到 src', async () => {
  const r = await scopeProbe('@css:a img@src');
  assert.equal(r.ok, true);
  assert.match(r.values?.[0] ?? '', /^https:\/\/a\.test\/c1\.jpg$/);
});

test('D-⑦ explainItemRule：没量到元素数（-1）且无静态特征时返回 null —— 不编结论', () => {
  const r = explainItemRule({ rule: 'h3@a@text', scopeRule: 'div.item', elCount: -1, prop: 'text' });
  assert.equal(r, null);
});
