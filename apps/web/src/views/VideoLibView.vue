<script setup lang="ts">
/**
 * VideoLibView —— 我的库 · 影视（收藏 / 历史 / 继续观看）
 *
 * **对齐 OmniFlow `views/VideoLibraryView.vue` 的实现**（用户实测 ③）：
 *   · 顶部一张卡：标题 + 三个带计数的 tab（★收藏 / ⏱历史 / ▶继续观看）+「清空历史」+「去影院发现」
 *   · 卡片：封面（hover 浮出操作条）→ 标题 → 相对时间 →「看到：第X集」→ **进度条**
 *   · 主按钮 = ▶ 播放 / 续播：**直接起播**（不再只开详情浮窗），续播按上次线路 + 集标题定位
 *
 * 与 OmniFlow 的差异（数据模型限制，非缺陷）：
 *   · 进度来自 `WatchEntry.progressSec/durationSec`（本地记录，见 `stores/reader.ts`）；
 *     没播过的条目没有进度 ⇒ 不显示进度条（不编造数字）。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useReaderStore, type ShelfBook, type WatchEntry } from '../stores/reader';
import { useVodStore } from '../stores/vod';

// 封面统一走服务端代理（防盗链 Referer + 源图片解密 + 动图原样透传）——见 utils/img.ts
import CoverImage from '../components/CoverImage.vue'; /* `#163` 封面统一出口 */
import { imgSrc } from '../utils/img';

const router = useRouter();
const reader = useReaderStore();

const vod = useVodStore();

type Tab = 'fav' | 'history' | 'resume';
type Row = ShelfBook | WatchEntry;
const tab = ref<Tab>('fav');

const favorites = computed<Row[]>(() => reader.videoShelf as Row[]);
const history = computed<Row[]>(() => reader.watchSorted as Row[]);
/** 继续观看 = 已记「看到第几集」或有播放进度的历史记录 */
const resumable = computed<Row[]>(() =>
  (reader.watchSorted as WatchEntry[]).filter((e) => e.lastEpisode || (e.progressSec ?? 0) > 0) as Row[],
);
const currentList = computed<Row[]>(() => {
  if (tab.value === 'fav') return favorites.value;
  if (tab.value === 'history') return history.value;
  return resumable.value;
});

const emptyHint = computed(() => {
  switch (tab.value) {
    case 'fav': return { icon: '★', title: '还没有收藏的影片', sub: '在影院或详情页点击「★ 收藏」，即可加入这里。' };
    case 'history': return { icon: '⏱', title: '暂无观看历史', sub: '开始播放后才会记入这里，并记录播放进度。' };
    default: return { icon: '▶', title: '还没有可继续观看的影片', sub: '播放过的影片会记录观看位置，这里可一键续播。' };
  }
});

/** 展示行（模板只读这个，避免在模板里反复调用函数 / 用 TS 断言） */
interface Card {
  key: string;
  title: string;
  cover?: string;
  sourceId: string;
  payload: unknown;
  /** 「看到的那一集」标题（收藏看 lastChapter，历史看 lastEpisode） */
  ep?: string;
  /** 那一集的线路名（CMS 集 payload 的 from；续播定位用） */
  epFrom?: string;
  /** 0~100，0 = 无进度 */
  progress: number;
  when: string;
  raw: Row;
}
/**
 * 「看到的那一集」：收藏看 `lastChapter`（`ShelfBook`），历史看 `lastEpisode`（`WatchEntry`）。
 *
 * ⚠️ 不能写 `'lastEpisode' in r ? r.lastEpisode : r.lastChapter`：两个字段**都是可选的**，
 * 所以 `in` 无法把 `WatchEntry` 从 else 分支里排除掉（TS 报 `lastChapter` 不存在于 `WatchEntry`），
 * 而且运行期也真的可能是 `ShelfBook` 没有 `lastChapter`（还没读过）。两次 `in` 判定才严密。
 */
function rowEp(r: Row): { title: string; payload: unknown } | undefined {
  if ('lastEpisode' in r && r.lastEpisode) return r.lastEpisode;
  if ('lastChapter' in r) return r.lastChapter;
  return undefined;
}
function rowProgress(r: Row): number {
  const sec = r.progressSec ?? 0;
  const dur = r.durationSec ?? 0;
  if (!(dur > 0) || !(sec > 0)) return 0;
  return Math.min(100, Math.round((100 * sec) / dur));
}
const cards = computed<Card[]>(() =>
  currentList.value.map((r, i) => {
    const ep = rowEp(r);
    const c: Card = {
      key: `${r.key ?? r.title}:${i}`,
      title: r.title,
      sourceId: r.sourceId,
      payload: r.payload,
      progress: rowProgress(r),
      when: fmtAgo(r.updatedAt),
      raw: r,
    };
    if (r.cover) c.cover = r.cover;
    if (ep) {
      c.ep = ep.title;
      c.epFrom = String((ep.payload as Record<string, unknown> | undefined)?.['from'] ?? '');
    }
    return c;
  }),
);

const POSTER_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const;
function posterCls(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 131 + seed.charCodeAt(i)) >>> 0;
  return POSTER_IDS[h % POSTER_IDS.length] ?? POSTER_IDS[0];
}
function fmtAgo(ts?: number): string {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}

/** 点卡片本体 = 开详情浮窗 */
function openDetail(c: Card): void {
  vod.openDetail({ sourceId: c.sourceId, payload: c.payload, title: c.title, ...(c.cover ? { cover: c.cover } : {}) });
}
/**
 * ▶ 播放 / 续播：详情到位后**直接起播**（`VodDetailSession.autoPlay`）。
 * 线路取该集 payload 的 `from`，集按**标题**定位 —— 不用下标（目录会随源更新漂移）。
 */
function openPlay(c: Card): void {
  vod.openDetail({
    sourceId: c.sourceId,
    payload: c.payload,
    title: c.title,
    ...(c.cover ? { cover: c.cover } : {}),
    ...(c.ep ? { autoPlay: { line: c.epFrom ?? '', ep: c.ep } } : {}),
  });
}
function removeRow(c: Card): void {
  if (tab.value === 'fav') reader.removeFromShelf(c.raw as ShelfBook);
  else reader.removeWatch(c.raw as WatchEntry);
}
</script>

<template>
  <div class="vl-wrap">
    <!-- 顶部：标题 + 三 tab（各带计数）+ 操作 -->
    <div class="vl-header card">
      <div class="vl-title">
        <h2>影视库 · 我的收藏与历史</h2>
        <span class="vl-total">共 {{ favorites.length + history.length }} 条</span>
      </div>
      <div class="vl-tabs">
        <div class="vl-tab" :class="{ on: tab === 'fav' }" @click="tab = 'fav'">
          <span>★ 收藏</span><em>{{ favorites.length }}</em>
        </div>
        <div class="vl-tab" :class="{ on: tab === 'history' }" @click="tab = 'history'">
          <span>⏱ 历史</span><em>{{ history.length }}</em>
        </div>
        <div class="vl-tab" :class="{ on: tab === 'resume' }" @click="tab = 'resume'">
          <span>▶ 继续观看</span><em>{{ resumable.length }}</em>
        </div>
        <span style="flex: 1"></span>
        <button v-if="tab === 'history' && history.length" class="btn sm" @click="reader.clearHistory()">清空历史</button>
        <button class="btn sm primary" @click="router.push('/discovery/video')">去影院发现 →</button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="!cards.length" class="empty-state card">
      <div class="empty-icon">{{ emptyHint.icon }}</div>
      <h2>{{ emptyHint.title }}</h2>
      <p>{{ emptyHint.sub }}</p>
      <button class="empty-btn primary" @click="router.push('/discovery/video')">前往影院 →</button>
    </div>

    <!-- 卡片网格 -->
    <div v-else class="vl-grid">
      <div v-for="(c, i) in cards" :key="c.key" class="vl-card">
        <div class="poster" :class="posterCls(c.title)" @click="openDetail(c)">
          <!-- 同书架：`.ph` 覆盖层与「下方信息按封面隐藏」整套已撤（用户 2026-10-01 纠错），
               默认封面由 CoverImage 自己画片名，加载到真图则不画。 -->
          <CoverImage class="poster-img" :cover="c.cover" :source-id="c.sourceId" :title="c.title" :index="i" />
          <div class="cover-actions">
            <button class="cover-btn ghost" @click.stop="removeRow(c)">
              {{ tab === 'fav' ? '★ 移除收藏' : '✕ 删除记录' }}
            </button>
            <button class="cover-btn primary" @click.stop="openPlay(c)">▶ {{ tab === 'resume' ? '续播' : '播放' }}</button>
          </div>
          <div v-if="tab !== 'fav' && c.progress" class="prog-bar">
            <div class="pb-fill" :style="{ width: c.progress + '%' }"></div>
          </div>
        </div>
        <div class="nm" :title="c.title">{{ c.title }}</div>
        <div class="au">{{ c.when }}</div>
        <div v-if="c.ep" class="lc" :title="c.ep">{{ tab === 'fav' ? '续看' : '看到' }}：{{ c.ep }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 页面整体锁成「正好一屏高」：顶部标题/标签卡固定，只有卡片网格滚动。
   高度取 `92vh` 与主区可用高度（100vh - 顶栏 52px - 主区上下 padding 40px）的较小值
   ⇒ 大屏正好 92vh，且不会把 `.omni-content` 再撑出第二条滚动条。 */
.vl-wrap {
  display: flex; flex-direction: column; gap: 14px;
  height: min(92vh, calc(100vh - 92px)); overflow: hidden;
}
.vl-header { flex: none; padding: 14px 16px; }
.vl-title { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.vl-title h2 { margin: 0; font-size: 17px; font-weight: 700; }
.vl-total { font-size: 11.5px; color: var(--muted); }
.vl-tabs { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.vl-tab {
  display: flex; align-items: center; gap: 8px; padding: 7px 14px;
  border-radius: 999px; border: 1px solid var(--line); background: var(--bg-3);
  color: var(--muted); cursor: pointer; font-size: 13px; transition: all 0.15s;
}
.vl-tab em { font-family: var(--mono); font-style: normal; font-size: 11px; padding: 0 7px; border-radius: 10px; background: var(--bg-2); color: var(--faint); }
.vl-tab:hover { color: var(--text-0); }
.vl-tab.on { background: var(--brand); color: #fff; border-color: var(--brand); font-weight: 600; }
.vl-tab.on em { background: rgba(255, 255, 255, 0.18); color: #fff; }

.empty-state { text-align: center; padding: 70px 30px; }
.empty-icon { font-size: 42px; margin-bottom: 10px; }
.empty-state h2 { margin: 0 0 8px; font-size: 17px; }
.empty-state p { color: var(--muted); font-size: 13px; max-width: 460px; margin: 0 auto 20px; line-height: 1.7; }
.empty-btn { padding: 9px 18px; border-radius: 9px; border: 1px solid var(--line2); background: var(--bg-3); color: var(--text); font-size: 13px; cursor: pointer; }
.empty-btn.primary { background: linear-gradient(135deg, var(--acc), #8b5cf6); border: none; color: #fff; }

/* 内容区：占满剩余高度并独立滚动（顶部 `.vl-header` 不跟着走） */
.vl-grid {
  flex: 1; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable;
  align-content: start;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px;
  padding-bottom: 8px;
}
.vl-card { min-width: 0; }
/* ★ `#186` 用 `background-color` 长写（理由同 DashboardView：简写会重置 background-size） */
.poster { position: relative; overflow: hidden; border-radius: 10px; aspect-ratio: 3 / 4; cursor: pointer; background-color: var(--bg-3); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); }
.poster-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
/* `#163`：`.ph` / `.ph .t` 已删 —— 覆盖层节点同一轮从模板移除，文字改由封面下方 `.nm/.au/.lc` 常驻承担。 */
.cover-actions {
  position: absolute; inset: auto 0 0 0; display: flex; gap: 6px;
  padding: 8px; opacity: 0; transform: translateY(4px); transition: all 0.18s ease;
  background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.7) 100%);
}
.vl-card:hover .cover-actions { opacity: 1; transform: translateY(0); }
.cover-btn { flex: 1; padding: 5px 0; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.12); color: #fff; font-size: 11px; cursor: pointer; font-weight: 600; backdrop-filter: blur(4px); }
.cover-btn.primary { background: var(--brand); border-color: var(--brand); }
.cover-btn:hover { filter: brightness(1.15); }
.prog-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(0, 0, 0, 0.42); }
.pb-fill { height: 100%; background: linear-gradient(90deg, var(--acc), #50c8ff); }
.vl-card .nm { font-size: 12.5px; font-weight: 600; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vl-card .au { font-size: 11px; color: var(--faint); margin-top: 2px; }
.vl-card .lc { font-size: 10.5px; color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
