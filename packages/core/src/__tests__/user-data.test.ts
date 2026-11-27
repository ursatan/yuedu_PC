/**
 * 用户数据契约回归测试（Phase 1.1）。
 *
 * 目的有二：
 * 1. **锁住「字段数量」** —— 契约要求逐条对照 `F:\legado` 实体，字段数是硬指标
 *    （历史上出过 BookSource 38/33、RssSource 40/45 的估算错误）。
 *    将来有人多写/少写一个字段，这里会红。
 * 2. **锁住「默认值」** —— 默认值全部来自 Legado 源码，改动即破坏兼容。
 *
 * 若某条断言失败，**先回去核对 Legado 源文件**，不要顺手改断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_TYPE_ALL,
  BOOK_TYPE_ALL_LOCAL,
  BookGroupId,
  BookType,
  ChineseConvertType,
  LOCAL_TAG,
  READ_STYLE_KEYS,
  REPLACE_RULE_ORDER_DEFAULT,
  UNKNOWN_TITLE_LENGTH,
  WEBDAV_TAG,
  displayCover,
  displayIntro,
  emptyBookmark,
  emptyBookHighlight,
  emptyBookGroup,
  emptyBookReadConfig,
  emptyCacheEntry,
  emptyGlobalReaderPrefs,
  emptyReadRecord,
  emptyReplaceRule,
  emptyShelfBook,
  emptyShelfChapter,
  emptyUiCoverConfig,
  emptyUiThemeConfig,
  highlightBodyPos,
  isBookType,
  replaceRuleTimeout,
  toReadProgress,
  unreadChapterNum,
} from '../contract/user-data';

/* ---------------- 字段数量（对应 Legado 实体的持久化字段数） ---------------- */

/**
 * **本仓扩展字段**（Legado 实体里**没有**的）—— 新增时必须登记在这里。
 *
 * 为什么要这份名单：本文件的其它断言锁的是「与 Legado 逐条一致」，
 * 而扩展字段天然会让字段数多出来。若不显式分开，只有两种坏结果：
 * ① 有人直接把期望数字 +1（那「与 Legado 一致」就失效了，以后随便加字段没人管）；
 * ② 有人不敢加扩展字段（于是去借 `variable` 之类的槽 —— 2026-09-25 评估过，会撞源脚本命名空间）。
 * 所以：**总数 = Legado 字段数 + 本名单长度**，且名单里的字段必须真实存在。
 */
const SHELF_BOOK_EXTENSIONS = ['payload', 'readStyle'] as const;

/**
 * `GlobalReaderPrefs` 里来自 `ReadBookConfig.Config` 的**排版项**（`#145` 新增）。
 * 单独列出来是为了让「字段数断言」能说清「哪 8 个是全局项、哪 9 个是排版项」，
 * 而不是变成一句 `=== 17`（数字对不上时看不出是漏了哪个来源）。
 */
const READ_PREFS_TYPOGRAPHY_KEYS = [
  'textSize',
  'titleSize',
  'textBold',
  'letterSpacing',
  'lineSpacingExtra',
  'paragraphSpacing',
  'paragraphIndent',
  'textFont',
  'titleFont',
] as const;

/**
 * `GlobalReaderPrefs` 里的**全局项**（`AppConfig`/`ReadBookConfig` 顶层）。
 * `shareLayout` 是 `#173` 新增的「共用布局」开关（上游 `ReadBookConfig.shareLayout`）。
 * `highlightLastStyle` 是 `#256` 新增的「上次高亮样式」（上游 `PreferKey.highlightLastStyle`，
 *   在 `AppConfig` 的 prefer 集合里 ⇒ 归这一组）。
 */
const READ_PREFS_GLOBAL_KEYS = [
  'themeMode',
  'chineseConverterType',
  'bookshelfSort',
  'replaceEnableDefault',
  'enableReadRecord', // `#144`（AppConfig.enableReadRecord）
  'readBodyToLh',
  'autoReadSpeed',
  'audioSkipOpenCredits',
  'audioSkipCloseCredits',
  'shareLayout',
  'highlightLastStyle', // `#256`（PreferKey.highlightLastStyle）
  'manualReplaceRuleEnabled', // `#261`（AppConfig.manualReplaceRule，默认 false）
] as const;

/**
 * `GlobalReaderPrefs` 里 `#163` 新增的**界面主题 / 封面配置**项。
 * 它们**不属于 Legado 的某个实体**（上游是 `ThemeConfig` + `SharedPreferences` + `themeConfig.json`
 * 三个来源），所以单独列一组：**总数 = 全局项 + 9 排版项 + 本名单长度**。
 */
const READ_PREFS_UI_KEYS = ['uiDayTheme', 'uiNightTheme', 'uiThemes', 'cover'] as const;

/**
 * `GlobalReaderPrefs` 里 `#164` 新增的**阅读样式全面化**项（25 项 + `pageAnim`）
 * 与 `#221` 新增的**页眉 / 页脚**项（27 项）。

 * 它们**全部来自 `ReadBookConfig.Config`**（背景 4 / 文字色 6 / 边距 4 / 标题 5 / 下划线 6 /
 * 翻页动画 1 / 页眉页脚 27），与上一组「排版项」同源，只是分三批落地
 * （`#145` 9 项 + `#164` 25 项 + `pageAnim` + `#221` 27 项）。
 * ⚠️ 与契约的 `READ_STYLE_KEYS` 是**两个不同的集合**，别混：
 *  · 这里的 53 项 = prefs **新增**的字段（用于数「GlobalReaderPrefs 一共几个字段」）；
 *  · `READ_STYLE_KEYS`（62 项）= 「**可被每本书覆盖**」的白名单（= 上面的 53 + 排版 9）。
 *  两者混用会让「字段数」与「可覆盖范围」两个断言互相污染。
 */
const READ_PREFS_STYLE_KEYS = [
  'bgStr', 'bgStrNight', 'bgStrEInk', 'bgAlpha',
  'textColor', 'textColorNight', 'textColorEInk',
  'textAccentColor', 'textAccentColorNight', 'textAccentColorEInk',
  'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom',
  'titleMode', 'titleColor', 'titleTopSpacing', 'titleBottomSpacing', 'titleLineSpacingExtra',
  'underlineMode', 'underlineColor', 'underlineWidth', 'underlineDistance',
  'underlineBodyEnabled', 'underlineTitleEnabled',
  'pageAnim',
  // ── `#221` 页眉 / 页脚（27 项，`ReadBookConfig.kt:922-948`）
  'headerMode', 'footerMode',
  'tipHeaderLeft', 'tipHeaderMiddle', 'tipHeaderRight',
  'tipFooterLeft', 'tipFooterMiddle', 'tipFooterRight',
  'tipHeaderLeftTemplate', 'tipHeaderMiddleTemplate', 'tipHeaderRightTemplate',
  'tipFooterLeftTemplate', 'tipFooterMiddleTemplate', 'tipFooterRightTemplate',
  'tipTextSize', 'tipColor', 'tipDividerColor',
  'headerPaddingTop', 'headerPaddingLeft', 'headerPaddingRight', 'headerPaddingBottom',
  'footerPaddingTop', 'footerPaddingLeft', 'footerPaddingRight', 'footerPaddingBottom',
  'showHeaderLine', 'showFooterLine',
  // `#235` 页眉/页脚**独立**字号·文字色·分隔线色 + 线型（上游只有一份，本仓按侧拆开）
  'headerTextSize', 'headerTextColor', 'headerDividerColor',
  'footerTextSize', 'footerTextColor', 'footerDividerColor',
  'headerLineStyle', 'footerLineStyle',
  // ★ `#249` **背景图片三套**（与 bgStr 对称）。上游用 `bgType*` +「同槽复用 bgStr 装路径」
  //   表达（`ReadBookConfig.kt:814-826`），本仓**另开三字段**（理由见契约 `bgImgPath` 注释）。
  'bgImgPath', 'bgImgPathNight', 'bgImgPathEInk',
  // ★ `#250` **栏位透明**：标题栏 / 页眉 / 页脚各一组「透明开关 + 不透明度」。
  //   **上游没有这些字段**（`ll_header`/`ll_footer` 自身无 `android:background` ⇒ 恒透明、不可配；
  //   工具栏在另一个 Activity 层）⇒ 与 `#235`/`#249` 同属「本仓显式登记的扩展字段」。
  'toolbarTransparent', 'toolbarAlpha',
  'headerTransparent', 'headerAlpha',
  'footerTransparent', 'footerAlpha',
] as const;

/** `GlobalReaderPrefs` 字段总数的**权威表达式**（改契约就必须改这里，改不动说明漏了登记） */
const READ_PREFS_TOTAL =
  READ_PREFS_GLOBAL_KEYS.length
  + READ_PREFS_TYPOGRAPHY_KEYS.length
  + READ_PREFS_UI_KEYS.length
  + READ_PREFS_STYLE_KEYS.length;

test('契约字段数：与 Legado 实体逐条一致（另有显式登记的扩展字段）', () => {
  // Book.kt:43-129 —— 34 个持久化字段（不含 @Ignore/@IgnoredOnParcel 的 infoHtml/tocHtml/downloadUrls 等）
  const keys = Object.keys(emptyShelfBook());
  assert.equal(
    keys.length,
    34 + SHELF_BOOK_EXTENSIONS.length,
    `ShelfBook = 34 个 Legado 字段 + ${SHELF_BOOK_EXTENSIONS.length} 个本仓扩展`,
  );
  for (const k of SHELF_BOOK_EXTENSIONS) {
    assert.ok(keys.includes(k), `登记的扩展字段「${k}」必须真实存在于契约里（登记与实现不能脱节）`);
  }
  // Book.ReadConfig（Book.kt:494-513）—— 19 个字段
  assert.equal(Object.keys(emptyBookReadConfig()).length, 19, 'BookReadConfig');
  // BookChapter.kt:43-59 —— 17 个字段
  assert.equal(Object.keys(emptyShelfChapter()).length, 17, 'ShelfChapter');
  // AppConfig/ReadBookConfig 全局项 + ReadBookConfig.kt:868-917 的排版 9 项 + `#163` 界面主题 4 项
  const prefsKeys = Object.keys(emptyGlobalReaderPrefs());
  assert.equal(
    prefsKeys.length,
    READ_PREFS_TOTAL,
    'GlobalReaderPrefs = 全局项（含 #256 的 highlightLastStyle）+ 9 个排版项（#145）+ 4 个界面主题项（#163）+ 阅读样式项（#164 26 + #221 页眉页脚 27 + #235 独立样式 8 + #249 背景图片 3 + #250 栏位透明 6）',
  );
  for (const k of READ_PREFS_GLOBAL_KEYS) {
    assert.ok(prefsKeys.includes(k), `登记的全局字段「${k}」必须真实存在于契约里`);
  }
  for (const k of READ_PREFS_TYPOGRAPHY_KEYS) {
    assert.ok(prefsKeys.includes(k), `登记的排版字段「${k}」必须真实存在于契约里`);
  }
  for (const k of READ_PREFS_UI_KEYS) {
    assert.ok(prefsKeys.includes(k), `登记的界面主题字段「${k}」必须真实存在于契约里`);
  }
  for (const k of READ_PREFS_STYLE_KEYS) {
    assert.ok(prefsKeys.includes(k), `登记的阅读样式字段「${k}」必须真实存在于契约里`);
  }
  /**
   * ★ 防空转：`READ_PREFS_STYLE_KEYS`（本文件，25 项）与契约的 `READ_STYLE_KEYS`（可覆盖白名单，34 项）
   * 必须**精确对得上**：`契约白名单 = 排版 9 + 样式 25`。
   * 只数总数是假通过 —— 「契约里多了一个可覆盖键、但本文件没登记」会让总数照样对（因为另一个方向漏了）。
   */
  assert.deepEqual(
    [...READ_STYLE_KEYS].sort(),
    [...READ_PREFS_TYPOGRAPHY_KEYS, ...READ_PREFS_STYLE_KEYS].sort(),
    '契约的可覆盖白名单必须恰好等于「排版 9 + 阅读样式 26（#164 + pageAnim）」',
  );
});

/* ---------------- GlobalReaderPrefs 排版项默认值（`ReadBookConfig.kt:868-917`） ---------------- */

test('GlobalReaderPrefs 排版默认值逐条等于 Legado Config 主构造器的默认值', () => {
  const p = emptyGlobalReaderPrefs();
  // 逐条对照 `ReadBookConfig.kt` 的 `data class Config(...)`（行号见各断言消息）
  assert.equal(p.textSize, 20, 'ReadBookConfig.kt:891 —— Config.textSize 默认 20（不是 Web 旧默认 15！）');
  assert.equal(p.titleSize, 0, 'ReadBookConfig.kt:897 —— 0 = 「不单独设置」，UI 上显示为跟随正文');
  assert.equal(p.textBold, 0, 'ReadBookConfig.kt:890 —— 0 正常 / 1 粗体 / 2 细体');
  assert.equal(p.letterSpacing, 0.1, 'ReadBookConfig.kt:892 —— 0.1f，单位是 em');
  assert.equal(p.lineSpacingExtra, 12, 'ReadBookConfig.kt:893 —— 12，是「行高之外的增量」而非总行高');
  assert.equal(p.paragraphSpacing, 2, 'ReadBookConfig.kt:895');
  assert.equal(p.paragraphIndent, '　　', 'ReadBookConfig.kt:905 —— 两个全角空格（U+3000）');
  assert.equal(p.paragraphIndent.length, 2, '缩进必须是 2 个字符（防被 trim 成空串）');
  assert.equal(p.textFont, '', 'ReadBookConfig.kt:888 —— 空 = 系统默认字体');
  assert.equal(p.titleFont, '', 'ReadBookConfig.kt:889 —— 空 = 跟随正文字体');
});

/* ---------------- BookType 位掩码（BookType.kt:14-54） ---------------- */

test('BookType 位值与 Legado 一致', () => {
  assert.equal(BookType.video, 4);
  assert.equal(BookType.text, 8);
  assert.equal(BookType.updateError, 16);
  assert.equal(BookType.audio, 32);
  assert.equal(BookType.image, 64);
  assert.equal(BookType.webFile, 128);
  assert.equal(BookType.local, 256);
  assert.equal(BookType.archive, 512);
  assert.equal(BookType.notShelf, 1024);
  // allBookType = video | text | image | audio | webFile = 4+8+64+32+128 = 236
  assert.equal(BOOK_TYPE_ALL, 236);
  assert.equal(BOOK_TYPE_ALL_LOCAL, 236 + 256);
  assert.equal(LOCAL_TAG, 'loc_book');
  assert.equal(WEBDAV_TAG, 'webDav::');
});

test('isBookType 是位掩码判定（DAO 用 `type & :type > 0`）', () => {
  const t = BookType.video | BookType.audio;
  assert.equal(isBookType(t, BookType.video), true);
  assert.equal(isBookType(t, BookType.audio), true);
  assert.equal(isBookType(t, BookType.text), false);
  assert.equal(isBookType(t, BookType.local), false);
});

/* ---------------- ShelfBook 默认值（Book.kt） ---------------- */

test('emptyShelfBook：默认值与 Book.kt 的 @ColumnInfo default 一致', () => {
  const now = 1_700_000_000_000;
  const b = emptyShelfBook(now);
  assert.equal(b.bookUrl, '', 'bookUrl 是主键，默认空串');
  assert.equal(b.origin, LOCAL_TAG, 'origin 默认 BookType.localTag（是"本地书"而不是空串）');
  assert.equal(b.type, BookType.text, 'type 默认 BookType.text(8)（SQL 列默认 "0" 是历史遗留）');
  assert.equal(b.group, 0);
  assert.equal(b.canUpdate, true);
  assert.equal(b.totalChapterNum, 0);
  assert.equal(b.durChapterIndex, 0);
  assert.equal(b.durVolumeIndex, 0, 'durVolumeIndex 默认 0');
  assert.equal(b.chapterInVolumeIndex, 0, 'chapterInVolumeIndex 默认 0');
  assert.equal(b.durChapterPos, 0);
  assert.equal(b.syncTime, 0, 'syncTime 默认 0（唯一不用当前时间的时间字段）');
  assert.equal(b.readConfig, null, 'readConfig 默认 null，读时惰性初始化');
  // 三个时间字段默认取当前时间 → 用注入值保证可测试
  assert.equal(b.latestChapterTime, now);
  assert.equal(b.lastCheckTime, now);
  assert.equal(b.durChapterTime, now);
  // 需要「空」的字段确实是 null 而不是 ''
  for (const k of ['kind', 'customTag', 'coverUrl', 'customCoverUrl', 'intro', 'customIntro', 'charset', 'latestChapterTitle', 'durChapterTitle', 'wordCount', 'variable', 'persistedCoverUrl'] as const) {
    assert.equal(b[k], null, `${k} 应为 null（Kotlin 侧是可空类型）`);
  }
});

test('ShelfBook 的 null 语义与空串语义不能混（Kotlin `String?` vs `String`）', () => {
  const b = emptyShelfBook(0);
  // 不可空字段是 ''，可空字段是 null —— 这是 Legado 的原始区分，别统一成一种
  assert.equal(typeof b.name, 'string');
  assert.equal(b.name, '');
  assert.equal(b.coverUrl, null);
});

/* ---------------- BookReadConfig 默认值（Book.kt:494-513） ---------------- */

test('emptyBookReadConfig：默认值与 ReadConfig 主构造器一致', () => {
  const c = emptyBookReadConfig();
  assert.equal(c.reverseToc, false);
  assert.equal(c.tocExpanded, true);
  assert.equal(c.pageAnim, null);
  assert.equal(c.reSegment, false);
  assert.equal(c.imageStyle, null);
  assert.equal(c.useReplaceRule, null, 'null = 跟随全局 replaceEnableDefault');
  assert.equal(c.delTag, 0);
  assert.equal(c.ttsEngine, null);
  assert.equal(c.splitLongChapter, true);
  assert.equal(c.readSimulating, false);
  assert.equal(c.startDate, null);
  assert.equal(c.startChapter, null);
  assert.equal(c.dailyChapters, 3);
  assert.equal(c.openCredits, 0);
  assert.equal(c.closeCredits, 0);
  assert.equal(c.playMode, 0);
  assert.equal(c.playSpeed, 1.0);
  assert.equal(c.useGlobalAudioSkip, false);
  assert.deepEqual(c.manualReplaceRuleIds, []);
});

/* ---------------- ShelfChapter 默认值（BookChapter.kt:42-60） ---------------- */

test('emptyShelfChapter：默认值 + 复合主键两个字段', () => {
  const ch = emptyShelfChapter('https://b/1', 7);
  assert.equal(ch.url, '', 'url 是复合主键之一');
  assert.equal(ch.bookUrl, 'https://b/1', 'bookUrl 是复合主键之一');
  assert.equal(ch.index, 7);
  assert.equal(ch.isVolume, false);
  assert.equal(ch.isVip, false);
  assert.equal(ch.isPay, false);
  assert.equal(ch.title, '');
  assert.equal(ch.baseUrl, '');
  for (const k of ['resourceUrl', 'tag', 'wordCount', 'start', 'end', 'startFragmentId', 'endFragmentId', 'variable', 'imgUrl'] as const) {
    assert.equal(ch[k], null, `${k} 应为 null`);
  }
});

/* ---------------- 派生逻辑（照抄 Legado 方法） ---------------- */

test('displayCover 优先级：persistedCoverUrl > customCoverUrl > coverUrl', () => {
  assert.equal(displayCover({ persistedCoverUrl: 'p', customCoverUrl: 'c', coverUrl: 's' }), 'p');
  assert.equal(displayCover({ persistedCoverUrl: '', customCoverUrl: 'c', coverUrl: 's' }), 'c');
  assert.equal(displayCover({ persistedCoverUrl: null, customCoverUrl: '', coverUrl: 's' }), 's');
  assert.equal(displayCover({ persistedCoverUrl: null, customCoverUrl: null, coverUrl: null }), null);
});

test('displayIntro：customIntro 为空串时回落到 intro', () => {
  assert.equal(displayIntro({ customIntro: '我的简介', intro: '源简介' }), '我的简介');
  assert.equal(displayIntro({ customIntro: '', intro: '源简介' }), '源简介');
  assert.equal(displayIntro({ customIntro: null, intro: '源简介' }), '源简介');
});

test('unreadChapterNum：clamp 到 0（Book.getUnreadChapterNum）', () => {
  assert.equal(unreadChapterNum({ totalChapterNum: 100, durChapterIndex: 10 }), 89);
  assert.equal(unreadChapterNum({ totalChapterNum: 10, durChapterIndex: 9 }), 0);
  assert.equal(unreadChapterNum({ totalChapterNum: 10, durChapterIndex: 99 }), 0, '不能出现负数');
});

test('toReadProgress：从书架条目派生进度视图（BookProgress.kt:12-19）', () => {
  const b = emptyShelfBook(1234);
  b.name = '书名';
  b.author = '作者';
  b.durChapterIndex = 5;
  b.durChapterPos = 100;
  b.durChapterTitle = '第五章';
  assert.deepEqual(toReadProgress(b), {
    name: '书名',
    author: '作者',
    durChapterIndex: 5,
    durChapterPos: 100,
    durChapterTime: 1234,
    durChapterTitle: '第五章',
  });
});

/* ---------------- 其它实体的常量/工具 ---------------- */

test('ReplaceRule：默认超时 3000ms，≤0 时回落到 3000', () => {
  assert.equal(replaceRuleTimeout({ timeoutMillisecond: 5000 }), 5000);
  assert.equal(replaceRuleTimeout({ timeoutMillisecond: 0 }), 3000);
  assert.equal(replaceRuleTimeout({ timeoutMillisecond: -1 }), 3000);
  assert.equal(REPLACE_RULE_ORDER_DEFAULT, -2147483648, 'Int.MIN_VALUE');
});

test('BookHighlight：layoutTitleLength 哨兵与正文偏移换算', () => {
  assert.equal(UNKNOWN_TITLE_LENGTH, -1);
  // 已知标题长度：直接减
  assert.equal(highlightBodyPos(100, 10, 999), 90);
  // 未知：用当前标题长度
  assert.equal(highlightBodyPos(100, UNKNOWN_TITLE_LENGTH, 10), 90);
  // 不能为负
  assert.equal(highlightBodyPos(5, 10, 0), 0);
});

test('BookGroupId 内置分组常量（BookGroup.kt:32-41）', () => {
  assert.equal(BookGroupId.root, -100);
  assert.equal(BookGroupId.all, -1);
  assert.equal(BookGroupId.local, -2);
  assert.equal(BookGroupId.audio, -3);
  assert.equal(BookGroupId.netNone, -4);
  assert.equal(BookGroupId.localNone, -5);
  assert.equal(BookGroupId.video, -6);
  assert.equal(BookGroupId.error, -11);
});

test('ChineseConvertType：1=繁转简 2=简转繁（BookChapter.kt:131-136）', () => {
  assert.equal(ChineseConvertType.none, 0);
  assert.equal(ChineseConvertType.t2s, 1);
  assert.equal(ChineseConvertType.s2t, 2);
});

test('默认值工厂：字段数与关键默认值（与接口一一对应）', () => {
  for (const [name, obj, count] of [
    // 34 个 Legado 字段 + 显式登记的扩展字段（见文件上方 SHELF_BOOK_EXTENSIONS）
    ['emptyShelfBook', emptyShelfBook(0), 34 + SHELF_BOOK_EXTENSIONS.length],
    ['emptyBookReadConfig', emptyBookReadConfig(), 19],
    ['emptyShelfChapter', emptyShelfChapter(), 17],
    ['emptyBookmark', emptyBookmark(0), 8],
    ['emptyBookHighlight', emptyBookHighlight(0), 13],
    ['emptyReplaceRule', emptyReplaceRule(1), 14],
    ['emptyBookGroup', emptyBookGroup(1), 8],
    ['emptyReadRecord', emptyReadRecord('d', 'b', 0), 5],
    ['emptyCacheEntry', emptyCacheEntry('k'), 3],
    // 全局项（含 `shareLayout`）+ 9 个排版项（`#145`）+ 4 个界面主题项（`#163`）+ 阅读样式项（`#164` 26 + `#221` 页眉页脚 27 + `#235` 独立样式 8 + `#249` 背景图片 3）
    // —— 权威表达式见文件上方的 READ_PREFS_TOTAL
    ['emptyGlobalReaderPrefs', emptyGlobalReaderPrefs(), READ_PREFS_TOTAL],
    ['emptyUiThemeConfig', emptyUiThemeConfig('x'), 9], // ThemeConfig.Config 主构造器 = 9 字段（ThemeConfig.kt:492-502）
    ['emptyUiCoverConfig', emptyUiCoverConfig(), 9], // pref_config_cover.xml 收录项（见契约注释的「故意没收录」名单）
  ] as const) {
    assert.equal(Object.keys(obj).length, count, `${name} 字段数`);
  }

  // 关键默认值：这几个一旦漂移就会造成"用户数据看着有、其实不对"
  assert.equal(emptyBookmark(7).time, 7, '可为测试注入时间');
  assert.equal(emptyBookmark(0).content, '', '书签备注默认空串（不是 null）');
  assert.equal(
    emptyBookHighlight(0).layoutTitleLength,
    UNKNOWN_TITLE_LENGTH,
    '高亮 layoutTitleLength 默认必须是 -1 哨兵，不能是 0',
  );
  assert.equal(emptyReplaceRule(9).order, REPLACE_RULE_ORDER_DEFAULT, 'ReplaceRule.order 默认 Int.MIN_VALUE');
  assert.equal(emptyReplaceRule(9).scopeContent, true, '净化默认作用于正文');
  assert.equal(emptyReplaceRule(9).isRegex, true, '净化默认按正则');
  assert.equal(emptyReplaceRule(9).timeoutMillisecond, 3000);
  assert.equal(emptyReplaceRule(9).id, 9, 'id 由调用方给');
  assert.equal(emptyBookGroup(3).bookSort, -1, 'bookSort=-1 表示跟随全局');
  assert.equal(emptyBookGroup(3).enableRefresh, true);
  assert.equal(emptyBookGroup(3).onlyUpdateRead, false);
  assert.equal(emptyReadRecord('dev', 'book', 5).readTime, 0, '新记录时长为 0');
  assert.equal(emptyCacheEntry('k').deadline, 0, 'deadline=0 表示永不过期');
  assert.equal(emptyCacheEntry('k').value, null);
});

test('GlobalReaderPrefs 默认值（AppConfig/ReadBookConfig 出处见契约注释）', () => {
  const p = emptyGlobalReaderPrefs();
  assert.equal(p.themeMode, '0', 'themeMode 是字符串 "0".."3"（PreferKey 存 String）');
  assert.equal(p.chineseConverterType, 0);
  assert.equal(p.bookshelfSort, 0);
  assert.equal(p.replaceEnableDefault, true);
  assert.equal(p.readBodyToLh, true);
  assert.equal(p.autoReadSpeed, 10);
  assert.equal(p.audioSkipOpenCredits, 0);
  assert.equal(p.audioSkipCloseCredits, 0);
  assert.equal(p.pageAnim, 3, 'Web 默认滚动（PageAnim.scrollPageAnim）');
  assert.equal(p.shareLayout, false);
});
