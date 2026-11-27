/**
 * AgentGuard MCP v3.1.2 — Scheduled Database Maintenance Utility
 *
 * Runs periodic maintenance tasks:
 *  1. Rolling TTL cleanup for expired session checkpoints and time-series observations.
 *  2. Retention pruning for call_logs, admin_audit_logs, webhook_deliveries, and expired rate_limit_buckets.
 *  3. PRAGMA incremental_vacuum execution to reclaim freed SQLite pages.
 */

import db from "../db/schema.js";
import { parseEnvInt } from "./validation.js";

export interface MaintenanceResult {
    deleted_checkpoints: number;
    deleted_observations: number;
    deleted_call_logs: number;
    deleted_audit_logs: number;
    deleted_webhook_deliveries: number;
    deleted_rate_buckets: number;
    vacuum_executed: boolean;
    timestamp: string;
}

/**
 * Executes rolling TTL pruning and incremental vacuuming.
 */
export async function runDatabaseMaintenance(
    retentionDays: number = parseEnvInt("SESSION_TTL_DAYS", 30, 1),
    callLogDays: number = parseEnvInt("CALL_LOG_TTL_DAYS", 90, 1),
    auditLogDays: number = parseEnvInt("AUDIT_LOG_TTL_DAYS", 180, 1)
): Promise<MaintenanceResult> {
    const nowMs = Date.now();
    const sessionCutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const callLogCutoff = new Date(nowMs - callLogDays * 24 * 60 * 60 * 1000).toISOString();
    const auditCutoff = new Date(nowMs - auditLogDays * 24 * 60 * 60 * 1000).toISOString();
    const rateBucketCutoffMs = nowMs - 5 * 60 * 1000; // stale >5 minutes ago

    const maintenanceTx = db.transaction(() => {
        const cpResult = db.prepare(`DELETE FROM session_checkpoints WHERE created_at < ?`).run(sessionCutoff);
        const obsResult = db.prepare(`DELETE FROM metric_observations WHERE recorded_at < ?`).run(sessionCutoff);
        const callResult = db.prepare(`DELETE FROM call_logs WHERE called_at < ?`).run(callLogCutoff);
        const auditResult = db.prepare(`DELETE FROM admin_audit_logs WHERE created_at < ?`).run(auditCutoff);
        const whdResult = db.prepare(`DELETE FROM webhook_deliveries WHERE delivered_at < ?`).run(sessionCutoff);
        const rlResult = db.prepare(`DELETE FROM rate_limit_buckets WHERE window_start < ?`).run(rateBucketCutoffMs);

        return {
            checkpoints: cpResult.changes,
            observations: obsResult.changes,
            call_logs: callResult.changes,
            audit_logs: auditResult.changes,
            webhook_deliveries: whdResult.changes,
            rate_buckets: rlResult.changes,
        };
    });

    const deleted = maintenanceTx();

    let vacuumExecuted = false;
    try {
        db.exec("PRAGMA incremental_vacuum;");
        vacuumExecuted = true;
    } catch {
        vacuumExecuted = false;
    }

    return {
        deleted_checkpoints: deleted.checkpoints,
        deleted_observations: deleted.observations,
        deleted_call_logs: deleted.call_logs,
        deleted_audit_logs: deleted.audit_logs,
        deleted_webhook_deliveries: deleted.webhook_deliveries,
        deleted_rate_buckets: deleted.rate_buckets,
        vacuum_executed: vacuumExecuted,
        timestamp: new Date().toISOString(),
    };
}
