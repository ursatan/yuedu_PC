/**
 * `#561`/`#562` 回归锁：自取数规则判定 + 挑战页判定 + 占位内容（叶子判据 `diag/self-fetch.ts`）。
 *
 * 为什么锁：这两个判据是「要不要给用户放行试跑 / 报错怎么措辞」的唯一依据，
 * 被**四处**消费（字段试跑端点 / 发现试跑端点 / 物料链 / Web 前端）——
 * 判据漂移的表现是「发现试跑说自取数、字段试跑要物料」这类自相矛盾。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSelfFetchingRule, isChallengePage, SELF_FETCH_PLACEHOLDER } from '../diag/self-fetch';

test('S-① isSelfFetchingRule：`<js>`/`@js:` + 网络调用才认', () => {
  assert.equal(isSelfFetchingRule('<js>var r = java.ajax(u)</js>'), true);
  assert.equal(isSelfFetchingRule('@js:java.get(u)'), true);
  assert.equal(isSelfFetchingRule('@js:java.post(u, d)'), true);
  assert.equal(isSelfFetchingRule('<js>fetch(u)</js>'), true);
  // 非 JS 形态：CSS / JSON 选择器永远不是自取数（哪怕恰好含这些词）
  assert.equal(isSelfFetchingRule('.book-list@class'), false);
  assert.equal(isSelfFetchingRule('$.data.books'), false);
  // JS 形态但没有网络调用（纯本地拼串）也不算 —— 它依赖页面内容
  assert.equal(isSelfFetchingRule('<js>JSON.stringify({a:1})</js>'), false);
  assert.equal(isSelfFetchingRule(''), false);
});

test('S-② 七猫/黄金屋真实判例（内容级断言，不依赖源版本）', () => {
  // 七猫 bookList：`<js>` + java.ajax（页面 404 是正常形态）
  assert.equal(isSelfFetchingRule('<js>\nvar base = baseUrl;\nvar hu = "https://api-bc.wtzw.com/api/v1/h5/hall-of-fame/list?gender=" + hg;\nresult = java.ajax(hu);\n</js>\n$.data.books'), true);
  // 黄金屋 bookList：`<js>` + cookie.setCookie + java.ajax（挑战页自愈）
  assert.equal(isSelfFetchingRule('<js>\nif(chal){cookie.setCookie(baseUrl,"__sc_clearance=1");var h2=java.ajax(baseUrl);}\n</js>'), true);
});

test('S-③ isChallengePage：按内容特征判定，不看状态码', () => {
  assert.deepEqual(isChallengePage('<html>正在检查您的浏览器，请稍候…__sc_clearance</html>'), { challenge: true, via: '__sc_clearance（网站安全校验）' });
  assert.equal(isChallengePage('<html>Just a moment...</html>').challenge, true);
  assert.equal(isChallengePage('<html>verify you are human</html>').challenge, true);
  // 普通页面：哪怕提到「验证」字样的正文也不误报（判据是盾方**特征**，不是「验证」这个词）
  assert.equal(isChallengePage('<html><title>总点击榜榜单-热门小说推荐-黄金屋</title><div class="book-card">开局一座神秘岛</div></html>').challenge, false);
  assert.equal(isChallengePage('').challenge, false);
});

test('S-③c `#642` CF「硬拦截页」也要认（Attention Required / cf-error-details / Error 1020）', () => {
  // 真实形态（顶点小说 `m.terry-haass.com` 一类）：既无 Just a moment、也无 challenge-platform
  const block =
    '<html><head><title>Access denied | www.example.com used Cloudflare</title></head>' +
    '<body><h1>Attention Required! | Cloudflare</h1>' +
    '<div id="cf-error-details"><span>Error 1020</span> Ray ID: 8a1b2c3d4e5f</div></body></html>';
  assert.equal(isChallengePage(block).challenge, true, '不认这一类 ⇒ 引擎把它当正文 ⇒ 静默 0 条（#11 真因）');
  assert.match(String(isChallengePage(block).via), /Attention Required|1020/);
  // 只要三者之一即可（各站回的是不同形态）
  assert.equal(isChallengePage('<title>Attention Required! | Cloudflare</title>').challenge, true);
  assert.equal(isChallengePage('<div id="cf-error-details">x</div>').challenge, true);
  assert.equal(isChallengePage('Error 1015 The owner of this website is rate limited').challenge, true);
  assert.equal(isChallengePage('Please enable JavaScript and cookies to continue').challenge, true);
  /**
   * ★ 反向锁：**不能**用泛化的 `cloudflare` 字样判定。
   * CF 前置站点的**正常正文页**里到处都有 `cloudflare`（脚本域名、`cdn-cgi`），
   * 认它 ⇒ 每个正常页面都被判成挑战页（`#564` 同类教训）。
   */
  const normal = '<html><head><script src="https://cdn.cloudflare.com/x.js"></script></head><body>正常正文</body></html>';
  assert.equal(isChallengePage(normal).challenge, false, 'cloudflare 域名出现在正文里不算拦截');
});

test('S-③b `#564` 复查只认最初那条特征（过盾后的正文残留盾方脚本也要算成功）', () => {
  const chal = isChallengePage('<html>Just a moment...</html>');
  assert.equal(chal.challenge, true);
  // 过盾后的真实正文：没有 Just a moment，但残留 CF 的 challenge-platform 脚本引用
  const passed =
    '<html><head><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>' +
    '</head><body><div class="book-card">开局一座神秘岛</div></body></html>';
  // 全量复查：会被残留脚本命中（误判成仍未过盾）
  assert.equal(isChallengePage(passed).challenge, true, '全量复查会被残留脚本命中 —— 所以复查必须收窄');
  // 只复查最初那条（Cloudflare）⇒ 不在 ⇒ 判定过盾成功
  assert.equal(isChallengePage(passed, chal.via).challenge, false, '只复查最初那条特征时应判为已过盾');
});

test('S-④ 占位内容：三处消费方必须同一份（含「自取数」字样，日志可辨）', () => {
  assert.match(SELF_FETCH_PLACEHOLDER, /self-fetch/);
  assert.match(SELF_FETCH_PLACEHOLDER, /自取数|自行请求/);
  // 占位不是合法选择器目标，但探针的「非空内容」闸门放它过（自取数 JS 不读它）
  assert.ok(SELF_FETCH_PLACEHOLDER.trim().length > 0);
});
