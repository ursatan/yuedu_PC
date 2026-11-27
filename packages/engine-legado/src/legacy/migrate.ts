/**
 * 旧版书源（v1）→ 新版（v3）迁移器
 *
 * 逐行对齐 LegadoTeam/legado @3.26082823
 *   app/src/main/java/io/legado/app/help/storage/ImportOldData.kt
 *     toNewRule            L251-305
 *     toNewUrls            L307-320
 *     toNewUrl             L322-370
 *     uaToHeader           L372-376
 *     contentDollar 内联   L234-237
 *     legacyTypeFromString L197-198
 *
 * ⚠️ 迁移不只是字段重命名，规则语法与 URL 语法本身也要转换。
 *
 * ── Kotlin / JS 语义差异（已逐处处理，勿"优化"掉）────────────────────
 * 1. Kotlin `String.replace(old, new)` 是**全量字面量**替换；
 *    JS `String.replace(old, new)` 只替换**首个**且 new 中 `$&`/`$1` 等会被解释。
 *    → 统一使用 `replaceAllLiteral()`（split + join），语义与 Kotlin 一致。
 * 2. Kotlin `String.split(delimiter: String)` 是**字面量**分割；
 *    JS `String.split(s)` 会把 s 当正则 —— `"a|b".split("|")` 会被拆成每个字符。
 *    → 统一使用 `splitLiteral()`。
 * 3. Kotlin `isNullOrBlank()` 视纯空白字符串为 blank（JS 的 `!s` 不等价）。
 *    → 统一使用 `isNullOrBlank()`。
 * 4. Kotlin `startsWith(x, ignoreCase = true)` → JS 需先 toLowerCase。
 * 5. Kotlin `HashMap` 无序，GSON 输出顺序不确定；此处按 headers→charset→method→body
 *    固定顺序输出，保证迁移结果可复现（JSON 对象本身无序，不影响语义）。
 */

const UA_NAME = 'User-Agent'; // 取自 constant/AppConst.kt L27，非推断

/** Kotlin: `@Header:\{.+?\}` with CASE_INSENSITIVE */
const HEADER_PATTERN = /@Header:\{.+?\}/i;
/** Kotlin: `\{\{.+?\}\}` with CASE_INSENSITIVE */
const JS_PATTERN = /\{\{.+?\}\}/i;
/** Kotlin: `"(&&|\r?\n)+".toRegex()` */
const MULTI_URL_SPLIT = /(&&|\r?\n)+/;
/** Kotlin: `"\n\\s*".toRegex()` */
const TRAILING_WS = /\n\s*/g;
/** Kotlin: `"<searchPage([-+]1)>".toRegex()` */
const SEARCH_PAGE_TAG = /<searchPage([-+]1)>/g;
/** Kotlin: `"searchPage([-+]1)".toRegex()` */
const SEARCH_PAGE_PLAIN = /searchPage([-+]1)/g;

// ── 语义对齐的工具函数 ────────────────────────────────────────────────

export function isNullOrBlank(s: string | null | undefined): boolean {
  return s == null || s.trim().length === 0;
}

/** 等价于 Kotlin `String.replace(oldValue, newValue)`：全量 + 字面量 + 不解释 $ */
export function replaceAllLiteral(
  s: string,
  oldValue: string,
  newValue: string,
): string {
  return s.split(oldValue).join(newValue);
}

/** 等价于 Kotlin `String.split(delimiter: String)`：字面量分割 */
export function splitLiteral(s: string, delimiter: string): string[] {
  return s.split(delimiter);
}

// ── 规则语法迁移 ──────────────────────────────────────────────────────

/**
 * 旧版规则语法 → 新版。
 *
 * 转换规则（仅当规则**不是**新式语法时执行）：
 *   `#`  → `##`（旧版用单 # 做清洗分隔）
 *   `|`  → `||`（旧版用单 | 做降级；若含 ##，只在 ## 前段替换，避免破坏正则）
 *   `&`  → `&&`（旧版用单 & 做拼接；排除含 http 或 / 开头的规则，避免误伤 URL query）
 *
 * 跳过条件：以 `@CSS:` / `@XPath:` / `//` / `##` / `:` 开头，或含 `@js:` / `<js>`
 *
 * 另处理前缀：`-` → 反向（reverse），`+` → allinone，转换后重新加回。
 */
export function toNewRule(oldRule: string | null | undefined): string | null {
  if (isNullOrBlank(oldRule)) return null;
  const src = oldRule as string;
  let newRule = src;
  let reverse = false;
  let allinone = false;

  if (src.startsWith('-')) {
    reverse = true;
    newRule = src.substring(1);
  }
  if (newRule.startsWith('+')) {
    allinone = true;
    newRule = newRule.substring(1);
  }

  const isModern =
    newRule.toLowerCase().startsWith('@css:') ||
    newRule.toLowerCase().startsWith('@xpath:') ||
    newRule.startsWith('//') ||
    newRule.startsWith('##') ||
    newRule.startsWith(':') ||
    newRule.toLowerCase().includes('@js:') ||
    newRule.toLowerCase().includes('<js>');

  if (!isModern) {
    if (newRule.includes('#') && !newRule.includes('##')) {
      // ⚠️ Legado 原版此处用的是 oldRule 而非 newRule（ImportOldData L271）。
      // 后果：当规则带 "-" 或 "+" 前缀时，替换会把前缀带回来，导致最终出现 "--" 前缀。
      // 此处按 1:1 原样复刻；若后续回归集发现真实旧源因此出错，再针对性修正。
      newRule = replaceAllLiteral(src, '#', '##');
    }

    if (newRule.includes('|') && !newRule.includes('||')) {
      if (newRule.includes('##')) {
        const list = splitLiteral(newRule, '##');
        const head = list[0];
        if (head !== undefined && head.includes('|')) {
          // 只替换 ## 之前的那一段，后面的正则部分保持原样
          newRule = replaceAllLiteral(head, '|', '||');
          for (let i = 1; i < list.length; i++) {
            newRule += '##' + (list[i] ?? '');
          }
        }
      } else {
        newRule = replaceAllLiteral(newRule, '|', '||');
      }
    }

    if (
      newRule.includes('&') &&
      !newRule.includes('&&') &&
      !newRule.includes('http') &&
      !newRule.startsWith('/')
    ) {
      newRule = replaceAllLiteral(newRule, '&', '&&');
    }
  }

  if (allinone) newRule = '+' + newRule;
  if (reverse) newRule = '-' + newRule;
  return newRule;
}

// ── URL 语法迁移 ──────────────────────────────────────────────────────

/** 按 `&&` 或换行拆分成多条 URL，逐条迁移后以 `\n` 连接 */
export function toNewUrls(oldUrls: string | null | undefined): string | null {
  if (isNullOrBlank(oldUrls)) return null;
  const src = oldUrls as string;

  if (src.startsWith('@js:') || src.startsWith('<js>')) {
    return src;
  }
  if (!src.includes('\n') && !src.includes('&&')) {
    return toNewUrl(src);
  }

  const urls = src.split(MULTI_URL_SPLIT);
  const parts = urls
    .map((it) => {
      const u = toNewUrl(it);
      return u == null ? null : u.replace(TRAILING_WS, '');
    })
    .filter((u): u is string => u != null && u.trim().length > 0);

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * 单条 URL 迁移：
 *   `<js>` 前缀   → `=searchKey`→`={{key}}`，`=searchPage`→`={{page}}`，直接返回
 *   `@Header:{…}` → 抽出转 headers
 *   `|` 后段      → charset
 *   `{{…}}`       → 暂存为 `$N` 占位（避免被后续 `{`→`<` 破坏）
 *   `{` `}`       → `<` `>`
 *   searchKey     → {{key}}
 *   searchPage±1  → {{page±1}}（尖括号与裸写两种形态）
 *   searchPage    → {{page}}
 *   `@` 后段      → POST body
 *   末尾拼 `,{json}` 附加参数
 */
export function toNewUrl(oldUrl: string | null | undefined): string | null {
  if (isNullOrBlank(oldUrl)) return null;
  let url: string = oldUrl as string;

  if ((oldUrl as string).toLowerCase().startsWith('<js>')) {
    url = replaceAllLiteral(url, '=searchKey', '={{key}}');
    url = replaceAllLiteral(url, '=searchPage', '={{page}}');
    return url;
  }

  const map: Record<string, string> = {};

  // 1) @Header:{...}
  const headerMatch = HEADER_PATTERN.exec(url);
  if (headerMatch) {
    const header = headerMatch[0];
    url = replaceAllLiteral(url, header, '');
    map['headers'] = header.substring(8); // "@Header:{" 恰好 8 字符，保留 "{...}"
  }

  // 2) | 后段为 charset（注意：字面量分割，非正则）
  let urlList = splitLiteral(url, '|');
  url = urlList[0] ?? '';
  if (urlList.length > 1) {
    const kv = splitLiteral(urlList[1] ?? '', '=');
    const charset = kv[1];
    // 只在有值时写入：JSON.stringify 会丢弃 undefined 键，
    // 与 GSON 默认忽略 null 的行为一致，输出等价。
    if (charset !== undefined) map['charset'] = charset;
  }

  // 3) {{...}} 暂存为 $N 占位
  const jsList: string[] = [];
  const globalJsPattern = new RegExp(JS_PATTERN.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = globalJsPattern.exec(url)) !== null) {
    const matched = m[0];
    jsList.push(matched);
    url = replaceAllLiteral(url, matched, `$${jsList.length - 1}`);
    globalJsPattern.lastIndex = 0; // Kotlin 每次都在新字符串上 find，重置以保持一致
  }

  // 4) 旧版单大括号 → 新版尖括号
  url = replaceAllLiteral(url, '{', '<');
  url = replaceAllLiteral(url, '}', '>');

  // 5) 搜索变量
  url = replaceAllLiteral(url, 'searchKey', '{{key}}');
  url = url.replace(SEARCH_PAGE_TAG, '{{page$1}}');
  url = url.replace(SEARCH_PAGE_PLAIN, '{{page$1}}');
  url = replaceAllLiteral(url, 'searchPage', '{{page}}');

  // 6) 还原暂存的 JS 表达式（值可能含 $，故用 split/join 而非 replace）
  for (let index = 0; index < jsList.length; index++) {
    const expr = jsList[index] ?? '';
    const restored = replaceAllLiteral(
      replaceAllLiteral(expr, 'searchKey', 'key'),
      'searchPage',
      'page',
    );
    url = splitLiteral(url, `$${index}`).join(restored);
  }

  // 7) @ 后段为 POST body
  urlList = splitLiteral(url, '@');
  url = urlList[0] ?? '';
  const body = urlList[1];
  if (urlList.length > 1 && body !== undefined) {
    map['method'] = 'POST';
    map['body'] = body;
  }

  if (Object.keys(map).length > 0) {
    url += ',' + JSON.stringify(map);
  }
  return url;
}

/** 旧版裸 UA 字符串 → `{"User-Agent":"..."}` JSON 串 */
export function uaToHeader(ua: string | null | undefined): string | null {
  if (ua == null || ua.length === 0) return null;
  return JSON.stringify({ [UA_NAME]: ua });
}

/** 正文规则：以 `$` 开头且不以 `$.` 开头时，去掉首字符 `$` */
export function contentDollar(content: string | null | undefined): string | null {
  if (content == null) return null;
  if (content.startsWith('$') && !content.startsWith('$.')) {
    return content.substring(1);
  }
  return content;
}

/** 旧版 bookSourceType 为字符串：仅 "AUDIO" → 1，其余一律 0 */
export function legacyTypeFromString(t: string | number | null | undefined): number {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return t === 'AUDIO' ? 1 : 0;
  return 0;
}

// ── 整源迁移 ──────────────────────────────────────────────────────────

type LegacyRaw = Record<string, unknown>;

/**
 * 旧版（v1 扁平）书源**独有**的键——取自本文件实际读取的旧字段，剔除两种格式共有的
 * 顶层字段（bookSourceUrl / Name / Group / Comment / login 系列 / coverDecodeJs 等），
 * 用于安全判定「这份 JSON 是否需要迁移」（避免把新格式源误迁移后丢字段）。
 */
const LEGACY_ONLY_KEYS = [
  'ruleSearchUrl', 'ruleSearchList', 'ruleSearchName', 'ruleSearchAuthor', 'ruleSearchKind',
  'ruleSearchLastChapter', 'ruleSearchIntroduce', 'ruleSearchCoverUrl', 'ruleSearchNoteUrl',
  'ruleFindUrl', 'ruleFindList', 'ruleFindName', 'ruleFindAuthor', 'ruleFindKind',
  'ruleFindLastChapter', 'ruleFindIntroduce', 'ruleFindCoverUrl', 'ruleFindNoteUrl',
  'ruleBookName', 'ruleBookAuthor', 'ruleBookKind', 'ruleBookLastChapter', 'ruleIntroduce',
  'ruleCoverUrl', 'ruleBookInfoInit',
  'ruleChapterList', 'ruleChapterName', 'ruleChapterUrl', 'ruleChapterUrlNext', 'ruleContentUrl',
  'ruleBookContent', 'ruleBookContentReplace', 'ruleContentUrlNext',
  'ruleBookUrlPattern', 'httpUserAgent',
] as const;

/** 是否为旧版扁平格式（v1）书源 → 需要先走 migrateLegacySource 再编译 */
export function isLegacyFlatSource(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return LEGACY_ONLY_KEYS.some((k) => o[k] !== undefined);
}


function str(raw: LegacyRaw, key: string): string | null {
  const v = raw[key];
  return typeof v === 'string' ? v : null;
}

/**
 * 旧版（扁平 ruleXxx）→ 新版（嵌套 ruleXxx 对象）。
 *
 * 对齐 ImportOldData.fromOldBookSource：
 *   五个规则对象**总是创建**（即使字段全为 null），与 Legado 行为一致。
 *   源类型缺失时 `enabledExplore` 在 `exploreUrl` 为空时置 false。
 */
export function migrateLegacySource(raw: LegacyRaw): LegacyRaw {
  const out: LegacyRaw = {};

  // 顶层直搬
  out.bookSourceUrl = str(raw, 'bookSourceUrl') ?? '';
  out.bookSourceName = str(raw, 'bookSourceName') ?? '';
  out.bookSourceGroup = str(raw, 'bookSourceGroup');
  out.loginUrl = str(raw, 'loginUrl');
  out.loginUi = str(raw, 'loginUi');
  out.loginCheckJs = str(raw, 'loginCheckJs');
  out.coverDecodeJs = str(raw, 'coverDecodeJs');
  out.bookSourceComment = str(raw, 'bookSourceComment') ?? '';
  out.bookUrlPattern = str(raw, 'ruleBookUrlPattern');
  out.customOrder = typeof raw['serialNumber'] === 'number' ? raw['serialNumber'] : 0;
  out.header = uaToHeader(str(raw, 'httpUserAgent'));
  out.searchUrl = toNewUrl(str(raw, 'ruleSearchUrl'));
  out.exploreUrl = toNewUrls(str(raw, 'ruleFindUrl'));
  out.bookSourceType = legacyTypeFromString(raw['bookSourceType'] as string | number | null);
  out.enabled = typeof raw['enable'] === 'boolean' ? raw['enable'] : true;

  // 规则对象（总是创建）
  out.ruleSearch = {
    bookList: toNewRule(str(raw, 'ruleSearchList')),
    name: toNewRule(str(raw, 'ruleSearchName')),
    author: toNewRule(str(raw, 'ruleSearchAuthor')),
    intro: toNewRule(str(raw, 'ruleSearchIntroduce')),
    kind: toNewRule(str(raw, 'ruleSearchKind')),
    bookUrl: toNewRule(str(raw, 'ruleSearchNoteUrl')),
    coverUrl: toNewRule(str(raw, 'ruleSearchCoverUrl')),
    lastChapter: toNewRule(str(raw, 'ruleSearchLastChapter')),
  };

  out.ruleExplore = {
    bookList: toNewRule(str(raw, 'ruleFindList')),
    name: toNewRule(str(raw, 'ruleFindName')),
    author: toNewRule(str(raw, 'ruleFindAuthor')),
    intro: toNewRule(str(raw, 'ruleFindIntroduce')),
    kind: toNewRule(str(raw, 'ruleFindKind')),
    bookUrl: toNewRule(str(raw, 'ruleFindNoteUrl')),
    coverUrl: toNewRule(str(raw, 'ruleFindCoverUrl')),
    lastChapter: toNewRule(str(raw, 'ruleFindLastChapter')),
  };

  out.ruleBookInfo = {
    init: toNewRule(str(raw, 'ruleBookInfoInit')),
    name: toNewRule(str(raw, 'ruleBookName')),
    author: toNewRule(str(raw, 'ruleBookAuthor')),
    intro: toNewRule(str(raw, 'ruleIntroduce')),
    kind: toNewRule(str(raw, 'ruleBookKind')),
    coverUrl: toNewRule(str(raw, 'ruleCoverUrl')),
    lastChapter: toNewRule(str(raw, 'ruleBookLastChapter')),
    tocUrl: toNewRule(str(raw, 'ruleChapterUrl')),
  };

  out.ruleToc = {
    chapterList: toNewRule(str(raw, 'ruleChapterList')),
    chapterName: toNewRule(str(raw, 'ruleChapterName')),
    chapterUrl: toNewRule(str(raw, 'ruleContentUrl')),
    nextTocUrl: toNewRule(str(raw, 'ruleChapterUrlNext')),
  };

  const content = toNewRule(str(raw, 'ruleBookContent')) ?? '';
  out.ruleContent = {
    content: contentDollar(content),
    replaceRegex: toNewRule(str(raw, 'ruleBookContentReplace')),
    nextContentUrl: toNewRule(str(raw, 'ruleContentUrlNext')),
  };

  // 与 Legado 一致：exploreUrl 为空则关闭发现
  if (isNullOrBlank(out.exploreUrl as string | null)) {
    out.enabledExplore = false;
  }

  return out;
}
