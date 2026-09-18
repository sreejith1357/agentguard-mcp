/**
 * AgentGuard MCP v2.0.0 — SQLite Database Layer
 *
 * Opens a single WAL-mode SQLite database at the project root and ensures all
 * required tables and indices exist before the server starts accepting traffic.
 *
 * Tables created here:
 *   circuit_breakers      — persistent state for the Circuit Breaker system
 *   metric_observations   — raw time-series data for Adaptive Baseline Learning
 *   metric_baselines      — pre-computed EMA statistics per metric
 *
 * Swap point: replace the better-sqlite3 implementation with a remote database
 * (Turso, libSQL, Cloudflare D1) for multi-node / edge deployments.
 */

import Database from "better-sqlite3";
import path from "path";

// ---------------------------------------------------------------------------
// Database path — resolves to <project-root>/agentguard.db
// CJS __dirname = dist/db/ or src/db/ depending on dev vs prod
// ---------------------------------------------------------------------------

const DB_PATH = path.resolve(__dirname, "..", "..", "agentguard.db");

// ---------------------------------------------------------------------------
// Open database
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH, {
    verbose: process.env.NODE_ENV !== "production" ? undefined : undefined,
});

// WAL mode for concurrent read performance and crash safety
db.pragma("journal_mode = WAL");

// Enforce relational integrity on all foreign key constraints
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

export function initializeDatabase(): void {
    // -----------------------------------------------------------------------
    // Table: circuit_breakers
    // Stores the current state of each named circuit breaker.
    // -----------------------------------------------------------------------
    db.exec(`
        CREATE TABLE IF NOT EXISTS circuit_breakers (
            name            TEXT PRIMARY KEY,
            state           TEXT NOT NULL DEFAULT 'CLOSED'
                            CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
            failure_count   INTEGER NOT NULL DEFAULT 0,
            success_count   INTEGER NOT NULL DEFAULT 0,
            last_failure_at TEXT,
            last_success_at TEXT,
            opened_at       TEXT,
            half_opened_at  TEXT,
            updated_at      TEXT NOT NULL
        )
    `);

    // -----------------------------------------------------------------------
    // Table: metric_observations
    // Raw time-series observations for every metric that flows through
    // the Adaptive Baseline Learning system.
    // -----------------------------------------------------------------------
    db.exec(`
        CREATE TABLE IF NOT EXISTS metric_observations (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name   TEXT NOT NULL,
            value         REAL NOT NULL,
            recorded_at   TEXT NOT NULL
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_metric_observations_name
            ON metric_observations (metric_name)
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_metric_observations_name_time
            ON metric_observations (metric_name, recorded_at)
    `);

    // -----------------------------------------------------------------------
    // Table: metric_baselines
    // Pre-computed exponential-moving-average statistics per metric.
    // One row per metric_name; updated on every observation.
    // -----------------------------------------------------------------------
    db.exec(`
        CREATE TABLE IF NOT EXISTS metric_baselines (
            metric_name       TEXT PRIMARY KEY,
            ema_mean          REAL NOT NULL,
            ema_variance      REAL NOT NULL,
            observation_count INTEGER NOT NULL DEFAULT 0,
            first_observed_at TEXT NOT NULL,
            last_observed_at  TEXT NOT NULL,
            window_size       INTEGER NOT NULL DEFAULT 20,
            updated_at        TEXT NOT NULL
        )
    `);
}

// Run immediately when the module is first imported
initializeDatabase();

export default db;
