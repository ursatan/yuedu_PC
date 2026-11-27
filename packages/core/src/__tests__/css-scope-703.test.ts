/**
 * `#703` 回归锁之一：**`@css:` 行内规则里的「从文档根写起的完整路径」必须能命中**。
 *
 * ## 缺陷（用户实测：精华书阁手机版 V2）
 * 源的搜索规则长这样：
 * ```
 * ruleSearch.bookList = @css:div.searchbook                                  ← 命中 13 项 ✓
 * ruleSearch.name     = @css:html > body > div.searchbook > div.bookinfo > h4.bookname a@text  ← 恒空 ✗
 * ```
 * 列表有 13 条，但每一项的书名/作者/封面全空 ⇒ 整个源「搜索失效」（引擎把空书名条目直接跳过）。
 *
 * ## 根因：作用域语义差一层
 * 上游 Legado 走 **jsoup** 的 `Element.select(css)`：
 *  · 候选集限定在 `root` 的**子树**内；
 *  · 但**祖先链是整棵文档树**的（`ImmediateParentRun` 等求值器用 `element.parent()` 一路向上）
 *    ⇒ `html > body > div.searchbook > …` 在「root = div.searchbook」时照样命中。
 * 本仓此前用 `root.querySelectorAll(css)`：把 root 当**作用域根**，`html`/`body` 必须在 root 内
 * 才可能匹配 ⇒ 恒 0。
 *
 * 实测（真实搜索页）：`doc.querySelectorAll(完整路径)` = 13，`item.querySelectorAll(同一串)` = **0**。
 *
 * ## 本文件锁三件事
 *  1. 行内 `@css:` 完整路径能取到值（这是用户报的那条）；
 *  2. **不会因此把兄弟节点也算进来**（恒等在 root 子树内过滤 —— 否则就从「取不到」变成「取错」）；
 *  3. 游离元素（脚本里 `createElement` 造的）仍按子树查询，不炸。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalyzeRule } from '../selector/analyze';
import { selectJsoup } from '../selector/jsoup-select';
import { parseHtml } from '../dom';
import { createVariableStore } from '../store';

/** 最小环境（本用例不需要 JS 求值） */
function makeEnv(): never {
  return {
    jsEval: async () => '',
    variables: createVariableStore(),
  } as never;
}

const HTML = `<!doctype html><html><body>
<div class="searchbook">
  <div class="bookinfo">
    <h4 class="bookname"><a href="/1/">书甲</a></h4>
    <p class="author">作者A</p>
  </div>
  <div class="bookimg"><a href="/1/"><img src="/c/1.jpg"></a></div>
</div>
<div class="searchbook">
  <div class="bookinfo">
    <h4 class="bookname"><a href="/2/">书乙</a></h4>
    <p class="author">作者B</p>
  </div>
</div>
</body></html>`;

const FULL = '@css:html > body > div.searchbook > div.bookinfo > h4.bookname a@text';

test('#703① 行内 `@css:` 完整路径（html > body > …）能取到值', async () => {
  const ar = new AnalyzeRule(makeEnv()).setContent(HTML, 'https://x.test/s');
  const items = await ar.getElements('@css:div.searchbook');
  assert.equal(items.length, 2, '列表规则本身应命中 2 项');

  const first = new AnalyzeRule(makeEnv()).setContent(items[0] as never, 'https://x.test/s');
  assert.equal(await first.getString(FULL), '书甲');

  const second = new AnalyzeRule(makeEnv()).setContent(items[1] as never, 'https://x.test/s');
  assert.equal(await second.getString(FULL), '书乙');
});

test('#703② 祖先感知不会「越界」：兄弟项的元素不算进来', async () => {
  const doc = parseHtml(HTML).document;
  const items = [...doc.querySelectorAll('div.searchbook')];
  assert.equal(items.length, 2);
  const sel = 'html > body > div.searchbook > div.bookinfo > h4.bookname a';
  // 每项只能拿到自己那一个 a（doc 级是 2 个）
  assert.equal(doc.querySelectorAll(sel).length, 2, '文档级应为 2');
  assert.equal(selectJsoup(items[0]!, sel).length, 1, '第 1 项内应为 1（不是 2）');
  assert.equal(selectJsoup(items[1]!, sel).length, 1, '第 2 项内应为 1');
  assert.equal((selectJsoup(items[0]!, sel)[0] as Element).textContent, '书甲', '而且必须是它自己的那个');
});

test('#703③ `getElements`（取元素）同样祖先感知', async () => {
  const ar = new AnalyzeRule(makeEnv()).setContent(HTML, 'https://x.test/s');
  const items = await ar.getElements('@css:div.searchbook');
  const inner = new AnalyzeRule(makeEnv()).setContent(items[1] as never, 'https://x.test/s');
  const anchors = await inner.getElements('@css:html > body > div.searchbook > div.bookinfo > h4.bookname a');
  assert.equal(anchors.length, 1, '项内完整路径应取到 1 个 a');
});

test('#703④ 真·不存在的祖先仍为 0（不能因为「祖先感知」就乱匹配）', async () => {
  const doc = parseHtml(HTML).document;
  const item = doc.querySelector('div.searchbook')!;
  assert.equal(selectJsoup(item, 'html > body > div.not-exist > a').length, 0);
  const ar = new AnalyzeRule(makeEnv()).setContent(item, 'https://x.test/s');
  assert.equal(await ar.getString('@css:html > body > div.not-exist > a@text'), '');
});

test('#703⑤ 游离元素（未挂到文档上）退回子树查询，不抛错', () => {
  const doc = parseHtml('<div id="host"></div>').document;
  const host = doc.getElementById('host')!;
  const loose = doc.createElement('div');
  loose.className = 'searchbook';
  loose.innerHTML = '<div class="bookinfo"><h4 class="bookname"><a>独立</a></h4></div>';
  // 未 append ⇒ isConnected=false ⇒ 只能查子树
  assert.equal(selectJsoup(loose, 'div.bookinfo > h4.bookname a').length, 1);
  assert.equal(selectJsoup(loose, 'html > body > div.searchbook > div.bookinfo a').length, 0, '游离节点没有文档祖先链');
  // 挂上去之后祖先链就成立了
  host.appendChild(loose);
  assert.equal(selectJsoup(loose, 'html > body > div#host > div.searchbook > div.bookinfo a').length, 1);
});
