/**
 * POST 表单体编码（Legado `AnalyzeUrl` 的 `analyzeFields` / `encodeParams` 语义）。
 *
 * ## 为什么需要
 *
 * 源把请求体写成 form 形态（`k=v&k2=v2`）时，值里可能出现 **`+`**（base64 密文、签名）。
 * `application/x-www-form-urlencoded` 的语义下 `+` 会被解码成**空格** ⇒ 服务端拿到坏数据。
 * 实测（2026-09-22，⚡📂️独阅读网 `/signup/auto_reg`，站点侧对照同一密文只改 body 形态）：
 *   · `secret_content=<base64 原样>`      → 88 字符 `{"code":"200001","tip":"缺少参数"}` ❌
 *   · `secret_content=<base64 带 %2B>`    → 896 字符 `{"code":"100000","login_token":…}` ✅
 * 这就是用户报告的「分类获取失败：ERROR:缺少参数」的真因 —— **不是站点问题**。
 *
 * ## Legado 的权威语义（`AnalyzeUrl.kt`）
 *
 * ```kotlin
 * // :284-289 —— 什么时候编码
 * RequestMethod.POST -> body?.let {
 *     if (!it.isJson() && !it.isXml() && headerMap["Content-Type"].isNullOrEmpty()) {
 *         analyzeFields(it)              // encodedForm = encodeParams(body, charset, false)
 *     }
 * }
 * // :470-473 —— 什么时候用编码结果
 * if (!encodedForm.isNullOrEmpty() || body.isBlank()) postForm(encodedForm ?: "")
 * else if (contentType.isNotBlank())                 body.toRequestBody(contentType)
 * else                                               postJson(body)
 * ```
 *
 * `encodeParams`（`:315-371`）按 `&` 拆字段、首个 `=` 拆键值，**逐段**编码；
 * 但「看起来已经编码好」的段（`NetworkUtils.encodedForm`：只含 `[0-9a-zA-Z*-._]` 或合法 `%XX`）
 * 原样保留 ⇒ 不会二次编码（源里已经手写 `%20` 的体不会被破坏）。
 *
 * `URLEncoder.encode`（Java 语义，**不是** `encodeURIComponent`）：空格 → `+`，
 * 仅 `A-Za-z0-9` 与 `.-*_` 不编码，其余按 UTF-8 字节 `%XX`（大写十六进制）。
 */

/** Java `URLEncoder.encode(s, "UTF-8")` */
export function javaFormEncode(s: string): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf-8')) {
    const ch = String.fromCharCode(byte);
    // Java `URLEncoder.encode` 的"安全集"：字母数字 **与 `-._*`**（见 JDK 文档原文）
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      ch === '-' ||
      ch === '.' ||
      ch === '_' ||
      ch === '*'
    ) {
      out += ch;
    } else if (ch === ' ') {
      out += '+';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Legado `NetworkUtils.encodedForm`：仅 `[0-9a-zA-Z*-._]` + 合法 `%XX` ⇒ 视为已编码 */
export function isFormEncoded(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (/[0-9a-zA-Z*\-._]/.test(c)) continue;
    if (c === '%' && i + 2 < s.length && /[0-9A-Fa-f]/.test(s[i + 1] as string) && /[0-9A-Fa-f]/.test(s[i + 2] as string)) {
      i += 2;
      continue;
    }
    return false;
  }
  return true;
}

/** Legado `AnalyzeUrl.encodeParams(params, charset, isQuery = false)`：按 `&`/`=` 拆字段逐段编码 */
export function encodeFormBody(body: string, checkEncoded: boolean): string {
  const parts: string[] = [];
  for (const seg of body.split('&')) {
    const eq = seg.indexOf('=');
    if (eq < 0) {
      parts.push(checkEncoded && isFormEncoded(seg) ? seg : javaFormEncode(seg));
      continue;
    }
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    parts.push(
      `${checkEncoded && isFormEncoded(k) ? k : javaFormEncode(k)}=${checkEncoded && isFormEncoded(v) ? v : javaFormEncode(v)}`,
    );
  }
  return parts.join('&');
}

/** Legado `String.isJson()`（trim 后 `{…}`/`[…]`）/ `String.isXml()`（trim 后 `<…>`） */
export function looksJsonOrXml(s: string): boolean {
  const t = s.trim();
  return (
    (t.startsWith('{') && t.endsWith('}')) ||
    (t.startsWith('[') && t.endsWith(']')) ||
    (t.startsWith('<') && t.endsWith('>'))
  );
}

/**
 * 需要时把 POST 体编码成 form 形态，并补齐 `Content-Type`。
 *
 * 判据与 Legado 一致：**POST** + 体非空 + **非 JSON/XML** + **显式 Content-Type 不存在**。
 * 返回新对象（不改入参）；不需要编码时原样返回，`body` 引用不变（零成本）。
 *
 * ⚠️ 有意偏离 Legado 一处：Legado 查的是 `headerMap["Content-Type"]`（**大小写敏感**），
 * 这里按大小写不敏感判定 —— 源写 `content-type` 时同样应视为「作者已声明」，
 * 否则会把它本已写好的体再编码一遍。
 */
export function withFormEncodedBody(
  method: string,
  body: string | undefined,
  headers: Record<string, string>,
): { body: string | undefined; headers: Record<string, string> } {
  if (String(method).toUpperCase() !== 'POST' || !body) return { body, headers };
  const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (hasCt) return { body, headers }; // 源已声明 Content-Type ⇒ Legado 跳过 analyzeFields，体原样
  const isJson = /^\s*[\{\[]/.test(body);
  const ct = isJson ? 'application/json' : 'application/x-www-form-urlencoded';
  // JSON/XML 体不编码（Legado 的 `!it.isJson() && !it.isXml()` 前置条件），只补默认 Content-Type
  if (isJson || looksJsonOrXml(body)) return { body, headers: { ...headers, 'content-type': ct } };
  return { body: encodeFormBody(body, true), headers: { ...headers, 'content-type': ct } };
}
