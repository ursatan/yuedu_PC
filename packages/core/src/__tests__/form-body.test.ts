/**
 * 回归锁：**POST 表单体编码**（2026-09-22，用户实测 ③ ⚡📂️独阅读网「缺少参数」）。
 *
 * 症状：站点回 `{"code":"200001","tip":"缺少参数"}`，搜索 0 条（基线 post7/post8c 里 search=ok:false）。
 * 真因：源把 AES 密文做成 form 体 `secret_content=<base64>`，而 base64 含 `+`；
 * `application/x-www-form-urlencoded` 语义下 **`+` 会被解成空格** ⇒ 密文损坏 ⇒ 站点解不开。
 *
 * 站点侧决定性对照（同一密文、只改 body 形态）：
 *   · base64 原样放 body        → 88 字符 / `缺少参数`（= 引擎当时的响应）
 *   · base64 做百分号编码       → 896 字符 / `login_token…` 成功
 *
 * 权威依据：Legado `AnalyzeUrl.kt:284-289`
 * ```kotlin
 * RequestMethod.POST -> body?.let {
 *     if (!it.isJson() && !it.isXml() && headerMap["Content-Type"].isNullOrEmpty()) { … encodeParams(body, charset, false) }
 * }
 * ```
 * 逐字段 `URLEncoder.encode`（Java 语义：空格→`+`，仅 `A-Za-z0-9` 与 `.-*_` 不编码）；
 * 「看起来已编码」的段（`NetworkUtils.encodedForm`：只含 `[0-9a-zA-Z*-._]` 或合法 `%XX`）**原样保留**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFormBody, isFormEncoded, javaFormEncode, looksJsonOrXml, withFormEncodedBody } from '../net/form-body';

test('javaFormEncode：Java URLEncoder 语义（空格→+，`+`→%2B，仅 A-Za-z0-9.-*_ 与 + 不编码）', () => {
  assert.equal(javaFormEncode('a b'), 'a+b');
  // base64 的 `+` 必须编码 —— 这正是用户实测那个缺陷的核心
  assert.equal(javaFormEncode('a+b'), 'a%2Bb');
  assert.equal(javaFormEncode('a/b='), 'a%2Fb%3D');
  assert.equal(javaFormEncode('中'), '%E4%B8%AD');
  assert.equal(javaFormEncode('-._*'), '-._*');
});

test('isFormEncoded：只含安全字符或合法 %XX 才视为已编码（防二次编码）', () => {
  assert.equal(isFormEncoded('abc123-._*'), true);
  assert.equal(isFormEncoded('a%2Bb'), true);
  assert.equal(isFormEncoded('a+b'), false);
  assert.equal(isFormEncoded('%zz'), false);
  assert.equal(isFormEncoded('a/b'), false);
});

test('encodeFormBody：按 & / = 拆字段逐段编码，已编码段原样保留', () => {
  // `+` 都被编码；`bookId=1` 这类纯净段保持原样
  assert.equal(encodeFormBody('secret_content=a+b&bookId=1', true), 'secret_content=a%2Bb&bookId=1');
  // checkEncoded=false（Legado 传 charset 时的分支）→ 不判"已编码"，全部再编码
  assert.equal(encodeFormBody('secret_content=a%2Bb', false), 'secret_content=a%252Bb');
  // 无 `=` 的裸段
  assert.equal(encodeFormBody('flag', true), 'flag');
});

test('looksJsonOrXml：JSON/XML 体不参与表单编码（Legado 的前置条件）', () => {
  assert.equal(looksJsonOrXml('{"a":1}'), true);
  assert.equal(looksJsonOrXml('[1,2]'), true);
  assert.equal(looksJsonOrXml('<xml/>'), true);
  assert.equal(looksJsonOrXml('a=1&b=2'), false);
});

test('withFormEncodedBody：POST 表单体编码 + 补默认 Content-Type；JSON 只补头不编码；源显式声明则完全不碰', () => {
  // ① 典型：base64 密文（含 +）→ 编码 + 默认表单头
  const r1 = withFormEncodedBody('POST', 'secret_content=ab+cd', {});
  assert.equal(r1.body, 'secret_content=ab%2Bcd');
  assert.equal(r1.headers['content-type'], 'application/x-www-form-urlencoded');

  // ② JSON 体：只补 application/json，**不动 body**（否则会破坏 JSON）
  const r2 = withFormEncodedBody('POST', '{"a":"b+c"}', {});
  assert.equal(r2.body, '{"a":"b+c"}');
  assert.equal(r2.headers['content-type'], 'application/json');

  // ③ 源显式声明 Content-Type（点众阅读就是这个形态）→ Legado 跳过 analyzeFields，体原样
  const r3 = withFormEncodedBody('POST', 'secret_content=ab+cd', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r3.body, 'secret_content=ab+cd');

  // ④ 非 POST / 无 body → 不介入
  assert.equal(withFormEncodedBody('GET', 'a+b', {}).body, 'a+b');
  assert.equal(withFormEncodedBody('POST', undefined, {}).body, undefined);
});
