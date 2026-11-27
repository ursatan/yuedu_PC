/**
 * `#646` jsoup `Elements.outerHtml()` 的两条语义（搬山人小说网正文实测）：
 *
 * ① **遍历全部元素拼接**（上游 `Elements.outerHtml()`：`for (Element el : this) accum.append(el.outerHtml())`）。
 *    旧实现 `list[0].outerHTML` ⇒ 整章被截成 1 段（线上：规则内部 135 段，输出 1 段 / 51 字）。
 *
 * ② **必须实时序列化**，不能读描述符快照。
 *    源规则的收尾套路是 `clean = paragraphs.clone(); clean.select('span[class*=count_]').remove();
 *    String(clean.outerHtml())` —— remove 改的是**宿主活节点**，读快照会把删掉的节点又吐回来
 *    （线上：135 段正文 + 135 个残留 `<span class="z count_N">0</span>` = 270 段）。
 *
 * ③ 连带修：`java.getElements(...)`（规则桥）返回的描述符**没有 nid**，于是后续 `select` 只能
 *    「html 字符串重新解析」⇒ 每次一棵新树 ⇒ 身份丢失 ⇒ remove 无效。
 *    现在宿主按 html 文本缓存游离树（`selectOnHtmlTree`），元素身份稳定。
 *
 * 三条都必须在**同一个用例**里断言，因为它们是同一条链路上的连续环节：
 * 只断言「段落数」会漏掉残留 0；只断言「没有 0」会漏掉整章截断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

const PAGE =
  '<html><body><div class="box">' +
  '<p>第一段<span class="z cnt">0</span></p>' +
  '<p>第二段<span class="z cnt">0</span></p>' +
  '<p>第三段<span class="z cnt">0</span></p>' +
  '</div></body></html>';

/** 线上形态：规则桥（`java.getElements`）返回的描述符**没有 nid** */
const RULE_BRIDGE_NODES = [
  { outerHTML: PAGE, innerHTML: PAGE, text: '第一段第二段第三段', attrs: {} },
];

const CODE = [
  "var doc = java.getElements('@css:html');",
  "var ps = doc.select('.box > p');",
  "var clean = ps.clone();",
  "clean.select('span.cnt').remove();",
  'String(clean.outerHtml());',
].join('\n');

test('#646 Elements.outerHtml：拼接全部 + 实时序列化（remove 后不再吐回被删节点）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    // 规则桥：模拟 `java.setContent/getElements` 的产物（无 nid 描述符）
    // 注：op='elements' 的返回就是**数组**（makeRuleBridge 的 elements 分支即如此）
    ruleBridge: async () => RULE_BRIDGE_NODES,
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  const out = String(await Promise.resolve(ev(CODE, { baseUrl: 'https://s.test' })));

  // ① 三段都在（旧实现只有「第一段」）
  assert.ok(out.includes('第一段'), `应含第一段：${out}`);
  assert.ok(out.includes('第二段'), `应含第二段（旧实现丢这段）：${out}`);
  assert.ok(out.includes('第三段'), `应含第三段（旧实现丢这段）：${out}`);
  // ② remove 生效（旧实现残留 3 个 span 与文本 0）
  assert.ok(!out.includes('cnt'), `不应残留被 remove 的 span：${out}`);
  assert.ok(!out.includes('>0<'), `不应残留计数文本 0：${out}`);

  // worker 池的收尾方法不在 `JsSandboxPool` 契约里（只有具体实现有）⇒ 显式窄化，别用 `any`
  await (pool as unknown as { dispose?: () => Promise<void> }).dispose?.();
});
