import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySchemeImport, detectJsonImportType } from '../src/utils/scheme-import';

/** `#343` 唤起导入链接归类 + 上游 jsonImportType 判型表（判据带上游行号，见 scheme-import.ts 头注） */

test('classify: 用户点名的三类真实链接', () => {
  const a = classifySchemeImport(
    'yuedu://booksource/importonline?src=https://www.yckceo.com/yuedu/shuyuan/json/id/7929.json',
  );
  assert.equal(a.action.kind, 'sources');
  assert.equal(a.src, 'https://www.yckceo.com/yuedu/shuyuan/json/id/7929.json');

  const b = classifySchemeImport('legado://import/bookSource?src=https://qyyuapi.com/sy/hx/V3.1.json');
  assert.equal(b.action.kind, 'sources');
  assert.equal(b.src, 'https://qyyuapi.com/sy/hx/V3.1.json');

  const c = classifySchemeImport('legado://import/auto?src=https://www.yckceo.com/yuedu/rss/json/id/376.json');
  assert.equal(c.action.kind, 'determine');
  assert.equal(c.src, 'https://www.yckceo.com/yuedu/rss/json/id/376.json');
});

test('classify: 显式 rssSource（path 与 /importonline host 两式）', () => {
  assert.equal(classifySchemeImport('legado://import/rssSource?src=https://x/a.json').action.kind, 'sources');
  assert.equal(classifySchemeImport('yuedu://rsssource/importonline?src=https://x/a.json').action.kind, 'sources');
});

test('classify: 替换（净化）规则两式', () => {
  assert.equal(classifySchemeImport('legado://import/replaceRule?src=https://x/r.json').action.kind, 'replaceRule');
  assert.equal(classifySchemeImport('yuedu://replace/importonline?src=https://x/r.json').action.kind, 'replaceRule');
});

test('classify: 上游有、本仓无实体的 path 一律 unsupported 且带标签', () => {
  const cases: Array<[string, string]> = [
    ['legado://import/theme?src=https://x/t.json', '主题'],
    ['legado://import/httpTTS?src=https://x/t.json', '朗读 TTS 源'],
    ['legado://import/dictRule?src=https://x/t.json', '字典规则'],
    ['legado://import/textTocRule?src=https://x/t.json', 'txt 目录规则'],
    ['legado://import/autoTask?src=https://x/t.json', '自动任务'],
    ['legado://import/readConfig?src=https://x/t.zip', '阅读配置'],
    ['legado://import/addToBookshelf?src=https://x/', '加入书架'],
  ];
  for (const [raw, label] of cases) {
    const a = classifySchemeImport(raw);
    assert.equal(a.action.kind, 'unsupported', raw);
    if (a.action.kind === 'unsupported') assert.equal(a.action.label, label);
  }
});

test('classify: 未知 path 落 determine（上游 else -> determineType 兜底）', () => {
  assert.equal(classifySchemeImport('legado://import/something?src=https://x/a.json').action.kind, 'determine');
});

test('classify: 无 src / 坏链接 / 缺 query 一律 invalid', () => {
  assert.equal(classifySchemeImport('legado://import/bookSource').action.kind, 'invalid');
  assert.equal(classifySchemeImport('legado://import/bookSource?src=').action.kind, 'invalid');
  assert.equal(classifySchemeImport('not a url at all').action.kind, 'invalid');
});

test('classify: src 百分号编码要解码；scheme/path/host 大小写宽容（分享站实际大小写混乱）', () => {
  const a = classifySchemeImport('legado://import/bookSource?src=https%3A%2F%2Fx%2Fa.json');
  assert.equal(a.src, 'https://x/a.json');
  const b = classifySchemeImport('LEGADO://IMPORT/BOOKSOURCE?src=https://x/a.json');
  assert.equal(b.action.kind, 'sources');
});

test('classify: src 参数名大小写敏感（对齐上游 Uri.getQueryParameter("src")）', () => {
  assert.equal(classifySchemeImport('legado://import/bookSource?SRC=https://x/a.json').action.kind, 'invalid');
});

test('detect: 书源数组取首个元素判型', () => {
  const text = JSON.stringify([{ bookSourceUrl: 'https://x', bookSourceName: 'a' }, { bookSourceUrl: 'https://y' }]);
  assert.equal(detectJsonImportType(text), 'bookSource');
});

test('detect: 订阅源对象（sourceUrl 键）', () => {
  assert.equal(detectJsonImportType(JSON.stringify({ sourceUrl: 'https://x', sourceName: 'r' })), 'rssSource');
});

test('detect: 替换规则数组（pattern 键）', () => {
  const text = JSON.stringify([{ pattern: 'a', replacement: 'b', name: 'r' }]);
  assert.equal(detectJsonImportType(text), 'replaceRule');
});

test('detect: 其余类型逐条对齐上游判据', () => {
  assert.equal(detectJsonImportType(JSON.stringify({ themeName: 't' })), 'theme');
  assert.equal(detectJsonImportType(JSON.stringify({ showRule: 'x' })), 'dictRule');
  assert.equal(detectJsonImportType(JSON.stringify({ name: 'n', rule: 'r' })), 'txtRule');
  assert.equal(detectJsonImportType(JSON.stringify({ cron: 'c', script: 's' })), 'autoTask');
  assert.equal(detectJsonImportType(JSON.stringify({ name: 'n', url: 'u' })), 'httpTts');
  assert.equal(detectJsonImportType(JSON.stringify({ name: 'n', author: 'a' })), 'bookshelf');
  assert.equal(detectJsonImportType(JSON.stringify({ type: 'highlightRule' })), 'highlightRule');
});

test('detect: pattern+style+uuid 无 replacement = 高亮；pattern+(style|uuid) = 上游显式「格式不对」', () => {
  assert.equal(
    detectJsonImportType(JSON.stringify({ pattern: 'p', style: 's', uuid: 'u' })),
    'highlightRule',
  );
  assert.equal(detectJsonImportType(JSON.stringify({ pattern: 'p', style: 's' })), null);
});

test('detect: 解析失败 / 空数组 / 空对象 => null', () => {
  assert.equal(detectJsonImportType('this is not json {'), null);
  assert.equal(detectJsonImportType('[]'), null);
  assert.equal(detectJsonImportType('{}'), null);
});

/**
 * `#347` 深链派发器：两条到达路径（网页 postMessage / 桌面端 IPC）必须落到**同一个**处理器。
 * 缺陷类别：在 `desktop.ts` 里另写一遍判型 ⇒ 同一判据写两处必然漂移。
 */
test('#347 dispatch: 处理器已注册时立即投递（顺序保持）', async () => {
  const mod = await import('../src/utils/scheme-import');
  const seen: string[] = [];
  mod.setSchemeImportHandler((u) => seen.push(u));
  mod.dispatchSchemeImport('yuedu://import/bookSource?src=https://x/a.json');
  mod.dispatchSchemeImport('legado://import/rssSource?src=https://x/b.json');
  assert.deepEqual(seen, [
    'yuedu://import/bookSource?src=https://x/a.json',
    'legado://import/rssSource?src=https://x/b.json',
  ]);
  mod.setSchemeImportHandler(null);
});

test('#347 dispatch: 处理器未注册时**入队不丢**，注册后立即补发（桌面端冷启动时序）', async () => {
  const mod = await import('../src/utils/scheme-import');
  mod.setSchemeImportHandler(null);
  // 模拟：IPC 早于组件挂载到达
  mod.dispatchSchemeImport('yuedu://import/bookSource?src=https://early/x.json');
  const seen: string[] = [];
  mod.setSchemeImportHandler((u) => seen.push(u));
  assert.deepEqual(seen, ['yuedu://import/bookSource?src=https://early/x.json'], '排队中的深链必须补发，否则冷启动那次唤起就丢了');
  // 补发后队列清空：再注册一次不该重复收到
  const seen2: string[] = [];
  mod.setSchemeImportHandler((u) => seen2.push(u));
  assert.deepEqual(seen2, [], '补发过的不该再发一次');
  mod.setSchemeImportHandler(null);
});

test('#347 dispatch: 空白输入被忽略（别把空串当深链投出去）', async () => {
  const mod = await import('../src/utils/scheme-import');
  const seen: string[] = [];
  mod.setSchemeImportHandler((u) => seen.push(u));
  mod.dispatchSchemeImport('');
  mod.dispatchSchemeImport('   ');
  assert.deepEqual(seen, []);
  mod.setSchemeImportHandler(null);
});
