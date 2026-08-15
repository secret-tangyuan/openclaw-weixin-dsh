/**
 * DSH Host 半：weixin 桥接 Cordis 插件。
 *
 * 注册：
 * - 设置命名空间 `weixin`（settings 服务，持久化到 settings.yaml）；
 * - 包私有 RPC（harness.handle ↔ 面板 host.call）：snapshot / config /
 *   login.* / monitor.* / accounts.* / agent.test / inbound.simulate；
 * - 每账号 monitor 长轮询生命周期；
 * - 事件：weixin/status、weixin/message（供其他宿主插件与面板观察）。
 *
 * 生命周期：ctx.effect 注册清理（stop/update 时停止 monitor、释放 agent、
 * 注销 RPC）。
 */
import { z } from 'zod'
import { WEIXIN_SETTINGS_NAMESPACE, WeixinSettingsSchema, type WeixinSettings } from './config.js'
import { fetchBotQrcode, pollQrStatus } from './http.js'
import { processInboundText, readLastAssistantText, type AccountRecord } from './agent-bridge.js'
import { monitorLoop, type MonitorHandle } from './monitor.js'

const QR_TTL_MS = 5 * 60 * 1000
const MAX_QR_REFRESH = 3
const CHANNEL_VERSION = '1.0.0'

interface ActiveLogin {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  status: string
  startedAt: number
  qrRefreshCount: number
  currentBaseUrl: string
  pendingVerifyCode?: string
}

export interface WeixinBridgeState {
  accounts: AccountRecord[]
  activeLogin: ActiveLogin | null
  contextTokens: Record<string, string>
  allowlist: Record<string, boolean>
  pending: Record<string, { firstSeen: number; lastText: string }>
  monitors: Record<string, MonitorHandle>
  agentCache: Record<string, { agent: unknown; dispose: () => void }>
  log: Array<{ t: number; level: string; msg: string }>
}

export default {
  name: 'openclaw-weixin-dsh',
  apply(ctx: any) {
    const state: WeixinBridgeState = {
      accounts: [],
      activeLogin: null,
      contextTokens: {},
      allowlist: {},
      pending: {},
      monitors: {},
      agentCache: {},
      log: [],
    }
    const LOG_CAP = 400

    const pushLog = (level: 'info' | 'warn' | 'error', msg: string) => {
      state.log.push({ t: Date.now(), level, msg })
      if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP)
    }
    pushLog('info', 'weixin bridge loaded')

    // ---- 登录/白名单/context_token 持久化（fs 服务，workspaceRoot/.dsh-weixin/state.json）----
    const stateFilePath = (): string => {
      const sp = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined
      return `${sp?.workspaceRoot ?? ''}/.dsh-weixin/state.json`
    }
    const persistState = async (): Promise<void> => {
      const fs = ctx.get('fs') as { resolve: (p: string) => Promise<unknown>; writeText: (t: unknown, c: string) => Promise<unknown> } | undefined
      if (fs === undefined) return
      try {
        const target = await fs.resolve(stateFilePath())
        await fs.writeText(target, JSON.stringify({
          accounts: state.accounts,
          contextTokens: state.contextTokens,
          allowlist: state.allowlist,
        }))
      } catch (err) {
        pushLog('warn', `persistState failed: ${String((err as Error)?.message ?? err)}`)
      }
    }
    const loadState = async (): Promise<void> => {
      const fs = ctx.get('fs') as { resolve: (p: string) => Promise<unknown>; stat: (t: unknown) => Promise<unknown>; readText: (t: unknown) => Promise<string> } | undefined
      if (fs === undefined) { pushLog('warn', 'fs service unavailable, no persistence'); return }
      try {
        const target = await fs.resolve(stateFilePath())
        if (await fs.stat(target) === undefined) return
        const parsed = JSON.parse(await fs.readText(target)) as {
          accounts?: AccountRecord[]; contextTokens?: Record<string, string>; allowlist?: Record<string, boolean>
        }
        if (Array.isArray(parsed.accounts)) {
          state.accounts = parsed.accounts
            .filter((a) => a?.id && a.token)
            .map((a) => ({ ...a, status: 'online' as const }))
        }
        if (parsed.contextTokens) state.contextTokens = parsed.contextTokens
        if (parsed.allowlist) state.allowlist = parsed.allowlist
        pushLog('info', `restored ${state.accounts.length} accounts from persistence`)
      } catch (err) {
        pushLog('warn', `loadState failed: ${String((err as Error)?.message ?? err)}`)
      }
    }
    void loadState()

    // ---- settings 命名空间 ----
    const settings = ctx.get('settings')
    let cfg: WeixinSettings = { ...WeixinSettingsSchema.parse({}) } as WeixinSettings
    if (settings !== undefined) {
      const scope = settings.register(
        WEIXIN_SETTINGS_NAMESPACE,
        WeixinSettingsSchema,
        { immediate: true, onUpdate: (next: WeixinSettings) => { cfg = next } },
      )
      const current = settings.get(WEIXIN_SETTINGS_NAMESPACE)
      if (current) cfg = WeixinSettingsSchema.parse(current)
      ctx.effect(() => scope.dispose?.())
    }

    const timer = ctx.get('timer')
    const sleep = async (ms: number) => {
      if (timer === undefined) return
      try { await timer.timeout(ms) } catch { /* aborted */ }
    }

    const findAccount = (id: string): AccountRecord | undefined =>
      state.accounts.find((a) => a.id === id)

    // ---- agents 服务封装 ----
    const agents = ctx.get('agents')
    const sessionQuery = ctx.get('sessionQuery')

    /** 与 apiProxy 一致的默认模型：agentDefaultModel.currentSelection()。 */
    const defaultAgentOptions = (): { provider: string; model: string } | undefined => {
      const adm = ctx.get('agentDefaultModel')
      if (adm === undefined) return undefined
      try {
        const sel = adm.currentSelection() as { provider?: string; model?: string } | undefined
        if (!sel?.provider || !sel.model) return undefined
        return { provider: sel.provider, model: sel.model }
      } catch {
        return undefined
      }
    }
    /** 微信 Agent 的工作目录：沙箱策略的 workspaceRoot。 */
    const defaultCwd = (): string | undefined => {
      const sp = ctx.get('sandboxPolicy')
      return (sp as { workspaceRoot?: string } | undefined)?.workspaceRoot
    }

    const bridgeDeps = {
      agents: {
        ensure: async (sessionId: string, agentPreset: string) => {
          const cached = state.agentCache[sessionId]
          if (cached && cached.agent) return cached.agent
          if (agents === undefined) { pushLog('error', 'agents service unavailable'); return null }
          const handle = await agents.create({
            sessionId,
            agentOptions: defaultAgentOptions(),
            meta: { agentPreset, ...(defaultCwd() ? { cwd: defaultCwd() } : {}) },
          })
          state.agentCache[sessionId] = {
            agent: handle.agent,
            dispose: () => { void handle.dispose() },
          }
          pushLog('info', `agent created for ${sessionId}`)
          return handle.agent
        },
      },
      sessionQuery: {
        readSession: async (sessionId: string) => sessionQuery?.readSession(sessionId),
      },
      log: pushLog,
      allow: (userId: string) => cfg.autoApprove || state.allowlist[userId] === true,
      recordPending: (userId: string, text: string) => {
        const existing = state.pending[userId]
        state.pending[userId] = existing
          ? { ...existing, lastText: text.slice(0, 80) }
          : { firstSeen: Date.now(), lastText: text.slice(0, 80) }
        if (!existing) pushLog('info', `new contact pending approval: ${userId}`)
      },
    }

    // ---- 登录状态机 ----
    const startLogin = async () => {
      const L = state.activeLogin
      if (L && Date.now() - L.startedAt < QR_TTL_MS) {
        return { sessionKey: L.sessionKey, qrcodeUrl: L.qrcodeUrl, message: '已有进行中的登录' }
      }
      try {
        const qr = await fetchBotQrcode(cfg, '3', { baseUrl: undefined })
        state.activeLogin = {
          sessionKey: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
          qrcode: qr.qrcode,
          qrcodeUrl: qr.qrcodeUrl,
          status: 'wait',
          startedAt: Date.now(),
          qrRefreshCount: 0,
          currentBaseUrl: 'https://ilinkai.weixin.qq.com',
        }
        pushLog('info', 'login started')
        return { sessionKey: state.activeLogin.sessionKey, qrcodeUrl: state.activeLogin.qrcodeUrl, message: '请用手机微信扫码' }
      } catch (err) {
        return { sessionKey: null, qrcodeUrl: null, message: `登录发起失败: ${String((err as Error)?.message ?? err)}` }
      }
    }

    const pollLoginStep = async () => {
      const L = state.activeLogin
      if (!L) return { done: true, connected: false, message: '没有进行中的登录' }
      if (Date.now() - L.startedAt > QR_TTL_MS) {
        state.activeLogin = null
        return { done: true, connected: false, message: '二维码已过期，请重新发起登录' }
      }
      const s = await pollQrStatus(L.qrcode, L.pendingVerifyCode, cfg, { baseUrl: L.currentBaseUrl })
      L.status = s.status || 'wait'
      switch (L.status) {
        case 'wait':
        case 'scaned':
          if (L.pendingVerifyCode) L.pendingVerifyCode = undefined
          return { status: L.status }
        case 'need_verifycode':
          return { status: 'need_verifycode' }
        case 'expired':
        case 'verify_code_blocked': {
          L.qrRefreshCount += 1
          if (L.qrRefreshCount > MAX_QR_REFRESH) { state.activeLogin = null; return { done: true, connected: false, message: '多次失败，请稍后再试' } }
          const qr = await fetchBotQrcode(cfg, '3', { baseUrl: undefined })
          L.qrcode = qr.qrcode; L.qrcodeUrl = qr.qrcodeUrl; L.startedAt = Date.now(); L.status = 'wait'; L.pendingVerifyCode = undefined
          return { status: 'wait', newQr: true, qrcodeUrl: L.qrcodeUrl }
        }
        case 'binded_redirect':
          state.activeLogin = null
          return { done: true, connected: false, alreadyConnected: true, message: '已连接过此实例' }
        case 'scaned_but_redirect':
          if (s.redirect_host) L.currentBaseUrl = `https://${s.redirect_host}`
          return { status: 'scaned' }
        case 'confirmed': {
          if (!s.ilink_bot_id) { state.activeLogin = null; return { done: true, connected: false, message: '登录失败：服务器未返回 ilink_bot_id' } }
          state.accounts.push({
            id: s.ilink_bot_id,
            label: `WeChat ${String(s.ilink_bot_id).slice(0, 8)}`,
            status: 'online',
            addedAt: Date.now(),
            token: s.bot_token,
            baseUrl: s.baseurl,
            userId: s.ilink_user_id,
          })
          state.activeLogin = null
          pushLog('info', `login confirmed account=${s.ilink_bot_id}`)
          void persistState()
          ctx.emit?.('weixin/status', { accountId: s.ilink_bot_id, status: 'online' })
          return { done: true, connected: true, message: '已连接到微信' }
        }
        default:
          return { status: 'wait' }
      }
    }

    // ---- monitor 生命周期 ----
    const startMonitor = async (accountId: string) => {
      const account = findAccount(accountId)
      if (!account || account.status !== 'online') return { ok: false, message: '账号不存在或不在线' }
      if (state.monitors[accountId]?.running) return { ok: true, already: true }
      const handle: MonitorHandle = {
        accountId, running: true, aborted: false, lastEventAt: null, lastInboundAt: null, lastError: null, pausedUntil: null,
      }
      state.monitors[accountId] = handle
      const deps = {
        findAccount,
        log: pushLog,
        onInbound: async (acct: string, msg: any, text: string) => {
          const ctxToken = (msg as { context_token?: string }).context_token
          const from = msg.from_user_id ?? ''
          if (ctxToken) state.contextTokens[`${acct}:${from}`] = ctxToken
          pushLog('info', `inbound from ${from}: ${text.slice(0, 80)}`)
          const result = await processInboundText(bridgeDeps, { accountId: acct, userId: from, text, agentPreset: cfg.agentPreset })
          if (result.reply) {
            await sendReply(account, from, ctxToken ?? state.contextTokens[`${acct}:${from}`], result.reply)
          }
          ctx.emit?.('weixin/message', { accountId: acct, from, direction: 'inbound', text })
        },
        saveSyncBuf: (acct: string, buf: string) => { /* M6: storageDomain 持久化 */ },
        loadSyncBuf: () => '',
        sleep,
        channelVersion: CHANNEL_VERSION,
      }
      void monitorLoop(handle, deps, cfg).catch((err) => {
        handle.running = false
        handle.lastError = String((err as Error)?.message ?? err)
        pushLog('error', `monitor crashed: ${handle.lastError}`)
      })
      return { ok: true }
    }

    const stopMonitor = (accountId: string) => {
      const m = state.monitors[accountId]
      if (m) { m.aborted = true; pushLog('info', `monitor stop requested for ${accountId}`) }
      return { ok: !!m }
    }

    const sendReply = async (account: AccountRecord, to: string, contextToken: string | undefined, text: string) => {
      const { sendTextMessage } = await import('./http.js')
      const res = await sendTextMessage(cfg, {
        to, text, contextToken,
        clientId: `wx${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
        baseUrl: account.baseUrl,
        token: account.token,
      }, {})
      if (!res.ok) pushLog('error', `sendmessage failed: ${res.error ?? res.body.slice(0, 300)}`)
      else pushLog('info', `sent reply to ${to} (${text.length} chars)`)
    }

    // ---- 公共视图（不泄漏 token） ----
    const publicView = () => ({
      config: { ...cfg },
      accounts: state.accounts.map((a) => ({ id: a.id, label: a.label, status: a.status, addedAt: a.addedAt })),
      login: state.activeLogin ? { sessionKey: state.activeLogin.sessionKey, status: state.activeLogin.status, qrcodeUrl: state.activeLogin.qrcodeUrl, startedAt: state.activeLogin.startedAt } : null,
      monitors: Object.values(state.monitors).map((m) => ({ accountId: m.accountId, running: m.running, lastEventAt: m.lastEventAt, lastInboundAt: m.lastInboundAt, lastError: m.lastError, pausedUntil: m.pausedUntil })),
      allowlist: Object.keys(state.allowlist),
      pending: Object.keys(state.pending).map((uid) => ({ userId: uid, firstSeen: state.pending[uid].firstSeen, lastText: state.pending[uid].lastText })),
      log: state.log.slice(-60),
      meta: {
        shell: ctx.get('shell') !== undefined,
        agents: agents !== undefined,
        sessions: ctx.get('sessions') !== undefined,
        settings: settings !== undefined,
      },
    })

    // ---- RPC ----
    const disposers: Array<() => void> = []
    const handle = (method: string, handler: (args: any) => any) => {
      try { disposers.push(ctx.harness?.handle(method, handler) ?? (() => {})) } catch { /* 宿主未提供 harness 时忽略 */ }
    }
    handle('wx/snapshot', async () => publicView())
    handle('wx/config/set', async (args) => {
      const patch = args?.config ?? {}
      cfg = WeixinSettingsSchema.parse({ ...cfg, ...patch })
      if (settings !== undefined) await settings.update(WEIXIN_SETTINGS_NAMESPACE, patch)
      pushLog('info', 'config updated')
      return publicView()
    })
    handle('wx/login/start', async () => startLogin())
    handle('wx/login/poll', async () => pollLoginStep())
    handle('wx/login/verify', async (args) => {
      if (!state.activeLogin || !args?.code) return { ok: false }
      state.activeLogin.pendingVerifyCode = String(args.code).trim()
      return { ok: true }
    })
    handle('wx/login/cancel', async () => { state.activeLogin = null; return { ok: true } })
    handle('wx/accounts/logout', async (args) => {
      const id = String(args?.id ?? '')
      stopMonitor(id)
      state.accounts = state.accounts.filter((a) => a.id !== id)
      void persistState()
      return { ok: true }
    })
    handle('wx/monitor/start', async (args) => startMonitor(String(args?.accountId ?? '')))
    handle('wx/monitor/stop', async (args) => stopMonitor(String(args?.accountId ?? '')))
    handle('wx/allowlist/approve', async (args) => {
      const userId = String(args?.userId ?? '')
      if (!userId) return { ok: false }
      state.allowlist[userId] = true
      delete state.pending[userId]
      pushLog('info', `allowlisted: ${userId}`)
      void persistState()
      return { ok: true }
    })
    handle('wx/allowlist/deny', async (args) => {
      const userId = String(args?.userId ?? '')
      if (!userId) return { ok: false }
      delete state.pending[userId]
      return { ok: true }
    })
    handle('wx/allowlist/remove', async (args) => {
      const userId = String(args?.userId ?? '')
      if (!userId) return { ok: false }
      delete state.allowlist[userId]
      void persistState()
      return { ok: true }
    })
    handle('wx/agent/test', async (args) => {
      const text = String(args?.text ?? '')
      if (!text) return { ok: false, error: '缺少消息文本' }
      const sessionId = `wx-test-${Date.now().toString(36)}`
      const agent = await bridgeDeps.agents.ensure(sessionId, cfg.agentPreset)
      if (!agent) return { ok: false, error: 'agent unavailable' }
      const started = Date.now()
      agent.followup({ id: `wx${Date.now().toString(36)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      await agent.whenIdle()
      const reply = await readLastAssistantText(bridgeDeps, sessionId)
      return { ok: true, reply, sessionId, ms: Date.now() - started }
    })
    handle('wx/inbound/simulate', async (args) => {
      const text = String(args?.text ?? '')
      if (!text) return { ok: false, error: '缺少消息文本' }
      const accountId = state.accounts[0]?.id ?? null
      return processInboundText(bridgeDeps, { accountId, userId: `sim-${Date.now().toString(36)}`, text, agentPreset: cfg.agentPreset })
    })
    handle('wx/test/ilink', async () => {
      const probe = await fetch(`https://ilinkai.weixin.qq.com`, { method: 'GET' }).then((r) => r.status).catch(() => 0)
      return { ok: probe === 200, httpCode: probe }
    })

    // ---- 清理 ----
    ctx.effect(() => () => {
      for (const m of Object.values(state.monitors)) m.aborted = true
      for (const c of Object.values(state.agentCache)) { try { c.dispose() } catch { /* ignore */ } }
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    })
  },
}
