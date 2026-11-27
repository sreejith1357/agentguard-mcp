/**
 * AgentGuard MCP — Unit Tests: Real PostgreSQL Repository SQL Execution
 *
 * Uses a mocked PgQueryExecutor to verify real parameterized SQL queries,
 * connection pooling health checks, recursive CTEs, and schema initialization.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    PostgresConnectionPool,
    PostgresCircuitBreakerRepository,
    PostgresBaselineRepository,
    PostgresCausalTraceRepository,
    type PgQueryExecutor,
} from "../src/repositories/postgresRepository.js";

describe("PostgreSQL Repository Implementation", () => {
    function createMockPool() {
        const queries: { text: string; values?: unknown[] }[] = [];
        const cbStore = new Map<string, any>();
        const baselineStore = new Map<string, any>();
        const obsStore: any[] = [];
        const cpStore: any[] = [];

        const executor: PgQueryExecutor = {
            async query(text: string, values: unknown[] = []) {
                queries.push({ text, values });

                if (text.trim() === "SELECT 1" || text.includes("CREATE TABLE IF NOT EXISTS")) {
                    return { rows: [{ ok: 1 }], rowCount: 1 };
                }

                // Circuit Breakers
                if (text.includes("FROM circuit_breakers") && text.includes("WHERE tenant_id = $1 AND project_id = $2 AND name = $3")) {
                    const row = cbStore.get(`${values[0]}:${values[1]}:${values[2]}`);
                    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
                }
                if (text.includes("INSERT INTO circuit_breakers")) {
                    const [tid, pid, name, state, fc, sc, hos, lf, ls, oa, ho, le, lrt, ua] = values;
                    cbStore.set(`${tid}:${pid}:${name}`, {
                        tenant_id: tid,
                        project_id: pid,
                        name,
                        state,
                        failure_count: fc,
                        success_count: sc,
                        half_open_success_count: hos,
                        last_failure_at: lf,
                        last_success_at: ls,
                        opened_at: oa,
                        half_opened_at: ho,
                        last_error: le,
                        last_response_time_ms: lrt,
                        updated_at: ua,
                    });
                    return { rows: [], rowCount: 1 };
                }

                // Baselines
                if (text.includes("INSERT INTO metric_observations")) {
                    obsStore.push({
                        id: obsStore.length + 1,
                        tenant_id: values[0],
                        project_id: values[1],
                        metric_name: values[2],
                        value: values[3],
                        recorded_at: values[4],
                    });
                    return { rows: [], rowCount: 1 };
                }
                if (text.includes("SELECT COUNT(*)::int AS count") && text.includes("metric_observations")) {
                    const cnt = obsStore.filter(
                        (o) => o.tenant_id === values[0] && o.project_id === values[1] && o.metric_name === values[2]
                    ).length;
                    return { rows: [{ count: cnt }], rowCount: 1 };
                }
                if (text.includes("SELECT * FROM metric_baselines")) {
                    const row = baselineStore.get(`${values[0]}:${values[1]}:${values[2]}`);
                    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
                }
                if (text.includes("INSERT INTO metric_baselines")) {
                    baselineStore.set(`${values[0]}:${values[1]}:${values[2]}`, {
                        tenant_id: values[0],
                        project_id: values[1],
                        metric_name: values[2],
                        ema_mean: values[3],
                        ema_variance: values[4],
                        observation_count: values[5],
                        status: values[6],
                        winsorized_count: values[7],
                        first_observed_at: values[8],
                        last_observed_at: values[9],
                        window_size: values[10],
                        updated_at: values[11],
                    });
                    return { rows: [], rowCount: 1 };
                }

                // Causal Trace Checkpoints
                if (text.includes("SELECT COUNT(*)::int AS count FROM session_checkpoints")) {
                    const cnt = cpStore.filter(
                        (c) => c.tenant_id === values[0] && c.project_id === values[1] && c.session_id === values[2]
                    ).length;
                    return { rows: [{ count: cnt }], rowCount: 1 };
                }
                if (text.includes("INSERT INTO session_checkpoints")) {
                    cpStore.push({
                        checkpoint_id: values[0],
                        tenant_id: values[1],
                        project_id: values[2],
                        session_id: values[3],
                        parent_checkpoint_id: values[4],
                        checkpoint_type: values[5],
                        tool_name: values[6],
                        status: values[7],
                        content: values[8],
                        metadata_json: values[9],
                        tags_json: values[10],
                        payload_json: values[11],
                        created_at: values[12],
                    });
                    return { rows: [], rowCount: 1 };
                }
                if (text.includes("WITH RECURSIVE lineage")) {
                    return { rows: cpStore, rowCount: cpStore.length };
                }

                return { rows: [], rowCount: 0 };
            },
        };

        return { pool: new PostgresConnectionPool("postgres://mock:5432/db", 10, executor), queries };
    }

    it("initializes schema and passes health check", async () => {
        const { pool, queries } = createMockPool();
        assert.equal(await pool.connect(), true);
        assert.equal(pool.isConnected(), true);
        assert.ok(queries.some((q) => q.text.includes("CREATE TABLE IF NOT EXISTS circuit_breakers")));

        const health = await pool.checkHealth();
        assert.equal(health.healthy, true);
        assert.equal(health.backend, "postgres");
        assert.equal(health.connection_pooled, true);
    });

    it("executes parameterized SQL for circuit breakers and baselines", async () => {
        const { pool, queries } = createMockPool();
        const cbRepo = new PostgresCircuitBreakerRepository(pool);

        await cbRepo.upsert("stripe", { state: "OPEN", failure_count: 5, last_error: "502" });
        cbRepo.clearCache();
        const fetched = await cbRepo.get("stripe");
        assert.equal(fetched?.state, "OPEN");
        assert.equal(fetched?.last_error, "502");
        assert.ok(queries.some((q) => q.text.includes("ON CONFLICT (tenant_id, project_id, name)")));

        const baseRepo = new PostgresBaselineRepository(pool);
        await baseRepo.recordObservation("api.ms", 45);
        await baseRepo.upsert("api.ms", { ema_mean: 45, observation_count: 1, status: "learning" });
        baseRepo.clearCache();
        const b = await baseRepo.get("api.ms");
        assert.equal(b?.ema_mean, 45);
        assert.equal(await baseRepo.getObservationCount("api.ms"), 1);
    });

    it("executes recursive CTE lineage queries on PostgresCausalTraceRepository", async () => {
        const { pool, queries } = createMockPool();
        const traceRepo = new PostgresCausalTraceRepository(pool);

        await traceRepo.append("pg-sess", {
            id: "cp-1",
            checkpoint_type: "reasoning",
            content: "Root",
            created_at: "2026-01-01T00:00:00Z",
        });
        await traceRepo.append("pg-sess", {
            id: "cp-2",
            parent_checkpoint_id: "cp-1",
            checkpoint_type: "error",
            content: "Failed",
            created_at: "2026-01-01T00:01:00Z",
        });

        const lineage = await traceRepo.getLineageForFailures("pg-sess", ["cp-2"]);
        assert.equal(lineage.length, 2);
        assert.ok(queries.some((q) => q.text.includes("WITH RECURSIVE lineage")));
    });
});

