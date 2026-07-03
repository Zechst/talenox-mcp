# Talenox MCP — Design

Date: 2026-07-03

## Purpose

Talenox doesn't offer an official MCP/connector. This project builds one so payroll
processing can be driven from Claude (claude.ai custom connector or Claude Code),
starting with payroll and leaving a Lark ↔ Talenox leave-sync bridge as an explicit
future phase (not in scope here).

References informing this design (both already in this workspace/GitHub):
- `xero-mcp-server` (github.com/Zechst/xero-mcp-server) — tool-organization pattern
  (per-resource files), stdio-only, no remote/OAuth serving.
- `lark-mcp-oauth` (github.com/Zechst/lark-mcp-oauth) — remote per-user OAuth
  deployment pattern (proxy OAuth, encrypted token store, Render deploy). This is
  where the remote-connector plumbing comes from.

## Scope

**In scope (v1):**
- Employees (CRUD)
- Payroll: adhoc/recurring/attendance/leave payments, process/publish/unpublish,
  export, payslips (data + PDF)
- Custom Pay Items, Cost Centres (read-only lookups, needed as inputs to payroll
  payment tools)
- Full read/write access, including `process_payroll` / `publish_payroll`
- Dry-run mode on all write tools

**Explicitly out of scope (v1):**
- Leave, Leave Applications, Leave Approval Structure, Leave Approvers,
  Leave Off-in-Lieus, Leave Types, Leave Application/Attachments Flow — this is the
  whole leave-sync half of the original ask, deferred to a future Lark-bridge phase.
- Branches, Company Settings, Employee Roles, Holiday Policies, Jobs, Next of Kins,
  Working Days, Working Hours, Metadata, User Info (OAuth) — one-time setup/config
  resources or employee-record details not touched by the stated payroll workflow.
  Add later only if a real gap shows up in testing.

**Open-source:** yes — public repo, anyone can self-host with their own Talenox
OAuth app credentials.

## Architecture

Deployed as a **remote HTTP MCP server** (not stdio), addable as a claude.ai custom
connector or via `claude mcp add --transport http`.

- **MCP layer** — `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`,
  tools grouped by domain.
- **OAuth authorization server** — the service acts as an OAuth provider to MCP
  clients (discovered via `/.well-known/oauth-authorization-server`), proxying real
  authorization to Talenox's OAuth (`app.talenox.com/oauth/authorize` → `/token`).
  Same shape as `lark-mcp-oauth`'s `handler.ts`, adapted to Talenox's endpoints.
- **Token store** — see Auth section below.
- **Talenox client** (`src/talenox/client.ts`) — thin `fetch` wrapper, `Authorization:
  Bearer` header, base URL `https://api.talenox.com/api/v2/`, centralized error
  mapping (Talenox error → MCP tool error, message passed through).
- **Tools** — one file per domain (`src/tools/employees.ts`, `src/tools/payroll.ts`,
  `src/tools/pay-items.ts`, `src/tools/cost-centres.ts`), each exporting tool defs +
  handlers, registered in a central index. Mirrors `xero-mcp-server`'s per-resource
  organization.

**Deploy target: Render, native Node runtime — no Dockerfile.**
Lark's Docker setup exists solely to work around `keytar`'s OS-keychain dependency
(gnome-keyring/dbus in a headless container). This design never uses an OS keychain
— the encryption key is an env var and encryption uses Node's built-in `crypto`
module — so none of that complexity applies. Xero's repo has no remote deploy at
all (stdio-only), so it isn't a comparison point for deploy target.
- Build: `npm ci && npm run build`
- Start: `node dist/index.js`

## Auth: OAuth Proxy & Persistent Token Store

- Registration: an OAuth app created from a Talenox account (own `client_id`/
  `client_secret`), redirect URI = this service's `/callback`.
- Flow: client discovers OAuth metadata → redirected to our `/authorize` → redirected
  to Talenox's `authorize` endpoint → Talenox redirects back to our `/callback` with
  a code → exchanged server-side for Talenox access + refresh tokens → encrypted and
  stored → we mint our own MCP-facing token back to the client.
- **Storage: persistent from v1.** Encrypted SQLite (`better-sqlite3`) on a mounted
  Render disk (`/data/tokens.db`). Requires Render **Starter plan** (always-on,
  persistent disk) — not the free tier, since disk-less restarts would wipe tokens.
  This is real payroll automation depended on regularly, so persistence isn't
  deferred to a "phase 2."
- **Refresh-token rotation:** Talenox access tokens expire in 30 minutes. The refresh
  endpoint may issue a new refresh token on every rotation — the client always
  overwrites the stored refresh token with whatever the refresh call returns, never
  assumes it's stable across refreshes.
- **Proactive refresh:** token age checked before every tool call; refreshed shortly
  before expiry (e.g. at 25 min) rather than reactively on a 401.
- **Crash safety:** refresh writes are a single atomic SQLite transaction (new tokens
  written, old deleted together) so a crash mid-refresh can't leave a dead access
  token with no refresh token.
- `MCP_ENCRYPTION_KEY` (AES key) is an env var; losing/rotating it invalidates all
  stored tokens, so treat it as immutable infrastructure once set.

## Tool Set (v1)

**Employees:**
- `list_employees`, `get_employee`, `create_employee`, `update_employee`,
  `delete_employee`

**Payroll:**
- `create_adhoc_payment`, `create_recurring_payment`, `create_attendance_payment`,
  `create_leave_payment`
- `process_payroll`, `publish_payroll`, `unpublish_payroll`
- `export_payroll`
- `get_payslip` (data), `get_payslip_pdf`

**Supporting (read-only lookups for payroll inputs):**
- `list_pay_items`, `list_cost_centres`

All write tools accept `dry_run: boolean` (default `false`) — validates inputs and
resolves IDs, returns the exact payload that would be sent to Talenox, without
making the write call.

## Error Handling

- Talenox API errors (4xx/5xx) map to MCP tool errors with the original Talenox
  message passed through, so failures are diagnosable (e.g. "invalid cost centre
  id"), not generic.
- OAuth/token errors (expired refresh token, revoked access) surface as a distinct
  "reconnect the connector" error rather than a raw 401.
- Tool descriptions for `process_payroll` / `publish_payroll` explicitly note these
  are irreversible-ish in Talenox, so Claude confirms with the user before calling
  them rather than chaining payroll actions autonomously.

## Testing & Verification

No Talenox sandbox environment is documented — automated integration tests would
hit production/live data, so testing strategy is:

- **Unit tests:** Talenox client (mocked fetch), token-refresh/rotation logic
  (atomic write, always-overwrite-refresh-token behavior specifically).
- **Manual verification against the real account**, per new tool, before trusting
  it unattended:
  1. Exercise a read-only tool first (`list_employees`, `get_payslip`) to confirm
     auth/connectivity.
  2. For a write tool, run `dry_run: true` first and inspect the payload.
  3. Run it live on something small/reversible, then check the Talenox dashboard to
     confirm the entry matches what Claude reported.
  4. For `process_payroll` / `publish_payroll` — verify on the smallest possible
     real cycle first, not a full live payroll run, and confirm the dashboard state
     matches Claude's reported result before relying on it further.
  5. If the dashboard and Claude's reported result disagree, that's a response-
     mapping bug in the tool, to be fixed before further use.
- No automated test for the OAuth web flow itself — validated manually via the
  claude.ai connector, same approach as `lark-mcp-oauth`.

## Deferred / Not Planned

- Lark ↔ Talenox leave-sync bridge (future phase, not designed here).
- All Leave-* endpoints, and the "not currently planned" resource list under Scope
  above.
