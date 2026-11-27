/**
 * `document` 绑定回归锁（挂账 `#92`，2026-09-24）。
 *
 * ## 现场（实测证据，不是推断）
 * 🏷🎨腾讯漫画 正文规则必须 `eval` 页面自带的 nonce 表达式才能解密 `DATA`。连续抓该章 15 次，
 * **3 次**出现浏览器环境探针：
 * ```
 * window["no"+"nce"] = "60cbf69930707b7d24976f0ea910535" +
 *                      (+eval("!!document.getElementsByTagName('html')")).toString() + …
 * ```
 * 我们（以及 Legado 的 Rhino）沙箱里都没有 `document` ⇒ `document is not defined`
 * ⇒ **整条正文规则失败**（搜索 23 / 详情 119 都正常，只有正文偶发崩 —— 这就是「非确定性」的真因）。
 *
 * ## 修法
 * `AnalyzeRule.bindings()` 传 `DOCUMENT_THUNK` 工厂 → 求值器在 `globalThis` 上定义成
 * **惰性 getter**（`Object.defineProperty`，不能用对象展开，否则 getter 会被立刻执行）；
 * 取到的是**当前内容真实的 jsdom Document**（`documentOf()`，复用 `nodesOf` 的共享 DOM 槽）。
 * 引用 `document` 的脚本由 `HOST_DOCUMENT_RE` 强制留 L1（worker 无 DOM）。
 *
 * 本测试锁四条不变量：
 * 1. `document` 存在且是**真 DOM**（`documentElement.nodeName === 'HTML'`）；
 * 2. 页面那种 `eval("!!document.getElementsByTagName('html')")` 得到 `true`（与浏览器同构）；
 * 3. **惰性**：脚本不读 `document` ⇒ **0 次额外解析**（不得退化成「每段 JS 先解析一遍」）；
 * 4. 只读 `document` 一次 ⇒ 只解析一次（共享槽生效）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtmlStats } from '../index';

const PAGE = '<html><head><title>t</title></head><body><div id="x">正文</div></body></html>';

function envOf() {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  return { baseUrl: 'https://ac.qq.com/ComicView/index/id/1/cid/1', variables, jsEval, jsEvalSync: jsEval } as never;
}

/** 在**字符串内容**上求值一段 JS，返回 [结果, 本次新增 parseHtml 次数] */
async function runOnPage(code: string): Promise<[string, number]> {
  const env = envOf();
  const before = parseHtmlStats.count;
  const out = await new AnalyzeRule(env).setContent(PAGE).getString(`@js:${code}`);
  return [String(out), parseHtmlStats.count - before];
}

test('① `document` 是真 DOM（不是伪造桩）：documentElement / getElementsByTagName 均可用', async () => {
  const [name] = await runOnPage('document.documentElement.nodeName');
  assert.equal(name, 'HTML', `应为真 jsdom 文档：${name}`);
  const [n] = await runOnPage(`String(document.getElementsByTagName('html').length)`);
  assert.ok(Number(n) >= 1, `getElementsByTagName('html') 应非空，实际 ${n}`);
  const [txt] = await runOnPage(`document.getElementById('x').textContent`);
  assert.equal(txt, '正文', `应能读到内容节点：${txt}`);
});

test('② 站点那形态：eval("!!document.getElementsByTagName(\'html\')") → 与浏览器同值且不抛错', async () => {
  /**
   * ⚠️ 期望值是 `"1"` 而不是 `"true"`：表达式外面套了**一元加号**
   * （`(+eval("!!…")).toString()`）⇒ 浏览器里 `+true` 也是 `1`。
   * 所以站点这个探针**不是靠取值区分**环境，而是**靠「没有 document 就抛 ReferenceError」**——
   * 我们此前正是被它抛错打死（整条正文规则失败），补齐 `document` 后取值与浏览器逐字一致。
   */
  const [v] = await runOnPage(`var s = "a" + (+eval("!!document.getElementsByTagName('html')")).toString() + "b"; s`);
  assert.equal(v, 'a1b', `必须与浏览器一致（+true === 1）：${v}`);
  // 另一种不带一元加号的写法：真值应为 "true"
  const [v2] = await runOnPage(`String(!!document.getElementsByTagName('html'))`);
  assert.equal(v2, 'true', `不带一元加号时应为 true：${v2}`);
});

test('③ 惰性：脚本**不读** document ⇒ 0 次额外解析（不得退化成「每段 JS 先解析一遍」）', async () => {
  const [v, parses] = await runOnPage('1 + 1');
  assert.equal(v, '2');
  assert.equal(parses, 0, `不读 document 就不该解析内容，实际新增 ${parses} 次`);
});

test('④ 只读一次 ⇒ 只解析一次（复用共享 DOM 槽）', async () => {
  const [, parses] = await runOnPage(`document.getElementsByTagName('html').length + document.title.length`);
  assert.equal(parses, 1, `同一段里读两次 document 也只应解析 1 次，实际 ${parses}`);
});

test('⑤ 内容已是**元素**时不额外解析（ownerDocument 直接返回）', async () => {
  const env = envOf();
  const dom = (await import('../index')).parseHtml(PAGE, 'https://ac.qq.com/');
  const el = dom.root.querySelector('#x') as Element;
  const before = parseHtmlStats.count;
  const out = await new AnalyzeRule(env).setContent(el as never).getString(`@js:document.documentElement.nodeName`);
  assert.equal(String(out), 'HTML');
  assert.equal(parseHtmlStats.count - before, 0, '元素内容的 ownerDocument 无需再解析');
});

test('⑥ `window` = 全局对象（浏览器语义）：window.Array 探针不崩且一致', async () => {
  // 探针实测枚举里第二种形态：eval("1 * (!window.Array) + 1")（`tmp/probe-92-probes.mjs`）
  const [v] = await runOnPage('1 * (!window.Array) + 1');
  assert.equal(v, '1', `window.Array 应为真值（浏览器里 window 就是全局对象）：${v}`);
  // 同一段里读 document 两次 → 仍只解析一次（window 与 document 共用同一份内容）
  const [same, parses] = await runOnPage(`String(window.document === document) + '|' + document.documentElement.nodeName`);
  assert.equal(same, 'true|HTML', `window.document 必须就是 document：${same}`);
  assert.equal(parses, 1, `仍应只解析 1 次，实际 ${parses}`);
});
