/**
 * AgentGuard MCP — Tool: get_session_history
 *
 * Retrieves prior reasoning checkpoints logged via log_checkpoint, giving
 * agents persistent memory across sessions with SQL-indexed filtering support.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { querySessionHistory } from "../utils/storage.js";
import type { SessionHistoryResult } from "../types/index.js";

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function getSessionHistoryTool(server: McpServer): void {
    server.registerTool(
        "get_session_history",
        {
            description: "Retrieve prior reasoning checkpoints and tool call history for a session, giving your agent persistent memory across sessions. Supports filtering by checkpoint type, timestamp, and tags.",
            inputSchema: {
                session_id: z
                    .string()
                    .min(1)
                    .max(128)
                    .describe("The session ID to retrieve history for"),
                limit: z
                    .number()
                    .int()
                    .min(1)
                    .max(500)
                    .optional()
                    .default(50)
                    .describe("Maximum number of entries to return (default 50, max 500). Applied after all filters."),
                checkpoint_type: z
                    .enum(["reasoning", "decision", "tool_call", "error", "milestone"])
                    .optional()
                    .describe("Filter entries by checkpoint type. Omit to return all types."),
                since_timestamp: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 datetime string. Only return entries created at or after this time. Example: '2024-01-15T10:00:00Z'"
                    ),
                tags: z
                    .array(z.string().min(1))
                    .optional()
                    .describe(
                        "Filter by tags (AND logic — entries must have ALL specified tags). Omit to return all."
                    ),
            },
        },
        async ({ session_id, limit, checkpoint_type, since_timestamp, tags }) => {
            try {
                // Parse since_timestamp upfront to fail fast on bad input
                if (since_timestamp) {
                    const sinceDate = new Date(since_timestamp);
                    if (isNaN(sinceDate.getTime())) {
                        return buildResponse({
                            error: "INVALID_TIMESTAMP",
                            message: `since_timestamp "${since_timestamp}" is not a valid ISO 8601 date`,
                            session_id,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }

                // Query database with indexed SQL execution
                const effectiveLimit = limit ?? 50;
                const { entries: paginated, totalFound } = querySessionHistory({
                    session_id,
                    limit: effectiveLimit,
                    checkpoint_type,
                    since_timestamp,
                    tags,
                });

                // Compute time bounds from paginated results
                let oldestEntryAt: string | null = null;
                let newestEntryAt: string | null = null;

                if (paginated.length > 0) {
                    const timestamps = paginated
                        .map((e) => new Date(e.created_at).getTime())
                        .filter((t) => !isNaN(t));

                    if (timestamps.length > 0) {
                        oldestEntryAt = new Date(Math.min(...timestamps)).toISOString();
                        newestEntryAt = new Date(Math.max(...timestamps)).toISOString();
                    }
                }

                const result: SessionHistoryResult = {
                    session_id,
                    total_found: totalFound,
                    entries: paginated,
                    oldest_entry_at: oldestEntryAt,
                    newest_entry_at: newestEntryAt,
                    filters_applied: {
                        ...(checkpoint_type && { checkpoint_type }),
                        ...(since_timestamp && { since_timestamp }),
                        ...(tags && tags.length > 0 && { tags }),
                        limit: effectiveLimit,
                    },
                    timestamp: new Date().toISOString(),
                };

                return buildResponse(result);
            } catch (error) {
                return buildErrorResponse("get_session_history", error);
            }
        }
    );
}
