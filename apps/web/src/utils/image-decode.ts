/**
 * **图片密文解密规则生成**（规则工坊「图片解密」面板 + `image-decode-byte-recon` 技能的唯一实现）。
 *
 * ## 问题（本模块要自动化掉的手工动作）
 * 一类站点（91 系列 / 麻豆系…）把图片在**服务端**加密成 AES 密文，真地址藏在
 * `<img data-xxxx="https://…jpeg">` 这类**防爬随机属性**里，页面再靠自己的 JS
 * （`CryptoJS.AES.decrypt` + 一段**混淆过的字符串表**）解密后写成 `data:image/…` 渲染。
 * 我们直连拿到的 `src` 是占位图、改写成真地址后拿到的又是**密文** ⇒ 用户看到裂图。
 *
 * 修法是给源加 `coverDecodeJs`（Legado 标准字段，引擎对**封面与正文图**都走这条）。
 * 难点在**把 key/iv 从站点混淆 JS 里挖出来** —— 正是本模块做的事：
 *
 *  ① {@link extractKeyCandidates}：从 JS 文本里抽候选密钥。混淆器的 key/iv 通常以
 *     `'57_55_98_…'`（charCode 用 `_` 连接）形式**以字面量留在字符串表里** ⇒
 *     **不需要复现旋转**，正则直取后 {@link charcodeJoinToText} 还原即可。
 *  ② {@link detectAesCbcKeyIv}：拿一张**真实密文图**，对「候选 × 候选」做 AES-CBC 试解，
 *     以**图片魔数**（`ffd8ff`/`89504e47`/`GIF`…）为判据 —— 唯一能证伪的判据。
 *  ③ {@link buildCoverDecodeJs}：产出可直接粘进源 `coverDecodeJs` 的规则串。
 *
 * ## 边界
 * 本模块**不发网络请求**（抓取由视图走既有 `/api/proxy`）；只用 WebCrypto（`crypto.subtle`，
 * Node ≥18 与浏览器都有）完成试解 ⇒ 纯逻辑可单测。
 * ⚠️ WebCrypto 的 AES-CBC **必带 PKCS#7 去填充**（无法关闭）⇒ 只适用于 PKCS5/7 的站点；
 * ECB/NoPadding 的站点请直接写 `java.createSymmetricCrypto('AES/ECB/NoPadding',…)`（见技能）。
 */

/** key/iv 候选的来源类型 */
export type KeyCandidateKind = 'charcode-join' | 'literal';

export interface KeyCandidate {
  /** 原始字面量（去引号后） */
  raw: string;
  /** 还原后的可用密钥串 */
  value: string;
  kind: KeyCandidateKind;
}

/**
 * `'57_55_98_…'` → `'97b…'` —— 按 `_` 切分后逐段 `String.fromCharCode(parseInt(p,10))`。
 *
 * 与站点 `decryptImage` 里的写法逐字对应（实测 91 吃瓜：
 * `'102_53_100_57_…'` ⇒ `'f5d965df75336270'`）。非法段（非数字）产出空串，不抛。
 */
export function charcodeJoinToText(s: string): string {
  return s
    .split('_')
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isNaN(n) ? '' : String.fromCharCode(n);
    })
    .join('');
}

/** UTF-8 字节长度（判决「是不是 16/24/32 字节的 AES 密钥」用） */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * 抽候选密钥。两类，按置信度排序（charcode-join 优先 —— 那是最典型的混淆写法）：
 *  · `'57_55_98_…'`：≥6 段的 charCode 串（去引号）→ {@link charcodeJoinToText} 还原；
 *  · `'xxxxxxxxxxxxxxxx'`：16/24/32 个**可见 ASCII** 的直角引号字面量。
 * 去重（按 `value`），最多返回 `max` 个。
 */
export function extractKeyCandidates(text: string, max = 16): KeyCandidate[] {
  const out: KeyCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: string, v: string, kind: KeyCandidateKind): void => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push({ raw, value: v, kind });
  };

  // ① charCode 用 `_` 连接的字面量（站点混淆表的典型形态；6 段以上才收，避免误命中日期串）
  const reChar = /['"](\d{1,3}(?:_\d{1,3}){5,})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = reChar.exec(text))) {
    const raw = m[1] ?? '';
    push(raw, charcodeJoinToText(raw), 'charcode-join');
  }

  // ② 16/24/32 个可见 ASCII 的引号字面量（普通硬编码 key/iv）
  const reLit = /['"]([!-~]{16}|[!-~]{24}|[!-~]{32})['"]/g;
  while ((m = reLit.exec(text))) {
    const raw = m[1] ?? '';
    // 纯数字串多半是别的东西（版本号/时间戳），跳过以降低噪声
    if (/^\d+$/.test(raw)) continue;
    push(raw, raw, 'literal');
  }

  return out.slice(0, max);
}

/** AES 密钥可用长度集合（字节） */
const AES_KEY_LENS = [16, 24, 32];

export type ImageMagic = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'avif' | null;

/**
 * 图片魔数判定 —— 试解成功的**唯一硬判据**（错 key 解出的字节基本不可能命中）。
 * 覆盖 jpeg / png / gif / webp / bmp / avif。
 */
export function imageMagic(b: Uint8Array): ImageMagic {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  const three = String.fromCharCode(b[0]!, b[1]!, b[2]!);
  if (three === 'GIF') return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP') return 'webp';
  // avif：ftyp box（offset 4 起，'ftypavif'）
  if (String.fromCharCode(b[4]!, b[5]!, b[6]!, b[7]!) === 'ftyp' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'avif') return 'avif';
  return null;
}

export interface DetectResult {
  key: string;
  iv: string;
  /** 解出的明文（用于回显图片） */
  plain: Uint8Array<ArrayBuffer>;
  magic: Exclude<ImageMagic, null>;
}

/**
 * 对「候选 key × 候选 iv」做 AES-CBC 试解，返回**第一个解出图片魔数**的组合。
 *
 * key 取 16/24/32 字节的候选；iv 取 16 字节的候选（CBC 必需）。密文长度必须是 16 的倍数，
 * 否则直接返回 null（不是分组密码密文）。**全部按 UTF-8 字节** —— 与引擎
 * `toKeyBytes`（`Buffer.from(String(v),'utf-8')`）**同一口径**，否则「能解但我这边解不出」。
 *
 * ⚠️ WebCrypto 的 AES-CBC 自动做 PKCS#7 去填充：错 key 通常因填充非法而抛 ⇒ 天然是过滤器；
 * 但极少数错 key 会产生合法填充，故仍以 {@link imageMagic} 复核。
 */
export async function detectAesCbcKeyIv(
  cipher: Uint8Array<ArrayBuffer>,
  cands: KeyCandidate[],
): Promise<DetectResult | null> {
  if (!cipher.length || cipher.length % 16 !== 0) return null;
  const keys = cands.filter((c) => AES_KEY_LENS.includes(utf8Len(c.value)));
  const ivs = cands.filter((c) => utf8Len(c.value) === 16);
  for (const k of keys) {
    for (const iv of ivs) {
      if (k.value === iv.value) continue; // key 与 iv 相同几乎不可能是真配置
      try {
        const ck = await crypto.subtle.importKey(
          'raw', new TextEncoder().encode(k.value), { name: 'AES-CBC' }, false, ['decrypt'],
        );
        const plain = new Uint8Array(
          await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(iv.value) }, ck, cipher),
        );
        const magic = imageMagic(plain);
        if (magic) return { key: k.value, iv: iv.value, plain, magic };
      } catch {
        /* 错组合 ⇒ 继续试下一个 */
      }
    }
  }
  return null;
}

/** 把字符串包成 JS 单引号字面量（转义 `\` 与 `'`） */
function jsQuote(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * 产出可直接粘进源 `coverDecodeJs` 的规则串（与 91 视频 / 91 吃瓜 实测可用的写法逐字一致）：
 * ```
 * java.createSymmetricCrypto('AES/CBC/PKCS5Padding','<key>','<iv>').decrypt(result.readAllBytes())
 * ```
 * `result` 是引擎按 `asImageStreamResult` 传进来的 **InputStream 语义**字节（脚本用 `readAllBytes()`）。
 */
export function buildCoverDecodeJs(key: string, iv: string, transformation = 'AES/CBC/PKCS5Padding'): string {
  return `java.createSymmetricCrypto(${jsQuote(transformation)},${jsQuote(key)},${jsQuote(iv)}).decrypt(result.readAllBytes())`;
}

/** 便捷：候选列表的展示文本（面板回显用） */
export function formatCandidates(cands: KeyCandidate[]): string {
  if (!cands.length) return '（未抽到候选）';
  return cands
    .map((c) => `${c.kind === 'charcode-join' ? '⟲' : '·'} ${c.value}  ← ${c.raw.slice(0, 60)}`)
    .join('\n');
}
