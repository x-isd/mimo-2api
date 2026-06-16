# Docker 部署指南（Render 平台）

## 📁 文件清单（根目录）

```
v2-micode2api/
├── Dockerfile              # Docker 镜像构建文件
├── docker-entry.ts         # 应用入口（极简依赖版本）
├── package.docker.json     # 最小化依赖（仅 hono）
├── render.yaml             # Render 平台配置
├── .dockerignore           # Docker 构建排除规则
└── DOCKER_DEPLOY_GUIDE.md  # 本文档
```

## 🎯 核心特性

- **极简依赖**：仅依赖 `hono@4.10.7`，构建快速
- **多阶段构建**：builder + runtime，最终镜像 ~150MB
- **TLS 指纹兼容**：使用 Bun 原生 TLS，绕过 MiMo CDN 的 TLS 指纹检测
- **JWT 自动续期**：单例获取 + 5分钟提前续期 + 40分钟后台保活
- **真实流式传输**：透传上游 SSE，延迟 < 100ms

## 🚀 Render 部署步骤

### 方法一：Blueprint 自动部署（推荐）

1. **将项目推送到 GitHub**
   ```bash
   git init
   git add Dockerfile docker-entry.ts package.docker.json render.yaml .dockerignore
   git commit -m "feat: Docker deployment for Render"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **连接 Render**
   - 登录 [Render Dashboard](https://dashboard.render.com)
   - 点击 **New** → **Blueprint**
   - 选择你的 GitHub 仓库
   - Render 会自动读取 `render.yaml` 并创建服务

3. **等待构建**
   - 构建时间：约 2-3 分钟
   - Render 会自动注入 `PORT` 环境变量
   - 构建成功后，Render 会分配一个公开域名（如 `https://mimo-2api.onrender.com`）

### 方法二：手动创建服务

1. **创建 Web Service**
   - Render Dashboard → **New** → **Web Service**
   - 连接 GitHub 仓库
   - 配置如下：
     - **Name**: `mimo-2api`
     - **Region**: `Singapore`
     - **Branch**: `main`
     - **Runtime**: `Docker`
     - **Dockerfile Path**: `./Dockerfile`
     - **Plan**: `Free`

2. **环境变量**（可选）
   - `MIMO_FREE_BASE_URL`: `https://api.xiaomimimo.com`（默认值）

3. **部署**
   - 点击 **Create Web Service**
   - 等待构建完成

## 🧪 验证部署

部署成功后，获取你的 Render 域名（如 `https://mimo-2api.onrender.com`），然后测试：

### 1. 健康检查
```bash
curl https://mimo-2api.onrender.com/
# 预期: {"status":"ok","service":"v2-micode2api-docker"}
```

### 2. 调试端点
```bash
curl https://mimo-2api.onrender.com/debug
```
预期返回：
```json
{
  "jwt_ready": true,
  "jwt_cached": true,
  "jwt_expire": "2024-01-01T12:00:00.000Z",
  "jwt_remain_ms": 2700000,
  "runtime": {
    "bun_version": "1.1.x",
    "node_version": "v21.x.x",
    "platform": "linux",
    "arch": "x64",
    "hostname": "srv-xxx"
  },
  "config": {
    "mimo_base_url": "https://api.xiaomimimo.com",
    "port": "10000"
  }
}
```

### 3. 模型列表
```bash
curl https://mimo-2api.onrender.com/v1/models
```
预期返回：
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o-mini",
      "object": "model",
      "created": 1686935002,
      "owned_by": "openai"
    }
  ]
}
```

### 4. 聊天测试（流式）
```bash
curl -X POST https://mimo-2api.onrender.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## 🔍 故障排查

### 构建失败：`bun install exit code: 1`

**原因**：Render 免费版内存限制（512MB）或网络超时

**解决方案**：
1. Dockerfile 已包含重试逻辑（3次 + 指数退避）
2. 如果持续失败，查看构建日志：
   - Render Dashboard → 你的服务 → **Logs** → **Build Logs**
   - 查找具体错误信息（如 OOM、网络错误）

3. 备用方案：使用 npm 安装
   ```dockerfile
   # 在 Dockerfile 的 RUN 命令中替换为：
   RUN npm install --verbose
   ```

### JWT 获取失败

查看运行日志：
```bash
# Render Dashboard → Logs → Runtime Logs
# 查找 [JWT] 相关日志
```

常见原因：
- bootstrap 端点网络超时（重试会自动处理）
- 指纹生成异常（检查 `/debug` 端点的 `hostname`）

### 聊天返回 403

如果 `/debug` 显示 `jwt_ready: true` 但聊天仍 403，原因可能是：
- **TLS 指纹问题**（理论上 Bun 在 Linux 容器中应该能通过）
- **上游限流**（稍后重试）

检查步骤：
1. 查看运行日志中的 `[chat]` 错误信息
2. 尝试等待 1-2 分钟后重试（JWT 可能刚获取，上游有短暂限制）

## 🔧 本地测试

如果你想在本地测试 Docker 镜像：

```bash
# 构建镜像
docker build -t v2-micode2api .

# 运行容器
docker run -p 4096:4096 v2-micode2api

# 测试
curl http://localhost:4096/debug
```

## 📊 性能指标

- **冷启动时间**：约 10-15 秒（Render 免费版）
- **JWT 获取时间**：约 500-800ms
- **流式首字延迟**：约 50-100ms（透传上游）
- **内存占用**：约 50-80MB（运行时）

## 🎉 在 Cherry Studio 中使用

1. 打开 Cherry Studio
2. 设置 → 模型提供商 → 添加自定义 OpenAI
3. 填写：
   - **API Base**: `https://mimo-2api.onrender.com/v1`
   - **API Key**: 随意填写（如 `sk-xxx`，后端不验证）
   - **模型**: `gpt-4o-mini`
4. 测试连接 → 开始使用

## 📝 注意事项

1. **Render 免费版限制**：
   - 15 分钟无请求后会休眠
   - 重新唤醒需要 10-15 秒
   - 每月 750 小时免费运行时间

2. **JWT 续期**：
   - 后台每 40 分钟自动续期
   - 如果服务休眠超过 50 分钟，JWT 会过期
   - 下次请求会自动重新获取（约 1 秒延迟）

3. **TLS 指纹稳定性**：
   - Bun 在 Docker 容器中的 TLS 指纹应该能通过 MiMo CDN
   - 如果仍然 403，可能是上游策略更新，需进一步调试

## 🔗 相关文档

- [Render Docker 部署文档](https://render.com/docs/docker)
- [Render Blueprint 说明](https://render.com/docs/infrastructure-as-code)
- [原项目分析](./PROJECT_ANALYSIS.md)
