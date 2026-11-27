/**
 * `#411`：`java.importScript / cacheFile / readTxtFile / deleteFile` 的**共享判据**。
 *
 * ## 上游语义（`JsExtensions.kt:455-493` / `:826-851`）
 * ```kotlin
 * fun importScript(path) = when { path.startsWith("http") -> cacheFile(path); else -> readTxtFile(path) }
 *     .also { if (it.isBlank()) throw NoStackTraceException("$path 内容获取失败或者为空") }
 * fun cacheFile(urlStr, saveTime) = 命中 CacheManager(路径) 且文件在 → readTxtFile；否则 downloadFile → 缓存 → readTxtFile
 * fun readTxtFile(path) = 文件不存在 → ""      fun deleteFile(path) = FileUtils.delete(file, true)
 * ```
 *
 * ★ **为什么必须实现**：18AV 的 `loginUi`（`@js:` 模板串）**第一个字段名**就是
 * `"ArtPlayer V${java.importScript('https://unpkg.com/artplayer/dist/artplayer.js').match(/artplayer.js.*v(.+)/i)[1]}"`
 * —— 本仓 java 桩此前没有这四个 key，落到 `Proxy` 的「未实现 → 返回空串」兜底：
 * `importScript(...)` 返回的是那个兜底**函数**而不是文本 ⇒ `.match` 不存在 ⇒ TypeError
 * ⇒ **整个 loginUi 求值失败、字段数组为空** ⇒ 对话框静默退化成「打开登录窗口」（违反铁律 4）。
 *
 * ★ **空内容必须抛**（不是返回空串）：上游就是抛；源作者的写法依赖它（`.match(...)[1]` 直接下标）。
 * 静默返回空串只会把「脚本没取到」伪装成「后续规则拿到空值」，排查成本极高。
 *
 * ## 本仓的落点（有意偏离，已在注释里写清）
 * Legado 是「CacheManager 记**磁盘路径** + 磁盘存内容」；本仓没有「阅读私有数据目录」，
 * 文件层落点 = `CacheOps` 的**文件层**（`cache.getFile/putFile`，键带 `file:` 前缀、**按源持久**）：
 * 一层文本存储等价于「路径 + 内容」，且天然跨请求可见（下载过的脚本不会每次重下）。
 * 键算法与上游一致 = `md5Encode16(url)`（32 位 hex 的第 8~23 位）。
 *
 * ⚠️ **拉取文本的传输由调用方注入**（L1 = 同步 `syncHttp`；worker 宿主 = 异步 fetch），
 * 因为两边的传输本就不同（与 `java.ajax` 同一分工）。真正共享的是**四条判据**：
 * 键算法 / 「命中即不下载」/「内容空则不写缓存」/「空则抛」——它们只在本文件里写一次。
 */

import { createHash } from 'node:crypto';
import { isRenderedTextDocument } from '../net/jslib-mirror';

/** 文件层的最小面（= `CacheOps` 的 getFile/putFile/remove，L1 与 worker 共用同一份存储） */
export interface ScriptFileLayer {
  getFile: (k: string) => string | null;
  putFile: (k: string, v: string, saveTime?: number) => void;
  /** `cache.delete(k)`：内存 + 持久 + 文件三层全删（`java.deleteFile` 用它清文件层） */
  remove: (k: string) => void;
}

/** `MD5Utils.md5Encode16(url)` —— 上游 `cacheFile` 的缓存键（32 位 hex 的第 8~23 位） */
export function fileCacheKey(url: string): string {
  return createHash('md5').update(String(url), 'utf-8').digest('hex').slice(8, 24);
}

/**
 * `deleteFile(path)` 的键：URL 用 `md5Encode16`（与 `cacheFile` 对称），否则当字面键
 * （上游这里是**相对路径**；本仓的文件层没有目录概念，故非 URL 一律按字面键处理）。
 */
export function fileKeyOf(path: string): string {
  return /^https?:\/\//i.test(String(path)) ? fileCacheKey(String(path)) : String(path);
}

const markupWarned = new Set<string>();
function warnMarkupOnce(key: string, msg: string): void {
  if (markupWarned.has(key)) return;
  markupWarned.add(key);
  console.warn(`[js-file] ${msg}`);
}

/** 读文件层（未命中 → null，与 `CacheOps.getFile` 同语义） */
export function readScriptFile(cache: ScriptFileLayer | undefined, key: string): string | null {
  const text = cache?.getFile(key) ?? null;
  /**
   * 旧版本会把「浏览器文本阅读器 DOM」当脚本缓存下来（jsLib 撞 WAF → 重放 `.js` 拿到 HTML），
   * 于是每次启动都 `Unexpected token '<'`。这类内容按未命中处理，让调用方重新取。
   */
  if (text && isRenderedTextDocument(text)) {
    warnMarkupOnce(`read:${key}`, `脚本缓存是浏览器文本阅读器 DOM（非脚本原文），按未命中处理：${key}`);
    return null;
  }
  return text;
}

/**
 * 写文件层并返回文本。
 * ⚠️ **空内容不写**：上游 `downloadFile` 失败时也会 `CacheManager.put`（记了个不存在的路径），
 * 于是「首次下载失败」会被缓存成「永久空」——源作者改了网络环境也不会恢复。
 * 这里改成「只有拿到非空内容才缓存」，失败下次仍会重试（有意偏离，对用户更有利）。
 */
export function writeScriptFile(
  cache: ScriptFileLayer | undefined,
  key: string,
  text: string,
  saveTime: number,
): string {
  if (text && !isRenderedTextDocument(text)) cache?.putFile(key, text, saveTime);
  else if (text) warnMarkupOnce(`write:${key}`, `拒绝把浏览器文本阅读器 DOM 当脚本缓存：${key}`);
  return text;
}

/** `deleteFile(path)`：命中才删（对齐上游 `FileUtils.delete` 的布尔返回） */
export function deleteScriptFile(cache: ScriptFileLayer | undefined, path: string): boolean {
  if (!cache) return false;
  const key = fileKeyOf(path);
  const existed = cache.getFile(key) != null;
  cache.remove(key);
  return existed;
}

/**
 * `importScript` 的收尾判据：**内容为空即抛**（上游 `NoStackTraceException`）。
 * 返回原文，方便调用方 `return importScriptEnsure(text, path)` 一行收口。
 *
 * `detail`（`#636`）：把「为什么空」带上。原来的报错只有一个 URL + 一句「内容获取失败或者为空」，
 * 于是「超时 / DNS / 404 / 站点回空」四种完全不同的原因在日志里长得一模一样 ——
 * `#636` 卡了两轮才定位到「主机慢抖 + 单次 12s 必死」，代价就在这里。
 */
export function importScriptEnsure(text: string, path: string, detail?: string): string {
  if (!String(text ?? '').trim()) {
    throw new Error(`${path} 内容获取失败或者为空${detail ? `（${detail}）` : ''}`);
  }
  return text;
}

/**
 * `downloadFile` 的文件后缀（上游 `AnalyzeUrl.type ?: UrlUtil.getSuffix(url)`）。
 *
 * 三处来源，按优先级：
 *  ① url 尾部选项 `,{"type":"html"}` 的 `type`（千白羽/番茄短剧都靠它，**不是**靠后缀）；
 *  ② `data:` URI 的 mime 子类型（`data:text/html;base64,…` ⇒ `html`）；
 *  ③ 路径后缀（去掉 query/fragment 后最后一个 `.xxx`）。
 * 都没有 ⇒ `bin`（上游此时给空串，会让文件名变成 `md5.` —— 反而不如 `bin` 可用）。
 */
export function downloadFileType(url: string): string {
  const u = String(url ?? '');
  const opt = /,\s*(\{[\s\S]*\})\s*$/.exec(u);
  if (opt) {
    try {
      const o = JSON.parse(opt[1] as string) as { type?: unknown };
      const t = String(o.type ?? '').trim().replace(/^\./, '');
      if (t) return t;
    } catch {
      /* 选项不是合法 JSON（源里手写常见）→ 退回后缀 */
    }
  }
  if (/^data:/i.test(u)) {
    const meta = u.slice(5, Math.max(5, u.indexOf(',')));
    const sub = /^[a-z]+\/([A-Za-z0-9.+-]+)/i.exec(meta)?.[1];
    if (sub) return sub.toLowerCase().replace(/^x-/, '');
  }
  const base = u.replace(/,\s*\{[\s\S]*$/, '').split('?')[0]!.split('#')[0]!;
  const dot = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return dot ? (dot[1] as string).toLowerCase() : 'bin';
}

/** 后缀 → mime（只覆盖语料出现的；其余 octet-stream，与上游 FileUtils 的粗粒度一致） */
const MIME_BY_TYPE: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  json: 'application/json',
  js: 'application/javascript',
  css: 'text/css',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export function mimeOfType(type: string): string {
  return MIME_BY_TYPE[String(type ?? '').toLowerCase()] ?? 'application/octet-stream';
}

/**
 * `downloadFile` 的**内容载荷**解码 —— 上游第一个参数既可以是十六进制字符串，
 * 也可以是 `data:` URI（千白羽论坛的兜底分支就写 `downloadFile('data:text/html;base64,'+b64+',{...}')`）。
 *
 * · `data:` ⇒ 按 `;base64` 与否分别 base64 / URL 解码；
 * · 纯十六进制（含空白）⇒ hex 解码（奇数长度截掉末位，与源作者「精确 hex」的预期一致）；
 * · 其余 ⇒ 当 UTF-8 文本（源偶尔直接传文本；上游 `HexUtil.decodeHex` 会抛，这里更宽松，
 *   因为本仓的失败面已经够大，不值得为这种形态再打挂整段规则）。
 */
export function decodeDownloadPayload(payload: unknown): Buffer {
  const s = String(payload ?? '');
  if (/^data:/i.test(s)) {
    const comma = s.indexOf(',');
    if (comma < 0) return Buffer.from('', 'utf-8');
    const meta = s.slice(5, comma);
    const data = s.slice(comma + 1);
    return /;base64/i.test(meta) ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf-8');
  }
  const hex = s.replace(/\s+/g, '');
  if (hex && /^[0-9A-Fa-f]+$/.test(hex)) {
    return Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex');
  }
  return Buffer.from(s, 'utf-8');
}

/* ══════════════════════════════════════════════════════════════════════════════
 * `#636` 第二层：**外部脚本取数的「重试 + 预算」**——唯一实现
 *
 * 谁在用：`Reload(url)`（源作者写在 `jsLib` 里的公共函数）内部就是
 * `java.importScript(url)`；`java.cacheFile` 是同一条下载路径。所以这一处的策略，
 * 等于所有「规则里 `eval(String(Reload(...)))`」的源的策略。
 *
 * ## 为什么必须重试（实测，不是推断）
 * qyyuapi 系（包子漫画 / 漫画柜 / G站 / MYCOMIC …14~20 源）的外链主机**慢且抖**：
 *   · `searchUrl.js` GET 0.3~1.2s、`loginUrl.js` GET 0.3~2.9s（中位 ~1s）
 *   · 同一台机的 `jsLib.js`（47KB）4~9s，`common.js`（180KB）25~30s
 *   · 偶发整段挂死（HEAD 实测一次 25s 未返回）
 * ⇒ 单次尝试（旧：12s / 无重试）撞上抖动就判死；而 `importScript` 一旦返回空，
 *   上层就是 `内容获取失败或者为空` ⇒ 该源所有规则全挂，症状看起来像「规则写错」。
 *
 * ## 为什么异步权重试、同步（L1）不重试
 * L1 的同步传输是 curl 子进程，**阻塞主线程**：3 次 × 20s = 60s 的主线程停摆，
 * 正是 `#480-a` 那类「服务假死 + 所有源陪超时」的机制；而且 `syncHttp` 自带
 * `SYNC_BUDGET_MS=20s` 的预算闸（超了就静默返回空串 ⇒ 第二次重试其实是假重试）。
 * ⇒ **重试只放在 worker 宿主的异步 rpc 路径**（那条路上等待不占主线程，且
 *   `worker-pool` 的 `beginHostWork/endHostWork` 会把宿主耗时还给 eval 预算）。
 *   同步侧保持「单次 + 既有 15s 超时」（`SYNC_HTTP_TIMEOUT_DEFAULT_MS`，与本策略的
 *   `perAttemptMs` 同一量级，不另立一个数）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 重试策略（唯一来源：worker 宿主 + 未来的其它异步取数点都读这一份） */
export interface ScriptFetchPolicy {
  /** 总尝试次数（含首次） */
  maxAttempts: number;
  /** 单次尝试的超时上限（毫秒） */
  perAttemptMs: number;
  /** 整个取数动作的预算（毫秒）——超了就不再开新的一次尝试 */
  totalBudgetMs: number;
}

/**
 * 默认策略。数字来自 `#636` 的实测分布（见上面的文件头注）：
 *  · `perAttemptMs = 20s`：GET 中位 ~1s、最慢观测 ~9s（47KB 库）⇒ 20s 足够，
 *    又不至于让「真挂死」把预算吃光（旧值 60s 单次，一次挂死就用完）。
 *  · `totalBudgetMs = 45s`：3 次 × 20s 的上界之外再设一道总闸，
 *    保证 `Reload` 在最坏情况下也不会把一次搜索拖成分钟级。
 *  · `maxAttempts = 3`：抖动是「偶发」，两次连续失败概率已经很低；再多就是纯等待。
 */
export const SCRIPT_FETCH_POLICY: ScriptFetchPolicy = {
  maxAttempts: 3,
  perAttemptMs: 20_000,
  totalBudgetMs: 45_000,
};

/** 单次尝试的产物（`code = 0` 表示传输层直接失败，拿不到状态码） */
export interface ScriptFetchAttempt {
  text: string;
  code: number;
  /** 本次尝试的失败原因（成功时留空）——只用于拼最终错误信息 */
  error?: string;
}

/** 多尝试之后的结论 */
export interface ScriptFetchOutcome {
  text: string;
  code: number;
  /** 实际尝试了几次（1 表示首次就成/首次就确定性失败） */
  attempts: number;
  /** 全部失败时的可读原因（成功时为空串） */
  failure: string;
}

/** 内容算不算「拿到了」：纯空白等价于空（上游 `isBlank()` 同语义） */
export function isBlankScriptBody(text: unknown): boolean {
  return !String(text ?? '').trim();
}

/**
 * 「这次失败值不值得再试一次」——**纯函数**，便于单测锁定。
 *
 * · 4xx：确定性失败（不存在/被拒）⇒ 不重试（重试只是白等，还拖慢别的源）
 * · 0（传输层失败）、5xx、空 body ⇒ 瞬时 ⇒ 重试
 * · 其它（2xx/3xx 且有内容）⇒ 不算失败
 */
export function shouldRetryScriptFetch(code: number, text: unknown): boolean {
  const c = Number(code) || 0;
  if (c >= 400 && c < 500) return false;
  if (isBlankScriptBody(text)) return true;
  return c === 0 || c >= 500;
}

/**
 * 错误是不是「瞬时」的（可重试）。
 *
 * 与 `engine-legado` 里 jsLib 预下载用的那份**是同一套判词**（`#636` 第一层已实证）：
 * 超时 / 连接重置 / DNS / socket 都是抖动；`HTTP 4xx` 是确定性失败。
 */
export function isTransientScriptFetchError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  if (/HTTP 4\d\d/.test(msg)) return false;
  return /超时|timeout|aborted|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|fetch failed/i.test(
    msg,
  );
}

/** 退避：第一次 300ms、之后 800ms（抖动是秒级，不需要指数退避） */
export function scriptFetchBackoffMs(attempt: number): number {
  return attempt <= 1 ? 300 : 800;
}

/**
 * 异步「取脚本文本」：**可重试、有总预算**。
 *
 * 不抛异常（除非 `fetchOnce` 抛了不可重试的错）——失败用 `failure` 表达，
 * 由调用方决定是「抛上游语义的 `内容获取失败或者为空`」还是「返回空串」。
 *
 * @param fetchOnce 单次尝试；入参是**本次允许的超时**（已按剩余预算收缩过）
 */
export async function fetchScriptTextRetry(
  fetchOnce: (timeoutMs: number) => Promise<ScriptFetchAttempt>,
  policy: ScriptFetchPolicy = SCRIPT_FETCH_POLICY,
): Promise<ScriptFetchOutcome> {
  const t0 = Date.now();
  const errors: string[] = [];
  let lastCode = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt++) {
    const left = policy.totalBudgetMs - (Date.now() - t0);
    // 剩余不够一次「有意义」的尝试就不再开新的（1s 以下连建连都不够，纯浪费）
    if (attempt > 1 && left < 1_000) {
      errors.push(`预算用尽（${policy.totalBudgetMs}ms）`);
      break;
    }
    const perAttempt = Math.max(1_000, Math.min(policy.perAttemptMs, Math.max(left, 1_000)));
    attempts = attempt;
    let cur: ScriptFetchAttempt;
    try {
      cur = await fetchOnce(perAttempt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`第 ${attempt} 次：${msg.slice(0, 120)}`);
      if (!isTransientScriptFetchError(e)) break;
      if (attempt < policy.maxAttempts) await sleepMs(scriptFetchBackoffMs(attempt));
      continue;
    }
    lastCode = Number(cur.code) || 0;
    if (!isBlankScriptBody(cur.text)) {
      return { text: cur.text, code: lastCode, attempts: attempt, failure: '' };
    }
    errors.push(`第 ${attempt} 次：${cur.error ? cur.error.slice(0, 120) : `HTTP ${lastCode} 空响应`}`);
    // 确定性失败（4xx）不再试；其余（0 / 5xx / 200 空体）继续
    if (!shouldRetryScriptFetch(lastCode, cur.text)) break;
    if (attempt < policy.maxAttempts) await sleepMs(scriptFetchBackoffMs(attempt));
  }
  return { text: '', code: lastCode, attempts, failure: errors.join('；') };
}

/**
 * 退避等待。
 *
 * ⚠️ **不能 `unref()`**：这个 Promise 是被 `await` 的，定时器一旦 unref，事件循环没有别的
 * 活干时就会「提前收工」⇒ 该 Promise 永远不 resolve（`node --test` 直接报
 * `Promise resolution is still pending but the event loop has already resolved`）。
 * 本轮第一版就是这么写的，被新锁当场抓住 —— 记录在此，别再"顺手 unref"。
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
