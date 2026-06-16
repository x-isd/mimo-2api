#!/usr/bin/env bun
/**
 * v2-micode2api — 独立可搬运 2API 入口
 *
 * 使用:
 *   1. bun install
 *   2. bun run dev
 *   3. curl http://localhost:4096/v1/chat/completions -d '...'
 */

process.env.AGENT = "1"
process.env.MIMOCODE = "1"
process.env.MIMOCODE_PID = String(process.pid)
process.env.MIMOCODE_DB = ":memory:"

const PORT = parseInt(process.env.PORT || "4096")

async function main() {
  const [{ Log }, { Server }, { Database }] = await Promise.all([
    import("./lib/opencode-lite/util/index"),
    import("./lib/opencode-lite/server/server"),
    import("./lib/opencode-lite/storage/index"),
  ])

  await Log.init({ print: true, dev: true, level: "INFO" })
  Log.Default.info("v2-micode2api", { port: PORT })

  Database.Client()
  Log.Default.info("database ready")

  const server = await Server.listen({ port: PORT, hostname: "0.0.0.0" })
  console.log(`\n  MiMo 2API: http://localhost:${server.port}/v1/chat/completions`)
  console.log(`  Health:    http://localhost:${server.port}/\n`)

  await new Promise(() => {})
}

main().catch((e) => {
  console.error("Fatal:", e)
  process.exit(1)
})
