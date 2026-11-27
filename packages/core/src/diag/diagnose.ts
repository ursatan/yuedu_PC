/**
 * `#550` **失败归因表**（无 LLM；D/E 两件的判据源）。
 *
 * 目的：`/api/run` 的报错是给程序看的（`SELECTOR_MISS@parse` / `HTTP 403` / `JS_TIMEOUT`），
 * 用户看不懂、也不知道下一步查什么。这里把「错误码/现象 → 可能原因 → 下一步」固化成表 ——
 * 这是 `legado-book-source-skill` 的 `troubleshoot.md` 在**本仓引擎口径**下的落地。
 *
 * 纪律：
 *  · **表驱动、可测**：每条一个 code，测试逐条对拍；
 *  · **有顺序**：具体错误（选择器/JS 语法）优先于泛化错误（HTTP/网络）；
 *  · **不猜站点**：能确定的写确定（403 = 过闸/登录），确定不了的写「先看 X」；
 *  · 结果侧（`tocError` / 0 章 / 0 段 / CF 页特征）单独判，不只靠错误字符串。
 */

export type DiagnosisSeverity = 'error' | 'warn' | 'info';

export interface Diagnosis {
  code: string;
  title: string;
  cause: string;
  /** 下一步（按顺序做，第 1 条通常就能定位） */
  next: string[];
  severity: DiagnosisSeverity;
}

interface Rule {
  re: RegExp;
  code: string;
  title: string;
  cause: string;
  next: string[];
  severity: DiagnosisSeverity;
}

/** 顺序 = 优先级（具体 → 泛化） */
const RULES: readonly Rule[] = [
  {
    re: /SOURCE_DISABLED/,
    code: 'SOURCE_DISABLED',
    title: '源被禁用了',
    cause: '该源在「源状态」里是关闭的，引擎直接拒绝运行',
    next: ['在源列表里启用该源（或检查是否被批量校验自动 markOnError 关掉）'],
    severity: 'warn',
  },
  {
    re: /SOURCE_NOT_FOUND|SOURCE_INVALID/,
    code: 'SOURCE_INVALID',
    title: '源定义不合法 / 找不到',
    cause: '主键（bookSourceUrl）为空或源已被删除',
    next: ['检查「基本」页的源地址是否为空', '若是刚导入的源，确认导入时没有被墓碑（removed）挡住'],
    severity: 'error',
  },
  {
    re: /JS_TIMEOUT|timeout|timed out|超时/i,
    code: 'JS_TIMEOUT',
    title: '脚本超时',
    cause: '规则脚本死循环、或同步 HTTP 在当前机器上阻塞太久',
    next: ['缩小脚本范围（先用「单字段试跑」排除是哪条规则）', '检查是否在循环里调 java.ajax', '若脚本含 document/JavaImporter，可能被留在了 L1（同步阻塞）'],
    severity: 'error',
  },
  {
    re: /Invalid or unexpected token|Unexpected token|Malformed arrow function|Unexpected identifier|Invalid regular expression|SyntaxError/i,
    code: 'JS_SYNTAX',
    title: '规则里的 JS 有语法错',
    cause: '脚本编译失败（常见：`map([a,b]=>` 缺括号、零宽字符、正则/字符串没闭合）',
    next: ['看报错给的行号与片段', '用 `pnpm check:lint --only L001,L002,L008` 看是否命中已知形态', '改完先「校验」再运行'],
    severity: 'error',
  },
  {
    re: /SELECTOR_MISS/i,
    code: 'SELECTOR_MISS',
    title: '选择器没命中',
    cause: '规则在该页面上匹配到 0 个元素 —— 页面结构变了，或选择器写错',
    next: ['用「站点探查」抓一次页面，确认不是 CF/登录页', '把该条规则单独试跑，看命中数', '检查是否多写了 `@attr` 后缀（列表规则尤其常见）'],
    severity: 'error',
  },
  {
    /**
     * **选择器本身解析不了**（XPath/CSS 语法错），如 `//h1@text` 报
     * `Position 9: Unparsed tokens: @ text`（`#551` 实测）。
     *
     * 归到 `SELECTOR_MISS`（表里没有更贴切的码）：它**确实是 0 命中**，只是原因是「选择器不成立」
     * 而不是「页面结构变了」——`cause` 里两种情况都写了，下一步不变（先看页面、再单独试跑）。
     *
     * 为什么值得单独一条：这类错误此前落到 `UNKNOWN`（「未识别的错误」+ 去看 trace），
     * 而用户看到的是「我的 XPath 写错了」这种一眼能改的东西，不该被推去翻 trace。
     * ⚠️ 语料实测：真实书源里 `//…@text` 这种写法 **0 例**（`//script[@src]` 是 XPath 谓词，
     *    不是 `@attr` 后缀）⇒ 它几乎总是用户手写时的笔误，报出来是纯收益。
     */
    /**
     * `#684` 补上 `xpath` 库（jsdom 内置那份）的真实报错形态：它抛的是
     * `Position 10: Expected nodeTest after axisSpecifier attribute`
     * —— 旧正则（`Unparsed tokens|Invalid XPath|…`）匹配不到，于是落到 `UNKNOWN`「未识别的错误」。
     *
     * 用户实测的触发写法：`//div[@//data-xpch/="card-list"]//article`（谓词里多写了 `//` 与 `/`）。
     * 这类错误**一眼就能改**，必须直接说「规则语法错」而不是推去看 trace。
     */
    re: /Unparsed tokens|Invalid XPath|XPath.*(syntax|invalid)|Invalid selector|bad selector|Position \d+:\s*(?:Expected|Unparsed|Invalid)|Expected nodeTest|Unable to parse (?:XPath|expression)|XPath\s*语法/i,
    code: 'SELECTOR_MISS',
    title: '选择器本身不成立（解析不了）',
    cause: 'XPath/CSS 表达式语法错 ⇒ 一个元素都选不到。常见：XPath 取文本写成 `@text`（应 `/text()`）、取属性写成 `@href`（应 `/@href`）、谓词写坏（`[@attr="v"]` 不要写成 `[@//attr/="v"]`）',
    next: ['XPath：取文本用 `//h1/text()`、取属性用 `//a/@href`、谓词用 `//div[@data-x="1"]`', 'CSS：属性后缀是 `.a@href`，不是 `.a/@href`', '把该条规则单独试跑，看命中数'],
    severity: 'error',
  },
  {
    re: /EMPTY_CONTENT|正文为空|EMPTY_BODY/i,
    code: 'EMPTY_CONTENT',
    title: '正文解出来是空的',
    cause: '正文规则没命中内容，或站点返回了错误页/需要登录',
    next: ['先看「目录」是否正常（目录都不对 ⇒ 先修目录）', '用正文规则对当前页试跑，看命中数', '检查正文是否在 iframe / 需要 webView'],
    severity: 'error',
  },
  {
    re: /\b403\b|Forbidden|访问被拒绝/i,
    code: 'HTTP_403',
    title: '被站点拒绝（403）',
    cause: '过闸（CF/盾）/ 需要登录 / 请求头不像真浏览器',
    next: ['打开验证窗过一次闸（清关后同源请求会静默通过）', '检查源 header 规则与登录态', '若站点要求 UA/Referer，补进「基本」页的 header'],
    severity: 'error',
  },
  {
    re: /\b429\b|Too Many Requests|限流/i,
    code: 'HTTP_429',
    title: '被限流（429）',
    cause: '请求太密（源级限频没设 / 并发太高）',
    next: ['给源设 `concurrentRate`（源级限频）', '降低批量校验并发', '等一段时间再试'],
    severity: 'warn',
  },
  {
    re: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|网络/i,
    code: 'NETWORK',
    title: '网络层失败',
    cause: '域名解析/连接失败（站点挂了、DNS、或本机代理）',
    next: ['浏览器直接打开源地址确认站点可达', '检查是否走了代理（`/api/network-proxy`）', '换网络/等站点恢复'],
    severity: 'warn',
  },
  {
    /**
     * `#688` **规则 JS 的「类型用错」** —— 与「引擎能力缺口」必须分开。
     *
     * 实测（橙果短剧 `ruleContent.content`）：规则是 `script[id="__NUXT_DATA__"]` + `<js>result.match(…)…</js>`，
     * **取值路径**里 `result` 是字符串 ⇒ 正常出 m3u8；**取元素路径**里 `result` 是元素集合
     * ⇒ `result.match is not a function`。
     *
     * 这条错误原来被下面的 `UNSUPPORTED`（`not a function`）吞掉，显示成「引擎能力缺口 / 未实现 API」，
     * 于是用户会去翻 `capability-inventory` 找一个根本不存在的缺口。真正的改法在规则侧。
     * 只匹配「`result.xxx` 不是函数」与「读 undefined 的属性」两种，**不碰** `java.xxx is not a function`
     * （那才是引擎缺口，仍归 `UNSUPPORTED`）。
     */
    re: /result\.[A-Za-z_$][\w$]* is not a function|Cannot read propert(?:y|ies) of (?:undefined|null)/i,
    code: 'JS_RUNTIME',
    title: '规则 JS 运行期出错（类型用错）',
    cause:
      '脚本里对 `result`（或 undefined 上的属性）用了不存在的方法 —— 最常见是 `result` 的类型随路径不同：'
      + '**取值路径**给的是字符串，**取元素路径 / 列表字段**给的是元素集合（`result.match` 在那边必然报错）',
    next: [
      '先用 `String(result)` 或 `result.textContent` 取到字符串，再做正则/字符串操作',
      '或把这条规则填在**取值字段**（content / chapterName 等），别填列表字段',
      '查看器里点「匹配」看「值」与「元素」两种口径的差异',
    ],
    severity: 'error',
  },
  {
    re: /UNSUPPORTED|NOT_IMPLEMENTED|not a function|is not defined/i,
    code: 'UNSUPPORTED',
    title: '引擎能力缺口 / 未实现 API',
    cause: '规则用了本仓未实现的 Java API 或方法',
    next: ['看报错里的 API 名', '对照 `docs/live/capability-inventory.md` 是否已登记「暂缓」', '若属新 API，登记到 backlog'],
    severity: 'warn',
  },
];

/** 内容侧特征（结果里能看到页面内容时） */
const CF_HINTS = [/just a moment/i, /cf-challenge/i, /attention required/i, /challenge-platform/i, /验证码|人机验证|安全验证/];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 在结果对象里找「最像报错」的字段（tocError / error / items 为空 …） */
function fromResult(result: unknown): Diagnosis | null {
  if (!result || typeof result !== 'object') return null;
  const o = result as Record<string, unknown>;
  const tocError = str(o['tocError']);
  if (tocError) {
    const base = diagnoseFailure({ error: tocError });
    return base
      ? { ...base, title: `目录失败：${base.title}`, next: ['先修目录（目录不通，正文/书架都无从谈起）', ...base.next] }
      : null;
  }
  const err = str(o['error']);
  if (err) return diagnoseFailure({ error: err });
  // 搜索 0 条 / 目录 0 章 / 正文 0 段 —— 结果形状本身就能定位
  const items = o['items'];
  const chapters = o['chapters'];
  const paragraphs = o['paragraphs'];
  const content = o['content'];
  if (Array.isArray(items) && items.length === 0) {
    return { code: 'SEARCH_EMPTY', title: '搜索 0 条', cause: '搜索规则在该关键词上没解析出任何结果', next: ['换个关键词（有的站只支持书名全匹配）', '用「站点探查」看搜索结果页是否正常', '检查 bookList 选择器与 bookUrl 规则'], severity: 'warn' };
  }
  if (Array.isArray(chapters) && chapters.length === 0) {
    return { code: 'TOC_EMPTY', title: '目录 0 章', cause: '目录规则没解析出章节（下一章分页/选择器/正文入口都可能）', next: ['检查 chapterList 选择器命中数', '若是分页目录，看 nextTocUrl 是否写对', '确认 tocUrl 取到的是目录页而不是详情页'], severity: 'error' };
  }
  if (Array.isArray(paragraphs) && paragraphs.length === 0) {
    return { code: 'CONTENT_EMPTY', title: '正文 0 段', cause: '正文规则没命中（或内容被站点替换成提示页）', next: ['先看目录是否正常', '用正文规则试跑并看命中数', '检查是否需要在 webView 里渲染'], severity: 'error' };
  }
  if (typeof content === 'string' && CF_HINTS.some((re) => re.test(content))) {
    return { code: 'CF_PAGE', title: '抓到的是过闸/验证页', cause: '站点返回了 CF 挑战页或人机验证页，不是内容页', next: ['打开验证窗过一次闸（清关后同源请求会静默通过）', '确认该源的渲染模式（webView）是否必要'], severity: 'error' };
  }
  return null;
}

/**
 * 归因入口：先看结果形状，再看错误字符串；都没有则返回 null。
 * @param input.error  错误消息（`/api/run` 的 error / 调试面板的 dbgError）
 * @param input.result 成功返回体（也可能内含 `tocError` / 空列表）
 */
export function diagnoseFailure(input: { error?: string; result?: unknown }): Diagnosis | null {
  const errText = str(input.error).trim();
  const fromRes = fromResult(input.result);
  if (fromRes) return fromRes;
  if (!errText) return null;
  for (const r of RULES) {
    if (r.re.test(errText)) return { code: r.code, title: r.title, cause: r.cause, next: r.next, severity: r.severity };
  }
  return {
    code: 'UNKNOWN',
    title: '未识别的错误',
    cause: errText.slice(0, 200),
    next: ['看调试输出里的 trace（阶段 + 规则名）', '把错误与源名贴出来，便于定位'],
    severity: 'error',
  };
}

/** 表自检用（测试断言 id 唯一、每条都有下一步） */
export const DIAGNOSE_CODES: readonly string[] = ['SOURCE_DISABLED', 'SOURCE_INVALID', 'JS_TIMEOUT', 'JS_SYNTAX', 'SELECTOR_MISS', 'EMPTY_CONTENT', 'HTTP_403', 'HTTP_429', 'NETWORK', 'JS_RUNTIME', 'UNSUPPORTED'];
