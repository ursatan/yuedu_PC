/**
 * `#208` **WebDAV 配置持久化 + 阅读进度同步**（服务端侧）。
 *
 * 上游对照：`AppWebDav.kt` 的 `upConfig()` / `downloadAllBookProgress()` / `uploadBookProgress()`。
 * 逐条对齐，三处**有意差异**写在各自的函数上。
 *
 * ## 上游语义（逐条）
 * - 配置门槛 = 账号与密码都非空（`upConfig` 里两者都空 ⇒ `authorization = null`，功能整体关闭）。
 * - 同步一次 = **先下载全部进度**（`downloadAllBookProgress`）再按本上传；
 *   下载时的哨兵是 `book.syncTime`：`webDavFile.lastModify <= book.syncTime` ⇒ 跳过（本地更新过就不回拉）。
 * - 采用远端的前提是**更远**（`durChapterIndex`/`durChapterPos` 比较），不是「时间更新」。
 * - 上传成功后把 `book.syncTime` 写成当前时间（`AppWebDav.kt:257`）。
 *
 * ## 与上游的一处**有意差异**
 * 上游 `uploadBookProgress` 是**无条件 PUT 本地进度** ⇒ 若远端更远（比如另一台设备读得更后），
 * 一次上传就把远端**冲掉**了。本仓在上传前先做一次 `mergeBookProgress`：远端更远就先采用远端，
 * 再把合并结果传回去 ⇒ 两端都满足「只前进不后退」。判据在 `@yuedu/core/book-progress.ts`，两端共用同一份。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  bookProgressFileName,
  bookProgressOf,
  emptyWebDavConfig,
  mergeBookProgress,
  parseBookProgress,
  publicWebDavConfig,
  sameProgress,
  validateWebDavConfig,
  webDavProgressRoot,
  type BookProgress,
  type UserDataStore,
  type WebDavConfig,
} from '@yuedu/core';
import { WebDavClient, WebDavError, type WebDavHttp } from '@yuedu/facade';

/**
 * `B7` ④ 云端备份保留份数：1~10，**默认 1（只保留最新）**。
 * 上限 10 是产品约束：再多就不是「轮转」而是「归档」，且列表/MinIO 目录都会变重。
 */
export const DEFAULT_BACKUP_KEEP = 1;
export const MAX_BACKUP_KEEP = 10;

export function clampBackupKeep(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_BACKUP_KEEP;
  return Math.min(MAX_BACKUP_KEEP, Math.max(1, v));
}

/** 落盘形态（配置 + 开关一起存，避免「配置在 A 文件、开关在 B 文件」的漂移） */
interface WebDavStoreFile {
  config: WebDavConfig;
  /** 是否同步阅读进度（上游 `AppConfig.syncBookProgress`，默认 true） */
  syncProgress: boolean;
  /** `B7` ④ 备份轮转保留份数（1~10，默认 1） */
  backupKeep?: number;
}

export interface WebDavState {
  /** 是否**已配置**（账号密码齐全） */
  configured: boolean;
  /** 对外配置（**密码已被抹掉**） */
  config: ReturnType<typeof publicWebDavConfig>;
  syncProgress: boolean;
  /** `B7` ④ 云端备份保留份数（1~10） */
  backupKeep: number;
}

/**
 * WebDAV 配置的落盘存储。
 *
 * 写盘用**临时文件 + rename**（原子替换）—— 与 `share-direct-link.ts` 同一理由：
 * 写一半掉电会留下半截 json ⇒ 下次启动解析失败 ⇒ 静默回落「未配置」，用户会以为配置自己没了。
 */
export class WebDavConfigStore {
  private data: WebDavStoreFile | null;

  constructor(private readonly file: string) {
    this.data = this.read();
  }

  private read(): WebDavStoreFile | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const o = raw as Record<string, unknown>;
      const v = validateWebDavConfig(o['config']);
      if (!v.ok) return null; // 手改坏的配置 ⇒ 当作「未配置」（对齐上游 getOrNull 的宽容）
      return {
        config: v.config,
        syncProgress: o['syncProgress'] !== false,
        backupKeep: clampBackupKeep(o['backupKeep']),
      };
    } catch {
      return null;
    }
  }

  /** 已配置则返回配置，否则 null（上游 `authorization` 为 null = 功能关） */
  getConfig(): WebDavConfig | null {
    return this.data?.config ?? null;
  }

  syncProgressEnabled(): boolean {
    return this.data?.syncProgress !== false;
  }

  backupKeepCount(): number {
    return clampBackupKeep(this.data?.backupKeep);
  }

  put(config: WebDavConfig, syncProgress = true, backupKeep?: number): void {
    this.data = {
      config,
      syncProgress,
      // 不传 ⇒ 沿用旧值（同步/测试等只改配置的调用不会把轮转设置冲成默认值）
      backupKeep: clampBackupKeep(backupKeep ?? this.data?.backupKeep ?? DEFAULT_BACKUP_KEEP),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  setSyncProgress(on: boolean): void {
    if (!this.data) return; // 没配置时开关无意义（界面也该禁用它）
    this.put(this.data.config, on);
  }

  /** 只改「备份保留份数」；界面上是独立入口，不必把账号密码一起重存 */
  setBackupKeep(n: number): void {
    if (!this.data) return;
    this.put(this.data.config, this.syncProgressEnabled(), clampBackupKeep(n));
  }

  /** 删掉配置（连同开关） */
  del(): void {
    this.data = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* 删不掉也不影响（内存里已经清空），下次 put 会覆盖 */
    }
  }

  state(): WebDavState {
    const cfg = this.getConfig();
    return {
      configured: cfg !== null,
      config: publicWebDavConfig(cfg ?? emptyWebDavConfig()),
      syncProgress: this.syncProgressEnabled(),
      backupKeep: this.backupKeepCount(),
    };
  }
}

/** 同步报告（界面直接显示这些数字） */
export interface SyncReport {
  /** 本地书架书数 */
  books: number;
  /** 远端进度文件数 */
  remoteFiles: number;
  /** 实际下载的进度文件数（过了 syncTime 哨兵的） */
  downloaded: number;
  /** 采用了远端（本地被往前推）的书的 url */
  adopted: string[];
  /** 上传到远端的书的 url */
  uploaded: string[];
  /** 因为「远端不比本地新」而跳过的书数 */
  skipped: number;
  /** 逐条错误（**不中断**整个同步；书名 + 原因） */
  errors: Array<{ bookUrl: string; name: string; error: string }>;
}

function emptyReport(): SyncReport {
  return { books: 0, remoteFiles: 0, downloaded: 0, adopted: [], uploaded: [], skipped: 0, errors: [] };
}

export interface SyncOptions {
  /** 注入 HTTP（单测打桩） */
  http?: WebDavHttp;
  /** 当前时间（测试可注入） */
  now?: number;
  /** 只下载不上传（界面「只看远端」用途） */
  downloadOnly?: boolean;
}

/**
 * 同步一次阅读进度。
 *
 * ★ **不会因为某一本书失败就中断**：一本书的进度文件写坏、或某个书名在远端取不到，
 * 只记进 `errors`，其余书照常同步（静默跳过会让用户以为「都同步了」—— 铁律 3 要求留痕）。
 */
export async function syncBookProgress(
  store: UserDataStore,
  configStore: WebDavConfigStore,
  opts: SyncOptions = {},
): Promise<SyncReport> {
  const report = emptyReport();
  const cfg = configStore.getConfig();
  if (!cfg) throw new Error('WebDAV 还没配置（先填账号密码并点「测试」）');
  if (!configStore.syncProgressEnabled()) throw new Error('阅读进度同步已关闭（在设置里打开它）');

  const now = opts.now ?? Date.now();
  const client = new WebDavClient(cfg, opts.http ? { http: opts.http } : {});
  const progressRoot = webDavProgressRoot(client.root);

  // 目录可能还没建（首次同步）⇒ 建一次；失败不致命（有些网盘对已存在目录回 405）
  await client.makeAsDir(progressRoot);

  let remote: Awaited<ReturnType<WebDavClient['listFiles']>> = [];
  try {
    remote = await client.listFiles(progressRoot);
  } catch (e) {
    // 列不出目录就没有「远端」可言 —— 这是**整体的**失败，应当抛出让端点回 502
    throw new Error(`列不出远端进度目录（${progressRoot}）：${describe(e)}`);
  }
  report.remoteFiles = remote.length;
  const remoteByName = new Map<string, { url: string; lastModify: number }>();
  for (const f of remote) {
    if (f.isDir) continue;
    remoteByName.set(f.displayName, { url: f.url, lastModify: f.lastModify });
  }

  const books = await store.listBooks();
  report.books = books.length;

  for (const book of books) {
    const fileName = bookProgressFileName(book.name, book.author);
    const hit = remoteByName.get(fileName);
    let remoteProgress: BookProgress | null = null;

    if (hit && hit.lastModify > (book.syncTime ?? 0)) {
      try {
        const text = await client.downloadText(hit.url);
        report.downloaded += 1;
        const parsed = parseBookProgress(text);
        if (!parsed) {
          report.errors.push({
            bookUrl: book.bookUrl,
            name: book.name,
            error: `远端的 ${fileName} 不是有效的进度文件，已跳过（不会改动本地进度）`,
          });
          continue;
        }
        remoteProgress = parsed;
      } catch (e) {
        report.errors.push({ bookUrl: book.bookUrl, name: book.name, error: `下载进度失败：${describe(e)}` });
        continue;
      }
    }

    const local = bookProgressOf(book);
    // ★ `final` 是本次同步后**应当生效**的进度：采用远端时它就是远端的值。
    //   后面所有写库与上传都必须用它 —— 若图省事再用 `local`，会把刚采用的远端**又覆盖回去**。
    let final: BookProgress = local;

    if (remoteProgress) {
      const merged = mergeBookProgress(local, remoteProgress);
      final = merged.progress;
      if (merged.adoptedRemote) {
        await store.saveProgress(book.bookUrl, {
          durChapterIndex: final.durChapterIndex,
          durChapterPos: final.durChapterPos,
          durChapterTime: final.durChapterTime,
          durChapterTitle: final.durChapterTitle,
          syncTime: now,
        });
        report.adopted.push(book.bookUrl);
      } else {
        report.skipped += 1;
      }
    }

    if (opts.downloadOnly) continue;
    // 上传：远端没有 ⇒ 首次同步要传；远端有但比本地落后 ⇒ 把 `final`（= 本地）传回去
    if (remoteProgress && sameProgress(final, remoteProgress)) continue;
    try {
      await client.upload(`${progressRoot}${fileName}`, JSON.stringify(final), 'application/json');
      report.uploaded.push(book.bookUrl);
      // 上游：上传成功后记 syncTime（下次同步时这个文件的 lastModify 就不会再被当成「更新」）
      await store.saveProgress(book.bookUrl, {
        durChapterIndex: final.durChapterIndex,
        durChapterPos: final.durChapterPos,
        durChapterTime: final.durChapterTime,
        durChapterTitle: final.durChapterTitle,
        syncTime: now,
      });
    } catch (e) {
      report.errors.push({ bookUrl: book.bookUrl, name: book.name, error: `上传进度失败：${describe(e)}` });
    }
  }

  return report;
}

function describe(e: unknown): string {
  if (e instanceof WebDavError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
