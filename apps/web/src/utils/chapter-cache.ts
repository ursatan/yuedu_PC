/**
 * 章节正文**离线缓存** + **书籍详情/目录本地化**（同一个 IndexedDB）。
 *
 * ## 为什么是 IndexedDB 而不是 localStorage
 * 缓存的对象是「一整本书的正文 / 一整本目录（可达数千章）」。
 * localStorage 只有 ~5MB 且是**同步** API（写入会卡主线程），一本 2000 章的书轻松超过它；
 * IndexedDB 有大得多的配额、全异步，不会阻塞渲染。
 *
 * ## 语义
 *  · **写**：
 *    - 正文：默认在「阅读时按窗口预缓存」写（见 `prefetchWindow`，用户 5-5 要求 20 章未读窗口），
 *      也支持用户显式点「离线缓存」批量写（`cacheRange`）。
 *    - 详情/目录（store `books`）：**每次真正拉取详情成功后回写**（用户 5-2/5-4 要求本地化）。
 *  · **读**：`openChapter` 先查正文缓存；书架书籍打开时先查 `books` 里的详情/目录。
 *    **「↻ 刷新正文」绕过正文缓存**（用户点刷新就是想要最新的）；
 *    **「↻ 刷新详情」传 `force`** 重新拉详情并回写。
 *  · 键 = `sourceId|章节 payload 的稳定串`（正文）/ `itemKey(sourceId,payload)`（详情）。
 *    payload 是源给的标识（含 chapterUrl/nid/sort 等），换章/换书天然不冲突；
 *    不用数组下标（那会在目录更新后串位）。
 */
import type { ContentUiMark } from '@yuedu/core/contract';

const DB_NAME = 'yuedu-offline';
/** ⚠️ 升版本必须同时在建库回调里建新 store（v2 加 `books`；v3 加 `downloads`） */
const DB_VERSION = 3;
const STORE = 'chapters';
const STORE_BOOKS = 'books';
/** `#207` 整本下载任务（键 = 书键；只存**可序列化**的任务快照，不存目录） */
const STORE_DOWNLOADS = 'downloads';

/**
 * **正文缓存变更通知**（对齐上游 `EventBus.SAVE_CONTENT`）。
 *
 * 上游目录的「未缓存云朵」靠 `BookHelp.saveContent` 保存成功后发事件、`ChapterListFragment`
 * 增量更新；本仓所有写盘都走 `putCachedChapter`（阅读/刷新/预缓存/整本下载），
 * 所以事件放在这里发一次即可，消费方不用去每个写入点各挂一遍。
 */
export interface ChapterCacheChange {
  add?: string[];
  remove?: string[];
}

const CACHE_EVENT = 'yuedu:chapter-cache-changed';

function emitChapterCacheChange(change: ChapterCacheChange): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ChapterCacheChange>(CACHE_EVENT, { detail: change }));
}

/** 订阅正文缓存变更；返回退订函数（`onBeforeUnmount` 里调） */
export function onChapterCacheChange(cb: (change: ChapterCacheChange) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (e: Event): void => cb((e as CustomEvent<ChapterCacheChange>).detail);
  window.addEventListener(CACHE_EVENT, listener);
  return () => window.removeEventListener(CACHE_EVENT, listener);
}

export interface CachedChapter {
  title?: string;
  paragraphs: string[];
  /**
   * `#308` 正文 HTML（与 `paragraphs` 互斥，见契约 `UnifiedContent.html`）。
   * 订阅源（RSS）与组装型正文（影视聚合播放器 / 24凹凸图集）走这条路。
   * 缓存它是为了让「离线再看一次」也能出播放器/图集，而不是退化成一段纯文本。
   */
  html?: string;
  /** `#308` `html` 的相对地址基准（上游 `loadWithBaseUrl` 语义） */
  htmlBaseUrl?: string;
  /** `#583` 正文里的源按钮（段评 / 本章说 / 神评 / 书评）—— 离线阅读也要保留 */
  uiMarks?: ContentUiMark[];
  subContent?: string;
  imageStyle?: string;
  imageDecode?: boolean;
  media?: { url: string; format?: string; alternatives?: string[]; headers?: Record<string, string> };
  /** 写入时间（毫秒），供「缓存时间」展示与将来做过期策略 */
  at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      // v2：书籍详情/目录本地化（用户 5-2/5-4）
      if (!db.objectStoreNames.contains(STORE_BOOKS)) db.createObjectStore(STORE_BOOKS);
      // v3：`#207` 整本下载任务
      if (!db.objectStoreNames.contains(STORE_DOWNLOADS)) db.createObjectStore(STORE_DOWNLOADS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 章节 payload → 缓存键（payload 是源给的标识，稳定且唯一） */
export function chapterKey(sourceId: string, payload: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(payload ?? {});
  } catch {
    body = String(payload);
  }
  return `${sourceId}|${body}`;
}

export async function getCachedChapter(sourceId: string, payload: unknown): Promise<CachedChapter | null> {
  try {
    const db = await openDb();
    return await new Promise<CachedChapter | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(chapterKey(sourceId, payload));
      req.onsuccess = () => resolve((req.result as CachedChapter | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null; // 隐私模式/配额异常时静默降级为「无缓存」，不影响在线阅读
  }
}

/**
 * **错误文案**（`D1`）：源规则失效时常把「提示语」当正文返回（实测语料里出现过
 * `请刷新查看内容`、`未取到媒体地址` 这类占位文本），前端若把它落进离线缓存，
 * 以后每次点这一章都会命中「坏缓存」，刷新也绕不过 ⇒ 必须**写入前就拒收**。
 *
 * ★ 判据只在这一处实现（`stores/reader.ts` / `stores/downloads.ts` 的调用点不再各写一遍）。
 * ★ 只认**整段精确命中**（含少量带后缀的提示语前缀），不做长度启发式 ——
 *   正常小说正文里出现「加载失败」四个字不能被误杀。
 */
const ERROR_CHAPTER_TEXTS: readonly string[] = [
  '本章正文为空',
  '正文为空',
  '未取到媒体地址',
  '正文加载失败',
  '加载失败',
  '获取正文失败',
  '页面加载失败',
  '媒体加载失败',
  '请求失败',
  '网络错误',
  '请刷新查看内容',
  '该地址无法播放（格式不支持，或直链已失效/防盗链拦截）',
];

/** 带详情后缀的错误提示（如 `正文加载失败（已自动重试一次）：…`） */
const ERROR_CHAPTER_PREFIX_RE = /^(?:正文加载失败|未取到媒体地址|本章正文为空|获取正文失败|加载失败|页面加载失败)[（(：:]/;

/** 这段文本是不是「错误提示」而不是真正的正文/标题 */
export function isErrorChapterText(text: string | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return ERROR_CHAPTER_TEXTS.includes(t) || ERROR_CHAPTER_PREFIX_RE.test(t);
}

/**
 * **写盘失败审计**（用户 2026-11-09：「预缓存突然不灵了」却无从知道原因）。
 *
 * 只记账、不阻断阅读：失败仍然静默降级为「在线读」，但设置页「缓存治理」会显示
 * 「正文缓存写入失败 N 次 + 最后一次原因」并给清理建议。计数是**本次会话**口径，
 * 清理正文缓存（`clearChapterCache` / 全部清理）后归零。
 */
let writeFailCount = 0;
let writeFailLast = '';
let writeFailLastAt = 0;

export interface ChapterCacheWriteFailure {
  count: number;
  /** 最后一次失败原因（人话，不含堆栈） */
  last: string;
  /** 最后一次失败时间（毫秒） */
  lastAt: number;
}

export function chapterCacheWriteFailures(): ChapterCacheWriteFailure {
  return { count: writeFailCount, last: writeFailLast, lastAt: writeFailLastAt };
}

function noteWriteFailure(reason: string): void {
  writeFailCount += 1;
  writeFailLast = reason;
  writeFailLastAt = Date.now();
  // 控制台留痕便于排查（配额不足最常见的报错是 QuotaExceededError）
  console.warn('[chapter-cache] 正文缓存写入失败：', reason);
}

export async function putCachedChapter(sourceId: string, payload: unknown, data: Omit<CachedChapter, 'at'>): Promise<void> {
  // `D1`：错误文案（正文或标题）一律不落库 —— 否则会「毒化」这一章的缓存
  if (isErrorChapterText(data.title)) return;
  if ((data.paragraphs ?? []).some((p) => isErrorChapterText(p))) return;
  const key = chapterKey(sourceId, payload);
  try {
    const db = await openDb();
    const wrote = await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ ...data, at: Date.now() }, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
    // 只有真正落盘成功才通知（上游也只在 saveContent 成功后发 SAVE_CONTENT）
    if (wrote) emitChapterCacheChange({ add: [key] });
    else noteWriteFailure('IndexedDB 事务未完成（常见原因：浏览器存储配额不足 / 存储被禁用）');
  } catch (e) {
    noteWriteFailure(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 清空一个 store，返回被清的条数（隐私模式/异常时按 0 处理）。
 *
 * ★ 清正文库（`STORE`）时**必须逐键通知**：目录云朵的显隐完全靠 `chapter-cache` 事件维持，
 *   `store.clear()` 本身不产生事件 ⇒ 清理后目录里已缓存的章仍不带云朵（用户会以为没清掉）。
 *   先把键扫出来再 clear，事务成功后发 `remove`（与 `deleteCachedByKeys` 同一个通道）。
 */
async function clearStore(name: string): Promise<number> {
  try {
    const db = await openDb();
    return await new Promise<number>((resolve) => {
      const tx = db.transaction(name, 'readwrite');
      const store = tx.objectStore(name);
      const removed: string[] = [];
      const req = store.openKeyCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          store.clear();
          return;
        }
        removed.push(String(cur.key));
        cur.continue();
      };
      req.onerror = () => { /* 由 tx 兜底 */ };
      const done = (): void => {
        if (name === STORE) {
          if (removed.length) emitChapterCacheChange({ remove: removed });
          // 清理后配额已释放，失败计数也随之归零（否则提示会一直挂着）
          writeFailCount = 0;
          writeFailLast = '';
          writeFailLastAt = 0;
        }
        resolve(removed.length);
      };
      tx.oncomplete = done;
      tx.onerror = done;
      tx.onabort = done;
    });
  } catch {
    return 0;
  }
}

/**
 * `#516` **清空全部本地缓存**（设置页「清理缓存与 Cookie」用）：
 * 正文 / 书籍详情目录 / 整本下载任务三个 store 一起清。
 * 返回各类被清的条数，便于给用户一个「清了 N 章」的回执。
 */
export async function clearAllCache(): Promise<{ chapters: number; books: number; downloads: number }> {
  return {
    chapters: await clearStore(STORE),
    books: await clearStore(STORE_BOOKS),
    downloads: await clearStore(STORE_DOWNLOADS),
  };
}

/* ========================= `#816` B5 六类缓存治理（浏览器侧两类） ========================= */

/**
 * 一类浏览器缓存的口径：**条数 + 估算字节**。
 * 字节按「记录序列化后的 UTF-8 长度」估算 —— IndexedDB 内部还有索引/页开销，
 * 设置页只用来给用户看量级，不用于配额强删（强删会误伤手动离线缓存，见 B5 头注）。
 */
export interface BrowserCacheUsage {
  items: number;
  bytes: number;
}

async function storeUsage(name: string): Promise<BrowserCacheUsage> {
  const encoder = new TextEncoder();
  try {
    const db = await openDb();
    return await new Promise<BrowserCacheUsage>((resolve) => {
      const tx = db.transaction(name, 'readonly');
      const req = tx.objectStore(name).openCursor();
      let items = 0;
      let bytes = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          resolve({ items, bytes });
          return;
        }
        items += 1;
        try {
          bytes += encoder.encode(JSON.stringify(cur.value)).byteLength;
        } catch {
          /* 单条序列化失败只影响这一条的估算，跳过 */
        }
        cur.continue();
      };
      req.onerror = () => resolve({ items, bytes });
    });
  } catch {
    return { items: 0, bytes: 0 };
  }
}

/** 浏览器侧两类：`toc` = 书籍详情+目录（`books`），`content` = 章节正文（`chapters`） */
export async function browserCacheUsage(): Promise<{ toc: BrowserCacheUsage; content: BrowserCacheUsage }> {
  return {
    toc: await storeUsage(STORE_BOOKS),
    content: await storeUsage(STORE),
  };
}

/**
 * **某一本书**的正文缓存用量（章数 + 估算字节）—— 详情页「🧹 清缓存」旁显示。
 *
 * `keys` 用这本书目录里每章的 `chapterKey` 传进来（同 `clearBookCache` 的键口径），
 * 只统计这本书自己的条目：正文库是多书共用一个 store，按 `sourceId` 前缀统计会把同源其它书算进来。
 */
export async function chapterCacheUsageOf(keys: Iterable<string>): Promise<BrowserCacheUsage> {
  const want = new Set(keys);
  if (!want.size) return { items: 0, bytes: 0 };
  const encoder = new TextEncoder();
  try {
    const db = await openDb();
    return await new Promise<BrowserCacheUsage>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      let items = 0;
      let bytes = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) {
          resolve({ items, bytes });
          return;
        }
        if (want.has(String(cur.key))) {
          items += 1;
          try {
            bytes += encoder.encode(JSON.stringify(cur.value)).byteLength;
          } catch {
            /* 单条序列化失败只影响这一条的估算 */
          }
        }
        cur.continue();
      };
      req.onerror = () => resolve({ items, bytes });
    });
  } catch {
    return { items: 0, bytes: 0 };
  }
}

/** 清「目录缓存」（书籍详情 + 目录本地化）；不动阅读进度/书签/书架 */
export async function clearBookMetaCache(): Promise<number> {
  return clearStore(STORE_BOOKS);
}

/** 清「正文缓存」（含预缓存窗口与手动离线缓存）；不动阅读进度/书签/书架 */
export async function clearChapterCache(): Promise<number> {
  return clearStore(STORE);
}

/** 已缓存章节数（按 sourceId 前缀统计） */
export async function countCached(sourceId: string): Promise<number> {
  try {
    const db = await openDb();
    return await new Promise<number>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openKeyCursor();
      const prefix = `${sourceId}|`;
      let n = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(n); return; }
        if (String(cur.key).startsWith(prefix)) n += 1;
        cur.continue();
      };
      req.onerror = () => resolve(n);
    });
  } catch {
    return 0;
  }
}

/**
 * 某本书**已缓存章节的 key 集合**（`chapterKey(sourceId, payload)` 形式）。
 *
 * 用途：书内全文搜索要判断「这一章能不能搜」—— 对齐上游 `SearchContentActivity`
 * 的 `cacheChapterNames.contains(chapter.getFileName())`：**只搜已有正文的章节，不联网抓**
 * （否则搜一本书会变成几百次站点请求）。
 *
 * ★ 为什么返回 `Set` 而不是「逐章 `hasCachedChapter()`」：一本 2000 章的书逐章查是 2000 次
 * IndexedDB 往返；这里**一次游标扫完**（与 `countCached` 同一套路），O(1) 查询。
 */
export async function cachedChapterKeys(sourceId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openKeyCursor();
      const prefix = `${sourceId}|`;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const k = String(cur.key);
        if (k.startsWith(prefix)) keys.add(k);
        cur.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {
    /* 隐私模式/配额异常 ⇒ 当作「没有缓存」，搜索会如实报告 0 章可搜 */
  }
  return keys;
}

/**
 * `#489` 音频书的「已缓存章节键」—— 最接近上游 `AudioCacheKey` / `AudioCacheManager` 的判定。
 *
 * 上游（`ChapterListAdapter.kt` 196-202、`AudioCacheKey.kt`、`ChapterListFragment.kt` 214-238）：
 * 音频缓存是**独立目录里的音频文件**，键 = `chapter.url`（空则 `chapter.title`）的 MD5-16；
 * 目录按 `bookUrl` 扫出已缓存键；缓存状态就绪前先按「已缓存」显示，避免整屏云朵闪一下。
 *
 * ⚠️ 本仓差异：音频走 `<video>` **流式播放**，不落音频字节（m3u8 还涉及分片），
 * 没有可扫描的音频文件目录；这里把「已下载到正文库、且带 `media.url`」的章节视作音频缓存，
 * 即 `stores/downloads` 的音频下载结果。语义是「已缓存播放地址」，**不等于可离线播放**。
 */
export async function cachedAudioChapterKeys(sourceId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      const prefix = `${sourceId}|`;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        const k = String(cur.key);
        const rec = cur.value as CachedChapter | undefined;
        if (k.startsWith(prefix) && rec?.media?.url) keys.add(k);
        cur.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {
    /* 隐私模式/配额异常 ⇒ 当作「还没有音频缓存」 */
  }
  return keys;
}

/** 清空某本书的缓存 */
export async function clearCached(sourceId: string): Promise<number> {
  try {
    const db = await openDb();
    return await new Promise<number>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openKeyCursor();
      const prefix = `${sourceId}|`;
      const removed: string[] = [];
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const k = String(cur.key);
        if (k.startsWith(prefix)) { store.delete(cur.key); removed.push(k); }
        cur.continue();
      };
      tx.oncomplete = () => {
        // 与 `deleteCachedByKeys` 同一通道：目录开着时云朵要跟着恢复
        if (removed.length) emitChapterCacheChange({ remove: removed });
        resolve(removed.length);
      };
      tx.onerror = () => resolve(removed.length);
    });
  } catch {
    return 0;
  }
}

/* ============================ 书籍详情 / 目录本地化（用户 5-2/5-4） ============================ */

/**
 * 本地化的「详情 + 目录」。
 *
 * `detail` 是引擎 `detail` 动作的完整响应（含 `chapters`，可达成千上万条）——存 IndexedDB 无压力。
 * `precacheKeys` 是 **5-5 的正文预缓存窗口**当前持有的章节键：窗口滑动时据此精确删除「掉出窗口」的
 * 那些键，**不会误删用户自己点「⬇ 缓存」批量缓存的章节**（那些不在这个集合里）。
 */
export interface CachedBookMeta<T = unknown> {
  detail: T;
  at: number;
  precacheKeys?: string[];
}

export async function putBookMeta<T>(bookKey: string, detail: T, precacheKeys?: string[]): Promise<void> {
  /**
   * ⚠️ **必须先转成纯数据**：调用方传进来的常是 Vue 的 reactive proxy（`detail.value`），
   * 而 IndexedDB 写入会对值做 structuredClone —— **Proxy 不能被结构化克隆**，
   * 直接 put 会抛 `DataCloneError`。踩过一次：书架的「详情/目录本地化」全静默失效，
   * 表现是「每次打开书架的书都重新拉详情」（用户 5-2 报的正是这个），
   * 而当时的 catch 把它吞了 ⇒ 排查了很久。所以这里既转换、也**留痕**。
   */
  let plain: T;
  try {
    plain = JSON.parse(JSON.stringify(detail)) as T;
  } catch (e) {
    console.warn('[book-cache] 详情无法序列化为纯数据，跳过本地化', e);
    return;
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_BOOKS, 'readwrite');
      const store = tx.objectStore(STORE_BOOKS);
      const get = store.get(bookKey);
      get.onsuccess = () => {
        const prev = (get.result as CachedBookMeta<T> | undefined) ?? undefined;
        store.put({
          detail: plain,
          at: Date.now(),
          ...(precacheKeys ?? prev?.precacheKeys ? { precacheKeys: precacheKeys ?? prev?.precacheKeys } : {}),
        }, bookKey);
      };
      get.onerror = () => store.put({ detail: plain, at: Date.now() }, bookKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (e) {
    console.warn('[book-cache] 写入详情失败（本地化跳过，不影响本次阅读）', e);
  }
}

export async function getBookMeta<T>(bookKey: string): Promise<CachedBookMeta<T> | null> {
  try {
    const db = await openDb();
    return await new Promise<CachedBookMeta<T> | null>((resolve) => {
      const tx = db.transaction(STORE_BOOKS, 'readonly');
      const req = tx.objectStore(STORE_BOOKS).get(bookKey);
      req.onsuccess = () => resolve((req.result as CachedBookMeta<T> | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('[book-cache] 读取详情失败（回落为无本地数据）', e);
    return null;
  }
}

export async function deleteBookMeta(bookKey: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_BOOKS, 'readwrite');
      tx.objectStore(STORE_BOOKS).delete(bookKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/** 只更新 `precacheKeys`（窗口滑动时用，不动 detail） */
export async function setPrecacheKeys<T>(bookKey: string, keys: string[]): Promise<void> {
  const cur = await getBookMeta<T>(bookKey);
  if (!cur) return;
  await putBookMeta(bookKey, cur.detail, keys);
}

/** 按**精确的章节键**删除正文缓存（窗口滑出时用；不会波及别的书/用户手动缓存的章节） */
export async function deleteCachedByKeys(keys: readonly string[]): Promise<number> {
  if (!keys.length) return 0;
  try {
    const db = await openDb();
    const n = await new Promise<number>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of keys) store.delete(k);
      tx.oncomplete = () => resolve(keys.length);
      tx.onerror = () => resolve(0);
    });
    // 目录云朵要跟着「掉出窗口」重新出现（与写入同一个通知通道）
    if (n) emitChapterCacheChange({ remove: [...keys] });
    return n;
  } catch {
    return 0;
  }
}

/* ============================ `#207` 整本下载任务持久化 ============================ */

/**
 * 下载任务**整表覆盖写**。
 *
 * 为什么不是「逐条 put」：任务完成/取消后要从列表里消失，逐条写还得自己维护删除；
 * 任务条数本来就是个位数（没人会同时下 50 本），整表覆盖更不容易出错。
 *
 * ⚠️ 与 `putBookMeta` 同一个坑：调用方给的常是 Vue reactive proxy，而 IndexedDB 的
 * structuredClone **克隆不了 Proxy** ⇒ 这里先 `JSON` 往返转纯数据，失败则留痕跳过。
 */
export async function putDownloadTasks(tasks: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  let plain: Array<Record<string, unknown>>;
  try {
    plain = JSON.parse(JSON.stringify(tasks)) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn('[download-cache] 任务无法序列化为纯数据，跳过落盘', e);
    return;
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_DOWNLOADS, 'readwrite');
      const store = tx.objectStore(STORE_DOWNLOADS);
      store.clear();
      for (const t of plain) {
        const k = String(t?.key ?? '');
        if (k) store.put(t, k);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch (e) {
    console.warn('[download-cache] 任务落盘失败（不影响本次下载）', e);
  }
}

/** 读出全部下载任务（顺序不保证 —— UI 自己按 `updatedAt` 排） */
export async function listDownloadTasks(): Promise<Array<Record<string, unknown>>> {
  try {
    const db = await openDb();
    return await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const tx = db.transaction(STORE_DOWNLOADS, 'readonly');
      const req = tx.objectStore(STORE_DOWNLOADS).getAll();
      req.onsuccess = () => resolve((req.result as Array<Record<string, unknown>>) ?? []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    console.warn('[download-cache] 读取下载任务失败（按「没有任务」处理）', e);
    return [];
  }
}

/** 该键是否已在正文缓存里（预缓存窗口用它跳过已缓存的章，省流量） */
export async function hasCachedChapter(key: string): Promise<boolean> {
  try {
    const db = await openDb();
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getKey(key);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}
