/**
 * `#820` B2 第一批：HTTP TTS 内核（配置 / 分段 / 请求构造 / 音频类型）。
 *
 * 这一层**只有纯逻辑**，不碰网络、不碰 Node 内置模块 —— 这样：
 *  · 服务端可以直接用（`apps/server/src/tts*.ts`）；
 *  · 将来的设置页/阅读页也能走 `@yuedu/core/tts` 深路径导入（类型与分段共用，避免第二份实现）。
 */
export * from './types';
export * from './config';
export * from './segment';
export * from './request';
export * from './audio';
