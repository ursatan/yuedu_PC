/**
 * `#332` **默认 HTTP dispatcher 加固**（用户侧修复，不必再依赖 `NODE_OPTIONS`）。
 *
 * ## 缺陷
 * 本机网络是**双栈 DNS + IPv6 出口不通**：域名解析出 2×IPv6 + 2×IPv4 四个地址，
 * Node ≥20 默认开启 `autoSelectFamily`（Happy Eyeballs）——**四个地址整体并行尝试、
 * 整体等 10s**（undici connectTimeout 默认值）。IPv6 全部黑洞 ⇒ 即使 IPv4 可达，
 * 也要先耗满 10s 才失败 ⇒ 实测 Cloudflare 站（饭团 / 24凹凸同款）home/category 全超时。
 *
 * ## 取证（2026-10-07）
 * 同一脚本带 `NODE_OPTIONS=--no-network-family-autoselection` 后 **3s 通**；
 * 不带时连 403 都拿不到（连接超时）。⇒ 主因 = 地址族自动选择，不是站点侧。
 *
 * ## 修法
 * 默认 dispatcher 用 `Agent({ connect: { autoSelectFamily: false } })`：
 * **关闭 Happy Eyeballs**，退回 Node 传统的「按 DNS 顺序逐个地址尝试」——
 * IPv6 先试、快速失败（ECONNREFUSED/ENETUNREACH 是**秒级**，不是 10s）⇒ 立刻回落 IPv4。
 * 等价于把 `--no-network-family-autoselection` 写进进程，**用户侧无需设环境变量**。
 *
 * ## 与系统代理（`#386`）的关系
 * 两者都操作 undici **全局 dispatcher**，所以**共用同一份「接管 → 记录原值 → 还原」协议**：
 * 本模块负责**建立默认值**，`system-proxy.ts` 负责**临时接管**（代理开/关）。
 * `savedDispatcher`（system-proxy 捕获的"原值"）自然就是本模块建好的默认 agent ⇒
 * 关闭代理时还原到的仍是加固后的直连，两条路径不打架。
 */
import { Agent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';

/** 是否禁用地址族自动选择（默认禁用；`YUEDU_NET_AUTOSELECT_FAMILY=1` 可恢复 Node 默认，便于对照） */
function autoSelectDisabledByDefault(): boolean {
  const v = String(process.env['YUEDU_NET_AUTOSELECT_FAMILY'] ?? '').toLowerCase();
  return !['1', 'true', 'yes'].includes(v);
}

let hardened: Dispatcher | null = null;

/**
 * 建好并安装加固后的默认 dispatcher（**幂等**：重复调用只装一次）。
 * 返回安装的那个 dispatcher（供测试断言 / 供 system-proxy 记录原值）。
 */
export function installHardenedDispatcher(): Dispatcher {
  if (hardened) {
    setGlobalDispatcher(hardened);
    return hardened;
  }
  if (autoSelectDisabledByDefault()) {
    hardened = new Agent({
      // ★ 关闭 Happy Eyeballs（undici Agent 顶层选项，非 connect 内）：
      //   四地址不再整体并行等 10s，改为逐地址快速回落（`#332`）
      autoSelectFamily: false,
    });
    setGlobalDispatcher(hardened);
    console.warn('[net-agent] 已安装加固 dispatcher（autoSelectFamily: false ⇒ 双栈环境快速回落 IPv4，#332）');
  } else {
    hardened = getGlobalDispatcher();
    console.warn('[net-agent] YUEDU_NET_AUTOSELECT_FAMILY=1 ⇒ 保留 Node 默认地址族自动选择（仅对照用）');
  }
  return hardened;
}

/** 当前加固 dispatcher（未安装时为 null） */
export function hardenedDispatcher(): Dispatcher | null {
  return hardened;
}

/** 测试专用：丢弃已建 agent（下一个 install 会重建） */
export function __resetHardenedDispatcherForTest(): void {
  hardened = null;
}

let insecure: Dispatcher | null = null;

/**
 * `#428`（`D12` = **A**，用户 2026-10-12 拍板）**按源忽略 TLS 校验**的 dispatcher —— 唯一实现。
 *
 * ## 为什么必须能开这个口子（且只按源开）
 * AGE 动漫（`api.agedm.io`）的**证书当天过期**（叶子 `CN=www.agedm.io`，2026-10-12 10:03 GMT）：
 * 站点侧问题，但站点续期前该源**完全不可用**；`http` 端口不通、也没有替代域。
 * `tls-aia.ts` 的既定决策是「过期证书不补全」（对：补全只解决**链不完整**，解决不了过期），
 * 所以只能由**用户自己**按源显式承担这个风险。
 *
 * ## 安全边界（三条硬约束，改这里必须同时满足）
 *  · **绝不设成全局默认** —— 只由 `HttpRequestOptions.allowInsecureTls` 单请求传入，
 *    不碰 `setGlobalDispatcher`（全局关校验 = 给整台机器的所有请求开中间人窗口）；
 *  · 只在**源侧显式开了 `allowInsecureTls`** 时才传该选项（`hub.makeContext` 的唯一接线点）；
 *  · 保留 `autoSelectFamily: false`（与加固 dispatcher 一致，否则双栈站点会退化成整体等超时）。
 *
 * 进程级单例（一台 host 一个 Agent 太碎，且 undici 的 `connect` 对任意 host 生效）。
 */
export function insecureTlsDispatcher(): Dispatcher {
  if (!insecure) {
    insecure = new Agent({ autoSelectFamily: false, connect: { rejectUnauthorized: false } });
    console.warn('[net-agent] ⚠️ 已启用「按源忽略 TLS 校验」dispatcher —— 仅对显式开启该开关的源生效（`D12`=A / `#428`）');
  }
  return insecure;
}

/** 测试专用：丢弃已建 insecure agent */
export function __resetInsecureTlsDispatcherForTest(): void {
  insecure = null;
}
