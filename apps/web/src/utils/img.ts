/**
 * 图片/封面地址 → **服务端代理地址**（`/api/proxy`）。
 *
 * 为什么统一走代理（2026-09-23 用户实测 ②）：
 *  ① **防盗链**：图站只认站点自己的 Referer/UA。实测 📷🔞学姐吧 同一张封面 ——
 *     带 `Referer: https://xuejieba2026.com` → 200 / 61394 字节；
 *     浏览器直连（Referer = 本应用地址）→ **404 text/html** ⇒ 被 `@error` 隐藏 ⇒ 用户看到「无封面」。
 *  ② **源声明的图片二次解密**（Legado `imageDecode` / `coverDecodeJs`）浏览器跑不了源 JS，
 *     必须带 `sid` 交给服务端解。
 *  ③ **动图（gif/webp/avif）原样显示**：服务端只做「解密 + 按魔数纠正 content-type」，
 *     **不做任何转码**；上游把动图当 `application/octet-stream` 返回时，纠正后才不会被浏览器当静态图。
 *  ④ **本机 IP 不外泄**：上游只看到服务端地址。
 *
 * 代理侧同时复用引擎的**网络护栏**（并发 6 / 单主机 2 / 带宽 30% / 体积 8MB），
 * 所以一页几十张封面也不会把线路打满（用户实测过该自伤形态）。
 *
 * @param url      原始图片地址
 * @param opts.sourceId 源 id（= `bookSourceUrl`）：用于取源头 Referer/UA/Cookie 与图片解密
 * @param opts.referer  显式 Referer（可选；不给时服务端按「源 header → 源站点 origin → 图片 origin」解析）
 * @param opts.cover    标记为封面（源的 `coverDecodeJs` 与 `imageDecode` 是两套规则）
 */
/**
 * `#405①` 拆开图片地址尾部的 `,{...}` **选项尾巴**（Legado 语法，**上游在图片加载器里拆**）。
 *
 * 咚漫 `ruleSearch.coverUrl` 尾段 `@js:` 追加了 `,{"headers":"{\"Referer\":…}"}` ⇒ cover 串
 * 形如 `https://cdn…/x.jpg?x-oss-process=…,{"headers":"{\"Referer\":\"https://m…/dailySchedule\"}"}`。
 * 上游：Glide 的 String 经 `AnalyzeUrl`（`OkHttpStreamFetcher.kt:71-79`）→ `url` 取逗号前、
 * headers 由 `UrlOption.getHeaderMap()` 带上（封面跨域 Referer 由此生效）。
 * 本仓不拆这条 ⇒ 整串当 `<img src>` = 非法 URL ⇒ 封面 404/塌缩。
 *
 * 解析失败 ⇒ **原样返回**（不改未知形态）；解析成功 ⇒ 去掉尾巴、取出 Referer。
 * ⚠️ 只认 `,{`（Legado 选项形态）：图片 URL 里的 `,`（`x-oss-process=…,limit_0`）后面不是 `{`，不受影响。
 */
export function splitImageUrlTail(url: string): { url: string; referer?: string; host?: string; dnsIp?: string } {
  const m = /\s*,\s*(?=\{)/.exec(url);
  if (!m) return { url };
  const head = url.slice(0, m.index).trim();
  let optStr = url.slice(m.index + m[0].length);
  // 尾巴可能被百分号编码（与引擎 `cutUrlOptionsTail` 同款粗还原）
  if (/%7B/i.test(optStr)) optStr = optStr.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/%22/g, '"');
  let opt: unknown;
  try {
    opt = JSON.parse(optStr);
  } catch {
    return { url };
  }
  if (!opt || typeof opt !== 'object') return { url };
  const rawHeaders = (opt as { headers?: unknown }).headers;
  let headers: Record<string, unknown> | undefined;
  if (typeof rawHeaders === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawHeaders);
      if (parsed && typeof parsed === 'object') headers = parsed as Record<string, unknown>;
    } catch { /* headers 串坏了 ⇒ 只取主 URL */ }
  } else if (rawHeaders && typeof rawHeaders === 'object') {
    headers = rawHeaders as Record<string, unknown>;
  }
  let referer: string | undefined;
  let host: string | undefined;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'referer' && typeof v === 'string' && v) referer = v;
      // `#742` 源侧「IP 进 URL + Host 头」形态（哔咔封面 `http://<CF IP>/…` + `Host: storage-b…`）
      if (k.toLowerCase() === 'host' && typeof v === 'string' && v) host = v;
    }
  }
  /**
   * `#742` 图片也可以要 IP 直连（`{"dnsIp":"104.21.235.3"}`）：代理侧据此建连接，
   * 而 Host/SNI 仍按 `u` 的域名 —— 与 `curl --resolve` 等价。
   */
  const optDnsIp = (opt as { dnsIp?: unknown }).dnsIp;
  const dnsIp = typeof optDnsIp === 'string' && optDnsIp.trim() ? optDnsIp.trim() : undefined;
  return { url: head, ...(referer ? { referer } : {}), ...(host ? { host } : {}), ...(dnsIp ? { dnsIp } : {}) };
}

/**
 * `#702` 图片代理的**另一 origin**（`''` = 同源）。
 *
 * 为什么要换：浏览器对**同一个 origin** 只有 6 条 HTTP/1.1 连接，而图片全部走同源
 * `/api/proxy` ⇒ 一页几十张慢图会把 6 条全占住，心跳 `/api/engines` 连不上
 * ⇒ 侧栏误报「服务离线」。改由 `localhost`/`127.0.0.1` 这对**同机不同源**的主机名分担，
 * 图片吃自己那 6 条，接口不受影响。完整论证与自检见 `utils/image-origin.ts`。
 *
 * ⚠️ 只影响**图片**（本文件是唯一入口）；`/api/*` 的业务请求一律仍走同源相对地址。
 */
let imageProxyOrigin = '';
/** 设置/清除图片代理 origin（`''` = 同源；由 `resolveImageProxyOrigin()` 在启动时自检后调用） */
export function setImageProxyOrigin(origin: string): void {
  imageProxyOrigin = String(origin ?? '').replace(/\/+$/, '');
}
/** 当前图片代理 origin（探针/测试用；业务代码不需要读） */
export function imageProxyOriginValue(): string {
  return imageProxyOrigin;
}

/**
 * `#750` 封面地址变更时的策略：**换书**必须清空旧图（`#176`「切分类残留上一本封面」），
 * **同一本书自己的封面升级**（七猫：列表 `_288x384` → 详情 `_600x800`，上游
 * `BookInfo.kt:142-148` 的「非空才替换」）则保留旧图占位，新图到了再替换。
 *
 * 抽成纯函数是为了回归锁：判断错只会「闪一下」，不会报错，肉眼很容易漏。
 *
 * @param prevOwner 上一帧的「书身份」（见 CoverImage 的 `ownerKey`：`sourceId\u0000原始标题`）
 * @param nextOwner 本帧的「书身份」
 * @param prevShown 上一帧**已经显示成功**的图片地址（空 = 还没有可用旧图）
 */
export type CoverSwap = 'reset' | 'keep-old';
export function coverSwapMode(prevOwner: string, nextOwner: string, prevShown: string): CoverSwap {
  if (!prevShown) return 'reset';          // 旧图还没成功 ⇒ 没得占位
  if (!prevOwner || !nextOwner) return 'reset'; // 身份未知 ⇒ 保守清空（宁闪不可错书）
  if (prevOwner !== nextOwner) return 'reset';  // 换书
  return 'keep-old';
}

export function imgSrc(
  url: unknown,
  opts: { sourceId?: string; referer?: string; cover?: boolean } = {},
): string {
  const split = splitImageUrlTail(String(url ?? '').trim());
  const u = split.url;
  if (!u) return '';
  /**
   * `#441` **`data:image/…` 带源 id 时也走代理**（源可能声明了图片解密规则）。
   *
   * 实测（91视频）：封面/正文图片的 `src` 是 `data:image/jpeg;base64,<AES-ECB 密文>`，
   * 站点靠自己的 JS 解密后才渲染 —— 直连渲染就是裂图。服务端 `/api/proxy` 已支持
   * `u=data:image/…`（base64 解字节 → 跑源解密规则 → 回图）；这里只负责把它送过去。
   * ⚠️ 判据必须带 `sourceId`：主题壁纸 / 本地书插图这类**没有源上下文**的内联图保持原样
   * （不吃这一跳，也不受源规则影响）。
   */
  const inlineImage = /^data:image\//i.test(u) && !!opts.sourceId;
  // 内联/本地资源不需要代理
  if (!inlineImage && (/^(data:|blob:)/i.test(u) || u.startsWith('/'))) return u;
  if (!inlineImage && !/^https?:\/\//i.test(u)) return u;
  let uHost = '';
  try {
    uHost = new URL(u).hostname.toLowerCase();
  } catch { /* 非法 URL 交给下游原样处理 */ }
  const p = new URLSearchParams({ u });
  if (opts.sourceId) p.set('sid', opts.sourceId);
  // 显式 referer 优先；否则用选项尾巴里的 Referer（`#405①`：咚漫封面靠它过防盗链）
  const referer = opts.referer ?? split.referer;
  if (referer) p.set('r', referer);
  /**
   * `#742` 源侧「**IP 进 URL + `Host` 头**」形态（哔咔封面
   * `http://<CF IP>/static/…,{"headers":{"Host":"storage-b.picacomic.com"}}`）：
   * **不把 Host 头硬塞给代理**，而是还原成「域名 URL + `dnsIp=<该 IP>`」——
   * 这样 Host 与 TLS SNI 都由域名天然决定（实测：IP 进 URL 时 CF 回 `error code: 1003`，
   * 域名 + dnsIp 则正常命中，见 `tmp/probe742-host2.mts` 的 403 vs 404）。
   * 判据：主 URL 的主机是**IP 字面量**且选项给了 `Host`。
   *
   * 协议**一律用 `https`**（即使源写的是 `http://<IP>/…`）：实测同一张真实封面
   * `https://storage-b…` + dnsIp → **200 / 207799B / 1058ms**，
   * 换成 `http://storage-b…` + dnsIp → **20s 超时**（CF 的 80 端口在本网络走不通）。
   * 走 https 也更安全：只换地址、不改主机名。
   */
  const ipLiteral = /^(?:(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\])$/;
  let finalUrl = u;
  let finalDnsIp = split.dnsIp;
  if (split.host && ipLiteral.test(uHost)) {
    const mm = /^https?:\/\/[^/?#]+(\/.*)?$/i.exec(u);
    if (mm) {
      finalUrl = `https://${split.host}${mm[1] ?? '/'}`;
      finalDnsIp = split.dnsIp ?? uHost.replace(/^\[|\]$/g, '');
    }
  }
  p.set('u', finalUrl);
  // `#742` IP 直连（只改域名→地址；Host/SNI 仍按上面还原来域名）
  if (finalDnsIp) p.set('dnsIp', finalDnsIp);
  // 兜底：非「IP 进 URL」形态时，源显式给的 Host 仍原样带给代理（不影响 CF 以外站点）
  else if (split.host) p.set('h', split.host);
  if (opts.cover) p.set('cover', '1');
  // `#702`：`imageProxyOrigin` 非空时给出**绝对地址**（换 origin，独占另一组连接）
  return `${imageProxyOrigin}/api/proxy?${p.toString()}`;
}
