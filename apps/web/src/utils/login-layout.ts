/**
 * loginUi 行的 flex 布局计算（`#354` 排版修复）。
 *
 * ## 上游语义
 * Legado 把**所有登录行**（text / password / select / button / toggle / label）addView 进
 * **同一个 `FlexboxLayout`**（`SourceLoginDialog.kt:316/374/488/504/569`），每行按自己的
 * `RowUi.style()` → `FlexChildStyle.apply(view)` 决定占比：
 *
 * ```
 * data class FlexChildStyle(
 *   val layout_flexGrow: Float = 0F,
 *   val layout_flexBasisPercent: Float = -1F,   // ← 关键：小数比例，1 = 100%
 *   ...
 * )
 * ```
 *
 * 源作者就靠 `layout_flexBasisPercent` 排版。实测（禁漫天堂 20 行）：
 *   · `1`    → 整行（「点击切换分流」「每周必看索引」这类**分隔标题**，是 button 但占满行）
 *   · `0.25` → 一行 4 个（时间/阅读/最爱/收藏）
 *   · `0.2`  → 一行 5 个（重置/随机/+1/-1）
 *   · `0.3`  → 一行约 3 个
 *
 * ## 抽出来的原因
 * 本仓此前把 button 全抽进独立容器等宽平铺、`flexBasisPercent` **完全丢弃** ⇒ 源作者的排版
 * 意图丢失（用户报「按钮/输入框没有按 loginUi 排列」）。判据抽到这里，`.vue` 只做渲染，
 * 也便于加回归锁（判据写两处必然漂移，见项目铁律）。
 */

/** 只依赖用到的字段，避免前端重新声明 core 的完整 `LoginField` */
export interface LoginRowStyle {
  type: string;
  style?: { flexGrow?: number; flexBasisPercent?: number };
}

/**
 * 生成行的 inline flex 样式。
 *
 * - `flexBasisPercent` 是**小数比例**（`1` = 100%、`0.25` = 25%），CSS `flex-basis` 要百分比 ⇒ ×100。
 * - 同时设 `maxWidth`：`flex-basis` 只定**基准**，源里普遍还带 `flexGrow: 1`，
 *   不设上限时该行会被 grow 拉满整行（等于排版失效）。
 * - `<= 0`（上游默认 `-1F` = 不设置）⇒ 不写 basis，按内容宽（按钮）或整行（`isRowFull`）。
 */
export function loginRowStyle(f: LoginRowStyle): Record<string, string> {
  const pct = f.style?.flexBasisPercent;
  const out: Record<string, string> = {};
  const hasPct = typeof pct === 'number' && pct > 0;
  if (hasPct) out.flexBasis = `${pct * 100}%`;
  if (hasPct && pct < 1) out.maxWidth = `${pct * 100}%`;
  if (typeof f.style?.flexGrow === 'number') out.flexGrow = String(f.style.flexGrow);
  return out;
}

/**
 * 该行是否应按「整行」渲染（CSS 类 `.full` ⇒ `flex: 1 1 100%`）。
 *
 * 表单控件（text/password/select）与说明行（label）在源里**几乎都不带 style**，
 * 但它们必须独占一行 —— 「账号」和「密码」挤在 25% 宽里毫无意义。
 * 按钮相反：不带 style 时按内容宽排（一行能放几个放几个）。
 * 显式 `flexBasisPercent >= 1` 的按钮（分隔标题）也算整行。
 */
export function isLoginRowFull(f: LoginRowStyle): boolean {
  if (f.type === 'text' || f.type === 'password' || f.type === 'select' || f.type === 'label') return true;
  const pct = f.style?.flexBasisPercent;
  return typeof pct === 'number' && pct >= 1;
}
