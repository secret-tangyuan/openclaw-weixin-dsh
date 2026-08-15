/**
 * 微信媒体发送（DSH 版）：CDN 上传（AES-128-ECB 加密）+ 媒体消息发送。
 *
 * 语义与 src/cdn/upload.ts + src/messaging/send-media.ts 一致，但：
 * - 使用 Node 原生 crypto（createCipheriv / randomBytes / md5）；
 * - 不依赖 OpenClaw 侧模块。
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import type { WeixinSettings } from './config.js'
import { CDN_BASE_URL, getUploadUrl, rawRequest, type ILinkRequestOptions } from './http.js'

/** AES-128-ECB（PKCS7 默认填充）加密。 */
export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** AES-128-ECB 密文长度（PKCS7 补齐到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

export interface UploadedFileInfo {
  filekey: string
  /** 下载加密参数，填入 ImageItem.media.encrypt_query_param。 */
  downloadEncryptedQueryParam: string
  /** AES-128-ECB key（hex），CDNMedia.aes_key 需转 base64。 */
  aeskey: string
  fileSize: number
  fileSizeCiphertext: number
}

const UPLOAD_MAX_RETRIES = 3

/** 把 buffer 加密后 POST 到微信 CDN，返回下载参数。 */
export async function uploadBufferToCdn(params: {
  buf: Uint8Array
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  cdnBaseUrl?: string
  aeskey: Uint8Array
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, aeskey } = params
  const ciphertext = encryptAesEcb(buf, aeskey)
  const cdnUrl = uploadFullUrl?.trim()
    ?? (uploadParam
      ? `${params.cdnBaseUrl ?? CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
      : undefined)
  if (!cdnUrl) throw new Error('CDN upload URL missing (need upload_full_url or upload_param)')

  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? (await res.text())
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`)
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`
        throw new Error(`CDN upload server error: ${errMsg}`)
      }
      const downloadParam = res.headers.get('x-download-encrypt-query-param') ?? ''
      if (!downloadParam) throw new Error('CDN upload missing download param')
      return { downloadParam }
    } catch (err) {
      lastError = err
      if (attempt === UPLOAD_MAX_RETRIES) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 完整媒体上传管线：读文件 → md5/aeskey → getUploadUrl → CDN 加密上传。 */
export async function uploadMediaToWeixin(params: {
  buf: Uint8Array
  toUserId: string
  mediaType: number
  settings: WeixinSettings
  baseUrl?: string
  token?: string
  cdnBaseUrl?: string
  opts?: ILinkRequestOptions
}): Promise<UploadedFileInfo> {
  const { buf, toUserId, mediaType, settings, baseUrl, token, cdnBaseUrl } = params
  const rawsize = buf.byteLength
  const rawfilemd5 = createHash('md5').update(buf).digest('hex')
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = randomBytes(16).toString('hex')
  const aeskey = randomBytes(16)

  const uploadResp = await getUploadUrl(settings, {
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString('hex'),
    baseUrl,
    token,
  }, params.opts)

  const { downloadParam } = await uploadBufferToCdn({
    buf,
    uploadFullUrl: uploadResp.upload_full_url,
    uploadParam: uploadResp.upload_param,
    filekey,
    cdnBaseUrl,
    aeskey,
  })

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  }
}

/** 发送媒体消息（item_list 携带 CDN 媒体项）。 */
export async function sendMediaMessage(
  settings: WeixinSettings,
  params: {
    to: string
    contextToken?: string
    clientId: string
    item: unknown
    baseUrl?: string
    token?: string
  },
  opts: ILinkRequestOptions = {},
): Promise<boolean> {
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: 2,
      message_state: 2,
      item_list: [params.item],
      context_token: params.contextToken ?? undefined,
    },
  })
  const res = await rawRequest('POST', 'ilink/bot/sendmessage', body, settings, {
    ...opts,
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: opts.timeoutMs ?? 15000,
  })
  return res.ok
}

export { rawRequest }
