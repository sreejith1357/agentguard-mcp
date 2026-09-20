import type { CircuitRow } from "../types/index.js";
import { getCircuitBreakerRepository } from "../repositories/factory.js";

/**
 * Retrieve a single circuit breaker row by name scoped by tenant identity.
 * Resolves directly from active repository (with L1 memory caching).
 */
export function getCircuit(name: string, tenantId?: string, projectId?: string): CircuitRow | undefined {
    const res = getCircuitBreakerRepository().get(name, tenantId, projectId);
    return res instanceof Promise ? undefined : res;
}

/**
 * Insert or update a circuit breaker row.
 * Writes through active repository.
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
 * Return all circuit breaker rows for the active tenant.
 */
export function getAllCircuits(tenantId?: string, projectId?: string): CircuitRow[] {
    const res = getCircuitBreakerRepository().getAll(tenantId, projectId);
    return res instanceof Promise ? [] : res;
}

/**
 * Permanently remove a circuit breaker for the active tenant.
 */
export function deleteCircuit(name: string, tenantId?: string, projectId?: string): void {
    const res = getCircuitBreakerRepository().delete(name, tenantId, projectId);
    if (res instanceof Promise) res.catch(() => {});
}

/**
 * Clear circuit cache on active repository.
 */
export function clearCircuitCache(): void {
    getCircuitBreakerRepository().clearCache?.();
}
