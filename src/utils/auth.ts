/**
 * AgentGuard MCP v2.0.0 — Bearer Token Authentication Utility
 *
 * Provides constant-time Bearer token verification against AGENTGUARD_API_KEY.
 * When AGENTGUARD_API_KEY is unset or empty, runs in open mode (development convenience).
 */

import type { Request } from "express";
import crypto from "node:crypto";

export interface AuthResult {
    authenticated: boolean;
    error?: string;
}

/**
 * Authenticate an incoming Express HTTP request using Bearer token verification.
 * Employs crypto.timingSafeEqual to prevent timing side-channel attacks.
 */
export function authenticateRequest(req: Request): AuthResult {
    const apiKey = process.env.AGENTGUARD_API_KEY;

    // Open mode — if AGENTGUARD_API_KEY is not set or empty, allow all requests
    if (!apiKey || apiKey.trim() === "") {
        return { authenticated: true };
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
    const token = authHeader.slice(7).trim();

    const tokenBuf = Buffer.from(token, "utf8");
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
        return { authenticated: true };
    }

    return {
        authenticated: false,
        error: "Invalid API key",
    };
}
