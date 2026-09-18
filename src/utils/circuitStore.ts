/**
 * AgentGuard MCP v2.0.0 — Circuit Breaker Store
 *
 * Thin data-access layer over the circuit_breakers SQLite table.
 * All queries use better-sqlite3 prepared statements for performance
 * and type safety.
 */

import db from "../db/schema.js";
import type { CircuitRow } from "../types/index.js";

// ---------------------------------------------------------------------------
// Prepared statements — compiled once at module load
// ---------------------------------------------------------------------------

const stmtGet = db.prepare<[string], CircuitRow>(
    "SELECT * FROM circuit_breakers WHERE name = ?"
);

const stmtGetAll = db.prepare<[], CircuitRow>(
    "SELECT * FROM circuit_breakers ORDER BY name ASC"
);

const stmtDelete = db.prepare<[string]>(
    "DELETE FROM circuit_breakers WHERE name = ?"
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a single circuit breaker row by name.
 * Returns undefined if the circuit does not yet exist.
 */
export function getCircuit(name: string): CircuitRow | undefined {
    return stmtGet.get(name);
}

/**
 * Insert or update a circuit breaker row.
 * Always stamps updated_at with the current ISO timestamp.
 * Caller supplies only the fields they want to change.
 */
export function upsertCircuit(name: string, data: Partial<CircuitRow>): void {
    const now = new Date().toISOString();

    // Merge existing row (if any) with the supplied partial data
    const existing = getCircuit(name);

    const merged: CircuitRow = Object.assign(
        {
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
        { updated_at: now }   // always win — override whatever caller passed
    );

    db.prepare(`
        INSERT INTO circuit_breakers
            (name, state, failure_count, success_count, last_failure_at,
             last_success_at, opened_at, half_opened_at, updated_at)
        VALUES
            (@name, @state, @failure_count, @success_count, @last_failure_at,
             @last_success_at, @opened_at, @half_opened_at, @updated_at)
        ON CONFLICT(name) DO UPDATE SET
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

/**
 * Return all circuit breaker rows, ordered alphabetically by name.
 */
export function getAllCircuits(): CircuitRow[] {
    return stmtGetAll.all();
}

/**
 * Permanently remove a circuit breaker from the database.
 * No-op if the circuit does not exist.
 */
export function deleteCircuit(name: string): void {
    stmtDelete.run(name);
}
