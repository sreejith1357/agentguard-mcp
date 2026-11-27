import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// Tools
import { healthCheckTool } from "./tools/healthCheck.js";
import { validateToolResponseTool } from "./tools/validateToolResponse.js";
import { logCheckpointTool } from "./tools/logCheckpoint.js";
import { detectAnomalyTool } from "./tools/detectAnomaly.js";
import { getSessionHistoryTool } from "./tools/getSessionHistory.js";
import { circuitBreakerTools } from "./tools/circuitBreaker.js";
import { causalChainTools } from "./tools/causalChain.js";
import { adaptiveBaselineTools } from "./tools/adaptiveBaseline.js";

// Infrastructure & Utilities
import { initializeDatabase } from "./db/schema.js";
import db from "./db/schema.js";
import { RepositoryFactory } from "./repositories/factory.js";
import { getStorageStats } from "./utils/storage.js";
import { getAllCircuitsAsync, upsertCircuitAsync } from "./utils/circuitStore.js";
import { getBaselineStatsAsync } from "./utils/metricStore.js";
import { authenticateRequest, tenantContextStorage, verifyAdminKey, type TenantIdentity } from "./utils/auth.js";
import { runDatabaseMaintenance } from "./utils/maintenance.js";
import { getUsageStats, getAllTenantsStats, getMonthlyUsageSummary, getPrometheusMetrics } from "./utils/callLogger.js";
import { checkTenantRateLimit } from "./utils/rateLimiter.js";
import { createApiKey, listApiKeys, revokeApiKey, createTenant, listTenants, getTenant, updateTenantStatus, deleteTenant } from "./utils/apiKeyStore.js";
import { createWebhook, listWebhooks, deleteWebhook, listWebhookDeliveries, dispatchWebhookEvent } from "./utils/webhookDispatcher.js";
import { logAdminAction, listAdminAuditLogs } from "./utils/auditLogger.js";
import { attachMcpCallTelemetry } from "./middleware/requestLogger.js";
import { parseEnvInt } from "./utils/validation.js";

export const SERVER_NAME = "AgentGuard MCP";
export const SERVER_VERSION = "3.1.2";
const START_TIME = Date.now();

export const REGISTERED_TOOLS = [
    "health_check",
    "validate_tool_response",
    "log_checkpoint",
    "detect_anomaly",
    "get_session_history",
    "report_tool_result",
    "get_circuit_state",
    "reset_circuit",
    "analyze_causality",
    "record_observation",
    "get_learned_baseline",
    "reset_baseline",
] as const;

// ---------------------------------------------------------------------------
// MCP Server Factory (Tools + Resources + Prompts)
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
    const mcp = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        description:
            "Production-grade reliability and observability infrastructure for AI agents. Detects silent failures, validates tool outputs against prompt injections, logs reasoning checkpoints with loop detection, trips circuit breakers, and provides persistent session memory.",
    });

    // Register all 12 tools
    healthCheckTool(mcp);
    validateToolResponseTool(mcp);
    logCheckpointTool(mcp);
    detectAnomalyTool(mcp);
    getSessionHistoryTool(mcp);
    circuitBreakerTools(mcp);
    causalChainTools(mcp);
    adaptiveBaselineTools(mcp);

    // Register MCP Resources
    mcp.registerResource(
        "agentguard_status",
        "agentguard://status",
        {
            title: "AgentGuard Control Plane Status",
            description: "Live status summary, registered tools, and storage backend information",
            mimeType: "application/json",
        },
        async (uri) => {
            const dbHealth = await RepositoryFactory.getInstance().getDatabaseHealth();
            const circuits = await getAllCircuitsAsync();
            const baselineStats = await getBaselineStatsAsync();
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(
                            {
                                server: SERVER_NAME,
                                version: SERVER_VERSION,
                                uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
                                database_health: dbHealth,
                                circuits_tracked: circuits.length,
                                open_circuits: circuits.filter((c) => c.state === "OPEN").length,
                                adaptive_baselines: baselineStats,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    mcp.registerResource(
        "agentguard_circuits",
        "agentguard://circuits",
        {
            title: "Circuit Breaker Grid",
            description: "Current state of all tracked tool circuit breakers for the active tenant",
            mimeType: "application/json",
        },
        async (uri) => {
            const circuits = await getAllCircuitsAsync();
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify({ circuits }, null, 2),
                    },
                ],
            };
        }
    );

    // Register MCP Prompts
    mcp.registerPrompt(
        "pre_flight_check",
        {
            title: "Pre-Flight Tool Governance Check",
            description: "Guided workflow to verify circuit breaker state and endpoint health before invoking an external tool.",
            argsSchema: {
                tool_name: z.string().describe("Name of the external tool or API"),
                url: z.string().optional().describe("Optional HTTP/HTTPS endpoint URL to probe"),
            },
        },
        async ({ tool_name, url }) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text:
                            `Run a pre-flight safety check before calling "${tool_name}":\n` +
                            `1. Call get_circuit_state with tool_name="${tool_name}". If state is OPEN, abort and use a fallback.\n` +
                            (url ? `2. Call health_check on url="${url}". If unhealthy, do not proceed.\n` : "") +
                            `3. After executing "${tool_name}", always call report_tool_result and validate_tool_response.`,
                    },
                },
            ],
        })
    );

    mcp.registerPrompt(
        "root_cause_debug",
        {
            title: "Session Failure Root-Cause Analysis",
            description: "Guided workflow to inspect session history and trace causal failure chains.",
            argsSchema: {
                session_id: z.string().describe("Session identifier to diagnose"),
            },
        },
        async ({ session_id }) => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text:
                            `Diagnose failures in session "${session_id}":\n` +
                            `1. Call get_session_history with session_id="${session_id}" and checkpoint_type="error".\n` +
                            `2. Collect the failed checkpoint UUIDs and call analyze_causality with include_downstream=true.\n` +
                            `3. Summarize the root-cause candidate and impacted downstream steps.`,
                    },
                },
            ],
        })
    );

    return mcp;
}

const server = createMcpServer();

// ---------------------------------------------------------------------------
// Express HTTP Application Setup
// ---------------------------------------------------------------------------

export const app = express();

// Trust first reverse-proxy hop by default (Render, Railway, Cloudflare, Nginx)
const trustProxyRaw = process.env.TRUST_PROXY;
app.set("trust proxy", trustProxyRaw === "false" ? false : trustProxyRaw ? parseEnvInt("TRUST_PROXY", 1, 0, 10) : 1);

// Request ID & UTF-8 charset enforcement middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("X-Request-ID", requestId);

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

// Full Helmet security headers (CSP enabled globally; tailored per-route only for /admin HTML)
app.use(helmet());

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(morgan(":method :url :status :res[content-length] - :response-time ms [req-id: :req[x-request-id]]"));
app.use(express.json({ limit: "2mb" }));

// Global IP rate limiter
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = parseEnvInt("RATE_LIMIT_MAX", 500, 1);

app.use(
    rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
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

// ---------------------------------------------------------------------------
// Auth & Quota Helper for MCP Endpoints
// ---------------------------------------------------------------------------

function enforceMcpAuth(req: Request, res: Response, next: NextFunction): void {
    const result = authenticateRequest(req);
    if (!result.authenticated) {
        res.status(401).json({
            error: "UNAUTHORIZED",
            message: result.error,
            hint: "Set AGENTGUARD_API_KEY or generate a tenant key and pass: Authorization: Bearer <key>",
            timestamp: new Date().toISOString(),
        });
        return;
    }
    if (result.identity) {
        (req as any).tenantIdentity = result.identity;
    }
    next();
}

app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST") {
        enforceMcpAuth(req, res, next);
        return;
    }
    next();
});

// ---------------------------------------------------------------------------
// MCP StreamableHTTP Endpoint
// ---------------------------------------------------------------------------

app.get("/mcp", (_req: Request, res: Response) => {
    res.json({
        service: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: "Model Context Protocol (MCP) StreamableHTTP",
        message: "The /mcp endpoint accepts POST requests containing JSON-RPC 2.0 tool invocation payloads.",
        usage: {
            method: "POST",
            url: "/mcp",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": "Bearer <your-api-key>",
            },
        },
        sse_endpoint: "/sse",
        admin_console: "/admin",
        health_check: "/health",
        registered_tools_count: REGISTERED_TOOLS.length,
        registered_tools: REGISTERED_TOOLS,
        timestamp: new Date().toISOString(),
    });
});

app.post("/mcp", async (req: Request, res: Response) => {
    const toolName = req.body?.params?.name || "unknown";
    const rpcMethod = req.body?.method || "";
    const tenantCtx: TenantIdentity | undefined = (req as any).tenantIdentity;
    const tenantId = tenantCtx?.tenant_id || "default-tenant";

    // Enforce per-key tool scopes if configured on the API key
    if (
        rpcMethod === "tools/call" &&
        tenantCtx?.scopes &&
        tenantCtx.scopes.length > 0 &&
        !tenantCtx.scopes.includes("*") &&
        !tenantCtx.scopes.includes(toolName)
    ) {
        res.status(403).json({
            error: "FORBIDDEN_SCOPE",
            message: `API key is not authorized to invoke tool "${toolName}". Allowed scopes: ${tenantCtx.scopes.join(", ")}`,
            timestamp: new Date().toISOString(),
        });
        return;
    }

    // Per-tenant rate limit & monthly quota enforcement
    const rateLimitCheck = checkTenantRateLimit(tenantId);
    if (!rateLimitCheck.allowed) {
        res.setHeader("Retry-After", String(Math.max(1, rateLimitCheck.resetAt - Math.floor(Date.now() / 1000))));
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

    attachMcpCallTelemetry(req, res, tenantCtx);

    try {
        const handleMcpRequest = async () => {
            const requestServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });

            res.on("close", () => {
                transport.close().catch(() => {});
                requestServer.close().catch(() => {});
            });
            await requestServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
        };

        if (tenantCtx) {
            await tenantContextStorage.run(tenantCtx, handleMcpRequest);
        } else {
            await handleMcpRequest();
        }
    } catch (error) {
        console.error("[AgentGuard] MCP request error:", error);
        if (!res.headersSent) {
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString(),
            });
        }
    }
});

// ---------------------------------------------------------------------------
// Legacy SSE Transport (/sse + /messages) for SSE MCP Clients
// ---------------------------------------------------------------------------

const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer; identity?: TenantIdentity }>();

app.get("/sse", enforceMcpAuth, async (req: Request, res: Response) => {
    const identity: TenantIdentity | undefined = (req as any).tenantIdentity;
    const sseServer = createMcpServer();
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, { transport, server: sseServer, identity });

    res.on("close", () => {
        sseSessions.delete(transport.sessionId);
        sseServer.close().catch(() => {});
    });

    if (identity) {
        await tenantContextStorage.run(identity, () => sseServer.connect(transport));
    } else {
        await sseServer.connect(transport);
    }
});

app.post("/messages", enforceMcpAuth, async (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId || "");
    const session = sseSessions.get(sessionId);
    if (!session) {
        res.status(404).json({ error: "SSE session not found", sessionId });
        return;
    }

    const identity = session.identity || (req as any).tenantIdentity;
    if (identity) {
        await tenantContextStorage.run(identity, () => session.transport.handlePostMessage(req, res, req.body));
    } else {
        await session.transport.handlePostMessage(req, res, req.body);
    }
});

// ---------------------------------------------------------------------------
// Admin Endpoints & Standalone Admin Console (/admin)
// ---------------------------------------------------------------------------

const adminRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "TOO_MANY_REQUESTS", message: "Admin rate limit exceeded. Please wait 1 minute." },
});

app.use("/admin", adminRateLimiter);

// Serve standalone Admin Console HTML with route-specific CSP
app.get("/admin", (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.accept?.includes("text/html") || !req.headers.authorization) {
        const adminPath = path.resolve(__dirname, "..", "public", "admin.html");
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http: https:; img-src 'self' data:;"
        );
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.sendFile(adminPath);
        return;
    }
    next();
});

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
    if (req.method === "OPTIONS") {
        next();
        return;
    }
    const auth = req.headers.authorization;
    if (!verifyAdminKey(auth)) {
        res.status(401).json({
            error: "Unauthorized",
            message: "Invalid or missing Admin API Key",
            timestamp: new Date().toISOString(),
        });
        return;
    }
    next();
}

app.use("/admin", requireAdminAuth);

// Zod schemas for Admin REST endpoints
const CreateTenantBodySchema = z.object({
    tenant_id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "tenant_id must be alphanumeric with dashes/underscores"),
    name: z.string().min(1).max(128),
    plan: z.enum(["free", "starter", "pro", "team"]).optional(),
    email: z.string().email().max(254).optional().or(z.literal("")),
    notes: z.string().max(2000).optional(),
});

const UpdateTenantBodySchema = z.object({
    status: z.enum(["active", "suspended"]).optional(),
    plan: z.enum(["free", "starter", "pro", "team"]).optional(),
    notes: z.string().max(2000).optional(),
    email: z.string().email().max(254).optional().or(z.literal("")),
});

const CreateApiKeyBodySchema = z.object({
    tenant_id: z.string().min(1).max(64),
    name: z.string().min(1).max(128).optional(),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
    expires_at: z.string().optional(),
    scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
});

const CreateWebhookBodySchema = z.object({
    tenant_id: z.string().min(1).max(64),
    url: z.string().url().max(2048),
    events: z.array(z.string().min(1)).optional(),
});

app.get("/admin/usage", (req: Request, res: Response) => {
    const tenant_id = (req.query.tenant_id as string) || "all";
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);

    const stats = getUsageStats(tenant_id, month);
    const tenantList = getAllTenantsStats(month);

    res.json({
        ...stats,
        tenants: tenantList,
        timestamp: new Date().toISOString(),
    });
});

app.get("/admin/metrics", (_req: Request, res: Response) => {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(getPrometheusMetrics(uptimeSeconds));
});

app.get("/admin/tenants", (_req: Request, res: Response) => {
    res.json({ tenants: listTenants(), timestamp: new Date().toISOString() });
});

app.post("/admin/tenants", (req: Request, res: Response) => {
    const parsed = CreateTenantBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request payload", details: parsed.error.issues });
        return;
    }
    const { tenant_id, name, plan, email, notes } = parsed.data;
    const tenant = createTenant({ tenant_id, name, plan, email: email || undefined, notes });
    logAdminAction({
        action: "CREATE_TENANT",
        tenant_id: tenant.tenant_id,
        details: `Created tenant '${tenant.name}' with plan '${tenant.plan}'${email ? ` (${email})` : ""}`,
        ip_address: req.ip || req.socket.remoteAddress,
    });
    res.json({ tenant, timestamp: new Date().toISOString() });
});

app.patch("/admin/tenants/:id", (req: Request, res: Response) => {
    const tenant_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = UpdateTenantBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request payload", details: parsed.error.issues });
        return;
    }
    const { status, plan, notes, email } = parsed.data;
    const updated = updateTenantStatus({ tenant_id, status, plan, notes, email: email === "" ? undefined : email });
    if (!updated) {
        res.status(404).json({ error: "Tenant not found" });
        return;
    }
    logAdminAction({
        action: "UPDATE_TENANT",
        tenant_id: updated.tenant_id,
        details: `Updated tenant: status='${updated.status}', plan='${updated.plan}'${notes !== undefined ? `, notes updated` : ""}`,
        ip_address: req.ip || req.socket.remoteAddress,
    });
    res.json({ tenant: updated, timestamp: new Date().toISOString() });
});

app.delete("/admin/tenants/:id", (req: Request, res: Response) => {
    const tenant_id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (tenant_id === "default-tenant") {
        res.status(400).json({ error: "Cannot delete the default system tenant." });
        return;
    }
    try {
        const existing = getTenant(tenant_id);
        if (!existing) {
            res.status(404).json({ error: "Tenant not found" });
            return;
        }
        const deleted = deleteTenant(tenant_id);
        if (!deleted) {
            res.status(500).json({ error: "Delete operation failed" });
            return;
        }
        logAdminAction({
            action: "DELETE_TENANT",
            tenant_id,
            details: `Permanently deleted tenant '${existing.name}' (${tenant_id})`,
            ip_address: req.ip || req.socket.remoteAddress,
        });
        res.json({ message: `Tenant '${tenant_id}' deleted successfully.`, timestamp: new Date().toISOString() });
    } catch (err: any) {
        res.status(500).json({ error: err.message || "Failed to delete tenant" });
    }
});

app.get("/admin/api-keys", (req: Request, res: Response) => {
    const tenant_id = req.query.tenant_id as string;
    res.json({ api_keys: listApiKeys(tenant_id), timestamp: new Date().toISOString() });
});

app.post("/admin/api-keys", (req: Request, res: Response) => {
    const parsed = CreateApiKeyBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request payload", details: parsed.error.issues });
        return;
    }
    try {
        const apiKey = createApiKey(parsed.data);
        logAdminAction({
            action: "CREATE_API_KEY",
            tenant_id: apiKey.tenant_id,
            details: `Generated API Key '${apiKey.prefix}' (${apiKey.name})${apiKey.expires_at ? ` expires ${apiKey.expires_at}` : ""}`,
            ip_address: req.ip || req.socket.remoteAddress,
        });
        res.json({
            message: "API key created successfully. Save this raw key now, it will not be shown again.",
            api_key: apiKey.key,
            id: apiKey.id,
            prefix: apiKey.prefix,
            tenant_id: apiKey.tenant_id,
            name: apiKey.name,
            expires_at: apiKey.expires_at,
            scopes: apiKey.scopes,
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
    logAdminAction({
        action: "REVOKE_API_KEY",
        details: `Revoked API key '${keyId}'`,
        ip_address: req.ip || req.socket.remoteAddress,
    });
    res.json({ message: "API key revoked successfully", timestamp: new Date().toISOString() });
});

app.get("/admin/webhooks", (req: Request, res: Response) => {
    const tenant_id = req.query.tenant_id as string;
    res.json({ webhooks: listWebhooks(tenant_id), timestamp: new Date().toISOString() });
});

app.get("/admin/webhooks/deliveries", (req: Request, res: Response) => {
    const tenant_id = req.query.tenant_id as string;
    const limit = parseInt(String(req.query.limit || "50"), 10) || 50;
    res.json({ deliveries: listWebhookDeliveries(tenant_id, limit), timestamp: new Date().toISOString() });
});

app.post("/admin/webhooks", (req: Request, res: Response) => {
    const parsed = CreateWebhookBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request payload", details: parsed.error.issues });
        return;
    }
    try {
        const webhook = createWebhook(parsed.data);
        logAdminAction({
            action: "CREATE_WEBHOOK",
            tenant_id: webhook.tenant_id,
            details: `Subscribed webhook '${webhook.id}' to '${webhook.url}'`,
            ip_address: req.ip || req.socket.remoteAddress,
        });
        res.json({ webhook, timestamp: new Date().toISOString() });
    } catch (err: any) {
        res.status(400).json({ error: err.message || "Invalid webhook configuration" });
    }
});

app.delete("/admin/webhooks/:id", (req: Request, res: Response) => {
    const hookId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const success = deleteWebhook(hookId);
    if (!success) {
        res.status(404).json({ error: "Webhook not found" });
        return;
    }
    logAdminAction({
        action: "DELETE_WEBHOOK",
        details: `Deleted webhook '${hookId}'`,
        ip_address: req.ip || req.socket.remoteAddress,
    });
    res.json({ message: "Webhook deleted successfully", timestamp: new Date().toISOString() });
});

app.get("/admin/circuits", async (_req: Request, res: Response) => {
    const circuits = await getAllCircuitsAsync();
    res.json({ circuits, timestamp: new Date().toISOString() });
});

app.post("/admin/circuits/:name/reset", async (req: Request, res: Response) => {
    const circuitName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    try {
        const decodedName = decodeURIComponent(circuitName);
        await upsertCircuitAsync(decodedName, {
            state: "CLOSED",
            failure_count: 0,
            half_open_success_count: 0,
            opened_at: null,
            half_opened_at: null,
            last_error: null,
        });
        logAdminAction({
            action: "RESET_CIRCUIT",
            details: `Reset circuit breaker '${decodedName}' to CLOSED`,
            ip_address: req.ip || req.socket.remoteAddress,
        });
        res.json({ message: `Circuit '${decodedName}' reset to CLOSED`, timestamp: new Date().toISOString() });
    } catch (err: any) {
        res.status(400).json({ error: err.message || "Failed to reset circuit" });
    }
});

app.get("/admin/audit-logs", (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit || "100"), 10) || 100;
    const action = req.query.action as string | undefined;
    const tenant_id = req.query.tenant_id as string | undefined;
    const since = req.query.since as string | undefined;

    const logs = listAdminAuditLogs({ limit, action, tenant_id, since });
    res.json({ audit_logs: logs, timestamp: new Date().toISOString() });
});

app.post("/admin/maintenance", async (req: Request, res: Response) => {
    try {
        const result = await runDatabaseMaintenance();
        logAdminAction({
            action: "RUN_MAINTENANCE",
            details: `Pruned ${result.deleted_checkpoints} checkpoints, ${result.deleted_observations} observations, ${result.deleted_call_logs} call logs`,
            ip_address: req.ip || req.socket.remoteAddress,
        });
        res.json({ maintenance: result, timestamp: new Date().toISOString() });
    } catch (err: any) {
        res.status(500).json({ error: err.message || "Maintenance failed" });
    }
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

app.get("/health", async (_req: Request, res: Response) => {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);

    const dbHealth = await RepositoryFactory.getInstance().getDatabaseHealth().catch((err) => ({
        healthy: false,
        backend: RepositoryFactory.getInstance().getBackend(),
        connection_pooled: false,
        latency_ms: -1,
        error: String(err),
    }));

    const storage = await getStorageStats().catch(() => ({
        total_sessions: -1,
        total_checkpoints: -1,
    }));

    let total_circuits = 0;
    let open_circuits = 0;
    let half_open_circuits = 0;
    try {
        const circuits = await getAllCircuitsAsync();
        total_circuits = circuits.length;
        open_circuits = circuits.filter((c) => c.state === "OPEN").length;
        half_open_circuits = circuits.filter((c) => c.state === "HALF_OPEN").length;
    } catch { /* non-fatal */ }

    let total_metrics_tracked = 0;
    let confident_baselines = 0;
    try {
        const baselineStats = await getBaselineStatsAsync();
        total_metrics_tracked = baselineStats.total_metrics_tracked;
        confident_baselines = baselineStats.confident_baselines;
    } catch { /* non-fatal */ }

    let usageSummary = { total_calls_this_month: 0, active_tenants_this_month: 0 };
    try {
        usageSummary = getMonthlyUsageSummary();
    } catch { /* non-fatal */ }

    res.json({
        status: dbHealth.healthy ? "ok" : "degraded",
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
            checkpoint_limit_per_session: parseEnvInt("MAX_CHECKPOINTS", 10000, 1),
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
// 404 Handler
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
    res.status(404).json({
        error: "Not Found",
        message:
            "Available endpoints: POST /mcp, GET /sse, POST /messages, GET /health, GET /admin (Admin Console UI), GET /admin/usage, GET /admin/metrics, GET /admin/tenants, GET /admin/api-keys, GET /admin/circuits, GET /admin/webhooks, POST /admin/maintenance",
        timestamp: new Date().toISOString(),
    });
});

// ---------------------------------------------------------------------------
// Startup (HTTP or Stdio transport)
// ---------------------------------------------------------------------------

async function startStdioMode(): Promise<void> {
    initializeDatabase();
    runDatabaseMaintenance().catch((err) => console.error("[AgentGuard] Maintenance error:", err));
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[AgentGuard] ${SERVER_NAME} v${SERVER_VERSION} running on stdio transport`);
}

function startHttpMode(): void {
    initializeDatabase();
    console.log("[AgentGuard] SQLite database initialized");
    runDatabaseMaintenance().catch((err) =>
        console.error("[AgentGuard] Maintenance error:", err)
    );

    // Periodic maintenance every 6 hours
    const maintenanceInterval = setInterval(() => {
        runDatabaseMaintenance().catch((err) =>
            console.error("[AgentGuard] Scheduled maintenance error:", err)
        );
    }, 6 * 60 * 60 * 1000);
    maintenanceInterval.unref();

    const PORT = process.env.PORT || 3000;
    const boxWidth = 50;
    const padLine = (text: string) => `│ ${text.padEnd(boxWidth - 3)}│`;

    const httpServer = app.listen(PORT, () => {
        console.log("");
        console.log(`┌${"─".repeat(boxWidth - 2)}┐`);
        console.log(padLine(`     ${SERVER_NAME} v${SERVER_VERSION}`));
        console.log(`├${"─".repeat(boxWidth - 2)}┤`);
        console.log(padLine(`MCP endpoint  : http://localhost:${PORT}/mcp`));
        console.log(padLine(`SSE endpoint  : http://localhost:${PORT}/sse`));
        console.log(padLine(`Admin Console : http://localhost:${PORT}/admin`));
        console.log(padLine(`Health check  : http://localhost:${PORT}/health`));
        console.log(`├${"─".repeat(boxWidth - 2)}┤`);
        console.log(padLine("Registered tools:"));
        REGISTERED_TOOLS.forEach((t) => console.log(padLine(`  • ${t}`)));
        console.log(`└${"─".repeat(boxWidth - 2)}┘`);

        console.log("");
        console.log(
            `[AgentGuard] ℹ️  Storage backend: ${RepositoryFactory.getInstance().getBackend().toUpperCase()}.`
        );

        if (!process.env.AGENTGUARD_API_KEY) {
            console.warn(
                "[AgentGuard] ⚠️  AGENTGUARD_API_KEY not set — running in OPEN mode (unless DB keys are passed). Set this in production."
            );
        } else {
            console.log("[AgentGuard] ✅  API key authentication enabled");
        }

        if (!process.env.AGENTGUARD_ADMIN_KEY) {
            console.warn(
                "[AgentGuard] ⚠️  AGENTGUARD_ADMIN_KEY not set — Admin Console is UNPROTECTED. Set this before going live."
            );
        } else {
            console.log("[AgentGuard] ✅  Admin Console protected by AGENTGUARD_ADMIN_KEY");
        }
    });

    function shutdown(signal: string): void {
        console.log(`\n[AgentGuard] Received ${signal}. Shutting down gracefully…`);
        clearInterval(maintenanceInterval);
        for (const session of sseSessions.values()) {
            session.server.close().catch(() => {});
        }
        sseSessions.clear();
        httpServer.close((err) => {
            try {
                db.close();
            } catch { /* ignore if already closed */ }
            if (err) {
                console.error("[AgentGuard] Error during shutdown:", err);
                process.exit(1);
            }
            console.log("[AgentGuard] Server closed. Goodbye.");
            process.exit(0);
        });

        setTimeout(() => {
            console.error("[AgentGuard] Forced shutdown after 10s timeout.");
            process.exit(1);
        }, 10_000).unref();
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
    const isStdio = process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";
    if (isStdio) {
        startStdioMode().catch((err) => {
            console.error("[AgentGuard] Fatal stdio error:", err);
            process.exit(1);
        });
    } else {
        startHttpMode();
    }
}
