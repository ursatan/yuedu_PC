/**
 * `#555` **试跑前置判定：URL 模板 / 登录字段形态 / 登录界面静态解析**（纯函数，无网络）。
 *
 * 起因（用户 2026-10-21 对工坊试跑的评审）：
 *  · 「源 URL 只有网址，只需站点能通，不该拿它去跑规则匹配」；
 *  · 「JS 的要跑 JS，纯文字的去试跑没有意义」；
 *  · 「登录地址/登录界面/登录校验 JS 三者应该联动」。
 *
 * 所以「点一下」这件事必须先分类，再决定跑什么。分类判据只写在这一处：
 *  · `classifyRuleField()` —— 一条规则串到底是 HTML/JSON 规则、纯 JS、还是 URL；
 *  · `evalUrlTemplate()` —— Legado `AnalyzeUrl` 的完整构造链（`#557` 起：**真求值**，见下）；
 *  · `interpSearchUrl()` —— 旧版**纯静态**插值，只认 `{{key}}`/`{{page}}`（保留给不需要求值的调用方）；
 *  · `analyzeLoginUi()` —— 旧 HTML 形态 `loginUi` 的静态解析（JSON 形态见 `login-ui-check.ts`）。
 *
 * ⚠️ 纪律：这里**不做网络请求**，也**不自己解释规则语义**（求值器由调用方按引擎同款注入）。
 */

import { applyUrlRuleJs, splitUrlOptions, stripOptionalUrlSegments } from '../net/url-prep';
import { resolveUrl } from '../net/url-resolve';


/** 一条字段的「可跑形态」——决定前端给哪个按钮、服务端跑哪条通路 */
export type RuleFieldKind =
  /** 静态规则（CSS/XPath/JSONPath/`@js:` 尾缀）：对着页面求值才有意义 */
  | 'rule'
  /** 整条就是 JS（`@js:`/`<js>` 全包）：要真跑 JS */
  | 'js'
  /** 只是一个网址（源 URL / 登录地址）：只做连通测试 */
  | 'url'
  /** 形如 `https://…` 也可能是 JS（Legado 允许登录地址写 JS）⇒ 两种都要能跑 */
  | 'url-or-js'
  /** 结构化 HTML（登录界面）：静态预览 + 解析按钮，不跑规则 */
  | 'html'
  /** 纯文本 / 数字 / 枚举 / JSON 配置：无「匹配」可言 */
  | 'plain';

/** 字段值的几种形态判定（顺序即优先级：URL > 整串 JS > 含 JS 尾缀的规则 > 普通规则） */
export function classifyRuleField(raw: unknown): RuleFieldKind {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'plain';
  if (/^https?:\/\//i.test(s) && !/\s/.test(s)) return 'url';
  if (/^@js:/.test(s) || /^<js>[\w\W]*<\/js>$/.test(s)) return 'js';
  if (/^\s*<(!doctype|html|div|table|form|ul|ol|p|span|button|input|textarea|iframe|a|li|section)/i.test(s)) return 'html';
  // 其余以 `<` 开头的（例如自定义标签 / 片段注释）也当结构化 HTML：它不可能是 CSS/XPath/JSONPath
  if (/^\s*</.test(s)) return 'html';
  // 规则串里带 JS 尾缀（`@css:…@js:…`）仍属「规则」，求值走 analyze 的分段
  if (/@(?:css|xpath|json):/.test(s) || /[.#\[]|^\/\/|^\$|@/.test(s)) return 'rule';
  return 'plain';
}

/**
 * 拆分 Legado `AnalyzeUrl` 的 URL 选项：`https://x/search?q={{key}},{"method":"POST","body":"…"}`
 *
 * ⚠️ 只在**第一个** `,{` 处切（正文里可能有逗号花括号）；切出来的 JSON 坏了就整串当 URL，
 * 并把原文交回给调用方（`optionsError`）—— 不静默丢选项。
 */
export function parseUrlOptions(raw: string): {
  url: string;
  options: Record<string, unknown>;
  optionsError?: string;
} {
  const s = raw.trim();
  const idx = s.indexOf(',{');
  if (idx < 0) return { url: s, options: {} };
  const url = s.slice(0, idx).trim();
  const tail = s.slice(idx + 1);
  try {
    const o = JSON.parse(tail) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return { url, options: o as Record<string, unknown> };
    }
    return { url: s, options: {}, optionsError: 'URL 选项不是对象（尾部 JSON 被当成了 URL 的一部分）' };
  } catch (e) {
    return { url: s, options: {}, optionsError: `URL 选项 JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** `{{…}}` 插值结果 */
export interface InterpResult {
  /** 插值后的 URL（有 `unsupported` 时仍返回尽力替换的结果，便于人眼比对） */
  url: string;
  /** 非空表示「这份模板静态构造不出来」，值为原因（给用户看的人话） */
  unsupported?: string;
  /** 实际被替换掉的占位符 */
  replaced: string[];
}

/**
 * 搜索 URL 的**静态插值**：只认 `{{key}}` 与 `{{page}}`（含 `{{page-1}}` 这类纯算术写法不认）。
 *
 * 认不出的 `{{…}}`（`{{$.id}}` / `{{cookie.getKey()}}` / `{{java.ajax(…)}}`）⇒ 报 `unsupported`：
 * 那些必须让引擎真跑（`/api/run`），猜一个 URL 只会给出**假结论**（"站点 404" 其实是模板没插值）。
 */
export function interpSearchUrl(
  raw: string,
  opts: { keyword: string; page: number; baseUrl?: string },
): InterpResult {
  const { url: pure } = parseUrlOptions(raw);
  const replaced: string[] = [];
  const unknown: string[] = [];
  const out = pure.replace(/\{\{([\w\W]*?)\}\}/g, (_m, expr: string) => {
    const p = String(expr).trim();
    if (/^key(word)?$/i.test(p)) {
      replaced.push('{{key}}');
      return encodeURIComponent(opts.keyword);
    }
    if (/^page$/i.test(p)) {
      replaced.push('{{page}}');
      return String(opts.page);
    }
    if (/^page\s*\+\s*1$/i.test(p)) {
      replaced.push('{{page+1}}');
      return String(opts.page + 1);
    }
    unknown.push(`{{${p}}}`);
    return `{{${p}}}`;
  });
  return {
    url: out,
    replaced,
    ...(unknown.length
      ? {
          unsupported: `含需真跑的插值 ${[...new Set(unknown)].join(' / ')}：静态构造不出 URL，请用「▶ 调试」真跑搜索`,
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* `#557` URL 模板**真求值**（与引擎 `AnalyzeUrl.initUrl` 同序）          */
/* ------------------------------------------------------------------ */

/** `{{}}` / `@js:` 求值时脚本能看到的绑定（与 `AnalyzeUrl.evalJS` 同面） */
export interface UrlTemplateBindings {
  key: string;
  page: number;
  baseUrl: string;
}

export interface UrlTemplateCtx {
  keyword?: string;
  page?: number;
  baseUrl?: string;
  /**
   * `{{表达式}}` 求值 —— **必须**由调用方注入引擎同一套 JS 求值器
   * （`makeProbeEnv().env.jsEval`），bindings 里 `key`/`page`/`baseUrl` 已给好。
   * 不注入 ⇒ 退化成「只认 key/page/纯算术」的静态插值（旧行为）。
   */
  evalExpr?: (expr: string, b: UrlTemplateBindings) => Promise<unknown> | unknown;
  /** `<js>…</js>` / `@js:` 段求值（引擎 `applyUrlRuleJs` 的回调形态，`result` 即当前累积值） */
  evalJsSegment?: (code: string, current: string) => Promise<string | null> | string | null;
}

export interface UrlTemplateOut {
  /** 求值 + 绝对化后的 URL（不含 `,{options}` 尾巴） */
  url: string;
  options: Record<string, unknown>;
  method: 'GET' | 'POST' | 'HEAD';
  body?: string;
  /** 真被求值替换掉的占位符（诊断用，别拿它当「所有占位符」） */
  replaced: string[];
  /** 求值失败 / 静态算不出来的项（人话，直接可展示） */
  errors: string[];
  /** 用过 `<js>`/`@js:` 段 */
  jsSegment: boolean;
  /** 用过 `<1,2,3>` 页码模式 */
  pagePattern: boolean;
  /** 有算不出来的占位符 ⇒ 这个 URL 不能当结论（要么真跑，要么修规则） */
  unresolved: boolean;
}

/** `<1,2,3>` 页码模式的取值（Legado `pagePattern`，越界取最后一档）——`#579` 起统一在 core 叶子里 */
import { pickPagePattern } from '../net/url-resolve';
export { pickPagePattern };

/**
 * **按引擎语义求值一条 URL 模板**（`#557`）。
 *
 * 用户 2026-10-21 报的四种「无法正确执行」，根因都是探针自己在算（`interpSearchUrl`
 * 只认 `{{key}}`/`{{page}}`/`{{page+1}}`），而引擎是**真跑 JS**：
 *  1. `/s.php,{"charset":"gbk","method":"post","body":"…s={{key}}"}` —— 选项尾巴要切、body 要插值；
 *  2. `<js>result = getServerHost() + "/i/sor.aspx?key=" + encodeURIComponent(key);</js>` —— JS 段；
 *  3. `/search.php?q={{key}}&p={{page}}` —— 能算（旧版也行，但 p=2 没人验）；
 *  4. `page/{{page}}?s={{key}}` —— 相对路径要按源 URL 绝对化。
 *  外加发现页的 `{{page == 1 ? "" : page + ".html"}}` —— 是**表达式**，不是"页码占位符"。
 *
 * 求值顺序逐条对齐引擎（`engine.ts` 的 searchUrl 分支）：
 *  `@js:`/`<js>` 段 → `{{}}` → `,{options}` 切分（**切在求值之后**：JS 结果本身可能带尾巴）
 *  → body 里的 `{{}}` → 选项 `js`（改写 URL）→ `<1,2,3>` 页码 → 相对路径绝对化。
 *
 * ⚠️ 失败不猜：算不出来的 `{{…}}` **原样留在 URL 里**并记 `errors` —— 宁可给「这里没算出来」，
 * 也不悄悄换成空串（那会请求一个假 URL，然后被误读成「站点 404」）。
 */
export async function evalUrlTemplate(raw: string, ctx: UrlTemplateCtx = {}): Promise<UrlTemplateOut> {
  const keyword = ctx.keyword ?? '';
  const page = Number.isFinite(ctx.page) && (ctx.page as number) > 0 ? Math.trunc(ctx.page as number) : 1;
  const baseUrl = String(ctx.baseUrl ?? '');
  const bind: UrlTemplateBindings = { key: keyword, page, baseUrl };
  const out: UrlTemplateOut = {
    url: '',
    options: {},
    method: 'GET',
    replaced: [],
    errors: [],
    jsSegment: false,
    pagePattern: false,
    unresolved: false,
  };

  let s = stripOptionalUrlSegments(String(raw ?? '').trim());

  /** `{{}}` 替换（body / URL 共用一份，判据只在这里） */
  const interpBraces = async (text: string): Promise<string> => {
    if (!text.includes('{{') || !text.includes('}}')) return text;
    const matches = [...text.matchAll(/\{\{([\w\W]*?)\}\}/g)];
    let acc = '';
    let last = 0;
    for (const m of matches) {
      const idx = m.index ?? 0;
      acc += text.slice(last, idx);
      last = idx + m[0].length;
      const expr = String(m[1] ?? '').trim();
      // ① `{{key}}`：关键词要**百分号编码**（与旧行为一致；源里写 `{{key}}` 就是让引擎替它编）
      if (/^key(word)?$/i.test(expr)) {
        out.replaced.push(`{{${expr}}}`);
        acc += encodeURIComponent(keyword);
        continue;
      }
      // ② `{{page}}`
      if (/^page$/i.test(expr)) {
        out.replaced.push('{{page}}');
        acc += String(page);
        continue;
      }
      // ③ 有求值器 ⇒ 按引擎走真 JS（`page == 1 ? "" : page + ".html"` 这类表达式靠它）
      if (ctx.evalExpr) {
        try {
          const v = await ctx.evalExpr(expr, bind);
          out.replaced.push(`{{${expr}}}`);
          acc += v == null ? '' : String(v);
        } catch (e) {
          out.errors.push(`{{${expr}}} 求值失败：${e instanceof Error ? e.message : String(e)}`);
          out.unresolved = true;
          acc += m[0];
        }
        continue;
      }
      // ④ 没有求值器：纯算术可以算（`{{page+1}}` 之类），其余如实报「算不出来」
      const arith = /^page\s*([+\-*/])\s*(\d+)$/i.exec(expr);
      if (arith) {
        const n = Number(arith[2]);
        const v = arith[1] === '+' ? page + n : arith[1] === '-' ? page - n : arith[1] === '*' ? page * n : page / n;
        out.replaced.push(`{{${expr}}}`);
        acc += String(Number.isInteger(v) ? v : Math.round(v * 100) / 100);
        continue;
      }
      out.errors.push(`{{${expr}}} 需要真跑 JS 求值（探针没拿到求值器）`);
      out.unresolved = true;
      acc += m[0];
    }
    return acc + text.slice(last);
  };

  // ① JS 段（`@js:` / `<js>`）：URL 里任意位置都触发，结果整体替换
  if (/@js:|<js>/i.test(s)) {
    out.jsSegment = true;
    if (!ctx.evalJsSegment) {
      out.errors.push('URL 里有 `<js>`/`@js:` 段，但没拿到 JS 求值器 ⇒ 无法构造 URL');
      out.unresolved = true;
      return { ...out, url: s };
    }
    try {
      s = await applyUrlRuleJs(s, ctx.evalJsSegment);
    } catch (e) {
      out.errors.push(`\`<js>\` 段求值失败：${e instanceof Error ? e.message : String(e)}`);
      out.unresolved = true;
      return { ...out, url: s };
    }
  }

  // ② `{{}}`（在切尾巴之前 —— JS 求值结果可能自带 `,{options}`）
  s = await interpBraces(s);

  // ③ 切 `,{options}` 尾巴（宽松 JSON：单引号/无引号键/GSON 语义）
  const split = splitUrlOptions(s);
  s = split.url;
  if (split.option) out.options = { ...(split.option as Record<string, unknown>) };
  out.method = String(out.options['method'] ?? 'GET').toUpperCase() === 'POST'
    ? 'POST'
    : String(out.options['method'] ?? 'GET').toUpperCase() === 'HEAD'
      ? 'HEAD'
      : 'GET';

  // ④ body 里的 `{{}}`（引擎对 body 也跑 interpUrl）
  if (typeof out.options['body'] === 'string' && out.options['body']) {
    out.body = await interpBraces(out.options['body'] as string);
    out.options = { ...out.options, body: out.body };
  }

  // ⑤ 选项 `js`：改写/构造 URL（Legado `AnalyzeUrl.kt:274-278`）；返回空则保持原 URL
  const optJs = typeof out.options['js'] === 'string' ? String(out.options['js']).trim() : '';
  if (optJs && optJs !== 'null') {
    if (!ctx.evalJsSegment) {
      out.errors.push('URL 选项里有 `js`（用脚本改写 URL），但没拿到 JS 求值器 ⇒ 无法构造 URL');
      out.unresolved = true;
    } else {
      try {
        const v = await ctx.evalJsSegment(optJs, s);
        if (v != null && String(v).trim()) s = String(v).trim();
      } catch (e) {
        out.errors.push(`URL 选项 \`js\` 求值失败：${e instanceof Error ? e.message : String(e)}`);
        out.unresolved = true;
      }
    }
  }

  // ⑥ `<1,2,3>` 页码模式
  const pp = pickPagePattern(s, page);
  s = pp.s;
  out.pagePattern = pp.used;

  // ⑦ 绝对化（引擎 `NetworkUtils.getAbsoluteURL` 同口径：相对路径按源 URL 补）
  out.url = resolveUrl(baseUrl || undefined, s);
  return out;
}

/** 「默认关键词」取法：有 `checkKeyWord` 用它（用户定的），否则用 `我的`（语料里最通用的写法） */
export const DEFAULT_SEARCH_KEYWORD = '我的';export function defaultSearchKeyword(checkKeyWord?: unknown): string {
  const s = typeof checkKeyWord === 'string' ? checkKeyWord.trim() : '';
  return s || DEFAULT_SEARCH_KEYWORD;
}

/* ------------------------------------------------------------------ */
/* 登录三件套：loginUrl / loginUi / loginCheckJs                        */
/* ------------------------------------------------------------------ */

/** `loginUrl` 的形态：空 / 纯网址 / 纯 JS / 两者混写（Legado 允许 `url` 与 JS 并存） */
export type LoginUrlKind = 'empty' | 'url' | 'js' | 'mixed';
export function loginUrlKind(raw: unknown): LoginUrlKind {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'empty';
  const hasUrl = /^https?:\/\//im.test(s);
  const hasJs = /@js:|<js>|function\s|=>|\bvar\s|\bconst\s|\blet\s/.test(s);
  if (hasUrl && hasJs) return 'mixed';
  if (hasUrl) return 'url';
  return 'js';
}

/** 登录界面里一个按钮 */
export interface LoginUiButton {
  /** 按钮上看到的文字（`<button>` 内容 / `value`） */
  label: string;
  /** `action` 属性的值（Legado：指向 loginUrl 的 JS 里的函数名；也可能是内联 JS 片段） */
  action: string;
  /** 这个 action 看起来是什么：函数调用 / 内联语句 / 没写 */
  actionKind: 'fn' | 'inline' | 'none';
}
/** 登录界面里的一个输入框 */
export interface LoginUiField {
  name: string;
  type: string;
  placeholder: string;
}

export interface LoginUiAnalysis {
  ok: boolean;
  /** 原文（前端用 srcdoc 预览） */
  html: string;
  /** `<button>` 数量与明细 */
  buttons: LoginUiButton[];
  fields: LoginUiField[];
  /** 是否标了 `multi`（多标签登录界面：一个源多个登录入口） */
  multi: boolean;
  /** 是否标了 `post`（点按钮后以 POST 提交表单） */
  post: boolean;
  /** 静态解析看不出来的东西（如需要 JS 才能生成的 DOM）如实说明 */
  warnings: string[];
  error?: string;
}

function attrOf(tag: string, name: string): string {
  // 属性名前面必须是空白（避免 `data-action` 被当成 `action`）
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return m ? String(m[2]).trim() : '';
}

/**
 * **静态解析 `loginUi`**（不执行、不渲染）：
 * 从 HTML 串里取出按钮、输入框、`action` 指向，并判它是「函数名」还是「内联 JS」。
 *
 * 为什么不做真渲染：`loginUi` 里常有 `@js:` 插值或依赖源变量（`{{getCookie()}}`），
 * 真渲染要拉起 Chromium（在「登录」按钮那条路里做）。这里先给**不依赖浏览器**的结构视图：
 * 「有几个按钮 / 每个按钮点了会调什么 / 有几个输入框」——足以判断排版意图与接线是否写错。
 */
export function analyzeLoginUi(raw: unknown): LoginUiAnalysis {
  const html = typeof raw === 'string' ? raw : '';
  const out: LoginUiAnalysis = {
    ok: false,
    html,
    buttons: [],
    fields: [],
    multi: false,
    post: false,
    warnings: [],
  };
  if (!html.trim()) {
    out.error = '登录界面为空（这个源可能只需要 loginUrl，不需要自定义界面）';
    return out;
  }
  const head = html.slice(0, 4000);
  // `multi` / `post` 两种写法都要认：标签形态 `<multi>`，或属性形态 `multi="true"`
  out.multi = /<multi\b|\smulti\b/i.test(head);
  out.post = /<post\b|\spost\b/i.test(head);

  for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const inner = String(m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const action = attrOf(tag, 'action') || attrOf(tag, 'onclick');
    const label = inner || attrOf(tag, 'value') || attrOf(tag, 'name');
    out.buttons.push({ label, action, actionKind: actionKindOf(action) });
  }
  // 有些源用 <input type="button|submit" action="…"> 代替 <button>
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const type = (attrOf(tag, 'type') || 'text').toLowerCase();
    if (type === 'button' || type === 'submit') {
      const action = attrOf(tag, 'action') || attrOf(tag, 'onclick');
      out.buttons.push({ label: attrOf(tag, 'value') || attrOf(tag, 'name'), action, actionKind: actionKindOf(action) });
    } else {
      out.fields.push({
        name: attrOf(tag, 'name'),
        type,
        placeholder: attrOf(tag, 'placeholder'),
      });
    }
  }
  if (/<textarea\b/i.test(html)) out.fields.push({ name: '(textarea)', type: 'textarea', placeholder: '' });

  if (!out.buttons.length) {
    out.warnings.push('没找到按钮：点「登录」后可能无法提交（除非 loginUrl 的 JS 自己接管）');
  }
  const noAction = out.buttons.filter((b) => b.actionKind === 'none');
  if (noAction.length) {
    out.warnings.push(`${noAction.length} 个按钮没写 action —— 点了不会有任何反应（Legado 靠 action 调 loginUrl 里的函数）`);
  }
  if (/\{\{|\@js:/.test(html)) {
    out.warnings.push('界面里含 {{}} / @js: 插值：静态预览看到的是未求值的原样，真实排版要在「登录」里看');
  }
  out.ok = out.buttons.length > 0;
  return out;
}

function actionKindOf(action: string): LoginUiButton['actionKind'] {
  const s = action.trim();
  if (!s) return 'none';
  // `doLogin()` / `doLogin` / `java.ajax(...)` 当函数；含分号/赋值/花括号当内联语句
  if (/[;=]|\{|\}/.test(s)) return 'inline';
  if (/^[\w$.]+\s*(\([\s\S]*\))?$/.test(s)) return 'fn';
  return 'inline';
}
