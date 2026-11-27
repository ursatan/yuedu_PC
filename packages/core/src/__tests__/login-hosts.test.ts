/**
 * 交互式登录窗口的域名筛选逻辑（纯函数）—— 对应 apps/server/src/browser-login.ts 的 harvest。
 *
 * 背景：`loginUrl` 里 52 个源是登录页链接（还有 42 个脚本内部 startBrowserAwait），
 * 人工/验证码登录只能在真浏览器里做；做完后要从**整个浏览器**的 cookie 里筛出属于该源的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harvestHosts, hostMatches, pickLoginCookies } from '../net/login-hosts';

test('harvestHosts: 取 host + 主域（登录域与内容域不同的场景）', () => {
  const hosts = harvestHosts(['https://ac.qq.com/login.shtml?redir=x', 'https://ac.qq.com']);
  assert.deepEqual(hosts, ['ac.qq.com', 'qq.com'], 'ac.qq.com → 同时给出主域 qq.com');
});

test('harvestHosts: 去 www、支持无协议域名、忽略非法值', () => {
  assert.deepEqual(harvestHosts(['www.example.com']), ['example.com']);
  assert.deepEqual(harvestHosts(['m.example.com/login']), ['m.example.com', 'example.com']);
  assert.deepEqual(harvestHosts(['', '   ', 'notaurl']), []);
});

test('hostMatches: 双向后缀匹配（cookie 域比 host 深或浅都能命中）', () => {
  assert.equal(hostMatches('qq.com', ['ac.qq.com', 'qq.com']), true);
  assert.equal(hostMatches('passport.qq.com', ['qq.com']), true, 'cookie 域更深');
  assert.equal(hostMatches('www.baidu.com', ['baidu.com']), true);
  assert.equal(hostMatches('baidu.com', ['www.baidu.com']), true, 'cookie 域更浅');
  assert.equal(hostMatches('evil-qq.com', ['qq.com']), false, '不能命中相似域名');
  assert.equal(hostMatches('other.com', []), true, '未给候选 = 全收（调用方显式要全部）');
});

test('pickLoginCookies: 只留命中域名的，同名后者覆盖（对齐 CookieStore 语义）', () => {
  const all = [
    { name: 'sid', value: 'A', domain: '.qq.com', path: '/' },
    { name: 'sid', value: 'B', domain: 'ac.qq.com', path: '/' },
    { name: 'TRACK', value: 'X', domain: 'doubleclick.net', path: '/' },
    { name: '', value: 'ignored', domain: 'qq.com', path: '/' },
  ];
  const { picked, dropped } = pickLoginCookies(all, ['ac.qq.com', 'qq.com']);
  assert.deepEqual(picked, [{ name: 'sid', value: 'B', domain: 'ac.qq.com', path: '/' }], '同名取最后一条');
  assert.equal(dropped, 1, '无关域名的被丢掉');
});

test('pickLoginCookies: 源站根域名场景（loginUrl 只填了域名）', () => {
  const all = [
    { name: 'session', value: '1', domain: 'ao3mirror.com', path: '/' },
    { name: 'cf_clearance', value: '2', domain: '.ao3mirror.com', path: '/' },
    { name: 'x', value: '3', domain: 'twitter.com', path: '/' },
  ];
  const { picked } = pickLoginCookies(all, harvestHosts(['https://ao3mirror.com']));
  assert.deepEqual(picked.map((c) => c.name).sort(), ['cf_clearance', 'session']);
});
