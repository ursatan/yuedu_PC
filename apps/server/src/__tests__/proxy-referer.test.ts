/**
 * 缺陷类BL 回归锁：`/api/proxy` 的 Referer 候选表（`refererChain`）。
 *
 * 背景：上游防盗链的判据**没有统一约定**，语料里两种相反规则都真实存在 ——
 *   · CDN 图床认「源站点」Referer（用资源自身 origin 一定被拒）；
 *   · 🔊书音M 的音频直链认「资源自身」origin（用源站点 origin 被 403）。
 * 所以只能先试源站点、被拒再试资源自身；而**显式指定 / 源 header 规则**必须单次权威
 * （`#369` 例外：陌生 origin 的显式 `?r=` 降到 srcSite 之后 —— 见 refererChain 头注）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERER_RETRY_STATUS, originOf, refererChain } from '../proxy-referer';

test('origin(): 取 origin + 尾斜杠；不可解析给空串', () => {
  assert.equal(originOf('https://a.b/c/d?e=1'), 'https://a.b/');
  assert.equal(originOf('http://a.b:8080/x'), 'http://a.b:8080/');
  assert.equal(originOf('not a url'), '');
  assert.equal(originOf(undefined), '');
});

test('① 两段阶梯：源站点 origin 在前、资源自身 origin 在后', () => {
  assert.deepEqual(
    refererChain({ srcSite: 'https://m.shuyinfm.com/', assetOrigin: 'https://api.aikeu.com/' }),
    ['https://m.shuyinfm.com/', 'https://api.aikeu.com/'],
  );
});

test('① 两者相同 → 去重，只试一次（不白跑第二趟）', () => {
  assert.deepEqual(refererChain({ srcSite: 'https://a.b/', assetOrigin: 'https://a.b/' }), ['https://a.b/']);
});

test('① 缺失的 origin 不占位（避免发出空 Referer 的第二次请求）', () => {
  assert.deepEqual(refererChain({ srcSite: '', assetOrigin: 'https://a.b/' }), ['https://a.b/']);
  assert.deepEqual(refererChain({ srcSite: 'https://a.b/' }), ['https://a.b/']);
});

test('① 两个都没有 → 返回 [""]（= 不设 Referer，仍发一次请求）', () => {
  assert.deepEqual(refererChain({}), ['']);
});

test('② 显式 ?r= 与源站点同 origin（=真嵌页地址）→ 权威单次，不降级', () => {
  assert.deepEqual(
    refererChain({ explicit: 'https://s.test/page/1', srcSite: 'https://s.test/', assetOrigin: 'https://a.test/' }),
    ['https://s.test/page/1'],
  );
});

test('② `#369` 陌生 origin 的 explicit 降级：srcSite 先行（AGE：r=API 地址，解析站只认源站点）', () => {
  assert.deepEqual(
    refererChain({
      explicit: 'https://api.agedm.io/v2/detail/20260286',
      srcSite: 'https://m.agedm.io/',
      assetOrigin: 'https://jx.ejtsyc.com:8443/',
    }),
    ['https://m.agedm.io/', 'https://api.agedm.io/v2/detail/20260286', 'https://jx.ejtsyc.com:8443/'],
  );
});

test('② `#369` explicit = 资源自身 origin → 不算陌生，仍权威单次', () => {
  assert.deepEqual(
    refererChain({ explicit: 'https://a.test/embed', srcSite: 'https://s.test/', assetOrigin: 'https://a.test/' }),
    ['https://a.test/embed'],
  );
});

test('② `#369` 没有 srcSite 时无从降级 → explicit 保持权威单次', () => {
  assert.deepEqual(
    refererChain({ explicit: 'https://x.test/', assetOrigin: 'https://a.test/' }),
    ['https://x.test/'],
  );
});

test('② `#369` 降级时 headerRef 仍最权威置顶', () => {
  assert.deepEqual(
    refererChain({
      explicit: 'https://api.agedm.io/v2/detail/1',
      headerRef: 'https://from-rule.test/',
      srcSite: 'https://m.agedm.io/',
      assetOrigin: 'https://jx.ejtsyc.com:8443/',
    }),
    ['https://from-rule.test/', 'https://m.agedm.io/', 'https://api.agedm.io/v2/detail/1', 'https://jx.ejtsyc.com:8443/'],
  );
});

test('② 源 header 规则声明的 Referer 权威：单次', () => {
  assert.deepEqual(
    refererChain({ headerRef: 'https://from-rule.test/', srcSite: 'https://s.test/', assetOrigin: 'https://a.test/' }),
    ['https://from-rule.test/'],
  );
});

test('② 显式 ?r= 非 http(s) 时视为未指定（退回阶梯）', () => {
  assert.deepEqual(refererChain({ explicit: 'javascript:alert(1)', srcSite: 'https://s.test/' }), ['https://s.test/']);
});

test('③ 只在这三个状态码上换 Referer 重试（5xx/超时不属于防盗链）', () => {
  assert.equal(REFERER_RETRY_STATUS.has(401), true);
  assert.equal(REFERER_RETRY_STATUS.has(403), true);
  assert.equal(REFERER_RETRY_STATUS.has(404), true);
  for (const code of [200, 301, 400, 500, 502, 503]) {
    assert.equal(REFERER_RETRY_STATUS.has(code), false, `${code} 不应触发 Referer 重试`);
  }
});
