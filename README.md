# AgentGuard MCP

<div align="center">

# 🛡️ AgentGuard MCP (v3.1.2 Enterprise)

**Active Control Plane & Governance Infrastructure for AI Agents built on the Model Context Protocol (MCP)**

[![npm version](https://img.shields.io/npm/v/agentguard-mcp-server.svg?color=cb3837&style=flat-square)](https://www.npmjs.com/package/agentguard-mcp-server)
[![PyPI version](https://img.shields.io/pypi/v/agentguard-mcp-sdk.svg?color=3775a9&style=flat-square)](https://pypi.org/project/agentguard-mcp-sdk/)
[![MCP Spec](https://img.shields.io/badge/MCP_Spec-1.30.0-purple.svg?style=flat-square)](https://modelcontextprotocol.io)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ed.svg?style=flat-square)](Dockerfile)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

[Features](#-key-features) • [Architecture](#-architectural-design) • [Quick Start](#-quick-start) • [Admin Console](#-admin-console) • [MCP Tools](#-mcp-tool-reference) • [SDKs](#-python--node-sdks) • [Version History](#-version-evolution)

---

</div>

## 📌 Executive Summary

Most AI agent observability platforms operate purely **after the fact**—logging telemetry 10 minutes after an autonomous agent loops endlessly, burns API tokens, or processes corrupted tool outputs.

**AgentGuard MCP** provides an **active control plane** for Model Context Protocol (MCP) agents. Through standard MCP tool protocol primitives and lightweight SDK client wrappers, agents and execution orchestrators pre-flight external tool health, validate response data schemas, track reasoning trajectories, and isolate cascading API failures in real time.

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

## ✨ Key Features (Fully Implemented & Test-Verified)

### 🛡️ Active Execution Governance
* **Infinite Loop & Trajectory Checkpointing**: Real-time detection of duplicate parameter patterns and recursive execution loops (`log_checkpoint`).
* **Schema & Output Sanitization**: Validates tool payload structures, data freshness, and checks for prompt injection signatures (`validate_tool_response`).
* **Statistical Anomaly Detection**: Calculates Z-scores and sliding-window Exponential Moving Averages (EMA) to flag latency drift or anomalous output sizes (`detect_anomaly`).

### ⚡ Circuit Breaker Reliability Grid
* **Automated Failure Isolation**: Automatically trips breakers from `CLOSED` to `OPEN` after 5 consecutive tool failures (`report_tool_result`, `get_circuit_state`).
* **Canary Recovery Testing**: Transitions to `HALF_OPEN` after a 60-second cooldown window to safely test downstream endpoint recovery.

### 🏢 Multi-Tenant Security & Storage Tier
* **Hashed Token Authentication**: Supports tenant-scoped Bearer tokens with SHA-256 key hashing in database storage (`apiKeyStore.ts`).
* **Dual Database Architecture**: Zero-config SQLite (WAL mode with 64MB mmap) + production PostgreSQL repository abstraction (`sqliteRepository.ts`, `postgresRepository.ts`).
* **Security Audit Trail**: Append-only audit logger capturing administrative events, tenant updates, and IP addresses (`auditLogger.ts`).

### 🖥️ Admin Console & Webhook Dispatcher
* **Live Administration Web UI**: Standalone browser application available at `/admin` for real-time tenant subscription management, key generation, circuit resets, and audit log inspection.
* **Webhook Alerting**: Asynchronous event dispatcher firing HTTP POST alerts (`circuit.tripped`, `anomaly.detected`, `quota.warning`) to external monitoring endpoints.

---

## 🛠️ Complete MCP Tool Reference (12 Registered Tools)

AgentGuard exposes **12 purpose-built MCP tools** divided into four operational modules:

### 1. Core Governance & Security Module
| Tool | Description | Key Inputs |
| :--- | :--- | :--- |
| `health_check` | Proactively tests HTTP/HTTPS target health and response latency before tool invocation. | `url`, `expected_status`, `timeout_ms` |
| `validate_tool_response` | Inspects tool output data for schema types, required fields, freshness, and prompt injection signatures. | `data`, `schema`, `required_fields`, `max_age_seconds` |
| `log_checkpoint` | Records agent reasoning step and checks trajectory history for infinite loops. | `session_id`, `checkpoint_type`, `content`, `tags` |
| `detect_anomaly` | Evaluates observed metrics against baseline statistics using Z-score outlier detection. | `value`, `baseline`, `metric_name`, `sensitivity` |
| `get_session_history` | Retrieves full persistent session trajectory with type, timestamp, and tag filters. | `session_id`, `limit`, `checkpoint_type`, `tags` |

### 2. Circuit Breaker Grid Module
| Tool | Description | Key Inputs |
| :--- | :--- | :--- |
| `report_tool_result` | Reports tool call success or failure to update circuit failure counters. | `tool_name`, `success`, `error_message` |
| `get_circuit_state` | Queries current pre-flight breaker state (`CLOSED`, `OPEN`, `HALF_OPEN`). | `tool_name` |
| `reset_circuit` | Manually resets an `OPEN` or `HALF_OPEN` circuit back to `CLOSED`. | `tool_name`, `reason` |

### 3. Causal Chain Analysis Module
| Tool | Description | Key Inputs |
| :--- | :--- | :--- |
| `analyze_causality` | Performs Breadth-First Search (BFS) over parent checkpoint IDs to locate root-cause failure steps. | `session_id`, `failed_checkpoint_ids` |

### 4. Adaptive Baseline Learning Module
| Tool | Description | Key Inputs |
| :--- | :--- | :--- |
| `record_observation` | Feeds numeric metric samples into the online Exponential Moving Average (EMA) engine. | `metric_name`, `value` |
| `get_learned_baseline` | Fetches computed statistical mean, standard deviation, and sample count baselines. | `metric_name`, `include_recent_observations` |
| `reset_baseline` | Resets or soft-deletes learned statistical baselines for a target metric. | `metric_name`, `hard_delete` |

---

## 🚀 Quick Start

### 1. Run the MCP Server

```bash
# Option A: Run directly via npx
npx agentguard-mcp-server

# Option B: Run via Docker Container
docker run -p 3000:3000 \
  -e AGENTGUARD_ADMIN_KEY=$(openssl rand -hex 32) \
  -e AGENTGUARD_API_KEY=$(openssl rand -hex 32) \
  sreejith1357/agentguard-mcp
```

### 2. Configure Claude Desktop (`claude_desktop_config.json`)

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

---

## 🐍 Python & Node SDKs

### Python SDK (`agentguard-mcp-sdk`)

```bash
pip install agentguard-mcp-sdk
```

```python
from agentguard import AgentGuardClient

client = AgentGuardClient(
    base_url="http://localhost:3000",
    api_key="ag_live_your_api_key_here"
)

# 1. Pre-flight Circuit Check
circuit = client.check_circuit("weather_api")
if circuit.get("state") == "OPEN":
    print("⚡ Circuit is OPEN! Activating fallback strategy.")

# 2. Checkpoint Trajectory
checkpoint = client.log_checkpoint(
    session_id="sess_1029",
    step_index=1,
    tool_name="web_search",
    tool_input={"query": "mcp security"}
)

if checkpoint.get("loop_detected"):
    print("⚠️ Loop detected! Halting execution.")
```

---

## 🖥️ Admin Web Console (`/admin`)

Access the built-in management UI at `http://localhost:3000/admin`:

* **Analytics**: Real-time tool call distribution and execution volume.
* **Tenant Governance**: Manage customer slugs, subscription plans (`Free`, `Starter`, `Pro`, `Team`), monthly quotas, and account suspensions.
* **API Keys**: Generate live Bearer tokens (`ag_live_...`) with instant copy helpers and key revocation.
* **Circuit Grid**: Live monitor for tool circuit statuses with manual override reset buttons.
* **Webhooks**: Configure real-time HTTP POST notification endpoints.
* **Audit Trail**: Filterable security audit logs capturing administrative actions and request IP addresses.

---

## 📜 Version Evolution

| Version | Architectural Focus | Key Additions |
| :--- | :--- | :--- |
| **v1.0.0** | Core MCP Safety Tools | `health_check`, `validate_tool_response`, `log_checkpoint`, `detect_anomaly`, `get_session_history`. |
| **v2.0.0 / v2.1.0** | Dynamic Reliability Engine | SQLite persistence, Circuit Breakers (`report_tool_result`, `get_circuit_state`), Causal BFS Analysis, and EMA Adaptive Baselines. |
| **v3.0.0 / v3.1.2** | Enterprise SaaS Control Plane | SQLite WAL + PostgreSQL dual repository architecture, Standalone Admin Console (`/admin`), SHA-256 API Key hashing, Webhook Dispatcher, and Security Audit Logger. |

---

## 🌐 Ecosystem Registries

* 📦 **NPM Registry**: [`agentguard-mcp-server`](https://www.npmjs.com/package/agentguard-mcp-server)
* 🐍 **PyPI Registry**: [`agentguard-mcp-sdk`](https://pypi.org/project/agentguard-mcp-sdk/)
* 📋 **Official MCP Standard Metadata**: [`server.json`](server.json)
* 🛠️ **Smithery.ai**: [`smithery.yaml`](smithery.yaml)
* 🦙 **Glama.ai**: [`glama.json`](glama.json)
* 🌐 **MCP.so / Mcpize**: [`mcp.json`](mcp.json)

---

## 📜 License & Author

Distributed under the **MIT License**. Created by **Sreejith** ([@sreejith1357](https://github.com/sreejith1357)).
