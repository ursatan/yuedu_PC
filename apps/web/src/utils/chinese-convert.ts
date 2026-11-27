/**
 * 简繁转换（`#146`）—— 上游用第三方库，本仓用 **`opencc-js`**（license `MIT AND Apache-2.0`，与 GPL-3.0 兼容）。
 *
 * ## 上游依据（转换点只有两处）
 * Legado 用 `com.github.liuyueyi.quick.transfer` 的 `ChineseUtils`（`app/src/main/java/io/legado/app/utils/ChineseUtils.kt`）：
 *  · **正文**：`ContentProcessor.kt:153-163` —— `type 1 → t2s`、`type 2 → s2t`，
 *    且 **catch 后照原样继续**（只 toast 一句「简繁转换出错」）；
 *  · **章节显示名**：`BookChapter.getDisplayTitle()`（`BookChapter.kt:131-136`），在**替换规则之前**转换。
 *  `chineseConverterType` 取值见契约 `ChineseConvertType`：`0` 不转换 / `1` 繁→简 / `2` 简→繁。
 *
 * ⚠️ **与 Legado 无法逐字一致**（词典实现不同；上游还带一份约 100 条的港台用语例外表）。
 *   用户 2026-09-30 已明确：「**无需与 Legado 逐字一致，实现功能就行**」。
 *
 * ## 配置怎么选的（**实测对比过，别凭感觉改**）
 * `opencc-js` 的 `Locale` 有 `cn / tw / hk / t / twp` 五种。对「軟體 伺服器 網路 硬碟 計程車 滑鼠 資訊」实测：
 * ```
 *   t2cn from=t|tw|hk  ⇒ 软体 伺服器 网路 硬碟 计程车 滑鼠 资讯   ← 只做**字级**，大陆读者读着别扭
 *   t2cn from=twp      ⇒ 软件 服务器 网络 硬盘 出租车 鼠标 信息   ← 带**词组**，正确 ✅
 *   cn2t to=t|tw|hk    ⇒ 軟件 服務器 網絡 硬盤 出租車 鼠標 信息   ← 字级
 *   cn2t to=twp        ⇒ 軟體 伺服器 網路 硬碟 計程車 滑鼠 資訊   ← 词组 ✅
 * ```
 * ⇒ **繁→简 `twp→cn`，简→繁 `cn→twp`**。顺带实测：上游那份例外表里的样本
 *   （「機車/雪梨/起司/桌球」）在 `twp` 词典下**已经是期望结果**，无需再移植那份例外表。
 *
 * ## 为什么必须**动态 `import()`**
 * ESM 构建体积（`node_modules/opencc-js/dist/esm/`）：`full.js` 1167KB · `cn2t.js` **1075KB** · `t2cn.js` **107KB**。
 * 静态引会把 Web 主包从 ~2.6MB 推到近 4MB，而简繁转换是**少数人偶尔开一次**的功能
 * ⇒ 按需加载，且**每个方向只加载自己那份词典**（Vite 自动切成独立 chunk）。
 *
 * ## 失败不致命（对齐上游 + 铁律 4）
 * 转换失败 ⇒ 返回原文继续（读者至少能读到字），但必须 `warnOnce` **留痕** ——
 * 静默失败会被当成「这本本来就是简体」，是最难发现的一类问题。
 */

/** 与契约 `ChineseConvertType` 对齐（`user-data.ts`）：0 不转换 / 1 繁→简 / 2 简→繁 */
export type ChineseConvertType = 0 | 1 | 2;

type ConvertFn = (text: string) => string;

/** 每个方向各自的惰性加载器（分开加载，避免「只要繁→简却拖进 1MB」） */
type Loader = () => Promise<ConvertFn>;

const loadT2S: Loader = async () => {
  const mod = await import('opencc-js/t2cn');
  // 繁 → 简：只有 `twp` 会做**词组**转换（軟體→软件）
  return mod.Converter({ from: 'twp', to: 'cn' }) as ConvertFn;
};

const loadS2T: Loader = async () => {
  const mod = await import('opencc-js/cn2t');
  // 简 → 繁：同理，只有 `twp` 给出台灣用语（软件→軟體）
  return mod.Converter({ from: 'cn', to: 'twp' }) as ConvertFn;
};

const cache = new Map<ChineseConvertType, ConvertFn>();
const inFlight = new Map<ChineseConvertType, Promise<ConvertFn>>();

/**
 * ⚠️ `warnOnce` 已抽到 `utils/warn-once.ts`（全仓唯一实现，2026-09-30）——
 * 这里改成 import，**不要**再在本文件里各写一份 `Set`（两份去重表会让「只留一次」失效）。
 */
import { resetWarnOnce, warnOnce } from './warn-once';

/** `chineseConverterType` 是不是「要转换」（脏值一律当不转换） */
export function isChineseConvertOn(type: unknown): boolean {
  return type === 1 || type === 2;
}

/** 规范化：只认 0/1/2，其余按 0（契约默认值） */
export function normalizeChineseConvertType(type: unknown): ChineseConvertType {
  return type === 1 || type === 2 ? type : 0;
}

/** 设置页用的三选一文案（取值语义与契约、上游 `arrays.xml` 一致） */
export const CHINESE_CONVERT_OPTIONS: ReadonlyArray<{ value: ChineseConvertType; label: string }> = [
  { value: 0, label: '不转换' },
  { value: 1, label: '繁体 → 简体' },
  { value: 2, label: '简体 → 繁体' },
];

/** 取（并按需加载）某方向的转换器 */
async function getConverter(type: ChineseConvertType): Promise<ConvertFn | null> {
  if (type !== 1 && type !== 2) return null;
  const hit = cache.get(type);
  if (hit) return hit;
  let p = inFlight.get(type);
  if (!p) {
    // ⚠️ 别写成 `(cond ? loadT2S() : loadS2T())()` —— 那会把加载器**再调一次**
    //（返回的是 Promise，不是函数）⇒ `is not a function`。这里就是被单测抓到的原样。
    p = type === 1 ? loadT2S() : loadS2T();
    inFlight.set(type, p);
  }
  try {
    const fn = await p;
    cache.set(type, fn);
    return fn;
  } catch (e) {
    inFlight.delete(type); // 允许下次重试
    warnOnce(
      `chinese-convert-load-${type}`,
      `[chinese] 简繁转换词典加载失败（type=${type}），本次按原文显示：${String(
        e instanceof Error ? e.message : e,
      )}`,
    );
    return null;
  } finally {
    inFlight.delete(type);
  }
}

/**
 * ★ `#257`：**同步**窥视某个方向的转换器 —— 只在**已经加载过**时返回函数，否则 `null`。
 *
 * 给 `@js:` 净化脚本里的 `java.t2s` / `java.s2t` 用（上游那两个方法是**同步**的）。
 * 本仓词典是按需异步加载（见文件头：静态引会 +1.4MB）⇒ 同步上下文里拿不到就只能报错留痕，
 * **不能**临时去 `await`（`applyReplaceRules` 是同步管线），也**不能**假装转换成功。
 *
 * @param type 1 = 繁→简（`t2s`）、2 = 简→繁（`s2t`）
 */
export function peekChineseConverter(type: ChineseConvertType): ConvertFn | null {
  return cache.get(type) ?? null;
}

/**
 * 转换一段文本。`type` 为 0 / 脏值 / 空串 / 加载失败 ⇒ **原样返回**（永不抛）。
 */
export async function convertChinese(text: string, type: unknown): Promise<string> {
  const t = normalizeChineseConvertType(type);
  if (t === 0 || !text) return text;
  const fn = await getConverter(t);
  if (!fn) return text;
  try {
    return fn(text);
  } catch (e) {
    warnOnce(
      `chinese-convert-run-${t}`,
      `[chinese] 简繁转换出错（type=${t}），本次按原文显示：${String(e instanceof Error ? e.message : e)}`,
    );
    return text;
  }
}

/**
 * 批量转换（正文段落 / 目录标题）。
 *
 * ★ 只加载**一次**词典（`getConverter` 有缓存），别在循环里逐条 `convertChinese`
 * —— 那样每次都要过一次 `Map` 查找与 try/catch，2000 章的目录会明显卡。
 */
export async function convertChineseBatch(
  texts: readonly string[],
  type: unknown,
): Promise<string[]> {
  const t = normalizeChineseConvertType(type);
  if (t === 0 || texts.length === 0) return texts.slice();
  const fn = await getConverter(t);
  if (!fn) return texts.slice();
  try {
    return texts.map((s) => (s ? fn(s) : s));
  } catch (e) {
    warnOnce(
      `chinese-convert-run-${t}`,
      `[chinese] 简繁转换出错（type=${t}），本次按原文显示：${String(e instanceof Error ? e.message : e)}`,
    );
    return texts.slice();
  }
}

/** 仅供测试：清掉已缓存的词典与「已留痕」标记 */
export function __resetChineseConvertCache(): void {
  cache.clear();
  inFlight.clear();
  resetWarnOnce();
}
