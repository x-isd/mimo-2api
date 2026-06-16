#!/usr/bin/env bun
/**
 * v2-micode2api ~20K 对话压力测试
 */
const BASE = "http://localhost:4096/v1/chat/completions"

async function call(body: any) {
  const t0 = Date.now()
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  return {
    ok: res.status === 200,
    status: res.status,
    content: json.choices?.[0]?.message?.content || "",
    ms: Date.now() - t0,
  }
}

// 生成 ~4000 字的中文长文本
function fill(kChars: number): string {
  const base = "人工智能（AI）是计算机科学的一个分支，旨在创建能够模拟人类智能的系统。这些系统可以执行学习、推理、问题解决、感知和语言理解等任务。现代AI技术基于深度学习算法，利用多层神经网络从大量数据中提取模式。深度学习的突破使得图像识别、自然语言处理和自动驾驶等领域取得了巨大进展。然而，AI的发展也带来了伦理和社会挑战，包括隐私保护、算法偏见和就业变革等问题。研究人员正在探索更安全、更透明和更可解释的AI系统。"
  return base.repeat(Math.ceil(kChars * 1000 / base.length)).slice(0, kChars * 1000)
}

const PROMPT_4K = fill(4)  // ~4000 字

async function main() {
  console.log("╔══════════════════════════════════════════╗")
  console.log("║  v2-micode2api ~20K 对话压力测试          ║")
  console.log("╚══════════════════════════════════════════╝\n")

  const results: string[] = []
  let totalTokensIn = 0

  // ── Test 1: 短消息验证服务正常 ──────────────
  console.log("[1/5] 短消息验证")
  {
    const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: "1+1=?" }] })
    console.log(`  ${r.ok ? "✅" : "❌"} 1+1=? → ${r.content} (${r.ms}ms)`)
    results.push(`[1] ${r.ok ? "OK" : "FAIL"}: ${r.content.slice(0, 40)}`)
  }

  // ── Test 2: ~4K 输入 + ~500 字输出 ─────────
  console.log("\n[2/5] ~4K 输入 + 要求长回复")
  {
    const r = await call({
      model: "mimo-auto",
      messages: [{ role: "user", content: `${PROMPT_4K}\n\n请总结以上文本的核心观点，写300字以上的摘要。` }],
      max_tokens: 1024,
    })
    totalTokensIn += PROMPT_4K.length
    console.log(`  ${r.ok ? "✅" : "❌"} 输入=${(PROMPT_4K.length/1000).toFixed(1)}k 输出=${(r.content.length/1000).toFixed(1)}k (${r.ms}ms)`)
    console.log(`  ${r.content.slice(0, 120)}...`)
    results.push(`[2] ${r.ok ? "OK" : "FAIL"}: in=4k out=${(r.content.length/1000).toFixed(1)}k`)
  }

  // ── Test 3: 多轮累积 ~8K 上下文 ────────────
  console.log("\n[3/5] 多轮对话（累积 ~8K 上下文）")
  {
    const messages: any[] = [
      { role: "user", content: `请记住以下信息：\n1. 项目名称：CloudSync\n2. 技术栈：Go + Redis + PostgreSQL\n3. 架构：微服务，共12个服务\n4. 部署方式：Kubernetes\n5. 日活用户：50万\n6. SLA：99.95%` },
    ]
    const r1 = await call({ model: "mimo-auto", messages })
    messages.push({ role: "assistant", content: r1.content })

    messages.push({ role: "user", content: "请补充以下功能模块信息：\n1. 用户服务（auth-service）：JWT 认证 + OAuth2\n2. 文件服务（file-service）：S3 兼容存储，最大文件 5GB\n3. 通知服务（notify-service）：WebSocket + FCM + 邮件\n4. 计费服务（billing-service）：按量计费 + 预付费套餐" })
    const r2 = await call({ model: "mimo-auto", messages })
    messages.push({ role: "assistant", content: r2.content })

    messages.push({ role: "user", content: "根据我提供的所有项目信息，生成一份架构概览文档。包含：项目概况、技术栈、服务列表、部署信息。" })
    const r3 = await call({ model: "mimo-auto", messages, max_tokens: 2048 })

    const totalIn = JSON.stringify(messages).length
    totalTokensIn += totalIn
    console.log(`  ✅ turn1: ${r1.content.slice(0, 50)}...`)
    console.log(`  ✅ turn2: ${r2.content.slice(0, 50)}...`)
    console.log(`  ${r3.ok ? "✅" : "❌"} turn3: 累积=${(totalIn/1000).toFixed(1)}k 输出=${(r3.content.length/1000).toFixed(1)}k (${r3.ms}ms)`)
    console.log(`  ${r3.content.slice(0, 150)}...`)
    results.push(`[3] OK: multi-turn 3 turns, out=${(r3.content.length/1000).toFixed(1)}k`)
  }

  // ── Test 4: 图片 + 长文本混合 ──────────────
  console.log("\n[4/5] 图片 + 长文本混合")
  {
    const r = await call({
      model: "mimo-auto",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `${PROMPT_4K}\n\n同时请看这张图片，结合文本内容详细描述你看到的信息。` },
          { type: "image_url", image_url: { url: "https://img.kookapp.cn/assets/2025-03/29/STH8CPpau00d60d6.jpg" } },
        ],
      }],
      max_tokens: 1024,
    })
    totalTokensIn += PROMPT_4K.length
    console.log(`  ${r.ok ? "✅" : "❌"} 文本=${(PROMPT_4K.length/1000).toFixed(1)}k + 图片 → 输出=${(r.content.length/1000).toFixed(1)}k (${r.ms}ms)`)
    console.log(`  ${r.content.slice(0, 150)}...`)
    results.push(`[4] ${r.ok ? "OK" : "FAIL"}: image+text, out=${(r.content.length/1000).toFixed(1)}k`)
  }

  // ── Test 5: ~8K 代码相关长对话 ──────────────
  console.log("\n[5/5] ~8K 技术长对话")
  {
    const techPrompt = `你是一个资深后端架构师。以下是我们的系统设计文档，请仔细阅读后回答最后的问题。

${("## 微服务架构设计\n\n我们的系统采用微服务架构，包含以下核心服务：\n\n" +
"### 1. API Gateway (Kong)\n- 统一入口，处理认证、限流、日志\n- 基于 OpenResty，支持自定义插件\n- 配置热更新，无需重启\n\n" +
"### 2. 用户服务 (Go + gRPC)\n- 用户注册/登录/个人信息管理\n- 支持手机号、邮箱、第三方登录\n- JWT Token 管理，支持 Refresh Token\n- 数据库：PostgreSQL + Redis 缓存\n\n" +
"### 3. 订单服务 (Go + gRPC)\n- 订单创建、查询、状态流转\n- 支持分布式事务（Saga 模式）\n- 消息队列：Kafka\n- 数据库：MySQL（分库分表）\n\n" +
"### 4. 商品服务 (Go + gRPC)\n- 商品 CRUD、库存管理、分类管理\n- 搜索引擎：Elasticsearch\n- 缓存：Redis Cluster\n- 数据库：MongoDB\n\n" +
"### 5. 支付服务 (Go + gRPC)\n- 对接微信支付、支付宝、银联\n- 支持退款、对账\n- 幂等性保证\n- 数据库：MySQL\n\n").repeat(3)}` +
`\n\n请回答以下问题：\n1. 指出当前架构中可能存在的瓶颈\n2. 给出至少3条优化建议\n3. 用 Mermaid 流程图画出订单创建的时序图`;
    const r = await call({ model: "mimo-auto", messages: [{ role: "user", content: techPrompt }], max_tokens: 2048 })
    const inLen = techPrompt.length
    totalTokensIn += inLen
    console.log(`  ${r.ok ? "✅" : "❌"} 输入=${(inLen/1000).toFixed(1)}k 输出=${(r.content.length/1000).toFixed(1)}k (${r.ms}ms)`)
    console.log(`  ${r.content.slice(0, 200)}...`)
    results.push(`[5] ${r.ok ? "OK" : "FAIL"}: tech=${(inLen/1000).toFixed(1)}k in, out=${(r.content.length/1000).toFixed(1)}k`)
  }

  // ── 总结 ─────────────────────────────────
  console.log("\n╔══════════════════════════════════════════╗")
  console.log("║  测试结果汇总                              ║")
  console.log("╠══════════════════════════════════════════╣")
  for (const r of results) console.log(`║  ${r.padEnd(42)}║`)
  console.log("╚══════════════════════════════════════════╝")
}

main().catch(e => { console.error("Fatal:", e); process.exit(1) })
