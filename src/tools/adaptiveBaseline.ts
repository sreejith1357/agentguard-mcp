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
    getRecentObservations,
    getObservationCount,
} from "../utils/metricStore.js";

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
                "Record a real observed metric value so AgentGuard can learn what normal looks like over time. " +
                "After 20+ observations the baseline becomes statistically meaningful. " +
                "detect_anomaly will automatically use learned baselines — no manual baseline needed. " +
                "confidence_percent represents learning progress: min(observation_count / window_size, 1.0) × 100. " +
                "At 100% the baseline has reached the configured learning threshold. This is not a statistical confidence interval.",
            inputSchema: {
                metric_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe(
                        "Unique name for this metric. Use consistent naming: tool_name.metric e.g. weather_api.response_time_ms"
                    ),
                value: z
                    .number()
                    .finite()
                    .describe("The observed numeric value to record"),
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
                const now = new Date().toISOString();

                if (!existing || existing.observation_count === 0) {
                    // First observation
                    ema_mean = value;
                    ema_variance = 0;
                    observation_count = 1;
                    first_observed_at = now;
                } else {
                    // Update existing EMA and Variance using online formula
                    const oldMean = existing.ema_mean;
                    const oldVariance = existing.ema_variance;

                    ema_mean = alpha * value + (1 - alpha) * oldMean;
                    ema_variance =
                        alpha * Math.pow(value - oldMean, 2) +
                        (1 - alpha) * oldVariance;
                    observation_count = existing.observation_count + 1;
                    first_observed_at = existing.first_observed_at;
                }

                // 3. Persist updated baseline statistics to SQLite
                upsertBaseline(metric_name, {
                    ema_mean,
                    ema_variance,
                    observation_count,
                    first_observed_at,
                    last_observed_at: now,
                    window_size,
                });

                // 4. Calculate response metrics
                const current_stddev = Math.sqrt(ema_variance);
                const confidence_percent = Number(
                    (Math.min(observation_count / window_size, 1.0) * 100).toFixed(
                        2
                    )
                );
                const learning_status =
                    observation_count < window_size ? "learning" : "confident";

                const message =
                    observation_count < window_size
                        ? `Recorded observation ${observation_count}/${window_size}. Need ${
                              window_size - observation_count
                          } more for confident baseline.`
                        : `Baseline is confident after ${observation_count} observations.`;

                return buildResponse({
                    metric_name,
                    value_recorded: value,
                    observation_count,
                    current_mean: Number(ema_mean.toFixed(2)),
                    current_stddev: Number(current_stddev.toFixed(2)),
                    confidence_percent,
                    learning_status,
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
                "Retrieve what AgentGuard has learned about a metric from past observations. " +
                "Check this before manually providing baselines to detect_anomaly — if a learned baseline exists, detect_anomaly uses it automatically. " +
                "confidence_percent represents learning progress: min(observation_count / window_size, 1.0) × 100. " +
                "At 100% the baseline has reached the configured learning threshold. This is not a statistical confidence interval.",
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

                if (!baseline) {
                    return buildResponse({
                        error: "NO_BASELINE_FOUND",
                        metric_name,
                        message: `No learned baseline found for metric "${metric_name}". Use record_observation first to begin learning normal baseline values.`,
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
                    (Math.min(total_count / window_size, 1.0) * 100).toFixed(2)
                );
                const learning_status =
                    total_count < window_size ? "learning" : "confident";

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
                    confidence_percent,
                    confidence_formula: "min(observation_count / window_size, 1.0) × 100",
                    learning_status,
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
}
