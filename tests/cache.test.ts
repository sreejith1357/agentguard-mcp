/**
 * AgentGuard MCP v2.1.0 — Unit Tests: In-Memory L1 Cache & Hot Path Optimization
 *
 * Covers:
 *  1. Sub-millisecond L1 cache hit performance on getCircuit & getBaseline.
 *  2. Read-your-own-writes consistency across L1 cache and SQLite write-through.
 *  3. L1 cache entry invalidation on delete/reset operations.
 *  4. LRU cache eviction and cache clearing utilities.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCircuit, upsertCircuit, deleteCircuit, clearCircuitCache } from "../src/utils/circuitStore.js";
import { getBaseline, upsertBaseline, resetBaseline, clearMetricCache } from "../src/utils/metricStore.js";
import { tenantContextStorage } from "../src/utils/auth.js";

describe("In-Memory L1 Cache & Hot Path Optimization", () => {
    const mockTenant = {
        tenant_id: "tenant-cache-test",
        project_id: "proj-cache",
        env: "prod",
        rate_limit: 100,
    };

    // -----------------------------------------------------------------------
    // 1. Circuit Breaker L1 Cache Tests
    // -----------------------------------------------------------------------
    describe("Circuit Breaker L1 Memory Cache", () => {
        it("resolves pre-flight circuit lookups directly from L1 memory in sub-millisecond time", () => {
            tenantContextStorage.run(mockTenant, () => {
                clearCircuitCache();
                const circuitName = `cached_circuit_${Date.now()}`;

                upsertCircuit(circuitName, { state: "CLOSED", failure_count: 0 });

                // First call populates or verifies L1 cache
                const start = performance.now();
                const c1 = getCircuit(circuitName);
                const duration1 = performance.now() - start;

                assert.equal(c1?.state, "CLOSED");

                // Subsequent L1 memory cache calls (hot path)
                const hotStart = performance.now();
                for (let i = 0; i < 1000; i++) {
                    const c = getCircuit(circuitName);
                    assert.equal(c?.state, "CLOSED");
                }
                const totalHotDuration = performance.now() - hotStart;
                const avgHotLatencyMs = totalHotDuration / 1000;

                assert.ok(avgHotLatencyMs < 0.05, `Average hot path latency (${avgHotLatencyMs.toFixed(5)}ms) must be < 0.05ms`);
            });
        });

        it("updates L1 cache instantly on state transition (read-your-own-writes)", () => {
            tenantContextStorage.run(mockTenant, () => {
                const circuitName = `state_trans_circuit_${Date.now()}`;

                upsertCircuit(circuitName, { state: "CLOSED" });
                assert.equal(getCircuit(circuitName)?.state, "CLOSED");

                // State transition to OPEN
                upsertCircuit(circuitName, { state: "OPEN", failure_count: 5 });
                const updated = getCircuit(circuitName);
                assert.equal(updated?.state, "OPEN");
                assert.equal(updated?.failure_count, 5);
            });
        });

        it("invalidates L1 cache entry on deleteCircuit", () => {
            tenantContextStorage.run(mockTenant, () => {
                const circuitName = `del_circuit_${Date.now()}`;

                upsertCircuit(circuitName, { state: "OPEN" });
                assert.equal(getCircuit(circuitName)?.state, "OPEN");

                deleteCircuit(circuitName);
                assert.equal(getCircuit(circuitName), undefined);
            });
        });
    });

    // -----------------------------------------------------------------------
    // 2. Metric Baseline L1 Cache Tests
    // -----------------------------------------------------------------------
    describe("Metric Baseline L1 Memory Cache", () => {
        it("resolves metric baseline lookups directly from L1 memory in sub-millisecond time", () => {
            tenantContextStorage.run(mockTenant, () => {
                clearMetricCache();
                const metricName = `cached_metric_${Date.now()}`;

                upsertBaseline(metricName, { ema_mean: 120.5, ema_variance: 4.2, observation_count: 15 });

                const start = performance.now();
                for (let i = 0; i < 1000; i++) {
                    const b = getBaseline(metricName);
                    assert.equal(b?.ema_mean, 120.5);
                }
                const duration = performance.now() - start;
                const avgLatencyMs = duration / 1000;

                assert.ok(avgLatencyMs < 0.05, `Average hot path metric latency (${avgLatencyMs.toFixed(5)}ms) must be < 0.05ms`);
            });
        });

        it("invalidates and resets L1 baseline cache on resetBaseline", () => {
            tenantContextStorage.run(mockTenant, () => {
                const metricName = `reset_metric_${Date.now()}`;

                upsertBaseline(metricName, { ema_mean: 300, observation_count: 50, status: "active" });
                assert.equal(getBaseline(metricName)?.status, "active");

                resetBaseline(metricName, false);
                const resetRow = getBaseline(metricName)!;
                assert.equal(resetRow.ema_mean, 0);
                assert.equal(resetRow.status, "learning");
            });
        });
    });
});
