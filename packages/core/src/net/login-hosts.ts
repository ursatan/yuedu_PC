/**
 * 交互式登录窗口的「域名匹配」纯逻辑（可单测；浏览器/CDP 操作在 apps/server/src/browser-login.ts）
 *
 * 为什么需要：登录窗口抓回来的是**整个浏览器**的 cookie，必须筛出属于该源的。
 * 但登录域名常与内容域名不同（`account.qq.com` 登录、`ac.qq.com` 看书，
 * cookie 往往落在 `qq.com`），所以：
 *   · 候选域名 = 登录页 host + 源站 host + 各自的「主域」（末两段）；
 *   · 匹配 = 后缀双向匹配（双向是为了兼容 cookie.domain 比 host 更深的情况）。
 */

export interface HarvestCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

/** 从若干 URL 推出「该抓哪些域名的 cookie」（host + 主域，去重） */
export function harvestHosts(urls: string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls ?? []) {
    const u = String(raw ?? '').trim();
    if (!u) continue;
    let host = '';
    try {
      host = new URL(u.includes('://') ? u : `https://${u}`).hostname.toLowerCase();
    } catch {
      continue;
    }
    const h = host.replace(/^www\./, '');
    // 必须像域名（含点）——避免把 'notaurl' 这种无效值当 host 参与匹配
    if (!h || !h.includes('.')) continue;
    out.add(h);
    const parts = h.split('.');
    // 主域取末两段（对 .co.uk 这类会偏宽 —— 宁可多抓，也不漏掉登录站的 cookie）
    if (parts.length > 2) out.add(parts.slice(-2).join('.'));
  }
  return [...out];
}

/** 域名是否命中候选集合（双向后缀匹配） */
export function hostMatches(domain: string, hosts: string[]): boolean {
  const d = String(domain ?? '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  if (!hosts.length) return true; // 未给候选 → 全要（调用方明确要「全部」时）
  return hosts.some((h) => {
    const x = String(h ?? '').toLowerCase();
    if (!x) return false;
    return x === d || x.endsWith(`.${d}`) || d.endsWith(`.${x}`);
  });
}

/** 从浏览器全部 cookie 里筛出属于该源的（同名后者覆盖前者，对齐 CookieStore 语义） */
export function pickLoginCookies(
  cookies: Array<Record<string, unknown>>,
  hosts: string[],
): { picked: HarvestCookie[]; dropped: number } {
  const byName = new Map<string, HarvestCookie>();
  let dropped = 0;
  for (const c of cookies ?? []) {
    const name = String(c['name'] ?? '');
    if (!name) continue;
    const domain = String(c['domain'] ?? '').replace(/^\./, '').toLowerCase();
    if (!hostMatches(domain, hosts)) {
      dropped++;
      continue;
    }
    byName.set(name, {
      name,
      value: String(c['value'] ?? ''),
      domain,
      path: String(c['path'] ?? '/'),
    });
  }
  return { picked: [...byName.values()], dropped };
}
