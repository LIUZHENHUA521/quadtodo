import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { SessionMeta, PetState } from '../store/aiSessionStore'
import { QUADRANT_TINT, petShape } from './petAssets'

/**
 * 卡通小机器人：身体 + 天线 + 眼睛 + 嘴巴 + 两只脚 + 地面阴影
 * 受 Claude Code 终端小机器人启发，蹦跳时有挤压拉伸和抛物线轨迹
 */
export class Pet extends Container {
  sessionId: string
  todoId: string
  state: PetState = 'idle'

  private shadow: Graphics
  private bodyGroup: Container
  private body: Graphics
  private antenna: Graphics
  private leftEye: Graphics
  private rightEye: Graphics
  private mouth: Graphics
  private leftFoot: Graphics
  private rightFoot: Graphics
  private labelText: Text

  private anchorY = 0
  private phase: number = Math.random() * Math.PI * 2
  private hopTimer = 0
  private blinkTimer = Math.random() * 3
  private multiplier = 1
  private baseSize: number
  private bodyTint: number = 0x1677ff
  private round: boolean = true
  private decorColor: number = 0xffffff

  constructor(session: SessionMeta, size = 52) {
    super()
    this.sessionId = session.sessionId
    this.todoId = session.todoId
    this.baseSize = size
    this.eventMode = 'static'
    this.cursor = 'pointer'

    this.shadow = new Graphics()
    this.addChild(this.shadow)

    this.bodyGroup = new Container()
    this.addChild(this.bodyGroup)

    this.antenna = new Graphics()
    this.bodyGroup.addChild(this.antenna)

    this.body = new Graphics()
    this.bodyGroup.addChild(this.body)

    this.leftFoot = new Graphics()
    this.rightFoot = new Graphics()
    this.bodyGroup.addChild(this.leftFoot)
    this.bodyGroup.addChild(this.rightFoot)

    this.leftEye = new Graphics()
    this.rightEye = new Graphics()
    this.bodyGroup.addChild(this.leftEye)
    this.bodyGroup.addChild(this.rightEye)

    this.mouth = new Graphics()
    this.bodyGroup.addChild(this.mouth)

    this.labelText = new Text({
      text: session.todoTitle.length > 10 ? session.todoTitle.slice(0, 10) + '…' : session.todoTitle,
      style: new TextStyle({ fontSize: 11, fill: 0x333333, align: 'center', fontFamily: 'system-ui, -apple-system, sans-serif' }),
    })
    this.labelText.anchor.set(0.5, 0)
    this.labelText.y = size / 2 + 14
    this.addChild(this.labelText)

    this.drawBody(session)
    this.drawFace('idle', 0)
  }

  drawBody(session: SessionMeta) {
    const s = this.baseSize
    this.bodyTint = QUADRANT_TINT[session.quadrant]
    this.round = petShape(session.tool) === 'round'
    this.decorColor = lighten(this.bodyTint, 0.35)

    // 影子
    this.shadow.clear()
    this.shadow
      .ellipse(0, s * 0.58, s * 0.45, s * 0.1)
      .fill({ color: 0x000000, alpha: 0.18 })

    // 天线
    this.antenna.clear()
    this.antenna
      .moveTo(0, -s * 0.52)
      .lineTo(0, -s * 0.78)
      .stroke({ color: 0x333333, width: 2 })
    this.antenna
      .circle(0, -s * 0.82, s * 0.07)
      .fill({ color: this.decorColor })
      .stroke({ color: 0x333333, width: 1.5 })

    // 身体
    const bw = s * 0.9
    const bh = s * 0.9
    this.body.clear()
    if (this.round) {
      this.body
        .roundRect(-bw / 2, -bh / 2, bw, bh, s * 0.45)
        .fill({ color: this.bodyTint })
        .stroke({ color: 0xffffff, width: 2 })
    } else {
      this.body
        .roundRect(-bw / 2, -bh / 2, bw, bh, s * 0.18)
        .fill({ color: this.bodyTint })
        .stroke({ color: 0xffffff, width: 2 })
    }
    // 身体高光
    this.body
      .roundRect(-bw / 2 + 4, -bh / 2 + 4, bw * 0.35, bh * 0.22, s * 0.1)
      .fill({ color: 0xffffff, alpha: 0.28 })

    // 脚
    const fw = s * 0.22
    const fh = s * 0.12
    const fy = s * 0.44
    this.leftFoot.clear()
    this.leftFoot
      .roundRect(-s * 0.28 - fw / 2, fy - fh / 2, fw, fh, fh / 2)
      .fill({ color: darken(this.bodyTint, 0.25) })
    this.rightFoot.clear()
    this.rightFoot
      .roundRect(s * 0.28 - fw / 2, fy - fh / 2, fw, fh, fh / 2)
      .fill({ color: darken(this.bodyTint, 0.25) })
  }

  private drawFace(state: PetState, eyeOpen: number) {
    const s = this.baseSize
    const eyeY = -s * 0.08
    const eyeDx = s * 0.19
    const eyeR = s * 0.12

    this.leftEye.clear()
    this.rightEye.clear()
    if (eyeOpen <= 0.08) {
      // 闭眼：一条线
      this.leftEye
        .moveTo(-eyeDx - eyeR * 0.8, eyeY)
        .lineTo(-eyeDx + eyeR * 0.8, eyeY)
        .stroke({ color: 0x222222, width: 2 })
      this.rightEye
        .moveTo(eyeDx - eyeR * 0.8, eyeY)
        .lineTo(eyeDx + eyeR * 0.8, eyeY)
        .stroke({ color: 0x222222, width: 2 })
    } else {
      const h = eyeR * eyeOpen
      this.leftEye
        .ellipse(-eyeDx, eyeY, eyeR, h)
        .fill({ color: 0xffffff })
      this.rightEye
        .ellipse(eyeDx, eyeY, eyeR, h)
        .fill({ color: 0xffffff })
      // 瞳孔
      this.leftEye
        .circle(-eyeDx, eyeY, eyeR * 0.55)
        .fill({ color: 0x222222 })
      this.rightEye
        .circle(eyeDx, eyeY, eyeR * 0.55)
        .fill({ color: 0x222222 })
      // 高光
      this.leftEye
        .circle(-eyeDx + eyeR * 0.2, eyeY - eyeR * 0.2, eyeR * 0.18)
        .fill({ color: 0xffffff })
      this.rightEye
        .circle(eyeDx + eyeR * 0.2, eyeY - eyeR * 0.2, eyeR * 0.18)
        .fill({ color: 0xffffff })
    }

    // 嘴巴：随状态变化
    this.mouth.clear()
    const my = s * 0.18
    const mw = s * 0.22
    switch (state) {
      case 'celebrating': {
        // 张开大笑
        this.mouth
          .ellipse(0, my, mw * 0.9, s * 0.08)
          .fill({ color: 0x222222 })
        break
      }
      case 'working':
      case 'calling': {
        this.mouth
          .moveTo(-mw / 2, my)
          .quadraticCurveTo(0, my + s * 0.08, mw / 2, my)
          .stroke({ color: 0x222222, width: 2 })
        break
      }
      case 'thinking': {
        this.mouth
          .moveTo(-mw / 2, my)
          .lineTo(mw / 2, my)
          .stroke({ color: 0x222222, width: 2 })
        break
      }
      case 'fallen':
      case 'statue':
      case 'disconnected': {
        this.mouth
          .moveTo(-mw / 2, my + s * 0.04)
          .quadraticCurveTo(0, my - s * 0.04, mw / 2, my + s * 0.04)
          .stroke({ color: 0x222222, width: 2 })
        break
      }
      default: {
        this.mouth
          .moveTo(-mw / 2, my - s * 0.02)
          .quadraticCurveTo(0, my + s * 0.05, mw / 2, my - s * 0.02)
          .stroke({ color: 0x222222, width: 2 })
      }
    }
  }

  setAnchor(x: number, y: number) {
    this.x = x
    this.y = y
    this.anchorY = y
  }

  update(state: PetState, multiplier: number, dt: number) {
    const stateChanged = state !== this.state
    if (stateChanged) this.state = state
    this.multiplier = multiplier
    const dts = dt / 1000

    this.phase += dt * 0.004 * this.multiplier
    this.hopTimer += dts
    this.blinkTimer -= dts

    let hopY = 0
    let squash = 0 // 正数：垂直拉伸，负数：挤压
    let rotation = 0
    let alpha = 1

    switch (state) {
      case 'working': {
        // 蹦跳：周期性 crouch → jump → land
        const period = 0.6 / Math.max(0.5, this.multiplier)
        const t = (this.hopTimer % period) / period
        if (t < 0.15) {
          // 下蹲蓄力
          const k = t / 0.15
          squash = -0.25 * k
          hopY = 0
        } else if (t < 0.85) {
          // 空中
          const k = (t - 0.15) / 0.7
          hopY = -Math.sin(k * Math.PI) * this.baseSize * 0.45
          squash = 0.15 * Math.sin(k * Math.PI)
        } else {
          // 落地
          const k = (t - 0.85) / 0.15
          squash = -0.2 * (1 - k)
          hopY = 0
        }
        break
      }
      case 'idle': {
        // 呼吸
        hopY = Math.sin(this.phase) * 2
        squash = Math.sin(this.phase * 2) * 0.04
        break
      }
      case 'thinking': {
        // 左右晃头
        rotation = Math.sin(this.phase * 1.2) * 0.1
        hopY = Math.sin(this.phase) * 1.5
        break
      }
      case 'calling': {
        // 急速上下
        hopY = -Math.abs(Math.sin(this.phase * 5)) * this.baseSize * 0.2
        squash = Math.sin(this.phase * 10) * 0.06
        break
      }
      case 'celebrating': {
        // 开心大跳 + 旋转
        const period = 0.5
        const t = (this.hopTimer % period) / period
        hopY = -Math.sin(t * Math.PI) * this.baseSize * 0.6
        rotation = Math.sin(this.phase * 4) * 0.2
        squash = 0.1 * Math.sin(t * Math.PI)
        break
      }
      case 'fallen': {
        rotation = Math.PI / 2
        alpha = 0.65
        break
      }
      case 'statue': {
        alpha = 0.45
        break
      }
      case 'disconnected': {
        alpha = 0.35 + Math.abs(Math.sin(this.phase)) * 0.3
        break
      }
    }

    // 眨眼：每 2-4 秒眨一下
    let eyeOpen = 1
    if (this.blinkTimer <= 0) {
      if (this.blinkTimer <= -0.12) {
        this.blinkTimer = 2 + Math.random() * 2
      } else {
        eyeOpen = Math.abs(this.blinkTimer) / 0.06 - 1 // 0..-0.12 映射到 1..-1..1
        eyeOpen = Math.abs(eyeOpen)
      }
    }

    // 重画脸（保持低频：状态变化或眨眼中）
    if (stateChanged || eyeOpen < 1) {
      this.drawFace(state, eyeOpen)
    }

    // 应用变换：hop + squash
    this.bodyGroup.y = hopY
    const sx = 1 - squash * 0.5
    const sy = 1 + squash
    this.bodyGroup.scale.set(sx, sy)
    this.bodyGroup.rotation = rotation

    // 影子随高度缩放
    const hopRatio = Math.min(1, Math.abs(hopY) / (this.baseSize * 0.6))
    this.shadow.scale.set(1 - hopRatio * 0.4, 1)
    this.shadow.alpha = 0.18 * (1 - hopRatio * 0.5)

    this.alpha = alpha
  }
}

function lighten(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + 255 * amount)
  const g = Math.min(255, ((color >> 8) & 0xff) + 255 * amount)
  const b = Math.min(255, (color & 0xff) + 255 * amount)
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
}

function darken(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) - 255 * amount)
  const g = Math.max(0, ((color >> 8) & 0xff) - 255 * amount)
  const b = Math.max(0, (color & 0xff) - 255 * amount)
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
}
