/**
 * AgentGuard MCP — Tool: get_session_history
 *
 * Retrieves prior reasoning checkpoints logged via log_checkpoint, giving
 * agents persistent memory across sessions with SQL-indexed filtering & pagination.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { querySessionHistoryAsync } from "../utils/storage.js";
import type { SessionHistoryResult } from "../types/index.js";

export function getSessionHistoryTool(server: McpServer): void {
    server.registerTool(
        "get_session_history",
        {
            description:
                "Retrieve prior reasoning checkpoints and tool call history for a session, giving your agent persistent memory across sessions. " +
                "Supports filtering by checkpoint type, time range, tags (AND/OR), and cursor/offset pagination.",
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
                    .describe("Maximum number of entries to return (default 50, max 500)."),
                offset: z
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .default(0)
                    .describe("Number of matching entries to skip from the start for chronological pagination (default 0)."),
                checkpoint_type: z
                    .string()
                    .min(1)
                    .max(64)
                    .optional()
                    .describe("Filter entries by checkpoint type (e.g. 'reasoning', 'decision', 'tool_call', 'error', 'milestone', 'observation'). Omit for all."),
                since_timestamp: z
                    .string()
                    .optional()
                    .describe("ISO 8601 datetime string. Only return entries created at or after this time."),
                until_timestamp: z
                    .string()
                    .optional()
                    .describe("ISO 8601 datetime string. Only return entries created at or before this time."),
                tags: z
                    .array(z.string().min(1))
                    .optional()
                    .describe("Filter by tags. Use tag_match to control AND ('all') vs OR ('any') logic."),
                tag_match: z
                    .enum(["all", "any"])
                    .optional()
                    .default("all")
                    .describe("How tags are matched: 'all' requires every tag (default), 'any' requires at least one tag."),
            },
        },
        async ({ session_id, limit, offset, checkpoint_type, since_timestamp, until_timestamp, tags, tag_match }) => {
            try {
                if (since_timestamp) {
                    const sinceDate = new Date(since_timestamp);
                    if (Number.isNaN(sinceDate.getTime())) {
                        return buildResponse({
                            error: "INVALID_TIMESTAMP",
                            message: `since_timestamp "${since_timestamp}" is not a valid ISO 8601 date`,
                            session_id,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }

                if (until_timestamp) {
                    const untilDate = new Date(until_timestamp);
                    if (Number.isNaN(untilDate.getTime())) {
                        return buildResponse({
                            error: "INVALID_TIMESTAMP",
                            message: `until_timestamp "${until_timestamp}" is not a valid ISO 8601 date`,
                            session_id,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }

                const effectiveLimit = limit ?? 50;
                const effectiveOffset = offset ?? 0;
                const effectiveTagMatch = tag_match ?? "all";

                const { entries: paginated, totalFound, hasMore } = await querySessionHistoryAsync({
                    session_id,
                    limit: effectiveLimit,
                    offset: effectiveOffset,
                    checkpoint_type,
                    since_timestamp,
                    until_timestamp,
                    tags,
                    tag_match: effectiveTagMatch,
                });

                let oldestEntryAt: string | null = null;
                let newestEntryAt: string | null = null;

                if (paginated.length > 0) {
                    const timestamps = paginated
                        .map((e) => new Date(e.created_at).getTime())
                        .filter((t) => !Number.isNaN(t));

                    if (timestamps.length > 0) {
                        oldestEntryAt = new Date(Math.min(...timestamps)).toISOString();
                        newestEntryAt = new Date(Math.max(...timestamps)).toISOString();
                    }
                }

                const result: SessionHistoryResult = {
                    session_id,
                    total_found: totalFound,
                    returned_count: paginated.length,
                    has_more: Boolean(hasMore),
                    entries: paginated,
                    oldest_entry_at: oldestEntryAt,
                    newest_entry_at: newestEntryAt,
                    filters_applied: {
                        ...(checkpoint_type && { checkpoint_type }),
                        ...(since_timestamp && { since_timestamp }),
                        ...(until_timestamp && { until_timestamp }),
                        ...(tags && tags.length > 0 && { tags, tag_match: effectiveTagMatch }),
                        ...(effectiveOffset > 0 && { offset: effectiveOffset }),
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
