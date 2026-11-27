/**
 * `#621` **备份：可勾选内容 + AES 加密**
 *
 * 上游依据（逐条对照，`F:\legado`）：
 * - `app/src/main/java/io/legado/app/help/storage/BackupConfig.kt:59-113`
 *   —— 12 个勾选键（`backupBookshelf` / `backupAnnotations` / `backupSources` / `backupRules` /
 *   `backupHistory` / `backupReadRecordCovers` / `backupSettings` / `backupPersistedCovers` /
 *   `backupOtherCovers` / `backupBackgrounds` / `backupCookies` / `backupSourceVariables`）
 * - `Backup.kt:60-112` `selectedBackupFileNames()` —— **勾选键 → zip 内条目名**的映射
 * - `Backup.kt:245-262` —— 口令为空却勾了 cookies / 源变量 ⇒ **直接抛错**（既不静默漏敏感数据、
 *   也不静默跳过勾选项）；文案取自 `values-zh/strings.xml:1444-1445`
 * - `Backup.kt:311-330` —— `servers.json` / `cookies.json` / `runtimeSourceCache.json` 用
 *   `aes.encryptBase64(...)` **逐条目加密后写文本**；**整个 zip 不加密**
 * - `BackupAES.kt` —— 密钥推导，移植在 `./backup-aes.ts`（已与 `openssl` 逐字节对齐）
 *
 * ## 本仓的形态：**单条目快照 + 可选加密附件**（与上游多条目不同，理由见下）
 * 本仓 `D6=A` 早已定下「一份完整快照」（`#201` 的 `/api/user/snapshot` + `importSnapshot`）。
 * 上游是「一实体一 json」，恢复时逐文件解析。改成多条目意味着**重写整条恢复管线**，
 * 而收益只有「与手机端备份互通」—— 而互通本来就不成立（`webdav-backup.ts` 已注明：
 * 手机端 zip 本仓打不开，字段名与实体表都不同）。所以继续用单条目：
 *
 * ```
 * yuedu-snapshot.json      主快照（JSON 明文；按勾选项裁剪）
 * cookies.json             ← 勾了「持久 Cookie」才有；内容 = AES(JSON) 的 Base64 文本
 * runtimeSourceCache.json  ← 勾了「源变量」才有；同上
 * ```
 *
 * 后两个**沿用上游文件名与加密参数**，所以将来真要做「导出给手机端」也不用改格式。
 *
 * ## ★ 本文件存在的核心理由：`included`
 * 上游用「文件不存在」表达「这项没勾」，恢复端靠 `file.exists()` 判断。
 * 单条目快照里没有这个信号 ⇒「没勾」与「勾了但恰好为空」**长得一模一样**。
 * 若不处理，一次「只备份书签」的恢复会在用户以为安全的时候把其它字段按空值写进去
 * （`importSnapshot` 的 `overwrite` 分支是**置值**语义）—— 静默数据丢失。
 * 所以快照里必须写 `included: BackupOptionId[]`，恢复端**只处理 included 列出的字段**
 * （`filterSnapshotByIncluded`）。
 *
 * 旧备份（`#208` ④ 产出的，没有 `included`）按「快照里实际有哪些字段就恢复哪些」处理 ——
 * 否则老备份一恢复就变成什么都不做。
 */

import type { GlobalReaderPrefs, ShelfBook, ShelfChapter, UserDataStore } from '@yuedu/core';
import { createZip, readZip } from '@yuedu/facade';
import { decryptBackupText, encryptBackupText, isProbablyEncrypted } from './backup-aes';
import { buildSnapshot, SNAPSHOT_VERSION, type UserSnapshot } from './user-snapshot';

/* ------------------------------------------------------------------ *
 * 勾选项
 * ------------------------------------------------------------------ */

/**
 * 本仓支持的勾选项。
 *
 * 与上游 12 项不是一对一：上游的「封面 / 背景图」在本仓**没有对应物**
 * （PC 端不落封面缓存、背景走 CSS），所以**不给出假选项** —— 一个勾了却什么也不做的
 * 选项比没有这个选项更坏（用户会以为备份了）。缺项列在 `UNSUPPORTED_BACKUP_OPTIONS`。
 */
export type BackupOptionId =
  | 'bookshelf'
  | 'annotations'
  | 'rules'
  | 'history'
  | 'settings'
  | 'chapters'
  | 'cookies'
  | 'sourceVariables';

export interface BackupOptionMeta {
  id: BackupOptionId;
  /** 界面标题（措辞对齐上游 `values-zh/strings.xml:978-992`） */
  label: string;
  /** 一句话说明「具体带了哪些数据」—— 勾选框旁边必须能看清，否则用户只能靠猜 */
  desc: string;
  /** 默认勾选 */
  defaultOn: boolean;
  /**
   * 敏感内容 ⇒ **必须**有口令才能备份（上游 `Backup.kt:245-262`）。
   * 敏感项进 zip 时是 AES 密文文本，不是明文 JSON。
   */
  sensitive?: boolean;
}

export const BACKUP_OPTIONS: readonly BackupOptionMeta[] = [
  { id: 'bookshelf', label: '书架与分组', desc: '书架条目（含阅读进度）+ 分组', defaultOn: true },
  { id: 'annotations', label: '书签与标注', desc: '书签 + 划线高亮 + 高亮规则', defaultOn: true },
  { id: 'rules', label: '规则与工具', desc: '替换净化规则 + 字典规则', defaultOn: true },
  { id: 'history', label: '阅读记录', desc: '各书累计阅读时长与最后阅读时间', defaultOn: true },
  { id: 'settings', label: '阅读设置', desc: '全局阅读偏好（字号、行距、翻页方式…）', defaultOn: true },
  { id: 'chapters', label: '书籍目录', desc: '每本书的目录（体量大，可能几十 MB；正文不在备份里）', defaultOn: false },
  {
    id: 'cookies',
    label: '持久 Cookie',
    desc: '各源的登录态 / cf_clearance（需口令，加密存放）',
    defaultOn: false,
    sensitive: true,
  },
  {
    id: 'sourceVariables',
    label: '源变量',
    desc: '各源「设置源变量」留下的状态（需口令，加密存放）',
    defaultOn: false,
    sensitive: true,
  },
];

/**
 * 上游有、本仓**没有对应物**的勾选项。
 *
 * 写在这里是为了让「不给假选项」这件事本身可 review：哪天真做了封面缓存/背景图，
 * 从这里删一项、往 `BACKUP_OPTIONS` 加一项即可。
 */
export const UNSUPPORTED_BACKUP_OPTIONS: ReadonlyArray<{ upstreamKey: string; label: string; why: string }> = [
  {
    upstreamKey: 'backupSources',
    label: '书源与订阅',
    why: '书源有独立的多源导入导出（直链上传 / 书源面板），不进整库备份',
  },
  { upstreamKey: 'backupReadRecordCovers', label: '阅读记录封面', why: '本仓不缓存阅读记录封面' },
  { upstreamKey: 'backupPersistedCovers', label: '书籍固化封面', why: '本仓不落封面文件（封面走远端 URL）' },
  { upstreamKey: 'backupOtherCovers', label: '其他封面文件', why: '本仓没有封面文件（与「书籍固化封面」同一个原因）' },
  { upstreamKey: 'backupBackgrounds', label: '阅读背景', why: '本仓阅读背景是主题/CSS，没有背景图文件' },
];

/** 默认勾选项集合 */
export function defaultBackupOptions(): Set<BackupOptionId> {
  return new Set(BACKUP_OPTIONS.filter((o) => o.defaultOn).map((o) => o.id));
}

/** 合法 id 集合（校验用） */
const OPTION_IDS = new Set<string>(BACKUP_OPTIONS.map((o) => o.id));

/** 备份相关错误：带 `code` 便于端点映射状态码、界面做分支提示（不必解析中文） */
export class BackupOptionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupOptionError';
    this.code = code;
  }
}

/**
 * 校验并规整勾选项。
 *
 * - 传 `undefined` ⇒ 用默认值（**不是**「全选」也不是「全不选」）
 * - 未知 id ⇒ **抛错**（打错一个字母就静默少备份一类数据，是必须留痕的错）
 * - 空数组 ⇒ 抛错（生成一份只有 `included: []` 的空备份没有意义，只会让用户以为存了东西）
 * - 勾了目录但没勾书架 ⇒ 抛错（目录挂在书上，恢复时没有书就没处放）
 */
export function normalizeBackupOptions(input?: readonly string[] | null): Set<BackupOptionId> {
  if (input === undefined || input === null) return defaultBackupOptions();
  const out = new Set<BackupOptionId>();
  const unknown: string[] = [];
  for (const raw of input) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    if (!OPTION_IDS.has(id)) unknown.push(id);
    else out.add(id as BackupOptionId);
  }
  if (unknown.length) {
    throw new BackupOptionError(
      'UNKNOWN_OPTION',
      `未知的备份内容：${unknown.join('、')}（可选：${[...OPTION_IDS].join(' / ')}）`,
    );
  }
  if (out.size === 0) {
    throw new BackupOptionError('EMPTY_OPTIONS', '至少要勾选一项备份内容（全不勾会生成一份空备份）');
  }
  if (out.has('chapters') && !out.has('bookshelf')) {
    throw new BackupOptionError(
      'CHAPTERS_NEED_SHELF',
      '勾了「书籍目录」就必须同时勾「书架与分组」：目录挂在书上，没有书就没处放',
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 条目名（对齐上游 `BackupConfig.cookieFileName` / `runtimeSourceCacheFileName`）
 * ------------------------------------------------------------------ */

export const SNAPSHOT_ENTRY = 'yuedu-snapshot.json';
export const COOKIE_ENTRY = 'cookies.json';
export const SOURCE_VAR_ENTRY = 'runtimeSourceCache.json';

/* ------------------------------------------------------------------ *
 * 打包
 * ------------------------------------------------------------------ */

/** 敏感项的数据来源（服务端注入：cookies 走 `hub.exportSourceCookies()`，源变量同理） */
export interface SensitiveProviders {
  /** `sourceId → "a=b; c=d"` */
  cookies?: () => Record<string, string>;
  /** `sourceId → 变量 JSON 串` */
  sourceVariables?: () => Record<string, string>;
}

export interface BuildBackupDeps extends SensitiveProviders {
  /**
   * 备份口令。**空 ⇒ 敏感项无法备份**（勾了就抛错，对齐上游 `Backup.kt:245-262`）。
   * 非空时**只**用于加密那两个敏感条目，主快照仍是明文（与上游一致）。
   */
  password?: string | null;
  /** 注入当前时间（测试可固定，产物才逐字节可比） */
  now?: number;
}

export interface BackupZipEntryReport {
  name: string;
  bytes: number;
  /** 是否 AES 密文 */
  encrypted: boolean;
}

export interface BuildBackupResult {
  zip: Uint8Array;
  /** 打了哪些条目（顺序即写入顺序；界面/日志直接显示这个） */
  entries: BackupZipEntryReport[];
  /** 实际勾选项（规整后） */
  included: BackupOptionId[];
  books: number;
  /** 勾了但本机没数据的敏感项（要告诉用户，别让他以为登录态备份上了） */
  skippedSensitive: Array<{ id: BackupOptionId; why: string }>;
}

/** 快照的实际形状（比 `UserSnapshot` 宽松：字段按勾选出现） */
export interface BackupSnapshot {
  version: number;
  exportedAt: number;
  /** ★ 本文件的核心：这份备份**带了哪些内容**（恢复端据此决定动哪些字段） */
  included: BackupOptionId[];
  books?: ShelfBook[];
  chapters?: Record<string, ShelfChapter[]>;
  bookmarks?: unknown[];
  highlights?: unknown[];
  replaceRules?: unknown[];
  highlightRules?: unknown[];
  dictRules?: unknown[];
  bookGroups?: unknown[];
  readRecords?: unknown[];
  /** 书内备注（Legado `BookMemo`） */
  bookMemos?: unknown[];
  /** 搜索历史（Legado `SearchKeyword`） */
  searchHistory?: unknown[];
  prefs?: GlobalReaderPrefs;
}

/**
 * 造一份备份 zip（纯产物，不上传）。
 *
 * 数据采集**复用** `buildSnapshot`（`#201` 的唯一采集实现）再按勾选**裁剪** ——
 * 不在这里重写一遍「从哪些表取什么」，否则快照导出与备份迟早漂移（`#247` 的教训）。
 */
export async function buildBackup(
  store: UserDataStore,
  options?: readonly string[] | null,
  deps: BuildBackupDeps = {},
): Promise<BuildBackupResult> {
  const on = normalizeBackupOptions(options);
  const now = deps.now ?? Date.now();
  const password = deps.password ?? '';

  // ★ 口令校验**前置**：先确认敏感项能不能备，再去读几十万行目录，
  //   否则一次必然失败的备份会白跑（也可能白读一遍库）。
  if (on.has('cookies') && !password) {
    throw new BackupOptionError(
      'PASSWORD_REQUIRED_COOKIES',
      '备份或恢复持久 Cookie 前，请先设置非空的本地密码。', // 上游 values-zh/strings.xml:1444
    );
  }
  if (on.has('sourceVariables') && !password) {
    throw new BackupOptionError(
      'PASSWORD_REQUIRED_SOURCE_VARS',
      '备份或恢复源变量前，请先设置非空的本地密码。', // 上游 values-zh/strings.xml:1445
    );
  }

  // 1) 采集（`includeChapters` 只在勾了目录时才去查，避免白读几十万行）
  const full: UserSnapshot = await buildSnapshot(store, { includeChapters: on.has('chapters'), now });

  // 2) 裁剪
  const snap: BackupSnapshot = { version: SNAPSHOT_VERSION, exportedAt: now, included: [...on] };
  if (on.has('bookshelf')) {
    snap.books = full.books;
    snap.bookGroups = full.bookGroups;
  }
  if (on.has('annotations')) {
    snap.bookmarks = full.bookmarks;
    snap.highlights = full.highlights;
    snap.highlightRules = full.highlightRules;
    snap.bookMemos = full.bookMemos;
  }
  if (on.has('rules')) {
    snap.replaceRules = full.replaceRules;
    snap.dictRules = full.dictRules;
  }
  if (on.has('history')) {
    snap.readRecords = full.readRecords;
    snap.searchHistory = full.searchHistory;
  }
  if (on.has('settings')) snap.prefs = full.prefs as GlobalReaderPrefs;
  if (on.has('chapters') && full.chapters) snap.chapters = full.chapters;

  // 3) 敏感附件
  const skippedSensitive: BuildBackupResult['skippedSensitive'] = [];
  const extras: Array<{ name: string; text: string }> = [];
  if (on.has('cookies')) {
    const data = deps.cookies?.() ?? {};
    if (Object.keys(data).length === 0) {
      skippedSensitive.push({ id: 'cookies', why: '本机没有已保存的 Cookie（还没登录过任何源）' });
    } else {
      extras.push({ name: COOKIE_ENTRY, text: encryptBackupText(JSON.stringify(data), password) });
    }
  }
  if (on.has('sourceVariables')) {
    const data = deps.sourceVariables?.() ?? {};
    if (Object.keys(data).length === 0) {
      skippedSensitive.push({ id: 'sourceVariables', why: '本机没有已保存的源变量' });
    } else {
      extras.push({ name: SOURCE_VAR_ENTRY, text: encryptBackupText(JSON.stringify(data), password) });
    }
  }

  // 4) 打包（时间戳用 now：同一次备份内所有条目同一时刻，测试可逐字节断言）
  const enc = new TextEncoder();
  const files = [
    { name: SNAPSHOT_ENTRY, data: enc.encode(JSON.stringify(snap)) },
    ...extras.map((e) => ({ name: e.name, data: enc.encode(e.text) })),
  ];
  const zip = createZip(files, { mtime: new Date(now) });

  return {
    zip,
    entries: files.map((f) => ({
      name: f.name,
      bytes: f.data.length,
      encrypted: f.name !== SNAPSHOT_ENTRY,
    })),
    included: [...on],
    books: snap.books?.length ?? 0,
    skippedSensitive,
  };
}

/* ------------------------------------------------------------------ *
 * 读取（恢复用）
 * ------------------------------------------------------------------ */

export interface ReadBackupResult {
  snapshot: BackupSnapshot;
  /** 快照声明的 included；**旧备份（无该字段）按「快照里有什么就是什么」推断** */
  included: BackupOptionId[];
  /** 解密后的 Cookie（`sourceId → "a=b; c=d"`）；没勾/没数据 ⇒ undefined */
  cookies?: Record<string, string>;
  sourceVariables?: Record<string, string>;
  /** 这份备份是不是旧格式（`#208` ④ 产出，无 `included`）—— 界面要能提示 */
  legacy: boolean;
}

/**
 * 解开一份备份 zip。
 *
 * 兼容三条路径：
 * 1. 新备份（有 `included`）⇒ 按 `included` 恢复
 * 2. 旧备份（无 `included`）⇒ 按快照实际字段推断（老备份不能变成「什么都不做」）
 * 3. 敏感条目：有口令就解；**确实是密文却没口令** ⇒ 抛错（不静默跳过，
 *    否则用户以为登录态恢复了、实际没有）
 */
export function readBackupArchive(
  bytes: Uint8Array,
  password?: string | null,
): ReadBackupResult {
  let map: Map<string, Uint8Array>;
  try {
    map = readZip(bytes);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new BackupOptionError('NOT_A_ZIP', `这不是一份有效的备份 zip：${why}`);
  }

  const snapRaw = map.get(SNAPSHOT_ENTRY);
  if (!snapRaw) {
    throw new BackupOptionError(
      'NO_SNAPSHOT',
      `备份里没有 ${SNAPSHOT_ENTRY}。若它是手机端 Legado 生成的备份，格式与本仓不同（本仓只认自己导出的 zip）`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(snapRaw));
  } catch {
    throw new BackupOptionError('BAD_SNAPSHOT', `备份里的 ${SNAPSHOT_ENTRY} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupOptionError('BAD_SNAPSHOT', '备份内容不是一份快照对象');
  }

  const dec = new TextDecoder('utf-8');
  const snap = parsed as BackupSnapshot;
  const legacy = !Array.isArray(snap.included);
  const included: BackupOptionId[] = legacy
    ? inferIncluded(snap)
    : (snap.included.filter((x) => OPTION_IDS.has(String(x))) as BackupOptionId[]);

  const out: ReadBackupResult = { snapshot: snap, included, legacy };

  const cookieText = map.get(COOKIE_ENTRY);
  if (cookieText) out.cookies = parseSensitive(dec.decode(cookieText), password, COOKIE_ENTRY);
  const varText = map.get(SOURCE_VAR_ENTRY);
  if (varText) out.sourceVariables = parseSensitive(dec.decode(varText), password, SOURCE_VAR_ENTRY);

  return out;
}

/**
 * 旧备份（无 `included`）的内容推断：**看快照里实际有哪些字段**。
 *
 * 比「当作全选」准确：手工裁剪过的老快照也不会被误判成「带了目录」。
 */
function inferIncluded(snap: BackupSnapshot): BackupOptionId[] {
  const out: BackupOptionId[] = [];
  if (snap.books || snap.bookGroups) out.push('bookshelf');
  if (snap.bookmarks || snap.highlights || snap.highlightRules) out.push('annotations');
  if (snap.replaceRules || snap.dictRules) out.push('rules');
  if (snap.readRecords) out.push('history');
  if (snap.prefs) out.push('settings');
  if (snap.chapters) out.push('chapters');
  return out;
}

/**
 * 按 `included` 裁掉快照里「没声明」的字段，再交给 `importSnapshot`。
 *
 * `importSnapshot` 本身对缺失字段是「不动」，但这条过滤仍有必要：
 * ① 手改过的备份里可能混入没声明的字段，不该被应用；
 * ② 恢复报告（`counts`）要能如实反映「这份备份声明了什么」。
 */
export function filterSnapshotByIncluded(
  snap: BackupSnapshot,
  included: readonly BackupOptionId[],
): Record<string, unknown> {
  const has = (id: BackupOptionId) => included.includes(id);
  const out: Record<string, unknown> = {};
  if (has('bookshelf')) {
    if (snap.books) out.books = snap.books;
    if (snap.bookGroups) out.bookGroups = snap.bookGroups;
  }
  if (has('chapters') && snap.chapters) out.chapters = snap.chapters;
  if (has('annotations')) {
    if (snap.bookmarks) out.bookmarks = snap.bookmarks;
    if (snap.highlights) out.highlights = snap.highlights;
    if (snap.highlightRules) out.highlightRules = snap.highlightRules;
  }
  if (has('rules')) {
    if (snap.replaceRules) out.replaceRules = snap.replaceRules;
    if (snap.dictRules) out.dictRules = snap.dictRules;
  }
  if (has('history') && snap.readRecords) out.readRecords = snap.readRecords;
  if (has('settings') && snap.prefs) out.prefs = snap.prefs;
  return out;
}

/**
 * 解一条敏感条目。
 *
 * - 有口令 ⇒ 必须能解开；解不开（口令错/密文损坏）⇒ 抛错。
 *   绝不允许「失败当空值」：恢复管线是**置值**语义，空值会把登录态清掉。
 * - 无口令但内容是明文 JSON ⇒ 照读（兼容：万一是手工放进来的明文）
 * - 无口令且内容是密文 ⇒ 抛错并明说「需要口令」
 */
function parseSensitive(
  text: string,
  password: string | null | undefined,
  entry: string,
): Record<string, string> {
  const raw = String(text ?? '').trim();
  if (!raw) return {};
  if (!isProbablyEncrypted(raw)) {
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
    } catch {
      throw new BackupOptionError('BAD_SENSITIVE_ENTRY', `备份里的 ${entry} 既不是密文也不是合法 JSON`);
    }
  }
  if (!password) {
    throw new BackupOptionError(
      'PASSWORD_REQUIRED',
      `备份里的 ${entry} 是加密的，恢复它需要备份口令（当初备份时设置的那个）`,
    );
  }
  let plain: string;
  try {
    plain = decryptBackupText(raw, password);
  } catch {
    // 口令错 ⇒ PKCS5 填充校验失败
    throw new BackupOptionError('BAD_PASSWORD', `口令不对：${entry} 解不开`);
  }
  try {
    const v = JSON.parse(plain) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    throw new BackupOptionError('BAD_SENSITIVE_ENTRY', `${entry} 解出来不是合法 JSON`);
  }
}
