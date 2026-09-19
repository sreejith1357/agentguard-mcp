# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install C++ compilation tools required by better-sqlite3 (node-gyp)
RUN apk add --no-cache python3 make g++

# Copy manifests first for optimal layer caching
COPY package*.json ./

# Install all dependencies and build native C++ bindings
RUN npm ci

# Copy TypeScript config and source code
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# Remove devDependencies leaving only production node_modules
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime (lean production image)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Copy production node_modules (with compiled better-sqlite3 bindings) and dist
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create data directory for session checkpoint files
RUN mkdir -p data

# Non-root user for security
RUN addgroup -S agentguard && adduser -S agentguard -G agentguard
RUN chown -R agentguard:agentguard /app

USER agentguard

EXPOSE 3000

CMD ["node", "dist/index.js"]
