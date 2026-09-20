/**
 * AgentGuard MCP v3.0.0 — Unified Session Storage Utility
 *
 * Provides transaction-safe storage for reasoning checkpoints and causal dependency graphs,
 * delegating to the active persistence repository (SQLite or PostgreSQL) via RepositoryFactory.
 */

import type { CheckpointEntry } from "../types/index.js";
import { getCausalTraceRepository } from "../repositories/factory.js";
import db from "../db/schema.js";

const _parsed = parseInt(process.env.MAX_CHECKPOINTS ?? "", 10);
export const MAX_CHECKPOINTS: number = Number.isFinite(_parsed) && _parsed > 0 ? _parsed : 10_000;

export class CheckpointLimitError extends Error {
    readonly sessionId: string;
    readonly limit: number;

    constructor(sessionId: string, limit: number) {
        super(
            `Session "${sessionId}" has reached the maximum of ${limit} checkpoints. ` +
            `Increase MAX_CHECKPOINTS or archive old sessions.`
        );
        this.name = "CheckpointLimitError";
        this.sessionId = sessionId;
        this.limit = limit;
    }
}

/**
 * Atomically insert a checkpoint into storage scoped by tenant.
 * Enforces MAX_CHECKPOINTS limit.
 */
export async function append<T extends object>(
    sessionId: string,
    record: T,
    tenantId?: string,
    projectId?: string
): Promise<void> {
    return getCausalTraceRepository().append(sessionId, record, tenantId, projectId);
}

/**
 * Read all checkpoints for a given session scoped by tenant identity.
 */
export async function readAll<T = CheckpointEntry>(
    sessionId: string,
    tenantId?: string,
    projectId?: string
): Promise<T[]> {
    return getCausalTraceRepository().readAll<T>(sessionId, tenantId, projectId);
}

/**
 * Filtered query for session history directly using database indexes scoped by tenant context.
 */
export function querySessionHistory(options: {
    session_id: string;
    limit?: number;
    checkpoint_type?: string;
    since_timestamp?: string;
    tags?: string[];
    tenant_id?: string;
    project_id?: string;
}): { entries: CheckpointEntry[]; totalFound: number } {
    const res = getCausalTraceRepository().queryHistory(options);
    return res instanceof Promise ? { entries: [], totalFound: 0 } : res;
}

/**
 * Traces failure lineage recursively using a Common Table Expression (CTE) scoped by tenant.
 */
export function getLineageForFailures(
    sessionId: string,
    failedCheckpointIds: string[],
    tenantId?: string,
    projectId?: string
): CheckpointEntry[] {
    const res = getCausalTraceRepository().getLineageForFailures(sessionId, failedCheckpointIds, tenantId, projectId);
    return res instanceof Promise ? [] : res;
}

/**
 * Check if a session exists in storage.
 */
export async function sessionExists(
    sessionId: string,
    tenantId?: string,
    projectId?: string
): Promise<boolean> {
    const count = await countRecords(sessionId, tenantId, projectId);
    return count > 0;
}

/**
 * Count the number of checkpoints for a session.
 */
export async function countRecords(
    sessionId: string,
    tenantId?: string,
    projectId?: string
): Promise<number> {
    return getCausalTraceRepository().countRecords(sessionId, tenantId, projectId);
}

/**
 * Aggregate storage statistics across all sessions for active tenant context.
 */
export async function getStorageStats(
    tenantId?: string,
    projectId?: string
): Promise<{
    total_sessions: number;
    total_checkpoints: number;
}> {
    return getCausalTraceRepository().getStats(tenantId, projectId);
}

/**
 * Execute rolling TTL pruning and incremental vacuuming within a transaction.
 */
export async function cleanupOldSessions(
    maxAgeMs: number = parseInt(process.env.SESSION_TTL_DAYS ?? "30", 10) * 24 * 60 * 60 * 1000
): Promise<{ deleted_files: number; deleted_records: number }> {
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();

    const cleanupTx = db.transaction(() => {
        const result = db.prepare("DELETE FROM session_checkpoints WHERE created_at < ?").run(cutoffDate);
        return result.changes;
    });

    const deletedRecords = cleanupTx();

    try {
        db.exec("PRAGMA incremental_vacuum;");
    } catch { /* ignore */ }

    return { deleted_files: 0, deleted_records: deletedRecords };
}

