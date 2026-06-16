#!/usr/bin/env bun
/**
 * v2-micode2api — Docker / Render 部署入口
 *
 * 基于 minimal-entry.ts，只依赖 hono + 标准库。
 * 跳过 effect、ai-sdk、SQLite、Session、LSP、Plugin 全部 opencode 基建。
 *
 * 环境变量：
 *   PORT              监听端口（Render 通过 PORT 环境变量指定，必填）
 *   MIMO_FREE_BASE_URL  MiMo API 地址（默认 https://api.xiaomimimo.com）
 */
import { Hono } from "hono"
import { stream } from "hono/streaming"
import crypto from "crypto"
import os from "os"

const PORT = parseInt(process.env.PORT || "4096")
const BASE_URL = (process.env.MIMO_FREE_BASE_URL || "https://api.xiaomimimo.com").replace(/\/+$/, "")
const BOOTSTRAP_URL = `${BASE_URL}/api/free-ai/bootstrap`
const CHAT_URL = `${BASE_URL}/api/free-ai/openai/chat`
const MIMO_SOURCE = "mimocode-cli-free"
const DEFAULT_MODEL = "mimo-auto"

// ── JWT 管理 ────────────────────────────────────────────────
let jwt: string | null = null
let jwtExp = 0
let jwtReady = false
let jwtPending: Promise<string> | null = null

function getFingerprint(): string {
  return crypto.createHash("sha256").update(
    [os.hostname(), process.platform, process.arch,
      os.cpus()[0]?.model ?? "",
      (() => { try { return os.userInfo().username } catch { return "" } })(),
    ].join("|")
  ).digest("hex")
}

function parseExp(token: string): number {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    return typeof p.exp === "number" ? p.exp * 1000 : Date.now() + 50 * 60_000
  } catch { return Date.now() + 50 * 60_000 }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchJwt(): Promise<string> {
  if (jwt && jwtExp - Date.now() > 300_000) return jwt
  if (jwtPending) return jwtPending

  jwtPending = (async () => {
    for (let delay = 2000; ; delay = Math.min(delay * 2, 60_000)) {
      try {
        const res = await fetch(BOOTSTRAP_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client: getFingerprint() }),
        })
        if (res.status === 429) { console.warn("[jwt]", `429, retry in ${delay}ms`); await sleep(delay); continue }
        if (!res.ok) { console.warn("[jwt]", res.status); await sleep(delay); continue }
        const d = await res.json() as { jwt?: string }
        if (!d.jwt) { await sleep(delay); continue }
        jwt = d.jwt; jwtExp = parseExp(d.jwt); jwtReady = true
        return d.jwt
      } catch (e) {
        console.warn("[jwt] error:", String(e).slice(0, 80))
        await sleep(delay)
      }
    }
  })().finally(() => { jwtPending = null })

  return jwtPending
}

/** 等 JWT 就绪（最多 timeoutMs） */
async function waitForJwt(timeoutMs = 15000): Promise<boolean> {
  if (jwtReady && jwt) return true
  const p = fetchJwt()
  return await Promise.race([
    p.then(() => !!jwt),
    sleep(timeoutMs).then(() => false),
  ])
}

// 首次获取 + 后台每 40 分钟刷新
fetchJwt().then(t => console.log("[jwt]", t ? "ready" : "failed"))
setInterval(() => { fetchJwt().catch(() => {}) }, 40 * 60_000)

function wrappedFetch(url: string, init?: RequestInit): Promise<Response> {
  return (async () => {
    const token = await fetchJwt()
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token}`)
    headers.set("x-mimo-source", MIMO_SOURCE)
    let res = await fetch(url, { ...init, headers })
    if (res.status === 401 || res.status === 403) {
      jwt = null; jwtReady = false
      const nt = await fetchJwt()
      if (nt) {
        headers.set("authorization", `Bearer ${nt}`)
        res = await fetch(url, { ...init, headers })
      }
    }
    return res
  })()
}

// ── Hono 服务器 ──────────────────────────────────────────────
const app = new Hono()

app.get("/", (c) => c.text("MiMo 2API running\n"))

app.get("/debug", (c) => c.json({
  jwt_ready: jwtReady,
  jwt_cached: jwt ? `${jwt.slice(0, 20)}...` : null,
  runtime: `${process.platform}/${process.arch}`,
  bun: typeof Bun !== "undefined",
}))

app.get("/v1/models", (c) => c.json({
  object: "list",
  data: [{
    id: DEFAULT_MODEL, object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "xiaomi", permission: [],
    root: DEFAULT_MODEL, parent: null,
  }],
}))

app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: { message: "invalid JSON", code: "400", type: "invalid_request_error" } }, 400)
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: { message: "messages required", code: "400", type: "invalid_request_error" } }, 400)
  }

  // 等 JWT 就绪
  const ok = await waitForJwt(15000)
  if (!ok) {
    return c.json({ error: { message: "JWT not available — bootstrap still retrying", code: "503", type: "server_error" } }, 503)
  }

  const isStream = body.stream === true
  const chatUrl = `${CHAT_URL}/chat`

  console.log("[chat]", `model=${body.model || DEFAULT_MODEL}, stream=${isStream}, msgs=${body.messages.length}`)

  const mimoRes = await wrappedFetch(chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: body.model || "mimo-auto",
      messages: body.messages,
      stream: isStream,
      max_tokens: body.max_tokens ?? 4096,
    }),
  })

  if (!mimoRes.ok) {
    const text = await mimoRes.text().catch(() => "unknown error")
    console.warn("[chat]", `upstream ${mimoRes.status}: ${text.slice(0, 200)}`)
    return c.json({
      error: { message: text, code: String(mimoRes.status), type: "upstream_error" },
    }, mimoRes.status as any)
  }

  if (isStream) {
    // 流式：透传上游 SSE
    return c.newResponse(mimoRes.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      },
    })
  }

  const data = await mimoRes.json()
  return c.json(data)
})

export default app

// ── 启动 ─────────────────────────────────────────────────────
const server = Bun.serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" })
console.log(`\n  MiMo 2API: http://localhost:${server.port}/v1/chat/completions`)
console.log(`  Health:    http://localhost:${server.port}/`)
console.log(`  Debug:     http://localhost:${server.port}/debug\n`)
