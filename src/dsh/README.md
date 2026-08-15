# openclaw-weixin × DeepSeek Harness 适配层（src/dsh/）

本目录把 openclaw-weixin 的微信领域核心（iLink 协议、扫码登录、CDN、媒体、
monitor 长轮询、context_token 管理）桥接到 DeepSeek Harness（DSH），
使微信消息由 DSH 的 Agent/Session 处理并回复，同时在 DSH 的 **设置** 中
提供独立的 **微信控制面板**。

## 设计原则

- **双入口**：`index.ts`（OpenClaw 插件入口）原样保留；本目录是 DSH 侧的新入口。
  微信领域逻辑（`src/api`、`src/cdn`、`src/media`、`src/auth/login-qr.ts`、
  `src/monitor/monitor.ts`、`src/messaging/` 大部分）尽量复用，仅替换
  OpenClaw 通道契约层（`src/channel.ts`、`src/compat.ts`、`src/auth/pairing.ts` 等）。
- **概念映射**：

  | OpenClaw 概念 | DSH 映射 |
  |---|---|
  | channel plugin contract | Cordis Host 插件 + 包私有 RPC（`harness.handle` ↔ `host.call`）+ 事件 |
  | OpenClaw config / `openclaw.json` | `settings` 服务命名空间（`weixin`） |
  | `~/.openclaw` 状态目录 | DSH 状态目录 / `storageDomain` |
  | pairing / allowlist | 插件内白名单（settings 持久化 + 面板审批） |
  | OpenClaw agent 路由（routing/resolveAgentRoute） | `agents.create({sessionId, meta:{agentPreset}})` + `agent.followup()` + `agent.whenIdle()` |
  | reply dispatch | `sessionQuery.readSession()` 读 `assistant/message` 事件 → `sendmessage` |
  | 设置页 | `settings.section` 槽位注册（id: `weixin`） |

## 模块划分

- `config.ts` — `weixin` 设置命名空间（zod schema + 默认值）。
- `http.ts` — 原生 `fetch` 的 iLink HTTP 客户端（`src/api/api.ts` 的 DSH 版，
  去掉 OpenClaw 依赖：botAgent/routeTag 来自配置而非 accounts 模块）。
- `agent-bridge.ts` — 微信联系人 ↔ DSH SessionId 确定性映射；
  入站文本 → `agents.create`/`followup` → `whenIdle` → 读回复。
- `monitor.ts` — 每账号 `getupdates` 长轮询循环（同步游标、错误退避、
  stale-token(-14) 暂停），消息归一化后交 `agent-bridge`。
- `plugin.ts` — Cordis Host 插件：注册服务/事件/RPC/工具/设置命名空间，
  生命周期清理（monitor 停止、agent dispose、disposer 回收）。
- `client.tsx` — Client 插件：`settings.section` 控制面板
  （账号+扫码登录、监控启停、Agent 路由、白名单、消息日志、配置）。

## 运行时差异（与原型动态插件相比）

| 项 | 动态插件原型 | fork 落库版 |
|---|---|---|
| 出站 HTTP | `shell`+`curl`（因无 fetch 内建） | 原生 `fetch`（Node 环境） |
| 二维码渲染 | 外部 QR 服务转 base64 | 本地 `qrcode` 库生成 data URL |
| 配置持久化 | 内存 | `settings` 命名空间（settings.yaml） |
| 账号/token 存储 | 内存 | DSH 状态目录（权限收紧，不落入会话） |
| 运行载体 | 每会话动态插件 | Host 组合（`cordis.patch.yml` 行 / profile bundle） |

## 装载（M6 交付）

见仓库根 `README.zh_CN.md` 新增的「DeepSeek Harness 集成」章节与
`docs/dsh.md`。
