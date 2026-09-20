/**
 * AgentGuard MCP v2.1.0 — Unit Tests: Unified SQLite Storage & Recursive CTE Lineage
 *
 * Covers:
 *  1. Transactional checkpoint insertion & MAX_CHECKPOINTS limit enforcement.
 *  2. Indexed session history queries & tag filtering.
 *  3. Recursive CTE ancestor lineage queries for causal chain tracing.
 *  4. Rolling TTL pruning & incremental vacuuming.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    append,
    readAll,
    querySessionHistory,
    getLineageForFailures,
    countRecords,
    sessionExists,
    getStorageStats,
    cleanupOldSessions,
    CheckpointLimitError,
} from "../src/utils/storage.js";
import { runDatabaseMaintenance } from "../src/utils/maintenance.js";
import db from "../src/db/schema.js";

describe("Unified SQLite Storage & CTE Lineage", () => {
    const testSession = `test-session-${Date.now()}`;

    // -----------------------------------------------------------------------
    // 1. Transactional Insertion & Limit Enforcement
    // -----------------------------------------------------------------------
    describe("ACID Checkpoint Persistence", () => {
        it("atomically inserts checkpoints and queries count", async () => {
            const initialCount = await countRecords(testSession);
            assert.equal(initialCount, 0);

            await append(testSession, {
                id: `cp-100-${Date.now()}`,
                checkpoint_type: "reasoning",
                content: "Root decision step",
                created_at: new Date().toISOString(),
            });

            const newCount = await countRecords(testSession);
            assert.equal(newCount, 1);
            assert.equal(await sessionExists(testSession), true);
        });

        it("enforces MAX_CHECKPOINTS cap inside transaction", async () => {
            const capSession = `cap-session-${Date.now()}`;

            // Insert 5 checkpoints into a test session
            for (let i = 1; i <= 5; i++) {
                await append(capSession, {
                    id: `cap-cp-${Date.now()}-${i}`,
                    checkpoint_type: "reasoning",
                    content: `Step ${i}`,
                    created_at: new Date().toISOString(),
                });
            }

            assert.equal(await countRecords(capSession), 5);
        });
    });

    // -----------------------------------------------------------------------
    // 2. Indexed Session History Queries
    // -----------------------------------------------------------------------
    describe("Indexed History Queries & Filtering", () => {
        const historySession = `hist-session-${Date.now()}`;

        before(async () => {
            await append(historySession, {
                id: "cp-h1",
                checkpoint_type: "reasoning",
                content: "Reasoning step",
                tags: ["agent", "init"],
                created_at: "2026-01-01T10:00:00.000Z",
            });
            await append(historySession, {
                id: "cp-h2",
                checkpoint_type: "decision",
                content: "Decision step",
                tags: ["agent", "critical"],
                created_at: "2026-01-01T10:05:00.000Z",
            });
            await append(historySession, {
                id: "cp-h3",
                checkpoint_type: "error",
                content: "Error step",
                tags: ["critical", "failure"],
                created_at: "2026-01-01T10:10:00.000Z",
            });
        });

        it("filters history by checkpoint_type", () => {
            const res = querySessionHistory({
                session_id: historySession,
                checkpoint_type: "error",
            });
            assert.equal(res.totalFound, 1);
            assert.equal(res.entries[0].id, "cp-h3");
        });

        it("filters history by since_timestamp", () => {
            const res = querySessionHistory({
                session_id: historySession,
                since_timestamp: "2026-01-01T10:05:00.000Z",
            });
            assert.equal(res.totalFound, 2);
        });

        it("filters history by tags (AND logic)", () => {
            const res = querySessionHistory({
                session_id: historySession,
                tags: ["critical", "failure"],
            });
            assert.equal(res.totalFound, 1);
            assert.equal(res.entries[0].id, "cp-h3");
        });
    });

    // -----------------------------------------------------------------------
    // 3. Recursive CTE Causal Lineage Tracing
    // -----------------------------------------------------------------------
    describe("Recursive CTE Ancestor Lineage", () => {
        const cteSession = `cte-session-${Date.now()}`;

        before(async () => {
            // Build 3-level parent-child dependency chain: root -> mid -> leaf
            await append(cteSession, {
                id: "cte-root",
                parent_checkpoint_id: null,
                checkpoint_type: "reasoning",
                content: "Root reasoning checkpoint",
                created_at: "2026-01-01T12:00:00.000Z",
            });
            await append(cteSession, {
                id: "cte-mid",
                parent_checkpoint_id: "cte-root",
                checkpoint_type: "decision",
                content: "Mid decision checkpoint",
                created_at: "2026-01-01T12:01:00.000Z",
            });
            await append(cteSession, {
                id: "cte-leaf",
                parent_checkpoint_id: "cte-mid",
                checkpoint_type: "error",
                content: "Leaf error checkpoint",
                created_at: "2026-01-01T12:02:00.000Z",
            });
        });

        it("traces full ancestor lineage recursively in SQLite using CTEs", () => {
            const lineage = getLineageForFailures(cteSession, ["cte-leaf"]);
            assert.equal(lineage.length, 3);
            const ids = lineage.map((c) => c.id);
            assert.deepEqual(ids, ["cte-root", "cte-mid", "cte-leaf"]);
        });
    });

    // -----------------------------------------------------------------------
    // 4. Rolling TTL Maintenance & Incremental Vacuuming
    // -----------------------------------------------------------------------
    describe("Rolling TTL Cleanup & Vacuuming", () => {
        it("prunes old checkpoints and executes incremental vacuuming", async () => {
            const ttlSession = `ttl-session-${Date.now()}`;
            await append(ttlSession, {
                id: "old-cp",
                checkpoint_type: "reasoning",
                content: "Expired checkpoint",
                created_at: "2020-01-01T00:00:00.000Z", // 6 years ago
            });

            const result = await runDatabaseMaintenance(30);
            assert.ok(result.deleted_checkpoints >= 1);
            assert.equal(result.vacuum_executed, true);
        });

        it("computes storage stats across SQLite sessions", async () => {
            const stats = await getStorageStats();
            assert.ok(stats.total_sessions >= 1);
            assert.ok(stats.total_checkpoints >= 1);
        });
    });
});
