<script setup lang="ts">
/**
 * MediaPlayer —— 通用媒体播放器（视频 / 音频 / HLS）。
 *
 * ## 为什么需要它（而不是继续用 `<video :src>`）
 *
 * 阅读浮层里原来对 `kind === 'video'` 直接渲染一个裸 `<video :src="…">`。这有两个问题：
 *
 * ① **Chromium 没有原生 HLS**。语料里 **10 个源**的正文/播放页返回 `.m3u8`，
 *    裸 `<video>` 拿到 m3u8 只会报 `no supported source`（错误信息完全看不出是格式问题）。
 *    必须用 hls.js 解封装 —— 本仓已有该依赖（`PlayerView.vue` 早在用）。
 * ② **直链排序是启发式的**。引擎按可信度给出 `url` + `alternatives`，但真实播放页上
 *    常有广告位/预告/多线路，**排序必然有取错的时候**。谁也无法在服务端判定「这条真能放」，
 *    只有媒体元素的 error 事件知道 —— 所以这里负责**按序换线路**。
 *
 * ## 防盗链 / CORS：三级「取址阶梯」
 *
 * 实测（页内 `fetch`，即受同源策略约束的真实环境）：m3u8 播放列表**可能被 CORS 拦**
 * （`Failed to fetch`），而分片/密钥常常能直连。于是本组件按**能直连就直连**排序，
 * 失败自动升级：**0 全直连 → 1 列表走代理 → 2 全走代理**（详见 `attempt` 的注释）。
 *
 * ⚠️ 列表一旦经代理，**相对地址必须补成绝对** —— hls.js 是按「它拿到的列表 URL」解析相对
 * 分片的，而那个 URL 现在是 `/api/proxy?u=…`，不补就会算出 `/api/proxy?u=…/seg1.ts` 这种
 * 垃圾地址（用户实测的 `levelParsingError`/`fragParsingError`/`fragLoadTimeOut` 就是这个形状）。
 * 服务端（`apps/server/src/hls.ts`）与**客户端**（本文件的 `rewriteRelativePlaylist`）
 * **各做一份**：客户端那份是为了不依赖服务端进程的版本（旧 bundle 也能播），两边规则必须一致。
 */
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { imgSrc } from '../utils/img';

const props = defineProps<{
  /** 主直链（引擎 `media.url`） */
  src: string;
  /** 备选直链（引擎 `media.alternatives`）——主地址失败后按序尝试 */
  alternatives?: string[];
  format?: 'm3u8' | 'mp4' | 'audio' | 'unknown' | string;
  /** 源 id（走代理时用于带源头 Cookie/UA） */
  sourceId?: string;
  /** 显式 Referer（走代理时透传） */
  referer?: string;
}>();

const emit = defineEmits<{
  (e: 'error', msg: string): void;
  (e: 'ready'): void;
  /** 播放进度（秒）—— 上层落盘为影视库进度条 / 续播定位（见 reader.recordProgress） */
  (e: 'progress', sec: number, dur: number): void;
  /** `#689` 本集播完 —— 上层据此决定要不要自动连播下一集 */
  (e: 'ended'): void;
}>();

const shell = ref<HTMLDivElement | null>(null);
/**
 * `#684` **视频按内容比例自适应**（用户实测两张截图）：
 *
 * | 现象 | 原因 | 现在 |
 * |-|-|-|
 * | 面板钉 92vh 后，视频下方留一大块黑（截图 1） | `.mp-shell` 恒 `width:100%` + `aspect-ratio:16/9`，高度只由宽度算出，吃不满可用高度 | 先按可用**高度**算，宽度按比例跟随 |
 * | 窗口很扁时视频高度溢出面板（截图 2） | 同一个原因：宽度优先 ⇒ 高度超过 92vh | 宽高双向夹取，永不超出舞台 |
 *
 * 另外按用户要求给最小宽度 = 当前高度的 9/16：内容比 16:9 更「竖」时宽度不再缩成一条缝。
 */
const fitStyle = ref<Record<string, string>>({});
/** 内容的自然宽高比（`loadedmetadata` 后更新；未知时按 16:9） */
const nature = ref(16 / 9);

/**
 * 计算视频盒子：先按可用高度定高，宽度按比例跟随；超宽就把宽度收回到可用宽。
 *
 * 父容器用 `clientWidth/clientHeight` 拿**内容盒**；父容器没有确定高度时清空内联样式，
 * 回退到 CSS 默认（`width:100%` + 16:9），保持阅读浮层里的旧行为。
 */
function relayout(): void {
  const host = shell.value?.parentElement;
  if (!host) return;
  const availW = host.clientWidth;
  const availH = host.clientHeight;
  if (!availW || !availH) {
    fitStyle.value = {};
    return;
  }
  const ratio = nature.value > 0.1 ? nature.value : 16 / 9;
  let h = availH;
  let w = h * ratio;
  if (w > availW) {
    w = availW;
    h = w / ratio;
  }
  const minW = (h * 9) / 16;
  if (w < minW) {
    w = Math.min(minW, availW);
    h = w / ratio;
  }
  fitStyle.value = { width: `${Math.floor(w)}px`, height: `${Math.floor(h)}px`, 'aspect-ratio': 'auto' };
}

let ro: ResizeObserver | null = null;
function watchStage(): void {
  const host = shell.value?.parentElement;
  if (!host || typeof ResizeObserver === 'undefined') return;
  ro?.disconnect();
  ro = new ResizeObserver(() => relayout());
  ro.observe(host);
  relayout();
}
const errMsg = ref('');
/** 当前试到第几条候选（0 = 主地址） */
const tryIdx = ref(0);
let art: Artplayer | null = null;
let hls: Hls | null = null;

/**
 * 播放进度上报。
 * `timeupdate` 每秒触发约 4 次 —— **必须节流**（上层会写 localStorage，每次都写会卡顿）。
 * 暂停/播完时 `force` 补一次：否则「看到 03:20 就关掉」会丢掉最后那段进度。
 */
let lastProgAt = 0;
/**
 * `#689` **记住最后播放位置**。
 *
 * 用户实测「播到一半卡住、过十几二十秒又从头开始」：一次网络抖动被 hls.js 判成 fatal，
 * 我们旧的 `fail()` 会 `destroy()` + 重建播放器 ⇒ 位置归零，看起来像「自己重播了」。
 * 任何一个重建路径（软恢复失败后 remount、线路切换）都要能**续上**，否则长视频体验直接崩。
 */
let lastPos = 0;
/** 重建后要跳回的位置（`mount()` 里设，`loadedmetadata` 时用掉一次） */
let pendingResume = 0;

function reportProgress(force = false): void {
  if (!art) return;
  const d = Number(art.duration);
  const c = Number(art.currentTime);
  if (!(d > 0) || !Number.isFinite(c)) return;
  lastPos = c;
  const now = Date.now();
  if (!force && now - lastProgAt < 4000) return;
  lastProgAt = now;
  emit('progress', c, d);
}

/** 候选表：主地址 + 备选（去重、去空） */
const candidates = computed(() => {
  const all = [props.src, ...(props.alternatives ?? [])].filter((u) => !!u);
  return [...new Set(all)];
});
const current = computed(() => candidates.value[tryIdx.value] ?? '');

/**
 * **取址策略阶梯**（0 → 1 → 2，失败自动升级）。
 *
 * 为什么要有阶梯（2026-09-26 用户实测三源 HLS 报错的根因）：
 * 影院链原先用 `views/PlayerView.vue` —— 它是 `hls.loadSource(原始URL)`，**全程直连**；
 * 浮窗化后统一走本组件，改成了「**m3u8 一律走代理**」，于是出现了两类回归：
 *   · 相对地址（master 多码率的子列表、相对分片）被解析到 **代理 URL** 下
 *     （`/api/proxy?u=…/2000kb/hls/index.m3u8`）⇒ `levelParsingError` / `fragParsingError`
 *     / `fragLoadTimeOut`（症状完全一致）；
 *   · 服务端若没做重写（旧进程），这个错就**必然**发生。
 *
 * 所以按「**能直连就直连**」排序，逐级升级，每级都有明确目的：
 *   · **0 全直连** —— 与旧 `PlayerView` 行为一致；相对地址由 hls.js **原生**按上游 URL 解析，
 *     最不容易错（也最省服务端资源）；
 *   · **1 列表走代理、子请求直连** —— 解决「播放列表被 CORS 拦」（实测麻豆的 m3u8 直连
 *     `Failed to fetch`，只有服务端能绕过）；
 *   · **2 全走代理** —— 解决「子请求也要防盗链头 / 也被 CORS 拦」。
 *
 * 每一级失败都只是**升级到下一级再试**，用户看到的是「自己好了」而不是一排英文错误。
 */
const attempt = ref(0);
/** 需要走代理的地址（`attempt >= 1` 时列表过代理；`props.referer` 时也必须过——浏览器设不了 Referer） */
const needProxyList = computed(() => attempt.value >= 1 || !!props.referer);
const proxyChildren = computed(() => attempt.value >= 2 || !!props.referer);
/** 交给播放器的地址 */
const playSrc = computed(() => {
  if (!needProxyList.value) return current.value;
  return imgSrc(current.value, { sourceId: props.sourceId, ...(props.referer ? { referer: props.referer } : {}) });
});

function isHls(u: string): boolean {
  if (props.format === 'm3u8') return true;
  return /\.m3u8(\?|#|$)/i.test(u) || /m3u8/i.test(u);
}

/**
 * **把播放列表里的相对地址补成绝对**（客户端版，基于**上游**播放列表 URL）。
 *
 * 为什么客户端也要做一份（不依赖服务端的 `apps/server/src/hls.ts`）：
 * 播放列表一旦经 `/api/proxy`，hls.js 就会把相对地址解析到**代理 URL** 下 ⇒ 必失败。
 * 服务端回传前会重写，但那要求**服务端进程是新版本** —— 用户实测正是踩在「服务端还在跑
 * 旧 bundle」上，症状就是 `levelParsingError`/`fragParsingError`。客户端自带一份后，
 * 无论服务端新旧都能播（服务端已重写过时这里是**幂等无操作**）。
 *
 * ⚠️ 与服务端 `rewriteHlsPlaylist` 是**同一套规则**，改一处必须改另一处
 * （回归锁：`apps/server/src/__tests__/hls-playlist.test.ts` 锁住规则本身）。
 */
function rewriteRelativePlaylist(text: string, base: string): string {
  const abs = (u: string): string => {
    const s = u.trim();
    if (!s || /^(https?:|data:|blob:)/i.test(s)) return u;
    try {
      return new URL(s, base).toString();
    } catch {
      return u;
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/gi, (_m, u: string) => `URI="${abs(u)}"`);
      return abs(t);
    })
    .join('\n');
}

/** 自取并重写后的播放列表 blob（销毁时要 revoke，否则泄漏） */
let playlistBlob: string | null = null;
function revokePlaylistBlob(): void {
  if (!playlistBlob) return;
  try {
    URL.revokeObjectURL(playlistBlob);
  } catch {
    /* 忽略 */
  }
  playlistBlob = null;
}

function destroy(): void {
  ro?.disconnect();
  ro = null;
  if (hls) {
    try {
      hls.destroy();
    } catch {
      /* 忽略 */
    }
    hls = null;
  }
  revokePlaylistBlob();
  if (art) {
    try {
      art.destroy();
    } catch {
      /* 忽略 */
    }
    art = null;
  }
}

/**
 * 失败处理：**先升级取址阶梯，再换候选线路**，都试完才把错误交给上层。
 *
 * 这是「服务端只给一个地址 ⇒ 取错就彻底放不了」+「相对地址/防盗链导致整条流挂掉」的解法。
 */
function fail(msg: string): void {
  if (attempt.value < 2) {
    attempt.value += 1;
    errMsg.value = `播放失败，正在改用「${attempt.value === 1 ? '列表经代理' : '全部经代理'}」重试…`;
    void mount();
    return;
  }
  if (tryIdx.value < candidates.value.length - 1) {
    tryIdx.value += 1;
    attempt.value = 0;
    errMsg.value = `该线路无法播放，已自动切换（${tryIdx.value + 1}/${candidates.value.length}）…`;
    void mount();
    return;
  }
  errMsg.value = msg;
  emit('error', msg);
}

/**
 * `#689` **软恢复**：网络抖动 / 解码小问题先就地修，**不重建播放器**（保住进度与已缓冲）。
 *
 * 旧实现里 hls.js 的任何一个 `fatal` 都直接 `fail()` ⇒ `destroy()` + 重建 ⇒ 从头播。
 * 但 hls.js 把「重试耗尽」的错误标成 fatal，其中一大半是**临时性**的：
 *   · `NETWORK_ERROR`（分片/列表超时、5xx）：`startLoad()` 让它在**当前位置**继续加载即可；
 *   · `MEDIA_ERROR`（解码/缓冲异常）：`recoverMediaError()` 是 hls.js 官方恢复手段。
 * 只有这两类之外、或连续软恢复仍失败，才升级到重建/换线路。
 *
 * 上限 2 次：真挂的流软恢复多少次都没用，别让用户干等（每次恢复本身也要十几秒）。
 */
let softTries = 0;
function softRecover(type: string): boolean {
  if (!hls || softTries >= 2) return false;
  softTries += 1;
  if (type === Hls.ErrorTypes.MEDIA_ERROR) {
    errMsg.value = `解码异常，正在恢复（${softTries}/2）…`;
    hls.recoverMediaError();
    return true;
  }
  if (type === Hls.ErrorTypes.NETWORK_ERROR) {
    errMsg.value = `网络抖动，正在续传（${softTries}/2）…`;
    hls.startLoad();
    return true;
  }
  return false;
}

function mount(): void {
  const container = shell.value;
  const u = playSrc.value;
  if (!container || !u) {
    if (!u) fail('没有可播放的媒体地址');
    return;
  }
  // 重建前记下位置（`destroy()` 之后 video 元素就没了）
  pendingResume = lastPos > 5 ? lastPos : 0;
  softTries = 0;
  destroy();
  errMsg.value = '';
  watchStage();
  art = new Artplayer({
    container,
    url: u,
    type: isHls(current.value) ? 'm3u8' : 'mp4',
    volume: 0.8,
    autoplay: true,
    playbackRate: true,
    aspectRatio: true,
    setting: true,
    fullscreen: true,
    fullscreenWeb: true,
    pip: true,
    miniProgressBar: true,
    airplay: true,
    customType: {
      m3u8: (video: HTMLVideoElement, src: string) => {
        if (!Hls.isSupported()) {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            return;
          }
          fail('当前浏览器不支持 m3u8（HLS）播放');
          return;
        }
        hls = new Hls({
          /**
           * `#689` **缓存/重试调优**（用户实测「播到一半不再加载，卡十几二十秒后从头开始」）。
           *
           * 旧配置是 hls.js 默认值：`fragLoadingTimeOut` 20s、`fragLoadingMaxRetry` 6、缓冲 60s 上限。
           * 症状对得上：弱网时一个分片超时 ⇒ 走完重试链（十几秒）⇒ 被判 fatal ⇒ 旧 `fail()`
           * 重建播放器 ⇒ **从头开始**。这里三件事一起改：
           *   ① 缓冲给足（30s/60s）+ 限制回看（30s）—— 短剧一集 10 余分钟，缓冲越深越不容易卡；
           *   ② 重试更密、退避更短（`fragLoadingRetryDelay` 500ms、`MaxRetryTimeout` 8s）；
           *   ③ `nudgeMaxRetry` —— hls.js 的「卡在缓冲」自救次数（默认 3，这里给 5）。
           */
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          backBufferLength: 30,
          lowLatencyMode: false,
          manifestLoadingTimeOut: 15000,
          levelLoadingTimeOut: 15000,
          fragLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 6,
          fragLoadingRetryDelay: 500,
          fragLoadingMaxRetryTimeout: 8000,
          nudgeMaxRetry: 5,
          ...(proxyChildren.value
            ? {
                /**
                 * 子请求（分片/密钥/子播放列表）也走代理（第 2 级）。
                 * 只改写**绝对地址**：相对地址的基址本应是上游播放列表所在目录，
                 * 而我们拿到的是「代理 URL」这一刻的地址 —— 相对地址已在上一步补成绝对
                 * （客户端 `rewriteRelativePlaylist` / 服务端 `rewriteHlsPlaylist`）。
                 */
                xhrSetup: (xhr, url) => {
                  if (!/^https?:\/\//i.test(url)) return;
                  xhr.open(
                    'GET',
                    imgSrc(url, { sourceId: props.sourceId, ...(props.referer ? { referer: props.referer } : {}) }),
                    true,
                  );
                },
              }
            : {}),
        });
        // 加载成功就把软恢复计数清零（否则一次抖动过后再也不给自救机会）
        hls.on(Hls.Events.FRAG_LOADED, () => {
          softTries = 0;
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data?.fatal) return;
          // `#689` 先软恢复（保住进度），实在不行才重建/换线路
          if (softRecover(String(data.type ?? ''))) return;
          fail(`播放失败：${String(data.type)}/${String(data.details)}`);
        });
        // 第 0 级：直连 → 相对地址由 hls.js 原生按上游 URL 解析（最稳）
        if (attempt.value === 0) {
          hls.loadSource(src);
          hls.attachMedia(video);
          return;
        }
        // 第 1/2 级：列表已代理 ⇒ 自取 + 本地重写相对地址后再喂 hls.js
        void (async () => {
          try {
            const r = await fetch(src);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const fixed = rewriteRelativePlaylist(await r.text(), current.value);
            revokePlaylistBlob();
            playlistBlob = URL.createObjectURL(new Blob([fixed], { type: 'application/vnd.apple.mpegurl' }));
            hls?.loadSource(playlistBlob);
            if (hls && video) hls.attachMedia(video);
          } catch (e) {
            fail(`播放列表取不到：${String(e instanceof Error ? e.message : e).slice(0, 60)}`);
          }
        })();
      },
    },
  });
  // artplayer 的错误事件（非 HLS 路径：mp4 403/404、编码不支持等）
  art.on('error', () => fail('播放失败：地址无法加载或格式不支持'));
  art.on('ready', () => {
    /**
     * `#684` 拿到真实画面比例后重算盒子：竖屏短剧（9:16）与横屏（16:9）的盒子完全不同，
     * 只按 16:9 猜会在竖屏内容上留下一大块黑边。`loadedmetadata` 是唯一可靠的时点
     * （artplayer 的 ready 早于它，此时 videoWidth 还是 0）。
     */
    const v = art?.video;
    if (v) {
      const sync = (): void => {
        if (v.videoWidth > 0 && v.videoHeight > 0) {
          nature.value = v.videoWidth / v.videoHeight;
          relayout();
        }
        /**
         * `#689` **续播**：重建/换线路后跳回原来位置（只做一次）。
         * 放在 `loadedmetadata` 之后 —— 此时 `duration` 才可用，
         * 否则 hls.js 还没解析出时长，`currentTime` 赋值会被丢弃（表现为「还是从头」）。
         */
        if (pendingResume > 0 && Number.isFinite(v.duration) && v.duration > pendingResume) {
          const at = pendingResume;
          pendingResume = 0;
          v.currentTime = at;
        }
      };
      v.addEventListener('loadedmetadata', sync);
      v.addEventListener('resize', sync);
      sync();
    }
    emit('ready');
  });
  // 播放进度上报（节流见 reportProgress；暂停/播完强制补一次，避免丢最后一段）
  art.on('video:timeupdate', () => reportProgress());
  art.on('video:pause', () => reportProgress(true));
  art.on('video:ended', () => {
    reportProgress(true);
    // `#689` 交给上层决定要不要连播（开关在选集列表标题栏）
    emit('ended');
  });
}

onMounted(() => void mount());
onBeforeUnmount(destroy);
// 换集/换章：候选与阶梯都从头开始（否则会「继承」上一集试到一半的状态）
watch(
  () => [props.src, props.format] as const,
  () => {
    tryIdx.value = 0;
    attempt.value = 0;
    void mount();
  },
);
</script>

<template>
  <div class="mp-shell" ref="shell" :style="fitStyle">
    <div v-if="errMsg" class="mp-err">{{ errMsg }}</div>
  </div>
</template>

<style scoped>
.mp-shell {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 10px;
  overflow: hidden;
}
/* 错误提示浮在画面上（artplayer 也会往容器里插 DOM，不能挤占布局） */
.mp-err {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  z-index: 2; max-width: 90%;
  color: var(--red); font-size: 12.5px; line-height: 1.6; text-align: center;
  background: rgba(0, 0, 0, 0.65); padding: 8px 12px; border-radius: 8px;
  pointer-events: none;
}
</style>
