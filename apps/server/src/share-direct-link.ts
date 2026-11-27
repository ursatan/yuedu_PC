/**
 * `#208` **直链上传配置 + 源分享**（服务端侧）。
 *
 * 三块职责，刻意分在一个小文件里（index.ts 已 2700 行，且这三块要能脱离 Fastify 单测）：
 *  1. **配置持久化** —— 对齐上游 `DirectLinkUpload.getConfig/putConfig/delConfig`
 *     （上游存 ACache 的 `directLinkUploadRule.json`；本仓存 `<DATA_DIR>/direct-link-upload.json`）。
 *  2. **测试上传** —— 对齐上游配置对话框左下角「测试」：`upLoad("test.json", "{}", "application/json", rule)`。
 *  3. **分享一个源** —— 上游这套东西的实际用途（`HandleFileViewModel` 把文件传上网盘拿到 url，
 *     再由 `SourceSharePassphraseDialog` 把 url 编成口令）。这里合成一步：
 *     **源 json → 上传 → 拿 url → 编口令**。
 *
 * ## 上游语义（逐条）
 * - `getRule()` = **有自定义配置就用它，否则用内置第 1 条**（`getConfig() ?: defaultRules[0]`）。
 *   注意是**第 1 条**不是「全部」——内置 3 条是给用户挑的，不是依次尝试。
 * - `getConfig()` 解析失败 ⇒ 视为**没有自定义**（`GSON.fromJsonObject<T>(json).getOrNull()`），
 *   不报错、不崩：一个手改坏的配置文件不该让服务起不来。
 * - `getSummary()` 界面上显示的就是它；`getExpiryDate()` 同时决定**口令的有效期**
 *   （上游 `sourceSharePassphraseButton` 里 `expiryDays = DirectLinkUpload.getExpiryDate()`）。
 *
 * ## 安全边界（如实写出来，别以为没有）
 * 本端点会让服务端**向用户配置的任意地址 POST 源 json**。这是功能本身（用户自己配的网盘），
 * 但要知道：`/api` 全程无鉴权（本仓已知，见 `cors.ts` 注释）。挡在前面的**只有 CORS**：
 * 外站网页发 `PUT/POST + application/json` 都会先预检，而 `corsOriginFor` 对外站一律 `null`
 * ⇒ 预检不通过、请求发不出去。因此**不要把本端点的 body 放宽成 `text/plain` 也接受**
 * （那会变成「简单请求」⇒ 预检被跳过 ⇒ 网页能偷偷改配置并诱导上传）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DIRECT_LINK_UPLOAD_RULES,
  SOURCE_SHARE_TYPES,
  canEncodeSourceShareUrl,
  encodeSourceSharePassphrase,
  sourceShareExpiresAt,
  validateDirectLinkUploadRule,
  type DirectLinkUploadRule,
} from '@yuedu/core';
import {
  uploadDirectLink,
  type DirectLinkUploadOptions,
  type DirectLinkUploadResult,
} from '@yuedu/facade';

/** 配置的对外形态（界面/PUT 的 body 都用它） */
export interface DirectLinkUploadState {
  /** 当前生效的规则（自定义优先，否则内置第 1 条） */
  rule: DirectLinkUploadRule;
  /** 是否来自用户自定义配置（false = 正在用内置默认） */
  custom: boolean;
  /** 内置 3 条（供界面「导入默认」选择） */
  defaults: readonly DirectLinkUploadRule[];
}

/**
 * 直链上传配置的落盘存储。
 *
 * 写盘用**临时文件 + rename**（原子替换）：`JSON.stringify` 到一半掉电不会留下半截 json，
 * 否则下次启动 `getConfig()` 解析失败会静默回落默认规则 —— 用户会以为「配置自己没了」。
 */
export class DirectLinkUploadConfig {
  private rule: DirectLinkUploadRule | null;

  constructor(private readonly file: string) {
    this.rule = this.read();
  }

  private read(): DirectLinkUploadRule | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
      // 存盘内容也要过一遍校验：手改坏的配置按「没有自定义」处理（对齐上游 getOrNull 的宽容）
      const v = validateDirectLinkUploadRule(raw);
      return v.ok ? v.rule : null;
    } catch {
      return null;
    }
  }

  /** 上游 `getConfig()`：没有 / 坏掉 ⇒ null */
  getCustomRule(): DirectLinkUploadRule | null {
    return this.rule;
  }

  /** 上游 `getRule()`：自定义优先，否则内置第 1 条 */
  getRule(): DirectLinkUploadRule {
    return this.rule ?? (DEFAULT_DIRECT_LINK_UPLOAD_RULES[0] as DirectLinkUploadRule);
  }

  /** 上游 `putConfig(rule)` —— 传进来的必须已过校验（调用方负责给用户报错） */
  putConfig(rule: DirectLinkUploadRule): void {
    this.rule = { ...rule };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.rule, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  /** 上游 `delConfig()`：删掉自定义 ⇒ 回落到内置第 1 条 */
  delConfig(): void {
    this.rule = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      /* 删不掉也不影响（内存里已经回落），下次 putConfig 会覆盖 */
    }
  }

  /** 上游 `getSummary()` */
  summary(): string {
    return this.getRule().summary;
  }

  /** 上游 `getExpiryDate()`：**同时决定分享口令的有效期** */
  expiryDate(): number {
    return this.getRule().expiryDate;
  }

  getState(): DirectLinkUploadState {
    return { rule: this.getRule(), custom: this.rule !== null, defaults: DEFAULT_DIRECT_LINK_UPLOAD_RULES };
  }
}

/** 上游「测试」按钮：`upLoad("test.json", "{}", "application/json", rule)` */
export async function testDirectLinkRule(
  rule: DirectLinkUploadRule,
  opts: DirectLinkUploadOptions = {},
): Promise<DirectLinkUploadResult> {
  return uploadDirectLink(
    rule,
    { fileName: 'test.json', contentType: 'application/json', bytes: new TextEncoder().encode('{}') },
    opts,
  );
}

/** 源文件名净化：只留安全字符（网盘对文件名挑剔，中文名也常被拒） */
export function safeShareFileName(name: string): string {
  const base = (name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_');
  const cut = base.slice(0, 60) || 'bookSource';
  return cut.toLowerCase().endsWith('.json') ? cut : `${cut}.json`;
}

export interface ShareSourceInput {
  /** 要分享的源 json（对象或字符串都行） */
  raw: unknown;
  /** 文件名来源（一般用源展示名） */
  name?: string;
}

export interface ShareSourceResult {
  /** 网盘返回的下载地址 */
  downloadUrl: string;
  /** 可直接复制给别人的口令（`复制口令到阅读导入…！sy©…¥Legado^`） */
  passphrase: string;
  /** 口令里的过期时间（毫秒；0 = 永久）—— 与口令内容同源，界面直接显示 */
  expiresAt: number;
  /** 本次上传的实况（文件名 / 大小 / 是否压缩 / 真正打到的地址） */
  upload: DirectLinkUploadResult;
  /** 生效规则摘要（便于界面提示「用了哪个网盘」） */
  summary: string;
}

/** 分享失败的原因分类（供端点回不同状态码；界面据此给不同文案） */
export type ShareSourceError =
  | { kind: 'empty' }
  | { kind: 'unshareable'; downloadUrl: string; detail: string }
  | { kind: 'upload'; detail: string };

export type ShareSourceOutcome =
  | { ok: true; value: ShareSourceResult }
  | { ok: false; error: ShareSourceError };

/**
 * 把一个源分享出去：源 json → 直链上传 → 口令。
 *
 * ⚠️ **顺序有讲究**：先上传、后判 `canEncode`。因为下载地址是**上传之后才知道的**，
 * 而有些网盘返回的地址带 `！©¥^` 或口令替身字面量（比如域名里出现「店」「杠」），
 * 那种 url 编不成口令。这时**不能把上传白费掉**：错误里带上 `downloadUrl`，
 * 用户至少还能手动把链接发给别人（上游对这种情况是「按钮不显示」，PC 上没有「检测 url」的时机）。
 */
export async function shareSource(
  input: ShareSourceInput,
  config: DirectLinkUploadConfig,
  opts: DirectLinkUploadOptions = {},
): Promise<ShareSourceOutcome> {
  const raw = input.raw;
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { ok: false, error: { kind: 'empty' } };
  const json = typeof raw === 'string' ? raw : JSON.stringify(raw);

  const rule = config.getRule();
  let upload: DirectLinkUploadResult;
  try {
    upload = await uploadDirectLink(
      rule,
      {
        fileName: safeShareFileName(input.name ?? ''),
        contentType: 'application/json',
        bytes: new TextEncoder().encode(json),
      },
      opts,
    );
  } catch (e) {
    return { ok: false, error: { kind: 'upload', detail: e instanceof Error ? e.message : String(e) } };
  }

  if (!canEncodeSourceShareUrl(upload.downloadUrl)) {
    return {
      ok: false,
      error: {
        kind: 'unshareable',
        downloadUrl: upload.downloadUrl,
        detail: '网盘返回的地址含口令保留字符，无法编成口令（可把该链接直接发给对方）',
      },
    };
  }

  const expiryDays = rule.expiryDate;
  const passphrase = encodeSourceSharePassphrase(upload.downloadUrl, SOURCE_SHARE_TYPES.BOOK_SOURCE, expiryDays);
  return {
    ok: true,
    value: {
      downloadUrl: upload.downloadUrl,
      passphrase,
      expiresAt: sourceShareExpiresAt(expiryDays),
      upload,
      summary: rule.summary,
    },
  };
}
