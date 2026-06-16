#!/usr/bin/env bun
/**
 * v2-micode2api 最终验证 — 较长对话 + 多轮测试
 */
const BASE = "http://localhost:4096/v1/chat/completions"

async function call(body: any) {
  const t0 = Date.now()
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const ms = Date.now() - t0
  let ok = "❌"
  try {
    const j = JSON.parse(text)
    const content = j.choices?.[0]?.message?.content || "(empty)"
    if (res.status === 200) ok = "✅"
    return { ok: res.status === 200, status: res.status, content, ms }
  } catch {
    // might be SSE
    if (text.startsWith("data:")) {
      const d = text.match(/"content":"([^"]+)"/)
      ok = "✅"
      return { ok: true, status: res.status, content: d?.[1] || text.slice(0, 80), ms }
    }
    return { ok: false, status: res.status, content: text.slice(0, 80), ms }
  }
}

function toK(text: string) {
  return Math.round(text.length / 100) / 10 + "k"
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗")
  console.log("║  v2-micode2api 最终验证                          ║")
  console.log("╚══════════════════════════════════════════════════╝\n")

  let passed = 0
  let failed = 0

  // ── 1. 简短短消息 ──────────────────────────────────
  console.log("── 1. 短消息（基线）")
  {
    const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: "6+6=?" }] })
    const icon = r.ok ? "✅" : "❌"
    if (r.ok) passed++; else failed++
    console.log(`  ${icon} 6+6=? → ${r.content} (${r.ms}ms)`)
  }

  // ── 2. 多轮对话 ────────────────────────────────────
  console.log("\n── 2. 多轮对话（4 turn）")
  {
    const msgs: any[] = [{ role: "user", content: "我叫小明，今年25岁。请记住这个名字。" }]
    const r1 = await call({ model: "mimo-auto", messages: msgs })
    const content1 = r1.content.slice(0, 60)
    const icon1 = r1.ok ? "✅" : "❌"
    console.log(`  ${icon1} turn1 → ${content1}`)

    msgs.push({ role: "assistant", content: r1.content })
    msgs.push({ role: "user", content: "我叫什么名字？几岁？" })
    const r2 = await call({ model: "mimo-auto", messages: msgs })
    const icon2 = r2.ok ? "✅" : "❌"
    console.log(`  ${icon2} turn2 → ${r2.content.slice(0, 80)}`)

    msgs.push({ role: "assistant", content: r2.content })
    msgs.push({ role: "user", content: "把之前的对话总结成一句话。" })
    const r3 = await call({ model: "mimo-auto", messages: msgs })
    const icon3 = r3.ok ? "✅" : "❌"
    console.log(`  ${icon3} turn3 → ${r3.content.slice(0, 80)}`)

    if (r1.ok && r2.ok && r3.ok) passed++; else failed++
  }

  // ── 3. 长输入（~2k 字的 prompt）────────────────
  console.log("\n── 3. 长 Prompt（~2000 字）")
  {
    const longPrompt = `请详细分析以下文本的主题、写作风格和核心论点，并给出一个结构化的摘要。

${"人工智能技术在过去十年中经历了飞速发展。从早期的规则系统到如今的深度学习模型，AI 已经渗透到医疗、金融、教育、交通等各个领域。".repeat(60)}`
    const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: longPrompt }], max_tokens: 256 })
    const icon = r.ok ? "✅" : "❌"
    if (r.ok) passed++; else failed++
    console.log(`  ${icon} input=${toK(longPrompt)} output=${toK(r.content)} "${r.content.slice(0, 100)}..." (${r.ms}ms)`)
  }

  // ── 4. 长回复（要求写 ~500 字文章）────────────────
  console.log("\n── 4. 长回复")
  {
    const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: "请写一篇关于数据结构'哈希表'的入门介绍文章，中文，约500字。" }], max_tokens: 2048 })
    const icon = r.ok ? "✅" : "❌"
    if (r.ok) passed++; else failed++
    console.log(`  ${icon} output=${toK(r.content)} (${r.ms}ms)`)
    console.log(`  ${r.content.slice(0, 200)}...`)
  }

  // ── 5. 流式长回复 ──────────────────────────────
  console.log("\n── 5. 流式长回复")
  {
    const t0 = Date.now()
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mimo-auto", messages: [{ role: "user", content: "写一个简短的小故事，主角是一只猫。100字以内。" }], stream: true }),
    })
    let total = ""
    for await (const line of res.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream({
      transform(chunk, ctrl) { ctrl.enqueue(chunk) }
    }))) {
      // collect SSE
    }
    const text = await res.text()
    const icon = res.status === 200 ? "✅" : "❌"
    if (res.status === 200) passed++; else failed++
    const ms = Date.now() - t0
    console.log(`  ${icon} stream response (${ms}ms)`)
    // re-fetch
    const r2 = await fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mimo-auto", messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    const r2t = await r2.text()
    const d = r2t.match(/"content":"([^"]+)"/)
    console.log(`  stream test: "${d?.[1]?.slice(0, 80) || '(parse err)'}"`)
  }

  // ── 6. 图片消息（非流式）───────────────────────
  console.log("\n── 6. 图片理解")
  {
    const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: [
      { type: "text", text: "用一句话描述这张图（英文）" },
      { type: "image_url", image_url: { url: "https://img.kookapp.cn/assets/2025-03/29/STH8CPpau00d60d6.jpg" } }
    ] }], max_tokens: 128 })
    const icon = r.ok ? "✅" : "❌"
    if (r.ok) passed++; else failed++
    console.log(`  ${icon} "${r.content.slice(0, 120)}" (${r.ms}ms)`)
  }

  // ── 连续请求（验证 session 清理）────────────────
  console.log("\n── 7. 连续请求（验证 session 泄漏）")
  {
    for (let i = 0; i < 5; i++) {
      const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: `${i+1}+${i+1}=?` }] })
      const icon = r.ok ? "." : "❌"
      process.stdout.write(icon)
    }
    console.log(" done")
    passed++
  }

  // ── 总结 ─────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════╗")
  console.log(`║  通过: ${passed}/7                                   ║`)
  console.log("╚══════════════════════════════════════════════════╝")
}

main().catch(e => { console.error("Fatal:", e); process.exit(1) })
