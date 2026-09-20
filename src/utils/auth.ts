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

export interface TenantIdentity {
    tenant_id: string;
    project_id: string;
    env: string;
    rate_limit: number;
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
 * Employs crypto.timingSafeEqual to prevent timing side-channel attacks.
 */
export function authenticateRequest(req: Request): AuthResult {
    const apiKey = process.env.AGENTGUARD_API_KEY;

    // Default tenant identity fallback
    const defaultIdentity: TenantIdentity = {
        tenant_id: "default-tenant",
        project_id: "default-project",
        env: apiKey ? "production" : "development",
        rate_limit: apiKey ? 100 : 10000,
    };

    // Open mode — if AGENTGUARD_API_KEY is not set or empty, allow all requests
    if (!apiKey || apiKey.trim() === "") {
        return { authenticated: true, identity: defaultIdentity };
    }

    const authHeader = req.headers["authorization"] || req.headers["Authorization"];

    // Missing header
    if (!authHeader || typeof authHeader !== "string") {
        return {
            authenticated: false,
            error: "Missing Authorization header. Use: Bearer <your-api-key>",
        };
    }

    // Invalid format — must be "Bearer <token>"
    if (!authHeader.startsWith("Bearer ")) {
        return {
            authenticated: false,
            error: "Invalid Authorization format. Use: Bearer <your-api-key>",
        };
    }

    // Extract token
    const tokenRaw = authHeader.slice(7).trim();

    // Check if token specifies structured tenant scoping: "tenant_id:project_id:env:key"
    let tokenKey = tokenRaw;
    let identity: TenantIdentity = { ...defaultIdentity };

    const parts = tokenRaw.split(":");
    if (parts.length === 4) {
        identity = {
            tenant_id: parts[0] || "default-tenant",
            project_id: parts[1] || "default-project",
            env: parts[2] || "production",
            rate_limit: 100,
        };
        tokenKey = parts[3];
    }

    const tokenBuf = Buffer.from(tokenKey, "utf8");
    const keyBuf = Buffer.from(apiKey, "utf8");

    // Constant-time length check
    if (tokenBuf.length !== keyBuf.length) {
        return {
            authenticated: false,
            error: "Invalid API key",
        };
    }

    // Constant-time comparison to prevent timing side-channel attacks
    if (crypto.timingSafeEqual(tokenBuf, keyBuf)) {
        return { authenticated: true, identity };
    }

    return {
        authenticated: false,
        error: "Invalid API key",
    };
}
