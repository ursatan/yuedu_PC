/**
 * `#154` 回归锁：服务端 CORS **只放行白名单，绝不回通配**。
 *
 * 背景（缺陷类BV，2026-09-28）：原实现是 `Access-Control-Allow-Origin: *`，
 * 而 `/api` **全程没有鉴权** ⇒ **本机任意网页**都能读走
 * `GET /api/user/snapshot`（书架/书签/高亮/偏好）与 `GET /api/sources/<id>/login-info`（源登录凭据）。
 *
 * 判据（这个文件钉死的就是这几条）：
 *   ① 任何路径下**返回值都不等于 `*`**（通配一旦回来，洞就全开）；
 *   ② 外站来源一律 `null`（= 调用方一个 CORS 头都不加）；
 *   ③ **白名单不含 `'null'`** —— `#155` 起桌面离线页改为真实文件 + 主进程轮询
 *      （页面零脚本零请求 ⇒ 不再产生 `Origin: null`），这个可被 `data:` iframe 伪造的
 *      特例必须**保持删除**；恢复 `data:` 离线页时才允许连着它一起恢复；
 *   ④ 匹配是**精确**的（不做前缀/通配/size 归一），`http://localhost:5173/` 带尾斜杠就不算。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORS_ALLOWED_ORIGINS, corsOriginFor, corsPreflightFor } from '../cors';

/** 外站样本（覆盖各种「看起来像自己人」的写法） */
const EVIL = [
  'https://evil.example',
  'http://evil.example',
  'https://127.0.0.1.evil.example', // 前缀伪装
  'https://evil.example/127.0.0.1:3000', // 路径伪装
  'https://localhost.evil.example', // 后缀伪装
  'http://localhost:3000', // 本机但**别的端口**（服务端自己就是 3000 ⇒ 同源，不带 Origin）
  'http://127.0.0.1:9999',
  'https://snapshot.example',
  'file://',
  'chrome-extension://abcdefg',
];

test('① 白名单本身不含通配（防空转：证明后面测的确实是白名单）', () => {
  assert.ok(CORS_ALLOWED_ORIGINS.length > 0, '白名单不能是空的（否则前端全挂）');
  assert.ok(!CORS_ALLOWED_ORIGINS.includes('*'), '白名单里绝不允许出现 *');
  for (const o of CORS_ALLOWED_ORIGINS) assert.notEqual(o, '*');
});

test("② 白名单**不得**含 'null' —— #155 起离线页已是真实文件 + 主进程轮询（回归锁）", () => {
  assert.ok(!CORS_ALLOWED_ORIGINS.includes('null'),
    "`Origin: null` 可由「父页面嵌 data: iframe」伪造 ⇒ 不许回白名单（#155 已删除，别加回来）");
  assert.equal(corsOriginFor('null'), null, "Origin: null 的请求不应放行");
});

test('③ 白名单内：**回显来源自身**，不是 `*`', () => {
  assert.equal(corsOriginFor('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(corsOriginFor('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
});

test('④ 外站一律 null（这是本锁的核心：加一个外站来源就等于没修）', () => {
  for (const o of EVIL) {
    assert.equal(corsOriginFor(o), null, `不应放行 ${o}`);
  }
});

test('⑤ 同源请求 / 非浏览器调用 → null（不带 Origin ⇒ 与 CORS 无关）', () => {
  assert.equal(corsOriginFor(undefined), null);
  assert.equal(corsOriginFor(null), null);
  assert.equal(corsOriginFor(''), null);
});

test('⑥ 返回值在任何输入下都不等于 `*`', () => {
  for (const o of [...EVIL, ...CORS_ALLOWED_ORIGINS, 'null', undefined, null, '']) {
    assert.notEqual(corsOriginFor(o as string | null | undefined), '*');
  }
});

test('⑦ 匹配是精确的：不做尾斜杠 / 大小写 / 前缀归一', () => {
  assert.equal(corsOriginFor('http://localhost:5173/'), null, '尾斜杠不该被当成同源');
  assert.equal(corsOriginFor('HTTP://LOCALHOST:5173'), null, 'origin 是大小写敏感的规范形态，不做归一');
  assert.equal(corsOriginFor('http://localhost:51730'), null, '端口前缀不该误命中');
  assert.equal(corsOriginFor('null '), null, '带空格不算 null');
});

/** `#375` 沙箱 iframe 对 `/api/proxy` 的预检：缺陷全链见 `cors.ts` 的 `corsPreflightFor` 头注。 */
test('⑧ #375 · `/api/proxy` + Origin:null + OPTIONS ⇒ 预检放行（ACAO 回显 null，不出现 *）', () => {
  const h = corsPreflightFor('null', 'OPTIONS', '/api/proxy?u=https%3A%2F%2Fx.com', 'x-requested-with');
  assert.ok(h, 'yckceo「生成」预检必须能过 —— 否则站点回调静默不执行（用户报障现象）');
  assert.equal(h['Access-Control-Allow-Origin'], 'null', '回显 null，与 #326 的 GET 特例同口径');
  assert.equal(h['Access-Control-Allow-Headers'], 'x-requested-with', '必须覆盖 jQuery 自动加的 X-Requested-With');
  assert.equal(h['Access-Control-Allow-Methods'], 'GET,POST,OPTIONS', '本路由 GET + `#418` 的 POST 半边');
  for (const v of Object.values(h)) assert.notEqual(v, '*', '通配绝不允许回来（#154 红线）');
});

test('⑨ #375 · 预检特例的范围钉死：只限 OPTIONS × Origin:null × /api/proxy 三者同时成立', () => {
  assert.equal(corsPreflightFor('null', 'GET', '/api/proxy?u=x', 'x-requested-with'), null, '非 OPTIONS 不是预检');
  assert.equal(corsPreflightFor('null', 'OPTIONS', '/api/user/snapshot', 'content-type'), null, '用户数据端点绝不放行');
  assert.equal(corsPreflightFor('null', 'OPTIONS', '/api/sources/http___x/login-info', 'content-type'), null, '登录凭据端点绝不放行');
  assert.equal(corsPreflightFor('https://evil.example', 'OPTIONS', '/api/proxy?u=x', 'x-requested-with'), null, '外站来源不放行');
  assert.equal(corsPreflightFor(undefined, 'OPTIONS', '/api/proxy?u=x', 'content-type'), null, '同源/非浏览器调用与 CORS 无关');
  // 带查询串的 url 也要命中（Fastify req.url 含 query）
  assert.ok(corsPreflightFor('null', 'OPTIONS', '/api/proxy?u=anything&sid=x', 'x-requested-with'), 'req.url 带查询串必须照常命中');
});

test('⑩ #375 · ACAH 回显有界：超长/缺失回落 content-type（防滥用，预检仍能过）', () => {
  assert.equal(corsPreflightFor('null', 'OPTIONS', '/api/proxy', undefined)?.['Access-Control-Allow-Headers'], 'content-type');
  assert.equal(corsPreflightFor('null', 'OPTIONS', '/api/proxy', 'content-type')?.['Access-Control-Allow-Headers'], 'content-type');
  assert.equal(
    corsPreflightFor('null', 'OPTIONS', '/api/proxy', 'x'.repeat(257))?.['Access-Control-Allow-Headers'],
    'content-type',
    '超过 256 字符的声明不回显',
  );
  assert.equal(
    corsPreflightFor('null', 'OPTIONS', '/api/proxy', 'x'.repeat(256))?.['Access-Control-Allow-Headers'],
    'x'.repeat(256),
    '恰好 256 字符仍回显',
  );
});
