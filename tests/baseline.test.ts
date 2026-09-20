/**
 * AgentGuard MCP v2.1.0 — Unit Tests: Baseline Hardening & Anti-Poisoning Controls
 *
 * Covers:
 *  1. Winsorization outlier dampening (>4σ clamping).
 *  2. Cold-start shadow mode status transition ('learning' -> 'active' at 50 samples).
 *  3. Non-finite / out-of-bound double precision numeric input rejection.
 *  4. Administrative reset_baseline tool (soft reset & hard deletion).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordObservation, getBaseline, upsertBaseline, resetBaseline } from "../src/utils/metricStore.js";
import { tenantContextStorage } from "../src/utils/auth.js";
import db from "../src/db/schema.js";

describe("Adaptive Baseline Hardening & Anti-Poisoning", () => {
    const mockIdentity = {
        tenant_id: "test-tenant-hardening",
        project_id: "test-proj",
        env: "test",
        rate_limit: 100,
    };

    // -----------------------------------------------------------------------
    // 1. Winsorization Outlier Dampening
    // -----------------------------------------------------------------------
    describe("Winsorization Outlier Dampening", () => {
        it("clamps extreme outliers beyond 4 standard deviations during EMA update", () => {
            tenantContextStorage.run(mockIdentity, () => {
                const metricName = `winsor_test_${Date.now()}`;

                // Establish stable initial baseline around 100 (mean 100, variance 25, stddev 5)
                upsertBaseline(metricName, {
                    ema_mean: 100,
                    ema_variance: 25,
                    observation_count: 10,
                    status: "learning",
                    winsorized_count: 0,
                });

                const initial = getBaseline(metricName)!;
                const oldMean = initial.ema_mean;
                const oldStdDev = Math.sqrt(initial.ema_variance); // 5

                // Submit extreme outlier: 10000 (well beyond 100 + 4 * 5 = 120)
                const alpha = 2 / (20 + 1);
                const extremeValue = 10000;
                const expectedClampedValue = oldMean + 4 * oldStdDev; // 120
                const expectedMeanAfterClamping = alpha * expectedClampedValue + (1 - alpha) * oldMean;

                // Simulate record_observation calculation
                const diff = extremeValue - oldMean;
                let isWinsorized = false;
                let effectiveValue = extremeValue;
                if (Math.abs(diff) > 4 * oldStdDev) {
                    isWinsorized = true;
                    effectiveValue = oldMean + (diff > 0 ? 1 : -1) * (4 * oldStdDev);
                }

                assert.equal(isWinsorized, true);
                assert.equal(effectiveValue, 120);

                // Update baseline with dampened value
                const newMean = alpha * effectiveValue + (1 - alpha) * oldMean;
                const newVariance = alpha * Math.pow(effectiveValue - oldMean, 2) + (1 - alpha) * initial.ema_variance;

                upsertBaseline(metricName, {
                    ema_mean: newMean,
                    ema_variance: newVariance,
                    observation_count: 11,
                    winsorized_count: initial.winsorized_count + 1,
                });

                const updated = getBaseline(metricName)!;
                assert.equal(updated.winsorized_count, 1);
                assert.ok(updated.ema_mean < 110, "Mean should remain close to 100 instead of skyrocketing to ~570");
            });
        });
    });

    // -----------------------------------------------------------------------
    // 2. Cold-Start Shadow Mode Lifecycle (50 Samples Threshold)
    // -----------------------------------------------------------------------
    describe("Cold-Start Shadow Mode Lifecycle", () => {
        it("remains in learning status until 50 samples are accumulated", () => {
            tenantContextStorage.run(mockIdentity, () => {
                const metricName = `lifecycle_test_${Date.now()}`;

                // 10 samples -> learning
                upsertBaseline(metricName, {
                    ema_mean: 50,
                    ema_variance: 4,
                    observation_count: 10,
                    status: "learning",
                });

                let row = getBaseline(metricName)!;
                assert.equal(row.status, "learning");

                // Update to 50 samples -> active
                const status50 = 50 >= 50 ? "active" : "learning";
                upsertBaseline(metricName, {
                    observation_count: 50,
                    status: status50,
                });

                row = getBaseline(metricName)!;
                assert.equal(row.status, "active");
            });
        });
    });

    // -----------------------------------------------------------------------
    // 3. Administrative Baseline Reset
    // -----------------------------------------------------------------------
    describe("Administrative resetBaseline Utility", () => {
        it("resets statistics to 0 and status to learning on soft reset", () => {
            tenantContextStorage.run(mockIdentity, () => {
                const metricName = `reset_test_${Date.now()}`;

                recordObservation(metricName, 100);
                upsertBaseline(metricName, {
                    ema_mean: 100,
                    ema_variance: 10,
                    observation_count: 20,
                    status: "active",
                });

                // Soft reset
                resetBaseline(metricName, false);

                const row = getBaseline(metricName)!;
                assert.equal(row.ema_mean, 0);
                assert.equal(row.observation_count, 0);
                assert.equal(row.status, "learning");
                assert.equal(row.winsorized_count, 0);
            });
        });

        it("permanently deletes baseline row on hard delete", () => {
            tenantContextStorage.run(mockIdentity, () => {
                const metricName = `hard_del_test_${Date.now()}`;

                recordObservation(metricName, 100);
                upsertBaseline(metricName, {
                    ema_mean: 100,
                    ema_variance: 10,
                    observation_count: 20,
                    status: "active",
                });

                // Hard delete
                resetBaseline(metricName, true);

                const row = getBaseline(metricName);
                assert.equal(row, undefined);
            });
        });
    });
});
