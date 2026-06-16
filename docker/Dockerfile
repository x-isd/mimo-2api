# v2-micode2api — Docker / Render 部署版
#
# 只装 hono 这一个依赖，秒级完成 install，镜像极小。
# Bun 跑在完整 Linux 容器里，TLS 指纹是 Bun 原生的，能过 MiMo CDN 风控。

# ─── Builder ───
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY entry.ts ./

# ─── Runtime ───
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/entry.ts ./entry.ts

ENV PORT=4096
ENV MIMO_FREE_BASE_URL=https://api.xiaomimimo.com

EXPOSE 4096

CMD ["bun", "run", "entry.ts"]
