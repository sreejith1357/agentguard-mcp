import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { randomUUID } from "node:crypto";
import path from "node:path";


// Tools
import { healthCheckTool } from "./tools/healthCheck.js";
import { validateToolResponseTool } from "./tools/validateToolResponse.js";
import { logCheckpointTool } from "./tools/logCheckpoint.js";
import { detectAnomalyTool } from "./tools/detectAnomaly.js";
import { getSessionHistoryTool } from "./tools/getSessionHistory.js";
import { circuitBreakerTools } from "./tools/circuitBreaker.js";
import { causalChainTools } from "./tools/causalChain.js";
import { adaptiveBaselineTools } from "./tools/adaptiveBaseline.js";
import { getStorageStats } from "./utils/storage.js";
import { getAllCircuits, upsertCircuit } from "./utils/circuitStore.js";
import { getBaselineStats } from "./utils/metricStore.js";

import { initializeDatabase } from "./db/schema.js";
import { authenticateRequest, tenantContextStorage, verifyAdminKey } from "./utils/auth.js";
import { runDatabaseMaintenance } from "./utils/maintenance.js";
import { logCall, getUsageStats, getAllTenantsStats, getMonthlyUsageSummary } from "./utils/callLogger.js";
import { checkTenantRateLimit } from "./utils/rateLimiter.js";
import { createApiKey, listApiKeys, revokeApiKey, createTenant, listTenants, getTenant } from "./utils/apiKeyStore.js";
import { createWebhook, listWebhooks, deleteWebhook, dispatchWebhookEvent } from "./utils/webhookDispatcher.js";


// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const app = express();

// Request ID header middleware for request tracing
app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("X-Request-ID", requestId);

    // Enforce UTF-8 charset on Content-Type headers so HTTP clients (e.g. Python requests) decode emojis cleanly
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: any) {
        if (typeof name === "string" && name.toLowerCase() === "content-type") {
            if (typeof value === "string" && !value.toLowerCase().includes("charset")) {
                value = `${value}; charset=utf-8`;
            }
        }
        return originalSetHeader(name, value);
    };

    next();
});

// HTTP security headers via helmet
app.use(helmet());

// CORS configuration (allow all origins by default, configurable via CORS_ORIGIN)
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));

// Production HTTP request logger
app.use(morgan(":method :url :status :res[content-length] - :response-time ms [req-id: :req[x-request-id]]"));

app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// Rate limiting — 100 requests per 15 minutes per IP
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

app.use(
    rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX,
        standardHeaders: true,  // Return RateLimit-* headers (RFC 6585 draft)
        legacyHeaders: false,   // Disable X-RateLimit-* legacy headers
        handler: (_req: Request, res: Response) => {
            res.status(429).json({
                error: "Too Many Requests",
                message: `Rate limit exceeded: ${RATE_LIMIT_MAX} requests per 15 minutes per IP`,
                retry_after_seconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
                timestamp: new Date().toISOString(),
            });
        },
    })
);

const SERVER_NAME = "AgentGuard MCP";
const SERVER_VERSION = "3.1.0";
const START_TIME = Date.now();

const REGISTERED_TOOLS = [
    "health_check",
    "validate_tool_response",
    "log_checkpoint",
    "detect_anomaly",
    "get_session_history",
    // Circuit Breaker (v2.0.0)
    "report_tool_result",
    "get_circuit_state",
    "reset_circuit",
    // Causal Chain (v2.0.0)
    "analyze_causality",
    // Adaptive Baseline Learning (v2.0.0)
    "record_observation",
    "get_learned_baseline",
    "reset_baseline",
] as const;

// Create MCP server
const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
        "Production-grade reliability and observability infrastructure for AI agents. Detects silent failures, validates tool outputs, logs reasoning checkpoints, flags anomalies, and provides persistent session memory.",
});

// Register all tools
healthCheckTool(server);
validateToolResponseTool(server);
logCheckpointTool(server);
detectAnomalyTool(server);
getSessionHistoryTool(server);
// v2.0.0 tools
circuitBreakerTools(server);
causalChainTools(server);
adaptiveBaselineTools(server);

// ---------------------------------------------------------------------------
// Authentication middleware — protects MCP tool calls via Bearer token & sets tenant context
// ---------------------------------------------------------------------------

app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST") {
        const result = authenticateRequest(req);
        if (!result.authenticated) {
            res.status(401).json({
                error: "UNAUTHORIZED",
                message: result.error,
                hint: "Set AGENTGUARD_API_KEY environment variable and pass it as: Authorization: Bearer <key>",
                timestamp: new Date().toISOString(),
            });
            return;
        }
        if (result.identity) {
            (req as any).tenantIdentity = result.identity;
        }
    }
    next();
});

// ---------------------------------------------------------------------------
// MCP endpoint — stateless StreamableHTTP (MCP protocol rev. July 2026)
// ---------------------------------------------------------------------------

app.post("/mcp", async (req: Request, res: Response) => {
    const startTime = Date.now();
    let isSuccess = true;
    let errorCode: string | undefined = undefined;

    // Extract tool name from request body
    const toolName = req.body?.params?.name || "unknown";
    const tenantCtx = (req as any).tenantIdentity;
    const tenantId = tenantCtx?.tenant_id || "default-tenant";

    // Rate Limiting & Plan Quota Enforcement
    const rateLimitCheck = checkTenantRateLimit(tenantId);
    if (!rateLimitCheck.allowed) {
        res.setHeader("Retry-After", String(rateLimitCheck.resetAt - Math.floor(Date.now() / 1000)));
        res.setHeader("X-RateLimit-Limit", rateLimitCheck.limit);
        res.setHeader("X-RateLimit-Remaining", 0);

        if (rateLimitCheck.reason === "monthly_quota_exceeded") {
            dispatchWebhookEvent({
                tenant_id: tenantId,
                event: "quota.warning",
                payload: {
                    monthly_used: rateLimitCheck.monthlyUsed,
                    monthly_quota: rateLimitCheck.monthlyQuota,
                    message: "Monthly call quota exceeded",
                },
            });
        }

        res.status(429).json({
            error: "TOO_MANY_REQUESTS",
            reason: rateLimitCheck.reason,
            message:
                rateLimitCheck.reason === "monthly_quota_exceeded"
                    ? `Monthly call quota of ${rateLimitCheck.limit.toLocaleString()} calls exceeded for plan.`
                    : `Per-minute rate limit of ${rateLimitCheck.limit} requests/min exceeded.`,
            monthly_used: rateLimitCheck.monthlyUsed,
            monthly_quota: rateLimitCheck.monthlyQuota,
            timestamp: new Date().toISOString(),
        });
        return;
    }

    // Wrap res.write & res.end to measure response timing & capture completion state
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let responseBody = "";

    res.write = function (chunk: any, ...args: any[]) {
        if (chunk) {
            responseBody += chunk.toString();
        }
        return originalWrite(chunk, ...args);
    };

    res.end = function (chunk?: any, ...args: any[]) {
        if (chunk) {
            responseBody += chunk.toString();
        }
        const responseTime = Date.now() - startTime;

        if (res.statusCode >= 400) {
            isSuccess = false;
            errorCode = `HTTP_${res.statusCode}`;
        } else if (
            responseBody.includes('"isError":true') ||
            responseBody.includes('"_error"') ||
            responseBody.includes('"error":{') ||
            responseBody.includes('"error": {')
        ) {
            isSuccess = false;
            try {
                const match =
                    responseBody.match(/"error"\s*:\s*"([^"]+)"/) ||
                    responseBody.match(/"code"\s*:\s*"?([^",}\s]+)"?/);
                if (match && match[1]) {
                    errorCode = match[1];
                }
            } catch { /* ignore */ }
        }

        logCall({
            tenant_id: tenantId,
            project_id: tenantCtx?.project_id || "default-project",
            env: tenantCtx?.env || (process.env.AGENTGUARD_API_KEY ? "production" : "development"),
            tool_name: toolName,
            success: isSuccess,
            response_time_ms: responseTime,
            ...(errorCode && { error_code: errorCode }),
        });

        return originalEnd(chunk, ...args);
    };

    try {
        const identity = (req as any).tenantIdentity;
        const handleMcpRequest = async () => {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // stateless mode — no in-memory session state
            });

            res.on("close", () => transport.close());
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        };

        if (identity) {
            await tenantContextStorage.run(identity, handleMcpRequest);
        } else {
            await handleMcpRequest();
        }
    } catch (error) {
        console.error("[AgentGuard] MCP request error:", error);
        res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
        });
    }
});

// Serve standalone Admin Console single-page web app for browser requests
app.get("/admin", (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.accept?.includes("text/html") || !req.headers.authorization) {
        const adminPath = path.resolve(__dirname, "..", "public", "admin.html");
        res.sendFile(adminPath);
        return;
    }
    next();
});

// Admin Auth Middleware Helper for JSON API endpoints
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization;
    if (!verifyAdminKey(auth)) {
        res.status(401).json({ error: "Unauthorized", timestamp: new Date().toISOString() });
        return;
    }
    next();
}

app.use("/admin", requireAdminAuth);


// Usage Analytics
app.get("/admin/usage", (req: Request, res: Response) => {
    const tenant_id = (req.query.tenant_id as string) || "all";
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);

    if (tenant_id === "all") {
        res.json({
            month,
            tenants: getAllTenantsStats(month),
            timestamp: new Date().toISOString(),
        });
        return;
    }

    res.json(getUsageStats(tenant_id, month));
});

// Tenants Management
app.get("/admin/tenants", (_req: Request, res: Response) => {
    res.json({ tenants: listTenants(), timestamp: new Date().toISOString() });
});

app.post("/admin/tenants", (req: Request, res: Response) => {
    const { tenant_id, name, plan } = req.body || {};
    if (!tenant_id || !name) {
        res.status(400).json({ error: "Missing required fields: tenant_id, name" });
        return;
    }
    const tenant = createTenant({ tenant_id, name, plan });
    res.json({ tenant, timestamp: new Date().toISOString() });
});

// API Keys Management
app.get("/admin/api-keys", (req: Request, res: Response) => {
    const tenant_id = req.query.tenant_id as string;
    res.json({ api_keys: listApiKeys(tenant_id), timestamp: new Date().toISOString() });
});

app.post("/admin/api-keys", (req: Request, res: Response) => {
    const { tenant_id, name } = req.body || {};
    if (!tenant_id) {
        res.status(400).json({ error: "Missing required field: tenant_id" });
        return;
    }
    try {
        const apiKey = createApiKey({ tenant_id, name });
        res.json({
            message: "API key created successfully. Save this raw key now, it will not be shown again.",
            api_key: apiKey.key,
            id: apiKey.id,
            prefix: apiKey.prefix,
            tenant_id: apiKey.tenant_id,
            name: apiKey.name,
            timestamp: new Date().toISOString(),
        });
    } catch (err: any) {
        res.status(400).json({ error: err.message || "Failed to create API key" });
    }
});

app.delete("/admin/api-keys/:id", (req: Request, res: Response) => {
    const keyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const success = revokeApiKey(keyId);
    if (!success) {
        res.status(404).json({ error: "API key not found or already revoked" });
        return;
    }
    res.json({ message: "API key revoked successfully", timestamp: new Date().toISOString() });
});

// Webhooks Management
app.get("/admin/webhooks", (req: Request, res: Response) => {
    const tenant_id = req.query.tenant_id as string;
    res.json({ webhooks: listWebhooks(tenant_id), timestamp: new Date().toISOString() });
});

app.post("/admin/webhooks", (req: Request, res: Response) => {
    const { tenant_id, url, events } = req.body || {};
    if (!tenant_id || !url) {
        res.status(400).json({ error: "Missing required fields: tenant_id, url" });
        return;
    }
    const webhook = createWebhook({ tenant_id, url, events });
    res.json({ webhook, timestamp: new Date().toISOString() });
});

app.delete("/admin/webhooks/:id", (req: Request, res: Response) => {
    const hookId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const success = deleteWebhook(hookId);
    if (!success) {
        res.status(404).json({ error: "Webhook not found" });
        return;
    }
    res.json({ message: "Webhook deleted successfully", timestamp: new Date().toISOString() });
});


// Circuit Breakers List & Reset
app.get("/admin/circuits", (_req: Request, res: Response) => {
    res.json({ circuits: getAllCircuits(), timestamp: new Date().toISOString() });
});

app.post("/admin/circuits/:name/reset", (req: Request, res: Response) => {
    const circuitName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    try {
        upsertCircuit(decodeURIComponent(circuitName), {
            state: "CLOSED",
            failure_count: 0,
            success_count: 0,
            opened_at: null,
            half_opened_at: null,
        });
        res.json({ message: `Circuit '${circuitName}' reset to CLOSED`, timestamp: new Date().toISOString() });
    } catch (err: any) {
        res.status(400).json({ error: err.message || "Failed to reset circuit" });
    }
});



// ---------------------------------------------------------------------------
// Health endpoint — uptime monitoring for Railway / Cloudflare / k8s probes
// ---------------------------------------------------------------------------

import { RepositoryFactory } from "./repositories/factory.js";

app.get("/health", async (_req: Request, res: Response) => {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);

    // Database repository health probe
    const dbHealth = await RepositoryFactory.getInstance().getDatabaseHealth().catch((err) => ({
        healthy: false,
        backend: RepositoryFactory.getInstance().getBackend(),
        connection_pooled: false,
        latency_ms: -1,
        error: String(err),
    }));

    // Storage stats — never let a failure break the health probe
    const storage = await getStorageStats().catch(() => ({
        total_sessions: -1,
        total_checkpoints: -1,
    }));

    // Circuit breaker stats — wrapped for safety
    let total_circuits = 0;
    let open_circuits = 0;
    let half_open_circuits = 0;
    try {
        const circuits = getAllCircuits();
        total_circuits = circuits.length;
        open_circuits = circuits.filter((c) => c.state === "OPEN").length;
        half_open_circuits = circuits.filter((c) => c.state === "HALF_OPEN").length;
    } catch { /* non-fatal */ }

    // Adaptive baseline stats
    let total_metrics_tracked = 0;
    let confident_baselines = 0;
    try {
        const baselineStats = getBaselineStats();
        total_metrics_tracked = baselineStats.total_metrics_tracked;
        confident_baselines = baselineStats.confident_baselines;
    } catch { /* non-fatal */ }

    // Monthly usage stats — wrapped for safety
    let usageSummary = { total_calls_this_month: 0, active_tenants_this_month: 0 };
    try {
        usageSummary = getMonthlyUsageSummary();
    } catch { /* non-fatal */ }

    res.json({
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        uptime_seconds: uptimeSeconds,
        node_version: process.version,
        tools_registered: REGISTERED_TOOLS.length,
        tools: REGISTERED_TOOLS,
        database_health: dbHealth,
        storage: {
            total_sessions: storage.total_sessions,
            total_checkpoints: storage.total_checkpoints,
            checkpoint_limit_per_session: parseInt(process.env.MAX_CHECKPOINTS ?? "10000", 10),
        },
        usage: usageSummary,
        storage_mode: dbHealth.backend,
        storage_note: "Supports runtime backend switching between local SQLite and distributed PostgreSQL.",
        v2_systems: {
            circuit_breaker: {
                total_circuits,
                open_circuits,
                half_open_circuits,
            },
            adaptive_baseline: {
                total_metrics_tracked,
                confident_baselines,
            },
        },
        auth_mode: process.env.AGENTGUARD_API_KEY
            ? "authenticated"
            : "open (no key set)",
        timestamp: new Date().toISOString(),
    });
});

// ---------------------------------------------------------------------------
// 404 handler for unknown routes
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
    res.status(404).json({
        error: "Not Found",
        message: "Available endpoints: POST /mcp, GET /health, GET /admin (Admin Console UI), GET /admin/usage, GET /admin/tenants, GET /admin/api-keys, GET /admin/circuits, GET /admin/webhooks",
        timestamp: new Date().toISOString(),
    });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Ensure SQLite tables exist before the server accepts any traffic
initializeDatabase();
console.log("[AgentGuard] SQLite database initialized at agentguard.db");
runDatabaseMaintenance().catch((err) =>
    console.error("[AgentGuard] Maintenance error:", err)
);

const PORT = process.env.PORT || 3000;

const httpServer = app.listen(PORT, () => {
    console.log("");
    console.log("┌─────────────────────────────────────────┐");
    console.log(`│       ${SERVER_NAME} v${SERVER_VERSION}           │`);
    console.log("├─────────────────────────────────────────┤");
    console.log(`│  MCP endpoint  : http://localhost:${PORT}/mcp │`);
    console.log(`│  Admin Console : http://localhost:${PORT}/admin │`);
    console.log(`│  Health check  : http://localhost:${PORT}/health│`);
    console.log("├─────────────────────────────────────────┤");
    console.log("│  Registered tools:                      │");
    REGISTERED_TOOLS.forEach((t) => console.log(`│    • ${t.padEnd(33)}│`));
    console.log("└─────────────────────────────────────────┘");

    console.log("");
    console.log(
        "[AgentGuard] ℹ️  Storage: SQLite WAL-mode (unified single-instance)."
    );

    if (!process.env.AGENTGUARD_API_KEY) {
        console.warn(
            "[AgentGuard] ⚠️  AGENTGUARD_API_KEY not set — running in open mode. Set this in production."
        );
    } else {
        console.log("[AgentGuard] ✅  API key authentication enabled");
    }
});

// ---------------------------------------------------------------------------
// Graceful shutdown — flush in-flight requests before terminating
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
    console.log(`\n[AgentGuard] Received ${signal}. Shutting down gracefully…`);
    httpServer.close((err) => {
        if (err) {
            console.error("[AgentGuard] Error during shutdown:", err);
            process.exit(1);
        }
        console.log("[AgentGuard] Server closed. Goodbye.");
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful close stalls
    setTimeout(() => {
        console.error("[AgentGuard] Forced shutdown after 10s timeout.");
        process.exit(1);
    }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));