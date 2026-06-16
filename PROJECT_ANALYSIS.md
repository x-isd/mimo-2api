# v2-micode2api 项目功能实现流程分析

> 本文档基于对 `v2-micode2api` 整个项目的源码分析，梳理项目的目标、架构、核心模块、请求流转链路以及关键实现细节。

---

## 一、项目概览

**v2-micode2api** 是一个 **2API 网关**，把小米开源的 **MiMo Free API** 包装成 **OpenAI 兼容** 的 `/v1/chat/completions` 端点，对外提供免费的文本 / 多模态（图片）对话能力，支持流式（SSE）和非流式两种响应模式。

| 维度 | 说明 |
|------|------|
| 运行时 | Bun ≥ 1.3.0 |
| 语言 | TypeScript |
| HTTP 框架 | Hono（带 Bun / Node 双适配器） |
| 核心运行时 | opencode-lite（从 MiMoCode 裁剪而来） |
| 数据库 | SQLite `:memory:`（重启即重置） |
| 默认端口 | `4096` |
| 模型 | `mimo-auto`（免费） |

### 1.1 为什么需要这个网关

MiMo Free API 由 **MiFe CDN** 保护，CDN 通过 **TLS 指纹** 做风控。裸 `fetch` 即使带着合法 JWT 也会返回 `403`。受信任的通路必须经过 opencode 完整的 **Effect DI 初始化链**（`Config → Plugin → Provider`），这条链在 `InstanceMiddleware` 首次命中时建立。所以 `/v1/chat/completions` 路由直接挂载在完整的 Hono app 上，复用已有的受信任运行时。

> **注意：** 项目同时提供了一个 `minimal-entry.ts`（极简入口）和 `lib/opencode-lite/plugin/mimo-free.ts`，这两处直接通过 `POST /api/free-ai/bootstrap` 拿 JWT 再直连 chat 端点，不走完整 Effect 链。这表明**直连方式在大多数情况下也能工作**，是 Deno 移植的关键参考路径。

---

## 二、目录结构

```
v2-micode2api/
├── entry.ts              — 生产/开发入口（加载完整 opencode-lite 运行时）
├── entry-minimal.ts      — 极简入口（只挂 session 路由 + InstanceMiddleware）
├── minimal-entry.ts      — 最精简入口（纯 Hono + 直连 MiMo，绕过 Effect/ai-sdk/SQLite）
├── package.json          — 依赖声明
├── tsconfig.json         — TypeScript 配置
├── README.md
├── 2048.html / game.py   — 测试/演示用，非核心
├── test-20k.ts / test-final.ts — 功能验证脚本
├── dist/
│   └── bundle.js         — bun build 产物（单文件，~13MB）
├── lib/
│   ├── opencode-lite/    — 裁剪后的 opencode 核心源码
│   ├── plugin/           — @mimo-ai/plugin
│   ├── shared/           — @mimo-ai/shared
│   ├── script/           — @mimo-ai/script
│   └── sdk/              — @mimo-ai/sdk
└── migration/            — SQLite schema 迁移文件（34 个）
```

### 2.1 `lib/opencode-lite` 内部分层

| 目录 | 作用 |
|------|------|
| `server/` | Hono 服务器、路由、中间件、adapter（bun/node） |
| `session/` | 会话管理、LLM 调用、prompt 编排、压缩、回滚、check-point |
| `provider/` | Provider 注册表、模型解析、ai-sdk 集成、SSE 超时包装 |
| `plugin/` | 插件系统，含 `mimo-free`（核心）和 `mimo`（OAuth 登录） |
| `storage/` | SQLite 数据库（bun/node 双实现） + schema |
| `config/` | 全局配置、agent 配置、permission、keybinds 等 |
| `effect/` | Effect DI 运行时、runner、bridge、instance registry |
| `tool/` | 大量内置工具（read / edit / bash / grep / glob / task 等） |
| `account/` `actor/` `task/` `inbox/` `history/` `memory/` 等 | 支撑模块 |

---

## 三、三种入口对比

项目提供了三个入口，复杂度由高到低：

### 3.1 `entry.ts`（完整入口，推荐生产）

```
加载完整 opencode-lite 运行时
  → Log.init
  → Database.Client()（:memory: SQLite）
  → Server.listen({ port })
    → create() 内部组装完整 Hono app：
        - 各类中间件（Auth/Logger/Compression/Cors）
        - GlobalRoutes / ControlPlaneRoutes
        - InstanceMiddleware（懒加载 InstanceBootstrap）
        - InstanceRoutes（含 SessionRoutes）
        - UIRoutes
        - POST /v1/chat/completions（2api 网关）
```

启动时设置环境变量：`AGENT=1`、`MIMOCODE=1`、`MIMOCODE_PID`、`MIMOCODE_DB=:memory:`。

### 3.2 `entry-minimal.ts`（精简入口）

只挂 `InstanceMiddleware` + `SessionRoutes` + `/v1/chat/completions`，跳过 ProjectRoutes、PtyRoutes、McpRoutes、WorkflowRoutes、FileRoutes 等大量路由。但仍依赖 Effect DI 和 SQLite。

### 3.3 `minimal-entry.ts`（最精简入口，Deno 移植蓝本）

**只依赖 hono + Node 标准库**，完全绕过：
- effect（Effect DI）
- ai-sdk（Vercel AI SDK）
- SQLite / Session 系统
- LSP、Plugin 基建

直接：
1. `POST {BASE_URL}/api/free-ai/bootstrap` 拿 JWT
2. `POST {BASE_URL}/api/free-ai/openai/chat` 发消息（带 JWT 和 `X-Mimo-Source` 头）
3. JWT 后台每 40 分钟刷新

**这是 Deno 移植的核心参考。**

---

## 四、核心功能实现流程

### 4.1 JWT 获取与保活（`minimal-entry.ts` + `plugin/mimo-free.ts`）

```
                    ┌─────────────────────────────────────┐
                    │  fingerprint = sha256(hostname |    │
                    │    platform | arch | cpu.model |    │
                    │    username)                        │
                    └────────────────┬────────────────────┘
                                     │
                                     ▼
            POST {BASE}/api/free-ai/bootstrap
            body: { client: fingerprint }
            headers: { content-type: application/json }
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                       429/!ok                 ok
                          │                     │
                  指数退避重试              { jwt: "..." }
                  (2s → 4s → ... 60s)          │
                                                ▼
                                    parseExp(jwt) 从 payload.exp
                                    算过期时间（默认 50 分钟）
                                                │
                                                ▼
                                    缓存 cachedJwt + jwtExp
```

**关键点：**
- **去重并发**：`jwtInflight` 单飞，多个请求共享同一个 JWT 获取 promise。
- **提前续期**：剩余 < 5 分钟就重新获取（`jwtExp - Date.now() > 5*60_000`）。
- **后台保活**：`keepalive()` 每 40 分钟主动刷新（JWT 50 分钟过期，40 分钟刷新）。
- **失败自愈**：bootstrap 持续重试，永不放弃。

### 4.2 注入认证的 `wrappedFetch`

```typescript
async function wrappedFetch(url, init) {
  const jwt = await fetchJwt()           // 1. 拿 JWT
  headers.set("Authorization", `Bearer ${jwt}`)
  headers.set("X-Mimo-Source", "mimocode-cli-free")
  // 2. 路径重写：/chat/completions → /chat
  const rewritten = url.replace(/\/chat\/completions(\?|$)/, "/chat$1")
  let res = await fetch(rewritten, { ...init, headers })
  // 3. 401/403 → 刷新 JWT 后重试一次
  if (res.status === 401 || res.status === 403) {
    cachedJwt = null
    const nj = await fetchJwt()
    headers.set("Authorization", `Bearer ${nj}`)
    res = await fetch(rewritten, { ...init, headers })
  }
  return res
}
```

### 4.3 实际请求的端点

| 用途 | 方法 | URL |
|------|------|-----|
| 拿 JWT | POST | `{BASE_URL}/api/free-ai/bootstrap` |
| 对话 | POST | `{BASE_URL}/api/free-ai/openai/chat` |

`BASE_URL` 默认 `https://api.xiaomimimo.com`，可用 `MIMO_FREE_BASE_URL` 覆盖。

### 4.4 完整入口下的 `/v1/chat/completions` 请求流（`server.ts`）

```
curl → POST /v1/chat/completions
  │
  ▼
Hono app（已挂 InstanceMiddleware）
  │
  ├── 1. 解析 body，取最后一条 user 消息
  │      OpenAI content 可能是 string 或 part 数组
  │
  ├── 2. content → PromptInput.parts 转换：
  │      - string / {type:"text"}       → [{type:"text", text}]
  │      - {type:"image_url"}           → [{type:"file", mime, url}]
  │      - 纯图片时补一句 "describe this image"
  │
  ├── 3. 同进程回环（in-process loopback）：
  │      POST http://{host}/session
  │        body: { model: "mimo/mimo-auto", title: "api" }
  │      → 拿到临时 session.id
  │
  ├── 4. POST http://{host}/session/{id}/message
  │        headers: { Accept: application/json }  （非流式整段返回）
  │        body: { parts }
  │      → 走 provider stack → wrappedFetch → MiMo API
  │
  ├── 5. DELETE http://{host}/session/{id}  （异步清理，不阻塞）
  │
  └── 6. 包装成 OpenAI 格式返回：
         - stream=false → chat.completion JSON
         - stream=true  → 单 chunk SSE（伪流式）
```

### 4.5 SessionRoutes 的核心路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/session` | 列出所有 session |
| POST | `/session` | 创建 session（`SessionShare.create`） |
| GET | `/session/:id` | 获取 session 详情 |
| DELETE | `/session/:id` | 删除 session |
| PATCH | `/session/:id` | 更新 title/permission |
| POST | `/session/:id/message` | **发消息（核心，流式响应）** |
| POST | `/session/:id/prompt_async` | 异步发消息 |
| POST | `/session/:id/command` | 发命令 |
| POST | `/session/:id/abort` | 中止 |
| POST | `/session/:id/fork` | 分叉 |
| POST | `/session/:id/revert` | 回滚 |
| POST | `/session/:id/share` | 分享 |
| POST | `/session/:id/summarize` | 压缩摘要 |
| GET | `/session/:id/message` | 获取消息列表 |

### 4.6 `mimo-free` 插件如何注入 Provider（`plugin/mimo-free.ts`）

```typescript
config: async (input) => {
  input.provider.mimo = {
    name: "MiMo Auto (free)",
    npm: "@ai-sdk/openai-compatible",
    api: CHAT_BASE_URL,                  // .../api/free-ai/openai
    options: {
      apiKey: "anonymous",
      fetch: wrappedFetch,                // 注入 JWT 的自定义 fetch
    },
    models: {
      "mimo-auto": {
        name: "MiMo Auto",
        attachment: true,                 // 多模态
        reasoning: true,
        tool_call: true,
        temperature: true,
        modalities: { input: ["text","image"], output: ["text"] },
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 0, output: 0 },
      },
    },
  }
  // 禁用 opencode 内置 provider
  input.disabled_providers = ["opencode", "opencode-go"]
}
```

这样 ai-sdk 通过 `@ai-sdk/openai-compatible` 创建一个 OpenAI 兼容客户端，所有 HTTP 请求都经过 `wrappedFetch`（自动加 JWT、重写路径、401/403 重试）。

### 4.7 `mimo` 插件（OAuth 登录，付费/正式账号）

`plugin/mimo.ts` 实现了完整的 OAuth 流程，用于登录正式的 MiMo 平台账号（非免费版）：
1. 生成 X25519 密钥对
2. 启动本地 HTTP 服务器接收回调
3. 打开浏览器到 `platform.xiaomimimo.com/authorize?pk=...`
4. 用户授权后，CDN 回调带加密的 `u` 参数
5. 用 X25519 ECDH + AES-256-GCM 解密拿到 `{ sk, uid, url }`
6. 存为 api key，base_url 指向 `https://api.xiaomimimo.com/v1`

> 这是免费版网关**不需要**的部分。

---

## 五、关键实现细节

### 5.1 多模态输入处理

OpenAI 协议的 content 有两种形态：

```jsonc
// 字符串
{ "role": "user", "content": "你好" }

// part 数组（多模态）
{ "role": "user", "content": [
  { "type": "text", "text": "这张图里有什么？" },
  { "type": "image_url", "image_url": { "url": "https://...或data:image/jpeg;base64,..." } }
]}
```

转换逻辑：
- `text` part → `{ type: "text", text }`
- `image_url` part → `{ type: "file", mime, url }`
  - data URI：`data:image/png;base64,...` → mime 从前缀提取
  - HTTP URL：mime 默认 `image/jpeg`
- 纯图片（无 text part）→ 自动补 `{ type: "text", text: "describe this image" }`

### 5.2 流式响应（SSE）

完整入口和 minimal 入口都用**伪流式**：先拿到完整文本，再一次性吐一个 chunk + `[DONE]`。

真正的流式（增量 SSE）只在 minimal-entry 的直连模式下由 MiMo 上游透传（`c.newResponse(mimoRes.body, {...})`）。

### 5.3 Session 用完即删

每次 `/v1/chat/completions` 都会：
1. 创建临时 session
2. 发消息
3. `DELETE /session/{id}`（异步、不阻塞响应）

保证不积累历史数据，` :memory:` SQLite 重启即重置。

### 5.4 首次请求的冷启动

完整入口下，第一次命中 `InstanceMiddleware` 会触发 `InstanceBootstrap`（加载 Config → Plugin → Provider），耗时约 3-5 秒。之后即时响应。

### 5.5 SQLite 迁移

`lib/migration/` 下 34 个迁移（按时间戳命名），通过 drizzle-orm 管理 schema 演进。因为是 `:memory:`，每次启动都全量重跑。

---

## 六、对外 API 契约

### `POST /v1/chat/completions`

**请求体（OpenAI 兼容）：**

```jsonc
{
  "model": "mimo-auto",            // 可选，默认 mimo-auto
  "messages": [
    { "role": "system", "content": "..." },   // 可选
    { "role": "user", "content": "你好" }
  ],
  "stream": false,                 // 可选，默认 false
  "max_tokens": 4096               // 可选
}
```

**多模态：**

```jsonc
{
  "model": "mimo-auto",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "描述这张图" },
      { "type": "image_url", "image_url": { "url": "https://..." } }
    ]
  }]
}
```

`image_url.url` 支持 HTTP/HTTPS URL 和 `data:image/...;base64,...` URI。

**非流式响应：**

```jsonc
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "mimo-auto",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

**流式响应（SSE）：**

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"mimo-auto","choices":[{"index":0,"delta":{"content":"..."},"finish_reason":"stop"}]}

data: [DONE]
```

### `GET /`

健康检查，返回 `MiMo 2API running`。

---

## 七、环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4096` | 监听端口 |
| `MIMO_FREE_BASE_URL` | `https://api.xiaomimimo.com` | MiMo API 地址 |
| `AGENT` | — | 入口设置 `1`，启用 agent 模式 |
| `MIMOCODE` | — | 入口设置 `1`，标识 MiMoCode 运行时 |
| `MIMOCODE_DB` | — | 入口设置 `:memory:` |

---

## 八、Deno 移植要点

基于以上分析，Deno 版本应采用 **`minimal-entry.ts` 的直连策略**，因为：

1. **绕过 Effect DI**：Effect 4.0 beta 在 Deno 下兼容性未验证，且大量内部模块（storage、actor、task 等）对 2API 网关是冗余的。
2. **绕过 ai-sdk**：ai-sdk 体积大、依赖 Bun 特定 API（`Bun.serve`），Deno 有原生 HTTP server。
3. **绕过 SQLite**：无状态网关不需要持久化，JWT 和 session 都是临时的。
4. **直连即可工作**：`minimal-entry.ts` 已证明直连 `bootstrap` + `chat` 端点可行。

### 移植清单

| 原（Bun） | Deno 对应 |
|----------|-----------|
| `Bun.serve` | `Deno.serve` |
| `import { Hono } from "hono"` | `import { Hono } from "jsr:@hono/hono`（或自写路由） |
| `crypto.createHash("sha256")` | `crypto.subtle.digest` + Web Crypto |
| `Buffer.from(..., "base64url")` | `atob` / 自写 base64url |
| `os.hostname()` 等 | `Deno.hostname()` / `Deno.build.arch` |
| `fetch` | 原生 `fetch`（Deno 内置） |
| `TextEncoder` | 内置 |
| `setInterval` | `setInterval`（Deno 内置） |

### 必须保留的核心逻辑

1. **fingerprint 生成**（sha256 of 主机特征）
2. **bootstrap 拿 JWT**（含 429 退避、单飞、5 分钟提前续期）
3. **wrappedFetch**（注入 `Authorization` + `X-Mimo-Source`、401/403 刷新重试）
4. **keepalive**（每 40 分钟后台刷新）
5. **OpenAI 兼容的请求/响应转换**
6. **SSE 流式包装**

---

## 九、总结

v2-micode2api 的本质是：**用一个经过 opencode 受信任运行时初始化的 Hono 进程，把 OpenAI 格式的请求翻译成 MiMo Free API 的内部协议，再把结果翻译回 OpenAI 格式**。

其中最精简、最可移植的核心（脱离 opencode 基建也能工作）是：
- `POST /api/free-ai/bootstrap` 获取 JWT（基于客户端指纹，免费、匿名）
- `POST /api/free-ai/openai/chat` 对话（带 JWT + `X-Mimo-Source` 头）
- JWT 的获取、缓存、续期、401/403 重试逻辑

Deno 版本只需复刻这一层，即可获得功能等价的 2API 网关。
