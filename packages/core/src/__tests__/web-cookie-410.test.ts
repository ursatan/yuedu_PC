/**
 * `#410` 回归锁：`cookie.setWebCookie(url, cookie)`（上游 `CookieStore.kt:41-53`）。
 *
 * ## 缺陷
 * 本仓**没有实现**这个方法 ⇒ 落到 java/cookie Proxy 的「未实现 → 返回空」兜底 = **静默**
 * （违反铁律 4；18AV 的 `rrcheck()` 用它给「过 18+ 声明闸」的会话 cookie 落地）。
 *
 * ## 上游语义与我们的落点
 * 上游写 Android WebView 的 `CookieManager`（**不落库**）；本仓无 WebView ⇒ 取等价且
 * **真正生效**的落点 = **源级 CookieStore**（有意超集，见 `selector/web-cookie.ts` 头注）。
 * 判据（`scheme://host` 必须可解析 + `;` 拆分去空白项）与上游逐条对齐。
 *
 * ⚠️ 必须测 **L1 与 worker 两路**：worker 侧此前连方法都没有（落到「未实现」），
 * 只测 L1 会漏掉真断点（`#409` 的教训）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CookieStore } from '../contract/engine';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { baseUrlOf, webCookiePairs } from '../selector/web-cookie';

/** 最小内存版源级 CookieStore（生产实现见 server 侧；本锁只关心「有没有真的写进来」） */
function createMemoryCookieStore(): CookieStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? '',
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    clear: () => m.clear(),
    header: () => [...m].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

test('#410 判据：baseUrlOf 只认 http(s)://host（对齐上游 NetworkUtils.getBaseUrl）', () => {
  assert.equal(baseUrlOf('https://mjv006.com/zh/x/1.html'), 'https://mjv006.com');
  assert.equal(baseUrlOf('http://a.b:8080/p?q=1'), 'http://a.b:8080');
  assert.equal(baseUrlOf('https://host/x@js:\'data:;base64,AA\''), 'https://host', '`@js:` 之前那段才是传输主机');
  assert.equal(baseUrlOf('ftp://x/y'), '', '非 http(s) ⇒ 空（上游 ?: return）');
  assert.equal(baseUrlOf('not a url'), '');
  assert.equal(baseUrlOf(''), '');
});

test('#410 判据：cookie 串按 ; 拆、丢弃空白项（对齐 splitNotBlank）', () => {
  const r = webCookiePairs('https://a.test/', '  k1=v1 ; k2=v2 ;; ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.pairs, [['k1', 'v1'], ['k2', 'v2']]);
  assert.equal(webCookiePairs('https://a.test/', '   ').ok, false, '空 cookie ⇒ 不写');
  assert.equal(webCookiePairs('bad-url', 'k=v').reason, 'BAD_URL');
});

test('#410 L1：cookie.setWebCookie 真的写进源级 CookieStore（旧实现静默丢弃）', () => {
  const cookies = createMemoryCookieStore();
  const ev = createJsEvaluator({ variables: createVariableStore(), cookies });
  ev('cookie.setWebCookie("https://mjv006.com/zh/x/1.html", "d652abc=90aa11; path=/")', {});
  assert.equal(cookies.get('d652abc'), '90aa11', 'cookie 必须真的落进源级 CookieStore');
  // 对偶：URL 解析不出主机 ⇒ **不写**（上游同）
  ev('cookie.setWebCookie("bad-url", "zz=1")', {});
  assert.equal(cookies.get('zz'), '', 'url 非法时不得写入');
});

test('#410 worker：同一句在 worker 路径也必须落到宿主 CookieStore（两路不许分岔）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const cookies = createMemoryCookieStore();
  const st = { evals: 0 };
  const counting = new Proxy(pool as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          st.evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), cookies, pool: counting as never });
  try {
    await Promise.resolve(ev('cookie.setWebCookie("https://mjv006.com/zh/x/1.html", "wk=1; wk2=2")', {}));
    assert.ok(st.evals > 0, '必须真的走 worker（若为 0 说明回落 L1，本条空转）');
    assert.equal(cookies.get('wk'), '1', 'worker 侧 setWebCookie 必须回宿主落库');
    assert.equal(cookies.get('wk2'), '2');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});