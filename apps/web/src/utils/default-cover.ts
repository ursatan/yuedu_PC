/**
 * 「设置 → 外观 → 默认封面」自定义图片的**存储层**。
 *
 * ## 为什么用 IndexedDB，而不是 data URL 塞进偏好
 * 偏好是一份 JSON：本地 localStorage + 服务端 `data/kv.json`（见 `stores/reader.ts`
 * 的 `PREFS_LOCAL_KEY` / `/api/user/prefs`）。把几 MB 的图片字节塞进去，
 * 既会撑爆 localStorage 的 ~5MB 配额，也会让每次偏好同步把整张图搬一遍。
 *
 * ⇒ **图片字节只进 IndexedDB，偏好里只留一个标记串**（{@link DEFAULT_COVER_MARKER}）：
 * · Web（浏览器）：IndexedDB 就是浏览器的标准持久化，重启/刷新自动恢复；
 * · Electron：渲染进程的 IndexedDB 落在 Chromium 的 userData 目录
 *   （`…/Local Storage/leveldb` 与 IndexedDB 分支），即「落到用户数据目录」，
 *   不写 `data/kv.json`，也不需要给主进程加 IPC。
 *
 * ## 跨设备/跨浏览器的坦白话
 * 偏好同步到服务端时只同步标记串；**另一台设备没那张图** ⇒ 解析时静默回落内置默认封面
 * （见 `resolveDefaultCoverBg`）。这比「同步一张二进制图」或「同步后封面变白」都干净。
 */
import { ref } from 'vue';
import type { UiCoverConfig } from '@yuedu/core/contract';
import {
  DEFAULT_COVER_MARKER,
  resolveDefaultCoverBg,
  validateDefaultCoverFile,
} from './default-cover-core';

const DB_NAME = 'yuedu-default-cover';
const DB_VERSION = 1;
const STORE = 'images';
const RECORD_KEY = 'default-cover';

/** 压缩后的最长边（原图更大就等比缩小；小于它不放大） */
const MAX_W = 900;
const MAX_H = 1350;

/**
 * 当前可用的**对象地址**（`blob:`）。空串 = 没有自定义图 / 读不出来。
 * 组件里通过 {@link resolveDefaultCoverBg} 读它，所以这里必须是响应式 ref。
 */
export const customDefaultCoverUrl = ref('');

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readBlob(): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    void openDb().then((db) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(RECORD_KEY);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => reject(req.error);
    }, reject);
  });
}

function writeBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    void openDb().then((db) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }, reject);
  });
}

function deleteBlob(): Promise<void> {
  return new Promise((resolve, reject) => {
    void openDb().then((db) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }, reject);
  });
}

/** 旧对象地址要主动释放，否则每次换图都会多占一份内存 */
function setCustomUrl(url: string): void {
  const prev = customDefaultCoverUrl.value;
  if (prev && prev !== url) URL.revokeObjectURL(prev);
  customDefaultCoverUrl.value = url;
}

/** 预加载：确认这张图**真的能解码**再拿去设置，避免「切过去一闪/白块」 */
function preload(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(true);
    im.onerror = () => resolve(false);
    im.src = url;
  });
}

/**
 * 启动时调用（挂载前）：
 * · 读得到且能解码 ⇒ 生成对象地址，首帧就是自定义图（**不会先闪内置图再换**）；
 * · 读不到 / 解码失败 ⇒ 删除坏记录，保持空串 ⇒ 全局回落内置默认封面。
 */
export async function hydrateDefaultCoverImage(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const blob = await readBlob();
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) return;
    const url = URL.createObjectURL(blob);
    if (await preload(url)) {
      setCustomUrl(url);
    } else {
      URL.revokeObjectURL(url);
      await deleteBlob().catch(() => {});
    }
  } catch (e) {
    console.warn('[default-cover] 自定义默认封面读取失败（回落内置图）：', e);
  }
}

/**
 * 选图后的入口：校验 → 解码 → 等比压到 {@link MAX_W}/{@link MAX_H} → 落 IndexedDB → 生成对象地址。
 * 任何一步失败都抛**用户看得懂**的错（调用方 toast/提示），且**不改动现有图**。
 */
export async function saveDefaultCoverImage(file: File): Promise<void> {
  if (!idbAvailable()) throw new Error('当前环境不支持本地图片存储（IndexedDB 不可用）');
  const reject = validateDefaultCoverFile({ name: file.name, type: file.type, size: file.size });
  if (reject === 'empty') throw new Error('这个文件是空的，换一张图片试试');
  if (reject === 'size') throw new Error('图片超过 2MB —— 请压缩后再选');
  if (reject === 'type') throw new Error('只支持 PNG / JPG / WebP 图片');

  let compressed: Blob;
  try {
    compressed = await compressImage(file);
  } catch {
    throw new Error('图片已损坏或格式不受支持，无法解析');
  }

  const url = URL.createObjectURL(compressed);
  if (!(await preload(url))) {
    URL.revokeObjectURL(url);
    throw new Error('图片已损坏或格式不受支持，无法解析');
  }
  await writeBlob(compressed);
  setCustomUrl(url);
}

/** 删除自定义图（「恢复默认」/「清除」共用），并释放对象地址 */
export async function removeDefaultCoverImage(): Promise<void> {
  if (idbAvailable()) {
    try {
      await deleteBlob();
    } catch (e) {
      console.warn('[default-cover] 删除自定义默认封面失败：', e);
    }
  }
  setCustomUrl('');
}

/**
 * 等比缩放到最长边 ≤ {@link MAX_W}x{@link MAX_H}，输出 WebP（不支持时浏览器自己回落 PNG）。
 * 不放大：原图比目标尺寸小就按原尺寸画。
 */
async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_W / bitmap.width, MAX_H / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 不可用');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (!out || out.size <= 0) throw new Error('图片编码失败');
    return out;
  } finally {
    bitmap.close?.();
  }
}

/**
 * 界面/组件统一的取值入口：偏好里的路径 → 真正能画的地址。
 * `builtIn` 由调用方给（`coverParamsFor` 已经兜过内置图，这里再兜一次防漏）。
 */
export function defaultCoverBg(path: string | null | undefined, builtIn: string): string {
  return resolveDefaultCoverBg(path, builtIn, customDefaultCoverUrl.value);
}

/** 这次写入是不是「自定义图片」标记（设置页按钮/状态文案用） */
export function isCustomCover(cfg: Pick<UiCoverConfig, 'defaultCoverPath' | 'defaultCoverDarkPath'>): boolean {
  const p = String(cfg.defaultCoverPath ?? '').trim();
  const d = String(cfg.defaultCoverDarkPath ?? '').trim();
  return p === DEFAULT_COVER_MARKER || d === DEFAULT_COVER_MARKER;
}
