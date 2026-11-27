# yuedu_PC

插件式解析引擎集合（TypeScript，Node ≥ 22）：兼容 **Legado 书源** / **AppleCMS（maccms）** / **RSS**，
提供 Web + Server + Electron 桌面端。pnpm workspace monorepo，核心包 `@yuedu/core`。

> ⚠️ **本仓库与发布包都不携带任何源**。书源 / 漫画源 / 影视源 / RSS 的规则文件（含 `data/seed/`、
> `data/jslib-mirror/`）均不入库，需要自行导入或新建；源库 `data/yuedu.db` 首次启动自动创建，
> 空库时源列表为空、应用照常运行。请只导入你**拥有使用授权**的源。详见 [NOTICE.md](./NOTICE.md)。

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

## 合法合规

本项目**仅用于个人学习与研究**。请遵守所在国家 / 地区的法律法规，以及目标站点的服务条款与
`robots` 约定；不得用于侵权、盗版内容的批量获取或商业分发。源规则与抓取内容的版权归原站点
及原作者所有，本项目不对其主张任何权利；导入何种源、如何使用抓取结果，由使用者自行决定并
承担全部责任。详见 [NOTICE.md](./NOTICE.md)。

## 协议

GPL-3.0-only，见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
