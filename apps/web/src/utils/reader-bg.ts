/**
 * `#249` **阅读背景图片**（内置图清单 + 取值解析）。
 *
 * ## 上游依据（读了才敢这么写）
 * · `ReadBookConfig.kt:874-876`：`bgType/bgTypeNight/bgTypeEInk` = `0 颜色 / 1 assets 图片 / 2 其它图片`；
 *   `:814-826` 里 `bgType==2` 时 **`bgStr` 被改写成文件路径**（同槽复用），`bgType==0` 时才当颜色。
 * · `PageView.kt:329-336`：`binding.vwRoot.background = LayerDrawable(bgMeanColor, bg)`
 *   —— 背景挂在 **`vwRoot`**（`view_book_page.xml` 里它包含 `ll_header` + 正文 + `ll_footer`），
 *   而 **`ll_header` / `ll_footer` 自身没有 `android:background`** ⇒ **透明** ⇒ 背景图透上来。
 *   ⇒ **上游是「一张背景铺满整个阅读界面，页眉/页脚透明」，不是只铺正文块。**
 *   本仓照此实现（背景挂 `.se-scroll`，`.se-head` 工具栏保持自身背景 —— 工具栏在上游不在 PageView 内）。
 * · 内置图 14 张在 `F:\legado\app\src\main\assets\bg\`，已拷到 `apps/web/public/reader-bg/`。
 *   ⚠️ 放 `public/` 而**不是**打进 bundle：合计 ~1MB，放 public 由浏览器**按需加载**（选中才请求），
 *   不拖首屏；打进 bundle 则每次都要带上。
 * · ⚠️ 上游 6 个内置预设的 `bgType` **全是 0（纯色）** ⇒ 内置图**不进预设**，只供用户自选。
 *
 * ## 为什么内置图**不进预设**
 * 上游已经这么定（`readConfig.json` 里没有任何 `bgType!=0` 的条目）；而且一张图 ≈ 100~320KB，
 * 塞进 localStorage 的用户预设里会让预设体积失控、写入失败。
 */

/** 一张内置背景图（与 `public/reader-bg/manifest.json` 一一对应） */
export interface ReaderBgImage {
  /** id = 文件名去扩展名（如 `护眼漫绿`）—— 存进偏好就是它 */
  id: string;
  label: string;
  /** 相对 `origin` 的 URL（`/reader-bg/护眼漫绿.jpg`） */
  url: string;
}

/**
 * 14 张内置图（`F:\legado\app\src\main\assets\bg\`，**逐字照抄文件名，不改名不改顺序**）。
 *
 * ⚠️ 为什么文件名用中文原样：它们是**上游的资源名**，改名就断了「与上游一一对应」这层可核对性。
 * URL 里中文无需转义（浏览器会自动编码），但为稳妥仍走 {@link encodeURIComponent}。
 */
export const READER_BG_IMAGES: readonly ReaderBgImage[] = [
  { id: '午后沙滩', label: '午后沙滩', url: 'reader-bg/午后沙滩.jpg' },
  { id: '宁静夜色', label: '宁静夜色', url: 'reader-bg/宁静夜色.jpg' },
  { id: '山水墨影', label: '山水墨影', url: 'reader-bg/山水墨影.jpg' },
  { id: '山水画', label: '山水画', url: 'reader-bg/山水画.jpg' },
  { id: '护眼漫绿', label: '护眼漫绿', url: 'reader-bg/护眼漫绿.jpg' },
  { id: '新羊皮纸', label: '新羊皮纸', url: 'reader-bg/新羊皮纸.jpg' },
  { id: '明媚倾城', label: '明媚倾城', url: 'reader-bg/明媚倾城.jpg' },
  { id: '深宫魅影', label: '深宫魅影', url: 'reader-bg/深宫魅影.jpg' },
  { id: '清新时光', label: '清新时光', url: 'reader-bg/清新时光.jpg' },
  { id: '羊皮纸1', label: '羊皮纸 1', url: 'reader-bg/羊皮纸1.jpg' },
  { id: '羊皮纸2', label: '羊皮纸 2', url: 'reader-bg/羊皮纸2.jpg' },
  { id: '羊皮纸3', label: '羊皮纸 3', url: 'reader-bg/羊皮纸3.jpg' },
  { id: '羊皮纸4', label: '羊皮纸 4', url: 'reader-bg/羊皮纸4.jpg' },
  { id: '边彩画布', label: '边彩画布', url: 'reader-bg/边彩画布.jpg' },
] as const;

/** 内置图 id → URL（`Map` 建一次即可，别每次 `find`） */
const BY_ID = new Map(READER_BG_IMAGES.map((x) => [x.id, x.url] as const));

/** 本机图片转 data URL 的上限（与界面壁纸那条一致：偏好跟着服务端同步，不能太大） */
export const MAX_LOCAL_BG_BYTES = 400 * 1024;

/**
 * 把偏好里的 `bgImgPath` 解析成可放进 CSS 的 `url(...)`，**解析不出来就返回 `null`**。
 *
 * ## 四种取值（与契约 `ShelfBook.readStyle` / `GlobalReaderPrefs` 的注释一致）
 * · `null` / 空串 → 没有图；
 * · 内置图 id → `/reader-bg/<file>`（**相对根路径**，`origin` 由调用方拼）；
 * · `http(s)://…` → 原样；
 * · `data:image/…` → 原样。
 *
 * ⚠️ **不认识的字符串一律当「无效」返回 `null`，而不是原样塞进 CSS** ——
 * 一个坏值会让 `url(…)` 变成无效声明；更糟的是若将来支持 CSS 注入，
 * `url("); background: red; …")` 这种串就能带进样式。宁可不出图。
 */
export function resolveReaderBgUrl(value: string | null | undefined, origin = ''): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const builtin = BY_ID.get(v);
  if (builtin) return `${origin}/${builtin}`;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^data:image\//i.test(v)) return v;
  return null;
}

/** 这个值是不是内置图 id（UI 用它决定高亮哪一枚） */
export function isBuiltinBgId(value: string | null | undefined): boolean {
  return !!value && BY_ID.has(value.trim());
}
