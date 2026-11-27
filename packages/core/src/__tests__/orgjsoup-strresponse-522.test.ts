/**
 * `#522` **能力补齐**回归锁：`org.jsoup`（parse / parser.Parser.unescapeEntities）与
 * `io.legado.app.help.http.StrResponse` 在 **worker 与 L1 必须逐项对拍**（同 `#526` 的纪律）。
 *
 * 为什么必须两路都跑：
 *  · 路由放行只代表「允许去 worker」；真正决定源能否跑的是 worker 内的**语义**。
 *  · 本仓历史教训：L1 能跑、worker 静默空串（未知成员落 nest() 空工厂）⇒ 只测 worker
 *    等于把源从「能用」改成「不能用」（`#526` 头注即此）。
 *
 * 覆盖的真实形态：
 *  · `Packages.org.jsoup.parser.Parser.unescapeEntities(h, true)` —— 存书啦/格格党网 用它解实体（7 处）；
 *    worker 侧经 `rpc('dom','unescapeEntities')` 回宿主，用 commons-text 表解码（与 L1 同一份 `unescapeHtml4`）。
 *  · `Packages.org.jsoup.Jsoup.parse(html).select(sel).text()` —— 通用正文/列表直取。
 *  · `new Packages.io.legado.app.help.http.StrResponse(url, body, code)` —— 爱丽丝书屋×3 / 点众阅读 /
 *    聚合书库 用它造可链式响应（`.body()/.code()/.statusCode()`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { needsJavaBridgeL1, WORKER_PACKAGES_PREFIXES } from '../selector/java-bridge';

function makeEvaluator(withPool: boolean) {
  const vars = createVariableStore();
  const pool = withPool ? createWorkerSandboxPool({ size: 1 }) : undefined;
  return createHybridJsEvaluator({ variables: vars, pool }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
}

async function bothWays(code: string): Promise<{ l1: string; wk: string }> {
  const l1 = String(await Promise.resolve(makeEvaluator(false)(code, {})));
  const wk = String(await Promise.resolve(makeEvaluator(true)(code, {})));
  return { l1, wk };
}

test('① Parser.unescapeEntities：worker（RPC 回宿主）与 L1 结果一致', async () => {
  const code = 'Packages.org.jsoup.parser.Parser.unescapeEntities("A&amp;B&nbsp;c&#233;&lrm;", true);';
  const { l1, wk } = await bothWays(code);
  assert.equal(l1, 'A&B\u00A0cé\u200E', 'L1 基线不对 ⇒ 对拍失去意义');
  assert.equal(wk, l1, 'worker 与 L1 结果不一致');
});

test('② Jsoup.parse(inner).select(sel).text()：worker 与 L1 结果一致', async () => {
  const code =
    'var d = Packages.org.jsoup.Jsoup.parse("<div class=\'x\'>你好<b>世界</b></div>");' +
    'd.select(".x").text() + "|" + d.select(".x").size();';
  const { l1, wk } = await bothWays(code);
  assert.equal(l1, '你好世界|1');
  assert.equal(wk, l1);
});

test('③ new io.legado.app.help.http.StrResponse(url, body, code)：worker 与 L1 一致', async () => {
  const code =
    'var r = new Packages.io.legado.app.help.http.StrResponse("https://a.test/x", "BODY-X", 404);' +
    'r.body() + "|" + r.code() + "|" + r.statusCode() + "|" + r.url();';
  const { l1, wk } = await bothWays(code);
  assert.equal(l1, 'BODY-X|404|404|https://a.test/x', 'L1 基线不对 ⇒ 对拍失去意义');
  assert.equal(wk, l1, 'worker 与 L1 结果不一致');
});

test('④ 路由判据：本轮放行的路径不再强留 L1（含 `#528` 的 select.Elements）', () => {
  assert.equal(needsJavaBridgeL1('var d = Packages.org.jsoup.Jsoup.parse(x);'), false, 'Jsoup.parse 应放行');
  assert.equal(needsJavaBridgeL1('Packages.org.jsoup.parser.Parser.unescapeEntities(s, true);'), false, 'Parser 应放行');
  assert.equal(
    needsJavaBridgeL1('new Packages.io.legado.app.help.http.StrResponse(u, b, 200);'),
    false,
    'StrResponse 应放行',
  );
  assert.equal(needsJavaBridgeL1('new Packages.org.jsoup.select.Elements();'), false, '#528 select.Elements 应放行');
  assert.ok(WORKER_PACKAGES_PREFIXES.includes('org.jsoup.select.Elements'));
  /**
   * 说明（非断言）：裸 `org.jsoup.Jsoup` 前缀会**顺带覆盖** `Jsoup.connect`（两侧都未实现）。
   * `#529` 负责补齐 connect；在此之前，worker 侧调用 `connect` 即**抛 TypeError（响亮失败，非静默空串）**。
   */
  void 0;
});

test('⑤ `#528` Elements.add / clone / text(写) / child / parseBodyFragment：worker 与 L1 逐项对拍', async () => {
  // 真实形态取自 找书啦·求书互助 ruleToc：克隆 → 删徽标 → 读净化后的标题 → 造盒 → 追加进 Elements
  const code = [
    'var Jsoup = Packages.org.jsoup.Jsoup;',
    'var d = Jsoup.parse(\'<div class="wrap"><h1 class="t">书名<span class="badge">[完]</span></h1><ul><li>甲</li><li>乙</li></ul></div>\');',
    'var out = new Packages.org.jsoup.select.Elements();',
    'var h1 = d.select("h1.t").first();',
    'var c = h1.clone();',
    'var bs = c.select("span.badge");',
    'for (var z = 0; z < bs.size(); z++) bs.get(z).remove();',
    'var title = String(c.text());',
    'var box = Jsoup.parseBodyFragment(\'<div class="mk"></div>\').body().child(0);',
    'box.text("T|" + title);',
    'out.add(box);',
    'var lis = d.select("li");',
    'for (var i = 0; i < lis.size(); i++) out.add(lis.get(i));',
    'out.size() + "|" + out.get(0).text() + "|" + out.get(1).text() + "|" + out.get(2).text();',
  ].join('\n');
  const { l1, wk } = await bothWays(code);
  assert.equal(l1, '3|T|书名|甲|乙', 'L1 基线不对 ⇒ 对拍失去意义');
  assert.equal(wk, l1, 'worker 与 L1 结果不一致');
});

test('⑥ `#529` Jsoup.connect：Method 枚举 + 构建器链式 + 坏地址抛 `Malformed URL`（两侧一致）', async () => {
  const code = [
    'var M = Packages.org.jsoup.Connection.Method;',
    'var conn = Packages.org.jsoup.Jsoup.connect("https://example.test/x");',
    'var chained = (conn.header("a","b") === conn) && (conn.method(M.DELETE) === conn) &&',
    '  (conn.ignoreContentType(true) === conn) && (conn.ignoreHttpErrors(true) === conn) && (conn.timeout(3000) === conn);',
    'var threw = "";',
    'try { Packages.org.jsoup.Jsoup.connect("not-a-url").execute(); } catch (e) { threw = String(e && e.message ? e.message : e); }',
    'String(M.DELETE) + "|" + String(M.GET) + "|" + chained + "|" + threw;',
  ].join('\n');
  const { l1, wk } = await bothWays(code);
  assert.equal(l1, 'DELETE|GET|true|Malformed URL: not-a-url', 'L1 基线不对 ⇒ 对拍失去意义');
  assert.equal(wk, l1, 'worker 与 L1 结果不一致');
});
