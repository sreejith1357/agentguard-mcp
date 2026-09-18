/**
 * AgentGuard MCP — File-Based JSONL Storage Utility
 *
 * Provides atomic append / read operations on newline-delimited JSON files.
 * Each session maps to a single file: ./data/<session_id>.jsonl
 *
 * Design principles:
 *  - Zero external dependencies (uses only Node.js built-ins)
 *  - Atomic writes via O_APPEND flag (atomic at the OS level for small writes
 *    on local POSIX filesystems — see POSIX.1-2017 §2.9.7)
 *  - Stateless: no in-memory cache — every call goes to disk
 *  - The `data/` directory is created automatically on first write
 *  - MAX_CHECKPOINTS cap enforced per session (env var, default 10 000)
 *
 * Swap point: replace the implementation of `append` and `readAll` with calls
 * to Redis, Cloudflare KV, or D1 for multi-node / edge deployments.
 */

import fs from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// Path resolution — CJS __dirname points to compiled utils/ or src/utils/
// ---------------------------------------------------------------------------

// Resolve data directory relative to project root (two levels up from utils/)
const DATA_DIR = path.resolve(__dirname, "..", "..", "data");

// ---------------------------------------------------------------------------
// Checkpoint limit
// ---------------------------------------------------------------------------

/**
 * Maximum number of checkpoints allowed per session.
 * Configurable via MAX_CHECKPOINTS environment variable.
 * Defaults to 10 000 if unset or unparseable.
 */
const _parsed = parseInt(process.env.MAX_CHECKPOINTS ?? "", 10);
const MAX_CHECKPOINTS: number = Number.isFinite(_parsed) && _parsed > 0 ? _parsed : 10_000;

/**
 * Thrown by `append()` when a session has reached MAX_CHECKPOINTS.
 * Caught specifically in logCheckpoint.ts to return a structured error
 * response instead of a generic internal error.
 */
export class CheckpointLimitError extends Error {
    readonly sessionId: string;
    readonly limit: number;

    constructor(sessionId: string, limit: number) {
        super(
            `Session "${sessionId}" has reached the maximum of ${limit} checkpoints. ` +
            `Increase MAX_CHECKPOINTS or archive old sessions.`
        );
        this.name = "CheckpointLimitError";
        this.sessionId = sessionId;
        this.limit = limit;
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure the data directory exists. Called before every write. */
async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Derive the full path for a session's JSONL file. */
function sessionPath(sessionId: string): string {
    // Sanitise the session ID to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(DATA_DIR, `${safe}.jsonl`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single record to a session's JSONL file.
 *
 * Enforces the MAX_CHECKPOINTS cap: reads the current line count before
 * writing. If the session is already at the limit, throws CheckpointLimitError
 * without touching the file.
 *
 * The record is serialised as a single line of JSON followed by a newline.
 * Uses the `a` (append) flag which is atomic for small writes on POSIX.
 *
 * @throws CheckpointLimitError  when the session is at MAX_CHECKPOINTS
 * @throws Error                 on genuine filesystem failures
 */
export async function append<T extends object>(
    sessionId: string,
    record: T
): Promise<void> {
    await ensureDataDir();

    // Enforce checkpoint cap before writing
    const current = await countRecords(sessionId);
    if (current >= MAX_CHECKPOINTS) {
        throw new CheckpointLimitError(sessionId, MAX_CHECKPOINTS);
    }

    const filePath = sessionPath(sessionId);
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(filePath, line, { encoding: "utf8" });
}

/**
 * Read and parse all records from a session's JSONL file.
 * Returns an empty array if the session file does not exist (not an error).
 * Lines that fail to parse are silently skipped with a console warning so
 * a single corrupt line never takes down the entire history read.
 */
export async function readAll<T = unknown>(sessionId: string): Promise<T[]> {
    const filePath = sessionPath(sessionId);

    let raw: string;
    try {
        raw = await fs.readFile(filePath, { encoding: "utf8" });
    } catch (err: unknown) {
        // File not found → empty history (expected for new sessions)
        if (
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
            return [];
        }
        throw err;
    }

    const records: T[] = [];
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
        try {
            records.push(JSON.parse(line) as T);
        } catch {
            console.warn(
                `[storage] Skipping malformed JSONL line in session "${sessionId}":`,
                line.slice(0, 120)
            );
        }
    }

    return records;
}

/**
 * Check whether a session file exists.
 * Useful for fast existence checks without reading the full file.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
    const filePath = sessionPath(sessionId);
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Return the number of records in a session without loading them all.
 * Counts newlines — O(file size) but avoids full JSON parse overhead.
 * Returns 0 if the session file does not exist.
 */
export async function countRecords(sessionId: string): Promise<number> {
    const filePath = sessionPath(sessionId);
    try {
        const raw = await fs.readFile(filePath, { encoding: "utf8" });
        return raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
        return 0;
    }
}

/**
 * Return aggregate storage statistics across all sessions.
 * Used by the /health endpoint to surface observability data.
 *
 * Reads DATA_DIR, counts .jsonl files (= sessions), and sums their line
 * counts (= total checkpoints). Returns zeros if DATA_DIR doesn't exist yet.
 */
export async function getStorageStats(): Promise<{
    total_sessions: number;
    total_checkpoints: number;
}> {
    try {
        const files = await fs.readdir(DATA_DIR);
        const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

        let totalCheckpoints = 0;
        for (const file of jsonlFiles) {
            const sessionId = file.slice(0, -6); // strip .jsonl
            totalCheckpoints += await countRecords(sessionId);
        }

        return {
            total_sessions: jsonlFiles.length,
            total_checkpoints: totalCheckpoints,
        };
    } catch {
        // DATA_DIR doesn't exist yet (no checkpoints written)
        return { total_sessions: 0, total_checkpoints: 0 };
    }
}

/** Expose the active limit so callers can surface it in responses. */
export { MAX_CHECKPOINTS };

/**
 * Clean up session files older than a specified threshold (in milliseconds).
 * Default threshold is 30 days (configurable via SESSION_TTL_DAYS env var).
 */
export async function cleanupOldSessions(
    maxAgeMs: number = parseInt(process.env.SESSION_TTL_DAYS ?? "30", 10) * 24 * 60 * 60 * 1000
): Promise<{ deleted_files: number }> {
    try {
        const files = await fs.readdir(DATA_DIR);
        const now = Date.now();
        let deletedCount = 0;

        for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = path.join(DATA_DIR, file);
            const stat = await fs.stat(filePath);
            if (now - stat.mtimeMs > maxAgeMs) {
                await fs.unlink(filePath);
                deletedCount++;
            }
        }
        return { deleted_files: deletedCount };
    } catch {
        return { deleted_files: 0 };
    }
}

