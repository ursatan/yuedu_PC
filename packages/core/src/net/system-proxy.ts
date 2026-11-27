/**
 * `#332`/`#386` **引擎接入系统代理**（运行期开关）。
 *
 * 为什么需要：引擎的 HTTP 栈 = undici 的 global `fetch`，**默认不吃系统代理** ——
 * 用户浏览器走本地代理软件可达的站点，引擎直连就撞墙（实测 2026-10-10：封面域
 * `static-tw.baozimhcn.com` 解析到 Cloudflare 104.26.x 段，本机直连 TCP 全阻断，
 * 浏览器走代理却正常 ⇒ 发现页整页文字封面）。本模块把「走不走代理」做成运行期配置：
 *
 * - `applySystemProxy(true, url)`：
 *   · `url` 非空 ⇒ `ProxyAgent(url)`（用户在设置页填的代理地址，如 `http://127.0.0.1:7890`）；
 *   · `url` 为空 ⇒ `EnvHttpProxyAgent()`（吃 `http_proxy` / `https_proxy` / `no_proxy` 环境变量）。
 * - `applySystemProxy(false)`：恢复进程**原始** dispatcher（首次接管时捕获，只捕获一次）。
 *
 * 生效面：`fetchOnceInner` 用 global `fetch` ⇒ 全局 dispatcher 一换全通；AIA 补证书链的
 * 请求自带 per-request dispatcher（`#372`），不受影响也不受破坏 —— 两机制正交。
 *
 * 持久化在**服务端**（`data/network-proxy.json`，独立文件 —— `#238` 纪律：配置不进
 * 300ms 防抖 KV）；本模块只负责「把 dispatcher 换上/换下来」，无状态持久。
 */
import { EnvHttpProxyAgent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { installHardenedDispatcher } from './net-agent';

/** 首次接管前的进程默认 dispatcher（只捕获一次；false 恢复的就是它） */
let savedDispatcher: Dispatcher | null = null;

/** 已 apply 成功的状态（与 `current`（用户期望）分开：apply 失败时 current 变、active 不变） */
let active: { enabled: boolean; url: string } = { enabled: false, url: '' };

/** warnOnce（本模块独立小实现——net/index.ts 的是私有，为一条日志不值得开公共口） */
const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[system-proxy] ${msg}`);
}

/** 当前实际生效的代理状态（服务端 GET 回显 + 测试断言用） */
export function systemProxyState(): { enabled: boolean; url: string } {
  return { ...active };
}

/**
 * 应用/关闭系统代理。**不抛异常**（设置页要拿 error 人话回显），结果看返回值。
 * @param enabled true = 走代理；false = 恢复直连
 * @param url 代理地址（空 = 吃环境变量；只认 http/https——SOCKS 不在 undici 内建范围）
 */
export function applySystemProxy(enabled: boolean, url = ''): { ok: boolean; error?: string } {
  try {
    if (!enabled) {
      if (savedDispatcher) {
        setGlobalDispatcher(savedDispatcher);
        savedDispatcher = null;
      }
      active = { enabled: false, url: '' };
      warnOnce('off', '已恢复直连（全局 dispatcher 还原）');
      return { ok: true };
    }
    const u = url.trim();
    if (u) {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return { ok: false, error: '代理地址不是合法 URL（例：http://127.0.0.1:7890）' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: `代理协议只认 http/https（实得 ${parsed.protocol}；SOCKS 需本地转换）` };
      }
    }
    if (!savedDispatcher) {
      // `#332`：先确保「加固后的默认 dispatcher」（关 autoSelectFamily）已安装，
      // 再记下它作为「代理关闭时要还原到的直连」——否则会还原成 Node 裸默认（双栈挂死）。
      installHardenedDispatcher();
      savedDispatcher = getGlobalDispatcher();
    }
    setGlobalDispatcher(u ? new ProxyAgent(u) : new EnvHttpProxyAgent());
    active = { enabled: true, url: u };
    warnOnce('on', u ? `引擎走代理：${u}` : '引擎走代理（环境变量 http_proxy/https_proxy）');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

/** 测试专用：重置模块状态（dispatcher 本身不动——每个测试进程内先 apply(false) 收尾） */
export function __resetSystemProxyForTest(): void {
  savedDispatcher = null;
  active = { enabled: false, url: '' };
}

/** 语法合法性预检（设置页保存前的人话校验；不真正建连） */
export function validateProxyUrl(url: string): { ok: boolean; error?: string } {
  const u = url.trim();
  if (!u) return { ok: true }; // 空 = 环境变量模式
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `代理协议只认 http/https（实得 ${parsed.protocol}）` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '代理地址不是合法 URL（例：http://127.0.0.1:7890）' };
  }
}
