/**
 * 视频**播放浮窗**状态（影视 + Legado 视频源共用）。
 *
 * ## 为什么需要它（2026-09-25 用户要求）
 *
 * 用户要「点内容 → 浮窗详情 → 点播放 → **浮窗播放页**」，而不是整页跳转。同时还有两类
 * 视频内容需要同一套播放界面：
 *   · **CMS/影视源**：直链要经 `play` 动作解析（选集的 payload 里带 `raw`/`from`）；
 *   · **Legado 视频类源**（含 `bookSourceType=0` 但正文是 m3u8 的那种）：直链要经
 *     `content` 动作解析（章节 payload）。
 * 两者**只有「怎么拿直链」不同**，播放器/选集/上下集/观影历史完全一样 ⇒ 用一个 store +
 * 一个组件（`components/PlayerOverlay.vue`）收口，用 `mode` 区分解析方式。
 *
 * ## 为什么要「序号闸门」
 * 与 `stores/audio.ts` 同因：解析直链是网络操作（数百 ms~数秒），期间用户连点两集 /
 * 切线路会并发进来，后一次的结果可能先返回、把 UI 写成错的剧集。`seq` 保证只有最新一次生效。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { runAction, resolveMediaPage } from '../api';
// `#394` 直链判据走 core 唯一实现（窄子路径，同 html-shell 的 bundle 纪律）
import { MEDIA_EXT_RE } from '@yuedu/core/media-shape';
// `#433` 播放 API 边界的「播放器页包直链」解包 + 格式推断（与引擎共用 core 唯一实现）
import { inferPlayFormat, unwrapPlayerUrl } from '@yuedu/core/media-extract';
import { useReaderStore } from './reader';

/** 一集 / 一章 */
export interface PlayItem {
  title: string;
  payload: unknown;
}

/**
 * 解析方式：
 *  · `play`    → CMS/影视源：`runAction(sid,'play',{id, extra:{playRaw, from}})`
 *  · `content` → Legado 源：`runAction(sid,'content',{id})` 取 `media`
 *  · `direct`  → `#352` 嗅探：直链已在手上（阅读正文的 `chapter.media`），**不再解析**
 *    （`openDirect` 进入；`items` 恒空 ⇒ 选集/上下集/刷新全部禁用，只有播放与关闭）。
 *    `#376` 扩展：LIVE 嗅探（页内观察桥）可以带上 `items`（页内切过的每条直链都在），
 *    `resolve` 对 direct 的取链逻辑 = 从 `payload.url` 直取 ⇒ 选集/上下集照常可用。
 */
export type PlayerMode = 'play' | 'content' | 'direct';

export interface PlayerSession {
  mode: PlayerMode;
  sourceId: string;
  /** 影片 / 书籍标题 */
  title: string;
  /** 副标题（线路名等） */
  subtitle?: string;
  cover?: string;
  items: PlayItem[];
  index: number;
  /** 整部影片的 payload（写观影历史用；`content` 模式可为空） */
  vodPayload?: unknown;
}

interface Resolved {
  url: string;
  format?: string;
  alternatives?: string[];
  /** 需要走服务端代理时透传（浏览器设不了 Referer） */
  referer?: string;
}

export const usePlayerStore = defineStore('player', () => {
  const session = ref<PlayerSession | null>(null);
  const open = ref(false);
  const listOpen = ref(false);
  const loading = ref(false);
  const err = ref('');
  const url = ref('');
  const format = ref<string | undefined>(undefined);
  const alternatives = ref<string[] | undefined>(undefined);
  const referer = ref<string | undefined>(undefined);

  /**
   * `#689` **自动连播**（本集播完自动切下一集，用户要求放进选集列表标题栏的滑块）。
   *
   * 默认开：短剧/影视连看是主场景，关掉比开着更烦。
   * 持久化到 localStorage —— 这是一条**跨会话的观看偏好**，每次重开都要重新拨一次会很恼人；
   * key 与 `stores/audio.ts` 的 `yuedu-audio-*` 同一命名法（`yuedu-player-*`）。
   */
  const AUTO_NEXT_KEY = 'yuedu-player-autonext';
  /**
   * 读偏好：**只认明确的「关」**（`0` / `false`），其余一律按开。
   *
   * `localStorage` 的值是外部输入（手改、旧版本、别的项目写脏同一个键），
   * 这里不能写成 `v === '1'` —— 那样一个 `''` 或 `'true'` 就会被当成「关」，
   * 用户会觉得「我明明开着，怎么不连播了」。宁可偏向默认值。
   */
  function readAutoNext(): boolean {
    try {
      const v = localStorage.getItem(AUTO_NEXT_KEY);
      if (v === '0' || v === 'false') return false;
      return true;
    } catch {
      return true; // 隐私模式 / 存储被禁：按默认开，不影响播放
    }
  }
  const autoNext = ref(readAutoNext());
  function setAutoNext(v: boolean): void {
    autoNext.value = v;
    try {
      localStorage.setItem(AUTO_NEXT_KEY, v ? '1' : '0');
    } catch {
      /* 存不了就只在本次会话生效 */
    }
  }

  const cur = computed<PlayItem | null>(() => session.value?.items[session.value.index] ?? null);
  const total = computed(() => session.value?.items.length ?? 0);
  const hasPrev = computed(() => (session.value?.index ?? -1) > 0);
  const hasNext = computed(() => {
    const s = session.value;
    return !!s && s.index >= 0 && s.index < s.items.length - 1;
  });

  let seq = 0;

  /**
   * `#394` **解析云二级解析**：选集地址不是直链扩展名（如 AGE 的
   * `jx…:8443/m3u8/?url=…` —— 路径带 `/m3u8/` 骗过「像媒体」判据的解析页）时，
   * 先打 `/api/media-resolve` 把它换成真直链，再交给播放器。
   * 失败是**业务结果**（服务端恒 200），把原因抛给 playAt 的 err 通道。
   */
  async function resolveParsePage(u: string): Promise<Resolved> {
    const r = await resolveMediaPage(u);
    if (!r.ok || !r.url) {
      throw new Error(`解析页取直链失败（${r.reason || 'UNKNOWN'}）`);
    }
    return {
      url: r.url,
      ...(r.format ? { format: r.format } : {}),
      ...(r.alternatives?.length ? { alternatives: r.alternatives } : {}),
      ...(r.headers?.['Referer'] ? { referer: r.headers['Referer'] } : {}),
    };
  }

  /** 解析某一集的直链（三种模式在此分流） */
  async function resolve(i: number): Promise<Resolved> {
    const s = session.value;
    const item = s?.items[i];
    if (!s || !item) throw new Error('没有选集');
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    // `#376` direct：直链在 `payload.url`（openDirect 的 items 组装形态），零网络直取
    if (s.mode === 'direct') {
      const u = String(payload['url'] ?? '');
      if (!u) throw new Error('该选集没有直链');
      // `#394` 直链扩展名 ⇒ 原样（零网络）；否则按解析页二级解析（结果回写 payload，同集不再二次解析）
      if (!MEDIA_EXT_RE.test(u)) {
        const r = await resolveParsePage(u);
        payload['url'] = r.url;
        if (r.format) payload['format'] = r.format;
        return r;
      }
      return { url: u, ...(payload['format'] ? { format: String(payload['format']) } : {}) };
    }
    if (s.mode === 'play') {
      const r = (await runAction(s.sourceId, 'play', {
        id: JSON.stringify(item.payload ?? {}),
        extra: { playRaw: String(payload['raw'] ?? ''), from: String(payload['from'] ?? '') },
      })) as { url?: string; format?: string; alternatives?: string[]; headers?: Record<string, string> } | null;
      if (!r?.url) throw new Error('play 未返回直链');
      return {
        url: r.url,
        ...(r.format ? { format: r.format } : {}),
        ...(r.alternatives?.length ? { alternatives: r.alternatives } : {}),
        ...(r.headers?.['Referer'] ? { referer: r.headers['Referer'] } : {}),
      };
    }
    const r = (await runAction(s.sourceId, 'content', { id: JSON.stringify(item.payload ?? {}) })) as
      | { media?: { url?: string; format?: string; alternatives?: string[]; headers?: Record<string, string> }; paragraphs?: string[] }
      | null;
    const m = r?.media;
    if (!m?.url) throw new Error('该章节没有媒体直链');
    return {
      url: m.url,
      ...(m.format ? { format: m.format } : {}),
      ...(m.alternatives?.length ? { alternatives: m.alternatives } : {}),
      ...(m.headers?.['Referer'] ? { referer: m.headers['Referer'] } : {}),
    };
  }

  /** 播放第 i 集（含观影历史：仅 `play` 模式的影视条目记） */
  async function playAt(i: number): Promise<void> {
    const s = session.value;
    if (!s) return;
    const idx = Math.max(0, Math.min(s.items.length - 1, i));
    const my = ++seq;
    s.index = idx;
    loading.value = true;
    err.value = '';
    // 换集先清空旧地址：不清的话播放器会短暂显示上一集（且旧 URL 可能已过期）
    url.value = '';
    alternatives.value = undefined;
    try {
      const r = await resolve(idx);
      if (my !== seq) return; // 已被更新的请求取代（用户连点）
      url.value = r.url;
      format.value = r.format;
      alternatives.value = r.alternatives;
      referer.value = r.referer;
      if (s.mode === 'play') {
        useReaderStore().recordWatch(s.sourceId, s.vodPayload ?? {}, s.title, s.cover, {
          title: s.items[idx]?.title ?? '',
          payload: s.items[idx]?.payload,
        });
      }
    } catch (e) {
      if (my !== seq) return;
      err.value = '播放失败：' + String(e instanceof Error ? e.message : e).slice(0, 120);
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  /** 打开播放浮窗并从第 index 集开始 */
  function openSession(s: Omit<PlayerSession, 'index'> & { index?: number }): void {
    const idx = Math.max(0, s.index ?? 0);
    session.value = { ...s, index: idx };
    open.value = true;
    listOpen.value = false;
    url.value = '';
    format.value = undefined;
    alternatives.value = undefined;
    referer.value = undefined;
    if (s.items.length) void playAt(idx);
    else err.value = '该源没有可播放的选集';
  }

  /**
   * `#352` **嗅探播放**：直链已在手上（阅读正文 `chapter.media`），直接开播。
   *
   * 与 `openSession` 的区别：不解析（`playAt` 一次都不跑）⇒ 打开的是**独立浮窗**
   * （盖在阅读浮层上）⇒ 关闭即回原页面，正文与阅读位置分毫不动。
   *
   * `#376` items 扩展：LIVE 嗅探（页内观察桥，ReaderOverlay `liveSniff`）手里有**一组**
   * 页内实际挂载过的直链（页内切过的集都记下）⇒ 传 `items` + `index` 进来，
   * direct 会话就有选集列表（PlayerOverlay 按 `items.length` 渲染选集/上下集，
   * 点选集走 `playAt` → `resolve` 的 direct 分支直取，无网络）。不传 = 旧形态
   * （items 空、选集全禁）。
   */
  function openDirect(s: {
    title: string;
    subtitle?: string;
    url: string;
    format?: string;
    alternatives?: string[];
    referer?: string;
    /**
     * `#422` **来源源 id**（用户报「嗅探没有带 header」）。
     *
     * 嗅探会话此前把 `sourceId` 写死成 `''` ⇒ `MediaPlayer` 经 `imgSrc({sourceId:''})` 打
     * `/api/proxy` 时**不带 `sid`** ⇒ 服务端 `sourceProxyHeaders(sid)` 拿不到源 ⇒
     * Referer/User-Agent/Cookie **一个都不注入** ⇒ 防盗链站点直接 403（症状：
     * 「正文内能播、嗅探播不了」——正文 iframe 的 NET 桥是带 sid 的，见 `html-shell.ts`）。
     * 调用方（读者浮层的嗅探入口）传当前源的 id 即可。
     */
    sourceId?: string;
    items?: { title?: string; url: string; format?: string }[];
    index?: number;
  }): void {
    if (!s.url) return;
    seq += 1; // 作废可能在途的解析（若有）
    const items: PlayItem[] = (s.items ?? []).map((it, i) => ({
      title: it.title || String(i + 1),
      payload: { url: it.url, ...(it.format ? { format: it.format } : {}) },
    }));
    session.value = {
      mode: 'direct',
      sourceId: s.sourceId ?? '',
      title: s.title,
      ...(s.subtitle ? { subtitle: s.subtitle } : {}),
      items,
      index: Math.max(0, Math.min(items.length - 1, s.index ?? 0)),
    };
    open.value = true;
    listOpen.value = false;
    loading.value = false;
    err.value = '';
    url.value = s.url;
    format.value = s.format;
    alternatives.value = s.alternatives;
    referer.value = s.referer;
    /**
     * `#433` **播放 API 边界统一解包**「播放器页包直链」。
     *
     * 缺陷（91视频实测）：正文页脚本写的是**播放器页**地址
     * `https://ha2.dd.frcfwb.cn/t2player.html?url=https://ehapp2.dd.frcfwb.cn/cshort/xxx.m3u8`，
     * 真 m3u8 在 `?url=` 里。而下面那道 `MEDIA_EXT_RE.test(s.url)` **只看整串是否含 `.m3u8`**
     * （query 里也算，这是麻豆那种 `/api/v1/m3u8/proxy?path=x.m3u8` 的需要）⇒ 播放器页被
     * 误判成「已是直链」⇒ 跳过二级解析、直接喂给 hls.js ⇒ 拿到 HTML ⇒ `manifestParsingError`。
     * 解包与引擎共用 core 的唯一实现（`@yuedu/core/media-extract` 的 `unwrapPlayerUrl`，
     * 只在入口自身是网页扩展名时才解）⇒ 解得出就用真直链，解不出保持原样走下面的二级解析。
     */
    const unwrapped = unwrapPlayerUrl(s.url);
    if (unwrapped) {
      url.value = unwrapped;
      format.value = inferPlayFormat(unwrapped);
    }
    /**
     * `#394` 初始地址不是直链扩展名（解析页，如 AGE 的 jx 链接）⇒ 后台二级解析，
     * 解析完换上真直链。seq 已在上面 +1 ⇒ 用当前值做竞态标记：期间用户点选集
     * （playAt 再 +1）或关窗都让这次回填作废。
     */
    if (!unwrapped && !MEDIA_EXT_RE.test(s.url)) {
      const my = seq;
      loading.value = true;
      resolveParsePage(s.url)
        .then((r) => {
          if (my !== seq || !open.value) return;
          url.value = r.url;
          if (r.format) format.value = r.format;
          if (r.alternatives?.length) alternatives.value = r.alternatives;
          if (r.referer) referer.value = r.referer;
        })
        .catch((e) => {
          if (my !== seq || !open.value) return;
          err.value = '播放失败：' + String(e instanceof Error ? e.message : e).slice(0, 120);
        })
        .finally(() => {
          if (my === seq) loading.value = false;
        });
    }
  }

  /**
   * `#376` **页内切集跟随**：direct 会话开着时，页内观察桥报到的新直链直接换上
   * （不重解析、不动选集列表；index 对齐到同地址项）。用户在 iframe 页内点了另一集
   * ⇒ 播放浮窗跟着换 —— 「页内切集不跟随」的另一半。
   */
  function followDirect(next: string, fmt?: string): void {
    const s = session.value;
    if (!s || s.mode !== 'direct' || !open.value) return;
    if (!next || next === url.value) return;
    const idx = s.items.findIndex((it) => (it.payload as { url?: string })?.url === next);
    if (idx >= 0) s.index = idx;
    seq += 1;
    const my = seq;
    loading.value = false;
    err.value = '';
    // `#394` 桥报的也可能是解析页地址（AGE 的 iframe src 就是 jx 链接）⇒ 同 openDirect 的二级解析
    if (MEDIA_EXT_RE.test(next)) {
      url.value = next;
      format.value = fmt;
      return;
    }
    loading.value = true;
    resolveParsePage(next)
      .then((r) => {
        if (my !== seq || !open.value) return;
        url.value = r.url;
        format.value = fmt ?? r.format;
      })
      .catch((e) => {
        if (my !== seq || !open.value) return;
        err.value = '播放失败：' + String(e instanceof Error ? e.message : e).slice(0, 120);
      })
      .finally(() => {
        if (my === seq) loading.value = false;
      });
  }

  /** 关闭 = 彻底退出（断开媒体源由播放器组件的卸载负责；这里清状态避免下次打开闪旧数据） */
  function close(): void {
    seq += 1;
    open.value = false;
    session.value = null;
    listOpen.value = false;
    url.value = '';
    format.value = undefined;
    alternatives.value = undefined;
    referer.value = undefined;
    err.value = '';
    loading.value = false;
  }

  function next(): void {
    if (hasNext.value) void playAt((session.value?.index ?? 0) + 1);
  }
  function prev(): void {
    if (hasPrev.value) void playAt((session.value?.index ?? 0) - 1);
  }
  /** 播放器报错时让上层显示（并允许用户换线路） */
  function setError(msg: string): void {
    err.value = msg;
  }

  return {
    session, open, listOpen, loading, err, url, format, alternatives, referer,
    autoNext, setAutoNext,
    cur, total, hasPrev, hasNext,
    openSession, openDirect, followDirect, close, playAt, next, prev, setError,
  };
});
