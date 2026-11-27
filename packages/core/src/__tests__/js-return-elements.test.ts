/**
 * 回归锁：**元素列表经 `<js>` 段「原样返回 result」后不得退化成单个元素**。
 *
 * ## 症状（用户实测）
 * 🎨🔞禁漫天堂多话作品（如 `/album/1232836` 有 **73 话**）**目录只剩 1 章**，
 * 标题恒为「第1话」= 列表里的**第 0 个 `<a>`**。用户明确反馈「之前是完整章节目录」= 回归。
 *
 * ## 取证链（逐层对齐，均已复跑）
 *   ① 详情页真实结构：`<div class="episode"><ul class="btn-toolbar "><a href="/photo/1">…`
 *      （`<a>` 是 `<ul>` 的**直接子元素**，不规范 HTML，但 jsdom 解析后完好、未被重建）；
 *   ② 引擎选择器层正常：`cssGetElements('class.btn-toolbar.0@tag.a||.reading')` → **73 个**；
 *   ③ 引擎目录链路（`engine.ts` 的 `ca.getElements(listRule)`）却只有 **1 个**
 *      （`YUEDU_DEBUG_DETAIL=1` 实测 `[toc] els=1`）⇒ 塌陷发生在**元素路径的 `<js>` 段**；
 *   ④ 根因：`bindings()` 走 `bridgeDom(result)`，而 `bridgeDom` 对元素数组调 `bridgeList()`，
 *      后者把列表方法**挂在 `arr[0]` 上并返回它** ⇒ 脚本拿到的 `result` 是第 0 个元素
 *      （`result.size()` 却是 73，自相矛盾）。目录规则几乎都以 `<js> … result </js>` 结尾，
 *      于是 **N 个章节元素 → 1 个**。
 *
 * ## Legado 语义
 * `AnalyzeByJSoup.getElements` 每段产出的都是 `org.jsoup.select.Elements`
 * （`ArrayList<Element>`，**真数组**），`bindings["result"]` 就是这个列表 ⇒ 原样返回仍是 N 项。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzeRule } from '../selector/analyze';
import { createVariableStore } from '../store';

/** 复刻禁漫天堂详情页章节区（`a` 是 `ul` 的直接子元素） */
const HTML = `<html><body>
<div class="read-block"><a class="btn btn-primary reading" href="/photo/1">开始阅读</a></div>
<div class="episode"><ul class="btn-toolbar ">
  <a href="/photo/1"><li class="current_series"><h3>第1话</h3></li></a>
  <a href="/photo/2"><li><h3>第2话</h3></li></a>
  <a href="/photo/3"><li><h3>第3话</h3></li></a>
</ul></div>
<body></html>`;

/** 禁漫天堂真实的 chapterList（选择器段 + `<js>` 段；JS 段原样 `result` 交下去） */
const JM_RULE =
  'class.btn-toolbar.0@tag.a||.reading\n<js>\nvar type = +(java.get(\'btype\'))\n' +
  'switch (type) {\n  case 1:\n    book.type = 8;\n    break;\n  case 2:\n    book.type = 64;\n}\nresult\n</js>';

const BASE = 'https://18comic.test/album/1232836';

/** 捕获「真正交给脚本的 result」，同时把脚本最后一行 `result` 原样回传（Legado 语义） */
function makeEnv(sink?: { result?: unknown }) {
  const jsEval = (code: string, bindings: Record<string, unknown>): unknown => {
    if (sink) sink.result = bindings['result'];
    return /result\s*$/.test(code.trim()) ? bindings['result'] : '';
  };
  return {
    baseUrl: BASE,
    variables: createVariableStore(),
    jsEval,
    jsEvalSync: jsEval,
    toAbsolute: (u: string) => u,
  } as never;
}
const mk = (sink?: { result?: unknown }) => new AnalyzeRule(makeEnv(sink)).setContent(HTML, BASE);

test('目录：chapterList 的元素列表经 <js> 段后仍是全量（禁漫天堂只剩一章的根因）', async () => {
  const els = await mk().getElements(JM_RULE);
  assert.equal(els.length, 3, `必须是 3 章；拿到 ${els.length} = result 被退化成了首元素`);

  // 再按 engine.ts 的目录流程逐元素取 chapterName / chapterUrl
  const names: string[] = [];
  const urls: string[] = [];
  for (const el of els) {
    const ea = new AnalyzeRule(makeEnv()).setContent(el, BASE);
    names.push(await ea.getString('text'));
    urls.push(await ea.getString('href'));
  }
  assert.deepEqual(names, ['第1话', '第2话', '第3话']);
  assert.deepEqual(urls, ['/photo/1', '/photo/2', '/photo/3']);
});

test('交给脚本的 result 必须是「数组 + Elements 方法」双全（不得只留其一）', async () => {
  const sink: { result?: unknown } = {};
  await mk(sink).getElements('class.btn-toolbar.0@tag.a||.reading\n<js>result</js>');
  const r = sink.result as { length?: number; size?: () => number } | undefined;
  assert.ok(r, 'result 未送到脚本');
  assert.equal(r?.length, 3, `result 应是长度为 3 的真数组，实际 length=${r?.length}`);
  assert.equal(typeof r?.size, 'function', 'jsoup Elements 的 size() 必须仍可用');
  assert.equal(r?.size?.(), 3);
});

test('单元素规则不受影响（只命中 1 个时仍是 1 项）', async () => {
  const html = '<html><body><div class="x"><a href="/only">唯一</a></div></body></html>';
  const els = await new AnalyzeRule(makeEnv())
    .setContent(html, 'https://t.test/')
    .getElements('class.x@tag.a\n<js>result</js>');
  assert.equal(els.length, 1);
});

test('不带 <js> 段时逐项取 href 正常（chapterUrl 形态）', async () => {
  const els = await mk().getElements('class.btn-toolbar.0@tag.a');
  assert.equal(els.length, 3);
  const urls: string[] = [];
  for (const el of els) {
    urls.push(await new AnalyzeRule(makeEnv()).setContent(el, BASE).getString('href'));
  }
  assert.deepEqual(urls, ['/photo/1', '/photo/2', '/photo/3']);
});
