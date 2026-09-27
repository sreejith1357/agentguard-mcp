# AgentGuard MCP v3.1.0 Multi-stage Production Dockerfile
FROM node:22-slim AS builder

WORKDIR /app

# Install build tools for native C++ addon compilation (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDependencies to keep runtime image lightweight
RUN npm prune --production

# Production runtime stage
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install runtime utilities (curl for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Copy compiled production node_modules and built artifacts from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# Create volume mount point for persistent SQLite database
VOLUME ["/app/agentguard.db"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
