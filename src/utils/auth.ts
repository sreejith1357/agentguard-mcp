/**
 * AgentGuard MCP v2.1.0 — Multi-Tenant Bearer Token Authentication & Identity Utility
 *
 * Provides constant-time Bearer token verification and resolves token identity
 * into a structured TenantIdentity ({ tenant_id, project_id, env, rate_limit }).
 * Uses AsyncLocalStorage to inject tenant identity into async tool execution contexts.
 */

import type { Request } from "express";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { verifyApiKey } from "./apiKeyStore";

export interface TenantIdentity {
    tenant_id: string;
    project_id: string;
    env: string;
    rate_limit: number;
    plan?: string;
    monthly_quota?: number;
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
    const envApiKey = process.env.AGENTGUARD_API_KEY;

    // Default tenant identity fallback
    const defaultIdentity: TenantIdentity = {
        tenant_id: "default-tenant",
        project_id: "default-project",
        env: envApiKey ? "production" : "development",
        rate_limit: envApiKey ? 100 : 10000,
    };

    const authHeader = req.headers["authorization"] || req.headers["Authorization"];

    // Open mode — if AGENTGUARD_API_KEY is not set AND no auth header is supplied
    if (!envApiKey && (!authHeader || typeof authHeader !== "string")) {
        return { authenticated: true, identity: defaultIdentity };
    }

    if (!authHeader || typeof authHeader !== "string") {
        return {
            authenticated: false,
            error: "Missing Authorization header. Use: Bearer <your-api-key>",
        };
    }

    const tokenRaw = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

    // Check if token specifies structured tenant scoping: "tenant_id:project_id:env:key"
    let tokenKey = tokenRaw;
    let customTenantId: string | null = null;
    let customProjectId = "default-project";
    let customEnv = "production";

    const parts = tokenRaw.split(":");
    if (parts.length === 4) {
        customTenantId = parts[0];
        customProjectId = parts[1] || "default-project";
        customEnv = parts[2] || "production";
        tokenKey = parts[3];
    }

    // 1. First check Database for hashed API keys
    const dbKeyCtx = verifyApiKey(tokenKey);
    if (dbKeyCtx) {
        return {
            authenticated: true,
            identity: {
                tenant_id: customTenantId || dbKeyCtx.tenant_id,
                project_id: customProjectId,
                env: customEnv,
                rate_limit: dbKeyCtx.monthly_quota,
                plan: dbKeyCtx.plan,
                monthly_quota: dbKeyCtx.monthly_quota,
            },
        };
    }

    // 2. Fall back to AGENTGUARD_API_KEY env variable check
    if (envApiKey && envApiKey.trim() !== "") {
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

    // 3. Open mode fallback if AGENTGUARD_API_KEY not set and no valid DB key matched
    if (!envApiKey) {
        return { authenticated: true, identity: defaultIdentity };
    }

    return {
        authenticated: false,
        error: "Invalid API key",
    };
}

/**
 * Verifies if the incoming Authorization header contains a valid admin API key or DB key.
 */
export function verifyAdminKey(authHeader?: string): boolean {
    const envApiKey = process.env.AGENTGUARD_API_KEY;

    if (!envApiKey && (!authHeader || typeof authHeader !== "string")) {
        return true;
    }

    if (!authHeader || typeof authHeader !== "string") {
        return false;
    }

    const tokenRaw = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
    const parts = tokenRaw.split(":");
    const tokenKey = parts.length === 4 ? parts[3] : tokenRaw;

    // Check DB key first
    const dbKeyCtx = verifyApiKey(tokenKey);
    if (dbKeyCtx) return true;

    // Check env key
    if (envApiKey && envApiKey.trim() !== "") {
        const tokenBuf = Buffer.from(tokenKey, "utf8");
        const keyBuf = Buffer.from(envApiKey, "utf8");
        if (tokenBuf.length === keyBuf.length && crypto.timingSafeEqual(tokenBuf, keyBuf)) {
            return true;
        }
    }

    return !envApiKey;
}

