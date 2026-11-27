/**
 * URL 构造（Legado `AnalyzeUrl.initUrl` 等价）回归测试。
 *
 * 背景：`java.ajax/ajaxAll/get/post/getStrResponse` 收到的是**源脚本自己拼**的 URL，
 * 天然带 Legado 的 URL 约定：`{{内嵌 JS}}`、`<1,2,3>` 页码、`,{options}` 尾巴。
 * 此前这些约定只在「规则 URL」路径被解析，脚本路径直接把整串丢给 HTTP 层 →
 * 绿柠小说（ajaxAll 带 POST body）与七猫（java.ajax 带签名头）双双拿不到内容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareUrl, prepareRequest, splitUrlOptions, optionToRequest, applyUrlRuleJs, stripOptionalUrlSegments } from '../net/url-prep';
import { createJsEvaluator, createVariableStore } from '..';

/**
 * `#405②` `{,...}` 可选段（**非 Legado 语法**，源作者约定）：
 * 咚漫 `exploreUrl` 的分类值 = `https://m.dongmanmanhua.cn/genre{,/error.html}#LOVE`。
 * 上游无此语法 ⇒ 整段当字面量 ⇒ 站点 404（实测 `…/genre` = 200）。本仓剥离该段取主 URL。
 */
test('#405② prepareUrl/splitUrlOptions：剥离 `{,...}` 可选段，且不误伤 `,{options}` 尾巴', () => {
  assert.equal(
    prepareUrl('https://m.dongmanmanhua.cn/genre{,/error.html}#LOVE').url,
    'https://m.dongmanmanhua.cn/genre#LOVE',
  );
  assert.equal(stripOptionalUrlSegments('https://a/b{,/x.html}#T'), 'https://a/b#T');
  // 对偶：Legado 选项尾巴 `,{...}` 必须保留（形态不同）
  const r = prepareUrl('https://a.test/api,{"method":"POST","body":"k=v"}');
  assert.equal(r.url, 'https://a.test/api');
  assert.equal((r.option as { method?: string } | null)?.method, 'POST');
  // 对偶：无该语法 ⇒ 原样
  assert.equal(stripOptionalUrlSegments('https://a/b#T'), 'https://a/b#T');
});

test('prepareUrl: {{内嵌 JS}} 用当前绑定求值（page/key 是全局绑定，与 Legado evalJS 一致）', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const before = { page: g['page'], key: g['key'] };
  try {
    g['page'] = 3;
    g['key'] = '斗破';
    assert.equal(prepareUrl('https://a.test/list?p={{page}}&q={{key}}').url, 'https://a.test/list?p=3&q=%E6%96%97%E7%A0%B4'.replace('%E6%96%97%E7%A0%B4', '斗破'));
    // 表达式形态（不是单纯的变量名）
    assert.equal(prepareUrl('https://a.test/x?p={{page + 1}}').url, 'https://a.test/x?p=4');
    // 求值失败 → 空串（Legado 同样吞掉异常）
    assert.equal(prepareUrl('https://a.test/x?p={{ nope.nope }}').url, 'https://a.test/x?p=');
  } finally {
    g['page'] = before.page;
    g['key'] = before.key;
  }
});

test('prepareUrl: <1,2,3> 页码模式取当前 page（pagePattern = "<(.*?)>"）', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const before = g['page'];
  try {
    g['page'] = 2;
    assert.equal(prepareUrl('https://a.test/list/<1,2,3>.html').url, 'https://a.test/list/2.html');
    g['page'] = 9;
    // 越界 → 取最后一页（Legado：pages.last()）
    assert.equal(prepareUrl('https://a.test/list/<1,2,3>.html').url, 'https://a.test/list/3.html');
  } finally {
    g['page'] = before;
  }
});

test('prepareUrl: ,{options} 尾巴拆出 method/headers/body，并置空未绑定的 page', () => {
  const parsed = prepareUrl('https://a.test/api?x=1,{"method":"POST","body":"id=12&page={{page}}&pagesize=10"}');
  assert.equal(parsed.url, 'https://a.test/api?x=1');
  assert.equal(parsed.option?.['method'], 'POST');
  assert.equal(parsed.option?.['body'], 'id=12&page=&pagesize=10');

  const req = prepareRequest('https://a.test/api,{"method":"POST","body":"id=12"}');
  assert.equal(req.method, 'POST');
  assert.equal(req.body, 'id=12');
  assert.equal(req.url, 'https://a.test/api');
});

test('prepareUrl: headers 支持对象与 [[k,v]] 两种形态；对象 body 序列化为 JSON', () => {
  const obj = prepareRequest('https://a.test/api,{"headers":{"sign":"abc","reg":"0"}}');
  assert.deepEqual(obj.headers, { sign: 'abc', reg: '0' });
  assert.equal(obj.method, 'GET');

  const arr = prepareRequest('https://a.test/api,{"headers":[["sign","abc"]]}');
  assert.deepEqual(arr.headers, { sign: 'abc' });

  const jsonBody = prepareRequest('https://a.test/api,{"method":"POST","body":{"a":1}}');
  assert.equal(jsonBody.body, '{"a":1}');
});

test('prepareUrl: options JSON 不规范（无引号键）时按 JS 对象字面量宽松解析', () => {
  const req = prepareRequest("https://a.test/api,{method:'POST',body:'a=1'}");
  assert.equal(req.url, 'https://a.test/api');
  assert.equal(req.method, 'POST');
  assert.equal(req.body, 'a=1');
});

test('prepareUrl: 相对路径按当前页 baseUrl 绝对化（NetworkUtils.getAbsoluteURL）', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const before = g['baseUrl'];
  try {
    g['baseUrl'] = 'https://api-bc.wtzw.com/leader-board?x=1';
    assert.equal(prepareUrl('/api/v1/leader-board?a=1').url, 'https://api-bc.wtzw.com/api/v1/leader-board?a=1');
    // 已是绝对 URL → 不动
    assert.equal(prepareUrl('https://other.test/x').url, 'https://other.test/x');
  } finally {
    g['baseUrl'] = before;
  }
});

test('splitUrlOptions: 只在「逗号后紧跟 {」处切分（URL 里的普通逗号不切）', () => {
  assert.deepEqual(splitUrlOptions('https://a.test/x?a=1,b=2'), { url: 'https://a.test/x?a=1,b=2', option: null });
  const r = splitUrlOptions('https://a.test/x?a=1 , {"method":"POST"}');
  assert.equal(r.url, 'https://a.test/x?a=1');
  assert.equal(r.option?.['method'], 'POST');
});

test('java.ajax：选项尾巴解析结果真的到达 HTTP 层（断言请求 URL 已剥离尾巴）', () => {
  // 沙箱环境不允许 curl 连 loopback，且 syncHttp 是 execFileSync('curl') —— 这里用
  // 「返回对象的 url() 反映实际请求 URL」来证明解析生效（同步层不抛错 + URL 正确）。
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables, javaExtra: {} });
  const raw = 'https://a.test/api/ci.do,{"body":"id=60&pagesize=10","method":"POST"}';
  const r = ev(`var x = java.ajax(${JSON.stringify(raw)}); x.url() + "|" + typeof x.body()`, {}) as string;
  assert.equal(r, 'https://a.test/api/ci.do|string', '尾巴被剥离，只把主体 URL 交给请求层');

  // 相对路径 + 选项尾巴：按当前页 baseUrl 绝对化后再发（baseUrl 是求值期绑定）
  const raw2 = '/api/v1/leader-board?a=1,{"headers":{"sign":"s"}}';
  const r2 = ev(`java.ajax(${JSON.stringify(raw2)}).url()`, { baseUrl: 'https://api-bc.wtzw.com/leader-board?x=1' }) as string;
  assert.equal(r2, 'https://api-bc.wtzw.com/api/v1/leader-board?a=1');
});

test('java.ajaxAll：数组里每个元素各自解析选项尾巴（绿柠小说形态）', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables, javaExtra: {} });
  const urls = ['https://a.test/one,{"method":"POST","body":"id=1"}', 'https://a.test/two'];
  const r = ev(
    `var arr = java.ajaxAll(${JSON.stringify(urls)}); arr.length + "|" + arr[0].url() + "|" + arr[1].url()`,
    {},
  ) as string;
  assert.deepEqual(r.split('|'), ['2', 'https://a.test/one', 'https://a.test/two']);
});

test('optionToRequest: 选项映射（method 归一 + headers 数组/对象两形态 + body 对象 JSON 序列化）', () => {
  // 与 prepareRequest 同源（__yueduOptionRequest 一份实现）；本测试锁「具名出口」本身，
  // 防止后续有人绕开它重写映射（同一判据写两处必然漂移）。
  const r1 = optionToRequest({ method: 'post', body: { a: 1 }, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r1.method, 'POST');
  assert.equal(r1.body, '{"a":1}');
  assert.equal(r1.headers['Content-Type'], 'application/json');

  const r2 = optionToRequest({ headers: [['sign', 's'], ['token', 't']] }, { method: 'GET' });
  assert.equal(r2.method, 'GET');
  assert.deepEqual(r2.headers, { sign: 's', token: 't' });

  // null 选项 + 无 fallback ⇒ 纯 GET 默认（RSS 无尾巴源的行为锚点）
  const r3 = optionToRequest(null);
  assert.equal(r3.method, 'GET');
  assert.equal(r3.body, undefined);
  assert.deepEqual(r3.headers, {});
});

// ---------------------------------------------------------------------------
// applyUrlRuleJs（#382：URL 中缀 `@js:` 全文扫描 —— 上游 AnalyzeUrl.analyzeJs 唯一实现）
// ---------------------------------------------------------------------------

test('applyUrlRuleJs：@js: 在 URL 中间也触发，JS 结果整体替换（前缀丢弃）', async () => {
  // qyyuapi 聚合源真实形态：`Movieffm@js:`{{Get('url')}}/cats/...`` —— 分类名前缀 + 中缀标记
  const out = await applyUrlRuleJs("Movieffm@js:`https://qyyuapi.com/cats/x/`", async (code) => code.replace(/`/g, ''));
  assert.equal(out, 'https://qyyuapi.com/cats/x/');
});

test('applyUrlRuleJs：前缀里的 @result 以累积结果回填；<js> 多段连排结果跨段传递', async () => {
  // 段1：<js> → 'U'；中缀文本 'mid@result' → 'midU'；段2：<js> 收到 result='midU'
  const seen: string[] = [];
  const out = await applyUrlRuleJs('<js>return "U"</js>mid@result<js>return "V"+result.length</js>', (code, cur) => {
    seen.push(cur);
    return code.includes('U"') ? 'U' : 'V' + cur.length;
  });
  assert.equal(out, 'V4');
  assert.deepEqual(seen, ['<js>return "U"</js>mid@result<js>return "V"+result.length</js>', 'midU']);
});

test('applyUrlRuleJs：尾部残余按 @result 拼接；JS 返回 null 按空串继续', async () => {
  const out = await applyUrlRuleJs('<js>return null</js>?t=@result&x=1', () => null);
  assert.equal(out, '?t=&x=1');
});
