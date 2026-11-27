/**
 * AgentGuard MCP v3.1.2 — Call Logger, Usage Analytics & Prometheus Metrics Utility
 *
 * Provides synchronous call logging to SQLite `call_logs` table, percentile latency
 * analytics (P50/P95/P99), and Prometheus exposition metrics.
 */

import db from "../db/schema.js";
import { incrementMonthlyCountCache } from "./rateLimiter.js";

export interface LogCallParams {
    tenant_id: string;
    project_id: string;
    env: string;
    tool_name: string;
    success: boolean;
    response_time_ms?: number;
    error_code?: string;
}

export interface UsageStats {
    tenant_id: string;
    month: string;
    total_calls: number;
    successful_calls: number;
    failed_calls: number;
    calls_by_tool: { tool_name: string; count: number }[];
    avg_response_time_ms: number;
    p50_response_time_ms: number;
    p95_response_time_ms: number;
    p99_response_time_ms: number;
    error_codes: { code: string; count: number }[];
    daily_breakdown: { date: string; count: number }[];
    first_call_at: string | null;
    last_call_at: string | null;
}

const stmtInsertCall = db.prepare(`
    INSERT INTO call_logs (
        tenant_id, project_id, env, tool_name, success, response_time_ms, error_code, called_at, month_key
    ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
`);

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Number(sorted[idx].toFixed(2));
}

/**
 * Synchronously log a tool execution call into SQLite and bump monthly quota cache.
 */
export function logCall(params: LogCallParams): void {
    try {
        const now = new Date().toISOString();
        const month_key = now.slice(0, 7);

        stmtInsertCall.run(
            params.tenant_id,
            params.project_id,
            params.env,
            params.tool_name,
            params.success ? 1 : 0,
            params.response_time_ms ?? null,
            params.error_code ?? null,
            now,
            month_key
        );

        incrementMonthlyCountCache(params.tenant_id, month_key);
    } catch (error) {
        console.error("[AgentGuard] Call logging error:", error);
    }
}

/**
 * Retrieve usage analytics for a specific tenant and month including latency percentiles.
 */
export function getUsageStats(
    tenant_id: string,
    month_key?: string
): UsageStats {
    const month = month_key || new Date().toISOString().slice(0, 7);
    const isAll = tenant_id === "all";
    const whereClause = isAll ? "WHERE month_key = ?" : "WHERE tenant_id = ? AND month_key = ?";
    const params = isAll ? [month] : [tenant_id, month];

    try {
        const summaryRow = db
            .prepare(
                `
            SELECT 
                COUNT(*) as total_calls,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_calls,
                AVG(response_time_ms) as avg_response_time_ms,
                MIN(called_at) as first_call_at,
                MAX(called_at) as last_call_at
            FROM call_logs
            ${whereClause}
        `
            )
            .get(...params) as {
            total_calls: number;
            successful_calls: number | null;
            failed_calls: number | null;
            avg_response_time_ms: number | null;
            first_call_at: string | null;
            last_call_at: string | null;
        } | undefined;

        const calls_by_tool = db
            .prepare(
                `
            SELECT tool_name, COUNT(*) as count
            FROM call_logs
            ${whereClause}
            GROUP BY tool_name
            ORDER BY count DESC
        `
            )
            .all(...params) as { tool_name: string; count: number }[];

        const error_codes = db
            .prepare(
                `
            SELECT error_code as code, COUNT(*) as count
            FROM call_logs
            ${whereClause} AND error_code IS NOT NULL AND error_code != ''
            GROUP BY error_code
            ORDER BY count DESC
        `
            )
            .all(...params) as { code: string; count: number }[];

        const daily_breakdown = db
            .prepare(
                `
            SELECT substr(called_at, 1, 10) as date, COUNT(*) as count
            FROM call_logs
            ${whereClause}
            GROUP BY substr(called_at, 1, 10)
            ORDER BY date ASC
        `
            )
            .all(...params) as { date: string; count: number }[];

        const latencyRows = db
            .prepare(
                `
            SELECT response_time_ms
            FROM call_logs
            ${whereClause} AND response_time_ms IS NOT NULL
            ORDER BY response_time_ms ASC
        `
            )
            .all(...params) as { response_time_ms: number }[];
        const latencies = latencyRows.map((r) => r.response_time_ms);

        const total_calls = summaryRow?.total_calls || 0;
        const successful_calls = summaryRow?.successful_calls || 0;
        const failed_calls = summaryRow?.failed_calls || 0;
        const avg_response_time_ms = summaryRow?.avg_response_time_ms
            ? Number(summaryRow.avg_response_time_ms.toFixed(2))
            : 0;

        return {
            tenant_id,
            month,
            total_calls,
            successful_calls,
            failed_calls,
            calls_by_tool,
            avg_response_time_ms,
            p50_response_time_ms: percentile(latencies, 50),
            p95_response_time_ms: percentile(latencies, 95),
            p99_response_time_ms: percentile(latencies, 99),
            error_codes,
            daily_breakdown,
            first_call_at: summaryRow?.first_call_at || null,
            last_call_at: summaryRow?.last_call_at || null,
        };
    } catch (error) {
        console.error("[AgentGuard] Error retrieving usage stats:", error);
        return {
            tenant_id,
            month,
            total_calls: 0,
            successful_calls: 0,
            failed_calls: 0,
            calls_by_tool: [],
            avg_response_time_ms: 0,
            p50_response_time_ms: 0,
            p95_response_time_ms: 0,
            p99_response_time_ms: 0,
            error_codes: [],
            daily_breakdown: [],
            first_call_at: null,
            last_call_at: null,
        };
    }
}

export function getAllTenantsStats(
    month_key?: string
): { tenant_id: string; total_calls: number }[] {
    const month = month_key || new Date().toISOString().slice(0, 7);

    try {
        return db
            .prepare(
                `
            SELECT tenant_id, COUNT(*) as total_calls
            FROM call_logs
            WHERE month_key = ?
            GROUP BY tenant_id
            ORDER BY total_calls DESC
        `
            )
            .all(month) as { tenant_id: string; total_calls: number }[];
    } catch (error) {
        console.error("[AgentGuard] Error retrieving all tenants stats:", error);
        return [];
    }
}

export function getMonthlyUsageSummary(month_key?: string): {
    total_calls_this_month: number;
    active_tenants_this_month: number;
} {
    const month = month_key || new Date().toISOString().slice(0, 7);

    try {
        const row = db
            .prepare(
                `
            SELECT 
                COUNT(*) as total_calls_this_month,
                COUNT(DISTINCT tenant_id) as active_tenants_this_month
            FROM call_logs
            WHERE month_key = ?
        `
            )
            .get(month) as {
            total_calls_this_month: number;
            active_tenants_this_month: number;
        } | undefined;

        return {
            total_calls_this_month: row?.total_calls_this_month || 0,
            active_tenants_this_month: row?.active_tenants_this_month || 0,
        };
    } catch (error) {
        console.error("[AgentGuard] Error retrieving monthly usage summary:", error);
        return {
            total_calls_this_month: 0,
            active_tenants_this_month: 0,
        };
    }
}

/**
 * Formats Prometheus text exposition format (version 0.0.4) metrics.
 */
export function getPrometheusMetrics(uptimeSeconds: number): string {
    const stats = getUsageStats("all");
    const lines: string[] = [
        "# HELP agentguard_uptime_seconds Process uptime in seconds",
        "# TYPE agentguard_uptime_seconds gauge",
        `agentguard_uptime_seconds ${uptimeSeconds}`,
        "# HELP agentguard_mcp_calls_total Total MCP tool calls for current month",
        "# TYPE agentguard_mcp_calls_total counter",
        `agentguard_mcp_calls_total{status="success"} ${stats.successful_calls}`,
        `agentguard_mcp_calls_total{status="error"} ${stats.failed_calls}`,
        "# HELP agentguard_mcp_response_time_ms Tool call response latency in milliseconds",
        "# TYPE agentguard_mcp_response_time_ms gauge",
        `agentguard_mcp_response_time_ms{quantile="0.5"} ${stats.p50_response_time_ms}`,
        `agentguard_mcp_response_time_ms{quantile="0.95"} ${stats.p95_response_time_ms}`,
        `agentguard_mcp_response_time_ms{quantile="0.99"} ${stats.p99_response_time_ms}`,
    ];

    for (const t of stats.calls_by_tool) {
        const safeTool = t.tool_name.replace(/[^a-zA-Z0-9_]/g, "_");
        lines.push(`agentguard_mcp_tool_calls_total{tool="${safeTool}"} ${t.count}`);
    }

    try {
        const circuitCounts = db
            .prepare("SELECT state, COUNT(*) as cnt FROM circuit_breakers GROUP BY state")
            .all() as { state: string; cnt: number }[];
        lines.push("# HELP agentguard_circuits_total Number of tracked circuits by state");
        lines.push("# TYPE agentguard_circuits_total gauge");
        for (const row of circuitCounts) {
            lines.push(`agentguard_circuits_total{state="${row.state}"} ${row.cnt}`);
        }
    } catch { /* ignore */ }

    return lines.join("\n") + "\n";
}
