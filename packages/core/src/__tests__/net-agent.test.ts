/**
 * `#332` 回归锁：默认 HTTP dispatcher 必须关闭 `autoSelectFamily`（双栈环境快速回落 IPv4）。
 *
 * ## 缺陷（用户侧，此前只能靠 env 规避）
 * 本机 = 双栈 DNS + IPv6 出口不通：域名解析出 2×v6 + 2×v4，Node 默认 Happy Eyeballs
 * 对四地址**整体并行等 10s**（undici connectTimeout）⇒ 即便 IPv4 可达也先耗满 10s 才失败。
 * 取证：带 `NODE_OPTIONS=--no-network-family-autoselection` 后 3s 通。
 *
 * ## 锁什么
 * ① 加载 core 网络层后，**全局 dispatcher 已是加固 agent**（非 Node 裸默认）；
 * ② 该 agent 的 `autoSelectFamily === false`；
 * ③ `YUEDU_NET_AUTOSELECT_FAMILY=1` 时不改（对照开关可用）——子进程验证。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.resolve(here, '../..');

/** 异步跑子进程并收集 stdout（★ 不用 execFileSync —— EBUSY 输出空，仓库纪律） */
function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: coreRoot, env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(0, 300)}`))));
  });
}

test('#332：默认 dispatcher 被加固，且 autoSelectFamily === false', async () => {
  const mod = await import('../net/net-agent');
  const { hardenedDispatcher, installHardenedDispatcher, __resetHardenedDispatcherForTest } = mod;
  __resetHardenedDispatcherForTest();
  const d = installHardenedDispatcher();
  assert.ok(d, '必须返回加固 dispatcher');
  assert.equal(hardenedDispatcher(), d);
  // undici Agent 把选项存在 agent[kOptions]（Symbol），公开面上无直接读法；
  // 用 `agent.constructor.name` + 反射读 options 断言。
  const opts = (d as unknown as { [k: symbol]: unknown })[
    (Object.getOwnPropertySymbols(d).find((s) => String(s).includes('options')) ?? Symbol.for('x')) as symbol
  ] as { autoSelectFamily?: unknown } | undefined;
  assert.equal(opts?.autoSelectFamily, false, `autoSelectFamily 必须为 false，实得 ${String(opts?.autoSelectFamily)}`);
});

test('#332：对照开关 YUEDU_NET_AUTOSELECT_FAMILY=1 时不改 dispatcher（子进程）', async () => {
  // 探针放 coreRoot 内（否则 node_modules 解析链断裂 / Windows 绝对路径 import 报
  // ERR_UNSUPPORTED_ESM_URL_SCHEME）⇒ 相对 import = `../src/net/net-agent.ts`
  const script = `
import { getGlobalDispatcher } from 'undici';
import { installHardenedDispatcher } from '../src/net/net-agent.ts';
const before = getGlobalDispatcher();
const d = installHardenedDispatcher();
// 对照模式下 install 返回的是「当前 dispatcher 原样」（不是新建 agent）⇒ 身份相同
console.log(JSON.stringify({ same: d === before, name: d.constructor.name }));
`;
  const tmpDir = fs.mkdtempSync(path.join(coreRoot, '.tmp-332-'));
  const tmpFile = path.join(tmpDir, 'probe.mts');
  fs.writeFileSync(tmpFile, script);
  try {
    const out = await runNode([path.join(coreRoot, '../../node_modules/tsx/dist/cli.mjs'), path.relative(coreRoot, tmpFile)], {
      ...process.env,
      YUEDU_NET_AUTOSELECT_FAMILY: '1',
    });
    const r = JSON.parse(out.trim().split('\n').pop() as string) as { same: boolean; name: string };
    assert.equal(r.same, true, '对照模式下不得替换 dispatcher');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
});
