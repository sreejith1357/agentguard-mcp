/**
 * AgentGuard MCP — Prompt Injection & Payload Sanitization Scanner
 *
 * Inspects untrusted tool responses for known prompt injection signatures,
 * chat delimiter spoofing, persona hijacking, exfiltration directives, and
 * invisible Unicode smuggling.
 */

export type InjectionSeverity = "low" | "medium" | "high" | "critical";

export interface InjectionMatch {
    field: string;
    category: string;
    severity: InjectionSeverity;
    signature: string;
    excerpt: string;
}

export interface InjectionScanResult {
    prompt_injection_detected: boolean;
    risk_level: "none" | InjectionSeverity;
    matches: InjectionMatch[];
}

interface SignatureRule {
    category: string;
    severity: InjectionSeverity;
    signature: string;
    pattern: RegExp;
}

const SIGNATURE_RULES: SignatureRule[] = [
    // 1. Instruction override attempts
    {
        category: "instruction_override",
        severity: "critical",
        signature: "ignore_previous_instructions",
        pattern: /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|original|system)\s+(instructions?|prompts?|rules?|directives?|constraints?)\b/i,
    },
    {
        category: "instruction_override",
        severity: "high",
        signature: "new_instructions_directive",
        pattern: /\b(new|updated|real|actual)\s+system\s+(instructions?|prompt|directive)\s*:/i,
    },
    // 2. Chat template / delimiter spoofing
    {
        category: "delimiter_spoofing",
        severity: "critical",
        signature: "chatml_or_special_token",
        pattern: /(<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>|<\|endoftext\|>|<<SYS>>|<\/?SYS>|\[INST\]|\[\/INST\])/,
    },
    {
        category: "delimiter_spoofing",
        severity: "high",
        signature: "markdown_system_header",
        pattern: /(?:^|\n)\s*#{1,4}\s*(SYSTEM\s+PROMPT|DEVELOPER\s+MESSAGE|HIDDEN\s+INSTRUCTIONS?)\s*:?/i,
    },
    // 3. Role / persona hijacking & jailbreaks
    {
        category: "persona_hijack",
        severity: "high",
        signature: "persona_reassignment",
        pattern: /\b(you\s+are\s+now\s+(?:a|an|in)\s+(?:unrestricted|unfiltered|jailbroken|DAN|developer\s+mode)|enable\s+DAN\s+mode|enter\s+developer\s+mode)\b/i,
    },
    {
        category: "persona_hijack",
        severity: "medium",
        signature: "jailbreak_keyword",
        pattern: /\bjailbreak\s+(mode|prompt|instructions?)\b/i,
    },
    // 4. Exfiltration / covert tool abuse directives
    {
        category: "exfiltration_directive",
        severity: "critical",
        signature: "secret_exfiltration",
        pattern: /\b(reveal|print|output|dump|send|exfiltrate|leak|post)\s+(your\s+|all\s+|the\s+)?(system\s+prompt|hidden\s+instructions?|api[_\s]?keys?|secrets?|credentials?|env(?:ironment)?\s+variables?)\b/i,
    },
    // 5. Invisible Unicode / tag character smuggling
    {
        category: "unicode_smuggling",
        severity: "medium",
        signature: "invisible_bidi_or_tag_chars",
        pattern: /[\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/,
    },
];

const SEVERITY_RANK: Record<"none" | InjectionSeverity, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
};

function scanString(fieldPath: string, text: string, matches: InjectionMatch[]): void {
    if (!text) return;

    for (const rule of SIGNATURE_RULES) {
        const match = rule.pattern.exec(text);
        if (match) {
            const start = Math.max(0, match.index - 20);
            const end = Math.min(text.length, match.index + match[0].length + 20);
            matches.push({
                field: fieldPath,
                category: rule.category,
                severity: rule.severity,
                signature: rule.signature,
                excerpt: text.slice(start, end).replace(/[\r\n]+/g, " "),
            });
        }
    }

    // Check long base64-like tokens (>= 32 chars) for hidden ASCII injection payloads
    const b64Matches = text.match(/[A-Za-z0-9+/]{32,}={0,2}/g);
    if (b64Matches) {
        for (const token of b64Matches.slice(0, 5)) {
            try {
                const decoded = Buffer.from(token, "base64").toString("utf8");
                // Only inspect if decoded text is predominantly printable ASCII
                if (/^[\x20-\x7E\r\n\t]{16,}$/.test(decoded)) {
                    for (const rule of SIGNATURE_RULES) {
                        if (rule.pattern.test(decoded)) {
                            matches.push({
                                field: fieldPath,
                                category: "obfuscated_injection",
                                severity: "critical",
                                signature: `base64:${rule.signature}`,
                                excerpt: decoded.slice(0, 80),
                            });
                            break;
                        }
                    }
                }
            } catch {
                /* ignore invalid base64 */
            }
        }
    }
}

function walkAndScan(
    value: unknown,
    path: string,
    matches: InjectionMatch[],
    depth: number
): void {
    if (depth > 15 || value === null || value === undefined) return;

    if (typeof value === "string") {
        scanString(path, value, matches);
        return;
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < Math.min(value.length, 200); i++) {
            walkAndScan(value[i], `${path}[${i}]`, matches, depth + 1);
        }
        return;
    }

    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const nextPath = path ? `${path}.${k}` : k;
            walkAndScan(v, nextPath, matches, depth + 1);
        }
    }
}

/**
 * Recursively scans structured or string tool responses for prompt injection patterns.
 */
export function scanForPromptInjection(data: unknown): InjectionScanResult {
    const matches: InjectionMatch[] = [];
    walkAndScan(data, "data", matches, 0);

    let maxSeverity: "none" | InjectionSeverity = "none";
    for (const m of matches) {
        if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[maxSeverity]) {
            maxSeverity = m.severity;
        }
    }

    return {
        prompt_injection_detected: matches.length > 0,
        risk_level: maxSeverity,
        matches,
    };
}

