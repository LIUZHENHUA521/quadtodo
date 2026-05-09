import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const settingsSource = fs.readFileSync(path.resolve('web/src/SettingsDrawer.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.resolve('web/src/api.ts'), 'utf8')

describe('SettingsDrawer Lark notification settings', () => {
  it('types the Lark config returned by /api/config', () => {
    expect(apiSource).toContain('lark?: {')
    expect(apiSource).toContain('appId?: string')
    expect(apiSource).toContain('appSecret?: string')
    expect(apiSource).toContain('appSecretMasked?: string | null')
    expect(apiSource).toContain("appSecretSource?: 'quadtodo' | 'missing'")
    expect(apiSource).toContain('requireThreadGroup?: boolean')
    expect(apiSource).toContain('eventSubscribeEnabled?: boolean')
    expect(apiSource).toContain('notificationCooldownMs?: number')
    expect(apiSource).toContain('export async function testLark')
  })

  it('loads and saves Lark form values through the existing config endpoint', () => {
    expect(settingsSource).toContain('larkAppId: result.config.lark?.appId || \'\'')
    expect(settingsSource).toContain('larkAppSecret: result.config.lark?.appSecretMasked || \'\'')
    expect(settingsSource).toContain('larkEnabled: result.config.lark?.enabled ?? false')
    expect(settingsSource).toContain("larkChatId: result.config.lark?.chatId || ''")
    expect(settingsSource).toContain('larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false')
    expect(settingsSource).toContain('larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false')
    expect(settingsSource).toContain('larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000')
    expect(settingsSource).toContain('appId: String(values.larkAppId || \'\').trim()')
    expect(settingsSource).toContain('appSecret: values.larkAppSecret || \'\'')
    expect(settingsSource).toContain('enabled: Boolean(values.larkEnabled)')
    expect(settingsSource).toContain("chatId: String(values.larkChatId || '').trim()")
    expect(settingsSource).toContain('requireThreadGroup: values.larkRequireThreadGroup !== false')
    expect(settingsSource).toContain('eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false')
    expect(settingsSource).toContain('notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0')
  })

  it('groups Telegram and Lark under the notification-channel section', () => {
    expect(settingsSource).toContain('<Text strong>通知渠道</Text>')
    expect(settingsSource).toContain("key: 'telegram'")
    expect(settingsSource).toContain("key: 'lark'")
    expect(settingsSource).toContain('Telegram · 话题群同步、bot 配置、通知与白名单')
    expect(settingsSource).toContain('Lark / 飞书 · 话题群双向通知')
    expect(settingsSource).toContain('Lark 的话题由话题群中的主消息/thread 承载，不是 Telegram Forum Topic 那种原生 topic 对象。')
    expect(settingsSource).toContain('name="larkAppId"')
    expect(settingsSource).toContain('name="larkAppSecret"')
    expect(settingsSource).toContain('name="larkEnabled"')
    expect(settingsSource).toContain('name="larkChatId"')
    expect(settingsSource).toContain('name="larkRequireThreadGroup"')
    expect(settingsSource).toContain('name="larkEventSubscribeEnabled"')
    expect(settingsSource).toContain('name="larkNotificationCooldownMs"')
    expect(settingsSource).toContain('来自 quadtodo 配置')
    expect(settingsSource).toContain('未配置')
    expect(settingsSource).toContain('Lark 连通')
  })
})
