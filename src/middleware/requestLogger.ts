/**
 * AgentGuard MCP v3.1.2 — Request Lifecycle & Telemetry Middleware
 *
 * Cleanly captures MCP tool execution timing and completion errors without
 * fragile monkey-patching inside index.ts.
 */

import type { Request, Response } from "express";
import { logCall } from "../utils/callLogger.js";
import type { TenantIdentity } from "../utils/auth.js";

/**
 * Extracts a JSON-RPC / MCP error code from a serialized MCP response payload if present.
 */
function detectMcpErrorCode(body: string, statusCode: number): { success: boolean; errorCode?: string } {
    if (statusCode >= 400) {
        return { success: false, errorCode: `HTTP_${statusCode}` };
    }

    if (
        body.includes('"isError":true') ||
        body.includes('"_error"') ||
        body.includes('"error":{') ||
        body.includes('"error": {')
    ) {
        try {
            const match =
                body.match(/"error"\s*:\s*"([^"]+)"/) ||
                body.match(/"code"\s*:\s*"?([^",}\s]+)"?/);
            return { success: false, errorCode: match?.[1] || "MCP_ERROR" };
        } catch {
            return { success: false, errorCode: "MCP_ERROR" };
        }
    }

    return { success: true };
}

/**
 * Attaches response capture and `finish` event listener to log MCP tool telemetry.
 */
export function attachMcpCallTelemetry(req: Request, res: Response, tenantCtx?: TenantIdentity): void {
    const startTime = Date.now();
    const toolName = req.body?.params?.name || req.body?.method || "unknown";
    const tenantId = tenantCtx?.tenant_id || "default-tenant";
    const projectId = tenantCtx?.project_id || "default-project";
    const env = tenantCtx?.env || (process.env.AGENTGUARD_API_KEY ? "production" : "development");

    const chunks: string[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = function (chunk: any, ...args: any[]) {
        if (chunk && chunks.length < 32) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        }
        return origWrite(chunk, ...args);
    };

    res.end = function (chunk?: any, ...args: any[]) {
        if (chunk && chunks.length < 32) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        }
        return origEnd(chunk, ...args);
    };

    res.once("finish", () => {
        const responseTime = Date.now() - startTime;
        const body = chunks.join("");
        const outcome = detectMcpErrorCode(body, res.statusCode);

        logCall({
            tenant_id: tenantId,
            project_id: projectId,
            env,
            tool_name: toolName,
            success: outcome.success,
            response_time_ms: responseTime,
            ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
        });
    });
}

