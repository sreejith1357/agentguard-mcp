/**
 * AgentGuard MCP — Unit Tests: Webhook SSRF Guard, HMAC Signing & Retry Delivery
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import {
    createWebhook,
    listWebhooks,
    deliverWebhookWithRetry,
    listWebhookDeliveries,
    type WebhookRecord,
} from "../src/utils/webhookDispatcher.js";
import { SSRFBlockError } from "../src/utils/ssrfGuard.js";
import { createTenant } from "../src/utils/apiKeyStore.js";

describe("Webhook Security, Signing & Retries", () => {
    let server: http.Server;
    let port: number;
    let attempts = 0;
    let lastSignature = "";
    let lastBody = "";

    before(() => new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                attempts += 1;
                lastSignature = String(req.headers["x-agentguard-signature"] || "");
                lastBody = Buffer.concat(chunks).toString("utf8");

                // Fail first attempt, succeed second
                if (attempts === 1) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "transient" }));
                } else {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                }
            });
        });
        server.listen(0, "127.0.0.1", () => {
            port = (server.address() as { port: number }).port;
            resolve();
        });
    }));

    after(() => new Promise<void>((resolve) => {
        server.close(() => resolve());
    }));

    it("blocks private/loopback/metadata URLs and invalid events on createWebhook", () => {
        const tid = `wh-sec-${Date.now()}`;
        createTenant({ tenant_id: tid, name: "Webhook Sec", plan: "pro" });

        assert.throws(
            () => createWebhook({ tenant_id: tid, url: "http://127.0.0.1:8080/hook" }),
            (err: any) => err instanceof SSRFBlockError
        );
        assert.throws(
            () => createWebhook({ tenant_id: tid, url: "http://169.254.169.254/latest" }),
            (err: any) => err instanceof SSRFBlockError
        );
        assert.throws(
            () => createWebhook({ tenant_id: tid, url: "https://example.com/hook", events: ["invalid.event"] }),
            /Invalid webhook event/
        );
    });

    it("masks webhook secrets in listWebhooks", () => {
        const tid = `wh-mask-${Date.now()}`;
        createTenant({ tenant_id: tid, name: "Mask Corp", plan: "pro" });
        const created = createWebhook({ tenant_id: tid, url: "https://example.com/webhook" });
        assert.ok(created.secret.startsWith("whsec_"));

        const listed = listWebhooks(tid);
        assert.equal(listed.length, 1);
        assert.ok(listed[0].secret.endsWith("..."));
        assert.notEqual(listed[0].secret, created.secret);
    });

    it("retries transient failures, verifies HMAC signature, and logs delivery attempts", async () => {
        attempts = 0;
        const wh: WebhookRecord = {
            id: `wh_test_${Date.now()}`,
            tenant_id: "default-tenant",
            url: `http://127.0.0.1:${port}/webhook`,
            secret: "whsec_test_secret_123",
            events: ["circuit.tripped"],
            is_active: true,
            created_at: new Date().toISOString(),
        };

        const delivered = await deliverWebhookWithRetry(
            wh,
            "circuit.tripped",
            { tool_name: "stripe_api", failure_count: 5 },
            { maxRetries: 3, retryDelaysMs: [10, 10], allowLoopback: true }
        );

        assert.equal(delivered, true);
        assert.equal(attempts, 2);

        // Verify HMAC signature matches body
        const parts = Object.fromEntries(lastSignature.split(",").map((p) => p.split("=")));
        const expectedSig = crypto.createHmac("sha256", wh.secret).update(lastBody).digest("hex");
        assert.equal(parts.v1, expectedSig);

        const deliveries = listWebhookDeliveries("default-tenant", 10).filter((d) => d.webhook_id === wh.id);
        assert.equal(deliveries.length, 2);
        assert.equal(deliveries.some((d) => d.attempt === 1 && !d.success), true);
        assert.equal(deliveries.some((d) => d.attempt === 2 && d.success), true);
    });
});

