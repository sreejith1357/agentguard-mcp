# Changelog

All notable changes to AgentGuard MCP will be documented in this file.

## [3.1.2] - 2026-11-27

### Fixed
- **PostgreSQL Backend**: Replaced in-memory stub with a real `pg.Pool`-backed PostgreSQL repository (`PostgresConnectionPool`, `PostgresCircuitBreakerRepository`, `PostgresBaselineRepository`, `PostgresCausalTraceRepository`) with parameterized SQL, recursive CTE lineage, schema initialization, and health probes.
- **Async Store Consistency**: Added async repository wrappers (`getCircuitAsync`, `upsertCircuitAsync`, `getBaselineAsync`, `querySessionHistoryAsync`, `getLineageForFailuresAsync`) so all MCP tools work seamlessly with both SQLite and PostgreSQL.
- **Loop Detection**: Implemented real-time trajectory loop detection (`exact_repeat`, `parameter_repetition`, `oscillation`) in `log_checkpoint` via `src/utils/loopDetector.ts`.
- **Prompt Injection Detection**: Implemented recursive prompt injection & delimiter spoofing detection in `validate_tool_response` via `src/utils/injectionDetector.ts`.
- **Circuit Breaker Configuration**: Wired `CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_COOLDOWN_SECONDS`, `CIRCUIT_SUCCESS_THRESHOLD`, and `CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS` env vars, added `HALF_OPEN` probe timeout recovery, and persisted `last_error` & `last_response_time_ms`.
- **Auth Hardening**: Prevented tenant DB API keys from authenticating `/admin/*` endpoints in `verifyAdminKey()`, and blocked invalid Bearer headers even when `AGENTGUARD_API_KEY` is unset.
- **Admin Console XSS & CSP**: Added `escapeHtml()` sanitization and delegated event handlers in `public/admin.html`, and scoped Helmet CSP per-route so API routes keep strict CSP.
- **Webhook Security & Reliability**: Added SSRF validation and `executeSSRFRequest()` IP-pinned delivery, event validation, parallel dispatch, exponential backoff retries, and `webhook_deliveries` audit logging.
- **Docker Volume Mount**: Fixed `docker-compose.yml` to mount `/app/data` directory (`DB_PATH=/app/data/agentguard.db`) instead of mounting a directory over a file path.
- **Python SDK**: Fixed `health_check(url=...)` and `analyze_causality(session_id, failed_checkpoint_ids)` parameter mismatches, added all 12 tool wrappers, added retry logic, and added `AsyncAgentGuardClient`.
- **MCP Transports & Primitives**: Added `--stdio` (`StdioServerTransport`), `/sse` + `/messages` (`SSEServerTransport`), MCP Resources (`agentguard://status`, `agentguard://circuits`), and MCP Prompts (`pre_flight_check`, `root_cause_debug`).
- **Maintenance & Observability**: Scheduled periodic database maintenance (including `call_logs`, `admin_audit_logs`, `webhook_deliveries`, and `rate_limit_buckets` pruning), added `POST /admin/maintenance`, `GET /admin/metrics` (Prometheus), and P50/P95/P99 latency percentiles.

