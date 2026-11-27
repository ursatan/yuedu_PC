/**
 * `#731` **导航 URL 清洗锁**：用户 3000 日志里的真实现象
 * ```
 * [verify] Page.navigate 返回错误：Cannot navigate to invalid URL
 *           · https___www.asianfanfics.com|`https://www.asianfanfics.com/browse?page=1`
 * ```
 * 根因：`hub.renderChallenge` 把缓存键（`${sourceId}|${url}`）当 URL 传给 `antibotReplay`。
 * 这里锁三件事：解析规则、非法串必须抛、以及「所有入口都用同一个解析函数」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeNavUrl } from '../nav-url';

const VERIFY = readFileSync(join(process.cwd(), 'src/verification.ts'), 'utf8');
const INDEX = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
const HUB = readFileSync(join(process.cwd(), '../../packages/facade/src/hub.ts'), 'utf8');

test('#731 ⑧ 用户真实复合串：sourceKey|`url` ⇒ 解析出纯 URL', () => {
  const raw = 'https___www.asianfanfics.com|`https://www.asianfanfics.com/browse?page=1`';
  assert.equal(normalizeNavUrl(raw), 'https://www.asianfanfics.com/browse?page=1');
});

test('#731 ⑨ 反引号/引号/尖括号/前后空白都要剥掉', () => {
  assert.equal(normalizeNavUrl('  src:abc|  `https://a.com/x`  '), 'https://a.com/x');
  assert.equal(normalizeNavUrl('src|"https://a.com/y"'), 'https://a.com/y');
  assert.equal(normalizeNavUrl('<https://a.com/z>'), 'https://a.com/z');
});

test('#731 ⑩ `|` 出现多次：按第一个切分，URL 里的 `|` 原样保留', () => {
  assert.equal(normalizeNavUrl('src|https://a.com/?p=1|2'), 'https://a.com/?p=1|2');
  // 纯 URL 自带 `|` 时**不能**被切：否则正常地址会被拦腰截断
  assert.equal(normalizeNavUrl('https://a.com/?q=a|b'), 'https://a.com/?q=a|b');
});

test('#731 ⑪ 非法 URL 必须抛「导航 URL 非法」，不下发给 CDP', () => {
  for (const bad of ['about:blank', 'src|not-a-url', '', 'ftp://a.com/x', 'chrome://newtab/']) {
    assert.throws(() => normalizeNavUrl(bad), /导航 URL 非法/, `应拒绝：${bad}`);
  }
});

test('#731 ⑫ 所有入口共用同一解析函数（不许各写一遍）', () => {
  // 源头：hub 传的是纯 url，不是缓存键 key
  assert.match(HUB, /antibot\(url, sourceId, \{ background \}\)/);
  assert.doesNotMatch(HUB, /const hit = await antibot\(key, sourceId/, '禁止再把复合键当 URL 传给过盾回调');
  // 服务端：openVerification / navigateVerification / antibotPassPage 都过 normalizeNavUrl
  assert.match(VERIFY, /const url = normalizeNavUrl\(opts\.url\)/);
  assert.match(VERIFY, /u = normalizeNavUrl\(url\)/);
  assert.match(INDEX, /url = normalizeNavUrl\(url\)/);
});
