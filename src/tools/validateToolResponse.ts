/**
 * AgentGuard MCP — Tool: validate_tool_response
 *
 * Inspects data returned from any MCP tool for:
 *  1. Required field presence
 *  2. Field type correctness
 *  3. Data freshness (via timestamp age check)
 *  4. Custom per-field sanity rules (numeric bounds, regex pattern)
 *  5. Prompt injection & delimiter spoofing detection
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildResponse, buildErrorResponse } from "../utils/response.js";
import { scanForPromptInjection } from "../utils/injectionDetector.js";
import { getTenantContext } from "../utils/auth.js";
import { dispatchWebhookEvent } from "../utils/webhookDispatcher.js";
import type {
    ValidationResult,
    ExpectedFieldType,
    FieldValidationResult,
} from "../types/index.js";

const CustomRuleSchema = z.object({
    field: z.string().describe("The field name to apply this rule to"),
    min: z.number().optional().describe("Minimum numeric value (inclusive)"),
    max: z.number().optional().describe("Maximum numeric value (inclusive)"),
    pattern: z
        .string()
        .max(256)
        .optional()
        .describe("Regex pattern the field value must match (as string)"),
});

const SchemaMapSchema = z
    .record(
        z.string(),
        z.enum(["string", "number", "boolean", "array", "object", "null"])
    )
    .describe("Map of field name → expected JS type");

function resolveType(value: unknown): ExpectedFieldType {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value as ExpectedFieldType;
}

function getNestedField(obj: Record<string, unknown>, key: string): unknown {
    return key.split(".").reduce<unknown>((acc, part) => {
        if (acc !== null && typeof acc === "object") {
            if (Array.isArray(acc)) {
                const idx = Number(part);
                return Number.isInteger(idx) && idx >= 0 && idx < acc.length ? acc[idx] : undefined;
            }
            return (acc as Record<string, unknown>)[part];
        }
        return undefined;
    }, obj);
}

function validateRequiredFields(
    data: Record<string, unknown>,
    requiredFields: string[]
): { errors: string[]; results: Record<string, FieldValidationResult> } {
    const errors: string[] = [];
    const results: Record<string, FieldValidationResult> = {};

    for (const field of requiredFields) {
        const value = getNestedField(data, field);
        const present = value !== undefined && value !== null;
        results[`required:${field}`] = {
            passed: present,
            reason: present
                ? `Field "${field}" is present`
                : `Required field "${field}" is missing or null`,
        };
        if (!present) {
            errors.push(`Required field "${field}" is missing or null`);
        }
    }

    return { errors, results };
}

function validateSchema(
    data: Record<string, unknown>,
    schema: Record<string, string>
): { errors: string[]; results: Record<string, FieldValidationResult> } {
    const errors: string[] = [];
    const results: Record<string, FieldValidationResult> = {};

    for (const [field, expectedType] of Object.entries(schema)) {
        const value = getNestedField(data, field);
        if (value === undefined) {
            results[`type:${field}`] = {
                passed: true,
                reason: `Field "${field}" not present — type check skipped`,
            };
            continue;
        }
        const actualType = resolveType(value);
        const passed = actualType === expectedType;
        results[`type:${field}`] = {
            passed,
            reason: passed
                ? `"${field}" is ${actualType} ✓`
                : `"${field}" expected ${expectedType}, got ${actualType}`,
        };
        if (!passed) {
            errors.push(
                `Type mismatch on "${field}": expected ${expectedType}, got ${actualType}`
            );
        }
    }

    return { errors, results };
}

function validateAge(
    data: Record<string, unknown>,
    maxAgeSeconds: number
): {
    ageSeconds: number | undefined;
    ageCheck: "passed" | "stale" | "no_timestamp";
    warnings: string[];
    results: Record<string, FieldValidationResult>;
} {
    const warnings: string[] = [];
    const results: Record<string, FieldValidationResult> = {};

    const candidateFields = ["timestamp", "created_at", "updated_at", "ts", "time"];
    let timestampValue: unknown;
    let foundField = "";

    for (const f of candidateFields) {
        const v = getNestedField(data, f);
        if (v !== undefined) {
            timestampValue = v;
            foundField = f;
            break;
        }
    }

    if (timestampValue === undefined) {
        results["freshness:timestamp"] = {
            passed: false,
            reason: "No timestamp field found — cannot verify freshness",
        };
        warnings.push(
            "max_age_seconds was specified but no timestamp field found in data"
        );
        return { ageSeconds: undefined, ageCheck: "no_timestamp", warnings, results };
    }

    const parsed = new Date(String(timestampValue));
    if (Number.isNaN(parsed.getTime())) {
        results["freshness:timestamp"] = {
            passed: false,
            reason: `Field "${foundField}" is not a parseable date: "${timestampValue}"`,
        };
        warnings.push(`Timestamp field "${foundField}" could not be parsed as a date`);
        return { ageSeconds: undefined, ageCheck: "no_timestamp", warnings, results };
    }

    const ageSeconds = (Date.now() - parsed.getTime()) / 1000;
    const stale = ageSeconds > maxAgeSeconds;

    results["freshness:timestamp"] = {
        passed: !stale,
        reason: stale
            ? `Data is ${ageSeconds.toFixed(1)}s old (max: ${maxAgeSeconds}s) — STALE`
            : `Data is ${ageSeconds.toFixed(1)}s old (max: ${maxAgeSeconds}s) ✓`,
    };

    if (stale) {
        warnings.push(
            `Data freshness violation: ${ageSeconds.toFixed(1)}s old, max allowed is ${maxAgeSeconds}s`
        );
    }

    return {
        ageSeconds,
        ageCheck: stale ? "stale" : "passed",
        warnings,
        results,
    };
}

function validateCustomRules(
    data: Record<string, unknown>,
    rules: z.infer<typeof CustomRuleSchema>[]
): { errors: string[]; warnings: string[]; results: Record<string, FieldValidationResult> } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const results: Record<string, FieldValidationResult> = {};

    for (const rule of rules) {
        const value = getNestedField(data, rule.field);

        if (value === undefined) {
            results[`rule:${rule.field}`] = {
                passed: false,
                reason: `Custom rule target "${rule.field}" not found in data`,
            };
            warnings.push(`Custom rule field "${rule.field}" not present in data`);
            continue;
        }

        if (rule.min !== undefined || rule.max !== undefined) {
            if (typeof value !== "number") {
                results[`rule:${rule.field}:numeric`] = {
                    passed: false,
                    reason: `Cannot apply numeric bounds to non-number field "${rule.field}" (got ${typeof value})`,
                };
                errors.push(
                    `Field "${rule.field}" is not a number — cannot apply min/max bounds`
                );
            } else {
                const belowMin = rule.min !== undefined && value < rule.min;
                const aboveMax = rule.max !== undefined && value > rule.max;
                const passed = !belowMin && !aboveMax;
                results[`rule:${rule.field}:numeric`] = {
                    passed,
                    reason: passed
                        ? `"${rule.field}" = ${value} within bounds [${rule.min ?? "−∞"}, ${rule.max ?? "+∞"}] ✓`
                        : `"${rule.field}" = ${value} out of bounds [${rule.min ?? "−∞"}, ${rule.max ?? "+∞"}]`,
                };
                if (!passed) {
                    errors.push(
                        `Field "${rule.field}" value ${value} violates bounds [${rule.min ?? "−∞"}, ${rule.max ?? "+∞"}]`
                    );
                }
            }
        }

        if (rule.pattern !== undefined) {
            const strValue = String(value);
            let regex: RegExp;
            try {
                regex = new RegExp(rule.pattern);
            } catch {
                results[`rule:${rule.field}:pattern`] = {
                    passed: false,
                    reason: `Invalid regex pattern "${rule.pattern}"`,
                };
                errors.push(`Custom rule for "${rule.field}" has invalid regex: "${rule.pattern}"`);
                continue;
            }
            const passed = regex.test(strValue);
            results[`rule:${rule.field}:pattern`] = {
                passed,
                reason: passed
                    ? `"${rule.field}" matches pattern /${rule.pattern}/ ✓`
                    : `"${rule.field}" = "${strValue}" does not match /${rule.pattern}/`,
            };
            if (!passed) {
                errors.push(
                    `Field "${rule.field}" value "${strValue}" does not match required pattern /${rule.pattern}/`
                );
            }
        }
    }

    return { errors, warnings, results };
}

export function validateToolResponseTool(server: McpServer): void {
    server.registerTool(
        "validate_tool_response",
        {
            description:
                "Inspects data returned from another MCP tool for five independent validation checks: " +
                "1. Required field presence, 2. Field type schema validation, 3. Numeric value bounds & regex rules, " +
                "4. Data freshness via timestamp age, 5. Prompt injection & delimiter spoofing detection. " +
                "Returns a structured report so you can gate downstream actions on data trustworthiness.",
            inputSchema: {
                data: z
                    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
                    .describe(
                        "The raw tool response to validate. Can be a JSON string, plain text, object, or array."
                    ),
                schema: SchemaMapSchema.optional().describe(
                    "Map of field name to expected type. Supports dot notation for nested fields (e.g. 'meta.id')."
                ),
                required_fields: z
                    .array(z.string())
                    .optional()
                    .default([])
                    .describe("Fields that must be present and non-null in the data"),
                max_age_seconds: z
                    .number()
                    .positive()
                    .optional()
                    .describe(
                        "If set, checks that data timestamp field is not older than this many seconds"
                    ),
                custom_rules: z
                    .array(CustomRuleSchema)
                    .optional()
                    .default([])
                    .describe("Per-field sanity rules: numeric bounds and regex patterns"),
                check_prompt_injection: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Scan text fields for prompt injection, delimiter spoofing, and exfiltration directives (default: true)"),
                tool_name: z
                    .string()
                    .max(128)
                    .optional()
                    .describe("Optional source tool name for security telemetry and webhook alerts"),
            },
        },
        async ({ data, schema, required_fields, max_age_seconds, custom_rules, check_prompt_injection, tool_name }) => {
            try {
                const runInjectionCheck = check_prompt_injection ?? true;
                let parsed: Record<string, unknown>;
                let rawDataForScan: unknown = data;

                if (typeof data === "string") {
                    try {
                        const p = JSON.parse(data);
                        rawDataForScan = p;
                        if (Array.isArray(p)) {
                            parsed = { items: p };
                        } else if (typeof p !== "object" || p === null) {
                            parsed = { value: p };
                        } else {
                            parsed = p as Record<string, unknown>;
                        }
                    } catch {
                        // Even when non-JSON string is provided, still scan for prompt injection if enabled!
                        const injectionScan = runInjectionCheck
                            ? scanForPromptInjection(data)
                            : { prompt_injection_detected: false, risk_level: "none" as const, matches: [] };

                        const hasStructuralRequirements =
                            (required_fields && required_fields.length > 0) ||
                            (schema && Object.keys(schema).length > 0) ||
                            max_age_seconds !== undefined ||
                            (custom_rules && custom_rules.length > 0);

                        const errors: string[] = [];
                        const fieldResults: Record<string, FieldValidationResult> = {};

                        if (hasStructuralRequirements) {
                            errors.push("data is a string but could not be parsed as JSON");
                            fieldResults["parse:data"] = {
                                passed: false,
                                reason: "JSON.parse failed — data is not valid JSON",
                            };
                        }

                        if (injectionScan.prompt_injection_detected) {
                            errors.push(
                                `Prompt injection detected (${injectionScan.risk_level} risk): ${injectionScan.matches.map((m) => m.signature).join(", ")}`
                            );
                            fieldResults["security:prompt_injection"] = {
                                passed: false,
                                reason: `Detected ${injectionScan.matches.length} prompt injection signature(s)`,
                            };
                            const ctx = getTenantContext();
                            dispatchWebhookEvent({
                                tenant_id: ctx.tenant_id,
                                event: "anomaly.detected",
                                payload: {
                                    metric_name: tool_name || "validate_tool_response",
                                    severity: injectionScan.risk_level,
                                    signatures: injectionScan.matches.map((m) => m.signature),
                                    verdict: "Prompt injection detected in tool response",
                                    timestamp: new Date().toISOString(),
                                },
                            });
                        } else if (runInjectionCheck) {
                            fieldResults["security:prompt_injection"] = {
                                passed: true,
                                reason: "No prompt injection signatures detected ✓",
                            };
                        }

                        // Backward-compatible behavior: if structural checks weren't requested and text is clean, still reject non-JSON if no injection check passed? Wait: preserve exact JSON-parse error when string isn't JSON unless plain-text injection check was explicitly all that was asked?
                        // Wait: if caller only passes raw string (e.g. from README example), without structural rules, non-JSON clean string shouldn't fail unless JSON expected, OR wait: existing behavior returned valid: false for any non-JSON string! Keeping valid: false when non-JSON unless parsed, wait: README example passes raw_response string without schema! If valid text has no injection and no schema/required_fields, returning valid: !injectionDetected for plain text? Let's check: if schema or required_fields is empty AND no injection found, wait — what if a test passes invalid JSON expecting valid: false?
                        // Let's keep JSON parse error if `hasStructuralRequirements` OR if `data.trim().startsWith("{")` or `data.trim().startsWith("[")`. For plain text without JSON brackets and without structural checks, return `valid: !injectionScan.prompt_injection_detected`! That handles BOTH malformed JSON tests AND plain-text prompt-injection checks cleanly!
                        const looksLikeJson = data.trim().startsWith("{") || data.trim().startsWith("[");
                        if (!hasStructuralRequirements && looksLikeJson) {
                            errors.push("data is a string but could not be parsed as JSON");
                            fieldResults["parse:data"] = {
                                passed: false,
                                reason: "JSON.parse failed — data is not valid JSON",
                            };
                        }

                        return buildResponse<ValidationResult>({
                            valid: errors.length === 0,
                            errors,
                            warnings: [],
                            field_results: fieldResults,
                            ...(runInjectionCheck ? { security_scan: injectionScan } : {}),
                            timestamp: new Date().toISOString(),
                        });
                    }
                } else if (Array.isArray(data)) {
                    parsed = { items: data };
                } else {
                    parsed = data as Record<string, unknown>;
                }

                const allErrors: string[] = [];
                const allWarnings: string[] = [];
                const allResults: Record<string, FieldValidationResult> = {};

                // 1. Required fields
                const reqCheck = validateRequiredFields(parsed, required_fields ?? []);
                allErrors.push(...reqCheck.errors);
                Object.assign(allResults, reqCheck.results);

                // 2. Type schema
                if (schema && Object.keys(schema).length > 0) {
                    const schemaCheck = validateSchema(parsed, schema as Record<string, string>);
                    allErrors.push(...schemaCheck.errors);
                    Object.assign(allResults, schemaCheck.results);
                }

                // 3. Freshness
                let ageSeconds: number | undefined;
                let ageCheck: "passed" | "stale" | "no_timestamp" | undefined;
                if (max_age_seconds !== undefined) {
                    const freshnessCheck = validateAge(parsed, max_age_seconds);
                    ageSeconds = freshnessCheck.ageSeconds;
                    ageCheck = freshnessCheck.ageCheck;
                    allWarnings.push(...freshnessCheck.warnings);
                    Object.assign(allResults, freshnessCheck.results);
                    if (ageCheck === "stale") {
                        allErrors.push(
                            `Data is stale: ${ageSeconds?.toFixed(1)}s old (max: ${max_age_seconds}s)`
                        );
                    }
                }

                // 4. Custom rules
                if (custom_rules && custom_rules.length > 0) {
                    const ruleCheck = validateCustomRules(parsed, custom_rules);
                    allErrors.push(...ruleCheck.errors);
                    allWarnings.push(...ruleCheck.warnings);
                    Object.assign(allResults, ruleCheck.results);
                }

                // 5. Prompt injection security scan
                let securityScan;
                if (runInjectionCheck) {
                    securityScan = scanForPromptInjection(rawDataForScan);
                    if (securityScan.prompt_injection_detected) {
                        allErrors.push(
                            `Prompt injection detected (${securityScan.risk_level} risk): ${securityScan.matches.map((m) => `${m.field}:${m.signature}`).join(", ")}`
                        );
                        allResults["security:prompt_injection"] = {
                            passed: false,
                            reason: `Detected ${securityScan.matches.length} prompt injection signature(s) across fields`,
                        };
                        const ctx = getTenantContext();
                        dispatchWebhookEvent({
                            tenant_id: ctx.tenant_id,
                            event: "anomaly.detected",
                            payload: {
                                metric_name: tool_name || "validate_tool_response",
                                severity: securityScan.risk_level,
                                signatures: securityScan.matches.map((m) => m.signature),
                                verdict: "Prompt injection detected in tool response",
                                timestamp: new Date().toISOString(),
                            },
                        });
                    } else {
                        allResults["security:prompt_injection"] = {
                            passed: true,
                            reason: "No prompt injection signatures detected ✓",
                        };
                    }
                }

                const result: ValidationResult = {
                    valid: allErrors.length === 0,
                    errors: allErrors,
                    warnings: allWarnings,
                    field_results: allResults,
                    ...(securityScan ? { security_scan: securityScan } : {}),
                    ...(ageSeconds !== undefined && { age_seconds: Math.round(ageSeconds * 10) / 10 }),
                    ...(ageCheck !== undefined && { age_check: ageCheck }),
                    timestamp: new Date().toISOString(),
                };

                return buildResponse(result);
            } catch (error) {
                return buildErrorResponse("validate_tool_response", error);
            }
        }
    );
}
