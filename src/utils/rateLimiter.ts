/**
 * AgentGuard MCP v3.1.2 — Rate Limiting & Monthly Plan Quota Middleware
 *
 * Enforces per-minute rate limits (configurable via TENANT_RPM_LIMIT, default 600 RPM)
 * backed by SQLite `rate_limit_buckets` for restart persistence, plus cached monthly call quotas.
 */

import db from "../db/schema.js";
import { getTenant } from "./apiKeyStore.js";
import { parseEnvInt } from "./validation.js";

const WINDOW_DURATION_MS = 60 * 1000; // 1 minute window

function getPerMinuteLimit(): number {
    return parseEnvInt("TENANT_RPM_LIMIT", parseEnvInt("RATE_LIMIT_RPM", 600, 1), 1);
}

// Short-lived in-memory cache for monthly call count so hot path avoids COUNT(*) on every request
const monthlyCountCache = new Map<string, { count: number; expiresAt: number }>();
const MONTHLY_CACHE_TTL_MS = 5000;

export function incrementMonthlyCountCache(tenant_id: string, monthKey?: string): void {
    const month = monthKey || new Date().toISOString().slice(0, 7);
    const key = `${tenant_id}:${month}`;
    const entry = monthlyCountCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
        entry.count += 1;
    }
}

export function clearRateLimitState(): void {
    monthlyCountCache.clear();
    try {
        db.prepare("DELETE FROM rate_limit_buckets").run();
    } catch { /* ignore */ }
}

/**
 * Retrieves the total call count for a tenant in the current calendar month (cached for 5s).
 */
export function getMonthlyCallCount(tenant_id: string, monthKey?: string): number {
    const month = monthKey || new Date().toISOString().slice(0, 7);
    const key = `${tenant_id}:${month}`;
    const now = Date.now();
    const cached = monthlyCountCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.count;
    }

    try {
        const stmt = db.prepare("SELECT COUNT(*) as cnt FROM call_logs WHERE tenant_id = ? AND month_key = ?");
        const row = stmt.get(tenant_id, month) as { cnt: number } | undefined;
        const count = row ? row.cnt : 0;
        monthlyCountCache.set(key, { count, expiresAt: now + MONTHLY_CACHE_TTL_MS });
        return count;
    } catch {
        return 0;
    }
}

export interface RateLimitCheckResult {
    allowed: boolean;
    reason?: "monthly_quota_exceeded" | "per_minute_rate_exceeded";
    limit: number;
    remaining: number;
    resetAt: number;
    monthlyUsed?: number;
    monthlyQuota?: number;
}

/**
 * Checks rate limits and monthly quota for a given tenant context using atomic SQLite buckets.
 */
export function checkTenantRateLimit(tenant_id: string): RateLimitCheckResult {
    const now = Date.now();
    const monthKey = new Date().toISOString().slice(0, 7);
    const perMinuteLimit = getPerMinuteLimit();

    // 1. Fetch tenant plan & monthly quota
    const tenant = getTenant(tenant_id);
    const monthlyQuota = tenant ? tenant.monthly_quota : 500000;

    // 2. Check Monthly Quota
    const monthlyUsed = getMonthlyCallCount(tenant_id, monthKey);
    if (monthlyUsed >= monthlyQuota) {
        return {
            allowed: false,
            reason: "monthly_quota_exceeded",
            limit: monthlyQuota,
            remaining: 0,
            resetAt: Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime() / 1000),
            monthlyUsed,
            monthlyQuota,
        };
    }

    // 3. Atomic SQLite bucket increment for per-minute window
    const windowStart = Math.floor(now / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
    const resetAtMs = windowStart + WINDOW_DURATION_MS;

    let count = 1;
    try {
        const tx = db.transaction(() => {
            const existing = db
                .prepare("SELECT window_start, count FROM rate_limit_buckets WHERE tenant_id = ?")
                .get(tenant_id) as { window_start: number; count: number } | undefined;

            if (!existing || existing.window_start !== windowStart) {
                db.prepare(`
                    INSERT INTO rate_limit_buckets (tenant_id, window_start, count)
                    VALUES (?, ?, 1)
                    ON CONFLICT(tenant_id) DO UPDATE SET window_start = excluded.window_start, count = 1
                `).run(tenant_id, windowStart);
                return 1;
            }

            const nextCount = existing.count + 1;
            db.prepare("UPDATE rate_limit_buckets SET count = ? WHERE tenant_id = ?").run(nextCount, tenant_id);
            return nextCount;
        });
        count = tx();
    } catch {
        count = 1;
    }

    const remaining = Math.max(0, perMinuteLimit - count);

    if (count > perMinuteLimit) {
        return {
            allowed: false,
            reason: "per_minute_rate_exceeded",
            limit: perMinuteLimit,
            remaining: 0,
            resetAt: Math.floor(resetAtMs / 1000),
            monthlyUsed,
            monthlyQuota,
        };
    }

    return {
        allowed: true,
        limit: perMinuteLimit,
        remaining,
        resetAt: Math.floor(resetAtMs / 1000),
        monthlyUsed,
        monthlyQuota,
    };
}
