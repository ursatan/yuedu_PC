/**
 * 「闸页」静默过闸（`D11=C` 的 **B** 半）—— 判据的唯一实现。
 *
 * ## 闸页形态（2026-10-12 对 18AV `mjv006.com` 实测取证）
 * 业务请求被站点拦下，**回 200 但正文是一个 1814 字节的「年满18岁声明」页**：
 * ```html
 * <input id='fwin_dialog_submit' class='scale_button'
 *        onclick='window.location="https://mjv006.com/zh/chinese_IamOverEighteenYearsOld/19/index.html"'>
 * ```
 * 过闸 = GET 那个目标 URL（站点回 `Set-Cookie: YES_Eighteen=IamOverEighteenYearsOld`），
 * 再带该 Cookie 重放原请求。**实测有效**（同一探针：过闸前 1814 字节闸页 → 过闸后重放 44761 字节真列表）。
 *
 * ## 为什么做成「框架级」而不是让源自己写
 * 源作者确实在 `jsLib` 里手写了过闸（18AV 的 `rrcheck()`：`java.connect(url19).headers().values('Set-Cookie')`
 * → `source.putLoginHeader` → `cookie.setWebCookie` → `sleep(120)` → `java.ajax(url)` 重放）——
 * 但那要求**每个源**都写一遍，且依赖 `sleep`/`java.connect` 等一串原语全部到位（`#409`/`#410` 修的就是它们）。
 * 放在 HTTP 出口上做，任何源的任何 `java.ajax/get/post` 都自动过闸，且与源侧手写**不冲突**（幂等：
 * 过闸后的请求不再含闸页特征）。
 *
 * ## 触发面与边界（从严，防误伤）
 * - **只认这两种特征**（`fwin_dialog_submit` 中文站常见 / URL 含 `IamOverEighteenYearsOld`）+ HTML 且体积小；
 * - **只在 GET** 上触发（对声明页做 POST 没有语义）；
 * - 只过**一层**（不递归）；重放仍拿到闸页/空 ⇒ 保留原响应，交给上层（见引擎的 emptyHint / 登录窗口通道）。
 *
 * ⚠️ `applySessionCookie` 是这条链的**前置条件**：过闸刚拿到的 Cookie 存在源 CookieStore 里
 * （`cookie.setWebCookie` / 登录窗口 harvest 都写这里），而源 `header` 规则常写
 * `'Cookie': source.getLoginHeader()`（本次会话里往往还是**空串**）—— 空值头会**遮蔽**真 Cookie，
 * 于是「过了闸也发不出去」。空串对 Cookie 这个头而言只能是「未填写」，故让位给 CookieStore。
 */

/** 闸页识别结果：过闸目标（绝对 URL） */
export interface AgeGatePlan {
  target: string;
}

/** 闸页都很小（实测 1814 字节）；正常列表/正文页远大于此 ⇒ 大于这个上限直接不认，省一次全串扫描 */
const MAX_GATE_HTML = 64 * 1024;

/**
 * ★ **必须捕获真正的 `URL` 构造器**（`D11` 实测踩坑）。
 *
 * 本函数会被 **L1 求值内的调用链**调用（`java.ajax` → `syncHttp` → 这里），而 L1 的历史包袱之一是
 * 它在 eval 期间把绑定挂到 `globalThis` 上 —— 其中 `URL` 被换成了 Rhino 兼容 shim
 * `function(u){ return new URL(String(u)); }`（见 `createJsEvaluator` 的 `full.URL`）。
 * 于是这里 `new URL(raw, pageBase)` 命中那个 shim ⇒ **不走 base、且自己递归自己** ⇒ 抛
 * `RangeError: Maximum call stack size exceeded` ⇒ 被下面的 try 吞掉 ⇒ 永远 `null`
 * （症状：闸页识别在 worker 路径正常、在 L1 路径**永远不触发** —— 极难定位）。
 * 模块加载期捕获一份真构造器即可（标注：worker 宿主侧没有这层遮蔽，行为一致）。
 */
const RealURL = URL;

/**
 * 是不是「年满18岁声明」闸页？是则给出过闸目标 URL。
 * @param html 响应体
 * @param pageUrl 本次请求的 URL（用于把相对目标绝对化 + 防自跳）
 */
export function planAgeGatePass(html: string, pageUrl: string): AgeGatePlan | null {
  const s = typeof html === 'string' ? html : '';
  if (!s || s.length > MAX_GATE_HTML) return null;
  if (!/fwin_dialog_submit|IamOverEighteenYearsOld/i.test(s)) return null;

  // onclick 的属性值里嵌套了双引号（`onclick='window.location="https://…"'`）⇒ 属性引号必须**成对**匹配，
  // 不能用 [^"']*（那会截在 window.location= 就停，实测踩过）。
  const el = s.match(/<[^>]*id=["']?fwin_dialog_submit["']?[^>]*>/i)?.[0] ?? '';
  const onclick =
    (el.match(/onclick='([^']*)'/i)?.[1] ??
      el.match(/onclick="([^"]*)"/i)?.[1] ??
      s.match(/onclick='([^']*IamOverEighteenYearsOld[^']*)'/i)?.[1] ??
      s.match(/onclick="([^"]*IamOverEighteenYearsOld[^"]*)"/i)?.[1] ??
      s.match(/https?:\/\/[^"'\s]*IamOverEighteenYearsOld[^"'\s]*/i)?.[0]) ??
    '';
  const raw = onclick.match(/https?:\/\/[^"'\s]+/i)?.[0];
  if (!raw) return null;
  let target: string;
  try {
    target = new RealURL(raw, pageUrl).href; // RealURL：L1 eval 会把 globalThis.URL 换成 shim，见上方注释
  } catch {
    return null;
  }
  // 目标就是当前页 ⇒ 不是可过闸的声明页（防自跳/死循环）
  if (target === pageUrl) return null;
  return { target };
}

/** 便宜的「是不是闸页」谓词（引擎给用户的 empty-hint 用；不需要目标 URL 可解析） */
export function isAgeGatePage(html: string): boolean {
  const s = typeof html === 'string' ? html : '';
  return s.length > 0 && s.length <= MAX_GATE_HTML && /fwin_dialog_submit|IamOverEighteenYearsOld/i.test(s);
}

/**
 * **类CD（2026-10-26）「JS 下发的 Cookie 闸页」**：站点回一个几百字节的空壳页，
 * 里面只有 `document.cookie = "k=v; path=/; max-age=…"; window.location.reload();`
 * ⇒ 浏览器执行脚本、带 Cookie 重载就能拿到真内容。
 *
 * 实测（📂智能书库 zzbook，`/go/4/4371/` 详情页 278 字节）：
 * ```html
 * <script>document.cookie = "ge_js_validator_20=<ts>@20@<md5>; path=/; max-age=3600;";
 *         window.location.reload();</script>
 * ```
 * 引擎不跑页面脚本 ⇒ 只能拿到这 278 字节空壳 ⇒ 目录 0 / 正文空。
 *
 * **上游无对应实现**：Legado 靠 WebView 渲染（它会执行脚本），本仓没有 Android WebView，
 * 所以用「把脚本要写的 Cookie 直接塞进 Cookie 头重放一次」做等价实现（幂等：重放后不再命中）。
 *
 * 触发面从严（防误伤正常页面）：体积 ≤4KB + 必须同时出现 `document.cookie=` 赋值
 * 与 `location.reload()`；只取**第一段** `k=v`（后续是 path/max-age 属性）。
 */
export interface CookieGatePlan {
  /** 要发送的 `k=v`（不含 path/expires 等属性） */
  cookie: string;
}

const MAX_COOKIE_GATE_HTML = 4096;

export function planCookieGatePass(html: string): CookieGatePlan | null {
  const s = typeof html === 'string' ? html : '';
  if (!s || s.length > MAX_COOKIE_GATE_HTML) return null;
  if (!/location\s*\.\s*reload\s*\(/i.test(s)) return null;
  const m = s.match(/document\s*\.\s*cookie\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  const first = (m[1] ?? '').split(';')[0]?.trim() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return { cookie: first };
}

/**
 * 「空值的 Cookie 头不遮蔽会话 Cookie」——返回需要写入/改写的 `{key, value}`；`null` = 保持原样。
 *
 * 三种情形：
 *  · headers 里**没有** Cookie 头 → 写入 `Cookie: <store>`（= 旧行为，`!some(k===cookie)` 分支）；
 *  · 有 Cookie 但**值为空/空白** → **改写**成 store 的值（源 header 规则里 `'Cookie': ''` 的真实语义是
 *    「我还没登录信息」，不是「显式清空」；不改写就永远发不出登录窗口/过闸拿到的 Cookie）；
 *  · 有 Cookie 且**非空** → 尊重源作者给的值（可能是它自己拼的多段 Cookie）。
 */
export function sessionCookieOverride(headers: Record<string, string>,
  storeCookie: string,
): { key: string; value: string } | null {
  if (!storeCookie) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
  if (key === undefined) return { key: 'Cookie', value: storeCookie };
  if (String(headers[key] ?? '').trim() === '') return { key, value: storeCookie };
  return null;
}

/** 就地把会话 Cookie 应用到请求头（两个 HTTP 出口共用这一份判据，防漂移）。返回是否改写过 */
export function applySessionCookie(headers: Record<string, string>, storeCookie: string): boolean {
  const pick = sessionCookieOverride(headers, storeCookie);
  if (!pick) return false;
  headers[pick.key] = pick.value;
  return true;
}