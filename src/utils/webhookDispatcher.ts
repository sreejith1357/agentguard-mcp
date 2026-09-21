/**
 * AgentGuard MCP v3.1.0 — Async Webhook Event Dispatcher
 *
 * Provides event subscription management and async, non-blocking webhook delivery
 * signed with HMAC SHA-256 headers for authentication.
 */

import crypto from "crypto";
import db from "../db/schema";

export interface WebhookRecord {
    id: string;
    tenant_id: string;
    url: string;
    secret: string;
    events: string[];
    is_active: boolean;
    created_at: string;
}

export type WebhookEvent = "circuit.tripped" | "anomaly.detected" | "quota.warning";

/**
 * Creates a new webhook endpoint subscription
 */
export function createWebhook(params: { tenant_id: string; url: string; events?: string[] }): WebhookRecord {
    const id = `wh_${crypto.randomBytes(8).toString("hex")}`;
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
    const events = params.events && params.events.length > 0 ? params.events : ["circuit.tripped", "anomaly.detected", "quota.warning"];
    const createdAt = new Date().toISOString();

    db.prepare(`
        INSERT INTO webhooks (id, tenant_id, url, secret, events_json, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, params.tenant_id, params.url, secret, JSON.stringify(events), createdAt);

    return {
        id,
        tenant_id: params.tenant_id,
        url: params.url,
        secret,
        events,
        is_active: true,
        created_at: createdAt,
    };
}

/**
 * Lists webhooks for a tenant or all tenants
 */
export function listWebhooks(tenant_id?: string): WebhookRecord[] {
    try {
        let rows: any[];
        if (tenant_id && tenant_id !== "all") {
            rows = db.prepare("SELECT * FROM webhooks WHERE tenant_id = ? ORDER BY created_at DESC").all(tenant_id);
        } else {
            rows = db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all();
        }

        return rows.map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            url: r.url,
            secret: r.secret,
            events: JSON.parse(r.events_json || "[]"),
            is_active: Boolean(r.is_active),
            created_at: r.created_at,
        }));
    } catch {
        return [];
    }
}

/**
 * Deletes a webhook subscription
 */
export function deleteWebhook(id: string): boolean {
    try {
        const result = db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
        return result.changes > 0;
    } catch {
        return false;
    }
}

/**
 * Dispatches an event payload to all matching active webhooks asynchronously
 */
export function dispatchWebhookEvent(params: { tenant_id: string; event: WebhookEvent; payload: Record<string, any> }): void {
    // Non-blocking execution via setImmediate / unhandled promise catch
    setImmediate(async () => {
        try {
            const webhooks = listWebhooks(params.tenant_id).filter((wh) => wh.is_active && wh.events.includes(params.event));
            if (webhooks.length === 0) return;

            const timestamp = new Date().toISOString();
            const body = JSON.stringify({
                event: params.event,
                tenant_id: params.tenant_id,
                timestamp,
                data: params.payload,
            });

            for (const wh of webhooks) {
                const signature = crypto.createHmac("sha256", wh.secret).update(body).digest("hex");

                try {
                    await fetch(wh.url, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "User-Agent": "AgentGuard-MCP-Webhook/3.1.0",
                            "X-AgentGuard-Event": params.event,
                            "X-AgentGuard-Signature": `t=${timestamp},v1=${signature}`,
                        },
                        body,
                        signal: AbortSignal.timeout(5000), // 5s timeout
                    });
                } catch (err) {
                    console.error(`Failed to dispatch webhook ${wh.id} to ${wh.url}:`, err);
                }
            }
        } catch (err) {
            console.error("Webhook dispatch error:", err);
        }
    });
}
