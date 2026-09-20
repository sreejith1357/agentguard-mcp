/**
 * AgentGuard MCP v3.0.0 — SQLite Repository Implementation
 *
 * Implements ICircuitBreakerRepository, IBaselineRepository, and ICausalTraceRepository
 * using better-sqlite3 WAL mode + in-memory L1 cache.
 */

import db from "../db/schema.js";
import type { CircuitRow, BaselineRow, ObservationRow, CheckpointEntry } from "../types/index.js";
import type {
    ICircuitBreakerRepository,
    IBaselineRepository,
    ICausalTraceRepository,
} from "./interfaces.js";
import { getTenantContext } from "../utils/auth.js";
import { CheckpointLimitError, MAX_CHECKPOINTS } from "../utils/storage.js";

const MAX_CACHE_SIZE = 10_000;

// ===========================================================================
// 1. SqliteCircuitBreakerRepository
// ===========================================================================

export class SqliteCircuitBreakerRepository implements ICircuitBreakerRepository {
    private cache = new Map<string, CircuitRow | null>();

    private stmtGet = db.prepare<[string, string, string], CircuitRow>(
        "SELECT * FROM circuit_breakers WHERE tenant_id = ? AND project_id = ? AND name = ?"
    );
    private stmtGetAll = db.prepare<[string, string], CircuitRow>(
        "SELECT * FROM circuit_breakers WHERE tenant_id = ? AND project_id = ? ORDER BY name ASC"
    );
    private stmtDelete = db.prepare<[string, string, string]>(
        "DELETE FROM circuit_breakers WHERE tenant_id = ? AND project_id = ? AND name = ?"
    );

    private getCacheKey(tid: string, pid: string, name: string): string {
        return `${tid}:${pid}:${name}`;
    }

    clearCache(): void {
        this.cache.clear();
    }

    get(name: string, tenantId?: string, projectId?: string): CircuitRow | undefined {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, name);

        if (this.cache.has(key)) {
            return this.cache.get(key) ?? undefined;
        }

        const row = this.stmtGet.get(tid, pid, name);

        if (this.cache.size >= MAX_CACHE_SIZE) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }

        this.cache.set(key, row ?? null);
        return row;
    }

    upsert(name: string, data: Partial<CircuitRow>, tenantId?: string, projectId?: string): void {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, name);
        const now = new Date().toISOString();

        const existing = this.get(name, tid, pid);

        const merged: CircuitRow = Object.assign(
            {
                tenant_id: tid,
                project_id: pid,
                name,
                state: "CLOSED" as const,
                failure_count: 0,
                success_count: 0,
                last_failure_at: null,
                last_success_at: null,
                opened_at: null,
                half_opened_at: null,
                updated_at: now,
            },
            existing ?? {},
            data,
            { updated_at: now, tenant_id: tid, project_id: pid }
        );

        if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(key)) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }
        this.cache.set(key, merged);

        db.prepare(`
            INSERT INTO circuit_breakers
                (tenant_id, project_id, name, state, failure_count, success_count, last_failure_at,
                 last_success_at, opened_at, half_opened_at, updated_at)
            VALUES
                (@tenant_id, @project_id, @name, @state, @failure_count, @success_count, @last_failure_at,
                 @last_success_at, @opened_at, @half_opened_at, @updated_at)
            ON CONFLICT(tenant_id, project_id, name) DO UPDATE SET
                state           = excluded.state,
                failure_count   = excluded.failure_count,
                success_count   = excluded.success_count,
                last_failure_at = excluded.last_failure_at,
                last_success_at = excluded.last_success_at,
                opened_at       = excluded.opened_at,
                half_opened_at  = excluded.half_opened_at,
                updated_at      = excluded.updated_at
        `).run(merged);
    }

    getAll(tenantId?: string, projectId?: string): CircuitRow[] {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        return this.stmtGetAll.all(tid, pid);
    }

    delete(name: string, tenantId?: string, projectId?: string): void {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, name);

        this.cache.delete(key);
        this.stmtDelete.run(tid, pid, name);
    }
}

// ===========================================================================
// 2. SqliteBaselineRepository
// ===========================================================================

export class SqliteBaselineRepository implements IBaselineRepository {
    private cache = new Map<string, BaselineRow | null>();

    private stmtInsertObs = db.prepare<{
        tenant_id: string;
        project_id: string;
        metric_name: string;
        value: number;
        recorded_at: string;
    }>(`
        INSERT INTO metric_observations (tenant_id, project_id, metric_name, value, recorded_at)
        VALUES (@tenant_id, @project_id, @metric_name, @value, @recorded_at)
    `);

    private stmtGetBaseline = db.prepare<[string, string, string], BaselineRow>(
        "SELECT * FROM metric_baselines WHERE tenant_id = ? AND project_id = ? AND metric_name = ?"
    );

    private stmtGetRecentObs = db.prepare<[string, string, string, number], ObservationRow>(`
        SELECT * FROM metric_observations
        WHERE tenant_id = ? AND project_id = ? AND metric_name = ?
        ORDER BY recorded_at DESC
        LIMIT ?
    `);

    private stmtCountObs = db.prepare<[string, string, string], { count: number }>(
        "SELECT COUNT(*) AS count FROM metric_observations WHERE tenant_id = ? AND project_id = ? AND metric_name = ?"
    );

    private getCacheKey(tid: string, pid: string, name: string): string {
        return `${tid}:${pid}:${name}`;
    }

    clearCache(): void {
        this.cache.clear();
    }

    recordObservation(metricName: string, value: number, tenantId?: string, projectId?: string): void {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        this.stmtInsertObs.run({
            tenant_id: tid,
            project_id: pid,
            metric_name: metricName,
            value,
            recorded_at: new Date().toISOString(),
        });
    }

    get(metricName: string, tenantId?: string, projectId?: string): BaselineRow | undefined {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, metricName);

        if (this.cache.has(key)) {
            return this.cache.get(key) ?? undefined;
        }

        const row = this.stmtGetBaseline.get(tid, pid, metricName);

        if (this.cache.size >= MAX_CACHE_SIZE) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }

        this.cache.set(key, row ?? null);
        return row;
    }

    upsert(metricName: string, data: Partial<BaselineRow>, tenantId?: string, projectId?: string): void {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, metricName);
        const now = new Date().toISOString();

        const existing = this.get(metricName, tid, pid);

        const merged: BaselineRow = Object.assign(
            {
                tenant_id: tid,
                project_id: pid,
                metric_name: metricName,
                ema_mean: 0,
                ema_variance: 0,
                observation_count: 0,
                status: "learning" as const,
                winsorized_count: 0,
                first_observed_at: now,
                last_observed_at: now,
                window_size: 20,
                updated_at: now,
            },
            existing ?? {},
            data,
            { updated_at: now, tenant_id: tid, project_id: pid }
        );

        if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(key)) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
        }
        this.cache.set(key, merged);

        db.prepare(`
            INSERT INTO metric_baselines
                (tenant_id, project_id, metric_name, ema_mean, ema_variance, observation_count,
                 status, winsorized_count, first_observed_at, last_observed_at, window_size, updated_at)
            VALUES
                (@tenant_id, @project_id, @metric_name, @ema_mean, @ema_variance, @observation_count,
                 @status, @winsorized_count, @first_observed_at, @last_observed_at, @window_size, @updated_at)
            ON CONFLICT(tenant_id, project_id, metric_name) DO UPDATE SET
                ema_mean          = excluded.ema_mean,
                ema_variance      = excluded.ema_variance,
                observation_count = excluded.observation_count,
                status            = excluded.status,
                winsorized_count  = excluded.winsorized_count,
                last_observed_at  = excluded.last_observed_at,
                window_size       = excluded.window_size,
                updated_at        = excluded.updated_at
        `).run(merged);
    }

    reset(metricName: string, hardDelete: boolean = false, tenantId?: string, projectId?: string): void {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, metricName);

        db.prepare("DELETE FROM metric_observations WHERE tenant_id = ? AND project_id = ? AND metric_name = ?").run(tid, pid, metricName);

        if (hardDelete) {
            this.cache.delete(key);
            db.prepare("DELETE FROM metric_baselines WHERE tenant_id = ? AND project_id = ? AND metric_name = ?").run(tid, pid, metricName);
        } else {
            const existing = this.get(metricName, tid, pid);
            if (existing) {
                const now = new Date().toISOString();
                const resetRow: BaselineRow = {
                    ...existing,
                    ema_mean: 0,
                    ema_variance: 0,
                    observation_count: 0,
                    status: "learning",
                    winsorized_count: 0,
                    updated_at: now,
                };
                this.cache.set(key, resetRow);
            }
            const now = new Date().toISOString();
            db.prepare(`
                UPDATE metric_baselines
                SET ema_mean = 0, ema_variance = 0, observation_count = 0, status = 'learning', winsorized_count = 0, updated_at = ?
                WHERE tenant_id = ? AND project_id = ? AND metric_name = ?
            `).run(now, tid, pid, metricName);
        }
    }

    getRecentObservations(metricName: string, limit: number, tenantId?: string, projectId?: string): ObservationRow[] {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        return this.stmtGetRecentObs.all(tid, pid, metricName, limit);
    }

    getObservationCount(metricName: string, tenantId?: string, projectId?: string): number {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const row = this.stmtCountObs.get(tid, pid, metricName);
        return row?.count ?? 0;
    }

    getStats(tenantId?: string, projectId?: string): { total_metrics_tracked: number; confident_baselines: number } {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const row = db
            .prepare<[string, string], { total: number; confident: number }>(
                `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN observation_count >= window_size THEN 1 ELSE 0 END) AS confident
                FROM metric_baselines
                WHERE tenant_id = ? AND project_id = ?`
            )
            .get(tid, pid);

        return {
            total_metrics_tracked: row?.total ?? 0,
            confident_baselines: row?.confident ?? 0,
        };
    }
}

// ===========================================================================
// 3. SqliteCausalTraceRepository
// ===========================================================================

interface CheckpointRow {
    checkpoint_id: string;
    tenant_id: string;
    project_id: string;
    session_id: string;
    parent_checkpoint_id: string | null;
    checkpoint_type: string;
    tool_name: string | null;
    status: string | null;
    content: string;
    metadata_json: string | null;
    tags_json: string | null;
    payload_json: string | null;
    created_at: string;
}

function mapRowToEntry(row: CheckpointRow): CheckpointEntry {
    let metadata: Record<string, unknown> | undefined;
    let tags: string[] | undefined;

    if (row.metadata_json) {
        try { metadata = JSON.parse(row.metadata_json); } catch { /* ignore */ }
    }
    if (row.tags_json) {
        try { tags = JSON.parse(row.tags_json); } catch { /* ignore */ }
    }

    return {
        id: row.checkpoint_id,
        session_id: row.session_id,
        checkpoint_type: row.checkpoint_type as any,
        content: row.content,
        metadata,
        tags,
        parent_checkpoint_id: row.parent_checkpoint_id,
        created_at: row.created_at,
    };
}

export class SqliteCausalTraceRepository implements ICausalTraceRepository {
    private stmtCount = db.prepare(
        `SELECT COUNT(*) AS count FROM session_checkpoints WHERE tenant_id = ? AND project_id = ? AND session_id = ?`
    );
    private stmtInsert = db.prepare(`
        INSERT INTO session_checkpoints (
            checkpoint_id, tenant_id, project_id, session_id, parent_checkpoint_id,
            checkpoint_type, tool_name, status, content, metadata_json, tags_json,
            payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    private stmtReadAll = db.prepare(
        `SELECT * FROM session_checkpoints WHERE tenant_id = ? AND project_id = ? AND session_id = ? ORDER BY created_at ASC`
    );
    private stmtStats = db.prepare(
        `SELECT COUNT(DISTINCT session_id) AS total_sessions, COUNT(*) AS total_checkpoints FROM session_checkpoints WHERE tenant_id = ? AND project_id = ?`
    );

    async append<T extends object>(sessionId: string, record: T, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const entry = record as any;
        const checkpointId = entry.id || entry.checkpoint_id || crypto.randomUUID();

        const insertTx = db.transaction(() => {
            const countRow = this.stmtCount.get(tid, pid, sessionId) as { count: number };
            if (countRow.count >= MAX_CHECKPOINTS) {
                throw new CheckpointLimitError(sessionId, MAX_CHECKPOINTS);
            }

            this.stmtInsert.run(
                checkpointId, tid, pid, sessionId,
                entry.parent_checkpoint_id ?? null,
                entry.checkpoint_type ?? "reasoning",
                entry.tool_name ?? null,
                entry.status ?? null,
                entry.content ?? "",
                entry.metadata ? JSON.stringify(entry.metadata) : null,
                entry.tags ? JSON.stringify(entry.tags) : null,
                entry.payload ? JSON.stringify(entry.payload) : null,
                entry.created_at ?? new Date().toISOString()
            );
        });

        insertTx();
    }

    async readAll<T = CheckpointEntry>(sessionId: string, tenantId?: string, projectId?: string): Promise<T[]> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const rows = this.stmtReadAll.all(tid, pid, sessionId) as CheckpointRow[];
        return rows.map((r) => mapRowToEntry(r) as unknown as T);
    }

    queryHistory(options: {
        session_id: string;
        limit?: number;
        checkpoint_type?: string;
        since_timestamp?: string;
        tags?: string[];
        tenant_id?: string;
        project_id?: string;
    }): { entries: CheckpointEntry[]; totalFound: number } {
        const ctx = getTenantContext();
        const tid = options.tenant_id ?? ctx.tenant_id;
        const pid = options.project_id ?? ctx.project_id;
        const { session_id, limit = 50, checkpoint_type, since_timestamp, tags } = options;

        let sql = `SELECT * FROM session_checkpoints WHERE tenant_id = ? AND project_id = ? AND session_id = ?`;
        const params: any[] = [tid, pid, session_id];

        if (checkpoint_type) { sql += ` AND checkpoint_type = ?`; params.push(checkpoint_type); }
        if (since_timestamp) { sql += ` AND created_at >= ?`; params.push(since_timestamp); }

        sql += ` ORDER BY created_at ASC`;

        const rows = db.prepare(sql).all(...params) as CheckpointRow[];
        let entries = rows.map(mapRowToEntry);

        if (tags && tags.length > 0) {
            entries = entries.filter((e) => e.tags && tags.every((t) => e.tags!.includes(t)));
        }

        return { entries: entries.slice(-limit), totalFound: entries.length };
    }

    getLineageForFailures(sessionId: string, failedCheckpointIds: string[], tenantId?: string, projectId?: string): CheckpointEntry[] {
        if (failedCheckpointIds.length === 0) return [];
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const placeholders = failedCheckpointIds.map(() => "?").join(",");
        const query = `
            WITH RECURSIVE lineage(checkpoint_id, parent_checkpoint_id, depth) AS (
                SELECT checkpoint_id, parent_checkpoint_id, 0
                FROM session_checkpoints
                WHERE checkpoint_id IN (${placeholders}) AND tenant_id = ? AND project_id = ? AND session_id = ?

                UNION ALL

                SELECT c.checkpoint_id, c.parent_checkpoint_id, l.depth + 1
                FROM session_checkpoints c
                JOIN lineage l ON c.checkpoint_id = l.parent_checkpoint_id
                WHERE l.parent_checkpoint_id IS NOT NULL AND l.depth < 100 AND c.tenant_id = ? AND c.project_id = ?
            )
            SELECT DISTINCT c.* FROM session_checkpoints c
            JOIN lineage l ON c.checkpoint_id = l.checkpoint_id
            ORDER BY c.created_at ASC
        `;

        const rows = db.prepare(query).all(...failedCheckpointIds, tid, pid, sessionId, tid, pid) as CheckpointRow[];
        return rows.map(mapRowToEntry);
    }

    async countRecords(sessionId: string, tenantId?: string, projectId?: string): Promise<number> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const row = this.stmtCount.get(tid, pid, sessionId) as { count: number };
        return row?.count ?? 0;
    }

    async getStats(tenantId?: string, projectId?: string): Promise<{ total_sessions: number; total_checkpoints: number }> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const row = this.stmtStats.get(tid, pid) as { total_sessions: number; total_checkpoints: number };
        return {
            total_sessions: row?.total_sessions || 0,
            total_checkpoints: row?.total_checkpoints || 0,
        };
    }
}
