/**
 * 「阅读样式：全局默认 ⊕ 每本覆盖」回归锁（`#164`）。
 *
 * ## 为什么值得单独一个文件
 * 这一块有**两类静默失败**，都不报错、控制台也干净：
 *  ① **清单与对象漂移**：`READ_STYLE_KEYS` 是「哪些字段可被每本覆盖」的白名单，
 *     新增一个阅读样式字段却忘了加进去 ⇒ 它在「本书样式」里**静默失效**
 *     （用户会看到「改了、退出去再进来又变回去」）；
 *  ② **持久化漏字段**：`readStyle` 要过 `ShelfBook` → `user-map` → REST → SQLite 四道关，
 *     任何一道漏了都表现为「存了就丢」。
 *
 * ## 防空转（本文件最重要的两条）
 *  · **清单覆盖**：断言 `READ_STYLE_KEYS` 的每一项**都真的存在于** `emptyGlobalReaderPrefs()`，
 *    且反过来断言「契约里那 34 个排版/样式字段**一个不少**」——
 *    只测「清单里的键有值」是假通过（清单少写了一项照样过）。
 *  · **空覆盖 = 不覆盖**：`mergeReadStyle(g, {})` 必须**逐键等于** `pickReadStyle(g)`。
 *    只测「覆盖生效了」同样会漏掉「顺带把别的键抹空」这种错（`{...a, b: undefined}` 就是它）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  READ_STYLE_KEYS,
  emptyGlobalReaderPrefs,
  emptyShelfBook,
  mergeReadStyle,
  effectiveReadStyleOverride,
  pickReadStyle,
  type ReadStyleOverride,
  readTipDefaultTemplate,
  renderReaderInfoTemplate,
  READ_TIP,
  READ_TIP_OPTIONS,
  READER_INFO_PLACEHOLDERS,
  type ShelfBook,
} from '../contract/user-data';
import { createJsonUserStore, createSqliteUserStore, hasSqliteSupport, type UserDataStore } from '../user-store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuedu-rstyle-'));
}

/** 阅读样式字段的**期望全集**（70 项）—— 手写一遍，故意的：清单改了这里就必须跟着改，改不动说明漏了。 */
const EXPECTED_KEYS = [
  // 排版 9（`#145`）
  'textSize', 'titleSize', 'textBold', 'letterSpacing', 'lineSpacingExtra',
  'paragraphSpacing', 'paragraphIndent', 'textFont', 'titleFont',
  // 翻页动画（`PageAnim.kt:9-17`）
  'pageAnim',
  // 背景 4（`#164`）
  'bgStr', 'bgStrNight', 'bgStrEInk', 'bgAlpha',
  // 文字颜色 6（`#164`）
  'textColor', 'textColorNight', 'textColorEInk',
  'textAccentColor', 'textAccentColorNight', 'textAccentColorEInk',
  // 正文边距 4（`#164`）
  'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom',
  // 标题 5（`#164`）
  'titleMode', 'titleColor', 'titleTopSpacing', 'titleBottomSpacing', 'titleLineSpacingExtra',
  // 下划线 6（`#164`）
  'underlineMode', 'underlineColor', 'underlineWidth', 'underlineDistance',
  'underlineBodyEnabled', 'underlineTitleEnabled',
  // 页眉 / 页脚 27（`#221`：`ReadBookConfig.kt:922-948`）
  'headerMode', 'footerMode',
  'tipHeaderLeft', 'tipHeaderMiddle', 'tipHeaderRight',
  'tipFooterLeft', 'tipFooterMiddle', 'tipFooterRight',
  'tipHeaderLeftTemplate', 'tipHeaderMiddleTemplate', 'tipHeaderRightTemplate',
  'tipFooterLeftTemplate', 'tipFooterMiddleTemplate', 'tipFooterRightTemplate',
  'tipTextSize', 'tipColor', 'tipDividerColor',
  'headerPaddingTop', 'headerPaddingLeft', 'headerPaddingRight', 'headerPaddingBottom',
  'footerPaddingTop', 'footerPaddingLeft', 'footerPaddingRight', 'footerPaddingBottom',
  'showHeaderLine', 'showFooterLine',
  // `#235` 页眉/页脚**独立**字号·文字色·分隔线色 + 线型（超出上游的有意增强）
  'headerTextSize', 'headerTextColor', 'headerDividerColor',
  'footerTextSize', 'footerTextColor', 'footerDividerColor',
  'headerLineStyle', 'footerLineStyle',
  // ★ `#249` 背景图片三套（与 bgStr 对称）。本条断言**故意**拦住未登记的新增字段 ——
  //   本轮它红了 3 次（core 454 项里 3 条失败），正因为如此才确认「加字段必登记」这条纪律有效。
  'bgImgPath', 'bgImgPathNight', 'bgImgPathEInk',
  // ★ `#250` 栏位透明（标题栏 / 页眉 / 页脚各一组「开关 + 不透明度」）。
  //   **上游没有这些字段** —— `view_book_page.xml` 里 `ll_header`/`ll_footer` 恒透明（无 background），
  //   工具栏在另一个 Activity 层。本仓 Web 把三者收进同一浮层，才需要「透明 / 不透明 + 透明度」。
  'toolbarTransparent', 'toolbarAlpha',
  'headerTransparent', 'headerAlpha',
  'footerTransparent', 'footerAlpha',
].sort();

test('① 防空转：READ_STYLE_KEYS 恰好覆盖期望的 79 项（多一项/少一项都要红）', () => {
  assert.deepEqual([...READ_STYLE_KEYS].sort(), EXPECTED_KEYS);
});

test('② 防空转：清单每一项都**真的存在于** GlobalReaderPrefs 的默认值里', () => {
  const d = emptyGlobalReaderPrefs() as unknown as Record<string, unknown>;
  for (const k of READ_STYLE_KEYS) {
    assert.ok(k in d, `READ_STYLE_KEYS 里的 ${k} 在 emptyGlobalReaderPrefs() 里不存在 —— 清单写错了`);
  }
});

test('③ pickReadStyle 只取阅读样式：界面主题 / 封面 / 行为项**必须被丢掉**', () => {
  const g = emptyGlobalReaderPrefs();
  const picked = pickReadStyle(g) as Record<string, unknown>;
  assert.equal(Object.keys(picked).length, READ_STYLE_KEYS.length);
  for (const notStyle of ['themeMode', 'chineseConverterType', 'bookshelfSort', 'uiDayTheme', 'uiNightTheme', 'uiThemes', 'cover', 'readBodyToLh']) {
    assert.ok(!(notStyle in picked), `${notStyle} 不是阅读样式，不该出现在 pickReadStyle 结果里`);
  }
});

test('④ 防空转：空覆盖 == 不覆盖（逐键等于全局，不许把别的键抹空）', () => {
  const g = emptyGlobalReaderPrefs();
  g.bgStr = '#123456';
  g.textSize = 33;
  const merged = mergeReadStyle(g, {});
  const base = pickReadStyle(g) as Record<string, unknown>;
  assert.equal(Object.keys(merged).length, READ_STYLE_KEYS.length);
  for (const k of READ_STYLE_KEYS) {
    assert.equal((merged as Record<string, unknown>)[k], base[k], `${k} 在空覆盖下必须保持全局值`);
  }
});

test('⑤ 逐键覆盖：只覆盖给了的键；`null` 是**有效值**（表达「跟随正文色」）', () => {
  const g = emptyGlobalReaderPrefs();
  const merged = mergeReadStyle(g, { textSize: 40, titleColor: null });
  assert.equal(merged.textSize, 40, '给了的键要覆盖');
  assert.equal(merged.titleColor, null, 'null 必须真的覆盖（它是「跟随正文色」的取值，不是「没给」）');
  assert.equal(merged.bgStr, g.bgStr, '没给的键保持全局值');

  // ⚠️ 反向锁：`undefined` 必须**等于没给** —— 这正是 `{...global, ...override}` 写法的病
  const withUndef = mergeReadStyle(g, { textSize: undefined } as never);
  assert.equal(withUndef.textSize, g.textSize, 'undefined 不该覆盖（否则「只改了颜色」会顺带把字号抹掉）');
});

test('⑥ 合并时全局对象可以是不完整的旧数据（会被补齐，不是崩）', () => {
  const merged = mergeReadStyle({ textSize: 26 }, { bgAlpha: 50 });
  assert.equal(merged.textSize, 26, '旧数据里的值要保住');
  assert.equal(merged.bgAlpha, 50);
  assert.equal(merged.paddingLeft, emptyGlobalReaderPrefs().paddingLeft, '缺的键补默认值');
});

test('⑦ ShelfBook 默认 readStyle 是 null（= 不覆盖，而不是{}）', () => {
  assert.equal(emptyShelfBook().readStyle, null);
});

/* ---------------- `#247` 共用布局开关（`shareLayout`）----------------
 * 上游依据（`ReadBookConfig.kt:434`）：
 *   `val config get() = if (shareLayout) shareConfig else durConfig`
 * 一个开关决定「读哪一份配置」：共用读全局（shareConfig），不共用读这本书的（durConfig）。
 * 书籍侧的覆盖层形态见 `Book.readConfig: ReadConfig?`（`Book.kt:124`）——
 * 19 个字段**全部可空**，「可空」就是「不覆盖、用全局」。
 * ⚠️ 但上游那个 `ReadConfig` **不含字号/字距/行距/颜色** ⇒「每本书独立排版」上游没有实体，
 * 本仓 `ShelfBook.readStyle` 是显式标注的扩展字段。
 *
 * ★ 本组测试的意义：`shareLayout` 的**语义**（「共用」时本书覆盖必须**不生效**）
 *   只有在这里锁住才牢 —— 因为合并函数 `mergeReadStyle` 本身**不知道**这个开关，
 *   它只认「有没有传 override」。开关传错了（比如把 `shareLayout` 反过来读）
 *   合并函数照样返回正确结果 ⇒ **测合并函数测不出开关接反了**。
 */

/** 按 `shareLayout` 决定传给合并函数的那个 override（= 前端 `effectiveTarget` 的语义） */
function overrideFor(shareLayout: boolean, bookOverride: ReadStyleOverrideLike | null): ReadStyleOverrideLike | null {
  return shareLayout ? null : bookOverride;
}
type ReadStyleOverrideLike = Parameters<typeof mergeReadStyle>[1];

test('⑩ shareLayout=true ⇒ 本书的覆盖**完全不参与**合并（所有键都跟全局）', () => {
  const g = emptyGlobalReaderPrefs();
  const book: ReadStyleOverride = { textSize: 40, bgStr: '#101010' };
  const merged = mergeReadStyle(g, overrideFor(true, book));
  assert.equal(merged.textSize, g.textSize, '共用时字号必须跟全局，不能被这本书带偏');
  assert.equal(merged.bgStr, g.bgStr, '共用时背景必须跟全局');
  assert.deepEqual(pickReadStyle(merged), pickReadStyle(g), '★ 逐键等于全局（一个键都不能被本书影响）');
});

test('⑪ shareLayout=false ⇒ 本书的覆盖逐键生效，没覆盖的键仍跟全局', () => {
  const g = emptyGlobalReaderPrefs();
  const book: ReadStyleOverride = { textSize: 40 };
  const merged = mergeReadStyle(g, overrideFor(false, book));
  assert.equal(merged.textSize, 40, '给了的键用本书的');
  assert.equal(merged.bgStr, g.bgStr, '没给的键仍跟全局');
});

test('⑫ shareLayout=false 但本书**没有**覆盖 ⇒ 等同共用（null 就是「不覆盖」）', () => {
  const g = emptyGlobalReaderPrefs();
  const merged = mergeReadStyle(g, overrideFor(false, null));
  assert.deepEqual(pickReadStyle(merged), pickReadStyle(g), '结果与共用完全一致');
});

test('⑬ 切换 shareLayout **不会**改动任何已有数据（只是换读哪一份）', () => {
  // ★ 这条锁住「开关是纯读取侧的选择」——
  //   若有人实现成「切换时把本书的覆盖搬进全局 / 搬回本书」，本条会红。
  const g = emptyGlobalReaderPrefs();
  const book: ReadStyleOverride = { textSize: 40, bgStr: '#101010' };
  const onShared = mergeReadStyle(g, overrideFor(true, book));
  const onBook = mergeReadStyle(g, overrideFor(false, book));
  assert.notEqual(onShared.textSize, onBook.textSize, '两种模式读到的值确实不同');
  assert.deepEqual(book, { textSize: 40, bgStr: '#101010' }, '★ 切换过程中覆盖层本身没被改写');
  assert.equal(g.textSize, emptyGlobalReaderPrefs().textSize, '★ 全局也没被改写');
});

/* ---------------- 持久化往返（两个实现都跑，语义必须一致） ---------------- */

const OVERRIDE = { textSize: 31, bgStr: '#101010', underlineMode: 2, titleColor: null, underlineBodyEnabled: false };

/**
 * 往返断言（**写完 → 关库 → 重开 → 再读**，不是同一个连接里读）。
 * ⚠️ 必须重开：同一个句柄里读回走的是内存里的对象，**验不到列映射**；
 * 只有关库重开才是真的「过了一遍磁盘」。`close()` 也不能省 —— 不关就 `EBUSY` 删不掉临时目录。
 */
async function roundTrip(store: UserDataStore, label: string): Promise<void> {
  const key = `${label}-book`;
  const b: ShelfBook = { ...emptyShelfBook(), bookUrl: key, origin: 'https://s.example.com', name: '样式往返' };
  b.readStyle = { ...OVERRIDE };
  await store.upsertBook(b);
  // 「不覆盖」也要如实往返（`null` 不能被写成 `{}` 或被丢掉）
  const b2: ShelfBook = { ...emptyShelfBook(), bookUrl: `${key}-2`, origin: 'https://s.example.com', name: '无覆盖' };
  await store.upsertBook(b2);

  const got = await store.getBook(key);
  assert.ok(got, `${label}：应能取回这本书`);
  assert.deepEqual(got.readStyle, OVERRIDE, `${label}：readStyle 必须逐键往返`);
  assert.equal((await store.getBook(`${key}-2`))?.readStyle, null, `${label}：没设置过必须读回 null`);
}

test('⑧ JSON 实现：readStyle 往返', async () => {
  const dir = tempDir();
  try {
    const store = await createJsonUserStore({ dir });
    try {
      await roundTrip(store, 'json');
    } finally {
      await store.close();
    }
    // 关库重开再读一次：JSON 实现是整个文档重写，重开能挡住「只在内存里对」的实现
    const reopened = await createJsonUserStore({ dir });
    try {
      assert.deepEqual((await reopened.getBook('json-book'))?.readStyle, OVERRIDE, 'json：重开后仍要完整');
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('⑨ SQLite 实现：readStyle 往返（列漏加 / 映射漏写都会在这里红）', async (t) => {
  if (!hasSqliteSupport()) {
    t.skip('本环境没有 node:sqlite');
    return;
  }
  const dir = tempDir();
  try {
    const store = await createSqliteUserStore({ dir });
    try {
      await roundTrip(store, 'sqlite');
    } finally {
      await store.close();
    }
    const reopened = await createSqliteUserStore({ dir });
    try {
      assert.deepEqual((await reopened.getBook('sqlite-book'))?.readStyle, OVERRIDE, 'sqlite：重开后仍要完整');
      assert.equal((await reopened.getBook('sqlite-book-2'))?.readStyle, null, 'sqlite：重开后 null 仍是 null');
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});


/* ===================== `#221` 页眉 / 页脚：信息位与模板 =====================
 * 这一段最容易「静默错」：模板写错一个花括号，页眉就**整条空白**，而界面不会报任何错。
 * 所以下面每条都锁死**具体的输出字符串**，不是「不为空」。
 */
test('⑦ 信息位 → 默认模板与上游 fromLegacy 一致（ReaderInfoTemplate.kt:118-129）', () => {
  assert.equal(readTipDefaultTemplate(READ_TIP.none), '');
  assert.equal(readTipDefaultTemplate(READ_TIP.bookName), '{书名}');
  assert.equal(readTipDefaultTemplate(READ_TIP.chapterTitle), '{章节}');
  assert.equal(readTipDefaultTemplate(READ_TIP.time), '{时间}');
  assert.equal(readTipDefaultTemplate(READ_TIP.page), '{页码}/{总页数}');
  assert.equal(readTipDefaultTemplate(READ_TIP.totalProgress), '{阅读进度}');
  assert.equal(readTipDefaultTemplate(READ_TIP.totalProgress1), '{章节序号}/{章节总数}');
  // 上游 `pageAndTotal` 两个信息之间是**两个空格**（`ReaderInfoTemplate.kt:124`）
  assert.equal(readTipDefaultTemplate(READ_TIP.pageAndTotal), '{页码}/{总页数}  {阅读进度}');
});

test('⑧ 模板渲染：占位符全部替换成真实值', () => {
  const out = renderReaderInfoTemplate('{书名} · {章节} · {时间} · {阅读进度} · {章节序号}/{章节总数}', {
    bookName: '三体', chapterTitle: '第 3 章', time: '21:30',
    readProgress: '12.5%', chapter: '3', totalChapters: '120',
  });
  assert.equal(out, '三体 · 第 3 章 · 21:30 · 12.5% · 3/120');
});

/* ===================== `#264`（用户 2026-10-04 Add）`{正文字数}` =====================
 * 用户要的是「信息位下拉里多一个『正文字数』」⇒ 它是一个**新信息位**（不只是占位符），
 * 所以三处都要动：`READ_TIP` / `READ_TIP_OPTIONS`（下拉）/ `READER_INFO_PLACEHOLDERS`（模板）。
 * ★ 这一组最该防的是**取值撞车**：上游 `0..11` 全占用（`ReadTipConfig.kt:12-23`），
 *   若顺手用了 `3` 就会让老配置里「电量图标」一夜之间变成字数 —— 而且不报错。
 */
test('⑦-b `{正文字数}` 是本仓扩展的信息位：取值 12（上游 0..11 全占用）', () => {
  assert.equal(READ_TIP.textLength, 12, '12 是第一个空号（上游 tipValues 用了 0..11）');
  const used = Object.entries(READ_TIP)
    .filter(([k]) => k !== 'textLength')
    .map(([, v]) => v as number);
  assert.deepEqual([...used].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    '上游那 12 个值必须一个不少——少一个就说明我们挪用了它的号');
  assert.ok(!used.includes(12), '12 必须没被上游占用');
});

test('⑦-c `{正文字数}` 的默认模板与渲染', () => {
  // ★ `#265`（用户 2026-10-04）：默认展示带「正文字数：」前缀 —— 光一个裸数字看不出是什么
  assert.equal(readTipDefaultTemplate(READ_TIP.textLength), '正文字数：{正文字数}');
  // ★ 占位符本身仍是裸值 ⇒ 自定义模板（如 `共{正文字数}字`）不受前缀影响
  assert.equal(READER_INFO_PLACEHOLDERS.textLength, '{正文字数}');
  assert.equal(renderReaderInfoTemplate('{正文字数} 字', { textLength: '1234' }), '1234 字');
  // ★ 防空转之一：没传 ⇒ **空串**（不能是 `'undefined'`，也不能编一个 `'0'`）
  assert.equal(renderReaderInfoTemplate('{正文字数} 字', {}), ' 字');
  // ★ 防空转之二：它是**已知占位符**，不能落到「未知 ⇒ 原样输出」那条兜底路径上去
  assert.equal(renderReaderInfoTemplate('{正文字数}', { textLength: '' }), '', '空值 ⇒ 渲染成空串，而不是把 {正文字数} 吐回来');
  // 与其它占位符混排（页脚最常见的写法）
  assert.equal(
    renderReaderInfoTemplate('{章节} · {正文字数}字 · {阅读进度}', { chapterTitle: '第1章', textLength: '3210', readProgress: '3%' }),
    '第1章 · 3210字 · 3%',
  );
});

test('⑦-d 下拉选项：上游 12 项原样在前，本仓「正文字数」追加在末尾', () => {
  assert.equal(READ_TIP_OPTIONS.length, 13, '上游 12 项 + 本仓 1 项');
  const last = READ_TIP_OPTIONS.at(-1)!; // noUncheckedIndexedAccess ⇒ 断言前显式取末元素
  assert.equal(last.value, READ_TIP.textLength);
  assert.equal(last.label, '正文字数');
  // ★ 前面 12 项必须**仍是上游 tipValues 的顺序**（插队会让以后照上游截图核对界面对不上）
  assert.deepEqual(
    READ_TIP_OPTIONS.slice(0, 12).map((o) => o.value),
    [0, 7, 1, 2, 3, 10, 4, 5, 11, 6, 8, 9],
    '前 12 项 = 上游 ReadTipConfig.tipValues（:25-28）',
  );
  assert.equal(new Set(READ_TIP_OPTIONS.map((o) => o.value)).size, 13, '不能有重复 value（重复 ⇒ 下拉里出现两个「正文字数」且互相抢）');
});

test('⑨ 电量取不到 ⇒ 空串（**不编造 0%**）', () => {
  assert.equal(renderReaderInfoTemplate('电量 {电量}', { battery: null }), '电量 ');
  assert.equal(renderReaderInfoTemplate('电量 {电量}', { battery: 0 }), '电量 0%');
  assert.equal(renderReaderInfoTemplate('{电量图标}', { battery: 88 }), '🔋');
  // 越界值要夹住（上游 `coerceIn(0, 100)`）
  assert.equal(renderReaderInfoTemplate('{电量}', { battery: 140 }), '100%');
  assert.equal(renderReaderInfoTemplate('{电量}', { battery: -5 }), '0%');
});

test('⑩ 写错的模板**原样显示**，不留空白（用户要能看见自己写错了什么）', () => {
  assert.equal(renderReaderInfoTemplate('{书名', { bookName: 'A' }), '{书名', '没闭合的 { ⇒ 原样');
  assert.equal(renderReaderInfoTemplate('{不存在的占位符}', {}), '{不存在的占位符}', '未知占位符 ⇒ 原样');
  assert.equal(renderReaderInfoTemplate('{{书名}}', { bookName: 'A' }), '{{书名}}', '嵌套花括号 ⇒ 不是占位符');
  assert.equal(renderReaderInfoTemplate('{书名}{章节}', { bookName: 'A' }), 'A', '缺值 ⇒ 空串，不报错');
  assert.equal(renderReaderInfoTemplate('', {}), '');
});

/* ---------------- `#248` 读取侧：`shareLayout` 必须真的「二选一」----------------
 * ★★ `#247` 那 4 条测的是**写侧**（改动落到哪），缺**读侧**（生效值读哪一份）
 *   —— 而用户 2026-10-03 22:00 报的「只有『病宠成瘾』这一本样式不生效」正是**读侧**的锅：
 *   `readStyle = mergeReadStyle(prefs, bookOverride)` **完全不看 `shareLayout`**，
 *   恒按「全局 ⊕ 覆盖」叠加 ⇒ 那本书一旦有过覆盖，改全局对它毫无影响。
 *
 * 本组把这个判据做成**可复用的纯函数**，让 store 与单测共用同一条规则 ——
 * 否则「store 里写了 if、测试里另写一遍」必然漂移（这正是本轮 bug 的形态）。
 */

test('⑭ 勾了共用布局 ⇒ 本书覆盖**完全不参与**（上游的 durConfig 分支被短路）', () => {
  const g = emptyGlobalReaderPrefs();
  const book: ReadStyleOverride = { bgStr: '#123456', textColor: '#654321' };
  // 覆盖模式：覆盖生效
  const off = mergeReadStyle(g, effectiveReadStyleOverride(false, book));
  assert.equal(off.bgStr, '#123456', '不勾时读本书覆盖');
  // 共用模式：**同一个覆盖**必须被忽略
  const on = mergeReadStyle(g, effectiveReadStyleOverride(true, book));
  assert.equal(on.bgStr, g.bgStr, '★ 勾了共用就完全不读 durConfig（不是叠加）');
  assert.deepEqual(pickReadStyle(on), pickReadStyle(g), '★ 逐键等于全局');
});

test('⑮ 共享是「暂时不读」而不是「删除覆盖」—— 反复切换后覆盖仍在', () => {
  const g = emptyGlobalReaderPrefs();
  const book: ReadStyleOverride = { bgStr: '#123456' };
  // 模拟：设覆盖 → 勾共用 → 取消共用（组件里就是这个顺序）
  effectiveReadStyleOverride(true, book);
  const back = mergeReadStyle(g, effectiveReadStyleOverride(false, book));
  assert.equal(back.bgStr, '#123456', '取消共用后覆盖重新生效 ⇒ 数据没被破坏');
});
