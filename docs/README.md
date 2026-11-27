# 悦读（YueDu）· 文档

[项目首页](../README.md) ｜ [问题反馈](https://github.com/ursatan/yuedu_PC/issues) ｜ [许可证](../LICENSE) ｜ [NOTICE](../NOTICE.md)

## 这是什么

悦读是一个本地优先的阅读平台：桌面端（Electron）提供阅读器与书架，服务端（Fastify）负责源解析、缓存、备份与进度同步。支持 Legado 书源 / RSS 源 / CMS 接口，提供阅读、听书、漫画、仿真翻页等能力。

本仓库**不附带任何内置书源或 CMS 源规则**，所有源由使用者自行导入或新建。

## 安装（使用发布包）

从 [Releases](https://github.com/ursatan/yuedu_PC/releases) 下载绿色 zip，解压后直接运行：

| 入口 | 形态 |
|-|-|
| `YueDu.exe` | PC 客户端（启动后自带服务端，端口 3100） |
| `YueDu.exe --server-only` | 服务端形态（服务 + 托盘，端口 3000，无主窗口） |

首次运行会在桌面创建「悦读」「悦读服务」两个快捷方式。无需安装，删除目录即卸载。

## 从源码构建

要求 Node.js ≥ 22、pnpm，以及 Windows 10/11（构建桌面端需要 Windows）。

```bash
pnpm install
pnpm --filter @yuedu/web build        # 前端产物
node apps/desktop/build-server.mjs    # 服务端单文件 bundle
pnpm --filter @yuedu/desktop dist     # 绿色 zip（输出到 apps/desktop/release-*/）
```

开发调试：`pnpm --filter @yuedu/desktop start`；只起服务端可用仓库根的 `start-server.bat`（开发兜底，无托盘）。

## 目录结构

| 路径 | 说明 |
|-|-|
| `apps/desktop` | Electron 桌面壳（单份 `YueDu.exe`，`--server-only` 即服务端） |
| `apps/server` | Fastify 服务端 |
| `apps/web` | Vue 3 前端（阅读器、书架、设置、检修工坊） |
| `packages/core`、`packages/engine-*` | 核心模型与各类源引擎 |
| `scripts` | 构建与校验脚本 |

## 提问与反馈

- Bug 与功能建议：[GitHub Issues](https://github.com/ursatan/yuedu_PC/issues)
- 安全或版权问题：请勿在公开区贴出受版权保护的书籍内容、站点凭据或 Cookie

> 开发过程记录、归档与内部设计文档不随公开仓库分发。
