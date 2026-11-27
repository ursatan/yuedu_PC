/**
 * 界面主题（`#163`）—— 把一套 {@link UiThemeConfig} 换算成 **全局 CSS 自定义属性**。
 *
 * ## 这是哪个「主题」（用户 2026-09-30 纠正过的概念模型，别再混）
 * · **主题模式** = `GlobalReaderPrefs.themeMode`（跟随系统/亮/暗/墨水屏）—— 决定**用哪个槽的颜色**；
 * · **主题** = 本文件消费的 `UiThemeConfig`（界面用：色调 + 壁纸），即上游 `ThemeConfig.Config`；
 * · **阅读样式** = `GlobalReaderPrefs.textSize` 那组（**正文**的），见 `styles/reader-theme.ts`（`#164` 另做）。
 *
 * ## 字段 / 默认值的出处（**已逐行核实**）
 * `ThemeConfig.Config` 主构造器 `ThemeConfig.kt:492-502`（9 字段）+ `assets/defaultData/themeConfig.json`。
 * 逐条依据写在契约 `packages/core/src/contract/user-data.ts` 的 `UiThemeConfig` 注释里，这里不重复。
 *
 * ## 本文件**只做三件事**
 * 1. **换算**：一套主题 → CSS 变量（派生规则见 {@link uiThemeVars} 的逐条注释）；
 * 2. **判槽**：`themeMode` + 系统偏好 → 用日槽还是夜槽（照抄 `AppConfig.kt:172-178`）；
 * 3. **封面文字**：照抄 `normalizeCoverText`（`CoverImageView.kt:52-55`）。
 *
 * ## 颜色派生的诚实声明（⚠️ 不是「上游移植」）
 * 上游只给 **4 个颜色**，而本仓的暗色界面用了 **`--bg-0..3` 四层** —— 中间两层（卡片 / 控件底）上游**没有对应概念**。
 * 处理：`--bg-1` ← `bottomBackground`（语义就是「侧栏/底栏底色」，最接近），
 * `--bg-2` / `--bg-3` 由 `backgroundColor` **按通道线性加深/变浅**派生。
 * ⚠️ 「深色（本仓）」这套预设是按 `styles/theme.css` 原来的字面值配的，派生出来的
 * `--bg-2`/`--bg-3` 与原字面值有 **≤ 7/255 的通道偏差**（肉眼不可辨，已截图核对）。
 * 若日后要**逐字节**复现某套配色，正确做法是给 `UiThemeConfig` 加本仓扩展字段（用户已授权），
 * 而不是在这里调派生系数 —— 调系数会让其它主题跟着变。
 */
import type { UiCoverConfig, UiThemeConfig } from '@yuedu/core/contract';
import { EINK_UI_THEME } from '@yuedu/core/contract';
import { coverLayerOf } from '../utils/default-cover-core';

/* ------------------------------------------------------------------ *
 * 颜色工具（全部纯函数，`#` 开头的 hex 输入）
 * ------------------------------------------------------------------ */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0~1。6 位 hex = 1 */
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3,8})$/i;

/**
 * 解析 hex 颜色。
 *
 * ⚠️ **上游有一个真实的坑**：`ThemeConfig.applyConfig()` 把颜色存成
 * `"#${Color.hexString}"` —— Android 的 `hexString` 是 **ARGB 8 位**（alpha 在前），
 * 所以从**保存过的**主题读回来会出现 `#ffc0edc6`（`readConfig.json` 里就有）。
 * 规则：**8 位一律当 ARGB 处理**（与上游一致），6 位/3 位是不带 alpha 的普通 hex。
 */
export function parseHex(input: string, fallback: Rgba = { r: 0, g: 0, b: 0, a: 1 }): Rgba {
  const s = String(input ?? '').trim();
  const m = HEX_RE.exec(s);
  if (!m) return fallback;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) {
    // ARGB：前两位是 alpha（照抄 Android Color.hexString 的语义）
    return { a: parseInt(h.slice(0, 2), 16) / 255, r: parseInt(h.slice(2, 4), 16), g: parseInt(h.slice(4, 6), 16), b: parseInt(h.slice(6, 8), 16) };
  }
  if (h.length !== 6) return fallback;
  return { a: 1, r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** 0~1 的相对亮度（sRGB，WCAG 加权）—— 只用于「亮底还是暗底」与对比度计算 */
export function relLuminance(c: Rgba): number {
  const lin = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** 亮底还是暗底（阈值 0.5 = WCAG 对比度公式的分界，不是拍的） */
export function isLightColor(input: string): boolean {
  return relLuminance(parseHex(input)) > 0.5;
}

const to2 = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

/** 每个通道线性 +`amt`（`amt`<0 = 变暗）。⚠️ 上游没有这个概念，是本仓派生用的（见文件头声明） */
export function stepColor(input: string, amt: number): string {
  const c = parseHex(input);
  return `#${to2(c.r + amt)}${to2(c.g + amt)}${to2(c.b + amt)}`;
}

/** `rgba(r,g,b,a)` 串 —— 用于边框 / 光晕这类「同色不同透明度」的场景 */
export function withAlpha(input: string, alpha: number): string {
  const c = parseHex(input);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.min(1, Math.max(0, alpha))})`;
}

/**
 * 归一成 6 位 `#rrggbb` —— 给 `<input type="color">` 用。
 * ⚠️ 那个控件**不吃** 8 位 ARGB（`#ffc0edc6` 会被当成非法值清空），所以喂之前必须剥掉 alpha。
 * 解析失败返回灰（`#888888`），让用户至少能打开取色器重新选，而不是看到一个空输入框。
 */
export function toRrGgBb(input: string | null | undefined): string {
  const c = parseHex(String(input ?? ''), { r: 0x88, g: 0x88, b: 0x88, a: 1 });
  return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
}

/**
 * 在给定底色上可读的前景色（WCAG 对比度最大者）。
 * ⚠️ 只返回黑白两档 —— 上游也是这个思路（E-Ink 分支直接给 `Color.WHITE`/`Color.BLACK`），
 * 这里只是把「选哪档」从硬编码变成按对比度算。
 */
export function contrastOn(input: string): string {
  return relLuminance(parseHex(input)) > 0.35 ? '#0B0D12' : '#FFFFFF';
}

/* ------------------------------------------------------------------ *
 * 判槽 / 墨水屏（照抄 AppConfig.kt:172-178）
 * ------------------------------------------------------------------ */

/**
 * 现在算「夜间」吗 —— **逐分支照抄** `AppConfig.isNightTheme` 的 getter（`AppConfig.kt:172-178`）：
 * `"1"` → false · `"2"` → true · **`"3"`（墨水屏）→ false** · `"0"`（跟随系统）→ 系统日夜偏好。
 */
export function uiNightActive(themeMode: string, prefersDark: boolean): boolean {
  if (themeMode === '1') return false;
  if (themeMode === '2') return true;
  if (themeMode === '3') return false; // 别漏：墨水屏不算夜间（上游明确写了 "3" -> false）
  return prefersDark;
}

/**
 * 生效的那套界面主题。
 * 墨水屏（`"3"`）**不取槽** —— 上游 `ThemeConfig.applyTheme()` 的 EInk 分支
 * （`ThemeConfig.kt:398-406`）是直接给一套强制黑白，无视日/夜槽。
 */
export function effectiveUiTheme(
  themeMode: string,
  prefersDark: boolean,
  day: UiThemeConfig,
  night: UiThemeConfig,
): UiThemeConfig {
  return themeMode === '3' ? EINK_UI_THEME : uiNightActive(themeMode, prefersDark) ? night : day;
}

/* ------------------------------------------------------------------ *
 * 主题 → CSS 变量
 * ------------------------------------------------------------------ */

/** 亮 / 暗底各自的**文本**梯度（暗底那组就是 `styles/theme.css` 原来的字面值，保证默认观感不变） */
const TEXT_SET = {
  dark: { t0: '#E8ECF1', t1: '#B7BFCC', muted: '#6D7688', faint: '#5C6478' },
  light: { t0: '#1B1E24', t1: '#3A4150', muted: '#5C6577', faint: '#8A92A3' },
} as const;

/** 内置壁纸预设（`backgroundImgPath` 留空时的快捷选择）。⚠️ 本仓自有 —— 上游只支持选图。 */
export const WALLPAPER_PRESETS: ReadonlyArray<{ id: string; label: string; css: string }> = [
  { id: '', label: '无壁纸', css: '' },
  { id: 'wp-dawn', label: '晨昏', css: 'linear-gradient(160deg, #2b3a67 0%, #b56576 55%, #f0c987 100%)' },
  { id: 'wp-forest', label: '林间', css: 'linear-gradient(160deg, #1f4d4a 0%, #0c2a2a 60%, #04140f 100%)' },
  { id: 'wp-ink', label: '墨色', css: 'linear-gradient(160deg, #232946 0%, #121629 60%, #0b0d12 100%)' },
  { id: 'wp-blossom', label: '花笺', css: 'linear-gradient(160deg, #ffe3ec 0%, #f7c8d8 55%, #fdf6f0 100%)' },
];

/** 壁纸取值 → CSS `background-image`。支持内置预设 id / http(s) URL / data URL。 */
export function wallpaperCss(path: string | null | undefined): string {
  const p = String(path ?? '').trim();
  if (!p) return 'none';
  const preset = WALLPAPER_PRESETS.find((w) => w.id === p);
  if (preset) return preset.css;
  // ⚠️ 只放行 http(s) 与 data: —— 其它 scheme（file:/javascript:）既加载不了也不该加载
  if (/^https?:\/\//i.test(p) || /^data:image\//i.test(p)) return `url("${p.replace(/"/g, '%22')}")`;
  return 'none';
}

/**
 * 一套主题 → CSS 变量。**所有派生规则的出处都写在各行注释里。**
 *
 * 返回的变量**直接写到 `<html>` 的 inline style**（`App.vue`），因此覆盖 `:root` 的字面值；
 * 没写到的变量（如 `--cy` / `--gold` 这些语义色）继续用 `:root` 那份。
 */
export function uiThemeVars(t: UiThemeConfig): Record<string, string> {
  const bg = parseHex(t.backgroundColor, { r: 0x0b, g: 0x0d, b: 0x12, a: 1 });
  const light = relLuminance(bg) > 0.5;
  const dir = light ? -1 : 1; // 亮底往上变深、暗底往上变亮 —— 卡片永远比页面「浮」一层
  const text = light ? TEXT_SET.light : TEXT_SET.dark;
  const primary = t.primaryColor || '#4F8CFF';
  const accent = t.accentColor || '#A070FF';

  const vars: Record<string, string> = {
    // ── 背景：--bg-0 页面 / --bg-1 侧栏+顶栏（= bottomBackground，语义最接近的那项）/
    //        --bg-2 控件底 / --bg-3 悬浮层
    '--bg-0': t.backgroundColor,
    '--bg-1': t.bottomBackground || t.backgroundColor,
    '--bg-2': stepColor(t.backgroundColor, 12 * dir),
    '--bg-3': stepColor(t.backgroundColor, 19 * dir),

    // ── 文本：亮/暗各一组（暗底那组 = theme.css 原值，默认观感不变）
    '--text-0': text.t0,
    '--text-1': text.t1,
    '--muted': text.muted,
    '--faint': text.faint,

    // ── 边框：原来写死 rgba(255,255,255,α)（暗色假设）—— 亮底下会整个消失，改由文字色派生
    '--border': withAlpha(text.t0, 0.07),
    '--border-strong': withAlpha(text.t0, 0.14),

    // ── 主色 / 强调色
    '--brand': primary,
    '--accent': accent,
    '--brand-soft': withAlpha(primary, 0.14),
    '--acc': primary, // 原来是独立的 #6c7cff；统一到主色，避免「品牌色换了、chips 还蓝着」
    '--acc-dim': stepColor(primary, -18), // 焦点/悬停描边：比主色深一档（两边的主题都成立）
    '--acc-glow': withAlpha(primary, 0.35),

    // ── 落在主色上的文字（按钮/激活项）。不能写死 #fff：主色若被换成亮色就看不见了
    '--on-brand': contrastOn(primary),

    // ── 底栏沉浸：上游 transparentNavBar = 导航栏透明（pref_config_theme.xml:133「沉浸导航栏」）
    //    Web 映射：侧栏/顶栏不铺自己的底色，让壁纸透上来
    '--nav-bg': t.transparentNavBar ? 'transparent' : (t.bottomBackground || t.backgroundColor),

    // ── 页面底：没壁纸 = --bg-0；有壁纸 = 透明（否则壁纸被页面自己的底色盖住，永远看不见）
    '--ui-page-bg': t.backgroundImgPath ? 'transparent' : 'var(--bg-0)',

    // ── 壁纸层
    '--ui-wallpaper': wallpaperCss(t.backgroundImgPath),
    '--ui-wallpaper-blur': `${clampInt(t.backgroundImgBlur, 0, 40)}px`,

    // ── 阴影：亮底上 35% 黑会变成一圈脏边，压到 12%
    '--shadow': light ? '0 8px 24px rgba(0, 0, 0, 0.12)' : '0 8px 24px rgba(0, 0, 0, 0.35)',
  };
  return vars;
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.round(Math.min(max, Math.max(min, n)));
}

/* ------------------------------------------------------------------ *
 * 封面（照抄 BookCover.kt / CoverImageView.kt）
 * ------------------------------------------------------------------ */

/** 默认封面底图路径（从上游 Legado 的 `image_cover_default.jpg` 引入） */
const DEFAULT_COVER_PATH = '/assets/default-cover.jpg';

/**
 * 日/夜槽的封面参数（照抄 `BookCover.upDefaultCover()`，`BookCover.kt:66-83` 的分支）。
 * ⚠️ `coverHorizontal` / `coverKeepPunctuation` / `useDefaultCover` 是**全局**的（不分日夜）。
 */
export function coverParamsFor(cfg: UiCoverConfig, isNight: boolean): {
  showName: boolean;
  showAuthor: boolean;
  bgImage: string | null;
} {
  return {
    showName: isNight ? cfg.coverShowNameN : cfg.coverShowName,
    showAuthor: isNight ? cfg.coverShowAuthorN : cfg.coverShowAuthor,
    bgImage: (isNight ? cfg.defaultCoverDarkPath : cfg.defaultCoverPath) || DEFAULT_COVER_PATH,
  };
}

/**
 * 封面文字清洗 —— **逐字照抄** `normalizeCoverText`（`CoverImageView.kt:52-55`）：
 * ```kotlin
 * internal fun normalizeCoverText(value: String?, keepPunctuation: Boolean): String? =
 *     value?.let { text ->
 *         if (keepPunctuation) text.trim() else text.replace(AppPattern.bdRegex, "").trim()
 *     }
 * ```
 * `AppPattern.bdRegex = Regex("(\\p{P})+")`（`AppPattern.kt:50`）—— **Unicode 标点类**，
 * JS 的 `\p{P}` 需要显式 `u` 标志，别漏。
 */
export function normalizeCoverText(value: string | null | undefined, keepPunctuation: boolean): string {
  const text = String(value ?? '');
  const t = text.trim();
  if (keepPunctuation) return t;
  return t.replace(/(\p{P})+/gu, '').trim();
}

/**
 * 生成封面上文字的**配色** —— 上游 `CoverImageView.generateCoverBitmap`
 * （`CoverImageView.kt:391-396` 书名 / `413-418` 作者，两处逐字相同）：
 * ```kotlin
 * namePaint.color = backgroundColor;  namePaint.style = Paint.Style.STROKE; canvas.drawText(...)
 * namePaint.color = accentColor;      namePaint.style = Paint.Style.FILL;   canvas.drawText(...)
 * ```
 * 即**先描边一遍、再用强调色填一遍**（同一段文字画两遍）。
 *
 * ## 本仓为什么不能原样照抄那一行（本轮修掉的真缺陷，不是审美偏好）
 * 上游的描边色 = **主题底色**，而它的封面底**也是同一个底色** ⇒ 「同色描边」是刻意的造型手法。
 * 本仓的底**是一张图片**（`defaultCoverPath`，内置默认封面 `assets/default-cover.jpg`
 * 就是一张**浅色宣纸**），与主题底色毫无关系：
 * · 照抄「用主题底色描边」⇒ 浅底主题 + 浅色宣纸底图 = 浅底浅描边，字彻底看不见；
 * · 旧实现更糟：写死 `rgba(255,255,255,.94)` 白字 + 黑投影 ⇒ **浅底白字同样看不见**（实测截图确认）。
 *
 * ## 本仓的做法：深浅**双圈**描边（本仓扩展，上游无对应代码）
 * 判断不了底图明暗（用户可配任意 `defaultCoverPath`），所以不去猜 ——
 * 两圈都画：浅底上**深圈**起作用，深底上**浅圈**起作用。字面照旧用用户选的强调色。
 * 这样对任意底图都有一侧轮廓，代价只是多几行 `text-shadow`。
 */
export interface CoverTextStyle {
  /** 字面色（上游 = `accentColor`，本仓保留 —— 主题强调色是用户自己选的） */
  fill: string;
  /** 深色描边（浅底上起作用）。**6 位 hex**，alpha 由 {@link alpha} 给 —— 别写成 `rgba()` 串 */
  strokeDark: string;
  /** 浅色描边（深底上起作用）。同上 */
  strokeLight: string;
  /**
   * 两圈描边的 alpha（0~1）。
   * ⚠️ 为什么单独一个字段而不是直接返回 `rgba()` 串：本仓的 {@link parseHex}
   * **只认 `#` hex**（这是被回归锁钉住的既有语义，见 `ui-theme.test.ts` 的 ARGB 用例），
   * 返回 `rgba()` 串会让「这圈到底多深」在测试里无法断言。
   */
  alpha: number;
  /** 内圈描边宽（CSS 长度）。上游 `namePaint.strokeWidth = textSize / 6` ⇒ 折成 em */
  strokeWidth: string;
  /** 外圈描边宽（比内圈宽一档） */
  strokeWidthOuter: string;
}

/**
 * 书名字号的**除数**（字号 = 封面宽 / 它）。
 *
 * 照抄上游 `coverTitleTextSize`（`CoverImageView.kt:80-92`）：
 * ```kotlin
 * internal fun coverTitleTextSize(viewWidth, viewHeight, characterCount, largeTextHeight) =
 *   if ((characterCount - 2) * largeTextHeight > viewHeight * 0.7f ||
 *       (characterCount - 3) * largeTextHeight > viewHeight * 0.6f) viewWidth / 9
 *   else viewWidth / 7
 * ```
 * `largeTextHeight` = `viewWidth/7` 那个字号下的字高（中文 ≈ 字号本身）。
 *
 * ⚠️ **阈值依赖封面高宽比，两侧比例不同**（别当成抄错了）：
 * · 上游 `onMeasure` 固定 `params.height = width * 4 / 3` ⇒ 高/宽 = 1.333
 *   代进去解出「字数 ≥ **9** ⇒ /9」；
 * · 本仓卡片是竖版（`ShelfView` 用 `aspect-ratio: 2 / 3` ⇒ 高/宽 = **1.5**）
 *   同式解出「字数 ≥ **10** ⇒ /9」（逐条代数在回归锁里，两档都钉住）。
 * 差一档只影响长书名的字号观感、不影响功能，故按**本仓真实比例**取值，不硬套 4:3。
 */
export function coverTitleDivisor(characterCount: number): 7 | 9 {
  return characterCount >= 10 ? 9 : 7;
}

/* ============================================================================
 * `#177` 生成封面的**竖排/横排逐字布局** —— 照抄上游 `CoverImageView.generateCoverBitmap`
 *
 * ## 为什么要移植成 TS，而不是继续用 CSS `writing-mode` 顶着
 * 上游的竖排**不是**「把整段文字交给排版引擎」：
 * 它**逐字**推进一个 Y 游标，并在两个阈值上决定「换列/压缩/收尾」（`coverTitleColumnOffsets`）。
 * 这套逻辑用 CSS 表达不了 —— `writing-mode` 只会「按容器高度自动换列」，
 * 而上游是「按**字数**与**高度的比值**在 0.8/ 0.9 两个点上做不同动作」。
 * ⇒ 移植成纯函数后：**数值可单测**（见 `tests/cover-layout.test.ts`），
 *   CSS 只负责按算出的坐标逐字摆位，不参与决策。
 *
 * ## 上游出处（逐条核对，不照印象写）
 * · `coverTitleColumnOffsets`（`:100-135`）：换列算法本体；
 * · `coverTitleColumnStartY`（`:94-98`）：`top + max(0, maxColumnBottom - columnBottom)`
 *   ⇒ **各列底部对齐**（短列往下压），不是顶部对齐；
 * · 竖排书名首列 `startX = viewWidth * 0.2f`，后续列 `+ textSize * columnIndex`（`:379`）；
 * · 作者 `startX = viewWidth * 0.8f`、`startY = max(viewHeight*0.95 - 字数*行高, viewHeight*0.3f)`，
 *   且逐字下移时 `startY > viewHeight*0.95` 就**截断**（`:407-420`）。
 */

/** 一列里的每个字，相对该列顶部的 Y 偏移（上游 `column` 里存的就是相对 offset） */
export type CoverColumn = number[];

/**
 * 上下两个字之间必须留的**净空**（相对字号），本仓扩展（上游没有这个概念）。
 *
 * ## 为什么必须偏离上游
 * 上游是 `Canvas.drawText` **逐字**绘制，**没有行高/字距的概念** —— 两个字的间距就等于
 * `textSize`。本仓走 CSS：竖排每列是 `display:flex; flex-direction:column`，
 * 字之间的实际间距 = 行高 − 字号。而本组件为了让字在浅色宣纸底上可见，给每个字描了
 * **内外双圈** `text-shadow`（合计外扩约 `0.055em + 0.11em ≈ 0.165em`，见 `CoverImage.vue`）。
 * ⇒ `line-height: 1` 时**净空 = 0**，描边直接互相吃掉 ⇒
 *   **下方字的描边压在��方字上**（用户 2026-10-01 实测「竖排：下方文字会遮挡一点上方文字」，
 *   放大截图确认是描边粘连，不是坐标算错）。
 *
 * ## 为什么是 0.12（`#186` 二轮 2026-10-01 晚：0.16 → 0.12，用户实测「纵向字与字之间间隔
 * 稍微大了一点」）
 * 描边外扩 ≈ 0.165em；0.12em 净空 ⇒ 相邻字的**外圈描边轻微相切**、内圈不粘连 ——
 * 这是用户在「描边粘连」与「字距偏松」之间拍板的取舍，**别再单方面调回 0.16**。
 *⚠️ 这条只改**渲染行距**；**分列决策仍用上游的 `textSize * 1.2` 结构**（`coverTitleColumns`），
 *   但 `#186` 二轮起容量按渲染步进算（见其 `opts.step`）—— 否则长书名末字会越出装饰线。
 */
export const COVER_CHAR_GAP = 0.12;

/**
 * 列与列之间的**步进系数**（1 = 恰好等于字号，即列距 0），本仓扩展（上游没有）。
 *
 * ## 为什么需要
 * 竖排的字是方形、字宽 = 字号 ⇒ 步进 = 字号 ⇒ **列间净空也是 0**，描边同样互相吃掉
 * （用户 2026-10-01 实测「字与字上下左右应有适当间距」）。
 * 取 1.12 ⇒ 列间净空 ≈ 0.12 × 字号（与 {@link COVER_CHAR_GAP} 同一净空口径）。
 * ⚠️ **顺带是个安全边界**：列 x 起点固定 `0.2*宽`，作者列固定 `0.8*宽` ⇒
 *   长书名的末列不会压到作者那一列（上游步进 1.0 能排 6 列，末列描边会撞作者列）。
 * ★ `#186` 二轮（2026-10-01 晚）：1.18 → 1.12 —— 用户实测「行间距适当再减少一点」。
 */
export const COVER_COLUMN_GAP = 1.12;

/**
 * 竖排书名的分列 —— 结构逐字照抄上游 `coverTitleColumnOffsets`
 *（`CoverImageView.kt:100-135`：0.8H 提前换列 / 0.9H 强制换列 / 最后两字压缩 1/5 行高）。
 *
 * @param characterCount 字数（已按`Array.from` 数过，不是 `length`）
 * @param viewHeight封面高（px 或 cqw 换算后的值，与 viewWidth 同一坐标系）
 * @param textHeight 单字行高（= 字号 × 行高系数）
 * @param opts **渲染感知的容量**（`#186` 二轮，本仓扩展 —— 上游没有对应物）：
 *
 * ## 为什么需要 opts.step（长书名末字越线的根治）
 * 上游按 `textSize×1.2` 推进游标、0.9H 强制换列 —— 它的 y 是**基线**、且没有字距。
 * 本仓渲染按 `renderLineHeight`（1.2+GAP）摆，**同样的字数列会更长**：
 * 7 字书名（如「斗罗之诸天卡牌」）在上游容量下排 1 列，渲染列底 ≈ 0.98H，
 * 直接压过默认封面 0.930H 的装饰横线（用户 2026-10-01 晚实测截图）。
 * ⇒ 传入 `step = renderLineHeight` 后，0.8/0.9 两个阈值按**渲染步进**推进，
 *   容量自动收缩（2:3 卡 ÷7 档从 6~7 字/列 收到 5 字/列），列底回到 ≤0.9H 安全区。
 * ⚠️ **缺省（不传 opts）仍与上游逐字节一致** —— 旧测试与上游对表依赖这一点。
 */
export interface CoverTitleSplitOpts {
  /** 字的 em 高（= 字号）。缺省 = textHeight（上游口径） */
  charSize?: number;
  /** 渲染步进（相邻两字 em 顶的间距）。缺省 = textHeight ⇒ 上游口径 */
  step?: number;
}

export function coverTitleColumns(
  characterCount: number,
  viewHeight: number,
  textHeight: number,
  opts?: CoverTitleSplitOpts,
): CoverColumn[] {
  if (characterCount <= 0 || viewHeight <= 0 || textHeight <= 0) return [];
  const charSize = opts?.charSize ?? textHeight;
  const step = opts?.step ?? textHeight;
  const columns: CoverColumn[] = [];
  let column: number[] = [];
  let columnOffset = 0;
  let line = 0;
  // cursor = 下一个字的 **em 顶**（本仓按 em 盒推进，与 CSS 行盒模型一致）
  let cursor = viewHeight * 0.2;
  for (let index = 0; index < characterCount; index += 1) {
    column.push(columnOffset);
    columnOffset += step;
    cursor += step;
    // 下一个字的 **em 底**（em 顶 + 半行距 + 字高）：越过安全底就处理换列
    const nextEmBottom = cursor + (step + charSize) / 2;
    const remaining = characterCount - index - 1;
    if (nextEmBottom > viewHeight * 0.9) {
      if (remaining === 1) {
        // 最后两个字：各压缩 1/5 行高（上游 `:117-119`）
        cursor -= step / 5;
        columnOffset -= step / 5;
      } else if (remaining > 0) {
        columns.push(column);
        column = [];
        columnOffset = 0;
        line += 1;
        cursor = viewHeight * 0.2 + step * line;
      }
    } else if (nextEmBottom > viewHeight * 0.8 && remaining > 2) {
      columns.push(column);
      column = [];
      columnOffset = 0;
      line += 1;
      cursor = viewHeight * 0.2 + step * line;
    }
  }
  if (column.length) columns.push(column);
  return columns;
}

/**
 * 某一列的起始 Y —— 逐字照抄上游 `coverTitleColumnStartY`（`:94-98`）。
 * 各列**底部对齐**：`top + max(0, maxColumnBottom - columnBottom)`。
 */
export function coverTitleColumnStartY(
  top: number,
  maxColumnBottom: number,
  columnBottom: number,
): number {
  return top + Math.max(0, maxColumnBottom - columnBottom);
}

/**
 * 竖排书名的完整布局（组件直接按这个摆位）。
 *
 * @param text     书名（**已清洗**：去标点等，见 `normalizeCoverText`）
 * @param viewWidth  封面宽
 * @param viewHeight 封面高
 * @param divisor字号除数（`coverTitleDivisor` 的结果：7 或 9）
 * @returns 每列的 `x`（该列**中心线**位置）、`y`（列顶）、`chars`（逐字），以及全局 `textHeight`
 *
 * ⚠️ `x` 是**中心线**：上游 `TextPaint.textAlign = CENTER`（`:361`），
 *   逐字drawText 时 x 是字的中心 ⇒ CSS 里必须配`translateX(-50%)`。
 */
export interface CoverTitleLayout {
  /** 每列：x = 中心线位置、y = 列顶、chars = 该列的字 */
  columns: Array<{ x: number; y: number; chars: string[]; fs: number }>;
  textHeight: number;
  textSize: number;
  /** 各列底部的最大值（喂给coverTitleColumnStartY 做底部对齐） */
  maxColumnBottom: number;
  /**
   * ★ **渲染行高**（px）＝ `textSize × (1.2 + COVER_CHAR_GAP)` —— 组件据此设 `.cv-col` 的
   * `line-height`，同列内相邻字的 Y 间距就等于它。
   *
   * 为什么单独带出来（`#181` 用户实测「下方文字遮挡上方文字」）：
   * **分列**必须按上游的 `textSize × 1.2` 算（否则列数就变了），
   * 而**渲染**要按带净空的行高摆（否则描边吃掉间距）。
   * ⚠️ 别改成「用 renderLineHeight 去分列」—— 那会让列数与Legado 不一致。
   */
  renderLineHeight: number;
}

export function coverTitleLayout(
  text: string,
  viewWidth: number,
  viewHeight: number,
  divisor: 7 | 9,
): CoverTitleLayout {
  const chars = Array.from(text);
  const textSize = viewWidth / divisor;
  // 行高：上游 `textHeight` 来自 Paint.getTextHeight()，约 = 字号 × 1.17（Android 默认字体含上下伸部）
  // 这里取 1.2：CSS 侧算的是「行盒高度」，比字形包围盒略大一点，视觉上更接近上游截图。
  const textHeight = textSize * 1.2;
  const renderLineHeight = textSize * (1.2 + COVER_CHAR_GAP);
  // ★ `#186` 二轮：分列按**渲染步进**算容量（否则 7 字书名排 1 列、末字压过装饰线，
  //   用户实测截图）—— 结构（0.8/0.9 阈值、/5 压缩）仍是上游的。
  const offsets = coverTitleColumns(chars.length, viewHeight, textHeight, {
    charSize: textSize,
    step: renderLineHeight,
  });
  const bottoms = offsets.map((col) => col[col.length - 1]);
  const maxColumnBottom = bottoms.length ? Math.max(...bottoms) : 0;
  // ⚠️ 上游是**逐字推进 nameIndex**（`:374-386`）：第 n 列拿到的是「前n 列用掉的字数之后」那些字。
  //   所以这里是**按各列字数累加切片**，不是按 bottom 值去找列（后者在两列等高时会取错）。
  let consumed = 0;
  // ★ 底部对齐在**渲染坐标系**里直接做：列顶 = 0.2H + (最长列字数 − 本列字数) × 渲染步进。
  //   ⇒ 各列的渲染列底（y + 字数×渲染行高）恒等于 0.2H + 最长列字数×步进，天然对齐；
  //     且最长列（从 0.2H 起）的 em 底已被分列阈值压在 ≤0.9H（不越 0.930H 的装饰横线）。
  //   （旧版的 `字数×(renderLH−textH)` 修正量已被这个公式取代 —— 那是决策/渲染双行高
  //     不一致时的补丁，现在分列本身就按渲染步进算，不再需要。）
  const tallest = offsets.length ? offsets[0].length : 0;
  const columns = offsets.map((col, ci) => {
    const slice = chars.slice(consumed, consumed + col.length);
    consumed += col.length;
    return {
      // 上游：首列 0.2*宽，后续列每列 +textSize（`:371`、`:379`）
      //★ 本仓：步进 × COVER_COLUMN_GAP（列间留净空，见常量注释的「安全边界」那条）
      x: viewWidth * 0.2 + textSize * COVER_COLUMN_GAP * ci,
      y: viewHeight * 0.2 + (tallest - col.length) * renderLineHeight,
      chars: slice,
      // 每列字号都一样（上游只分 /7 与 /9 两档，逐字不缩放）—— 带出来给组件直接用
      fs: textSize,
    };
  });
  return { textSize, textHeight, renderLineHeight, maxColumnBottom, columns };
}

/**
 * 竖排作者的布局（上游 `:404-420`）。
 * `x = 0.8*宽`；`y` 从底部往上留出「字数 × 行高」，但**不低于 0.3*高**；逐字超出 0.95*高即截断。
 */
export interface CoverAuthorLayout {
  x: number;
  y: number;
  chars: string[];
  textSize: number;
  /** 渲染行高（px）＝ 字号 × (1.2 + COVER_CHAR_GAP)，与书名列同一口径（见 {@link COVER_CHAR_GAP}） */
  renderLineHeight: number;
  /** 放不下被截断掉了几个（组件可据此决定要不要提示） */
  truncated: number;
}

/**
 * 竖排作者列的**底线**（占高的比例），本仓扩展（上游是 0.95）。
 *
 * ## 为什么必须从 0.95 收到 0.92（`#186`，用户 2026-10-01 实测「作者下端超过下方装饰横线」）
 * 内置默认封面底图 `assets/default-cover.jpg`（600×900，来自上游 `image_cover_default.jpg`）
 * 下方有**三条装饰横线**，最上面一条在 **0.930H**（实测逐行亮度：y=836..838 / 900 ⇒ 0.930）。
 * 上游的 0.95 是给 **4:3 容器**定的：`CoverImageView` 的 `onMeasure` 固定 `height = width*4/3`，
 * `cover` 居中裁切后那条 0.930 的线落在 **(0.930-0.0556)/0.8889 ≈ 0.983H** ⇒ 压不到。
 * 本仓竖版卡片是 **2:3（零裁切）** ⇒ 那条线就在 0.930H，0.95 必然越线。
 * 取 0.92 ⇒ 字形底沿 ≈ 0.91H，与 0.930H 的线留约 2% 可见间隙。
 * ⚠️ 别改回 0.95，也别「顺手」再抬高 —— 再高就压到书名列的换列区（0.9H 阈值）。
 */
export const COVER_AUTHOR_BOTTOM = 0.92;

export function coverAuthorLayout(
  text: string,
  viewWidth: number,
  viewHeight: number,
): CoverAuthorLayout {
  const chars = Array.from(text);
  const textSize = viewWidth / 10;
  // ★ `#186` 占位/截断必须用**渲染行高**（renderLineHeight），不能再用上游的 textHeight：
  //   旧实现 y 按 textHeight(1.2) 算、渲染却按 renderLineHeight(1.2+GAP) 摆，
  //   末字底部比预期低 `字数×GAP×字号` —— 4 个字就多坠 0.064×宽 ≈ 0.043×高，
  //   这正是「作者压过装饰横线」的主因之一（另一个是上面的 0.95 底线）。
  const renderLineHeight = textSize * (1.2 + COVER_CHAR_GAP);
  // 上游 `max(viewHeight*0.95 - size*textHeight, viewHeight*0.3)`（`:412-413`）；
  // 底线换成 {@link COVER_AUTHOR_BOTTOM}（本仓扩展，理由见其注释）。
  const y = Math.max(
    viewHeight * COVER_AUTHOR_BOTTOM - chars.length * renderLineHeight,
    viewHeight * 0.3,
  );
  // 上游逐字下移，`startY > viewHeight*0.95` 就 return（`:417-419`）—— 同样换成渲染行高口径。
  // ⚠️ 这里数的是**整行盒**（不带上游的 `+1`）：上游判的是基线（drawText 的 y），
  //   字形下伸部还会低于基线；CSS 里行盒底 = 字形底 + 半行距 ⇒ 按「列底 = y + n×行盒高 ≤ 底线」
  //   计数才能保证**渲染出来的**列底不越线。略严于上游，视觉意图一致。
  const fit = Math.floor((viewHeight * COVER_AUTHOR_BOTTOM - y) / renderLineHeight);
  const kept = chars.slice(0, Math.max(0, Math.min(chars.length, fit)));
  return {
    x: viewWidth * 0.8,
    y,
    chars: kept,
    textSize,
    renderLineHeight,
    truncated: chars.length - kept.length,
  };
}

/* ============================================================================
 * 竖排布局用不到CSS 的 `writing-mode` 了，但**横排**仍然是「交给排版引擎」——
 * 上游 `drawHorizontalTextCover`（`:428-498`）是「标题居中 4 行 + 作者右对齐单行」，
 * 这两件事 CSS 原生就能做，且不涉及逐字决策。横排样式留在组件里。
 * ============================================================================ */

/** 横排书名的**行数上限**（上游 `HORIZONTAL_TITLE_MAX_LINES`，`drawHorizontalTextCover` 用） */
export const HORIZONTAL_TITLE_MAX_LINES = 4;
/** 横排行高系数（上游 StaticLayout 默认行距 ≈ 1.34；与组件 `.cv-text.h .t` 的 line-height 同值） */
export const HORIZONTAL_LINE_HEIGHT = 1.34;

/**
 * 横排（宽扁容器）的布局度量 —— 本仓扩展（`#186`），上游没有对应物。
 *
 * ## 为什么横排也要搬进 TS 算，而不是留在 CSS `calc(100cqw / …)`
 * 上游横排字号只看**宽度**（`textSize = viewWidth / 7`），因为上游封面控件
 * 最扁也是 4:3，`0.1H + 4 行 × 1.34 × viewWidth/7 ≈ 0.9W < 1.227W` 放得下。
 * 本仓 `#184` 的横屏卡片是 **16:10（高/宽 = 0.625）**：按宽度取字号的话
 * 4 行要 `0.16W + 0.766W = 0.926W`，而容器只有 `0.625W` 高 ⇒ **必然溢出**
 * （用户 2026-10-01 实测「横屏布局：书名作者文字错乱」的另一半根因）。
 * ⇒ 字号必须**同时受高度约束**：`min(宽/档位, 可用高度 / (行数上限 × 行高))`。
 *
 * ## 什么时候被调用
 * 组件按**实测宽高**判定（`w/h > 1.2` 即宽扁，见 `CoverImage.vue` 的 `isWideBox`），
 * 宽扁时**强制横排**（用户拍板：「横屏时，书名/作者切为横向展示」），
 * 用户 pref `coverHorizontal` 在竖版容器下仍然生效（上游语义保留）。
 *
 * @returns 三个 px 值，组件内联成 CSS 变量（`--cv-ttop/--cv-tfs/--cv-afs`）
 */
export interface CoverHorizontalLayout {
  /** 首行顶部留白（px）—— 对齐上游 `titleY = viewHeight * 0.1f` 的意图；
   *  `#181` 实测顶部有装饰花纹 ⇒ 抬到 0.16（对齐组件 CSS 的 `margin-top: 16%`），
   *  但宽扁容器里 16% **宽度**可能超过容器高的小头 ⇒ 用 `min(0.16*宽, 0.18*高)` 兜住 */
  titleTop: number;
  /** 书名字号（px） */
  titleSize: number;
  /** 作者字号（px）—— 上游 `viewWidth / 10` 起、超宽逐级缩到 `viewWidth / 16`（`:476-481`），
   *  这里折算成「高度约束」一口算，避免在 CSS 里做循环 */
  authorSize: number;
}

export function coverHorizontalLayout(
  viewWidth: number,
  viewHeight: number,
  characterCount: number,
): CoverHorizontalLayout {
  if (viewWidth <= 0 || viewHeight <= 0) {
    return { titleTop: 0, titleSize: 0, authorSize: 0 };
  }
  const divisor = coverTitleDivisor(characterCount);
  // 首行顶部：与组件 CSS 的 `margin-top: 16%` 同值（16% 是相对**宽度**的百分比边距）
  const titleTop = Math.min(viewWidth * 0.16, viewHeight * 0.18);
  // 底部作者行预留：上游作者基线 0.92H ⇒ 预留 0.16H（含 8% 的下边距，见组件 CSS）
  const authorReserve = viewHeight * 0.16;
  const usable = viewHeight - titleTop - authorReserve;
  // ★ 高度约束：可用高度必须装下「行数上限 × 行高」，装不下就缩字号
  const byHeight = usable / (HORIZONTAL_TITLE_MAX_LINES * HORIZONTAL_LINE_HEIGHT);
  const titleSize = Math.max(6, Math.min(viewWidth / divisor, byHeight));
  const authorSize = Math.max(6, Math.min(viewWidth / 10, authorReserve / 1.6));
  return { titleTop, titleSize, authorSize };
}

/**
 * 生成封面文字的配色（深浅双圈描边，见 {@link CoverTextStyle} 的说明）。
 *
 * @param accent主题强调色（上游 `accentColor`）
 * @param bgTheme 主题底色（上游 `backgroundColor`）—— **只用来判断强调色要不要退回黑白**，
 *   不再当描边色（那正是本轮去掉的做法：底图是图片，跟主题底色没关系）
 */
export function coverTextColors(accent: string, bgTheme: string): CoverTextStyle {
  // 强调色与主题底色几乎同色时（用户把 accent 配成了底色），字面会糊 ⇒ 退回黑/白
  const gap = Math.abs(relLuminance(parseHex(accent)) - relLuminance(parseHex(bgTheme)));
  return {
    fill: gap < 0.25 ? contrastOn(bgTheme) : toRrGgBb(accent),
    strokeDark: '#000000',
    strokeLight: '#FFFFFF',
    // 不是 1：底图是照片/插画时纯黑纯白的实心描边太硬，0.8 观感更接近上游的 STROKE
    alpha: 0.8,
    strokeWidth: '0.1em',
    strokeWidthOuter: '0.2em',
  };
}

/**
 * 「这张卡片该不该画默认封面」。
 * 上游 `BookCover.load()`（`BookCover.kt:95-98`）：`useDefaultCover` 为真时**无视**真实封面地址。
 * 这里再补一条 Web 必需的：真实封面**本来就为空**（源站没给）⇒ 也走默认封面。
 */
export function useDefaultCover(cover: string | null | undefined, cfg: UiCoverConfig): boolean {
  // 落点收口到 `default-cover-core.ts` 的纯函数（「真实封面 > 自定义默认 > 内置占位」的唯一判据，
  // 有单测锁）；`loadFailed=false` 是因为本函数只回答「该不该去加载真图」，
  // 加载失败后的回落由 `CoverImage` 的 `state==='error'` 另行叠加。
  return coverLayerOf(cover, cfg.useDefaultCover, false) === 'default';
}

/* ⚠️ 这里曾经有两个函数（`coverGenShowsText` / `cardShowsText`），语义是
 * 「有真实封面时**隐藏卡片下方的书名/作者**」（`#172`，用户 2026-09-30 Add）。
 * **已按用户 2026-10-01 纠错删除** —— 理由不是「实现得不好」，而是那条规则本身与需求冲突：
 *
 * · 用户口径：**「封面」仅指封面图片本身，不包含图片下方信息**（两者是不同的东西）；
 * · 那条规则的实际后果 = 「书籍一旦有真封面，卡片下方的书名/作者/最新章节**整块消失**」，
 *   而这恰恰是用户唯一在看的信息（用户原话：「封面图片下方三行信息展示，应始终存在，退回之前」）；
 * · 它还带来一个副作用：为了「避免同一段字出现两次」，给 CoverImage 加了 `plain`（禁止画字），
 *   于是「默认封面 ⇒ 封面上显示书名作者」这条**需求本身**也一并失效了。
 *
 * ⇒ 现在规则只有一条，且收口在 `CoverImage.vue` 一个地方：
 *   **默认封面（无地址 / 加载失败 / 强制）⇒ 封面上画书名作者；有真图 ⇒ 封面上不画。**
 *   卡片下方的信息**恒显示**，与封面互不干涉。
 * 新增代码不要再引入「按封面有无决定要不要显示下方信息」这类联动 —— 那就是 #172 犯的错。
 */
