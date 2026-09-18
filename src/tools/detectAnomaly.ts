/**
 * AgentGuard MCP — Tool: detect_anomaly
 *
 * Compares an agent output against an expected baseline and flags statistical
 * outliers before they propagate downstream.
 *
 * For numeric values: uses z-score (standard deviations from baseline mean).
 * For string values: uses Levenshtein similarity ratio against baseline strings.
 *
 * No external libraries — all math is implemented inline to keep the
 * dependency footprint at zero and the logic fully auditable.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import type {
    AnomalyReport,
    AnomalySensitivity,
    AnomalySeverity,
    BaselineSummaryNumeric,
    BaselineSummaryString,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Math utilities (pure, no deps)
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
    return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
    if (values.length < 2) return 0;
    const variance =
        values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

/**
 * Levenshtein distance between two strings.
 * O(m * n) space-optimised to two rows.
 */
function levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array<number>(n + 1);

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/** Normalised similarity: 1.0 = identical, 0.0 = completely different */
function similarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    return 1 - levenshtein(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Sensitivity → threshold mappings
// ---------------------------------------------------------------------------

const Z_SCORE_THRESHOLDS: Record<AnomalySensitivity, number> = {
    low: 3.0,    // Only flag extreme outliers (3σ)
    medium: 2.0, // Standard statistical threshold (2σ)
    high: 1.5,   // Aggressive — catches subtle drift
};

const SIMILARITY_THRESHOLDS: Record<AnomalySensitivity, number> = {
    low: 0.3,    // Must be at least 30% similar
    medium: 0.5, // Must be at least 50% similar
    high: 0.7,   // Must be at least 70% similar
};

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

function classifyNumericSeverity(
    zScore: number,
    sensitivity: AnomalySensitivity
): AnomalySeverity {
    const absZ = Math.abs(zScore);
    if (absZ <= Z_SCORE_THRESHOLDS[sensitivity]) return "none";
    if (absZ < 2.0) return "low";
    if (absZ < 3.0) return "medium";
    if (absZ < 4.0) return "high";
    return "critical";
}

function classifyStringSeverity(
    sim: number,
    sensitivity: AnomalySensitivity
): AnomalySeverity {
    const threshold = SIMILARITY_THRESHOLDS[sensitivity];
    if (sim >= threshold) return "none";
    if (sim >= 0.6) return "low";
    if (sim >= 0.4) return "medium";
    if (sim >= 0.2) return "high";
    return "critical";
}

// ---------------------------------------------------------------------------
// Numeric anomaly detection
// ---------------------------------------------------------------------------

function detectNumeric(
    value: number,
    baseline: number[],
    sensitivity: AnomalySensitivity,
    metricName: string,
    context?: string
): AnomalyReport {
    const avg = mean(baseline);
    const sd = stddev(baseline, avg);
    const minVal = Math.min(...baseline);
    const maxVal = Math.max(...baseline);
    const threshold = Z_SCORE_THRESHOLDS[sensitivity];

    // Handle zero stddev (all baseline values identical)
    let zScore: number;
    if (sd === 0) {
        zScore = value === avg ? 0 : Infinity;
    } else {
        zScore = (value - avg) / sd;
    }

    const anomalyDetected = Math.abs(zScore) > threshold;
    const severity = classifyNumericSeverity(zScore, sensitivity);

    const baselineSummary: BaselineSummaryNumeric = {
        mean: Math.round(avg * 10000) / 10000,
        stddev: Math.round(sd * 10000) / 10000,
        min: minVal,
        max: maxVal,
        count: baseline.length,
    };

    const verdict = anomalyDetected
        ? `⚠️ Anomaly detected on "${metricName}": z-score ${zScore.toFixed(3)} exceeds ${threshold}σ threshold (${sensitivity} sensitivity)`
        : `✅ "${metricName}" is within normal range: z-score ${zScore.toFixed(3)} ≤ ${threshold}σ`;

    const recommendation = anomalyDetected
        ? `Severity is ${severity.toUpperCase()}. Investigate "${metricName}" before proceeding. Value ${value} deviates significantly from baseline mean of ${avg.toFixed(4)}.`
        : `Value is statistically consistent with baseline. Safe to proceed.`;

    // Clamp Infinity to a large finite sentinel so JSON.stringify produces a
    // number rather than null. Infinity arises when stddev=0 and value≠avg
    // (e.g. single-value baseline). 999999 is large enough to always exceed
    // every sensitivity threshold and unambiguously signal "maximal deviation".
    const safeZScore = isFinite(zScore)
        ? Math.round(zScore * 10000) / 10000
        : (zScore > 0 ? 999999 : -999999);

    return {
        anomaly_detected: anomalyDetected,
        metric_name: metricName,
        observed_value: value,
        value_type: "numeric",
        baseline_summary: baselineSummary,
        z_score: safeZScore,
        severity,
        sensitivity_used: sensitivity,
        verdict,
        recommendation,
        ...(context && { context }),
        timestamp: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// String anomaly detection
// ---------------------------------------------------------------------------

function detectString(
    value: string,
    baseline: string[],
    sensitivity: AnomalySensitivity,
    metricName: string,
    context?: string
): AnomalyReport {
    const similarities = baseline.map((b) => similarity(value, b));
    const minSim = Math.min(...similarities);
    const maxSim = Math.max(...similarities);
    const avgSim = similarities.reduce((s, v) => s + v, 0) / similarities.length;
    const threshold = SIMILARITY_THRESHOLDS[sensitivity];

    // Use minimum similarity as the worst-case metric
    const anomalyDetected = minSim < threshold;
    const severity = classifyStringSeverity(minSim, sensitivity);

    const baselineSummary: BaselineSummaryString = {
        min_similarity: Math.round(minSim * 10000) / 10000,
        max_similarity: Math.round(maxSim * 10000) / 10000,
        avg_similarity: Math.round(avgSim * 10000) / 10000,
        count: baseline.length,
    };

    const simPercent = (minSim * 100).toFixed(1);
    const thresholdPercent = (threshold * 100).toFixed(0);

    const verdict = anomalyDetected
        ? `⚠️ Anomaly detected on "${metricName}": minimum similarity ${simPercent}% is below ${thresholdPercent}% threshold (${sensitivity} sensitivity)`
        : `✅ "${metricName}" is within acceptable similarity range: ${simPercent}% ≥ ${thresholdPercent}%`;

    const recommendation = anomalyDetected
        ? `Severity is ${severity.toUpperCase()}. The output differs significantly from all baseline examples. Review "${metricName}" before using it downstream.`
        : `String output is sufficiently similar to baseline patterns. Safe to proceed.`;

    return {
        anomaly_detected: anomalyDetected,
        metric_name: metricName,
        observed_value: value,
        value_type: "string",
        baseline_summary: baselineSummary,
        similarity_score: Math.round(minSim * 10000) / 10000,
        severity,
        sensitivity_used: sensitivity,
        verdict,
        recommendation,
        ...(context && { context }),
        timestamp: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function detectAnomalyTool(server: McpServer): void {
    server.registerTool(
        "detect_anomaly",
        {
            description: "Compare an agent output or metric against expected baseline patterns and flag statistical outliers before they propagate downstream. Uses z-score analysis for numeric values and Levenshtein similarity for strings.",
            inputSchema: {
                value: z
                    .union([z.number(), z.string()])
                    .describe("The current observed value or agent output to check"),
                baseline: z
                    .union([
                        z.array(z.number()).min(1).max(1000),
                        z.array(z.string()).min(1).max(1000),
                    ])
                    .describe(
                        "Historical or expected comparison set. Must be same type as value (all numbers or all strings). Minimum 1 item, maximum 1000, recommended 5+ for statistical reliability."
                    ),
                metric_name: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("Human-readable name for the metric being checked (e.g. 'response_latency_ms', 'confidence_score', 'output_format')"),
                sensitivity: z
                    .enum(["low", "medium", "high"])
                    .optional()
                    .default("medium")
                    .describe(
                        "Detection sensitivity: 'low' (3σ / 30% similarity — only extreme outliers), 'medium' (2σ / 50% — standard), 'high' (1.5σ / 70% — catches subtle drift)"
                    ),
                context: z
                    .string()
                    .max(512)
                    .optional()
                    .describe("Optional agent-provided context about what this metric represents"),
            },
        },
        async ({ value, baseline, metric_name, sensitivity, context }) => {
            try {
                // Type-check baseline matches value type
                if (typeof value === "number") {
                    if (!baseline.every((b) => typeof b === "number")) {
                        return buildResponse<AnomalyReport>({
                            anomaly_detected: false,
                            metric_name,
                            observed_value: value,
                            value_type: "numeric",
                            baseline_summary: { mean: 0, stddev: 0, min: 0, max: 0, count: 0 },
                            severity: "none",
                            sensitivity_used: sensitivity ?? "medium",
                            verdict: "❌ Type mismatch: value is numeric but baseline contains non-numeric values",
                            recommendation: "Ensure all baseline values are numbers when checking a numeric metric",
                            timestamp: new Date().toISOString(),
                        });
                    }
                    return buildResponse(
                        detectNumeric(
                            value,
                            baseline as number[],
                            sensitivity ?? "medium",
                            metric_name,
                            context
                        )
                    );
                } else {
                    if (!baseline.every((b) => typeof b === "string")) {
                        return buildResponse<AnomalyReport>({
                            anomaly_detected: false,
                            metric_name,
                            observed_value: value,
                            value_type: "string",
                            baseline_summary: { min_similarity: 0, max_similarity: 0, avg_similarity: 0, count: 0 },
                            severity: "none",
                            sensitivity_used: sensitivity ?? "medium",
                            verdict: "❌ Type mismatch: value is string but baseline contains non-string values",
                            recommendation: "Ensure all baseline values are strings when checking a string metric",
                            timestamp: new Date().toISOString(),
                        });
                    }
                    return buildResponse(
                        detectString(
                            value,
                            baseline as string[],
                            sensitivity ?? "medium",
                            metric_name,
                            context
                        )
                    );
                }
            } catch (error) {
                return buildErrorResponse("detect_anomaly", error);
            }
        }
    );
}
