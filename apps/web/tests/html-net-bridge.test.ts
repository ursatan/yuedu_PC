/**
 * `#375` **NET 跨域桥**的回归锁 —— 与 `html-nav.test.ts` 同款：直接**执行**壳层
 * 生成的那段脚本，断言行为，不是看字符串。
 *
 * ## 缺陷背景（用户报障：yckceo 书源列表「生成」点击无反应）
 * 旧版 `prox()` 只重写**绝对** http(s) URL，相对 URL 原样放行 —— 在真同源页面里
 * 这是对的，但沙箱 srcdoc 的 `document.baseURI` 是 `<base href>` 指向的**远端站**：
 * 相对 XHR（yckceo `$.get('/index/durl/add.html?data=…')`）被浏览器解析到远端并
 * 直连 ⇒ opaque origin 无凭据、响应被 CORS 拦死 ⇒ 站点回调静默不执行（网络层
 * 200、JS 层 ERR_FAILED、无任何弹层）。修法 = 相对 URL 先按 baseURI 解析成绝对
 * 再代理；`data:`/`blob:`/`javascript:`/`mailto:`/`tel:`/`#`/`about:` 与已代理地址不动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNetBridge } from '../src/utils/html-shell';

const ORG = 'http://127.0.0.1:3415';

/** 最小假环境里跑桥脚本：返回「XHR open 实际收到的 URL」与「fetch 实际收到的 URL」 */
function runBridge(baseURI: string) {
  const xhrOpened: string[] = [];
  const fetched: string[] = [];
  class FakeXHR {
    open(_m: string, u: string) {
      xhrOpened.push(u);
    }
  }
  const document = { baseURI };
  const window = {
    fetch: (u: string) => {
      fetched.push(u);
      return 'RESPONSE';
    },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'XMLHttpRequest', 'URL', buildNetBridge(ORG, 'sid1'));
  fn(window, document, FakeXHR, URL);
  return {
    xhr: (m: string, u: string) => {
      // eslint-disable-next-line no-new-func
      new FakeXHR().open(m, u);
      return xhrOpened[xhrOpened.length - 1];
    },
    fetch: (u: string, init?: unknown) => {
      // eslint-disable-next-line no-new-func
      (window as unknown as (i: string, init?: unknown) => string).fetch(u, init);
      return fetched[fetched.length - 1];
    },
  };
}

test('NET 桥 · 相对 URL 按 baseURI 解析成绝对并改写到代理（#375 根因）', () => {
  const b = runBridge('https://www.yckceo.com/yuedu/shuyuan/index.html');
  const out = b.xhr('GET', '/index/durl/add.html?data=abc');
  assert.equal(
    out,
    ORG + '/api/proxy?u=' + encodeURIComponent('https://www.yckceo.com/index/durl/add.html?data=abc') + '&sid=sid1',
    '相对 XHR 若放行会被解析到远端站并直连 ⇒ CORS 拦死 ⇒ 站点回调静默不执行（yckceo「生成」无弹层的根因）',
  );
});

test('NET 桥 · fetch 的相对 URL 同样接住', () => {
  const b = runBridge('https://a.com/dir/page');
  assert.equal(b.fetch('api/x?n=1'), ORG + '/api/proxy?u=' + encodeURIComponent('https://a.com/dir/api/x?n=1') + '&sid=sid1');
});

test('NET 桥 · 绝对 http(s) 照旧改写；带 Referer 时补 `r`', () => {
  const b = runBridge('https://a.com/p/');
  assert.equal(b.xhr('GET', 'https://b.com/x'), ORG + '/api/proxy?u=' + encodeURIComponent('https://b.com/x') + '&sid=sid1');
  assert.equal(b.fetch('https://b.com/y', { headers: { referer: 'https://a.com/from' } }), ORG + '/api/proxy?u=' + encodeURIComponent('https://b.com/y') + '&sid=sid1&r=' + encodeURIComponent('https://a.com/from'));
});

test('NET 桥 · data:/blob:/javascript: 等非资源请求原样放行', () => {
  const b = runBridge('https://a.com/p/');
  assert.equal(b.xhr('GET', 'data:text/plain,hi'), 'data:text/plain,hi');
  assert.equal(b.xhr('GET', 'blob:about:srcdoc/uuid'), 'blob:about:srcdoc/uuid');
  assert.equal(b.xhr('GET', 'javascript:void(0)'), 'javascript:void(0)');
});

test('NET 桥 · 已是代理地址不二次改写（防重入）', () => {
  const b = runBridge('https://a.com/p/');
  const proxied = ORG + '/api/proxy?u=' + encodeURIComponent('https://b.com/x');
  assert.equal(b.xhr('GET', proxied), proxied);
});

test('NET 桥 · 没有 `<base>`（baseURI 非 http）时相对 URL 保持原样（不劣化旧行为）', () => {
  const b = runBridge('about:srcdoc');
  assert.equal(b.xhr('GET', '/rel/x'), '/rel/x', '解析不了就放行 —— 与旧行为一致，不能把无 base 的场景弄坏');
});

test('NET 桥 · 拼接纪律：脚本文本无反引号、无字面 script 闭合标签', () => {
  const s = buildNetBridge(ORG, 'sid1');
  assert.doesNotMatch(s, /`/, '反引号会截断拼接它的模板串（本仓踩过多次）');
  assert.ok(!s.includes('</script>'), '字面闭合标签会切断 srcdoc 里的 script');
});
