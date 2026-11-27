/**
 * AgentGuard MCP v3.1.2 — Tool: Adaptive Baseline Learning
 *
 * Implements online Exponential Moving Average (EMA) learning for agent metrics.
 * Learns normal baseline behavior from continuous observations in real time
 * with Winsorization outlier dampening (>4σ clamped), shadow-mode lifecycle,
 * and degraded baseline detection (high outlier poisoning or stale observations).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import {
    recordObservationAsync,
    getBaselineAsync,
    upsertBaselineAsync,
    resetBaselineAsync,
    getRecentObservationsAsync,
    getObservationCountAsync,
} from "../utils/metricStore.js";
import { safeNumericSchema, parseEnvInt } from "../utils/validation.js";
import type { BaselineStatus } from "../types/index.js";

const OUTLIER_SIGMA_FACTOR = 4.0;

export function getBaselineConfig() {
    return {
        DEFAULT_WINDOW_SIZE: parseEnvInt("EMA_WINDOW_SIZE", 20, 2, 1000),
        MIN_ACTIVE_SAMPLES: parseEnvInt("BASELINE_MIN_ACTIVE_SAMPLES", 50, 5, 10000),
        STALE_DAYS: parseEnvInt("BASELINE_STALE_DAYS", 14, 1, 3650),
    };
}

function isBaselineDegraded(params: {
    observation_count: number;
    winsorized_count: number;
    last_observed_at: string;
    staleDays: number;
}): { degraded: boolean; reason?: string } {
    if (params.observation_count >= 10) {
        const poisonRatio = params.winsorized_count / params.observation_count;
        if (poisonRatio > 0.3) {
            return {
                degraded: true,
                reason: `High outlier rate (${(poisonRatio * 100).toFixed(1)}% of observations winsorized) — baseline may be drifting or poisoned.`,
            };
        }
    }

    const lastMs = new Date(params.last_observed_at).getTime();
    if (!Number.isNaN(lastMs)) {
        const ageDays = (Date.now() - lastMs) / (24 * 60 * 60 * 1000);
        if (ageDays > params.staleDays) {
            return {
                degraded: true,
                reason: `Baseline is stale (${ageDays.toFixed(1)} days since last observation; threshold ${params.staleDays}d).`,
            };
        }
    }

    return { degraded: false };
}

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
                "Reaches 'active' status after reaching the active sample threshold (default: 50 observations).",
            inputSchema: {
                metric_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("Unique name for this metric (e.g. weather_api.response_time_ms)"),
                value: safeNumericSchema.describe("The observed numeric value to record"),
                window_size: z
                    .number()
                    .int()
                    .min(2)
                    .max(1000)
                    .optional()
                    .describe("Optional EMA smoothing window size when initializing a new metric (default: EMA_WINDOW_SIZE env or 20)"),
                context: z
                    .string()
                    .max(300)
                    .optional()
                    .describe("Optional context about this observation"),
            },
        },
        async ({ metric_name, value, window_size: requestedWindowSize, context }) => {
            try {
                const { DEFAULT_WINDOW_SIZE, MIN_ACTIVE_SAMPLES, STALE_DAYS } = getBaselineConfig();

                await recordObservationAsync(metric_name, value);

                const existing = await getBaselineAsync(metric_name);
                const window_size = existing?.window_size ?? requestedWindowSize ?? DEFAULT_WINDOW_SIZE;
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
                    ema_mean = value;
                    ema_variance = 0;
                    observation_count = 1;
                    first_observed_at = now;
                } else {
                    const oldMean = existing.ema_mean;
                    const oldVariance = existing.ema_variance;
                    const oldStdDev = Math.sqrt(oldVariance);
                    const effectiveStdDev = oldStdDev > 0 ? oldStdDev : Math.max(0.05 * Math.abs(oldMean), 1.0);

                    if (existing.observation_count >= 3) {
                        const diff = value - oldMean;
                        const thresholdDelta = OUTLIER_SIGMA_FACTOR * effectiveStdDev;
                        if (Math.abs(diff) > thresholdDelta) {
                            is_winsorized = true;
                            effective_value = oldMean + (diff > 0 ? 1 : -1) * thresholdDelta;
                            winsorized_count += 1;
                        }
                    }

                    ema_mean = alpha * effective_value + (1 - alpha) * oldMean;
                    ema_variance =
                        alpha * Math.pow(effective_value - oldMean, 2) +
                        (1 - alpha) * oldVariance;
                    observation_count = existing.observation_count + 1;
                    first_observed_at = existing.first_observed_at;
                }

                const degradation = isBaselineDegraded({
                    observation_count,
                    winsorized_count,
                    last_observed_at: now,
                    staleDays: STALE_DAYS,
                });

                const status: BaselineStatus = degradation.degraded
                    ? "degraded"
                    : observation_count >= MIN_ACTIVE_SAMPLES
                    ? "active"
                    : "learning";

                await upsertBaselineAsync(metric_name, {
                    ema_mean,
                    ema_variance,
                    observation_count,
                    status,
                    winsorized_count,
                    first_observed_at,
                    last_observed_at: now,
                    window_size,
                });

                const current_stddev = Math.sqrt(ema_variance);
                const confidence_percent = Number(
                    (Math.min(observation_count / MIN_ACTIVE_SAMPLES, 1.0) * 100).toFixed(2)
                );

                const message =
                    status === "degraded"
                        ? `Baseline marked degraded: ${degradation.reason}`
                        : status === "learning"
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
                    window_size,
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
                const { DEFAULT_WINDOW_SIZE, MIN_ACTIVE_SAMPLES, STALE_DAYS } = getBaselineConfig();
                const baseline = await getBaselineAsync(metric_name);

                if (!baseline || baseline.observation_count === 0) {
                    return buildResponse({
                        error: "NO_BASELINE_FOUND",
                        metric_name,
                        message: `No learned baseline found for metric "${metric_name}". Use record_observation first to begin learning.`,
                        hint: "Call record_observation with observed numeric values to build a baseline.",
                        timestamp: new Date().toISOString(),
                    });
                }

                const total_count = await getObservationCountAsync(metric_name);
                const effectiveCount = Math.max(total_count, baseline.observation_count);
                const mean = baseline.ema_mean;
                const variance = baseline.ema_variance;
                const stddev = Math.sqrt(variance);
                const window_size = baseline.window_size || DEFAULT_WINDOW_SIZE;

                const confidence_percent = Number(
                    (Math.min(effectiveCount / MIN_ACTIVE_SAMPLES, 1.0) * 100).toFixed(2)
                );

                const degradation = isBaselineDegraded({
                    observation_count: effectiveCount,
                    winsorized_count: baseline.winsorized_count ?? 0,
                    last_observed_at: baseline.last_observed_at,
                    staleDays: STALE_DAYS,
                });

                const status: BaselineStatus = degradation.degraded
                    ? "degraded"
                    : baseline.status ?? (effectiveCount >= MIN_ACTIVE_SAMPLES ? "active" : "learning");

                const recent_observations = include_recent_observations
                    ? (await getRecentObservationsAsync(metric_name, 10)).map((obs) => ({
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
                    observation_count: effectiveCount,
                    status,
                    learning_status: status,
                    ...(degradation.degraded ? { degradation_reason: degradation.reason } : {}),
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
                    ...(include_recent_observations && { recent_observations }),
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
                const existing = await getBaselineAsync(metric_name);

                if (!existing) {
                    return buildResponse({
                        metric_name,
                        reset: false,
                        message: `No baseline found for metric "${metric_name}" — nothing to reset.`,
                        timestamp: now,
                    });
                }

                const shouldDelete = hard_delete ?? true;
                await resetBaselineAsync(metric_name, shouldDelete);

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
