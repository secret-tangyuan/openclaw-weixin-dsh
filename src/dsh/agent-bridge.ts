/**
 * 微信联系人 ↔ DSH Agent 会话 的桥接层。
 *
 * 职责：
 * - 确定性映射：账号 + 联系人 → DSH SessionId（`wx-<acct>-<user>`，sanitize 后）；
 * - 入站文本 → 构造 UserMessage → `agent.followup()` → `await agent.whenIdle()`；
 * - 从会话日志读取最后一条 `assistant/message` 的文本块（注意 SessionEvent 的
 *   payload 在 `data` 字段下：`event.data.message.content`）；
 * - 上下文延续：微信 `context_token` 按 (account, user) 缓存并回传。
 *
 * 不持有任何 OpenClaw 依赖；只依赖 DSH 服务：`agents`、`sessionQuery`。
 */
import type { AgentLike, AgentsService, UserMessageLike } from './services.js'

export interface AccountRecord {
  id: string
  label: string
  status: 'online' | 'offline'
  addedAt: number
  /** 宿主侧机密，绝不出现在 RPC 返回中。 */
  token?: string
  baseUrl?: string
  userId?: string
}

export interface BridgeDeps {
  agents: AgentsService
  sessionQuery: {
    readSession(sessionId: string): Promise<{ events: Array<{ type: string; data: unknown }> } | undefined>
  }
  log(level: 'info' | 'warn' | 'error', msg: string): void
  allow(userId: string): boolean
  /** 未放行联系人入 pending 队列（一次性登记）。 */
  recordPending?(userId: string, text: string): void
}

export function sanitizeSessionSegment(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

export function sessionIdFor(accountId: string | null, userId: string): string {
  return `wx-${sanitizeSessionSegment(accountId ?? 'sim')}-${sanitizeSessionSegment(userId)}`
}

function makeMessageId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 从会话日志提取最后一条 assistant 文本（已按 data 嵌套修正）。 */
export async function readLastAssistantText(deps: BridgeDeps, sessionId: string): Promise<string> {
  try {
    const snap = await deps.sessionQuery.readSession(sessionId)
    const events = snap?.events ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type !== 'assistant/message') continue
      const message = (e.data as { message?: { content?: Array<{ type?: string; text?: string }> } })?.message
      const blocks = (message?.content ?? []).filter((b) => b?.type === 'text' && b.text)
      if (blocks.length > 0) return blocks.map((b) => b.text ?? '').join('\n')
    }
    return ''
  } catch (err) {
    deps.log('warn', `readLastAssistantText failed: ${String((err as Error)?.message ?? err)}`)
    return ''
  }
}

export interface InboundResult {
  ok: boolean
  blocked?: boolean
  reply: string | null
  sessionId: string | null
  ms?: number
  error?: string
}

/**
 * 处理一条入站微信文本消息：创建/复用 DSH Agent，投递消息，等待回复。
 * 返回回复文本（发信由调用方决定，便于区分真实发送与模拟）。
 */
export async function processInboundText(
  deps: BridgeDeps,
  opts: { accountId: string | null; userId: string; text: string; agentPreset: string },
): Promise<InboundResult> {
  const { accountId, userId, text, agentPreset } = opts
  if (!deps.allow(userId)) {
    deps.log('warn', `blocked (not allowlisted): ${userId}`)
    deps.recordPending?.(userId, text)
    return { ok: false, blocked: true, reply: null, sessionId: null }
  }
  const sessionId = sessionIdFor(accountId, userId)
  const started = Date.now()
  try {
    const agent = await deps.agents.ensure(sessionId, agentPreset)
    if (!agent) return { ok: false, error: 'agent unavailable', reply: null, sessionId }
    const message: UserMessageLike = {
      id: makeMessageId('wx'),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
    agent.followup(message)
    await agent.whenIdle()
    const reply = await readLastAssistantText(deps, sessionId)
    deps.log('info', `inbound ${userId} -> reply (${Date.now() - started}ms, ${reply.length} chars)`)
    return { ok: true, reply, sessionId, ms: Date.now() - started }
  } catch (err) {
    deps.log('error', `processInbound failed: ${String((err as Error)?.message ?? err)}`)
    return { ok: false, error: String((err as Error)?.message ?? err), reply: null, sessionId }
  }
}
