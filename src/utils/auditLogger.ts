/**
 * AgentGuard MCP v3.1.2 — Admin Audit Logger Utility
 *
 * Provides persistent SQLite audit trail logging for administrative actions
 * with filterable querying (action, tenant_id, since, limit).
 */

import crypto from "node:crypto";
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
 * Logs an administrative action to the audit trail.
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
    const ipAddress = params.ip_address || "unknown";

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
 * Retrieves recent audit logs from SQLite with optional filtering.
 */
export function listAdminAuditLogs(
    optionsOrLimit:
        | number
        | {
              limit?: number;
              action?: string;
              tenant_id?: string;
              since?: string;
          } = 100
): AuditLogRecord[] {
    const opts = typeof optionsOrLimit === "number" ? { limit: optionsOrLimit } : optionsOrLimit;
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);

    try {
        let sql = `SELECT id, action, tenant_id, details, ip_address, created_at FROM admin_audit_logs WHERE 1=1`;
        const params: unknown[] = [];

        if (opts.action) {
            sql += ` AND action = ?`;
            params.push(opts.action);
        }
        if (opts.tenant_id && opts.tenant_id !== "all") {
            sql += ` AND tenant_id = ?`;
            params.push(opts.tenant_id);
        }
        if (opts.since) {
            sql += ` AND created_at >= ?`;
            params.push(opts.since);
        }

        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);

        return db.prepare(sql).all(...params) as AuditLogRecord[];
    } catch (err) {
        console.error("[AuditLogger] Failed to list audit logs:", err);
        return [];
    }
}
