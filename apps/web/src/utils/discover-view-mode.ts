/**
 * `#184` 发现页「内容区布局」的**持久化**（用户 2026-10-01：「按钮组，持久化（记忆布局）」）。
 *
 * ## 为什么单独抽一个模块（而不是写在 store 里）
 * 两条纪律的交集：
 * ① **决策只此一份** —— `stores/discover.ts` 已经是 300 行的状态机，再往里塞 localStorage 读写
 *    会让「布局这个值从哪来」有两个答案（`blank()` 里播种一次、组件里再存一次）⇒ 必然漂移；
 * ② **可测** —— `localStorage` 在 Node 测试环境里不存在，塞进 store 就只能靠真浏览器验。
 *    抽成纯函数后，`normalizeViewMode()` 的白名单校验能直接单测（这是**最值得测**的一处：
 *    localStorage 里的值是**外部输入**，手改浏览器控制台、旧版本残留、别的项目写脏都会进来）。
 *
 * ## 为什么落 localStorage 而不是服务端
 * 契约里**没有对应实体**（与 `navMode` / 字典规则 / 音量倍速 / 字号主题同类）⇒
 * 硬塞进 24 个user 端点等于造第二份真相源。
 * 而它纯粹是「这台机器上我习惯怎么看列表」，**与账号无关**。
 *
 * ## 为什么键名**不含 kind**
 * `viewMode` 是**用户偏好**，不是「这个源/这个发现页的状态」。
 * 按 kind 分存（`yuedu-discover-view-mode:legado` / `:maccms`）的话，
 * 用户在书院选「列表」、切到影院又变回「多列」—— 等于要设两遍，
 * 而用户的原话是「按钮组，持久化（记忆布局）」，记的是**布局这件事**。
 * 切源/换分类同样**不该**重置它。
 */
export type DiscoverViewMode = 'grid' | 'list' | 'wide';

/** 全部合法值 —— 新增模式时**只改这一处**，白名单校验与 UI 按钮组都靠它对齐 */
export const DISCOVER_VIEW_MODES: readonly DiscoverViewMode[] = ['grid', 'list', 'wide'] as const;

/** 默认布局（用户没选过、或存的���是坏值） */
export const DEFAULT_VIEW_MODE: DiscoverViewMode = 'grid';

/** ⚠️ 不含 kind，理由见上方注释 */
export const VIEW_MODE_KEY = 'yuedu-discover-view-mode';

/**
 * 校验一个「来路不明的字符串」是不是合法布局值。
 *
 * ⚠️ **必须白名单、不能用 `as` 断言**：localStorage 里的值是**外部输入**
 * （浏览器控制台手改、旧版本残留、别的项目写脏同一个键）。
 * 写进模板的 `viewMode === 'wide'` 之类比较一旦拿到 `'foo'`，
 * 三个分支全部落空 ⇒ **内容区整块空白且不报错**（最典型的「看起来坏了」）。
 */
export function normalizeViewMode(raw: unknown): DiscoverViewMode {
  return typeof raw === 'string' && (DISCOVER_VIEW_MODES as readonly string[]).includes(raw)
    ? (raw as DiscoverViewMode)
    : DEFAULT_VIEW_MODE;
}

/** 读持久化的布局（无值 / 坏值 / 读抛错 ⇒ 默认） */
export function loadViewMode(): DiscoverViewMode {
  try {
    return normalizeViewMode(localStorage.getItem(VIEW_MODE_KEY));
  } catch {
    // 隐私模式 / 无 DOM 环境（SSR、Node 测试）⇒ 默认值，不抛
    return DEFAULT_VIEW_MODE;
  }
}

/** 写回持久化。**返回是否成功**，好让调用方在失败时留痕（不抛：布局切换是次要功能） */
export function saveViewMode(mode: DiscoverViewMode): boolean {
  try {
    localStorage.setItem(VIEW_MODE_KEY, normalizeViewMode(mode));
    return true;
  } catch {
    return false;
  }
}