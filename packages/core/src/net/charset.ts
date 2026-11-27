/**
 * `#439` **响应字节的字符集检测 / 解码** —— **唯一实现**（core 文本通路 与 `/api/proxy` 共用）。
 *
 * ## 为什么必须下沉成唯一实现
 * 同一条判据（① 显式字符集 → ② `Content-Type` 的 charset → ③ 页面 `<meta charset>` 嗅探 → ④ UTF-8）
 * 此前**只**在 `net/index.ts` 的文本分支里写了一份；而 `/api/proxy` 走
 * `responseType:'arraybuffer'`（要拿原始字节做图片解密 / `ty=hex` / HLS 重写）
 * ⇒ core 的文本分支**根本不执行** ⇒ 代理侧需要自己再解一次，而它**当时压根没做**
 * ⇒ 把上游字节当 UTF-8 处理 ⇒ **整页乱码**（见下方缺陷记录）。
 * 按铁律「同一判据写两处必然漂移」，这里抽成 core 的唯一实现，两侧共用。
 *
 * ## 缺陷记录（2026-10-13，用户实测：千白羽小说站整页 `����`）
 * GBK 页面的代理链路：`/api/proxy` 取回**原始 GBK 字节** → `#435` 的 HTML 文档修补
 * 执行 `buf.toString('utf8')`（**把 GBK 字节按 UTF-8 解** ⇒ 每个汉字变 U+FFFD `�`）→
 * 再 `Buffer.from(str,'utf8')` 回写 ⇒ 字节已被**不可逆**破坏；`#437` 又把 `content-type`
 * 改写为 `charset=utf-8` ⇒ 客户端拿到的是一串 `�`。多次重启无效 —— 这是**代码缺陷**，
 * 不是「服务端没重启」。
 * 修法：文本类响应**先按上游字符集解码**再做任何字符串处理，最后统一编码 UTF-8 回传。
 */

/** 按给定 charset 解码字节（未知标签 / 解码失败 ⇒ 退回 UTF-8，绝不抛） */
export function decodeBytes(buf: Uint8Array | ArrayBuffer, charset: string): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return '';
    }
  }
}

/**
 * 字符集判定（对齐浏览器 / Legado okhttp 语义）：
 *   ① **显式**（源规则 `,{"charset":"gbk"}` / 代理 `&cs=`）—— 最高优先，作者最清楚；
 *   ② 响应头 `Content-Type; charset=…`；
 *   ③ **正文前 2KB 的 `<meta charset>` / `<meta http-equiv>` 嗅探**（中文老站常见：
 *      头里不带 charset，只在本页 meta 声明）；
 *   ④ 兜底 `utf-8`。
 */
export function detectResponseCharset(buf: Uint8Array | ArrayBuffer, contentType = '', hint = ''): string {
  const explicit = String(hint ?? '').trim();
  if (explicit) return explicit;
  const ct = /charset=["']?([\w-]+)/i.exec(String(contentType ?? ''))?.[1];
  if (ct) return ct;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /charset=([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
}

/** 便捷：按「显式 → 头 → meta → utf-8」判定并解码 */
export function decodeText(buf: Uint8Array | ArrayBuffer, contentType = '', hint = ''): string {
  return decodeBytes(buf, detectResponseCharset(buf, contentType, hint));
}
