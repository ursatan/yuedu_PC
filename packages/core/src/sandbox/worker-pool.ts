/**
 * Worker 池沙箱（M4）
 *
 * 实现 core 契约的 JsSandboxPool：
 *  - 每个求值在独立 worker_threads 里跑，与宿主进程隔离；
 *  - 硬超时：超时直接 terminate 该 worker 并重新补位（Legado 的 JsSourceEngine
 *    没有硬中断，这是我们超出原版的安全增强，对齐 docs R7 风险项）；
 *  - worker 代码以 `eval: true` 字符串注入 —— 避免依赖 TS loader 对 worker
 *    文件的支持（tsx 下 `new Worker('./x.ts')` 不可靠）；
 *  - `java` 等绑定在 worker 内部自建（postMessage 无法传函数），宿主只传
 *    结构化数据绑定（result / baseUrl / key / page / $ ...）。
 *
 * 结果约定与 core/selector/js.ts 保持一致（对齐 Legado evalJS）：
 *  - 多行/语句脚本：返回 `result` 变量的值；
 *  - 单表达式：直接返回表达式值。
 *
 * ⚠️ 绑定必须是结构可克隆的（string/number/boolean/plain object/array）。
 *    DOM 节点、函数等无法跨越 postMessage —— 该场景应走进程内 jsEval。
 */

import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { EngineError } from '../contract/error';
import type { JsSandboxPool } from '../contract/engine';
import { URL_PREP_SOURCE } from '../net/url-prep';
import { JSON_MAP_METHODS_SOURCE, JSON_MAP_BINDING_KEYS } from '../selector/json-map';
// `#759` 图片解密：宿主只下发裸字节，worker 用同一份源码重建 InputStream 方法面
import { IMAGE_BYTES_SOURCE } from '../selector/image-bytes';
import { JS_ERROR_EXPLAIN_SOURCE } from '../selector/js-error';
// `#409`：okhttp `Headers` 视图的唯一实现（与宿主 L1 共用同一份源码）
import { OK_HEADERS_SOURCE } from '../selector/ok-headers';
// `#612` 上游 ClassShutter 黑名单（宿主与 worker 同一来源）
import { shutterLiterals } from '../selector/java-shutter';
import { recordBlock } from '../diag/block-stats';
// `#771` 冻结探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）
import { probeEnter, probeLeave } from '../diag/freeze-probe';

/**
 * worker 脚本（纯 JS，注意：本字符串内的正则已按「最终 JS」书写，
 * 在 TS 模板串里 `\\s` 会输出为 `\s`）。
 * java 绑定集合镜像 core/selector/js.ts 的 makeJavaStub —— 两处需同步维护。
 * URL 构造逻辑（`{{}}` / `<1,2,3>` / `,{options}`）直接注入 core 的同一份源码，
 * 不再手抄副本（该逻辑曾因两处漂移导致 java.ajax 行为不一致）。
 */
const WORKER_SRC = String.raw`
const { parentPort } = require('node:worker_threads');
const { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, createPrivateKey, createPublicKey, privateDecrypt, publicDecrypt, privateEncrypt, publicEncrypt } = require('node:crypto');
const { gzipSync, gunzipSync, inflateSync, deflateSync } = require('node:zlib');

// 宿主基础设施用的**原生 Proxy**（模块加载期捕获，此后永不被源脚本污染）。
// java 桩在每次求值入口构造（见 runEval），若那里写裸 new Proxy，非 vm 模式下
// 上一条求值经 with(g) 把 globalThis.Proxy 污染成字符串（源脚本 var Proxy = "1,2,3"）
// 会让构造直接抛 "Proxy is not a constructor" ⇒ 整个 worker 报废
// （#624 收尾实测：YUEDU_JS_VM=0 下测试 780）。求值全局侧的污染由 runEval finally
// 的原生复位兜底；这里是第二道防线（宿主基础设施不依赖可被脚本改写的全局）。
var __yueduHostProxy = Proxy;

// —— URL 构造（Legado AnalyzeUrl 等价）——与宿主 L1 共用同一份源码 ——
${URL_PREP_SOURCE}

// —— 语法错可定位化（与宿主 explainJsError 同逻辑）——见 selector/js-error.ts ——
${JS_ERROR_EXPLAIN_SOURCE}

// —— JSON 绑定的 Java Map/List 方法（与宿主 attachJsonMapMethods 共用同一份源码）——
//    非枚举属性不会随 structuredClone 过来，所以必须在 worker 里再挂一次。
${JSON_MAP_METHODS_SOURCE}
const __YUEDU_JSON_MAP_KEYS = ${JSON.stringify([...JSON_MAP_BINDING_KEYS])};

// —— okhttp Headers 视图（与宿主 L1 共用同一份源码，#409）——
${OK_HEADERS_SOURCE}

// —— #759 图片解密字节 → InputStream（与宿主 asImageStreamResult 共用同一份源码）——
${IMAGE_BYTES_SOURCE}

// —— #612 上游 ClassShutter 黑名单（与宿主 selector/java-shutter.ts 同一来源，
//    这里内联成字面量：worker 源码是字符串，import 不进来）。
//    语义：RhinoClassShutter.kt:47-191 的类/包 ⇒ 对脚本不可见（返回 undefined），
//    不再是「未实现 ⇒ 调用返回空串」的兜底桩 —— 否则 Packages.com.script 这类
//    上游被挡的路径在本仓变成「可调用」，与上游不一致。
//    （本段在 String.raw 模板内：注释禁反引号与美元花括号）
const __SHUTTER_EXACT = ${JSON.stringify([...shutterLiterals().exact])};
const __SHUTTER_PREFIX = ${JSON.stringify([...shutterLiterals().prefix])};
function __yueduShuttered(p) {
  if (!p) return false;
  for (var i = 0; i < __SHUTTER_EXACT.length; i++) { if (p === __SHUTTER_EXACT[i]) return true; }
  for (var j = 0; j < __SHUTTER_PREFIX.length; j++) {
    var q = __SHUTTER_PREFIX[j];
    if (p.indexOf(q) === 0 && p.charAt(q.length) === '.') return true;
  }
  return false;
}

/* 对称加密工厂（Legado JsEncodeUtils.kt:45-75 / hutool SymmetricCrypto 的等价物）。
   抽成顶层函数：createSymmetricCrypto 与 aesBase64DecodeToString 都要用它，
   避免两处各写一份导致漂移（历史上就这么漂过：worker 的 aesBase64DecodeToString
   自己拼算法名 → 不支持 DES、固定 base64 解 → 宜搜小说正文在 worker 路径恒空）。
   注意：本段在 String.raw 模板内，注释里不能出现反引号。 */
function __yueduSymCrypto(transformation, key, iv) {
        const parts = String(transformation).split('/');
        const alg = (parts[0] || 'aes').toLowerCase();
        const mode = (parts[1] || 'cbc').toLowerCase();
        const pad = (parts[2] || 'pkcs5').toLowerCase();
        const keyBuf = toKeyBytes(key);
        // 算法名映射 + DES 退化 —— 与 L1 同一份逻辑（见 selector/js.ts 的同名注释）
        const isDes = alg === 'des' || alg === 'desede' || alg === 'tripledes' || alg === 'des3';
        let algoName;
        let keyUse = keyBuf;
        if (isDes) {
          const m = mode === 'ecb' ? 'ecb' : mode;
          if (alg === 'des') {
            if (keyBuf.length !== 8) throw new Error('createSymmetricCrypto: DES key 长度须 8 字节，当前 ' + keyBuf.length);
            keyUse = Buffer.concat([keyBuf, keyBuf, keyBuf]);
            algoName = 'des-ede3-' + m;
          } else {
            if (keyBuf.length === 16) algoName = 'des-ede-' + m;
            else if (keyBuf.length === 24) algoName = 'des-ede3-' + m;
            else throw new Error('createSymmetricCrypto: DESede key 长度须 16/24 字节，当前 ' + keyBuf.length);
          }
        } else {
          if (![16, 24, 32].includes(keyBuf.length)) throw new Error('createSymmetricCrypto: AES key 长度须 16/24/32 字节，当前 ' + keyBuf.length);
          algoName = alg + '-' + keyBuf.length * 8 + '-' + (mode === 'ecb' ? 'ecb' : mode);
        }
        const algo = algoName;
        const ivBuf = iv !== undefined && iv !== null && mode !== 'ecb' ? toKeyBytes(iv) : null;
        const toBytes = (d) => {
          if (d instanceof Uint8Array) return Buffer.from(d);
          if (Array.isArray(d)) return Buffer.from(d);
          return Buffer.from(String(d), 'utf-8');
        };
        const enc = (d) => { const c = ivBuf ? createCipheriv(algo, keyUse, ivBuf) : createCipheriv(algo, keyUse, null); if (pad === 'nopadding') c.setAutoPadding(false); return Buffer.concat([c.update(d), c.final()]); };
        const dec = (d) => { const c = ivBuf ? createDecipheriv(algo, keyUse, ivBuf) : createDecipheriv(algo, keyUse, null); if (pad === 'nopadding') c.setAutoPadding(false); return Buffer.concat([c.update(d), c.final()]); };
        return {
          encrypt: (d) => Array.from(enc(toBytes(d))),
          decrypt: (d) => Array.from(dec(toBytes(d))),
          encryptStr: (d) => enc(toBytes(d)).toString('utf-8'),
          decryptStr: (d) => dec(d instanceof Uint8Array ? Buffer.from(d) : decodeAutoCipher(String(d))).toString('utf-8'),
          encryptBase64: (d) => enc(toBytes(d)).toString('base64'),
          decryptBase64: (d) => dec(Buffer.from(String(d), 'base64')).toString('utf-8'),
          encryptHex: (d) => enc(toBytes(d)).toString('hex'),
          decryptHex: (d) => dec(Buffer.from(String(d), 'hex')).toString('utf-8'),
        };
}

/**
 * #657 worker 内就地取 JSON 字段（java.getString('$.a.b[0]') 不再回宿主）。
 *
 * 目录求值的最大头就在这里：qimao 聚合 MD3 实测 1652 章要 6600+ 次 rpc('evalRule')，
 * 每次 worker 都卡在 Atomics.wait 等宿主回信 —— 而取一个 JSON 字段既不需要 DOM
 * 也不需要正则/JS 引擎，宿主那边只是白跑一趟往返。
 *
 * 只在**最朴素**的形态下接管（否则返回 undefined，调用方照旧回宿主）：
 *  · 规则 = $ 后面只跟 .name 与 [n]（不含 ||、##、<js>、@、通配、内嵌 {$.x}）；
 *  · 值 = 对象，或能 JSON.parse 的字符串（HTML / 纯文本 ⇒ 不接管）。
 * 取值与转字符串逐条对齐宿主 jsonpath.ts 的 jsonValueToText（对象 ⇒ JSON.stringify）。
 *
 * 注意：本段位于模板串内，禁反引号与美元花括号。
 */
var __yueduJsonMemoKey = null;
var __yueduJsonMemoVal = undefined;
function __yueduJsonPathGetLocal(value, rule) {
  if (typeof rule !== 'string') return undefined;
  if (!/^\$(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])+$/.test(rule)) return undefined;
  var obj = value;
  if (typeof value === 'string') {
    /* 同一章的 chapterUrl / updateTime 用同一份 $ ⇒ 一槽 memo 省掉第二次 parse */
    if (__yueduJsonMemoKey === value) {
      obj = __yueduJsonMemoVal;
    } else {
      var head = value.charAt(0);
      if (head !== '{' && head !== '[') return undefined;
      try {
        obj = JSON.parse(value);
      } catch (e) {
        return undefined;
      }
      __yueduJsonMemoKey = value;
      __yueduJsonMemoVal = obj;
    }
  }
  if (obj == null || typeof obj !== 'object') return undefined;
  var cur = obj;
  var rest = rule.slice(1);
  var seg = /^\.([A-Za-z_$][A-Za-z0-9_$]*)|^\[(\d+)\]/;
  while (rest.length) {
    var m = seg.exec(rest);
    if (!m) return undefined;
    if (m[1] !== undefined) cur = cur[m[1]];
    else cur = cur[Number(m[2])];
    if (cur == null) return undefined;
    rest = rest.slice(m[0].length);
  }
  if (typeof cur === 'object') {
    try {
      return JSON.stringify(cur);
    } catch (e) {
      return String(cur);
    }
  }
  return String(cur);
}

/**
 * #643 java.post/get/head/ajaxAll 第三参「头」实参规整（与宿主 L1 的 normalizeJsHeaderArg 同语义）。
 *
 * 上游 JsExtensions 的签名是 headers: String?，内部 GSON.fromJsonObject 解析
 * ⇒ 源传的是 JSON 字符串。此前 worker 把字符串直接当对象用，源写的 Referer 等头被静静丢掉。
 *
 * 注意：本注释位于模板串内，禁反引号与美元花括号。
 */
function __yueduHeaderArg(h) {
  if (h === undefined || h === null) return undefined;
  if (typeof h === 'string') {
    var t = h.trim();
    if (!t) return undefined;
    try {
      var o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (e) {}
    return undefined;
  }
  if (typeof h === 'object') return h;
  return undefined;
}

function httpRpcSpec(raw, fallback) {
  const p = __yueduPrepareUrl(String(raw == null ? '' : raw));
  // #464 坏地址必须抛（与宿主 L1 的 assertHttpUrl 同语义、同理由）：
  // 上游 java.head/get/post 都是 Jsoup.connect ⇒ 空串/相对地址抛 IllegalArgumentException，
  // 源作者靠它做兜底（18AV「获取网址」：head 抛了才写默认域名）。
  // 注意：本注释位于模板串内，禁反引号与美元花括号。
  if (!/^https?:\/\//i.test(String(p.url == null ? '' : p.url))) {
    throw new Error('Malformed URL: ' + String(p.url == null ? '' : p.url));
  }
  const r = __yueduOptionRequest(
    p.option,
    (fallback && fallback.method) || 'GET',
    fallback ? fallback.body : undefined,
    // #643 头实参可能是 JSON 字符串（上游 GSON 语义），统一在这里规整
    fallback && fallback.headers !== undefined ? __yueduHeaderArg(fallback.headers) : undefined,
  );
  // #387c：java.get/post 要求不跟随重定向（上游 JsExtensions followRedirects(false)）
  // #742：URL 选项 dnsIp（IP 直连）随请求一起回宿主；宿主出口的消费点见 selector/js.ts 的 http 分支
  var dn = p.option && p.option.dnsIp != null ? String(p.option.dnsIp) : '';
  // URL 选项 timeout（毫秒）：与 L1 的 syncHttpSpec 同一规则；缺省/非法不写，保持宿主默认超时
  var tmo = p.option && p.option.timeout != null ? Number(p.option.timeout) : 0;
  if (!(isFinite(tmo) && tmo > 0)) tmo = 0;
  return httpRpc(r.method, p.url, r.body, r.headers, !!(fallback && fallback.noRedirect), dn, tmo);
}

// 「当前在 worker 线程里」标记：java.lang.Thread.sleep 据此决定能否长阻塞
// （worker 里阻塞只影响本脚本；**L1/主线程里阻塞会把整个事件循环拖住 → 其它源全部超时**）
globalThis.__yueduInWorker = true;

// #540 aes/des 旧 API 家族的小助手（与 L1 侧同语义：iv 空串视为无 iv；base64 串先解成字节）
// #540 iv 原样透传：ArgsBase64 变体传 Uint8Array（String() 会拼成 "18,52,..." 炸掉）
function symIv(iv) { return iv === undefined || iv === null || iv === '' ? undefined : iv; }
function b64Bytes(s) { return new Uint8Array(Buffer.from(String(s == null ? '' : s), 'base64')); }
// #540 createAsymmetricCrypto 的 DER 包装（hutool KeyUtil 收 PKCS1，Node 只认 PKCS8/SPKI）
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  var bytes = [];
  for (var x = n; x > 0; x >>>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length].concat(bytes));
}
var RSA_ALG_ID = Buffer.from('300d06092a864886f70d0101010500', 'hex');
function wrapPkcs1Private(pkcs1) {
  var inner = Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), RSA_ALG_ID, Buffer.from([0x04]), derLen(pkcs1.length), pkcs1]);
  return Buffer.concat([Buffer.from([0x30]), derLen(inner.length), inner]);
}
function wrapPkcs1Public(pkcs1) {
  var bits = Buffer.concat([Buffer.from([0x03]), derLen(pkcs1.length + 1), Buffer.from([0x00]), pkcs1]);
  var inner = Buffer.concat([RSA_ALG_ID, bits]);
  return Buffer.concat([Buffer.from([0x30]), derLen(inner.length), inner]);
}

// —— 与宿主 L1（core/selector/js.ts）同名的工具函数：两处需同步维护 ——
// key/iv 归一：ByteArray（Uint8Array/number[]）直用；字符串按 UTF-8
function toKeyBytes(v) {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v.map((x) => Number(x) & 0xff));
  return Buffer.from(String(v ?? ''), 'utf-8');
}
// 密文解码（hutool SecureUtil.decode）：全 hex → hex，否则 → base64
function decodeAutoCipher(s) {
  const t = String(s ?? '').trim();
  if (t && /^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return Buffer.from(t, 'hex');
  return Buffer.from(t, 'base64');
}
// Java 摘要算法名 → Node 名（"SHA-256"→"sha256"，"HmacSHA256"→"sha256"）
function digestAlgoName(algorithm) {
  let raw = String(algorithm ?? 'md5').trim().toLowerCase().replace(/[-_]/g, '');
  if (raw.startsWith('hmac')) raw = raw.slice(4);
  const aliases = { sha: 'sha1', md5: 'md5' };
  return aliases[raw] ?? raw;
}

// this 上下文：对齐 Legado（this.put/get/M 跨脚本存取）与 L1 的 makeThisScope —— **逐项一致**。
// ⚠️ 这张面此前**定义了却从未接到作用域上**（this.getHeaderMap / this.put 全缺），
// 于是「带 java.ajax 的规则（走 worker）」里 jsLib 的 this.xxx() 会抛 NOT_A_FUNCTION。
// get/put 经 RPC 回宿主（同一份变量链：本地 variables ⊕ 按源持久），与 java.get/java.put 同语义。
// cache.getInt/getLong/getDouble/getFloat 的数值化（Legado CacheManager 的同名方法）：
// 未命中或非数字 → null（不是 0/NaN），与 get() 的 null 语义一致。
function cacheNum(v, truncate) {
  if (v === null || v === undefined || v === '') return null;
  var x = Number(v);
  if (!Number.isFinite(x)) return null;
  return truncate ? Math.trunc(x) : x;
}

const thisScope = {
  M: (k) => rpc('javaVarGet', { k: String(k) }) || '',
  get: (k) => rpc('javaVarGet', { k: String(k) }) || '',
  /**
   * 与 L1 的 makeThisScope.put 同两形态（两面必须逐项一致）：
   *  · 单参 = 保存整份源变量（qyyuapi 系 jsLib 的 this.put(obj) 约定）
   *    —— 走 sourceCall 回宿主的 source 桩 setVariable，与 L1 同一落点；
   *    不能用 javaVarPut：那是「把 kv 并进源变量 JSON」，会把整份 JSON 再套一层
   *    （历史坏值形如 中括号object Object 中括号:undefined）。
   *  · 双参 = put(k, v)，保持原行为。
   * 注意：本段在 String.raw 模板内，注释禁反引号与美元花括号。
   */
  put: (k, v) => {
    if (v === undefined) {
      var __t = typeof k === 'string' ? k : JSON.stringify(k);
      rpc('sourceCall', { m: 'setVariable', args: [__t == null ? '' : __t] });
      return k;
    }
    rpc('javaVarPut', { k: String(k), v: String(v) });
    return v;
  },
  setHeaders: () => undefined,
  encode: (s) => encodeURIComponent(String(s)),
  // Legado BaseSource.getHeaderMap()：jsLib 里常写 this.getHeaderMap() 取签名字段
  getHeaderMap: () => rpc('getSourceHeaders', {}) || {},
};

/**
 * 「#484「 **命名空间常量外提**（worker 侧）。
 *
 * 实测依据（#480-b 的 bench-ipc，1310 章 × 2 次 JS）：单次 eval 的固定开销里
 * **编译只占 0.005ms**（做编译缓存没用），大头是**每次求值重建命名空间** ——
 * 其中 Packages 一口气造 ArrayList/HashMap 两套原型 + javaNs/androidNs 两棵树，
 * org 还要调一次 __yueduJsoup()（约 50 个闭包）。
 *
 * org / com / net / javax / Packages 都是**无状态常量**（只用全局 rpc 与纯函数，
 * 不引用 ruleState / localVars / cookie / cache）⇒ 提到模块级只建一次。
 * ⚠️ stateful 的 java（ruleState.content / localVars）与 cookie、cache 仍按求值构造。
 *
 * ⚠️ 本段位于 String.raw 模板内：注释禁反引号与美元花括号（这个坑已踩五次）。
 */
const __JSOUP_NS = __yueduJsoup();
const __ORG_NS = (function () {
  function nestOrg(path) {
    var f = function () { return ''; };
    return new Proxy(f, { get: function (_t, prop) { if (typeof prop === 'symbol' || prop === 'then') return undefined; var full = path ? path + '.' + String(prop) : String(prop); if (__yueduShuttered(full)) return undefined; return nestOrg(full); }, apply: function () { return ''; } });
  }
  var jsoupNs = { Jsoup: __JSOUP_NS };
  /* #522 org.jsoup.parser.Parser.unescapeEntities 回宿主解码：worker 模板里没有 commons-text 实体表，
     按铁律「同一判据只留一处」不再写第二份。语料 7 处调用（存书啦/格格党网 等）。 */
  jsoupNs.parser = { Parser: { unescapeEntities: function (text) { return rpc('dom', { op: 'unescapeEntities', text: String(text == null ? '' : text) }); } } };
  /* #528 org.jsoup.select.Elements：new Elements() 造空列表，逐条 add(el)（找书啦 ruleToc） */
  jsoupNs.select = { Elements: function Elements() { return __JSOUP_NS.list([]); } };
  /* #640 org.jsoup.nodes.Element：new Element(tag) 造游离元素（源里拼卡片用；此前 org.jsoup.nodes 是 undefined） */
  jsoupNs.nodes = { Element: function Element(tag) { return __JSOUP_NS.element(tag); } };
  /* #529 org.jsoup.Connection.Method.*（源里 org.jsoup.Connection.Method.DELETE；字符串常量对齐 String(Method)） */
  jsoupNs.Connection = { Method: { GET: 'GET', POST: 'POST', DELETE: 'DELETE', PUT: 'PUT', HEAD: 'HEAD', OPTIONS: 'OPTIONS', PATCH: 'PATCH', TRACE: 'TRACE' } };
  return new Proxy(function () { return ''; }, {
    get: function (_t, prop) {
      if (prop === 'jsoup') return jsoupNs;
      return typeof prop === 'symbol' || prop === 'then' ? undefined : nestOrg('org');
    },
    apply: function () { return ''; },
  });
})();
const __COM_NS = (function () { function nest(path) { var f = function () { return ''; }; return new Proxy(f, { get: function (_t, prop) { if (typeof prop === 'symbol' || prop === 'then') return undefined; var full = path ? path + '.' + String(prop) : String(prop); if (__yueduShuttered(full)) return undefined; return nest(full); }, apply: function () { return ''; } }); } return nest('com'); })();
const __NET_NS = (function () { function nest(path) { var f = function () { return ''; }; return new Proxy(f, { get: function (_t, prop) { if (typeof prop === 'symbol' || prop === 'then') return undefined; var full = path ? path + '.' + String(prop) : String(prop); if (__yueduShuttered(full)) return undefined; return nest(full); }, apply: function () { return ''; } }); } return nest('net'); })();
const __JAVAX_NS = (function () { function nest(path) { var f = function () { return ''; }; return new Proxy(f, { get: function (_t, prop) { if (typeof prop === 'symbol' || prop === 'then') return undefined; var full = path ? path + '.' + String(prop) : String(prop); if (__yueduShuttered(full)) return undefined; return nest(full); }, apply: function () { return ''; } }); } return nest('javax'); })();
const __PACKAGES_NS = (function () {
  // #500 P0-1a：字节/摘要 helpers（cn.hutool / javax.crypto 子树用）
  function toBytes(v) {
    if (v == null) return Buffer.alloc(0);
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === 'string') return Buffer.from(v, 'utf8');
    if (Array.isArray(v)) return Buffer.from(v);
    if (typeof v === 'object' && typeof v.length === 'number') return Buffer.from(v);
    return Buffer.from(String(v), 'utf8');
  }
  function hexOf(algo, v) { return createHash(algo).update(toBytes(v)).digest('hex'); }
  function ArrayList() { this.a = []; }
  ArrayList.prototype.add = function (x) { this.a.push(x); return true; };
  ArrayList.prototype.push = function (x) { this.a.push(x); };
  ArrayList.prototype.size = function () { return this.a.length; };
  ArrayList.prototype.get = function (i) { return this.a[i]; };
  ArrayList.prototype.isEmpty = function () { return this.a.length === 0; };
  ArrayList.prototype.toArray = function () { return this.a.slice(); };
  ArrayList.prototype.clear = function () { this.a = []; };
  ArrayList.prototype.toString = function () { return String(this.a); };
  function HashMap() { this.m = {}; }
  HashMap.prototype.put = function (k, v) { var p = this.m[String(k)]; this.m[String(k)] = v; return p; };
  HashMap.prototype.get = function (k) { return this.m[String(k)]; };
  HashMap.prototype.containsKey = function (k) { return String(k) in this.m; };
  HashMap.prototype.remove = function (k) { var p = this.m[String(k)]; delete this.m[String(k)]; return p; };
  HashMap.prototype.size = function () { return Object.keys(this.m).length; };
  HashMap.prototype.isEmpty = function () { return Object.keys(this.m).length === 0; };
  HashMap.prototype.keySet = function () { return Object.keys(this.m); };
  /* #501 P0-1a-2：按逐源缺口分析补（补一个路径能解放 N 个源）。
     原则：宿主 L1 已实现的（String/MessageDigest/UUID）严格对齐宿主语义；
     宿主也没有的（io/zip/BigInteger/charset/SecureRandom）按 Java 语义实现 ——
     那些路径在 L1 下本来就是 nest() 空串兜底，补上属纯增强、不破坏兼容。 */
  /* #526：字节 → 文本（charset 感知，与宿主 bytesToText 同语义 —— 未知 charset 退 UTF-8，不抛） */
  function __yueduBytesText(a, cs) {
    try {
      var name = cs == null ? 'utf-8' : String(cs);
      if (/^iso-?8859-1$/i.test(name)) name = 'latin1';
      return Buffer.from(a).toString(name);
    } catch (e) { return Buffer.from(a).toString('utf8'); }
  }
  /* #526 java.lang.String 必须「new / 无 new 均可调」—— 对齐宿主 makeJString。
     为什么：with(new JavaImporter()) 把 String 复制进 with 作用域后，脚本里的 String(x)
     解析成 java.lang.String(x)（Java 语义，返回对象）。旧实现是普通构造器：无 new 调用时
     赋值落到 globalThis（sloppy）或直接抛 TypeError ⇒ 七猫 3.9.61 正文
     String(chipher.doFinal(...)) 拿到 undefined ⇒ 整章空。
     （本段在 String.raw 模板内：注释禁反引号与美元花括号） */
  var __JStringImpl = function (a, b) {
    if (a instanceof Uint8Array || Buffer.isBuffer(a) || a instanceof ArrayBuffer) { this.text = __yueduBytesText(a, b); }
    else { this.text = a == null ? '' : String(a); }
  };
  /* [#532] 原型标记（非枚举，不影响 structuredClone）——
     __yueduSendable 在全局作用域，读不到本 IIFE 内的 __JStringImpl 局部变量，
     instanceof 会抛 ReferenceError。用原型标记做鸭子判断代替。 */
  __JStringImpl.prototype.__isJString = true;
  var JStringImpl = function (a, b) { return new __JStringImpl(a, b); };
  JStringImpl.prototype = __JStringImpl.prototype;
  JStringImpl.valueOf = function (x) { return x == null ? 'null' : String(x); };
  JStringImpl.join = function (sep) {
    var out = [];
    for (var i = 1; i < arguments.length; i++) out.push(String(arguments[i] == null ? '' : arguments[i]));
    return out.join(String(sep == null ? '' : sep));
  };
  JStringImpl.prototype.getBytes = function (cs) {
    var name = cs == null ? 'utf-8' : String(cs);
    if (/^iso-?8859-1$/i.test(name)) name = 'latin1';
    try { return new Uint8Array(Buffer.from(this.text, name)); } catch (e) { return new Uint8Array(Buffer.from(this.text, 'utf8')); }
  };
  JStringImpl.prototype.length = function () { return this.text.length; };
  JStringImpl.prototype.charAt = function (i) { return this.text.charAt(Number(i) || 0); };
  JStringImpl.prototype.substring = function (a, b) { return this.text.substring(Number(a) || 0, b === undefined ? undefined : Number(b)); };
  JStringImpl.prototype.indexOf = function (x) { return this.text.indexOf(String(x)); };
  // （旧的 split(x) 已并入下方 #508 的完整版：支持正则与 limit）
  JStringImpl.prototype.replace = function (a, b) { return this.text.replace(a, b); };
  JStringImpl.prototype.trim = function () { return this.text.trim(); };
  JStringImpl.prototype.toString = function () { return this.text; };
  JStringImpl.prototype.equals = function (o) { return String(o) === this.text; };
  // #508 与宿主同步补齐（java.lang.String 常用子集；with(JavaImporter) 下 String(x) 走这里）
  JStringImpl.prototype.indexOf = function (s, from) { return this.text.indexOf(String(s == null ? '' : s), from == null ? 0 : Number(from)); };
  JStringImpl.prototype.lastIndexOf = function (s) { return this.text.lastIndexOf(String(s == null ? '' : s)); };
  JStringImpl.prototype.startsWith = function (s, pos) { return this.text.startsWith(String(s == null ? '' : s), pos == null ? 0 : Number(pos)); };
  JStringImpl.prototype.endsWith = function (s) { return this.text.endsWith(String(s == null ? '' : s)); };
  JStringImpl.prototype.contains = function (s) { return this.text.indexOf(String(s == null ? '' : s)) >= 0; };
  JStringImpl.prototype.equalsIgnoreCase = function (o) { return this.text.toLowerCase() === String(o == null ? '' : o).toLowerCase(); };
  JStringImpl.prototype.isEmpty = function () { return this.text.length === 0; };
  JStringImpl.prototype.replace = function (a, b) { return this.text.split(String(a == null ? '' : a)).join(String(b == null ? '' : b)); };
  JStringImpl.prototype.replaceAll = function (re, b) { return this.text.replace(new RegExp(String(re == null ? '' : re), 'g'), String(b == null ? '' : b)); };
  JStringImpl.prototype.split = function (re, limit) { var out = this.text.split(new RegExp(String(re == null ? '' : re))); return limit == null ? out : out.slice(0, Number(limit)); };
  JStringImpl.prototype.toUpperCase = function () { return this.text.toUpperCase(); };
  JStringImpl.prototype.toLowerCase = function () { return this.text.toLowerCase(); };
  JStringImpl.prototype.concat = function (s) { return this.text + String(s == null ? '' : s); };
  JStringImpl.prototype.matches = function (re) { return new RegExp(String(re == null ? '' : re)).test(this.text); };
  JStringImpl.prototype.valueOf = function () { return this.text; };
  JStringImpl.prototype[Symbol.toPrimitive] = function () { return this.text; };
  var JStringBuilder = function () { this.parts = []; };
  JStringBuilder.prototype.append = function (x) { this.parts.push(x == null ? 'null' : String(x)); return this; };
  JStringBuilder.prototype.toString = function () { return this.parts.join(''); };
  JStringBuilder.prototype.length = function () { return this.parts.join('').length; };
  var JByteArrayOutputStream = function () { this.buf = []; };
  /**
   * #690 Java 的 write(byte[], off, len) 三参重载：黄果短剧的 coverDecodeJs 写法是
   * write(buf, 0, n)，旧实现只认单参，把整个 32 字节缓冲区反复写进去，拼出的密文是垃圾。
   * 注意：本函数体在 WORKER_SRC 模板串里，注释里不能出现反引号。
   */
  JByteArrayOutputStream.prototype.write = function (b, off, len) {
    if (b instanceof Uint8Array || Buffer.isBuffer(b) || Array.isArray(b)) {
      var start = (off == null) ? 0 : Number(off) || 0;
      var end = (len == null) ? b.length : Math.min(b.length, start + (Number(len) || 0));
      for (var i = start; i < end; i++) this.buf.push(b[i] & 0xff);
    } else { this.buf.push(Number(b) & 0xff); }
    return this;
  };
  JByteArrayOutputStream.prototype.toByteArray = function () { return new Uint8Array(this.buf); };
  JByteArrayOutputStream.prototype.toString = function () { return Buffer.from(this.buf).toString('utf8'); };
  JByteArrayOutputStream.prototype.size = function () { return this.buf.length; };
  JByteArrayOutputStream.prototype.reset = function () { this.buf = []; };
  var JByteArrayInputStream = function (b) { this.b = b == null ? new Uint8Array(0) : (b instanceof Uint8Array ? b : new Uint8Array(Buffer.from(String(b), 'binary'))); this.i = 0; };
  /**
   * #690 同时支持 read() 与 read(byte[], off, len)（Java InputStream 两种重载）。
   * 后者返回实际读到的字节数，无剩余时返回 -1 —— 黄果的 coverDecodeJs 靠这个返回值判断 EOF。
   * 本函数体在模板串里，注释不能出现反引号。
   */
  JByteArrayInputStream.prototype.read = function (buf, off, len) {
    if (buf == null) return this.i < this.b.length ? this.b[this.i++] : -1;
    var target = buf;
    if (typeof target !== 'object' || typeof target.length !== 'number') return this.i < this.b.length ? this.b[this.i++] : -1;
    var start = (off == null) ? 0 : Number(off) || 0;
    var want = (len == null) ? (target.length - start) : (Number(len) || 0);
    var avail = Math.max(0, Math.min(want, this.b.length - this.i));
    if (avail === 0) return -1;
    for (var i = 0; i < avail; i++) target[start + i] = this.b[this.i + i];
    this.i += avail;
    return avail;
  };
  JByteArrayInputStream.prototype.readBytes = function (n) { var out = this.b.subarray(this.i, this.i + n); this.i += out.length; return new Uint8Array(out); };
  JByteArrayInputStream.prototype.available = function () { return this.b.length - this.i; };
  JByteArrayInputStream.prototype.close = function () { return undefined; };
  var JBufferedReader = function (r) {
    var t = r && r.__text != null ? String(r.__text) : (r == null ? '' : String(r));
    this.lines = t.length ? t.split(/\r?\n/) : [];
    this.i = 0;
  };
  JBufferedReader.prototype.readLine = function () { return this.i < this.lines.length ? this.lines[this.i++] : null; };
  JBufferedReader.prototype.close = function () { return undefined; };
  var JInputStreamReader = function (is) { this.__text = is && is.__text != null ? String(is.__text) : (is == null ? '' : String(is)); };
  /**
   * java.security.MessageDigest —— **按 Java 公共契约移植**（与宿主 java-bridge.ts 同一组签名）。
   *
   * 背景：番茄系 jsLib 写 getInstance('MD5').update(bytes).digest()，而这里此前只有 digest
   * ⇒ d.update is not a function（全量基线 r2，2 源）。上游 legado 是真 Java 类，整组
   * update/digest/reset/getAlgorithm/getDigestLength/clone 都在，故按 JDK 契约补齐。
   * 语义：update 累积；digest() 返回摘要并**自动 reset**；digest(input) = 先 update 再 digest。
   * 本段在模板串内：禁反引号与美元花括号。
   */
  var __mdLen = { md5: 16, sha1: 20, sha256: 32, sha512: 64 };
  var __makeDigest = function (impl, algo, initial) {
    var h = initial || createHash(impl);
    var api = {
      update: function (input, off, len) {
        var data = toBytes(input);
        if (off != null) {
          var o = Number(off) || 0;
          data = data.subarray(o, len == null ? data.length : o + (Number(len) || 0));
        }
        h.update(Buffer.from(data));
      },
      digest: function (input, off, len) {
        if (input != null) api.update(input, off, len);
        var out = new Uint8Array(h.digest());
        h = createHash(impl);
        return out;
      },
      reset: function () { h = createHash(impl); },
      getAlgorithm: function () { return algo; },
      getDigestLength: function () { return __mdLen[impl] || 0; },
      clone: function () { return __makeDigest(impl, algo, h.copy()); }
    };
    return api;
  };
  var javaSecurityNs = {
    MessageDigest: {
      getInstance: function (algo) {
        var norm = String(algo == null ? '' : algo).toUpperCase().replace(/-/g, '');
        var map = { MD5: 'md5', SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
        var impl = map[norm];
        if (!impl) throw new Error('MessageDigest: unsupported algorithm ' + String(algo));
        return __makeDigest(impl, String(algo == null ? '' : algo));
      },
      isEqual: function (a, b) {
        var x = toBytes(a);
        var y = toBytes(b);
        if (x.length !== y.length) return false;
        var diff = 0;
        for (var i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
        return diff === 0;
      }
    },
    SecureRandom: function () {
      /**
       * #577：对齐宿主 / Java 语义 —— nextBytes(bytes) 是**就地填充**传入的 byte[]（不是返回长度）。
       * 旧实现把参数当「字节数」处理，源脚本写 random.nextBytes(arr) 会拿到一个新数组、
       * 原数组仍是全 0（设备号变 0 ⇒ 登录接口判无效）。
       * ⚠️ 本注释位于模板串内：禁止反引号。
       */
      this.nextInt = function (b) { var n = Math.floor(Number(b)); return (isFinite(n) && n > 0) ? Math.floor(Math.random() * n) : Math.floor(Math.random() * 0x7fffffff); };
      this.nextLong = function () { return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER); };
      this.nextDouble = function () { return Math.random(); };
      this.nextBytes = function (bytes) {
        var len = (bytes && bytes.length != null) ? bytes.length : -1;
        if (len < 0) throw new Error('SecureRandom.nextBytes: 参数必须是 byte[]');
        var rnd = randomBytes(len);
        for (var i = 0; i < len; i++) bytes[i] = rnd[i];
      };
    },
  };
  var javaMathNs = {
    BigInteger: (function () {
      function BI(v) { this.v = typeof v === 'bigint' ? v : BigInt(String(v == null ? 0 : v).replace(/[^0-9-]/g, '') || 0); }
      BI.prototype.toString = function (r) { return this.v.toString(r === 16 || r === '16' ? 16 : 10); };
      BI.prototype.add = function (o) { return new BI(this.v + (o instanceof BI ? o.v : BigInt(String(o)))); };
      BI.prototype.subtract = function (o) { return new BI(this.v - (o instanceof BI ? o.v : BigInt(String(o)))); };
      BI.prototype.multiply = function (o) { return new BI(this.v * (o instanceof BI ? o.v : BigInt(String(o)))); };
      BI.prototype.mod = function (o) { return new BI(this.v % (o instanceof BI ? o.v : BigInt(String(o)))); };
      BI.prototype.compareTo = function (o) { var x = o instanceof BI ? o.v : BigInt(String(o)); return this.v < x ? -1 : this.v > x ? 1 : 0; };
      BI.prototype.equals = function (o) { return String(o) === this.toString(); };
      BI.ONE = new BI(1);
      BI.ZERO = new BI(0);
      BI.valueOf = function (v) { return new BI(v); };
      return BI;
    })(),
  };
  var javaNioNs = {
    charset: { Charset: { forName: function (n) { return String(n == null ? 'UTF-8' : n); } } },
    ByteBuffer: {
      allocate: function (n) {
        var b = new Uint8Array(Math.max(0, Number(n) || 0));
        return {
          put: function (x) { if (x instanceof Uint8Array) { for (var i = 0; i < x.length; i++) b[i] = x[i]; } else { b[0] = Number(x) & 0xff; } return this; },
          array: function () { return b; },
          toString: function () { return Buffer.from(b).toString('utf8'); }
        };
      }
    },
  };
  var javaUtilZipNs = {
    GZIPInputStream: function (is) {
      this.__text = is && is.__text != null ? String(is.__text) : '';
      this.read = function () { return -1; };
      this.readBytes = function (n) { return new Uint8Array(gunzipSync(Buffer.from(this.__text, 'binary')).subarray(0, n)); };
      this.available = function () { return 0; };
      this.close = function () { return undefined; };
    },
    GZIPOutputStream: function () {
      this.buf = [];
      this.write = function (b) { if (b instanceof Uint8Array) { for (var i = 0; i < b.length; i++) this.buf.push(b[i]); } else { this.buf.push(Number(b) & 0xff); } return this; };
      this.toByteArray = function () { return new Uint8Array(gzipSync(Buffer.from(this.buf))); };
      this.toString = function () { return Buffer.from(gzipSync(Buffer.from(this.buf))).toString('base64'); };
      this.close = function () { return undefined; };
    },
    Inflater: function (n) { this.nowrap = n === true; },
    InflaterInputStream: function (is) {
      this.__text = is && is.__text != null ? String(is.__text) : '';
      this.readBytes = function (n) { return new Uint8Array(inflateSync(Buffer.from(this.__text, 'binary')).subarray(0, n)); };
      this.read = function () { return -1; };
      this.close = function () { return undefined; };
    },
  };
  /**
   * #605 new Packages.java.net.URL(u).openConnection()：番茄系/花花短剧的手写 HTTP 客户端整条链
   * 压在这上面（setRequestMethod / setRequestProperty / getOutputStream().write / getResponseCode /
   * getHeaderField / getInputStream|getErrorStream → GZIPInputStream → BufferedReader.readLine）。
   *
   * 传输复用 rpc('http')（与 java.ajax 同一条宿主出口：源级默认头 / Cookie / 表单体编码 / 超时一致）。
   * 时序照 JDK：openConnection 不发请求，getResponseCode/getInputStream/connect 才发。
   * 语义照 JDK：>=400 时 getInputStream 抛，错误体只能走 getErrorStream。
   * 本段位于模板串内：禁止反引号。
   */
  function __yueduOpenConnection(urlStr) {
    // 强制不压缩：本仓的流是**文本**面（rpc('http') 回来的是已解码字符串），
    // 让站点 gzip 等于把二进制塞进 utf8 解码器。脚本若显式设了 Accept-Encoding 会覆盖这里。
    var headers = { 'Accept-Encoding': 'identity' };
    var chunks = [];
    var bodyLen = 0;
    var method = 'GET';
    var resp = null;
    var fire = function () {
      if (resp) return resp;
      var bodyText = '';
      if (chunks.length) {
        var all = new Uint8Array(bodyLen);
        var off = 0;
        for (var ci = 0; ci < chunks.length; ci++) { all.set(chunks[ci], off); off += chunks[ci].length; }
        bodyText = Buffer.from(all).toString('utf-8');
      }
      var args = { url: urlStr, headers: headers };
      if (method && method !== 'GET') args.method = method;
      if (bodyText) args.body = bodyText;
      try {
        var r = rpc('http', args);
        resp = { code: r && r.code ? r.code : 0, headers: (r && r.headers) || {}, text: r && r.body != null ? String(r.body) : '' };
      } catch (e) {
        resp = { code: 0, headers: {}, text: '' };
      }
      return resp;
    };
    var mkStream = function (text) {
      var bytes = Buffer.from(String(text == null ? '' : text), 'utf-8');
      return { __text: String(text == null ? '' : text), _bytes: new Uint8Array(bytes) };
    };
    return {
      setRequestMethod: function (m) { method = String(m == null ? 'GET' : m).toUpperCase(); },
      getRequestMethod: function () { return method; },
      setDoOutput: function () { return undefined; },
      setDoInput: function () { return undefined; },
      setUseCaches: function () { return undefined; },
      setRequestProperty: function (k, v) { headers[String(k)] = String(v == null ? '' : v); },
      addRequestProperty: function (k, v) { headers[String(k)] = String(v == null ? '' : v); },
      getRequestProperty: function (k) { return headers[String(k)] != null ? headers[String(k)] : null; },
      setConnectTimeout: function () { return undefined; },
      setReadTimeout: function () { return undefined; },
      setInstanceFollowRedirects: function () { return undefined; },
      getOutputStream: function () {
        return {
          write: function (buf, off, len) {
            var src = toBytes(buf);
            var o = Number(off) || 0;
            var n = len == null ? src.length - o : Number(len) || 0;
            var slice = new Uint8Array(src.subarray(o, o + n));
            chunks.push(slice);
            bodyLen += slice.length;
          },
          flush: function () { return undefined; },
          close: function () { return undefined; },
          writeBytes: function (buf) { var src = toBytes(buf); chunks.push(new Uint8Array(src)); bodyLen += src.length; }
        };
      },
      connect: function () { fire(); },
      getResponseCode: function () { return fire().code; },
      getResponseMessage: function () { return fire().code >= 400 ? 'Error' : 'OK'; },
      getHeaderField: function (n) {
        var k = String(n == null ? '' : n).toLowerCase();
        var h = fire().headers;
        for (var key in h) { if (String(key).toLowerCase() === k) return String(h[key]); }
        return null;
      },
      getHeaderFields: function () { return fire().headers; },
      getContentLength: function () { return Buffer.from(fire().text, 'utf-8').length; },
      getContentType: function () { return this.getHeaderField('content-type'); },
      getInputStream: function () {
        var r = fire();
        if (r.code >= 400) throw new Error('getInputStream: HTTP ' + r.code);
        return mkStream(r.text);
      },
      getErrorStream: function () {
        var r = fire();
        return r.code >= 400 ? mkStream(r.text) : null;
      },
      disconnect: function () { return undefined; }
    };
  }
  var javaNetNs = {
    URL: function (u) { this.u = String(u == null ? '' : u);
      this.toString = function () { return this.u; };
      this.toExternalForm = function () { return this.u; };
      this.getProtocol = function () { return (this.u.match(/^([a-z0-9+.-]+):/i) || [])[1] || ''; };
      this.getHost = function () { return (this.u.match(/^[a-z0-9+.-]+:\/\/([^/:]+)/i) || [])[1] || ''; };
      this.getPath = function () { return (this.u.replace(/^[a-z0-9+.-]+:\/\/[^/]+/i, '').match(/^[^?#]*/) || [''])[0]; };
      this.getQuery = function () { return (this.u.match(/\?([^#]*)/) || [])[1] || ''; };
      this.getRef = function () { return (this.u.match(/#(.*)$/) || [])[1] || null; };
      this.getFile = function () { return this.getPath() + (this.getQuery() ? '?' + this.getQuery() : ''); };
      this.getPort = function () { var m = this.u.match(/^[a-z0-9+.-]+:\/\/[^/:]+:(\d+)/i); return m ? Number(m[1]) : -1; };
      this.getDefaultPort = function () { var p = this.getProtocol().toLowerCase(); return p === 'https' ? 443 : (p === 'http' ? 80 : -1); };
      this.openConnection = function () { return __yueduOpenConnection(this.u); };
      this.openStream = function () { return __yueduOpenConnection(this.u).getInputStream(); };
    },
    InetAddress: {
      getByName: function (h) { return { getHostAddress: function () { return '127.0.0.1'; }, getHostName: function () { return String(h == null ? '' : h); } }; }
    },
    Socket: function () {
      this.getInputStream = function () { return new JInputStreamReader({ __text: '' }); };
      this.getOutputStream = function () { return new JByteArrayOutputStream(); };
      this.close = function () { return undefined; };
    },
    InetSocketAddress: function (h, p) { this.host = String(h == null ? '' : h); this.port = Number(p) || 0;
      this.toString = function () { return this.host + ':' + this.port; };
    },
  };
  var javaxNetNs = {
    ssl: { SSLSocketFactory: { getDefault: function () { return { createSocket: function () { return new javaNetNs.Socket(); } }; } } },
  };
  var androidTextNs = {
    TextUtils: { isEmpty: function (s) { return s == null || String(s).length === 0; } },
  };
  var kazusaNs = {
    utils: { TimeoutCancellationException: function () { this.message = 'timeout'; } },
  };
  var javaNs = {
    // #501 P0-1a-2：直接内联（后赋值在该模板里不可靠，内联如 String: JStringImpl 验证可用）
    security: javaSecurityNs,
    math: javaMathNs,
    nio: javaNioNs,
    net: javaNetNs,
    io: { ByteArrayOutputStream: JByteArrayOutputStream, ByteArrayInputStream: JByteArrayInputStream, BufferedReader: JBufferedReader, InputStreamReader: JInputStreamReader },
    util: {
      ArrayList: ArrayList, HashMap: HashMap, List: ArrayList, Map: HashMap,
      Arrays: {
        asList: function (a) { return Array.isArray(a) ? a : [a]; },
        toString: function (a) { return String(a); },
        copyOfRange: function (b, f, t) { var by = toBytes(b); f = Math.max(0, Number(f) || 0); t = Math.min(by.length, Number(t) || 0); return f >= t ? new Uint8Array(0) : new Uint8Array(by.subarray(f, t)); },
        copyOf: function (b, n) { var by = toBytes(b); var out = new Uint8Array(Math.max(0, Number(n) || 0)); out.set(by.subarray(0, Math.min(out.length, by.length))); return out; }
      },
      // #501 对齐宿主 makeJavaPackages：返回带 toString() 的对象（源里常写 .toString() 取串）
      UUID: { randomUUID: function () { return { toString: function () { return (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2); } }; } },
      zip: javaUtilZipNs,
      Base64: {
        getEncoder: function () { return { encodeToString: function (s) { return Buffer.from(toBytes(s)).toString('base64'); } }; },
        getDecoder: function () { return { decode: function (s) { return new Uint8Array(Buffer.from(String(s == null ? '' : s), 'base64')); } }; },
        // #500 补 getUrlEncoder/getUrlDecoder（宿主 makeJavaPackages 同款）
        getUrlEncoder: function () { return { encodeToString: function (s) { return Buffer.from(toBytes(s)).toString('base64url'); } }; },
        getUrlDecoder: function () { return { decode: function (s) { return new Uint8Array(Buffer.from(String(s == null ? '' : s), 'base64url')); } }; },
      },
    },
    lang: {
      // new Packages.java.lang.String(bytes, 'UTF-8') → String 包装
      // #501 换成宿主 makeJString 同款（字节解码 / 字符串原样；第二参区分语义）
      String: JStringImpl,
      Integer: { parseInt: function (s) { return parseInt(String(s), 10) || 0; }, valueOf: function (s) { return parseInt(String(s), 10) || 0; }, toHexString: function (n) { return (Number(n) >>> 0).toString(16); } },
      Long: { parseLong: function (s) { return parseInt(String(s), 10) || 0; } },
      StringBuilder: JStringBuilder,
      System: {
        currentTimeMillis: function () { return Date.now(); },
        nanoTime: function () { return Number(process.hrtime.bigint()); },
        lineSeparator: function () { return '\n'; },
        getProperty: function (k) { return ({ 'line.separator': '\n', 'file.separator': '/', 'os.name': 'Linux' })[String(k)]; },
      },
      /**
       * Packages.java.lang.Thread.sleep(ms)。
       *
       * 语义与 L1 的 threadNs() 一致：worker 内真睡（只阻塞本脚本），上限 3s。
       */
      Thread: {
        sleep: function (ms) {
          var raw = Math.max(0, Number(ms) || 0);
          var ms2 = Math.min(raw, 3000);
          if (ms2 > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms2);
        },
        currentThread: function () { return { getName: function () { return 'worker'; } }; },
      },
    },
  };
  /* #500 cn.hutool（qm 系签名的高频依赖：DigestUtil.md5Hex 等）。
     与宿主 makeJavaPackages 的 cn 子树同语义；这里用 Buffer/node:crypto 实现。 */
  var cnNs = {
    hutool: {
      crypto: {
        digest: {
          DigestUtil: {
            md5Hex: function (v) { return hexOf('md5', v); },
            md5Hex16: function (v) { return hexOf('md5', v).slice(8, 24); },
            sha1Hex: function (v) { return hexOf('sha1', v); },
            sha256Hex: function (v) { return hexOf('sha256', v); },
            sha512Hex: function (v) { return hexOf('sha512', v); }
          }
        }
      },
      core: {
        codec: {
          Base64: {
            encode: function (v) { return Buffer.from(toBytes(v)).toString('base64'); },
            decode: function (v) { return new Uint8Array(Buffer.from(String(v == null ? '' : v), 'base64')); },
            encodeStr: function (v) { return Buffer.from(toBytes(v)).toString('base64'); },
            decodeStr: function (v) { return Buffer.from(String(v == null ? '' : v), 'base64').toString('utf8'); }
          }
        },
        util: {
          CharsetUtil: { UTF_8: 'UTF-8', ISO_8859_1: 'ISO-8859-1', GBK: 'GBK' },
          HexUtil: {
            encodeHexStr: function (v) { return Buffer.from(toBytes(v)).toString('hex'); },
            decodeHex: function (s) { return new Uint8Array(Buffer.from(String(s == null ? '' : s), 'hex')); }
          },
          StrUtil: {
            isBlank: function (v) { return v == null || String(v).trim() === ''; },
            isNotBlank: function (v) { return !(v == null || String(v).trim() === ''); },
            isEmpty: function (v) { return v == null || String(v) === ''; }
          }
        }
      }
    }
  };
  /* #500 javax.crypto（AES/DES 解密链；既有 androidNs 只有 util.Base64） */
  var javaxNs = {
    crypto: {
      /* #504 Cipher 完整对齐宿主 makeCipherNs / makeCipherInstance：
         · 静态工厂 getInstance（Java 语义）+ 原型 init/doFinal；
         · 算法名按 node 要求拼（aes-128-cbc / aes-256-gcm / des-ede3-cbc…）——
           此前直接传 'AES' ⇒ node 报 Unknown cipher ⇒ 七猫正文全挂；
         · GCM：密文 = ct || tag（tag 位数取 GCMParameterSpec.getTLen）；
         · ChaCha20-Poly1305 / ChaCha20 一并支持。 */
      Cipher: (function () {
        function Cipher(algo) { this.algo = String(algo || ''); this.op = 1; this.key = null; this.iv = null; this.tagLen = 128; }
        Cipher.prototype.getInstance = function (a) { return new Cipher(a); };
        Cipher.prototype.init = function (op, key, iv) {
          this.op = Number(op) === 2 ? 2 : 1;
          this.key = toBytes(key);
          if (iv == null) { this.iv = null; }
          else if (iv.iv != null) { this.iv = toBytes(iv.iv); if (iv.tagLength != null) this.tagLen = Number(iv.tagLength); }
          else { this.iv = toBytes(iv); }
          return this;
        };
        Cipher.prototype.doFinal = function (data) {
          var t = String(this.algo || 'AES/CBC/PKCS5Padding').trim();
          var m = /^(AES|DES|DESede|RSA)\/(CBC|ECB|GCM|CTR)\/(NoPadding|PKCS5Padding|ISO10126Padding)$/i.exec(t);
          var chacha = /^(ChaCha20-Poly1305|ChaCha20)$/i.exec(t);
          var input = toBytes(data);
          if (chacha) {
            var aead = /poly1305/i.test(chacha[1]);
            var opts = aead ? { authTagLength: 16 } : undefined;
            var nonce = this.iv || Buffer.alloc(12);
            if (!aead && nonce.length === 12) nonce = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce)]);
            if (this.op === 2) {
              var tagLen = aead ? 16 : 0;
              var ct = aead ? input.subarray(0, input.length - tagLen) : input;
              var d = createDecipheriv('chacha20', this.key, nonce, opts || {});
              if (aead) d.setAuthTag(Buffer.from(input.subarray(input.length - tagLen)));
              return new Uint8Array(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
            }
            var e = createCipheriv('chacha20', this.key, nonce, opts || {});
            var out2 = Buffer.concat([e.update(Buffer.from(input)), e.final()]);
            return aead ? new Uint8Array(Buffer.concat([out2, e.getAuthTag()])) : new Uint8Array(out2);
          }
          if (!m) return new Uint8Array(0);
          var base = m[1].toLowerCase();
          if (base === 'desede') base = 'des-ede3';
          var mode = m[2].toLowerCase();
          var pad = !/NoPadding/i.test(m[3]);
          var variant = base;
          if (base === 'aes') {
            var bits = this.key.length * 8;
            if (bits !== 128 && bits !== 192 && bits !== 256) {
              throw new Error('Cipher: AES 密钥长度须为 16/24/32 字节，实际 ' + this.key.length);
            }
            variant = 'aes-' + bits;
          }
          if (mode === 'gcm') {
            var tl = Math.floor((this.tagLen || 128) / 8);
            var ivg = this.iv || Buffer.alloc(12);
            if (this.op === 2) {
              var c2 = input.subarray(0, input.length - tl);
              var tag = input.subarray(input.length - tl);
              var dg = createDecipheriv(variant + '-gcm', this.key, ivg);
              dg.setAuthTag(Buffer.from(tag));
              return new Uint8Array(Buffer.concat([dg.update(Buffer.from(c2)), dg.final()]));
            }
            var eg = createCipheriv(variant + '-gcm', this.key, ivg);
            var ctg = Buffer.concat([eg.update(Buffer.from(input)), eg.final()]);
            return new Uint8Array(Buffer.concat([ctg, eg.getAuthTag()]));
          }
          var algo = mode === 'ecb' ? variant + '-ecb' : variant + '-cbc';
          var ivv = mode === 'ecb' ? null : (this.iv || null);
          var cc = this.op === 2 ? createDecipheriv(algo, this.key, ivv) : createCipheriv(algo, this.key, ivv);
          if (!pad) cc.setAutoPadding(false);
          return new Uint8Array(Buffer.concat([cc.update(Buffer.from(input)), cc.final()]));
        };
        Cipher.getInstance = function (a) { return new Cipher(a); };
        Cipher.ENCRYPT_MODE = 1;
        Cipher.DECRYPT_MODE = 2;
        return Cipher;
      })(),
      spec: {
        SecretKeySpec: function (key, algo) { return toBytes(key); },
        IvParameterSpec: function (iv) { return toBytes(iv); },
        // #503 GCM 参数（tagLen, iv）—— 听友M/纸间 的 AEAD 链需要
        GCMParameterSpec: function (tagLen, iv) { return { tagLength: Number(tagLen) || 128, iv: toBytes(iv) }; }
      },
      // #503 HmacMD5/HmacSHA1…：Mac.getInstance(algo).init(key).doFinal(data)
      Mac: {
        getInstance: function (algo) {
          var m = /hmac\s*([\w-]+)/i.exec(String(algo == null ? '' : algo));
          var impl = m ? m[1].toLowerCase().replace('-', '') : 'md5';
          var map = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha512: 'sha512' };
          var a = map[impl] || 'md5';
          return {
            init: function (key) { this.key = toBytes(key); return this; },
            doFinal: function (data) { return new Uint8Array(createHmac(a, this.key || Buffer.alloc(0)).update(toBytes(data)).digest()); }
          };
        }
      }
    }
  };
  var androidNs = {
    util: {
      Base64: {
        decode: function (input, flags) { void flags; return Buffer.from(String(input == null ? '' : input), 'base64'); },
        // #537：对齐 L1 的 toJavaBytes 语义 —— 字节数组输入**不能**走 String()（Buffer 会被
        // 变成 "255,216,…" 十进制串再被 base64，禁漫天堂 compress 回包即复现过这条）
        encode: function (input, flags) { void flags; return new Uint8Array(Buffer.from(Buffer.from(toBytes(input)).toString('base64'), 'base64')); },
        encodeToString: function (input, flags) { void flags; return Buffer.from(toBytes(input)).toString('base64'); },
        NO_WRAP: 2, DEFAULT: 0,
      },
    },
    /**
     * #526 android.graphics（worker 版）：**不在这里做像素运算**，而是把位图存在宿主、
     * worker 只持句柄（整数 id），每次操作 rpc('bitmap', …) 回宿主用
     * selector/android-graphics.ts 的**唯一实现**执行。
     *
     * 为什么这么绕：编解码器（jpeg-js / pngjs / libwebp wasm）只在宿主 bundle 里，
     * 在 worker 内重写一份必然漂移（本仓已有「两处各写一份 → 静默不一致」的教训）。
     * 走 RPC 后，worker 与 L1 是**同一份像素实现**，语义零差异。
     *
     * 代价：每张图多一次同步 RPC（worker 内 Atomics.wait，不阻塞宿主事件循环），
     * 禁漫天堂一页 ~4 次调用，实测可接受。真正贵的是「整源留 L1 ⇒ 阻塞主线程」。
     *
     * #537：compress 改**二进制回包**（SAB status=3，免 base64/JSON 化）；draw/fill/release
     * 是免回复 op ⇒ 并入**有序**非阻塞通道（postMessage 同端口保序，后续同步 op 天然看得到），
     * 不再各等一次往返；句柄空闲 30s 由宿主自动回收（TTL）。
     */
    graphics: (function () {
      function op(payload) { return rpc('bitmap', payload); }
      function wrap(meta) {
        if (!meta || meta.id == null) throw new Error('Bitmap: 宿主未返回位图句柄');
        var id = meta.id;
        var w = Number(meta.width) || 0;
        var h = Number(meta.height) || 0;
        return {
          __bitmapId: id,
          getWidth: function () { return w; },
          getHeight: function () { return h; },
          getConfig: function () { return 'ARGB_8888'; },
          getByteCount: function () { return w * h * 4; },
          isRecycled: function () { return false; },
          recycle: function () { bitmapNoWait({ op: 'release', id: id }); },
          getPixels: function () { return undefined; },
          compress: function (format, quality, stream) {
            // #537 ③：大图原始字节回包（SAB status=3）；小图宿主回 base64 JSON（原路），
            // 超单片容量也会退回 base64 JSON 分片 ⇒ 两条路都通。
            var r = rpcBinary('bitmap', { op: 'compress', id: id, format: String(format == null ? 'PNG' : format), quality: Number(quality) || 100 });
            var bytes = (r instanceof Uint8Array) ? r : new Uint8Array(Buffer.from(String((r && r.b64) || ''), 'base64'));
            if (!stream || typeof stream.write !== 'function') {
              throw new Error('Bitmap.compress: 第 3 个参数必须是 ByteArrayOutputStream');
            }
            stream.write(bytes);
            return true;
          },
        };
      }
      var BitmapFactory = {
        decodeByteArray: function (bytes, off, len) {
          var u8 = bytes instanceof Uint8Array ? bytes
            : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
              : (bytes && bytes.length != null ? new Uint8Array(bytes) : new Uint8Array(0)));
          var s = off == null ? 0 : (Number(off) | 0);
          var e = (len == null || Number(len) <= 0) ? u8.length : s + (Number(len) | 0);
          return wrap(op({ op: 'decode', bytes: u8.subarray(s, e) }));
        },
        decodeFile: function () { throw new Error('BitmapFactory.decodeFile: worker 侧不支持（无本地文件句柄）'); },
      };
      var Bitmap = {
        createBitmap: function (a, b, c, d, e) {
          if (a && a.__bitmapId != null) {
            return wrap(op({ op: 'crop', src: a.__bitmapId, x: Number(b) || 0, y: Number(c) || 0, w: Number(d) || 0, h: Number(e) || 0 }));
          }
          return wrap(op({ op: 'create', w: Number(a) || 0, h: Number(b) || 0 }));
        },
        Config: { ARGB_8888: 'ARGB_8888', RGB_565: 'RGB_565', ALPHA_8: 'ALPHA_8', RGBA_F16: 'RGBA_F16' },
        CompressFormat: { PNG: 'PNG', JPEG: 'JPEG', WEBP: 'WEBP' },
      };
      function Canvas(target) {
        if (!target || target.__bitmapId == null) {
          throw new Error('Canvas: 构造参数必须是 Bitmap（本实现只支持位图画布）');
        }
        this.__canvasId = target.__bitmapId;
        this.drawBitmap = function (src, a, b) {
          if (!src || src.__bitmapId == null) throw new Error('Canvas.drawBitmap: 第 1 个参数必须是 Bitmap');
          // #587 六参形态：(bmp, srcRect, dstRect, paint) —— Rect 按鸭子类型认
          //（四个 int 字段齐了就当 Rect；跨 realm 也不能靠 instanceof）
          var r1 = a && typeof a.left === 'number' && typeof a.top === 'number' && typeof a.right === 'number' && typeof a.bottom === 'number' ? a : null;
          var r2 = b && typeof b.left === 'number' && typeof b.top === 'number' && typeof b.right === 'number' && typeof b.bottom === 'number' ? b : null;
          if (r1 && r2) {
            bitmapNoWait({ op: 'drawRegion', dst: target.__bitmapId, src: src.__bitmapId,
              sl: r1.left, st: r1.top, sr: r1.right, sb: r1.bottom,
              dl: r2.left, dt: r2.top, dr: r2.right, db: r2.bottom });
            return;
          }
          // #537 ③：免回复 op 先入同帧队列，由 flushBitmapOps 合并成一条 RPC（YUEDU_BITMAP_BATCH=0 回退旧行为）。
          bitmapNoWait({ op: 'draw', dst: target.__bitmapId, src: src.__bitmapId, left: Number(a) || 0, top: Number(b) || 0 });
        };
        this.drawColor = function (color) { bitmapNoWait({ op: 'fill', id: target.__bitmapId, color: Number(color) >>> 0 }); };
      }
      /**
       * #587 Rect：新版禁漫天堂系 imageDecode 的 drawBitmap(bmp, src, dst, paint) 指定区域用
       *（canvas.drawBitmap(bmp, new Rect(0,ys,w,ys+m2), new Rect(0,yd,w,yd+m2), pt)）。
       * 缺它 ⇒ new undefined 抛「Rect is not a constructor」⇒ 解密被 try 吞掉 ⇒ 回原图。
       * Android 的 Rect 是**公共 int 字段**；worker 侧只做数据持有，区域搬运回宿主
       * android-graphics.ts 的唯一实现执行（op: 'drawRegion'）。
       * ⚠️ 本注释位于模板串内：禁止反引号。
       */
      function Rect(left, top, right, bottom) {
        this.left = Math.floor(Number(left) || 0);
        this.top = Math.floor(Number(top) || 0);
        this.right = Math.floor(Number(right) || 0);
        this.bottom = Math.floor(Number(bottom) || 0);
      }
      Rect.prototype.width = function () { return this.right - this.left; };
      Rect.prototype.height = function () { return this.bottom - this.top; };
      Rect.prototype.isEmpty = function () { return this.left >= this.right || this.top >= this.bottom; };
      Rect.prototype.contains = function (x, y) { return x >= this.left && x < this.right && y >= this.top && y < this.bottom; };
      Rect.prototype.toString = function () { return 'Rect(' + this.left + ', ' + this.top + ' - ' + this.right + ', ' + this.bottom + ')'; };
      /**
       * #577 Paint：只做状态容器（与宿主 android-graphics.ts 的 makePaintCtor 同一语义）。
       * 新版禁漫系 imageDecode 会 new Paint() → 缺它整段解密抛错 → 图片保持横条。
       * ⚠️ 本注释位于模板串内：禁止反引号。
       */
      function Paint() {
        this.antiAlias = false; this.filterBitmap = false; this.dither = false;
        this.color = 0xff000000; this.alpha = 255; this.style = 'FILL'; this.strokeWidth = 0;
        this.setAntiAlias = function (v) { this.antiAlias = !!v; };
        this.isAntiAlias = function () { return this.antiAlias; };
        this.setFilterBitmap = function (v) { this.filterBitmap = !!v; };
        this.isFilterBitmap = function () { return this.filterBitmap; };
        this.setDither = function (v) { this.dither = !!v; };
        this.isDither = function () { return this.dither; };
        this.setColor = function (c) { this.color = Number(c) >>> 0; };
        this.getColor = function () { return this.color; };
        this.setAlpha = function (a) { this.alpha = Math.max(0, Math.min(255, Number(a) || 0)); };
        this.getAlpha = function () { return this.alpha; };
        this.setStyle = function (s) { this.style = String(s == null ? 'FILL' : s); };
        this.getStyle = function () { return this.style; };
        this.setStrokeWidth = function (w) { this.strokeWidth = Number(w) || 0; };
        this.getStrokeWidth = function () { return this.strokeWidth; };
        this.reset = function () {
          this.antiAlias = false; this.filterBitmap = false; this.dither = false;
          this.color = 0xff000000; this.alpha = 255; this.style = 'FILL'; this.strokeWidth = 0;
        };
      }
      return { BitmapFactory: BitmapFactory, Bitmap: Bitmap, Canvas: Canvas, Paint: Paint, Rect: Rect };
    })(),
  };
  /**
   * #538 okhttp3 桥（收口 #473 剩余 3 源：阅文集团 / 大灰狼聚合 / 木里聚合）。
   *
   * 面 = 语料实测最小集（不是完整 okhttp 移植）：
   *  · 阅文 / 木里：new OkHttpClient() → new Request.Builder().url(u).get()/post(body)
   *    .addHeader(k,v)…build() → client.newCall(req).execute() → resp.body().bytes()|string()
   *  · 大灰狼：HttpUrl.parse(u).topPrivateDomain()（hasJavaClass 守卫 + importClass 形态）
   *
   * 传输：execute() 走 httpRpcRaw（raw 模式，base64 回传真实字节）—— 与 java.ajax
   * 同一条同步出口 ⇒ 源级默认头 / 会话 Cookie / 同步预算 / 超时自动一致，不另起第二条
   * HTTP 通道（#529 Jsoup.connect 同纪律）。为什么必须 raw：阅文正文密文是二进制帧
   * （8B 头 + 16B 尾），utf8 文本往返会把 ≥0x80 的字节熔成 U+FFFD ⇒ 解密必失败。
   * ⚠️ 本注释位于模板串内：禁反引号。
   */
  var okhttp3Ns = (function () {
    function MediaType() {}
    MediaType.parse = function (s) { return { __mediaType: String(s == null ? '' : s) }; };

    function RequestBody(content, contentType) {
      this.__content = content == null ? '' : content;
      this.__contentType = contentType && contentType.__mediaType != null ? contentType.__mediaType : String(contentType == null ? '' : contentType);
    }
    RequestBody.create = function (content, contentType) { return new RequestBody(content, contentType); };

    function Request(u) { this.__url = String(u == null ? '' : u); this.__method = 'GET'; this.__body = null; this.__headers = {}; }
    function RequestBuilder() { this.__r = new Request(''); }
    RequestBuilder.prototype.url = function (u) { this.__r.__url = String(u == null ? '' : u); return this; };
    RequestBuilder.prototype.get = function () { this.__r.__method = 'GET'; this.__r.__body = null; return this; };
    RequestBuilder.prototype.post = function (body) {
      this.__r.__method = 'POST';
      this.__r.__body = body instanceof RequestBody ? body : new RequestBody(body, null);
      return this;
    };
    RequestBuilder.prototype.put = function (body) {
      this.__r.__method = 'PUT';
      this.__r.__body = body instanceof RequestBody ? body : new RequestBody(body, null);
      return this;
    };
    RequestBuilder.prototype.addHeader = function (k, v) { this.__r.__headers[String(k)] = String(v == null ? '' : v); return this; };
    RequestBuilder.prototype.header = function (k, v) { return this.addHeader(k, v); };
    RequestBuilder.prototype.headers = function (m) { if (m) { for (var k in m) this.__r.__headers[k] = String(m[k]); } return this; };
    RequestBuilder.prototype.build = function () { return this.__r; };
    Request.Builder = RequestBuilder;

    function ResponseBody(bytes) { this.__bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(0); }
    ResponseBody.prototype.bytes = function () { return this.__bytes; };
    ResponseBody.prototype.string = function () { return Buffer.from(this.__bytes).toString('utf8'); };
    ResponseBody.prototype.contentType = function () { return null; };

    function Response(code, headers, bytes) {
      this.__code = Number(code) || 0;
      this.__headers = headers || {};
      this.__body = new ResponseBody(bytes);
    }
    Response.prototype.code = function () { return this.__code; };
    Response.prototype.message = function () { return ''; };
    Response.prototype.isSuccessful = function () { return this.__code >= 200 && this.__code < 300; };
    Response.prototype.body = function () { return this.__body; };
    Response.prototype.header = function (name) {
      var hs = this.__headers || {};
      var lower = String(name == null ? '' : name).toLowerCase();
      for (var k in hs) { if (k.toLowerCase() === lower) return hs[k]; }
      return null;
    };
    Response.prototype.headers = function () { return this.__headers || {}; };

    function Call(request) { this.__req = request; }
    Call.prototype.execute = function () {
      var req = this.__req;
      var headers = {};
      for (var k in req.__headers) headers[k] = req.__headers[k];
      var body = req.__body;
      if (body && body.__contentType && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = body.__contentType;
      var r = httpRpcRaw(req.__method, req.__url, body ? body.__content : undefined, headers, false);
      return new Response(r.code, r.headers, r.bytes);
    };
    function OkHttpClient() {}
    OkHttpClient.prototype.newCall = function (request) { return new Call(request); };

    // HttpUrl：eTLD+1 启发式（小后缀表 + 默认末二段）—— 只服务 getSubDomain 一类用法
    var MULTI_SUFFIX = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'com.jp', 'com.hk', 'com.tw', 'com.au', 'co.kr'];
    function topPrivateDomain(host) {
      var h = String(host == null ? '' : host).toLowerCase().replace(/\.$/, '');
      if (!h) return '';
      var parts = h.split('.');
      if (parts.length <= 2) return h;
      var last2 = parts.slice(-2).join('.');
      var last3 = parts.slice(-3).join('.');
      if (MULTI_SUFFIX.indexOf(last2) >= 0) return parts.length >= 3 ? last3 : h;
      if (MULTI_SUFFIX.indexOf(last3) >= 0 && parts.length >= 4) return parts.slice(-4).join('.');
      return last2;
    }
    function HttpUrl(u) { this.__u = String(u == null ? '' : u); this.__host = ''; }
    HttpUrl.parse = function (u) {
      var s = String(u == null ? '' : u);
      var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(s);
      var o = new HttpUrl(s);
      o.__host = m ? m[1].split('@').pop().split(':')[0] : '';
      return o;
    };
    HttpUrl.prototype.host = function () { return this.__host; };
    HttpUrl.prototype.topPrivateDomain = function () { return topPrivateDomain(this.__host); };
    HttpUrl.prototype.scheme = function () { var m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(this.__u); return m ? m[1].toLowerCase() : ''; };
    HttpUrl.prototype.queryParameter = function (name) {
      var q = /\?([^#]*)/.exec(this.__u);
      if (!q) return null;
      var pairs = q[1].split('&');
      for (var i = 0; i < pairs.length; i++) {
        var kv = pairs[i].split('=');
        if (decodeURIComponent(kv[0].replace(/\+/g, ' ')) === String(name)) {
          return kv.length > 1 ? decodeURIComponent(kv.slice(1).join('=').replace(/\+/g, ' ')) : '';
        }
      }
      return null;
    };
    HttpUrl.prototype.toString = function () { return this.__u; };

    return {
      OkHttpClient: OkHttpClient,
      Request: Request,
      RequestBody: RequestBody,
      MediaType: MediaType,
      Response: Response,
      ResponseBody: ResponseBody,
      Call: Call,
      HttpUrl: HttpUrl,
    };
  })();
  var __nestWarned = {};
  function nest(path) {
    var f = function () { return ''; };
    /* #500 未知路径一次性 warn（铁律 4：兜底必须留痕）—— 与宿主 makeJavaPackages
       的「未知包留痕 + 空串」同语义，避免 worker 路径的静默失败无法归因。
       #612：被上游 ClassShutter 挡掉的路径返回 undefined（类不可见），与宿主同判据。 */
    try {
      rpcNoWait('warn', { msg: '[worker] Packages 未实现路径（返回空）：' + String(path || '') + ' ' + String(new Error().stack || '').split('\n')[2] });
    } catch (e) { /* 宿主不可达：不影响求值 */ }
    return new Proxy(f, { get: function (_t, prop) { if (prop === 'prototype') return undefined; var full = path ? path + '.' + String(prop) : String(prop); if (__yueduShuttered(full)) return undefined; return nest(full); }, apply: function () { return ''; } });
  }
  var javaTopNs = {
    URLEncoder: { encode: function (s) { return encodeURIComponent(String(s == null ? '' : s)).replace(/[!'()*]/g, function (ch) { return '%' + ch.charCodeAt(0).toString(16).toUpperCase(); }); } },
    URLDecoder: { decode: function (s) { try { return decodeURIComponent(String(s == null ? '' : s)); } catch (e) { return String(s == null ? '' : s); } } }
  };
  var javaxTopNs = { crypto: javaxNs.crypto, net: javaxNetNs };
  var androidTopNs = { util: androidNs.util, graphics: androidNs.graphics, text: androidTextNs };
  /* #522 io.legado.app.help.http.StrResponse（语料 4 源：爱丽丝书屋×3 / 点众阅读 / 聚合书库）——
     与宿主 makeJavaPackages 的 StrResponseCtor 同语义：new StrResponse(url, body, code) 造可链式响应；
     worker 侧复用本文件的 strResponse（与 java.ajax 走同一条 HTTP 语义），不再写第二份实现。 */
  var strResponseCtor = function StrResponse(u, b, c) {
    return strResponse(b == null ? '' : String(b), {}, typeof c === 'number' ? c : 200, { url: String(u == null ? '' : u) });
  };
  var ioNs = { legado: { kazusa: kazusaNs, app: { help: { http: { StrResponse: strResponseCtor, StrResponseKt: strResponseCtor } } } }, legato: { kazusa: kazusaNs } };
  return new Proxy({ java: javaNs, javax: javaxTopNs, android: androidTopNs, okhttp3: okhttp3Ns, cn: cnNs, org: __ORG_NS, io: ioNs, net: javaTopNs }, { get: function (t, prop) { return prop in t ? t[prop] : nest(); } });


})();

/* #526 JavaImporter（worker 版）：与宿主 makeJavaImporterCtor 同语义 ——
   importPackage(pkg) 把包对象的 own 属性挂到 importer 自身，with(importer) 便经
   with 作用域解析到裸类名（Rhino 语义）；new / 无 new 均可调。
   为什么要有：语料 10 个源用 JavaImporter（七猫 3.9.61 / 茄子 / 星空 / 禁漫天堂 …），
   此前一律被 needsJavaBridgeL1 强制留 L1 ⇒ L1 的 execFileSync(curl) 阻塞主线程
   （#497 实证的 stall 主因家族）。worker 是非严格模式，with + 动态属性可用。
   （本段在 String.raw 模板内：注释禁反引号与美元花括号） */
var __yueduJavaImporterCtor = (function () {
  function attachTo(target, pkg) {
    if (pkg == null || typeof pkg !== 'object') return;
    var keys = Object.keys(pkg);
    for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (target[k] == null) target[k] = pkg[k]; }
  }
  function JavaImporter() {
    var self = this instanceof JavaImporter ? this : {}; /* eslint-disable-line */
    self.importPackage = function () {
      for (var i = 0; i < arguments.length; i++) attachTo(self, arguments[i]);
    };
    self.importClass = self.importPackage;
    for (var i = 0; i < arguments.length; i++) attachTo(self, arguments[i]);
    return self;
  }
  return JavaImporter;
})();
/* Rhino 全局 importPackage(pkg)：挂到当前全局作用域。只补缺不覆盖原生全局
   （String/Array 等原生名不会被换掉）。runCode 的快照/恢复会删掉本作业新增的键。 */
function __yueduImportPackage() {
  for (var i = 0; i < arguments.length; i++) {
    var pkg = arguments[i];
    if (pkg == null || typeof pkg !== 'object') continue;
    var keys = Object.keys(pkg);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (globalThis[k] == null) { try { globalThis[k] = pkg[k]; } catch (e) { /* 只读全局 */ } }
    }
  }
}

// ---- 同步 RPC：java.ajax 等在脚本里是同步语义（Legado 源如此）。
// 机制：postMessage 发请求 → Atomics.wait 同步阻塞本 worker（不阻塞宿主）→
//       宿主异步执行后把结果写入 SharedArrayBuffer 并 Atomics.notify → 本 worker 醒来读结果。
//
// SAB 布局（i32 索引，头部 8 个 = byte 0..31，数据从 byte 32 起）：
//   [0] callId   [1] status（0 等 / 1 单片完成 / 2 分片模式）   [2] 本片字节长
//   [3] 分片握手位（本 worker 消费完一片 → 置 1 + notify 宿主，请它写下一片）
//   [4] 当前片号  [5] 总片数  [6] 结果总字节长（诊断用）  [7] 保留
//
// 为什么要分片（#105）：宿主回传的大结果（媒体 body）会超过单块 SAB 的容量。
// 分片用**同一块 SAB 反复写**，靠 i32[3] 握手推进 —— 不加大 SAB（内存 × 池大小），
// 也不新建 SAB（worker 正卡在 Atomics.wait 里，收不到 postMessage，换不了通道）。
var SAB_HEAD_I32 = 8;
var SAB_DATA_OFF_BYTES = 32;
let SAB = null;
let rpcSeq = 0;
/** '#480-b' 批量求值：当前跑到批里的第几个作业（宿主据此把 RPC 路由回正确的作业） */
var CUR_JOB = 0;
/**
 * #745 DOM 读缓存世代（worker 内）：mkList 快照里的 text/attrs/outerHTML 都是**建表那一刻**的值，
 * 一旦同一棵树上发生过写操作（setText/setAttr/remove/append）就整体作废。
 * 每次写 op 成功后自增一次 —— 判定只需一次整数比较，比「逐元素打 dirty 标记」便宜且不会漏标
 * （元素对象可能在 Elements.add 里被共享/复制，逐对象标记反而容易漏）。
 * 注意：本段位于模板串内，禁反引号与美元花括号。
 */
var __yueduDomEpoch = 0;
var __YUEDU_DOM_MUT_OPS = { setText: 1, setAttr: 1, setAttrAll: 1, remove: 1, append: 1 };
function rpc(method, args) {
  // #537 ②：同步位图 op 只冲洗**同句柄**的排队写入（其余继续攒批，见 flushBitmapOps）
  if (method === 'bitmap') flushBitmapOps(bitmapFlushIds(args));
  const callId = ++rpcSeq;
  try {
    parentPort.postMessage({ kind: 'rpc', callId, method, args, job: CUR_JOB, at: Date.now() });
  } catch (e) {
    // 参数不可结构化克隆（源脚本把带方法的对象塞进 RPC 参数）——报出方法名便于定位
    throw new Error('rpc ' + String(method) + ' 参数不可克隆: ' + (e && e.message ? e.message : String(e)));
  }
  const i32 = new Int32Array(SAB, 0, SAB_HEAD_I32);
  Atomics.wait(i32, 1, 0); // 同步等宿主回填（worker 线程允许 wait；硬超时由宿主 terminate 兜底）
  if (Atomics.load(i32, 1) === 2) return rpcReadChunked(i32);
  const len = Atomics.load(i32, 2);
  Atomics.store(i32, 1, 0); // 复位，供下一次调用
  const obj = JSON.parse(new TextDecoder().decode(new Uint8Array(SAB, SAB_DATA_OFF_BYTES, len)));
  /* #745 写 op 成功后整体作废读缓存（失败不动：树没被改） */
  if (obj.ok && method === 'dom' && args && __YUEDU_DOM_MUT_OPS[args.op]) __yueduDomEpoch++;
  if (obj.ok) return obj.value;
  throw new Error(obj.error || 'rpc failed');
}

/**
 * #537 ② 二进制版同步 RPC：宿主可回 **status=3 原始字节**（免 base64/JSON 化）。
 * 其余状态与 rpc 逐字同语义（1=单片 JSON / 2=分片 JSON）⇒ 老调用方行为不变。
 * ⚠️ status=3 的数据区必须**复制**出来：SAB 会被下一次 RPC 覆盖。
 */
function rpcBinary(method, args) {
  // #537 ②：compress 之前只落地目标位图上的排队写入（其余保持排队）
  flushBitmapOps(bitmapFlushIds(args));
  const callId = ++rpcSeq;
  try {
    parentPort.postMessage({ kind: 'rpc', callId, method, args, job: CUR_JOB, at: Date.now() });
  } catch (e) {
    throw new Error('rpc ' + String(method) + ' 参数不可克隆: ' + (e && e.message ? e.message : String(e)));
  }
  const i32 = new Int32Array(SAB, 0, SAB_HEAD_I32);
  Atomics.wait(i32, 1, 0);
  const status = Atomics.load(i32, 1);
  if (status === 3) {
    const len = Atomics.load(i32, 2);
    const bytes = new Uint8Array(len);
    bytes.set(new Uint8Array(SAB, SAB_DATA_OFF_BYTES, len)); // 复制：SAB 下一拍就被覆盖
    Atomics.store(i32, 1, 0);
    return bytes;
  }
  if (status === 2) return rpcReadChunked(i32);
  const len = Atomics.load(i32, 2);
  Atomics.store(i32, 1, 0);
  const obj = JSON.parse(new TextDecoder().decode(new Uint8Array(SAB, SAB_DATA_OFF_BYTES, len)));
  if (obj.ok) return obj.value;
  throw new Error(obj.error || 'rpc failed');
}

/**
 * 分片模式的读取循环（宿主已置 status=2）。
 *
 * 握手顺序：宿主写片 + notify i32[1] → 本函数读片 → 还有下一片就置 i32[3]=1 + notify i32[3]
 * → (宿主 waitAsync 醒来写下一片) → 本函数再 wait i32[1]。
 */
function rpcReadChunked(i32) {
  var total = Atomics.load(i32, 5);
  if (!(total > 0)) throw new Error('rpc 分片协议异常: total=' + String(total));
  var parts = [];
  for (var i = 0; ; i++) {
    var len = Atomics.load(i32, 2);
    // ⚠️ 必须 slice 复制：SAB 是同一块内存，下一片会把它覆盖掉
    parts.push(Buffer.from(new Uint8Array(SAB, SAB_DATA_OFF_BYTES, len)));
    if (i + 1 >= total) break;
    Atomics.store(i32, 3, 1);
    Atomics.notify(i32, 3);
    Atomics.store(i32, 1, 0);
    Atomics.wait(i32, 1, 0); // 宿主可能已写好（值≠0 → 立即返回）
  }
  Atomics.store(i32, 1, 0);
  Atomics.store(i32, 3, 0);
  var obj = JSON.parse(Buffer.concat(parts).toString('utf-8'));
  if (obj.ok) return obj.value;
  throw new Error(obj.error || 'rpc failed');
}

/**
 * 不等待回包的 RPC（fire-and-forget）：只把请求发给宿主，立刻返回。
 *
 * 为什么需要它：Legado 的 java.startBrowser 是 startActivity 语义（发射即返回，见
 * SourceVerificationHelp.kt:348-373）。若用上面的同步 rpc 去等一次渲染，worker 会
 * 一直阻塞到渲染完成，把宿主 10s 的 JS 预算吃光，最后报 JS_TIMEOUT
 * （实测：麻豆传媒AI 正文规则 java.startBrowser(url,'') ）。
 * 失败不抛（fire-and-forget 语义：打开浏览器失败不该打挂整条规则）。
 */
function rpcNoWait(method, args) {
  try {
    parentPort.postMessage({ kind: 'rpc', noReply: true, method, args, job: CUR_JOB });
  } catch (e) {
    /* 参数不可克隆 / 通道关闭 —— 忽略 */
  }
}

/**
 * #537 ② 免回复位图 op 的**同帧合并队列**：一次求值里 N 次 draw/fill/release 只发 1 条消息。
 *
 * 为什么安全：这些 op 无返回值，脚本人眼可见的效果只取决于后续同步 op（compress）能否看见
 * 它们；flush 在每次同步 rpc/rpcBinary 之前执行，且 postMessage 同端口保序，所以语义不变。
 * 为什么值得做：跨线程消息固定开销与 op 数成正比（禁漫天堂一页 2~20 条切条绘制）。
 * 回退：YUEDU_BITMAP_BATCH=0 恢复「每条一个 postMessage」的旧行为（排障/A-B 用）。
 * 注意：本函数体位于模板串内 —— 注释里不能出现反引号与美元花括号。
 */
var BITMAP_BATCH_ON = !(typeof process !== 'undefined' && String(process.env.YUEDU_BITMAP_BATCH) === '0');
var __bitmapOps = [];
function bitmapOpTarget(p) {
  if (!p) return -1;
  return p.dst != null ? p.dst : (p.id != null ? p.id : -1);
}
/**
 * 落地队列：ids 为空/未传 ⇒ 全量；否则只落地**目标句柄命中**的 op（其余继续排队）。
 * 依赖判定是「同句柄」：禁漫天堂一页是 decode → (crop 同步 + draw 排队) x N → compress(dst)，
 * crop 读的是原图、draw 写的是 dst ⇒ 不在 crop 处冲洗，20 条 draw 才能合并成 1 条 compress 前的 RPC。
 */
function flushBitmapOps(ids) {
  if (__bitmapOps.length === 0) return;
  var pick;
  if (ids == null) {
    pick = __bitmapOps;
    __bitmapOps = [];
  } else {
    var rest = [];
    pick = [];
    for (var i = 0; i < __bitmapOps.length; i++) {
      var t = bitmapOpTarget(__bitmapOps[i]);
      if (ids.indexOf(t) >= 0) pick.push(__bitmapOps[i]);
      else rest.push(__bitmapOps[i]);
    }
    if (pick.length === 0) return;
    __bitmapOps = rest;
  }
  try {
    parentPort.postMessage({ kind: 'rpc', noReply: true, method: 'bitmap', args: { op: 'batch', ops: pick }, job: CUR_JOB });
  } catch (e) {
    /* 通道关闭 —— 忽略（语义同 rpcNoWait） */
  }
}
/** 同步位图 op 引用的句柄（src 读 / dst 写 / id 单目标）——只有命中才需要先冲洗 */
function bitmapFlushIds(args) {
  var ids = [];
  if (args) {
    if (args.src != null) ids.push(args.src);
    if (args.dst != null) ids.push(args.dst);
    if (args.id != null) ids.push(args.id);
  }
  return ids;
}
function bitmapNoWait(payload) {
  if (!BITMAP_BATCH_ON) { rpcNoWait('bitmap', payload); return; }
  __bitmapOps.push(payload);
  if (__bitmapOps.length >= 64) flushBitmapOps(); // 极端脚本防无界增长
}

/**
 * org.jsoup 仿真（worker 版）。
 *
 * Legado 源高频写法：org.jsoup.Jsoup.parse(java.ajax(url)).select(sel)...
 * DOM 后端（jsdom）只在宿主可用 → select 经 RPC 回宿主求值（jsoupSelect），
 * 而它的产出本就是可序列化 POJO，回传零损失，与 L1 是**同一份实现**（语义一致）。
 * 这样「用 jsoup 又发 java.ajax」的脚本就能进 worker：java.ajax 走异步 RPC，
 * 不再用 execFileSync 阻塞宿主事件循环（Phase 0.1 的核心）。
 *
 * #333 重写：旧模型是「字符串快照 + 选择器/索引回写」，跨不过删除后的身份变化
 * （次元小镇：doc.selectFirst / el.ownText / img.attr(k,v) 设值 / 改完 content.html() 全线失效）。
 * 现在节点身份 = nid，宿主那一份 JsoupDom 持有**活节点**，worker 只拿 nid 经 RPC 读写删，
 * 与 L1 是同一份实现（详见 selector/jsoup-dom.ts 头注）。
 *
 * 兼容：规则桥（java.getElements）产出的描述符**没有 nid** ⇒ 退化成旧的按 html 文本 select。
 *
 * 注意：本函数体整段位于 String.raw 模板内 ——
 *   ① 注释里**不能出现反引号**（会截断模板）；
 *   ② 需要换行符请用 String.fromCharCode(10)，不要写转义（String.raw 不解释转义）。
 */
function __yueduJsoup() {
  function mkList(list) {
    var arr = list.map(function (e) {
      // nid == null：无身份的旧描述符（规则桥产物）⇒ 走快照分支，行为与 #108 时一致
      var nid = e && e.nid != null ? e.nid : null;
      function call(op, extra) {
        var a = { op: op, nid: nid };
        if (extra) { for (var k in extra) { a[k] = extra[k]; } }
        return rpc('dom', a);
      }
      function pick(s) {
        return nid == null
          ? rpc('dom', { op: 'select', html: e.outerHTML, sel: String(s) })
          : call('select', { sel: String(s) });
      }
      /**
       * #745 **读穿透缓存**：select/clone/child 回来的描述符里本就带了
       * text / innerHTML / outerHTML / attrs（都是建表那一刻的**活值**）。
       * 旧实现每个读都要打一次跨线程 RPC —— 1500 章 × 2 次读 = 3000 次往返，
       * 实测比 jsdom 解析本身还贵（这就是 worker 模式 8.73s vs 宿主 5.49s 的差额）。
       *
       * 只要这棵树上**没发生过写操作**（世代一致），快照就是活值 ⇒ 直接返回，零往返；
       * 写 op 后世代自增（见顶层 __yueduDomEpoch），所有旧快照自动作废、退回 RPC。
       * 判据只此一处，text() / outerHtml() / html() / attr() 四读共用。
       */
      var snap = __yueduDomEpoch;
      function fresh() { return __yueduDomEpoch === snap; }
      function textNow() {
        if (nid == null) return e.text;
        if (fresh() && typeof e.text === 'string') return e.text;
        return call('text');
      }
      function htmlNow(kind) {
        if (nid == null) return kind === 'inner' ? e.innerHTML : e.outerHTML;
        if (fresh()) {
          var v = kind === 'inner' ? e.innerHTML : e.outerHTML;
          if (typeof v === 'string') return v;
        }
        return call('html', { kind: kind });
      }
      function attrNow(n) {
        var k = String(n);
        if (nid == null) return e.attrs[k] === undefined ? '' : e.attrs[k];
        // abs: 前缀要走文档基址（快照里没有）⇒ 必须回宿主，与 JsoupDom.attr 同一判据
        if (/^abs:/i.test(k)) return call('attr', { name: k });
        if (fresh() && e.attrs) return e.attrs[k] === undefined ? '' : e.attrs[k];
        return call('attr', { name: k });
      }
      var el = {
        /* 快照字段：仍是建表时刻的值（活值请用 outerHtml()/html()/text()/attr()） */
        outerHTML: e.outerHTML,
        innerHTML: e.innerHTML,
        attrs: e.attrs,
        toString: function () { return htmlNow('outer'); },
        html: function () { return htmlNow('inner'); },
        outerHtml: function () { return htmlNow('outer'); },
        /* #528 jsoup Element.text() 两形态：无参读 / 有参 text(String) 写（返回自身便于链式） */
        text: function (v) {
          if (v === undefined) return textNow();
          if (nid != null) call('setText', { text: String(v) });
          return el;
        },
        ownText: function () { return nid == null ? e.text : call('ownText'); },
        tagName: function () { return String(e.attrs && e.attrs.tagName ? e.attrs.tagName : ''); },
        data: function (k) { return e.attrs['data-' + String(k)] === undefined ? '' : e.attrs['data-' + String(k)]; },
        hasClass: function (c) { return (' ' + (e.attrs['class'] || '') + ' ').indexOf(' ' + String(c) + ' ') >= 0; },
        isEmpty: function () { return nid == null ? false : String(htmlNow('inner')).replace(/\s/g, '').length === 0; },
        attr: function (n, v) {
          if (v === undefined) return attrNow(n);
          if (nid != null) call('setAttr', { name: String(n), value: String(v) });
          return el;
        },
        /* #528 jsoup Element.clone()：深拷贝 → 独立元素（宿主回描述符，这里再包成可链式元素） */
        clone: function () {
          if (nid == null) return mkList([{ nid: null, outerHTML: e.outerHTML, innerHTML: e.innerHTML, text: e.text, attrs: e.attrs }])[0];
          var d = rpc('dom', { op: 'clone', nid: nid });
          return d ? mkList([d])[0] : null;
        },
        /* #528 jsoup Element.child(index)：第 index 个子元素（越界 null） */
        child: function (i) {
          if (nid == null) return null;
          var d = rpc('dom', { op: 'child', nid: nid, idx: Number(i) });
          return d ? mkList([d])[0] : null;
        },
        select: function (s) { return mkList(pick(s) || []); },
        selectFirst: function (s) { var r = pick(s) || []; return r.length ? mkList(r)[0] : null; },
        getAllElements: function () { return mkList(nid == null ? [] : call('selectAll') || []); },
        remove: function () { if (nid != null) call('remove', { nids: [nid] }); return el; },
        /* #640 jsoup Element.appendChild(child)：把 child 移到本元素末尾（与 L1 makeJsoupElement 同语义） */
        appendChild: function (c) {
          var cid = c && c.__nid;
          if (cid != null && nid != null) call('append', { child: cid });
          return el;
        },
      };
      /* #528 内部身份：Elements.add(el) / 列表级 select() 要按 nid 继续查，故留非枚举引用 */
      try {
        Object.defineProperty(el, '__nid', { value: nid });
        Object.defineProperty(el, '__desc', { value: e });
        /* #745 列表级批量读要判断「这个元素的快照还新不新」 */
        Object.defineProperty(el, '__freshDom', { value: fresh });
      } catch (_e) { /* 极老引擎无 defineProperty：退化为不参与 add（不影响原有方法） */ }
      return el;
    });
    function def(k, fn) { Object.defineProperty(arr, k, { value: fn }); }
    function nids() { var out = []; for (var i = 0; i < list.length; i++) { if (list[i].nid != null) out.push(list[i].nid); } return out; }
    def('size', function () { return list.length; });
    def('get', function (i) { return arr[Number(i)]; });
    def('eq', function (i) { return arr[Number(i)]; });
    def('first', function () { return arr[0]; });
    def('last', function () { return arr[list.length - 1]; });
    /**
     * #745 列表级文本：快照新就零往返；有写操作后**一次 textAll 批量取**，
     * 避免 1500 个元素各打一次 RPC（旧实现 list.map(x => x.text) 还是死快照，删改后不刷新）。
     */
    function eachTextNow() {
      var staleIds = [], stalePos = [];
      for (var i = 0; i < arr.length; i++) {
        var id = arr[i].__nid;
        if (typeof id === 'number' && arr[i].__freshDom && !arr[i].__freshDom()) { staleIds.push(id); stalePos.push(i); }
      }
      var live = null;
      if (staleIds.length > 1) {
        try { live = rpc('dom', { op: 'textAll', nids: staleIds }); } catch (e) { live = null; }
      }
      var liveMap = {};
      if (live && live.length === staleIds.length) {
        for (var j = 0; j < staleIds.length; j++) liveMap[stalePos[j]] = live[j];
      }
      var out = [];
      for (var k = 0; k < arr.length; k++) out.push(liveMap[k] != null ? liveMap[k] : arr[k].text());
      return out;
    }
    def('eachText', function () { return eachTextNow(); });
    def('text', function () { return eachTextNow().join(String.fromCharCode(10)); });
    def('attr', function (n, v) {
      if (!list.length) return '';
      if (v === undefined) return arr[0].attr(n); // 读：元素级缓存（写后自动退回 RPC）
      /* #745 写：一次 setAttrAll 写完 N 个元素 */
      var ids = nids();
      if (ids.length) rpc('dom', { op: 'setAttrAll', nids: ids, name: String(n), value: String(v) });
      return arr;
    });
    def('hasClass', function (c) { return list.length ? (' ' + (list[0].attrs['class'] || '') + ' ').indexOf(' ' + String(c) + ' ') >= 0 : false; });
    def('toArray', function () { return arr.slice(); });
    def('isEmpty', function () { return list.length === 0; });
    /**
     * #644 **Elements.clone()**：jsoup 的 Elements 是 ArrayList 的子类并**重写了 clone**
 * —— 深拷贝出一批独立元素（源脚本靠它做「在副本上净化」：先克隆，再在克隆上 remove，
     * 最后读副本的 outerHtml）。
     *
     * ⚠️ 若这里返回**同一批 nid**，随后的 .remove() 会删掉**原始 DOM**上的节点
     * ⇒ 与上游语义正好相反（源会拿到被删空的正文）。
     * 故逐个走宿主 dom.clone（拿**新 nid 的描述符**）再包一层 ⇒ 与原树彻底脱钩。
     */
    def('clone', function () {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var nid0 = list[i].nid;
        if (nid0 == null) {
          out.push({ nid: null, outerHTML: list[i].outerHTML, innerHTML: list[i].innerHTML, text: list[i].text, attrs: list[i].attrs });
        } else {
          var d = rpc('dom', { op: 'clone', nid: nid0 });
          if (d) out.push(d);
        }
      }
      return mkList(out);
    });
    def('html', function () { return list.length ? arr[0].html() : ''; });
    /**
     * #646 jsoup Elements.outerHtml()：**遍历全部元素依次拼接**（上游无分隔符），
     * 且必须**实时序列化** —— 不能读描述符快照。
     *
     * 两层真因（搬山人小说网实测，同一条规则里叠在一起）：
     *  ① 旧实现只返回 list[0].outerHTML ⇒ 整章截成 1 段（规则内部 135 段，输出 1 段 / 51 字）；
     *  ② 快照不刷新：源规则 clean = paragraphs.clone() → clean.select('span[class*=count_]').remove()
     *     删的是**宿主活节点**，而描述符里的 outerHTML 是生成时的字符串 ⇒ 删不掉
     *     ⇒ 每段末尾残留 <span class="z count_N">0</span> ⇒ 阅读区每段后多一行 0
     *     （实测 270 段 = 135 段正文 + 135 个 0）。
     * 单元素路径一直走 call('html',{kind:'outer'})（实时），列表路径没跟上，这就是漂移。
     *
     * 性能：**一次 htmlAll 批量取**，不要 135 次 rpc 往返（每往返都计入这次本就 9s 的请求）。
     * 拿不到（旧宿主/无 nid）就退回快照，行为不变。
     * 本段在模板串内：禁反引号与美元花括号。
     */
    def('outerHtml', function () { return joinOuterHtml(); });
    def('toString', function () { return joinOuterHtml(); });
    function joinOuterHtml() {
      var ids = [], idx = [];
      var allFresh = true;
      for (var i = 0; i < list.length; i++) {
        if (list[i].nid != null) {
          ids.push(list[i].nid); idx.push(i);
          if (arr[i].__freshDom && !arr[i].__freshDom()) allFresh = false;
        }
      }
      /**
       * #745 快路径：没发生过写操作 ⇒ 快照就是活值，直接拼，零往返。
       * 写操作后仍走一次 htmlAll 批量取（不能逐元素 RPC）。
       */
      if (ids.length && allFresh) {
        var fast = '';
        for (var f = 0; f < list.length; f++) if (list[f].outerHTML != null) fast += String(list[f].outerHTML);
        return fast;
      }
      var live = null;
      if (ids.length) {
        try { live = rpc('dom', { op: 'htmlAll', nids: ids }); } catch (e) { live = null; }
        if (__yueduEnvFlag('YUEDU_DEBUG_JSLIB', '1')) {
          console.log('[dom:w] joinOuterHtml 元素=' + list.length + ' 带nid=' + ids.length +
            ' live=' + (live ? live.length : 'null') +
            ' 首段含span=' + (live && live[0] ? String(live[0]).indexOf('count_') >= 0 : 'n/a'));
        }
      }
      var liveMap = {};
      if (live && live.length === ids.length) {
        for (var j = 0; j < ids.length; j++) liveMap[idx[j]] = live[j];
      }
      var out = '';
      for (var k = 0; k < list.length; k++) {
        var h = liveMap[k] != null ? liveMap[k] : list[k].outerHTML;
        if (h != null) out += String(h);
      }
      return out;
    }
    def('select', function (s) {
      var out = [];
      var __dbgSel = __yueduEnvFlag('YUEDU_DEBUG_JSLIB', '1');
      if (__dbgSel) console.log('[dom:w] list.select "' + String(s).slice(0, 48) + '" 输入元素=' + list.length + ' 带nid=' + list.filter(function (x) { return x.nid != null; }).length);
      var ids = nids();
      if (ids.length === list.length && ids.length > 1) {
        /* #745 全带 nid 的列表：一次 selectList 批量取（N 次往返 → 1 次） */
        out = rpc('dom', { op: 'selectList', nids: ids, sel: String(s) }) || [];
      } else {
        for (var i = 0; i < list.length; i++) {
          var r = (list[i].nid == null
            ? rpc('dom', { op: 'select', html: list[i].outerHTML, sel: String(s) })
            : rpc('dom', { op: 'select', nid: list[i].nid, sel: String(s) })) || [];
          for (var j = 0; j < r.length; j++) out.push(r[j]);
        }
      }
      if (__dbgSel) console.log('[dom:w] list.select 命中=' + out.length + ' 其中带nid=' + out.filter(function (x) { return x.nid != null; }).length);
      return mkList(out);
    });
    // jsoup Elements.remove()：按身份删全部（宿主活节点，删完 doc.html() 立刻可见）
    def('remove', function () {
      var ids = nids();
      if (__yueduEnvFlag('YUEDU_DEBUG_JSLIB', '1')) console.log('[dom:w] list.remove 列表=' + list.length + ' 可删nid=' + ids.length);
      if (ids.length) rpc('dom', { op: 'remove', nids: ids });
      return arr;
    });
    /* #528 jsoup Elements.add(Element)：new Elements() 后逐条追加（返回 true）。
       必须同时维护 arr（索引/长度）与 list（text/attr/select 等列表级方法的数据源）。 */
    def('add', function (x) {
      var d = x && x.__desc;
      if (d) list.push(d);
      arr.push(x);
      return true;
    });
    return arr;
  }
  return {
    /**
     * 元素列表构造器（**对外暴露**，供 'java.getElements/getElement' 的规则桥复用）。
     *
     * 为什么必须共用同一份：它决定了「元素上挂哪些方法」（'select/attr/text/size/toArray/…'）。
     * 若规则桥自己再写一套，两处会慢慢漂移 —— 而漂移的表现是「某个源在 worker 里少一个方法」
     * 这类极难定位的静默失败（'NOT_A_FUNCTION' 只在日志里一闪而过）。
     */
    list: mkList,
    parse: parseDoc,
    /* #528 Jsoup.parseBodyFragment(html)：与 parse 同一形态（jsoup 里按 body 片段解析；jsdom 会把
       片段补成完整文档，'.body().child(0)' 取到的正是片段首个元素，与上游一致）。 */
    parseBodyFragment: parseDoc,
    /* #529 Jsoup.connect(url)：HTTP 客户端构建器（传输复用本文件的同步 httpRpc，与 java.ajax 同一条出口） */
    connect: makeWorkerJsoupConnection,
    /* #640 new org.jsoup.nodes.Element(tag)：宿主造游离元素，这里再包成可链式元素 */
    element: function (tag) {
      var nid2 = rpc('dom', { op: 'create', tag: String(tag == null ? 'div' : tag) });
      var d = nid2 == null ? null : rpc('dom', { op: 'desc', nid: nid2 });
      return d ? mkList([d])[0] : null;
    },
  };
  function parseDoc(html, baseUri) {
    /* #563 baseUri（Jsoup.parse 第二参）必须回传宿主：abs:href 的绝对化基址 */
    var nid = rpc('dom', { op: 'parse', html: String(html == null ? '' : html), baseUri: typeof baseUri === 'string' && baseUri.trim() ? baseUri.trim() : undefined });
    var doc = {
      select: function (sel) { return mkList(rpc('dom', { op: 'select', nid: nid, sel: String(sel) }) || []); },
      selectFirst: function (sel) {
        var r = rpc('dom', { op: 'select', nid: nid, sel: String(sel) }) || [];
        return r.length ? mkList(r)[0] : null;
      },
      getAllElements: function () { return mkList(rpc('dom', { op: 'selectAll', nid: nid }) || []); },
      body: function () {
        var r = rpc('dom', { op: 'select', nid: nid, sel: 'body' }) || [];
        return r.length ? mkList(r)[0] : null;
      },
      head: function () {
        var r = rpc('dom', { op: 'select', nid: nid, sel: 'head' }) || [];
        return r.length ? mkList(r)[0] : null;
      },
      title: function () {
        var r = rpc('dom', { op: 'select', nid: nid, sel: 'title' }) || [];
        return r.length ? r[0].text : '';
      },
      attr: function (n, v) {
        if (v === undefined) return rpc('dom', { op: 'attr', nid: nid, name: String(n) });
        rpc('dom', { op: 'setAttr', nid: nid, name: String(n), value: String(v) });
        return doc;
      },
      /* #528 Document.child(index)（Document extends Element）—— 找书啦 ruleToc 用它取片段首元素 */
      child: function (i) {
        var d = rpc('dom', { op: 'child', nid: nid, idx: Number(i) });
        return d ? mkList([d])[0] : null;
      },
      toString: function () { return rpc('dom', { op: 'html', nid: nid, kind: 'outer' }); },
      html: function () { return rpc('dom', { op: 'html', nid: nid, kind: 'outer' }); },
      /* #528 Document.text() 两形态（读 / 写） */
      text: function (v) {
        if (v === undefined) return rpc('dom', { op: 'text', nid: nid });
        rpc('dom', { op: 'setText', nid: nid, text: String(v) });
        return doc;
      },
    };
    Object.defineProperty(doc, 'size', { value: function () { return 1; } });
    return doc;
  }
}

/**
 * #523 **worker 侧 document** —— 只读的 DOM facade（活节点在宿主，方法经 rpc('dom')）。
 *
 * ## 为什么需要
 * 宿主（L1）的 document 是当前内容**真实的 jsdom Document**（挂账 #92）：腾讯漫画正文页会
 * 把浏览器探针 eval("!!document.getElementsByTagName('html')") 算进 nonce —— 没有 document
 * 就 ReferenceError ⇒ 整条正文规则崩（「非确定性失败」的真因）。worker 里既无 DOM 也无 jsdom，
 * 此前由 js.ts 的 HOST_DOCUMENT_RE（**文本暴匹配**）把这类源一律强留 L1 —— 代价是它们的
 * java.ajax 继续在主线程 execFileSync 同步阻塞（#497 实证的 stall 家族）。
 *
 * ## 面（与宿主的 jsdom 语义对齐的**只读**子集）
 *   · document：documentElement · body · head · title · getElementsByTagName ·
 *     getElementById · querySelector · querySelectorAll
 *   · element：nodeType · nodeName · tagName · id · className · outerHTML ·
 *     innerHTML · textContent · getAttribute · hasAttribute · querySelector ·
 *     querySelectorAll · getElementsByTagName
 *   · 集合：**真数组** + length + item(i)（对齐 HTMLCollection 的两条常用读法）
 *
 * ⚠️ **白名单纪律**：只实现上面这些。其余成员（createElement / addEventListener / execCommand /
 * fonts / visibilityState / select 等）**刻意不实现** ⇒ 由 js.ts 的路由守卫继续留 L1
 * （宁留也不静默半残）。宿主侧守卫与这里必须**同一张名单**（同一判据只留一处：守卫读
 * DOCUMENT_WORKER_MEMBERS，注释见 js.ts）。
 *
 * ⚠️ getElementsByTagName 必须**含根自身**：宿主 JsoupDom.parse 的根就是 documentElement
 * （html），而 dom.select 是 jsoup 语义（**不含自身**）⇒ 不补根会让
 * getElementsByTagName('html') 恒空 ⇒ 探针取到 false（与浏览器/L1 不一致 ⇒ nonce 错）。
 *
 * ⚠️ 本段位于 String.raw 模板内：注释与代码里都不得出现反引号与美元花括号。
 */
function __yueduDomElement(desc) {
  var nid = desc && desc.nid != null ? desc.nid : null;
  var html = String(desc && desc.outerHTML != null ? desc.outerHTML : '');
  var m = /^<\s*([A-Za-z][\w-]*)/.exec(html);
  var tag = m ? m[1].toUpperCase() : '';
  var el = {
    nodeType: 1,
    nodeName: tag,
    tagName: tag,
    id: String((desc && desc.attrs && desc.attrs.id) || ''),
    className: String((desc && desc.attrs && desc.attrs.class) || ''),
    /* 三个随 DOM 变更的读法走**实时** RPC（对齐 L1：jsdom 活节点） */
    get outerHTML() { return nid == null ? html : String(rpc('dom', { op: 'html', nid: nid, kind: 'outer' })); },
    get innerHTML() { return nid == null ? String((desc && desc.innerHTML) || '') : String(rpc('dom', { op: 'html', nid: nid, kind: 'inner' })); },
    get textContent() { return nid == null ? String((desc && desc.text) || '') : String(rpc('dom', { op: 'text', nid: nid })); },
    getAttribute: function (n) {
      var k = String(n);
      if (nid != null) return String(rpc('dom', { op: 'attr', nid: nid, name: k }) || '');
      return desc && desc.attrs && desc.attrs[k] != null ? String(desc.attrs[k]) : '';
    },
    hasAttribute: function (n) { return el.getAttribute(n) !== ''; },
    querySelector: function (s) { var r = __yueduDomPick(nid, s); return r.length ? __yueduDomElement(r[0]) : null; },
    querySelectorAll: function (s) { return __yueduDomCollection(__yueduDomPick(nid, s)); },
    /**
     * #644 **含根自身**（浏览器语义：document.getElementsByTagName('html') 命中 1 个）。
     *
     * ⚠️ 旧实现在这里手工补 desc（因为那时 dom.select = querySelectorAll，不含根）；
     *    现在 selectJsoup 已经把根算进去了 ⇒ **这段补偿必须删掉**，否则变成 2 个。
     */
    getElementsByTagName: function (t) {
      return __yueduDomCollection(__yueduDomPick(nid, t));
    },
  };
  return el;
}

/** nid 下的**后代**元素描述符（jsoup select 语义：不含自身） */
function __yueduDomPick(nid, sel) {
  if (nid == null) return [];
  return rpc('dom', { op: 'select', nid: nid, sel: String(sel) }) || [];
}

/** 描述符数组 → 集合（真数组 + item(i)；对齐 HTMLCollection 的常用读法） */
function __yueduDomCollection(descs) {
  var arr = [];
  for (var i = 0; i < descs.length; i++) arr.push(__yueduDomElement(descs[i]));
  arr.item = function (i) { return arr[Number(i)] || null; };
  return arr;
}

/**
 * #523 造 document（惰性：只有脚本真读 document 时才调用一次；调用点见 runEval 的 getter）。
 * 以**内容 HTML** 为准（与 L1 的 AnalyzeRule.documentOf(running) 同源 —— 那边解析的就是 running）。
 */
function __yueduDocument(rootNid, rootDesc) {
  function pick(sel) { return rpc('dom', { op: 'select', nid: rootNid, sel: String(sel) }) || []; }
  var doc = {
    nodeType: 9,
    nodeName: '#document',
    get documentElement() { return rootDesc ? __yueduDomElement(rootDesc) : null; },
    get body() { var r = pick('body'); return r.length ? __yueduDomElement(r[0]) : null; },
    get head() { var r = pick('head'); return r.length ? __yueduDomElement(r[0]) : null; },
    get title() { var r = pick('title'); return r.length ? String(r[0].text || '') : ''; },
    /**
     * #644 **含根自身**（浏览器语义：document.getElementsByTagName('html') 命中 1 个）。
     *
     * ⚠️ 旧实现在这里手工补 rootDesc（那时 dom.select = querySelectorAll，不含根）；
     *    现在 selectJsoup 已把根算进去 ⇒ **补偿删掉**，否则同一个 html 会被数两次。
     */
    getElementsByTagName: function (t) {
      return __yueduDomCollection(pick(String(t)));
    },
    getElementById: function (id) { var r = pick('#' + String(id)); return r.length ? __yueduDomElement(r[0]) : null; },
    querySelector: function (s) { var r = pick(s); return r.length ? __yueduDomElement(r[0]) : null; },
    querySelectorAll: function (s) { return __yueduDomCollection(pick(s)); },
  };
  return doc;
}

/**
 * 把宿主传来的「可序列化描述符」重建成「活对象」（RPC 支撑）。
 *
 * 为什么需要：java.ajax 在 L1 走 execFileSync（同步阻塞 Node 事件循环）→ 并发一高就雪崩。
 * 把含 HTTP 的脚本送进 worker 能解决（本 worker 的 Atomics.wait 只阻塞 worker 线程），
 * 但 worker 的 bindings 必须可结构化克隆，而 source（Proxy + 方法）与 infoMap（Proxy over Map）
 * 都不可克隆。于是约定：宿主传 __yueduSourceFields（纯字段）/ __yueduInfoMapEntries（纯键值），
 * 由本函数在 worker 内重建出「方法齐全、读写经 RPC 回流宿主」的等价对象。
 * 这样脚本看到的 source.setVariable(...) 语义不变，而状态仍落在宿主（引擎）那一份。
 *
 * 注意：本函数体整段位于模板字符串内 —— 注释里**不能出现反引号**（会截断模板）。
 */
/**
 * 规则对象在宿主侧是 Kotlin data class 的 toString 复刻（见 core/source-stub.ts）；
 * 方法属性过不了 structuredClone，这里按同一“属性名紧贴值”形态重建。
 * qyyuapi 系 user_Check 用 String(source.ruleSearch) 算 MD5，缺了它恒为 [object Object]。
 * 注意：本函数体整段位于模板字符串内 —— 注释里不能出现反引号。
 */
function __yueduRuleBean(o, cls) {
  try {
    Object.defineProperty(o, 'toString', {
      value: function () {
        var ks = Object.keys(o), ps = [], i;
        for (i = 0; i < ks.length; i++) ps.push(ks[i] + '=' + (o[ks[i]] == null ? 'null' : String(o[ks[i]])));
        return cls + '(' + ps.join(', ') + ')';
      },
      enumerable: false, configurable: true, writable: true,
    });
  } catch (e) {}
  return o;
}

function __yueduPrepareBindings(b) {
  const out = Object.assign({}, b || {});
  // #759 图片解密：宿主下发的是裸字节（见 core/selector/image-bytes.ts 的 IMAGE_BYTES_KEY）。
  // 结构化克隆会丢挂载方法 ⇒ 这里用与宿主同一份源码重建 result 的 InputStream 方法面。
  if (out.__yueduImageBytes) { out.result = __yueduImageStream(out.__yueduImageBytes); delete out.__yueduImageBytes; }
  // book / chapter / rssArticle：宿主侧是 entityStub（函数型 Proxy + 未知字段下钻桩）。
  // 这里用「字段快照 + 下钻桩」等价重建，让含 java.ajax 的字段级规则也能进 worker。
  // （只读语义；脚本若**写**这些实体，宿主不会给快照、会留在 L1 —— 见 createHybridJsEvaluator）
  function __yueduEntityLike(fields) {
    var data = Object.assign({}, fields || {});
    function nest() {
      var f = function () { return ''; };
      return new Proxy(f, {
        get: function (t, p) {
          if (typeof p === 'symbol' || p === 'then') return undefined;
          if (p === 'toString' || p === 'valueOf') return function () { return ''; };
          return nest();
        },
        apply: function () { return ''; },
      });
    }
    var top = nest();
    return new Proxy(top, {
      get: function (t, p) {
        if (typeof p !== 'symbol' && Object.prototype.hasOwnProperty.call(data, p)) return data[p];
        return t[p];
      },
      set: function (t, p, v) { if (typeof p !== 'symbol') data[p] = v; return true; },
      has: function (t, p) { return typeof p === 'string' && Object.prototype.hasOwnProperty.call(data, p) ? true : (p in t); },
    });
  }
  if (out.__yueduBookFields) { out.book = __yueduEntityLike(out.__yueduBookFields); delete out.__yueduBookFields; }
  if (out.__yueduChapterFields) { out.chapter = __yueduEntityLike(out.__yueduChapterFields); delete out.__yueduChapterFields; }
  if (out.__yueduRssFields) { out.rssArticle = __yueduEntityLike(out.__yueduRssFields); delete out.__yueduRssFields; }
  if (out.__yueduSourceFields) {
    const fields = out.__yueduSourceFields || {};
    delete out.__yueduSourceFields;
    const call = (m, args) => rpc('sourceCall', { m: m, args: args || [] });
    out.source = Object.assign({}, fields, {
      getKey: () => call('getKey'),
      /**
       * #682 JavaBean getter：宿主源桩已经补上（BookSource 是 Kotlin data class，
       * JVM 自动生成 getXxx），worker 这里要同步给出，否则同一段脚本在 L1 与 worker 下
       * 行为不同 —— 黄果短剧的 source.getBookSourceUrl() 在 worker 里拿到空串，
       * 详情/选集 URL 就回落到当前页 baseUrl（404 页「页面不存在或已下架」）。
       * 注释里不要出现反引号（本函数体在模板串内）。
       */
      getBookSourceUrl: () => call('getBookSourceUrl'),
      getBookSourceName: () => call('getBookSourceName'),
      getBookSourceGroup: () => call('getBookSourceGroup'),
      getBookSourceType: () => call('getBookSourceType'),
      getBookSourceComment: () => call('getBookSourceComment'),
      getLoginUrl: () => call('getLoginUrl'),
      getHeader: () => call('getHeader'),
      getJsLib: () => call('getJsLib'),
      get: (k) => call('get', [String(k)]),
      put: (k, v) => call('put', [String(k), v]),
      getVariable: () => call('getVariable'),
      setVariable: (v) => call('setVariable', [v]),
      getComment: () => call('getComment'),
      hasLogin: () => call('hasLogin'),
      getLoginInfo: () => call('getLoginInfo'),
      putLoginInfo: (v) => call('putLoginInfo', [v]),
      removeLoginInfo: () => call('removeLoginInfo'),
      getLoginHeader: () => call('getLoginHeader'),
      putLoginHeader: (v) => call('putLoginHeader', [v]),
      removeLoginHeader: () => call('removeLoginHeader'),
      // Legado 返回 Java Map：方括号与 .get("账号") 都要能用（上游 Rhino 为 java.util.Map 做了桥接）。
      // 复用与 JSON 绑定同一份注入源码 __yueduAttachJsonMap —— 它挂的方法是**非枚举**的，
      // 否则 Object.keys(loginInfo) 会多出 get/put/size 等键（这是 2026-10-07 收敛前的旧写法）。
      getLoginInfoMap: () => __yueduAttachJsonMap(Object.assign({}, call('getLoginInfoMap') || {})),
      // Legado BaseSource.kt:213 —— 返回 Java Map 或 null（书耽等源直接读它）
      getLoginHeaderMap: () => {
        const o = call('getLoginHeaderMap');
        if (!o || typeof o !== 'object') return null;
        return __yueduAttachJsonMap(Object.assign({}, o));
      },
      putLoginInfoMap: (m) => call('putLoginInfoMap', [m]),
      putVariable: (v) => call('putVariable', [v]),
      getHeaderMap: () => call('getHeaderMap') || {},
      // App 端 UI/调度动作（服务端无害桩，避免 is not a function 打挂规则）
      refreshExplore: () => true,
      refreshJSLib: () => true,
      // ⚙️ #331：putConcurrent 上游 = updateConcurrentRate(getKey(), v)（运行期改限频）——
      // 经 sourceCall RPC 回宿主，落到引擎 source 桩的 putConcurrent（BaseSource.kt:401 语义）。
      putConcurrent: (v) => call('putConcurrent', [v]),
    });
    // 规则对象：宿主挂的 toString 过不了 structuredClone ⇒ 在这里重建（字段名紧贴值，MD5 才匹配）
    var __ruleCls = { ruleSearch: 'SearchRule', ruleExplore: 'ExploreRule', ruleToc: 'TocRule', ruleContent: 'ContentRule' };
    for (var __rk in __ruleCls) {
      if (out.source[__rk] && typeof out.source[__rk] === 'object') __yueduRuleBean(out.source[__rk], __ruleCls[__rk]);
    }
  }
  if (out.__yueduInfoMapEntries) {
    const initial = out.__yueduInfoMapEntries || {};
    delete out.__yueduInfoMapEntries;
    // 方括号读写（Rhino/Java Map 语义）+ Map API 双通；每次写入经 RPC 回流宿主那份持久 Map。
    // ⚠️ 语义必须与宿主 makeInfoMapBinding **逐项一致**（size 是数字不是函数、keys/values/entries
    //    返回数组），否则同一段源脚本在 L1 与 worker 下行为不同。
    out.infoMap = new Proxy(Object.assign({}, initial), {
      get: function (t, p) {
        if (typeof p === 'symbol') return undefined;
        const k = String(p);
        const has = (n) => Object.prototype.hasOwnProperty.call(t, String(n));
        const write = (n, v) => { t[String(n)] = v == null ? '' : String(v); rpc('infoMapSet', { k: String(n), v: t[String(n)] }); return v; };
        /**
         * #672 worker 侧 infoMap 与宿主同语义（上游 InfoMap.kt:26-38）：
         *  - get() 无参 = 取整个 map（上游有 get(key) 与 get():MutableMap 两个重载）；
         *  - set(map) 单参 = 整体替换（Map 习惯的 set(k,v) 仍走 write）；
         *  - save()/saveNow() = 源脚本要求落盘（媚色MM 的 exploreUrl 就调它，缺了整页 0 分类）。
         */
        if (k === 'get') return (n) => (n === undefined ? Object.assign({}, t) : (has(n) ? String(t[String(n)]) : undefined));
        if (k === 'put') return write;
        if (k === 'set') return (a, b) => {
          if (b === undefined && a != null && typeof a === 'object' && !Array.isArray(a)) {
            for (const n of Object.keys(t)) { delete t[n]; rpc('infoMapRemove', { k: n }); }
            for (const n of Object.keys(a)) write(n, a[n]);
            return;
          }
          return write(a, b);
        };
        if (k === 'save' || k === 'saveNow') return () => { rpc('infoMapSave', {}); };
        if (k === 'remove' || k === 'delete') return (n) => { const prev = t[String(n)]; delete t[String(n)]; rpc('infoMapRemove', { k: String(n) }); return prev; };
        if (k === 'containsKey') return has;
        if (k === 'containsValue') return (v) => Object.keys(t).some((n) => String(t[n]) === String(v == null ? '' : v));
        if (k === 'isEmpty') return () => Object.keys(t).length === 0;
        if (k === 'clear') return () => { for (const n of Object.keys(t)) { delete t[n]; rpc('infoMapRemove', { k: n }); } };
        if (k === 'keys' || k === 'keySet') return Object.keys(t);
        if (k === 'values') return Object.keys(t).map((n) => String(t[n]));
        if (k === 'entries') return Object.keys(t).map((n) => [n, String(t[n])]);
        if (k === 'forEach') return (fn) => { for (const n of Object.keys(t)) fn(String(t[n]), n); };
        if (k === 'toJSON' || k === 'toString') return () => JSON.stringify(t);
        if (k === 'size') return Object.keys(t).length;
        return t[k];
      },
      set: function (t, p, v) {
        if (typeof p === 'symbol') return false;
        t[String(p)] = v == null ? '' : String(v);
        rpc('infoMapSet', { k: String(p), v: t[String(p)] });
        return true;
      },
      deleteProperty: function (t, p) {
        if (typeof p === 'symbol') return false;
        delete t[String(p)];
        rpc('infoMapRemove', { k: String(p) });
        return true;
      },
      has: function (t, p) { return typeof p === 'string' && Object.prototype.hasOwnProperty.call(t, p); },
      ownKeys: function (t) { return Object.keys(t); },
      getOwnPropertyDescriptor: function (t, p) {
        return typeof p === 'string' && Object.prototype.hasOwnProperty.call(t, p)
          ? { value: t[p], enumerable: true, configurable: true, writable: true }
          : undefined;
      },
    });
  }
  // JSON 内容绑定补 Java Map/List 方法（与宿主 attachJsonMapMethods **同一份注入源码**）。
  // 宿主侧的 Map 方法是非枚举的 → structuredClone 不会带过来 → 这里必须再挂一次，
  // 否则同一个 kind 规则在 L1 能跑、进 worker 就报 result.get is not a function。
  for (const k of __YUEDU_JSON_MAP_KEYS) {
    if (out[k] !== undefined && out[k] !== null) out[k] = __yueduAttachJsonMap(out[k]);
  }
  return out;
}

// StrResponse 语义（对齐宿主 syncHttp 返回）：字符串本体可当 body，也可链式取
function strResponse(body, headers, code, req) {
  const out = new String(body);
  out.body = () => body;
  // [#409] headers() 必须是 okhttp Headers 视图（get/names/values/size/toMultimap）——
  // 旧实现给普通对象 => 源脚本的 java.connect(u).headers().values('Set-Cookie') 抛
  // values is not a function（18AV 的 rrcheck 过 18+ 声明闸就靠它）。
  // 唯一实现见宿主 selector/ok-headers.ts，同一份源码经 OK_HEADERS_SOURCE 注入本模板。
  // 注意：本注释位于模板串内，禁反引号与美元花括号插值。
  out.headers = () => __yueduOkHeaders(headers);
  out.header = (name) => (name === undefined ? headers : (headers[String(name).toLowerCase()] ?? ''));
  out.code = () => code;
  // 与 L1（core/selector/js.ts 的 syncHttp 返回值）**同面**：statusCode / url 也要有。
  // 实测缺 statusCode → 走 worker 的脚本报 NOT_A_FUNCTION: response.statusCode
  // （同一份源走 L1 却正常 —— 又一例「两路不一致」）。
  out.statusCode = () => code;
  out.url = () => req.url;
  out.raw = () => {
    const bodyOut = new String(body);
    bodyOut.body = () => body;
    bodyOut.code = () => code;
    return {
      body: bodyOut,
      headers,
      code,
      request: () => ({
        url: () => req.url,
        method: () => req.method,
        body: () => req.body,
        headers: () => req.headers,
      }),
      headersObj: () => headers,
    };
  };
  return out;
}
function httpRpc(method, url, body, headers, noRedirect, dnsIp, timeoutMs) {
  const r = rpc('http', {
    method,
    url: String(url),
    body: body === undefined ? '' : String(body),
    headers: headers || {},
    ...(noRedirect ? { noRedirect: true } : {}),
    ...(dnsIp ? { dnsIp: String(dnsIp) } : {}),
    ...(timeoutMs > 0 ? { timeoutMs: Number(timeoutMs) } : {}),
  });
  return strResponse(r.body, r.headers || {}, r.code || 0, { url: String(url), method, body: body === undefined ? '' : String(body), headers: headers || {} });
}

/**
 * #538 **原始字节模式**同步 RPC（okhttp3 body().bytes() 用）：宿主绕开 utf8 解码，
 * 以 base64 回传真实字节 ⇒ 二进制响应（密文帧）零失真。文本响应同样正确
 * （bytes 再 toString('utf8') 即正文）。与 httpRpc 同一条出口、同一套头/预算语义。
 */
function httpRpcRaw(method, url, body, headers, noRedirect) {
  const r = rpc('http', {
    method,
    url: String(url),
    body: body === undefined ? '' : String(body),
    headers: headers || {},
    raw: true,
    ...(noRedirect ? { noRedirect: true } : {}),
  });
  return {
    code: Number(r.code) || 0,
    headers: r.headers || {},
    bytes: new Uint8Array(Buffer.from(String(r.bodyB64 || ''), 'base64')),
  };
}

/**
 * #529 org.jsoup.Jsoup.connect(url) 的 worker 版：构建器 + execute()（传输复用本文件的 httpRpc，
 * 与 java.ajax 同一条同步出口 ⇒ 源级头/闸页/预算语义自动一致）。bodyAsBytes() 与宿主**同面**
 * 返回 Uint8Array（本仓 decryptStr 认字节数组）。注意：本注释位于模板串内，禁反引号。
 */
function makeWorkerJsoupConnection(rawUrl) {
  var cfg = { url: String(rawUrl == null ? '' : rawUrl), method: 'GET', headers: {}, body: undefined };
  function kv(k, v) { return encodeURIComponent(String(k)) + '=' + encodeURIComponent(String(v == null ? '' : v)); }
  function hget(hs, n) { return hs && hs.get ? hs.get(String(n)) : (hs ? hs[String(n).toLowerCase()] : ''); }
  var conn = {
    method: function (m, k, v) { cfg.method = String(m == null ? 'GET' : m).toUpperCase(); if (k !== undefined) cfg.body = kv(k, v); return conn; },
    header: function (k, v) { cfg.headers[String(k)] = String(v == null ? '' : v); return conn; },
    userAgent: function (s) { cfg.headers['User-Agent'] = String(s == null ? '' : s); return conn; },
    referrer: function (s) { cfg.headers['Referer'] = String(s == null ? '' : s); return conn; },
    cookie: function (k, v) { var c = String(k) + '=' + String(v == null ? '' : v); cfg.headers['Cookie'] = cfg.headers['Cookie'] ? cfg.headers['Cookie'] + '; ' + c : c; return conn; },
    data: function (k, v) { var x = kv(k, v); cfg.body = cfg.body ? cfg.body + '&' + x : x; return conn; },
    timeout: function () { return conn; },
    ignoreContentType: function () { return conn; },
    ignoreHttpErrors: function () { return conn; },
    execute: function () {
      /* #464 坏地址必须抛（与宿主 assertHttpUrl 同语义/同文案：源靠它做兜底分支） */
      if (!/^https?:\/\//i.test(cfg.url)) { throw new Error('Malformed URL: ' + cfg.url); }
      var r = httpRpc(cfg.method, cfg.url, cfg.body, cfg.headers, false);
      var body = String(r && r.body ? r.body() : '');
      var code = r && r.code ? r.code() : 0;
      var hs = r && r.headers ? (r.headers() || {}) : {};
      return {
        body: function () { return body; },
        bodyAsBytes: function () { return Uint8Array.from(Buffer.from(body, 'utf8')); },
        statusCode: function () { return code; },
        code: function () { return code; },
        status: function () { return code; },
        headers: function () { return hs; },
        header: function (n) { var v = hget(hs, n); return v == null ? '' : String(v); },
        contentType: function () { var v = hget(hs, 'content-type'); return v == null ? '' : String(v); },
        toString: function () { return body; },
      };
    },
  };
  return conn;
}

// 时间格式化（对齐宿主 javaTimeFormat）
function timeFmt(ms, pattern) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return String(pattern)
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

/**
 * 原生全局快照构建器：按**宿主下发的名字**从目标全局取当前值。
 *
 * 为什么名单要下发而不是手写（#601 二次踩坑，2026-10-24）：
 * 这里原手写了一份 28 个内置名，与宿主 BUILTIN_GLOBAL_NAMES（68 个）**漂移** ——
 * 漏掉 Proxy ⇒ 🎨热辣/包子/MYCOMIC/再漫画 的 header 脚本 var Proxy = Map('代理：')
 * 被当普通变量 hoist 到 globalThis（字符串），后续任何 new Proxy(...) 直接
 * 「Proxy is not a constructor」（4 源）。名单必须**单一来源**。
 * 本段在模板串内：禁反引号与美元花括号。
 *
 * #624：target 可以是 vm context 的全局（内置是 context 自己那份，与求值 realm 一致）。
 */
function __yueduBuildNatives(names, target) {
  var g = target || globalThis;
  var o = {};
  if (!names || !names.length) return o;
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (typeof n !== 'string' || !n) continue;
    var v = g[n];
    if (typeof v === 'function') o[n] = v;
  }
  return o;
}
/**
 * #629 **natives 快照按 realm 缓存**（worker 内分段计时实测 natives=0.35ms/次，
 * 占单次求值 ~12%）。
 *
 * 贵的不是那 65 次循环，而是**每次 g[n] 都要跨 vm context 边界**取值。
 * 宿主下发的名单（BUILTIN_GLOBAL_NAMES）在同一源里恒定 ⇒ 同一 realm 内可安全复用。
 *
 * 命中判据：realm 相同 + 名单**逐项同序相等**（数组每次 postMessage 都是新对象，
 * 不能用引用比较；逐项字符串比较远便宜于跨 context 取值）。
 */
var __yueduNativesCache = { realm: null, keys: null, value: null };
function __yueduNatives(names, target) {
  var g = target || globalThis;
  var cachedValue = __yueduNativesCache.value;
  if (cachedValue && __yueduNativesCache.realm === g && names && __yueduNativesCache.keys) {
    var ck = __yueduNativesCache.keys;
    if (ck.length === names.length) {
      var same = true;
      for (var i = 0; i < ck.length; i++) {
        if (ck[i] !== names[i]) {
          same = false;
          break;
        }
      }
      if (same) return cachedValue;
    }
  }
  var v = __yueduBuildNatives(names, g);
  __yueduNativesCache = { realm: g, keys: names ? Array.prototype.slice.call(names) : null, value: v };
  return v;
}

/**
 * #624 **真隔离求值 realm**（node:vm）。
 *
 * 背景（#612 审计 + 本轮取证 tmp/probe-624-worker-surface.mts）：worker 线程里
 * require 是 Node **注入**的 ⇒ 书源脚本能 require('os').userInfo().username
 * （实测返回 SATAN）⇒ 「默认跑 worker 所以无 RCE」这个缓解判断**只对 process.exit()
 * 成立，对 RCE 是错的**。vm context 内 process/require/Buffer/global 全 undefined，
 * 且 ({}).constructor('return …')() 逃逸直接 THROW（见 docs/live/vm-isolate-audit-2026-10-25.md）。
 *
 * 为什么**按 worker 复用**而不是按求值新建：审计实测 createContext = 2.27ms/次，
 * 而单次求值总耗时 0.1~0.2ms ⇒ 按求值建就是 20 倍劣化。本 worker 只建一次，
 * 求值之间靠 reset() 复位。
 *
 * ⚠️ **两个实测坑**（tmp/probe-624-keys.mts / node -e 验证）：
 *  ① contextified 对象（createContext 返回值）**只能看到显式赋值的键** —— 内置
 *     （Map/JSON…）从外部读是 undefined，只在 context 内部可见 ⇒ 必须取**内部全局**
 *     （runInContext('globalThis')）当真全局：绑定注入、window、natives 快照都用它；
 *  ② 脚本的隐式全局（foo=1）也落在内部全局上 ⇒ 复位不能只删「注入键」，要按
 *     「初始内置键清单 + 值快照」做差集删除与值还原（内置被脚本覆盖也靠它恢复）。
 *
 * 返回 { global, reset, compile } 或 null（不可用 ⇒ 调用方回落 worker 全局，旧行为）。
 * 注意：本段在 String.raw 模板内 —— 禁反引号与美元花括号。
 */
var __yueduVmState = null;
function __yueduVmRealm() {
  if (__yueduVmState) return __yueduVmState.ok ? __yueduVmState : null;
  var state = { ok: false };
  try {
    var vmmod = require('node:vm');
    var ctx = vmmod.createContext({});
    var inner = vmmod.runInContext('globalThis', ctx);
    /**
     * ⚠️ 必须用 **getOwnPropertyNames** 而不是 Object.keys：全局内置（Array/Map/
     * Object/JSON…）在全局对象上是**非枚举**自有属性，Object.keys 一个都不返回
     * ⇒ keep 会是空数组 ⇒ 复位时把内置也 delete 掉（实测：下一个求值
     * "Array is not defined"）。非枚举属性同样会被脚本的隐式赋值覆盖/遮蔽，
     * 所以值快照也要按全量自有属性做。
     */
    var keep = Object.getOwnPropertyNames(inner);
    var vals = keep.map(function (k) { return inner[k]; });
    var resetFn = vmmod.runInContext(
      '(function(keep,vals){var ks=Object.getOwnPropertyNames(globalThis);' +
      'for(var i=0;i<ks.length;i++){if(keep.indexOf(ks[i])<0){try{delete globalThis[ks[i]];}catch(e){}}}' +
      'for(var j=0;j<keep.length;j++){if(globalThis[keep[j]]!==vals[j]){try{globalThis[keep[j]]=vals[j];}catch(e2){}}}})',
      ctx,
    );
    /**
     * #628 **接纳当前 realm 全局里「新增」的键**（把它们并入复位快照，之后不再删）。
     *
     * 为什么需要：lib 侧若有无 var 的隐式全局赋值（HJ_BASE = 'https://…'），它们落到
     * realm 全局上；而 lib 作用域现在要**跨求值长期复用**（对齐上游 SharedJsScope 的
     * preventExtensions + 从不 reset）⇒ lib 不再重跑，那些隐式全局就再也不会产生，
     * 却被 reset() 每次删掉 ⇒ 复用的 libScope 里闭包引用它们 ⇒ ReferenceError。
     *
     * 这正是本仓上一轮「共享 libScope ⇒ 目录 0 章」的**真正机制**（不是 this.xxx 那条路，
     * this 指向 scope 只解决了一半）。上游没有这笔问题，因为它的 scope 从不 reset。
     *
     * ⚠️ 只在 **lib 首次求值之后调用一次**：脚本（code）求值产生的隐式全局**必须**仍被
     * reset 删除（那是 #624 隔离语义的核心，防跨求值串味 —— 实测 var Proxy='1,2,3'
     * 会污染到下次求值的 java 桩）。
     */
    var adopt = function () {
      var ks = Object.getOwnPropertyNames(inner);
      for (var i = 0; i < ks.length; i++) {
        if (keep.indexOf(ks[i]) < 0) {
          keep.push(ks[i]);
          vals.push(inner[ks[i]]);
        }
      }
    };
    state = {
      ok: true,
      ctx: ctx,
      global: inner,
      reset: function () { resetFn(keep, vals); },
      compile: function (src) { return vmmod.runInContext(src, ctx); },
      adopt: adopt,
    };
  } catch (e) {
    state = { ok: false };
  }
  __yueduVmState = state;
  return state.ok ? state : null;
}

/**
 * #624 **向 context 注入的「无害 Web/Node 面」**（vm context 里没有，但语料/既有行为要用）。
 *
 * 判据（2026-10-25 语料全量扫描 + 全局差集实测 tmp/probe-624-globals.mts）：
 *  · Buffer / process / require / module / global **坚决不给** —— 那是 #624 要关的面；
 *  · URL / URLSearchParams / TextEncoder / TextDecoder / atob / btoa / structuredClone
 *    / performance / crypto ⇒ **纯计算**，无新能力；
 *  · setTimeout 等计时器 ⇒ 与今天 worker 全局同形态（回调仍是 context 函数，
 *    自由变量解析不到 require）；AbortController + fetch ⇒ **网络能力类**与 java.ajax
 *    等价（书源本来就能发任意请求），语料有 1 个源在求值器代码里用 fetch
 *    （_____2.json 的服务端探测），不给就是静默回归。
 * URL 用与 L1 逐字相同的「可无 new 调用」shim（Rhino 语义：URL(baseUrl).host）。
 */
function __yueduWebGlobals() {
  var urlShim = Object.assign(function (u) { return new URL(String(u == null ? '' : u)); }, { prototype: URL.prototype });
  return {
    URL: urlShim,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    atob: atob,
    btoa: btoa,
    structuredClone: structuredClone,
    performance: performance,
    crypto: crypto,
    AbortController: AbortController,
    fetch: fetch,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    queueMicrotask: queueMicrotask,
  };
}

/**
 * #611 step3 **jsLib 独立作用域工厂**（对齐 L1 的 libScopeFactory / 上游 ScriptBindings）。
 *
 * 形态与 L1 逐字对应：var __yueduLibScope={};Object.setPrototypeOf(它,globalThis);
 * 接着是 lib 文本、hoist 到 __yueduLibScope 的语句、collect 语句，最后 return __yueduLibScope。
 *  · 内置名收「new.target 双语义 shim」（new 走原生 / 普通调用走源库版，#601）；
 *  · 普通函数收原值（返回后由调用方统一重绑到本次求值层）；
 *  · 非函数收值。
 * lib 每 worker 只编译一次（Map 缓存；V8 对 vm.runInContext 无编译缓存，
 * 而 lib 是 55KB 级文本 —— 不缓存就等于每次求值重编译，那正是 #509 在 L1 修掉的坑）。
 *
 * ★ #628 **作用域对象由调用方传入（作为参数 + this）**，不再在函数体里新建。
 *
 * 上游依据（app/src/main/java/io/legado/app/model/SharedJsScope.kt:103-124）：
 * jsLib 是 RhinoScriptEngine.eval(jsLib, scope) —— **lib 就在那个 scope 里求值**，
 * 于是 lib 顶层的 this.xxx = … 落进 scope 自己；scope 按 md5(jsLib) 进 LruCache(16)
 * 长期复用，preventExtensions 冻结，**从不 reset**。
 *
 * 我们此前的写法是 libFactory.call(realmGlobal)（this = realm 全局）⇒ lib 的
 * this.xxx 落到 realm 全局上，而 #624 每次求值后 realm.reset() 会把它们抹掉
 * ⇒ 复用的 scope 里闭包引用的全局消失 ⇒ 只能每次重建（实测「复用 ⇒ 目录 0 章」）。
 * 把 this 指向 scope 本身后，字节与上游一致：lib 的写入只落 scope，reset 不再影响它。
 */
var __yueduLibFactories = new Map();
function __yueduLibFactorySrc(libText, libFns, natives) {
  var names = [];
  for (var i = 0; i < libFns.length; i++) {
    var n0 = libFns[i];
    if (typeof n0 === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n0)) names.push(n0);
  }
  var hoist = '';
  var collect = '';
  for (var j = 0; j < names.length; j++) {
    var n = names[j];
    var key = JSON.stringify(n);
    var isNative = !!(natives && natives[n]);
    if (isNative) {
      hoist += 'try{if(typeof ' + n + '!=="undefined")__yueduLibScope[' + key + ']=(function(){var __f=' + n +
        ';var __N=(globalThis.__yueduNativeGlobals||{})[' + key + '];if(!__N)return __f;' +
        'var __w=function(){return new.target?new __N(...arguments):__f.apply(this,arguments);};' +
        'try{__w.prototype=__N.prototype;}catch(e){}return __w;})();}catch(e){}';
    } else {
      hoist += 'try{if(typeof ' + n + '!=="undefined") __yueduLibScope[' + key + ']=' + n + ';}catch(e){}';
    }
    var pick = isNative ? '__yueduLibScope[' + key + ']' : n;
    collect += 'try{ if (typeof ' + n + ' !== "undefined") __yueduLibScope[' + key + '] =' +
      ' typeof ' + n + ' === "function" ? ' + pick + ' : ' + n + '; }catch(e){}';
  }
  /**
   * ★ #628 作用域对象由**调用方传入**（this 与形参都指向它）：lib 顶层 this.xxx
   * 因此只落该 scope，不落 realm 全局 —— 复用的 scope 才不会被 realm.reset() 打断。
   * 见本函数头注的上游依据。
   */
  return 'Object.setPrototypeOf(__yueduLibScope, globalThis);\n' +
    libText + '\n' + hoist + '\n' + collect + '\nreturn __yueduLibScope;';
}
function __yueduLibFactory(libText, libFns, natives, realm) {
  var cached = __yueduLibFactories.get(libText);
  if (cached) return cached;
  var body = __yueduLibFactorySrc(libText, libFns, natives);
  var factory;
  try {
    /**
     * ⚠️ vm 模式必须包一层函数表达式：工厂体末尾有 return __yueduLibScope，
     * 而 vm.runInContext 是 **Script 上下文**，顶层 return 直接 SyntaxError
     * （与 #598 同一条判据）。new Function 是函数体上下文，无需包裹。
     * #628：形参 __yueduLibScope 由调用方传入（见 __yueduLibFactorySrc 头注）。
     */
    factory = realm
      ? realm.compile('(function(__yueduLibScope){' + body + '})')
      : new Function('__yueduLibScope', body);
  } catch (e) {
    // 源本身语法错：返回一个「跑起来就抛」的工厂，让错误按原样冒到脚本层（带行号）
    factory = function () { throw e; };
  }
  if (__yueduLibFactories.size > 16) __yueduLibFactories.clear();
  __yueduLibFactories.set(libText, factory);
  return factory;
}

/**
 * #628 **worker 内 jsLib 作用域复用**（对齐上游 SharedJsScope.scopeMap）。
 *
 * 上游（SharedJsScope.kt:103-124）：key = md5(jsLib) 的 LruCache(16)，
 * 命中就复用 **同一个 ScriptBindings 对象**，RhinoScriptEngine.eval(jsLib, scope)
 * 全进程只跑一次，且 **从不 reset**。
 *
 * 本仓此前每次求值都要重跑 56KB lib —— 那是「手机端 2~3s vs 我们 15~20s」的主因
 * （1612 章 × 每次 ~10ms worker CPU）。原因有两条，逐条对齐后才敢复用：
 *   ① lib 顶层 this.xxx = … 原先落在 **realm 全局**（factory.call(realmGlobal)），
 *      被 realm.reset() 每次抹掉 ⇒ 本函数改用 factory.call(scope, scope)；
 *   ② lib 的**隐式全局**（无 var 赋值）也落在 realm 全局，同样被 reset 抹掉
 *      ⇒ 首次建好后 realm.adopt() 把它们并入复位快照（见 __yueduVmRealm.adopt）。
 *
 * **不照抄上游的 preventExtensions**（本仓自有设计，上游无等价前提）：
 * 上游是「scope 直接作为求值作用域」单层结构，冻结它防污染；
 * 本仓 #611 step3 是**双层**（本次 bindings 层 scopeObj 原型指向 libScope），
 * 求值写入默认落 scopeObj 自身属性、**进不了 libScope**，而 lib 自身的延迟赋值
 * （this.xxx 写在某个函数里而非顶层）会被冻结打成静默失败 ⇒ 冻结风险大于收益。
 *
 * 失效条件（任一即重建）：
 *  · libText 变了（换源 / 源被编辑）；
 *  · realm 变了（worker 被回收换新，#624 的 realm 是 per-worker 的）；
 *  · 显式要求回收（__yueduLibScopeClear()，宿主在换源/编辑源时会走新 realm）。
 */
var __yueduLibScopeCache = { key: '', realm: null, scope: null };
function __yueduLibScopeClear() {
  __yueduLibScopeCache = { key: '', realm: null, scope: null };
}
/**
 * worker 侧读环境变量（worker 全局有没有 process 未经约定，故一律 try 包住、读一次缓存）。
 * ⚠️ 本段在 WORKER_SRC 模板串内：注释不得出现反引号（已踩五次）。
 */
var __yueduEnvMemo = {};
function __yueduEnvFlag(name, offValue) {
  if (name in __yueduEnvMemo) return __yueduEnvMemo[name];
  var v = false;
  try {
    v = typeof process !== 'undefined' && !!process.env && process.env[name] === offValue;
  } catch (e) {
    v = false;
  }
  __yueduEnvMemo[name] = v;
  return v;
}
/**
 * #629 **worker 侧分段计时**（默认关闭，YUEDU_DEBUG_WORKER_TIME=1 开启；关闭时零开销）。
 *
 * 为什么需要：wall time 在本机波动 ±25%，母发生 ±40%，已无法判别差异；而 profile 的 self time
 * 又被长尾摊薄。这里直接把「单次 eval 在 worker 里的时间构成」累加出来（每 400 次打印一行）：
 *   pre  = 建 natives / 预置 / 桥接前的准备
 *   lib  = 取 jsLib 作用域（命中复用时应趋近 0）
 *   bind = 把 lib 函数 bind 到本次求值层
 *   run  = 真正执行脚本（含 vm context 切换）
 *   reset= 求值后复位 realm 全局
 * 「HOST 端看到的往返 − 上述之和」= 消息序列化 / 排队等待。
 * ⚠️ 本段在 WORKER_SRC 模板串内：注释不得出现反引号。
 */
var __yueduWTN = 0;
var __yueduWTAcc = null;
function __yueduWTOn() {
  return __yueduEnvFlag('YUEDU_DEBUG_WORKER_TIME', '1');
}
function __yueduWTMark(w, name) {
  if (!w) return;
  var now = performance.now();
  w.seg[name] = (w.seg[name] ?? 0) + (now - w.last);
  w.last = now;
}
function __yueduWTDone(w) {
  if (!w) return;
  __yueduWTMark(w, 'tail');
  __yueduWTN += 1;
  if (!__yueduWTAcc) __yueduWTAcc = { pre: 0, lib: 0, bind: 0, run: 0, reset: 0, tail: 0, total: 0 };
  for (var k in w.seg) __yueduWTAcc[k] = (__yueduWTAcc[k] ?? 0) + w.seg[k];
  __yueduWTAcc.total += performance.now() - w.t0;
  // ⚠️ 周期必须 <= RECYCLE_AFTER_EVALS(100)：worker 到点就换新worker，计数随之清零
  if (__yueduWTN % 50 === 0) {
    var p = function (x) {
      return (x / __yueduWTN).toFixed(3);
    };
    console.log(
      '[wt] n=' +
        __yueduWTN +
        ' total=' +
        p(__yueduWTAcc.total) +
        'ms natives=' +
        p(__yueduWTAcc.natives ?? 0) +
        ' pre=' +
        p(__yueduWTAcc.pre) +
        ' lib=' +
        p(__yueduWTAcc.lib) +
        ' bind=' +
        p(__yueduWTAcc.bind) +
        ' run=' +
        p(__yueduWTAcc.run) +
        ' reset=' +
        p(__yueduWTAcc.reset) +
        ' tail=' +
        p(__yueduWTAcc.tail),
    );
  }
}
/**
 * 取一段脚本里出现过的标识符（YUEDU_JS_LIBBIND=minimal 用）。
 * 与宿主 selector/js.ts 的 identsOf 同判据；单次 match 而非逐名字 new RegExp（#628 教训）。
 */
var __yueduIdentRe = /[A-Za-z_$][\w$]*/g;
function __yueduIdentsOf(s) {
  var out = {};
  __yueduIdentRe.lastIndex = 0;
  var m = __yueduIdentRe.exec(s);
  while (m) {
    out[m[0]] = 1;
    m = __yueduIdentRe.exec(s);
  }
  return out;
}
function __yueduLibScopeFor(libText, libFns, natives, realm, libGlobal) {
  /**
   * **回退开关 YUEDU_JS_LIBSCOPE_CACHE=0**：关掉复用、每次求值重建 lib 作用域
   * （#628 归因对照用；也是缓存万一出错时的兜底，语义回到 10-25 之前的行为）。
   *
   * **非 vm 模式本身也不缓存**（YUEDU_JS_VM=0 回退路径）：那里求值全局就是 worker 全局，
   * 隔离靠「求值前 key 快照 + 求值后删除新增键」，而 lib 的隐式全局也走这条路 ⇒
   * 一旦 lib 不重跑，那些键被删后再也不会回来（等价于缺一个 adopt）。
   * 回退路径优先保语义不变（它本来就是正确性对照档），perf 收益只在 vm 默认路径要。
   */
  var cacheable = !!realm && !__yueduEnvFlag('YUEDU_JS_LIBSCOPE_CACHE', '0');
  if (cacheable && __yueduLibScopeCache.key === libText && __yueduLibScopeCache.realm === realm && __yueduLibScopeCache.scope) {
    return __yueduLibScopeCache.scope;
  }
  var factory = __yueduLibFactory(libText, libFns, natives, realm);
  var scope = {};
  /**
   * this = scope（不是 realmGlobal）：上游 RhinoScriptEngine.eval(jsLib, scope) 同义 ——
   * lib 顶层的 this.xxx = … 必须落在 scope 上，这样 scope 才能跨求值复用。
   */
  var ret = factory.call(scope, scope);
  var out = ret && typeof ret === 'object' ? ret : scope;
  /**
   * #636 第二层 **lib 的名字必须也落在「realm 全局」上**（按源开启：msg.libGlobalNames；
   * YUEDU_JS_LIBGLOBAL_OFF=1 可整体强制关）。
   *
   * 真因（2026-10-26，有栈为证）：qyyuapi 系的 de.js 是**混淆 + 自解密 eval**，
   * 它解出来的载荷把 user_Check 这类函数**定义在自己的 IIFE 里再挂到全局**。
   * 这种函数的闭包只看见「全局」，看不见我们挂在 libScope 上的 Get
   * ⇒ 调用时 Get is not defined（包子漫画/漫画柜/G站/MYCOMIC 全挂在这条）。
   *
   * 上游为什么没有这个问题：Rhino 的 SharedJsScope 产出的 scope **就是脚本的全局**
   * （ScriptBindings.chainTo 把它接到 global），所以任何闭包都能沿全局拿到 lib 函数。
   * 本仓是「with(scopeObj) 只包住顶层 eval」，一旦代码自己把函数挂到全局就断链了。
   *
   * 所以：lib 求值后把它的**自有键**镜像到 realm 全局；随后 realm.adopt() 会把它们并进
   * 复位保留名单 ⇒ 跨求值存活（与上游 preventExtensions + 从不 reset 同效）。
   * ⚠️ 只镜像 lib 自己的键（Object.keys(out)），不镜像脚本产生的隐式全局
   *    —— 脚本那部分必须继续被 realm.reset() 删掉（#624 隔离语义）。
   *
   * ★ **默认关**：#611 step3 的隔离锁明确「lib 声明不进求值全局」⇒ 只有宿主判定
   *   「jsLib 是远程 URL 表」（msg.libGlobalNames）的源才开，普通内联 jsLib 源不受影响。
   */
  var __libGlobalOn = libGlobal === true;
  if (__yueduEnvFlag('YUEDU_JS_LIBGLOBAL_OFF', '1')) __libGlobalOn = false;
  if (__libGlobalOn) {
    var __mt = realm && realm.global ? realm.global : typeof globalThis !== 'undefined' ? globalThis : null;
    if (__mt) {
      var __mk = Object.keys(out);
      for (var __mi = 0; __mi < __mk.length; __mi++) {
        try { __mt[__mk[__mi]] = out[__mk[__mi]]; } catch (e) { /* 只读全局：跳过 */ }
      }
    }
  }
  /**
   * lib 求值完毕后**立刻**把这个 realm 的当前全局并入「复位保留名单」：
   * lib 产生的隐式全局从此免删（否则下一次 reset 就把它们抹了，而 lib 不再重跑）。
   * ⚠️ 只此一次：脚本（code）的隐式全局仍必须每次被 reset 删掉（#624 隔离语义）。
   */
  if (realm && typeof realm.adopt === 'function') {
    try { realm.adopt(); } catch (e) { /* 接受失败：退化成「可能丢隐式全局」的既有行为 */ }
  }
  __yueduLibScopeCache = { key: libText, realm: realm, scope: out };
  return out;
}

/**
 * #611 step3 / #624 **求值 runner**（在求值 realm 里编译一次，按求值调用）。
 *
 * 四个参数对应今天 worker 里 new Function(__pre + 'var ret=eval(…);' + hoistVars …)
 * 的四段，拆成参数是为了**runner 只编译一次**（今天整段含 55KB lib 每次重编）：
 *  · __yueduScope：求值层对象（chain 模式 = Object.create(libScope)+绑定；否则 = realm 全局）
 *  · __yueduCode ：eval 的源码（顶层 return 由 #598 的 IIFE 重试在 code 里包）
 *  · __yueduPre  ：同名 var 预置（shadow 保护，先跑）
 *  · __yueduPost ：顶层 var 回写全局（后跑；两个都是直接 eval ⇒ sloppy 下 var 泄漏可见）
 * this = 求值层（上游 Rhino：顶层 this 就是作用域对象）。
 */
function __yueduRunnerSrc() {
  /**
   * ⚠️ 局部名**不要**叫 __yueduRet：#636 第二层的 Script 分支曾用同名的
   * 「Script 顶层 var」承接结果 —— 那种 var 在 realm 全局上**删不掉**
   * （delete globalThis.__yueduRet 恒为 false），而这里 with(__yueduScope) 的赋值
   * 会沿原型链写到那个全局属性 ⇒ 本地变量恒空 ⇒ 后续求值全返回 undefined。
   * 那边现在已改成不声明 Script 顶层 var（结果走 __yueduP.out）；这里换名是第二道防线。
   * 本段在 WORKER_SRC 模板串内：禁反引号与美元花括号。
   */
  return '(function(__yueduScope,__yueduCode,__yueduPre,__yueduPost){' +
    'var __yueduRunOut;' +
    'if(__yueduPre) eval(__yueduPre);' +
    'with(__yueduScope){__yueduRunOut=eval(__yueduCode);}' +
    'if(__yueduPost) eval(__yueduPost);' +
    'return __yueduRunOut;})';
}

/** runner 按 realm 缓存（vm context 一个 / worker 全局一个）；realm 变了才重编译 */
var __yueduRunnerCache = { realm: null, fn: null };
function __yueduRunner(realm) {
  if (__yueduRunnerCache.fn && __yueduRunnerCache.realm === realm) return __yueduRunnerCache.fn;
  var fn = null;
  try {
    /**
     * ⚠️ 两条编译路径的**返回语义不同**（实测踩坑）：
     *  · vm.runInContext(源码) 返回脚本的**完成值** ⇒ 传函数表达式源码即可拿到函数；
     *  · new Function(源码) 把源码当**函数体** ⇒ 表达式语句不 return，必须包一层
     *    'return ' + 源码，否则 runner 恒为 undefined（legacy 路径全静默失效）。
     */
    var src = __yueduRunnerSrc();
    fn = realm ? realm.compile(src) : new Function('return ' + src)();
  } catch (e) {
    fn = null;
  }
  __yueduRunnerCache = { realm: realm, fn: fn };
  return fn;
}

/**
 * #624 错误信息**鸭子取值**：vm 上下文抛出的错，在 worker 侧 instanceof Error 是 false
 * （原型是 context 那一份）⇒ 原来 e instanceof Error ? e.message : String(e) 会整体退化成
 * "TypeError: xxx" 串，explainJsError 的正则匹配与行号定位都受影响。
 */
function __yueduErrMsg(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
  return String(e);
}

/**
 * 顶层声明提升（对齐 L1 的 hoistStmts）：把脚本里的顶层声明挂到 globalThis。
 *
 * 为什么必须：Legado 用 Rhino，**函数声明即全局属性** → 源脚本大量写 this.foo()，
 * 而 V8 的 eval 里声明只落在 eval 自己作用域 → this.foo 取不到（实测报
 * "this.getData is not a function"）。名单由宿主 scanDecls 扫出，这里只挂载。
 *
 * @param post true = **回写位**（hoistVars，跑在 code 之后的独立 eval 里，没有 with 包着）。
 *   该位置对**内置名一律跳过**，原因（#624 收尾取证，测试 780）：
 *     · 直接 eval 的 var 声明提升到 runner 作用域留下**空绑定**（赋值经 with 写进求值全局）；
 *     · 回写位的裸名 typeof n 解析到这个空绑定 ⇒ 恒为 undefined ⇒ 旧代码靠
 *       if(typeof n!=="undefined") 恰好跳过 —— 那是 bug 形态，不是设计；
 *     · 更要命的是**污染没人还原**：var Proxy = "1,2,3" 把求值全局的 Proxy 顶成字符串，
 *       跨求值留存 ⇒ 下一条求值入口的 java 桩 new Proxy 直接炸（YUEDU_JS_VM=0 实测）。
 *   宿主 L1 同位置（hoistStmts(codeVars) 在 new Function 体内）对内置名同样因空绑定
 *   不可达 ⇒ 这里显式跳过与之对齐；求值全局的污染由 runEval finally 的原生复位兜底。
 *
 * 注意：本函数体在 String.raw 模板内 —— 不能出现反引号，不要写转义（用 String.fromCharCode）。
 */
function __yueduHoist(names, natives, post) {
  if (!names || !names.length) return '';
  var out = '';
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (typeof n !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n)) continue;
    var N = natives && natives[n];
    if (typeof N === 'function') {
      // 内置名：new.target 双语义 shim（new 走原生、普通调用走源库版）。与宿主 hoistStmts 同判据。
      //
      // ⚠️ worker 与 L1 的差异：legacy 模式（宿主把 lib 拼进 code）下 lib 与 code 在
      // **同一个 eval 作用域**里，code 里的 new Map(...) 会解析到 lib 的函数声明
      // （词法作用域），绕过 globalThis 的 shim ⇒ 仍然 new 源库版。故除了挂 globalThis，
      // 还要把**本作用域的绑定**回指 shim：Map = globalThis["Map"]（函数声明绑定在
      // sloppy 下可赋值）。这样 lib 内部的 Map(x) 也走 shim 的普通分支（→ 源库版），语义不变。
      // 回写位（post）对内置名跳过，理由见函数头 @param post。
      if (post) continue;
      const key = JSON.stringify(n);
      out += 'try{if(typeof ' + n + '!=="undefined"){globalThis[' + key + ']=(function(){var __f=' + n +
        ';var __N=(globalThis.__yueduNativeGlobals||{})[' + key + '];' +
        'if(!__N)return __f;' +
        'var __w=function(){return new.target?new __N(...arguments):__f.apply(this,arguments);};' +
        'try{__w.prototype=__N.prototype;}catch(e){}return __w;})();' + n + '=globalThis[' + key + '];}}catch(e){}';
      continue;
    }
    out += 'try{if(typeof ' + n + '!=="undefined") globalThis[' + JSON.stringify(n) + ']=' + n + ';}catch(e){}';
  }
  return out;
}

/**
 * 结果「可发送化」：postMessage 要求可结构化克隆，而源脚本常返回**带方法的对象**
 * （典型：org.jsoup.Jsoup.parse(html) 的 doc —— 上面 __yueduJsoup 造的 doc/元素列表）。
 * L1 路径由调用方 asString() 转字符串，worker 路径必须在此等价转换，否则会报
 * could not be cloned 把整条规则打挂（实测源：悦读小说正文规则 ...remove(); doc）。
 * 注意：本函数体位于模板字符串内 —— 注释里不能出现反引号。
 */
function __yueduSendable(v) {
  if (v == null) return v;
  if (typeof v === 'function' || typeof v === 'symbol') return '';
  /**
   * [#531] **jsoup 元素包装走「描述符回流」**（与规则桥 getElements 同一条通道）。
   *
   * 为什么必须有这一支：mkList 造的元素包装，其 outerHTML/html/text/attr/select 等方法都是
   * **可枚举函数属性** ⇒ structuredClone 必失败 ⇒ 旧行为退化成 String(v)，而 jsoup
   * Elements.toString() = 全表 outerHTML 拼接 ⇒ **N 个元素塌成 1 个字符串**。
   * 实测（找书啦·求书互助 ruleToc）：
   *   ① chapterList 返回 new Elements() 包装的 2 个元素 ⇒ 宿主只拿到 1 个字符串（els.length = 1）；
   *   ② 阶段二 chapterName 里 result 变成纯字符串（worker 内 typeof result.hasClass 不再是 function）
   *      ⇒ 脚本抛 e.hasClass is not a function ⇒ 目录 0 章（tocError）。
   * 修法：元素包装内部持有的 __desc（含 nid/outerHTML/innerHTML/text/attrs，均可克隆）直接回宿主，
   * 宿主用 worker 自己那份 JsoupDom 按 nid 重建活元素 ⇒ 身份不丢，worker 里 attr(k,v) 的写入
   * 宿主后续阶段读得到。宿主端重建见 selector/js.ts 的 rehydrateWorkerJsoup。
   * 注意：本函数体位于 String.raw 模板串内 —— 注释里不能出现反引号与美元花括号。
   */
  if (v && typeof v === 'object' && v.__desc && typeof v.__desc.outerHTML === 'string') return v.__desc;
  if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].__desc) {
    var descs = [];
    for (var i0 = 0; i0 < v.length; i0++) {
      var it = v[i0];
      descs.push(it && typeof it === 'object' && it.__desc ? it.__desc : it);
    }
    return descs;
  }
  /* [#532] JStringImpl 跨 structuredClone 只留 own 属性 {text}、丢原型 ⇒
     宿主拿到纯对象后 String(obj) 变 [object Object]（七猫 3.9.61 正文
     decode() 的 String(doFinal(...)) 就踩在这里）。提前还成纯字符串。
     注意：不能用 instanceof __JStringImpl（它在 __PACKAGES_NS 的 IIFE 内，
     全局不可见 ⇒ ReferenceError）。改用原型上的非枚举标记 __isJString 做鸭子判断。 */
  if (v && typeof v === 'object' && v.__isJString === true && typeof v.text === 'string') return v.text;
  /**
   * 类BZ（2026-10-26）：脚本返回 java.util 集合（new Packages.java.util.ArrayList()）
   * 必须展开成数组 —— 上游 AnalyzeRule.kt:478 的 is List 分支就是这么做的
   * （Rhino 里 ArrayList 本来就是 java.util.List，逐项成为元素）。
   * 不展开的后果：整个列表塌成 1 个对象，getElements 只回 1 条
   * （实测 海棠搜书 每页 100 章 变成 1 章、全站目录 0 章）。
   * 判据用鸭子类型，与宿主的 expandJavaCollection 同一套（实例方法跨 context 不可 instanceof）。
   * 但必须先排除两类也带 toArray/size 的非集合值（宿主侧同一处注释有完整实测）：
   *   - 字符串人格（Object.prototype.toString.call 为 [object String]）；
   *   - jsoup 元素桥（nodeType 是数字）。
   * 误展开会让字符串人格失效，纯文本正文变成整页 outerHTML。
   * 注意：本函数体位于模板串内 —— 注释里不能出现反引号与美元花括号。
   */
  if (
    Object.prototype.toString.call(v) !== '[object String]' &&
    typeof v.nodeType !== 'number' &&
    typeof v.toArray === 'function' &&
    typeof v.size === 'function'
  ) {
    try {
      var __yueduArr = v.toArray();
      /**
       * #672 **展开后还要逐项再转一次**，否则整表在 postMessage 处炸。
       *
       * 缺陷形态（用户 2026-10-29，63书阁 目录 0 章）：脚本返回
       * new Packages.java.util.ArrayList()，里面装的是 mkList 造的 jsoup 元素包装
       * （方法都是可枚举函数属性 ⇒ 不可 structuredClone）。
       * 旧实现只 return __yueduArr，**跳过了上面那段 __desc 描述符化** ⇒
       * postMessage 抛 DataCloneError，而 errors 通道把 message 丢空 ⇒
       * 宿主只看到 tocError = "Error: "（空消息），完全无从排查。
       * 修法：逐项走本函数（元素包装就走 __desc 分支）。
       * 注意：本函数体位于模板串内 —— 注释里不能出现反引号与美元花括号。
       */
      if (Array.isArray(__yueduArr)) {
        var __yueduOut = [];
        for (var i2 = 0; i2 < __yueduArr.length; i2++) __yueduOut.push(__yueduSendable(__yueduArr[i2]));
        return __yueduOut;
      }
    } catch (e3) { /* 非集合语义的 toArray 则不展开 */ }
  }
  try {
    structuredClone(v);
    return v;
  } catch (e) {
    try { return String(v); } catch (e2) { return ''; }
  }
}

/**
 * '#480-b' 批量入口：一条消息带 N 个作业 ⇒ **只有一次消息往返**（原先 N 次）。
 *
 * 为什么值得做：实测（1310 章 × 每章 2 次 JS）单次 eval 的**固定开销约 0.65ms**，
 * 而脚本本身只占其中极小一部分 —— 加池大小（4→8/16）完全没用（1.80s→1.65s），
 * 因为卡的是「消息条数 × 主线程收发」，不是并行度。合成批后条数降到 1/N。
 */
async function handleBatch(msg) {
  var values = [];
  for (var i = 0; i < msg.jobs.length; i++) {
    CUR_JOB = i; // RPC 回宿主时要能找到是哪个作业发起的
    try {
      values.push(await runEval({ id: msg.id, ...msg.jobs[i] }));
    } catch (e) {
      values.push({ ok: false, error: String(e && e.message ? e.message : e) });
    } finally {
      flushBitmapOps(); // #537 ②：作业收尾前把同帧绘制落地（CUR_JOB 仍是本作业）
    }
  }
  CUR_JOB = 0;
  parentPort.postMessage({ id: msg.id, ok: true, batch: true, values });
}

async function handle(msg) {
  CUR_JOB = 0;
  let r;
  try { r = await runEval(msg); } finally { flushBitmapOps(); } // #537 ②：收尾落地同帧绘制
  parentPort.postMessage({ id: msg.id, ok: r.ok, ...(r.ok ? { value: r.value } : { error: r.error }) });
}

/** 跑**一个**作业（不发包）：返回 '{ok:true,value}' | '{ok:false,error}'，供单发与批量共用 */
async function runEval(msg, retried) {
  const { code, bindings = {}, hoistFns = [], hoistVars = [] } = msg;
  var __wt = __yueduWTOn() ? { t0: performance.now(), last: performance.now(), seg: {} } : null;
  /**
   * #624 / #611 step3：**求值 realm 与作用域模式**（宿主按开关下发，见 JsSandboxPool.eval）。
   *  · realm：vm context（process/require/Buffer 对脚本不可见）/ worker 全局（旧行为）；
   *  · chain：jsLib 进独立作用域（上游 ScriptBindings.chainTo）/ 拼进 code（旧行为）。
   * 两种开关独立 ⇒ 四种组合，出问题可按开关二分归因。
   */
  var realm = msg.vm === true ? __yueduVmRealm() : null;
  var realmGlobal = realm ? realm.global : globalThis;
  var useChain = msg.chain === true && typeof msg.lib === 'string' && msg.lib.length > 0;
  // 规则桥预置内容（见 core selector/types.ts 的 RULE_CONTENT_KEY 注释）：
  // 上游 java.getElements() 无 mContent 读 AnalyzeRule 实例当前 content；
  // 宿主把当前 content 挂在 __yueduRuleContent 里随 bindings 送来 —— 在这里弹出，
  // 既是 ruleState.content 的初始值，也避免它泄漏成脚本可见的全局。
  var __ruleContentPreset = typeof bindings.__yueduRuleContent === 'string' ? bindings.__yueduRuleContent : '';
  // 内置名清单由宿主下发（与宿主 BUILTIN_GLOBAL_NAMES 单一来源，防两处漂移）；
  // 快照取自**求值 realm** 的全局（vm 模式下内置是 context 自己那份，与脚本同世界）。
  var natives = __yueduNatives(bindings.__yueduNativeNames, realmGlobal);
  __yueduWTMark(__wt, 'natives');
  if (bindings.__yueduNativeNames !== undefined) delete bindings.__yueduNativeNames;
  if (bindings.__yueduRuleContent !== undefined) delete bindings.__yueduRuleContent;
  // 每次调用独立的变量内存（put 后同脚本内 get 可见）
  // ⚠️ cache / cookie **不在这里**：两者都必须跨调用及跨请求存活（详见下面两个代理的注释），
  //    一律经 RPC 回宿主（cookie 曾经是本地 Map ⇒ setCookie 静默 no-op，见类CA）。
  const localVars = new Map();
  /**
   * 'java.setContent(html)' 的**本次求值内状态**（规则桥缺省内容）。
   *
   * 与 L1 的 'AnalyzeRule.mContent' 同语义：只在这一次 eval 内有效、不跨请求。
   * 源里的典型写法是
   *   'java.setContent(cache.get('x')); java.getElements('$.data[*]')'
   * —— 第二步不带 mContent，必须能读到第一步设的内容（否则目录恒 0 章，见 #108）。
   */
  const ruleState = { content: __ruleContentPreset };
  // ⚠️ 用模块加载期捕获的 __yueduHostProxy 而不是裸 Proxy：java 桩是宿主基础设施，
  // 不能因为上一条求值污染了求值全局的 Proxy（var Proxy = "1,2,3"）就构造失败
  // （失败 = 整个 worker 报废，测试 780 在 YUEDU_JS_VM=0 下当场抓获）。
  const java = new __yueduHostProxy(
    {
      log: (...a) => console.log('[sandbox-js]', ...a),
      // java.toast / java.longToast → 宿主（引擎侧收集后回传前端）
      // 用**同步** rpc 而不是 rpcNoWait：把消息交到宿主是让调用方拿到 toast 的前提，
      // 而 rpcNoWait 是「发完就走」，宿主处理发生在下一个事件循环 tick ——
      // 若引擎已返回、宿主已把结果发走，尾部 toast 就丢了（这正是旧实现的缺陷形状）。
      // 空文本在 worker 内挡掉（源脚本常 toast 一个可能为空的变量）：省一次 RPC 往返。
      toast: (m) => { var s = String(m == null ? '' : m).trim(); if (s) rpc('toast', { msg: s, long: false }); return ''; },
      longToast: (m) => { var s = String(m == null ? '' : m).trim(); if (s) rpc('toast', { msg: s, long: true }); return ''; },
      base64Encode: (s) => Buffer.from(String(s), 'utf-8').toString('base64'),
      base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf-8'),
      md5Encode: (s) => createHash('md5').update(String(s)).digest('hex'),
      // #361：与 L1（selector/js.ts 的 java 桩）**同一语义** —— 上游 MD5Utils.md5Encode16
      // = md5Encode(str).substring(8, 24)。两处需同步维护（worker 源码在 String.raw 模板内，不能 import）。
      md5Encode16: (s) => createHash('md5').update(String(s)).digest('hex').slice(8, 24),
      sha1Encode: (s) => createHash('sha1').update(String(s)).digest('hex'),
      string: (s) => String(s),
      put: (k, v) => {
        // 本脚本内可见 + 回流宿主（= L1 的 java.put：写本地并持久化到按源变量）
        localVars.set(String(k), String(v));
        try { rpc('javaVarPut', { k: String(k), v: String(v) }); } catch (e) { /* 宿主不可达：本脚本内仍可见 */ }
        return v;
      },
      get: (...a) => {
        // 双语义：java.get(url, headers) → HTTP；java.get(key) → 取变量（对齐宿主）
        // #387c：HTTP 分支不跟随重定向（上游 java.get = followRedirects(false)）
        if (a.length >= 2 || /^https?:\/\//i.test(String(a[0] ?? ''))) return httpRpcSpec(a[0], { headers: a[1], noRedirect: true });
        var k = String(a[0]);
        var local = localVars.get(k);
        if (local !== undefined && local !== '') return local;
        // 回落到宿主变量表 / 按源持久变量（跨阶段可读）——不回落则 worker 路由的规则读不到
        // 上一阶段 java.put 的键（如七猫系 headers），表现为「请求不带签名字段」的静默失败
        try { return rpc('javaVarGet', { k: k }) || ''; } catch (e) { return ''; }
      },
      /**
       * 'java.setContent / getElements / getElement / getStringList' —— **规则桥**（#108）。
       *
       * 旧实现在 worker 里**这四个方法都不存在** ⇒ 落到 java Proxy 的「未实现 → 返回空串」兜底 ⇒
       * 静默失效（用户可见症状：🎨快看漫画「详情通了但目录 0 章」）。当时的对策是
       * 'JAVA_RULE_API_RE' 把用这四个 API 的脚本**强制留 L1**，代价是其中 18 个同时用
       * 'java.ajax' 的源也跟着回 L1 —— 而 L1 的 java.ajax 用 execFileSync **同步阻塞进程**。
       *
       * 现在改成与 '__yueduJsoup' 同一模式：**求值仍回宿主**（那边才有 jsdom 与 AnalyzeRule），
       * 返回值是可序列化描述符，再用 'mkList' 在 worker 内重建出「带 jsoup 方法的活列表」
       * ⇒ 脚本后续 '.select()/.attr()/.toArray()' 照常可用（只回一次性快照会让 '.select()' 失效，
       * 那是另一种静默失败）。
       */
      setContent: (content) => {
        ruleState.content = content == null ? '' : String(content);
        return content;
      },
      getStringList: (rule, mContent) => {
        var c = mContent === undefined || mContent === null ? ruleState.content : String(mContent);
        return rpc('rule', { op: 'strings', rule: String(rule == null ? '' : rule), content: String(c) }) || [];
      },
      getElements: (rule, mContent) => {
        var c = mContent === undefined || mContent === null ? ruleState.content : String(mContent);
        var r = rpc('rule', { op: 'elements', rule: String(rule == null ? '' : rule), content: String(c) });
        /**
         * [#406] 宿主判定为「Json 段的纯值列表」（点路径通配，如 data 数组）⇒ **原样给回 JSON 数组**，
         * 不再套 jsoup 元素包装。原因（实测 🎨快看漫画：同一份源 L1=176 章、worker=0 章）：
         *   ① 包装的字段是 outerHTML = JSON.stringify(x) ⇒ 脚本/引擎取不到 title 字段；
         *   ② 包装元素带**可枚举函数**（html/text/attr/select…）⇒ structuredClone 失败
         *      ⇒ __yueduSendable 退化成 String(v) ⇒ 整表被 join 成 1 个字符串。
         * 与 L1 的 java.getElements 语义一致：JSON 列表给的就是 JSON 值本身。
         * 方法挂载走 __yueduAttachJsonMap（非枚举 ⇒ 可克隆），与 java.getElement 的纯值分支同路。
         * ⚠️ 本注释位于模板串内：禁反引号。
         */
        if (r && r.kind === 'values') return __yueduAttachJsonMap(r.list || []);
        var list = r || [];
        return __JSOUP_NS.list(list, null, '');
      },
      getElement: (rule, mContent) => {
        var c = mContent === undefined || mContent === null ? ruleState.content : String(mContent);
        /**
         * [#313] 对齐上游 'AnalyzeRule.getElement'（AnalyzeRule.kt:384-414）的**两种**返回值 ——
         *   · Css/XPath  -> 'getElements(rule)' = 整个 Elements 列表（重建活列表）；
         *   · Json       -> 'getObject(rule)'   = **原值**（对象/标量/数组都算命中）；
         *   · Regex/Js   -> 单值。
         * 旧实现一律发 op='elements'（= 'getList'，只认数组）⇒ ① 'java.getElement("$.某对象")'
         * 静默为空；② 即使命中数组也被包成「元素列表」，'java.getElement("$.data").field' 取不到字段。
         * ⚠️ 所以**不能**再用 'Array.from(java.getElement(...))' 那句老注释当依据 —— 上游
         * 只有 Css/XPath 分支才是列表。
         * ⚠️ 本注释位于**模板串**内：禁反引号（写它会提前闭合模板串，且只报 Invalid character）。
         */
        var r = rpc('rule', { op: 'object', rule: String(rule == null ? '' : rule), content: String(c) });
        if (r && r.kind === 'nodes') return __JSOUP_NS.list(r.list, null, '');
        // JSON 单值：挂 Java Map/List 方法（与宿主 attachJsonMapMethods **同一份注入源码**）——
        // 上游 Json 分支给脚本的是 fastjson 的 JSONArray/JSONObject，脚本会写 .size() / .get(k)；
        // 而 Map 方法是非枚举的、过不了 structuredClone，所以两侧各自挂一次。
        if (r && r.kind === 'value') return __yueduAttachJsonMap(r.value);
        return null;
      },
      // ⚠️ ajax / connect / post 的**唯一实现**在下方的 http 段（约 800-830 行）——
      //   本桩此前这里还有一份同名键，被后者静默覆盖 ⇒ 「改一处不生效」（已删，勿再加回来）。
      //   （本段在 String.raw 模板内：注释里不能出现反引号，否则模板被截断 —— 刚踩过一次）
      // webView / startBrowserAwait：回宿主 render 通道（有 WebViewProvider 时真渲染，否则静态抓取）。
      // #374 空地址守卫：站点无播放数据时 url_next 是空串（实测 🎬茶杯狐狸），
      // 空地址进 render 通道会白等整个渲染超时（15s/次）⇒ 立即给空响应。
      webView: (htmlOrUrl, url, js) => {
        var a = htmlOrUrl == null ? '' : String(htmlOrUrl);
        var b = url == null ? '' : String(url);
        var c = js == null ? '' : String(js);
        if (!b && !c) {
          var u = a.trim();
          if (!u) return strResponse('', {}, 0, { url: '', method: 'GET', body: '', headers: {} });
          var r0 = rpc('render', { url: u, kind: 'cookie' });
          return strResponse(r0.body, r0.headers || {}, r0.code || 0, { url: u, method: 'GET', body: '', headers: {} });
        }
        /**
         * #676 三参形态（上游 JsExtensions.kt:279-304）：把 html 当文档、url 当 origin、跑 js 取返回值。
         * 宿主那条是异步 CDP，这里靠 rpc 的同步等待（Atomics.wait）保持脚本的同步语义。
         */
        var rr = rpc('renderHtmlJs', { html: a, base: b, js: c });
        return rr && typeof rr.text === 'string' ? rr.text : String((rr && rr.body) || '');
      },
      startBrowserAwait: (url) => { const u = String(url ?? '').trim(); if (!u) return strResponse('', {}, 0, { url: '', method: 'GET', body: '', headers: {} }); const r = rpc('render', { url: u, kind: 'cookie' }); return strResponse(r.body, r.headers || {}, r.code || 0, { url: u, method: 'GET', body: '', headers: {} }); },
      // Legado startBrowser 是 fire-and-forget（startActivity 后立即返回，不等待页面）——
      // 必须用 rpcNoWait：用同步 rpc 去等渲染会把 10s JS 预算吃光（实测麻豆传媒AI 正文）。
      // #393：kind='show' —— 上游 startBrowser 是 fire-and-forget「打开给人看」（前端用应用内浏览器）
      startBrowser: (url) => { rpcNoWait('browser', { url: String(url), kind: 'show' }); return ''; },
      /**
       * #582 java.showBrowser(url, html)：把一段 HTML 交给浏览器（七猫评论面板 jsLib 自绘）。
       * 与宿主 selector/js.ts 同语义：html 转 data URL，http base 补 <base href>，kind='show'。
       * ⚠️ 本段位于模板串内：禁止反引号。
       */
      showBrowser: (url, html) => {
        var u = String(url == null ? '' : url).trim();
        var h = html == null ? '' : String(html);
        if (h.trim()) {
          if (/^https?:\/\//i.test(u) && !/<base\s/i.test(h)) h = '<base href="' + u.replace(/"/g, '&quot;') + '">' + h;
          u = 'data:text/html;base64,' + Buffer.from(h, 'utf8').toString('base64');
        }
        if (u) rpcNoWait('browser', { url: u, kind: 'show' });
        return '';
      },
      /**
       * Legado java.openUrl(url, mimeType?)（JsExtensions.kt:1239-1269）：
       * 交给系统打开（legado://import/addToBookshelf 一键加书架、lofter:// 深链、http 浏览器）。
       * 与宿主 selector/js.ts 同语义：超长抛错；UI 不可用静默返回（源普遍 try/catch 改文案）；
       * 返回 Unit → 给空串。走 rpcNoWait 的 browser 通道（fire-and-forget，不占 JS 预算）。
       * ⚠️ 本段位于模板串内：禁止反引号。
       */
      openUrl: (url, mimeType) => {
        var u = String(url == null ? '' : url);
        if (u.length >= 65536) throw new Error('java.openUrl: parameter url too long');
        if (u) rpcNoWait('browser', { url: u, kind: 'show' });
        return '';
      },
      // java.webViewGetSource(html?, url?, js?, sourceRegex)（JsExtensions.kt:261-289）
      // → 宿主 renderSource 通道：渲染 + js 注入（CDP 层）+ sourceRegex 取资源 URL
      webViewGetSource: (html, url, js, sourceRegex) => {
        const r = rpc('renderSource', {
          html: html == null ? '' : String(html),
          url: url == null ? '' : String(url),
          js: js == null ? '' : String(js),
          sourceRegex: sourceRegex == null ? '' : String(sourceRegex),
        });
        return strResponse(r.body, r.headers || {}, r.code || 0, { url: String(url ?? ''), method: 'GET', body: '', headers: {} });
      },
      /**
       * java.getString(ruleStr, mContent?)：回宿主按规则引擎求值（宿主侧同步、无网络）。
       * #341：mContent 与 L1 同语义 —— null/undefined =「未传」⇒ 用当前 bindings.$
       * （上游 AnalyzeRule.kt:322 的 mContent ?: this.content）；显式传非 null 内容才覆盖。
       * 此前签名只有单参，源脚本 java.getString(rule, content) 的 content 在 worker 被静默丢弃。
       *
       * #657 **纯 $.x 取值在 worker 内算，不回宿主**（目录求值的最大头）。
       *
       * 实测 qimao 聚合 MD3（1652 章）：[toc] 33.10s · worker · worker=3302（每章 2 次求值、
       * 每次 1~3 次 java.getString('$.xxx')）⇒ 6600+ 次 Atomics.wait 往返；而 worker 侧的
       * 计算本身只占 2.6s，其余全在**等宿主回信**（宿主同时还在跑别的请求/求值）。
       * 取一条 JSON 字段不需要宿主的 DOM/正则/JS 引擎 —— 这里就地算，语义与 jsonGetString
       * 一致（只接受**最朴素**的 $.a.b[0] 形态，其余一律照旧回宿主，绝不猜）。
       */
      getString: (ruleStr, mContent) => {
        var ruleTxt = String(ruleStr == null ? '' : ruleStr);
        var val = mContent != null ? mContent : (bindings && bindings.$ !== undefined ? bindings.$ : null);
        var got = __yueduJsonPathGetLocal(val, ruleTxt);
        if (got !== undefined) return got;
        return rpc('evalRule', { rule: ruleTxt, value: val });
      },
      // —— 对称加密：与 L1 createSymmetricCrypto 全对齐（encrypt/decrypt 返回字节数组、
      //    ByteArray key、nopadding、decryptStr 自动 hex/base64）——此前缺 encrypt/decrypt，
      //    Proxy 兜底返回 '' → 源 header JS（java.createSymmetricCrypto(...).encrypt(body)）
      //    产出空密文，站点返回错误页（点众阅读 71 字节）——worker 池改坏 JS 构造请求的根源。
      createSymmetricCrypto: __yueduSymCrypto,
      randomUUID: () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2)),
      base64DecodeToByteArray: (s) => new Uint8Array(Buffer.from(String(s ?? ''), 'base64')),
      /**
       * #400 与 L1 js.ts 的 hexStrict **同一语义**（曾漂移：此处 try/catch 静默返回空串，
       * L1 抛错）。上游 JsExtensions.kt:721 → Hutool HexUtil.decodeHexStr → Base16Codec.toDigit
       * **对非法 hex 字符抛 UtilException**，对空串原样返回、奇数长度前补 0。
       * 静默返回空串会让源脚本拿空值继续拼 URL（排查成本极高的静默错值）⇒ 这里改成抛错。
       * 本段在 String.raw 模板内 —— 注释禁反引号；正则里的反斜杠按模板原样保留。
       */
      hexDecodeToString: (s) => {
        var t = String(s == null ? '' : s).replace(/\s+/g, '');
        if (!t) return '';
        if (t.length % 2) t = '0' + t;
        if (!/^[0-9a-fA-F]+$/.test(t)) {
          var i = t.search(/[^0-9a-fA-F]/);
          throw new Error('Illegal hexadecimal character ' + JSON.stringify(t.charAt(i)) + ' at index ' + i);
        }
        return Buffer.from(t, 'hex').toString('utf-8');
      },
      hexEncodeToString: (s) => Buffer.from(String(s ?? ''), 'utf-8').toString('hex'),
      digestBase64Str: (data, algorithm) => {
        try { return createHash(digestAlgoName(algorithm)).update(String(data ?? ''), 'utf-8').digest('base64'); }
        catch { return ''; }
      },
      HMacHex: (data, algorithm, key) => {
        try { return createHmac(digestAlgoName(algorithm), toKeyBytes(key)).update(String(data ?? ''), 'utf-8').digest('hex'); }
        catch { return ''; }
      },
      HMacBase64: (data, algorithm, key) => {
        try { return createHmac(digestAlgoName(algorithm), toKeyBytes(key)).update(String(data ?? ''), 'utf-8').digest('base64'); }
        catch { return ''; }
      },
      encodeURI: (s) => encodeURIComponent(String(s)),
      decodeURI: (s) => { try { return decodeURIComponent(String(s)); } catch { return String(s); } },
      // 类CA（2026-10-26）java.urlEncode / java.urlDecode：上游 JsExtensions.kt 无这两个
      // （本仓自有扩展），但语料里有源写成 try{java.urlEncode(s)}catch{encodeURIComponent(s)}。
      // Proxy 兜底是返回空串（不抛）=> 不补就静默把搜索词变空（实测 笔趣阁·恋爱呀 q= 空）。
      // 语义与 encodeURI 同源（percent-encoding / UTF-8）。注释在模板串内：禁反引号。
      urlEncode: (s) => encodeURIComponent(String(s == null ? '' : s)),
      urlDecode: (s) => { try { return decodeURIComponent(String(s == null ? '' : s)); } catch { return String(s == null ? '' : s); } },
      getWebViewUA: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      /**
       * Legado JsEncodeUtils.kt:188-192 = createSymmetricCrypto(transformation, key, iv).decryptStr(str)。
       *
       * ⚠️ 此前这里是**另一份手写实现**（自己拼 alg-bits-mode、固定按 base64 解），与
       * L1 的 createSymmetricCrypto 委托版**漂移**，于是两件事同时坏掉：
       *   · 不支持 DES/DESede（算法名拼成 des-64-cbc → OpenSSL 报不支持 → 被 catch 吞成 空串）；
       *   · 固定按 base64 解，传 hex 密文的源解不出来。
       * 实测（宜搜小说正文用 java.aesBase64DecodeToString(...,"DES/CBC/PKCS5Padding",...)）：
       * L1 路径能出正文、worker 路径**恒空** —— 就是这份漂移。
       * 现在与 L1 完全一致：委托 createSymmetricCrypto，用 hutool 语义的 decryptStr（全 hex 按 hex、否则 base64）。
       *
       * 本段在 String.raw 模板内 —— 注释里不能出现反引号（否则模板被截断）。
       */
      aesBase64DecodeToString: (data, key, transformation, iv) => {
        try {
          const c = __yueduSymCrypto(String(transformation), key, iv === undefined || iv === null ? undefined : String(iv));
          return c.decryptStr(String(data));
        } catch { return ''; }
      },
      /**
       * #540 aes/des 旧 API 家族补全（上游 JsEncodeUtils.kt deprecated 组，「web 需要调用」）。
       * 与 L1（selector/js.ts 同批）逐条同面：全部委托 __yueduSymCrypto，不另写加解密。
       * 重探 733 源：11 源在调；阅文的 tripleDESEncodeBase64Str 是 #538 okhttp3 闭链一环。
       * ArgsBase64 变体的 key/iv 先 base64 解成字节再进工厂。本段禁反引号（String.raw 模板内）。
       */
      aesDecodeToByteArray: (str, key, transformation, iv) => {
        try { return new Uint8Array(__yueduSymCrypto(String(transformation), key, symIv(iv)).decrypt(String(str))); }
        catch { return new Uint8Array(0); }
      },
      aesDecodeToString: (str, key, transformation, iv) => {
        try { return __yueduSymCrypto(String(transformation), key, symIv(iv)).decryptStr(String(str)); } catch { return ''; }
      },
      aesDecodeArgsBase64Str: (data, key, mode, padding, iv) => {
        try {
          return __yueduSymCrypto('AES/' + String(mode) + '/' + String(padding), b64Bytes(key), b64Bytes(iv)).decryptStr(String(data));
        } catch { return ''; }
      },
      aesBase64DecodeToByteArray: (str, key, transformation, iv) => {
        try { return new Uint8Array(__yueduSymCrypto(String(transformation), key, symIv(iv)).decrypt(String(str))); }
        catch { return new Uint8Array(0); }
      },
      desDecodeToString: (data, key, transformation, iv) => {
        try { return __yueduSymCrypto(String(transformation), key, symIv(iv)).decryptStr(String(data)); } catch { return ''; }
      },
      desBase64DecodeToString: (data, key, transformation, iv) => {
        try { return __yueduSymCrypto(String(transformation), key, symIv(iv)).decryptStr(String(data)); } catch { return ''; }
      },
      tripleDESDecodeStr: (data, key, mode, padding, iv) => {
        try {
          return __yueduSymCrypto('DESede/' + String(mode) + '/' + String(padding), key, symIv(iv)).decryptStr(String(data));
        } catch { return ''; }
      },
      tripleDESDecodeArgsBase64Str: (data, key, mode, padding, iv) => {
        try {
          return __yueduSymCrypto('DESede/' + String(mode) + '/' + String(padding), b64Bytes(key), b64Bytes(iv)).decryptStr(String(data));
        } catch { return ''; }
      },
      aesEncodeToByteArray: (data, key, transformation, iv) => {
        try { return new Uint8Array(__yueduSymCrypto(String(transformation), key, symIv(iv)).encrypt(String(data))); }
        catch { return new Uint8Array(0); }
      },
      aesEncodeToString: (data, key, transformation, iv) => {
        try { return String(__yueduSymCrypto(String(transformation), key, symIv(iv)).encrypt(String(data))); } catch { return ''; }
      },
      aesEncodeToBase64ByteArray: (data, key, transformation, iv) => {
        try { return new Uint8Array(Buffer.from(__yueduSymCrypto(String(transformation), key, symIv(iv)).encryptBase64(String(data)), 'base64')); }
        catch { return new Uint8Array(0); }
      },
      aesEncodeToBase64String: (data, key, transformation, iv) => {
        try { return __yueduSymCrypto(String(transformation), key, symIv(iv)).encryptBase64(String(data)); } catch { return ''; }
      },
      aesEncodeArgsBase64Str: (data, key, mode, padding, iv) => {
        try {
          return __yueduSymCrypto('AES/' + String(mode) + '/' + String(padding), b64Bytes(key), b64Bytes(iv)).encryptBase64(String(data));
        } catch { return ''; }
      },
      desEncodeToString: (data, key, transformation, iv) => {
        try { return String(__yueduSymCrypto(String(transformation), key, symIv(iv)).encrypt(String(data))); } catch { return ''; }
      },
      desEncodeToBase64String: (data, key, transformation, iv) => {
        try { return __yueduSymCrypto(String(transformation), key, symIv(iv)).encryptBase64(String(data)); } catch { return ''; }
      },
      tripleDESEncodeBase64Str: (data, key, mode, padding, iv) => {
        try {
          return __yueduSymCrypto('DESede/' + String(mode) + '/' + String(padding), key, symIv(iv)).encryptBase64(String(data));
        } catch { return ''; }
      },
      tripleDESEncodeArgsBase64Str: (data, key, mode, padding, iv) => {
        try {
          return __yueduSymCrypto('DESede/' + String(mode) + '/' + String(padding), b64Bytes(key), b64Bytes(iv)).encryptBase64(String(data));
        } catch { return ''; }
      },
      /**
       * #540 htmlFormat（上游 JsExtensions.kt:770 = HtmlFormatter.formatKeepImg）。
       * 走 convert 通道回宿主（与 t2s/s2t 同一条）⇒ formatText 正则链只有宿主一份，不漂移。
       * 重探 733 源：6 源在用（红牛/U酷/pixiv 系）。
       */
      htmlFormat: (html) => rpc('convert', { dir: 'htmlFormat', text: String(html == null ? '' : html) }),
      /**
       * #540 createAsymmetricCrypto（上游 JsEncodeUtils.kt:80 + help/crypto/AsymmetricCrypto.kt）。
       * 与 L1（selector/js.ts 同批）逐条同面：setPrivateKey/setPublicKey 链式 + decrypt/decryptStr/
       * encrypt/encryptBase64/encryptHex，usePublicKey 默认 true（照抄 hutool 怪默认）。
       * 密钥 = hutool KeyUtil 口径（PKCS8 私 / SPKI 公；PKCS1 自动包一层）。重探 3 源在用。
       * 本段在 String.raw 模板内 —— 注释禁反引号。
       */
      createAsymmetricCrypto: (transformation) => {
        var parts = String(transformation == null ? '' : transformation).split('/');
        var alg = (parts[0] || 'RSA').toUpperCase();
        if (alg !== 'RSA') throw new Error('createAsymmetricCrypto: 仅支持 RSA（上游 hutool 同限），当前 ' + alg);
        var padName = (parts[2] || 'PKCS1Padding').toUpperCase();
        var padding = padName.indexOf('OAEP') >= 0 ? 4 : padName.indexOf('NOPADDING') >= 0 ? 3 : 1; // 1=PKCS1 3=NO 4=OAEP
        var priv = null, pub = null;
        function toBuf(v) {
          if (v instanceof Uint8Array) return Buffer.from(v);
          if (Buffer.isBuffer(v)) return v;
          return Buffer.from(String(v == null ? '' : v), 'utf-8');
        }
        var self = {
          setPrivateKey: function (k) {
            var der = toBuf(k);
            try { priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }); }
            catch (e) { priv = createPrivateKey({ key: wrapPkcs1Private(der), format: 'der', type: 'pkcs8' }); }
            return self;
          },
          setPublicKey: function (k) {
            var der = toBuf(k);
            try { pub = createPublicKey({ key: der, format: 'der', type: 'spki' }); }
            catch (e) { pub = createPublicKey({ key: wrapPkcs1Public(der), format: 'der', type: 'pkcs8' }); }
            return self;
          },
          decrypt: function (data, usePublicKey) {
            var buf = toBuf(data);
            if (usePublicKey === false || usePublicKey === 'false') {
              if (!priv) throw new Error('createAsymmetricCrypto: usePublicKey=false 但未 setPrivateKey');
              return new Uint8Array(privateDecrypt(priv, buf, { padding }));
            }
            if (!pub) throw new Error('createAsymmetricCrypto: usePublicKey=true 但未 setPublicKey');
            return new Uint8Array(publicDecrypt(pub, buf, { padding }));
          },
          decryptStr: function (data, usePublicKey) {
            return Buffer.from(self.decrypt(data, usePublicKey)).toString('utf-8');
          },
          encrypt: function (data, usePublicKey) {
            var buf = toBuf(data);
            if (usePublicKey === false || usePublicKey === 'false') {
              if (!priv) throw new Error('createAsymmetricCrypto: usePublicKey=false 但未 setPrivateKey');
              return new Uint8Array(privateEncrypt(priv, buf, { padding }));
            }
            if (!pub) throw new Error('createAsymmetricCrypto: usePublicKey=true 但未 setPublicKey');
            return new Uint8Array(publicEncrypt(pub, buf, { padding }));
          },
          encryptBase64: function (data, usePublicKey) {
            return Buffer.from(self.encrypt(data, usePublicKey)).toString('base64');
          },
          encryptHex: function (data, usePublicKey) {
            return Buffer.from(self.encrypt(data, usePublicKey)).toString('hex');
          },
        };
        return self;
      },
      androidId: () => '0000000000000000',
      timeFormat: (t, fmt) => timeFmt(Number(t), typeof fmt === 'string' ? fmt : 'yyyy/MM/dd HH:mm'),
      timeFormatUTC: (t, fmt, sh) => timeFmt(Number(t) + Number(sh ?? 0) * 3600000, typeof fmt === 'string' ? fmt : 'yyyy-MM-dd'),
      // —— 简繁/源 cookie：回宿主（opencc 字典/源级 CookieStore 在宿主侧）——
      t2s: (t) => rpc('convert', { dir: 't2s', text: String(t ?? '') }),
      s2t: (t) => rpc('convert', { dir: 's2t', text: String(t ?? '') }),
      getCookie: (tag, key) => rpc('getCookie', { key: key === undefined ? null : String(key) }),
      // —— [#411] 脚本文件 API（Legado JsExtensions.kt:455-493 / :826-851）——
      // 与 L1（selector/js.ts 的 makeScriptFileApi + selector/js-file.ts 的共享判据）同语义：
      //   命中文件层即返回；importScript 的 http 分支下载并缓存、非 http 分支读本地；
      //   **内容空即抛**（宿主侧 importScriptEnsure 抛，经 rpc 的 error 通道回到本线程）。
      // 传输由宿主异步执行（= java.ajax 的同一出口 hostRpc('http')），本线程用 SAB 同步等待。
      // 注意：本注释位于模板串内，禁反引号与美元花括号。
      cacheFile: (urlStr, saveTime) => rpc('cacheFile', { url: String(urlStr == null ? '' : urlStr), saveTime: Number(saveTime || 0) }),
      readTxtFile: (path) => rpc('readTxtFile', { path: String(path == null ? '' : path) }),
      deleteFile: (path) => rpc('deleteFile', { path: String(path == null ? '' : path) }),
      importScript: (path) => rpc('importScript', { path: String(path == null ? '' : path) }),
      /**
       * Legado java.downloadFile(hexContent, url) / downloadFile(url)（#604）：
       * 内容可以是十六进制或 data: URI；返回 <md5Encode16(url)>.<type> 形式的相对路径。
       * 判据全在宿主（与 L1 同一份 js-file.ts），这里只搬运参数。
       * 单参形态把 url 放在 url 位（宿主据此判断是「下载」还是「内联 data:」）。
       * 本段位于模板串内：禁止反引号。
       */
      downloadFile: (content, url) =>
        typeof url === 'undefined' && !/^data:/i.test(String(content == null ? '' : content))
          ? rpc('downloadFile', { url: String(content == null ? '' : content) })
          : rpc('downloadFile', { content: content == null ? '' : String(content), url: String(url == null ? '' : url) }),
      /* #613 java 文件面（宿主实现，判据同源）：getFile 在 worker 里退化为绝对路径字符串
         （File 形态对象带方法，不可结构化克隆），readFile 返回 Uint8Array 或 null。 */
      getFile: (p) => rpc('getFile', { path: String(p == null ? '' : p) }),
      readFile: (p) => rpc('readFile', { path: String(p == null ? '' : p) }),
      getTxtInFolder: (p) => rpc('getTxtInFolder', { path: String(p == null ? '' : p) }),
      /* #614 字体反爬（宿主实现）：TTF 解析在宿主（core/font/ttf.ts），
         worker 只拿到句柄 {__ttfId}（与 getFile 退化成路径字符串同一手法）。
         字节用 structured clone 直传（Uint8Array 可克隆），不额外编码。 */
      queryTTF: (data, useCache) =>
        rpc('queryTTF', { data: data, useCache: useCache === undefined ? true : useCache }),
      queryBase64TTF: (data) => rpc('queryBase64TTF', { data: data }),
      replaceFont: (text, errTtf, corrTtf, filter) =>
        rpc('replaceFont', {
          text: String(text == null ? '' : text),
          errId: errTtf && errTtf.__ttfId ? errTtf.__ttfId : '',
          corrId: corrTtf && corrTtf.__ttfId ? corrTtf.__ttfId : '',
          filter: filter === true || filter === 'true' || filter === 1,
        }),
      /* #615 zip（宿主实现）：unzipFile 返回相对路径；getZip* 走宿主解码 */
      unzipFile: (p) => rpc('unzipFile', { path: String(p == null ? '' : p) }),
      unArchiveFile: (p) => rpc('unArchiveFile', { path: String(p == null ? '' : p) }),
      un7zFile: (p) => rpc('un7zFile', { path: String(p == null ? '' : p) }),
      unrarFile: (p) => rpc('unrarFile', { path: String(p == null ? '' : p) }),
      getZipStringContent: (u, p, c) => rpc('getZipStringContent', { url: String(u == null ? '' : u), path: String(p == null ? '' : p), charset: c == null ? '' : String(c) }),
      getZipByteArrayContent: (u, p) => rpc('getZipByteArrayContent', { url: String(u == null ? '' : u), path: String(p == null ? '' : p) }),
      // —— 摘要（node crypto 自足；算法名归一对齐 L1 digestAlgoName）——
      digestHex: (data, algorithm) => {
        try { return createHash(digestAlgoName(algorithm)).update(String(data ?? ''), 'utf-8').digest('hex'); }
        catch { return ''; }
      },
      // —— HEAD（上游 JsExtensions.kt:600-620：HEAD + followRedirects(false)，js 自己拦 3xx、不取 body）——
      //    与 L1 的 java.head 同一实现（httpRpcSpec 内含 AnalyzeUrl 语义的 URL/选项解析）
      head: (url, headers) => httpRpcSpec(url, { method: 'HEAD', headers: headers, noRedirect: true }),
      getStrResponse: (url, headers) => httpRpcSpec(url, { headers: headers }),
      /**
       * Legado java.ajaxTestAll(urlList, timeout, skipRateLimit?)（#604）：
       * 并发抓一组 URL 返回 StrResponse 数组。上游正式版有它，且兽人小说站/Linpx 用它做
       * 「是否 Sigma 版」的特性探测（typeof java.ajaxTestAll === function）。
       * worker 里逐个走 rpc 的 http 通道（宿主侧已对齐 60s 超时）；单项失败仍返回空响应项，
       * 保持数组下标语义与上游一致。
       * 本段位于模板串内：禁止反引号。
       */
      ajaxTestAll: (urlList, timeout) => {
        var list = Object.prototype.toString.call(urlList) === '[object Array]' ? urlList : [urlList];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var u = String(list[i] == null ? '' : list[i]);
          var one;
          try {
            one = rpc('http', { url: u });
            out.push(strResponse(one.body, one.headers || {}, one.code || 0, { url: u, method: 'GET', body: '', headers: {} }));
          } catch (e) {
            out.push(strResponse('', {}, 0, { url: u, method: 'GET', body: '', headers: {} }));
          }
        }
        return out;
      },
      // java.ajax/connect 一律经 httpRpcSpec（AnalyzeUrl 语义，**跟随**重定向 —— 与上游 AnalyzeUrl 一致）
      ajax: (url) => httpRpcSpec(url),
      connect: (url) => httpRpcSpec(url),
      // 上游 JsExtensions.kt:645 java.post = followRedirects(false)（#387c）
      post: (url, body, headers) => httpRpcSpec(url, { method: 'POST', body: body === undefined ? undefined : String(body), headers: headers, noRedirect: true }),
      // java.upLoginData(data)：脚本要求实时更新登录界面字段值（Legado SourceLoginJsExtensions.kt:35-37）。
      // 本线程无 UI，回宿主（宿主把它收成 map 随登录结果回传前端回填）——与 L1 走同一条 onUpLoginData。
      upLoginData: (data) => rpc('upLoginData', { data: data === undefined ? null : data }),
      /**
       * java.refreshBookInfo / refreshBookToc / refreshContent（上游 JsExtensions.kt:157-167）：
       * 上游只是 EventBus 发射（通知 App 重拉详情/目录/正文），返回 Unit、不抛。
       * 本线程无阅读界面 => 回宿主记录（rpcNoWait，不占同步预算），脚本侧保持调用即成功。
       * 本段在模板串内：注释里禁反引号。
       */
      refreshBookInfo: () => { rpcNoWait('refreshBook', { kind: 'info' }); return ''; },
      refreshBookToc: () => { rpcNoWait('refreshBook', { kind: 'toc' }); return ''; },
      refreshContent: () => { rpcNoWait('refreshBook', { kind: 'content' }); return ''; },
      // java.canOpenSourceUi()（上游是 private）：回宿主判据（缺省 false）。
      canOpenSourceUi: () => rpc('canOpenSourceUi', {}) === true,
      // java.getSource() / java.getTag()（上游 JsExtensions.kt:127-128）：
      // getSource 返回源对象；getTag = BookSource.getTag() = bookSourceName。
      // full 在本函数后面声明，但这两个方法只在求值期被调用（那时已初始化）。
      getSource: () => full.source,
      getTag: () => {
        var s = full.source;
        if (!s) return '';
        try {
          if (typeof s.getBookSourceName === 'function') {
            var n = s.getBookSourceName();
            if (n) return String(n);
          }
        } catch (e) { /* 源桩异常不致命 */ }
        return String(s.bookSourceName == null ? '' : s.bookSourceName);
      },
      /**
       * java.getVerificationCode(imageUrl)（上游 :442-449）：上游弹图片验证码框、阻塞等人输入。
       *
       * [#727] 本仓把这个「同步等人输入」做成 **有界同步 RPC**：worker 用 Atomics.wait 阻塞
       * 自己的线程（宿主等待期间暂停 JS 预算），宿主拉起/复用该源 Chromium、把画面推给桌面端
       * 内置窗口，用户输入后收回 Cookie 并把 code 回给脚本。超时/取消/关窗都由宿主 reject
       * ⇒ 这里的 rpc 原样抛错（不会永久阻塞）。
       * 本段位于模板串内：禁止反引号与美元花括号。
       */
      getVerificationCode: (imageUrl) => {
        const code = rpc('verificationCode', { url: String(imageUrl ?? '') });
        if (typeof code !== 'string') throw new Error('java.getVerificationCode 未收到验证码（用户取消或超时）');
        return code;
      },
      ajaxAll: (urls) => {
        var arr = Array.isArray(urls) ? urls : [];
        // 与 L1 同形态：同序 StrResponse 数组（Legado JsExtensions.ajaxAll :154-168）
        return arr.map(function (u) {
          var t = httpRpcSpec(u);
          return strResponse(t, {}, 200, { url: String(u), method: 'GET', body: '', headers: {} });
        });
      },
      // —— 字节桥（Buffer 自足）——
      strToBytes: (s, charset) => { try { return Buffer.from(String(s), charset || 'utf-8'); } catch { return Buffer.alloc(0); } },
      bytesToStr: (b, charset) => { try { return Buffer.from(b).toString(charset || 'utf-8'); } catch { return ''; } },
      hexDecodeToByteArray: (hex) => { try { return Buffer.from(String(hex), 'hex'); } catch { return Buffer.alloc(0); } },
      // —— 章节数转数字（对齐宿主 attachExtendedJavaApi）——
      toNumChapter: (() => {
        const cnMap = {
          '〇':0,'零':0,'一':1,'壹':1,'二':2,'贰':2,'三':3,'叁':3,'四':4,'肆':4,
          '五':5,'伍':5,'六':6,'陆':6,'七':7,'柒':7,'八':8,'捌':8,'九':9,'玖':9,
          '十':10,'拾':10,'百':100,'佰':100,'千':1000,'仟':1000,'万':10000,'亿':100000000,'两':2,
        };
        return (s) => {
          const str = s == null ? null : String(s);
          if (!str) return null;
          const m = /第([〇零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟万亿]+)(章)/.exec(str);
          if (!m) return str;
          const raw = m[1];
          let total = 0, section = 0, digit = 0;
          for (const ch of raw) {
            const d = cnMap[ch] ?? -1;
            if (d < 0) return str;
            if (d >= 10000) { total = (total + section + digit) * d; section = 0; digit = 0; }
            else if (d >= 10) { section += (digit || 1) * d; digit = 0; }
            else digit = d;
          }
          return '第' + (total + section + digit) + m[2];
        };
      })(),
      getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      // —— java.util.Base64 / UUID（源常用 Rhino 原生包访问）——
      util: new Proxy({
        Base64: {
          getEncoder: () => ({ encodeToString: (s) => Buffer.from(String(s ?? ''), 'utf-8').toString('base64'), encode: (s) => Buffer.from(String(s ?? ''), 'utf-8').toString('base64') }),
          getDecoder: () => ({ decode: (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf-8'), decodeToString: (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf-8') }),
          encode: (s) => Buffer.from(String(s ?? ''), 'utf-8').toString('base64'),
          decode: (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf-8'),
        },
        UUID: { randomUUID: () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2)) },
      }, { get: (t, p) => (p in t ? t[p] : () => '') }),
    },
    { get: (t, p) => (p in t ? t[p] : () => '') },
  );
  /**
   * 类CA（2026-10-26）：cookie 的**全部读写都回宿主源级 CookieStore**。
   *
   * 为什么必须在宿主：worker 里的 Map 既不影响任何一次请求（引擎注入头读的是宿主的
   * ctx.cookies），也不跨 eval 存活。曾经的实现就是这样一个本地 Map —— 于是
   * cookie.setCookie 成了静默 no-op（Proxy 兜底返回空串），
   * 实测 笔趣阁·恋爱呀 设了 waf_challenge 也没带上，第二次请求仍 503、搜索 0 条。
   * 语料用量：setCookie 16 源 / getCookie 33 源 / removeCookie 71 源。
   *
   * 简写 get/set/remove 与 Legado 的 getCookie/setCookie/replaceCookie/removeCookie
   * 统统走 RPC（判据与落点复用宿主那份，与 L1 的 makeCookieStub 零漂移）。
   * 注意：本注释位于模板串内，禁反引号与美元花括号。
   */
  const cookie = new Proxy(
    {
      get: (k) => String(rpc('getCookie', { key: String(k) }) ?? ''),
      set: (k, v) => { rpc('cookieSet', { cookie: String(k) + '=' + String(v == null ? '' : v) }); },
      remove: (k) => { rpc('cookieRemoveKey', { key: String(k) }); },
      header: () => String(rpc('getCookie', {}) ?? ''),
      getCookie: (_url) => String(rpc('getCookie', {}) ?? ''),
      setCookie: (_url, ck) => { rpc('cookieSet', { cookie: String(ck == null ? '' : ck) }); },
      replaceCookie: (_url, ck) => { rpc('cookieSet', { cookie: String(ck == null ? '' : ck) }); },
      removeCookie: () => { rpc('cookieClear', {}); },
      getKey: (_url, key) => String(rpc('getCookie', { key: String(key) }) ?? ''),
      // [#410] cookie.setWebCookie(url, cookie)：回宿主写**源级 CookieStore**
      // （与 L1 的 makeCookieStub.setWebCookie 同一判据 + 同一落点；判据唯一实现在
      //  宿主 selector/web-cookie.ts，worker 只发 RPC）。
      setWebCookie: (url, cookie) => { rpc('cookieSetWeb', { url: String(url == null ? '' : url), cookie: String(cookie == null ? '' : cookie) }); return ''; },
    },
    { get: (t, p) => (p in t ? t[p] : () => '') },
  );
  // —— cache：Legado CacheManager 面，**全部经 RPC 回宿主**（与 L1 的 makeCacheStub 同源）——
  //
  // ⚠️ 曾经的实现是 worker 内的一个 Map，注释写「put 后同脚本内 get 可见」——那是**假的跨阶段保证**：
  //   详情 init 里 cache.put 的键，到目录阶段（另一次 eval、可能另一个 worker 甚至 L1）就读不到。
  //   语料实测跨阶段依赖 cache 是常态：🎨快看漫画（init.put -> toc.get）、
  //   📂小说阅读（init.putMemory -> toc.chapterUrl 的 {{cache.getFromMemory(...)}}）。
  //   现在 put/get/delete 一律回宿主，两层（__srcCache 持久 / __memCache 进程内）与 L1 完全共用。
  //
  // ⚠️ 回传走 SAB（4MB）：cacheGet 拿到超大字符串会降级为可见的 'rpc result exceeds SAB' 错误。
  const cache = new Proxy(
    {
      put: (k, v, saveTime) => {
        rpc('cachePut', { k: String(k), v: v == null ? '' : String(v), saveTime: Number(saveTime || 0) });
        return v;
      },
      putMemory: (k, v) => {
        rpc('memCachePut', { k: String(k), v: v == null ? '' : String(v) });
        return v;
      },
      get: (k, onlyDisk) => rpc('cacheGet', { k: String(k), onlyDisk: !!onlyDisk }),
      getMemory: (k) => rpc('memCacheGet', { k: String(k) }),
      getFromMemory: (k) => rpc('memCacheGet', { k: String(k) }),
      delete: (k) => { rpc('cacheRemove', { k: String(k) }); return true; },
      deleteMemory: (k) => { rpc('memCacheRemove', { k: String(k) }); return true; },
      putFile: (k, v, saveTime) => {
        rpc('cacheFilePut', { k: String(k), v: v == null ? '' : String(v), saveTime: Number(saveTime || 0) });
        return v;
      },
      getFile: (k) => rpc('cacheFileGet', { k: String(k) }),
      getInt: (k) => cacheNum(rpc('cacheGet', { k: String(k) }), true),
      getLong: (k) => cacheNum(rpc('cacheGet', { k: String(k) }), true),
      getDouble: (k) => cacheNum(rpc('cacheGet', { k: String(k) }), false),
      getFloat: (k) => cacheNum(rpc('cacheGet', { k: String(k) }), false),
    },
    { get: (t, p) => (p in t ? t[p] : () => '') },
  );
  /**
   * org.jsoup 桥（worker 侧，**唯一实现在此**；L1 同款见 selector/js.ts 的 makeOrgStub）。
   *
   * ★ 必须**同时**挂到裸全局 org 与 Packages.org —— 源脚本两种写法都有
   *   （org.jsoup.Jsoup.parse 与 Packages.org.jsoup.Jsoup.parse）。此前 Packages 只挂了
   *   java/android ⇒ 后者落 nest() 空桩 ⇒ doc 的 select/selectFirst 全缺
   *   （爱丽丝书屋 doc.selectFirst is not a function ⇒ 目录 0 章）。
   *
   * ⚠️ 本段位于 String.raw 模板内：注释里禁反引号与美元花括号（已踩四次）。
   */
  /** #523 window 的取值目标（= 本 worker 的全局对象，见下方 full.window 注释） */
  const g0 = globalThis;
  const full = {
    // this.M / this.get / this.put / this.setHeaders / this.encode / this.getHeaderMap
    // ——与 L1 的 makeThisScope 逐项一致（此前后者定义了却没接上，导致 worker 里 this.* 全缺）
    ...thisScope,
    // 本次作业的原生全局快照（shim 里读 globalThis.__yueduNativeGlobals 回落用）
    __yueduNativeGlobals: natives,
    java,
    cookie,
    cache,
    source: undefined,
    book: undefined,
    result: undefined,
    baseUrl: undefined,
    chapter: undefined,
    title: undefined,
    src: undefined,
    nextChapterUrl: undefined,
    rssArticle: undefined,
    fromBookInfo: false,
    page: undefined,
    key: undefined,
    org: __ORG_NS,
    com: __COM_NS,
    net: __NET_NS,
    javax: __JAVAX_NS,
    Packages: __PACKAGES_NS,
    // #526 硬桥：JavaImporter / 全局 importPackage 在 worker 内可用（见上方 ctor 注释）
    JavaImporter: __yueduJavaImporterCtor,
    importPackage: __yueduImportPackage,
    importClass: __yueduImportPackage,
    ...__yueduPrepareBindings(bindings),
  };
  /**
   * ★ source 兜底（与宿主 L1 selector/js.ts 同一条，两边别漂移）：
   * __yueduPrepareBindings 只有在宿主下发 __yueduSourceFields 时才重建 source；
   * 没下发（或调用方显式传 source 为 undefined，后展开后胜）⇒ 脚本里
   * source.getLoginInfoMap() 直接 TypeError（全量基线 2026-10-24：65 个源挂在
   * Cannot read properties of undefined (reading getLoginInfoMap)）。
   * ⇒ 无源时挂一个「方法齐全、无登录态」的桩：可以读不到登录信息，但不能没有 source。
   * ⚠️ 本段位于模板字符串内：注释里禁反引号与美元花括号（已踩四次）。
   */
  if (full.source == null) {
    full.source = Object.assign({
      getKey: function () { return ''; },
      get: function () { return ''; },
      put: function (k, v) { return v; },
      set: function () { return undefined; },
      getVariable: function () { return ''; },
      setVariable: function () { return undefined; },
      getLoginInfoMap: function () { return __yueduAttachJsonMap({}); },
      getHeaderMap: function () { return {}; },
      getComment: function () { return ''; },
      putLoginHeader: function () { return undefined; },
    });
  }
  /**
   * #523 window = **求值 realm 的全局对象本身**（与宿主 L1 同语义：浏览器里 window 就是
   * globalThis，window.Array / window.java / window.document 都取得到）。此前 worker 里没有
   * window ⇒ 引用它的脚本在本应走 worker 的路径上直接 ReferenceError（宿主那份守卫只管
   * document，window 无人管）。赋值也一致：window.x = 1 落在 realm 全局（求值结束复位）。
   * #624：vm 模式下 realm 全局是 **context 全局**（不是 worker 全局）—— 否则脚本通过
   * window 就摸到了 worker 世界，隔离出现后门。
   */
  full.window = realmGlobal;
  /**
   * #624 vm 模式：注入「无害 Web/Node 面」（URL/fetch/计时器…）。
   * Buffer / process / require / module / global **不注入** —— 那是本任务要关死的面
   * （worker 线程里 require 是 Node 注入的，书源脚本实测能 require('os') ⇒ RCE）。
   * 判据与逐项理由见 __yueduWebGlobals 的注释。
   */
  if (realm) Object.assign(full, __yueduWebGlobals());
  // ★ Rhino 全局作用域仿真：绑定挂 realm 全局再 eval（this=全局含全部绑定；jsLib
  //   函数/隐式全局一致）。vm 模式靠「删掉 context 全局全部自有键」复位（contextified
  //   对象的 ownKeys 只含注入键，内置不在其列）；非 vm 模式沿用快照/恢复。
  const g = realmGlobal;
  const before = new Set(Reflect.ownKeys(g));
  const saved = new Map();
  for (const k of Object.keys(full)) { saved.set(k, g[k]); g[k] = full[k]; }
  /**
   * #523 document 的**惰性** getter（对齐 L1：只有脚本真读 document 才解析内容）。
   *
   * 内容取 __ruleContentPreset —— 宿主随 __yueduRuleContent 下发的 String(this.content)，
   * 与 L1 AnalyzeRule.documentOf(running) 解析的**是同一份字符串**（那边解析的就是 running），
   * 且**零额外 parse**（脚本不读 document 就不 parse，与挂账 #92 的「惰性」不变量一致）。
   * ⚠️ 取不到内容（元素 / JSON 内容的脚本、或内容为空）⇒ **不定义** document：
   *    宁可 ReferenceError（显式失败）也不给假文档（假文档会把 nonce 算错 = 静默错值）。
   *    路由守卫（js.ts）已按「内容须是字符串」把这类脚本留 L1。
   * ⚠️ 本注释位于模板串内：禁反引号与美元花括号。
   */
  if (__ruleContentPreset) {
    var __docCache = null;
    Object.defineProperty(g, 'document', {
      configurable: true,
      enumerable: false,
      get: function () {
        if (__docCache) return __docCache;
        var __rootNid = rpc('dom', { op: 'parse', html: __ruleContentPreset });
        var __rootDesc = rpc('dom', { op: 'desc', nid: __rootNid }) || null;
        __docCache = __yueduDocument(__rootNid, __rootDesc);
        return __docCache;
      },
    });
  }
  // 求值源码（catch 里靠它给出「出错行 + 片段」，所以提到 try 外）
  let prepared = '';
  try {
    /**
     * #611 step3 **jsLib 独立作用域**（对齐 L1 libScopeFactory + 上游 ScriptBindings.chainTo）。
     *
     *  · libScope = factory.call(realmGlobal) —— lib 顶层照常跑（含 this.java 赋值），
     *    声明收进它自己的作用域对象（**不再污染 realm 全局**）；
     *  · 求值层 scope = Object.create(libScope) + 绑定 ⇒ 写落本层、读走原型链；
     *  · libScope 的每个函数**重绑**到求值层 —— 上游 Rhino 顶层函数的 this 就是作用域对象，
     *    V8 裸调用的 this 恒是全局（chain 下拿不到本层）⇒ 不重绑就会复现 #601。
     */
    var scopeObj = null;
    if (useChain) {
      __yueduWTMark(__wt, 'pre');
      /**
       * ⚠️ collect 名单必须是 **libFns ∪ libVars**（与 L1 的 names 构造逐字对齐）：
       * 源库大量把基址/开关写成 var HJ_B='https://…'（黄金屋实测），只收函数声明
       * 会让规则里的 HJ_B 报 is not defined（#563 锁当场抓获）。
       */
      var libNames = (msg.libFns || []).concat(Array.isArray(msg.libVars) ? msg.libVars : []);
      /**
       * #628 **jsLib 作用域按 (libText, realm) 复用**（对齐上游 SharedJsScope.scopeMap）。
       *
       * ← 上一轮这里写的是「不能缓存复用 libScope，#628 试过已回退」，那个结论**已被推翻**：
       *   当时的真因是 ① this 落在 realm 全局 ② lib 隐式全局也落在 realm 全局，两条都被
       *   realm.reset() 抹掉。现在分别用 factory.call(scope, scope) 与 realm.adopt() 解决，
       *   上游本来就是「长期复用、从不 reset」。省掉的就是「每章重跑 56KB lib」（主因）。
       *   详见 __yueduLibScopeFor 头注（本段在 WORKER_SRC 模板串内：禁反引号）。
       */
      var libScope = __yueduLibScopeFor(msg.lib, libNames, natives, realm, msg.libGlobalNames);
      /**
       * #611 step3 双层作用域：本次求值的 bindings 放**自有属性层**，libScope 作原型。
       * lib 里的函数统一 bind 到 scopeObj —— 保证 this 落在「能看到本次绑定」的那层
       * （否则复现 #601：lib 函数经回调/间接调用时 this 丢了 ⇒ 读不到注入的 source/java）。
       *
       * ⚠️ **bind 结果必须写在 scopeObj 上，不能写回 libScope**（旧实现写回 libScope）：
       *  ① libScope 现在跨求值复用 ⇒ 写回会把**第一次求值的 scopeObj** 固化进去，
       *     后续换书仍在用上一本书的 source/java 桩（真实串味 bug）；
       *  ② 写回也会被上游那层 preventExtensions 语义拒绝。
       * 顺序：先铺 bind 后的 lib 函数，再 assign full ⇒ bindings 同名时仍以 full 为准（与旧实现同优先级）。
       */
      scopeObj = Object.create(libScope);
      /**
       * YUEDU_JS_LIBBIND=minimal：**只 bind 本次 code 里出现过的 lib 函数**（#628 归因/优化开关）。
       * 默认全 bind（203 个名字 ⇒ 每次求值几十次 Function.prototype.bind）；
       * minimal 下先扫一遍 code 的标识符，只对交集 bind —— 规则通常只用 lib 的一两个函数。
       * 正确性：需要 this 的只有「规则代码直接调用」的那些 lib 函数；lib 内部互调走闭包作用域，
       * 不经过 scope 属性 ⇒ 不在交集中也不受影响。
       */
      var minimal = __yueduEnvFlag('YUEDU_JS_LIBBIND', 'minimal');
      var codeIdents = minimal ? __yueduIdentsOf(String(code)) : null;
      for (var __lk of Object.keys(libScope)) {
        var __lv = libScope[__lk];
        if (typeof __lv !== 'function') continue;
        if (codeIdents && !codeIdents[__lk]) continue;
        try { scopeObj[__lk] = __lv.bind(scopeObj); } catch (e2) { /* 不可绑：保持原型上的原值 */ }
      }
      Object.assign(scopeObj, full);
      /**
       * 与 L1 同判据（详见 selector/js.ts 的同名注释）：源库自己定义 $ 时，库函数必须
       * 赢过 AnalyzeRule.bindings() 注入的「$ = 当前内容别名」，否则 qyyuapi 系
       * （拷贝漫画 / 热辣漫画）登录页「切换站源」按钮的 $(0) 抛 $ is not a function。
       * 只删本层自有属性 => 查找回落到 libScope（函数已在上面 bind 到 scopeObj）。
       * 本段在模板串内：禁反引号与美元花括号。
       */
      try { if (typeof libScope['$'] === 'function') delete scopeObj['$']; } catch (e6) { /* 只读：忽略 */ }
      /**
       * #636 第二层留痕（YUEDU_DEBUG_JSLIB=1）：**lib 到底有没有进到本次求值的作用域**。
       *
       * 为什么需要：宿主日志只能证明「拼出来的 lib 文本里有 Get」，证明不了 worker 侧
       * Get 是可达的 —— 而 libFns 名单、Object.keys(libScope)、LIBBIND=minimal 的
       * 标识符交集任何一处漏了，症状都是同一句 Get is not defined（看起来像源规则写错）。
       * 本段在模板串内：禁反引号与美元花括号。
       */
      if (__yueduEnvFlag('YUEDU_DEBUG_JSLIB', '1')) {
        console.log('[jslib:w] chain=' + useChain + ' libLen=' + String(msg.lib ? msg.lib.length : 0) +
          ' names=' + libNames.length + ' scopeKeys=' + Object.keys(libScope).length +
          ' scope.Get=' + (typeof libScope.Get) + ' scope.Reload=' + (typeof libScope.Reload) +
          ' scoped.Get=' + (typeof scopeObj.Get) + ' minimal=' + minimal);
        /**
         * #636 第二层：**求值前**看两个关键名是否已在「求值环境」里。
         *
         * 为什么单独打这两个：Get 是 lib 侧公共函数（本应在 scope 上），
         * user_Check 是源脚本里被调用的另一个函数（谁定义的当时并不清楚）。
         * 若 user_Check 在**执行之前**就已是 function，说明它是上一条脚本经
         * 「顶层声明回写全局」漏出来的 —— 那种函数的闭包不含 lib 作用域，
         * 里面再调 Get 就是 Get is not defined（本次真因）。
         */
        var __probeUserCheck = 'n/a';
        try {
          var __uc = (useChain ? scopeObj : g)['user_Check'];
          __probeUserCheck = typeof __uc === 'function' ? 'function:' + String(__uc).replace(/\s+/g, ' ').slice(0, 90) : typeof __uc;
        } catch (e3) { /* 取不到就算了 */ }
        console.log('[jslib:w] pre-user_Check=' + __probeUserCheck +
          ' global-user_Check=' + (typeof (globalThis && globalThis.user_Check)) +
          ' libGlobalFlag=' + String(msg.libGlobalNames) +
          ' g.Get=' + (typeof (globalThis && globalThis.Get)));
      }
      __yueduWTMark(__wt, 'lib');
      // 与 L1 同款兜底：工厂那一次若 source 缺失，用本次的（否则 with/原型链上读到 undefined 遮蔽真桩）
      // ⚠️ 必须写在 scopeObj（每求值层）而不是 libScope —— libScope 是复用的，写进去就永久串味。
      if (scopeObj['source'] == null) scopeObj['source'] = full['source'];
      __yueduWTMark(__wt, 'bind');
    }
    // 顶层声明提升（对齐 L1）：函数声明**置于 eval 源码内**（它们只在 eval 作用域里）、
    // var 在 eval 之后挂（sloppy 模式下 var 会泄漏到本函数作用域）。
    // ⚠️ code 由宿主做过 Rhino→V8 语法兼容与「var f = function」改写（见 createHybridJsEvaluator）。
    /**
     * #598 顶层 return：eval 是 Script 上下文不允许，包一层 IIFE 重试（与宿主 selector/js.ts 同判据）。
     * 只有首次真抛 Illegal return statement 才会走到这里（retried），正常脚本零额外开销。
     * 本段在模板串内：禁反引号与美元花括号。
     */
    prepared = __yueduHoist(hoistFns, natives) + (retried ? '(function(){' + String(code) + '\n})()' : String(code));
    // 同名 var 预置（与 L1 同逻辑，见 selector/js.ts 的注释）：脚本里写 var result = ... 时
    // V8 会把它提升成 fn 作用域本地变量 → 遮蔽注入的绑定 → 读到 undefined
    // （实测 ⚡📂书荒小说 正文 result.match(...) → Cannot read properties of undefined）。
    // #611 step3：chain 模式下 lib 的 var 名也要参与（lib 与 code 此时是两层作用域，
    // 但绑定只注入在求值层 ⇒ lib 侧同名 var 同样会被「提升成 undefined」遮蔽）。
    // ⚠️ 本注释不得出现反引号：WORKER_SRC 是模板字符串，反引号会截断它（已踩四次）。
    var __shadow = [];
    var __shadowNames = hoistVars.concat(useChain && Array.isArray(msg.libVars) ? msg.libVars : []);
    for (var __si = 0; __si < __shadowNames.length; __si++) {
      var __sn = __shadowNames[__si];
      if (Object.prototype.hasOwnProperty.call(full, __sn)) __shadow.push(__sn + '=globalThis[' + JSON.stringify(__sn) + ']');
    }
    var __pre = __shadow.length ? 'var ' + __shadow.join(',') + ';' : '';
    var __post = __yueduHoist(hoistVars, natives, true);
    /**
     * #624/#611 step3：runner 在求值 realm 里**只编译一次**（vm 模式经 runInContext），
     * 每次求值只 eval code 本身 —— 旧实现把 55KB lib 拼进 new Function 源码 ⇒ V8 编译缓存
     * 按整段源码做键、每章 code 都不同 ⇒ 100% miss（#509 在 L1 修掉的坑，worker 侧一并补上）。
     */
    var runner = __yueduRunner(realm);
    if (!runner) throw new Error('sandbox runner 编译失败（求值 realm 不可用）');
    var value;
    /**
     * #636 第二层：**远程库源走「全局作用域 Script」求值**（仅 vm 模式；YUEDU_JS_LIBSCRIPT_OFF=1 关）。
     *
     * 为什么还需要这一步（lib 已镜像到全局之后）：qyyuapi 系的 ruleSearch.js 顶层
     * var data,Headers,… 在函数式 runner（function 包一层 + 直接 eval）里落在**函数作用域**，
     * 而外链 de.js 自解密出来的函数（间接 eval / Function 构造）闭包只看见**全局**
     * ⇒ data is not defined（实测有栈；lib 镜像已解掉 Get，这是同一族问题的第二层）。
     *
     * 上游语义：Rhino 的脚本（含嵌套 eval）顶层 var 都落在**共享 scope** ⇒ 跨脚本可见。
     * V8 里唯一能等价做到的是把求值放在 **Script 上下文**（顶层 var ⇒ 全局属性）——
     * 函数式 runner 无论怎么包都做不到（var 永远落函数作用域）。
     *
     * 代价与边界：
     *  · __yueduP 这个临时键**不进 adopt 名单** ⇒ 每次 realm.reset() 都会删掉；
     *    本段**不得声明 Script 顶层 var/function**（那会在全局上留下删不掉的绑定，
     *    实测 var __yueduRet 之后整个 worker 的求值全变 undefined），结果只走对象属性；
     *  · 只对「jsLib 是远程 URL 表」的源开（msg.libGlobalNames，同 lib 镜像的判据），
     *    内联 jsLib 的普通源继续走函数式 runner（#611 隔离锁不变）。
     */
    if (useChain && msg.libGlobalNames === true && realm && realm.global && !__yueduEnvFlag('YUEDU_JS_LIBSCRIPT_OFF', '1')) {
      /**
       * #785 不能再用 with(scopeObj)：scopeObj 的原型链连到 realm 全局，脚本顶层
       * var（ruleExplore 的 var data）先 hoist 到全局，随后 with 里的 data=[] 会按
       * OrdinarySet 在 scopeObj 上建自有属性（实测 global=undefined / scope=[]），
       * 而 de.js 间接 eval 出来的 Data()/push() 闭包只读全局 => undefined.push。
       * Rhino 的语义是「共享 scope 就是全局」：把求值层自有键临时注入 realm 全局，
       * 以 Script 顶层 eval 执行，结束后按快照还原（__yueduP 不进 adopt，reset 兜底删）。
       * 注意：本段在模板串内，禁反引号与美元花括号；也不得在 Script 顶层声明 var/function。
       */
      var __saved = [];
      var __inject = function (src) {
        var ks = Object.keys(src || {});
        for (var i = 0; i < ks.length; i++) {
          var k = ks[i];
          __saved.push([k, Object.prototype.hasOwnProperty.call(realm.global, k), realm.global[k]]);
          try { realm.global[k] = src[k]; } catch (e3) { /* 只读内置：跳过 */ }
        }
      };
      __inject(libScope);
      __inject(scopeObj);
      try {
        realm.global.__yueduP = { code: prepared, pre: __pre, post: __post };
        realm.compile(
          'if (__yueduP.pre) eval(__yueduP.pre);' +
            '__yueduP.out = eval(__yueduP.code);' +
            'if (__yueduP.post) eval(__yueduP.post);',
        );
        value = realm.global.__yueduP.out;
      } finally {
        try { delete realm.global.__yueduP; } catch (e4) {}
        for (var __ri = __saved.length - 1; __ri >= 0; __ri--) {
          var __it = __saved[__ri];
          try {
            if (__it[1]) realm.global[__it[0]] = __it[2];
            else delete realm.global[__it[0]];
          } catch (e5) {}
        }
      }
    } else {
      value = await runner.call(useChain ? scopeObj : g, useChain ? scopeObj : g, prepared, __pre, __post);
    }
    __yueduWTMark(__wt, 'run');
    let payload;
    try {
      payload = __yueduSendable(value);
      return { ok: true, value: payload };
    } catch (e) {
      // 兜底：结果仍不可克隆（极少数嵌套函数对象）→ 退化成字符串，绝不让规则因克隆失败而打挂
      return { ok: true, value: value == null ? '' : String(value) };
    }
  } catch (e) {
    /**
     * #636 第二层留痕（YUEDU_DEBUG_JSLIB=1）：**原始错误 + 栈**。
     *
     * 为什么需要：返回给宿主的只有 __yueduExplainJsError 加工过的**一行字符串**，
     * 栈和真实出错位置都丢了 —— 于是「Get is not defined」到底发生在第几层 eval、
     * 是哪个文件的第几行，全靠猜（#636 第二轮就卡在这里）。
     * 本段在模板串内：禁反引号与美元花括号。
     */
    if (__yueduEnvFlag('YUEDU_DEBUG_JSLIB', '1')) {
      console.log('[jslib:err] msg=' + String(__yueduErrMsg(e)).slice(0, 300) +
        ' || stack=' + String((e && e.stack) || '').replace(/\n/g, ' <- ').slice(0, 600));
    }
    // #598：顶层 return 在 eval 里非法 ⇒ 包 IIFE 重试一次（见 prepared 处注释）
    if (!retried && /Illegal return statement/.test(String(e && e.message ? e.message : e))) {
      return runEval(msg, true);
    }
    // #624：vm 上下文抛出的错在 worker 侧 instanceof Error 为 **false**（跨上下文原型）
    // ⇒ 统一鸭子取值（有 message 就用 message），否则错误链全退化成 String(e)。
    return { ok: false, error: __yueduExplainJsError(__yueduErrMsg(e), prepared, (e && e.stack) || '') };
  } finally {
    if (realm) {
      // vm：按「初始内置键 + 值快照」复位 —— 删掉本次注入与脚本隐式全局，
      // 还原被脚本覆盖的内置值（内置是 context 内部属性，外部 delete 不到，必须在
      // context 内做；见 __yueduVmRealm 的坑②）。
      realm.reset();
    } else {
      for (const k of Reflect.ownKeys(g)) if (!before.has(k)) { try { delete g[k]; } catch { /* non-configurable */ } }
      for (const [k, v] of saved) { try { if (g[k] !== v) g[k] = v; } catch { /* read-only global */ } }
      /**
       * #624 收尾：**内置全局原生复位**（vm 模式由 realm.reset() 等价完成，见上）。
       *
       * 为什么必须：非 vm 模式求值全局就是 worker 全局，脚本 var Proxy = "1,2,3" 经
       * with(g) 的赋值把 g.Proxy 污染成字符串且**跨求值留存** ⇒ 下次求值入口的 java 桩
       * new Proxy(...) 直接 "Proxy is not a constructor"（YUEDU_JS_VM=0 实测，测试 780；
       * vm 模式不炸只因污染进 realm 且 reset() 每次还原 —— 同一个 bug 被掩盖）。
       * 宿主 L1 的求值从不持久改写内置全局（chain 模式写 libScope、legacy 模式没有 with），
       * 这里按同一不变量复位：natives 是本步求值开始时的快照，而上一步的 finally 已复位
       * ⇒ 归纳得每步开始都是真原生（shim 不会链式嵌套）。
       */
      for (const k of Object.keys(natives)) { try { if (g[k] !== natives[k]) g[k] = natives[k]; } catch { /* read-only global */ } }
    }
    __yueduWTMark(__wt, 'reset');
    __yueduWTDone(__wt);
  }
}
parentPort.on('message', (msg) => {
  if (msg && msg.kind === 'init' && msg.sab) { SAB = msg.sab; return; }
  // '#480-b'：批量优先（jobs 数组）⇒ 一条消息跑 N 个作业
  if (msg && msg.id && Array.isArray(msg.jobs)) void handleBatch(msg);
  else if (msg && msg.id && msg.code !== undefined) void handle(msg);
});
`;

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  /** 同步 RPC 回填缓冲（worker Atomics.wait 用） */
  sab: SharedArrayBuffer;
  /** 已完成的 eval 次数（达到阈值即回收换新，防止脚本全局累积泄漏） */
  evals: number;
}

/** 单块 SAB 的容量。刻意保持 4MB：它是**每块**（每 worker 一块）的常驻内存，池 4 个 = 16MB。 */
const SAB_SIZE = 4 * 1024 * 1024;
/** 头部 i32 个数（byte 0..31）；数据从 byte 32 起。与 `WORKER_SRC` 里的 `SAB_HEAD_I32` 必须一致。 */
const SAB_HEAD_I32 = 8;
const SAB_DATA_OFF = 32;
/**
 * `#537` ② **原始字节回包**标记字段名：宿主 RPC 返回值带这个字段（`Uint8Array`）时，
 * 分发器走 `sabReplyRaw`（SAB status=3）而不是 JSON —— 免 base64 编解码 + JSON 字符串膨胀。
 * 超过单片容量时 `sabReplyRaw` 自动退回 base64 JSON（分片通道已有）⇒ 两条路都通。
 */
export const RAW_REPLY_FIELD = '__yueduRawReply';
/**
 * 单次 RPC 回传的**硬上限**（超过就直接报错，不再分片）。
 *
 * 为什么要有：分片解决了 4MB 天花板，但**没有**解决「一个脚本要求宿主回传 1GB」这种情况 ——
 * 那会把宿主内存和 SAB 往返都拖死。256MB 远高于任何合法用法（最大的是媒体 body / HTML 列表）。
 * 可用 `YUEDU_WORKER_SAB_MAX_MB` 调整。
 */
const SAB_MAX_TOTAL = (() => {
  const mb = Number(process.env['YUEDU_WORKER_SAB_MAX_MB'] ?? 0);
  return (Number.isFinite(mb) && mb > 0 ? mb : 256) * 1024 * 1024;
})();

/**
 * 把 RPC 结果写入 SAB 并唤醒 worker（跨线程 notify）。**大结果自动分片**（#105）。
 *
 * ## 为什么是「同一块 SAB 分片」而不是「动态多 SAB / 加大 SAB」
 *
 * 实测（2026-09-22，枫叶音乐盒正文：`var resp = java.get(clean, headers)` 回传音频/媒体 body）：
 * 超过 4MB 时旧实现直接把结果丢成 `rpc result exceeds SAB` 错误 —— 源**必然**失败。
 *
 * 三条路的取舍：
 *  1. **加大 SAB**（如 64MB）：最简单，但每 worker 常驻 64MB × 池 4 = 256MB，且仍有上限；
 *  2. **动态新建 SAB 通道**：❌ 不可行 —— worker 此刻**正卡在 `Atomics.wait` 里**（阻塞状态
 *     没有事件循环），宿主 `postMessage` 过去的 SAB 它**收不到**；
 *  3. **同一块 SAB 分片**（本实现）：把结果切成 ≤ 容量的片，用 `i32[3]` 做握手位交替推进。
 *     宿主是主线程、**不能** `Atomics.wait`（会阻塞事件循环），所以用 `Atomics.waitAsync`
 *     异步等 worker 消费完一片（Node ≥ 12.16 支持，本机 Node 22 实测可用）。
 *
 * 分片只在**超过容量时**触发；小结果走原来那条单片路径（行为逐字不变，零回归风险）。
 */
/**
 * `#537` ② **原始字节回包**（SAB status=3）：把 `bytes` 原样写进数据区，worker 侧
 * `rpcBinary` 直接取字节 —— 免 base64 编解码与 JSON 字符串化（compress 一类大二进制）。
 *
 * 超过单片容量 ⇒ 自动退回 base64 JSON（复用 `sabReply` 的分片通道），调用方无感。
 * 错误回包仍走 JSON（`sabReply`）—— 协议上 status=3 恒为成功。
 */
async function sabReplyRaw(pw: PooledWorker, callId: number, bytes: Uint8Array): Promise<void> {
  const i32 = new Int32Array(pw.sab, 0, SAB_HEAD_I32);
  const capacity = SAB_SIZE - SAB_DATA_OFF;
  if (bytes.length > capacity) {
    await sabReply(pw, callId, { ok: true, value: { b64: Buffer.from(bytes).toString('base64') } });
    return;
  }
  new Uint8Array(pw.sab, SAB_DATA_OFF).set(bytes);
  Atomics.store(i32, 2, bytes.length);
  Atomics.store(i32, 3, 0);
  Atomics.store(i32, 4, 0);
  Atomics.store(i32, 5, 1);
  Atomics.store(i32, 6, bytes.length);
  Atomics.store(i32, 0, callId);
  Atomics.store(i32, 1, 3);
  Atomics.notify(i32, 1);
}

async function sabReply(
  pw: PooledWorker,
  callId: number,
  payload: { ok: boolean; value?: unknown; error?: string },
): Promise<void> {
  const json = Buffer.from(JSON.stringify(payload), 'utf-8');
  const i32 = new Int32Array(pw.sab, 0, SAB_HEAD_I32);
  const capacity = SAB_SIZE - SAB_DATA_OFF;

  if (json.length <= capacity) {
    // —— 常见路径：单片（与旧协议一致，只多了几个头部槽的写入）——
    new Uint8Array(pw.sab, SAB_DATA_OFF).set(json);
    Atomics.store(i32, 2, json.length);
    Atomics.store(i32, 3, 0);
    Atomics.store(i32, 4, 0);
    Atomics.store(i32, 5, 1);
    Atomics.store(i32, 6, json.length);
    Atomics.store(i32, 0, callId);
    Atomics.store(i32, 1, 1);
    Atomics.notify(i32, 1);
    return;
  }

  if (json.length > SAB_MAX_TOTAL) {
    const msg = `rpc result too large: ${(json.length / 1048576).toFixed(1)}MB > ${(SAB_MAX_TOTAL / 1048576).toFixed(0)}MB（分片上限于 YUEDU_WORKER_SAB_MAX_MB 可调）`;
    const err = Buffer.from(JSON.stringify({ ok: false, error: msg }), 'utf-8');
    new Uint8Array(pw.sab, SAB_DATA_OFF).set(err);
    Atomics.store(i32, 2, err.length);
    Atomics.store(i32, 5, 1);
    Atomics.store(i32, 0, callId);
    Atomics.store(i32, 1, 1);
    Atomics.notify(i32, 1);
    return;
  }

  // —— 大结果：分片（status=2 告诉 worker 进分片读取循环）——
  const total = Math.ceil(json.length / capacity);
  for (let i = 0; i < total; i++) {
    const chunk = json.subarray(i * capacity, Math.min((i + 1) * capacity, json.length));
    new Uint8Array(pw.sab, SAB_DATA_OFF, chunk.length).set(chunk);
    Atomics.store(i32, 2, chunk.length);
    Atomics.store(i32, 3, 0); // 握手位清零，等 worker 消费
    Atomics.store(i32, 4, i);
    Atomics.store(i32, 5, total);
    Atomics.store(i32, 6, json.length);
    Atomics.store(i32, 0, callId);
    Atomics.store(i32, 1, 2);
    Atomics.notify(i32, 1);
    if (i + 1 < total) {
      // 等 worker 读完本片（它会置 i32[3]=1 + notify）。已经置好时 waitAsync 返回 async:false。
      const w = Atomics.waitAsync(i32, 3, 0);
      if (w.async) await w.value;
    }
  }
}

export interface WorkerSandboxOptions {
  /** 池大小，默认 4 */
  size?: number;
  /** 默认硬超时毫秒，默认 10_000 */
  defaultTimeoutMs?: number;
  /**
   * `#753` B2：单 worker 的 V8 老生代上限（MB，0/未传 = 不设）。
   * 到顶时 worker 会被 V8 强制终止，`refill()` 自动补位 —— 用于把**批处理子进程**的
   * worker 池关进笼子，防止某个源 JS 泄漏把整机内存吃穿（主进程默认不设，行为不变）。
   */
  memoryLimitMb?: number;
}

export function createWorkerSandboxPool(opts: WorkerSandboxOptions = {}): JsSandboxPool {
  const size = Math.max(1, opts.size ?? 4);
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
  const memoryLimitMb = Math.max(0, opts.memoryLimitMb ?? 0);
  const pool: PooledWorker[] = [];

  function spawn(): PooledWorker {
    const t0 = Date.now();
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      ...(memoryLimitMb ? { resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb } } : {}),
    });
    // 埋点：new Worker 会同步编译 WORKER_SRC（~35KB），属调用线程的同步开销
    recordBlock('worker-spawn', Date.now() - t0, `pool size=${pool.length + 1}`);
    worker.unref(); // 不阻止进程退出（测试/CLI 场景）
    const pw: PooledWorker = { worker, busy: false, sab: new SharedArrayBuffer(SAB_SIZE), evals: 0 };
    worker.postMessage({ kind: 'init', sab: pw.sab });
    return pw;
  }

  function refill(): void {
    // 超时/错误后补位，保持池容量
    while (pool.length < size) pool.push(spawn());
  }

  /**
   * worker 回收阈值：脚本在 worker 顶层 eval 里声明的 var/function 会永久留在
   * 该 worker 的全局作用域（每次调用又是独立 bindings，无法清理），常驻池跑久了
   * 全局累积导致 OOM。每次 eval 计数，达到阈值即终止换新——泄漏有界。
   *
   * `#629` **默认值按 vm 模式分档**（旧值一律 100）：
   *  · **vm 模式（默认）**：`#624` 的 `realm.reset()` 每次求值已把 context 全局复位，
   *    「靠回收兜底泄漏」的必要性很低；而**每回收一次，该 worker 上的 jsLib 作用域、
   *    natives 快照、V8 JIT 预热全部作废**，换新 worker 还要重编译 35KB WORKER_SRC。
   *    实测（七猫 1612 章，真网络）：100 → **3.23ms/章**、1000 → 更优，`lib` 段从
   *    0.4~0.7ms/次降到 ~0.05ms/次 ⇒ 整体提速约 32%。
   *    内存对照（4000 次 eval）：100 ⇒ ΔRSS 134MB，1000 ⇒ ΔRSS 152MB（heapUsed 均稳定在 ~70MB）
   *    ⇒ 放宽是安全的。
   *  · **非 vm 模式（`YUEDU_JS_VM=0` 回退档）**：没有 realm，泄漏只能靠回收 ⇒ 保持 100。
   * 环境变量 `YUEDU_WORKER_RECYCLE` 可显式覆盖（归因/兜底用）。
   */
  const RECYCLE_AFTER_EVALS = (() => {
    const explicit = Number(process.env['YUEDU_WORKER_RECYCLE'] ?? NaN);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return process.env['YUEDU_JS_VM'] === '0' ? 100 : 1000;
  })();

  function release(pw: PooledWorker, count = 1): void {
    pw.evals += count;
    if (pw.evals >= RECYCLE_AFTER_EVALS) {
      terminate(pw); // 从池中移除并杀掉；refill() 在下次取用时补位
      refill();
      flush(); // 池里可能还有排队作业，别等下次 eval 才发
      return;
    }
    pw.busy = false;
    // `#480-b`：worker 空出来了 ⇒ 立刻把排队作业发下去（原先靠 waiters 逐个唤醒）
    flush();
  }

  function terminate(pw: PooledWorker): void {
    const i = pool.indexOf(pw);
    if (i >= 0) pool.splice(i, 1);
    void pw.worker.terminate();
  }

  /**
   * `#480-b` **批量合流队列**：`eval()` 不再「来一个发一条」，而是先入队、
   * 在本轮 `setImmediate` 里把**排队中的作业合成一条消息**发给同一个 worker。
   *
   * 实测依据（1310 章 × 2 次 JS，`bench-ipc`）：单次 eval 固定开销 ~0.65ms，
   * 池 4→16 只从 1.80s 降到 1.65s ⇒ 卡的是**消息条数**，不是并行度。
   *
   * ★ 对调用方**完全透明**（`eval()` 签名与语义不变）：
   *   · 批内作业仍**顺序执行**（worker 单线程），语义与逐条发送一致；
   *   · 纯计算预算按批计时（RPC 等待照旧扣除）；批内 timeoutMs 相同才合批；
   *   · 单作业时就是「一条消息一个作业」，只多一次 ~1ms 的合流等待。
   */
  interface QueuedJob {
    code: string;
    bindings: Record<string, unknown>;
    hoistFns: string[];
    hoistVars: string[];
    /** `#611` step3 / `#624`：jsLib 与作用域/隔离模式（见 JsSandboxPool.eval 注释） */
    lib?: string;
    libFns?: string[];
    libVars?: string[];
    chain?: boolean;
    /** `#636` 第二层：lib 名字镜像到 realm 全局（白名单链路：eval opts → QueuedJob → postMessage） */
    libGlobalNames?: boolean;
    vm?: boolean;
    timeoutMs: number;
    rpc?: (method: string, args: unknown) => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }
  const queue: QueuedJob[] = [];
  let flushArmed = false;
  /** 单批上限（够大以摊薄往返，够小以免一个慢作业拖住整批太久） */
  const BATCH_MAX = Math.max(1, Number(process.env['YUEDU_SANDBOX_BATCH'] ?? 32) || 32);

  function armFlush(): void {
    if (flushArmed) return;
    flushArmed = true;
    // `setImmediate`：本轮 I/O 回调结束后立刻发，排队窗口 ≈ 0~1ms（不给单次求值添可感延迟）
    setImmediate(() => {
      flushArmed = false;
      flush();
    });
  }

  function flush(): void {
    refill();
    if (queue.length === 0) return;
    /**
     * `#628` **把批次均分给空闲 worker**（原实现让第一个 worker 吃掉整批 ⇒ 池退化成单线程）。
     *
     * 真实缺陷（2026-10-25 实测，真 worker 池）：`size=4` 下发 4 个各耗 100ms 的纯计算脚本，
     * 总耗时 **400ms** —— 完全串行。原因就是旧实现「第一个空闲 worker 取队首最多 BATCH_MAX(32) 个」：
     * 目录求值的 in-flight 只有 `YUEDU_TOC_CONC`(4) ⇒ 那 4 个全进了 worker[0] 的批，
     * worker[1..3] 空转 ⇒ 七猫 1612 章实测 9.8ms/章（≈ 单 worker 串行）。
     *
     * `#480-b` 的 bench 没暴露它：那次是「1310 章 + 无界 `Promise.all`」⇒ 队列很深，
     * 32 个一批自然会摊到 4 个 worker。可一旦调用方**有界并发**（正是 `#480-a` 的要求），
     * 合批就把并行度吃掉了 —— 两个优化互相抵消。
     *
     * 修法：批大小 = `min(BATCH_MAX, ceil(候选数 / 空闲 worker 数))`：
     *   · 浅队列（4 个 / 4 worker）⇒ 每 worker 1 个 ⇒ 真并行；
     *   · 深队列（128 个 / 4 worker）⇒ 每 worker 32 个 ⇒ 仍保留合批摊薄往返。
     * 语义不变：批内顺序执行、同批仍要求 timeoutMs 一致（预算语义必须一致）。
     */
    const idle = pool.filter((pw) => !pw.busy);
    if (idle.length === 0) return;
    const timeoutMs = queue[0]!.timeoutMs;
    // 只挑与队首**同超时**的作业（其余留在队列原位，等对应批次）
    const candidates: QueuedJob[] = [];
    for (let i = 0; i < queue.length; ) {
      if (queue[i]!.timeoutMs !== timeoutMs) {
        i += 1;
        continue;
      }
      candidates.push(queue.splice(i, 1)[0]!);
    }
    if (candidates.length === 0) return;
    const per = Math.max(1, Math.min(BATCH_MAX, Math.ceil(candidates.length / idle.length)));
    let k = 0;
    for (const pw of idle) {
      if (k >= candidates.length) break;
      const chunk = candidates.slice(k, k + per);
      k += chunk.length;
      runChunk(pw, chunk, timeoutMs);
    }
    if (k < candidates.length) {
      // 派不完的放回队首（保持原顺序）：worker 一释放就会再 flush，不会饿死
      queue.unshift(...candidates.slice(k));
    }
  }

  function runChunk(pw: PooledWorker, jobs: QueuedJob[], timeoutMs: number): void {
    pw.busy = true;
    const id = randomUUID();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 批预算 = 各作业截止时刻的**最大值**（同批 timeoutMs 相同，差值只有入队先后） */
    let deadline = Date.now() + timeoutMs;
    let pausedAt = 0;
    /**
     * `#779` D：一次求值的耗时画像（只用于诊断，不参与任何判定）。
     *   · `hostMs`：宿主 RPC 处理时长（`beginHostWork`→`endHostWork`，已从预算扣除）
     *   · `rpcLagMs`：worker 发出 RPC → 宿主收到消息的间隔（宿主事件循环排队）
     *   · `rpcCalls`：批内 RPC 次数
     * 三者 + `computeMs = wall - hostMs` 足以区分「纯计算到顶」与「宿主 RPC 排队」：
     * 超时日志里 `rpcLag` 占比大 ⇒ 宿主挤占；`compute≈budget` 且 `rpcLag` 小 ⇒ 真计算。
     */
    const dispatchedAt = Date.now();
    let hostMs = 0;
    let rpcLagMs = 0;
    let rpcCalls = 0;
    /** `#537` ② A/B 计量：位图 RPC 条数与合并前的 op 数（只在 YUEDU_BITMAP_DIAG=1 时输出） */
    let bitmapRpcMsgs = 0;
    let bitmapOps = 0;
    const noteEval = (
      outcome: 'ok' | 'timeout' | 'fail',
    ): { evalMs: number; hostMs: number; rpcLagMs: number; rpc: number } => {
      const wallMs = Date.now() - dispatchedAt;
      const computeMs = Math.max(0, wallMs - hostMs);
      const snippet = (jobs[0]?.code ?? '').replace(/\s+/g, ' ').slice(0, 90);
      const detail = `jobs=${jobs.length} ${outcome} rpc=${rpcCalls} rpcLag=${Math.round(rpcLagMs)} code=${snippet}`;
      // 只记「慢求值/失败」：普通求值不写采样环，避免把 400 条容量挤掉（日志行为不变）
      if (outcome !== 'ok' || computeMs >= 100) recordBlock('sandbox-eval', computeMs, detail);
      if (hostMs >= 100) recordBlock('sandbox-host', hostMs, detail);
      if (rpcLagMs >= 100) recordBlock('sandbox-rpc-lag', rpcLagMs, detail);
      if (process.env['YUEDU_BITMAP_DIAG'] === '1') {
        console.log(
          `[bitmap-diag] evalMs=${computeMs} rpc=${rpcCalls} bitmapRpc=${bitmapRpcMsgs} bitmapOps=${bitmapOps} jobs=${jobs.length} ${outcome}`,
        );
      }
      if (outcome === 'timeout') {
        console.warn(
          `[sandbox-js] JS_TIMEOUT compute=${Math.round(computeMs)}ms host=${Math.round(hostMs)}ms` +
            ` rpcLag=${Math.round(rpcLagMs)}ms rpc=${rpcCalls} budget=${timeoutMs}ms jobs=${jobs.length} code=${snippet}`,
        );
      }
      return {
        evalMs: Math.round(computeMs),
        hostMs: Math.round(hostMs),
        rpcLagMs: Math.round(rpcLagMs),
        rpc: rpcCalls,
      };
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    /**
     * `#759` 标「基础设施故障」（worker 崩溃 / 绑定不可克隆）—— 让调用方（图片解密）
     * 能区分「脚本自身抛错」与「这条通道坏了」：后者回落宿主同步实现，前者不重跑。
     * 超时（`JS_TIMEOUT`）单独按 `code` 判，不在这里标（它可能是脚本死循环）。
     */
    const markInfra = (err: unknown): unknown => {
      try {
        (err as Record<string, unknown>)['__yueduWorkerInfra'] = true;
      } catch {
        /* 冻结错误对象时忽略：调用方仍可读 message */
      }
      return err;
    };
    const failAll = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      noteEval('fail');
      const tagged = markInfra(err);
      for (const j of jobs) j.reject(tagged);
    };
    const onBudgetExhausted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const evalStats = noteEval('timeout');
      terminate(pw);
      for (const j of jobs) {
        j.reject(
          new EngineError('JS_TIMEOUT', 'parse', {
            engine: 'sandbox',
            sourceId: '-',
            rule: j.code.slice(0, 60),
            input: {
              timeoutMs,
              note: '纯计算超时（宿主 RPC 等待时间已扣除）',
              // `#779` D：把画像一并带出（`[sandbox-js]` 行与 /api/diag 之外的结构化副本）
              ...evalStats,
            },
            trace: [],
            retryable: false,
          }),
        );
      }
    };
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      if (pausedAt) return; // 宿主工作中：暂停计时（与单发同语义）
      timer = setTimeout(onBudgetExhausted, Math.max(0, deadline - Date.now()));
    };
    const beginHostWork = () => {
      if (settled || pausedAt) return;
      pausedAt = Date.now();
      if (timer) clearTimeout(timer);
    };
    const endHostWork = () => {
      if (settled || !pausedAt) return;
      const d = Date.now() - pausedAt; // 宿主耗时「还」给预算
      deadline += d;
      hostMs += d;
      pausedAt = 0;
      armTimer();
    };
    const onMessage = (m: { id?: string; kind?: string; callId?: number; job?: number; method?: string; args?: unknown; noReply?: boolean; at?: number; ok?: boolean; value?: unknown; batch?: boolean; values?: unknown; error?: string }) => {
      // worker 的 RPC 请求：按 `job` 路由回发起它的那个作业（批内顺序执行 ⇒ 一一对应）
      if (m.kind === 'rpc') {
        const callId = Number(m.callId);
        const owner = jobs[Number(m.job ?? 0) || 0] ?? jobs[0];
        const handler = owner?.rpc;
        if (!handler) {
          if (!m.noReply) void sabReply(pw, callId, { ok: false, error: 'no rpc handler on host' });
          return;
        }
        rpcCalls += 1;
        if (String(m.method) === 'bitmap') {
          bitmapRpcMsgs += 1;
          const ba = m.args as { op?: string; ops?: unknown[] } | undefined;
          bitmapOps += ba && ba.op === 'batch' && Array.isArray(ba.ops) ? ba.ops.length : 1;
        }
        // `#779` D：worker 的 `at` 是发出 postMessage 的时刻；差值 = 宿主事件循环排队（budget 仍在跑）
        if (!m.noReply) {
          const sentAt = Number(m.at);
          if (Number.isFinite(sentAt) && sentAt > 0) rpcLagMs += Math.max(0, Date.now() - sentAt);
        }
        beginHostWork();
        void Promise.resolve()
          .then(() => handler(String(m.method), m.args))
          .then((v) => {
            endHostWork();
            if (!m.noReply) {
              // `#537` ②：宿主标记了原始字节 ⇒ 走 status=3 直传（免 base64/JSON 化）
              const raw = v && typeof v === 'object' ? (v as Record<string, unknown>)[RAW_REPLY_FIELD] : undefined;
              if (raw instanceof Uint8Array) void sabReplyRaw(pw, callId, raw);
              else void sabReply(pw, callId, { ok: true, value: v ?? null });
            }
          })
          .catch((err: unknown) => {
            endHostWork();
            if (!m.noReply) void sabReply(pw, callId, { ok: false, error: String(err instanceof Error ? err.message : err) });
          });
        return;
      }
      if (m.id !== id || settled) return;
      settled = true;
      cleanup();
      noteEval('ok');
      if (m.ok && m.batch && Array.isArray(m.values)) {
        // 批量回包：逐作业兑现（每项形如 {ok:true,value} / {ok:false,error}）
        const vals = m.values as Array<{ ok?: boolean; value?: unknown; error?: string }>;
        for (let i = 0; i < jobs.length; i += 1) {
          const r = vals[i];
          if (r && r.ok) jobs[i]!.resolve(r.value as unknown);
          else {
            jobs[i]!.reject(new Error(r?.error ?? 'sandbox eval failed'));
          }
        }
      } else if (m.ok) {
        for (const j of jobs) j.resolve(m.value as unknown);
      } else {
        for (const j of jobs) j.reject(new Error(m.error ?? 'sandbox eval failed'));
      }
      release(pw, jobs.length);
    };
    const onError = (e: Error) => failAll(e);
    const onExit = () => failAll(new Error('sandbox worker 意外退出'));
    const worker = pw.worker;

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    armTimer();
    try {
      // `#771`：`postMessage` 的**结构化克隆在宿主线程同步执行**（大 result/bindings 可达几十 ms）
      probeEnter('sandbox:post');
      try {
        worker.postMessage({
          id,
          jobs: jobs.map((j) => ({
            code: j.code,
            bindings: j.bindings,
            hoistFns: j.hoistFns,
            hoistVars: j.hoistVars,
            ...(j.lib !== undefined ? { lib: j.lib } : {}),
            ...(j.libFns ? { libFns: j.libFns } : {}),
            ...(j.libVars ? { libVars: j.libVars } : {}),
            ...(j.chain ? { chain: true } : {}),
            // `#636`：同上白名单 —— 这条不发，worker 永远收不到（本轮实测踩过）
            ...(j.libGlobalNames ? { libGlobalNames: true } : {}),
            ...(j.vm ? { vm: true } : {}),
          })),
        });
      } finally {
        probeLeave();
      }
    } catch (e) {
      // 绑定里混进了不可克隆的值（函数/Proxy/DOM）——报出**键名**，便于定位是谁
      const bad: string[] = [];
      for (const j of jobs) {
        for (const [k, v] of Object.entries(j.bindings ?? {})) {
          try {
            structuredClone(v);
          } catch {
            bad.push(k);
          }
        }
      }
      cleanup();
      noteEval('fail');
      for (const j of jobs) {
        j.reject(
          markInfra(
            new Error(`worker 绑定不可克隆（键：${bad.join(',') || '未知'}）：${e instanceof Error ? e.message : String(e)}`),
          ),
        );
      }
      terminate(pw);
    }
  }

  const poolApi = {
    async eval<T = unknown>(evalOpts: {
      code: string;
      bindings?: Record<string, unknown>;
      timeoutMs?: number;
      /** 宿主 RPC：worker 内 java.ajax/webView/getString 回调（宿主异步执行，不阻塞） */
      rpc?: (method: string, args: unknown) => Promise<unknown>;
      /** 顶层声明提升名单（宿主 scanDecls 扫出）——见 JsSandboxPool.eval 注释 */
      hoistFns?: string[];
      hoistVars?: string[];
      /** `#611` step3 / `#624`：jsLib 分开下发（chain 模式进独立作用域） */
      lib?: string;
      libFns?: string[];
      libVars?: string[];
      chain?: boolean;
      /**
       * `#636` 第二层：lib 名字镜像到 realm 全局（只对「jsLib 是远程 URL 表」的源开）。
       * ⚠️ 这里是**白名单转发**：不加进类型与下面的 queue.push，字段会被静默丢掉
       * （本轮就栽在这 —— 宿主发了、worker 收不到，`libGlobalFlag=undefined`）。
       */
      libGlobalNames?: boolean;
      vm?: boolean;
    }): Promise<T> {
      const timeoutMs = evalOpts.timeoutMs ?? defaultTimeoutMs;
      return new Promise<T>((resolve, reject) => {
        queue.push({
          code: evalOpts.code,
          bindings: evalOpts.bindings ?? {},
          hoistFns: evalOpts.hoistFns ?? [],
          hoistVars: evalOpts.hoistVars ?? [],
          timeoutMs,
          ...(evalOpts.lib !== undefined ? { lib: evalOpts.lib } : {}),
          ...(evalOpts.libFns ? { libFns: evalOpts.libFns } : {}),
          ...(evalOpts.libVars ? { libVars: evalOpts.libVars } : {}),
          ...(evalOpts.chain ? { chain: true } : {}),
          ...(evalOpts.libGlobalNames ? { libGlobalNames: true } : {}),
          ...(evalOpts.vm ? { vm: true } : {}),
          ...(evalOpts.rpc ? { rpc: evalOpts.rpc } : {}),
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        armFlush();
      });
    },
  };
  // 品牌标记：createHybridJsEvaluator 据此区分「真 worker 池」与测试桩
  Object.defineProperty(poolApi, '__yueduWorkerPool', { value: true });
  return poolApi as JsSandboxPool & { __yueduWorkerPool: true };
}
