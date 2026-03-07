# =============================================================================
# Polymarket Copy Trade — Multi-stage Docker Build
# =============================================================================
# Single image used by all 7 worker containers.
# Each container overrides CMD to run a different job script.
# Runtime: node --import tsx (TypeScript executed directly, no compile step).

# ─── Builder Stage ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Native build deps for ethers (secp256k1) and pg
RUN apk add --no-cache python3 make g++

# Install all dependencies (including devDeps for tsx)
COPY package.json package-lock.json ./
RUN npm ci

# Generate Prisma client (placeholder DATABASE_URL satisfies the generator)
COPY prisma/ ./prisma/
COPY prisma.config.ts ./
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN npx prisma generate

# Copy source (needed at runtime via tsx — no tsc build step)
COPY tsconfig.json ./
COPY src/ ./src/

# ─── Production Stage ────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Create log directory for Winston (writes to /app/logs/)
RUN mkdir -p /app/logs

# Copy everything from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json /app/tsconfig.json /app/prisma.config.ts ./

# Copy and prepare entrypoint
COPY .server/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Own everything by non-root node user
RUN chown -R node:node /app

USER node

ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]

# Default CMD (overridden per-container in docker-compose)
CMD ["src/jobs/copy-trader.ts"]
