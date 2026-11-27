/**
 * AgentGuard MCP — Shared Validation Schemas & Helpers
 * Centralizes numeric safety bounds and common input parsers across tools and routes.
 */

import { z } from "zod";

export const MAX_SAFE_VALUE = 1e15;

export const safeNumericSchema = z
    .number()
    .finite()
    .refine(
        (val) => !Number.isNaN(val) && Number.isFinite(val) && Math.abs(val) <= MAX_SAFE_VALUE,
        {
            message: `Value must be a finite double-precision number within range [-${MAX_SAFE_VALUE}, ${MAX_SAFE_VALUE}]`,
        }
    );

/**
 * Safely parse a positive integer environment variable with fallback and optional bounds.
 */
export function parseEnvInt(
    name: string,
    defaultValue: number,
    min: number = 1,
    max: number = Number.MAX_SAFE_INTEGER
): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        return defaultValue;
    }
    return parsed;
}

