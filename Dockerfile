# AgentGuard MCP v3.1.0 Multi-stage Production Dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package*.json ./
RUN npm ci

# Copy source code and build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install build dependencies for better-sqlite3 native addon
RUN apk add --no-req-packages python3 make g++

COPY package*.json ./
RUN npm ci --only=production

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Create volume mount point for persistent SQLite database
VOLUME ["/app/agentguard.db"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
