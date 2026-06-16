# v2-micode2api

基于 MiMoCode 运行时的 MiMo Free API 2API 网关。提供 OpenAI 兼容的 `/v1/chat/completions` 端点，支持**文本/多模态**、**流式/非流式**，免费使用。

## 必要条件

- [Bun](https://bun.sh) >= 1.3.0

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 启动（开发模式）
bun run dev

# 3. 调用测试
curl http://localhost:4096/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-auto","messages":[{"role":"user","content":"hi"}]}'
```

## 生产部署

预编译单文件模式，减少模块加载开销：

```bash
# 编译
bun run build

# 启动（推荐：--smol 降低内存占用）
bun run start
```

编译后单文件在 `dist/bundle.js`（~13MB），运行时内存约 **230MB**。

## 内存占用

| 模式 | 内存 | 说明 |
|------|------|------|
| 开发 (`entry.ts`) | ~290 MB | 源码模式 |
| 生产 (`dist/bundle.js`) | ~230 MB | 预编译 + `--smol` |

## API

### `POST /v1/chat/completions`

OpenAI 兼容接口，支持 text 和 multimodal 输入。

**请求体：**

```json
{
  "model": "mimo-auto",
  "messages": [
    {
      "role": "user",
      "content": "你好"
    }
  ],
  "stream": false,
  "max_tokens": 4096
}
```

**多模态（图片）：**

```json
{
  "model": "mimo-auto",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图里有什么？"},
        {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
      ]
    }
  ],
  "max_tokens": 1024
}
```

`image_url.url` 支持 HTTP/HTTPS URL 和 base64 data URI。

### `GET /`

健康检查。

## 功能支持

| 特性 | 支持 |
|------|------|
| 文本消息 | ✅ |
| 多模态（图片） | ✅ |
| 非流式响应 | ✅ |
| 流式响应 (SSE) | ✅ |
| 临时 Session 自动清理 | ✅ |
| JWT 自动获取 & 保活 | ✅ |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4096` | 监听端口 |
| `MIMO_FREE_BASE_URL` | `https://api.xiaomimimo.com` | MiMo API 地址 |

## 设计说明

### 请求流

```
curl → POST /v1/chat/completions
  → InstanceMiddleware（首次懒加载 InstanceBootstrap）
  → POST /session（创建临时 session）
  → POST /session/{id}/message（走 provider stack → wrappedFetch → MiMo API）
  → DELETE /session/{id}（异步清理）
```

### 为什么不能直接调用 MiMo API

MiMo Free API 由 MiFE CDN 保护，CDN 通过 TLS 指纹做风控。裸 fetch 即使带着 JWT 也会返回 403。唯一受信通路是经过 opencode 完整的 Effect DI 初始化链（Config → Plugin → Provider），这条链在 `InstanceMiddleware` 首次命中时建立。所以 `/v1/chat/completions` 路由必须挂载在完整的 Hono app 上，复用已有的受信运行时。

### 裁剪策略

`lib/opencode-lite` 是从 MiMoCode 源码裁剪而来，保留了：
- 核心运行时（Effect DI、Config、Plugin、Provider）
- Session 系统（创建/对话/清理）
- 数据库（`:memory:` SQLite）
- MiMo Free 插件（JWT 获取、wrappedFetch）

删除了：
- 前端 UI（Vite/SolidJS）
- LSP 全量实现
- CLI 交互界面
- 绝大多数 AI SDK Provider（anthropic、openai 等保留为动态 import）

## 文件结构

```
v2-micode2api/
├── entry.ts                     — 启动入口（~40 行）
├── package.json                 — 依赖声明
├── tsconfig.json                — TypeScript 配置
├── README.md
├── dist/
│   └── bundle.js                — 预编译单文件（bun run build）
├── lib/
│   ├── opencode-lite/           — 裁剪后的核心源码
│   │   ├── server/              — Hono 服务器 & 路由
│   │   ├── session/             — Session & LLM 调用
│   │   ├── provider/            — Provider 注册
│   │   ├── plugin/              — 插件系统（含 mimo-free 插件）
│   │   ├── storage/             — SQLite 数据库
│   │   ├── config/              — 配置系统
│   │   ├── effect/              — Effect 运行时 DI
│   │   └── ...                  — 其他必要模块
│   ├── plugin/                  — @mimo-ai/plugin（源码）
│   ├── shared/                  — @mimo-ai/shared
│   ├── script/                  — @mimo-ai/script
│   └── sdk/                     — @mimo-ai/sdk
└── migration/                   — SQLite schema（34 个 migration）
```

## 注意事项

- 使用 `:memory:` SQLite，重启即重置，无需持久化文件
- Session 用完即删，不积累历史数据
- JWT 每次启动自动获取，后台每 40 分钟刷新一次
- 首次请求会触发 InstanceBootstrap（加载约 3-5 秒），后续请求即时响应
