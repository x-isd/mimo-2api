/**
 * Docker/Render 部署入口
 * 
 * 基于 minimal-entry.ts 的极简实现，只依赖 hono + Node.js 内置模块
 * 
 * 核心功能：
 * 1. JWT 获取与保活（单例 + 5分钟提前续期 + 40分钟后台续期）
 * 2. wrappedFetch：自动注入 JWT + X-Mimo-Source，处理 401/403 重试
 * 3. /v1/chat/completions：真实流式转发（透传上游 SSE）
 * 4. /v1/models：返回固定模型列表
 * 5. /debug：调试端点，显示 JWT 状态和运行时信息
 */

import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { createHash, randomBytes } from 'node:crypto'
import { hostname, arch, platform } from 'node:os'

const app = new Hono()

// ===== 配置 =====
const MIMO_FREE_BASE_URL = process.env.MIMO_FREE_BASE_URL || 'https://api.xiaomimimo.com'
const BOOTSTRAP_URL = `${MIMO_FREE_BASE_URL}/v1/agent/bootstrap`
const CHAT_URL = `${MIMO_FREE_BASE_URL}/v1/agent/chat`
const PORT = process.env.PORT || 4096

// ===== JWT 状态管理 =====
let jwt: string | null = null
let jwtExpire = 0
let fetchingPromise: Promise<string> | null = null

/**
 * 生成设备指纹（基于主机名 + 架构 + 时间戳）
 */
function getFingerprint(): string {
  const raw = `${hostname()}-${arch()}-${platform()}-${Date.now()}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

/**
 * 获取 JWT（带单例保护 + 指数退避重试）
 */
async function fetchJwt(): Promise<string> {
  const now = Date.now()
  
  // 如果 JWT 仍有效（距离过期 > 5 分钟），直接返回
  if (jwt && jwtExpire - now > 5 * 60 * 1000) {
    return jwt
  }

  // 单例保护：如果正在获取，复用 Promise
  if (fetchingPromise) {
    return fetchingPromise
  }

  fetchingPromise = (async () => {
    const fingerprint = getFingerprint()
    const deviceId = randomBytes(16).toString('hex')
    
    let attempt = 0
    const maxAttempts = 3

    while (attempt < maxAttempts) {
      attempt++
      try {
        const res = await fetch(BOOTSTRAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fingerprint,
            deviceId,
            platform: 'web'
          })
        })

        if (!res.ok) {
          throw new Error(`Bootstrap failed: ${res.status} ${res.statusText}`)
        }

        const data = await res.json() as any
        if (!data?.jwt) {
          throw new Error('No JWT in response')
        }

        jwt = data.jwt
        jwtExpire = Date.now() + 50 * 60 * 1000 // 假设 JWT 有效期 50 分钟
        console.log(`[JWT] 获取成功，过期时间: ${new Date(jwtExpire).toISOString()}`)
        return jwt
      } catch (err: any) {
        console.error(`[JWT] 获取失败 (attempt ${attempt}/${maxAttempts}):`, err.message)
        if (attempt < maxAttempts) {
          const backoff = Math.pow(2, attempt) * 1000
          console.log(`[JWT] ${backoff}ms 后重试...`)
          await new Promise(resolve => setTimeout(resolve, backoff))
        }
      }
    }

    throw new Error('Failed to fetch JWT after retries')
  })()

  try {
    const result = await fetchingPromise
    return result
  } finally {
    fetchingPromise = null
  }
}

/**
 * 后台 JWT 续期任务（每 40 分钟触发一次）
 */
setInterval(() => {
  console.log('[JWT] 后台续期任务触发')
  fetchJwt().catch(err => console.error('[JWT] 后台续期失败:', err))
}, 40 * 60 * 1000)

/**
 * 包装的 fetch：自动注入 JWT + X-Mimo-Source，处理 401/403 重试
 */
async function wrappedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await fetchJwt()
  
  const headers = new Headers(init.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-Mimo-Source', 'opencode')

  let res = await fetch(url, { ...init, headers })

  // 如果遇到 401/403，清空 JWT 并重试一次
  if (res.status === 401 || res.status === 403) {
    console.warn(`[wrappedFetch] 收到 ${res.status}，清空 JWT 并重试`)
    jwt = null
    jwtExpire = 0
    const newToken = await fetchJwt()
    headers.set('Authorization', `Bearer ${newToken}`)
    res = await fetch(url, { ...init, headers })
  }

  return res
}

/**
 * 等待 JWT 就绪的辅助函数（用于聊天请求前的预检）
 */
async function waitForJwt(): Promise<boolean> {
  try {
    await fetchJwt()
    return true
  } catch {
    return false
  }
}

// ===== 路由 =====

/**
 * 健康检查（Render 需要）
 */
app.get('/', (c) => c.json({ status: 'ok', service: 'v2-micode2api-docker' }))

/**
 * 调试端点：显示 JWT 状态和运行时信息
 */
app.get('/debug', (c) => {
  const now = Date.now()
  return c.json({
    jwt_ready: !!jwt,
    jwt_cached: !!jwt,
    jwt_expire: jwt ? new Date(jwtExpire).toISOString() : null,
    jwt_remain_ms: jwt ? Math.max(0, jwtExpire - now) : 0,
    runtime: {
      bun_version: process.versions.bun || 'unknown',
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: hostname()
    },
    config: {
      mimo_base_url: MIMO_FREE_BASE_URL,
      port: PORT
    }
  })
})

/**
 * 模型列表端点
 */
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: 'gpt-4o-mini',
        object: 'model',
        created: 1686935002,
        owned_by: 'openai'
      }
    ]
  })
})

/**
 * 聊天补全端点（流式 + 非流式）
 */
app.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json()
    const isStream = body.stream ?? false

    // 确保 JWT 已就绪
    const ready = await waitForJwt()
    if (!ready) {
      return c.json({ error: { code: '500', message: 'JWT not ready', type: 'internal_error' } }, 500)
    }

    // 转发请求到上游
    const res = await wrappedFetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[chat] 上游返回错误: ${res.status} ${text}`)
      return c.json(
        { error: { code: String(res.status), message: text || res.statusText, type: 'upstream_error' } },
        res.status
      )
    }

    if (isStream) {
      // 流式：透传上游 SSE
      return stream(c, async (writer) => {
        const reader = res.body?.getReader()
        if (!reader) {
          await writer.write('data: {"error":"No response body"}\n\n')
          return
        }

        const decoder = new TextDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            const chunk = decoder.decode(value, { stream: true })
            await writer.write(chunk)
          }
        } catch (err: any) {
          console.error('[chat] 流式传输错误:', err)
          await writer.write(`data: {"error":"${err.message}"}\n\n`)
        }
      })
    } else {
      // 非流式：直接返回 JSON
      const data = await res.json()
      return c.json(data)
    }
  } catch (err: any) {
    console.error('[chat] 请求处理错误:', err)
    return c.json(
      { error: { code: '500', message: err.message, type: 'internal_error' } },
      500
    )
  }
})

// ===== 启动服务 =====
console.log(`[启动] v2-micode2api-docker on port ${PORT}`)
console.log(`[配置] MIMO_FREE_BASE_URL=${MIMO_FREE_BASE_URL}`)

// 预热 JWT（后台启动，不阻塞服务启动）
fetchJwt().then(
  () => console.log('[启动] JWT 预热成功'),
  (err) => console.error('[启动] JWT 预热失败:', err)
)

export default {
  port: PORT,
  fetch: app.fetch
}
