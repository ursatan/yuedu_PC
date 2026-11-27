<script setup lang="ts">
/**
 * MainLayout —— 复用 OmniFlow 布局骨架（el-container 四态导航 + crumb 顶栏）
 * 保留 YueDu 自己的：品牌区（顶部）、服务状态（底部）、全局搜索顶栏、导航项（无直播/IPTV）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Search, Location } from '@element-plus/icons-vue';
import { useSourcesStore } from '../stores/sources';
import { useSyncStore } from '../stores/sync';
import ReaderOverlay from '../components/ReaderOverlay.vue';
import AudioPlayer from '../components/AudioPlayer.vue';
import NavIcon from '../components/NavIcon.vue';
// 影视链浮窗（原 VDetailView / PlayerView 整页跳转的浮窗化 —— 见 stores/vod.ts 注释）
import VDetailOverlay from '../components/VDetailOverlay.vue';
import SchemeImportHost from '../components/SchemeImportHost.vue';
import PlayerOverlay from '../components/PlayerOverlay.vue';
import { isDesktop } from '../desktop';
import { getSystemIdentity, type SystemIdentity } from '../ops-api';

const route = useRoute();
const router = useRouter();
const st = useSourcesStore();
/** 服务可达性 + 待同步（阶段 1.5 / `#143`）——**唯一实现**在 stores/sync.ts，这里只是显示 */
const sync = useSyncStore();

/* ---- 导航四态（对齐 OmniFlow） ---- */
type NavMode = 'wide' | 'narrow' | 'icon' | 'hidden';
const NAV_MODES: NavMode[] = ['wide', 'narrow', 'icon', 'hidden'];
const NAV_WIDTHS: Record<NavMode, string> = { wide: '240px', narrow: '88px', icon: '64px', hidden: '0px' };
const NAV_MODE_LABEL: Record<NavMode, string> = { wide: '宽态', narrow: '窄态', icon: '仅图标', hidden: '隐藏' };
const NAV_STORE_KEY = 'yuedu.ui.navMode';
const navMode = ref<NavMode>((localStorage.getItem(NAV_STORE_KEY) as NavMode) || 'wide');
const hiddenCtxVisible = ref(false);
const navWidth = computed(() => NAV_WIDTHS[navMode.value] ?? '240px');
const nextLabel = computed(() => {
  const idx = NAV_MODES.indexOf(navMode.value);
  return NAV_MODE_LABEL[NAV_MODES[(idx + 1) % NAV_MODES.length] ?? 'wide'] ?? '宽态';
});
function cycleNavMode() {
  const idx = NAV_MODES.indexOf(navMode.value);
  navMode.value = NAV_MODES[(idx + 1) % NAV_MODES.length] ?? 'wide';
  hiddenCtxVisible.value = false;
}
function onPickNavMode(m: string | number | object) {
  const mode = String(m) as NavMode;
  if (NAV_MODES.includes(mode)) navMode.value = mode;
}
function shortLabelOf(full: string): string {
  const s = (full ?? '').trim();
  if (!s) return '';
  const step1 = s.includes('·') ? (s.split('·')[0] ?? s) : s;
  const step2 = step1.includes(' / ') ? (step1.split(' / ')[0] ?? step1) : step1;
  return step2.length <= 4 ? step2 : step2.slice(0, 2);
}

/** `icon` 是 `components/NavIcon.vue` 里的图标名（统一线性 SVG），不再是字符 */
type NavItem = { path: string; label: string; shortLabel?: string; icon: string };
const groups: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '',
    items: [
      { path: '/', label: '首页', shortLabel: '首页', icon: 'home' },
      { path: '/search', label: '跨源搜索', shortLabel: '搜索', icon: 'search' },
    ],
  },
  {
    title: '我的库',
    items: [
      { path: '/shelf', label: '书架', shortLabel: '书架', icon: 'shelf' },
      // `#207` 整本下载任务中心（入口在书架/阅读器，这一页看进度与控制任务）
      { path: '/downloads', label: '下载管理', shortLabel: '下载', icon: 'download' },
      { path: '/video', label: '影视', shortLabel: '影视', icon: 'video' },
    ],
  },
  {
    title: '全源发现',
    items: [
      { path: '/discovery/books', label: '书院 · 书源', shortLabel: '书院', icon: 'book-open' },
      { path: '/discovery/video', label: '影院 · 影视源', shortLabel: '影院', icon: 'clapper' },
      { path: '/discovery/rss', label: 'RSS 订阅', shortLabel: 'RSS', icon: 'rss' },
    ],
  },
  {
    title: '工具',
    items: [
      { path: '/workshop', label: '规则工坊', shortLabel: '规则', icon: 'wrench' },
      { path: '/source-mgr', label: '源管理', shortLabel: '源管', icon: 'server' },
      { path: '/dict', label: '字典', shortLabel: '字典', icon: 'dict' },
      { path: '/stats', label: '阅读统计', shortLabel: '统计', icon: 'chart' },
      { path: '/settings', label: '设置', shortLabel: '设置', icon: 'gear' },
    ],
  },
];
const flat = groups.flatMap((g) => g.items);
const currentTitle = computed(() => flat.find((i) => i.path === route.path)?.label ?? '阅读 YueDu');

/* ---- 数据徽标（顶栏）：形态 · 端口 · 目录尾名 ----
 * 为什么常驻：同一台机器上可能存在「桌面端 / 独立 Web+server」两套服务，
 * 只有把当前页面连的**是哪一套、读哪个目录**摆在明面上，用户才不会看错库/改错源。
 * 悬停给完整路径与 instanceId 用于核对；两端 dataDir 相同则转红（不是真隔离）。
 */
const identity = ref<SystemIdentity | null>(null);
const idDirTail = computed(() => {
  const d = identity.value?.dataDir ?? '';
  if (!d) return '';
  const parts = d.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? d;
});
const idModeLabel = computed(() => (identity.value?.mode === 'desktop' ? '桌面' : '独立'));
const normDir = (s: string) => s.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
const sameDirAsPeer = computed(() => {
  const own = identity.value?.dataDir;
  const peer = identity.value?.peer?.dataDir;
  return !!own && !!peer && normDir(own) === normDir(peer);
});
const identityTip = computed(() => {
  const v = identity.value;
  if (!v) return '尚未读到服务身份（服务可能已停止）';
  const lines = [
    `形态：${v.mode === 'desktop' ? '桌面端托管' : '独立 Web+server'}（PID ${v.pid}）`,
    `端口：${v.port}`,
    `数据目录：${v.dataDir}`,
    `源库：${v.sourceDb}`,
    `实例：${v.instanceId} · 启动于 ${v.startedAt}`,
  ];
  if (v.peer) lines.push(`另一端口 ${v.peer.port}：${v.peer.dataDir}`);
  if (sameDirAsPeer.value) lines.push('⚠ 两端共用同一数据目录，并非独立');
  return lines.join('\n');
});
function refreshIdentity() {
  getSystemIdentity()
    .then((v) => { identity.value = v; })
    .catch(() => { /* 老服务没有该端点 ⇒ 保持上一次的值，徽标显示 — */ });
}

/* ---- 全局搜索（顶栏） ---- */
const keyword = ref((route.query.q as string) || '');
function goSearch() {
  void router.push({ path: '/search', query: keyword.value ? { q: keyword.value } : {} });
}

/* ---- 服务心跳（底部） ----
 * 2026-09-29（`#143`）：**删掉了这里原本自己那套 `ping` + 15s 定时器** ——
 * 「服务端可达吗」与 stores/sync.ts 维护的是**同一个语义**，两份必然会漂移
 * （用户会看到侧栏写「服务在线」而同步提示写「离线」）。现在只读 sync 的状态。
 */
/* ---- `#225` 重启服务（侧栏底部） ----
 * 为什么要有：本仓**没有热更新** —— 改完前端要 rebuild、改完服务端要重打 bundle，
 * 都得重启才生效。让用户回到桌面关掉 cmd 窗口再双击 start-server.bat 是纯体力活。
 */
const restarting = ref(false);
async function doRestart(): Promise<void> {
  if (restarting.value) return;
  const ok = window.confirm(
    '重启服务？\r\n\r\n'
    + '· 服务会中断几秒，这期间界面不可用；\r\n'
    + '· 正在跑的下载 / 同步会中断（任务已落盘，重启后可继续）。\r\n\r\n'
    + '确定要重启吗？',
  );
  if (!ok) return;
  restarting.value = true;
  try {
    // ⚠️ 用绝对路径：本文件被多处复用，相对 base 不一定一致
    const r = await fetch('/api/system/restart', { method: 'POST' })
      .then((x) => x.json() as Promise<{ ok?: boolean; message?: string } | null>)
      .catch(() => null);
    if (!r?.ok) {
      window.alert(`重启失败：${r?.message ?? '服务没有响应'}`);
      return;
    }
    // 等服务重新起来再刷新（最多 30s）—— 直接刷新会撞上「服务还没起来」的空白页
    for (let i = 0; i < 60; i += 1) {
      await new Promise((res) => setTimeout(res, 500));
      if (await sync.ping()) { window.location.reload(); return; }
    }
    window.alert('服务没有在 30 秒内回来 —— 请在托盘菜单点「重启服务」，或重新打开悦读客户端。');
  } finally {
    restarting.value = false;
  }
}

/**
 * `#242` **停止服务** —— 「重启」的孪生按钮。
 *
 * ## 为什么必须有
 * `#225` 的重启端点用 `detached: true` 拉起新进程（否则它随父进程一起没），
 * 代价是**新进程没有控制台窗口** ⇒ 用户「关掉 cmd 窗口」这个动作**杀不掉它**
 * （2026-10-03 实测：占用 3000 的 PID 23304 的父进程 12816 已 GONE，标准孤儿）。
 * 于是用户重开 bat 被挡、页面又还在线 ⇒ 只能去任务管理器手工找。
 * 这个按钮把「停掉它」变成界面上的一下。
 *
 * 它是**真的要停**，不是「恢复原状」—— 点了之后网页会失去后端，
 * 所以必须二次确认，且按钮与「重启」分开（别误点）。
 */
const stopping = ref(false);
async function doStop(): Promise<void> {
  if (stopping.value) return;
  const ok = window.confirm(
    '停止服务？\r\n\r\n'
    + '· 后端会真的退出，网页将无法继续使用（本地缓存的已下载内容仍可读）；\r\n'
    + '· 想再起来：托盘菜单「重启服务」，或重新打开 YueDu.exe。\r\n\r\n'
    + '确定要停止吗？',
  );
  if (!ok) return;
  stopping.value = true;
  try {
    const r = await fetch('/api/system/shutdown', { method: 'POST' })
      .then((x) => x.json() as Promise<{ ok?: boolean; mode?: string; message?: string } | null>)
      .catch(() => null);
    if (!r) {
      window.alert('停止失败：服务没有响应。');
      return;
    }
    if (!r.ok) {
      window.alert(r.message ?? '停止失败。');
      return;
    }
    // 服务已收到退出指令：给个明确落点，别让用户对着「仍在线」的界面怀疑人生
    window.alert('服务已停止。\n\n要再启动：托盘菜单「重启服务」，或重新打开 YueDu.exe。');
    sync.online = false;
  } finally {
    stopping.value = false;
  }
}

/**
 * `#243` 【服务】下拉的命令分发。
 *
 * 刻意**不复用** `doRestart`/`doStop` 里的确认弹窗时序：两者都自带二次确认
 * （重启影响进行中的下载/同步、停止会让网页失去后端）⇒ 菜单项点了仍要确认，
 * 否则「点一下就重启」是危险动作。
 */
function onServiceCommand(cmd: string): void {
  if (cmd === 'restart') void doRestart();
  else if (cmd === 'stop') void doStop();
}

/** 按钮上的文字/提示随状态走（宽导航才显示文字，窄导航只有图标 + tooltip） */
const serviceLabel = computed(() => {
  if (restarting.value) return '重启中…';
  if (stopping.value) return '停止中…';
  return '服务';
});
const serviceTip = computed(() => {
  if (restarting.value) return '正在重启服务…';
  if (stopping.value) return '正在停止服务…';
  return '服务：重启（改了前端/服务端后用它生效）· 停止（真退出；再启动用托盘「重启服务」或重新打开客户端）';
});

onMounted(() => {
  void st.loadMeta();
  refreshIdentity();
});
watch(() => route.query.q, (q) => {
  if (route.path === '/search' && typeof q === 'string') keyword.value = q;
});
watch(navMode, (v) => localStorage.setItem(NAV_STORE_KEY, v), { immediate: true });
</script>

<template>
  <el-container class="omni-root">
    <!-- 左侧导航 -->
    <el-aside :width="navWidth" :class="['omni-nav', 'nav-' + navMode]">
      <!-- 品牌（YueDu 保留） -->
      <div class="brand" :class="['brand-' + navMode]" @click="router.push('/')">
        <span class="logo-dot"><span class="logo-y">阅</span></span>
        <div v-if="navMode === 'wide'" class="brand-text">
          <div class="name">阅读 YueDu</div>
          <div class="sub">插件式解析引擎聚合</div>
        </div>
        <div v-else-if="navMode === 'narrow'" class="brand-text narrow">
          <div class="name">阅读</div>
        </div>
      </div>

      <!-- 激活项文字用品牌色：激活项底是 brand-soft（柔色），白字在亮底主题下看不清 -->
      <el-menu
        :default-active="route.path"
        router
        :class="['nav-menu', 'nav-' + navMode]"
        background-color="transparent"
        text-color="var(--text-1)"
        active-text-color="var(--brand)"
      >
        <template v-for="g in groups" :key="g.title || 'default'">
          <div v-if="g.title && navMode === 'wide'" class="menu-group">{{ g.title }}</div>
          <el-tooltip
            v-for="item in g.items"
            :key="item.path"
            :content="item.label"
            placement="right"
            :disabled="navMode !== 'icon'"
          >
            <el-menu-item :index="item.path" :class="['menu-item', 'menu-' + navMode]">
              <span class="mi-icon"><NavIcon :name="item.icon" /></span>
              <template #title>
                <span v-if="navMode !== 'icon'" :class="['nav-label', navMode === 'narrow' ? 'narrow' : '']">
                  {{ navMode === 'narrow' ? (item.shortLabel ?? shortLabelOf(item.label)) : item.label }}
                </span>
              </template>
            </el-menu-item>
          </el-tooltip>
        </template>
      </el-menu>

      <!-- 底部：服务状态 + 待同步（YueDu 保留；`#143` 加了同步指示） -->
      <div v-if="navMode !== 'hidden'" class="nav-footer" :class="'footer-' + navMode">
        <span class="dot" :class="sync.online ? 'ok' : 'bad'" :title="sync.online ? '服务在线' : '服务离线'"></span>
        <span v-if="navMode === 'wide'">{{ sync.online ? '服务在线' : '服务离线' }} · {{ st.sources.length }} 源</span>
        <span v-else-if="navMode === 'narrow'" class="footer-mini">{{ sync.online ? '在线' : '离线' }}</span>
        <!--
          同步指示：**在线且无待同步时不显示**（别占地方）。
          离线时它同时说明「本地照常可用」——否则用户会以为数据丢了。
        -->
        <template v-if="navMode === 'wide' && sync.visible">
          <span class="sync-tag" :class="sync.online ? 'warn' : 'bad'" :title="sync.msg || sync.text">
            {{ sync.online ? '⟳' : '⚠' }} {{ sync.text }}
          </span>
          <button class="sync-retry" :disabled="sync.busy" @click="void sync.retry()">
            {{ sync.busy ? '同步中…' : '重试' }}
          </button>
        </template>
        <!--
          `#243` **【服务】按钮**：把「重启」「停止」两枚收拢进一个下拉。

          ## 为什么收拢
          侧栏底部宽度有限（`narrow` 态只有一枚按钮的位置），两枚并排会把切换条挤走；
          而这两件事**同属一类**（都是「动服务进程」），摊平成两枚并列按钮反而弱化了它们的共性。

          ## 图标为什么自己画 SVG 而不用 emoji / 字符
          · `⟳`（U+27F3）在不同字体下粗细/位置差异很大，`⏻` 更是要靠符号字体才好看；
          · 项目已有内联 SVG 先例（`ShelfView.vue` 封面图标、`SourcePinButton.vue` 置顶箭头）；
          · 内联 SVG 可以精确控制 16×16 视框里的线宽与端点，与旁边 `nt-arrow` 同一套观感。
          齿轮是「设置/服务」的通用隐喻；下拉的展开方向在 CSS 里与 `nt-arrow` 对齐。
        -->
        <!--
          ★ `#245` `class` 必须挂在 **el-dropdown 自身**（Element Plus 把它渲染成
            `<div class="el-dropdown">`，而 `.nav-footer` 是 flex 容器 ⇒ **作为 flex 项的是这个 div**，
            不是它里面的 `<button>`）。之前 `margin-left: auto` 只写在 `.nav-restart`（按钮）上，
            而按钮不是 flex 项 ⇒ auto margin 完全不参与布局 ⇒ 齿轮按钮紧跟在
            「服务在线 · N 源」后面，没有靠到右边缘（用户 2026-10-03 19:22 实测）。
        -->
        <el-dropdown
          trigger="click" placement="top-end"
          class="nav-service-wrap"
          @command="onServiceCommand"
        >
          <button
            type="button"
            class="nav-restart nav-service" data-service-btn
            :disabled="restarting || stopping"
            :title="serviceTip"
            @click.stop
          >
            <!-- 齿轮（内联 SVG）：中心圆 + 8 个齿 -->
            <svg class="nr-icon ns-gear" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path
                d="M8 1.4v1.9M8 12.7v1.9M14.6 8h-1.9M3.3 8H1.4M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3M12.7 12.7l-1.3-1.3M4.6 4.6L3.3 3.3"
                fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
              />
            </svg>
            <span v-if="navMode === 'wide'" class="nr-text">{{ serviceLabel }}</span>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="restart" :disabled="restarting || stopping">
                <span class="ns-item">
                  <svg class="ns-ic" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path
                      d="M13 8a5 5 0 1 1-1.6-3.7M13 2.2V5h-2.8"
                      fill="none" stroke="currentColor" stroke-width="1.5"
                      stroke-linecap="round" stroke-linejoin="round"
                    />
                  </svg>
                  <span>{{ restarting ? '重启中…' : '重启服务' }}</span>
                </span>
              </el-dropdown-item>
              <el-dropdown-item command="stop" :disabled="restarting || stopping">
                <span class="ns-item">
                  <svg class="ns-ic" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path d="M8 1.8v6.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5" />
                    <path d="M4.6 4.6l6.8 6.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                  <span>{{ stopping ? '停止中…' : '停止服务' }}</span>
                </span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <!-- 切换条（OmniFlow） -->
      <el-dropdown trigger="contextmenu" class="nav-toggle-wrap" @command="onPickNavMode">
        <button
          type="button"
          class="nav-toggle-strip"
          :title="'点击切换导航（下一态：' + nextLabel + ' / 右键菜单选态）'"
          @click.stop.prevent="cycleNavMode"
        >
          <span class="nt-arrow"><span class="a-before"></span></span>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="m in NAV_MODES"
              :key="m"
              :command="m"
              :class="{ 'is-active': navMode === m }"
            >
              <span>{{ navMode === m ? '● ' : '○ ' }}{{ NAV_MODE_LABEL[m] }}</span>
              <span style="float: right; color: var(--faint)">{{ NAV_WIDTHS[m] }}</span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-aside>

    <!-- hidden 态：左边缘展开条 -->
    <div v-if="navMode === 'hidden'" class="hidden-toggle-wrap">
      <button
        type="button"
        class="nav-toggle-strip strip-hidden"
        title="展开导航栏（右键选态）"
        @contextmenu.prevent="hiddenCtxVisible = !hiddenCtxVisible"
        @click.stop.prevent="cycleNavMode"
      >
        <span class="nt-arrow"><span class="a-before"></span></span>
      </button>
    </div>
    <transition name="fade">
      <ul v-if="navMode === 'hidden' && hiddenCtxVisible" class="hidden-ctx-menu" @mouseleave="hiddenCtxVisible = false">
        <li
          v-for="m in NAV_MODES"
          :key="m"
          :class="{ on: navMode === m }"
          @click="onPickNavMode(m); hiddenCtxVisible = false;"
        >
          <span>{{ navMode === m ? '● ' : '○ ' }}{{ NAV_MODE_LABEL[m] }}</span>
          <span style="float: right; color: var(--faint)">{{ NAV_WIDTHS[m] }}</span>
        </li>
      </ul>
    </transition>

    <!-- 主区 -->
    <el-container class="omni-main">
      <el-header class="omni-header" :class="{ 'desktop-chrome': isDesktop() }" height="52px">
        <div class="crumb">
          <el-icon><Location /></el-icon>
          <span class="crumb-text">{{ currentTitle }}</span>
        </div>
        <el-input
          v-model="keyword"
          placeholder="跨源搜索书籍 / 影视… (Enter)"
          clearable
          class="global-search"
          @keyup.enter="goSearch"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <!-- 数据徽标：形态 · 端口 · 目录尾名（悬停看完整路径/源库/instanceId） -->
        <div
          class="data-badge"
          :class="{ danger: sameDirAsPeer }"
          :title="identityTip"
          data-identity-badge
        >
          <span class="db-mode">{{ identity ? idModeLabel : '—' }}</span>
          <span class="db-sep">·</span>
          <span class="db-port">{{ identity?.port ?? '—' }}</span>
          <span class="db-sep">·</span>
          <span class="db-dir">{{ idDirTail || '—' }}</span>
          <span v-if="sameDirAsPeer" class="db-warn">同目录</span>
        </div>
      </el-header>
      <el-main class="omni-content">
        <router-view />
      </el-main>
    </el-container>

    <!-- 全局浮层：阅读链 -->
    <ReaderOverlay />
    <!-- 全局浮层：影视链（详情 → 播放；原为整页路由，见 components/VDetailOverlay.vue） -->
    <VDetailOverlay />
    <!-- `#392` 唤起导入宿主（`#343`）：**常驻且不受任何浮层门控** ——
         原先它住在 `ReaderOverlay` 里，而那边根节点是 `v-if="r.open"` ⇒
         在登录界面/发现页的内置浏览器里点「导入书源」什么都不会发生。 -->
    <SchemeImportHost />
    <PlayerOverlay />
    <!-- 全局浮窗：音频播放（跨路由常驻，见 stores/audio.ts） -->
    <AudioPlayer />
  </el-container>
</template>

<style scoped>
.omni-root { height: 100%; background: var(--ui-page-bg); } /* `#163`：有壁纸时透明，壁纸才看得见 */
.omni-nav {
  position: relative;
  background: var(--nav-bg); /* `#163`：bottomBackground；沉浸模式下 transparent */
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-width: 0;
  transition: width 0.18s ease;
}
.omni-nav.nav-hidden { display: none !important; }

.brand { padding: 16px 14px 10px; display: flex; align-items: center; gap: 10px; cursor: pointer; overflow: hidden; }
.brand-narrow { flex-direction: column; padding: 14px 4px 8px; }
.brand-icon { justify-content: center; padding: 12px 0 8px; }
.logo-dot {
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 34px; height: 34px; border-radius: 9px;
  background: linear-gradient(135deg, var(--brand), var(--accent));
  box-shadow: 0 4px 10px rgba(79, 140, 255, 0.35);
}
.logo-y { color: #fff; font-weight: 800; font-size: 16px; }
.brand-text { line-height: 1.2; overflow: hidden; white-space: nowrap; }
.brand-text .name { font-weight: 700; font-size: 15px; }
.brand-text .sub { color: var(--muted); font-size: 11px; margin-top: 3px; }
.brand-text.narrow { text-align: center; }
.brand-text.narrow .name { font-size: 12px; }

.nav-menu { border-right: 0; padding: 6px 8px; overflow-x: hidden !important; overflow-y: auto !important; flex: 1; }
.menu-group { padding: 12px 16px 4px 10px; color: var(--muted); font-size: 11px; letter-spacing: 1.4px; }
.nav-menu :deep(.el-menu-item) {
  border-radius: 8px;
  margin-bottom: 2px;
  height: 40px;
  line-height: 40px;
  padding: 0 10px !important;
}
.nav-menu :deep(.el-menu-item.is-active) { background: var(--brand-soft) !important; color: var(--brand); } /* 柔色底 ⇒ 品牌色文字（白字在亮底主题下看不见，实测） */
.mi-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; flex-shrink: 0; }
/* 图标是统一线性 SVG（NavIcon.vue）：18px 常规，仅图标态放到 20px；颜色走 currentColor 跟随激活色 */
.mi-icon :deep(.nav-icon) { width: 18px; height: 18px; display: block; }
.nav-menu.nav-icon :deep(.mi-icon .nav-icon) { width: 20px; height: 20px; }
.nav-menu.nav-narrow :deep(.mi-icon .nav-icon) { width: 17px; height: 17px; }
.nav-label { color: var(--text-1); }
.nav-menu :deep(.el-menu-item.is-active) .nav-label { color: var(--brand); }
.nav-menu.nav-icon :deep(.el-menu-item) { justify-content: center; padding: 0 !important; height: 44px !important; }
.nav-menu.nav-narrow :deep(.el-menu-item) {
  flex-direction: column !important;
  justify-content: center !important;
  height: 56px !important;
  line-height: normal !important;
  gap: 2px;
}
.nav-label.narrow { font-size: 10px; text-align: center; line-height: 1.15; max-width: 60px; overflow: hidden; white-space: normal; }

.nav-footer {
  display: flex; align-items: center; gap: 6px;
  /* 加了同步指示后一行放不下（240px 宽）⇒ 允许换行；不加就会把「重试」按钮挤没 */
  flex-wrap: wrap; row-gap: 4px;
  padding: 10px 14px; border-top: 1px solid var(--border);
  color: var(--muted); font-size: 11px;
  white-space: nowrap; overflow: hidden;
}
.footer-icon, .footer-narrow { justify-content: center; }
.footer-mini { font-size: 10px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.ok { background: var(--green); animation: pulse 2.4s infinite; }
.dot.bad { background: var(--red); }

/* 同步指示（`#143`）：离线 / 有 N 项待同步。横幅窄，所以让它自己截断 + 换行放下重试按钮 */
.sync-tag {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis;
  padding: 1px 6px; border-radius: 6px; font-size: 10px;
}
.sync-tag.warn { background: rgba(255, 176, 32, 0.16); color: var(--yellow, #ffb020); }
.sync-tag.bad { background: rgba(255, 84, 112, 0.16); color: var(--red); }
.sync-retry {
  flex-shrink: 0;
  padding: 1px 7px; border-radius: 6px; cursor: pointer;
  font-size: 10px; font-family: var(--font);
  background: var(--bg-3); color: var(--text-1); border: 1px solid var(--border-strong);
}
.sync-retry:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand); }
.sync-retry:disabled { opacity: 0.6; cursor: default; }

/* `#225` 重启按钮：与「重试」同款尺寸，靠右、不抢同步指示的位置 */
.nav-restart {
  flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 7px; border-radius: 6px; cursor: pointer;
  font-size: 10px; font-family: var(--font);
  background: var(--bg-3); color: var(--text-1); border: 1px solid var(--border-strong);
}
.nav-restart:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand); }
.nav-restart:disabled { opacity: 0.6; cursor: default; }
.nr-icon { display: inline-block; font-size: 11px; line-height: 1; }
.nr-icon.spin { animation: nr-spin 0.9s linear infinite; }
@keyframes nr-spin { to { transform: rotate(360deg); } }

/* `#243` 【服务】按钮：内联 SVG 齿轮。
 * `.nav-restart` 提供尺寸/配色/边框，这儿只补「图标与文字要对齐」——
 * SVG 是 inline 元素，默认会留基线下的空隙 ⇒ 用 `vertical-align` + `display:block` 消掉。 */
.nav-service { gap: 5px; }
/* ★ `#245` 靠右对齐写在 **el-dropdown 的根 div** 上 —— 它才是 `.nav-footer` 的 flex 项
 *   （`margin-left:auto` 写在里面的 `<button>` 上完全不参与布局，这就是按钮没靠右的原因）。
 *   另压掉根 div 作为 inline-block 的基线间隙，否则它会低 1~2px。 */
.nav-service-wrap { margin-left: auto; display: inline-flex; line-height: 0; }
.ns-gear { display: block; flex: none; }
/* 齿轮的齿要能「转」才表示正在重启 —— 复用 `#225` 的 nr-spin，不另写一条 */
.nav-service:disabled .ns-gear { animation: nr-spin 0.9s linear infinite; }
/* 下拉项：图标 + 文字。Element Plus 的 dropdown-item 是 flex 也能居中，
   这里给内层 span 一层 flex，避免图标与文字基线错位。 */
.ns-item { display: inline-flex; align-items: center; gap: 7px; }
.ns-ic { display: block; flex: none; opacity: 0.75; }

/* 切换条（OmniFlow 胶囊） */
.nav-toggle-wrap { position: absolute; top: 50%; right: 2px; transform: translateY(-50%); z-index: 10; }
.nav-toggle-strip {
  width: 18px; min-height: 56px;
  border: 1px solid var(--border-strong); border-radius: 10px;
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  cursor: pointer; color: var(--text-1);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 4px 0; transition: background 150ms ease, color 150ms ease, border-color 150ms ease;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25);
}
.nav-toggle-strip:hover {
  background: linear-gradient(180deg, rgba(79, 140, 255, 0.25), rgba(160, 112, 255, 0.2));
  color: var(--brand); border-color: var(--acc-dim); /* 同上：悬停底是 25% 品牌柔色，不是实色 */
}
.nt-arrow { position: relative; width: 16px; height: 14px; display: block; }
.nt-arrow .a-before {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 0; height: 0; border: 6px solid transparent;
  border-right-color: currentColor; border-left-width: 0;
}
.hidden-toggle-wrap { position: fixed; top: 0; left: 0; width: 8px; height: 100vh; z-index: 9999; }
.strip-hidden { width: 100%; height: 100%; border: 0; border-right: 1px solid var(--border-strong); background: linear-gradient(180deg, var(--bg-3), var(--bg-2)); color: var(--text-0); cursor: pointer; position: relative; }
.strip-hidden .nt-arrow .a-before { border-right-color: transparent; border-left-color: currentColor; }
.hidden-ctx-menu {
  position: fixed; left: 14px; top: 50%; transform: translateY(-50%); z-index: 10000;
  list-style: none; padding: 6px 0; margin: 0; min-width: 160px;
  background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 8px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
}
.hidden-ctx-menu li { padding: 7px 12px; cursor: pointer; font-size: 13px; color: var(--text-1); }
.hidden-ctx-menu li:hover, .hidden-ctx-menu li.on { background: var(--brand-soft); color: var(--brand); }
.fade-enter-active, .fade-leave-active { transition: opacity 120ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* 主区 */
.omni-main { display: flex; flex-direction: column; min-width: 0; }
.omni-header {
  background: var(--nav-bg); /* `#163`：同侧栏，取 bottomBackground */
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 18px;
  padding: 0 20px;
}
/* 桌面端主窗用 `titleBarStyle:'hidden'`：正常窗保留原生控件，顶栏给右上角控件留出 140px，
   空白区域作为窗口拖动区（输入框/按钮必须 no-drag，否则点不动）。 */
.omni-header.desktop-chrome {
  -webkit-app-region: drag;
  padding-right: 140px;
}
.omni-header.desktop-chrome .global-search {
  -webkit-app-region: no-drag;
}
.crumb { display: flex; align-items: center; gap: 8px; color: var(--text-1); min-width: 140px; }
.crumb-text { font-weight: 600; color: var(--text-0); }
/* 顶栏右侧动作（新建源 / 设置）已移除：搜索框保持原来的 640px 上限，
   不随空出来的位置拉长（`flex: 1` 只吃剩余空间，到达上限就停）。 */
.global-search { flex: 1; max-width: 640px; }
/* 顶栏右侧常驻数据徽标：告诉用户「这页连的是哪一套、读哪个目录」 */
.data-badge {
  margin-left: auto;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-2); color: var(--muted);
  font-size: 12px; line-height: 1.6; white-space: nowrap; cursor: default;
  -webkit-app-region: no-drag;
}
.data-badge .db-port { font-variant-numeric: tabular-nums; }
.data-badge .db-dir { color: var(--text-0); font-weight: 600; }
.data-badge.danger {
  background: var(--red, #e5484d); border-color: var(--red, #e5484d); color: #fff;
}
.data-badge.danger .db-dir { color: #fff; }
.data-badge .db-warn { font-weight: 700; }
.omni-content { padding: 20px 24px; background: var(--ui-page-bg); overflow: auto; height: calc(100vh - 52px); }
</style>
