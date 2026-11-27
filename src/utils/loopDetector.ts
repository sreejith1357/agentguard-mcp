/**
 * AgentGuard MCP — Execution Loop & Parameter Repetition Detector
 *
 * Analyzes recent session checkpoints to detect:
 *  1. Exact / near-duplicate checkpoint repeats (e.g. identical tool inputs or reasoning loops).
 *  2. Oscillating / ping-pong cycles (A -> B -> A -> B).
 *  3. Repeated tool_call + input parameter patterns even with slightly varied wording.
 */

import crypto from "node:crypto";
import type { CheckpointEntry } from "../types/index.js";

export type LoopType = "exact_repeat" | "oscillation" | "parameter_repetition";

export interface LoopDetectionResult {
    loop_detected: boolean;
    loop_type?: LoopType;
    repeat_count: number;
    window_checked: number;
    fingerprint: string;
    recommended_action: string;
    warning?: string;
}

/**
 * Deterministic canonical JSON serialization (sorted keys) so equivalent
 * parameter objects hash identically regardless of key insertion order.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    return (
        "{" +
        sortedKeys
            .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
            .join(",") +
        "}"
    );
}

/**
 * Computes a normalized fingerprint for a checkpoint's content and parameters.
 */
export function computeCheckpointFingerprint(params: {
    checkpoint_type: string;
    content: string;
    metadata?: Record<string, unknown>;
}): string {
    const normalizedContent = params.content.trim().toLowerCase().replace(/\s+/g, " ");
    const normalizedMeta = params.metadata ? canonicalJson(params.metadata) : "";
    return crypto
        .createHash("sha256")
        .update(`${params.checkpoint_type}:${normalizedContent}:${normalizedMeta}`)
        .digest("hex")
        .slice(0, 16);
}

/**
 * Computes a parameter-only fingerprint when tool_name + tool_input are present in metadata.
 */
export function computeToolParamFingerprint(metadata?: Record<string, unknown>): string | null {
    if (!metadata) return null;
    const toolName = metadata.tool_name;
    const toolInput = metadata.tool_input ?? metadata.input ?? metadata.arguments ?? metadata.params;
    if (typeof toolName !== "string" || !toolName) return null;
    if (toolInput === undefined) return null;
    return crypto
        .createHash("sha256")
        .update(`${toolName}:${canonicalJson(toolInput)}`)
        .digest("hex")
        .slice(0, 16);
}

/**
 * Evaluates a candidate checkpoint against recent session history.
 */
export function detectExecutionLoop(
    recentEntries: CheckpointEntry[],
    current: {
        checkpoint_type: string;
        content: string;
        metadata?: Record<string, unknown>;
    },
    options: {
        windowSize?: number;
        repeatThreshold?: number;
    } = {}
): LoopDetectionResult {
    const windowSize = options.windowSize ?? 20;
    const repeatThreshold = options.repeatThreshold ?? 3;

    const currentFp = computeCheckpointFingerprint(current);
    const currentParamFp = computeToolParamFingerprint(current.metadata);

    const window = recentEntries.slice(-windowSize);
    const historyFps = window.map((entry) =>
        computeCheckpointFingerprint({
            checkpoint_type: entry.checkpoint_type,
            content: entry.content,
            metadata: entry.metadata,
        })
    );

    // 1. Count exact fingerprint matches in the recent window (including current = +1)
    const priorMatches = historyFps.filter((fp) => fp === currentFp).length;
    const totalExactCount = priorMatches + 1;

    if (totalExactCount >= repeatThreshold) {
        return {
            loop_detected: true,
            loop_type: "exact_repeat",
            repeat_count: totalExactCount,
            window_checked: window.length,
            fingerprint: currentFp,
            recommended_action:
                "Halt current execution path immediately, inspect prior tool errors, and switch strategy or escalate to user.",
            warning: `Infinite loop detected: identical "${current.checkpoint_type}" checkpoint repeated ${totalExactCount} times within last ${window.length} steps.`,
        };
    }

    // 2. Check parameter repetition (same tool_name + tool_input even if content narrative changed)
    if (currentParamFp) {
        const paramMatches = window.filter(
            (entry) => computeToolParamFingerprint(entry.metadata) === currentParamFp
        ).length;
        const totalParamCount = paramMatches + 1;
        if (totalParamCount >= repeatThreshold) {
            return {
                loop_detected: true,
                loop_type: "parameter_repetition",
                repeat_count: totalParamCount,
                window_checked: window.length,
                fingerprint: currentParamFp,
                recommended_action:
                    "Stop calling the same tool with identical arguments. Alter input parameters, check circuit state, or use a fallback tool.",
                warning: `Parameter repetition loop detected: identical tool call parameters repeated ${totalParamCount} times within last ${window.length} steps.`,
            };
        }
    }

    // 3. Check oscillating A -> B -> A -> B cycle (including current as newest item)
    const seq = [...historyFps, currentFp];
    if (seq.length >= 4) {
        const len = seq.length;
        const a1 = seq[len - 4];
        const b1 = seq[len - 3];
        const a2 = seq[len - 2];
        const b2 = seq[len - 1];
        if (a1 === a2 && b1 === b2 && a1 !== b1) {
            return {
                loop_detected: true,
                loop_type: "oscillation",
                repeat_count: 2,
                window_checked: window.length,
                fingerprint: currentFp,
                recommended_action:
                    "Break alternating A<->B cycle by introducing a new diagnostic step or escalating.",
                warning: `Oscillating loop detected (A -> B -> A -> B) across the last 4 checkpoints.`,
            };
        }
    }

    return {
        loop_detected: false,
        repeat_count: totalExactCount,
        window_checked: window.length,
        fingerprint: currentFp,
        recommended_action: "Proceed normally.",
    };
}

