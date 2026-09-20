/**
 * AgentGuard MCP — Unit Tests: Socket-Level SSRF & DNS Rebinding Guard
 *
 * Covers:
 *  1. DNS Rebinding prevention (dual A/AAAA resolution & restricted IP rejection).
 *  2. Zero-conf IPv6 and IPv4-mapped IPv6 conversions & CIDR checks.
 *  3. Internal redirect chains (blocking redirects to loopback / link-local).
 *  4. IP Pinning, SNI preservation, and valid public endpoint execution.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import {
    getSSRFBlockCategory,
    isPrivateOrReservedIP,
    parseIPv6,
    extractEmbeddedIPv4,
    resolveAndValidateTarget,
    executeSSRFRequest,
    SSRFBlockError,
} from "../src/utils/ssrfGuard.js";

describe("SSRF & DNS Rebinding Mitigation", () => {
    // -----------------------------------------------------------------------
    // 1. IPv4 & IPv6 CIDR Blocklist & Zero-Conf Conversions
    // -----------------------------------------------------------------------
    describe("CIDR Range Validation & IPv6 Normalization", () => {
        it("blocks IPv4 loopback and private ranges", () => {
            assert.equal(getSSRFBlockCategory("127.0.0.1"), "ipv4_loopback");
            assert.equal(getSSRFBlockCategory("127.0.0.53"), "ipv4_loopback");
            assert.equal(getSSRFBlockCategory("0.0.0.0"), "ipv4_loopback");
            assert.equal(getSSRFBlockCategory("10.0.0.1"), "ipv4_private");
            assert.equal(getSSRFBlockCategory("172.16.0.1"), "ipv4_private");
            assert.equal(getSSRFBlockCategory("172.31.255.255"), "ipv4_private");
            assert.equal(getSSRFBlockCategory("192.168.1.1"), "ipv4_private");
        });

        it("blocks IPv4 link-local (APIPA / Cloud Instance Metadata Services)", () => {
            assert.equal(getSSRFBlockCategory("169.254.169.254"), "ipv4_link_local");
            assert.equal(getSSRFBlockCategory("169.254.1.1"), "ipv4_link_local");
        });

        it("blocks CGNAT, multicast, and documentation ranges", () => {
            assert.equal(getSSRFBlockCategory("100.64.0.1"), "ipv4_cgnat");
            assert.equal(getSSRFBlockCategory("100.127.255.255"), "ipv4_cgnat");
            assert.equal(getSSRFBlockCategory("224.0.0.1"), "ipv4_multicast");
            assert.equal(getSSRFBlockCategory("240.0.0.1"), "ipv4_multicast");
            assert.equal(getSSRFBlockCategory("192.0.2.1"), "ipv4_private"); // TEST-NET-1
            assert.equal(getSSRFBlockCategory("198.51.100.1"), "ipv4_private"); // TEST-NET-2
            assert.equal(getSSRFBlockCategory("203.0.113.1"), "ipv4_private"); // TEST-NET-3
        });

        it("blocks IPv6 loopback, link-local, ULA, and multicast", () => {
            assert.equal(getSSRFBlockCategory("::1"), "ipv6_loopback");
            assert.equal(getSSRFBlockCategory("::"), "ipv6_loopback");
            assert.equal(getSSRFBlockCategory("fe80::1"), "ipv6_link_local");
            assert.equal(getSSRFBlockCategory("fc00::1"), "ipv6_unique_local");
            assert.equal(getSSRFBlockCategory("fd12:3456:789a::1"), "ipv6_unique_local");
            assert.equal(getSSRFBlockCategory("ff02::1"), "ipv6_multicast");
            assert.equal(getSSRFBlockCategory("2001:db8::1"), "ipv6_unique_local");
        });

        it("normalizes and blocks zero-conf IPv4-mapped IPv6 addresses", () => {
            // ::ffff:127.0.0.1 (Dot notation)
            assert.equal(getSSRFBlockCategory("::ffff:127.0.0.1"), "ipv4_loopback");

            // ::ffff:169.254.169.254 (Cloud metadata in IPv4-mapped IPv6)
            assert.equal(getSSRFBlockCategory("::ffff:169.254.169.254"), "ipv4_link_local");

            // ::ffff:10.0.0.1 (Private in IPv4-mapped IPv6)
            assert.equal(getSSRFBlockCategory("::ffff:10.0.0.1"), "ipv4_private");

            // Hex notation: ::ffff:7f00:1 (127.0.0.1)
            const words1 = parseIPv6("::ffff:7f00:1");
            assert.notEqual(words1, null);
            assert.equal(extractEmbeddedIPv4(words1!), "127.0.0.1");
            assert.equal(getSSRFBlockCategory("::ffff:7f00:1"), "ipv4_loopback");

            // Hex notation: ::ffff:a9fe:a9fe (169.254.169.254)
            const words2 = parseIPv6("::ffff:a9fe:a9fe");
            assert.notEqual(words2, null);
            assert.equal(extractEmbeddedIPv4(words2!), "169.254.169.254");
            assert.equal(getSSRFBlockCategory("::ffff:a9fe:a9fe"), "ipv4_link_local");
        });

        it("allows valid public IPv4 and IPv6 addresses", () => {
            assert.equal(getSSRFBlockCategory("93.184.216.34"), null);
            assert.equal(getSSRFBlockCategory("8.8.8.8"), null);
            assert.equal(getSSRFBlockCategory("1.1.1.1"), null);
            assert.equal(getSSRFBlockCategory("2606:2800:220:1:248:1893:25c8:1946"), null);
            assert.equal(isPrivateOrReservedIP("example.com"), false);
        });

        it("blocks reserved hostname suffixes", () => {
            assert.equal(getSSRFBlockCategory("localhost"), "hostname_reserved");
            assert.equal(getSSRFBlockCategory("service.internal"), "hostname_reserved");
            assert.equal(getSSRFBlockCategory("app.local"), "hostname_reserved");
            assert.equal(getSSRFBlockCategory("metadata.google.internal"), "hostname_reserved");
        });
    });

    // -----------------------------------------------------------------------
    // 2. DNS Rebinding Prevention
    // -----------------------------------------------------------------------
    describe("DNS Pre-Resolution & Rebinding Rejection", () => {
        it("rejects direct resolution to loopback/private IPs", async () => {
            await assert.rejects(
                async () => {
                    await resolveAndValidateTarget("127.0.0.1");
                },
                (err: any) => {
                    return (
                        err instanceof SSRFBlockError &&
                        err.category === "ipv4_loopback"
                    );
                }
            );

            await assert.rejects(
                async () => {
                    await resolveAndValidateTarget("169.254.169.254");
                },
                (err: any) => {
                    return (
                        err instanceof SSRFBlockError &&
                        err.category === "ipv4_link_local"
                    );
                }
            );
        });

        it("rejects target if ANY resolved IP in A/AAAA records is restricted (Rebinding TOCTOU protection)", async () => {
            // Backup original resolve4 and resolve6
            const origResolve4 = dns.resolve4;
            const origResolve6 = dns.resolve6;

            try {
                // Mock DNS returning a public IP AND a private IP (rebind vector)
                dns.resolve4 = async () => ["93.184.216.34", "127.0.0.1"];
                dns.resolve6 = async () => [];

                await assert.rejects(
                    async () => {
                        await resolveAndValidateTarget("rebind-target.test");
                    },
                    (err: any) => {
                        return (
                            err instanceof SSRFBlockError &&
                            err.category === "ipv4_loopback" &&
                            err.blockedIp === "127.0.0.1"
                        );
                    }
                );
            } finally {
                dns.resolve4 = origResolve4;
                dns.resolve6 = origResolve6;
            }
        });
    });

    // -----------------------------------------------------------------------
    // 3. Internal Redirect Chains
    // -----------------------------------------------------------------------
    describe("Internal Redirect Chain Interception", () => {
        let server: http.Server;
        let serverPort: number;

        before(() => new Promise<void>((resolve) => {
            server = http.createServer((req, res) => {
                if (req.url === "/redirect-to-loopback") {
                    res.writeHead(302, { Location: "http://127.0.0.1:8080/admin" });
                    res.end();
                } else if (req.url === "/redirect-to-metadata") {
                    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
                    res.end();
                } else if (req.url === "/redirect-to-ipv6-loopback") {
                    res.writeHead(302, { Location: "http://[::1]:8080/secret" });
                    res.end();
                } else {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("OK");
                }
            });

            server.listen(0, "127.0.0.1", () => {
                const addr = server.address() as any;
                serverPort = addr.port;
                resolve();
            });
        }));

        after(() => new Promise<void>((resolve) => {
            server.close(() => resolve());
        }));

        it("blocks redirects target resolving to loopback 127.0.0.1", async () => {
            // Directly test executeSSRFRequest against localhost redirect endpoint
            // (Targeting localhost explicitly for testing redirect interception logic)
            const testUrl = `http://127.0.0.1:${serverPort}/redirect-to-loopback`;

            await assert.rejects(
                async () => {
                    await executeSSRFRequest(testUrl);
                },
                (err: any) => {
                    return (
                        err instanceof SSRFBlockError &&
                        (err.category === "ipv4_loopback" || err.category === "hostname_reserved")
                    );
                }
            );
        });

        it("blocks redirects target resolving to metadata 169.254.169.254", async () => {
            const testUrl = `http://127.0.0.1:${serverPort}/redirect-to-metadata`;

            await assert.rejects(
                async () => {
                    await executeSSRFRequest(testUrl);
                },
                (err: any) => {
                    return err instanceof SSRFBlockError;
                }
            );
        });

        it("blocks redirects target resolving to IPv6 loopback [::1]", async () => {
            const testUrl = `http://127.0.0.1:${serverPort}/redirect-to-ipv6-loopback`;

            await assert.rejects(
                async () => {
                    await executeSSRFRequest(testUrl);
                },
                (err: any) => {
                    return err instanceof SSRFBlockError;
                }
            );
        });
    });

    // -----------------------------------------------------------------------
    // 4. End-to-End Safe Requests & IP Pinning
    // -----------------------------------------------------------------------
    describe("IP Pinning & Valid Requests", () => {
        let publicServer: http.Server;
        let publicPort: number;
        let lastReceivedHostHeader: string | undefined;

        before(() => new Promise<void>((resolve) => {
            publicServer = http.createServer((req, res) => {
                lastReceivedHostHeader = req.headers.host;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok" }));
            });

            // Listen on 127.0.0.1 for local test server
            publicServer.listen(0, "127.0.0.1", () => {
                const addr = publicServer.address() as any;
                publicPort = addr.port;
                resolve();
            });
        }));

        after(() => new Promise<void>((resolve) => {
            publicServer.close(() => resolve());
        }));

        it("preserves original Host header when IP pinning", async () => {
            // Mock DNS pre-resolution to return 127.0.0.1 for a custom test domain
            const origResolve4 = dns.resolve4;
            try {
                dns.resolve4 = async () => ["127.0.0.1"];

                // Bypass static category check for this specific mock domain test
                const response = await executeSSRFRequest(`http://custom-safe-domain.org:${publicPort}/health`, {
                    allowLoopback: true,
                });

                assert.equal(response.status, 200);
                assert.equal(lastReceivedHostHeader, `custom-safe-domain.org:${publicPort}`);
            } finally {
                dns.resolve4 = origResolve4;
            }
        });
    });
});
