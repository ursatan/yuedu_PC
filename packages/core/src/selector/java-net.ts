/**
 * `#605` **`java.net.URL` + `HttpURLConnection`** 及其配套流（上游是真 JDK 类，这里按 JDK 契约移植）。
 *
 * ## 为什么需要
 * 番茄系（🍅番茄小说(APP) / 🍅番茄漫画(APP)）与花花短剧不做 `java.ajax`，而是**手写 HTTP 客户端**：
 *
 * ```js
 * var c = new Packages.java.net.URL(url).openConnection();
 * c.setRequestMethod('POST'); c.setDoOutput(true);
 * for (var k in headers) c.setRequestProperty(k, headers[k]);
 * c.setConnectTimeout(20000); c.setReadTimeout(25000);
 * var out = c.getOutputStream(); out.write(bytes, 0, bytes.length); out.flush(); out.close();
 * var code = c.getResponseCode();
 * var is = (code >= 400) ? c.getErrorStream() : c.getInputStream();
 * var enc = String(c.getHeaderField('Content-Encoding') || '');
 * if (enc.indexOf('gzip') >= 0) is = new Packages.java.util.zip.GZIPInputStream(is);
 * var rd = new Packages.java.io.BufferedReader(new Packages.java.io.InputStreamReader(is, 'UTF-8'));
 * while ((line = rd.readLine()) != null) sb += String(line);
 * ```
 *
 * 本仓此前 `java.net` 整个命名空间落到兜底 Proxy ⇒ `new URL(url)` 得到一个「调用返回空串的函数」
 * ⇒ `openConnection is not a function`（全量基线 2026-10-24 `#605`，番茄漫画等 6 源）。
 *
 * ## 设计要点
 * 1. **惰性发请求**：`openConnection()` 不发；`getResponseCode()/getInputStream()/connect()` 才发，
 *    这样才能先 `setRequestProperty` + 写完 body（JDK 就是这个时序）。
 * 2. **传输注入**：本模块不碰 fetch（L1 用同步 curl/worker、worker 用宿主 RPC），
 *    由 `wireJavaNetTransport` 注入一条 `(req) => {code,headers,body}`。
 * 3. **字节优先**：连接体一律 `Uint8Array`；`BufferedReader` 再按 charset 解码（只做 utf-8/gbk 两种，
 *    语料里就这两种）。
 * 4. 未实现的 `Socket` / `InetSocketAddress` / `InetAddress`（速读谷的连通性探测）**不假装**：
 *    仍是兜底空串，但 `net` 命名空间里挂一个显式留痕，避免「静默 0 延迟」被当成正常。
 */

/** `node:zlib` 的 gunzip（静态 import：本包是 ESM，`require` 在 tsx/打包产物里不可用） */
import { gunzipSync } from 'node:zlib';

/** 传输请求（由宿主注入；与 `java.ajax` 同一条出口，避免「同一 URL 两种取法」漂移） */
export interface JavaNetRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  connectTimeoutMs: number;
  readTimeoutMs: number;
}

export interface JavaNetResponse {
  code: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type JavaNetTransport = (req: JavaNetRequest) => JavaNetResponse;

let transport: JavaNetTransport | null = null;

/** 注入传输（L1：同步 curl/worker；worker：rpc 回宿主）。传 `null` 复位（测试用）。 */
export function wireJavaNetTransport(fn: JavaNetTransport | null): void {
  transport = fn;
}

/** 没有注入传输时的兜底：明确失败（不静默返回空 body，否则「响应 0 字节」会被当成功） */
const noTransport: JavaNetTransport = () => {
  throw new Error('java.net.URL：当前求值路径没有注入同步传输（L1 用 syncHttp，worker 用 rpc）');
};

/* ---------------- 字节工具 ---------------- */

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v.map((x) => Number(x) & 0xff));
  return new Uint8Array(0);
}

/** 语料只出现 utf-8 / gbk（番茄系个别接口回 GBK）；其余按 utf-8 兜底 */
function decodeWithCharset(bytes: Uint8Array, charset: string): string {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/[-_]/g, '');
  if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      /* 运行时不支持 gbk：退回 utf-8（宁可乱码也不炸） */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------- 流 ---------------- */

/** `java.io.InputStream` 的最小可读面（`read()/read(byte[])/available()/skip()/close()`） */
function makeInputStream(bytes: Uint8Array): Record<string, unknown> {
  let pos = 0;
  return {
    read: (buf?: unknown, off?: unknown, len?: unknown): number => {
      if (buf == null) return pos < bytes.length ? bytes[pos++]! : -1; // 无参：返回 int（-1 = EOF）
      const target = toBytes(buf) as Uint8Array;
      const o = Number(off ?? 0) || 0;
      const n = len == null ? target.length - o : Number(len) || 0;
      if (pos >= bytes.length) return -1;
      const take = Math.max(0, Math.min(n, bytes.length - pos, target.length - o));
      for (let i = 0; i < take; i++) target[o + i] = bytes[pos + i]!;
      pos += take;
      return take;
    },
    available: (): number => bytes.length - pos,
    skip: (n: unknown): number => {
      const t = Math.max(0, Math.min(Number(n) || 0, bytes.length - pos));
      pos += t;
      return t;
    },
    close: (): void => {
      pos = bytes.length;
    },
    _bytes: bytes,
  };
}

/** `java.util.zip.GZIPInputStream`：读全部 → gunzip → 当普通 InputStream（无 gzip 头则原样） */
function makeGzipInputStream(inner: unknown): Record<string, unknown> {
  const src = (inner as { _bytes?: Uint8Array } | null)?._bytes;
  if (!src) return makeInputStream(new Uint8Array(0));
  /* 1f 8b = gzip 魔数；不是 gzip 就原样透传（上游会抛 ZipException，这里更宽容：源常无条件包一层） */
  if (src.length < 2 || src[0] !== 0x1f || src[1] !== 0x8b) return makeInputStream(src);
  try {
    return makeInputStream(new Uint8Array(gunzipSync(Buffer.from(src))));
  } catch {
    return makeInputStream(src);
  }
}

/* ---------------- URL / URLConnection ---------------- */

interface ParsedUrl {
  protocol: string;
  host: string;
  port: number;
  path: string;
  file: string;
  query: string;
  ref: string;
  authority: string;
  userInfo: string;
}

function parseUrl(raw: string): ParsedUrl {
  const empty: ParsedUrl = { protocol: '', host: '', port: -1, path: '', file: '', query: '', ref: '', authority: '', userInfo: '' };
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw);
  if (!m) return { ...empty, path: raw, file: raw };
  const protocol = (m[1] ?? '').toLowerCase();
  const authority = m[2] ?? '';
  const path = m[3] || '/';
  const query = m[4] ?? '';
  const ref = m[5] ?? '';
  const userInfo = authority.includes('@') ? (authority.split('@')[0] ?? '') : '';
  const hostPort = authority.split('@').pop() ?? '';
  /* IPv6 字面量：[::1]:8080 */
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(hostPort);
  const host = v6 ? (v6[1] ?? '') : hostPort.replace(/:\d+$/, '');
  const portRaw = v6 ? (v6[2] ?? '') : (/:(\d+)$/.exec(hostPort)?.[1] ?? '');
  const port = portRaw ? Number(portRaw) : -1;
  return { protocol, host, port, path, file: query ? `${path}?${query}` : path, query, ref, authority, userInfo };
}

/** `new java.net.URL(str)` 的实例面（JDK `URL` 的 getter 全覆盖） */
function makeUrl(urlStr: string): Record<string, unknown> {
  const p = parseUrl(urlStr);
  const self: Record<string, unknown> = {
    __u: urlStr,
    getProtocol: () => p.protocol,
    getHost: () => p.host,
    getPort: () => p.port,
    /** JDK：未显式给端口时 -1，`getDefaultPort()` 才是 80/443 */
    getDefaultPort: () => (p.protocol === 'https' ? 443 : p.protocol === 'http' ? 80 : -1),
    getPath: () => p.path,
    getFile: () => p.file,
    getQuery: () => (p.query ? p.query : null),
    getRef: () => (p.ref ? p.ref : null),
    getAuthority: () => p.authority,
    getUserInfo: () => (p.userInfo ? p.userInfo : null),
    toExternalForm: () => urlStr,
    toString: () => urlStr,
    sameFile: (o: unknown) => String((o as { __u?: unknown } | null)?.__u ?? o) === urlStr,
  };
  self['openConnection'] = () => makeConnection(urlStr);
  self['openStream'] = () => (makeConnection(urlStr)['getInputStream'] as () => unknown)();
  return self;
}

/**
 * `HttpURLConnection` 的实例面。
 * 时序照 JDK：set* 只记参数 → `getOutputStream()` 收集 body → `getResponseCode()`/`getInputStream()` 才发。
 */
function makeConnection(urlStr: string): Record<string, unknown> {
  const headers: Record<string, string> = {};
  const chunks: Uint8Array[] = [];
  let method = 'GET';
  let bodyLen = 0;
  let connectTimeoutMs = 0;
  let readTimeoutMs = 0;
  let resp: JavaNetResponse | null = null;

  const bodyBytes = (): Uint8Array | undefined => {
    if (!chunks.length) return undefined;
    const out = new Uint8Array(bodyLen);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };

  const fire = (): JavaNetResponse => {
    if (resp) return resp;
    const fn = transport ?? noTransport;
    resp = fn({
      method,
      url: urlStr,
      headers: { ...headers },
      ...(chunks.length ? { body: bodyBytes() as Uint8Array } : {}),
      connectTimeoutMs,
      readTimeoutMs,
    });
    return resp;
  };

  const setProp = (k: unknown, v: unknown): void => {
    headers[String(k)] = String(v ?? '');
  };

  const conn: Record<string, unknown> = {
    setRequestMethod: (m: unknown) => {
      method = String(m ?? 'GET').toUpperCase();
    },
    getRequestMethod: () => method,
    setDoOutput: () => undefined,
    getDoOutput: () => true,
    setDoInput: () => undefined,
    getDoInput: () => true,
    setUseCaches: () => undefined,
    setRequestProperty: setProp,
    addRequestProperty: setProp,
    getRequestProperty: (k: unknown) => headers[String(k)] ?? null,
    setConnectTimeout: (ms: unknown) => {
      connectTimeoutMs = Number(ms) || 0;
    },
    getConnectTimeout: () => connectTimeoutMs,
    setReadTimeout: (ms: unknown) => {
      readTimeoutMs = Number(ms) || 0;
    },
    getReadTimeout: () => readTimeoutMs,
    setInstanceFollowRedirects: () => undefined,
    /** body 写入缓冲（JDK 里 write 也不发请求） */
    getOutputStream: () => ({
      write: (buf: unknown, off?: unknown, len?: unknown): void => {
        const src = toBytes(buf);
        const o = Number(off ?? 0) || 0;
        const n = len == null ? src.length - o : Number(len) || 0;
        const slice = src.subarray(o, o + n);
        chunks.push(Uint8Array.from(slice));
        bodyLen += slice.length;
      },
      flush: (): void => undefined,
      close: (): void => undefined,
      writeBytes: (buf: unknown): void => {
        const src = toBytes(buf);
        chunks.push(Uint8Array.from(src));
        bodyLen += src.length;
      },
    }),
    connect: (): void => {
      fire();
    },
    getResponseCode: (): number => fire().code,
    getResponseMessage: (): string => (fire().code >= 400 ? 'Error' : 'OK'),
    getHeaderField: (n: unknown): string | null => {
      const k = String(n ?? '').toLowerCase();
      const v = fire().headers[k];
      return v == null ? null : String(v);
    },
    getHeaderFields: (): Record<string, string> => ({ ...fire().headers }),
    getContentLength: (): number => fire().body.length,
    getContentLengthLong: (): number => fire().body.length,
    getContentType: (): string | null => {
      const v = fire().headers['content-type'];
      return v == null ? null : String(v);
    },
    /** JDK 语义：≥400 时 `getInputStream()` 抛 IOException，错误体只能从 `getErrorStream()` 取 */
    getInputStream: (): Record<string, unknown> => {
      const r = fire();
      if (r.code >= 400) throw new Error(`getInputStream: HTTP ${r.code}（错误体请用 getErrorStream）`);
      return makeInputStream(r.body);
    },
    getErrorStream: (): Record<string, unknown> | null => {
      const r = fire();
      return r.code >= 400 ? makeInputStream(r.body) : null;
    },
    disconnect: (): void => undefined,
  };
  return conn;
}

/**
 * `java.net` 命名空间。
 *
 * ⚠️ `Socket` / `InetSocketAddress` / `InetAddress` **有意不实现**：同步 TCP 连不通服务端的事件循环
 * （Node 的 `net.Socket` 是异步），硬做只能编造「延迟 0ms、ok=true」。速读谷的 `checkConnectivity`
 * 因此仍会走兜底 → 它的 `catch` 分支会给「探测失败」文案（源作者写了兜底）。
 */
export function makeJavaNetNs(extraNest?: (path: string) => unknown): Record<string, unknown> {
  const URL = function (this: unknown, u: unknown) {
    return makeUrl(String(u ?? ''));
  } as unknown as Record<string, unknown>;
  URL['create'] = (u: unknown) => makeUrl(String(u ?? ''));
  return {
    URL,
    URI: URL, // `java.net.URI` 在语料里只当 URL 用（无独立语义需求）
    ...(extraNest ? { Socket: extraNest('Socket'), InetSocketAddress: extraNest('InetSocketAddress'), InetAddress: extraNest('InetAddress') } : {}),
  };
}

/** `java.io` 里流相关的补充面（`BufferedReader` / `InputStreamReader` / `InputStream`） */
export function makeJavaIoStreamNs(): Record<string, unknown> {
  /**
   * `InputStreamReader(stream, charset)`：只记住底层字节与字符集，真正解码推迟到 `readLine`
   * （JDK 是流式解码；这里一次性解码，语料里都是「读完再处理」，行为等价）。
   */
  const InputStreamReader = function (this: unknown, stream: unknown, charset?: unknown) {
    const bytes = (stream as { _bytes?: Uint8Array } | null)?._bytes ?? new Uint8Array(0);
    const cs = String(charset ?? 'utf-8');
    return {
      _text: decodeWithCharset(bytes, cs),
      getEncoding: () => cs,
      close: () => undefined,
      read: () => -1,
    };
  } as unknown as Record<string, unknown>;

  /**
   * `BufferedReader(reader)`：`readLine()` 逐行，行尾 `\r?\n`；读完返回 null（**这是番茄循环的终止条件**）。
   * 也接受直接传 InputStream（源里偶有这种写法）。
   */
  const BufferedReader = function (this: unknown, reader: unknown) {
    const r = reader as { _text?: string; _bytes?: Uint8Array; getEncoding?: () => string } | null;
    const text = r?._text != null ? r._text : decodeWithCharset(r?._bytes ?? new Uint8Array(0), 'utf-8');
    const lines = text.split(/\r?\n/);
    /* 末行是空串（文本以换行结尾）时去掉 —— JDK readLine 不会多给一个空行 */
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let i = 0;
    return {
      readLine: (): string | null => (i < lines.length ? (lines[i++] as string) : null),
      ready: () => i < lines.length,
      close: () => undefined,
      read: () => -1,
    };
  } as unknown as Record<string, unknown>;

  return {
    BufferedReader,
    InputStreamReader,
    /** `java.io.InputStream` 作为「类型」出现在 `new` 里极少；给出可 read 的空流避免 NOT_A_FUNCTION */
    InputStream: function () {
      return makeInputStream(new Uint8Array(0));
    },
  };
}

/** `java.util.zip` 命名空间 */
export function makeJavaZipNs(): Record<string, unknown> {
  return {
    GZIPInputStream: function (this: unknown, inner: unknown) {
      return makeGzipInputStream(inner);
    },
  };
}
