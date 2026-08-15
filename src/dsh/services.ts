/**
 * 桥接层依赖的 DSH 服务最小类型契约（host 插件在 apply 里从 ctx.get 取）。
 * 不引入 dsh 包的重型类型，避免 fork 的 peer 依赖扩散；运行时形状与
 * DSH 的 agents 服务 / session 事件一致。
 */
export interface AgentLike {
  followup(message: UserMessageLike): void
  whenIdle(): Promise<void>
}

/** 与 @deepseek-ai/dsh-llm 的 UserMessage 运行时形状一致的最小类型。 */
export interface UserMessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' | 'plugin'; plugin?: string }
}

/** agents 服务的封装面：按 sessionId 取或建一个可用的 Agent。 */
export interface AgentsService {
  ensure(sessionId: string, agentPreset: string): Promise<AgentLike | null>
}
