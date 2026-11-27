/**
 * `#568` **P3 站点定制层 —— 本地配置存储**（`data/site-customize.json`）。
 *
 * 为什么独立文件（不塞 `kv.json` / 不塞源定义）：
 *  · `kv.json` 是**源变量**（脚本 `getVariable` 用），混进去会被源脚本的 key 撞上；
 *  · 源定义要能**干净地导入导出**（用户 2026-10-22 拍板「本地独立配置」）——
 *    定制随源走会导致「导入别人的源把界面样式也带过来」，且源更新会覆盖定制。
 *
 * 写入纪律：**先写临时文件再 rename**。直接覆写时进程被杀会留下半截 JSON ⇒ 下次启动整表丢。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SITE_CUSTOMIZE_LIMITS,
  isSiteCustomizeEmpty,
  matchSiteCustomize,
  normalizeSiteHost,
  type SiteCustomize,
} from '@yuedu/core';

export interface SiteCustomizeStore {
  /** 全量列表（按 host 排序，便于设置页稳定显示） */
  list(): SiteCustomize[];
  /** 命中该 URL 的规则（最具体者胜；无 ⇒ null） */
  match(url: string): SiteCustomize | null;
  /**
   * 新增/覆盖。空内容（无 css/js 且 readerMode≠true）= **删除**（与 UI「清空保存」同语义）。
   * 返回 `{ ok:false, error }` 时调用方回 400 —— 校验在**唯一入口**做，路由不重复判。
   */
  upsert(input: Partial<SiteCustomize>): { ok: true; item: SiteCustomize | null } | { ok: false; error: string };
  remove(host: unknown): boolean;
}

function readJson(file: string): SiteCustomize[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: SiteCustomize[] = [];
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue;
      const host = normalizeSiteHost((it as SiteCustomize).host);
      if (!host) continue;
      out.push({ ...(it as SiteCustomize), host });
    }
    return out;
  } catch {
    // 文件不存在/损坏（损坏时保留原文件供人工修复，下次保存会覆盖）
    return [];
  }
}

export function createSiteCustomizeStore(file: string): SiteCustomizeStore {
  let cache: SiteCustomize[] | null = null;
  const load = (): SiteCustomize[] => {
    if (!cache) cache = readJson(file);
    return cache;
  };
  const persist = (next: SiteCustomize[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    cache = next;
  };

  return {
    list() {
      return [...load()].sort((a, b) => a.host.localeCompare(b.host));
    },
    match(url: string) {
      // 复用 core 的唯一匹配实现（此处不重复写域名逻辑）
      return matchSiteCustomize(load(), url);
    },
    upsert(input) {
      const host = normalizeSiteHost(input?.host);
      if (!host) return { ok: false, error: 'HOST_INVALID' };
      const css = typeof input.css === 'string' ? input.css : '';
      const js = typeof input.js === 'string' ? input.js : '';
      if (css.length > SITE_CUSTOMIZE_LIMITS.css) return { ok: false, error: 'CSS_TOO_LARGE' };
      if (js.length > SITE_CUSTOMIZE_LIMITS.js) return { ok: false, error: 'JS_TOO_LARGE' };
      const item: SiteCustomize = {
        host,
        ...(css.trim() ? { css } : {}),
        ...(js.trim() ? { js } : {}),
        ...(input.readerMode === true ? { readerMode: true } : {}),
        updatedAt: Date.now(),
      };
      const rest = load().filter((x) => x.host !== host);
      if (isSiteCustomizeEmpty(item)) {
        persist(rest);
        return { ok: true, item: null };
      }
      persist([...rest, item]);
      return { ok: true, item };
    },
    remove(host) {
      const h = normalizeSiteHost(host);
      if (!h) return false;
      const cur = load();
      const next = cur.filter((x) => x.host !== h);
      if (next.length === cur.length) return false;
      persist(next);
      return true;
    },
  };
}
