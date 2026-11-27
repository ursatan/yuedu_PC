/**
 * `#209` 桌面端纯逻辑的单测。
 *
 * 跑法：`pnpm --filter @yuedu/desktop test`（= `node --test tests/`）。
 *
 * ⚠️ 这组测试**不能**替代端到端验收：它证明的是「我们的决策对」，
 * 「Windows 真的把托盘画出来了 / 快捷键真的抢到了」只有 selfcheck.mjs 与手工双击能证明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lib from '../desktop-lib.js';

const {
  BOOK_EXTS, MAX_BOOK_BYTES, DEFAULT_PREFS, isBookFile, normalizeAccelerator, normalizePrefs,
  bookFilesFromArgv, planFileAssoc, regArgsFor, parseRegQueryValue, trayMenuSpec, isServerOnlyArgv,
  defaultPortForMode, SHELL_LOCK_FILE, shellLockPath, planGreenShortcuts,
  // `#347`
  IMPORT_SCHEMES, isImportSchemeUrl, schemeUrlsFromArgv, planProtocolAssoc,
} = lib;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/* ---------------- 后缀 ---------------- */

test('isBookFile：认 txt/epub/umd/pdf/mobi/azw3（不分大小写），不认引擎没实现的格式', () => {
  for (const p of [
    'a.txt', 'A.TXT', 'D:\\books\\三体.epub', '/x/y.EPUB',
    'a.umd', 'a.pdf', 'a.mobi', 'a.azw3',
  ]) {
    assert.equal(isBookFile(p), true, `${p} 应被认作本地书`);
  }
  // `#212` Step4 起上列格式引擎都做了；用**真没做**的后缀做对照，别谎报
  for (const p of ['a.azw', 'a.docx', 'a.txt.bak', 'txt', 123, null, undefined]) {
    assert.equal(isBookFile(p), false, `${String(p)} 不应被认作本地书`);
  }
  assert.deepEqual([...BOOK_EXTS], ['txt', 'epub', 'umd', 'pdf', 'mobi', 'azw3']);
});

/* ---------------- 快捷键 ---------------- */

test('normalizeAccelerator：去掉空格、原样保留合法组合，挡掉注定失败的输入', () => {
  assert.equal(normalizeAccelerator('Control+Shift+Y'), 'Control+Shift+Y');
  assert.equal(normalizeAccelerator('  CommandOrControl + Alt + K '), 'CommandOrControl+Alt+K');
  assert.equal(normalizeAccelerator('Ctrl+空格'), null, '非 ASCII 键名不认（Electron 要的是 "Space"）');
  assert.equal(normalizeAccelerator('Y'), null, '单字符键**必然**注册失败（Electron 要求至少一个修饰键）');
  assert.equal(normalizeAccelerator(''), null);
  assert.equal(normalizeAccelerator('   '), null);
  assert.equal(normalizeAccelerator('A'.repeat(70)), null, '超长串直接挡掉');
  assert.equal(normalizeAccelerator(null), null);
  assert.equal(normalizeAccelerator(123), null);
});

/* ---------------- 偏好归一 ---------------- */

test('normalizePrefs：空/垃圾输入 ⇒ 全默认值，且不产生噪音告警', () => {
  for (const bad of [undefined, null, 0, 'x', [], true]) {
    const { prefs, warnings } = normalizePrefs(bad);
    assert.deepEqual(prefs, { ...DEFAULT_PREFS, prefsVersion: lib.PREFS_VERSION });
    assert.deepEqual(warnings, [], `${JSON.stringify(bad)} 不该报未知键`);
  }
});

test('normalizePrefs：好值原样留，坏值回落 + 说清原因（不静默）', () => {
  const { prefs, warnings } = normalizePrefs({
    closeToTray: false,
    minimizeToTray: 'yes',      // 类型错
    shortcutEnabled: true,
    shortcut: 'Control+Alt+Q',
    nonsense: 1,                // 未知键
  });
  assert.equal(prefs.closeToTray, false, '合法布尔值必须生效');
  assert.equal(prefs.shortcut, 'Control+Alt+Q');
  assert.equal(prefs.minimizeToTray, DEFAULT_PREFS.minimizeToTray);
  assert.equal(warnings.length, 2, `应恰好两条告警，实际：${JSON.stringify(warnings)}`);
  assert.ok(warnings.some((w) => w.includes('minimizeToTray')), '类型错要指名');
  assert.ok(warnings.some((w) => w.includes('nonsense')), '未知键要指名');
  assert.ok(!('nonsense' in prefs), '未知键必须被丢掉，不能回写');
});

test('normalizePrefs：非法快捷键回落默认值并告警', () => {
  const { prefs, warnings } = normalizePrefs({ shortcut: 'Y' });
  assert.equal(prefs.shortcut, DEFAULT_PREFS.shortcut);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('快捷键'));
});

test('normalizePrefs：布尔项按 DEFAULT_PREFS 的类型自动覆盖（新加布尔项不会「改了不生效」）', () => {
  // trayHintShown 是逻辑内部用的布尔项：**不在任何界面开关里**，但必须同样受支持
  assert.equal(typeof DEFAULT_PREFS.trayHintShown, 'boolean');
  assert.equal(normalizePrefs({ trayHintShown: true }).prefs.trayHintShown, true);
  // 反证：把布尔项的名字写错（= 未知键）必须被丢掉 + 告警，不能静默变成「设了没用」
  const bad = normalizePrefs({ trayHintShow: true });
  assert.equal('trayHintShow' in bad.prefs, false);
  assert.equal(bad.warnings.length, 1);
});

/* ---------------- 上限常量不许与服务端漂移 ---------------- */

test('★ MAX_BOOK_BYTES 必须等于服务端 Fastify 的 bodyLimit（同一判据不许写两遍还各写各的）', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'apps/server/src/index.ts'), 'utf8');
  const m = /bodyLimit:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(src);
  assert.ok(m, '在 apps/server/src/index.ts 里没找到 `bodyLimit: N * 1024 * 1024` —— 若写法变了，请同步改这条测试');
  const serverLimit = Number(m[1]) * 1024 * 1024;
  assert.equal(
    MAX_BOOK_BYTES, serverLimit,
    `桌面端上限 ${MAX_BOOK_BYTES} 与服务端 bodyLimit ${serverLimit} 不一致 ⇒ 会出现「本地拦下/服务端却收得下」或反之`,
  );
});

/* ---------------- argv ---------------- */

test('bookFilesFromArgv：开发态 / 打包态 / 带开关 三种形态通吃', () => {
  const yes = () => true;
  // 开发态：electron . book.txt
  assert.deepEqual(bookFilesFromArgv(['C:\\e\\electron.exe', '.', 'D:\\b\\a.txt'], yes), ['D:\\b\\a.txt']);
  // 打包态（文件关联）：YueDu.exe  D:\b\b.epub
  assert.deepEqual(bookFilesFromArgv(['C:\\app\\YueDu.exe', 'D:\\b\\b.epub'], yes), ['D:\\b\\b.epub']);
  // 中间夹开关（自检/调试常用）
  assert.deepEqual(
    bookFilesFromArgv(['C:\\app\\YueDu.exe', '--remote-debugging-port=9333', 'D:\\b\\c.TXT'], yes),
    ['D:\\b\\c.TXT'],
  );
  // 多个文件 + 去重
  assert.deepEqual(bookFilesFromArgv(['x', 'a.txt', 'a.txt', 'b.epub'], yes), ['a.txt', 'b.epub']);
  // 非书文件 / 不存在 / 空
  assert.deepEqual(bookFilesFromArgv(['x', '.', 'a.docx'], yes), [], 'docx 不是本地书');
  // `#212` Step4：pdf/mobi/azw3 现在也认
  assert.deepEqual(bookFilesFromArgv(['x', '.', 'd.pdf'], yes), ['d.pdf']);
  assert.deepEqual(bookFilesFromArgv(['x', 'a.txt'], () => false), [], '文件不存在时不能假装要打开它');
  assert.deepEqual(bookFilesFromArgv([], yes), []);
  assert.deepEqual(bookFilesFromArgv(null, yes), []);
});

test('bookFilesFromArgv：`file://` 与整体带引号的路径都要认', () => {
  const yes = () => true;
  const fromUrl = bookFilesFromArgv(['x', 'file:///D:/books/%E4%B8%89%E4%BD%93.txt'], yes);
  assert.equal(fromUrl.length, 1);
  assert.ok(fromUrl[0].endsWith('三体.txt'), `URL 形态要解成真实路径，实际 ${fromUrl[0]}`);
  assert.deepEqual(bookFilesFromArgv(['x', '"D:\\b\\q.txt"'], yes), ['D:\\b\\q.txt']);
});

/* ---------------- 文件关联计划 ---------------- */

const PLAN = planFileAssoc({ exePath: 'D:\\soft\\YueDu-portable.exe', appName: '阅读 YueDu' });

test('planFileAssoc：★★ 绝不劫持 .txt/.epub 的默认打开程序', () => {
  const hijack = PLAN.install.filter((o) => /^HKCU\\Software\\Classes\\\.(txt|epub)$/i.test(o.key));
  assert.deepEqual(hijack, [], '不许写 …\\Classes\\.txt 的默认值（那是抢默认程序）');
  // 而且**没有任何** op 落在 …\Classes\.txt 这个键本身的默认值上
  assert.ok(!PLAN.install.some((o) => /Classes\\\.txt$/i.test(o.key) && (o.name === null || o.name === undefined)));
});

test('planFileAssoc：install 覆盖四类键（Applications / SupportedTypes / OpenWithProgids / ProgID）', () => {
  const keys = PLAN.install.map((o) => o.key);
  assert.ok(keys.some((k) => k === 'HKCU\\Software\\Classes\\Applications\\YueDu-portable.exe'));
  assert.ok(keys.some((k) => k.endsWith('\\SupportedTypes')));
  assert.ok(keys.some((k) => k === 'HKCU\\Software\\Classes\\.txt\\OpenWithProgids'));
  assert.ok(keys.some((k) => k === 'HKCU\\Software\\Classes\\.epub\\OpenWithProgids'));
  assert.ok(keys.some((k) => k === 'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids'));
  assert.ok(keys.some((k) => k === 'HKCU\\Software\\Classes\\YueDu.txt\\shell\\open\\command'));
  assert.deepEqual(PLAN.progIds, ['YueDu.txt', 'YueDu.epub', 'YueDu.umd', 'YueDu.pdf', 'YueDu.mobi', 'YueDu.azw3']);
});

test('planFileAssoc：打开命令带引号（路径有空格才不会把参数切碎）', () => {
  assert.equal(PLAN.openCmd, '"D:\\soft\\YueDu-portable.exe" "%1"');
  for (const o of PLAN.install.filter((x) => x.key.endsWith('shell\\open\\command'))) {
    assert.equal(o.data, PLAN.openCmd);
  }
});

test('planFileAssoc：★ 卸载只拆自己搭的 —— 不删 OpenWithProgids 整键、不动别人的值', () => {
  const delKeys = PLAN.uninstall.filter((o) => o.op === 'delKey').map((o) => o.key);
  assert.ok(!delKeys.some((k) => /OpenWithProgids$/i.test(k)), 'OpenWithProgids 是共享键，只能删自己的值');
  assert.deepEqual(
    PLAN.uninstall.filter((o) => o.op === 'delValue').map((o) => `${o.key}|${o.name}`).sort(),
    [
      'HKCU\\Software\\Classes\\.azw3\\OpenWithProgids|YueDu.azw3',
      'HKCU\\Software\\Classes\\.epub\\OpenWithProgids|YueDu.epub',
      'HKCU\\Software\\Classes\\.mobi\\OpenWithProgids|YueDu.mobi',
      'HKCU\\Software\\Classes\\.pdf\\OpenWithProgids|YueDu.pdf',
      'HKCU\\Software\\Classes\\.txt\\OpenWithProgids|YueDu.txt',
      'HKCU\\Software\\Classes\\.umd\\OpenWithProgids|YueDu.umd',
    ],
  );
  // 对偶：install 写进去的每一个 OpenWithProgids 值，uninstall 都有对应的删除
  for (const add of PLAN.install.filter((o) => o.key.endsWith('OpenWithProgids'))) {
    assert.ok(
      PLAN.uninstall.some((d) => d.op === 'delValue' && d.key === add.key && d.name === add.name),
      `uninstall 漏了 ${add.key}\\${add.name}`,
    );
  }
});

test('planFileAssoc：exePath 为空要抛（宁可报错，也不写一条指向空的关联）', () => {
  assert.throws(() => planFileAssoc({ exePath: '' }), /exePath/);
});

test('regArgsFor：默认值用 /ve、命名值用 /v，且总能拿到可执行 argv', () => {
  assert.deepEqual(
    regArgsFor({ op: 'add', key: 'HKCU\\K', name: null, type: 'REG_SZ', data: 'v' }),
    ['add', 'HKCU\\K', '/ve', '/t', 'REG_SZ', '/d', 'v', '/f'],
  );
  assert.deepEqual(
    regArgsFor({ op: 'add', key: 'HKCU\\K', name: '.txt', type: 'REG_SZ', data: '' }),
    ['add', 'HKCU\\K', '/v', '.txt', '/t', 'REG_SZ', '/d', '', '/f'],
  );
  assert.deepEqual(regArgsFor({ op: 'delValue', key: 'HKCU\\K', name: 'YueDu.txt' }), ['delete', 'HKCU\\K', '/v', 'YueDu.txt', '/f']);
  assert.deepEqual(regArgsFor({ op: 'delKey', key: 'HKCU\\K' }), ['delete', 'HKCU\\K', '/f']);
  assert.throws(() => regArgsFor({ op: 'nope' }), /未知的注册表操作/);
  // 计划里每一条 op 都必须变成得出来的 argv（防空转：防止 op 形状与 regArgsFor 漂移）
  for (const op of [...PLAN.install, ...PLAN.uninstall]) {
    assert.ok(Array.isArray(regArgsFor(op)) && regArgsFor(op).length >= 3);
  }
});

/* ---------------- reg query 解析 ---------------- */

test('parseRegQueryValue：中/英两种报错文案下都不误判，成功时取到数据', () => {
  // 中文 Windows：找不到
  assert.equal(parseRegQueryValue('错误: 系统找不到指定的注册表项或值。\r\n', null), null);
  // 英文 Windows：找不到
  assert.equal(parseRegQueryValue('ERROR: The system was unable to find the specified registry key or value.\r\n', 'FriendlyAppName'), null);
  // 成功：默认值
  assert.equal(parseRegQueryValue('\r\nHKEY_CURRENT_USER\\K\r\n    (默认)    REG_SZ    hello\r\n\r\n', null), 'hello');
  // 成功：命名值（英文系统显示 (Default)）
  assert.equal(parseRegQueryValue('\r\nHKEY_CURRENT_USER\\K\r\n    (Default)    REG_SZ    x\r\n    FriendlyAppName    REG_SZ    阅读 YueDu\r\n\r\n', 'FriendlyAppName'), '阅读 YueDu');
  assert.equal(parseRegQueryValue('    (默认)    REG_SZ    \r\n', null), '', '空数据要返回空串，不能当成「没找到」');
});

/* ---------------- 托盘菜单 ---------------- */

test('trayMenuSpec：文案跟着窗口可见状态变，退出永远在最后', () => {
  const shown = trayMenuSpec({ windowVisible: true });
  const hidden = trayMenuSpec({ windowVisible: false });
  assert.equal(shown[0].label, '隐藏主窗口');
  assert.equal(hidden[0].label, '显示主窗口');
  assert.equal(shown[shown.length - 1].id, 'quit');
  assert.equal(hidden[hidden.length - 1].id, 'quit');
  assert.equal(shown.filter((i) => i.type === 'separator').length, 2);
});

test('trayMenuSpec：快捷键没抢到时，托盘上直接挂一条（不能只写日志）', () => {
  const bad = trayMenuSpec({ windowVisible: true, shortcutEnabled: true, shortcutOk: false, shortcut: 'Control+Shift+Y' });
  const warn = bad.find((i) => i.id === 'shortcut-broken');
  assert.ok(warn, '注册失败必须在托盘菜单里可见');
  assert.match(warn.label, /Control\+Shift\+Y/);
  assert.equal(warn.enabled, false);

  assert.equal(trayMenuSpec({ windowVisible: true, shortcutEnabled: true, shortcutOk: true }).some((i) => i.id === 'shortcut-broken'), false);
  assert.equal(trayMenuSpec({ windowVisible: true, shortcutEnabled: false, shortcutOk: false }).some((i) => i.id === 'shortcut-broken'), false, '用户主动关掉的快捷键不是故障');
});

test('trayMenuSpec：--server-only 只留服务壳该有的项（无显隐/本地书），双击打开界面', () => {
  const spec = trayMenuSpec({ serverOnly: true, autoLaunch: false, windowVisible: true });
  const ids = spec.filter((i) => i.id).map((i) => i.id);
  assert.deepEqual(ids, ['open-ui', 'restart-server', 'settings', 'open-data-dir', 'auto-launch', 'quit']);
  assert.equal(ids.includes('toggle'), false, '服务壳没有主窗口，不该有显隐项');
  assert.equal(ids.includes('open-local'), false, '服务壳不注册文件关联');
  const chk = spec.find((i) => i.id === 'auto-launch');
  assert.equal(chk.type, 'checkbox');
  assert.equal(chk.checked, false, '开机自启默认关');
  assert.equal(spec[spec.length - 1].id, 'quit');
});

test('isServerOnlyArgv：认 --server-only（含 =1/=true），普通启动与其它开关不误判', () => {
  assert.equal(isServerOnlyArgv(['electron .', '--server-only']), true);
  assert.equal(isServerOnlyArgv(['YueDu.exe', '--server-only=1']), true);
  assert.equal(isServerOnlyArgv(['YueDu.exe', '--server-only=true']), true);
  assert.equal(isServerOnlyArgv(['YueDu.exe', '--server-only-mode']), false);
  assert.equal(isServerOnlyArgv(['YueDu.exe']), false);
  assert.equal(isServerOnlyArgv(null), false);
});

test('形态默认端口与数据目录锁：服务端 3000 / PC 3100；锁文件跟数据目录走', () => {
  assert.equal(defaultPortForMode(true), 3000, '独立服务端默认 3000，才能和 Web+server 对齐');
  assert.equal(defaultPortForMode(false), 3100, 'PC 客户端默认 3100，避免与 3000 抢端口');
  assert.equal(SHELL_LOCK_FILE, '.yuedu-shell.lock.json');
  assert.equal(shellLockPath('F:\\yuedu_PC\\data'), 'F:\\yuedu_PC\\data\\.yuedu-shell.lock.json');
  // 两种形态的默认端口不同 ⇒ 偏好里的 0（跟随形态默认）不会让两个壳抢同一端口
  assert.notEqual(defaultPortForMode(true), defaultPortForMode(false));
  const n0 = normalizePrefs({ serverPort: 0 });
  assert.equal(n0.prefs.serverPort, 0);
  assert.equal(n0.warnings.length, 0, '0 是合法值（跟随形态默认），不该告警');
});

/* ---------------- 绿色 zip 的两个入口（2026-11-25：只发布 zip） ---------------- */

test('planGreenShortcuts：两个入口，服务端带 --server-only，图标与工作目录都落得对', () => {
  const exe = 'D:\\悦读\\YueDu.exe';
  const plan = planGreenShortcuts({
    exePath: exe,
    desktopDir: 'C:\\Users\\u\\Desktop',
    iconPath: 'D:\\悦读\\resources\\icon-server.ico',
  });
  assert.equal(plan.length, 2, '恰好两个入口：阅读 + 服务');
  assert.deepEqual(plan.map((p) => p.name), ['悦读', '悦读服务']);
  assert.equal(plan[0].args, '', '阅读入口不能带 --server-only（否则双击只出托盘）');
  assert.equal(plan[1].args, '--server-only', '服务入口靠参数区分，同一份 exe');
  assert.equal(plan[0].path, path.join('C:\\Users\\u\\Desktop', '悦读.lnk'));
  assert.equal(plan[1].path, path.join('C:\\Users\\u\\Desktop', '悦读服务.lnk'));
  for (const p of plan) {
    assert.equal(p.target, exe, '两个快捷方式都指向同一个 exe');
    assert.equal(p.cwd, 'D:\\悦读', '工作目录 = exe 所在目录');
  }
  assert.equal(plan[0].icon, exe, '阅读入口用 exe 自身图标');
  assert.equal(plan[1].icon, 'D:\\悦读\\resources\\icon-server.ico', '服务入口用独立图标，两个才分得开');
  // 图标缺失时回落 exe 自身，不能生成一条指向空文件的 .lnk
  assert.equal(planGreenShortcuts({ exePath: exe, desktopDir: 'C:\\d' })[1].icon, exe);
  assert.throws(() => planGreenShortcuts({ desktopDir: 'C:\\d' }), /exePath/);
  assert.throws(() => planGreenShortcuts({ exePath: exe }), /desktopDir/);
});

test('shortcutsCreated：默认 false、可读写（只建一次的标记，不能被 normalizePrefs 丢掉）', () => {
  assert.equal(DEFAULT_PREFS.shortcutsCreated, false);
  const { prefs, warnings } = normalizePrefs({ shortcutsCreated: true });
  assert.equal(prefs.shortcutsCreated, true, '已建过标记必须原样保留，否则每次启动都往桌面写 .lnk');
  assert.deepEqual(warnings, [], '这是合法键，不该告警');
});

/* ---------------- `#347` 导入链接协议（唤起 yuedu:// / legado://） ---------------- */

test('isImportSchemeUrl：只认 yuedu:// 与 legado://（大小写不敏感），别把 http 当深链', () => {
  for (const u of [
    'yuedu://import/bookSource?src=https%3A%2F%2Fx.com%2Fa.json',
    'legado://import/rssSource?src=https%3A%2F%2Fx.com%2Fb.json',
    'YUEDU://booksource/importonline?src=u',
    'legado://replace/importonline?src=u',
  ]) {
    assert.equal(isImportSchemeUrl(u), true, `${u} 应被认作深链`);
  }
  for (const u of ['https://x.com/a.json', 'file:///D:/a.txt', 'yuedu:/x', 'x-yuedu://a', '', null, undefined, 42]) {
    assert.equal(isImportSchemeUrl(u), false, `${String(u)} 不应被认作深链`);
  }
});

test('schemeUrlsFromArgv：从 argv 挑出深链（剥离 Windows 偶发包裹的引号），跳过开关', () => {
  const argv = [
    'C://App//YueDu.exe',
    '--remote-debugging-port=9333',
    'yuedu://import/bookSource?src=https%3A%2F%2Fx.com%2Fa.json',
    '"legado://import/rssSource?src=https%3A%2F%2Fx.com%2Fb.json"',
    'D://books//三体.epub',
  ];
  const urls = schemeUrlsFromArgv(argv);
  assert.deepEqual(urls, [
    'yuedu://import/bookSource?src=https%3A%2F%2Fx.com%2Fa.json',
    'legado://import/rssSource?src=https%3A%2F%2Fx.com%2Fb.json',
  ]);
  assert.deepEqual(schemeUrlsFromArgv([]), []);
  assert.deepEqual(schemeUrlsFromArgv(null), []);
  // 去重（同一 URL 出现两次只交一次），顺序按首次出现
  assert.deepEqual(schemeUrlsFromArgv(['yuedu://a', 'yuedu://a', 'yuedu://b']), ['yuedu://a', 'yuedu://b']);
});

test('planProtocolAssoc：两个 scheme 各写 4 条，**必须**含判据值 URL Protocol', () => {
  const plan = planProtocolAssoc({ exePath: 'C://App//YueDu.exe', appName: '阅读 YueDu' });
  assert.deepEqual(plan.schemes, ['yuedu', 'legado'], '两 scheme 等价（Manifest 406-407）');
  assert.equal(plan.install.length, 8, '2 scheme × 4 条');
  assert.equal(plan.uninstall.length, 2);

  for (const scheme of ['yuedu', 'legado']) {
    const key = `HKCU\\Software\\Classes\\${scheme}`;
    const proto = plan.install.find((o) => o.key === key && o.name === 'URL Protocol');
    assert.ok(proto, `缺 URL Protocol ⇒ Windows 不认为这是协议处理器（本项根因）`);
    assert.equal(proto.type, 'REG_SZ');
    assert.equal(proto.data, '', 'URL Protocol 用空串即可，但不能没有');
    const cmd = plan.install.find((o) => o.key === `${key}\\shell\\open\\command`);
    assert.equal(cmd?.data, '"C://App//YueDu.exe" "%1"', '%1 的引号必须有（URL 含 & 会被切碎）');
    assert.ok(plan.install.some((o) => o.key === `${key}\\DefaultIcon`));
    assert.ok(plan.install.some((o) => o.key === key && o.name === null), '键的默认值=友好名');
  }
  // 卸载只拆自己搭的（整棵 scheme 子树）
  assert.deepEqual(plan.uninstall.map((o) => o.key), ['HKCU\\Software\\Classes\\yuedu', 'HKCU\\Software\\Classes\\legado']);
  assert.throws(() => planProtocolAssoc({ exePath: '' }), /exePath/);
});

test('planProtocolAssoc 与 planFileAssoc 写入的键**互不相交**（别把两者合并）', () => {
  const proto = planProtocolAssoc({ exePath: 'C://App//YueDu.exe' });
  const file = planFileAssoc({ exePath: 'C://App//YueDu.exe' });
  const pKeys = new Set(proto.install.map((o) => o.key));
  const fKeys = new Set(file.install.map((o) => o.key));
  for (const k of pKeys) assert.equal(fKeys.has(k), false, `协议键 ${k} 不应出现在文件关联计划里`);
  // scheme 名不能与「扩展名 ProgID」撞：Classes\yuedu 走的是 scheme，Classes\YueDu.txt 走的是 ProgID
  assert.equal([...fKeys].some((k) => /\\yuedu$/.test(k)), false);
});

test('regArgsFor 能吃下协议计划的每一条 op（与文件关联共用同一套 reg.exe argv）', () => {
  const plan = planProtocolAssoc({ exePath: 'C://App//YueDu.exe' });
  for (const op of [...plan.install, ...plan.uninstall]) {
    const a = regArgsFor(op);
    assert.ok(Array.isArray(a) && a.length > 0, `${op.op} ${op.key} 应能转成 argv`);
    assert.equal(a[a.length - 1], '/f');
  }
});

/* ---------------- 桌面朗读歌词（纯判定） ---------------- */

test('★ 偏好迁移 v1→v2：旧键整体搬到 float*，prefsVersion 落盘、旧键清零', () => {
  const { prefs, warnings } = normalizePrefs({
    prefsVersion: 1,
    lyricsFontSize: 30,
    lyricsTextColor: '#aabbcc',
    lyricsReadColor: '#5B8DEF',
    lyricsBgColor: '#1B1B1F',
    lyricsBgOpacity: 0.35,
    lyricsShowNeighbors: false,
    lyricsDragLocked: true,
    lyricsX: 120,
    lyricsY: 340,
    smallX: 10, smallY: 20, smallW: 460, smallH: 340,
    barX: 30, barY: 40, barW: 900, barH: 150,
    barSpeed: 3,
    barClickThrough: false,
  });
  assert.equal(prefs.prefsVersion, lib.PREFS_VERSION);
  assert.equal(prefs.floatFontSize, 30);
  assert.equal(prefs.floatTextColor, '#AABBCC');
  assert.equal(prefs.floatBgColor, '#1B1B1F');
  assert.equal(prefs.floatBgOpacity, 0.35);
  assert.equal(prefs.floatShowNeighbors, false);
  assert.equal(prefs.floatDragLocked, true);
  assert.equal(prefs.floatLyricsX, 120);
  assert.equal(prefs.floatLyricsY, 340);
  assert.equal(prefs.floatRegularX, 10);
  assert.equal(prefs.floatRegularY, 20);
  assert.equal(prefs.floatRegularW, 460);
  assert.equal(prefs.floatRegularH, 340);
  assert.equal(prefs.floatBarX, 30);
  assert.equal(prefs.floatBarY, 40);
  assert.equal(prefs.floatBarW, 900);
  assert.equal(prefs.floatBarH, 150);
  assert.equal(prefs.floatSpeed, 3);
  assert.equal(prefs.floatClickThrough, false);
  // 只迁到条形；常规仍保持自己的默认 false（不能顺手也置 true）
  assert.equal(prefs.floatRegularClickThrough, false);
  // 已读色静默丢弃（不产生告警），旧键不残留
  assert.equal(prefs.floatReadColor, undefined);
  assert.equal(prefs.lyricsReadColor, undefined);
  assert.equal(prefs.smallX, undefined);
  assert.ok(!warnings.some((w) => w.includes('lyrics')), '旧键不能再报「未知配置项」');
});

test('★ 偏好迁移幂等：v2 再读不重复迁移、零告警', () => {
  const first = normalizePrefs({ lyricsFontSize: 26, smallW: 500, barSpeed: 1 }).prefs;
  const second = normalizePrefs({ ...first }).prefs;
  assert.deepEqual(second, first);
  const third = normalizePrefs({ ...first, floatFontSize: 28 }).prefs;
  assert.equal(third.floatFontSize, 28, '新键优先，不被旧键覆盖');
});

test('★ 偏好迁移隔离：一个坏旧值只影响该项，其余键全部保留', () => {
  const { prefs, warnings } = normalizePrefs({
    lyricsFontSize: 'oops',
    lyricsBgColor: '#112233',
    smallX: 12.6,
  });
  assert.equal(prefs.floatFontSize, lib.DEFAULT_PREFS.floatFontSize);
  assert.equal(prefs.floatBgColor, '#112233');
  assert.equal(prefs.floatRegularX, 13);
  assert.ok(warnings.some((w) => w.includes('floatFontSize')));
  // 迷你几何取消：给一句提示，但不算错误，其它键不受影响
  const mini = normalizePrefs({ miniX: 100, miniY: 200 });
  assert.ok(mini.warnings.some((w) => w.includes('迷你档已取消')));
  assert.equal(mini.prefs.miniX, undefined);
});

test('歌词默认关：首次不弹置顶窗；外观字段有安全默认值', () => {
  const { prefs } = normalizePrefs({});
  assert.equal(prefs.lyricsEnabled, false, '默认必须是关（系统级置顶窗的打扰更大）');
  assert.equal(prefs.floatFontSize, 22);
  assert.equal(prefs.floatTextColor, '#F2F2F2');
  assert.equal(prefs.floatBgColor, '#0C0E12');
  assert.equal(prefs.floatBgOpacity, 0.72);
  assert.equal(prefs.floatShowNeighbors, true);
  assert.equal(prefs.floatLyricsX, null);
  assert.equal(prefs.floatLyricsY, null);
});

test('歌词外观归一：字号超出 14~40 回落默认、颜色只收 #RRGGBB、透明度只收 0~1、坐标取整/null', () => {
  const { prefs, warnings } = normalizePrefs({
    floatFontSize: 99,
    floatTextColor: 'red',
    floatBgColor: '#1b1b1f',
    floatBgOpacity: 2,
    floatLyricsX: 12.6,
    floatLyricsY: 'oops',
  });
  assert.equal(prefs.floatFontSize, 22, '超出范围回落默认并告警（与其它坏值同一口径）');
  assert.equal(prefs.floatTextColor, '#F2F2F2', '非法颜色回落默认');
  assert.equal(prefs.floatBgColor, '#1B1B1F', '合法颜色统一大写');
  assert.equal(prefs.floatBgOpacity, 0.72, '超出 0~1 回落默认');
  assert.equal(prefs.floatLyricsX, 13, '坐标取整');
  assert.equal(prefs.floatLyricsY, null);
  assert.ok(warnings.length >= 4, `非法值必须留告警，不静默：${JSON.stringify(warnings)}`);
  // 边界内的合法值要原样留下
  const ok = normalizePrefs({ floatFontSize: 30, floatBgOpacity: 0.35 }).prefs;
  assert.equal(ok.floatFontSize, 30);
  assert.equal(ok.floatBgOpacity, 0.35);
  assert.equal(ok.floatTextColor, '#F2F2F2');
});

test('★ 2026-11-08 浮窗外观/拖动：拖动锁定只收 boolean、穿透两键各自独立', () => {
  const { prefs } = normalizePrefs({});
  assert.equal(prefs.floatDragLocked, false, '默认不锁定拖动');
  assert.equal(prefs.floatClickThrough, true, '条形默认穿透');
  assert.equal(prefs.floatRegularClickThrough, false, '常规默认不穿透（否则漏滚轮）');
  assert.deepEqual(lib.FLOAT_MIN_SIZE, { width: 180, height: 120 }, '与 apps/desktop/float-geometry.json 一致（Web 端同值）');
  const ok = normalizePrefs({ floatDragLocked: true, floatClickThrough: false, floatRegularClickThrough: true }).prefs;
  assert.equal(ok.floatDragLocked, true);
  assert.equal(ok.floatClickThrough, false);
  assert.equal(ok.floatRegularClickThrough, true);
  const bad = normalizePrefs({ floatDragLocked: 'yes' }).prefs;
  assert.equal(bad.floatDragLocked, false);
});

test('★ 2026-11-09 小窗顶部热区：高度唯一真源 float-geometry.json（Web/桌面不再各写 44 与 48）', () => {
  const geo = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'float-geometry.json'), 'utf8'));
  assert.equal(lib.FLOAT_HEAD_ZONE_H, geo.headZoneHeight, '桌面主进程从 json 读热区高度');
  const shared = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/components/reader-float-shared.ts'), 'utf8');
  assert.match(shared, /DOCK_REVEAL_H[^=]*=\s*floatGeometry\.headZoneHeight/, 'Web 阈值也从同一 json 派生');
  const overlay = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/components/ReaderOverlay.vue'), 'utf8');
  assert.match(overlay, /smallHeadHover\.value = e\.clientY <= DOCK_REVEAL_H/, '小窗热区按 Y 判定要用共享常量');
  assert.ok(!/clientY <= 44/.test(overlay), '不能残留写死的 44');
  // ★ 2026-11-09：主窗变形链整链删除 ⇒ 桌面不再往主窗注入小窗 CSS（热区只在渲染层用）
  const main = fs.readFileSync(path.join(HERE, '..', 'main.js'), 'utf8');
  assert.ok(!/rd-head-dock/.test(main), '主窗变形 CSS 已删，不该再有 rd-head-dock 选择器');
  assert.ok(!/min-height: \$\{lib\.FLOAT_HEAD_ZONE_H\}px/.test(main), '不再注入标题栏最小高度（浮窗自己画工具条）');
  assert.ok(!/padding-top: 8px/.test(main), '不再靠 8px padding 迁就 44，避免三处数字漂移');
  // 按钮高度带必须整条落在热区里：标题栏上下 padding 12 + 按钮 24 = 48 ≤ 热区高度
  assert.match(overlay, /\.se-head \{[\s\S]*?padding: 12px 16px;/, '标题栏上下 padding 仍是 12px');
  const navRule = overlay.match(/\.se-mask\.rd-small \.rd-small-navbtn \{[\s\S]*?\}/)?.[0] || '';
  assert.match(navRule, /height: 24px;/, '小窗导航按钮高 24px');
  const btnBand = 12 * 2 + 24;
  assert.ok(btnBand <= lib.FLOAT_HEAD_ZONE_H, `按钮高度带 ${btnBand}px 必须 ≤ 热区 ${lib.FLOAT_HEAD_ZONE_H}px`);
});

test('★ 2026-11-09 桌面歌词窗：长句换行 / 同色系前后句 / 章节按钮 / 首帧可点', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'lyrics.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  // ① 长句按容器宽换行（对齐 Web：white-space normal + overflow-wrap）
  const lyLineRule = html.match(/\.fl-line\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(lyLineRule, /white-space: normal;/);
  assert.match(lyLineRule, /overflow-wrap: anywhere;/);
  assert.ok(!/text-overflow: ellipsis/.test(lyLineRule), '歌词行不能再靠省略号截断（条形档的 .bar-row 不受影响）');
  // ② 前后句颜色由 --float-text 现算的同色系降透明度（不再写死深灰）
  assert.match(html, /\.fl-prev, \.fl-next\s*\{[\s\S]*?color: var\(--float-dim\);/);
  assert.match(js, /setProperty\('--float-dim', textRgba\(prefs\.textColor, 0\.55\)\)/);
  // ③ 控制条有上一章 / 下一章
  assert.match(html, /data-cmd="chapterPrev"/);
  assert.match(html, /data-cmd="chapterNext"/);
  // ④ 首帧即可点：不再等 hover 才打开 pointer-events
  assert.match(html, /\.fl-actions\s*\{[\s\S]*?pointer-events: auto;/);
  // 换行后按真实内容高度请求改窗
  assert.match(js, /window\.yueduLyrics\.fitHeight\(/);
});

test('★ 2026-11-09 字号/行高整数：不再用小数倍数，字号只挂在三类行上', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'lyrics.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  // 旧的 `calc(var(--float-font-size) * 0.62/0.66/0.72)` 会把字号算成 13.64px 这种小数 ⇒ 发虚
  assert.ok(!/\*\s*0\.(62|66|72)\)/.test(html), '字号不能再走小数倍数');
  assert.ok(!/line-height:\s*1\.(3|35|72)\b/.test(html), '行高必须落成整数 px（1.35/1.72/1.3 都会产生小数）');
  for (const v of ['--fl-fs-cur', '--fl-fs-adj', '--fl-fs-read', '--fl-fs-bar', '--fl-lh-cur', '--fl-lh-adj', '--fl-lh-read', '--fl-lh-bar']) {
    assert.ok(html.includes(v), `缺整数外观变量 ${v}`);
  }
  assert.match(html, /\.fl-cur\s*\{[^}]*font-size:\s*var\(--fl-fs-cur\)/);
  assert.match(html, /\.fl-prev,\s*\.fl-next\s*\{[^}]*font-size:\s*var\(--fl-fs-adj\)/);
  assert.match(html, /\.rd-body\s*\{[^}]*font-size:\s*var\(--fl-fs-read\)/);
  assert.match(html, /\.bar-row\s*\{[^}]*font-size:\s*var\(--fl-fs-bar\)/);
  // 现算时四舍五入（22px 字配 30px 行高，不会出现「字比行高大」）
  assert.match(js, /Math\.round\(fs \* 1\.35\)/);
  assert.match(js, /Math\.round\(Number\(prefs\.fontSize\) \|\| 22\)/);
});

test('★ 2026-11-09 色盘：5 预设双端同源 + 自定义取色 + 三态共用浮层 + Esc/空白关闭', () => {
  const geo = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'float-geometry.json'), 'utf8'));
  assert.equal(geo.palette.text.length, 5);
  assert.equal(geo.palette.bg.length, 5);
  assert.equal(geo.palette.text[0].v, '');
  assert.equal(geo.palette.bg[0].v, '');
  // Web 与桌面不再各写一份十六进制表
  const shared = fs.readFileSync(path.join(REPO_ROOT, 'apps/web/src/components/reader-float-shared.ts'), 'utf8');
  assert.match(shared, /FONT_COLORS[^=]*=\s*floatGeometry\.palette\.text/);
  assert.match(shared, /BG_COLORS[^=]*=\s*floatGeometry\.palette\.bg/);
  assert.deepEqual({ text: lib.FLOAT_PALETTE.text, bg: lib.FLOAT_PALETTE.bg }, geo.palette);
  const html = fs.readFileSync(path.join(HERE, '..', 'lyrics.html'), 'utf8');
  assert.match(html, /data-picker="text"/);
  assert.match(html, /data-picker="bg"/);
  // 面板不再按形态隐藏（旧实现 bar/regular 直接 display:none）
  assert.ok(!/body\[data-mode="(bar|regular)"\][^{]*\.fl-settings/.test(html), '三态必须共用同一份面板');
  assert.match(html, /\.fl-settings \{[^}]*bottom: 0/s, '面板贴底浮出');
  assert.match(html, /body\.fl-panel-on \.rd-card/, '面板打开时正文让位');
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  assert.match(js, /e\.key !== 'Escape'/);
  assert.match(js, /closest\('\.fl-settings'\)/);
  assert.match(js, /fl-panel-on/);
  assert.match(js, /focusable\(true\)/, '原生取色器要临时解除 focusable:false');
});

test('★ 2026-11-09 滚动动画：transform 与字号共用时长，角色在滑动起点切换，收尾不跳', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'lyrics.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  assert.match(html, /\.bar-track\.slide\s*\{[^}]*transition:\s*transform var\(--bar-anim-ms/s);
  assert.match(html, /\.bar-row\s*\{[^}]*transition:\s*font-size var\(--bar-anim-ms/s);
  assert.match(html, /cubic-bezier\(\.33,\s*\.05,\s*\.24,\s*1\)/);
  // 先换角色，再让轨道滑动 ⇒ 同帧起；动画结束才重建 DOM（可见三行位置不变 ⇒ 不跳）
  const tick = js.slice(js.indexOf('function tick()'), js.indexOf('function updateIgnoreLabel'));
  const swap = tick.indexOf("rows[2].classList.add('is-cur')");
  const slide = tick.indexOf("classList.add('slide')");
  assert.ok(swap > 0 && slide > swap, '必须在 classList.add("slide") 之前换 is-cur');
  assert.match(tick, /renderRows\(\)/);
});

test('★ 2026-11-09 已读色：边界做锚点 + 按语速时间外推，落后不回拨', () => {
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  assert.match(js, /prog\.pos \+ \(performance\.now\(\) - prog\.at\) \* prog\.rate/);
  assert.match(js, /Math\.max\(lastInnerPos, est\)/, '取 max ⇒ 边界落后时不回拨');
  assert.match(js, /pos >= prog\.chars/, '锚点只在新边界不落后时校准');
  assert.match(js, /prog\.rate = prog\.rate \* 0\.6 \+ r2 \* 0\.4/, '按观测到的边界间隔校准语速');
});

test('normalizeLyricsState：IPC 另一头是网页上下文 ⇒ 字段逐个白名单，进度夹进当前句长度', () => {
  const s = lib.normalizeLyricsState({
    active: true, playing: true, paused: false, index: 3.4, innerPos: 999,
    prev: '上', current: '当前句', next: '下', extra: 'ignored',
  });
  assert.equal(s.index, 3);
  assert.equal(s.innerPos, '当前句'.length, 'innerPos 不许超过当前句长度');
  assert.equal(s.hasContent, true);
  assert.deepEqual(Object.keys(s).sort(), ['active', 'current', 'hasContent', 'index', 'innerPos', 'next', 'paused', 'playing', 'prev']);
  assert.equal(s.extra, undefined);
  // 垃圾输入 ⇒ 全零结构，不抛
  const empty = lib.normalizeLyricsState(null);
  assert.equal(empty.hasContent, false);
  assert.equal(empty.current, '');
  assert.equal(empty.active, false);
});

test('★ lyricsShouldShow：单一出口——开关 / 朗读会话 / 有内容 / 未锁屏，缺一不可（暂停不隐藏）', () => {
  const base = { enabled: true, active: true, playing: true, hasContent: true, screenLocked: false };
  assert.equal(lib.lyricsShouldShow(base), true);
  for (const key of ['enabled', 'active', 'hasContent']) {
    assert.equal(lib.lyricsShouldShow({ ...base, [key]: false }), false, `${key}=false 必须隐藏`);
  }
  // 用户 2026-11-14：点「暂停」不隐藏歌词窗（active 仍为 true，只是 playing=false）
  assert.equal(lib.lyricsShouldShow({ ...base, playing: false }), true, '暂停必须留下窗口');
  // 用户 2026-11-08 拍板：歌词窗是浮条的一种模式，用户主动开启 ⇒ 主窗有焦点也显示
  assert.equal(lib.lyricsShouldShow({ ...base, focused: true }), true, '主窗有焦点仍显示（开关是用户主动开的）');
  assert.equal(lib.lyricsShouldShow({ ...base, screenLocked: true }), false, '锁屏/休眠必须隐藏');
  // 浮窗阅读（常规/条形）与歌词是同一内容的两份投影
  assert.equal(lib.lyricsShouldShow({ ...base, floatReading: true }), false, '浮窗阅读必须隐藏桌面歌词');
  assert.equal(lib.lyricsShouldShow({ ...base, floatReading: false }), true);
  assert.equal(lib.lyricsShouldShow(null), false);
});

test('★ lyricsWindowHeight：高度 = 三行文字 + 上下 padding，随字号变化（删掉固定 180 的过高窗）', () => {
  // F=22 默认字号：ceil(0.84×22)=19(前) + ceil(1.35×22)=30(当) + 19(后) + 18(padding) + 2(亚像素) = 88
  assert.equal(lib.lyricsWindowHeight(22, true), 88);
  // 字号变大 ⇒ 高度变大（能装下三行）
  assert.equal(lib.lyricsWindowHeight(30, true), Math.ceil(30 * 0.84) * 2 + Math.ceil(30 * 1.35) + 20);
  // 字号变小 ⇒ 高度变小
  assert.ok(lib.lyricsWindowHeight(14, true) < lib.lyricsWindowHeight(22, true));
  // 不要前后句时只有当前行
  assert.equal(lib.lyricsWindowHeight(22, false), Math.ceil(22 * 1.35) + 20);
  // 任何字号都必须容得下三行（ceil 保证不截字）
  for (const f of [14, 18, 22, 26, 30, 36, 40]) {
    const h = lib.lyricsWindowHeight(f, true);
    assert.ok(h >= Math.ceil(f * 1.35) + Math.ceil(f * 0.84) * 2 + 18, `字号 ${f} 高度不足`);
  }
});

test('lyricsBoundsFromPrefs：默认底部居中留 72px；高度按字号自动算；多显示器/分辨率变化时夹回工作区', () => {
  const wa = { x: 100, y: 50, width: 1280, height: 800 };
  const d = lib.lyricsBoundsFromPrefs({ floatLyricsX: null, floatLyricsY: null }, wa);
  assert.deepEqual(d, { x: 100 + 280, y: 50 + 800 - 88 - 72, width: 720, height: 88 });
  // 字号 30 ⇒ 同一位置但更高
  const big = lib.lyricsBoundsFromPrefs({ floatLyricsX: null, floatLyricsY: null, floatFontSize: 30 }, wa);
  assert.equal(big.height, lib.lyricsWindowHeight(30, true));
  // 坐标落在副屏（已拔掉）⇒ 夹回主屏内，不许整窗跑到屏幕外
  const off = lib.lyricsBoundsFromPrefs({ floatLyricsX: 5000, floatLyricsY: -300 }, wa);
  assert.equal(off.x, 100 + (1280 - 720));
  assert.equal(off.y, 50);
  assert.deepEqual(lib.clampLyricsBounds({ x: 0, y: 0, width: 720, height: 180 }, wa), { x: 100, y: 50, width: 720, height: 180 });
});

test('★ 浮窗常规态：默认 420×320 居中、记录值优先、越界夹回，下限 FLOAT_MIN_SIZE 180×120（不等于默认尺寸）', () => {
  const wa = { x: 100, y: 50, width: 1280, height: 800 };
  assert.deepEqual(lib.floatRegularBoundsFromPrefs({}, wa), {
    x: 100 + Math.round((1280 - 420) / 2),
    y: 50 + Math.round((800 - 320) / 2),
    width: 420,
    height: 320,
  });
  // 记录值生效
  assert.deepEqual(lib.floatRegularBoundsFromPrefs({ floatRegularX: 300, floatRegularY: 200, floatRegularW: 460, floatRegularH: 340 }, wa), {
    x: 300, y: 200, width: 460, height: 340,
  });
  // 越界坐标夹回；小于下限（180×120）的尺寸被抬回下限
  // ★ 下限不是默认尺寸 —— 记录 300×200 原样保留（旧实现会抬回 420×320）
  assert.deepEqual(lib.floatRegularBoundsFromPrefs({ floatRegularX: 5000, floatRegularY: -500, floatRegularW: 300, floatRegularH: 200 }, wa), {
    x: 100 + 1280 - 300, y: 50, width: 300, height: 200,
  });
  assert.deepEqual(lib.floatRegularBoundsFromPrefs({ floatRegularX: 5000, floatRegularY: -500, floatRegularW: 120, floatRegularH: 90 }, wa), {
    x: 100 + 1280 - 180, y: 50, width: 180, height: 120,
  });
  // 默认落点跟随工作区原点（多显示器负坐标不能让窗口跑到主屏去）
  const wa2 = { x: -1920, y: -100, width: 1920, height: 1080 };
  const d2 = lib.floatRegularBoundsFromPrefs({}, wa2);
  assert.equal(d2.x, -1920 + Math.round((1920 - 420) / 2));
  assert.equal(d2.y, -100 + Math.round((1080 - 320) / 2));
});

test('normalizePrefs：浮窗两态几何只收合法数字，坏值回落 null 并告警', () => {
  const ok = normalizePrefs({ floatRegularX: 12.6, floatRegularY: null, floatRegularW: 460, floatRegularH: 340, floatBarX: 13.4, floatBarW: 320, floatBarH: 240 });
  assert.equal(ok.prefs.floatRegularX, 13);
  assert.equal(ok.prefs.floatRegularY, null);
  assert.equal(ok.prefs.floatRegularW, 460);
  assert.equal(ok.prefs.floatRegularH, 340);
  assert.equal(ok.prefs.floatBarX, 13);
  assert.equal(ok.prefs.floatBarW, 320);
  assert.equal(ok.prefs.floatBarH, 240);
  assert.equal(ok.warnings.length, 0);

  // 常规下限 = FLOAT_MIN_SIZE（180×120，见 apps/desktop/float-geometry.json）
  // 条形下限 = 320×100
  // ★ 400×320 不再算非法 —— 用户可以把常规浮窗手动缩到 180×120
  const bad = normalizePrefs({ floatRegularW: 170, floatRegularH: 'x', floatBarW: 100, floatBarH: 'x' });
  assert.equal(bad.prefs.floatRegularW, null);
  assert.equal(bad.prefs.floatRegularH, null);
  assert.equal(bad.prefs.floatBarW, null);
  assert.equal(bad.prefs.floatBarH, null);
  assert.equal(bad.warnings.length, 4);
  assert.ok(bad.warnings.some((w) => w.includes('floatRegularW')));
  assert.ok(bad.warnings.some((w) => w.includes('floatRegularH')));
  assert.ok(bad.warnings.some((w) => w.includes('floatBarW')));
  assert.ok(bad.warnings.some((w) => w.includes('floatBarH')));
});

test('★ 浮窗条形态：默认宽 920（与阅读面板同宽）高 140、底部居中；记录值优先且夹回工作区，下限 320×48', () => {
  const wa = { x: 100, y: 50, width: 1280, height: 800 };
  const d = lib.floatBarBoundsFromPrefs({}, wa, 920);
  assert.deepEqual(d, {
    x: 100 + (1280 - 920) / 2,
    y: 50 + 800 - 140 - 72,
    width: 920,
    height: 140,
  });
  // 主窗更窄时按主窗内容宽度（不超过 920）
  assert.equal(lib.floatBarBoundsFromPrefs({}, wa, 700).width, 700);
  // 用户记录值优先
  assert.deepEqual(lib.floatBarBoundsFromPrefs({ floatBarX: 300, floatBarY: 200, floatBarW: 1000, floatBarH: 160 }, wa, 920), {
    x: 300, y: 200, width: 1000, height: 160,
  });
  // 越界夹回；小于条形档下限被抬回（高度 60 已高于新下限 48，原样保留）
  const clamped = lib.floatBarBoundsFromPrefs({ floatBarX: 5000, floatBarY: -500, floatBarW: 200, floatBarH: 60 }, wa, 920);
  assert.equal(clamped.width, 320);
  assert.equal(clamped.height, 60);
  assert.equal(clamped.x, 100 + 1280 - 320);
  assert.equal(clamped.y, 50);
  // 默认尺寸常量与字面值一致（防「测试跟着实现一起漂」）
  assert.deepEqual({ ...lib.FLOAT_BAR_SIZE }, { width: 920, height: 140 });
  assert.deepEqual({ ...lib.FLOAT_BAR_MIN_SIZE }, { width: 320, height: 48 });
});

test('★ normalizeFloatReadingState：正文行去空/截断/夹取，坏值不抛错', () => {
  const s = lib.normalizeFloatReadingState({
    title: '第一章', chapterLabel: '1/10',
    lines: ['  第一行  ', '', 42, 'x'.repeat(400), '第二行'],
    index: 99,
  });
  assert.deepEqual(s.lines, ['  第一行  ', 'x'.repeat(300), '第二行']);
  assert.equal(s.index, 2, '越界 index 夹到最后一行');
  assert.equal(s.total, 3);
  assert.equal(typeof s.updatedAt, 'number');
  const empty = lib.normalizeFloatReadingState(null);
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.index, 0);
});

test('normalizePrefs：浮窗速度 / 两态穿透 / 条形态几何归一', () => {
  const ok = normalizePrefs({ floatSpeed: 3, floatClickThrough: false, floatRegularClickThrough: true, floatBarX: 10.4, floatBarW: 1000, floatBarH: 150 });
  assert.equal(ok.prefs.floatSpeed, 3);
  assert.equal(ok.prefs.floatClickThrough, false);
  assert.equal(ok.prefs.floatRegularClickThrough, true);
  assert.equal(ok.prefs.floatBarX, 10);
  assert.equal(ok.prefs.floatBarW, 1000);
  assert.equal(ok.prefs.floatBarH, 150);
  const bad = normalizePrefs({ floatSpeed: 9, floatClickThrough: 'yes', floatRegularClickThrough: 'no', floatBarW: 100, floatBarH: 'x' });
  assert.equal(bad.prefs.floatSpeed, lib.DEFAULT_PREFS.floatSpeed);
  assert.equal(bad.prefs.floatClickThrough, lib.DEFAULT_PREFS.floatClickThrough);
  assert.equal(bad.prefs.floatRegularClickThrough, lib.DEFAULT_PREFS.floatRegularClickThrough);
  assert.equal(bad.prefs.floatBarW, null);
  assert.equal(bad.prefs.floatBarH, null);
  assert.ok(bad.warnings.some((w) => w.includes('floatSpeed')));
  assert.ok(bad.warnings.some((w) => w.includes('floatClickThrough')));
  assert.ok(bad.warnings.some((w) => w.includes('floatRegularClickThrough')));
});

/* ---------------- 桌面歌词开关优先级链（env > 旗标 > 偏好 > 默认） ---------------- */

test('★ 歌词优先级①：环境变量最高——0 压过 lyrics-on.txt 与偏好开，1 压过 lyrics-off.txt', () => {
  const on = lib.resolveLyricsEnabled({ envRaw: '1', flagOn: false, flagOff: true, prefsEnabled: false });
  assert.equal(on.enabled, true);
  assert.equal(on.source, 'env');
  assert.equal(on.forced, true);
  const off = lib.resolveLyricsEnabled({ envRaw: '0', flagOn: true, flagOff: false, prefsEnabled: true });
  assert.equal(off.enabled, false);
  assert.equal(off.source, 'env');
  // 大小写/同义词也认；拼错/空串视为未设置，不猜
  assert.equal(lib.parseLyricsEnv(' OFF '), false);
  assert.equal(lib.parseLyricsEnv('Enabled'), true);
  assert.equal(lib.parseLyricsEnv(''), null);
  assert.equal(lib.parseLyricsEnv('yyds'), null);
});

test('★ 歌词优先级②：没有环境变量时，旗标文件压过偏好；两个旗标同时存在按关闭', () => {
  const flagOff = lib.resolveLyricsEnabled({ envRaw: '', flagOff: true, flagOn: false, prefsEnabled: true });
  assert.equal(flagOff.enabled, false, 'lyrics-off.txt 必须压过设置页的「开」');
  assert.equal(flagOff.source, 'flag');
  assert.equal(flagOff.forced, true);
  const flagOn = lib.resolveLyricsEnabled({ envRaw: undefined, flagOff: false, flagOn: true, prefsEnabled: false });
  assert.equal(flagOn.enabled, true, 'lyrics-on.txt 必须压过设置页的「关」');
  assert.equal(flagOn.source, 'flag');
  const both = lib.resolveLyricsEnabled({ flagOff: true, flagOn: true, prefsEnabled: true });
  assert.equal(both.enabled, false, '冲突时按关闭');
  assert.equal(both.conflict, true);
});

test('★ 歌词优先级③④：无外部配置时才看偏好；偏好也没有（或关）⇒ 默认 false', () => {
  const prefsOn = lib.resolveLyricsEnabled({ flagOff: false, flagOn: false, prefsEnabled: true });
  assert.equal(prefsOn.enabled, true);
  assert.equal(prefsOn.source, 'prefs');
  assert.equal(prefsOn.forced, false);
  const dflt = lib.resolveLyricsEnabled({});
  assert.equal(dflt.enabled, false);
  assert.equal(dflt.source, 'default');
  assert.equal(dflt.forced, false);
  // 文件名的约定要稳定（便携启动器与文档都按这两个名字）
  assert.equal(lib.LYRICS_FLAG_FILES.off, 'lyrics-off.txt');
  assert.equal(lib.LYRICS_FLAG_FILES.on, 'lyrics-on.txt');
});

/**
 * ★ release-818 实机 P0：歌词窗能用、小窗打不开并提示 `desktop-shell-outdated`。
 * 根因：preload 已换成 `float-*`，而冻结的 `ReaderOverlay.vue` 仍调旧封装名
 * （`toggleSmallMode` / `setSmallWindowTier`），封装层找不到对应桥方法就回落成「外壳过旧」。
 * 修法：**在 desktop.ts 这一层**把旧调用名翻译到 float API（不改冻结文件）。
 * 这里做的是源码级反证：翻译必须存在，且「过旧」只允许在没有 float 能力时出现。
 */
test('★ 818 回归：旧小窗调用名在 desktop.ts 翻译到 float API，不再误报 desktop-shell-outdated', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'web', 'src', 'desktop.ts'), 'utf8');

  // ① 桥接口必须声明 float 方法（否则 typecheck 会红）
  for (const m of ['getFloatState?', 'toggleFloat?', 'setFloatMode?', 'closeFloat?', 'onFloatState?']) {
    assert.ok(src.includes(m), `YueduBridge 缺少 ${m}() 声明`);
  }

  // ② 四个旧封装都要先试 float，再谈「过旧」
  const body = (name) => {
    const i = src.indexOf(`export const ${name}`);
    assert.ok(i >= 0, `找不到 ${name}`);
    // 截到下一个顶层 export / 文件末尾
    const rest = src.slice(i + 1);
    const j = rest.indexOf('\nexport ');
    return j >= 0 ? rest.slice(0, j) : rest;
  };
  const getBody = body('getSmallState');
  assert.match(getBody, /b\.getFloatState\(\)\.then\(floatToSmallState\)/, 'getSmallState 必须回落 getFloatState');

  const toggleBody = body('toggleSmallMode');
  assert.match(toggleBody, /b\.toggleFloat\('regular'\)/, '进入小窗 = toggleFloat(regular)');
  assert.match(toggleBody, /b\.closeFloat\(\)/, '退出小窗 = closeFloat()');
  assert.ok(
    toggleBody.indexOf('toggleFloat') < toggleBody.indexOf('outdatedSmallState'),
    '先试 float，最后才允许报过旧',
  );

  const tierBody = body('setSmallWindowTier');
  assert.match(tierBody, /b\.setFloatMode\(tier === 'bar' \? 'bar' : 'regular'\)/, '切档 = setFloatMode');

  const onBody = body('onSmallStateChange');
  assert.match(onBody, /b\.onFloatState\(/, '状态广播要订阅 onFloatState');
});

/**
 * ★ 818 实机：长句换行时歌词窗高度「逐帧慢慢涨」。
 * 根因：`.fl-card` 固定 100% 高 + 行被 flex 压扁 ⇒ 每次量到的都比当前窗只高一点点；
 * 加上 rAF 逐帧上报，看起来像动画。修法：行不许压缩 + 同步量 + 同高去重 + 主进程一次设到位。
 */
test('★ 818 回归：歌词窗高度一步到位（同步测量 / 行不压缩 / 实测高作基准）', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'lyrics.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  const main = fs.readFileSync(path.join(HERE, '..', 'main.js'), 'utf8');

  // ① 歌词行不许被 flex 压缩（否则 offsetHeight 量的是被压扁后的高度）
  const lineRule = html.match(/\.fl-line\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.match(lineRule, /flex:\s*0 0 auto;/, '.fl-line 必须 flex:0 0 auto');

  // ② requestFitHeight 同步测量，不再走 requestAnimationFrame
  const fitFn = js.match(/function requestFitHeight\(\)\s*\{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(fitFn, '找不到 requestFitHeight');
  assert.ok(!/requestAnimationFrame/.test(fitFn), 'requestFitHeight 不能再用 rAF 逐帧量');
  assert.ok(!/fitPending/.test(js), 'fitPending 节流已不需要');
  assert.match(fitFn, /lastFitH/, '同高必须去重，避免每帧发 IPC');
  assert.match(fitFn, /window\.yueduLyrics\.fitHeight\(target\)/);

  // ③ 窗高被外部改过（面板开合 / 切形态 / 字号）⇒ 去重基准要清掉，否则不会重报
  assert.match(js, /lastFitH = 0;[\s\S]{0,80}requestFitHeight\(\)/, '面板关闭后必须强制重报');
  assert.match(js, /if \(fs !== lastFitFs\) \{[\s\S]{0,120}lastFitH = 0;/, '字号变化要清去重基准');

  // ④ 主进程记实测内容高，面板加高/字号变化都以它为基准（长句开面板不缩高）
  assert.match(main, /let floatFitHeight = 0;/, '主进程要跟踪渲染层实测高');
  assert.match(main, /floatFitHeight = target;/, 'yuedu:float-height 要记住目标高（面板敞着也记）');
  assert.match(main, /function lyricsBaseHeight\(\)/, '基准高要有唯一出口');
  assert.match(main, /lyricsBaseHeight\(\) \+ extra/, '面板加高要叠在实测基准上，不能退回静态三行');
  assert.match(main, /floatFitHeight = 0;/, '离开歌词形态要清掉实测高');
});

/**
 * ★ 设置页「显示上下句 / 重置位置」整行删除；「重置位置」收进歌词窗工具条。
 * 重置是歌词窗唯一的位置重置入口（工具条原本没有），所以是**搬**过来而不是删掉。
 */
test('★ 「重置位置」收进歌词窗工具条（仅歌词形态；320 宽不挤掉按钮）', () => {
  const html = fs.readFileSync(path.join(HERE, '..', 'lyrics.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, '..', 'lyrics.js'), 'utf8');
  const main = fs.readFileSync(path.join(HERE, '..', 'main.js'), 'utf8');
  const settings = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'web', 'src', 'views', 'SettingsView.vue'), 'utf8');

  // ① 设置页那一整行已删干净（控件与标记都不留）
  assert.ok(!settings.includes('data-desk-lyrics-reset-pos'), '设置页不该再有重置按钮');
  assert.ok(!settings.includes('data-desk-lyrics-neighbors'), '设置页不该再有上下句开关');
  assert.ok(!settings.includes('<b>显示上下句</b>'), '设置页不该再有这一行');

  // ② 工具条按钮与既有按钮同构：data-tool 分发 + data-modes 控制形态（只在歌词形态出现）
  assert.match(html, /<button[^>]*data-tool="resetPos"[^>]*data-modes="lyrics"[^>]*>⌖<\/button>/);

  // ③ 点击走既有 floatCommand（不新造通道）
  assert.match(js, /case 'resetPos':[\s\S]{0,260}floatCommand\(\{ cmd: 'reset-pos' \}\)/);

  // ④ 主进程：清位置偏好 + 用户尺寸复位 + 按内容高；锁定不拦显式重置
  const block = main.match(/cmd\.cmd === 'reset-pos'[\s\S]*?sendFloatState\(\);/)?.[0] || '';
  assert.ok(block, 'main.js 缺 reset-pos 分支');
  assert.match(block, /prefs\.floatLyricsX = null;/);
  assert.match(block, /prefs\.floatLyricsY = null;/);
  assert.match(block, /floatLyricsUserSized = false;/);
  assert.match(block, /lyricsBaseHeight\(\)/);
  assert.ok(!/floatDragLocked/.test(block), '锁定不该阻止重置');

  // ⑤ 最窄 320px：窄屏下收紧按钮/间距（13×22 + 12×2 + 6 = 316），不裁掉/挤掉任何按钮
  const narrow = html.match(/@media \(max-width: 440px\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(narrow, /\.fl-actions button \{ width: 22px; height: 24px;/);
});


