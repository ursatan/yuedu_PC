/**
 * `#621` **备份加密（AES）** —— 逐条对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\help\storage\BackupAES.kt`（8 行）：
 *
 * ```kotlin
 * class BackupAES(password: String?) : AES(
 *     MD5Utils.md5Encode(password.orEmpty()).encodeToByteArray(0, 16)
 * )
 * ```
 *
 * 展开成可移植的算法参数（hutool `AES(byte[])` 的默认值）：
 * - 算法：**AES/ECB/PKCS5Padding**（ECB 无 IV，`encryptBase64` 出标准 Base64）
 * - 密钥：`md5Hex(password)` 这个 **32 字符十六进制串的前 16 个字符**，按 ASCII 取字节 ⇒ 16 字节
 *   （★ 不是「md5 摘要前 16 字节」，那是 32 位十六进制串里取前 16 个字符再编码 —— 两者完全不同，
 *   写错了手机端备份就打不开，属于「看起来像、实际不通」的典型）
 * - 空密码也**照样算**（`password.orEmpty()`）—— 但上游在启用 cookie 备份时会先拦下空密码
 *
 * ## 为什么不能用 `#616` 的 `secret-vault`
 * `secret-vault` 是 AES-256-GCM + **本机随机密钥文件**（`data/vault.key`）：
 * 它的目的是「防本机文件被拷走后明文可读」，**换台机器就解不开**。
 * 备份的加密目的相反 —— 要能在**另一台设备/另一个客户端**上恢复 ⇒ 密钥必须来自**用户口令**。
 * 两者是不同用途，不能互相替代（`#616` 的文档也写明了它不随备份迁移）。
 *
 * ## 兼容性
 * 目标：手机端 Legado 生成的加密备份能在这里解开，反之亦然。所以**不用** GCM、
 * 不加 IV/盐、不加自定义头 —— 就是上游那一套原始参数。
 * ECB 本身不安全（相同明文块出相同密文块），但这里要的是**互操作**，不是自创更强的格式；
 * 真正的强度由口令承担（弱口令就是弱备份）。
 */

import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';

const ALG = 'aes-128-ecb';

/** 上游密钥推导：`md5Hex(password)` 的前 16 个**字符**（ASCII 字节） */
export function backupKey(password: string | null | undefined): Buffer {
  const hex = createHash('md5').update(String(password ?? ''), 'utf8').digest('hex');
  return Buffer.from(hex.slice(0, 16), 'utf8');
}

/** 加密 → Base64（上游 `aes.encryptBase64(json)`） */
export function encryptBackupText(plain: string, password: string | null | undefined): string {
  const c = createCipheriv(ALG, backupKey(password), null);
  return Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]).toString('base64');
}

/**
 * 解密 Base64 密文。口令错/PKCS5 填充不合法 ⇒ 抛错（**不返回空串**）：
 * 「恢复出一份空数据」比「解不开」危险得多（会把用户库覆盖成空）。
 */
export function decryptBackupText(b64: string, password: string | null | undefined): string {
  const d = createDecipheriv(ALG, backupKey(password), null);
  const buf = Buffer.from(String(b64 ?? '').trim(), 'base64');
  return Buffer.concat([d.update(buf), d.final()]).toString('utf8');
}

/** 看起来像不像我们加密后的 base64（用于「这份后端是明文还是密文」的自动判定） */
export function isProbablyEncrypted(text: string): boolean {
  const t = String(text ?? '').trim();
  // JSON 明文一定以 `{` 开头；密文只含 base64 字符集且长度是 4 的倍数
  if (!t || t.startsWith('{') || t.startsWith('[')) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(t) && t.length % 4 === 0;
}
