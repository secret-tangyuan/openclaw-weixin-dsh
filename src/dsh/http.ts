/**
 * iLink HTTP 客户端（DSH 版）。
 *
 * 语义与 src/api/api.ts 一致，但：
 * - 使用 Node 原生 `fetch`（DSH Host 进程内可用），不依赖 shell/curl；
 * - 不导入 OpenClaw 侧的 src/api/*（botAgent 的 UA 清洗逻辑内联于此）；
 * - 返回结构化结果而非抛错，便于 monitor 循环做错误分类。
 */
import type { WeixinSettings } from './config.js'

export const ILINK_FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const STALE_TOKEN_ERRCODE = -14

/** 默认 bot_agent（UA 语义，仅观测用）。 */
const DEFAULT_BOT_AGENT = 'OpenClaw'
const BOT_AGENT_MAX_LEN = 256

/**
 * UA 风格 bot_agent 清洗（忠实移植 src/api/api.ts 的 sanitizeBotAgent）：
 * 两遍扫描——先按空白分词并粘合多词注释，再以 pendingProduct 把合法注释
 * 挂到前一个 product 上；超长时从尾部丢弃 token 截断。
 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_BOT_AGENT
  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/

  const rawTokens = trimmed.split(/\s+/)
  const tokens: string[] = []
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i]
    if (tok.startsWith('(') && !tok.endsWith(')')) {
      let acc = tok
      while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
        i += 1
        acc += ` ${rawTokens[i]}`
      }
      tokens.push(acc)
    } else {
      tokens.push(tok)
    }
  }

  const accepted: string[] = []
  let pendingProduct: string | null = null
  for (const tok of tokens) {
    if (tok.startsWith('(') && tok.endsWith(')')) {
      const inner = tok.slice(1, -1)
      if (pendingProduct !== null && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`)
        pendingProduct = null
      } else {
        if (pendingProduct !== null) { accepted.push(pendingProduct); pendingProduct = null }
      }
      continue
    }
    if (pendingProduct !== null) { accepted.push(pendingProduct); pendingProduct = null }
    if (productRe.test(tok)) pendingProduct = tok
  }
  if (pendingProduct !== null) accepted.push(pendingProduct)
  if (accepted.length === 0) return DEFAULT_BOT_AGENT

  const joined = accepted.join(' ')
  if (Buffer.byteLength(joined, 'utf-8') <= BOT_AGENT_MAX_LEN) return joined

  const truncated: string[] = []
  let len = 0
  for (const tok of accepted) {
    const tokBytes = Buffer.byteLength(tok, 'utf-8')
    if (len + (truncated.length ? 1 : 0) + tokBytes > BOT_AGENT_MAX_LEN) break
    truncated.push(tok)
    len += tokBytes + (truncated.length > 1 ? 1 : 0)
  }
  return truncated.join(' ') || DEFAULT_BOT_AGENT
}

/** X-WECHAT-UIN: random uint32 → decimal string → base64。 */
export function randomWechatUin(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return btoa(String(n))
}

export interface ILinkRequestOptions {
  baseUrl?: string
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** get_bot_qrcode 携带的本地已登录 token 列表（用于多端登录识别）。 */
  localTokenList?: string[]
}

export interface ILinkResult {
  ok: boolean
  status: number
  body: string
  /** 网络层失败 / 超时等（与 HTTP 状态码区分）。 */
  error?: string
  timedOut?: boolean
}

export async function rawRequest(
  method: 'GET' | 'POST',
  endpoint: string,
  body: string | undefined,
  settings: WeixinSettings,
  opts: ILinkRequestOptions,
): Promise<ILinkResult> {
  const base = (opts.baseUrl ?? ILINK_FIXED_BASE_URL).replace(/\/$/, '')
  const url = new URL(endpoint, `${base}/`)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const controller = new AbortController()
  const timeout = opts.timeoutMs ?? 15000
  const timer = setTimeout(() => controller.abort(), timeout)
  const onOuterAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : body,
      signal: controller.signal,
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, body: text }
  } catch (err) {
    const aborted = controller.signal.aborted
    return {
      ok: false,
      status: 0,
      body: '',
      timedOut: aborted && !opts.signal?.aborted,
      error: String((err as Error)?.message ?? err),
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

export function buildBaseInfo(settings: WeixinSettings, channelVersion: string) {
  return { channel_version: channelVersion, bot_agent: sanitizeBotAgent(settings.botAgent) }
}

/** get_bot_qrcode：发起扫码登录，返回 qrcode id 与二维码内容 URL。 */
export async function fetchBotQrcode(
  settings: WeixinSettings,
  botType = '3',
  opts: ILinkRequestOptions = {},
): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const res = await rawRequest(
    'POST',
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    JSON.stringify({ local_token_list: opts.localTokenList ?? [] }),
    settings,
    { ...opts, timeoutMs: opts.timeoutMs ?? 15000 },
  )
  if (!res.ok || !res.body) throw new Error(`get_bot_qrcode failed: ${res.error ?? res.body}`)
  const parsed = JSON.parse(res.body) as { qrcode?: string; qrcode_img_content?: string; ret?: number }
  if (!parsed.qrcode || !parsed.qrcode_img_content) throw new Error('get_bot_qrcode missing fields')
  return { qrcode: parsed.qrcode, qrcodeUrl: parsed.qrcode_img_content }
}

export interface QrStatusResponse {
  status: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
}

/** get_qrcode_status：长轮询（默认 35s）；超时/网络错误按 wait 处理（与原版语义一致）。 */
export async function pollQrStatus(
  qrcode: string,
  verifyCode: string | undefined,
  settings: WeixinSettings,
  opts: ILinkRequestOptions = {},
): Promise<QrStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`
  const res = await rawRequest('GET', endpoint, undefined, settings, { ...opts, timeoutMs: opts.timeoutMs ?? 40000 })
  if (!res.ok || !res.body) return { status: 'wait' }
  try {
    return JSON.parse(res.body) as QrStatusResponse
  } catch {
    return { status: 'wait' }
  }
}

/** getupdates：长轮询收消息。返回原始 JSON（monitor 负责游标与错误分类）。 */
export async function getUpdates(
  settings: WeixinSettings,
  channelVersion: string,
  syncBuf: string,
  opts: ILinkRequestOptions & { longPollTimeoutMs?: number },
): Promise<ILinkResult> {
  const timeout = opts.longPollTimeoutMs ?? settings.longPollTimeoutMs
  return rawRequest(
    'POST',
    'ilink/bot/getupdates',
    JSON.stringify({ get_updates_buf: syncBuf ?? '', base_info: buildBaseInfo(settings, channelVersion) }),
    settings,
    { ...opts, timeoutMs: timeout },
  )
}

/** sendmessage：发送文本消息。 */
export async function sendTextMessage(
  settings: WeixinSettings,
  params: { to: string; text: string; contextToken?: string; clientId: string; baseUrl?: string; token?: string },
  opts: ILinkRequestOptions = {},
): Promise<ILinkResult> {
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: 2,
      message_state: 2,
      item_list: params.text ? [{ type: 1, text_item: { text: params.text } }] : [],
      context_token: params.contextToken ?? undefined,
    },
  })
  return rawRequest('POST', 'ilink/bot/sendmessage', body, settings, { ...opts, timeoutMs: opts.timeoutMs ?? 15000 })
}

/** getUploadUrl：申请 CDN 上传预签名参数（媒体发送前调用）。 */
export async function getUploadUrl(
  settings: WeixinSettings,
  params: {
    filekey: string
    mediaType: number
    toUserId: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    aeskey: string
    baseUrl?: string
    token?: string
  },
  opts: ILinkRequestOptions = {},
): Promise<{ upload_param?: string; upload_full_url?: string; thumb_upload_param?: string }> {
  const body = JSON.stringify({
    filekey: params.filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: true,
    aeskey: params.aeskey,
  })
  const res = await rawRequest('POST', 'ilink/bot/getuploadurl', body, settings, {
    ...opts,
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: opts.timeoutMs ?? 15000,
  })
  if (!res.ok || !res.body) throw new Error(`getUploadUrl failed: ${res.error ?? res.body}`)
  return JSON.parse(res.body)
}

/** sendTyping：发送/取消"正在输入"指示。 */
export async function sendTyping(
  settings: WeixinSettings,
  params: { ilinkUserId: string; typingTicket: string; status: 1 | 2; baseUrl?: string; token?: string },
  opts: ILinkRequestOptions = {},
): Promise<ILinkResult> {
  const body = JSON.stringify({
    ilink_user_id: params.ilinkUserId,
    typing_ticket: params.typingTicket,
    status: params.status,
  })
  return rawRequest('POST', 'ilink/bot/sendtyping', body, settings, {
    ...opts,
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: opts.timeoutMs ?? 10000,
  })
}
