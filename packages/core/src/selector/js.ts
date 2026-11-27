/**
 * JS 求值器（L2-lite）
 *
 * ⚠️ 一期为「同步、未硬化」实现：直接用 new Function 在宿主线程执行。
 *    - 没有硬超时（依赖宿主 try/catch 兜底）。
 *    - 没有进程/worker 隔离（L4 会换成 worker_threads + node:vm 池）。
 *    - 仅用于受信任 / 已审核的书源；恶意书源风险见 docs/01-开发计划.md R7。
 *
 * 对齐 Legado evalJS 的 binding 集合：java / cookie / cache / source / book /
 * result / baseUrl / chapter / title / src / nextChapterUrl / rssArticle /
 * fromBookInfo / page / key，以及 this（指向解析上下文）。
 *
 * 返回值约定（对齐 Rhino）：脚本体最后对 `result` 的赋值即返回值；
 * 若脚本显式 `return X`，则以 X 为准。
 */

import { execFileSync } from 'node:child_process';
import { createCryptoJs } from './cryptojs';
import { makeJavaPackages, makeJavaImporterCtor, wireStrResponseFactory, wireOkhttpTransport, needsJavaBridgeL1, setJavaBridgeSourceLabel, nsProxy, expandJavaCollection } from './java-bridge'; // #77 Java 类桥（#158：判定收进 needsJavaBridgeL1）
// #526 worker 侧 android.graphics 的宿主执行端（唯一一份像素实现，worker 只持句柄）
import { AndroidBitmap, makeAndroidGraphicsNs } from './android-graphics';
// `#613`/`#615` java 文件面（getFile/readFile/getTxtInFolder/unzipFile/getZip*Content）
import { makeJavaFileApi } from './java-file';
// #160：缺省同步 HTTP 改为 worker 版（不依赖子进程），curl 保留为兜底。见 net/sync-fetch-worker.ts
import { defaultSyncFetch } from '../net/sync-fetch-worker';
import { recordTruncatedFetch } from '../net/truncated-log';
import { explainJsError } from './js-error';
import { createFastExprRunner, type FastExprResult } from './fast-expr'; // #633 纯表达式快速求值
// `#771` 冻结探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）：标记快路同步段，定位停摆是否落在这里
import { isFreezeProbeEnabled, probeEnter, probeLeave } from '../diag/freeze-probe';
// `#522` `org.jsoup.parser.Parser.unescapeEntities` 的权威实体解码（commons-text 表，与 Legado 同源）
import { unescapeHtml4, formatText } from './html-format';
// opencc-js：简繁转换（pnpm hoist 到根 node_modules，运行时 require 即可——装不上时降级为原文）
let OpenCC: any = null;
try { OpenCC = require('opencc-js'); } catch { /* 降级 */ }
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, privateDecrypt, publicDecrypt, privateEncrypt, publicEncrypt } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VariableStore, WebRendererHook } from '../contract/engine';
import { recordBlock } from '../diag/block-stats';
// `#749` D2：L1 路由 / l1w-drop / 单段硬超时 / curl 回退的计数（`/api/diag` 的数据来源）
import { noteL1Eligible, noteL1RoutedWorker, noteL1RoutedL1, noteL1Drops, noteL1Timeout } from '../diag/l1-stats';
import { handleDomCall } from './dom-rpc';
import { createDomClient, type DomClient } from '../sandbox/dom-backend';
import { RAW_REPLY_FIELD } from '../sandbox/worker-pool'; // `#537` ②：原始字节回包标记（SAB 协议归 worker-pool）
// `#314`：源登录信息 map 的 Java-Map 方法补齐全场共用一份（非枚举 + 幂等），
// 见 `source-login.ts` 头注 ②（上游 Rhino 对 java.util.Map 支持方括号与 .get 两种写法）。
import { attachJsonMapMethods } from './json-map';
// `#759` 图片解密字节描述符（见 image-bytes.ts 头注）：worker 下发裸字节、L1 就地还原成流
import { IMAGE_BYTES_KEY, isImageBytesResult, materializeImageBindings } from './image-bytes';
// `#409`：okhttp `Headers` 视图的唯一实现（宿主与 worker 共用一份源码）
import { okHeaders } from './ok-headers';
// `#410`：`cookie.setWebCookie` 的判据唯一实现（宿主与 worker 共用）
import { parseCookiePairs, webCookiePairs, applyWebCookie } from './web-cookie';
import { syncRenderHtml } from '../net/render';
import { prepareRequest } from '../net/url-prep';
// `#742`：URL 选项 `dnsIp`（IP 直连）—— 唯一实现在 `net/dns-ip.ts`；两条同步出口共用
import { dnsIpDispatcherFor, parseDnsIpList, urlHostnameOf } from '../net/dns-ip';
import { getVarValue } from './rule-analyzer';
import { withFormEncodedBody } from '../net/form-body';
import { DEFAULT_UA as UA_DEFAULT } from '../net/user-agent';
import { encodeUrlForCurl } from '../net/url-resolve';
// `#614`：`java.queryTTF(url)` 要把 `,{…}` 尾巴剥掉（那是给引擎的选项，不是 URL 一部分）
import { urlBodyOf } from '../source-match';
// `#614` 字体反爬：TTF 解析 + 轮廓串反查（上游 `analyzeRule/QueryTTF.java` 的移植）
import { parseTtf, replaceFont as replaceFontImpl, type QueryTtf } from '../font';
import { wireJavaNetTransport } from './java-net';
// `D11`：闸页（年满18岁声明）静默过闸 —— 判据唯一实现在 net/gate-pass.ts（L1 与 worker 宿主同源）
import { planAgeGatePass, applySessionCookie } from '../net/gate-pass';
import { relaxLetParamShadow } from './js-compat'; // #639 Rhino↔V8 语法宽松度差异（形参同名 let/const）
// `#333`：jsoup 仿真的唯一 DOM 实现（L1 直连、worker 经 RPC 用 nid 指回同一份）
import { JsoupDom, type JsoupDesc } from './jsoup-dom';
// `#411`：`java.importScript/cacheFile/readTxtFile/deleteFile` 的共享判据（L1 与 worker 宿主同源）
import {
  fileCacheKey,
  readScriptFile,
  writeScriptFile,
  deleteScriptFile,
  importScriptEnsure,
  downloadFileType,
  decodeDownloadPayload,
  mimeOfType,
  // `#636` 第二层：外部脚本取数的「重试 + 预算」（唯一实现，策略见 js-file.ts 头注）
  fetchScriptTextRetry,
  SCRIPT_FETCH_POLICY,
  type ScriptFetchAttempt,
} from './js-file';
import type { JsEvaluator } from './types';
// `#732` 外链脚本（jsLib / loginUrl / sortUrl）本地镜像 —— **网络优先、镜像兜底**（L1 与 worker 共用）
import { jsMirrorEtag, readJsMirror, writeJsMirror, noteJsMirrorFailure, isMarkupDocumentBody } from '../net/jslib-mirror';
import { SOURCE_FIELDS_KEY, BOOK_FIELDS_KEY, CHAPTER_FIELDS_KEY, RSS_FIELDS_KEY, INFOMAP_ENTRIES_KEY, INFOMAP_RAW_KEY, DOCUMENT_THUNK, RULE_CONTENT_KEY, JSON_CTX_KEY } from './types';

/**
 * `#743`：`jsoupSelect` 已随 `handleDomCall` 抽到 `dom-rpc.ts`（宿主 / DOM worker 共用一份）。
 * 这里保留 re-export，外部 import 路径不变。
 */
export { jsoupSelect } from './dom-rpc';

/**
 * `#333` 元素列表（L1 侧）—— **薄壳**：所有读改写都**实时**委托给 `JsoupDom`（活节点）。
 *
 * 旧实现是「字符串快照 + 选择器/索引回写」，跨不过删除后的身份变化（详见 jsoup-dom.ts 头注）；
 * 现在 L1 与 worker 共用 `JsoupDom` 那份**唯一实现**，这里只负责把方法名映射到它。
 */
/**
 * `#528` 造一个可链式**单个元素**（jsoup `Element`）。
 *
 * 从 `makeElementList` 里提出来，因为 `Element.clone()` / `Element.child(i)` / `Document.child(i)`
 * 都要能**单独**造元素（不是列表）。与 `Elements`（列表）共用这一份 `buildEl` 语义 —— 同一判据只留一处。
 */
/**
 * `#745` 回流元素的**写回**句柄：`{client, nid}` 指向原始 DOM worker 那张表里的节点。
 *
 * 为什么需要：`rehydrateWorkerJsoup` 把 worker 元素「快照 → 宿主副本」重建后，宿主侧再改
 * （`attr(k,v)` / `text(v)` / `remove()` / `appendChild`）只动了宿主副本，worker 树还停在旧值
 * —— 下一阶段若又走 worker（同一源的另一条规则），读到的就是错的。
 * 这里把写操作**同时异步派发**给原 client（fire-and-forget；读仍走宿主副本，因为方法面是同步的）。
 */
interface RemoteOrigin {
  client: DomClient;
  nid: number;
}

function makeJsoupElement(dom: JsoupDom, e: JsoupDesc, remote?: RemoteOrigin): Record<string, unknown> {
  const wr = (args: Record<string, unknown>): void => {
    if (!remote) return;
    void Promise.resolve(remote.client.call(args)).catch(() => undefined);
  };
  const el: Record<string, unknown> = {
    /**
     * `#640` `outerHTML` / `innerHTML` 必须**实时**读，不能存快照。
     *
     * 源里「用 `new org.jsoup.nodes.Element()` 拼卡片、再 `Elements.add(div)` 当 bookList 结果」
     * 这一整类写法（刺猬书库 jsLib `mkCard`）：元素**创建时是空壳**，内容全靠后续 `appendChild`。
     * 若存快照，`asNodes` 的 `isElementDescriptor` 会拿到的还是 `<div></div>`
     * ⇒ `descriptorToNode` 重新 parse 出空壳 ⇒ 条目子规则（`h3 a@text`）全空 ⇒ **列表 0 条**。
     *
     * 用 getter 读活节点（`dom.html` 已经是活节点语义），代价只在「取值时序列化一次」。
     */
    get outerHTML() {
      return dom.html(e.nid as number, 'outer');
    },
    get innerHTML() {
      return dom.html(e.nid as number, 'inner');
    },
    attrs: e.attrs,
    toString: () => dom.html(e.nid as number, 'outer'),
    html: () => dom.html(e.nid as number, 'inner'),
    outerHtml: () => dom.html(e.nid as number, 'outer'),
    /** `#528` jsoup `Element.text()` 两形态：无参读 / 有参 `text(String)` 写（返回自身便于链式） */
    text: (v?: unknown) => {
      if (v === undefined) return dom.text(e.nid as number);
      dom.setText(e.nid as number, String(v));
      wr({ op: 'setText', nid: remote?.nid, text: String(v) });
      return el;
    },
    /** jsoup `Element.ownText()`：只看直接子文本节点（次元小镇判付费关键词就用它） */
    ownText: () => dom.ownText(e.nid as number),
    tagName: () => String(e.attrs?.['tagName'] ?? ''),
    data: (k: unknown) => e.attrs[`data-${String(k)}`] ?? '',
    hasClass: (c: unknown) => ` ${String(e.attrs?.['class'] ?? '')} `.includes(` ${String(c)} `),
    isEmpty: () => String(dom.html(e.nid as number, 'inner')).trim() === '',
    /** 读：attr(k)；写：attr(k, v)（jsoup 两形态；返回自身便于链式） */
    attr: (n: unknown, v?: unknown) => {
      if (v === undefined) return dom.attr(e.nid as number, String(n));
      dom.setAttr(e.nid as number, String(n), String(v));
      wr({ op: 'setAttr', nid: remote?.nid, name: String(n), value: String(v) });
      return el;
    },
    /** `#528` jsoup `Element.clone()`：深拷贝，返回**独立元素**（不插父树）—— 找书啦 ruleToc 的净化套路 */
    clone: () => {
      const d = dom.descById(dom.clone(e.nid as number));
      return d ? makeJsoupElement(dom, d) : null;
    },
    /** `#528` jsoup `Element.child(index)`：第 index 个**子元素**（越界 null） */
    child: (i: unknown) => {
      const d = dom.child(e.nid as number, Number(i));
      return d ? makeJsoupElement(dom, d) : null;
    },
    /**
     * `#673` **jsoup 的 Node 导航面**（`nextSibling` / `previousSibling` / `parent` / `siblingElements`）。
     *
     * 此前这个面**一条都没有**（`grep nextSibling` 全仓 0 处），而源脚本用得很自然：
     * ```js
     * var viewCount = result.selectFirst("i.fa-eye");
     * viewCount = viewCount != null ? viewCount.nextSibling().text().trim() : "0";   // 媚色MM
     * ```
     * ⇒ `viewCount.nextSibling is not a function` ⇒ 详情整段 `RULE_PARSE@parse`（0 卡片之后
     * 下一段就炸，属于「修一处冒一处」的典型）。
     *
     * 语义照 jsoup：`nextSibling()` 返回 **Node**（可能是**文本节点** —— `<i></i> 1234` 就是），
     * 文本节点也要能被 `.text()`（jsoup `TextNode.text()`，不 trim）。只取元素的形态另有
     * `nextElementSibling()`。
     */
    nextSibling: () => {
      const s = dom.siblingNode(e.nid as number, 1);
      if (!s) return null;
      if (typeof s.nid === 'number') {
        const d = dom.descById(s.nid);
        return d ? makeJsoupElement(dom, d) : null;
      }
      return makeTextNodeBridge(String(s.text ?? ''));
    },
    previousSibling: () => {
      const s = dom.siblingNode(e.nid as number, -1);
      if (!s) return null;
      if (typeof s.nid === 'number') {
        const d = dom.descById(s.nid);
        return d ? makeJsoupElement(dom, d) : null;
      }
      return makeTextNodeBridge(String(s.text ?? ''));
    },
    nextElementSibling: () => {
      let s = dom.siblingNode(e.nid as number, 1);
      // 跳过文本节点继续找下一个兄弟（jsoup 语义：只认元素）
      let guard = 0;
      while (s && typeof s.nid !== 'number' && guard++ < 50) {
        const nid = typeof s.nid === 'number' ? s.nid : undefined;
        if (nid === undefined) break;
        s = null;
      }
      if (!s || typeof s.nid !== 'number') return null;
      const d = dom.descById(s.nid);
      return d ? makeJsoupElement(dom, d) : null;
    },
    parent: () => {
      const pid = dom.parentId(e.nid as number);
      if (pid === null) return null;
      const d = dom.descById(pid);
      return d ? makeJsoupElement(dom, d) : null;
    },
    parentNode: () => {
      const pid = dom.parentId(e.nid as number);
      if (pid === null) return null;
      const d = dom.descById(pid);
      return d ? makeJsoupElement(dom, d) : null;
    },
    siblingElements: () => makeElementList(dom, dom.siblingIds(e.nid as number).map((id) => dom.descById(id)).filter((x): x is JsoupDesc => !!x)),
    select: (s: unknown) => makeElementList(dom, dom.select(e.nid as number, String(s))),
    /** jsoup `Element.selectFirst`：命中返回元素，否则 null（次元小镇就是栽在它上面） */
    selectFirst: (s: unknown) => firstElementOf(dom, dom.select(e.nid as number, String(s))),
    /** jsoup `Element.getAllElements()`：自身 + 全部后代 */
    getAllElements: () => makeElementList(dom, dom.selectAll(e.nid as number)),
    remove: () => {
      dom.remove([e.nid as number]);
      wr({ op: 'remove', nids: [remote?.nid] });
      return el;
    },
    /**
     * `#640` jsoup `Element.appendChild(child)` —— 把 child **移动**到本元素末尾。
     *
     * 与 `new org.jsoup.nodes.Element(tag)` 配套（源里「用 DOM 拼卡片再 `toString()` 当 bookList
     * 的内容」这一整类写法：刺猬书库 jsLib `mkCard`）。child 可以是本方法造出的元素
     * （带 `__nid`），也可以是 `select()`/`child()` 拿到的活元素。
     */
    appendChild: (child: unknown) => {
      const c = child as { __nid?: unknown; __desc?: { nid?: number }; __remote?: RemoteOrigin } | null;
      const cid = typeof c?.__nid === 'number' ? c.__nid : c?.__desc?.nid;
      if (typeof cid === 'number') dom.append(e.nid as number, cid);
      // 写回：只有「同一个 DOM worker client」上的节点才能按远端 nid 追加
      const cr = c?.__remote;
      if (cr && remote && cr.client.id === remote.client.id) {
        wr({ op: 'append', nid: remote.nid, child: cr.nid });
      }
      return el;
    },
  };
  // `#528` 内部身份：`Elements.add(el)` / 列表级 `select()` 要按 nid 继续查，故留非枚举引用
  Object.defineProperty(el, '__nid', { value: e.nid, enumerable: false });
  Object.defineProperty(el, '__desc', { value: e, enumerable: false });
  if (remote) Object.defineProperty(el, '__remote', { value: remote, enumerable: false });
  return el;
}

/**
 * `#673` **文本节点桥**（jsoup `TextNode`）—— `nextSibling()` 撞到文本节点时返回它。
 *
 * 只实现源脚本真正会用的那几面：`text()`（原文，不 trim，与 jsoup 一致）、`toString()`、
 * `outerHtml()`、`nodeValue`；`attr()` 返回空（文本节点没有属性）。其余一律不提供 ——
 * 让「用错了 API」继续显式报错，而不是静默给假值。
 */
function makeTextNodeBridge(text: string): Record<string, unknown> {
  return {
    nodeType: 3,
    nodeValue: text,
    text: () => text,
    textNodes: () => [],
    ownText: () => text,
    html: () => text,
    outerHtml: () => text,
    toString: () => text,
    val: () => text,
    data: () => text,
    attr: () => '',
    hasAttr: () => false,
    size: () => 0,
    children: () => [],
    childNodes: () => [],
  };
}

/**
 * `#745` `remote` = 这批描述符在 DOM worker 里的原始 nid（逐项对齐），用于写回。
 * 只有 `rehydrateWorkerJsoup` 会传；普通宿主路径传 undefined ⇒ 行为与改前一致。
 */
function makeElementList(dom: JsoupDom, list: JsoupDesc[], remote?: { client: DomClient; nids: Array<number | null> }): unknown {
  /** 造一个可链式元素（`Element`）；`list` 级方法是另一个面（`Elements`）。实现见模块级 `makeJsoupElement` */
  const buildEl = (e: JsoupDesc, i: number): Record<string, unknown> => {
    const nid = remote?.nids[i];
    return makeJsoupElement(dom, e, remote && typeof nid === 'number' ? { client: remote.client, nid } : undefined);
  };
  const arr = list.map((e, i) => buildEl(e, i));
  const def = Object.defineProperty;
  const nids = () => arr.map((e) => (e as Record<string, unknown>)['__nid']).filter((x): x is number => typeof x === 'number');
  def(arr, 'size', { value: () => arr.length });
  def(arr, 'get', { value: (i: unknown) => arr[Number(i)] });
  def(arr, 'eq', { value: (i: unknown) => arr[Number(i)] });
  def(arr, 'first', { value: () => arr[0] });
  def(arr, 'last', { value: () => arr[arr.length - 1] });
  def(arr, 'eachText', { value: () => arr.map((e) => (e as { text: () => string }).text()) });
  def(arr, 'text', { value: () => arr.map((e) => (e as { text: () => string }).text()).join('\n') });
  def(arr, 'attr', {
    value: (n: unknown, v?: unknown) => {
      const head = list[0];
      if (!head) return '';
      if (v === undefined) return dom.attr(head.nid as number, String(n));
      for (const id of nids()) dom.setAttr(id, String(n), String(v));
      return arr;
    },
  });
  def(arr, 'toArray', { value: () => arr.slice() });
  def(arr, 'isEmpty', { value: () => arr.length === 0 });
  def(arr, 'html', { value: () => (list[0] ? dom.html(list[0].nid as number, 'inner') : '') });
  def(arr, 'outerHtml', { value: () => (list[0] ? dom.html(list[0].nid as number, 'outer') : '') });
  /** jsoup `Elements.select`：各元素子查询并集 */
  def(arr, 'select', {
    value: (s: unknown) => makeElementList(dom, nids().flatMap((id) => dom.select(id, String(s)))),
  });
  /** jsoup `Elements.remove()`：按身份删全部（实测源：悦读小说 doc.select(".articleHide").remove(); doc） */
  def(arr, 'remove', {
    value: () => {
      dom.remove(nids());
      return arr;
    },
  });
  def(arr, 'toString', { value: () => arr.map((e) => (e as { outerHTML: string }).outerHTML).join('') });
  /**
   * `#528` jsoup `Elements.add(Element)`（构造 `new Elements()` 后逐条追加；返回 `true`）。
   * 必须**同时**维护 `arr`（索引/长度）与 `list`（`text/attr/select` 等列表级方法的数据源）——
   * 找书啦 ruleToc 就是「`out = new Elements()` → `out.add(...)` 若干次 → `return out`」。
   */
  def(arr, 'add', {
    value: (el: unknown) => {
      const d = (el as Record<string, unknown> | null)?.['__desc'] as JsoupDesc | undefined;
      if (d) list.push(d);
      arr.push(el as Record<string, unknown>);
      return true;
    },
  });
  return arr;
}

/**
 * `#531` **worker 侧 jsoup 元素的回流重建**（宿主端；worker 那一半见 sandbox/worker-pool.ts 的
 * `__yueduSendable`）。
 *
 * 为什么需要：worker 求值结果跨 postMessage 前要过 `__yueduSendable` —— 元素包装带**可枚举
 * 函数属性**，结构化克隆必失败，旧行为退化成 `String(v)`，而 jsoup 的 `Elements.toString()`
 * 正是**全表 outerHTML 拼接** ⇒ N 个元素塌成 1 个字符串。实测（找书啦·求书互助 ruleToc 目录）：
 *   ① 阶段一 `chapterList`（`new Packages.org.jsoup.select.Elements()` 逐条 `add` 后 `return out`）
 *      的 2 个元素只回来 1 个字符串 ⇒ `els.length = 1`；
 *   ② 阶段二 `chapterName` 拿到的 `result` 是纯字符串（worker 里 `typeof result.hasClass`
 *      也不再是 function）⇒ 脚本 `e.hasClass(...)` 抛 ⇒ `tocError`、目录 0 章。
 *   （与 `#406` 的「整表被 join 成 1 个字符串」是**同一形状**的另一处。）
 *
 * 修法：worker 改送**描述符**（`__desc`：nid/outerHTML/innerHTML/text/attrs 全可克隆），
 * 宿主用 **worker 自己那份 `JsoupDom`**（活节点本来就在宿主）按 nid 重建活元素 —— 与规则桥
 * `java.getElements` 的「描述符回流 → mkList 重建」是**同一条通道**，只是方向相反。
 * ★ 收益是**身份不丢**：worker 里对节点做的 `attr(k,v)` 写入，宿主后续阶段（chapterName /
 *   chapterUrl）读得到 —— 找书啦的 `data-rid` 就是这么在阶段间传递的。
 *
 * ⚠️ 只认 **nid 是数字** 的描述符（`mkList` 元素的描述符来自 `rpc('dom')`，必有身份）；
 * 规则桥那种无身份的旧描述符（`nid == null`，靠 `jsoupSelect` 重解析 html）原样放过 ——
 * 重建出来的元素方法全都指不到节点，反而比字符串更坏。
 */
function isJsoupDesc(v: unknown): v is JsoupDesc {
  if (v == null || typeof v !== 'object') return false;
  const d = v as Partial<JsoupDesc>;
  return typeof d.nid === 'number' && typeof d.outerHTML === 'string';
}

/** 见 `isJsoupDesc` 头注：把 worker 回来的描述符重建为**活元素**（列表 / 单元素 / 原样放行） */
async function rehydrateWorkerJsoup(v: unknown, dom: JsoupDom, domClient?: DomClient | null): Promise<unknown> {
  const list = Array.isArray(v) ? (v as unknown[]) : null;
  const descs: JsoupDesc[] = list
    ? (list.length > 0 && list.every(isJsoupDesc) ? (list as JsoupDesc[]) : [])
    : isJsoupDesc(v) ? [v as JsoupDesc] : [];
  if (!descs.length) return v;
  /**
   * `#743`：A 轮之后，**描述符里的 nid 属于 DOM worker 那张表**（`hostRpc('dom')` 已整段转发），
   * 宿主这张 `jsoupDom` 没有这些 nid。若直接 `makeElementList(dom, descs)`，方法全都指不到
   * 节点 ⇒ `#531` 的「阶段一 attr(k,v) 写、阶段二读」全部读空（实测：`data-no`/`data-rid` 丢失）。
   *
   * 收尾：`describeAll` 取回**实时**描述 → 一次性 parse 回宿主表 ⇒ 得到宿主 nid；属性用实时 attrs。
   * `#745` **写回**：重建出的元素带 `__remote = {client, nid}`，宿主的写操作（setText/setAttr/
   * remove/append）会同时异步派发回原 DOM worker 树 ⇒ 两份树不再分叉。
   * 读仍走宿主副本（方法面是同步的，跨线程读只能靠副本）；副本是在**重建那一刻**的实时值。
   */
  /**
   * `#745` **一次 `describeAll`** 取回全部实时描述（旧实现是 N 次 `describe`，1500 个元素
   * 就是 1500 次跨线程往返，把 DOM worker 的队列和宿主事件循环都拖住）。
   */
  let liveDescs: Array<JsoupDesc | null> = descs;
  if (domClient) {
    try {
      const r = (await domClient.call({ op: 'describeAll', nids: descs.map((d) => d.nid) })) as unknown;
      if (Array.isArray(r) && r.length === descs.length) liveDescs = r as Array<JsoupDesc | null>;
    } catch {
      liveDescs = descs;
    }
  }
  const htmls = descs.map((d, i) => {
    const live = liveDescs[i];
    return typeof live?.outerHTML === 'string' ? live.outerHTML : typeof d.outerHTML === 'string' ? d.outerHTML : '';
  });
  /**
   * 没有 DOM worker 时，描述符里的 nid **本来就属于宿主这张表**（`hostRpc('dom')` 走的是
   * `handleDomCall(dom)`）⇒ 原样放行即可，**不能**重解析（那会造出一份新节点：属性的活值
   * 丢失，且同一元素在表里出现两份）。只有跨线程（nid 属于 worker 表）才需要重建。
   */
  const hostDescs = domClient
    ? parseFragments(dom, htmls).map((h, i) => {
      const live = liveDescs[i];
      if (!h) return descs[i] as JsoupDesc;
      return live && live.attrs && typeof live.attrs === 'object' ? { ...h, attrs: live.attrs } : h;
    })
    : descs;
  const remote = domClient ? { client: domClient, nids: descs.map((d) => d.nid) } : undefined;
  if (list) return makeElementList(dom, hostDescs, remote);
  const one = makeElementList(dom, hostDescs, remote) as unknown[];
  return one[0] ?? null;
}

/**
 * `#745` 把 N 个片段**一次 parse** 回宿主节点表（旧实现是逐片段 `dom.parse`）。
 *
 * 做法：每段包进一个标记元素 `<rh data-yrh="i">`，整串解析一次，再按标记取首个子元素。
 * 为什么值得：`JsoupDom` 每 parse 一次会额外常驻 `<html>/<head>/<body>` 三个包装节点
 * （`CAP=4096`）；1500 个元素就是多 4500 个节点 ⇒ **早期元素的 nid 直接被挤出表**
 * （返回的元素方法全指空）。批处理把包装节点从 3N 降到 N（标记本身）。
 *
 * 兜底：解不出子元素的片段（`<td>` 这类必须处于表格上下文、或 `<html>/<body>` 这类会被
 * 解析器合并的）逐个按旧路径 parse —— 正确性优先，只有少数形态付这个代价。
 */
function parseFragments(dom: JsoupDom, htmls: string[]): Array<JsoupDesc | null> {
  const out: Array<JsoupDesc | null> = new Array(htmls.length).fill(null);
  if (!htmls.length) return out;
  if (htmls.length === 1) {
    out[0] = parseOneFragment(dom, htmls[0] ?? '');
    return out;
  }
  const markers = htmls.map((h, i) => `<rh data-yrh="${i}">${h}</rh>`).join('');
  const rootNid = dom.parse(`<html><body>${markers}</body></html>`);
  for (const m of dom.select(rootNid, 'rh')) {
    if (typeof m.nid !== 'number') continue;
    const i = Number(m.attrs['data-yrh']);
    if (!Number.isInteger(i) || i < 0 || i >= htmls.length || out[i]) continue;
    out[i] = dom.child(m.nid, 0) ?? null;
  }
  for (let i = 0; i < htmls.length; i += 1) {
    if (!out[i]) out[i] = parseOneFragment(dom, htmls[i] ?? '');
  }
  return out;
}

/** 单个片段 → 宿主描述符（旧路径，也是批处理的兜底）。 */
function parseOneFragment(dom: JsoupDom, html: string): JsoupDesc | null {
  if (!html) return null;
  const rootNid = dom.parse(html);
  /**
   * `dom.parse` 返回的是 `<html>` 根，不是片段元素；`html(root,'outer')` 又因「脱壳」语义
   * 会直接回原始输入 ⇒ 只看根会拿到一个**属性为空**的空壳（实测：`data-rid` 恒空，而
   * `outerHTML` 看着是对的）。这里在解析出的文档里按 outerHTML 找回**那个元素本身**。
   */
  let host = dom.descById(rootNid);
  if (host && host.outerHTML !== html) {
    host = dom.selectAll(rootNid).find((x) => typeof x.outerHTML === 'string' && x.outerHTML === html) ?? host;
  }
  return host ?? null;
}

/** `selectFirst` 的公共收尾：有命中返回**元素**（不是列表），否则 null */
function firstElementOf(dom: JsoupDom, descs: JsoupDesc[]): unknown {
  if (!descs.length) return null;
  const r = makeElementList(dom, descs) as { length: number; [i: number]: unknown };
  return r.length ? r[0] : null;
}

/**
 * `#529` `org.jsoup.Connection.Method.*`。jsoup 里是 Kotlin/Java 枚举；源脚本只把它当值传给
 * `connection.method(...)`，故用**字符串常量**对齐（`String(Method.DELETE)` === `'DELETE'`）。
 */
const JSOUP_CONNECTION_METHOD: Record<string, string> = {
  GET: 'GET', POST: 'POST', DELETE: 'DELETE', PUT: 'PUT', HEAD: 'HEAD',
  OPTIONS: 'OPTIONS', PATCH: 'PATCH', TRACE: 'TRACE',
};

/**
 * `#529` `org.jsoup.Jsoup.connect(url)` —— jsoup 的 HTTP 客户端**构建器**（语料 2 源：
 * Aff 的 DELETE 写操作 · novelapi.baidu 的正文 `bodyAsBytes()` 解密）。
 *
 * ## 设计
 * · 只实现语料用到的面：`method(Method[,k,v])` · `header(k,v)` · `data(k,v)` · `userAgent(s)` ·
 *   `referrer(s)` · `cookie(k,v)` · `timeout(ms)` · `ignoreContentType(b)` · `ignoreHttpErrors(b)` ·
 *   `execute()` → `Response{body() bodyAsBytes() statusCode() headers() contentType()}`；
 * · **传输复用 L1 的 `syncHttp`**（与 `java.ajax` 同一条 HTTP 出口）⇒ 源级默认头 / 闸页静默过闸 /
 *   同步预算 / 超时语义**自动一致**，不另起第二条通道（本仓「同一判据只留一处」的纪律）；
 * · `bodyAsBytes()` 返回 **`Uint8Array`**（本仓 `decryptStr` 认字节数组；与 worker 侧同面）。
 *   ⚠️ 已知边界：同步出口拿到的是**已解码字符串**，故二进制响应（图片等）再转字节可能失真；
 *   语料两处都是 base64/ASCII 正文，不受影响。
 */
function makeJsoupConnection(rawUrl: unknown): Record<string, unknown> {
  const cfg: { url: string; method: SyncHttpRequest['method']; headers: Record<string, string>; body?: string; timeoutMs?: number } = {
    url: String(rawUrl ?? ''),
    method: 'GET',
    headers: {},
  };
  const formKv = (k: unknown, v: unknown) => `${encodeURIComponent(String(k ?? ''))}=${encodeURIComponent(String(v ?? ''))}`;
  const conn: Record<string, unknown> = {};
  conn['method'] = (m: unknown, k?: unknown, v?: unknown) => {
    cfg.method = String(m ?? 'GET').toUpperCase() as SyncHttpRequest['method'];
    if (k !== undefined) cfg.body = formKv(k, v);
    return conn;
  };
  conn['header'] = (k: unknown, v: unknown) => { cfg.headers[String(k)] = String(v ?? ''); return conn; };
  conn['userAgent'] = (s: unknown) => { cfg.headers['User-Agent'] = String(s ?? ''); return conn; };
  conn['referrer'] = (s: unknown) => { cfg.headers['Referer'] = String(s ?? ''); return conn; };
  conn['cookie'] = (k: unknown, v: unknown) => {
    const c = `${String(k)}=${String(v ?? '')}`;
    cfg.headers['Cookie'] = cfg.headers['Cookie'] ? `${cfg.headers['Cookie']}; ${c}` : c;
    return conn;
  };
  conn['data'] = (k: unknown, v: unknown) => { const kv = formKv(k, v); cfg.body = cfg.body ? `${cfg.body}&${kv}` : kv; return conn; };
  conn['timeout'] = (ms: unknown) => { const n = Number(ms); if (Number.isFinite(n) && n > 0) cfg.timeoutMs = n; return conn; };
  // jsoup 里这两项只放宽**客户端**校验；我们的 HTTP 出口本就不校验 content-type / 不因 4xx 抛错，故为 no-op（保留以便链式）
  conn['ignoreContentType'] = () => conn;
  conn['ignoreHttpErrors'] = () => conn;
  conn['execute'] = () => {
    assertHttpUrl(cfg.url); // `#464`：坏地址必须抛（与上游 `Jsoup.connect` 同语义）
    const res = syncHttp(cfg.method, cfg.url, cfg.body, cfg.headers, undefined, cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : undefined);
    const r = res as unknown as {
      body?: () => string;
      statusCode?: () => number;
      code?: () => number;
      headers?: () => Record<string, string>;
    };
    const body = typeof r?.body === 'function' ? String(r.body()) : String(res ?? '');
    const status = typeof r?.statusCode === 'function' ? r.statusCode() : typeof r?.code === 'function' ? r.code() : 200;
    const headers = typeof r?.headers === 'function' ? (r.headers() ?? {}) : {};
    return {
      body: () => body,
      bodyAsBytes: () => Uint8Array.from(Buffer.from(body, 'utf8')),
      statusCode: () => status,
      code: () => status,
      status: () => status,
      headers: () => headers,
      header: (n: unknown) => headers[String(n ?? '').toLowerCase()] ?? '',
      contentType: () => headers['content-type'] ?? '',
      toString: () => body,
    };
  };
  return conn;
}

/** org 命名空间桥（Legado：org.jsoup.Jsoup.parse(html).select(css)） */
function makeOrgStub(dom: JsoupDom): Record<string, unknown> {
  /** `Jsoup.parse` 与 `Jsoup.parseBodyFragment` 共用：都产出可链式 `Document`（jsoup 语义相近） */
  const parseDoc = (html: unknown, baseUri?: unknown): Record<string, unknown> => {
    // `#563` 第二参是**文档基址**（abs:href 靠它绝对化），必须收下传给 JsoupDom
    const nid = dom.parse(String(html ?? ''), typeof baseUri === 'string' && baseUri.trim() ? baseUri.trim() : undefined);
    const doc: Record<string, unknown> = {
      select: (sel: unknown) => makeElementList(dom, dom.select(nid, String(sel))),
      // ★ Document extends Element ⇒ doc 上也有 selectFirst / getAllElements / child（次元小镇 / 找书啦）
      selectFirst: (sel: unknown) => firstElementOf(dom, dom.select(nid, String(sel))),
      getAllElements: () => makeElementList(dom, dom.selectAll(nid)),
      // ★ Document.body() / head()（jsoup Document 特有）
      body: () => firstElementOf(dom, dom.select(nid, 'body')),
      head: () => firstElementOf(dom, dom.select(nid, 'head')),
      title: () => dom.select(nid, 'title')[0]?.text ?? '',
      attr: (n: unknown, v?: unknown) => {
        if (v === undefined) return dom.attr(nid, String(n));
        dom.setAttr(nid, String(n), String(v));
        return doc;
      },
      /** `#528` `Document.child(index)`（Document extends Element）—— 找书啦 `parseBodyFragment(…).body().child(0)` */
      child: (i: unknown) => {
        const d = dom.child(nid, Number(i));
        return d ? makeJsoupElement(dom, d) : null;
      },
      toString: () => dom.html(nid, 'outer'),
      html: () => dom.html(nid, 'outer'),
      /** `#528` `Document.text()` 两形态（读 / 写） */
      text: (v?: unknown) => {
        if (v === undefined) return dom.text(nid);
        dom.setText(nid, String(v));
        return doc;
      },
    };
    defAll(doc);
    return doc;
  };
  return {
    jsoup: {
      Jsoup: {
        parse: parseDoc,
        /**
         * `#528` `Jsoup.parseBodyFragment(html)`：jsoup 里是「按 body 片段解析」。本仓复用同一 `parse`
         * （jsdom 会把片段补成完整文档，`.body().child(0)` 取到的正是片段首个元素，与上游结果一致）。
         */
        parseBodyFragment: parseDoc,
        /** `#529` `Jsoup.connect(url)`（HTTP 客户端构建器；实现与设计见 `makeJsoupConnection` 头注） */
        connect: makeJsoupConnection,
      },
      /** `#529` `org.jsoup.Connection.Method.*`（源里 `org.jsoup.Connection.Method.DELETE`） */
      Connection: { Method: JSOUP_CONNECTION_METHOD },
      /** `#528` `org.jsoup.select.Elements`：`new Elements()` 造空列表，逐条 `add(el)`（找书啦 ruleToc） */
      select: {
        Elements: function Elements() {
          return makeElementList(dom, []);
        },
      },
      /**
       * `#640` `new org.jsoup.nodes.Element(tag)` —— 上游是真 Java 类可 `new`，源里用它**拼卡片**：
       * ```js
       * var div = new org.jsoup.nodes.Element('div'); div.appendChild(h3); … return div.toString();
       * ```
       * 此前只补了 `select.Elements`，`org.jsoup.nodes` 是 undefined ⇒
       * `Cannot read properties of undefined (reading 'Element')`（刺猬书库 jsLib `mkCard`）。
       * 返回的仍是**可链式元素**（`attr/text/appendChild/outerHtml/toString` 全在）。
       */
      nodes: {
        Element: function Element(tag: unknown) {
          const nid = dom.createElement(String(tag ?? 'div'));
          const d = dom.descById(nid);
          return d ? makeJsoupElement(dom, d) : null;
        },
      },
      /**
       * `#522` `org.jsoup.parser.Parser.unescapeEntities(text, inAttribute)` —— 语料高频（7 处）：
       * 存书啦 / 格格党网 等用它把 HTML 实体统一解码（注释原文：「实体统一交 jsoup Parser.unescapeEntities
       * 解码（String.replace 只换首个的坑已避）」）。语义 = **commons-text `unescapeHtml4`**
       * （253 命名实体 + 数字实体，与本仓 `getString` 收尾、Legado `StringEscapeUtils` 同一张表）。
       * `inAttribute` 参数对齐上游签名但**不影响结果**（我们按整串解码，语料两种调用结果一致）。
       */
      parser: {
        Parser: {
          unescapeEntities: (text: unknown) => unescapeHtml4(String(text ?? '')),
        },
      },
    },
  };
}
function defAll(o: Record<string, unknown>): void {
  Object.defineProperty(o, 'size', { value: () => 1 });
}

/**
 * `#474`：把 `org` 补进 `Packages` 命名空间（源里 `Packages.org.jsoup.Jsoup.parse(html)` 的写法）。
 *
 * 与裸全局 `org` 共用**同一个** `orgNs`（**不写第二份实现**，`#467`/`#313` 的教训）；
 * 其余键原样透传给 `makeJavaPackages()`（它的 Proxy 负责对未知包留痕兜底）。
 * worker 侧同款见 `sandbox/worker-pool.ts` 的 `orgNs` + `Packages` proxy。
 */
function withOrgPackage(pkgs: Record<string, unknown>, orgNs: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(pkgs, {
    get: (t, prop: string | symbol) => (prop === 'org' ? orgNs : (t as Record<string, unknown>)[prop as string]),
  });
}

/**
 * 同步 HTTP（Legado java.ajax/post/get 需要在脚本内同步拿响应）。
 * Node 主线程无同步 fetch，用系统 curl（Windows 10+ / macOS / Linux 均自带）。
 * 返回「可链式」的 body 字符串：附加 .body() / .headers() / .code()（Legado StrResponse 语义）。
 */
/**
 * 同步请求预算：java.ajax/connect 等同步 HTTP 阻塞事件循环（execFileSync）。
 * 部分源规则对每个列表项发一次 ajax（几十项 × 最长 10s）——单次事件循环内累计
 * 阻塞超预算后快速失败，防止整服务卡死数分钟。宏任务间（setImmediate）重置。
 */
const SYNC_BUDGET_MS = 20_000;

/**
 * 单次**同步** HTTP 请求的默认超时（毫秒）。
 *
 * 为什么要 15s 而不是 10s：站点响应抖动极大（实测 51acgs.com/category 在 2.1s~14.7s 之间），
 * 10s 会把「其实能出内容的源」判成空 body，下游再报晦涩的 `JSON.parse('')` 错误。
 * 宿主可经 `JsEvalOptions.syncTimeoutMs` 覆盖。
 *
 * ⚠️ **与 worker 求值超时的关系**：`createHybridJsEvaluator` 给含 HTTP 的脚本传
 * `本值 + 5s` 作为 worker 求值超时。两者必须保持这个大小关系，否则 worker 会先在 HTTP 超时之前被 kill
 * （改这个值时要一起看 `createHybridJsEvaluator` 里的注释）。
 */
const SYNC_HTTP_TIMEOUT_DEFAULT_MS = 15_000;

/**
 * 脚本里出现这些 = 会发**同步** HTTP（用于给 worker 求值分级设超时）。
 * `#411`：`importScript` / `cacheFile` 未命中时也要下载（18AV 登录页会 `importScript` 拉 artplayer.js）
 * —— 不纳入就会吃 10s 池超时被 kill（表现 `JS_TIMEOUT`），而 L1 的同步 HTTP 超时是 15s。
 */
const HTTP_API_RE = /java\.(ajax|ajaxAll|post|get|connect|head|getStrResponse|importScript|cacheFile|queryTTF|queryBase64TTF)\s*\(/;
/**
 * `#779` **content 动作的纯计算求值预算**（默认 20s）。
 *
 * 背景：content 规则常见「大批量纯计算」（哔咔 40 张图逐张签名/解码，**不含** `java.ajax`）
 * ⇒ 吃不到 `syncTimeoutMs + 5s` 分级，落 worker 池默认 **10s**。真机现场：`content 已 8s`
 * 后立刻 `JS_TIMEOUT@parse`（总时长约 10s），同窗口另一 attempt 正常跑完（`PICADIAG 图数=40`）。
 *
 * 只有 **content 动作**（由 hub 按 `action` 注入 `EngineContext.jsComputeTimeoutMs`）才用它；
 * detail 的 75s 行动预算、普通求值的 10s、含 HTTP 的 `+5s` 分级全部不动。
 *
 * 回退（一行）：环境变量 `YUEDU_JS_CONTENT_TIMEOUT_MS=10000`；设 `0`/非法值 = 不覆盖
 * （content 回到池默认 10s，与改动前逐字一致）。
 */
const CONTENT_COMPUTE_TIMEOUT_DEFAULT_MS = 20_000;
export function contentComputeEvalTimeoutMs(): number | undefined {
  const raw = process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return CONTENT_COMPUTE_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}
let syncBudgetUsed = 0;

/**
 * `#749` D2 **单段 L1 求值的硬超时**（`YUEDU_L1_MAX_MS`，默认 60s，`0` = 关闭）。
 *
 * 为什么需要：`l1-eval` 是**主线程同步求值**，历史最长单段 **145s**（`blocks` 里可直接读到）。
 * 那段时间里服务完全不可抢占 —— 一个慢源就能把整站拖成「假死」。
 *
 * ## 能做到什么 / 做不到什么（必须写清楚，否则会高估这条护栏）
 * L1 求值跑在 `new Function` 里，V8 **没有**从外部中断同步脚本的手段（`while(true)` 无法被
 * setTimeout/AbortSignal 打断）。所以这里实现的是**协作式截止**：
 *   · 在每个**同步 HTTP 出口**（`syncHttp`，L1 全部网络请求的唯一闸口）前后检查截止时刻；
 *   · 到点 ⇒ 抛 `L1EvalTimeoutError`（`code='L1_TIMEOUT'`），中止本段并让调用方看到明确错误；
 *   · 纯 CPU 死循环仍拦不住（那条路只能靠独立子进程，见 D2 ④ 的评估）。
 *
 * ## 为什么默认 60s
 * 历史 max 145s 属于要收掉的长尾；而单次同步 HTTP 缺省 15s、`SYNC_BUDGET_MS` 20s，
 * 一段规则卡到 60s 基本只剩三种原因：源站吊住 + 多次重试、闸页重放风暴、或超长 CPU 解析。
 * 60s 给了 4 倍单请求余量，同时把 145s 长尾截掉一半以上。调参用 `YUEDU_L1_MAX_MS`。
 */
const L1_MAX_MS_DEFAULT = 60_000;
/** 当前 L1 求值段的截止时刻（0 = 无截止）；嵌套求值取**更早**的那个 */
let l1Deadline = 0;
/** 当前截止对应的限制值（用于算 elapsed 与错误文案） */
let l1LimitMs = 0;
/** 求值嵌套深度（0 = 不在 L1 求值中；只有 >0 时 `syncHttp` 才按截止抛错） */
let l1Depth = 0;
/** 本段已发起的同步 HTTP 次数 / 最后一个 URL（诊断用） */
let l1ReqCount = 0;
let l1LastUrl = '';
/** 超时后已跑完（无法中止）的段只留痕一次，避免刷屏 */
let l1OverrunWarned = false;

/**
 * `L1_TIMEOUT`：**与 `JS_TIMEOUT` 刻意区分**。
 *
 * | 错误 | 来源 | 含义 | 处置 |
 * |---|---|---|---|
 * | `JS_TIMEOUT` | worker 池（`worker-pool.ts`） | worker **被 terminate**（纯计算超预算） | 重试/换 worker |
 * | `L1_TIMEOUT` | 本文件（L1 同步求值） | 宿主主线程上的**单段 L1** 到点中止 | 降级/换源/缩减规则；**不是**死循环 |
 *
 * 混用会让日志里「到底是 worker 被杀还是主线程被拖住」分不开 —— 这两类问题的修法完全不同。
 */
export class L1EvalTimeoutError extends Error {
  readonly code = 'L1_TIMEOUT';
  constructor(
    readonly limitMs: number,
    readonly elapsedMs: number,
    readonly requestCount: number,
    readonly lastUrl: string,
  ) {
    super(
      `L1_TIMEOUT: 单段 L1 求值超过 ${limitMs}ms（已 ${elapsedMs}ms，同步 HTTP ${requestCount} 次` +
        `${lastUrl ? `，最后一次 ${lastUrl.slice(0, 160)}` : ''}）——已中止，避免主线程继续被占用`,
    );
    this.name = 'L1EvalTimeoutError';
  }
}

/** 判断是否本仓的 `L1_TIMEOUT`（跨 bundle/多实例时 `instanceof` 不可靠，故同时认 `code`） */
export function isL1EvalTimeoutError(e: unknown): boolean {
  if (e instanceof L1EvalTimeoutError) return true;
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'L1_TIMEOUT';
}

/** 读 `YUEDU_L1_MAX_MS`（未设 ⇒ 60s；`0` ⇒ 关闭；非法值 ⇒ 回默认） */
function l1TimeoutLimitMs(): number {
  const raw = process.env['YUEDU_L1_MAX_MS'];
  if (raw === undefined || raw === '') return L1_MAX_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : L1_MAX_MS_DEFAULT;
}

/**
 * 在同步 HTTP 闸口检查截止。**只在 L1 求值中生效**（`l1Depth > 0` + 有截止），
 * 否则 `syncHttp` 被引擎/探针直接调用时会被误杀。
 */
function l1DeadlineCheck(phase: string, url?: string): void {
  if (!l1Deadline || l1Depth === 0) return;
  if (url) l1LastUrl = url;
  const now = Date.now();
  if (now <= l1Deadline) return;
  const elapsed = Math.max(0, now - (l1Deadline - l1LimitMs));
  const detail = `${phase} req=${l1ReqCount} ${l1LastUrl.slice(0, 120)}`;
  noteL1Timeout(l1LimitMs, elapsed, detail);
  recordBlock('l1-timeout', elapsed, detail);
  throw new L1EvalTimeoutError(l1LimitMs, elapsed, l1ReqCount, l1LastUrl);
}

/** 同步 HTTP 请求（`syncFetch` 注入点的形状） */
export interface SyncHttpRequest {
  /** `#529`：jsoup `Connection.Method` 全集（传输层原样交 `fetch`，见 `syncHttp` 同处注释） */
  method: 'GET' | 'POST' | 'HEAD' | 'DELETE' | 'PUT' | 'PATCH' | 'OPTIONS';
  url: string;
  body?: string;
  headers: Record<string, string>;
  /** 期望超时（毫秒）——传输实现自行换算 */
  timeoutMs: number;
  /**
   * `#614` 需要**原始字节**（`java.queryTTF(url)` 取字体）。
   * 给了就在响应里回 `bytes`；不给走原来的文本解码（默认路径，行为完全不变）。
   */
  binary?: boolean;
  /**
   * **不跟随重定向**（`#387c`）。
   *
   * 上游 `JsExtensions.kt:591/618/645`：`java.get` / `java.head` / `java.post` 三个 API 全部
   * `.followRedirects(false)` —— 注释原话「js实现重定向拦截」：**由源脚本自己处理 3xx**。
   * 语料里的用法就是 `if (/^30/.test(java.get(u,{}).statusCode())) { …跟随 Location… }`
   * （📂m.miduxs、📂97k.cc 等 3 源 / 12 处 `statusCode()`）。
   *
   * ⚠️ 只作用于这三个 API —— `java.ajax` / 规则请求走上游 `AnalyzeUrl`（`HttpHelper.kt:68`
   * `.followRedirects(true)`），**必须继续跟随**。
   */
  noRedirect?: boolean;
  /**
   * `#742` 源选项 `dnsIp`（IP 直连）：传输层只把「域名→地址」换成给定 IP（多值逗号分隔），
   * **Host 头与 TLS SNI 仍按 URL 域名**（对齐上游 `AnalyzeUrlNetworkOptions.buildScopedDns`）。
   * 缺省/非法值 ⇒ 正常解析。
   */
  dnsIp?: string;
}

/** 同步 HTTP 响应。`setCookie` 单独成数组：多条 Set-Cookie 合并成一条会被 Expires 里的逗号破坏。 */
export interface SyncHttpResponse {
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
  body: string;
  /**
   * `#614` 响应体**原始字节**（只有请求带 `binary: true` 时才有）。
   *
   * 为什么必须单独开一路：`body` 是 utf-8 解码后的字符串，字体/图片这类二进制
   * 经它一转就不可逆（非法字节变 U+FFFD）。这条通路只给「明确要字节」的调用方用
   * （目前只有 `java.queryTTF(url)`），默认不取 ⇒ 不影响既有文本链路。
   */
  bytes?: Uint8Array;
  /**
   * 响应体是否被**体积护栏**截断（`#152`）。
   * worker SAB 传输会透传；curl 回落拿不到这个信息（缺省 undefined）。
   * 消费点：`syncHttp` 里登记进截断环，随引擎结果回传前端 ⇒ 「被截断」与「返回空」分得开。
   */
  truncated?: boolean;
}

/**
 * `#742` 把 URL 选项的 `dnsIp` 变成 `fetch` 的 `dispatcher`（**只用于未注入 HttpClient 的回退路**）。
 * 非法值 ⇒ `parseDnsIpList` 已留痕并返回空 ⇒ 这里回 `{}`，`fetch` 完全按旧行为走。
 */
function dnsIpFetchInit(url: string, dnsIp: string): { dispatcher?: unknown } {
  const ips = parseDnsIpList(dnsIp).ips;
  const first = ips[0];
  if (!first) return {};
  return { dispatcher: dnsIpDispatcherFor(urlHostnameOf(url), first) };
}

/**
 * `curlSyncFetch` 失败的**分类** —— 纯函数，导出以便单测（不依赖本机能否 spawn 子进程）。
 *
 * ## 为什么要分类（2026-09-29 踩的坑，挂账 `#159`）
 *
 * 原来两类失败共用「静默 `body = ''`」，于是**环境问题伪装成站点问题**：
 * `execFileSync` 起不来 curl（`EBUSY`/`ENOENT`/`EACCES`）时，**所有** `java.ajax` 恒返回空串，
 * 表现成「站点返回空 / 规则报 RULE_PARSE」。我据此把 ⚡Linpx 的失败当成了引擎缺陷，
 * 实际是本环境 spawn 不可用（判据：`[ajax:L1] ← 0 len=0`，而 bash 里 `curl` 是好的）。
 *
 * | 分类 | 判据（Node 官方示例的写法） | 含义 | 处理 |
 * |---|---|---|---|
 * | `'spawn'` | **`err.code` 有值**（`EBUSY`/`ENOENT`/`EACCES`…） | 进程**根本没跑起来** ⇒ 环境问题，且是**全局性**的 | **留痕**（once/进程）+ 给出自查方向 |
 * | `'exit'` | `err.code` 无值（`err.status` 是退出码，如超时 28） | 进程跑了、网络失败 | 静默（语料里成千次，属预期） |
 *
 * 依据：Node 文档 `child_process.execFileSync()` 的官方示例 —— 它以 `err.code` **是否有值**
 * 区分「spawning child process failed」与「exited with non-zero exit code」两种情形。
 * 本机实测（2026-09-29）：spawn 失败时 `code='EBUSY'`、`status=null`、`stdout/stderr=undefined`，与示例一致。
 */
export function classifySyncFetchFailure(e: unknown): 'spawn' | 'exit' {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code !== '' ? 'spawn' : 'exit';
}

/** `'spawn'` 分类的留痕开关（每进程只说一次，避免批量时刷屏） */
let curlSpawnWarned = false;

/**
 * 同步传输实现：**curl 子进程**。
 *
 * ⚠️ **自 `#160`（2026-09-29）起它不再是缺省** —— 缺省是 `defaultSyncFetch`（worker 版，
 * 不依赖子进程，见 `net/sync-fetch-worker.ts`）；本函数保留两用：
 *  1. `YUEDU_SYNC_FETCH=curl` 时的显式选择（回退/对照）；
 *  2. 本机没有 `SharedArrayBuffer`/`Atomics.wait`/`worker_threads` 时的**自动兜底**。
 *
 * 为什么同步：`java.ajax` 在源脚本里是同步语义（`var s = java.ajax(u); JSON.parse(s)`），
 * 而 `HttpClient.request` 是 Promise —— 进程内没有「同步等待 Promise」的干净手段。
 * worker 版用的是 `Atomics.wait` + 共享内存（同一条约束下的另一条路）。
 *
 * 想换成别的 HTTP 栈（或测试打桩）→ 传 `JsEvalOptions.syncFetch`；
 * 需要走注入 HttpClient（代理/mock/统一超时）的脚本请走 worker 池
 * （`HybridEvalOptions.http`，宿主异步 fetch，worker 内同步 RPC 回宿主）。
 */
export function curlSyncFetch(req: SyncHttpRequest): SyncHttpResponse {
  const secs = Math.max(1, Math.round(req.timeoutMs / 1000));
  // `#387c`：`noRedirect` 时不加 `-L`（curl 默认就不跟随）——与 worker 侧 `redirect:'manual'` 对齐
  const args = ['-s', ...(req.noRedirect ? [] : ['-L']), '--max-time', String(secs), '-X', req.method];
  /**
   * `#742` `dnsIp` → curl 的 `--resolve`（等价语义：只改「域名→地址」，Host/SNI 与证书仍按域名）。
   * 多值只取**第一个合法地址**：curl 这条是 `YUEDU_SYNC_FETCH=curl` / 无 SAB 的兜底通路，
   * 主通路（worker SAB 与注入 HttpClient）都已实现按序切换。
   */
  if (req.dnsIp) {
    const firstIp = parseDnsIpList(req.dnsIp).ips[0];
    if (firstIp) {
      const m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^/?#]+)/.exec(req.url);
      const hostPort = m ? (m[1] ?? '').replace(/^\[|\]$/g, '') : '';
      const defaultPort = /^https:/i.test(req.url) ? '443' : '80';
      const hasPort = /:(\d+)$/.test(hostPort);
      const [h, p] = hasPort ? hostPort.split(':') : [hostPort, defaultPort];
      if (h) args.push('--resolve', `${h}:${p}:${firstIp}`);
    }
  }
  const headerFile = join(tmpdir(), `yuedu-curl-h-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  /**
   * `#614` 二进制模式：curl 的 stdout 会被当文本解码（非法字节变 U+FFFD，不可逆），
   * 所以二进制响应**必须落文件再读**。
   */
  const outFile = req.binary
    ? join(tmpdir(), `yuedu-curl-b-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    : '';
  args.push('-D', headerFile);
  if (outFile) args.push('-o', outFile);
  for (const [k, v] of Object.entries(req.headers)) {
    const val = v == null ? '' : String(v);
    /**
     * ⚠️ **curl 的 `-H 'Name:'` 语义是「删除该头」，不是「发空值头」**（2026-09-22 修，缺陷类AI）。
     * 要真的发出一个空值头必须用**分号**形式 `-H 'Name;'`（curl 文档原文：
     * "If you send the custom header with no-value then its header must be terminated with a semicolon"）。
     *
     * 为什么这条会毁掉一个源（实测 🏷七猫[官方]v3.1 正文 `验签失败 44010120`）：
     * 该源把签名头写成 `{…, 'AUTHORIZATION':'', 'qm-params':''}` 并对**全部字段**算 sign ——
     * 站点按「实际收到的字段集」重算 sign。curl 把两个空值头删掉后，服务端只看到 7 个字段
     * → sign 不一致 → 拒绝。**同一次运行里引擎侧请求（走 undici fetch，空值头能正常发出）却全部正常**
     * —— 于是症状表现为「只有 `java.ajax` 的请求失败」，极易误判成站点改版。
     * 站点侧因果对照（同一签名、只改是否带这两个头）：
     *   · 带 → 200 / 9500 字节（`data.content` 有值）；不带 → 115 字节 `{"code":"44010120","title":"验签失败"}`。
     * 这与 #81（header 规则缺 source）/ 空值头必须保留 是同一族：**空值头是源作者的有意声明**。
     */
    args.push('-H', val === '' ? `${k};` : `${k}: ${val}`);
  }
  if (req.body !== undefined && req.body !== '') args.push('--data-binary', req.body);
  /**
   * ★ **URL 必须 percent-encode 再交给 curl**（`#606`，2026-10-24）。
   *
   * curl 不像 okHttp（上游 `Request.url(String)` → `HttpUrl.get()`）那样把非 ASCII 自动
   * UTF-8 编码：原始中文 URL 给 curl ⇒ `http_code=000`（0 字节）；编码后 ⇒ 200。
   * 语料里常见（`https://qyyuapi.com/sy/js/G站漫画/jsLib.js`、`…/dy/js/剧迷/loginUrl.js`），
   * 不编码的表现是「请求恒空」，极易误判成站点/规则问题。
   * 判据在 `net/url-resolve.ts` 的 `encodeUrlForCurl`（与 engine-legado 的 jsLib 下载同一份）。
   */
  args.push(encodeUrlForCurl(req.url));
  let body = '';
  const t0 = Date.now();
  try {
    // 二进制走「落文件」，见 outFile 处注释（stdout 直接当 utf-8 会毁字节）
    // `#773`：这条 `execFileSync(curl)` 是主线程同步阻塞，但此前只有 `recordBlock('curl')`
    // （返回后才记）⇒ 冻结窗口里看不出「在等 curl」。补 marker + 慢调用日志（仅探针开启时）。
    probeEnter('curl:sync');
    try {
      body = req.binary
        ? (execFileSync('curl', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, maxBuffer: 1024 * 1024 }) as unknown as string) ?? ''
        : execFileSync('curl', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    } finally {
      probeLeave();
      const ms = Date.now() - t0;
      if (ms >= 500 && isFreezeProbeEnabled()) {
        console.log(`[curl-sync] ${ms}ms max=${secs}s ${req.method} ${req.url.slice(0, 120)}`);
      }
    }
  } catch (e) {
    const kind = classifySyncFetchFailure(e);
    if (kind === 'spawn' && !curlSpawnWarned) {
      // ★ 环境级失败：**不能静默**（铁律 4）。它会让**所有** java.ajax 恒空，
      //   而症状长得像「站点返回空/规则解析失败」⇒ 极易被误判成源侧或引擎缺陷。
      curlSpawnWarned = true;
      const er = e as { code?: string; message?: string };
      console.warn(
        `[syncfetch] ⚠️ 起不了 curl 子进程（code=${er.code ?? '?'}）：` +
          `**本进程内所有 java.ajax 都会返回空串** ⇒ 表现为「站点返回空 / RULE_PARSE」，` +
          `但真因是环境。自查：① shell 里 \`curl -sS -o /dev/null -w '%{http_code}' https://example.com\` 是否 200；` +
          `② 本机是否禁止子进程（沙箱/杀软/受限环境）。` +
          `绕开办法：让该源的规则脚本走 **worker 池**（worker 的 java.ajax 经 RPC 回宿主异步 fetch，不依赖 curl）。` +
          `首例 URL=${req.url.slice(0, 120)}`,
      );
    }
    if (process.env.YUEDU_DEBUG_SYNCFETCH) {
      const er = e as { status?: number; code?: string; stderr?: unknown; message?: string };
      console.error('[syncfetch] curl 失败', kind, req.method, req.url, 'status=', er.status, 'code=', er.code,
        'msg=', er.message, 'stderr=', String(er.stderr ?? '').slice(0, 200));
    }
    body = '';
  } finally {
    // 埋点：这是「事件循环被同步阻塞」的头号来源，见 diag/block-stats.ts
    recordBlock('curl', Date.now() - t0, `${req.method} ${req.url}`);
  }
  const headers: Record<string, string> = {};
  const setCookie: string[] = [];
  let status = 0;
  try {
    const raw = readFileSync(headerFile, 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^HTTP\/\d[\d.]*\s+(\d{3})/.exec(line);
      if (m) { status = Number(m[1]); continue; } // 重定向时以最后一个响应为准（-L 跟随后的）
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === 'set-cookie') {
        setCookie.push(v);
        headers[k] = headers[k] ? `${headers[k]}\n${v}` : v; // 用 \n 保留多条（对齐 harvestCookies）
        continue;
      }
      headers[k] = v;
    }
  } catch {
    /* 头文件缺失则忽略 */
  } finally {
    try { rmSync(headerFile, { force: true }); } catch { /* ignore */ }
  }
  let bytes: Uint8Array | undefined;
  if (outFile) {
    try {
      bytes = new Uint8Array(readFileSync(outFile));
    } catch {
      bytes = new Uint8Array(0); // 文件没生成（网络失败）⇒ 空字节，调用方按「没取到」处理
    } finally {
      try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
    }
  }
  return { status, headers, setCookie, body, ...(bytes ? { bytes } : {}) };
}
/**
 * 同步 HTTP。
 *
 * `defaultHeaders` = **源级默认请求头**（源 `header` 规则 + 登录头 + 源 Cookie），
 * 由 `createJsEvaluator` 注入。对齐 Legado `AnalyzeUrl(url, baseUrl, source)`：
 * 源 `header` 是**基底**，URL 自带的 `,{"headers":{…}}` 覆盖同名项
 * （Legado `UrlOption` 的 headerMap 在 source header 之后 putAll）。
 *
 * 为什么必须有：`java.ajax` 过去只发 URL 自带的头，源 `header` 规则（App 版 UA /
 * application-id / 签名头）**完全没发出去** → 带签名校验的源（星空小说那类）必失败。
 */
function syncHttp(
  /**
   * `#529`：放宽到 jsoup `Connection.Method` 的常用全集。传输层（`sync-fetch-worker`）本就把
   * method 原样交给 `fetch(url, { method })` ⇒ `DELETE`/`PUT` 一直可用，此前只是**类型**收窄了。
   */
  method: 'GET' | 'POST' | 'HEAD' | 'DELETE' | 'PUT' | 'PATCH' | 'OPTIONS',
  url: string,
  body?: string,
  headers?: Record<string, unknown>,
  defaultHeaders?: (url?: string) => Record<string, string>,
  extra?: {
    /** 同步传输实现（缺省 curl）；宿主/测试可替换 */
    transport?: (req: SyncHttpRequest) => SyncHttpResponse;
    /** 响应回调：同步路径的 Set-Cookie 回收、状态码统计等（core 用它写回源 CookieStore） */
    onResponse?: (res: SyncHttpResponse, url: string) => void;
    /** 单次同步请求超时（毫秒，缺省 15_000） */
    timeoutMs?: number;
    /** 不跟随重定向（`#387c`：`java.get/post/head` 用；见 `SyncHttpRequest.noRedirect`） */
    noRedirect?: boolean;
    /**
     * `#614` 需要**原始字节**（`java.queryTTF(url)` 拉字体）。给了就要求传输层回 `bytes`，
     * 并在拿到时回调 `onBytes`。默认 false ⇒ 既有的文本链路一字不变。
     */
    binary?: boolean;
    /** 二进制响应的出口（配合 `binary: true`） */
    onBytes?: (bytes: Uint8Array) => void;
    /** `#742` 源选项 `dnsIp`（IP 直连）；见 `SyncHttpRequest.dnsIp` */
    dnsIp?: string;
  },
): string {
  const merged: Record<string, unknown> = { ...(defaultHeaders?.(String(url)) ?? {}), ...(headers ?? {}) };
  if (syncBudgetUsed > SYNC_BUDGET_MS) return ''; // 预算耗尽：本次事件循环内不再阻塞
  // `#749` D2：到点中止本段 L1（只在 L1 求值中生效；见 `l1DeadlineCheck` 头注）
  l1DeadlineCheck('start', String(url));
  const t0 = Date.now();
  setImmediate(() => { syncBudgetUsed = 0; }); // 事件循环空闲即重置
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (v != null) plain[k] = String(v);
  /** 调用方自带的头（URL 选项 `,{headers}`）—— 闸页重放时要覆盖在**重算后**的源级默认头之上 */
  const callerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (v != null) callerHeaders[k] = String(v);
  /**
   * **POST 表单体编码**（Legado `AnalyzeUrl.encodeParams`；见 `net/form-body.ts` 的长注释）。
   *
   * 放在 `syncHttp` 是**有意为之**：它是 L1 侧所有同步 HTTP 的**唯一出口**
   * （`java.ajax` / `java.post` / `ajaxAll` / `getStrResponse` / `HEAD` 全经过它），
   * 所以在这里做一次即可覆盖全部 L1 用法，不必在 7 个绑定上各写一遍。
   * worker 侧对应位置是宿主 `hostRpc('http')` 分支（同一份 `withFormEncodedBody`）。
   *
   * 修的是用户实测 ③：⚡📂️独阅读网 `secret_content=<base64>` 里的 `+` 被 form 语义解成空格
   * ⇒ 站点 AES 解不开 ⇒ `{"code":"200001","tip":"缺少参数"}`。
   */
  const formPrepared = withFormEncodedBody(method, body, plain);
  const reqBody = formPrepared.body;
  const reqHeaders = formPrepared.headers;
  // `YUEDU_DEBUG_DETAIL=1`：L1（curl）路径的同步 HTTP 留痕 —— 与 worker 路径的 `[ajax]` 对应，
  // 排查「init 里的 java.ajax 拿到站点错误页」时必须能同时看清两条路径发了什么（只打 header 键名）。
  if (process.env['YUEDU_DEBUG_DETAIL']) {
    // eslint-disable-next-line no-console
    console.log(
      `[ajax:L1] ${method} ${String(url).slice(0, 140)} | hdr=[${Object.keys(reqHeaders).join(',')}]` +
        `${reqBody !== undefined ? ` | body=${String(reqBody).slice(0, 60)}` : ''}`,
    );
  }
  let res = (extra?.transport ?? defaultSyncFetch)({
    method,
    url: String(url),
    ...(reqBody !== undefined ? { body: reqBody } : {}),
    headers: reqHeaders,
    // 超时可配（缺省 15s）：实测慢站在 1.6~15s 间抖动，旧的硬编码 10s 会让「能出内容的源」
    // 变成空 body → 下游 JSON.parse('') 抛晦涩错误。宿主可经 syncTimeoutMs 覆盖。
    timeoutMs: extra?.timeoutMs ?? SYNC_HTTP_TIMEOUT_DEFAULT_MS,
    // `#387c`：不跟随重定向（`java.get/post` 的 followRedirects(false) 语义）
    ...(extra?.noRedirect ? { noRedirect: true } : {}),
    // `#614`：要原始字节（字体）—— 传输层不做 utf-8 解码
    ...(extra?.binary ? { binary: true } : {}),
    // `#742`：IP 直连（只换域名→地址，Host/SNI 不变）
    ...(extra?.dnsIp ? { dnsIp: extra.dnsIp } : {}),
  });
  syncBudgetUsed += Date.now() - t0;
  l1ReqCount += 1;
  // 请求本身可能刚好跨过截止（单次最长 15s）⇒ 返回后再判一次，避免「超时了还继续跑下一步」
  l1DeadlineCheck('after', String(url));
  extra?.onResponse?.(res, String(url));
  // `#614`：二进制响应**只**经这个回调交给调用方（`syncHttp` 的返回值始终是字符串，
  // 保持既有 7 个绑定零改动）
  if (res.bytes) extra?.onBytes?.(res.bytes);
  /**
   * `D11`（B 半）闸页静默过闸 —— 见 `net/gate-pass.ts` 头注（判据唯一实现在那里）。
   * 流程：声明页 → GET 过闸目标（收 Set-Cookie，经 onResponse 写回源 CookieStore）→
   * **重算请求头**（此时 CookieStore 里已有 `YES_Eighteen`）→ 重放原请求；拿到非空就用它。
   * 与 worker 宿主（`hostRpc` 的 http 分支）同序；只对 **GET** 且只过**一层**。
   */
  if (method === 'GET') {
    const gate = planAgeGatePass(String(res.body ?? ''), String(url));
    if (gate) {
      /**
       * `#749` D2：过闸的两次重放**不经过 `syncHttp` 的预算/埋点**（历史实现如此），
       * 但硬超时必须覆盖它们 —— 否则「闸页 + 两次重放」能把一段规则拖到 3×15s。
       */
      const once = (u: string, h: Record<string, string>): SyncHttpResponse => {
        l1DeadlineCheck('gate', u);
        const r = (extra?.transport ?? defaultSyncFetch)({
          method: 'GET',
          url: u,
          headers: h,
          timeoutMs: extra?.timeoutMs ?? SYNC_HTTP_TIMEOUT_DEFAULT_MS,
          ...(extra?.dnsIp ? { dnsIp: extra.dnsIp } : {}),
        });
        l1ReqCount += 1;
        l1DeadlineCheck('gate-after', u);
        return r;
      };
      const gateRes = once(gate.target, reqHeaders);
      extra?.onResponse?.(gateRes, gate.target);
      // 重算源级默认头（= 源 header 规则 ⊕ 源 CookieStore 的**最新**会话）——不能复用首次那份（那时还没过闸）
      const replayHeaders: Record<string, string> = { ...(defaultHeaders?.(String(url)) ?? {}) };
      for (const [k, v] of Object.entries(callerHeaders)) if (v != null) replayHeaders[k] = String(v);
      const replay = once(String(url), replayHeaders);
      extra?.onResponse?.(replay, String(url));
      const replayBody = String(replay.body ?? '');
      // 「重放仍是闸页」也算失败 —— 否则会把闸页当成功结果交给规则（列表 0 条，症状与没过闸一样）
      if (replayBody.trim() && !planAgeGatePass(replayBody, String(url))) {
        res = replay;
        gateWarn(`ok:${String(url).slice(0, 100)}`, `已静默过闸（年满18岁声明页 → ${gate.target}）并重放成功：${String(url).slice(0, 120)}`);
      } else {
        gateWarn(
          `fail:${String(url).slice(0, 100)}`,
          `识别到闸页但重放仍为空（过闸目标 ${gate.target}）⇒ 请用「登录窗口」人工过闸后再刷新：${String(url).slice(0, 120)}`,
        );
      }
    }
  }
  // ★ `#152`：L1 同步响应被体积护栏截断 ⇒ 登记进截断环（随引擎结果回传前端）。
  //   这里是 L1 侧所有同步 HTTP 的唯一出口 ⇒ 一处覆盖 java.ajax/post/ajaxAll/getStrResponse。
  //   截断不留痕的话，规则拿到的是前半段 ⇒ 「目录少一截/正文缺后半段」与「站点返回空」分不开。
  if (res.truncated) recordTruncatedFetch(String(url), String(res.body ?? '').length);
  /**
   * `YUEDU_DEBUG_DETAIL=1`：L1（curl）路径的**响应**留痕。
   *
   * 只有请求留痕时，「站点回错误信封 / 回空」这类失败仍然看不到原因 ——
   * 实测（🏷七猫[官方]v3.1 正文）：请求 URL 看着完全正常（`id=203436&chapterId=630355&sign=…`），
   * 必须看到响应体才能判断是**签名被拒**还是**接口改了**。worker 侧对应 `[ajax]` 的那条 `logResp`。
   */
  if (process.env['YUEDU_DEBUG_DETAIL']) {
    // eslint-disable-next-line no-console
    console.log(
      `[ajax:L1] ← ${res.status} len=${String(res.body ?? '').length} | ${String(res.body ?? '').replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  }
  const respBody = res.body;
  const respHeaders = res.headers;
  // StrResponse 语义：字符串本体可当 body 用，也可 .body() / .headers() / .code() 链式取
  const out = new String(respBody) as string & Record<string, unknown>;
  out.body = () => respBody;
  // `#409`：`headers()` 必须是 **okhttp Headers 视图**（get/names/values/size/toMultimap）——
  // 源脚本会写 `java.connect(u).headers().values('Set-Cookie')`（18AV 的 rrcheck 正是），
  // 旧实现给普通对象 ⇒ `values is not a function` ⇒ 整段列表规则失败。
  // 唯一实现在 `selector/ok-headers.ts`（同一份源码也注入 worker，两侧不许各写一份）。
  out.headers = () => okHeaders(respHeaders);
  /**
   * `#639` 与 `makeStrResponse` 同一份实现（`cookieItemsOf*`）—— 别在这里再写一份。
   *
   * ★ 优先用 `res.setCookie`（传输层把多条 Set-Cookie **单独**存成数组，见 `SyncHttpResponse`
   *   的注释：合并成一条会被 `Expires` 里的逗号破坏）。实测 `https://t.shuqi.com` 回三条
   *   （`csrfToken` / `shuqi_token` / `shuqi_user_id`），走 `headers['set-cookie']` 只剩最后一条
   *   ⇒ `cookies()` 里没有 `shuqi_token` ⇒ 书旗 jsLib 的 `Token()` `.match()` 返回 null ⇒
   *   `Cannot read properties of null (reading '1')`。
   */
  out.cookies = () => (res.setCookie?.length ? cookieItemsOfList(res.setCookie) : cookieItemsOf(respHeaders));
  out.header = (name?: unknown) =>
    name === undefined ? respHeaders : (respHeaders[String(name).toLowerCase()] ?? '');
  out.code = () => res.status;
  out.statusCode = () => res.status;
  out.url = () => String(url);
  out.raw = () => {
    const req = { url: String(url), method, body: body ?? '', headers: headers ?? {} };
    // body 兼容两种用法：当字符串读 / 当 .body() 调（复用 String 包装技巧）
    const bodyOut = new String(respBody) as string & Record<string, unknown>;
    bodyOut.body = () => respBody;
    bodyOut.code = () => res.status;
    return {
      body: bodyOut,
      headers: respHeaders,
      code: res.status,
      request: () => ({
        url: () => req.url,
        method: () => req.method,
        body: () => req.body,
        headers: () => req.headers,
      }),
      headersObj: () => respHeaders,
    };
  };
  return out;
}

/**
 * `#614` **取字节**的同步 HTTP（`java.queryTTF(url)` 用）。
 *
 * 为什么不复用 `syncHttpSpec`：它按 Legado `AnalyzeUrl` 语义把 URL 当**页面地址**处理
 * （`<1,2,3>`、`{{js}}`、`,{options}` 尾巴…），而字体地址就是一只普通 URL —— 多绕一层只会
 * 引入「字体地址里恰好有 `<` 或 `,{`」的误解析。这里只做三件事：
 * 剥 `,{…}` 尾巴 → 走同一条源级默认头 → 传输层按二进制取。
 *
 * 返回 undefined ⇒ 没取到（网络失败/非 2xx）；调用方按「字体不可用」退化，不抛错。
 */
function syncHttpByteArray(
  url: string,
  defaultHeaders?: (url?: string) => Record<string, string>,
  extra?: { transport?: (req: SyncHttpRequest) => SyncHttpResponse; timeoutMs?: number },
): Uint8Array | undefined {
  const target = urlBodyOf(url) || url;
  let got: Uint8Array | undefined;
  syncHttp('GET', target, undefined, undefined, defaultHeaders, {
    ...(extra ?? {}),
    binary: true,
    onBytes: (b) => {
      got = b;
    },
  });
  return got && got.length ? got : undefined;
}

/* ───────────────────────── `#614` 字体反爬（java.queryTTF 的取字节 + 缓存） ───────────────────────── */

/** 字体缓存上限：一只中文字体 1~10MB，缓存 8 只已能覆盖「同页多章复用同一只字体」 */
const TTF_CACHE_MAX = 8;
const ttfCache = new Map<string, QueryTtf>();

/**
 * `#614` worker 侧的**字体句柄**（见 `hostRpc` 里 `queryTTF` 分支的长注释）。
 * 上限 16：一次求值里不会用到更多字体；超出按插入序淘汰。
 */
const TTF_HANDLE_MAX = 16;
let ttfHandleSeq = 0;
const ttfHandles = new Map<string, QueryTtf>();

/** 取字节时可用的注入点（L1 有源级默认头；worker 走宿主 RPC 时没有） */
interface TtfHooks {
  baseHeaders?: (url?: string) => Record<string, string>;
  sync?: Parameters<typeof syncHttp>[5];
}

/**
 * 上游方法名 ⇄ 我们的实现名**两套都给**。
 *
 * 为什么不一端一套：源脚本可能调 `qttf.getGlyfByUnicode(cp)`（上游名，语料里少见但存在），
 * 而我们内部用 `glyfOf`。让同一个对象同时具备两套，调用方就不会因为「名字猜错」拿到 undefined。
 */
function toJavaQueryTtf(q: QueryTtf): QueryTtf {
  const out = Object.create(null) as QueryTtf & Record<string, unknown>;
  out.glyfIdOf = q.glyfIdOf;
  out.glyfOf = q.glyfOf;
  out.unicodeOfGlyf = q.unicodeOfGlyf;
  out.isBlankUnicode = q.isBlankUnicode;
  Object.defineProperty(out, 'numGlyphs', { get: () => q.numGlyphs, enumerable: true });
  Object.defineProperty(out, 'mappedCount', { get: () => q.mappedCount, enumerable: true });
  // 上游 JsExtensions 的方法名
  out.getGlyfByUnicode = (cp: unknown) => q.glyfOf(Number(cp));
  out.getGlyfIdByUnicode = (cp: unknown) => q.glyfIdOf(Number(cp));
  out.getUnicodeByGlyf = (g: unknown) => q.unicodeOfGlyf(g == null ? null : String(g));
  return out as QueryTtf;
}

/** `replaceFont` 的入参归一：不是我们返回的对象 ⇒ null（上游对 null 字体原样返回文本） */
function asQueryTtf(v: unknown): QueryTtf | null {
  if (v && typeof v === 'object' && typeof (v as QueryTtf).glyfOf === 'function') return v as QueryTtf;
  return null;
}

/**
 * `java.queryTTF(data, useCache)`：url / base64（含 `data:` 前缀）/ 字节数组三形态。
 *
 * 与上游一致的三处：
 *  ① 缓存键是**字节的 sha256**（不是 URL —— 同一只字体可能从 data: 与 url 两条路来）；
 *  ② 取不到字体 ⇒ 返回 `null`（上游 `font ?: return null`），**不抛**；
 *  ③ 解析失败 ⇒ **抛**（上游 catch 后 rethrow），并写清是哪一步失败。
 */
export function queryTtfOf(data: unknown, useCache: boolean, hooks: TtfHooks = {}): QueryTtf | null {
  /**
   * 缓存键在**下载之前**就要算出来 —— 上游原文是
   * `key = MessageDigest.getInstance("SHA-256").digest(data.toByteArray())`，
   * 对 String 入参而言 `data` 是**URL 或 base64 文本本身**（不是字体字节）。
   * 这意味着 `queryTTF(url)` 第二次调用**不会重新下载**（先命中缓存再发请求）；
   * 若改成「先下载再按字节算键」，同一只 3MB 字体每章都白下一次 —— 那是实打实的流量与耗时。
   */
  const keyOf = (x: string | Uint8Array): string =>
    createHash('sha256').update(typeof x === 'string' ? Buffer.from(x, 'utf-8') : x).digest('hex');

  let bytes: Uint8Array | undefined;
  let key = '';
  if (typeof data === 'string') {
    const s = data.trim();
    if (!s) return null;
    key = useCache ? keyOf(s) : '';
    if (key) {
      const hit = ttfCache.get(key);
      if (hit) return toJavaQueryTtf(hit);
    }
    if (/^https?:\/\//i.test(s)) {
      bytes = syncHttpByteArray(s, hooks.baseHeaders, {
        ...(hooks.sync?.transport ? { transport: hooks.sync.transport } : {}),
        ...(hooks.sync?.timeoutMs ? { timeoutMs: hooks.sync.timeoutMs } : {}),
      });
      if (!bytes) return null; // 网络失败/非 2xx ⇒ 上游语义：字体不可用
    } else {
      const b64 = /^data:[^,]*;base64,/i.test(s) ? s.slice(s.indexOf(',') + 1) : s;
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
        throw new Error('queryTTF: 入参既不是 http(s) 地址也不是 base64 字体数据');
      }
      bytes = new Uint8Array(Buffer.from(b64.replace(/\s+/g, ''), 'base64'));
    }
  } else if (data instanceof Uint8Array) {
    bytes = data;
    key = useCache ? keyOf(data) : '';
    if (key) {
      const hit = ttfCache.get(key);
      if (hit) return toJavaQueryTtf(hit);
    }
  } else if (data instanceof ArrayBuffer) {
    const u8 = new Uint8Array(data);
    bytes = u8;
    key = useCache ? keyOf(u8) : '';
    if (key) {
      const hit = ttfCache.get(key);
      if (hit) return toJavaQueryTtf(hit);
    }
  } else {
    return null; // 上游 `else -> return null`
  }
  if (!bytes || bytes.length < 12) {
    throw new Error(`queryTTF: 字体数据为空或过短（${bytes?.length ?? 0} 字节）`);
  }

  const parsed = parseTtf(bytes); // 抛错时上游也是抛 —— 但消息要能指认「字体有问题」
  if (key) {
    if (ttfCache.size >= TTF_CACHE_MAX) {
      const oldest = ttfCache.keys().next().value;
      if (oldest !== undefined) ttfCache.delete(oldest);
    }
    ttfCache.set(key, parsed);
  }
  return toJavaQueryTtf(parsed);
}

/**
 * 脚本内 HTTP：先按 **Legado `AnalyzeUrl` 语义**解析 URL（`{{内嵌 JS}}` / `<1,2,3>` /
 * `,{options}` 尾巴 / 相对路径绝对化），再发出同步请求。
 *
 * 为什么必须有这一层：`java.ajax/all/get/post` 收到的字符串是**源脚本自己拼**的，
 * 它天然带着 Legado 的 URL 约定。直接丢给 curl 会出现两类硬失败：
 *  · `url,{"method":"POST","body":"id=12&page=1"}` → 整串当 GET URL（绿柠小说 ajaxAll）；
 *  · `url,{"headers":{…}}`（签名头）→ 签名头根本发不出去（七猫 ruleExplore）。
 */
/**
 * `#643` **`java.post/get/head/ajaxAll` 第三参的「头」实参规整**（唯一实现）。
 *
 * 上游（`JsExtensions.kt` 的 `post`/`get`/`head`）签名是
 * `fun post(urlStr: String, body: String?, headers: String?)`，
 * 内部走 **`GSON.fromJsonObject<MutableMap<String,String>>(headers)`**
 * ⇒ 源传的是**一个 JSON 字符串**，不是对象。
 *
 * 我们此前把第三参直接当 `Record<string, unknown>` 用 ⇒ 字符串被静静忽略，
 * 症状是「源明明写了 Referer/Content-Type 等头，请求里却一个都没有」。
 * 实测（`#643` uu书库 `www.uushuk.com` 目录翻页）：源写
 * `java.post(url, 'data='+enc, '{"Content-Type":"…","Referer":"https://…/book/3UWK.html"}')`
 * ⇒ 出口头只有 `[User-Agent,Accept,Accept-Language,content-type]`，**Referer 丢了**。
 *
 * 兼容三种形态（源作者写法很杂）：
 *  ① JSON 字符串 → 解析（对齐上游 GSON）；
 *  ② Java Map（Rhino 桥可能给 Map）→ 转普通对象；
 *  ③ 已经是对象 → 原样。
 * 解析失败**不抛**：头是可选装饰，不该因为它让整条规则失败（上游 GSON 会抛，
 * 但那属于源写错；我们选择「忽略并留痕」，与 `cleanHeaders` 的宽松口径一致）。
 */
function normalizeJsHeaderArg(h: unknown): Record<string, unknown> | undefined {
  if (h === undefined || h === null) return undefined;
  if (typeof h === 'string') {
    const t = h.trim();
    if (!t) return undefined;
    try {
      const o = JSON.parse(t) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
    } catch {
      /* 不是合法 JSON：当「没给头」，不因它中断整条规则 */
    }
    return undefined;
  }
  if (h instanceof Map) return Object.fromEntries(h as Map<string, string>);
  if (typeof h === 'object') return h as Record<string, unknown>;
  return undefined;
}

function syncHttpSpec(
  raw: unknown,
  fallback: { method?: 'GET' | 'POST' | 'HEAD'; body?: string; headers?: Record<string, unknown> } = {},
  defaultHeaders?: (url?: string) => Record<string, string>,
  extra?: Parameters<typeof syncHttp>[5],
): string {
  if (process.env['YUEDU_DEBUG_DETAIL']) {
    // #110 取证：`java.ajax/all/get/post/head` 收到的**实参形态**（上一轮只看到最终请求 URL 被拼了
    // 前缀，看不到实参本身）。打印 `typeof / instanceof String / 构造器名 / 长度 / 头部` 以便判断
    // 是「源脚本自己拼的」还是「我们的包装对象字符串化异常」。
    try {
      const s = String(raw ?? '');
      const ctor = raw && (raw as { constructor?: { name?: string } }).constructor?.name;
      // eslint-disable-next-line no-console
      console.log(
        `[ajax-in] typeof=${typeof raw} str=${raw instanceof String} ctor=${ctor ?? '-'} len=${s.length} head=${JSON.stringify(s.slice(0, 140))} :: ` +
          String(new Error().stack ?? '')
            .split('\n')
            .slice(2, 9)
            .map((l) => l.trim().replace(/^at /, ''))
            .join(' <- '),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[ajax-in] 打印失败: ${String(e).slice(0, 80)}`);
    }
  }
  const spec = prepareRequest(String(raw ?? ''), {
    ...fallback,
    // `#643` 头实参可能是 **JSON 字符串**（上游 `GSON.fromJsonObject` 语义），在这里统一规整。
    // 放最外层（而不是各个 java.*）⇒ ajax/get/post/head/ajaxAll 一处覆盖。
    ...(fallback.headers !== undefined ? { headers: normalizeJsHeaderArg(fallback.headers) } : {}),
  });
  // `#464` 坏地址**必须抛**（与上游 `Jsoup.connect` 同语义）——见 assertHttpUrl 的说明
  assertHttpUrl(spec.url);
  // spec.headers 已含 URL 自带的 `,{headers}`（覆盖 fallback）；再叠源级默认头（最低优先级）
  // `#742` URL 选项 `dnsIp`（IP 直连）—— L1 没有别的地方能拿到它，必须在这里并进 `extra`
  const optObj = spec.option as Record<string, unknown> | undefined;
  const dnsIp = typeof optObj?.['dnsIp'] === 'string' ? String(optObj['dnsIp']).trim() : '';
  /**
   * URL 选项 `timeout`（毫秒，Legado `UrlOption` 语义）：此前被**静默丢弃** ⇒
   * `java.ajax(url+',{"timeout":8000}')` 仍按默认 15s 走。
   * 与 `dnsIp` 同一处消费即可覆盖全部同步出口（ajax/post/get/head/getStrResponse/ajaxAll/fetchText）；
   * 选项缺省/非法时**不写** `timeoutMs`，行为与从前逐字一致（不把超时改短）。
   */
  const optTimeout = ((): number | undefined => {
    const n = Number(optObj?.['timeout']);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  })();
  if (!dnsIp && optTimeout === undefined) return syncHttp(spec.method, spec.url, spec.body, spec.headers, defaultHeaders, extra);
  return syncHttp(spec.method, spec.url, spec.body, spec.headers, defaultHeaders, {
    ...(extra ?? {}),
    ...(dnsIp ? { dnsIp } : {}),
    // URL 选项是**本次请求**的显式意图 ⇒ 优先于调用方给的默认超时（Legado 同语义）
    ...(optTimeout !== undefined ? { timeoutMs: optTimeout } : {}),
  });
}

/**
 * `#464` **`java.head/get/post/ajax/**connect` 的地址闸门**：不是绝对 `http(s)://` 就抛。
 *
 * ## 为什么必须抛（用户 2026-10-15 实测 18AV「🌐获取网址」按钮完全失效）
 * 上游这几个 API 都是 `Jsoup.connect(urlStr)`（`JsExtensions.kt:526-620`），jsoup 对
 * **空串 / 相对地址 / 未知 scheme** 一律抛 `IllegalArgumentException("Malformed URL…")`
 * —— 源作者正是靠它做**兜底分支**：
 * ```js
 * let fbyu = source.get('fbyu')+'';        // 首次运行 ⇒ ''（上游 get 也是空串）
 * try { java.head(fbyu, headers, 6000); }  // 空地址 ⇒ 上游抛 ⇒ 进 catch
 * catch(e) { fbyu='https://mm18vd.com'; }  // ← 默认域名在这里才被写上
 * ```
 * 我们此前**静默返回一个假响应**（不抛）⇒ catch 永不触发 ⇒ `fbyu` 恒空 ⇒
 * `startBrowserAwait('')`（空地址守卫直接返回空、也不通知宿主）⇒ **窗口不弹、正文为空、
 * 还被源脚本误报「已填写最新网址」**（用户看到的就是这个）。
 *
 * ⚠️ 刻意**只**卡住这几个 java API 出口，**不**动 `renderOrFetch` 的静态兜底抓取 ——
 * 那里合法地会收 `data:` 地址（源作者的 `startBrowser('data:text/html;base64,…')` 内联更新页）。
 */
function assertHttpUrl(url: string): void {
  if (/^https?:\/\//i.test(String(url ?? ''))) return;
  throw new Error(`Malformed URL: ${String(url ?? '')}`);
}

// ---- StrResponse 兼容对象（Legado `io.legado.app.help.http.StrResponse` 的 JS 视图） ----
//
// Legado 在 takeResponse 之后把 StrResponse 交给 loginCheckJs 的 `result` 绑定
// （WebBook.kt:75/149/227/327/454 —— search/explore/detail/toc/content 五处出口都会跑）。
// 源脚本读 result.url() / result.body() / result.code() / result.headers()，
// 也会用 `Packages.io.legado.app.help.http.StrResponse(url, body)` 造一个新的返回。
//
// 两个刻意的宽容设计：
//   1) url / body 既是方法又是「可字符串化」的值（函数对象自带 toString/valueOf）——
//      Kotlin 里 `url` 同时是方法与属性（StrResponse.kt:57-64），源里两种写法都有；
//   2) headers() 返回大小写不敏感的 okhttp Headers 视图（get/names/values/size/toMultimap）。

const STR_RESPONSE_FLAG = '__yueduStrResponse';
const STR_RESPONSE_PARTS = '__yueduStrResponseParts';

export interface StrResponseParts {
  url: string;
  body: string;
  code: number;
  headers: Record<string, string>;
}

/**
 * `#639` Legado `StrResponse.cookies()`（okhttp `Response` 的 Set-Cookie 视图）。
 *
 * ## 为什么必须有（真站取证：书旗听书本地源（同人），用户实测第 4 条）
 * jsLib 的 `Token()` 用**登录 Cookie 换 token**：
 * ```js
 * var token = java.get(origin, {}).cookies().toString().match(/shuqi_token=([^,]*)/)[1];
 * ```
 * 本仓两处响应包装此前都没有 `cookies()` ⇒ `TypeError: java.get(...).cookies is not a function`
 * ⇒ `GetUrl` 抛错 ⇒ `bodyJs` 求值失败 ⇒ **详情/目录/正文全空**（发现页却正常，最容易误判成站点问题）。
 *
 * ## 形状（对齐 okhttp3 `Cookie.toString()` = `name=value`）
 * 返回数组，每项 `{ name, value, toString() }`：
 *  · `.toString()` ⇒ `"name=value"`，多个用 `,` 连接（`Array.prototype.toString`）
 *    —— 正好满足上面那条 `/shuqi_token=([^,]*)/` 正则；
 *  · 每项带 `name`/`value`，供 `cookie.mapToCookie(response.cookies())` 这类用法消费
 *    （®️爱丽丝书屋（大侠修）的 loginUrl 就是这么写的，见 `mapToCookie` 的数组分支）。
 *
 * 多个 Set-Cookie 在本仓头表里以 `\n` 分隔（见 `net/index.ts:545`），这里按 `\n` 拆。
 * ⚠️ **两份响应包装共用这一份实现**（`makeStrResponse` 与 `syncHttp` 的 String 包装）——
 * 它们历史上各写一份，已经漂移过一次（`statusCode` / `raw` 都踩过）。
 */
interface CookieItem {
  name: string;
  value: string;
  toString: () => string;
}

/** 把若干条 `Set-Cookie` 原始行转成 okhttp `Cookie` 视图（`toString()` = name=value） */
function cookieItemsOfList(lines: readonly string[]): CookieItem[] {
  return lines
    .map((line) => String(line ?? '').trim())
    .filter(Boolean)
    .map((line) => (line.split(';')[0] ?? '').trim())
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      return { name, value, toString: () => `${name}=${value}` };
    });
}

function cookieItemsOf(headers: Record<string, string>): CookieItem[] {
  let raw = '';
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === 'set-cookie') raw = String(v ?? '');
  }
  return cookieItemsOfList(raw.split('\n'));
}

/** 构造 StrResponse 兼容对象（源脚本的 `result`，或脚本自造返回值） */
export function makeStrResponse(
  url: string,
  body: string,
  code = 200,
  headers: Record<string, string> = {},
  message = 'OK',
): Record<string, unknown> {
  const asValue = (v: string) => Object.assign(() => v, { toString: () => v, valueOf: () => v });
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = String(v);
  // `#409`：这里原本是 okhttp Headers 视图的**第二份实现** —— 改为复用唯一实现
  // （`selector/ok-headers.ts`）；同步 HTTP 出口此前缺这个视图，两边一度只差这一处。
  const headerView = okHeaders(headers);
  const cookieItems = cookieItemsOf(headers);
  const obj: Record<string, unknown> = {
    url: asValue(url),
    body: asValue(body),
    code: () => code,
    /** `#522`：worker 侧 `strResponse` 与 L1 `syncHttp` 返回值都有 `statusCode()`，本函数此前**缺**它 ⇒
     *  `new Packages.io.legado.app.help.http.StrResponse(url,body,code)` 这条要跨两侧的路会 NOT_A_FUNCTION。
     *  补上以对齐（同一份响应视图不该两处不同）。 */
    statusCode: () => code,
    message: () => message,
    headers: () => headerView,
    cookies: () => cookieItems.slice(),
    isSuccessful: () => code >= 200 && code < 300,
    errorBody: () => null,
    callTime: () => 0,
    raw: () => ({}),
    // Legado 的 toString() 返回 raw.toString()（okhttp Response 的调试串），实战里源要的是正文
    toString: () => body,
  };
  Object.defineProperty(obj, STR_RESPONSE_FLAG, { value: true, enumerable: false });
  Object.defineProperty(obj, STR_RESPONSE_PARTS, { value: { url, body, code, headers: lower } satisfies StrResponseParts, enumerable: false });
  return obj;
}

/** 是否是 StrResponse 兼容对象 */
export function isStrResponse(v: unknown): boolean {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>)[STR_RESPONSE_FLAG] === true;
}

/** 取出 StrResponse 兼容对象的原始 url/body/code；非 StrResponse 返回 null */
export function readStrResponse(v: unknown): StrResponseParts | null {
  if (!isStrResponse(v)) return null;
  const parts = (v as Record<string, unknown>)[STR_RESPONSE_PARTS] as StrResponseParts | undefined;
  return parts ?? null;
}

/**
 * L1 同步渲染是否可用（`#198`：**默认关闭**）。
 *
 * ## 为什么默认关掉（这是 `#194` 诊断的 `render-spawnSync` 元凶）
 * `syncRenderHtml` 用 **`spawnSync`** 起 Chromium `--dump-dom`，整段生命周期
 * （实测单次 **8896ms**，`net/render.ts:157`）**完全阻塞事件循环** ⇒ 阻塞窗口内
 * **任何** HTTP 请求都进不来（连 `/api/diag` 探活也一样）⇒ 表现为「服务端假死 /
 * 拒绝新连接」。批量跑源时这一条足以让整批超时。
 *
 * ## 为什么关掉是**安全**的（能力没丢，只是换了条不阻塞的路）
 * · worker 路径的 `java.webView` / `startBrowserAwait` 走 `hostRpc(..., opts.renderer, ...)`
 *   ⇒ 用宿主注入的**异步** `WebRenderer`（`apps/server/src/renderer.ts` 的分层渲染器，
 *   `execFile` 而非 `spawnSync`），**不阻塞事件循环**；
 * · worker 池不可用时（无 `worker_threads` 的极端环境），这里回落的是**静态抓取** ——
 *   拿不到 JS 渲染后的 DOM，但**不会把整个服务卡死**。
 *   ★ 这个取舍是有意的：宁可「部分源少一层渲染」，也不要「整个服务假死」。
 *
 * ## 怎么临时拿回旧行为
 * `YUEDU_SYNC_RENDER=1` 显式开启（旧行为，会阻塞）；`=0` 强制关闭（默认）。
 * 单测里**必须显式 `=1`** —— 拉浏览器会让单测变慢且不确定。
 */
export function syncRenderEnabled(): boolean {
  const flag = process.env.YUEDU_SYNC_RENDER;
  // `#198`：由「默认启用」改为「默认关闭」。理由见上面注释（spawnSync 阻塞事件循环）。
  return flag === '1';
}

/**
 * webView 系列统一入口：**同步钩子 → 静态抓取兜底**。
 *
 * ★ `#198`：原来这里还有一条「同步渲染」（`spawnSync` 起 Chromium），已按
 *   `syncRenderEnabled()` 的新默认值关闭。渲染能力**没有丢** —— worker 路径走
 *   宿主的异步 `WebRenderer`（见 `hostRpc` 的 `method === 'render'` 分支）。
 */
/**
 * `#393` 「脚本要求打开浏览器」的**目的** —— 前端据此**选浏览器**（应用内极简浏览器 / 本机真浏览器）。
 *
 *  · `show`   → `java.startBrowser(url, tag)` 是 **fire-and-forget**（上游 `startActivity` 语义）：
 *               语义就是「打开给人看」—— 拿密钥 / 发布页 / 源作者内联的 `data:text/html;base64` 更新页。
 *               这类页面**不需要把 Cookie 带回引擎**，应用内 iframe 浏览器完全够用；
 *               而且只有应用内才有宿主能力（页面里的「导入书源」= `legado://` 链接，外部浏览器点了没用）。
 *  · `cookie` → `java.startBrowserAwait(...)` / `java.webView(...)` / 源的登录页：脚本**在等浏览器里的结果**
 *               （上游 `startBrowserAwait` 返回 StrResponse，源常接着 `cookie.getKey(url,"token")` 取 token）。
 *               ⚠️ 跨域站点的登录 Cookie **无法**从应用内 iframe 取出（浏览器 cookie ≠ 服务端 cookie jar）
 *               ⇒ 必须本机真浏览器（服务端 Chromium + CDP 回传）。
 *
 * ⚠️ 这不是「有没有浏览器 API」的**提示位**（那是 `needBrowser`）—— 它只回答「打开它到底为了什么」。
 */
export type BrowserOpenKind = 'show' | 'cookie';

/**
 * `#580` **把「裸 JSON 响应」包装成 WebView 会看到的文档**（Legado `java.webView` 语义）。
 *
 * 真浏览器打开 `application/json` 时，Chromium 会自动渲染成 `<pre>[{…}]</pre>`
 * （默认 JSON viewer）。源作者正是依赖这个形态：🔞Linpx 的 jsLib
 * `getWebviewJson()` 写 `html.match(/>\[\{.*?}]</)[0]` —— 浏览器里必命中。
 *
 * 我们的静态兜底抓取返回的是**裸 JSON**（`[{` 开头、没有 `<`）⇒ `match` 为 null
 * ⇒ `Cannot read properties of null (reading '0')`，用户看到发现页无内容卡片。
 * 只在「看起来是裸 JSON」时包装；HTML / 空串原样返回（零回归面）。
 */
export function asWebViewDocument(body: string): string {
  const s = String(body ?? '');
  const t = s.trimStart();
  if (!t || !/^[[{]/.test(t)) return s;
  // 已经带标签（站点返回的 JSONP/HTML 混排）⇒ 不重复包装
  if (t.includes('<')) return s;
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<html><head></head><body><pre>' + esc + '</pre></body></html>';
}

/** `showBrowser` 用：把 HTML 包成 data URL（可带 base；`<base>` 只补一次） */
function htmlToDataUrl(html: string, base: string): string {
  let body = html;
  if (/^https?:\/\//i.test(base) && !/<base\s/i.test(body)) {
    body = '<base href="' + base.replace(/"/g, '&quot;') + '">' + body;
  }
  return 'data:text/html;base64,' + Buffer.from(body, 'utf8').toString('base64');
}

function renderOrFetch(
  url: string,
  hooks: {
    renderHtml?: (u: string) => string;
    onBrowserOpen?: (u: string, kind?: BrowserOpenKind) => void;
    /** 源级默认请求头（渲染不可用时的静态兜底抓取要带上，否则拿到的是未登录/无身份的页面） */
    baseHeaders?: (url?: string) => Record<string, string>;
    /** 同步传输与响应回调（同 makeJavaStub 的 sync） */
    sync?: Parameters<typeof syncHttp>[5];
  },
  /**
   * `#393` 这次渲染是「给人看」还是「要浏览器里的结果」。缺省 `cookie` —— 保守：
   * 调它的 `webView` / `startBrowserAwait` 都可能依赖浏览器登录态。
   */
  kind: BrowserOpenKind = 'cookie',
): string {
  // `#374` 空地址守卫：实测（🎬茶杯狐狸 2026-10-09）站点无播放数据时 `url_next` 是**空串**，
  // 源脚本照旧 `startBrowserAwait('')` ⇒ 空地址进渲染器/抓取会**白等整个渲染超时**（实测 15s/次），
  // 用户点开正文就是十几秒卡顿且一无所获。空地址立即返回空（Legado startActivity 空意图也是空转）。
  if (!url.trim()) return '';
  hooks.onBrowserOpen?.(url, kind); // 记录「脚本想打开浏览器」及其**目的**（`#393`）——登录流程据此选浏览器
  /**
   * `#580` 渲染结果为空 ⇒ **回落静态抓取**（旧实现拿到空串就直接返回，源脚本看到的是空文档）。
   * 渲染失败不应比「不渲染」更差。
   */
  if (hooks.renderHtml) {
    const html = hooks.renderHtml(url);
    if (html) return html;
  }
  if (syncRenderEnabled()) {
    const html = syncRenderHtml(url);
    if (html) return html;
  }
  // `#580` 静态兜底拿到裸 JSON 时，按浏览器 JSON viewer 的形态包成 `<pre>…</pre>`
  return asWebViewDocument(syncHttp('GET', url, undefined, undefined, hooks.baseHeaders, hooks.sync));
}

/** `#411` 文件 API 的未命中留痕（铁律 4：静默空值会被误判成「源侧规则写错」） */
const fileWarned = new Set<string>();
function fileWarn(tag: string, msg: string): void {
  if (fileWarned.has(tag)) return;
  fileWarned.add(tag);
  // eslint-disable-next-line no-console
  console.warn(`[js-file] ${msg}`);
}

const ajaxTestWarned = new Set<string>();
/** `java.ajaxTestAll` 单项失败的留痕（同 URL 只报一次）—— 失败项仍会出现在返回数组里 */
function ajaxTestWarn(url: string, e: unknown): void {
  const key = url.slice(0, 120);
  if (ajaxTestWarned.has(key)) return;
  if (ajaxTestWarned.size > 100) ajaxTestWarned.clear();
  ajaxTestWarned.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[ajaxTestAll] ${key} 失败（仍返回空响应项）：${e instanceof Error ? e.message : String(e)}`);
}

/** `D11` 闸页过闸的留痕（同 key 只打一次；成功与失败都要可见 —— 否则「过了闸却没内容」无从归因） */
const gateWarned = new Set<string>();
function gateWarn(tag: string, msg: string): void {
  if (gateWarned.has(tag)) return;
  gateWarned.add(tag);
  // eslint-disable-next-line no-console
  console.warn(`[gate] ${msg}`);
}

/**
 * `#411` `java.importScript / cacheFile / readTxtFile / deleteFile` 的 **L1 实现**
 * （worker 宿主侧复用 `selector/js-file.ts` 的同一批判据；此处只把「同步 HTTP」这块接上）。
 *
 * `syncHttpSpec` 是 L1 侧所有同步 HTTP 的唯一出口（URL 选项解析 + 源级默认头 + 同步传输），
 * 与 `java.ajax` 完全同一条路 —— 不另开一条 fetch 通道，避免「同一 URL 两种取法」的漂移。
 */
function makeScriptFileApi(variables: VariableStore, hooks: NonNullable<Parameters<typeof makeJavaStub>[1]>) {
  const layer = makeCacheOps(variables);
  const fetchText = (url: string): string => syncHttpSpec(url, {}, hooks.baseHeaders, hooks.sync);
  /**
   * `#636` 第二层：**L1 不做重试**（有意与 worker 宿主不同）。
   *
   * 理由（两条，都不是猜的）：
   *  ① L1 的同步传输是 curl 子进程 / `execFileSync` —— 重试 3 次 × 15s = 主线程停摆 45s，
   *     其它源/请求全部陪等，正是 `#480-a` 那条「调度雪崩」的机制（`[stall]` 看门狗观测的也是它）。
   *  ② `syncHttp` 自带 `SYNC_BUDGET_MS = 20_000` 的预算闸：本次事件循环内的同步 HTTP 累计超 20s 后
   *     **直接返回空串** ⇒ 第二次「重试」其实是假重试，只会更快地拿到空。
   * ⇒ 这里只补**失败原因**（旧行为：空串 + 一句「内容获取失败或者为空」，分不清超时/404/站点回空）。
   *    真正的重试放在 worker 宿主（`fetchScriptTextRetry`），qyyuapi 系（包子/漫画柜/G站/MYCOMIC…）
   *    全部走那条路（`needsJavaBridgeL1(lib)=false` ⇒ 落 worker，实测见 `docs/rounds/2026-10-26-10`）。
   */
  const emptyHint = 'L1 同步传输返回空（L1 单次尝试、不重试：重试会阻塞主线程；见 js-file.ts 头注）';
  return {
    cacheFile: (urlStr: unknown, saveTime?: unknown) => {
      const url = String(urlStr ?? '');
      const key = fileCacheKey(url);
      const hit = readScriptFile(layer, key);
      if (hit != null) return hit;
      // `#732` **网络优先**（原行为）：成功 ⇒ 用网络内容 + 回写镜像；不因镜像存在而跳过请求
      let text = '';
      let failure = '';
      try {
        // 同步传输可能回**沙箱侧的 String 包装对象**（跨 realm）：空内容时它仍是 truthy，
        // 不转原始串就会把「空响应」当成功（#732 当场被单测抓住）
        text = String(fetchText(url) ?? '');
      } catch (e) {
        failure = `连接错误：${(e as Error)?.message ?? e}`;
      }
      if (text.trim() && isMarkupDocumentBody(text)) {
        // 浏览器重放把 `.js` 渲染成「文本阅读器」DOM：不是脚本，按网络失败走镜像兜底
        failure = '响应是 HTML 文档（非脚本原文）';
        text = '';
      }
      if (text) {
        writeJsMirror(url, text);
        return writeScriptFile(layer, key, text, toSaveTime(saveTime));
      }
      // 失败 ⇒ 镜像兜底
      failure = failure || `${emptyHint}（空响应）`;
      const mirror = readJsMirror(url, { reason: failure });
      if (mirror) return writeScriptFile(layer, key, mirror.text, toSaveTime(saveTime));
      // 两者都失败 ⇒ 明确报错（不返回静默空串）+ 连续失败计数（到阈值提示「请手动下载」）
      noteJsMirrorFailure(url, failure);
      fileWarn(`cf:${url.slice(0, 80)}`, `java.cacheFile('${url.slice(0, 120)}') 失败（本地镜像未命中；网络：${failure}）`);
      return writeScriptFile(layer, key, '', toSaveTime(saveTime));
    },
    readTxtFile: (path: unknown) => {
      const p = String(path ?? '');
      const text = readScriptFile(layer, fileCacheKey(p)) ?? '';
      if (!text) {
        fileWarn(`read:${p.slice(0, 80)}`, `java.readTxtFile('${p.slice(0, 120)}') 未命中（本仓无「阅读私有数据目录」⇒ 返回空串）`);
      }
      return text;
    },
    deleteFile: (path: unknown) => deleteScriptFile(layer, String(path ?? '')),
    /**
     * Legado `java.downloadFile(...)`（`JsExtensions.kt:518-570`）—— **两个重载**：
     *   · `downloadFile(hexContent, url)`：把 hex 内容写到「缓存文件名」，返回**相对路径**
     *   · `downloadFile(url)`：下载 URL 内容后同上（上游 getInputStream 直落文件）
     * 文件名 = `<md5Encode16(url)>.<type>`，`type` 取 url 尾部 `,{"type":"html"}` 选项、否则取后缀。
     *
     * ## 语料用法（4 源，形态高度一致）
     * 千白羽论坛导出帖子为 HTML、番茄短剧落 mp4 —— 都是**两参**形态，且源自己拼缓存目录前缀：
     * `rel = java.downloadFile(hex, 'https://x/名字.html,{"type":"html"}'); 完整路径 = DLPKG + rel`
     * ⇒ 只要**返回非空文件名**脚本就 `ok=true`；返回空则源会走 data: URI 兜底（不会崩）。
     *
     * ## 本仓的落地（有意近似，注释写清）
     * 服务端没有「用户能打开的本地文件系统」，所以：内容写进**文件层**（文本层存 data URL，
     * 二进制不丢），键统一 `md5Encode16(url)`；并额外按返回路径再写一份别名键，
     * 让随后的 `java.readTxtFile(rel)` 也能命中同一份内容。
     * 返回值为上游形态的相对路径，**不是**本机真实路径 —— 前端要展示需自行转 data URL。
     */
    downloadFile: (a: unknown, b?: unknown) => {
      /**
       * 形态判定（三种，语料都有）：
       *  · 两参 `(hexContent|data:, url)` —— 内容已给定（千白羽 / 番茄短剧）
       *  · 一参且是 `data:` URI        —— 内容内联（千白羽的兜底分支）
       *  · 一参且是 http URL           —— 需要下载
       */
      const twoArg = b !== undefined;
      const argA = String(a ?? '');
      const inlineData = /^data:/i.test(argA);
      const urlStr = String(twoArg ? b : argA);
      const type = downloadFileType(urlStr);
      const key = fileCacheKey(urlStr);
      let bytes: Buffer;
      if (twoArg || inlineData) {
        bytes = decodeDownloadPayload(argA);
      } else {
        // 一参：同步取文本（二进制会被 utf8 解码损伤 —— 语料里没有这种用法，留痕说明）
        fileWarn(`dl:1arg:${urlStr.slice(0, 80)}`, `java.downloadFile('${urlStr.slice(0, 120)}') 单参形态按文本下载（本仓同步传输只有文本面）`);
        bytes = Buffer.from(fetchText(urlStr), 'utf-8');
      }
      const stored = `data:${mimeOfType(type)};base64,${bytes.toString('base64')}`;
      const rel = `${key}.${type}`;
      layer.putFile(key, stored, 0);
      layer.putFile(fileCacheKey(rel), stored, 0); // 别名：readTxtFile(rel) 可命中
      return rel;
    },
    importScript: (path: unknown) => {
      const p = String(path ?? '');
      if (/^http/i.test(p)) {
        const key = fileCacheKey(p);
        const hit = readScriptFile(layer, key);
        if (hit != null) return importScriptEnsure(hit, p);
        // `#732` **网络优先**（`loginUrl`/`sortUrl` 的 `Reload(url)` 都走这里）
        let fetched = '';
        let failure = '';
        try {
          // 同 `cacheFile`：转原始串，空内容的 String 包装对象是 truthy 的
          fetched = String(fetchText(p) ?? '');
        } catch (e) {
          failure = `连接错误：${(e as Error)?.message ?? e}`;
        }
        if (fetched.trim() && isMarkupDocumentBody(fetched)) {
          failure = '响应是 HTML 文档（非脚本原文）';
          fetched = '';
        }
        if (fetched) {
          writeJsMirror(p, fetched);
          return importScriptEnsure(writeScriptFile(layer, key, fetched, 0), p);
        }
        // 失败 ⇒ 镜像兜底
        failure = failure || `${emptyHint}（空响应）`;
        const mirror = readJsMirror(p, { reason: failure });
        if (mirror) return importScriptEnsure(writeScriptFile(layer, key, mirror.text, 0), p);
        // 两者都失败 ⇒ 明确报错 + 计数
        noteJsMirrorFailure(p, failure);
        const stored = writeScriptFile(layer, key, '', 0);
        return importScriptEnsure(stored, p, `${failure}；本地镜像未命中`);
      }
      const text = readScriptFile(layer, fileCacheKey(p)) ?? '';
      if (!text) fileWarn(`read:${p.slice(0, 80)}`, `java.importScript('${p.slice(0, 120)}') 非 URL 分支未命中（本仓无「阅读私有数据目录」）`);
      return importScriptEnsure(text, p);
    },
  };
}

/**
 * `#540` DER 长度前缀（ASN.1）：内容 <128 用短型，否则长型（0x80|字节数 + 大端长度）。
 * 只服务「PKCS1 → PKCS8/SPKI」包装（hutool KeyUtil 收 PKCS1，Node crypto 只认 PKCS8/SPKI）。
 */
function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const RSA_ALG_ID = Buffer.from('300d06092a864886f70d0101010500', 'hex'); // AlgId(rsaEncryption, NULL)
/** RSAPrivateKey(PKCS1) → PrivateKeyInfo(PKCS8)：SEQ{INT 0, AlgId, OCTET STRING{pkcs1}} */
function wrapDerPkcs1Private(pkcs1: Buffer): Buffer {
  const inner = Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), RSA_ALG_ID, Buffer.from([0x04]), derLen(pkcs1.length), pkcs1]);
  return Buffer.concat([Buffer.from([0x30]), derLen(inner.length), inner]);
}
/** RSAPublicKey(PKCS1) → SubjectPublicKeyInfo(SPKI)：SEQ{AlgId, BIT STRING{pkcs1}} */
function wrapDerPkcs1Public(pkcs1: Buffer): Buffer {
  const bits = Buffer.concat([Buffer.from([0x03]), derLen(pkcs1.length + 1), Buffer.from([0x00]), pkcs1]);
  const inner = Buffer.concat([RSA_ALG_ID, bits]);
  return Buffer.concat([Buffer.from([0x30]), derLen(inner.length), inner]);
}

function makeJavaStub(
  variables: VariableStore,
  hooks: {
    evalRule?: (rule: string, value: unknown) => string;
    contextValue?: () => unknown;
    javaExtra?: Record<string, unknown>;
    /** java.getCookie(tag, key?) 读取（注入 cookie 桩，Legado JsExtensions.kt:449-462） */
    getCookie?: (tag: string, key?: string) => string;
    /** 同步渲染钩子（宿主可注入；缺省用本机 Chromium `--dump-dom`）——java.webView 系列 */
    renderHtml?: (url: string) => string;
    /**
     * `#675` **载入给定 HTML + 执行 JS 并取返回值**（上游 `jsoup? no — JsExtensions.webView`）。
     *
     * `webView(html, url, js)` 的语义是「把这个 html 当成文档、以 url 为 origin、跑 js、要 js 的返回值」，
     * 不是「渲染一个 URL 再取 DOM」。宿主实现应为：
     *   `Page.navigate(url)` → `Page.setDocumentContent(frameId, html)` →
     *   `Runtime.evaluate(js, { returnByValue: true, awaitPromise: true })` → 取 result.value。
     * 为什么要 navigate 一次：源脚本里常是**相对路径 XHR**（`xhr.open('POST','/conapi.php')`），
     * 文档没有站点 origin 时浏览器直接拒发（data:/file: 的 origin 是 null）。
     */
    renderHtmlJs?: (html: string, baseUrl: string, js: string) => string;
    /** 同步「渲染 + sourceRegex 取资源 URL」钩子——java.webViewGetSource */
    renderSource?: (url: string, sourceRegex: string) => string;
    /**
     * `java.toast` / `java.longToast` 回调（Legado JsExtensions.kt:60-70 —— App 里弹
     * Toast 给用户看）。服务端没有 UI，早期是**静默丢弃**，导致大量源的关键反馈
     * （禁漫天堂登录按钮 `log()` → `java.longToast`、独阅读网接口 `tip`）全部消失，
     * 用户只看到「点了没反应」。现在由宿主收集后回传（如登录结果附带 toasts）。
     */
    onToast?: (msg: string, long: boolean) => void;
    /**
     * 源级默认请求头提供者（源 `header` 规则 + 登录头；Cookie 由本模块自己从 `cookies` 补）。
     *
     * 由宿主（engine-legado）注入——`header` 规则可能是 `@js:`，只有引擎知道怎么求值。
     * 惰性调用：脚本不发 HTTP 就完全不会产生求值开销。
     */
    getSourceHeaders?: (url?: string) => Record<string, string> | undefined;
    /** 页面内 JS 注入渲染（Legado webJs；仅 CDP 渲染层支持），缺省返回空串 */
    renderWithJs?: (url: string, js: string) => string;
    /**
     * 「脚本要求打开浏览器」回调（Legado `startBrowser` / `startBrowserAwait` / `webView`）。
     * 服务端拿得到渲染结果，但**人工登录/验证码**必须真浏览器 —— 登录流程据此把 URL 交给前端打开。
     */
    onBrowserOpen?: (url: string, kind?: BrowserOpenKind) => void;
    /**
     * Legado `java.upLoginData(data)` 回调（`SourceLoginJsExtensions.kt:35-37` → 对话框 `handleUpUiData`）。
     *
     * 语义：**脚本要求实时更新登录界面的字段值**（如 18AV `fabuye()` 取到最新站点域名后
     * `java.upLoginData({'网址': surl})` —— 用户要看到输入框被填上）。它不是「保存登录信息」：
     * 上游只改 UI，落库仍要用户点 ✓（`jsHelp.md`:「文本类输入需用户主动打勾保存，或调用 java.upLoginData 更新」）。
     * 服务端没有 UI ⇒ 交给宿主（引擎把这份 map 随登录结果回传，前端回填到表单）。
     */
    onUpLoginData?: (data: unknown) => void;
    /**
     * 源级默认请求头（源 `header` 规则 + 登录头 + 源 Cookie）。
     * `java.ajax/connect/post/get/getStrResponse/ajaxAll` 全部以它为基底发请求
     * —— 对齐 Legado `AnalyzeUrl(url, baseUrl, source)` 的 `source.getHeaderMap()`。
     */
    baseHeaders?: (url?: string) => Record<string, string>;
    /** 同步传输与响应回调（`syncFetch` 注入 + Set-Cookie 回收），透传给每次 syncHttp 调用 */
    sync?: Parameters<typeof syncHttp>[5];
    /** `java.refreshBookInfo/Toc/Content` —— 宿主发刷新事件（服务端无 UI，由引擎记录/落变量） */
    onRefreshBook?: (kind: 'info' | 'toc' | 'content') => void;
    /** `java.canOpenSourceUi()` —— 宿主是否具备打开源网页/视频的能力（缺省 false） */
    canOpenSourceUi?: () => boolean;
    /** `java.getSource()` —— 返回源桩（BaseSource，只读快照；缺省用无源兜底桩） */
    getSource?: () => unknown;
    /** `java.getTag()` —— 源名（`BookSource.getTag()` = `bookSourceName`） */
    getTag?: () => string;
    /**
     * `#727` `java.getVerificationCode(imageUrl)` 的**同步**人工输入通道（L1 专用）。
     *
     * L1 在宿主主线程同步求值：这里只能接「已经拿到值」的同步实现（测试/宿主自备弹窗）。
     * 服务端那边的人工输入是**异步**的（要等桌面端窗口提交），走
     * `HybridEvalOptions.verificationCodeAsync` + worker 的同步 RPC。
     */
    verificationCode?: (imageUrl: string) => string;
  } = {},
): Record<string, unknown> {
  // `#411` 文件 API（同一份判据给 java.importScript/cacheFile/readTxtFile/deleteFile 四个键）
  const readTxtFileImpl = makeScriptFileApi(variables, hooks);
  /**
   * `#613`/`#615`：`getFile` / `readFile` / `getTxtInFolder` / `unzipFile` / `getZip*Content`。
   * 与 `makeScriptFileApi` **共用同一份文件层**（`makeCacheOps(variables)`）⇒ `downloadFile`
   * 落的东西 `readFile` 就能读到。真文件系统部分限制在 `YUEDU_JAVA_FILE_DIR` 内（越界抛错）。
   */
  const javaFileImpl = makeJavaFileApi(makeCacheOps(variables), {
    fetchText: (url) => syncHttpSpec(url, {}, hooks.baseHeaders, hooks.sync),
    warn: (tag, msg) => fileWarn(tag, msg),
  });
  const base: Record<string, unknown> = {
    log: (...a: unknown[]) => console.log('[legado-js]', ...a),
    // Legado JsExtensions.kt:60-70 —— java.toast / java.longToast 都是「弹给用户看」的反馈。
    // App 里是 Toast；服务端没有 UI，改为回调宿主（引擎收集后回传前端弹 Android 风格 Toast）。
    // 空文本在**这里**就挡掉：源脚本常写 `java.toast(someVar)` 而变量可能为空，
    // 不挡就会弹出一串空气泡。
    toast: (m: unknown) => {
      const s = String(m ?? '').trim();
      if (!s) return undefined;
      try { hooks.onToast?.(s, false); } catch { /* 回调不得影响脚本 */ }
      return undefined;
    },
    longToast: (m: unknown) => {
      const s = String(m ?? '').trim();
      if (!s) return undefined;
      try { hooks.onToast?.(s, true); } catch { /* 同上 */ }
      return undefined;
    },
    randomUUID: () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2),
    base64Encode: (s: string) => Buffer.from(String(s), 'utf-8').toString('base64'),
    base64Decode: (s: string) => Buffer.from(String(s), 'base64').toString('utf-8'),
    base64DecodeToByteArray: (s: string) => new Uint8Array(Buffer.from(String(s), 'base64')),
    /**
     * `#614` **字体反爬**（上游 `JsExtensions.kt:1052-1166` + `analyzeRule/QueryTTF.java`）。
     *
     * 用法（语料唯一用例：🔞爱丽丝书屋）：
     * ```
     * ct = java.replaceFont(ct,
     *        java.queryBase64TTF(css里的 ttf;base64,…),   // 站点下发的「错」字体
     *        java.queryTTF('https://…/SourceHanSansCN-Regular.ttf'),  // 原始「对」字体
     *        true)                                        // filter：删掉没有轮廓的字符
     * ```
     * 三件套的语义与坑见 `core/font/ttf.ts` 头注；这里只负责**取字节 + 缓存**：
     *  · `data` 支持 url / base64 / ByteArray（上游 `queryTTF(Any?)` 三形态）；
     *  · 缓存键 = 字节的 sha256（上游 `AppCacheManager.getQueryTTF` 同口径，但**只放内存**：
     *    字体是 1~10MB 级，落盘得不偿失；一次求值里同一只字体常被调多次）；
     *  · 取不到/解析失败 ⇒ **抛错**（上游 `queryTTF` 也是 catch 后 rethrow）——
     *    静默返回 null 会让源作者以为「规则没错、就是字没变」，那是最难查的一类。
     */
    queryTTF: (data: unknown, useCache?: unknown) => queryTtfOf(data, useCache !== false && useCache !== 'false', hooks),
    /** 上游已标 `@Deprecated`（等价 `queryTTF(data)`），保留只为语料兼容 */
    queryBase64TTF: (data: unknown) => queryTtfOf(data, true, hooks),
    replaceFont: (text: unknown, errorTtf?: unknown, correctTtf?: unknown, filter?: unknown) =>
      replaceFontImpl(
        String(text ?? ''),
        asQueryTtf(errorTtf),
        asQueryTtf(correctTtf),
        filter === true || filter === 'true' || filter === 1,
      ),
    hexDecodeToString: (s: string) => Buffer.from(hexStrict(String(s)), 'hex').toString('utf-8'),
    hexEncodeToString: (s: string) => Buffer.from(String(s), 'utf-8').toString('hex'),
    md5Encode: (s: string) => createHash('md5').update(String(s)).digest('hex'),
    /**
     * `JsEncodeUtils.kt:26-29`（@JavascriptInterface）= `MD5Utils.md5Encode16(str)`
     * = `md5Encode(str).substring(8, 24)` —— **32 位 hex 的第 8~23 位**（不是 16 位 hex）。
     *
     * ⚠️ **#361**：此前本仓只有 md5Encode，缺 md5Encode16 ⇒ 落到 java Proxy 的
     * 「未实现 → 空串」兜底 ⇒ **不报错但静默错值**：语料 45 处用它当缓存键
     * （qyyuapi 系 header 规则 `cache.put(java.md5Encode16(Get('url') + "headers"), …)`）
     * ⇒ 键全塌成同一个 `…headers` ⇒ **跨源串味 + 自己的头读不回来**。
     */
    md5Encode16: (s: string) => createHash('md5').update(String(s)).digest('hex').slice(8, 24),
    sha1Encode: (s: string) => createHash('sha1').update(String(s)).digest('hex'),
    // 摘要 / HMAC（Legado JsEncodeUtils.kt:456-500；hutool DigestUtil.digester(algorithm).digestHex）
    digestHex: (data: unknown, algorithm: unknown) =>
      createHash(digestAlgoName(algorithm)).update(String(data ?? ''), 'utf-8').digest('hex'),
    digestBase64Str: (data: unknown, algorithm: unknown) =>
      createHash(digestAlgoName(algorithm)).update(String(data ?? ''), 'utf-8').digest('base64'),
    HMacHex: (data: unknown, algorithm: unknown, key: unknown) =>
      createHmac(digestAlgoName(algorithm), toKeyBytes(key)).update(String(data ?? ''), 'utf-8').digest('hex'),
    HMacBase64: (data: unknown, algorithm: unknown, key: unknown) =>
      createHmac(digestAlgoName(algorithm), toKeyBytes(key)).update(String(data ?? ''), 'utf-8').digest('base64'),
    string: (s: unknown) => String(s),
    encodeURI: (s: unknown) => encodeURIComponent(String(s)),
    decodeURI: (s: unknown) => {
      try { return decodeURIComponent(String(s)); } catch { return String(s); }
    },
    /**
     * **类CA（2026-10-26）`java.urlEncode` / `java.urlDecode`（★ 上游无对应实现）**。
     *
     * 上游 `JsExtensions.kt` 只有 `encodeURI`/`decodeURI`，**没有** `urlEncode`；但语料里
     * 📂笔趣阁·恋爱呀 的 searchUrl / exploreUrl 都写成 `try{java.urlEncode(s)}catch(ex){encodeURIComponent(s)}`
     * ——作者显然指望「有就用、没有就走 catch」。
     *
     * L1 确实走了 catch（`java.urlEncode` 是 undefined ⇒ 调用抛 TypeError），
     * 而 worker 的 `java` Proxy 兜底是 **`() => ''`** ⇒ 不抛、直接返回空串
     * ⇒ 搜索词恒为空（实测服务端 `q=` 空、页面 2KB「无结果」；带上正确的
     * `q=%E5%89%91%E6%9D%A5` 后同一 URL 返回 16KB 真结果页）。
     *
     * 语义取 percent-encoding（与 `encodeURI` 同源，UTF-8）。**刻意不照 Java `URLEncoder` 把
     * 空格变 `+`** ——本仓所有出站编码都走 percent-encoding，混两种语义会让签名类源漂移。
     */
    urlEncode: (s: unknown) => encodeURIComponent(String(s ?? '')),
    urlDecode: (s: unknown) => {
      try { return decodeURIComponent(String(s ?? '')); } catch { return String(s ?? ''); }
    },
    // 同步 HTTP（对齐 Legado java.ajax / post / get）——统一走 Legado AnalyzeUrl 语义：
    //   `{{内嵌 JS}}` 求值、`<1,2,3>` 页码模式、`,{options}` 尾巴（method/headers/body）、相对路径绝对化。
    //   此前这些 URL 被原样丢给 curl → 源脚本拼出的请求必然失败（绿柠 ajaxAll / 七猫 ruleExplore 都栽在这）。
    ajax: (url: unknown) => syncHttpSpec(url, {}, hooks.baseHeaders, hooks.sync),
    /**
     * Legado `JsExtensions.ajaxAll(urlList)`（`:154-168`）：**并发**请求一组 URL，
     * 返回**同序**的 `StrResponse` 数组（`urlList.asFlow().mapAsync(...).toList()` 保序）。
     *
     * ⚠️ 旧实现只在 **worker** 里有，L1 缺失 → L1 路径下 `java.ajaxAll(...)` 落到
     * 「未实现的 java.* 返回空串」兜底 → 脚本里 `ah[0]` 恒 undefined → 依赖它的**动态分类/列表静默为空**
     * （实测绿柠小说 exploreUrl：只剩 `push_list` 的分组头，`cy(ah[0])` 一条子分类都推不出来）。
     * worker 侧同步补齐为同一形态（`strResponse` 包装 = `new String(body)`，
     * 所以 `JSON.parse(res)` 与 `res.body()` 两种写法都能用）。
     */
    ajaxAll: (urls: unknown) => {
      const list = Array.isArray(urls) ? urls : [];
      // 复用 `syncHttp` 的返回值（它本身就是 StrResponse 形态：字符串本体 + .body()/.code()/.statusCode()）
      return list.map((u) => {
        const spec = prepareRequest(String(u ?? ''), {});
        return syncHttp(spec.method, spec.url, spec.body, spec.headers, hooks.baseHeaders, hooks.sync);
      });
    },
    /**
     * Legado `JsExtensions.connect(urlStr, header)`（:240-260）返回 **StrResponse**，
     * 不是纯字符串 —— 源脚本会链式取 `.body() / .code() / .headers() / .raw()`。
     *
     * ⚠️ **#361**：旧实现把 `syncHttpSpec` 的返回值（它**已经是**完整 StrResponse：
     * 字符串本体 + `.body()/.code()/.statusCode()/.url()/.raw()`）再 `new String(...)` 包一层，
     * 只手工补了 `body/code/headers` 三个方法 ⇒ **`raw()` 没了** ⇒
     * `java.connect(u).raw().request().url()` 抛 `raw is not a function`
     * （qyyuapi 系「💡源 站 更 新💡」按钮 `update()` 实测：29 个按钮里唯一失败的正是它，
     * 表现 = 「登录脚本执行失败」）。
     *
     * 修法 = **不要写第二份**：直接把 `syncHttpSpec` 的结果透出去（与 ajax/post/get 同一形态）。
     */
    connect: (url: unknown, headers?: unknown) => {
      // headers 可为 Java Map（Rhino 桥）或普通对象
      const h = headers instanceof Map ? Object.fromEntries(headers as Map<string, string>) : (headers as Record<string, unknown> | undefined);
      return syncHttpSpec(url, { headers: h }, hooks.baseHeaders, hooks.sync);
    },
    post: (url: unknown, body?: unknown, headers?: Record<string, unknown>) =>
      syncHttpSpec(
        url,
        {
          method: 'POST',
          body: body === undefined ? undefined : String(body),
          headers,
        },
        hooks.baseHeaders,
        // `#387c`：上游 `JsExtensions.kt:645` `java.post` = `followRedirects(false)`
        { ...(hooks.sync ?? {}), noRedirect: true },
      ),
    // ⚠️ java.head 的**唯一实现**在下方 `base.head = …`（本对象字面量里**不要**再写一份，
    //   同键后写覆盖 ⇒ 改一处不生效。2026-10-11 实测踩过，锁在 java-redirect-nofollow.test.ts）。
    /**
     * 规则求值桥（Legado `java.getString(ruleStr, mContent?)`）。
     *
     * ⚠️ 两个分支的**优先级**是有意的（2026-09-22 修 #109）：
     *  · **给了第二参 `mContent`** → 交回 `AnalyzeRule` 的规则桥（`javaExtra.getString`），
     *    它按 Legado 语义「用 mContent 当文档建临时 AnalyzeRule」求值。
     *    此处曾**把第二参整个丢掉**（签名只有 `rule`），且因为 java Proxy 的 fallback 是
     *    「base 优先于 javaExtra」（`prop in target`），`AnalyzeRule.ruleApi().getString` 永远轮不到
     *    → `java.getString(rule, content)` 的 content 静默失效。
     *  · **没给第二参** → 保持原路径（宿主注入的 `evalRule` + `contextValue`），
     *    与历史行为逐字一致（零回归）。它和规则桥在正常流程下等价（引擎的当前实例就是 contextValue 的来源）。
     */
    getString: (rule: string, mContent?: unknown) => {
      /**
       * `#341`：**null 与 undefined 同为「未传」** —— 上游 `AnalyzeRule.kt:322`
       * `val content = mContent ?: this.content`：mContent 为 null ⇒ 用**当前实例内容**。
       * Lofter 等源的 jsLib 惯用 `java.getString(e, s ?? null)`（S 的第二参缺省即 null），
       * 旧判定 `!== undefined` 把 null 当「传了」⇒ 走规则桥 `setContent(null)` ⇒ 在**空内容**上
       * 求值 ⇒ `$.post.blogId` 这类路径恒空（正文 detail URL 的 postid/targetblogid 全空）。
       */
      if (mContent != null) {
        const api = hooks.javaExtra?.['getString'];
        if (typeof api === 'function') return (api as (r: string, c?: unknown) => unknown)(rule, mContent);
      }
      return hooks.evalRule ? hooks.evalRule(rule, hooks.contextValue?.() ?? undefined) : '';
    },
    // java.get 双语义：java.get(url, headers) → HTTP GET；java.get(key) → 取变量（Legado 两处同名）
    get: (...a: unknown[]) => {
      if (a.length >= 2 || /^https?:\/\//i.test(String(a[0] ?? ''))) {
        // `#387c`：上游 `JsExtensions.kt:591` `java.get` = `followRedirects(false)`
        // —— 源脚本靠它实现「JS 拦截 3xx」（`statusCode()` 看得见 301/302）。
        return syncHttpSpec(
          a[0],
          { headers: a[1] as Record<string, unknown> },
          hooks.baseHeaders,
          { ...(hooks.sync ?? {}), noRedirect: true },
        );
      }
      const key = String(a[0]);
      return javaVarGet(variables, key);
    },
    /**
     * 变量存取（Legado `AnalyzeRule.put` → chapter/book/ruleData/**source** 变量链）。
     *
     * ⚠️ Legado 这条链是**跨阶段可读**的（`ruleBookInfo` 里 put 的键，`ruleContent` 阶段照样 get 到），
     * 而我们是无状态服务：每次 HTTP 动作新建一个 `variables`（hub），只写本地那一份就是
     * 「跨阶段必丢」。所以写本地之外，还要经 `javaExtra.putVariable`（引擎注入 → 按源持久化，
     * 与 `@put:{k:v}` 同一落点，实测七猫官方 toc 阶段 put headers → content 阶段 get 得到）。
     */
    put: (k: string, v: unknown) => {
      const key = String(k);
      const val = String(v);
      variables.set(key, val);
      const persist = hooks.javaExtra?.['putVariable'];
      if (typeof persist === 'function') {
        try {
          (persist as (k: string, v: string) => void)(key, val);
        } catch {
          /* 持久化失败不影响脚本继续（值已在本请求内生效） */
        }
      }
      return v;
    },
    // 读 Cookie（Legado JsExtensions.kt:449-462 java.getCookie(tag, key?) → CookieStore）
    getCookie: (tag: unknown, key?: unknown) => hooks.getCookie?.(String(tag ?? ''), key == null ? undefined : String(key)) ?? '',
    /**
     * `java.getSource()` / `java.getTag()`（上游 `JsExtensions.kt:127-128`）：
     * `getSource` 返回**当前源对象**（BaseSource），`getTag` 返回 `BookSource.getTag()` = `bookSourceName`。
     *
     * 宿主没注入时给「无源兜底桩」——与 `bindings.source` 的缺省形态同一份，
     * 保证脚本里 `java.getSource().getKey()` 至少不 TypeError（露出的信息为空是正确的：确实没有源）。
     */
    getSource: () => {
      try {
        return hooks.getSource?.() ?? defaultSourceStub;
      } catch {
        return defaultSourceStub;
      }
    },
    getTag: () => {
      try {
        return String(hooks.getTag?.() ?? '');
      } catch {
        return '';
      }
    },
    /**
     * `java.canOpenSourceUi()` —— ⚠️ 上游是 `private`（`JsExtensions.kt:1299`），JS 侧其实**调不到**。
     * 本仓把它作为**可注入能力**暴露，只是为了兼容那些按「有就用、没有就跳过」写的源：
     * 宿主没注入 ⇒ `false`（宁可让源早退，也不要它以为能弹窗而把流程走死）。
     */
    canOpenSourceUi: () => {
      try {
        return hooks.canOpenSourceUi?.() === true;
      } catch {
        return false;
      }
    },
    /**
     * `java.refreshBookInfo()` / `refreshBookToc()` / `refreshContent()`（上游 `:157-167`）：
     * 上游只是 `EventBus.post(REFRESH_*, true)`（通知 App 重拉详情/目录/正文），**返回 Unit、不抛**。
     * 服务端没有阅读界面 ⇒ 交宿主回调（引擎记事件/落变量），脚本侧保持「调用即成功」。
     */
    refreshBookInfo: () => {
      try { hooks.onRefreshBook?.('info'); } catch { /* 宿主回调不得影响脚本 */ }
      return '';
    },
    refreshBookToc: () => {
      try { hooks.onRefreshBook?.('toc'); } catch { /* 同上 */ }
      return '';
    },
    refreshContent: () => {
      try { hooks.onRefreshBook?.('content'); } catch { /* 同上 */ }
      return '';
    },
    /**
     * `java.getVerificationCode(imageUrl)`（上游 `:442-449`）：弹图片验证码对话框、**阻塞等人输入**，
     * 用户取消时上游 `check(result is Response)` 抛错。
     *
     * `#727` 本仓的语义（服务端）：
     *   · **worker 通道**（主路径）→ `rpc('verificationCode')` 回宿主，宿主拉起/复用该源的常驻
     *     Chromium、把验证码画面推给桌面端内置窗口，用户输入后**收回 Cookie**并把 code 返回给脚本；
     *   · **L1 通道**（主线程同步）→ 只能接宿主注入的同步钩子；服务端不注入（60s 同步等待会冻住
     *     事件循环，连提交验证码的 HTTP 端点都进不来）⇒ 明确失败，由引擎把这类脚本路由到 worker。
     *
     * ★ 不允许落 Proxy 兜底静默返回空串 —— 那会让登录脚本把空验证码提交上去，看起来像「密码错」。
     */
    getVerificationCode: (imageUrl: unknown): string => {
      const url = String(imageUrl ?? '').trim();
      if (hooks.verificationCode) return String(hooks.verificationCode(url));
      throw new Error(
        'java.getVerificationCode 需要浏览器交互（L1 同步求值通道无法等待人工输入；该脚本应交给 worker 池执行）',
      );
    },
    /**
     * `#411` —— 脚本文件 API（`JsExtensions.kt:455-493` / `:826-851`）。
     *
     * `cacheFile(url, saveTime)`：命中**文件层**（键 = `md5Encode16(url)`）直接返回；
     * 未命中才发一次同步 HTTP，**内容非空才写回**（失败下次仍会重试），返回文本。
     * `importScript(path)`：`http*` → `cacheFile`；否则 `readTxtFile`；**内容空即抛**（上游同）。
     * `readTxtFile(path)` / `deleteFile(path)`：本仓文件层的直读/直删。
     * 详细语义与「为什么必须实现」见 `selector/js-file.ts` 的头注（18AV 登录页整段求值失败）。
     */
    cacheFile: readTxtFileImpl.cacheFile,
    /**
     * `readTxtFile(path[, charset])`：`#613` 起**先文件层、再真文件系统**（上游是
     * `externalCache` 目录里的真文件；本仓两层合一，文件层不回退）。
     */
    readTxtFile: (p: unknown, charset?: unknown) => readTxtFileImpl.readTxtFile(p) || javaFileImpl.readTxtFile(p, charset),
    deleteFile: readTxtFileImpl.deleteFile,
    importScript: readTxtFileImpl.importScript,
    downloadFile: readTxtFileImpl.downloadFile,
    // `#613`：getFile / readFile / getTxtInFolder（上游 JsExtensions.kt:802-925）
    getFile: javaFileImpl.getFile,
    readFile: javaFileImpl.readFile,
    getTxtInFolder: javaFileImpl.getTxtInFolder,
    // `#615`：zip（上游 JsExtensions.kt:877-995）
    unzipFile: javaFileImpl.unzipFile,
    unArchiveFile: javaFileImpl.unArchiveFile,
    un7zFile: javaFileImpl.un7zFile,
    unrarFile: javaFileImpl.unrarFile,
    getZipStringContent: javaFileImpl.getZipStringContent,
    getZipByteArrayContent: javaFileImpl.getZipByteArrayContent,
    // 对称加密（Legado java.createSymmetricCrypto —— AES/CBC/ECB，key/iv 取 UTF-8 字节）
    createSymmetricCrypto: (transformation: string, key: unknown, iv?: unknown) => {
      const parts = String(transformation).split('/');
      const alg = (parts[0] ?? 'aes').toLowerCase();
      const mode = (parts[1] ?? 'cbc').toLowerCase();
      const pad = (parts[2] ?? 'pkcs5').toLowerCase();
      // Legado JsEncodeUtils.kt:45-75 —— key/iv 都是 **ByteArray**（另有 String 重载 = UTF-8 字节）。
      // 源脚本里的常见写法是 `java.hexDecodeToByteArray(java.digestHex(secret, "SHA-256"))`
      // → 传进来的是 Uint8Array；此前用 String(bytes) 拼成 "12,34,..." → 长度校验直接炸。
      const keyBuf = toKeyBytes(key);
      /**
       * 算法名映射 + DES 退化（2026-09-22 修，缺陷类AC；用户实测 ① 宜搜小说正文空）。
       *
       * Legado 走 hutool 的通用 `createSymmetricCrypto(transformation, key, iv)`，
       * 所以 **DES / DESede 都能用**（`JsEncodeUtils.kt:188-192`）。
       * 而 node(OpenSSL 3) **默认禁用单 DES**（legacy provider，报
       * `digital envelope routines::unsupported`）—— DES 由语料里 **7 个源**使用
       * （宜搜小说 / 晋江文学 / 书山聚合 / 移动阅读 / 阅文集团…），实测宜搜正文因此**恒空**。
       *
       * 解法（**无需 legacy provider、无新依赖**）：`DES(K) ≡ 3DES(K,K,K)` ——
       * EDE 的等密钥退化，而 `des-ede3-*` 在默认 provider 里**可用**。
       * 实测：宜搜正文用 `des-ede3-cbc` + `K||K||K` 解出完整中文正文 ✅。
       *
       * 各算法的 node 算法名与密钥长度：
       *   · AES      → `aes-128/192/256-<mode>`（长度 16/24/32）
       *   · DES      → `des-ede3-<mode>` + 密钥重复三次（长度 8）
       *   · DESede  → `des-ede3-<mode>`（24 字节）；16 字节 → `des-ede-<mode>`
       */
      const isDes = alg === 'des' || alg === 'desede' || alg === 'tripledes' || alg === 'des3';
      let algoName: string;
      let keyUse = keyBuf;
      if (isDes) {
        const m = mode === 'ecb' ? 'ecb' : mode;
        if (alg === 'des') {
          if (keyBuf.length !== 8) throw new Error('createSymmetricCrypto: DES key 长度须 8 字节，当前 ' + keyBuf.length);
          keyUse = Buffer.concat([keyBuf, keyBuf, keyBuf]); // DES(K) ≡ 3DES(K,K,K)
          algoName = 'des-ede3-' + m;
        } else {
          if (keyBuf.length === 16) algoName = 'des-ede-' + m;
          else if (keyBuf.length === 24) algoName = 'des-ede3-' + m;
          else throw new Error('createSymmetricCrypto: DESede key 长度须 16/24 字节，当前 ' + keyBuf.length);
        }
      } else {
        if (![16, 24, 32].includes(keyBuf.length)) {
          throw new Error(
            'createSymmetricCrypto: AES key 长度须 16/24/32 字节，当前 ' +
              keyBuf.length +
              '（若源脚本传的是 hex/base64 字符串，请先 java.hexDecodeToByteArray / java.base64DecodeToByteArray；' +
              '若是 DES/DESede 请写全 transformation，如 DES/CBC/PKCS5Padding）',
          );
        }
        algoName = alg + '-' + keyBuf.length * 8 + '-' + (mode === 'ecb' ? 'ecb' : mode);
      }
      const algo = algoName as Parameters<typeof createCipheriv>[0];

      const ivBuf = iv !== undefined && iv !== null && mode !== 'ecb' ? toKeyBytes(iv) : null;
      const enc = (data: Buffer) => {
        const c = ivBuf ? createCipheriv(algo, keyUse, ivBuf) : createCipheriv(algo, keyUse, null);
        if (pad === 'nopadding') c.setAutoPadding(false);
        // update+final 拼接：autoPadding 下 update 缓冲不足一块的数据，final 才吐出尾块
        return Buffer.concat([c.update(data), c.final()]);
      };
      const dec = (data: Buffer) => {
        const d = ivBuf ? createDecipheriv(algo, keyUse, ivBuf) : createDecipheriv(algo, keyUse, null);
        if (pad === 'nopadding') d.setAutoPadding(false);
        return Buffer.concat([d.update(data), d.final()]);
      };
      /**
       * `#452` **流对象也要能进 `toBytes`**（用户口径：「图片解密的规则方面，我们要兼容 legado 写法」）。
       * Legado 的 `coverDecodeJs` 里 `result` 是**真 `java.io.InputStream`**，源的标准写法是
       * `java.createSymmetricCrypto(…).decrypt(result)`（hutool 有 `decrypt(InputStream)` 重载）。
       * 本仓 `result` 是「挂了流方法的 `Uint8Array`」⇒ `instanceof Uint8Array` 那条已经接住；
       * 这里再兜一层「任何带 `readAllBytes()`/`read()` 的对象」，保证**同一个 Legado 写法**在两条路都成立。
       */
      const streamBytes = (d: unknown): Buffer | null => {
        if (!d || typeof d !== 'object' || d instanceof Uint8Array) return null;
        const o = d as { readAllBytes?: () => unknown; read?: () => unknown };
        if (typeof o.readAllBytes === 'function') {
          const v = o.readAllBytes();
          if (v instanceof Uint8Array) return Buffer.from(v);
          if (Array.isArray(v)) return Buffer.from(v as number[]);
        }
        if (typeof o.read === 'function') {
          const out: number[] = [];
          for (let i = 0; i < 8 * 1024 * 1024; i++) {
            const x = Number(o.read());
            if (!(x >= 0)) break;
            out.push(x & 255);
          }
          if (out.length) return Buffer.from(out);
        }
        return null;
      };
      const toBytes = (d: unknown): Buffer => {
        if (d instanceof Uint8Array) return Buffer.from(d);
        if (Array.isArray(d)) return Buffer.from(d as number[]);
        const sb = streamBytes(d);
        if (sb) return sb;
        return Buffer.from(String(d), 'utf-8');
      };
      return {
        encrypt: (d: unknown) => Array.from(enc(toBytes(d))),
        /**
         * hutool `SymmetricCrypto.decrypt(data)`：`data` 可以是 byte[] / InputStream / **String**，
         * 其中 **String 走 `SecureUtil.decode`（全 hex 按 hex，否则按 base64）** —— 老实现把字符串
         * 当 UTF-8 明文再解密 ⇒ Legado 写法 `cipher.decrypt(base64串)` 在本仓解出垃圾（`#452` 兼容项）。
         */
        decrypt: (d: unknown) => Array.from(dec(typeof d === 'string' ? decodeAutoCipher(d) : toBytes(d))),
        encryptStr: (d: unknown) => enc(toBytes(d)).toString('utf-8'),
        // hutool `SymmetricCrypto.decryptStr(data)`：byte[] 直解（源常传
        // java.hexDecodeToByteArray(x) 的 Uint8Array——String() 会拼成 "18,52,…" 炸掉）；
        // 字符串走 SecureUtil.decode（全 hex 则按 hex，否则按 base64）。
        decryptStr: (d: unknown) => dec(d instanceof Uint8Array ? Buffer.from(d) : decodeAutoCipher(String(d))).toString('utf-8'),
        encryptBase64: (d: unknown) => enc(toBytes(d)).toString('base64'),
        decryptBase64: (d: unknown) => dec(Buffer.from(String(d), 'base64')).toString('utf-8'),
        encryptHex: (d: unknown) => enc(toBytes(d)).toString('hex'),
        decryptHex: (d: unknown) => dec(Buffer.from(String(d), 'hex')).toString('utf-8'),
      };
    },
    // Legado 返回 Android WebView UA——空串会让源 header 覆盖默认 UA 后触发站点 400，给真实移动端 UA
    getWebViewUA: () =>
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    // webView / startBrowserAwait / startBrowser：取「JS 执行后的 DOM」。
    // 同步语义 → 同步驱动本机 Chromium（`--dump-dom`，零依赖；找不到浏览器则空串，不炸规则）。
    // 优先用宿主注入的同步渲染钩子（可与 app 层分层渲染器共用实现）。
    /**
     * `java.webView([html], url, js)` —— 对齐上游 `JsExtensions.kt:279-304`：
     * `@param html 直接用 webView 载入的 html，为空则访问 url；url 是相对路径资源的 base；
     *  js 用来取返回值的语句，没有就返回整页源码；返回 **js 的结果**。`
     *
     * ★ `#675` 修的真 bug：本仓此前签名只有 **1 个参数**（当 URL 用），于是爱看吧这种
     * `java.webView(html, baseUrl, script)` 会把**整段 HTML 当 URL** 交给渲染器
     * ⇒ 实测 `webView res len=41 head=<html><head></head><body></body></html>`（空壳）
     * ⇒ 正文恒空，而且看不出错在哪。
     *
     * 现在：只要给了 url 或 js 就走「HTML + 脚本」通道；宿主没提供该通道时**明确报错**
     * （`WEBVIEW_UNSUPPORTED`），不再假装成功返回空壳。
     */
    webView: (htmlOrUrl: unknown, url?: unknown, js?: unknown) => {
      const a = htmlOrUrl == null ? '' : String(htmlOrUrl);
      const b = url == null ? '' : String(url);
      const c = js == null ? '' : String(js);
      if (!b && !c) return renderOrFetch(a, hooks, 'cookie'); // 旧的单参形态（源传 URL）
      const fn = hooks.renderHtmlJs;
      if (!fn) {
        return 'WEBVIEW_UNSUPPORTED: 源要求「WebView 载入给定 HTML 并执行 JS 取返回值」，当前环境未提供该通道';
      }
      try {
        return fn(a, b, c);
      } catch (e) {
        return 'WEBVIEW_FAILED: ' + (e instanceof Error ? e.message : String(e));
      }
    }, // `#393` 渲染类 = 可能要浏览器登录态
    // startBrowserAwait 在 Legado 里返回 **StrResponse**（JsExtensions.kt:364-391）——
    // 源脚本常写 `result = java.startBrowserAwait(...)`，必须给兼容对象而不是裸字符串，
    // 否则 loginCheckJs 的重写语义接不上（会被当成「随便一个字符串」）。
    startBrowserAwait: (url: unknown, _tag?: unknown, _refetch?: unknown, _html?: unknown) => {
      /**
       * 与 `startBrowser` **一致地**把「脚本要求打开浏览器」通知宿主（2026-09-25 补）。
       *
       * 为什么：源常把**播放页 URL** 交给它 —— 实测 🎬茶杯狐狸 `ruleContent`：
       * ```
       * var pUrl = result.match(/"url_next":"([^"]*)"/)[1]…;  java.startBrowserAwait(pUrl, title)
       * ```
       * 即「播放地址就在正文页 HTML 里，作者只是选择用弹窗打开」。宿主据此可以把该 URL
       * 当作**媒体候选**（跟随一层解析出 m3u8/mp4），从而用内嵌播放器替代弹窗
       * （见 `engine.ts` 的 `followPlayPage`）。此前只有 `startBrowser` 通知、
       * `startBrowserAwait` 静默 → 这条最关键的地址线索被丢掉。
       */
      hooks.onBrowserOpen?.(String(url), 'cookie'); // `#393` 它在等浏览器里的结果 ⇒ 要能回传 Cookie 的真浏览器
      return makeStrResponse(String(url), renderOrFetch(String(url), hooks, 'cookie'));
    },
    /**
     * Legado `java.startBrowser(url, title, html?)`（`JsExtensions.kt:352-359`）
     * → `SourceVerificationHelp.startBrowser`（`SourceVerificationHelp.kt:348-373`）
     * → `appCtx.startActivity<WebViewActivity>{...}` —— **发射即返回（返回 Unit），不等待页面**。
     *
     * 「打开并等结果」是**另一个 API**（`startBrowserAwait`，同上 :364-391，返回 StrResponse）。
     * 旧实现让 `startBrowser` await 一次真渲染，把 UI 语义变成了阻塞语义：
     * 源只想去开浏览器，却付了整轮渲染的代价，而渲染时间算进 worker 的 10s JS 预算
     * → `JS_TIMEOUT`（实测：麻豆传媒AI 正文规则 `@js: … java.startBrowser(url,'') …`）。
     * 语料：`startBrowser` 64 次 / 20 源，字段覆盖 ruleContent/ruleExplore/exploreUrl/jsLib/loginUrl。
     */
    startBrowser: (url: unknown) => {
      hooks.onBrowserOpen?.(String(url), 'show'); // `#393` fire-and-forget「打开给人看」⇒ 应用内浏览器即可
      return ''; // Rhino 里真实返回 undefined；给 '' 更安全（有源把它当字符串拼，见 兽人小说站 return startBrowser(...)）
    },
    /**
     * Legado `java.showBrowser(url, html, tag?)` —— **把一段 HTML 交给浏览器显示**。
     *
     * 用户报障 ⭐七猫[官方]：「段评/本章说/神评/书评」点不开。该源没有 `ruleReview`，
     * 评论面板是 jsLib **自绘**：内容里的 SVG 气泡图带 `{"click":"qmC_OpenComment(...)"}`
     * 选项，`qmC_OpenComment` 调 `java.showBrowser('https://api-cmnt.wtzw.com/', html, …)`。
     * 我们此前没有这个 API（未知属性落 Proxy 兜底的空函数）⇒ 点击静默无反应。
     *
     * 实现：把 html 转成 `data:text/html;base64,…`（若给了 http base 且在 html 里补 `<base href>`，
     * 让面板里的相对请求/接口仍打到正确域），走与 `startBrowser` 相同的 `browser` 通道
     * （`kind='show'` ⇒ 应用内浏览器）。不返回内容（上游是 fire-and-forget）。
     */
    showBrowser: (url: unknown, html: unknown) => {
      const base = String(url ?? '').trim();
      const body = html == null ? '' : String(html);
      const target = body.trim() ? htmlToDataUrl(body, base) : base;
      if (target) hooks.onBrowserOpen?.(target, 'show');
      return '';
    },
    /**
     * Legado `java.openUrl(url, mimeType?)`（`JsExtensions.kt:1239-1269`）——
     * **把链接交给系统打开**（App 里是 `OpenUrlConfirmActivity` 确认框后再 `startActivity`）。
     *
     * 语料 22 源在用，主流形态是两类：
     *  · `java.openUrl('legado://import/addToBookshelf?src=' + 编码后的 bookUrl + origin)` ——
     *    「🔗 一键开书」按钮（🔍找书啦）；`yuedu://` 同义（本仓自己的 scheme）。
     *  · `java.openUrl('lofter://…')` / 普通 http —— 跳到 App 深链或浏览器（📖Lofter / 📖微博）。
     *
     * ## 语义要点（照上游，不自己发明）
     * 1. **超长直接抛**：上游 `require(url.length < 64 * 1024)`，不是截断；
     * 2. **UI 不可用 ⇒ 静默 return**（上游 `if (!canOpenSourceUi()) return`）——
     *    所以服务端不能因为「没有系统浏览器」就抛错：源普遍写成
     *    `try{ java.openUrl(u); ok='✅ 已调起' }catch(e){ ok='⚠️ 调起失败:'+e.message }`，
     *    抛错会把按钮文案变成失败（找书啦就是这样显式 catch 的）；
     * 3. 返回 Unit ⇒ 这里给 `''`（有源把它当字符串拼）。
     *
     * 落地：走与 `startBrowser` 相同的 `browser` 通道（`kind='show'`），宿主/前端决定怎么处理
     * ——`legado://` / `yuedu://` 由客户端做导入，http 用应用内浏览器。
     * `mimeType` 上游只用于「按类型挑外部 App」，服务端没有这一层，故忽略（不编造行为）。
     */
    openUrl: (url: unknown, _mimeType?: unknown) => {
      const u = String(url ?? '');
      if (u.length >= 64 * 1024) throw new Error('java.openUrl: parameter url too long');
      if (u) hooks.onBrowserOpen?.(u, 'show');
      return '';
    },
    /**
     * Legado `java.upLoginData(data: Map)`（`SourceLoginJsExtensions.kt:35-37`）——
     * **实时更新登录界面的字段值**（不是保存）。服务端无 UI ⇒ 回调宿主随登录结果回传前端回填。
     * ⚠️ 曾**完全未实现**：Proxy 兜底返回空函数 ⇒ 脚本写了 `java.upLoginData({'网址': …})` 是**静默空转**
     * （用户 2026-10-15 实测 18AV「🌐获取网址」：toast 说「已填写最新网址」而输入框仍空）。
     */
    upLoginData: (data: unknown) => {
      try {
        hooks.onUpLoginData?.(data);
      } catch {
        /* 宿主回调不得影响脚本执行 */
      }
      return '';
    },
    // java.webViewGetSource(html?, url?, js?, sourceRegex)（JsExtensions.kt:261-289）：
    // Legado 用后台 WebView 打开页面并拦截**子资源**（命中 sourceRegex 的资源 URL 即返回）。
    // 服务端降级：渲染 url 后在 DOM 里找匹配的绝对 URL（子资源拦截需 CDP，见 app 层 L3）。
    webViewGetSource: (html: unknown, url: unknown, js: unknown, sourceRegex: unknown) => {
      const target = url != null && String(url) ? String(url) : '';
      void html;
      void js;
      if (!target) return '';
      const re = sourceRegex == null ? '' : String(sourceRegex);
      if (hooks.renderSource) return hooks.renderSource(target, re);
      if (!syncRenderEnabled()) return '';
      return syncRenderHtml(target, { sourceRegex: re || undefined });
    },
    androidId: () => '0000000000000000',
    // 时间格式化（对齐 Legado：默认 "yyyy/MM/dd HH:mm"，AppConst.dateFormat）
    // —— 默认 UA（Legado getUserAgent：headerMap UA 或默认）——
    getUserAgent: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    timeFormat: (t: unknown, fmt?: unknown) =>
      javaTimeFormat(Number(t), typeof fmt === 'string' ? fmt : 'yyyy/MM/dd HH:mm'),
    timeFormatUTC: (t: unknown, fmt: unknown, sh: unknown) => {
      const d = new Date(Number(t) + Number(sh ?? 0) * 3600_000);
      return javaTimeFormat(d.getTime(), typeof fmt === 'string' ? fmt : 'yyyy-MM-dd');
    },
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      // AnalyzeRule 规则桥（java.getElements/getStringList/setContent——Legado bindings["java"]=this）
      const extra = hooks.javaExtra;
      if (extra && prop in extra) return extra[prop];
      // 未实现的 java.* API 返回空串（对齐 cookie/cache 桩）——炸规则会整源失败，空串可走后续兜底规则
      return () => '';
    },
  });
}

/**
 * 严格 hex 解码（对齐 hutool `HexUtil.decodeHexStr` / `Base16Codec.decode`，Legado
 * `java.hexDecodeToString` / `hexDecodeToByteArray` 的实现）：
 *   · 空串 → 原样返回（hutool `StrUtil.isEmpty` 早返回）；
 *   · 先去空白（hutool `StrUtil.cleanBlank`）；
 *   · 奇数长度**前面补 0**凑偶（hutool 同款）；
 *   · 出现非 hex 字符 → **抛错**（hutool `toDigit` 抛
 *     `Illegal hexadecimal character {} at index {}`）。
 *
 * 为什么必须严格：Node 的 `Buffer.from(s,'hex')` 遇非法字符**静默截断**——七猫官方正文
 * 传进来的是 `"630355/90f43448…"`（含 `/`），旧实现安静地解出 3 个字节，规则随后拿它当
 * chapterId 去请求 → 站点「参数错误」→ 最终表现为 `Cannot read properties of undefined
 * (reading 'data')`。整条链路没有一个环节报错，排查成本极高（静默错值）。
 */
function hexStrict(s: string): string {
  const cleaned = String(s ?? '').replace(/\s+/g, '');
  if (!cleaned) return '';
  const padded = cleaned.length % 2 ? `0${cleaned}` : cleaned;
  if (!/^[0-9a-fA-F]+$/.test(padded)) {
    const bad = padded.search(/[^0-9a-fA-F]/);
    throw new Error(`Illegal hexadecimal character ${JSON.stringify(padded[bad])} at index ${bad}`);
  }
  return padded;
}

/**
 * `java.get(key)` 的取值链：本请求 `variables` → **按源持久变量** `sourceVariable`。
 *
 * L1 与 worker（经 `javaVarGet` RPC）**共用这一份实现**，避免两条路径语义漂移。
 * 为什么必须回落：Legado 的变量链（`AnalyzeRule.get` :872-888）跨阶段可读，而 hub 每个 HTTP
 * 动作新建一个 variables，只写本地那份就「跨阶段必丢」——七猫系在 toc 阶段 put 的 headers
 * （含签名）在 content 阶段读到空，表现为「请求不带签名字段」的静默失败。
 *
 * ★ **2026-09-28（缺陷类BT）**：实现上收到 `rule-analyzer.getVarValue` —— 因为
 * Legado 里 `@get:{k}` 与 `java.get(k)` 走的是**同一条链**（`AnalyzeRule.kt:810-812` 的
 * `getRuleType -> get(param)`），而 `@get:{…}` 那 6 处此前只读顶层 ⇒
 * 「同进程能过、服务端跨请求为空」。**同一条链只留一份实现**，别再在这里重写。
 */
function javaVarGet(variables: { get: (k: string) => unknown }, key: string): string {
  return getVarValue(variables, key);
}

/** java.timeFormat 的时间格式化（支持 yyyy/MM/dd/HH/mm/ss 词元） */
function javaTimeFormat(ms: number, pattern: string): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return pattern
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

/** cookie 桩：优先接源级 CookieStore（登录态/持久化），否则进程内 KV */
/**
 * cookie 桩（Legado `bindings["cookie"] = CookieStore`，JsExtensions.kt:896）——
 * 对齐 CookieManagerInterface 的 **URL 形态** API：
 *   getCookie(url) / setCookie(url, cookie) / replaceCookie(url, cookie) / removeCookie(url)
 *   / getKey(url, key) / cookieToMap / mapToCookie
 * 我们的存储是「每源一份扁平 name→value」（Legado 按二级域名分桶），故 url 参数不参与分桶。
 */
/** `#410` cookie 兜底留痕（铁律 4：静默兜底是「反复出现的形同问题」的温床；同 key 只打一次） */
const cookieWarned = new Set<string>();
function cookieWarn(tag: string, msg: string): void {
  if (cookieWarned.has(tag)) return;
  cookieWarned.add(tag);
  console.warn(`[cookie] ${msg}`);
}

function makeCookieStub(external?: import('../contract/engine').CookieStore): Record<string, unknown> {
  const store = new Map<string, string>();
  const getK = (k: string) => external?.get(k) ?? store.get(k) ?? '';
  const setK = (k: string, v: unknown) => {
    if (external) external.set(k, String(v));
    else store.set(k, String(v));
  };
  const delK = (k: string) => {
    if (external?.remove) external.remove(k);
    else store.delete(k);
  };
  // `#410`：cookie 拆分/校验的唯一实现在 `selector/web-cookie.ts`（与 worker 共用同一判据）
  const parsePairs = parseCookiePairs;
  const header = () =>
    external ? external.header() : Object.entries(Object.fromEntries(store)).map(([k, v]) => `${k}=${v}`).join('; ');
  return new Proxy(
    {
      // 简写（非 Legado，保留兼容）
      get: getK,
      set: setK,
      remove: delK,
      header,
      // Legado CookieStore API
      getCookie: (_url: string) => header(),
      setCookie: (_url: string, cookie: unknown) => {
        for (const [k, v] of parsePairs(cookie)) setK(k, v);
      },
      replaceCookie: (_url: string, cookie: unknown) => {
        // 合并语义 = 逐键覆盖（对齐 CookieStore.replaceCookie → mergeCookie）
        for (const [k, v] of parsePairs(cookie)) setK(k, v);
      },
      removeCookie: (_url: string) => {
        // 每源独立 store：整清相当于移除该域 cookie
        for (const k of Object.keys(Object.fromEntries(store))) delK(k);
      },
      getKey: (_url: string, key: string) => getK(String(key)),
      /**
       * `#410` 上游 `CookieStore.setWebCookie(url, cookie)`（`CookieStore.kt:41-53`）：
       * 把 cookie 交给**内置浏览器**（Android `CookieManager`），**不落库**。
       * 本仓没有 Android WebView ⇒ 取等价且**真正生效**的落点 = 源级 CookieStore
       * （上游只影响内置浏览器，我们同时影响后续所有请求 ⇒ **有意超集**；详见 web-cookie.ts）。
       * 判据（拆分 + URL 校验）与 worker 侧**同一份实现**；按上游语义**不落库**以外的行为不变。
       * 铁律 4：上游此处是**静默** return —— 我们补 `warnOnce`（结果不变，只加可见性）。
       */
      setWebCookie: (url: unknown, cookie: unknown) => {
        const r = webCookiePairs(url, cookie);
        if (!r.ok) {
          cookieWarn(`setweb:${r.reason}`,
            `cookie.setWebCookie 已忽略（${r.reason === 'BAD_URL' ? 'url 解析不出主机名' : 'cookie 为空'}）：url=${String(url).slice(0, 100)}`);
          return;
        }
        for (const [k, v] of r.pairs) setK(k, v);
      },
      cookieToMap: (cookie: unknown) => Object.fromEntries(parsePairs(cookie)),
      /**
       * `#639` 除了 Map，还要吃 **`response.cookies()` 的返回值**（Cookie 项数组）。
       *
       * 🔞爱丽丝书屋（大侠修）loginUrl 的写法就是 `cookie.mapToCookie(response.cookies())`
       * —— 上游 okhttp 的 `cookies()` 给的是 `List<Cookie>`，不是 Map。
       * 旧实现只走 `Object.entries(map)` ⇒ 数组会被展开成 `0=[object Object]&1=…`
       * 这种垃圾 Cookie 头（静默错值）。这里对「数组 + `{name,value}`」单独识别。
       */
      mapToCookie: (map: Record<string, unknown> | Map<string, unknown> | unknown[]) => {
        if (Array.isArray(map)) {
          return map
            .map((it) => {
              if (typeof it === 'string') return it;
              const o = (it ?? {}) as { name?: unknown; value?: unknown };
              return o.name != null ? `${String(o.name)}=${String(o.value ?? '')}` : '';
            })
            .filter(Boolean)
            .join('; ');
        }
        const entries = map instanceof Map ? [...map.entries()] : Object.entries(map ?? {});
        return entries.map(([k, v]) => `${k}=${String(v)}`).join('; ');
      },
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        // `#410`：未实现的 cookie.* **不再静默**（旧实现直接给 `() => ''`）——
        // 与 cache 桩的 `cacheWarn(method:…)` 同一判据族。`setWebCookie` 就是被这条
        // 静默兜底吞掉的（源脚本以为设上了，实际没有）。
        if (typeof prop === 'string' && prop !== 'then' && prop !== Symbol.toStringTag.toString()) {
          cookieWarn(`method:${prop}`, `源脚本调用了未实现的 cookie.${prop}() —— 已按空值返回`);
        }
        return () => '';
      },
    },
  );
}

/* ── `cache.*` 的两层落点（对齐 Legado `CacheManager.kt`）──────────────────────────
 *
 * Legado 把 `cache` 绑成 `CacheManager`（`AnalyzeRule.kt:897`、`AnalyzeUrl.kt:382`）：key 是**全局**的，
 * 两层存储 —— 内存 LruCache（进程级，50MB 上限）+ DB（持久）；`put(key, value, saveTime)` 的 saveTime
 * **单位是秒**、`0` = 不过期，且**带 TTL 时不驻内存**（`CacheManager.put` 里 `deleteMemory`）。
 *
 * 我们落成两层，都放进 `variables`（**同步可读**，与 `sourceVariable` / `__loginInfo` 同一手法）：
 *   · 持久层 `__srcCache`：JSON `{k: {v, dl}}`。引擎请求前从 storage 注入、请求后落盘
 *     （`primeSourceCache` / `persistSourceCache`）→ **跨请求 + 跨重启**；
 *   · 内存层 `__memCache`：JSON `{k: v}`。宿主进程内保留（hub 注入 / 回写）→ **跨请求、不落盘**，
 *     对齐 Legado 的进程级 LruCache（`putMemory` 语义）。
 *
 * 为什么必须分成两层（2026-09-22 语料实测，不是照搬 Legado 的结构）：
 *   · 🎨快看漫画 `ruleBookInfo.init` 里 `cache.put("kkmh", json)` → `ruleToc` 里 `cache.get('kkmh')`
 *     ⇒ 详情与目录是**两次 HTTP 请求**，需要持久层；
 *   · 📂小说阅读 `init` 里 `cache.putMemory('articleid', id)` → `ruleToc.chapterUrl` 的
 *     `{{cache.getFromMemory('articleid')}}` ⇒ 同样跨请求，但源选的是**内存层**：若把内存层实现成
 *     「本次求值内有效」，这个源的章节 URL 会静默拼成空；
 *   · 🏷晋江文学 `cache.put("jjtime", true, 11600)` ⇒ **必须消费 TTL 第三参**；
 *   · ⚡酷我小说 / 🔊懒人听书 用 `cache.getFile/putFile` ⇒ 文件层（Legado 落 ACache 文件，我们复用持久层）。
 *
 * ⚠️ **未命中返回 `null`**（对齐 Legado `CacheManager.get(): String?`），**不是空串**。
 *   旧的 `makeCacheStub` 返回 `''`：会让源的「未命中」判定失效
 *   （⚡酷我小说 `sort = cache.getFile('KuwoNovels'); if (sort==null){…}`），
 *   并把 `JSON.parse(cache.get(k))` 从「正常走未命中分支」打成抛错。
 *
 * ⚠️ **key 是全局的（对齐 Legado）**：持久层落 `cache:global`、内存层由 hub 维护**一份**进程级缓存，
 *   不按 sourceId 隔离。这不是实现细节 —— qyyuapi 系的激活链路就是「XH发布页」登录写入
 *   `XHaccount` / `XHtime` / `xhJson`，同系所有源在 `user_Check` 里读同一份缓存；
 *   按源隔离会让这条路彻底断掉（实测各源读不到激活码 ⇒ 只出兜底 1 条）。
 *   代价：一个源 `cache.delete(k)` 会影响别的源（上游 `CacheManager` 同样如此）。
 */
const CACHE_BINDING_DISK = '__srcCache';
const CACHE_BINDING_MEM = '__memCache';
/** 文件层用持久层 + 前缀（Legado 把文件缓存放 ACache 文件，我们没必要真写盘） */
const CACHE_FILE_PREFIX = 'file:';
/** 单键值上限（对齐 `YUEDU_NET_MAX_BODY_MB=8`）：超限**不缓存并留痕**，防单个大 body 撑爆 storage */
const CACHE_MAX_VALUE = 8 * 1024 * 1024;
/** 单层键数上限：防源脚本用循环键名（按时间戳/URL）把 storage 撑大 */
const CACHE_MAX_KEYS = 500;
const cacheWarned = new Set<string>();
function cacheWarn(tag: string, msg: string): void {
  if (cacheWarned.has(tag)) return;
  cacheWarned.add(tag);
  // eslint-disable-next-line no-console
  console.warn(`[cache] ${msg}`);
}

interface CacheEntry {
  v?: unknown;
  dl?: unknown;
}

function readCacheBag(variables: VariableStore, binding: string): Record<string, CacheEntry> {
  const raw = variables.get(binding);
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function cacheRead(variables: VariableStore, binding: string, key: string): string | null {
  const e = readCacheBag(variables, binding)[key];
  if (!e || typeof e !== 'object') return null;
  const dl = Number(e.dl ?? 0);
  // 过期按未命中处理（对齐 Legado：get 只判 deadline，不做顺带清理）
  if (dl > 0 && dl <= Date.now()) return null;
  return e.v == null ? null : String(e.v);
}

function cacheWrite(variables: VariableStore, binding: string, key: string, value: string, saveTime: number): void {
  if (value.length > CACHE_MAX_VALUE) {
    cacheWarn(`big:${binding}`, `缓存值 ${(value.length / 1048576).toFixed(1)}MB 超过 ${CACHE_MAX_VALUE / 1048576}MB 上限，本次不缓存（键 ${key}）`);
    return;
  }
  const bag = readCacheBag(variables, binding);
  if (!(key in bag) && Object.keys(bag).length >= CACHE_MAX_KEYS) {
    cacheWarn(`full:${binding}`, `缓存键数已达 ${CACHE_MAX_KEYS} 上限，本次不写入（键 ${key}）`);
    return;
  }
  bag[key] = { v: value, dl: saveTime > 0 ? Date.now() + saveTime * 1000 : 0 };
  variables.set(binding, JSON.stringify(bag));
}

function cacheDelete(variables: VariableStore, binding: string, key: string): void {
  const bag = readCacheBag(variables, binding);
  if (!(key in bag)) return;
  delete bag[key];
  variables.set(binding, JSON.stringify(bag));
}

/** `cache.put/putFile` 的第三个参数（秒，0/非正/非法 = 不过期） */
function toSaveTime(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `cache.*` 的**宿主面**：L1 的 `makeCacheStub` 与 worker（经 `cacheGet/cachePut/…` RPC → `hostRpc`）
 * **共用这一份实现**，避免两条路径语义漂移（历史教训：`this.*` 与 `java.*` 各写一份 → 分叉）。
 */
export interface CacheOps {
  get: (k: string, onlyDisk?: boolean) => string | null;
  put: (k: string, v: string, saveTime?: number) => void;
  remove: (k: string) => void;
  memGet: (k: string) => string | null;
  memPut: (k: string, v: string) => void;
  memRemove: (k: string) => void;
  getFile: (k: string) => string | null;
  putFile: (k: string, v: string, saveTime?: number) => void;
}

export function makeCacheOps(variables: VariableStore): CacheOps {
  return {
    // Legado `get(key)`：先内存 LRU，再 DB；`get(key, onlyDisk=true)` 跳过内存
    get: (k, onlyDisk) => {
      if (!onlyDisk) {
        const m = cacheRead(variables, CACHE_BINDING_MEM, k);
        if (m !== null) return m;
      }
      return cacheRead(variables, CACHE_BINDING_DISK, k);
    },
    put: (k, v, saveTime = 0) => {
      // 带 TTL ⇒ 不驻内存（对齐 CacheManager.put 的 deleteMemory 分支）
      if (saveTime > 0) cacheDelete(variables, CACHE_BINDING_MEM, k);
      else cacheWrite(variables, CACHE_BINDING_MEM, k, v, 0);
      cacheWrite(variables, CACHE_BINDING_DISK, k, v, saveTime);
    },
    // Legado `delete`：DB + 内存 + 文件三处全删
    remove: (k) => {
      cacheDelete(variables, CACHE_BINDING_MEM, k);
      cacheDelete(variables, CACHE_BINDING_DISK, k);
      cacheDelete(variables, CACHE_BINDING_DISK, CACHE_FILE_PREFIX + k);
    },
    memGet: (k) => cacheRead(variables, CACHE_BINDING_MEM, k),
    memPut: (k, v) => cacheWrite(variables, CACHE_BINDING_MEM, k, v, 0),
    memRemove: (k) => cacheDelete(variables, CACHE_BINDING_MEM, k),
    getFile: (k) => cacheRead(variables, CACHE_BINDING_DISK, CACHE_FILE_PREFIX + k),
    putFile: (k, v, saveTime = 0) => cacheWrite(variables, CACHE_BINDING_DISK, CACHE_FILE_PREFIX + k, v, saveTime),
  };
}

/** Proxy 上不触发「未实现方法」告警的属性（运行时探测，不是源脚本调用） */
const CACHE_PROBE_KEYS = new Set(['then', 'toJSON', 'inspect', 'constructor', 'prototype', 'valueOf', 'toString']);

/**
 * L1 的 `cache` 绑定：Legado `CacheManager` 的公开面（`put/get/putMemory/getFromMemory/delete/…`）。
 * 所有落点经 `makeCacheOps` —— 与 worker RPC 面**同源**。
 */
function makeCacheStub(variables: VariableStore): Record<string, unknown> {
  const ops = makeCacheOps(variables);
  const num = (k: string, f: (x: number) => number): number | null => {
    const raw = ops.get(k); // Legado getInt/getLong/getDouble/getFloat 先内存后磁盘
    if (raw == null || raw === '') return null;
    const x = Number(raw);
    return Number.isFinite(x) ? f(x) : null;
  };
  return new Proxy(
    {
      put: (k: string, v: unknown, saveTime?: unknown) => {
        ops.put(String(k), v == null ? '' : String(v), toSaveTime(saveTime));
        return v;
      },
      putMemory: (k: string, v: unknown) => {
        ops.memPut(String(k), v == null ? '' : String(v));
        return v;
      },
      get: (k: string, onlyDisk?: unknown) => ops.get(String(k), Boolean(onlyDisk)),
      getMemory: (k: string) => ops.memGet(String(k)),
      getFromMemory: (k: string) => ops.memGet(String(k)),
      delete: (k: string) => {
        ops.remove(String(k));
        return true;
      },
      deleteMemory: (k: string) => {
        ops.memRemove(String(k));
        return true;
      },
      putFile: (k: string, v: unknown, saveTime?: unknown) => {
        ops.putFile(String(k), v == null ? '' : String(v), toSaveTime(saveTime));
        return v;
      },
      getFile: (k: string) => ops.getFile(String(k)),
      getInt: (k: string) => num(String(k), Math.trunc),
      getLong: (k: string) => num(String(k), Math.trunc),
      getDouble: (k: string) => num(String(k), (x) => x),
      getFloat: (k: string) => num(String(k), (x) => x),
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (!CACHE_PROBE_KEYS.has(String(prop)) && typeof prop === 'string') {
          // 未实现的 cache API 不静默：源脚本用了我们没做的能力必须能看见
          cacheWarn(`method:${prop}`, `源脚本调用了未实现的 cache.${prop}() —— 已按空值返回`);
        }
        return () => '';
      },
    },
  );
}

/**
 * 构造 this 上下文：`this.M / this.get / this.put / this.setHeaders / this.encode / this.getHeaderMap`。
 *
 * ⚠️ 这张面必须与 worker 里的 `thisScope`（`worker-pool.ts` 的 WORKER_SRC）**逐项一致** ——
 * 否则「同一份源在带 java.ajax 的规则（走 worker）与不带（走 L1）」表现不同。
 * 实测：晋江文学 v3.6+ 的 jsLib 调 `this.getHeaderMap()`，worker 侧原本连这个方法都没有 → NOT_A_FUNCTION。
 *
 * `put`/`get` 与 `java.put`/`java.get` **共用同一条链**（本地 variables ⊕ 按源持久落点），
 * 不再各写一份（历史教训：`this.*` 与 `java.*` 语义分叉）。
 */
function makeThisScope(
  variables: VariableStore,
  opts?: { persist?: (k: string, v: string) => void; headers?: () => Record<string, string> },
) {
  return {
    M: (k: string) => variables.get(k) ?? '',
    get: (k: string) => javaVarGet(variables, k),
    /**
     * `this.put` 两形态（对齐 Legado：jsLib 顶层的 `function put(...)` 就是 `this` 上的同名方法）。
     *
     * ① **单参 = 保存整份源变量** —— qyyuapi 系 jsLib 的约定（common.js:
     *    `function put(data){ … source.setVariable(JSON.stringify(data)) }`），
     *    五个 qyyuapi 漫画源全部写 `this.put(original)` / `this.put($$$)`。
     *    旧实现一律按二元 put 处理 ⇒ `String(obj)="[object Object]"`、`String(undefined)="undefined"`
     *    ⇒ 源变量被持久化成 `{"[object Object]":"undefined"}` ⇒ `Get('url')` 取不到站点
     *    ⇒ 分类 URL 变成 `undefined/comics`（「用过一次就坏」的取证栈在 `putSharedVariable`）。
     *    ⚠️ 单参**不走** `opts.persist`：那条链是「把 kv 并进源变量 JSON」，
     *    会把整份 JSON 当成 value 再套一层。
     * ② 双参保持 `put(k, v)`（本请求可见 + 按源持久，与 `java.put` 同一落点）。
     */
    put: (k: unknown, v?: unknown) => {
      if (v === undefined) {
        const text = typeof k === 'string' ? k : JSON.stringify(k) ?? '';
        variables.set('sourceVariable', text);
        return k;
      }
      const key = String(k);
      const val = String(v);
      variables.set(key, val);
      opts?.persist?.(key, val);
      return v;
    },
    setHeaders: (_h: unknown) => undefined,
    encode: (s: string) => encodeURIComponent(String(s)),
    /** Legado `BaseSource.getHeaderMap()`：jsLib 里常写 `this.getHeaderMap()` 取签名字段 */
    getHeaderMap: () => opts?.headers?.() ?? {},
  };
}

export interface JsEvalOptions {
  variables: VariableStore;
  /** AnalyzeRule 规则桥合并点（java.getElements/getStringList/setContent；AnalyzeRule 构造时写入同一对象） */
  javaExtra?: Record<string, unknown>;
  /** java.getCookie(tag, key?) 读取（注入 cookie 桩） */
  getCookie?: (tag: string, key?: string) => string;
  /** java.toast / java.longToast 回调（宿主收集；见 makeJavaStub 的 onToast 说明） */
  onToast?: (msg: string, long: boolean) => void;
  /**
   * `java.upLoginData(data)` 回调（脚本要求**实时更新登录界面字段值**）。
   * 见 `makeJavaStub` 的 `upLoginData` 说明；引擎在登录流程里把它收成一份 map 随结果回传前端。
   */
  onUpLoginData?: (data: unknown) => void;
  /**
   * `#196` 源身份标签（形如 `源名(https___x.com)`）—— 给 java-bridge 的「未实现的 Java 类」
   * 这类留痕用，便于定位是哪个源触发的静默空值。不传则不显示（测试场景）。
   */
  sourceLabel?: string;
  /**
   * 源级默认请求头提供者（源 `header` 规则 ⊕ 登录头；Cookie 由本模块从 `cookies` 补）。
   *
   * 由引擎注入（`header` 规则可能是 `@js:`，只有引擎知道怎么求值）。惰性调用：
   * 脚本不发 HTTP 就零开销；L1 与 worker(经 hostRpc) 两条路径都会带上，
   * 对齐 Legado `AnalyzeUrl(url, baseUrl, source)` 的 `source.getHeaderMap()`。
   */
  getSourceHeaders?: (url?: string) => Record<string, string> | undefined;
  /**
   * 同步 HTTP 传输实现（缺省 curl 子进程，见 `curlSyncFetch`）。
   *
   * 存在的意义：
   *  · **测试可打桩** —— 过去 `java.ajax` 绕过一切注入点，只能靠真实网络验证；
   *  · **宿主可换栈** —— 想接到自带 HTTP 客户端/代理上时不必改 core。
   * 需要走注入 `HttpClient`（mock/代理/统一超时）的脚本请走 worker 池（`HybridEvalOptions.http`）。
   */
  syncFetch?: (req: SyncHttpRequest) => SyncHttpResponse;
  /**
   * 单次同步 HTTP 超时（毫秒，缺省 15 000）。
   * 实测慢站响应在 1.6~15s 抖动，旧的硬编码 10s 会把「能出内容的源」变成空 body。
   */
  syncTimeoutMs?: number;
  /** 源级 Cookie 存储（登录态），可选；cookie.get/set 透传到此 */
  cookies?: import('../contract/engine').CookieStore;
  /** 源的 jsLib：每次求值前注入的前导代码（Legado AnalyzeRule.getJSLib 语义） */
  lib?: string;
  /**
   * 规则求值桥：java.getString(ruleStr) 对当前上下文（bindings.$）求规则。
   * 引擎注入（JSON 文档走 jsonGetString 等）。
   */
  evalRule?: (rule: string, value: unknown) => string;
  /**
   * 「脚本要求打开浏览器」回调（java.startBrowser / startBrowserAwait / webView）。
   * 引擎用它记录 URL，登录流程据此把登录页交给前端打开（人工/验证码）。
   */
  onBrowserOpen?: (url: string, kind?: BrowserOpenKind) => void;
  /**
   * `java.refreshBookInfo()/refreshBookToc()/refreshContent()` —— 上游只是发 EventBus 刷新事件。
   * 服务端没有阅读界面：引擎把它记成事件（日志 + 变量袋标记），前端/上层可据此决定重拉。
   */
  onRefreshBook?: (kind: 'info' | 'toc' | 'content') => void;
  /** `java.canOpenSourceUi()` —— 宿主是否具备打开源网页/视频的能力（缺省 false；上游本为 private） */
  canOpenSourceUi?: () => boolean;
  /** `java.getSource()` —— 返回当前源桩（BaseSource 只读视图） */
  getSource?: () => unknown;
  /** `java.getTag()` —— 源名（上游 `BookSource.getTag()` = `bookSourceName`） */
  getTag?: () => string;
  /**
   * `#727` `java.getVerificationCode(imageUrl)` 的**同步**通道（L1）。
   * 服务端的人工输入是异步的 ⇒ 那条走 `HybridEvalOptions.verificationCodeAsync`。
   */
  verificationCode?: (imageUrl: string) => string;
}

/**
 * 「顶层声明提升」——对齐 Rhino：脚本顶层的 `function foo(){}` / `var foo = …`
 * 会成为**全局对象的属性**，所以源脚本大量使用 `this.foo()`（例：独阅读网 loginUrl 的
 * `this.auto_reg()` / `this.Login(param)` / `this.decrypt(res)`）。
 *
 * 我们用的是直接 eval：非严格模式下 eval 里的 function/var 声明只落在 **eval 所在函数的作用域**，
 * `this.foo`（this = globalThis）拿不到 → 报 `this.foo is not a function`。
 *
 * 对齐方式（关键在**时序**：脚本自己那句 `this.foo()` 也在同一个 eval 里执行）：
 *   1) 函数声明在 JS 里是提升的 → 把 `globalThis.x = x` 放在**同作用域的最前面**即可，
 *      此时 x 已绑定。lib 的声明提升到 `fn` 函数体顶部，code 的声明提升到 eval 字符串顶部，
 *      故两处都要前置注入（分别注入到对应的作用域里）。
 *   2) `var x = function(){}` 是**语句**赋值，只能在语句执行之后补挂 → 放在 eval 之后。
 *   3) 全部包 `typeof x !== "undefined"` 守卫：名字不存在时跳过，绝不误设 undefined。
 */
/** key/iv 归一：ByteArray（Uint8Array/number[]）直用；字符串按 UTF-8（对齐 Kotlin encodeToByteArray） */
function toKeyBytes(v: unknown): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v.map((x) => Number(x) & 0xff));
  return Buffer.from(String(v ?? ''), 'utf-8');
}

/**
 * 密文解码（对齐 hutool `SecureUtil.decode` + `Validator.isHex`）：
 * 全 `[0-9a-fA-F]+` → hex，否则 → base64。
 */
function decodeAutoCipher(s: string): Buffer {
  const t = s.trim();
  if (t && /^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return Buffer.from(t, 'hex');
  try {
    return Buffer.from(t, 'base64');
  } catch {
    return Buffer.from(t, 'utf-8');
  }
}

/**
 * Java 摘要算法名 → Node 名。
 * "SHA-256" → "sha256" · "MD5" → "md5" · "SHA-1"/"SHA" → "sha1" · "HmacSHA256" → "sha256"
 * （Java 的 HMac 算法名带 `Hmac` 前缀，Node 的 createHmac 只认裸算法名）
 */
function digestAlgoName(algorithm: unknown): string {
  let raw = String(algorithm ?? 'md5').trim().toLowerCase().replace(/[-_]/g, '');
  if (raw.startsWith('hmac')) raw = raw.slice(4);
  const aliases: Record<string, string> = { sha: 'sha1', md5: 'md5' };
  return aliases[raw] ?? raw;
}

/** JS 保留字：`var` 预置语句里不能出现（scanDecls 的标识符正则理论上不会给出，这里是保险） */
const JS_RESERVED = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'true',
  'false', 'class', 'extends', 'super', 'import', 'export', 'default', 'try', 'catch', 'finally',
  'throw', 'void', 'yield', 'await', 'async', 'static', 'get', 'set',
]);

/**
 * ★★ **内置全局名**：`hoistStmts` 绝不允许把它们写到 `globalThis` 上（`#595` 的真因）。
 *
 * 事故链（2026-10-24 全量基线 Top1，**65 个源**挂在
 * `Cannot read properties of undefined (reading 'getLoginInfoMap')`）：
 *  - 聚合类源的 jsLib 里普遍自己实现了一个 `function Map(e){ const {source}=this; … }`
 *    （qyyuapi 系的 `jsLib.js`／`common.js` 都有，因为源库要在分类 URL 里取「年份/地区」映射）；
 *  - L1 为了「Rhino 里函数声明即全局」而把 jsLib 的每个函数**挂到真 `globalThis`**：
 *    `globalThis["Map"] = Map` ⇒ **宿主进程的内置 `Map` 被源库函数覆盖**；
 *  - 求值期间宿主自己的代码被回调（`source.getLoginInfoMap()` 的桩里 `new Map([...])`）⇒
 *    调到的却是源库那个 `Map` ⇒ 它内部 `this` 是新建实例、没有 `source`
 *    ⇒ `undefined.getLoginInfoMap` **TypeError**。
 *    取证栈（`tmp/repro-595.ts` 最小复现）：
 *    `at new Map (js.ts …) ← at Object.getLoginInfoMap (宿主桩) ← at Map (jsLib)`。
 *  - `finally` 的还原**救不了**：污染发生在**求值过程中**，宿主的回调正是那时跑的；
 *    而且 worker 侧同款逻辑也会污染 worker 自己的 `globalThis`。
 *
 * 为什么「不挂内置名」不改变语义：jsLib 的函数本来就在**求值作用域**里可见 ——
 *   · scopeFactory 分支：`with(__yueduScope)` 里有（`collect` 按名字收集）；
 *   · 逐次编译分支：`lib` 直接拼在 `new Function` 体顶部 ⇒ 函数声明落在 fn 作用域，eval 可见。
 * 唯一失去的是 `this.Map(...)` 这种**把源库函数当全局方法调**的写法（语料里 `this.` 后接的
 * 全是 `getHeaderMap/get/put/encode/M` 这些自有名，无一命中内置名），故收益远大于代价。
 */
/** worker 侧接收内置名清单的键（与 sandbox/worker-pool.ts 的读取处同一字面量） */
const BUILTIN_NAMES_KEY = '__yueduNativeNames';

const BUILTIN_GLOBAL_NAMES = new Set([
  'Array', 'Object', 'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'Proxy', 'Reflect',
  'JSON', 'Math', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'console', 'globalThis',
]);

/**
 * **原生全局快照**（模块加载时一次；此后永不被源库覆盖）。
 * 用途见 {@link hoistStmts}：内置名要做「`new Map()` 落原生、`Map(x)` 落源库」的双语义 shim。
 */
const NATIVE_GLOBALS: Record<string, unknown> = (() => {
  const out: Record<string, unknown> = {};
  for (const n of BUILTIN_GLOBAL_NAMES) {
    const v = (globalThis as Record<string, unknown>)[n];
    if (typeof v === 'function') out[n] = v;
  }
  return out;
})();

/**
 * 原生 `URL` 的快照（模块加载时）。
 *
 * 求值期 `globalThis.URL` 会被下面的 Rhino 构造器 shim 覆盖（`#732`），而 shim 本身
 * `new URL(...)` 若走 `globalThis` 就是**自递归**（`Maximum call stack size exceeded`）——
 * 镜像路径映射等宿主代码在求值期间被回调时也会踩到。
 */
const NativeURL = globalThis.URL;

/**
 * 把声明挂到 `globalThis`（Rhino「函数声明即全局」仿真）。
 *
 * ★ **内置名一律用 `new.target` 双语义 shim**（`#595` 的残留 + `#601`，2026-10-24）：
 * 源库 jsLib 里普遍自己写 `function Map(e){ … }`（qyyuapi 系聚合源、🏷晋江文学都有），
 * 而 L1 为了让 Rhino「函数声明即全局」把 jsLib 每个函数 `globalThis[n]=n` ——
 * **Node 内置 `Map` 被顶掉**。求值**期间**宿主自己的代码被回调（`source.getLoginInfoMap()`
 * 的桩里 `new Map([...])`）就调到了源库版（其 `this` 是新实例、没有 `getHeaderMap`/`source`）
 * ⇒ `Cannot read properties of undefined (reading 'getLoginInfoMap')` /
 * `this.getHeaderMap is not a function`（取证栈：`at new Map (jsLib 定义处) ← 宿主桩`）。
 *
 * 两种写法源库**同时**在用，所以既不能一律覆盖、也不能一律不挂：
 *  · `Map(x)` / `this.Map(x)` ⇒ 源库版（普通调用分支）
 *  · `new Map(x)`          ⇒ **原生**（`new.target` 非空分支）—— 宿主桩与把 Map 当数据结构的代码都靠它
 * ⇒ 既不破坏源库语义，也不会污染宿主。原生引用来自 {@link NATIVE_GLOBALS}（加载时快照）。
 *
 * ⚠️ 已知边界：源库**在自己的函数体里** `new Map(...)` 时，`Map` 走的是它自己的函数声明
 * （词法作用域，不经 `globalThis`）⇒ 仍是源库版。那是源自身矛盾（上游 Rhino 同样如此），不修。
 */
/**
 * @param target 挂到哪个对象上（默认 `globalThis`）。
 *   `#611` step 1：jsLib 的声明改挂 **`__yueduLibScope`**（本作用域），不再碰宿主 `globalThis`
 *   —— 上游 `ScriptBindings.chainTo`：jsLib 在独立 bindings 求值，写只落它自己那一层。
 */
function hoistStmts(names: Iterable<string>, target = 'globalThis'): string {
  const list = [...names];
  if (!list.length) return '';
  const T = target;
  return (
    list
      .map((n) =>
        NATIVE_GLOBALS[n]
          ? `try{if(typeof ${n}!=="undefined")${T}[${JSON.stringify(n)}]=(function(){var __f=${n};` +
            `var __N=(globalThis.__yueduNativeGlobals||{})[${JSON.stringify(n)}];if(!__N)return __f;` +
            `var __w=function(){return new.target?new __N(...arguments):__f.apply(this,arguments);};` +
            `try{__w.prototype=__N.prototype;}catch(e){}return __w;})();}catch(e){}`
          : `try{if(typeof ${n}!=="undefined") ${T}[${JSON.stringify(n)}]=${n};}catch(e){}`,
      )
      .join('') + '\n'
  );
}


/** 扫描脚本里的声明名：函数声明（可提升，前置挂）与 var 声明（语句赋值，后置挂）分开 */
function scanDecls(code: string, fns: Set<string>, vars: Set<string>): void {
  const fnRe = /(?:^|[;{}(),=\n])\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  const varRe = /(?:^|[;{}\n])\s*var\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(code))) fns.add(m[1] as string);
  while ((m = varRe.exec(code))) vars.add(m[1] as string);
}

/**
 * `var f = function(){}` / `var f = () => {}` 这类「顶层辅助函数」改写为
 * `var f = globalThis["f"] = …`：Rhino 里该赋值语句执行后 `f` 就是全局属性，
 * 所以脚本内随后的 `this.f()` 必须能拿到。只改写**初始值确实是函数**的 var，
 * 避免把 `for (var i = 0; …)` 这类循环变量也挂到全局。
 */
const VAR_FN_RE =
  /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?=function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;

/** 供回归测试单点验证（worker 路径依赖同一份改写） */
export const inlineVarFnHoistForTest = inlineVarFnHoist;

function inlineVarFnHoist(code: string): string {
  return code.replace(VAR_FN_RE, (_m, name: string) => `var ${name}=globalThis[${JSON.stringify(name)}]=`);
}

/**
 * Rhino → V8 语法兼容预处理（只做「Rhino 能跑、V8 语法错」的改写）。
 *
 * ① **数组解构形参不加括号**：Rhino 接受 `[a, b] => ...`，V8 抛
 *    `SyntaxError: Malformed arrow function parameter list`。
 *    实测番茄系聚合源大量写 `.map([title, id] => {...})`，不改写则整个 exploreUrl
 *    脚本语法错 → 分类列表为空（引擎 catch 后静默返回 []，表现就是「取不到分类」）。
 *
 * 扫描时跳过字符串 / 模板串 / 正则 / 注释，避免误伤数组字面量与文本。
 * 只在「`[` 处于表达式起始位」且「配对 `]` 后紧跟 `=>`」时补括号 —— 已带括号的
 * `([a, b]) => ...` 不匹配（`]` 与 `=>` 之间有 `)`），数组字面量 `.map(...)` 也不匹配。
 */
/**
 * `#398b` **Rhino 无 let-TDZ** 的窄兼容：`let NAME = NAME(...)` / `const NAME = NAME(...)`
 * 且 NAME 是 jsLib 提升的**全局函数**时，RHS 换成 `globalThis["NAME"](...)`。
 *
 * ## 为什么（上游逐行核实）
 * Legado 的 Rhino fork（htmlunit corejs）**全库没有实现 let-TDZ**
 * （`grep -r "before initialization" modules/rhino` = 0 条）⇒ `let start=start()`
 * 的初始化器里 `start` 解析到**外层全局函数**（jsLib 的「书源更新」入口），
 * 结果赋给局部 `start` —— 源作者就是按这个语义写的（˃̶͈ ꇴ ˂̶͈ ruleArticles，
 * 语料面：全库 482 书源 + 已导入源**仅此 1 处**，故只做窄改写不碰其它）。
 * V8 的 `let` 有 TDZ ⇒ 同一写法直接 `Cannot access 'start' before initialization`。
 *
 * ## 语义保持
 * 改写后 = 「调用**全局**函数、结果赋给**局部**变量」—— 与 Rhino 行为逐字等价；
 * 非 jsLib 全局名的自引用**一律不动**（那是真正的 TDZ bug，不该替源圆）。
 */
const RHINO_LET_SELF_RE = /\b(let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\2\s*\(/g;

/**
 * `#611` step3：jsLib 自身 let 自引用的查找表达式。
 *
 * lib 跑在**工厂函数体**里（`var __yueduLibScope={};…${lib}…return __yueduLibScope;`），
 * 那里没有 `__yueduScope`（求值层参数），只有 `__yueduLibScope`（工厂自己的作用域对象）——
  * 所以 lib 与 code 用**不同的**首选查找，同一条回落 globalThis（legacy）。
 */
const LIB_SELFREF_LOOKUP =
  '(typeof __yueduLibScope!=="undefined"&&__yueduLibScope?__yueduLibScope:globalThis)';

export function fixRhinoLetSelfRef(
  codeText: string,
  globalFns: Set<string>,
  /**
   * `#611` step3：自引用查找表达式（四种路径同判据）。
   *  · 规则代码 ⇒ `__yueduScope`（L1-chain / worker-chain 的求值层参数，原型链落到 libScope）
   *  · jsLib 自身 ⇒ `__yueduLibScope`（lib 工厂体内的作用域对象；lib 跑在工厂里，没有 __yueduScope）
   * 两种都回落 globalThis（legacy 路径：声明就在 globalThis 上）。
   */
  lookupExpr = '(typeof __yueduScope!=="undefined"&&__yueduScope?__yueduScope:globalThis)',
): string {
  if (!globalFns.size || !/let|const/.test(codeText)) return codeText;
  RHINO_LET_SELF_RE.lastIndex = 0;
  /**
   * `#611` step3 补丁（2026-10-25，实测抓到的**已翻默认回归**）：
   * 旧形态 `globalThis["NAME"](...)` 在 **chain 模式**下必炸 —— jsLib 声明按
   * `ScriptBindings.chainTo` 已迁到独立作用域（`__yueduLibScope`），**不在 globalThis 上**
   * ⇒ `globalThis.start is not a function`（探针 `tmp/probe-let-selfref.mts` 两种模式对拍抓获）。
   * 改成四种路径同判据的查找：`__yueduScope`（L1-chain / worker-chain 的求值层参数）
   * 存在就走它（原型链落到 libScope），否则回落 globalThis（L1-legacy / worker-legacy）。
   * 不能写 `this["NAME"]`：自引用可能出现在**嵌套函数**里，那里 `this` 不是求值层。
   */
  const lookup = lookupExpr;
  return codeText.replace(RHINO_LET_SELF_RE, (whole: string, decl: string, name: string) =>
    globalFns.has(name) ? `${decl} ${name}=${lookup}[${JSON.stringify(name)}](` : whole,
  );
}

/**
 * ⚠️ **挂账**：顶层 `return` 的 Rhino 兼容（全量基线 2026-10-24 第三类，**3 个源**挂在
 * `Illegal return statement`）。
 *
 * 上游 Rhino 把 `@js:`/`<js>` 规则**当函数体**编译 ⇒ 顶层 `return` 合法；
 * 本仓那条抛错发生在**间接 eval**（globalThis 上求值）路径 —— 而 `new Function(src)`
 * 对 `return "ok";` **是能编译通过的**（V8 把 Function 构造器的 body 当函数体），
 * 所以「编译期预检再包 IIFE」这条路**判不出来**（已实测，别再试）。
 * ⇒ 要修得先定位那条间接 eval 的调用点，再决定包裹时机；**本轮不做**（无证据不动手）。
 */
export function normalizeRhinoSyntax(code: string): string {
  if (!code.includes('=>')) return code;
  const out: string[] = [];
  let i = 0;
  let prev = ''; // 上一个「有意义的」非空白字符（判断 `/` 是正则还是除号、`[` 是否在表达式起始位）
  const n = code.length;
  const EXPR_START = new Set(['', '(', ',', '=', ':', '[', '{', ';', '&', '|', '!', '?', '+', '-', '*', '%', '<', '>', '~']);

  while (i < n) {
    const c = code[i] as string;
    const c2 = code.slice(i, i + 2);

    // 注释 / 字符串 / 模板串 / 正则：原样拷贝，内部一律不改写
    if (c2 === '//' || c2 === '/*') {
      const end = c2 === '//' ? (code.indexOf('\n', i) === -1 ? n : code.indexOf('\n', i)) : (code.indexOf('*/', i) === -1 ? n : code.indexOf('*/', i) + 2);
      out.push(code.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j++; break; }
        j++;
      }
      out.push(code.slice(i, j));
      prev = c;
      i = j;
      continue;
    }
    if (c === '/') {
      // 正则字面量判定：前一个有意义字符允许正则起始（`= /re/` 而非 `a / b`）
      const isRegex = EXPR_START.has(prev);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === '[') inClass = true;
          else if (code[j] === ']') inClass = false;
          else if (code[j] === '/' && !inClass) { j++; break; }
          else if (code[j] === '\n') break;
          j++;
        }
        out.push(code.slice(i, j));
        prev = '/';
        i = j;
        continue;
      }
    }

    if (c === '[' && EXPR_START.has(prev)) {
      // 找配对 `]`（考虑嵌套与字符串），看其后是否紧跟 `=>` → 补括号
      let depth = 0;
      let j = i;
      let matched = -1;
      while (j < n) {
        const d = code[j] as string;
        if (d === '"' || d === "'" || d === '`') {
          let k = j + 1;
          while (k < n) {
            if (code[k] === '\\') { k += 2; continue; }
            if (code[k] === d) { k++; break; }
            k++;
          }
          j = k;
          continue;
        }
        if (d === '[') depth++;
        else if (d === ']') {
          depth--;
          if (depth === 0) { matched = j; break; }
        }
        j++;
      }
      if (matched > 0) {
        const after = code.slice(matched + 1).match(/^\s*=>/);
        if (after) {
          out.push('(', code.slice(i, matched + 1), ')');
          i = matched + 1;
          prev = ')';
          continue;
        }
      }
    }

    out.push(c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/**
 * 缺省 source 桩：jsLib 等未显式绑定 source 的场景。
 * 必须是实体方法对象（不能用 Proxy）—— this 合并依赖对象展开。
 *
 * ⚠️ `#553` 之后这里**不是**「第二份源桩」：真桩只有一份（`core/source-stub.ts` 的
 * `makeSourceStub`，引擎与试跑探针共用）。本对象只负责「**根本没有源**」时的兜底形态
 * （无 variables 可读、无登录态），随后会被调用方传入的 `bindings.source` 整体覆盖。
 * 想给桩加方法 ⇒ 改 `source-stub.ts`，别往这里加 —— 加在这里等于「只在无源时才有的能力」。
 */
const defaultSourceStub: Record<string, unknown> = {
  // Legado `BaseSource.getKey()` 的 JavaBean 属性视图（源里 `source.key` 与 `source.getKey()` 并存）
  key: '',
  getKey: () => '',
  get: (_k: unknown) => '',
  put: (_k: unknown, v: unknown) => v,
  set: (_k: unknown, _v: unknown) => undefined,
  getVariable: () => '',
  setVariable: (_v: unknown) => undefined,
  // Legado 返回 Java Map（源脚本 info.get(name) 与 info["name"] 都能用）。
  // `#314`：从 `new Map()` 改成「纯对象 + 非枚举 Map 方法」—— 方括号是上游官方语义
  // （`RhinoWrapFactory.kt:80-81` 桥接 java.util.Map），JS Map 会让 `info["键"]` 恒 undefined。
  getLoginInfoMap: () => attachJsonMapMethods({}),
  getHeaderMap: () => ({}),
  getComment: () => '',
  putLoginHeader: (_h: unknown) => undefined,
};

export function createJsEvaluator(opts: JsEvalOptions): JsEvaluator {
  const ctxHolder: { value: unknown } = { value: undefined };
  const cookie = makeCookieStub(opts.cookies);
  const cache = makeCacheStub(opts.variables);
  /**
   * 同步 HTTP 的默认请求头 = 源 `header` 规则 + 源 Cookie（+ 同站请求才有的登录头）。
   * （登录头由宿主合进 getSourceHeaders，宿主按 `isLoginHeaderSite` 判定 —— 见 engine 同名注释）
   * 惰性：只有脚本真的发请求时才求值；`url` 用于登录头的同域判定。
   */
  const baseHeaders = (url?: string): Record<string, string> => {
    const out: Record<string, string> = { ...(opts.getSourceHeaders?.(url) ?? {}) };
    const ck = (cookie['header'] as (() => string) | undefined)?.() ?? '';
    /**
     * 源 CookieStore 的会话 Cookie 必须发得出去。
     * `D11`：源 `header` 规则常写 `'Cookie': source.getLoginHeader()`，而本次会话里它往往是**空串**
     * （过闸 / 登录窗口刚拿到的 Cookie 落在 CookieStore，不在登录头里）——
     * 空值头会**遮蔽**真 Cookie ⇒ 「过了闸也发不出去」。空串对 Cookie 只能是「未填写」，
     * 判据唯一实现在 `net/gate-pass.ts`（与 worker 宿主同一份）。
     */
    applySessionCookie(out, ck);
    return out;
  };
  /**
   * 同步 HTTP 的响应回调：把 `Set-Cookie` 写回源 CookieStore。
   *
   * 为什么关键：不少源的**登录动作就在脚本里**（禁漫天堂 `java.ajax(url + '/login', {...})`、
   * 独阅读网 `this.Login()`），会话 Cookie 只在响应头里。此前同步路径的响应头**读出来就扔**，
   * 于是「脚本登录成功、后续请求仍匿名」。Legado 走 okhttp + CookieJar，天然回写 —— 这里补齐。
   */
  const sync = {
    ...(opts.syncFetch ? { transport: opts.syncFetch } : {}),
    ...(opts.syncTimeoutMs ? { timeoutMs: opts.syncTimeoutMs } : {}),
    onResponse: (res: SyncHttpResponse, url: string): void => {
      if (!res.setCookie.length) return;
      const ck = cookie as { setCookie?: (u: string, c: string) => void; remove?: (k: string) => void };
      for (const one of res.setCookie) {
        const pair = (one.split(';')[0] ?? '').trim();
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        // Max-Age=0 / 已过期 → 删除（对齐 engine.harvestCookies 语义）
        if (/max-age\s*=\s*0\b/i.test(one)) {
          try { ck.remove?.(name); } catch { /* ignore */ }
          continue;
        }
        try { ck.setCookie?.(url, pair); } catch { /* 不得影响脚本 */ }
      }
    },
  };
  const java = makeJavaStub(opts.variables, {
    evalRule: opts.evalRule,
    ...(opts.onBrowserOpen ? { onBrowserOpen: opts.onBrowserOpen } : {}),
    ...(opts.onUpLoginData ? { onUpLoginData: opts.onUpLoginData } : {}),
    ...(opts.onToast ? { onToast: opts.onToast } : {}),
    ...(opts.onRefreshBook ? { onRefreshBook: opts.onRefreshBook } : {}),
    ...(opts.canOpenSourceUi ? { canOpenSourceUi: opts.canOpenSourceUi } : {}),
    ...(opts.getSource ? { getSource: opts.getSource } : {}),
    ...(opts.getTag ? { getTag: opts.getTag } : {}),
    ...(opts.verificationCode ? { verificationCode: opts.verificationCode } : {}),
    baseHeaders,
    sync,
    contextValue: () => ctxHolder.value,
    javaExtra: opts.javaExtra,
    getCookie: (_tag: string, key?: string) =>
      key === undefined
        ? (cookie['header'] as () => string)()
        : (cookie['getKey'] as (u: string, k: string) => string)('', key),
  });
  attachExtendedJavaApi(java, cookie, baseHeaders, sync);
  const thisScope = makeThisScope(opts.variables, {
    persist: (k, v) => {
      const p = opts.javaExtra?.['putVariable'];
      if (typeof p === 'function') (p as (k: string, v: string) => void)(k, v);
    },
    headers: () => opts.getSourceHeaders?.() ?? {},
  });
  /**
   * `#639` Rhino↔V8 语法宽松度差异兜底（实现与依据见 `js-compat.ts`）。
   *
   * jsLib 里「形参与同名 `let`」在上游 htmlunit-core-js 是**合法遮蔽**，在 V8 是 SyntaxError；
   * 而 jsLib 是每次求值的前导代码 ⇒ 编不出来 = **每条规则都抛错**（🏷书旗小说 搜索 0 条的真因：
   * `[url-interp-ERR] Identifier 'sourceUrl' has already been declared` ⇒ `q={{key}}` 原样发出）。
   * 只放宽这一类（语料 111 个内联 jsLib 里仅 2 个），其余语法错原样上报。
   */
  const libText = opts.lib ? relaxLetParamShadow(opts.lib, '源 jsLib') : '';
  const lib = libText ? `${libText}\n` : '';
  // lib（jsLib）里的函数声明提升到 fn 体顶部 → 前置挂到 globalThis 供 `this.foo()` 使用
  const libFns = new Set<string>();
  const libVarsTmp = new Set<string>();
  if (libText) scanDecls(libText, libFns, libVarsTmp);
  /**
   * `#509` **jsLib 只编译一次**（L1 求值第二刀；用户实测：七猫 712 章目录 → stall 34s）。
   *
   * ## 问题（bench + CPU profile 双证，见 `.tmp-510/`）
   * 旧实现每次 eval 都 `new Function(\`${lib}${hoist}${preassign}eval(prepared)\`)`，而 lib 是
   * **55KB 级**文本。V8 对 `new Function(src)` 有编译缓存，但键是**整个 src** —— 真实目录解析里
   * 每章的 code 都不同（`{{$.id}}`/`{{$.content_md5}}`）⇒ 缓存 100% miss ⇒ **每次重编译 55KB**。
   * 实测：固定 code 1.09ms / 变化 code 5.88ms（差值 4.79ms 全在 lib 编译）；
   * profile 也印证：85% self time 在 `l1Eval` 本体（编译发生在 native，不计入子函数）。
   *
   * ## 做法
   * lib **编译一次**成 factory（返回「lib 顶层声明」的作用域对象），每次 eval 只编译 code：
   *   `scope = factory.call(g)` + `new Function('__s','__c','with(__s){ eval(__c) }')`。
   * **注意 `factory.call(g)` 是每次执行的** —— lib 顶层照常跑（含 `var token = java.xxx()`
   * 这类依赖 bindings 的赋值），所以语义与旧路径一致，只省掉重复编译。
   * 标识符解析顺序也与旧路径一致：先 lib 声明（with 作用域）→ 再全局（bindings 已注入）。
   *
   * ## 为什么不缓存 scope（更快 0.11ms vs 0.21ms）
   * 源库实测有 **16 个源**的 jsLib 顶层引用了 `java`/`source`/`cookie`/`cache`（见 `#509` 记录），
   * 只建一次会让它们读到 stale 值。每次重建只贵 0.1ms，不值得为此冒险。
   *
   * ## 回退
   * `YUEDU_JS_LIBSCOPE=0` 走旧路径（对齐 `#491` 纪律：核心 eval 路径必须可回退）。
   * lib 构建失败（源本身语法错）也自动回退，让旧路径按原样报错（错误信息带源码行号，更贴近源）。
   */
  /**
   * `#611` **求值作用域「chainTo」化**（step 1 落地 + step 2 翻默认；`YUEDU_JS_CHAINSCOPE=0` 可关）。
   *
   * ★ 上游依据：`modules/rhino/.../ScriptBindings.kt:32-46` 的 `chainTo` ——
   *   jsLib 求值进**独立 bindings**，每次规则求值 `bindings.chainTo(sharedScope)`
   *   ⇒ **本层独立（写只落本层）+ 父层可读（jsLib 走原型链）**。
   *
   * 本仓旧行为：jsLib 的顶层声明 **直接写到真 `globalThis`**（`hoistStmts` 默认目标）
   * ⇒ 源库的 `function Map(...)` 把宿主内置 `Map` 顶掉 ⇒ `#595`/`#601` 两条事故链（65 个源）。
   * 现在的止血（`new.target` 双语义 shim）只是把「顶掉」改成「挂个影子」，**污染仍然存在**。
   *
   * step 1 只做最小可回退的一步：**jsLib 的声明改挂它自己的作用域对象，不再碰 globalThis**；
   * 规则求值层再 `Object.create(libScope)` 作为本层（写落本层、读走原型链），
   * 与上游 `chainTo` 的「父可读 / 写落本层」逐条对齐。
   *
   * ## step 2（2026-10-25）：真源码验收后**翻为默认开**
   *  · 护栏一：core 全量「开 / 关」两种模式**各跑一遍全绿**（977）；
   *  · 护栏二：**真源码验收** —— 482 源里 **32 个带内联 jsLib 的真实源**逐条对拍两条路径，
   *    结果 **32/32 完全一致**（含源库自带 `function Map` 的晋江，即 `#601` 那条链），
   *    探针 `tmp/probe-611-real-sources.mts`（离线、不发网络，只测本改动的三件事）。
   * 回退：`YUEDU_JS_CHAINSCOPE=0`（`#491` 纪律：核心 eval 路径必须可回退）。
   *
   * ⚠️ 未覆盖：**worker 侧**仍是「lib 与 code 同一 eval 作用域」（宿主把 lib 拼进 code）
   * ⇒ 带 `java.ajax` 的规则走 worker 时仍是旧语义 ⇒ 记 `#611` step3。
   */
  const chainScope = process.env['YUEDU_JS_CHAINSCOPE'] !== '0';
  const libScopeFactory: (() => Record<string, unknown>) | null = (() => {
    if (!opts.lib || !lib) return null;
    if (process.env['YUEDU_JS_LIBSCOPE'] === '0') return null;
    const names = [...new Set([...libFns, ...libVarsTmp])].filter(
      (n) => /^[A-Za-z_$][\w$]*$/.test(n) && !JS_RESERVED.has(n),
    );
    if (!names.length) return null;
    /**
     * 把 lib 的顶层声明收集进 scope（`with(scope)` 用）。
     *
     * ★ **内置名要收 `globalThis[n]`（= 上面刚 hoist 的 shim），不能 bind 原函数**（`#601`）：
     * 这条 collect 执行时，`${n}` 在工厂作用域里解析到的是**源库自己的** `function Map`；
     * 若直接 `Map.bind(globalThis)` 放进 scope，`with` 里 `new Map(...)` 就会 `new` 源库版
     * ⇒ `this` 是新实例、没有 `getHeaderMap`/`source` ⇒ `#595`/`#601` 的现象照旧。
     * 收 shim（`new.target` 已分流）才能让「`new Map` 走原生、`Map(x)` 走源库」同时对。
     */
    const collect = names
      .map((n) => {
        /**
         * `#611` step 1：chain 模式下内置名要收 **本次刚挂进 `__yueduLibScope` 的 shim**
         * （hoist 已先跑），而不是 `globalThis[n]` —— 后者在 chain 模式下是纯原生，
         * 会让 `new Map()` 走原生、`Map(x)` 走源库 的双语义失效（即 `#601` 的回归）。
         */
        const pick = NATIVE_GLOBALS[n]
          ? `${chainScope ? '__yueduLibScope' : 'globalThis'}[${JSON.stringify(n)}]`
          : chainScope
            ? `${n}` // chain 模式：`this` 由下面统一重绑到本次作用域对象（bind 过就不能再改 this）
            : `${n}.bind(globalThis)`;
        return (
          `try{ if (typeof ${n} !== 'undefined') __yueduLibScope[${JSON.stringify(n)}] =` +
          ` typeof ${n} === 'function' ? ${pick} : ${n}; }catch(e){}`
        );
      })
      .join('\n');
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      // chain 模式：作用域对象**先声明**（hoist 要写它），再跑 lib、再 hoist
      // ★ `#611` step3 补丁：libScope 的原型设成 **globalThis**（实测抓到的第二个已翻默认回归：
      //   规则代码自己的 `function foo(){}` / `var f=function(){}` 被 hoistStmts 挂到 globalThis，
      //   而 chain 模式下 `this`=本层对象 ⇒ `this.foo()` 走**属性查找**（own+原型链）拿不到
      //   globalThis 上的声明 ⇒ `this.foo is not a function`（legacy 模式 this=g 反而能用）。
      //   上游 Rhino 顶层 `this` 就是**全局作用域对象**（绑定+内置全在里面）⇒ 原型指 globalThis
      //   正是还原上游语义；读写语义不变（未声明写仍落 globalThis，命中原型与命中全局同目标）。
      return new Function(
        chainScope
          ? `var __yueduLibScope = {};Object.setPrototypeOf(__yueduLibScope, globalThis);\n${lib}${hoistStmts(libFns, '__yueduLibScope')}\n${collect}\nreturn __yueduLibScope;`
          : `${lib}${hoistStmts(libFns)}\nvar __yueduLibScope = {};\n${collect}\nreturn __yueduLibScope;`,
      ) as unknown as () => Record<string, unknown>;
    } catch (e) {
      console.warn('[js] jsLib 预编译失败，回退逐次编译路径：', e instanceof Error ? e.message : e);
      return null;
    }
  })();
  const l1Eval = (code: string, bindings: Record<string, unknown>, retried = false): unknown => {
    // `#759`：图片解密若下发了字节描述符，这里就地还原成「裸字节 + InputStream 方法」。
    // 命中时返回新对象（不污染调用方），未命中原样返回 ⇒ 其余路径零变化。
    bindings = materializeImageBindings(bindings);
    ctxHolder.value = bindings?.['$'];
    /**
     * `#474`：本次求值的 `org.jsoup` 桥实例（**与下面 `org` / `Packages.org` 共用同一份**）。
     * 源脚本两种写法都有：裸全局 `org.jsoup.Jsoup.parse(...)` 与 `Packages.org.jsoup.Jsoup.parse(...)`；
     * `makeJavaPackages()` 的 `Packages` 只挂了 java/javax/android/io/cn ⇒ 后者落 nest() 空桩
     * （爱丽丝书屋 `doc.selectFirst is not a function` ⇒ 目录 0 章）。worker 同款见
     * `sandbox/worker-pool.ts` 的 `orgNs`。
     */
    const orgNs = nsProxy(makeOrgStub(new JsoupDom()), 'org');
    const full: Record<string, unknown> = {
      ...thisScope, // this.M / this.get / this.put / this.setHeaders / this.encode
      /** 原生全局快照（hoistStmts 的 shim 靠它回落，见该函数注释） */
      __yueduNativeGlobals: NATIVE_GLOBALS,
      java,
      cookie,
      cache,
      source: defaultSourceStub,
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
      // Rhino Java 桥桩：源脚本可能引用 Packages.xxx
      Packages: withOrgPackage(javaPackages, orgNs), // Rhino Java 类桥（#77：String.getBytes/javax.crypto/Arrays/Thread…）
      /**
       * `#691` **CryptoJS**（上游 App 内置 `app/src/main/assets/scripts/cryptojs.min.js`，
       * `SharedJsScope` 把它编译进每次求值的 scope）。语料里一批源的 jsLib 直接写
       * `CryptoJS.enc.Utf8.parse(key)` / `CryptoJS.AES.decrypt(...)`；
       * 我们此前没有 ⇒ `ReferenceError: CryptoJS is not defined` ⇒ 整条规则第一步就断
       * （实测 野果短剧：`RULE_PARSE@parse · CryptoJS is not defined`）。
       *
       * ⚠️ 必须挂在**求值 scope**（这里），不是 `java` 对象上 —— 源写的是裸 `CryptoJS`。
       * ⚠️ 只挂 L1：`WordArray` 是带方法的对象（不可结构化克隆）⇒ 传不进 worker，
       * 故 `needsJavaBridgeL1()` 把含 `CryptoJS` 的脚本路由到本线程（同 Bitmap/Canvas）。
       */
      CryptoJS: createCryptoJs(),
      JavaImporter: javaImporterCtor, // with(importer){ 裸类名 } 语义（七猫官方/茄子/星空）
      // URL(...) 函数式调用 shim（Rhino 允许无 new 调用构造器；返回真 URL 实例，instanceof 仍成立）
      URL: Object.assign(function (u: unknown) { return new NativeURL(String(u)); }, { prototype: NativeURL.prototype }),
      // Rhino 默认全局可见的 Java 顶层包名（源脚本直接写 org.jsoup.xxx / com.xxx 等）
      // org 单独给 jsoup 桥（org.jsoup.Jsoup.parse 是 Legado 源 exploreUrl 高频用法）。
      // `#333`：每次求值新建一份 JsoupDom（活节点表随本次求值回收，不跨请求驻留）。
      org: orgNs,
      com: javaPkgStub,
      net: javaPkgStub,
      javax: javaPkgStub,
      edu: javaPkgStub,
      // `this.getHeaderMap()` 由 makeThisScope 提供（与 worker 同一份定义，防两处漂移）
      ...bindings,
    };
    /**
     * ★ **`source` 兜底**（全量基线 2026-10-24 Top1，**65 个源**挂在
     *   `Cannot read properties of undefined (reading 'getLoginInfoMap')`）：
     *
     * 上面 `...bindings` 是**后展开、后胜** —— 调用方只要显式传了 `source: undefined`
     * （如 `engine-rss` 的 `source: env.sourceData` 而 sourceData 缺失），
     * 就会把 `source: defaultSourceStub` **覆盖成 undefined**，脚本里
     * `source.getLoginInfoMap()` 立刻 TypeError，整条规则链崩。
     *
     * ⇒ 展开后统一兜底：**可以没有登录态，但不能没有 `source` 这个对象**
     * （上游 Rhino 里 `source` 是永远存在的 binding，缺失即我方缺陷）。
     * 调用方给了真桩 ⇒ 不动；没给 ⇒ 用无登录态兜底桩。
     */
    if (full['source'] == null) full['source'] = defaultSourceStub;
    // ★ Rhino 全局作用域仿真：把绑定直接挂到 globalThis 上再 eval——
    //   1) jsLib 的顶层函数声明成为全局函数，调用时 this = globalThis（含全部绑定），
    //      `function Map(e){ this.getHeaderMap() }` / `const {java,source} = this` 均成立；
    //   2) 未声明赋值（sign_key='xxx'）落 globalThis —— 与 Rhino 非 strict 一致；
    //   3) eval 返回「完成值」= 最后一个表达式的值（{{key;java.put("k",key)}} → key）。
    //   eval 前快照 globalThis，eval 后恢复——绑定与隐式全局都不跨调用泄漏。
    const g = globalThis as Record<string | symbol, unknown>;
    const before = new Map<PropertyKey, unknown>(Reflect.ownKeys(g).map((k) => [k, g[k]]));
    /** 求值源码（catch 里靠它给出「出错行 + 片段」，所以提到 try 外） */
    let prepared = '';
    try {
      Object.assign(g, full);
      /**
       * ★ `document` 的**惰性 getter**（挂账 `#92`）。
       *
       * 绑定里放的是工厂（`DOCUMENT_THUNK`），这里才定义成 getter —— 因为 `{...bindings}`
       * 的对象展开会**立刻求值 getter**，那就退化成「每段 JS 都先解析一遍内容」（缺陷类 R）。
       * 定义在 `globalThis` 上而不是 `full` 里：`Object.assign` 已把其它绑定摊平，
       * 这里补一个访问器即可；函数末尾的 `finally` 会把它一并还原/删除。
       * 取不到工厂（非 AnalyzeRule 构造的绑定集）就跳过 —— 此时 `document` 保持未定义。
       */
      const docThunk = (bindings as Record<string | symbol, unknown> | undefined)?.[DOCUMENT_THUNK];
      if (typeof docThunk === 'function') {
        Object.defineProperty(g, 'document', {
          get: docThunk as () => unknown,
          configurable: true,
          enumerable: false,
        });
        /**
         * ★ `window`（挂账 `#92` 的第二半）。
         *
         * 站点探针实测枚举（30 次抓取、21 种表达式，见 `tmp/probe-92-probes.mjs`）：除
         * `document.getElementsByTagName('html')` / `document.children` 外，还有
         * `eval("1 * (!window.Array) + 1")` —— **没有 `window` 同样整条规则崩**。
         *
         * 语义取「浏览器事实」：浏览器里 `window` **就是全局对象**（`window === globalThis`，
         * `window.Array` / `window.document` / `window.java` 都能取到）。所以这里直接返回 `g`
         * 本身，而不是另造一个只有几个字段的假对象 —— 后者会在别的探针上继续崩。
         * 赋值语义也一致：`window.x = 1` 落在 globalThis（求值结束由 `finally` 还原）。
         * ⚠️ 只在确有 `document` 工厂时定义（非 AnalyzeRule 的绑定集不注入）。
         */
        Object.defineProperty(g, 'window', {
          get: () => g,
          configurable: true,
          enumerable: false,
        });
      }
      // 顶层声明提升：lib 的声明提升到 fn 体顶部、code 的声明提升到 eval 顶部 → 都前置注入；
      // code 里的 `var x = function(){}` 属语句赋值 → eval 之后补挂。
      const codeFns = new Set<string>();
      const codeVars = new Set<string>();
      scanDecls(code, codeFns, codeVars);
      // ⚠️ code 的函数声明在 **eval 自己的作用域**里（不在 fn 体里），所以前置挂必须写进
      // eval 的源码字符串；写成 fn 体里的独立语句会因为作用域不同而 typeof 为 undefined。
      // 先做 Rhino→V8 语法兼容（`[a,b]=>` → `([a,b])=>`），再做 `#398b` let 自引用窄改写
      // （判据 = jsLib 提升的全局函数名 libFns；两条 eval 路径共用同一份实现，防漂移），
      // 最后挂提升语句
      const body = inlineVarFnHoist(fixRhinoLetSelfRef(normalizeRhinoSyntax(code), libFns));
      /**
       * ★ **顶层 `return` 兼容**（`#598`，全量基线 2026-10-24：可乐小说 / 得奇小说）。
       *
       * 上游 Rhino 把 `<js>` / `@js:` 规则**当函数体**编译 ⇒ 顶层 `return` 合法（源里很常见，
       * 如 `{ let token = …; return {…} }`）；而我们的 code 是放进 `eval(...)` 执行的，
       * V8 的 **eval 是 Script 上下文 ⇒ 顶层 `return` 直接 SyntaxError**
       * （`Illegal return statement｜运行期 3:16 | return {`）。
       *
       * 判据不能用 `new Function(src)` 预检 —— 函数体上下文**允许**顶层 return（实测过），
       * 只有 `vm.Script`/eval 才会报。所以改成**失败后重试**：
       *   首次照常执行；只有真的抛 `Illegal return statement` 才把整段包一层 IIFE 重跑。
       * ⇒ 能跑的脚本**零额外开销**（热路径不多编译一次），也不会误伤函数体内部的 return。
       */
      prepared = retried
        ? `${hoistStmts(codeFns)}${hoistStmts(codeVars)}(function(){\n${body}\n})()`
        : `${hoistStmts(codeFns)}${body}`;
      /**
       * ★ **同名 `var` 预置**（否则注入的绑定会被静默遮蔽成 undefined）。
       *
       * 脚本里写 `var result = ...`（哪怕在**没走到的分支**里）时，V8 会把整段 eval 的 `result`
       * 提升为 `fn` 作用域的**本地变量**；本地变量遮蔽 `globalThis` 上的注入绑定，
       * 于是脚本开头读 `result.match(...)` 拿到 undefined。
       * Rhino 的 `var` 落在作用域对象上、不会把已有属性清成 undefined —— 这就是同一份源
       * 「Legado 能跑、我们报 Cannot read properties of undefined」的原因。
       * 实测：⚡📂书荒小说 正文规则 `var bes = result.match(/PHA\+…/g)` → 撞上 `else` 分支里的
       * `var result = []` → `Cannot read properties of undefined (reading 'match')`。
       *
       * 做法：对「同时是绑定名」的 var 名，在 eval 之前先按绑定值声明初始化
       * （`var result=globalThis["result"];`）——读到的是注入值；脚本内赋值仍落在本地，
       * 最后由 `hoistStmts(codeVars)` 回写 globalThis，与 Rhino 语义一致。
       */
      const shadowed = [...new Set([...codeVars, ...libVarsTmp])].filter((n) => n in full && !JS_RESERVED.has(n));
      const preassign = shadowed.length
        ? `var ${shadowed.map((n) => `${n}=globalThis[${JSON.stringify(n)}]`).join(',')};`
        : '';
      // `#509`：lib 已预编译 ⇒ 本次只编译 code（不再把 55KB lib 放进每次的 new Function 源码）
      if (libScopeFactory) {
        const libScope = libScopeFactory.call(g);
        /**
         * ★ **`source` 兜底（第二条路径）**：`scope` 是 **jsLib 预编译时缓存**的作用域对象，
         *   它持有的是**那一次**的 bindings —— 若那次 `source` 就是 undefined，
         *   `with(__yueduScope)` 会拿它**遮蔽** globalThis 上本次注入的真桩
         *   （`with` 的属性查找先走作用域对象）⇒ 脚本里 `source.getLoginInfoMap()` 照样
         *   `Cannot read properties of undefined`（全量基线 2026-10-24：**65 个源**挂在这）。
         *   ⇒ 这里也要兜：缓存里没有 ⇒ 用本次的（或默认桩）。
         */
        if (libScope['source'] == null) libScope['source'] = full['source'] ?? defaultSourceStub;
        /**
         * `#611` step 1：**本层 = `Object.create(libScope)`**（`chainTo` 的「父可读 / 写落本层」）。
         * 绑定（`java`/`source`/`result`…）必须**同时**在本层有一份 —— 因为 `this` 从 `g` 换成了
         * 本层对象，而 `this.getHeaderMap()` 走的是**属性查找**（只查 own + 原型链，
         * 不查作用域链），少了这一步 `this.*` 会全部 undefined。
         */
        const scope: Record<string, unknown> = chainScope
          ? Object.assign(Object.create(libScope) as Record<string, unknown>, full)
          : libScope;
        /**
         * 源库自己定义 `$` 时，**库函数必须赢过注入的 `$`（= 当前内容别名）**。
         *
         * 实证（2026-11-26，拷贝漫画 / 热辣漫画 登录页「切换站源」①②③④ 按钮）：
         *   jsLib 里 `function $(e){ const {java,source,cookie,cache}=this; … }` 是按钮依赖的函数，
         *   而 `AnalyzeRule.bindings()` 把 `$` 注入成当前 result（登录场景是 `{账号,密码}` 对象）
         *   ⇒ 按钮脚本 `$(0)` 抛 `$ is not a function`。
         * 上游 Rhino 的登录求值**不注入 `$`**（`$` 只是 AnalyzeRule 规则求值的别名）。
         * 只删本层自有属性 ⇒ 查找回落到 libScope（该层函数已被下面统一 bind 到 scope）。
         */
        if (chainScope && typeof (libScope as Record<string, unknown>)['$'] === 'function') {
          delete (scope as Record<string, unknown>)['$'];
        }
        /**
         * ★★ **jsLib 函数里的 `this` 必须指向「本次求值的作用域对象」**（`#611` step 1 的关键一步）。
         *
         * 上游 Rhino：顶层函数 `f()` 的 `this` = 该 bindings 的**全局对象**（它 `chainTo` 共享作用域），
         * 所以 `readFl()` 里的 `this.Map(...)` 与 `this.getHeaderMap()` 都能取到。
         * 本仓 V8：`f()` 这种**裸调用**的 `this` 恒为 `globalThis`（非严格模式）⇒ 若不重绑，
         * `this.Map` 会取到**宿主原生 Map**（chain 模式下我们不再往 globalThis 写 shim）
         * ⇒ `Constructor Map requires 'new'`（实测：`source-lib-map-shim-601.test.ts` 当场抓获）。
         *
         * ⇒ 求值前把 jsLib 的每个函数**重绑**到本次作用域对象（绑定到 `libScope` 上的值，
         * 经原型链对 `this.xxx` 可见），`this` 语义即与上游一致。
         */
        if (chainScope) {
          for (const k of Object.keys(libScope)) {
            const v = libScope[k];
            if (typeof v === 'function') {
              try {
                libScope[k] = (v as (...a: unknown[]) => unknown).bind(scope);
              } catch {
                /* 个别不可绑（已 bind 过也能绑），失败保持原值 */
              }
            }
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fnWithLib = new Function(
          '__yueduScope',
          '__yueduCode',
          `${preassign}with(__yueduScope){\nvar __yueduRet=eval(__yueduCode);\n}` +
            `${hoistStmts(codeVars)}return __yueduRet;`,
        );
        // `this` = 本次求值的作用域对象（上游 Rhino：顶层 `this` 就是作用域对象）
        return fnWithLib.call(chainScope ? scope : g, scope, prepared);
      }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(
        `${lib}${hoistStmts(libFns)}${preassign}var __yueduRet=eval(${JSON.stringify(prepared)});` +
          `${hoistStmts(codeVars)}return __yueduRet;`,
      );
      return fn.call(g);

    } catch (e) {
      // `#749` D2：`L1_TIMEOUT` 是**控制信号**，不能被语法错解释器改写消息/包一层新 Error
      if (isL1EvalTimeoutError(e)) throw e;
      // 语法错补「出错位置 + 片段」（两条路径同逻辑，见 selector/js-error.ts）——
      // 原来只有一句 "Invalid or unexpected token"，看不出是哪条规则/哪一行
      const rawMsg = String(e instanceof Error ? e.message : e);
      /** `#598`：顶层 `return` 只在 eval（Script 上下文）里非法 ⇒ 包 IIFE 重试一次（见 prepared 处注释） */
      if (!retried && /Illegal return statement/.test(rawMsg)) return l1Eval(code, bindings, true);
      const msg = explainJsError(rawMsg, prepared, e instanceof Error ? e.stack : undefined);
      // 调试钩子（YUEDU_DEBUG_JS_FAIL=1 时开启）：脚本报错无栈帧，落盘原文便于定位
      if (process.env.YUEDU_DEBUG_JS_FAIL) {
        try {
          const { appendFileSync } = require('node:fs') as typeof import('node:fs');
          const keys = Object.keys(bindings ?? {});
          const types: Record<string, string> = {};
          for (const k of keys) {
            const v = (bindings as Record<string, unknown>)[k];
            types[k] = Array.isArray(v) ? `array(${v.length})` : v == null ? String(v) : typeof v;
          }
          appendFileSync(
            'debug-js-fail.log',
            `\n===== ${new Date().toISOString()} =====\nerror: ${String(e instanceof Error ? e.message : e)}\nbindings: ${JSON.stringify(types)}\ncode://n${String(code).slice(0, 4000)}\n`,
            'utf-8',
          );
        } catch { /* 落盘失败不影响主流程 */ }
      }
      if (msg !== rawMsg) throw new Error(msg, { cause: e });
      throw e;
    } finally {
      for (const k of Reflect.ownKeys(g)) if (!before.has(k)) {
        try { delete g[k as string]; } catch { /* non-configurable（undici Symbol 等） */ }
      }
      for (const [k, v] of before) {
        try {
          if (g[k] !== v) g[k] = v;
        } catch {
          // 只读全局（如 NaN / Infinity）跳过
        }
      }
    }
  };
  // 埋点：L1 是**同步**求值，脚本内 java.ajax 会阻塞事件循环（curl 子进程）。
  // 记录耗时 + 是否发 HTTP + 脚本片段，用于把「服务假死」精确归因到哪一次求值。
  const HTTP_IN_CODE = /java\.(ajax|ajaxAll|post|get|connect|head|getStrResponse)\s*\(/;
  /**
   * `#633` **纯表达式快速求值**（挂在求值器上，供混合求值器在路由前先试一次）。
   *
   * 为什么挂在这里：这段代码要用**同一个 `java` 桩**，否则 `base64Encode` 之类的语义会漂。
   * 见 `fast-expr.ts` 的边界说明与实测（编译 1.15ms vs 命中 0.007ms）。
   * 回退：`YUEDU_JS_FASTPATH=0`。
   */
  const fastExpr = createFastExprRunner();
  const evalFn = (code: string, bindings: Record<string, unknown>): unknown => {
    // `#196`：给 java-bridge 的「未实现的 Java 类」这类留痕带上**源身份**。
    // L1 求值是**同步**的 ⇒ 设/复位不会被并发源抢队（worker 路径是另一实例，另有挂账）。
    const resetLabel = setJavaBridgeSourceLabel(opts.sourceLabel ?? '');
    /**
     * `#749` D2 单段硬超时的进入/退出。
     * 嵌套求值（如 `java.getString` → AnalyzeRule → `jsEvalSync`）**取更早的截止**，
     * 保证内层不能把外层的总预算重新续期（否则一段规则可以被无限制地拆成多段）。
     */
    const limit = l1TimeoutLimitMs();
    const prevDeadline = l1Deadline;
    const prevLimit = l1LimitMs;
    const prevDepth = l1Depth;
    if (limit > 0) {
      const now = Date.now();
      l1Deadline = prevDeadline ? Math.min(prevDeadline, now + limit) : now + limit;
      l1LimitMs = prevDeadline ? Math.min(prevLimit, limit) : limit;
      l1Depth = prevDepth + 1;
      if (prevDepth === 0) {
        l1ReqCount = 0;
        l1LastUrl = '';
      }
    }
    const t0 = Date.now();
    /** 已按 `L1_TIMEOUT` 中止 ⇒ 不再重复报「跑完但超预算」 */
    let abortedByTimeout = false;
    try {
      return l1Eval(code, bindings);
    } catch (e) {
      if (isL1EvalTimeoutError(e)) abortedByTimeout = true;
      throw e;
    } finally {
      const elapsed = Date.now() - t0;
      recordBlock('l1-eval', elapsed, `${HTTP_IN_CODE.test(code) ? 'HTTP ' : ''}${code.replace(/\s+/g, ' ').slice(0, 90)}`);
      /**
       * **纯 CPU 段**：V8 无法从外部中断（见 `L1_MAX_MS_DEFAULT` 头注），所以到点也中止不了。
       * 这里只留痕（一次/进程）—— 让「l1-eval 有长尾但 timeout.n=0」不再是无法解释的数据。
       */
      if (!abortedByTimeout && limit > 0 && prevDepth === 0 && elapsed > limit && !l1OverrunWarned) {
        l1OverrunWarned = true;
        recordBlock('l1-overrun', elapsed, `已跑完（无法中止）${code.replace(/\s+/g, ' ').slice(0, 90)}`);
        console.warn(
          `[l1] 单段求值 ${elapsed}ms 超过 YUEDU_L1_MAX_MS=${limit}ms，但已同步跑完（纯 CPU 段无法中止；需独立子进程，见 D2 ④）`,
        );
      }
      l1Deadline = prevDeadline;
      l1LimitMs = prevLimit;
      l1Depth = prevDepth;
      resetLabel();
    }
  };
  (evalFn as unknown as { __yueduFastExpr?: unknown }).__yueduFastExpr = (code: string) =>
    fastExpr(code, java as unknown as Record<string, unknown>);
  return evalFn;
}

/** Rhino `Packages` 命名空间桩：Packages.java.util.ArrayList 等可 new 使用（列表/映射语义） */
/** Java 类桥（#77）：单一实例，L1 全局与 attachExtendedJavaApi 共用同一份（防两处漂移） */
const javaPackages = makeJavaPackages();
const javaImporterCtor = makeJavaImporterCtor();
wireStrResponseFactory(makeStrResponse);
// `#538` okhttp3 桥（L1 侧）的同步传输：复用 syncHttp（= java.ajax 同一条出口）。
// 与 `#529` jsoup 桥同款防御式取值（syncHttp 正常返回字符串；个别 transport 返回富对象）。
/**
 * `#605` **`java.net.URL(...).openConnection()` 的同步传输**（L1 侧）。
 *
 * 复用 `syncHttp`（= `java.ajax` 的同一条出口：URL 选项解析 + 源级默认头 + Cookie + 同步传输），
 * 不另开 fetch 通道。两点有意处理：
 *  ① **强制 `Accept-Encoding: identity`**：本仓同步传输只有**文本**面（curl / SAB worker 都回字符串），
 *     让站点压缩等于把二进制塞进 utf8 解码器 ⇒ 必然损坏。源里 `GZIPInputStream` 的分支因此不会触发
 *     （`Content-Encoding` 不含 gzip），解压类仍实现着（防御 + 有源无条件包一层）。
 *  ② body 用 `Buffer.from(bytes).toString('utf-8')`：语料里 hpost 的 body 都是 JSON 文本/表单串。
 */
wireJavaNetTransport((req) => {
  const headers: Record<string, string> = { ...(req.headers ?? {}), 'Accept-Encoding': 'identity' };
  const bodyText = req.body && req.body.length ? Buffer.from(req.body).toString('utf-8') : undefined;
  const res = syncHttp(req.method as 'GET', req.url, bodyText, headers as Record<string, unknown>);
  const r = res as unknown as {
    body?: () => string;
    statusCode?: () => number;
    headers?: () => Record<string, string>;
  };
  const text = typeof r?.body === 'function' ? String(r.body()) : String(res ?? '');
  const code = typeof r?.statusCode === 'function' ? r.statusCode() : 200;
  const hs = typeof r?.headers === 'function' ? (r.headers() ?? {}) : {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(hs)) lower[String(k).toLowerCase()] = String(v);
  return { code, headers: lower, body: new Uint8Array(Buffer.from(text, 'utf-8')) };
});

wireOkhttpTransport((method, url, body, headers) => {
  const res = syncHttp(method as 'GET', url, body, headers as Record<string, unknown>);
  const r = res as unknown as { body?: () => string; statusCode?: () => number; headers?: () => Record<string, string> };
  return {
    body: typeof r?.body === 'function' ? String(r.body()) : String(res ?? ''),
    code: typeof r?.statusCode === 'function' ? r.statusCode() : 200,
    headers: typeof r?.headers === 'function' ? (r.headers() ?? {}) : {},
  };
});

// ---- 自引用桥（base 字面量内不可引用 base，字面量完成后补挂） ----
/**
 * `#643` 收归一处：默认 UA 现在由 `net/user-agent.ts` 定义（出口请求也要用它补缺省头），
 * 这里改成引用，避免「`java.getUserAgent()` 返回 A、实际发出去的是 B」这种二次漂移。
 */
const DEFAULT_UA = UA_DEFAULT;

function attachExtendedJavaApi(
  base: Record<string, unknown>,
  cookie: Record<string, unknown>,
  /** 源级默认请求头（源 header 规则 + 登录头 + 源 Cookie）——与 makeJavaStub 同一份 */
  baseHeaders?: (url?: string) => Record<string, string>,
  /** 同步传输与响应回调——与 makeJavaStub 同一份 */
  sync?: Parameters<typeof syncHttp>[5],
): void {
  let t2sCv: ((s: string) => string) | null | undefined;
  let s2tCv: ((s: string) => string) | null | undefined;
  let cnMap: Record<string, number> | null = null;

  base.t2s = (t: unknown) => {
    const s = String(t ?? '');
    if (!s || !OpenCC) return s;
    t2sCv ??= (() => { try { return OpenCC.Converter({ from: 'tw', to: 'cn' }) as (x: string) => string; } catch { return null; } })();
    try { return t2sCv ? t2sCv(s) : s; } catch { return s; }
  };
  base.s2t = (t: unknown) => {
    const s = String(t ?? '');
    if (!s || !OpenCC) return s;
    s2tCv ??= (() => { try { return OpenCC.Converter({ from: 'cn', to: 'tw' }) as (x: string) => string; } catch { return null; } })();
    try { return s2tCv ? s2tCv(s) : s; } catch { return s; }
  };
  base.getCookie = (_tag: unknown, key?: unknown) => {
    if (key !== undefined) {
      const v = cookie?.get ? (cookie.get as (k: string) => string)(String(key)) : '';
      return v ?? '';
    }
    return cookie?.header ? (cookie.header as () => string)() : '';
  };
  base.aesBase64DecodeToString = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try {
      const c = (base.createSymmetricCrypto as (...a: unknown[]) => Record<string, unknown>)(String(transformation), String(key), iv === undefined ? undefined : String(iv));
      // Legado：`createSymmetricCrypto(...).decryptStr(str)`（JsEncodeUtils.kt:191）——
      // hutool 的 `decryptStr` 走 `SecureUtil.decode`：**全 hex 按 hex、否则按 base64**。
      // 旧实现固定 `decryptBase64` ⇒ 传 hex 密文的源解不出来（如宜搜小说正文）。
      return (c.decryptStr as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  /**
   * `#540` **aes/des 旧 API 家族补全**（上游 `JsEncodeUtils.kt` 的 deprecated 组，注释原话
   * 「过于繁琐弃用，但是 web 需要调用」）。全部是 `createSymmetricCrypto(transformation, key, iv)`
   * 的薄包装 —— 与 `aesBase64DecodeToString` 同一条委托路，不另写加解密。
   * 重探依据（2026-10-20，733 源）：**11 源在调**（宜搜/海棠/PO5/猫眼/全免漫画/阅文/uu书库/禁漫天堂API…），
   * 其中阅文的 `tripleDESEncodeBase64Str` 是 `#538` okhttp3 闭链的一环 ⇒ 不补 = 阅文签名头恒空。
   * 签名逐条对齐上游；`ArgsBase64` 变体的 key/iv 先 base64 解成字节再进工厂。
   */
  const symOf = (transformation: unknown, key: unknown, iv: unknown): Record<string, unknown> =>
    (base.createSymmetricCrypto as (...a: unknown[]) => Record<string, unknown>)(
      String(transformation),
      key,
      // ⚠️ iv 原样透传：ArgsBase64 变体传的是 Uint8Array（String() 会拼成 "18,52,…" 炸掉）
      iv === undefined || iv === null || iv === '' ? undefined : iv,
    );
  const b64Bytes = (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s ?? ''), 'base64'));
  // —— 解码组（decrypt/decryptStr）——
  base.aesDecodeToByteArray = (str: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return new Uint8Array((symOf(transformation, key, iv).decrypt as (d: string) => Buffer)(String(str))); }
    catch { return new Uint8Array(0); }
  };
  base.aesDecodeToString = (str: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return (symOf(transformation, key, iv).decryptStr as (d: string) => string)(String(str)); } catch { return ''; }
  };
  base.aesDecodeArgsBase64Str = (data: unknown, key: unknown, mode: unknown, padding: unknown, iv: unknown) => {
    try {
      const c = symOf(`AES/${String(mode)}/${String(padding)}`, b64Bytes(key), b64Bytes(iv));
      return (c.decryptStr as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  base.aesBase64DecodeToByteArray = (str: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return new Uint8Array((symOf(transformation, key, iv).decrypt as (d: string) => Buffer)(String(str))); }
    catch { return new Uint8Array(0); }
  };
  base.desDecodeToString = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return (symOf(transformation, key, iv).decryptStr as (d: string) => string)(String(data)); } catch { return ''; }
  };
  base.desBase64DecodeToString = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return (symOf(transformation, key, iv).decryptStr as (d: string) => string)(String(data)); } catch { return ''; }
  };
  base.tripleDESDecodeStr = (data: unknown, key: unknown, mode: unknown, padding: unknown, iv: unknown) => {
    try {
      const c = symOf(`DESede/${String(mode)}/${String(padding)}`, key, iv);
      return (c.decryptStr as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  base.tripleDESDecodeArgsBase64Str = (data: unknown, key: unknown, mode: unknown, padding: unknown, iv: unknown) => {
    try {
      const c = symOf(`DESede/${String(mode)}/${String(padding)}`, b64Bytes(key), b64Bytes(iv));
      return (c.decryptStr as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  // —— 编码组（encrypt/encryptBase64）——
  base.aesEncodeToByteArray = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return new Uint8Array((symOf(transformation, key, iv).encrypt as (d: string) => Buffer)(String(data))); }
    catch { return new Uint8Array(0); }
  };
  base.aesEncodeToString = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return String((symOf(transformation, key, iv).encrypt as (d: string) => Buffer)(String(data))); } catch { return ''; }
  };
  base.aesEncodeToBase64ByteArray = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try {
      const b64 = (symOf(transformation, key, iv).encryptBase64 as (d: string) => string)(String(data));
      return new Uint8Array(Buffer.from(b64, 'base64'));
    } catch { return new Uint8Array(0); }
  };
  base.aesEncodeToBase64String = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return (symOf(transformation, key, iv).encryptBase64 as (d: string) => string)(String(data)); } catch { return ''; }
  };
  base.aesEncodeArgsBase64Str = (data: unknown, key: unknown, mode: unknown, padding: unknown, iv: unknown) => {
    try {
      const c = symOf(`AES/${String(mode)}/${String(padding)}`, b64Bytes(key), b64Bytes(iv));
      return (c.encryptBase64 as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  base.desEncodeToString = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return String((symOf(transformation, key, iv).encrypt as (d: string) => Buffer)(String(data))); } catch { return ''; }
  };
  base.desEncodeToBase64String = (data: unknown, key: unknown, transformation: unknown, iv: unknown) => {
    try { return (symOf(transformation, key, iv).encryptBase64 as (d: string) => string)(String(data)); } catch { return ''; }
  };
  base.tripleDESEncodeBase64Str = (data: unknown, key: unknown, mode: unknown, padding: unknown, iv: unknown) => {
    try {
      const c = symOf(`DESede/${String(mode)}/${String(padding)}`, key, iv);
      return (c.encryptBase64 as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  base.tripleDESEncodeArgsBase64Str = (data: unknown, key: unknown, mode: unknown, padding: unknown, iv: unknown) => {
    try {
      const c = symOf(`DESede/${String(mode)}/${String(padding)}`, b64Bytes(key), b64Bytes(iv));
      return (c.encryptBase64 as (d: string) => string)(String(data));
    } catch { return ''; }
  };
  /**
   * `#540` **htmlFormat**（上游 `JsExtensions.kt:770` = `HtmlFormatter.formatKeepImg`）。
   * 重探 733 源：**6 源在用**（红牛/U酷 从播放页 HTML 抠 JSON · pixiv 系清简介）。
   * 复用 `html-format.ts` 的 formatText（preserveImg 分支 = 上游 notImgHtmlRegex 策略，
   * 正则链与顺序逐条对齐）⇒ 不抄第二份。worker 侧经 convert 通道回宿主（同 t2s/s2t 范式）。
   * ⚠️ 与上游的已知差异：formatKeepImg 还会把 img src 改写成绝对 URL（formatImagePattern），
   *    我们保留原 src —— 语料 6 源的用法（抠 JSON / 清文本）不依赖它。
   */
  base.htmlFormat = (html: unknown): string => formatText(String(html ?? ''), '\u3000\u3000', true);
  /**
   * `#540` **createAsymmetricCrypto**（上游 `JsEncodeUtils.kt:80` + `help/crypto/AsymmetricCrypto.kt`）。
   * 重探 733 源：**3 源在用**（🌍🔞爱丽丝书屋 RSA/ECB/PKCS1Padding 私钥解 · 📂乐读小说 RSA 公钥解）。
   * 面（逐条对齐上游）：setPrivateKey / setPublicKey（链式）+ decrypt / decryptStr / encrypt /
   * encryptBase64 / encryptHex，统一带 `usePublicKey`（上游默认 **true** —— hutool 的怪默认，照抄）。
   * 密钥口径 = hutool `KeyUtil`：PKCS8（私）/ SPKI（公）DER；PKCS1 形态自动包一层再进 Node。
   */
  base.createAsymmetricCrypto = (transformation: unknown) => {
    const parts = String(transformation ?? '').split('/');
    const alg = (parts[0] || 'RSA').toUpperCase();
    if (alg !== 'RSA') throw new Error(`createAsymmetricCrypto: 仅支持 RSA（上游 hutool 同限），当前「${alg}」`);
    const padName = (parts[2] || 'PKCS1Padding').toUpperCase();
    // Node crypto 的 padding 常量：1=PKCS1 · 3=NO · 4=OAEP（crypto.constants.RSA_*）
    const padding: 1 | 3 | 4 = padName.includes('OAEP') ? 4 : padName.includes('NOPADDING') ? 3 : 1;
    let priv: ReturnType<typeof createPrivateKey> | null = null;
    let pub: ReturnType<typeof createPublicKey> | null = null;
    // Node 的运行时签名是 (key, buffer, options?)；本仓 @types/node 只声明了 2 参 ⇒ 显式别名
    type RsaOp = (k: unknown, b: Buffer, o?: { padding: number }) => Buffer;
    const rsaPrivDec = privateDecrypt as unknown as RsaOp;
    const rsaPubDec = publicDecrypt as unknown as RsaOp;
    const rsaPrivEnc = privateEncrypt as unknown as RsaOp;
    const rsaPubEnc = publicEncrypt as unknown as RsaOp;
    const toBuf = (v: unknown): Buffer =>
      v instanceof Uint8Array ? Buffer.from(v) : Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf-8');
    const self: Record<string, unknown> = {
      setPrivateKey: (k: unknown) => {
        const der = toBuf(k);
        try {
          priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        } catch {
          priv = createPrivateKey({ key: wrapDerPkcs1Private(der), format: 'der', type: 'pkcs8' });
        }
        return self;
      },
      setPublicKey: (k: unknown) => {
        const der = toBuf(k);
        try {
          pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
        } catch {
          pub = createPublicKey({ key: wrapDerPkcs1Public(der), format: 'der', type: 'spki' });
        }
        return self;
      },
      decrypt: (data: unknown, usePublicKey: unknown = true) => {
        const buf = toBuf(data);
        if (usePublicKey === false || usePublicKey === 'false') {
          if (!priv) throw new Error('createAsymmetricCrypto: usePublicKey=false 但未 setPrivateKey');
          return new Uint8Array(rsaPrivDec(priv, buf, { padding }));
        }
        if (!pub) throw new Error('createAsymmetricCrypto: usePublicKey=true 但未 setPublicKey');
        return new Uint8Array(rsaPubDec(pub, buf, { padding }));
      },
      decryptStr: (data: unknown, usePublicKey: unknown = true) =>
        Buffer.from((self.decrypt as (d: unknown, u?: unknown) => Uint8Array)(data, usePublicKey)).toString('utf-8'),
      encrypt: (data: unknown, usePublicKey: unknown = true) => {
        const buf = toBuf(data);
        if (usePublicKey === false || usePublicKey === 'false') {
          if (!priv) throw new Error('createAsymmetricCrypto: usePublicKey=false 但未 setPrivateKey');
          return new Uint8Array(rsaPrivEnc(priv, buf, { padding }));
        }
        if (!pub) throw new Error('createAsymmetricCrypto: usePublicKey=true 但未 setPublicKey');
        return new Uint8Array(rsaPubEnc(pub, buf, { padding }));
      },
      encryptBase64: (data: unknown, usePublicKey: unknown = true) =>
        Buffer.from((self.encrypt as (d: unknown, u?: unknown) => Uint8Array)(data, usePublicKey)).toString('base64'),
      encryptHex: (data: unknown, usePublicKey: unknown = true) =>
        Buffer.from((self.encrypt as (d: unknown, u?: unknown) => Uint8Array)(data, usePublicKey)).toString('hex'),
    };
    return self;
  };
  base.toNumChapter = (s: unknown) => {
    const str = s == null ? null : String(s);
    if (!str) return null;
    const m = /第([〇零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟万亿]+)(章)/.exec(str);
    if (!m) return str;
    cnMap ??= {
      '〇':0,'零':0,'一':1,'壹':1,'二':2,'贰':2,'三':3,'叁':3,'四':4,'肆':4,
      '五':5,'伍':5,'六':6,'陆':6,'七':7,'柒':7,'八':8,'捌':8,'九':9,'玖':9,
      '十':10,'拾':10,'百':100,'佰':100,'千':1000,'仟':1000,'万':10000,'亿':100000000,'两':2,
    };
    // 中文数字组合解析（对齐 StringUtils.stringToInt 语义：十/百/千/万 位权组合）
    const raw = m[1] as string;
    let total = 0;
    let section = 0;
    let digit = 0;
    for (const ch of raw) {
      const d = cnMap[ch] ?? -1;
      if (d < 0) return str;
      if (d >= 10000) { total = (total + section + digit) * d; section = 0; digit = 0; }
      else if (d >= 10) { section += (digit || 1) * d; digit = 0; }
      else digit = d;
    }
    const num = total + section + digit;
    return `第${num}${m[2]}`;
  };
  base.getUserAgent = () => DEFAULT_UA;
  // —— Rhino Java 包访问：Packages.java.util.ArrayList / HashMap 等（源脚本直接 new 使用）——
  base.Packages = javaPackages;
  base.JavaImporter = javaImporterCtor;
  // —— java.util（Legado 源常用 java.util.Base64 / UUID 等 Rhino 原生包访问）——
  const b64 = {
    encode: (s: unknown) => Buffer.from(String(s ?? ''), 'utf-8').toString('base64'),
    decode: (s: unknown) => Buffer.from(String(s ?? ''), 'base64').toString('utf-8'),
  };
  base.util = new Proxy(
    {
      Base64: {
        getEncoder: () => ({ encodeToString: (s: unknown) => b64.encode(s), encode: (s: unknown) => b64.encode(s) }),
        getDecoder: () => ({ decode: (s: unknown) => b64.decode(s), decodeToString: (s: unknown) => b64.decode(s) }),
        encode: (s: unknown) => b64.encode(s),
        decode: (s: unknown) => b64.decode(s),
      },
      UUID: { randomUUID: () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) },
      Arrays: { toString: (a: unknown) => String(a), asList: (a: unknown) => (Array.isArray(a) ? a : [a]) },
    } as Record<string, unknown>,
    {
      // 未实现的 java.util.*：返回可继续下钻的空桩（避免 undefined.xxx 炸规则）
      get: (t, prop: string) => (prop in t ? t[prop] : () => ''),
    },
  );

  /**
   * HEAD 请求（Legado `java.head`，`JsExtensions.kt:600-620`）：返 status/headers/url，**无 body 省流量**。
   *
   * ⚠️ 上游这三个 API（`get`/`head`/`post`）**全部 `followRedirects(false)`** ——
   * 上游注释原话「js实现重定向拦截」：源脚本先 HEAD 看 3xx/Location 再自己决定跟不跟。
   * 所以这里必须传 `noRedirect`（否则 HEAD 的 3xx 判据形同虚设，见 `#387c`）。
   */
  base.head = (url: unknown, headers?: unknown, timeout?: unknown) => {
    const spec = prepareRequest(String(url), { method: 'HEAD', headers: headers as Record<string, unknown> });
    // Legado `head(url, headers, timeout)` 的 timeout 单位是 ms，缺省 15s；
    // 未显式给 timeout 时沿用 URL 选项 `,{"timeout":N}`（与 syncHttpSpec 同一规则）
    const optTimeout = Number((spec.option as Record<string, unknown> | undefined)?.['timeout']);
    const timeoutMs = typeof timeout === 'number' && timeout > 0
      ? timeout
      : (Number.isFinite(optTimeout) && optTimeout > 0 ? Math.round(optTimeout) : SYNC_HTTP_TIMEOUT_DEFAULT_MS);
    // `#464` 坏地址必须抛（上游 `Jsoup.connect` 语义）—— 18AV「获取网址」靠这个 catch 写默认域名
    assertHttpUrl(spec.url);
    /**
     * `#732` **网络优先、镜像兜底**。
     *
     * HEAD 探测按原行为先发请求；**失败**（超时 / 连接错误 / `code=0`）才用镜像内容的
     * sha256 当 etag 兜底（用户换镜像文件 ⇒ etag 变 ⇒ 源侧 `Reload` 会重取）。
     * 网络成功时**不读镜像**，也不会因镜像存在而跳过请求。
     */
    // 优先级：源级默认头（最低）< 调用方 headers < URL 自带 `,{headers}`（spec.headers，最高）
    const plain: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...(baseHeaders?.(spec.url) ?? {}),
      ...(headers as Record<string, unknown> ?? {}),
      ...spec.headers,
    })) {
      if (v != null) plain[k] = String(v);
    }
    // `noRedirect`：上游 `java.head` = `followRedirects(false)`（#387c）
    let res: ReturnType<typeof defaultSyncFetch> | null = null;
    let netErr: unknown = null;
    try {
      res = (sync?.transport ?? defaultSyncFetch)({ method: 'HEAD', url: spec.url, headers: plain, timeoutMs, noRedirect: true });
      sync?.onResponse?.(res, spec.url);
    } catch (e) {
      netErr = e;
    }
    if (!res || !res.status) {
      const mirrorEtag = jsMirrorEtag(spec.url);
      if (mirrorEtag) {
        const respHeaders: Record<string, string> = { etag: mirrorEtag, 'x-yuedu-mirror': '1' };
        const out0 = new String('') as string & Record<string, unknown>;
        out0.body = () => '';
        out0.headers = () => respHeaders;
        out0.header = (n?: unknown) => (n === undefined ? respHeaders : (respHeaders[String(n).toLowerCase()] ?? ''));
        out0.code = () => 200;
        out0.statusCode = () => 200;
        out0.url = () => String(url);
        return out0;
      }
    }
    if (!res) throw netErr; // 没镜像可兜底 ⇒ 保持原语义（异常照抛）
    const respHeaders = res.headers;
    const out = new String('') as string & Record<string, unknown>;
    out.body = () => '';
    out.headers = () => respHeaders;
    out.header = (n?: unknown) => (n === undefined ? respHeaders : (respHeaders[String(n).toLowerCase()] ?? ''));
    out.code = () => res.status;
    out.statusCode = () => res.status;
    out.url = () => String(url);
    return out;
  };
  /**
   * Legado `java.ajaxTestAll(urlList, timeout, skipRateLimit?)`（`JsExtensions.kt:219-234`）——
   * **并发**抓一组 URL，返回 `StrResponse[]`（每项带 body/headers/code，供脚本挑最快的那个）。
   *
   * ## 语料实况：它是「版本特性探测」而不是真的测速
   * 🔞兽人小说站 / 🔞Linpx 的 jsLib 里写着
   * `function isLegadoSigma(){ return typeof java.ajaxTestAll === "function" }`，
   * 用来判断「这是 Sigma 版阅读」并把结果写进 `u.environment.IS_LEGADO_SIGMA` 缓存。
   * 上游正式版**确实有这个函数**（就在 `JsExtensions.kt`），所以实现它才是「与上游一致」；
   * 不实现反而让这两个源误判环境（它们会走「非 Sigma」分支，丢掉一批只在 Sigma 下可用的逻辑）。
   *
   * ⚠️ 上游是并发（`mapAsync(AppConfig.threadCount)`）；本仓 L1 求值面是**同步**的，
   * 这里按顺序逐个发（`timeout` 单位是**毫秒**，对齐上游 `callTimeout = timeout.toLong()`）。
   * 单项失败**不抛**、也不从数组里剔除 —— 上游同样返回带错误状态的 StrResponse，
   * 脚本按 `code`/`body` 自己挑（剔除会改变数组下标语义）。
   */
  base.ajaxTestAll = (urlList: unknown, timeout?: unknown, _skipRateLimit?: unknown) => {
    const list = Array.isArray(urlList) ? urlList : [urlList];
    const transport = sync?.transport ?? defaultSyncFetch;
    return list.map((item) => {
      const raw = String(item ?? '');
      const spec = prepareRequest(raw, { method: 'GET', headers: (baseHeaders?.(raw) ?? {}) as Record<string, unknown> });
      // 显式第二参优先；未给时沿用 URL 选项 `,{"timeout":N}`（与 syncHttpSpec 同一规则）
      const optTimeout = Number((spec.option as Record<string, unknown> | undefined)?.['timeout']);
      const timeoutMs = typeof timeout === 'number' && timeout > 0
        ? timeout
        : (Number.isFinite(optTimeout) && optTimeout > 0 ? Math.round(optTimeout) : SYNC_HTTP_TIMEOUT_DEFAULT_MS);
      try {
        const res = transport({ method: 'GET', url: spec.url, headers: spec.headers, timeoutMs, noRedirect: false });
        const body = typeof res.body === 'string' ? res.body : Buffer.from(res.body ?? []).toString('utf-8');
        return makeStrResponse(spec.url, body, res.status, res.headers);
      } catch (e) {
        // 失败项照旧返回（上游也是给一个带错误信息的响应），但留痕一次，避免「全是 0 却没人知道」
        ajaxTestWarn(spec.url, e);
        return makeStrResponse(spec.url, '', 0, {}, String(e instanceof Error ? e.message : e).slice(0, 120));
      }
    });
  };
  // —— getStrResponse：带 headers 的 GET（同样走 URL 选项解析）——
  base.getStrResponse = (url: unknown, headers?: unknown) =>
    syncHttpSpec(url, { headers: headers as Record<string, unknown> }, baseHeaders, sync);
  // —— ajaxAll：多 URL 抓取返数组（L1 同步串行；worker 走 rpc 并发）——
  //   每个 URL 都按 AnalyzeUrl 语义解析（绿柠小说的 ajaxAll 每个元素都带 POST body 尾巴）
  base.ajaxAll = (urls: unknown) => {
    const arr = Array.isArray(urls) ? (urls as unknown[]) : [];
    return arr.map((u) => syncHttpSpec(u, {}, baseHeaders, sync));
  };
  // —— 字节/字符串桥 ——
  base.strToBytes = (s: unknown, charset?: unknown) => {
    try { return Buffer.from(String(s), (charset as BufferEncoding) || 'utf-8'); }
    catch { return Buffer.alloc(0); }
  };
  base.bytesToStr = (b: unknown, charset?: unknown) => {
    try { return Buffer.from(b as Buffer).toString((charset as BufferEncoding) || 'utf-8'); }
    catch { return ''; }
  };
  base.hexDecodeToByteArray = (hex: unknown) => Buffer.from(hexStrict(String(hex)), 'hex');
  // —— 摘要（Legado DigestUtil.digester(algorithm).digestHex）——
  base.digestHex = (data: unknown, algorithm: unknown) => {
    try { return createHash(String(algorithm).toLowerCase()).update(String(data)).digest('hex'); }
    catch { return ''; }
  };
}

/** Java 顶层包名桩（Rhino 语义）：org.jsoup / com.alibaba 等任意下钻，调用返回空串 */
const javaPkgStub: unknown = new Proxy(function () { return ''; } as unknown as Record<string, unknown>, {
  get: (_t, prop: string) => {
    if (typeof prop === 'symbol') return undefined;
    if (prop === 'then') return undefined;
    return javaPkgStub;
  },
  apply: () => '',
});

// ---------------------------------------------------------------------------
// L4 混合求值器：结构化绑定 → worker 池（异步、不阻塞主线程）；DOM 绑定 → L1 同步
// ---------------------------------------------------------------------------

/** 判定 bindings 是否可结构化克隆（跨 worker postMessage）。DOM 节点/函数/类实例 → 否 */
function isCloneable(v: unknown, depth = 0): boolean {
  if (v == null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') return t === 'undefined';
  if (depth > 4) return false;
  if (v instanceof Date || v instanceof RegExp) return true;
  if (Array.isArray(v)) return v.every((x) => isCloneable(x, depth + 1));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false; // String 包装 / DOM 节点 / 类实例
    return Object.values(v as Record<string, unknown>).every((x) => isCloneable(x, depth + 1));
  }
  return false;
}

export interface HybridEvalOptions extends JsEvalOptions {
  /** worker 池（须由 createWorkerSandboxPool 创建——带品牌标记；不传/非品牌 → 全部走 L1） */
  pool?: import('../contract/engine').JsSandboxPool & { __yueduWorkerPool?: boolean };
  /**
   * `#779` **纯计算脚本的 worker 求值预算**（毫秒；不传 = 池默认 10s）。
   * 只有 content 动作由引擎传 20s（见 `contentComputeEvalTimeoutMs`）；含 HTTP 的脚本
   * 仍走 `syncTimeoutMs + 5s`，本值对它们不生效。
   */
  computeTimeoutMs?: number;
  /** JS 渲染器（WebViewProvider）：java.webView/startBrowserAwait 走真渲染；不传降级静态抓取 */
  renderer?: WebRendererHook;
  /**
   * `#676` **`java.webView(html, url, js)` 的宿主实现**（异步）：把给定 HTML 当文档、以 url 为 origin
   * 执行 js，返回 **js 的返回值**。与 `renderer`（按 URL 取渲染后 DOM）是两件事。
   *
   * 只能异步：宿主要走 `Page.navigate` → `setDocumentContent` → `Runtime.evaluate` 三段 CDP。
   * 所以调用方必须保证带 `java.webView` 的脚本**进 worker**（worker 的同步 RPC 会等宿主的异步结果）。
   */
  renderHtmlJsAsync?: (html: string, baseUrl: string, js: string) => Promise<string>;
  /** 源级 Cookie（worker 内 java.getCookie 经 RPC 回宿主） */
  cookies?: import('../contract/engine').CookieStore;
  /**
   * 宿主 HTTP 实现：worker 内 `java.ajax/post/get/head/getStrResponse` 经 RPC 回宿主时用它替代全局 fetch。
   *
   * 引擎传 `ctx.http` 进来即可让 worker 里的脚本请求也走**注入的 HTTP 层**
   * （代理 / mock / 统一超时 / UA / Cookie 落盘），这是 L1 同步路径做不到的。
   */
  http?: (req: {
    method: 'GET' | 'POST' | 'HEAD';
    url: string;
    body?: string;
    headers: Record<string, string>;
    /** `#387c`：不跟随重定向（`java.get/post/head` → 宿主 HttpClient 的 `redirect:'manual'`） */
    redirect?: 'follow' | 'manual';
    /**
     * `#636` 第二层：**本次请求的超时（毫秒）**。给了就由注入层用它，而不是「剩余行动预算」。
     *
     * 为什么必须有这个字段：注入层此前一律用 `requestTimeout(ctx)`（= 这个源还剩多少预算），
     * 实测一次 `HEAD` 被给到 **52s** ⇒ `Reload()` 的 etag 探测直接把整个搜索预算吃光，
     * 后面真正要下载的 `importScript` 只剩 1s（日志里的 `请求超时（>1000ms）`）。
     * 有了它，`Reload` 的 HEAD 固定 15s、脚本下载每次 20s，失败快、预算留给该做的事。
     */
    timeout?: number;
    /**
     * `#742` URL 选项里的 `dnsIp`（IP 直连）：由 worker 侧 `httpRpcSpec` 从 `option` 取出后带上来，
     * 注入层必须把它落到 HttpClient（否则发现页/登录仍走被污染的系统 DNS）。
     */
    dnsIp?: string;
  }) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
  /**
   * **规则桥**（`java.setContent / getElements / getElement / getStringList`，挂账 `#108`）。
   *
   * 为什么必须回宿主：这四个方法的求值要**真 DOM + `AnalyzeRule`**，而 worker 里两样都没有
   * （旧实现直接「未实现 → 空串」，是静默失效；当时的兜底是把用它们的脚本全推回 L1，
   * 副作用是其中 18 个含 `java.ajax` 的源也跟着同步阻塞进程）。
   *
   * 返回**可序列化描述符**（`{outerHTML, innerHTML, text, attrs}`）——worker 侧再用
   * `__yueduJsoup().list()` 重建出「带 jsoup 方法的活列表」，这样脚本后续的
   * `.select()/.attr()/.toArray()` 仍然可用（**只回一次性快照会让 `.select()` 一律失效**，
   * 那是另一种静默失败，评估文档里专门点过）。
   *
   * `op='strings'` 时返回 `string[]`；`op='elements'` 时返回描述符数组；
   * `op='object'` 对应上游 `AnalyzeRule.getElement`（`:384-414`），按它的**两种**返回值分流（`#313`）：
   *   · Css / XPath → `{kind:'nodes'}`（**整个 Elements 列表**，worker 侧重建活列表）；
   *   · Json / Regex / Js → `{kind:'value'}`（**原值**，不再包成元素列表 —— 上游 `getObject` 直接给脚本）。
   * 不注入 → 返回空（与旧行为一致，不引入新的崩溃点）。
   */
  ruleBridge?: (op: 'elements' | 'strings' | 'object', rule: string, content: string) => Promise<RuleBridgeResult>;
  /**
   * `#636` 第二层：**lib 名字镜像到求值 realm 的全局**（默认关；只对远程 jsLib 表的源开）。
   *
   * 背景：上游 Rhino 的 `SharedJsScope` 产出**就是**脚本的全局 —— lib 函数任何闭包都够得着。
   * 本仓 chain 模式把 lib 放在 `with(scopeObj)` 原型层，顶层 eval 够得着；但**源自己**把函数
   * 定义/挂到全局（qyyuapi 系 `de.js` 混淆自解密后的 `user_Check` 等）时，那些函数的闭包
   * 只看见全局 ⇒ `Get is not defined`（实测有栈）。
   *
   * 为什么默认不开：`#611 step3` 的隔离锁明确「lib 声明不进求值全局」，普通（内联 jsLib）源
   * 靠它防串味 ⇒ 只有「jsLib 是远程 URL 表」的源（`engine` 侧用 `jsLibUrls(原始jsLib)` 判定）
   * 才打开。也接受环境变量强制：`YUEDU_JS_LIBGLOBAL_OFF=1` 在 worker 侧整体关闭。
   */
  libGlobalNames?: boolean;
  /**
   * `#727` `java.getVerificationCode(imageUrl)` 的**异步**宿主通道（worker 专用）。
   *
   * worker 侧 `rpc('verificationCode')` 会同步阻塞 worker 线程（`Atomics.wait`），
   * 宿主这段时间异步拉起/复用该源的 Chromium、等桌面端人工输入并回收 Cookie。
   * 宿主等待期间不计入 worker 的 JS 预算（`beginHostWork` / `endHostWork`）。
   *
   * 超时/用户取消必须 **reject**（worker 侧会原样抛出），不能返回空串。
   */
  verificationCodeAsync?: (imageUrl: string) => Promise<string>;
}

/** 规则桥的元素描述符（worker 侧用 `__yueduJsoup().list()` 重建出「带 jsoup 方法的活列表」） */
export interface RuleNodeDescriptor {
  outerHTML: string;
  innerHTML: string;
  text: string;
  attrs: Record<string, string>;
}

/**
 * `op='object'`（= 上游 `AnalyzeRule.getElement`）的两条返回形态（`#313`）。
 *
 * ★ 必须显式带 `kind`：**「Css 的元素列表」与「Json 的数组」在 JSON 里长得一模一样**，
 *   靠形状猜必然出错（见 MEMORY「同一判据写两处/靠形状推断必然漂移」）。
 */
export type RuleBridgeObjectResult =
  | { kind: 'nodes'; list: RuleNodeDescriptor[] }
  | { kind: 'value'; value: unknown };

/**
 * `op='elements'` 的**纯 JSON 列表**形态（`#406`）。
 *
 * ## 为什么必须单独一个 kind
 * `op='elements'` 此前一律把元素按 `describeRuleNode` 转成
 * `{outerHTML: JSON.stringify(x), innerHTML: 同, text: 同, attrs:{}}` 描述符。
 * 对 **Json 段的 `$.…[*]`（JSON 对象列表）** 这是错的，两重后果：
 *   ① **字段丢失**：worker 侧元素变成「一串 JSON 塞在 outerHTML 里」，
 *      脚本的 `$.title` / 引擎 `chapterName` 全取不到；
 *   ② **整表塌成 1 个字符串**：描述符元素携带**可枚举函数**（`mkList` 在 worker 里挂的
 *      `html/text/attr/select…`）⇒ `structuredClone` 失败 ⇒ `__yueduSendable` 退化成
 *      `String(v)`（元素 `toString` = outerHTML，用逗号 join）⇒ 宿主 `getElements` 只拿到
 *      **1 个元素**（实测 🎨快看漫画：同一份源 **L1 = 176 章、worker = 0 章**）。
 *
 * 上游 `bindings["java"] = this` 的语义是 L1 与 worker **逐字等价** ⇒ 这里必须按**纯值**下发，
 * worker 侧再用 `__yueduAttachJsonMap` 挂 Java List/Map 方法（与 `kind:'value'` 同一条路，
 * 且那些方法是非枚举的 ⇒ 过得了 structuredClone）。
 */
export interface RuleBridgeValueList {
  kind: 'values';
  list: unknown[];
}

/** 规则桥返回值（三个 op 的并集） */
export type RuleBridgeResult = RuleNodeDescriptor[] | string[] | RuleBridgeObjectResult | RuleBridgeValueList;

/**
 * `#526` worker 侧 `android.graphics` 的**宿主位图句柄表**。
 *
 * worker 只持整数 id（见 worker-pool 的 graphics 注释），像素全在宿主、由
 * `android-graphics.ts` 的唯一实现运算 ⇒ worker/L1 零漂移。
 *
 * 容量：句柄不随作业结束自动释放（worker 侧没有 GC 回调），故设硬上限
 * （24 张 / 128MB，按插入顺序淘汰）—— 禁漫天堂一类脚本单页只用 2~20 张，
 * 超限只会在**极多张**的极端脚本上淘汰旧句柄（下一次引用会明确报错，不静默）。
 *
 * `#537` ①：记录 `at`（最近使用时刻）⇒ **空闲 30s 自动回收**。双保险：
 * 惰性清扫（每次 hold/get 顺手扫，≤24 项可忽略）+ unref 定时器（10s 一轮，
 * 位图活动停止后也释放内存，且不拽住进程退出）。`now` 可注入 ⇒ 测试免时钟造假。
 */
interface BitmapHandle { b: AndroidBitmap; at: number }
/** `#537` ② 免回复位图 op（worker 同帧合并成一条 RPC 后按序下发） */
interface BitmapNoReplyOp {
  op?: string;
  id?: number;
  src?: number;
  dst?: number;
  left?: number;
  top?: number;
  color?: number;
  sl?: number;
  st?: number;
  sr?: number;
  sb?: number;
  dl?: number;
  dt?: number;
  dr?: number;
  db?: number;
}
const bitmapHandles = new Map<number, BitmapHandle>();
let bitmapNextId = 1;
let bitmapHandleBytes = 0;
const BITMAP_MAX_COUNT = 24;
const BITMAP_MAX_BYTES = 128 * 1024 * 1024;
/** `#537` 空闲回收阈值（毫秒） */
export const BITMAP_IDLE_MS = 30_000;
const BITMAP_SWEEP_MS = 10_000;
/**
 * `#537` ③ **大图二进制回包的体积阈值**（字节）。
 *
 * 为什么区分大小：SAB status=3 的收益是免 base64 膨胀与 JSON 字符串化，但每张图都要把
 * 字节**同步拷进 4MB SAB**；小图（图标/小封面）走原路反而少一次协议切换。
 *  · 默认 64KB：漫画页（实测 100KB~2.4MB）全走二进制，小图保持原 base64 JSON；
 *  · `YUEDU_BITMAP_BINARY_MIN_KB=0` ⇒ 全量二进制；
 *  · 设极大值 ⇒ 关闭二进制（等价 #537 之前的原路，用于回退/对照）。
 * 超 4MB 时由 worker-pool 的 `sabReplyRaw` 自动退回 base64 JSON（分片通道）。
 */
function bitmapBinaryMinBytes(): number {
  const kb = Number(process.env['YUEDU_BITMAP_BINARY_MIN_KB'] ?? 64);
  return (Number.isFinite(kb) && kb >= 0 ? kb : 64) * 1024;
}
let bitmapSweeper: ReturnType<typeof setInterval> | null = null;
/** 清扫空闲句柄，返回释放张数 */
export function sweepBitmapHandles(now: number = Date.now()): number {
  let freed = 0;
  for (const [id, h] of bitmapHandles) {
    if (now - h.at > BITMAP_IDLE_MS) {
      bitmapHandleBytes -= h.b.data.length;
      bitmapHandles.delete(id);
      freed += 1;
    }
  }
  return freed;
}
function armBitmapSweeper(): void {
  if (bitmapSweeper) return;
  try {
    bitmapSweeper = setInterval(() => { sweepBitmapHandles(); }, BITMAP_SWEEP_MS);
    bitmapSweeper.unref?.();
  } catch { /* 无定时器环境 ⇒ 惰性清扫仍生效 */ }
}
/** `android.graphics` 唯一实现（懒建：只有真用到位图的进程才付这份开销） */
let androidGfxNs: Record<string, unknown> | null = null;
function androidGfx(): Record<string, unknown> {
  if (!androidGfxNs) androidGfxNs = makeAndroidGraphicsNs();
  return androidGfxNs;
}
function bitmapHold(b: AndroidBitmap): { id: number; width: number; height: number } {
  const id = bitmapNextId++;
  bitmapHandles.set(id, { b, at: Date.now() });
  bitmapHandleBytes += b.data.length;
  armBitmapSweeper();
  sweepBitmapHandles(); // 惰性：连击时顺手回收上一轮的空闲句柄
  while (bitmapHandles.size > BITMAP_MAX_COUNT || bitmapHandleBytes > BITMAP_MAX_BYTES) {
    const first = bitmapHandles.keys().next();
    if (first.done) break;
    const old = bitmapHandles.get(first.value);
    bitmapHandles.delete(first.value);
    if (old) bitmapHandleBytes -= old.b.data.length;
  }
  return { id, width: b.width, height: b.height };
}
function bitmapGet(id: unknown): AndroidBitmap {
  const h = bitmapHandles.get(Number(id));
  if (!h) throw new Error(`Bitmap 句柄失效（id=${String(id)}）——已超上限/空闲 ${BITMAP_IDLE_MS / 1000}s 被回收，或脚本跨作业持有`);
  h.at = Date.now();
  return h.b;
}

/**
 * 宿主 http rpc 失败留痕的去重表（每个 URL 只报一次；`#606`）。
 * 上限 200 条：批量跑时避免无限增长，超了整表清空（重新开始去重，不丢信息量）。
 */
const hostHttpFailWarned = new Set<string>();

/**
 * `#636` 第二层：**HEAD 失败负缓存**（URL → 失败时刻）。
 *
 * 用途见 `hostRpc` 的 `http` 分支：`Reload()` 的 etag 探测失败一次后会**每次求值重打**
 * （它只在成功时写 `etagtime` 保护），而我们根本用不到 etag ⇒ 记住失败、2 分钟内快返回。
 * 只在「传输层失败 / 超时」时记录：4xx/5xx 是**站点真实回答**，不该被负缓存掩盖。
 */
const headFailAt = new Map<string, number>();
/** 负缓存时长（`YUEDU_HEAD_FAIL_TTL_MS`，默认 120s；0 = 关闭本次优化） */
const HEAD_FAIL_TTL_MS = ((): number => {
  const raw = Number(process.env['YUEDU_HEAD_FAIL_TTL_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
})();

/**
 * `#732` HEAD 网络失败 ⇒ **镜像兜底**响应（etag = 内容 sha256；没有镜像 ⇒ null）。
 * 每个 URL 只留痕一次（HEAD 在 `Reload()` 里会反复打，逐次打日志会刷屏）。
 */
const mirrorHeadWarned = new Set<string>();
function mirrorHeadFallback(url: string): { body: string; headers: Record<string, string>; code: number; url: string } | null {
  const etag = jsMirrorEtag(url);
  if (!etag) return null;
  if (!mirrorHeadWarned.has(url)) {
    if (mirrorHeadWarned.size > 200) mirrorHeadWarned.clear();
    mirrorHeadWarned.add(url);
    console.log(`[jslib-mirror] HEAD 镜像兜底（网络不可用）：${url.slice(0, 140)}`);
  }
  return { body: '', headers: { etag, 'x-yuedu-mirror': '1' }, code: 200, url };
}

/**
 * 网络异常的一句话摘要（undici / AbortController / TLS 三类各自的判据字段不同）：
 *  · 超时：`name === 'AbortError'` 或 `cause.code === 'UND_ERR_CONNECT_TIMEOUT'`
 *  · DNS / 连接：`cause.code`（`ENOTFOUND` / `ECONNREFUSED` / `ECONNRESET` / `CERT_*`）
 *  · 其余：`message`
 * 只取 `message` 会把 `fetch failed` 这种无信息量的话打出来（`#606` 排查时踩过）。
 */
function summarizeHttpError(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, 200);
  const cause = (e as { cause?: { code?: unknown; message?: unknown } }).cause;
  const bits = [e.name, e.message];
  if (cause?.code != null) bits.push(`code=${String(cause.code)}`);
  else if (cause?.message != null) bits.push(String(cause.message).slice(0, 120));
  return bits.filter(Boolean).join(' | ').slice(0, 240);
}

/** 宿主侧 RPC 处理：worker 的 java.ajax/webView → 全局 fetch（异步非阻塞）；getString → 规则桥；bitmap → 句柄表 */
export async function hostRpc(
  evalRule: ((rule: string, value: unknown) => string) | undefined,
  method: string,
  args: unknown,
  renderer?: WebRendererHook,
  cookies?: import('../contract/engine').CookieStore,
  /** 源级默认请求头（源 header 规则 ⊕ 登录头）——worker 的 java.ajax 经此补上，与 L1 行为一致 */
  defaultHeaders?: (url?: string) => Record<string, string> | undefined,
  /** 宿主 HTTP 实现（注入的 HttpClient）；缺省用全局 fetch */
  http?: HybridEvalOptions['http'],
  /** 真正的 source 桩（宿主侧那份）——worker 里重建出来的 source 每个调用都回到它 */
  sourceStub?: Record<string, unknown>,
  /** 真正的 infoMap（宿主侧那份持久 Map）——worker 里的写入回流到此 */
  infoMap?: Map<string, string>,
  /**
   * 变量作用域（worker 的 `java.put` / `java.get(key)` 回流宿主）：
   *  · `read` = 与 L1 同一份 `javaVarGet`（本请求 variables → 按源持久变量）；
   *  · `put`  = 引擎注入的 `javaExtra.putVariable`（与 `@put:{k:v}` 同一持久落点）。
   * 不给就退化为「worker 内自留」——那正是旧行为（跨阶段必丢）。
   */
  javaScope?: {
    read: (k: string) => string;
    put?: (k: string, v: string) => void;
    /** `cache.*` 宿主面（worker 的 cache.get/put/delete… 回流到与 L1 同一份两层存储） */
    cache?: CacheOps;
  },
  /** `#333` worker 侧 jsoup 的宿主 DOM（活节点表）；L1 不需要（自有那份） */
  dom?: JsoupDom,
  /** `#743` A 轮：DOM 后端（常驻 worker）。给了就**整段转发**，`dom` 仅作兜底/对照 */
  domClient?: DomClient,
  /** `#676` `java.webView(html, url, js)` 的宿主实现（异步三段 CDP），见 HybridEvalOptions 同名注释 */
  renderHtmlJsAsync?: (html: string, baseUrl: string, js: string) => Promise<string>,
  /** `#727` `java.getVerificationCode(imageUrl)` 的宿主人工输入通道（异步；超时/取消 reject） */
  verificationCode?: (imageUrl: string) => Promise<string>,
): Promise<unknown> {
  if (method === 'verificationCode') {
    const a = (args ?? {}) as { url?: unknown };
    const url = String(a.url ?? '').trim();
    if (!verificationCode) {
      throw new Error('java.getVerificationCode 需要浏览器交互（宿主未提供验证码输入通道）');
    }
    const code = String((await verificationCode(url)) ?? '').trim();
    if (!code) throw new Error('java.getVerificationCode 未收到验证码（用户取消或超时）');
    return code;
  }
  if (method === 'browser') {
    // java.startBrowser 的 fire-and-forget 通道：只登记「要打开浏览器」，不做渲染、不返回内容。
    // 与 L1 的 makeJavaStub.startBrowser 同语义（Legado startActivity）。
    return '';
  }
  if (method === 'convert') {
    const a = (args ?? {}) as { dir?: string; text?: string };
    const text = String(a.text ?? '');
    if (!text) return '';
    // `#540` htmlFormat：worker 侧复用宿主这份 formatText（正则链唯一实现，不抄第二份）
    if (a.dir === 'htmlFormat') return formatText(text, '\u3000\u3000', true);
    if (!OpenCC) return text;
    try {
      const cv = OpenCC.Converter(a.dir === 's2t' ? { from: 'cn', to: 'tw' } : { from: 'tw', to: 'cn' }) as (s: string) => string;
      return cv(text);
    } catch { return text; }
  }
  if (method === 'getCookie') {
    const a = (args ?? {}) as { key?: string | null };
    if (a.key != null) return cookies ? cookies.get(a.key) : '';
    return cookies ? cookies.header() : '';
  }
  /**
   * **类CA（2026-10-26）worker 的 `cookie.setCookie` / `replaceCookie` / `removeCookie`**。
   *
   * 背景（实测 📂笔趣阁·恋爱呀）：源脚本先 `java.ajax(host)` 拿到 WAF 挑战页里的
   * `var token='…'`，再 `cookie.setCookie(host, 'waf_challenge=' + token)` 重试请求。
   * 上游 `CookieStore.setCookie` 写的是**按源持久 CookieStore**（`AnalyzeRule` 的
   * `cookie` 就是它）⇒ 之后任何请求都带得上。
   *
   * 我们的 worker 侧 `cookie` 只是一个**与该 worker 同生死的本地 Map**，
   * 既不影响宿主发出的请求（引擎注入头读的是 `ctx.cookies`），
   * 也不跨 eval 存活 ⇒ `setCookie` 等于**静默 no-op**（Proxy 兜底 `() => ''`）。
   * 结果：设了 waf_challenge 也没带上 → 第二次请求还是 503 → 搜索 0 条。
   *
   * 判据/落点与 L1 的 `makeCookieStub` 完全一致：解析用 `parseCookiePairs`（唯一实现），
   * 落点是源级 CookieStore（`removeCookie` = 整清，与 L1 同语义）。
   */
  if (method === 'cookieSet') {
    const a = (args ?? {}) as { cookie?: unknown };
    for (const [k, v] of parseCookiePairs(a.cookie)) cookies?.set(k, v);
    return '';
  }
  if (method === 'cookieRemoveKey') {
    const a = (args ?? {}) as { key?: unknown };
    cookies?.remove?.(String(a.key ?? ''));
    return '';
  }
  if (method === 'cookieClear') {
    cookies?.clear?.();
    return '';
  }
  /**
   * `#410` worker 的 `cookie.setWebCookie(url, cookie)` —— 回宿主写**源级 CookieStore**
   * （与 L1 的 `makeCookieStub.setWebCookie` **同一判据 + 同一落点**；判据实现在
   * `selector/web-cookie.ts`，此处只负责写）。
   */
  if (method === 'cookieSetWeb') {
    const a = (args ?? {}) as { url?: unknown; cookie?: unknown };
    const r = applyWebCookie(cookies, a.url, a.cookie);
    if (!r.ok) {
      cookieWarn(`setweb-rpc:${r.reason}`,
        `cookie.setWebCookie 已忽略（${r.reason === 'BAD_URL' ? 'url 解析不出主机名' : 'cookie 为空'}）：url=${String(a.url ?? '').slice(0, 100)}`);
    }
    return '';
  }
  /**
   * org.jsoup 桥（Phase 0.1）：worker 里的 `Jsoup.parse(html).select(sel)` 经此回宿主求值。
   *
   * 为什么走 RPC：DOM 后端（jsdom）只在宿主可用，而 `jsoupSelect` 的产出**本就是可序列化 POJO**
   * （`{outerHTML, innerHTML, text, attrs}`，见 makeElementList），回传零损失，
   * 且与 L1 共用同一份实现 → **语义完全一致**，不会引入兼容性差异。
   *
   * 这一桥的意义：把「用 jsoup 又发 java.ajax」的源（语料里 25 个）从 L1 挪进 worker，
   * 于是 java.ajax 走异步 RPC，不再用 execFileSync 阻塞事件循环。
   */
  /**
   * `#333` worker 的 jsoup 全部走这里 —— **同一个 `JsoupDom` 实例**（活节点在宿主）：
   * worker 只拿到 nid，读写删都回到上面那份唯一实现，与 L1 零漂移。
   *
   * 兼容：规则桥（`java.getElements`）产出的描述符**没有 nid** ⇒ 退化成旧的「按 html 文本 select」
   * （`jsoupSelect`），保持 `#108` 以来 worker 侧的行为不变。
   */
  if (method === 'dom') {
    /**
     * `#743` A 轮：DOM 后端已搬常驻 worker（唯一实现在 `dom-rpc.ts`）。
     *
     * ⚠️ **同一个求值器的全部 op 必须打到同一个 `JsoupDom`**（`nid` 是活节点身份）。
     * 所以这里不做「5 个 op 转发、其余回落」的拆分 —— 拆表会让 `remove/append/clone`
     * 拿到陌生 nid，直接违反 `#333` 铁律。第一批 5 个 op（parse/select/html/text/attr）
     * 是**验收与回归范围**，不是路由范围；其余 op 已在同一 worker 路径上，专项回归锁排第二批。
     *
     * 无 backend（`YUEDU_DOM_WORKER=0` / worker 起不来）时保持旧行为：宿主同步执行。
     */
    if (domClient) {
      const a = (args ?? {}) as { op?: string; sel?: string };
      const t0 = Date.now();
      try {
        return await domClient.call(args);
      } finally {
        // 只量**异步等待**；`dom-select` 只保留给宿主回落路径，避免污染「主线程阻塞」口径
        recordBlock('dom-async', Date.now() - t0, `${String(a.op ?? '')} ${String(a.sel ?? '')}`);
      }
    }
    return handleDomCall(dom, args);
  }
  if (method === 'bitmap') {
    const a = (args ?? {}) as {
      op?: string;
      id?: number;
      src?: number;
      dst?: number;
      bytes?: Uint8Array;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      left?: number;
      top?: number;
      color?: number;
      format?: string;
      quality?: number;
      // `#587` 六参 drawBitmap 的区域坐标（src/dst 各四个）
      sl?: number;
      st?: number;
      sr?: number;
      sb?: number;
      dl?: number;
      dt?: number;
      dr?: number;
      db?: number;
      /** `#537` ② 同帧合并的免回复 op 列表 */
      ops?: BitmapNoReplyOp[];
    };
    const t0 = Date.now();
    const op = String(a.op ?? '');
    try {
      const gfx = androidGfx();
      const BitmapApi = gfx['Bitmap'] as { createBitmap: (...args: unknown[]) => AndroidBitmap };
      const CanvasCtor = gfx['Canvas'] as new (t: unknown) => {
        drawBitmap: (...args: unknown[]) => void;
        drawColor: (c: unknown) => void;
      };
      const Factory = gfx['BitmapFactory'] as {
        decodeByteArray: (b: Uint8Array, o: number, l: number) => AndroidBitmap;
      };
      /**
       * `#537` ② 免回复 op 执行器：worker 把同一次求值里的 draw/drawRegion/fill/release
       * 合并成一条 `op:'batch'` 消息，宿主按数组顺序落地。worker 在「触碰同句柄的同步 RPC」
       * 之前冲洗相关 op，所以可见性与逐条下发完全相同。
       */
      const applyBitmapOp = (one: BitmapNoReplyOp): void => {
        const oneOp = String(one.op ?? '');
        if (oneOp === 'draw') {
          new CanvasCtor(bitmapGet(one.dst)).drawBitmap(bitmapGet(one.src), Number(one.left) || 0, Number(one.top) || 0, null);
          return;
        }
        if (oneOp === 'drawRegion') {
          new CanvasCtor(bitmapGet(one.dst)).drawBitmap(
            bitmapGet(one.src),
            { left: Number(one.sl) || 0, top: Number(one.st) || 0, right: Number(one.sr) || 0, bottom: Number(one.sb) || 0 },
            { left: Number(one.dl) || 0, top: Number(one.dt) || 0, right: Number(one.dr) || 0, bottom: Number(one.db) || 0 },
            null,
          );
          return;
        }
        if (oneOp === 'fill') {
          new CanvasCtor(bitmapGet(one.id)).drawColor(one.color);
          return;
        }
        if (oneOp === 'release') {
          const h = bitmapHandles.get(Number(one.id));
          if (h) {
            bitmapHandleBytes -= h.b.data.length;
            bitmapHandles.delete(Number(one.id));
          }
          return;
        }
        throw new Error(`bitmap batch: 不支持的免回复 op「${oneOp}」`);
      };
      if (op === 'decode') {
        const bytes = a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(0);
        return bitmapHold(Factory.decodeByteArray(bytes, 0, bytes.length));
      }
      if (op === 'create') return bitmapHold(BitmapApi.createBitmap(Number(a.w) || 0, Number(a.h) || 0, 'ARGB_8888'));
      if (op === 'crop') {
        return bitmapHold(
          BitmapApi.createBitmap(bitmapGet(a.src), Number(a.x) || 0, Number(a.y) || 0, Number(a.w) || 0, Number(a.h) || 0),
        );
      }
      // `#537` ② 同帧合并包：按数组顺序落地（数组顺序 = 脚本调用顺序）
      if (op === 'batch') {
        const list = Array.isArray(a.ops) ? a.ops : [];
        for (const one of list) applyBitmapOp(one);
        return '';
      }
      if (op === 'draw' || op === 'drawRegion' || op === 'fill' || op === 'release') {
        applyBitmapOp(a);
        return '';
      }
      if (op === 'compress') {
        let out: Uint8Array = new Uint8Array(0);
        bitmapGet(a.id).compress(a.format ?? 'PNG', a.quality ?? 100, {
          write: (b: unknown) => {
            out = b instanceof Uint8Array ? b : new Uint8Array(0);
          },
        });
        // `#537` ③：大图走二进制（SAB status=3，免 base64/JSON 化），小图保留 base64 JSON 原路。
        // 容量判定归 worker-pool：超过单片容量时 sabReplyRaw 自动退回 base64 JSON（分片通道）。
        return out.length >= bitmapBinaryMinBytes()
          ? { [RAW_REPLY_FIELD]: out }
          : { b64: Buffer.from(out).toString('base64') };
      }
      throw new Error(`bitmap: 未知 op「${op}」`);
    } finally {
      // 解码/编码是同步 CPU —— 埋点进 block-stats，否则 stall 追因时看不见它
      recordBlock(`bitmap-${op || '?'}`, Date.now() - t0, `${String(a.format ?? '')} ${Number(a.w) || 0}x${Number(a.h) || 0}`);
    }
  }
  if (method === 'render') {
    const a = (args ?? {}) as { url: string; js?: string; kind?: 'show' | 'cookie' };
    if (renderer) {
      try {
        return {
          body: await renderer(a.url, {
            ...(a.js ? { js: a.js } : {}),
            ...(a.kind ? { kind: a.kind } : {}),
          }),
          headers: {},
          code: 200,
        };
      } catch (e) {
        /**
         * `#731` **`kind='cookie'` 不许静默回落**：`startBrowserAwait` / `webView` 的脚本在等
         * 浏览器里的结果，宿主建不出会话时必须把明确错误抛给脚本 —— 旧实现回落静态抓取
         * 或给空串，脚本在空文档上继续跑，用户只看到「验证会话已结束或浏览器不可用」。
         */
        if (a.kind === 'cookie') throw e instanceof Error ? e : new Error(String(e));
        // `#580` 其它渲染失败 ⇒ 落到下面的静态抓取，不要直接给空文档
      }
    }
    // 无渲染器 / 渲染失败：降级静态抓取（复用 http 分支语义）；裸 JSON 按浏览器形态包成 <pre>
    const r = (await hostRpc(evalRule, 'http', { url: a.url })) as { body?: unknown; headers?: Record<string, string>; code?: number } | null;
    return {
      body: asWebViewDocument(typeof r?.body === 'string' ? r.body : String(r?.body ?? '')),
      headers: r?.headers ?? {},
      code: r?.code ?? 0,
    };
  }
  /**
   * `#676` worker 的 `java.webView(html, url, js)` → 宿主异步执行（三段 CDP），返回脚本结果。
   *
   * worker 里这个调用是**同步**的（`Atomics.wait` 等宿主回信），所以脚本语义不变；
   * 宿主这边必须是异步 —— CDP 的 navigate/evaluate 没有同步版本。
   */
  if (method === 'renderHtmlJs') {
    const a = (args ?? {}) as { html?: string; base?: string; js?: string };
    if (!renderHtmlJsAsync) return { text: '' };
    try {
      const text = await renderHtmlJsAsync(String(a.html ?? ''), String(a.base ?? ''), String(a.js ?? ''));
      return { text };
    } catch {
      return { text: '' };
    }
  }
  // java.webViewGetSource → 渲染 + js 注入 + sourceRegex 取资源 URL（Legado JsExtensions.kt:261-289）
  if (method === 'renderSource') {
    const a = (args ?? {}) as { url?: string; js?: string; sourceRegex?: string };
    if (renderer && a.url) {
      try {
        const body = await renderer(a.url, {
          ...(a.js ? { js: a.js } : {}),
          ...(a.sourceRegex ? { sourceRegex: a.sourceRegex } : {}),
        });
        return { body, headers: {}, code: body ? 200 : 0 };
      } catch {
        return { body: '', headers: {}, code: 0 };
      }
    }
    return { body: '', headers: {}, code: 0 };
  }
  if (method === 'http') {
    const a = (args ?? {}) as {
      url: string;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      /** `#387c`：worker 侧 `java.get/post` 要求不跟随重定向（上游 followRedirects(false)） */
      noRedirect?: boolean;
      /** `#538`：okhttp3 桥的原始字节模式（arrayBuffer + base64 回传，绕开 utf8 解码） */
      raw?: boolean;
      /**
       * `#636` 第二层：**本次请求的超时**（毫秒）。不给则按方法取默认（见下）。
       * 由宿主内部调用点（`importScript`/`cacheFile` 的重试循环）传入
       * —— worker 里的 `java.ajax/head` 等仍走默认，行为不变。
       */
      timeoutMs?: number;
      /** `#742` worker 侧 `java.ajax` 的 URL 选项 `dnsIp`（IP 直连） */
      dnsIp?: string;
    };
    const controller = new AbortController();
    /**
     * 宿主侧 http rpc 的超时（`#606` 第 3 层，2026-10-24）：**60s，对齐上游 okHttp**
     * （`HttpHelper.kt:61-62` 的 `readTimeout(60)/callTimeout(60)`；原本写 8s）。
     *
     * 为什么 8s 不够：qyyuapi 系的大体积 js（`common.js` 180KB / `de.js`）在本机网络下
     * 实测要 25~30s 才吐完 ⇒ 8s 必判死 ⇒ `java.importScript` 拿到空 ⇒
     * `Reload(...) 内容获取失败或者为空`（G站/MYCOMIC/包子漫画）。
     *
     * 为什么不担心撑爆 worker 的 eval 预算：宿主 RPC 期间 worker 侧会**暂停计时**并把
     * 耗时「还」给预算（`worker-pool.ts` 的 `beginHostWork/endHostWork`），
     * 所以这里等多久都不会让 eval 误报 `JS_TIMEOUT`。
     *
     * ★ `#636` 两处收敛：
     *  · 调用方显式给了 `timeoutMs` ⇒ 用它（重试循环按剩余预算收窄每次尝试）；
     *  · **HEAD 默认 15s**（不是 60s）：HEAD 没有响应体，60s 只可能是「站点吊住」。
     *    实测 `HEAD …/loginUrl.js` 一次 **25s 未返回**，而 `Reload()` 每次都会先 HEAD 拿 etag
     *    ⇒ 60s 默认会让一次规则求值卡满一分钟。15s 与 **L1 侧 `java.head` 的实际默认**
     *    （`SYNC_HTTP_TIMEOUT_DEFAULT_MS`）一致，顺带消掉两个路由的超时漂移。
     */
    const hostTimeoutMs = ((): number => {
      const explicit = Number(a.timeoutMs);
      if (Number.isFinite(explicit) && explicit > 0) return Math.max(1_000, Math.min(180_000, explicit));
      return a.method === 'HEAD' ? 8_000 : 60_000;
    })();
    /**
     * `#636` 第二层 **HEAD 失败负缓存**（`YUEDU_HEAD_FAIL_TTL_MS`，默认 120s，0 = 关闭）。
     *
     * 为什么必须有：`Reload()`（源作者写在 jsLib 里的公共函数）每次都会先 `java.head(url)` 拿 etag，
     * 而**只有成功才会 `cache.put('etagtime…')`** —— 失败时那条 10 分钟的保护根本不生效
     * ⇒ 一次失败就变成「每次 eval 都重打一次 HEAD」。实测（包子漫画一次搜索）：
     * 4 个 `Reload` ⇒ 4 次 HEAD，其中挂住的每次吃掉 8~15s，占了整请求 61s 的绝大部分；
     * 而 HEAD 拿到的 etag 在本仓**根本没用**（我们的传输不做 `If-None-Match` 重验）。
     *
     * 语义安全性：HEAD 失败现在的返回本来就是 `{body:'', headers:{}, code:0}`（不抛），
     * 调用方已经把「空响应」当失败处理；这里只是把**同一个失败**在 2 分钟内快返回，
     * 不改变任何分支判定，只省掉重复的网络等待。
     */
    if (a.method === 'HEAD') {
      /**
       * `#732` **网络优先**：不再先读镜像；只有「网络已被判死（负缓存）」时才用镜像 etag 兜底，
       * 没有镜像才回 `code 0`（调用方本来就把空响应当失败）。
       */
      const failedAt = headFailAt.get(String(a.url ?? ''));
      if (failedAt !== undefined && Date.now() - failedAt < HEAD_FAIL_TTL_MS) {
        return mirrorHeadFallback(String(a.url ?? '')) ?? { body: '', headers: {}, code: 0 };
      }
    }
    const timer = setTimeout(() => controller.abort(), hostTimeoutMs);
    // 源级默认头（源 header 规则 + 登录头）为基底；worker 传来的 URL 自带头覆盖同名项；
    // Cookie 从源 CookieStore 补（worker 里拿不到宿主 cookie jar）。
    const merged: Record<string, string> = { ...(defaultHeaders?.(String(a.url)) ?? {}), ...(a.headers ?? {}) };
    // 源 CookieStore 的会话 Cookie 补进来（worker 里拿不到宿主 cookie jar）；
    // 与 L1 的 `baseHeaders` **同一份判据**：空值 Cookie 头不得遮蔽真会话（`D11` 的前置条件）。
    applySessionCookie(merged, cookies?.header() ?? '');
    const httpMethod: 'GET' | 'POST' | 'HEAD' =
      a.method === 'HEAD' ? 'HEAD' : a.body ? 'POST' : 'GET';
    /**
     * **POST 表单体编码**（与 L1 的 `syncHttp` 用**同一份** `withFormEncodedBody`，防两条路径漂移）。
     *
     * 这条分支是 worker 侧 `java.ajax/post/ajaxAll` 的**唯一出口**（worker 里
     * `httpRpcSpec` → `rpc('http', …)` → 这里），所以只需在此处理一次。
     * 修的是用户实测 ③：⚡📂️独阅读网 `secret_content=<base64>` 里的 `+` 被 form 语义解成空格
     * ⇒ 站点 AES 解不开 ⇒ `{"code":"200001","tip":"缺少参数"}`。
     */
    const formPrepared = withFormEncodedBody(httpMethod, a.body, merged);
    const reqBody = formPrepared.body;
    const reqHeaders = formPrepared.headers;
    /**
     * `#742` worker 侧 `java.ajax` 的 URL 选项 `dnsIp`（IP 直连）：
     *  · 注入了 HttpClient ⇒ 把 `dnsIp` 透给注入层，由 `net/index` 的**唯一消费点**处理；
     *  · 直走全局 fetch（探针/未注入）⇒ 这里自建 dispatcher，保证两条路不分叉。
     */
    const dnsIp = typeof a.dnsIp === 'string' ? String(a.dnsIp).trim() : '';
    const dnsInit = dnsIp ? dnsIpFetchInit(String(a.url), dnsIp) : {};
    /**
     * `#538` **原始字节模式**（okhttp3 桥 `body().bytes()` 显式开启）：绕开 utf8 文本解码，
     * 以 base64 回传**真实字节** —— 阅文集团正文密文是二进制帧（8B 头 + 16B 尾），
     * utf8 往返会把 ≥0x80 的字节熔成 U+FFFD ⇒ 解密必失败。
     * ⚠️ 只被 okhttp3 桥开启（`raw: true`）；其余路径逐字不走这里（含闸页过闸）。
     * ⚠️ 直走全局 fetch（注入的 HttpClient 只有字符串面）⇒ 无代理/落盘加持，已文档化。
     */
    if (a.raw) {
      const resp = await fetch(a.url, {
        method: httpMethod === 'HEAD' ? 'HEAD' : httpMethod,
        headers: reqHeaders,
        /**
         * `#742` `dnsIp` 直连（只换地址，Host/SNI 不变）；`dnsInit` 为空对象时与从前完全一致
         */
        ...dnsInit,
        // ⚠️ 空串 body 必须转 undefined：undici 对 GET/HEAD + body('') 直接抛
        // 「Request with GET/HEAD method cannot have body」（本分支直走全局 fetch，无注入客户端兜底）
        body: reqBody ? reqBody : undefined,
        redirect: a.noRedirect ? 'manual' : 'follow',
        signal: controller.signal,
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const rawHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => { rawHeaders[k.toLowerCase()] = v; });
      return { code: resp.status, headers: rawHeaders, bodyB64: buf.toString('base64') };
    }
    /**
     * `YUEDU_DEBUG_DETAIL=1` 时打印 worker 侧 `java.ajax` 的**实际请求**。
     *
     * 为什么需要：worker 的 `java.ajax` 走这条 `hostRpc('http')` 分支，**不经过引擎的
     * `ctx.http`**（见下方 `http` 选项与 `fetch` 分支），所以外层的探针/日志**看不到**它 ——
     * 排查「init 里 java.ajax 拿到的是站点错误页」时，看不到 URL 就只能猜。
     * 只打印 **header 的键名**（不打值），避免把 token 写进日志。
     */
    if (process.env['YUEDU_DEBUG_DETAIL']) {
      // eslint-disable-next-line no-console
      console.log(
        `[ajax] ${httpMethod} ${String(a.url).slice(0, 140)} | hdr=[${Object.keys(reqHeaders).join(',')}]` +
          `${a.body ? ` | body=${String(reqBody).slice(0, 60)}` : ''}`,
      );
    }
    try {
      // 宿主注入了 HttpClient 就走它（拿代理/超时/UA/Cookie 落盘/mock 的全部好处）
      /**
       * `YUEDU_DEBUG_DETAIL=1`：打印 `java.ajax` 的**响应**头部（状态 + 前 120 字）。
       * 只有请求留痕时，「站点回了错误信封 / 回了空」这类失败仍然看不到原因
       * （实测 ① 宜搜小说：请求 URL 看起来正常，但站点回 `非法身份` —— 必须看到响应才能定案）。
       */
      const logResp = (code: number, body: unknown): void => {
        if (!process.env['YUEDU_DEBUG_DETAIL']) return;
        // eslint-disable-next-line no-console
        console.log(`[ajax] ← ${code} len=${String(body ?? '').length} | ${String(body ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
      };
      /** 首次请求：注入了 HttpClient 就走它，否则全局 fetch */
      const first = await (async (): Promise<{ body: string; headers: Record<string, string>; code: number }> => {
        if (http) {
          const r = await http({
            method: httpMethod,
            url: a.url,
            ...(reqBody ? { body: reqBody } : {}),
            headers: reqHeaders,
            ...(dnsIp ? { dnsIp } : {}),
            // `#387c`：worker 的 java.get/post 要求「js 自己拦截 3xx」⇒ 透传 manual
            ...(a.noRedirect ? { redirect: 'manual' as const } : {}),
            // `#636`：把本分支算好的超时透给注入层（否则它按「剩余行动预算」给，能到 52s）
            timeout: hostTimeoutMs,
          });
          logResp(r.status, r.body);
          return { body: String(r.body ?? ''), headers: r.headers, code: r.status };
        }
        const resp = await fetch(a.url, {
          method: httpMethod === 'HEAD' ? 'HEAD' : httpMethod,
          headers: reqHeaders,
          /** `#742`：同上，未注入 HttpClient 时的 fetch 回退也要走 IP 直连 */
          ...dnsInit,
          /**
           * `#636` **空串 body 必须转 undefined**：undici 对 `GET/HEAD + body('')` 直接抛
           * 「Request with GET/HEAD method cannot have body」。
           * 实测（本轮探针）：`Reload()` 的 `java.head(url)` 在这条 fetch 回退路上 100% 抛，
           * 于是每次 HEAD 都白跑一次（引擎路径走注入 HttpClient，受不到影响 —— 但探针/单测/
           * 未注入 http 的调用点会）。`a.raw` 分支早就有这个保护（见上），此处补齐。
           */
          body: reqBody ? reqBody : undefined,
          // `#387c`：`manual` 在 Node/undici 下**保留真实 3xx 状态码与 Location**（实测 301 + location），
          //   与 `java.ajax` 的 `follow` 语义分开 —— 前者要脚本自己处理跳转，后者要最终页面。
          redirect: a.noRedirect ? 'manual' : 'follow',
          signal: controller.signal,
        });
        const body = await resp.text();
        logResp(resp.status, body);
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        return { body, headers, code: resp.status };
      })();
      /**
       * `D11`（B 半）闸页静默过闸 —— 与 L1 的 `syncHttp` **同序**，判据唯一实现见 `net/gate-pass.ts`。
       * 过闸目标响应的 Set-Cookie 由注入的 HttpClient（引擎的 `http` 包装）harvest 进源 CookieStore；
       * 重放前重算请求头并用 `applySessionCookie` 把新会话带上去（源 header 规则里的空 Cookie 不遮蔽）。
       */
      if (httpMethod === 'GET') {
        const gate = planAgeGatePass(first.body, a.url);
        if (gate) {
          const once = async (u: string, hdrs: Record<string, string>) => {
            if (http) {
              // `#636`：过闸重放同样是「本分支的请求」，超时延用 hostTimeoutMs
              const r = await http({ method: 'GET', url: u, headers: hdrs, timeout: hostTimeoutMs, ...(dnsIp ? { dnsIp } : {}) });
              logResp(r.status, r.body);
              return { body: String(r.body ?? ''), headers: r.headers, code: r.status };
            }
            const resp = await fetch(u, { method: 'GET', headers: hdrs, redirect: a.noRedirect ? 'manual' : 'follow', signal: controller.signal, ...(dnsIp ? dnsIpFetchInit(u, dnsIp) : {}) });
            const body = await resp.text();
            logResp(resp.status, body);
            const h: Record<string, string> = {};
            resp.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
            return { body, headers: h, code: resp.status };
          };
          await once(gate.target, reqHeaders);
          const replayHeaders: Record<string, string> = { ...(defaultHeaders?.(String(a.url)) ?? {}), ...(a.headers ?? {}) };
          applySessionCookie(replayHeaders, cookies?.header() ?? '');
          const replay = await once(String(a.url), replayHeaders);
          // 「重放仍是闸页」也算失败（否则会把闸页当成功结果交给规则 ⇒ 列表 0 条）
          if (replay.body.trim() && !planAgeGatePass(replay.body, String(a.url))) {
            gateWarn(`ok:${String(a.url).slice(0, 100)}`, `已静默过闸（年满18岁声明页 → ${gate.target}）并重放成功：${String(a.url).slice(0, 120)}`);
            return replay;
          }
          gateWarn(
            `fail:${String(a.url).slice(0, 100)}`,
            `识别到闸页但重放仍为空（过闸目标 ${gate.target}）⇒ 请用「登录窗口」人工过闸后再刷新：${String(a.url).slice(0, 120)}`,
          );
        }
      }
      // `#636`：HEAD 的成败都要维护负缓存 —— 拿到站点真实回答（任何状态码）就清掉失败记录，
      // 只在「传输层失败（code 0 / 超时）」时记，2 分钟内不再重打（见 headFailAt 注释）。
      if (a.method === 'HEAD' && HEAD_FAIL_TTL_MS > 0) {
        const key = String(a.url ?? '');
        if (Number(first.code) > 0) headFailAt.delete(key);
        else {
          if (headFailAt.size > 500) headFailAt.clear();
          headFailAt.set(key, Date.now());
        }
      }
      // `#732` HEAD 传输层失败（code 0）⇒ 镜像 etag 兜底；没有镜像就保持原语义（code 0）
      if (a.method === 'HEAD' && Number(first.code) === 0) {
        const fallback = mirrorHeadFallback(String(a.url ?? ''));
        if (fallback) return fallback;
      }
      return first;
    } catch (e) {
      /**
       * 网络失败 → 空 body（对齐 L1 容错语义），但**不再静默**（`#606`，2026-10-24）。
       *
       * 为什么必须留痕：这条分支是 worker 侧 `java.ajax` / `java.importScript` 的**唯一出口**，
       * 它把异常压成 `body:''` 后，上层只能看到「内容获取失败或者为空」/「解析 0 条」这类
       * 二次症状 —— 排查 jsLib 拉不到时完全看不到「是超时、DNS 还是 TLS」（`#606` 卡了很久）。
       * 每个 URL 只报一次（批量时同一地址会请求多次）。
       */
      const key = String(a.url ?? '');
      // `#636`：超时/DNS 失败同样记入 HEAD 负缓存（`Reload` 的 etag 探测失败后会每次重打）
      if (a.method === 'HEAD' && HEAD_FAIL_TTL_MS > 0) {
        if (headFailAt.size > 500) headFailAt.clear();
        headFailAt.set(key, Date.now());
      }
      if (!hostHttpFailWarned.has(key)) {
        if (hostHttpFailWarned.size > 200) hostHttpFailWarned.clear();
        hostHttpFailWarned.add(key);
        // eslint-disable-next-line no-console
        console.warn(
          `[rpc-http] ⚠️ ${httpMethod} ${key.slice(0, 140)} 失败（已按空 body 继续）：${summarizeHttpError(e)}`,
        );
      }
      // `#732` HEAD 异常 ⇒ 镜像 etag 兜底（没有镜像才回空 body）
      if (a.method === 'HEAD') {
        const fallback = mirrorHeadFallback(key);
        if (fallback) return fallback;
      }
      return { body: '', headers: {}, code: 0 }; // 对齐 L1 容错语义：网络失败 → 空 body
    } finally {
      clearTimeout(timer);
    }
  }
  if (method === 'evalRule') {
    const a = (args ?? {}) as { rule?: string; value?: unknown };
    return evalRule ? evalRule(String(a.rule ?? ''), a.value) : '';
  }
  // —— 重建在 worker 里的 source 活对象（见 worker-pool 的 __yueduPrepareBindings）——
  if (method === 'sourceCall') {
    const a = (args ?? {}) as { m?: string; args?: unknown[] };
    const s = sourceStub as Record<string, unknown> | undefined;
    const fn = s?.[String(a.m ?? '')];
    if (typeof fn !== 'function') return '';
    try {
      const out = (fn as (...x: unknown[]) => unknown)(...(a.args ?? []));
      // Legado `getLoginInfoMap()` 返回 Java Map（不可 JSON 序列化）→ 转纯对象，worker 侧再包 .get()
      if (out instanceof Map) return Object.fromEntries(out as Map<string, string>);
      if (out === undefined) return '';
      return typeof out === 'object' ? JSON.parse(JSON.stringify(out)) : out;
    } catch {
      return '';
    }
  }
  // —— worker 里 infoMap 的写入回流到宿主那份持久 Map ——
  if (method === 'infoMapSet') {
    const a = (args ?? {}) as { k?: string; v?: unknown };
    if (infoMap && a.k !== undefined) infoMap.set(String(a.k), String(a.v ?? ''));
    return '';
  }
  if (method === 'infoMapRemove') {
    const a = (args ?? {}) as { k?: string };
    if (infoMap && a.k !== undefined) infoMap.delete(String(a.k));
    return '';
  }
  /**
   * `#672` **worker 侧 `infoMap.save()/saveNow()`**（上游 `InfoMap.kt:26-34`）。
   *
   * 上游 `save()` 只置 `needSave` 标志、真正落盘在 `ExploreAdapter.kt:685`；我们这边宿主 Map
   * 本就是同一份（写入即时生效），落盘时机由调用方（引擎的 explore 段）在求值后比对快照决定。
   * 所以这里**只需吃掉这次 RPC**（不报「未知方法」），不做额外动作。
   */
  if (method === 'infoMapSave') {
    return '';
  }
  // —— worker 的 this.getHeaderMap() / java.getHeaderMap() 取源级请求头（与 L1 同面）——
  if (method === 'getSourceHeaders') {
    return defaultHeaders?.() ?? {};
  }
  // —— worker 的 java.put / java.get(key) 回流宿主变量作用域（与 L1 同语义）——
  if (method === 'javaVarGet') {
    const a = (args ?? {}) as { k?: unknown };
    return javaScope ? javaScope.read(String(a.k ?? '')) : '';
  }
  if (method === 'javaVarPut') {
    const a = (args ?? {}) as { k?: unknown; v?: unknown };
    javaScope?.put?.(String(a.k ?? ''), String(a.v ?? ''));
    return '';
  }
  /**
   * `#613`/`#615` —— worker 的**新文件面**（`getFile`/`readFile`/`getTxtInFolder`/
   * `unzipFile`/`getZip*Content`）回流宿主 —— 与 `downloadFile` 同手法（判据全在宿主，
   * worker 只搬运参数），宿主实现见 `selector/java-file.ts`。
   *
   * ⚠️ `getFile` 在 L1 返回的是**带方法的 File 形态对象**，**不可结构化克隆**（postMessage 传不过去）
   * ⇒ worker 路径退化成「绝对路径字符串」（等价 `String(f)`）；`f.getAbsolutePath()` 这类调用
   * 在 worker 里拿不到。语料 0 命中（口径见 `java-file.ts` 头注），故接受这个退化并写明。
   */
  if (
    method === 'getFile' ||
    method === 'readFile' ||
    method === 'getTxtInFolder' ||
    method === 'unzipFile' ||
    method === 'unArchiveFile' ||
    method === 'un7zFile' ||
    method === 'unrarFile' ||
    method === 'getZipStringContent' ||
    method === 'getZipByteArrayContent'
  ) {
    const a = (args ?? {}) as { path?: unknown; url?: unknown; charset?: unknown };
    const impl = javaScope as Record<string, unknown> | undefined;
    const fn = impl?.[method];
    if (typeof fn !== 'function') return method === 'readFile' || method === 'getZipByteArrayContent' ? null : '';
    try {
      if (method === 'getFile') {
        const f = (fn as (p: unknown) => { getAbsolutePath?: () => string })(a.path);
        return String(f?.getAbsolutePath?.() ?? '');
      }
      if (method === 'getZipStringContent') {
        return (fn as (u: unknown, p: unknown, c?: unknown) => string)(a.url, a.path, a.charset);
      }
      if (method === 'getZipByteArrayContent') {
        return (fn as (u: unknown, p: unknown) => Uint8Array | null)(a.url, a.path);
      }
      return (fn as (p: unknown) => unknown)(a.path);
    } catch (e) {
      fileWarn(`worker:${method}`, `java.${method} 失败：${e instanceof Error ? e.message : String(e)}`);
      return method === 'readFile' || method === 'getZipByteArrayContent' ? null : '';
    }
  }
  /**
   * `#614` —— worker 的 `java.queryTTF / queryBase64TTF / replaceFont`。
   *
   * 为什么整个落到宿主：TTF 解析在 `core/font/ttf.ts`（几百行），**不可能**塞进 worker 模板串；
   * 而且解析结果（字形映射表）是几万个键的对象，逐次回传比解析本身还贵。
   * 所以 worker 拿到的是**句柄** `{__ttfId}`（与 `#613` 的 `getFile` 退化成路径字符串同一手法，
   * 都已在本文件头注 §「worker 侧退化」里写明）。两次调用之间句柄在宿主侧存活：
   *  · `queryTTF(...)` → 句柄；`replaceFont(text, err, corr, filter)` → 宿主按 id 取回真对象。
   *
   * ⚠️ 句柄有上限（16 只）：一次求值里字体不会更多；超了按插入序淘汰最早的
   * （那只字体已被替换过的文本不会再用到，淘汰后若还来 `replaceFont` 会退化成「原样返回」）。
   */
  if (method === 'queryTTF' || method === 'queryBase64TTF') {
    const a = (args ?? {}) as { data?: unknown; useCache?: unknown };
    const q = queryTtfOf(a.data, a.useCache !== false && a.useCache !== 'false', {
      ...(defaultHeaders ? { baseHeaders: (u?: string) => defaultHeaders?.(u) ?? {} } : {}),
    });
    if (!q) return null;
    const id = `ttf${++ttfHandleSeq}`;
    ttfHandles.set(id, q);
    if (ttfHandles.size > TTF_HANDLE_MAX) {
      const oldest = ttfHandles.keys().next().value;
      if (oldest !== undefined) ttfHandles.delete(oldest);
    }
    return { __ttfId: id };
  }
  if (method === 'replaceFont') {
    const a = (args ?? {}) as { text?: unknown; errId?: unknown; corrId?: unknown; filter?: unknown };
    const err = ttfHandles.get(String(a.errId ?? '')) ?? null;
    const corr = ttfHandles.get(String(a.corrId ?? '')) ?? null;
    return replaceFontImpl(String(a.text ?? ''), err, corr, a.filter === true || a.filter === 'true');
  }
  /**
   * `#411` —— worker 的 `java.importScript / cacheFile / readTxtFile / deleteFile`。
   *
   * 与 L1 的 `makeScriptFileApi` **共用 `selector/js-file.ts` 的四条判据**（键算法 = md5Encode16、
   * 命中即不下载、内容空则不写缓存、importScript 空则抛），且共用 `javaScope.cache` 的**文件层**
   * （同一份按源持久存储）⇒ 一条规则在 worker 里 `importScript` 过，L1 里再读也命中。
   *
   * 传输**复用 `hostRpc('http')`**（递归调用）：源级默认头 / Cookie / 表单体编码 / 超时 / 调试留痕
   * 全部与 `java.ajax` 一致 —— 不另开一条 fetch 通道，避免「同一 URL 两种取法」的漂移。
   */
  if (
    method === 'importScript' ||
    method === 'cacheFile' ||
    method === 'readTxtFile' ||
    method === 'deleteFile' ||
    method === 'downloadFile'
  ) {
    const a = (args ?? {}) as { path?: unknown; url?: unknown; saveTime?: unknown; content?: unknown };
    /**
     * `downloadFile`（`#604`）：worker 里只做参数搬运，**判据全部在宿主**的同名实现里
     * （`makeScriptFileApi.downloadFile`，与 L1 共用 `js-file.ts` 的 type/mime/载荷解码三件套）。
     * 返回值是上游形态的「相对路径」字符串（`<md5Encode16>.<type>`）。
     */
    if (method === 'downloadFile') {
      const dl = javaScope as { downloadFile?: (x: unknown, y?: unknown) => string } | undefined;
      /* 宿主 javaScope 上**没有**单独的 downloadFile 时退回文件层直存（保持可用，不静默返回空） */
      if (typeof dl?.downloadFile === 'function') return dl.downloadFile(a.content, a.url);
      const layerDl = javaScope?.cache;
      const u = String(a.url ?? '');
      const keyDl = fileCacheKey(u);
      const payload = String(a.content ?? '');
      layerDl?.putFile(keyDl, payload, 0);
      return `${keyDl}.${/,\s*\{[\s\S]*"type"\s*:\s*"([^"]+)"/.exec(u)?.[1] ?? 'bin'}`;
    }
    const layer = javaScope?.cache;
    const path = String((method === 'cacheFile' ? a.url : a.path) ?? '');
    if (method === 'deleteFile') return deleteScriptFile(layer, path);
    if (method === 'readTxtFile' || (method === 'importScript' && !/^http/i.test(path))) {
      const text = readScriptFile(layer, fileCacheKey(path)) ?? '';
      if (!text) fileWarn(`read:${path.slice(0, 80)}`, `java.${method}('${path.slice(0, 120)}') 非 URL 分支未命中（本仓无「阅读私有数据目录」）`);
      return method === 'importScript' ? importScriptEnsure(text, path) : text;
    }
    const key = fileCacheKey(path);
    /**
     * `#636` 第二层：**命中即返回；未命中走「重试 + 预算」取数**。
     *
     * 为什么必须重试：源里的 `Reload(url)` 就是 `java.importScript(url)`（见 `jsLib` 里的公共函数），
     * 而这类外链主机慢且抖（实测 GET 中位 ~1s、最坏 9s、偶发整段挂死）。旧实现单次 60s、
     * 失败一次就把 **空串** 交给 `importScriptEnsure` ⇒ 抛 `内容获取失败或者为空` ⇒ 整个源全挂。
     * 现在的判据全在 `js-file.ts` 的 `fetchScriptTextRetry`（唯一实现）：
     * 4xx 不重试、0/5xx/空体重试、单次 20s、总预算 45s。
     *
     * 为什么放在这里而不是改 `Reload`：`Reload` 是源作者写在外链 `jsLib` 里的代码，我们改不到；
     * 但它的下载动作**必须**经过这条宿主 rpc ⇒ 在这一层收口，等于覆盖所有同类源。
     */
    const hit = readScriptFile(layer, key);
    if (hit != null) return method === 'importScript' ? importScriptEnsure(hit, path) : hit;
    /**
     * 镜像已存在时，**网络尝试必须短**（仍保持网络优先，只是不再无限重试）。
     *
     * 现场（`#photo-batch`）：qyyuapi 系一个发现页要 `Reload(loginUrl)` + `Reload(exploreUrl)`
     * 两个外链脚本；旧策略每个 3×20s / 总 45s ⇒ 两个就能吃掉整个 60s 行动预算，
     * 随后源脚本自己的 `java.ajax`（漫画 API）只剩 1s（日志 `请求超时（>1000ms）`）⇒
     * `JSON.parse('')` ⇒ 发现页 0 分类，看起来像「规则写错 / 站点挂了」。
     * 有镜像兜底时把预算收到 2×6s：慢脚本（>6s）直接用镜像，把时间留给真正的业务请求。
     */
    const mirrored = readJsMirror(path, { quiet: true });
    const fetchPolicy = mirrored
      ? { maxAttempts: 2, perAttemptMs: 6_000, totalBudgetMs: 12_000 }
      : SCRIPT_FETCH_POLICY;
    const outcome = await fetchScriptTextRetry(async (timeoutMs): Promise<ScriptFetchAttempt> => {
      const resp = (await hostRpc(
        evalRule,
        'http',
        { url: path, timeoutMs },
        renderer,
        cookies,
        defaultHeaders,
        http,
        sourceStub,
        infoMap,
        javaScope,
        dom,
      )) as { body?: unknown; code?: unknown } | undefined;
      return { text: String(resp?.body ?? ''), code: Number(resp?.code) || 0 };
    }, fetchPolicy);
    if (outcome.text && !isMarkupDocumentBody(outcome.text)) {
      if (outcome.attempts > 1) {
        // eslint-disable-next-line no-console
        console.log(
          `[script] ${method} 第 ${outcome.attempts} 次尝试成功（预算 ${SCRIPT_FETCH_POLICY.totalBudgetMs}ms）：${path.slice(0, 110)}`,
        );
      }
      writeJsMirror(path, outcome.text);
      const text = writeScriptFile(layer, key, outcome.text, toSaveTime(a.saveTime));
      return method === 'importScript' ? importScriptEnsure(text, path) : text;
    }
    // 网络失败 ⇒ 镜像兜底（日志写「兜底 + 原因」，与「走网络成功」一眼可分）
    const failure =
      outcome.failure ||
      (outcome.text && isMarkupDocumentBody(outcome.text) ? '响应是 HTML 文档（非脚本原文）' : '内容为空');
    const mirror = readJsMirror(path, { reason: failure });
    if (mirror) {
      writeScriptFile(layer, key, mirror.text, toSaveTime(a.saveTime));
      return method === 'importScript' ? importScriptEnsure(mirror.text, path) : mirror.text;
    }
    // 两者都失败 ⇒ 连续失败计数（到阈值提示「请手动下载」）+ 明确失败细节
    noteJsMirrorFailure(path, failure);
    const text = writeScriptFile(layer, key, '', toSaveTime(a.saveTime));
    /**
     * 失败细节必须带上去：`第 1 次：HTTP 0 空响应；第 2 次：aborted …` 这种一行就够定位
     * 「超时 / DNS / 404 / 站点回空」，并说明「本地镜像也未命中」，
     * 否则只剩一句「内容获取失败或者为空」（`#636` 的教训）。
     */
    return method === 'importScript' ? importScriptEnsure(text, path, `本地镜像未命中；网络：${failure}`) : text;
  }
  /**
   * —— worker 的 `cache.*` 回流宿主 ——
   *
   * 与 L1 的 `makeCacheStub` **共用 `javaScope.cache`（= makeCacheOps 那一份）**，所以
   * 「带 java.ajax 的规则（走 worker）」与「纯 JS 规则（走 L1）」的 cache 语义完全一致，
   * 且**共用同一份存储** —— 这正是一条规则在 worker 里 `cache.put`、另一条在 L1 里 `cache.get`
   * 也能读到的前提（源里很常见：详情 init 走 L1，目录脚本因带 java.ajax 而走 worker）。
   *
   * ⚠️ 回传走 SAB（4MB，见 `SAB_SIZE`）：`cacheGet` 回传超大字符串会降级为
   * `rpc result exceeds SAB` 错误（**可见**，不是静默空值）。单键 8MB 上限也挡了大部分情况。
   */
  if (method === 'cacheGet' || method === 'cachePut' || method === 'cacheRemove' || method === 'cacheFileGet' || method === 'cacheFilePut' || method === 'memCacheGet' || method === 'memCachePut' || method === 'memCacheRemove') {
    const c = javaScope?.cache;
    if (!c) return null; // 宿主没给 cache 面（旧调用点）→ 未命中语义
    const a = (args ?? {}) as { k?: unknown; v?: unknown; saveTime?: unknown; onlyDisk?: unknown };
    const k = String(a.k ?? '');
    switch (method) {
      case 'cacheGet':
        return c.get(k, Boolean(a.onlyDisk));
      case 'cachePut':
        c.put(k, String(a.v ?? ''), toSaveTime(a.saveTime));
        return a.v == null ? '' : String(a.v);
      case 'cacheRemove':
        c.remove(k);
        return true;
      case 'cacheFileGet':
        return c.getFile(k);
      case 'cacheFilePut':
        c.putFile(k, String(a.v ?? ''), toSaveTime(a.saveTime));
        return a.v == null ? '' : String(a.v);
      case 'memCacheGet':
        return c.memGet(k);
      case 'memCachePut':
        c.memPut(k, String(a.v ?? ''));
        return a.v == null ? '' : String(a.v);
      case 'memCacheRemove':
        c.memRemove(k);
        return true;
      default:
        return null;
    }
  }
  return '';
}

// 描述符键定义在 ./types（避免与本文件的循环依赖）；此处仅转发，便于调用方从 js.ts 取
export { SOURCE_FIELDS_KEY, BOOK_FIELDS_KEY, CHAPTER_FIELDS_KEY, RSS_FIELDS_KEY, INFOMAP_ENTRIES_KEY, INFOMAP_RAW_KEY } from './types';

/**
 * 取对象的**可结构化克隆字段**（丢掉方法/Proxy/类实例）。
 * 用于把 `source` 桩压成能跨 postMessage 的快照。返回 null = 无法安全快照（调用方应回退 L1）。
 */
export function cloneableFieldsOf(src: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!src || typeof src !== 'object') return null;
  let keys: string[];
  try {
    keys = Object.keys(src); // Proxy over function → []（拿不到字段）→ 视为不可快照
  } catch {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    let v: unknown;
    try {
      v = src[k];
    } catch {
      return null;
    }
    if (isCloneable(v)) out[k] = v;
  }
  return out;
}

/**
 * 混合求值器（L4）：
 *  - bindings 全部结构化可克隆（JSON/字符串场景：JSON 路径规则、searchUrl JS 构造等）→ worker 池执行，
 *    worker 内 java.ajax/post/get/webView 经 RPC 回宿主 fetch（异步，主线程零阻塞）；
 *  - 绑定含 DOM/函数（CSS 上下文 JS 规则）→ L1 进程内同步求值（罕见路径）。
 *
 * ⚠️ **性能要点（Phase 0.1）**：L1 的 `java.ajax` 走 `execFileSync`，会**同步阻塞 Node 事件循环**
 * —— 并发一高，请求就在事件循环里排队等 curl，表现为大面积 TIMEOUT（实测并发 2→10 时
 * 发现链正文通过率 27%→4%）。而 worker 内的同步 RPC 用 `Atomics.wait` **只阻塞 worker 线程**，
 * 宿主异步执行后回填，所以只要把「会发 HTTP 的脚本」送进 worker，就能既保持脚本的同步语义、
 * 又解放主线程。为此对 `source` / `infoMap` 这两个不可克隆的绑定做**描述符化**：
 * 传纯字段快照过去，worker 内部重建成「方法齐全、读写经 RPC 回流宿主」的等价对象。
 */
export function createHybridJsEvaluator(opts: HybridEvalOptions): JsEvaluator {
  const l1raw = createJsEvaluator(opts);
  /**
   * **类BZ（2026-10-26）**：`@js:` 返回 `java.util` 集合（`new Packages.java.util.ArrayList()`）
   * 必须按上游 `AnalyzeRule.kt:478` 的 `is List<*>` 语义**展开成数组**，否则整列表塌成 1 个元素
   * （实测 📚海棠搜书 100 章/页 ⇒ 1 章/页、全站目录 0）。判据与实现见
   * `java-bridge.ts#expandJavaCollection`（worker 侧同一份判断在 `__yueduSendable`）。
   */
  const l1: JsEvaluator = (code, bindings) => {
    const r = l1raw(code, bindings);
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      return (r as Promise<unknown>).then(expandJavaCollection);
    }
    return expandJavaCollection(r);
  };
  /**
   * `#656` **快路入口必须透传到包装层**（`#633` 的快路在此之前一直是死的）。
   *
   * `createJsEvaluator` 把 `__yueduFastExpr` 挂在它返回的 `evalFn` 上；这里为了
   * `expandJavaCollection` 又包了一层箭头函数 ⇒ 属性留在 `l1raw` 上、包装层没有。
   * 而下面 `fn` 里的判据是 `(l1 as any).__yueduFastExpr` ⇒ **恒 `undefined`** ⇒ 纯表达式
   * 永远走 worker（实测七猫官方 1695 章目录 `fast=0 worker=1694`，18.7s）。
   *
   * 为什么 `#633` 当初没发现：它的实测（1.15ms 编译 / 0.007ms 命中 / 1.24ms worker）是拿
   * `createJsEvaluator` **单独**跑的，没经过混合求值器 —— 又一次「测的不是生产那条路」。
   */
  {
    const carrier = (l1raw as unknown as { __yueduFastExpr?: (c: string) => FastExprResult }).__yueduFastExpr;
    if (typeof carrier === 'function') {
      (l1 as unknown as { __yueduFastExpr?: (c: string) => FastExprResult }).__yueduFastExpr = carrier;
    }
  }
  const pool = opts.pool?.__yueduWorkerPool ? opts.pool : undefined;
  if (!pool) return l1;
  // `#333`：worker 侧 jsoup 的活节点表（与 L1 每 eval 一份同理，随本求值器生命周期回收）
  const jsoupDom = new JsoupDom();
  /**
   * `#743` A 轮：把这份活节点表搬进常驻 DOM worker（宿主只转发）。
   * 起不来（开关关/入口缺失）时返回 null ⇒ 走 `jsoupDom` 宿主路径，行为不变。
   */
  const domClient = createDomClient();
  /**
   * `#639`：worker 侧把 lib 与 code 拼进同一次 eval（宿主负责拼），所以这里必须用**同一份
   * 兼容处理后的文本** —— 否则 L1 通了、走 worker 的规则照旧 SyntaxError（同一个源两条路两种结果）。
   * memo 按文本命中，重复调用不重复编译检查。
   */
  const lib = opts.lib ? `${relaxLetParamShadow(opts.lib, '源 jsLib(worker)')}\n` : '';
  // 需要 jsoup/DOM API 的脚本（result.toArray()/select()/attr() 等）必须走 L1：
  // worker 内无 jsdom，绑定里的 DOM 桥接对象无法跨 postMessage，字符串 result 也就没有这些 API。
  const DOM_API_RE = /\.(toArray|select|attr|html|text|first|last|children|size|getElements|getElement|getStringList|setContent)\s*\(/;
  /**
   * **在宿主 DOM 绑定上**调 DOM 方法（`$` / `result` / `src` 是「String 包装 + 挂载 jsoup 方法」
   * 或 bridgeDom 的 DOM 桥）——这些对象不可结构化克隆，只能留在 L1。
   *
   * 为什么不能像旧版那样「代码里出现 DOM API 就回 L1」：脚本自己写的
   * `org.jsoup.Jsoup.parse(str).select(...)` 由 worker 的 RPC 桥支持（见 worker-pool 的
   * `__yueduJsoup`），而这类源恰恰是「jsoup + java.ajax」重灾区（语料 25 个）。
   * 旧判定把它们全推回 L1 → java.ajax 走 execFileSync → **事件循环被阻塞 4~9.5s**。
   */
  const DOM_ON_BINDING_RE =
    /(?:\$|result|src|nextChapterUrl)\s*\.\s*(?:toArray|select|attr|html|outerHTML|outerHtml|innerHTML|text|first|last|children|size|getElements|getElement|getStringList|setContent)\s*\(/;
  /**
   * ✅ **已撤（2026-09-25，挂账 `#108` 完成）**：这里曾用 `JAVA_RULE_API_RE` 把「脚本里出现
   * `java.setContent/getElements/getElement/getStringList`」的源**强制留 L1**。
   *
   * 原因回顾（缺陷类W，2026-09-22）：那四个方法在 worker 里没有实现、`hostRpc` 也没有分支
   * ⇒ 落到 java Proxy 的「未实现 → 空串」兜底 ⇒ 静默失效（🎨快看漫画「详情通了但目录 0 章」：
   * 同一份源 L1 = 26 章、worker = 0 章）。
   *
   * 当时的兜底代价：语料里 **32 个源**用这类 API，其中 **18 个同时用 `java.ajax`** ——
   * 这些源被迫回 L1，而 L1 的同步 HTTP（`execFileSync`）**阻塞进程事件循环**，并发一高就雪崩。
   *
   * 现在四个方法都已**RPC 化**（worker 侧声明 → `rpc('rule')` → 宿主用同一份 `AnalyzeRule` 求值 →
   * 描述符回流 → `mkList` 重建带 jsoup 方法的活列表），与 `__yueduJsoup` 同一模式，故撤掉兜底。
   * 回归锁：`java-rule-bridge.test.ts` 的 `#108` 用例（断言**真的进了 worker**且结果正确）。
   */
  /**
   * `#523` **`document` 的路由守卫**（替代原先的 `HOST_DOCUMENT_RE` 文本暴匹配）。
   *
   * 原先只要脚本文本里出现 `document.` 就强留 L1 ⇒ **25 个源**（其中多数含 `java.ajax`）
   * 继续在主线程 `execFileSync` 同步阻塞 —— `#497` 实证的 stall 家族。而语料里绝大多数
   * `document` 其实写在 **webView/webJs 的 HTML 载荷字符串**里（那段代码在渲染页里跑，
   * 我们这边的求值器根本不碰它）。
   *
   * 现在改为「**成员白名单**」（名单与 worker facade **同一张**，见 worker-pool 的
   * `__yueduDocument` 头注）：
   *   · 用到的 `document.<成员>` 全在名单内 ⇒ 放去 worker（worker 里那份 facade 语义对齐 jsdom）；
   *   · 名单外成员（`createElement` / `addEventListener` / `execCommand` / `fonts` / `select`…）
   *     或**裸 `document`**（可能被赋给别名后乱用）⇒ 仍留 L1（宁留也不静默半残）；
   *   · 另需**内容是可下发的字符串**：worker 的 `document` 以宿主下发的 `String(content)` 为根
   *     （`RULE_CONTENT_KEY`），元素 / JSON 内容没有这一份 ⇒ 留 L1（不给假文档 ⇒ nonce 不会算错）。
   */
  const DOCUMENT_WORKER_MEMBERS =
    'documentElement|body|head|title|getElementsByTagName|getElementById|querySelector|querySelectorAll';
  const DOCUMENT_WORKER_RE = new RegExp(`\\bdocument\\s*\\.\\s*(?:${DOCUMENT_WORKER_MEMBERS})\\b`, 'g');
  /**
   * `#536b` **lib 内 document 用法的可达性判定**（`#523` 成员白名单之后的第二道细化）。
   *
   * 案例（七猫 3.9.61，本次实测）：jsLib 56KB 里 87 个函数，其中 `paint()` 用
   * `document.createElement/...` 渲染**书评页 UI**（那段代码在 WebView 里跑，evaluator 从不执行）。
   * 但旧守卫扫 `lib + code` ⇒ 一个字把**整个源**锁死在 L1 ⇒ category/detail 全部走同步 HTTP
   * （日志实测单次 `sync-http m=1004`，一次分类加载 ~1.8s 阻塞主线程）。
   *
   * 做法：给 lib 建**函数级调用图**（`function NAME(` + 花括号配对，跳过字符串/注释），
   * 从「规则代码引用到的 lib 函数名」做可达闭包；只有**可达函数**里的名单外 document 用法
   * 才留 L1。解析失败（配不上括号等）一律按「可达」保守处理。
   *
   * 回退：`YUEDU_DOC_REACH=0` 恢复旧行为（lib 有任何名单外 document ⇒ 留 L1）。
   */
  const matchBrace = (src: string, open: number): number => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  };
  /**
   * lib 的**函数级调用图**（`#628` 起按 libText 缓存）。
   *
   * 为什么必须缓存：建图要对 56KB lib 扫 87 个函数体，旧实现还对「每个函数 × 每个函数名」
   * 各 `new RegExp` 一次（87×87 ≈ 7569 条边）**每次 eval 都重建**。
   * 七猫 1612 章目录实测：`document` 判定这一步累计 ~1.5s 主线程 CPU（profile 里
   * `RegExp: function\s+(...)` 579ms + `var\s+(...)` 521ms + `scanDecls` 226ms）。
   * lib 在同一个求值器生命周期里是不变的 ⇒ 按 libText 缓存，只对 ruleCode 做 seed 闭包。
   */
  interface LibDocGraph {
    names: Set<string>;
    edges: Map<string, Set<string>>;
    docFns: Set<string>;
  }
  const LIB_DOC_CACHE = new Map<string, LibDocGraph | null>();
  /** 标识符切分（一次 match 代替「对每个已知函数名各 new RegExp」） */
  const IDENT_RE = /[A-Za-z_$][\w$]*/g;
  const identsOf = (s: string): Set<string> => new Set(s.match(IDENT_RE) ?? []);
  const buildLibDocGraph = (libText: string): LibDocGraph | null => {
    const fns: Array<{ name: string; body: string }> = [];
    const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(libText)) !== null) {
      const open = libText.indexOf('{', m.index);
      if (open < 0) return null;
      const close = matchBrace(libText, open);
      if (close < 0) return null;
      fns.push({ name: m[1]!, body: libText.slice(open + 1, close) });
    }
    if (!fns.length) return null;
    const names = new Set(fns.map((f) => f.name));
    const stripDoc = (s: string): string => s.replace(DOCUMENT_WORKER_RE, ' ');
    const docFns = new Set(fns.filter((f) => /\bdocument\b/.test(stripDoc(f.body))).map((f) => f.name));
    const edges = new Map<string, Set<string>>();
    for (const f of fns) {
      const ids = identsOf(f.body);
      const refs = new Set<string>();
      for (const n of names) {
        if (n !== f.name && ids.has(n)) refs.add(n);
      }
      edges.set(f.name, refs);
    }
    return { names, edges, docFns };
  };
  /** lib 里的名单外 document 用法是否**对当前规则不可达**（true = 可忽略，不锁 L1） */
  const libDocUsageUnreachable = (libText: string, ruleCode: string): boolean => {
    let g = LIB_DOC_CACHE.get(libText);
    if (g === undefined) {
      g = buildLibDocGraph(libText);
      // 上限 8：一个进程里同时活跃的 jsLib 不会多（清空而不是 LRU，够用且简单）
      if (LIB_DOC_CACHE.size >= 8) LIB_DOC_CACHE.clear();
      LIB_DOC_CACHE.set(libText, g);
    }
    // 解析失败（括号配不上等）⇒ 保守按「可达」处理（保持旧行为）
    if (!g) return false;
    if (!g.docFns.size) return true; // lib 里没有名单外用法（调用方已判过，双保险）
    const ids = identsOf(ruleCode);
    const seed = [...g.names].filter((n) => ids.has(n));
    const seen = new Set(seed);
    const q = [...seed];
    while (q.length) {
      const cur = q.shift()!;
      for (const nxt of g.edges.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          q.push(nxt);
        }
      }
    }
    return ![...g.docFns].some((n) => seen.has(n));
  };
  /**
   * `#628`：lib 侧的三个判定（是否含 `document` / 去掉白名单成员后是否还剩 / 是否需类桥）
   * **一律由调用方预计算后传入，本函数不碰 `lib`**。
   *
   * 为什么不能用**默认参数**兜底：默认参数是**调用时**求值，调用方省略一次就白跑一次
   * 56KB 的 `replace` + `test`（1612 章 = 1612 遍）—— 那正是本批要消掉的开销，
   * 用默认值会把它悄悄留在原地（注释说已缓存、代码仍在扫，是最难发现的那种漂移）。
   * 故这里**不给默认值**，漏传即编译期报错。
   */
  const documentNeedsL1 = (
    code: string,
    hasContentString: boolean,
    jsonCtx: boolean,
    libHasDoc: boolean,
    libDocLeft: boolean,
  ): boolean => {
    if (!libHasDoc && !/\bdocument\b/.test(code)) return false;
    /**
     * `#628` **JSON 上下文不因 `document` 留 L1**（七猫 1627 章目录 12s → 实测修复）。
     *
     * 为什么：下一句 `if (!hasContentString) return true` 把「内容是对象」一律当 L1，理由是
     * 「HTML 内容可能要靠 document 解析」。但 `AnalyzeRule.isJson` 下内容已解析成对象，
     * `document` 指向的是渲染页 DOM、与内容无关 ⇒ 它出现与否都不构成 L1 的理由。
     *
     * 代价实证：七猫 jsLib 56KB 的 36 处 `document` 全在**段评 UI 的 HTML 载荷字符串**里，
     * `#536b` 的可达性分析本可判「不可达 ⇒ 进 worker」，却被上述短路绕过（目录 content 是
     * JSON 元素）⇒ 1612 章逐章 `l1-eval`（实测 1617 次 / 4.8s，总 12s）⇒ 与手机端 2~3s 差 5 倍。
     */
    if (jsonCtx) return false;
    if (!hasContentString) return true;
    // 规则代码自身用了名单外成员 ⇒ 留 L1（这条不变）
    if (/\bdocument\b/.test(code.replace(DOCUMENT_WORKER_RE, ' '))) return true;
    if (!libDocLeft) return false;
    if (process.env['YUEDU_DOC_REACH'] === '0') return true; // 回退：旧行为
    return !libDocUsageUnreachable(lib, code);
  };
  /**
   * `#628` **lib 部分的路由判定只算一次**。
   *
   * `needsJavaBridgeL1(lib + code)` 会对传入文本跑四组正则（`Packages.` / `JavaImporter` /
   * `BitmapFactory|Canvas|Bitmap` / `packagesPaths`）。lib 固定而 code 每章变 ⇒ 旧写法把
   * **56KB jsLib 反复扫了 1612 遍**（profile 实测这几条正则合计 >200ms 主线程 CPU）。
   *
   * 语义：lib 单独判为「需要类桥」⇒ 直接 L1（与拼接判定同结论）；否则再看 code。
   * 唯一差异是「lib 尾 + code 头拼出一个关键词」这种跨界匹配 —— 正则都带 `\b` 且 lib 以
   * 换行收尾，实际不存在；这个判据本身就只是文本启发式（真判据在 `java-bridge` 的类表）。
   */
  const libNeedsJavaBridge = lib ? needsJavaBridgeL1(lib) : false;
  const libHasDocument = /\bdocument\b/.test(lib);
  /** `#628`：lib 里「去掉白名单成员后是否还剩 `document`」也只算一次（同上面两个的理由） */
  const libDocLeft = libHasDocument && /\bdocument\b/.test(lib.replace(DOCUMENT_WORKER_RE, ' '));
  /**
   * `#628` **lib 的预处理只在求值器创建时做一次**（原先写在每次求值的闭包里）。
   *
   * 为什么要动：`lib` 对同一个求值器是**常量**，但下面三件事原先每章都重跑一遍 ——
   *   · `scanDecls(lib, …)`：对 56KB 跑 4 条声明扫描正则；
   *   · `fixRhinoLetSelfRef(lib, …)`：另一遍全文本改写；
   *   · 名单 `[...libFnsW]` / `[...libVarsW]` 的数组化。
   * CPU profile 实证（七猫 1612 章目录、主线程 self time）：
   *   `RegExp: function\s+(…` **577ms** + `RegExp: var\s+(…` **456ms** + `scanDecls` 本体 163ms
   *   + `RegExp: \b(let|const)…` 115ms + `RegExp: let|const` 91ms ≈ **1.4s**，
   *   占整段「求值+组装 6.9s」的 ~20% —— 全是**对同一份 lib 的重复劳动**。
   *
   * 语义不变：两个开关仍按环境变量读一次（同一次运行内不会被改）；`sendLib` 仍然只在 chain
   * 模式下产出（legacy 分支本就把 lib 拼进 code，不单独下发）。
   */
  const chainW = process.env['YUEDU_JS_CHAINSCOPE'] !== '0';
  /**
   * `#636` 第二层：lib 名字是否镜像到 realm 全局（默认关；只对远程 jsLib 表的源开，见选项注释）。
   * 环境变量 `YUEDU_JS_LIBGLOBAL=1` 可对**所有**源强制打开（对照实验/应急用）。
   */
  const libGlobalW = opts.libGlobalNames === true || process.env['YUEDU_JS_LIBGLOBAL'] === '1';
  const vmW = process.env['YUEDU_JS_VM'] !== '0';
  const libFnsW = new Set<string>();
  const libVarsW = new Set<string>();
  if (lib) scanDecls(lib, libFnsW, libVarsW);
  const sendLib = lib && chainW ? fixRhinoLetSelfRef(lib, libFnsW, LIB_SELFREF_LOOKUP) : '';
  /**
   * `#630` **路由计数**：本求值器实际走了 L1 还是 worker，各累计一次。
   *
   * 为什么需要：目录求值的并发度必须**按路由分档** —— worker 路是真并行（并发越高越快），
   * L1 路是**同步**求值（`new Function` 当场跑完），并发一高只是让更多 Promise 在同一根
   * 主线程排队，把「排队等待」计进每次 eval，主线程被占用成倍增长（`#480-a` 的调度雪崩）。
   * 实测（`tmp/probe-toc-conc-630.mts`，1612 章强制走 L1，一次扫描 4/16/32）：
   *   l1-eval 累计 4 ⇒ **11.8s**、16 ⇒ 20.7s、32 ⇒ **26.7s（2.3 倍）**；墙钟 14.2s → 23.3s → 29.0s。
   * 而只从规则文本猜路由会猜错（判据散落在 4 个分支里）⇒ 直接数实际落点最准。
   *
   * 引擎侧用法：跑第 0 章做探测，读 `fn.__yueduRouteStats` 的**增量**决定整批的并发
   * （实数落点比从规则文本猜路由准得多；`engine.ts` 的目录求值即如此用）。
   */
  const routeStats = { l1: 0, worker: 0, fast: 0 };
  /**
   * `#749` D2：L1 落点计数 + **回落原因**（`/api/diag` 的 `l1.reasons`）。
   * `reason` 取**第一个**拦下它的判据 —— 多条同时成立时只记最先触发的那条，
   * 这样分布之和 = `routed.l1`（可直接当「为什么没默认开」的依据）。
   */
  const l1Counted = (code: string, bindings: Record<string, unknown>, reason: string): unknown | Promise<unknown> => {
    routeStats.l1 += 1;
    noteL1RoutedL1(reason);
    return l1(code, bindings);
  };
  /**
   * `#748` **D1：纯 `java.ajax` / `java.head` + 文本规则的 L1 子集下放到 worker**（默认关）。
   *
   * 为什么只做这一小步：worker 的 `java.ajax` 走的是「worker 线程 SAB 等宿主异步 HTTP」，
   * 宿主事件循环**完全不参与**阻塞；而 L1 的同步 HTTP 是 `Atomics.wait` + 可能 `execFileSync`
   * （curl 兜底）—— 两者在并发目录下差一个数量级。但 worker 撑不起 DOM/浏览器/Java 类桥，
   * 所以只放行「脚本自身只用 HTTP + 字符串/正则/JSON」这一档，其余一律回落 L1（宁可慢不可错）。
   *
   * 判定是**保守的白名单**：
   *   · `code` 里不能有 `document` / `window` / `globalThis` / `this[...]` / `eval` / `Function`
   *     （动态取值可以绕过「未引用绑定可丢」的检查）；
   *   · 不能出现 `cookie` / `cache` / `source` / `infoMap` / 浏览器 / 文件 / 规则桥（`java.getString` 等）；
   *   · 所有 `java.<name>` 调用必须落在纯 HTTP + 纯函数白名单里（只认 `ajax` / `head` 两种网络）；
   *   · 绑定里不可克隆的值，只有**脚本（含 lib）完全没提这个名字**时才允许丢掉后下发。
   *
   * 回退：`YUEDU_L1_WORKER` 未设或 `=0`（默认）⇒ 本段代码零行为变化。
   */
  const l1WorkerW = process.env['YUEDU_L1_WORKER'] === '1';
  const L1W_JAVA_OK = new Set([
    'ajax', 'head', 'base64', 'base64Decode', 'base64Encode', 'md5', 'sha1',
    'timeFormat', 'log', 'toast', 'longToast', 'getCookie',
    'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
    'hex', 'strToBytes', 'bytesToStr', 'utf8ToGbk', 'gbkToUtf8',
  ]);
  const L1W_BANNED_IDENT = new Set([
    'document', 'window', 'globalThis', 'process', 'require',
    'cookie', 'cache', 'source', 'infomap', 'sourcefields',
    'startbrowser', 'webview', 'getverificationcode', 'refreshbook',
    'importscript', 'readtxtfile', 'writefile', 'deletefile',
    'setcontent', 'getelements', 'getelement', 'getstringlist', 'getstring',
  ]);
  const L1W_DYNAMIC_RE =
    /\b(eval|Function)\s*\(|\bthis\s*\[|\bglobalThis\b|\bwith\s*\(|\bObject\s*\.\s*keys\s*\(\s*this\s*\)|\bfor\s*\([^)]*\bin\s+this\b/;
  const l1WorkerPureHttpText = (code: string): boolean => {
    if (!l1WorkerW) return false;
    if (/\bdocument\b/.test(code)) return false;
    if (L1W_DYNAMIC_RE.test(code)) return false;
    const ids = identsOf(code);
    const lower = new Set<string>();
    for (const id of ids) lower.add(id.toLowerCase());
    for (const bad of L1W_BANNED_IDENT) if (lower.has(bad)) return false;
    // 每次用新的字面量（避免共享 `g` 正则的 lastIndex 状态）
    for (const m of code.matchAll(/\bjava\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (!L1W_JAVA_OK.has(m[1]!)) return false;
    }
    return true;
  };
  /** 丢掉「不可克隆且脚本从未引用」的绑定；有任一被引用的不可克隆绑定 ⇒ 返回 null（留 L1） */
  const dropUnreferencedForWorker = (
    wb: Record<string, unknown>,
    code: string,
  ): string[] | null => {
    // lib 也会在 worker 里执行（顶层语句 + 被调函数），所以引用判定必须把 lib 算进来
    const ids = identsOf(`${lib ?? ''}\n${code}`);
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(wb)) {
      // `#759` 图片字节键由 worker 侧重建方法面 ⇒ 它「不可克隆」是有意的，不参与丢/留判定
      if (k === IMAGE_BYTES_KEY) continue;
      if (isCloneable(v)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(k) && !ids.has(k)) {
        delete wb[k];
        dropped.push(k);
        continue;
      }
      return null;
    }
    return dropped;
  };
  const fn = (code: string, bindings: Record<string, unknown>): unknown | Promise<unknown> => {
    /**
     * `#633` **快路优先**：纯表达式（只碰字面量 / 本脚本 `var` / 白名单 `java.*` 纯函数）
     * 直接在宿主按**模板缓存**编译求值 —— 实测编译 1.15ms、命中 0.007ms，而走 worker 要 1.24ms。
     * 不满足边界（引用绑定/lib/控制流/java 有副作用方法）⇒ 返回 `{ok:false}`，继续往下走原路由，
     * 语义零变化。回退：`YUEDU_JS_FASTPATH=0`。
     */
    if (process.env['YUEDU_JS_FASTPATH'] !== '0') {
      const fast = (l1 as unknown as { __yueduFastExpr?: (c: string) => FastExprResult }).__yueduFastExpr;
      /**
       * `#743` P0 埋点：目录快路**一直在主线程同步执行**（tokenize + 模板编译/求值），
       * 但此前没有任何计时 —— 1322 章目录 = 1322 次，若单次 0.1ms 只是 130ms，
       * 若某模板 miss 导致重新编译（1.15ms）就会累加成秒级。用**独立 k=`fast-expr`**
       * 记录（不并入 `l1-eval`，否则会污染既有统计口径）。
       */
      if (typeof fast === 'function') {
        const tFast = performance.now();
        // `#771`：`fast` 是**同步**的（tokenize/模板命中/求值），包一层标记
        probeEnter('expr:fast');
        let r: FastExprResult;
        try {
          r = fast(code);
        } finally {
          probeLeave();
        }
        recordBlock('fast-expr', performance.now() - tFast, `fast ${r.ok ? 'hit' : `skip:${r.why}`} ${code.replace(/\s+/g, ' ').slice(0, 80)}`);
        if (r.ok) {
          routeStats.fast += 1;
          return r.value;
        }
      }
    }
    /**
     * `#759` **图片解密**：宿主下发的是 `{ __yueduImageBytes: Uint8Array }` 描述符。
     * · L1 路由：还原成「裸字节 + InputStream 方法」（与旧行为逐字一致）；
     * · worker 路由：下发裸字节（下方 `workerBindings[IMAGE_BYTES_KEY]`），worker 重新挂方法。
     */
    let imageBytes: Uint8Array | undefined;
    if (isImageBytesResult((bindings ?? {})['result'])) {
      imageBytes = ((bindings ?? {})['result'] as { [IMAGE_BYTES_KEY]: Uint8Array })[IMAGE_BYTES_KEY];
      bindings = materializeImageBindings(bindings ?? {});
    }
    const src = bindings ?? {};
    // Java 类桥（JavaImporter / Packages.）：**lib + code 一起判** —— 四合一/聚合类源把
    // `JavaImporter`、`Packages.javax.crypto.*` 写在 jsLib，规则代码里只有 `qmXxx.call(this,…)`
    // （语料 11 源桥在 jsLib、7 源代码里零字面量）。只看 code 会判漏 → 落 worker → 类桩缺失 → 静默失败。
    // `#628`：lib 侧结论已缓存（见 libNeedsJavaBridge 注释），这里只判 code。
    if (libNeedsJavaBridge || needsJavaBridgeL1(code)) return l1Counted(code, bindings, 'java-bridge');
    // 引用 `document` 且用到 worker facade 撑不起的成员（或内容不是可下发字符串）⇒ 留 L1。
    // 见 `documentNeedsL1` 注释：改为**成员白名单**后，`document` 只写在 webView 载荷字符串里的源
    // （以及只读白名单成员的源）可落 worker ⇒ 其 `java.ajax` 不再阻塞主线程。
    const l1WorkerOk = l1WorkerPureHttpText(code);
    if (l1WorkerOk) noteL1Eligible();
    if (documentNeedsL1(code, typeof src[RULE_CONTENT_KEY] === 'string', src[JSON_CTX_KEY] === true, libHasDocument, libDocLeft)) {
      /**
       * `#748` D1：`documentNeedsL1` 在「内容不是可下发字符串」时**无条件**判 L1（`!hasContentString`
       * 分支），但纯 HTTP 脚本根本不碰内容/document。这里用 `hasContentString=true` 再判一次：
       * 只有「document 成员在 worker 白名单内 / lib 里的 document 不可达」时才放行，
       * 否则仍按原判据留 L1。
       */
      const docSafeIfString = l1WorkerOk
        && !documentNeedsL1(code, true, src[JSON_CTX_KEY] === true, libHasDocument, libDocLeft);
      if (!docSafeIfString) return l1Counted(code, bindings, 'document');
    }
    const hostDomBound = (['$', 'result', 'src'] as const).some((k) => {
      const v = src[k];
      return v != null && typeof v !== 'string';
    });
    if (hostDomBound && DOM_ON_BINDING_RE.test(code)) return l1Counted(code, bindings, 'dom-binding');
    const liveSource = src['source'] as Record<string, unknown> | undefined;
    const rawInfoMap = src[INFOMAP_RAW_KEY] instanceof Map
      ? (src[INFOMAP_RAW_KEY] as Map<string, string>)
      : src['infoMap'] instanceof Map
        ? (src['infoMap'] as Map<string, string>)
        : undefined;

    // 压成可克隆形态：source / infoMap 用描述符表达，worker 侧重建为 RPC 活对象
    const workerBindings: Record<string, unknown> = { ...src };
    /**
     * 内置名清单**下发**给 worker（它是字符串数组，可结构化克隆）。
     *
     * 为什么不让 worker 自己维护一份：worker 侧曾手写 28 个名字，与这里 68 个**漂移**，
     * 漏掉 `Proxy` ⇒ 🎨热辣/包子/MYCOMIC/再漫画 的 `var Proxy = Map('代理：')` 被当普通变量
     * hoist 成字符串 ⇒ 后续 `new Proxy(...)` 报「Proxy is not a constructor」（4 源）。
     * ⇒ 名单单一来源（本处），worker 用它建快照。
     */
    workerBindings[BUILTIN_NAMES_KEY] = [...BUILTIN_GLOBAL_NAMES];
    delete workerBindings[INFOMAP_RAW_KEY];
    // `document` 工厂是函数、且 worker 里没有 DOM（引用它的脚本已在上方被强制留 L1）——
    // 显式删掉，避免把函数塞进 postMessage（结构化克隆不支持函数）。
    delete (workerBindings as Record<string | symbol, unknown>)[DOCUMENT_THUNK];
    // ⚠️ `entityStub` 返回的是**Proxy over function** → `typeof` 是 'function' 不是 'object'。
    //    早期只判 'object' 导致 source/book/chapter 从没被替换掉（HTTP 脚本始终回 L1）。
    const isEntityish = (v: unknown): boolean => typeof v === 'object' || typeof v === 'function';
    if (liveSource && isEntityish(liveSource)) {
      const fields = src[SOURCE_FIELDS_KEY] ?? cloneableFieldsOf(liveSource);
      if (fields && typeof fields === 'object') {
        delete workerBindings['source'];
        workerBindings[SOURCE_FIELDS_KEY] = fields;
      }
    }
    // `$` / `result` / `src`：宿主侧是「String 包装 + 挂载的 jsoup 方法」。
    // 若脚本不用 jsoup（DOM_API_RE 为 false 已排除），worker 里给**纯字符串**即可 ——
    // String 原型方法（replace/match/split）一样有；这样 CSS 上下文的 HTTP 脚本也能进 worker。
    // 宿主侧 `$` / `result` / `src` 是「String 包装 + 挂载的 jsoup 方法」。既已排除
    // 「在绑定上调 DOM 方法」的用法，worker 里给**纯字符串**即可 ——
    // String 原型方法（replace/match/split）一样有；这类脚本因而也能进 worker。
    for (const k of ['$', 'result', 'src']) {
      const v = src[k];
      if (v instanceof String) workerBindings[k] = String(v);
    }
    /**
     * `#759` 图片字节**只下发裸 TypedArray**，方法面由 worker 的 `__yueduImageStream`
     * 重建（结构化克隆会丢挂载方法）。`result` 这个键在 worker 里由
     * `__yueduPrepareBindings` 换成重建后的流对象。
     */
    if (imageBytes) {
      delete workerBindings['result'];
      workerBindings[IMAGE_BYTES_KEY] = imageBytes;
    }
    /**
     * `#629` **`src` 按需下发**（目录/列表热路径的关键优化）。
     *
     * 问题：`src` = bridgeDom(content)，而**目录求值里 content 是整份章节表**（七猫 1612 项
     * ≈ 233KB）。worker 隔离靠结构化克隆 ⇒ **每章都要整份克隆一次** ⇒ O(n²)。
     * 实测（`tmp/probe-eval-cost-629.mts`，同 lib 同 code，conc=4）：
     *    小 bindings 1.29ms/次 → 带 1612 项 src **4.60ms/次**（占单次 eval 的 72%）。
     * 这正是「手机端 2~3s vs 我们 15~20s」的主因之一。
     *
     * 上游零成本：`SharedJsScope` 里 `bindings.put("result", obj)` 是**同一 scope 内的引用传递**，
     * 不拷贝；我们没有这条路（worker 隔离是刻意的：给 `java.ajax` 一个不阻塞主线程的同步语义）。
     * ⇒ 只能靠裁剪：**脚本没提到 `src` 就不下发**。
     *
     * 判据：标识符级（`identsOf`），不是字符串 contains —— `mySrc.xxx` 不算命中 `src`。
     * 回退：`YUEDU_JS_TRIM_SRC=0`（万一某源靠 `globalThis.src` 动态取值）。
     */
    if (process.env['YUEDU_JS_TRIM_SRC'] !== '0' && 'src' in workerBindings) {
      if (!identsOf(code).has('src')) delete workerBindings['src'];
    }
    if (rawInfoMap) {
      delete workerBindings['infoMap'];
      workerBindings[INFOMAP_ENTRIES_KEY] = Object.fromEntries(rawInfoMap);
    }
    // book / chapter / rssArticle 同样是 entityStub（函数型 Proxy）→ 用字段快照描述符替代。
    // ⚠️ 安全守卫：脚本若**赋值**给这些实体（如 preUpdateJs 改 `book.bookUrl` 换域名），
    // 必须留在 L1 —— worker 里的写入经 JSON 回流太脆，丢写会造成「换域名失效」这类隐性 bug。
    const writesEntity = /\b(book|chapter|rssArticle)\s*(?:\.[\w$]+|\[[^\]]+\])\s*=[^=]/.test(code);
    if (!writesEntity) {
      for (const [bind, key] of [
        ['book', BOOK_FIELDS_KEY],
        ['chapter', CHAPTER_FIELDS_KEY],
        ['rssArticle', RSS_FIELDS_KEY],
      ] as const) {
        const fields = src[key];
        if (fields && typeof fields === 'object' && isCloneable(fields)) delete workerBindings[bind];
      }
    }

    // 绑定仍不可克隆（真 DOM 上下文等）→ 先按 `#748` D1 丢掉「脚本从未引用」的不可克隆绑定；
    // 仍有被引用的不可克隆绑定 / 不是纯 HTTP+文本 ⇒ 回退 L1（此时 java.ajax 仍会阻塞）。
    /**
     * `#759` 图片字节键（裸 TypedArray）**单独豁免**：worker 会用它重建 InputStream。
     * 不能把 `isCloneable` 整体放宽到 TypedArray —— 那会让「宿主故意留 L1 的
     * `result = 挂了方法的数组`」被误送 worker（方法面被结构化克隆丢掉 ⇒ TypeError）。
     */
    const cloneableBindings = (wb: Record<string, unknown>): boolean =>
      Object.entries(wb).every(([k, v]) => k === IMAGE_BYTES_KEY || isCloneable(v));
    let cloneable = cloneableBindings(workerBindings);
    let l1wDropped: string[] = [];
    /**
     * `#759` 图片解密默认**不走** `YUEDU_L1_WORKER` 白名单（该开关默认关），但图片脚本
     * 经常与 `source`/`book` 等 entityStub 无关 —— 只要脚本没动态取值，就可以按
     * 「未引用的不可克隆绑定直接丢」裁剪，让封面解密进 worker。引用到 `source` 的呢
     * （如荔枝短剧 `source.get(...)`）仍留 L1：worker 没有源字段快照时不能假装能用。
     */
    const imageTrimOk = !!imageBytes && !/\bdocument\b/.test(code) && !L1W_DYNAMIC_RE.test(code);
    if (!cloneable && (l1WorkerOk || imageTrimOk)) {
      const dropped = dropUnreferencedForWorker(workerBindings, code);
      if (dropped) {
        l1wDropped = dropped;
        cloneable = cloneableBindings(workerBindings);
      }
    }
    if (process.env.YUEDU_DEBUG_HYBRID) {
      const bad = Object.entries(workerBindings)
        .filter(([k, v]) => k !== IMAGE_BYTES_KEY && !isCloneable(v))
        .map(([k, v]) => `${k}:${typeof v}`);
      console.log(
        `[hybrid] ${cloneable ? 'worker' : 'L1'} dom=${DOM_API_RE.test(code)} ` +
          `http=${/java\.(ajax|ajaxAll|post|get|connect|head|getStrResponse)\s*\(/.test(code)} ` +
          `keys=[${Object.keys(workerBindings).join(',')}]` +
          (l1wDropped.length ? ` l1w-drop=[${l1wDropped.join(',')}]` : '') +
          (bad.length ? ` 不可克隆=[${bad.join(' ')}]` : ''),
      );
    }
    if (!cloneable) {
      // 纯 HTTP 子集但绑定不可克隆 ⇒ 记 `non-cloneable`；本来就不是纯子集 ⇒ `non-pure-http`；
      // 开关没开 ⇒ `switch-off`（不把它算进「判据失败」，避免默认关时污染分布）。
      return l1Counted(code, bindings, l1WorkerOk ? 'non-cloneable' : l1WorkerW ? 'non-pure-http' : 'switch-off');
    }
    routeStats.worker += 1;
    noteL1RoutedWorker();
    if (l1wDropped.length) noteL1Drops(l1wDropped);
    const rpc = async (method: string, args: unknown) => {
      /**
       * worker 的**规则桥**（`java.setContent/getElements/getElement/getStringList`，`#108`）。
       *
       * 与 L1 的 `AnalyzeRule.ruleApi()` 是同语义的两侧实现：求值统一回宿主（那边才有
       * jsdom + AnalyzeRule），worker 只负责把描述符重建成带 jsoup 方法的活列表。
       */
      if (method === 'rule') {
        const a = (args ?? {}) as { op?: unknown; rule?: unknown; content?: unknown };
        const bridge = opts.ruleBridge;
        // `#313`：新增 `'object'`（上游 `AnalyzeRule.getElement` 的两种返回值）。缺省仍是 `'elements'`。
        const op: 'elements' | 'strings' | 'object' =
          a.op === 'strings' ? 'strings' : a.op === 'object' ? 'object' : 'elements';
        if (!bridge) return op === 'object' ? { kind: 'value', value: null } : []; // 未注入 → 空（旧行为，不崩）
        return bridge(op, String(a.rule ?? ''), String(a.content ?? ''));
      }
      /**
       * worker 的 `java.toast` / `java.longToast` 回宿主 —— 与 L1 的 `makeJavaStub` 走同一条
       * `opts.onToast`（宿主收集后回传前端逐条弹）。**必须在这里短路**、不进 `hostRpc`：
       * hostRpc 没有 `toast` 分支，落到末尾会返回 undefined（对无返回值的调用无害，但白跑一趟）。
       */
      if (method === 'toast') {
        const a = (args ?? {}) as { msg?: unknown; long?: unknown };
        const s = String(a.msg ?? '').trim();
        if (s) {
          try {
            opts.onToast?.(s, Boolean(a.long));
          } catch {
            /* 宿主回调不得影响脚本执行 */
          }
        }
        return '';
      }
      /**
       * worker 的 `java.upLoginData(data)` 回宿主（与 L1 的 `makeJavaStub.upLoginData` 同一条回调）。
       * 必须在这里短路：hostRpc 没有 `upLoginData` 分支，落末尾会当未实现返回 undefined（白跑一趟）。
       */
      if (method === 'upLoginData') {
        const a = (args ?? {}) as { data?: unknown };
        try {
          opts.onUpLoginData?.(a.data);
        } catch {
          /* 宿主回调不得影响脚本执行 */
        }
        return '';
      }
      /**
       * worker 的 `java.refreshBookInfo/refreshBookToc/refreshContent` 回宿主
       * （与 L1 的 `makeJavaStub` 走同一条 `opts.onRefreshBook`）。上游是 EventBus 发射即返回。
       */
      if (method === 'refreshBook') {
        const a = (args ?? {}) as { kind?: string };
        const k = a.kind;
        if (k === 'info' || k === 'toc' || k === 'content') {
          try {
            opts.onRefreshBook?.(k);
          } catch {
            /* 同上 */
          }
        }
        return '';
      }
      /** worker 的 `java.canOpenSourceUi()` 回宿主（缺省 false） */
      if (method === 'canOpenSourceUi') {
        try {
          return opts.canOpenSourceUi?.() === true;
        } catch {
          return false;
        }
      }
      // worker 里的 java.startBrowser/startBrowserAwait/webView 会走 render RPC —— 在这里
      // 补记录「脚本要求打开浏览器」（L1 路径由 makeJavaStub 的 hooks 直接记录）。
      // 'browser' 是 startBrowser 的 **fire-and-forget** 通道（Legado startActivity 语义）：只记录，不渲染。
      if (method === 'render' || method === 'renderSource' || method === 'browser') {
        const a = args as { url?: string; kind?: string } | undefined;
        const u = a?.url;
        // `#393` 目的：worker 显式带了就照它；否则按通道默认 —— 'browser'（startBrowser）是展示型，
        // 'render'/'renderSource'（webView / startBrowserAwait）可能要浏览器里的登录态 ⇒ cookie。
        const k: BrowserOpenKind =
          a?.kind === 'show' || a?.kind === 'cookie' ? a.kind : method === 'browser' ? 'show' : 'cookie';
        if (u) opts.onBrowserOpen?.(u, k);
      }
      return hostRpc(
        opts.evalRule, method, args, opts.renderer, opts.cookies, opts.getSourceHeaders, opts.http,
        liveSource, rawInfoMap,
        {
          // worker 的 java.get(key) / java.put 回到宿主同一份取值链与持久落点（否则跨阶段必丢）
          read: (k: string) => javaVarGet(opts.variables, k),
          put: (k: string, v: string) => {
            const persist = opts.javaExtra?.['putVariable'];
            if (typeof persist === 'function') (persist as (k: string, v: string) => void)(k, v);
            else opts.variables.set(k, v);
          },
          // worker 的 cache.* 回到宿主同一份两层存储（与 L1 的 makeCacheStub 同源 ⇒ 零漂移）
          cache: makeCacheOps(opts.variables),
        },
        jsoupDom, // `#333`：worker 的 org.jsoup 回到宿主这份活节点表（backend 不可用时的兜底）
        domClient ?? undefined, // `#743`：DOM 后端常驻 worker（给了就整段转发，见 hostRpc 的 dom 分支）
        opts.renderHtmlJsAsync, // `#676`：worker 的 java.webView(html,url,js) → 宿主三段 CDP
        opts.verificationCodeAsync, // `#727`：worker 的 java.getVerificationCode → 宿主人工输入通道
      );
    };
    /**
     * ⚠️ **worker 路径必须复刻 L1 的脚本预处理**，否则会引入两类静默回归
     * （2026-09-16 由 Web 端 20+ 源实测暴露，且都是我自己的 Phase 0.1 改动引入的）：
     *   ① **Rhino→V8 语法兼容**：`[a,b]=>` 是 Rhino 特有写法，V8 抛
     *      `Malformed arrow function parameter list`。不做则整段脚本语法错
     *      （表现：分类条显示 `ERROR：Malformed arrow fun..`）。
     *   ② **顶层声明提升**：Rhino 里函数声明即全局属性，源脚本大量写 `this.foo()`；
     *      V8 的 eval 里声明落在 eval 作用域 → `this.getData is not a function`。
     * 正则/改写逻辑只在宿主这一份，worker 只按名字挂载（避免两处漂移）。
     */
    /**
     * `#611` step3 / `#624`：**lib 与 code 分开下发**。
     *
     * 上游 `ScriptBindings.kt:32-46`：jsLib 求值进独立 bindings，规则求值
     * `bindings.chainTo(sharedScope)`。本仓 step1/step2 已把 **L1** 改成同语义
     * （jsLib 声明不再写真 globalThis）；worker 侧此前仍是「宿主把 lib 拼进 code
     * 同一 eval 作用域」⇒ 带 `java.ajax` 的规则走 worker 时是旧语义 ⇒ step3 补上。
     *
     * 两个开关都与 L1 同源（`#491` 纪律：核心 eval 路径必须可回退）：
     *  · `YUEDU_JS_CHAINSCOPE=0` ⇒ 仍拼在一起（worker 行为与 10-25 前逐字一致）；
     *  · `YUEDU_JS_VM=0`        ⇒ 不用 `node:vm`，仍在 worker 全局求值（旧行为）。
     * 四种组合都可跑，便于出问题时按开关二分归因。
     * （判据与 L1 的 `chainScope` 同式：默认开，显式 `=0` 才关。）
     *
     * `#628`：`chainW` / `vmW` / `libFnsW` / `libVarsW` / `sendLib` 已提到**求值器创建时**算一次
     * （见上方 lib 预处理注释）——这里只剩 code 侧的事。
     */
    let sendCode: string;
    const hoistFns = new Set<string>();
    const hoistVars = new Set<string>();
    if (chainW) {
      // chain：code 单独 normalize+fix（自引用查找走 `__yueduScope` ⇒ 原型链落到 libScope）；
      // lib 单独 fix（查找走 `__yueduLibScope` ⇒ lib 工厂体内的作用域对象）——lib 那半已预计算。
      const codeNorm = fixRhinoLetSelfRef(normalizeRhinoSyntax(code), libFnsW);
      scanDecls(codeNorm, hoistFns, hoistVars);
      sendCode = inlineVarFnHoist(codeNorm);
    } else {
      // legacy：与 10-25 前逐字一致（lib 拼进 code、名单扫合并文本）
      const combined = fixRhinoLetSelfRef(normalizeRhinoSyntax(lib + code), libFnsW);
      scanDecls(combined, hoistFns, hoistVars);
      sendCode = inlineVarFnHoist(combined);
    }
    /**
     * ⚠️ **含同步 HTTP 的脚本必须给更大的求值超时**，否则「把同步 HTTP 超时调到 15s」这条改动
     * 在 worker 路径上**完全无效** —— worker 的默认求值超时（池的 `defaultTimeoutMs`，10s）会先炸，
     * 表现是 `JS_TIMEOUT@parse`，而不是优雅的空 body。
     *
     * 为什么会踩到：站点响应时间抖动极大（实测 51acgs.com/category：2.4s / 2.1s / **14.7s**），
     * 而 Phase 0.1 之后绝大多数含 `java.ajax` 的脚本都走 worker。此时 10s 的求值超时成了真正的天花板。
     *
     * 做法：**分级超时** —— 含 HTTP 的脚本给 `同步 HTTP 超时 + 5s`（留出解析/序列化余量），
     * 纯计算脚本不给 → 仍受池默认值（10s）的硬超时保护，避免死循环脚本长期占用 worker。
     */
    const httpTimeoutMs = opts.syncTimeoutMs ?? SYNC_HTTP_TIMEOUT_DEFAULT_MS;
    /**
     * `#531` 结果回流后**立刻重建 jsoup 元素**（见 `rehydrateWorkerJsoup` 头注）：
     * worker 把 `mkList` 元素包装降级成描述符发回来（否则会退化成整表 join 成 1 个字符串），
     * 宿主用**同一份** `jsoupDom` 按 nid 重建活元素 ⇒ 方法面与身份都在，
     * 后续阶段（`setContent(els[i])` → chapterName/chapterUrl）才能正常求值。
     */
    return pool
      .eval<unknown>({
        code: sendCode,
        bindings: workerBindings,
        // 内置名由 worker 侧 __yueduHoist 用「new.target 双语义 shim」挂（见该函数注释），
        // 所以这里**不过滤**：名字全量下发，是否 shim 由 worker 按原生快照判断。
        hoistFns: [...hoistFns],
        hoistVars: [...hoistVars],
        ...(sendLib
          ? {
              lib: sendLib,
              libFns: [...libFnsW],
              libVars: [...libVarsW],
              chain: chainW,
              // `#636`：只对远程 jsLib 表的源（engine 侧判定）镜像 lib 名到 realm 全局
              ...(libGlobalW ? { libGlobalNames: true } : {}),
            }
          : {}),
        ...(vmW ? { vm: true } : {}),
        rpc,
        ...(HTTP_API_RE.test(code)
          ? { timeoutMs: httpTimeoutMs + 5_000 }
          : // `#779`：content 动作的纯计算脚本给显式预算（默认 20s）；其余仍不给 ⇒ 池默认 10s
            opts.computeTimeoutMs !== undefined && opts.computeTimeoutMs > 0
            ? { timeoutMs: opts.computeTimeoutMs }
            : {}),
      })
      .then((v) => rehydrateWorkerJsoup(v, jsoupDom, domClient));
  };
  /** `#630`：把路由统计与「这是混合求值器」一并暴露给调用方（引擎据此决定目录并发）。 */
  (fn as unknown as Record<string, unknown>)['__yueduRouteStats'] = routeStats;
  return fn;
}

/**
 * 「类 Map」绑定（Legado `InfoMap : MutableMap<String,String>` 的等价物）——给发现页
 * 交互输入态用，也可被其他引擎（RSS 参数、海阔小程序入参）复用。
 *
 * 为什么不是 JS `Map`：源脚本按 Rhino/Java Map 语义写 **方括号** 读写
 * （`infoMap["频道"]` / `infoMap["频道"] = '男生频道'`），JS Map 的方括号取值恒为
 * undefined；而 InfoMap 同时提供 `get/put/remove/containsKey/size` 等 Map API。
 * 这里用 Proxy 同时满足两种写法，且**直接读写传入的 Map**（无同步延迟）。
 *
 * ⚠️ Proxy 不可结构化克隆 —— 需要它的求值请走进程内同步求值（jsEvalSync），
 *    不要丢进 worker 池（worker 里写入无法回传）。
 */
export function makeInfoMapBinding(
  map: Map<string, string>,
  /** `#672` 源脚本调 `infoMap.save()` / `saveNow()` 时通知调用方「该落盘了」（见下方注释） */
  hooks?: { onSave?: () => void },
): Record<string, unknown> {
  const toStr = (v: unknown) => (v == null ? '' : String(v));
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      const key = String(prop);
      switch (key) {
        /**
         * `#672` **`get()` 无参要返回整个 map** —— 上游 `InfoMap` 同时有
         * `get(key: String)`（Map 接口）与 `get(): MutableMap` 两个**重载**（`InfoMap.kt:38`）。
         * 两条都成立：`infoMap.get("排序")` 取单项、`infoMap.get()` 取全部。
         * 旧实现把无参当成 `get(String(undefined))` ⇒ 恒 `undefined`，源脚本 `JSON.stringify(infoMap.get())` 直接空。
         */
        case 'get': return (k?: unknown) => (k === undefined ? Object.fromEntries(map) : map.get(String(k)));
        /**
         * `#672` **上游 `InfoMap.save()/saveNow()`**（`InfoMap.kt:26-34`）。
         *
         * 用户实测 媚色MM：`exploreUrl` 脚本里有 `infoMap.save()`，而本仓绑定只有 Map 接口 ⇒
         * `infoMap.save is not a function` ⇒ 整条发现页只剩一条 `ERROR:` 分类（0 内容卡片）。
         *
         * 上游语义：`save(time, need)` **只置 `needSave` 标志**（不落盘），真正写缓存在
         * `ExploreAdapter.kt:685` 列表加载完后调 `saveNow()`。我们这里等价处理：
         *   · `save()` → 通知调用方「这轮结束请落盘」（不立刻写，对齐上游不打断脚本）；
         *   · `saveNow()` → 立刻通知（调用方通常直接 `saveExploreInput`）。
         * 宿主那份 Map 本来就是同一份（写入即时生效，只是持久化时机延后）。
         */
        case 'save': return (_time?: unknown, _need?: unknown) => { hooks?.onSave?.(); };
        case 'saveNow': return () => { hooks?.onSave?.(); };
        /**
         * `#672` `set` 要兼容两种调用：`set(k, v)`（Map 习惯）与 `set(map)`（上游
         * `InfoMap.set(value: Map)` **整体替换**）。旧实现只有前者 ⇒ 单参对象会被写成
         * `map.set("[object Object]", "")`，把整个 infoMap 污染成一条垃圾键。
         */
        case 'put': return (k: unknown, v: unknown) => { map.set(String(k), toStr(v)); return v; };
        case 'set': return (a: unknown, b?: unknown) => {
          if (b === undefined && a != null && typeof a === 'object' && !Array.isArray(a)) {
            map.clear();
            for (const [k, v] of Object.entries(a as Record<string, unknown>)) map.set(String(k), toStr(v));
            return;
          }
          map.set(String(a), toStr(b));
          return b;
        };
        case 'remove':
        case 'delete': return (k: unknown) => { const p = map.get(String(k)); map.delete(String(k)); return p; };
        case 'containsKey': return (k: unknown) => map.has(String(k));
        case 'containsValue': return (v: unknown) => [...map.values()].includes(toStr(v));
        case 'isEmpty': return () => map.size === 0;
        case 'clear': return () => { map.clear(); };
        case 'keys':
        case 'keySet': return [...map.keys()];
        case 'values': return [...map.values()];
        case 'entries': return [...map.entries()];
        case 'forEach': return (fn: (v: string, k: string) => void) => { for (const [k, v] of map) fn(v, k); };
        case 'toJSON':
        case 'toString': return () => JSON.stringify(Object.fromEntries(map));
        case 'size': return map.size;
        default: return map.get(key);
      }
    },
    set(_t, prop, v) {
      if (typeof prop === 'string') map.set(prop, toStr(v));
      return true;
    },
    deleteProperty(_t, prop) {
      if (typeof prop === 'string') map.delete(prop);
      return true;
    },
    has(_t, prop) { return typeof prop === 'string' && map.has(prop); },
    ownKeys() { return [...map.keys()]; },
    getOwnPropertyDescriptor(_t, prop) {
      return typeof prop === 'string'
        ? { value: map.get(prop), enumerable: true, configurable: true, writable: true }
        : undefined;
    },
  });
}
