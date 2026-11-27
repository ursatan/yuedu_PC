/**
 * CORS 白名单 —— **判定在这里，装配在 `index.ts`**。
 *
 * 抽成纯模块的原因：`index.ts` 末尾有 `app.listen(...)` 副作用，**不能被测 import**
 * （本仓既有约定：可测逻辑放独立文件，如 `proxy-referer.ts` / `hls-playlist.ts`）。
 *
 * ---------------------------------------------------------------------------
 * ## 为什么必须收紧（2026-09-28，`#154`）
 *
 * 原实现是 `Access-Control-Allow-Origin: *`，而 `/api` **全程没有鉴权**。两条合起来意味着：
 * **用户在这台机器上打开的任意网页，都能读走**
 * `GET /api/user/snapshot`（书架 / 书签 / 高亮 / 阅读偏好）与
 * `GET /api/sources/<id>/login-info`（**源登录凭据**，该端点直接返回 `getSourceLoginInfo`、**没有掩码**）。
 * 服务端只绑 `127.0.0.1` ⇒ 外网进不来 —— 但「**本机任意网页**」不需要外网就能打进来。
 *
 * ## 为什么收紧不影响任何合法路径
 *
 * 前端 `apps/web/src/api.ts` 的 `BASE = '/api'` —— **全部走相对路径**：
 *   · 生产：服务端自己托管 `apps/web/dist` ⇒ 同源；
 *   · 开发：vite 的 `server.proxy` 把 `/api` 转发到 3000 ⇒ 浏览器看到的仍是 5173 同源；
 *   · Electron：`loadURL('http://127.0.0.1:<port>/')` ⇒ 同源。
 * ⇒ **同源请求根本不带 `Origin`**，与 CORS 无关。
 * （已核对：`apps/web/src` 里没有任何绝对地址去调 3000。）
 *
 * ## `'null'` 已删除（`#155`，2026-10-01）
 *
 * 曾经白名单里有 `'null'`：桌面端的「启动中」页是 `data:text/html`（不透明 origin ⇒ 请求带
 * `Origin: null`）。⚠️ 但不透明 origin 也能由「父页面嵌 `data:` iframe」**伪造** ⇒ 等于给
 * 本机任意页面开洞。`#155` 把离线页改成**真实文件 + 主进程轮询**（页面零脚本零请求，
 * `apps/desktop/main.js` 的 `startOfflineWatch`）⇒ 不再需要这个特例，**已删除**。
 * 若日后要恢复 `data:` 页，必须连着这条白名单一起恢复。
 *
 * ## 为什么保留 `localhost:5173`
 *
 * vite 走的是 `/api` **代理**而非直连，浏览器侧仍是同源 ⇒ 严格说不需要它。
 * 保留只为「谁临时绕过代理直连 3000」的调试场景，代价为零（localhost 已是本机信任域）。
 */

export const CORS_ALLOWED_ORIGINS: readonly string[] = [
  // ★ `'null'` 已随 `#155` 删除：离线页改为真实文件 + 主进程轮询（不再发任何跨源请求）。
  //   见上方「'null' 已删除」一节 —— 恢复 data: 离线页时必须连着它一起恢复。
  'http://127.0.0.1:5173', // vite 直连调试
  'http://localhost:5173',
];

/**
 * 该来源是否可放行。
 * @returns 要回显的 `Access-Control-Allow-Origin` 值（= 来源自身）；不在白名单则 `null`，
 *          调用方**一个 CORS 头都不要加**。
 *
 * ★ 刻意**回显来源而不是 `*`**：`*` 一旦写回去就等于把上一版的洞重新打开，
 *   所以这里没有任何「通配」分支，回归锁也钉死「返回值里绝不出现 `*`」。
 */
export function corsOriginFor(origin: string | undefined | null): string | null {
  if (typeof origin !== 'string' || origin === '') return null; // 同源请求 / 非浏览器调用
  return CORS_ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

/**
 * `#375` **`/api/proxy` 的 CORS 预检放行**（`Origin: null` 特例的预检半边）。
 *
 * 缺陷全链（2026-10-09 沙箱内 CDP 实证，yckceo 书源列表「生成」按钮）：
 *  ① 沙箱 srcdoc（opaque origin）里，站点 jQuery `$.get('/index/durl/add.html?…')`
 *     —— 相对 URL 被 jQuery 判成「同源」⇒ 自动加 `X-Requested-With` 头；
 *  ② NET 桥（`html-shell.ts` `#375` 半边）把 URL 改写到 `/api/proxy` ⇒ 请求变**跨源**，
 *     非简单头 ⇒ Chrome 先发 **OPTIONS 预检**；
 *  ③ 本 hook 对白名单外来源「一个 CORS 头都不加」但 **OPTIONS 仍 204 短路**
 *     ⇒ 预检响应没有任何 ACAO/ACAM/ACAH ⇒ 预检失败 ⇒ 真正的 GET 被 Chrome 拦下
 *     （`net::ERR_FAILED`）⇒ `$.get` 回调永不执行 ⇒ 站点静默（用户视角「点了没反应」）。
 *
 * ## 为什么放行不破 #154/#155 的收紧结论
 * `#326` 已给**实际响应**在 `Origin: null` 时回 `ACAO: null`（无凭据只读资源端点）。
 * 本函数只是把**同一个特例**补到预检半边 —— 预检通过与否不改变「谁能读到什么」：
 * 能过预检的请求，其 GET 本来就会拿到 ACAO:null 的响应。范围**只限 `/api/proxy`**
 * （快照 / 登录凭据等用户数据端点照旧一格不放），且 `ACAO` 回显 `null` 而非 `*`。
 *
 * @returns 预检响应该加的头（键保持规范大小写）；不满足特例 ⇒ `null`（调用方什么都不加）。
 */
export function corsPreflightFor(
  origin: string | undefined | null,
  method: string,
  url: string,
  reqAllowHeaders: string | string[] | undefined | null,
): Record<string, string> | null {
  if (method !== 'OPTIONS') return null;
  if (origin !== 'null') return null; // 只有沙箱 iframe 是这个形态；伪造面与 #326 的 GET 特例一致
  if (url.split('?')[0] !== '/api/proxy') return null; // 用户数据端点绝不放行
  // ACAM 只给 GET（本路由只有 GET）；ACAH 回显浏览器声明的头（jQuery 的 X-Requested-With 等），
  // 上限 256 字符防滥用 —— 超限按最普通的 content-type 处理（预检仍能过，多余头会被浏览器拒绝）。
  const allowHeaders =
    typeof reqAllowHeaders === 'string' && reqAllowHeaders.length > 0 && reqAllowHeaders.length <= 256
      ? reqAllowHeaders
      : 'content-type';
  return {
    'Access-Control-Allow-Origin': 'null',
    Vary: 'Origin',
    // `#418`：本路由多了 POST 半边（沙箱页 `java.ajax` 的 POST 出口，见 index.ts）⇒ 一并放行。
    // 只多开「方法」，可达主机与 GET 半边完全相同。
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
  };
}
