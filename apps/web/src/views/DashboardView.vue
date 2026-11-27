<script setup lang="ts">
/**
 * DashboardView —— 复用 OmniFlow 首页骨架（Hero + Mini Stats + 继续观看/继续阅读）
 * 数据接 YueDu 自己的 stores（sources / reader 观影历史 + 书架）
 */
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSourcesStore } from '../stores/sources';
import { useReaderStore, type ShelfBook, type WatchEntry } from '../stores/reader';
import { useVodStore } from '../stores/vod';

// 封面统一走服务端代理（防盗链 Referer + 源图片解密 + 动图原样透传）——见 utils/img.ts
import CoverImage from '../components/CoverImage.vue'; /* `#163` 封面统一出口 */
import { imgSrc } from '../utils/img';
const router = useRouter();
const st = useSourcesStore();
const reader = useReaderStore();

const vod = useVodStore();

onMounted(() => void st.loadMeta());

const enabledCount = computed(() => st.sources.filter((s) => s.state.enabled).length);
const bookCount = computed(() => st.sources.filter((s) => s.kind === 'legado').length);
const videoCount = computed(() => st.sources.filter((s) => s.kind === 'maccms').length);
const rssCount = computed(() => st.sources.filter((s) => s.kind === 'rss').length);
const errorCount = computed(() => st.sources.filter((s) => (s.comment ?? '').includes('//error')).length);

const recentRead = computed(() => reader.bookShelf.slice(0, 6));
const recentWatch = computed(() => reader.watchSorted.slice(0, 6));

function posterClass(i: number): string {
  return 'p' + ((i % 8) + 1);
}
function openBook(b: ShelfBook) {
  void reader.openShelfBook(b);
}
function openWatch(e: WatchEntry) {
  // 影视详情改为**浮窗**（openDetail 内部即置 detailOpen=true），不再整页跳转
  vod.openDetail({ sourceId: e.sourceId, payload: e.payload, title: e.title, cover: e.cover });
}
function whenLabel(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 3600e3) return `${Math.max(1, Math.floor(diff / 60e3))} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}
</script>

<template>
  <div class="dash">
    <!-- Hero -->
    <div class="hero">
      <div class="in">
        <h2>阅读 YueDu</h2>
        <p>插件式解析引擎聚合 · Legado 书源 / MacCMS（苹果CMS）影视 / RSS 订阅</p>
        <div class="hstats">
          <div class="hstat"><b>{{ st.sources.length }}</b><i>已导入源</i></div>
          <div class="hstat"><b>{{ enabledCount }}</b><i>已启用</i></div>
          <div class="hstat"><b>{{ st.engines.length }}</b><i>解析引擎</i></div>
          <div class="hstat"><b>{{ errorCount }}</b><i>校验失败标记</i></div>
        </div>
      </div>
    </div>

    <!-- Mini Stats -->
    <div class="mini-stats">
      <div class="card mstat" @click="router.push('/discovery/video')">
        <b style="color: var(--cy)">{{ videoCount }}</b><span>影视源 · MacCMS</span>
        <span v-if="videoCount" class="trend" style="color: var(--green)">↗ 已就绪</span>
        <span v-else class="trend" style="color: var(--muted)">待导入</span>
      </div>
      <div class="card mstat" @click="router.push('/discovery/books')">
        <b style="color: var(--acc)">{{ bookCount }}</b><span>书源 / 漫画源</span>
        <span v-if="bookCount" class="trend" style="color: var(--green)">可搜索 {{ st.eligible }} 个</span>
        <span v-else class="trend" style="color: var(--muted)">未导入</span>
      </div>
      <div class="card mstat" @click="router.push('/shelf')">
        <b style="color: var(--gold)">{{ reader.bookShelf.length }}</b><span>书架藏書</span>
        <span class="trend" style="color: var(--muted)">含阅读进度</span>
      </div>
      <div class="card mstat" @click="router.push('/discovery/rss')">
        <b style="color: var(--orange)">{{ rssCount }}</b><span>RSS 订阅源</span>
        <!-- `#304` 起 RSS 引擎三批已交付（列表 / 正文 / URL 语义）⇒ 这里不再写「引擎规划中」 -->
        <span class="trend" style="color: var(--muted)">订阅解析可用</span>
      </div>
    </div>

    <!-- 继续观看 -->
    <div class="sec-head">
      <h2>▶ 继续观看</h2><span class="sub">观影历史 · 自动记录</span>
      <span class="more" v-if="recentWatch.length" @click="router.push('/video')">影视库 ›</span>
    </div>
    <div v-if="recentWatch.length" class="grid cols6">
      <div v-for="(e, i) in recentWatch" :key="e.title" class="poster-wrap">
        <div class="poster" :class="posterClass(i)" @click="openWatch(e)">
          <!-- `#163`：`.ph` 文字层与 `plain` 已撤（用户 2026-10-01 纠错）。
               ⚠️ 这里原本**没有**下方信息区，`.ph` 一撤，有真封面时片名就彻底没了
               ⇒ 补一个下方信息区（与书架/影院同口径），而不是把字画回封面上。 -->
          <CoverImage class="poster-img" :cover="e.cover" :source-id="e.sourceId" :title="e.title" :index="i" />
          <div class="play-overlay"><span class="p-ic">▶</span><span class="p-txt">继续</span></div>
        </div>
        <div class="p-nm" :title="e.title">{{ e.title }}</div>
        <div class="p-au">{{ e.lastEpisode?.title || '尚未播放' }}</div>
        <div v-if="e.updatedAt" class="p-au dim">{{ whenLabel(e.updatedAt) }}</div>
      </div>
    </div>
    <div v-else class="card empty-sec" style="margin-bottom: 24px">
      <div class="es-ic">🎬</div>
      <div class="es-text">
        <div class="es-t">还没有观看记录</div>
        <div class="es-s">在 <a @click="router.push('/discovery/video')">影院</a> 发现感兴趣的影片，打开详情后进度会出现在这里。</div>
      </div>
      <button class="empty-btn" @click="router.push('/discovery/video')">去影院看看 →</button>
    </div>

    <!-- 继续阅读 -->
    <div class="sec-head">
      <h2>📚 继续阅读</h2><span class="sub">书架同步 · 含漫画</span>
      <span class="more" v-if="recentRead.length" @click="router.push('/shelf')">书架 ›</span>
    </div>
    <div v-if="recentRead.length" class="grid cols6">
      <div v-for="(b, i) in recentRead" :key="b.title">
        <div class="poster" :class="posterClass(i)" @click="openBook(b)">
          <CoverImage class="poster-img" :cover="b.cover" :source-id="b.sourceId" :title="b.title" :author="b.author" :index="i" />
        </div>
        <div class="p-nm" :title="b.title">{{ b.title }}</div>
        <div class="p-au">{{ b.author || '未知作者' }}</div>
        <div class="p-au">{{ b.lastChapter ? `读到：${b.lastChapter.title}` : '未开始阅读' }}</div>
      </div>
    </div>
    <div v-else class="card empty-sec">
      <div class="es-ic">📚</div>
      <div class="es-text">
        <div class="es-t">书架空空如也</div>
        <div class="es-s">在 <a @click="router.push('/discovery/books')">书院</a> 或 <a @click="router.push('/search')">搜索</a> 找到书籍，详情页点「加入书架」。</div>
      </div>
      <button class="empty-btn" @click="router.push('/discovery/books')">去书院看看 →</button>
    </div>
  </div>
</template>

<style scoped>
.hero {
  border-radius: 16px; overflow: hidden; position: relative; height: 200px;
  /* `#163`：原来写死深色渐变（#1b2244→#0e1120），换亮色主题后主页仍是一片黑。
     改为主题派生：品牌柔色打底 + 卡片底色，任何主题下都跟主题走 */
  background: linear-gradient(120deg, var(--brand-soft), transparent 62%), var(--bg-1);
  display: flex; align-items: center; padding: 0 34px; margin-bottom: 22px;
  border: 1px solid var(--line);
}
.hero::after { content: ''; position: absolute; right: -60px; top: -60px; width: 300px; height: 300px; border-radius: 50%; background: radial-gradient(circle, var(--acc-glow), transparent 65%); }
.hero::before { content: ''; position: absolute; right: 80px; bottom: -80px; width: 220px; height: 220px; border-radius: 50%; background: radial-gradient(circle, var(--brand-soft), transparent 65%); }
.hero .in { position: relative; z-index: 1; }
.hero h2 { font-size: 24px; font-weight: 800; letter-spacing: 1px; }
.hero p { color: var(--muted); margin-top: 8px; font-size: 13px; }
.hstats { display: flex; gap: 26px; margin-top: 18px; }
.hstat b { font-size: 20px; font-family: var(--mono); color: var(--cy); display: block; }
.hstat i { font-style: normal; font-size: 11px; color: var(--muted); }
.mini-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 22px; }
.mstat { padding: 16px; display: flex; flex-direction: column; gap: 6px; cursor: pointer; transition: all 0.18s; }
.mstat:hover { background: var(--bg-2); filter: brightness(1.06); }
.mstat b { font-size: 22px; font-family: var(--mono); }
.mstat span { font-size: 12px; color: var(--muted); }
.mstat .trend { font-size: 11px; }
.sec-head { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; }
.sec-head h2 { font-size: 16px; font-weight: 700; margin: 0; }
.sec-head .sub { font-size: 12px; color: var(--muted); }
.sec-head .more { margin-left: auto; font-size: 12px; color: var(--cy); cursor: pointer; }
.sec-head .more:hover { text-decoration: underline; }
.grid.cols6 { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px; margin-bottom: 24px; }
@media (max-width: 1280px) { .grid.cols6 { grid-template-columns: repeat(4, 1fr); } .mini-stats { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 1024px) { .grid.cols6 { grid-template-columns: repeat(3, 1fr); } }

/* 海报（含悬浮播放） */
.poster-wrap { min-width: 0; }
/* ★ `#186` 用 `background-color` 长写：`background` 简写会重置 `background-size`，
   盖掉 CoverImage 里 `.cv-gen { background-size: cover }` ⇒ 默认封面只显示左上角 */
.poster { position: relative; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); transition: transform 0.2s; background-color: var(--bg-3); }
.poster:hover { transform: translateY(-4px); }
.poster-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
/* 下方信息行（`#163`：`.ph` 覆盖层已撤，信息不再画在封面上，改为封面下方常驻三行。
   口径与书架 `.book-card .nm/.au`、影院 `.vl-card .nm/.au/.lc` 一致：
   第一行标题（超长省略）、第二行副信息、第三行更弱的补充。 */
.p-nm { font-size: 12.5px; font-weight: 600; margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-au { font-size: 11px; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p-au.dim { color: var(--faint); font-size: 10.5px; }
.play-overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 4px;
  align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45); opacity: 0; transition: opacity 0.18s;
}
.poster:hover .play-overlay { opacity: 1; }
.p-ic { font-size: 26px; color: #fff; }
.p-txt { font-size: 11px; color: #ddd; }
.empty-sec { display: flex; align-items: center; gap: 16px; padding: 22px 24px; background: var(--bg-1); }
.empty-sec .es-ic { font-size: 34px; width: 60px; height: 60px; display: flex; align-items: center; justify-content: center; border-radius: 16px; background: linear-gradient(135deg, rgba(108, 124, 255, 0.18), rgba(80, 200, 255, 0.18)); border: 1px solid var(--line); flex-shrink: 0; }
.empty-sec .es-text { flex: 1; }
.empty-sec .es-t { font-weight: 700; font-size: 14px; }
.empty-sec .es-s { font-size: 12px; color: var(--muted); margin-top: 4px; }
.empty-sec .es-s a { cursor: pointer; color: var(--cy); }
.empty-btn { padding: 9px 16px; border-radius: 9px; border: 1px solid var(--line2); background: var(--bg-3); color: var(--text); font-size: 13px; cursor: pointer; white-space: nowrap; }
.empty-btn:hover { border-color: var(--acc-dim); }
</style>
