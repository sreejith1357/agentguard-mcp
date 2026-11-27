/**
 * AgentGuard MCP — Tool: log_checkpoint
 *
 * Allows agents to write their current reasoning state to persistent storage,
 * creating a full audit trail of agent decision-making across a session AND
 * performing real-time loop / parameter-repetition detection.
 */

import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import {
    append,
    querySessionHistoryAsync,
    CheckpointLimitError,
    MAX_CHECKPOINTS,
} from "../utils/storage.js";
import { detectExecutionLoop } from "../utils/loopDetector.js";
import { getTenantContext } from "../utils/auth.js";
import { dispatchWebhookEvent } from "../utils/webhookDispatcher.js";
import type { CheckpointEntry, LogCheckpointResult } from "../types/index.js";

export function logCheckpointTool(server: McpServer): void {
    server.registerTool(
        "log_checkpoint",
        {
            description:
                "Write your current reasoning state or tool call to persistent storage, creating a full audit trail across this session. " +
                "Automatically inspects recent session trajectory for infinite loops, parameter repetition, and oscillating cycles.",
            inputSchema: {
                session_id: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe(
                        "Unique identifier for this agent session. Use a consistent ID across all checkpoints in one session."
                    ),
                checkpoint_type: z
                    .string()
                    .min(1)
                    .max(64)
                    .describe(
                        "Category of this checkpoint (e.g. 'reasoning', 'decision', 'tool_call', 'error', 'milestone', 'observation')"
                    ),
                content: z
                    .string()
                    .min(1)
                    .max(16384)
                    .describe(
                        "The agent's current reasoning, decision rationale, tool call summary, or error description."
                    ),
                metadata: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe(
                        "Optional structured context: tool names, input hashes, confidence scores, model parameters, etc."
                    ),
                tags: z
                    .array(z.string().min(1).max(64))
                    .max(20)
                    .optional()
                    .default([])
                    .describe(
                        "Searchable tags for filtering history later (e.g. ['critical', 'user-facing', 'financial'])"
                    ),
                parent_checkpoint_id: z
                    .string()
                    .uuid()
                    .optional()
                    .describe(
                        "UUID of the parent checkpoint this one depends on. Enables causal chain analysis."
                    ),
                tool_name: z
                    .string()
                    .max(128)
                    .optional()
                    .describe("Optional tool name associated with this checkpoint"),
                status: z
                    .string()
                    .max(64)
                    .optional()
                    .describe("Optional status (e.g. 'started', 'completed', 'failed')"),
                tool_input: z
                    .unknown()
                    .optional()
                    .describe("Optional tool input parameters for parameter-repetition loop detection"),
                step_index: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .describe("Optional monotonic step counter within the session"),
                loop_window: z
                    .number()
                    .int()
                    .min(2)
                    .max(100)
                    .optional()
                    .default(20)
                    .describe("How many recent checkpoints to inspect for loops (default: 20)"),
                loop_threshold: z
                    .number()
                    .int()
                    .min(2)
                    .max(20)
                    .optional()
                    .default(3)
                    .describe("Number of matching occurrences before flagging a loop (default: 3)"),
            },
        },
        async ({
            session_id,
            checkpoint_type,
            content,
            metadata,
            tags,
            parent_checkpoint_id,
            tool_name,
            status,
            tool_input,
            step_index,
            loop_window,
            loop_threshold,
        }) => {
            try {
                const checkpointId = crypto.randomUUID();
                const now = new Date().toISOString();

                const mergedMetadata: Record<string, unknown> | undefined =
                    metadata || tool_name !== undefined || tool_input !== undefined || step_index !== undefined
                        ? {
                              ...(metadata ?? {}),
                              ...(tool_name !== undefined ? { tool_name } : {}),
                              ...(tool_input !== undefined ? { tool_input } : {}),
                              ...(step_index !== undefined ? { step_index } : {}),
                          }
                        : undefined;

                // Evaluate recent trajectory for execution loops before persisting
                const windowSize = loop_window ?? 20;
                const repeatThreshold = loop_threshold ?? 3;
                const history = await querySessionHistoryAsync({
                    session_id,
                    limit: windowSize,
                });

                const loopResult = detectExecutionLoop(
                    history.entries,
                    {
                        checkpoint_type,
                        content,
                        metadata: mergedMetadata,
                    },
                    { windowSize, repeatThreshold }
                );

                const entry: CheckpointEntry = {
                    id: checkpointId,
                    session_id,
                    checkpoint_type,
                    ...(tool_name ? { tool_name } : {}),
                    ...(status ? { status } : {}),
                    content,
                    metadata: mergedMetadata,
                    tags: tags && tags.length > 0 ? tags : undefined,
                    parent_checkpoint_id: parent_checkpoint_id ?? null,
                    created_at: now,
                };

                await append<CheckpointEntry>(session_id, entry);

                if (loopResult.loop_detected) {
                    const ctx = getTenantContext();
                    dispatchWebhookEvent({
                        tenant_id: ctx.tenant_id,
                        event: "loop.detected",
                        payload: {
                            session_id,
                            checkpoint_id: checkpointId,
                            loop_type: loopResult.loop_type,
                            repeat_count: loopResult.repeat_count,
                            tool_name,
                            warning: loopResult.warning,
                            timestamp: now,
                        },
                    });
                }

                const result: LogCheckpointResult = {
                    logged: true,
                    id: checkpointId,
                    checkpoint_id: checkpointId,
                    session_id,
                    checkpoint_type,
                    ...(tool_name ? { tool_name } : {}),
                    ...(status ? { status } : {}),
                    parent_checkpoint_id: parent_checkpoint_id ?? null,
                    loop_detected: loopResult.loop_detected,
                    ...(loopResult.loop_type ? { loop_type: loopResult.loop_type } : {}),
                    repeat_count: loopResult.repeat_count,
                    recommended_action: loopResult.recommended_action,
                    ...(loopResult.warning ? { warning: loopResult.warning } : {}),
                    timestamp: now,
                };

                return buildResponse(result);
            } catch (error) {
                if (error instanceof CheckpointLimitError) {
                    return buildResponse({
                        logged: false,
                        error: "CHECKPOINT_LIMIT_REACHED",
                        session_id: error.sessionId,
                        limit: error.limit,
                        message: error.message,
                        hint: `Set MAX_CHECKPOINTS env var above ${MAX_CHECKPOINTS} to increase the limit, or use a new session_id to start fresh.`,
                        timestamp: new Date().toISOString(),
                    });
                }
                return buildErrorResponse("log_checkpoint", error);
            }
        }
    );
}
