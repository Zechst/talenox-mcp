# talenox-mcp

Remote MCP server that lets Claude (claude.ai custom connector or Claude Code)
drive Talenox payroll: employees, adhoc/recurring/attendance/leave payments,
process/publish/unpublish, exports, and payslips. Each user authenticates as
their own Talenox account via OAuth.

Leave management, Lark integration, and non-payroll Talenox resources
(branches, holiday policies, working hours, etc.) are explicitly out of scope
— see `docs/superpowers/specs/2026-07-03-talenox-mcp-design.md`.

## Setup

### 1. Register a Talenox OAuth app

1. Log into https://app.talenox.com.
2. Top-right nav → API Settings → OAuth 2.0 developer page.
3. Create an app: name it, set Redirect URI to
   `https://<your-service>.onrender.com/callback`, choose scopes.
4. Copy the generated Client ID and Client Secret.

### 2. Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep this value stable once set — changing it invalidates all stored tokens.

### 3. Deploy on Render

- New → Blueprint → select this repo (`render.yaml` is picked up).
- Fill in `PUBLIC_BASE_URL` (your service's own `https://<name>.onrender.com`
  URL — you know the name before first deploy), `TALENOX_CLIENT_ID`,
  `TALENOX_CLIENT_SECRET`, `MCP_ENCRYPTION_KEY` from steps 1-2.
- Requires the **Starter** plan (always-on, persistent disk) — tokens are
  stored on a mounted disk and would be lost on every restart on the free tier.

### 4. Connect clients

**Claude Code:**
```bash
claude mcp add --transport http --scope user talenox https://<name>.onrender.com/mcp
```

**claude.ai:** Settings → Connectors → Add custom connector → paste
`https://<name>.onrender.com/mcp` → Connect → log into Talenox + consent.

### 5. Validate

- Ask it to list employees (read-only, confirms auth).
- Try a payment tool with `dry_run: true` first, inspect the payload.
- Run a real write on something small, then confirm in the Talenox dashboard.
- See the design doc's Testing & Verification section for the full checklist
  before trusting `process_payroll` / `publish_payroll` unattended.
