/**
 * MacCMS（苹果CMS）引擎（M2，T1 JSON 协议）
 *
 * 实现 contract/engine.ts 的 RuleEngine 接口：
 *   home / category / search / detail / play
 *
 * 兼容性设计（对照用户现场问题 + others/CMS_/cms.ts）：
 *   - 响应形状自动归一：V1–V6（code=1 / status=200；data./list./data数组 任意位置）→ normalizeCmsList/Detail
 *   - 分页别名：pageindex/pagecount/pagesize/recordcount + page 对象自动识别
 *   - ac 双发降级：列表/搜索先 ac=videolist 再退 ac=list；详情 ac=detail；首页 ac=class 退 ac=list
 *   - 封面降级：列表缺封面时批量补 detail（§6.3）
 *   - 反爬/验证页：检测 HTML 验证页 → 抛 ANTI_BOT
 *   - 搜索被禁：code=1002 / 暂不支持搜索 / err not serarch → 优雅返回空，不报错
 *   - 选集解析：dollar-hash / crlf / colon / 双数组 / vod_url 兜底；m3u8 前置
 *   - 参数名可覆盖：ac/wd/pg/t/ids + extraParams（用户在 Web 导入/编辑时自主修改）
 *   - 源开关：state.enabled / searchEnabled / exploreEnabled 短路
 */

import {
  EngineError,
  resolveSourceState,
  type RuleEngine,
  type EngineAction,
  type CompileResult,
  type EngineContext,
  type ValidationIssue,
  type UnifiedRequest,
  type UnifiedListResult,
  type UnifiedDetail,
  type UnifiedItem,
  type UnifiedPlay,
  type FilterGroup,
} from '@yuedu/core';
import {
  type CmsSource,
  type CmsVod,
  detectCmsSource,
  compileCmsSource,
} from './model/cms-source';
import { parsePlayList, inferFormat, type PlaySplit } from './playlist';
import { isXmlText, cmsXmlToJson } from './xml';
import {
  normalizeCmsList,
  normalizeCmsDetail,
  normalizeCmsPlayFields,
  detectAntiBot,
  isJsonText,
  isSearchForbidden,
  hasListContent,
  hasClassContent,
} from './normalize';

const UA = 'Mozilla/5.0 (compatible; EngineHub/0.1)';

/** 语义参数 → 实际参数名（可被源覆盖） */
interface SemanticParams {
  ac?: string;
  wd?: string;
  pg?: string;
  t?: string;
  ids?: string;
}

function buildUrl(rule: CmsSource, p: SemanticParams): string {
  const acP = rule.acParam || 'ac';
  const wdP = rule.wdParam || 'wd';
  const pgP = rule.pgParam || 'pg';
  const tP = rule.typeParam || 't';
  const idsP = rule.idsParam || 'ids';
  const q = new URLSearchParams();
  if (p.ac !== undefined) q.append(acP, p.ac);
  if (p.wd !== undefined) q.append(wdP, p.wd);
  if (p.pg !== undefined) q.append(pgP, p.pg);
  if (p.t !== undefined) q.append(tP, p.t);
  if (p.ids !== undefined) q.append(idsP, p.ids);
  /**
   * `#653` 每页条数：**只有显式配了 `pageSize` 才发**。
   *
   * 为什么默认不发：maccms 各变体对 `limit` 的处理不一致（有的当上限、有的忽略、
   * 个别把非法 limit 直接 400）。旧版从不发 limit 且工作正常 ⇒ 默认保持旧行为，
   * 想控页大小的源自己填 `cms.pageSize`（默认参数名 `limit`，可用 `limitParam` 改）。
   */
  if (rule.pageSize && rule.pageSize > 0) q.append(rule.limitParam || 'limit', String(rule.pageSize));
  if (rule.extraParams) {
    for (const [k, v] of Object.entries(rule.extraParams)) q.append(k, v);
  }
  const sep = rule.apiUrl.includes('?') ? '&' : '?';
  return `${rule.apiUrl}${sep}${q.toString()}`;
}

/**
 * `#653` **分类缓存**（用户要求：分类名/URL 只生成一次，之后加载本地；`刷新分类` 才重拉）。
 *
 * 存哪：hub 的持久 KV（`data/kv.json`），键 `cms:cats:<sourceId>` —— 和自学习 ac 同一个存储，
 * 不额外建表；删源时随 `purgeSourceData` 的源级前缀一起清。
 * TTL：7 天。过期不是「不用」，而是**下次 home 会重拉并覆盖**（既能自动纠错，又不会每次都打站点）。
 */
interface CatsCache {
  /** 生成时间（ms） */
  at: number;
  /**
   * `#655` **探针签名**：这套分类是「用哪套接口参数」探出来的。
   * 用户改了 `apiUrl` / `catAc` / 参数名 / 请求头 / 备用域名之后，旧分类已经不代表这个源了，
   * 必须重探 —— 否则「改了接口地址，发现页还是老站点的分类」，而且 7 天不自愈。
   */
  sig?: string;
  items: Array<{ label: string; typeId: string; url: string }>;
}

const CATS_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * `#655` 参与签名的字段 = **决定「探出来的分类长什么样」的那些**。
 *
 * ⚠️ 故意**不含 `blacklist`**：黑名单是「显示时过滤」，不是「探针条件」。
 * 这样用户改黑名单后点刷新分类是**瞬间生效、零请求**的（缓存里的分类还在，
 * 只是展示时按名单剔掉）—— 反过来把 blacklist 放进签名，改一次就要重探一次站点。
 */
function catsSig(rule: CmsSource): string {
  return JSON.stringify([
    rule.apiUrl,
    rule.catAc ?? rule.acClass ?? '',
    rule.acParam ?? '',
    rule.typeParam ?? '',
    rule.idsParam ?? '',
    rule.format ?? '',
    rule.header ?? null,
    rule.siteDomains ?? null,
  ]);
}

/** 四接口（对应 OmniFlow 的 searchAc / catAc / contentAc / detailAc） */
type AcIface = 'search' | 'cat' | 'content' | 'detail';

/**
 * `#653` **四接口 ac 候选链**。
 *
 * 语义（对齐 OmniFlow 的「填了就只试它，空则自动 fallback」）：
 *  · 用户显式填了该接口的 ac ⇒ **只把它放第一位**，后面仍带内置 fallback
 *    （OmniFlow 是「填值即可，空时自动 fallback」，我们不比它更激进：显式值失败了还能救回来）；
 *  · 没填 ⇒ 自学习值（上次成功过的）优先，其次内置顺序：
 *      search  detail → videolist → list   （ac=list 普遍无封面，所以排最后）
 *      cat     list → class                （class 不是标准动作，见 fetchClassList 注释）
 *      content detail → videolist          （分类卡片列表要封面 ⇒ 先 detail）
 *      detail  detail → videolist
 */
const AC_DEFAULTS: Record<AcIface, string[]> = {
  search: ['detail', 'videolist', 'list'],
  cat: ['list', 'class'],
  content: ['detail', 'videolist'],
  detail: ['detail', 'videolist'],
};

function explicitAc(rule: CmsSource, iface: AcIface): string | undefined {
  if (iface === 'search') return rule.searchAc;
  if (iface === 'cat') return rule.catAc || rule.acClass;
  if (iface === 'content') return rule.contentAc || rule.acList;
  return rule.detailAc || rule.acDetail;
}

/** 自学习键（存在 hub 的持久 KV 里，删源时随 `purgeSourceData` 的前缀清理） */
function acLearnKey(sourceId: string, iface: AcIface): string {
  return `cms:ac:${sourceId}:${iface}`;
}

function acChain(rule: CmsSource, iface: AcIface, learned?: string): string[] {
  const out: string[] = [];
  const explicit = explicitAc(rule, iface);
  if (explicit) out.push(explicit);
  else if (learned && learned.trim()) out.push(learned.trim());
  for (const d of AC_DEFAULTS[iface]) if (!out.includes(d)) out.push(d);
  return out;
}

/** 网络层错误判定（域名镜像回退只对这些错误重试，4xx/解析错不重试） */
function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timeout|network/i.test(msg);
}

/**
 * `#653` **备用域名**：把 url 的 origin 换成 `siteDomains` 里的每个域名。
 * 主域永远排第一；没有 siteDomains 或 url 解析失败 ⇒ 原样返回。
 */
function mirrorUrls(url: string, rule: CmsSource): string[] {
  const rawDoms = rule.siteDomains;
  // 允许数组或「换行/逗号分隔的串」（用户手填 JSON 时两种都常见）
  const doms: string[] = Array.isArray(rawDoms)
    ? rawDoms.map((s) => String(s))
    : typeof rawDoms === 'string'
      ? rawDoms.split(/[,，\n]+/)
      : [];
  if (!doms.length) return [url];
  let origin: string;
  let rest: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    rest = url.slice(origin.length);
  } catch {
    return [url];
  }
  const out = [url];
  for (const d of doms) {
    const clean = String(d).trim().replace(/\/+$/, '');
    if (!clean || clean === origin) continue;
    const cand = `${clean}${rest}`;
    if (!out.includes(cand)) out.push(cand);
  }
  return out;
}

/** 极简 JSONPath 取值（仅覆盖 §6.5 的 $.url 形式） */
function firstByPath(obj: unknown, path: string): unknown {
  const norm = path.replace(/^\$\.?/, '');
  if (!norm) return obj;
  const segs = norm.split(/[.\[\]]/).map((s) => s.trim()).filter(Boolean);
  let cur: any = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function emptyList(page = 1): UnifiedListResult {
  return { items: [], page: { page, pageCount: 0, total: 0, hasMore: false } };
}

/**
 * `#479` 解析分类黑名单为 Set（`blacklist` 数组/逗号分隔串；兼容 zyfun 的 `categories`）。
 * 空名单返回空 Set —— 过滤点 `black.size` 短路，零开销。
 */
function blacklistOf(rule: CmsSource): Set<string> {
  const raw = (rule as { blacklist?: unknown; categories?: unknown }).blacklist ?? (rule as { categories?: unknown }).categories;
  const items: string[] = Array.isArray(raw)
    ? raw.map((s) => String(s).trim())
    : typeof raw === 'string'
      ? raw.split(/[,，\n]+/)
      : [];
  return new Set(items.map((s) => s.trim()).filter(Boolean));
}

/**
 * `#654` **分类黑名单过滤**（`blacklist` / zyfun 的 `categories`）。
 *
 * 命中判据：`type_id` **或** `type_name` —— 用户按名排除（「里番」）比记 id 自然，
 * 但有的站分类名会变（「电影片」→「电影」），所以 id 也要认。空黑名单直接短路返回。
 *
 * 应用点：home 的分类 chips（`filters`）、分类列表卡片、搜索结果卡片 —— 三处同一判据，
 * 否则「屏蔽了分类，搜索里还能搜到」就成了漏网（`#479` 只做了前两处）。
 */
function filterBlacklist(rule: CmsSource, list: CmsVod[] | undefined): CmsVod[] {
  const arr = Array.isArray(list) ? list : [];
  const black = blacklistOf(rule);
  if (!black.size) return arr;
  return arr.filter((v) => !black.has(String(v.type_id ?? '')) && !black.has(String(v.type_name ?? '')));
}

/**
 * `#653` ac 候选链里，**每条都失败**时该抛哪个错。
 *
 * 为什么要判：链会把「这个 ac 不支持」和「整个域名反爬/不是 JSON」都吞成一次 continue。
 * 前者该继续试下一个 ac；后者换 ac 也没用，必须原样抛给上层（否则用户看到的是
 * 「SELECTOR_MISS」而不是「撞了反爬页」，诊断会完全跑偏 —— `#653` 之前的行为就是直接抛 ANTI_BOT）。
 */
function semanticError(e: unknown): unknown {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'ANTI_BOT' || code === 'DECODE' ? e : null;
}

/**
 * `#653` **屏蔽 vod_id**（`cms.blackId`）—— 与 `blacklist`（屏蔽**分类**）是两件事：
 * 前者剔除具体片子（版权/不想看的），后者剔除整个分类。空集合时过滤点短路。
 *
 * ⚠️ 两者**不能合并成一个列表**：分类 id 与 vod_id 都是小整数，混在一起会互相误伤
 * （屏蔽分类 `1` 会顺手屏蔽 `vod_id=1` 的片子）。`#654` 只把语义写清、字段分开保留。
 */
function blackIdOf(rule: CmsSource): Set<string> {
  const raw = rule.blackId;
  const items: string[] = Array.isArray(raw)
    ? raw.map((s) => String(s).trim())
    : typeof raw === 'string'
      ? raw.split(/[,，\n]+/).map((s) => s.trim())
      : [];
  return new Set(items.filter(Boolean));
}

export class MacCmsEngine implements RuleEngine<CmsSource, unknown> {
  readonly kind = 'maccms';
  readonly version = '0.1.0';
  readonly capabilities: EngineAction[] = ['home', 'category', 'search', 'detail', 'play'];

  detect(raw: unknown): boolean {
    return detectCmsSource(raw);
  }

  compile(raw: unknown): CompileResult<CmsSource> {
    const r = compileCmsSource(raw);
    return { ok: r.ok, rule: r.rule, issues: r.issues as ValidationIssue[] };
  }

  validate(rule: CmsSource): ValidationIssue[] {
    return compileCmsSource(rule).issues as ValidationIssue[];
  }

  /**
   * `#653` 该接口的 ac 候选链：**显式配置 > 自学习 > 内置 fallback**。
   *
   * 自学习读的是 hub 的持久 KV（`data/kv.json`），键 `cms:ac:<sourceId>:<iface>`
   * —— 上一次哪个 ac 成功过，下一次直接先试它，省掉一轮注定失败的请求
   * （OmniFlow 的「填值即可，空时自动 fallback + 自学习」同义）。
   */
  private async chainFor(ctx: EngineContext, rule: CmsSource, iface: AcIface): Promise<string[]> {
    let learned: string | undefined;
    const st = ctx.storage;
    if (st && typeof st.get === 'function') {
      try {
        learned = (await st.get(acLearnKey(ctx.sourceId, iface))) ?? undefined;
      } catch {
        /* KV 读失败 ⇒ 只用内置链 */
      }
    }
    return acChain(rule, iface, learned);
  }

  /** 读分类缓存（KV 不可用/坏 JSON ⇒ null，退回网络） */
  private async readCats(ctx: EngineContext): Promise<CatsCache | null> {
    const st = ctx.storage;
    if (!st || typeof st.get !== 'function') return null;
    try {
      const raw = await st.get(`cms:cats:${ctx.sourceId}`);
      if (!raw) return null;
      const j = JSON.parse(raw) as CatsCache;
      if (!j || !Array.isArray(j.items) || !j.items.length) return null;
      return j;
    } catch {
      return null;
    }
  }

  /** 写分类缓存（失败静默：缓存是增强，写不进去不该影响本次结果） */
  private writeCats(ctx: EngineContext, rule: CmsSource, items: CatsCache['items']): void {
    const st = ctx.storage;
    if (!st || typeof st.set !== 'function' || !items.length) return;
    const payload = JSON.stringify({ at: Date.now(), sig: catsSig(rule), items } satisfies CatsCache);
    void Promise.resolve(st.set(`cms:cats:${ctx.sourceId}`, payload)).catch(() => {});
  }

  /** 记住让该接口成功的 ac（失败静默：学不到不该影响这次请求） */
  private learnAc(ctx: EngineContext, iface: AcIface, ac: string): void {
    const st = ctx.storage;
    // 测试桩 / 极简 ctx 可能没有 storage —— 自学习是**增强**，不能因此让请求失败
    if (!st || typeof st.set !== 'function') return;
    void Promise.resolve(st.set(acLearnKey(ctx.sourceId, iface), ac)).catch(() => {});
  }

  // ---- 公共：请求 + 解析 JSON（带反爬检测） ----
  /**
   * `#653` 带**备用域名**的取数：主域失败且是**网络层**错误时，按 `cms.siteDomains` 顺序重试。
   * 解析错（非 JSON / 反爬）不重试 —— 换个域名也是同一份坏响应，白白多打请求。
   */
  private async raw(ctx: EngineContext, url: string, rule?: CmsSource): Promise<Record<string, unknown>> {
    const cands = rule ? mirrorUrls(url, rule) : [url];
    let lastErr: unknown;
    for (let i = 0; i < cands.length; i++) {
      try {
        return await this.fetchJson(ctx, cands[i] as string, rule);
      } catch (e) {
        lastErr = e;
        const more = i + 1 < cands.length;
        if (!more || !isNetworkError(e)) throw e;
        ctx.trace.push({ stage: 'request', rule: `mirror→${cands[i + 1]}` });
      }
    }
    throw lastErr;
  }

  private async fetchJson(ctx: EngineContext, url: string, rule?: CmsSource): Promise<Record<string, unknown>> {
    /**
     * `#654` **请求头接通**（源级 `header`，见 `parseHeader`）：
     *  · 默认 `User-Agent`，源里配了同名键则**覆盖**（很多站按 UA 分流，必须让用户能改）；
     *  · 其余头原样带上（`Referer` / `X-Token` / `Authorization` …）。
     * `#653` 之前工坊「进阶」有这个输入框但引擎没读 ⇒ 填了等于没填（死字段）。
     */
    const headers: Record<string, string> = { 'User-Agent': UA, ...(rule?.header ?? {}) };
    const resp = await ctx.http.request(url, { headers, method: 'GET' });
    const body = resp.body;
    if (typeof body !== 'string') {
      throw new EngineError('DECODE', 'request', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: url,
        input: 'binary response',
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    // XML 接口（at/xml）：解析后转标准 JSON 形状，下游归一化零改动
    if (isXmlText(body)) {
      try {
        return cmsXmlToJson(body) as unknown as Record<string, unknown>;
      } catch (e) {
        throw new EngineError('RULE_PARSE', 'parse', {
          engine: this.kind,
          sourceId: ctx.sourceId,
          rule: url,
          input: `xml: ${String(e instanceof Error ? e.message : e)}: ${body.slice(0, 120)}`,
          trace: ctx.trace.tail(20),
          retryable: false,
        });
      }
    }
    // 反爬 / 验证页（HTML 而非 JSON）
    if (!isJsonText(body)) {
      const reason = detectAntiBot(body);
      throw new EngineError('ANTI_BOT', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: url,
        input: reason ? `${reason}: ${body.slice(0, 120)}` : `non-json body: ${body.slice(0, 120)}`,
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch (e) {
      throw new EngineError('RULE_PARSE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: url,
        input: String(e instanceof Error ? e.message : e),
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
  }

  /** 单条 vod → UnifiedItem */
  private toItem(v: CmsVod): UnifiedItem {
    return {
      id: String(v.vod_id),
      kind: 'video',
      title: String(v.vod_name ?? ''),
      cover: v.vod_pic ? String(v.vod_pic) : undefined,
      subtitle: v.vod_remarks ? String(v.vod_remarks) : undefined,
      summary: v.vod_blurb || v.vod_content ? String(v.vod_blurb || v.vod_content) : undefined,
      tags: v.type_name ? [String(v.type_name)] : undefined,
      layout: 'grid-card',
      payload: { vod_id: String(v.vod_id) },
      raw: v,
    };
  }

  /**
   * 列表映射 + 封面降级（§6.3）。
   *
   * 列表里有条目缺字段（主要是 `vod_pic`）时，用 `ac=detail&ids=…` **批量**取回详情补缺。
   *
   * ⚠️ **2026-09-21 修（用户可见缺陷）**：旧实现是 `normalizeCmsDetail(d)`（**只取首条**）
   * 然后 `items = [dv]` —— 把**整张列表塌成 1 条**。实测 `api.xjzyapi.com`：
   * `ac=list` 的短列表普遍无图 → 首页/分类页 20 条只剩 1 张卡。
   * 而该接口对多 id 是**逐条返回**的（`ids=106469,102654,106467` → `list.length=2`），
   * 所以正确做法是「按 `vod_id` 建索引 → 逐条补齐**空缺**字段」，**条数与顺序保持不变**。
   * 补齐语义：列表里已有的非空值**优先**（列表就是调用方要的数据），只填空缺/空串。
   */
  private async mapList(ctx: EngineContext, rule: CmsSource, list: CmsVod[] | undefined): Promise<UnifiedItem[]> {
    if (!Array.isArray(list) || list.length === 0) return [];
    /** `#653` 屏蔽 vod_id（`cms.blackId`）：列表/搜索/首页统一在这里剔除，空集合零开销 */
    const blocked = blackIdOf(rule);
    let items = blocked.size ? list.filter((v) => !blocked.has(String(v.vod_id ?? ''))) : list;
    if (list.some((v) => !v.vod_pic)) {
      const ids = list.map((v) => String(v.vod_id)).filter(Boolean).join(',');
      if (ids) {
        try {
          const d = await this.raw(ctx, buildUrl(rule, { ac: rule.detailAc || rule.acDetail || 'detail', ids }), rule);
          // 整表（不是首条）——多 id 请求会逐条返回
          const detail = normalizeCmsList(d).list;
          if (detail.length) {
            const byId = new Map(detail.map((v) => [String(v.vod_id), v as Record<string, unknown>]));
            items = list.map((v) => {
              const dv = byId.get(String(v.vod_id));
              if (!dv) return v;
              const merged = { ...(v as unknown as Record<string, unknown>) };
              for (const [k, val] of Object.entries(dv)) {
                const cur = merged[k];
                if (cur == null || cur === '') merged[k] = val;
              }
              return merged as unknown as CmsVod;
            });
          }
        } catch {
          /* 降级失败就用原 list，不阻断 */
        }
      }
    }
    return items.map((v) => this.toItem(v));
  }

  private pageInfo(n: ReturnType<typeof normalizeCmsList>, page: number) {
    return {
      page,
      pageCount: n.pageCount,
      total: n.total,
      hasMore: n.pageCount ? page < n.pageCount : false,
    };
  }

  /**
   * 取**分类**（首页 `filters` 的来源）：候选 `ac` 依次尝试，取第一个**真的给出 class 列表**的响应。
   *
   * ⚠️ 为什么不能只发 `ac=class`（2026-09-21 用户报告「CMS 分类获取失败」）：
   * `ac=class` **不是** maccms 标准动作，标准是 `ac=list`（分类 + 短列表一起返回）。
   * 实测 `api.xjzyapi.com`：`ac=class` → `{code,limit,list:[20 条 vod]}`（**没有 class**），
   * `ac=list` → `class: 38 条 + list: 20 条`。旧逻辑判「有 list 就算有内容」→ `ac=class` 直接通过、
   * 不再降级 → 分类为空。详见 `hasClassContent` 的注释。
   *
   * 候选顺序：源显式配置的 `acClass` → `list`（标准）→ `class`（扩展），去重。
   * 逐个请求，**单个候选失败不中断**（不实现 `ac=class` 的站点会 404/返错，应继续找下一个）；
   * 全部都不含 class 时返回「最后一个有内容的响应」（保证首页仍有推荐位），一个都没有才抛错。
   */
  private async fetchClassList(ctx: EngineContext, rule: CmsSource): Promise<Record<string, unknown>> {
    // `#653` 候选链：catAc/acClass 显式值 > 自学习 > list → class
    const cands = await this.chainFor(ctx, rule, 'cat');
    let lastWithContent: Record<string, unknown> | null = null;
    let firstErr: unknown = null;
    let semanticErr: unknown = null;
    for (const ac of cands) {
      let resp: Record<string, unknown>;
      try {
        resp = await this.raw(ctx, buildUrl(rule, { ac }), rule);
      } catch (e) {
        firstErr ??= e; // 站点不实现该 ac（404/HTML/反爬）→ 继续下一个候选
        semanticErr ??= semanticError(e);
        continue;
      }
      if (hasClassContent(resp)) {
        this.learnAc(ctx, 'cat', ac);
        return resp;
      }
      if (hasListContent(resp)) lastWithContent = resp;
    }
    if (lastWithContent) return lastWithContent;
    if (semanticErr) throw semanticErr;
    if (firstErr) throw firstErr;
    throw new EngineError('SELECTOR_MISS', 'parse', {
      engine: this.kind,
      sourceId: ctx.sourceId,
      rule: `ac=${cands.join('|')}`,
      input: null,
      trace: ctx.trace.tail(20),
      retryable: false,
    });
  }

  // ---- 首页 / 发现：取分类 + 推荐 ----
  async home(rule: CmsSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    const state = resolveSourceState(rule.state);
    if (!state.enabled || !state.exploreEnabled) return emptyList();

    /**
     * `#653` **分类本地化**（用户要求：分类名+URL 生成一次就记下来，刷新分类才重新生成）：
     *  · 命中缓存 ⇒ **不再做 ac 探测**（省掉 1~3 次请求），只取一页推荐位；
     *  · 未命中 / 显式刷新（`extra.refreshCategories=true`）/ 超 TTL ⇒ 走原路径生成并写缓存。
     *
     * 刷新入口在后端：`POST /api/sources/:id/categories/refresh`。
     */
    const refresh = req?.extra?.['refreshCategories'] === true;
    /**
     * `categoriesOnly`：只要分类、不要推荐位 —— 工坊/发现页的「分类缓存」接口就传它。
     * 不传时保持原行为（首页要推荐位）。这样「读本地分类」是**零网络**的。
     */
    const catsOnly = req?.extra?.['categoriesOnly'] === true;
    const cached = refresh ? null : await this.readCats(ctx);
    /**
     * `#655` 缓存可用判据 = **未过期** 且 **探针签名一致**。
     *
     * 用户实测报的 bug 就在这里：`非凡资源` 填了 `cms.blacklist=电影片,连续剧,综艺片`，
     * 发现页点「刷新分类」后那三个分类**还在**。真因不是黑名单没生效，而是发现页的
     * 「刷新分类」走 `home`（`discover.ts` 的 `onSourceChange`），命中**分类 KV 缓存**后
     * 直接 `cached.items.map(...)` 就返回了 —— **命中分支从来没套用黑名单**，
     * 而缓存是 7 天 TTL、改 blacklist 也不会失效 ⇒ 看起来「填了没用」。
     *
     * 修法两条一起：
     *  ① 命中分支**也**按黑名单过滤（显示时过滤，零请求 ⇒ 改黑名单立刻见效）；
     *  ② 缓存带 `sig`，探针条件（apiUrl/参数名/请求头/备用域名）变了就视为未命中，
     *     否则「换了接口地址，分类还是老站点的」。
     */
    const sigOk = !!cached && (cached.sig === undefined || cached.sig === catsSig(rule));
    if (cached && sigOk && Date.now() - cached.at < CATS_TTL_MS) {
      let items: UnifiedItem[] = [];
      if (!catsOnly) {
        try {
          const ac = (await this.chainFor(ctx, rule, 'content'))[0] ?? 'detail';
          const r = await this.raw(ctx, buildUrl(rule, { ac, pg: '1' }), rule);
          items = await this.mapList(ctx, rule, normalizeCmsList(r).list);
        } catch {
          /* 推荐位取不到不影响分类展示（用户点进分类再取也行） */
        }
      }
      const black = blacklistOf(rule);
      const options = cached.items
        .filter((i) => !black.has(i.label) && !black.has(i.typeId))
        .map((i) => ({ name: i.label, value: i.typeId }));
      return {
        items,
        page: emptyList().page,
        filters: [{ name: '分类', key: 't', options }],
      };
    }

    const resp = await this.fetchClassList(ctx, rule);
    const n = normalizeCmsList(resp);
    /**
     * `#479` **分类黑名单**（对齐 zyfun `source.categories` 按名排除）：条目命中
     * `type_id` 或 `type_name` 的分类**不出现**在发现分类里；`category` 同步过滤卡片。
     * 输入兼容：数组（zyfun 形态）或逗号分隔字符串（工坊表单）。
     */
    const black = blacklistOf(rule);
    const options = n.classes
      .map((c) => ({ name: String(c.type_name), value: String(c.type_id) }))
      .filter((o) => !black.has(o.name) && !black.has(o.value));
    const filters: FilterGroup[] | undefined = options.length
      ? [{ name: '分类', key: 't', options }]
      : undefined;
    /**
     * 生成并缓存「分类名 + 该分类的请求 URL」。
     * URL 用**内容链的首选 ac**（detail 优先，卡片有封面），和 `category()` 实际请求一致。
     *
     * ⚠️ `#655` **必须存站点原样（`n.classes`），不能存过滤后的 `options`**：
     * 缓存里若已经剔掉被屏蔽的分类，用户把黑名单清空后（探针条件没变、签名仍命中）
     * 那些分类就**再也回不来了**，要等 7 天 TTL 或手动刷新。
     * 黑名单是「展示层」的事 —— 缓存只负责「这个源现在有哪些分类」这个事实。
     */
    const catAc = explicitAc(rule, 'content') ?? AC_DEFAULTS.content[0] ?? 'detail';
    this.writeCats(
      ctx,
      rule,
      n.classes.map((c) => ({
        label: String(c.type_name),
        typeId: String(c.type_id),
        url: buildUrl(rule, { ac: catAc, t: String(c.type_id), pg: '1' }),
      })),
    );
    // `#654` 推荐位卡片同样按分类黑名单过滤（原来只过滤分类 chips，卡片会漏）
    const items = await this.mapList(ctx, rule, filterBlacklist(rule, n.list));
    return { items, page: emptyList().page, filters };
  }

  // ---- 分类列表 ----
  async category(rule: CmsSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    const state = resolveSourceState(rule.state);
    if (!state.enabled || !state.exploreEnabled) return emptyList(req.page ?? 1);
    const tid = req.filters?.['t'];
    if (!tid) {
      throw new EngineError('SOURCE_INVALID', 'request', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: 'filters.t',
        input: req.filters,
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    const page = req.page ?? 1;
    /**
     * `#653` **内容分页 ac 链**：contentAc/listAc 显式值 > 自学习 > detail → videolist。
     * 为什么 detail 排第一：分类卡片要封面，而 `ac=list` 的短列表普遍没有 `vod_pic`（见 mapList 注释）。
     */
    const chain = await this.chainFor(ctx, rule, 'content');
    let resp: Record<string, unknown> | null = null;
    let firstErr: unknown = null;
    let semanticErr: unknown = null;
    for (const ac of chain) {
      try {
        const r = await this.raw(ctx, buildUrl(rule, { ac, t: String(tid), pg: String(page) }), rule);
        if (hasListContent(r)) {
          this.learnAc(ctx, 'content', ac);
          resp = r;
          break;
        }
        resp ??= r; // 有响应但没内容（可能是空分类页）：留着兜底
      } catch (e) {
        firstErr ??= e;
        // 语义错误（反爬/解码）优先于「这个 ac 不支持」，见 semanticError 注释
        semanticErr ??= semanticError(e);
      }
    }
    if (!resp || !hasListContent(resp)) {
      if (semanticErr) throw semanticErr;
      throw new EngineError('SELECTOR_MISS', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: `ac=${chain.join('|')}&t=${tid}`,
        input: resp ?? (firstErr instanceof Error ? firstErr.message : firstErr),
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    const n = normalizeCmsList(resp);
    // `#479`/`#654` 黑名单同步过滤卡片：`type_id` **或** `type_name` 命中即弃
    const items = await this.mapList(ctx, rule, filterBlacklist(rule, n.list));
    return { items, page: this.pageInfo(n, page) };
  }

  // ---- 搜索 ----
  async search(rule: CmsSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    const state = resolveSourceState(rule.state);
    if (!state.enabled || !state.searchEnabled) return emptyList(req.page ?? 1);
    const wd = (req.keyword ?? '').trim();
    if (!wd) {
      throw new EngineError('SOURCE_INVALID', 'request', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: 'keyword',
        input: req.keyword,
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    const page = req.page ?? 1;
    /**
     * `#653` **搜索 ac 链**：searchAc 显式值 > 自学习 > detail → videolist → list。
     * `list` 排最后：多数站 `ac=list` 搜索不返回 `vod_pic`（卡片全空图）。
     * 站点明确「禁止搜索」（`isSearchForbidden`）⇒ 所有 ac 都别试了，直接空结果。
     */
    const chain = await this.chainFor(ctx, rule, 'search');
    let resp: Record<string, unknown> | null = null;
    let firstErr: unknown = null;
    let semanticErr: unknown = null;
    for (const ac of chain) {
      try {
        const r = await this.raw(ctx, buildUrl(rule, { ac, wd, pg: String(page) }), rule);
        if (isSearchForbidden(r)) return emptyList(page);
        if (hasListContent(r)) {
          this.learnAc(ctx, 'search', ac);
          resp = r;
          break;
        }
        resp ??= r;
      } catch (e) {
        firstErr ??= e;
        // 语义错误（反爬/解码）优先于「这个 ac 不支持」，见 semanticError 注释
        semanticErr ??= semanticError(e);
      }
    }
    /**
     * ⚠️ 「有响应但没内容」也要算失败：mock/真实站点对不支持的 ac 常回 `{}` 或空 list，
     * 若把它当成兜底响应，就会把「videolist 撞反爬」这种**语义错误**吞成 SELECTOR_MISS
     * （`#653` 回归锁 `反爬/验证页` 就是抓这个）。
     */
    if (!resp || !hasListContent(resp)) {
      if (semanticErr) throw semanticErr;
      throw new EngineError('SELECTOR_MISS', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: `ac=${chain.join('|')}&wd=${wd}`,
        input: resp ?? (firstErr instanceof Error ? firstErr.message : firstErr),
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    const n = normalizeCmsList(resp);
    // `#654` 搜索卡片同样过滤分类黑名单（否则「屏蔽了分类，搜索里还能搜到」）
    const items = await this.mapList(ctx, rule, filterBlacklist(rule, n.list));
    return { items, page: this.pageInfo(n, page) };
  }

  // ---- 详情 + 目录（播放链） ----
  async detail(rule: CmsSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedDetail> {
    // id 兼容多形态：统一契约里前端传 JSON.stringify(payload)，这里是 {"vod_id":"..."}；也接受纯 id / 数字
    let ids = String(req.id ?? '').trim();
    if (ids.startsWith('{') || ids.startsWith('[')) {
      try {
        const parsed = JSON.parse(ids) as Record<string, unknown>;
        const extracted = parsed['vod_id'] ?? parsed['id'] ?? (Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>)?.['vod_id'] : undefined);
        ids = extracted != null ? String(extracted) : '';
      } catch {
        /* 保底用原串 */
      }
    }
    if (!ids) {
      throw new EngineError('SOURCE_INVALID', 'request', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: 'id',
        input: req.id,
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    /**
     * `#653` **详情 ac 链**：detailAc/playAc/acDetail 显式值 > 自学习 > detail → videolist。
     * `videolist` 兜底是实测来的：有的站 `ac=detail` 只回精简字段（无播放串），
     * 而 `ac=videolist&ids=` 才给 `vod_play_url`（见下面「0 集兜底」注释）。
     */
    const chain = await this.chainFor(ctx, rule, 'detail');
    let resp: Record<string, unknown> | null = null;
    let rawV: ReturnType<typeof normalizeCmsDetail> = null;
    let firstErr: unknown = null;
    let semanticErr: unknown = null;
    for (const ac of chain) {
      try {
        const r = await this.raw(ctx, buildUrl(rule, { ac, ids }), rule);
        const v = normalizeCmsDetail(r);
        if (v) {
          this.learnAc(ctx, 'detail', ac);
          resp = r;
          rawV = v;
          break;
        }
        resp ??= r;
      } catch (e) {
        firstErr ??= e;
        // 语义错误（反爬/解码）优先于「这个 ac 不支持」，见 semanticError 注释
        semanticErr ??= semanticError(e);
      }
    }
    if (!rawV) {
      if (semanticErr) throw semanticErr;
      throw new EngineError('SELECTOR_MISS', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: `ac=${chain.join('|')}&ids=${ids}`,
        input: firstErr instanceof Error ? firstErr.message : (resp ?? firstErr),
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }
    const split: PlaySplit = rule.playSplit || 'dollar-hash';
    /** `#653` 线路分隔符可配（默认 `$$$`，个别源用 `$$` / `|||`） */
    const playOpts = { split, ...(rule.playFromSplit ? { lineSep: rule.playFromSplit } : {}) };
    let v = normalizeCmsPlayFields(rawV);
    let plays = parsePlayList(v.vod_play_from, v.vod_play_url, { ...playOpts, vodUrl: v.vod_url });
    /**
     * **0 集兜底：改用列表端点再取一次。**
     *
     * 为什么需要（2026-09-26 用户实测「大地资源：没有解析到选集」）：
     * 该站的 `ac=detail` 是**精简版**，只返回 `{vod_id, vod_name, list_name, vod_play}` ——
     * **既没有 `vod_play_url` 也没有 `vod_url`**；而**同一个 id 走 `ac=videolist&ids=`**
     * 才带播放串（实测 `vod_url = "在线播放$https://…/index.m3u8"`）。
     * 注意 `ac=videolist` 在标准 AppleCMS 里同样接受 `ids` ⇒ 这条兜底对标准源也安全，
     * 且**只在 detail 解析出 0 集时才多打一次请求**（正常源不受影响）。
     * 失败不抛：保持「0 集」的原结果，由上层显示提示（不掩盖真正的原因）。
     */
    if (!plays.length && v.vod_id != null) {
      // `#653`：兜底把 content 链里**没试过的** ac 全试一遍（原来只试 acList 一个值）
      const fbChain = (await this.chainFor(ctx, rule, 'content')).filter((a) => !chain.includes(a) || a !== chain[0]);
      for (const ac of fbChain) {
        try {
          const fb = await this.raw(ctx, buildUrl(rule, { ac, ids: String(v.vod_id) }), rule);
          const fbV = normalizeCmsDetail(fb);
          if (!fbV) continue;
          const nv = normalizeCmsPlayFields(fbV);
          const fbPlays = parsePlayList(nv.vod_play_from, nv.vod_play_url, { ...playOpts, vodUrl: nv.vod_url });
          if (fbPlays.length) {
            plays = fbPlays;
            // 列表端点的字段更全（封面/简介/演员等），整条替换掉精简版
            v = { ...nv, vod_id: v.vod_id };
            break;
          }
        } catch {
          /* 该 ac 兜底失败 → 试下一个 */
        }
      }
    }
    let order = 0;
    const chapters = plays.flatMap((p) =>
      p.episodes.map((ep) => ({
        title: ep.text,
        payload: { from: p.from, episode: ep.text, raw: ep.link, index: order },
        order: order++,
      })),
    );
    return {
      id: String(v.vod_id),
      kind: 'video',
      title: String(v.vod_name ?? ''),
      cover: v.vod_pic ? String(v.vod_pic) : undefined,
      subtitle: v.vod_remarks ? String(v.vod_remarks) : undefined,
      summary: v.vod_blurb || v.vod_content ? String(v.vod_blurb || v.vod_content) : undefined,
      tags: v.type_name ? [String(v.type_name)] : undefined,
      meta: {
        ...(v.vod_year ? { 年份: String(v.vod_year) } : {}),
        ...(v.vod_area ? { 地区: String(v.vod_area) } : {}),
        ...(v.vod_director ? { 导演: String(v.vod_director) } : {}),
        ...(v.vod_actor ? { 主演: String(v.vod_actor) } : {}),
      },
      chapters,
      raw: v,
    };
  }

  // ---- 播放地址解析（§6.5） ----
  async play(rule: CmsSource, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedPlay> {
    const raw =
      (typeof req.extra?.['playRaw'] === 'string' && (req.extra['playRaw'] as string)) ||
      (typeof req.extra?.['playUrl'] === 'string' && (req.extra['playUrl'] as string)) ||
      '';
    if (!raw) {
      throw new EngineError('SOURCE_INVALID', 'request', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: 'extra.playRaw',
        input: req.extra,
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }

    // 已匹配直链
    if (/\.(m3u8|mp4|mpd|flv|mkv)(\?|#|$)/i.test(raw)) {
      return { url: raw, format: inferFormat(raw) };
    }

    const playUrl = rule.playUrl;
    if (playUrl && playUrl.startsWith('json:')) {
      const target = playUrl.replace('json:', '') + encodeURIComponent(raw);
      /**
       * `#654` 这里**只带请求头、不做镜像**：解析服务常常是另一个域名，
       * 拿 `siteDomains` 去替换它的 origin 只会拼出坏地址。
       */
      const resp = await this.fetchJson(ctx, target, rule);
      const url = firstByPath(resp, '$.url');
      if (url != null && String(url).length) {
        return { url: String(url), format: inferFormat(String(url)) };
      }
      throw new EngineError('DECODE', 'parse', {
        engine: this.kind,
        sourceId: ctx.sourceId,
        rule: 'json: play url',
        input: resp,
        trace: ctx.trace.tail(20),
        retryable: false,
      });
    }

    // 其他：交给外部解析（parse = 1）
    return { url: raw, format: inferFormat(raw) };
  }
}
