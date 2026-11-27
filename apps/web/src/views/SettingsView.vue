<script setup lang="ts">
import { useSourcesStore } from '../stores/sources';
import { useReaderStore } from '../stores/reader';
import { useDiscoverStore } from '../stores/discover';
// `#145`：主题 4 档（取值与文案照抄上游 arrays.xml 的 theme_mode）
import { READER_THEME_MODES as THEME_MODES } from '../styles/reader-theme';
// `#163`：界面主题（内置壁纸预设 + 给 <input type=color> 的 6 位归一）
import { WALLPAPER_PRESETS, toRrGgBb } from '../styles/ui-theme';
// `#206`：主题包的导入/导出（格式与校验见 utils/theme-transfer.ts 的上游依据）
import { themeBundleFileName, parseThemeInput } from '../utils/theme-transfer';
import { UI_THEME_PRESETS } from '@yuedu/core/contract';
// `#144`：用户全局净化（替换）规则面板
import ReplaceRulesPanel from '../components/ReplaceRulesPanel.vue';
// `#574` 站点定制批量管理：与阅读器/内置浏览器用**同一个编辑器**、**同一份本地配置**
import SiteCustomizeDialog from '../components/SiteCustomizeDialog.vue';
// `#816` B5 六类缓存治理（分类占用 / 单类清理 / 配额可调）
import CacheGovernancePanel from '../components/CacheGovernancePanel.vue';
import TtsEnginePanel from '../components/TtsEnginePanel.vue';
import { listSiteCustomize, removeSiteCustomize, onSiteCustomizeChange } from '../site-customize';
// `#635` 启停（本机偏好）+ 列表展示用纯逻辑（源归属 / 更新时间 / 内容摘要）
import { isSiteCustomizeEnabled, setSiteCustomizeEnabled } from '../site-customize';
import {
  formatSiteUpdatedAt,
  readDisabledHosts,
  siteCustomizeSummary,
  siteSourceRefs,
} from '../utils/site-customize-manage';
import type { SiteCustomize } from '@yuedu/core/site-customize';
// `#201`：用户数据导出/导入（导入后要重新对齐这些 store）
import { useReplaceRulesStore } from '../stores/replaceRules';
import { useDictStore } from '../stores/dict';
import { getSnapshot, importSnapshot } from '../user-data';
import type { ImportResult } from '@yuedu/core/contract';
// `#210` 运维分区：端点薄封装统一在这（URL 与方法只有这一份）
import {
  getDiag,
  getPatrolConfig,
  getShelfUpdate,
  getSystemErrors,
  runShelfUpdate,
  savePatrolConfig,
  saveShelfUpdateConfig,
} from '../ops-api';
import type { DiagInfo, PatrolConfig, ShelfUpdateStatus } from '../ops-api';
// `#208` ⑤ UI 集成：WebDAV 同步 + 源分享（直链上传规则）
import {
  getWebDav, putWebDav, deleteWebDav, testWebDav, syncWebDav,
  listWebDavBackups, webDavBackup, webDavRestore, getBackupOptions,
  getBackupModes, inspectBackupZip, applyBackup, exportBackupZip,
  type BackupModesPayload, type BackupInspectResult, type BackupFormat,
  type BackupOptionMeta, type BackupOptionsPayload,
  getDirectLinkState, putDirectLinkRule, resetDirectLinkRule, testDirectLink,
  type WebDavPublicConfig, type WebDavSyncReport, type WebDavBackupItem,
  type DirectLinkState, type DirectLinkTestOutcome,
  getNetworkProxy,
  putNetworkProxy,
  getBrowserContextMode,
  setBrowserContextMode,
  clearAllCookies,
} from '../api';
import { clearAllCache } from '../utils/chapter-cache';
import { toast } from '../toast';
// `#793` 默认封面自定义图（IndexedDB 存字节，偏好只留标记）；预览复用统一封面组件
import CoverImage from '../components/CoverImage.vue';
import { removeDefaultCoverImage, saveDefaultCoverImage } from '../utils/default-cover';
import {
  BUILT_IN_DEFAULT_COVER_PATH,
  DEFAULT_COVER_MARKER,
  isCustomDefaultCoverPath,
  validateDefaultCoverFile,
} from '../utils/default-cover-core';
// `#811` 翻页动画档位（视图模式入口已按用户 2026-11-09 要求从设置页移除，只在阅读界面）
import { PAGE_ANIM_OPTIONS } from '../utils/reader-view-mode';
// B8 屏幕常亮：与阅读界面「更多 → 样式 → 动画」共用 `utils/keep-awake.ts` 的同一个 ref
import { keepAwakePref, keepAwakeSupported, setKeepAwakePref } from '../utils/keep-awake';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
// `#209` 桌面端（Electron 外壳）：托盘 / 全局快捷键 / 文件关联 / 开机自启 / 打开本地书
import {
  isDesktop, getDesktopStatus, setDesktopPrefs, setFileAssoc, setProtocolAssoc, setAutoLaunch,
  toggleMainWindow, pickAndOpenLocalBook, pickDataDir,
  type DesktopStatus, type DesktopPrefs,
} from '../desktop';

const st = useSourcesStore();
const reader = useReaderStore();
const disc = useDiscoverStore();
const replaceRules = useReplaceRulesStore();
const dict = useDictStore();
const origin = window.location.origin;

/**
 * `#811` 设置页 → **翻页动画**档位。
 * （用户 2026-11-09：设置页里的「阅读视图模式」与「自动滚动速度」已移除 ——
 *  它们与阅读界面「更多 → 样式 → 动画」重复；屏幕常亮迁到这里，与阅读页共用同一份偏好。）
 */
function onPageAnimChange(e: Event): void {
  const n = Number((e.target as HTMLSelectElement).value);
  if (!Number.isFinite(n)) return;
  reader.patchReadStyle({ pageAnim: n });
}

/** 当前生效的那套界面主题（响应式：改颜色后这里立刻跟着变） */
const theme = computed(() => reader.uiTheme);
/** 另存命名主题的输入框内容 */
const saveName = ref('');
/** `#206` 主题导入/导出：上一次操作的结果（**如实报告**，不静默） */
const themeXferMsg = ref('');
const themeXferBusy = ref(false);

/**
 * `#206` 导入主题包。
 *
 * ## `exists` 判定为什么这么写
 * `theme-transfer` 的 `probeWallpapers` 要判断「主题里的壁纸路径在本机存不存在」。
 * **浏览器没有同步 fs** ⇒ 传一个保守判定：只对 `data:image` 与 `http(s)` 返回 true，
 * 绝对路径一律判「不存在」⇒ 该主题的壁纸被清成 `null` 并在消息里点名。
 *
 * 后果要说明白：从**别的机器**导进来的主题，若带的是导出者的本机路径，壁纸本来也用不了；
 * 而**自己**备份自己再用时会丢掉自定义壁纸 —— 权衡后选择「宁可干净，不留一个必然失效的路径」
 * （留着的后果是界面背景变空白且没有任何提示）。
 */
function onImportThemesFile(e: Event): void {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = ''; // 允许重复选同一个文件
  if (!f) return;
  void (async () => {
    // ★ `#272`：文件内容进对话框的 textarea ⇒ 与「粘贴」走**同一条**预览路径
    //   （宽容解析 parseThemeInput：主题包 / 裸单主题 / 裸数组都认）。
    themeImportText.value = await f.text();
    themeImportOpen.value = true;
  })();
}

/**
 * `#272`（用户 2026-10-04 晚）：主题导入改**对话框**形式（对齐字典导入）——
 * 可粘贴、可选文件，两种来源都进同一条预览（解析条数、新增/重复/错误），确认才导入。
 * 解析 = `parseThemeInput`（宽容：主题包外壳 / 裸单主题 / 裸数组；备份文件仍明确拦下），
 * 与确认导入用的 `importThemeRules` 共享解析结果 ⇒ 「预览说几套，导入就进几套」。
 */
const themeImportOpen = ref(false);
const themeImportText = ref('');
const themeImportParsed = computed(() =>
  themeImportText.value.trim() ? parseThemeInput(themeImportText.value) : null,
);
/** 重复 = 与现有命名主题同名（与「覆盖后同名归一」同一判定） */
const themeImportDupNames = computed(() => {
  if (!themeImportParsed.value) return new Set<string>();
  const names = new Set(reader.prefs.uiThemes.map((t) => t.themeName));
  return new Set(themeImportParsed.value.valid.filter((t) => names.has(t.themeName)).map((t) => t.themeName));
});
const themeImportable = computed(() => {
  const p = themeImportParsed.value;
  if (!p) return 0;
  return themePreviewMode.value === 'keepExisting'
    ? p.valid.length - themeImportDupNames.value.size
    : p.valid.length;
});
function openThemeImport(): void {
  themeImportText.value = '';
  themeImportOpen.value = true;
}
function cancelThemeImport(): void {
  themeImportOpen.value = false;
  themeImportText.value = '';
}
function confirmThemeImport(): void {
  const p = themeImportParsed.value;
  if (!p || !p.valid.length) return;
  themeXferBusy.value = true;
  void (async () => {
    try {
      const r = reader.importThemeRules(
        p.valid,
        themePreviewMode.value,
        (path) => /^data:image|^https?:/i.test(path),
        p.rejected,
      );
      const parts: string[] = [];
      if (r.error) {
        themeXferMsg.value = '导入失败：' + r.error;
        window.alert(themeXferMsg.value);
        return;
      }
      parts.push(`已导入 ${r.imported} 套`);
      if (r.rejected.length) {
        parts.push(`丢弃 ${r.rejected.length} 条（${r.rejected.map((x) => `第 ${x.index + 1} 条：${x.reason}`).join('；')}）`);
      }
      if (r.wallpaperDropped.length) {
        parts.push(`有 ${r.wallpaperDropped.length} 套的壁纸指向本机不存在的文件，已清空（${r.wallpaperDropped.join('、')}）`);
      }
      themeXferMsg.value = parts.join('；');
      cancelThemeImport();
    } catch (err) {
      themeXferMsg.value = '导入失败：' + (err instanceof Error ? err.message : String(err));
      window.alert(themeXferMsg.value);
    } finally {
      themeXferBusy.value = false;
    }
  })();
}

/** `#272` 重复处理：merge = 同名覆盖；keepExisting = 同名跳过（`importThemeRules` 原生两种模式） */
const themePreviewMode = ref<'merge' | 'keepExisting'>('merge');

/** `#271`：主题下拉（自定义，每项带 ✕）—— 当前生效主题与内置 5 套不可删 */
const themeDdOpen = ref(false);
const builtinThemeNames = computed(() => new Set(UI_THEME_PRESETS.map((t) => t.themeName)));
function onPickUiTheme(name: string): void {
  reader.applyUiTheme(name);
}
function removeThemeItem(name: string): void {
  if (!confirm(`删除命名主题「${name}」？（当前生效的样式不受影响）`)) return;
  reader.deleteUiTheme(name);
  themeXferMsg.value = `已删除主题「${name}」`;
}
/** 点击面板其它位置收起主题下拉 */
function onDocClickCloseThemeDd(): void {
  themeDdOpen.value = false;
}
onMounted(() => document.addEventListener('click', onDocClickCloseThemeDd));
onBeforeUnmount(() => document.removeEventListener('click', onDocClickCloseThemeDd));
onBeforeUnmount(() => {
  // `#210`：离开页面必须停掉运维轮询（组件销毁了定时器还活着 = 白打请求）
  if (opsTimer) { clearInterval(opsTimer); opsTimer = null; }
});

/**
 * `#206` 导出主题包。
 * @param onlyCurrent 只导当前生效的这一套（否则导全部命名主题）
 */
function doExportThemes(onlyCurrent: boolean): void {
  themeXferBusy.value = true;
  try {
    const text = onlyCurrent ? reader.exportCurrentUiThemeText() : reader.exportUiThemesText();
    const n = onlyCurrent ? 1 : reader.prefs.uiThemes.length;
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = themeBundleFileName();
    a.click();
    URL.revokeObjectURL(url);
    themeXferMsg.value = `已导出 ${n} 套主题`;
  } catch (e) {
    themeXferMsg.value = '导出失败：' + (e instanceof Error ? e.message : String(e));
    window.alert(themeXferMsg.value);
  } finally {
    themeXferBusy.value = false;
  }
}

/** 本机图片 → data URL。⚠️ 上限 400KB：偏好是一个 JSON 对象（localStorage 5MB + 服务端同步），
 *  塞一张几 MB 的原图进去会把整个 prefs 拖垮 —— 截断是**有意**的，不是偷懒。 */
function onWallpaperFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 400 * 1024) {
    window.alert('图片超过 400KB —— 请压缩后再选（偏好数据会跟着服务端同步，不能太大）');
    (e.target as HTMLInputElement).value = '';
    return;
  }
  const fr = new FileReader();
  fr.onload = () => reader.patchUiTheme({ backgroundImgPath: String(fr.result) });
  fr.readAsDataURL(f);
}

/* ------------------------------------------------------------------ *
 * `#793` 设置 → 外观 → 默认封面（自定义图片）
 * ------------------------------------------------------------------ */
/** 文件选择框（隐藏，按钮触发） */
const coverFileEl = ref<HTMLInputElement | null>(null);
const coverBusy = ref(false);
/** 是否已经写入自定义标记（**不清空旧图再替换**：这里只决定按钮文案/可用性） */
const hasCustomCover = computed(() =>
  isCustomDefaultCoverPath(reader.prefs.cover.defaultCoverPath)
  || isCustomDefaultCoverPath(reader.prefs.cover.defaultCoverDarkPath),
);
function pickDefaultCover(): void {
  if (coverBusy.value) return;
  coverFileEl.value?.click();
}
async function onDefaultCoverFile(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = ''; // 允许重复选同一个文件
  if (!f || coverBusy.value) return;
  const reject = validateDefaultCoverFile({ name: f.name, type: f.type, size: f.size });
  if (reject === 'size') { toast('图片超过 2MB —— 请压缩后再选', 'warn', 8000); return; }
  if (reject === 'type') { toast('只支持 PNG / JPG / WebP 图片', 'warn', 8000); return; }
  if (reject === 'empty') { toast('这个文件是空的，换一张图片试试', 'warn', 8000); return; }
  coverBusy.value = true;
  try {
    // 先落盘 + 预加载成功，再写偏好 ⇒ 切换那一刻不会出现白块/闪动
    await saveDefaultCoverImage(f);
    reader.patchCover({ defaultCoverPath: DEFAULT_COVER_MARKER, defaultCoverDarkPath: DEFAULT_COVER_MARKER });
    toast('已应用自定义默认封面', 'info', 5000);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'warn', 9000);
  } finally {
    coverBusy.value = false;
  }
}
/** 恢复默认 = 写回契约默认值（内置默认封面），并删掉自定义图 */
async function resetDefaultCover(): Promise<void> {
  if (coverBusy.value) return;
  coverBusy.value = true;
  try {
    await removeDefaultCoverImage();
    reader.patchCover({ defaultCoverPath: BUILT_IN_DEFAULT_COVER_PATH, defaultCoverDarkPath: BUILT_IN_DEFAULT_COVER_PATH });
    toast('已恢复内置默认封面', 'info', 5000);
  } finally {
    coverBusy.value = false;
  }
}
/** 清除 = 删掉自定义图 + 偏好留空；解析时仍回落内置图，观感与「恢复默认」一致 */
async function clearDefaultCover(): Promise<void> {
  if (coverBusy.value) return;
  coverBusy.value = true;
  try {
    await removeDefaultCoverImage();
    reader.patchCover({ defaultCoverPath: null, defaultCoverDarkPath: null });
    toast('已清除自定义默认封面，回落到内置封面', 'info', 5000);
  } finally {
    coverBusy.value = false;
  }
}

const SECTIONS = [
  { id: 'appearance', name: '外观' },
  { id: 'reading', name: '阅读' },
  // `#144`：用户全局净化规则（端点与契约早就封好，本轮才接上界面与引擎应用点）
  { id: 'purify', name: '净化' },
  { id: 'playback', name: '播放' },
  // `#822` B2 在线朗读（HTTP TTS）：总开关默认关，用户自选引擎
  { id: 'tts', name: '朗读' },
  // `#574` 站点定制（per-site CSS/JS + 阅读模式）的批量管理：列表/编辑/删除
  { id: 'site', name: '站点定制' },
  { id: 'network', name: '服务与网络' },
  // `#816` B5：六类缓存治理（分类占用 / 单类清理 / 条数与总上限可调）
  { id: 'cache', name: '缓存治理' },
  { id: 'backup', name: '数据备份' },
  // `#208` ⑤：源分享（直链上传规则 —— 决定「分享口令」把源文件传到哪个网盘）
  { id: 'share', name: '源分享' },
  // `#210`：自动化与运维（定时更新书架 / 性能面板 / 崩溃日志）
  { id: 'ops', name: '运维' },
  /**
   * `#209`：**桌面端专属**分区（托盘/快捷键/文件关联/开机自启）。
   * ★ 浏览器里连导航项都不渲染 —— 这些能力浏览器做不到，摆一堆点了没反应的开关
   *   就是 `#298c` 那类「能点但不能用」的缺陷。判断依据是外壳是否注入 `window.yuedu`。
   */
  ...(isDesktop() ? [{ id: 'desktop', name: '桌面端' }] : []),
  { id: 'about', name: '关于' },
];
const section = ref('appearance');
function go(s: string) {
  section.value = s;
}

/* ------------------------------------------------------------------ *
 * 关于：版本 / 开发人员 / 更新日志 / 开源许可 / 免责声明
 * ------------------------------------------------------------------ */

/**
 * 版本号来自**构建注入**（`apps/web/vite.config.ts` 读 `apps/desktop/package.json`
 * 的 version 写成 `__APP_VERSION__`）—— 界面里不再另写常量，避免发版后两处对不上。
 */
const APP_VERSION = __APP_VERSION__;

/**
 * 更新日志：只列**用户可感知**的里程碑（按日期倒序）。
 * 逐轮过程记录（含实测结论与踩坑）在仓库 `docs/rounds/`，这里不搬。
 */
const CHANGELOG: Array<{ date: string; text: string }> = [
  { date: '2026-11-26', text: '侧栏导航图标统一为线性风格；备份恢复后无需重启即生效；RSS 订阅去除「新」标记' },
  { date: '2026-11-25', text: '发布形态收敛为绿色 zip，首次运行自建「悦读」「悦读服务」快捷方式；音频离线预取稳定性修复' },
  { date: '2026-11-24', text: 'Legado 备份互通与整库备份 / 恢复；新增 YueDu-Server 独立服务形态' },
  { date: '2026-11-19', text: '音频离线 P1.5：手动缓存任务队列、进度与取消；服务壳支持 --server-only' },
  { date: '2026-11-14', text: '站点图标；小窗三态的上/下一章按钮与歌词键位统一' },
  { date: '2026-11-10', text: '接入 Edge TTS 全部音色；浮窗三态工具条、色盘与章节标题统一' },
  { date: '2026-11-09', text: '小窗阅读两态收敛；漫画双击大图；目录云朵与本书缓存治理' },
  { date: '2026-11-06', text: '卷曲翻页、常亮 / 自动翻页、右键菜单、F11 全屏等阅读体验批' },
];

/** 运行时主要第三方依赖（许可证取自各自 package.json，非推测） */
const LICENSES: Array<{ name: string; license: string }> = [
  { name: 'Vue 3 / Vue Router / Pinia', license: 'MIT' },
  { name: 'Element Plus', license: 'MIT' },
  { name: 'CodeMirror 6', license: 'MIT' },
  { name: 'ArtPlayer', license: 'MIT' },
  { name: 'js-beautify', license: 'MIT' },
  { name: 'Fastify', license: 'MIT' },
  { name: 'Electron', license: 'MIT' },
  { name: 'hls.js', license: 'Apache-2.0' },
  { name: 'PDF.js（pdfjs-dist）', license: 'Apache-2.0' },
  { name: 'OpenCC（opencc-js）', license: 'MIT AND Apache-2.0' },
];

/* ------------------------------------------------------------------ *
 * `#209` 桌面端（托盘 / 全局快捷键 / 文件关联 / 开机自启）
 * ------------------------------------------------------------------ */

/**
 * 桌面端状态。**全部来自主进程**（`window.yuedu.desktopStatus()`）——
 * 「快捷键到底抢到没有」「注册表写过没有」「托盘建起来没有」这三件事只有外壳知道，
 * 界面**不自己推断**（按「是不是打包版」推出来的口径迟早和真实情况不一致）。
 */
const desk = ref<DesktopStatus | null>(null);
const deskBusy = ref<'' | 'refresh' | 'shortcut' | 'assoc' | 'protocol' | 'autolaunch' | 'server'>('');
const deskMsg = ref<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
/**
 * 快捷键输入框。
 * ★ 用**草稿值**、点「应用」才提交：每敲一个字符就重注册会在输入过程中反复抢键
 *   （还会把中间态写进配置文件）。
 */
const deskShortcutDraft = ref('');
/** 本地服务：端口/数据目录草稿（点「应用并重启」才提交，避免边输入边重启） */
const deskPortDraft = ref<number | ''>('');
const deskDataDirDraft = ref('');

async function refreshDesktop(): Promise<void> {
  const p = getDesktopStatus();
  if (!p) return;
  deskBusy.value = 'refresh';
  try {
    const st = await p;
    desk.value = st;
    deskShortcutDraft.value = st.prefs.shortcut;
    // 0 = 跟随形态默认（PC 3100 / 服务端 3000）；草稿框里直接显示生效端口更好懂
    deskPortDraft.value = st.prefs.serverPort || st.server?.port || 3100;
    deskDataDirDraft.value = st.prefs.dataDir ?? '';
  } catch (e) {
    deskMsg.value = { kind: 'err', text: `读取桌面端状态失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    deskBusy.value = '';
  }
}

/** 改偏好。写完**回读主进程的结论** —— 写进配置 ≠ 真的生效（尤其快捷键） */
async function patchDesktop(patch: Partial<DesktopPrefs>): Promise<void> {
  const p = setDesktopPrefs(patch);
  if (!p) return;
  const r = await p;
  if (desk.value) {
    desk.value = { ...desk.value, prefs: r.prefs, shortcut: r.shortcut, prefsWarnings: r.warnings };
  }
  deskMsg.value = r.ok
    ? (r.warnings.length ? { kind: 'warn', text: r.warnings.join('；') } : null)
    : { kind: 'err', text: `保存失败：${r.error || '未知原因'}` };
}

async function applyDesktopShortcut(): Promise<void> {
  const v = deskShortcutDraft.value.trim();
  if (!v) {
    deskMsg.value = { kind: 'warn', text: '请先填一个组合键，例如 Control+Shift+Y' };
    return;
  }
  deskBusy.value = 'shortcut';
  try {
    await patchDesktop({ shortcut: v });
    // 结论看主进程报的 ok / held（两个判据），不看我们刚输入了什么
    const sc = desk.value?.shortcut;
    if (!sc || !sc.enabled) return;
    if (sc.ok && sc.held) deskMsg.value = { kind: 'ok', text: `快捷键 ${sc.accelerator} 已生效（在任意窗口按它都能唤出/收起阅读）` };
    else deskMsg.value = { kind: 'err', text: `快捷键 ${sc.accelerator} 未生效：${sc.reason}` };
  } finally {
    deskBusy.value = '';
  }
}

async function applyServerPort(): Promise<void> {
  const n = Number(deskPortDraft.value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    deskMsg.value = { kind: 'warn', text: '端口需要 1024~65535 的整数' };
    return;
  }
  if (!window.confirm(`端口改为 ${n}？\n\n确认后会立即重启桌面端；若端口被占用，重启会失败并提示。`)) return;
  deskBusy.value = 'server';
  deskMsg.value = { kind: 'ok', text: `正在改用端口 ${n} 并重启…` };
  try { await patchDesktop({ serverPort: n }); } finally { deskBusy.value = ''; }
}

async function pickDeskDataDir(): Promise<void> {
  const r = await pickDataDir();
  if (!r || !r.ok || !r.path) {
    if (r && r.error) deskMsg.value = { kind: 'err', text: `选择目录失败：${r.error}` };
    return;
  }
  deskDataDirDraft.value = r.path;
}

async function applyDataDir(): Promise<void> {
  const v = deskDataDirDraft.value.trim();
  if (!window.confirm(
    '切换数据目录？\n\n只改目录，不复制旧数据；旧数据留在原处（需要时请自行迁移或走导入/导出）。\n确认后立即重启桌面端。',
  )) return;
  deskBusy.value = 'server';
  deskMsg.value = { kind: 'ok', text: '正在切换数据目录并重启…' };
  try { await patchDesktop({ dataDir: v }); } finally { deskBusy.value = ''; }
}

async function resetDataDir(): Promise<void> {
  if (!window.confirm('恢复默认数据目录？\n\n只改目录，不复制旧数据；当前目录里的数据不会被删除。')) return;
  deskDataDirDraft.value = '';
  deskBusy.value = 'server';
  deskMsg.value = { kind: 'ok', text: '正在恢复默认目录并重启…' };
  try { await patchDesktop({ dataDir: '' }); } finally { deskBusy.value = ''; }
}

async function toggleFileAssoc(on: boolean): Promise<void> {
  deskBusy.value = 'assoc';
  try {
    const p = setFileAssoc(on);
    if (!p) return;
    const r = await p;
    if (!r.supported) { deskMsg.value = { kind: 'warn', text: r.error || '当前环境不支持注册文件关联' }; return; }
    if (r.ok) {
      deskMsg.value = {
        kind: 'ok',
        text: on
          ? `已注册（${r.enabled ? '写入' : ''}${r.done}/${r.total} 条）。本程序已出现在「打开方式」里 —— 想设为默认，请在资源管理器里右键某个 txt → 打开方式 → 始终使用此应用。`
          : `已注销（清除 ${r.done}/${r.total} 条）。只删了本程序写入的项，没有动其它程序。`,
      };
    } else {
      const bad = (r.results || []).filter((x) => !x.ok).map((x) => `${x.key}：${x.detail}`).join('；');
      deskMsg.value = { kind: 'err', text: `操作未完成（已做 ${r.done}/${r.total} 条，遇到第一条失败就停了）：${bad || '未知原因'}` };
    }
    await refreshDesktop();
  } finally {
    deskBusy.value = '';
  }
}

/**
 * `#347` 导入链接协议（`yuedu://` / `legado://`）注册 —— 与文件关联同构。
 * 缺它 ⇒ 分享页里点「一键导入」链接时系统不知道该唤起谁。
 */
async function toggleProtocolAssoc(on: boolean): Promise<void> {
  deskBusy.value = 'protocol';
  try {
    const p = setProtocolAssoc(on);
    if (!p) return;
    const r = await p;
    if (!r.supported) { deskMsg.value = { kind: 'warn', text: r.error || '当前环境不支持注册导入链接协议' }; return; }
    if (r.ok) {
      deskMsg.value = {
        kind: 'ok',
        text: on
          ? `已注册（写入 ${r.done}/${r.total} 条）。现在在浏览器/分享页里点 yuedu:// 或 legado:// 一键导入链接，会唤起本程序并打开导入预览。`
          : `已注销（清除 ${r.done}/${r.total} 条）。`,
      };
    } else {
      const bad = (r.results || []).filter((x) => !x.ok).map((x) => `${x.key}：${x.detail}`).join('；');
      deskMsg.value = { kind: 'err', text: `操作未完成（已做 ${r.done}/${r.total} 条，遇到第一条失败就停了）：${bad || '未知原因'}` };
    }
    await refreshDesktop();
  } finally {
    deskBusy.value = '';
  }
}

async function toggleAutoLaunch(on: boolean): Promise<void> {
  deskBusy.value = 'autolaunch';
  try {
    const p = setAutoLaunch(on);
    if (!p) return;
    const r = await p;
    if (!r.supported) { deskMsg.value = { kind: 'warn', text: r.error || r.reason || '当前环境不支持开机自启' }; return; }
    deskMsg.value = r.ok
      ? { kind: 'ok', text: on ? '已设置开机自启（下次登录 Windows 时自动打开）' : '已取消开机自启' }
      : { kind: 'err', text: `系统未接受该设置：${r.error || '未知原因'}` };
    await refreshDesktop();
  } finally {
    deskBusy.value = '';
  }
}

const serverOk = ref<boolean | null>(null);
async function ping() {
  try {
    const r = await fetch('/api/engines', { signal: AbortSignal.timeout(4000) });
    serverOk.value = r.ok;
  } catch {
    serverOk.value = false;
  }
}

/* ---- `#386` 引擎系统代理（服务端出网统一走代理；保存即生效，无需重启） ---- */
const proxyEnabled = ref(false);
const proxyUrl = ref('');
const proxyBusy = ref(false);
const proxySay = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);
async function loadProxy() {
  try {
    const cfg = await getNetworkProxy();
    proxyEnabled.value = cfg.enabled;
    proxyUrl.value = cfg.url;
  } catch {
    /* 服务离线时静默（服务器状态行已有红标） */
  }
}
async function saveProxy(nextEnabled: boolean) {
  proxyBusy.value = true;
  proxySay.value = null;
  try {
    const cfg = await putNetworkProxy({ enabled: nextEnabled, url: proxyUrl.value.trim() });
    proxyEnabled.value = cfg.enabled;
    proxySay.value = {
      kind: 'ok',
      text: cfg.enabled ? `✓ 已生效：${cfg.url ? cfg.url : '走服务端环境变量 http_proxy'}` : '✓ 已恢复直连',
    };
  } catch (e) {
    proxySay.value = { kind: 'err', text: String((e as { message?: string })?.message ?? e).slice(0, 140) };
  } finally {
    proxyBusy.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * `#210` 运维分区（定时更新书架 / 性能面板 / 崩溃日志）
 * ------------------------------------------------------------------ */

const shelfUp = ref<ShelfUpdateStatus | null>(null);
const diag = ref<DiagInfo | null>(null);
const errs = ref<Awaited<ReturnType<typeof getSystemErrors>> | null>(null);
const opsMsg = ref<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
const opsBusy = ref<'' | 'run' | 'save'>('');
const intervalDraft = ref(60);
let opsTimer: ReturnType<typeof setInterval> | null = null;

/* `#558` 源医生巡检间隔（四档，默认 7 天）。配置不随 5s 轮询刷 —— 它只在用户改时才变 */
const patrolCfg = ref<PatrolConfig | null>(null);
const patrolMsg = ref<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null);
const patrolHoursDraft = ref<number>(168);

async function loadPatrolCfg() {
  try {
    const c = await getPatrolConfig();
    patrolCfg.value = c;
    patrolHoursDraft.value = c.hours;
  } catch {
    patrolCfg.value = null; // 服务端没起就不显示这块的断言式文案
  }
}

async function savePatrolCfg() {
  patrolMsg.value = null;
  try {
    const r = await savePatrolConfig(Number(patrolHoursDraft.value));
    patrolCfg.value = patrolCfg.value ? { ...patrolCfg.value, hours: r.hours, everyMs: r.everyMs } : null;
    patrolMsg.value = { kind: 'ok', text: `已改为每 ${patrolLabel(r.hours)} 巡检一轮（立即生效，不用重启）` };
  } catch (e) {
    patrolMsg.value = { kind: 'err', text: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 168 → 「7 天」；不进位到月（30 天就写 30 天） */
function patrolLabel(h: number): string {
  return h % 24 === 0 && h >= 24 ? `${h / 24} 天` : `${h} 小时`;
}

/** 三个端点各拉各的；任何一个挂了只在面板里标一句，不连坐其它面板 */
async function refreshOps() {
  const jobs: Promise<void>[] = [
    getShelfUpdate()
      .then((s) => {
        shelfUp.value = s;
        intervalDraft.value = s.config.intervalMin;
      })
      .catch((e) => {
        opsMsg.value = { kind: 'warn', text: `书架更新状态拉取失败：${e instanceof Error ? e.message : String(e)}` };
      }),
    getDiag().then((d) => { diag.value = d; }).catch(() => { diag.value = null; }),
    getSystemErrors().then((r) => { errs.value = r; }).catch(() => { errs.value = null; }),
  ];
  await Promise.allSettled(jobs);
}

/** 只有停在「运维」分区才轮询（5s）；离开就停 —— 别在用户看别处时白打请求 */
watch(section, (s) => {
  if (opsTimer) { clearInterval(opsTimer); opsTimer = null; }
  if (s === 'ops') {
    void refreshOps();
    void loadPatrolCfg();
    opsTimer = setInterval(() => void refreshOps(), 5000);
  }
});

/* ---------------- `#574` 站点定制批量管理（设置页） ----------------
 * 需求原话：「补设置页的批量管理列表」。
 * 编辑复用 `SiteCustomizeDialog`（同一份编辑器、同一套校验），这里只负责列表与删除。
 */
const siteList = ref<SiteCustomize[]>([]);
const siteBusy = ref(false);
const siteErr = ref('');
const siteMsg = ref('');
/** 正在编辑的条目：`url` 决定默认域名；`current=null` = 新增 */
const siteEdit = ref<{ url: string; current: SiteCustomize | null; title: string } | null>(null);
/**
 * `#635` 停用清单（镜像 localStorage，用于**渲染响应式**）。
 * `isSiteCustomizeEnabled` 读的是 localStorage（非响应式），所以列表另存一份：
 * 刷新列表与切换开关时同步赋值，模板只依赖这份 ref。
 */
const siteDisabled = ref<string[]>(readDisabledHosts());
let offSiteChange: (() => void) | null = null;

async function refreshSiteList(): Promise<void> {
  siteBusy.value = true;
  siteErr.value = '';
  try {
    siteList.value = await listSiteCustomize();
    siteDisabled.value = readDisabledHosts();
  } catch (e) {
    siteErr.value = `读取站点定制失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    siteBusy.value = false;
  }
}
function addSite(): void {
  siteEdit.value = { url: '', current: null, title: '新增站点定制' };
}
function editSite(c: SiteCustomize): void {
  siteEdit.value = { url: `https://${c.host.replace(/^\*\./, '')}`, current: c, title: c.host };
}
/** 启停：本机偏好（不写配置文件；换浏览器/清缓存后回默认启用） */
function siteEnabled(host: string): boolean {
  return !siteDisabled.value.includes(host) && isSiteCustomizeEnabled(host);
}
function toggleSite(c: SiteCustomize): void {
  const next = !siteEnabled(c.host);
  siteDisabled.value = setSiteCustomizeEnabled(c.host, next);
  siteMsg.value = next
    ? `已启用 ${c.host}`
    : `已停用 ${c.host}（本机偏好：换浏览器 / 清缓存后回默认启用）`;
}
/** 该定制域名命中的源（「站点名（#源 id）」；没有 url 的老源无法归属） */
function siteSourcesOf(c: SiteCustomize): string {
  const refs = siteSourceRefs(c.host, st.sources);
  if (!refs.length) return st.sources.length ? '未匹配到源' : '源列表读取中…';
  return refs.map((r) => `${r.name}（#${r.id}）`).join('、');
}
async function deleteSite(c: SiteCustomize): Promise<void> {
  if (!window.confirm(`删除 ${c.host} 的站点定制？（CSS/JS/阅读模式一并删除，站点本身不受影响）`)) return;
  const ok = await removeSiteCustomize(c.host);
  siteMsg.value = ok ? `已删除 ${c.host}` : `删除 ${c.host} 失败（服务端不可达？）`;
  if (ok) siteDisabled.value = readDisabledHosts();
  await refreshSiteList();
}
function onSiteSaved(item: SiteCustomize | null): void {
  siteEdit.value = null;
  siteMsg.value = item ? `已保存 ${item.host}` : '已删除该站配置';
  void refreshSiteList();
}
/** 只在停在「站点定制」分区时拉列表（避免设置页一打开就打请求） */
watch(section, (s) => {
  if (s === 'site') {
    void st.loadMeta(); // 源归属列要用（`loaded` 后为空操作）
    void refreshSiteList();
  }
});
onMounted(() => {
  // 别处（阅读器/内置浏览器）改了配置 ⇒ 列表跟着刷新
  offSiteChange = onSiteCustomizeChange(() => {
    if (section.value === 'site') void refreshSiteList();
  });
});
onBeforeUnmount(() => offSiteChange?.());

async function saveUpConfig() {
  opsBusy.value = 'save';
  try {
    const r = await saveShelfUpdateConfig({ intervalMin: Number(intervalDraft.value) || 60 });
    shelfUp.value = r.status;
    opsMsg.value = { kind: 'ok', text: r.warnings.length ? `已保存（有告警：${r.warnings.join('；')}）` : '已保存' };
  } catch (e) {
    opsMsg.value = { kind: 'err', text: `保存失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    opsBusy.value = '';
  }
}

async function toggleShelfUpdate(on: boolean) {
  opsBusy.value = 'save';
  try {
    const r = await saveShelfUpdateConfig({ enabled: on });
    shelfUp.value = r.status;
    opsMsg.value = { kind: 'ok', text: on ? `已开启（每 ${r.config.intervalMin} 分钟自动查一次）` : '已关闭自动更新（仍可点「立即更新」）' };
  } catch (e) {
    opsMsg.value = { kind: 'err', text: `操作失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    opsBusy.value = '';
  }
}

async function runShelfUpdateNow() {
  opsBusy.value = 'run';
  opsMsg.value = null;
  try {
    const r = await runShelfUpdate();
    shelfUp.value = r.status;
    const names = r.status.updatedNames;
    opsMsg.value = {
      kind: 'ok',
      text: names.length
        ? `更新完成，有新增：${names.join('、')}`
        : '更新完成，全部书目无新增章节',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 409 = 已经在跑（可能是定时轮到了）——如实说，别当错误吓人
    opsMsg.value = msg.includes('409')
      ? { kind: 'warn', text: '正在更新中，稍等片刻即可' }
      : { kind: 'err', text: `更新失败：${msg}` };
  } finally {
    opsBusy.value = '';
    void refreshOps();
  }
}

/** ISO 时间串 → 「月-日 时:分」（既有 fmtTime 收的是毫秒数，不冲突） */
function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * `#515` 渲染共享宿主开关（服务端持久化；对新渲染会话生效，已在跑的不受影响）。
 * `#525` 10-23 观察期满起**默认开** —— 所有源的渲染共用一只 Chromium（内存约 -67%，
 * 后续源冷启快 ~10 倍）。设置页可关；`YUEDU_BROWSER_CONTEXT=0` 可钉死关。
 */
/** `#516` 清理全部缓存与 Cookie（设置页） */
const cacheClearing = ref(false);
async function clearEverything(): Promise<void> {
  if (!confirm('清空所有缓存与 Cookie？\n\n会清掉：离线正文、书籍详情/目录本地化、下载任务，以及所有源的 Cookie（含渲染凭证）。\n已下载的内容需要重新下载。')) return;
  cacheClearing.value = true;
  try {
    const r = await clearAllCache();
    const c = await clearAllCookies();
    toast(`已清理：正文 ${r.chapters} 章 · 书籍 ${r.books} 本 · 下载任务 ${r.downloads} 条 · Cookie ${c.cleared} 个源`, 'info');
  } catch (e) {
    toast('清理失败：' + String(e instanceof Error ? e.message : e), 'error');
  } finally {
    cacheClearing.value = false;
  }
}

const ctxMode = ref(false);
async function loadCtxMode(): Promise<void> {
  try {
    ctxMode.value = (await getBrowserContextMode()).enabled;
  } catch {
    /* 老服务端没有该接口：保持关 */
  }
}
async function toggleCtxMode(): Promise<void> {
  const next = !ctxMode.value;
  ctxMode.value = next; // 乐观更新，失败回滚
  try {
    await setBrowserContextMode(next);
  } catch {
    ctxMode.value = !next;
    themeXferMsg.value = '渲染共享宿主：开关保存失败（服务端未更新）';
  }
}

onMounted(async () => {
  void st.loadMeta();
  void ping();
  void loadProxy(); // `#386` 系统代理回显
  void loadCtxMode(); // `#515` 渲染共享宿主回显
  // `#209`：桌面端状态只在桌面端外壳里有意义（浏览器下 `desk` 保持 null，分区也不渲染）
  if (isDesktop()) void refreshDesktop();
});

function clearWatch() {
  if (!confirm('清空观影历史？')) return;
  // 必须走 store 的 `clearHistory()`：它会同删 shelf 里的 notShelf 行（服务端副本）。
  // 只清本地 `watch-history` 的话，下次启动 `hydrateShelf` 会把这些行回填 ⇒ 删除后复活。
  reader.clearHistory();
}
function clearShelf() {
  if (!confirm('清空整个书架（含影视收藏）？')) return;
  reader.shelf.length = 0;
  reader.saveShelf();
}
/* ---- `#201` 用户数据导出 / 导入 ---- */

/** 导出时是否带目录（体积换便利：目录能省一次「刷新目录」，不带则文件很小） */
const exportWithChapters = ref(false);
const fileEl = ref<HTMLInputElement | null>(null);
const busy = ref<'' | 'export' | 'import'>('');
/** 已选文件解析出的快照（确认导入前先让用户看清「要导入什么」） */
const pending = ref<Record<string, unknown> | null>(null);
const pendingSummary = ref('');
const overwrite = ref(false);
const importHint = ref('选择由「导出用户数据」生成的 JSON；默认只补新增 —— 不覆盖、不删除任何现有数据');
const importResultText = ref('');

const n = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** 粗略清点快照内容（**不是**权威统计，只为「导入前让人看清」） */
function summarize(j: Record<string, unknown>): string {
  const chs = (j['chapters'] ?? {}) as Record<string, unknown>;
  const chCount = Object.values(chs).reduce<number>((a, v) => a + n(v), 0);
  const parts = [
    `书架 ${n(j['books'])}`,
    ...(chCount ? [`目录 ${chCount}（${Object.keys(chs).length} 本）`] : []),
    `书签 ${n(j['bookmarks'])}`,
    `划线 ${n(j['highlights'])}`,
    `净化 ${n(j['replaceRules'])}`,
    `字典 ${n(j['dictRules'])}`,
    `分组 ${n(j['bookGroups'])}`,
    `阅读记录 ${n(j['readRecords'])}`,
    ...(j['prefs'] ? ['含偏好'] : []),
  ];
  return parts.join(' · ');
}

function fmtCounts(label: string, c: { added: number; updated: number; kept: number; skipped: number }): string {
  const bits = [`新增 ${c.added}`];
  if (c.updated) bits.push(`改动 ${c.updated}`);
  if (c.kept) bits.push(`保留 ${c.kept}`);
  if (c.skipped) bits.push(`跳过 ${c.skipped}`);
  return `${label} ${bits.join('/')}`;
}

function fmtResult(r: ImportResult): string {
  const prefsTxt =
    r.prefs.policy === 'none'
      ? '偏好 未提供'
      : `偏好 ${r.prefs.policy === 'overwrite' ? '已覆盖' : '填充默认项'} ${r.prefs.fields}`;
  return [
    fmtCounts('书架', r.books),
    fmtCounts('目录', r.chapters),
    fmtCounts('书签', r.bookmarks),
    fmtCounts('划线', r.highlights),
    fmtCounts('净化', r.replaceRules),
    fmtCounts('字典', r.dictRules),
    fmtCounts('分组', r.bookGroups),
    fmtCounts('阅读记录', r.readRecords),
    prefsTxt,
  ].join(' · ');
}

async function doExport() {
  busy.value = 'export';
  try {
    const snap = await getSnapshot(exportWithChapters.value);
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yuedu-userdata-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    importHint.value = `已导出（${summarize(snap as Record<string, unknown>)}）`;
  } catch (e) {
    window.alert('导出失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    busy.value = '';
  }
}

async function onPickFile(e: Event) {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = ''; // 允许重复选同一个文件
  if (!f) return;
  try {
    const j = JSON.parse(await f.text()) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('不是快照对象（顶层应为 JSON 对象）');
    pending.value = j as Record<string, unknown>;
    pendingSummary.value = `${summarize(pending.value)} · 文件 ${(f.size / 1024).toFixed(0)} KB`;
    importResultText.value = '';
  } catch (err) {
    pending.value = null;
    pendingSummary.value = '';
    window.alert('解析失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function doImport() {
  const snap = pending.value;
  if (!snap) return;
  if (overwrite.value && !window.confirm('「覆盖同名项」会用备份里的内容替换服务端上主键相同的条目（仍不会删除任何数据）。继续？')) return;
  busy.value = 'import';
  try {
    const r = await importSnapshot(snap, overwrite.value);
    importResultText.value = `${r.mode === 'overwrite' ? '覆盖' : '合并'}完成（${r.elapsedMs}ms）：${fmtResult(r.result)}`;
    pending.value = null;
    pendingSummary.value = '';
    importHint.value = '导入完成 —— 已重新从服务端加载界面数据';
    await refreshAfterImport();
  } catch (e) {
    window.alert('导入失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    busy.value = '';
  }
}

/**
 * 导入后重新对齐 —— 与 `main.ts` 启动时那份清单**同一组** hydrate。
 * 不刷新页面：hydrate 本身就是「把服务端数据拉回本地缓存」，够用且不打断操作。
 *
 * ⚠️ 源列表必须**带 force**：`loadMeta()` 在 `loaded` 已置位时是空操作
 * （`stores/sources.ts` 的门闩），而源管理/发现页的 `onMounted` 调的正是不带 force 的那版
 * ⇒ 不在这里强刷，就只能靠整页刷新才看得见刚导入/恢复的源（2026-11-26 用户实测）。
 */
async function refreshAfterImport() {
  const rs = await Promise.allSettled([
    reader.hydrateGroups(),
    reader.hydrateShelf(),
    reader.hydrateBookmarks(),
    reader.hydrateHighlights(),
    reader.hydratePrefs(),
    replaceRules.hydrate(),
    dict.hydrate(),
  ]);
  for (const r of rs) if (r.status === 'rejected') console.warn('[settings] 导入后对齐失败：', r.reason);
  // 强刷失败不能反过来报「导入失败」（数据已经导入成功）⇒ 只留痕
  try {
    await st.loadMeta(true);
  } catch (e) {
    console.warn('[settings] 导入后刷新源列表失败（数据已导入，刷新页面即可）：', e);
  }
}

function exportCookies() {
  const a = document.createElement('a');
  a.href = '/api/sources/export?filter=all&kind=legado';
  a.download = '';
  a.click();
}

/* ═══════════ `#208` ⑤ WebDAV 同步（设置页真实现） ═══════════
 *
 * 三条界面纪律（都是从服务端语义反推的，别改）：
 *  ① **密码框回显恒为空**（服务端 `publicWebDavConfig` 抹掉了它）⇒ 空着保存**不会**把密码冲掉
 *     （服务端 `PUT /api/webdav` 有「新密码为空且有旧配置 ⇒ 沿用旧密码」的保护）。
 *     所以占位文案必须说清「留空 = 不改」，否则用户会以为保存把密码弄丢了。
 *  ② **「测试连接」失败也回 200** ⇒ 界面上「密码不对 / 连不上 / 不是 WebDAV」必须分开显示，
 *     塌成一句「测试失败」等于把排障线索扔掉。
 *  ③ **恢复是破坏性操作** ⇒ 必须二次确认，且确认文案里写明「覆盖现有数据、建议先备份」。
 */

const wd = ref<WebDavPublicConfig>({
  url: '', username: '', password: '', dir: '', authEncoding: 'utf-8', hasPassword: false,
});
const wdConfigured = ref(false);
/** 「同步阅读进度」开关。⚠️ 它在 `WebDavState` 上、**不在** config 里（见服务端 `WebDavState`） */
const wdSyncProgress = ref(true);
/**
 * `B7` ④ 云端备份保留份数（1~10，默认 1 = 只保留最新）。
 * 与同步开关一样在 `WebDavState` 上；切换即保存，但清理发生在**下一次成功备份之后**
 * （删除不可逆，不能靠改设置偷偷删文件）。
 */
const wdBackupKeep = ref(1);
const wdKeepBusy = ref(false);
/**
 * `B7` ③ 恢复方式：覆盖（默认，还原如初）/ 合并（只补缺失、不覆盖现有）。
 * 只在点「恢复…」时生效；不持久化，避免用户下次忘了自己上次选过「合并」。
 */
const wdRestoreMode = ref<'overwrite' | 'merge'>('overwrite');
/** 是否已从服务端读过一次（没读过就不显示「还没配置」那种断言式文案） */
const wdLoaded = ref(false);
const wdBusy = ref('');
const wdMsg = ref<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
const syncReport = ref<WebDavSyncReport | null>(null);
const backups = ref<WebDavBackupItem[]>([]);
/**
 * `#621` 可勾选的备份内容。
 *
 * ★ **不硬编码**：清单由服务端 `/api/backup/options` 下发（`BACKUP_OPTIONS` 是唯一真相源）。
 * 读不到时保持空数组 ⇒ 界面退回「按服务端默认内容备份」，并明确提示，
 * 而不是自己瞎猜一份清单（猜出来的清单少一项就少备份一类数据）。
 */
const backupOptionList = ref<BackupOptionMeta[]>([]);
const backupPicked = ref<string[]>([]);
/** 上游有、本仓没有对应物的项（用于「为什么没有封面勾选框」的解释） */
const backupUnsupported = ref<BackupOptionsPayload['unsupported']>([]);
/** 备份/恢复口令（只有在勾了敏感项时才必需；恢复加密备份时也要它） */
const backupPassword = ref('');
const backupOptionsError = ref('');

/* ── 文件备份（Legado 兼容 / 本仓完整，两模式并列） ───────────────── */
const fbMode = ref<BackupFormat>('legado');
const fbModes = ref<BackupModesPayload | null>(null);
const fbPicked = ref<Record<BackupFormat, string[]>>({ legado: [], full: [] });
const fbPassword = ref('');
const fbBusy = ref<'' | 'inspect' | 'apply' | 'export'>('');
const fbPreview = ref<BackupInspectResult | null>(null);
const fbFileName = ref('');
const fbMsg = ref<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
const fbFileEl = ref<HTMLInputElement | null>(null);

const fbOptions = computed(() => fbModes.value?.[fbMode.value].options ?? []);
const fbPickedNow = computed(() => fbPicked.value[fbMode.value]);
const fbNeedPassword = computed(() => {
  const picked = new Set(fbPickedNow.value);
  const avail = fbPreview.value?.available ? new Set(fbPreview.value.available) : null;
  return fbOptions.value.some((o) => o.sensitive && picked.has(o.id) && (!avail || avail.has(o.id)));
});
const fbPreviewLines = computed<string[]>(() => {
  const p = fbPreview.value;
  if (!p) return [];
  const lines: string[] = [];
  if (p.format === 'legado') {
    const b = p.books as
      | { total: number; rebuildable: number; create: number; progress: number; claimed: number; local: number; video: number; sourceMissing: number }
      | undefined;
    if (b) {
      lines.push(`可确定性重建 ${b.rebuildable}/${b.total} 本（新建 ${b.create} · 续接进度 ${b.progress} · 认领 ${b.claimed}）`);
      if (b.local || b.video || b.sourceMissing) {
        lines.push(`跳过：本地书 ${b.local} · 影视书 ${b.video} · 源不存在 ${b.sourceMissing}`);
      }
    }
    const a = p.annotations as
      | { bookmarks: number; orphanBookmarks: number; highlights: number; orphanHighlights: number; bookMemos?: number; orphanBookMemos?: number; highlightRules: number }
      | undefined;
    if (a) {
      lines.push(
        `书签 ${a.bookmarks}（孤立 ${a.orphanBookmarks}）· 划线 ${a.highlights}（孤立 ${a.orphanHighlights}）`
        + ` · 备注 ${a.bookMemos ?? 0}（孤立 ${a.orphanBookMemos ?? 0}）· 高亮规则 ${a.highlightRules}`,
      );
    }
    const h = p.history as { readRecords: number; conflicts: number; searchHistory?: number } | undefined;
    if (h) lines.push(`阅读记录 ${h.readRecords}（author 冲突 ${h.conflicts}，将在恢复时拦掉）· 搜索历史 ${h.searchHistory ?? 0}`);
    const s = p.settings as { mapped?: unknown[] } | undefined;
    if (s) lines.push(`阅读设置白名单映射 ${s.mapped?.length ?? 0} 项（其余项不改）`);
    for (const sk of p.skipped ?? []) {
      if (sk.count) lines.push(`跳过 ${sk.entry}：${sk.why}（${sk.count}）`);
    }
  } else {
    if (p.stats) lines.push(Object.entries(p.stats).map(([k, v]) => `${k} ${v}`).join(' · '));
    if (p.included?.length) lines.push(`包含：${p.included.join(' · ')}`);
    for (const e of p.parseErrors ?? []) lines.push(`解析失败 ${e.entry}：${e.error}`);
    for (const e of p.unknownEntries ?? []) lines.push(`未识别条目 ${e}（不会导入）`);
  }
  for (const w of p.warnings ?? []) lines.push(`⚠ ${w}`);
  return lines;
});

function wdSay(kind: 'ok' | 'warn' | 'err', text: string): void {
  wdMsg.value = { kind, text };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function fmtTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

async function loadWebDav(): Promise<void> {
  try {
    const s = await getWebDav();
    wdConfigured.value = s.configured;
    wd.value = { ...s.config };
    wdSyncProgress.value = s.syncProgress;
    wdBackupKeep.value = s.backupKeep ?? 1;
    wdLoaded.value = true;
  } catch (e) {
    wdSay('err', '读不到 WebDAV 配置：' + (e instanceof Error ? e.message : String(e)));
    wdLoaded.value = true;
  }
}

async function saveWebDav(): Promise<void> {
  wdBusy.value = 'save';
  try {
    const s = await putWebDav({ config: wd.value, syncProgress: wdSyncProgress.value, backupKeep: wdBackupKeep.value });
    wdConfigured.value = s.configured;
    wd.value = { ...s.config };
    wdSyncProgress.value = s.syncProgress;
    wdBackupKeep.value = s.backupKeep ?? 1;
    wdSay(s.configured ? 'ok' : 'warn', s.configured
      ? '已保存。建议点「测试连接」确认真能连上（连不上的配置只会在同步时才暴露）。'
      : '已保存，但账号或密码还是空的 ⇒ 仍算「未配置」，同步会拒绝执行。');
  } catch (e) {
    wdSay('err', '保存失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    wdBusy.value = '';
  }
}

/**
 * `B7` ④ 保存保留份数。
 * 只发 `{ backupKeep }`：服务端沿用已存配置，不会因为这次保存把账号密码重写。
 * 提示里说清「下次备份成功后清理」——不在保存时偷偷删云端文件。
 */
async function saveBackupKeep(): Promise<void> {
  if (!wdConfigured.value) {
    wdBackupKeep.value = 1;
    return;
  }
  wdKeepBusy.value = true;
  try {
    const s = await putWebDav({ backupKeep: wdBackupKeep.value });
    wdBackupKeep.value = s.backupKeep;
    wdSay('ok', `已设置云端备份保留 ${s.backupKeep} 份；下次备份成功后自动清理更早的文件。`);
  } catch (e) {
    wdSay('err', '保存保留份数失败：' + (e instanceof Error ? e.message : String(e)));
    await loadWebDav(); // 回滚成服务端真实值，避免界面显示一个没生效的数字
  } finally {
    wdKeepBusy.value = false;
  }
}

async function testWebDavConn(): Promise<void> {
  wdBusy.value = 'test';
  try {
    const r = await testWebDav(wd.value);
    if (r.ok) wdSay('ok', '✓ 连接成功（服务器认了这份账号密码）');
    else {
      const why = r.kind === 'unauthorized' ? '账号或密码不对（401）'
        : r.kind === 'unreachable' ? '连不上这个地址（DNS / 端口 / 证书）'
        : r.kind === 'not-webdav' ? '这个地址不是 WebDAV 服务（它没回 DAV 响应）'
        : '账号密码还没填齐';
      wdSay('err', `${why}：${r.detail}`);
    }
  } catch (e) {
    wdSay('err', '测试失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    wdBusy.value = '';
  }
}

async function delWebDav(): Promise<void> {
  if (!window.confirm('删除 WebDAV 配置？云端已有的文件不会动，只是本机不再往那边同步。')) return;
  wdBusy.value = 'del';
  try {
    const s = await deleteWebDav();
    wdConfigured.value = s.configured;
    wd.value = { ...s.config };
    wdBackupKeep.value = s.backupKeep ?? 1;
    backups.value = [];
    syncReport.value = null;
    wdSay('warn', '配置已删除（云端的备份文件仍在，可重新配置后再列出来）。');
  } catch (e) {
    wdSay('err', '删除失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    wdBusy.value = '';
  }
}

/** `pullOnly` ⇒ 只把远端进度拉下来，不推本机（看别人读到哪了） */
async function doSync(pullOnly: boolean): Promise<void> {
  wdBusy.value = pullOnly ? 'pull' : 'sync';
  syncReport.value = null;
  try {
    const r = await syncWebDav({ pullOnly });
    syncReport.value = r;
    wdSay(r.errors.length ? 'warn' : 'ok', r.errors.length
      ? `同步完成，但有 ${r.errors.length} 本书出错（其余书照常同步，明细见下）`
      : '同步完成');
  } catch (e) {
    wdSay('err', '同步失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    wdBusy.value = '';
  }
}

/**
 * 列出云端备份。
 * ★ `quiet` 是**必须的**：`doBackup` 成功后会顺手刷新这个列表，
 *   而刷新的提示（「云端有 N 份备份」）会把刚写下的「已备份 <文件名>（大小，含 N 本书）」
 *   **覆盖掉** ⇒ 用户看不到自己刚备份了什么（`#298` 探针实测：界面只剩「云端有 1 份备份」）。
 */
async function loadBackups(quiet = false): Promise<void> {
  wdBusy.value = quiet ? wdBusy.value : 'list';
  try {
    backups.value = await listWebDavBackups();
    if (!quiet) {
      wdSay('ok', backups.value.length
        ? `云端有 ${backups.value.length} 份备份`
        : '云端还没有备份文件（点「备份到云端」生成第一份）');
    }
  } catch (e) {
    if (!quiet) wdSay('err', '列出备份失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    if (!quiet) wdBusy.value = '';
  }
}

async function doBackup(): Promise<void> {
  // 敏感项没口令 ⇒ 前端先拦一次（服务端也会拦，但让用户少走一次网络往返）
  const needPwd = backupOptionList.value.some((o) => o.sensitive && backupPicked.value.includes(o.id));
  if (needPwd && !backupPassword.value) {
    wdSay('err', '勾了「持久 Cookie」/「源变量」⇒ 必须先填备份口令（上游同样要求：这两项必须加密存放）');
    return;
  }
  wdBusy.value = 'backup';
  try {
    const r = await webDavBackup({
      options: backupOptionList.value.length ? backupPicked.value : undefined,
      password: backupPassword.value || undefined,
    });
    await loadBackups(true); // 先刷新列表（静默），再写结果提示 —— 顺序不能倒，否则提示被覆盖
    const labelOf = (id: string) => backupOptionList.value.find((o) => o.id === id)?.label ?? id;
    const parts = [`已备份 ${r.fileName}（${fmtBytes(r.bytes)}，含 ${r.books} 本书）`];
    if (r.included?.length) parts.push(`内容：${r.included.map(labelOf).join('、')}`);
    if (r.skippedSensitive?.length) {
      parts.push(`⚠️ ${r.skippedSensitive.map((s) => `${labelOf(s.id)}未备份 —— ${s.why}`).join('；')}`);
    }
    if (r.rotation) {
      parts.push(r.rotation.deleted.length
        ? `轮转：保留最新 ${r.rotation.keep} 份，已清理 ${r.rotation.deleted.length} 份旧备份`
        : `轮转：保留最新 ${r.rotation.keep} 份（没有更早的备份需要清理）`);
    }
    if (r.rotationError) parts.push(`⚠️ 旧备份清理失败（备份本身已成功）：${r.rotationError}`);
    wdSay('ok', parts.join(' · '));
  } catch (e) {
    wdSay('err', '备份失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    wdBusy.value = '';
  }
}

async function doRestore(name: string): Promise<void> {
  const hint = backupPassword.value
    ? ''
    : '\n\n（若这份备份带了加密的 Cookie/源变量，恢复会失败并提示需要口令 —— 在下面口令框里填上再试）';
  const modeText = wdRestoreMode.value === 'merge'
    ? `当前是「合并」：只补备份里缺失的内容；本机已有的同主键记录**一律不覆盖**，本机多出来的记录也不会删。\n（想看某台设备的完整旧状态，请先切回「覆盖」。）`
    : `当前是「覆盖」：同主键记录用备份内容替换（走非累加管线 —— 累加型导入会把旧记录再插一遍，而且删掉的东西回不来）。\n备份里**没带**的内容一个字段都不会动；备份里没有的本机记录不删。`;
  const ok = window.confirm(
    `从「${name}」恢复？\n\n⚠️ ${modeText}\n建议先点一次「备份到云端」留一份当前状态。${hint}\n\n确定继续？`,
  );
  if (!ok) return;
  wdBusy.value = 'restore';
  try {
    const r = await webDavRestore(name, backupPassword.value || undefined, wdRestoreMode.value);
    const c = r.counts;
    const line = (label: string, x: { added: number; updated: number; kept: number; skipped: number }) =>
      `${label} 新增${x.added}/更新${x.updated}/保留${x.kept}/跳过${x.skipped}`;
    const tail: string[] = [];
    if (r.legacy) tail.push('这是旧格式备份（按快照里实际有的字段恢复）');
    if (r.cookiesRestored) tail.push(`写回 ${r.cookiesRestored} 个源的 Cookie`);
    if (r.sourceVariablesRestored) tail.push(`写回 ${r.sourceVariablesRestored} 个源的变量`);
    if (r.warnings?.length) tail.push(`⚠️ ${r.warnings.join('；')}`);
    wdSay(
      'ok',
      `已从 ${r.fileName} 恢复（${wdRestoreMode.value === 'merge' ? '合并' : '覆盖'}） · ${line('书', c.books)} · ${line('目录', c.chapters)} · ${line('书签', c.bookmarks)} · ${line('划线', c.highlights)}${tail.length ? ' · ' + tail.join(' · ') : ''}`,
    );
    await refreshAfterImport();
  } catch (e) {
    wdSay('err', '恢复失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    wdBusy.value = '';
  }
}

/**
 * `#621` 拉一次可勾选清单（进「数据备份」分区时拉）。
 *
 * 失败**不阻塞**备份：`backupOptionList` 留空 ⇒ `doBackup` 传 `options: undefined`
 * ⇒ 服务端按默认勾选备份。同时把原因写在界面上，不让用户以为「勾选框消失了」。
 */
async function loadBackupOptions(): Promise<void> {
  if (backupOptionList.value.length) return;
  try {
    const p = await getBackupOptions();
    backupOptionList.value = p.options;
    backupPicked.value = [...p.defaultOn];
    backupUnsupported.value = p.unsupported;
    backupOptionsError.value = '';
  } catch (e) {
    backupOptionsError.value = e instanceof Error ? e.message : String(e);
  }
}

/* ── 文件备份：两模式勾选项 + 预检 + 恢复 + 导出 ───────────────── */

async function loadFileBackupModes(): Promise<void> {
  if (fbModes.value) return;
  try {
    const m = await getBackupModes();
    fbModes.value = m;
    fbPicked.value = { legado: [...m.legado.defaultOn], full: [...m.full.defaultOn] };
  } catch (e) {
    fbMsg.value = { kind: 'err', text: `读不到备份模式清单：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 勾选（依赖成组）：勾上某项自动补齐 requires；取消某项会自动取消依赖它的项 */
function fbToggle(id: string, checked: boolean): void {
  const mode = fbMode.value;
  const opts = fbModes.value?.[mode].options ?? [];
  const picked = new Set(fbPicked.value[mode]);
  if (checked) picked.add(id);
  else picked.delete(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of opts) {
      if (!picked.has(o.id)) continue;
      if (checked && o.requires?.some((r) => !picked.has(r))) {
        for (const r of o.requires) picked.add(r);
        changed = true;
      }
      if (!checked && o.requires?.some((r) => !picked.has(r))) {
        picked.delete(o.id);
        changed = true;
      }
    }
  }
  fbPicked.value = { ...fbPicked.value, [mode]: [...picked] };
  // 勾选变了 ⇒ 之前那份预检的「会跳过/会覆盖」不再成立
  fbPreview.value = null;
}

function fbSay(kind: 'ok' | 'warn' | 'err', text: string): void {
  fbMsg.value = { kind, text };
}

async function runInspect(file: File): Promise<void> {
  fbBusy.value = 'inspect';
  fbPreview.value = null;
  try {
    const r = await inspectBackupZip(file, fbPassword.value || undefined, fbPicked.value[fbMode.value]);
    fbPreview.value = r;
    fbMode.value = r.format;
    if (r.options?.length) fbPicked.value = { ...fbPicked.value, [r.format]: r.options };
    fbSay('ok', `预检完成：识别为${r.format === 'legado' ? 'Legado 手机端备份' : '本仓完整备份'}。请核对下方明细后确认恢复。`);
  } catch (e) {
    fbSay('err', e instanceof Error ? e.message : String(e));
  } finally {
    fbBusy.value = '';
  }
}

function fbPickFile(): void {
  fbFileEl.value?.click();
}

async function onPickBackupFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  fbFileName.value = file.name;
  await runInspect(file);
}

async function doApplyFileBackup(): Promise<void> {
  const p = fbPreview.value;
  if (!p) return;
  if (!window.confirm('按预检结果恢复？同主键冲突按预检页说明处理，本机不在备份里的数据会保留。')) return;
  fbBusy.value = 'apply';
  try {
    const r = await applyBackup(p.token, fbPicked.value[fbMode.value], fbPassword.value || undefined);
    fbPreview.value = null;
    /**
     * 恢复写的是服务端库，界面上的源列表/发现页结果都还是**内存快照**：
     *  · `useSourcesStore` 的 `loaded` 门闩让源管理/发现页的 `loadMeta()` 直接返回；
     *  · `useDiscoverStore` 的桶与模块级快照缓存要整页刷新才清。
     * ⇒ 不在这里失效，就只能重启服务/重开页面才看得见恢复出来的内容（2026-11-26 用户实测）。
     * 先重新对齐用户数据 + 强刷源，再作废发现页快照（`resetAll` 校验源 id 需要新列表）。
     * ⚠️ 顺序：把「恢复完成」提示放到失效之后 —— 提示一出现就代表列表已对齐，
     *    用户立刻切到源管理/发现页也不会先看到恢复前的旧内容。
     */
    await refreshAfterImport();
    disc.resetAll();
    fbSay('ok', `恢复完成：${JSON.stringify(r).slice(0, 400)}`);
  } catch (e) {
    fbSay('err', e instanceof Error ? e.message : String(e));
  } finally {
    fbBusy.value = '';
  }
}

async function doExportFileBackup(): Promise<void> {
  if (fbNeedPassword.value && !fbPassword.value) {
    fbSay('warn', '勾选的敏感项（Cookie / 源变量）必须给口令');
    return;
  }
  fbBusy.value = 'export';
  try {
    const r = await exportBackupZip(fbMode.value, fbPicked.value[fbMode.value], fbPassword.value || undefined);
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = r.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const stats = Object.entries(r.stats).map(([k, v]) => `${k} ${v}`).join(' · ');
    fbSay('ok', `已导出 ${r.fileName}${stats ? `（${stats}）` : ''}${r.warnings.length ? `；${r.warnings.join('；')}` : ''}`);
  } catch (e) {
    fbSay('err', e instanceof Error ? e.message : String(e));
  } finally {
    fbBusy.value = '';
  }
}

/* ── `#208` ⑤ 源分享：直链上传规则（`D5`=B） ──────────────────
 * 这个规则决定「分享口令」把文件传到哪个网盘。上游在手机端是个独立配置对话框，
 * 本仓放设置页一个分区（值 = 与上游字段名一字不差，便于两边粘贴互通）。
 */
const dl = ref<DirectLinkState | null>(null);
const dlPaste = ref('');
const dlBusy = ref('');
const dlMsg = ref<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
const dlTestResult = ref<DirectLinkTestOutcome | null>(null);

function dlSay(kind: 'ok' | 'warn' | 'err', text: string): void {
  dlMsg.value = { kind, text };
}

async function loadDirectLink(): Promise<void> {
  try {
    dl.value = await getDirectLinkState();
  } catch (e) {
    dlSay('err', '读不到直链上传配置：' + (e instanceof Error ? e.message : String(e)));
  }
}

async function saveDirectLinkPaste(): Promise<void> {
  const t = dlPaste.value.trim();
  if (!t) { dlSay('warn', '先粘贴一条规则（JSON）再保存'); return; }
  dlBusy.value = 'save';
  try {
    dl.value = await putDirectLinkRule({ paste: t });
    dlPaste.value = '';
    dlTestResult.value = null;
    dlSay('ok', '已保存为自定义规则（「分享口令」下次就用它）。建议点「测试上传」确认网盘收不收。');
  } catch (e) {
    dlSay('err', '规则没通过校验：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    dlBusy.value = '';
  }
}

/** 用内置 3 条里的一条：先试一次（不落盘），确认能传再保存 —— 否则用户会存下一个传不上去的规则 */
async function useDefaultRule(i: number): Promise<void> {
  const rule = dl.value?.defaults[i];
  if (!rule) return;
  dlPaste.value = JSON.stringify(rule, null, 2);
  dlTestResult.value = null;
  dlSay('warn', `已把内置第 ${i + 1} 条填进下面的文本框（还没保存）。可先「测试上传」再点保存。`);
}

async function resetDirectLink(): Promise<void> {
  if (!window.confirm('恢复内置默认规则？自定义的那条会被删掉（云端文件不受影响）。')) return;
  dlBusy.value = 'reset';
  try {
    dl.value = await resetDirectLinkRule();
    dlPaste.value = '';
    dlTestResult.value = null;
    dlSay('ok', '已改回内置默认规则');
  } catch (e) {
    dlSay('err', '恢复默认失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    dlBusy.value = '';
  }
}

async function testDirectLinkNow(): Promise<void> {
  dlBusy.value = 'test';
  dlTestResult.value = null;
  try {
    dlTestResult.value = await testDirectLink();
    if (dlTestResult.value.ok) dlSay('ok', '✓ 测试上传成功（网盘收下了 test.json）');
    else dlSay('err', '测试上传失败：' + dlTestResult.value.error);
  } catch (e) {
    dlSay('err', '测试失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    dlBusy.value = '';
  }
}

/** 切分区时按需加载（设置页 8 个分区，不必一进页面就打 3 个请求）。
 *  `immediate: true`：万一以后默认分区改成 backup/share，也不会停在「加载中」。 */
watch(section, (s) => {
  if (s === 'backup' && !wdLoaded.value) void loadWebDav();
  // `#621` 可勾选清单也在这里按需拉（不和 `loadWebDav` 合并：清单是纯静态元数据，
  // 网盘没配置也该显示得出来）
  if (s === 'backup') void loadBackupOptions();
  if (s === 'backup') void loadFileBackupModes();
  if (s === 'share' && !dl.value) void loadDirectLink();
}, { immediate: true });
</script>

<template>
  <div class="settings-layout">
    <!-- 左：分区导航 -->
    <div class="card settings-nav">
      <div
        v-for="s in SECTIONS" :key="s.id"
        class="settings-nav-item" :class="{ on: section === s.id }"
        @click="go(s.id)"
      >{{ s.name }}</div>
    </div>

    <!-- 右：分区内容 -->
    <div class="card settings-content">
      <!-- 外观 -->
      <template v-if="section === 'appearance'">
        <h3>外观</h3>
        <div class="sh-sub">
          `#163` 界面主题 —— 对齐 Legado 的 `ThemeConfig`（不是「主题模式」：模式在下面单独一档，
          它决定**用日间槽还是夜间槽**的颜色）。
        </div>

        <!-- 主题模式（`#145` 从「阅读」分区挪过来：它是外观概念，同时决定正文配色与界面日/夜槽） -->
        <div class="setting-row">
          <div class="setting-info">
            <b>主题模式</b><span>照抄上游 `theme_mode` 4 档；「跟随系统/墨水屏」下墨水屏强制黑白、不取槽</span>
          </div>
          <div class="setting-input">
            <select
              :value="reader.themeMode"
              @change="reader.setThemeMode(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="m in THEME_MODES" :key="m.value" :value="m.value" :title="m.hint">
                {{ m.label }}
              </option>
            </select>
          </div>
        </div>

        <!-- 命名主题：点击应用 -->
        <div class="setting-row">
          <div class="setting-info">
            <b>界面主题</b>
            <span>选择即应用（对应上游「应用主题」：同时把颜色写进对应日夜槽并回写主题模式）；同名另存会覆盖</span>
          </div>
          <div class="setting-input">
            <!--
              `#271`（用户 2026-10-04 晚）：「下拉列表里各主题增加删除功能」。
              原生 `<select>` 的 option 里放不了按钮 ⇒ 换成**自定义下拉**：点击展开主题列表，
              每项「主题名（底色）+ ✕」。规则：
              · 点击主题名 = 选择并应用（原 select 的行为不变）；
              · **当前生效的主题不可删**（正在用）；**内置 5 套不可删**（`UI_THEME_PRESETS`，删除后无法找回）；
              · ✕ 带 confirm 确认。
            -->
            <div class="theme-dd" style="position: relative" data-theme-dd>
              <!-- `#284` 箭头居右：名字居左、▾ 贴右（与筛选组件 sg-btn/fd-btn 同一套布局） -->
              <button class="btn sm theme-dd-btn" @click.stop="themeDdOpen = !themeDdOpen">
                <span class="theme-dd-cur">{{ reader.activeUiThemeName || '选择主题…' }}</span>
                <span class="theme-dd-caret">▾</span>
              </button>
              <div v-if="themeDdOpen" class="theme-dd-list" @click.stop>
                <div
                  v-for="t in reader.prefs.uiThemes" :key="t.themeName"
                  class="theme-dd-item"
                  :class="{ on: t.themeName === reader.activeUiThemeName }"
                  @click="onPickUiTheme(t.themeName); themeDdOpen = false"
                >
                  <span class="theme-dd-name">{{ t.themeName }}（{{ t.backgroundColor }}）</span>
                  <button
                    v-if="t.themeName !== reader.activeUiThemeName && !builtinThemeNames.has(t.themeName)"
                    class="theme-dd-del" title="删除该主题"
                    @click.stop="removeThemeItem(t.themeName)"
                  >✕</button>
                  <span
                    v-else class="theme-dd-lock"
                    :title="t.themeName === reader.activeUiThemeName ? '当前生效的主题不可删除' : '内置主题不可删除'"
                  >🔒</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 当前这套的颜色（直接改槽，不自动进列表） -->
        <div class="setting-row">
          <div class="setting-info">
            <b>颜色</b><span>主色 / 强调色 / 界面底 / 侧栏底（对应上游 `colorPrimary` 等 4 色）</span>
          </div>
          <div class="color-row">
            <label class="color-item"><input type="color" :value="toRrGgBb(theme.primaryColor)" @change="reader.patchUiTheme({ primaryColor: ($event.target as HTMLInputElement).value })" /><span>主色</span></label>
            <label class="color-item"><input type="color" :value="toRrGgBb(theme.accentColor)" @change="reader.patchUiTheme({ accentColor: ($event.target as HTMLInputElement).value })" /><span>强调</span></label>
            <label class="color-item"><input type="color" :value="toRrGgBb(theme.backgroundColor)" @change="reader.patchUiTheme({ backgroundColor: ($event.target as HTMLInputElement).value })" /><span>界面底</span></label>
            <label class="color-item"><input type="color" :value="toRrGgBb(theme.bottomBackground)" @change="reader.patchUiTheme({ bottomBackground: ($event.target as HTMLInputElement).value })" /><span>侧栏底</span></label>
          </div>
        </div>

        <!-- 壁纸 -->
        <div class="setting-row">
          <div class="setting-info">
            <b>壁纸</b><span>内置预设 / 图片 URL / 本机图片（≤400KB，转 data URL 存储）</span>
          </div>
          <div class="setting-input">
            <select :value="theme.backgroundImgPath ?? ''" @change="reader.patchUiTheme({ backgroundImgPath: ($event.target as HTMLSelectElement).value || null })">
              <option v-for="w in WALLPAPER_PRESETS" :key="w.id" :value="w.id">{{ w.label }}</option>
            </select>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>壁纸地址</b><span>http(s) 或 data:image；留空 = 用上面的预设</span></div>
          <div class="setting-input">
            <input
              type="text" placeholder="https://… 或留空"
              :value="/^https?:|^data:image/.test(theme.backgroundImgPath ?? '') ? theme.backgroundImgPath! : ''"
              @change="reader.patchUiTheme({ backgroundImgPath: (($event.target as HTMLInputElement).value || null) })"
            />
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>本机图片</b><span>转 data URL 存进偏好（跟着服务端走）</span></div>
          <div class="setting-input"><input type="file" accept="image/*" @change="onWallpaperFile" /></div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>壁纸模糊</b><span>上游 `backgroundImgBlur`，0 = 不模糊</span></div>
          <div class="setting-input">
            <input
              type="number" min="0" max="40" :value="theme.backgroundImgBlur"
              @change="reader.patchUiTheme({ backgroundImgBlur: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <b>沉浸侧栏</b>
            <span>上游 `transparentNavBar`（导航栏透明）；Web 映射：侧栏/顶栏不铺底色，让壁纸透上来</span>
          </div>
          <div class="switch" :class="{ on: theme.transparentNavBar }" @click="reader.patchUiTheme({ transparentNavBar: !theme.transparentNavBar })"></div>
        </div>

        <!-- 另存 / 删除 -->
        <div class="setting-row">
          <div class="setting-info"><b>保存当前为主题</b><span>同名即覆盖（照抄上游 `addConfig` 的按名替换）</span></div>
          <div class="setting-input" style="display: flex; gap: 6px">
            <input v-model="saveName" type="text" placeholder="主题名" style="width: 110px" />
            <button class="btn sm" :disabled="!saveName.trim()" @click="reader.saveUiThemeAs(saveName); saveName = ''">另存</button>
            <button
              v-if="reader.activeUiThemeName" class="btn sm danger"
              @click="reader.deleteUiTheme(reader.activeUiThemeName)"
            >删除当前</button>
          </div>
        </div>

        <!--
          `#206` **导入 / 导出**。
          上游 `ThemeConfig` 把命名主题存成一个数组（`themeConfig.json`，备份里以
          `themeConfig` 键整体进出 —— `BackupConfig.kt:24,76`），所以导出单元是
          **「全部命名主题」而不是「当前槽」**；另给一枚「只导当前」应付「我只想分享这一套」。
          ★ 导入默认**同名覆盖**（照抄 `addConfigs`，`ThemeConfig.kt:189-205`），
            这样「导出 → 改 → 导回」这个往返可用。
        -->
        <div class="setting-row">
          <div class="setting-info">
            <b>导入 / 导出主题</b>
            <span>导出全部命名主题（<code>.json</code>）；导入走对话框：**粘贴或选文件** → 预览（新增/重复/错误）→ 确认才导入；支持主题包与裸的单 / 多主题数据</span>
          </div>
          <div class="setting-input" style="display: flex; gap: 6px; flex-wrap: wrap">
            <button class="btn sm" :disabled="themeXferBusy" @click="doExportThemes(false)">导出全部</button>
            <button class="btn sm" :disabled="themeXferBusy" @click="doExportThemes(true)">只导当前</button>
            <button class="btn sm" data-theme-import @click="openThemeImport()">导入…</button>
            <span v-if="themeXferMsg" style="align-self: center; font-size: 11px; color: var(--muted)">{{ themeXferMsg }}</span>
          </div>

          <!--
            `#272` 主题导入对话框（用户 2026-10-04 晚：改成**类似字典导入的对话框形式**，
            不是内嵌展开）：可**粘贴**主题数据，也可点「选择文件」；两种来源都走同一条
            预览（解析条数、新增/重复/错误，逐条判定），确认后点「导入 N 套」。
            解析 = `parseThemeInput`（宽容：主题包外壳 / 裸单主题 / 裸多主题数组都认）；
            「重复→跳过 / 覆盖」= `importThemeRules` 的 keepExisting / merge。
          -->
          <div v-if="themeImportOpen" class="mask" style="z-index: 1300" @click.self="cancelThemeImport()">
            <div style="width: min(600px, 94vw); background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); padding: 16px; box-shadow: var(--shadow)">
              <h3 style="margin: 0 0 8px">导入主题</h3>
              <p style="margin: 0 0 8px; font-size: 12px; color: var(--muted)">
                粘贴主题数据（单个主题对象、主题数组，或 <code>kind: "yuedu-themes"</code> 的主题包），
                或点「选择文件」—— 两种方式都会先出预览，确认无误再导入。
              </p>
              <textarea
                v-model="themeImportText" rows="8" spellcheck="false"
                style="width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0); font-family: var(--mono); font-size: 12px"
                placeholder='[{"themeName":"…","isNightTheme":false,"primaryColor":"#…","accentColor":"#…","backgroundColor":"#…","bottomBackground":"#…","transparentNavBar":false,"backgroundImgPath":null,"backgroundImgBlur":0}]'
              ></textarea>
              <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
                <label class="btn sm" style="cursor: pointer">
                  选择文件…
                  <input type="file" accept="application/json,.json" style="display: none" @change="onImportThemesFile" />
                </label>
                <span style="font-size: 11px; color: var(--muted)">文件内容会填进上面的输入框，走同一条预览</span>
              </div>

              <!-- 预览：解析条数 / 新增·重复·错误 / 逐条判定 -->
              <div v-if="themeImportParsed && (themeImportText.trim())" class="pv">
                <div v-if="themeImportParsed.error" class="err" style="font-size: 12px; color: var(--red, #ef4444)">{{ themeImportParsed.error }}</div>
                <template v-else>
                  <div style="display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted)">
                    <span>共解析 <b style="font-size: 14px">{{ themeImportParsed.valid.length + themeImportParsed.rejected.length }}</b> 套</span>
                    <span class="green">新增 <b style="font-size: 14px">{{ themeImportParsed.valid.length - themeImportDupNames.size }}</b></span>
                    <span style="color: var(--orange, #d08700)">重复 <b style="font-size: 14px">{{ themeImportDupNames.size }}</b></span>
                    <span style="color: var(--red, #ef4444)">错误 <b style="font-size: 14px">{{ themeImportParsed.rejected.length }}</b></span>
                  </div>
                  <div v-if="themeImportParsed.valid.length" style="margin-top: 8px; max-height: 200px; overflow: auto; border: 1px solid var(--border); border-radius: 6px">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px">
                      <tbody>
                        <tr v-for="t in themeImportParsed.valid" :key="t.themeName" style="border-bottom: 1px solid var(--border)">
                          <td style="padding: 4px 8px">{{ t.themeName }}</td>
                          <td style="padding: 4px 8px; width: 70px">
                            <span :style="{ color: themeImportDupNames.has(t.themeName) ? 'var(--orange, #d08700)' : 'var(--green, #22c55e)' }">
                              {{ themeImportDupNames.has(t.themeName) ? '重复' : '新增' }}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <ul v-if="themeImportParsed.rejected.length" style="margin: 8px 0 0; padding-left: 18px; font-size: 11.5px; color: var(--orange, #d08700); max-height: 90px; overflow: auto">
                    <li v-for="(x, i) in themeImportParsed.rejected.slice(0, 8)" :key="i">第 {{ x.index + 1 }} 套：{{ x.reason }}</li>
                  </ul>
                  <div style="margin-top: 8px; display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted)">
                    <span>重复处理：</span>
                    <button class="chip" :class="{ on: themePreviewMode === 'keepExisting' }" @click="themePreviewMode = 'keepExisting'">重复 → 跳过</button>
                    <button class="chip" :class="{ on: themePreviewMode === 'merge' }" @click="themePreviewMode = 'merge'">重复 → 覆盖</button>
                  </div>
                </template>
              </div>

              <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px">
                <button class="btn sm" @click="cancelThemeImport()">取消</button>
                <button
                  class="btn sm primary" data-theme-import-commit
                  :disabled="themeXferBusy || !themeImportParsed || themeImportParsed.error !== undefined || themeImportable === 0"
                  @click="confirmThemeImport()"
                >导入 {{ themeImportable }} 套</button>
              </div>
            </div>
          </div>
        </div>

        <h3 style="margin-top: 26px">封面</h3>
        <div class="sh-sub">`#163` 封面配置 —— 对齐上游 `pref_config_cover.xml`；「仅 WiFi 加载」在 Web 上无对应能力，不移植。</div>
        <!-- `#793` 默认封面图片（上游 `defaultCover` / `defaultCoverDark`）：一张图同时用于日/夜槽 -->
        <div class="setting-row">
          <div class="setting-info">
            <b>默认封面图片</b>
            <span>
              没有真实封面的书用这张图（日/夜槽共用）。PNG / JPG / WebP，≤2MB；
              图片存本机（IndexedDB / Electron 用户数据目录），偏好只记标记。
              有真实封面的书不受影响。
            </span>
            <span :class="{ 'cover-state-on': hasCustomCover }">
              当前：{{ hasCustomCover ? '自定义图片' : '内置默认封面（assets/default-cover.jpg）' }}
            </span>
          </div>
          <div class="cover-mgr">
            <CoverImage class="cover-preview" :cover="null" title="示例书名" author="作者" :index="0" />
            <div class="cover-acts">
              <button class="btn sm" :disabled="coverBusy" @click="pickDefaultCover">选择图片…</button>
              <button class="btn sm" :disabled="coverBusy || !hasCustomCover" @click="resetDefaultCover">恢复默认</button>
              <button class="btn sm" :disabled="coverBusy || !hasCustomCover" @click="clearDefaultCover">清除</button>
            </div>
            <input
              ref="coverFileEl" type="file" accept="image/png,image/jpeg,image/webp" style="display: none"
              data-cover-file @change="onDefaultCoverFile"
            />
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <b>强制使用默认封面</b>
            <span>上游 `useDefaultCover`：忽略源站封面，全部用下面生成的封面（书名/作者文字 + 底色）</span>
          </div>
          <div class="switch" :class="{ on: reader.prefs.cover.useDefaultCover }" @click="reader.patchCover({ useDefaultCover: !reader.prefs.cover.useDefaultCover })"></div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>封面显示书名 / 作者 —— 日间</b><span>关掉书名时作者一并禁用（照抄上游联动）</span></div>
          <div class="duo">
            <div class="switch" :class="{ on: reader.prefs.cover.coverShowName }" @click="reader.patchCover({ coverShowName: !reader.prefs.cover.coverShowName })"></div>
            <div class="switch" :class="{ on: reader.prefs.cover.coverShowAuthor, off: !reader.prefs.cover.coverShowName }" @click="reader.prefs.cover.coverShowName && reader.patchCover({ coverShowAuthor: !reader.prefs.cover.coverShowAuthor })"></div>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>封面显示书名 / 作者 —— 夜间</b><span>同上，对应 `coverShowNameN` / `coverShowAuthorN`</span></div>
          <div class="duo">
            <div class="switch" :class="{ on: reader.prefs.cover.coverShowNameN }" @click="reader.patchCover({ coverShowNameN: !reader.prefs.cover.coverShowNameN })"></div>
            <div class="switch" :class="{ on: reader.prefs.cover.coverShowAuthorN, off: !reader.prefs.cover.coverShowNameN }" @click="reader.prefs.cover.coverShowNameN && reader.patchCover({ coverShowAuthorN: !reader.prefs.cover.coverShowAuthorN })"></div>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <b>封面文字横排</b>
            <span>上游 `coverHorizontal`；默认关闭 = 竖排（Android 原生习惯，PC 上可按喜好开）</span>
          </div>
          <div class="switch" :class="{ on: reader.prefs.cover.coverHorizontal }" @click="reader.patchCover({ coverHorizontal: !reader.prefs.cover.coverHorizontal })"></div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>封面保留标点</b><span>上游 `coverKeepPunctuation`；关闭时去掉 Unicode 标点（`bdRegex` = `\p{P}`）</span></div>
          <div class="switch" :class="{ on: reader.prefs.cover.coverKeepPunctuation }" @click="reader.patchCover({ coverKeepPunctuation: !reader.prefs.cover.coverKeepPunctuation })"></div>
        </div>
      </template>

      <!-- 阅读 -->
      <template v-else-if="section === 'reading'">
        <h3>阅读</h3>
        <div class="sh-sub">
          阅读器行为设置。阅读样式（字号 / 排版 / 颜色 / 边距 / 标题 / 下划线 / 简繁转换）的入口已移到阅读界面工具栏的「样式」按钮。
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>续读记忆</b><span>打开书架卡片自动定位到最后阅读章节</span></div>
          <span class="tag green">已启用</span>
        </div>
        <!-- `#144`：阅读时长记录（`AppConfig.enableReadRecord`，默认开） -->
        <div class="setting-row">
          <div class="setting-info">
            <b>记录阅读时长</b>
            <span>
              对应上游 `AppConfig.enableReadRecord`（默认 **开**）。按**书名**累计阅读时间（同上游
              `ReadRecord` 主键），存在服务端并在换设备时聚合；翻章/离开阅读/页面隐藏时结算。
            </span>
          </div>
          <div class="setting-input">
            <label class="rr-global" data-rr-global>
              <input
                type="checkbox" :checked="reader.prefs.enableReadRecord"
                @change="reader.patchPrefs({ enableReadRecord: !reader.prefs.enableReadRecord })"
              />
              {{ reader.prefs.enableReadRecord ? '已启用' : '已关闭' }}
            </label>
          </div>
        </div>
        <!-- 5-5：正文预缓存窗口（用户要求：默认保持 20 章未读正文缓存） -->
        <div class="setting-row">
          <div class="setting-info">
            <b>预缓存章节数</b>
            <span>
              书架里的书随阅读进度自动向后预取这么多「未读章节」的正文，保持窗口大小（默认 20，0 = 关闭）；
              未加入书架、只是点开阅读的书固定预取 <b>3 章</b>。
              缓存后可离线/断网阅读；<b>已读章节与预取过的章节都会一直保留</b>，回跳不会清理，
              也不会动你点「⬇ 缓存」手动缓存的那批。
              正文缓存没有自动淘汰，需要手动清理（设置 → 缓存治理，或详情页「🧹 清缓存」）。
            </span>
          </div>
          <div class="setting-input">
            <input
              :value="reader.precacheCount" type="number" min="0" max="200"
              @change="reader.setPrecacheCount(Number(($event.target as HTMLInputElement).value))"
            />
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <b>当前预缓存</b>
            <span v-if="reader.precacheState.running">后台缓存中 {{ reader.precacheState.done }} / {{ reader.precacheState.total }}</span>
            <span v-else>窗口 {{ reader.precacheCount }} 章 · 空闲</span>
          </div>
          <button class="btn sm" @click="reader.prefetchWindow()">立即维护窗口</button>
        </div>
        <!--
          `#811` 翻页动画（分页模式才显示）。
          用户 2026-11-09：这里**不再放**「阅读视图模式」「自动滚动速度」——
          两项在阅读界面「更多 → 样式 → 动画」已有，设置页只保留这一处不重复的档位。
        -->
        <div v-if="reader.viewMode === 'paged'" class="setting-row">
          <div class="setting-info">
            <b>翻页动画</b>
            <span>只在分页模式下有意义（对应上游 `PageAnim` 的五个档位）。</span>
          </div>
          <div class="setting-input">
            <select data-reader-page-anim :value="String(reader.readStyle.pageAnim)" @change="onPageAnimChange($event)">
              <option v-for="o in PAGE_ANIM_OPTIONS" :key="o.value" :value="String(o.value)" :title="o.hint">
                {{ o.label }}
              </option>
            </select>
          </div>
        </div>
        <!-- B8 屏幕常亮（默认关；只在阅读界面打开期间生效）。
             用户 2026-11-09：从「更多 → 样式 → 动画」迁到这里 —— 与阅读页共用
             `utils/keep-awake.ts` 的同一个 `keepAwakePref`，不存在两份状态。 -->
        <div class="setting-row">
          <div class="setting-info">
            <b>屏幕常亮</b>
            <span>
              阅读时不让系统自动熄屏（Screen Wake Lock），默认<b>关</b>；
              只在阅读界面打开期间生效，退出阅读即释放。
            </span>
            <span v-if="!keepAwakeSupported" class="tag orange">当前环境不支持（需要 https 或 localhost）</span>
          </div>
          <div class="setting-input">
            <div
              class="switch" :class="{ on: keepAwakePref, off: !keepAwakeSupported }"
              role="switch" :aria-checked="keepAwakePref" data-reader-keepawake="on"
              :title="!keepAwakeSupported ? '当前环境不支持 Screen Wake Lock' : (keepAwakePref ? '点击关闭' : '点击开启（Screen Wake Lock）')"
              @click="keepAwakeSupported && setKeepAwakePref(!keepAwakePref)"
            ></div>
          </div>
        </div>
      </template>

      <!-- `#144`：净化（替换）规则 -->
      <template v-else-if="section === 'purify'">
        <h3>净化</h3>
        <div class="sh-sub">
          用户**全局**替换规则（对齐 Legado `ReplaceRule`）。规则存在服务端（`/api/user/replace-rules`），
          换设备/换浏览器都能带走；在**阅读时**应用，**缓存里存的仍是原文**。
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <b>正文默认启用净化</b>
            <span>
              对应上游 `AppConfig.replaceEnableDefault`（默认 **开**）—— 这是**全局默认**。
              每本书还能在**阅读界面 →「更多 → 替换净化」**里单独覆盖它（上游
              `Book.ReadConfig.useReplaceRule`，`null` = 跟随这里）。
            </span>
          </div>
          <div class="setting-input">
            <label class="rr-global" data-rr-global>
              <input
                type="checkbox" :checked="reader.prefs.replaceEnableDefault"
                @change="reader.patchPrefs({ replaceEnableDefault: !reader.prefs.replaceEnableDefault })"
              />
              {{ reader.prefs.replaceEnableDefault ? '已启用' : '已关闭' }}
            </label>
          </div>
        </div>
        <ReplaceRulesPanel />
      </template>

      <!-- 播放 -->
      <template v-else-if="section === 'playback'">
        <h3>播放</h3>
        <div class="sh-sub">影视播放与观影历史</div>
        <div class="setting-row">
          <div class="setting-info"><b>观影历史</b><span>开始播放时自动记录，可在影视页删除单条</span></div>
          <button class="btn sm danger" @click="clearWatch">清空观影历史</button>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>播放内核</b><span>m3u8/mp4 直链（video 标签）；播放页管道待接入 play action</span></div>
          <span class="tag orange">建设中</span>
        </div>
      </template>

      <!-- `#822` 朗读（HTTP TTS） -->
      <template v-else-if="section === 'tts'">
        <TtsEnginePanel />
      </template>

      <!-- 服务与网络 -->
      <template v-else-if="section === 'network'">
        <h3>服务与网络</h3>
        <div class="sh-sub">后端服务与请求</div>
        <div class="setting-row">
          <div class="setting-info"><b>服务地址</b><span>桌面端内置服务；浏览器直连时与页面同源</span></div>
          <code class="mono">{{ origin }}</code>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>服务状态</b><span>API 心跳探测</span></div>
          <span class="tag" :class="serverOk ? 'green' : 'red'">{{ serverOk === null ? '检测中…' : serverOk ? '在线' : '离线' }}</span>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>引擎</b><span>已加载引擎及能力</span></div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap">
            <span v-for="e in st.engines" :key="e.kind" class="tag">{{ e.kind }} · {{ e.capabilities.join('/') }}</span>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>Cookie / 登录态</b><span>按源隔离，服务端持久化（data/cookies.json）</span></div>
          <span class="tag">{{ st.sources.length }} 源</span>
        </div>
        <!-- `#515` P1-2/P1-3 收尾：渲染共享宿主（`#525` 10-23 观察期满改**默认开**，
             开关落盘，对新渲染会话生效）。打开后所有源的渲染共用一只 Chromium；
             凭证（含 cf_clearance）持久化在 profile 目录，撞 CF 的源仍能复用 clearance，
             不必反复过挑战。`YUEDU_BROWSER_CONTEXT=0` 可钉死关。 -->
        <div class="setting-row">
          <div class="setting-info">
            <b>渲染共享宿主浏览器</b>
            <span>所有源的渲染共用一只 Chromium：内存约 -67%、后续源冷启约快 10 倍。凭证已持久化（含 cf_clearance），撞 CF 的源可复用。开关对新渲染会话生效</span>
          </div>
          <div class="switch" :class="{ on: ctxMode }" title="开启 / 关闭渲染共享宿主" @click="toggleCtxMode()"></div>
        </div>
        <!-- `#516` 清理入口（用户要求：「设置 → 服务与网络」加一个清理所有） -->
        <div class="setting-row">
          <div class="setting-info">
            <b>清理缓存与 Cookie</b>
            <span>清空离线正文缓存、书籍详情/目录本地化、下载任务，并清掉所有源的 Cookie（含渲染凭证）。清理后已下载内容需要重新下载</span>
          </div>
          <button class="btn sm danger" :disabled="cacheClearing" @click="clearEverything()">
            {{ cacheClearing ? '清理中…' : '清理全部' }}
          </button>
        </div>

        <!-- `#386` 引擎系统代理：引擎（undici）默认不吃系统代理，直连被运营商阻断的站点
             （如 Cloudflare 104.26 段）需要借代理出网。保存即生效，不用重启。 -->
        <div class="setting-row" style="align-items: flex-start">
          <div class="setting-info">
            <b>引擎走系统代理</b>
            <span>让引擎与浏览器走同一条代理出网（绕开直连被断的网段）。地址留空 = 读服务端环境变量 http_proxy</span>
          </div>
          <label style="display:flex;align-items:center;gap:8px;white-space:nowrap">
            <input
              type="checkbox"
              :checked="proxyEnabled"
              :disabled="proxyBusy"
              @change="saveProxy(($event.target as HTMLInputElement).checked)"
            />
            {{ proxyEnabled ? '已开启' : '已关闭' }}
          </label>
        </div>
        <div class="setting-row" v-if="proxyEnabled || proxyUrl">
          <div class="setting-info"><b>代理地址</b><span>例：http://127.0.0.1:7890（Clash 等本地代理的混合端口）</span></div>
          <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
            <input
              v-model="proxyUrl"
              class="mono"
              type="text"
              placeholder="http://127.0.0.1:7890"
              style="width:260px"
              :disabled="proxyBusy"
              @change="saveProxy(proxyEnabled)"
            />
            <span v-if="proxySay" :style="{ color: proxySay.kind === 'ok' ? 'var(--ok, #2a8)' : 'var(--bad, #c44)', fontSize: '12px' }">{{ proxySay.text }}</span>
          </div>
        </div>
      </template>

      <!-- `#816` B5 缓存治理 -->
      <template v-else-if="section === 'cache'">
        <CacheGovernancePanel />
      </template>

      <!-- 数据备份 -->
      <template v-else-if="section === 'backup'">
        <h3>数据备份</h3>

        <!-- 文件备份 / 恢复：两种模式并列 -->
        <div class="sh-sub">
          两种模式并列：<b>Legado 兼容</b>只含 Legado 支持的项目（CMS 影视源不进）；
          <b>本仓完整</b>含所有可备份项（CMS 影视源、TTS 等本项目独有数据）。
          导入前一律先预检，把「会跳过什么、会覆盖什么」写在确认页。
        </div>
        <div class="bk-mode" data-fb-mode>
          <label class="rr-global">
            <input v-model="fbMode" type="radio" value="legado" @change="fbPreview = null" />
            ① Legado 兼容备份 / 恢复
          </label>
          <label class="rr-global">
            <input v-model="fbMode" type="radio" value="full" @change="fbPreview = null" />
            ② 本项目完整备份 / 恢复
          </label>
        </div>
        <div v-if="fbOptions.length" class="bk-opts" data-fb-options>
          <div class="bk-opts-head">备份 / 恢复内容（依赖项会自动成组勾选）</div>
          <label v-for="o in fbOptions" :key="o.id" class="bk-opt" :class="{ sens: o.sensitive }">
            <input
              type="checkbox"
              :checked="fbPickedNow.includes(o.id)"
              @change="fbToggle(o.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="bk-opt-label">{{ o.label }}</span>
            <span class="bk-opt-desc">
              {{ o.desc }}<template v-if="o.requires?.length">（依赖：{{ o.requires.join(' / ') }}）</template>
            </span>
          </label>
          <div class="bk-opts-foot">
            <label class="bk-pwd">
              <span>口令{{ fbNeedPassword ? '（必填：含敏感项）' : '（可选：加密备份需要）' }}</span>
              <input v-model="fbPassword" type="password" class="ops-input" placeholder="备份口令" data-fb-password />
            </label>
          </div>
        </div>
        <div v-else-if="fbMsg?.kind === 'err'" class="hint" data-fb-options-err>{{ fbMsg.text }}</div>
        <div class="setting-row">
          <div class="setting-info">
            <b>从文件恢复</b>
            <span>{{ fbFileName || '选择 Legado 导出的 zip 或本仓导出的 zip；只解析不写库' }}</span>
          </div>
          <div class="setting-input" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <input ref="fbFileEl" type="file" accept="application/zip,.zip" style="display: none" @change="onPickBackupFile" />
            <button class="btn sm" :disabled="!!fbBusy" data-fb-pick @click="fbPickFile">
              {{ fbBusy === 'inspect' ? '预检中…' : '选择文件并预检…' }}
            </button>
            <button
              v-if="fbPreview"
              class="btn sm primary"
              :disabled="!!fbBusy || (fbNeedPassword && !fbPassword)"
              data-fb-apply
              @click="doApplyFileBackup"
            >
              {{ fbBusy === 'apply' ? '恢复中…' : '确认恢复' }}
            </button>
          </div>
        </div>
        <div v-if="fbPreview" class="fb-preview" data-fb-preview>
          <b>预检结果（会跳过什么 / 会覆盖什么）</b>
          <ul>
            <li v-for="(line, i) in fbPreviewLines" :key="i">{{ line }}</li>
          </ul>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>导出到文件</b><span>按上面勾选内容打包；密码只用于加密敏感项</span></div>
          <button class="btn sm" :disabled="!!fbBusy" data-fb-export @click="doExportFileBackup">
            {{ fbBusy === 'export' ? '导出中…' : '导出 zip' }}
          </button>
        </div>
        <div v-if="fbMsg" class="hint" :class="`fb-${fbMsg.kind}`" data-fb-msg>{{ fbMsg.text }}</div>

        <h3 style="margin-top: 26px">JSON 快照</h3>
        <div class="sh-sub">用户数据（书架 / 目录 / 书签 / 划线 / 净化 / 字典 / 分组 / 阅读时长 / 偏好）</div>
        <div class="setting-row">
          <div class="setting-info">
            <b>导出用户数据</b>
            <span>JSON 快照，可换设备恢复；正文不在快照里，勾「含目录」后文件会大一些</span>
          </div>
          <div class="setting-input" style="display: flex; gap: 8px; align-items: center">
            <label class="rr-global"><input type="checkbox" v-model="exportWithChapters" />含目录</label>
            <button class="btn sm" :disabled="busy === 'export'" @click="doExport">
              {{ busy === 'export' ? '导出中…' : '导出' }}
            </button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-info">
            <b>导入用户数据</b>
            <span>{{ importHint }}</span>
          </div>
          <div class="setting-input" style="display: flex; gap: 8px; align-items: center">
            <input ref="fileEl" type="file" accept="application/json,.json" style="display: none" @change="onPickFile" />
            <button class="btn sm" :disabled="busy === 'import'" @click="fileEl?.click()">选择文件…</button>
            <button v-if="pending" class="btn sm primary" :disabled="busy === 'import'" @click="doImport">
              {{ busy === 'import' ? '导入中…' : '确认导入' }}
            </button>
          </div>
        </div>
        <div v-if="pending" class="setting-row">
          <div class="setting-info"><b>待导入内容</b><span>{{ pendingSummary }}</span></div>
          <div class="setting-input">
            <label class="rr-global"><input type="checkbox" v-model="overwrite" />覆盖同名项</label>
          </div>
        </div>
        <div v-if="importResultText" class="setting-row">
          <div class="setting-info"><b>上次导入结果</b><span>{{ importResultText }}</span></div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>源清单导出</b><span>Legado 导入格式 JSON（全部源）</span></div>
          <button class="btn sm" @click="exportCookies">导出</button>
        </div>
        <div class="setting-row">
          <div class="setting-info"><b>书架（{{ reader.shelf.length }} 条）</b><span>书籍收藏 + 影视收藏，含续读进度（浏览器本地）</span></div>
          <button class="btn sm danger" @click="clearShelf">清空书架</button>
        </div>
        <!-- ═══ `#208` ⑤ WebDAV 同步（真实现；此前是「规划中」占位） ═══ -->
        <h3 data-wd-block style="margin-top: 26px">WebDAV 同步</h3>
        <div class="sh-sub">
          跨设备同步阅读进度，并把整库备份到云端。配置只存在本机服务端（`data/webdav.json`），密码不会回显。
        </div>

        <div class="wd-grid">
          <span class="wd-lab">地址</span>
          <input v-model="wd.url" data-wd-url placeholder="https://dav.example.com/remote.php/dav/files/用户名" />
          <span class="wd-lab">账号</span>
          <input v-model="wd.username" data-wd-user placeholder="WebDAV 用户名" />
          <span class="wd-lab">密码</span>
          <input
            v-model="wd.password" data-wd-pass type="password" autocomplete="new-password"
            :placeholder="wd.hasPassword ? '已保存 —— 留空表示不修改' : '多数服务要「应用专用密码」，不是登录密码'"
          />
          <span class="wd-lab">子目录</span>
          <input v-model="wd.dir" data-wd-dir placeholder="可空；填了就在该子目录下同步" />
          <span class="wd-lab">认证编码</span>
          <select v-model="wd.authEncoding">
            <option value="utf-8">utf-8（推荐）</option>
            <option value="iso-8859-1">iso-8859-1（老服务端才需要）</option>
          </select>
          <span class="wd-lab">进度同步</span>
          <label class="rr-global">
            <input v-model="wdSyncProgress" type="checkbox" data-wd-sync-progress />
            开启（同步一次 = 先拉远端、再推本机；只前进不后退）
          </label>
        </div>

        <div class="wd-actions">
          <button class="btn sm" data-wd-test :disabled="!!wdBusy" @click="testWebDavConn">
            {{ wdBusy === 'test' ? '⟳ 测试中…' : '测试连接' }}
          </button>
          <button class="btn sm primary" data-wd-save :disabled="!!wdBusy" @click="saveWebDav">
            {{ wdBusy === 'save' ? '⟳ 保存中…' : '保存' }}
          </button>
          <button class="btn sm" data-wd-sync :disabled="!!wdBusy || !wdConfigured" @click="doSync(false)">
            {{ wdBusy === 'sync' ? '⟳ 同步中…' : '⟳ 同步一次' }}
          </button>
          <button class="btn sm" data-wd-pull :disabled="!!wdBusy || !wdConfigured" @click="doSync(true)">
            {{ wdBusy === 'pull' ? '⟳ 拉取中…' : '⬇ 只拉取远端' }}
          </button>
          <button class="btn sm danger" data-wd-del :disabled="!!wdBusy || !wdConfigured" @click="delWebDav">删除配置</button>
        </div>

        <div v-if="wdLoaded && !wdConfigured" class="hint" style="margin-top: 6px">
          还没配置：账号与密码都填上并「保存」之后，「同步」按钮才会可用。
        </div>
        <div v-if="wdMsg" class="wd-msg" :class="wdMsg.kind" data-wd-msg>{{ wdMsg.text }}</div>

        <!-- 同步报告：数字直接摆出来，别只回一句「同步完成」 -->
        <div v-if="syncReport" class="wd-report" data-wd-report>
          <div class="wd-report-head">本次同步（共 {{ syncReport.books }} 本）</div>
          <div class="wd-stats">
            <div class="wd-stat">远端进度文件 <b>{{ syncReport.remoteFiles }}</b></div>
            <div class="wd-stat">下载了 <b>{{ syncReport.downloaded }}</b></div>
            <div class="wd-stat">本地被推进 <b>{{ syncReport.adopted.length }}</b></div>
            <div class="wd-stat">上传了 <b>{{ syncReport.uploaded.length }}</b></div>
            <div class="wd-stat">跳过（远端不比本地新） <b>{{ syncReport.skipped }}</b></div>
          </div>
          <div v-if="syncReport.errors.length" class="wd-errs">
            <div v-for="(e, i) in syncReport.errors.slice(0, 10)" :key="i">{{ e.name || e.bookUrl }}：{{ e.error }}</div>
            <div v-if="syncReport.errors.length > 10">…还有 {{ syncReport.errors.length - 10 }} 条</div>
          </div>
        </div>

        <!-- 整库备份 / 恢复 -->
        <h3 data-wd-backup style="margin-top: 26px">云端备份 / 恢复</h3>
        <div class="sh-sub">
          文件名为上游格式 <code>backup&lt;日期&gt;.zip</code> ⇒ 同一天重复备份会覆盖。
          <b>每次备份成功后按「保留份数」自动清理更早的文件</b>（默认 1 = 只保留最新）。
        </div>
        <!-- `B7` ④ 保留份数：1~10，默认 1；改设置不立刻删云端文件，下一次成功备份后才轮转 -->
        <div class="bk-rotate" data-bk-rotate>
          <span class="bk-rotate-lab">保留份数</span>
          <select
            v-model.number="wdBackupKeep" class="ops-input" data-bk-keep
            :disabled="!!wdBusy || wdKeepBusy || !wdConfigured" @change="saveBackupKeep"
          >
            <option v-for="n in 10" :key="n" :value="n">{{ n === 1 ? '1（默认 · 只保留最新）' : `${n} 份` }}</option>
          </select>
          <span class="hint">{{ wdKeepBusy ? '⟳ 保存中…' : '备份成功后清理更早的备份；1 = 只保留最新。' }}</span>
        </div>
        <!-- `#621` 备份内容勾选：清单来自服务端 `/api/backup/options`（唯一真相源） -->
        <div v-if="backupOptionList.length" class="bk-opts" data-bk-options>
          <div class="bk-opts-head">备份内容</div>
          <label v-for="o in backupOptionList" :key="o.id" class="bk-opt" :class="{ sens: o.sensitive }">
            <input v-model="backupPicked" type="checkbox" :value="o.id" />
            <span class="bk-opt-label">{{ o.label }}</span>
            <span class="bk-opt-desc">{{ o.desc }}</span>
          </label>
          <div class="bk-opts-foot">
            <label class="bk-pwd">
              <span>备份口令</span>
              <input
                v-model="backupPassword"
                type="password"
                autocomplete="new-password"
                placeholder="勾了 Cookie / 源变量时必填"
                data-bk-password
              />
            </label>
            <span class="hint">
              口令只用来加密 Cookie 与源变量（AES，与手机端 Legado 同一套参数）；主快照本身是明文。
              恢复时要用同一个口令。
            </span>
          </div>
          <details v-if="backupUnsupported.length" class="bk-unsup">
            <summary>为什么没有「封面 / 背景」这些勾选框？</summary>
            <div v-for="u in backupUnsupported" :key="u.upstreamKey" class="bk-unsup-row">
              <b>{{ u.label }}</b><span>{{ u.why }}</span>
            </div>
          </details>
        </div>
        <div v-else-if="backupOptionsError" class="hint" data-bk-options-err>
          读不到可勾选清单（{{ backupOptionsError }}）⇒ 本次将按<b>服务端默认内容</b>备份。
        </div>

        <!-- `B7` ③ 恢复方式：默认覆盖（保持原有语义）；合并只补缺失，跨设备保守合并用 -->
        <div class="bk-restore-mode" data-bk-restore-mode>
          <span class="bk-rotate-lab">恢复方式</span>
          <label class="rr-global">
            <input v-model="wdRestoreMode" type="radio" value="overwrite" data-bk-mode-overwrite />
            覆盖 <span class="hint">（默认，还原如初）</span>
          </label>
          <label class="rr-global">
            <input v-model="wdRestoreMode" type="radio" value="merge" data-bk-mode-merge />
            合并 <span class="hint">（只补缺失，不覆盖现有）</span>
          </label>
        </div>
        <div class="wd-actions">
          <button class="btn sm primary" data-wd-backup-do :disabled="!!wdBusy || !wdConfigured" @click="doBackup">
            {{ wdBusy === 'backup' ? '⟳ 备份中…' : '⬆ 备份到云端' }}
          </button>
          <!-- ⚠️ 写 `loadBackups()` 而不是 `loadBackups`：后者会把 PointerEvent 当第一个实参
               （`quiet`）传进去 ⇒ 刷新变静默、按钮也不转（vue-tsc 会报，别跳过 typecheck） -->
          <button class="btn sm" data-wd-backup-list :disabled="!!wdBusy || !wdConfigured" @click="loadBackups()">
            {{ wdBusy === 'list' ? '⟳ 读取中…' : '↻ 列出云端备份' }}
          </button>
        </div>
        <div v-if="backups.length" class="bk-list" data-wd-backup-list-body>
          <div v-for="b in backups" :key="b.name" class="bk-item">
            <div class="bk-info">
              <b>{{ b.name }}</b>
              <span>{{ fmtBytes(b.size) }} · {{ fmtTime(b.lastModify) }}</span>
            </div>
            <button class="btn sm danger" :disabled="!!wdBusy" @click="doRestore(b.name)">
              {{ wdBusy === 'restore' ? '⟳ 恢复中…' : '恢复…' }}
            </button>
          </div>
        </div>
        <div v-else-if="wdLoaded && wdConfigured" class="hint" style="margin-top: 6px">
          还没读云端列表（点「列出云端备份」）。
        </div>
      </template>

      <!-- `#208` ⑤ 源分享：直链上传规则 -->
      <template v-else-if="section === 'share'">
        <h3>源分享</h3>
        <div class="sh-sub">
          在源管理里点「分享口令」时，源文件会先上传到一个网盘，再把下载地址混淆成中文口令。
          这里配置的就是「传到哪个网盘」。字段名与手机端 Legado 完全一致，两边可以互相粘贴。
        </div>

        <div v-if="dl" class="dl-cur" data-dl-current>
          <div class="dl-cur-head">
            <b>当前生效：{{ dl.rule.summary || '（这条规则没写注释）' }}</b>
            <span class="tag" :class="dl.custom ? 'green' : ''">{{ dl.custom ? '自定义' : '内置默认' }}</span>
          </div>
          <div class="kv"><span>上传地址</span><b class="mono">{{ dl.rule.uploadUrl }}</b></div>
          <div class="kv"><span>下载规则</span><b class="mono">{{ dl.rule.downloadUrlRule }}</b></div>
          <div class="kv"><span>有效期</span><b>{{ dl.rule.expiryDate ? dl.rule.expiryDate + ' 天' : '永久' }} · {{ dl.rule.compress ? '压缩后上传' : '原样上传' }}</b></div>
        </div>

        <div class="wd-actions">
          <button class="btn sm" data-dl-test :disabled="!!dlBusy" @click="testDirectLinkNow">
            {{ dlBusy === 'test' ? '⟳ 测试中…' : '🧪 测试上传（传一个 test.json）' }}
          </button>
          <button class="btn sm danger" data-dl-reset :disabled="!!dlBusy || !dl?.custom" @click="resetDirectLink">
            恢复内置默认
          </button>
        </div>
        <div v-if="dlMsg" class="wd-msg" :class="dlMsg.kind" data-dl-msg>{{ dlMsg.text }}</div>
        <div v-if="dlTestResult?.ok" class="dl-test-ok" data-dl-test-result>
          ✓ 测试成功 · 文件名 <b>{{ dlTestResult.result.fileName }}</b>
          · {{ (dlTestResult.result.byteLength / 1024).toFixed(1) }} KB
          · 下载地址 <span class="mono">{{ dlTestResult.result.downloadUrl }}</span>
        </div>

        <h3 style="margin-top: 24px">改用别的网盘 / 自定义规则</h3>
        <div class="sh-sub">
          内置 3 条是上游自带的公用网盘（可用性随时可能变）。点一条填进下面文本框，可先「测试上传」再保存。
        </div>
        <div class="wd-actions" data-dl-defaults>
          <button
            v-for="(d, i) in (dl?.defaults ?? [])" :key="i"
            class="chip" @click="useDefaultRule(i)"
          >{{ i + 1 }}. {{ d.summary }}</button>
        </div>
        <textarea
          v-model="dlPaste" class="ta" rows="7" spellcheck="false" data-dl-paste
          placeholder='粘贴一条规则 JSON，例如：&#10;{ "uploadUrl": "…", "downloadUrlRule": "…", "summary": "…", "compress": false, "expiryDate": 30 }&#10;（容忍 // 注释与尾逗号；只能有一条）'
        ></textarea>
        <div class="wd-actions">
          <button class="btn sm primary" data-dl-save :disabled="!!dlBusy || !dlPaste.trim()" @click="saveDirectLinkPaste">
            {{ dlBusy === 'save' ? '⟳ 保存中…' : '保存为自定义规则' }}
          </button>
          <span class="hint">保存后「分享口令」立刻改用这条（不用重启服务）。</span>
        </div>
      </template>

      <!-- `#210` 运维：定时更新书架 / 性能面板 / 崩溃日志（数据全部来自服务端，浏览器桌面端都能用） -->
      <template v-else-if="section === 'ops'">
        <!-- `#558` 源医生巡检间隔（用户：频率太高，给接口） -->
        <h3>源医生巡检</h3>
        <div class="sh-sub">
          服务端定时把全部源过一遍规则结构检查（不联网）：只播报「相对上一轮新增 / 恢复」的问题。
          巡检本身很便宜（几百源 ≈ 亚秒级），但结论不会分钟级变化，<b>默认 7 天一轮</b>。
        </div>
        <div class="wd-actions" data-patrol-controls>
          <label class="hint" style="display:flex;align-items:center;gap:6px">
            巡检间隔
            <select v-model.number="patrolHoursDraft" class="ops-input" data-patrol-hours :disabled="patrolCfg?.pinned">
              <option v-for="h in patrolCfg?.options ?? [24, 72, 168, 720]" :key="h" :value="h">
                {{ patrolLabel(h) }}{{ h === (patrolCfg?.defaultHours ?? 168) ? '（默认）' : '' }}
              </option>
            </select>
          </label>
          <button class="btn sm" data-patrol-save :disabled="!!patrolCfg?.pinned" @click="savePatrolCfg">保存</button>
          <span v-if="patrolCfg?.pinned" class="hint" data-patrol-pinned>
            被环境变量 YUEDU_DOCTOR_PATROL_EVERY_MS 钉住，这里改不了
          </span>
        </div>
        <div v-if="patrolCfg" class="hint" data-patrol-meta>
          当前生效：每 {{ patrolLabel(patrolCfg.hours) }} 一轮（{{ Math.round(patrolCfg.everyMs / 3600000) }} 小时）
        </div>
        <div v-else class="hint">读不到巡检配置（服务端没起？）</div>
        <div v-if="patrolMsg" class="wd-msg" :class="patrolMsg.kind" data-patrol-msg>{{ patrolMsg.text }}</div>

        <h3 style="margin-top: 26px">定时更新书架</h3>
        <div class="sh-sub">
          服务端每隔一段时间把书架里的在线书逐本重查一次目录：有新章节就在这里记下来。
          本地书和「关闭更新」的书不查。整个过程串行、带间隔，走与服务端其它请求相同的流量护栏。
        </div>

        <div class="wd-actions" data-up-controls>
          <label class="hint" style="display:flex;align-items:center;gap:6px">
            <input
              type="checkbox" data-up-enabled :checked="shelfUp?.config.enabled"
              :disabled="opsBusy !== ''" @change="toggleShelfUpdate(($event.target as HTMLInputElement).checked)"
            />
            自动更新（服务开着就查，不需要本页面开着）
          </label>
          <span class="hint">间隔（分钟）</span>
          <input v-model.number="intervalDraft" class="ops-input" data-up-interval type="number" min="5" max="1440" />
          <button class="btn sm" data-up-save :disabled="opsBusy !== ''" @click="saveUpConfig">保存间隔</button>
          <button class="btn sm primary" data-up-run :disabled="opsBusy === 'run' || !!shelfUp?.running" @click="runShelfUpdateNow">
            {{ shelfUp?.running ? `⟳ 更新中 ${shelfUp.progress ? shelfUp.progress.done + '/' + shelfUp.progress.total : '…'}` : '立即更新' }}
          </button>
        </div>
        <div class="hint" data-up-meta>
          上次整轮：{{ fmtIso(shelfUp?.lastRunAt) }}
          <template v-if="shelfUp?.lastDurationMs != null"> · 耗时 {{ (shelfUp.lastDurationMs / 1000).toFixed(1) }}s</template>
          · 下次自动：{{ shelfUp?.config.enabled ? fmtIso(shelfUp?.nextRunAt) : '（已关闭）' }}
        </div>
        <div v-if="shelfUp?.lastError" class="wd-msg warn" data-up-lasterror>⚠ {{ shelfUp.lastError }}</div>
        <div v-if="opsMsg" class="wd-msg" :class="opsMsg.kind" data-up-msg>{{ opsMsg.text }}</div>

        <table v-if="shelfUp?.results?.length" class="kv-table" data-up-results>
          <thead><tr><th>书名</th><th>结果</th><th>目录变化</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in shelfUp.results" :key="i">
              <td>{{ r.name }}</td>
              <td>
                <span v-if="r.status === 'ok'" :class="r.added > 0 ? 'tag green' : 'tag'">
                  {{ r.added > 0 ? `新增 ${r.added} 章` : '无新增' }}
                </span>
                <span v-else class="tag" :title="r.error">失败：{{ r.error }}</span>
              </td>
              <td class="hint">{{ r.oldCount }} → {{ r.newCount }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="hint" data-up-empty>还没有更新记录 —— 点「立即更新」跑一轮试试。</div>

        <h3 style="margin-top: 24px">外链脚本（镜像兜底）</h3>
        <div class="sh-sub">
          jsLib / loginUrl / sortUrl 这类外链脚本先走网络，失败才用本地镜像兜底。
          同一个地址连续失败到阈值只提示一次：看到下面条目说明浏览器能下、引擎下不了，
          按路径手动放一份即可（不用改源）。
        </div>
        <template v-if="diag?.jslibHints?.length">
          <div v-for="h in diag.jslibHints" :key="h.url" class="wd-msg warn" data-jslib-hint>
            <div class="mono" style="word-break: break-all">{{ h.url }}</div>
            <div>连续失败 {{ h.fails }} 次（最近一次：{{ h.reason }}），请用浏览器下载后保存到：</div>
            <div class="mono" style="word-break: break-all">{{ h.absPath }}</div>
            <div class="hint">浏览器下载后按此路径保存，重启服务生效。</div>
          </div>
        </template>
        <div v-else class="hint" data-jslib-hint-empty>
          没有待处理的提示 —— 外链脚本都在正常下载，或已放到 <code>data/jslib-mirror/</code>。
        </div>

        <h3 style="margin-top: 24px">性能面板</h3>
        <div class="sh-sub">
          服务端进程的实时读数（5 秒刷新）。跑批量任务前后各看一眼，能回答「堆顶到多少」「请求有没有堆积」。
          <code>heapUsedMB</code> 贴近 <code>heapLimitMB</code> = OOM 前兆。
        </div>
        <template v-if="diag">
          <div class="kv-grid" data-diag-mem>
            <div class="kv"><span>堆 已用/上限</span><b class="mono">{{ diag.mem.heapUsedMB }} / {{ diag.mem.heapLimitMB }} MB</b></div>
            <div class="kv"><span>堆 峰值</span><b class="mono">{{ diag.mem.peakHeapUsedMB }} MB</b></div>
            <div class="kv"><span>进程内存 RSS</span><b class="mono">{{ diag.mem.rssMB }} MB</b></div>
            <div class="kv"><span>运行时长</span><b class="mono">{{ Math.floor(diag.mem.uptimeSec / 3600) }}h {{ Math.floor((diag.mem.uptimeSec % 3600) / 60) }}m</b></div>
          </div>
          <div class="kv-grid" data-diag-net>
            <div class="kv"><span>累计请求</span><b class="mono">{{ diag.net.requests }}</b></div>
            <div class="kv"><span>在飞 / 峰值</span><b class="mono">{{ diag.net.inFlight }} / {{ diag.net.peakInFlight }}</b></div>
            <div class="kv"><span>累计流量</span><b class="mono">{{ fmtBytes(diag.net.bytes) }}</b></div>
            <div class="kv"><span>响应被截断</span><b class="mono">{{ diag.net.truncated }}</b></div>
            <div class="kv"><span>连接超时 / DNS / 重置</span><b class="mono">{{ diag.net.errConnectTimeout }} / {{ diag.net.errDns }} / {{ diag.net.errReset }}</b></div>
            <div class="kv"><span>事件循环阻塞</span><b class="mono">{{ Object.values(diag.blocks).reduce((a, b) => a + b, 0) }} 次</b></div>
          </div>
          <div v-if="diag.traffic.warnings?.length" class="wd-msg warn" data-diag-warnings>
            ⚠ 流量护栏告警：{{ diag.traffic.warnings.join('；') }}
          </div>
          <details class="hint" data-diag-blocks-text>
            <summary>事件循环阻塞明细（哪类操作在同步卡主线程）</summary>
            <pre class="mono" style="white-space:pre-wrap">{{ diag.blocksText || '（无）' }}</pre>
          </details>
        </template>
        <div v-else class="hint" data-diag-empty>读不到 /api/diag —— 服务可能没启动。</div>

        <h3 style="margin-top: 24px">崩溃与大错留痕</h3>
        <div class="sh-sub">
          未捕获异常 / 未处理的 Promise 拒绝会记在这里（内存最近 20 条），
          同时追加写进服务端 <code>data/logs/crash-年-月.log</code>，重启也不丢。
        </div>
        <template v-if="errs">
          <div class="hint" data-err-files>
            日志文件（{{ errs.logDir }}）：
            <template v-if="errs.files.length">
              <span v-for="f in errs.files" :key="f.name" class="tag">{{ f.name }} · {{ f.sizeKB }}KB</span>
            </template>
            <template v-else>（还没有生成过）</template>
          </div>
          <table v-if="errs.recent.length" class="kv-table" data-err-recent>
            <thead><tr><th>时间</th><th>类型</th><th>消息</th></tr></thead>
            <tbody>
              <tr v-for="(e, i) in [...errs.recent].reverse()" :key="i">
                <td class="mono hint">{{ fmtIso(e.at) }}</td>
                <td><span class="tag">{{ e.kind }}</span></td>
                <td class="hint" style="word-break:break-all">{{ e.message }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="hint" data-err-empty>✓ 没有记录过未捕获异常。</div>
        </template>
        <div v-else class="hint" data-err-unreachable>读不到 /api/system/errors —— 服务可能没启动。</div>
      </template>

      <!-- 桌面端（`#209`）—— 浏览器下连导航项都没有，这里不会渲染 -->
      <template v-else-if="section === 'desktop'">
        <h3>桌面端</h3>
        <div class="sh-sub">
          Electron 外壳提供的系统能力：托盘 / 全局快捷键 / 文件关联 / 开机自启。
          这些能力浏览器做不到，所以浏览器访问时整个分区都不出现。
        </div>

        <div v-if="!desk" class="wd-msg warn" data-desk-loading>
          正在读取桌面端状态…（若一直停在这里，说明外壳没把状态交上来，可看 `server.log`）
        </div>

        <template v-else>
          <!-- 本地服务：端口 / 数据目录（改完确认后立即重启外壳） -->
          <div class="setting-row">
            <div class="setting-info">
              <b>本地服务端口</b>
              <span>
                当前生效：<code class="mono" data-desk-server-port-now>{{ desk.server?.port ?? '—' }}</code>
                <template v-if="desk.server?.envPort">（被环境变量 PORT={{ desk.server.envPort }} 覆盖）</template>
                <br />默认 3100，避免和 Web+server 的 3000 抢端口；改完确认后立即重启桌面端。
              </span>
            </div>
            <div class="setting-input" style="display: flex; gap: 8px; align-items: center">
              <input
                v-model.number="deskPortDraft" data-desk-server-port type="number" min="1024" max="65535"
                style="width: 110px" :disabled="!!desk.server?.envPort"
              />
              <button
                class="btn sm" data-desk-server-port-apply
                :disabled="!!desk.server?.envPort || deskBusy === 'server'" @click="applyServerPort"
              >
                {{ desk.server?.envPort ? '由环境变量控制' : (deskBusy === 'server' ? '重启中…' : '应用并重启') }}
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <b>数据目录</b>
              <span>
                当前生效：<code class="mono" data-desk-data-dir-now>{{ desk.server?.dataDir ?? '—' }}</code>
                <template v-if="desk.server?.envDataDir">（被环境变量 YUEDU_DATA_DIR 覆盖）</template>
                <br />切换只改目录，<b>不复制旧数据</b>；旧数据留在原处。
              </span>
            </div>
            <div class="setting-input" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
              <input
                v-model="deskDataDirDraft" data-desk-data-dir spellcheck="false"
                style="width: 250px" placeholder="留空 = 默认目录" :disabled="!!desk.server?.envDataDir"
              />
              <button class="btn sm" :disabled="!!desk.server?.envDataDir" @click="pickDeskDataDir">浏览…</button>
              <button
                class="btn sm" data-desk-data-dir-apply
                :disabled="!!desk.server?.envDataDir || deskBusy === 'server'" @click="applyDataDir"
              >
                {{ deskBusy === 'server' ? '重启中…' : '应用并重启' }}
              </button>
              <button class="btn sm" :disabled="!!desk.server?.envDataDir" @click="resetDataDir">恢复默认</button>
            </div>
          </div>

          <!-- 托盘 -->
          <div class="setting-row">
            <div class="setting-info">
              <b>系统托盘</b>
              <span v-if="desk.tray.ok">已就绪：双击托盘图标把窗口叫回来；右键是菜单（显示/隐藏、打开本地书、桌面端设置、退出）</span>
              <span v-else class="desk-bad">未就绪：{{ desk.tray.reason }}（此时代码**不会**拦截窗口关闭 —— 否则窗口收起来就找不回来了）</span>
            </div>
            <span class="tag" :class="desk.tray.ok ? 'green' : 'red'" data-desk-tray>{{ desk.tray.ok ? '就绪' : '不可用' }}</span>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <b>点「关闭」时收进托盘</b>
              <span>关掉窗口但程序继续跑（后台朗读/下载不中断）；从托盘菜单点「退出」才是真退出</span>
            </div>
            <div class="setting-input">
              <label class="rr-global">
                <input
                  type="checkbox" data-desk-close-tray :checked="desk.prefs.closeToTray"
                  @change="patchDesktop({ closeToTray: ($event.target as HTMLInputElement).checked })"
                />启用
              </label>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <b>点「最小化」时收进托盘</b>
              <span>默认**不开**：Windows 用户对「最小化」的预期就是进任务栏，改了会变成「最小化后找不到了」</span>
            </div>
            <div class="setting-input">
              <label class="rr-global">
                <input
                  type="checkbox" data-desk-min-tray :checked="desk.prefs.minimizeToTray"
                  @change="patchDesktop({ minimizeToTray: ($event.target as HTMLInputElement).checked })"
                />启用
              </label>
            </div>
          </div>

          <!-- 全局快捷键 -->
          <div class="setting-row">
            <div class="setting-info">
              <b>全局快捷键</b>
              <span v-if="desk.shortcut.enabled && desk.shortcut.ok && desk.shortcut.held">已生效：{{ desk.shortcut.accelerator }}（焦点在任意窗口时都能唤出/收起阅读）</span>
              <span v-else-if="desk.shortcut.enabled" class="desk-bad">未生效：{{ desk.shortcut.reason }}</span>
              <span v-else>已关闭</span>
            </div>
            <div class="setting-input" style="display: flex; gap: 8px; align-items: center">
              <input
                v-model="deskShortcutDraft" data-desk-shortcut spellcheck="false"
                style="width: 190px" placeholder="Control+Shift+Y"
              />
              <button class="btn sm" data-desk-shortcut-apply :disabled="deskBusy === 'shortcut'" @click="applyDesktopShortcut">
                {{ deskBusy === 'shortcut' ? '应用中…' : '应用' }}
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <b>启用全局快捷键</b>
              <span>关掉后不占用任何组合键（与别的软件冲突时先关这里）。写法和 Electron 一致：`Control+Shift+Y`、`CommandOrControl+Alt+K` 这类</span>
            </div>
            <div class="setting-input">
              <label class="rr-global">
                <input
                  type="checkbox" data-desk-shortcut-enabled :checked="desk.prefs.shortcutEnabled"
                  @change="patchDesktop({ shortcutEnabled: ($event.target as HTMLInputElement).checked })"
                />启用
              </label>
            </div>
          </div>

          <!-- 文件关联 -->
          <div class="setting-row">
            <div class="setting-info">
              <b>文件关联（双击 txt / epub 直接打开）</b>
              <span v-if="!desk.fileAssoc.supported" class="desk-bad">{{ desk.fileAssoc.reason }}</span>
              <span v-else>
                注册后本程序出现在「打开方式」列表里。<b>不会</b>抢走 .txt 的默认程序 ——
                想设为默认请到资源管理器右键某个 txt → 打开方式 → 始终使用此应用。
              </span>
            </div>
            <div class="setting-input" style="display: flex; gap: 8px; align-items: center">
              <span class="tag" :class="desk.fileAssoc.registered ? 'green' : ''" data-desk-assoc-state>
                {{ desk.fileAssoc.registered === true ? '已注册' : desk.fileAssoc.registered === false ? '未注册' : '不可用' }}
              </span>
              <button class="btn sm" data-desk-assoc-on :disabled="!desk.fileAssoc.supported || deskBusy === 'assoc'" @click="toggleFileAssoc(true)">注册</button>
              <button
                class="btn sm danger" data-desk-assoc-off
                :disabled="!desk.fileAssoc.supported || deskBusy === 'assoc' || desk.fileAssoc.registered !== true"
                @click="toggleFileAssoc(false)"
              >注销</button>
            </div>
          </div>

          <!-- 开机自启 -->
          <div class="setting-row">
            <div class="setting-info">
              <b>导入链接协议（yuedu:// / legado://）</b>
              <span v-if="!desk.protocolAssoc.supported" class="desk-bad">{{ desk.protocolAssoc.reason }}</span>
              <span v-else>
                注册后，在浏览器或分享页里点「一键导入」链接会唤起本程序并打开<b>导入预览</b>。
                不注册的话，系统不知道该唤起谁 —— 点了会没反应。
              </span>
            </div>
            <div class="setting-input" style="display: flex; gap: 8px; align-items: center">
              <span class="tag" :class="desk.protocolAssoc.registered ? 'green' : ''" data-desk-protocol-state>
                {{ desk.protocolAssoc.registered === true ? '已注册' : desk.protocolAssoc.registered === false ? '未注册' : '不可用' }}
              </span>
              <button class="btn sm" data-desk-protocol-on :disabled="!desk.protocolAssoc.supported || deskBusy === 'protocol'" @click="toggleProtocolAssoc(true)">注册</button>
              <button
                class="btn sm danger" data-desk-protocol-off
                :disabled="!desk.protocolAssoc.supported || deskBusy === 'protocol' || desk.protocolAssoc.registered !== true"
                @click="toggleProtocolAssoc(false)"
              >注销</button>
            </div>
          </div>

          <!-- 开机自启 -->
          <div class="setting-row">
            <div class="setting-info">
              <b>开机自启</b>
              <span v-if="!desk.autoLaunch.supported" class="desk-bad">{{ desk.autoLaunch.reason }}</span>
              <span v-else>登录 Windows 后自动打开阅读（便携版记录的是**原始 exe** 的路径；把 exe 挪走会让它失效，重新打开一次即可）</span>
            </div>
            <div class="setting-input">
              <label class="rr-global">
                <input
                  type="checkbox" data-desk-autolaunch :checked="desk.autoLaunch.openAtLogin"
                  :disabled="!desk.autoLaunch.supported || deskBusy === 'autolaunch'"
                  @change="toggleAutoLaunch(($event.target as HTMLInputElement).checked)"
                />启用
              </label>
            </div>
          </div>

          <!-- 快捷动作 -->
          <div class="setting-row">
            <div class="setting-info"><b>打开本地书籍</b><span>挑 txt / epub 直接导入并阅读（与双击打开走同一条路）</span></div>
            <div class="setting-input" style="display: flex; gap: 8px">
              <button class="btn sm" data-desk-open-local @click="pickAndOpenLocalBook()">📄 选择文件…</button>
              <button class="btn sm" data-desk-hide-window @click="toggleMainWindow(false)">收进托盘</button>
              <button class="btn sm" data-desk-show-window @click="toggleMainWindow(true)">显示窗口</button>
            </div>
          </div>

          <div v-if="deskMsg" class="wd-msg" :class="deskMsg.kind" data-desk-msg>{{ deskMsg.text }}</div>
          <div v-if="desk.prefsWarnings.length" class="wd-msg warn" data-desk-warnings>
            设置文件里有 {{ desk.prefsWarnings.length }} 处被忽略/回落：{{ desk.prefsWarnings.join('；') }}
          </div>

          <div class="hint" style="margin-top: 12px">
            程序路径 <code class="mono">{{ desk.paths.portableExe || desk.paths.exe }}</code><br />
            设置文件 <code class="mono">{{ desk.prefsFile }}</code><br />
            Electron {{ desk.versions.electron || '—' }} · Node {{ desk.versions.node }}
          </div>
        </template>
      </template>

      <!-- `#574` 站点定制批量管理 -->
      <template v-else-if="section === 'site'">
        <h3>站点定制</h3>
        <div class="sh-sub">
          按域名为网页添加 CSS / JS 与阅读模式。配置只存本机
          <code class="mono">data/site-customize.json</code>，不随书源导入导出；
          阅读器 / 内置浏览器标题栏里的「🎨 定制」与本列表操作的是同一份配置。
        </div>
        <div class="site-bar">
          <button class="btn sm" data-site-add @click="addSite()">＋ 新增站点</button>
          <button class="btn sm" :disabled="siteBusy" data-site-refresh @click="refreshSiteList()">↻ 刷新</button>
          <span class="hint">{{ siteBusy ? '读取中…' : `共 ${siteList.length} 条` }}</span>
          <span class="hint site-pref">启用开关是本机偏好（不写配置文件）</span>
          <span v-if="siteMsg" class="hint" data-site-msg>{{ siteMsg }}</span>
        </div>
        <div v-if="siteErr" class="wd-msg err site-err" data-site-err>
          <span>{{ siteErr }}</span>
          <button class="btn mini" data-site-retry @click="refreshSiteList()">重试</button>
        </div>
        <div v-else-if="siteBusy && !siteList.length" class="hint site-loading" data-site-loading>
          正在读取站点定制…
        </div>
        <div v-else-if="!siteList.length" class="hint" data-site-empty>
          还没有任何站点定制。点「＋ 新增站点」填域名与 CSS/JS；也可以在阅读器里打开网页后点「🎨 定制」。
        </div>
        <table v-else class="kv-table" data-site-table>
          <thead>
            <tr>
              <th>站点 / 域名</th>
              <th>源</th>
              <th style="width: 92px">启用</th>
              <th style="width: 132px">更新时间</th>
              <th>内容</th>
              <th style="width: 110px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in siteList" :key="c.host" :data-site-row="c.host" :class="{ 'site-off': !siteEnabled(c.host) }">
              <td class="mono">{{ c.host }}</td>
              <td class="site-src" data-site-source :title="siteSourcesOf(c)">{{ siteSourcesOf(c) }}</td>
              <td class="site-state">
                <div
                  class="switch" :class="{ on: siteEnabled(c.host) }"
                  :data-site-enabled="siteEnabled(c.host) ? '1' : '0'"
                  :title="siteEnabled(c.host) ? '点击停用（阅读器/内置浏览器不再注入）' : '点击启用'"
                  @click="toggleSite(c)"
                ></div>
                <span class="site-state-txt">{{ siteEnabled(c.host) ? '启用' : '停用' }}</span>
              </td>
              <td class="site-upd" data-site-updated>{{ formatSiteUpdatedAt(c.updatedAt) }}</td>
              <td class="site-sum" :title="siteCustomizeSummary(c)">{{ siteCustomizeSummary(c) }}</td>
              <td class="site-acts">
                <button class="btn mini" :data-site-edit="c.host" @click="editSite(c)">编辑</button>
                <button class="btn mini site-del" :data-site-del="c.host" @click="deleteSite(c)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <SiteCustomizeDialog
          v-if="siteEdit"
          :url="siteEdit.url"
          :current="siteEdit.current"
          :title="siteEdit.title"
          @close="siteEdit = null"
          @saved="onSiteSaved"
        />
      </template>

      <!-- 关于 -->
      <template v-else>
        <!-- 产品身份证：名称 / 版本 / 一句话定位 / 规模 -->
        <div class="about-head">
          <div class="about-logo">阅</div>
          <div class="about-id">
            <div class="about-name">
              阅读 YueDu
              <span class="about-ver" data-about-version>v{{ APP_VERSION }}</span>
            </div>
            <div class="about-slogan">插件式解析引擎聚合 · Legado 书源 / MacCMS（苹果CMS）影视 / RSS 订阅</div>
            <div class="about-meta">
              <span>{{ st.engines.length }} 个解析引擎</span>
              <i>·</i>
              <span>{{ st.sources.length }} 个已导入源</span>
              <i>·</i>
              <span>GPL-3.0-only</span>
            </div>
          </div>
        </div>

        <!-- 开发人员 -->
        <h4 class="about-h">开发人员</h4>
        <div class="about-rows">
          <div class="about-row">
            <span class="k">开发与维护</span>
            <span class="v">yuedu · 个人非商业项目</span>
          </div>
          <div class="about-row">
            <span class="k">AI 协作平台</span>
            <span class="v">
              <b>WorkBuddy</b>、<b>Trae</b> —— 需求拆解、代码实现、实测验收与文档维护由两个 Agent
              平台接力完成；界面上的每个功能都经过真实服务 / 真实源的实跑验证。
            </span>
          </div>
          <div class="about-row">
            <span class="k">技术栈</span>
            <span class="v">Vue 3 + Element Plus · Fastify + Node.js · Electron（桌面壳与浮窗）</span>
          </div>
        </div>

        <!-- 更新日志 -->
        <h4 class="about-h">更新日志</h4>
        <ul class="about-log" data-about-changelog>
          <li v-for="e in CHANGELOG" :key="e.date">
            <span class="date">{{ e.date }}</span>
            <span class="text">{{ e.text }}</span>
          </li>
        </ul>
        <div class="about-note">
          更早的记录见源码仓库 <code class="mono">docs/rounds/</code>（每轮一份，含实测结论与踩坑）。
        </div>

        <!-- 开源许可 -->
        <h4 class="about-h">开源许可</h4>
        <div class="lic-grid" data-about-licenses>
          <div v-for="l in LICENSES" :key="l.name" class="lic">
            <b>{{ l.name }}</b>
            <span>{{ l.license }}</span>
          </div>
        </div>
        <div class="about-note">
          本项目以 GPL-3.0-only 发布，许可证全文见仓库根
          <code class="mono">LICENSE</code>；以上依赖的许可证随各项目分发。
        </div>

        <!-- 免责声明 -->
        <h4 class="about-h">免责声明</h4>
        <ul class="about-disc">
          <li>
            本软件是纯本地的阅读 / 浏览辅助工具，<b>不内置、不提供、不分发任何书源、影视源、RSS 源规则</b>，
            发布包里的源列表为空。
          </li>
          <li>
            所有书刊、影视、订阅内容均来自用户自行导入的第三方源，版权归原作者与源站所有；
            本软件不存储、不上传、不代理这些内容。
          </li>
          <li>
            使用前请自行确认所在地区的法律法规与目标站点的服务条款；
            不得将本软件用于商业用途、侵权传播或任何违法用途。
          </li>
          <li>
            软件按「现状」提供，不对可用性、准确性作任何明示或暗示担保；
            因使用本软件产生的风险与后果由使用者自行承担。
          </li>
          <li>若权利人认为某些内容侵权，请直接联系相应源站处理。</li>
        </ul>
      </template>
    </div>
  </div>
</template>

<style scoped>
/**
 * `#793` 设置页布局：**左栏固定、右栏独立滚动**。
 *
 * 主区 `.omni-content` 自己会滚（`height: calc(100vh - 52px)` + `padding: 20px 24px`）
 * ⇒ 旧布局里左栏跟着整页滚走。这里把这页锁成「正好一屏高」的网格：
 * 高度 = `100vh - 52px(顶栏) - 40px(主区上下 padding)`；
 * 左栏 `align-self: start`（不拉伸、超出时自己滚），右栏 `min-height: 0 + overflow-y: auto`
 * ⇒ 滚右栏到底也不会带动左栏，整页本身不再产生第二条滚动条。
 */
.settings-layout {
  display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px;
  align-items: stretch; max-width: 980px;
  height: calc(100vh - 92px);
}
.settings-nav {
  padding: 8px; align-self: start; max-height: 100%;
  overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
}
.settings-nav-item {
  padding: 10px 14px; border-radius: 8px; cursor: pointer;
  font-size: 13px; color: var(--text-1); transition: all 0.15s;
}
.settings-nav-item:hover { background: var(--bg-3); }
.settings-nav-item.on { background: rgba(108, 124, 255, 0.15); color: #fff; }
/* `scrollbar-gutter: stable`：滚动条不遮内容（滚动条占位始终预留）。
   `min-height: 0` 是 grid 子项能真正收缩的前提，否则内容会把行撑高、右栏滚不动。 */
.settings-content {
  padding: 20px 22px; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
}
.settings-content h3 { font-size: 15px; margin: 0 0 6px; }
.sh-sub { font-size: 11.5px; color: var(--faint); margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.setting-row {
  display: flex; justify-content: space-between; align-items: center; gap: 20px;
  padding: 13px 0; border-bottom: 1px solid var(--border);
}
.setting-row:last-child { border-bottom: none; }
.setting-info b { font-size: 13px; display: block; }
.setting-info span { font-size: 11px; color: var(--muted); margin-top: 3px; display: block; }
.setting-input input, .setting-input select {
  width: 200px; background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 12px; color: var(--text); font-size: 12px; outline: none;
}
.setting-input input:focus, .setting-input select:focus { border-color: var(--acc-dim); }

/* ---- `#163` 界面主题 ---- */
.color-row { display: flex; gap: 10px; }
.color-item { display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 10px; color: var(--muted); }
.color-item input[type="color"] {
  width: 40px; height: 26px; padding: 0; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-3); cursor: pointer;
}
.duo { display: flex; gap: 8px; align-items: center; }
/* 上游联动：关掉「显示书名」时「显示作者」禁用（CoverConfigFragment.kt:52-55） */
.duo .switch.off { opacity: 0.35; cursor: not-allowed; }
.mono { font-family: var(--mono); font-size: 12px; color: var(--cy); }
/* ── 关于：产品身份证 / 开发人员 / 更新日志 / 开源许可 / 免责声明 ──
 * 全部走主题令牌（--bg-2 / --border / --brand-soft / --muted），换界面主题时自动跟随。 */
.about-head {
  display: flex; align-items: center; gap: 16px;
  padding: 18px 20px; margin-bottom: 22px;
  background: linear-gradient(120deg, var(--brand-soft), transparent 70%), var(--bg-2);
  border: 1px solid var(--border); border-radius: 12px;
}
.about-logo {
  width: 54px; height: 54px; border-radius: 15px; flex-shrink: 0;
  background: linear-gradient(135deg, var(--brand), var(--accent));
  display: flex; align-items: center; justify-content: center;
  font-size: 25px; font-weight: 800; color: #fff;
  box-shadow: 0 6px 16px rgba(79, 140, 255, 0.28);
}
.about-id { min-width: 0; }
.about-name { font-size: 18px; font-weight: 800; color: var(--text-0); display: flex; align-items: center; gap: 8px; }
.about-ver {
  font-family: var(--mono); font-size: 11px; font-weight: 600;
  padding: 1px 8px; border-radius: 999px;
  color: var(--brand); background: var(--brand-soft); border: 1px solid var(--acc-dim);
}
.about-slogan { font-size: 12px; color: var(--muted); margin-top: 6px; }
.about-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: var(--faint); }
.about-meta i { font-style: normal; opacity: 0.6; }

.about-h {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 700; color: var(--text-0);
  margin: 22px 0 10px;
}
.about-h::before { content: ''; width: 3px; height: 13px; border-radius: 2px; background: var(--brand); }

.about-rows { display: flex; flex-direction: column; gap: 1px; background: var(--border); border-radius: 10px; overflow: hidden; }
.about-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 14px; padding: 11px 14px; background: var(--bg-2); font-size: 12.5px; }
.about-row .k { color: var(--muted); }
.about-row .v { color: var(--text-1); line-height: 1.65; }
.about-row .v b { color: var(--text-0); }

.about-log { list-style: none; margin: 0; padding: 0; }
.about-log li {
  display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 14px;
  padding: 8px 0; border-bottom: 1px dashed var(--border);
  font-size: 12.5px; color: var(--text-1); line-height: 1.6;
}
.about-log li:last-child { border-bottom: none; }
.about-log .date { font-family: var(--mono); font-size: 11px; color: var(--faint); padding-top: 1px; }

.about-note { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.6; }

.lic-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
.lic {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); font-size: 12px;
}
.lic b { font-weight: 600; color: var(--text-0); }
.lic span { font-family: var(--mono); font-size: 10.5px; color: var(--muted); white-space: nowrap; }

.about-disc { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-1); line-height: 1.75; }
.about-disc li { margin-bottom: 6px; }
.about-disc li:last-child { margin-bottom: 0; }
.about-disc b { color: var(--text-0); }

@media (max-width: 900px) {
  .about-row { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .about-log li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
/* 窄窗口：左栏改成横排的分区条（仍然固定），右栏继续独立滚。
   `grid-template-rows: auto minmax(0, 1fr)` 保证右栏拿到剩余高度且能滚。 */
@media (max-width: 900px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    height: calc(100vh - 92px);
  }
  .settings-nav {
    display: flex; align-items: center; gap: 6px; max-height: none;
    overflow-x: auto; overflow-y: hidden;
  }
  .settings-nav-item { flex: 0 0 auto; white-space: nowrap; }
}

/* `#793` 默认封面自定义：预览 + 三个动作 */
.cover-mgr { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex-shrink: 0; }
.cover-preview {
  width: 96px; height: 144px; border-radius: 8px; overflow: hidden; flex-shrink: 0;
  border: 1px solid var(--border); background: var(--bg-3);
}
.cover-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 220px; }
.cover-state-on { color: var(--green, #22c55e); }

/* ── #272 主题导入对话框 ─────────────────────────────── */
/* ★ chip 的「选中态」此前没有样式 ⇒ 点「重复→跳过/覆盖」看起来没反应（用户原话「点击无变化」）。
   全局只有静态展示的 chip 样式；这里是可点的开关 chip，必须有自己的 on 态。 */
.mask { position: fixed; inset: 0; z-index: 1300; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px; overflow: auto; }
.chip { padding: 3px 10px; font-size: 12px; border-radius: 999px; background: var(--bg-3); border: 1px solid var(--border); color: var(--muted); cursor: pointer; }
.chip:hover { color: var(--text-0); }
.chip.on { background: rgba(108, 124, 255, 0.16); border-color: var(--brand, #6366f1); color: var(--text-0); box-shadow: 0 0 0 1px var(--brand, #6366f1) inset; }
.green { color: var(--green, #22c55e); }

/* ── #271 主题下拉（自定义：每项带 ✕；当前/内置不可删） ── */
/* `#284` 主题下拉按钮：名字居左、▾ 贴右（与筛选组件对齐） */
.theme-dd-btn { min-width: 200px; display: flex; align-items: center; gap: 6px; text-align: left; }
.theme-dd-cur { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.theme-dd-caret { font-size: 10px; opacity: 0.75; flex-shrink: 0; }
.theme-dd-list {
  position: absolute; top: calc(100% + 4px); left: 0; min-width: 240px; max-height: 260px; overflow: auto; z-index: 40;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: var(--shadow); padding: 4px;
}
.theme-dd-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 12.5px; color: var(--text-1); }
.theme-dd-item:hover { background: var(--bg-3); }
.theme-dd-item.on { background: rgba(108, 124, 255, 0.16); color: #fff; }
.theme-dd-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.theme-dd-del { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 4px; }
.theme-dd-del:hover { color: var(--red, #ef4444); background: rgba(239, 68, 68, 0.12); }
.theme-dd-lock { opacity: 0.45; font-size: 11px; cursor: not-allowed; }

/* ── `#208` ⑤ WebDAV 同步 + 源分享（设置页两个新分区） ──────────────
 * 与既有 `.setting-row` 的区别：那两个分区是**表单网格**（标签 + 控件）而不是
 * 「一行一件事」，所以不复用 `.setting-row`（复用它会让标签被挤成 200px 宽的一列）。 */
.hint { font-size: 11.5px; color: var(--muted); line-height: 1.7; }
/* `#209` 桌面端分区：把「未生效/不可用」的原因染成告警色（这些原因必须看得见，不能只落日志） */
.desk-bad { color: var(--orange); }
.hint code, .sh-sub code {
  font-family: var(--mono); font-size: 11px;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px;
}
/* `#574` 站点定制批量管理 */
.site-bar { display: flex; gap: 8px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
.site-acts { white-space: nowrap; }
.site-del { color: var(--red); }
.site-del:hover { border-color: var(--red); }
/* `#635` 列表新增列 / 三态 */
.site-pref { margin-left: auto; }
.site-err { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px; }
.site-loading { padding: 18px 0; text-align: center; }
.site-src, .site-sum {
  max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; color: var(--muted);
}
.site-state { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.site-state-txt { font-size: 11px; color: var(--muted); }
.site-upd { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.site-off > .mono, .site-off > .site-src, .site-off > .site-sum { opacity: 0.55; }
.wd-grid {
  display: grid; grid-template-columns: 76px 1fr; gap: 8px 12px;
  align-items: center; margin: 10px 0 12px;
}
.wd-lab { font-size: 12px; color: var(--muted); }
.wd-grid input, .wd-grid select {
  width: 100%; max-width: 460px; background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 8px; padding: 7px 12px; color: var(--text); font-size: 12px; outline: none;
}
.wd-grid input:focus, .wd-grid select:focus { border-color: var(--acc-dim); }
.wd-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
.wd-msg { font-size: 12px; line-height: 1.7; border-radius: 8px; padding: 8px 10px; border: 1px solid var(--border); }
.wd-msg.ok { color: var(--green); border-color: rgba(34, 197, 94, 0.35); background: rgba(34, 197, 94, 0.08); }
.wd-msg.warn { color: var(--orange); border-color: rgba(249, 115, 22, 0.35); background: rgba(249, 115, 22, 0.08); }
.wd-msg.err { color: var(--red); border-color: rgba(255, 84, 112, 0.35); background: rgba(255, 84, 112, 0.08); }
.wd-report { margin-top: 10px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-0); }
.wd-report-head { font-size: 12.5px; margin-bottom: 8px; }
.wd-stats { display: flex; gap: 8px; flex-wrap: wrap; }
.wd-stat { flex: 1; min-width: 108px; text-align: center; font-size: 11.5px; color: var(--muted); padding: 6px 4px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--border); }
.wd-stat b { display: block; font-size: 15px; color: var(--text); margin-top: 2px; }
.wd-errs { margin-top: 8px; font-size: 11.5px; line-height: 1.7; color: var(--orange); max-height: 120px; overflow: auto; }
.bk-list { margin-top: 8px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.bk-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--border); }
.bk-item:last-child { border-bottom: none; }
.bk-info b { font-size: 12.5px; display: block; }
.bk-info span { font-size: 11px; color: var(--muted); }
/* `#621` 备份内容勾选 */
.bk-opts { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 10px 0 4px; background: var(--bg-0); }
/* `B7` ③④ 备份轮转 / 恢复方式 */
.bk-rotate, .bk-restore-mode { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 9px 0 2px; }
.bk-rotate-lab { font-size: 12px; color: var(--muted); }
.bk-rotate .hint, .bk-restore-mode .hint { font-size: 11px; color: var(--muted); }
.bk-opts-head { font-size: 12px; color: var(--muted); margin-bottom: 8px; letter-spacing: .02em; }
.bk-opt { display: flex; align-items: baseline; gap: 8px; padding: 3px 0; font-size: 12px; cursor: pointer; }
.bk-opt input { margin: 0; flex-shrink: 0; position: relative; top: 1px; }
.bk-opt-label { color: var(--text-1); flex-shrink: 0; min-width: 88px; }
.bk-opt-desc { color: var(--muted); font-size: 11px; line-height: 1.5; }
.bk-opt.sens .bk-opt-label { color: var(--orange); }
.bk-opts-foot { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 5px; }
.bk-pwd { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.bk-pwd input { flex: 0 1 240px; font-size: 12px; }
.bk-opts-foot .hint { font-size: 11px; color: var(--muted); line-height: 1.6; }
.bk-mode { display: flex; flex-wrap: wrap; gap: 10px 22px; margin: 10px 0 2px; font-size: 12.5px; }
.fb-preview { margin: 8px 0 2px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-0); font-size: 12px; }
.fb-preview b { color: var(--text-1); }
.fb-preview ul { margin: 6px 0 0; padding-left: 18px; color: var(--muted); line-height: 1.7; }
.hint.fb-ok { color: var(--green, #3a9d5d); }
.hint.fb-warn { color: var(--orange); }
.hint.fb-err { color: var(--red, #d9534f); }
.bk-unsup { margin-top: 8px; font-size: 11.5px; color: var(--muted); }
.bk-unsup summary { cursor: pointer; }
.bk-unsup-row { display: flex; gap: 8px; padding: 2px 0; font-size: 11px; line-height: 1.5; }
.bk-unsup-row b { color: var(--text-1); flex-shrink: 0; min-width: 96px; }
.dl-cur { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-0); margin-bottom: 8px; }
.dl-cur-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; margin-bottom: 6px; }
.kv { display: flex; gap: 8px; padding: 3px 0; font-size: 11.5px; }
.kv span { color: var(--muted); min-width: 62px; flex-shrink: 0; }
.kv b { color: var(--text-1); font-weight: 500; word-break: break-all; }
.dl-test-ok { margin-top: 8px; font-size: 12px; color: var(--green); background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.35); border-radius: 8px; padding: 8px 10px; word-break: break-all; }
.ta {
  width: 100%; font-family: var(--mono); font-size: 12px; margin-top: 4px;
  background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px; outline: none; resize: vertical;
}
.ta:focus { border-color: var(--acc-dim); }

/* ── `#210` 运维分区 ── */
.kv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 2px 18px; margin: 8px 0; }
.kv-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 10px 0 4px; }
.kv-table th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.kv-table td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.tag {
  display: inline-block; padding: 1px 8px; font-size: 11px; border-radius: 999px;
  background: var(--bg-3); border: 1px solid var(--border); color: var(--muted); margin-right: 4px;
}
.tag.green { color: var(--green, #22c55e); border-color: rgba(34, 197, 94, 0.4); }
.ops-input {
  width: 90px; background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; outline: none;
}
.ops-input:focus { border-color: var(--acc-dim); }
</style>

