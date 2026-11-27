/**
 * okhttp `Headers` 的 JS 视图 —— **唯一实现**（宿主 L1 与 worker 共用同一份源码）。
 *
 * ## 缺陷类别（`#409`，2026-10-12 实测）
 * Legado 的 `java.ajax/connect/get/post/head` 返回 `StrResponse`，其 `headers()` 是
 * **okhttp `Headers`**（`get / names / values / size / toMultimap`）。本仓此前只有
 * 「规则桥那条路」（`StrResponse` 工厂）实现了这个视图，而**同步 HTTP 出口（L1 的
 * `syncHttp`、worker 的 `strResponse`）返回的是普通对象** ⇒ 源脚本一写
 * `java.connect(u).headers().values('Set-Cookie')` 就抛
 * `TypeError: ....values is not a function`。
 *
 * 真源取证（18AV，用户语料）：其 jsLib 的 `rrcheck()` 用
 * `java.connect(url19).headers().values("Set-Cookie")` 过「年满18岁声明」闸（Discuz
 * `#fwin_dialog_submit` 的 onclick 里带目标 URL）。`values` 缺失 ⇒ rrcheck 抛错 ⇒
 * 列表规则整段失败 ⇒ 用户可见症状 = **分类下「无内容卡片」+ `SELECTOR_MISS@parse`**。
 *
 * 语料面（`data/sources/`）：`headers().values/get/names/toMultimap` 共 **3 处 / 2 源**
 * （另有用户导入源 18AV）⇒ 不是孤例。
 *
 * ## 为什么写成「源码串 + 宿主也编译一份」
 * worker 内的 java 桩在 `WORKER_SRC` 里以字符串求值，无法 import TS 函数。若两侧各写一份
 * 必然漂移（本仓已有 `JSON_MAP_METHODS_SOURCE` / `URL_PREP_SOURCE` 两条同样的先例）。
 * ⚠️ 本串内**不能出现反引号**，也不能出现 `${`（会截断外层模板）。
 *
 * ## 与旧行为的兼容（零回归）
 * 视图对象**同时把小写键平铺成属性**（`headers()['content-type']` 这种旧写法照旧可用），
 * 并且 `toMultimap()` 保持既有实现的口径（小写键 → 字符串），不改成 okhttp 的
 * 「键 → 数组」——那是**已经线上跑着**的语义，改它会静默破坏依赖它的源。
 */
export const OK_HEADERS_SOURCE = String.raw`
function __yueduOkHeaders(headers) {
  var lower = {};
  if (headers && typeof headers === 'object') {
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k)) {
        lower[String(k).toLowerCase()] = String(headers[k] == null ? '' : headers[k]);
      }
    }
  }
  var view = {};
  for (var k2 in lower) view[k2] = lower[k2];
  view.get = function (n) { var v = lower[String(n).toLowerCase()]; return v === undefined ? null : v; };
  view.size = function () { return Object.keys(lower).length; };
  view.names = function () { return Object.keys(lower); };
  view.values = function (n) { var v = lower[String(n).toLowerCase()]; return v === undefined ? [] : [v]; };
  view.toMultimap = function () { var o = {}; for (var k3 in lower) o[k3] = lower[k3]; return o; };
  view.toString = function () {
    var s = [];
    for (var k4 in lower) s.push(k4 + ': ' + lower[k4]);
    return s.join(String.fromCharCode(10));
  };
  return view;
}`;

/** 宿主侧编译结果（懒编译一次，全进程复用） */
let compiled: ((h: Record<string, string> | undefined) => Record<string, unknown>) | null = null;

/** 宿主 L1 用：把响应头压成 okhttp `Headers` 视图 */
export function okHeaders(headers?: Record<string, string> | null): Record<string, unknown> {
  if (!compiled) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    compiled = new Function(`${OK_HEADERS_SOURCE}; return __yueduOkHeaders;`)() as typeof compiled;
  }
  return (compiled as (h: Record<string, string> | undefined) => Record<string, unknown>)(headers ?? {});
}