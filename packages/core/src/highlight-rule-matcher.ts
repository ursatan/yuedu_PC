/**
 * 高亮规则**渲染期匹配器** —— `#262`，移植上游 `help/HighlightRuleMatcher.kt`。
 *
 * ⚠️ **浏览器侧必须从 `@yuedu/core/highlight-rule-matcher` 深路径导入**（package.json exports
 * 有这条）：core 的**根出口**连着 `user-store`（node:sqlite / node:path），
 * 从根导入会把 node 内置模块拖进浏览器 bundle（vite externalize ⇒ build 直接失败，#262 实测）。
 *
 * ## 语义（逐条对齐上游 `matchDetailed`，`HighlightRuleMatcher.kt:38-66`）
 * - 输入整段文本 + 规则集；每条规则独立匹配（literal `indexOf` / regex 全局循环）；
 * - **titleEnd 分段**：`applyToTitle` 只匹配 `[0, titleEnd)`，`applyToBody` 只匹配
 *   `[titleEnd, len)`；两者都开 = 全文（`matchSegment(0, text.length)`）。
 *   上游的文本是「标题+正文」拼接、`titleLength` 是布局标题长度；**本仓正文偏移不含标题**
 *   （标题是独立 DOM 元素，见 `apps/web/src/utils/chapter-text.ts` 顶部）⇒ 调用方对正文传
 *   `titleEnd: 0`（text 里本来就没有标题），标题匹配单独对标题字符串调一次。
 * - `maxMatches` 上限（上游 `DEFAULT_MAX_MATCHES = 10_000`）：达到即停（completed=false），
 *   上游对未完成的匹配**整批丢弃**（`ReadBook.kt:292-296`：completed 才采用）—— 本仓同样
 *   只在 `completed=true` 时采用结果，防半截匹配导致画面闪烁。
 * - 每条规则是**独立超时**（`timeoutMillisecond`）；正则编译失败 = 跳过该规则继续
 *   （上游 `catch → return true`），运行中超时 = 该规则未完成（`return false`）。
 *
 * ## ★ 与上游的固有限制差异（如实说明，不装相等）
 * Java 版用 `DeadlineCharSequence` 在**每个字符访问**时查超时 ⇒ 单次灾难性回溯也会被打断；
 * JS 的 `RegExp.exec` **没有中断点**，只能在**两次 exec 之间**检查时间 —— 单次 exec 内部的
 * 灾难性回溯（指数级）会卡住事件循环直到它自然结束。缓解：
 * ① 保存时用 `highlightRuleIsValid` 拦掉编译不过的；② 匹配放在 Web 阅读器侧按章执行，
 * 章文本通常几十 KB，正常规则远达不到上限；③ 超时仍在（拦住「多条规则 × 多次 exec」的累积）。
 */

/** 参与匹配的最小规则形状（渲染侧从 `HighlightRule` 挑字段构造） */
export interface HighlightRuleMatchInput {
  /** 规则 id（回填进每个命中，调用方用它反查样式） */
  id: number;
  pattern: string;
  isRegex: boolean;
  /** 正则超时毫秒（仅 isRegex 生效） */
  timeoutMillisecond: number;
  applyToTitle: boolean;
  applyToBody: boolean;
}

/** 一个命中区间（整段文本坐标，`[start, end)` 闭开） */
export interface HighlightRuleMatch {
  start: number;
  end: number;
  /** 命中它的规则 id（同一条规则的多个命中共享 id） */
  ruleId: number;
}

export interface HighlightRuleMatchResult {
  matches: HighlightRuleMatch[];
  /**
   * 是否完整跑完：false = 达到 maxMatches / 超时 / 取消。
   * ★ 上游语义：**未完成的结果整批丢弃**（不采用），调用方应照做。
   */
  completed: boolean;
}

/** 上游 `DEFAULT_MAX_MATCHES`（`HighlightRuleMatcher.kt:206`） */
export const HIGHLIGHT_RULE_MAX_MATCHES = 10_000;

/**
 * 对一段文本执行全部规则。
 *
 * @param text      被匹配的文本（正文整章或标题字符串）
 * @param rules     已过 `highlightRuleAppliesToBook` / `isEnabled` 筛选的规则
 * @param titleEnd  标题段终点（本仓正文调用传 0；标题字符串传其长度）
 * @param opts      maxMatches 上限、shouldContinue 取消回调、now 时钟（测试注入）
 */
export function matchHighlightRules(
  text: string,
  rules: readonly HighlightRuleMatchInput[],
  titleEnd = 0,
  opts: {
    maxMatches?: number;
    shouldContinue?: () => boolean;
    now?: () => number;
  } = {},
): HighlightRuleMatchResult {
  const limit = Math.max(0, opts.maxMatches ?? HIGHLIGHT_RULE_MAX_MATCHES);
  const shouldContinue = opts.shouldContinue ?? ((): boolean => true);
  const now = opts.now ?? Date.now;
  if (!text || rules.length === 0 || limit === 0) {
    return { matches: [], completed: true };
  }
  const matches: HighlightRuleMatch[] = [];
  for (const rule of rules) {
    if (!shouldContinue()) return { matches, completed: false };
    if (!rule.pattern || (!rule.applyToTitle && !rule.applyToBody)) continue;
    const ok = rule.isRegex
      ? matchRegex(text, titleEnd, rule, matches, shouldContinue, limit, now)
      : matchLiteral(text, titleEnd, rule, matches, limit);
    if (!ok) return { matches, completed: false };
  }
  return { matches, completed: true };
}

/** 字面量匹配（对齐 `matchLiteral`，`:68-95`）：indexOf 循环，逐命中推进 */
function matchLiteral(
  text: string,
  titleEnd: number,
  rule: HighlightRuleMatchInput,
  out: HighlightRuleMatch[],
  maxMatches: number,
): boolean {
  const seg = (from: number, to: number): boolean => {
    if (from >= to) return true;
    let idx = text.indexOf(rule.pattern, from);
    while (idx >= 0 && idx < to) {
      if (out.length >= maxMatches) return false;
      const end = idx + rule.pattern.length;
      out.push({ start: idx, end, ruleId: rule.id });
      idx = text.indexOf(rule.pattern, end);
    }
    return true;
  };
  // 两段都开 = 全文一条（上游 `matchSegment(0, text.length)`；不重复匹配交界）
  if (rule.applyToTitle && rule.applyToBody) return seg(0, text.length);
  if (rule.applyToTitle && !seg(0, Math.min(titleEnd, text.length))) return false;
  return !rule.applyToBody || seg(Math.min(titleEnd, text.length), text.length);
}

/** 正则匹配（对齐 `matchRegex`，`:97-154`）：全局 exec 循环 + **exec 间**超时检查 */
function matchRegex(
  text: string,
  titleEnd: number,
  rule: HighlightRuleMatchInput,
  out: HighlightRuleMatch[],
  shouldContinue: () => boolean,
  maxMatches: number,
  now: () => number,
): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(rule.pattern, 'g');
  } catch {
    return true; // 编译失败 = 跳过该规则（对齐上游 catch → return true）
  }
  const timeoutMs = Math.max(1, rule.timeoutMillisecond);
  const startedAt = now();
  const timedOut = (): boolean => now() - startedAt > timeoutMs;
  const seg = (from: number, to: number): boolean => {
    if (from >= to) return true;
    // 只对 `[0, to)` 匹配：slice 一次（起点 0 ⇒ m.index 与原 text 偏移一致），
    // 避免每次 exec 都复制字符串。标题段（to < len）之外的区域不会被碰。
    const scoped = to < text.length ? text.slice(0, to) : text;
    regex.lastIndex = from;
    for (;;) {
      let m: RegExpExecArray | null;
      try {
        m = regex.exec(scoped);
      } catch {
        return false; // 运行中异常（如灾难性回溯溢出）⇒ 未完成（对齐上游 catch Exception）
      }
      if (m === null) return true;
      const start = m.index;
      const end = start + m[0].length;
      if (end > start && out.length < maxMatches) {
        out.push({ start, end, ruleId: rule.id });
      }
      if (out.length >= maxMatches) return false;
      if (!shouldContinue() || timedOut()) return false;
      if (m[0].length === 0) {
        // 空匹配（如 `a*`）：强制前进一格，否则 exec 死循环
        regex.lastIndex = m.index + 1;
        if (regex.lastIndex > scoped.length) return true;
      }
    }
  };
  if (rule.applyToTitle && rule.applyToBody) return seg(0, text.length);
  if (rule.applyToTitle && !seg(0, Math.min(titleEnd, text.length))) return false;
  return !rule.applyToBody || seg(Math.min(titleEnd, text.length), text.length);
}
