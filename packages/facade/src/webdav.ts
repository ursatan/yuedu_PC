/**
 * `#208` **WebDAV 客户端**（执行层）—— 逐条对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\lib\webdav\WebDav.kt`（487 行，2026-10-06 读源码提取）。
 *
 * 纯逻辑（地址/认证/文件名/进度合并）在 `@yuedu/core` 的 `webdav.ts` 与 `book-progress.ts`；
 * 本文件只做**网络动作 + XML 解析**，且**依赖注入 HTTP**（单测可打桩）。
 *
 * ## 上游语义（逐条）
 * - 列目录 = `PROPFIND` + 头 `Depth: 1`，请求体是 XML（指定要哪些属性）；
 *   ⚠️ `Depth: 0` 表示只问自己（上游 `getWebDavFile`）。
 * - 判存在 = `PROPFIND` + `Depth: 0` + 只问 `resourcetype`，**成功即存在**（`exists()` 用 `isSuccessful`）。
 * - 建目录 = `MKCOL`，且**先判存在**（已存在就不发）。
 * - 上传 = `PUT`（`overwrite=false` 时加 `If-None-Match: *`）。
 * - 删除 = `DELETE`。
 * - 成功判定用 okhttp 的 `isSuccessful`（**2xx**）⇒ PROPFIND 的 `207 Multi-Status` 也算成功。
 * - 失败时从响应体里抠 `<s:message>` / `<s:exception>`（`ObjectNotFound` 单独一类）。
 *
 * ## 与上游的两处**有意差异**（都写清理由，别当 bug 修回去）
 * 1. **`check()` 不再返回「失败即通过」**：上游是
 *    `runCatching { code != 401 }.getOrDefault(true)` ⇒ 网络不通时**回 true**（假通过，
 *    用户会以为「配置好了」而去点同步）。本仓返回**结构化结果**，把「密码错」和「连不上」分开。
 * 2. **XML 解析不再依赖「猜命名空间前缀」**：上游要 `findNSPrefix("DAV:")` 再拼标签名，
 *    遇到不声明前缀的服务器就抓瞎。这里直接用 `getElementsByTagNameNS('DAV:', …)`，
 *    拿不到再按 **localName** 兜底扫一遍（caddy / nginx / 坚果云 三种形态都能解）。
 */

import {
  PROPFIND_EXISTS_BODY,
  isWebDavDir,
  propfindDirBody,
  webDavBasicAuth,
  webDavRootOf,
  webDavUrlToHttp,
  type WebDavConfig,
  type WebDavFileInfo,
} from '@yuedu/core';
import { parseXml } from '@yuedu/core';
import type { HttpRequestOptions, HttpResponse } from '@yuedu/core';

/** 最小 HTTP 面（与 `createHttpClient()` 的 `request` 同形，便于打桩） */
export interface WebDavHttp {
  request(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface WebDavClientOptions {
  /** 注入 HTTP（默认 `createHttpClient()` 的即时任务；单测打桩） */
  http?: WebDavHttp;
  /** 单次请求超时（默认 30s —— WebDAV 的 PROPFIND 常常慢于普通 GET） */
  timeoutMs?: number;
}

/** WebDAV 错误（带上状态码与响应体片段，便于界面给出可行动文案） */
export class WebDavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'WebDavError';
  }
}

export type WebDavCheckResult =
  | { ok: true }
  | { ok: false; kind: 'unauthorized' | 'unreachable' | 'not-webdav'; detail: string };

/** okhttp `isSuccessful` = 2xx（PROPFIND 的 207 也在内） */
function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/** `URLDecoder.decodeForPath` 的等价物：解不开就原样返回（别让一个坏 href 炸掉整个列表） */
function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 把 PROPFIND 的 href 变成绝对地址（上游 `NetworkUtils.getAbsoluteURL`） */
function resolveHref(baseUrl: string, href: string): string {
  const h = decodePath(href);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h)) return h;
  if (h.startsWith('/')) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)/.exec(baseUrl);
    return `${m ? m[1] : ''}${h}`;
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${h}`;
}

/**
 * 取某个 DAV 属性的**原始 XML**（`resourcetype` 专用）。
 *
 * ★ 为什么 resourcetype 要取 html 而不是 text：目录的 `resourcetype` 是
 * `<d:collection/>` —— **空元素**，文本是空串，而上游判目录靠的就是
 * `resourceType.contains("collection")`（`WebDav.kt:207` 用的是 `html()`）。
 * 若这里退回 textContent，所有目录都会被判成文件。
 */
function davPropHtml(el: Element, localName: string): string | null {
  const nsHit = el.getElementsByTagNameNS('DAV:', localName)[0];
  if (nsHit) return nsHit.innerHTML ?? '';
  for (const child of Array.from(el.getElementsByTagName('*'))) {
    if ((child as Element).localName === localName) return child.innerHTML ?? '';
  }
  return null;
}

/** 取某个 DAV 属性的文本（先按 NS 精确取，再按 localName 兜底） */
function davProp(el: Element, localName: string): string | null {
  const nsHit = el.getElementsByTagNameNS('DAV:', localName)[0];
  if (nsHit) return nsHit.textContent ?? '';
  for (const child of Array.from(el.getElementsByTagName('*'))) {
    if ((child as Element).localName === localName) return child.textContent ?? '';
  }
  return null;
}

/**
 * 解析 `207 Multi-Status` 的响应体。
 *
 * @param body   XML 文本
 * @param baseUrl 被请求的那个地址（用于把相对 href 补成绝对地址）
 */
export function parsePropFind(body: string, baseUrl: string): WebDavFileInfo[] {
  const { document } = parseXml(body);
  let responses = Array.from(document.getElementsByTagNameNS('DAV:', 'response')) as Element[];
  if (responses.length === 0) {
    // 服务器没声明 DAV: 前缀（或用了别的别名）⇒ 按 localName 兜底
    responses = Array.from(document.getElementsByTagName('*')).filter(
      (e) => (e as Element).localName === 'response',
    ) as Element[];
  }
  const out: WebDavFileInfo[] = [];
  for (const el of responses) {
    const hrefRaw = davProp(el, 'href');
    if (hrefRaw == null) continue;
    const href = decodePath(hrefRaw);
    // 上游：`href` 为空时退回 `url.file.replace("/", "")`
    const fileName = href.replace(/\/$/, '').split('/').pop() ?? '';
    const displayNameRaw = davProp(el, 'displayname');
    const displayName = displayNameRaw && displayNameRaw.length > 0 ? decodePath(displayNameRaw) : fileName;
    const contentType = davProp(el, 'getcontenttype') ?? '';
    // ★ 目录的 resourcetype 是空元素 ⇒ 必须取 html（见 davPropHtml 的注释）
    const resourceType = davPropHtml(el, 'resourcetype') ?? '';
    const sizeRaw = davProp(el, 'getcontentlength');
    const size = sizeRaw ? Number(sizeRaw) : 0;
    const lastRaw = davProp(el, 'getlastmodified');
    const lastModify = lastRaw ? Date.parse(lastRaw) : Number.NaN;
    let url = resolveHref(baseUrl, href);
    const dir = isWebDavDir(contentType, resourceType);
    if (dir && !url.endsWith('/')) url = `${url}/`;
    out.push({
      url,
      displayName,
      urlName: href,
      size: Number.isFinite(size) ? size : 0,
      contentType,
      resourceType,
      lastModify: Number.isFinite(lastModify) ? lastModify : 0,
      isDir: dir,
    });
  }
  return out;
}

/** 从失败响应体里抠 `<s:message>`（上游 `checkResult` 的做法） */
function messageFromBody(body: string): string | null {
  if (!body) return null;
  try {
    const { document } = parseXml(body);
    for (const tag of ['message', 'exception']) {
      const hit = Array.from(document.getElementsByTagName('*')).find((e) => (e as Element).localName === tag);
      const text = hit?.textContent?.trim();
      if (text) return text;
    }
  } catch {
    /* 解析不了就走默认文案 */
  }
  return null;
}

/** 上游 `checkResult`：把非 2xx 变成带状态码与可读信息的错误 */
function throwForStatus(_url: string, res: HttpResponse): void {
  if (is2xx(res.status)) return;
  const raw = typeof res.body === 'string' ? res.body : '';
  const msg = messageFromBody(raw);
  if (res.status === 401) {
    const wwwAuth = res.headers?.['www-authenticate'] ?? res.headers?.['WWW-Authenticate'] ?? '';
    const supportsBasic = /^basic\b/i.test(wwwAuth.trim());
    // ★ 401 的两种真因必须分开说，否则用户只会一直重试密码
    if (wwwAuth && !supportsBasic) {
      throw new WebDavError(`服务器不接受 Basic 认证（它要的是：${wwwAuth.slice(0, 80)}）`, 401, raw.slice(0, 300));
    }
    throw new WebDavError('账号或密码不对（很多网盘要用「应用专用密码」，不是登录密码）', 401, raw.slice(0, 300));
  }
  throw new WebDavError(`${msg ?? '未知错误'}（HTTP ${res.status}）`, res.status, raw.slice(0, 300));
}

/** WebDAV 客户端（一个实例 = 一份配置；地址以「根」为基准） */
export class WebDavClient {
  /** 归一化后的根地址（已折算 dav(s)://、必带尾斜杠） */
  readonly root: string;

  constructor(
    readonly config: WebDavConfig,
    private readonly opts: WebDavClientOptions = {},
  ) {
    this.root = webDavRootOf(config);
  }

  private async http(): Promise<WebDavHttp> {
    if (this.opts.http) return this.opts.http;
    // 延迟引入：facade 的根出口连着 core 的 node 侧，但**本文件本身**不该在 import 期就把 HTTP 栈拉起来
    const { createHttpClient } = await import('@yuedu/core');
    return createHttpClient();
  }

  private authHeader(): Record<string, string> {
    return { Authorization: webDavBasicAuth(this.config.username, this.config.password, this.config.authEncoding) };
  }

  private async send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array; responseType?: 'text' | 'arraybuffer' },
  ): Promise<HttpResponse> {
    const http = await this.http();
    const target = webDavUrlToHttp(url);
    try {
      return await http.request(target, {
        method: init.method as HttpRequestOptions['method'],
        headers: { ...this.authHeader(), ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        timeout: this.opts.timeoutMs ?? 30_000,
        ...(init.responseType ? { responseType: init.responseType } : {}),
      } as HttpRequestOptions);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new WebDavError(`连接 WebDAV 失败：${reason}\n地址：${target}`);
    }
  }

  /** `PROPFIND`（返回原始 XML；调用方按需解析） */
  async propfind(url: string = this.root, depth: 1 | 0 = 1, extraProps: readonly string[] = []): Promise<string> {
    const res = await this.send(url, {
      method: 'PROPFIND',
      headers: { Depth: String(depth), 'Content-Type': 'text/plain' },
      body: depth === 0 ? PROPFIND_EXISTS_BODY : propfindDirBody(extraProps),
    });
    throwForStatus(url, res);
    return typeof res.body === 'string' ? res.body : '';
  }

  /**
   * 列出某个目录下的条目（**不含目录自己**，对齐上游 `it.path != path`）。
   * 目录不存在时上游会抛；这里同样抛（但错误带状态码，调用方可据此判定「目录还没建」）。
   */
  async listFiles(url: string = this.root): Promise<WebDavFileInfo[]> {
    const body = await this.propfind(url, 1);
    const self = webDavUrlToHttp(url).replace(/\/+$/, '');
    return parsePropFind(body, url).filter((f) => f.url.replace(/\/+$/, '') !== self);
  }

  /** 某个地址是否存在（上游 `exists()`：PROPFIND 成功即存在） */
  async exists(url: string = this.root): Promise<boolean> {
    let res: HttpResponse;
    try {
      res = await this.send(url, {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml' },
        body: PROPFIND_EXISTS_BODY,
      });
    } catch (e) {
      // ★ 404 = 不存在（正常返回 false）；**其它错误必须继续抛** ——
      //   若被吞成 false，`makeAsDir` 会以为「已经存在」而不建目录，用户看到的就是「同步了但远端什么都没有」。
      if (e instanceof WebDavError && e.status === 404) return false;
      throw e;
    }
    if (is2xx(res.status)) return true;
    if (res.status === 404) return false;
    throwForStatus(url, res);
    return false;
  }

  /**
   * 检查账号密码是否有效。
   *
   * ★ 与上游的差异见文件头：这里**不**把「连不上」当成「通过」，
   * 而是分成 `unauthorized`（密码错）/ `unreachable`（网络）/ `not-webdav`（地址不像 WebDAV）。
   */
  async check(): Promise<WebDavCheckResult> {
    try {
      const res = await this.send(this.root, {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml' },
        body: PROPFIND_EXISTS_BODY,
      });
      if (res.status === 401) return { ok: false, kind: 'unauthorized', detail: '账号或密码不对' };
      if (!is2xx(res.status)) {
        return { ok: false, kind: 'not-webdav', detail: `服务器返回 HTTP ${res.status}（这个地址是 WebDAV 目录吗？）` };
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof WebDavError && e.status === 401) {
        return { ok: false, kind: 'unauthorized', detail: e.message };
      }
      const detail = e instanceof Error ? e.message : String(e);
      return { ok: false, kind: 'unreachable', detail };
    }
  }

  /** 建目录（上游 `makeAsDir`：已存在则跳过） */
  async makeAsDir(url: string = this.root): Promise<boolean> {
    try {
      // ⚠️ `exists()` 对「非 404 的错误」是**抛**的（不吞），所以 try 必须把它也包进来 ——
      //    否则「服务器 500」会从这里一路抛出，把整个同步打断，而目录建不成其实不致命。
      if (await this.exists(url)) return true;
      const res = await this.send(url, { method: 'MKCOL' });
      throwForStatus(url, res);
      return true;
    } catch (e) {
      // ★ 留痕但不抛：建目录失败不该让「同步」整体失败 —— 有些网盘对已存在目录回 405，
      //   而内容其实能传。调用方看返回值决定要不要提示。
      console.warn(`[webdav] 创建目录失败（继续尝试同步）：${url} — ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 下载文件内容（文本按 UTF-8 解，二进制用 `downloadBytes`） */
  async downloadText(url: string): Promise<string> {
    const res = await this.send(url, { method: 'GET' });
    throwForStatus(url, res);
    return typeof res.body === 'string' ? res.body : new TextDecoder('utf-8').decode(res.body);
  }

  async downloadBytes(url: string): Promise<Uint8Array> {
    const res = await this.send(url, { method: 'GET', responseType: 'arraybuffer' });
    throwForStatus(url, res);
    if (typeof res.body === 'string') return new TextEncoder().encode(res.body);
    return new Uint8Array(res.body);
  }

  /** 上传（上游 `upload`：PUT；`overwrite=false` 时加 `If-None-Match: *`） */
  async upload(
    url: string,
    data: string | Uint8Array,
    contentType = 'application/octet-stream',
    overwrite = true,
  ): Promise<void> {
    const res = await this.send(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType, ...(overwrite ? {} : { 'If-None-Match': '*' }) },
      body: typeof data === 'string' ? data : data,
    });
    throwForStatus(url, res);
  }

  async remove(url: string): Promise<boolean> {
    const res = await this.send(url, { method: 'DELETE' });
    throwForStatus(url, res);
    return true;
  }

  /** 一次性把三个固定子目录建好（对齐上游 `upConfig()` 里连着建 4 个目录的动作） */
  async ensureDirs(): Promise<{ root: boolean; progress: boolean }> {
    const root = await this.makeAsDir(this.root);
    const progress = await this.makeAsDir(`${this.root.replace(/\/+$/, '')}/bookProgress/`);
    return { root, progress };
  }
}
