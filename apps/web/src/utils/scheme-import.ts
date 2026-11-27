/**
 * **唤起导入链接归类**（`#343`）——把 `legado://` / `yuedu://` 一键导入链接解析为动作。
 *
 * ## 上游语义（读自 Legado 源码，逐条提取，不猜）
 * - Manifest：`legado` 与 `yuedu` 两个 scheme **等价**（AndroidManifest.xml:406-407，都进
 *   OnLineImportActivity），scheme 本身不参与分发，分发只看 path/host。
 * - 格式：`{scheme}://import/{path}?src={url}`（OnLineImportActivity.kt:16-19 类注释），
 *   以及旧式分享链接 `{scheme}://{host}/importonline?src={url}` —— 此时 path=/importonline、
 *   host=booksource|rsssource|replace（OnLineImportActivity.kt:113-126）。
 * - path 分发表（OnLineImportActivity.kt:81-128）：/bookSource /rssSource /replaceRule
 *   /textTocRule /httpTTS /dictRule /theme /autoTask /auto /readConfig /addToBookshelf
 *   /importonline；**未列出的 path 落 determineType**（下载内容按 jsonImportType 判型，
 *   OnLineImportActivity.kt:127 else 分支）。
 * - 内容判型表 = jsonImportType（BaseAssociationViewModel.kt:29-69）：JSON **数组取首个元素**
 *   判型（importJson 先 read("$[0]")，失败才 read("$")，BaseAssociationViewModel.kt:16-26）；
 *   highlightRule 的 TYPE 常量 = "highlightRule"（HighlightRule.kt:110）。
 *
 * ## 本仓支持范围（按「有没有对应实体/端点」划界，不硬塞）
 * - 书源 / 订阅源 → `/api/sources/import`（同一端点，kind 由导入解析判）
 * - 替换（净化）规则 → 复用净化导入对话框（显式 path 直开；determine 判出时喂文本）
 * - 其余上游类型（txt 目录规则 / 朗读 TTS / 字典规则 / 主题 / 自动任务 / 阅读配置 / 书架 /
 *   高亮规则）本仓**无对应实体** ⇒ 明确报「暂不支持」，不静默吞。
 */

/**
 * 深链的来源与派发（`#347`）——**唯一实现**，两端共用。
 *
 * ## 为什么需要它（两条入口，一个处理器）
 * 同一个 `yuedu://import/bookSource?src=…` 有**两条**到达路径：
 *  ① **网页/WebView 里点链接** ⇒ 壳层导航桥 `postMessage` 给 `ReaderOverlay`（`#336`）；
 *  ② **桌面端**：Windows 起第二个进程并把 URL 塞进 argv ⇒ 主进程 IPC 给渲染进程（`#347`）。
 * 两条都必须落到**同一段处理逻辑**（`ReaderOverlay.onLegadoUrl`）。
 *
 * ★ 反例（本仓踩过的踩法）：在 `desktop.ts` 里**重写一遍**判型与对话框打开 ⇒
 *   同一判据写两处必然漂移。故：`desktop.ts` 只负责把 URL **投递**进来（`dispatchSchemeImport`），
 *   由 `ReaderOverlay` 在 `onMounted` 时**注册**处理函数（`setSchemeImportHandler`）。
 */
type SchemeImportHandler = (url: string) => void;
let schemeImportHandler: SchemeImportHandler | null = null;
/** 处理器还没注册时先攒着（桌面端冷启动：IPC 可能早于组件挂载） */
const schemeImportQueue: string[] = [];

/** `ReaderOverlay` 挂载时注册（卸载时传 `null`）。注册后立即补发排队中的深链。 */
export function setSchemeImportHandler(fn: SchemeImportHandler | null): void {
  schemeImportHandler = fn;
  if (!fn) return;
  const pending = schemeImportQueue.splice(0, schemeImportQueue.length);
  for (const u of pending) fn(u);
}

/** 投递一条深链（桌面端 IPC / 其它入口）。处理器未注册时入队，不丢。 */
export function dispatchSchemeImport(url: string): void {
  const u = String(url || '').trim();
  if (!u) return;
  if (schemeImportHandler) schemeImportHandler(u);
  else schemeImportQueue.push(u);
}

/** classifySchemeImport 的归类结果（`invalid` 含：解析失败 / 缺 src 参数） */
export type SchemeImportAction =
  | { kind: 'sources' } // 书源 / 订阅源
  | { kind: 'replaceRule' } // 替换（净化）规则
  | { kind: 'determine' } // 需抓取内容按 jsonImportType 判型
  | { kind: 'unsupported'; label: string } // 上游支持、本仓无实体
  | { kind: 'invalid' };

/** 上游已登记、但本仓无对应实体的 path（显示给用户的中文标签） */
const UNSUPPORTED_PATHS: Record<string, string> = {
  '/texttocrule': 'txt 目录规则',
  '/httptts': '朗读 TTS 源',
  '/dictrule': '字典规则',
  '/theme': '主题',
  '/autotask': '自动任务',
  '/readconfig': '阅读配置',
  '/addtobookshelf': '加入书架',
};

/**
 * 链接 → 动作。path 大小写不敏感（分享站实际大小写混乱；上游大小写敏感的 path 未命中时
 * 落 determineType 兜底，本仓宽容匹配后结果等价 —— 书源 URL 判型结果仍是 bookSource）。
 */
export function classifySchemeImport(raw: string): { action: SchemeImportAction; src: string } {
  const m = /[?&]src=([^&]+)/.exec(raw);
  const src = m?.[1] ? decodeURIComponent(m[1]) : '';
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  if (!u || !src) return { action: { kind: 'invalid' }, src: '' };
  const host = u.host.toLowerCase();
  const path = (u.pathname || '/').toLowerCase();
  // 旧式分享链接：path=/importonline，再按 host 分（OnLineImportActivity.kt:113-126）
  if (path === '/importonline') {
    if (host === 'booksource' || host === 'rsssource') return { action: { kind: 'sources' }, src };
    if (host === 'replace') return { action: { kind: 'replaceRule' }, src };
    return { action: { kind: 'determine' }, src };
  }
  if (path === '/booksource' || path === '/rsssource') return { action: { kind: 'sources' }, src };
  if (path === '/replacerule') return { action: { kind: 'replaceRule' }, src };
  if (path === '/auto') return { action: { kind: 'determine' }, src };
  const label = UNSUPPORTED_PATHS[path];
  if (label) return { action: { kind: 'unsupported', label }, src };
  // 上游未登记的 path → determineType 兜底（OnLineImportActivity.kt:127）
  return { action: { kind: 'determine' }, src };
}

/** detectJsonImportType 的判型结果（本仓能接的 + 要明确说「暂不支持」的） */
export type JsonImportType =
  | 'bookSource'
  | 'rssSource'
  | 'replaceRule'
  | 'theme'
  | 'dictRule'
  | 'txtRule'
  | 'httpTts'
  | 'autoTask'
  | 'bookshelf'
  | 'highlightRule';

/**
 * JSON 文本 → 上游 jsonImportType 判型（BaseAssociationViewModel.kt:29-69 逐条对齐，
 * 顺序敏感 —— pattern+style+uuid 无 replacement 是高亮规则，pattern+(style|uuid) 是
 * 上游显式判「格式不对」）。数组取首个元素判型；解析失败 / 非对象 ⇒ null。
 */
export function detectJsonImportType(text: string): JsonImportType | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const probe = Array.isArray(j) ? j[0] : j; // 上游先 read("$[0]") 失败才 read("$")
  if (probe == null || typeof probe !== 'object' || Array.isArray(probe)) return null;
  const m = probe as Record<string, unknown>;
  if (m['type'] === 'highlightRule') return 'highlightRule';
  if ('bookSourceUrl' in m) return 'bookSource';
  if ('sourceUrl' in m) return 'rssSource';
  if ('pattern' in m && 'style' in m && 'uuid' in m && !('replacement' in m)) return 'highlightRule';
  if ('pattern' in m && ('style' in m || 'uuid' in m)) return null;
  if ('pattern' in m) return 'replaceRule';
  if ('themeName' in m) return 'theme';
  if ('showRule' in m) return 'dictRule';
  if ('name' in m && 'rule' in m) return 'txtRule';
  if ('cron' in m && 'script' in m) return 'autoTask';
  if ('name' in m && 'url' in m) return 'httpTts';
  if ('name' in m && 'author' in m) return 'bookshelf';
  return null;
}
