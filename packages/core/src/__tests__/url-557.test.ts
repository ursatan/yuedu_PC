/**
 * `#557` 锁：URL 模板**真求值**（`evalUrlTemplate`）+ `loginUi` 规则校验（`checkLoginUi`）。
 *
 * 用户 2026-10-21 报的四种 searchUrl 写法和发现页 `{{page == 1 ? …}}` 都在这里钉住：
 * 以前 `interpSearchUrl` 只认 `{{key}}`/`{{page}}`/`{{page+1}}`，其余一律「需真跑」，
 * 于是 `,{}` 尾巴、`<js>` 段、表达式、相对路径**四种都跑不了**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evalUrlTemplate } from '../diag/url-probe';
import { checkLoginUi, classifyLoginUi, definedNames } from '../diag/login-ui-check';

/** 模拟引擎的 JS 求值器（绑定与 `AnalyzeUrl.evalJS` 同面） */
function jsEnv(bind: { page: number; key: string; baseUrl: string; result?: string }) {
  return (code: string): unknown => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function('page', 'key', 'baseUrl', 'result', `return (${code});`);
    return fn(bind.page, bind.key, bind.baseUrl, bind.result ?? '');
  };
}

test('U-① `,{charset/method/body}` 尾巴：URL 与选项分开，body 里的 {{key}} 也插值', async () => {
  const r = await evalUrlTemplate(
    '/s.php,{"charset": "gbk","method":"post","body":"objectType=2&type=articlename&s={{key}}"}',
    { keyword: '我的 书', page: 1, baseUrl: 'https://a.test/' },
  );
  assert.equal(r.url, 'https://a.test/s.php');
  assert.equal(r.method, 'POST');
  assert.equal(r.options['charset'], 'gbk');
  assert.equal(r.body, `objectType=2&type=articlename&s=${encodeURIComponent('我的 书')}`);
  assert.deepEqual(r.errors, []);
});

test('U-② `<js>result = … + encodeURIComponent(key)</js>`：JS 段真跑（旧版直接放弃）', async () => {
  const r = await evalUrlTemplate(
    '<js>result = getHost() + "/i/sor.aspx?key=" + encodeURIComponent(key);</js>',
    {
      keyword: '我的 书',
      page: 1,
      baseUrl: 'https://a.test/',
      evalJsSegment: (code, current) => {
        // 源里的 getHost() 来自 jsLib；`result` 是参数（引擎同款绑定，供 `result = …` 赋值）
        const getHost = () => 'https://a.test';
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('getHost', 'key', 'result', `${code}\n;return result;`);
        return String(fn(getHost, '我的 书', current));
      },
    },
  );
  assert.equal(r.jsSegment, true);
  assert.equal(r.url, `https://a.test/i/sor.aspx?key=${encodeURIComponent('我的 书')}`);
});

test('U-③ `{{key}}&p={{page}}`：静态也能算，且第 2 页真的换成 2', async () => {
  const tpl = 'https://a.test/search.php?q={{key}}&p={{page}}';
  const p1 = await evalUrlTemplate(tpl, { keyword: '书', page: 1 });
  const p2 = await evalUrlTemplate(tpl, { keyword: '书', page: 2 });
  assert.equal(p1.url, `https://a.test/search.php?q=${encodeURIComponent('书')}&p=1`);
  assert.equal(p2.url, `https://a.test/search.php?q=${encodeURIComponent('书')}&p=2`);
});

test('U-④ `page/{{page}}?s={{key}}`：相对路径按源 URL 绝对化', async () => {
  const r = await evalUrlTemplate('page/{{page}}?s={{key}}', { keyword: '书', page: 3, baseUrl: 'https://a.test/list/' });
  assert.equal(r.url, `https://a.test/list/page/3?s=${encodeURIComponent('书')}`);
});

test('U-⑤ 发现页表达式 `{{page == 1 ? "" : page + ".html"}}`：页 1 首页、页 2 次页', async () => {
  const tpl = 'https://www.suduguu.com/wanjie/{{page == 1 ? "" : page + ".html"}}';
  const p1 = await evalUrlTemplate(tpl, { page: 1, evalExpr: jsEnv({ page: 1, key: '', baseUrl: '' }) });
  const p2 = await evalUrlTemplate(tpl, { page: 2, evalExpr: jsEnv({ page: 2, key: '', baseUrl: '' }) });
  assert.equal(p1.url, 'https://www.suduguu.com/wanjie/');
  assert.equal(p2.url, 'https://www.suduguu.com/wanjie/2.html');
  assert.deepEqual(p1.replaced, ['{{page == 1 ? "" : page + ".html"}}']);
});

test('U-⑥ `<1,2,3>` 页码模式（越界取最后一档）', async () => {
  const a = await evalUrlTemplate('https://a.test/l/<1,2,3>.html', { page: 2 });
  const b = await evalUrlTemplate('https://a.test/l/<1,2,3>.html', { page: 9 });
  assert.equal(a.url, 'https://a.test/l/2.html');
  assert.equal(a.pagePattern, true);
  assert.equal(b.url, 'https://a.test/l/3.html');
});

test('U-⑦ 算不出来的占位符：原样保留 + 报错（不猜、不悄悄换空串）', async () => {
  const r = await evalUrlTemplate('https://a.test/s?q={{$.book.id}}', { page: 1 });
  assert.equal(r.unresolved, true);
  assert.equal(r.url, 'https://a.test/s?q={{$.book.id}}');
  assert.equal(r.errors.length, 1);
});

test('U-⑧ 有求值器但表达式抛错：照样报错（如 host is not defined）', async () => {
  const r = await evalUrlTemplate('https://a.test/{{host}}/x', {
    page: 1,
    evalExpr: () => {
      throw new Error('host is not defined');
    },
  });
  assert.equal(r.unresolved, true);
  assert.match(r.errors[0] ?? '', /host is not defined/);
});

test('U-⑨ 已经是绝对地址的不动（不做二次拼装）', async () => {
  const r = await evalUrlTemplate('https://b.test/x?y=1', { page: 1, baseUrl: 'https://a.test/' });
  assert.equal(r.url, 'https://b.test/x?y=1');
});

/* ---------------------------- loginUi 校验 ---------------------------- */

/** 用户 2026-10-21 给的真实 loginUi（速读谷：1 整行 + 4 半行） */
const SDG_UI = JSON.stringify([
  { name: '⚡ 智能换源', type: 'button', action: 'smartswitch()', style: { layout_flexGrow: 1, layout_flexBasisPercent: 1.0 } },
  { name: '🔄 切换域名', type: 'button', action: 'sethost()', style: { layout_flexGrow: 1, layout_flexBasisPercent: 0.5 } },
  { name: '🔍 自动选可用', type: 'button', action: 'autohost()', style: { layout_flexGrow: 1, layout_flexBasisPercent: 0.5 } },
  { name: '📋 当前域名', type: 'button', action: 'checkhost()', style: { layout_flexGrow: 1, layout_flexBasisPercent: 0.5 } },
  { name: '📶 域名延迟', type: 'button', action: 'pinghost()', style: { layout_flexGrow: 1, layout_flexBasisPercent: 0.5 } },
]);

test('L-① 真实 JSON loginUi：5 行、按 basisPercent 排成 3 行', () => {
  const r = checkLoginUi({ raw: SDG_UI });
  assert.equal(r.kind, 'json');
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows.map((x) => x.widthPercent), [100, 50, 50, 50, 50]);
  assert.equal(r.layout.length, 3);
  assert.deepEqual(r.layout[0]?.items.map((x) => x.name), ['⚡ 智能换源']);
  assert.deepEqual(r.layout[1]?.items.map((x) => x.name), ['🔄 切换域名', '🔍 自动选可用']);
  assert.deepEqual(r.layout[2]?.items.map((x) => x.name), ['📋 当前域名', '📶 域名延迟']);
});

test('L-② action 的函数定义查得到 / 查不到 —— 都要如实说', () => {
  // 没给登录脚本：不是「函数名写错」，是「没地方定义」——单独一个码，且**汇总成一条**
  const noJs = checkLoginUi({ raw: SDG_UI });
  assert.equal(noJs.actions.every((a) => a.defined === undefined), true, '没给脚本时应是「未知」，不能断言 false');
  assert.equal(noJs.problems.filter((p) => p.code === 'LOGINUI_ACTION_NO_JS').length, 1);
  assert.equal(noJs.problems.some((p) => p.code === 'LOGINUI_ACTION_UNDEF'), false);

  // 给了登录脚本但确实找不到定义：逐行报，带行号
  const badJs = checkLoginUi({ raw: SDG_UI, loginJs: 'function sethost(){}' });
  assert.equal(badJs.problems.filter((p) => p.code === 'LOGINUI_ACTION_UNDEF').length, 4);
  assert.ok(badJs.problems.every((p) => p.code !== 'LOGINUI_ACTION_NO_JS'));
  assert.equal(badJs.actions[1]!.defined, true);
  assert.equal(badJs.actions[0]!.defined, false);

  const withJs = checkLoginUi({ raw: SDG_UI, loginJs: 'function smartswitch(){ java.toast("换源") }\nfunction sethost(){}\nfunction autohost(){}\nfunction checkhost(){}\nfunction pinghost(){}' });
  assert.equal(withJs.actions.every((a) => a.defined === true), true);
  assert.ok(!withJs.problems.some((p) => p.code === 'LOGINUI_ACTION_UNDEF'));
});

test('L-③ 缺 action 的 button / type 不认识 / name 缺失 各有专门问题码', () => {
  const r = checkLoginUi({
    raw: JSON.stringify([
      { name: '只有文字', type: 'button' },
      { name: '怪类型', type: 'slider', action: 'x()' },
      { type: 'text' },
    ]),
    loginJs: 'function x(){}',
  });
  const codes = r.problems.map((p) => p.code);
  assert.ok(codes.includes('LOGINUI_ACTION_MISSING'));
  assert.ok(codes.includes('LOGINUI_TYPE'));
  assert.ok(codes.includes('LOGINUI_NAME'));
  assert.equal(r.rows.length, 2); // 没 name 的那行 Legado 也不显示
});

test('L-④ 语法错（全角逗号 + 漏逗号）：报可修 + 给纠正全文（且纠正后必须真能解析）', () => {
  const bad = '[{"name":"A","type":"label"}，{"name":"B","type":"label"}]';
  const r = checkLoginUi({ raw: bad });
  assert.ok(r.problems.some((p) => p.fixable));
  assert.ok(r.fixed);
  assert.equal(JSON.parse(r.fixed as string).length, 2);
});

test('L-④b 修完仍解析不了的（全角花括号不在纠正范围）：不给 fixed，只说哪里还坏', () => {
  const r = checkLoginUi({ raw: '[{"name":"A","type":"label"｝]' });
  assert.equal(r.fixed, undefined);
  assert.ok(r.problems.some((p) => p.message.includes('全角')));
});

test('L-⑤ `{"version":2}` 只当标记：不假装能列出各行', () => {
  const r = checkLoginUi({ raw: '{"version":2}', loginJs: 'function loginUi(s){return "{}"}' });
  assert.equal(r.kind, 'v2');
  assert.equal(r.needEval, true);
  assert.equal(r.rows.length, 0);
});

test('L-⑥ 脚本形态要服务端代跑（needEval）+ 旧 HTML 形态仍能读', () => {
  assert.equal(classifyLoginUi('@js:`[{name:"A",type:"label"}]`'), 'script');
  assert.equal(checkLoginUi({ raw: '@js:`[]`' }).needEval, true);

  const html = checkLoginUi({ raw: '<div><input name="u" type="text"><button action="doLogin()">登录</button></div>' });
  assert.equal(html.kind, 'html');
  assert.equal(html.rows.length, 2);
  assert.ok(html.hints.some((h) => h.includes('JSON 数组')));
});

test('L-⑦ `definedNames`：四种常见定义写法都要认出来', () => {
  const s = 'function a(){}; var b = function(){}; const c = () => 1; d = function(){}; e:function(){}';
  const d = definedNames(s);
  for (const name of ['a', 'b', 'c', 'd', 'e']) assert.ok(d.has(name), `${name} 应被认出`);
});
