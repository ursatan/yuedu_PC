/**
 * `loginUrl` 形态识别（对齐 Legado `BaseSource.getLoginJs()` + 实战里出现过的三种写法）
 *
 * ⚠️ **本文件 `#314` 从 `engine-legado/src/model/login.ts` 原样下沉到 core**。
 * 为什么下沉：上游这条判据是 `BaseSource.getLoginJs()`，**BookSource 与 RssSource 共用**
 * （`RssSource.kt:40-44` 继承 loginUrl/loginUi/loginCheckJs；`RssAdapter.kt:68` 也挂「登录」菜单）
 * ⇒ 两个引擎必须用**同一条**判据。此前它只存在于 legado 包内，rss 包要么抄一份、要么依赖
 * legado 包（后者是架构错向）—— 两条都是「同一判据写两处」的老路。
 * `engine-legado/src/model/login.ts` 现在是本文件的**兼容壳**（具名再导出）。
 *
 * Legado 的 loginUrl 语义很宽：
 *   1) 纯登录页 URL（编辑器提示「填写网站登录网址」）→ 打开内置浏览器让用户手动登录；
 *   2) JS（`<js>…</js>` / `@js:…` 包裹，或整体就是脚本）→ `BaseSource.login()` 执行它，
 *      脚本内部可用 `java.startBrowserAwait`（拉浏览器）或 `java.post`（纯 HTTP 登录）；
 *   3) 第三方编辑器（源阅等）导出的 `{ "url": "…" }` JSON 配置 —— 非 Legado 原生，
 *      但语料里真实存在（飞卢小说、灰机小说），按「登录页 URL」处理。
 *
 * 分类的直接用途：**点击登录按钮时该做什么**。
 *   - `url` / `config-url` → 打开登录页（人工/安全验证；Web 端新标签、桌面端内置窗口）
 *   - `js`                 → 直接执行脚本（可能是纯 HTTP 登录，也可能内部 `startBrowserAwait` 拉页面）
 *   - `ui`                 → `loginUi` 驱动：text/password 表单（值存 loginInfo）+ button 动作
 *                            （action 是绝对 URL → 打开页面；否则是源里的 JS 函数名，如 `login()`）
 *
 * ⚠️ 不再有 `js-browser` 类别：静态扫「脚本里出现过 startBrowser」会误判（七猫的 `startBrowser`
 *    只出现在无关函数里）。是否需要浏览器**由运行时错误**判定（见 engine.login）。
 */

import { isLoginUiV2 } from './contract/login-v2';
// `#411`：loginUi 行的宽松解析与上游 GSON lenient 同口径（唯一实现在 json-loose.ts）
import { parseJsonLoose } from './json-loose';
import type { LoginField } from './contract/types';

/** Legado AppPattern.JS_PATTERN：`<js>…</js>` 或 `@js:…`（不区分大小写，整体匹配） */
const JS_PATTERN = /^(?:<js>([\w\W]*?)<\/js>|@js:([\w\W]*))$/i;

/** 取内联 JS：`<js>…</js>` / `@js:…` → 内层；整体不是 JS 包裹 → null（Legado 同义） */
export function extractInlineJs(rule: string | undefined | null): string | null {
  const text = String(rule ?? '').trim();
  if (!text) return null;
  const m = JS_PATTERN.exec(text);
  if (!m) return null;
  const inner = (m[1] ?? m[2] ?? '').trim();
  return inner || null;
}

/** 脚本是否依赖真实浏览器（WebView）——服务端无法执行的标志 */
const BROWSER_API = /startBrowserAwait|startBrowser\b|startBrowser\s*\(|webView\s*\(|webview\s*\(|getVerificationCode|openVideoPlayer/;

/** 登录形态：none / url、config-url（打开登录页）/ js（执行脚本）/ ui（loginUi 表单或按钮） */
export type LoginKind = 'none' | 'url' | 'config-url' | 'js' | 'ui';

export type { LoginField };

export interface LoginPlan {
  kind: LoginKind;
  /** 可直接打开的登录页（kind = url / config-url 时非空） */
  url: string;
  /** 待执行的登录脚本（kind = js / ui 时非空；Legado `getLoginJs()`） */
  js: string;
  /** 依赖 WebView → 服务端跑不了（仅作提示，不再直接拒绝） */
  needBrowser: boolean;
  /** loginUi 是否为动态脚本（`@js:`/`<js>`）——需要求值后才知道有哪些行 */
  uiIsScript: boolean;
  /** loginUi 原始文本（JSON 数组 / 脚本源码 / 空） */
  uiRaw: string;
  /** 静态可解析时的行（动态脚本由引擎求值后再填） */
  fields: LoginField[];
  /**
   * 是否 **LoginUiV2**（`loginUi = {"version":2}`）。
   * v2 的 `loginUi` 只是标记，行由 `loginUrl` 脚本里的全局 `loginUi(state)` 产出，
   * 动作由 `loginAction(action,state,form)` 产出（Legado `LoginUiV2` + `SourceLoginV2Delegate`）。
   */
  uiV2?: boolean;
}

/** RowUi 行归一（容忍缺省字段；type 缺省 = text，对齐 RowUi 默认值） */
export function normalizeLoginField(raw: unknown): LoginField | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = String(o['name'] ?? '').trim();
  if (!name) return null;
  const type = String(o['type'] ?? 'text').trim() || 'text';
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x) => x != null).map((x) => String(x)) : undefined;
  const style = (o['style'] ?? undefined) as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const flexGrow = style ? num(style['layout_flexGrow']) : undefined;
  const flexBasisPercent = style ? num(style['layout_flexBasisPercent']) : undefined;
  const f: LoginField = { name, type };
  if (o['action'] != null) f.action = String(o['action']);
  const chars = strArr(o['chars']);
  if (chars) f.chars = chars;
  if (o['default'] != null) f.default = String(o['default']);
  if (o['hint'] != null) f.hint = String(o['hint']);
  if (o['value'] != null) f.value = String(o['value']);
  const options = strArr(o['options']);
  if (options) f.options = options;
  if (typeof o['countdown'] === 'number') f.countdown = o['countdown'];
  if (flexGrow !== undefined || flexBasisPercent !== undefined) {
    f.style = { ...(flexGrow !== undefined ? { flexGrow } : {}), ...(flexBasisPercent !== undefined ? { flexBasisPercent } : {}) };
  }
  return f;
}

/**
 * 解析 loginUi 静态文本 → 行数组。
 *
 * ⚠️ **必须用 GSON 宽松口径**（`parseJsonLoose` 三级回落：标准 → 修非法转义 → 自研 tokenizer），
 * **不能**再用 `new Function('return (' + t + ')')`（`#411`）。
 *
 * 实测 18AV（`tmp/src-18AV.json`）的 `loginUi`：它是 `` @js: `[...]` `` 模板串，求值后是一段
 * **对象字面量文本**，里面有两处 JS 解析必炸、而 GSON 宽松照单全收的写法：
 *   · `"layout_wrapBefore": flase`（源作者笔误，**裸标识符**）——JS 里是 ReferenceError
 *     ⇒ 旧实现整段 `return []` ⇒ **登录界面空白**；GSON 把它当字符串 `"flase"`（App 里正常渲染）；
 *   · `chars:['默认','阅读','外部']`（单引号）—— 标准 JSON 也炸。
 * 上游登录行就是这么解析的（GSON lenient），所以宽松解析才是**对齐上游**的那条路。
 */
export function parseLoginUiText(text: string): LoginField[] {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const arr = parseJsonLoose(t);
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeLoginField).filter((x): x is LoginField => !!x);
}

/**
 * 识别登录形态（对齐 Legado `BaseSource.getLoginJs()` + `loginUi` + 语料实证）。
 *
 * 实测形态（484 源）：loginUrl 100 个（52 登录页链接 / 42 脚本 / 6 JSON 配置）；
 * loginUi 37 个（28 JSON 数组 / 8 `@js:` / **v2 0 个**——LoginUiV2 按需，不实现）。
 * RSS 侧（31 源，`#314` 实测）：loginUrl 9 个、loginUi 7 个 → 分布 `none 22 / ui 7 / url 2`。
 *
 * 判定优先级：**有 loginUi 且是表单/动作行 → kind='ui'**（Legado 登录对话框就是 loginUi 驱动；
 * loginUrl 只是它内部的 `login()` 脚本），否则按 loginUrl 分 url / js。
 */
export function classifyLoginUrl(raw: unknown, loginUiRaw?: unknown): LoginPlan {
  const uiText = String(loginUiRaw ?? '').trim();
  const uiJs = extractInlineJs(uiText);
  const uiIsScript = !!uiJs;
  const uiFields = !uiIsScript && uiText.startsWith('[') ? parseLoginUiText(uiText) : [];

  const none: LoginPlan = {
    kind: 'none',
    url: '',
    js: '',
    needBrowser: false,
    uiIsScript,
    uiRaw: uiText,
    fields: uiFields,
    // 显式 false（而不是缺省 undefined）：调用方可以无脑判 `plan.uiV2`，测试也用它锁「不是 v2」
    uiV2: false,
  };
  const t = String(raw ?? '').trim();

  // ③ LoginUiV2（`{"version":2}`）：**行与动作都由 loginUrl 里的脚本产出**，不是 loginUi 字段本身。
  //    Legado `BaseSource.getLoginJs()` = loginUrl（去 `<js>`/`@js:` 外壳）；
  //    求值入口 `evalLoginUiV2(state)` → `loginUi(JSON.parse(state))`、
  //    `evalLoginActionV2(action,state,form)` → `loginAction(...)`（见 engine.login 的 v2 分支）。
  //    ⚠️ 必须在下面「纯 URL / JSON 配置」判定**之前**返回：v2 的 loginUrl 是脚本块，
  //    而被当成 URL/JSON 配置都会走错路径（表现为「点了登录只打开一个页面」）。
  if (isLoginUiV2(uiText)) {
    const v2js = extractInlineJs(t) ?? (/^https?:\/\//i.test(t) ? '' : t);
    // 没给脚本 → 仍标 uiV2，由引擎报「缺少 loginUi/loginAction 脚本」（Legado 同文案）
    return { ...none, kind: 'ui', js: v2js, needBrowser: BROWSER_API.test(v2js), uiV2: true };
  }

  // loginUi 存在（静态数组，或动态脚本——Legado 里 loginUi 可以是 @js: 生成数组）
  // 且 loginUrl 是脚本（Legado `login()` 入口）→ 「表单/按钮驱动登录」
  if (uiText && (uiFields.length > 0 || uiIsScript)) {
    const js = extractInlineJs(t) ?? (/^https?:\/\//i.test(t) ? '' : t);
    // loginUi 是按钮面板（无 text/password）时，登录动作全在按钮 action 里
    if (js) {
      return { ...none, kind: 'ui', js, needBrowser: BROWSER_API.test(js) };
    }
    // loginUi 有表单但没有 loginUrl 脚本：Legado 会「保存登录信息」后靠源其它规则使用
    if (uiFields.some((f) => f.type === 'text' || f.type === 'password')) {
      return { ...none, kind: 'ui', js: '', needBrowser: false };
    }
  }

  if (!t || t === 'null') return none;

  // ① 纯 URL：无脚本特征（`{` `}` `;` `function` `=>`）
  //   → 打开登录页人工验证（Legado：`showBrowser`）
  if (/^https?:\/\//i.test(t) && !/[{};]|\bfunction\b|=>/.test(t)) {
    return { ...none, kind: 'url', url: t };
  }
  // ①b 只填了域名（无协议）：`www.example.com` / `m.example.com/login`
  //    实测有源这么写（编辑器提示就是「填写网站登录网址」）→ 补 https:// 后当登录页
  if (/^[\w-]+(?:\.[\w-]+)+\/?(?:[^\s{};]*)$/i.test(t) && !/[{};]|\bfunction\b|=>/.test(t) && !t.includes('@')) {
    return { ...none, kind: 'url', url: `https://${t.replace(/^\/+/, '')}` };
  }

  // ② 第三方编辑器导出的 JSON 配置（源阅等）：{ "url": "https://…" }
  if (/^\{[\s\S]*\}$/.test(t)) {
    try {
      const o = JSON.parse(t) as { url?: unknown };
      const u = String(o.url ?? '').trim();
      if (/^https?:\/\//i.test(u)) return { ...none, kind: 'config-url', url: u };
    } catch {
      /* 不是合法 JSON → 落到脚本分支（有些 loginUrl 以 { 开头但其实是脚本块） */
    }
    return none;
  }

  // ③ 脚本：`<js>…</js>` / `@js:…` 取内层，否则整体当脚本（Legado getLoginJs）
  //   注：不再单独分 'js-browser' 类别 —— 见 engine.login 的说明（静态扫描会误判，
  //   实际是否需要浏览器要看**运行时错误**）。needBrowser 保留为提示信息。
  const js = extractInlineJs(t) ?? t;
  return { ...none, kind: 'js', js, needBrowser: BROWSER_API.test(js) };
}
