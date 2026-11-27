/**
 * 源导入解析层（Web「导入源」对话框 + 服务端 /api/sources/import* 共用）。
 *
 * 为什么要单独一层：
 *  - 解析/格式识别/去重判定必须**在服务端**做一份权威实现（Web 只需展示预览），
 *    否则前后端各写一套识别规则，必然出现「预览说 29 条新增、导入却 0 条」。
 *  - 纯函数、无 IO → 可单测。
 *
 * 支持形态（本仓库已实现的引擎）：
 *  · `legado`  —— Legado 书源：单个对象 / 对象数组
 *  · `maccms`  —— 苹果 CMS（MacCMS）影视源：`{apiUrl|api, name}`
 *                也支持纯文本清单（每行一条 `name,apiUrl`，非 JSON，便于批量导入）
 */

import { isLegadoBookSource } from '@yuedu/core/contract';

export type ImportFormat = 'legado' | 'maccms' | 'rss';
export type ImportFormatHint = 'auto' | ImportFormat;

/** 解析出的单条待导入源（还没有进 hub） */
export interface ImportRow {
  /** 入库 id（与 hub 的 deriveId 同一规则，便于前端预览时判定重复） */
  id: string;
  /** 引擎 kind：legado / maccms / rss */
  kind: string;
  name: string;
  group?: string;
  raw: unknown;
}

/** 预览里的单条源（不含 raw，体积可控） */
export interface ImportPreviewItem {
  /**
   * `#351` **在 `rows` 里的下标**（0 基）—— 逐行勾选的**唯一键**。
   *
   * ★ 不能用 `id` 当勾选键：**同一份导入文本里可以有两条同 id 的源**
   *   （合集文件里同一个站出现两次很常见，`deriveId` 只认 `bookSourceUrl`
   *   ⇒ 两条 raw 同 id）。用 id 存勾选状态时两行会**联动**，用户取消其中一行
   *   另一行也一起被取消 ⇒ 无法「逐行自选」。
   */
  index: number;
  /** 入库 id（与 hub 的 deriveId 同一规则，便于前端预览时判定重复） */
  id: string;
  kind: string;
  name: string;
  group?: string;
}

/** 导入预览结果（UI 直接渲染） */
export interface ImportPreview {
  format: ImportFormat;
  /** 解析出的候选项总数 */
  parsedTotal: number;
  /** 可入库的**新源**（库里没有这个 id） */
  valid: ImportPreviewItem[];
  /**
   * 库里已有**同 id 但内容不同** ⇒ 导入会**覆盖更新**（`#351`）。
   * 默认勾选；不勾选则这条不会被动。
   */
  updatable: ImportPreviewItem[];
  /**
   * 库里已有**同 id 且内容等价** ⇒ 什么都不会变（`#351`）。
   * 默认**不勾选**；用户想强制重写一遍时可手动勾。
   */
  duplicates: Array<ImportPreviewItem & { existingName?: string }>;
  errors: Array<{ index: number; reason: string }>;
  /** 原文前 140 字符 */
  preview: string;
  /** 解析出的条目总数（含重复/错误，用于 UI 展示） */
  rowCount: number;
  /** 预览提示（如超大合集只采样编译了前 N 条） */
  note?: string;
}

export interface ImportParseResult {
  format: ImportFormat;
  /** 解析出的条目总数（含后面被判定为错误的） */
  parsedTotal: number;
  rows: ImportRow[];
  errors: Array<{ index: number; reason: string }>;
  /** 原文前 140 字符（UI 预览） */
  preview: string;
  /**
   * 格式层面的提示（可空）：**显式指定格式与内容实际形态不符**时给出。
   * 逐条错误只说明「缺哪个字段」，这里补一句「你选的格式不对，应该选哪个」。
   */
  hint?: string;
}

/**
 * id 安全化：**非 `[A-Za-z0-9_.-]` 的字符逐个换成 `_`**（不合并、不去首尾）。
 *
 * 为什么要这一步（实测踩到）：`https://a.com` 直接当 id 会带 `/`、`:`，
 * 而服务端路由是 `/api/sources/:id/...` —— 带斜杠的 id **所有按源操作的接口都会 404**
 * （删除/开关/校验/登录/源变量全挂），且 Fastify 对 `%2F` 也不解，编码也救不回来。
 * 同时文件源的 id 就是文件名（`hub.loadDir` 用 `f.replace(/\.json$/,'')`），
 * 不规则会影响去重：同一个站从文件加载是 `https___a.com`、导入进来是 `https://a.com`
 * → 判定成两个源，重复入库。
 */
export function safeSourceId(id: string): string {
  return String(id ?? '').trim().replace(/[^\w.-]/g, '_');
}

/**
 * 「URL 安全字母表」：这些字符过 `safeSourceId` 是**逐字符一一对应**的（不会撞）。
 *
 * 表外的字符（中文、空格、`<>{}|^"` 等）会被**折叠**成同一个 `_` ⇒ 多个不同的
 * `bookSourceUrl` 可能得到**同一个 id**。见 `deriveId` 里的指纹补偿。
 */
const URL_SAFE_CHARS = /^[\w.:/?#@!$&'()*+,;=%~[\]-]*$/;

/**
 * 稳定指纹（`deriveId` 的碰撞补偿用）：FNV-1a + djb2 两个种子拼起来。
 *
 * 为什么不用 `Math.random`/递增计数：id 必须是 **raw 的纯函数** ——
 * 否则「同一个源第二次导入」会得到另一个 id，去重彻底失效（比碰撞更糟）。
 * 10 位 base36 ≈ 51 bit，几千个源的碰撞概率可忽略。
 */
function fingerprint(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return (h1 >>> 0).toString(36).padStart(5, '0') + (h2 >>> 0).toString(36).padStart(5, '0');
}

/**
 * 源 id 派生（与 hub.importSource 保持一致）：
 * bookSourceUrl / sourceUrl / apiUrl / id / _id，缺失则 JSON 稳定 hash。
 * 字符串候选一律过 `safeSourceId`（对齐文件源「文件名即 id」的规则）。
 *
 * ## 为什么安全化之后还要补指纹（`#640`，用户实测）
 * `safeSourceId` 对**表外字符逐个换成 `_`**，是个**多对一**映射。用户的两个源
 * 「听小说APP[小说_官方本地解密]」（`APP小说接口`）与「听小说APP[短剧_官方本地解密]」
 * （`APP短剧接口`）都被折成 `APP____` ⇒ 导入预览显示「更新」，**导入一个把另一个覆盖掉**。
 *
 * 补偿规则：候选串**含表外字符**（即安全化会丢信息）时，在安全化结果后追加
 * `-<10 位指纹>`；纯 URL 字符集的候选（482 个存量源全是这种）**原样不变** ——
 * 这样既不破坏已有文件名（文件名即 id），又保证不同 url 不再撞。
 */
export function deriveId(raw: unknown, kind: string): string {
  const r = raw as Record<string, unknown>;
  const cand = r['bookSourceUrl'] ?? r['sourceUrl'] ?? r['apiUrl'] ?? r['id'] ?? r['_id'];
  if (typeof cand === 'string' && cand) {
    const safe = safeSourceId(cand);
    if (safe) return URL_SAFE_CHARS.test(cand) ? safe : `${safe}-${fingerprint(cand)}`;
  }
  let h = 5381;
  const s = JSON.stringify(raw);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${kind}:${(h >>> 0).toString(36)}`;
}

/**
 * 两条源 raw 是否**内容等价**（判据**唯一实现**）。
 *
 * ## 为什么需要它（`#351` 导入预览「新增 / 更新 / 重复」三分类）
 * 用户要求预览区分三种：**新增**（库里没有）、**更新**（库里同 id 但内容**变了**）、
 * **重复**（库里同 id 且内容**一模一样**）。后两者只靠 `id` 分不开 —— `id` 是
 * `deriveId` 从 `bookSourceUrl` 派生的，**只要 `bookSourceUrl` 没变，改了规则也是同一个 id**。
 *
 * ## 为什么用「稳定键序 JSON」而不是 `JSON.stringify(a) === JSON.stringify(b)`
 * `JSON.stringify` **保留对象自身的键序**。同一条源经不同途径（粘贴 / 文件 / URL / 上游导出器）
 * 拿到时键序可能不同 ⇒ 直接串比对会把**内容相同**的判成「更新」，预览里满屏假「更新」。
 * ⇒ 这里先递归按**键名升序**重建再串化。数组顺序**保持原样**（规则数组的顺序有语义）。
 *
 * ## 边界（实测，不是推测）
 *  · 值为 `undefined` 的键**仍然占位** ⇒ 与「缺失该键」**视为不同**
 *    （`JSON.stringify({a:undefined})==='{}'`，但 `Object.keys` 里有 `'a'` ⇒ 本实现看键集，不看 JSON 输出）；
 *  · `null` 与「没有该键」**视为不同**（`null` 是显式值）；
 *  · 继承属性不算（`Object.keys` 只取自有键）。
 */
export function sameSourceRaw(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** 递归按**键名升序**串化（数组保序）；见 `sameSourceRaw` 的说明。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map((x) => stableStringify(x)).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 单条是否像 Legado 书源。
 *
 * ★ 判据**不在这里** —— 唯一实现在 `@yuedu/core/contract` 的 `isLegadoBookSource`（`#312`）。
 *   此前本文件与 `@yuedu/engine-legado` 的 `detectBookSource` **各写一份且已漂移**：
 *   本文件「有主键**或**有 bookSourceName 或有 ruleSearch/ruleBookInfo」，
 *   引擎侧「**必须**有主键**且**有搜索侧规则字段」⇒ 同一个源在导入层与引擎层结论可能相反，
 *   且两边都会误杀**纯发现源**（只有 `exploreUrl`）。
 * 上游口径（`BookSourceImport.kt:122-126` `requireBookSourceUrl()`）：**主键非空即书源**。
 */
function looksLegado(o: Record<string, unknown>): boolean {
  return isLegadoBookSource(o);
}

/** 单条是否像 MacCMS 源 */
function looksMaccms(o: Record<string, unknown>): boolean {
  if (typeof o['bookSourceUrl'] === 'string') return false;
  /** `#653` 与 `detectCmsSource` 同口径：OmniFlow 导出形态把接口根放在 `cms.base` */
  const cms = o['cms'];
  const api = o['apiUrl'] ?? o['api'] ?? (cms && typeof cms === 'object' ? (cms as Record<string, unknown>)['base'] : undefined);
  return typeof api === 'string' && api.trim().length > 0;
}

/**
 * 单条是否像 Legado RSS 订阅源（RssSource.kt 特征字段，BookSource 无这些字段；
 * 判别逻辑与 @yuedu/engine-rss 的 detectRssSource 一致——此处复制判别是因为
 * facade 不依赖引擎包，且只判「格式归属」不编译）。
 */
function looksRss(o: Record<string, unknown>): boolean {
  if (typeof o['bookSourceUrl'] === 'string') return false;
  if (typeof o['sourceUrl'] !== 'string' || !o['sourceUrl']) return false;
  return (
    typeof o['ruleArticles'] === 'string'
    || typeof o['sortUrl'] === 'string'
    || typeof o['articleStyle'] === 'number'
    || o['singleUrl'] === true
    || typeof o['nextContentUrl'] === 'string'
    || typeof o['startHtml'] === 'string'
    || typeof o['shouldOverrideUrlLoading'] === 'string'
  );
}

// （TVBox 配置导入已移除：本仓库没有 TVBox 引擎，相关源无法落地，故不再做 TVBox 识别/展开）

/**
 * 格式识别：数组时按前 10 条样本投票（避免首条占位条误判）。
 * 一条都对不上时返回 `null`（调用方 `detectImportFormat` 兜底成 legado）。
 *
 * ★ 保留 `null` 是为了区分「真有 legado 特征」与「谁都不认」：
 *   后者不能拿来说「内容更像 Legado」—— 那是假提示，会把用户带偏。
 */
function voteImportFormat(raw: unknown): ImportFormat | null {
  if (Array.isArray(raw)) {
    const sample = raw.slice(0, 10).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
    let legado = 0;
    let maccms = 0;
    let rss = 0;
    for (const it of sample) {
      if (looksLegado(it)) legado++;
      else if (looksMaccms(it)) maccms++;
      else if (looksRss(it)) rss++;
    }
    if (legado + maccms + rss === 0) return null;
    if (rss > 0 && rss >= legado && rss >= maccms) return 'rss';
    if (maccms > legado) return 'maccms';
    return 'legado';
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (looksRss(o)) return 'rss';
    if (looksMaccms(o)) return 'maccms';
    if (looksLegado(o)) return 'legado';
  }
  return null;
}

export function detectImportFormat(raw: unknown): ImportFormat {
  return voteImportFormat(raw) ?? 'legado';
}

/** 格式的中文名（错误/提示文案统一用词，避免各处叫法不一） */
export function formatLabel(f: ImportFormat): string {
  return f === 'legado' ? 'Legado 书源' : f === 'rss' ? 'RSS 订阅源' : 'CMS 影视源';
}

/**
 * 单条「实际像什么」（`null` = 什么特征都不够）。
 * 仅用于**显式选错格式**时把报错说清楚：不是靠它做识别（识别用 `voteImportFormat`）。
 */
function looksLikeKind(o: Record<string, unknown>): ImportFormat | null {
  if (looksLegado(o)) return 'legado';
  if (looksRss(o)) return 'rss';
  if (looksMaccms(o)) return 'maccms';
  return null;
}

/**
 * 显式指定格式 `want` 但该条缺主键时，返回一句「选错类型」的原因。
 *
 * 用户原话（2026-11-16）：导入 Legado 订阅源时选了「legado 书源」，只看到
 * 「缺少 bookSourceUrl」这类字段级报错，不知道其实是**格式选错**。
 * ⇒ 认出这条其实是 RSS/CMS 时直接点名该选哪个。
 */
function mismatchReason(o: Record<string, unknown>, want: ImportFormat, index: number): string {
  const actual = looksLikeKind(o);
  if (actual && actual !== want) {
    const key = actual === 'legado' ? 'bookSourceUrl' : actual === 'rss' ? 'sourceUrl' : 'apiUrl';
    return `第 ${index} 条是 ${formatLabel(actual)}（含 ${key}），与所选格式「${formatLabel(want)}」不符：请选择「${formatLabel(actual)}」或「自动识别」`;
  }
  const key = want === 'legado' ? 'bookSourceUrl' : want === 'rss' ? 'sourceUrl' : 'apiUrl';
  return `第 ${index} 条缺少 ${key}（${formatLabel(want)}必需）`;
}

// （MacCMS 接口有效性交由引擎运行时校验；导入层只要求 apiUrl 为非空 http(s) 地址）

function groupOf(raw: Record<string, unknown>): string {
  // RSS 订阅源的分组字段是 `sourceGroup`（`RssSource.kt`），读过 `group` 也兼容手工整理的清单
  return str(raw['bookSourceGroup']) || str(raw['sourceGroup']) || str(raw['group']);
}

/** 把默认分组写进 raw（仅在源自身没有分组时；id 保持稳定不受分组影响） */
function withDefaultGroup(raw: Record<string, unknown>, kind: string, defaultGroup?: string): Record<string, unknown> {
  const g = defaultGroup?.trim();
  if (!g || groupOf(raw)) return raw;
  // 每种引擎读的分组字段不同：写错键 = 默认分组静默失效
  if (kind === 'legado') return { ...raw, bookSourceGroup: g };
  if (kind === 'rss') return { ...raw, sourceGroup: g };
  return { ...raw, group: g };
}

/**
 * 解析「CMS 文本清单」：每行一条 `name,apiUrl`（逗号分隔，URL 必须是 http(s)）。
 * 用于非 JSON 的批量导入（大量影视源站常以此格式分发）。
 * 仅当文本整体像清单时才认（≥60% 数据行符合），否则交回 JSON 错误路径。
 */
function tryCmsLines(text: string): Array<Record<string, unknown>> | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const data = lines.filter((l) => !l.startsWith('#'));
  if (data.length === 0) return null;
  const rows: Array<Record<string, unknown>> = [];
  let matched = 0;
  for (const line of data) {
    const idx = line.indexOf(',');
    if (idx <= 0) continue; // 没有逗号，或名字为空
    const name = line.slice(0, idx).trim();
    const url = line.slice(idx + 1).trim();
    if (!name || !/^https?:\/\//i.test(url)) continue;
    matched++;
    rows.push({ name, apiUrl: url });
  }
  if (matched === 0 || matched < Math.ceil(data.length * 0.5)) return null;
  return rows;
}

/**
 * 解析导入文本。`text` 可以是 JSON 原文；已是对象的也可直接传（`value`）。
 * 只做语法/结构层解析 —— **不**做引擎编译（那一步由 hub.previewImport 干，以便把
 * 「能解析但编译不过」的条目也如实报成错误）。
 */
export function parseImportText(
  input: string | unknown,
  opts: { format?: ImportFormatHint; defaultGroup?: string } = {},
): ImportParseResult {
  const preview = typeof input === 'string' ? input.trim().slice(0, 140) : JSON.stringify(input ?? '').slice(0, 140);
  const errors: Array<{ index: number; reason: string }> = [];
  /** 当文本是「CMS 文本清单」时被设为 'maccms'（忽略格式下拉，清单即 CMS） */
  let forcedFormat: ImportFormat | null = null;

  let parsed: unknown = input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t) {
      return { format: 'legado', parsedTotal: 0, rows: [], errors: [{ index: 0, reason: '内容为空' }], preview };
    }
    // XML/RSS/Atom 之类：这是**订阅内容本身**，不是可导入的源配置，如实说清楚
    if (/^\s*<(\?xml|rss|feed|html)\b/i.test(t)) {
      return {
        format: 'legado',
        parsedTotal: 0,
        rows: [],
        errors: [{ index: 0, reason: '这是 XML / RSS / HTML 文本（网页或订阅内容本身），不是源配置 JSON；导入 Legado 订阅源请提供含 sourceUrl 字段的订阅源 JSON' }],
        preview,
      };
    }
    try {
      parsed = JSON.parse(t);
    } catch {
      // 非 JSON：尝试当作「name,apiUrl」文本清单（CMS 批量导入）
      const cmsLines = tryCmsLines(t);
      if (cmsLines) {
        parsed = cmsLines;
        forcedFormat = 'maccms';
      } else {
        return {
          format: opts.format && opts.format !== 'auto' ? opts.format : 'legado',
          parsedTotal: 0,
          rows: [],
          errors: [{ index: 0, reason: '既不是合法的书源 JSON，也不是「name,apiUrl」形式的 CMS 文本清单' }],
          preview,
        };
      }
    }
  }

  const explicitFormat: ImportFormat | null = opts.format && opts.format !== 'auto' ? opts.format : null;
  const format: ImportFormat = forcedFormat ?? explicitFormat ?? detectImportFormat(parsed);

  /**
   * 显式指定的格式与内容实际特征不符 ⇒ 给一句整体提示（逐条 errors 只说明缺哪个字段，
   * 不足以让用户意识到「是格式选错了」）。`voteImportFormat` 返回 null（谁都不认）时不给，
   * 免得编出「内容更像 Legado」这种假提示。
   */
  let hint: string | undefined;
  if (explicitFormat && !forcedFormat) {
    const actual = voteImportFormat(parsed);
    if (actual && actual !== explicitFormat) {
      hint = `检测到这批内容更像「${formatLabel(actual)}」，与所选格式「${formatLabel(explicitFormat)}」不符：请把格式切到「${formatLabel(actual)}」或「自动识别」`;
    }
  }

  const push = (raw: Record<string, unknown>, kind: string): void => {
    const withGroup = withDefaultGroup(raw, kind, opts.defaultGroup);
    const id = deriveId(withGroup, kind);
    const name =
      str(withGroup['bookSourceName']) || str(withGroup['sourceName']) || str(withGroup['name']) || str(withGroup['apiUrl']) || str(withGroup['api']) || id;
    rows.push({ id, kind, name, group: groupOf(withGroup) || undefined, raw: withGroup });
  };

  const rows: ImportRow[] = [];
  /** 解析出的候选条目数（不含「lives 已忽略」这类整体提示） */
  let parsedTotal = 0;

  if (Array.isArray(parsed)) {
    parsedTotal = parsed.length;
    parsed.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push({ index: i + 1, reason: '不是 JSON 对象' });
        return;
      }
      const o = it as Record<string, unknown>;
      if (format === 'legado') {
        if (!str(o['bookSourceUrl'])) {
          errors.push({ index: i + 1, reason: mismatchReason(o, 'legado', i + 1) });
          return;
        }
        push(o, 'legado');
      } else if (format === 'rss') {
        if (!str(o['sourceUrl'])) {
          errors.push({ index: i + 1, reason: mismatchReason(o, 'rss', i + 1) });
          return;
        }
        push(o, 'rss');
      } else {
        const api = str(o['apiUrl']) || str(o['api']);
        if (!api) {
          errors.push({ index: i + 1, reason: mismatchReason(o, 'maccms', i + 1) });
          return;
        }
        push(o, 'maccms');
      }
    });
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    parsedTotal = 1;
    if (format === 'legado') {
      if (!str(o['bookSourceUrl'])) errors.push({ index: 1, reason: mismatchReason(o, 'legado', 1) });
      else push(o, 'legado');
    } else if (format === 'rss') {
      if (!str(o['sourceUrl'])) errors.push({ index: 1, reason: mismatchReason(o, 'rss', 1) });
      else push(o, 'rss');
    } else {
      const api = str(o['apiUrl']) || str(o['api']);
      if (!api) errors.push({ index: 1, reason: mismatchReason(o, 'maccms', 1) });
      else push(o, 'maccms');
    }
  } else {
    errors.push({ index: 0, reason: '顶层必须是 JSON 对象或数组' });
  }

  return { format, parsedTotal, rows, errors, preview, ...(hint ? { hint } : {}) };
}
