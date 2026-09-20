/**
 * AgentGuard MCP v2.1.0 — Hot Path Latency Benchmark Harness (.mjs)
 *
 * Verifies that pre-flight circuit breaker state queries (getCircuit) operate with
 * sub-millisecond p50, p95, and p99 latency under concurrent load using the L1 in-memory cache.
 */

import { getCircuit, upsertCircuit, clearCircuitCache } from "../dist/utils/circuitStore.js";
import { tenantContextStorage } from "../dist/utils/auth.js";

const CONCURRENCY = 10;
const TOTAL_ITERATIONS = 100_000;
const TEST_CIRCUIT = "hotpath_benchmark_circuit";

const mockTenant = {
    tenant_id: "bench-tenant",
    project_id: "bench-proj",
    env: "prod",
    rate_limit: 10000,
};

async function runBenchmark() {
    console.log("=================================================");
    console.log(" AgentGuard MCP Hot Path Latency Benchmark");
    console.log("=================================================");
    console.log(`- Total Queries : ${TOTAL_ITERATIONS.toLocaleString()}`);
    console.log(`- Concurrency   : ${CONCURRENCY} workers`);
    console.log("");

    tenantContextStorage.run(mockTenant, () => {
        clearCircuitCache();
        // Warm up circuit in database & L1 cache
        upsertCircuit(TEST_CIRCUIT, { state: "CLOSED", failure_count: 0 });
    });

    const latenciesNs = new BigInt64Array(TOTAL_ITERATIONS);
    const iterationsPerWorker = Math.floor(TOTAL_ITERATIONS / CONCURRENCY);

    const overallStart = performance.now();

    async function worker(workerId, startIndex) {
        return tenantContextStorage.run(mockTenant, async () => {
            for (let i = 0; i < iterationsPerWorker; i++) {
                const idx = startIndex + i;
                const start = process.hrtime.bigint();
                const c = getCircuit(TEST_CIRCUIT);
                const end = process.hrtime.bigint();
                latenciesNs[idx] = end - start;
                if (!c) throw new Error("Circuit lookup returned null during benchmark");
            }
        });
    }

    const workers = [];
    for (let w = 0; w < CONCURRENCY; w++) {
        workers.push(worker(w, w * iterationsPerWorker));
    }

    await Promise.all(workers);
    const totalDurationMs = performance.now() - overallStart;

    // Sort latencies to compute percentiles
    const sortedUs = Array.from(latenciesNs, (ns) => Number(ns) / 1000).sort((a, b) => a - b);

    const p50Us = sortedUs[Math.floor(sortedUs.length * 0.50)];
    const p95Us = sortedUs[Math.floor(sortedUs.length * 0.95)];
    const p99Us = sortedUs[Math.floor(sortedUs.length * 0.99)];
    const maxUs = sortedUs[sortedUs.length - 1];

    const qps = Math.round((TOTAL_ITERATIONS / totalDurationMs) * 1000);

    console.log(`⚡ Benchmark Completed in ${totalDurationMs.toFixed(2)} ms`);
    console.log(`🚀 Throughput       : ${qps.toLocaleString()} ops/sec`);
    console.log("");
    console.log("Latency Breakdown:");
    console.log(`  - p50 (Median)   : ${(p50Us / 1000).toFixed(5)} ms  (${p50Us.toFixed(2)} µs)`);
    console.log(`  - p95            : ${(p95Us / 1000).toFixed(5)} ms  (${p95Us.toFixed(2)} µs)`);
    console.log(`  - p99            : ${(p99Us / 1000).toFixed(5)} ms  (${p99Us.toFixed(2)} µs)`);
    console.log(`  - Max            : ${(maxUs / 1000).toFixed(5)} ms  (${maxUs.toFixed(2)} µs)`);
    console.log("");

    if (p99Us / 1000 < 1.0) {
        console.log("✅ PASS: p99 latency is SUB-MILLISECOND (< 1.0 ms)!");
        process.exit(0);
    } else {
        console.error("❌ FAIL: p99 latency exceeded 1.0 ms!");
        process.exit(1);
    }
}

runBenchmark().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});
