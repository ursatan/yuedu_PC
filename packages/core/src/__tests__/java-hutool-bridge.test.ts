/**
 * 回归锁：**`Packages.cn.hutool.*` Java 类桥**（缺陷类AO，2026-09-23）。
 *
 * 背景（用户实测 ②）：🏷七猫四合一本地版「发现页无内容卡片：站点返回 {"Status":"Unauthorized"}」。
 * 该源 jsLib 的签名链是
 *     `qmSign(v) = qmMd5(v + QM_SECRET)`；`qmMd5(v) = Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex(v)`
 * 而 `cn` 是**未实现的顶级包** → 落进 `makeJavaPackages` 的 `nest()` 兜底（调用一律返回空串）
 * ⇒ `sign` 头 / `qm-request-id` 头 / URL 上的 `sign=` 查询参数**全是空串**
 * ⇒ 站点判签名缺失 → 401。登录接口不校验签名，所以同一轮里登录还是 200 —— 典型的「一半成功一半失败」。
 *
 * 站点侧因果对照（同一 URL，只去掉 `sign` 头）：带 → 200 / 22514 字节；去掉 → 401。
 *
 * 本测试锁两件事：
 *   ① 摘要/编码的**真值**（不是空串，也不是占位）；
 *   ② `JavaImporter.importPackage(Packages.cn.hutool.*)` 之后**裸类名**可用
 *      —— 这要求命名空间是真对象（Proxy 没有 own keys，importPackage 一个类名都挂不上）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

const ev = () => createJsEvaluator({ variables: createVariableStore() });
const run = (code: string): unknown => ev()(code, {});

test('Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex 返回真 md5（不是空串）', () => {
  const r = run(`String(Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex('abc'))`);
  assert.equal(r, '900150983cd24fb0d6963f7d28e17f72');
});

test('DigestUtil.md5 与 digester(algo).digestHex 同值（hutool 别名语义）', () => {
  const a = run(`String(Packages.cn.hutool.crypto.digest.DigestUtil.md5('abc'))`);
  const b = run(`String(Packages.cn.hutool.crypto.digest.DigestUtil.digester('MD5').digestHex('abc'))`);
  const c = run(`String(Packages.cn.hutool.crypto.digest.DigestUtil.digester('SHA-256').digestHex('abc'))`);
  assert.equal(a, '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(b, '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(c, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Packages.cn.hutool.core.codec.Base64.encode（长佩文学用法）', () => {
  assert.equal(run(`String(Packages.cn.hutool.core.codec.Base64.encode('abc'))`), 'YWJj');
  assert.equal(
    run(`String(Packages.cn.hutool.core.codec.Base64.decodeStr('YWJj'))`),
    'abc',
  );
});

test('JavaImporter.importPackage(Packages.cn.hutool.*) 后裸类名可用（木里聚合用法）', () => {
  const r = run(`
    var ji = new JavaImporter();
    ji.importPackage(Packages.cn.hutool.crypto.digest, Packages.cn.hutool.core.codec);
    var out;
    with (ji) { out = DigestUtil.md5Hex('abc') + '|' + Base64.encode('abc'); }
    String(out)
  `);
  assert.equal(r, '900150983cd24fb0d6963f7d28e17f72|YWJj');
});

test('未实现的 Java 类访问必须留痕（不能静默返回空串）', () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    // `cn.hutool.net 未实现` 走兜底 —— 必须打一条告警
    const r = run(`String(Packages.cn.hutool.definitely.not.implemented.foo())`);
    assert.equal(r, '');
  } finally {
    console.warn = orig;
  }
  assert.ok(
    warns.some((w) => w.includes('java-bridge') && w.includes('未实现的 Java 类')),
    `应打印「未实现的 Java 类」告警，实际：${JSON.stringify(warns)}`,
  );
});
