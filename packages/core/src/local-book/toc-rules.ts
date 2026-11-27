/**
 * TXT 目录规则（`#202`）
 *
 * 逐条来自上游 `assets/defaultData/txtTocRule.json`（**26 条，其中 12 条默认启用**），
 * 字段名沿用上游（`name` / `rule` / `enable` / `example`）。
 *
 * ## 为什么整表照搬而不是自己写几条
 * 目录规则是**经验集合** —— 针对不同排版（章节号带不带「第」、有没有书名括号、是否顶格）
 * 各有一条更合适的正则。上游把「哪几条默认开」也定好了（`enable`），照搬才能让
 * 「同一本 txt 在 App 和 PC 上分章结果一致」。少一条就会在某些书上少分/多分章节。
 *
 * ## 移植时做的**唯一**改动：内联标志
 * 上游 3 条规则写了 `(?m)` / `(?im)` 前缀（Java 的行内标志）。JS 的 `RegExp` 不支持这种写法，
 * 因此**把前缀剥掉并记在 `flags` 里**，构造正则时用 `new RegExp(rule, flags)` 传入。
 * 其余字符（含 `(?<=…)` 后行断言、全角空格）JS 与 Java 语义一致，未做改写。
 */

/** 一条 TXT 目录规则（字段名照上游 `TxtTocRule.kt`） */
export interface TxtTocRule {
  name: string;
  /** 正则**源码**（不含内联标志） */
  rule: string;
  /** 是否默认启用（上游 `enable`） */
  enable: boolean;
  /** 上游给的示例（用于理解这条规则适合什么排版） */
  example: string;
  /** 从内联标志剥出来的 RegExp flags（上游用 `Pattern.MULTILINE`，等价 `m`） */
  flags: string;
  /**
   * 标题**净化表达式**（上游 `TxtTocRule.replacement`，存进 `book.tocUrl` 的第二段）。
   *
   * ⚠️ 上游这里是**一段 JS**（`TextFile.kt:578` 用 Rhino `eval(jsStr, bindings)` 跑），
   * 绑定 `result`（标题原文）/`index`/`prevTitle`/`prevLength`/`lastVolumeTitle`。
   * **本仓不执行外来脚本**（铁律 4）⇒ 这里只接受**受支持的纯表达式子集**，
   * 判据与支持范围见 `sanitize.ts`；不支持的表达式**不改标题**并 `warnOnce` 留痕。
   *
   * 实测：上游 `assets/defaultData/txtTocRule.json` 的 26 条内置规则**全部为空串**
   * ⇒ 默认行为 = 不做任何净化（照抄标题）。字段存在只为「用户自定义规则」的往返保真。
   */
  replacement: string;
}

/**
 * 全部规则（顺序即上游顺序 = **匹配优先级**：越靠前越先试）。
 *
 * 选规则口径见 `txt.ts` 的 `pickTocRule()`：取「分出的章节数最多」的那条，但**后面的规则
 * 必须比当前最好成绩多出 2 条以上才换**（上游 `overRuleCount = 2`）—— 否则同分/略胜的规则
 * 会把已在用的稳定规则顶掉，导致同一本书两次导入分章结果不同。
 */
export const TXT_TOC_RULES: TxtTocRule[] = [

  {
    name: '目录(去空白)',
    rule: '(?<=[　\\s])(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和]))).{0,30}$',
    enable: true,
    example: '第一章 假装第一章前面有空白但我不要',
    flags: '',
    replacement: '',
  },
  {
    name: '目录',
    rule: '^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|篇(?!张))).{0,30}$',
    enable: true,
    example: '第一章 标准的粤语就是这样',
    flags: '',
    replacement: '',
  },
  {
    name: '目录(匹配简介)',
    rule: '(?<=[　\\s])(?:(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|回(?![合来事去])|场(?![和合比电是])|篇(?!张))).{0,30}$',
    enable: false,
    example: '简介 老夫诸葛村夫',
    flags: '',
    replacement: '',
  },
  {
    name: '目录(古典、轻小说备用)',
    rule: '^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|集(?![合和])|部(?![分赛游])|回(?![合来事去])|场(?![和合比电是])|话|篇(?!张))).{0,30}$',
    enable: false,
    example: '第一章 比上面只多了回和话',
    flags: '',
    replacement: '',
  },
  {
    name: '数字(纯数字标题)',
    rule: '(?<=[　\\s])\\d+\\.?[ 　\\t]{0,4}$',
    enable: false,
    example: '12',
    flags: '',
    replacement: '',
  },
  {
    name: '大写数字(纯数字标题)',
    rule: '(?<=[　\\s])[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,12}[ 　\\t]{0,4}$',
    enable: false,
    example: '一百七十',
    flags: '',
    replacement: '',
  },
  {
    name: '数字混合(纯数字标题)',
    rule: '(?<=[　\\s])[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟\\d]{1,12}[ 　\\t]{0,4}$',
    enable: false,
    example: '12\n一百七十',
    flags: '',
    replacement: '',
  },
  {
    name: '数字 分隔符 标题名称',
    rule: '^[ 　\\t]{0,4}\\d{1,5}[:：,.， 、_—\\-].{1,30}$',
    enable: true,
    example: '1、这个就是标题',
    flags: '',
    replacement: '',
  },
  {
    name: '大写数字 分隔符 标题名称',
    rule: '^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章?)[ 、_—\\-].{1,30}$',
    enable: true,
    example: '一、只有前面的数字有差别\n二十四章 我瞎编的标题',
    flags: '',
    replacement: '',
  },
  {
    name: '数字混合 分隔符 标题名称',
    rule: '^[ 　\\t]{0,4}(?:序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章?[ 、_—\\-]|\\d{1,5}章?[:：,.， 、_—\\-]).{0,30}$',
    enable: false,
    example: '1、人参公鸡\n二百二十章 boy next door',
    flags: '',
    replacement: '',
  },
  {
    name: '正文 标题/序号',
    rule: '^[ 　\\t]{0,4}正文[ 　]{1,4}.{0,20}$',
    enable: true,
    example: '正文 我奶常山赵子龙',
    flags: '',
    replacement: '',
  },
  {
    name: 'Chapter/Section/Part/Episode 序号 标题',
    rule: '^[ 　\\t]{0,4}(?:[Cc]hapter|[Ss]ection|[Pp]art|ＰＡＲＴ|[Nn][oO][.、]|[Ee]pisode|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)\\s{0,4}\\d{1,4}.{0,30}$',
    enable: true,
    example: 'Chapter 1 MyGrandmaIsNB',
    flags: '',
    replacement: '',
  },
  {
    name: 'Chapter(去简介)',
    rule: '^[ 　\\t]{0,4}(?:[Cc]hapter|[Ss]ection|[Pp]art|ＰＡＲＴ|[Nn][Oo]\\.|[Ee]pisode)\\s{0,4}\\d{1,4}.{0,30}$',
    enable: false,
    example: 'Chapter 1 MyGrandmaIsNB',
    flags: '',
    replacement: '',
  },
  {
    name: '特殊符号 序号 标题',
    rule: '(?<=[\\s　])[【〔〖「『〈［\\[](?:第|[Cc]hapter)[\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,10}[章节].{0,20}$',
    enable: true,
    example: '【第一章 后面的符号可以没有',
    flags: '',
    replacement: '',
  },
  {
    name: '特殊符号 标题(成对)',
    rule: '(?<=[\\s　]{0,4})(?:[\\[〈「『〖〔《（【\\(].{1,30}[\\)】）》〕〗』」〉\\]]?|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)[ 　]{0,4}$',
    enable: false,
    example: '『加个直角引号更专业』\n(11)我奶常山赵子聋',
    flags: '',
    replacement: '',
  },
  {
    name: '特殊符号 标题(单个)',
    rule: '(?<=[\\s　]{0,4})(?:[☆★✦✧].{1,30}|(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外)[ 　]{0,4}$',
    enable: true,
    example: '☆、晋江作者最喜欢的格式',
    flags: '',
    replacement: '',
  },
  {
    name: '章/卷 序号 标题',
    rule: '^[ \\t　]{0,4}(?:(?:内容|文章)?简介|文案|前言|序章|楔子|正文(?!完|结)|终章|后记|尾声|番外|[卷章][\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8})[ 　]{0,4}.{0,30}$',
    enable: true,
    example: '卷五 开源盛世',
    flags: '',
    replacement: '',
  },
  {
    name: '顶格标题',
    rule: '^\\S.{1,20}$',
    enable: false,
    example: '20字以内顶格写的都是标题',
    flags: '',
    replacement: '',
  },
  {
    name: '双标题(前向)',
    rule: '(?<=[ \\t　]{0,4})第[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章.{0,30}$(?=[\\s　]{0,8}第[\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章)',
    enable: false,
    example: '第一章 真正的标题\n第一章 这个不要',
    flags: 'm',
    replacement: '',
  },
  {
    name: '双标题(后向)',
    rule: '(?<=[ \\t　]{0,4}第[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章.{0,30}$[\\s　]{0,8})第[\\d零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}章.{0,30}$',
    enable: false,
    example: '第一章 这个标题不要\n第一章真正的标题',
    flags: 'm',
    replacement: '',
  },
  {
    name: '书名 括号 序号',
    rule: '^[一-龥]{1,20}[ 　\\t]{0,4}[(（][\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[)）][ 　\\t]{0,4}$',
    enable: true,
    example: '标题后面数字有括号(12)',
    flags: '',
    replacement: '',
  },
  {
    name: '书名 序号',
    rule: '^[一-龥]{1,20}[ 　\\t]{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[ 　\\t]{0,4}$',
    enable: true,
    example: '标题后面数字没有括号124',
    flags: '',
    replacement: '',
  },
  {
    name: '特定字符 标题 特定符号',
    rule: '(?<=\\={3,6}).{1,40}?(?=\\=)',
    enable: false,
    example: '===起这种标题干什么===',
    flags: '',
    replacement: '',
  },
  {
    name: '字数分割 分节阅读',
    rule: '(?<=[ 　\\t]{0,4})(?:.{0,15}分[页节章段]阅读[-_ ]|第\\s{0,4}[\\d零一二两三四五六七八九十百千万]{1,6}\\s{0,4}[页节]).{0,30}$',
    enable: true,
    example: '分节|分页|分段阅读\n第一页',
    flags: '',
    replacement: '',
  },
  {
    name: '通用规则',
    rule: '^.{0,6}(?:[引楔]子|正文(?!完|结)|[引序前]言|[序终]章|扉页|[上中下][部篇卷]|卷首语|后记|尾声|番外|={2,4}|第\\s{0,4}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+?\\s{0,4}(?:章|节(?!课)|卷|页[、 　]|集(?![合和])|部(?![分是门落])|篇(?!张))).{0,40}$|^.{0,6}[\\d〇零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟a-z]{1,8}[、. 　].{0,20}$',
    enable: false,
    example: '激进规则,适配更多非常用格式',
    flags: 'im',
    replacement: '',
  },
  {
    name: '默认分章规则',
    rule: '',
    enable: false,
    example: '兜底规则，请勿改动此内容',
    flags: '',
    replacement: '',
  },
];

/** 默认启用的规则（对应上游 `txtTocRuleDao.enabled`） */
export const DEFAULT_ENABLED_TXT_TOC_RULES: TxtTocRule[] = TXT_TOC_RULES.filter((r) => r.enable);
