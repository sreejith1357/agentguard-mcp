/**
 * AgentGuard MCP v3.1.2 — Async SSRF-Protected Webhook Event Dispatcher
 *
 * Provides event subscription management and async, non-blocking webhook delivery:
 *  - Validates webhook target URLs against SSRF / private CIDR ranges on creation and delivery
 *  - Signs payloads with HMAC-SHA256 headers (`X-AgentGuard-Signature`)
 *  - Delivers in parallel across matching endpoints with exponential backoff retries (3 attempts)
 *  - Persists delivery attempts in `webhook_deliveries` for observability
 */

import crypto from "node:crypto";
import db from "../db/schema.js";
import { getSSRFBlockCategory, executeSSRFRequest, SSRFBlockError } from "./ssrfGuard.js";

export const ALLOWED_WEBHOOK_EVENTS = [
    "circuit.tripped",
    "anomaly.detected",
    "quota.warning",
    "loop.detected",
] as const;

export type WebhookEvent = (typeof ALLOWED_WEBHOOK_EVENTS)[number];

export interface WebhookRecord {
    id: string;
    tenant_id: string;
    url: string;
    secret: string;
    events: string[];
    is_active: boolean;
    created_at: string;
}

export interface WebhookDeliveryRecord {
    id: string;
    webhook_id: string;
    tenant_id: string;
    event: string;
    status_code: number | null;
    success: boolean;
    attempt: number;
    error_message: string | null;
    delivered_at: string;
}

/**
 * Validates a webhook URL against protocol and SSRF rules.
 */
export function validateWebhookUrl(urlStr: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(urlStr);
    } catch {
        throw new Error(`Invalid webhook URL: "${urlStr}"`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Webhook protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`);
    }

    const blockedCategory = getSSRFBlockCategory(parsed.hostname);
    if (blockedCategory) {
        throw new SSRFBlockError(
            `Webhook URL host "${parsed.hostname}" is in a private/reserved range (${blockedCategory})`,
            blockedCategory,
            parsed.hostname
        );
    }

    return parsed;
}

/**
 * Validates and normalizes subscribed webhook events.
 */
export function validateWebhookEvents(events?: string[]): WebhookEvent[] {
    if (!events || events.length === 0) {
        return ["circuit.tripped", "anomaly.detected", "quota.warning"];
    }
    const allowedSet = new Set<string>(ALLOWED_WEBHOOK_EVENTS);
    const invalid = events.filter((e) => !allowedSet.has(e));
    if (invalid.length > 0) {
        throw new Error(
            `Invalid webhook event(s): ${invalid.join(", ")}. Allowed events: ${ALLOWED_WEBHOOK_EVENTS.join(", ")}`
        );
    }
    return [...new Set(events)] as WebhookEvent[];
}

/**
 * Creates a new webhook endpoint subscription after validating URL and events.
 */
export function createWebhook(params: { tenant_id: string; url: string; events?: string[] }): WebhookRecord {
    validateWebhookUrl(params.url);
    const events = validateWebhookEvents(params.events);

    const id = `wh_${crypto.randomBytes(8).toString("hex")}`;
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
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
 * Lists webhooks for a tenant or all tenants (masks secret by default unless includeSecrets=true).
 */
export function listWebhooks(tenant_id?: string, includeSecrets: boolean = false): WebhookRecord[] {
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
            secret: includeSecrets ? r.secret : `${String(r.secret).slice(0, 10)}...`,
            events: JSON.parse(r.events_json || "[]"),
            is_active: Boolean(r.is_active),
            created_at: r.created_at,
        }));
    } catch {
        return [];
    }
}

export function deleteWebhook(id: string): boolean {
    try {
        const result = db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
        return result.changes > 0;
    } catch {
        return false;
    }
}

export function listWebhookDeliveries(tenant_id?: string, limit: number = 50): WebhookDeliveryRecord[] {
    try {
        let rows: any[];
        if (tenant_id && tenant_id !== "all") {
            rows = db
                .prepare("SELECT * FROM webhook_deliveries WHERE tenant_id = ? ORDER BY delivered_at DESC LIMIT ?")
                .all(tenant_id, limit);
        } else {
            rows = db
                .prepare("SELECT * FROM webhook_deliveries ORDER BY delivered_at DESC LIMIT ?")
                .all(limit);
        }
        return rows.map((r) => ({
            id: r.id,
            webhook_id: r.webhook_id,
            tenant_id: r.tenant_id,
            event: r.event,
            status_code: r.status_code ?? null,
            success: Boolean(r.success),
            attempt: r.attempt,
            error_message: r.error_message ?? null,
            delivered_at: r.delivered_at,
        }));
    } catch {
        return [];
    }
}

function recordDeliveryAttempt(params: {
    webhook_id: string;
    tenant_id: string;
    event: string;
    status_code: number | null;
    success: boolean;
    attempt: number;
    error_message: string | null;
}): void {
    try {
        const id = `whd_${crypto.randomBytes(8).toString("hex")}`;
        db.prepare(`
            INSERT INTO webhook_deliveries (id, webhook_id, tenant_id, event, status_code, success, attempt, error_message, delivered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            params.webhook_id,
            params.tenant_id,
            params.event,
            params.status_code,
            params.success ? 1 : 0,
            params.attempt,
            params.error_message,
            new Date().toISOString()
        );
    } catch {
        /* non-fatal logging */
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

export interface WebhookDispatchOptions {
    maxRetries?: number;
    retryDelaysMs?: number[];
    allowLoopback?: boolean;
}

/**
 * Synchronous-awaitable delivery for a single webhook with SSRF pinning & exponential backoff retries.
 */
export async function deliverWebhookWithRetry(
    wh: WebhookRecord,
    event: WebhookEvent,
    payload: Record<string, any>,
    options: WebhookDispatchOptions = {}
): Promise<boolean> {
    const maxRetries = options.maxRetries ?? 3;
    const retryDelaysMs = options.retryDelaysMs ?? [1000, 4000, 16000];
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
        event,
        tenant_id: wh.tenant_id,
        timestamp,
        data: payload,
    });
    const signature = crypto.createHmac("sha256", wh.secret).update(body).digest("hex");

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await executeSSRFRequest(wh.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "AgentGuard-MCP-Webhook/3.1.2",
                    "X-AgentGuard-Event": event,
                    "X-AgentGuard-Delivery": `${wh.id}:${attempt}`,
                    "X-AgentGuard-Signature": `t=${timestamp},v1=${signature}`,
                },
                body,
                timeoutMs: 5000,
                maxRedirects: 2,
                allowLoopback: options.allowLoopback ?? false,
            });

            const success = response.status >= 200 && response.status < 300;
            recordDeliveryAttempt({
                webhook_id: wh.id,
                tenant_id: wh.tenant_id,
                event,
                status_code: response.status,
                success,
                attempt,
                error_message: success ? null : `HTTP ${response.status} ${response.statusText}`,
            });

            if (success) return true;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            recordDeliveryAttempt({
                webhook_id: wh.id,
                tenant_id: wh.tenant_id,
                event,
                status_code: null,
                success: false,
                attempt,
                error_message: errMsg.slice(0, 500),
            });

            // Never retry SSRF blocks
            if (err instanceof SSRFBlockError) {
                return false;
            }
        }

        if (attempt < maxRetries) {
            const delay = retryDelaysMs[attempt - 1] ?? 4000;
            await sleep(delay);
        }
    }

    return false;
}

/**
 * Dispatches an event payload to all matching active webhooks asynchronously in parallel.
 */
export function dispatchWebhookEvent(
    params: { tenant_id: string; event: WebhookEvent; payload: Record<string, any> },
    options: WebhookDispatchOptions = {}
): void {
    setImmediate(async () => {
        try {
            const webhooks = listWebhooks(params.tenant_id, true).filter(
                (wh) => wh.is_active && wh.events.includes(params.event)
            );
            if (webhooks.length === 0) return;

            await Promise.allSettled(
                webhooks.map((wh) => deliverWebhookWithRetry(wh, params.event, params.payload, options))
            );
        } catch (err) {
            console.error("Webhook dispatch error:", err);
        }
    });
}
