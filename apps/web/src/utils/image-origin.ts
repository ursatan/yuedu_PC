/**
 * `#702` **图片代理换一个 origin** —— 让「一页几十张慢图」不再**饿死心跳**。
 *
 * ## 病根（实测，不是推测）
 * 浏览器对**同一个 origin** 只开 **6 条 HTTP/1.1 连接**。而本应用的图片全部走
 * 同源的 `/api/proxy`（防盗链 + 源声明的解密规则，不能省）。漫画/图库一页几十张、
 * 又常常来自**同一个慢图床**（用户 2026-11-01 报的 `www.tkshuw.com`，每张 8~10s）——
 * 服务端那边还有按主机限并发的护栏（`hostSem=2`）⇒ 绝大多数请求**卡在服务端排队**，
 * **浏览器那 6 条同源连接却一直被占着**。
 *
 * 判据探针 `tmp/probe702-connstarve.mjs`（真浏览器 + 本地慢图床）：
 * ```
 * 空载            /api/engines = 155 ms
 * 6 张慢图在飞    /api/engines = 3384 ms   ← 排队等空闲连接
 * 2 张在飞        /api/engines =  20 ms
 * ```
 * 慢图床一旦慢到 8~10s、图又多，心跳（`PING_TIMEOUT_MS = 15s`）就会连失 3 次
 * ⇒ 侧栏「服务离线 · 764 源」（`server-sync.ts` 的 3 次 + 30s 双判据也拦不住）。
 *
 * ## 修法：把图片挪到**另一个 origin**（同一个服务进程、同一个端口，只是换个主机名）
 * `127.0.0.1` 与 `localhost` 在浏览器眼里是**两个 origin**（同源判定比的是 scheme+host+port），
 * 但指向的是同一台机器、同一个 Node 进程。于是：
 * · 图片用 `http://localhost:3000/api/proxy?…` ⇒ 吃 **另一组 6 条连接**；
 * · 页面/接口仍在 `http://127.0.0.1:3000` ⇒ 自己那 6 条**一条都不会被图片占**。
 * 服务端**零改动**（端口没变、路由没变、绑定地址没变），也不需要新开端口 —— 只是换个 host 名。
 *
 * ## 为什么必须**自检**
 * `localhost` 的解析不受我们控制（hosts 文件、IPv6 优先、公司 DNS 劫持都可能让它指到别处）。
 * 指错了就是「所有图片裂掉」，比误报离线严重得多。所以启动时先用服务端现成的一条通路
 * 真加载一张图（`/api/proxy?u=data:image/gif;base64,…`，纯本地解码、不碰外网），
 * **加载成功才启用**；失败/超时 ⇒ 整个特性静默关闭，回到原来的同源行为（零回归）。
 *
 * ## 什么时候不启用
 * · 页面不是 http(s)（`file://` 的桌面壳、`about:blank`）；
 * · 主机名既不是 `127.0.0.1` 也不是 `localhost`（局域网 IP 访问时 `localhost` 指的是**客户端**
 *   ⇒ 换过去只会全裂，保持同源）；
 * · 自检失败。
 */
import { setImageProxyOrigin } from './img';

/**
 * 自检用的 1×1 透明 GIF。
 * 走 `/api/proxy?u=data:image/…` 是因为这条通路**服务端就地解码**（见 `index.ts` 的
 * `data:image` 分支），不发任何外网请求 ⇒ 自检既快又不会因为图床抽风而误判。
 */
const SELF_CHECK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 真加载一次图片，成功 true；失败/超时 false（`<img>` 不受 CORS 约束，跨 origin 也能判） */
function canLoadImage(src: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const img = new Image();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = src;
  });
}

/**
 * 解析「图片代理应该用哪个 origin」并**落地**到 `imgSrc()`。返回实际启用的 origin（''=同源）。
 *
 * 幂等、可重复调用（探针与测试会多次调用）；失败一律静默回落，不抛。
 */
export async function resolveImageProxyOrigin(timeoutMs = 2500): Promise<string> {
  try {
    const { protocol, hostname, port } = window.location;
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    const alt = hostname === '127.0.0.1' ? 'localhost' : hostname === 'localhost' ? '127.0.0.1' : '';
    if (!alt) return '';
    const base = `${protocol}//${alt}${port ? `:${port}` : ''}`;
    const probeUrl = `${base}/api/proxy?u=${encodeURIComponent(SELF_CHECK_GIF)}`;
    const ok = await canLoadImage(probeUrl, timeoutMs);
    if (!ok) {
      setImageProxyOrigin('');
      return '';
    }
    setImageProxyOrigin(base);
    return base;
  } catch {
    setImageProxyOrigin('');
    return '';
  }
}
