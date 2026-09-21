/**
 * AgentGuard MCP v3.1.0 — Call Logger & Usage Analytics Utility
 *
 * Provides synchronous call logging to SQLite call_logs table and
 * analytics aggregation for tenant usage monitoring.
 */

import db from "../db/schema.js";

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

/**
 * Synchronously log a tool execution call into SQLite.
 * Wrapped in try-catch to guarantee call logging never crashes tool execution.
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
    } catch (error) {
        console.error("[AgentGuard] Call logging error:", error);
    }
}

/**
 * Retrieve usage analytics for a specific tenant and month.
 */
export function getUsageStats(
    tenant_id: string,
    month_key?: string
): UsageStats {
    const month = month_key || new Date().toISOString().slice(0, 7);

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
            WHERE tenant_id = ? AND month_key = ?
        `
            )
            .get(tenant_id, month) as {
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
            WHERE tenant_id = ? AND month_key = ?
            GROUP BY tool_name
            ORDER BY count DESC
        `
            )
            .all(tenant_id, month) as { tool_name: string; count: number }[];

        const error_codes = db
            .prepare(
                `
            SELECT error_code as code, COUNT(*) as count
            FROM call_logs
            WHERE tenant_id = ? AND month_key = ? AND error_code IS NOT NULL AND error_code != ''
            GROUP BY error_code
            ORDER BY count DESC
        `
            )
            .all(tenant_id, month) as { code: string; count: number }[];

        const daily_breakdown = db
            .prepare(
                `
            SELECT substr(called_at, 1, 10) as date, COUNT(*) as count
            FROM call_logs
            WHERE tenant_id = ? AND month_key = ?
            GROUP BY substr(called_at, 1, 10)
            ORDER BY date ASC
        `
            )
            .all(tenant_id, month) as { date: string; count: number }[];

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
            error_codes: [],
            daily_breakdown: [],
            first_call_at: null,
            last_call_at: null,
        };
    }
}

/**
 * Retrieve total calls across all tenants for admin view.
 */
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

/**
 * Retrieve aggregate monthly usage summary for health endpoint.
 */
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
