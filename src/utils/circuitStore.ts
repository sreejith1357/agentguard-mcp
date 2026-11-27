import type { CircuitRow } from "../types/index.js";
import { getCircuitBreakerRepository } from "../repositories/factory.js";

/**
 * Retrieve a single circuit breaker row by name scoped by tenant identity (sync fast-path for SQLite).
 */
export function getCircuit(name: string, tenantId?: string, projectId?: string): CircuitRow | undefined {
    const res = getCircuitBreakerRepository().get(name, tenantId, projectId);
    return res instanceof Promise ? undefined : res;
}

/**
 * Async-safe retrieval across both SQLite and PostgreSQL backends.
 */
export async function getCircuitAsync(name: string, tenantId?: string, projectId?: string): Promise<CircuitRow | undefined> {
    return await getCircuitBreakerRepository().get(name, tenantId, projectId);
}

/**
 * Insert or update a circuit breaker row (sync fast-path for SQLite).
 */
export function upsertCircuit(
    name: string,
    data: Partial<CircuitRow>,
    tenantId?: string,
    projectId?: string
): void {
    const res = getCircuitBreakerRepository().upsert(name, data, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

/**
 * Async-safe upsert across both SQLite and PostgreSQL backends.
 */
export async function upsertCircuitAsync(
    name: string,
    data: Partial<CircuitRow>,
    tenantId?: string,
    projectId?: string
): Promise<void> {
    await getCircuitBreakerRepository().upsert(name, data, tenantId, projectId);
}

/**
 * Return all circuit breaker rows for the active tenant (sync fast-path for SQLite).
 */
export function getAllCircuits(tenantId?: string, projectId?: string): CircuitRow[] {
    const res = getCircuitBreakerRepository().getAll(tenantId, projectId);
    return res instanceof Promise ? [] : res;
}

/**
 * Async-safe listing across both SQLite and PostgreSQL backends.
 */
export async function getAllCircuitsAsync(tenantId?: string, projectId?: string): Promise<CircuitRow[]> {
    return await getCircuitBreakerRepository().getAll(tenantId, projectId);
}

/**
 * Permanently remove a circuit breaker for the active tenant.
 */
export function deleteCircuit(name: string, tenantId?: string, projectId?: string): void {
    const res = getCircuitBreakerRepository().delete(name, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

export async function deleteCircuitAsync(name: string, tenantId?: string, projectId?: string): Promise<void> {
    await getCircuitBreakerRepository().delete(name, tenantId, projectId);
}

/**
 * Clear circuit cache on active repository.
 */
export function clearCircuitCache(): void {
    getCircuitBreakerRepository().clearCache?.();
}
