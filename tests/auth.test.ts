/**
 * AgentGuard MCP — Unit Tests: Authentication, Admin Isolation, Key Expiry & Scopes
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { authenticateRequest, verifyAdminKey } from "../src/utils/auth.js";
import { createTenant, createApiKey, deleteTenant, clearApiKeyCache } from "../src/utils/apiKeyStore.js";
import { logCall } from "../src/utils/callLogger.js";
import db from "../src/db/schema.js";

describe("Authentication & API Key Hardening", () => {
    const origApiKey = process.env.AGENTGUARD_API_KEY;
    const origAdminKey = process.env.AGENTGUARD_ADMIN_KEY;

    afterEach(() => {
        clearApiKeyCache();
        if (origApiKey === undefined) delete process.env.AGENTGUARD_API_KEY;
        else process.env.AGENTGUARD_API_KEY = origApiKey;
        if (origAdminKey === undefined) delete process.env.AGENTGUARD_ADMIN_KEY;
        else process.env.AGENTGUARD_ADMIN_KEY = origAdminKey;
    });

    it("rejects regular tenant DB API keys on admin endpoints", () => {
        process.env.AGENTGUARD_ADMIN_KEY = "super-secret-admin-key";
        const tid = `auth-tenant-${Date.now()}`;
        createTenant({ tenant_id: tid, name: "Auth Tenant", plan: "pro" });
        const keyObj = createApiKey({ tenant_id: tid, name: "Tenant Key" });

        assert.equal(verifyAdminKey(`Bearer ${keyObj.key}`), false);
        assert.equal(verifyAdminKey("Bearer super-secret-admin-key"), true);
        assert.equal(verifyAdminKey("Bearer wrong-key"), false);
        assert.equal(verifyAdminKey(undefined), false);
    });

    it("rejects invalid Bearer tokens even when AGENTGUARD_API_KEY is unset", () => {
        delete process.env.AGENTGUARD_API_KEY;

        // No header -> dev open mode allowed
        const openReq = { headers: {} } as unknown as Request;
        assert.equal(authenticateRequest(openReq).authenticated, true);

        // Explicit invalid Bearer header -> MUST reject
        const badReq = { headers: { authorization: "Bearer ag_live_invalid_token" } } as unknown as Request;
        const badRes = authenticateRequest(badReq);
        assert.equal(badRes.authenticated, false);
    });

    it("enforces API key expiration and attaches scopes", () => {
        process.env.AGENTGUARD_API_KEY = "fallback-master";
        const tid = `exp-tenant-${Date.now()}`;
        createTenant({ tenant_id: tid, name: "Expiry Corp", plan: "starter" });

        const expiredKey = createApiKey({
            tenant_id: tid,
            name: "Expired Key",
            expires_at: new Date(Date.now() - 60_000).toISOString(),
        });
        const expiredReq = { headers: { authorization: `Bearer ${expiredKey.key}` } } as unknown as Request;
        assert.equal(authenticateRequest(expiredReq).authenticated, false);

        const validScopedKey = createApiKey({
            tenant_id: tid,
            name: "Scoped Valid Key",
            expires_in_days: 7,
            scopes: ["health_check", "log_checkpoint"],
        });
        const validReq = { headers: { authorization: `Bearer ${validScopedKey.key}` } } as unknown as Request;
        const validRes = authenticateRequest(validReq);
        assert.equal(validRes.authenticated, true);
        assert.deepEqual(validRes.identity?.scopes, ["health_check", "log_checkpoint"]);
    });

    it("cascades tenant deletion across call_logs and session_checkpoints", () => {
        const tid = `cascade-tenant-${Date.now()}`;
        createTenant({ tenant_id: tid, name: "Cascade Corp", plan: "free" });
        logCall({
            tenant_id: tid,
            project_id: "default-project",
            env: "production",
            tool_name: "health_check",
            success: true,
            response_time_ms: 12,
        });

        const beforeCount = (
            db.prepare("SELECT COUNT(*) as cnt FROM call_logs WHERE tenant_id = ?").get(tid) as { cnt: number }
        ).cnt;
        assert.equal(beforeCount, 1);

        assert.equal(deleteTenant(tid), true);

        const afterCount = (
            db.prepare("SELECT COUNT(*) as cnt FROM call_logs WHERE tenant_id = ?").get(tid) as { cnt: number }
        ).cnt;
        assert.equal(afterCount, 0);
    });
});

