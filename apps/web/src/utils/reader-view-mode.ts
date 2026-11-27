/**
 * `#224` 阅读器**视图模式**（滚动 / 分页）的持久化。
 *
 * ## 为什么需要它（这不是「把滚动改成翻页」那么小）
 * 契约里的 `pageAnim`（`ReadBookConfig.kt:886` / `PageAnim.kt:9-17`：0 覆盖 / 1 滑动 / 2 仿真 /
 * 3 滚动 / 4 无动画）只描述**翻页动画**，而「**要不要分页**」在**上游没有这个开关** ——
 * Legado 的阅读器本来就是**分页的自定义 View**（`ReadView.kt:898 isScroll = pageAnim() == 3`，
 * 即「滚动」只是它五档里的一档）。本仓 Web 阅读浮层从头到尾是**滚动式**，
 * 所以 `pageAnim` 此前给别的档位就是**假设置**（见契约 `user-data.ts` 的「暂缓 / 不做」段）。
 * ⇒ 要做真分页，必须**自己**引入「视图模式」这一层，两个概念分开：
 *   · **视图模式** = 滚动 还是 分页（本文件，`#224` 新增）
 *   · **翻页动画** = 分页时怎么翻（复用已有的 `pageAnim`，语义与上游对齐）
 *
 * ## 为什么落 localStorage 而不是服务端
 * 与 `utils/discover-view-mode.ts` 同一判断：契约里没有对应实体（`navMode` / 音量倍倍速 /
 * 字典规则同类），硬塞进 user 端点等于造第二份真相源；它纯粹是「这台机器上我习惯怎么读」。
 *
 * ## 为什么**按 kind / 源**不分存
 * `viewMode` 是**用户偏好**，不是「这本书的状态」。按书分存的话换本书就变回默认，
 * 等于每本都要设一遍（与 `discover-view-mode` 的同一条理由）。
 *
 * ## 为什么键名带 `v1`
 * 将来若要改默认值或加新档位，旧键里存的值可能是非法值 —— `normalizeReaderViewMode`
 * 的白名单已经能挡住，这里加版本号只是为了让「结构变了」时可以自然换键。
 */
export type ReaderViewMode = 'scroll' | 'paged';

/** 全部合法值 —— 新增模式时**只改这一处**，白名单校验与 UI 按钮组都靠它对齐 */
export const READER_VIEW_MODES: readonly ReaderViewMode[] = ['scroll', 'paged'] as const;

/**
 * 默认视图：**滚动**。
 *
 * 为什么默认滚动而不是分页：分页在 Web 上有已知代价 —— ① 内容高度变化（图片加载完、窗口改大小）
 *   需要重算页数；② 一段被 `column` 切断的文字无法用鼠标选（跨列选择是浏览器的老毛病）；
 *   ③ 长章节的分页数可能上百，页脚要显示「第 N / 共 M 页」就得有可靠的测量。
 * ⇒ 滚动是**零风险**的既有行为，分页作为**用户主动开启**的能力更稳妥。
 */
export const DEFAULT_READER_VIEW_MODE: ReaderViewMode = 'scroll';

export const READER_VIEW_MODE_KEY = 'yuedu-reader-view-mode:v1';

/**
 * 校验「来路不明的字符串」是不是合法视图模式。
 *
 * ⚠️ **必须白名单、不能用 `as` 断言**（理由同 `discover-view-mode.ts`）：
 * localStorage 是**外部输入**，拿到 `'foo'` 时模板里的比较全部落空
 * ⇒ 分页容器不生成、也没有滚动容器 ⇒ **正文整块空白且不报错**。
 */
export function normalizeReaderViewMode(raw: unknown): ReaderViewMode {
  return typeof raw === 'string' && (READER_VIEW_MODES as readonly string[]).includes(raw)
    ? (raw as ReaderViewMode)
    : DEFAULT_READER_VIEW_MODE;
}

/** 读持久化的视图模式（无值 / 坏值 / 读抛错 ⇒ 默认） */
export function loadReaderViewMode(): ReaderViewMode {
  try {
    return normalizeReaderViewMode(localStorage.getItem(READER_VIEW_MODE_KEY));
  } catch {
    // 隐私模式 / 无 DOM 环境（SSR、Node 测试）⇒ 默认值，不抛
    return DEFAULT_READER_VIEW_MODE;
  }
}

/**
 * 写回持久化。
 *
 * **返回是否成功**，好让调用方在失败时留痕 —— 这里**不抛**：
 * 视图切换是次要功能，为它打断阅读体验更糟（与 `saveViewMode` 同一判断）。
 */
export function saveReaderViewMode(mode: ReaderViewMode): boolean {
  try {
    localStorage.setItem(READER_VIEW_MODE_KEY, normalizeReaderViewMode(mode));
    return true;
  } catch {
    return false;
  }
}

/**
 * 翻页动画档位（`PageAnim.kt:9-17`）的**文案 + 是否只在分页下有意义**。
 *
 * ★ `scroll`（3）这一档在**滚动模式**下就是「不翻页」⇒ 界面上的说法要说清，
 *   否则用户选了「滚动」却发现在分页模式里也选得到，会以为设置互相矛盾。
 */
export interface PageAnimOption {
  value: number;
  label: string;
  /** 仅在分页模式下可选（滚动模式下这一档 ≡ 无动画） */
  pagedOnly: boolean;
  /** 一句话说明它看起来是什么样（tooltip 用） */
  hint: string;
}

/**
 * 照抄 `PageAnim.kt:9-17`：`cover=0 / slide=1 / simulation=2 / scroll=3 / noAnim=4`。
 * ⚠️ **不要改这些数字** —— `pageAnim` 是上游既有字段，将来导出给 App 时要对得上。
 */
export const PAGE_ANIM_OPTIONS: readonly PageAnimOption[] = [
  { value: 0, label: '覆盖', pagedOnly: false, hint: '新一页从侧边滑入盖住旧页（旧页不动）' },
  { value: 1, label: '滑动', pagedOnly: false, hint: '新旧两页一起水平位移（有加减速）' },
  { value: 2, label: '仿真', pagedOnly: false, hint: '透视旋转 + 页边阴影的翻书近似（非真卷曲）' },
  { value: 3, label: '滚动', pagedOnly: true, hint: '匀速连续位移，没有「翻页」的停顿感' },
  { value: 4, label: '无动画', pagedOnly: false, hint: '直接切页，不做任何动画' },
] as const;

/** 归一一个「来路不明的 pageAnim 值」⇒ 合法档位（坏值回落 3 = 匀速位移，不是「不动画」） */
export function normalizePageAnim(raw: unknown): number {
  const n = Number(raw);
  return PAGE_ANIM_OPTIONS.some((o) => o.value === n) ? n : 3;
}

/**
 * `#833` **滚动模式「无限滚动」开关**的持久化。
 *
 * ## 为什么默认**关**
 * 开启后滚到章末会自动加载下一章（并且向上会加载上一章），这是**用户可见的行为改变**。
 * 既有用户的预期是「章末即停」⇒ 不能默认替他们决定（与 `#224` 视图模式默认滚动的保守口径一致）。
 *
 * ## 为什么和 `viewMode` 放同一个文件
 * 两者都是「这台机器上我习惯怎么读」的本地偏好（上游没有对应实体），与 `discover-view-mode`
 * 同类；放同一处可以共用 localStorage 读出失败时的兜底判断，避免第二个文件漂移。
 */
export const INFINITE_SCROLL_KEY = 'yuedu-reader-infinite-scroll:v1';

/** 读持久化开关（无值 / 读抛错 ⇒ 关） */
export function loadInfiniteScroll(): boolean {
  try {
    return localStorage.getItem(INFINITE_SCROLL_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写回开关；返回值同 `saveReaderViewMode`：失败不抛、只让调用方留痕 */
export function saveInfiniteScroll(on: boolean): boolean {
  try {
    localStorage.setItem(INFINITE_SCROLL_KEY, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
