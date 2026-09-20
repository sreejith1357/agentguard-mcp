/**
 * AgentGuard MCP — Socket-Level SSRF & DNS Rebinding Guard
 *
 * Provides OWASP-grade SSRF protection:
 *  1. Full IPv4 and IPv6 CIDR blocklist checking (private, loopback, link-local/APIPA,
 *     CGNAT, multicast, ULA, documentation, zero-conf IPv4-mapped IPv6).
 *  2. Dual A (IPv4) & AAAA (IPv6) DNS pre-resolution via `node:dns/promises`.
 *  3. Instant rejection if ANY resolved IP maps to a restricted CIDR range (eliminates DNS Rebinding TOCTOU).
 *  4. Strict IP Pinning: connects directly to the validated IP address while preserving SNI `servername` and `Host` header.
 *  5. Client-level manual redirect handling with recursive pre-resolution validation on every hop.
 */

import type { LookupOptions } from "node:dns";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// SSRF Block Categories
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
    resolvedIps?: string[];
}

export class SSRFBlockError extends Error {
    category: BlockedCategory;
    blockedIp?: string;

    constructor(message: string, category: BlockedCategory, blockedIp?: string) {
        super(message);
        this.name = "SSRFBlockError";
        this.category = category;
        this.blockedIp = blockedIp;
    }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Reserved hostnames blocked regardless of DNS resolution */
const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "metadata.google.internal",
    "metadata",
    "ip6-localhost",
    "ip6-loopback",
    "localhost.localdomain",
]);

// ---------------------------------------------------------------------------
// IPv6 Parsing & Zero-Conf / IPv4-Mapped Conversion
// ---------------------------------------------------------------------------

/**
 * Parses an IPv6 address string into 8 16-bit words [w0..w7], or null if invalid IPv6.
 * Correctly normalizes dot-notation embedded IPv4 (e.g. `::ffff:127.0.0.1` or `::ffff:169.254.169.254`).
 */

export function parseIPv6(ipStr: string): number[] | null {
    let str = ipStr.toLowerCase().trim();
    if (str.startsWith("[") && str.endsWith("]")) {
        str = str.slice(1, -1);
    }
    const pctIdx = str.indexOf("%");
    if (pctIdx !== -1) {
        str = str.slice(0, pctIdx);
    }

    const lastColon = str.lastIndexOf(":");
    if (lastColon !== -1) {
        const lastPart = str.slice(lastColon + 1);
        if (net.isIPv4(lastPart)) {
            const octets = lastPart.split(".").map(Number);
            if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null;
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
 * Extracts embedded IPv4 string from IPv4-mapped or zero-conf IPv6 address if present.
 * Example: `::ffff:127.0.0.1` -> `"127.0.0.1"`, `::ffff:7f00:1` -> `"127.0.0.1"`,
 * `::ffff:a9fe:a9fe` -> `"169.254.169.254"`.
 */
export function extractEmbeddedIPv4(words: number[]): string | null {
    // Check if IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::0:0/96)
    const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
    const isCompat = words.slice(0, 6).every((w) => w === 0);

    if (isMapped || isCompat) {
        const w6 = words[6];
        const w7 = words[7];
        const b1 = (w6 >> 8) & 0xff;
        const b2 = w6 & 0xff;
        const b3 = (w7 >> 8) & 0xff;
        const b4 = w7 & 0xff;
        return `${b1}.${b2}.${b3}.${b4}`;
    }

    return null;
}

// ---------------------------------------------------------------------------
// CIDR Range Validation Engine
// ---------------------------------------------------------------------------

/**
 * Returns the specific BlockedCategory if hostname or IP address is private/reserved,
 * or null if safe.
 */
export function getSSRFBlockCategory(hostname: string): BlockedCategory | null {
    let cleanHost = hostname.trim();
    if (cleanHost.startsWith("[") && cleanHost.endsWith("]")) {
        cleanHost = cleanHost.slice(1, -1);
    }
    const lowerHost = cleanHost.toLowerCase();

    // 1. Reserved hostname check
    if (
        BLOCKED_HOSTNAMES.has(lowerHost) ||
        lowerHost.endsWith(".internal") ||
        lowerHost.endsWith(".local") ||
        lowerHost.endsWith(".localhost") ||
        lowerHost.endsWith(".localdomain")
    ) {
        return "hostname_reserved";
    }

    // 2. Direct IPv4 address check
    if (net.isIPv4(cleanHost)) {
        return checkIPv4Octets(cleanHost.split(".").map(Number));
    }

    // 3. IPv6 Address check
    const words = parseIPv6(cleanHost);
    if (words) {
        // Loopback / Unspecified (::1, ::)
        const isAllZero = words.every((w) => w === 0);
        const isLoopback = words.slice(0, 7).every((w) => w === 0) && words[7] === 1;
        if (isAllZero || isLoopback) return "ipv6_loopback";

        // Check embedded IPv4 (e.g. ::ffff:127.0.0.1, ::ffff:169.254.169.254)
        const embeddedIPv4 = extractEmbeddedIPv4(words);
        if (embeddedIPv4) {
            const mappedIPv4Category = checkIPv4Octets(embeddedIPv4.split(".").map(Number));
            if (mappedIPv4Category) {
                return mappedIPv4Category;
            }
            return "ipv6_mapped";
        }

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

function checkIPv4Octets(octets: number[]): BlockedCategory | null {
    if (octets.length !== 4 || octets.some((o) => isNaN(o) || o < 0 || o > 255)) {
        return "ipv4_private";
    }

    const [a, b, c] = octets;

    // Loopback / Current network (127.0.0.0/8, 0.0.0.0/8)
    if (a === 127 || a === 0) return "ipv4_loopback";

    // Private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, TEST-NETs, Benchmark)
    if (a === 10) return "ipv4_private";
    if (a === 172 && b >= 16 && b <= 31) return "ipv4_private";
    if (a === 192 && b === 168) return "ipv4_private";
    if (
        (a === 192 && b === 0 && c === 2) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        (a === 198 && (b === 18 || b === 19))
    ) {
        return "ipv4_private";
    }

    // Link-local / APIPA / Cloud Instance Metadata (169.254.0.0/16)
    if (a === 169 && b === 254) return "ipv4_link_local";

    // CGNAT (100.64.0.0/10)
    if (a === 100 && b >= 64 && b <= 127) return "ipv4_cgnat";

    // Multicast / Reserved / Broadcast (224.0.0.0/4, 240.0.0.0/4, 255.255.255.255)
    if (a >= 224) return "ipv4_multicast";

    return null;
}

export function isPrivateOrReservedIP(hostname: string): boolean {
    return getSSRFBlockCategory(hostname) !== null;
}

// ---------------------------------------------------------------------------
// DNS Pre-Resolution & Comprehensive Validation Wrapper
// ---------------------------------------------------------------------------

/**
 * Pre-resolves both A (IPv4) and AAAA (IPv6) records for `hostname`.
 * Validates EVERY resolved IP address against the CIDR blocklist.
 * If ANY resolved IP is in a restricted block, throws SSRFBlockError immediately.
 */
export async function resolveAndValidateTarget(
    hostname: string,
    options: { allowLoopback?: boolean } = {}
): Promise<string[]> {
    const staticCategory = getSSRFBlockCategory(hostname);
    if (
        staticCategory &&
        !(
            options.allowLoopback &&
            (staticCategory === "ipv4_loopback" || staticCategory === "ipv6_loopback")
        )
    ) {
        throw new SSRFBlockError(
            `Hostname/IP "${hostname}" is in a private/reserved range (${staticCategory})`,
            staticCategory,
            hostname
        );
    }

    // If target is already a valid IP string (IPv4 or IPv6), static check was sufficient
    if (net.isIP(hostname)) {
        return [hostname];
    }

    // Resolve A (IPv4) and AAAA (IPv6) records concurrently
    const [aResults, aaaaResults] = await Promise.all([
        dns.resolve4(hostname).catch(() => [] as string[]),
        dns.resolve6(hostname).catch(() => [] as string[]),
    ]);

    const allResolved = [...new Set([...aResults, ...aaaaResults])];

    if (allResolved.length === 0) {
        // Try standard lookup fallback if resolve4/resolve6 returned nothing
        try {
            const lookupRes = await dns.lookup(hostname, { all: true });
            for (const item of lookupRes) {
                if (item.address) allResolved.push(item.address);
            }
        } catch {
            // DNS resolution failed — caller handles HTTP network error
        }
    }

    const uniqueIps = [...new Set(allResolved)];

    // Validate EVERY resolved IP address against restricted CIDR ranges
    for (const ip of uniqueIps) {
        const category = getSSRFBlockCategory(ip);
        if (
            category &&
            !(
                options.allowLoopback &&
                (category === "ipv4_loopback" || category === "ipv6_loopback")
            )
        ) {
            throw new SSRFBlockError(
                `Hostname "${hostname}" resolved to restricted IP "${ip}" (${category})`,
                category,
                ip
            );
        }
    }

    return uniqueIps;
}

// ---------------------------------------------------------------------------
// Socket-Level Custom Agent & IP-Pinned HTTP Execution
// ---------------------------------------------------------------------------

/**
 * Custom lookup function for http.Agent / https.Agent options.
 * Re-validates target IP at socket connection time.
 */
export function createSSRFLookup(options: { allowLoopback?: boolean } = {}) {
    return async (
        hostname: string,
        opts: LookupOptions,
        callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
    ) => {
        try {
            const safeIps = await resolveAndValidateTarget(hostname, options);
            if (safeIps.length === 0) {
                const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
                err.code = "ENOTFOUND";
                return callback(err, "", 4);
            }
            const chosen = safeIps[0];
            const family = net.isIPv6(chosen) ? 6 : 4;
            callback(null, chosen, family);
        } catch (error) {
            const err = new Error(
                `SSRF_BLOCKED: ${error instanceof Error ? error.message : String(error)}`
            ) as NodeJS.ErrnoException;
            err.code = "ENOTFOUND";
            callback(err, "", 4);
        }
    };
}

export function createSSRFSafeAgents(options: { allowLoopback?: boolean } = {}): {
    httpAgent: http.Agent;
    httpsAgent: https.Agent;
} {
    const lookup = createSSRFLookup(options);
    return {
        httpAgent: new http.Agent({ lookup, keepAlive: false }),
        httpsAgent: new https.Agent({ lookup, keepAlive: false }),
    };
}

export interface SSRFRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxRedirects?: number;
    allowLoopback?: boolean;
}

export interface SSRFResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    url: string;
    responseTimeMs: number;
    redirectsFollowed: number;
}

/**
 * Executes an HTTP/HTTPS request with strict IP Pinning, SNI preservation,
 * and manual redirect evaluation.
 */
export async function executeSSRFRequest(
    targetUrlStr: string,
    options: SSRFRequestOptions = {}
): Promise<SSRFResponse> {
    const {
        method = "GET",
        headers = {},
        timeoutMs = 5000,
        maxRedirects = 5,
        allowLoopback = false,
    } = options;

    let currentUrlStr = targetUrlStr;
    let redirectCount = 0;

    const agents = createSSRFSafeAgents({ allowLoopback });

    try {
        while (true) {
            const startTime = Date.now();
            const parsed = new URL(currentUrlStr);

            if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
                throw new SSRFBlockError(
                    `Protocol "${parsed.protocol}" is not allowed`,
                    "hostname_reserved"
                );
            }

            // 1. DNS Pre-Resolution & Validation (throws immediately if ANY IP is blocked)
            const validatedIps = await resolveAndValidateTarget(parsed.hostname, { allowLoopback });

            const isHttps = parsed.protocol === "https:";
            const defaultPort = isHttps ? 443 : 80;
            const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
            const pinnedIp = validatedIps[0] || parsed.hostname;

            // 2. Format request options for IP Pinning
            const isIPv6 = net.isIPv6(pinnedIp);
            const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;

            const reqHeaders: Record<string, string> = {
                "User-Agent": "AgentGuard-SSRFGuard/2.1",
                ...headers,
                Host: hostHeader,
            };

            const client = isHttps ? https : http;
            const agent = isHttps ? agents.httpsAgent : agents.httpAgent;

            const requestOptions: http.RequestOptions = {
                hostname: pinnedIp,
                port,
                path: parsed.pathname + parsed.search,
                method,
                headers: reqHeaders,
                agent,
                timeout: timeoutMs,
            };

            if (isHttps) {
                (requestOptions as https.RequestOptions).servername = parsed.hostname; // TLS SNI extension
            }

            // 3. Issue IP-Pinned Request
            const response = await new Promise<{
                status: number;
                statusText: string;
                headers: Record<string, string>;
                location?: string;
            }>((resolve, reject) => {
                const req = client.request(requestOptions, (res) => {
                    const resHeaders: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) {
                        if (v) resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
                    }
                    resolve({
                        status: res.statusCode || 0,
                        statusText: res.statusMessage || "",
                        headers: resHeaders,
                        location: resHeaders["location"],
                    });
                    res.resume(); // Discard body for health check
                });

                req.on("error", (err) => reject(err));
                req.on("timeout", () => {
                    req.destroy();
                    reject(new Error(`TIMEOUT: Request timed out after ${timeoutMs}ms`));
                });

                req.end();
            });

            const elapsed = Date.now() - startTime;

            // 4. Handle Redirects Manually
            if (response.status >= 300 && response.status < 400 && response.location) {
                if (redirectCount >= maxRedirects) {
                    throw new Error(`TOO_MANY_REDIRECTS: Exceeded max redirects (${maxRedirects})`);
                }

                const redirectUrl = new URL(response.location, currentUrlStr);
                currentUrlStr = redirectUrl.toString();
                redirectCount++;
                continue;
            }

            return {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                url: currentUrlStr,
                responseTimeMs: elapsed,
                redirectsFollowed: redirectCount,
            };
        }
    } finally {
        agents.httpAgent.destroy();
        agents.httpsAgent.destroy();
    }
}
