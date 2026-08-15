/**
 * DSH 侧 weixin 桥接的配置命名空间。
 *
 * 通过 `settings.register('weixin', schema, opts)` 挂到 DSH 设置服务，
 * 持久化到 settings.yaml；控制面板读写同一命名空间。
 */
import { z } from 'zod'

export const WEIXIN_SETTINGS_NAMESPACE = 'weixin'

export const WeixinSettingsSchema = z.object({
  /** 总开关：关闭时 monitor 不启动、入站消息直接忽略。 */
  enabled: z.boolean().default(true),
  /** 回复用 Agent preset id（DSH agentPresets 注册表）。 */
  agentPreset: z.string().default('cordis'),
  /** 会话持久化策略：per-account 或 per-account-channel-peer。 */
  dmScope: z.enum(['per-account', 'per-account-channel-peer']).default('per-account-channel-peer'),
  /** 新联系人是否自动放行；false 时需在面板白名单审批。 */
  autoApprove: z.boolean().default(true),
  /** iLink 出站 bot_agent（UA 语义，仅观测用）。 */
  botAgent: z.string().default('DSH-Weixin/1.0.0'),
  /** 长轮询超时（ms），跟随服务端建议，默认 35s。 */
  longPollTimeoutMs: z.number().int().min(5000).max(120000).default(35000),
  /** 是否把 markdown 转为微信友好纯文本。 */
  markdownFilter: z.boolean().default(true),
  /** 调试模式：记录更详细的收发日志。 */
  debug: z.boolean().default(false),
})

export type WeixinSettings = z.infer<typeof WeixinSettingsSchema>

export const WEIXIN_SETTINGS_DEFAULTS: WeixinSettings = WeixinSettingsSchema.parse({})

/** 只暴露面板需要的标量字段（不含 token 等机密）。 */
export function publicSettings(s: WeixinSettings): WeixinSettings {
  return { ...s }
}
