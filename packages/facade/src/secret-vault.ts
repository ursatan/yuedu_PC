/**
 * `#616` **登录态落盘加密**（凭据保险箱）。
 *
 * ★ 上游依据（`F:\legado`，今日版）：
 *   `app/src/main/java/io/legado/app/data/entities/BaseSource.kt:255-325`
 *     · `getLoginInfo()`：读 `CacheManager.get("userInfo_${getKey()}")` → `AES(key).decryptStr(cache)`
 *     · `putLoginInfo(info)`：`SymmetricCryptoAndroid("AES", key).encryptBase64(info)` 再落 CacheManager
 *     · 密钥 = `AppConst.androidId.encodeToByteArray(0, 16)`（**设备本地**，16 字节）
 *   即：上游把**账号密码**加密后落盘，密钥是本设备标识，**不随备份/导出迁移**。
 *
 * 本仓移植要点（与上游的差异都在这里写明）：
 *   1. 算法：上游是 `AES`（16 字节密钥，Crypto-JS 系 CBC/PKCS7 + base64）；本仓用
 *      **AES-256-GCM**（Node `crypto`）—— 上游的 CBC 无 MAC、可篡改，GCM 更稳且实现短。
 *      ★ 这是**有意偏离**：安全强度更高，语义（加密后 base64 落盘、读时解密）一致。
 *   2. 密钥：本仓没有 `androidId`（`legado-parity` §2 里 `androidId` 判定为 ➖：Web/PC 无对应物，
 *      做了是假值）。改用**随机 32 字节密钥文件**（`data/vault.key`，0600，首次启动生成）。
 *      安全等级与上游相同（防「目录/备份被拷贝走后明文可读」，不防同机提权读文件）。
 *   3. 覆盖范围：上游只加密 `userInfo`（账号密码）；本仓**额外**把 `cookies.json` 也加密
 *      —— 因为 PC 端的 cookie 里有 `cf_clearance` / 登录 session，价值等同密码。
 *      ★ **上游无对应**（上游 `CookieStore` 是明文落 Room），属本仓自有加固，已在文档标注。
 *
 * 兼容：读路径**必须能吃旧明文**（升级前已存的 `kv.json` / `cookies.json`），
 *       读到明文就地加密回写一次（迁移），不丢数据。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { KeyValueStore } from '@yuedu/core';

/** 密文前缀：带它 = 已加密；不带 = 旧明文（迁移路径） */
export const VAULT_PREFIX = 'vault1:';

/** 需要加密的存储键前缀（登录信息 + 登录头；Cookie 由宿主在文件层整体加密） */
export const VAULT_KEY_PREFIXES = ['login-info:', 'login-header:'] as const;

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
let keyWarned = false;

/**
 * 取（或首次生成）保险箱密钥。
 *
 * 优先级：① `<DATA_DIR>/vault.key`（默认，随机 32 字节 base64，0600）；
 *            或用 `YUEDU_VAULT_KEY_FILE` 指定另一份密钥文件（换机恢复）。
 *
 * 拿不到密钥时**不加密**（fail-open）并留痕 —— 因为「登录态存不进去」比「明文落盘」更影响可用性，
 * 但按铁律 3 必须 warn，不能静默退化。
 */
export function vaultKey(keyFile?: string): Buffer | null {
  if (cachedKey) return cachedKey;
  const file =
    keyFile ?? process.env.YUEDU_VAULT_KEY_FILE ?? path.join(process.env.YUEDU_DATA_DIR ?? 'data', 'vault.key');
  try {
    if (fs.existsSync(file)) {
      const raw = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'base64');
      if (raw.length === 32) {
        cachedKey = raw;
        return cachedKey;
      }
    }
    const fresh = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh.toString('base64'), { mode: 0o600 });
    cachedKey = fresh;
    return cachedKey;
  } catch {
    if (!keyWarned) {
      keyWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[secret-vault] 无法读写密钥文件 ${file} ⇒ **登录态将明文落盘**（与加密前一致，功能不受影响）`,
      );
    }
    return null;
  }
}

/** 明文 → 密文串（无密钥时原样返回明文） */
export function sealSecret(plain: string, key: Buffer | null = vaultKey()): string {
  if (!key) return plain;
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([c.update(Buffer.from(plain, 'utf-8')), c.final()]);
  return VAULT_PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/**
 * 密文串 → 明文。**旧明文原样返回**（`sealed=false`，调用方据此决定是否迁移回写）。
 * 解密失败（换机/密钥丢失）返回 `null` —— 调用方按「没有登录态」处理，不要崩。
 */
export function openSecret(
  stored: string,
  key: Buffer | null = vaultKey(),
): { text: string; sealed: boolean; failed: boolean } {
  if (!stored.startsWith(VAULT_PREFIX)) return { text: stored, sealed: false, failed: false };
  if (!key) return { text: '', sealed: true, failed: true };
  try {
    const buf = Buffer.from(stored.slice(VAULT_PREFIX.length), 'base64');
    if (buf.length < IV_LEN + TAG_LEN) return { text: '', sealed: true, failed: true };
    const d = createDecipheriv(ALG, key, buf.subarray(0, IV_LEN));
    d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
    return { text: Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf-8'), sealed: true, failed: false };
  } catch {
    return { text: '', sealed: true, failed: true };
  }
}

export function isSealed(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.startsWith(VAULT_PREFIX);
}

/** 该键是否需要进保险箱 */
function needsVault(key: string): boolean {
  return VAULT_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * 把任意 `KeyValueStore` 包一层：**写入即加密、读出即解密**。
 *
 * 为什么做在存储层而不是改引擎：登录信息/登录头有 **6 处**读写点
 * （`engine-legado/src/engine.ts:1820/1831/1880/1895`、`engine-rss/src/engine.ts:267/273`、
 * `core/src/source-login.ts:140/148`、`facade/src/hub.ts:934/945/958`），
 * 逐点改会漏；而它们**全都走 `ctx.storage` 这一个接口** ⇒ 在接口上做透明加解密是唯一不漏的方案。
 */
export function createVaultStore(inner: KeyValueStore, key: Buffer | null = vaultKey()): KeyValueStore {
  return {
    async get(k: string): Promise<string | null> {
      const raw = await inner.get(k);
      if (raw == null) return raw;
      if (!needsVault(k)) return raw;
      const r = openSecret(raw, key);
      if (r.failed) return null;
      // 旧明文 ⇒ 就地加密回写一次（迁移），不阻塞返回
      if (!r.sealed && key) void inner.set(k, sealSecret(r.text, key));
      return r.text;
    },
    async set(k: string, v: string): Promise<void> {
      await inner.set(k, needsVault(k) ? sealSecret(v, key) : v);
    },
    async delete(k: string): Promise<void> {
      await inner.delete(k);
    },
  };
}

/**
 * 整文件信封（给 `cookies.json` 这类「一个文件就是一个 JSON 对象」的持久化用）。
 *
 * 落盘形态：`{"vault":1,"alg":"AES-256-GCM","data":"<base64>"}`；
 * 读时若不是信封（旧文件）⇒ 原样返回并 `sealed=false`，由调用方迁移回写。
 */
export function sealJsonFile(obj: unknown, key: Buffer | null = vaultKey()): string {
  const plain = JSON.stringify(obj, null, 1);
  if (!key) return plain;
  return JSON.stringify({ vault: 1, alg: ALG, data: sealSecret(plain, key) }, null, 1);
}

export function openJsonFile<T>(
  text: string,
  key: Buffer | null = vaultKey(),
): { data: T | null; sealed: boolean; failed: boolean } {
  try {
    const o = JSON.parse(text) as { vault?: number; data?: string };
    if (o && o.vault === 1 && typeof o.data === 'string') {
      const r = openSecret(o.data, key);
      if (r.failed) return { data: null, sealed: true, failed: true };
      return { data: JSON.parse(r.text) as T, sealed: true, failed: false };
    }
    return { data: o as unknown as T, sealed: false, failed: false };
  } catch {
    return { data: null, sealed: false, failed: false };
  }
}
