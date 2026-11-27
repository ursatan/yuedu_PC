/**
 * **阅读样式预设**（`#223`）。
 *
 * ## 为什么要「按当前颜色集重定向」
 * 用户 2026-10-03 报「样式预设不生效」。真因不是预设坏了，而是：
 * **预设里的颜色是写死在「白天」槽的**（`bgStr` / `textColor` / `textAccentColor`），
 * 而当时界面处于**夜间或墨水屏主题** ⇒ 改的是另一套槽，界面**逐像素不变**。
 * 主观感受就是「我点了，什么也没发生」。
 *
 * 上游 Legado 正是这么处理的 —— `ReadBookConfig.kt:1075-1094` 的背景/文字写入：
 * ```kotlin
 * when {
 *   AppConfig.isEInkMode -> { bgStrEInk = bg }
 *   AppConfig.isNightTheme -> { bgStrNight = bg }
 *   else -> { bgStr = bg }
 * }
 * ```
 * ⇒ **只写当前模式对应的那一个槽**（换模式时另一套仍然是自己那套）。
 * 本函数就是这条规则的实现，属**按类别修能力**：所有预设、所有主题模式都一起受益，
 * 不是给某个预设打补丁。
 */
import type { ReadStyleOverride } from '@yuedu/core/contract';

/** 与 `styles/reader-theme.ts` 的 `ReaderColorSet` 同名同义（day / night / eink） */
export type PresetColorSet = 'day' | 'night' | 'eink';

/**
 * 每组颜色的三个槽，顺序固定为 [白天, 夜间, 墨水屏]。
 *
 * ★ `#249` **背景图片也成一组**（`bgImgPath` / `bgImgPathNight` / `bgImgPathEInk`）——
 * 它与背景色**同为「三套颜色集各一份」**，若不登记进 `COLOR_GROUPS`，就会被①「非颜色键原样透传」
 * 拷到**三套槽**上 ⇒ 「白天选的图出现在夜间」这种脏数据。
 */
const COLOR_GROUPS: ReadonlyArray<readonly [string, string, string]> = [
  ['bgStr', 'bgStrNight', 'bgStrEInk'],
  ['textColor', 'textColorNight', 'textColorEInk'],
  ['textAccentColor', 'textAccentColorNight', 'textAccentColorEInk'],
  ['bgImgPath', 'bgImgPathNight', 'bgImgPathEInk'],
];

const SET_INDEX: Record<PresetColorSet, number> = { day: 0, night: 1, eink: 2 };

/** 三个颜色组涉及的全部键（用来把「颜色键」从透传里剔掉） */
const COLOR_KEYS: ReadonlySet<string> = new Set(COLOR_GROUPS.flat());

/**
 * 把预设里的颜色**重定向到当前生效的颜色集**。
 *
 * · 只输出「非颜色键 + 当前槽的颜色」，**另外两槽原样缺席** ——
 *   ⚠️ 这里踩过一次：早先写的是 `out = { ...patch }` 再覆盖当前槽，结果**三套颜色全被写进去**
 *   （`patch` 里本来就带白天的值）⇒ 夜间点一次预设，白天也跟着变 ⇒ 用户白天的主题设置
 *   被悄悄改掉。**缺席 ≠ 清空**：`commit` 只写 patch 里有的键，所以「不写」就是「不碰」。
 * · 取值口径：**先取当前槽**；当前槽没给才**回退到白天的值**（不少预设只写一套色）。
 */
export function redirectPresetColors(patch: ReadStyleOverride, set: PresetColorSet): ReadStyleOverride {
  const idx = SET_INDEX[set] ?? 0;
  const out: Record<string, unknown> = {};
  // ① 非颜色键原样透传（字号、边距、透明度……与主题无关）
  for (const [k, v] of Object.entries(patch)) {
    if (!COLOR_KEYS.has(k)) out[k] = v;
  }
  // ② 三个颜色组：只写当前槽
  for (const keys of COLOR_GROUPS) {
    const isBgImg = keys[0] === 'bgImgPath';
    // ★★ `#249` **图片组必须区分「没给」与「明确无图」**：
    //   `null` 在颜色组里是「不覆盖」（缺席≠清空，见文件头纪律），
    //   但在图片组里是用户点了「清除背景图片」—— 那是**明确要求这槽无图**，必须写进去。
    //   判据用 `'bgImgPath' in patch` 而不是 `!== undefined`：合并语义里 `undefined` 才叫「没给」，
    //   `null` 是合法取值（与 `underlineColor: null` 同一套约定）。
    const raw = (patch as Record<string, unknown>)[keys[idx] as string];
    const has = keys[idx] in (patch as Record<string, unknown>)
      || (idx !== 0 && keys[0] in (patch as Record<string, unknown>));
    const v = raw ?? (idx === 0 ? undefined : (patch as Record<string, unknown>)[keys[0] as string]);
    if (isBgImg) {
      if (has) out[keys[idx] as string] = v ?? null; // 明确无图 ⇒ 写 null
      continue;
    }
    if (v === undefined || v === null) continue;
    out[keys[idx] as string] = v;
  }
  return out as ReadStyleOverride;
}
