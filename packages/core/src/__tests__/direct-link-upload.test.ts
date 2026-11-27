/**
 * `#208` 直链上传：规则模型 + 校验 + 配置解析的纯函数单测。
 *
 * 上游语义逐条对照 `DirectLinkUpload.kt` / `DirectLinkUploadConfig.kt` /
 * `defaultData/directLinkUpload.json`（2026-10-06 读源码提取）。
 * ★ 防空转约定：每个「拒绝」用例旁边都有能通过的对照（同函数、同形状、换一个字段），
 *   证明链路本来是通的，不是断言写错导致恒真/恒假。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DIRECT_LINK_UPLOAD_RULES,
  DIRECT_LINK_UPLOAD_FILE_TOKEN,
  parseDirectLinkUploadRules,
  validateDirectLinkUploadRule,
} from '../direct-link-upload';
import { SOURCE_SHARE_MAX_EXPIRY_DAYS } from '../source-share-passphrase';

const OK = {
  uploadUrl: 'https://example.com/up,{"method":"POST","body":{"file":"fileRequest"}}',
  downloadUrlRule: '$.data',
  summary: '测试网盘',
  compress: false,
  expiryDate: 30,
};

test('#208 内置规则 = 上游 defaultData 的 3 条，字段与顺序逐条一致', () => {
  assert.equal(DEFAULT_DIRECT_LINK_UPLOAD_RULES.length, 3, '上游 json 恰 3 条');
  const summaries = DEFAULT_DIRECT_LINK_UPLOAD_RULES.map((r) => r.summary);
  assert.deepEqual(summaries, [
    '喵公子网盘①(有效期30天·香港G口)',
    '喵公子网盘②(有效期7天)',
    '橘涂书源网盘2.0 Beta(永久有效)',
  ]);
  const expiries = DEFAULT_DIRECT_LINK_UPLOAD_RULES.map((r) => r.expiryDate);
  assert.deepEqual(expiries, [30, 7, 0], '有效期 30 / 7 / 0(永久)');
  // 上游 3 条都是 compress:false（这一条很关键：若哪天改成 true，本仓 zip 路径必须真的对）
  assert.deepEqual(
    DEFAULT_DIRECT_LINK_UPLOAD_RULES.map((r) => r.compress),
    [false, false, false],
  );
  // 每条都要能通过自己的校验器（内置规则不该被自己的规则判非法）
  for (const r of DEFAULT_DIRECT_LINK_UPLOAD_RULES) {
    const v = validateDirectLinkUploadRule(r);
    assert.equal(v.ok, true, `${r.summary} 应合法：${v.ok ? '' : v.error}`);
  }
});

test('#208 内置规则里的 uploadUrl 都带 UrlOption 尾巴（否则解析不出 method/body）', () => {
  for (const r of DEFAULT_DIRECT_LINK_UPLOAD_RULES) {
    assert.ok(r.uploadUrl.includes(',{'), `${r.summary} 的 uploadUrl 应含 ,{ 选项段`);
    const optText = r.uploadUrl.slice(r.uploadUrl.indexOf(',{') + 1);
    const opt = JSON.parse(optText) as Record<string, unknown>;
    assert.equal(opt['method'], 'POST');
    assert.equal(opt['type'], 'multipart/form-data');
    const body = opt['body'] as Record<string, unknown>;
    // 上游语义：值为字面量 fileRequest 的那一项才是文件部件
    assert.ok(
      Object.values(body).includes(DIRECT_LINK_UPLOAD_FILE_TOKEN),
      `${r.summary} 的 body 应有且仅有 fileRequest 标记`,
    );
  }
});

test('#208 校验：四个字段各自空 ⇒ 各自的错误文案（对齐上游 toast）', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...OK, uploadUrl: '' }, '上传Url不能为空'],
    [{ ...OK, uploadUrl: '   ' }, '上传Url不能为空'],
    [{ ...OK, downloadUrlRule: '' }, '下载Url规则不能为空'],
    [{ ...OK, summary: '  ' }, '注释不能为空'],
  ];
  for (const [raw, expected] of cases) {
    const r = validateDirectLinkUploadRule(raw);
    assert.equal(r.ok, false, `应被拒绝：${expected}`);
    if (r.ok) continue;
    assert.equal(r.error, expected);
  }
  // ★ 对照：同形状、只把该字段填回去 ⇒ 立刻通过（证明拒绝是「因为那个字段」而不是别的原因）
  assert.equal(validateDirectLinkUploadRule(OK).ok, true);
});

test('#208 校验：expiryDate 只认 0..36500 的整数（含字符串整数字面量）', () => {
  const bad: unknown[] = [-1, SOURCE_SHARE_MAX_EXPIRY_DAYS + 1, 1.5, '30.5', 'abc', null, undefined];
  for (const v of bad) {
    const r = validateDirectLinkUploadRule({ ...OK, expiryDate: v });
    assert.equal(r.ok, false, `expiryDate=${String(v)} 应被拒绝`);
  }
  // 边界：0（永久）与上限都合法
  for (const v of [0, SOURCE_SHARE_MAX_EXPIRY_DAYS]) {
    assert.equal(validateDirectLinkUploadRule({ ...OK, expiryDate: v }).ok, true, `${v} 应合法`);
  }
  // 上游 `toIntOrNull()`：字符串整数等价于数字
  const str = validateDirectLinkUploadRule({ ...OK, expiryDate: '7' });
  assert.equal(str.ok, true);
  if (str.ok) assert.equal(str.rule.expiryDate, 7);
});

test('#208 校验：compress 缺省为 false；非对象入参被拒', () => {
  const noCompress = { ...OK } as Record<string, unknown>;
  delete noCompress['compress'];
  const r = validateDirectLinkUploadRule(noCompress);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.rule.compress, false, '缺省即 false（对齐上游 data class 默认值）');

  for (const bad of [null, undefined, 42, 'x', [], [{ ...OK }]]) {
    assert.equal(validateDirectLinkUploadRule(bad).ok, false, `${JSON.stringify(bad)} 不是规则对象`);
  }
});

test('#208 校验：downloadUrlRule 原样保留（不 trim，默认规则含换行与缩进）', () => {
  const weird = "$.data@js:if (result == '') \n '' \n else \n 'x/' + result";
  const r = validateDirectLinkUploadRule({ ...OK, downloadUrlRule: weird });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.rule.downloadUrlRule, weird, '规则文本必须逐字节保留');
});

test('#208 解析粘贴配置：单个对象 / 数组 / 宽松 json 三种形态', () => {
  const one = parseDirectLinkUploadRules(JSON.stringify(OK));
  assert.equal(one.ok, true);
  if (one.ok) {
    assert.equal(one.rules.length, 1);
    assert.equal(one.rules[0]?.summary, '测试网盘');
  }

  const arr = parseDirectLinkUploadRules(JSON.stringify([OK, { ...OK, summary: '第二个' }]));
  assert.equal(arr.ok, true);
  if (arr.ok) assert.deepEqual(arr.rules.map((r) => r.summary), ['测试网盘', '第二个']);

  // 宽松：尾逗号 + `//` 注释（用户从别处抄来的 json 常见）
  const loose = parseDirectLinkUploadRules(`{
    // 我的网盘
    "uploadUrl": "https://a.com/u",
    "downloadUrlRule": "$.msg",
    "summary": "注释",
    "expiryDate": 0,
  }`);
  assert.equal(loose.ok, true, loose.ok ? '' : loose.error);
  if (loose.ok) assert.equal(loose.rules[0]?.uploadUrl, 'https://a.com/u');
});

test('#208 解析粘贴配置：坏输入给「指得出哪一条」的错误，不静默丢弃', () => {
  assert.equal(parseDirectLinkUploadRules('').ok, false);
  assert.equal(parseDirectLinkUploadRules('   ').ok, false);
  const notJson = parseDirectLinkUploadRules('hello 世界');
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.match(notJson.error, /合法 JSON/);

  const emptyArr = parseDirectLinkUploadRules('[]');
  assert.equal(emptyArr.ok, false);

  // ★ 数组里第 2 条坏 ⇒ 报「第 2 条」且整体失败（不返回只含第 1 条的「成功」）
  const partial = parseDirectLinkUploadRules(JSON.stringify([OK, { ...OK, summary: '' }]));
  assert.equal(partial.ok, false);
  if (!partial.ok) {
    assert.match(partial.error, /第 2 条/);
    assert.match(partial.error, /注释不能为空/);
  }
});

test('#208 解析粘贴配置：内置规则表 json 能整体往返（导入默认的等价物）', () => {
  const r = parseDirectLinkUploadRules(JSON.stringify(DEFAULT_DIRECT_LINK_UPLOAD_RULES));
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) assert.deepEqual(r.rules, DEFAULT_DIRECT_LINK_UPLOAD_RULES.map((x) => ({ ...x })));
});
