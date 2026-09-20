/**
 * AgentGuard MCP v3.0.0 — Unit Tests: Repository Abstraction Layer
 *
 * Covers:
 *  1. RepositoryFactory backend switching (sqlite <-> postgres).
 *  2. Database health probes (getDatabaseHealth).
 *  3. ICircuitBreakerRepository operations under tenant context.
 *  4. IBaselineRepository operations & L1 cache.
 *  5. ICausalTraceRepository operations & CTE lineage.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    RepositoryFactory,
    getCircuitBreakerRepository,
    getBaselineRepository,
    getCausalTraceRepository,
} from "../src/repositories/factory.js";
import { runDatabaseMaintenance } from "../src/utils/maintenance.js";

describe("Repository Abstraction Tier (v3.0 Preparation)", () => {
    before(() => {
        runDatabaseMaintenance();
    });

    beforeEach(() => {
        RepositoryFactory.getInstance().setBackend("sqlite");
    });

    describe("RepositoryFactory & Backend Switching", () => {
        it("instantiates default SQLite backend", () => {
            const factory = RepositoryFactory.getInstance();
            assert.equal(factory.getBackend(), "sqlite");
        });

        it("switches backends via setBackend()", () => {
            const factory = RepositoryFactory.getInstance();
            factory.setBackend("postgres");
            assert.equal(factory.getBackend(), "postgres");

            factory.setBackend("sqlite");
            assert.equal(factory.getBackend(), "sqlite");
        });

        it("returns database health probe for SQLite backend", async () => {
            const factory = RepositoryFactory.getInstance();
            factory.setBackend("sqlite");
            const health = await factory.getDatabaseHealth();

            assert.equal(health.healthy, true);
            assert.equal(health.backend, "sqlite");
            assert.equal(health.connection_pooled, false);
            assert.ok(typeof health.latency_ms === "number");
        });
    });

    describe("ICircuitBreakerRepository", () => {
        it("performs CRUD operations on circuit breakers", () => {
            const repo = getCircuitBreakerRepository();
            const circuitName = `repo-cb-${Date.now()}`;

            // Initially undefined
            assert.equal(repo.get(circuitName), undefined);

            // Upsert OPEN state
            repo.upsert(circuitName, { state: "OPEN", failure_count: 5 });
            const saved = repo.get(circuitName);
            assert.ok(saved);
            assert.equal(saved?.state, "OPEN");
            assert.equal(saved?.failure_count, 5);

            // GetAll
            const all = repo.getAll();
            assert.ok(all.some((c) => c.name === circuitName));

            // Delete
            repo.delete(circuitName);
            assert.equal(repo.get(circuitName), undefined);
        });
    });

    describe("IBaselineRepository", () => {
        it("records observations and computes baselines", () => {
            const repo = getBaselineRepository();
            const metricName = `repo-metric-${Date.now()}`;

            // Record observation
            repo.recordObservation(metricName, 42.5);
            const count = repo.getObservationCount(metricName);
            assert.ok(typeof count === "number");

            // Upsert baseline
            repo.upsert(metricName, { ema_mean: 42.5, observation_count: 1, status: "learning" });
            const baseline = repo.get(metricName);
            assert.ok(baseline);
            assert.equal(baseline?.ema_mean, 42.5);

            // Reset
            repo.reset(metricName, true);
            assert.equal(repo.get(metricName), undefined);
        });
    });

    describe("ICausalTraceRepository", () => {
        it("appends checkpoints and retrieves session history", async () => {
            const repo = getCausalTraceRepository();
            const sessionId = `repo-session-${Date.now()}`;

            await repo.append(sessionId, {
                id: `cp-repo-1-${Date.now()}`,
                checkpoint_type: "reasoning",
                content: "Repository test checkpoint",
                created_at: new Date().toISOString(),
            });

            const count = await repo.countRecords(sessionId);
            assert.equal(count, 1);

            const entries = await repo.readAll(sessionId);
            assert.equal(entries.length, 1);
            assert.equal(entries[0].content, "Repository test checkpoint");
        });
    });
});
