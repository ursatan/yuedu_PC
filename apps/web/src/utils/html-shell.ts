/**
 * `#326` RSS 正文 iframe 的「壳拼装」—— 从 `ReaderOverlay.vue` 抽出的**唯一实现**。
 *
 * 为什么抽：探针（tmp/*.mts）必须用与前端**逐字同一份**的拼装逻辑做端到端验证，
 * 复制一份必然漂移（铁律：同一判据写两处必然漂移）。SFC 与探针都 import 本模块。
 *
 * 背景（缺陷类别）：RSS 正文里的 `<script>` 是**源作者写的**（如饭团动漫播放器：
 * `fetch(playUrl)` 拉播放页 → 提取 m3u8 → hls.js 播放），跑在不透明 origin 的
 * `<iframe srcdoc sandbox>` 里 ⇒ 任何 `fetch`/XHR 都是跨源且读不到响应 ⇒
 * `Failed to fetch`。这类脚本是源数据，不能改语义 ⇒ 壳层两件事：
 *
 *  ① **跨域通路桥（NET）**：覆写 iframe 内 `fetch` / `XMLHttpRequest.open`，
 *     把 http(s) 请求改写到 `/api/proxy`（服务端转发；响应对 `Origin: null`
 *     回 `ACAO: null`，见 `apps/server/src/index.ts` `/api/proxy` 路由）。
 *     **`#375` 相对 URL 也必须接住**：沙箱 srcdoc 的 `document.baseURI` 是
 *     `<base href>` 指向的**远端站**，相对请求若原样放行会被解析到远端并直连
 *     ⇒ CORS 拦死（网络层 200、JS 层 ERR_FAILED、站点回调静默不执行，
 *     实测 yckceo 书源列表「生成」按钮）。相对 URL 先按 baseURI 解析成绝对再代理；
 *     `data:`/`blob:`/`javascript:`/`mailto:`/`tel:`/`#`/`about:`、已是代理地址的不动（防重入）。
 *  ② **hls.js 注入（HLS）**：源脚本调用 Hls API 但没自带库（Chromium 又没有
 *     原生 HLS）⇒ 注入静态资产；必须绝对地址 —— srcdoc 里有 `<base href>`，
 *     相对路径会被解析到正文站点域名下。
 *  ③ **LIVE 媒体观察桥（`#376`）**：`navSniffMedia` 基于导航时的**静态 HTML 快照**，
 *     站点脚本在页内**动态切集**（换 `<video src>` / 换 iframe 播放页）后快照不变
 *     ⇒ 嗅探永远停在进页那一条（用户实测苹果MCS「嗅探只嗅到一集、页内切集不跟随」）。
 *     沙箱 iframe 是 opaque origin ⇒ 父页读不到内部 DOM ⇒ 只能在内容侧装观察钩子
 *     把「实际挂载的媒体地址」`postMessage` 出来（`#326`/`#336` 同型号坑）。
 *     判据（像媒体 URL）来自 core `media-shape` 的唯一实现——iframe 内不能 import TS，
 *     生成桥文本时以**正则 source 值**注入（`fn.toString()` 方案不可行：编译产物
 *     引用被压缩器重命名的模块级标识符 ⇒ iframe 内 ReferenceError）。
 */

/** 主页面所在 server 的 origin（http 开头才有效；file:// 态没有可代理的服务端） */
export function serverOriginOf(): string {
  return typeof window !== 'undefined' && window.location.origin.startsWith('http') ? window.location.origin : '';
}

/**
 * 跨域通路桥脚本文本。
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildNetBridge(origin: string, sid: string): string {
  const F = [
    '(function(){',
    'var ORG=' + JSON.stringify(origin) + ';',
    'var SID=' + JSON.stringify(sid) + ';',
    'function prox(u,ref){',
    'try{',
    'u=String(u);',
    "if(!u) return u;",
    // `#375` 相对 URL 先按 `<base href>`（document.baseURI）解析成绝对：
    // 沙箱 srcdoc 里相对请求若放行，会被浏览器解析到**远端站**（baseURI 是它）
    // ⇒ XHR/fetch 直连远端 ⇒ opaque origin 无凭据且 CORS 读不到响应 ⇒ 站点
    // 回调静默不执行（实测 yckceo「生成」：网络层 200、JS 层 ERR_FAILED、无弹层）。
    // data:/blob:/javascript:/mailto:/tel:/#/about: 不是资源请求，保持原样。
    "if(!/^(https?:|data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(u)){",
    'try{var b=document.baseURI||"";',
    "if(/^https?:\\/\\//i.test(b)) u=new URL(u,b).href;",
    '}catch(e){}',
    '}',
    "if(!/^https?:\\/\\//i.test(u)) return u;",
    "if(u.indexOf(ORG+'/api/proxy')===0) return u;",
    "var p=ORG+'/api/proxy?u='+encodeURIComponent(u);",
    "if(SID) p+='&sid='+encodeURIComponent(SID);",
    "if(ref) p+='&r='+encodeURIComponent(ref);",
    'return p;',
    '}catch(e){return u;}',
    '}',
    'var _f=window.fetch;',
    'if(_f){',
    'window.fetch=function(input,init){',
    'try{',
    "var u=(typeof input==='string')?input:((input&&input.url)||'');",
    'if(u){',
    'var ref="";',
    'if(init&&init.headers){',
    'var h=init.headers;',
    'try{ref=(typeof h.get==="function")?(h.get("referer")||""):(h["Referer"]||h["referer"]||"");}catch(e){}',
    '}',
    'return _f.call(window,prox(u,ref),init);',
    '}',
    '}catch(e){}',
    'return _f.apply(window,arguments);',
    '};',
    '}',
    'var _o=XMLHttpRequest.prototype.open;',
    'XMLHttpRequest.prototype.open=function(m,u){',
    'try{',
    // `#375`：相对 URL 也要过 prox（由 prox 内部按 baseURI 解析后决定是否代理）
    'arguments[1]=prox(u);',
    '}catch(e){}',
    'return _o.apply(this,arguments);',
    '};',
    '})();',
  ].join('');
  return F;
}

/**
 * `#571` **文档写保护**（白屏修复）：禁止「页面加载完成后」的 `document.write/open` 清空文档。
 *
 * ## 真因（2026-10-23 运行时取证，非猜测）
 * 打开 `https://www.163.com` 进阅读壳：0.8s 时正文 2071 字、`documentElement` 正常；
 * 3.3s 时 `document.childNodes=0` / `documentElement=null` ⇒ **整篇文档被清空**（用户看到「闪一下全白」）。
 * CDP 在 `Document.prototype.open/write` 上挂钩后抓到调用栈：
 * `HOOK document.write ← eval at ./src/js/utils/redirect.js (…/main.<hash>.js)`
 *
 * 机理：`document.write()` 在**解析结束后**调用会**隐式执行 `document.open()`**（HTML 规范行为）
 * ⇒ 清空现有文档并从零写。真站点上这段脚本在**解析期**同步跑（write 追加，无害）；
 * 进我们的壳后（`<base>` + 资源桥 + 脚本时序变化）它落到了解析后 ⇒ 白屏。
 * 这不是 163 独有：老式广告/跳转脚本普遍这么写，属**站点脚本缺陷的通用兜底**。
 *
 * ## 做法
 * 在**壳层最前面**（早于站点任何脚本）垫一层守卫：
 *  · 解析期（`readyState === 'loading'`）**原样放行** —— 站点正常的 `write` 不受影响；
 *  · 解析结束后：`write/writeln` **静默丢弃**、`open` 返回 `this`（不清空）。
 * 判据用 `readyState` 而不是只听 DOMContentLoaded：`DOMContentLoaded` 可能因站点脚本抛错而不触发。
 *
 * ⚠️ 生成脚本里不能出现反引号与字面 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildWriteGuard(): string {
  return [
    '(function(){',
    /**
     * 从 `document` 自身向上找**声明 `write` 的那个原型**，而不是直接用全局 `Document`：
     * 跨 realm（iframe）与某些仿真环境里全局构造器不一定可见；顺着原型链找是唯一稳妥写法。
     */
    "  var p = Object.getPrototypeOf(document);",
    "  while (p && !Object.prototype.hasOwnProperty.call(p, 'write')) p = Object.getPrototypeOf(p);",
    '  if (!p) return;',
    '  var w = p.write, wl = p.writeln, op = p.open;',
    /**
     * 「此刻写会清空文档吗」的判据：
     *  · `readyState !== 'loading'` ⇒ 解析已结束 ⇒ 规范会隐式 open（清空）；
     *  · **body 已经有子元素** ⇒ 解析早已越过正文开头 —— 此时写同样会 open/覆盖。
     *    ★ 实测（163）光看 readyState 不够：页面被外部脚本拖住，6.8s 仍是 `loading`，
     *      但 body 已有 2000+ 字 ⇒ 旧判据全部放行 ⇒ 整页被清空。
     * 代价：解析中「正文出现后再 document.write 追加广告」会被一起拦掉 —— 在阅读壳里可接受
     * （这类 write 基本都是广告/统计；正文已经在返回的 HTML 里）。
     */
    "  function destructive(){ try {",
    "    if (document.readyState !== 'loading') return true;",
    '    var b = document.body;',
    '    return !!(b && b.childElementCount > 0);',
    '  } catch(e){ return true; } }',
    '  p.write = function(){ if (destructive()) { return; } return w.apply(this, arguments); };',
    '  p.writeln = function(){ if (destructive()) { return; } return wl.apply(this, arguments); };',
    '  p.open = function(){ if (destructive()) { return this; } return op.apply(this, arguments); };',
    '})();',
  ].join('\n');
}

/**
 * `#364` **存储垫片（STORAGE）**：沙箱 iframe（opaque origin，无 `allow-same-origin`）里
 * 访问 `window.localStorage` / `window.sessionStorage` / `document.cookie` 直接抛
 * `SecurityError: Failed to read the 'localStorage' property from 'Window': The document
 * is sandboxed and lacks the 'allow-same-origin' flag.`
 *
 * ## 用户实测（2026-10-09）
 * 「阅读 · 全版本汇总」打开即「⚠️ 获取失败：Failed to read the 'localStorage' …」。
 * 「⚠️ 获取失败：」**不是本仓文案**（全仓 grep 无）—— 是该站自己的 UI；根因是**站点脚本**
 * 一启动就读 localStorage ⇒ 抛 SecurityError ⇒ 站点自己的初始化中断。
 *
 * ## 缺陷类别与修法
 * **任何**在沙箱 srcdoc 里跑的源站/源作者脚本，只要碰存储 API 就崩（与 NET 桥「有没有
 * 脚本」的门控无关 —— 这是「脚本碰存储」的独立缺陷面）。修法 = 壳层在站点脚本之前垫
 * **内存态**实现：
 *  · 运行时**自门控**：先 try 真访问，抛错才 `Object.defineProperty` 覆盖。探针实测
 *    （`.tmp-r3/storage-probe-run.cjs`，真 Chromium）：沙箱里该属性描述符
 *    `configurable: true`（Chromium 未按 LegacyUnforgeable 实现）⇒ 可覆盖，读写回路 OK；
 *    **非沙箱环境不抛 ⇒ 一字不改** ⇒ 对未来任何非沙箱消费者零行为回归面。
 *  · `document.cookie` 同款 SecurityError（原属性在 `Document.prototype`，在 document
 *    实例上定义 own 属性遮蔽之；get/set 都要，站点脚本写 cookie 也常见）。
 *  · 持久性：opaque origin 本就拿不到真持久存储，内存态是唯一可能的语义
 *    （上游 Android WebView 非沙箱无此问题；#308 架构决定沙箱隔离优先）。
 *  · defineProperty 再失败（如未来浏览器改 LegacyUnforgeable）⇒ 静默保持原状，
 *    症状与修复前完全相同（错误会原样浮出来，不新增静默面）。
 *
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildStorageShim(opts: { snapshot?: string; key?: string } = {}): string {
  const SEED = JSON.stringify(opts.snapshot ?? '');
  const SKEY = JSON.stringify(opts.key ?? '');
  const F = [
    '(function(){',
    /**
     * `#437` **可持久化的存储**（只有**启动页**传 `snapshot`/`key`）。
     *
     * 为什么：源作者的启动页把「书架 / 外观配置 / 自定义按钮」等存在 `localStorage`
     * （见千百羽论坛 `pput/pget`：「java.put 仅随书源导出用, **localStorage 才是跨重进真正持久的层**」），
     * 而沙箱 iframe 是不透明 origin ⇒ 真 `localStorage` 抛异常 ⇒ 垫片只能给内存态
     * ⇒ **每次重开源/刷新，作者的「书架」就空了**（用户实测「加入书架后重进该源，书架空」）。
     * 现在：宿主把上次的快照以 `SEED` 灌进来（同步可读），写入侧防抖 400ms 回传父页落盘。
     * ⚠️ 只有传了 `key` 才回传（普通正文本就不该往宿主写东西）。
     */
    'var SEED=' + SEED + ',SKEY=' + SKEY + ',D={},timer=0;',
    'try{if(SEED){var o=JSON.parse(SEED);if(o&&typeof o==="object"){for(var sk in o){if(Object.prototype.hasOwnProperty.call(o,sk))D[sk]=String(o[sk]);}}}}catch(e0){}',
    // ⚠️ `flush`/`touch` 定义在**本 IIFE 末尾**（函数声明会提升，`mk()` 里调用没问题）——
    //    这样「本文件第一次出现 postMessage」仍是紧随其后的**导航桥**，
    //    回归锁（`html-storage-shim.test.ts` 的「垫片先于导航桥」）用它当锚点。
    // 内存态 Storage 形状（getItem/setItem/removeItem/clear/key/length —— Storage 全接口）
    'function mk(){',
    'var s={',
    'getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(D,k)?D[k]:null;},',
    'setItem:function(k,v){D[String(k)]=String(v);touch();},',
    'removeItem:function(k){delete D[String(k)];touch();},',
    'clear:function(){D={};touch();},',
    'key:function(i){var ks=Object.keys(D);return i>=0&&i<ks.length?ks[i]:null;}',
    '};',
    'Object.defineProperty(s,"length",{get:function(){return Object.keys(D).length;}});',
    'return s;',
    '}',
    // 同一份存储暴露给 java 垫片（`java.put/get`、`source.get/put` 要用；STORAGE 是 head 里第一个脚本）
    'window.__yueduKV={get:function(k){return Object.prototype.hasOwnProperty.call(D,String(k))?D[String(k)]:"";},',
    'put:function(k,v){D[String(k)]=String(v==null?"":v);touch();return D[String(k)];},',
    'drop:function(k){delete D[String(k)];touch();}};',
    // 只在「真访问抛错」时覆盖（自门控；见函数头注释）
    'function patch(obj,name){',
    'try{obj[name].getItem("__yuedu_probe__");return;}catch(e){}',
    'try{Object.defineProperty(obj,name,{value:mk(),configurable:false,enumerable:true,writable:false});}catch(e){}',
    '}',
    'patch(window,"localStorage");',
    'patch(window,"sessionStorage");',
    // document.cookie：读抛错才垫（get/set 都要 —— 写 cookie 与读同样常见）
    'try{void document.cookie;}catch(e){',
    'try{var c="";',
    'Object.defineProperty(document,"cookie",{',
    'get:function(){return c;},',
    // set：同名覆盖（按首段键名匹配），其余当新条目追加；属性串（expires 等）原样并入值 —— 内存态无过期语义
    'set:function(v){try{v=String(v);var i=v.indexOf("=");var k=i<0?v:v.slice(0,i);var pair=k+"="+(i<0?"":v.slice(i+1));var parts=c?c.split("; "):[];var rep=false;for(var j=0;j<parts.length;j++){if(parts[j].indexOf(k+"=")===0){parts[j]=pair;rep=true;break;}}if(!rep)parts.push(pair);c=parts.join("; ");}catch(e2){}},',
    'configurable:false,enumerable:true});',
    '}catch(e2){}',
    '}',
    // `#437` 回写宿主（见文件头注；函数声明提升 ⇒ 上面 `mk()`/`__yueduKV` 里调用没问题）
    'function flush(){if(!SKEY)return;try{parent.postMessage({yueduStartStorage:{key:SKEY,data:JSON.stringify(D)}},"*");}catch(e){}}',
    'function touch(){if(!SKEY||timer)return;timer=setTimeout(function(){timer=0;flush();},400);}',
    '})();',
  ].join('');
  return F;
}

/**
 * `#345b` **动态资源改写桥**（24 系列「阅读页图片全部失败」的**唯一实现**）。
 *
 * ## 为什么不能只靠 `decorateRssHtml`（装饰期改写）
 * 24 系列（`www.myao.cc`）的 `ruleContent` 是**源作者写的脚本**：
 * ```
 * data="{{@@#imgData@value}}"; imgs=data.split("|");
 * for (...) html += '<img src="'+atob(imgs[i])+'" />';
 * box.innerHTML += html;
 * ```
 * 真实 `<img>` 是**脚本在 iframe 里运行后**才插入的 —— 装饰期 HTML 里只有那段模板
 * 字面量（`'<img src="'+atob(imgs[i])+'" />'`），`decorateRssHtml` 此刻**看不到真节点**
 * ⇒ 只能靠**内容侧观察**：MutationObserver 盯住后续插入/改属性的 img/video/source，
 * 把绝对 http(s) 地址换成 `/api/proxy`（服务端补源头 Referer/UA/Cookie）。
 *
 * ## 为什么要与 NET 桥**分开**（别合回去）
 * NET 桥按「正文含 `<script`」门控（没有脚本就没有 fetch/XHR 要桥接）；
 * 但「图片盗链」与「有没有脚本」是**两件事** —— 合在一起 = 同一判据写两处，
 * 哪天 NET 门控变了，动态图片能力会**静默消失**。故独立注入（有 origin 就注入）。
 *
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildResourceBridge(origin: string, sid: string, base: string): string {
  const F = [
    '(function(){',
    'var ORG=' + JSON.stringify(origin) + ';',
    'var SID=' + JSON.stringify(sid) + ';',
    'var BASE=' + JSON.stringify(base || '') + ';',
    // 相对地址 → 绝对：优先 `<base href>`（srcdoc 里 document.baseURI 已是它），
    // 没有 `<base>` 时用构造时传入的正文地址兜底（否则相对图会被解析到 about:srcdoc）。
    'function abs(u){',
    'try{',
    "u=String(u).trim();",
    "if(!u) return '';",
    "if(/^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(u)) return '';",
    "if(/^https?:\\/\\//i.test(u)) return u;",
    /**
     * `#212` Step2：**本服务端点的根相对路径按自服务 origin 解析**（`/api/...`）。
     *
     * 为什么必须有：srcdoc 的 `document.baseURI` 是 `about:srcdoc`（没写 `<base>` 时），
     * `new URL('/api/x','about:srcdoc')` **直接抛** ⇒ `abs()` 返回 `''` ⇒ 图被丢掉。
     * epub 正文章节没有 `<base href>`（图片是 zip 内相对 → 已由服务端改写成根相对），
     * 正是这种情况。用 `ORG` 兜底后 `/api/local-books/asset` 落回本服务。
     *
     * ⚠️ **只认 `/api/` 前缀**，不是所有根相对路径 —— 站点自己的根相对图
     * （如 `/LoadImage.ashx/x.jpg`）必须继续交给 `<base href>` 解析成**站点地址**，
     * 再由 `prox()` 代理回源（带 cookie/referer）。若在这里一律拼 `ORG`
     * 会把站点图错认成「本服务的图」⇒ 代理到 `127.0.0.1/LoadImage.ashx` ⇒ 404。
     */
    "if(u.indexOf('/api/')===0) return ORG?ORG+u:'';",
    'var b=document.baseURI||BASE||location.href;',
    "if(!/^https?:\\/\\//i.test(b)) b=BASE||b;",
    'return new URL(u,b).href;',
    '}catch(e){return "";}',
    '}',
    /**
     * `#363`：**iframe / embed 的 `src` 要带 `r`（正文页 Referer）**。
     *
     * 实测（AGE 动漫）：`ruleContent` 生成 `<iframe src="https://jx.ejtsyc.com:8443/m3u8/?url=<密文>">`。
     * 这个解析站**按 Referer 分流**：
     *   · 直连（任何 UA，带不带父页 Referer 都一样）→ 6382 字节「云播放器」页（含 m3u8）✅
     *   · 经 `/api/proxy` **不带 r** → 45725 字节「88影视网」首页（无 m3u8/无 video）❌
     *   · 经 `/api/proxy` **带 r=正文页** → 「云播放器」✅
     * 即：不带 `r` 时服务端 `refererChain` 落到一个**它不接受**的 Referer ⇒ 解析站回首页
     * ⇒ 用户看到「播放区域变成了内嵌网页」（#358 的用户原话）。
     *
     * 为什么只给 iframe/embed 加：浏览器里 iframe 导航的 Referer 就是**父文档 URL**，
     * 这个语义是确定的；而 img/video 现在跑得好好的，不为修一处去动它们的 Referer 阶梯
     * （`refererChain` 对 4xx 有换 Referer 重试的兜底，但能不动就不动）。
     */
    'function prox(u,ref){',
    'try{',
    'u=abs(u);',
    "if(!u) return '';",
    "if(u.indexOf(ORG+'/api/proxy')===0) return u;",
    /**
     * `#212` Step2：**同源 `/api/` 端点原样放行**（不再套一层 `/api/proxy`）。
     *
     * 为什么需要：epub 正文的插图 src 是 `/api/local-books/asset?bookUrl=…&path=…`
     * —— 那是**本服务自己的只读资源端点**（字节直接从 zip 里取，不涉及外部网络）。
     * 若照旧改写成 `/api/proxy?u=<本机地址>`，服务端会**去 fetch 自己**：
     *   ① 多一跳、多一次整包转发；② proxy 的私网/回环判定与限流语义都可能插一脚。
     * 直接放行让 `<img>` 命中真端点 —— 与父页上的 `<img :src>` 走的是同一个地址（行为一致）。
     *
     * 安全性：判据是 `ORG`（自服务 origin 前缀，`serverOriginOf()` 给的），
     * 只放行**同源**的 `/api/`，不放过任何第三方绝对地址。
     */
    "if(u.indexOf(ORG+'/api/')===0) return u;",
    "var p=ORG+'/api/proxy?u='+encodeURIComponent(u);",
    "if(SID) p+='&sid='+encodeURIComponent(SID);",
    "if(ref&&/^https?:\\/\\//i.test(ref)) p+='&r='+encodeURIComponent(ref);",
    'return p;',
    '}catch(e){return "";}',
    '}',
    // 需要改写的属性集合：
    //  · img：`src` + 各种懒加载真地址（`data-original`/`data-src`/`data-lazy`/`data-echo`）
    //    —— 24 系列站点用 `jquery.lazyload`：`src` 是 `/grey.gif` 占位、真地址在 `data-original`。
    //    **必须同时改写 `src` 与这些 data-* **：只改 src 会让 lazyload 认不出占位 ⇒ 真图永不换上（`#345` 实测 0/13）。
    //  · video/audio/source/iframe/embed：`src` + `poster`。
    'function attrsOf(tag){',
    'if(tag==="img") return ["src","data-original","data-src","data-lazy","data-echo"];',
    'if(tag==="video"||tag==="audio"||tag==="source"||tag==="iframe"||tag==="embed") return ["src","poster"];',
    'return [];',
    '}',
    'function fixEl(el){',
    'try{',
    'if(!el||el.nodeType!==1) return;',
    /**
     * `#583` **源自绘图片按钮**由 `buildImageOptionBridge` 接管：它的 `src` 是内联 SVG data URL，
     * 走 `/api/proxy` 的「图片解密」通道只会拿到裂图（而且选项 JSON 已经不在 src 里）。
     * 标记判据与那个桥同一份（`data-yuedu-optimg`）。
     */
    "if(el.getAttribute&&el.getAttribute('data-yuedu-optimg')) return;",
    'var tag=(el.tagName||"").toLowerCase();',
    'var attrs=attrsOf(tag);',
    // `#442`：**原始** src（下面的循环会把它改写成代理地址）—— 判断「src 是不是占位」要用原值
    'var origSrc=(el.getAttribute&&el.getAttribute("src"))||"";',
    'for(var i=0;i<attrs.length;i++){',
    'var a=attrs[i];',
    'var v=el.getAttribute&&el.getAttribute(a);',
    'if(!v) continue;',
    // 占位图（grey.gif / blank 等）不动：换掉它会让 lazyload 失效（见上）
    'if(/\\/grey\\.gif|^about:blank$/i.test(v)) continue;',
    /**
     * `#441` **内联 `data:image/…` 也走代理解一次**（源可能声明了图片解密规则）。
     * 实测（91视频）：正文/封面图片的 `src` 是 `data:image/jpeg;base64,<密文>`，站点自己解密后渲染
     * ⇒ 我们直连渲染就是裂图。判据**必须带 SID**（没有源上下文的内联图不吃这一跳）。
     * ⚠️ 体积上限 200KB：data URL 会整串进查询串 ⇒ 超长会被中间层拒；封面/插图远小于此。
     */
    'if(SID&&v.indexOf("data:image/")===0&&v.length<=200000){',
    'var dp=ORG+"/api/proxy?u="+encodeURIComponent(v)+"&sid="+encodeURIComponent(SID);',
    'if(dp!==v) el.setAttribute(a,dp);',
    'continue;',
    '}',
    // `#363`：只有 iframe/embed 带正文页 Referer（见 `prox` 的注释）；img/video 保持原样。
    'var ref="";',
    'if(tag==="iframe"||tag==="embed") ref=BASE||(document.baseURI||"");',
    'var p=prox(v,ref);',
    // ★★ 只在**值真的变了**时才写回：`setAttribute` 即使写入同值也会产生 attribute
    // mutation record（Chromium 行为）⇒ 会再次触发本函数 ⇒ **无限回路**（页面卡死，
    // 实测 `Runtime.evaluate` 永不返回）。`prox` 对已是代理地址的输入返回原串，
    // 没有这道守卫就会自激。（`#350`）
    'if(p&&p!==v) el.setAttribute(a,p);',
    '}',
    'if(el.getAttribute&&el.getAttribute("srcset")) el.removeAttribute("srcset");',
    /**
     * `#442` **站点自定义懒加载属性**（91 系列实测：`<img src="/usr/plugins/tbxw/zw.png"
     * data-xkrkllgl="https://pic.hdhwqx.cn/…jpeg">` —— 真图在**随机命名的** `data-*` 里，
     * `src` 只是占位图）。
     *
     * 为什么不能只加进上面的固定白名单：那个名字是**站点防爬随机生成**的（今天叫
     * `data-xkrkllgl`，明天可能换），写死必然漂移。这里用**判据**代替名单：
     *   `<img>` 上**不在已知名单里**的 `data-*`，其值 `http(s)` 且**看起来是图片**
     *   （扩展名或 `/upload`）⇒ ① 该属性改写走代理（站点自己的 lazyload 若在跑，换上去也能用）；
     *   ② 若 `src` 是**占位/相对**（本站点实测 `/usr/…`）⇒ **把真图提升为 `src`**
     *   （不依赖站点那段（混淆过的）JS 是否跑得起来）。
     * ⚠️ 已知懒加载名（`data-original`/`data-src`/`data-lazy`/`data-echo`）**不动 src** ——
     * 24 系列靠 lazyload 自己换，改 src 会让它认不出占位（`#345` 的教训）。
     */
    'if(tag==="img"&&el.getAttributeNames){',
    'var KNOWN={"src":1,"srcset":1,"alt":1,"title":1,"class":1,"id":1,"width":1,"height":1,"loading":1,"decoding":1,"referrerpolicy":1,"crossorigin":1,"sizes":1,"ismap":1,"usemap":1,"data-xuid":1,"no-zoom":1,"data-original":1,"data-src":1,"data-lazy":1,"data-echo":1};',
    'var names=[];',
    'try{names=el.getAttributeNames()||[];}catch(e0){names=[];}',
    'var pickName="";var pickVal="";',
    'for(var k=0;k<names.length;k++){',
    'var nm=String(names[k]).toLowerCase();',
    'if(KNOWN[nm]||nm.indexOf("data-")!==0) continue;',
    'var vv=el.getAttribute(names[k]);',
    'if(!vv||vv.indexOf("data:")===0) continue;',
    'if(!/^https?:\\/\\//i.test(vv)) continue;',
    'if(!/\\.(jpe?g|png|gif|webp|bmp|avif)(\\?|$)/i.test(vv)&&!/\\/upload/i.test(vv)) continue;',
    'pickName=String(names[k]);pickVal=vv;break;',
    '}',
    'if(pickName){',
    'var cp=prox(pickVal,"");',
    'if(cp&&cp!==pickVal) el.setAttribute(pickName,cp);',
    'var cur=origSrc;',
    'if(cp&&(!/^https?:\\/\\//i.test(cur))) el.setAttribute("src",cp);',
    '}',
    '}',
    '}catch(e){}',
    '}',
    'function scan(root){',
    'try{',
    'if(!root) return;',
    'if(root.nodeType===1) fixEl(root);',
    'var list=root.querySelectorAll?root.querySelectorAll("img,video,audio,source,iframe,embed"):[];',
    'for(var i=0;i<list.length;i++) fixEl(list[i]);',
    '}catch(e){}',
    '}',
    'try{',
    'var mo=new MutationObserver(function(muts){',
    'for(var i=0;i<muts.length;i++){',
    'var m=muts[i];',
    'if(m.type==="childList"){for(var j=0;j<m.addedNodes.length;j++) scan(m.addedNodes[j]);}',
    'else if(m.type==="attributes"){fixEl(m.target);}',
    '}',
    '});',
    'mo.observe(document.documentElement||document,{childList:true,subtree:true,attributes:true,attributeFilter:["src","data-original","data-src","data-lazy","data-echo","poster","srcset"]});',
    'document.addEventListener("DOMContentLoaded",function(){scan(document.body||document.documentElement);});',
    // 图片可能由站点脚本在任意时刻插入（如 24 系列的 `#imgData` base64 解码）⇒ 多扫几轮兜住
    'scan(document.body||document.documentElement);',
    // ★ `#364` 批次附带修复：这个轮询 interval 在 node 宿主（web 包测试/探针）里会**挂住
    // 进程永不退出** —— html-res-bridge.test.ts 自 #345b 起把 web 全量套件卡死（本轮实测
    // 两轮 SIGTERM）。浏览器里 setInterval 返回 number、没有 unref ⇒ 判过再调，零行为影响。
    'var __t=setInterval(function(){scan(document.body||document.documentElement);},1200);if(__t&&__t.unref)__t.unref();',
    'window.addEventListener("load",function(){scan(document.body||document.documentElement);});',
    '}catch(e){}',
    '})();',
  ].join('');
  return F;
}

/* `#583` ── 源自绘 UI：图片选项 `click` + 面板里的 `qmRun` RPC ───────────────────
 *
 * 七猫把段评/本章说/神评/书评做成**正文里的图片按钮**：图片 `src` 尾巴挂一段
 * `,{"style":"text","type":"qmpl","click":"qmC_OpenComment(…)"}`。Legado 的 WebView
 * 会解析这段选项、按 `style` 决定行内小图/整宽条、点了执行 `click`。浏览器没有这套机制
 * ⇒ 壳层补上第一半（解析 + 点击上报），引擎补第二半（点击回的脚本求值，见
 * `POST /api/source-ui/eval`）。
 *
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildImageOptionBridge(): string {
  return [
    '(function(){',
    /**
     * 兼容分支：直接吃「src 里带 `,{…}`」的旧形态（引擎侧正常会给 `data-yuedu-ui`，见下）。
     * 按**最后一个** `,{` 切分（data URL 自己也有逗号）。
     */
    'function opt(s){var i=s.lastIndexOf(\',{\');if(i<0)return null;try{var o=JSON.parse(s.slice(i+1));if(!o||typeof o!==\'object\')return null;return {src:s.slice(0,i),opt:o};}catch(e){return null;}}',
    /**
     * ⚠️ 引擎侧（`#583`）把按钮重写成 **合法标签**：`src`（纯 data URL）+ `data-yuedu-ui`
     * （HTML 转义后的选项 JSON）。源给的裸引号形态在 HTML 解析时属性会被截断，不能依赖。
     * 兼容分支 `opt()` 留给「没有引擎重写、直接喂进壳的 HTML」。
     */
    'function fix(img){',
    'try{',
    'if(!img||img.nodeType!==1)return;',
    // 处理过就跳过：既防重复绑 click，也让资源改写桥（RES）不再代理 data URL（见那里的 marker 判据）
    "if(img.getAttribute&&img.getAttribute('data-yuedu-optimg'))return;",
    "var s=(img.getAttribute&&img.getAttribute('src'))||'';",
    "var raw=(img.getAttribute&&img.getAttribute('data-yuedu-ui'))||'';",
    'var o=null,real=s;',
    'if(raw){try{o=JSON.parse(raw);}catch(e0){o=null;}}',
    'if(!o){var p=opt(s);if(!p)return;o=p.opt;real=p.src;}',
    'if(!o||typeof o!==\'object\')return;',
    "img.setAttribute('data-yuedu-optimg','1');",
    "if(real!==s)img.setAttribute('src',real);",
    "var st=String(o.style||'').toLowerCase();",
    "img.className=(img.className?img.className+' ':'')+(st==='full'?'yuedu-opt-full':'yuedu-opt-text');",
    'if(o.click){',
    "img.style.cursor='pointer';",
    "img.addEventListener('click',function(ev){",
    'try{ev.preventDefault();ev.stopPropagation();}catch(e){}',
    // 宿主收到后交服务端在源环境里求值（见 utils/html-shell 头注 / api.evalSourceUi）
    "try{parent.postMessage({yueduSourceUi:{click:String(o.click),type:String(o.type||'')}},'*');}catch(e){}",
    '});',
    '}',
    '}catch(e){}',
    '}',
    'function scan(){try{var l=document.querySelectorAll(\'img[src]\');for(var i=0;i<l.length;i++)fix(l[i]);}catch(e){}}',
    /**
     * 必须在**资源改写桥之前**跑完（见 `buildHtmlDoc` 的注入顺序）：改写桥会把 `data:image/…`
     * 送去 `/api/proxy`（那是给「图片解密」开的通道），带着选项 JSON 的 data URL 会解析失败。
     */
    'document.addEventListener(\'DOMContentLoaded\',function(){',
    'scan();',
    'try{var mo=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];',
    "if(m.type==='attributes'){fix(m.target);}else{for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];if(n&&n.nodeType===1){fix(n);var l=n.querySelectorAll?n.querySelectorAll('img[src]'):[];for(var k=0;k<l.length;k++)fix(l[k]);}}}}",
    "});mo.observe(document.documentElement||document,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});}catch(e){}",
    '});',
    'scan();',
    '})();',
  ].join('');
}

/**
 * `#583` **面板里的 `qmRun` RPC 桥**（Legado `java.showBrowser(url, html, js)` 第三参的等价物）。
 *
 * 七猫评论面板的 HTML 自带脚本，靠 `window.qmRun('<脚本片段>').then(JSON.parse)` 继续拉
 * 「更多评论 / 回复」。上游把这个 `run` 作为 WebView 的 JS 接口注入；我们这里同样注入，
 * 只是 RPC 走 `postMessage` → 宿主 → `/api/source-ui/eval`。
 *
 * 只对**真的用到了 `qmRun`** 的页面注入（判据在 `buildHtmlDoc`；普通正文一字不改）。
 *
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildSourceRunBridge(): string {
  return [
    '(function(){',
    'var SEQ=0,PEND={};',
    'function run(code){',
    'return new Promise(function(resolve){',
    'var id=++SEQ;',
    'PEND[id]=resolve;',
    "try{parent.postMessage({yueduSourceRun:{code:String(code==null?'':code),id:id}},'*');}catch(e){resolve('');}",
    '});',
    '}',
    // 上游第三参写的是 `window.qmRun=run` —— 两个名字都给，源换个名字也能接住（七猫用 qmRun）
    'window.qmRun=run;window.run=run;',
    "window.addEventListener('message',function(e){",
    'var d=e.data||{};var r=d.yueduSourceRunResult;',
    'if(!r)return;',
    'var f=PEND[r.id];if(!f)return;',
    'delete PEND[r.id];',
    "f(String(r.value==null?'':r.value));",
    '});',
    '})();',
  ].join('');
}

/**
 * `#352` 判据下沉：`bodyUsesHls` / `bodyHasHlsLib` 移到 core 的**零依赖叶子模块**
 * `media-shape.ts` —— 引擎的嗅探门控（`bodySelfPlaying`）与前端壳层的 hls.js 注入
 * 必须共用**同一份**判据（铁律：同一判据写两处必然漂移）。
 * ⚠️ 前端必须走**窄子路径** `@yuedu/core/media-shape`（core exports）：从 index 导入
 * 会把整个 core（user-store 的 node:fs、net 的 undici…）拉进浏览器 bundle ⇒
 * rollup `copyFileSync is not exported` 构建失败（2026-10-08 实测）。
 */
import { bodyUsesHls, bodyHasHlsLib, MEDIA_EXT_RE, MEDIA_HINT_RE } from '@yuedu/core/media-shape';
// `#627` 远端字体失效 ⇒ 本地系统字体栈回落（只对声明了远程 @font-face 的页面注入）
import { planFontFallback } from './font-fallback';
export { bodyUsesHls, bodyHasHlsLib, MEDIA_EXT_RE, MEDIA_HINT_RE };

/**
 * `#336` **页内导航桥**：把正文里的跳转**留在阅读页内**（不跳系统浏览器新标签）。
 *
 * ## 缺陷类别（用户实测）
 * 阅读页点链接 ⇒ 浏览器新标签打开（`<a target="_blank">` / `window.open`），
 * 用户被带离阅读器，且**没有返回的路**。上游 `ReadRssActivity` 是 WebView
 * ⇒ 点击就在同一个 WebView 里前进/后退。本仓补上同一语义。
 *
 * ## 三件事
 *  ① 捕获 `<a>` 点击（含 `target=_blank`）：`preventDefault` + `postMessage` 给父窗口；
 *  ② 覆写 `window.open`：改为 postMessage，不真开窗；
 *  ③ `legado://` / `yuedu://` 协议（如 `legado://import/bookSource?src=…`）单独标记 ⇒ 父窗口唤起
 *     一键导入（`#343`：上游 Manifest 406-407 两 scheme 等价，kind 统一 'legado'）。
 *
 * ## ⚠️ 不拦的四种
 *  · `#` 锚点（页内定位，本来就在页内）；
 *  · `javascript:` / `mailto:` / `tel:` 等（不是导航，交给浏览器默认行为）；
 *  · `data:` / `blob:` / `about:`（同上）；
 *  · **`target` 命中页内元素**（`<a target="ageplayer">` 且页内有 `<iframe name="ageplayer">`）
 *    —— 见下方 `#391`。
 *
 * ## `#391` 为什么必须放行「页内 target」
 * 站点/源规则合成的播放页（AGE动漫 `ruleContent`）里，选集是
 * `<a href="…/m3u8/?url=…" target="ageplayer">`，而页内就有
 * `<iframe name="ageplayer">` —— **浏览器的原生语义是「导航那个 iframe」**（播放区就地换集）。
 * 我们一律 `preventDefault` + 交给宿主 `navGo` ⇒ **整个阅读页被换成那个解析页**
 * （用户实测：「点击选集会跳转解析云播放器页面，不停留在当前页面」）。
 * 判据：`target` 非 `_` 开头且 `document.getElementsByName(target)` 非空 ⇒ 放行。
 * 这与浏览器自己的解析规则一致（命名 target 优先解析为文档内的 browsing context）。
 *
 * ## 为什么必须由壳层注入而不是父窗口监听
 * iframe 是 **opaque origin**（`sandbox` 无 `allow-same-origin`）⇒ 父页**读不到**内部 DOM，
 * 只能在内容侧装钩子再 `postMessage` 出来（`#326` 跨域桥同型号坑）。
 */
export function buildNavBridge(): string {
  const F = [
    '(function(){',
    'function abs(h){try{return new URL(h,document.baseURI||location.href).href;}catch(e){return "";}}',
    'function kind(u){',
    "if(/^(legado|yuedu):/i.test(u)) return 'legado';",
    "if(/^https?:\\/\\//i.test(u)) return 'http';",
    "return '';",
    '}',
    'function send(u,k){',
    "try{parent.postMessage({yueduNav:{url:u,kind:k}},'*');}catch(e){}",
    '}',
    /**
     * `#391` target 是否指向**本文档内的** browsing context（`<iframe name>` / `<form name>`）。
     * `_blank`/`_self`/`_parent`/`_top` 开头是下划线 ⇒ 明确不是页内命名目标 ⇒ 交回拦截逻辑。
     */
    'function inDoc(t){',
    'if(!t) return false;',
    'if(t.charAt(0)==="_") return false;',
    'try{return !!(document.getElementsByName&&document.getElementsByName(t).length);}catch(e){return false;}',
    '}',
    'function hit(href){',
    'if(!href) return false;',
    "if(/^#/.test(href)) return false;",
    'var u=abs(href);',
    'if(!u) return false;',
    'if(shouldOverride(u)) return true;',
    'var k=kind(u);',
    'if(!k) return false;',
    'send(u,k);',
    'return true;',
    '}',
    /**
     * `#449` **源的 `shouldOverrideUrlLoading` 优先**（用户口径：「为什么是 D13 的事？现在不能支持么？」）。
     *
     * 上游 WebView 每次导航前跑这段 JS（`url` 在作用域里），**返回 true = 拦截**、由源自己
     * `java.open('rss',url)` 把这次跳转交给源规则重新解析。⇒ 这比壳层「同站」启发式精确
     * （源作者写的是 URL 模式），所以**先问源**；源没声明或判 false 才走下面的通用分流。
     *
     * 两种求值信号取「或」：
     *  · **返回值**（源写成自执行 IIFE 表达式时）；
     *  · **`java.open` 被调用过**（源写成纯语句列表时，返回值是 undefined）——
     *    这里先用探针接管 `java.open`、把参数记下来，求值完再**原样重放**，
     *    于是「拦截」与「报文给宿主」两件事都成立，且**不会重复**（探针期间不报文）。
     * ⚠️ 必须在 **IIFE 顶层**声明：`hit()`（点击）与 `window.open` 覆写**两个入口**都要用它，
     * 放进 `hit` 里就变成「只有点击看得到、`window.open` 看不到」⇒ 后者被外层 try 吞掉、
     * 静默回落到原生 open（实测过这个坑）。
     */
    'function shouldOverride(u){',
    'var f=window.__yueduShouldOverride;if(typeof f!=="function")return false;',
    'var j=window.java,args=null,saved=j&&j.open;',
    'try{if(saved)j.open=function(){args=Array.prototype.slice.call(arguments);};}catch(e){}',
    'var ret=false;try{ret=f(u)===true;}catch(e){}',
    'try{if(saved)j.open=saved;}catch(e){}',
    'if(args&&saved){try{saved.apply(j,args);}catch(e){}}',
    'return !!(args||ret);',
    '}',
    'document.addEventListener("click",function(e){',
    'var t=e.target;',
    /**
     * `#444` **`.json` 书源/订阅源「一键导入」按钮**（千白羽论坛实测）。
     *
     * 站点的按钮是 `span.onclick = function(){ location.href = 'legado://import/any?src=' + … }`
     * —— 在**不透明 origin 的沙箱 iframe** 里，未知 scheme 的导航会被浏览器直接丢弃
     * ⇒ 用户看到「按钮点了没反应」（上游 Legado 是靠 WebView 的 shouldOverrideUrlLoading 接住的，
     * 我们没有那一层）。而且 `location.href` 是 `[LegacyUnforgeable]`，**改写不了**。
     * ⇒ 换一条判据：**在捕获阶段先把站点自己的 onclick 掐掉**（属性型处理器要冒泡到 target 才跑，
     * 捕获阶段早于它），再按我们的通路派发导入。
     *
     * 判据（**代替站点自己的类名**，那名字会变）：元素（或祖先）带 `data-u` / `title`，
     * 其值是 `http(s)` 的 `.json` URL。站点正是把地址写在 `title`（`rn()`）/`data-u`（`annImp()`）上。
     */
    'var b=t;',
    'while(b&&b!==document){',
    'if(b.nodeType===1){',
    "var iu=b.getAttribute?b.getAttribute('data-u'):'';",
    "if(!iu&&b.getAttribute) iu=b.getAttribute('title');",
    'if(iu&&/^https?:\\/\\/[^\\s"\'<>]+\\.json(\\?|#|$)/i.test(iu)){',
    'e.preventDefault();e.stopImmediatePropagation();',
    'try{b.onclick=null;}catch(e3){}',
    "send('legado://import/any?src='+encodeURIComponent(iu),'legado');",
    'return;',
    '}',
    '}',
    'b=b.parentNode;',
    '}',
    'while(t&&t!==document){',
    'if(t.nodeType===1){',
    "var h=t.getAttribute?t.getAttribute('href'):'';",
    'if(h){',
    "var tg=t.getAttribute?t.getAttribute('target'):'';",
    'if(inDoc(tg)) return;', // `#391` 页内命名目标 ⇒ 交给浏览器原生行为（如换 ageplayer iframe）
    'if(hit(h)){e.preventDefault();e.stopPropagation();}',
    'return;',
    '}',
    '}',
    't=t.parentNode;',
    '}',
    '},true);',
    'var _open=window.open;',
    'window.open=function(u,n){',
    'try{',
    'if(inDoc(String(n||""))) return _open.apply(window,arguments);', // 同上（`window.open(u,"ageplayer")`）
    'var s=String(u||"");',
    'if(s){var a=abs(s);if(a){if(shouldOverride(a)) return null;var k=kind(a);if(k){send(a,k);return null;}}}',
    '}catch(e){}',
    'try{return _open.apply(window,arguments);}catch(e){return null;}',
    '};',
    '})();',
  ].join('');
  return F;
}

/**
 * `#404` **RSS 启动页的 `java` 桥垫片**。
 *
 * 启动页源脚本（`startJs`）用 `java.open('sort', <分类 JSON>)` 切分类、`java.base64Encode`
 * 拼 `data:` 分类 URL、`java.toast/longToast` 提示（18AV 实证）。iframe 是 opaque origin
 * （`sandbox` 无 `allow-same-origin`）⇒ 父页读不到内部 ⇒ **动作类**（`open`/`openUrl`/
 * `startBrowser`/`toast`/`putVariable`）一律 `postMessage({yueduStartJava:{m,args}})` 交宿主
 * （与 `yueduNav` 同型号）。只垫**启动页需要**的几项；正文页不注入它。
 *
 * ## `#418`：为什么还要 `java.ajax` / `source.*`（用户报障「启动页按钮点击无法正确加载信息」）
 * LOFTER（`rss/json/id/901`）的启动页是一整页 SPA：`loadRank` / `loadSubscrCols` / `updateColCount`
 * / `updateAuthor` 全走 `Host.ajax(url)` → **同步** `java.ajax`；标签/合集/历史走
 * `source.getVariable/putVariable/get/put`。缺任何一项，用户点按钮就是「没反应」。两条关键约束：
 *  · **同步**语义 ⇒ 只能用 `sync XHR`（`postMessage` 回不来值）打 `/api/proxy`
 *    （服务端已对 `Origin: null` 回 `ACAO: null`；`#418` 另补了该路由的 POST 半边）；
 *  · `source.getVariable()` 读的是**引擎侧**的源变量，沙箱页拿不到 ⇒ 由 `start` 动作随
 *    `variable` 一起下发、垫片**预置**（`setVariable` 再回宿主 `POST /api/sources/:id/variable` 落盘）。
 *    `source.get/put`（历史记录那套 CacheManager 命名空间）本服务端**无对应端点** ⇒ 内存态
 *    （单次会话内一致；跨会话丢失 —— 留账，见 backlog）。
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildStartPageJavaShim(opts: {
  /** 父页所在服务端 origin（`serverOriginOf()`）；空串 ⇒ 沙箱页发不出请求（`java.ajax` 恒返回空串） */
  origin?: string;
  /** 源 id：`/api/proxy` 用它带源级 header（源 `header` 规则 ⊕ 登录头 ⊕ Cookie） */
  sid?: string;
  /** `#418` 源变量初值（`source.getVariable()`）—— 由 `/api/run action=start` 带回 */
  variable?: string;
} = {}): string {
  const F = [
    '(function(){',
    'var ORG=' + JSON.stringify(opts.origin ?? '') + ';',
    'var SID=' + JSON.stringify(opts.sid ?? '') + ';',
    'var VAR=' + JSON.stringify(opts.variable ?? '') + ';',
    "function post(m,a){try{parent.postMessage({yueduStartJava:{m:m,args:a}},'*');}catch(e){}}",
    "function b64(s){try{return btoa(unescape(encodeURIComponent(String(s==null?'':s))));}catch(e){return '';}}",
    "function unb64(s){try{return decodeURIComponent(escape(atob(String(s==null?'':s))));}catch(e){return '';}}",
    // —— `#418` 同步 HTTP：Legado `java.ajax` 在源脚本里是**同步**语义（`var s=java.ajax(u); JSON.parse(s)`）。
    // 沙箱 iframe 是 opaque origin ⇒ 只能 `sync XHR` 打到 `/api/proxy`（服务端已对 `Origin: null`
    // 回 `ACAO: null`）。`url,{options}` 尾巴的切分判据与 core `net/url-prep.ts` 的
    // `splitUrlOptions` 一致（首个 `,{`）；method/body 取 options，GET 走既有半边、POST 走 #418 新增半边。
    "function splitUrl(u){",
    "u=String(u==null?'':u);",
    "var m=/\\s*,\\s*(?=\\{)/.exec(u);",
    "if(!m) return {url:u.trim(),opt:null};",
    "var o=null;try{o=JSON.parse(u.slice(m.index+m[0].length));}catch(e){o=null;}",
    "return {url:u.slice(0,m.index).trim(),opt:o};",
    "}",
    /**
     * `#437` **`java.ajax(url[, options])` 的选项补齐**（对齐 Legado `AnalyzeUrl`）：
     *  · 第 2 参数（`java.ajax(u, JSON.stringify({method,body,headers}))`）是 Legado 的写法，
     *    以前的垫片只认 `url,{…}` 尾巴 ⇒ POST/体/头全丢；
     *  · `,{"charset":"gbk"}` ⇒ 必须**取原始字节自己解码**（源作者大量依赖这条：中文老站整页 GBK）；
     *  · `,{"type":"hex"}` ⇒ 回**原始字节的 hex 串**（作者的兜底通路 `hexDecodeToByteArray`+`bytesToStr`）。
     *    ⚠️ 这两条**必须与 `/api/proxy` 的 charset 改写配套**：服务端回传的字节是 UTF-8，
     *    所以 `charset` 解码要按**上游声明的**字符集重解 —— 由服务端在文本响应的 content-type 上
     *    改写为 utf-8、并把原始字节… （见下：我们让服务端给出**正确 UTF-8**，本地再按 charset 解会错）。
     *    ⇒ 结论：`charset` 只在**响应头没给出正确 charset 时**才需要 —— 这里直接把 charset 透传给
     *    服务端（`&cs=`），由服务端按该字符集解码后回 UTF-8，客户端拿到的就是对的。
     */
    "function ajax(raw,optStr){",
    "try{",
    "var sp=splitUrl(raw),u=sp.url,opt=sp.opt||{};",
    "if(optStr){try{var o2=(typeof optStr==='string')?JSON.parse(optStr):optStr;if(o2&&typeof o2==='object'){for(var k2 in o2){if(Object.prototype.hasOwnProperty.call(o2,k2))opt[k2]=o2[k2];}}}catch(e1){}}",
    "if(!ORG||!/^https?:\\/\\//i.test(u)) return '';",
    "var method=String(opt.method||'GET').toUpperCase();",
    "var cs=String(opt.charset||'').trim();",
    "var wantHex=(String(opt.type||'').toLowerCase()==='hex');",
    "var q=ORG+'/api/proxy?u='+encodeURIComponent(u)+(SID?'&sid='+encodeURIComponent(SID):'')+(cs?'&cs='+encodeURIComponent(cs):'');",
    "if(wantHex) q+='&ty=hex';",
    "var x=new XMLHttpRequest();",
    "x.open(method==='POST'?'POST':'GET',q,false);",
    // 只设 CORS 简单请求允许的 Content-Type（非简单头会触发预检，而同步 XHR 无法完成预检）
    "var ct='';",
    "if(opt.headers){for(var hk in opt.headers){if(String(hk).toLowerCase()==='content-type')ct=String(opt.headers[hk]);}}",
    "try{x.setRequestHeader('Content-Type',ct||'text/plain;charset=UTF-8');}catch(e2){}",
    "if(method==='POST')x.send(opt.body==null?'':String(opt.body));else x.send(null);",
    "if(!(x.status>=200&&x.status<400)) return '';",
    "return x.responseText;",
    "}catch(e){return '';}",
    "}",
    // `#437` Legado 的 `ajaxAwait`（内容页 WebView 里才有；作者的代码优先用它、失败再退回 java.ajax）
    "function ajaxAwait(u,o){return new Promise(function(res){var t='';try{t=ajax(u,o);}catch(e){t='';}res(t);});}",
    // source：**可持久化**（`#437`）+ 变量预置（`getVariable` 同步读；`setVariable` 顺带回宿主落盘）
    'var mem={};',
    // `#437`：`source.get/put` 与 `localStorage` 走**同一份可持久化存储**（`window.__yueduKV`，
    // 由 STORAGE 垫片提供，它排在 head 注入件最前 —— 见 buildHtmlDoc 的顺序注释）。取不到退回内存态。
    "function kvGet(k){k=String(k);try{if(window.__yueduKV)return window.__yueduKV.get(k);}catch(e){}return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:'';}",
    "function kvPut(k,v){k=String(k);v=String(v==null?'':v);try{if(window.__yueduKV)return window.__yueduKV.put(k,v);}catch(e){}mem[k]=v;return v;}",
    'var source={',
    "get:function(k){return kvGet(k);},",
    "put:function(k,v){return kvPut(k,v);},",
    "getVariable:function(){return VAR;},",
    "setVariable:function(v){VAR=String(v==null?'':v);post('putVariable',[VAR]);return VAR;},",
    "putVariable:function(v){return source.setVariable(v);},",
    "getKey:function(){return SID;},",
    "getLoginInfoMap:function(){return {};},getLoginInfo:function(){return '';},putLoginInfo:function(){},",
    "removeLoginInfo:function(){},getLoginHeader:function(){return '';},putLoginHeader:function(){},",
    "removeLoginHeader:function(){},getHeaderMap:function(){return {};},getComment:function(){return '';}",
    '};',
    "var cookie={getCookie:function(){return '';},setCookie:function(){},removeCookie:function(){}};",
    'window.java={',
    // 3 参：`open(kind,url,title)`（title 由宿主用于阅读页标题）
    "open:function(t,p,x){post('open',[String(t==null?'':t),String(p==null?'':p),String(x==null?'':x)]);},",
    "openUrl:function(u,m){post('openUrl',[String(u==null?'':u),String(m==null?'':m)]);},",
    "startBrowser:function(u,t){post('startBrowser',[String(u==null?'':u),String(t==null?'':t)]);},",
    /**
     * `#582` `java.showBrowser(url, html)` —— 把**一段 HTML** 交给内置浏览器显示。
     * 七猫评论面板（段评/本章评）是 jsLib 自绘：气泡图点击后调它；缺这个 API 就静默无反应。
     * 与引擎侧 `selector/js.ts` 同语义：html 转 data URL，http base 补 `<base href>`。
     */
    "showBrowser:function(u,h){var t=String(h==null?'':h),b=String(u==null?'':u);if(t){if(/^https?:\\/\\//i.test(b)&&!/<base\\s/i.test(t))t='<base href=\"'+b.replace(/\"/g,'&quot;')+'\">'+t;try{b='data:text/html;base64,'+btoa(unescape(encodeURIComponent(t)));}catch(e){}}post('startBrowser',[b,'']);},",
    'base64Encode:b64,base64Decode:unb64,',
    "toast:function(m){post('toast',[String(m==null?'':m),false]);},",
    "longToast:function(m){post('toast',[String(m==null?'':m),true]);},",
    "getWebViewUA:function(){return navigator.userAgent;},",
    // 与引擎桩同值（core `js.ts` / `worker-pool.ts` 的 `androidId` 恒 '0000000000000000'）
    "androidId:function(){return '0000000000000000';},",
    'ajax:ajax,',
    // `#437` 兜底解码三件套（源作者 `x8Gbk` 的写法：
    // `java.bytesToStr(java.hexDecodeToByteArray(java.ajax(u,',{"type":"hex"}')),'gbk')`）
    "hexDecodeToByteArray:function(h){try{var s=String(h==null?'':h).replace(/[^0-9a-fA-F]/g,'');var n=s.length>>1,a=new Uint8Array(n);for(var i=0;i<n;i++)a[i]=parseInt(s.substr(i*2,2),16);return a;}catch(e){return new Uint8Array(0);}},",
    "bytesToStr:function(b,cs){try{var u=Uint8Array.from(b&&b.length!==undefined?b:[]);return new TextDecoder(String(cs||'utf-8')).decode(u);}catch(e){return '';}},",
    // `#437` 全局 KV（随源持久化；与 `source.put/get`、`localStorage` 同一份存储）
    // ★ 源作者的原话：「java.put 仅随书源导出用, localStorage 才是跨重进真正持久的层」
    //   —— 本仓两者现在是同一份（见 buildStorageShim），所以两条路都能持久。
    "put:function(k,v){return kvPut(k,v);},",
    "get:function(k){return kvGet(k);},",
    // LOFTER 里被注释掉的格式化（给个可用实现，防 ReferenceError）
    "timeFormatUTC:function(t,f){try{var d=new Date(Number(t));if(isNaN(d.getTime()))return '';var p=function(n){return (n<10?'0':'')+n;};return d.getFullYear()+'/'+p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());}catch(e){return '';}}",
    '};',
    'window.source=source;window.cookie=cookie;',
    // `#437`：Legado 内容页才有 `ajaxAwait`；作者的代码「有就用、没有退回 java.ajax」。
    // 这里补上（语义 = 同步 ajax 的 Promise 包装），让走 ajaxAwait 的那几条通道也能用。
    'window.ajaxAwait=ajaxAwait;',
    '})();',
  ];
  return F.join('');
}

/**
 * `#408` **正文页 `java` 垫片**（WebView 型订阅源的 `ruleContent` 合成页）。
 *
 * ## 缺陷类别（用户语料：18AV，WebView 型 RSS）
 * 这类源的 `ruleContent` 产出**整页 `<script>`**（源作者自己写的播放器页）：
 * ```js
 * eval(await window.importScriptAwait('.../artplayer.js'));   // 拉播放器库
 * let srcurl = await playu(url);                              // ⇐ 交给 WebView 嗅探 m3u8
 * java.openVideoPlayer(u, title, true);                       // 或交给 App 播放器
 * source.get/put('av18'+id, srcurl);
 * ```
 * 上游 `preloadJs` 把这些符号（`java` / `source` / `importScriptAwait` / `playu`）
 * 注入 WebView 全局；本仓正文 iframe 是 opaque origin，且 `makeJavaStub` 只有规则求值面
 * ⇒ 页面脚本一跑到 `importScriptAwait`/`java.openVideoPlayer` 就 ReferenceError，
 * 用户看到的是**卡在加载**（18AV 的「正文只有播放器占位」症状同源）。
 *
 * ## 修法：内容侧垫片 + `postMessage` 回宿主（与 `buildStartPageJavaShim` 同型号）
 *  · `java.openVideoPlayer(u,t,a)` / `java.openUrl(u,m)` / `java.longToast|toast`
 *    ⇒ `postMessage({yueduReaderJava:{m,args}})`，宿主开**本仓播放器**（HLS 由我们处理）；
 *  · `playu(url)` / `webViewGetSourceAwait(url)` ⇒ **RPC**（带 `id`）：宿主拿
 *    `resolveMediaPage(url)`（`#394` 的解析页二级解析）回填 `{yueduReaderJavaResult}`；
 *  · `importScriptAwait(url)` ⇒ 壳内 `fetch`（NET 桥已把 http(s) 改写到 `/api/proxy`）；
 *  · `source.get/put`、`cache.get/put/delete` ⇒ **壳内内存态**（opaque origin 无持久存储；
 *    语义 = 本次页面内一致，与上游 WebView 单次会话近似）。
 *
 * ## `#446`（2026-10-14）千白羽论坛：**源创作页面顶部的 4 枚按钮**
 *
 * 用户语料：详情页自绘的 4 枚按钮 —— ① 返回（`‹ 返回`）② 其下方「下载 HTML」（⬇️，
 * `downloadThread()`）③ 返回顶端（`⬆`，`topInit()` 造的 `#fabtop`）④ 外观设置（🎨，
 * `.fab` → `bgPanel()`）。它们全部由**源自己的脚本**（`style` 字段里的 `__p8page` 主脚本）
 * 产出，故「按钮点了没反应」= 我们缺它调用的那几个 WebView 能力。逐条对照：
 *
 *  ① **返回**：`onclick="goBack()"` → 源里是
 *     `if(history.length>1){history.back();return} → java.open('rss',Rr) → location.href=Rr`。
 *     沙箱 iframe 里 `history.length` 恒 1（`srcdoc` 只算一次）、`java` 未垫 ⇒ 只剩
 *     `location.href=Rr`（**把 iframe 甩到站点原始页**，源规则全失效）。⇒ 两处补齐：
 *     `java.open` 垫片 + `history.back` 宿主出口（后端返回实为「页内返回」，见
 *     ReaderOverlay 的 `back` 分支）。
 *  ② **下载 HTML**：`downloadThread()` → `dlSave()` → `java.downloadFile(hex,url)`；
 *     我们**不**实现 `downloadFile`（那是 Android 缓存目录语义），而是让 `dlSave` 的第 ③
 *     兜底 `<a download>` 真正生效 —— 沙箱若没有 `allow-downloads`，Chrome 会**静默丢弃**
 *     这次下载（不报错、`dlSave` 仍判 `ok=true`，用户看到弹窗却没有文件）。⇒ 见
 *     `ReaderOverlay` 正文 iframe 的 `sandbox`。
 *  ③ **返回顶端**：`window.scrollTo(0,0)`；`#432` 起正文 iframe **定高自滚**，这条本就有效。
 *  ④ **外观设置**：纯页内 JS + 本地存储垫片，本就有效。
 *
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildContentJavaShim(opts: { origin?: string; sid?: string } = {}): string {
  const F = [
    '(function(){',
    'var P={};var N=0;',
    'var ORG=' + JSON.stringify(opts.origin ?? '') + ',SID=' + JSON.stringify(opts.sid ?? '') + ';',
    "function post(m,a,id){try{parent.postMessage({yueduReaderJava:{m:m,args:a||[],id:id||0}},'*');}catch(e){}}",
    /**
     * `#449` **`window.ajaxAwait` 改由我们提供**（用户复测 ②「✘ 未获取到楼层内容」⇒ 抓楼层一个字节都没进来）。
     *
     * 缺陷类别：源脚本里取数走 `Dt()`/`Wt()`，而它们是「**有 `ajaxAwait` 就用它**、没有才退回 `fetch`」；
     * `window.java` 一被壳层垫上（我们垫了），源自己的初始化就会装一个**坏包装**
     * （`window.ajaxAwait=function(j){return window.java.ajaxAwait(j)}` —— 而 `java.ajaxAwait` 不存在）
     * ⇒ 调用即抛 ⇒ 退回 `fetch(u,{credentials:'include'})`，那条路要 NET 桥把 URL 改写到 `/api/proxy`，
     * 任何一环没接住就变成**直连源站**（不透明 origin 下 CORS 必失败）⇒ 抓楼层全空、`finish()` 报「未获取到楼层内容」。
     *
     * ⇒ 自己实现一条**受控通道**（不依赖 NET 桥）：相对 URL 先按 `document.baseURI` 解析成绝对，再打
     * `/api/proxy`（服务端补源 header / Referer / Cookie）。与 NET 桥那版的关键差别：**失败必须 reject**
     * （返回空串会让源把「空响应」当成功、不再退回），并把失败 `post('toast')` 出来
     * （铁律 3：兜底要留痕，否则用户只看到「点了没反应」）。
     */
    'function ajaxAwait(u,m,b,h){',
    'try{',
    "u=String(u==null?'':u);",
    'if(!u)return Promise.reject(new Error("empty url"));',
    'if(!/^https?:\\/\\//i.test(u)){try{u=new URL(u,document.baseURI||location.href).href;}catch(e){}}',
    "if(!ORG||!/^https?:\\/\\//i.test(u))return Promise.reject(new Error('bad url'));",
    "var q=ORG+'/api/proxy?u='+encodeURIComponent(u)+(SID?'&sid='+encodeURIComponent(SID):'');",
    'var init={};',
    "var mm=String(m==null?'':m).toUpperCase();",
    "if(mm&&mm!=='GET'){init.method=mm;if(b!=null)init.body=String(b);}",
    'if(h&&typeof h==="object")init.headers=h;',
    'return fetch(q,init).then(function(r){',
    "if(!r||!r.ok){var st=r?r.status:'?';try{post('toast',['页面数据请求失败：HTTP '+st+' '+u.slice(0,50),false]);}catch(e2){}throw new Error('HTTP '+st);}",
    'return r.text();',
    '});',
    '}catch(e){return Promise.reject(e);}',
    '}',
    "function b64(s){try{return btoa(unescape(encodeURIComponent(String(s==null?'':s))));}catch(e){return '';}}",
    "function unb64(s){try{return decodeURIComponent(escape(atob(String(s==null?'':s))));}catch(e){return '';}}",
    // RPC：宿主回 `{yueduReaderJavaResult:{id,value}}`；超时按「没拿到」返回空串（不挂住页面）
    'function rpc(m,a,ms){return new Promise(function(res){var id=++N;P[id]=res;post(m,a,id);setTimeout(function(){if(P[id]){delete P[id];res("");}},ms||15000);});}',
    'window.addEventListener("message",function(e){try{var r=e.data&&e.data.yueduReaderJavaResult;if(!r)return;var f=P[r.id];if(!f)return;delete P[r.id];f(String(r.value==null?"":r.value));}catch(e2){}});',
    // source：内存态（含登录信息族——页面脚本可能读；值由规则阶段注入，这里给同形空值）
    'var mem={};',
    'var source={',
    "get:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:'';},",
    "put:function(k,v){k=String(k);mem[k]=String(v==null?'':v);return mem[k];},",
    "getLoginInfoMap:function(){return {};},getLoginInfo:function(){return '';},putLoginInfo:function(){},",
    "getLoginHeader:function(){return '';},putLoginHeader:function(){},getHeaderMap:function(){return {};},getKey:function(){return '';}",
    '};',
    // cache：内存态空实现（18AV 页面会 cache.delete(url)）
    "var cache={get:function(){return '';},put:function(){},delete:function(){},getFromMemory:function(){return '';},putMemory:function(){},deleteMemory:function(){}};",
    "function getText(u){return fetch(String(u)).then(function(r){return r.text();});}",
    'window.java={',
    /**
     * `#446`① `java.open(kind,url,title)` —— Legado 的「用本订阅源重新解析这个 URL」。
     * 千白羽的「返回」按钮（`goBack()`）在 `history.back()` 之后就走它；
     * `shouldOverrideUrlLoading`（本仓引擎标记 UNSUPPORTED）也用它把站内帖子/板块链接
     * 拉回源规则。宿主按 kind 分流：`rss`⇒阅读页（同 `readFirstDirect`），其余⇒页内浏览器。
     */
    "open:function(t,p,x){post('open',[String(t==null?'':t),String(p==null?'':p),String(x==null?'':x)]);},",
    /**
     * `#446`① `java.startBrowser(url,title)` —— 源作者的注释原话：「详情页链接统一
     * 『一键跳转』……出口与首页侧边栏文章容器一致: 一律走**内置浏览器** java.startBrowser」。
     * ⇒ 这是「应用内浏览器」语义（**不是**系统外跳），宿主接 `startBrowser` 走页内导航。
     */
    "startBrowser:function(u,t){post('startBrowser',[String(u==null?'':u),String(t==null?'':t)]);},",
    /**
     * `#582` `java.showBrowser(url, html)` —— 把**一段 HTML** 交给内置浏览器显示。
     * 七猫评论面板（段评/本章评）是 jsLib 自绘：气泡图点击后调它；缺这个 API 就静默无反应。
     * 与引擎侧 `selector/js.ts` 同语义：html 转 data URL，http base 补 `<base href>`。
     */
    "showBrowser:function(u,h){var t=String(h==null?'':h),b=String(u==null?'':u);if(t){if(/^https?:\\/\\//i.test(b)&&!/<base\\s/i.test(t))t='<base href=\"'+b.replace(/\"/g,'&quot;')+'\">'+t;try{b='data:text/html;base64,'+btoa(unescape(encodeURIComponent(t)));}catch(e){}}post('startBrowser',[b,'']);},",
    "openVideoPlayer:function(u,t,a){post('openVideoPlayer',[String(u==null?'':u),String(t==null?'':t),!!a]);},",
    "openUrl:function(u,m){post('openUrl',[String(u==null?'':u),String(m==null?'':m)]);},",
    "longToast:function(m){post('toast',[String(m==null?'':m),true]);},",
    "toast:function(m){post('toast',[String(m==null?'':m),false]);},",
    /**
     * `#448`② `java.downloadFile(content[, url])` —— Legado 的「把字节写到 App 的下载目录」。
     *
     * ## 为什么要垫它（用户复测：`#447` 后 ①③④ 通了，② 「下载 HTML」仍不出文件）
     * 千白羽的 ⬇️ 按钮 → `dlSave()` 三条通道：① `java.downloadFile(hex,url)` ② `data:base64`
     * 也走 `downloadFile` ③ `<a download>`（Blob，源作者注明「Legado 内置 WebView 不支持 blob:」）。
     * 我们既不实现① ⇒ 落到第 ③ 条，而**沙箱 iframe 里的 `<a download>` 会被 Chrome 丢弃**
     * （即便给了 `allow-downloads`，不透明 origin 的下载仍不可靠）⇒ 用户看到「已生成 HTML」弹窗
     * 却没有文件。⇒ 实现 ① 即可：**由宿主顶层文档落盘**（顶层不在 sandbox 里，Web/桌面同一份实现）。
     *
     * ## 形状（与 Legado 对齐）
     * · `content`：源给的是**十六进制字节**（`_dlHex(html)`）或 `data:text/html;base64,…`；
     *   这里就地解成文本（hex → `Uint8Array` → `TextDecoder('utf-8')`）再报文，宿主只管落盘。
     * · `url`：只用来推文件名（源把 tid 编进去：`…/_x8dl_<tid>.html,{"type":"html"}`，尾部的
     *   `,{…}` 是 Legado 的选项串，要切掉）。
     * · **必须同步返回非空**：源判 `if(rel) ok=true`，返回空会让它继续走第 ③ 条（又白干一场）。
     */
    "downloadFile:function(c,u){",
    "try{",
    "c=String(c==null?'':c);u=String(u==null?'':u);",
    "var w=c.lastIndexOf(',{');if(w>=0)c=c.slice(0,w);", // Legado 的选项尾同时对内容生效（源第②通道就带尾巴）
    "var q=u.lastIndexOf(',{');if(q>=0)u=u.slice(0,q);",
    "var s=u.split('?')[0],k=s.lastIndexOf('/'),nm=k>=0?s.slice(k+1):s;",
    "try{nm=decodeURIComponent(nm);}catch(e1){}",
    "nm=String(nm||'').replace(/[\\\\/:*?\"<>|\\s]+/g,'_').slice(0,80);",
    "if(!/\\.html?$/i.test(nm))nm=(nm||'download')+'.html';",
    "var txt='';",
    "if(/^data:/i.test(c)){var z=c.indexOf('base64,');txt=unb64(z>=0?c.slice(z+7):c.slice(c.indexOf(',')+1));}",
    "else{var h=c.replace(/[^0-9a-fA-F]/g,''),n=h.length>>1,b=new Uint8Array(n),p;",
    "for(p=0;p<n;p++)b[p]=parseInt(h.substr(p*2,2),16);",
    "try{txt=new TextDecoder('utf-8').decode(b);}catch(e3){txt='';}}",
    "post('downloadFile',[nm,txt]);",
    "return nm;",
    "}catch(e){return '';}",
    "},",
    'base64Encode:b64,base64Decode:unb64,',
    'getWebViewUA:function(){return navigator.userAgent;}',
    '};',
    /**
     * `#446`① **`history.back` 的宿主出口**。
     *
     * 为什么必须接管：沙箱 iframe 的 `srcdoc` 每换一页就算一次**新导航** ⇒ 用户「页内跳转」
     * 之后 `history.length > 1`，源里的 `goBack()` 就会走这条 —— 而浏览器原生 back 只回退
     * **自己那份 iframe 历史**，宿主（Vue）的 `navStack` 一无所知 ⇒ 画面与栈**脱同步**，
     * 下一次渲染又会被 Vue 拉回新页（按钮看着时好时坏）。接管后交给宿主 `navBack()`，
     * 与页内导航条（`←`）走**同一条**判据。
     * ⚠️ `history.length <= 1` 时源不会调它、直接走 `java.open('rss',…)` ⇒ 不冲突。
     */
    "try{history.back=function(){post('back',[]);};}catch(e0){}",
    /**
     * `#449` 暴露 `ajaxAwait`（源脚本「有就用」它）+ `postAwait` 别名。
     * ⚠️ 必须在源自己的初始化**之前**就位（本垫片在 head 注入、源脚本在 body）⇒ 源的
     * `window.ajaxAwait||(...)` 那一行会认我们这份，不再装坏包装。
     */
    'window.ajaxAwait=ajaxAwait;',
    'window.postAwait=function(u,b,h){return ajaxAwait(u,"POST",b,h);};',
    'window.source=source;',
    'window.cache=cache;',
    "window.run=function(){return Promise.resolve('');};",
    "window.importScriptAwait=function(u){try{return getText(u);}catch(e){return Promise.resolve('');}};",
    "window.playu=function(u){return rpc('resolve',[String(u==null?'':u)]);};",
    "window.webViewGetSourceAwait=function(u){return rpc('resolve',[String(u==null?'':u)]);};",
    '})();',
  ];
  return F.join('');
}

/**
 * `#376` **LIVE 媒体观察桥**：把 iframe 内**实际挂载**的媒体地址报给父页。
 *
 * ## 为什么必须存在
 * `navSniffMedia`（ReaderOverlay）对**静态 HTML 快照**跑 `mediaFromRaw` —— 站点脚本
 * 在页内切集（换 `<video src>` / 换 iframe 播放页）后快照不变 ⇒ 嗅探停在进页那一条
 * （用户实测苹果MCS「只嗅到一集、页内切集不跟随」）。沙箱 opaque origin 父页读不到
 * 内部 DOM ⇒ 内容侧观察 + `postMessage`（`#326`/`#336` 同型号坑）。
 *
 * ## 报文与消费
 * `{yueduLiveMedia:{items:[{u:绝对直链, t?:集名}...], cur:当前}}` —— items 是**当前可见集
 * 列表的整表快照**（`#396` 替换语义：每次扫描重建、整体替换，**不跨扫描累积** —— 用户实测
 * AGE 换线路后旧线路的集被追加到尾部，列表变成混合线路的长串；「点另一条线路 tab = 清空
 * 列表、加载当前 tab 播放列表」，集数不特指）。上限 999（`#401`：200+ 集源曾被 60 截断）。cur = 第一个 video/audio 的
 * currentSrc（真实在播者）；都没有时沿用仍在列表里的旧 cur、再取首条。
 * 父页（ReaderOverlay）补 format（`inferPlayFormat`）—— 桥内**不抄第二份** format 判据。
 * 变化才发（整表签名比对；首次有候选也发）。
 *
 * ## `#377②` 播放列表整表提取（用户实测苹果MCS：双线路、多集，要进选集列表）
 * 苹果MCS 的 `ruleContent`（26368 字符 `@js:`）**自己产出播放器 HTML**：每集是一个
 * `<button data-url="完整直链">`（点击才 `vp.src=url`），线路名是另一排 `.line-tabs`。
 * 只盯 `<video src>` ⇒ 只能跟上「当前集」，拿不到整表（用户原话「能不能直接嗅探到
 * 播放列表所有集？」）。故除媒体元素外，本桥再扫一遍**带媒体直链的元素**：
 *   `[data-url],[data-src],[data-href],[data-video],[data-play],[data-mp4],[href]`
 * —— 只有 `like(url)` 为真（core 判据：扩展名/路径提示）才收 ⇒ 普通导航链接不会污染
 * （这是「不收噪声」的关键：判据仍是 media-shape 那份，不新增第二判据）。
 * 集名 `t` 取自 `data-title|data-name|title|textContent`（截 40 字）。
 *
 * ## 判据注入（为什么不是 `fn.toString()`）
 * 判据本体 = core `media-shape` 的 `MEDIA_EXT_RE` / `MEDIA_HINT_RE`（`likeMediaUrl`
 * 的两半）。iframe 内不能 import TS；`fn.toString()` 拿到的是**编译产物**——函数体
 * 引用被压缩器重命名的模块级标识符（`MEDIA_EXT_RE`→`t` 之类），注入即 ReferenceError。
 * ⇒ 注入**正则 source 值**（`JSON.stringify(re.source)`），桥内 `new RegExp(source,'i')`
 * 重建；胶水组合 `A.test(u)||B.test(u)` 必须与 `likeMediaUrl` 保持一致（改判据两处同步）。
 *
 * ## 触发
 * MutationObserver（src 类属性 + 子树变化，300ms 节流）+ load/DOMContentLoaded +
 * 1200ms 轮询兜底（`currentSrc` 被 JS 直接改 property 时不产生 attribute mutation）。
 * ⚠️ `setInterval` 必须 unref（`#364`：node 宿主跑单测时挂住进程永不退出）。
 * ⚠️ 生成的脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildLiveMediaBridge(extSource: string, hintSource: string): string {
  const F = [
    '(function(){',
    // 判据：两个正则 source 由父页按 core media-shape 注入（见函数头注释）
    'var _A=new RegExp(' + JSON.stringify(extSource) + ',"i");',
    'var _B=new RegExp(' + JSON.stringify(hintSource) + ',"i");',
    // 胶水组合 —— 与 media-shape.likeMediaUrl 保持一致（判据本体在上面两个正则里）
    'function like(u){return _A.test(u)||_B.test(u);}',
    // 相对 → 绝对（`<base href>` 优先；非 http(s) 目标返回空串）
    'function abs(u){',
    'try{',
    'u=String(u).trim();',
    "if(!u) return '';",
    "if(/^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(u)) return '';",
    "if(/^https?:\\/\\//i.test(u)) return u;",
    'var b=document.baseURI||"";',
    "if(/^https?:\\/\\//i.test(b)) return new URL(u,b).href;",
    '}catch(e){}',
    "return '';",
    '}',
    // RES 桥（#345b）会把 video/iframe 的 src 改写成 /api/proxy?u=<绝对> —— 还原原始直链
    // （父页要用原始地址做显示与直链播放，代理由播放器/服务端另行处理）。
    // ⚠️ RES 写回的是**绝对**地址（ORG 开头）⇒ 前缀可选匹配；探针实证首扫发生在
    // RES 改写之后（LIVE 脚本先执行但 head 期 body 还没解析，首扫实际由 RES 改写
    // 触发的 mutation 驱动）⇒ 必须按绝对形态还原，否则 like 判 false、items 恒空。
    'function unproxy(u){',
    'try{',
    'var m=/^(?:https?:\\/\\/[^\\/]+)?\\/api\\/proxy\\?u=([^&]+)/.exec(u);',
    'if(m) return decodeURIComponent(m[1]);',
    '}catch(e){}',
    'return u;',
    '}',
    // 从元素抽原始候选：video/audio 优先 currentSrc（真实加载地址；懒加载常只有 property
    // 没有 attribute），其次 src 属性，再退到子 <source>；source/embed/iframe 用 src
    'function grab(el){',
    'try{',
    'var tag=(el.tagName||"").toLowerCase();',
    'var s="";',
    'if(tag==="video"||tag==="audio"){',
    'try{s=el.currentSrc||"";}catch(e){s="";}',
    'if(!s) s=el.getAttribute("src")||"";',
    'if(!s&&el.querySelector){var so=el.querySelector("source");if(so)s=so.getAttribute("src")||"";}',
    'return unproxy(s);',
    '}',
    'if(tag==="source"||tag==="embed"||tag==="iframe") return unproxy(el.getAttribute("src")||"");',
    '}catch(e){}',
    "return '';",
    '}',
    // `#377②` 带媒体直链的元素（集按钮/链接）：data-* 里最常见的几种 + href，逐个试；
    // 只有像媒体的才返回（由调用方再用 like 复核，这里先把候选抽出来）
    'function grabEp(el){',
    'try{',
    'var attrs=["data-url","data-src","data-href","data-video","data-play","data-mp4","data-m3u8","href"];',
    'for(var i=0;i<attrs.length;i++){',
    'var v=el.getAttribute&&el.getAttribute(attrs[i]);',
    'if(v){var a=abs(unproxy(String(v).trim()));if(a&&like(a))return a;}',
    '}',
    '}catch(e){}',
    "return '';",
    '}',
    // 集名：data-title/data-name/title 优先，其次可见文本（截 40 字，去掉多余空白）
    'function label(el){',
    'try{',
    'var t=el.getAttribute&&(el.getAttribute("data-title")||el.getAttribute("data-name")||el.getAttribute("title"));',
    'if(!t){t=(el.textContent||"").replace(/\\s+/g," ").trim();}',
    't=String(t||"").trim();',
    'if(t.length>40) t=t.slice(0,40);',
    'return t;',
    '}catch(e){return "";}',
    '}',
    /**
     * `#395` 元素是否**真的看得见**。AGE 的合成页把**所有线路**的选集容器都渲染在
     * DOM 里（非当前线路只是 `display:none`）⇒ 不加可见性过滤时 5 线路×12 集
     * 全被收进嗅探列表（60 条、每条线路各自从「第01集」重排 ⇒ 用户看到的是一串
     * 乱序重名集）。过滤后：列表 = **当前可见**的集元素 —— 初始是当前线路 1-12
     * （页内顺序天然有序）。
     * 判据 = 三件套任一非零（offsetWidth/offsetHeight/getClientRects）——
     * `display:none` 子树三者全零；异常时放行（宁多勿漏，不猜）。
     * ⚠️ 只用于 ② 号「元素带媒体直链」通路；① 号媒体元素（video/audio/iframe）
     * 不做可见性过滤 —— 播放器可能藏起来播音频（`audio` 元素常见 width=0）。
     */
    'function vis(el){',
    'try{',
    'if(el.offsetWidth||el.offsetHeight) return true;',
    'return !!(el.getClientRects&&el.getClientRects().length);',
    '}catch(e){return true;}',
    '}',
    'var seen=[];var cur="";var timer=null;var lastSig="";',
    // `#396` **替换语义**（用户 2026-10-11：「点另一条线路 tab，清空列表，加载当前 tab 播放列表；
    // 不特指 12 集，可能更多也可能更少」）—— 每次扫描**重建**当前可见集列表整体替换 `seen`，
    // **不再跨扫描累积**（旧的「页内切过的集都留着」会把另一条线路的 12 集按序追加到尾部，
    // 列表变成长长一串混合线路的集）。变化判定 = 整表签名（u+t 序列）与上次不同才发报文。
    'function collect(sel,fn,visOnly){',
    'var out=[];',
    'try{',
    'var els=document.querySelectorAll(sel);',
    'for(var i=0;i<els.length;i++){',
    'if(visOnly&&!vis(els[i])) continue;',
    'var u=abs(fn(els[i]));',
    'if(!u||!like(u)) continue;',
    'var t=visOnly?label(els[i]):"";',
    'var dup=false;',
    'for(var j=0;j<out.length;j++){if(out[j].u===u){if(!out[j].t&&t)out[j].t=t;dup=true;break;}}',
    'if(!dup) out.push({u:u,t:t||""});',
    '}',
    '}catch(e){}',
    'return out;',
    '}',
    'function scan(){',
    'try{',
    // ① video/audio —— 实际挂载地址（当前在播/在册）
    'var mediaList=collect("video,audio",grab,false);',
    // ② `#377②` 可见集元素（集按钮/链接）—— **当前 tab** 的整张播放列表：
    //    苹果MCS 每集 <button data-url>；AGE 每集 <a href target=ageplayer>。
    //    `#395`：隐藏容器（display:none 的其它线路）里的候选跳过 —— 见 vis() 注释
    'var epList=collect("[data-url],[data-src],[data-href],[data-video],[data-play],[data-mp4],[data-m3u8],a[href],button",grabEp,true);',
    // ③ iframe/source/embed —— 内嵌播放页地址：**只在②为空时**当列表兜底
    //    （有集列表的源里，换线路后旧播放区的 iframe src 是**上一条线路的地址**，
    //    混进列表 = 污染「当前 tab 播放列表」；没有集列表的源，它仍是唯一线索）。
    'var frameList=epList.length?[]:collect("iframe,source,embed",grab,false);',
    // 合并去重（video/audio 挂载地址常与第一集链接相同；首个非空 label 胜出）
    'var next=mediaList.concat(frameList);',
    'for(var p=0;p<epList.length;p++){',
    'var dup=false;',
    'for(var q=0;q<next.length;q++){if(next[q].u===epList[p].u){if(!next[q].t&&epList[p].t)next[q].t=epList[p].t;dup=true;break;}}',
    'if(!dup) next.push(epList[p]);',
    '}',
    // 上限 999（`#401`：旧值 60 把 200+ 集的长番截断，用户实测 AGE 只出 60 集）
    // 站点广告轮换可能塞进大量假候选，别无限涨
    'if(next.length>999) next=next.slice(next.length-999);',
    // 替换判定：与 seen 整表比较（u+t 序列），不同才换 + 发
    'var same=next.length===seen.length;',
    'if(same){for(var k=0;k<next.length;k++){if(seen[k].u!==next[k].u||seen[k].t!==next[k].t){same=false;break;}}}',
    'if(!same) seen=next;',
    // cur = 第一个 video/audio 的实际挂载地址；没有则沿用**仍在列表里**的旧 cur，
    // 再没有取列表首条（换线路后旧 cur 已不在新列表 ⇒ 跟到新列表首条）
    'var c="";',
    'var v=document.querySelector("video,audio");',
    'if(v) c=abs(grab(v));',
    'if(!c){for(var k2=0;k2<seen.length;k2++){if(seen[k2].u===cur){c=cur;break;}}}',
    'if(!c&&seen.length) c=seen[0].u;',
    'if(c!==cur) cur=c;',
    'if(seen.length||cur){',
    'var items=[];',
    'for(var k3=0;k3<seen.length;k3++) items.push({u:seen[k3].u,t:seen[k3].t});',
    'var sig=cur+"\\n"+items.map(function(it){return it.u+"\\u0001"+it.t;}).join("\\n");',
    'if(sig!==lastSig){',
    'lastSig=sig;',
    "try{parent.postMessage({yueduLiveMedia:{items:items,cur:cur}},'*');}catch(e){}",
    '}',
    '}',
    '}catch(e){}',
    '}',
    'function kick(){if(timer)return;timer=setTimeout(function(){timer=null;scan();},300);}',
    'try{',
    'var mo=new MutationObserver(function(){kick();});',
    'mo.observe(document.documentElement||document,{childList:true,subtree:true,attributes:true,attributeFilter:["src","data-src","data-url","data-original","href","data-href","data-play","data-video","data-mp4","data-m3u8"]});',
    '}catch(e){}',
    'try{document.addEventListener("DOMContentLoaded",scan);}catch(e){}',
    'try{window.addEventListener("load",scan);}catch(e){}',
    'var __t=setInterval(scan,1200);if(__t&&__t.unref)__t.unref();',
    'scan();',
    '})();',
  ].join('');
  return F;
}

/**
 * `#377①` **视口居中桥**：把站点浮层（`layer.open` / 自绘浮层）「对齐到父页可见带」。
 *
 * ## 为什么单独一条桥（不合进 LIVE/NET）
 * 判据完全不同：LIVE 桥看**媒体地址**、NET 桥看**有没有脚本**，本桥看**浮层 DOM 出现**。
 * 合进去 = 同一判据写两处必然漂移（铁律）——且浮层能力与「有没有媒体」毫无关系。
 *
 * ## 语义
 * iframe 被撑到内容全高后，「视口」概念在子文档里失效（`innerHeight` = 全高）⇒ 站点
 * 用文档高算的居中必然错位。本桥：
 *  ① 观察 `.layui-layer`（及自绘浮层兜底选择器）出现 ⇒ `postMessage {yueduLayer:{count}}`；
 *  ② 监听父页回灌的 `{yueduVpTop:<px>}` ⇒ 写 `--yuedu-vp-top` CSS 变量（由 `LAYER_FIX_CSS`
 *     的 `transform:translateY(var(--yuedu-vp-top))` 消费）⇒ 浮层移到**父页可见带顶部**。
 *  ③ 浮层出现时**首帧先给一个兜底值 0**（贴 iframe 顶），父页拿到消息立刻算真值回灌。
 *
 * ⚠️ 生成脚本文本里不能出现反引号与字面的 script 闭合标签（srcdoc 拼接纪律）。
 */
export function buildLayerViewportBridge(): string {
  const SEL = '.layui-layer,[class*="layer-mask"],[class*="layer-shade"]';
  const F = [
    '(function(){',
    'var SEL=' + JSON.stringify(SEL) + ';',
    'var lastN=0;',
    'function setVp(px){try{document.documentElement.style.setProperty("--yuedu-vp-top",(parseInt(px,10)||0)+"px");}catch(e){}}',
    'window.addEventListener("message",function(e){',
    'try{',
    'var d=e.data;',
    'if(d&&typeof d.yueduVpTop!=="undefined") setVp(d.yueduVpTop);',
    '}catch(err){}',
    '});',
    'function scan(){',
    'try{',
    'var n=document.querySelectorAll(SEL).length;',
    'if(n!==lastN){',
    'lastN=n;',
    'if(n>0){',
    // 首帧兜底：贴 iframe 顶（父页回灌前至少不被丢到文档中段）
    'setVp(0);',
    "try{parent.postMessage({yueduLayer:{count:n}},'*');}catch(e){}",
    '}',
    '}',
    '}catch(e){}',
    '}',
    'try{var mo=new MutationObserver(function(){scan();});mo.observe(document.documentElement||document,{childList:true,subtree:true});}catch(e){}',
    'var __t=setInterval(scan,600);if(__t&&__t.unref)__t.unref();',
    'scan();',
    '})();',
  ].join('');
  return F;
}

/**
 * `#432` **高度回报脚本已删除**（原 `REPORT`）。
 *
 * 旧机制：「内容页把 `scrollHeight` 报给父页、父页设 iframe 高度」。唯一消费方是
 * `ReaderOverlay`，而只要页面 CSS 用了视口单位（`min-height:60vh` 等）就会与「iframe 高度」
 * 互为因果 ⇒ 高度来回变 ⇒ 父页滚动位置反复被钳位（用户报「文章一直跳顶、内侧滚动条时隐时现」）。
 * 现改为 **HTML 正文 iframe 定高自滚**（见 `ReaderOverlay.vue` 的 `isHtmlChapter` 注释与
 * `.se-body.se-html` 样式），父页不再需要这个数字 ⇒ 连同机制一起去掉（不留死代码）。
 */

/**
 * `#432` **滚轮转发桥**（沙箱 iframe → 父页滚 `.se-body`）。
 *
 * ## 缺陷（用户 2026-10-13 实测）
 * 正文 iframe 是 `sandbox="allow-scripts"`（**无** `allow-same-origin`）⇒ 它是不透明 origin 的
 * **独立文档**。滚轮事件投递给 iframe 自己的文档；而「滚动链（scroll chaining）」**不跨文档边界**
 * ⇒ iframe 自己没得滚时，外层 `.se-body` 收不到滚轮 ⇒ 用户「鼠标放在正文上滚不动，
 * 必须放到正文与外层滚动条之间的窄带（`.se-body` 的 16px 内边距）才滚得动」。
 *
 * ## 处置
 * 在 iframe 文档里监听 `wheel`（**非 passive**，才能 `preventDefault`）：
 *  · 先按标准滚动链语义判断「事件目标那条链上有没有能滚的祖先」——有则**不介入**
 *    （交给浏览器原生滚：视频页/播放列表这类自带内层滚动条的页面不能被我们抢走）；
 *  · 都没有 ⇒ `postMessage({yueduWheel: dy})` 交父页滚 `.se-body`，并 `preventDefault()`
 *    （避免同一次滚轮被「父页 + 浏览器默认」双重消费）。
 *
 * `deltaMode` 归一（`1`=行 / `2`=页 ⇒ 换算成像素），否则 Firefox 这类浏览器会「滚一点点就到底」。
 * ⚠️ 生成的脚本文本里不能出现反引号（srcdoc 拼接纪律）。
 */
export function buildWheelBridge(): string {
  return [
    '(function(){',
    // 「这个盒子在这个方向上还能不能滚」——**不看 overflowY**（给文档视口用：Chrome 里
    // `getComputedStyle(documentElement).overflowY` 是 `visible`，但视口确实在滚）
    'function room(el,dy){try{',
    'if(!el)return false;',
    'return dy>0?(el.scrollHeight-el.clientHeight-el.scrollTop>1):(el.scrollTop>1);',
    '}catch(e){return false;}}',
    'function canScroll(el,dy){try{',
    'if(!el||el.nodeType!==1)return false;',
    'if(!(el.clientHeight>0))return false;', // 0 高的「假滚动条」不算（LOFTER 正文里有这种遮罩层）
    'var oy=getComputedStyle(el).overflowY;',
    'if(!(oy==="auto"||oy==="scroll"||oy==="overlay"))return false;',
    'return room(el,dy);',
    '}catch(e){return false;}}',
    /**
     * `#437` **横向滚动条（源作者的分类/导航条）在桌面端滚不动**。
     *
     * 实测（千百羽论坛启动页 `.subs`/`.tabs`：`overflow-x:auto` + `::-webkit-scrollbar{display:none}`
     * + `-webkit-overflow-scrolling:touch`）—— 这是**移动端**写法：手机上手指一划就滚，
     * 桌面上隐藏了滚动条、又没有触摸 ⇒ 后面那些分类**永远看不到**（用户实测「千百羽官方站/网盘/链接被遮挡」）。
     * 两种通行修法（换行 / 拖动）里我们选**不改变作者布局的那一种**：把
     * 「滚轮纵向 → 该容器横向滚」+「按住鼠标拖动」补上（与触摸屏行为一致）。
     * ⚠️ 只在该容器**确实还能横向滚**时才吃事件（滚到头就还给纵向滚动），不抢页面的正常滚动。
     */
    'function hscroll(el,dx){try{',
    'if(!el||el.nodeType!==1)return false;',
    'if(!(el.clientWidth>0))return false;',
    'if(!(el.scrollWidth-el.clientWidth>1))return false;',
    'var o=getComputedStyle(el);',
    'if(!(o.overflowX==="auto"||o.overflowX==="scroll"||o.overflowX==="overlay"))return false;',
    'var before=el.scrollLeft;',
    'el.scrollLeft=before+dx;',
    'return el.scrollLeft!==before;',
    '}catch(e){return false;}}',
    'function hFind(node,dx){try{var t=node;while(t&&t.nodeType===1){if(hscroll(t,dx))return t;t=t.parentNode;}return null;}catch(e){return null;}}',
    'window.addEventListener("wheel",function(e){',
    'try{',
    'var dy=e.deltaY||0;if(!dy)return;',
    'var md=e.deltaMode||0;',
    'if(md===1)dy=dy*16;else if(md===2)dy=dy*(window.innerHeight||600);',
    // ⓪ 横向滚动容器优先：滚轮纵向 → 该容器横向（滚到头自动放行给下面的纵向逻辑）
    'if(!e.shiftKey&&hFind(e.target,dy)){e.preventDefault();return;}',
    // ① **本文档（iframe 视口）还能滚 ⇒ 原生滚，不转发**。
    //    `#432` 起正文 iframe 是「定高自滚」，能滚的正是视口 —— 不先判它会把滚轮抢走转给父页。
    'if(room(document.scrollingElement||document.documentElement,dy))return;',
    // ② 再按滚动链语义看目标链上的内层滚动容器（有则不介入：视频页/播放列表不能被抢）
    'var t=e.target;',
    'while(t&&t.nodeType===1){if(canScroll(t,dy))return;t=t.parentNode;}',
    "parent.postMessage({yueduWheel:dy},'*');",
    'e.preventDefault();',
    '}catch(err){}',
    '},{passive:false});',
    // `#437` **按住鼠标拖动**横向滚动容器（桌面等价于手指划动）。
    // ⚠️ 只在**已经横向滚动过**时才算拖动（4px 阈值）⇒ 普通点击（卡片/链接）完全不受影响。
    'if(document&&document.addEventListener){',
    'var dragging=null,dx0=0,sx0=0,moved=0;',
    'document.addEventListener("mousedown",function(e){',
    'try{if(e.button!==0)return;var t=e.target;while(t&&t.nodeType===1){',
    'if(t.clientWidth>0&&t.scrollWidth-t.clientWidth>1){var o=getComputedStyle(t);',
    'if(o.overflowX==="auto"||o.overflowX==="scroll"||o.overflowX==="overlay"){dragging=t;dx0=e.clientX;sx0=t.scrollLeft;moved=0;return;}}',
    't=t.parentNode;}}catch(err){}',
    '});',
    'document.addEventListener("mousemove",function(e){',
    'try{if(!dragging)return;var d=e.clientX-dx0;',
    'if(moved===0&&Math.abs(d)<4)return;',
    'moved=1;dragging.scrollLeft=sx0-d;e.preventDefault();',
    'if(dragging.style)dragging.style.cursor="grabbing";}catch(err){}',
    '});',
    'document.addEventListener("mouseup",function(){try{if(dragging&&dragging.style)dragging.style.cursor="";}catch(e){}dragging=null;});',
    '}',
    '})();',
  ].join('');
}

/**
 * `#377①` 站点浮层（layui `layer.open` 等）的**视口内定位**基础样式。
 *
 * ## 缺陷（用户实测 yckceo「生成」弹层）
 * iframe 被撑到**内容全高**（`htmlFrameH`，实测 4875px）⇒ 站点脚本（layui layer）用
 * `html/body` 高度算「垂直居中」⇒ `top = (4875-500)/2 = 2187.5px` ⇒ 弹层落在文档中段，
 * 用户**必须滚动才能看到**（用户原话：「位置比较靠下，需要滚动到页面中间才出现」）。
 * 空 iframe 里没有任何「父页可见窗口」的信息 —— 只能由父页把**当前可见带**的偏移灌进来。
 *
 * ## 机制（两条通路，任一可用即可）
 *  ① **CSS 变量** `--yuedu-vp-top`：父页（ReaderOverlay）在滚动/浮层出现时写入
 *     「让浮层落到可见带顶部所需的 iframe 坐标 Y」⇒ 本样式把浮层 `translateY` 到该处。
 *  ② 变量缺失时**回退**：`translateY(0)` = 贴 iframe 顶（至少不再被丢到文档中段）。
 *     ⚠️ 用户 2026-10-09 修正：目标是**可见带上方**，**不做垂直居中、不做固定**。
 *
 * ⚠️ 只覆盖 **`position:fixed` 的浮层**（layui 的 `.layui-layer` 与通用 `[class*="layer-"]`
 *   容器）：不动站点自身的普通固定元素（导航条/返回顶部等）。用 `!important` 是因为
 *   layui 把 `top` 写在**内联 style**（`style="top:2187.5px"`）里，外部样式必须提权。
 */
const LAYER_FIX_CSS = [
  // layui layer（yckceo/多数国内 CMS 站点用）：容器 .layui-layer 有内联 top/left
  '.layui-layer{top:0 !important;transform:translateY(var(--yuedu-vp-top,0px));margin-top:12px !important}',
  // 兜底：少数站点自绘浮层也用 layer- 前缀
  '[class*="layer-mask"],[class*="layer-shade"]{top:0 !important;height:100vh !important}',
].join('');

/**
 * 图片样式两个档位（`#459`）。
 *
 * `#212` Step2 加 `max-height:90vh` 时，理由是「epub 插图常见整页大图/竖长图，只限宽会让单张图
 * 撑出好几屏」—— 当时 HTML 正文的 iframe 是**按内容高度撑开**的，`vh` ≈ 内容全高（实测 4875px），
 * 所以这条上限**几乎永不生效**（注释里那句「对 RSS 文章页无副作用」就是这么来的）。
 *
 * `#432` 把 iframe 改成**定高自滚**（`vh` = iframe 自身高度 = 正文格可见高）⇒ `90vh` 从
 * 「永不生效」变成**真实生效**：替换元素（`img`）在 `max-height` 绑定时会**按比例把宽度也压下来**，
 * 于是竖长图（图集类 RSS 文章的主形态）只渲染出正文格一半的宽度，两侧留黑
 * （用户 2026-10-14 报「宽图不是 CSS 设置的 100%」，并准确猜到了「是接管滚动的原因」）。
 *
 * ⇒ 因此**按调用方分档**：epub 仍用 `capTall`（保留 `#212` 的意图，一屏装得下），
 *   RSS 文章（图集）用 `noCap`（不设高度上限 ⇒ `max-width:100%` 生效，图按正文格宽铺满）。
 *   不提权 `width:100%` 是**故意的**：站点常用 1×1 占位 gif（`jquery.lazyload`），
 *   强拉 100% 会把占位符撑爆版面；只放开高度上限即可满足「大图铺满」。
 */
const IMG_CSS = {
  capTall: 'img{max-width:100% !important;height:auto;max-height:90vh;object-fit:contain;display:block;margin:8px auto}',
  noCap: 'img{max-width:100% !important;height:auto;display:block;margin:8px auto}',
} as const;

/**
 * `#468` **播放器 iframe 的高度规则**（用户 2026-10-15 实测：视频区域高度低、画面小）。
 *
 * 真因：源 `ruleContent` 常产出 `<iframe src="https://jx.…/m3u8/?url=…">`，**只给 `width="100%"` 不给高度**
 * （AGE动漫 即是此形态）。浏览器对 iframe（replaced element）的缺省尺寸是 **300×150** ⇒ 宽度被源拉满、
 * **高度恒为 150px** ⇒ 播放器页被压成一条，画面又小又带黑边。
 * 而 {@link buildStyle} 此前只注入了 `video{…}`、**没有 iframe 规则** ⇒ 这条默认高一直生效。
 *
 * 定 16:9（播放器页的主流比例）+ `height:auto`（让源里写死的高度让位给比例）+ `min-height` 兜底。
 * ⚠️ `width:100% !important` 会顺带放大文章里的小部件 iframe（如分享/统计框）—— 已权衡：
 * 正文 iframe 里这类元素罕见，而「播放器太矮」是每篇都中的主症状。
 */
const IFRAME_CSS =
  'iframe{display:block;width:100% !important;max-width:100% !important;height:auto !important;aspect-ratio:16/9;min-height:200px;margin:8px auto}' +
  'embed,object{max-width:100% !important}';

function buildStyle(capTallImages: boolean): string {
  return (
    (capTallImages ? IMG_CSS.capTall : IMG_CSS.noCap) +
    'video{max-width:100% !important;height:auto}' +
    IFRAME_CSS +
    /**
     * `#583` 源自绘图片按钮的两种版式（选项 `style`：`text` 行内小图 / 其它整宽条）。
     * ⚠️ 必须带 `!important`：上面 `IMG_CSS` 的 `img{display:block;margin:8px auto}` 会把
     * 行内小图撑成整行。
     */
    '.yuedu-opt-text{display:inline-block !important;height:1.25em !important;width:auto !important;' +
    'max-width:none !important;max-height:none !important;vertical-align:-0.22em;margin:0 4px !important}' +
    '.yuedu-opt-full{display:block !important;width:100% !important;height:auto !important;' +
    'max-height:none !important;margin:10px auto !important;cursor:pointer}' +
    'body{word-wrap:break-word;margin:0;padding:8px;font-size:16px;line-height:1.7;color:#222;background:#fff}' +
    LAYER_FIX_CSS
  );
}

export interface HtmlShellOpts {
  /** `<base href>`（= 引擎的 htmlBaseUrl，相对资源补全基准） */
  base?: string;
  /** 源 id（跨域桥改写到 /api/proxy 时带给服务端取源 Referer/UA） */
  sid?: string;
  /** server origin（空 = file:// 态 ⇒ 不注入 NET/HLS，保持旧行为） */
  origin?: string;
  /** hls.js 构建产物地址（vite `?url`，形如 /assets/hls.min-<hash>.js） */
  hlsAssetUrl?: string;
  /**
   * `#404` 追加注入到 `<head>` 末尾的片段（**RSS 启动页**用：`startStyle` + `java` 桥垫片）。
   * 普通正文不传 ⇒ 行为不变。
   */
  extraHead?: string;
  /** `#404` 追加注入到 `</body>` 前的片段（**RSS 启动页**用：`startJs`）。普通正文不传。 */
  extraBody?: string;
  /**
   * `#437` 存储垫片的**持久化快照** + 落盘键（只有**启动页**传）。
   * 见 {@link buildStorageShim}：不传 = 纯内存态（普通正文的旧行为）。
   */
  storageSnapshot?: string;
  storageKey?: string;
  /**
   * `#459` 是否给图片加「不超一屏高」的上限。**缺省 `true`**（`#212` 的 epub 语义）。
   * 图集类 RSS 文章传 `false`：见 {@link IMG_CSS} 的说明（`#432` 之后 `90vh` 真的会生效，
   * 竖长图会被压成半宽）。
   */
  capTallImages?: boolean;
}

/**
 * 给 HTML 正文补壳：文档补全 + 基础样式 + 高度回报 +（按需）跨域通路桥 / hls.js。
 * 与前端ReaderOverlay 的 `htmlDoc` computed 是同一份逻辑（抽到本模块前为逐字复制）。
 */
export function buildHtmlDoc(raw: string, opts: HtmlShellOpts = {}): string {
  if (!raw) return '';
  const base = opts.base ?? '';
  const tag = base ? '<base href="' + base + '">' : '';
  const hasHead = /<head[\s>]/i.test(raw);
  const META = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  // 跨域通路桥：只有确定 server origin 且正文含脚本才注入（纯图集/文本没有请求需求）
  const origin = opts.origin ?? '';
  const sid = opts.sid ?? '';
  const NET = origin && /<script/i.test(raw) ? '<script>' + buildNetBridge(origin, sid) + '<\/script>' : '';
  // `#345b` 动态资源改写桥（`#349` 起它成为**唯一**的资源改写点）：
  // 与 NET 分开（有 origin 就注入；盗链与「有没有脚本」无关）。
  // `decorateRssHtml` 已于 `#349` 从两条渲染通路撤除（装饰期改 `src` 会破坏 lazyload，实测 0/13），
  // 静态与动态资源统一在这里按「相对地址 + 懒加载 data-*」处理。
  const RES = origin ? '<script>' + buildResourceBridge(origin, sid, base) + '<\/script>' : '';
  /**
   * `#408` 正文页 `java` 垫片：**按内容特征自门控**（与 `bodyUsesHls` 同一思路）——
   * 只有页面脚本真的调用 WebView 型符号时才注入，普通正文一字不改。
   * 位置在 `NET` 之后：`importScriptAwait` 的 `fetch` 依赖 NET 桥的 `/api/proxy` 改写。
   *
   * `#446`（2026-10-14）**门控放宽一条**：除那 4 个播放器符号外，**页内出现 `java.某方法`
   * 也注入**。理由（千白羽论坛实测）：这类源的整页 UI 是源脚本自绘的，它们只用
   * `java.open` / `java.startBrowser` / `java.openUrl` 这类**动作类**能力（取返回/分类/
   * 一键跳转），一个播放器符号都没有 ⇒ 旧门控恒假 ⇒ 源里所有 `java.*` 全落空
   * （`goBack()` 三条兜底全失败，最后 `location.href` 把 iframe 甩到站点原始页）。
   */
  const RDR = /(?:importScriptAwait|webViewGetSourceAwait|openVideoPlayer|playu)\s*\(/.test(raw)
    || /\bjava\s*\.\s*[A-Za-z_$]/.test(raw)
    ? '<script>' + buildContentJavaShim({ origin, sid }) + '<\/script>'
    : '';
  // `#571` 文档写保护：**必须排在所有注入件与站点脚本之前**（见 `buildWriteGuard` 头注：
  // 163 的 redirect.js 在解析后 `document.write` ⇒ 隐式 open ⇒ 整页清空）。
  const WRITE_GUARD = '<script>' + buildWriteGuard() + '<\/script>';
  // `#364` 存储垫片：**无条件注入**（脚本内部自门控：非沙箱环境真访问不抛 ⇒ 零改动）。
  // 紧跟写保护之后 —— 站点脚本（body 里）按解析器顺序后执行，
  // 它们读 localStorage 时垫片必须已就位。
  const STORAGE = '<script>' + buildStorageShim({ snapshot: opts.storageSnapshot, key: opts.storageKey }) + '<\/script>';
  // `#336` 页内导航桥：**无条件注入**（只依赖 `parent.postMessage`，与 origin 无关）
  const NAV = '<script>' + buildNavBridge() + '<\/script>';
  // `#377①` 视口居中桥：**无条件注入**（浮层定位与 origin/媒体都无关）
  const LAYERVP = '<script>' + buildLayerViewportBridge() + '<\/script>';
  // `#432` 滚轮转发桥：**无条件注入**（不透明 origin 的 iframe 里滚轮滚不动外层 `.se-body`）
  const WHEEL = '<script>' + buildWheelBridge() + '<\/script>';
  // `#376` LIVE 媒体观察桥：**无条件注入**（只依赖 parent.postMessage；观察不到媒体
  // 就不发报文）。判据 source 来自 core media-shape 唯一实现（见 buildLiveMediaBridge 注释）。
  const LIVE = '<script>' + buildLiveMediaBridge(MEDIA_EXT_RE.source, MEDIA_HINT_RE.source) + '<\/script>';
  /**
   * `#583` 源自绘 UI：
   *  · `OPTIMG` **无条件注入**（内部只对带选项 JSON 的图片动手，普通图集/正文零影响）；
   *    必须排在 `RES` **之前** —— 它给按钮打标记，资源改写桥按标记跳过（见 `fixEl`）。
   *  · `SRUN` 只在页面真的调用 `qmRun`（评论面板的「加载更多 / 回复」）时注入。
   */
  const OPTIMG = '<script>' + buildImageOptionBridge() + '<\/script>';
  const SRUN = /\bqmRun\b/.test(raw) ? '<script>' + buildSourceRunBridge() + '<\/script>' : '';
  // hls.js：正文脚本调用 Hls API 但没自带库 ⇒ 注入静态资产（绝对地址，理由见文件头）
  const hlsUrl = opts.hlsAssetUrl ?? '';
  const HLS = origin && hlsUrl && bodyUsesHls(raw) && !bodyHasHlsLib(raw) ? '<script src="' + origin + hlsUrl + '"><\/script>' : '';
  const headInject =
    WRITE_GUARD + META + tag + '<style>' + buildStyle(opts.capTallImages !== false) + '</style>' +
    STORAGE + NAV + LAYERVP + WHEEL + LIVE + HLS + SRUN + OPTIMG + RES + NET + RDR + (opts.extraHead ?? '');
  /**
   * `#627` 字体回落只注入**脚本**（放在 `</head>` 之前）：
   * 脚本在 `document.fonts.ready` 后仅对 `status === "error"` 的 family
   * 才追加本地 `@font-face` 别名并改元素栈。
   * **不能静态预置别名** —— 同 family 的后声明会覆盖页面自带的 `@font-face`，
   * 那会在远端字体正常时也把页面字体换成本地字体。
   * 页面没有远程 `@font-face` ⇒ `planFontFallback` 返回 null ⇒ 一字不加。
   */
  const fontPlan = planFontFallback(raw);
  const fontInject = fontPlan ? '<script>' + fontPlan.script + '<\/script>' : '';
  const tailInject = opts.extraBody ?? '';
  if (/<html[\s>]/i.test(raw)) {
    // 已是完整文档：只在缺 head 时补一个；有 head 就把注入件插到开标签后
    let withHead = hasHead
      ? raw.replace(/<head([^>]*)>/i, '<head$1>' + headInject)
      : raw.replace(/<html([^>]*)>/i, '<html$1><head>' + headInject + fontInject + '</head>');
    if (hasHead && fontInject) {
      // 正常完整文档：插到 head 末尾；极少数没有 `</head>` 的残缺页则退回插在 head 开头
      withHead = /<\/head>/i.test(withHead)
        ? withHead.replace(/<\/head>/i, fontInject + '</head>')
        : withHead.replace(/<head([^>]*)>/i, '<head$1>' + headInject + fontInject);
    }
    // 回报脚本插在 body 闭合前；没有就追加到末尾
    return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, tailInject + '</body>') : withHead + tailInject;
  }
  return '<!doctype html><html><head>' + headInject + fontInject + '</head><body>' + raw + tailInject + '</body></html>';
}
