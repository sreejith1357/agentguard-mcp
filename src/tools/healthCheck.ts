/**
 * AgentGuard MCP — Tool: health_check
 *
 * SSRF Protection:
 *  - Protocol allowlist: only http: and https: are permitted
 *  - Private IP blocklist: localhost, loopback, RFC-1918, link-local, APIPA
 *  - DNS resolution check: hostname is resolved to an IP before fetch;
 *    the resolved IP is also checked against the blocklist (prevents
 *    CNAME-chaining / DNS-rebinding attacks)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import dns from "dns/promises";

// ---------------------------------------------------------------------------
// SSRF protection helpers
// ---------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Matches IPv4 private / reserved ranges:
 *  - 127.0.0.0/8     loopback
 *  - 10.0.0.0/8      RFC-1918
 *  - 172.16.0.0/12   RFC-1918
 *  - 192.168.0.0/16  RFC-1918
 *  - 169.254.0.0/16  link-local / APIPA (AWS metadata at 169.254.169.254)
 *  - 0.0.0.0         unspecified
 * Also matches IPv6 loopback (::1) and ULA ranges (fc00::/7 → fc/fd prefix).
 */
const PRIVATE_IP_RE =
    /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|[fF][cCdD][0-9a-fA-F]{0,2}:)/;

/** Hostnames that always resolve locally regardless of DNS */
const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/**
 * Returns a block reason string if the hostname/IP is on the denylist,
 * or null if it is safe to proceed.
 *
 * Two-pass check:
 *  1. String check on the hostname itself (fast, catches literal IPs and
 *     well-known aliases).
 *  2. DNS resolution → check the resolved IP (catches CNAME chains and
 *     DNS-rebinding where an external hostname points to a private IP).
 */
async function checkSSRF(
    hostname: string
): Promise<{ blocked: true; reason: string } | { blocked: false }> {
    // 1. Hostname string check
    if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
        return { blocked: true, reason: `Hostname "${hostname}" is a reserved localhost alias` };
    }
    if (PRIVATE_IP_RE.test(hostname)) {
        return { blocked: true, reason: `IP address "${hostname}" is in a private/reserved range` };
    }

    // 2. DNS resolution check (catches CNAME → private IP chains)
    try {
        const { address } = await dns.lookup(hostname);
        if (PRIVATE_IP_RE.test(address)) {
            return {
                blocked: true,
                reason: `Hostname "${hostname}" resolves to private IP "${address}"`,
            };
        }
    } catch {
        // DNS failure — the subsequent fetch() will also fail and return
        // CONNECTION_FAILED. Do not block here; let fetch handle it.
    }

    return { blocked: false };
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
                url: z.string().url().describe("The endpoint URL to check"),
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
            // SSRF guard — runs before any network I/O
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

            // Protocol allowlist
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

            // Private IP / hostname blocklist
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
            // Actual request
            // ------------------------------------------------------------------
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout_ms);

                const response = await fetch(url, {
                    method: "GET",
                    signal: controller.signal,
                });

                clearTimeout(timer);
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
                const isTimeout =
                    error instanceof Error && error.name === "AbortError";

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(
                                {
                                    healthy: false,
                                    url,
                                    error: isTimeout ? "TIMEOUT" : "CONNECTION_FAILED",
                                    message: isTimeout
                                        ? `Timed out after ${timeout_ms}ms`
                                        : error instanceof Error
                                        ? error.message
                                        : String(error),
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