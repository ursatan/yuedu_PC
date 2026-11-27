/**
 * `#208` **直链上传**（DirectLinkUpload）的规则模型 —— 逐条对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\help\DirectLinkUpload.kt`（122 行）
 * 与 `app\src\main\assets\defaultData\directLinkUpload.json`（2026-10-06 读源码提取）。
 *
 * ## 它解决什么
 * 源分享口令（`source-share-passphrase.ts`）里编进去的是一个**可公网下载的 url**；
 * 那个 url 从哪来？上游的答案就是这里：把源文件 json **上传到一个「直链网盘」**，
 * 再用一条规则从上传响应里把下载地址抠出来。二者是一对：口令是「包装」，
 * 直链上传是「投递」。
 *
 * ## 上游语义（逐条，勿删）
 * - `Rule` **恰 5 个字段**：`uploadUrl`（创建分享链接）· `downloadUrlRule`（下载链接规则）·
 *   `summary`（注释）· `compress`（是否压缩，默认 `false`）· `expiryDate`（有效期/天，`0` = 永久）。
 * - `uploadUrl` 用的是 **Legado 的 URL+选项语法**（`url,{json}`），例如
 *   `https://sy.nyasama.net/shuyuan,{"method":"POST","body":{"file":"fileRequest"},"type":"multipart/form-data"}`
 *   ⇒ 解析复用本仓已有的 `splitUrlOptions`（`core/src/net/url-prep.ts`，对齐 `AnalyzeUrl`）。
 * - `body` 是「字段名 → 值」的映射；**值为字面量 `fileRequest`** 的那一项才是**文件部分**
 *   ⇒ 拆成 multipart 的 `addFormDataPart(key, fileName, content)`；其余字段按字符串部件
 *   （上游 `OkHttpUtils.kt:157-192` `postMultipart`，逐条对齐）。
 * - `downloadUrlRule` 是**普通 Legado 规则**（`$.data@js:…` / `$.msg` 都很常见），
 *   拿上传响应体求值（`AnalyzeRule().setContent(res.body, res.url).getString(rule)`）。
 * - `compress && contentType != "application/zip"` ⇒ 把内容压成 zip，**文件名加 `.zip`**、
 *   内容类型改 `application/zip`，zip 内的**条目名是原名**（`ZipUtils.zipByteArray`）。
 * - `expiryDate` 校验范围 = `0..SourceSharePassphrase.MAX_EXPIRY_DAYS`（即 0..36500）。
 *
 * ## 本文件是**纯函数**（零副作用；只依赖同包内的 `json-loose` 与 `source-share-passphrase` 常量）
 * 理由与 `source-share-passphrase.ts` 一致：Web 与 服务端两端共用、可直接单测。
 * 真正的「上传」动作（网络 + zip）在 facade（`@yuedu/facade`）；本文件只负责
 * **规则模型 + 校验 + 默认规则表 + 解析用户粘贴的配置**。
 */

import { parseJsonLoose } from './json-loose';
import { SOURCE_SHARE_MAX_EXPIRY_DAYS } from './source-share-passphrase';

/** 上游 `Rule` 的数据形状（字段名一字不差，供 JSON 序列化/粘贴互通） */
export interface DirectLinkUploadRule {
  /** 创建分享链接（URL + `,{json}` 选项） */
  uploadUrl: string;
  /** 下载链接规则（对上一步响应求值） */
  downloadUrlRule: string;
  /** 注释（界面显示用；上游把它当 `toString()`） */
  summary: string;
  /** 是否压缩（默认 false） */
  compress: boolean;
  /** 有效期/天，0 = 永久 */
  expiryDate: number;
}

/**
 * multipart `body` 里代表「这就是文件本体」的**保留字面量**（上游硬编码字符串）。
 * 大写注意：上游写死 `"fileRequest"`，比较用 `entry.value.toString() == "fileRequest"`。
 */
export const DIRECT_LINK_UPLOAD_FILE_TOKEN = 'fileRequest';

/** 上游 `defaultData/directLinkUpload.json` 的 3 条内置规则（原文照抄，顺序不变） */
export const DEFAULT_DIRECT_LINK_UPLOAD_RULES: readonly DirectLinkUploadRule[] = [
  {
    uploadUrl:
      'https://sy.nyasama.net/shuyuan,{"method":"POST","body": {"file": "fileRequest"},"type": "multipart/form-data"}',
    downloadUrlRule:
      "$.data@js:if (result == '') \n '' \n else \n 'https://shuyuan.nyasama.net/shuyuan/' + result",
    summary: '喵公子网盘①(有效期30天·香港G口)',
    compress: false,
    expiryDate: 30,
  },
  {
    uploadUrl:
      'https://sy.mgz6.com/shuyuan,{"method":"POST","body": {"file": "fileRequest"},"type": "multipart/form-data"}',
    downloadUrlRule:
      "$.data@js:if (result == '') \n '' \n else \n 'https://shuyuan.mgz6.com/shuyuan/' + result",
    summary: '喵公子网盘②(有效期7天)',
    compress: false,
    expiryDate: 7,
  },
  {
    uploadUrl:
      'http://v2.jt12.eu/up-v2.php,{"method":"POST","body": {"file": "fileRequest"},"type": "multipart/form-data"}',
    downloadUrlRule: '$.msg',
    summary: '橘涂书源网盘2.0 Beta(永久有效)',
    compress: false,
    expiryDate: 0,
  },
];

/** 校验结果（`ok:false` 时 `error` 直接给界面显示） */
export type DirectLinkUploadRuleResult =
  | { ok: true; rule: DirectLinkUploadRule }
  | { ok: false; error: string };

/** 值是否为「非空字符串」（上游 `isNullOrBlank`，注意 `trim`） */
function nonBlank(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 单条规则的字段级校验（对齐上游 `DirectLinkUploadConfig.getRule()` 的四道 toast）。
 *
 * ⚠️ **只校验「字段本身」**，不校验网络可达性 —— 上游也是这么分的
 * （配置对话框只保证非空 + 天数范围；能不能传上去靠「测试」按钮）。
 * 这样用户可以先粘贴一条规则再点测试，而不是「不填完不让测」。
 */
export function validateDirectLinkUploadRule(raw: unknown): DirectLinkUploadRuleResult {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '规则必须是一个 JSON 对象' };
  }
  const o = raw as Record<string, unknown>;
  if (!nonBlank(o['uploadUrl'])) return { ok: false, error: '上传Url不能为空' };
  if (!nonBlank(o['downloadUrlRule'])) return { ok: false, error: '下载Url规则不能为空' };
  if (!nonBlank(o['summary'])) return { ok: false, error: '注释不能为空' };
  const expiryRaw = o['expiryDate'];
  // 上游 `text?.toIntOrNull()`：只认**整数字面量**，`"30.5"` / `"abc"` / 缺失都是 null
  const expiryDate =
    typeof expiryRaw === 'number'
      ? expiryRaw
      : typeof expiryRaw === 'string' && /^[+-]?\d+$/.test(expiryRaw.trim())
        ? Number(expiryRaw.trim())
        : NaN;
  if (!Number.isInteger(expiryDate) || expiryDate < 0 || expiryDate > SOURCE_SHARE_MAX_EXPIRY_DAYS) {
    return { ok: false, error: `有效期须是 0~${SOURCE_SHARE_MAX_EXPIRY_DAYS} 之间的整数天（0 = 永久）` };
  }
  // compress 上游是 CheckBox（布尔）。缺失按 false（上游 data class 默认值也是 false）。
  const compress = o['compress'] === true;
  return {
    ok: true,
    rule: {
      uploadUrl: (o['uploadUrl'] as string).trim(),
      // ⚠️ `downloadUrlRule` **不能 trim**：默认规则里有 `$.data@js:if (result == '') \n '' \n else …`，
      //    前后空白是规则文本的一部分（虽然 trim 掉一般也无害），但更重要的是
      //    「用户写的就是要发出去的」，多余加工只会让排障时对不上。
      downloadUrlRule: o['downloadUrlRule'] as string,
      summary: (o['summary'] as string).trim(),
      compress,
      expiryDate,
    },
  };
}

/** `validateDirectLinkUploadRule` 的别名（旧名字更贴近「规范化」的语义，保留两个入口） */
export const normalizeDirectLinkUploadRule = validateDirectLinkUploadRule;

/**
 * 解析用户**粘贴/导入**的配置 JSON（上游两个菜单：`menu_paste_rule` 传单个对象、
 * `menu_import_default` 选一条内置规则）。
 *
 * 宽容点与上游一致但不越界：
 * - 接受**单个对象**或**数组**（数组用于「导入一份规则表」的场景，上游内置数据就是这个形状）；
 * - 用本仓 `parseJsonLoose`（`json-loose.ts`）解析 ⇒ 容忍 `//` 注释与「最后一个键带逗号」
 *   —— 用户从别处抄来的 json 常带这些，原样报「格式不对」体验很差；
 * - **任一条不合法 ⇒ 整体失败并指明是第几条**（不静默丢掉坏的那条：
 *   静默丢弃会变成「导入成功但少了一条」，属于本仓反复警惕的静默兜底）。
 */
export function parseDirectLinkUploadRules(
  text: string,
): { ok: true; rules: DirectLinkUploadRule[] } | { ok: false; error: string } {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, error: '内容为空' };

  // 先按严格 JSON 解析；失败再走宽松解析（`//` 注释、尾逗号等）。
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    try {
      data = parseJsonLoose(trimmed);
    } catch {
      return { ok: false, error: '不是合法 JSON（若内容是从对话里复制的，注意别把说明文字一起粘进来）' };
    }
  }

  const list = Array.isArray(data) ? data : [data];
  if (list.length === 0) return { ok: false, error: '规则列表为空' };
  // ⚠️ 宽松解析器对「完全不是 JSON」的输入会**原样返回字符串**（它优先服务「规则片段」场景）。
  //    这里必须显式挡掉：否则一段说明文字会被当成「一个非对象规则」，
  //    报出「规则必须是一个 JSON 对象」——用户看不出自己粘贴的内容压根不是 JSON。
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: '不是合法 JSON（若内容是从对话里复制的，注意别把说明文字一起粘进来）' };
  }
  const out: DirectLinkUploadRule[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = validateDirectLinkUploadRule(list[i]);
    if (!r.ok) {
      const where = Array.isArray(data) ? `第 ${i + 1} 条：` : '';
      return { ok: false, error: `${where}${r.error}` };
    }
    out.push(r.rule);
  }
  return { ok: true, rules: out };
}
