/** `#563` worker 路径对照：jsoup abs:href 在 worker（经 RPC 回宿主 JsoupDom）也要解出绝对地址 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

test('worker：Jsoup.parse(h, base) + attr(abs:href) 经 RPC 回宿主后仍是绝对地址', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool }) as (
      code: string,
      bindings: Record<string, unknown>,
    ) => Promise<unknown>;
    const CODE = [
      "var h = String(result);",
      "var doc = org.jsoup.Jsoup.parse(h, 'https://www.huangjinwu.org/rank/allvisit/1.html');",
      "var es = doc.select('a.book-card[href^=/novel]');",
      "var e0 = es.size() > 0 ? es.get(0) : null;",
      "JSON.stringify({ size: es.size(), abs: e0 ? e0.attr('abs:href') : null });",
    ].join('\n');
    const out = String(
      await ev(CODE, {
        result: '<a class="book-card" href="/novel/55">A</a>',
        baseUrl: 'https://www.huangjinwu.org/rank/allvisit/1.html',
      }),
    );
    const parsed = JSON.parse(out) as { size: number; abs: string };
    assert.equal(parsed.size, 1, `应命中 1 个卡片：${out}`);
    assert.equal(parsed.abs, 'https://www.huangjinwu.org/novel/55', `abs:href 应为绝对地址：${out}`);
  } finally {
    await (pool as { destroy?: () => Promise<void> }).destroy?.();
  }
});
