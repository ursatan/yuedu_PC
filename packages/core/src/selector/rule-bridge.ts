/**
 * 规则桥（`java.setContent / getElements / getElement / getStringList`）的**唯一实现**。
 *
 * ## 为什么放在 core（2026-10-07，`#313`）
 * 这段逻辑此前在**三处**各写一遍：
 *   · `@yuedu/engine-legado` 的 `engine.ts`（内联 `ruleBridge` + 本地 `describeRuleNode`）
 *   · `@yuedu/engine-rss` 的 `env.ts`（同上，两份 `describeRuleNode` **逐字相同**）
 *   · `@yuedu/core` 的测试桩 `java-rule-bridge.test.ts`
 * 于是它们**已经漂移**：`#313` 给桥加了第三个 op（`'object'`）时，
 * 三处的参数类型立刻对不上（typecheck 直接报 `Type '"object"' is not assignable`）。
 * 这就是「同一判据写两处必然漂移」的实例 —— 收敛到一处才是解法。
 *
 * ## 上游语义（`AnalyzeRule.kt:384-414`，逐行核实）
 * ```
 * Mode.Json   -> ...getObject(rule)      // 原值：对象/标量/数组都算命中
 * Mode.Regex  -> AnalyzeByRegex.getElement(...)   // 单值
 * Mode.Js     -> evalJS(rule, result)             // 单值（脚本返回数组就是数组）
 * Mode.XPath  -> ...getElements(rule)    // ★ 整个列表
 * else (Css)  -> ...getElements(rule)    // ★ 整个列表
 * ```
 * ⇒ 只能靠 `AnalyzeRule.getElementTyped()` 的 `list` 标记分流：
 *   · `list === true`  → 发**节点描述符数组**，worker 侧重建「带 jsoup 方法的活列表」；
 *   · `list === false` → 发**纯 JSON 值**（worker 侧用 `__yueduAttachJsonMap` 挂 Java Map/List 方法）。
 * ★ 必须显式带 `kind`：**「Css 的元素列表」与「Json 的数组」在 JSON 里长得一模一样**。
 */
import { AnalyzeRule } from './analyze';
import type { AnalyzeEnv } from './types';
import type { RuleBridgeResult, RuleNodeDescriptor } from './js';

/**
 * DOM 节点 → worker 可序列化的描述符（worker 侧用 `__yueduJsoup().list()` 重建活列表）。
 * 非节点值退化成「三字段同值」的描述符（保持旧行为，别改：worker 侧仍有依赖它的路径）。
 */
export function describeRuleNode(n: unknown): RuleNodeDescriptor {
  const attrs: Record<string, string> = {};
  if (n && typeof n === 'object' && 'outerHTML' in (n as Record<string, unknown>)) {
    const el = n as unknown as {
      outerHTML?: string;
      innerHTML?: string;
      textContent?: string;
      tagName?: string;
      attributes?: ArrayLike<{ name?: string; value?: string }>;
    };
    const list = el.attributes;
    if (list) {
      for (let i = 0; i < list.length; i += 1) {
        const a = list[i];
        if (a?.name) attrs[String(a.name)] = String(a.value ?? '');
      }
    }
    attrs['tagName'] = String(el.tagName ?? '').toLowerCase();
    return {
      outerHTML: String(el.outerHTML ?? ''),
      innerHTML: String(el.innerHTML ?? ''),
      text: String(el.textContent ?? ''),
      attrs,
    };
  }
  const s = n == null ? '' : typeof n === 'object' ? JSON.stringify(n) : String(n);
  return { outerHTML: s, innerHTML: s, text: s, attrs: {} };
}

/** 是否是「像 DOM 节点」的值（Js 段可能返回元素，也要序列化） */
function looksLikeNode(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'outerHTML' in (v as Record<string, unknown>);
}

export interface RuleBridgeDeps {
  /** 取当前请求的 `AnalyzeEnv`（引擎侧持有 `envRef`，每请求会换）；返回 undefined ⇒ 空结果 */
  env: () => AnalyzeEnv | undefined;
  /** 本次求值的 baseUrl（与 `new AnalyzeRule(env).setContent(content, baseUrl)` 一致；可缺省） */
  baseUrl?: string;
  /** 求值失败时的留痕（**兜底必须留痕**：静默兜底会让问题反复出现） */
  warn?: (msg: string) => void;
}

/**
 * 造一个规则桥（引擎在 `makeEnv` 里把它塞进求值器的 `ruleBridge` 选项）。
 */
export function makeRuleBridge(
  deps: RuleBridgeDeps,
): (op: 'elements' | 'strings' | 'object', rule: string, content: string) => Promise<RuleBridgeResult> {
  return async (op, ruleStr, content) => {
    const empty = (): RuleBridgeResult => (op === 'object' ? { kind: 'value', value: null } : []);
    const e = deps.env();
    if (!e) return empty();
    try {
      const ar = new AnalyzeRule(e).setContent(content, deps.baseUrl);
      if (op === 'strings') return await ar.getStringList(ruleStr);
      if (op === 'object') {
        const { list, value } = await ar.getElementTyped(ruleStr);
        if (list) {
          const arr = Array.isArray(value) ? value : [];
          return { kind: 'nodes', list: arr.filter((x) => x != null).map(describeRuleNode) };
        }
        if (looksLikeNode(value)) return { kind: 'nodes', list: [describeRuleNode(value)] };
        // 纯 JSON 值：**不要**在这里挂 Map 方法 —— 宿主侧挂的是非枚举属性、过不了 structuredClone，
        // worker 侧会用 `__yueduAttachJsonMap`（与宿主 `attachJsonMapMethods` 同一份源码）再挂一次。
        return { kind: 'value', value: value === undefined ? null : value };
      }
      const els = (await ar.getElements(ruleStr)) as unknown[];
      const arr = Array.isArray(els) ? els : [els];
      const items = arr.filter((x) => x != null);
      /**
       * ★ `#406` **Json 段的 `$.…[*]` ⇒ 按纯值下发**（不能包成节点描述符）。
       *
       * 判据：元素**全都不是** DOM 节点（没有 `outerHTML`）⇒ 这是 JSON 对象/标量列表。
       * 若仍走 `describeRuleNode`，两重后果（实测 🎨快看漫画「详情通了但目录 0 章」）：
       *   ① 元素被压成 `{outerHTML: JSON.stringify(x), …}` ⇒ worker 侧与宿主侧
       *      都取不到 `$.title`（字段藏在 JSON 串里）；
       *   ② 描述符元素带**可枚举函数**（worker `mkList` 挂的 html/text/attr…）⇒
       *      `structuredClone` 失败 ⇒ `__yueduSendable` 退化为 `String(v)` ⇒ 整表 join 成
       *      **1 个字符串** ⇒ 宿主 `getElements` 恒 1 个元素。
       * L1 的 `java.getElements` 给的**就是**这些 JSON 对象本身（`getElementsInner` 的
       * `Array.isArray(val)` 分支保留原值）⇒ 此处按纯值下发才是「两侧逐字等价」。
       */
      if (items.length && !items.some((x) => looksLikeNode(x))) return { kind: 'values', list: items };
      return items.map(describeRuleNode);
    } catch (err) {
      deps.warn?.(
        `规则桥求值失败（java.${op === 'strings' ? 'getStringList' : op === 'object' ? 'getElement' : 'getElements'}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return empty();
    }
  };
}
