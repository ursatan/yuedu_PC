/**
 * `#635` **站点定制的管理列表 —— 纯逻辑**（设置页用）。
 *
 * ## 为什么「启用/停用」是**本机偏好**而不是写进 `data/site-customize.json`
 * 服务端 `site-customize-store.upsert()` 会把条目**重建**成
 * `{ host, css?, js?, readerMode?, updatedAt }`（见 `apps/server/src/site-customize-store.ts:82-88`），
 * 未知字段一律**不落盘**。也就是说：本轮只改 `apps/web/**` 的前提下，`enabled` 字段
 * 发过去会被服务端静默丢掉 —— 那才是真正会让用户觉得「开关不管用」的坏实现。
 *
 * 所以启用态放在**本机 localStorage**（与阅读偏好 / 播放器连播同一套模式），
 * 由 `site-customize.ts` 的**唯一读出口** `fetchSiteCustomize` 统一过滤：
 * 停用的站点在阅读器 / 内置浏览器里**不注入** CSS/JS，删除才动配置文件。
 * ⚠️ 代价要说清：换浏览器/清缓存后启用态会回到默认「全部启用」。
 *
 * ## 为什么源归属要在这里算
 * 定制按**域名**存，源按 `url` 存 —— 两者之间只有「域名命中」这一条关系。
 * 判据复用 core 的 `siteHostMatches`（与阅读器注入时**同一份**），
 * 避免设置页又写一条自己的域名比较逻辑。
 */
import {
  normalizeSiteHost,
  siteHostMatches,
  type SiteCustomize,
} from '@yuedu/core/site-customize';

/** localStorage 键（带版本后缀：将来换形状时不会读到旧数组） */
export const SITE_CUSTOMIZE_DISABLED_KEY = 'yuedu.site-customize.disabled.v1';

/** 只依赖 Storage 的最小子集（Node 测试环境没有 localStorage ⇒ 统一从这里拿） */
function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // 隐私模式下**读 localStorage 属性本身**就可能抛
    return null;
  }
}

/**
 * 读停用域名清单。
 *
 * `localStorage` 的值属于**外部输入**（手改 / 旧版本残留）⇒ 非法 JSON、非数组、
 * 非法域名一律丢弃，**不抛错**（设置页不能因为一条脏数据整页崩）。
 */
export function readDisabledHosts(): string[] {
  const raw = storage()?.getItem(SITE_CUSTOMIZE_DISABLED_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const it of v) {
      const h = normalizeSiteHost(it);
      if (h && !out.includes(h)) out.push(h);
    }
    return out;
  } catch {
    return [];
  }
}

/** 某站点是否启用（缺省 = 启用；`normalizeSiteHost` 认不出的输入同样按启用处理） */
export function isSiteCustomizeEnabled(host: string): boolean {
  const h = normalizeSiteHost(host);
  if (!h) return true;
  return !readDisabledHosts().includes(h);
}

/**
 * 写启用态。返回**落盘后的完整清单**（调用方据此刷新界面，不必再读一次）。
 *
 * 写盘失败（隐私模式 / 配额满）不得抛出：本次会话仍以返回值生效，
 * 与播放器连播开关的同一条纪律（见 `tests/player-autonext-689.test.ts`）。
 */
export function setSiteCustomizeEnabled(host: string, enabled: boolean): string[] {
  const h = normalizeSiteHost(host);
  const cur = readDisabledHosts();
  if (!h) return cur;
  const next = new Set(cur);
  if (enabled) next.delete(h);
  else next.add(h);
  const list = [...next].sort();
  try {
    storage()?.setItem(SITE_CUSTOMIZE_DISABLED_KEY, JSON.stringify(list));
  } catch {
    /* 写盘失败只影响跨会话持久化 */
  }
  return list;
}

/** 删除配置后清掉停用痕迹（否则重新新增同名站点会「看起来默认是关的」） */
export function forgetDisabledHost(host: string): string[] {
  return setSiteCustomizeEnabled(host, true);
}

export interface SiteSourceRef {
  id: string;
  name: string;
}

/**
 * 该定制域名命中的源（列表里显示「站点名 / 源 id」）。
 *
 * `host` 是**定制模式**（裸域名含子域 / `*.` 只含子域），源的 `url` 取主机名后
 * 用 core 的 `siteHostMatches` 比较 —— 与阅读器按 URL 取定制是同一条判据。
 * 源没有 `url`（部分老源）时无法归属，直接跳过（显示「未匹配到源」）。
 */
export function siteSourceRefs(
  host: string,
  sources: ReadonlyArray<{ id: string; name?: string; url?: string }>,
): SiteSourceRef[] {
  const pattern = normalizeSiteHost(host);
  if (!pattern) return [];
  const out: SiteSourceRef[] = [];
  for (const s of sources) {
    const u = String(s?.url ?? '');
    if (!/^https?:\/\//i.test(u)) continue;
    let hostname = '';
    try {
      hostname = new URL(u).hostname.toLowerCase();
    } catch {
      hostname = '';
    }
    if (!hostname || !siteHostMatches(pattern, hostname)) continue;
    out.push({ id: String(s.id), name: String(s.name ?? s.id) });
  }
  return out;
}

/**
 * `updatedAt`（epoch ms）→ 本机时间 `YYYY-MM-DD HH:mm`。
 * 缺失/非法 ⇒ `—`（**不显示 1970**：那会让用户以为配置在上世纪改过）。
 */
export function formatSiteUpdatedAt(ts: unknown): string {
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 列表行里「内容摘要」的一行文字（CSS / JS / 阅读模式） */
export function siteCustomizeSummary(item: SiteCustomize): string {
  const css = typeof item.css === 'string' ? item.css.length : 0;
  const js = typeof item.js === 'string' ? item.js.length : 0;
  const parts: string[] = [];
  parts.push(css ? `CSS ${css} 字符` : '无 CSS');
  parts.push(js ? `JS ${js} 字符` : '无 JS');
  if (item.readerMode === true) parts.push('阅读模式 开');
  return parts.join(' · ');
}
