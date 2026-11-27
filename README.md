# yuedu_PC

插件式解析引擎集合（TypeScript，Node ≥ 22）：兼容 **Legado 书源** / **AppleCMS（maccms）** / **RSS**，
提供 Web + Server + Electron 桌面端。pnpm workspace monorepo，核心包 `@yuedu/core`。

> ⚠️ **本仓库不携带任何源**。书源 / 漫画源 / 影视源 / RSS 订阅源的规则文件（含
> `data/seed/`、`data/jslib-mirror/`）都不入库，由使用者自行导入或新建。详见 [NOTICE.md](./NOTICE.md)。

## Clone 后如何自行构建

仓库里**不提交**构建产物（`dist/`、`apps/desktop/server-bundle.mjs`、`apps/desktop/release-*/` 等），
克隆后请按下面三步在本地生成：

```bash
# 1) 安装依赖（Node ≥ 22）
pnpm i

# 2) 构建服务端 bundle（生成 apps/desktop/server-bundle.mjs 等）
node apps/desktop/build-server.mjs

# 3) 构建 Web 前端（生成 apps/web/dist）
pnpm --filter @yuedu/web build
```

### 本地开发

```bash
# 开发模式跑 Web（Vite 5173，代理到 3000）
pnpm --filter @yuedu/web dev

# 直接起服务端（默认 3000）
pnpm --filter @yuedu/server start
```

### 桌面端打包（可选）

```bash
pnpm --filter @yuedu/desktop dist   # 绿色 zip（唯一发布产物；YueDu.exe 加 --server-only 即服务端形态）
```

## 校验

```bash
pnpm -r typecheck   # 全仓类型检查
pnpm -r test        # 各包测试
pnpm check:docs     # 文档体检
```

> 回归语料（`data/seed/bookSource.json` / `rssSource.json`）不入库；本机缺失时相关语料用例会自动跳过。

## 协议

GPL-3.0-only，见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
