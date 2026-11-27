/**
 * `#208` WebDAV 纯逻辑层单测（对照上游 `WebDav.kt` / `Authorization.kt` / `AppWebDav.kt`）。
 *
 * ★ 防空转约定：每个「回落/拒绝」用例旁都有能通过的对照（同函数、换入参）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROPFIND_EXISTS_BODY,
  WEBDAV_DEFAULT_URL,
  bookProgressFileName,
  bookProgressUrl,
  emptyWebDavConfig,
  isWebDavDir,
  normalizeWebDavFileName,
  normalizeWebDavRoot,
  propfindDirBody,
  publicWebDavConfig,
  replaceReservedChar,
  validateWebDavConfig,
  webDavBasicAuth,
  webDavProgressRoot,
  webDavRootFile,
  webDavRootOf,
  webDavSubDir,
  webDavUrlToHttp,
  type WebDavConfig,
} from '../webdav';

const CFG: WebDavConfig = {
  url: 'https://dav.example.com/dav',
  username: 'u',
  password: 'p',
  dir: 'legado',
  authEncoding: 'utf-8',
};

/* ── 根地址 ──────────────────────────────────────────────────────── */

test('#208 根地址：补尾斜杠 / 追加子目录 / 空则回落内置默认', () => {
  assert.equal(normalizeWebDavRoot('https://a.com/dav'), 'https://a.com/dav/');
  assert.equal(normalizeWebDavRoot('https://a.com/dav/'), 'https://a.com/dav/');
  assert.equal(normalizeWebDavRoot('https://a.com/dav', 'sub'), 'https://a.com/dav/sub/');
  // 子目录自带斜杠也要归一（不然会拼出 `sub//`）
  assert.equal(normalizeWebDavRoot('https://a.com/dav', '/sub/'), 'https://a.com/dav/sub/');
  // 空地址 ⇒ 内置默认（上游 `defaultWebDavUrl`）
  assert.equal(normalizeWebDavRoot(''), WEBDAV_DEFAULT_URL);
  assert.equal(normalizeWebDavRoot('   '), WEBDAV_DEFAULT_URL);
  assert.equal(normalizeWebDavRoot(null), WEBDAV_DEFAULT_URL);
  // 对照：给了地址就用地址，不再回落默认
  assert.equal(normalizeWebDavRoot('https://b.com/x'), 'https://b.com/x/');
});

test('#208 根地址：dav:// / davs:// 折算成 http(s)://', () => {
  assert.equal(webDavUrlToHttp('dav://a.com/dav/'), 'http://a.com/dav/');
  assert.equal(webDavUrlToHttp('davs://a.com/dav/'), 'https://a.com/dav/');
  assert.equal(normalizeWebDavRoot('davs://a.com/dav'), 'https://a.com/dav/');
  // 对照：本来就是 https 的不动
  assert.equal(webDavUrlToHttp('https://a.com/dav/'), 'https://a.com/dav/');
});

test('#208 子目录与成员地址：webDavRootOf / subDir / progressRoot / rootFile', () => {
  assert.equal(webDavRootOf(CFG), 'https://dav.example.com/dav/legado/');
  assert.equal(webDavSubDir('https://a.com/dav/', 'books'), 'https://a.com/dav/books/');
  assert.equal(webDavProgressRoot('https://a.com/dav/'), 'https://a.com/dav/bookProgress/');
  assert.equal(webDavRootFile('https://a.com/dav/', 'backup2026.zip'), 'https://a.com/dav/backup2026.zip');
  // 对照：根没带尾斜杠时也要拼对（不能出现 `davbackup`）
  assert.equal(webDavRootFile('https://a.com/dav', 'b.zip'), 'https://a.com/dav/b.zip');
});

/* ── 文件名 ──────────────────────────────────────────────────────── */

test('#208 文件名净化：normalizeFileName 只吃 [\\/:*?"<>|]（**不含点**）', () => {
  assert.equal(normalizeWebDavFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  // ★ 点**不**被替换 —— 上游 fileNameRegex2 里没有 `.`（`fileNameRegex` 才有）
  assert.equal(normalizeWebDavFileName('v1.2.txt'), 'v1.2.txt');
});

test('#208 保留字符转义：逐字符对齐上游 replaceReservedChar', () => {
  assert.equal(replaceReservedChar('a/b'), 'a%2Fb');
  assert.equal(replaceReservedChar('a b'), 'a%20b');
  assert.equal(replaceReservedChar('100%'), '100%25');
  // ⚠️ **该函数不是幂等的**（上游同样）：`%` 排在第一位先被替换 ⇒ 第二次调用会把
  //    已转义的 `%25` 再转成 `%2525`。所以**只能对原始文件名调用一次**（进度文件名只调一次，安全）。
  assert.equal(replaceReservedChar(replaceReservedChar('a/b')), 'a%252Fb');
  // 对照：不含保留字符的原样返回
  assert.equal(replaceReservedChar('甲乙丙'), '甲乙丙');
});

test('#208 进度文件名 = normalize → 转义 → 加 .json', () => {
  assert.equal(bookProgressFileName('我的书', '作者'), '我的书_作者.json');
  assert.equal(bookProgressFileName('a/b', 'c:d'), 'a_b_c_d.json', '先净化再转义，顺序不能反');
  assert.equal(bookProgressFileName('', ''), '_.json');
  assert.equal(
    bookProgressUrl('https://a.com/dav/', '我的书', '作者'),
    'https://a.com/dav/bookProgress/我的书_作者.json',
  );
});

/* ── 认证 ────────────────────────────────────────────────────────── */

test('#208 Basic 认证：ASCII 与上游一致的固定向量', () => {
  assert.equal(webDavBasicAuth('user', 'pass'), 'Basic dXNlcjpwYXNz');
  // 解回来必须还是 `user:pass`
  assert.equal(atob('dXNlcjpwYXNz'), 'user:pass');
});

test('#208 Basic 认证：默认 UTF-8（★ 与上游 ISO-8859-1 的有意差异 —— 中文密码不会被换成 ?）', () => {
  // base64 → latin1 字符串 → 原始字节 → 按指定编码解回文本（`atob` 只做 latin1 解码）
  const decode = (b64: string, encoding: string): string => {
    const latin1 = atob(b64);
    const bytes = new Uint8Array(latin1.length);
    for (let i = 0; i < latin1.length; i += 1) bytes[i] = latin1.charCodeAt(i);
    return new TextDecoder(encoding).decode(bytes);
  };

  const utf8 = webDavBasicAuth('甲', '乙', 'utf-8');
  assert.equal(utf8, 'Basic 55SyOuS5mQ==', 'UTF-8 字节序列（甲:乙 = 7 字节）');
  assert.equal(decode(utf8.slice(6), 'utf-8'), '甲:乙', '服务端按 UTF-8 解回来是原文');

  const latin1 = webDavBasicAuth('甲', '乙', 'iso-8859-1');
  assert.notEqual(utf8, latin1, '两种编码必须不同，否则开关形同虚设');
  // 上游语义：装不下的字符按 Java 的做法落到 `?`（0x3F）
  assert.equal(decode(latin1.slice(6), 'iso-8859-1'), '?:?', 'ISO-8859-1 下中文变 ? —— 这就是中文密码 401 的原因');
});

/* ── 目录判定 / 请求体 ───────────────────────────────────────────── */

test('#208 目录判定：contentType 是 httpd/unix-directory 或 resourceType 含 collection', () => {
  assert.equal(isWebDavDir('httpd/unix-directory', ''), true);
  assert.equal(isWebDavDir('', '<a:collection/>'), true);
  assert.equal(isWebDavDir('', '<a:COLLECTION/>'), true, '大小写无关（上游 lowercase）');
  // 对照：普通文件不是目录
  assert.equal(isWebDavDir('application/json', ''), false);
  assert.equal(isWebDavDir('', ''), false);
});

test('#208 PROPFIND 请求体：默认属性齐全；EXISTS 只问 resourcetype', () => {
  const dir = propfindDirBody();
  for (const p of ['displayname', 'resourcetype', 'getcontentlength', 'creationdate', 'getlastmodified']) {
    assert.ok(dir.includes(`<a:${p}/>`), `默认要带 ${p}`);
  }
  assert.ok(dir.includes('xmlns:a="DAV:"'));
  assert.ok(propfindDirBody(['getetag']).includes('<a:getetag/>'), '额外属性可追加');
  assert.ok(PROPFIND_EXISTS_BODY.includes('<resourcetype />'));
  assert.ok(!PROPFIND_EXISTS_BODY.includes('displayname'), 'EXISTS 不该问多余属性');
});

/* ── 配置校验 ────────────────────────────────────────────────────── */

test('#208 配置校验：账号与密码都非空才算配置（对齐 upConfig 的门槛）', () => {
  const ok = validateWebDavConfig(CFG);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.config.url, 'https://dav.example.com/dav');

  for (const bad of [
    { ...CFG, username: '' },
    { ...CFG, username: '   ' },
    { ...CFG, password: '' },
  ]) {
    const r = validateWebDavConfig(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  // ★ 密码**不 trim**：带空格的口令必须原样保留
  const spaced = validateWebDavConfig({ ...CFG, password: ' a b ' });
  assert.equal(spaced.ok, true);
  if (spaced.ok) assert.equal(spaced.config.password, ' a b ');
});

test('#208 配置校验：地址协议必须是 http(s)/dav(s)；空地址合法（= 用内置默认）', () => {
  const noScheme = validateWebDavConfig({ ...CFG, url: 'dav.example.com' });
  assert.equal(noScheme.ok, false);
  if (!noScheme.ok) assert.match(noScheme.error, /http\(s\)/);
  for (const good of ['http://a/dav', 'https://a/dav', 'dav://a/dav', 'davs://a/dav', '']) {
    assert.equal(validateWebDavConfig({ ...CFG, url: good }).ok, true, good);
  }
  // 非对象一律拒
  assert.equal(validateWebDavConfig(null).ok, false);
  assert.equal(validateWebDavConfig('x').ok, false);
  assert.equal(validateWebDavConfig([]).ok, false);
});

test('#208 对外配置必须抹掉密码（publicWebDavConfig）', () => {
  const pub = publicWebDavConfig(CFG);
  assert.equal(pub.password, '');
  assert.equal(pub.hasPassword, true);
  // 对照：本来就没密码 ⇒ hasPassword=false（界面据此显示「未设置」）
  assert.equal(publicWebDavConfig({ ...CFG, password: '' }).hasPassword, false);
  // 不能改动原对象
  assert.equal(CFG.password, 'p');
});

test('#208 空配置：密码为空、编码默认 utf-8', () => {
  const c = emptyWebDavConfig();
  assert.equal(c.password, '');
  assert.equal(c.authEncoding, 'utf-8');
  assert.equal(validateWebDavConfig(c).ok, false, '空配置不该算「已配置」');
});
