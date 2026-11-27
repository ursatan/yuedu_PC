import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';

/**
 * 产品版本号取**桌面端 package.json**（发布包就是用它打的），构建时注入成
 * `__APP_VERSION__` —— 「设置 · 关于」显示它，避免界面里再写一份会漂移的常量。
 *
 * 发版规则（2026-11-27 起）：`1` + `0` + YYMMDD + 两位序号，如 `1.0.26112701`
 * （本身即三段式 semver，package.json / 界面 / release 名完全一致，不做任何改写）。
 */
const APP_VERSION = (JSON.parse(
  readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'),
) as { version: string }).version;

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  build: { outDir: 'dist', emptyOutDir: true },
  // 开发时把 /api 代理到 Fastify，避免跨端口 CORS 问题
  server: {
    // ⚠️ `host: true` 不是随便加的：不写的话 vite 只绑IPv6 `[::1]`，
    // 浏览器把 localhost 解析成 127.0.0.1 时就连不上（实测netstat 只看得到 `[::1]:5173`）。
    host: true,
    port: 5173,
    strictPort: true,   // 5173 被占就直接报错，别静默换端口（换了你开错页面还以为没生效）
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
