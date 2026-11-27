/**
 * 缺陷类 Q —— `{{…}}` 占位符的**绑定面**与**复合段语义**（2026-09-21）。
 *
 * 两处偏差，都是「Legado 能跑、我们静默取错值」：
 *
 * ① **pre-pass 用裸求值器**：`resolvePlaceholders(ruleStr, …)` 此前拿到的是 `env.jsEval`
 *    （只有源变量），没有 `bindings()` 里的 `baseUrl` / `book` / `chapter` / `source` / `title` / `$` …
 *    → JS 里这些名字是 `undefined` → `resolvePlaceholders` 对 `v == null` 处理为
 *    **替换成空串** → 占位符被静默抹掉。语料该形态 82 处。
 *
 * ② **复合段（Legado `Mode.Regex`）语义丢失**：Legado 的 `mode` 在 SourceRule 构造时（替换**前**）定下，
 *    替换后仍是 `Mode.Regex` → `getString` 走 `else -> rule`（**结果就是替换后的文本本身**）；
 *    我们若在 pre-pass 提前替换，`splitSourceRule` 就看不到 `{{}}` → 复合段消失 → 规则被当 CSS 选择器。
 *
 * 语料原文（📂书文小说，`ruleBookInfo.tocUrl`）：`{{baseUrl}}##$##d1.html`
 * 期望（按 Legado 逐行推导）：`makeUpRule` 把 `{{baseUrl}}` 换成页面地址 → 按 `##` 切出
 * `replaceRegex='$'` / `replacement='d1.html'` → `rule` = 地址 → `else -> rule` → 再 replaceRegex
 * → **`<baseUrl>d1.html`**。（修前我们得到的是「正文内容 + d1.html」。）
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';

const BASE = 'https://www.shuww.com/book/77343/';
const CONTENT = '<p>正文内容</p>';

function mkEnv(
  extra: { variables?: Record<string, string>; bookData?: Record<string, unknown>; chapterData?: Record<string, unknown> } = {},
  withSync = true,
) {
  const variables = createVariableStore();
  for (const [k, v] of Object.entries(extra.variables ?? {})) variables.set(k, v);
  const jsEval = createJsEvaluator({ variables });
  const env = {
    baseUrl: BASE,
    variables,
    jsEval,
    // 同步求值器默认给上（引擎的 L1 就是这条）；withSync=false 时故意不给，用于锁「不静默抹空」
    ...(withSync ? { jsEvalSync: jsEval } : {}),
    ...(extra.bookData ? { bookData: extra.bookData } : {}),
    ...(extra.chapterData ? { chapterData: extra.chapterData } : {}),
  };
  return env;
}

const ruleOf = (env: ReturnType<typeof mkEnv>, content = CONTENT) => new AnalyzeRule(env).setContent(content, BASE);

test('① 绑定面：{{baseUrl}} 在复合段里必须取到页面地址（语料原文 书文小说 tocUrl）', async () => {
  const rule = '{{baseUrl}}##$##d1.html';
  const async_ = await ruleOf(mkEnv()).getString(rule);
  assert.equal(async_, `${BASE}d1.html`);

  const sync = ruleOf(mkEnv()).syncGetString(rule);
  assert.equal(sync, `${BASE}d1.html`, '同步路径必须同结果');
});

test('① 绑定面：{{baseUrl}} 纯拼接也不得被抹空', async () => {
  assert.equal(await ruleOf(mkEnv()).getString('{{baseUrl}}x'), `${BASE}x`);
  assert.equal(await ruleOf(mkEnv()).getString('{{baseUrl}}/d1.html'), `${BASE}/d1.html`);
});

test('① 绑定面：占位符里的 JS 表达式能拿到 baseUrl（语料 66书吧 coverUrl 形态）', async () => {
  const out = await ruleOf(mkEnv()).getString('https://img.test/{{baseUrl.match(/\\/(\\d+)\\//)[1]}}.jpg');
  assert.equal(out, 'https://img.test/77343.jpg');
});

test('① 绑定面：{{book.name}} / {{title}} 走 bindings（源变量里没有这些名字）', async () => {
  const env = mkEnv({
    bookData: { name: '青葫剑仙', author: '某某' },
    chapterData: { title: '第1章 剑来' },
  });
  assert.equal(await ruleOf(env).getString('书名:{{book.name}}'), '书名:青葫剑仙');
  // title 是 chapterData.title 的直连绑定（Legado AnalyzeRule.kt:903）
  assert.equal(await ruleOf(env).getString('{{title}}'), '第1章 剑来');
});

test('② 复合段语义：非复合的 {{}}（前缀含 ##）仍由 pre-pass 处理', async () => {
  // 首个占位符前的前缀含 `##` → 按 Legado 保持 Default 模式 → pre-pass 负责替换，替换后按选择器求值
  const el = '<div id="a">X</div>';
  const env = mkEnv({ chapterData: { title: '第1章' } });
  const out = await ruleOf(env, el).getString('#a@text##^##{{title}}');
  assert.equal(out, '第1章X');
});

test('② 复合段语义：pre-pass 让路后，两条路径逐字同结果（回归护栏）', async () => {
  const CASES = ['{{baseUrl}}##$##d1.html', '{{baseUrl}}x', '{{baseUrl}}/a/b.html'];
  for (const rule of CASES) {
    const a = await ruleOf(mkEnv()).getString(rule);
    const s = ruleOf(mkEnv()).syncGetString(rule);
    assert.equal(a, s, `同步/异步不一致：${rule}`);
  }
});

test('同步求值器缺失时占位符**保留原文**（不得静默抹成空串）', async () => {
  // 旧实现是 `this.env.jsEvalSync ?? (() => '')` → 所有 {{}} 被替换成空串（最恶劣的静默失败形态）
  // 故意**不给** jsEvalSync（withSync=false）
  const out = ruleOf(mkEnv({ chapterData: { title: '第1章' } }, false), '<div id="a">X</div>').syncGetString('#a@text##^##{{title}}');
  assert.ok(out.includes('{{title}}'), `缺同步求值器时应保留原文，实际：${JSON.stringify(out)}`);
});
