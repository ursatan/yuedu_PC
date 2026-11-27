/**
 * `#742` `dnsIp` IP 直连回归锁（对齐上游 `AnalyzeUrlNetworkOptions.buildScopedDns`）。
 *
 * 全部用**本机回环**：不依赖外网、不依赖真实 DNS（除「非法 IP 回落」那条用 `127.0.0.1` 字面量）。
 * 判据四件事：
 *  1. 带 `dnsIp` ⇒ 真的连指定 IP，而 `Host` 头**仍是 URL 域名**；
 *  2. 不带 `dnsIp` ⇒ 行为一点没变（URL 域名照旧交给系统解析）；
 *  3. 多值 `IP,IP2` ⇒ 第一个连不上时按序切到第二个；
 *  4. 非法 IP ⇒ 回落系统解析（不抛错、不留死路）。
 * 另加一条 TLS 判据：SNI 里必须是 URL 域名（不是 IP）—— 这是「证书按域名校验」的前提。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHttpClient } from './index';
import { __resetDnsIpDispatchersForTest, makeScopedDnsIpLookup, parseDnsIpList } from './dns-ip';

test('#742 parseDnsIpList：多值/空白/方括号 IPv6/非法值/去重', () => {
  const r = parseDnsIpList(' 10.0.0.1 , [2001:db8::1] , 10.0.0.1 , not-an-ip, ::1 ');
  assert.deepEqual(r.ips, ['10.0.0.1', '2001:db8::1', '::1']);
  assert.deepEqual(r.invalid, ['not-an-ip']);
  assert.deepEqual(parseDnsIpList('').ips, []);
  assert.deepEqual(parseDnsIpList(undefined).ips, []);
});

test('#742 作用域 lookup：只覆盖目标域名，其它域名回落', async () => {
  const lookup = makeScopedDnsIpLookup('picaapi.picacomic.com', '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    lookup('PICAAPI.picacomic.com', { family: 4 }, (err, addr, family) => {
      try {
        assert.equal(err, null);
        assert.equal(addr, '127.0.0.1');
        assert.equal(family, 4);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    lookup('localhost', { family: 0 }, (err, addr) => {
      try {
        assert.equal(err, null);
        assert.ok(addr);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('#742 带 dnsIp 走指定 IP，Host 头仍是 URL 域名', async () => {
  __resetDnsIpDispatchersForTest();
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.headers.host || ''));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const client = createHttpClient();
    const res = await client.request(`http://dnsip-742.test:${port}/categories`, {
      dnsIp: '127.0.0.1',
      timeout: 5_000,
    });
    assert.equal(res.status, 200);
    assert.equal(String(res.body), 'ok');
    // Host **必须**是域名（不是 IP）：这是「SNI/证书按域名」的同一条纪律
    assert.equal(seen[0], `dnsip-742.test:${port}`);
  } finally {
    server.close();
  }
});

test('#742 不带 dnsIp：行为零变化（域名照旧走系统解析）', async () => {
  __resetDnsIpDispatchersForTest();
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const client = createHttpClient();
    await assert.rejects(
      client.request(`http://dnsip-742.test:${port}/`, { timeout: 5_000 }),
      (e: unknown) => /DNS 解析失败|ENOTFOUND|fetch failed/i.test(String(e)),
    );
  } finally {
    server.close();
  }
});

test('#742 多值回退：第一个 IP 连不上按序切到第二个', async () => {
  __resetDnsIpDispatchersForTest();
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const client = createHttpClient();
    // 127.0.0.2 在本机必然 ECONNREFUSED（回环段未监听）⇒ 应自动切到 127.0.0.1
    const res = await client.request(`http://dnsip-742.test:${port}/`, {
      dnsIp: '127.0.0.2,127.0.0.1',
      timeout: 8_000,
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('#742 非法 dnsIp：回落系统解析，不抛错', async () => {
  __resetDnsIpDispatchersForTest();
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const res = await createHttpClient().request(`http://127.0.0.1:${port}/`, {
      dnsIp: 'not-an-ip',
      timeout: 5_000,
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('#742 TLS：SNI 用 URL 域名（不是 IP），连接走 dnsIp', async () => {
  __resetDnsIpDispatchersForTest();
  const hello = await new Promise<{ sni: string; ip: string }>((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.once('data', (buf) => {
        // TLS ClientHello 明文里带 SNI；这里不需要真握手，只验「发出去的 servername」
        const sni = buf.includes(Buffer.from('sni-742.test')) ? 'sni-742.test' : '';
        resolve({ sni, ip: sock.remoteAddress ?? '' });
        sock.destroy();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', async () => {
      const port = (server.address() as net.AddressInfo).port;
      try {
        await createHttpClient().request(`https://sni-742.test:${port}/`, {
          dnsIp: '127.0.0.1',
          timeout: 5_000,
        });
      } catch {
        /* 预期失败：服务端只收到 ClientHello 就断 */
      } finally {
        server.close();
      }
    });
  });
  assert.equal(hello.ip, '127.0.0.1');
  assert.equal(hello.sni, 'sni-742.test');
});
