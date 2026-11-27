/**
 * AgentGuard MCP — Tool: health_check
 *
 * OWASP-Grade SSRF & DNS Rebinding Protection:
 *  - Protocol allowlist: only http: and https: permitted.
 *  - Comprehensive IP & Hostname CIDR blocklist (IPv4 & IPv6).
 *  - Dual A & AAAA DNS pre-resolution via node:dns/promises.
 *  - Instant rejection if ANY resolved IP maps to a restricted block (eliminates DNS Rebinding TOCTOU).
 *  - Strict Socket-Level IP Pinning: connects directly to validated IP while preserving SNI servername & Host header.
 *  - Client-level manual redirect handling with recursive pre-resolution validation on every hop.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    BlockedCategory,
    SSRFCheckResult,
    SSRFBlockError,
    getSSRFBlockCategory,
    isPrivateOrReservedIP,
    resolveAndValidateTarget,
    executeSSRFRequest,
} from "../utils/ssrfGuard.js";
import { buildResponse } from "../utils/response.js";

export type { BlockedCategory, SSRFCheckResult };
export { getSSRFBlockCategory, isPrivateOrReservedIP };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_RESPONSE_HEADERS = ["content-type", "server", "cache-control", "x-request-id"];

async function checkSSRF(hostname: string): Promise<SSRFCheckResult> {
    const stringCategory = getSSRFBlockCategory(hostname);
    if (stringCategory) {
        return {
            blocked: true,
            category: stringCategory,
            reason: `Hostname/IP "${hostname}" is in a private/reserved range (${stringCategory})`,
        };
    }

    try {
        const resolvedIps = await resolveAndValidateTarget(hostname);
        return { blocked: false, resolvedIps };
    } catch (error) {
        if (error instanceof SSRFBlockError) {
            return {
                blocked: true,
                category: error.category,
                reason: error.message,
            };
        }
        return { blocked: false };
    }
}

export function healthCheckTool(server: McpServer): void {
    server.registerTool(
        "health_check",
        {
            description:
                "Test if an external MCP server or HTTP/HTTPS API endpoint is alive and responding correctly before your agent depends on it. " +
                "Built-in OWASP SSRF & DNS rebinding protection blocks private/loopback/metadata IPs automatically. " +
                "Returns response time, status code, optional body substring match, and a healthy/unhealthy verdict.",
            inputSchema: {
                url: z
                    .string()
                    .min(1)
                    .max(2048)
                    .describe("The public HTTP/HTTPS endpoint URL to check"),
                expected_status: z
                    .number()
                    .int()
                    .min(100)
                    .max(599)
                    .optional()
                    .default(200)
                    .describe("Expected HTTP status code (default: 200)"),
                timeout_ms: z
                    .number()
                    .int()
                    .min(100)
                    .max(30000)
                    .optional()
                    .default(5000)
                    .describe("Request timeout in milliseconds (100–30000, default: 5000)"),
                expected_body_contains: z
                    .string()
                    .min(1)
                    .max(500)
                    .optional()
                    .describe("Optional substring that must appear in the response body (up to 64KB inspected)"),
                include_headers: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include selected safe response headers (content-type, server, cache-control)"),
            },
        },
        async ({ url, expected_status, timeout_ms, expected_body_contains, include_headers }) => {
            const startTime = Date.now();

            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                return buildResponse({
                    healthy: false,
                    url,
                    error: "INVALID_URL",
                    message: "URL could not be parsed",
                    verdict: "❌ Invalid URL — do not proceed",
                    timestamp: new Date().toISOString(),
                });
            }

            if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
                return buildResponse({
                    healthy: false,
                    url,
                    error: "BLOCKED_PROTOCOL",
                    message: `Protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`,
                    verdict: "❌ Blocked — do not proceed",
                    timestamp: new Date().toISOString(),
                });
            }

            const ssrf = await checkSSRF(parsed.hostname);
            if (ssrf.blocked) {
                return buildResponse({
                    healthy: false,
                    url,
                    error: "BLOCKED_PRIVATE_IP",
                    blocked_category: ssrf.category,
                    message: ssrf.reason,
                    verdict: "❌ Blocked — private/internal addresses are not reachable",
                    timestamp: new Date().toISOString(),
                });
            }

            try {
                const response = await executeSSRFRequest(url, {
                    timeoutMs: timeout_ms,
                    maxRedirects: 5,
                    captureBody: Boolean(expected_body_contains),
                });

                const responseTime = Date.now() - startTime;
                const statusMatches = response.status === expected_status;
                const bodyMatches = expected_body_contains
                    ? Boolean(response.body && response.body.includes(expected_body_contains))
                    : true;
                const isHealthy = statusMatches && bodyMatches;

                const filteredHeaders: Record<string, string> = {};
                if (include_headers) {
                    for (const h of SAFE_RESPONSE_HEADERS) {
                        if (response.headers[h]) filteredHeaders[h] = response.headers[h];
                    }
                }

                let verdict: string;
                if (isHealthy) {
                    verdict = `✅ Healthy — responded in ${responseTime}ms`;
                } else if (!statusMatches) {
                    verdict = `❌ Got ${response.status}, expected ${expected_status}`;
                } else {
                    verdict = `❌ Status ${response.status} OK, but response body missing "${expected_body_contains}"`;
                }

                return buildResponse({
                    healthy: isHealthy,
                    url,
                    status_code: response.status,
                    expected_status,
                    response_time_ms: responseTime,
                    redirects_followed: response.redirectsFollowed,
                    ...(expected_body_contains ? { body_match: bodyMatches } : {}),
                    ...(include_headers ? { response_headers: filteredHeaders } : {}),
                    verdict,
                    timestamp: new Date().toISOString(),
                });
            } catch (error: unknown) {
                const responseTime = Date.now() - startTime;

                if (error instanceof SSRFBlockError) {
                    return buildResponse({
                        healthy: false,
                        url,
                        error: "BLOCKED_PRIVATE_IP",
                        blocked_category: error.category,
                        message: error.message,
                        verdict: "❌ Blocked — private/internal addresses are not reachable",
                        timestamp: new Date().toISOString(),
                    });
                }

                const msg = error instanceof Error ? error.message : String(error);
                const isTimeout = msg.includes("TIMEOUT");

                return buildResponse({
                    healthy: false,
                    url,
                    error: isTimeout ? "TIMEOUT" : "CONNECTION_FAILED",
                    message: msg,
                    response_time_ms: responseTime,
                    verdict: `❌ ${isTimeout ? "Timeout" : "Failed"} — do not proceed`,
                    timestamp: new Date().toISOString(),
                });
            }
        }
    );
}
