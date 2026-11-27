/**
 * AgentGuard MCP v3.1.2 — API Key & Tenant Management Store
 *
 * Provides cryptographic generation, SHA-256 hashing, expiry & scope enforcement,
 * lookup, creation, and revocation of tenant API keys backed by SQLite.
 */

import crypto from "node:crypto";
import db from "../db/schema.js";

export interface TenantRecord {
    tenant_id: string;
    name: string;
    plan: "free" | "starter" | "pro" | "team";
    monthly_quota: number;
    status: "active" | "suspended";
    created_at: string;
    notes?: string | null;
    email?: string | null;
}

export interface ApiKeySummary {
    id: string;
    tenant_id: string;
    prefix: string;
    name: string;
    is_active: boolean;
    expires_at: string | null;
    scopes: string[] | null;
    created_at: string;
    last_used_at: string | null;
}

export interface ValidatedKeyContext {
    tenant_id: string;
    plan: "free" | "starter" | "pro" | "team";
    monthly_quota: number;
    status: "active" | "suspended";
    expires_at: string | null;
    scopes: string[] | null;
}

export const PLAN_QUOTAS: Record<string, number> = {
    free: 1000,
    starter: 50000,
    pro: 500000,
    team: 5000000,
};

// Simple in-memory cache for ultra-fast verification hot paths
const keyCache = new Map<string, { data: ValidatedKeyContext | null; expiresAt: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds

export function clearApiKeyCache(): void {
    keyCache.clear();
}

export function hashApiKey(rawKey: string): string {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function parseScopes(raw: string | null | undefined): string[] | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : null;
    } catch {
        return null;
    }
}

/**
 * Validates a raw API key string against the database (checks active status, tenant status, and expiry).
 */
export function verifyApiKey(rawKey: string): ValidatedKeyContext | null {
    if (!rawKey || typeof rawKey !== "string") return null;

    const keyHash = hashApiKey(rawKey);
    const now = Date.now();

    const cached = keyCache.get(keyHash);
    if (cached && cached.expiresAt > now) {
        if (cached.data?.expires_at && new Date(cached.data.expires_at).getTime() <= now) {
            keyCache.delete(keyHash);
            return null;
        }
        return cached.data;
    }

    try {
        const stmt = db.prepare(`
            SELECT k.tenant_id, t.plan, t.monthly_quota, t.status, k.id, k.expires_at, k.scopes_json
            FROM api_keys k
            JOIN tenants t ON k.tenant_id = t.tenant_id
            WHERE k.key_hash = ? AND k.is_active = 1 AND t.status = 'active'
        `);
        const row = stmt.get(keyHash) as {
            tenant_id: string;
            plan: string;
            monthly_quota: number;
            status: string;
            id: string;
            expires_at: string | null;
            scopes_json: string | null;
        } | undefined;

        if (!row) {
            keyCache.set(keyHash, { data: null, expiresAt: now + CACHE_TTL_MS });
            return null;
        }

        // Enforce key expiration if set
        if (row.expires_at && new Date(row.expires_at).getTime() <= now) {
            keyCache.set(keyHash, { data: null, expiresAt: now + CACHE_TTL_MS });
            return null;
        }

        // Update last_used_at timestamp safely
        try {
            db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
        } catch { /* ignore non-critical update failure */ }

        const context: ValidatedKeyContext = {
            tenant_id: row.tenant_id,
            plan: (row.plan as any) || "free",
            monthly_quota: row.monthly_quota || PLAN_QUOTAS[row.plan] || 1000,
            status: (row.status as any) || "active",
            expires_at: row.expires_at || null,
            scopes: parseScopes(row.scopes_json),
        };

        keyCache.set(keyHash, { data: context, expiresAt: now + CACHE_TTL_MS });
        return context;
    } catch (err) {
        console.error("Error in verifyApiKey:", err);
        return null;
    }
}

/**
 * Generates a new API key for a tenant with optional expiration (days or ISO timestamp) and tool scopes.
 */
export function createApiKey(params: {
    tenant_id: string;
    name?: string;
    expires_in_days?: number;
    expires_at?: string;
    scopes?: string[];
}): {
    key: string;
    id: string;
    prefix: string;
    tenant_id: string;
    name: string;
    expires_at: string | null;
    scopes: string[] | null;
} {
    const tenant = getTenant(params.tenant_id);
    if (!tenant) {
        throw new Error(`Tenant '${params.tenant_id}' does not exist.`);
    }

    const randomBytes = crypto.randomBytes(24).toString("hex");
    const rawKey = `ag_live_${randomBytes}`;
    const keyHash = hashApiKey(rawKey);
    const prefix = rawKey.slice(0, 15) + "...";
    const id = `key_${crypto.randomBytes(8).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const keyName = params.name?.trim() || "Default Key";

    let expiresAt: string | null = null;
    if (params.expires_at) {
        const d = new Date(params.expires_at);
        if (Number.isNaN(d.getTime())) {
            throw new Error(`Invalid expires_at timestamp: '${params.expires_at}'`);
        }
        expiresAt = d.toISOString();
    } else if (typeof params.expires_in_days === "number" && params.expires_in_days > 0) {
        expiresAt = new Date(Date.now() + params.expires_in_days * 24 * 60 * 60 * 1000).toISOString();
    }

    const cleanScopes =
        Array.isArray(params.scopes) && params.scopes.length > 0
            ? params.scopes.map((s) => s.trim()).filter(Boolean)
            : null;
    const scopesJson = cleanScopes && cleanScopes.length > 0 ? JSON.stringify(cleanScopes) : null;

    db.prepare(`
        INSERT INTO api_keys (id, tenant_id, key_hash, prefix, name, is_active, expires_at, scopes_json, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, params.tenant_id, keyHash, prefix, keyName, expiresAt, scopesJson, createdAt);

    return {
        key: rawKey,
        id,
        prefix,
        tenant_id: params.tenant_id,
        name: keyName,
        expires_at: expiresAt,
        scopes: cleanScopes,
    };
}

/**
 * Lists API keys (without hashes)
 */
export function listApiKeys(tenant_id?: string): ApiKeySummary[] {
    try {
        let rows: any[];
        if (tenant_id && tenant_id !== "all") {
            rows = db
                .prepare(`SELECT id, tenant_id, prefix, name, is_active, expires_at, scopes_json, created_at, last_used_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`)
                .all(tenant_id);
        } else {
            rows = db
                .prepare(`SELECT id, tenant_id, prefix, name, is_active, expires_at, scopes_json, created_at, last_used_at FROM api_keys ORDER BY created_at DESC`)
                .all();
        }

        return rows.map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            prefix: r.prefix,
            name: r.name,
            is_active: Boolean(r.is_active),
            expires_at: r.expires_at || null,
            scopes: parseScopes(r.scopes_json),
            created_at: r.created_at,
            last_used_at: r.last_used_at,
        }));
    } catch (err) {
        console.error("Error in listApiKeys:", err);
        return [];
    }
}

/**
 * Revokes an API key and selectively invalidates its cached entry.
 */
export function revokeApiKey(keyId: string): boolean {
    try {
        const existing = db.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(keyId) as { key_hash: string } | undefined;
        const result = db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ? AND is_active = 1").run(keyId);
        if (existing?.key_hash) {
            keyCache.delete(existing.key_hash);
        }
        return result.changes > 0;
    } catch (err) {
        console.error("Error revoking API key:", err);
        return false;
    }
}

/**
 * Creates or updates a tenant
 */
export function createTenant(params: {
    tenant_id: string;
    name: string;
    plan?: "free" | "starter" | "pro" | "team";
    email?: string;
    notes?: string;
}): TenantRecord {
    const plan = params.plan || "free";
    const quota = PLAN_QUOTAS[plan] || 1000;
    const createdAt = new Date().toISOString();

    db.prepare(`
        INSERT INTO tenants (tenant_id, name, plan, monthly_quota, status, created_at, email, notes)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            name = excluded.name,
            plan = excluded.plan,
            monthly_quota = excluded.monthly_quota,
            email = COALESCE(excluded.email, tenants.email),
            notes = COALESCE(excluded.notes, tenants.notes)
    `).run(params.tenant_id, params.name, plan, quota, createdAt, params.email || null, params.notes || null);

    return getTenant(params.tenant_id)!;
}

/**
 * Updates a tenant's plan, status, or notes/email
 */
export function updateTenantStatus(params: {
    tenant_id: string;
    status?: "active" | "suspended";
    plan?: "free" | "starter" | "pro" | "team";
    notes?: string;
    email?: string;
}): TenantRecord | null {
    const tenant = getTenant(params.tenant_id);
    if (!tenant) return null;

    const newStatus = params.status || tenant.status;
    const newPlan = params.plan || tenant.plan;
    const newQuota = PLAN_QUOTAS[newPlan] || tenant.monthly_quota;
    const newNotes = params.notes !== undefined ? params.notes : tenant.notes;
    const newEmail = params.email !== undefined ? params.email : tenant.email;

    db.prepare(`
        UPDATE tenants
        SET status = ?, plan = ?, monthly_quota = ?, notes = ?, email = ?
        WHERE tenant_id = ?
    `).run(newStatus, newPlan, newQuota, newNotes || null, newEmail || null, params.tenant_id);

    // Selectively invalidate cached keys belonging to this tenant
    for (const [hash, entry] of keyCache.entries()) {
        if (entry.data?.tenant_id === params.tenant_id) {
            keyCache.delete(hash);
        }
    }
    return getTenant(params.tenant_id);
}

/**
 * Permanently deletes a tenant and cascades across all tenant-scoped tables in a transaction.
 */
export function deleteTenant(tenant_id: string): boolean {
    try {
        const deleteTx = db.transaction(() => {
            db.prepare("DELETE FROM call_logs WHERE tenant_id = ?").run(tenant_id);
            db.prepare("DELETE FROM session_checkpoints WHERE tenant_id = ?").run(tenant_id);
            db.prepare("DELETE FROM circuit_breakers WHERE tenant_id = ?").run(tenant_id);
            db.prepare("DELETE FROM metric_observations WHERE tenant_id = ?").run(tenant_id);
            db.prepare("DELETE FROM metric_baselines WHERE tenant_id = ?").run(tenant_id);
            db.prepare("DELETE FROM webhook_deliveries WHERE tenant_id = ?").run(tenant_id);
            db.prepare("DELETE FROM rate_limit_buckets WHERE tenant_id = ?").run(tenant_id);
            return db.prepare("DELETE FROM tenants WHERE tenant_id = ?").run(tenant_id);
        });

        const result = deleteTx();
        for (const [hash, entry] of keyCache.entries()) {
            if (entry.data?.tenant_id === tenant_id) {
                keyCache.delete(hash);
            }
        }
        return result.changes > 0;
    } catch (err) {
        console.error("Error deleting tenant:", err);
        return false;
    }
}

export function getTenant(tenant_id: string): TenantRecord | null {
    try {
        const row = db.prepare("SELECT * FROM tenants WHERE tenant_id = ?").get(tenant_id) as any;
        if (!row) return null;
        return {
            tenant_id: row.tenant_id,
            name: row.name,
            plan: row.plan,
            monthly_quota: row.monthly_quota,
            status: row.status,
            created_at: row.created_at,
            notes: row.notes || null,
            email: row.email || null,
        };
    } catch {
        return null;
    }
}

export function listTenants(): TenantRecord[] {
    try {
        const rows = db.prepare("SELECT * FROM tenants ORDER BY created_at DESC").all() as any[];
        return rows.map((row) => ({
            tenant_id: row.tenant_id,
            name: row.name,
            plan: row.plan,
            monthly_quota: row.monthly_quota,
            status: row.status,
            created_at: row.created_at,
            notes: row.notes || null,
            email: row.email || null,
        }));
    } catch {
        return [];
    }
}
