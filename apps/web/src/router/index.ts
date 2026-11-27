import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';

import DashboardView from '../views/DashboardView.vue';
import SearchView from '../views/SearchView.vue';
import ShelfView from '../views/ShelfView.vue';
import VideoLibView from '../views/VideoLibView.vue';
import DiscoverView from '../views/DiscoverView.vue';
import SourceManagerView from '../views/SourceManagerView.vue';
import WorkshopView from '../views/WorkshopView.vue';
import SettingsView from '../views/SettingsView.vue';
import DictView from '../views/DictView.vue';
// B1 阅读统计（导航栏「字典」「设置」之间的面板项）
import StatsView from '../views/StatsView.vue';
// `#207`：整本下载任务中心（缓存/离线）
import DownloadsView from '../views/DownloadsView.vue';

/** 路由表（对齐 OmniFlow，无直播/IPTV）：
 *  01 首页 / 02 跨源搜索 / 03 书架 / 04 影视库
 *  05 书院(书/漫发现) / 06 影院(影视发现) / 07 RSS 发现
 *  08 规则工坊 / 09 源管理 / 10 设置 */
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: MainLayout,
    children: [
      { path: '', name: 'dashboard', component: DashboardView, meta: { title: '首页' } },
      { path: 'search', name: 'search', component: SearchView, meta: { title: '跨源搜索' } },
      { path: 'shelf', name: 'shelf', component: ShelfView, meta: { title: '书架' } },
      { path: 'video', name: 'video', component: VideoLibView, meta: { title: '影视' } },
      { path: 'discovery/books', name: 'discovery-books', component: DiscoverView, meta: { title: '书院 · 书源发现', kinds: ['legado'] } },
      { path: 'discovery/video', name: 'discovery-video', component: DiscoverView, meta: { title: '影院 · 影视源发现', kinds: ['maccms'] } },
      { path: 'discovery/rss', name: 'discovery-rss', component: DiscoverView, meta: { title: 'RSS 订阅发现', kinds: ['rss'] } },
      { path: 'workshop', name: 'workshop', component: WorkshopView, meta: { title: '规则工坊' } },
      { path: 'source-mgr', name: 'source-mgr', component: SourceManagerView, meta: { title: '源管理' } },
      { path: 'dict', name: 'dict', component: DictView, meta: { title: '字典' } },
      { path: 'stats', name: 'stats', component: StatsView, meta: { title: '阅读统计' } },
      { path: 'downloads', name: 'downloads', component: DownloadsView, meta: { title: '下载管理' } },
      { path: 'settings', name: 'settings', component: SettingsView, meta: { title: '设置' } },
      // 影视详情 / 播放器已改为**全局浮窗**（components/VDetailOverlay.vue 与
      // PlayerOverlay.vue，见 stores/vod.ts 注释）。旧路径保留重定向，避免历史链接/书签 404。
      { path: 'v-detail', redirect: '/' },
      { path: 'player', redirect: '/' },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHashHistory(), // Hash：服务端无需 SPA fallback
  routes,
  scrollBehavior() {
    return { top: 0 };
  },
});

router.afterEach((to) => {
  const t = (to.meta?.title as string) || 'YueDu';
  document.title = `${t} · 阅读 YueDu`;
});

export default router;
