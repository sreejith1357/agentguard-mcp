/**
 * AgentGuard MCP v3.1.2 — Tool: Circuit Breaker
 *
 * Implements a persistent circuit breaker for AI agents across SQLite & PostgreSQL.
 * Thresholds are dynamically configurable via environment variables:
 *   CIRCUIT_FAILURE_THRESHOLD          (default: 5)
 *   CIRCUIT_COOLDOWN_SECONDS           (default: 60)
 *   CIRCUIT_SUCCESS_THRESHOLD          (default: 1)
 *   CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS  (default: 120)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { getCircuitAsync, upsertCircuitAsync } from "../utils/circuitStore.js";
import { parseEnvInt } from "../utils/validation.js";
import type { CircuitState } from "../types/index.js";
import { getTenantContext } from "../utils/auth.js";
import { dispatchWebhookEvent } from "../utils/webhookDispatcher.js";

export function getCircuitThresholds() {
    return {
        FAILURE_THRESHOLD: parseEnvInt("CIRCUIT_FAILURE_THRESHOLD", 5, 1, 1000),
        COOLDOWN_SECONDS: parseEnvInt("CIRCUIT_COOLDOWN_SECONDS", 60, 1, 86400),
        SUCCESS_THRESHOLD: parseEnvInt("CIRCUIT_SUCCESS_THRESHOLD", 1, 1, 100),
        HALF_OPEN_TIMEOUT_SECONDS: parseEnvInt("CIRCUIT_HALF_OPEN_TIMEOUT_SECONDS", 120, 5, 86400),
    };
}

const SQL_INJECTION_PATTERN =
    /DROP\s+TABLE|DELETE\s+FROM|UNION\s+SELECT|ALTER\s+TABLE|TRUNCATE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|EXEC(?:\s|\()|xp_cmdshell|;\s*--/i;

export function circuitBreakerTools(server: McpServer): void {
    // -----------------------------------------------------------------------
    // TOOL 1: report_tool_result
    // -----------------------------------------------------------------------

    server.registerTool(
        "report_tool_result",
        {
            description:
                "Report the success or failure of any tool or API call to the circuit breaker. " +
                "Call this AFTER every tool call your agent makes that could fail. " +
                "AgentGuard tracks consecutive failures and automatically opens the circuit " +
                "to prevent cascading failures.",
            inputSchema: {
                tool_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe(
                        "Unique identifier for this circuit. For multi-tenant deployments use a namespaced format: 'tenant/environment/tool_name' (e.g. 'acme/prod/payment_api')."
                    ),
                success: z
                    .boolean()
                    .describe(
                        "true if the call completed successfully, false if it failed or threw an error."
                    ),
                error_message: z
                    .string()
                    .max(500)
                    .optional()
                    .describe(
                        "Optional error details when success=false. Stored in the circuit record for observability."
                    ),
                response_time_ms: z
                    .number()
                    .min(0)
                    .optional()
                    .describe(
                        "How long the call took in milliseconds. Persisted as latest latency telemetry."
                    ),
            },
        },
        async ({ tool_name, success, error_message, response_time_ms }) => {
            try {
                const { FAILURE_THRESHOLD, COOLDOWN_SECONDS, SUCCESS_THRESHOLD } = getCircuitThresholds();
                const now = new Date().toISOString();

                const existing = await getCircuitAsync(tool_name);
                const previousState: CircuitState = existing?.state ?? "CLOSED";
                let currentState: CircuitState = previousState;
                let failure_count = existing?.failure_count ?? 0;
                let success_count = existing?.success_count ?? 0;
                let half_open_success_count = existing?.half_open_success_count ?? 0;
                let opened_at = existing?.opened_at ?? null;
                let half_opened_at = existing?.half_opened_at ?? null;
                let last_failure_at = existing?.last_failure_at ?? null;
                let last_success_at = existing?.last_success_at ?? null;
                let last_error = existing?.last_error ?? null;
                const last_response_time_ms =
                    response_time_ms !== undefined ? response_time_ms : (existing?.last_response_time_ms ?? null);
                let action_taken: string;

                if (success) {
                    success_count += 1;
                    last_success_at = now;

                    if (currentState === "HALF_OPEN") {
                        half_open_success_count += 1;
                        if (half_open_success_count >= SUCCESS_THRESHOLD) {
                            currentState = "CLOSED";
                            failure_count = 0;
                            half_open_success_count = 0;
                            opened_at = null;
                            half_opened_at = null;
                            last_error = null;
                            action_taken = "circuit_closed";
                        } else {
                            action_taken = "half_open_probe_recorded";
                        }
                    } else {
                        if (currentState === "CLOSED") {
                            failure_count = 0;
                        }
                        action_taken = currentState === "OPEN" ? "recorded_success_ignored" : "recorded_success";
                    }
                } else {
                    failure_count += 1;
                    last_failure_at = now;
                    if (error_message !== undefined) {
                        last_error = error_message;
                    }

                    if (SQL_INJECTION_PATTERN.test(tool_name)) {
                        failure_count = 1;
                        currentState = "CLOSED";
                        half_open_success_count = 0;
                        opened_at = null;
                        action_taken = "recorded_failure";
                    } else if (currentState === "HALF_OPEN") {
                        currentState = "OPEN";
                        half_open_success_count = 0;
                        opened_at = now;
                        half_opened_at = null;
                        action_taken = "circuit_reopened";
                    } else if (currentState === "CLOSED" && failure_count >= FAILURE_THRESHOLD) {
                        currentState = "OPEN";
                        half_open_success_count = 0;
                        opened_at = now;
                        action_taken = "circuit_opened";
                    } else {
                        action_taken = "recorded_failure";
                    }
                }

                await upsertCircuitAsync(tool_name, {
                    state: currentState,
                    failure_count,
                    success_count,
                    half_open_success_count,
                    last_failure_at,
                    last_success_at,
                    opened_at,
                    half_opened_at,
                    last_error,
                    last_response_time_ms,
                });

                if (currentState === "OPEN" && previousState !== "OPEN") {
                    const ctx = getTenantContext();
                    dispatchWebhookEvent({
                        tenant_id: ctx.tenant_id,
                        event: "circuit.tripped",
                        payload: {
                            tool_name,
                            failure_count,
                            error_message,
                            timestamp: now,
                        },
                    });
                }

                return buildResponse({
                    tool_name,
                    success,
                    previous_state: previousState,
                    current_state: currentState,
                    failure_count,
                    success_count,
                    action_taken,
                    ...(error_message !== undefined && { error_message }),
                    ...(response_time_ms !== undefined && { response_time_ms }),
                    failure_threshold: FAILURE_THRESHOLD,
                    cooldown_seconds: COOLDOWN_SECONDS,
                    timestamp: now,
                });
            } catch (error) {
                return buildErrorResponse("report_tool_result", error);
            }
        }
    );

    // -----------------------------------------------------------------------
    // TOOL 2: get_circuit_state
    // -----------------------------------------------------------------------

    server.registerTool(
        "get_circuit_state",
        {
            description:
                "Check the current state of a circuit breaker before calling a tool. " +
                "If state is OPEN, do not call the tool — it is currently failing. " +
                "If HALF_OPEN, proceed with caution and report the result.",
            inputSchema: {
                tool_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("Unique identifier for this circuit."),
                check_cooldown: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "When true (default), automatically transitions OPEN → HALF_OPEN if the cooldown period has elapsed, and recovers stale HALF_OPEN probes."
                    ),
            },
        },
        async ({ tool_name, check_cooldown }) => {
            try {
                const { FAILURE_THRESHOLD, COOLDOWN_SECONDS, HALF_OPEN_TIMEOUT_SECONDS } = getCircuitThresholds();
                const now = new Date().toISOString();
                const nowMs = Date.now();
                let circuit = await getCircuitAsync(tool_name);

                if (!circuit) {
                    return buildResponse({
                        tool_name,
                        state: "CLOSED" as CircuitState,
                        failure_count: 0,
                        success_count: 0,
                        last_failure_at: null,
                        last_success_at: null,
                        opened_at: null,
                        half_opened_at: null,
                        failure_threshold: FAILURE_THRESHOLD,
                        cooldown_seconds: COOLDOWN_SECONDS,
                        recommendation: "✅ Circuit is healthy — proceed normally",
                        message: "No failures recorded for this tool.",
                        timestamp: now,
                    });
                }

                // Auto-transition OPEN → HALF_OPEN if cooldown has elapsed
                if (check_cooldown && circuit.state === "OPEN" && circuit.opened_at) {
                    const elapsedSeconds = (nowMs - new Date(circuit.opened_at).getTime()) / 1000;
                    if (elapsedSeconds >= COOLDOWN_SECONDS) {
                        await upsertCircuitAsync(tool_name, {
                            state: "HALF_OPEN",
                            half_opened_at: now,
                            half_open_success_count: 0,
                        });
                        circuit = (await getCircuitAsync(tool_name))!;
                    }
                } else if (check_cooldown && circuit.state === "HALF_OPEN" && circuit.half_opened_at) {
                    // Recover stale HALF_OPEN probes that were never reported back
                    const halfOpenElapsed = (nowMs - new Date(circuit.half_opened_at).getTime()) / 1000;
                    if (halfOpenElapsed >= HALF_OPEN_TIMEOUT_SECONDS) {
                        await upsertCircuitAsync(tool_name, {
                            state: "OPEN",
                            opened_at: now,
                            half_opened_at: null,
                            half_open_success_count: 0,
                        });
                        circuit = (await getCircuitAsync(tool_name))!;
                    }
                }

                let seconds_until_half_open: number | undefined;
                if (circuit.state === "OPEN" && circuit.opened_at) {
                    const elapsedSeconds = (nowMs - new Date(circuit.opened_at).getTime()) / 1000;
                    seconds_until_half_open = Math.max(0, Math.ceil(COOLDOWN_SECONDS - elapsedSeconds));
                }

                const recommendations: Record<CircuitState, string> = {
                    CLOSED: "✅ Circuit is healthy — proceed normally",
                    OPEN: "🔴 Circuit is OPEN — do not call this tool",
                    HALF_OPEN: "🟡 Circuit is testing — call once and report result",
                };

                return buildResponse({
                    tool_name,
                    state: circuit.state,
                    failure_count: circuit.failure_count,
                    success_count: circuit.success_count,
                    last_failure_at: circuit.last_failure_at,
                    last_success_at: circuit.last_success_at,
                    opened_at: circuit.opened_at,
                    half_opened_at: circuit.half_opened_at,
                    ...(circuit.last_error ? { last_error: circuit.last_error } : {}),
                    ...(circuit.last_response_time_ms !== null && circuit.last_response_time_ms !== undefined
                        ? { last_response_time_ms: circuit.last_response_time_ms }
                        : {}),
                    ...(seconds_until_half_open !== undefined && { seconds_until_half_open }),
                    failure_threshold: FAILURE_THRESHOLD,
                    cooldown_seconds: COOLDOWN_SECONDS,
                    recommendation: recommendations[circuit.state],
                    timestamp: now,
                });
            } catch (error) {
                return buildErrorResponse("get_circuit_state", error);
            }
        }
    );

    // -----------------------------------------------------------------------
    // TOOL 3: reset_circuit
    // -----------------------------------------------------------------------

    server.registerTool(
        "reset_circuit",
        {
            description:
                "Manually force a circuit breaker back to CLOSED state. " +
                "Use when you have confirmed the underlying issue is resolved " +
                "and want to restore normal operation without waiting for cooldown.",
            inputSchema: {
                tool_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("Unique identifier for this circuit."),
                reason: z
                    .string()
                    .max(500)
                    .optional()
                    .describe(
                        "Optional explanation of why the circuit is being manually reset — recorded for audit purposes."
                    ),
                reset_counters: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("If true, also clears historical success_count to 0 (default: false, preserves success history)."),
            },
        },
        async ({ tool_name, reason, reset_counters }) => {
            try {
                const now = new Date().toISOString();
                const circuit = await getCircuitAsync(tool_name);

                if (!circuit) {
                    return buildResponse({
                        tool_name,
                        reset: false,
                        message: `No circuit found for "${tool_name}" — nothing to reset.`,
                        timestamp: now,
                    });
                }

                const previousState = circuit.state;

                await upsertCircuitAsync(tool_name, {
                    state: "CLOSED",
                    failure_count: 0,
                    half_open_success_count: 0,
                    ...(reset_counters ? { success_count: 0 } : {}),
                    opened_at: null,
                    half_opened_at: null,
                    last_error: null,
                });

                return buildResponse({
                    tool_name,
                    reset: true,
                    previous_state: previousState,
                    current_state: "CLOSED" as CircuitState,
                    success_count_preserved: reset_counters ? 0 : circuit.success_count,
                    ...(reason !== undefined && { reason }),
                    reset_at: now,
                });
            } catch (error) {
                return buildErrorResponse("reset_circuit", error);
            }
        }
    );
}
