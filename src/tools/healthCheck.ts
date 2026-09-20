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

export type { BlockedCategory, SSRFCheckResult };
export { getSSRFBlockCategory, isPrivateOrReservedIP };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * SSRF Guard with DNS resolution check:
 * 1. Static check on raw hostname string
 * 2. DNS resolution (A & AAAA) -> validate ALL resolved IPs against blocklist
 */
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
        // General DNS resolution errors handled during execution
        return { blocked: false };
    }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function healthCheckTool(server: McpServer): void {
    server.registerTool(
        "health_check",
        {
            description:
                "Test if an MCP server or API endpoint is alive and responding correctly before your agent depends on it. Returns response time, status code, and a clear healthy/unhealthy verdict.",
            inputSchema: {
                url: z
                    .string()
                    .url()
                    .refine((val) => !val.startsWith("data:"), {
                        message: "data: URIs are not permitted",
                    })
                    .describe("The endpoint URL to check"),
                expected_status: z
                    .number()
                    .optional()
                    .default(200)
                    .describe("Expected HTTP status code (default: 200)"),
                timeout_ms: z
                    .number()
                    .optional()
                    .default(5000)
                    .describe("Request timeout in milliseconds (default: 5000)"),
            },
        },
        async ({ url, expected_status, timeout_ms }) => {
            const startTime = Date.now();

            // ------------------------------------------------------------------
            // 1. URL Parsing & Protocol Allowlist
            // ------------------------------------------------------------------
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    healthy: false,
                                    url,
                                    error: "INVALID_URL",
                                    message: "URL could not be parsed",
                                    verdict: "❌ Invalid URL — do not proceed",
                                    timestamp: new Date().toISOString(),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    healthy: false,
                                    url,
                                    error: "BLOCKED_PROTOCOL",
                                    message: `Protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`,
                                    verdict: "❌ Blocked — do not proceed",
                                    timestamp: new Date().toISOString(),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            // ------------------------------------------------------------------
            // 2. DNS Pre-Resolution & Comprehensive CIDR Check
            // ------------------------------------------------------------------
            const ssrf = await checkSSRF(parsed.hostname);
            if (ssrf.blocked) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    healthy: false,
                                    url,
                                    error: "BLOCKED_PRIVATE_IP",
                                    blocked_category: ssrf.category,
                                    message: ssrf.reason,
                                    verdict: "❌ Blocked — private/internal addresses are not reachable",
                                    timestamp: new Date().toISOString(),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            // ------------------------------------------------------------------
            // 3. Socket-Level IP-Pinned Request Execution
            // ------------------------------------------------------------------
            try {
                const response = await executeSSRFRequest(url, {
                    timeoutMs: timeout_ms,
                    maxRedirects: 5,
                });

                const responseTime = Date.now() - startTime;
                const isHealthy = response.status === expected_status;

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    healthy: isHealthy,
                                    url,
                                    status_code: response.status,
                                    expected_status,
                                    response_time_ms: responseTime,
                                    redirects_followed: response.redirectsFollowed,
                                    verdict: isHealthy
                                        ? `✅ Healthy — responded in ${responseTime}ms`
                                        : `❌ Got ${response.status}, expected ${expected_status}`,
                                    timestamp: new Date().toISOString(),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error: unknown) {
                const responseTime = Date.now() - startTime;

                if (error instanceof SSRFBlockError) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    {
                                        healthy: false,
                                        url,
                                        error: "BLOCKED_PRIVATE_IP",
                                        blocked_category: error.category,
                                        message: error.message,
                                        verdict: "❌ Blocked — private/internal addresses are not reachable",
                                        timestamp: new Date().toISOString(),
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }

                const msg = error instanceof Error ? error.message : String(error);
                const isTimeout = msg.includes("TIMEOUT");

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    healthy: false,
                                    url,
                                    error: isTimeout ? "TIMEOUT" : "CONNECTION_FAILED",
                                    message: msg,
                                    response_time_ms: responseTime,
                                    verdict: `❌ ${isTimeout ? "Timeout" : "Failed"} — do not proceed`,
                                    timestamp: new Date().toISOString(),
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }
        }
    );
}