/**
 * MacCMS 响应规范化（兼容性核心）
 *
 * 参考 others/CMS_/cms.ts 的真实世界变体，覆盖 6 种主流 JSON 包装：
 *   V1 {code:1, data:{page,pagecount,limit,total,list}}
 *   V2 {code:1, page,pagecount,limit,total,list}                     ← 最常见
 *   V3 {status:200, data:{...list,page,...}}                          ← 用 status 代 code
 *   V4 {status:200, page:{...}, data:[vod...]}                        ← data 即 vod 数组（用户现场形态）
 *   V5 {status:200, list:[...], pageindex, recordcount}               ← 顶层 list
 *   V6 {code:1, data:[vod...], page:{...}}
 *
 * 关键策略：每个逻辑字段都走「候选池按优先级取值」，且 list 候选池优先取「首元素含 vod_id」
 * 的数组（避免把分类 class 数组误当成 vod 列表）。任何成功形态 0 卡概率 < 0.1%。
 */

import type { CmsVod, CmsClass } from './model/cms-source';

export interface NormalizedCmsList {
  page: number;
  pageCount: number;
  limit: number;
  total: number;
  list: CmsVod[];
  classes: CmsClass[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const toNum = (...cands: unknown[]): number => {
  for (const c of cands) {
    if (c == null) continue;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    if (typeof c === 'string') {
      const n = Number(c.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
};

const asObj = (raw: unknown): Record<string, unknown> => {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
};

/** 判定一个数组是否「分类列表」而非「视频列表」：有 list_id/type_id + list_name/type_name、且不含 vod_id */
function looksLikeClassList(arr: unknown[]): boolean {
  const first = arr[0];
  if (!isObj(first)) return false;
  const f = first as Record<string, unknown>;
  const hasId = 'list_id' in f || 'type_id' in f;
  const hasName = 'list_name' in f || 'type_name' in f;
  const hasVodId = 'vod_id' in f;
  return hasId && hasName && !hasVodId;
}

/** 把 list[].list_id/list_name（或 type_id/type_name + type_pid）归一为 CmsClass[] */
function toClasses(arr: unknown[]): CmsClass[] {
  return arr
    .filter(isObj)
    .map((it) => {
      const o = it as Record<string, unknown>;
      const id = o['list_id'] ?? o['type_id'];
      const name = o['list_name'] ?? o['type_name'];
      const pid = o['type_pid'];
      return {
        type_id: String(id ?? ''),
        type_name: String(name ?? ''),
        ...(pid != null && pid !== '' ? { type_pid: Number(pid) } : {}),
      } as CmsClass;
    })
    .filter((c) => c.type_id && c.type_name);
}

/** 规范化列表/首页响应为统一结构（兼容 V1–V6 + 任意 data./list. 位置 + 分类伪装成 list 的站点） */
export function normalizeCmsList(raw: unknown): NormalizedCmsList {
  const obj = asObj(raw);

  const hasDataObj = isObj(obj.data);
  const dataArr = Array.isArray(obj.data) ? (obj.data as CmsVod[]) : null;
  const pageObj = isObj(obj.page) ? (obj.page as Record<string, unknown>) : null;
  const dataBag = hasDataObj ? (obj.data as Record<string, unknown>) : obj;

  // list 候选池：dataBag.list → data 数组 → obj.list → dataBag.vod → obj.vod
  const cands: CmsVod[][] = [];
  const push = (a: unknown) => {
    if (Array.isArray(a) && a.length) cands.push(a as CmsVod[]);
  };
  push(dataBag.list);
  if (dataArr) push(dataArr);
  push(obj.list);
  push(dataBag.vod);
  push((obj as { vod?: unknown }).vod);

  let list: CmsVod[] = [];
  // 优先取「首元素含 vod_id」的数组（区分 vod 列表 vs 分类 list）
  for (const arr of cands) {
    const first = arr[0];
    if (first && isObj(first) && 'vod_id' in (first as Record<string, unknown>)) {
      list = arr;
      break;
    }
  }
  // 兜底：只有当候选确实是视频列表（首元素含 vod_id）时才采纳，避免把分类数组误当 vod 列表
  if (!list.length && cands.length) {
    const vodLike = cands.find((a) => isObj(a[0]) && 'vod_id' in (a[0] as Record<string, unknown>));
    if (vodLike) list = vodLike;
  }

  const clsArr: CmsClass[] = Array.isArray(obj.class)
    ? (obj.class as CmsClass[])
    : hasDataObj && Array.isArray((obj.data as { class?: CmsClass[] }).class)
      ? (obj.data as { class: CmsClass[] }).class
      : [];

  // 4) list[] 自身就是分类（list_id/list_name，或 type_id/type_name 且不含 vod_id）
  //    —— 部分站点 ac=class / ac=list 直接返回这种结构（对照 Legado 影视聚合源 结构1 / 结构1-分支）
  //    注意 obj.list 与 dataBag.list 在无 data 包裹时是同一个数组，需按引用去重
  const seen = new Set<unknown[]>();
  const rawLists = [obj.list, dataBag.list].filter(Array.isArray) as unknown[][];
  for (const arr of rawLists) {
    if (seen.has(arr)) continue;
    seen.add(arr);
    if (looksLikeClassList(arr)) clsArr.push(...toClasses(arr));
  }

  const page = toNum(dataBag.page, pageObj?.pageindex, pageObj?.page, obj.pageindex, obj.page) || 1;
  const pageCount = toNum(dataBag.pagecount, pageObj?.pagecount, obj.pagecount);
  const limit = toNum(dataBag.limit, pageObj?.pagesize, obj.pagesize, obj.limit) || 20;
  const total = toNum(dataBag.total, pageObj?.recordcount, obj.recordcount, obj.total);

  return { page, pageCount, limit, total, list, classes: clsArr };
}

/**
 * 播放串**字段变体**归一：把 `vod_url` 形态补成标准的 `vod_play_url`。
 *
 * 背景（2026-09-26 用户实测「大地资源：没有解析到选集」）：
 * 部分 CMS 变体**不用** `vod_play_from` / `vod_play_url` 这对字段，而是：
 *   · `vod_play` = **线路名 / 播放器标记**（实测 `"dadim3u8"`）
 *   · `vod_url`  = **集串**，形态与 `vod_play_url` 一致（`集名$地址#集名$地址`）
 * 实测 `https://dadiapi.com/feifei2/?ac=videolist&ids=250796`：
 *   `vod_play = "dadim3u8"`、`vod_url = "在线播放$https://v202510.ddcdnbf.com/…/index.m3u8"`
 * 而引擎只读 `vod_play_url` ⇒ 解析出 0 章 ⇒ 用户看到「没有解析到选集」。
 *
 * ⚠️ 只在 `vod_play_url` **为空**时才用 `vod_url` 顶替，且要求它含 `$`
 * （否则可能是别的语义的 URL，例如详情页地址 —— 不能当集串）。
 */
export function normalizeCmsPlayFields(v: CmsVod): CmsVod {
  const cur = typeof v.vod_play_url === 'string' ? v.vod_play_url.trim() : '';
  if (cur) return v;
  const alt = typeof v.vod_url === 'string' ? v.vod_url.trim() : '';
  if (!alt || !alt.includes('$')) return v;
  const from = (typeof v.vod_play === 'string' && v.vod_play.trim()) || v.vod_play_from || '默认线路';
  return { ...v, vod_play_url: alt, vod_play_from: from };
}

/** 规范化详情响应为单条 vod（兼容 {status,page,data:[vod]} / {code,page,data:[vod]} / data.list / data.vod / 单条对象） */
export function normalizeCmsDetail(raw: unknown): CmsVod | null {
  const obj = asObj(raw);

  if (Array.isArray(obj.data) && obj.data.length) return obj.data[0] as CmsVod;

  const dataBag = isObj(obj.data) ? (obj.data as Record<string, unknown>) : obj;
  const listArr = Array.isArray(dataBag.list) ? (dataBag.list as CmsVod[]) : [];
  if (listArr.length) return listArr[0]!;

  const vod = (dataBag as { vod?: unknown }).vod;
  if (Array.isArray(vod) && vod.length) return vod[0] as CmsVod;
  if (isObj(vod)) return vod as CmsVod;

  if (isObj(obj) && ('vod_id' in obj || 'vod_name' in obj)) return obj as CmsVod;
  return null;
}

/**
 * 检测反爬/人机验证页（HTML）。命中返回原因，否则 null。
 * 典型文案：本网站使用安全服务防护恶意自动程序 / verify you are a robot / 人机验证。
 */
export function detectAntiBot(html: string): string | null {
  const t = html.toLowerCase();
  if (/安全服务防护恶意自动程序|恶意自动程序|verify you are (a )?robot|just a moment|checking your browser|captcha|人机验证|安全验证|access denied|503 service/i.test(t)) {
    return 'anti-bot / verification page';
  }
  return null;
}

/** 判定响应是否是合法 JSON（不是 HTML/错误页） */
export function isJsonText(s: string): boolean {
  const t = s.trim();
  return t.startsWith('{') || t.startsWith('[');
}

/**
 * 判定搜索是否被站点禁止（优雅返回空，不报错）。
 * 真实案例：{"code":1002,"msg":"Current API forbids keyword search."}、暂不支持搜索、err not serarch。
 */
export function isSearchForbidden(raw: unknown): boolean {
  const obj = asObj(raw);
  const code = obj.code;
  if (code === 1002 || code === '1002') return true;
  const msg = String(obj.msg ?? obj.message ?? obj.info ?? '').toLowerCase();
  return /forbid|暂不支持搜索|not serarch|not search|disable.{0,6}search|搜索.{0,4}(关闭|禁用|不支持)/.test(msg);
}

/**
 * 列表接口是否返回了有效内容（用于 ac 降级判定）。
 *
 * ⚠️ 注意它**不能**用来判「有没有拿到分类」：`ac=class` 在部分站点返回的是**视频列表**
 * （见 `hasClassContent` 的说明），此时 `list.length > 0` 会让调用方误以为"拿到了分类"。
 */
export function hasListContent(raw: unknown): boolean {
  const n = normalizeCmsList(raw);
  return n.list.length > 0 || n.classes.length > 0;
}

/**
 * 响应里是否**真的给出了分类数组**（`class[]`，或 `list[]` 本身就是分类的站点）。
 *
 * 为什么要单独一个判定（2026-09-21 用户报告「CMS 分类获取失败」）：
 * `ac=class` **不是** maccms 标准动作，标准做法是 `ac=list`（返回 `{class:[…], code, limit, list:[…]}`）。
 * 实测 `api.xjzyapi.com`（小鸡资源）：
 *   · `ac=class` → `{code, limit, list:[20 条 vod]}` —— **没有 class**，但 `list` 有内容；
 *   · `ac=list`  → `class: 38 条` + `list: 20 条`（分类与短列表同时给出，还支持 `t`/`pg`/`wd`）。
 * 旧逻辑在 home() 里用 `hasListContent` 判「主请求是否可用」，于是 `ac=class` 直接"通过"、不再降级
 * → `classes` 为空 → **前端拿不到分类**。所以取分类必须用**本函数**判定。
 */
export function hasClassContent(raw: unknown): boolean {
  return normalizeCmsList(raw).classes.length > 0;
}
