# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Copy manifests first so layer is cached when only source changes
COPY package*.json ./

# Install all deps (including devDeps — tsc is a devDep)
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime (lean image — no devDeps, no source, no tsc)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# Set NODE_ENV so express and rate-limit use production optimisations
ENV NODE_ENV=production

WORKDIR /app

# Copy manifests and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Create the data directory (session JSONL files land here at runtime).
# On Railway / Render mount a volume to /app/data for persistence across deploys.
RUN mkdir -p data

# Non-root user for security
RUN addgroup -S agentguard && adduser -S agentguard -G agentguard
USER agentguard

EXPOSE 3000

CMD ["node", "dist/index.js"]
