/**
 * AgentGuard MCP v2.0.0 — Tool: Circuit Breaker
 *
 * Implements a persistent, SQLite-backed circuit breaker for AI agents.
 * Agents call report_tool_result after every tool call to track failures.
 * The circuit automatically opens after consecutive failures, preventing
 * cascading failures downstream.
 *
 * State machine:
 *   CLOSED     — normal operation; failures are counted
 *   OPEN       — tool is failing; calls should be skipped
 *   HALF_OPEN  — cooldown elapsed; one test call allowed
 *
 * Thresholds (adjust via constants below):
 *   FAILURE_THRESHOLD = 5   consecutive failures before CLOSED → OPEN
 *   COOLDOWN_SECONDS  = 60  seconds before OPEN → HALF_OPEN auto-transition
 *   SUCCESS_THRESHOLD = 1   successes in HALF_OPEN before → CLOSED
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import {
    getCircuit,
    upsertCircuit,
    deleteCircuit,
} from "../utils/circuitStore.js";
import type { CircuitState } from "../types/index.js";

// ---------------------------------------------------------------------------
// State machine constants
// ---------------------------------------------------------------------------

const FAILURE_THRESHOLD = 5;  // consecutive failures before CLOSED → OPEN
const COOLDOWN_SECONDS  = 60; // seconds to wait before OPEN → HALF_OPEN
const SUCCESS_THRESHOLD = 1;  // successes in HALF_OPEN before → CLOSED

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

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
                        "Unique identifier for the tool or endpoint being tracked (e.g. 'stripe_charge', 'openai_completions')."
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
                        "How long the call took in milliseconds. Informational — not used in state transitions."
                    ),
            },
        },
        async ({ tool_name, success, error_message, response_time_ms }) => {
            try {
                const now = new Date().toISOString();

                // Load current state (or initialise to CLOSED defaults)
                const existing = getCircuit(tool_name);
                const previousState: CircuitState = existing?.state ?? "CLOSED";
                let currentState: CircuitState   = previousState;
                let failure_count = existing?.failure_count ?? 0;
                let success_count = existing?.success_count ?? 0;
                let opened_at     = existing?.opened_at ?? null;
                let half_opened_at = existing?.half_opened_at ?? null;
                let last_failure_at = existing?.last_failure_at ?? null;
                let last_success_at = existing?.last_success_at ?? null;
                let action_taken: string;

                if (success) {
                    success_count += 1;
                    last_success_at = now;

                    if (currentState === "HALF_OPEN") {
                        // One success in HALF_OPEN → fully CLOSED
                        currentState  = "CLOSED";
                        failure_count = 0;
                        opened_at     = null;
                        half_opened_at = null;
                        action_taken  = "circuit_closed";
                    } else {
                        // CLOSED success — reset consecutive failure streak
                        if (currentState === "CLOSED") {
                            failure_count = 0;
                        }
                        action_taken = "recorded_success";
                    }
                } else {
                    // Failure path
                    failure_count  += 1;
                    last_failure_at = now;

                    if (currentState === "HALF_OPEN") {
                        // Any failure in HALF_OPEN → reopen the circuit
                        currentState   = "OPEN";
                        opened_at      = now;
                        half_opened_at = null;
                        action_taken   = "circuit_reopened";
                    } else if (currentState === "CLOSED" && failure_count >= FAILURE_THRESHOLD) {
                        // Hit the threshold → trip open
                        currentState = "OPEN";
                        opened_at    = now;
                        action_taken = "circuit_opened";
                    } else {
                        action_taken = "recorded_failure";
                    }
                }

                upsertCircuit(tool_name, {
                    state:          currentState,
                    failure_count,
                    success_count,
                    last_failure_at,
                    last_success_at,
                    opened_at,
                    half_opened_at,
                });

                return buildResponse({
                    tool_name,
                    success,
                    previous_state:    previousState,
                    current_state:     currentState,
                    failure_count,
                    success_count,
                    action_taken,
                    ...(error_message    !== undefined && { error_message }),
                    ...(response_time_ms !== undefined && { response_time_ms }),
                    failure_threshold:  FAILURE_THRESHOLD,
                    cooldown_seconds:   COOLDOWN_SECONDS,
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
                    .describe(
                        "The tool or endpoint to check (must match the name used in report_tool_result)."
                    ),
                check_cooldown: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "When true (default), automatically transitions OPEN → HALF_OPEN if the cooldown period has elapsed."
                    ),
            },
        },
        async ({ tool_name, check_cooldown }) => {
            try {
                const now       = new Date().toISOString();
                const nowMs     = Date.now();
                let circuit = getCircuit(tool_name);

                // No record at all — report pristine CLOSED
                if (!circuit) {
                    return buildResponse({
                        tool_name,
                        state:          "CLOSED" as CircuitState,
                        failure_count:  0,
                        success_count:  0,
                        last_failure_at: null,
                        last_success_at: null,
                        opened_at:      null,
                        half_opened_at: null,
                        recommendation: "✅ Circuit is healthy — proceed normally",
                        message:        "No failures recorded for this tool.",
                        timestamp: now,
                    });
                }

                // Auto-transition OPEN → HALF_OPEN if cooldown has elapsed
                if (check_cooldown && circuit.state === "OPEN" && circuit.opened_at) {
                    const elapsedSeconds =
                        (nowMs - new Date(circuit.opened_at).getTime()) / 1000;

                    if (elapsedSeconds >= COOLDOWN_SECONDS) {
                        upsertCircuit(tool_name, {
                            state:          "HALF_OPEN",
                            half_opened_at: now,
                        });
                        circuit = getCircuit(tool_name)!;
                    }
                }

                // Calculate seconds remaining until HALF_OPEN (only for OPEN circuits)
                let seconds_until_half_open: number | undefined;
                if (circuit.state === "OPEN" && circuit.opened_at) {
                    const elapsedSeconds =
                        (nowMs - new Date(circuit.opened_at).getTime()) / 1000;
                    const remaining = Math.ceil(COOLDOWN_SECONDS - elapsedSeconds);
                    seconds_until_half_open = Math.max(0, remaining);
                }

                // State-based recommendation
                const recommendations: Record<CircuitState, string> = {
                    CLOSED:    "✅ Circuit is healthy — proceed normally",
                    OPEN:      "🔴 Circuit is OPEN — do not call this tool",
                    HALF_OPEN: "🟡 Circuit is testing — call once and report result",
                };

                return buildResponse({
                    tool_name,
                    state:           circuit.state,
                    failure_count:   circuit.failure_count,
                    success_count:   circuit.success_count,
                    last_failure_at: circuit.last_failure_at,
                    last_success_at: circuit.last_success_at,
                    opened_at:       circuit.opened_at,
                    half_opened_at:  circuit.half_opened_at,
                    ...(seconds_until_half_open !== undefined && { seconds_until_half_open }),
                    failure_threshold:  FAILURE_THRESHOLD,
                    cooldown_seconds:   COOLDOWN_SECONDS,
                    recommendation:  recommendations[circuit.state],
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
                    .describe(
                        "The circuit breaker to reset (must match the name used in report_tool_result)."
                    ),
                reason: z
                    .string()
                    .max(500)
                    .optional()
                    .describe(
                        "Optional explanation of why the circuit is being manually reset — recorded for audit purposes."
                    ),
            },
        },
        async ({ tool_name, reason }) => {
            try {
                const now     = new Date().toISOString();
                const circuit = getCircuit(tool_name);

                if (!circuit) {
                    return buildResponse({
                        tool_name,
                        reset:   false,
                        message: `No circuit found for "${tool_name}" — nothing to reset.`,
                        timestamp: now,
                    });
                }

                const previousState = circuit.state;

                upsertCircuit(tool_name, {
                    state:          "CLOSED",
                    failure_count:  0,
                    success_count:  0,
                    opened_at:      null,
                    half_opened_at: null,
                });

                return buildResponse({
                    tool_name,
                    reset:          true,
                    previous_state: previousState,
                    current_state:  "CLOSED" as CircuitState,
                    ...(reason !== undefined && { reason }),
                    reset_at: now,
                });
            } catch (error) {
                return buildErrorResponse("reset_circuit", error);
            }
        }
    );
}
