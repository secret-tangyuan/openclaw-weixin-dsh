/**
 * DSH Client 半：微信控制面板（设置 → 微信 (WeChat)）。
 *
 * 挂载点：`settings.section` 槽位（id: weixin, order 30）。
 *
 * ⚠️ 接线说明（M6 收尾项）：本文件是从「已验证的动态插件原型」移植的参考实现，
 * 使用动态插件运行时的 `host.call('wx/*')` 与宿主 RPC 通信。落库为真实
 * DSH 包时，应改为标准 Client 插件接线：
 *   - Host：把 `wx/*` 方法注册为 `TypertRemoteService`（`@Remote('snapshot')` 等，
 *     参考 `@deepseek-ai/dsh-message-feedback/remote`），包内导出 `/remote` 子路径；
 *   - Client：`ClientContext` + `connection`（ConnectionHandle），
 *     经 `connection.api.weixin.snapshot()` 等调用，`inject: ['slots', 'connection']`；
 *   - package.json 增加 `dsh.client` 元数据（platform: "web"）。
 * 面板的 UI 结构与交互逻辑与原型一致，仅需替换 RPC 调用层。
 *
 * 功能：账号与扫码登录（面板内二维码）、监控启停、消息闭环测试、
 * Agent 路由与配置、iLink 连通性、日志。
 */
import { useEffect, useState } from 'react'

interface Snap {
  config: Record<string, unknown>
  accounts: Array<{ id: string; label: string; status: string }>
  login: { sessionKey: string; status: string; qrcodeUrl: string; startedAt: number } | null
  monitors: Array<{ accountId: string; running: boolean; lastEventAt: number | null; lastInboundAt: number | null; lastError: string | null }>
  allowlist: string[]
  pending: Array<{ userId: string; firstSeen: number; lastText: string }>
  log: Array<{ t: number; level: string; msg: string }>
  meta: { shell: boolean; agents: boolean; sessions: boolean; settings: boolean }
}

const statusLabel: Record<string, string> = {
  wait: '等待扫码…',
  scaned: '已扫码，正在验证…',
  need_verifycode: '需要输入验证码',
  'expired-refreshed': '二维码已刷新，请重新扫码',
  'blocked-refreshed': '验证受限，二维码已刷新',
}

function fmtTime(t: number | null | undefined): string {
  if (!t) return '-'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function WeixinPanel() {
  const [snap, setSnap] = useState<Snap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [login, setLogin] = useState<{ sessionKey: string } | null>(null)
  const [loginStatus, setLoginStatus] = useState<string | null>(null)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [needVerify, setNeedVerify] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  const [testText, setTestText] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; reply?: string; sessionId?: string; ms?: number; error?: string } | null>(null)

  const refresh = async () => {
    try {
      setSnap(await host.call('wx/snapshot'))
      setError(null)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }

  useEffect(() => {
    if (login !== null) return
    void refresh()
    const timer = ctx.get('timer')
    if (timer) {
      const d = timer.interval(() => { void refresh() }, 3000)
      return () => d()
    }
  }, [login === null])

  useEffect(() => {
    if (login === null) return
    let alive = true
    let polling = false
    const poll = async () => {
      if (polling || !alive) return
      polling = true
      try {
        const p = await host.call('wx/login/poll', { sessionKey: login.sessionKey })
        if (!alive) return
        if (p.done) {
          setLogin(null); setQrImage(null); setNeedVerify(false); setVerifyCode(''); setLoginStatus(null)
          await refresh()
        } else {
          setLoginStatus(p.status)
          setNeedVerify(p.status === 'need_verifycode')
          if (p.newQr) {
            const img = await host.call('wx/login/qr')
            if (alive && img?.imageDataUrl) setQrImage(img.imageDataUrl)
          }
        }
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e))
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = ctx.get('timer')
    if (timer) {
      const d = timer.interval(() => { void poll() }, 2500)
      return () => { alive = false; d() }
    }
    return () => { alive = false }
  }, [login])

  const startLogin = async () => {
    setBusy(true)
    try {
      const r = await host.call('wx/login/start')
      if (r?.qrcodeUrl) {
        setLogin({ sessionKey: r.sessionKey }); setLoginStatus('wait')
        const img = await host.call('wx/login/qr')
        if (img?.imageDataUrl) setQrImage(img.imageDataUrl)
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const cancelLogin = async () => {
    try { await host.call('wx/login/cancel') } catch { /* ignore */ }
    setLogin(null); setQrImage(null); setNeedVerify(false); setVerifyCode(''); setLoginStatus(null)
    await refresh()
  }

  const toggleMonitor = async (accountId: string, running: boolean) => {
    try {
      await host.call(running ? 'wx/monitor/stop' : 'wx/monitor/start', { accountId })
      await refresh()
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }

  const logoutAccount = async (id: string) => {
    try { await host.call('wx/accounts/logout', { id }); await refresh() } catch (e) { setError(String((e as Error)?.message ?? e)) }
  }

  const runTest = async (mode: 'agent' | 'inbound') => {
    if (!testText) return
    setTestResult(null)
    try {
      setTestResult(await host.call(mode === 'agent' ? 'wx/agent/test' : 'wx/inbound/simulate', { text: testText }))
    } catch (e) {
      setTestResult({ ok: false, error: String((e as Error)?.message ?? e) })
    }
  }

  const cfg = snap?.config ?? {}
  const accounts = snap?.accounts ?? []
  const monitors = snap?.monitors ?? []
  const monitorOf: Record<string, (typeof monitors)[number]> = {}
  for (const m of monitors) monitorOf[m.accountId] = m

  return (
    <div style={{ padding: '4px 2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <strong>微信 (WeChat) 桥接</strong>
        {error && <span style={{ color: '#e74c3c', fontFamily: 'monospace', fontSize: 12 }}>{error}</span>}
      </div>

      <section className="wx-card">
        <h3>账号与登录</h3>
        {login ? (
          <div>
            {qrImage ? <img className="wx-qr" src={qrImage} alt="微信登录二维码" /> : <div className="wx-empty">二维码加载中…</div>}
            <div>{statusLabel[loginStatus ?? 'wait'] ?? loginStatus ?? '等待扫码…'}</div>
            {needVerify && (
              <div>
                <input className="wx-input" placeholder="输入手机微信显示的数字" value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)} />
                <button className="wx-btn" disabled={!verifyCode} onClick={async () => {
                  try { await host.call('wx/login/verify', { sessionKey: login.sessionKey, code: verifyCode }); setNeedVerify(false); setVerifyCode('') } catch { /* ignore */ }
                }}>提交</button>
              </div>
            )}
            <button className="wx-btn" onClick={() => void cancelLogin()}>取消登录</button>
          </div>
        ) : (
          <div>
            <button className="wx-btn" disabled={busy} onClick={() => void startLogin()}>扫码登录</button>
            {accounts.length === 0 && <div className="wx-empty">暂无已登录账号</div>}
            {accounts.map((a) => {
              const m = monitorOf[a.id]
              return (
                <div key={a.id} style={{ borderTop: '1px solid rgba(127,127,127,.2)', paddingTop: 6, marginTop: 6 }}>
                  <div>
                    <span style={{ fontFamily: 'monospace' }}>{a.id}</span> <span style={{ opacity: .6 }}>{a.status}</span>
                    <button className="wx-btn" onClick={() => void logoutAccount(a.id)}>登出</button>
                  </div>
                  <div style={{ opacity: .8, fontSize: 12 }}>
                    监控: {m?.running ? '运行中' : '已停止'} · 最近事件: {fmtTime(m?.lastEventAt)} · 最近入站: {fmtTime(m?.lastInboundAt)}
                    {a.status === 'online' && (
                      <button className="wx-btn" onClick={() => void toggleMonitor(a.id, !!m?.running)}>
                        {m?.running ? '停止监控' : '启动监控'}
                      </button>
                    )}
                  </div>
                  {m?.lastError && <div style={{ color: '#e74c3c', fontSize: 12 }}>错误: {m.lastError}</div>}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="wx-card">
        <h3>配对白名单</h3>
        <div style={{ opacity: .8, fontSize: 12 }}>
          自动放行: {cfg.autoApprove ? '开 — 新联系人直接放行' : '关 — 新联系人需审批'}
        </div>
        {(snap?.pending ?? []).length > 0 && (snap?.pending ?? []).map((p) => (
          <div key={p.userId}>
            <code>{p.userId}</code> <span style={{ opacity: .6, fontSize: 12 }}>{p.lastText}</span>
            <button className="wx-btn" onClick={async () => {
              await host.call('wx/allowlist/approve', { userId: p.userId }); await refresh()
            }}>批准</button>
            <button className="wx-btn" onClick={async () => {
              await host.call('wx/allowlist/deny', { userId: p.userId }); await refresh()
            }}>拒绝</button>
          </div>
        ))}
        {(snap?.allowlist ?? []).length === 0
          ? <div className="wx-empty">白名单为空</div>
          : (snap?.allowlist ?? []).map((uid) => (
              <div key={uid}>
                <code>{uid}</code>
                <button className="wx-btn" onClick={async () => {
                  await host.call('wx/allowlist/remove', { userId: uid }); await refresh()
                }}>移除</button>
              </div>
            ))}
      </section>

      <section className="wx-card">
        <h3>消息闭环测试 (M3)</h3>
        <input className="wx-input" placeholder="输入一条消息，如：你好" value={testText} onChange={(e) => setTestText(e.target.value)} />
        <button className="wx-btn" disabled={!testText} onClick={() => void runTest('agent')}>直接发 Agent</button>
        <button className="wx-btn" disabled={!testText} onClick={() => void runTest('inbound')}>模拟微信入站</button>
        {testResult && (
          <div className="wx-reply">
            {testResult.ok
              ? `回复 (${testResult.ms ?? '?'}ms):\n${testResult.reply ?? '(空回复)'}${testResult.sessionId ? `\n\n[会话] ${testResult.sessionId}` : ''}`
              : `失败: ${testResult.error ?? '未知错误'}`}
          </div>
        )}
      </section>

      <section className="wx-card">
        <h3>配置</h3>
        <div>Agent Preset: <code>{String(cfg.agentPreset ?? '')}</code></div>
        <div>自动放行: <code>{cfg.autoApprove ? '开' : '关'}</code> · botAgent: <code>{String(cfg.botAgent ?? '')}</code></div>
        <div>会话隔离: <code>{String(cfg.dmScope ?? '')}</code> · Markdown 过滤: <code>{cfg.markdownFilter ? '开' : '关'}</code></div>
      </section>

      <section className="wx-card">
        <h3>日志</h3>
        <div className="wx-log">
          {(snap?.log ?? []).map((e, i) => (
            <div key={i}>{fmtTime(e.t)} [{e.level}] {e.msg}</div>
          ))}
        </div>
      </section>
    </div>
  )
}

export default {
  apply(ctx: any) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'weixin', order: 30, label: '微信 (WeChat)' },
      () => <WeixinPanel />,
    ))
  },
}
