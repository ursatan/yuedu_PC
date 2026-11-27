/**
 * **类BZ（2026-10-26）**：`@js:` 返回 `java.util` 集合 ⇒ 必须按上游 `AnalyzeRule.kt:453-500`
 * 的 `is List<*>` 语义**逐项展开**，不能把整个列表当成「一个元素」。
 *
 * ## 真站取证（📚海棠搜书🔞蓝海搜书）
 * `ruleToc.chapterList = '+@js:(function(){… var out = new Packages.java.util.ArrayList();
 * for(…) out.add(li.outerHTML); return out;})()'`
 * 目录页真实有 **100** 个 `<li class="BCsectionTwo-top-chapter">`，裸正则 100 条、CSS 选择器 100 条，
 * 而走源规则时 `getElements` 只回 **1** 条（`ctor=JavaArrayList`，内容是最后一个 li 的 outerHTML）
 * ⇒ 每页只出 1 章、5 页共 5 章，用户看到「目录 0 章」（首页往往是卷头被 `isVolume` 滤掉）。
 *
 * 真因：Rhino 里 `new Packages.java.util.ArrayList()` **本身就是 `java.util.List`**，
 * 上游 `is List<*>` 直接把它当元素列表；我们的 `JavaArrayList` 是普通 class 实例
 * （`Array.isArray` 为 false），宿主既不认也不会展开。
 *
 * 判别断言（写成「同一份规则：不修时 1 条、修后 N 条」）：
 *   ① `expandJavaCollection` 对「toArray + size」的对象展开成数组，其余原样返回；
 *   ② `getElements` 走源规则形态时拿到 3 条，且每条是 li 的 outerHTML 字符串。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createHybridJsEvaluator, createJsEvaluator, createVariableStore } from '../index';
import { expandJavaCollection } from '../selector/java-bridge';

const HTML = `<html><body><ol>
<li class="BCsectionTwo-top-chapter"><a href="/b/1.html">第1章 甲</a></li>
<li class="BCsectionTwo-top-chapter"><a href="/b/2.html">第2章 乙</a></li>
<li class="BCsectionTwo-top-chapter"><a href="/b/3.html">第3章 丙</a></li>
</ol></body></html>`;

/** 源里的真实形态：new Packages.java.util.ArrayList() + add() */
const LIST_RULE =
  "@js:(function(){var h=String(result),r=/<li[^>]*class=[\"'][^\"']*BCsectionTwo-top-chapter[^\"']*[\"'][^>]*>[\\s\\S]*?<\\/li>/gi,m,o=[],out=typeof Packages!='undefined'?new Packages.java.util.ArrayList():[];while((m=r.exec(h))){o.push(m[0]);}for(var i=0;i<o.length;i++){out.add?out.add(o[i]):out.push(o[i]);}return out;})()";

function ruleOn(): AnalyzeRule {
  const variables = createVariableStore();
  const env = { baseUrl: 'https://x.test/', variables, jsEval: createJsEvaluator({ variables }) };
  return new AnalyzeRule(env).setContent(HTML, 'https://x.test/');
}

/** 与引擎同一条路径（hybrid 求值器 = 宿主真正用的那个） */
function ruleOnHybrid(): AnalyzeRule {
  const variables = createVariableStore();
  const env = { baseUrl: 'https://x.test/', variables, jsEval: createHybridJsEvaluator({ variables } as never) };
  return new AnalyzeRule(env).setContent(HTML, 'https://x.test/');
}

test('类BZ ① `expandJavaCollection`：toArray + size 的对象展开成数组', () => {
  const list = { a: ['x', 'y'], toArray: () => ['x', 'y'], size: () => 2 };
  assert.deepEqual(expandJavaCollection(list), ['x', 'y'], '集合语义的对象必须展开');
  assert.deepEqual(expandJavaCollection(['a']), ['a'], '真数组原样返回');
  assert.deepEqual(expandJavaCollection({ k: 1 }), { k: 1 }, '普通对象不得被改写');
  assert.equal(expandJavaCollection(null), null, 'null 不得抛');
  // 只有 toArray、没有 size 的不算集合（避免误伤 jsoup Elements 等其它对象）
  const onlyToArray = { toArray: () => [1, 2] };
  assert.deepEqual(expandJavaCollection(onlyToArray), onlyToArray, '缺 size 不展开');
});

test('类BZ ①b 不得误伤「字符串人格」：jsoup 包装过的字符串仍须是字符串', () => {
  /**
   * `#639` 实测回归（`#583` 七猫段评）：`analyze.ts#strWithJsoup` 把 `new String(html)` 挂上
   * jsoup 方法（含 `toArray()` / `size()`）再定义 `toString`/`Symbol.toPrimitive` 还原纯文本。
   * 一旦被当集合展开，返回值变成 `[root]` ⇒ 字符串人格失效 ⇒ `String(result)` 落回 `outerHTML`
   * ⇒ 纯文本正文被包成整页 HTML、`<img …{"style":…}>` 被序列化成 `<img …{" style=…>`。
   */
  const s = new String('<p>正文</p>') as unknown as Record<string, unknown>;
  s['toArray'] = () => [{ nodeType: 1 }];
  s['size'] = () => 1;
  Object.defineProperty(s, 'toString', { value: () => '<p>正文</p>' });
  const out = expandJavaCollection(s);
  assert.equal(typeof out, 'object', '不得变成数组');
  assert.equal(Array.isArray(out), false, '字符串人格不得被展开');
  assert.equal(String(out), '<p>正文</p>', '字符串人格必须还原纯文本');
  // jsoup 元素桥（nodeType 是数字）同理：走上游的 getElements 元素通道，不是 is List
  const el = { nodeType: 1, toArray: () => [1], size: () => 1 };
  assert.equal(expandJavaCollection(el), el, '元素桥不得被当集合展开');
});

test('类BZ ② 源规则形态：ArrayList 里的 3 个 li 必须成为 3 个元素', async () => {
  const els = await ruleOnHybrid().getElements(LIST_RULE);
  assert.equal(els.length, 3, 'ArrayList 必须逐项展开（不修时这里只回 1 条）');
  assert.match(String(els[0]), /第1章 甲/, '首个元素应是第一条 li 的 outerHTML');
  assert.match(String(els[2]), /第3章 丙/, '末个元素应是第三条 li 的 outerHTML');
});

test('类BZ ③ 反向锁：裸 createJsEvaluator（不展开的路径）保持原样，证明判据落在边界层', async () => {
  const els = await ruleOn().getElements(LIST_RULE);
  // 这条锁的是「展开加在求值器边界，而不是偷偷改 getElements」
  assert.equal(Array.isArray(els) && els.length, 1, '评价器裸路径仍是 1 条（说明差异来自边界展开）');
});
