/**
 * 正则选择器后端（对齐 Legado AnalyzeByRegex.kt）
 *
 * 关键语义（源码）：
 *   - 规则按 && 分成多级正则，逐级串联：前一级把所有匹配拼起来喂给下一级。
 *   - 最后一级：
 *       · `getElements`（`AnalyzeByRegex.kt:39-51`）**每个匹配**返回一组捕获组 0..n；
 *       · `getElement`（`:16-22`）只取**首个匹配**的捕获组 0..n。
 *     ⇒ 两条路径必须分开，不能共用「只取首个匹配」的实现（否则列表恒 1 条）。
 *   - 正则模式只支持 && 链式（源码无 || / %% 处理，与 CSS/XPath 不同）。
 */

import type { AnalyzeEnv } from './types';

/**
 * 把 Kotlin 风格正则转成 JS 可编译的正则（R3：语法差异）。
 * 一期仅处理最高频的几个，其余原样交给 RegExp（待回归集补全）。
 */
export function compileKotlinRegex(pattern: string): RegExp {
  let p = pattern;
  let flags = '';
  // 行内标志 (?<flags>) 提到 RegExp flag
  const inline = p.match(/\(\?([imsxU]*)\)/);
  if (inline) {
    if (inline[1]?.includes('i')) flags += 'i';
    if (inline[1]?.includes('s')) flags += 's'; // DOTALL
    if (inline[1]?.includes('m')) flags += 'm';
    p = p.replace(inline[0], '');
  }
  // \R 任意换行
  p = p.replace(/\\R/g, '[\\r\\n]');
  return new RegExp(p, flags);
}

/**
 * 共用的逐级抽取（唯一实现，避免「单值/列表」两条路径各自漂移）。
 *
 * `all=false` ⇒ 末级只取首个匹配（上游 `getElement`）；
 * `all=true`  ⇒ 末级收集每一个匹配（上游 `getElements` 的 `do { … } while (find())`）。
 */
function regexGroups(rule: string, text: string, all: boolean): string[][] {
  const parts = rule.split('&&').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  let cur = text;
  for (let i = 0; i < parts.length; i++) {
    const re = compileKotlinRegex(parts[i] as string);
    const m = re.exec(cur);
    if (!m) return [];
    if (i === parts.length - 1) {
      if (!all) {
        const groups: string[] = [];
        for (let g = 0; g <= m.length - 1; g++) groups.push(m[g] ?? '');
        return [groups];
      }
      // 末级（列表）：收集**每一个**匹配的捕获组 0..n（捕获组 0 即整段匹配，与上游一致）
      const out: string[][] = [];
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let mm: RegExpExecArray | null;
      while ((mm = g.exec(cur))) {
        const groups: string[] = [];
        for (let k = 0; k <= mm.length - 1; k++) groups.push(mm[k] ?? '');
        out.push(groups);
        // 空匹配：Kotlin `find()` 会前进一格，JS `exec` 不会 ⇒ 手动前进防死循环
        if (mm[0] === '') g.lastIndex++;
      }
      return out;
    }
    // 中间级：拼接所有整匹配（上游 `do { append(group()) } while (find())`）
    let acc = '';
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let mm: RegExpExecArray | null;
    while ((mm = g.exec(cur))) {
      acc += mm[0];
      // 同上：空匹配必须手动前进，否则死循环
      if (mm[0] === '') g.lastIndex++;
    }
    cur = acc;
  }
  return [];
}

/** 取「元素列表」：**每条匹配**一组捕获组（string[][]），对齐 `AnalyzeByRegex.getElements` */
export function regexGetElements(rule: string, text: string): string[][] {
  return regexGroups(rule, text, true);
}

/** 取「单个元素」：只取**首个匹配**的捕获组，对齐 `AnalyzeByRegex.getElement` */
export function regexGetElement(rule: string, text: string): string[][] {
  return regexGroups(rule, text, false);
}

/** 取单个字符串：返回最后一级首个匹配的捕获组拼接，对齐 getElement 后 toString */
export function regexGetString(rule: string, text: string, _env: AnalyzeEnv, isUrl = false): string {
  const joined = (regexGetElement(rule, text)[0] ?? []).join('');
  if (isUrl && _env.toAbsolute) return _env.toAbsolute(joined);
  return joined;
}
