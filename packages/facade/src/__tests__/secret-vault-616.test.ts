/**
 * `#616` 登录态落盘加密 —— 回归锁。
 *
 * 判据（legado-parity §8 `#616`）：
 *   ① 落盘内容不再含可读账号/密码；
 *   ② 兼容读旧明文（迁移一次）；
 *   ③ 单测「加密→解密往返」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { createMemoryKeyValueStore } from '@yuedu/core';
import {
  createVaultStore,
  sealSecret,
  openSecret,
  isSealed,
  sealJsonFile,
  openJsonFile,
  VAULT_PREFIX,
} from '../secret-vault';

const KEY = randomBytes(32);
const KEY2 = randomBytes(32);

function memStore(initial: Record<string, string> = {}): {
  store: ReturnType<typeof createMemoryKeyValueStore>;
  raw: Map<string, string>;
} {
  const inner = createMemoryKeyValueStore();
  const raw = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) {
    raw.set(k, v);
    void inner.set(k, v);
  }
  // 用一个「可读到底存了什么」的探针包住，断言落盘内容
  const spied = {
    get: (k: string) => inner.get(k),
    set: async (k: string, v: string) => {
      raw.set(k, v);
      await inner.set(k, v);
    },
    delete: async (k: string) => {
      raw.delete(k);
      await inner.delete(k);
    },
  };
  return { store: spied as unknown as ReturnType<typeof createMemoryKeyValueStore>, raw };
}

test('#616 加密→解密往返（中文账号密码）', () => {
  const plain = JSON.stringify({ 用户名: 'zhangsan', 密码: 'p@ss 中文' });
  const sealed = sealSecret(plain, KEY);
  assert.ok(sealed.startsWith(VAULT_PREFIX));
  const r = openSecret(sealed, KEY);
  assert.equal(r.failed, false);
  assert.equal(r.text, plain);
});

test('#616 ① 落盘内容不含可读账号/密码', () => {
  const { store, raw } = memStore();
  const vault = createVaultStore(store, KEY);
  const info = JSON.stringify({ 账号: '13800138000', 密码: 'secret123' });
  void vault.set('login-info:s1', info);
  const onDisk = raw.get('login-info:s1')!;
  assert.ok(isSealed(onDisk), '落盘必须是密文信封');
  assert.ok(!onDisk.includes('secret123'), `落盘明文泄漏：${onDisk}`);
  assert.ok(!onDisk.includes('13800138000'));
});

test('#616 ② 旧明文可读，且就地加密回写一次', async () => {
  const { store, raw } = memStore({ 'login-info:legacy': JSON.stringify({ 密码: 'old123' }) });
  const vault = createVaultStore(store, KEY);
  const got = await vault.get('login-info:legacy');
  assert.equal(got, JSON.stringify({ 密码: 'old123' }), '旧明文必须原样读出（不能丢登录态）');
  await new Promise((r) => setTimeout(r, 5)); // 迁移回写是 fire-and-forget
  assert.ok(isSealed(raw.get('login-info:legacy') ?? ''), '读到旧明文应就地加密回写');
});

test('#616 非敏感键不进保险箱（源变量保持明文可读）', async () => {
  const { store, raw } = memStore();
  const vault = createVaultStore(store, KEY);
  await vault.set('source-var:s1', '{"page":3}');
  assert.equal(raw.get('source-var:s1'), '{"page":3}');
  assert.equal(await vault.get('source-var:s1'), '{"page":3}');
});

test('#616 换密钥（换机/密钥丢失）⇒ 读不到且不崩', async () => {
  const { store } = memStore();
  const vault = createVaultStore(store, KEY);
  await vault.set('login-info:s2', 'x');
  const other = createVaultStore(store, KEY2);
  assert.equal(await other.get('login-info:s2'), null, '密钥不对应返回 null（按无登录态处理）');
});

test('#616 cookies.json 信封：写读往返 + 旧文件兼容', () => {
  const cookies = { 'https___a.com': 'cf_clearance=abc; session=zzz' };
  const text = sealJsonFile(cookies, KEY);
  assert.ok(!text.includes('cf_clearance=abc'), 'cookie 明文泄漏');
  const { data, sealed } = openJsonFile<Record<string, string>>(text, KEY);
  assert.equal(sealed, true);
  assert.deepEqual(data, cookies);

  // 旧明文文件
  const legacy = JSON.stringify(cookies, null, 1);
  const old = openJsonFile<Record<string, string>>(legacy, KEY);
  assert.equal(old.sealed, false);
  assert.deepEqual(old.data, cookies);
});

test('#616 无密钥时 fail-open（明文直存，功能不坏）', async () => {
  const { store, raw } = memStore();
  const vault = createVaultStore(store, null);
  await vault.set('login-info:s3', 'plain-text');
  assert.equal(raw.get('login-info:s3'), 'plain-text');
  assert.equal(await vault.get('login-info:s3'), 'plain-text');
});
