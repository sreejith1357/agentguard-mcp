/**
 * AgentGuard MCP v3.1.0 — Admin Audit Logger Utility
 *
 * Provides persistent SQLite audit trail logging for all administrative actions
 * including tenant creation, plan updates, key generation/revocation, circuit resets,
 * and webhook updates.
 */

import crypto from "crypto";
import db from "../db/schema.js";

export interface AuditLogRecord {
    id: string;
    action: string;
    tenant_id: string | null;
    details: string | null;
    ip_address: string | null;
    created_at: string;
}

/**
 * Logs an administrative action to the audit trail
 */
export function logAdminAction(params: {
    action: string;
    tenant_id?: string | null;
    details?: string | null;
    ip_address?: string | null;
}): AuditLogRecord {
    const id = `audit_${crypto.randomBytes(8).toString("hex")}`;
    const createdAt = new Date().toISOString();
    const tenantId = params.tenant_id || null;
    const details = params.details || null;
    const ipAddress = params.ip_address || "local";

    try {
        db.prepare(`
            INSERT INTO admin_audit_logs (id, action, tenant_id, details, ip_address, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, params.action, tenantId, details, ipAddress, createdAt);
    } catch (err) {
        console.error("[AuditLogger] Failed to write audit log:", err);
    }

    return {
        id,
        action: params.action,
        tenant_id: tenantId,
        details,
        ip_address: ipAddress,
        created_at: createdAt,
    };
}

/**
 * Retrieves recent audit logs from SQLite
 */
export function listAdminAuditLogs(limit = 100): AuditLogRecord[] {
    try {
        const rows = db.prepare(`
            SELECT id, action, tenant_id, details, ip_address, created_at
            FROM admin_audit_logs
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit) as AuditLogRecord[];

        return rows;
    } catch (err) {
        console.error("[AuditLogger] Failed to list audit logs:", err);
        return [];
    }
}
