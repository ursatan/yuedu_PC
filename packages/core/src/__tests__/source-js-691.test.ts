/**
 * `#691` 两个脚本环境缺口的回归锁：
 *  ① **`CryptoJS` 完全没有**（野果短剧 `RULE_PARSE@parse · CryptoJS is not defined`）；
 *  ② **`JavaImporter` 实例缺 `importClass`**（自用极品书源 珍藏版 的 jsLib 用它按类名导入，
 *     我们只给了 `importPackage` ⇒ 它的 catch 打出一片「无法导入类」，`with` 作用域里一个类都没绑上）。
 *
 * ①的判据用**已知向量**（MD5('abc') / SHA256('abc') 是公开标准值），
 * AES 用 `node:crypto` 现造密文再由 CryptoJS 兼容层解 —— 两边算法不同实现，能对上才算真对上。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv } from 'node:crypto';
import { AnalyzeRule } from '../selector/analyze';
import { makeProbeEnv } from '../diag/probe';
import { makeJavaImporterCtor } from '../selector/java-bridge';

function mk() {
  const { env } = makeProbeEnv({ content: '<div></div>', baseUrl: 'https://x/', vars: {} } as never);
  return new AnalyzeRule(env).setContent('<div></div>', 'https://x/');
}

test('C-① CryptoJS 存在且是按上游口径的全局（不是挂在 java 上）', async () => {
  const out = await mk().runJs(
    `[typeof CryptoJS, typeof CryptoJS.AES, typeof CryptoJS.enc.Utf8.parse,
      (java.CryptoJS && java.CryptoJS.AES === CryptoJS.AES) ? 'same' : 'not-same'].join(',')`,
    {},
  );
  assert.equal(String(out), 'object,object,function,not-same', 'CryptoJS 必须是求值 scope 里的裸全局（java 上那个只是空桩）');
});

test('C-② 野果短剧的 ygDecryptData：WordArray(key/iv) + Base64 密文 + Pkcs7', async () => {
  const key = '0123456789abcdef';
  const iv = 'fedcba9876543210';
  const plain = JSON.stringify({ code: 0, data: { list: [{ id: 1, name: '野果' }] } });
  const c = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf-8'), Buffer.from(iv, 'utf-8'));
  const b64 = Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');

  const out = await mk().runJs(
    `function ygDecryptData(dataB64){
       var k=CryptoJS.enc.Utf8.parse('${key}');
       var iv=CryptoJS.enc.Utf8.parse('${iv}');
       var d=CryptoJS.AES.decrypt({ciphertext:CryptoJS.enc.Base64.parse(String(dataB64))},k,{iv:iv,padding:CryptoJS.pad.Pkcs7});
       return d.toString(CryptoJS.enc.Utf8);
     }
     ygDecryptData('${b64}')`,
    {},
  );
  assert.equal(String(out), plain, '解出来必须与 node:crypto 加密的原文逐字一致');
});

test('C-③ 口令模式往返：`AES.decrypt(AES.encrypt(x,pwd).toString(), pwd)`（toString 默认 base64）', async () => {
  const out = await mk().runJs(
    `CryptoJS.AES.decrypt(CryptoJS.AES.encrypt('口令模式 roundtrip','pass').toString(),'pass').toString(CryptoJS.enc.Utf8)`,
    {},
  );
  assert.equal(String(out), '口令模式 roundtrip');
});

test('C-④ 摘要/编码器：已知向量（MD5、SHA256、Base64、Hex→Utf8）', async () => {
  const out = await mk().runJs(
    `[
       CryptoJS.MD5('abc').toString(),
       CryptoJS.SHA256('abc').toString(),
       CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('中文 test')),
       CryptoJS.enc.Hex.parse('616263').toString(CryptoJS.enc.Utf8)
     ].join('|')`,
    {},
  );
  assert.equal(
    String(out),
    '900150983cd24fb0d6963f7d28e17f72|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad|5Lit5paHIHRlc3Q=|abc',
  );
});

test('C-⑤ 非法 UTF-8 抛 `Malformed UTF-8 data`（源里 try/catch 靠这条判失败）', async () => {
  const out = await mk().runJs(
    `(function(){try{CryptoJS.enc.Hex.parse('ff').toString(CryptoJS.enc.Utf8);return 'no-throw';}catch(e){return String(e.message||e);}})()`,
    {},
  );
  assert.match(String(out), /Malformed UTF-8 data/);
});

test('J-① JavaImporter 实例必须有 importClass（Rhino 两个方法都在）', () => {
  const Ctor = makeJavaImporterCtor() as new () => Record<string, unknown>;
  const imp = new Ctor();
  assert.equal(typeof imp['importPackage'], 'function');
  assert.equal(typeof imp['importClass'], 'function', '缺它 ⇒ 源的 safeImport 一片「无法导入类」');
});

test('J-② importClass 把简单名绑进作用域（`with(importer){ String(...) }` 能解析）', async () => {
  const out = await mk().runJs(
    `var ji = new JavaImporter();
     ji.importClass('java.lang.String');
     var bound = (typeof ji.String);
     ji.importClass({ __yueduClassName: 'android.util.Base64' });
     bound + ',' + (typeof ji.Base64)`,
    {},
  );
  assert.equal(String(out), 'function,object', '字符串名与带 __yueduClassName 的类对象都要能绑');
});

test('J-③ importClass 遇到认不出名字的对象**静默跳过**（不抛、不影响后续语句）', async () => {
  const out = await mk().runJs(
    `var ji2 = new JavaImporter(); try{ ji2.importClass({}); }catch(e){ 'threw' } 'ok'`,
    {},
  );
  assert.equal(String(out), 'ok');
});
