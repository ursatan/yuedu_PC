/**
 * `#224` **用户自定义样式预设**的持久化。
 *
 * ## 为什么单独一个模块
 * 与 `utils/reader-view-mode.ts` / `utils/discover-view-mode.ts` 同一套纪律：
 * ① **决策只此一份** —— 面板（`ReadStylePanel.vue`）只管渲染，读写与校验全在这里；
 * ② **可测** —— `localStorage` 在 Node 测试环境里不存在，而**白名单校验是最值得测的一处**
 *    （localStorage 是**外部输入**：浏览器控制台手改、旧版本残留、别的项目写脏同一个键）。
 *
 * ## 为什么落 localStorage 而不是服务端
 * 契约里**没有对应实体**（内置 6 套预设是照抄上游 `defaultData/readConfig.json` 的**常量**，
 * 见面板里的 `READ_STYLE_PRESETS`；上游也没有「用户自建预设」这个概念）
 * ⇒ 硬塞进 user 端点等于造第二份真相源。
 * 而它纯粹是「这台机器上我常用的几套配色」，与账号无关。
 *
 * ## 数据形状（刻意极简）
 * ```json
 * { "v": 1, "items": [ { "id": "u_ab12", "name": "我的护眼", "patch": { "bgStr": "#…" } } ] }
 * ```
 * · `v` 版本号：结构变了可以自然换键，不必写迁移；
 * · `id` 由 `name` + 时间派生，**不用随机**（便于复现与排查）；
 * · `patch` 走的是**和内置预设同一个形状**（`ReadStyleOverride`）⇒
 *   应用时走**同一条** `redirectPresetColors()` 路径，自建与内置不会有行为差异。
 */
import type { ReadStyleOverride } from '@yuedu/core/contract';

/** 用户自定义预设 */
export interface UserPreset {
  /** 稳定 id（`name` + 创建时间派生，见 `makePresetId`） */
  id: string;
  /** 预设名（用户自己起的，**非空**、去首尾空白后仍非空） */
  name: string;
  /** 颜色 + 排版 patch，形状与内置预设一致（应用时走同一条重定向路径） */
  patch: ReadStyleOverride;
  /** 创建时间（毫秒）。用于同名时不静默覆盖，而是加序号 */
  createdAt: number;
}

export const USER_PRESETS_KEY = 'yuedu-read-style-presets:v1';

/** 结构版本号 —— 与 `v` 字段一起构成「将来换键」的依据 */
const SCHEMA_VERSION = 1;

/** 最多几条（防 localStorage 被塞爆；超了保存时丢最旧的并留痕） */
export const MAX_USER_PRESETS = 30;

/** 预设名的长度上限（界面上是一枚色块下的短标签，太长排版会坏） */
const MAX_NAME_LEN = 16;

/** 白名单：只认这几个颜色键（与内置预设能改的范围对齐，不多不少） */
const ALLOWED_COLOR_KEYS = [
  'bgStr', 'textColor', 'textAccentColor',
  'bgStrNight', 'textColorNight', 'textAccentColorNight',
  'bgStrEInk', 'textColorEInk', 'textAccentColorEInk',
] as const;

/**
 * `#RRGGBB` / `#RGB` —— 与面板的 `<input type=color>` 输出格式一致。
 *
 * ★ `#249` **也接受 `#RRGGBBAA` / `#RGBA`**（8/4 位）：上游 `defaultData/readConfig.json`
 *   里的颜色就是 **8 位 ARGB**（如 `bgStr: "#ffc0edc6"`、`textColor: "#ff0b0b0b"`）——
 *   前两位是 alpha（`ff` = 全不透明）。此前这里只认 3/6 位 ⇒ 从上游抄来的颜色
 *   一进「另存为」就被判非法**静默丢弃**，用户看到的是「存了但颜色没变」。
 *   ⚠️ 上游 alpha **恒为 ff**（那几套预设没有半透明背景），但格式上仍按 8 位收，
 *   避免将来遇到带 alpha 的预设再被丢一次。
 */
function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v.trim());
}

/**
 * 校验一个「来路不明的对象」是不是合法预设。
 *
 * ⚠️ **每个字段都要校验**（不是只判 `typeof x === 'object'`）：
 * 脏值会一路流到 `<input type=color" :value="...">` 与 `style="{ background: ... }"`
 * ⇒ 非法颜色会让色块变成空白（看起来「预设丢了」），非法名字会渲染出 `undefined`。
 */
function normalizeOne(raw: unknown): UserPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_NAME_LEN) : '';
  if (!name) return null;
  const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : '';
  if (!id) return null;
  const createdAt = Number(o.createdAt);
  const rawPatch = (o.patch ?? {}) as Record<string, unknown>;
  // ★ 只保留白名单里的颜色键，且必须是合法 hex ⇒ 其余一律丢弃
  const patch: Record<string, unknown> = {};
  for (const k of ALLOWED_COLOR_KEYS) {
    const v = rawPatch[k];
    if (isHexColor(v)) patch[k] = (v as string).trim();
  }
  // 一个颜色都没有的预设没有意义（点了看不出变化）⇒ 判为无效
  if (!Object.keys(patch).length) return null;
  return {
    id, name, patch: patch as ReadStyleOverride,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** 读回全部自定义预设（无值 / 坏值 / 读抛错 ⇒ 空数组） */
export function loadUserPresets(): UserPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v?: unknown; items?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return [];
    return parsed.items.map(normalizeOne).filter((x): x is UserPreset => !!x).slice(0, MAX_USER_PRESETS);
  } catch {
    // 隐私模式 / 无 DOM 环境 / JSON 损坏 ⇒ 当作没有（用户仍能用内置预设）
    return [];
  }
}

/**
 * 写回。
 *
 * @returns 写入后的完整列表；**写失败时返回原列表**（调用方据此提示「本次没存上」）
 */
export function saveUserPresets(list: UserPreset[]): UserPreset[] {
  const clean = list.map(normalizeOne).filter((x): x is UserPreset => !!x).slice(0, MAX_USER_PRESETS);
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify({ v: SCHEMA_VERSION, items: clean }));
    return clean;
  } catch {
    return list;
  }
}

/**
 * 预设 id：`u_` + 名字的十六进制摘要 + 时间戳。
 *
 * 为什么不随机：同一条记录反复保存时 id 稳定 ⇒ 探针/用户反馈里能直接指认是哪一条。
 */
export function makePresetId(name: string, createdAt: number): string {
  let h = 0;
  const s = name.trim();
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `u_${hex}_${createdAt.toString(36)}`;
}

/**
 * 加入一条自定义预设（**同名不覆盖**，自动加序号）。
 *
 * 为什么不静默覆盖：用户起了个「护眼」又想起一个「护眼 2」，
 * 静默覆盖会让他发现「刚才调的那套没了」而且不知道为什么。
 */
export function addUserPreset(list: UserPreset[], name: string, patch: ReadStyleOverride, now = Date.now()): UserPreset[] {
  const base = name.trim().slice(0, MAX_NAME_LEN) || '我的预设';
  let finalName = base;
  let n = 2;
  while (list.some((p) => p.name === finalName)) {
    finalName = `${base} ${n}`;
    n += 1;
    if (n > 99) break; // 名字后缀到 99 还撞就放弃加序号（极端情况）
  }
  const item: UserPreset = { id: makePresetId(finalName, now), name: finalName, patch, createdAt: now };
  // 新预设排在**最前**（用户刚做的最可能是当前想用的），超上限丢最旧的
  return [item, ...list].slice(0, MAX_USER_PRESETS);
}

/** 按 id 删一条（找不到就是没找到，不抛） */
export function removeUserPreset(list: UserPreset[], id: string): UserPreset[] {
  return list.filter((p) => p.id !== id);
}

/** 按 id 改 patch（保存编辑）。找不到就原样返回。 */
export function updateUserPreset(list: UserPreset[], id: string, patch: ReadStyleOverride): UserPreset[] {
  return list.map((p) => (p.id === id ? { ...p, patch } : p));
}

/** 按 id 改名（空名 / 超长会被 `normalizeOne` 挡掉 ⇒ 那里返回原样） */
export function renameUserPreset(list: UserPreset[], id: string, name: string): UserPreset[] {
  return list.map((p) => (p.id === id ? { ...p, name: name.trim().slice(0, MAX_NAME_LEN) } : p));
}
