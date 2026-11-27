/**
 * `#555` 试跑前置判定回归锁（用户 2026-10-21 对工坊试跑的评审）：
 *
 *  ① **行内字段必须在「列表项内」求值**，对着整页求值会把所有同类节点拼成一坨
 *     （用户反馈的原始症状：书名/作者/简介/最新章节全糊在一起）。
 *  ② **「点一下」先分类再跑**：源 URL 只做连通测试、JS 字段跑 JS、元数据字段根本不该有试跑。
 *  ③ **静态构造不出 URL 就如实说**（`{{$.id}}` 这类），绝不猜一个 URL 给出假结论。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeField } from '../diag/probe';
import {
  analyzeLoginUi,
  classifyRuleField,
  defaultSearchKeyword,
  interpSearchUrl,
  loginUrlKind,
  parseUrlOptions,
} from '../diag/url-probe';

const SEARCH = `<ul class="list">
  <li class="item"><a class="n" href="/b/1">雪中悍刀行</a><span class="a">烽火戏诸侯</span><em class="c">玄幻</em></li>
  <li class="item"><a class="n" href="/b/2">道君</a><span class="a">跃千愁</span><em class="c">仙侠</em></li>
  <li class="item"><a class="n" href="/b/3">诡秘之主</a><span class="a">爱潜水的乌贼</span><em class="c">奇幻</em></li>
</ul>`;

/* ---------------- ① 作用域：行内字段 ---------------- */

test('S-① 行内字段在列表项内求值：逐项给值，不拼整页', async () => {
  const r = await probeField({
    rule: '.n@text',
    content: SEARCH,
    scopeRule: '.item',
    field: 'ruleSearch.name',
  });
  assert.equal(r.ok, true);
  assert.equal(r.itemCount, 3);
  assert.equal(r.hitCount, 3); // 作用域模式下 hitCount = 列表项数
  assert.deepEqual(r.values, ['雪中悍刀行', '道君', '诡秘之主']);
  // 关键：**没有**把三项拼成 `雪中悍刀行\n道君\n诡秘之主` 之外的额外噪声
  assert.equal(r.value.split('\n').length, 3);
  assert.equal(r.scopeRule, '.item');
});

test('S-② 作用域取前 N 项（scopeLimit），但 itemCount 报全量', async () => {
  const r = await probeField({ rule: '.n@text', content: SEARCH, scopeRule: '.item', scopeLimit: 2 });
  assert.equal(r.itemCount, 3);
  assert.equal(r.values.length, 2);
});

test('S-③ 作用域 0 命中 ⇒ SELECTOR_MISS，并指明「先修列表规则」', async () => {
  const r = await probeField({ rule: '.n@text', content: SEARCH, scopeRule: '.no-such-item' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SELECTOR_MISS');
  assert.match(r.error ?? '', /作用域规则 0 命中/);
  assert.equal(r.itemCount, 0);
});

test('S-④ 作用域只命中 1 项 ⇒ 提示「列表规则可能写窄了」', async () => {
  const html = `<div class="item"><a class="n">只有一本</a></div>`;
  const r = await probeField({ rule: '.n@text', content: html, scopeRule: '.item' });
  assert.equal(r.itemCount, 1);
  assert.ok((r.hints ?? []).some((h) => h.includes('写窄')));
});

test('S-⑤ 部分项解出空 ⇒ 明确报「N 项里有 M 项空」', async () => {
  const html = `<li class="item"><a class="n">A</a></li><li class="item"><b>没有 a 标签</b></li>`;
  const r = await probeField({ rule: '.n@text', content: html, scopeRule: '.item' });
  assert.equal(r.ok, true);
  assert.equal(r.values[1], '');
  assert.ok((r.hints ?? []).some((h) => h.includes('项里有 1 项解出空')));
});

/* ---------------- ② 字段形态分类 ---------------- */

test('C-① 分类：URL / JS / HTML / 规则 / 纯文本', () => {
  assert.equal(classifyRuleField('https://www.example.com'), 'url');
  assert.equal(classifyRuleField('@js:result'), 'js');
  assert.equal(classifyRuleField('<js>1+1</js>'), 'js');
  assert.equal(classifyRuleField('<button action="doLogin()">登录</button>'), 'html');
  assert.equal(classifyRuleField('.book-name@text'), 'rule');
  assert.equal(classifyRuleField('//div[@id="x"]'), 'rule');
  assert.equal(classifyRuleField('$.data.name'), 'rule');
  assert.equal(classifyRuleField('我的'), 'plain');
  assert.equal(classifyRuleField('0'), 'plain');
  assert.equal(classifyRuleField(''), 'plain');
});

test('C-② loginUrl 形态：空 / 网址 / JS / 混写', () => {
  assert.equal(loginUrlKind(''), 'empty');
  assert.equal(loginUrlKind('https://a.test/login'), 'url');
  assert.equal(loginUrlKind('@js:java.startBrowserAwait(url)'), 'js');
  assert.equal(loginUrlKind('https://a.test/login\n@js:doLogin()'), 'mixed');
});

/* ---------------- ③ 搜索 URL：选项与插值 ---------------- */

test('U-① `,{…}` 选项拆分：URL 与选项分开，不吞逗号', () => {
  const r = parseUrlOptions('https://a.test/search?q={{key}},{"method":"POST","body":"k={{key}}"}');
  assert.equal(r.url, 'https://a.test/search?q={{key}}');
  assert.equal(r.options['method'], 'POST');
  assert.equal(r.optionsError, undefined);
});

test('U-② 选项 JSON 坏了 ⇒ 整串当 URL，并报 optionsError（不静默丢）', () => {
  const r = parseUrlOptions('https://a.test/s?q=1,{"method":');
  assert.equal(r.url, 'https://a.test/s?q=1,{"method":');
  assert.match(r.optionsError ?? '', /解析失败/);
});

test('U-③ 插值：{{key}} 编码、{{page}} 原样、{{page+1}} 加法', () => {
  const r = interpSearchUrl('https://a.test/s?k={{key}}&p={{page}}&n={{page+1}}', { keyword: '我的 书', page: 3 });
  assert.equal(r.url, `https://a.test/s?k=${encodeURIComponent('我的 书')}&p=3&n=4`);
  assert.equal(r.unsupported, undefined);
  assert.deepEqual(r.replaced, ['{{key}}', '{{page}}', '{{page+1}}']);
});

test('U-④ 认不出的插值 ⇒ unsupported（宁可说「得真跑」，也不猜 URL）', () => {
  const r = interpSearchUrl('https://a.test/s?k={{key}}&id={{$.book.id}}', { keyword: '我的', page: 1 });
  assert.match(r.unsupported ?? '', /需真跑的插值/);
  assert.match(r.url, /\{\{\$\.book\.id\}\}/); // 原样留着，便于人眼看出是哪一段
});

test('U-⑤ 默认关键词：有 checkKeyWord 用它，否则「我的」', () => {
  assert.equal(defaultSearchKeyword('校验词'), '校验词');
  assert.equal(defaultSearchKeyword(''), '我的');
  assert.equal(defaultSearchKeyword(undefined), '我的');
});

/* ---------------- ④ 登录界面静态解析 ---------------- */

test('L-① loginUi 解析：按钮 action 分成 fn / inline / 缺失三类', () => {
  const html = `
    <multi>
    <input name="account" placeholder="账号" />
    <input name="pwd" type="password" placeholder="密码" />
    <button action="doLogin()">登录</button>
    <button action="if (x) { y() }">高级</button>
    <button>没接线</button>
    </multi>`;
  const r = analyzeLoginUi(html);
  assert.equal(r.ok, true);
  assert.equal(r.buttons.length, 3);
  assert.equal(r.buttons[0]?.actionKind, 'fn');
  assert.equal(r.buttons[1]?.actionKind, 'inline');
  assert.equal(r.buttons[2]?.actionKind, 'none');
  assert.deepEqual(
    r.fields.map((f) => f.name),
    ['account', 'pwd'],
  );
  assert.equal(r.multi, true);
  assert.ok(r.warnings.some((w) => w.includes('没写 action')));
});

test('L-② 空 loginUi ⇒ 明确说明「这个源不需要自定义界面」', () => {
  const r = analyzeLoginUi('');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /登录界面为空/);
});

test('L-③ 界面含 {{}} / @js: ⇒ 提醒静态预览是未求值原样', () => {
  const r = analyzeLoginUi('<button action="doLogin()">{{getKey()}}</button>');
  assert.ok(r.warnings.some((w) => w.includes('未求值')));
});
