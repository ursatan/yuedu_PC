/**
 * 「URL 构造」的 Legado 等价实现（`AnalyzeUrl.initUrl`）——`java.ajax/ajaxAll/get/post/head`
 * 这类**由脚本直接发起的请求**必须走同一套语义，否则源脚本拼出来的 URL 会被原样丢给 HTTP 层。
 *
 * 覆盖三步（逐条对齐 Legado `AnalyzeUrl.kt`）：
 *  1. `replaceKeyPageJs()` 第一步：`{{内嵌 JS}}` → **evalJS**（`AnalyzeUrl.kt:200-212`）
 *     ——注意 `<1,2,3>` 才是「页码模式」，`{{page}}` 在 Legado 里同样按 JS 求值（`page` 是绑定）。
 *  2. `replaceKeyPageJs()` 第二步：`<(1,2,3)>` 页码模式（`pagePattern = "<(.*?)>"`，`AnalyzeUrl.kt:801`）
 *  3. `analyzeUrl()`：按 `paramPattern = "\s*,\s*(?=\{"` **切首个** `,{` → URL 主体 + `UrlOption` JSON
 *     （method / headers / body / charset / retry / webView / webJs / js / bodyJs / type …）
 *
 * 为什么是「源码字符串」而不是普通 TS 函数：worker 沙箱（`sandbox/worker-pool.ts`）里的 java 桩是
 * 在 Worker 里以字符串源码求值的，无法 import TS 函数。这里导出**一份** JS 源码，L1（宿主）与 worker
 * 各自注入同一份逻辑，避免两处实现漂移（此前 worker 与 L1 的 java 面就因手抄副本漂移过）。
 */

import { parseJsonLoose } from '../json-loose';

/** 由 `URL_PREP_SOURCE` 定义出来的可调用对象（宿主侧类型） */
export interface UrlOptionLike {
  method?: unknown;
  charset?: unknown;
  headers?: unknown;
  body?: unknown;
  retry?: unknown;
  type?: unknown;
  webView?: unknown;
  webJs?: unknown;
  js?: unknown;
  bodyJs?: unknown;
  timeout?: unknown;
  followRedirects?: unknown;
  origin?: unknown;
  [k: string]: unknown;
}

export interface PreparedUrl {
  url: string;
  option: UrlOptionLike | null;
}

export interface PreparedRequest {
  url: string;
  method: 'GET' | 'POST' | 'HEAD';
  body?: string;
  headers: Record<string, string>;
  /** 选项原样保留（webView/webJs/js/type/charset/retry…），供上层决定是否走渲染层 */
  option: UrlOptionLike | null;
}

/* eslint-disable no-useless-escape */
export const URL_PREP_SOURCE = String.raw`
/**
 * 修非法 JSON 转义：JSON 里合法的只有 " \ / b f n r t uXXXX，其余 \X 补成 \\X。
 * 目的：解析手写 JSON 时保留反斜杠（正则片段 \d / \w / \.）。
 * 用 eval 兜底会把反斜杠吃掉（\d 变 d，正则 /(\d+)/ 退化成 /(d+)/），
 * 实测把悦读小说的 POST body 变成 bookId=d → 站点返 [] → 目录 0 章。
 */
function __yueduFixEscapes(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c !== '\\') { out += c; continue; }
    var nx = s.charAt(i + 1);
    if (nx === '') { out += '\\'; continue; }
    if ('"\\/bfnrtu'.indexOf(nx) >= 0) { out += c + nx; i++; continue; }
    out += '\\' + nx;
    i++;
  }
  return out;
}

/**
 * Legado AnalyzeUrl.initUrl 等价：{{内嵌 JS}} → <1,2,3> 页码 → ,{options} 拆分 → 相对路径绝对化。
 * 依赖调用方的全局绑定（page / baseUrl / source / java…），因为源脚本里这些就是全局可见的。
 */
function __yueduPrepareUrl(raw) {
  var s = String(raw == null ? '' : raw);
  // ① {{内嵌 JS}}（与 Legado 一致：内容是 JS 表达式，page/key 等就是绑定名）
  if (s.indexOf('{{') >= 0 && s.indexOf('}}') >= 0) {
    s = s.replace(/\{\{([\s\S]*?)\}\}/g, function (_m, expr) {
      try {
        var v = eval(expr);
        if (v == null) return '';
        if (typeof v === 'number' && v % 1 === 0) return String(Math.trunc(v));
        return String(v);
      } catch (e) {
        return '';
      }
    });
  }
  // ② 页码模式 <1,2,3>（Legado pagePattern = "<(.*?)>"）
  var pg = 1;
  try {
    if (typeof page !== 'undefined' && page != null && !isNaN(Number(page))) pg = Number(page);
  } catch (e) { /* page 未绑定 → 用 1 */ }
  if (s.indexOf('<') >= 0 && s.indexOf('>') >= 0) {
    s = s.replace(/<([^<>]+)>/g, function (_m, inner) {
      var parts = String(inner).split(',');
      var pick = pg < parts.length ? parts[pg - 1] : parts[parts.length - 1];
      return String(pick == null ? '' : pick).replace(/^\s+|\s+$/g, '');
    });
  }
  // ②.5 {,...}「可选段」——**不是 Legado 语法**，是源作者约定（咚漫 exploreUrl：
  //   https://m.dongmanmanhua.cn/genre{,/error.html}#LOVE）。上游 AnalyzeUrl 无此语法
  //   ⇒ 整段当字面量 ⇒ 站点 404（实测：去掉该段 = 200）。
  //   此处**剥离**该段取主 URL（超集：旧 404 → 新 200）。与③的选项尾巴形态不同
  //   （此处是 "{" + ","，③ 是 "," + "{"）⇒ 互不干扰；且本步在①②之后，不破坏 {{}} 求值结果。
  //   ⚠️ 本段在模板串内：注释里**不能出现反引号**（会提前掐断模板）。
  s = s.replace(/\{,[^}]*\}/g, '');
  // ③ ,{options} 尾巴（首个「逗号后紧跟 {」处切分，与 Legado paramPattern 一致）
  var out = { url: s, option: null };
  // 尾巴可能被**百分号编码**（源规则求值链路会编码 { " 空格）→ 先粗还原再切分，
  // 否则尾巴切不出来（整段当成 URL）或键值被污染成 %20body 之类（选项静默失效）。
  var probe = s;
  if (/%7B/i.test(probe)) {
    probe = probe.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/%22/g, '"').replace(/%20/g, ' ');
  }
  var m = /\s*,\s*(?=\{)/.exec(probe);
  if (m) {
    out.url = probe.slice(0, m.index);
    var optStr = probe.slice(m.index + m[0].length);
    /**
     * 解析顺序：**先原样**，解析失败才整体 decodeURIComponent。
     *
     * 旧实现是「只要含 %XX 就整体 decode」，与 #639（2026-10-26，书旗听书）撞车：
     * jsLib 预置的 POST 体是 data=<base64 的 percent-encoded 形态>（%2B / %2F / %2B%2B），
     * 整体 decode 会把它还原成 + 与 / —— 而 **form-urlencoded 里 + 就是空格** ⇒
     * 站点解出的密文全坏 ⇒ 500 {"message":"syntax error, po…"}。
     * 实测（同一 URL 同一 body）：引擎发出 …m7+N9f… → 500；curl 原样 …m7%2BN9f… → 200。
     *
     * 判据依据：若尾巴本身是**合法 JSON**，其中的 %XX 必然在**字符串值内部**，
     * 属于源作者的数据、必须原样保留；只有整条尾巴被百分号编码过（%7B%22…）时
     * 原样解析才会失败 —— 那时才需要 decode。
     */
    var cands = [optStr];
    if (/%[0-9A-Fa-f]{2}/.test(optStr)) {
      try { cands.push(decodeURIComponent(optStr)); } catch (e0) { /* 非法转义保持原样 */ }
    }
    for (var ci = 0; ci < cands.length && out.option == null; ci++) {
      var cand = cands[ci];
      try {
        out.option = JSON.parse(cand);
      } catch (e) {
        // GSON 宽松语义：允许单引号 / 无引号键（Legado 会打日志提示「JSON 格式不规范」）。
        // ⚠️ 先修「非法转义」再 JSON.parse，**不能直接 eval**：JS 字符串会吃掉未知转义的
        // 反斜杠（反斜杠 + d 变成 d），把 body 里的 /(\d+)/ 静默改成 /(d+)/
        // —— 实测源：悦读小说（POST body 变成 bookId=d → 站点返 [] → 目录 0 章）。
        try { out.option = JSON.parse(__yueduFixEscapes(cand)); }
        catch (e2) {
          try { out.option = eval('(' + cand + ')'); } catch (e3) { out.option = null; }
        }
      }
    }
  }
  out.url = String(out.url == null ? '' : out.url).replace(/^\s+|\s+$/g, '');
  // ④ 相对路径绝对化（NetworkUtils.getAbsoluteURL(baseUrl, url)）
  var b = '';
  try { if (typeof baseUrl !== 'undefined' && baseUrl) b = String(baseUrl); } catch (e) { /* 未绑定 */ }
  out.url = __yueduAbsolute(out.url, b);
  return out;
}

/**
 * 绝对化：**不能用 new URL()** —— 沙箱在求值期会把 URL shim 挂到 globalThis
 * （见 core/selector/js.ts 的 full.URL），宿主闭包里的 new URL(u, base) 会被劫持成
 * 单参版本并抛错（本条曾导致「java.ajax 的相对 URL 永远保留原样」）。这里纯字符串拼装。
 */
function __yueduAbsolute(u, base) {
  if (!u) return u;
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(u)) return u; // 已带协议
  if (u.indexOf('//') === 0) {
    var pm = base ? /^([a-zA-Z][a-zA-Z0-9+.\-]*:)/.exec(base) : null;
    return pm ? pm[1] + u : u;
  }
  if (!base) return u;
  var bm = /^([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\/?#]*)([^?#]*)/.exec(base);
  if (!bm) return u; // base 本身不是绝对 URL（如 file: 以外的怪值）→ 原样返回
  if (u.charAt(0) === '/') return bm[1] + u;
  var dir = (bm[2] || '/').replace(/[^\/]*$/, '');
  return bm[1] + dir + u.replace(/^\.\//, '');
}

/** UrlOption → 请求三元组（method / body / headers），对齐 Legado UrlOption 的取值语义 */
function __yueduOptionRequest(option, fallbackMethod, fallbackBody, fallbackHeaders) {
  var method = fallbackMethod || 'GET';
  var body = fallbackBody;
  var headers = {};
  if (fallbackHeaders && typeof fallbackHeaders === 'object') {
    for (var k in fallbackHeaders) {
      if (fallbackHeaders[k] != null) headers[k] = String(fallbackHeaders[k]);
    }
  }
  if (option && typeof option === 'object') {
    if (option.method != null && String(option.method) !== '') {
      var mm = String(option.method).toUpperCase();
      method = mm === 'POST' ? 'POST' : mm === 'HEAD' ? 'HEAD' : 'GET';
    }
    if (option.headers != null) {
      var hs = option.headers;
      // Legado：headers 既接受 Map<String,String>，也接受 [[k,v],…] 形态
      if (Array.isArray(hs)) {
        hs.forEach(function (pair) {
          if (Array.isArray(pair) && pair.length >= 2 && pair[0] != null) headers[String(pair[0])] = String(pair[1]);
        });
      } else if (typeof hs === 'object') {
        for (var hk in hs) if (hs[hk] != null) headers[hk] = String(hs[hk]);
      }
    }
    if (option.body != null) {
      // Legado getBody()：String 原样；对象/数组 → JSON 序列化（setBody 已把 JSON 串转成对象）
      body = typeof option.body === 'string' ? option.body : JSON.stringify(option.body);
    }
  }
  // POST 体的默认 Content-Type 与表单编码已移到两个出口统一处理：
  //   · L1     → selector/js.ts 的 syncHttp（所有同步 HTTP 的唯一出口）
  //   · worker → 宿主 hostRpc('http') 分支
  //   两者都调 net/form-body.ts 的 withFormEncodedBody（同一份实现）。
  //
  // 为什么不在这里做（曾在这里，2026-09-22 移出）：本函数是**共享源码串**
  // （URL_PREP_SOURCE，L1 与 worker 各编译一份），若在这里补 Content-Type，
  // 出口处就分不清「源作者显式声明的 Content-Type」与「我们自动补的」——
  // 而 Legado 的表单编码判据恰恰是「源没显式声明 Content-Type」（AnalyzeUrl.kt:286）。
  // 实测后果：独阅读网的 secret_content=<base64>（含 +）被跳过编码
  // → 站点解码失败 → {"code":"200001","tip":"缺少参数"}。
  //
  // 注意：不要在这里再补 Content-Type（会造成上述误判），出口处会补。
  return { method: method, body: body, headers: headers };
}
`;

/** 宿主侧（L1）：把源码编译成可直接调用的两个函数 */
const compiled = ((): {
  prepare: (raw: string) => PreparedUrl;
  toRequest: (
    option: UrlOptionLike | null,
    fallbackMethod?: string,
    fallbackBody?: string,
    fallbackHeaders?: Record<string, unknown>,
  ) => { method: 'GET' | 'POST' | 'HEAD'; body?: string; headers: Record<string, string> };
} => {
  try {
    // Function 体是非严格作用域 → 内部 eval 能把全局绑定（page/baseUrl/…）解析到 globalThis
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      `${URL_PREP_SOURCE}; return { prepare: __yueduPrepareUrl, toRequest: __yueduOptionRequest };`,
    ) as () => {
      prepare: (raw: string) => PreparedUrl;
      toRequest: (
        option: UrlOptionLike | null,
        fallbackMethod?: string,
        fallbackBody?: string,
        fallbackHeaders?: Record<string, unknown>,
      ) => { method: 'GET' | 'POST' | 'HEAD'; body?: string; headers: Record<string, string> };
    };
    return factory();
  } catch {
    return {
      prepare: (raw: string) => ({ url: String(raw ?? '').trim(), option: null }),
      toRequest: (_o, fallbackMethod, fallbackBody, fallbackHeaders) => ({
        method: (fallbackMethod as 'GET' | 'POST' | 'HEAD') ?? 'GET',
        body: fallbackBody,
        headers: Object.fromEntries(
          Object.entries(fallbackHeaders ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
        ),
      }),
    };
  }
})();

/** 解析 URL（含 `,{options}` 尾巴、`{{}}` 与 `<1,2,3>`） */
export function prepareUrl(raw: string): PreparedUrl {
  return compiled.prepare(raw);
}

/**
 * `#405②` 剥离 `{,...}`「可选段」（**非 Legado 语法**，源作者约定）。
 *
 * 咚漫 `exploreUrl` 的分类值形如 `https://…/genre{,/error.html}#LOVE`：上游 `AnalyzeUrl`
 * 没有该语法（唯一切分正则 `\s*,\s*(?=\{)`）⇒ 整段被当字面量 ⇒ 站点 **404**（实测：
 * 去掉该段 = 200）。本仓取**主 URL**（超集，旧 404 → 新 200）。
 * ⚠️ 判据 `{,` 与 Legado 的选项尾巴 `,{` 不同，**不会**误伤 `,{options}`。
 * 唯一实现 —— `__yueduPrepareUrl`（脚本宿主）与 `splitUrlOptions`（纯 TS）都调它。
 */
export function stripOptionalUrlSegments(raw: string): string {
  return String(raw ?? '').replace(/\{,[^}]*\}/g, '');
}

/** 纯 TS 版：把 URL 拆成「主体 + 选项」（不含 `{{}}`/页码，供宿主非脚本路径复用） */
export function splitUrlOptions(raw: string): { url: string; option: UrlOptionLike | null } {
  const s = stripOptionalUrlSegments(String(raw ?? ''));
  const m = /\s*,\s*(?=\{)/.exec(s);
  if (!m) return { url: s.trim(), option: null };
  const url = s.slice(0, m.index).trim();
  const optStr = s.slice(m.index + m[0].length).trim();
  try {
    return { url, option: JSON.parse(optStr) as UrlOptionLike };
  } catch {
    // 手写 JSON：先用 core 的宽松解析（保留反斜杠——new Function 会把 \d 吃成 d）
    const loose = parseJsonLoose(optStr);
    if (loose && typeof loose === 'object') return { url, option: loose as UrlOptionLike };
    return { url, option: null };
  }
}

/** 组装一次请求：解析 URL → 选项覆盖 method/body/headers */
export function prepareRequest(
  raw: string,
  fallback: { method?: 'GET' | 'POST' | 'HEAD'; body?: string; headers?: Record<string, unknown> } = {},
): PreparedRequest {
  const parsed = prepareUrl(raw);
  const req = compiled.toRequest(parsed.option, fallback.method, fallback.body, fallback.headers);
  return { url: parsed.url, method: req.method, body: req.body, headers: req.headers, option: parsed.option };
}

/**
 * 只做「选项 → 请求三元组」映射（method/body/headers），不碰 URL 本体。
 *
 * 供**已经把 URL 求值/补全完**的调用方复用（如 engine-rss 的 `,{options}` 尾巴：
 * 模板插值走它自己的链路，只有尾巴的 method/body/headers 需要与 legado 同语义）。
 * 判据与 `prepareRequest` 同源（`__yueduOptionRequest` 一份实现）——别在调用方重写
 * method 大小写归一 / headers 数组形态 / body JSON 序列化（同一判据写两处必然漂移）。
 */
export function optionToRequest(
  option: UrlOptionLike | null,
  fallback: { method?: 'GET' | 'POST' | 'HEAD'; body?: string; headers?: Record<string, unknown> } = {},
): { method: 'GET' | 'POST' | 'HEAD'; body?: string; headers: Record<string, string> } {
  return compiled.toRequest(option, fallback.method, fallback.body, fallback.headers);
}

/**
 * URL 规则里的 JS 段求值（`#382`：对齐上游 `AnalyzeUrl.analyzeJs`，`AnalyzeUrl.kt:172-193`）。
 *
 * 上游判据（**一处实现**，rss / legado 两个引擎的 URL 构造都必须走这里，别再各自写
 * `startsWith('@js:')`）：`JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/i` 配
 * `Matcher.find()` **全文扫描** —— `@js:` 在 URL **任意位置**都触发（qyyuapi 聚合源
 * `sortUrl`/`sourceUrl` 的真实形态是 `Movieffm@js:`…``：分类名前缀 + 中缀 JS 标记）。
 *
 * 逐条对齐上游 analyzeJs：
 *  1. 每个匹配段：匹配点之前的前缀（非空时）以 `@result` 占位拼接进累积结果；
 *  2. `result = evalJS(段代码, result)` —— JS 结果**整体替换**当前值（前缀除非写
 *     `@result` 否则被丢弃，这是上游原语义：`Movieffm` 分类名前缀就是这么消失的）；
 *  3. `@js:` 组贪婪吃满剩余全文（无后续匹配）；`<js>…</js>` 可多段连排，结果跨段传递；
 *  4. 尾部残余（`<js>` 块之后的普通文本）同样按 `@result` 拼接。
 * `{{}}` 内插**不在这里**做 —— 上游 `replaceKeyPageJs` 在 analyzeJs **之后**跑，调用方
 * （buildFeedRequest 等）在本函数返回后继续 `{{}}` 求值，顺序一致。
 *
 * JS 返回 null/undefined 时按空串继续（上游 Kotlin `Any?.toString()` 得 "null" 字符串、
 * 实际请求同样失败——这里取空串让 `@result` 拼接语义可预测，比拼出字面 "null" URL 好）。
 */
export async function applyUrlRuleJs(
  raw: string,
  evalJs: (code: string, currentResult: string) => Promise<string | null> | string | null,
): Promise<string> {
  const re = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
  let result = raw;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > consumed) {
      const prefix = raw.slice(consumed, m.index).trim();
      if (prefix) result = prefix.split('@result').join(result ?? '');
    }
    const out = await evalJs(m[2] ?? m[1] ?? '', result ?? '');
    result = out == null ? '' : out;
    consumed = m.index + m[0].length;
    if (m[2] !== undefined) break; // @js: 贪婪吃满剩余全文
  }
  if (raw.length > consumed) {
    const tail = raw.slice(consumed).trim();
    if (tail) result = tail.split('@result').join(result ?? '');
  }
  return result;
}
