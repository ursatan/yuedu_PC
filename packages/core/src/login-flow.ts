/**
 * `#315`：登录**执行流程**的共享件（上游 `BaseSource.login()` 主体，书源/订阅源共用一条）。
 *
 * 为什么下沉：与 `#314` 同理 —— 上游 BookSource 与 RssSource 继承同一个 `BaseSource`，
 * `login()` 的骨架（形态早退 → 表单闸门 → 拼 `login()` 脚本 → 跑 → 落盘 → 判 ok）只有一份；
 * 本仓两个引擎此前各写一遍，错误消息与判据已经在悄悄漂移（例如「该源 / 该订阅源」措辞、
 * `needBrowser` 正则抄了三处）。判据写两处必然漂移（`#247`）⇒ 骨架判据**只留一份**，
 * 引擎只保留各自真正不同的部分（legado：LoginUiV2 / 登录头 / `__browserUrl` 通路；rss：`prepare` / toastSink）。
 *
 * 边界（有意**不下沉**的部分）：
 * · v1 结尾的「ok 判据」两引擎语义确有差异（legado 比对 loadLoginHeader 快照、rss 直接比
 *   `__loginHeader` 变量与 cookie 串），强行统一 = 制造第二份真相源，留各自实现；
 * · LoginUiV2 流程只有 legado 有（rss 语料 0 例，rss 侧直接「暂不支持」告警）。
 */
import type { LoginField, LoginPlan } from './login-model';
import type { UnifiedLoginResult } from './contract/types';

/**
 * `#423` **「只渲染登录界面」的伪动作**（用户报 18AV「登录界面表单仍然未正确加载」）。
 *
 * ## 为什么需要它
 * `loginUi` 是 `@js:`/`<js>` 脚本的源，行数组要**求值脚本**才拿得到（`classifyLoginUrl` 只看
 * 静态数组 ⇒ 给不出 `fields`）。打开登录对话框走的是 `GET /api/sources/:id/login`（**只读**），
 * 它此前只返回空的 `uiFields` + `uiIsScript=true` ⇒ 前端只显示一句「该源登录界面由脚本动态生成，
 * 直接点『登录』执行」⇒ **用户看到的是空表单**；必须手动点一次「登录」才出现行
 * （上游 Legado 是**打开即渲染**）。
 *
 * 为什么不直接调 `hub.login(id)`（不带 action）：那会走 `loginFormGate` —— 只在「有表单字段且
 * **没有**已存登录信息」时早退；用户之前登录过（有 loginInfo）时闸门放行 ⇒ **GET 会真的执行
 * `login()` 脚本**（发请求/写状态）。读接口不许有副作用。
 *
 * ⇒ 定一个显式伪动作：引擎收到它只做「求值 `loginUi` + 返回行」这一件事，早退在一切脚本之前。
 * 值刻意长且不可能是源作者给按钮起的 action 名。
 */
export const LOGIN_UI_RENDER_ACTION = '__yuedu_render_login_ui__';

/**
 * 错误消息是否指向「脚本调用了 WebView/浏览器交互 API」（⇒ 需桌面端 + 人工操作）。
 * ⚠️ 只看**错误本身**：此前曾按「脚本里出现过 startBrowser」判定 → 七猫那种（startBrowser
 * 只在无关函数里、真正报错是 `this.setcsh is not a function`）被误报成「依赖浏览器」。
 */
export function needBrowserFromError(msg: string): boolean {
  /**
   * `#727` **验证码通道的超时/取消不算「需要浏览器」**。
   *
   * 这两条发生时浏览器已经拉起过（chrome 起不来/用户关窗/60s 没输入），再走「打开登录窗」
   * 只会让用户白等一轮；而且错误文案里带 `getVerificationCode` 会被下面的正则命中。
   * L1 同步通道的「无法等待人工输入」**要**留在 needBrowser 里（那条确实需要换浏览器通道）。
   */
  if (/验证码超时|验证码输入已取消|验证码窗口/.test(msg)) return false;
  return /startBrowser|startBrowserAwait|webView|WebView|getVerificationCode|openVideoPlayer/i.test(msg);
}

/** 错误消息是否指向「脚本引用了本环境未提供的函数」（源作者依赖自定义函数 ⇒ 脚本可能已失效） */
export function notAFunctionFromError(msg: string): boolean {
  return /is not a function|undefined is not|not implemented/i.test(msg);
}

/**
 * 拼登录脚本（Legado `BaseSource.login`：按钮点击跑 `loginJs + action`；
 * 「确定」跑 `loginJs + login.apply(this)`，没有 login 函数则按上游报
 * `Function login not implements!!!`）。
 */
export function buildLoginScript(planJs: string, loginAction: string): string {
  return loginAction
    ? `${planJs}\n${loginAction}`
    : `${planJs}\nif (typeof login === 'function') { login.apply(this); } else { throw new Error('Function login not implements!!!'); }`;
}

/**
 * 形态早退：`none` / `url` / `config-url` 三种形态在跑任何脚本之前就能定结果。
 * 返回 null = 形态是 `js`/`ui`，继续走引擎各自的执行流程。
 * @param noun 名词（「源」/「订阅源」），仅用于 none 形态的提示文案。
 */
export function loginPlanEarlyResult(plan: LoginPlan, noun: string): UnifiedLoginResult | null {
  if (plan.kind === 'none') {
    return {
      ok: false,
      action: 'none',
      message: `该${noun}未配置登录（loginUrl / loginUi 都为空）`,
    };
  }
  if (plan.kind === 'url' || plan.kind === 'config-url') {
    return {
      ok: false,
      action: 'browser',
      url: plan.url,
      /**
       * `#393` 登录页型的目的就是**把登录 Cookie 带回引擎** ⇒ 只能是 `cookie`。
       * 别把它降级成应用内 iframe —— 跨域站点的 cookie 落在浏览器里，服务端引擎读不到。
       */
      browserKind: 'cookie',
      message: '该源用登录页登录：打开登录页完成人工/安全验证后，Cookie 会自动保存',
    };
  }
  return null;
}

/**
 * 表单闸门：有 text/password 行、还没填过登录信息、且本次不是按钮动作
 * ⇒ 先把表单回给前端（Legado：getLoginData 为空则落回登录 UI；不先给表单直接跑 login()
 * ⇒ 脚本拿不到输入）。⚠️ 必须带 `fields` 回前端，否则对话框是空的（`#347` 用户实测症状）。
 * 返回 null = 闸门通过，继续执行脚本。
 */
export function loginFormGate(
  fields: LoginField[],
  opts: { loginAction: string; hasLoginInfo: boolean },
): UnifiedLoginResult | null {
  const formFields = fields.filter((f) => f.type === 'text' || f.type === 'password');
  if (formFields.length && !opts.loginAction && !opts.hasLoginInfo) {
    return { ok: false, action: 'form', fields, message: '请先填写登录信息再登录' };
  }
  return null;
}
