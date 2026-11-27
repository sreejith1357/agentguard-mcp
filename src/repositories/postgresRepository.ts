/**
 * AgentGuard MCP v3.1.2 — Distributed PostgreSQL Repository & Connection Pool Implementation
 *
 * Implements ICircuitBreakerRepository, IBaselineRepository, and ICausalTraceRepository
 * backed by `pg` (node-postgres) Pool with parameterized SQL queries, recursive CTE lineage,
 * automatic schema initialization, health probes, and reconnect support.
 */

import crypto from "node:crypto";
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import type { CircuitRow, BaselineRow, ObservationRow, CheckpointEntry } from "../types/index.js";
import type {
    ICircuitBreakerRepository,
    IBaselineRepository,
    ICausalTraceRepository,
    IDatabaseHealth,
    QueryHistoryOptions,
    QueryHistoryResult,
} from "./interfaces.js";
import { getTenantContext } from "../utils/auth.js";
import { CheckpointLimitError, MAX_CHECKPOINTS } from "../utils/storage.js";

/** Minimal structural interface compatible with `pg.Pool` (and test mocks). */
export interface PgQueryExecutor {
    query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R> | { rows: R[]; rowCount?: number | null }>;
    end?(): Promise<void>;
}

const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_checkpoints (
    checkpoint_id        TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL DEFAULT 'default-tenant',
    project_id           TEXT NOT NULL DEFAULT 'default-project',
    session_id           TEXT NOT NULL,
    parent_checkpoint_id TEXT REFERENCES session_checkpoints(checkpoint_id) ON DELETE SET NULL,
    checkpoint_type      TEXT NOT NULL,
    tool_name            TEXT,
    status               TEXT,
    content              TEXT NOT NULL,
    metadata_json        TEXT,
    tags_json            TEXT,
    payload_json         TEXT,
    created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_checkpoints_tenant_session_time
    ON session_checkpoints (tenant_id, project_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_pg_checkpoints_tenant_parent
    ON session_checkpoints (tenant_id, project_id, parent_checkpoint_id);

CREATE TABLE IF NOT EXISTS circuit_breakers (
    tenant_id               TEXT NOT NULL DEFAULT 'default-tenant',
    project_id              TEXT NOT NULL DEFAULT 'default-project',
    name                    TEXT NOT NULL,
    state                   TEXT NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
    failure_count           INTEGER NOT NULL DEFAULT 0,
    success_count           INTEGER NOT NULL DEFAULT 0,
    half_open_success_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at         TEXT,
    last_success_at         TEXT,
    opened_at               TEXT,
    half_opened_at          TEXT,
    last_error              TEXT,
    last_response_time_ms   DOUBLE PRECISION,
    updated_at              TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_pg_circuits_state
    ON circuit_breakers (state);

CREATE TABLE IF NOT EXISTS metric_observations (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     TEXT NOT NULL DEFAULT 'default-tenant',
    project_id    TEXT NOT NULL DEFAULT 'default-project',
    metric_name   TEXT NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    recorded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pg_metric_obs_tenant_metric_time
    ON metric_observations (tenant_id, project_id, metric_name, recorded_at);

CREATE TABLE IF NOT EXISTS metric_baselines (
    tenant_id         TEXT NOT NULL DEFAULT 'default-tenant',
    project_id        TEXT NOT NULL DEFAULT 'default-project',
    metric_name       TEXT NOT NULL,
    ema_mean          DOUBLE PRECISION NOT NULL,
    ema_variance      DOUBLE PRECISION NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'learning' CHECK (status IN ('learning', 'active', 'degraded')),
    winsorized_count  INTEGER NOT NULL DEFAULT 0,
    first_observed_at TEXT NOT NULL,
    last_observed_at  TEXT NOT NULL,
    window_size       INTEGER NOT NULL DEFAULT 20,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id, metric_name)
);
`;

export class PostgresConnectionPool {
    private connected = false;
    private schemaReady = false;
    private connectionString: string;
    private maxPoolSize: number;
    private pool: PgQueryExecutor;
    private lastError?: string;

    constructor(connectionString?: string, maxPoolSize: number = 20, customPool?: PgQueryExecutor) {
        this.connectionString =
            connectionString ||
            process.env.DATABASE_URL ||
            process.env.POSTGRES_URL ||
            "postgres://localhost:5432/agentguard";
        this.maxPoolSize = maxPoolSize;

        if (customPool) {
            this.pool = customPool;
        } else {
            const config: PoolConfig = {
                connectionString: this.connectionString,
                max: this.maxPoolSize,
                idleTimeoutMillis: 30_000,
                connectionTimeoutMillis: 5_000,
            };
            this.pool = new Pool(config);
        }
    }

    async query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }> {
        if (!this.connected) {
            const ok = await this.connect();
            if (!ok) {
                throw new Error(this.lastError || "PostgreSQL connection pool is offline");
            }
        }
        return this.pool.query<R>(text, values);
    }

    async connect(): Promise<boolean> {
        try {
            await this.pool.query("SELECT 1");
            if (!this.schemaReady) {
                await this.pool.query(POSTGRES_SCHEMA_SQL);
                this.schemaReady = true;
            }
            this.connected = true;
            this.lastError = undefined;
            return true;
        } catch (err) {
            this.connected = false;
            this.lastError = err instanceof Error ? err.message : String(err);
            return false;
        }
    }

    async checkHealth(): Promise<IDatabaseHealth> {
        const start = performance.now();
        try {
            await this.pool.query("SELECT 1");
            this.connected = true;
            this.lastError = undefined;
            const latency_ms = Number((performance.now() - start).toFixed(2));
            return {
                healthy: true,
                backend: "postgres",
                connection_pooled: true,
                latency_ms,
            };
        } catch (err) {
            this.connected = false;
            this.lastError = err instanceof Error ? err.message : String(err);
            const latency_ms = Number((performance.now() - start).toFixed(2));
            return {
                healthy: false,
                backend: "postgres",
                connection_pooled: true,
                latency_ms,
                error: this.lastError || "PostgreSQL connection pool offline",
            };
        }
    }

    async reconnect(): Promise<boolean> {
        this.connected = false;
        this.schemaReady = false;
        return this.connect();
    }

    async close(): Promise<void> {
        this.connected = false;
        if (this.pool.end) {
            await this.pool.end();
        }
    }

    isConnected(): boolean {
        return this.connected;
    }
}

// ===========================================================================
// 1. PostgresCircuitBreakerRepository
// ===========================================================================

export class PostgresCircuitBreakerRepository implements ICircuitBreakerRepository {
    private cache = new Map<string, CircuitRow | null>();

    constructor(private pool: PostgresConnectionPool) {}

    private getCacheKey(tid: string, pid: string, name: string): string {
        return `${tid}:${pid}:${name}`;
    }

    clearCache(): void {
        this.cache.clear();
    }

    async get(name: string, tenantId?: string, projectId?: string): Promise<CircuitRow | undefined> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, name);

        if (this.cache.has(key)) {
            return this.cache.get(key) ?? undefined;
        }

        const res = await this.pool.query<CircuitRow>(
            `SELECT tenant_id, project_id, name, state, failure_count, success_count, half_open_success_count,
                    last_failure_at, last_success_at, opened_at, half_opened_at,
                    last_error, last_response_time_ms, updated_at
             FROM circuit_breakers
             WHERE tenant_id = $1 AND project_id = $2 AND name = $3`,
            [tid, pid, name]
        );
        const row = res.rows[0];
        this.cache.set(key, row ?? null);
        return row;
    }

    async upsert(name: string, data: Partial<CircuitRow>, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, name);
        const now = new Date().toISOString();

        const existing = await this.get(name, tid, pid);
        const merged: CircuitRow = Object.assign(
            {
                tenant_id: tid,
                project_id: pid,
                name,
                state: "CLOSED" as const,
                failure_count: 0,
                success_count: 0,
                half_open_success_count: 0,
                last_failure_at: null,
                last_success_at: null,
                opened_at: null,
                half_opened_at: null,
                last_error: null,
                last_response_time_ms: null,
                updated_at: now,
            },
            existing ?? {},
            data,
            { updated_at: now, tenant_id: tid, project_id: pid }
        );

        await this.pool.query(
            `INSERT INTO circuit_breakers
                (tenant_id, project_id, name, state, failure_count, success_count, half_open_success_count,
                 last_failure_at, last_success_at, opened_at, half_opened_at,
                 last_error, last_response_time_ms, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (tenant_id, project_id, name) DO UPDATE SET
                state                   = EXCLUDED.state,
                failure_count           = EXCLUDED.failure_count,
                success_count           = EXCLUDED.success_count,
                half_open_success_count = EXCLUDED.half_open_success_count,
                last_failure_at         = EXCLUDED.last_failure_at,
                last_success_at         = EXCLUDED.last_success_at,
                opened_at               = EXCLUDED.opened_at,
                half_opened_at          = EXCLUDED.half_opened_at,
                last_error              = EXCLUDED.last_error,
                last_response_time_ms   = EXCLUDED.last_response_time_ms,
                updated_at              = EXCLUDED.updated_at`,
            [
                tid,
                pid,
                name,
                merged.state,
                merged.failure_count,
                merged.success_count,
                merged.half_open_success_count ?? 0,
                merged.last_failure_at,
                merged.last_success_at,
                merged.opened_at,
                merged.half_opened_at,
                merged.last_error ?? null,
                merged.last_response_time_ms ?? null,
                merged.updated_at,
            ]
        );

        this.cache.set(key, merged);
    }

    async getAll(tenantId?: string, projectId?: string): Promise<CircuitRow[]> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const res = await this.pool.query<CircuitRow>(
            `SELECT * FROM circuit_breakers
             WHERE tenant_id = $1 AND project_id = $2
             ORDER BY name ASC`,
            [tid, pid]
        );
        return res.rows;
    }

    async delete(name: string, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        this.cache.delete(this.getCacheKey(tid, pid, name));
        await this.pool.query(
            `DELETE FROM circuit_breakers WHERE tenant_id = $1 AND project_id = $2 AND name = $3`,
            [tid, pid, name]
        );
    }
}

// ===========================================================================
// 2. PostgresBaselineRepository
// ===========================================================================

export class PostgresBaselineRepository implements IBaselineRepository {
    private cache = new Map<string, BaselineRow | null>();

    constructor(private pool: PostgresConnectionPool) {}

    private getCacheKey(tid: string, pid: string, name: string): string {
        return `${tid}:${pid}:${name}`;
    }

    clearCache(): void {
        this.cache.clear();
    }

    async recordObservation(metricName: string, value: number, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        await this.pool.query(
            `INSERT INTO metric_observations (tenant_id, project_id, metric_name, value, recorded_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [tid, pid, metricName, value, new Date().toISOString()]
        );
    }

    async get(metricName: string, tenantId?: string, projectId?: string): Promise<BaselineRow | undefined> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, metricName);

        if (this.cache.has(key)) {
            return this.cache.get(key) ?? undefined;
        }

        const res = await this.pool.query<BaselineRow>(
            `SELECT * FROM metric_baselines
             WHERE tenant_id = $1 AND project_id = $2 AND metric_name = $3`,
            [tid, pid, metricName]
        );
        const row = res.rows[0];
        this.cache.set(key, row ?? null);
        return row;
    }

    async upsert(metricName: string, data: Partial<BaselineRow>, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, metricName);
        const now = new Date().toISOString();

        const existing = await this.get(metricName, tid, pid);
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

        await this.pool.query(
            `INSERT INTO metric_baselines
                (tenant_id, project_id, metric_name, ema_mean, ema_variance, observation_count,
                 status, winsorized_count, first_observed_at, last_observed_at, window_size, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (tenant_id, project_id, metric_name) DO UPDATE SET
                ema_mean          = EXCLUDED.ema_mean,
                ema_variance      = EXCLUDED.ema_variance,
                observation_count = EXCLUDED.observation_count,
                status            = EXCLUDED.status,
                winsorized_count  = EXCLUDED.winsorized_count,
                last_observed_at  = EXCLUDED.last_observed_at,
                window_size       = EXCLUDED.window_size,
                updated_at        = EXCLUDED.updated_at`,
            [
                tid,
                pid,
                metricName,
                merged.ema_mean,
                merged.ema_variance,
                merged.observation_count,
                merged.status,
                merged.winsorized_count,
                merged.first_observed_at,
                merged.last_observed_at,
                merged.window_size,
                merged.updated_at,
            ]
        );

        this.cache.set(key, merged);
    }

    async reset(metricName: string, hardDelete: boolean = false, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const key = this.getCacheKey(tid, pid, metricName);

        await this.pool.query(
            `DELETE FROM metric_observations WHERE tenant_id = $1 AND project_id = $2 AND metric_name = $3`,
            [tid, pid, metricName]
        );

        if (hardDelete) {
            this.cache.delete(key);
            await this.pool.query(
                `DELETE FROM metric_baselines WHERE tenant_id = $1 AND project_id = $2 AND metric_name = $3`,
                [tid, pid, metricName]
            );
        } else {
            const now = new Date().toISOString();
            const existing = await this.get(metricName, tid, pid);
            if (existing) {
                this.cache.set(key, {
                    ...existing,
                    ema_mean: 0,
                    ema_variance: 0,
                    observation_count: 0,
                    status: "learning",
                    winsorized_count: 0,
                    updated_at: now,
                });
            }
            await this.pool.query(
                `UPDATE metric_baselines
                 SET ema_mean = 0, ema_variance = 0, observation_count = 0, status = 'learning', winsorized_count = 0, updated_at = $1
                 WHERE tenant_id = $2 AND project_id = $3 AND metric_name = $4`,
                [now, tid, pid, metricName]
            );
        }
    }

    async getRecentObservations(metricName: string, limit: number, tenantId?: string, projectId?: string): Promise<ObservationRow[]> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const res = await this.pool.query<ObservationRow>(
            `SELECT id, tenant_id, project_id, metric_name, value, recorded_at
             FROM metric_observations
             WHERE tenant_id = $1 AND project_id = $2 AND metric_name = $3
             ORDER BY recorded_at DESC
             LIMIT $4`,
            [tid, pid, metricName, limit]
        );
        return res.rows;
    }

    async getObservationCount(metricName: string, tenantId?: string, projectId?: string): Promise<number> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const res = await this.pool.query<{ count: string | number }>(
            `SELECT COUNT(*)::int AS count
             FROM metric_observations
             WHERE tenant_id = $1 AND project_id = $2 AND metric_name = $3`,
            [tid, pid, metricName]
        );
        return Number(res.rows[0]?.count ?? 0);
    }

    async getStats(tenantId?: string, projectId?: string): Promise<{ total_metrics_tracked: number; confident_baselines: number }> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const res = await this.pool.query<{ total: string | number; confident: string | number | null }>(
            `SELECT
                COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN observation_count >= window_size THEN 1 ELSE 0 END), 0)::int AS confident
             FROM metric_baselines
             WHERE tenant_id = $1 AND project_id = $2`,
            [tid, pid]
        );
        return {
            total_metrics_tracked: Number(res.rows[0]?.total ?? 0),
            confident_baselines: Number(res.rows[0]?.confident ?? 0),
        };
    }
}

// ===========================================================================
// 3. PostgresCausalTraceRepository
// ===========================================================================

interface PgCheckpointRow {
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

function mapPgRowToEntry(row: PgCheckpointRow): CheckpointEntry {
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
        ...(row.tool_name ? { tool_name: row.tool_name } : {}),
        ...(row.status ? { status: row.status } : {}),
        content: row.content,
        metadata,
        tags,
        parent_checkpoint_id: row.parent_checkpoint_id,
        created_at: row.created_at,
    };
}

export class PostgresCausalTraceRepository implements ICausalTraceRepository {
    constructor(private pool: PostgresConnectionPool) {}

    async append<T extends object>(sessionId: string, record: T, tenantId?: string, projectId?: string): Promise<void> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;
        const entry = record as any;
        const checkpointId = entry.id || entry.checkpoint_id || crypto.randomUUID();

        const count = await this.countRecords(sessionId, tid, pid);
        if (count >= MAX_CHECKPOINTS) {
            throw new CheckpointLimitError(sessionId, MAX_CHECKPOINTS);
        }

        await this.pool.query(
            `INSERT INTO session_checkpoints (
                checkpoint_id, tenant_id, project_id, session_id, parent_checkpoint_id,
                checkpoint_type, tool_name, status, content, metadata_json, tags_json,
                payload_json, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
                checkpointId,
                tid,
                pid,
                sessionId,
                entry.parent_checkpoint_id ?? null,
                entry.checkpoint_type ?? "reasoning",
                entry.tool_name ?? null,
                entry.status ?? null,
                entry.content ?? "",
                entry.metadata ? JSON.stringify(entry.metadata) : null,
                entry.tags ? JSON.stringify(entry.tags) : null,
                entry.payload ? JSON.stringify(entry.payload) : null,
                entry.created_at ?? new Date().toISOString(),
            ]
        );
    }

    async readAll<T = CheckpointEntry>(sessionId: string, tenantId?: string, projectId?: string): Promise<T[]> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const res = await this.pool.query<PgCheckpointRow>(
            `SELECT * FROM session_checkpoints
             WHERE tenant_id = $1 AND project_id = $2 AND session_id = $3
             ORDER BY created_at ASC`,
            [tid, pid, sessionId]
        );
        return res.rows.map((r) => mapPgRowToEntry(r) as unknown as T);
    }

    async queryHistory(options: QueryHistoryOptions): Promise<QueryHistoryResult> {
        const ctx = getTenantContext();
        const tid = options.tenant_id ?? ctx.tenant_id;
        const pid = options.project_id ?? ctx.project_id;
        const {
            session_id,
            limit = 50,
            offset = 0,
            checkpoint_type,
            since_timestamp,
            until_timestamp,
            tags,
            tag_match = "all",
        } = options;

        let sql = `SELECT * FROM session_checkpoints WHERE tenant_id = $1 AND project_id = $2 AND session_id = $3`;
        const params: unknown[] = [tid, pid, session_id];
        let idx = 4;

        if (checkpoint_type) {
            sql += ` AND checkpoint_type = $${idx++}`;
            params.push(checkpoint_type);
        }
        if (since_timestamp) {
            sql += ` AND created_at >= $${idx++}`;
            params.push(since_timestamp);
        }
        if (until_timestamp) {
            sql += ` AND created_at <= $${idx++}`;
            params.push(until_timestamp);
        }
        sql += ` ORDER BY created_at ASC`;

        const res = await this.pool.query<PgCheckpointRow>(sql, params);
        let entries = res.rows.map(mapPgRowToEntry);

        if (tags && tags.length > 0) {
            if (tag_match === "any") {
                entries = entries.filter((e) => e.tags && tags.some((t) => e.tags!.includes(t)));
            } else {
                entries = entries.filter((e) => e.tags && tags.every((t) => e.tags!.includes(t)));
            }
        }

        const totalFound = entries.length;
        const paginated = offset > 0 ? entries.slice(offset, offset + limit) : entries.slice(-limit);
        return {
            entries: paginated,
            totalFound,
            hasMore: offset > 0 ? offset + paginated.length < totalFound : totalFound > limit,
        };
    }

    async getLineageForFailures(sessionId: string, failedCheckpointIds: string[], tenantId?: string, projectId?: string): Promise<CheckpointEntry[]> {
        if (failedCheckpointIds.length === 0) return [];
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const placeholders = failedCheckpointIds.map((_, i) => `$${i + 4}`).join(",");
        const query = `
            WITH RECURSIVE lineage(checkpoint_id, parent_checkpoint_id, depth) AS (
                SELECT checkpoint_id, parent_checkpoint_id, 0
                FROM session_checkpoints
                WHERE tenant_id = $1 AND project_id = $2 AND session_id = $3 AND checkpoint_id IN (${placeholders})

                UNION ALL

                SELECT c.checkpoint_id, c.parent_checkpoint_id, l.depth + 1
                FROM session_checkpoints c
                JOIN lineage l ON c.checkpoint_id = l.parent_checkpoint_id
                WHERE l.parent_checkpoint_id IS NOT NULL AND l.depth < 100 AND c.tenant_id = $1 AND c.project_id = $2
            )
            SELECT DISTINCT c.* FROM session_checkpoints c
            JOIN lineage l ON c.checkpoint_id = l.checkpoint_id
            ORDER BY c.created_at ASC
        `;

        const res = await this.pool.query<PgCheckpointRow>(query, [tid, pid, sessionId, ...failedCheckpointIds]);
        return res.rows.map(mapPgRowToEntry);
    }

    async countRecords(sessionId: string, tenantId?: string, projectId?: string): Promise<number> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const res = await this.pool.query<{ count: string | number }>(
            `SELECT COUNT(*)::int AS count FROM session_checkpoints
             WHERE tenant_id = $1 AND project_id = $2 AND session_id = $3`,
            [tid, pid, sessionId]
        );
        return Number(res.rows[0]?.count ?? 0);
    }

    async getStats(tenantId?: string, projectId?: string): Promise<{ total_sessions: number; total_checkpoints: number }> {
        const ctx = getTenantContext();
        const tid = tenantId ?? ctx.tenant_id;
        const pid = projectId ?? ctx.project_id;

        const res = await this.pool.query<{ total_sessions: string | number; total_checkpoints: string | number }>(
            `SELECT COUNT(DISTINCT session_id)::int AS total_sessions, COUNT(*)::int AS total_checkpoints
             FROM session_checkpoints
             WHERE tenant_id = $1 AND project_id = $2`,
            [tid, pid]
        );
        return {
            total_sessions: Number(res.rows[0]?.total_sessions ?? 0),
            total_checkpoints: Number(res.rows[0]?.total_checkpoints ?? 0),
        };
    }
}
