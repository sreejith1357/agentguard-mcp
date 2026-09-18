/**
 * AgentGuard MCP — Response Builder Utility
 *
 * Centralises construction of the MCP-compliant tool return shape.
 * The SDK's ToolCallback expects a type with an index signature `[x: string]: unknown`
 * in addition to the content array. We satisfy this by returning a plain object
 * literal which TypeScript structurally matches to the SDK's CallToolResult.
 *
 * Avoids duplication across every tool handler.
 */

/**
 * Wrap any serialisable payload in the MCP text-content envelope.
 * Pretty-prints the JSON with 2-space indentation so that agents and
 * developers reading raw responses get a human-readable structure.
 *
 * Returns a plain object literal to satisfy the SDK's structural type
 * (which requires an index signature in addition to `content`).
 */
export function buildResponse<T extends object>(payload: T): {
    content: { type: "text"; text: string }[];
    [key: string]: unknown;
} {
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}

/**
 * Build a standardised error envelope for unexpected failures that escape
 * the tool's own error handling.  Includes the error class name and message
 * so the agent can log or surface a meaningful diagnostic.
 */
export function buildErrorResponse(
    tool: string,
    error: unknown
): { content: { type: "text"; text: string }[]; [key: string]: unknown } {
    const message =
        error instanceof Error ? error.message : String(error);
    const name =
        error instanceof Error ? error.name : "UnknownError";

    return buildResponse({
        tool,
        error: name,
        message,
        timestamp: new Date().toISOString(),
    });
}
