/**
 * `#820` **音频响应类型判定**（纯字节嗅探 + 配置回退）。
 *
 * 为什么需要：很多 TTS 引擎回 `application/octet-stream` 或干脆没有 `content-type`，
 * 而 `<audio>`/Web Audio 需要正确的 MIME 才能解码。配置里的 `contentType` 只是**期望值**，
 * 真实数据优先按魔术字节判 —— 这样「配置写了 audio/mpeg、站点回了 wav」也能播。
 */

/** 按文件头判音频类型；不认识返回 null（不猜） */
export function sniffAudioContentType(bytes: Uint8Array | ArrayBuffer | null | undefined): string | null {
  if (!bytes) return null;
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (b.length < 4) return null;
  const u8 = b;
  const ascii = (start: number, len: number): string => {
    let s = '';
    for (let i = start; i < start + len && i < u8.length; i += 1) s += String.fromCharCode(u8[i]!);
    return s;
  };
  // MP3：ID3 标签 或 MPEG 帧同步（0xFFEx / 0xFFFx）
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (u8[0] === 0xff && (u8[1] === 0xfb || u8[1] === 0xf3 || u8[1] === 0xf7 || u8[1] === 0xf2)) {
    return 'audio/mpeg';
  }
  // AAC（ADTS 同步字）
  if (u8[0] === 0xff && (u8[1] === 0xf1 || u8[1] === 0xf9)) return 'audio/aac';
  // RIFF/WAVE
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  // Ogg（可能含 Opus/Vorbis）
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  // FLAC
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  // ISO BMFF（m4a）
  if (ascii(4, 4) === 'ftyp') return 'audio/mp4';
  // WebM/Matroska（EBML 头）
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'audio/webm';
  return null;
}

/**
 * 最终回传类型：**魔术字节 > 上游 content-type > 配置期望 > audio/mpeg**。
 * 上游给 `text/html` 但字节是 MP3 时，按 MP3 回传（用户要听的声音比「站点写错头」重要）。
 */
export function resolveTtsAudioType(opts: {
  bytes: Uint8Array | ArrayBuffer | null | undefined;
  upstream?: string | null;
  configured?: string | null;
}): { contentType: string; sniffed: string | null; trusted: boolean } {
  const sniffed = sniffAudioContentType(opts.bytes);
  if (sniffed) return { contentType: sniffed, sniffed, trusted: true };
  const upstream = String(opts.upstream ?? '').split(';')[0]!.trim().toLowerCase();
  if (upstream && /^audio\//.test(upstream)) return { contentType: upstream, sniffed: null, trusted: true };
  const configured = String(opts.configured ?? '').trim();
  if (configured && /^audio\//i.test(configured)) {
    return { contentType: configured, sniffed: null, trusted: false };
  }
  return { contentType: 'audio/mpeg', sniffed: null, trusted: false };
}
