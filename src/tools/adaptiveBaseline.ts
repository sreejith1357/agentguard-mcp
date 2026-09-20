/**
 * AgentGuard MCP v2.0.0 — Tool: Adaptive Baseline Learning
 *
 * Implements online Exponential Moving Average (EMA) learning for agent metrics.
 * Learns normal baseline behavior from continuous observations in real time
 * without external ML dependencies.
 *
 * Formulas used:
 *   α = 2 / (window_size + 1)   (default window_size = 20)
 *   EMA_new = α × value + (1 - α) × EMA_old
 *   Variance_new = α × (value - EMA_old)² + (1 - α) × Variance_old
 *   StdDev = √Variance_new
 *   Confidence % = min(observation_count / window_size, 1.0) × 100
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import {
    recordObservation,
    getBaseline,
    upsertBaseline,
    resetBaseline,
    getRecentObservations,
    getObservationCount,
} from "../utils/metricStore.js";
import type { BaselineStatus } from "../types/index.js";

const OUTLIER_SIGMA_FACTOR = 4.0;
const MIN_ACTIVE_SAMPLES = 50;
const MAX_SAFE_VALUE = 1e15;

const safeNumericSchema = z
    .number()
    .finite()
    .refine(
        (val) => !isNaN(val) && isFinite(val) && Math.abs(val) <= MAX_SAFE_VALUE,
        {
            message: `Value must be a finite double-precision number within range [-${MAX_SAFE_VALUE}, ${MAX_SAFE_VALUE}]`,
        }
    );

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function adaptiveBaselineTools(server: McpServer): void {
    // -----------------------------------------------------------------------
    // TOOL 1: record_observation
    // -----------------------------------------------------------------------

    server.registerTool(
        "record_observation",
        {
            description:
                "Record a real observed metric value so AgentGuard can learn normal baseline behavior over time. " +
                "Includes Winsorization outlier dampening (>4σ clamped) and a shadow mode lifecycle. " +
                "Reaches 'active' status after 20+ observations. In active status, detect_anomaly uses it automatically.",
            inputSchema: {
                metric_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe(
                        "Unique name for this metric (e.g. weather_api.response_time_ms)"
                    ),
                value: safeNumericSchema.describe("The observed numeric value to record"),
                context: z
                    .string()
                    .max(300)
                    .optional()
                    .describe("Optional context about this observation"),
            },
        },
        async ({ metric_name, value, context }) => {
            try {
                // 1. Record raw observation in time-series table
                recordObservation(metric_name, value);

                // 2. Load existing baseline row
                const existing = getBaseline(metric_name);
                const window_size = existing?.window_size ?? 20;
                const alpha = 2 / (window_size + 1);

                let ema_mean: number;
                let ema_variance: number;
                let observation_count: number;
                let first_observed_at: string;
                let winsorized_count = existing?.winsorized_count ?? 0;
                let is_winsorized = false;
                let effective_value = value;
                const now = new Date().toISOString();

                if (!existing || existing.observation_count === 0) {
                    // First observation
                    ema_mean = value;
                    ema_variance = 0;
                    observation_count = 1;
                    first_observed_at = now;
                } else {
                    const oldMean = existing.ema_mean;
                    const oldVariance = existing.ema_variance;
                    const oldStdDev = Math.sqrt(oldVariance);
                    const effectiveStdDev = oldStdDev > 0 ? oldStdDev : Math.max(0.05 * Math.abs(oldMean), 1.0);

                    // Outlier dampening (Winsorization): clamp value if > 4 standard deviations
                    if (existing.observation_count >= 3) {
                        const diff = value - oldMean;
                        const thresholdDelta = OUTLIER_SIGMA_FACTOR * effectiveStdDev;
                        if (Math.abs(diff) > thresholdDelta) {
                            is_winsorized = true;
                            effective_value =
                                oldMean + (diff > 0 ? 1 : -1) * thresholdDelta;
                            winsorized_count += 1;
                        }
                    }

                    // Update existing EMA and Variance using effective (dampened) value
                    ema_mean = alpha * effective_value + (1 - alpha) * oldMean;
                    ema_variance =
                        alpha * Math.pow(effective_value - oldMean, 2) +
                        (1 - alpha) * oldVariance;
                    observation_count = existing.observation_count + 1;
                    first_observed_at = existing.first_observed_at;
                }

                // Determine baseline status lifecycle: 'learning' -> 'active' (>= 50 samples)
                const status: BaselineStatus =
                    observation_count >= MIN_ACTIVE_SAMPLES ? "active" : "learning";

                // 3. Persist updated baseline statistics to SQLite
                upsertBaseline(metric_name, {
                    ema_mean,
                    ema_variance,
                    observation_count,
                    status,
                    winsorized_count,
                    first_observed_at,
                    last_observed_at: now,
                    window_size,
                });

                // 4. Calculate response metrics
                const current_stddev = Math.sqrt(ema_variance);
                const confidence_percent = Number(
                    (Math.min(observation_count / MIN_ACTIVE_SAMPLES, 1.0) * 100).toFixed(2)
                );

                const message =
                    status === "learning"
                        ? `Recorded observation ${observation_count}/${MIN_ACTIVE_SAMPLES} (shadow mode). Need ${
                              MIN_ACTIVE_SAMPLES - observation_count
                          } more for active status.`
                        : `Baseline is active after ${observation_count} observations.`;

                return buildResponse({
                    metric_name,
                    value_recorded: value,
                    effective_value_used: effective_value,
                    is_winsorized,
                    winsorized_count,
                    observation_count,
                    current_mean: Number(ema_mean.toFixed(4)),
                    current_stddev: Number(current_stddev.toFixed(4)),
                    confidence_percent,
                    status,
                    learning_status: status,
                    message,
                    ...(context && { context }),
                    timestamp: now,
                });
            } catch (error) {
                return buildErrorResponse("record_observation", error);
            }
        }
    );

    // -----------------------------------------------------------------------
    // TOOL 2: get_learned_baseline
    // -----------------------------------------------------------------------

    server.registerTool(
        "get_learned_baseline",
        {
            description:
                "Retrieve learned baseline statistics and status for a metric. " +
                "Includes shadow mode status ('learning' | 'active' | 'degraded') and winsorization statistics.",
            inputSchema: {
                metric_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("The metric to retrieve learned baseline for"),
                include_recent_observations: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include last 10 raw observations in response"),
            },
        },
        async ({ metric_name, include_recent_observations }) => {
            try {
                const baseline = getBaseline(metric_name);

                if (!baseline || baseline.observation_count === 0) {
                    return buildResponse({
                        error: "NO_BASELINE_FOUND",
                        metric_name,
                        message: `No learned baseline found for metric "${metric_name}". Use record_observation first to begin learning.`,
                        hint: "Call record_observation with observed numeric values to build a baseline.",
                        timestamp: new Date().toISOString(),
                    });
                }

                const total_count = getObservationCount(metric_name);
                const mean = baseline.ema_mean;
                const variance = baseline.ema_variance;
                const stddev = Math.sqrt(variance);
                const window_size = baseline.window_size || 20;

                const confidence_percent = Number(
                    (Math.min(total_count / MIN_ACTIVE_SAMPLES, 1.0) * 100).toFixed(2)
                );
                const status: BaselineStatus = baseline.status ?? (total_count >= MIN_ACTIVE_SAMPLES ? "active" : "learning");

                const recent_observations = include_recent_observations
                    ? getRecentObservations(metric_name, 10).map((obs) => ({
                          id: obs.id,
                          value: obs.value,
                          recorded_at: obs.recorded_at,
                      }))
                    : undefined;

                return buildResponse({
                    metric_name,
                    mean: Number(mean.toFixed(4)),
                    stddev: Number(stddev.toFixed(4)),
                    variance: Number(variance.toFixed(6)),
                    observation_count: total_count,
                    status,
                    learning_status: status,
                    winsorized_count: baseline.winsorized_count ?? 0,
                    confidence_percent,
                    active_threshold_samples: MIN_ACTIVE_SAMPLES,
                    first_observed_at: baseline.first_observed_at,
                    last_observed_at: baseline.last_observed_at,
                    window_size,
                    anomaly_thresholds: {
                        low_1sigma: Number((mean - 1 * stddev).toFixed(4)),
                        high_1sigma: Number((mean + 1 * stddev).toFixed(4)),
                        low_2sigma: Number((mean - 2 * stddev).toFixed(4)),
                        high_2sigma: Number((mean + 2 * stddev).toFixed(4)),
                        low_3sigma: Number((mean - 3 * stddev).toFixed(4)),
                        high_3sigma: Number((mean + 3 * stddev).toFixed(4)),
                    },
                    ...(include_recent_observations && {
                        recent_observations,
                    }),
                    timestamp: new Date().toISOString(),
                });
            } catch (error) {
                return buildErrorResponse("get_learned_baseline", error);
            }
        }
    );

    // -----------------------------------------------------------------------
    // TOOL 3: reset_baseline
    // -----------------------------------------------------------------------

    server.registerTool(
        "reset_baseline",
        {
            description:
                "Administrative tool to wipe poisoned metric data or reset a learned baseline. " +
                "Allows tenant administrators to clear poisoned metrics and restore baseline to learning state.",
            inputSchema: {
                metric_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("The metric key to reset or delete"),
                hard_delete: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "When true, permanently deletes the baseline record and observation history. When false, resets statistics to 0 and returns to learning status."
                    ),
                reason: z
                    .string()
                    .max(500)
                    .optional()
                    .describe("Optional audit reason for resetting the baseline"),
            },
        },
        async ({ metric_name, hard_delete, reason }) => {
            try {
                const now = new Date().toISOString();
                const existing = getBaseline(metric_name);

                if (!existing) {
                    return buildResponse({
                        metric_name,
                        reset: false,
                        message: `No baseline found for metric "${metric_name}" — nothing to reset.`,
                        timestamp: now,
                    });
                }

                const shouldDelete = hard_delete ?? true;
                resetBaseline(metric_name, shouldDelete);

                return buildResponse({
                    metric_name,
                    reset: true,
                    hard_delete: shouldDelete,
                    status: shouldDelete ? "deleted" : "learning",
                    ...(reason !== undefined && { reason }),
                    message: shouldDelete
                        ? `Permanently deleted baseline and observation history for "${metric_name}".`
                        : `Reset baseline for "${metric_name}" back to learning status.`,
                    timestamp: now,
                });
            } catch (error) {
                return buildErrorResponse("reset_baseline", error);
            }
        }
    );
}
