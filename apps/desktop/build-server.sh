#!/bin/sh
# 打包 server 为单文件 ESM（供桌面端内嵌启动）。
# - electron 外置；jsdom 完全内联 + patch-bundle.mjs 后置补丁（css/patch.json 内联）→ 零外部文件依赖
cd "$(dirname "$0")/../.." || exit 1
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild \
  apps/server/src/index.ts \
  --bundle --platform=node --format=esm \
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=apps/desktop/server-bundle.mjs \
  --external:electron || exit 1
# esbuild CJS/ESM 输出中 import.meta 转成空对象 → 注入 url
sed -i 's|import_meta\([0-9]*\) = { }|import_meta\1 = { url: require("node:url").pathToFileURL(__filename).href }|g; s|import_meta\([0-9]*\) = {};|import_meta\1 = { url: require("node:url").pathToFileURL(__filename).href };|g' \
  apps/desktop/server-bundle.mjs
# css-tree patch.json 置于 bundle 相对位置（补丁脚本读取并内联）
mkdir -p apps/desktop/data
cp -f node_modules/.pnpm/css-tree@3.2.1/node_modules/css-tree/data/patch.json apps/desktop/data/patch.json
# jsdom 的 xhr-sync-worker（相对 require，bundle 同目录解析）
# ⚠️ 不要写死 `.pnpm/jsdom@<版本>/`：pnpm 的目录名可能带 peer 后缀
#    （本机实际为 `jsdom@30.0.1_@noble+hashes@2.4.0`），写死会**静默** cp 失败
#    （本脚本没有 set -e），于是 apps/desktop 下留着一份**过期**的 worker 副本。
#    改为让 node 解析真实路径，并把失败显式说出来。
JSDOM_XHR="$(node -e "console.log(require.resolve('jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js'))" 2>/dev/null || true)"
if [ -n "$JSDOM_XHR" ]; then
  cp -f "$JSDOM_XHR" apps/desktop/xhr-sync-worker.js
else
  echo "[build] warn: 未找到 jsdom 的 xhr-sync-worker.js（仅同步 XHR 用；bundle 其余功能不受影响）"
fi
node apps/desktop/patch-bundle.mjs
