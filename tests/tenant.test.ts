/**
 * AgentGuard MCP v2.1.0 — Unit Tests: Token-Derived Multi-Tenant Scoping & Data Isolation
 *
 * Verifies strict data isolation across tenants for:
 *  1. Bearer token parsing and TenantIdentity structure.
 *  2. AsyncLocalStorage (tenantContextStorage) propagation.
 *  3. Multi-tenant Circuit Breaker state isolation.
 *  4. Multi-tenant Adaptive Baseline & Observation isolation.
 *  5. Multi-tenant Session Checkpoint storage isolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authenticateRequest, tenantContextStorage, getTenantContext } from "../src/utils/auth.js";
import { getCircuit, upsertCircuit, getAllCircuits } from "../src/utils/circuitStore.js";
import { recordObservation, getBaseline, upsertBaseline, getBaselineStats } from "../src/utils/metricStore.js";
import { append, readAll, countRecords, getStorageStats } from "../src/utils/storage.js";
import type { Request } from "express";

describe("Multi-Tenant Token Scoping & Data Isolation", () => {
    // -----------------------------------------------------------------------
    // 1. Bearer Token Parsing & Identity Derivation
    // -----------------------------------------------------------------------
    describe("Token Identity Derivation", () => {
        it("parses structured Bearer token tenant_id:project_id:env:key", () => {
            process.env.AGENTGUARD_API_KEY = "secret123";

            const mockReq = {
                headers: {
                    authorization: "Bearer tenant-alpha:proj-x:production:secret123",
                },
            } as unknown as Request;

            const res = authenticateRequest(mockReq);
            assert.equal(res.authenticated, true);
            assert.deepEqual(res.identity, {
                tenant_id: "tenant-alpha",
                project_id: "proj-x",
                env: "production",
                rate_limit: 100,
            });
        });

        it("falls back to default identity for standard Bearer token", () => {
            process.env.AGENTGUARD_API_KEY = "secret123";

            const mockReq = {
                headers: {
                    authorization: "Bearer secret123",
                },
            } as unknown as Request;

            const res = authenticateRequest(mockReq);
            assert.equal(res.authenticated, true);
            assert.equal(res.identity?.tenant_id, "default-tenant");
            assert.equal(res.identity?.project_id, "default-project");
        });
    });

    // -----------------------------------------------------------------------
    // 2. Circuit Breaker Isolation Across Tenants
    // -----------------------------------------------------------------------
    describe("Circuit Breaker Tenant Isolation", () => {
        it("isolates circuit state between two distinct tenants for the same tool_name", () => {
            const toolName = `payment_gateway_${Date.now()}`;

            const identityA = { tenant_id: "tenant-a", project_id: "proj-1", env: "prod", rate_limit: 100 };
            const identityB = { tenant_id: "tenant-b", project_id: "proj-1", env: "prod", rate_limit: 100 };

            // Trip circuit for Tenant A
            tenantContextStorage.run(identityA, () => {
                upsertCircuit(toolName, { state: "OPEN", failure_count: 5 });
                const circuitA = getCircuit(toolName);
                assert.equal(circuitA?.state, "OPEN");
                assert.equal(circuitA?.failure_count, 5);
            });

            // Verify Tenant B has separate pristine circuit
            tenantContextStorage.run(identityB, () => {
                const circuitB = getCircuit(toolName);
                assert.equal(circuitB, undefined);

                // Create CLOSED circuit for Tenant B
                upsertCircuit(toolName, { state: "CLOSED", success_count: 10 });
                const updatedB = getCircuit(toolName);
                assert.equal(updatedB?.state, "CLOSED");
                assert.equal(updatedB?.success_count, 10);
            });

            // Re-verify Tenant A's state remains OPEN and unaffected by Tenant B
            tenantContextStorage.run(identityA, () => {
                const circuitA = getCircuit(toolName);
                assert.equal(circuitA?.state, "OPEN");
                assert.equal(circuitA?.failure_count, 5);
            });
        });
    });

    // -----------------------------------------------------------------------
    // 3. Metric Observations & Baselines Isolation Across Tenants
    // -----------------------------------------------------------------------
    describe("Metric Observations & Baselines Tenant Isolation", () => {
        it("isolates adaptive baselines between distinct tenants for the same metric", () => {
            const metricName = `latency_ms_${Date.now()}`;

            const identityA = { tenant_id: "tenant-a", project_id: "proj-metrics", env: "prod", rate_limit: 100 };
            const identityB = { tenant_id: "tenant-b", project_id: "proj-metrics", env: "prod", rate_limit: 100 };

            tenantContextStorage.run(identityA, () => {
                recordObservation(metricName, 150);
                upsertBaseline(metricName, { ema_mean: 150, observation_count: 1 });

                const baselineA = getBaseline(metricName);
                assert.equal(baselineA?.ema_mean, 150);
                assert.equal(baselineA?.observation_count, 1);
            });

            tenantContextStorage.run(identityB, () => {
                const baselineB = getBaseline(metricName);
                assert.equal(baselineB, undefined);

                recordObservation(metricName, 450);
                upsertBaseline(metricName, { ema_mean: 450, observation_count: 1 });

                const updatedB = getBaseline(metricName);
                assert.equal(updatedB?.ema_mean, 450);
            });

            // Verify Tenant A baseline was untouched by Tenant B
            tenantContextStorage.run(identityA, () => {
                const baselineA = getBaseline(metricName);
                assert.equal(baselineA?.ema_mean, 150);
            });
        });
    });

    // -----------------------------------------------------------------------
    // 4. Storage Session Checkpoints Isolation Across Tenants
    // -----------------------------------------------------------------------
    describe("Session Checkpoint Tenant Isolation", () => {
        it("prevents cross-tenant access to session history even with matching session_id", async () => {
            const sharedSessionId = `shared-session-${Date.now()}`;
            const cpId = `cp-alpha-1-${Date.now()}`;

            const identityA = { tenant_id: "tenant-alpha", project_id: "proj-sec", env: "prod", rate_limit: 100 };
            const identityB = { tenant_id: "tenant-beta", project_id: "proj-sec", env: "prod", rate_limit: 100 };

            // Tenant Alpha writes checkpoint
            await tenantContextStorage.run(identityA, async () => {
                await append(sharedSessionId, {
                    id: cpId,
                    checkpoint_type: "reasoning",
                    content: "Secret Alpha data",
                    created_at: new Date().toISOString(),
                });

                const countA = await countRecords(sharedSessionId);
                assert.equal(countA, 1);

                const entriesA = await readAll(sharedSessionId);
                assert.equal(entriesA.length, 1);
                assert.equal(entriesA[0].id, cpId);
            });

            // Tenant Beta attempts to query the same session_id
            await tenantContextStorage.run(identityB, async () => {
                const countB = await countRecords(sharedSessionId);
                assert.equal(countB, 0); // Isolated!

                const entriesB = await readAll(sharedSessionId);
                assert.equal(entriesB.length, 0); // Cross-tenant data leak blocked!
            });
        });
    });
});
