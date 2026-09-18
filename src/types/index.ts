/**
 * AgentGuard MCP — Shared Type Definitions
 * Central contract types used across all tools and utilities.
 */


// Health Check
// ---------------------------------------------------------------------------

export interface HealthResult {
    healthy: boolean;
    url: string;
    status_code?: number;
    expected_status: number;
    response_time_ms: number;
    error?: "TIMEOUT" | "CONNECTION_FAILED";
    message?: string;
    verdict: string;
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Validate Tool Response
// ---------------------------------------------------------------------------

export type ExpectedFieldType = "string" | "number" | "boolean" | "array" | "object" | "null";

export interface CustomRule {
    field: string;
    min?: number;
    max?: number;
    pattern?: string;
}

export interface FieldValidationResult {
    passed: boolean;
    reason: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    field_results: Record<string, FieldValidationResult>;
    age_seconds?: number;
    age_check?: "passed" | "stale" | "no_timestamp";
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Log Checkpoint
// ---------------------------------------------------------------------------

export type CheckpointType =
    | "reasoning"
    | "decision"
    | "tool_call"
    | "error"
    | "milestone";

export interface CheckpointEntry {
    id: string;
    session_id: string;
    checkpoint_type: CheckpointType;
    content: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    created_at: string;
}

export interface LogCheckpointResult {
    logged: boolean;
    checkpoint_id: string;
    session_id: string;
    checkpoint_type: CheckpointType;
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Detect Anomaly
// ---------------------------------------------------------------------------

export type AnomalySensitivity = "low" | "medium" | "high";
export type AnomalySeverity = "none" | "low" | "medium" | "high" | "critical";

export interface BaselineSummaryNumeric {
    mean: number;
    stddev: number;
    min: number;
    max: number;
    count: number;
}

export interface BaselineSummaryString {
    min_similarity: number;
    max_similarity: number;
    avg_similarity: number;
    count: number;
}

export interface AnomalyReport {
    anomaly_detected: boolean;
    metric_name: string;
    observed_value: number | string;
    value_type: "numeric" | "string";
    baseline_summary: BaselineSummaryNumeric | BaselineSummaryString;
    z_score?: number;
    similarity_score?: number;
    severity: AnomalySeverity;
    sensitivity_used: AnomalySensitivity;
    verdict: string;
    recommendation: string;
    context?: string;
    timestamp: string;
}

// ---------------------------------------------------------------------------
// Session History
// ---------------------------------------------------------------------------

export interface SessionHistoryResult {
    session_id: string;
    total_found: number;
    entries: CheckpointEntry[];
    oldest_entry_at: string | null;
    newest_entry_at: string | null;
    filters_applied: {
        checkpoint_type?: string;
        since_timestamp?: string;
        tags?: string[];
        limit: number;
    };
    timestamp: string;
}
