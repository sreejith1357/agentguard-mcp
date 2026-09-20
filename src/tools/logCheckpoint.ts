/**
 * AgentGuard MCP — Tool: log_checkpoint
 *
 * Allows agents to write their current reasoning state to persistent storage,
 * creating a full audit trail of agent decision-making across a session.
 *
 * Each checkpoint is appended atomically to a session-scoped JSONL file.
 * Checkpoints are retrievable via get_session_history with full filtering.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { append, CheckpointLimitError, MAX_CHECKPOINTS } from "../utils/storage.js";
import type { CheckpointEntry, LogCheckpointResult } from "../types/index.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function logCheckpointTool(server: McpServer): void {
    server.registerTool(
        "log_checkpoint",
        {
            description: "Write your current reasoning state to persistent storage, creating a full audit trail of your decision-making across this session. Each checkpoint is stored with a unique ID and can be retrieved later with get_session_history.",
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
                    .max(8192)
                    .describe(
                        "The agent's current reasoning, decision rationale, tool call summary, or error description. Be specific — this is your audit trail."
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
                        "UUID of the parent checkpoint this one depends on. Set this when your current reasoning step was triggered by or depends on a previous checkpoint. Enables causal chain analysis."
                    ),
            },
        },
        async ({ session_id, checkpoint_type, content, metadata, tags, parent_checkpoint_id }) => {
            try {
                const checkpointId = crypto.randomUUID();
                const now = new Date().toISOString();

                const entry: CheckpointEntry = {
                    id: checkpointId,
                    session_id,
                    checkpoint_type,
                    content,
                    metadata: metadata ?? undefined,
                    tags: tags && tags.length > 0 ? tags : undefined,
                    parent_checkpoint_id: parent_checkpoint_id ?? null,
                    created_at: now,
                };

                await append<CheckpointEntry>(session_id, entry);

                const result: LogCheckpointResult = {
                    logged: true,
                    id: checkpointId,
                    checkpoint_id: checkpointId,
                    session_id,
                    checkpoint_type,
                    parent_checkpoint_id: parent_checkpoint_id ?? null,
                    timestamp: now,
                };

                return buildResponse(result);
            } catch (error) {
                // Surface checkpoint cap as a structured, actionable error
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
