#!/usr/bin/env bun
/**
 * v2-micode2api — 极简入口（只加载 session 路由 + InstanceMiddleware）
 *
 * 跳过：ProjectRoutes、PtyRoutes、McpRoutes、WorkflowRoutes、FileRoutes
 *       ConfigRoutes、ProviderRoutes、PermissionRoutes、EventRoutes
 *       SyncRoutes、QuestionRoutes、BashInteractiveRoutes、ExperimentalRoutes
 *       ControlPlaneRoutes、WorkspaceRoutes、UIRoutes、GlobalRoutes
 *       FenceMiddleware、WorkspaceRouterMiddleware、projectors、mdns
 */
import { Hono } from "hono"
import { adapter } from "#hono"
import { Log } from "@/util"
import { InstanceMiddleware } from "./lib/opencode-lite/server/routes/instance/middleware"
import { SessionRoutes } from "./lib/opencode-lite/server/routes/session"
import { Database } from "./lib/opencode-lite/storage"

const PORT = parseInt(process.env.PORT || "4096")

await Log.init({ print: true, dev: true, level: "INFO" })
Log.Default.info("v2-micode2api", { port: PORT })

Database.Client()
Log.Default.info("database ready")

const app = new Hono()
  .use(InstanceMiddleware())
  .route("/session", SessionRoutes())
  .post("/v1/chat/completions", async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body) return c.json({ error: "invalid JSON" }, 400)

    const lastUser = (body.messages || []).findLast((m: any) => m.role === "user")
    if (!lastUser) return c.json({ error: "no user message" }, 400)

    const content = lastUser.content
    const parts = Array.isArray(content)
      ? content.flatMap((p: any) => {
          if (p.type === "text") return [{ type: "text", text: p.text }]
          if (p.type === "image_url") {
            const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url
            if (!u) return []
            const mime = u.startsWith("data:") ? u.slice(5, u.indexOf(";")) : "image/jpeg"
            return [{ type: "file", mime, url: u }]
          }
          return []
        })
      : [{ type: "text", text: String(content) }]
    if (!parts.some((p: any) => p.type === "text")) {
      parts.unshift({ type: "text", text: "describe this image" })
    }

    const origin = `http://localhost:${PORT}`
    const sr = await fetch(`${origin}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mimo/mimo-auto", title: "api" }),
    })
    if (!sr.ok) return c.json({ error: "session failed", status: sr.status }, 500)
    const s = await sr.json() as any

    const mr = await fetch(`${origin}/session/${s.id}/message`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ parts }),
    })
    fetch(`${origin}/session/${s.id}`, { method: "DELETE" }).catch(() => {})
    if (!mr.ok) return c.json({ error: "message failed", status: mr.status }, 500)

    const md = await mr.json() as any
    const text = (md.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")

    if (body.stream) {
      const enc = new TextEncoder()
      return new Response(new ReadableStream({
        start(ctl) {
          ctl.enqueue(enc.encode(`data: ${JSON.stringify({
            id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model: "mimo-auto",
            choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
          })}\n\n`))
          ctl.enqueue(enc.encode("data: [DONE]\n\n"))
          ctl.close()
        },
      }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } })
    }

    return c.json({
      id: `chatcmpl-${Date.now()}`, object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model: "mimo-auto",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  })
  .get("/", (c) => c.text("MiMo 2API running\n"))

const runtime = adapter.create(app)
const server = await runtime.listen({ port: PORT, hostname: "0.0.0.0" })

console.log(`\n  MiMo 2API: http://localhost:${server.port}/v1/chat/completions`)
console.log(`  Health:    http://localhost:${server.port}/\n`)

await new Promise(() => {})
