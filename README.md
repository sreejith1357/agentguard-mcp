# AgentGuard MCP

> **Reliability and observability infrastructure for AI agents in production.**

AgentGuard sits between your AI agent and its tools as a safety net — detecting silent failures, validating tool outputs, logging reasoning checkpoints, flagging anomalies, and providing persistent session memory.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/your-org/agentguard-mcp)
[![Node.js](https://img.shields.io/badge/Node.js-24-green)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](https://github.com/your-org/agentguard-mcp)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.30.0-purple)](https://github.com/modelcontextprotocol/typescript-sdk)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow)](LICENSE)

---

## Why AgentGuard?

When an AI agent calls an MCP tool and receives stale, malformed, or corrupted data, the agent has **no native mechanism to detect the problem**. It continues executing with bad context — making real-world decisions that cost real money and produce wrong outcomes.

AgentGuard solves this by exposing five purpose-built MCP tools:

| Tool | What it does |
|---|---|
| `health_check` | Tests whether any endpoint or MCP server is alive before your agent depends on it |
| `validate_tool_response` | Inspects tool response data for schema integrity, freshness, and sanity |
| `log_checkpoint` | Writes agent reasoning state to create a full audit trail across a session |
| `detect_anomaly` | Compares outputs against expected baselines and flags statistical outliers |
| `get_session_history` | Retrieves prior reasoning checkpoints — persistent agent memory across sessions |

---

## Quick Start

### Prerequisites
- Node.js 24+
- npm

### Local Development

```bash
git clone https://github.com/your-org/agentguard-mcp
cd agentguard-mcp
cp .env.example .env
npm install
npm run dev
```

Server starts at `http://localhost:3000`.

```
MCP endpoint : http://localhost:3000/mcp
Health check : http://localhost:3000/health
```

### Build for Production

```bash
npm run build   # Compiles TypeScript → dist/
npm start       # Runs dist/index.js
```

---

## MCP Client Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

**Option A — Run locally via Node (recommended for development):**

```json
{
  "mcpServers": {
    "agentguard": {
      "command": "node",
      "args": ["/absolute/path/to/agentguard-mcp/dist/index.js"],
      "env": {
        "PORT": "3001",
        "MAX_CHECKPOINTS": "10000"
      }
    }
  }
}
```

**Option B — Connect to a running HTTP server (local or deployed):**

```json
{
  "mcpServers": {
    "agentguard": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Option C — Deployed instance (e.g. Railway):**

```json
{
  "mcpServers": {
    "agentguard": {
      "type": "http",
      "url": "https://your-agentguard-instance.railway.app/mcp"
    }
  }
}
```

---

## Authentication

AgentGuard supports Bearer token authentication.

Set the `AGENTGUARD_API_KEY` environment variable:
```bash
AGENTGUARD_API_KEY=your-secret-key
```

Then pass it on every MCP request:
```
Authorization: Bearer your-secret-key
```

Without `AGENTGUARD_API_KEY` set, the server runs in open mode (useful for local development). Always set this in production.

Generate a strong key:
```bash
openssl rand -hex 32
```

**curl example:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "health_check",
      "arguments": { "url": "https://api.openai.com/v1/models" }
    }
  }'
```

---

## Tool Reference


### `health_check`

Test if an MCP server or API endpoint is alive before your agent depends on it.

**Input:**
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string (URL) | ✅ | — | Endpoint to check (`http://` and `https://` only) |
| `expected_status` | number | ❌ | `200` | Expected HTTP status code |
| `timeout_ms` | number | ❌ | `5000` | Timeout in milliseconds |

**curl example:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "health_check",
      "arguments": {
        "url": "https://api.openai.com/v1/models",
        "expected_status": 200,
        "timeout_ms": 5000
      }
    }
  }'
```

**Example response:**
```json
{
  "healthy": true,
  "url": "https://api.openai.com/v1/models",
  "status_code": 200,
  "expected_status": 200,
  "response_time_ms": 142,
  "verdict": "✅ Healthy — responded in 142ms",
  "timestamp": "2024-01-15T10:00:00.000Z"
}
```

---

### `validate_tool_response`

Inspect data returned from another MCP tool before your agent acts on it.

**Input:**
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `data` | object / string / array | ✅ | — | The tool response to validate |
| `schema` | `Record<string, "string"\|"number"\|"boolean"\|"array"\|"object"\|"null">` | ❌ | — | Field type map (supports dot notation) |
| `required_fields` | string[] | ❌ | `[]` | Fields that must be present and non-null |
| `max_age_seconds` | number | ❌ | — | Max age in seconds (checks timestamp field) |
| `custom_rules` | `{ field, min?, max?, pattern? }[]` | ❌ | `[]` | Per-field sanity bounds |

**curl example:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "validate_tool_response",
      "arguments": {
        "data": {
          "user_id": "u_123",
          "score": 87,
          "timestamp": "2024-01-15T10:00:00Z"
        },
        "required_fields": ["user_id", "score"],
        "schema": { "user_id": "string", "score": "number" },
        "max_age_seconds": 300,
        "custom_rules": [{ "field": "score", "min": 0, "max": 100 }]
      }
    }
  }'
```

**Example response:**
```json
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "field_results": {
    "required:user_id": { "passed": true, "reason": "Field \"user_id\" is present" },
    "required:score":   { "passed": true, "reason": "Field \"score\" is present" },
    "type:user_id":     { "passed": true, "reason": "\"user_id\" is string ✓" },
    "type:score":       { "passed": true, "reason": "\"score\" is number ✓" },
    "freshness:timestamp": { "passed": true, "reason": "Data is 12.3s old (max: 300s) ✓" },
    "rule:score:numeric": { "passed": true, "reason": "\"score\" = 87 within bounds [0, 100] ✓" }
  },
  "age_seconds": 12.3,
  "age_check": "passed",
  "timestamp": "2024-01-15T10:00:12.000Z"
}
```

---

### `log_checkpoint`

Write your current reasoning state to persistent storage.

**Input:**
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `session_id` | string | ✅ | — | Unique session identifier |
| `checkpoint_type` | `"reasoning"\|"decision"\|"tool_call"\|"error"\|"milestone"` | ✅ | — | Category of this checkpoint |
| `content` | string | ✅ | — | Agent reasoning, decision rationale, or error description |
| `metadata` | object | ❌ | — | Structured context (tool names, confidence scores, etc.) |
| `tags` | string[] | ❌ | `[]` | Searchable tags |

**curl example:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "log_checkpoint",
      "arguments": {
        "session_id": "session-abc123",
        "checkpoint_type": "decision",
        "content": "Validated user data — score=87 is within bounds. Proceeding to generate recommendation.",
        "tags": ["validated", "user-facing"],
        "metadata": { "confidence": 0.94, "tool_used": "validate_tool_response" }
      }
    }
  }'
```

**Example response:**
```json
{
  "logged": true,
  "checkpoint_id": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": "session-abc123",
  "checkpoint_type": "decision",
  "timestamp": "2024-01-15T10:00:00.000Z"
}
```

---

### `detect_anomaly`

Compare an agent output against expected baseline patterns.

**Input:**
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `value` | number \| string | ✅ | — | Observed value to check |
| `baseline` | number[] \| string[] | ✅ | — | Historical comparison set (1–1000 items) |
| `metric_name` | string | ✅ | — | Human-readable metric name |
| `sensitivity` | `"low"\|"medium"\|"high"` | ❌ | `"medium"` | Detection threshold |
| `context` | string | ❌ | — | Agent-provided context |

Sensitivity thresholds:

| Sensitivity | Numeric (z-score) | String (similarity) |
|---|---|---|
| `low` | > 3.0σ | < 30% |
| `medium` | > 2.0σ | < 50% |
| `high` | > 1.5σ | < 70% |

**curl example:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "detect_anomaly",
      "arguments": {
        "value": 9500,
        "baseline": [120, 135, 128, 140, 130, 125, 138, 132, 129, 136],
        "metric_name": "response_latency_ms",
        "sensitivity": "medium"
      }
    }
  }'
```

**Example response:**
```json
{
  "anomaly_detected": true,
  "metric_name": "response_latency_ms",
  "observed_value": 9500,
  "value_type": "numeric",
  "baseline_summary": { "mean": 131.3, "stddev": 6.17, "min": 120, "max": 140, "count": 10 },
  "z_score": 1519.58,
  "severity": "critical",
  "sensitivity_used": "medium",
  "verdict": "⚠️ Anomaly detected on \"response_latency_ms\": z-score 1519.582 exceeds 2σ threshold",
  "recommendation": "Severity is CRITICAL. Investigate before proceeding.",
  "timestamp": "2024-01-15T10:00:00.000Z"
}
```

---

### `get_session_history`

Retrieve prior reasoning checkpoints with filtering.

**Input:**
| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `session_id` | string | ✅ | — | Session to retrieve |
| `limit` | number (1–500) | ❌ | `50` | Max entries to return |
| `checkpoint_type` | enum | ❌ | — | Filter by type |
| `since_timestamp` | ISO 8601 string | ❌ | — | Only entries after this time |
| `tags` | string[] | ❌ | — | Filter by tags (AND logic) |

**curl example:**
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_session_history",
      "arguments": {
        "session_id": "session-abc123",
        "limit": 20,
        "checkpoint_type": "decision",
        "tags": ["user-facing"]
      }
    }
  }'
```

**Example response:**
```json
{
  "session_id": "session-abc123",
  "total_found": 3,
  "entries": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "session_id": "session-abc123",
      "checkpoint_type": "decision",
      "content": "Validated user data — score=87 is within bounds...",
      "tags": ["validated", "user-facing"],
      "metadata": { "confidence": 0.94 },
      "created_at": "2024-01-15T10:00:00.000Z"
    }
  ],
  "oldest_entry_at": "2024-01-15T09:00:00.000Z",
  "newest_entry_at": "2024-01-15T10:00:00.000Z",
  "filters_applied": { "checkpoint_type": "decision", "tags": ["user-facing"], "limit": 20 },
  "timestamp": "2024-01-15T10:00:12.000Z"
}
```

---

## v2.0.0 — Advanced Systems

AgentGuard v2.0.0 adds three persistent SQLite-backed reliability and observability systems to safeguard autonomous AI agent operations.

### 1. Circuit Breaker System
Automatically tracks success/failure metrics for external tools and endpoints. When a tool experiences 5 consecutive failures, the circuit breaker opens to halt cascading failures, conserve API tokens, and give downstream services time to recover. After a 60-second cooldown, the breaker transitions to `HALF_OPEN` for canary testing.

#### `report_tool_result`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "report_tool_result",
      "arguments": {
        "tool_name": "weather_api",
        "success": false,
        "error_message": "HTTP 503 Service Unavailable"
      }
    }
  }'
```

#### `get_circuit_state`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_circuit_state",
      "arguments": {
        "tool_name": "weather_api"
      }
    }
  }'
```

#### `reset_circuit`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "reset_circuit",
      "arguments": {
        "tool_name": "weather_api",
        "reason": "API endpoint recovered"
      }
    }
  }'
```

---

### 2. Causal Chain Analysis
Traces reasoning dependency trees using `parent_checkpoint_id` references on checkpoints. When an agent step fails, `analyze_causality` performs Breadth-First Search (BFS) to identify the root cause step that triggered the failure propagation across the reasoning chain and outputs a confidence score.

#### `analyze_causality`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "analyze_causality",
      "arguments": {
        "session_id": "v2-test-001",
        "failed_checkpoint_ids": ["74f0a22a-724d-4837-89df-32414dbf6204"]
      }
    }
  }'
```

---

### 3. Adaptive Baseline Learning
Continuously updates numeric metric statistics using online Exponential Moving Average (EMA) as values are recorded over time. After 20+ observations, baselines reach confident status and `detect_anomaly` automatically uses learned baselines without requiring manual baseline arrays.

#### `record_observation`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "record_observation",
      "arguments": {
        "metric_name": "api.latency",
        "value": 128
      }
    }
  }'
```

#### `get_learned_baseline`
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 6,
    "method": "tools/call",
    "params": {
      "name": "get_learned_baseline",
      "arguments": {
        "metric_name": "api.latency",
        "include_recent_observations": true
      }
    }
  }'
```

---

### How They Work Together

Before calling an external dependency, the agent checks `get_circuit_state` to ensure the circuit is `CLOSED`. If healthy, the agent executes the tool call and immediately reports the outcome using `report_tool_result`. Numeric metrics (such as latency or response size) are recorded via `record_observation`, feeding into AgentGuard's SQLite storage. As observations accumulate, the Adaptive Baseline Learning system calculates statistical mean and variance, enabling `detect_anomaly` to auto-detect drift and outliers without manual input sets. If a failure occurs downstream, `analyze_causality` walks the reasoning chain to isolate the exact root cause checkpoint.

---

## Deployment

### Railway (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/your-org/agentguard-mcp)

**One-click deploy** using the button above, or via CLI:

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Environment variables to set in the Railway dashboard:
```
PORT=3000
MAX_CHECKPOINTS=10000
```

AgentGuard uses `/health` as its healthcheck path — Railway detects this automatically via `railway.json`.

> **Persistence note:** Railway's ephemeral filesystem resets on each deploy. For durable checkpoint storage, mount a [Railway Volume](https://docs.railway.com/reference/volumes) at `/app/data` or set `MAX_CHECKPOINTS` to a lower value and rely on `get_session_history` within a single deploy window.

### Docker

```bash
npm run build
docker build -t agentguard-mcp .
docker run -p 3000:3000 -e MAX_CHECKPOINTS=10000 agentguard-mcp
```

To persist checkpoints across container restarts:

```bash
docker run -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e MAX_CHECKPOINTS=50000 \
  agentguard-mcp
```

### Render / Fly.io

```bash
# Render: connect your GitHub repo, set Build Command = npm run build,
# Start Command = node dist/index.js, Health Check Path = /health

# Fly.io
fly launch
fly deploy
```

---

## Architecture

```
AI Agent
   │
   │  POST /mcp  (StreamableHTTP — stateless, July 2026 spec)
   ▼
┌─────────────────────────────────┐
│       AgentGuard MCP Server     │
│  Express + MCP SDK 1.30.0       │
│  Rate limit: 100 req/15min/IP   │
│                                 │
│  ┌─────────────────────────┐    │
│  │      Tool Router        │    │
│  └────────────┬────────────┘    │
│               │                 │
│  health_check │ validate_tool   │
│  log_checkp.. │ detect_anomaly  │
│  get_session  │                 │
│               ▼                 │
│  ┌─────────────────────────┐    │
│  │  storage.ts (JSONL)     │    │
│  │  ./data/<session>.jsonl │    │
│  │  cap: MAX_CHECKPOINTS   │    │
│  └─────────────────────────┘    │
│                                 │
│  GET /health  (uptime probe)    │
└─────────────────────────────────┘
```

**Stateless at the MCP transport layer. Application state (circuits, baselines, checkpoints) is stored in local SQLite and JSONL. Single-instance deployments only unless migrated to an external database.**

**Security:** `health_check` enforces an SSRF blocklist (http/https only, major IPv4 and IPv6 private, reserved, and metadata ranges). All endpoints are rate-limited.

---

## Known Limitations

**Single-instance storage:** AgentGuard uses local SQLite and JSONL files. Circuit breaker state, learned baselines, and session checkpoints are not shared across multiple server instances. For multi-instance deployments, a PostgreSQL backend is required (planned for v3.0.0).

**SSRF protection:** AgentGuard blocks major private IPv4 and IPv6 ranges. For adversarial environments, additional DNS resolution validation and network-layer controls are recommended.

**No tenant isolation:** Circuit breaker keys are global by default. In multi-tenant scenarios, namespace your tool_name values: "tenant/environment/tool_name".

**Dependency tracing vs causation:** analyze_causality traces declared parent_checkpoint_id relationships. It identifies structural dependency ancestors — not proven real-world causation.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `MAX_CHECKPOINTS` | `10000` | Max checkpoints per session before writes are rejected |

Copy `.env.example` to `.env` to configure locally.

---

## Registries

AgentGuard MCP is listed on:
- [mcp.so](https://mcp.so)
- [Glama](https://glama.ai/mcp/servers)
- [Smithery](https://smithery.ai)
- [MCPize](https://mcpize.com)

---

## License

ISC © AgentGuard
