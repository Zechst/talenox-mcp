# Security Policy

talenox-mcp handles OAuth tokens for real Talenox accounts and can trigger
real payroll writes. Please report security issues privately, not as a
public GitHub issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repo:
[github.com/Zechst/talenox-mcp/security/advisories/new](https://github.com/Zechst/talenox-mcp/security/advisories/new)

This opens a private draft advisory visible only to the maintainer until
it's resolved — it will not appear as a public issue or notification.

If you can't use that, email the maintainer via the address on the
[GitHub profile](https://github.com/Zechst).

## What to include

- A description of the vulnerability and its impact
- Steps to reproduce
- Affected version/commit
- Any relevant logs — with real Talenox tokens, client secrets, or employee
  data redacted first

## Scope

In scope: the OAuth flow (`src/auth/`), token storage, and the Talenox API
client (`src/talenox/`). Vulnerabilities in Talenox's own API or claude.ai's
own OAuth client implementation are out of scope for this repo — report
those to the respective vendor.
