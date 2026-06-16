# Multi-stage build for v2-micode2api (Docker/Render deployment)
# Uses Bun runtime with minimal dependencies (only hono)

# --- Builder stage ---
FROM oven/bun:1.1 AS builder

WORKDIR /app

# Copy minimal package.json (only hono dependency)
COPY package.docker.json ./package.json

# Install dependencies with retry logic and verbose output
RUN for i in 1 2 3; do \
      echo "Install attempt $i..."; \
      bun install --verbose && break || \
      { echo "Install attempt $i failed"; [ $i -lt 3 ] && sleep 5; }; \
    done && \
    echo "Verifying installation..." && \
    ls -la node_modules/hono/package.json

# Copy application code
COPY docker-entry.ts ./entry.ts

# Verify all files present
RUN ls -la entry.ts node_modules/

# --- Runtime stage ---
FROM oven/bun:1.1-slim

WORKDIR /app

# Copy installed dependencies and app from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/entry.ts ./entry.ts

# Expose port (Render will inject PORT env var)
EXPOSE 4096

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.PORT || 4096) + '/debug').then(r => r.ok ? process.exit(0) : process.exit(1))"

# Start the server
CMD ["bun", "run", "entry.ts"]
