/**
 * 每账号 getupdates 长轮询 monitor（DSH 版）。
 *
 * 与原版 src/monitor/monitor.ts 语义一致：同步游标持久化、stale-token(-14)
 * 暂停、连续失败退避、服务端建议超时跟随。差异：消息处理不经过 OpenClaw
 * channelRuntime，而是直接交给 agent-bridge。
 */
import { getUpdates, sendTextMessage, STALE_TOKEN_ERRCODE, type ILinkResult } from './http.js'
import type { AccountRecord } from './agent-bridge.js'
import type { WeixinSettings } from './config.js'
import type { WeixinMessage } from '../api/types.js'

export interface MonitorHandle {
  accountId: string
  running: boolean
  aborted: boolean
  lastEventAt: number | null
  lastInboundAt: number | null
  lastError: string | null
  pausedUntil: number | null
}

export interface MonitorDeps {
  findAccount(accountId: string): AccountRecord | undefined
  log(level: 'info' | 'warn' | 'error', msg: string): void
  onInbound(accountId: string, msg: WeixinMessage, text: string): Promise<void>
  saveSyncBuf(accountId: string, buf: string): void
  loadSyncBuf(accountId: string): string
  sleep(ms: number): Promise<void>
  channelVersion: string
}

const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
const STALE_TOKEN_PAUSE_MS = 10 * 60 * 1000

function extractText(msg: WeixinMessage): string {
  const item = (msg.item_list ?? []).find((it) => it?.type === 1 && it.text_item?.text)
  return item?.text_item?.text ?? ''
}

export async function monitorLoop(handle: MonitorHandle, deps: MonitorDeps, settings: WeixinSettings): Promise<void> {
  deps.log('info', `monitor started for ${handle.accountId}`)
  let syncBuf = deps.loadSyncBuf(handle.accountId)
  let longPollMs = settings.longPollTimeoutMs
  let failures = 0

  while (!handle.aborted) {
    const account = deps.findAccount(handle.accountId)
    if (!account || account.status !== 'online') break
    if (handle.pausedUntil !== null && Date.now() < handle.pausedUntil) {
      await deps.sleep(handle.pausedUntil - Date.now() + 1000)
      continue
    }

    const res: ILinkResult = await getUpdates(settings, deps.channelVersion, syncBuf, {
      baseUrl: account.baseUrl,
      token: account.token,
      longPollTimeoutMs: longPollMs,
    })
    if (handle.aborted) break

    if (!res.ok) {
      failures += 1
      handle.lastError = `getupdates ${res.error ? `network: ${res.error}` : `http ${res.status}: ${res.body.slice(0, 120)}`}`
      deps.log('warn', `getupdates failure ${failures}: ${handle.lastError}`)
      await deps.sleep(failures >= MAX_CONSECUTIVE_FAILURES ? (failures = 0, BACKOFF_DELAY_MS) : RETRY_DELAY_MS)
      continue
    }

    let parsed: { ret?: number; errcode?: number; errmsg?: string; msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }
    try {
      parsed = JSON.parse(res.body)
    } catch {
      failures += 1
      await deps.sleep(RETRY_DELAY_MS)
      continue
    }

    const isApiError = (parsed.ret !== undefined && parsed.ret !== 0) || (parsed.errcode !== undefined && parsed.errcode !== 0)
    if (isApiError) {
      if (parsed.errcode === STALE_TOKEN_ERRCODE || parsed.ret === STALE_TOKEN_ERRCODE) {
        handle.pausedUntil = Date.now() + STALE_TOKEN_PAUSE_MS
        handle.lastError = 'token stale (-14), pausing 10min'
        deps.log('error', handle.lastError)
        failures = 0
        await deps.sleep(10_000)
        continue
      }
      failures += 1
      handle.lastError = `api error ret=${parsed.ret} errcode=${parsed.errcode} ${parsed.errmsg ?? ''}`
      if (failures >= MAX_CONSECUTIVE_FAILURES) { failures = 0; await deps.sleep(BACKOFF_DELAY_MS) } else { await deps.sleep(RETRY_DELAY_MS) }
      continue
    }

    failures = 0
    handle.lastError = null
    handle.lastEventAt = Date.now()
    if (parsed.longpolling_timeout_ms && parsed.longpolling_timeout_ms > 0) longPollMs = parsed.longpolling_timeout_ms
    if (parsed.get_updates_buf) {
      syncBuf = parsed.get_updates_buf
      deps.saveSyncBuf(handle.accountId, syncBuf)
    }

    for (const msg of parsed.msgs ?? []) {
      if (handle.aborted) break
      if (msg.message_type === 2) continue // BOT 消息不回环
      handle.lastInboundAt = Date.now()
      const text = extractText(msg)
      if (text) {
        await deps.onInbound(handle.accountId, msg, text)
      } else {
        deps.log('warn', `unsupported non-text inbound from ${msg.from_user_id ?? '?'}`)
      }
    }
  }
  handle.running = false
  handle.aborted = false
  deps.log('info', `monitor stopped for ${handle.accountId}`)
}

export { sendTextMessage }
