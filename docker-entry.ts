#!/usr/bin/env bun
/**
 * v2-micode2api — 极简入口（Docker/Render 版本）
 *
 * 仅依赖：hono + 标准库
 * 跳过：effect、ai-sdk、SQLite、Session、LSP、Plugin 等全部 opencode 基建
 * 
 * 此版本直接复制自原项目 minimal-entry.ts，只修改了启动方式以兼容 Render
 */
import { Hono } from "hono"
import crypto from "crypto"
import os from "os"

const PORT = parseInt(process.env.PORT || "4096")
const BASE_URL = (process.env.MIMO_FREE_BASE_URL || "https://api.xiaomimimo.com").replace(/\/+$/, "")
const BOOTSTRAP_URL = `${BASE_URL}/api/free-ai/bootstrap`
const CHAT_URL = `${BASE_URL}/api/free-ai/openai/chat`
const MIMO_SOURCE = "mimocode-cli-free"

// ── JWT 管理 ────────────────────────────────────────────────
let jwt: string | null = null
let jwtExp = 0
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
        jwt = d.jwt; jwtExp = parseExp(d.jwt)
        return d.jwt
      } catch (e) {
        console.warn("[jwt] error:", String(e).slice(0, 80))
        await sleep(delay)
      }
    }
  })().finally(() => { jwtPending = null })

  return jwtPending
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
      jwt = null; const nt = await fetchJwt()
      headers.set("authorization", `Bearer ${nt}`)
      res = await fetch(url, { ...init, headers })
    }
    return res
  })()
}

// ── Hono 服务器 ──────────────────────────────────────────────
const app = new Hono()

app.get("/", (c) => c.text("MiMo 2API running\n"))

// 调试端点
app.get("/debug", (c) => {
  const now = Date.now()
  return c.json({
    jwt_ready: !!jwt,
    jwt_expire: jwt ? new Date(jwtExp).toISOString() : null,
    jwt_remain_ms: jwt ? Math.max(0, jwtExp - now) : 0,
    fingerprint: getFingerprint(),
    config: {
      base_url: BASE_URL,
      bootstrap_url: BOOTSTRAP_URL,
      chat_url: CHAT_URL,
      mimo_source: MIMO_SOURCE,
      port: PORT
    }
  })
})

// 模型列表
app.get("/v1/models", (c) => {
  return c.json({
    object: "list",
    data: [
      {
        id: "mimo-auto",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "xiaomi"
      }
    ]
  })
})

app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json()
  const isStream = body.stream === true
  const chatUrl = `${CHAT_URL}/chat`

  console.log("[chat] request:", { url: chatUrl, model: body.model || "mimo-auto", stream: isStream })

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

  console.log("[chat] response:", mimoRes.status, mimoRes.statusText)

  if (!mimoRes.ok) {
    const text = await mimoRes.text().catch(() => "unknown error")
    console.error("[chat] error body:", text)
    return c.json({ error: { message: text, status: mimoRes.status } }, mimoRes.status as any)
  }

  if (isStream) {
    return c.newResponse(mimoRes.body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  const data = await mimoRes.json()
  return c.json(data)
})

// ── 导出（Render Bun 运行时格式）─────────────────────────
export default {
  port: PORT,
  fetch: app.fetch,
}

console.log(`\n  MiMo 2API: http://localhost:${PORT}/v1/chat/completions`)
console.log(`  Health:    http://localhost:${PORT}/\n`)
