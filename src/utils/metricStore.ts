/**
 * AgentGuard MCP v2.0.0 — Metric Store
 *
 * Thin data-access layer over the metric_observations and metric_baselines
 * SQLite tables. Used by the Adaptive Baseline Learning system to record
 * time-series observations and manage pre-computed EMA statistics.
 */

import db from "../db/schema.js";
import type { BaselineRow, ObservationRow } from "../types/index.js";

// ---------------------------------------------------------------------------
// Prepared statements — compiled once at module load
// ---------------------------------------------------------------------------

const stmtInsertObservation = db.prepare<{
    metric_name: string;
    value: number;
    recorded_at: string;
}>(`
    INSERT INTO metric_observations (metric_name, value, recorded_at)
    VALUES (@metric_name, @value, @recorded_at)
`);

const stmtGetBaseline = db.prepare<[string], BaselineRow>(
    "SELECT * FROM metric_baselines WHERE metric_name = ?"
);

const stmtGetRecentObservations = db.prepare<[string, number], ObservationRow>(`
    SELECT * FROM metric_observations
    WHERE metric_name = ?
    ORDER BY recorded_at DESC
    LIMIT ?
`);

const stmtGetObservationCount = db.prepare<[string], { count: number }>(
    "SELECT COUNT(*) AS count FROM metric_observations WHERE metric_name = ?"
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single numeric observation for a metric.
 * recorded_at is always set server-side to prevent clock skew.
 */
export function recordObservation(metric_name: string, value: number): void {
    stmtInsertObservation.run({
        metric_name,
        value,
        recorded_at: new Date().toISOString(),
    });
}

/**
 * Retrieve the pre-computed EMA baseline for a metric.
 * Returns undefined if no observations have been recorded yet.
 */
export function getBaseline(metric_name: string): BaselineRow | undefined {
    return stmtGetBaseline.get(metric_name);
}

/**
 * Insert or update the EMA baseline for a metric.
 * Always stamps updated_at with the current ISO timestamp.
 */
export function upsertBaseline(
    metric_name: string,
    data: Partial<BaselineRow>
): void {
    const now = new Date().toISOString();
    const existing = getBaseline(metric_name);

    const merged: BaselineRow = Object.assign(
        {
            metric_name,
            ema_mean: 0,
            ema_variance: 0,
            observation_count: 0,
            first_observed_at: now,
            last_observed_at: now,
            window_size: 20,
            updated_at: now,
        },
        existing ?? {},
        data,
        { updated_at: now }   // always win — override whatever caller passed
    );

    db.prepare(`
        INSERT INTO metric_baselines
            (metric_name, ema_mean, ema_variance, observation_count,
             first_observed_at, last_observed_at, window_size, updated_at)
        VALUES
            (@metric_name, @ema_mean, @ema_variance, @observation_count,
             @first_observed_at, @last_observed_at, @window_size, @updated_at)
        ON CONFLICT(metric_name) DO UPDATE SET
            ema_mean          = excluded.ema_mean,
            ema_variance      = excluded.ema_variance,
            observation_count = excluded.observation_count,
            last_observed_at  = excluded.last_observed_at,
            window_size       = excluded.window_size,
            updated_at        = excluded.updated_at
    `).run(merged);
}

/**
 * Return the N most recent observations for a metric, newest first.
 */
export function getRecentObservations(
    metric_name: string,
    limit: number
): ObservationRow[] {
    return stmtGetRecentObservations.all(metric_name, limit);
}

/**
 * Return the total number of observations recorded for a metric.
 */
export function getObservationCount(metric_name: string): number {
    const row = stmtGetObservationCount.get(metric_name);
    return row?.count ?? 0;
}

/**
 * Return aggregate statistics for the metric_baselines table.
 */
export function getBaselineStats(): {
    total_metrics_tracked: number;
    confident_baselines: number;
} {
    const row = db
        .prepare<[], { total: number; confident: number }>(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN observation_count >= window_size THEN 1 ELSE 0 END) AS confident
            FROM metric_baselines`
        )
        .get();
    return {
        total_metrics_tracked: row?.total ?? 0,
        confident_baselines: row?.confident ?? 0,
    };
}

