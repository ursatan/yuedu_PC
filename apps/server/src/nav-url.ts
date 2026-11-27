/**
 * `#731` **导航 URL 的唯一清洗入口**。
 *
 * 事故（用户 3000 日志，2026-11-02）：
 * ```
 * [verify] Page.navigate 返回错误：Cannot navigate to invalid URL
 *           · https___www.asianfanfics.com|`https://www.asianfanfics.com/browse?page=1`
 * [verify] 验证浏览器启动失败（81181ms …）：导航未完成（15s）：最终 url=(空)
 * ```
 * 根因：`hub.renderChallenge` 把**缓存键**（`${sourceId}|${url}`）当 URL 传给了 `antibotReplay`
 * ⇒ 服务端 `openVerification` / `render` 拿到的都是这个复合串 ⇒ Chromium 直接拒导航 ⇒
 * 窗口停在空白页（无标题），15s 后判「导航未完成」。
 *
 * 纪律：**日志可以带 sourceId，导航必须是纯 URL**。所有 `openVerification` / `navigate` /
 * `antibotPassPage` 的入参都先过这里，不允许各调用点各写一遍。
 *
 * 支持的输入形态：
 *  · 纯 URL：`https://a/b?x=1`（**即使 URL 自身含 `|` 也原样保留**）；
 *  · 复合键：`sourceKey|`https://a/b``（按**第一个** `|` 切分；反引号/引号/尖括号/空白剥掉）；
 *  · 非法输入：抛 `导航 URL 非法：<原串>` —— 绝不把非法串丢给 CDP（否则只剩一句英文报错）。
 */
export function normalizeNavUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  let s = raw;
  /**
   * 只有「不是纯 URL」时才按 `|` 切分：纯 URL 的 query 里合法地可以出现 `|`，
   * 不能为了兼容复合键而把正常 URL 切坏。
   */
  if (!/^https?:\/\//i.test(s)) {
    const pipe = s.indexOf('|');
    if (pipe >= 0) s = s.slice(pipe + 1).trim();
    s = s.replace(/^[`'"<]+/, '').replace(/[`'">]+$/, '').trim();
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`导航 URL 非法：${raw.slice(0, 160) || '(空)'}`);
  }
  try {
    const u = new URL(s);
    if (!u.hostname) throw new Error('empty host');
  } catch {
    throw new Error(`导航 URL 非法：${raw.slice(0, 160)}`);
  }
  return s;
}
