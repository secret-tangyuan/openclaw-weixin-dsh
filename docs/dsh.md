# openclaw-weixin × DeepSeek Harness 集成

本分支在保留 OpenClaw 插件入口（`index.ts`）的同时，提供 DSH 侧适配层
（`src/dsh/`），并附带 DSH 设置中的「微信 (WeChat)」控制面板。

## 架构

```
微信手机端 ──iLink HTTP(long-poll)──▶ src/dsh/http.ts（原生 fetch 客户端）
                                        │
                                        ▼
        src/dsh/monitor.ts（每账号 getupdates 长轮询：游标/退避/stale-token）
                                        │  入站消息 + context_token
                                        ▼
        src/dsh/agent-bridge.ts（联系人 ↔ DSH SessionId 映射；
        agents.create + followup + whenIdle + readSession 读回复）
                                        │  回复文本
                                        ▼
        sendmessage 回发 + 控制面板展示
```

## 组件

| 文件 | 职责 |
|---|---|
| `config.ts` | `weixin` 设置命名空间（zod schema，settings.yaml 持久化） |
| `http.ts` | iLink HTTP 客户端（原生 fetch；botAgent 来自配置；含 getUploadUrl/sendTyping） |
| `media.ts` | 媒体发送：CDN 上传（AES-128-ECB 加密）+ 媒体消息发送 |
| `agent-bridge.ts` | 微信→DSH Agent 桥接（含 `event.data.message` 读取） |
| `monitor.ts` | 每账号长轮询循环 |
| `plugin.ts` | Host Cordis 插件：settings / RPC（`wx/*`）/ monitor 生命周期 / 事件 / 清理 |
| `client.tsx` | Client 插件：`settings.section` 控制面板 |

## RPC 契约（Host ↔ 面板）

| method | 说明 |
|---|---|
| `wx/snapshot` | 面板全量视图（不含 token 等机密） |
| `wx/config/set` | 更新 `weixin` 设置命名空间 |
| `wx/login/start` / `wx/login/qr` / `wx/login/poll` / `wx/login/verify` / `wx/login/cancel` | 扫码登录闭环 |
| `wx/accounts/logout` | 登出账号（同时停 monitor） |
| `wx/monitor/start` / `wx/monitor/stop` | 单账号长轮询启停 |
| `wx/allowlist/approve` / `wx/allowlist/deny` / `wx/allowlist/remove` | 白名单审批（pending 队列）/ 移除 |
| `wx/agent/test` / `wx/inbound/simulate` | 消息闭环测试（不经真实微信） |
| `wx/test/ilink` | iLink 连通性探测 |

## 装载（DSH 部署侧）

1. 构建 DSH 侧：`npm run build:dsh`（产物 `dist-dsh/`），类型检查 `npm run typecheck:dsh`。
2. 安装本包到 DSH 部署（`@deepseek-ai/dsh-session`、`cordis`、`react` 等为 optional peer）。
3. 在 Host 组合（profile 的 `cordis.patch.yml` / bundle 列表）加入插件行：
   id `openclaw-weixin-dsh`，入口指向包的 `./dsh` 导出（`dist-dsh/src/dsh/plugin.js`）。
4. 重启 DSH Web；设置 → 微信 (WeChat) 出现控制面板。
5. 面板内「扫码登录」→ 手机微信扫码 → 账号上线 → 「启动监控」。

## Client 接线（真实包，M6 收尾）

`src/dsh/client.tsx` 目前是从动态插件原型移植的参考实现（`host.call('wx/*')`）。
作为真实 DSH 包装载时改为标准接线：

- Host：把 `wx/*` 方法注册为 `TypertRemoteService`（`@Remote('snapshot')` 等，
  参考 `@deepseek-ai/dsh-message-feedback/remote`），包内导出 `/remote` 子路径；
- Client：`ClientContext` + `connection.api.weixin.*`，`inject: ['slots', 'connection']`；
- package.json 增加 `dsh.client` 元数据（platform: "web"）。

## 安全边界

- 登录 token 持久化在宿主侧 `<workspaceRoot>/.dsh-weixin/state.json`
  （含账号、context_token、白名单），不进入 RPC/前端；请确保该目录权限受控。
- 新联系人默认需白名单（`autoApprove=false` 时面板审批）。
- iLink 协议为腾讯私有，请遵守微信平台规范。
- 原型阶段（动态插件）出站 HTTP 走 shell+curl；如宿主无沙箱后端，须显式传
  `sandboxPolicy: { mode: 'danger-full-access' }`（受限模式会直接拒绝）。
  落库版用原生 fetch，无此问题。

## 与 OpenClaw 入口的关系

`index.ts`、`src/channel.ts` 等 OpenClaw 契约文件保持原样；`src/dsh/*`
不依赖 `openclaw/plugin-sdk/*`，仅依赖 DSH 服务（`settings`/`agents`/
`sessionQuery`/`timer`）与 Node 原生能力。`package.json` 新增 `exports`、
`build:dsh`/`typecheck:dsh` 脚本与 optional peer 依赖，均不影响 OpenClaw 装载。
