/**
 * MacCMS 影视源数据模型（T1 JSON 协议）
 *
 * 参考基准：/f/zyfun/src/main/services/FastifyService/routes/v1/film/cms/adapter/t1Json.ts
 * 协议文档：docs/01-开发计划.md §6
 *
 * 一份 MacCMS（苹果CMS）源配置的最小形态（zyfun 导出的真实字段）：
 *   { "name": "测试", "api": "https://x.com/api.php/provide/vod/", "playUrl": "...", "encode": "utf8" }
 * 我们统一归一为 apiUrl（兼容 api 别名）。
 */

/** T1 JSON 分类项 */
export interface CmsClass {
  type_id: string | number;
  type_name: string;
  /** 父分类 id（部分站点返回层级分类，type_pid=0 为一级）；前端可据此建树 */
  type_pid?: number | string;
}

/** T1 JSON 视频条目（list / detail 共用） */
export interface CmsVod {
  vod_id: string | number;
  vod_name?: string;
  vod_pic?: string;
  vod_remarks?: string;
  vod_year?: string | number;
  vod_area?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_content?: string;
  vod_blurb?: string;
  type_name?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  /** 部分源把播放串放在 vod_url（vod_play_url 为空时兜底） */
  vod_url?: string;
  [k: string]: unknown;
}

/** T1 JSON 响应（ac=class / ac=videolist / ac=detail 共享结构） */
export interface CmsResponse {
  code?: number | string;
  msg?: string;
  page?: number | string;
  pagecount?: number | string;
  limit?: number | string;
  total?: number | string;
  class?: CmsClass[];
  list?: CmsVod[];
  [k: string]: unknown;
}

/**
 * `#653` **CMS 参数块**（对齐全仓参考实现 OmniFlow `packages/shared/src/types/cms.ts` 的 `CmsEndpoint`）。
 *
 * 为什么把参数收进一个 `cms` 块而不是继续平铺：
 *  · 平铺时「哪些键是 CMS 参数、哪些是源元数据」只能靠命名猜（`acList` 是 ac 值还是参数名？）；
 *  · OmniFlow / zyfun 导出的 JSON 都是嵌套形态，用户从那边搬源过来时能**原样贴合**；
 *  · 工坊的「CMS 参数」tab 可以整块读写，不用在十几个平铺键里翻。
 *
 * 兼容规则（`pick()`）：**`cms` 块优先，平铺字段兜底** —— 老源（只有 `acList` 等平铺键）
 * 行为完全不变，新源/导出源走 `cms` 块。
 */
export interface CmsParamsBlock {
  /** 0=XML-CMS 1=JSON-CMS（OmniFlow 的 cmsType；本仓按 `format` 推断，此字段仅记录） */
  cmsType?: 0 | 1;
  /** 接口根（等价 apiUrl） */
  base?: string;
  /** ac 参数名，默认 'ac'（部分变体用 'action'） */
  acParam?: string;
  /** 关键词参数名，默认 'wd' */
  wdParam?: string;
  /** 页码参数名，默认 'pg' */
  pgParam?: string;
  /** 每页条数参数名，默认 'limit' */
  limitParam?: string;
  /** 分类参数名，默认 't' */
  typeParam?: string;
  /** 详情 id 参数名，默认 'ids' */
  idsParam?: string;
  /** 固定附加参数（h=1 / with_play=1 …） */
  extraParams?: Record<string, string | number | boolean>;
  /** 品牌：maccms / 10cms / feifeicms / unknown（纯元数据） */
  brand?: string;
  /** 内容页是否支持 ext 字段（纯元数据，本仓暂不消费） */
  hasExt?: boolean;
  /** 选集分隔方案：dollar-hash（默认）/ crlf / colon */
  playUrlSplit?: 'dollar-hash' | 'crlf' | 'colon';
  /** `vod_play_from` 多线路分隔符，默认 '$$$' */
  playFromSplit?: string;
  /**
   * 四接口 ac **值**（不是参数名；填 `videolist` / `detail` / `list` 这类）。
   * 留空 = 自动 fallback（并自学习记住成功值）：
   *   search  → detail → videolist → list
   *   cat     → list → class
   *   content → detail → videolist
   *   detail  → detail → videolist
   */
  searchAc?: string;
  catAc?: string;
  contentAc?: string;
  detailAc?: string;
  /** 搜索/分类列表的 ac 值（OmniFlow 的 listAc；也是老 `acList` 的别名） */
  listAc?: string;
  /** 详情 ac 的历史别名（`detailAc` 优先） */
  playAc?: string;
  /** 备用域名（`https://origin` 整段），主域网络失败时按序重试 */
  siteDomains?: string[];
  /**
   * `#654` **屏蔽分类**（分类 `type_id` 或 `type_name`，逗号/换行分隔或数组）。
   * 与下面的 `blackId`（屏蔽具体 `vod_id`）是**两件事**，故意不合成一个列表：
   * 分类 id 与 vod_id 都是小整数，混在一张表里会出现「屏蔽分类 1 ⇒ 顺手屏蔽了 vod_id=1 的片子」。
   */
  blacklist?: string[] | string;
  /** 屏蔽的 `vod_id`（逗号分隔或数组） */
  blackId?: string[] | string;
}

/** 编译后的 MacCMS（苹果CMS）源（一期仅做规范化 + 校验） */
export interface CmsSource {
  name?: string;
  /** 站点 API 根，如 https://x.com/api.php/provide/vod/ */
  apiUrl: string;
  /** 接口类型：json（默认）/ xml（at/xml）。缺省时按 apiUrl 自动推断 */
  format?: 'json' | 'xml';
  /** 播放地址再解析模板（§6.5），可选 */
  playUrl?: string;
  /** 关键词编码，预留 */
  encode?: string;

  /** ---- 兼容性覆盖：各站点参数名/取值不一，用户可在 Web 导入/编辑时自主修改 ---- */
  /** ac 参数名，默认 'ac' */
  acParam?: string;
  /** 关键词参数名，默认 'wd' */
  wdParam?: string;
  /** 页码参数名，默认 'pg' */
  pgParam?: string;
  /** 分类参数名，默认 't' */
  typeParam?: string;
  /** 详情 ids 参数名，默认 'ids' */
  idsParam?: string;
  /** `#653` 每页条数参数名，默认 'limit'（不配 `pageSize` 时不发该参数，行为与旧版一致） */
  limitParam?: string;
  /** `#653` 每页条数；配置了才发 `limit`，避免给不接受 limit 的站点添乱 */
  pageSize?: number;
  /** 列表/搜索的 ac 值，默认 'videolist'（部分站用 'list'） */
  acList?: string;
  /** 详情的 ac 值，默认 'detail' */
  acDetail?: string;
  /** 分类树的 ac 值，默认 'class' */
  acClass?: string;
  /** `#653` 四接口 ac（新命名，OmniFlow 口径；留空=自动 fallback + 自学习） */
  searchAc?: string;
  catAc?: string;
  contentAc?: string;
  detailAc?: string;
  /** `#653` 多线路分隔符，默认 '$$$' */
  playFromSplit?: string;
  /** `#653` 品牌/元数据 */
  brand?: string;
  hasExt?: boolean;
  /** `#653` 备用域名（主域网络失败时按序替换 origin 重试；数组或换行/逗号分隔串） */
  siteDomains?: string[] | string;
  /** `#653` 屏蔽的 vod_id（数组或逗号分隔串 —— 用户手填 JSON 常写成串） */
  blackId?: string[] | string;
  /** 原始 `cms` 参数块（编译时保留，方便工具回写/UI 展示） */
  cms?: CmsParamsBlock;
  /** 选集分隔方案，默认 'dollar-hash'（可改 crlf/colon） */
  playSplit?: 'dollar-hash' | 'crlf' | 'colon';
  /**
   * `#654` **请求头**（源级，所有接口请求都带）。
   *
   * 为什么必须有：不少 CMS 站点校验 `Referer` / 自定义 `X-Token` / 非默认 `User-Agent`，
   * 不带就回 HTML 验证页 ⇒ 表现为 `ANTI_BOT`，用户完全看不出是「少了请求头」。
   * `#653` 之前工坊「进阶」tab 里有 `header` 输入框，但引擎**从未读过它**（死字段），
   * 现已接通：`fetchJson` 把它并进每次请求（`User-Agent` 可被覆盖）。
   */
  header?: Record<string, string>;
  /**
   * `#479` **分类黑名单**（对齐 zyfun：`source.categories` 按名排除站点分类）。
   * 数组或逗号分隔字符串均可；条目命中 **type_id 或 type_name** 即从发现分类（filters）与
   * 分类卡片列表里屏蔽。兼容 zyfun 的 `categories` 字段名。
   */
  blacklist?: string[] | string;
  /** 额外透传参数（如 h=24、with_play=1） */
  extraParams?: Record<string, string>;
  /** 启用状态（启用/禁用、搜索、发现）—— 见 @yuedu/core SourceState */
  state?: import('@yuedu/core').SourceState;
  // 其余字段容错
  [k: string]: unknown;
}

export interface CompileIssue {
  level: 'error' | 'warn' | 'info';
  path?: string;
  message: string;
}

export interface CompileOutcome {
  ok: boolean;
  rule?: CmsSource;
  issues: CompileIssue[];
}

/** 判定一份配置是不是 MacCMS（苹果CMS）源（与 Legado / ZYFun 区分） */
export function detectCmsSource(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  // 排除 Legado
  if (typeof r['bookSourceUrl'] === 'string') return false;
  // 排除 ZYFun（rule 为 JS 脚本字符串）
  if (typeof r['rule'] === 'string') return false;
  /**
   * `#653` apiUrl 兼容三处：`apiUrl`（本仓）/ `api`（zyfun）/ `cms.base`（OmniFlow 导出形态）。
   * 少了 `cms.base` 的话，用户从 OmniFlow 搬过来的完整 JSON 会**根本不被认成 CMS 源**。
   */
  const cms = r['cms'];
  const api = r['apiUrl'] ?? r['api'] ?? (cms && typeof cms === 'object' ? (cms as Record<string, unknown>)['base'] : undefined);
  return typeof api === 'string' && api.trim().length > 0;
}

/**
 * `#654` **请求头归一**：用户可能在三个地方用三种写法填同一件事，全都认。
 *
 *  ① JSON 对象 `{ "Referer": "https://a/" }` —— 原生形态（手改 JSON 源码时）
 *  ② JSON 字符串 `'{"Referer":"https://a/"}'` —— 工坊表单只能出字符串
 *  ③ 逐行 `Key: Value`（也认 `Key=Value`）—— 用户从 DevTools「Copy as cURL / 请求头」直接粘
 *
 * 解析失败一律返回 `undefined`（当没填），**不抛错**：请求头是增强项，
 * 用户手滑写错一行不该让整个源连「保存」都过不去（`validate` 会另给告警）。
 */
export function parseHeader(v: unknown): Record<string, string> | undefined {
  const push = (out: Record<string, string>, k: string, val: string): void => {
    const key = k.trim();
    if (!key) return;
    out[key] = val.trim();
  };

  // ① 已是对象：只收标量值（数组/对象在这里没有语义）
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') push(out, k, String(val));
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v !== 'string' || !v.trim()) return undefined;

  const text = v.trim();
  // ② JSON 字符串（以 { 开头才试，避免把 `a: b` 拉去 JSON.parse 白跑一趟）
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) return parseHeader(j);
    } catch {
      /* 落到 ③ 逐行解析 */
    }
  }
  // ③ 逐行 `Key: Value`
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    const m = /^([^:=]+)[:=](.*)$/.exec(t);
    if (!m) continue;
    push(out, m[1] as string, m[2] as string);
  }
  return Object.keys(out).length ? out : undefined;
}

/** 预编译：归一化 api 别名 + 静态校验 */
export function compileCmsSource(raw: unknown): CompileOutcome {
  const issues: CompileIssue[] = [];
  if (!detectCmsSource(raw)) {
    return { ok: false, issues: [{ level: 'error', message: '不是 MacCMS（苹果CMS）源（缺少 apiUrl / api）' }] };
  }
  const src = raw as Record<string, unknown>;
  /**
   * `#653` **参数块优先**：OmniFlow / 新导出的源把参数放在 `cms` 里；
   * 老源（本仓既有 52 个）是平铺的 ⇒ 统一走 `pick()`，先 `cms.k` 再平铺 `k`。
   */
  const cmsRaw: Record<string, unknown> =
    src['cms'] && typeof src['cms'] === 'object' ? (src['cms'] as Record<string, unknown>) : {};
  const pick = (k: string): unknown => (cmsRaw[k] !== undefined ? cmsRaw[k] : src[k]);
  const pickStr = (k: string): string | undefined => {
    const v = pick(k);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const pickList = (k: string): string[] | undefined => {
    const v = pick(k);
    if (Array.isArray(v)) {
      const out = v.map((x) => String(x).trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
    if (typeof v === 'string' && v.trim()) {
      const out = v.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
    return undefined;
  };

  /** apiUrl 兼容三处：`apiUrl` / `api`（zyfun） / `cms.base`（OmniFlow） */
  const apiRaw = String(src['apiUrl'] ?? src['api'] ?? cmsRaw['base'] ?? '').trim();
  if (!apiRaw) {
    issues.push({ level: 'error', path: 'apiUrl', message: 'apiUrl 为空' });
  }
  // 归一 api：
  //  1) 补全协议（默认 https）—— 对齐 Legado 源 cleanApi 处理
  //  2) 去掉尾部 ? 与空白
  //  3) 去掉尾部多余斜杠（避免与 ? 拼接出 //，或路径重复）
  let apiUrl = apiRaw;
  if (!/^https?:\/\//i.test(apiUrl)) apiUrl = 'https://' + apiUrl;
  apiUrl = apiUrl.replace(/[?\s]+$/, '').replace(/\/+$/, '');
  // 接口类型：显式 format 优先；否则从 apiUrl 推断（at/xml、ac=xml、.xml → xml）
  const formatRaw = src['format'] === 'xml' || src['format'] === 'json' ? src['format'] : undefined;
  const format: 'json' | 'xml' | undefined =
    formatRaw ?? (/at\/xml|ac=xml|\.xml(?!\/)/i.test(apiUrl) ? 'xml' : undefined);

  const rule: CmsSource = {
    name: typeof src['name'] === 'string' ? (src['name'] as string) : undefined,
    apiUrl,
    format,
    playUrl: typeof src['playUrl'] === 'string' ? (src['playUrl'] as string) : undefined,
    encode: typeof src['encode'] === 'string' ? (src['encode'] as string) : undefined,
    // 参数名（`cms.*` 优先，平铺兜底）
    acParam: pickStr('acParam'),
    wdParam: pickStr('wdParam'),
    pgParam: pickStr('pgParam'),
    typeParam: pickStr('typeParam'),
    idsParam: pickStr('idsParam'),
    limitParam: pickStr('limitParam'),
    ...(Number(pick('pageSize')) > 0 ? { pageSize: Math.floor(Number(pick('pageSize'))) } : {}),
    /**
     * ac 值：新四接口（searchAc/catAc/contentAc/detailAc）为主；
     * 老字段 acList/acDetail/acClass 继续作为**别名**参与解析（引擎侧统一走 `acChain`）。
     */
    searchAc: pickStr('searchAc'),
    catAc: pickStr('catAc'),
    contentAc: pickStr('contentAc'),
    detailAc: pickStr('detailAc') ?? pickStr('playAc'),
    acList: pickStr('acList') ?? pickStr('listAc'),
    acDetail: pickStr('acDetail'),
    acClass: pickStr('acClass'),
    playSplit:
      pick('playUrlSplit') === 'crlf' || pick('playUrlSplit') === 'colon'
        ? (pick('playUrlSplit') as 'crlf' | 'colon')
        : src['playSplit'] === 'crlf' || src['playSplit'] === 'colon'
          ? (src['playSplit'] as 'crlf' | 'colon')
          : undefined,
    playFromSplit: pickStr('playFromSplit'),
    brand: pickStr('brand'),
    ...(typeof pick('hasExt') === 'boolean' ? { hasExt: pick('hasExt') as boolean } : {}),
    siteDomains: pickList('siteDomains'),
    blackId: pickList('blackId'),
    /** `#654` 请求头（`cms.header` 优先，平铺 `header` 兜底；三种写法都认，见 parseHeader） */
    header: parseHeader(pick('header')),
    ...(Object.keys(cmsRaw).length ? { cms: cmsRaw as CmsParamsBlock } : {}),
    /**
     * `#479`/`#654` 分类黑名单（按**分类 id 或分类名**屏蔽，和 `blackId` 屏蔽 **vod_id** 是两件事）：
     * `cms.blacklist` 优先，平铺 `blacklist` / zyfun 的 `categories` 兜底。
     */
    blacklist: pickList('blacklist') ?? pickList('categories'),
    /**
     * `#653` `extraParams` 统一成对象。
     * 工坊表单里它是**文本**（JSON），引擎要对象 ⇒ 这里兼容「JSON 字符串」形态，
     * 否则用户在 UI 里填了 `{"h":"24"}` 会被静默忽略（字段看起来存在、实际不生效）。
     */
    extraParams: (() => {
      const rawP = cmsRaw['extraParams'] ?? src['extraParams'];
      if (!rawP) return undefined;
      if (typeof rawP === 'object') return rawP as Record<string, string>;
      if (typeof rawP === 'string' && rawP.trim()) {
        try {
          const j = JSON.parse(rawP) as unknown;
          if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, string>;
        } catch {
          /* 填错了就当没填（`validate` 另有告警位，见 issues） */
        }
      }
      return undefined;
    })(),
    state:
      src['state'] && typeof src['state'] === 'object' ? (src['state'] as import('@yuedu/core').SourceState) : undefined,
  };

  const ok = !issues.some((i) => i.level === 'error');
  return { ok, rule, issues };
}
