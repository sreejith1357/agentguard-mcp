/**
 * AgentGuard MCP v2.1.0 — Multi-Tenant SQLite Database Layer
 *
 * Opens a single WAL-mode SQLite database at the project root and ensures all
 * required multi-tenant tables and indices exist before the server starts accepting traffic.
 *
 * Tables created here:
 *   session_checkpoints   — persistent session reasoning checkpoints & causal graph with tenant isolation
 *   circuit_breakers      — persistent state for Circuit Breakers scoped by (tenant_id, project_id, name)
 *   metric_observations   — time-series data for Adaptive Baseline Learning scoped by (tenant_id, project_id, metric_name)
 *   metric_baselines      — pre-computed EMA statistics scoped by (tenant_id, project_id, metric_name)
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

// Busy timeout of 5000ms for concurrent writer safety
db.pragma("timeout = 5000");

// Incremental auto-vacuum mode to keep storage bounded without full locks
db.pragma("auto_vacuum = INCREMENTAL");

// Enforce relational integrity on all foreign key constraints
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

function ensureColumnsExist(table: string, columns: { name: string; type: string; defaultVal: string }[]): void {
    try {
        const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        const existing = new Set(tableInfo.map((col) => col.name));

        for (const col of columns) {
            if (tableInfo.length > 0 && !existing.has(col.name)) {
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type} NOT NULL DEFAULT '${col.defaultVal}'`);
            }
        }
    } catch { /* ignore if table doesn't exist yet */ }
}

export function initializeDatabase(): void {
    // -----------------------------------------------------------------------
    // Table: session_checkpoints
    // -----------------------------------------------------------------------
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_checkpoints (
            checkpoint_id        TEXT PRIMARY KEY,
            tenant_id            TEXT NOT NULL DEFAULT 'default-tenant',
            project_id           TEXT NOT NULL DEFAULT 'default-project',
            session_id           TEXT NOT NULL,
            parent_checkpoint_id TEXT,
            checkpoint_type      TEXT NOT NULL,
            tool_name            TEXT,
            status               TEXT,
            content              TEXT NOT NULL,
            metadata_json        TEXT,
            tags_json            TEXT,
            payload_json         TEXT,
            created_at           TEXT NOT NULL,
            FOREIGN KEY (parent_checkpoint_id) REFERENCES session_checkpoints(checkpoint_id) ON DELETE SET NULL
        )
    `);

    ensureColumnsExist("session_checkpoints", [
        { name: "tenant_id", type: "TEXT", defaultVal: "default-tenant" },
        { name: "project_id", type: "TEXT", defaultVal: "default-project" },
    ]);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_checkpoints_tenant_session_time
            ON session_checkpoints (tenant_id, project_id, session_id, created_at)
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_checkpoints_tenant_parent
            ON session_checkpoints (tenant_id, project_id, parent_checkpoint_id)
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_checkpoints_tenant_type
            ON session_checkpoints (tenant_id, project_id, session_id, checkpoint_type)
    `);

    // -----------------------------------------------------------------------
    // Table: circuit_breakers
    // -----------------------------------------------------------------------
    // Check if circuit_breakers needs migration (e.g. primary key update)
    try {
        const cbInfo = db.prepare(`PRAGMA table_info(circuit_breakers)`).all() as { name: string; pk: number }[];
        if (cbInfo.length > 0) {
            const hasTenant = cbInfo.some((c) => c.name === "tenant_id");
            if (!hasTenant) {
                db.exec(`DROP TABLE circuit_breakers;`);
            }
        }
    } catch { /* ignore */ }

    db.exec(`
        CREATE TABLE IF NOT EXISTS circuit_breakers (
            tenant_id       TEXT NOT NULL DEFAULT 'default-tenant',
            project_id      TEXT NOT NULL DEFAULT 'default-project',
            name            TEXT NOT NULL,
            state           TEXT NOT NULL DEFAULT 'CLOSED'
                            CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
            failure_count   INTEGER NOT NULL DEFAULT 0,
            success_count   INTEGER NOT NULL DEFAULT 0,
            last_failure_at TEXT,
            last_success_at TEXT,
            opened_at       TEXT,
            half_opened_at  TEXT,
            updated_at      TEXT NOT NULL,
            PRIMARY KEY (tenant_id, project_id, name)
        )
    `);

    // -----------------------------------------------------------------------
    // Table: metric_observations
    // -----------------------------------------------------------------------
    db.exec(`
        CREATE TABLE IF NOT EXISTS metric_observations (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant_id     TEXT NOT NULL DEFAULT 'default-tenant',
            project_id    TEXT NOT NULL DEFAULT 'default-project',
            metric_name   TEXT NOT NULL,
            value         REAL NOT NULL,
            recorded_at   TEXT NOT NULL
        )
    `);

    ensureColumnsExist("metric_observations", [
        { name: "tenant_id", type: "TEXT", defaultVal: "default-tenant" },
        { name: "project_id", type: "TEXT", defaultVal: "default-project" },
    ]);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_metric_obs_tenant_metric_time
            ON metric_observations (tenant_id, project_id, metric_name, recorded_at)
    `);

    // -----------------------------------------------------------------------
    // Table: metric_baselines
    // -----------------------------------------------------------------------
    try {
        const mbInfo = db.prepare(`PRAGMA table_info(metric_baselines)`).all() as { name: string; pk: number }[];
        if (mbInfo.length > 0) {
            const hasTenant = mbInfo.some((c) => c.name === "tenant_id");
            if (!hasTenant) {
                db.exec(`DROP TABLE metric_baselines;`);
            }
        }
    } catch { /* ignore */ }

    db.exec(`
        CREATE TABLE IF NOT EXISTS metric_baselines (
            tenant_id         TEXT NOT NULL DEFAULT 'default-tenant',
            project_id        TEXT NOT NULL DEFAULT 'default-project',
            metric_name       TEXT NOT NULL,
            ema_mean          REAL NOT NULL,
            ema_variance      REAL NOT NULL,
            observation_count INTEGER NOT NULL DEFAULT 0,
            status            TEXT NOT NULL DEFAULT 'learning'
                              CHECK (status IN ('learning', 'active', 'degraded')),
            winsorized_count  INTEGER NOT NULL DEFAULT 0,
            first_observed_at TEXT NOT NULL,
            last_observed_at  TEXT NOT NULL,
            window_size       INTEGER NOT NULL DEFAULT 20,
            updated_at        TEXT NOT NULL,
            PRIMARY KEY (tenant_id, project_id, metric_name)
        )
    `);

    ensureColumnsExist("metric_baselines", [
        { name: "tenant_id", type: "TEXT", defaultVal: "default-tenant" },
        { name: "project_id", type: "TEXT", defaultVal: "default-project" },
        { name: "status", type: "TEXT", defaultVal: "learning" },
        { name: "winsorized_count", type: "INTEGER", defaultVal: "0" },
    ]);
}

// Run immediately when the module is first imported
initializeDatabase();

export default db;
