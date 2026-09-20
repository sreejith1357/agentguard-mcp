/**
 * AgentGuard MCP v3.0.0 — Metric Store
 *
 * Unified data-access layer delegating to the active persistence repository
 * (SQLite or PostgreSQL) via RepositoryFactory.
 */

import type { BaselineRow, ObservationRow } from "../types/index.js";
import { getBaselineRepository } from "../repositories/factory.js";

/**
 * Clear baseline memory cache on active repository.
 */
export function clearMetricCache(): void {
    getBaselineRepository().clearCache?.();
}

/**
 * Append a single numeric observation for a metric scoped by tenant identity.
 */
export function recordObservation(
    metric_name: string,
    value: number,
    tenantId?: string,
    projectId?: string
): void {
    const res = getBaselineRepository().recordObservation(metric_name, value, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

/**
 * Retrieve the pre-computed EMA baseline for a metric scoped by tenant identity.
 * Fast-path L1 cache read (< 0.01ms).
 */
export function getBaseline(
    metric_name: string,
    tenantId?: string,
    projectId?: string
): BaselineRow | undefined {
    const res = getBaselineRepository().get(metric_name, tenantId, projectId);
    return res instanceof Promise ? undefined : res;
}

/**
 * Insert or update the EMA baseline for a metric scoped by tenant identity.
 * Write-through atomic update.
 */
export function upsertBaseline(
    metric_name: string,
    data: Partial<BaselineRow>,
    tenantId?: string,
    projectId?: string
): void {
    const res = getBaselineRepository().upsert(metric_name, data, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

/**
 * Permanently delete or reset a metric baseline and its observation history for the active tenant.
 */
export function resetBaseline(
    metric_name: string,
    hardDelete: boolean = false,
    tenantId?: string,
    projectId?: string
): void {
    const res = getBaselineRepository().reset(metric_name, hardDelete, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

/**
 * Return the N most recent observations for a metric, newest first, scoped by tenant.
 */
export function getRecentObservations(
    metric_name: string,
    limit: number,
    tenantId?: string,
    projectId?: string
): ObservationRow[] {
    const res = getBaselineRepository().getRecentObservations(metric_name, limit, tenantId, projectId);
    return res instanceof Promise ? [] : res;
}

/**
 * Return the total number of observations recorded for a metric scoped by tenant.
 */
export function getObservationCount(
    metric_name: string,
    tenantId?: string,
    projectId?: string
): number {
    const res = getBaselineRepository().getObservationCount(metric_name, tenantId, projectId);
    return res instanceof Promise ? 0 : res;
}

/**
 * Return aggregate statistics for metric baselines for active tenant context.
 */
export function getBaselineStats(
    tenantId?: string,
    projectId?: string
): {
    total_metrics_tracked: number;
    confident_baselines: number;
} {
    const res = getBaselineRepository().getStats(tenantId, projectId);
    return res instanceof Promise ? { total_metrics_tracked: 0, confident_baselines: 0 } : res;
}


