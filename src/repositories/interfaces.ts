/**
 * AgentGuard MCP v3.0.0 — Unified Repository Interfaces
 *
 * Defines the persistence tier contracts (Repository Pattern) for:
 *   1. ICircuitBreakerRepository
 *   2. IBaselineRepository
 *   3. ICausalTraceRepository
 *
 * Allows seamless runtime swapping between local SQLite and distributed PostgreSQL/Redis.
 */

import type { CircuitRow, BaselineRow, ObservationRow, CheckpointEntry } from "../types/index.js";

export interface IDatabaseHealth {
    healthy: boolean;
    backend: "sqlite" | "postgres";
    connection_pooled: boolean;
    latency_ms: number;
    error?: string;
}

export interface ICircuitBreakerRepository {
    get(name: string, tenantId?: string, projectId?: string): Promise<CircuitRow | undefined> | CircuitRow | undefined;
    upsert(name: string, data: Partial<CircuitRow>, tenantId?: string, projectId?: string): Promise<void> | void;
    getAll(tenantId?: string, projectId?: string): Promise<CircuitRow[]> | CircuitRow[];
    delete(name: string, tenantId?: string, projectId?: string): Promise<void> | void;
    clearCache?(): void;
}

export interface IBaselineRepository {
    get(metricName: string, tenantId?: string, projectId?: string): Promise<BaselineRow | undefined> | BaselineRow | undefined;
    upsert(metricName: string, data: Partial<BaselineRow>, tenantId?: string, projectId?: string): Promise<void> | void;
    recordObservation(metricName: string, value: number, tenantId?: string, projectId?: string): Promise<void> | void;
    reset(metricName: string, hardDelete?: boolean, tenantId?: string, projectId?: string): Promise<void> | void;
    getRecentObservations(metricName: string, limit: number, tenantId?: string, projectId?: string): Promise<ObservationRow[]> | ObservationRow[];
    getObservationCount(metricName: string, tenantId?: string, projectId?: string): Promise<number> | number;
    getStats(tenantId?: string, projectId?: string): Promise<{ total_metrics_tracked: number; confident_baselines: number }> | { total_metrics_tracked: number; confident_baselines: number };
    clearCache?(): void;
}

export interface ICausalTraceRepository {
    append<T extends object>(sessionId: string, record: T, tenantId?: string, projectId?: string): Promise<void>;
    readAll<T = CheckpointEntry>(sessionId: string, tenantId?: string, projectId?: string): Promise<T[]>;
    queryHistory(options: {
        session_id: string;
        limit?: number;
        checkpoint_type?: string;
        since_timestamp?: string;
        tags?: string[];
        tenant_id?: string;
        project_id?: string;
    }): Promise<{ entries: CheckpointEntry[]; totalFound: number }> | { entries: CheckpointEntry[]; totalFound: number };
    getLineageForFailures(sessionId: string, failedCheckpointIds: string[], tenantId?: string, projectId?: string): Promise<CheckpointEntry[]> | CheckpointEntry[];
    countRecords(sessionId: string, tenantId?: string, projectId?: string): Promise<number>;
    getStats(tenantId?: string, projectId?: string): Promise<{ total_sessions: number; total_checkpoints: number }>;
}
