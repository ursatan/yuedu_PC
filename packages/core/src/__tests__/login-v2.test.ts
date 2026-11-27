/**
 * LoginUiV2 协议层（逐条对齐 Legado `model/login/LoginUiV2.kt`）。
 *
 * ⚠️ 语料 484 源里精确 `{version:2}` 对象 **0 个** → 没有真实源可端到端验证，
 * 这里用**合成输入**把协议行为锁死（出现真实源时再补端到端）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLoginUiV2,
  parseLoginUiV2Render,
  parseLoginUiV2Action,
  resolveLoginFieldValue,
  LOGIN_UI_V2_VERSION,
} from '../contract/login-v2';

const rows = (r: unknown) => JSON.stringify({ rows: r });

test('isLoginUiV2：只有 JSON 对象且 version==2 才算（Legado 以 `{` 开头为前提）', () => {
  assert.equal(LOGIN_UI_V2_VERSION, 2);
  assert.equal(isLoginUiV2('{"version":2}'), true);
  assert.equal(isLoginUiV2(' { "version" : 2 } '), true);
  assert.equal(isLoginUiV2('{"version":2,"rows":[]}'), true);
  assert.equal(isLoginUiV2('{"version":1}'), false);
  assert.equal(isLoginUiV2('{"version":"2"}'), true, 'Legado 用 asInt 比较，字符串 "2" 也算');
  assert.equal(isLoginUiV2('[{"name":"a"}]'), false, 'v1 数组不是 v2');
  assert.equal(isLoginUiV2('@js:[]'), false);
  assert.equal(isLoginUiV2(''), false);
  assert.equal(isLoginUiV2(null), false);
  assert.equal(isLoginUiV2('{"version":2'), false, '坏 JSON');
});

test('parseRender：合法行通过，缺 rows / 空数组 / 行非法一律 null（不得退化成空表单）', () => {
  const ok = parseLoginUiV2Render(
    rows([
      { name: '账号', type: 'text', key: 'user', value: 'alice' },
      { name: '密码', type: 'password', key: 'pass' },
      { name: '说明', type: 'label' },
      { name: '线路', type: 'select', key: 'line', options: ['A', 'B'] },
      { name: '记住', type: 'toggle', key: 'remember', value: 'true', action: 'toggleRemember' },
      { name: '登录', type: 'button', action: 'doLogin', countdown: 3 },
    ]),
  );
  assert.ok(ok, '合法 rows 应当通过');
  assert.equal(ok!.length, 6);
  assert.equal(ok![0]!.key, 'user');
  assert.equal(ok![0]!.value, 'alice');
  assert.equal(ok![3]!.options!.join(','), 'A,B');
  assert.equal(ok![5]!.countdown, 3);

  assert.equal(parseLoginUiV2Render(''), null);
  assert.equal(parseLoginUiV2Render('{}'), null, '缺 rows');
  assert.equal(parseLoginUiV2Render(rows([])), null, '空数组');
  assert.equal(parseLoginUiV2Render('not json'), null);
  assert.equal(parseLoginUiV2Render(JSON.stringify({ rows: 'x' })), null, 'rows 不是数组');
});

test('parseRender：逐类型合法性（key/options/value/action/countdown/name）', () => {
  assert.equal(parseLoginUiV2Render(rows([{ name: '  ', type: 'label' }])), null, 'name 不得为空');
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'text' }])), null, 'text 需要 key');
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'password', key: '' }])), null);
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'select', key: 'k' }])), null, 'select 需要 options');
  assert.equal(
    parseLoginUiV2Render(rows([{ name: 'x', type: 'select', key: 'k', options: [] }])),
    null,
    'options 不得为空数组',
  );
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'toggle', key: 'k', value: 'yes' }])), null, 'toggle.value 只允许 true/false');
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'toggle', key: 'k', action: '  ' }])), null, 'toggle.action 给了就不能空');
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'button' }])), null, 'button 需要 action');
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'unknown', key: 'k' }])), null, '未知 type');
  assert.equal(parseLoginUiV2Render(rows([{ name: 'x', type: 'label', countdown: -1 }])), null, 'countdown 不得为负');
  // label 行不需要 key
  assert.equal(parseLoginUiV2Render(rows([{ name: '标题', type: 'label' }]))!.length, 1);
});

test('parseRender：key / action 必须唯一（Legado keys.size != distinct → null）', () => {
  assert.equal(
    parseLoginUiV2Render(rows([{ name: 'a', type: 'text', key: 'k' }, { name: 'b', type: 'password', key: 'k' }])),
    null,
    'key 重复',
  );
  assert.equal(
    parseLoginUiV2Render(rows([{ name: 'a', type: 'button', action: 'go' }, { name: 'b', type: 'button', action: 'go' }])),
    null,
    'action 重复',
  );
  // text 与 select 同 key 也算重复；label 不参与
  assert.equal(
    parseLoginUiV2Render(rows([{ name: 'a', type: 'text', key: 'k' }, { name: 'l', type: 'label' }, { name: 'b', type: 'select', key: 'k', options: ['x'] }])),
    null,
  );
});

test('parseActionResult：四命令解析 + 未知键 + 类型不符判 malformed', () => {
  assert.deepEqual(parseLoginUiV2Action(''), { close: false, unknownKeys: [], malformed: false }, '空 → 无命令');
  const full = parseLoginUiV2Action(
    JSON.stringify({ state: { step: 2 }, error: { user: '必填' }, login: { u: 'a' }, close: true }),
  );
  assert.equal(full.malformed, false);
  assert.equal(full.stateJson, '{"step":2}');
  assert.equal(full.error!.user, '必填');
  assert.equal(full.loginJson, '{"u":"a"}');
  assert.equal(full.close, true);
  const unknown = parseLoginUiV2Action(JSON.stringify({ foo: 1, close: false }));
  assert.deepEqual(unknown.unknownKeys, ['foo'], '未知命令要回传（调用方记日志后忽略）');

  // 类型不符
  assert.equal(parseLoginUiV2Action('not json').malformed, true);
  assert.equal(parseLoginUiV2Action(JSON.stringify({ state: 'x' })).malformed, true);
  assert.equal(parseLoginUiV2Action(JSON.stringify({ login: [] })).malformed, true);
  assert.equal(parseLoginUiV2Action(JSON.stringify({ close: 'yes' })).malformed, true);
  assert.equal(parseLoginUiV2Action(JSON.stringify({ error: { k: { deep: 1 } } })).malformed, true, 'error 的值必须是标量');
  // 标量可字符串化（GSON Map<String,String> 语义）
  const scalar = parseLoginUiV2Action(JSON.stringify({ error: { k: 1, b: true } }));
  assert.equal(scalar.malformed, false);
  assert.equal(scalar.error!.k, '1');
  assert.equal(scalar.error!.b, 'true');
});

test('resolveFieldValue 优先级：row.value → 本次会话输入 → 已保存（Legado 同）', () => {
  assert.equal(resolveLoginFieldValue('r', 's', 'd'), 'r');
  assert.equal(resolveLoginFieldValue(null, 's', 'd'), 's');
  assert.equal(resolveLoginFieldValue(undefined, undefined, 'd'), 'd');
  assert.equal(resolveLoginFieldValue(null, null, null), undefined);
});
