/**
 * 兼容壳（`#314`）：`loginUrl` 形态识别已**下沉**到 `@yuedu/core` 的 `login-model.ts`。
 *
 * 为什么下沉：这条判据在上游是 `BaseSource.getLoginJs()` —— **BookSource 与 RssSource 共用**
 * （`RssSource.kt:40-44` 继承 loginUrl/loginUi/loginCheckJs）。此前它只存在于 legado 包内，
 * rss 引擎要用就只能「再抄一份」或「反向依赖 legado 包」⇒ 两个引擎的登录判定迟早漂移。
 *
 * 本文件保留为**具名再导出**（而不是删掉），让 `./model/login` 这条既有 import 路径继续有效；
 * 新代码直接从 `@yuedu/core` 引用。
 */
export { classifyLoginUrl, extractInlineJs, normalizeLoginField, parseLoginUiText } from '@yuedu/core';
export type { LoginKind, LoginPlan, LoginField } from '@yuedu/core';
