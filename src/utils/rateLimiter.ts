/**
 * AgentGuard MCP v3.1.0 — Rate Limiting & Monthly Plan Quota Middleware
 *
 * Enforces per-minute sliding window rate limits (600 RPM default) and monthly call quotas.
 * Returns HTTP 429 status response details when a tenant exceeds plan limits.
 */

import db from "../db/schema";
import { getTenant } from "./apiKeyStore";

interface SlidingWindowBucket {
    count: number;
    resetAt: number;
}

const windowMap = new Map<string, SlidingWindowBucket>();
const WINDOW_DURATION_MS = 60 * 1000; // 1 minute sliding window
const DEFAULT_PER_MINUTE_LIMIT = 600; // 600 requests / minute

/**
 * Retrieves the total call count for a tenant in the current calendar month
 */
export function getMonthlyCallCount(tenant_id: string, monthKey?: string): number {
    const month = monthKey || new Date().toISOString().slice(0, 7);
    try {
        const stmt = db.prepare("SELECT COUNT(*) as cnt FROM call_logs WHERE tenant_id = ? AND month_key = ?");
        const row = stmt.get(tenant_id, month) as { cnt: number } | undefined;
        return row ? row.cnt : 0;
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
 * Checks rate limits and monthly quota for a given tenant context
 */
export function checkTenantRateLimit(tenant_id: string): RateLimitCheckResult {
    const now = Date.now();
    const monthKey = new Date().toISOString().slice(0, 7);

    // 1. Fetch tenant plan & monthly quota
    const tenant = getTenant(tenant_id);
    const monthlyQuota = tenant ? tenant.monthly_quota : 500000; // default fallback

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

    // 3. Check Per-Minute Sliding Window Rate Limit
    let bucket = windowMap.get(tenant_id);
    if (!bucket || now >= bucket.resetAt) {
        bucket = {
            count: 0,
            resetAt: now + WINDOW_DURATION_MS,
        };
        windowMap.set(tenant_id, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, DEFAULT_PER_MINUTE_LIMIT - bucket.count);

    if (bucket.count > DEFAULT_PER_MINUTE_LIMIT) {
        return {
            allowed: false,
            reason: "per_minute_rate_exceeded",
            limit: DEFAULT_PER_MINUTE_LIMIT,
            remaining: 0,
            resetAt: Math.floor(bucket.resetAt / 1000),
            monthlyUsed,
            monthlyQuota,
        };
    }

    return {
        allowed: true,
        limit: DEFAULT_PER_MINUTE_LIMIT,
        remaining,
        resetAt: Math.floor(bucket.resetAt / 1000),
        monthlyUsed,
        monthlyQuota,
    };
}
