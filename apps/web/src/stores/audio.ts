/**
 * 音频播放器全局状态（浮窗常驻播放的**唯一真源**）。
 *
 * 为什么必须放在 store、而不是某个组件的 `<audio>`：
 *   用户要求「迷你浮窗常驻」= 切路由（书院 → 书架 → 设置）时**不能停播**。
 *   若 `<audio>` 挂在某个视图/浮层组件里，组件一卸载元素就被回收 ⇒ 播放中断。
 *   因此这里持有**全应用唯一一个 `Audio` 实例**（pinia setup store 的 setup 只跑一次），
 *   组件只是它的「遥控器」。
 *
 * 与阅读链（`stores/reader.ts`）的关系：
 *   音频类书源（`bookSourceType=1` ⇒ detail.kind==='audio'）走的是**同一条**
 *   search→detail→toc→content 链路，只是 content 产出的不是文字而是媒体直链。
 *   所以「目录 → 播放列表」直接复用 detail 的 chapters；播放时按章节 payload
 *   调 `content` 取 `media.url`（引擎契约字段，见 UnifiedContent.media）。
 *
 * 媒体地址**一律走服务端代理**（`utils/img.ts` 的 imgSrc）：音频源几乎都带 Referer/UA
 * 防盗链，浏览器直连必 403；服务端 `/api/proxy` 已支持 Range 透传（拖进度必需）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import Hls from 'hls.js';
import { runAction } from '../api';
import { imgSrc } from '../utils/img';
import {
  audioCacheUrl,
  cancelAudioDownload,
  emitAudioCacheChanged,
  fetchAudioCacheStatus,
  fetchAudioDownloads,
  prefetchAudioChapter,
  startAudioDownload,
  type AudioDownloadJob,
} from '../utils/audio-cache';
import { itemKey } from './reader';
import { toast } from '../toast';

export interface AudioChapter {
  title: string;
  payload: unknown;
  isVolume?: boolean;
}

interface ProgEntry {
  index: number;
  chapterUrl?: string;
  position: number;
  title?: string;
  updatedAt: number;
}
type ProgMap = Record<string, ProgEntry>;

const PROGRESS_KEY = 'yuedu-audio-progress';
const VOLUME_KEY = 'yuedu-audio-volume';
const RATE_KEY = 'yuedu-audio-rate';
/** 浮窗位置（跨会话记忆） */
const POS_KEY = 'yuedu-audio-pos';
/** 置顶开关（跨会话记忆） */
const ONTOP_KEY = 'yuedu-audio-ontop';
/** 进度表最多保留多少本（超出按 updatedAt 淘汰，防止 localStorage 无限增长） */
const PROG_MAX = 200;
/** 进度落盘节流：`timeupdate` 每秒数次，不能每次都写 localStorage */
const SAVE_THROTTLE_MS = 5000;
/**
 * 媒体直链缓存的有效期（毫秒）。
 *
 * ⚠️ **为什么要 TTL**（用户报 `no supported source` 的头号嫌疑）：
 * 这类直链**普遍带时效签名**。实测 🔊Hi歌曲音乐网 同一首歌两次解析出的地址不同：
 *   `…/dbf9fdf227915b14a77504cfa8dfafeb/6ab63191/resource/…/xxx.mp3`
 *   `…/5f1bfb50acd5f7a649ea40aef33b1183/6ab6321d/resource/…/xxx.mp3`
 * 路径里那两段就是**签名与过期时间**。缓存住一个过期签名，播放器只会得到 403/HTML，
 * 报出来就是「不支持该媒体源」。所以缓存必须**过期 + 失败即失效重解析**（见 `playAt` 的两轮）。
 */
const URL_TTL_MS = 5 * 60_000;

/** 声音文件扩展名（正文段落里出现这种裸链时也认） */
const AUDIO_EXT_RE = /^https?:\/\/[^\s"'<>]+\.(m3u8|mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4)(\?|#|$)/i;

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '');
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export const useAudioStore = defineStore('audio', () => {
  /**
   * ---- 全应用唯一媒体元素 ----
   *
   * ⚠️ **用 `<video>` 而不是 `new Audio()`**（2026-09-25 修，用户报「音乐播放失败 /
   * `The element has no supported sources`」时发现的类级问题）：
   *  ① 两者都是 `HTMLMediaElement`，`<video>` 播**纯音频**文件（mp3/m4a）行为完全一致
   *     —— 没有视频轨道就不渲染任何画面（且它本来就 `display:none`），
   *     事件、`Media Session`、音量、倍速、`textTracks` 全部相同；
   *  ② 但 **`<audio>` 放不了 HLS（`.m3u8`）** —— Chromium 没有原生 HLS，
   *     要靠 hls.js，而 hls.js 的 `attachMedia()` 接受的是 `HTMLMediaElement`
   *     （业界标准用法就是 `<video>`）。用 `<audio>` 遇到 m3u8 只会报
   *     `no supported source`，**错误信息完全看不出是格式问题**。
   *     语料实测：14 个音频源目前全返回 mp3/m4a，但「播放页返回 m3u8」是常见形态
   *     （同一批语料里有 10 个源带 m3u8），不该留这个洞。
   */
  const el: HTMLVideoElement = document.createElement('video');
  el.preload = 'metadata';
  el.playsInline = true;
  /** m3u8 时挂载的 hls.js 实例（非 HLS 流 / 已停止时为 null） */
  let hls: Hls | null = null;
  /**
   * **请求序号** —— 播放请求的并发闸门。
   *
   * 为什么必需（用户报的 `The play() request was interrupted by a new load request.`）：
   * 一次 `playAt()` 要经历「解析地址（网络）→ 设 src → `await play()`」，耗时数百毫秒到数秒。
   * 这期间用户**再点一次**（或目录点击与播放器自身的改道 watch 同时触发）就会并发进来，
   * 后来的 `el.src = …` 会把前一个还在 pending 的 `play()` 打断 —— 浏览器抛 AbortError，
   * UI 上就成了一条看不懂的「播放失败」。
   * 有了序号：**只有最新一次请求能改元素状态与写错误**，被取代的静默退出（那不是失败）。
   */
  let reqSeq = 0;
  /**
   * 把媒体元素挂进文档（`display:none`）。
   *
   * 为什么：WebKit 系（Safari / Electron 的某些版本）对**未插入文档**的 `Audio`
   * 实例存在播放限制（`play()` 静默失败）；挂载后行为与 `<audio>` 标签一致。
   * 挂在 `document.body` 上而不是组件里 —— 组件可能被路由卸载，元素不能跟着走
   * （见文件头「浮窗常驻」的说明）。
   */
  function ensureMounted(): void {
    if (typeof document === 'undefined' || el.isConnected) return;
    try {
      el.style.display = 'none';
      document.body.appendChild(el);
    } catch {
      /* 极端时序（body 尚未就绪）→ 下次调用再试 */
    }
  }

  const book = ref<{ sourceId: string; key: string; bookUrl?: string; title: string; cover?: string; author?: string } | null>(null);
  const tracks = ref<AudioChapter[]>([]);
  const index = ref(-1);
  const playing = ref(false);
  const position = ref(0);
  const duration = ref(0);
  const mediaUrl = ref('');
  const loading = ref(false);
  const err = ref('');
  /** 浮窗收起为迷你条 */
  const minimized = ref(false);
  /** 浮窗整体隐藏（关闭后不再显示；`book` 仍在，进度保留） */
  const closed = ref(false);
  const listOpen = ref(false);
  const volume = ref(Math.min(1, Math.max(0, Number(localStorage.getItem(VOLUME_KEY) ?? 0.9) || 0.9)));
  const rate = ref(Number(localStorage.getItem(RATE_KEY) ?? 1) || 1);
  /** 定时关闭到期时间戳（0 = 未设置）与剩余秒数（仅供显示） */
  const sleepEndAt = ref(0);
  const sleepLeft = ref(0);
  /**
   * 浮窗位置（视窗左上角坐标，单位 px）。`null` = 用默认位（右下角）。
   * 放 store 而不是组件：组件会随路由卸载，位置却要跨路由保留。
   */
  const floatPos = ref<{ x: number; y: number } | null>(readJson<{ x: number; y: number } | null>(POS_KEY, null));
  /** 贴边隐藏状态：拖到左/右边缘后自动半隐，鼠标移上去再展开 */
  const edgeDock = ref<'left' | 'right' | null>(null);
  /** 是否置顶（用户可切换；`false` 时降到普通层级，让阅读浮层盖住它） */
  const onTop = ref(readJson<boolean>(ONTOP_KEY, true));

  const visible = computed(() => !!book.value && !closed.value);
  const cur = computed(() => tracks.value[index.value] ?? null);
  const hasPrev = computed(() => index.value > 0);
  const hasNext = computed(() => index.value >= 0 && index.value < tracks.value.length - 1);
  const progressPct = computed(() => (duration.value > 0 ? (position.value / duration.value) * 100 : 0));

  // ---- 音频缓存（P1：服务端独立目录，文件存在即已缓存；P1.5：手动离线任务）----
  /**
   * 当前书里**确实已落盘**的章节标识（`chapterUrl`，缺失时回落标题）。
   * 用 `ref` 包一层是因为播放列表要按它渲染「已缓存」（P1 时只有云朵用，不渲染）。
   */
  const cachedChapters = ref<Set<string>>(new Set());
  /** 本会话已触发过后台落盘的章节（避免同章反复请求；服务端另有去重） */
  const prefetched = new Set<string>();
  /** 章节的缓存标识（与服务端 `status` 的返回口径一致） */
  function cacheIdOf(ch: AudioChapter): string {
    const p = (ch.payload ?? {}) as { chapterUrl?: string; url?: string };
    return String(p.chapterUrl || p.url || ch.title || '');
  }
  /** 拉一次当前书的缓存状态（打开书时；目录云朵与播放共用同一份判定） */
  async function refreshAudioCache(): Promise<void> {
    const b = book.value;
    if (!b) return;
    const chapters = tracks.value
      .map((t) => ({ chapterUrl: cacheIdOf(t), title: t.title }))
      .filter((c) => c.chapterUrl || c.title);
    const st = await fetchAudioCacheStatus(b.bookUrl ?? b.key, chapters);
    // 期间换书 ⇒ 结果作废（否则会把上一本的缓存状态套到新书）
    if (book.value?.key !== b.key) return;
    cachedChapters.value = new Set(st.cached);
  }
  /** 首播/播放中触发后台整章落盘（策略 A：不 await，播放不等下载） */
  function maybePrefetch(t: AudioChapter): void {
    const b = book.value;
    const id = cacheIdOf(t);
    if (!b || !id || cachedChapters.value.has(id) || prefetched.has(id)) return;
    prefetched.add(id);
    prefetchAudioChapter({
      sid: b.sourceId,
      bookUrl: b.bookUrl ?? b.key,
      bookTitle: b.title,
      chapterUrl: id,
      chapterTitle: t.title,
      payload: t.payload,
    });
    // 跟着任务轮询：落盘完成后云端/目录云朵要立刻按真实文件消掉
    schedulePoll();
  }

  // ---- P1.5 手动离线（`mode:'manual'`：永不参与配额自动淘汰）----
  /**
   * 离线任务表（键 = 章节缓存标识）。任务本体在服务端内存里：
   * 关掉播放器/切路由后任务继续跑，重新打开列表按 `bookUrl` 拉回来（不会假装下完）。
   */
  const downloadJobs = ref<Record<string, AudioDownloadJob>>({});
  /** 整本下载进行中（按钮文案切换 + 完成后统一刷新云朵） */
  const batchRunning = ref(false);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function bookUrlOf(): string | null {
    const b = book.value;
    return b ? (b.bookUrl ?? b.key) : null;
  }
  function jobOf(ch: AudioChapter): AudioDownloadJob | null {
    return downloadJobs.value[cacheIdOf(ch)] ?? null;
  }
  function isCachedTrack(ch: AudioChapter): boolean {
    return cachedChapters.value.has(cacheIdOf(ch));
  }
  /** 进度百分比（上游没给 `content-length` 时返回 -1 ⇒ UI 显示「下载中」而不是假进度） */
  function downloadPct(j: AudioDownloadJob | null): number {
    if (!j || j.totalBytes <= 0) return -1;
    return Math.min(100, Math.max(0, Math.round((j.bytes / j.totalBytes) * 100)));
  }
  function isActiveJob(j: AudioDownloadJob | null): boolean {
    return !!j && (j.status === 'queued' || j.status === 'running');
  }
  function hasActiveDownloads(): boolean {
    return Object.values(downloadJobs.value).some((j) => j.status === 'queued' || j.status === 'running');
  }

  /** 任务失败原因 → 可读中文（服务端给的是短码/短句，这里只解释最常见几类） */
  function explainJobError(j: AudioDownloadJob | null): string {
    if (!j) return '';
    const e = String(j.error ?? '');
    if (!e) return '未知原因';
    if (e === 'CANCELLED' || e === '已取消') return '已取消';
    if (e === 'QUOTA') return '缓存配额不足（手动内容不计入自动淘汰：清理或调大额度后可重试）';
    if (e === 'TOO_LARGE') return '单章超过缓存单文件上限';
    if (e === 'EMPTY') return '源返回了空文件';
    if (e === 'NO_MEDIA_URL') return '源没有给出可下载的媒体地址';
    if (e === 'IO') return '写盘失败（磁盘空间或权限）';
    if (e.startsWith('UPSTREAM_')) return `源站返回 ${e.slice('UPSTREAM_'.length)}`;
    if (e.startsWith('NOT_MEDIA')) return '源返回的不是音频文件（可能被拦截或需登录）';
    if (e.startsWith('FETCH_FAILED:') || e.startsWith('RESOLVE_FAILED:')) {
      return `请求源站失败：${e.split(':').slice(1).join(':').slice(0, 80)}`;
    }
    return e;
  }

  /** 把服务端任务合并进本地表；**只在状态跃迁时提示**（轮询每 800ms 一次，不能重复弹） */
  function ingestJobs(list: AudioDownloadJob[]): void {
    if (!list.length) return;
    const url = bookUrlOf();
    const next = { ...downloadJobs.value };
    for (const j of list) {
      const k = j.chapterUrl || j.title;
      if (!k) continue;
      // 自动预取（stream）不进「离线到本机」的 UI，但完成后要让云朵消掉（P2 联动）
      if (j.mode !== 'manual') {
        if (j.status === 'done' && !cachedChapters.value.has(k)) {
          cachedChapters.value.add(k);
          if (url) emitAudioCacheChanged(url);
        }
        continue;
      }
      const prev = downloadJobs.value[k];
      const same =
        prev &&
        prev.status === j.status &&
        prev.bytes === j.bytes &&
        prev.totalBytes === j.totalBytes &&
        !!prev.quotaOver === !!j.quotaOver;
      if (same) continue;
      next[k] = j;
      if (prev?.status === j.status) continue;
      if (j.status === 'done') {
        cachedChapters.value.add(k);
        if (j.quotaOver) toast(`「${j.title}」已离线到本机；已超出配额，手动内容不计入自动淘汰`);
        else toast(`「${j.title}」已离线到本机`);
        if (url) emitAudioCacheChanged(url);
      } else if (j.status === 'error') {
        toast(`「${j.title}」离线失败：${explainJobError(j)}`);
      } else if (j.status === 'unsupported') {
        toast(`「${j.title}」流式源不支持离线`);
      }
    }
    downloadJobs.value = next;
  }

  function schedulePoll(): void {
    if (pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollDownloads();
    }, 800);
  }

  /** 轮询当前书的离线任务；还有排队/下载中 ⇒ 继续轮询 */
  async function pollDownloads(): Promise<void> {
    const url = bookUrlOf();
    if (!url) return;
    const list = await fetchAudioDownloads(url);
    if (bookUrlOf() !== url) return; // 换书：结果作废
    ingestJobs(list);
    // 自动预取（stream）也算「还在跑」⇒ 继续轮询，完成后云朵才能及时消掉
    const anyActive = list.some((j) => j.status === 'queued' || j.status === 'running');
    if (anyActive || hasActiveDownloads()) {
      schedulePoll();
      return;
    }
    if (batchRunning.value) {
      batchRunning.value = false;
      toast('整本离线已完成');
      void refreshAudioCache();
      emitAudioCacheChanged(url);
    }
  }
  /** 打开播放列表时调一次：恢复「还在下 / 已下完 / 失败原因」 */
  async function refreshDownloadJobs(): Promise<void> {
    const url = bookUrlOf();
    if (!url) return;
    const list = await fetchAudioDownloads(url);
    if (bookUrlOf() !== url) return;
    ingestJobs(list);
    if (hasActiveDownloads()) schedulePoll();
  }

  /** 手动离线一章（单章入口） */
  async function downloadTrack(i: number): Promise<void> {
    const b = book.value;
    const t = tracks.value[i];
    if (!b || !t) return;
    const id = cacheIdOf(t);
    if (!id) return;
    if (cachedChapters.value.has(id)) {
      toast(`「${t.title}」已缓存，无需重复下载`);
      return;
    }
    const prev = downloadJobs.value[id];
    if (isActiveJob(prev ?? null)) {
      toast(`「${t.title}」正在离线中`);
      return;
    }
    const r = await startAudioDownload({
      sid: b.sourceId,
      bookUrl: b.bookUrl ?? b.key,
      bookTitle: b.title,
      chapterUrl: id,
      chapterTitle: t.title,
      payload: t.payload,
    });
    if (book.value?.key !== b.key) return;
    if (!r.ok) {
      toast(`「${t.title}」离线失败：${r.error || '请求被拒绝'}`);
      return;
    }
    if (r.cached) {
      cachedChapters.value.add(id);
      toast(`「${t.title}」已缓存，无需重复下载`);
      emitAudioCacheChanged(b.bookUrl ?? b.key);
      return;
    }
    if (r.unsupported) {
      toast(`「${t.title}」流式源不支持离线`);
      return;
    }
    downloadJobs.value = {
      ...downloadJobs.value,
      [id]: {
        id: r.jobId ?? id,
        bookUrl: b.bookUrl ?? b.key,
        chapterUrl: id,
        title: t.title,
        mode: 'manual',
        status: 'queued',
        bytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    schedulePoll();
  }

  /** 整本离线：跳过已缓存与已在队列的章，流式源（m3u8）如实计入「不支持」 */
  async function downloadAll(): Promise<void> {
    const b = book.value;
    if (!b || batchRunning.value) return;
    const todo: Array<{ t: AudioChapter; id: string }> = [];
    let cached = 0;
    for (const t of tracks.value) {
      const id = cacheIdOf(t);
      if (!id) continue;
      if (cachedChapters.value.has(id)) {
        cached += 1;
        continue;
      }
      if (isActiveJob(downloadJobs.value[id] ?? null)) continue;
      todo.push({ t, id });
    }
    if (!todo.length) {
      toast(cached ? `本节目录已全部离线（已缓存 ${cached} 章）` : '本节目录没有可离线的章节');
      return;
    }
    batchRunning.value = true;
    let queued = 0;
    let unsupported = 0;
    let failed = 0;
    for (const { t, id } of todo) {
      // 入队途中用户点了「取消整本」⇒ 立刻停手，不再往服务端塞新任务
      if (!batchRunning.value) return;
      const r = await startAudioDownload({
        sid: b.sourceId,
        bookUrl: b.bookUrl ?? b.key,
        bookTitle: b.title,
        chapterUrl: id,
        chapterTitle: t.title,
        payload: t.payload,
      });
      if (book.value?.key !== b.key) {
        batchRunning.value = false;
        return;
      }
      if (r.ok && r.cached) {
        cachedChapters.value.add(id);
        continue;
      }
      if (r.ok && r.unsupported) {
        unsupported += 1;
        continue;
      }
      if (!r.ok) {
        failed += 1;
        continue;
      }
      queued += 1;
      downloadJobs.value = {
        ...downloadJobs.value,
        [id]: {
          id: r.jobId ?? id,
          bookUrl: b.bookUrl ?? b.key,
          chapterUrl: id,
          title: t.title,
          mode: 'manual',
          status: 'queued',
          bytes: 0,
          totalBytes: 0,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }
    const parts = [`已加入离线队列 ${queued} 章`];
    if (cached) parts.push(`跳过已缓存 ${cached} 章`);
    if (unsupported) parts.push(`流式源不支持离线 ${unsupported} 章`);
    if (failed) parts.push(`请求失败 ${failed} 章`);
    toast(parts.join('，'));
    if (!queued) {
      batchRunning.value = false;
      return;
    }
    schedulePoll();
  }

  /** 取消一章（排队中/下载中才有意义；终态是空操作） */
  async function cancelDownload(ch: AudioChapter): Promise<void> {
    const b = book.value;
    const id = cacheIdOf(ch);
    const j = downloadJobs.value[id];
    if (!b || !id || !isActiveJob(j ?? null)) return;
    await cancelAudioDownload({
      bookUrl: b.bookUrl ?? b.key,
      chapterUrl: id,
      chapterTitle: ch.title,
    });
    downloadJobs.value = {
      ...downloadJobs.value,
      [id]: { ...j!, status: 'cancelled', error: '已取消', updatedAt: Date.now() },
    };
  }

  /** 「取消全部」：整本下载的中断口（服务端逐个 abort，落盘用临时文件，不会留半截缓存） */
  async function cancelAllDownloads(): Promise<void> {
    const b = book.value;
    if (!b) return;
    const active = Object.values(downloadJobs.value).filter(
      (j) => j.status === 'queued' || j.status === 'running',
    );
    if (!active.length) {
      batchRunning.value = false;
      return;
    }
    await Promise.all(
      active.map((j) =>
        cancelAudioDownload({ bookUrl: b.bookUrl ?? b.key, chapterUrl: j.chapterUrl, chapterTitle: j.title }),
      ),
    );
    const next = { ...downloadJobs.value };
    for (const j of active) next[j.chapterUrl] = { ...j, status: 'cancelled', error: '已取消', updatedAt: Date.now() };
    downloadJobs.value = next;
    batchRunning.value = false;
    toast(`已取消 ${active.length} 个离线任务`);
  }

  // ---- 进度持久化 ----
  function loadProg(): ProgMap {
    return readJson<ProgMap>(PROGRESS_KEY, {});
  }
  let lastSave = 0;
  function persist(force = false): void {
    const b = book.value;
    if (!b) return;
    if (!force && Date.now() - lastSave < SAVE_THROTTLE_MS) return;
    lastSave = Date.now();
    const m = loadProg();
    const p = (cur.value?.payload ?? {}) as { chapterUrl?: string };
    m[b.key] = {
      index: index.value,
      ...(p.chapterUrl ? { chapterUrl: p.chapterUrl } : {}),
      position: Number.isFinite(el.currentTime) ? el.currentTime : 0,
      ...(cur.value?.title ? { title: cur.value.title } : {}),
      updatedAt: Date.now(),
    };
    const ks = Object.keys(m);
    if (ks.length > PROG_MAX) {
      ks.sort((a, c) => (m[c]!.updatedAt || 0) - (m[a]!.updatedAt || 0));
      for (const k of ks.slice(PROG_MAX)) delete m[k];
    }
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(m));
    } catch {
      /* 配额满：进度丢失不影响播放 */
    }
  }
  /** 读取某本书的续播点（供 UI 显示「上次听到」） */
  function progressOf(sourceId: string, payload: unknown): ProgEntry | null {
    return loadProg()[itemKey(sourceId, payload)] ?? null;
  }

  // ---- 媒体地址解析（按章节 payload 调引擎 content）----
  /**
   * 一次解析的产物：**已过代理**的候选地址（按序尝试）+ 格式 + 防盗链头。
   *
   * 为什么是「候选列表」而不是单个地址：引擎按可信度排序，但排序是**启发式**
   * （标签 → 播放器变量 → 规则字面量 → 裸扩展名 URL），真实播放页上常常同时有
   * 广告位/预告/多线路，**必然有取错的时候**。判定「真放不出来」只有前端能做。
   */
  interface Resolved {
    urls: string[];
    format: string;
    headers?: Record<string, string>;
  }
  /** 缓存：值带时间戳（见 `URL_TTL_MS` 的注释） */
  let urlCache = new Map<string, { at: number; v: Resolved }>();

  /** 章节 payload → 代理后的绝对地址 */
  function toProxy(u: string, sid: string, headers: Record<string, string> | undefined, format: string): string {
    /**
     * **m3u8 一律走代理**（2026-09-25 实测修正）。
     *
     * 先前这里写的是「m3u8 不套代理，避免相对分片地址被解析错」。那条顾虑本身成立
     * （hls.js 相对**列表自身 URL** 解析分片），但结论错了 —— 实测在**页内 fetch**
     * （受同源策略约束的真实环境）：
     *   · m3u8 播放列表**直连被 CORS 拦掉**（`Failed to fetch`）；
     *   · 分片与 AES 密钥直连是 200。
     * 即：播放列表**没有**别的选择，必须过服务端；而「相对地址」的问题由**服务端**
     * 在回传前补成绝对解决（`rewriteHlsPlaylist`），不在前端绕。
     */
    const isHls = format === 'm3u8';
    return imgSrc(u, {
      sourceId: sid,
      ...(headers?.['Referer'] ? { referer: headers['Referer'] } : {}),
    });
  }

  /**
   * 解析一个章节的媒体地址（带缓存）。
   * @param fresh 跳过缓存（播放失败后的第二轮：**换掉过期签名**）
   */
  async function resolveUrls(sid: string, ch: AudioChapter, opts: { fresh?: boolean } = {}): Promise<Resolved> {
    const p = (ch.payload ?? {}) as Record<string, unknown>;
    const ck = `${sid}\u0000${String(p.chapterUrl ?? JSON.stringify(p))}`;
    const hit = urlCache.get(ck);
    if (hit && !opts.fresh && Date.now() - hit.at < URL_TTL_MS) return hit.v;
    const r = (await runAction(sid, 'content', { id: JSON.stringify(p) })) as
      | {
          media?: { url?: string; headers?: Record<string, string>; format?: string; alternatives?: string[] };
          paragraphs?: string[];
        }
      | null;
    const media = r?.media;
    const format = String(media?.format ?? '');
    const raw: string[] = [];
    if (media?.url) raw.push(media.url);
    // 引擎下发的备选（本次新增）—— 主地址失败后按序试
    for (const a of media?.alternatives ?? []) if (a) raw.push(a);
    // 兜底：媒体直链落在正文段落里（引擎 collectMediaCandidates 已尽量归到 media，
    // 这里再兜一层，避免「media 空但 paragraphs 第一段就是 mp3 地址」被漏掉）
    if (!raw.length) {
      const fromPara = (r?.paragraphs ?? [])
        .map((x) => String(x))
        .filter((x) => AUDIO_EXT_RE.test(x));
      raw.push(...fromPara);
    }
    const urls = [...new Set(raw.map((u) => toProxy(u, sid, media?.headers, format)))].filter(Boolean);
    const v: Resolved = { urls, format, ...(media?.headers ? { headers: media.headers } : {}) };
    // 空结果也缓存：避免「同一个坏章节被反复解析」（TTL 到期后自然重试）
    urlCache.set(ck, { at: Date.now(), v });
    return v;
  }

  /** 让某个章节的缓存立即失效（播放失败后调用） */
  function invalidate(sid: string, ch: AudioChapter): void {
    const p = (ch.payload ?? {}) as Record<string, unknown>;
    urlCache.delete(`${sid}\u0000${String(p.chapterUrl ?? JSON.stringify(p))}`);
  }

  // ---- 媒体元素装载 ----
  /** 断开当前媒体源（销毁 hls、清 src 并 `load()` 释放解码器与网络请求） */
  function detach(): void {
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* 销毁失败不影响后续装载 */
      }
      hls = null;
    }
    try {
      el.pause();
      el.removeAttribute('src');
      // `load()` 在无 src 时会把元素重置为 EMPTY：**这是让浏览器释放缓冲与
      // 系统媒体通知的唯一可靠方式**（只 pause 会留下「驻留」）
      el.load();
    } catch {
      /* 极端时序下忽略 */
    }
  }

  /** 媒体错误码 → 人话（浏览器原生 message 是英文且与中文 UI 风格不符） */
  function explainMediaError(err: unknown): string {
    const code = el.error?.code;
    if (code === 1) return '播放被中断（已加载新的地址）';
    if (code === 2) return '网络错误：直链已失效或无法连接';
    if (code === 3) return '解码失败：媒体文件可能已损坏';
    if (code === 4) return '该地址无法播放（格式不支持，或直链已失效/防盗链拦截）';
    const msg = String(err instanceof Error ? err.message : err);
    if (/NotAllowedError/i.test(msg)) return '浏览器拦截了自动播放：请点一下播放按钮';
    if (/AbortError|interrupted by a new load/i.test(msg)) return '播放被新的加载请求中断';
    if (/no supported source|NotSupportedError/i.test(msg)) return '该地址无法播放（格式不支持，或直链已失效）';
    return msg.slice(0, 100) || '播放失败';
  }

  /**
   * 装载一个地址并开始播放（**会先 detach 旧源**）。
   *
   * 先 `detach()` 再设新地址，是消除 `The play() request was interrupted by a
   * new load request` 的关键：旧源的 pending `play()` 被显式结束，而不是被新 src 撞掉。
   */
  async function loadAndPlay(
    u: string,
    format: string,
    startAt: number,
    opt: { sid: string; headers?: Record<string, string> },
  ): Promise<void> {
    detach();
    const isHls = format === 'm3u8' || /\.m3u8(\?|#|$)/i.test(u);
    if (isHls) {
      if (!Hls.isSupported()) throw new Error('当前浏览器不支持 HLS(m3u8) 播放');
      // 源声明了防盗链头时，子请求（分片/密钥）也必须过代理 —— 浏览器设不了 Referer。
      // 未声明时**不代理**：分片数量多、体积大，能直连就直连（与 MediaPlayer 同一判断）。
      const inst = new Hls(
        opt.headers?.['Referer']
          ? {
              xhrSetup: (xhr, url) => {
                if (!/^https?:\/\//i.test(url)) return;
                xhr.open('GET', imgSrc(url, { sourceId: opt.sid, referer: opt.headers?.['Referer'] ?? '' }), true);
              },
            }
          : {},
      );
      hls = inst;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = (): void => {
          settled = true;
          inst.off(Hls.Events.ERROR, onErr);
          inst.off(Hls.Events.MANIFEST_PARSED, onOk);
        };
        const onErr = (_e: unknown, data: { fatal?: boolean; type?: string; details?: string }): void => {
          if (!data?.fatal || settled) return;
          done();
          reject(new Error(`HLS ${String(data.type)}/${String(data.details)}`));
        };
        const onOk = (): void => {
          if (settled) return;
          done();
          resolve();
        };
        inst.on(Hls.Events.ERROR, onErr);
        inst.on(Hls.Events.MANIFEST_PARSED, onOk);
        inst.loadSource(u);
        inst.attachMedia(el);
      });
    } else {
      el.src = u;
    }
    el.playbackRate = rate.value;
    el.volume = volume.value;
    if (startAt > 0) {
      const onMeta = (): void => {
        el.removeEventListener('loadedmetadata', onMeta);
        try {
          el.currentTime = startAt;
        } catch {
          /* seek 越界（续播点超过新文件时长）→ 从头播 */
        }
      };
      el.addEventListener('loadedmetadata', onMeta);
    }
    // 源不支持时 Chromium 会以 NotSupportedError 拒绝 play() ⇒ 被上层捕获、试下一个候选
    await el.play();
  }

  // ---- 播放控制 ----
  /**
   * 播放第 i 章。
   *
   * 三层稳健性（都对应用户实测到的一条错误）：
   *  ① **请求序号**：并发调用只有最后一次生效 ⇒ 消除
   *     `The play() request was interrupted by a new load request`；
   *  ② **候选逐个尝试**：引擎给的 `url` + `alternatives` 依次试 ⇒ 缓解
   *     `no supported source`（排序启发式挑错时仍有救）；
   *  ③ **失败后重解析一轮**：直链普遍带时效签名（见 `URL_TTL_MS`），
   *     第一轮全挂就丢掉缓存、重新问引擎要地址再试一遍 ⇒ 缓解「放了一会儿就放不了」。
   */
  async function playAt(i: number, startAt = 0): Promise<void> {
    const b = book.value;
    const t = tracks.value[i];
    if (!b || !t) return;
    const my = ++reqSeq;
    index.value = i;
    loading.value = true;
    err.value = '';
    ensureMounted();
    let lastErr: unknown = null;
    try {
      /**
       * **已缓存 ⇒ 先走本地直出**（`/api/audio`，支持 Range），下次播放不依赖源站。
       * 未命中/文件被清 ⇒ 静默回落到下面的普通流式链路（首播不阻塞）。
       */
      const cacheId = cacheIdOf(t);
      if (cacheId && cachedChapters.value.has(cacheId)) {
        const cu = audioCacheUrl({
          bookUrl: b.bookUrl ?? b.key,
          chapterUrl: cacheId,
          title: t.title,
        });
        try {
          await loadAndPlay(cu, 'mp3', startAt, { sid: b.sourceId });
          if (my !== reqSeq) return;
          mediaUrl.value = cu;
          syncMediaSession();
          persist(true);
          return;
        } catch {
          if (my !== reqSeq) return;
          cachedChapters.value.delete(cacheId); // 文件被清理/损坏 ⇒ 本次回落流式，下次重新判
        }
      }
      for (let round = 0; round < 2; round += 1) {
        const r = await resolveUrls(b.sourceId, t, { fresh: round > 0 });
        if (my !== reqSeq) return; // 已被更新的播放请求取代 —— 这不是失败
        if (!r.urls.length) {
          lastErr = new Error('未取到媒体地址（源未返回 media，正文里也没有媒体直链）');
          continue; // 第二轮换个解析结果再试
        }
        for (const u of r.urls) {
          if (my !== reqSeq) return;
          try {
            await loadAndPlay(u, r.format, startAt, { sid: b.sourceId, ...(r.headers ? { headers: r.headers } : {}) });
            if (my !== reqSeq) return;
            mediaUrl.value = u;
            syncMediaSession();
            persist(true);
            // 策略 A：播放成功即后台整章落盘（不 await，首播不等下载）
            maybePrefetch(t);
            return; // 成功
          } catch (e) {
            if (my !== reqSeq) return; // 被新的请求打断：交由新请求汇报
            lastErr = e;
            // 单条候选失败不应打断整轮：用户看到的是「最终有没有播起来」
          }
        }
        // 本轮候选全败 ⇒ 下一轮强制重解析（换掉可能过期的签名）
        invalidate(b.sourceId, t);
      }
      throw lastErr ?? new Error('媒体加载失败');
    } catch (e) {
      playing.value = false;
      err.value = '播放失败：' + explainMediaError(e);
    } finally {
      if (my === reqSeq) loading.value = false;
    }
  }

  /**
   * 打开一本书的播放列表。
   *
   * @param opts.startIdx 指定起始曲目；不给则**优先续播**（上次听到的章节，
   *        按 `chapterUrl` 定位 —— 目录顺序会变、索引会漂移，URL 最稳）
   */
  async function playBook(opts: {
    sourceId: string;
    payload: unknown;
    /** 书级缓存键（`bookUrl` 优先；缺省回落 `itemKey`）—— 与服务端音频缓存同一口径 */
    bookUrl?: string;
    title: string;
    cover?: string;
    author?: string;
    chapters: AudioChapter[];
    startIdx?: number;
    /** 打开后是否自动开始（默认 true） */
    autoplay?: boolean;
  }): Promise<void> {
    const key = itemKey(opts.sourceId, opts.payload);
    const isNewBook = book.value?.key !== key;
    if (isNewBook) {
      urlCache.clear();
      listOpen.value = false;
      cachedChapters.value = new Set();
      prefetched.clear();
      downloadJobs.value = {};
      batchRunning.value = false;
    }
    book.value = {
      sourceId: opts.sourceId,
      key,
      ...(opts.bookUrl ? { bookUrl: opts.bookUrl } : {}),
      title: opts.title,
      ...(opts.cover ? { cover: opts.cover } : {}),
      ...(opts.author ? { author: opts.author } : {}),
    };
    closed.value = false;
    // 卷标题行没有正文/音频页 —— 与阅读器「跳过卷」一致
    tracks.value = opts.chapters.filter((c) => !c.isVolume);
    if (!tracks.value.length) {
      err.value = '该源没有可播放的章节';
      return;
    }
    // 先取一次缓存状态（本地目录读，毫秒级）：已缓存的章可直接本地直出
    await refreshAudioCache();
    // 恢复服务端仍记得的离线任务（关掉播放器又打开时，别让用户以为已经下完）
    void refreshDownloadJobs();
    let idx = opts.startIdx ?? -1;
    let pos = 0;
    if (idx < 0) {
      const saved = loadProg()[key];
      if (saved) {
        if (saved.chapterUrl) {
          const at = tracks.value.findIndex(
            (c) => (c.payload as { chapterUrl?: string } | undefined)?.chapterUrl === saved.chapterUrl,
          );
          if (at >= 0) idx = at;
        }
        if (idx < 0 && saved.index >= 0 && saved.index < tracks.value.length) idx = saved.index;
        // 续播位置只在「回到同一章节」时才用；换书/换章从头
        if (idx >= 0 && idx === saved.index) pos = saved.position || 0;
      }
    }
    if (idx < 0) idx = 0;
    if (opts.autoplay === false) {
      index.value = idx;
      return;
    }
    await playAt(idx, pos);
  }

  function play(): void {
    if (!book.value) return;
    // 列表还没选曲（例如先 openList 后直接点播放）→ 从第一首开始
    if (index.value < 0) {
      void playAt(0);
      return;
    }
    // ⚠️ 这里**不设错误**：`playAt` 正在装载新地址时，元素上的 `play()` 必然被打断
    // （AbortError）—— 那是正常时序，不是「播放失败」。真正的错误由 `playAt` 汇报。
    void el.play().catch(() => {
      /* 交给 playAt / 元素 error 事件留痕 */
    });
  }
  function pause(): void {
    el.pause();
    persist(true);
  }
  function toggle(): void {
    if (el.paused) play();
    else pause();
  }
  function next(): void {
    if (hasNext.value) void playAt(index.value + 1);
    else {
      pause();
      position.value = 0;
    }
  }
  function prev(): void {
    // 与主流播放器一致：播放超过 3 秒时「上一首」先回到本曲开头
    if (el.currentTime > 3) {
      seek(0);
      return;
    }
    if (hasPrev.value) void playAt(index.value - 1);
  }
  function seek(t: number): void {
    try {
      el.currentTime = Math.max(0, Math.min(duration.value || Number.MAX_SAFE_INTEGER, t));
      position.value = el.currentTime;
      persist(true);
    } catch {
      /* 元数据未就绪时 seek 会被忽略 */
    }
  }
  function setVolume(v: number): void {
    volume.value = Math.min(1, Math.max(0, v));
    el.volume = volume.value;
    localStorage.setItem(VOLUME_KEY, String(volume.value));
  }
  function setRate(r: number): void {
    rate.value = r;
    el.playbackRate = r;
    localStorage.setItem(RATE_KEY, String(r));
  }

  // ---- 定时关闭 ----
  /**
   * ⚠️ 类型不能写 `number`：`@types/node` 与 DOM 两套 `setInterval` 的返回类型不同
   * （`Timeout` vs `number`），写死 `number` 会在 Node 类型被引入时报错
   * （2026-09-30 跑 `vue-tsc` 全量时才发现 —— 之前靠增量缓存没暴露）。
   */
  let sleepTimer: ReturnType<typeof setInterval> | undefined;
  function setSleep(minutes: number): void {
    if (sleepTimer !== undefined) {
      clearInterval(sleepTimer);
      sleepTimer = undefined;
    }
    if (!minutes) {
      sleepEndAt.value = 0;
      sleepLeft.value = 0;
      return;
    }
    sleepEndAt.value = Date.now() + minutes * 60_000;
    sleepLeft.value = minutes * 60;
    sleepTimer = globalThis.setInterval(() => {
      const left = Math.max(0, Math.round((sleepEndAt.value - Date.now()) / 1000));
      sleepLeft.value = left;
      if (left <= 0) {
        pause();
        if (sleepTimer !== undefined) clearInterval(sleepTimer);
        sleepTimer = undefined;
        sleepEndAt.value = 0;
        toast('定时关闭：已暂停播放', 'info');
      }
    }, 1000);
  }

  // ---- 系统媒体键（Media Session）----
  function syncMediaSession(): void {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const b = book.value;
    const t = cur.value;
    try {
      ms.metadata = new MediaMetadata({
        title: t?.title ?? '音频',
        artist: b?.author || b?.title || '',
        album: b?.title ?? '',
        artwork: b?.cover
          ? [{ src: imgSrc(b.cover, { sourceId: b.sourceId, cover: true }), sizes: '512x512', type: 'image/jpeg' }]
          : [],
      });
      ms.setActionHandler('play', () => play());
      ms.setActionHandler('pause', () => pause());
      ms.setActionHandler('previoustrack', () => prev());
      ms.setActionHandler('nexttrack', () => next());
      ms.setActionHandler('seekto', (d) => {
        if (typeof d.seekTime === 'number') seek(d.seekTime);
      });
    } catch {
      /* 某些浏览器不支持全部 action，忽略 */
    }
  }

  // ---- `<audio>` 事件 → 状态（用户用系统媒体键操作时也要同步 UI）----
  el.addEventListener('play', () => {
    playing.value = true;
  });
  el.addEventListener('pause', () => {
    playing.value = false;
    persist(true);
  });
  el.addEventListener('timeupdate', () => {
    position.value = el.currentTime;
    if (Number.isFinite(el.duration)) duration.value = el.duration;
    persist();
    const ms = navigator.mediaSession;
    if (ms?.setPositionState && duration.value > 0) {
      try {
        ms.setPositionState({ duration: duration.value, position: Math.min(position.value, duration.value), playbackRate: rate.value });
      } catch {
        /* 位置状态只在有效 duration 下可设 */
      }
    }
  });
  el.addEventListener('loadedmetadata', () => {
    duration.value = Number.isFinite(el.duration) ? el.duration : 0;
    syncMediaSession();
  });
  el.addEventListener('ended', () => {
    // 连续播放：自动下一首；最后一首停住并把进度清零
    if (hasNext.value) next();
    else {
      playing.value = false;
      position.value = 0;
      persist(true);
    }
  });
  el.addEventListener('error', () => {
    if (!mediaUrl.value) return; // 清空 src 时的伪 error
    // 只标状态，**不改 `err` 文案**：`playAt` 正在按候选/重解析兜底，
    // 这里抢先写一条英文原话会把「正在自愈」显示成「失败」（且提示无法解释原因）。
    playing.value = false;
  });

  // ---- 浮窗位置 / 层级（用户要求：视窗内拖动、记忆位置、置顶、贴边隐藏）----
  /** 记住浮窗位置（视窗左上角坐标；调用方负责已做边界收敛） */
  function setFloatPos(p: { x: number; y: number } | null): void {
    floatPos.value = p;
    try {
      if (p) localStorage.setItem(POS_KEY, JSON.stringify(p));
      else localStorage.removeItem(POS_KEY);
    } catch {
      /* 配额满：位置丢失不影响播放 */
    }
  }
  /** 设置贴边状态（`null` = 不吸附） */
  function setEdgeDock(e: 'left' | 'right' | null): void {
    edgeDock.value = e;
  }
  /** 切换置顶 */
  function setOnTop(v: boolean): void {
    onTop.value = v;
    try {
      localStorage.setItem(ONTOP_KEY, JSON.stringify(v));
    } catch {
      /* 同上 */
    }
  }

  /**
   * 关闭浮窗 = **完全退出**（用户 2026-09-25：「点击关闭仍有驻留？点击关闭应完全退出」）。
   *
   * 旧实现只 `pause()` + `closed = true`，于是留下三处驻留：
   *  ① 元素仍持有 src 与已缓冲数据 ⇒ 浏览器标签页/任务栏继续显示「正在播放」并占内存；
   *  ② `Media Session` 的元数据与动作处理器还在 ⇒ 系统媒体面板仍显示这首歌；
   *  ③ store 里 `book/tracks` 还在 ⇒ 界面上「关不掉」的观感。
   * 现在：先落进度（**续播点不丢**，下次进同一本书照旧接着听）→ 再彻底断源、清状态。
   */
  function close(): void {
    // 关闭浮窗 ≠ 取消离线：任务在服务端继续跑。明确告知，避免用户以为「关了 = 下完了」
    if (hasActiveDownloads()) toast('离线任务仍在后台继续，重新打开播放列表可查看进度');
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    batchRunning.value = false;
    downloadJobs.value = {};
    persist(true);
    reqSeq += 1; // 让在途的解析/装载请求失效，避免它把关闭后的状态又写回来
    detach(); // 销毁 hls + 清 src + load() 释放缓冲
    playing.value = false;
    loading.value = false;
    mediaUrl.value = '';
    err.value = '';
    position.value = 0;
    duration.value = 0;
    index.value = -1;
    tracks.value = [];
    book.value = null;
    closed.value = false;
    minimized.value = false;
    listOpen.value = false;
    setSleep(0);
    try {
      const ms = navigator.mediaSession;
      if (ms) {
        ms.metadata = null;
        ms.setActionHandler('play', null);
        ms.setActionHandler('pause', null);
        ms.setActionHandler('previoustrack', null);
        ms.setActionHandler('nexttrack', null);
        ms.setActionHandler('seekto', null);
        ms.setActionHandler('seekbackward', null);
        ms.setActionHandler('seekforward', null);
      }
    } catch {
      /* 忽略 */
    }
  }

  return {
    // 状态
    book, tracks, index, playing, position, duration, mediaUrl, loading, err,
    minimized, closed, listOpen, volume, rate, sleepEndAt, sleepLeft,
    floatPos, edgeDock, onTop,
    /** 已缓存章节标识（响应式：播放列表「已缓存」标记） */
    cachedChapters,
    /** 手动离线任务表 + 整本下载状态（P1.5） */
    downloadJobs, batchRunning,
    // 派生
    visible, cur, hasPrev, hasNext, progressPct,
    // 动作
    playBook, playAt, play, pause, toggle, next, prev, seek, setVolume, setRate,
    setSleep, close, progressOf, persist, syncMediaSession,
    setFloatPos, setEdgeDock, setOnTop,
    // 离线（P1.5）
    downloadTrack, downloadAll, cancelDownload, cancelAllDownloads,
    refreshDownloadJobs, isCachedTrack, jobOf, downloadPct, isActiveJob, explainJobError,
    /** 暴露媒体元素（组件/调试用；正常通过上面动作操作） */
    element: el,
  };
});
