# AgentGuard MCP

<div align="center">

# 🛡️ AgentGuard MCP (v3.1.0 Enterprise)

**Active Control Plane & Governance Infrastructure for AI Agents built on the Model Context Protocol (MCP)**

[![npm version](https://img.shields.io/npm/v/agentguard-mcp-server.svg?color=cb3837&style=flat-square)](https://www.npmjs.com/package/agentguard-mcp-server)
[![PyPI version](https://img.shields.io/pypi/v/agentguard-mcp-sdk.svg?color=3775a9&style=flat-square)](https://pypi.org/project/agentguard-mcp-sdk/)
[![MCP Spec](https://img.shields.io/badge/MCP_Spec-1.30.0-purple.svg?style=flat-square)](https://modelcontextprotocol.io)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ed.svg?style=flat-square)](Dockerfile)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[Features](#-key-features) • [Quick Start](#-quick-start) • [Admin Console](#-admin-console) • [MCP Tools](#-mcp-tool-reference) • [SDKs](#-python--node-sdks) • [Deployment](#-deployment)

---

</div>

## 📌 Executive Summary

Most AI agent platforms rely on **passive observability**—logging errors 10 minutes after an autonomous agent goes rogue, drains token budgets, or leaks sensitive data. 

**AgentGuard MCP** sits **directly inside the agent execution loop** as an active control plane. It intercepts tool calls in real-time to prevent catastrophic agent failures *before* they consume budgets or corrupt downstream infrastructure.

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 AGENTGUARD CONTROL PLANE               │
                  │                                                        │
   AI AGENT       │  ┌──────────────────┐    ┌──────────────────────────┐  │     EXTERNAL APIs
 ┌──────────┐     │  │  SSRF & Security │    │  Circuit Breaker Grid    │  │    ┌──────────────┐
 │          │────▶│  │  Sanitization    │───▶│  (CLOSED/OPEN/HALF_OPEN) │──┼───▶│ Search / DB /│
 │ Autonomous│    │  └──────────────────┘    └──────────────────────────┘  │    │ External MCP │
 │  Agent   │     │            │                           │               │    └──────────────┘
 └──────────┘     │            ▼                           ▼               │
                  │  ┌──────────────────┐    ┌──────────────────────────┐  │
                  │  │  Loop & Anomaly  │    │  Multi-Tenant Quotas &   │  │
                  │  │  Detection       │    │  Audit Trail Logging     │  │
                  │  └──────────────────┘    └──────────────────────────┘  │
                  └────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

### 🛡️ Active Execution Governance
* **Infinite Loop Prevention**: Detects recursive tool calls and repeated parameter signatures before agents drain API budgets.
* **Prompt Injection & Output Validation**: Sanitizes and validates tool response payloads against strict JSON schemas and injection patterns.
* **Statistical Anomaly Detection**: Uses online Exponential Moving Average (EMA) and Z-score statistical analysis to flag latency drift or anomalous output sizes.

### ⚡ Automated Circuit Breaker Grid
* **Failure Isolation**: Automatically trips circuits (`CLOSED` → `OPEN`) after 5 consecutive tool failures to protect downstream APIs.
* **Canary Recovery**: Auto-transitions to `HALF_OPEN` after a 60-second cooldown to test target service recovery without risking agent uptime.

### 🏢 Enterprise Multi-Tenancy & Security
* **Tenant Isolation & Quota Enforcement**: Custom rate limits, monthly request quotas, and multi-tenant Bearer authentication.
* **Hashed Key Storage**: API keys are securely hashed using SHA-256 in SQLite/PostgreSQL storage.
* **Immutable Security Audit Trail**: Append-only security log tracking all administrative and tenant actions.

### 🖥️ Built-in Real-Time Admin Console
* **Single-Page Dashboard**: Accessible via `/admin` with live metrics, customer subscription management, API key generation, circuit resets, and webhook subscriptions.

### 🔔 Real-Time Webhook Dispatcher
* **Event Push**: Delivers real-time HTTP POST alerts (`circuit.tripped`, `anomaly.detected`, `quota.warning`) directly to Slack, Discord, or custom backend webhooks.

---

## 🚀 Quick Start

### 1. Run the MCP Server

#### Option A: Run via `npx` (No installation needed)
```bash
npx agentguard-mcp-server
```

#### Option B: Run via Docker Container
```bash
docker run -p 3000:3000 \
  -e AGENTGUARD_ADMIN_KEY=$(openssl rand -hex 32) \
  -e AGENTGUARD_API_KEY=$(openssl rand -hex 32) \
  sreejith1357/agentguard-mcp
```

#### Option C: Local Repository Setup
```bash
git clone https://github.com/sreejith1357/agentguard-mcp.git
cd agentguard-mcp
npm install
npm run build
npm start
```
* MCP Service Endpoint: `http://localhost:3000/mcp`
* Admin Console UI: `http://localhost:3000/admin`
* Health Check Endpoint: `http://localhost:3000/health`

---

## 🔌 MCP Client Configuration

### Claude Desktop Integration

Add AgentGuard to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentguard": {
      "command": "npx",
      "args": ["-y", "agentguard-mcp-server"],
      "env": {
        "PORT": "3000",
        "RATE_LIMIT_MAX": "500"
      }
    }
  }
}
```

Or connect via HTTP / Server-Sent Events (SSE):

```json
{
  "mcpServers": {
    "agentguard": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-agentguard-api-key"
      }
    }
  }
}
```

---

## 🖥️ Admin Console (`/admin`)

AgentGuard includes a built-in enterprise administration web interface. Open `http://localhost:3000/admin` in your web browser:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ AgentGuard MCP Admin Console                                [🔒 Lock Session] │
├───────────────────────────────────────────────────────────────────────────────┤
│ TOTAL CALLS: 142,500   REGISTERED TENANTS: 12   CIRCUITS: 8   AVG LATENCY: <5ms │
├───────────────────────────────────────────────────────────────────────────────┤
│ [📊 Analytics] [🏢 Tenants] [🔑 API Keys] [⚡ Circuits] [🔔 Webhooks] [🛡️ Audit] │
│                                                                               │
│  🏢 Registered Tenants & Quotas                                               │
│  • Acme Corp        (PRO Plan)     [ 34% Quota Used ]    [ Active ]  [ Actions ]│
│  • Globex Devs      (STARTER Plan) [ 92% Quota Used ]    [ Active ]  [ Actions ]│
└───────────────────────────────────────────────────────────────────────────────┘
```

### Dashboard Capabilities:
* 📊 **Usage Analytics**: Real-time tool invocation frequencies and trajectory statistics.
* 🏢 **Tenants & Subscriptions**: Create tenant slugs, assign billing tiers (`Free`, `Starter`, `Pro`, `Team`), set internal notes, and suspend/reactivate client accounts.
* 🔑 **API Key Management**: Generate live Bearer tokens (`ag_live_...`) with instant copy helpers and key revocation.
* ⚡ **Circuit Breaker Control Grid**: View active circuit states (`CLOSED`, `OPEN`, `HALF_OPEN`) and force manual breaker resets.
* 🔔 **Webhook Subscriptions**: Subscribe URLs to security events (`circuit.tripped`, `anomaly.detected`, `quota.warning`).
* 🛡️ **Security Audit Trail**: Inspect filterable audit logs (timestamps, admin actions, target tenant IDs, IP addresses).

---

## 🛠️ MCP Tool Reference

AgentGuard exposes five core MCP tools to AI agents:

| Tool Name | Purpose | Key Parameters |
| :--- | :--- | :--- |
| `log_checkpoint` | Records agent reasoning step & detects infinite loops | `session_id`, `checkpoint_type`, `content`, `tags` |
| `validate_tool_response` | Validates data payloads & blocks prompt injections | `data`, `schema`, `required_fields`, `max_age_seconds` |
| `detect_anomaly` | Statistical Z-score & EMA latency drift detection | `value`, `baseline`, `metric_name`, `sensitivity` |
| `circuit_breaker_check` | Checks tool health state (`CLOSED`, `OPEN`, `HALF_OPEN`) | `tool_name`, `failure_threshold`, `cooldown_seconds` |
| `get_session_history` | Retrieves persistent agent session memory & trajectory | `session_id`, `limit`, `checkpoint_type`, `tags` |

---

## 🐍 Python & Node SDKs

### Python SDK (`agentguard-mcp-sdk`)

Install from PyPI:
```bash
pip install agentguard-mcp-sdk
```

Usage in Python agent code:
```python
from agentguard import AgentGuardClient

client = AgentGuardClient(
    base_url="http://localhost:3000",
    api_key="ag_live_your_api_key_here"
)

# 1. Check Circuit Breaker status before executing an external tool
circuit = client.check_circuit("weather_api")
if circuit.get("state") == "OPEN":
    print("⚡ Circuit Breaker is OPEN! Triggering fallback mode.")

# 2. Log reasoning checkpoint & check for loops
checkpoint = client.log_checkpoint(
    session_id="sess_88291",
    step_index=3,
    tool_name="web_search",
    tool_input={"query": "agentic security"}
)

if checkpoint.get("loop_detected"):
    print(f"⚠️ Loop detected! Action: {checkpoint.get('recommended_action')}")
```

### Node.js / HTTP Integration

```javascript
const response = await fetch("http://localhost:3000/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer ag_live_your_api_key_here"
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "health_check",
      arguments: { url: "https://api.github.com" }
    }
  })
});
```

---

## ☁️ Deployment

### Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | Server HTTP port |
| `NODE_ENV` | `production` | Environment mode (`production` / `development`) |
| `AGENTGUARD_ADMIN_KEY` | *(Generated)* | Master 64-char hex key protecting `/admin` UI |
| `AGENTGUARD_API_KEY` | *(Generated)* | Global fallback API authentication token |
| `RATE_LIMIT_MAX` | `500` | Max API requests per 15-minute window per IP |
| `CORS_ORIGIN` | `*` | Allowed CORS origins for browser/web clients |

### Cloud Deployment (Render, AWS, DigitalOcean, Railway)

Deploying via Docker is fully supported:

```bash
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e AGENTGUARD_ADMIN_KEY=your_64_char_admin_key \
  -e AGENTGUARD_API_KEY=your_64_char_api_key \
  -e RATE_LIMIT_MAX=500 \
  -v agentguard_data:/app/data \
  sreejith1357/agentguard-mcp
```

*(For Render deployments, connect your repository and select the provided `Dockerfile` — environment variables set in the Render Dashboard will be loaded automatically).*

---

## 🌐 Registries & Standards Compliance

AgentGuard MCP is published and listed across standard ecosystem registries:

* 📦 **NPM Registry**: [`agentguard-mcp-server`](https://www.npmjs.com/package/agentguard-mcp-server)
* 🐍 **PyPI Registry**: [`agentguard-mcp-sdk`](https://pypi.org/project/agentguard-mcp-sdk/)
* 🛠️ **Smithery.ai**: Configured via [`smithery.yaml`](smithery.yaml)
* 🦙 **Glama.ai**: Configured via [`glama.json`](glama.json)
* 🌐 **MCP.so / Mcpize**: Manifest [`mcp.json`](mcp.json)

---

## 📜 License & Author

Distributed under the **MIT License**.

Created and maintained by **Sreejith** ([@sreejith1357](https://github.com/sreejith1357)).
