/**
 * 挂账 `#93` 的核查结论 + 回归锁（2026-09-24）。
 *
 * 核查数据（`tmp/probe-93-fragment.mts` / `tmp/probe-93-hotspot.mts`，24 源 + 40 源两轮）：
 *   ① DOM 解析占**进程 CPU 40.7%**（8121ms / 19954ms）—— 是真正的热点；
 *   ② 但 `JSDOM.fragment()` **语义不等价**：无 `documentElement`、文档级 XPath 返 0、
 *      正文里的 `<html>/<head>/<body>` 会被压平 ⇒ **不能**当 `parseHtml` 的通用快路；
 *   ③ 231 次 parseHtml 里有 **42 次是同一份内容**（sha1 相同），且重复的都是**整页**
 *      ⇒ 重复解析的输入字节占**全部解析字节的 46%**（一份 5787 字符的搜索页被解析了 8 次）。
 *
 * ⇒ 该修的是「同一份内容在一次请求里被反复解析」（违反 R1「一次解析只产出一棵树」），
 *    做法是 env 级共享槽 `SHARED_DOM`（`nodesOf` 查它）+ 变更安全阀 `markDomTouched()`。
 *
 * 本测试锁四条不变量：
 * 1. 同一 env（= 同一次引擎调用）+ 同一份文本 + 不同实例 → **只解析一次**；
 * 2. 不同 env（= 不同请求）→ 各自解析（**不得跨请求共享**，否则 DOM 常驻无上限）；
 * 3. 源脚本动过 DOM（`remove()/removeAttr()/addClass()/removeClass()`）→ **本请求内停用共享**
 *    （否则「A 实例删掉的节点」会消失给 B 实例看，与 Legado「每个 setContent 各自一棵树」不符）；
 * 4. 超过尺寸上限的文本不共享（jsdom 的 DOM ≈ HTML 的 90×，巨型页面共享会把寿命拖长）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtmlStats } from '../index';

const PAGE = `<html><body><div class="list">
  <a class="item" href="/b/1">第1章</a><b>粗体</b>
  <a class="item" href="/b/2">第2章</a>
</div></body></html>`;

function envOf() {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  return { baseUrl: 'https://example.com/list', variables, jsEval, jsEvalSync: jsEval } as never;
}

/** 用同一份页面文本跑一条 CSS 规则，返回本次新增的 parseHtml 次数 */
async function css(page: string, rule: string, env: unknown): Promise<number> {
  const before = parseHtmlStats.count;
  const out = await new AnalyzeRule(env as never).setContent(page).getString(rule);
  assert.ok(out.length >= 0);
  return parseHtmlStats.count - before;
}

/** 跑一段 JS 规则（用来触发 DOM 变更方法） */
async function js(env: unknown, page: string, code: string): Promise<void> {
  await new AnalyzeRule(env as never).setContent(page).getString(`@js:${code}`);
}

test('第①条：同一 env 内、同一份文本被不同实例求值 → 只解析一次', async () => {
  const env = envOf();
  parseHtmlStats.count = 0;
  const n1 = await css(PAGE, 'a.item@href', env);
  const n2 = await css(PAGE, 'a.item@text', env);
  const n3 = await css(PAGE, '.list@html', env);
  assert.equal(n1, 1, `首次应解析一次，实际 ${n1}`);
  assert.equal(n2, 0, `同一 env 的第二次必须复用共享 DOM（修复前为 1 次解析），实际 ${n2}`);
  assert.equal(n3, 0, `第三次同样复用，实际 ${n3}`);
  assert.equal(parseHtmlStats.count, 1, `整轮只应解析 1 次，实际 ${parseHtmlStats.count}`);
});

test('第⑤条：String 包装对象同样共享（源里 `java.getString(rule, result)` 传的就是它）', async () => {
  const env = envOf();
  parseHtmlStats.count = 0;
  // `strWithJsoup` 产物的形态：typeof 是 object、String() 才拿到原文。
  // 实测 📂VIP中文 同一份 5787 字符页面因此被解析 7 次（只认 typeof==='string' 会漏掉）。
  const wrapped = new String(PAGE);
  const a = await css(wrapped as unknown as string, 'a.item@href', env);
  const b = await css(wrapped as unknown as string, 'a.item@text', env);
  assert.equal(a, 1, `首次应解析一次，实际 ${a}`);
  assert.equal(b, 0, `String 包装对象必须命中共享槽，实际 ${b}`);
});

test('第②条：不同 env（不同请求）不得共享 —— 各自解析', async () => {
  const envA = envOf();
  const envB = envOf();
  parseHtmlStats.count = 0;
  const a = await css(PAGE, 'a.item@href', envA);
  const b = await css(PAGE, 'a.item@href', envB);
  assert.equal(a, 1, `A 请求应解析一次，实际 ${a}`);
  assert.equal(b, 1, `B 请求必须重新解析（跨请求共享会让 DOM 常驻无上限），实际 ${b}`);
});

test('第③条：源脚本 remove() 之后 → 本请求内停用共享（安全阀）', async () => {
  const env = envOf();
  parseHtmlStats.count = 0;
  const first = await css(PAGE, 'a.item@href', env);
  const reused = await css(PAGE, 'a.item@href', env);
  assert.equal(first, 1);
  assert.equal(reused, 0, '未变更时应复用');

  // 触发变更：remove() 会标记本 env「动过 DOM」
  await js(env, PAGE, 'result.select("b").remove(); "ok"');

  const after = await css(PAGE, 'a.item@href', env);
  assert.equal(after, 1, `动过 DOM 后必须重新解析（不得把改过的树给下一个实例），实际 ${after}`);
});

test('第③条补：removeAttr() / addClass() 同样触发安全阀', async () => {
  for (const code of ['result.select("a").removeAttr("href"); "ok"', 'result.select("a").addClass("x"); "ok"']) {
    const env = envOf();
    await css(PAGE, 'a.item@href', env);
    await js(env, PAGE, code);
    const after = await css(PAGE, 'a.item@href', env);
    assert.equal(after, 1, `${code} 之后应停用共享，实际解析 ${after} 次`);
  }
});

test('第④条：超过尺寸上限的文本不共享（默认 1MB，可配 YUEDU_DOM_CACHE_MAX_CHARS）', async () => {
  const env = envOf();
  const prev = process.env.YUEDU_DOM_CACHE_MAX_CHARS;
  process.env.YUEDU_DOM_CACHE_MAX_CHARS = '10'; // 让任何页面都超限
  try {
    parseHtmlStats.count = 0;
    const a = await css(PAGE, 'a.item@href', env);
    const b = await css(PAGE, 'a.item@href', env);
    assert.equal(a, 1, `实际 ${a}`);
    assert.equal(b, 1, `超限文本不应进共享槽（每次都解析），实际 ${b}`);
  } finally {
    if (prev === undefined) delete process.env.YUEDU_DOM_CACHE_MAX_CHARS;
    else process.env.YUEDU_DOM_CACHE_MAX_CHARS = prev;
  }
});

test('共享槽容量可配且默认 2（YUEDU_DOM_CACHE_MAX）', async () => {
  const env = envOf();
  const prev = process.env.YUEDU_DOM_CACHE_MAX;
  process.env.YUEDU_DOM_CACHE_MAX = '1';
  try {
    parseHtmlStats.count = 0;
    const p2 = PAGE.replace('第2章', '第2章（另一页）');
    await css(PAGE, 'a.item@href', env); // 占 1 槽
    await css(p2, 'a.item@href', env); // 挤掉上一槽
    const back = await css(PAGE, 'a.item@href', env); // 已被挤掉 → 重新解析
    assert.equal(back, 1, `容量 1 时应把最早的挤出，实际 ${back}`);
  } finally {
    if (prev === undefined) delete process.env.YUEDU_DOM_CACHE_MAX;
    else process.env.YUEDU_DOM_CACHE_MAX = prev;
  }
});
