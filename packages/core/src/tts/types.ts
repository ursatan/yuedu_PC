/**
 * `#820` **B2 第一批：HTTP TTS 的契约面**（服务端 + 引擎内核，不含 UI）。
 *
 * ## 为什么单独一套类型
 * 本仓的「源」是书源/订阅源，字段与 Legado 的 `BookSource` / `RssSource` 对齐；
 * TTS 在上游是**独立实体** `HttpTTS`（`BaseSource` 的兄弟），有自己的一份 JSON
 * （`name` / `url` / `contentType` / `header` / `jsLib` / `concurrentRate` / `loginUrl`）。
 * 硬塞进源契约会让源库/源表单被污染，所以单独一份 `TtsEngineConfig`。
 *
 * ## 默认关（用户 2026-11-06 拍板）
 *  · 全局开关 `TtsConfigFile.enabled` 缺省 **false**：没有用户显式打开之前，任何合成请求
 *    都被 `TTS_DISABLED` 拒绝（不预设可用状态）；
 *  · 单引擎 `enabled` 也缺省 **false**：新建/导入的引擎默认不参与朗读，用户要自己选；
 *  · 不内置任何引擎（发布包不带任何源规则，也不带任何 TTS 引擎）。
 *
 * ## 双音色（`#821`）
 * 一条引擎内两个音色槽：主槽 = 引擎顶层字段（与 Legado `HttpTTS` 同名），
 * 副槽 = `secondary`（字段与主槽同名，未填写的字段继承主槽）。
 *  · **默认关**：`TtsConfigFile.dualVoice` 缺省 false ⇒ 行为与单音色完全一致；
 *  · 开启后由 `activeVoice` 决定用哪个槽（`primary` / `secondary`）；
 *  · **副槽未配置**时，任何走副槽的路径都回退主槽（不报错、不静音）。
 * 切换粒度本轮只做「全局主/副」；按角色（旁白/对话）自动分流见 backlog。
 */

/** 各类上限（也是接口校验的唯一一份；路由/store 不重复写字面量） */
export const TTS_LIMITS = {
  /** 引擎名 */
  name: 64,
  /** url 模板（`@js:` 形态也走这个上限） */
  url: 4096,
  /** POST 体 */
  body: 8192,
  /** Legado TTS 的 `jsLib` 前导脚本 */
  jsLib: 50000,
  /** 自定义头条数 / 单值长度 */
  headers: 24,
  headerValue: 2000,
  /** `header` 原始串（JSON 或「K: V」逐行） */
  headerRaw: 8192,
  /** Legado `pauseDuration`（段间静音，毫秒） */
  pauseMax: 10000,
  /** Legado `loginUi`（登录表单 JSON） */
  loginUi: 8192,
  /** Legado `loginCheckJs`（响应后校验脚本） */
  loginCheckJs: 20000,
  /** 单次合成（= 一个朗读分段）的文本长度 */
  text: 5000,
  /** 分段接口的整段输入长度 */
  segmentInput: 30000,
  /** 单段目标字符数（句太长时才硬切） */
  segmentChars: 240,
  /** 分段结果条数（防「一次贴整本书」把界面打爆） */
  segments: 500,
  /** 单请求超时 */
  timeoutMin: 1000,
  timeoutMax: 60000,
  timeoutDefault: 15000,
  /** 合成的音频体积上限（单段；超过就是引擎配错） */
  audioBytes: 12 * 1024 * 1024,
} as const;

/** 音色槽：主槽（引擎顶层字段）/ 副槽（`secondary`） */
export type TtsVoiceSlot = 'primary' | 'secondary';

/**
 * 副音色槽（`#821`）。
 *
 * 字段与主槽**同名同义**（`url` / `contentType` / `header` / `jsLib` / `method` / `body` /
 * `headers` / `timeoutMs`）；未填写的字段在合成时继承主槽。
 * `name` 只是界面上的槽位名（如「旁白」「对话」），不参与请求。
 */
export interface TtsVoiceSlotConfig {
  /** 槽位显示名（可选，不参与请求） */
  name?: string;
  /** 请求地址模板；留空 ⇒ 沿用主槽 url */
  url?: string;
  contentType?: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  header?: string;
  jsLib?: string;
  timeoutMs?: number;
  /** 备注（界面展示；不参与请求） */
  remark?: string;
}

/**
 * 一条 TTS 引擎配置。
 *
 * 兼容面：`name` / `url` / `contentType` / `header` / `jsLib` / `loginUrl` / `concurrentRate`
 * 与 Legado `HttpTTS` 的 JSON 同名同义（可直接粘贴上游引擎 JSON）；
 * `method` / `body` / `headers` / `timeoutMs` / `remark` 是本仓扩展（HTTP 层更可控）。
 * `secondary` 是 `#821` 的副音色槽（默认不配置 ⇒ 单音色行为不变）。
 */
export interface TtsEngineConfig {
  /** 稳定 id（`tts-<hash>`；同 name+url 稳定，便于 UI 持久选择） */
  id: string;
  /** 显示名（用户自选引擎时看到的那一行） */
  name: string;
  /** **默认 false**：不预设可用状态 */
  enabled: boolean;
  /**
   * 请求地址模板。支持：
   *  · `{{speakText}}` / `{{speakSpeed}}` / `{{speakVolume}}`（Legado 绑定名）；
   *  · 任意 `{{表达式}}`（在受限沙箱里求值，见 `tts/js.ts`）；
   *  · `@js:` / `<js>` 形态（先求值脚本，再对结果做 `{{}}` 插值）；
   *  · `,{…}` 尾选项（Legado `UrlOption`：`method` / `headers` / `body`）。
   */
  url: string;
  /** 期望的音频类型；上游没给时用作回传类型（缺省 `audio/mpeg`） */
  contentType?: string;
  /** 缺省 GET（Legado 的 HttpTTS 也是 GET 为主） */
  method?: 'GET' | 'POST';
  /** POST 体（支持 `{{}}` 插值） */
  body?: string;
  /** 结构化请求头（优先于 `header`） */
  headers?: Record<string, string>;
  /** Legado 原始 `header` 串：JSON 对象或「Key: Value」逐行 */
  header?: string;
  /** Legado `jsLib`：`@js:`/`{{}}` 求值前注入的前导脚本（同一沙箱） */
  jsLib?: string;
  /** Legado `loginUrl`（**本轮只存不跑**：TTS 登录流程不在 B2 第一批范围） */
  loginUrl?: string;
  /** Legado `loginUi`（登录表单 JSON / v2 脚本；本批只存+校验，登录窗后续） */
  loginUi?: string;
  /**
   * Legado `loginCheckJs`：拿到响应后执行（受限沙箱）。
   * 返回**非空字符串** ⇒ 视为响应不合格，该串作为失败原因（典型用途：识别「需要登录」页）。
   */
  loginCheckJs?: string;
  /** Legado `pauseDuration`（0~10000ms）：段间静音；0/未设 ⇒ 用全局句间停顿 */
  pauseDuration?: number;
  /** Legado `enabledCookieJar`：该引擎的 Cookie 罐（默认 false） */
  enabledCookieJar?: boolean;
  /** Legado `concurrentRate`（`1/1500` = 每 1.5s 最多 1 次；`0`/空 = 不限） */
  concurrentRate?: string;
  /** 单请求超时（毫秒），缺省 15s */
  timeoutMs?: number;
  /** 备注（界面展示；不参与请求） */
  remark?: string;
  /** `#821` 副音色槽；缺省 ⇒ 视为没配副音色（走副槽时自动回退主槽） */
  secondary?: TtsVoiceSlotConfig;
  updatedAt?: number;
}

/** 落盘形态（`data/tts-engines.json`） */
export interface TtsConfigFile {
  /** **默认 false**：全局总开关 */
  enabled: boolean;
  /**
   * **默认 false**：双音色总开关。
   * false ⇒ 永远只用主音色（行为与 `#822` 单音色完全一致）；
   * true ⇒ 按 `activeVoice` 选槽，副槽缺失时自动回退主槽。
   */
  dualVoice: boolean;
  /** 双音色开启时朗读用哪个槽（默认 `primary`；另有「按角色分流」见 backlog） */
  activeVoice: TtsVoiceSlot;
  /** 用户选中的默认引擎 id（空 = 没选） */
  defaultEngineId: string;
  engines: TtsEngineConfig[];
}

/** 默认（= 什么都没配）——「默认关」的落点 */
export const EMPTY_TTS_CONFIG: TtsConfigFile = {
  enabled: false,
  dualVoice: false,
  activeVoice: 'primary',
  defaultEngineId: '',
  engines: [],
};

/** 失败码：**服务端与前端共用一份**（前端据 code 出文案，不靠 message 猜） */
export type TtsErrorCode =
  | 'TTS_DISABLED'
  | 'TTS_ENGINE_NOT_FOUND'
  | 'TTS_ENGINE_DISABLED'
  | 'TTS_CONFIG_INVALID'
  | 'TTS_TEXT_EMPTY'
  | 'TTS_TEXT_TOO_LONG'
  | 'TTS_JS_TIMEOUT'
  | 'TTS_JS_ERROR'
  | 'TTS_URL_INVALID'
  | 'TTS_HTTP_TIMEOUT'
  | 'TTS_HTTP_ERROR'
  | 'TTS_HTTP_STATUS'
  | 'TTS_CONTENT_TYPE'
  | 'TTS_EMPTY_AUDIO'
  // `#873` `loginCheckJs` 判定响应不合格（返回了非空字符串作为原因）
  | 'TTS_LOGIN_CHECK';

/** 配置校验失败码（`normalizeTtsEngine` 的 `error`，与请求失败码分开） */
export type TtsConfigError =
  | 'NAME_REQUIRED'
  | 'NAME_TOO_LONG'
  | 'URL_REQUIRED'
  | 'URL_TOO_LONG'
  | 'URL_INVALID'
  | 'CONTENT_TYPE_INVALID'
  | 'METHOD_INVALID'
  | 'BODY_TOO_LONG'
  | 'JS_LIB_TOO_LONG'
  | 'HEADER_INVALID'
  | 'HEADER_TOO_LARGE'
  | 'TIMEOUT_INVALID'
  | 'ID_INVALID'
  // `#873` 对齐上游 HttpTTS 的新增字段
  | 'PAUSE_INVALID'
  | 'LOGIN_UI_INVALID'
  | 'LOGIN_UI_TOO_LARGE'
  | 'LOGIN_CHECK_JS_TOO_LARGE'
  | 'CONCURRENT_RATE_INVALID'
  // `#821` 副音色槽（消息里统一带「副音色」前缀，便于界面直接显示）
  | 'VOICE2_INVALID'
  | 'VOICE2_NAME_TOO_LONG'
  | 'VOICE2_URL_TOO_LONG'
  | 'VOICE2_URL_INVALID'
  | 'VOICE2_CONTENT_TYPE_INVALID'
  | 'VOICE2_METHOD_INVALID'
  | 'VOICE2_BODY_TOO_LONG'
  | 'VOICE2_JS_LIB_TOO_LONG'
  | 'VOICE2_HEADER_INVALID'
  | 'VOICE2_HEADER_TOO_LARGE'
  | 'VOICE2_TIMEOUT_INVALID'
  // `#821` 设置面：`activeVoice` 只接受 primary/secondary
  | 'VOICE_SLOT_INVALID';

/** 一条校验结果 */
export type TtsValidation =
  | { ok: true; engine: TtsEngineConfig }
  | { ok: false; error: TtsConfigError; message: string };

/** `@js:` 求值器的返回。宿主（server）实现，core 只消费 */
export type TtsJsResult =
  | { ok: true; value: string }
  | { ok: false; code: 'TTS_JS_TIMEOUT' | 'TTS_JS_ERROR'; message: string };

/** `@js:` 求值器：受限沙箱，**不得**暴露网络/文件/进程（见 `apps/server/src/tts-js.ts`） */
export type TtsJsEvaluator = (code: string, bindings: Record<string, unknown>) => TtsJsResult;
