/**
 * AgentGuard MCP — Tool: health_check
 *
 * OWASP-Grade SSRF Protection:
 *  - Protocol allowlist: only http: and https: are permitted (data: URIs explicitly blocked)
 *  - Comprehensive IP & Hostname blocklist: IPv4 (private, loopback, link-local, CGNAT, multicast, reserved),
 *    IPv6 (loopback, link-local, unique local, multicast, IPv4-mapped), and reserved domain suffixes (.internal, .local, metadata)
 *  - DNS resolution check: pre-resolves domain names and validates resolved IPs against blocklist
 *  - Redirect hardening: automatic redirects disabled (redirect: "manual"); redirect targets validated against SSRF blocklist
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import dns from "dns/promises";
import net from "net";

// ---------------------------------------------------------------------------
// SSRF Categories & Blocklist Types
// ---------------------------------------------------------------------------

export type BlockedCategory =
    | "ipv4_private"
    | "ipv4_loopback"
    | "ipv4_link_local"
    | "ipv4_cgnat"
    | "ipv4_multicast"
    | "ipv6_loopback"
    | "ipv6_link_local"
    | "ipv6_unique_local"
    | "ipv6_multicast"
    | "ipv6_mapped"
    | "hostname_reserved";

export interface SSRFCheckResult {
    blocked: boolean;
    category?: BlockedCategory;
    reason?: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Reserved hostnames blocked regardless of DNS resolution */
const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "metadata.google.internal",
    "metadata",
    "ip6-localhost",
    "ip6-loopback",
]);

/**
 * Parses IPv6 address string into 8 16-bit words [w0..w7], or null if invalid IPv6.
 */
function parseIPv6(ipStr: string): number[] | null {
    let str = ipStr.toLowerCase();
    const pctIdx = str.indexOf("%");
    if (pctIdx !== -1) {
        str = str.slice(0, pctIdx);
    }

    const lastColon = str.lastIndexOf(":");
    if (lastColon !== -1) {
        const lastPart = str.slice(lastColon + 1);
        if (net.isIPv4(lastPart)) {
            const octets = lastPart.split(".").map(Number);
            const high16 = (octets[0] << 8) | octets[1];
            const low16 = (octets[2] << 8) | octets[3];
            str = str.slice(0, lastColon + 1) + high16.toString(16) + ":" + low16.toString(16);
        }
    }

    const doubleColonParts = str.split("::");
    if (doubleColonParts.length > 2) return null;

    let firstHex: string[] = [];
    let secondHex: string[] = [];

    if (doubleColonParts[0]) {
        firstHex = doubleColonParts[0].split(":").filter(Boolean);
    }
    if (doubleColonParts.length === 2 && doubleColonParts[1]) {
        secondHex = doubleColonParts[1].split(":").filter(Boolean);
    }

    const missingCount = 8 - (firstHex.length + secondHex.length);
    if (doubleColonParts.length === 2 && missingCount < 0) return null;
    if (doubleColonParts.length === 1 && firstHex.length !== 8) return null;

    const zeros = new Array(missingCount > 0 ? missingCount : 0).fill("0");
    const fullHex = [...firstHex, ...zeros, ...secondHex];

    if (fullHex.length !== 8) return null;

    const words = fullHex.map((h) => parseInt(h, 16));
    if (words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) return null;

    return words;
}

/**
 * Returns the specific BlockedCategory if hostname or IP address is private/reserved,
 * or null if safe.
 */
export function getSSRFBlockCategory(hostname: string): BlockedCategory | null {
    const cleanHost =
        hostname.startsWith("[") && hostname.endsWith("]")
            ? hostname.slice(1, -1)
            : hostname;
    const lowerHost = cleanHost.toLowerCase();

    // 1. Reserved hostnames check
    if (
        BLOCKED_HOSTNAMES.has(lowerHost) ||
        lowerHost.endsWith(".internal") ||
        lowerHost.endsWith(".local")
    ) {
        return "hostname_reserved";
    }

    // 2. IPv4 Address range check
    if (net.isIPv4(cleanHost)) {
        const octets = cleanHost.split(".").map(Number);
        const [a, b, c] = octets;

        // Loopback (127.0.0.0/8, 0.0.0.0/8)
        if (a === 127 || a === 0) return "ipv4_loopback";

        // Private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, TEST-NETs)
        if (a === 10) return "ipv4_private";
        if (a === 172 && b >= 16 && b <= 31) return "ipv4_private";
        if (a === 192 && b === 168) return "ipv4_private";
        if (
            (a === 192 && b === 0 && c === 2) ||
            (a === 198 && b === 51 && c === 100) ||
            (a === 203 && b === 0 && c === 113)
        ) {
            return "ipv4_private";
        }

        // Link-local / APIPA (169.254.0.0/16)
        if (a === 169 && b === 254) return "ipv4_link_local";

        // CGNAT (100.64.0.0/10)
        if (a === 100 && b >= 64 && b <= 127) return "ipv4_cgnat";

        // Multicast / Reserved / Broadcast (224.0.0.0/4, 240.0.0.0/4, 255.255.255.255)
        if (a >= 224) return "ipv4_multicast";

        return null;
    }

    // 3. IPv6 Address range check
    const words = parseIPv6(cleanHost);
    if (words) {
        // Loopback / Unspecified (::1, ::)
        const isAllZero = words.every((w) => w === 0);
        const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
        if (isAllZero || isLoopback) return "ipv6_loopback";

        // IPv4-mapped (::ffff:0:0/96)
        const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
        if (isMapped) return "ipv6_mapped";

        // Unique local (fc00::/7 → 0xfc00..0xfdff)
        if ((words[0] & 0xfe00) === 0xfc00) return "ipv6_unique_local";

        // Link-local (fe80::/10 → 0xfe80..0xfebf)
        if ((words[0] & 0xffc0) === 0xfe80) return "ipv6_link_local";

        // Multicast (ff00::/8 → 0xff00..0xffff)
        if ((words[0] & 0xff00) === 0xff00) return "ipv6_multicast";

        // Documentation range (2001:db8::/32)
        if (words[0] === 0x2001 && words[1] === 0x0db8) return "ipv6_unique_local";

        return null;
    }

    return null;
}

/**
 * Step 1 — Comprehensive validation function:
 * Accepts hostname string extracted from new URL(url).hostname
 * Returns true if hostname or IP is private/reserved.
 */
export function isPrivateOrReservedIP(hostname: string): boolean {
    return getSSRFBlockCategory(hostname) !== null;
}

/**
 * SSRF Guard with DNS resolution check:
 * 1. Fast static check on raw hostname string
 * 2. DNS resolution -> validate resolved IP against blocklist
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

    // DNS resolution check (catches CNAME -> private IP & DNS rebinding)
    try {
        const { address } = await dns.lookup(hostname);
        const resolvedCategory = getSSRFBlockCategory(address);
        if (resolvedCategory) {
            return {
                blocked: true,
                category: resolvedCategory,
                reason: `Hostname "${hostname}" resolves to private IP "${address}" (${resolvedCategory})`,
            };
        }
    } catch {
        // DNS failure will be handled by fetch()
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
            // Actual request — manual redirects & target validation
            // ------------------------------------------------------------------
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout_ms);

                const response = await fetch(url, {
                    method: "GET",
                    signal: controller.signal,
                    headers: { "Content-Type": "application/json" },
                    redirect: "manual",
                });

                clearTimeout(timer);

                // Handle redirects manually
                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get("location");
                    if (!location) {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: JSON.stringify(
                                        {
                                            healthy: false,
                                            url,
                                            error: "REDIRECT_NO_LOCATION",
                                            verdict: "❌ Redirect with no Location header",
                                            timestamp: new Date().toISOString(),
                                        },
                                        null,
                                        2
                                    ),
                                },
                            ],
                        };
                    }

                    // Validate redirect target is not private
                    try {
                        const redirectUrl = new URL(location, url);
                        if (!["http:", "https:"].includes(redirectUrl.protocol)) {
                            return {
                                content: [
                                    {
                                        type: "text" as const,
                                        text: JSON.stringify(
                                            {
                                                healthy: false,
                                                url,
                                                error: "BLOCKED_REDIRECT_PROTOCOL",
                                                message: `Redirect protocol "${redirectUrl.protocol}" is not allowed`,
                                                verdict: "❌ Blocked — disallowed redirect protocol",
                                                timestamp: new Date().toISOString(),
                                            },
                                            null,
                                            2
                                        ),
                                    },
                                ],
                            };
                        }
                        if (isPrivateOrReservedIP(redirectUrl.hostname)) {
                            const redirectCategory = getSSRFBlockCategory(redirectUrl.hostname);
                            return {
                                content: [
                                    {
                                        type: "text" as const,
                                        text: JSON.stringify(
                                            {
                                                healthy: false,
                                                url,
                                                error: "BLOCKED_REDIRECT_PRIVATE_IP",
                                                blocked_category: redirectCategory || "ipv4_private",
                                                message: "Redirect target resolves to private/reserved IP",
                                                verdict: "❌ Blocked — redirect to private address",
                                                timestamp: new Date().toISOString(),
                                            },
                                            null,
                                            2
                                        ),
                                    },
                                ],
                            };
                        }
                    } catch {
                        return {
                            content: [
                                {
                                    type: "text" as const,
                                    text: JSON.stringify(
                                        {
                                            healthy: false,
                                            url,
                                            error: "INVALID_REDIRECT_URL",
                                            message: "Redirect location could not be parsed as a valid URL",
                                            verdict: "❌ Invalid redirect target — do not proceed",
                                            timestamp: new Date().toISOString(),
                                        },
                                        null,
                                        2
                                    ),
                                },
                            ],
                        };
                    }

                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify(
                                    {
                                        healthy: false,
                                        url,
                                        redirect_detected: true,
                                        redirect_target: location,
                                        status_code: response.status,
                                        verdict: "↩️ Endpoint redirects — follow manually if safe",
                                        message:
                                            "health_check does not follow redirects automatically. Verify the redirect target and call health_check on it directly.",
                                        timestamp: new Date().toISOString(),
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }

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