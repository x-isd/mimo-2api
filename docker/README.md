# v2-micode2api — Docker / Render 部署版

把 **MiMo Free API** 包装成 **OpenAI 兼容** 的 `/v1/chat/completions` 端点，跑在 Docker 容器里。

> **为什么是 Docker 而不是 Deno Deploy？**
> MiMo 的 chat 端点有 CDN TLS 指纹风控。Deno Deploy / Cloudflare Workers 的出口网络会被识别并 403。Docker 容器里跑的是原生 Bun，TLS 指纹受信，能正常通过。

## 目录结构

```
docker/
├── entry.ts        — 服务入口（基于 minimal-entry.ts，只依赖 hono）
├── package.json    — 依赖声明（只装 hono 一个包）
├── Dockerfile      — 多阶段构建（builder + slim runtime）
├── render.yaml     — Render Blueprint 配置（可选）
└── .dockerignore
```

## 特性

- ✅ OpenAI 兼容 `/v1/chat/completions`（文本 + 多模态图片）
- ✅ 流式（SSE）和非流式响应
- ✅ JWT 自动获取、缓存、提前续期、后台保活
- ✅ 401/403 自动刷新重试
- ✅ 真流式（透传上游 SSE）
- ✅ `/v1/models`、`/debug` 端点
- ✅ 镜像小（~150MB），构建快（只装 1 个依赖）

---

## 部署到 Render（推荐，免费套餐够用）

### 方式一：GitHub 连接（推荐，支持自动部署）

#### Step 1：把 `docker/` 目录推到 GitHub

把整个项目推到 GitHub 仓库，`docker/` 子目录已经在里面了。结构如下：

```
你的仓库/
├── docker/
│   ├── entry.ts
│   ├── package.json
│   ├── Dockerfile
│   └── render.yaml
├── entry.ts          ← 原项目文件，不影响
├── lib/
└── ...
```

#### Step 2：在 Render 创建服务

1. 打开 **https://dashboard.render.com**
2. 点击 **"New +"** → **"Web Service"**
3. 选择 **"Build and deploy from a Git repository"**
4. 连接你的 GitHub 账号，选择你的仓库
5. 配置：

| 设置项 | 值 | 说明 |
|--------|-----|------|
| **Name** | `mimo-2api` | 自定义服务名 |
| **Region** | `Singapore` | 离中国近，延迟低 |
| **Branch** | `main` | 监听的分支 |
| **Root Directory** | `docker` | ★ 关键：指向 docker/ 子目录 |
| **Runtime** | `Docker` | Render 会自动识别 Dockerfile |
| **Instance Type** | `Free` | 免费套餐 |

6. 点击 **"Create Web Service"**

#### Step 3：等待构建

Render 会自动执行 `docker build`，构建过程通常 **1-2 分钟**（因为只装 hono 一个依赖）。

构建日志里会看到：
```
=> [builder 3/4] RUN bun install        2.3s
=> [builder 4/4] COPY entry.ts .         0.1s
=> exporting to image                    1.2s
=> writing image                         0.5s
```

#### Step 4：拿到域名

部署成功后，Render 会分配一个域名：

```
https://mimo-2api-xxxx.onrender.com
```

验证：

```bash
# 健康检查
curl https://mimo-2api-xxxx.onrender.com/
# → MiMo 2API running

# 调试信息
curl https://mimo-2api-xxxx.onrender.com/debug
# → {"jwt_ready":true, "runtime":"linux/x64", "bun":true}

# 对话测试
curl https://mimo-2api-xxxx.onrender.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-auto","messages":[{"role":"user","content":"你好"}]}'
```

#### 后续更新

```
修改代码 → git push → Render 自动检测 → 自动重新构建部署
                     （通常 1-2 分钟生效）
```

---

### 方式二：用 render.yaml（Blueprint）

如果你把 `render.yaml` 放在仓库根目录：

```bash
# 在 Render Dashboard → New → Blueprint
# 选择你的仓库
# Render 自动读取 render.yaml 创建服务
```

> ⚠️ 用这种方式时，确保 `render.yaml` 里的 `rootDir: docker` 指向正确。

---

## 本地用 Docker 跑

```bash
# 构建镜像
cd docker
docker build -t mimo-2api .

# 运行容器
docker run -d -p 4096:4096 --name mimo-2api mimo-2api

# 测试
curl http://localhost:4096/
curl http://localhost:4096/debug
```

查看日志：

```bash
docker logs -f mimo-2api
```

停止 / 删除：

```bash
docker stop mimo-2api
docker rm mimo-2api
```

---

## 接入第三方客户端

Cherry Studio / ChatGPT-Next-Web / LobeChat 等：

| 设置项 | 值 |
|--------|-----|
| **API 地址（Base URL）** | `https://mimo-2api-xxxx.onrender.com` |
| **API Key** | 随便填（本项目不校验） |
| **模型** | `mimo-auto` |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4096` | 监听端口（Render 自动注入） |
| `MIMO_FREE_BASE_URL` | `https://api.xiaomimimo.com` | MiMo API 地址 |

在 Render 的 **Environment** 标签页可以修改。

---

## 注意事项

### 1. Render 免费套餐限制

| 限制 | 说明 |
|------|------|
| **冷启动** | 15 分钟无流量后服务休眠，下次请求需要 ~30 秒唤醒 |
| **内存** | 512MB（本项目实际用 ~230MB，够用） |
| **构建分钟** | 每月 750 小时实例时间 |

如果不想冷启动，升级到 **Starter**（$7/月），永不休眠。

### 2. JWT 与冷启动

服务休眠后 JWT 缓存丢失，唤醒后首次请求会重新 bootstrap（~2-5 秒）。代码里做了同步等待，不会因为 JWT 没准备好就返回错误。

### 3. 为什么 Docker 能过 CDN

```
Deno Deploy  → Cloudflare Workers 网络 → Cloudflare TLS 指纹 → ❌ 403
Docker/Bun   → 普通云服务器出口 IP → Bun 原生 TLS 指纹 → ✅ 通过
```

Render 的 Docker 容器跑在标准云服务器上，Bun 的 TLS 握手特征与 CDN 白名单匹配。

---

## 故障排查

### 问题：`upstream 403: Illegal access`

**说明 Bun 容器的 TLS 指纹也被识别了**（可能性较低，但理论存在）。

排查步骤：
1. 访问 `/debug`，确认 `jwt_ready: true`（JWT 拿到了说明 bootstrap 通过）
2. 如果 JWT ready 但 chat 403，是 CDN 对 chat 端点的额外校验
3. 尝试换 Render region（如从 Singapore 换到 Oregon）

### 问题：`JWT not available — bootstrap still retrying`

JWT 获取失败。访问 `/debug` 查看 `jwt_cached` 和日志。

### 问题：构建失败

检查 Render 构建日志，常见原因：
- `docker/` 目录结构不对
- `package.json` 里 `hono` 版本写错

---

## 许可与免责

本项目仅供学习和研究使用。MiMo Free API 的所有权归小米公司所有，使用前请遵守其服务条款。
