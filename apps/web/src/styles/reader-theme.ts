/**
 * 阅读主题（`#145`）—— `themeMode` **4 档** + 颜色 **3 套**。
 *
 * ## 为什么是「4 档 + 3 套」（**已在上游逐行核实，不是推断**）
 * 1. 档位来自 `arrays.xml:71-76` 的 `theme_mode`（4 项）：
 *    `Follow system` / `Bright mode` / `Dark mode` / `E-Ink mode`；
 *    存的是**字符串** `"0"`~`"3"`（`AppConfig.kt:52` `getPrefString(PreferKey.themeMode, "0")`）。
 * 2. 颜色只有 **3 套**，因为「跟随系统」是**不独立的一套** —— 它由系统日夜间接落到亮/暗：
 *    `ThemeConfig.getTheme()`（`ThemeConfig.kt:60-64`）=
 *    `isEInkMode -> EInk` / `isNightTheme -> Dark` / `else -> Light`。
 * 3. 阅读正文取色是**同一个三分支**，见 `ReadBookConfig.Config.curTextColor()`
 *    （`ReadBookConfig.kt:1008-1017`）：`isEInkMode -> …EInk` / `isNightTheme -> …Night` / `else -> 白天`。
 *    ⇒ 所以「跟随系统」直接复用 `prefers-color-scheme` 在**暖亮 / 暗**之间选，**不新增第四套颜色**。
 *
 * ## 颜色值出处
 * 逐条照抄上游 `ReadBookConfig.Config` 主构造器的 **Kotlin 默认值**（`ReadBookConfig.kt:870-885`）：
 * `bgStr #EEEEEE` / `bgStrNight #000000` / `bgStrEInk #FFFFFF`、
 * `textColor #3E3D3B` / `textColorNight #ADADAD` / `textColorEInk #000000`、
 * `textAccentColor #E53935` / `textAccentColorNight #FE4D55` / `textAccentColorEInk #000000`。
 *
 * ⚠️ 上游这些值在 `assets/defaultData/readConfig.json` 里还会被 6 条**命名主题**
 * （`微信读书` / `预设1`~`预设5`）覆盖；本仓这一期**不做命名主题**（见契约 `GlobalReaderPrefs` 的说明），
 * 因此用 `Config()` 这组 Kotlin 默认值作为唯一基准。
 *
 * ⚠️ 注意上游是 **ARGB**（例：`#ffc0edc6` = alpha `ff` + `c0edc6`）；`Config()` 这组默认值都是 6 位，
 * 但若日后接入命名主题，**必须先剥掉 alpha 前两位再交给 CSS**。
 */
import {
  emptyGlobalReaderPrefs,
  normaliseTipLineStyle,
  tipColorOf,
  tipDividerColorOf,
  tipTextSizeOf,
  type GlobalReaderPrefs,
  type ReadStyle,
} from '@yuedu/core/contract';
// ★ 复用界面主题那边**已有**的取色工具（`ui-theme.ts`），不在这里另写一份 hex 解析 ——
//   两份解析必然在「8 位 ARGB 怎么办」这类边界上漂移（`#163` 已经因为 8 位 alpha 踩过一次）。
import { withAlpha as withAlpha01 } from './ui-theme';

/** 与契约 `GlobalReaderPrefs.themeMode` 同一类型（这里再导一次，免得调用方到处 import 契约） */
export type ReaderThemeMode = GlobalReaderPrefs['themeMode'];

/** 实际生效的颜色集：跟随系统会先落到 day 或 night */
export type ReaderColorSet = 'day' | 'night' | 'eink';

/** 4 档，顺序与文案照抄 `arrays.xml:71-76` 的 `theme_mode` */
export const READER_THEME_MODES: ReadonlyArray<{
  value: ReaderThemeMode;
  label: string;
  hint: string;
}> = [
  { value: '0', label: '跟随系统', hint: '按系统的浅色/深色偏好自动切换（上游 theme_mode[0]）' },
  { value: '1', label: '亮色', hint: '上游 theme_mode[1] Bright mode' },
  { value: '2', label: '暗色', hint: '上游 theme_mode[2] Dark mode' },
  { value: '3', label: '墨水屏', hint: '上游 theme_mode[3] E-Ink mode（纯黑白，为墨水屏省刷新）' },
];

/**
 * 三套颜色的**默认值**（= `ReadBookConfig.kt:870-885` 的 `Config()` Kotlin 默认值）。
 *
 * ⚠️ **`#164` 起不再在这里硬编码 hex** —— 改为从契约的 {@link emptyGlobalReaderPrefs} **派生**。
 * 理由：`#164` 把这三套颜色做成了**用户可改的偏好**，于是「上游默认值」同时存在于契约（默认值）
 * 与此处（兜底常量）⇒ 两份必然漂移。派生后**只有契约一处**是真源。
 */
export const READER_COLORS: Record<ReaderColorSet, { bg: string; text: string; accent: string }> = (() => {
  const d = emptyGlobalReaderPrefs();
  return {
    day: { bg: d.bgStr, text: d.textColor, accent: d.textAccentColor },
    night: { bg: d.bgStrNight, text: d.textColorNight, accent: d.textAccentColorNight },
    eink: { bg: d.bgStrEInk, text: d.textColorEInk, accent: d.textAccentColorEInk },
  };
})();

/**
 * 某套配色下**实际生效**的三色（`#164`：从偏好里取，不再是常量）。
 *
 * ⚠️ 脏值回落用 {@link READER_COLORS} 的**同一槽**值（而不是统一回落到 day）——
 * 否则「只有夜间背景色写坏了」会让夜间文字落到亮底上，成了看不清而不是「颜色没生效」。
 */
export function readStyleColors(s: ReadStyle, set: ReaderColorSet): { bg: string; text: string; accent: string } {
  const d = READER_COLORS[set];
  const k = COLOR_KEYS[set];
  return {
    bg: cssHexColor(s[k.bg] ?? d.bg, d.bg),
    text: cssHexColor(s[k.text] ?? d.text, d.text),
    accent: cssHexColor(s[k.accent] ?? d.accent, d.accent),
  };
}

/**
 * 配色槽 → 字段名。
 *
 * ⚠️ **三个槽读的是三组不同的键**（上游 `Config` 就是 `bgStr` / `bgStrNight` / `bgStrEInk` 三个字段）。
 * 这一条踩过：第一版写成「无论哪个槽都读 `bgStr`/`textColor`」⇒ **夜间与墨水屏的配色设置全部失效**
 * （界面里改了夜间背景，夜里照样是白底），而且不报错。回归锁 `apps/web/tests/read-style.test.ts` ⑧。
 */
const COLOR_KEYS: Record<
  ReaderColorSet,
  { bg: keyof ReadStyle; text: keyof ReadStyle; accent: keyof ReadStyle }
> = {
  day: { bg: 'bgStr', text: 'textColor', accent: 'textAccentColor' },
  night: { bg: 'bgStrNight', text: 'textColorNight', accent: 'textAccentColorNight' },
  eink: { bg: 'bgStrEInk', text: 'textColorEInk', accent: 'textAccentColorEInk' },
};

/**
 * 按生效配色取**背景色**（**不含** `bgAlpha`）。
 *
 * ★★ `#250` **刻意不再混入 `bgAlpha`** —— 此前它内部调了 `bgWithAlpha(c, s.bgAlpha)`，
 *   而上游 `PageView.kt:343` 的 alpha 是给**背景图层**（`ReadBookConfig.bg`）的，
 *   有背景图时**底色不参与**（`LayerDrawable` 的第一层 `bgMeanColor` 恒不透明，`:329-336`）。
 *   旧实现把 alpha 混进底色 ⇒ 「拖背景透明度，底色在淡、图纹丝不动」。
 *   ⇒ 现在这里只给**纯底色**；alpha 的落点由 store 的 `readerBackdropVars` 决定
 *     （有图 → 淡图片层；无图 → 淡底色）。
 * ⚠️ 保留这个导出而不是删掉：它是「当前槽的底色」这一语义的**唯一**取法，
 *   栏位底色（`#250` 的 `--rd-bar-bg`）也走它。
 */
export function bgColorOf(s: ReadStyle, set: ReaderColorSet): string {
  return readStyleColors(s, set).bg;
}

/** 按生效配色取**正文色** */
export function textColorOf(s: ReadStyle, set: ReaderColorSet): string {
  return readStyleColors(s, set).text;
}

/** 按生效配色取**强调色** */
export function accentColorOf(s: ReadStyle, set: ReaderColorSet): string {
  return readStyleColors(s, set).accent;
}

/**
 * 标题色：`titleColor === null` = **跟随正文色**。
 *
 * 上游判据：`ReadBookConfig.kt:527` `titleColor.takeIf { it != 0 } ?: textColor`
 * —— 本仓把「未设置」直接表达为 `null`（不移植那个 `0` 哨兵，也不移植 int 颜色）。
 */
export function titleColorOf(s: ReadStyle, set: ReaderColorSet): string {
  const c = s.titleColor;
  return c == null ? textColorOf(s, set) : cssHexColor(c, textColorOf(s, set));
}

/** 下划线色：`underlineColor === null` = **跟随正文色**（`TextLine.kt:50-54` 的取色分支） */
export function underlineColorOf(s: ReadStyle, set: ReaderColorSet): string {
  const c = s.underlineColor;
  return c == null ? textColorOf(s, set) : cssHexColor(c, textColorOf(s, set));
}

/**
 * 下划线样式的**档位表** —— 取值与文案照抄上游 `ReadBookConfig.kt:41-47`。
 *
 * ⚠️ `6`（`DOUBLE_DASHED` 双虚线）**CSS 没有对应值** ⇒ `css` 给 `dashed` 并在文案里明说，
 * 界面选项里也**不提供**这一档（见 {@link UNDERLINE_MODE_OPTIONS}）。宁可少一档，不要静默画成别的。
 */
export const UNDERLINE_MODES: ReadonlyArray<{ value: number; label: string; css: string | null }> = [
  { value: 0, label: '关闭', css: null },
  { value: 1, label: '实线', css: 'solid' },
  { value: 2, label: '虚线', css: 'dashed' },
  { value: 3, label: '点线', css: 'dotted' },
  { value: 4, label: '双线', css: 'double' },
  { value: 5, label: '波浪线', css: 'wavy' },
  { value: 6, label: '双虚线（CSS 无对应，按虚线渲染）', css: 'dashed' },
];

/** 界面里可选的下划线档位（**不含 6**，理由见 {@link UNDERLINE_MODES}） */
export const UNDERLINE_MODE_OPTIONS = UNDERLINE_MODES.filter((m) => m.value !== 6);

/**
 * 下划线 → CSS 分量；**返回 `null` 表示不画**。
 *
 * 生效条件照抄上游 `TextLine.kt:277-290` 的 `activeUnderlineMode()`：
 * `mode != 0` **且** `underlineWidth > 0` **且** 该部分被 `underline*Enabled` 放行。
 *
 * ⚠️ **不返回 `text-decoration` 整串**，而是拆成三个分量 —— 因为 CSS 的 `text-decoration`
 * 简写**不接受 `text-underline-offset`**，把它塞进简写会被整条判为非法（**静默失效**）。
 * 于是调用方这样组：`text-decoration: underline <style> <thickness> <color>` + 单独一条 `text-underline-offset`。
 *
 * ⚠️ 单位：上游 `underlineWidth` / `underlineDistance` 是 **dp**（`TextLine.kt:49,56` 里
 * `.dpToPx()`），Web 直接当 px 用（与字号同一套近似，理由见 {@link readerContentVars}）。
 */
export function underlineOf(
  s: ReadStyle,
  part: 'body' | 'title',
): { style: string; thickness: string; offset: string } | null {
  const mode = Number(s.underlineMode ?? 0);
  const m = UNDERLINE_MODES.find((x) => x.value === mode);
  if (!m || m.css === null) return null;
  if (!(Number(s.underlineWidth) > 0)) return null;
  const enabled = part === 'title' ? s.underlineTitleEnabled !== false : s.underlineBodyEnabled !== false;
  if (!enabled) return null;
  return {
    style: m.css,
    thickness: `${clampNum(s.underlineWidth, 0.5, 8, 1)}px`,
    offset: `${clampNum(s.underlineDistance, -8, 24, 4)}px`,
  };
}

/**
 * 「界面里的下划线档位」如果存的是 `6`（旧备份/上游数据）—— 界面上不提供该档，
 * 但要能**如实显示**成「6」而不是静默跳回 0。返回 null 表示落在已知档位上。
 */
export function underlineModeLabel(v: unknown): string | null {
  const m = UNDERLINE_MODES.find((x) => x.value === Number(v));
  return m ? m.label : `未知档位 ${String(v)}`;
}

/** 是不是合法的 `themeMode`（用于把脏值挡在门外，见 {@link normalizeThemeMode}） */
export function isReaderThemeMode(v: unknown): v is ReaderThemeMode {
  return v === '0' || v === '1' || v === '2' || v === '3';
}

/**
 * `themeMode` → 实际颜色集。
 * `prefersDark` 由调用方从 `matchMedia('(prefers-color-scheme: dark)')` 传入
 * （只在 `mode === '0'` 时用得上，对应上游的 `AppConfig.isNightTheme`）。
 */
export function readerColorSet(mode: ReaderThemeMode, prefersDark: boolean): ReaderColorSet {
  if (mode === '1') return 'day';
  if (mode === '2') return 'night';
  if (mode === '3') return 'eink';
  return prefersDark ? 'night' : 'day'; // '0' 跟随系统 ⇒ 上游就是「不新增一套」
}

/**
 * 把**旧值**（`'dark'` / `'sepia'`）或任何脏值规范成 `themeMode`。
 *
 * 迁移规则（`#145` 定，已写进契约的映射表）：
 *  · `'dark'` → `'2'` 暗色；
 *  · `'sepia'` → `'1'` 亮色 —— ⚠️ **不是等价映射**：上游 `themeMode` 只有 4 档、**没有 sepia**，
 *    我们不发明第 5 档 ⇒ 旧的暖米色观感会变成亮色。上游 `预设2`（`bgStr #DDC090` / `textColor #3E3422`）
 *    才是那个暖色档，等做「命名主题」时再找回来。
 *  · 其它 → `'0'`（跟随系统，即契约默认值）。
 */
export function normalizeThemeMode(v: unknown): ReaderThemeMode {
  if (isReaderThemeMode(v)) return v;
  if (v === 'dark') return '2';
  if (v === 'sepia') return '1';
  return '0';
}

/** 排版项（契约 `#145` 那 9 个；`ReadStyle` 是它的超集，`#164` 起传后者也行） */
export type ReaderTypography = Pick<
  GlobalReaderPrefs,
  | 'textSize'
  | 'titleSize'
  | 'textBold'
  | 'letterSpacing'
  | 'lineSpacingExtra'
  | 'paragraphSpacing'
  | 'paragraphIndent'
  | 'textFont'
  | 'titleFont'
>;

/**
 * 把排版项换算成一组 CSS 自定义属性（挂在 `.rd-content` 上，具体样式在组件 CSS 里消费）。
 *
 * ⚠️ 单位换算是**有意近似**，每条都写了理由：
 *  · `textSize` —— Android `TextPaint.textSize` 本来就是 px 语义 ⇒ 直接 `px`。
 *  · `lineSpacingExtra` —— 上游是「**行高之外的增量**」（`Config.kt:893`）⇒ CSS 写
 *    `calc(1em + 12px)`（`1em` 即字号本身），**不要**当成 `line-height` 的数值。
 *  · `letterSpacing` —— Android 是 **em** ⇒ CSS `em`。
 *  · `paragraphIndent` —— 上游是**字符串**（默认两个全角空格），直接前置到段落文本；
 *    Web 用 CSS `text-indent` 等价表达（首次缩进、不污染复制出来的文本）。
 *    长度按 `em` 计（CJK 全角字宽 ≈ 1em）⇒ 2 个全角空格 → `2em`。
 *  · `textBold` —— 0/1/2 三档映射到 CSS `font-weight`，**不是布尔**。
 */
export function readerContentVars(p: ReaderTypography & Partial<ReadStyle>): Record<string, string> {
  const vars: Record<string, string> = {
    '--rd-fs': `${clampNum(p.textSize, 8, 80, 20)}px`,
    '--rd-lh': `calc(1em + ${clampNum(p.lineSpacingExtra, 0, 200, 12)}px)`,
    '--rd-ls': `${clampNum(p.letterSpacing, -0.2, 2, 0.1)}em`,
    '--rd-ps': `${clampNum(p.paragraphSpacing, 0, 200, 2)}px`,
    '--rd-indent': `${Math.max(0, Math.min(8, String(p.paragraphIndent ?? '').length))}em`,
    '--rd-fw': String(boldWeight(p.textBold)),
  };
  // 字体：空串 = 系统默认（上游语义）⇒ 不写这个变量，让 CSS 用继承值
  const textFont = String(p.textFont ?? '').trim();
  if (textFont) vars['--rd-font'] = cssFontFamily(textFont);
  // 标题字体：上游「空 = 跟随正文字体」⇒ 也回落到正文那一条
  const titleFont = String(p.titleFont ?? '').trim();
  vars['--rd-title-font'] = titleFont ? cssFontFamily(titleFont) : textFont ? cssFontFamily(textFont) : 'inherit';
  // 标题字号：上游 `titleSize = 0` 是「不单独设置」的哨兵（`Config.kt:897`）⇒ 跟随正文
  const titleSize = Number(p.titleSize);
  vars['--rd-title-fs'] = titleSize > 0 ? `${clampNum(titleSize, 8, 120, titleSize)}px` : 'inherit';

  /* ---------------- `#164` 新增：正文边距 / 标题 / 下划线 ----------------
   * 以下每一项都是「**没给就不写这个变量**」，让 CSS 的 `var(--x, 默认)` 生效 ——
   * 这样「阅读器拿到的是旧的全局对象（缺新键）」时仍能正确渲染，不会把版面打崩。
   */
  if (p.paddingTop !== undefined) vars['--rd-pt'] = `${clampNum(p.paddingTop, 0, 200, 6)}px`;
  if (p.paddingRight !== undefined) vars['--rd-pr'] = `${clampNum(p.paddingRight, 0, 200, 16)}px`;
  if (p.paddingBottom !== undefined) vars['--rd-pb'] = `${clampNum(p.paddingBottom, 0, 200, 6)}px`;
  if (p.paddingLeft !== undefined) vars['--rd-pl'] = `${clampNum(p.paddingLeft, 0, 200, 16)}px`;

  if (p.titleMode !== undefined) {
    const mode = Number(p.titleMode);
    // 0 居左 / 1 居中 / 2 隐藏 / 3 居右（`Config.kt:896`；`TextChapterLayout.kt:165` 用 `!= 2` 判要不要画）
    vars['--rd-title-display'] = mode === 2 ? 'none' : 'block';
    vars['--rd-title-align'] = mode === 1 ? 'center' : mode === 3 ? 'right' : 'left';
  }
  if (p.titleTopSpacing !== undefined) vars['--rd-title-mt'] = `${clampNum(p.titleTopSpacing, 0, 200, 0)}px`;
  if (p.titleBottomSpacing !== undefined) vars['--rd-title-mb'] = `${clampNum(p.titleBottomSpacing, 0, 200, 0)}px`;
  if (p.titleLineSpacingExtra !== undefined) {
    // ★ 上游是**乘数**不是像素：`ChapterProvider.kt:308-309`
    //   `(100 + v.coerceIn(-20, 30)) / 100f` ⇒ 0.8 ~ 1.3 倍（相对正文字号算出来的行高）。
    const mult = (100 + clampNum(p.titleLineSpacingExtra, -20, 30, 0)) / 100;
    vars['--rd-title-lh'] = `calc(var(--rd-lh) * ${mult})`;
  }
  return vars;
}

/**
 * 下划线 → CSS 变量（`#164`）。
 *
 * ⚠️ 与 {@link readerContentVars} **分开**是因为它需要**生效配色**（颜色要按当前是白天/夜间/墨水屏取），
 * 而排版量本身与配色无关。调用方：`stores/reader.ts` 的 `readerStyleVars`（**唯一装配点**）。
 *
 * 为什么拆成 4 个变量而不是一条 `text-decoration` 简写：**CSS 的简写不接受 `text-underline-offset`**，
 * 塞进去整条会被判非法而**静默失效**（最坏的一种失败：设置看起来生效了、界面没变）。
 */
export function readerUnderlineVars(s: ReadStyle, set: ReaderColorSet): Record<string, string> {
  const color = underlineColorOf(s, set);
  const out: Record<string, string> = {};
  for (const part of ['body', 'title'] as const) {
    const u = underlineOf(s, part);
    const key = part === 'title' ? 'title' : 'body';
    out[`--rd-ul-${key}`] = u ? `underline ${u.style} ${u.thickness} ${color}` : 'none';
    out[`--rd-ul-${key}-offset`] = u ? u.offset : '0px';
  }
  return out;
}

/**
 * **页眉 / 页脚的 CSS 变量**（`#221`，对齐 `ReadBookConfig.kt:944-946`）。
 *
 * 与 {@link readerContentVars} 分开的理由同下划线那组：它需要**生效配色**
 * （`tipColor = null` 表示「跟随正文色」，而正文色本身随白天/夜间/墨水屏变）。
 */
export function readerTipVars(s: ReadStyle, set: ReaderColorSet): Record<string, string> {
  return tipVarsOf(s, set, 'header');
}

/**
 * `#235` **按页眉/页脚分别**出 CSS 变量（字号 / 文字色 / 分隔线色 / 线型）。
 *
 * ## 为什么要两个函数
 * 上游 `ReadBookConfig.kt:944-946` 只有**一份** `tipTextSize` / `tipColor` / `tipDividerColor`
 * ⇒ 页眉页脚被迫共用（用户 2026-10-03：「字号，文字颜色，分隔线颜色应可独立设置；现状：被合并了」）。
 * `readerTipVars` 保留为**页眉口径**的别名（不破坏既有调用方），
 * 新代码一律用带 `zone` 的 `tipVarsOf`。
 *
 * ## 回落链（老配置行为一字不变）
 * 独立字段（`headerTextSize` 等，`:235` 新增，默认 `null`）→ 上游共用字段 → 正文色。
 * 回落逻辑放在契约的 `tipTextSizeOf` / `tipColorOf` / `tipDividerColorOf` 里（可单测）。
 *
 * ## 线型（`#235`，上游只有实线）
 * 不走 `border-style`：虚线/点线用 `border-style` 够，但**双线与波浪线**要额外的
 * 「线在哪、多厚」信息 ⇒ 统一输出 `--rd-tip-line-style`（页眉下边 / 页脚上边用）
 * 与 `--rd-tip-line-image`（`double`/`wave` 时是一条 `background-image`，用 `repeating-linear-gradient` 生成）。
 * 渲染层 `.rd-tip-line` 负责在「有 line-style」时切到 `background-image` 模式。
 */
export function tipVarsOf(s: ReadStyle, set: ReaderColorSet, zone: 'header' | 'footer'): Record<string, string> {
  const text = textColorOf(s, set);
  // 上游把 tipTextSize 夹在 5–50（`ReadTipConfig.kt:11-12`）；独立字段同样夹
  const size = tipTextSizeOf(s, zone);
  const color = tipColorOf(s, zone);
  const divider = tipDividerColorOf(s, zone);
  const lineStyle = normaliseTipLineStyle(zone === 'header' ? s.headerLineStyle : s.footerLineStyle);
  const dividerColor = divider ? cssHexColor(divider, text) : text;
  return {
    '--rd-tip-fs': `${size}px`,
    '--rd-tip-color': color ? cssHexColor(color, text) : text,
    // `tipDividerColor`：上游默认 -1 = 跟随正文色（`-1` 与 `0` 在这里同义）⇒ 本仓用 null 统一表达
    '--rd-tip-divider': dividerColor,
    '--rd-tip-line-style': lineStyle,
    // 双线/波浪线用 background-image 画；实线/虚线/点线留空（走 border-style，避免双线叠成 3 条）
    '--rd-tip-line-image':
      lineStyle === 'double' || lineStyle === 'wave' ? tipLineImage(lineStyle, dividerColor, zone) : 'none',
  };
}

/**
 * 双线 / 波浪线的 `background-image`（CSS 生成，**不引图片资源**）。
 *
 * · 双线：两条 1px 实线 + 中间 1px 间隙，总高 3px（读起来不挤）
 * · 波浪线：`repeating-linear-gradient` 造 2px 一个的斜纹，视觉上接近 SVG 的锯齿波
 *
 * ⚠️ 方向按「朝向正文」理解（与 `showHeaderLine`/`showFooterLine` 的线位一致）：
 *   页眉线在**下**边 ⇒ 波浪在下方 ⇒ 用 `to top` 让波峰朝正文一侧，页脚反之。
 */
function tipLineImage(style: 'double' | 'wave', color: string, zone: 'header' | 'footer'): string {
  if (style === 'double') {
    return `linear-gradient(${color} 0 0), linear-gradient(${color} 0 0)`;
  }
  const dir = zone === 'header' ? 'to top' : 'to bottom';
  return `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`;
}

/** `textBold`：0 正常 / 1 粗体 / 2 细体（`ReadBookConfig.kt:890`） */
export function boldWeight(textBold: unknown): number {
  if (Number(textBold) === 1) return 700;
  if (Number(textBold) === 2) return 300;
  return 400;
}

/**
 * 把上游的「字体名」变成可用的 CSS `font-family`。
 * ⚠️ 上游存的是**用户设备上的字体名**（`Config.textFont`），浏览器里大概率没有那个字体；
 * 因此**总是追加一串通用回退**，避免整段文字变成衬线/方块。
 * 字体名里可能带引号或逗号（用户直接粘 font-family 串）⇒ 原样透传 + 回退兜底。
 */
export function cssFontFamily(name: string): string {
  const n = name.trim();
  // 已经像一整串 font-family（含逗号）就原样用，只补回退
  return `${n}, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
}

/**
 * 颜色串归一：只认 `#RGB` / `#RRGGBB`，其余一律回落到给定值。
 *
 * ⚠️ 这里**必须严格**：颜色来自服务端偏好（用户可粘贴任意文本），而**非法 CSS 值会让整条声明被丢弃**
 * ——那正是「设置看起来存了、界面没变」的经典成因。宁可回落到主题默认色，也不要写出一条没人执行的声明。
 */
function cssHexColor(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return fallback;
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  return s.toLowerCase();
}

/**
 * ★★ `#250` 已删除 `bgWithAlpha`（背景色 + 透明度 → `rgba()`）。
 *
 * ## 为什么删而不是留
 * 它唯一的调用方是同文件的 {@link bgColorOf}，而那个混色**就是本次 bug 的根因**：
 * `bgAlpha` 在上游只作用于**背景图层**（有图时 = 图片，底色恒不透明），
 * 混进底色会让「拖透明度 → 底色在淡、图纹丝不动」。
 * ⇒ 底色现在**恒不透明**，alpha 的落点改由 store 的 `readerBackdropVars` 决定
 *   （有图 → 淡 `.se-panel::before` 那一层；无图 → 淡底色），与上游同构。
 * ⚠️ 若将来又要「纯色背景 + 半透明」，请在**调用点**显式调 `ui-theme.withAlpha`，
 *   不要在取色函数里偷偷混 —— 那样就又分不清「这个色本身淡」还是「背景层淡」。
 */

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  // ★ 必须先把「没给」与「数值 0」分开：`Number(null) === 0`、`Number('') === 0`，
  //   它们会被 clamp 到**下限**（如字号 8px）—— 看起来像「尊重用户设置」，实际是静默改小。
  //   显式 null 在 JSON 往返里很常见（服务端 merge 后可能出现）。
  if (v === null || v === undefined || typeof v === 'boolean') return fallback;
  if (typeof v === 'string' && v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
