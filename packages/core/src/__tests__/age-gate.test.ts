/**
 * 回归锁 `D11`（B 半）：闸页（年满18岁声明）**静默过闸** + 其前置条件（空 Cookie 不遮蔽会话 Cookie）。
 *
 * ## 实测取证（2026-10-12，18AV `mjv006.com`）
 * ```
 * GET /zh/chinese_list/all/  → 200，1814 字节「年满18岁声明」页
 *   <input id='fwin_dialog_submit' class='scale_button'
 *          onclick='window.location="https://mjv006.com/zh/chinese_IamOverEighteenYearsOld/19/index.html"'>
 * GET 目标 URL             → Set-Cookie: YES_Eighteen=IamOverEighteenYearsOld
 * 带该 Cookie 重放原 URL    → 200，44761 字节真列表（不再是闸页）
 * ```
 * 修前：闸页被当成正文 ⇒ 列表规则 0 条（用户症状「分类下没有内容卡片 / SELECTOR_MISS」）。
 *
 * ## 本锁覆盖
 * 1. `planAgeGatePass` 的真形态识别（**属性引号嵌套**是踩过的坑）+ 负例（正常页/自跳/超大页）；
 * 2. `applySessionCookie`：源 header 规则里的**空 Cookie** 不得遮蔽 CookieStore 的真会话；
 * 3. **L1 闭环**（`java.ajax`）：闸页 → 过闸 → 重放，拿到真内容；
 * 4. **worker 闭环**：同一条链经 RPC 走宿主（计数池断言真进 worker）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { planAgeGatePass, isAgeGatePage, applySessionCookie, sessionCookieOverride } from '../net/gate-pass';
import type { SyncHttpRequest, SyncHttpResponse } from '../selector/js';

/** 真形态：`onclick` 用单引号包、值里是双引号 —— 用 `[^"']*` 会在 `window.location=` 处截断（踩过） */
const GATE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>年满18岁声明</title></head><body>
<div class="fwin_dialog">
  <img src="https://mjv006.com/images/Eighteen_declaration_2023.png">
  <input id='fwin_dialog_submit' class='scale_button' onclick='window.location="https://mjv006.com/zh/chinese_IamOverEighteenYearsOld/19/index.html"'>
  <a href="https://baidu.com/">离开</a>
</div></body></html>`;
const GATE_TARGET = 'https://mjv006.com/zh/chinese_IamOverEighteenYearsOld/19/index.html';
const LIST_URL = 'https://mjv006.com/zh/chinese_list/all/';
const REAL_BODY = `<html><body><div class="posts"><div class="post"><a href="/v/1">真实列表</a></div></div></body></html>`;

test('planAgeGatePass：识别真形态并取到过闸目标（属性引号嵌套不能截断）', () => {
  assert.deepEqual(planAgeGatePass(GATE_HTML, LIST_URL), { target: GATE_TARGET });
  assert.equal(isAgeGatePage(GATE_HTML), true);
  // 负例：正常页面 / 大页面 / 目标 == 当前页（防自跳）
  assert.equal(planAgeGatePass(REAL_BODY, LIST_URL), null);
  assert.equal(planAgeGatePass(GATE_HTML + 'x'.repeat(70 * 1024), LIST_URL), null, '正常大页面不做全串扫描');
  assert.equal(planAgeGatePass(GATE_HTML, GATE_TARGET), null, '目标就是当前页 ⇒ 不可过闸');
  assert.equal(isAgeGatePage(''), false);
});

test('applySessionCookie：空 Cookie 头不遮蔽会话 Cookie，非空则尊重源作者', () => {
  assert.deepEqual(sessionCookieOverride({ Cookie: '' }, 'YES_Eighteen=1'), { key: 'Cookie', value: 'YES_Eighteen=1' });
  assert.deepEqual(sessionCookieOverride({}, 'YES_Eighteen=1'), { key: 'Cookie', value: 'YES_Eighteen=1' });
  assert.deepEqual(sessionCookieOverride({ cookie: '  ' }, 'YES_Eighteen=1'), { key: 'cookie', value: 'YES_Eighteen=1' });
  assert.equal(sessionCookieOverride({ Cookie: 'a=1' }, 'YES_Eighteen=1'), null, '源给了非空 Cookie ⇒ 不动');
  assert.equal(sessionCookieOverride({ Cookie: '' }, ''), null, '会话里没有 Cookie ⇒ 不动');
  const h: Record<string, string> = { Cookie: '' };
  assert.equal(applySessionCookie(h, 'k=v'), true);
  assert.equal(h['Cookie'], 'k=v');
});

test('L1：java.ajax 拿到闸页 → 自动过闸 → 重放拿到真内容（D11 闭环）', () => {
  const seen: string[] = [];
  /** 假站点：带放行 Cookie 才给真内容；声明页 URL 负责下发该 Cookie */
  const syncFetch = (req: SyncHttpRequest): SyncHttpResponse => {
    seen.push(req.url);
    const cookie = String(req.headers['Cookie'] ?? req.headers['cookie'] ?? '');
    if (req.url === GATE_TARGET) {
      return { status: 200, headers: {}, setCookie: ['YES_Eighteen=IamOverEighteenYearsOld'], body: '<html>声明</html>' };
    }
    if (cookie.includes('YES_Eighteen=')) return { status: 200, headers: {}, setCookie: [], body: REAL_BODY };
    return { status: 200, headers: {}, setCookie: ['PHPSESSID=abc'], body: GATE_HTML };
  };
  const ev = createJsEvaluator({ variables: createVariableStore(), syncFetch });
  const out = String(ev(`java.ajax("${LIST_URL}")`, {}));
  assert.ok(out.includes('真实列表'), `必须拿到真内容，实际前 80 字：${out.slice(0, 80)}`);
  assert.deepEqual(seen, [LIST_URL, GATE_TARGET, LIST_URL], '顺序必须是「原请求 → 过闸目标 → 重放」');
});

test('worker：闸页过闸在宿主侧完成（真进 worker 池）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  let evals = 0;
  const counting = new Proxy(pool as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => { evals++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;

  // 源 CookieStore：`http` 桩模拟引擎的 harvestCookies（把 Set-Cookie 写进同一个 jar）
  const jar: Record<string, string> = {};
  const cookies = {
    get: (k: string) => jar[k] ?? '',
    set: (k: string, v: string) => { jar[k] = v; },
    remove: (k: string) => { delete jar[k]; },
    header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
  };
  const seen: string[] = [];
  const http = async (r: { url: string; headers?: Record<string, string> }) => {
    seen.push(r.url);
    const hdrs = r.headers ?? {};
    const cookie = String(hdrs['Cookie'] ?? hdrs['cookie'] ?? '');
    if (r.url === GATE_TARGET) {
      cookies.set('YES_Eighteen', 'IamOverEighteenYearsOld');
      return { status: 200, headers: {}, body: '<html>声明</html>' };
    }
    if (cookie.includes('YES_Eighteen=')) return { status: 200, headers: {}, body: REAL_BODY };
    return { status: 200, headers: {}, body: GATE_HTML };
  };
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), cookies, pool: counting, http });
  try {
    const out = String(await Promise.resolve(ev(`java.ajax("${LIST_URL}")`, {})));
    assert.ok(evals > 0, '本用例必须真的走 worker 池（否则是空转）');
    assert.ok(out.includes('真实列表'), `worker 路径也必须拿到真内容：${out.slice(0, 80)}`);
    assert.deepEqual(seen, [LIST_URL, GATE_TARGET, LIST_URL]);
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});