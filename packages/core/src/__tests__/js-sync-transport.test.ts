/**
 * `java.ajax` 的可插拔同步传输 + 响应侧效果。
 *
 * 三件事：
 *  1. `syncFetch` 注入点生效 —— 宿主/测试可以完全接管同步 HTTP（过去 java.ajax 绕过一切注入点，
 *     只能靠真实网络验证；这一点在本轮之前让「测试 java.ajax」变得不可行）；
 *  2. **Set-Cookie 写回源 CookieStore** —— 脚本内登录（如禁漫天堂 `java.ajax(url+'/login',{...})`）
 *     的会话 Cookie 此前读出来就扔，「脚本登录成功但后续仍匿名」。对齐 Legado（okhttp + CookieJar）；
 *  3. `code()` 返回真实 HTTP 状态码（此前恒为 0）；
 *  4. worker 池路径的 `java.ajax` 走**注入的宿主 HTTP**（`HybridEvalOptions.http`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsEvaluator, createHybridJsEvaluator, type SyncHttpRequest, type SyncHttpResponse } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import type { CookieStore } from '../contract/engine';

/** 内存 CookieStore（对齐 CookieStore 契约） */
function memCookies(): CookieStore & { dump: () => Record<string, string> } {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? '',
    set: (k, v) => { m.set(k, v); },
    remove: (k) => { m.delete(k); },
    header: () => [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    dump: () => Object.fromEntries(m),
  };
}

/** 可编程的假同步传输：记录请求，按 URL 返回预设响应 */
function fakeTransport(routes: Record<string, Partial<SyncHttpResponse>>) {
  const calls: SyncHttpRequest[] = [];
  const fetch = (req: SyncHttpRequest): SyncHttpResponse => {
    calls.push(req);
    const hit = Object.entries(routes).find(([k]) => req.url.includes(k))?.[1] ?? {};
    return {
      status: hit.status ?? 200,
      headers: hit.headers ?? { 'content-type': 'application/json' },
      setCookie: hit.setCookie ?? [],
      body: hit.body ?? '{}',
    };
  };
  return { calls, fetch };
}

test('syncFetch 注入点：java.ajax 走注入的传输，不再碰 curl', () => {
  const t = fakeTransport({ '/x': { body: '{"ok":1}' } });
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: t.fetch });
  const r = ev('java.ajax("https://api.test/x")', {});
  assert.equal(String(r), '{"ok":1}');
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]?.url, 'https://api.test/x');
  assert.equal(t.calls[0]?.method, 'GET');
});

test('java.ajax 的 code() 返回真实状态码', () => {
  const t = fakeTransport({ '/e': { status: 403, body: 'forbidden' } });
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: t.fetch });
  const r = ev('java.ajax("https://api.test/e")', {}) as Record<string, unknown>;
  assert.equal((r.code as () => number)(), 403);
  assert.equal((r.statusCode as () => number)(), 403);
  assert.equal((r.body as () => string)(), 'forbidden');
});

test('java.ajax 响应的 Set-Cookie 写回源 CookieStore（脚本内登录的会话能留住）', () => {
  const cookies = memCookies();
  const t = fakeTransport({
    '/login': {
      body: '{"code":0}',
      setCookie: ['SESSION=abc123; Path=/; HttpOnly', 'uid=42; Path=/'],
    },
  });
  const ev = createJsEvaluator({ variables: createVariableStore(), cookies, syncFetch: t.fetch });
  ev('java.ajax("https://api.test/login")', {});
  assert.deepEqual(cookies.dump(), { SESSION: 'abc123', uid: '42' });
});

test('Set-Cookie 的 Max-Age=0 视为删除（对齐 engine.harvestCookies）', () => {
  const cookies = memCookies();
  cookies.set('SESSION', 'old');
  const t = fakeTransport({ '/logout': { setCookie: ['SESSION=; Max-Age=0; Path=/'] } });
  const ev = createJsEvaluator({ variables: createVariableStore(), cookies, syncFetch: t.fetch });
  ev('java.ajax("https://api.test/logout")', {});
  assert.equal(cookies.get('SESSION'), '');
});

test('java.getCookie 能读到刚被 java.ajax 写回的 Cookie', () => {
  const cookies = memCookies();
  const t = fakeTransport({ '/login': { setCookie: ['TOKEN=xyz; Path=/'] } });
  const ev = createJsEvaluator({ variables: createVariableStore(), cookies, syncFetch: t.fetch });
  ev('java.ajax("https://api.test/login")', {});
  assert.equal(ev('java.getCookie("t", "TOKEN")', {}), 'xyz');
});

test('worker 池里的 java.ajax 走 HybridEvalOptions.http（注入的宿主 HTTP）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const hits: string[] = [];
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async (r) => {
      hits.push(r.url);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"from":"host-http"}' };
    },
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  // bindings 为空 → 可克隆 → 走 worker；worker 内 java.ajax 经 RPC 回宿主
  const out = await Promise.resolve(ev('java.ajax("https://api.test/worker")', {}));
  assert.deepEqual(hits, ['https://api.test/worker'], '宿主 HTTP 应被调用一次');
  assert.ok(String(out).includes('host-http'), `脚本应拿到宿主 HTTP 的响应，实际：${String(out)}`);
  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});

// ---- `#152`：同步响应的「被截断」标记必须登记进截断环（随引擎结果回传前端） ----
import { __resetTruncatedLogForTest, takeTruncatedSince, truncatedMark } from '../net/truncated-log';

test('#152 同步传输的 truncated 标记 ⇒ 登记进截断环（正文缺后半段不再伪装成「站点返回空」）', () => {
  __resetTruncatedLogForTest();
  const m = truncatedMark();
  // 传输实现（worker SAB 路径会透传这个字段）报告：响应被截断
  const t = fakeTransport({ '/big': { body: '{"partial":' } });
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: (req) => ({ ...t.fetch(req), truncated: true }) });
  const r = ev('java.ajax("https://api.test/big")', {});
  assert.equal(String(r), '{"partial":', '截断的半截 body 仍要交给规则（护栏语义：拿到多少用多少）');
  const { list } = takeTruncatedSince(m);
  assert.equal(list.length, 1, `截断必须登记进环，实得 ${list.length}`);
  assert.equal(list[0]?.url, 'https://api.test/big');
});

test('#152 未截断的同步响应不得污染截断环', () => {
  __resetTruncatedLogForTest();
  const m = truncatedMark();
  const t = fakeTransport({ '/ok': { body: '{"ok":1}' } });
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch: t.fetch });
  ev('java.ajax("https://api.test/ok")', {});
  assert.equal(takeTruncatedSince(m).list.length, 0, '正常响应不许被登记成截断');
});
