/**
 * AgentGuard MCP v3.1.2 — Multi-Tenant Bearer Token Authentication & Identity Utility
 *
 * Provides constant-time Bearer token verification and resolves token identity
 * into a structured TenantIdentity ({ tenant_id, project_id, env, rate_limit, scopes }).
 * Uses AsyncLocalStorage to inject tenant identity into async tool execution contexts.
 */

import type { Request } from "express";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { verifyApiKey } from "./apiKeyStore.js";

export interface TenantIdentity {
    tenant_id: string;
    project_id: string;
    env: string;
    rate_limit: number;
    plan?: string;
    monthly_quota?: number;
    scopes?: string[];
}

export interface AuthResult {
    authenticated: boolean;
    identity?: TenantIdentity;
    error?: string;
}

/** AsyncLocalStorage container for request-scoped tenant identity propagation */
export const tenantContextStorage = new AsyncLocalStorage<TenantIdentity>();

/**
 * Returns the active TenantIdentity for the current async execution context.
 * Falls back to default development tenant if no request storage is active.
 */
export function getTenantContext(): TenantIdentity {
    return (
        tenantContextStorage.getStore() ?? {
            tenant_id: "default-tenant",
            project_id: "default-project",
            env: "development",
            rate_limit: 10000,
        }
    );
}

/**
 * Authenticate an incoming Express HTTP request using Bearer token verification.
 * Supports DB hashed API keys as well as environment variable fallback keys.
 */
export function authenticateRequest(req: Request): AuthResult {
    const envApiKey = process.env.AGENTGUARD_API_KEY?.trim() || "";

    const defaultIdentity: TenantIdentity = {
        tenant_id: "default-tenant",
        project_id: "default-project",
        env: envApiKey ? "production" : "development",
        rate_limit: envApiKey ? 100 : 10000,
    };

    const authHeader = req.headers["authorization"] || req.headers["Authorization"];

    // Open mode — ONLY when AGENTGUARD_API_KEY is unset AND no Authorization header was sent
    if (!envApiKey && (!authHeader || typeof authHeader !== "string" || authHeader.trim() === "")) {
        return { authenticated: true, identity: defaultIdentity };
    }

    if (!authHeader || typeof authHeader !== "string" || authHeader.trim() === "") {
        return {
            authenticated: false,
            error: "Missing Authorization header. Use: Bearer <your-api-key>",
        };
    }

    const trimmedHeader = authHeader.trim();
    const tokenRaw = trimmedHeader.startsWith("Bearer ") ? trimmedHeader.slice(7).trim() : trimmedHeader;

    if (!tokenRaw) {
        return {
            authenticated: false,
            error: "Empty Bearer token",
        };
    }

    // Check if token specifies structured tenant scoping: "tenant_id:project_id:env:key"
    let tokenKey = tokenRaw;
    let customTenantId: string | null = null;
    let customProjectId = "default-project";
    let customEnv = "production";

    const parts = tokenRaw.split(":");
    if (parts.length === 4) {
        customTenantId = parts[0] || null;
        customProjectId = parts[1] || "default-project";
        customEnv = parts[2] || "production";
        tokenKey = parts[3];
    }

    // 1. Check Database for hashed API keys (rejects revoked/expired/suspended)
    const dbKeyCtx = verifyApiKey(tokenKey);
    if (dbKeyCtx) {
        return {
            authenticated: true,
            identity: {
                tenant_id: dbKeyCtx.tenant_id,
                project_id: customProjectId,
                env: customEnv,
                rate_limit: dbKeyCtx.monthly_quota,
                plan: dbKeyCtx.plan,
                monthly_quota: dbKeyCtx.monthly_quota,
                ...(dbKeyCtx.scopes && dbKeyCtx.scopes.length > 0 ? { scopes: dbKeyCtx.scopes } : {}),
            },
        };
    }

    // 2. Fall back to AGENTGUARD_API_KEY env variable check (constant-time comparison)
    if (envApiKey !== "") {
        const tokenBuf = Buffer.from(tokenKey, "utf8");
        const keyBuf = Buffer.from(envApiKey, "utf8");

        if (tokenBuf.length === keyBuf.length && crypto.timingSafeEqual(tokenBuf, keyBuf)) {
            return {
                authenticated: true,
                identity: {
                    tenant_id: customTenantId || "default-tenant",
                    project_id: customProjectId,
                    env: customEnv,
                    rate_limit: 10000,
                },
            };
        }
    }

    return {
        authenticated: false,
        error: "Invalid, expired, or revoked API key",
    };
}

/**
 * Verifies if the incoming Authorization header contains a valid Admin API key.
 * Only accepts AGENTGUARD_ADMIN_KEY (or AGENTGUARD_API_KEY if AGENTGUARD_ADMIN_KEY is not configured).
 * Regular tenant DB API keys are NEVER accepted for administrative endpoints.
 */
export function verifyAdminKey(authHeader?: string): boolean {
    const adminKey = (process.env.AGENTGUARD_ADMIN_KEY || process.env.AGENTGUARD_API_KEY || "").trim();

    // If no admin key configured in environment, allow open access in dev mode
    if (adminKey === "") {
        return true;
    }

    if (!authHeader || typeof authHeader !== "string") {
        return false;
    }

    const trimmed = authHeader.trim();
    const tokenRaw = trimmed.startsWith("Bearer ") ? trimmed.slice(7).trim() : trimmed;
    const parts = tokenRaw.split(":");
    const tokenKey = parts.length === 4 ? parts[3] : tokenRaw;

    if (!tokenKey) return false;

    const tokenBuf = Buffer.from(tokenKey, "utf8");
    const keyBuf = Buffer.from(adminKey, "utf8");
    if (tokenBuf.length === keyBuf.length && crypto.timingSafeEqual(tokenBuf, keyBuf)) {
        return true;
    }

    return false;
}
