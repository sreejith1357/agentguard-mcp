/**
 * AgentGuard MCP v3.1.0 — API Key & Tenant Management Store
 *
 * Provides cryptographic generation, SHA-256 hashing, lookup, creation,
 * and revocation of tenant API keys backed by SQLite.
 */

import crypto from "crypto";
import db from "../db/schema";

export interface TenantRecord {
    tenant_id: string;
    name: string;
    plan: "free" | "starter" | "pro" | "team";
    monthly_quota: number;
    status: "active" | "suspended";
    created_at: string;
}

export interface ApiKeyRecord {
    id: string;
    tenant_id: string;
    key_hash: string;
    prefix: string;
    name: string;
    is_active: number;
    created_at: string;
    last_used_at: string | null;
}

export interface ApiKeySummary {
    id: string;
    tenant_id: string;
    prefix: string;
    name: string;
    is_active: boolean;
    created_at: string;
    last_used_at: string | null;
}

export interface ValidatedKeyContext {
    tenant_id: string;
    plan: "free" | "starter" | "pro" | "team";
    monthly_quota: number;
    status: "active" | "suspended";
}

const PLAN_QUOTAS: Record<string, number> = {
    free: 1000,
    starter: 50000,
    pro: 500000,
    team: 5000000,
};

// Simple in-memory cache for ultra-fast verification hot paths
const keyCache = new Map<string, { data: ValidatedKeyContext | null; expiresAt: number }>();
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Computes SHA-256 hash of a raw API key string
 */
export function hashApiKey(rawKey: string): string {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Validates a raw API key string against the database
 */
export function verifyApiKey(rawKey: string): ValidatedKeyContext | null {
    if (!rawKey || typeof rawKey !== "string") return null;

    const keyHash = hashApiKey(rawKey);
    const now = Date.now();

    const cached = keyCache.get(keyHash);
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    try {
        const stmt = db.prepare(`
            SELECT k.tenant_id, t.plan, t.monthly_quota, t.status, k.id
            FROM api_keys k
            JOIN tenants t ON k.tenant_id = t.tenant_id
            WHERE k.key_hash = ? AND k.is_active = 1 AND t.status = 'active'
        `);
        const row = stmt.get(keyHash) as { tenant_id: string; plan: string; monthly_quota: number; status: string; id: string } | undefined;

        if (!row) {
            keyCache.set(keyHash, { data: null, expiresAt: now + CACHE_TTL_MS });
            return null;
        }

        // Update last_used_at timestamp asynchronously
        try {
            db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
        } catch { /* ignore non-critical update failure */ }

        const context: ValidatedKeyContext = {
            tenant_id: row.tenant_id,
            plan: (row.plan as any) || "free",
            monthly_quota: row.monthly_quota || PLAN_QUOTAS[row.plan] || 1000,
            status: (row.status as any) || "active",
        };

        keyCache.set(keyHash, { data: context, expiresAt: now + CACHE_TTL_MS });
        return context;
    } catch (err) {
        console.error("Error in verifyApiKey:", err);
        return null;
    }
}

/**
 * Generates a new API key for a tenant
 */
export function createApiKey(params: { tenant_id: string; name: string }): { key: string; id: string; prefix: string; tenant_id: string; name: string } {
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

    db.prepare(`
        INSERT INTO api_keys (id, tenant_id, key_hash, prefix, name, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, params.tenant_id, keyHash, prefix, params.name || "Default Key", createdAt);

    return {
        key: rawKey,
        id,
        prefix,
        tenant_id: params.tenant_id,
        name: params.name || "Default Key",
    };
}

/**
 * Lists API keys (without hashes)
 */
export function listApiKeys(tenant_id?: string): ApiKeySummary[] {
    try {
        let rows: any[];
        if (tenant_id && tenant_id !== "all") {
            rows = db.prepare(`SELECT id, tenant_id, prefix, name, is_active, created_at, last_used_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenant_id);
        } else {
            rows = db.prepare(`SELECT id, tenant_id, prefix, name, is_active, created_at, last_used_at FROM api_keys ORDER BY created_at DESC`).all();
        }

        return rows.map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            prefix: r.prefix,
            name: r.name,
            is_active: Boolean(r.is_active),
            created_at: r.created_at,
            last_used_at: r.last_used_at,
        }));
    } catch (err) {
        console.error("Error in listApiKeys:", err);
        return [];
    }
}

/**
 * Revokes an API key
 */
export function revokeApiKey(keyId: string): boolean {
    try {
        const result = db.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ?").run(keyId);
        keyCache.clear(); // Clear cache on key revocation
        return result.changes > 0;
    } catch (err) {
        console.error("Error revoking API key:", err);
        return false;
    }
}

/**
 * Creates or updates a tenant
 */
export function createTenant(params: { tenant_id: string; name: string; plan?: "free" | "starter" | "pro" | "team" }): TenantRecord {
    const plan = params.plan || "free";
    const quota = PLAN_QUOTAS[plan] || 1000;
    const createdAt = new Date().toISOString();

    db.prepare(`
        INSERT INTO tenants (tenant_id, name, plan, monthly_quota, status, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            name = excluded.name,
            plan = excluded.plan,
            monthly_quota = excluded.monthly_quota
    `).run(params.tenant_id, params.name, plan, quota, createdAt);

    return getTenant(params.tenant_id)!;
}

/**
 * Gets a tenant record
 */
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
        };
    } catch {
        return null;
    }
}

/**
 * Lists all tenants
 */
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
        }));
    } catch {
        return [];
    }
}
