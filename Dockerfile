# AgentGuard MCP v3.1.0 Multi-stage Production Dockerfile
FROM node:20-slim AS builder

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production runtime stage
FROM node:20-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JavaScript and static admin console assets
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# Create volume mount point for persistent SQLite database
VOLUME ["/app/agentguard.db"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
