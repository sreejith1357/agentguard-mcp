# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AgentGuard MCP (including SSRF bypasses, authentication flaws, XSS in the Admin Console, or prompt-injection evasion), please report it responsibly by contacting the maintainer via GitHub Security Advisories or `sjith310@gmail.com` rather than opening a public issue.

## Security Model

- **SSRF & DNS Rebinding Protection**: `health_check` and webhook delivery pre-resolve A/AAAA DNS records, block private/loopback/CGNAT/link-local/cloud-metadata CIDRs, pin socket connections to validated IPs with SNI preservation, and re-validate every HTTP redirect hop.
- **Authentication Isolation**: Administrative routes (`/admin/*`) strictly require `AGENTGUARD_ADMIN_KEY` (or `AGENTGUARD_API_KEY` fallback only if `AGENTGUARD_ADMIN_KEY` is unset); tenant database API keys cannot access administrative routes.
- **API Key Storage**: Keys are hashed with SHA-256 prior to SQLite storage and support optional expiration (`expires_at`) and tool-level scopes (`scopes`).
- **Webhook Integrity**: Outbound webhook payloads are signed with HMAC-SHA256 (`X-AgentGuard-Signature: t=...,v1=...`).

