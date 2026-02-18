# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main) | :white_check_mark: |
| Older releases | :x: |

## Scope

The following are **in scope** for security reports:

- Authentication and session management (`convex/auth.ts`, `@convex-dev/auth`)
- Multi-tenant data isolation (organization-scoped queries)
- API key authentication (`/api/v1/` endpoints)
- HMAC webhook signature verification
- Permission/RBAC bypass vulnerabilities
- Injection vulnerabilities (query injection, XSS, etc.)

**Out of scope:**

- Rate limiting and brute-force resistance
- Social engineering attacks
- Physical security
- Denial-of-service attacks
- Issues in third-party services (Convex platform, Vercel)
- Vulnerabilities requiring physical access to a device

## Reporting a Vulnerability

**Please do not report security vulnerabilities via public GitHub issues.**

Send an email to **security@hnbcrm.com** with:

1. A description of the vulnerability and its potential impact
2. Steps to reproduce (proof-of-concept code or screenshots if applicable)
3. Any relevant environment details (OS, browser, Node version)

### Response SLA

| Milestone | Target |
|-----------|--------|
| Acknowledgement | 48 hours |
| Initial assessment | 5 business days |
| Patch for critical issues | 14 days |
| Patch for non-critical issues | 90 days |

We will keep you informed throughout the process and credit you in the release notes (unless you prefer to remain anonymous).

## Disclosure Policy

We follow **coordinated disclosure**: please give us time to patch before publishing details publicly. We aim to resolve critical issues within 14 days and will work with you on a mutually agreed disclosure timeline.
