/**
 * `#568` **P3 站点定制 —— 前端接线层**（`/api/site-customize`）。
 *
 * 与 `user-data.ts` 同一纪律：端点 URL / 错误语义只有这一份，组件不直接 fetch。
 * 类型来自 `@yuedu/core/site-customize`（**只 import type** ⇒ 编译期擦除，不进 bundle 的 node 依赖）。
 *
 * 缓存：按 URL 记忆命中结果（一次阅读会话里 `htmlDoc` 会被重算很多次，不能每次都打网络）。
 * 保存/删除后清空该 URL 的缓存，并把变更广播给订阅者（阅读器据此重建 iframe）。
 */
import type { SiteCustomize } from '@yuedu/core/site-customize';
import {
  forgetDisabledHost,
  isSiteCustomizeEnabled as isEnabledPersisted,
  setSiteCustomizeEnabled as persistEnabled,
} from './utils/site-customize-manage';

const ENDPOINT = '/api/site-customize';

export class SiteCustomizeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SiteCustomizeError';
    this.status = status;
  }
}

/** url → 命中规则（`null` = 明确查过且没有）。key 用完整 URL，避免同域不同页误用。 */
const byUrl = new Map<string, SiteCustomize | null>();
/** 订阅：定制变更后要重渲染的地方（阅读器 / 内置浏览器）。 */
const listeners = new Set<() => void>();

export function onSiteCustomizeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者异常不得影响其它 */
    }
  }
}

/** 清缓存（可只清某 URL）。 */
export function invalidateSiteCustomize(url?: string): void {
  if (url === undefined) byUrl.clear();
  else byUrl.delete(url);
  notify();
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** 取某 URL 命中的定制（带内存缓存）。服务端不可达 ⇒ 返回 null（阅读照常，只是不注入）。 */
export async function fetchSiteCustomize(url: string): Promise<SiteCustomize | null> {
  const key = String(url ?? '');
  if (!key) return null;
  if (byUrl.has(key)) return byUrl.get(key) ?? null;
  try {
    const r = await fetch(`${ENDPOINT}?url=${encodeURIComponent(key)}`, { cache: 'no-store' });
    if (!r.ok) throw new SiteCustomizeError(`site-customize ${r.status}`, r.status);
    const j = (await readJson(r)) as { match?: SiteCustomize | null } | null;
    // `#635` 停用的站点**在唯一读出口过滤**：阅读器 / 内置浏览器都不必各自再判一次
    // （判据写两处必然漂移；这里返回 null 与「没配置」完全等价，注入逻辑零改动）。
    const hit = j?.match && isEnabledPersisted(j.match.host) ? j.match : null;
    byUrl.set(key, hit);
    return hit;
  } catch {
    // 服务端未启动/网络失败：本地降级（不缓存，下次再试）
    return null;
  }
}

/**
 * 全量列表（设置/管理界面用）。
 *
 * `#635` **失败必须抛错**：旧实现把网络/HTTP 失败吞成 `[]`，设置页就分不出
 * 「一条都没有」与「服务端没启动」—— 空态与错误态长得一模一样，用户只会以为配置丢了。
 * 现在由调用方（设置页）把错误显示成可重试的错误态。
 */
export async function listSiteCustomize(): Promise<SiteCustomize[]> {
  let r: Response;
  try {
    r = await fetch(ENDPOINT, { cache: 'no-store' });
  } catch (e) {
    throw new SiteCustomizeError(`无法连接服务端（${e instanceof Error ? e.message : String(e)}）`, 0);
  }
  if (!r.ok) throw new SiteCustomizeError(`site-customize ${r.status}`, r.status);
  const j = (await readJson(r)) as { items?: SiteCustomize[] } | null;
  return Array.isArray(j?.items) ? j.items : [];
}

/** 保存（空内容 ⇒ 服务端按删除处理）。成功后清缓存并通知订阅者。 */
export async function saveSiteCustomize(input: Partial<SiteCustomize>): Promise<SiteCustomize | null> {
  const r = await fetch(ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const j = (await readJson(r)) as { item?: SiteCustomize | null; error?: string } | null;
  if (!r.ok) throw new SiteCustomizeError(j?.error || `site-customize ${r.status}`, r.status);
  byUrl.clear();
  notify();
  return j?.item ?? null;
}

/** 删除一条。 */
export async function removeSiteCustomize(host: string): Promise<boolean> {
  try {
    const r = await fetch(`${ENDPOINT}?host=${encodeURIComponent(host)}`, { method: 'DELETE' });
    const j = (await readJson(r)) as { ok?: boolean } | null;
    byUrl.clear();
    // `#635` 配置已不存在 ⇒ 停用痕迹一并清掉：否则之后重新新增同名站点会「看起来默认是关的」
    if (j?.ok === true) forgetDisabledHost(host);
    notify();
    return j?.ok === true;
  } catch {
    return false;
  }
}

/**
 * `#635` 读该站点的启用态（本机偏好，见 `utils/site-customize-manage.ts` 模块头）。
 * 设置页用它渲染开关；实际注入路径由 `fetchSiteCustomize` 统一过滤。
 */
export const isSiteCustomizeEnabled = isEnabledPersisted;

/**
 * `#635` 切换启用态。落盘后清缓存并广播，让阅读器/内置浏览器按新状态重建。
 * 返回落盘后的停用清单（设置页可据此刷新所有行的开关，无需各自再读 localStorage）。
 */
export function setSiteCustomizeEnabled(host: string, enabled: boolean): string[] {
  const list = persistEnabled(host, enabled);
  byUrl.clear();
  notify();
  return list;
}
