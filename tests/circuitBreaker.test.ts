/**
 * AgentGuard MCP — Unit Tests: Circuit Breaker State Machine & Env Config
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { circuitBreakerTools } from "../src/tools/circuitBreaker.js";
import { upsertCircuitAsync, getCircuitAsync } from "../src/utils/circuitStore.js";

describe("Circuit Breaker State Machine & Configuration", () => {
    const origThresh = process.env.CIRCUIT_FAILURE_THRESHOLD;
    const origCooldown = process.env.CIRCUIT_COOLDOWN_SECONDS;
    const origSuccessThresh = process.env.CIRCUIT_SUCCESS_THRESHOLD;
    const origHalfOpenTimeout = process.env.CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS;

    afterEach(() => {
        if (origThresh === undefined) delete process.env.CIRCUIT_FAILURE_THRESHOLD;
        else process.env.CIRCUIT_FAILURE_THRESHOLD = origThresh;
        if (origCooldown === undefined) delete process.env.CIRCUIT_COOLDOWN_SECONDS;
        else process.env.CIRCUIT_COOLDOWN_SECONDS = origCooldown;
        if (origSuccessThresh === undefined) delete process.env.CIRCUIT_SUCCESS_THRESHOLD;
        else process.env.CIRCUIT_SUCCESS_THRESHOLD = origSuccessThresh;
        if (origHalfOpenTimeout === undefined) delete process.env.CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS;
        else process.env.CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS = origHalfOpenTimeout;
    });

    function createToolCaller() {
        const handlers = new Map<string, (args: any) => Promise<any>>();
        const mockServer = {
            registerTool(name: string, _schema: any, fn: (args: any) => Promise<any>) {
                handlers.set(name, fn);
            },
        } as unknown as McpServer;
        circuitBreakerTools(mockServer);
        return async (name: string, args: any) => {
            const res = await handlers.get(name)!(args);
            return JSON.parse(res.content[0].text);
        };
    }

    it("reads CIRCUIT_FAILURE_THRESHOLD and transitions CLOSED -> OPEN -> HALF_OPEN -> CLOSED", async () => {
        process.env.CIRCUIT_FAILURE_THRESHOLD = "2";
        process.env.CIRCUIT_COOLDOWN_SECONDS = "10";
        const call = createToolCaller();
        const toolName = `cb_sm_${Date.now()}`;

        const r1 = await call("report_tool_result", {
            tool_name: toolName,
            success: false,
            error_message: "503 Service Unavailable",
            response_time_ms: 120,
        });
        assert.equal(r1.current_state, "CLOSED");
        assert.equal(r1.failure_threshold, 2);

        const r2 = await call("report_tool_result", {
            tool_name: toolName,
            success: false,
            error_message: "503 Service Unavailable",
            response_time_ms: 140,
        });
        assert.equal(r2.current_state, "OPEN");
        assert.equal(r2.action_taken, "circuit_opened");

        // Verify last_error & response_time_ms persisted
        const persisted = await getCircuitAsync(toolName);
        assert.equal(persisted?.last_error, "503 Service Unavailable");
        assert.equal(persisted?.last_response_time_ms, 140);

        // Simulate elapsed cooldown -> auto-transition to HALF_OPEN
        await upsertCircuitAsync(toolName, {
            opened_at: new Date(Date.now() - 15_000).toISOString(),
        });
        const stateHalf = await call("get_circuit_state", { tool_name: toolName, check_cooldown: true });
        assert.equal(stateHalf.state, "HALF_OPEN");

        // Probe success -> CLOSED
        const r3 = await call("report_tool_result", { tool_name: toolName, success: true });
        assert.equal(r3.current_state, "CLOSED");
        assert.equal(r3.action_taken, "circuit_closed");
    });

    it("reopens stale HALF_OPEN probes after CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS", async () => {
        process.env.CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS = "5";
        const call = createToolCaller();
        const toolName = `cb_stale_ho_${Date.now()}`;

        await upsertCircuitAsync(toolName, {
            state: "HALF_OPEN",
            failure_count: 5,
            success_count: 3,
            half_opened_at: new Date(Date.now() - 20_000).toISOString(),
        });

        const state = await call("get_circuit_state", { tool_name: toolName, check_cooldown: true });
        assert.equal(state.state, "OPEN");
    });

    it("preserves historical success_count on manual reset by default", async () => {
        const call = createToolCaller();
        const toolName = `cb_reset_${Date.now()}`;

        await upsertCircuitAsync(toolName, {
            state: "OPEN",
            failure_count: 5,
            success_count: 42,
        });

        const resetRes = await call("reset_circuit", { tool_name: toolName, reason: "Upstream recovered" });
        assert.equal(resetRes.reset, true);
        assert.equal(resetRes.current_state, "CLOSED");
        assert.equal(resetRes.success_count_preserved, 42);
    });

    it("requires CIRCUIT_SUCCESS_THRESHOLD consecutive successes in HALF_OPEN even with prior success_count", async () => {
        process.env.CIRCUIT_SUCCESS_THRESHOLD = "3";
        const call = createToolCaller();
        const toolName = `cb_ho_multi_${Date.now()}`;

        await upsertCircuitAsync(toolName, {
            state: "HALF_OPEN",
            failure_count: 5,
            success_count: 100,
            half_open_success_count: 0,
            half_opened_at: new Date().toISOString(),
        });

        const s1 = await call("report_tool_result", { tool_name: toolName, success: true });
        assert.equal(s1.current_state, "HALF_OPEN");
        assert.equal(s1.action_taken, "half_open_probe_recorded");

        const s2 = await call("report_tool_result", { tool_name: toolName, success: true });
        assert.equal(s2.current_state, "HALF_OPEN");

        const s3 = await call("report_tool_result", { tool_name: toolName, success: true });
        assert.equal(s3.current_state, "CLOSED");
        assert.equal(s3.action_taken, "circuit_closed");
    });
});

