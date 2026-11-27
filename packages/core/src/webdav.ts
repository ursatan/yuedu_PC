/**
 * `#208` **WebDAV 的纯逻辑层**（零网络、零副作用）—— 逐条对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\lib\webdav\`（`WebDav.kt` / `Authorization.kt` /
 * `WebDavFile.kt`）与 `io\legado\app\help\AppWebDav.kt`（2026-10-06 读源码提取）。
 *
 * ## 它解决什么
 * 上游用 WebDAV 做两件事：**① 同步阅读进度**（每本书一个小 json，放在 `bookProgress/` 下）
 * ② **备份/恢复整库**（一个 `backup*.zip`）。本文件只提供「地址怎么拼、认证头怎么算、
 * 返回的文件条目长什么样」这些**确定性**的部分；真正的网络动作在 facade（`facade/src/webdav.ts`）。
 *
 * ## 上游语义（逐条，勿删）
 * - 根地址 `rootWebDavUrl`：配置为空时用内置 `https://dav.jianguoyun.com/dav/`；
 *   **必须以 `/` 结尾**；再拼上 `AppConfig.webDavDir`（子目录，非空则追加 `dir/`）。
 * - 固定三个子目录：`bookProgress/`（进度）· `books/`（导出）· `background/`（背景图）。
 * - 认证 = **HTTP Basic**（上游 `Credentials.basic`），头名恒 `Authorization`。
 * - 进度文件名 = `replaceReservedChar("${name}_${author}".normalizeFileName()) + ".json"`：
 *   · `normalizeFileName` = 把 `[\\/:*?"<>|]` 换成 `_`（**注意不含 `.`** —— 那是 `fileNameRegex` 才带）；
 *   · `replaceReservedChar` = 把 `% 空格 " # & ( ) + , / : ; < = > ? @ \ |` 逐个转成百分号转义。
 * - **进度只前进不后退**（`AppWebDav.kt:324-334`）：只有
 *   `remote.durChapterIndex > local.durChapterIndex ||
 *    (相等 && remote.durChapterPos > local.durChapterPos)` 才采用远端。
 * - `syncTime` 哨兵（`AppWebDav.kt:319`）：远端文件的 `lastModify <= book.syncTime` ⇒ 跳过不下载。
 *   ⚠️ 本仓 `ShelfBook.syncTime` **本来就有这个字段**（契约默认值 0，`user-map.ts` 里写「WebDAV 同步时间，本仓未做」）
 *   ⇒ 直接复用它，不再另开一份真相源。
 * - 判定「是不是目录」（`WebDavFile.isDir`）：`contentType == "httpd/unix-directory"`
 *   **或** `resourceType` 含 `collection`（大小写无关）。
 * - `dav://` / `davs://` 前缀要折算成 `http://` / `https://`（`WebDav.kt:87-88`）。
 *
 * ## 与上游的一处**有意差异**（写清楚，别当 bug 修回去）
 * **Basic 认证的编码**：上游用 `Credentials.basic(user, pass, ISO_8859_1)` —— ISO-8859-1 装不下中文，
 * 密码里有非拉丁字符时会被换成 `?` ⇒ 中文密码**必然 401**。本仓默认 **UTF-8**（RFC 7617 的现代做法，
 * 坚果云/Nextcloud/群晖 都按 UTF-8 解），同时保留 `authEncoding: 'iso-8859-1'` 开关，
 * 万一某个老服务器只认拉丁1，用户可切回去。
 */

/** 上游 `AppWebDav.defaultWebDavUrl` */
export const WEBDAV_DEFAULT_URL = 'https://dav.jianguoyun.com/dav/';

/** 上游三个固定子目录名（相对根） */
export const WEBDAV_DIRS = {
  /** 阅读进度 */
  progress: 'bookProgress',
  /** 导出的书 */
  books: 'books',
  /** 背景图 */
  background: 'background',
} as const;

/** 配置项（对外形态；密码只在「写入」时出现，读回时一律抹掉） */
export interface WebDavConfig {
  /** 根地址（可空 ⇒ 用内置默认）。可带 `dav://` / `davs://` 前缀 */
  url: string;
  username: string;
  password: string;
  /** 子目录（上游 `AppConfig.webDavDir`）；空 = 直接落在根 */
  dir: string;
  /** Basic 认证的字节编码，默认 `utf-8`（为什么不是上游的 ISO-8859-1：见文件头） */
  authEncoding: 'utf-8' | 'iso-8859-1';
}

/** 空配置（界面初始态 / 未配置） */
export function emptyWebDavConfig(): WebDavConfig {
  return { url: '', username: '', password: '', dir: '', authEncoding: 'utf-8' };
}

/** 抹掉密码（**任何**对外的响应都必须过一遍这个函数 —— 界面回显密码是安全事故） */
export function publicWebDavConfig(cfg: WebDavConfig): WebDavConfig & { hasPassword: boolean } {
  return { ...cfg, password: '', hasPassword: cfg.password.length > 0 };
}

/** PROPFIND 请求体：列出目录（上游 `WebDav.DIR`） */
export function propfindDirBody(extraProps: readonly string[] = []): string {
  const props = extraProps.map((p) => `<a:${p}/>\n`).join('');
  return `<?xml version="1.0"?>
<a:propfind xmlns:a="DAV:"><a:prop><a:displayname/><a:resourcetype/><a:getcontentlength/><a:creationdate/><a:getlastmodified/>${props}</a:prop></a:propfind>`;
}

/** PROPFIND 请求体：只问「在不在」（上游 `WebDav.EXISTS`） */
export const PROPFIND_EXISTS_BODY =
  '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype /></prop></propfind>';

/** 上游 `WebDavFile.isDir` */
export function isWebDavDir(contentType: string, resourceType: string): boolean {
  return contentType === 'httpd/unix-directory' || resourceType.toLowerCase().includes('collection');
}

/** 目录列表里的一项（上游 `WebDavFile` 的只读投影） */
export interface WebDavFileInfo {
  /** 完整地址（目录则保证以 `/` 结尾，对齐上游 `parseBody` 的补斜杠） */
  url: string;
  /** 展示名（上游 `displayname`，缺失时退回从 href 末段取的文件名） */
  displayName: string;
  /** href 原文（已 URL 解码） */
  urlName: string;
  size: number;
  contentType: string;
  resourceType: string;
  /** 最后修改时间（毫秒；解析不出为 0 —— 上游也是这个回落值） */
  lastModify: number;
  isDir: boolean;
}

/** `dav://` / `davs://` → `http://` / `https://`（上游 `WebDav.httpUrl`） */
export function webDavUrlToHttp(path: string): string {
  return path.replace(/^davs:\/\//i, 'https://').replace(/^dav:\/\//i, 'http://');
}

/** 上游 `String.normalizeFileName()`（`AppPattern.fileNameRegex2 = [\\/:*?"<>|]`） */
export function normalizeWebDavFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

/** 上游 `UrlUtil.replaceReservedChar()` —— 逐字符照抄，顺序无关 */
const RESERVED_CHAR_MAP: ReadonlyArray<readonly [string, string]> = [
  ['%', '%25'],
  [' ', '%20'],
  ['"', '%22'],
  ['#', '%23'],
  ['&', '%26'],
  ['(', '%28'],
  [')', '%29'],
  ['+', '%2B'],
  [',', '%2C'],
  ['/', '%2F'],
  [':', '%3A'],
  [';', '%3B'],
  ['<', '%3C'],
  ['=', '%3D'],
  ['>', '%3E'],
  ['?', '%3F'],
  ['@', '%40'],
  ['\\', '%5C'],
  ['|', '%7C'],
];

export function replaceReservedChar(text: string): string {
  let out = text;
  for (const [ch, esc] of RESERVED_CHAR_MAP) out = out.split(ch).join(esc);
  return out;
}

/** 上游 `getProgressFileName()` —— 进度 json 的文件名（已含 `.json`） */
export function bookProgressFileName(name: string, author: string): string {
  return `${replaceReservedChar(normalizeWebDavFileName(`${name ?? ''}_${author ?? ''}`))}.json`;
}

/** 上游 `rootWebDavUrl`：补尾斜杠 + 追加子目录 */
export function normalizeWebDavRoot(url: string | undefined | null, dir?: string | undefined | null): string {
  let base = (url ?? '').trim();
  if (!base) base = WEBDAV_DEFAULT_URL;
  base = webDavUrlToHttp(base);
  if (!base.endsWith('/')) base = `${base}/`;
  const sub = (dir ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return sub ? `${base}${sub}/` : base;
}

/** 从配置取根地址（顺手把 `dav(s)://` 折算掉） */
export function webDavRootOf(cfg: Pick<WebDavConfig, 'url' | 'dir'>): string {
  return normalizeWebDavRoot(cfg.url, cfg.dir);
}

/** 某个子目录的地址（保证以 `/` 结尾） */
export function webDavSubDir(root: string, name: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  const n = name.replace(/^\/+/, '').replace(/\/+$/, '');
  return n ? `${base}${n}/` : base;
}

/** 进度目录（`bookProgress/`） */
export function webDavProgressRoot(root: string): string {
  return webDavSubDir(root, WEBDAV_DIRS.progress);
}

/** 单本书进度文件的完整地址（上游 `getProgressUrl`） */
export function bookProgressUrl(root: string, name: string, author: string): string {
  return `${webDavProgressRoot(root)}${bookProgressFileName(name, author)}`;
}

/** 根下的一个普通成员（备份文件名之类） */
export function webDavRootFile(root: string, fileName: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return `${base}${String(fileName ?? '').replace(/^\/+/, '')}`;
}

/**
 * Basic 认证头的值（上游 `Authorization.data` = `Credentials.basic(...)` 的结果）。
 *
 * `btoa` 在 Node ≥16 与浏览器里都是全局可用的；这里先把字符串按选定编码转成**字节**，
 * 再把每个字节当成一个 latin1 字符喂给 `btoa`（否则多字节字符会被 `btoa` 直接拒绝）。
 */
export function webDavBasicAuth(username: string, password: string, encoding: 'utf-8' | 'iso-8859-1' = 'utf-8'): string {
  const raw = `${username}:${password}`;
  const bytes = new Uint8Array(raw.length * (encoding === 'utf-8' ? 4 : 1));
  let n = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (encoding === 'utf-8') {
      const enc = new TextEncoder().encode(raw[i] as string);
      for (const b of enc) bytes[n++] = b;
    } else {
      // ISO-8859-1：装不下的字符按 Java 的做法落到 `?`（**刻意**与上游一致，方便对照排障）
      bytes[n++] = code <= 0xff ? code : 0x3f;
    }
  }
  let latin1 = '';
  for (let i = 0; i < n; i += 1) latin1 += String.fromCharCode(bytes[i] as number);
  return `Basic ${btoa(latin1)}`;
}

/**
 * 配置校验（对齐 `AppWebDav.upConfig()` 的门槛：**账号与密码都非空**才算配置了）。
 *
 * ⚠️ **只校验字段，不校验网络可达性** —— 与直链上传同一分工：能不能连上靠「测试」按钮。
 * 这样用户可以先填完再点测试，而不是「不填完不让测」。
 */
export type WebDavConfigResult = { ok: true; config: WebDavConfig } | { ok: false; error: string };

export function validateWebDavConfig(raw: unknown): WebDavConfigResult {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '配置必须是一个 JSON 对象' };
  }
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const username = str(o['username']).trim();
  const password = str(o['password']);
  // 密码**不 trim**：空格可能是密码的一部分（很多人用带空格的口令）
  if (!username) return { ok: false, error: '账号不能为空' };
  if (!password) return { ok: false, error: '密码不能为空（WebDAV 多数服务用「应用专用密码」，不是登录密码）' };
  const encRaw = str(o['authEncoding']).trim();
  const authEncoding: WebDavConfig['authEncoding'] = encRaw === 'iso-8859-1' ? 'iso-8859-1' : 'utf-8';
  const url = str(o['url']).trim();
  if (url && !/^(https?|davs?):\/\//i.test(url)) {
    return { ok: false, error: '地址要以 http(s):// 或 dav(s):// 开头' };
  }
  return { ok: true, config: { url, username, password, dir: str(o['dir']).trim(), authEncoding } };
}
