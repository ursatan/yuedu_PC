/**
 * 高亮标记样式（上游 `HighlightStyle.kt` 的 Web 子集，`#146` 起用，`#256` 一期，`#258` 补齐高级通道）。
 *
 * ## 与「阅读样式的下划线」是**两套东西**（用户 `#256` 点名：独立一套配置，不与全局下划线混用）
 * · **阅读样式的下划线**（`GlobalReaderPrefs.underlineMode/underlineColor/underlineWidth/underlineDistance`）
 *   作用在 **整行正文 / 标题**上，是**全局**的（`#164` 移植，见 `utils/reader-style.ts`）。
 * · **高亮的样式**作用在**某一条高亮**上，存在 `BookHighlight.style`（**每条的 JSON**）。
 * 两者**互不读写**：这里只产出「绑到某个 `<span class="rd-hl">` 上的 CSS」，
 * 绝不去碰 `prefs.underline*`（上游同理：`TextLine.kt` 的全局下划线走另一条绘制通道）。
 *
 * ## 覆盖范围
 * `#256` 一期：底色（4 种形状）/ 文字色 / 粗体 / 斜体 / 下划线（线型+颜色+粗细+距离）/ 删除线（开关）。
 * `#258` 补齐（上游 `HighlightStyle.kt` 的 11 个字段全实现）：
 *   · `fillShape` 补 **`half`**（下半部分）/ **`baseline`**（基线下方细带）⇒ 6 种齐
 *   · `strike` 从「开关」扩成**带色**（上游 `Deco(color)`）
 *   · **`box`**（方框着重框）/ **`emphasis`**（着重号）/ **`shadow`**（文字阴影，含外发光）
 *   · **`fontFamily`**（见下：本仓扩展字段，与上游 `fontPath` 的差异）
 *
 * ## 上游字段对照（`HighlightStyle.kt:6-18`，11 个字段）
 * | 上游 | 本仓 | 说明 |
 * |---|---|---|
 * | `fill: Int` | `fill: string` | 上游 ARGB 整数，本仓用 CSS 颜色串 |
 * | `fillShape: FillShape?` | `fillShape` | 上游 6 种，`#258` 起**全实现** |
 * | `textColor: Int` | `textColor: string\|null` | `null` = 不改文字色（上游 `0`） |
 * | `bold` / `italic` | 同名 | 只做**开**（上游 `merge` 也是「一旦置上就不会被覆盖掉」） |
 * | `underline: Underline?` | `underline: {kind,color,width,distance}\|null` | 全实现 |
 * | `strike: Deco?` | `strike: Deco\|null` | `#258` 起带色（兼容一期落库的 `true`） |
 * | `box: Deco?` | `box: Deco\|null` | `#258` |
 * | `emphasis: Deco?` | `emphasis: Deco\|null` | `#258`，★ 与下划线**互斥**（上游 `TextColumn.kt:95`） |
 * | `shadow: Shadow?` | `shadow: {radius,dx,dy,color}\|null` | `#258` |
 * | `fontPath: String` | `fontFamily: string\|null` | ★★ **语义不同，刻意换名**，见下 |
 *
 * ★★ **`fontPath` → `fontFamily` 是本仓的显式偏离（不是「还没做」）**：
 *   上游 `fontPath` 装的是**本机字体文件路径**（`ChapterProvider.loadTypeface` 用 `Typeface.createFromFile`），
 *   且换字体后用 `preserveTextAdvance()`（缩放 `textScaleX`）**保持整行宽度不变** —— 因为 Android 是
 *   「预排好页再画」，换字体会**改变分页**。浏览器没有这个约束（CSS 换字体自动重排），也**没有**等价的
 *   「保持原宽度」手段。
 *   ⇒ Web 端对应物只能是**字体族名**（`font-family`）。用**不同的字段名**（不是复用 `fontPath`）是为了
 *   避免「同名不同义」的静默错误（与 `#249` 的 `bgImgPath` 同一决策）：一个装着 `fonts/楷体.ttf` 的
 *   `fontPath` 若被当成 `font-family` 值直接写进 CSS，会静默失效（且可能被当成 CSS 注入面）。
 *   ⚠️ 「上传字体文件」不在本条范围内（属 `#205`/`#206` 阅读样式那批）。
 *
 * ## 「跟随文字色」的表示
 * 上游 `Deco(color = 0)` / `Underline(color = 0)` 的 `0` 表示**用 fallbackColor（= 该段文字的实际颜色）**
 * （`HighlightDraw.kt:190,234,244`）。本仓统一写成 **`color: null`** ⇒ CSS 侧用 `currentColor`（同理）。
 */

/** 底色形状（上游 `HighlightStyle.FillShape`，6 种全收） */
export type HighlightFillShape = 'rectangle' | 'rounded' | 'pill' | 'marker' | 'half' | 'baseline';

/** 下划线线型（上游 `HighlightStyle.Kind`，5 种全收） */
export type HighlightUnderlineKind = 'solid' | 'wavy' | 'dashed' | 'dotted' | 'double';

/**
 * 下划线通道（上游 `HighlightStyle.Underline`，`HighlightStyle.kt:19-57`）。
 *
 * ★ `width <= 0` ⇒ **不画**（上游 `TextLine.kt:288` 的判据，不是「画一条最细的」）。
 * ★ `distance` = 下划线与基线之间的距离 ⇒ CSS 的 `text-underline-offset`。
 */
export interface HighlightUnderline {
  kind: HighlightUnderlineKind;
  /** 线色。`null` = 跟随文字色（上游 `color = 0`） */
  color?: string | null;
  /** 粗细 px。上游 `DEFAULT_WIDTH = 1`，范围 `0..10` */
  width?: number | null;
  /** 与基线的距离 px。上游 `DEFAULT_DISTANCE = 0`，范围 `0..30` */
  distance?: number | null;
}

/**
 * 单色装饰（上游 `HighlightStyle.Deco`，`HighlightStyle.kt:59`）——
 * `strike` / `box` / `emphasis` **三个通道共用**这一个形状（上游就是一个 `data class Deco(val color: Int)`）。
 */
export interface HighlightDeco {
  /** 颜色。`null` = 跟随文字色（上游 `color = 0` ⇒ `fallbackColor`） */
  color?: string | null;
}

/**
 * 文字阴影（上游 `HighlightStyle.Shadow`，`HighlightStyle.kt:61-79`）。
 *
 * ★ **外发光 = 把 `dx`/`dy` 归 0**：上游就是同一个 `setShadowLayer(radius, dx, dy, color)`
 *   （`HighlightDraw.kt:41`），没有单独的「glow」通道 ⇒ 本仓也不另外造一个字段。
 */
export interface HighlightShadow {
  /** 模糊半径。上游默认 `3`，`normalized()` 收进 `0..10` */
  radius?: number | null;
  /** 水平偏移。上游默认 `2`，收进 `-10..10` */
  dx?: number | null;
  /** 垂直偏移。上游默认 `2`，收进 `-10..10` */
  dy?: number | null;
  /** 颜色。上游默认 `0x80000000`（50% 黑） */
  color?: string | null;
}

export interface HighlightStyleView {
  /** 底色。null/undefined = 不画底色 */
  fill?: string | null;
  /** 底色形状。缺省 = `rectangle`（上游 `resolvedFillShape`） */
  fillShape?: HighlightFillShape;
  /** 文字色。null/undefined = 不改文字色 */
  textColor?: string | null;
  /** 下划线通道。null/undefined = 不画 */
  underline?: HighlightUnderline | null;
  /**
   * 删除线。`null` = 不画。
   * ⚠️ 类型含 `boolean` 只为**读得进 `#256` 落库的 `true`**（那时它是个开关）；
   *   凡是本文件**产出**的样式都已经是 `HighlightDeco`（见 `normalizeHighlightStyle`）。
   */
  strike?: boolean | HighlightDeco | null;
  /** 方框着重框（`#258`）。null = 不画 */
  box?: HighlightDeco | null;
  /** 着重号（`#258`）。null = 不画。★ 有下划线时不生效（上游互斥，见 {@link highlightStyleVars}） */
  emphasis?: HighlightDeco | null;
  /** 文字阴影 / 外发光（`#258`）。null = 不画 */
  shadow?: HighlightShadow | null;
  /** 字体族名（`#258`，本仓扩展字段，见文件头）。null = 跟随正文设置 */
  fontFamily?: string | null;
  bold?: boolean;
  italic?: boolean;
}

export const HIGHLIGHT_STYLE_EMPTY: HighlightStyleView = {
  fill: null,
  fillShape: 'rectangle',
  textColor: null,
  underline: null,
  strike: null,
  box: null,
  emphasis: null,
  shadow: null,
  fontFamily: null,
  bold: false,
  italic: false,
};

/**
 * 「没有样式」时**渲染**用的默认样式（上游 `visibleHighlightStyle()`，
 * `ReadBookActivity.kt:3017-3019`：`style?.takeUnless { it.isEmpty } ?: HighlightStyles.presets.first()`）。
 *
 * ★ 为什么默认**带**下划线（本仓与上游 presets[0] 的唯一有意差异）：
 *   本仓正文有三套底色（亮 / 暗 / 墨水屏，`#145`）。纯半透明底色在**墨水屏（白底）**上对比度不足，
 *   用户会以为「没划上」—— 这是 `#146` 加 `border-bottom` 的原始理由，`#256` 把它**显式化**
 *   成「下划线通道的一条实线」，于是它可被用户改掉，而不是一条拆不掉的硬编码边框。
 */
export const HIGHLIGHT_STYLE_DEFAULT: HighlightStyleView = {
  fill: 'rgba(255,193,7,.28)',
  fillShape: 'rounded',
  textColor: null,
  underline: { kind: 'solid', color: 'rgba(255,152,0,.85)', width: 1, distance: 1 },
  strike: null,
  box: null,
  emphasis: null,
  shadow: null,
  fontFamily: null,
  bold: false,
  italic: false,
};

/** 阴影默认值（上游 `HighlightStyle.Shadow` 的默认参数：radius 3 / dx 2 / dy 2 / 0x80000000） */
export const HIGHLIGHT_SHADOW_DEFAULT: { radius: number; dx: number; dy: number; color: string } = {
  radius: 3,
  dx: 2,
  dy: 2,
  color: 'rgba(0,0,0,.5)', // 0x80000000
};

/**
 * 字体族候选（**白名单**，见 `resolveFontFamily`）。
 *
 * ★ 上游是「本机字体文件路径」（`fontPath`），Web 端没有对应物 ⇒ 给系统字体族（含各家平台的
 *   中文别名，浏览器按序命中，命中不到就回落到通用族）。`value` 会**原样**写进 `font-family`。
 *
 * ⚠️ 定义在**文件前部**（而不是和别的「界面档位」一起放底部）：`resolveFontFamily` 在
 *   `parseHighlightStyle` 里被调用，而后者可能在任何时刻被调用 ⇒ 别让白名单落在 `const` 的
 *   暂时性死区（TDZ）后面。
 */
export const HIGHLIGHT_FONT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'serif', label: '衬线' },
  { value: 'sans-serif', label: '无衬线' },
  { value: 'monospace', label: '等宽' },
  { value: '"Songti SC","SimSun",serif', label: '宋体' },
  { value: '"Heiti SC","SimHei",sans-serif', label: '黑体' },
  { value: '"Kaiti SC","KaiTi","STKaiti",serif', label: '楷体' },
  { value: '"FangSong","STFangsong",serif', label: '仿宋' },
];

const FILL_SHAPES: readonly HighlightFillShape[] = ['rectangle', 'rounded', 'pill', 'marker', 'half', 'baseline'];
const UNDERLINE_KINDS: readonly HighlightUnderlineKind[] = ['solid', 'wavy', 'dashed', 'dotted', 'double'];

function isFillShape(v: unknown): v is HighlightFillShape {
  return typeof v === 'string' && (FILL_SHAPES as readonly string[]).includes(v);
}
function isUnderlineKind(v: unknown): v is HighlightUnderlineKind {
  return typeof v === 'string' && (UNDERLINE_KINDS as readonly string[]).includes(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 解析下划线通道，**兼容 `#146`~`#255` 落库的旧形态**。
 *
 * ★★ 旧数据里 `underline` 是**字符串**（`"wavy"`，见 `#146` 的实现）而新模型是对象 ——
 *   不做这层兼容，用户已有的高亮会在升级后**下划线整条消失**（`parseHighlightStyle` 会把它判成
 *   「不是字符串也不是合法对象 ⇒ null」），且**不报任何错**。这类「静默丢用户数据」是本仓反复踩的坑。
 */
function parseUnderline(v: unknown): HighlightUnderline | null {
  if (v === null || v === undefined) return null;
  // 旧形态：`"wavy"` / `"solid"` / …（字符串即线型）
  if (typeof v === 'string') {
    return isUnderlineKind(v) ? { kind: v, color: null, width: null, distance: null } : null;
  }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    kind: isUnderlineKind(o.kind) ? o.kind : 'solid',
    color: typeof o.color === 'string' ? o.color : null,
    width: numOrNull(o.width),
    distance: numOrNull(o.distance),
  };
}

/**
 * 解析单色装饰（`box` / `emphasis`），**兼容 `#256` 落库的 `strike: true`**。
 *
 * ★★ 兼容是必须的：`#256`~`#257` 期间「删除线」只是个**开关**（`strike: true`）⇒ 若这里只认对象，
 *   用户已有的删除线会在升级后**整条消失**（与 `underline` 从字符串变对象是同一个坑，第二次踩）。
 *   `true` ⇒ `{ color: null }`；序列化后就是新形态（**升级，不是丢数据**）。
 */
function parseDeco(v: unknown): HighlightDeco | null {
  if (v === true) return { color: null }; // 一期形态：只是一个开关
  if (v === false || v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  return { color: typeof (v as Record<string, unknown>).color === 'string' ? (v as Record<string, unknown>).color as string : null };
}

/**
 * 解析阴影，**兼容脏数据**。
 *
 * ★ `radius`/`dx`/`dy` 缺失或非法 ⇒ `null`（= 该字段用默认值，不是 0）。
 *   若把「缺失」当 0，`{ color: 'red' }` 这样一个只有颜色的阴影会变成**不可见**（radius 0 + dx/dy 0 时
 *   `setShadowLayer` 根本不画）⇒ 用户以为「开了阴影没反应」。
 */
function parseShadow(v: unknown): HighlightShadow | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    radius: numOrNull(o.radius),
    dx: numOrNull(o.dx),
    dy: numOrNull(o.dy),
    color: typeof o.color === 'string' ? o.color : null,
  };
}

/**
 * 兜底解析：脏数据一律回落到空样式，别让一条坏 JSON 把整章渲染炸掉。
 *
 * ⚠️ 新增字段时**必须同步这里**（`tests/highlight-style.test.ts` 的 ② 往返用例会红，提醒你）。
 */
export function parseHighlightStyle(json: string | null | undefined): HighlightStyleView {
  if (!json) return { ...HIGHLIGHT_STYLE_EMPTY };
  try {
    const o = JSON.parse(json) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...HIGHLIGHT_STYLE_EMPTY };
    return {
      fill: typeof o.fill === 'string' ? o.fill : null,
      fillShape: isFillShape(o.fillShape) ? o.fillShape : 'rectangle',
      textColor: typeof o.textColor === 'string' ? o.textColor : null,
      underline: parseUnderline(o.underline),
      strike: parseDeco(o.strike),
      box: parseDeco(o.box),
      emphasis: parseDeco(o.emphasis),
      shadow: parseShadow(o.shadow),
      fontFamily: resolveFontFamily(o.fontFamily),
      bold: !!o.bold,
      italic: !!o.italic,
    };
  } catch {
    return { ...HIGHLIGHT_STYLE_EMPTY };
  }
}

/**
 * 解析字体族：**只认白名单里的值**。
 *
 * ★ 为什么必须白名单（不是「检查里有没有 `url(`」）：`font-family` 的值会**直接拼进 CSS**，
 *   而这个样式来自「每条高亮的 JSON」⇒ 若放任意字符串进去，就是一条**用户数据 → CSS 注入**的通道
 *   （例如 `;} body{display:none` 这种）。白名单同时也解决「上游 `fontPath` 误写进来」的静默失效
 *   （一个文件路径不在白名单里 ⇒ 判为「没设置字体」，而不是写进 CSS 让浏览器去猜）。
 */
function resolveFontFamily(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return HIGHLIGHT_FONT_OPTIONS.some((o) => o.value === v) ? v : null;
}

/**
 * 「这条样式上有没有东西」—— 上游 `HighlightStyle.isEmpty`（`HighlightStyle.kt:91-94`）。
 * 判据是**逐通道**看，不是「JSON 是不是空串」：`{"bold":false}` 与 `''` 都算空。
 */
export function isHighlightStyleEmpty(s: HighlightStyleView | null | undefined): boolean {
  return !(
    s?.fill
    || s?.textColor
    || s?.underline
    || s?.strike
    || s?.box
    || s?.emphasis
    || s?.shadow
    || s?.fontFamily
    || s?.bold
    || s?.italic
  );
}

/** 渲染时用的样式：空的回落到 {@link HIGHLIGHT_STYLE_DEFAULT}（上游 `visibleHighlightStyle`） */
export function visibleHighlightStyle(s: HighlightStyleView | null | undefined): HighlightStyleView {
  return isHighlightStyleEmpty(s) ? { ...HIGHLIGHT_STYLE_DEFAULT } : (s as HighlightStyleView);
}

/** 归一化：把越界/非法值收进合法区间（上游 `normalized()`） */
export function normalizeHighlightStyle(s: HighlightStyleView): HighlightStyleView {
  const ul = s.underline;
  return {
    ...HIGHLIGHT_STYLE_EMPTY,
    ...s,
    fillShape: isFillShape(s.fillShape) ? s.fillShape : 'rectangle',
    underline: ul
      ? {
        kind: isUnderlineKind(ul.kind) ? ul.kind : 'solid',
        color: typeof ul.color === 'string' ? ul.color : null,
        width: clampOrNull(ul.width, 0, 10),
        distance: clampOrNull(ul.distance, 0, 30),
      }
      : null,
    strike: normalizeDeco(s.strike),
    box: normalizeDeco(s.box),
    emphasis: normalizeDeco(s.emphasis),
    shadow: normalizeShadow(s.shadow),
    fontFamily: resolveFontFamily(s.fontFamily),
  };
}

/** 归一化单色装饰：`true`/对象 ⇒ 对象；`false`/非法 ⇒ null */
function normalizeDeco(v: boolean | HighlightDeco | null | undefined): HighlightDeco | null {
  if (v === true) return { color: null };
  if (!v || typeof v !== 'object') return null;
  return { color: typeof v.color === 'string' ? v.color : null };
}

/**
 * 归一化阴影：上游 `Shadow.normalized()` 的区间**逐条对齐**
 * （`HighlightStyle.kt:68-70`：radius `0..10`、dx/dy `-10..10`；非法 ⇒ `0`）。
 *
 * ⚠️ 与上游的唯一差异：上游把「非法」收成 `0`，本仓把「字段缺失/非法」收成 **`null`（= 用默认值）**。
 *   理由：本仓的 `null` 已经承担「这个字段用户没设过」的语义（见 {@link parseShadow}），
 *   若把「缺失」收成 `0`，`{color:'red'}` 会变成全 0 的**不可见**阴影。
 */
function normalizeShadow(v: HighlightShadow | null | undefined): HighlightShadow | null {
  if (!v) return null;
  return {
    radius: clampOrNull(v.radius, 0, 10),
    dx: clampOrNull(v.dx, -10, 10),
    dy: clampOrNull(v.dy, -10, 10),
    color: typeof v.color === 'string' ? v.color : null,
  };
}

function clampOrNull(v: number | null | undefined, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(hi, Math.max(lo, v));
}

export function serializeHighlightStyle(s: HighlightStyleView): string {
  return JSON.stringify(normalizeHighlightStyle(s));
}

/** 阴影的三个数值字段（渲染与界面共用同一份默认值，避免两处漂移） */
export function shadowValue(s: HighlightShadow | null | undefined, key: 'radius' | 'dx' | 'dy'): number {
  const v = s?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : HIGHLIGHT_SHADOW_DEFAULT[key];
}

/**
 * 样式 → CSS（渲染时绑到 `<span class="rd-hl">` 上）。
 *
 * ## 三个如实说明的近似（不是 bug，是 CSS 表达力的边界）
 * ① `text-decoration-style` / `-thickness` / `-color` 是**整条装饰线共用**的
 *    ⇒ 同时开了「波浪下划线 + 删除线」时，删除线也会变成波浪（规范如此，无解）。
 *    ★★ `#258` 的**规避**：删除线**不走 `text-decoration`**，改用 `background-image` 画
 *    （见下）⇒ 删除线与下划线**彻底解耦**，颜色/线型互不干扰（上游 `HighlightDraw.kt` 本就是各画各的）。
 *    这条差异因此**只剩**「下划线自身」的线型/颜色/粗细三合一（那三者本来属于同一条线，无所谓）。
 * ② 形状靠 `border-radius`（+ `padding`）/ `linear-gradient` 近似，**不是上游的 `Path` 绘制**
 *    （上游 `HighlightGeometry` 是自绘路径，Web 端没有等价物）。
 * ③ `half` / `baseline` 两条色的**上下边界**是按 `content-area` 的**比例**近似的
 *    （上游按 `baseline ± textSize`/`dp` 精算再 clamp 到行高，见 `HighlightGeometry.fillBand`）。
 */
export function highlightStyleVars(s: HighlightStyleView | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (s?.textColor) out['color'] = s.textColor;

  const shape = isFillShape(s?.fillShape) ? s!.fillShape! : 'rectangle';

  /* ---- 背景层（`background-image`）-----------------------------------------
   * 为什么不用 `text-decoration` 画删除线：它和「下划线」共用 `text-decoration-color` /
   * `-style` / `-thickness` ⇒ 两条线必然同色同型（上游是各画各的）。
   * `background-image` 可以叠多层（**先写的在上层**），每层各有自己的 size/position ⇒ 解耦。
   * ⚠️ 顺序：删除线（上层）在前，底色层（下层）在后。
   */
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  const repeats: string[] = [];

  // ① 删除线（带色）：1.5px = 上游 `HighlightDraw.kt:185` 的 `defaultStrokeWidth`
  const strike = normalizeDeco(s?.strike);
  if (strike) {
    const c = strike.color ?? 'currentColor'; // 跟随文字色（上游 `fallbackColor`）
    images.push(`linear-gradient(${c}, ${c})`);
    sizes.push('100% 1.5px');
    positions.push('0 50%'); // 行盒中部（上游 `strikeY = baseline + (ascent+descent)/2`）
    repeats.push('no-repeat');
  }

  // ② 底色：`half` / `baseline` 两条形状**只铺一条带** ⇒ 只能用 `background-image`
  //    （`background-color` 永远铺满整个盒子）。其余形状照旧用 `background-color`。
  const fill = s?.fill ?? null;
  if (fill && (shape === 'half' || shape === 'baseline')) {
    // 上游 `fillBand`：HALF = `baseline - textSize*0.5` → `baseline + 2dp`；
    //                  BASELINE = `baseline + dp` → `baseline + 5dp`
    // 归一化到「行盒 0..1」后落在 ~30% / ~82%~96%（比例见文件头「三个近似」③）
    const stops = shape === 'half'
      ? `transparent 0 30%, ${fill} 30%`
      : `transparent 0 82%, ${fill} 82% 96%, transparent 96%`;
    images.push(`linear-gradient(to bottom, ${stops})`);
    sizes.push('100% 100%');
    positions.push('0 0');
    repeats.push('no-repeat');
  } else if (fill) {
    out['background-color'] = fill;
  }

  if (images.length) {
    out['background-image'] = images.join(', ');
    out['background-size'] = sizes.join(', ');
    out['background-position'] = positions.join(', ');
    out['background-repeat'] = repeats.join(', ');
  }

  const ul = s?.underline ?? null;
  // ★ `width <= 0` ⇒ 不画下划线（上游 `TextLine.kt:288`），不是「画一条 0px 的线」
  const drawUnderline = !!ul && (ul.width === null || ul.width === undefined || ul.width > 0);

  if (drawUnderline && ul) {
    out['text-decoration-line'] = 'underline';
    // 线型只有下划线这一通道有（删除线已改走 background-image）⇒ 不担心串型
    out['text-decoration-style'] = ul.kind;
    if (ul.color) out['text-decoration-color'] = ul.color;
    if (ul.width) out['text-decoration-thickness'] = `${ul.width}px`;
    if (ul.distance) out['text-underline-offset'] = `${ul.distance}px`;
  }

  /* ---- 方框着重框（`box`）-------------------------------------------------
   * 上游 `HighlightDraw.kt:243-261`：`drawRect(glyphTop+inset, glyphBottom-inset)`，
   * 线宽 1.5dp（= defaultStrokeWidth），**围住字形框**（不是整行高）。
   * Web 只能给 `<span>` 加 `border` ⇒ 用 `border` + 1px 水平 padding 近似；
   * ★ `box-decoration-break: clone` 是**必须的**：默认值 `slice` 在**跨行**时只画首尾两侧，
   *   而上游是**每行各画一个完整框**（按行内 run 画）。
   */
  const box = normalizeDeco(s?.box);
  if (box) {
    out['border'] = `1.5px solid ${box.color ?? 'currentColor'}`;
    out['border-radius'] = '2px';
    out['padding'] = '0 1px';
    out['box-decoration-break'] = 'clone';
    out['-webkit-box-decoration-break'] = 'clone';
  }

  /* ---- 着重号（`emphasis`）------------------------------------------------
   * ★★ **与下划线互斥**：上游 `TextColumn.kt:95` / `TextHtmlColumn.kt:101` 写的是
   *    `style?.takeIf { it.underline == null }?.emphasis` ⇒ **只要有下划线通道（哪怕 width=0 不画），
   *    着重号就不画**。这不是「优化」，是上游刻意的（两者都在字下方，会重叠）。
   * ⚠️ 判据是 **`underline == null`**，不是 `drawUnderline` —— 照抄上游语义，别「顺手改合理」。
   * 画法：CSS 原生 `text-emphasis`（上游是自绘圆点，半径 1.6dp、位置在每字下方中央）。
   */
  const emphasis = normalizeDeco(s?.emphasis);
  if (emphasis && !ul) {
    out['text-emphasis-style'] = 'dot';
    out['text-emphasis-color'] = emphasis.color ?? 'currentColor';
    // 中文着重号在**字下**（上游 `drawEmphasis` 的 y = 行高 - 半径 ⇒ 底部）
    out['text-emphasis-position'] = 'under right';
  }

  /* ---- 文字阴影 / 外发光（`shadow`）---------------------------------------
   * 上游 `HighlightDraw.kt:40-42`：`setShadowLayer(radius, dx, dy, color)`（直接对应 CSS `text-shadow`）。
   * ★ 外发光就是 `dx = dy = 0`（同一个通道，没有单独字段）。
   */
  const shadow = s?.shadow;
  if (shadow) {
    const r = shadowValue(shadow, 'radius');
    const dx = shadowValue(shadow, 'dx');
    const dy = shadowValue(shadow, 'dy');
    // ⚠️ `radius = 0` ⇒ Android 的 `setShadowLayer` **完全不画**（文档要求 radius > 0）；
    //    CSS 的 `text-shadow` 在 blur=0 时是**硬阴影**（仍会画）⇒ 两边不同。
    //    本仓保留 CSS 行为（可见的硬阴影），并把「想彻底关掉阴影」的入口留给开关本身（设为 null）。
    out['text-shadow'] = `${dx}px ${dy}px ${r}px ${shadow.color ?? HIGHLIGHT_SHADOW_DEFAULT.color}`;
  }

  /* ---- 字体（`fontFamily`，本仓扩展字段）----------------------------------
   * ★★ 这里**必须自己再过一遍白名单**（不能假设调用方已经归一化）：
   *   本函数是「用户数据 → CSS」的**最后一道关口**，而它的入参在真实路径上确实有
   *   **未归一化**的（`HighlightStyleDialog.vue` 的 draft、`visibleHighlightStyle()` 的回退值）。
   *   只靠 `parseHighlightStyle` 过滤 = 留一个「换个调用方就漏」的口子。
   */
  const ff = resolveFontFamily(s?.fontFamily);
  if (ff) out['font-family'] = ff;

  if (s?.bold) out['font-weight'] = '700';
  if (s?.italic) out['font-style'] = 'italic';
  return out;
}

/** 给 `<span>` 用的额外 class（形状 / 有没有某通道，方便 CSS 只写一次） */
export function highlightClass(s: HighlightStyleView | null | undefined): string[] {
  const out: string[] = [];
  if (s?.fill) out.push('rd-hl-has-fill');
  if (s?.underline) out.push('rd-hl-underline');
  if (normalizeDeco(s?.strike)) out.push('rd-hl-strike');
  if (normalizeDeco(s?.box)) out.push('rd-hl-box');
  if (normalizeDeco(s?.emphasis) && !s?.underline) out.push('rd-hl-emphasis');
  if (s?.shadow) out.push('rd-hl-shadow');
  if (s?.fontFamily) out.push('rd-hl-font');
  if (s?.bold) out.push('rd-hl-bold');
  if (s?.italic) out.push('rd-hl-italic');
  out.push(`rd-hl-shape-${isFillShape(s?.fillShape) ? s!.fillShape : 'rectangle'}`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 界面用的档位 / 调色板（上游 `HighlightColors.kt` + `HighlightStyles.kt`）
 * ------------------------------------------------------------------ */

/** 可选的底色形状（`#258` 起 6 种齐，与上游 `FillShape` 一一对应） */
export const HIGHLIGHT_FILL_SHAPES: ReadonlyArray<{ value: HighlightFillShape; label: string; hint?: string }> = [
  { value: 'rectangle', label: '矩形' },
  { value: 'rounded', label: '圆角' },
  { value: 'pill', label: '胶囊' },
  { value: 'marker', label: '马克笔' },
  { value: 'half', label: '下半', hint: '只铺文字下半（上游 HALF）' },
  { value: 'baseline', label: '基线带', hint: '基线下方一条细带（上游 BASELINE）' },
];

/** 界面里可选的下划线档位 */
export const HIGHLIGHT_UNDERLINE_OPTIONS: ReadonlyArray<{ value: HighlightUnderlineKind | null; label: string }> = [
  { value: null, label: '无' },
  { value: 'solid', label: '实线' },
  { value: 'wavy', label: '波浪' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' },
  { value: 'double', label: '双线' },
];

/**
 * 底色色板 —— **照抄上游 `HighlightColors.bg`**（`HighlightColors.kt:4-10`）的 5 个 ARGB。
 * 上游是 `0x80RRGGBB`（alpha = 0x80）⇒ 这里写成 `rgba(r,g,b,.5)`。
 */
export const HIGHLIGHT_BG_SWATCHES: readonly string[] = [
  'rgba(255,241,118,.5)', // 0x80FFF176
  'rgba(174,213,129,.5)', // 0x80AED581
  'rgba(79,195,247,.5)', // 0x804FC3F7
  'rgba(240,98,146,.5)', // 0x80F06292
  'rgba(255,183,77,.5)', // 0x80FFB74D
];

/** 文字色色板 —— 照抄上游 `HighlightColors.text`（`HighlightColors.kt:12-18`，不透明 5 色） */
export const HIGHLIGHT_TEXT_SWATCHES: readonly string[] = [
  '#d32f2f', // 0xFFD32F2F
  '#1976d2', // 0xFF1976D2
  '#388e3c', // 0xFF388E3C
  '#f57c00', // 0xFFF57C00
  '#7b1fa2', // 0xFF7B1FA2
];

/** 下划线色板（与文字色同源；另给一个「跟随文字色」= `null` 的入口由界面单独给） */
export const HIGHLIGHT_LINE_SWATCHES: readonly string[] = [
  '#e53935', // 0xFFE53935（上游 presets 的波浪线色）
  '#1e88e5', // 0xFF1E88E5（上游 presets 的实线色）
  '#9e9e9e', // 0xFF9E9E9E
  '#388e3c',
  '#f57c00',
];

/**
 * 删除线 / 方框 / 着重号的色板。
 *
 * ⚠️ 上游这 3 个通道**没有**色板（`HighlightColors` 只有 `bg` 与 `text` 两组），颜色由通用取色器给
 * （`HighlightStyleDialog.kt` 的 `pickHighlightColor`）。本仓没有「任意取色器」这条 UI 路径，
 * 所以给一组固定色 + 一个 `<input type=color>`（与底色/文字色同款做法）。
 * 前两色取自上游两条预设的实际用色（删除线 `0xFF9E9E9E`、着重号 `0xFFE53935`）。
 */
export const HIGHLIGHT_DECO_SWATCHES: readonly string[] = [
  '#9e9e9e', // 上游 presets[5] 删除线色 0xFF9E9E9E
  '#e53935', // 上游 presets[6] 着重号色 0xFFE53935
  '#1e88e5',
  '#388e3c',
  '#f57c00',
];

/**
 * 阴影色板（上游同样没有；默认色 = 上游 `Shadow.color` 的 `0x80000000`）。
 * 「外发光」常用亮色 ⇒ 第 2 个给半透明白（暗底上发光更像光）。
 */
export const HIGHLIGHT_SHADOW_SWATCHES: readonly string[] = [
  'rgba(0,0,0,.5)', // 0x80000000（上游默认）
  'rgba(255,255,255,.9)',
  '#e53935',
  '#1e88e5',
  '#ffd54f',
];

/**
 * 样式预设（上游 `HighlightStyles.presets`，`HighlightStyles.kt:8-25`，**7 条**）。
 *
 * `#258` 起与上游**逐条**对照：
 * ① 黄底（上游 `fill=0x80FFF176`，无 `fillShape`）—— ⚠️ 本仓用 `rounded`（上游是 RECTANGLE）
 * ② 蓝底圆角 `0x804FC3F7` + ROUNDED ✓ 一致
 * ③ 绿底 `0x8069F0AE` + **HALF** —— `#258` 起**归位**（`#256` 时因没实现 HALF 而临时用 `marker`）
 * ④ 红波浪 `Underline(WAVY, 0xFFE53935)` —— 本仓多给了宽度/距离（上游只用默认值）
 * ⑤ 蓝线加粗 `Underline(SOLID, 0xFF1E88E5)` + `bold` —— 本仓把线加粗到 2（label「加粗」才说得通）
 * ⑥ 灰删除线 `Deco(0xFF9E9E9E)` ✓ 一致（`#258` 起真的带色）
 * ⑦ 红着重号 `Deco(0xFFE53935)` —— `#258` 起可用
 * ⚠️ 上游没有「预设名」（界面上就是 7 个圆点），label 是本仓自己起的（给 Web 的按钮加可读文字）。
 */
export const HIGHLIGHT_PRESETS: ReadonlyArray<{ label: string; style: HighlightStyleView }> = [
  { label: '黄底', style: { ...HIGHLIGHT_STYLE_EMPTY, fill: 'rgba(255,241,118,.5)', fillShape: 'rounded' } },
  { label: '蓝底', style: { ...HIGHLIGHT_STYLE_EMPTY, fill: 'rgba(79,195,247,.5)', fillShape: 'rounded' } },
  { label: '绿底下半', style: { ...HIGHLIGHT_STYLE_EMPTY, fill: 'rgba(105,240,174,.5)', fillShape: 'half' } },
  { label: '红波浪', style: { ...HIGHLIGHT_STYLE_EMPTY, underline: { kind: 'wavy', color: '#e53935', width: 1, distance: 2 } } },
  { label: '蓝线加粗', style: { ...HIGHLIGHT_STYLE_EMPTY, bold: true, underline: { kind: 'solid', color: '#1e88e5', width: 2, distance: 2 } } },
  { label: '灰删除线', style: { ...HIGHLIGHT_STYLE_EMPTY, strike: { color: '#9e9e9e' } } },
  { label: '红着重号', style: { ...HIGHLIGHT_STYLE_EMPTY, emphasis: { color: '#e53935' } } },
];
