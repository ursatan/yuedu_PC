/**
 * **`#221`：阅读界面顶部工具栏的「固定 / 收进更多」配置**。
 *
 * ## 为什么是 localStorage 而不是服务端契约
 * 项目约定（`project-status.md` 第 4 条）：**契约里没有对应实体的偏好一律留本地**，
 * 硬塞进服务端就是造第二份真相源。Legado 上游也没有「工具栏按钮显隐」这个设置
 * （它是 Web 端因为按钮比手机多才需要的）⇒ 这里没有上游字段可对齐，落 localStorage。
 *
 * ## 语义（用户 2026-10-03 的原话）
 * 「按钮较多，支持配置各按钮显示/隐藏，**不显示的按钮收到更多（按钮）**」
 * ⇒ **不是「消失」**：关掉只是从标题栏挪进「更多」菜单，功能一个不少。
 * 这样用户永远不会遇到「我把按钮藏了，现在找不到它了」。
 */
export type ReaderToolId =
  | 'back' | 'switch' | 'refresh' | 'readAloud' | 'search' | 'cache' | 'style'
  | 'replace' | 'effectiveReplaces'
  // `#261` 手动规则集（上游 `menu_manual_replace_rule`）
  | 'manualRules'
  // `#262` 高亮规则（上游 `ReaderMenuItem.menu_highlight_rule`，`ReaderMenuItem.kt:19`）
  | 'highlightRules';

export interface ReaderToolDef {
  id: ReaderToolId;
  label: string;
  icon: string;
}

/**
 * 顺序 = 「更多」菜单里的顺序。★ 与标题栏固定显示的 4 个（目录/最大化/更多/关闭）不重叠。
 *
 * ★ 这份名单**只属于正文页**（用户 2026-10-03 的约束）：详情页的「刷新详情」是**另一个按钮**，
 *   既不收进「更多」，也不出现在「按钮显示设置」里。
 *   「换源」是**两页共用**的能力：详情页固定直接显示，正文页这一枚由本名单的显隐配置管。
 */
export const READER_TOOLS: ReadonlyArray<ReaderToolDef> = [
  { id: 'back', label: '返回详情', icon: '←' },
  { id: 'switch', label: '换源', icon: '⇄' },
  { id: 'refresh', label: '刷新正文', icon: '↻' },
  { id: 'readAloud', label: '朗读', icon: '🔊' },
  { id: 'search', label: '搜索', icon: '🔍' },
  { id: 'cache', label: '缓存', icon: '⬇' },
  { id: 'style', label: '样式', icon: '⚙' },
  /**
   * `#254`：**替换（净化）启闭开关**（用户 2026-10-04 第 5 点：放在「更多」按钮组里）。
   *
   * ★ 这一枚与其它按钮**性质不同**：它是**开关**（有开/关状态），不是「点了执行一次」的动作
   * ⇒ 菜单里要显示当前是「开」还是「关」（见 `ReaderOverlay` 的 `.rd-more-state`）。
   *
   * ★ `#260` 起它写的是**本书级**开关（上游 `Book.ReadConfig.useReplaceRule`，`Book.kt:499`）
   * —— 用户 2026-10-04 明确「阅读界面→更多→替换净化开关：就应该是本书级替换净化开关」。
   * 全局默认仍在 设置 → 净化（`GlobalReaderPrefs.replaceEnableDefault`）；
   * 本书值 `null` = 跟随全局。判据只有一份：`utils/replace-rules.ts` 的 `useReplaceRuleFor()`。
   */
  { id: 'replace', label: '替换净化', icon: '⇆' },
  /**
   * `#260`：**起效替换**（用户 2026-10-04：「增加：起效替换按钮，点击弹出本书起效的替换列表，
   * 可关闭起效，可点击弹出替换规则编辑对话框」）。
   *
   * 对齐上游 `EffectiveReplacesDialog`（阅读菜单 `menu_effective_replaces`）：列出**当前章
   * 真正改动了正文的**规则（`TextChapter.effectiveReplaceRules`），点条目去编辑、点 ✕ 关闭起效。
   * ⚠️ 上游的 ✕ 是把该条**全局规则**置为 `isEnabled = false`（不是「本书不用」），照抄。
   */
  { id: 'effectiveReplaces', label: '起效替换', icon: '≡' },
  /**
   * `#261` **手动规则集**（上游 `menu_manual_replace_rule`）。
   *
   * ⚠️ 上游它是与「启用替换」**互斥**的第二个模式（全局开关 `AppConfig.manualReplaceRule`
   * 控制显隐）；本仓菜单空间有限且要「按钮藏了也能找到」⇒ **两项都收在「更多」里**，
   * 模式开关放到对话框顶部（同一处能开能勾选，比藏在别处更好找）。
   */
  { id: 'manualRules', label: '手动规则集', icon: '☰' },
  /**
   * `#262` **高亮规则**（上游 `menu_highlight_rule`，`ReaderMenuItem.kt:19`）。
   * 按规则自动高亮命中的文字 —— 管理列表 + 导入/导出，编辑器对齐上游 HighlightRuleEditDialog。
   */
  { id: 'highlightRules', label: '高亮规则', icon: '✎' },
];

const STORE_KEY = 'yuedu.reader.toolbar.pins';

/** 默认放标题栏的：刷新 / 朗读 / 搜索 / 样式（最常点）；其余收进「更多」 */
const DEFAULT_PINS: Record<ReaderToolId, boolean> = {
  back: false,
  switch: false,
  refresh: true,
  readAloud: true,
  search: true,
  cache: false,
  style: true,
  // `#254`：默认**收进「更多」**（用户要的就是「放在更多按钮组里」），需要常显可自己去设置里置顶
  replace: false,
  // `#260`：起效替换同理，默认收进「更多」（它是一个「查看当前状态」的入口，不必常驻标题栏）
  effectiveReplaces: false,
  manualRules: false, // `#261`：默认收进「更多」
  highlightRules: false, // `#262`：默认收进「更多」
};

/**
 * 读取当前配置。
 *
 * ⚠️ **缺键要补默认值**，不能只回 `{ ...JSON.parse(...) }`：老用户存的是旧名单
 * （那时还没有 `cache` 这个按钮）⇒ 直接返回会让新按钮变成 `undefined` ⇒ 判 `=== true` 时
 * 静默收进「更多」，用户会以为「缓存按钮没了」。
 */
export function loadToolPins(): Record<ReaderToolId, boolean> {
  const out = { ...DEFAULT_PINS };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return out;
    for (const t of READER_TOOLS) {
      const v = (parsed as Record<string, unknown>)[t.id];
      if (typeof v === 'boolean') out[t.id] = v;
    }
  } catch {
    // 隐私模式 / 数据损坏：用默认值，不影响阅读
  }
  return out;
}

export function saveToolPins(v: Record<ReaderToolId, boolean>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    // 存不下就算了 —— 这是偏好，不是数据
  }
}
