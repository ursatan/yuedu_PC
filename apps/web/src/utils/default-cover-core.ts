/**
 * 默认封面自定义图片的**纯逻辑**（不碰 DOM / 不碰 IndexedDB —— 浏览器侧行为由
 * `default-cover.ts` 落盘，单测只锁这里）。
 *
 * ## 为什么单独一个文件
 * 「真实封面 > 自定义默认 > 内置占位」这条优先级只要写错，**不会报错** ——
 * 只会表现为「设置页显示已换图、卡片上还是旧图」或「有真封面的书被默认图盖掉」。
 * 抽成纯函数后可在 node 里直接断言（见 `tests/default-cover.test.ts`）。
 */

/** 预置封面写进偏好的**标记串**（不是真实路径 —— 图片字节在 IndexedDB 里） */
export const DEFAULT_COVER_MARKER = 'idb:default-cover';

/** 单文件体积上限：2MB（与需求一致；转码后落盘的 blob 会小很多） */
export const DEFAULT_COVER_MAX_BYTES = 2 * 1024 * 1024;

/** 支持的文件类型（png / jpg / webp；MIME 可能为空，所以还看扩展名） */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ALLOWED_EXT = /\.(png|jpe?g|webp)$/i;

export type CoverFileReject = 'empty' | 'type' | 'size';

/**
 * 选择文件时的**前置校验**（还没读字节）。
 * 返回 `null` = 可以继续；否则返回拒绝原因（调用方翻成用户看得懂的话）。
 *
 * ⚠️ 体积判断用**原文件**大小：需求给的就是「单文件 ≤2MB」，
 * 转码后多大只影响存储、不改变「用户选了多大」这个事实。
 */
export function validateDefaultCoverFile(meta: {
  name?: string | null;
  type?: string | null;
  size?: number | null;
}): CoverFileReject | null {
  const size = Number(meta.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) return 'empty';
  if (size > DEFAULT_COVER_MAX_BYTES) return 'size';
  const type = String(meta.type ?? '').toLowerCase();
  if (type) return ALLOWED_MIME.has(type) ? null : 'type';
  // 有些浏览器/系统给的 MIME 是空串 ⇒ 退回扩展名判断（不能直接把合法 png 当不支持）
  return ALLOWED_EXT.test(String(meta.name ?? '')) ? null : 'type';
}

/** 这个偏好值是不是「自定义图片」的标记 */
export function isCustomDefaultCoverPath(path: string | null | undefined): boolean {
  return String(path ?? '').trim() === DEFAULT_COVER_MARKER;
}

/**
 * 把偏好里的底图路径解析成**真正能画的地址**。
 *
 * 优先级：自定义标记 + 已就绪的 object URL > 路径本身 > 内置默认图。
 * `customUrl` 为空（IndexedDB 没读到 / 图片损坏被清掉了）时**悄悄回落内置图** ——
 * 这就是「损坏图优雅回落」的落点，不需要在 UI 上留一个坏状态。
 */
export function resolveDefaultCoverBg(
  path: string | null | undefined,
  builtIn: string,
  customUrl: string,
): string {
  const p = String(path ?? '').trim();
  if (p === DEFAULT_COVER_MARKER) return customUrl.trim() || builtIn;
  return p || builtIn;
}

/**
 * 这一帧该画**真实封面**还是**默认封面层**（默认层里再分自定义/内置）。
 *
 * 真值表（与 `CoverImage` 的上游出处一一对应，见 `BookCover.load()` / `CoverImageView.kt`）：
 * | cover | 强制默认 | 加载失败 | 结果 |
 * |---|---|---|---|
 * | 有 | false | false | real —— **有真封面就不能被任何默认图覆盖** |
 * | 有 | true | — | default |
 * | 有 | false | true | default（加载失败才回落） |
 * | 空 | — | — | default |
 */
export function coverLayerOf(
  cover: string | null | undefined,
  useDefaultCover: boolean,
  loadFailed: boolean,
): 'real' | 'default' {
  if (useDefaultCover) return 'default';
  if (!String(cover ?? '').trim()) return 'default';
  return loadFailed ? 'default' : 'real';
}

/** 「恢复默认」写回的偏好值（= 契约 `emptyUiCoverConfig()` 的默认值，内置默认封面） */
export const BUILT_IN_DEFAULT_COVER_PATH = '/assets/default-cover.jpg';

/**
 * 「清除」写回的偏好值。
 * 与「恢复默认」**观感完全一致**（两者都落到 `BUILT_IN_DEFAULT_COVER_PATH`），
 * 差别只在语义：清除 = 删掉自定义记录、偏好留空；恢复默认 = 显式写回契约默认值。
 * 留空仍然能画，是因为 {@link resolveDefaultCoverBg} 兜了内置图 —— 不改变现有观感。
 */
export const CLEARED_DEFAULT_COVER_PATH = null;
