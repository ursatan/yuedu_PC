/**
 * `/api/proxy` 的 **Referer 候选表**（抽取成纯函数以便回归锁定 —— 缺陷类BL）。
 *
 * ## 为什么需要「阶梯」而不是一个 Referer
 *
 * 上游防盗链的判据**没有统一约定**，两种相反的真实规则都存在于语料里：
 *
 *   · **认「源站点」**（CDN 图床）：图在 `xi.dzuxta.cn`、站点在 `51acgs.com`，
 *     必须带站点 Referer；带图片自身 origin 一定被拒（2026-09-23 实测，缺陷类…封面全 404）。
 *   · **认「自己」**（媒体直链）：🔊书音M 的音频直链在 `api.aikeu.com`，
 *     `Referer: https://m.shuyinfm.com/` → **403**；`Referer: https://api.aikeu.com/` → **200**。
 *
 * 两种规则都无法先验判定 ⇒ 只能**先试源站点、被拒再试资源自身 origin**。
 * 好在代价可控：图片（多数）第一段就成功，行为与修复前**完全一致**；
 * 只有第一段失败才多一次上游请求。
 *
 * ## 顺序与边界
 * ① 调用方显式 `?r=`、或**源 header 规则**里声明了 Referer → **权威，单次**（不猜、不试）；
 * ② 否则依次「源站点 origin」→「资源自身 origin」，只在 {@link REFERER_RETRY_STATUS}
 *    里的状态码上升级 —— 401/403/404 是防盗链的典型表现；5xx / 超时**不重试**
 *    （那是网络问题，换 Referer 无用，重试只会放大延迟）。
 */

/** 值得换 Referer 重试的上游状态码（防盗链的典型表现） */
export const REFERER_RETRY_STATUS: ReadonlySet<number> = new Set([401, 403, 404]);

/** `https://a.b/c?d` → `https://a.b/`（不可解析 → 空串） */
export function originOf(u: unknown): string {
  try {
    return new URL(String(u)).origin + '/';
  } catch {
    return '';
  }
}

/**
 * 生成 Referer 候选（按序尝试，后一个只在前一个被拒时使用）。
 * 返回值**至少一项**（可能为空串 = 不设 Referer）。
 *
 * ## `#369` **陌生 origin 的 explicit 降级**
 *
 * 壳层给 iframe/embed 发的 `r` = 正文文档地址（`htmlBaseUrl`）。多数情况它就是源站点的
 * 页面（同 origin ⇒ 权威，不降级）；但**引擎经 API 合成正文的源**（如 AGE 动漫：文章
 * link = `api.agedm.io/v2/detail/<id>`）会让 `r` 落在**第三方 API 域**上 —— 解析站不认
 * 这种 Referer（实测：`r=api.agedm.io/...` → 200 但回**首页**；`r=m.agedm.io` → 云播放器）。
 * 且「回首页」是 **200**，不在 {@link REFERER_RETRY_STATUS} 里 ⇒ 阶梯永远不会走到
 * 源站点那一环。故：explicit 的 origin 既不是源站点也不是资源自身时，它就不是
 * 「嵌页面地址」，降到 srcSite 之后当普通候选用（srcSite 先行）。
 * `headerRef`（源作者声明）不参与降级——作者权威，永远单发。
 */
export function refererChain(opts: {
  /** 调用方显式 `?r=` */
  explicit?: string;
  /** 源 header 规则里声明的 Referer */
  headerRef?: string;
  /** 源站点 origin（legado=`bookSourceUrl` / RSS=`sourceUrl`） */
  srcSite?: string;
  /** 资源自身 origin */
  assetOrigin?: string;
}): string[] {
  const explicit = opts.explicit && /^https?:\/\//i.test(opts.explicit) ? opts.explicit : '';
  const headerRef = opts.headerRef ?? '';
  const src = opts.srcSite ?? '';
  const asset = opts.assetOrigin ?? '';
  const foreign =
    !!explicit && !!src &&
    originOf(explicit) !== originOf(src) &&
    (!asset || originOf(explicit) !== originOf(asset));
  if (!foreign) {
    // 原语义：权威来源不给阶梯（源作者/调用方最清楚，猜错反而更难排查）
    const authoritative = explicit || headerRef;
    if (authoritative) return [authoritative];
    const chain = [...new Set([src, asset].filter(Boolean))];
    return chain.length ? chain : [''];
  }
  // `#369`：srcSite 先行，explicit 随后，assetOrigin 兜底（headerRef 若有，最权威，仍置顶）
  const chain = [...new Set([headerRef, src, explicit, asset].filter(Boolean))];
  return chain;
}
