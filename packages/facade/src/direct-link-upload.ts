/**
 * `#208` **直链上传**（DirectLinkUpload）—— 执行层。
 *
 * 规则模型 / 校验 / 内置规则表在 `@yuedu/core`（`core/src/direct-link-upload.ts`，纯函数）；
 * 本文件负责**动作**：按规则把文件发出去、再从响应里抠出下载地址。
 *
 * ## 逐条对齐上游 `DirectLinkUpload.kt:26-71`
 * 1. `rule.uploadUrl` 空 ⇒ 抛「上传url未配置」；`rule.downloadUrlRule` 空 ⇒ 抛「下载地址规则未配置」。
 * 2. `compress && contentType != 'application/zip'` ⇒ 压成 zip：**文件名加 `.zip`**、
 *    `contentType` 改 `application/zip`、**条目名 = 原文件名**（`ZipUtils.zipByteArray`）。
 * 3. 发请求：上游 `AnalyzeUrl.upload()` 硬编码 `postMultipart(type, bodyMap)`
 *    ⇒ **方法恒为 POST**（不看 `method` 选项，也不要以为 `urlNoQuery` 会去掉 query ——
 *    `AnalyzeUrl.kt:283` 只在**非 POST** 时才截 query，POST 分支 `urlNoQuery = url` 保留 query）。
 * 4. `body` 映射里**值等于字面量 `fileRequest`** 的那一项换成文件部件，其余按字符串部件。
 * 5. 对上一步响应体求 `downloadUrlRule`（`AnalyzeRule().setContent(res.body, res.url).getString(rule)`）。
 * 6. 结果为空 ⇒ 抛「上传失败,<响应体>」（**必须把响应体带出去**：网盘的失败原因就在体里，
 *    只报「上传失败」会让用户完全无法自救 —— 铁律 3）。
 *
 * ## 与上游的一处有意差异
 * `type` 选项（multipart 的 media type）**不再原样写死**：multipart 的 boundary 必须由
 * 发送方生成（上游靠 okhttp `MultipartBody.setType`），本仓走 `fetch` + `FormData`
 * ⇒ 由 `fetch` 自己写 `multipart/form-data; boundary=…`。
 * 若规则里的 `type` **不是** `multipart/*`，说明它想要的不是 multipart 上传 ——
 * 这种情况**明确报错**，不静默按 multipart 发出去（否则会得到一个「上传成功但内容是垃圾」的假象）。
 */

import {
  createHttpClient,
  createJsEvaluator,
  createVariableStore,
  analyzeString,
  splitUrlOptions,
  type AnalyzeEnv,
  type DirectLinkUploadRule,
  type HttpClient,
  type HttpResponse,
} from '@yuedu/core';
import { zipSingleFile } from './zip-writer';

/** 待上传的文件（内存形态；上游对应 `File` / `ByteArray` / `String` 三种入参） */
export interface UploadFile {
  /** 原始文件名（zip 的条目名也用它，对齐 `ZipUtils.zipByteArray(bytes, fileName)`） */
  fileName: string;
  /** 原始内容类型（如 `application/json`） */
  contentType: string;
  bytes: Uint8Array;
}

export interface DirectLinkUploadOptions {
  /** 注入 HTTP（默认 `createHttpClient` 的即时任务；单测可打桩） */
  http?: Pick<HttpClient, 'request'>;
  /** zip 时间戳（透传，供测试逐字节断言） */
  zipMtime?: Date;
}

export interface DirectLinkUploadResult {
  /** 最终下载地址（`downloadUrlRule` 求值结果） */
  downloadUrl: string;
  /** 真正 POST 到的地址（URL 已剥离 `,{…}` 选项尾巴） */
  requestUrl: string;
  /** 上传响应体（排障必备：网盘失败原因就在里面） */
  responseBody: string;
  /** 实际发出去的文件名（compress 时是 `xxx.zip`） */
  fileName: string;
  /** 实际发出去的 content type */
  contentType: string;
  /** 实际上传的字节数 */
  byteLength: number;
  /** 是否发生了 zip 压缩 */
  compressed: boolean;
}

/** 从 URL 选项里取 multipart 的部件表（`body`），兼容「JSON 字符串」形态 */
function readBodyMap(option: Record<string, unknown> | null): Record<string, unknown> | null {
  const raw = option?.['body'];
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

/** 独立的规则求值环境（`downloadUrlRule` 只用得上变量表 + JS 求值器） */
function makeRuleEnv(): AnalyzeEnv {
  const variables = createVariableStore();
  return { variables, jsEval: createJsEvaluator({ variables }) };
}

/**
 * 求 `downloadUrlRule`（导出供单测直接打）。
 * @param responseBody 上传响应体
 * @param responseUrl  上传响应最终 URL（规则里可用相对地址）
 */
export async function applyDirectLinkDownloadRule(
  downloadUrlRule: string,
  responseBody: string,
  responseUrl = '',
): Promise<string> {
  const out = await analyzeString(downloadUrlRule, responseBody, makeRuleEnv(), {
    baseUrl: responseUrl || undefined,
  });
  return (out ?? '').trim();
}

/** `Uint8Array` → `ArrayBuffer` 副本（`Blob` 只接受后者，避免共享底层 buffer 时被改写） */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 按规则组织 multipart 表单（**不做网络**，纯组装 ⇒ 可单测）。
 *
 * ⚠️ 这里不返回 `contentType`：multipart 的 `Content-Type` 由 `fetch` 依 `FormData`
 * 自动生成（含 boundary），任何手动设置都会丢掉 boundary ⇒ 服务端解不出部件。
 */
export function buildDirectLinkForm(
  rule: DirectLinkUploadRule,
  file: UploadFile,
  opts: DirectLinkUploadOptions = {},
): {
  form: FormData;
  fileName: string;
  contentType: string;
  compressed: boolean;
  bodyMap: Record<string, unknown>;
  /** 真正要发出去的字节（compress 时是 zip 产物；调用方用它报大小，别重复压一遍） */
  bytes: Uint8Array;
} {
  const parsed = splitUrlOptions(rule.uploadUrl);
  const option = parsed.option as Record<string, unknown> | null;

  const type = typeof option?.['type'] === 'string' ? (option['type'] as string).trim() : '';
  if (type && !type.toLowerCase().startsWith('multipart/')) {
    throw new Error(`该规则的上传类型是「${type}」，本实现只支持 multipart/form-data 上传`);
  }

  let fileName = file.fileName;
  let contentType = file.contentType;
  let bytes = file.bytes;
  let compressed = false;
  if (rule.compress && contentType !== 'application/zip') {
    // 上游：文件名加 .zip、类型改 application/zip、条目名用原名
    bytes = zipSingleFile(file.fileName, bytes, opts.zipMtime ? { mtime: opts.zipMtime } : {});
    fileName = `${file.fileName}.zip`;
    contentType = 'application/zip';
    compressed = true;
  }

  const bodyMap = readBodyMap(option) ?? {};
  const form = new FormData();
  let filePartCount = 0;
  for (const [key, value] of Object.entries(bodyMap)) {
    if (String(value) === 'fileRequest') {
      filePartCount += 1;
      form.append(key, new Blob([toArrayBuffer(bytes)], { type: contentType }), fileName);
    } else {
      form.append(key, String(value));
    }
  }
  if (filePartCount === 0) {
    // 上游会静默发出「一个没有文件部件的 multipart」⇒ 服务端多半回 400，但错误信息离真因很远。
    throw new Error('该规则的 body 里没有 fileRequest 标记，无法确定文件放在哪个字段');
  }
  return { form, fileName, contentType, compressed, bodyMap, bytes };
}

/**
 * 执行一次直链上传。返回下载地址；失败时抛**带响应体**的错误。
 */
export async function uploadDirectLink(
  rule: DirectLinkUploadRule,
  file: UploadFile,
  opts: DirectLinkUploadOptions = {},
): Promise<DirectLinkUploadResult> {
  const uploadUrl = (rule.uploadUrl ?? '').trim();
  if (!uploadUrl) throw new Error('上传url未配置');
  const downloadUrlRule = (rule.downloadUrlRule ?? '').trim();
  if (!downloadUrlRule) throw new Error('下载地址规则未配置');

  const parsed = splitUrlOptions(uploadUrl);
  const option = parsed.option as Record<string, unknown> | null;
  const headers: Record<string, string> = {};
  const rawHeaders = option?.['headers'];
  if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (v != null) headers[k] = String(v);
    }
  }

  const built = buildDirectLinkForm(rule, file, opts);
  const http = opts.http ?? createHttpClient();

  let res: HttpResponse;
  try {
    res = await http.request(parsed.url, {
      // 上游 `AnalyzeUrl.upload` 恒 POST（不看 method 选项）
      method: 'POST',
      headers,
      body: built.form,
      // 上传是用户主动点击的一次性动作 ⇒ 给足超时（默认即时任务 12s 对网盘偏紧）
      timeout: 60_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`上传请求失败：${msg}`);
  }

  const body = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  const downloadUrl = await applyDirectLinkDownloadRule(downloadUrlRule, body, res.url || parsed.url);
  if (!downloadUrl) throw new Error(`上传失败,${body.slice(0, 500)}`);

  return {
    downloadUrl,
    requestUrl: parsed.url,
    responseBody: body,
    fileName: built.fileName,
    contentType: built.contentType,
    byteLength: built.bytes.length,
    compressed: built.compressed,
  };
}

/** 便捷入口：源 json 文本 → 上传 → 下载地址（`#208` 分享流程的实际调用点） */
export async function uploadSourceJson(
  rule: DirectLinkUploadRule,
  json: string,
  fileName = 'bookSource.json',
  opts: DirectLinkUploadOptions = {},
): Promise<DirectLinkUploadResult> {
  return uploadDirectLink(
    rule,
    { fileName, contentType: 'application/json', bytes: new TextEncoder().encode(json) },
    opts,
  );
}
