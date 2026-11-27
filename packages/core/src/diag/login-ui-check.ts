/**
 * `#557` **`loginUi` 的规则校验**（JSON v1 数组 / v2 标记 / 脚本 / 旧 HTML 形态）。
 *
 * 用户 2026-10-21 的原话：预览只提供**代码展示**，要能回答
 *  · 「能不能按规则预期显示」——→ `layout`（每行占多宽、排成几行，按 `style.layout_flexBasisPercent` 推）
 *  · 「有没有书写错误，括号、逗号等问题」——→ `problems`（语法 + 逐行必填），语法类给 `fixed` 全文
 *  · 「action 写的函数能不能点」——→ `actions[].defined`（在 loginUrl/loginCheckJs/jsLib 里静态查定义）
 *  · 「这里能执行相应位置的 JS 代码么」——→ **不能**，如实写进 `hints`（见文件末尾的说明）
 *
 * 为什么不再渲染一遍界面：渲染只能告诉你「长这样」，说不出「为什么长这样」；
 * 而用户要的是**改规则**。把规则摊成「行 / 宽度 / action / 定义」四列，改起来才有靶子。
 *
 * JSON 形态用的是**上游同一套宽松口径**（`parseJsonLoose`，GSON lenient）：
 * 源里 `flase` 这种裸标识符、单引号 `'默认'` 都能读 —— 用标准 `JSON.parse` 会误报「语法错」。
 */

import { parseJsonLoose } from '../json-loose';
import { extractInlineJs, normalizeLoginField } from '../login-model';
import { isLoginUiV2 } from '../contract/login-v2';
import type { LoginField } from '../contract/types';
import { autoCorrectExploreRule } from './explore-probe';
import type { ExploreFix } from './explore-probe';
import { analyzeLoginUi } from './url-probe';

/** `loginUi` 的形态（判据顺序：空 → v2 标记 → 脚本 → JSON 数组/对象 → HTML） */
export type LoginUiKind = 'empty' | 'v2' | 'script' | 'json' | 'html';

export function classifyLoginUi(raw: unknown): LoginUiKind {
  const s = String(raw ?? '').trim();
  if (!s) return 'empty';
  if (isLoginUiV2(s)) return 'v2';
  if (extractInlineJs(s)) return 'script';
  if (s.startsWith('[') || s.startsWith('{')) return 'json';
  return 'html';
}

/** 一行在界面上的预期宽度（Legado `RowUi.style.layout_flexBasisPercent`：0~1 的比例） */
export interface LoginUiRowOut {
  index: number;
  /** v1 里 `name` 就是存储键；v2 是 `key` */
  name: string;
  type: string;
  action: string;
  /** 宽度百分比（1.0 → 100，0.5 → 50）；没写 style 的行按整行 100 算 */
  widthPercent: number;
  /** `chars`（select 的选项 / toggle 的两个值） */
  chars: string[];
  hint: string;
  /** 这一行本身的问题（与全局 `problems` 是同一批码，便于定位到行） */
  problems: string[];
}

/** 一行 action 的接线情况 */
export interface LoginUiActionOut {
  /** 出现在哪一行（行号从 1 起，与界面顺序一致） */
  row: number;
  action: string;
  kind: 'url' | 'fn' | 'inline' | 'none';
  /** `kind==='fn'` 时：函数名在 loginUrl/loginCheckJs/jsLib 里找得到定义吗 */
  defined?: boolean;
  note?: string;
}

export interface LoginUiProblem {
  code: string;
  message: string;
  /** 语法类（可机械补丁）→ 前端给「自动纠正」 */
  fixable: boolean;
  /** 出问题的行号（0 起，与 `rows[].index` 一致）；全局问题不带 */
  row?: number;
}

export interface LoginUiCheck {
  kind: LoginUiKind;
  /** 有行且没有致命问题 */
  ok: boolean;
  /** 规则原文（前端「代码展示」直接用它，不做任何格式化 —— 看到的就是要改的那份字节） */
  raw: string;
  rows: LoginUiRowOut[];
  /** 按宽度累加推出来的行分组（就是「按规则预期显示」的样子） */
  layout: { line: number; items: { name: string; widthPercent: number }[] }[];
  actions: LoginUiActionOut[];
  problems: LoginUiProblem[];
  /** 可自动修的项（全角标点/漏·尾逗号/括号未闭合） */
  fixes?: ExploreFix[];
  /** 自动纠正后的全文（有可修项才给） */
  fixed?: string;
  error?: string;
  hints: string[];
  /** 这是脚本形态：要服务端求值一次才知道有哪些行（服务端会代跑） */
  needEval: boolean;
  /** 脚本求值出来的原文（服务端代跑后回填；`rows` 就是按它校验的） */
  evaluated?: string;
}

export interface LoginUiCheckReq {
  raw: unknown;
  /** `loginUrl` 源码（action 的函数定义主要在这里） */
  loginJs?: unknown;
  /** `loginCheckJs` 源码 */
  checkJs?: unknown;
  /** `jsLib` 源码（函数也可能定义在这） */
  jsLib?: unknown;
}

/** 从源码里扫「定义了哪些函数/变量」（静态，不执行） */
export function definedNames(src: string): Set<string> {
  const out = new Set<string>();
  if (!src) return out;
  const pats = [
    /function\s+([A-Za-z_$][\w$]*)/g,
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g,
    /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?function/g,
    /([A-Za-z_$][\w$]*)\s*[:=]\s*\([^)]*\)\s*=>/g,
  ];
  for (const re of pats) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) if (m[1]) out.add(m[1]);
  }
  return out;
}

/** `action` 的形态（v1：既可能是函数调用，也可能是绝对 URL——点了就打开页面） */
function actionOf(action: string): { kind: LoginUiActionOut['kind']; name: string } {
  const s = action.trim();
  if (!s) return { kind: 'none', name: '' };
  if (/^https?:\/\//i.test(s)) return { kind: 'url', name: '' };
  const fn = /^([A-Za-z_$][\w$]*)\s*\(/.exec(s);
  if (fn && fn[1]) return { kind: 'fn', name: fn[1] };
  if (/[;=]|\{|\}/.test(s)) return { kind: 'inline', name: '' };
  if (/^[A-Za-z_$][\w$.]*$/.test(s)) return { kind: 'fn', name: s.split('.').pop() ?? s };
  return { kind: 'inline', name: '' };
}

const KNOWN_TYPES = new Set(['text', 'password', 'button', 'label', 'toggle', 'select']);
const KNOWN_STYLE_KEYS = new Set(['layout_flexGrow', 'layout_flexBasisPercent']);

/** `style` 里不被消费的键（Legado 只认两个 layout_*；写别的等于白写，要提示） */
function unknownStyleKeys(row: Record<string, unknown>): string[] {
  const st = row['style'];
  if (!st || typeof st !== 'object' || Array.isArray(st)) return [];
  return Object.keys(st as Record<string, unknown>).filter((k) => !KNOWN_STYLE_KEYS.has(k));
}

/**
 * 校验 `loginUi`（**不执行任何 JS**；脚本形态由调用方求值后再调本函数一次）。
 *
 * ⚠️ `rows` 拿的是 `normalizeLoginField` 的归一结果 —— 它会**丢掉没有 `name` 的行**，
 * 所以「源里写了 5 行、这里只出来 4 行」本身就是一条问题（少的那行在 App 里也不显示）。
 */
export function checkLoginUi(req: LoginUiCheckReq): LoginUiCheck {
  const raw = typeof req.raw === 'string' ? req.raw : '';
  const kind = classifyLoginUi(raw);
  const loginJs = String(req.loginJs ?? '');
  const checkJs = String(req.checkJs ?? '');
  const jsLib = String(req.jsLib ?? '');
  const defs = new Set([...definedNames(loginJs), ...definedNames(checkJs), ...definedNames(jsLib)]);
  /** 本源到底有没有登录脚本：全空 ⇒ action 不是「函数名写错」，而是「根本没地方定义它」 */
  const noJs = !(loginJs.trim() || checkJs.trim() || jsLib.trim());

  const problems: LoginUiProblem[] = [];
  const hints: string[] = [];
  const rows: LoginUiRowOut[] = [];
  const actions: LoginUiActionOut[] = [];
  const out: LoginUiCheck = {
    kind,
    ok: false,
    raw,
    rows,
    layout: [],
    actions,
    problems,
    hints,
    needEval: false,
  };

  if (kind === 'empty') {
    out.error = '登录界面为空：这个源不需要自定义登录界面（或登录逻辑全在 loginUrl 里）';
    return out;
  }
  if (kind === 'v2') {
    // v2 的 loginUi 只是标记，行由 loginUrl 里的 `loginUi(state)` 产出
    out.needEval = true;
    hints.push('这是 LoginUiV2（`{"version":2}`）：行不在 loginUi 里，而由 loginUrl 的 `loginUi(state)` 产出');
    hints.push('静态只能确认「标记写对了」；要真看有哪些行，得在登录对话框里跑一次');
    out.ok = /"version"\s*:\s*2/.test(raw);
    return out;
  }
  if (kind === 'script') {
    out.needEval = true;
    hints.push('loginUi 是脚本（`@js:`/`<js>`）：行由脚本产出，静态看不到 —— 服务端会代跑一次再校验');
    return out;
  }

  if (kind === 'html') {
    // 旧 HTML 形态（非 Legado 标准，但语料里有）：交给 HTML 解析，只做结构提示
    const a = analyzeLoginUi(raw);
    a.buttons.forEach((b, i) => {
      rows.push({ index: i, name: b.label, type: 'button', action: b.action, widthPercent: 100, chars: [], hint: '', problems: [] });
    });
    a.fields.forEach((f, i) => {
      rows.push({ index: rows.length + i, name: f.name, type: f.type === 'password' ? 'password' : 'text', action: '', widthPercent: 100, chars: [], hint: f.placeholder, problems: [] });
    });
    for (const w of a.warnings) problems.push({ code: 'LOGINUI_HTML', message: w, fixable: false });
    hints.push('这不是标准 Legado 形态：标准写法是 JSON 数组（每项 `{name,type,action,style}`）');
    out.ok = rows.length > 0;
    out.hints = hints;
    return out;
  }

  /* ---------- kind === 'json' ---------- */
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // 标准 JSON 炸了不代表源错了：上游 GSON 宽松能读（`flase` / 单引号）
    parsed = parseJsonLoose(raw);
    if (parsed == null) {
      out.error = '规则解析失败：既不是标准 JSON，GSON 宽松口径也读不出来';
    } else {
      problems.push({
        code: 'LOGINUI_LENIENT',
        message: '不是标准 JSON，但按 GSON 宽松口径能读（Legado 也能）—— 若换别的编辑器可能读不了',
        fixable: false,
      });
    }
  }
  // 语法类问题（全角标点 / 漏·尾逗号 / 括号未闭合）：复用发现试跑那一份纠正器
  const corr = autoCorrectExploreRule(raw, 'json');
  if (corr.fixes.length) {
    out.fixes = corr.fixes;
    /**
     * ⚠️ **只有纠正后真能解析才给 `fixed`**：纠正器不处理全角花括号 `｛｝`、缺引号这类，
     * 修完仍是坏 JSON。给人一个「点一下就更坏」的补丁比不给补丁更糟。
     */
    let ok = false;
    if (corr.text !== raw) {
      try {
        JSON.parse(corr.text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (ok) out.fixed = corr.text;
    for (const f of corr.fixes) {
      problems.push({ code: f.code, message: `${f.detail}（${f.count} 处）—— 可「自动纠正」`, fixable: true });
    }
    if (!ok) {
      problems.push({
        code: 'LOGINUI_FIX_INCOMPLETE',
        message: '自动纠正后仍然解析不了：还剩纠正器不处理的问题（典型是全角花括号「｛｝」、缺引号、对象没闭合）—— 这几处要手改',
        fixable: false,
      });
    }
  }
  if (out.error) {
    out.hints = hints;
    return out;
  }

  /**
   * 行数组：v1 是**顶层数组**；也容忍 `{rows:[…]}`（v2 渲染结果的形态，有人直接贴进来）
   */
  const arrRaw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
      ? ((parsed as { rows: unknown[] }).rows)
      : null;
  if (!arrRaw) {
    out.error = '规则不是行数组：loginUi 应该是 `[{…},{…}]`（每项一行）';
    out.hints = hints;
    return out;
  }

  const usedNames = new Set<string>();
  /** 没有登录脚本时被调用却无处定义的函数（最后汇总成一条，见 `LOGINUI_ACTION_NO_JS`） */
  const noJsCalls: { row: number; name: string; fn: string }[] = [];
  arrRaw.forEach((item, i) => {
    const obj = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const f: LoginField | null = obj ? normalizeLoginField(obj) : null;
    if (!obj) {
      problems.push({ code: 'LOGINUI_ROW_TYPE', message: `第 ${i + 1} 项不是对象（应该是 {name,type,…}）`, fixable: false, row: i });
      return;
    }
    if (!f) {
      const nm = String(obj['name'] ?? '').trim();
      problems.push({
        code: 'LOGINUI_NAME',
        message: nm ? `第 ${i + 1} 项 name 归一失败` : `第 ${i + 1} 项没有 \`name\`：Legado 会直接跳过这一行（界面上看不到）`,
        fixable: false,
        row: i,
      });
      return;
    }
    const style = (f.style ?? {}) as { flexBasisPercent?: number; flexGrow?: number };
    const widthPercent = typeof style.flexBasisPercent === 'number'
      ? Math.max(1, Math.round(style.flexBasisPercent * 100))
      : 100;
    const rowProblems: string[] = [];
    // type 必须是六个值之一（Legado `RowUi.Type`，未知 type 非法）
    if (!KNOWN_TYPES.has(f.type)) {
      problems.push({ code: 'LOGINUI_TYPE', message: `第 ${i + 1} 行 type「${f.type}」不认识：只认 ${[...KNOWN_TYPES].join(' / ')}`, fixable: false, row: i });
      rowProblems.push('type 不认识');
    }
    const act = actionOf(String(f.action ?? ''));
    if ((f.type === 'button' || f.type === 'toggle') && act.kind === 'none') {
      problems.push({ code: 'LOGINUI_ACTION_MISSING', message: `第 ${i + 1} 行「${f.name}」是 ${f.type} 但没写 action：点了不会有任何反应`, fixable: false, row: i });
      rowProblems.push('缺 action');
    }
    if (act.kind === 'fn' && act.name && !defs.has(act.name)) {
      if (noJs) {
        // 没有登录脚本时**不能**报「找不到定义」：那是在指控用户写错函数名。
        // 逐行收进来，最后汇成一条（5 个按钮全没处调时不要刷 5 条同样的错）。
        noJsCalls.push({ row: i, name: f.name, fn: act.name });
        rowProblems.push(`${act.name}() 无处可调`);
      } else {
        problems.push({
          code: 'LOGINUI_ACTION_UNDEF',
          message: `第 ${i + 1} 行「${f.name}」调用 \`${act.name}()\`，但 loginUrl / loginCheckJs / jsLib 里找不到它的定义：点了会报 \`${act.name} is not defined\``,
          fixable: false,
          row: i,
        });
        rowProblems.push(`${act.name}() 未定义`);
      }
    }
    if (f.type === 'select' && !(f.chars?.length ?? 0)) {
      problems.push({ code: 'LOGINUI_SELECT_CHARS', message: `第 ${i + 1} 行 select 没有 \`chars\`：选项是空的（Legado 用 chars 当选项列表与提交值）`, fixable: false, row: i });
      rowProblems.push('select 无 chars');
    }
    if (f.type === 'text' || f.type === 'password') {
      // v1 用 name 当存储键；重名会让两行的值互相覆盖
      if (usedNames.has(f.name)) {
        problems.push({ code: 'LOGINUI_DUP_NAME', message: `第 ${i + 1} 行 name「${f.name}」与前面重复：v1 用 name 当键，值会互相覆盖`, fixable: false, row: i });
        rowProblems.push('name 重复');
      }
      usedNames.add(f.name);
    }
    for (const k of unknownStyleKeys(obj)) {
      problems.push({ code: 'LOGINUI_STYLE_KEY', message: `第 ${i + 1} 行 style.${k} 不会被使用：只认 layout_flexGrow / layout_flexBasisPercent`, fixable: false, row: i });
      rowProblems.push(`style.${k} 无效`);
    }
    rows.push({
      index: i,
      name: f.name,
      type: f.type,
      action: String(f.action ?? ''),
      widthPercent,
      chars: f.chars ?? [],
      hint: String(f.hint ?? ''),
      problems: rowProblems,
    });
    actions.push({
      row: i,
      action: String(f.action ?? ''),
      kind: act.kind,
      // 没有登录脚本时不给 `defined`（= 未知）：写 `false` 等于断言「查过了，没定义」
      ...(act.kind === 'fn' && act.name && !noJs ? { defined: defs.has(act.name) } : {}),
      ...(act.kind === 'url' ? { note: '点了直接打开这个页面（不调脚本）' } : {}),
      ...(act.kind === 'inline' ? { note: '内联语句（不是函数名）：Legado 会把整段当 JS 执行' } : {}),
    });
  });

  if (!rows.length) {
    out.error = out.error ?? '没有解析出任何行';
  }

  if (noJsCalls.length) {
    const first = noJsCalls[0]!;
    problems.push({
      code: 'LOGINUI_ACTION_NO_JS',
      message:
        `共 ${noJsCalls.length} 个按钮点了要调 loginUrl / loginCheckJs 里的函数` +
        `（如第 ${first.row + 1} 行「${first.name}」的 \`${first.fn}()\`），` +
        '但这个源没有登录脚本（loginUrl / loginCheckJs / jsLib 全空）：按钮无处可调。' +
        '先写 loginUrl，或确认这些行该不该有 action',
      fixable: false,
      row: first.row,
    });
  }

  /* ---------- 预期排版：宽度累加成行 ---------- */
  const layout: LoginUiCheck['layout'] = [];
  let cur: { name: string; widthPercent: number }[] = [];
  let used = 0;
  for (const r of rows) {
    if (used > 0 && used + r.widthPercent > 100.5) {
      layout.push({ line: layout.length + 1, items: cur });
      cur = [];
      used = 0;
    }
    cur.push({ name: r.name, widthPercent: r.widthPercent });
    used += r.widthPercent;
    if (used >= 99.5) {
      layout.push({ line: layout.length + 1, items: cur });
      cur = [];
      used = 0;
    }
  }
  if (cur.length) layout.push({ line: layout.length + 1, items: cur });
  out.layout = layout;

  /** 只有「拦不住渲染」的问题才判不可用；提示类（宽松 JSON、无效 style 键）不算坏 */
  const blocking = problems.filter((p) => !p.fixable && p.code !== 'LOGINUI_LENIENT' && p.code !== 'LOGINUI_STYLE_KEY');
  out.ok = rows.length > 0 && !out.error && blocking.length === 0;
  out.hints = [
    ...hints,
    '静态只判「规则怎么写的」与「按 flex 宽度会排成几行」；真排版/真执行要开「登录」窗口（拉 Chromium）',
    'action 的函数定义在 loginUrl / loginCheckJs / jsLib 里；这里只查「有没有定义」，查不到「跑起来对不对」',
    '预览**不执行**这些函数：它们通常要源 Cookie、要发请求（`java.post`）甚至要拉浏览器（`java.startBrowserAwait`）—— 代跑会给假结论',
  ];
  return out;
}
