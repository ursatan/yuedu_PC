// 与 Fastify 服务通信的薄封装（REST + SSE 流式聚合）

import { androidToast } from './android-toast';
// `#482` 验证门：拿到 `needVerification` 时等人工在浮层里过验证，通过后自动重跑一次
import { requestVerification } from './utils/verification-gate';
// `#208` ⑤ UI 集成：口令解码与直链规则类型来自契约层（深路径入口，见 `core/contract/index.ts` 的「两处放行」）
import type { DirectLinkUploadRule, ImportResult as SnapshotImportResult, SourceHealth } from '@yuedu/core/contract';
// `#740` 纯 Web 端验证码浮层的类型（认领 consumer / pending 元数据）
import type { VerifyCodeConsumer, VerifyCodeMeta } from './utils/verify-code';

export interface EngineInfo {
  kind: string;
  version: string;
  capabilities: string[];
}
export interface SrcState {
  enabled: boolean;
  searchEnabled: boolean;
  exploreEnabled: boolean;
  /**
   * `#428`（`D12`=A）**该源忽略 TLS 校验**（站点证书过期/自签名时才用）。
   * ⚠️ 缺省 `false`（与上面三条相反 —— 它是安全开关），开启后该源的请求不再校验服务端身份。
   */
  allowInsecureTls: boolean;
}
export interface SourceInfo {
  id: string;
  kind: string;
  /** `#335` 源的源地址（id 是有损规范化形态，反解不出原地址 ⇒ 需要它来「直接打开网页」） */
  url?: string;
  name?: string;
  state: SrcState;
  addedAt: number;
  group?: string;
  customOrder?: number;
  respondTime?: number;
  comment?: string;
  loginUrl?: string;
  /** 登录形态：none / url、config-url（打开登录页）/ js（执行脚本）/ ui（loginUi 表单） */
  loginKind?: string;
  loginNeedBrowser?: boolean;
  /** 是否已保存账号密码（免浏览器登录脚本用） */
  hasLoginInfo?: boolean;
  /** 是否具备发现能力（legado：有 exploreUrl/ruleExplore 规则；CMS 恒 true） */
  hasExplore?: boolean;
  /**
   * `#293` **是否具备搜索能力**（legado：`searchUrl` 或 `ruleSearch.searchUrl` 非空；
   * CMS/演示源恒 true）。判据与引擎取搜索模板的表达式逐字一致（服务端 `publicSource`）。
   *
   * ⚠️ 与 `state.searchEnabled` **正交**：`hasSearch` 是「**能不能**搜」（能力事实，
   * 源里没写搜索规则就是不能），`searchEnabled` 是「**要不要**搜」（用户开关）。
   * 源列表的「搜索」滑块以 `hasSearch` 为准（不能搜的源显示关闭且不可点），
   * 它与「启用」滑块（`enabled`）的口径一致：能力门 + 用户开关两层。
   */
  hasSearch?: boolean;
  /** `#335` **网页型订阅源**（`singleUrl === true`）：点开即网页，发现页应直接开阅读页 */
  webViewOnly?: boolean;
  /**
   * `#404` **订阅源有「启动页」**（`startHtml` 非空，静态近似）：发现页据此决定是否去调
   * `action=start` 取启动页 HTML。真值以 `start` 返回的 `html` 是否非空为准。
   */
  hasStartPage?: boolean;
  /**
   * `#583` **源的自绘 UI 开关**（Legado `customButton` / `eventListener`）。
   * 详情页据此决定是否渲染「源按钮」——按钮点击走 `POST /api/source-ui/eval`（event 由服务端取源脚本）。
   */
  customButton?: boolean;
  eventListener?: boolean;
  /**
   * `#307` **源图标 URL**（服务端 `publicSource` 取上游 `RssSource.sourceIcon`；
   * 书源没有图标字段 ⇒ 恒空）。前端「有就显示、加载失败或为空回落首字母头像」。
   */
  icon?: string;
  /**
   * `#237` **源类型**（内容形态，**不是**引擎 kind）：文本 / 音频 / 图片 / 文件 / 视频。
   * 来自上游 `BookSource.bookSourceType`（服务端已按 `mapKind` 口径映射好）。
   * ⚠️ 与 `kind` 正交：`kind` = 引擎（legado/maccms/demo），`sourceType` = 内容形态。
   */
  sourceType?: 'text' | 'audio' | 'image' | 'file' | 'video';
  /**
   * `#238` **是否处于置顶态** —— 由服务端的置顶名单给出（`/api/sources` 每项都带）。
   *
   * ⚠️ **别再用 `customOrder` 猜**：多源置顶时好几个源的值都比别的小，
   * 「严格小于其余所有源」那种判据数学上只可能有一个成立（这正是 #238 修的缺陷）。
   */
  pinned?: boolean;
  lastUpdateTime?: number;
  /**
   * `B6` **体检结果**（服务端 `publicSource` 下发）：五态 + 质量分 + `deadUntil`。
   * 未体检过的源无此字段 —— 排序/展示按 `effectiveSourceQuality` 的中性分处理。
   */
  health?: SourceHealth;
}

const BASE = '/api';

export async function getEngines(): Promise<EngineInfo[]> {
  const r = await fetch(`${BASE}/engines`);
  return r.json();
}

/** `#394` 二级解析结果（服务端 `media-resolve.ts` 的 JSON） */
export interface MediaResolveResult {
  ok: boolean;
  /** ok=true ⇒ 可播直链（可能就是原地址）；ok=false 恒空串 */
  url: string;
  format?: string;
  alternatives?: string[];
  headers?: Record<string, string>;
  kind: 'direct' | 'page' | 'none';
  reason?: string;
}

/**
 * `#394` **解析云二级解析**：把解析页 URL（如 AGE 选集的 `jx…:8443/m3u8/?url=…`）
 * 换成可播直链。`ok:false` 是**业务结果**不是网络错误（服务端恒回 200）。
 */
export async function resolveMediaPage(u: string): Promise<MediaResolveResult> {
  const r = await fetch(`${BASE}/media-resolve?u=${encodeURIComponent(u)}`);
  const j = (await r.json().catch(() => null)) as MediaResolveResult | null;
  if (!j) return { ok: false, url: '', kind: 'none', reason: `HTTP_${r.status}` };
  return j;
}


export interface SourcesPayload {
  sources: SourceInfo[];
  /** 被界面删掉、磁盘上仍有文件的源 id（可「恢复已删除」一键还原） */
  removed: string[];
  /** `#645` 回收站清单：有名字/删除时间，两种源都在（用户源带 raw，文件源靠磁盘文件） */
  trash: TrashItem[];
}

/** `#645` 回收站条目 */
export interface TrashItem {
  id: string;
  name?: string;
  kind?: string;
  /** 删除时间戳（0 = 旧墓碑迁移进来的，时间未知） */
  deletedAt: number;
  /** true = 文件源（文件仍在磁盘）；false = 用户源（恢复靠服务端存的 raw） */
  fileBacked: boolean;
  /** 用户源是否带了 raw（没带就恢复不了，界面要标出来） */
  hasRaw: boolean;
}

export async function getSourcesPayload(kind?: string): Promise<SourcesPayload> {
  const url = kind ? `${BASE}/sources?kind=${encodeURIComponent(kind)}` : `${BASE}/sources`;
  const r = await fetch(url);
  const j = await r.json();
  return {
    sources: (j.sources ?? []) as SourceInfo[],
    removed: (j.removed ?? []) as string[],
    trash: (j.trash ?? []) as TrashItem[],
  };
}

export async function getSources(kind?: string): Promise<SourceInfo[]> {
  return (await getSourcesPayload(kind)).sources;
}

/**
 * `#625` URL → 书源识别的命中结果（服务端 `POST /api/shelf/resolve-url` 的每一项）。
 *
 * `by` 是上游三级链的哪一级命中的（`source-match.ts`）：`,{origin}` 显式指定 / 域名等值 /
 * `bookUrlPattern` 整串匹配。界面把它显示出来，用户就知道「为什么给我选这个源」。
 */
export interface UrlResolveMatch {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  kind: string;
  by: 'url-option-origin' | 'base-url' | 'bookUrlPattern';
  /** 归一化后的 bookUrl（保留 `,{...}` 尾巴 —— 尾巴里可能是 POST/headers 选项） */
  bookUrl: string;
  steps: { step: string; tested: number; note: string }[];
}

export interface UrlResolveItem {
  url: string;
  match?: UrlResolveMatch;
}

/**
 * `#625` 粘贴链接 ⇒ 反查该用哪个源（纯本地判定，服务端不发请求）。
 * 多行 / 数组都吃（上游 `bookUrls.split("\n")`）。
 */
export async function resolveUrlSource(url: string | string[]): Promise<{ total: number; hit: number; candidates: number; items: UrlResolveItem[] }> {
  const r = await fetch(`${BASE}/shelf/resolve-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const j = (await r.json().catch(() => null)) as
    | { total?: number; hit?: number; candidates?: number; items?: UrlResolveItem[]; error?: string; detail?: string }
    | null;
  if (!j) throw new Error(`HTTP_${r.status}`);
  if (j.error) throw new Error(j.detail || j.error);
  return { total: j.total ?? 0, hit: j.hit ?? 0, candidates: j.candidates ?? 0, items: j.items ?? [] };
}

/** 恢复已删除（`#269` 选择式）：给 `ids` 只恢复所选；不给 = 清空墓碑（全部恢复） */
export async function restoreRemoved(ids?: string[]): Promise<{ cleared: number; total: number }> {
  const r = await fetch(`${BASE}/sources/restore-removed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ids?.length ? { ids } : {}),
  });
  return r.json();
}

/** `#269` 清空已删除列表（`#645` 起语义 = 恢复全部：文件源重扫回来、用户源用 raw 重新入库） */
export async function clearRemoved(): Promise<{ cleared: number }> {
  const r = await fetch(`${BASE}/sources/clear-removed`, { method: 'POST' });
  return r.json();
}

/** `#645` 永久删除：把所选回收站条目真正丢掉（用户源 raw 丢弃；文件源文件不删、不再加载） */
export async function purgeRemoved(ids: string[]): Promise<{ purged: number }> {
  const r = await fetch(`${BASE}/sources/purge-removed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  return r.json();
}

export async function setSourceState(
  id: string,
  patch: Partial<SrcState>,
): Promise<{ id: string; state: SrcState }> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return r.json();
}

/**
 * SSE 聚合搜索：用 fetch 流式读取（服务端是 POST）。
 * onEvent 在每条 EngineEvent 到达时回调。
 */
export async function aggregateSearch(
  keyword: string,
  opts: { kinds?: string[]; groups?: string[]; limit?: number; concurrency?: number;
          /** `#273` 源白名单：只搜这几个（idle 懒加载 / 单源翻页） */
          sourceIds?: string[]; page?: number;
          /**
           * `#292` 中止信号：弹层/对话框关闭 ⇒ abort。
           *
           * ⚠️ 不能进 body（`JSON.stringify` 会把 `AbortSignal` 序列化成 `{}`）——
           * 所以这里显式解构出来只给 fetch 用（与 `runAction` 同一处理）。
           */
          signal?: AbortSignal } = {},
  onEvent: (ev: EngineEvent) => void,
): Promise<void> {
  const { signal, ...rest } = opts;
  const r = await fetch(`${BASE}/aggregate/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword, ...rest }),
    signal,
  });
  if (!r.body) return;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) {
        try {
          const ev = JSON.parse(line.slice(6)) as EngineEvent;
          /*
           * 源脚本 toast（`java.toast` / `java.longToast`）随 SSE 流逐条下发。
           * 集中在这里展示即可 —— 聚合搜索的调用方都不必各自处理（与 `runAction` 的
           * `showRunToasts` 同一意图：反馈通路只在一个地方）。
           */
          if (ev.type === 'toast') {
            const s = String(ev.text ?? '').trim();
            if (s) androidToast(s);
          }
          onEvent(ev);
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
}

export interface ScanSummary {
  scanned: string[];
  ok: string[];
  failed: Record<string, string>;
}
export type EngineEvent =
  | { type: 'items'; sourceId: string; items: unknown[] }
  | { type: 'done'; sourceId: string; ok: boolean }
  | { type: 'trace'; sourceId: string; entry: unknown }
  /** 源脚本 `java.toast` / `java.longToast` 的原话（聚合搜索 SSE 事件流里逐条下发） */
  | { type: 'toast'; sourceId: string; text: string }
  | { type: 'scan'; scanned: string[]; ok: string[]; failed: Record<string, string> };

// ---- M5：源编辑 / 删除 / 批量校验 / 调试运行 ----

export interface ValidationIssue {
  level: string;
  path: string;
  message: string;
}
export interface ValidateSummary {
  total: number;
  okCount: number;
  failedCount: number;
  results: Array<{ id: string; kind: string; name?: string; ok: boolean; issues: ValidationIssue[] }>;
}

export async function updateSource(
  id: string,
  raw: unknown,
): Promise<{ id: string; kind: string; name?: string }> {
  /**
   * `#647` 走 **body 版**（`POST /sources/save`），不用 `PUT /sources/:id`。
   *
   * 原因：源 id = `bookSourceUrl` 规范化，而部分源的 `bookSourceUrl` 是**长文本**
   * （实测 📚木里聚合：120+ 字符的项目说明）⇒ 塞进路径会撞 URL 长度上限，
   * 前端只看到 `保存失败：Bad Request` / `414`。
   */
  const r = await fetch(`${BASE}/sources/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, raw }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

/**
 * `#653` CMS 分类（本地缓存）：GET 命中缓存（无则生成一次），POST 强制重拉。
 * 返回 `{count, items:[{label, typeId}]}` —— URL 由服务端在缓存里生成，这里不拼。
 */
export interface CmsCategoryItem {
  label: string;
  typeId: string;
}

export async function getCmsCategories(id: string): Promise<{ count: number; items: CmsCategoryItem[] }> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/categories`);
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function refreshCmsCategories(id: string): Promise<{ count: number; items: CmsCategoryItem[] }> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/categories/refresh`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function deleteSource(id: string): Promise<void> {
  /**
   * `#647` 走 **body 版**（`POST /sources/delete`）。
   *
   * 实测（📚木里聚合）：`DELETE /api/sources/<120+ 字符的 id>` ⇒ **HTTP 414**（URI Too Long），
   * 界面上就是「删除失败 414」，这个源从此删不掉；同一列表里 id 短的源正常。
   * 服务端已提供 body 版（路径版保留兼容），前端改用它即可，无需关心 id 有多长。
   */
  const r = await fetch(`${BASE}/sources/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!r.ok) throw new Error('删除失败 ' + r.status);
}

/**
 * `#359` **源变量**（Legado「设置源变量」）—— `source.getVariable()` 读的就是它。
 *
 * 为什么必须有这个入口：qyyuapi 那一类聚合源（`Movieffm` / `剧迷` / `西瓜卡通` /
 * `袋鼠影视` / `爱动漫网`）的 `sourceUrl` / `searchUrl` 写成
 * `名@js:Get('url')...`，而 `Get(e)` 的定义就是 `JSON.parse(source.getVariable())[e]`
 * ⇒ **源变量为空时 `JSON.parse('')` 直接抛 `Unexpected end of JSON input`**。
 * 上游同源：`BaseSource.getVariable()` = `CacheManager.get("sourceVariable_…") ?: ""`
 * （`BaseSource.kt:351`），App 里也是用户手动填的（`RssSortActivity.setSourceVariable`）。
 *
 * ★ 服务端端点早就有了（`/api/sources/:id/variable` 的 GET/POST），缺的只是界面
 *   ⇒ 用户看到报错也**无处可填**。这一层只做 IO。
 */
export async function getSourceVariable(id: string): Promise<string> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/variable`);
  if (!r.ok) return '';
  const j = (await r.json()) as { value?: string };
  return typeof j.value === 'string' ? j.value : '';
}
/**
 * `#583` **源脚本 UI 动作**（Legado 图片选项 `click` / `ruleContent.callBackJs`）。
 *
 * 浏览器不能跑源 jsLib（那是引擎侧的 JS 环境）⇒ 这段 JS 一律交服务端在**该源的真实环境**里
 * 求值，返回它要弹出的面板地址（`java.showBrowser` 记录的 data URL）。
 *
 * 两种入参：
 *  · 正文图片按钮：`{ code }`（选项 JSON 里的 `click` 原文）；
 *  · 详情页「源按钮」：`{ event }`（服务端从源的 `ruleContent.callBackJs` 取脚本）。
 */
export async function evalSourceUi(
  sourceId: string,
  opts: { code?: string; event?: string; bookUrl?: string; bookName?: string; chapterUrl?: string },
): Promise<{ value?: string; browserUrl?: string; toasts?: string[] }> {
  const r = await fetch(`${BASE}/source-ui/eval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, ...opts }),
  });
  const j = (await r.json()) as { error?: string; value?: string; browserUrl?: string; toasts?: string[] };
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function setSourceVariable(id: string, value: string): Promise<string> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/variable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const j = (await r.json()) as { value?: string };
  if (!r.ok) throw new Error(String((j as { error?: string }).error ?? r.status));
  return typeof j.value === 'string' ? j.value : '';
}

/**
 * 源**置顶 / 置底 / 取消置顶**（`#166` / `#238`）。
 *
 * 服务端只改 `customOrder` 并落盘（上游 `BookSource.customOrder`，
 * 见 `BookSource.kt:46` 与 `BookSourceDao.kt` 的 `order by customOrder asc`）。
 * ★ **不要**改用 `updateSource()` 传整份源来实现这件事 —— 那是全量替换，客户端少回传一个字段就把源改坏。
 *
 * `#238` 起「置顶态」由**服务端的有序名单**维护 ⇒
 *  · 支持**多个源同时置顶**，最后置顶的排在最顶；
 *  · 取消置顶能**精确排回置顶前**的位置（原值存在服务端，不再依赖前端内存 Map）；
 *  · 返回 `pinned`（当前完整名单，索引 0 = 最顶）与 `customOrder`（受影响源的新值）
 *    ⇒ 前端**就地更新**那一行即可，不必全量重拉 570 个源（那正是「点一下要等一会儿」的成因）。
 */
export async function setSourceOrder(
  id: string,
  position: 'top' | 'bottom' | 'reset',
): Promise<{ ok: boolean; customOrder: number; pinned?: string[]; approximated?: boolean }> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ position }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function validateAll(): Promise<ValidateSummary> {
  const r = await fetch(`${BASE}/sources/validate-all`, { method: 'POST' });
  return r.json();
}

export async function runAction(
  sourceId: string,
  action: string,
  opts: {
    keyword?: string;
    page?: number;
    id?: string;
    filters?: Record<string, string>;
    extra?: Record<string, unknown>;
    /** `#306` 跨页通道：上一页结果给的下一页 URL，原样回传（与页码无关的那类源） */
    nextUrl?: string;
    /**
     * `#482` **不要再为同一条请求弹第二次验证浮层**（内部重试用）。
     *
     * 撞 CF 时服务端已自动开好内嵌验证会话；`runAction` 会等用户在浮层里过完验证，
     * 然后**自动重跑一次**。重跑必须带这个标记，否则「过不了验证的源」会变成
     * 「浮层关不掉 + 请求无限重放」。
     */
    noVerifyRetry?: boolean;
    /**
     * `#241` **中断上一次请求**。
     *
     * 为什么要它：发现页切分类 / 切源时，旧请求还在飞（有的源单次 home 要 2~5s）。
     * 旧实现是「排队等它跑完」⇒ 用户点了新分类要干等好几秒。
     * `AbortController` 能让浏览器**立刻丢掉这个响应**（连接一起断掉），
     * 新请求立即发出。
     *
     * ⚠️ 服务端**不会**因此停止手上的活（它已经把请求发给源站了）——
     *   这里省掉的是「用户等它」和「一份响应体传输」，不是源站侧的请求。
     *   这一点在 `stores/discover.ts` 的注释里也写明了，避免误以为省了带宽。
     */
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  // ★ `signal` 只给 fetch 用，**不能**进 body（JSON.stringify 会把它序列化成 `{}` 发给服务端）
  const { signal, noVerifyRetry, ...bodyOpts } = opts;
  const r = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, action, ...bodyOpts }),
    signal,
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  /**
   * `#482` **撞 CF / 验证码 ⇒ 在页面内的浮层里过验证，过完自动重跑一次**。
   *
   * 之前这类请求只是干报错（「HTTP 403」/「0 张卡片」），用户得自己跑到源管理里点「登录」、
   * 再去找那只弹出的独立 Chrome —— 现在服务端已经在响应里带回了开好的验证会话，
   * 这里等用户过完（`requestVerification` 内部按源去重，多个动作只弹一次），通过后重跑。
   *
   * ★ 客户端已 abort（切源/关页面）时**不等待**：门一开就是几十秒，挂着一个没人看的浮层没意义。
   */
  const need = pickNeedVerification(j);
  if (need && !noVerifyRetry && !signal?.aborted) {
    const passed = await requestVerification({ sourceId, sessionId: need.sessionId, url: need.url });
    if (passed) return runAction(sourceId, action, { ...opts, noVerifyRetry: true });
  }
  /**
   * `#642` **撞了挑战页但没能开成验证窗**（服务端没有完整浏览器 / 开窗抛错）⇒ 明确说一句。
   *
   * 旧行为是「静默 0 条」：用户以为源坏了，实际是站点拦截页。有 `needVerification` 时
   * 上面的浮层已经说清了，这里不再重复打扰。
   */
  if (!need) showNetChallengeNotice(j);
  if (!r.ok) throw new Error(describeRunError(j, r.status));
  showRunToasts(j);
  showNetTruncatedNotice(j);
  return j;
}

/**
 * `#512` **详情流式**（SSE）：`info` 事件先到（书籍信息，无目录），`done` 带完整结果。
 *
 * 为什么要有它：目录是详情页最耗时的一段（一次额外抓取 + 数百上千章逐章求值），而书名/作者/
 * 简介/封面早就求值完了。走流式后前端可以先渲染详情头部，目录到了再补列表。
 *
 * ⚠️ 任何异常（老服务端没有该路由 / 流中断）都向上抛 ⇒ 调用方回退普通 `runAction`，
 * 从而保留验证重试、toast、截断提示等既有语义。
 */
/**
 * `#515` 渲染是否共享宿主浏览器（设置页开关，服务端持久化到 `data/browser-config.json`）。
 *
 * `persisted` = 落盘值（null 表示从未设置过），`env` = 环境变量是否开启了它 ——
 * 设置页据此展示「跟随环境变量 / 已显式设置」的区别。
 */
/** `#516` 清空所有源 Cookie（含渲染凭证）；返回被清的源数与删掉的 context 凭证文件数 */
export async function clearAllCookies(): Promise<{ cleared: number; ctxFiles: number }> {
  const r = await fetch(`${BASE}/cookies`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`cookies ${r.status}`);
  return (await r.json()) as { cleared: number; ctxFiles: number };
}
export async function getBrowserContextMode(): Promise<{ enabled: boolean; persisted: boolean | null; env: boolean }> {
  const r = await fetch(`${BASE}/browser/context`);
  if (!r.ok) throw new Error(`browser/context ${r.status}`);
  return (await r.json()) as { enabled: boolean; persisted: boolean | null; env: boolean };
}
export async function setBrowserContextMode(enabled: boolean): Promise<void> {
  const r = await fetch(`${BASE}/browser/context`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`browser/context ${r.status}`);
}

export async function runDetailStream(
  sourceId: string,
  id: string,
  onInfo: (d: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/run/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId, action: 'detail', id }),
  });
  if (!r.ok) throw new Error(`detail stream unavailable (${r.status})`);
  // `#695` 帧解析收进 `readSse`（原本这里手写一份，与流式校验重复）
  let result: Record<string, unknown> | null = null;
  await readSse(r, (event, j) => {
    if (event === 'info') onInfo(j);
    else if (event === 'done') result = j;
    else if (event === 'error') throw new Error(String(j['message'] ?? j['error'] ?? 'detail failed'));
  });
  if (!result) throw new Error('detail stream ended without done');
  return result;
}

// ---------------------------------------------------------------------------
// `#482` 内嵌验证窗（Cloudflare / 验证码：不弹独立 Chrome，在页面里的浮层内过）
// ---------------------------------------------------------------------------

/** `/api/run` 响应里「需要人工过验证」的提示（服务端已自动开好会话） */
export interface NeedVerification {
  sessionId: string;
  url: string;
  phase: string;
}

/** 从 `/api/run` 的响应里取验证提示（**成功与失败 body 都可能带**）；没有则 `null` */
export function pickNeedVerification(j: unknown): NeedVerification | null {
  const v = (j ?? ({} as Record<string, unknown>)) as Record<string, unknown>;
  const n = v['needVerification'] as Record<string, unknown> | undefined;
  if (!n || typeof n['sessionId'] !== 'string') return null;
  return { sessionId: String(n['sessionId']), url: String(n['url'] ?? ''), phase: String(n['phase'] ?? '') };
}

async function verifyCall(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j['message'] ?? j['error'] ?? `${method} ${path} 失败（${r.status}）`));
  return j;
}

/** 开验证会话（同一源复用；服务端浏览器在后台启动，本调用不阻塞到就绪） */
export async function startVerification(sourceId: string, url?: string): Promise<NeedVerification> {
  const j = await verifyCall(`/sources/${encodeURIComponent(sourceId)}/verify/start`, 'POST', { ...(url ? { url } : {}) });
  return { sessionId: String(j['id'] ?? ''), url: String(j['url'] ?? url ?? ''), phase: String(j['phase'] ?? 'starting') };
}

/** 该源当前有没有在跑的验证会话 */
export async function verificationStatus(sourceId: string): Promise<NeedVerification | null> {
  const j = await verifyCall(`/sources/${encodeURIComponent(sourceId)}/verify`, 'GET');
  const s = j['session'] as Record<string, unknown> | null | undefined;
  return s && typeof s['id'] === 'string'
    ? { sessionId: String(s['id']), url: String(s['url'] ?? ''), phase: String(s['phase'] ?? '') }
    : null;
}

/** 帧流（SSE）：与聚合搜索同一套 `fetch + reader` 解析（项目里不用 `EventSource`） */
export async function verificationStream(
  sessionId: string,
  onEvent: (ev: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  const r = await fetch(`${BASE}/verify/${encodeURIComponent(sessionId)}/stream`, { signal });
  if (!r.body) return;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as Record<string, unknown>);
        } catch {
          /* 坏帧跳过 */
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 忽略 */
    }
  }
}

/** 输入回灌：`type` = click / move / wheel / text / key；`x,y` 为**页面 CSS 像素** */
export async function verificationInput(
  sessionId: string,
  ev: {
    type: 'click' | 'move' | 'wheel' | 'text' | 'key';
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    /** `key` 的物理键位（`Input.dispatchKeyEvent` 的 `code`；缺省由服务端按 `key` 推） */
    code?: string;
    deltaY?: number;
  },
): Promise<void> {
  await verifyCall(`/verify/${encodeURIComponent(sessionId)}/input`, 'POST', ev);
}

/** 换地址（同一只浏览器，不重开进程） */
export async function verificationNavigate(sessionId: string, url: string): Promise<void> {
  await verifyCall(`/verify/${encodeURIComponent(sessionId)}/navigate`, 'POST', { url });
}

/** 抓 Cookie 写入该源（与登录窗同一套过滤/落盘）⇒ 后续重放能带上清关凭据 */
export async function verificationHarvest(
  sessionId: string,
  opts: { close?: boolean } = {},
): Promise<{ ok: boolean; count: number; picked: string[] }> {
  const j = await verifyCall(`/verify/${encodeURIComponent(sessionId)}/harvest`, 'POST', opts);
  return { ok: j['ok'] === true, count: Number(j['count'] ?? 0), picked: (j['picked'] as string[]) ?? [] };
}

/** 关闭验证会话（保留浏览器进程与 profile，后续重放还要用） */
export async function verificationClose(sessionId: string): Promise<void> {
  await verifyCall(`/verify/${encodeURIComponent(sessionId)}`, 'DELETE');
}

/* =========================================================================
 * `#740` `java.getVerificationCode`：**纯 Web 端**的验证码浮层通道
 *
 * 服务端半边（`#727`）已齐：pending / frame / state / 提交 / 取消 / 换一张。
 * 桌面端主进程走同一组端点开 `BrowserWindow`；这里给浏览器用户用，并用
 * `consumer=web` 做**认领**（谁先认领谁独占，避免双开窗口）。
 * ========================================================================= */
export type {
  VerifyCodeConsumer,
  VerifyCodeMeta,
  VerifyCodeState,
} from './utils/verify-code';

async function verifyCodeJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j['message'] ?? j['error'] ?? `${path} 失败（${r.status}）`));
  return j;
}

/** 当前等待输入的验证码请求（已被桌面端认领的不会下发） */
export async function verifyCodePending(consumer: VerifyCodeConsumer = 'web'): Promise<VerifyCodeMeta[]> {
  const j = await verifyCodeJson(`/verify-code/pending?consumer=${encodeURIComponent(consumer)}`);
  const list = j['pending'];
  return Array.isArray(list) ? (list as VerifyCodeMeta[]) : [];
}

/**
 * 认领（独占）某个验证码请求。
 * `ok:false` 是**业务结果**（已被另一端认领 / 已结束），不是异常 ⇒ 调用方据此不弹窗。
 */
export async function claimVerifyCode(
  id: string,
  consumer: VerifyCodeConsumer = 'web',
): Promise<{ ok: boolean; claimedBy?: VerifyCodeConsumer; error?: string; message?: string }> {
  const r = await fetch(`${BASE}/verify-code/${encodeURIComponent(id)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consumer }),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: r.ok && j['ok'] === true,
    ...(typeof j['claimedBy'] === 'string' ? { claimedBy: j['claimedBy'] as VerifyCodeConsumer } : {}),
    ...(typeof j['error'] === 'string' ? { error: j['error'] } : {}),
    ...(typeof j['message'] === 'string' ? { message: j['message'] } : {}),
  };
}

/** 验证码画面（服务端截图 data URL；`error:'STARTING'` = 浏览器还在起） */
export async function verifyCodeFrame(
  id: string,
): Promise<{ ok: boolean; frame?: string; error?: string }> {
  const r = await fetch(`${BASE}/verify-code/${encodeURIComponent(id)}/frame`, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: r.ok && j['ok'] === true,
    ...(typeof j['frame'] === 'string' ? { frame: j['frame'] } : {}),
    ...(typeof j['error'] === 'string' ? { error: j['error'] } : {}),
  };
}

/** 当前状态（等待中 / 已提交 / 取消 / 超时 / 失败 + 错误文案） */
export async function verifyCodeState(id: string): Promise<VerifyCodeMeta> {
  return (await verifyCodeJson(`/verify-code/${encodeURIComponent(id)}/state`)) as unknown as VerifyCodeMeta;
}

/** 提交验证码；`ok:false` 是业务结果（空验证码 / 已结束 / 正在提交） */
export async function verifyCodeSubmit(
  id: string,
  code: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const r = await fetch(`${BASE}/verify-code/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: r.ok && j['ok'] === true,
    ...(typeof j['error'] === 'string' ? { error: String(j['error']) } : {}),
    ...(typeof j['message'] === 'string' ? { message: String(j['message']) } : {}),
  };
}

/** 取消（浮层关闭/ESC 必须调这个；否则 worker 会一直等到 60s 超时） */
export async function verifyCodeCancel(id: string): Promise<void> {
  await fetch(`${BASE}/verify-code/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
}

/** 「换一张」：重新加载验证码地址（一次性验证码图） */
export async function verifyCodeRefresh(id: string): Promise<boolean> {
  const j = await verifyCodeJson(`/verify-code/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
  return j['ok'] === true;
}


/**
 * **`#226`：把 `/api/run` 失败的「人话原因」拼进错误文本**（此前整条链路都丢掉了它）。
 *
 * 服务端已经给出了可读原因（`detail.input`，如「TLS 证书链无法验证（站点证书问题）」），
 * 但 `runAction` 只抛 `j.error`（形如 `NETWORK@request`）⇒ 界面上只剩一串标签，
 * 用户分不清是「域名失效」「超时」还是「证书链不完整」—— 而**后者浏览器能开、引擎打不开**，
 * 差别全在 `detail.input` 里。这条对**所有错误类别**生效（不是给某一个源打补丁）。
 */
/** 导出只为可测（纯函数，无副作用）；调用方仍走 `runAction` */
export function describeRunError(j: unknown, status: number): string {
  const obj = (j ?? {}) as Record<string, unknown>;
  const tag = String(obj.error ?? status);
  const detail = (obj.detail ?? {}) as Record<string, unknown>;
  const reason = typeof detail.input === 'string' ? detail.input.trim() : '';
  if (!reason || tag.includes(reason)) return tag;
  // 证书类：补一句用户能懂的解释。★ 不做「忽略证书校验」的开关 —— 那是安全妥协
  // （Legado 上游也没有），站点自己在 nginx 上补中间证书才是正解。
  const hint = /证书|certificate|TLS|SSL/i.test(reason)
    ? '（站点证书链不完整：浏览器会自动补全缺失的中间证书，引擎不做补全 ⇒ 浏览器能开、这里打不开。属站点侧问题）'
    : '';
  return `${tag} · ${reason}${hint}`;
}

/**
 * `#642`（`#11`）：`/api/run` 响应带 `netChallenge` —— **本轮撞了挑战/拦截页且没能过盾**。
 *
 * 为什么必须有这条提示：站点拦截页没有正文选择器 ⇒ 引擎解析出 0 条 ⇒ 旧实现前后端
 * 都一声不响，用户只能得出「这个源废了」。服务端若开得出验证窗，前端会先弹浮层让他过；
 * **开不出窗**（本机没有完整 Chrome / 起浏览器失败）时，至少要说清是「站点要求验证」。
 */
function showNetChallengeNotice(j: unknown): void {
  const c = (j as { netChallenge?: { count?: number; via?: string; urls?: string[] } } | null)?.netChallenge;
  if (!c || !c.count) return;
  const host = (() => {
    const u = (c.urls ?? [])[0];
    if (!u) return '';
    try {
      return new URL(u).host;
    } catch {
      return String(u).slice(0, 40);
    }
  })();
  androidToast(
    `⚠️ 站点要求过验证（${c.via ?? '挑战/拦截页'}${host ? ` · ${host}` : ''}）——` +
      `本次没拿到正文，所以列表是空的。到源管理里对该源点「登录」过一次验证即可。`,
  );
}

/**
 * `#152`：`/api/run` 响应带 `netTruncated`（本次请求期间有**文本**响应被体积护栏截断）时，
 * 用 Android 风格 Toast 如实提示 —— 让「目录少一截 / 正文缺后半段 / 列表空」
 * 与「站点返回空 / 源失效」在用户面前**分得开**（此前只有服务端 console.warn，用户看不到）。
 *
 * 为什么放 API 层：`runAction` 是全应用唯一的行动入口（与 {@link showRunToasts} 同理），
 * 一处覆盖发现/搜索/详情/目录/正文/播放全部入口。
 *
 * 为什么用 Toast 而不是常驻横幅：截断是**低频事件**（>20MB 的响应才会触发），
 * Toast 足以解释「这次为什么怪」；详情/目录的**空态**另有常驻提示（ReaderOverlay 的 tocEmptyHint）。
 */
function showNetTruncatedNotice(j: unknown): void {
  const t = (j as { netTruncated?: { count?: number; urls?: string[] } } | null)?.netTruncated;
  if (!t || !t.count) return;
  const hosts = [...new Set((t.urls ?? []).map((u) => {
    try { return new URL(u).host; } catch { return u; }
  }))];
  androidToast(`⚠️ ${t.count} 个响应被体积护栏截断（${hosts.join('、') || '详见服务端日志'}）——内容可能不完整`);
}

/**
 * 展示 `/api/run` 响应里**源脚本**弹出的 toast（`java.toast` / `java.longToast`）。
 *
 * 为什么放在 API 层、而不是各个页面自己处理：`runAction` 是**全应用唯一的行动入口**
 * （发现页 / 搜索 / 详情 / 目录 / 正文 / 播放都走它）—— 放这里一处即覆盖所有入口，
 * 以后新增页面也自动生效，不必依赖「记得加一行」。
 *
 * 为什么必须做：很多源的反馈**只有 toast**（动作不改任何字段），旧实现服务端静默丢弃
 * ⇒ 用户点按钮「毫无反应」，误以为功能坏了。等价于 Legado App 里的原生 Toast。
 */
function showRunToasts(j: unknown): void {
  const list = (j as { toasts?: unknown } | null)?.toasts;
  if (!Array.isArray(list)) return;
  /**
   * **逐条弹**（源脚本自己弹的每一条都保留 —— 用户 2026-10-15 口径：「按原正常 toast 通路走」）。
   *
   * ⚠️ 曾试过「一批只弹最后一条」（对齐上游 `ToastUtils.toastOnUi` 的 `toast?.cancel()` 语义），
   * 但那样会把**错误信息**吞掉（用户实测点「发布页」时真正要看的是前面那条校验/密钥提示）
   * ⇒ 已回滚，回到逐条展示；`android-toast.ts` 自带的「连续重复去重 + 同屏最多 3 条」足以防刷屏。
   */
  for (const t of list) {
    const s = String(t ?? '').trim();
    if (s) androidToast(s);
  }
}

export async function createSource(
  raw: unknown,
  preferred?: string,
): Promise<{ id: string; kind: string; name?: string }> {
  const url = preferred && preferred !== 'auto'
    ? `${BASE}/sources?preferred=${encodeURIComponent(preferred)}`
    : `${BASE}/sources`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(raw),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

// ---- 在线校验（复刻 Legado 书源校验） ----
/**
 * `#693` 分段结果带上**摘要与耗时**（对齐 Legado 调试信息流：不只一个 ✓，
 * 还要看到这一段拿到了多少东西、花了多久）。
 */
export interface VerifyStage {
  ok: boolean;
  error?: string;
  detail?: string;
  ms?: number;
}
/**
 * `#696` 调试信息流的一行（服务端 `event: log` 帧）。
 * `at` 是**服务端**时间戳（epoch ms）⇒ 前端减首行得到 `[mm:ss.mmm]`，不受网络批处理影响。
 */
export interface VerifyLogLine {
  at: number;
  msg: string;
  level?: 'info' | 'warn' | 'error';
}
export interface VerifyOutcome {
  ok: boolean;
  message: string;
  respondTime: number;
  stages: Partial<Record<string, VerifyStage>>;
}

export type VerifyOpts = {
  keyword?: string;
  markOnError?: boolean;
  checkSearch?: boolean;
  checkDiscovery?: boolean;
  checkDiscoveryDeep?: boolean;
  /** `#694` `name` = 分类显示名（时间轴据此显示「分类「热血」」而不是一长串 URL） */
  explorePick?: { key: string; value: string; name?: string };
};

/**
 * 逐字读取 SSE 帧（`event:` + `data:`），一次 `read` 可能带多帧 / 半帧。
 * `#695` 从 `runDetailStream` 里抽出来复用 —— 两处各写一份迟早只在一处修 bug。
 */
export async function readSse(
  res: Response,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.body) throw new Error(`SSE 响应没有 body（${res.status}）`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let cut = buf.indexOf('\n\n');
    while (cut >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data) as Record<string, unknown>);
      cut = buf.indexOf('\n\n');
    }
    if (done) break;
  }
}

/**
 * `#695` **流式全链试跑**：每落一段立刻回调，跑完返回完整结论。
 *
 * 一次性接口（`verifySource`）在发现链上要等 10~21s，界面期间只有「正在跑…」；
 * 这个接口把 `hub.verifySource` 的 `onStage` 转成 SSE，前端边跑边渲染时间轴。
 */
export async function verifySourceStream(
  id: string,
  opts: VerifyOpts = {},
  onStage?: (stage: string, stageResult: VerifyStage) => void,
  /** `#696` 调试信息流（对齐 Legado `Debug.log`）：服务端逐行推，这里逐行回调 */
  onLog?: (line: VerifyLogLine) => void,
  /**
   * `#697` **中断信号**：换源/关页/再点一次试跑 ⇒ abort。
   * 断开连接会让服务端 `ac.abort()`，把中断一路透传到引擎抓取（不是只停前端渲染）。
   */
  signal?: AbortSignal,
): Promise<VerifyOutcome> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/verify/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) {
    // 路由层面的错误（源不存在等）还是普通 JSON
    let msg = String(r.status);
    try {
      const j = (await r.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* 非 JSON 就报状态码 */
    }
    throw new Error(msg);
  }
  let outcome: VerifyOutcome | null = null;
  await readSse(r, (event, data) => {
    if (event === 'log') {
      const line = data as unknown as VerifyLogLine;
      if (typeof line?.msg === 'string') onLog?.(line);
    } else if (event === 'stage') {
      const stage = String(data['stage'] ?? '');
      if (!stage) return;
      const { stage: _s, ...rest } = data as unknown as { stage?: string } & VerifyStage;
      onStage?.(stage, rest as VerifyStage);
    } else if (event === 'done') {
      outcome = data as unknown as VerifyOutcome;
    } else if (event === 'error') {
      throw new Error(String(data['message'] ?? '流式校验失败'));
    }
  });
  if (!outcome) throw new Error('流式校验结束但没有 done 帧');
  return outcome;
}

/**
 * `#692` 全链试跑（规则工坊右栏）：
 *  · `checkSearch`/`checkDiscovery` 二选一 ⇒ 一次只跑一条链（搜索全链 / 发现全链）；
 *  · `checkDiscoveryDeep` 让发现链继续走 详情→目录→正文；
 *  · `explorePick` 指定发现分类（点哪个胶囊跑哪条）。
 */
export async function verifySource(id: string, opts: VerifyOpts = {}): Promise<VerifyOutcome> {
  const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function verifyBatch(
  opts: { limit?: number; concurrency?: number; keyword?: string; kind?: string; markOnError?: boolean } = {},
): Promise<{ total: number; results: Array<{ id: string; outcome: VerifyOutcome }> }> {
  const r = await fetch(`${BASE}/sources/verify-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  return r.json();
}

/* ---------------------------------------------------------------- `B6` 书源体检 */

export interface HealthCheckOpts {
  ids?: string[];
  limit?: number;
  concurrency?: number;
  keyword?: string;
  kind?: string;
  /** 默认 false：`dead` 且未过 3 天跳过期的源不体检 */
  includeDead?: boolean;
}

export interface HealthCheckItem {
  id: string;
  health: SourceHealth;
}

export interface HealthJob {
  id: string;
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'error';
  total: number;
  done: number;
  elapsedMs: number;
  error?: string;
  /** 中止后仍保留已完成条目 */
  results: HealthCheckItem[];
}

export async function startHealthCheck(opts: HealthCheckOpts = {}): Promise<{ jobId: string; total: number; ids: string[] }> {
  const r = await fetch(`${BASE}/sources/health/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function getHealthJob(jobId: string): Promise<HealthJob> {
  const r = await fetch(`${BASE}/sources/health/jobs/${encodeURIComponent(jobId)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function cancelHealthJob(jobId: string): Promise<HealthJob> {
  const r = await fetch(`${BASE}/sources/health/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j;
}

export async function getSourceHealth(): Promise<Array<SourceHealth & { id: string }>> {
  const r = await fetch(`${BASE}/sources/health`);
  const j = await r.json();
  return (j.results ?? []) as Array<SourceHealth & { id: string }>;
}

// ---- 导入源（格式识别 + 预览 + 提交）：解析在服务端做一份权威实现 ----
export type ImportFormat = 'legado' | 'maccms' | 'rss';
export type ImportFormatHint = 'auto' | ImportFormat;

export interface ImportPreviewItem {
  /**
   * `#351` 在解析结果 `rows` 里的**下标**（0 基）—— 逐行勾选提交时的键。
   * ★ 不能用 `id`：同一份文本里可以有两条同 id 的源（合集文件常见），两行会联动。
   */
  index: number;
  id: string;
  kind: string;
  name: string;
  group?: string;
}
export interface ImportPreview {
  format: ImportFormat;
  /** 解析出的候选项总数 */
  parsedTotal: number;
  /** 可入库的**新源**（库里没有） */
  valid: ImportPreviewItem[];
  /** 库里同 id 但**内容不同** ⇒ 导入会覆盖更新（`#351`），默认勾选 */
  updatable: ImportPreviewItem[];
  /** 库里同 id 且**内容等价** ⇒ 什么都不会变（`#351`），默认不勾选 */
  duplicates: Array<ImportPreviewItem & { existingName?: string }>;
  errors: Array<{ index: number; reason: string }>;
  /** 原文前 140 字符 */
  preview: string;
  bytes: number;
  rowCount: number;
  /** 预览提示（如超大合集只采样编译了前 N 条） */
  note?: string;
}

export interface ImportInput {
  /** 粘贴文本 / 上传文件内容；与 url 二选一（text 优先） */
  text?: string;
  /** 由**服务端**抓取（绕开浏览器 CORS） */
  url?: string;
  format?: ImportFormatHint;
  defaultGroup?: string;
}

/**
 * 网络层失败的统一文案。
 *
 * 为什么需要：浏览器对「服务没响应」只抛一句 `TypeError: Failed to fetch`，
 * 用户看到「预览失败：Failed to fetch」完全无法判断原因（用户真实上报过这一幕：
 * 当时桌面端服务因内存溢出崩了，导入按钮点不动）。这类失败与文件内容无关，
 * 必须说清「是连不上服务」并给出下一步动作。
 */
async function fetchOrExplain(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error('连不上后端服务：服务可能未启动或已崩溃。请确认服务在运行（大文件导入后建议看一眼服务日志）再重试');
  }
}

/** 预览（不写任何状态）：识别格式 / 解析条数 / 新增·重复·错误统计 */
export async function importPreview(body: ImportInput): Promise<ImportPreview> {
  const r = await fetchOrExplain(`${BASE}/sources/import-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j as ImportPreview;
}

export interface ImportResult {
  format: ImportFormat;
  parsedTotal: number;
  parseErrors: Array<{ index: number; reason: string }>;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  results: Array<{ id: string; ok: boolean; name?: string; error?: string; action?: 'inserted' | 'updated' | 'skipped' }>;
}

/** `D5` 导入进度：失败行带**原始行下标**（前端「重试失败行」按它二次提交） */
export interface ImportJobFailedRow {
  index: number;
  id?: string;
  name?: string;
  error: string;
}

/** `D5` `GET /api/sources/import/:jobId` 响应 */
export interface ImportJobProgress {
  id: string;
  state: 'running' | 'done' | 'error';
  stage: 'import' | 'persist' | 'done';
  done: number;
  total: number;
  failed: ImportJobFailedRow[];
  elapsedMs?: number;
  result?: ImportResult;
  error?: string;
}

export async function getImportJob(jobId: string): Promise<ImportJobProgress> {
  const r = await fetchOrExplain(`${BASE}/sources/import/${encodeURIComponent(jobId)}`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j as ImportJobProgress;
}

/**
 * `D5` 提交导入：走**异步 job**（立即拿 jobId，轮询进度），提交后消费进度。
 *
 * ★ 兼容旧服务端：响应里没有 `jobId`（老 bundle 还没重打）就按原来的同步结果直接返回，
 * 不会因为协议升级把「导入」变成不可用。
 */
export async function importCommit(
  body: ImportInput & { dedupe?: 'skip' | 'overwrite'; selectedRows?: number[] },
  onProgress?: (p: ImportJobProgress) => void,
): Promise<ImportResult> {
  const r = await fetchOrExplain(`${BASE}/sources/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, async: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  if (typeof j?.jobId !== 'string') return j as ImportResult; // 旧服务端：同步协议
  let p: ImportJobProgress;
  for (;;) {
    p = await getImportJob(j.jobId as string);
    onProgress?.(p);
    if (p.state === 'error') throw new Error(p.error ?? '导入失败');
    if (p.state === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!p.result) throw new Error('导入任务已结束但没有结果（请查看服务端日志）');
  return p.result;
}

// ---- `B21` 源订阅：远程源列表地址簿（更新永远走导入源的强制预览） ----
export type SourceSubFormat = 'auto' | ImportFormat;

export interface SourceSubscription {
  id: string;
  name: string;
  url: string;
  format: SourceSubFormat;
  createdAt: number;
  /** 最近一次确认预览/导入的时间；0 = 从未 */
  updatedAt: number;
}

export async function getSourceSubscriptions(): Promise<SourceSubscription[]> {
  const r = await fetchOrExplain(`${BASE}/source-subscriptions`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return (j.items ?? []) as SourceSubscription[];
}

export async function putSourceSubscriptions(items: SourceSubscription[]): Promise<SourceSubscription[]> {
  const r = await fetchOrExplain(`${BASE}/source-subscriptions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return (j.items ?? []) as SourceSubscription[];
}

/** `#266` 净化规则导入预览（服务端只负责「text 直传 / URL 抓取」+ 调 core 的解析纯函数） */
export interface ReplaceRuleImportPreview {
  parsedTotal: number;
  rules: Array<Record<string, unknown>>;
  errors: Array<{ index: number; reason: string }>;
  preview: string;
  bytes: number;
}

export async function replaceRuleImportPreview(body: { text?: string; url?: string }): Promise<ReplaceRuleImportPreview> {
  const r = await fetchOrExplain(`${BASE}/user/replace-rules/import-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.error ?? r.status));
  return j as ReplaceRuleImportPreview;
}

/* ═══════════════ `#208` ⑤ UI 集成：源分享口令 + WebDAV 同步 ═══════════════
 *
 * 这里**只放薄封装**：所有形状都是照服务端实际响应写的（不是照想象写的）。
 * 三处「失败也回 200」的端点（直链测试 / WebDAV 测试 / 分享结果分类）在下面
 * 都有各自的 `ok:false` 判别联合 —— 别把它们改成 throw，否则「密码不对」
 * 与「服务没启动」在界面上会变成同一句红字。
 */

/** 直链上传规则（上游 `Rule` 的字段名一字不差，供与手机端粘贴互通） */
export type { DirectLinkUploadRule };

/** 一次直链上传的实况（`DirectLinkUploadResult`；排障时 `responseBody` 是唯一线索） */
export interface DirectLinkUploadResult {
  downloadUrl: string;
  requestUrl: string;
  /** 上传响应体原文 —— 网盘拒绝的原因就在里面 */
  responseBody: string;
  fileName: string;
  contentType: string;
  byteLength: number;
  compressed: boolean;
}

/** `GET /api/share/direct-link` */
export interface DirectLinkState {
  /** 当前生效规则（自定义优先，否则内置第 1 条） */
  rule: DirectLinkUploadRule;
  /** false = 正在用内置默认 */
  custom: boolean;
  /** 内置 3 条（界面「导入默认」用） */
  defaults: DirectLinkUploadRule[];
}

export async function getDirectLinkState(): Promise<DirectLinkState> {
  const r = await fetchOrExplain(`${BASE}/share/direct-link`, { method: 'GET' });
  return (await r.json()) as DirectLinkState;
}

/**
 * 保存自定义规则。两种入口：
 *  · `{ paste }` —— 界面「粘贴规则」：容忍 `//` 注释与尾逗号（服务端 `parseJsonLoose`）；
 *  · `{ rule }` —— 直接给一整个规则对象（如从内置 3 条里选一条改）。
 * ⚠️ 粘贴内容里**多条规则会被拒**（要用户只留一条）—— 错误信息由服务端给。
 */
export async function putDirectLinkRule(body: { paste: string } | { rule: DirectLinkState['rule'] }): Promise<DirectLinkState> {
  const r = await fetchOrExplain(`${BASE}/share/direct-link`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as DirectLinkState;
}

/** 删除自定义规则 ⇒ 回落内置第 1 条 */
export async function resetDirectLinkRule(): Promise<DirectLinkState> {
  const r = await fetchOrExplain(`${BASE}/share/direct-link`, { method: 'DELETE' });
  return (await r.json()) as DirectLinkState;
}

/**
 * 「测试」上传（用 `test.json` + `{}` 真发一次）。
 * ★ 失败**也回 200**：`{ ok:false, error }` —— 语义是「报告结果」而不是「提交失败」。
 */
export type DirectLinkTestOutcome =
  | { ok: true; result: DirectLinkUploadResult }
  | { ok: false; error: string };

export async function testDirectLink(rule?: DirectLinkState['rule']): Promise<DirectLinkTestOutcome> {
  const r = await fetchOrExplain(`${BASE}/share/direct-link/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rule ? { rule } : {}),
  });
  const j = await r.json();
  if (!r.ok) return { ok: false, error: String(j.message ?? j.error ?? r.status) };
  return j as DirectLinkTestOutcome;
}

/** 分享成功的产物 */
export interface SharePassphraseResult {
  /** 网盘返回的下载地址 */
  downloadUrl: string;
  /** 可直接复制给别人的口令 */
  passphrase: string;
  /** 口令里的过期毫秒时间戳；0 = 永久 */
  expiresAt: number;
  upload: DirectLinkUploadResult;
  /** 生效规则摘要（界面提示「用了哪个网盘」） */
  summary: string;
}

/**
 * 分享失败的**分类**（界面据此给不同文案，别塌成一句「分享失败」）：
 *  · `notfound`     源不存在（404）
 *  · `empty`        源内容为空（400）
 *  · `unshareable`  网盘地址编不成口令（409）—— ★ **仍带 downloadUrl**，白上传了也要把链接交给用户
 *  · `upload`       上传本身失败（502），`detail` 里有网盘原话
 *  · `network`      连不上本机服务
 */
export type SharePassphraseOutcome =
  | { ok: true; value: SharePassphraseResult }
  | { ok: false; kind: 'notfound' | 'empty' | 'unshareable' | 'upload' | 'network'; message: string; downloadUrl?: string };

export async function shareSourcePassphrase(id: string): Promise<SharePassphraseOutcome> {
  try {
    const r = await fetch(`${BASE}/sources/${encodeURIComponent(id)}/share-passphrase`, { method: 'POST' });
    const j = (await r.json()) as Record<string, unknown>;
    if (r.ok) return { ok: true, value: j as unknown as SharePassphraseResult };
    const kind = String(j['kind'] ?? '');
    const mapped = kind === 'unshareable' ? 'unshareable' : kind === 'empty' ? 'empty' : kind === 'upload' ? 'upload' : 'notfound';
    return {
      ok: false,
      kind: mapped,
      message: String(j['detail'] ?? j['message'] ?? j['error'] ?? r.status),
      ...(typeof j['downloadUrl'] === 'string' ? { downloadUrl: j['downloadUrl'] } : {}),
    };
  } catch {
    return { ok: false, kind: 'network', message: '连不上后端服务：服务可能未启动或已崩溃' };
  }
}

/* ---------------- WebDAV ---------------- */

/** 对外配置：**密码恒为空串**，只有 `hasPassword`（服务端 `publicWebDavConfig` 抹的） */
export interface WebDavPublicConfig {
  url: string;
  username: string;
  /** 恒为空串 —— 回显不了；想改密码必须真的填一个新值 */
  password: string;
  /** 子目录；空 = 落在根 */
  dir: string;
  authEncoding: 'utf-8' | 'iso-8859-1';
  hasPassword: boolean;
}

export interface WebDavState {
  /** 账号密码齐全才算「已配置」 */
  configured: boolean;
  config: WebDavPublicConfig;
  syncProgress: boolean;
  /** `B7` ④ 云端备份保留份数（1~10，默认 1） */
  backupKeep: number;
}

/* `#386` 引擎系统代理（设置页「服务与网络」） */
export interface NetworkProxyState {
  enabled: boolean;
  url: string;
}

export async function getNetworkProxy(): Promise<NetworkProxyState> {
  const r = await fetchOrExplain(`${BASE}/network-proxy`, { method: 'GET' });
  return (await r.json()) as NetworkProxyState;
}

/** 保存并即时生效；服务端对非法 URL 回 400（`detail` 是人话）。 */
export async function putNetworkProxy(body: NetworkProxyState): Promise<NetworkProxyState> {
  const r = await fetchOrExplain(`${BASE}/network-proxy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as NetworkProxyState;
}

export async function getWebDav(): Promise<WebDavState> {
  const r = await fetchOrExplain(`${BASE}/webdav`, { method: 'GET' });
  return (await r.json()) as WebDavState;
}

/**
 * 保存配置。
 * ★ 服务端的空密码保护：`password` 为空且**已有配置** ⇒ 沿用旧密码。
 *   所以界面回显密码为空时直接原样 PUT 也不会把密码冲掉（用户只改开关是安全的）。
 */
export async function putWebDav(
  body: { config?: Partial<WebDavPublicConfig>; syncProgress?: boolean; backupKeep?: number },
): Promise<WebDavState> {
  const r = await fetchOrExplain(`${BASE}/webdav`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as WebDavState;
}

export async function deleteWebDav(): Promise<WebDavState> {
  const r = await fetchOrExplain(`${BASE}/webdav`, { method: 'DELETE' });
  return (await r.json()) as WebDavState;
}

/** 测试连接：★ 失败**也回 200**（`{ok:false,kind,detail}`）——「密码不对」与「连不上」要分得开 */
export type WebDavCheckOutcome =
  | { ok: true }
  | { ok: false; kind: 'unauthorized' | 'unreachable' | 'not-webdav' | 'unconfigured'; detail: string };

export async function testWebDav(config?: Partial<WebDavPublicConfig>): Promise<WebDavCheckOutcome> {
  const r = await fetchOrExplain(`${BASE}/webdav/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config ? { config } : {}),
  });
  const j = await r.json();
  /**
   * ★ 4xx **不是**「连不上」而是「这份配置本身不成立」（字段缺失/格式不对）——
   * 归到 `unconfigured` 才能让界面说「账号密码还没填齐」，
   * 而不是冤枉 DNS/端口/证书（`#298` 实测踩过：密码被抹空时报的是「连不上这个地址」）。
   */
  if (!r.ok) return { ok: false, kind: 'unconfigured', detail: String(j.message ?? j.error ?? r.status) };
  return j as WebDavCheckOutcome;
}

/** 一次进度同步的报告（界面直接显示这些数字） */
export interface WebDavSyncReport {
  books: number;
  remoteFiles: number;
  downloaded: number;
  /** 采用了远端（本地被往前推）的书 url */
  adopted: string[];
  uploaded: string[];
  skipped: number;
  /** 逐条错误（**不中断**整个同步） */
  errors: Array<{ bookUrl: string; name: string; error: string }>;
}

/** 同步一次；`pullOnly` ⇒ 只拉不传（`?pull=1`） */
export async function syncWebDav(opts: { pullOnly?: boolean } = {}): Promise<WebDavSyncReport> {
  const r = await fetchOrExplain(`${BASE}/webdav/sync${opts.pullOnly ? '?pull=1' : ''}`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as WebDavSyncReport;
}

export interface WebDavBackupItem {
  name: string;
  size: number;
  lastModify: number;
}

/** 列远端备份（**最新的在前**，界面直接照这个顺序显示，别自己再排） */
export async function listWebDavBackups(): Promise<WebDavBackupItem[]> {
  const r = await fetchOrExplain(`${BASE}/webdav/backups`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return (j.backups ?? []) as WebDavBackupItem[];
}

export interface WebDavBackupResult {
  fileName: string;
  bytes: number;
  books: number;
  /** `#621`：这份备份实际带了哪些内容 */
  included?: string[];
  /** `#621`：zip 里的条目（`encrypted=true` 的是 AES 密文） */
  entries?: Array<{ name: string; bytes: number; encrypted: boolean }>;
  /** `#621`：勾了但本机没数据的敏感项（要显示给用户，别让他以为登录态存进去了） */
  skippedSensitive?: Array<{ id: string; why: string }>;
  /** `B7` ④ 轮转结果：保留/删除了哪些备份 */
  rotation?: { keep: number; kept: string[]; deleted: string[] };
  /** `B7` ④ 轮转失败（备份本身已成功） */
  rotationError?: string;
}

/**
 * 备份当前整库到云端（文件名按上游格式 `backup<yyyy-MM-dd>.zip` ⇒ **同一天会覆盖**）。
 *
 * `#621`：`options` 不传 ⇒ 服务端用默认勾选；`password` 只有在勾了
 * 「持久 Cookie」/「源变量」时才必需（服务端会以 400 拒绝并说明原因）。
 */
export async function webDavBackup(
  opts: { includeChapters?: boolean; options?: string[]; password?: string } = {},
): Promise<WebDavBackupResult> {
  const qs = opts.includeChapters && !opts.options ? '?chapters=1' : '';
  const body: Record<string, unknown> = {};
  if (opts.options) body.options = opts.options;
  if (opts.password) body.password = opts.password;
  const r = await fetchOrExplain(`${BASE}/webdav/backup${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as WebDavBackupResult;
}

/** `#621` 一个可勾选的备份内容 */
export interface BackupOptionMeta {
  id: string;
  label: string;
  desc: string;
  defaultOn: boolean;
  /** 敏感项：必须给口令，且进 zip 时是 AES 密文 */
  sensitive?: boolean;
}

export interface BackupOptionsPayload {
  options: BackupOptionMeta[];
  defaultOn: string[];
  /** 上游有、本仓没有对应物的项（界面可以拿它解释「为什么没有勾选框」） */
  unsupported: Array<{ upstreamKey: string; label: string; why: string }>;
}

/**
 * 取可勾选的备份内容清单。
 *
 * ★ 界面**不硬编码**这份清单：写死就是第二份真相源，加一项忘一处就少备份一类数据。
 * 读不到时调用方按「服务端默认」备份（不猜内容）。
 */
export async function getBackupOptions(): Promise<BackupOptionsPayload> {
  const r = await fetchOrExplain(`${BASE}/backup/options`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as BackupOptionsPayload;
}

/* ------------------------------------------------------------------ *
 * 设置 → 数据备份：Legado 兼容 / 本仓完整（文件模式）
 * ------------------------------------------------------------------ */

export interface BackupModeOption {
  id: string;
  label: string;
  desc: string;
  defaultOn: boolean;
  /** 依赖项：勾了本项必须同时勾这些 */
  requires?: string[];
  /** 敏感项（Cookie / 源变量）：必须给口令 */
  sensitive?: boolean;
}

export interface BackupModesPayload {
  legado: { options: BackupModeOption[]; defaultOn: string[] };
  full: { options: BackupModeOption[]; defaultOn: string[] };
}

/** 两种备份模式的勾选项（服务端下发，界面不写死） */
export async function getBackupModes(): Promise<BackupModesPayload> {
  const r = await fetchOrExplain(`${BASE}/backup/modes`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as BackupModesPayload;
}

export type BackupFormat = 'legado' | 'full';

/** 预检结果（不写库）：Legado 与完整备份的字段并集，界面按 `format` 取用 */
export interface BackupInspectResult {
  token: string;
  format: BackupFormat;
  mode: BackupFormat;
  /** 本次将会生效的勾选项 */
  options?: string[];
  /** 完整备份：包内实际可恢复的项 */
  available?: string[];
  entries?: Array<{ name: string; bytes: number; recognized?: boolean }>;
  unknownEntries?: string[];
  parseErrors?: Array<{ entry: string; error: string }>;
  skipped?: Array<{ entry: string; why: string; count: number }>;
  warnings?: string[];
  books?: Record<string, unknown>;
  annotations?: Record<string, number>;
  rules?: Record<string, number>;
  history?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  stats?: Record<string, number>;
  included?: string[];
  legacy?: boolean;
  [k: string]: unknown;
}

/** 上传备份 zip 做预检（只解析不写库） */
export async function inspectBackupZip(
  file: Blob,
  password?: string,
  options?: string[],
): Promise<BackupInspectResult> {
  const qs = options?.length ? `?options=${encodeURIComponent(options.join(','))}` : '';
  const r = await fetchOrExplain(`${BASE}/backup/inspect${qs}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(password ? { 'x-backup-password': password } : {}),
    },
    body: file,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.detail ?? j.message ?? j.error ?? r.status));
  return j as BackupInspectResult;
}

/** 确认恢复（写库）。token 来自预检；密码只在预检时没带时才需要 */
export async function applyBackup(
  token: string,
  options?: string[],
  password?: string,
): Promise<Record<string, unknown>> {
  const r = await fetchOrExplain(`${BASE}/backup/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, ...(options ? { options } : {}), ...(password ? { password } : {}) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.detail ?? j.message ?? j.error ?? r.status));
  return j as Record<string, unknown>;
}

export interface BackupExportResult {
  blob: Blob;
  fileName: string;
  stats: Record<string, unknown>;
  warnings: string[];
}

/** 导出备份 zip（`mode: 'legado' | 'full'`） */
export async function exportBackupZip(
  mode: BackupFormat,
  options: string[],
  password?: string,
): Promise<BackupExportResult> {
  const r = await fetchOrExplain(`${BASE}/backup/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, options, ...(password ? { password } : {}) }),
  });
  if (!r.ok) {
    let detail = String(r.status);
    try {
      const j = await r.json();
      detail = String(j.detail ?? j.message ?? j.error ?? detail);
    } catch { /* 非 JSON */ }
    throw new Error(detail);
  }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const fileName = m?.[1] ? decodeURIComponent(m[1]) : `yuedu-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  let stats: Record<string, unknown> = {};
  let warnings: string[] = [];
  const raw = r.headers.get('x-backup-stats');
  if (raw) {
    try {
      const j = JSON.parse(decodeURIComponent(raw)) as { stats?: Record<string, unknown>; warnings?: string[] };
      stats = j.stats ?? {};
      warnings = j.warnings ?? [];
    } catch { /* 忽略坏头 */ }
  }
  return { blob, fileName, stats, warnings };
}

/** 从远端备份恢复（**破坏性**：走非累加管线，会覆盖现有数据） */
export interface WebDavRestoreResult {
  fileName: string;
  /** 快照导入的逐实体计数（books/chapters/… 各含 added/updated/kept/skipped） */
  counts: SnapshotImportResult;
  /** `#621`：这份备份声明带了哪些内容（未声明的字段本次**未改动**） */
  included?: string[];
  /** `#621`：旧格式备份（没有 `included`） */
  legacy?: boolean;
  cookiesRestored?: number;
  sourceVariablesRestored?: number;
  /** `#621`：恢复过程中的非致命提示 */
  warnings?: string[];
}

/**
 * `B7` ③ `mode`：
 *  - `overwrite`（默认，还原如初）：同主键用备份内容替换，备份里没有的本机记录保留；
 *  - `merge`：只补备份里缺失的部分，现有同主键记录一律不覆盖（跨设备合并用）。
 */
export async function webDavRestore(
  name: string, password?: string, mode: 'overwrite' | 'merge' = 'overwrite',
): Promise<WebDavRestoreResult> {
  const r = await fetchOrExplain(`${BASE}/webdav/restore?confirm=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...(password ? { password } : {}), mode }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return j as WebDavRestoreResult;
}

/* ------------------------------------------------------------------ *
 * 书内备注 + 搜索历史（服务端，跨端可用）
 * ------------------------------------------------------------------ */

export interface BookMemo {
  time: number;
  bookUrl: string;
  bookName: string;
  bookAuthor: string;
  chapterIndex: number;
  chapterPos: number;
  chapterName: string;
  bookText: string;
  title: string;
  content: string;
}

export async function getBookMemos(bookUrl?: string): Promise<BookMemo[]> {
  const qs = bookUrl ? `?bookUrl=${encodeURIComponent(bookUrl)}` : '';
  const r = await fetchOrExplain(`${BASE}/user/book-memos${qs}`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return (j.memos ?? []) as BookMemo[];
}

export async function saveBookMemo(memo: BookMemo): Promise<void> {
  const r = await fetchOrExplain(`${BASE}/user/book-memos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(memo),
  });
  if (!r.ok) {
    let detail = String(r.status);
    try {
      const j = await r.json();
      detail = String(j.detail ?? j.message ?? j.error ?? detail);
    } catch { /* ignore */ }
    throw new Error(detail);
  }
}

export async function deleteBookMemo(time: number): Promise<boolean> {
  const r = await fetchOrExplain(`${BASE}/user/book-memos?time=${encodeURIComponent(String(time))}`, { method: 'DELETE' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return !!j.ok;
}

export interface SearchHistoryEntry {
  word: string;
  lastUseTime: number;
  usage: number;
}

export async function getSearchHistory(limit = 20): Promise<SearchHistoryEntry[]> {
  const r = await fetchOrExplain(`${BASE}/user/search-history?limit=${limit}`, { method: 'GET' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return (j.history ?? []) as SearchHistoryEntry[];
}

/** 记录一次搜索（服务端累加 usage / 刷新 lastUseTime） */
export async function recordSearchHistory(word: string): Promise<SearchHistoryEntry | null> {
  const r = await fetchOrExplain(`${BASE}/user/search-history`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return (j.entry ?? null) as SearchHistoryEntry | null;
}

export async function deleteSearchHistory(word: string): Promise<boolean> {
  const r = await fetchOrExplain(`${BASE}/user/search-history?word=${encodeURIComponent(word)}`, { method: 'DELETE' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return !!j.ok;
}

export async function clearSearchHistory(): Promise<number> {
  const r = await fetchOrExplain(`${BASE}/user/search-history?all=1`, { method: 'DELETE' });
  const j = await r.json();
  if (!r.ok) throw new Error(String(j.message ?? j.error ?? r.status));
  return Number(j.cleared ?? 0);
}
