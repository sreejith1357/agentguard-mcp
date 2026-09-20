/**
 * AgentGuard MCP v2.1.0 — Scheduled Database Maintenance Utility
 *
 * Runs periodic maintenance tasks:
 *  1. Rolling TTL cleanup for expired session checkpoints and time-series observations.
 *  2. PRAGMA incremental_vacuum execution to reclaim freed pages.
 */

import { cleanupOldSessions } from "./storage.js";
import db from "../db/schema.js";

export interface MaintenanceResult {
    deleted_checkpoints: number;
    deleted_observations: number;
    vacuum_executed: boolean;
    timestamp: string;
}

/**
 * Executes rolling TTL pruning and incremental vacuuming.
 */
export async function runDatabaseMaintenance(
    retentionDays: number = parseInt(process.env.SESSION_TTL_DAYS ?? "30", 10)
): Promise<MaintenanceResult> {
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();

    // 1. Rolling TTL pruning in transaction
    const maintenanceTx = db.transaction(() => {
        const cpResult = db.prepare(
            `DELETE FROM session_checkpoints WHERE created_at < ?`
        ).run(cutoffDate);

        const obsResult = db.prepare(
            `DELETE FROM metric_observations WHERE recorded_at < ?`
        ).run(cutoffDate);

        return {
            checkpoints: cpResult.changes,
            observations: obsResult.changes,
        };
    });

    const deleted = maintenanceTx();

    // 2. Incremental vacuum
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
        vacuum_executed: vacuumExecuted,
        timestamp: new Date().toISOString(),
    };
}
