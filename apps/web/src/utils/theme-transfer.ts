/**
 * `#206` **主题导入 / 导出**（多套界面主题）。
 *
 * ## 上游依据（照抄，不自创格式）
 * `F:\legado\app\src\main\java\io\legado\app\help\config\ThemeConfig.kt`：
 * · `addConfig(json: String)`（`:160-172`）—— 先 GSON 解析成单个 `Config`，
 *   再 `validateConfig()`，通过才 `addConfig(it)`；
 * · `addConfigs(newConfigs: List<Config>?)`（`:189-205`）—— **批量**导入，
 *   先 `filter { validateConfig(it) }` 滤掉不合法的，再**按 `themeName` 找旧项替换**、没有就追加；
 * · `validateConfig(config)`（`:207-217`）—— ★ **只校验 4 个颜色能不能 `toColorInt()`**：
 *   `primaryColor` / `accentColor` / `backgroundColor` / `bottomBackground`；
 * · 存储是 `themeConfig.json`（一个**数组**），备份里以 `themeConfig` 键整体进出
 *   （`BackupConfig.kt:24,76`；`ConfigTag.kt:6` `THEME_CONFIG`）。
 * ⇒ 所以本仓的导出单元 = **命名主题数组**（`uiThemes`），不是「当前槽」。
 *
 * ## 为什么导出文件要带 `kind` / `v`
 * 用户数据备份（`yuedu-userdata-*.json`）已经是本仓的另一个 JSON 导出，
 * 两者顶层都是对象 ⇒ 用户很容易把主题文件丢进「导入备份」那个框。
 * 带上 `kind: 'yuedu-themes'` 就能在解析阶段**明确拒绝并说清原因**，
 * 而不是「解析成功但什么也没变」——那种静默失败最难查。
 *
 * ## 壁纸（`backgroundImgPath`）的两种形态
 * · `data:image/...`（本机图片转的）—— 能导出，但**体积大**（本机上限 400KB ⇒ base64 约 530KB/张）；
 * · 本机绝对路径（`C:\...\wall.jpg`）—— **导出给别人毫无意义**（对方机器上没有这个文件），
 *   但**自己备份再用是有用的**。⇒ 两种都原样导出，但**解析时区分对待**：
 *   指向不存在本机文件的绝对路径 → 清成 `null` 并在结果里如实报告（不留一个坏路径让界面变白）。
 */
import type { UiThemeConfig } from '@yuedu/core/contract';
import { emptyUiThemeConfig } from '@yuedu/core/contract';

/** 导出文件的顶层形状（`v` 便于将来结构演进换版本号） */
export interface ThemeBundle {
  kind: 'yuedu-themes';
  v: 1;
  /** 导出时间（毫秒）。纯信息，不参与校验 */
  exportedAt: number;
  /** 命名主题数组（与上游 `configList` 同形） */
  themes: UiThemeConfig[];
}

/** 顶层 `kind` 的常量 —— 别散落成字面量 */
export const THEME_BUNDLE_KIND = 'yuedu-themes';

/** 上游 `validateConfig` 校验的那 4 个颜色键（`ThemeConfig.kt:210-213`） */
const REQUIRED_COLORS = ['primaryColor', 'accentColor', 'backgroundColor', 'bottomBackground'] as const;

/** 一次最多导入多少套（防一个畸形文件塞爆偏好；上游无上限，但 Web 有 localStorage/服务端 body 限制） */
export const MAX_IMPORT_THEMES = 50;

/** 主题名长度上限（会出现在下拉里，太长排版坏） */
const MAX_NAME_LEN = 40;

/** 导出文件名（与设置页既有的 `yuedu-userdata-*.json` 同一套命名风格） */
export function themeBundleFileName(now = new Date()): string {
  return `yuedu-themes-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * 颜色是否合法 —— 与上游 `validateConfig` 同一口径：**能当颜色解析**即可。
 * 不用 `parseHex`（它对非法值给 fallback，会把脏数据「洗成」一个看起来正常的颜色）。
 * 接受 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()/rgba()`（浏览器 `<input type=color>` 给前两者，
 * 但用户可能从别处粘贴 `rgb()`；CSS 颜色串一律放行交给浏览器，跟上游 `toColorInt` 的宽松度一致）。
 */
function isColorLike(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return true;
  if (/^(rgb|hsl)a?\(\s*[0-9.%\s,/.-]+\)$/i.test(s)) return true;
  // 具名颜色：只认一小撮常见的（CSS 全量表太大，不值得为校验搬进来）
  return ['transparent', 'black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'yellow']
    .includes(s.toLowerCase());
}

/** 是不是 data URL（能安全跨机携带的图片） */
function isDataImage(v: unknown): boolean {
  return typeof v === 'string' && /^data:image\//i.test(v.trim());
}

/** 是不是本机绝对路径（Windows `C:\` 或 POSIX `/`） */
function isLocalPath(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return /^[a-z]:[\\/]/i.test(s) || s.startsWith('/') || s.startsWith('\\\\');
}

/**
 * 校验并规范化一条主题。
 * @returns 规范化后的主题，或 `null`（不合格）。
 *
 * ★ 与上游一致：**不合格的整条丢弃**，不「尽力修复」——
 *   上游 `addConfigs` 就是 `filter { validateConfig(it) }`。若在这里给脏色补默认值，
 *   用户导进来一个坏主题却看到「导入成功 + 一套我没配过的颜色」，那比失败更难查。
 */
export function normalizeImportedTheme(raw: unknown): UiThemeConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // 上游 validateConfig：4 个颜色必须都能解析，缺一即废
  for (const k of REQUIRED_COLORS) {
    if (!isColorLike(r[k])) return null;
  }
  const name = typeof r['themeName'] === 'string' ? r['themeName'].trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return null; // 没有名字的条目无法被 `applyUiTheme` 定位，等于没有

  const base = emptyUiThemeConfig(name);
  const bgPath = r['backgroundImgPath'];
  return {
    themeName: name,
    // 上游 `isNightTheme` 是**开关**（会回写 themeMode）。导入时按它分槽由调用方处理，
    // 这里只做类型收窄。
    isNightTheme: r['isNightTheme'] === true,
    primaryColor: String(r['primaryColor']).trim(),
    accentColor: String(r['accentColor']).trim(),
    backgroundColor: String(r['backgroundColor']).trim(),
    bottomBackground: String(r['bottomBackground']).trim(),
    transparentNavBar: r['transparentNavBar'] === true,
    // ★ 壁纸：只接受 http(s) 或 data:image；**本机绝对路径在这里清掉**
    //   （导给别人的文件里带 `C:\Users\x\wall.jpg` 是无意义且有害的）。
    //   但「自己备份再导入」（同一台机）也走这条路 —— 那时清掉会丢背景。
    //   ⇒ 折中：data:image 与 http(s) 保留；绝对路径**保留但标记**，
    //   由调用方（`importThemeBundle`）检查文件是否存在，不存在才清。
    backgroundImgPath: typeof bgPath === 'string' && bgPath.trim() ? bgPath.trim() : null,
    backgroundImgBlur: Number.isFinite(Number(r['backgroundImgBlur'])) ? Number(r['backgroundImgBlur']) : base.backgroundImgBlur,
  };
}

/** 导入结果（要如实告诉用户发生了什么，不静默） */
export interface ThemeImportResult {
  ok: boolean;
  /** 通过校验并已并入的条数 */
  imported: number;
  /** 被丢弃的条目及原因（逐条，用户能定位是哪个文件哪一条坏了） */
  rejected: { index: number; reason: string }[];
  /** 因本机文件不存在而被清掉壁纸的条目（主题本身仍导入成功） */
  wallpaperDropped: string[];
  /** 致命错误（文件不是主题包 / JSON 坏了 / 顶层形状不对） */
  error?: string;
}

/** 解析一个用户读到的文本 → 主题包。**不**碰文件系统。 */
export function parseThemeBundle(text: string): { bundle?: ThemeBundle; result: ThemeImportResult } {
  const bad = (error: string): { result: ThemeImportResult } => ({
    result: { ok: false, imported: 0, rejected: [], wallpaperDropped: [], error },
  });
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return bad('不是合法的 JSON：' + (e instanceof Error ? e.message : String(e)));
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    return bad('顶层应是 JSON 对象（导出的是 { kind, v, themes }）');
  }
  const o = j as Record<string, unknown>;
  /**
   * ★ 明确区分「这是备份文件」和「这是主题文件」——两者顶层都是对象，
   *   不区分的话用户会看到「导入成功但什么也没变」，是最难查的一类静默失败。
   *
   * 判据要覆盖**两种**备份形态（第一版只写了第二种，被单测抓到）：
   *  ① 顶层**带** `kind` 且值是别的（`{kind:'yuedu-userdata', …}`）；
   *  ② 顶层**不带** `kind`，但有备份的特征键（实测 `getSnapshot()` 的返回就是
   *     `{books, prefs, …}`，**没有** kind —— 见 `user-data.ts:427`）。
   */
  if (o['kind'] !== THEME_BUNDLE_KIND) {
    const looksLikeBackup =
      'books' in o || 'prefs' in o || 'bookGroups' in o || 'readRecords' in o || 'bookmarks' in o;
    if (o['kind'] !== undefined || looksLikeBackup) {
      return bad('这看起来是**用户数据备份**文件（不是主题包）—— 备份导入请用设置页那个入口');
    }
    return bad(`kind 字段应为 "${THEME_BUNDLE_KIND}"，实际是 ${JSON.stringify(o['kind'])}`);
  }
  if (!Array.isArray(o['themes'])) return bad('themes 字段应是数组');
  return {
    bundle: {
      kind: THEME_BUNDLE_KIND,
      v: 1,
      exportedAt: Number(o['exportedAt']) || 0,
      themes: o['themes'] as UiThemeConfig[],
    },
    result: { ok: true, imported: 0, rejected: [], wallpaperDropped: [] },
  };
}

/**
 * 把导出对象拍平成文件文本。
 * `themes` 为空数组也照样导出（导出「一个主题都没有」是合法状态，不该拦）。
 */
export function serializeThemeBundle(themes: readonly UiThemeConfig[], now = new Date()): string {
  const bundle: ThemeBundle = {
    kind: THEME_BUNDLE_KIND,
    v: 1,
    exportedAt: now.getTime(),
    themes: themes.map((t) => ({ ...emptyUiThemeConfig(t.themeName), ...t })),
  };
  return JSON.stringify(bundle, null, 2);
}

/**
 * 校验一遍（供 UI 在**导入前**先给用户看「这份文件里有几套、哪几条会被丢弃」），
 * 真正的并入由调用方用 {@link normalizeImportedTheme} 的结果做。
 */
export function inspectThemeBundle(text: string): {
  valid: UiThemeConfig[];
  rejected: { index: number; reason: string }[];
  error?: string;
} {
  const { bundle, result } = parseThemeBundle(text);
  if (!bundle) return { valid: [], rejected: [], error: result.error };
  const valid: UiThemeConfig[] = [];
  const rejected: { index: number; reason: string }[] = [];
  bundle.themes.slice(0, MAX_IMPORT_THEMES).forEach((t, i) => {
    const n = normalizeImportedTheme(t);
    if (n) valid.push(n);
    else rejected.push({ index: i, reason: describeReject(t) });
  });
  if (bundle.themes.length > MAX_IMPORT_THEMES) {
    rejected.push({ index: MAX_IMPORT_THEMES, reason: `超过上限 ${MAX_IMPORT_THEMES} 套，多余的已忽略` });
  }
  return { valid, rejected };
}

/** 说清一条为什么被拒（用户要能自己修，而不是只看到「1 条失败」） */
function describeReject(t: unknown): string {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return '不是对象';
  const r = t as Record<string, unknown>;
  const badColors = REQUIRED_COLORS.filter((k) => !isColorLike(r[k]));
  if (badColors.length) {
    const shown = badColors.map((k) => `${k}=${JSON.stringify(r[k])}`).join(' ');
    return `颜色不合法：${shown}`;
  }
  if (typeof r['themeName'] !== 'string' || !r['themeName'].trim()) return '缺 themeName';
  return '字段不完整';
}

/**
 * `#272`（用户 2026-10-04 晚）：**宽容**的导入解析 —— 在 `inspectThemeBundle`（只认
 * `kind: "yuedu-themes"` 包裹）之上，额外接受**裸**的单主题对象 / 多主题数组
 * （用户从别处抄来的主题数据往往没有导出器的外壳 ⇒ 不能因为缺 `kind` 就「导入失败」）。
 *
 * ⚠️ 两条保守线**保留**：
 * ① 顶层像**用户数据备份**（`books`/`prefs`/`bookGroups`… 特征键，或带别的 `kind`）
 *    ⇒ 仍然明确报错（最难查的一类静默失败，见 parseThemeBundle 的注释）；
 * ② 裸形态同样走 `normalizeImportedTheme` 逐条校验（4 个颜色 + themeName），
 *    rejected 的序号对齐原始输入，逐条能定位。
 */
export function parseThemeInput(text: string): {
  valid: UiThemeConfig[];
  rejected: { index: number; reason: string }[];
  error?: string;
} {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { valid: [], rejected: [], error: '不是合法的 JSON：' + (e instanceof Error ? e.message : String(e)) };
  }
  // ① 带 kind ⇒ 主题包外壳，走原路径（内含「备份文件」的区分提示）
  if (j && typeof j === 'object' && !Array.isArray(j) && (j as Record<string, unknown>)['kind'] !== undefined) {
    return inspectThemeBundle(text);
  }
  const list: unknown[] = Array.isArray(j) ? j : [];
  // ② 裸对象：备份文件要拦；有 themeName ⇒ 单主题；否则报「不是主题数据」
  if (!Array.isArray(j) && j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    const looksLikeBackup =
      'books' in o || 'prefs' in o || 'bookGroups' in o || 'readRecords' in o || 'bookmarks' in o;
    if (looksLikeBackup) {
      return { valid: [], rejected: [], error: '这看起来是**用户数据备份**文件（不是主题数据）—— 备份导入请用设置页那个入口' };
    }
    if (o['themeName'] === undefined) {
      return { valid: [], rejected: [], error: '不是主题数据 —— 应为单个主题对象、主题数组，或 kind 为 "yuedu-themes" 的主题包' };
    }
    list.push(j);
  }
  const valid: UiThemeConfig[] = [];
  const rejected: { index: number; reason: string }[] = [];
  list.slice(0, MAX_IMPORT_THEMES).forEach((raw, i) => {
    const n = normalizeImportedTheme(raw);
    if (n) valid.push(n);
    else rejected.push({ index: i, reason: describeReject(raw) });
  });
  if (list.length > MAX_IMPORT_THEMES) {
    rejected.push({ index: MAX_IMPORT_THEMES, reason: `超过上限 ${MAX_IMPORT_THEMES} 套，多余的已忽略` });
  }
  if (!valid.length && !rejected.length) {
    return { valid: [], rejected: [], error: '没有解析出任何主题' };
  }
  return { valid, rejected };
}

/** 壁纸检查结果（供调用方在**自己机器上**决定清不清） */
export interface WallpaperProbe {
  /** 主题名 → 该不该清掉它的壁纸 */
  drop: Set<string>;
  /** 保留 data:image / http(s) 的主题名 */
  keep: string[];
}

/**
 * 检查每个主题的 `backgroundImgPath` 在**本机**是否可用。
 *
 * 为什么要这一步：`normalizeImportedTheme` 无法分辨「导出文件里带的是别人的本机路径」
 * 与「我自己备份自己再用」。⇒ 运行时判：绝对路径且文件不存在 ⇒ 清掉（并在结果里报告）。
 * http(s) 与 data:image 一律保留（前者要网络才能验，不在这里做网络请求）。
 */
export function probeWallpapers(themes: readonly UiThemeConfig[], exists: (absPath: string) => boolean): WallpaperProbe {
  const drop = new Set<string>();
  const keep: string[] = [];
  for (const t of themes) {
    const p = t.backgroundImgPath;
    if (!p) { keep.push(t.themeName); continue; }
    if (isDataImage(p) || /^https?:/i.test(p)) { keep.push(t.themeName); continue; }
    if (isLocalPath(p) && !exists(p)) { drop.add(t.themeName); continue; }
    keep.push(t.themeName);
  }
  return { drop, keep };
}

/**
 * 并入已有列表：**按 `themeName` 替换旧的，没有则追加**（照抄上游 `addConfigs`，`ThemeConfig.kt:189-205`）。
 *
 * @param exists 本机文件存在性判定（注入以便测试；生产传 `fs.existsSync` 的等价物）
 * @param mode    `merge` = 同名覆盖（上游行为）；`keepExisting` = 已存在则跳过（保守导入）
 */
export function mergeThemeList(
  current: readonly UiThemeConfig[],
  incoming: readonly UiThemeConfig[],
  exists: (absPath: string) => boolean,
  mode: 'merge' | 'keepExisting' = 'merge',
): { list: UiThemeConfig[]; replaced: string[]; added: string[]; wallpaperDropped: string[] } {
  const list = current.slice();
  const replaced: string[] = [];
  const added: string[] = [];
  const wallpaperDropped: string[] = [];
  for (const t of incoming) {
    const { drop } = probeWallpapers([t], exists);
    const fixed: UiThemeConfig = drop.has(t.themeName) ? { ...t, backgroundImgPath: null } : { ...t };
    if (drop.has(t.themeName)) wallpaperDropped.push(t.themeName);

    const i = list.findIndex((x) => x.themeName === fixed.themeName);
    if (i >= 0) {
      if (mode === 'keepExisting') continue;
      list[i] = fixed;
      replaced.push(fixed.themeName);
    } else {
      list.push(fixed);
      added.push(fixed.themeName);
    }
  }
  return { list, replaced, added, wallpaperDropped };
}
