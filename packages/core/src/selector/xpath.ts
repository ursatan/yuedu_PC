/**
 * XPath 选择器后端（对齐 Legado AnalyzeByXPath.kt）
 *
 * 使用 jsdom 的 document.evaluate（XPath 1.0）。
 * 组合符 && || %% 在 splitRule 后逐段处理（§5.4）。
 */

import { splitCombinator } from './rule-analyzer';
import type { AnalyzeEnv } from './types';

function nodeToString(node: Node): string {
  if (node.nodeType === 2 /* ATTRIBUTE */) return (node as Attr).value;
  if (node.nodeType === 3 /* TEXT */) return (node.textContent ?? '').trim();
  if (node.nodeType === 1 /* ELEMENT */) return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
  return (node.textContent ?? '').trim();
}

/**
 * `#640` **前导 `//` 相对化**（`//x` → `.//x`）。
 *
 * ## 上游语义（`#640` 用户实测「八叉书库列表标题全串在一起」）
 * 上游 `AnalyzeByXPath.getResult` 是 `jxNode.sel(xPath)` —— JsoupXpath 的 `JXNode.sel`
 * 把路径**从该节点出发**求值，所以条目子规则里写 `//div[@class='caption']/a/@title`
 * 取的是**该条目内部**的 caption（Legado 语料里这就是主流写法：482 源里大量条目规则
 * 以 `//` 开头）。
 *
 * ## 我们此前的问题
 * `document.evaluate(rule, root, …)` 按 DOM XPath 1.0 规范：**前导 `//` 是绝对路径**
 * （从文档根开始），context node 不参与。于是「20 个条目的标题规则」每条都拿到
 * 全部 20 个标题并 `join('\n')` ⇒ 列表每一项的标题都是「整页所有标题拼起来」。
 *
 * ## 为什么可以无条件加 `.`
 * 首层规则（bookList 之类）的 root 是**文档/根元素**，而 `.//x` 与 `//x` 在文档节点上
 * **结果完全相同**（都是自下而上全部后代）⇒ 加上 `.` 对首层零影响，只修子规则。
 * 相对路径（`.` / `./` / `(` 开头）与绝对路径（`/html`）不动。
 */
function relativeXPath(rule: string): string {
  const t = rule.trim();
  return t.startsWith('//') ? `.${t}` : t;
}

/**
 * `#687` **严格按 XPath 1.0 求值，不做语法上的「宽容兼容」**。
 *
 * `@` 后面只能跟**属性名**（`@href` ≡ `attribute::href`），不能跟路径或关键字 ——
 * 所以 `//a@text`、`//div[@class='x']/@style` 之类在标准 XPath 里就是语法错。
 * `#686` 一度把 `@text` / `@html` 尾缀当成 jsoup 风格来自动兼容，`#687` 按用户要求**撤回**：
 *
 *   · 标准写法是 `/text()`（取文本）与 `/@href`（取属性）；
 *   · `@text` / `@href` 尾缀是 **jsoup/CSS 侧**的语法，两套各管一段，串味只会让人写错还以为对；
 *   · 静默兼容「写错的 XPath」= 把错误变成能跑（同 `#685` 的教训），不值得。
 *
 * 但报错要能直接照做：`xpath` 库原文 `Unparsed tokens: @ text` 看不出该改哪里，
 * 这里在求值前识别这个形态并给出改法。
 */
function assertStandardXpath(rule: string): void {
  const m = /([^/])@([A-Za-z_][\w-]*)$/.exec(rule.trim());
  if (!m) return;
  const tail = m[2] as string;
  const isKeyword = /^(text|textNodes|ownText|html|all)$/.test(tail);
  const fix = isKeyword ? '取文本要写 `/text()`' : `取属性要写 \`/@${tail}\``;
  throw new Error(
    `XPath 语法错：末段「@${tail}」不是合法 XPath —— XPath 里 \`@\` 后面只能跟属性名（如 \`@href\`），${fix}。`
    + `若你本意是 jsoup/CSS 语法，去掉开头的 \`//\`（或改用 \`@css:\` 前缀），那边才有 \`@${tail}\` 这种尾缀。`,
  );
}

function evalSnapshot(rule: string, root: Node): Node[] {
  assertStandardXpath(rule);
  const doc = root.ownerDocument ?? (root as Document);
  const result = doc.evaluate(
    relativeXPath(rule),
    root,
    null,
    // ORDERED_NODE_SNAPSHOT_TYPE
    7,
    null,
  );
  const out: Node[] = [];
  for (let i = 0; i < result.snapshotLength; i++) {
    const n = result.snapshotItem(i);
    if (n) out.push(n);
  }
  return out;
}

function combineStrings(lists: string[][], type: string): string[] {
  if (type === '%%' && lists.length) {
    const out: string[] = [];
    const max = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i] as string);
    return out;
  }
  return lists.flat();
}

export function xpathGetElements(rule: string, roots: Element[], _env: AnalyzeEnv): Element[] {
  const { parts, type } = splitCombinator(rule);
  const lists: Element[][] = [];
  for (const part of parts) {
    if (!part) continue;
    const els = roots.flatMap((r) =>
      evalSnapshot(part, r).filter((n) => n.nodeType === 1) as Element[],
    );
    if (els.length) {
      lists.push(els);
      if (type === '||') break;
    }
  }
  if (type === '%%' && lists.length) {
    const out: Element[] = [];
    const max = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i] as Element);
    return out;
  }
  return lists.flat();
}

export function xpathGetStringList(rule: string, roots: Element[], _env: AnalyzeEnv): string[] {
  const { parts, type } = splitCombinator(rule);
  const results: string[][] = [];
  for (const part of parts) {
    if (!part) continue;
    const strs = roots.flatMap((r) => evalSnapshot(part, r).map(nodeToString).filter(Boolean));
    if (strs.length) {
      results.push(strs);
      if (type === '||') break;
    }
  }
  return combineStrings(results, type);
}

export function xpathGetString(rule: string, roots: Element[], env: AnalyzeEnv, isUrl = false): string {
  const list = xpathGetStringList(rule, roots, env);
  if (list.length === 0) return '';
  if (isUrl) {
    const first = list.find((s) => s.trim() !== '');
    return env.toAbsolute ? env.toAbsolute(first ?? '') : first ?? '';
  }
  return list.length === 1 ? list[0] as string : list.join('\n');
}
