/**
 * `/api/user/*` 的**前端薄封装** —— Phase 1.4（前端 localStorage → 服务端）的接线层。
 *
 * ## 为什么要有这一层（而不是各 store 自己 fetch）
 * 迁移前，前端各处直接写 `fetch('/api/user/...')`，会把 URL、HTTP 方法、错误处理、
 * JSON 形状散在 5 个文件里；契约类型也会退化成**手写第二份真相源**（必与 core 漂移）。
 * 这里集中一次：
 *  · 端点 URL 与请求方法**只有这一份**；
 *  · 类型全部来自 `@yuedu/core/contract`（Phase 1.4 已拍板：给 web 加 `@yuedu/core` 依赖
 *    —— 契约已用测试锁住字段数，手写必漂移）；
 *  · 只 `import type` ⇒ **编译期擦除**，浏览器 bundle 里不会出现 `node:sqlite` / `jsdom`。
 *
 * ## 错误语义（迁移期最关键的一条）
 * 所有方法在**非 2xx 时抛错**（`UserDataError`）。调用方必须能区分：
 *  · 服务端未启动 / 网络失败 ⇒ **降级回 localStorage**（前端仍可用，这是迁移期的安全网）；
 *  · 其它错误 ⇒ 照常抛。
 * 所以这里**不做静默兜底**（静默兜底会让「迁移没生效」看起来像「数据本来就没有」，与铁律 3 冲突）。
 */
import type {
  BookGroup,
  BookHighlight,
  Bookmark,
  BookTombstone,
  CacheEntry,
  DictRule,
  ImportResult,
  HighlightRule,
  ReadRecord,
  ReadSession,
  ReadStatsSnapshot,
  ReplaceRule,
  ShelfBook,
  ShelfChapter,
  /** 全局阅读偏好（Legado `ReadConfig` 的全局部分）—— 契约里的真实名字是 GlobalReaderPrefs */
  GlobalReaderPrefs,
} from '@yuedu/core/contract';

const BASE = '/api/user';

/** 错误带上 HTTP 状态码，便于调用方区分「服务端不可用」与「请求本身有问题」 */
export class UserDataError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UserDataError';
    this.status = status;
  }
  /** 服务端不可达/未启动（迁移期据此降级到 localStorage） */
  get offline(): boolean {
    return this.status === 0;
  }
}

/**
 * 这个 404 是不是「**整条路由不存在**」（`#215` 用户实测踩到）。
 *
 * 场景：服务端 bundle 比前端旧（用户只刷新了页面、没重启服务端 ⇒ 新加的端点在旧进程里不存在），
 * Fastify 的默认 notFound 会回
 * `{"error":"Not Found","message":"Route POST:/api/local-books/import not found","statusCode":404}`。
 * 若照常把 `error` 透出去，界面只会显示 **「Not Found」**——用户会以为自己**导入的文件有问题**
 * （这正是 `#215` 的误判来源：真正没做的是「重启服务端」）。
 *
 * 判据为什么安全：本仓自己的业务 404 一律带**自己的错误码**（如 `BOOK_NOT_FOUND` / `CHAPTER_NOT_FOUND`），
 * 不会恰好是 Fastify 的 `Not Found`。
 */
function isMissingRoute(j: unknown, status: number): boolean {
  if (status !== 404) return false;
  if (typeof j === 'string') return /^\s*not\s*found\s*$/i.test(j);
  if (!j || typeof j !== 'object') return false;
  const o = j as { error?: unknown; message?: unknown; statusCode?: unknown };
  if (o.error === 'Not Found' && o.statusCode === 404) return true;
  return typeof o.message === 'string' && /^Route .+ not found$/i.test(o.message);
}

/** 路由不存在时给用户的提示（可执行：重启服务端）—— 见 `isMissingRoute` */
const ROUTE_MISSING_HINT =
  '服务端没有这个接口（HTTP 404）—— 多半是服务端还是旧版本：请重启悦读服务（托盘「重启服务」或重新打开客户端），再刷新页面重试';

async function req<T>(method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    // 网络层失败（服务端未启动、被 CORS/代理拦）→ status=0，调用方据此降级
    throw new UserDataError(String((e as Error)?.message ?? e), 0);
  }
  const text = await r.text();
  let j: unknown = null;
  if (text) {
    try {
      j = JSON.parse(text);
    } catch {
      j = text;
    }
  }
  if (!r.ok) {
    if (isMissingRoute(j, r.status)) throw new UserDataError(ROUTE_MISSING_HINT, r.status);
    const msg = (j as { error?: string } | null)?.error ?? `HTTP ${r.status}`;
    throw new UserDataError(String(msg), r.status);
  }
  return j as T;
}

const q = (o: Record<string, string | number | boolean | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * ★★ 传「**已编码过**的 `bookUrl`」的查询串 —— 本地书专用，别用 {@link q}。
 *
 * ## 背景
 * 本地书的 `bookUrl` 形态是 `loc_book%00{"fileName":"…"}`，其中 `%00` 是
 * `encodeItemKey` 把 NUL 编过的结果（JSON 里的中文也已编好）。
 *
 * ## 为什么 `q()` 不行
 * `q()` 走 `URLSearchParams` 的 `set()`，它对值做 form 编码：`%` → `%25`、空格 → `+`。
 * 本地书里 JSON 后的引号等会变成 `+` / `%22` 混搭，服务端解码后与主键**对不上**。
 *
 * ## 为什么必须用 `encodeURIComponent`（而不能原样拼）
 * Fastify 解析 query 时会对值**再解一层**：原样拼 `%00` 时它只还原成 NUL，
 * 而 JSON 部分的中文引号仍是 `%22%3A` 没解 ⇒ 查不到书（实测 `BOOK_NOT_FOUND`）。
 * 用 `encodeURIComponent` 把 `%` 编成 `%25`（变 `%2500`）⇒ Fastify 解完正好是 `%00…` 原文
 * ⇒ 与主键一致（实测能取到正文）。
 *
 * ★ 只在**query** 上是这样；`x-file-name` 头是另一条路（一直用 `encodeURIComponent`）。
 *
 * ## 症状（最坑的地方：不报错，只是「内容空」）
 * 导入正常、目录正常、书也在书架里 ⇒ 但正文一片空白。
 * 网络书 bookUrl 不含 `%`，用 `q()` 也没事 ⇒ **只有本地书**出问题。
 */
const qBookUrl = (bookUrl: string, rest: Record<string, string | number | boolean | undefined> = {}): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) p.set(k, String(v));
  const tail = p.toString();
  return `?bookUrl=${encodeURIComponent(bookUrl)}${tail ? `&${tail}` : ''}`;
};

/**
 * list 端点的**信封剥壳** —— 服务端统一返回 `{ total, <key> }`。
 *
 * ★★ **2026-09-28 实测发现并修（#66 开工的第一件事）**：接线层此前把 7 个 list 端点声明成
 * **裸数组**，而路由返回的是信封（`apps/server/src/index.ts:470 / 509 / 536 / 563 / 590 / 626 / 669`）
 * ⇒ `listGroups().length` 恒为 `undefined`。**因为接线层建好后一直没人 import**（`aa934ba` 只建了层），
 * 这个「类型谎言」藏了 3 天 —— 迁移一开工就会撞上，而且症状是「数据像没同步」而不是报错。
 *
 * ⚠️ **唯一例外是 `/books`**：路由直接 `return store.listBooks()`（裸数组），不要套壳。
 * ⚠️ 形状不符 **不是**「服务端不可用」⇒ 抛普通 `Error`，别伪装成 `UserDataError.offline`
 * （那会触发「降级 localStorage」的安全网，把「接口改了」误判成「服务端没起」，与铁律 3 冲突）。
 */
async function reqList<T>(path: string, key: string): Promise<T[]> {
  const r = await req<Record<string, unknown>>('GET', path);
  const v = r?.[key];
  if (!Array.isArray(v)) {
    throw new Error(`/api/user${path} 响应缺少数组字段 \`${key}\`（实得 ${v === undefined ? 'undefined' : typeof v}）`);
  }
  return v as T[];
}

// ---- 书架（ShelfBook，主键 bookUrl）----

export function listBooks(): Promise<ShelfBook[]> {
  return req<ShelfBook[]>('GET', '/books');
}

/**
 * 取单本书。
 * ⚠️ **不存在时路由返回 404**（`apps/server/src/index.ts:398`）⇒ 这里会**抛** `UserDataError`，
 * 不是返回 `null`（原签名写 `| null` 是类型谎言，2026-09-28 一并修正）。
 * 调用方用 `e instanceof UserDataError && e.status === 404` 判「没有这本书」。
 */
export function getBook(bookUrl: string): Promise<ShelfBook> {
  return req<ShelfBook>('GET', `/books/one${qBookUrl(bookUrl)}`);
}

/** 单条新增/更新（书架「加入书架」「改进度」用） */
export function putBook(book: Partial<ShelfBook>): Promise<unknown> {
  return req('PUT', '/books', book);
}

/** 批量（**一次性搬迁**用：localStorage → 服务端） */
export function putBooksBatch(books: Partial<ShelfBook>[]): Promise<{ count?: number }> {
  return req<{ count?: number }>('POST', '/books/batch', { books });
}

export function deleteBook(bookUrl: string): Promise<unknown> {
  return req('DELETE', `/books${qBookUrl(bookUrl)}`);
}

/**
 * 拉取**删除墓碑**（跨端一致删除；不传 `since` = 全量）。
 *
 * 为什么必须显式拉：`pull({ mergeLocal: true })` 的历史语义是「本地独有的立即补推」，
 * 它无法区分「本地新增还没推」和「另一端删了但本地缓存还在」——墓碑就是这个区分。
 * 形状不符照常抛（不静默退化成空数组，否则删除语义会静默失效）。
 */
export async function listDeletedBooks(since?: number): Promise<BookTombstone[]> {
  const r = await req<{ deleted?: unknown }>('GET', `/books/deleted${q({ since })}`);
  if (!Array.isArray(r?.deleted)) {
    throw new Error(`/api/user/books/deleted 响应缺少数组字段 \`deleted\`（实得 ${typeof r?.deleted}）`);
  }
  return r.deleted as BookTombstone[];
}

/** 只写阅读进度（高频小写，避免整条重写） */
export function putProgress(bookUrl: string, patch: Record<string, unknown>): Promise<unknown> {
  return req('PUT', '/books/progress', { bookUrl, ...patch });
}

// ---- 目录缓存（ShelfChapter）----

export function listChapters(bookUrl: string): Promise<ShelfChapter[]> {
  return reqList<ShelfChapter>(`/chapters${qBookUrl(bookUrl)}`, 'chapters');
}

export function putChapters(bookUrl: string, chapters: Partial<ShelfChapter>[]): Promise<unknown> {
  return req('PUT', '/chapters', { bookUrl, chapters });
}

// ---- 书签 / 高亮 ----

export function listBookmarks(bookName?: string): Promise<Bookmark[]> {
  return reqList<Bookmark>(`/bookmarks${q({ bookName })}`, 'bookmarks');
}

export function putBookmark(b: Partial<Bookmark>): Promise<unknown> {
  return req('PUT', '/bookmarks', b);
}

export function deleteBookmark(time: string | number): Promise<unknown> {
  return req('DELETE', `/bookmarks${q({ time })}`);
}

export function listHighlights(bookUrl?: string): Promise<BookHighlight[]> {
  // ⚠️ 这里刻意用 `q` 而不是 `qBookUrl`：`bookUrl` 是**可选**的（不传 = 查全部），
  // 而 `qBookUrl` 要求必传。传了 bookUrl 时它也不含 `%`（网络书），用 `q` 没有编码问题。
  return reqList<BookHighlight>(`/highlights${q({ bookUrl })}`, 'highlights');
}

export function putHighlight(h: Partial<BookHighlight>): Promise<unknown> {
  return req('PUT', '/highlights', h);
}

export function deleteHighlight(time: string | number): Promise<unknown> {
  return req('DELETE', `/highlights${q({ time })}`);
}

// ---- 净化规则 / 分组 ----

export function listReplaceRules(): Promise<ReplaceRule[]> {
  return reqList<ReplaceRule>('/replace-rules', 'rules');
}

export function putReplaceRule(r: Partial<ReplaceRule>): Promise<unknown> {
  return req('PUT', '/replace-rules', r);
}

export function deleteReplaceRule(id: string): Promise<unknown> {
  return req('DELETE', `/replace-rules${q({ id })}`);
}

// ---- 高亮规则（`#262`：上游 HighlightRule 全链路） ----

export function listHighlightRules(): Promise<HighlightRule[]> {
  return reqList<HighlightRule>('/highlight-rules', 'rules');
}

export function putHighlightRule(r: Partial<HighlightRule>): Promise<unknown> {
  return req('PUT', '/highlight-rules', r);
}

export function deleteHighlightRule(id: string | number): Promise<unknown> {
  return req('DELETE', `/highlight-rules${q({ id })}`);
}

export function listGroups(): Promise<BookGroup[]> {
  return reqList<BookGroup>('/groups', 'groups');
}

export function putGroup(g: Partial<BookGroup>): Promise<unknown> {
  return req('PUT', '/groups', g);
}

export function deleteGroup(groupId: string): Promise<unknown> {
  return req('DELETE', `/groups${q({ groupId })}`);
}

// ---- 阅读记录 / 时长 ----

export function listReadRecords(aggregate?: boolean): Promise<ReadRecord[]> {
  return reqList<ReadRecord>(`/read-records${q({ aggregate: aggregate ? 1 : undefined })}`, 'records');
}

export function putReadTime(patch: Record<string, unknown>): Promise<unknown> {
  return req('PUT', '/read-time', patch);
}

// ---- 阅读会话统计（P1 `#863`） ----

/** 追加会话（幂等；离线补传可直接批量重放） */
export function appendReadSessions(
  sessions: ReadSession[],
): Promise<{ ok: boolean; inserted: number; skipped: number }> {
  return req('POST', '/read-sessions', { sessions });
}

/** 看板快照（按日 / 按书 / 断点 / 平均单次 / 旧历史总额） */
export function getReadStats(): Promise<ReadStatsSnapshot> {
  return req('GET', '/read-stats');
}

/** 会话流水（只读）：阅读节奏 / 单书下钻；`bookUrl` 精确过滤 */
export function listReadSessions(limit = 200, bookUrl?: string): Promise<ReadSession[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (bookUrl) qs.set('bookUrl', bookUrl);
  return reqList<ReadSession>(`/read-sessions?${qs}`, 'sessions');
}

// ---- 字典规则（`#189`：上服务端 ⇒ 5173 与 3000 同源同数据） ----

export function listDictRules(): Promise<DictRule[]> {
  return reqList<DictRule>('/dict-rules', 'rules');
}

export function putDictRule(r: Partial<DictRule>): Promise<unknown> {
  return req('PUT', '/dict-rules', r);
}

export function deleteDictRule(name: string): Promise<unknown> {
  return req('DELETE', `/dict-rules${q({ name })}`);
}

// ---- 本地书（`#202`：txt/epub 上传 + 取正文） ----

/**
 * 上传一个本地书文件。
 *
 * `bookUrl` **必须由调用方算好**（`encodeItemKey(itemKey(LOCAL_TAG, localBookPayload(file.name)))`）——
 * 服务端按它存入书架，前端打开时才能认成「在书架里」。
 * 文件字节走 `application/octet-stream`，文件名走 `x-file-name`（URL 编码，中文/空格才安全）。
 */
export async function importLocalBookFile(
  file: File,
  bookUrl: string,
  charset?: string,
): Promise<{ ok: boolean; chapterCount: number; book: { name: string; author: string }; summary: { format: string; chapterCount: number; wordCount: number; tocRuleName: string } }> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name),
  };
  if (charset) headers['x-book-charset'] = charset;
  const r = await fetch(`/api/local-books/import${qBookUrl(bookUrl)}`, { method: 'POST', headers, body: file });
  const text = await r.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = text;
  }
  if (!r.ok) {
    // ★ `#215`：先判「整条路由不存在」——它**不是**「文件有问题」，必须给出可执行提示，
    //   否则界面只剩 Fastify 的 `Not Found` 四个字，用户会一直去改自己的 txt（实测即如此）。
    if (isMissingRoute(j, r.status)) throw new Error(ROUTE_MISSING_HINT);
    const o = j as { error?: string; detail?: string } | null;
    // 把服务端的中文 detail 直接透出来（解析失败的原因对用户有意义，别吞成「HTTP 400」）
    throw new Error(o?.detail || o?.error || `导入失败（HTTP ${r.status}）`);
  }
  return j as never;
}

/**
 * 批量导入：上传一个 **zip 压缩包**，由服务端把里面的书逐本导进书架（`#212` Step3）。
 *
 * ⚠️ 与 `importLocalBookFile` 的差别：**前端不算 bookUrl**。压缩包内每本书的主键由
 * 服务端按**包内文件名**（`importLocalBook` 的 `defaultLocalBookUrl`）算 —— 前端拿不到
 * 包内文件名（不自己解 zip），也就无法预知主键。这与单本导入「前端算好 bookUrl 传进来」
 * 不同，所以**归组不能靠预知主键**：导入后按「服务端返回的 bookUrl」归组（见 ShelfView）。
 *
 * 返回每本的成败（`items`），让界面能逐条说明哪个条目失败了。
 */
export async function importLocalBookArchive(
  file: File,
  charset?: string,
): Promise<{ ok: number; failed: number; total: number; items: Array<{ entry: string; name?: string; ok: boolean; error?: string; chapterCount?: number; format?: string; bookUrl?: string }> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name),
  };
  if (charset) headers['x-book-charset'] = charset;
  const r = await fetch('/api/local-books/import-archive', { method: 'POST', headers, body: file });
  const text = await r.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = text;
  }
  if (!r.ok) {
    if (isMissingRoute(j, r.status)) throw new Error(ROUTE_MISSING_HINT);
    const o = j as { error?: string; detail?: string } | null;
    throw new Error(o?.detail || o?.error || `压缩包导入失败（HTTP ${r.status}）`);
  }
  return j as never;
}

/**
 * 取本地书某一章的正文（服务端从原文件按偏移/章节现取）。
 *
 * ★★ **不能用 `req()`** —— 它会拼 `BASE = '/api/user'` 前缀，而本端点在
 * `/api/local-books/content`（**没有 `/user`**，见 `server/index.ts` 的路由注册）
 * ⇒ 打成 `/api/user/local-books/content` ⇒ 404 ⇒ `isMissingRoute` 命中后抛出
 * 「服务端没有这个接口，请重启 start-server.bat」——**误导性极强**：明明是路径写错，
 * 却提示用户去重启服务。同文件的 `importLocalBookFile` 用的是 `fetch` 绝对路径，两处不一致。
 *
 * 用 `qBookUrl` 而不是 `q`：本地书的 `bookUrl` 里的 `%00` 是 `encodeItemKey` 已编过的
 * `q()` 会把它再编一层（`URLSearchParams` 把 `%` → `%25`），Fastify 解出来就对不上主键。
 * 详见 {@link qBookUrl} 的注释。
 *
 * `#212` Step2：`html` 只在**含图章**（epub 正文里有插图）时由服务端给出，
 * 且其中的 `<img src>` 已指向 `/api/local-books/asset`；阅读器据此走 iframe 通路。
 */
export async function getLocalBookContent(
  bookUrl: string,
  index: number,
): Promise<{ title: string; paragraphs: string[]; html?: string }> {
  const r = await fetch(`/api/local-books/content${qBookUrl(bookUrl, { index })}`);
  const text = await r.text();
  if (!r.ok) {
    let j: { error?: string; detail?: string } | null = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* 非 JSON（网关错误页等）*/ }
    throw new UserDataError(String(j?.detail || j?.error || `HTTP ${r.status}`), r.status);
  }
  return JSON.parse(text) as { title: string; paragraphs: string[]; html?: string };
}

/* ---- `#204` 封面自定义 ---- */

/** 上传自定义封面的结果（服务端把字节存进 blob，`customCoverUrl` 存同源相对 URL） */
export interface CoverUploadResult {
  ok: true;
  bookUrl: string;
  customCoverUrl: string;
  bytes: number;
}

/**
 * 上传自定义封面。
 *
 * ★ 为什么不复用 {@link req}：它固定发 `content-type: application/json` + `JSON.stringify`，
 *   而封面是**二进制**（`application/octet-stream`，类型另放 `x-cover-type` 头 ——
 *   浏览器 `File.type` 有时是空串，放体里会被 JSON 序列化毁掉）。
 * ★ 服务端 `PUT /api/user/books` 是「整条 upsert + 缺字段补默认值」，
 *   拿它改封面会**把没传的字段重置成默认值**（实测会丢阅读进度）⇒ 必须走专用端点。
 */
export async function uploadBookCover(bookUrl: string, file: File): Promise<CoverUploadResult> {
  const buf = await file.arrayBuffer();
  let r: Response;
  try {
    r = await fetch(`${BASE}/books/cover${qBookUrl(bookUrl)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-cover-type': file.type || 'image/png' },
      body: buf,
    });
  } catch (e) {
    throw new UserDataError(String((e as Error)?.message ?? e), 0);
  }
  const text = await r.text();
  let j: unknown = null;
  if (text) {
    try { j = JSON.parse(text); } catch { j = text; }
  }
  if (!r.ok) {
    if (isMissingRoute(j, r.status)) throw new UserDataError(ROUTE_MISSING_HINT, r.status);
    // 服务端的中文 detail 对用户有意义（类型不支持 / 超 8MB），别吞成「HTTP 400」
    const o = j as { detail?: string; error?: string } | null;
    throw new UserDataError(String(o?.detail || o?.error || `HTTP ${r.status}`), r.status);
  }
  return j as CoverUploadResult;
}

/** 清除自定义封面 ⇒ 回落显示源封面 */
export function clearBookCover(bookUrl: string): Promise<{ ok: true; bookUrl: string; customCoverUrl: null }> {
  return req('DELETE', `/books/cover${qBookUrl(bookUrl)}`);
}

/**
 * 把 `customCoverUrl` 设成用户给的图片地址（**不下载、不存 blob**，只记一个外链）。
 * 好处：跨设备可用、零服务端存储；代价：那个 URL 挂了封面就空（所以清除按钮必须留着）。
 */
export function setBookCoverUrl(bookUrl: string, customCoverUrl: string): Promise<{ ok: true; bookUrl: string; customCoverUrl: string }> {
  return req('PUT', `/books/cover-url${qBookUrl(bookUrl)}`, { customCoverUrl });
}

// ---- 偏好 / KV 缓存 ----

export function getPrefs(): Promise<GlobalReaderPrefs> {
  return req<GlobalReaderPrefs>('GET', '/prefs');
}

export function patchPrefs(patch: Record<string, unknown>): Promise<unknown> {
  return req('PATCH', '/prefs', patch);
}

/** KV 缓存条目（**不是** `Record<string,string>`：路由返回的是 `CacheEntry[]`，见 `sqlite.ts:969`） */
export function getCacheValue(prefix?: string): Promise<CacheEntry[]> {
  return reqList<CacheEntry>(`/cache${q({ prefix })}`, 'entries');
}

export function putCacheValue(key: string, value: string | null, ttlMs?: number): Promise<unknown> {
  return req('PUT', '/cache', { key, value, ttlMs });
}

/** 全量快照（导出/备份用；`includeChapters` 才带目录） */
export function getSnapshot(includeChapters = false): Promise<Record<string, unknown>> {
  return req<Record<string, unknown>>('GET', `/snapshot${q({ includeChapters: includeChapters ? 1 : undefined })}`);
}

/**
 * `#201` 把一份快照**合并**回服务端（与 `getSnapshot` 配对）。
 *
 * `overwrite=false`（默认）= 合并：只补服务端没有的条目，已存在的一律不动，**永不删除**；
 * `overwrite=true` = 主键冲突时以快照为准（仍是 upsert，不删任何条目）。
 * 逐实体判据见 `packages/core/src/user-store/import.ts` 文件头表格。
 */
export function importSnapshot(
  snapshot: Record<string, unknown>,
  overwrite = false,
): Promise<{ ok: boolean; mode: string; elapsedMs: number; result: ImportResult }> {
  return req('POST', `/snapshot/import${q({ overwrite: overwrite ? 1 : undefined })}`, snapshot);
}

/**
 * 服务端用户数据是否可用（迁移期的**探针**，不做任何写入）。
 *
 * 为什么要它：迁移期前端需要决定「走服务端还是降级 localStorage」。
 * 直接 try 一次真实读代替专门的探测请求即可（`/prefs` 最轻）。
 */
export async function userDataAvailable(): Promise<boolean> {
  try {
    await getPrefs();
    return true;
  } catch (e) {
    return !(e instanceof UserDataError && e.offline);
  }
}
