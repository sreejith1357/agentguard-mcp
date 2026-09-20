import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { randomUUID } from "node:crypto";

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
import { getAllCircuits } from "./utils/circuitStore.js";
import { getBaselineStats } from "./utils/metricStore.js";
import { initializeDatabase } from "./db/schema.js";
import { authenticateRequest, tenantContextStorage } from "./utils/auth.js";
import { runDatabaseMaintenance } from "./utils/maintenance.js";

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const app = express();

// Request ID header middleware for request tracing
app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    req.headers["x-request-id"] = requestId;
    res.setHeader("X-Request-ID", requestId);
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
const SERVER_VERSION = "3.0.0";
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
            tenantContextStorage.run(result.identity, () => {
                next();
            });
            return;
        }
    }
    next();
});

// ---------------------------------------------------------------------------
// MCP endpoint — stateless StreamableHTTP (MCP protocol rev. July 2026)
// ---------------------------------------------------------------------------

app.post("/mcp", async (req: Request, res: Response) => {
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless mode — no in-memory session state
        });

        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error("[AgentGuard] MCP request error:", error);
        res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
        });
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
        message: "Available endpoints: POST /mcp, GET /health",
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
    console.log(`│  MCP endpoint : http://localhost:${PORT}/mcp  │`);
    console.log(`│  Health check : http://localhost:${PORT}/health│`);
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