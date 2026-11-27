/**
 * `#542` **可执行规则 lint 表**（P2-c）。
 *
 * 背景（P2 四刀之 c）：`#521` 源医生把 729 源分成「语法错 28 / 缺字段 / 未实现 API / L1 强留」，
 * 但那是**按源计数**；要「修」就需要**按缺陷**给出可执行的判定 + 修法。本模块把
 * `开源阅读助手` 的三份材料（`书源规则：从入门到入土` / `书源输出模板_严格模式` /
 * `Legado书源开发_长记忆系统`）里**可静态判定**的坑，抽成一张数据驱动的表：
 * 每条规则 = id + 严重级 + 作用域 + 判据 + 修法（能自动修的带 `fix`）。
 *
 * 纪律：
 *  · **只判「整串就是 JS」的形态**（`<js>…</js>` / 整字段 `@js:`），中缀 `@js:` 不编译
 *    —— 否则 68 个正常源会被报假语法错（`#521` 实测）。
 *  · **逐字段、逐字符串**处理，绝不 `JSON.stringify` 整个规则对象（`#521` 的 443 个误报）。
 *  · 语法判定用 `new Function`（函数体语义），`vm.Script` 只取行号（顶层 `return` 合法）。
 *  · 编译前把 `{{…}}` 替换成 `x`（占位符里常有双引号）。
 *  · 误报比漏报更糟 ⇒ 拿不准的一律 `info`，能自动修的才给 `fix`。
 */

import { needsJavaBridgeL1 } from '../selector/java-bridge';

export type LintSeverity = 'error' | 'warn' | 'info';
export type SourceKind = 'legado' | 'rss' | 'vod';

export interface LintFix {
  /** 出问题的字段路径（如 `ruleToc.chapterList`） */
  field: string;
  /** 精确替换（只做**字节级**替换，不做语义重写） */
  search: string;
  replace: string;
  /** 该字段里可能多处出现（如零宽字符）⇒ 应用时必须**全局替换**，否则只修第一处 */
  all?: boolean;
}

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  /** 字段路径（`jsLib` / `ruleToc.chapterList` / `searchUrl` …） */
  field: string;
  message: string;
  /** 定位辅助：行号 / 片段（尽力而为） */
  line?: number;
  snippet?: string;
  /** 可自动修的补丁（有则 `--fix-plan` 会收） */
  fix?: LintFix;
}

export interface LintRule {
  id: string;
  title: string;
  severity: LintSeverity;
  /** 作用域：js（只对可编译 JS 片段）/ text（对字段文本）/ list（列表字段）/ source（整源） */
  scope: 'js' | 'text' | 'list' | 'source';
  /** 修法说明（人审用） */
  hint: string;
}

/** 参与诊断的字段（与 `scripts/source-doctor.mts` 同一份口径） */
export const LINT_FIELDS = [
  'ruleSearch',
  'ruleBookInfo',
  'ruleToc',
  'ruleContent',
  'ruleExplore',
  'ruleReview',
  'searchUrl',
  'exploreUrl',
  'jsLib',
  'loginCheckJs',
] as const;

const RULE_ATTRS = ['text', 'textNodes', 'ownText', 'html', 'all', 'href', 'src', 'attr'];

/** 递归收集字符串叶子（不 JSON.stringify 对象） */
export function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    if (v) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out);
    return;
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out);
  }
}

/** 带路径的字符串叶子（`ruleToc.chapterList` 这种） */
export function collectStringLeaves(v: unknown, prefix: string, out: Array<{ field: string; text: string }>): void {
  if (typeof v === 'string') {
    if (v.trim()) out.push({ field: prefix, text: v });
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectStringLeaves(x, `${prefix}[${i}]`, out));
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      collectStringLeaves(x, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

/** 从单个规则串抽「整串就是 JS」的片段（中缀 `@js:` 不算） */
export function jsChunksOf(one: string): string[] {
  const out: string[] = [];
  for (const m of one.matchAll(/<js>([\s\S]*?)<\/js>/g)) out.push(m[1] ?? '');
  const whole = one.trim();
  if (whole.startsWith('@js:') && !whole.includes('##')) out.push(whole.slice(4));
  return out.filter((s) => s.trim().length > 0);
}

/** 编译判定：`new Function`（函数体语义）+ 行号 + 消息 */
export function jsCompileError(code: string): { message: string; line?: number } | null {
  const src = code.trim().replace(/\{\{[\s\S]*?\}\}/g, 'x');
  if (!src) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(src);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 行号：用栈里的 <anonymous>:N（`new Function` 的栈不总带行号，取不到就省略）
    const m = /<anonymous>:(\d+):\d+/.exec(String(e instanceof Error ? (e.stack ?? '') : ''));
    return { message: msg, ...(m ? { line: Math.max(1, Number(m[1]) - 2) } : {}) };
  }
}

/** 不可见字符（零宽空格/连接符/BOM）—— 实测会导致 `Invalid or unexpected token` */
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

/** 非重叠计数（`{{` / `}}` 用） */
function countOf(s: string, sub: string): number {
  return s.split(sub).length - 1;
}
/**
 * 逐规则串的检查（scope = text / list）。
 * 返回 [] = 没问题。
 */
function checkRuleText(field: string, text: string): LintFinding[] {
  const out: LintFinding[] = [];
  const isPureJs = text.trim().startsWith('@js:');

  // L003 `@js:` 只能放最后（材料：`@js:` 只能放在其他规则的最后使用）
  // ⚠️ 只判「字段**以** `@attr`/`@css:` 结尾」这一种明确形态：
  //    `@js:` 之后接 `##pattern` 合法（正则清洗）；JS 正文里出现 `@text` 字样也是合法的（字符串/正则）
  if (!isPureJs) {
    const i = text.indexOf('@js:');
    if (i >= 0) {
      const after = text.slice(i + 4);
      const endsWithAttr = new RegExp(`@(?:${RULE_ATTRS.join('|')}|css)\\s*$`);
      if (endsWithAttr.test(after)) {
        out.push({
          ruleId: 'L003',
          severity: 'warn',
          field,
          message: '`@js:` 之后还有选择器/正则后缀（`@js:` 只能作为最后一段）',
          snippet: text.slice(Math.max(0, i - 20), i + 60),
        });
      }
    }
  }

  // L006 模板占位符未闭合（`{{` 多于 `}}`）——⚠️ 纯 JS 串跳过：那是 JS 的大括号
  if (isPureJs) return out;
  const open = countOf(text, '{{');
  const close = countOf(text, '}}');
  if (open > close) {
    out.push({
      ruleId: 'L006',
      severity: 'warn',
      field,
      message: `\`{{\` ${open} 个 / \`}}\` ${close} 个 ⇒ 占位符缺闭合`,
      snippet: text.slice(0, 80),
    });
  }

  // L007 POST body 必须是 String 形态（材料：`body` 必须保证是 JS 的 String 类型）
  if (/"method"\s*:\s*"POST"/i.test(text) || /'method'\s*:\s*'POST'/i.test(text)) {
    const m = /"body"\s*:\s*([^,}]+)/i.exec(text);
    const v = m?.[1]?.trim() ?? '';
    const looksString =
      !v ||
      /^["']/.test(v) ||
      /^String\s*\(/.test(v) ||
      /^JSON\.stringify\s*\(/.test(v) ||
      /^encodeURIComponent\s*\(/.test(v) ||
      /^`/.test(v) ||
      /^[A-Za-z_$][\w$.]*$/.test(v); // 变量（作者已算好）
    if (m && !looksString) {
      out.push({
        ruleId: 'L007',
        severity: 'warn',
        field,
        message: 'POST 的 `body` 不是 String 形态（对象/数字字面量）⇒ 站点会收到 `[object Object]`',
        snippet: `"body": ${v.slice(0, 60)}`,
      });
    }
  }

  return out;
}

/**
 * 路由/入口类检查（L010 / L011）—— 与引擎**同一实现**（`needsJavaBridgeL1`），不复制判据。
 * `#526`/`#538`/`#540` 之后 okhttp3/JavaImporter/Bitmap 都已落地，旧的静态「未实现 API」名单已过期 ⇒
 * 这里只报「仍会强留 L1」这一件**有性能含义**的事实（同步阻塞 = 并发下的 stall 家族）。
 */
function checkRouting(raw: Record<string, unknown>): LintFinding[] {
  const out: LintFinding[] = [];
  const lib = String(raw['jsLib'] ?? '');
  const rules: string[] = [];
  collectStrings(raw['ruleSearch'], rules);
  collectStrings(raw['ruleExplore'], rules);
  collectStrings(raw['ruleBookInfo'], rules);
  collectStrings(raw['ruleToc'], rules);
  collectStrings(raw['ruleContent'], rules);
  collectStrings(raw['searchUrl'], rules);
  collectStrings(raw['exploreUrl'], rules);
  const blob = lib + '\n' + rules.join('\n');
  if (blob.trim() && needsJavaBridgeL1(blob)) {
    out.push({
      ruleId: 'L010',
      severity: 'info',
      field: 'jsLib/规则',
      message: '求值会被强留 L1（同步 HTTP/同步 JS 阻塞主线程；并发时是 stall 家族）',
    });
  }
  const searchUrl = String(raw['searchUrl'] ?? '').trim();
  if (searchUrl && searchUrl.startsWith('http') && !/\{\{[\s\S]*?\}\}|\$\{/.test(searchUrl) && !/method["']?\s*:\s*["']POST/i.test(searchUrl)) {
    out.push({
      ruleId: 'L011',
      severity: 'info',
      field: 'searchUrl',
      message: '`searchUrl` 没有关键词占位符（疑似写死），搜索将恒返同一批结果',
    });
  }
  return out;
}

/**
 * 列表字段的检查（`bookList` / `chapterList`）。
 * 材料：列表规则给「元素集合」，不应以属性读取结尾（`@text`/`@href`…）。
 * ⚠️ `@css:` 前缀是合法的（`@css:tag.a`），不算。
 */
function checkListRule(field: string, text: string): LintFinding[] {
  const out: LintFinding[] = [];
  if (!text.trim() || /^\s*@js:/.test(text) || text.includes('<js>') || text.includes('{{')) return out;
  const m = new RegExp(`@(?:${RULE_ATTRS.join('|')})\\s*$`).exec(text.trim());
  if (m) {
    out.push({
      ruleId: 'L004',
      severity: 'warn',
      field,
      message: `列表规则以属性读取结尾（\`${m[0].trim()}\`）⇒ 拿到的不是元素集合（应为选择器 / \`@css:\`）`,
      snippet: text.slice(0, 80),
    });
  }
  return out;
}

/** JS 片段的检查（可编译性 + 已知语法坑 + 不可见字符） */
function checkJsChunk(field: string, chunk: string): LintFinding[] {
  const out: LintFinding[] = [];
  // L002 不可见字符（零宽空格/BOM）—— 修法：删掉（能精确替换 ⇒ 给 fix）
  const zw = chunk.match(ZERO_WIDTH_RE);
  if (zw) {
    out.push({
      ruleId: 'L002',
      severity: 'error',
      field,
      message: `JS 片段含 ${zw.length} 个不可见字符（零宽空格/连接符/BOM）⇒ \`Invalid or unexpected token\``,
      fix: { field, search: zw[0], replace: '', all: true },
    });
  }
  // L001 解构参数缺括号：`.map([a,b]=>`（28 条语法错里最常见的形态）
  const destr = /\.(map|forEach|filter|some|every|find|findIndex|flatMap|sort)\(\s*\[(\w+\s*,\s*\w+)\]\s*=>/g;
  let m: RegExpExecArray | null;
  while ((m = destr.exec(chunk)) !== null) {
    out.push({
      ruleId: 'L001',
      severity: 'error',
      field,
      message: `\`${m[1]}([${m[2]}]=>\` 解构参数缺括号 ⇒ 应为 \`${m[1]}(([${m[2]}])=>\``,
      fix: { field, search: m[0], replace: `.${m[1]}(([${m[2]}])=>` },
    });
  }
  // L008 JS 语法错兜底（new Function 编译）
  const err = jsCompileError(chunk);
  if (err) {
    const lineText = err.line ? chunk.split('\n')[err.line - 1]?.trim() ?? '' : '';
    out.push({
      ruleId: 'L008',
      severity: 'error',
      field,
      ...(err.line ? { line: err.line } : {}),
      message: `JS 语法错：${err.message}`,
      snippet: lineText.slice(0, 110) || chunk.slice(0, 110),
    });
  }
  return out;
}

/** 必填字段（严格模式；按源类型给不同级别：rss/vod 不套书源模板） */
function checkRequiredFields(raw: Record<string, unknown>, kind: SourceKind): LintFinding[] {
  if (kind !== 'legado') return [];
  const out: LintFinding[] = [];
  const push = (field: string, message: string): void => {
    out.push({ ruleId: 'L009', severity: 'info', field, message });
  };
  if (!String(raw['bookSourceUrl'] ?? '').trim()) push('bookSourceUrl', '严格模式必填：`bookSourceUrl` 为空');
  if (!String(raw['bookSourceName'] ?? '').trim()) push('bookSourceName', '严格模式必填：`bookSourceName` 为空');
  const rs = raw['ruleSearch'] as Record<string, unknown> | undefined;
  const hasSearch = String(raw['searchUrl'] ?? '').trim() || String(rs?.['bookList'] ?? '').trim();
  if (!hasSearch) push('searchUrl', '严格模式必填：`searchUrl` 与 `ruleSearch.bookList` 都为空');
  else if (rs) {
    for (const k of ['bookList', 'name', 'bookUrl']) {
      if (!String(rs[k] ?? '').trim()) push(`ruleSearch.${k}`, `严格模式必填：\`ruleSearch.${k}\` 为空`);
    }
  }
  const rt = raw['ruleToc'] as Record<string, unknown> | undefined;
  const type = Number(raw['bookSourceType'] ?? 0);
  if (type === 0 && !String(rt?.['chapterList'] ?? '').trim()) {
    push('ruleToc.chapterList', '严格模式必填：`ruleToc.chapterList` 为空（文本源无法取目录）');
  } else if (rt) {
    for (const k of ['chapterName', 'chapterUrl']) {
      const hasList = String(rt['chapterList'] ?? '').trim();
      if (hasList && !String(rt[k] ?? '').trim()) push(`ruleToc.${k}`, `严格模式必填：\`ruleToc.${k}\` 为空`);
    }
  }
  return out;
}

/**
 * `#552` **源形态判定的唯一实现**（`/api/doctor/inspect` 与离线巡检共用）。
 *
 * 为什么必须抽出来：巡检要按源跑 lint，而 kind 判定此前只写在 `inspect` 路由里 ——
 * 抄一份到巡检侧就是「两处各写一份后来漂了」（`#158` 那类）。
 * 判据（与 `#369` 的「RSS 站点在 sourceUrl」同源）：
 *  · `apiUrl` ⇒ MacCMS 影视源；
 *  · `sourceUrl` + 文章规则 ⇒ RSS；
 *  · 其余 ⇒ 书源。
 */
export function sourceKindOf(raw: Record<string, unknown>): SourceKind {
  if (raw['apiUrl']) return 'vod';
  if (raw['sourceUrl'] && (raw['ruleArticles'] || raw['ruleTitle'])) return 'rss';
  return 'legado';
}

/** 整源 lint 入口 */
export function lintSource(raw: Record<string, unknown>, kind: SourceKind = 'legado'): LintFinding[] {
  const findings: LintFinding[] = [];
  const leaves: Array<{ field: string; text: string }> = [];
  for (const k of LINT_FIELDS) {
    if (raw[k] !== undefined) collectStringLeaves(raw[k], k, leaves);
  }
  for (const { field, text } of leaves) {
    // 列表字段：`ruleSearch.bookList` / `ruleToc.chapterList`
    if (/(?:^|\.)(?:bookList|chapterList)$/.test(field)) findings.push(...checkListRule(field, text));
    // 规则文本通用检查（纯 JS 串会在 checkRuleText 里自动跳过 `##`/`@js:` 后缀那几条）
    findings.push(...checkRuleText(field, text));
    // JS 片段：可编译性 + 语法坑
    for (const chunk of jsChunksOf(text)) findings.push(...checkJsChunk(field, chunk));
  }
  findings.push(...checkRequiredFields(raw, kind));
  findings.push(...checkRouting(raw));
  return findings;
}

/** lint 表（**文档 + 稳定 id**；判据在 checkRuleText/checkListRule/checkJsChunk/checkRequiredFields） */
export const LINT_RULES: readonly LintRule[] = [
  { id: 'L001', title: '解构参数缺括号（`.map([a,b]=>`）', severity: 'error', scope: 'js', hint: '改成 `.map(([a,b])=>`' },
  { id: 'L002', title: 'JS 片段含不可见字符（零宽空格/BOM）', severity: 'error', scope: 'js', hint: '删除不可见字符（可自动修）' },
  { id: 'L003', title: '`@js:` 之后还有选择器/正则后缀', severity: 'warn', scope: 'text', hint: '把 `@js:` 移到规则最后一段' },
  { id: 'L004', title: '列表规则以属性读取结尾', severity: 'warn', scope: 'list', hint: '列表应给元素选择器（或 `@css:` 前缀），不要 `@text`/`@href` 收尾' },
  { id: 'L006', title: '`{{…}}` 占位符缺闭合', severity: 'warn', scope: 'text', hint: '补齐 `}}`' },
  { id: 'L007', title: 'POST 的 `body` 不是 String 形态', severity: 'warn', scope: 'text', hint: '用 `String(...)` 强转或写字符串字面量' },
  { id: 'L008', title: 'JS 语法错（`new Function` 编译失败）', severity: 'error', scope: 'js', hint: '按提示行修复；常见为未闭合正则/字符串缺引号' },
  { id: 'L009', title: '严格模式必填字段缺失', severity: 'info', scope: 'source', hint: '按 `书源输出模板_严格模式` 补齐' },
  { id: 'L010', title: '求值会被强留 L1（同步阻塞）', severity: 'info', scope: 'source', hint: '见 `needsJavaBridgeL1`：Java 桥未覆盖 / document 名单外 / 动态 eval' },
  { id: 'L011', title: '`searchUrl` 无关键词占位', severity: 'info', scope: 'source', hint: '加 `{{key}}` 或改成 POST 体' },
];
