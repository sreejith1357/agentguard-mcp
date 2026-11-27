/**
 * AgentGuard MCP v3.1.2 — Metric Store
 *
 * Unified data-access layer delegating to the active persistence repository
 * (SQLite or PostgreSQL) via RepositoryFactory.
 */

import type { BaselineRow, ObservationRow } from "../types/index.js";
import { getBaselineRepository } from "../repositories/factory.js";

export function clearMetricCache(): void {
    getBaselineRepository().clearCache?.();
}

export function recordObservation(
    metric_name: string,
    value: number,
    tenantId?: string,
    projectId?: string
): void {
    const res = getBaselineRepository().recordObservation(metric_name, value, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

export async function recordObservationAsync(
    metric_name: string,
    value: number,
    tenantId?: string,
    projectId?: string
): Promise<void> {
    await getBaselineRepository().recordObservation(metric_name, value, tenantId, projectId);
}

export function getBaseline(
    metric_name: string,
    tenantId?: string,
    projectId?: string
): BaselineRow | undefined {
    const res = getBaselineRepository().get(metric_name, tenantId, projectId);
    return res instanceof Promise ? undefined : res;
}

export async function getBaselineAsync(
    metric_name: string,
    tenantId?: string,
    projectId?: string
): Promise<BaselineRow | undefined> {
    return await getBaselineRepository().get(metric_name, tenantId, projectId);
}

export function upsertBaseline(
    metric_name: string,
    data: Partial<BaselineRow>,
    tenantId?: string,
    projectId?: string
): void {
    const res = getBaselineRepository().upsert(metric_name, data, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

export async function upsertBaselineAsync(
    metric_name: string,
    data: Partial<BaselineRow>,
    tenantId?: string,
    projectId?: string
): Promise<void> {
    await getBaselineRepository().upsert(metric_name, data, tenantId, projectId);
}

export function resetBaseline(
    metric_name: string,
    hardDelete: boolean = false,
    tenantId?: string,
    projectId?: string
): void {
    const res = getBaselineRepository().reset(metric_name, hardDelete, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

export async function resetBaselineAsync(
    metric_name: string,
    hardDelete: boolean = false,
    tenantId?: string,
    projectId?: string
): Promise<void> {
    await getBaselineRepository().reset(metric_name, hardDelete, tenantId, projectId);
}

export function getRecentObservations(
    metric_name: string,
    limit: number,
    tenantId?: string,
    projectId?: string
): ObservationRow[] {
    const res = getBaselineRepository().getRecentObservations(metric_name, limit, tenantId, projectId);
    return res instanceof Promise ? [] : res;
}

export async function getRecentObservationsAsync(
    metric_name: string,
    limit: number,
    tenantId?: string,
    projectId?: string
): Promise<ObservationRow[]> {
    return await getBaselineRepository().getRecentObservations(metric_name, limit, tenantId, projectId);
}

export function getObservationCount(
    metric_name: string,
    tenantId?: string,
    projectId?: string
): number {
    const res = getBaselineRepository().getObservationCount(metric_name, tenantId, projectId);
    return res instanceof Promise ? 0 : res;
}

export async function getObservationCountAsync(
    metric_name: string,
    tenantId?: string,
    projectId?: string
): Promise<number> {
    return await getBaselineRepository().getObservationCount(metric_name, tenantId, projectId);
}

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

export async function getBaselineStatsAsync(
    tenantId?: string,
    projectId?: string
): Promise<{
    total_metrics_tracked: number;
    confident_baselines: number;
}> {
    return await getBaselineRepository().getStats(tenantId, projectId);
}
