# Talenox MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a remote, HTTP-based MCP server that lets Claude drive Talenox payroll processing (employees, payments, process/publish, payslips), deployable to Render, with per-user OAuth against Talenox and a persistent encrypted token store.

**Architecture:** Express HTTP server hosting `@modelcontextprotocol/sdk`'s `mcpAuthRouter` (spec-compliant OAuth 2.1 authorization server: PKCE, dynamic client registration, `/.well-known` metadata — required by claude.ai's connector flow) backed by a custom `OAuthServerProvider` implementation, plus the MCP endpoint (`StreamableHTTPServerTransport`). Talenox's `authorize` endpoint is standard and used directly; its `token`/`refresh` endpoint is nonstandard (requires a `code=<current access token>` param on refresh), so our provider mints its own opaque refresh token per grant, mapping it server-side (encrypted SQLite) to the real Talenox access+refresh token pair, and translates every refresh call into Talenox's actual required shape. Talenox's real access token passes through to the MCP client untouched — only the refresh leg is translated. Refresh is driven by the MCP client's own OAuth machinery calling our `/token` endpoint, not by a proactive per-tool-call check.

> **Revision note:** an earlier version of this plan (Tasks 3/5/7/8) used hand-rolled Express OAuth routes and a proactive per-request refresh check. That design was replaced during `/plan-ceo-review` after confirming claude.ai's connector OAuth requires PKCE + dynamic client registration, which the hand-rolled routes didn't implement — see the design spec's revision history. Tasks 2, 4, 6, 9-13 are unaffected by the change.

**Tech Stack:** TypeScript, Node 20+, `@modelcontextprotocol/sdk`, `express`, `better-sqlite3`, native `fetch`, `vitest` for tests.

## Global Constraints

- Node >= 20 (per `lark-mcp-oauth`/`xero-mcp-server` convention).
- No native OS-keychain dependency (no `keytar`) — encryption key comes from `MCP_ENCRYPTION_KEY` env var, AES-256-GCM via Node's built-in `crypto` module.
- Deploy target is Render's native Node runtime — no Dockerfile.
- Talenox API base URL: `https://api.talenox.com/api/v2/`. Auth header: `Authorization: Bearer <token>`.
- Talenox OAuth: authorize at `https://app.talenox.com/oauth/authorize`, token/refresh at `https://app.talenox.com/oauth/token`. Access tokens expire in 30 minutes.
- All write tools (`create_*_payment`, `process_payroll`, `publish_payroll`, `unpublish_payroll`) accept `dry_run: boolean` (default `false`).
- v1 tool scope only: Employees, Payroll, Pay Items (read), Cost Centres (read). No Leave-* tools, no Branches/Company Settings/Employee Roles/Holiday Policies/Jobs/Next of Kins/Working Days/Working Hours/Metadata/User Info.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vitest.config.ts`
- Create: `src/index.ts` (placeholder entry point, replaced in Task 8)

**Interfaces:**
- Produces: an `npm run build` command emitting `dist/`, an `npm test` command, an `npm run dev` command.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "talenox-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.5.0",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
.env
*.db
*.db-journal
```

- [ ] **Step 4: Write `.env.example`**

```
PORT=3000
PUBLIC_BASE_URL=https://your-service.onrender.com
TALENOX_CLIENT_ID=
TALENOX_CLIENT_SECRET=
MCP_ENCRYPTION_KEY=
TOKEN_STORE_PATH=./data/tokens.db
```

- [ ] **Step 5: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 6: Write placeholder `src/index.ts`**

```typescript
console.log("talenox-mcp: scaffold OK");
```

- [ ] **Step 7: Install dependencies and verify build**

Run: `npm install && npm run build && node dist/index.js`
Expected: prints `talenox-mcp: scaffold OK`

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example vitest.config.ts src/index.ts
git commit -m "chore(repo): scaffold talenox-mcp project"
```

---

### Task 2: Crypto helpers (AES-256-GCM)

**Files:**
- Create: `src/auth/crypto.ts`
- Test: `tests/auth/crypto.test.ts`

**Interfaces:**
- Produces: `encrypt(plaintext: string): string`, `decrypt(ciphertext: string): string` — both read the key from `process.env.MCP_ENCRYPTION_KEY` (64-char hex, 32 bytes) at call time. `ciphertext` format: `<ivHex>:<authTagHex>:<encryptedHex>`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/crypto.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "../../src/auth/crypto.js";

describe("crypto", () => {
  beforeAll(() => {
    process.env.MCP_ENCRYPTION_KEY =
      "0".repeat(63) + "1"; // 64 hex chars = 32 bytes
  });

  it("round-trips a string", () => {
    const plaintext = "talenox-access-token-abc123";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext for the same input each call", () => {
    const a = encrypt("same-input");
    const b = encrypt("same-input");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/crypto.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/crypto.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getKey(): Buffer {
  const hex = process.env.MCP_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "MCP_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Malformed ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/crypto.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/crypto.ts tests/auth/crypto.test.ts
git commit -m "feat(auth): add AES-256-GCM encrypt/decrypt helpers"
```

---

### Task 3: Persistent grant store

**Files:**
- Create: `src/auth/token-store.ts`
- Test: `tests/auth/token-store.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `src/auth/crypto.ts` (Task 2).
- Produces:
  - `type StoredGrant = { talenoxAccessToken: string; talenoxRefreshToken: string; expiresAt: number }`
  - `class TokenStore { constructor(dbPath: string); createGrant(grantId: string, grant: StoredGrant): void; getGrant(grantId: string): StoredGrant | null; findGrantByAccessToken(accessToken: string): StoredGrant | null; rotateGrant(oldGrantId: string, newGrantId: string, grant: StoredGrant): void; deleteGrant(grantId: string): void; close(): void }`
  - `grantId` is an opaque token **we** mint (a UUID) and hand to the MCP client as its OAuth `refresh_token` — Talenox's real refresh token never leaves the server. `rotateGrant` deletes `oldGrantId` and inserts `newGrantId` in a single atomic transaction, so a crash mid-rotation can never leave both an old and new row alive, or neither.
  - `findGrantByAccessToken` supports the `verifyAccessToken` hook (Task 5/7): the MCP client presents Talenox's real access token on every `/mcp` call, and we need to confirm it's the live token for *some* grant without knowing the grant id.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/token-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/auth/token-store.js";

describe("TokenStore", () => {
  let dir: string;
  let store: TokenStore;

  beforeEach(() => {
    process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
    dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
    store = new TokenStore(join(dir, "tokens.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null for an unknown grant", () => {
    expect(store.getGrant("nope")).toBeNull();
  });

  it("creates and retrieves a grant", () => {
    const grant = {
      talenoxAccessToken: "a1",
      talenoxRefreshToken: "r1",
      expiresAt: 12345,
    };
    store.createGrant("grant-1", grant);
    expect(store.getGrant("grant-1")).toEqual(grant);
  });

  it("finds a grant by its current Talenox access token", () => {
    store.createGrant("grant-1", {
      talenoxAccessToken: "a1",
      talenoxRefreshToken: "r1",
      expiresAt: 12345,
    });
    expect(store.findGrantByAccessToken("a1")).toEqual({
      talenoxAccessToken: "a1",
      talenoxRefreshToken: "r1",
      expiresAt: 12345,
    });
    expect(store.findGrantByAccessToken("not-a-real-token")).toBeNull();
  });

  it("rotateGrant atomically replaces the old grant id with a new one", () => {
    store.createGrant("grant-1", {
      talenoxAccessToken: "a1",
      talenoxRefreshToken: "r1",
      expiresAt: 100,
    });

    store.rotateGrant("grant-1", "grant-2", {
      talenoxAccessToken: "a2",
      talenoxRefreshToken: "r2",
      expiresAt: 200,
    });

    expect(store.getGrant("grant-1")).toBeNull();
    expect(store.getGrant("grant-2")).toEqual({
      talenoxAccessToken: "a2",
      talenoxRefreshToken: "r2",
      expiresAt: 200,
    });
  });

  it("deletes a grant", () => {
    store.createGrant("grant-1", {
      talenoxAccessToken: "a1",
      talenoxRefreshToken: "r1",
      expiresAt: 100,
    });
    store.deleteGrant("grant-1");
    expect(store.getGrant("grant-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/token-store.test.ts`
Expected: FAIL — `Cannot find module '../../src/auth/token-store.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/token-store.ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encrypt, decrypt } from "./crypto.js";

export type StoredGrant = {
  talenoxAccessToken: string;
  talenoxRefreshToken: string;
  expiresAt: number;
};

type Row = {
  grant_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

function rowToGrant(row: Row): StoredGrant {
  return {
    talenoxAccessToken: decrypt(row.access_token),
    talenoxRefreshToken: decrypt(row.refresh_token),
    expiresAt: row.expires_at,
  };
}

export class TokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  createGrant(grantId: string, grant: StoredGrant): void {
    this.db
      .prepare(
        `INSERT INTO grants (grant_id, access_token, refresh_token, expires_at)
         VALUES (@grantId, @accessToken, @refreshToken, @expiresAt)`,
      )
      .run({
        grantId,
        accessToken: encrypt(grant.talenoxAccessToken),
        refreshToken: encrypt(grant.talenoxRefreshToken),
        expiresAt: grant.expiresAt,
      });
  }

  getGrant(grantId: string): StoredGrant | null {
    const row = this.db
      .prepare(`SELECT * FROM grants WHERE grant_id = ?`)
      .get(grantId) as Row | undefined;
    return row ? rowToGrant(row) : null;
  }

  findGrantByAccessToken(accessToken: string): StoredGrant | null {
    // access_token is stored encrypted (nondeterministic ciphertext, see Task 2),
    // so this can't be a WHERE on the encrypted column — scan and decrypt.
    // Fine at this scale (single user's active grants); revisit with a
    // deterministic HMAC lookup column if this ever needs to scale further.
    const rows = this.db.prepare(`SELECT * FROM grants`).all() as Row[];
    for (const row of rows) {
      const grant = rowToGrant(row);
      if (grant.talenoxAccessToken === accessToken) {
        return grant;
      }
    }
    return null;
  }

  rotateGrant(oldGrantId: string, newGrantId: string, grant: StoredGrant): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM grants WHERE grant_id = ?`).run(oldGrantId);
      this.createGrant(newGrantId, grant);
    });
    tx();
  }

  deleteGrant(grantId: string): void {
    this.db.prepare(`DELETE FROM grants WHERE grant_id = ?`).run(grantId);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/token-store.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-store.ts tests/auth/token-store.test.ts
git commit -m "feat(auth): add encrypted SQLite token store with upsert rotation"
```

---

### Task 4: Talenox OAuth client (authorize URL, code exchange, refresh)

**Files:**
- Create: `src/auth/talenox-oauth-client.ts`
- Test: `tests/auth/talenox-oauth-client.test.ts`

**Interfaces:**
- Produces:
  - `type TalenoxTokenResponse = { access_token: string; refresh_token: string; expires_in: number }`
  - `function buildAuthorizeUrl(params: { clientId: string; redirectUri: string; scope: string; state: string }): string`
  - `async function exchangeCodeForTokens(params: { clientId: string; clientSecret: string; redirectUri: string; code: string }): Promise<TalenoxTokenResponse>`
  - `async function refreshTokens(params: { clientId: string; clientSecret: string; redirectUri: string; refreshToken: string; accessToken: string }): Promise<TalenoxTokenResponse>`
- These wrap Talenox's documented OAuth endpoints exactly:
  - Authorize: `https://app.talenox.com/oauth/authorize?client_id=...&redirect_uri=...&scope=...&response_type=code&state=...`
  - Token exchange: `POST https://app.talenox.com/oauth/token` with `grant_type=authorization_code&code=...&client_id=...&client_secret=...&redirect_uri=...`
  - Refresh: `POST https://app.talenox.com/oauth/token` with `grant_type=refresh_token&code=<access_token>&refresh_token=...&client_id=...&client_secret=...&redirect_uri=...` (Talenox's documented refresh call reuses the `code` param name for the current access token — kept as-is to match their API, not a typo).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/talenox-oauth-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
} from "../../src/auth/talenox-oauth-client.js";

describe("buildAuthorizeUrl", () => {
  it("builds the Talenox authorize URL with required params", () => {
    const url = buildAuthorizeUrl({
      clientId: "client-123",
      redirectUri: "https://example.com/callback",
      scope: "payroll",
      state: "state-abc",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://app.talenox.com/oauth/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://example.com/callback",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
  });
});

describe("exchangeCodeForTokens / refreshTokens", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("exchanges an authorization code for tokens", async () => {
    const mockResponse = {
      access_token: "acc-1",
      refresh_token: "ref-1",
      expires_in: 1800,
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as unknown as typeof fetch;

    const result = await exchangeCodeForTokens({
      clientId: "client-123",
      clientSecret: "secret-abc",
      redirectUri: "https://example.com/callback",
      code: "auth-code-xyz",
    });

    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://app.talenox.com/oauth/token"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshes tokens, always requesting a fresh refresh_token", async () => {
    const mockResponse = {
      access_token: "acc-2",
      refresh_token: "ref-2",
      expires_in: 1800,
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as unknown as typeof fetch;

    const result = await refreshTokens({
      clientId: "client-123",
      clientSecret: "secret-abc",
      redirectUri: "https://example.com/callback",
      refreshToken: "ref-1",
      accessToken: "acc-1",
    });

    expect(result).toEqual(mockResponse);
  });

  it("throws when Talenox returns a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    }) as unknown as typeof fetch;

    await expect(
      exchangeCodeForTokens({
        clientId: "client-123",
        clientSecret: "secret-abc",
        redirectUri: "https://example.com/callback",
        code: "bad-code",
      }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/talenox-oauth-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/talenox-oauth-client.ts
const TALENOX_AUTHORIZE_URL = "https://app.talenox.com/oauth/authorize";
const TALENOX_TOKEN_URL = "https://app.talenox.com/oauth/token";

export type TalenoxTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(TALENOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function postTokenRequest(
  params: Record<string, string>,
): Promise<TalenoxTokenResponse> {
  const url = new URL(TALENOX_TOKEN_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { method: "POST" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Talenox token endpoint returned ${response.status}: ${body}`,
    );
  }
  return (await response.json()) as TalenoxTokenResponse;
}

export async function exchangeCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<TalenoxTokenResponse> {
  return postTokenRequest({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
}

export async function refreshTokens(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  accessToken: string;
}): Promise<TalenoxTokenResponse> {
  return postTokenRequest({
    grant_type: "refresh_token",
    code: params.accessToken,
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/talenox-oauth-client.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/talenox-oauth-client.ts tests/auth/talenox-oauth-client.test.ts
git commit -m "feat(auth): add Talenox OAuth client (authorize/exchange/refresh)"
```

---

### Task 5: Talenox grant shim (exchange, refresh-translation, verify)

**Files:**
- Create: `src/auth/talenox-grant-shim.ts`
- Test: `tests/auth/talenox-grant-shim.test.ts`

**Interfaces:**
- Consumes: `TokenStore` (Task 3), `exchangeCodeForTokens`/`refreshTokens` (Task 4).
- Produces:
  - `type IssuedGrant = { accessToken: string; refreshToken: string; expiresIn: number }` — shaped for direct use as an MCP/OAuth token response body.
  - `class TalenoxGrantShim { constructor(store: TokenStore, oauthConfig: { clientId: string; clientSecret: string; redirectUri: string }, idGenerator?: () => string); exchangeAuthorizationCode(code: string): Promise<IssuedGrant>; refresh(ourRefreshToken: string): Promise<IssuedGrant>; verifyAccessToken(accessToken: string): { valid: true; expiresAt: number } | { valid: false } }`
  - `idGenerator` defaults to `crypto.randomUUID`, injectable for deterministic tests.
  - `exchangeAuthorizationCode`: calls Talenox's real authorization_code grant (standard shape, unaffected by the refresh quirk), mints a new opaque grant id, stores `{talenoxAccessToken, talenoxRefreshToken, expiresAt}` under it, returns `{accessToken: <Talenox's real access token>, refreshToken: <our opaque grant id>, expiresIn}`.
  - `refresh`: looks up the grant by `ourRefreshToken` (our opaque id, not Talenox's real refresh token); if not found, throws `GrantNotFoundError` (exported — Task 7 maps this to an OAuth `invalid_grant` error so the client knows to re-authorize). Otherwise calls Talenox's refresh endpoint using the **stored** `talenoxAccessToken` for the required `code` param and the stored `talenoxRefreshToken`, rotates to a new grant id via `TokenStore.rotateGrant`, and returns the new `{accessToken, refreshToken, expiresIn}` in the same shape.
  - `verifyAccessToken`: looks up `TokenStore.findGrantByAccessToken`; returns `{valid: false}` if not found or already past `expiresAt`, else `{valid: true, expiresAt}`. This never calls Talenox — it only trusts what this server already knows from the last exchange/refresh, which is correct because refresh is client-driven (Task 7), not proactive.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/talenox-grant-shim.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/auth/token-store.js";
import {
  TalenoxGrantShim,
  GrantNotFoundError,
} from "../../src/auth/talenox-grant-shim.js";
import * as talenoxOAuth from "../../src/auth/talenox-oauth-client.js";

describe("TalenoxGrantShim", () => {
  let dir: string;
  let store: TokenStore;
  let shim: TalenoxGrantShim;
  let idCounter: number;

  beforeEach(() => {
    process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
    dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
    store = new TokenStore(join(dir, "tokens.db"));
    idCounter = 0;
    shim = new TalenoxGrantShim(
      store,
      {
        clientId: "client-123",
        clientSecret: "secret-abc",
        redirectUri: "https://example.com/callback",
      },
      () => `grant-${++idCounter}`,
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exchanges an authorization code, minting an opaque grant id as refreshToken", async () => {
    vi.spyOn(talenoxOAuth, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "acc-1",
      refresh_token: "talenox-ref-1",
      expires_in: 1800,
    });

    const issued = await shim.exchangeAuthorizationCode("auth-code-xyz");

    expect(issued).toEqual({
      accessToken: "acc-1",
      refreshToken: "grant-1",
      expiresIn: 1800,
    });
    expect(store.getGrant("grant-1")).toEqual({
      talenoxAccessToken: "acc-1",
      talenoxRefreshToken: "talenox-ref-1",
      expiresAt: expect.any(Number),
    });
  });

  it("refresh looks up the stored access token to build Talenox's required code param, then rotates", async () => {
    vi.spyOn(talenoxOAuth, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "acc-1",
      refresh_token: "talenox-ref-1",
      expires_in: 1800,
    });
    await shim.exchangeAuthorizationCode("auth-code-xyz");

    const refreshSpy = vi
      .spyOn(talenoxOAuth, "refreshTokens")
      .mockResolvedValue({
        access_token: "acc-2",
        refresh_token: "talenox-ref-2",
        expires_in: 1800,
      });

    const issued = await shim.refresh("grant-1");

    expect(refreshSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "acc-1", // the stored Talenox access token, not the client's opaque id
        refreshToken: "talenox-ref-1",
      }),
    );
    expect(issued).toEqual({
      accessToken: "acc-2",
      refreshToken: "grant-2",
      expiresIn: 1800,
    });
    expect(store.getGrant("grant-1")).toBeNull(); // old grant id is gone
    expect(store.getGrant("grant-2")).toEqual({
      talenoxAccessToken: "acc-2",
      talenoxRefreshToken: "talenox-ref-2",
      expiresAt: expect.any(Number),
    });
  });

  it("refresh throws GrantNotFoundError for an unknown refresh token", async () => {
    await expect(shim.refresh("not-a-real-grant")).rejects.toThrow(
      GrantNotFoundError,
    );
  });

  it("verifyAccessToken reports valid for a live grant's access token", async () => {
    vi.spyOn(talenoxOAuth, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "acc-1",
      refresh_token: "talenox-ref-1",
      expires_in: 1800,
    });
    await shim.exchangeAuthorizationCode("auth-code-xyz");

    const result = shim.verifyAccessToken("acc-1");
    expect(result.valid).toBe(true);
  });

  it("verifyAccessToken reports invalid for an unknown access token", () => {
    const result = shim.verifyAccessToken("never-issued");
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/talenox-grant-shim.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/talenox-grant-shim.ts
import { randomUUID } from "node:crypto";
import type { TokenStore } from "./token-store.js";
import { exchangeCodeForTokens, refreshTokens } from "./talenox-oauth-client.js";

export type IssuedGrant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export class GrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`No stored grant for refresh token ${grantId}`);
    this.name = "GrantNotFoundError";
  }
}

export class TalenoxGrantShim {
  constructor(
    private store: TokenStore,
    private oauthConfig: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
    private idGenerator: () => string = randomUUID,
  ) {}

  async exchangeAuthorizationCode(code: string): Promise<IssuedGrant> {
    const tokens = await exchangeCodeForTokens({
      clientId: this.oauthConfig.clientId,
      clientSecret: this.oauthConfig.clientSecret,
      redirectUri: this.oauthConfig.redirectUri,
      code,
    });

    const grantId = this.idGenerator();
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    this.store.createGrant(grantId, {
      talenoxAccessToken: tokens.access_token,
      talenoxRefreshToken: tokens.refresh_token,
      expiresAt,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: grantId,
      expiresIn: tokens.expires_in,
    };
  }

  async refresh(ourRefreshToken: string): Promise<IssuedGrant> {
    const grant = this.store.getGrant(ourRefreshToken);
    if (!grant) {
      throw new GrantNotFoundError(ourRefreshToken);
    }

    const refreshed = await refreshTokens({
      clientId: this.oauthConfig.clientId,
      clientSecret: this.oauthConfig.clientSecret,
      redirectUri: this.oauthConfig.redirectUri,
      refreshToken: grant.talenoxRefreshToken,
      accessToken: grant.talenoxAccessToken,
    });

    const newGrantId = this.idGenerator();
    const expiresAt = Date.now() + refreshed.expires_in * 1000;

    this.store.rotateGrant(ourRefreshToken, newGrantId, {
      talenoxAccessToken: refreshed.access_token,
      talenoxRefreshToken: refreshed.refresh_token,
      expiresAt,
    });

    return {
      accessToken: refreshed.access_token,
      refreshToken: newGrantId,
      expiresIn: refreshed.expires_in,
    };
  }

  verifyAccessToken(accessToken: string): { valid: true; expiresAt: number } | { valid: false } {
    const grant = this.store.findGrantByAccessToken(accessToken);
    if (!grant || grant.expiresAt <= Date.now()) {
      return { valid: false };
    }
    return { valid: true, expiresAt: grant.expiresAt };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/talenox-grant-shim.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/talenox-grant-shim.ts tests/auth/talenox-grant-shim.test.ts
git commit -m "feat(auth): add Talenox grant shim (exchange/refresh-translation/verify)"
```

---

### Task 6: Talenox API client

**Files:**
- Create: `src/talenox/errors.ts`
- Create: `src/talenox/client.ts`
- Test: `tests/talenox/client.test.ts`

**Interfaces:**
- Produces:
  - `class TalenoxApiError extends Error { constructor(status: number, body: string) }`
  - `class TalenoxClient { constructor(accessToken: string); get<T>(path: string, query?: Record<string, string>): Promise<T>; post<T>(path: string, body: unknown): Promise<T>; put<T>(path: string, body: unknown): Promise<T>; delete<T>(path: string): Promise<T> }`
  - All methods prefix `path` with `https://api.talenox.com/api/v2/`, send `Authorization: Bearer <accessToken>` and `Content-Type: application/json`, throw `TalenoxApiError` on non-2xx with the response body as the message so the original Talenox error text passes through.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/talenox/client.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";

describe("TalenoxClient", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("GETs from the v2 base URL with bearer auth", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, name: "Jane" }),
    }) as unknown as typeof fetch;

    const client = new TalenoxClient("tok-123");
    const result = await client.get<{ id: number; name: string }>(
      "employees/1",
    );

    expect(result).toEqual({ id: 1, name: "Jane" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.talenox.com/api/v2/employees/1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-123",
        }),
      }),
    );
  });

  it("POSTs a JSON body", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 2 }),
    }) as unknown as typeof fetch;

    const client = new TalenoxClient("tok-123");
    await client.post("employees", { name: "New Employee" });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.talenox.com/api/v2/employees",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "New Employee" }),
      }),
    );
  });

  it("throws TalenoxApiError with the response body on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"error":"invalid cost centre id"}',
    }) as unknown as typeof fetch;

    const client = new TalenoxClient("tok-123");
    await expect(client.get("employees/999")).rejects.toThrow(
      TalenoxApiError,
    );
    await expect(client.get("employees/999")).rejects.toThrow(
      /invalid cost centre id/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/talenox/client.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `src/talenox/errors.ts`**

```typescript
// src/talenox/errors.ts
export class TalenoxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Talenox API error ${status}: ${body}`);
    this.name = "TalenoxApiError";
  }
}
```

- [ ] **Step 4: Write `src/talenox/client.ts`**

```typescript
// src/talenox/client.ts
import { TalenoxApiError } from "./errors.js";

const BASE_URL = "https://api.talenox.com/api/v2/";

export class TalenoxClient {
  constructor(private accessToken: string) {}

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, BASE_URL);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new TalenoxApiError(response.status, body);
    }

    return (await response.json()) as T;
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/talenox/client.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/talenox/errors.ts src/talenox/client.ts tests/talenox/client.test.ts
git commit -m "feat(talenox): add API client with bearer auth and error mapping"
```

---

### Task 7: Talenox OAuth provider (PKCE + dynamic client registration via SDK)

**Files:**
- Create: `src/auth/pending-authorizations.ts`
- Create: `src/auth/oauth-provider.ts`
- Test: `tests/auth/pending-authorizations.test.ts`
- Test: `tests/auth/oauth-provider.test.ts`

**Interfaces:**
- Consumes: `TalenoxGrantShim`/`GrantNotFoundError` (Task 5), `buildAuthorizeUrl` (Task 4).
- Produces:
  - `class PendingAuthorizations { constructor(ttlMs?: number, idGenerator?: () => string); create(payload: unknown): string; consume(id: string): unknown | null }` — in-memory, TTL-expiring (default 5 minutes), single-use (`consume` deletes on read). Ephemeral by design: a lost in-flight authorization just means the user retries login — no durability requirement, unlike the grant store. `create()` opportunistically sweeps expired entries before inserting (caught during `/plan-ceo-review`'s Section 3 security pass: without this, abandoned/never-completed `/authorize` attempts would grow the map unbounded, since `consume`/`peek` only clean up entries that are actually read).
  - `function createTalenoxOAuthProvider(config: { publicBaseUrl: string; talenoxClientId: string; talenoxClientSecret: string; scope: string; shim: TalenoxGrantShim }): { provider: OAuthServerProviderShape; callbackHandler: express.RequestHandler }`. The returned `provider` object matches the SDK's `OAuthServerProvider` interface (see implementer note below) with:
    - `clientsStore` — minimal in-memory `getClient`/`registerClient` (dynamic client registration; ephemeral across restarts, acceptable since claude.ai re-registers automatically on reconnect, same tradeoff as `PendingAuthorizations`).
    - `authorize(client, params, res)` — stores `{ clientRedirectUri, clientState, codeChallenge, codeChallengeMethod }` in a `PendingAuthorizations` instance (the "handoff"), redirects `res` to Talenox's real authorize URL with `state` set to the handoff id.
    - The `callbackHandler` (mounted separately at `/callback`, NOT part of the SDK's router — this is Talenox's redirect target, registered as the app's Redirect URI in the Talenox developer console): reads Talenox's `code`/`state`, looks up the handoff by `state`, immediately calls `shim.exchangeAuthorizationCode(code)`, mints a second, final single-use MCP authorization code via a second `PendingAuthorizations` instance carrying `{ accessToken, refreshToken, expiresIn, codeChallenge, codeChallengeMethod }`, and redirects the browser to `clientRedirectUri` with that new code + the original `clientState`.
    - `challengeForAuthorizationCode(client, code)` — looks up the final pending entry by `code` (without consuming), returns its `codeChallenge`/`codeChallengeMethod` so the SDK's router can verify the client's PKCE `code_verifier`.
    - `exchangeAuthorizationCode(client, code)` — consumes the final pending entry, returns `{ access_token, refresh_token, expires_in }` from the values already fetched at callback time (no second Talenox call).
    - `exchangeRefreshToken(client, refreshToken)` — calls `shim.refresh(refreshToken)`, maps `GrantNotFoundError` to whatever invalid-grant error the installed SDK expects (verify exact class/shape — see implementer note).
    - `verifyAccessToken(token)` — calls `shim.verifyAccessToken(token)`; on `{valid:false}` throws/returns the SDK's expected "invalid token" signal (verify exact contract — see implementer note); on valid, returns an `AuthInfo`-shaped object `{ token, clientId: "talenox-mcp-client", scopes: [config.scope], expiresAt: Math.floor(grant.expiresAt / 1000) }`.

**Note for implementer:** the exact method names/signatures of `OAuthServerProvider` (from `@modelcontextprotocol/sdk/server/auth/provider.js`) and the shape of `AuthInfo`/error classes it expects are SDK-version-sensitive — same caveat already flagged for `McpServer`/`StreamableHTTPServerTransport` in Tasks 9 and 12. Before writing this task, read `node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/provider.js` (or its `.d.ts`) and `.../router.js` in the installed version and adjust method names/signatures to match exactly. The structural decision to preserve regardless of exact SDK shape: a custom (non-Proxy) `OAuthServerProvider` implementation is required — NOT `ProxyOAuthServerProvider` — because Talenox's refresh grant is nonstandard (needs the extra `code=<access_token>` param) and a transparent proxy cannot express that translation.

- [ ] **Step 1: Write the failing test for `PendingAuthorizations`**

```typescript
// tests/auth/pending-authorizations.test.ts
import { describe, it, expect } from "vitest";
import { PendingAuthorizations } from "../../src/auth/pending-authorizations.js";

describe("PendingAuthorizations", () => {
  it("creates and consumes a payload exactly once", () => {
    const pending = new PendingAuthorizations(5 * 60 * 1000, () => "id-1");
    const id = pending.create({ foo: "bar" });
    expect(id).toBe("id-1");
    expect(pending.consume(id)).toEqual({ foo: "bar" });
    expect(pending.consume(id)).toBeNull();
  });

  it("returns null for an unknown id", () => {
    const pending = new PendingAuthorizations();
    expect(pending.consume("nope")).toBeNull();
  });

  it("expires an entry after the TTL", async () => {
    const pending = new PendingAuthorizations(10, () => "id-1"); // 10ms TTL
    const id = pending.create({ foo: "bar" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pending.consume(id)).toBeNull();
  });

  it("sweeps expired entries opportunistically on create(), bounding memory growth", async () => {
    let counter = 0;
    const pending = new PendingAuthorizations(10, () => `id-${++counter}`); // 10ms TTL
    pending.create({ abandoned: true }); // id-1, will expire and never be consumed
    await new Promise((resolve) => setTimeout(resolve, 20));

    pending.create({ fresh: true }); // id-2 — this create() call should sweep id-1 away

    expect((pending as any).entries.size).toBe(1);
    expect((pending as any).entries.has("id-2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/pending-authorizations.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/auth/pending-authorizations.ts`**

```typescript
// src/auth/pending-authorizations.ts
import { randomUUID } from "node:crypto";

type Entry = { payload: unknown; expiresAt: number };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class PendingAuthorizations {
  private entries = new Map<string, Entry>();

  constructor(
    private ttlMs: number = DEFAULT_TTL_MS,
    private idGenerator: () => string = randomUUID,
  ) {}

  create(payload: unknown): string {
    this.sweep(); // opportunistic cleanup — bounds memory growth from abandoned/never-completed authorize attempts without needing a background timer
    const id = this.idGenerator();
    this.entries.set(id, { payload, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  consume(id: string): unknown | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.entries.delete(id);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }

  peek(id: string): unknown | null {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/pending-authorizations.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/pending-authorizations.ts tests/auth/pending-authorizations.test.ts
git commit -m "feat(auth): add TTL-based single-use pending authorization store"
```

- [ ] **Step 6: Write the failing test for the OAuth provider**

```typescript
// tests/auth/oauth-provider.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/auth/token-store.js";
import { TalenoxGrantShim } from "../../src/auth/talenox-grant-shim.js";
import { createTalenoxOAuthProvider } from "../../src/auth/oauth-provider.js";
import * as talenoxOAuth from "../../src/auth/talenox-oauth-client.js";

describe("createTalenoxOAuthProvider", () => {
  let dir: string;
  let store: TokenStore;
  let shim: TalenoxGrantShim;

  beforeEach(() => {
    process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
    dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
    store = new TokenStore(join(dir, "tokens.db"));
    shim = new TalenoxGrantShim(store, {
      clientId: "client-123",
      clientSecret: "secret-abc",
      redirectUri: "https://example.onrender.com/callback",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("redirects authorize() to Talenox's real authorize URL", async () => {
    const { provider } = createTalenoxOAuthProvider({
      publicBaseUrl: "https://example.onrender.com",
      talenoxClientId: "client-123",
      talenoxClientSecret: "secret-abc",
      scope: "payroll",
      shim,
    });

    const redirectSpy = vi.fn();
    const fakeRes = { redirect: redirectSpy } as any;

    await provider.authorize(
      { client_id: "mcp-client-1" } as any,
      {
        redirectUri: "https://claude.ai/oauth/callback",
        state: "client-state-1",
        codeChallenge: "challenge-abc",
      } as any,
      fakeRes,
    );

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    const location = new URL(redirectSpy.mock.calls[0][0]);
    expect(location.origin + location.pathname).toBe(
      "https://app.talenox.com/oauth/authorize",
    );
  });

  it("runs the full authorize -> callback -> exchange -> refresh cycle", async () => {
    vi.spyOn(talenoxOAuth, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "acc-1",
      refresh_token: "talenox-ref-1",
      expires_in: 1800,
    });

    const { provider, callbackHandler } = createTalenoxOAuthProvider({
      publicBaseUrl: "https://example.onrender.com",
      talenoxClientId: "client-123",
      talenoxClientSecret: "secret-abc",
      scope: "payroll",
      shim,
    });

    let talenoxRedirectUrl = "";
    await provider.authorize(
      { client_id: "mcp-client-1" } as any,
      {
        redirectUri: "https://claude.ai/oauth/callback",
        state: "client-state-1",
        codeChallenge: "challenge-abc",
      } as any,
      { redirect: (url: string) => (talenoxRedirectUrl = url) } as any,
    );
    const handoffState = new URL(talenoxRedirectUrl).searchParams.get("state")!;

    let finalRedirectUrl = "";
    const fakeReq = {
      query: { code: "talenox-auth-code", state: handoffState },
    } as any;
    const fakeRes = { redirect: (url: string) => (finalRedirectUrl = url) } as any;
    await callbackHandler(fakeReq, fakeRes, () => {});

    const finalUrl = new URL(finalRedirectUrl);
    expect(finalUrl.origin + finalUrl.pathname).toBe(
      "https://claude.ai/oauth/callback",
    );
    expect(finalUrl.searchParams.get("state")).toBe("client-state-1");
    const mcpAuthCode = finalUrl.searchParams.get("code")!;

    const challenge = await provider.challengeForAuthorizationCode(
      { client_id: "mcp-client-1" } as any,
      mcpAuthCode,
    );
    expect(challenge).toBe("challenge-abc");

    const tokens = await provider.exchangeAuthorizationCode(
      { client_id: "mcp-client-1" } as any,
      mcpAuthCode,
    );
    expect(tokens.access_token).toBe("acc-1");
    expect(tokens.refresh_token).toBeTruthy();

    vi.spyOn(talenoxOAuth, "refreshTokens").mockResolvedValue({
      access_token: "acc-2",
      refresh_token: "talenox-ref-2",
      expires_in: 1800,
    });
    const refreshed = await provider.exchangeRefreshToken(
      { client_id: "mcp-client-1" } as any,
      tokens.refresh_token,
    );
    expect(refreshed.access_token).toBe("acc-2");
  });

  it("verifyAccessToken resolves valid tokens and rejects unknown ones", async () => {
    vi.spyOn(talenoxOAuth, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "acc-1",
      refresh_token: "talenox-ref-1",
      expires_in: 1800,
    });
    const { provider } = createTalenoxOAuthProvider({
      publicBaseUrl: "https://example.onrender.com",
      talenoxClientId: "client-123",
      talenoxClientSecret: "secret-abc",
      scope: "payroll",
      shim,
    });
    await shim.exchangeAuthorizationCode("talenox-auth-code");

    const info = await provider.verifyAccessToken("acc-1");
    expect(info.token).toBe("acc-1");

    await expect(provider.verifyAccessToken("never-issued")).rejects.toThrow();
  });
});
```

**Note for implementer:** adjust the exact shapes passed to `provider.authorize`/`challengeForAuthorizationCode`/`exchangeAuthorizationCode`/`exchangeRefreshToken`/`verifyAccessToken` in this test to match the installed SDK's real `OAuthServerProvider` interface (see the Interfaces section's implementer note) — the test's job is to prove the *behavior* (redirect to Talenox, full round-trip, PKCE challenge survives the two-hop redirect, verify accepts/rejects correctly), not to lock in exact SDK argument names if they differ by version.

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/auth/oauth-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 8: Write `src/auth/oauth-provider.ts`**

```typescript
// src/auth/oauth-provider.ts
import type { Request, Response, NextFunction } from "express";
import { buildAuthorizeUrl } from "./talenox-oauth-client.js";
import { TalenoxGrantShim, GrantNotFoundError } from "./talenox-grant-shim.js";
import { PendingAuthorizations } from "./pending-authorizations.js";

type HandoffPayload = {
  clientRedirectUri: string;
  clientState: string;
  codeChallenge: string;
};

type FinalCodePayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  codeChallenge: string;
};

export function createTalenoxOAuthProvider(config: {
  publicBaseUrl: string;
  talenoxClientId: string;
  talenoxClientSecret: string;
  scope: string;
  shim: TalenoxGrantShim;
}) {
  const redirectUri = `${config.publicBaseUrl}/callback`;
  const handoffs = new PendingAuthorizations();
  const finalCodes = new PendingAuthorizations();
  const registeredClients = new Map<string, unknown>();

  const clientsStore = {
    async getClient(clientId: string) {
      return registeredClients.get(clientId);
    },
    async registerClient(client: { client_id: string }) {
      registeredClients.set(client.client_id, client);
      return client;
    },
  };

  async function authorize(
    _client: unknown,
    params: { redirectUri: string; state: string; codeChallenge: string },
    res: Response,
  ) {
    const handoffId = handoffs.create({
      clientRedirectUri: params.redirectUri,
      clientState: params.state,
      codeChallenge: params.codeChallenge,
    } satisfies HandoffPayload);

    const url = buildAuthorizeUrl({
      clientId: config.talenoxClientId,
      redirectUri,
      scope: config.scope,
      state: handoffId,
    });

    console.log(JSON.stringify({ event: "oauth.authorize.redirect", handoffId }));
    res.redirect(url);
  }

  const callbackHandler = async (req: Request, res: Response, _next: NextFunction) => {
    const code = String(req.query.code ?? "");
    const handoffId = String(req.query.state ?? "");
    const handoff = handoffs.consume(handoffId) as HandoffPayload | null;

    if (!code || !handoff) {
      console.log(
        JSON.stringify({ event: "oauth.callback.invalid_handoff", handoffId }),
      );
      res.status(400).json({ error: "invalid or expired authorization handoff" });
      return;
    }

    const issued = await config.shim.exchangeAuthorizationCode(code);

    const mcpAuthCode = finalCodes.create({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      codeChallenge: handoff.codeChallenge,
    } satisfies FinalCodePayload);

    console.log(JSON.stringify({ event: "oauth.callback.exchanged", handoffId }));

    const redirectUrl = new URL(handoff.clientRedirectUri);
    redirectUrl.searchParams.set("code", mcpAuthCode);
    redirectUrl.searchParams.set("state", handoff.clientState);
    res.redirect(redirectUrl.toString());
  };

  async function challengeForAuthorizationCode(_client: unknown, code: string) {
    const entry = finalCodes.peek(code) as FinalCodePayload | null;
    if (!entry) throw new Error("unknown or expired authorization code");
    return entry.codeChallenge;
  }

  async function exchangeAuthorizationCode(_client: unknown, code: string) {
    const entry = finalCodes.consume(code) as FinalCodePayload | null;
    if (!entry) throw new Error("unknown or expired authorization code");
    return {
      access_token: entry.accessToken,
      refresh_token: entry.refreshToken,
      expires_in: entry.expiresIn,
    };
  }

  async function exchangeRefreshToken(_client: unknown, refreshToken: string) {
    try {
      const issued = await config.shim.refresh(refreshToken);
      console.log(JSON.stringify({ event: "oauth.refresh.success" }));
      return {
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        expires_in: issued.expiresIn,
      };
    } catch (err) {
      if (err instanceof GrantNotFoundError) {
        console.log(JSON.stringify({ event: "oauth.refresh.invalid_grant" }));
        throw new Error("invalid_grant"); // TODO(implementer): map to the SDK's expected invalid-grant error type
      }
      throw err;
    }
  }

  async function verifyAccessToken(token: string) {
    const result = config.shim.verifyAccessToken(token);
    if (!result.valid) {
      console.log(JSON.stringify({ event: "oauth.verify.invalid_token" }));
      throw new Error("invalid_token"); // TODO(implementer): map to the SDK's expected invalid-token error type
    }
    return {
      token,
      clientId: "talenox-mcp-client",
      scopes: [config.scope],
      expiresAt: Math.floor(result.expiresAt / 1000),
    };
  }

  return {
    provider: {
      clientsStore,
      authorize,
      challengeForAuthorizationCode,
      exchangeAuthorizationCode,
      exchangeRefreshToken,
      verifyAccessToken,
    },
    callbackHandler,
  };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run tests/auth/oauth-provider.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: Commit**

```bash
git add src/auth/oauth-provider.ts tests/auth/oauth-provider.test.ts
git commit -m "feat(auth): add Talenox OAuth provider (PKCE handoff + refresh translation)"
```

---

### Task 8: MCP server bootstrap and app wiring

**Files:**
- Create: `src/mcp-server.ts`
- Modify: `src/index.ts`
- Test: `tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: `createTalenoxOAuthProvider` (Task 7), `TalenoxGrantShim` (Task 5), `TokenStore` (Task 3).
- Produces: `function createApp(config: { publicBaseUrl: string; talenoxClientId: string; talenoxClientSecret: string; scope: string; store: TokenStore }): express.Express` — mounts `@modelcontextprotocol/sdk`'s `mcpAuthRouter` (using the Task 7 provider) for `/authorize`, `/token`, `/register`, and `/.well-known/oauth-authorization-server`; mounts the Task 7 `callbackHandler` at `GET /callback` directly (not part of `mcpAuthRouter` — this is Talenox's redirect target); mounts `GET /health` (unauthenticated, `{status:"ok"}`); and a `POST /mcp` endpoint gated by the SDK's bearer-auth middleware (built from the same provider's `verifyAccessToken`), which attaches the verified token to the request so tool handlers can construct a `TalenoxClient` from it. Actual MCP tool dispatch is wired in Task 12 once tools exist — this task proves the auth plumbing (401 on bad/missing token, 200 with a resolved identity on a valid one) before tools are layered on.

**Note for implementer:** the SDK exposes bearer-auth enforcement as middleware (commonly `requireBearerAuth` from `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js` in versions seen during this plan's research) that wraps a provider's `verifyAccessToken` and attaches the result to `req.auth`. Verify the exact import path and attached-property name against the installed SDK version and adjust Step 3 accordingly — same category of caveat as Task 7's provider shape.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/auth/token-store.js";
import { createApp } from "../src/mcp-server.js";

describe("createApp", () => {
  let dir: string;
  let store: TokenStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
    dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
    store = new TokenStore(join(dir, "tokens.db"));
    app = createApp({
      publicBaseUrl: "https://example.onrender.com",
      talenoxClientId: "client-123",
      talenoxClientSecret: "secret-abc",
      scope: "payroll",
      store,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns 401 for an unauthenticated /mcp request", async () => {
    const res = await request(app).post("/mcp").send({});
    expect(res.status).toBe(401);
  });

  it("returns 401 for a bogus bearer token on /mcp", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer not-a-real-token")
      .send({});
    expect(res.status).toBe(401);
  });

  it("still serves /health unauthenticated", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("serves OAuth metadata at the well-known endpoint", async () => {
    const res = await request(app).get(
      "/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Install `supertest` and run the test to verify it fails**

Run: `npm install --save-dev supertest @types/supertest && npx vitest run tests/mcp-server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/mcp-server.ts`**

```typescript
// src/mcp-server.ts
import express, { type Express } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createTalenoxOAuthProvider } from "./auth/oauth-provider.js";
import { TalenoxGrantShim } from "./auth/talenox-grant-shim.js";
import type { TokenStore } from "./auth/token-store.js";

export type AppConfig = {
  publicBaseUrl: string;
  talenoxClientId: string;
  talenoxClientSecret: string;
  scope: string;
  store: TokenStore;
};

export function createApp(config: AppConfig): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const shim = new TalenoxGrantShim(config.store, {
    clientId: config.talenoxClientId,
    clientSecret: config.talenoxClientSecret,
    redirectUri: `${config.publicBaseUrl}/callback`,
  });

  const { provider, callbackHandler } = createTalenoxOAuthProvider({
    publicBaseUrl: config.publicBaseUrl,
    talenoxClientId: config.talenoxClientId,
    talenoxClientSecret: config.talenoxClientSecret,
    scope: config.scope,
    shim,
  });

  app.get("/callback", callbackHandler);

  app.use(
    mcpAuthRouter({
      provider: provider as any, // see Task 7/8 implementer notes on exact provider typing
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
    }),
  );

  app.post(
    "/mcp",
    requireBearerAuth({ provider: provider as any }),
    (_req, res) => {
      // Tool dispatch is wired in Task 12 once the MCP transport and tool
      // registry exist. Reaching this point at all proves auth succeeded.
      res.json({ status: "authenticated" });
    },
  );

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: PASS (4 tests) — if import paths for `mcpAuthRouter`/`requireBearerAuth` don't match the installed SDK version, fix them per the Task 7/8 implementer notes before re-running.

- [ ] **Step 5: Wire up `src/index.ts`**

```typescript
// src/index.ts
import { createApp } from "./mcp-server.js";
import { TokenStore } from "./auth/token-store.js";

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const talenoxClientId = process.env.TALENOX_CLIENT_ID;
const talenoxClientSecret = process.env.TALENOX_CLIENT_SECRET;
const tokenStorePath = process.env.TOKEN_STORE_PATH ?? "./data/tokens.db";
const encryptionKey = process.env.MCP_ENCRYPTION_KEY;

if (!publicBaseUrl || !talenoxClientId || !talenoxClientSecret) {
  throw new Error(
    "PUBLIC_BASE_URL, TALENOX_CLIENT_ID, and TALENOX_CLIENT_SECRET must be set",
  );
}

if (!encryptionKey || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
  throw new Error(
    "MCP_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) " +
      "— generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

const store = new TokenStore(tokenStorePath);
const app = createApp({
  publicBaseUrl,
  talenoxClientId,
  talenoxClientSecret,
  scope: "payroll",
  store,
});

app.listen(port, () => {
  console.log(`talenox-mcp listening on :${port}`);
});
```

- [ ] **Step 6: Verify the full app boots**

Run:
```bash
MCP_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000001 \
PUBLIC_BASE_URL=http://localhost:3000 \
TALENOX_CLIENT_ID=test \
TALENOX_CLIENT_SECRET=test \
npm run build && node dist/index.js
```
Expected: prints `talenox-mcp listening on :3000`. Stop with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server.ts src/index.ts tests/mcp-server.test.ts package.json package-lock.json
git commit -m "feat(server): wire SDK OAuth router, Talenox callback, and authenticated /mcp endpoint"
```

---

### Task 9: Employees tools

**Files:**
- Create: `src/tools/employees.ts`
- Test: `tests/tools/employees.test.ts`

**Interfaces:**
- Consumes: `TalenoxClient` (Task 6).
- Produces: `function textResult(data: unknown): { content: [{ type: "text", text: string }] }` in a new shared module `src/tools/shared.ts` — imported by every tools file from here on, instead of each file redefining it (a DRY violation caught during `/plan-ceo-review`'s Section 5 code-quality pass). Also produces `type ToolContext = { talenox: TalenoxClient }` (defined in `employees.ts`, the canonical shape reused by every tools file) and `function registerEmployeeTools(server: McpServer, getContext: (extra: unknown) => ToolContext): void`, registering `list_employees`, `get_employee`, `create_employee`, `update_employee`, `delete_employee` via `server.registerTool`.
- Each handler calls `TalenoxClient` methods directly and returns MCP `{ content: [{ type: "text", text: JSON.stringify(result) }] }` via the shared `textResult` helper.

- [ ] **Step 0: Write `src/tools/shared.ts`**

```typescript
// src/tools/shared.ts
export function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
```

Run: `git add src/tools/shared.ts && git commit -m "feat(tools): add shared textResult helper"` — commit this immediately since it has no test of its own (trivial pass-through) and later steps in this task depend on importing it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tools/employees.test.ts
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEmployeeTools } from "../../src/tools/employees.js";
import type { TalenoxClient } from "../../src/talenox/client.js";

function makeMockTalenox() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as TalenoxClient;
}

describe("employee tools", () => {
  it("registers list_employees, calling GET employees", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue([{ id: 1, name: "Jane" }]);

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = (server as any)._registeredTools?.list_employees
      ?? (server as any).tools?.list_employees;
    expect(tool).toBeDefined();

    const result = await tool.callback({}, {});
    expect(talenox.get).toHaveBeenCalledWith("employees");
    expect(result.content[0].text).toContain("Jane");
  });

  it("registers create_employee, calling POST employees with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.post as any).mockResolvedValue({ id: 2 });

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = (server as any)._registeredTools?.create_employee
      ?? (server as any).tools?.create_employee;
    const result = await tool.callback({ employee: { name: "New" } }, {});

    expect(talenox.post).toHaveBeenCalledWith("employees", { name: "New" });
    expect(result.content[0].text).toContain("2");
  });
});
```

**Note for implementer:** `McpServer`'s internal storage of registered tools is not part of its public API and may differ by SDK version — inspect `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` if the test's tool lookup (`_registeredTools` / `tools`) doesn't match what's installed, and adjust the lookup expression in the test accordingly. The public contract that matters is `server.registerTool(name, schema, handler)` being called correctly — the test is inspecting internals only because there's no other way to invoke a handler without a full transport.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/employees.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/tools/employees.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TalenoxClient } from "../talenox/client.js";
import { textResult } from "./shared.js";

export type ToolContext = { talenox: TalenoxClient };

export function registerEmployeeTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_employees",
    {
      description: "List all employees in the Talenox account.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get("employees");
      return textResult(result);
    },
  );

  server.registerTool(
    "get_employee",
    {
      description: "Get a single employee by id.",
      inputSchema: { id: z.string() },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get(`employees/${args.id}`);
      return textResult(result);
    },
  );

  server.registerTool(
    "create_employee",
    {
      description:
        "Create a new employee. `employee` is passed through to Talenox as-is; refer to the Talenox API docs for country-specific required fields (HK/ID/MY/SG).",
      inputSchema: { employee: z.record(z.unknown()) },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.post("employees", args.employee);
      return textResult(result);
    },
  );

  server.registerTool(
    "update_employee",
    {
      description: "Update an existing employee by id.",
      inputSchema: { id: z.string(), employee: z.record(z.unknown()) },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.put(`employees/${args.id}`, args.employee);
      return textResult(result);
    },
  );

  server.registerTool(
    "delete_employee",
    {
      description: "Delete an employee by id.",
      inputSchema: { id: z.string() },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.delete(`employees/${args.id}`);
      return textResult(result);
    },
  );
}
```

- [ ] **Step 4: Install `zod` and run test to verify it passes**

Run: `npm install zod && npx vitest run tests/tools/employees.test.ts`
Expected: PASS (2 tests) — if the internal tool-lookup expression needed adjusting per the note above, confirm it now matches the installed SDK version.

- [ ] **Step 5: Commit**

```bash
git add src/tools/employees.ts tests/tools/employees.test.ts package.json package-lock.json
git commit -m "feat(tools): add employee CRUD tools"
```

---

### Task 10: Pay Items and Cost Centres tools (read-only lookups)

**Files:**
- Create: `src/tools/pay-items.ts`
- Create: `src/tools/cost-centres.ts`
- Test: `tests/tools/pay-items.test.ts`
- Test: `tests/tools/cost-centres.test.ts`

**Interfaces:**
- Consumes: `ToolContext` (Task 9).
- Produces: `registerPayItemTools(server, getContext)` registering `list_pay_items`; `registerCostCentreTools(server, getContext)` registering `list_cost_centres`. Both GET-only, same `textResult` shape as Task 9.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/tools/pay-items.test.ts
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPayItemTools } from "../../src/tools/pay-items.js";
import type { TalenoxClient } from "../../src/talenox/client.js";

describe("pay item tools", () => {
  it("registers list_pay_items, calling GET custom_pay_items", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue([{ id: 1, name: "Bonus" }]) } as unknown as TalenoxClient;

    registerPayItemTools(server, () => ({ talenox }));

    const tool = (server as any)._registeredTools?.list_pay_items
      ?? (server as any).tools?.list_pay_items;
    const result = await tool.callback({}, {});

    expect(talenox.get).toHaveBeenCalledWith("custom_pay_items");
    expect(result.content[0].text).toContain("Bonus");
  });
});
```

```typescript
// tests/tools/cost-centres.test.ts
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCostCentreTools } from "../../src/tools/cost-centres.js";
import type { TalenoxClient } from "../../src/talenox/client.js";

describe("cost centre tools", () => {
  it("registers list_cost_centres, calling GET cost_centres", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue([{ id: 1, name: "Engineering" }]) } as unknown as TalenoxClient;

    registerCostCentreTools(server, () => ({ talenox }));

    const tool = (server as any)._registeredTools?.list_cost_centres
      ?? (server as any).tools?.list_cost_centres;
    const result = await tool.callback({}, {});

    expect(talenox.get).toHaveBeenCalledWith("cost_centres");
    expect(result.content[0].text).toContain("Engineering");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/pay-items.test.ts tests/tools/cost-centres.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `src/tools/pay-items.ts`**

```typescript
// src/tools/pay-items.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult } from "./shared.js";

export function registerPayItemTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_pay_items",
    {
      description:
        "List custom pay items configured in Talenox (needed to resolve valid pay item IDs before creating payments).",
      inputSchema: {},
    },
    async (_args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get("custom_pay_items");
      return textResult(result);
    },
  );
}
```

- [ ] **Step 4: Write `src/tools/cost-centres.ts`**

```typescript
// src/tools/cost-centres.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult } from "./shared.js";

export function registerCostCentreTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_cost_centres",
    {
      description:
        "List cost centres configured in Talenox (needed to resolve valid cost centre IDs before creating payments).",
      inputSchema: {},
    },
    async (_args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get("cost_centres");
      return textResult(result);
    },
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/tools/pay-items.test.ts tests/tools/cost-centres.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/tools/pay-items.ts src/tools/cost-centres.ts tests/tools/pay-items.test.ts tests/tools/cost-centres.test.ts
git commit -m "feat(tools): add pay item and cost centre read-only lookup tools"
```

---

### Task 11: Payroll payment tools with dry-run support

**Files:**
- Create: `src/tools/payroll.ts`
- Test: `tests/tools/payroll.test.ts`

**Interfaces:**
- Consumes: `ToolContext` (Task 9).
- Produces: `registerPayrollTools(server, getContext)` registering:
  - `create_adhoc_payment`, `create_recurring_payment`, `create_attendance_payment`, `create_leave_payment` — each takes `{ payment: Record<string, unknown>, dry_run?: boolean }`. When `dry_run` is `true`, returns `{ content: [{ type: "text", text: JSON.stringify({ dry_run: true, would_send: { path, body: args.payment } }) }] }` without calling `talenox.post`.
  - `process_payroll`, `publish_payroll`, `unpublish_payroll` — each takes `{ payroll_id: string, dry_run?: boolean }`, posting to `payroll/${payroll_id}/process` etc. Same dry-run short-circuit pattern.
  - `export_payroll` — takes `{ payroll_id: string }`, GETs `payroll/${payroll_id}/export` (read-only, no dry-run needed).
  - `get_payslip` — takes `{ payslip_id: string }`, GETs `payslips/${payslip_id}`.
  - `get_payslip_pdf` — takes `{ payslip_id: string }`, GETs `payslips/${payslip_id}/pdf`.
  - Tool descriptions for `process_payroll` and `publish_payroll` explicitly state these actions are hard to reverse in Talenox and should be confirmed with the user first.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/tools/payroll.test.ts
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPayrollTools } from "../../src/tools/payroll.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";

function getTool(server: any, name: string) {
  return server._registeredTools?.[name] ?? server.tools?.[name];
}

describe("payroll tools", () => {
  it("create_adhoc_payment calls POST payroll/adhoc_payments with the given payment", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.callback(
      { payment: { employee_id: 5, amount: 100 } },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("payroll/adhoc_payments", {
      employee_id: 5,
      amount: 100,
    });
    expect(result.content[0].text).toContain("1");
  });

  it("create_adhoc_payment short-circuits on dry_run, never calling talenox.post", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn() } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.callback(
      { payment: { employee_id: 5, amount: 100 }, dry_run: true },
      {},
    );

    expect(talenox.post).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_send.body).toEqual({ employee_id: 5, amount: 100 });
  });

  it("process_payroll calls POST payroll/{id}/process", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ status: "processed" }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "process_payroll");
    await tool.callback({ payroll_id: "42" }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/42/process", {});
  });

  it("get_payslip_pdf calls GET payslips/{id}/pdf", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue({ url: "https://..." }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "get_payslip_pdf");
    await tool.callback({ payslip_id: "7" }, {});

    expect(talenox.get).toHaveBeenCalledWith("payslips/7/pdf");
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result, not an unhandled rejection", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = {
      post: vi.fn().mockRejectedValue(new TalenoxApiError(422, "invalid cost centre id")),
    } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.callback({ payment: { employee_id: 5 } }, {});

    // registerTool's default behavior wraps a thrown error into an isError
    // result rather than propagating the rejection — verify that contract
    // holds for the installed SDK version rather than assuming it.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid cost centre id");
  });
});
```

**Note for implementer:** if the installed SDK's `registerTool` does NOT automatically convert a thrown error into `{isError: true, content: [...]}` (verify by running this test against the installed version), wrap every handler body in `src/tools/*.ts` in a `try { ... } catch (err) { return { isError: true, content: [{type: "text", text: String(err instanceof Error ? err.message : err)}] } }` instead of relying on the SDK default. This is the same category of SDK-version-sensitive behavior already flagged for `McpServer`/`StreamableHTTPServerTransport` in Tasks 9/12 and the OAuth provider in Task 7/8 — confirm behavior, don't assume it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/payroll.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/tools/payroll.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult } from "./shared.js";

function dryRunResult(path: string, body: unknown) {
  return textResult({ dry_run: true, would_send: { path, body } });
}

const paymentSchema = {
  payment: z.record(z.unknown()),
  dry_run: z.boolean().optional(),
};

function registerPaymentTool(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
  name: string,
  path: string,
  description: string,
) {
  server.registerTool(
    name,
    { description, inputSchema: paymentSchema },
    async (args, extra) => {
      if (args.dry_run) {
        return dryRunResult(path, args.payment);
      }
      const { talenox } = getContext(extra);
      const result = await talenox.post(path, args.payment);
      return textResult(result);
    },
  );
}

const payrollActionSchema = {
  payroll_id: z.string(),
  dry_run: z.boolean().optional(),
};

function registerPayrollActionTool(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
  name: string,
  pathFor: (payrollId: string) => string,
  description: string,
) {
  server.registerTool(
    name,
    { description, inputSchema: payrollActionSchema },
    async (args, extra) => {
      const path = pathFor(args.payroll_id);
      if (args.dry_run) {
        return dryRunResult(path, {});
      }
      const { talenox } = getContext(extra);
      const result = await talenox.post(path, {});
      return textResult(result);
    },
  );
}

export function registerPayrollTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  registerPaymentTool(
    server,
    getContext,
    "create_adhoc_payment",
    "payroll/adhoc_payments",
    "Create a one-off (adhoc) payroll payment. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_recurring_payment",
    "payroll/recurring_payments",
    "Create a recurring payroll payment. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_attendance_payment",
    "payroll/attendance_payments",
    "Create an attendance-based payroll payment. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_leave_payment",
    "payroll/leave_payments",
    "Create a leave-based payroll payment. Supports dry_run.",
  );

  registerPayrollActionTool(
    server,
    getContext,
    "process_payroll",
    (id) => `payroll/${id}/process`,
    "Process a payroll run. This is hard to reverse in Talenox — confirm with the user before calling without dry_run.",
  );
  registerPayrollActionTool(
    server,
    getContext,
    "publish_payroll",
    (id) => `payroll/${id}/publish`,
    "Publish a payroll run, making payslips visible to employees. This is hard to reverse in Talenox — confirm with the user before calling without dry_run.",
  );
  registerPayrollActionTool(
    server,
    getContext,
    "unpublish_payroll",
    (id) => `payroll/${id}/unpublish`,
    "Unpublish a previously published payroll run. Supports dry_run.",
  );

  server.registerTool(
    "export_payroll",
    {
      description: "Export payroll data for a given payroll run.",
      inputSchema: { payroll_id: z.string() },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get(`payroll/${args.payroll_id}/export`);
      return textResult(result);
    },
  );

  server.registerTool(
    "get_payslip",
    {
      description: "Get payslip data by payslip id.",
      inputSchema: { payslip_id: z.string() },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get(`payslips/${args.payslip_id}`);
      return textResult(result);
    },
  );

  server.registerTool(
    "get_payslip_pdf",
    {
      description: "Get the payslip PDF (or a link to it) by payslip id.",
      inputSchema: { payslip_id: z.string() },
    },
    async (args, extra) => {
      const { talenox } = getContext(extra);
      const result = await talenox.get(`payslips/${args.payslip_id}/pdf`);
      return textResult(result);
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/payroll.test.ts`
Expected: PASS (5 tests) — if the error-propagation test fails because the SDK doesn't auto-wrap thrown errors, apply the try/catch fallback from the implementer note above and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/tools/payroll.ts tests/tools/payroll.test.ts
git commit -m "feat(tools): add payroll payment/process/publish/payslip tools with dry-run"
```

---

### Task 12: Tool registry and MCP transport wiring

**Files:**
- Create: `src/tools/index.ts`
- Modify: `src/mcp-server.ts`
- Test: `tests/tools/index.test.ts`
- Modify: `tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: all `register*Tools` functions from Tasks 9-11.
- Produces: `function registerAllTools(server: McpServer, getContext: (extra: unknown) => ToolContext): void` calling every register function. `createApp`'s `/mcp` handler now constructs an `McpServer`, calls `registerAllTools` with a context getter that builds a `TalenoxClient` from the bearer token `requireBearerAuth` (Task 8) attached to the request — Talenox's real access token passes through as the MCP bearer token (see Task 7's design), so it can be used directly, with no store lookup needed at request time — and connects a `StreamableHTTPServerTransport` per request per the MCP SDK's stateless-HTTP pattern, forwarding the Express request/response into `transport.handleRequest`.

- [ ] **Step 1: Write the failing test for the registry**

```typescript
// tests/tools/index.test.ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";
import type { TalenoxClient } from "../../src/talenox/client.js";

describe("registerAllTools", () => {
  it("registers every v1 tool name exactly once", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, () => ({ talenox: {} as TalenoxClient }));

    const registered =
      (server as any)._registeredTools ?? (server as any).tools ?? {};
    const names = Object.keys(registered);

    const expected = [
      "list_employees",
      "get_employee",
      "create_employee",
      "update_employee",
      "delete_employee",
      "list_pay_items",
      "list_cost_centres",
      "create_adhoc_payment",
      "create_recurring_payment",
      "create_attendance_payment",
      "create_leave_payment",
      "process_payroll",
      "publish_payroll",
      "unpublish_payroll",
      "export_payroll",
      "get_payslip",
      "get_payslip_pdf",
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(names.length).toBe(expected.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/tools/index.ts`**

```typescript
// src/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEmployeeTools, type ToolContext } from "./employees.js";
import { registerPayItemTools } from "./pay-items.js";
import { registerCostCentreTools } from "./cost-centres.js";
import { registerPayrollTools } from "./payroll.js";

export type { ToolContext };

// Wraps every tool's handler with structured invocation logging (tool name,
// dry_run flag if present, success/failure) without touching each tools file
// individually — caught as a gap during /plan-ceo-review's Section 8
// observability pass: with zero logging, a bad payroll run has no trail to
// reconstruct what Claude actually called.
function withInvocationLogging(server: McpServer): McpServer {
  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, schema: unknown, handler: Function) => {
    const wrappedHandler = async (args: any, extra: unknown) => {
      const dryRun = args && typeof args === "object" && "dry_run" in args ? args.dry_run : undefined;
      console.log(JSON.stringify({ event: "tool.invoke", tool: name, dryRun }));
      try {
        const result = await handler(args, extra);
        console.log(
          JSON.stringify({ event: "tool.result", tool: name, isError: Boolean(result?.isError) }),
        );
        return result;
      } catch (err) {
        console.log(
          JSON.stringify({
            event: "tool.error",
            tool: name,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }
    };
    return originalRegisterTool(name, schema, wrappedHandler);
  };
  return server;
}

export function registerAllTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  const loggedServer = withInvocationLogging(server);
  registerEmployeeTools(loggedServer, getContext);
  registerPayItemTools(loggedServer, getContext);
  registerCostCentreTools(loggedServer, getContext);
  registerPayrollTools(loggedServer, getContext);
}
```

**Note for implementer:** `withInvocationLogging` reassigns `server.registerTool` via a mutable cast (`as any`) because `McpServer`'s public type doesn't declare that property as writable — same SDK-internals caveat already flagged for `_registeredTools`/`tools` lookups in this task's test and Task 9's. If a future SDK version makes `registerTool` non-configurable, wrap at the `registerAllTools` call site instead (pass a thin proxy object matching `McpServer`'s public shape to each `register*Tools` function) rather than mutating the real server instance.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/index.test.ts`
Expected: PASS (1 test) — the existing test only asserts tool names are registered, which still holds since the logging wrapper is transparent to registration; it does not yet assert on log output.

- [ ] **Step 5: Wire the transport into `src/mcp-server.ts`**

```typescript
// src/mcp-server.ts (replace the /mcp handler body from Task 8)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools/index.js";
import { TalenoxClient } from "./talenox/client.js";

// ... (keep everything above the /mcp route from Task 8 unchanged, including
// the requireBearerAuth(...) middleware already applied there)

  app.post(
    "/mcp",
    requireBearerAuth({ provider: provider as any }),
    async (req, res) => {
      const server = new McpServer({ name: "talenox-mcp", version: "0.1.0" });
      // req.auth is attached by requireBearerAuth from Task 8; its .token is
      // Talenox's real access token (passed through untranslated per Task 7).
      const talenox = new TalenoxClient((req as any).auth.token);
      registerAllTools(server, () => ({ talenox }));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  return app;
}
```

**Note for implementer:** `StreamableHTTPServerTransport`'s exact constructor options and `handleRequest` signature, and the exact property `requireBearerAuth` attaches auth info to (`req.auth` assumed here), may differ slightly by installed SDK version — check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js` and `.../middleware/bearerAuth.js` and adjust this wiring to match if it doesn't compile as written. The per-request `new McpServer()` + `new StreamableHTTPServerTransport()` pattern (stateless mode) is the important structural decision to preserve: each HTTP request gets its own server/transport pair scoped to that request's authenticated Talenox access token, so one user's session can never leak into another's tool call.

- [ ] **Step 6: Update the auth tests from Task 8 to match the real tool-dispatch response**

```typescript
// tests/mcp-server.test.ts — the 401 tests and /health test from Task 8 are
// unchanged. Remove any assertion on the old { status: "authenticated" } stub
// body, since /mcp now speaks the real MCP protocol instead of returning that
// placeholder JSON.
```

Remove any test asserting the old `{ status: "authenticated", ready: true }` stub body, since `/mcp` now speaks the real MCP protocol instead of returning that placeholder JSON.

- [ ] **Step 7: Run the full test suite and the manual boot check**

Run: `npx vitest run`
Expected: all tests pass.

Run the same manual boot command from Task 8 Step 6, confirm it still starts.

- [ ] **Step 8: Commit**

```bash
git add src/tools/index.ts src/mcp-server.ts tests/tools/index.test.ts tests/mcp-server.test.ts
git commit -m "feat(server): register all v1 tools on a per-request MCP transport"
```

---

### Task 13: Render deploy config and setup docs

**Files:**
- Create: `render.yaml`
- Create: `README.md`

**Interfaces:**
- None (deploy/docs only).

- [ ] **Step 1: Write `render.yaml`**

```yaml
services:
  - type: web
    name: talenox-mcp
    plan: starter
    env: node
    region: singapore
    buildCommand: npm ci && npm run build
    startCommand: npm start
    disk:
      name: talenox-mcp-data
      mountPath: /data
      sizeGB: 1
    envVars:
      - key: PORT
        value: 3000
      - key: PUBLIC_BASE_URL
        sync: false
      - key: TALENOX_CLIENT_ID
        sync: false
      - key: TALENOX_CLIENT_SECRET
        sync: false
      - key: MCP_ENCRYPTION_KEY
        sync: false
      - key: TOKEN_STORE_PATH
        value: /data/tokens.db
```

- [ ] **Step 2: Write `README.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add render.yaml README.md
git commit -m "docs(repo): add Render deploy config and setup instructions"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Tasks 7, 8, 12, 13), Auth/persistent token store (Tasks 2, 3, 4, 5, 7), PKCE + dynamic client registration (Task 7, added during `/plan-ceo-review` after confirming claude.ai's connector requires it), Talenox client (Task 6), Tool set (Tasks 9-11), dry-run (Task 11), Error handling — Talenox errors passed through via `TalenoxApiError` (Task 6), invalid-grant/invalid-token on reconnect (Task 7/8) — all covered. Manual verification workflow is documented in Task 13's README rather than re-implemented as a task, since it's a human process, not code.
- **Type consistency:** `ToolContext` is defined once in `src/tools/employees.ts` (Task 9) and imported by every later tools file (Tasks 10-12) rather than redefined — checked for drift across tasks. `IssuedGrant` (Task 5) is the single shape threaded through the shim, provider, and `exchangeAuthorizationCode`/`exchangeRefreshToken` — checked for drift there too after the Task 7/8 rewrite.
- **No placeholders:** every step has runnable code. The "Note for implementer" callouts (Tasks 7, 8, 9, 12) are flagged explicitly because `OAuthServerProvider`/`mcpAuthRouter`/`requireBearerAuth`/`McpServer`/`StreamableHTTPServerTransport` internals are SDK-version-sensitive — not because the plan is leaving something undecided. The two literal `TODO(implementer)` comments in Task 7's `oauth-provider.ts` (mapping our generic errors to the SDK's exact invalid-grant/invalid-token error types) are the one spot where exact behavior depends on reading the installed SDK source first; the fallback behavior (throwing a plain `Error`) is still correct enough to fail closed (any error from these hooks results in the SDK rejecting the request), so this isn't a functional gap, just an unpolished error type.
- **Post-review architecture change:** the original Tasks 3/5/7/8 (hand-rolled Express OAuth routes, session-id-keyed token store, proactive per-tool-call refresh) were replaced during `/plan-ceo-review`'s Step 0B/0C-bis after confirming (a) claude.ai's connector OAuth requires PKCE + dynamic client registration, which the hand-rolled routes didn't implement, and (b) Talenox's refresh grant is nonstandard (`code=<access_token>` param), which a transparent SDK proxy can't express. The revised design uses the SDK's `mcpAuthRouter` for spec compliance plus a custom `OAuthServerProvider` (Task 7) that mints its own opaque refresh token per grant and translates refresh calls into Talenox's actual shape. Tasks 1, 2, 4, 6, 9-13 were unaffected.

## NOT in Scope

- **Leave management** (Leave, Leave Applications, Leave Approval Structure, Leave Approvers, Leave Off-in-Lieus, Leave Types, Leave Application/Attachments Flow) — this is the Lark ↔ Talenox leave-sync bridge from the original ask; deliberately deferred to a future phase, decided during brainstorming.
- **Branches, Company Settings, Employee Roles, Holiday Policies, Jobs, Next of Kins, Working Days, Working Hours, Metadata, User Info (OAuth)** — one-time setup/config resources or employee-record details not touched by the stated payroll workflow; add only if a real gap surfaces during testing.
- **Multi-region/multi-instance deployment, horizontal scaling** — single Render instance is correct for a single-user personal tool; revisit only if usage pattern changes materially.
- **Durable dynamic-client-registration / pending-authorization storage across restarts** — both are in-memory by design (Task 7); acceptable because re-authentication is cheap and this isn't a high-availability multi-tenant service.
- **Automated integration tests against the real Talenox API** — no sandbox environment is documented; testing strategy is unit tests + a manual verification checklist (Task 13) against the real account instead.

## What Already Exists

- **`xero-mcp-server`** (github.com/Zechst/xero-mcp-server) — supplied the tool-organization pattern (per-resource files, `register*Tools` functions) used in Tasks 9-11. Does not supply any remote/OAuth serving code (stdio-only), so nothing there was reused for Tasks 5-8.
- **`lark-mcp-oauth`** (github.com/Zechst/lark-mcp-oauth) — supplied the "remote per-user OAuth deployment" pattern (encrypted token storage via env-var key, `PUBLIC_BASE_URL`-aware issuer, Render deploy shape) that Task 13's deploy config and Task 2/3's crypto/storage design are modeled on. Its Docker setup was explicitly NOT reused (see Architecture section) since it exists only to work around `keytar`'s OS-keychain dependency, which this project doesn't have.
- **`@modelcontextprotocol/sdk`'s `mcpAuthRouter`/`OAuthServerProvider`** — discovered during this review's Landscape Check; supplies PKCE and dynamic client registration compliance for free, avoiding a from-scratch reimplementation that the original Task 7 draft would have required.

## Dream State Delta

```
CURRENT STATE                    THIS PLAN                         12-MONTH IDEAL
No Talenox automation --->  Remote MCP connector for  --->   Same connector, plus the
at all, manual payroll      payroll (employees, pay-         Lark <-> Talenox leave-sync
processing via the          ments, process/publish,          bridge (explicitly deferred),
Talenox web UI only.        payslips), open-sourced,          possibly extended to other
                             usable from claude.ai or          Talenox resources if a real
                             Claude Code with dry-run           gap shows up in practice.
                             safety on every write.
```

This plan moves directly toward the 12-month ideal — it's the payroll-automation foundation the leave-sync bridge would sit on top of later, not a detour from it.

## Error & Rescue Registry

| Method/Codepath | What Can Go Wrong | Exception Class | Rescued? | Rescue Action | User Sees |
|---|---|---|---|---|---|
| `TalenoxClient#request` | Talenox returns 4xx/5xx | `TalenoxApiError` | Y | Message passed through as-is | Original Talenox error text (e.g. "invalid cost centre id") |
| `TalenoxClient#request` | Network failure (DNS, timeout, connection reset) | Native `fetch` rejection (e.g. `TypeError`) | Y (as of this review's fix) | Propagates to the tool handler, which the SDK's `registerTool` wrapper converts to `isError: true` — verified by Task 11's added test | Generic network error message |
| `TalenoxGrantShim#refresh` | Unknown/expired opaque refresh token | `GrantNotFoundError` | Y | Mapped to `invalid_grant` in the OAuth provider | Client-side "reconnect" flow (standard OAuth invalid_grant handling) |
| OAuth provider `verifyAccessToken` | Unknown/expired access token | Generic `Error("invalid_token")` | Y | Rejects the `/mcp` request with 401 | Client-side "reconnect" flow |
| `TokenStore` (any method) | `MCP_ENCRYPTION_KEY` missing/malformed | `Error` (from `crypto.ts`'s `getKey()`) | Y (as of this review's fix) | Validated at boot in `src/index.ts`, process exits immediately with a clear message | Deploy fails loudly at startup, not mid-request |
| `oauth-provider.ts` exchange/refresh/verify hooks | Any of the above during an in-flight OAuth exchange | Various | Y | Logged via `console.log` structured events (this review's fix) | Standard OAuth error response to the client |

## Failure Modes Registry

| Codepath | Failure Mode | Rescued? | Test? | User Sees | Logged? |
|---|---|---|---|---|---|
| `TalenoxClient#request` | Talenox 4xx/5xx | Y | Y (Task 6) | Original error text | N (not yet — acceptable at personal-project scale; add if needed) |
| Tool handler (any) | `TalenoxClient` call throws | Y | Y (Task 11, added this review) | MCP `isError` result | Y (Task 12's logging wrapper, added this review) |
| `PendingAuthorizations` | Abandoned `/authorize` never completed | Y | Y (Task 7, added this review) | N/A (no user-visible effect) | N (sweep is silent by design — low-severity path) |
| `TalenoxGrantShim#refresh` | Stale/invalid refresh token | Y | Y (Task 5) | Standard OAuth reconnect flow | Y (Task 7's logging, added this review) |
| `oauth-provider` PKCE challenge mismatch | Client sends wrong `code_verifier` | Handled by the SDK's `mcpAuthRouter`, not this plan's code | N (relies on SDK's own tests) | Standard OAuth PKCE failure | Depends on SDK |

No row has all three of RESCUED=N, TEST=N, and USER SEES=Silent — no CRITICAL GAPs found.

## TODOS.md Candidates (not blocking — proposed for later, not built now)

- **Structured metrics/alerting beyond console logs** (P3) — if this ever needs to run unattended for a while, plain `console.log` lines are enough to debug after the fact manually, but a real metrics/alerting layer would be needed for unattended reliability. Deferred: personal-scale usage doesn't need it yet.
- **Automated smoke test against a disposable Talenox sandbox, if Talenox ever offers one** (P3) — would remove the "manual dashboard verification" dependency for regression-testing writes. Deferred: no sandbox is documented today, so there's nothing to automate against.
- **Durable dynamic-client-registration storage** (P3) — currently in-memory (Task 7); losing it on restart just means claude.ai re-registers automatically, so this is low priority. Deferred: not worth the SQLite schema addition until it's actually annoying in practice.

## Outside Voice — Independent Plan Challenge

Not run this session — Codex CLI availability wasn't probed in this environment. Given the plan already went through one architecture correction (Approach C's SDK-based OAuth redesign) driven by concrete platform-requirement research rather than speculation, and given this is a personal-scope project rather than a team/production system, I'd recommend running `/codex review` manually against this plan file if you want a second independent opinion before implementation — but it isn't required to proceed.

## Diagrams

```
System architecture (new components, HOLD SCOPE — showing the post-review design):

  claude.ai / Claude Code
        │  HTTPS
        ▼
  ┌─────────────────────────── talenox-mcp (Render, single instance) ───────────────────────────┐
  │                                                                                                │
  │   GET /health           GET /.well-known/oauth-authorization-server   POST /mcp               │
  │        │                          │  (mcpAuthRouter)                     │                    │
  │        │                          ▼                                requireBearerAuth          │
  │        │                  OAuthServerProvider (Task 7)                   │                    │
  │        │                  ┌──────────────────────┐                      ▼                    │
  │        │                  │ authorize()──────────┼──▶ Talenox /oauth/authorize (real)         │
  │        │                  │ callbackHandler ◀─────┼──── Talenox redirects back                │
  │        │                  │ exchangeAuthCode()    │                                            │
  │        │                  │ exchangeRefreshToken()├──▶ TalenoxGrantShim (Task 5)               │
  │        │                  │ verifyAccessToken()   │        │                                  │
  │        │                  └──────────────────────┘        ▼                                  │
  │        │                                            TokenStore (Task 3, SQLite on disk)        │
  │        │                                                   │                                  │
  │        ▼                                                   ▼                                  │
  │   { status: "ok" }                                 exchangeCodeForTokens / refreshTokens        │
  │                                                     (Task 4) ──▶ Talenox /oauth/token (real)   │
  │                                                                                                │
  │   McpServer + StreamableHTTPServerTransport (Task 8/12, per-request)                            │
  │        │                                                                                        │
  │        ▼                                                                                        │
  │   registerAllTools ──▶ employees.ts / pay-items.ts / cost-centres.ts / payroll.ts (Tasks 9-11)  │
  │        │                                                                                        │
  │        ▼                                                                                        │
  │   TalenoxClient (Task 6) ──▶ Talenox REST API v2 (real)                                          │
  └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

```
Data flow — OAuth token exchange (happy + shadow paths):

  authorize() ──▶ handoff stored ──▶ Talenox authorize ──▶ callback ──▶ shim.exchange ──▶ grant stored
       │                                                        │              │
       ▼                                                        ▼              ▼
  [nil params?]                                          [nil/expired      [Talenox 4xx/5xx?]
  SDK validates                                            handoff?]        propagates as
  before calling us                                        400 response     TalenoxApiError
                                                                             (Task 6, rescued)
```

```
State machine — a single grant's lifecycle (Task 3/5):

  (none) ──createGrant──▶ [ACTIVE, keyed by grantId=A]
                                │
                                │ client calls refresh(A)
                                ▼
                    rotateGrant(A → B) [atomic: delete A, insert B]
                                │
                                ▼
                          [ACTIVE, keyed by grantId=B]
                                │
                                │ client calls refresh(B) again...
                                ▼
                              (repeats)

  Invalid transition prevented: refresh(A) after A has already been rotated to B
  finds no row for A (deleted atomically) → GrantNotFoundError → invalid_grant,
  never a partial/corrupt state with both A and B alive or neither.
```

```
Error flow (tool call):

  Claude calls tool ──▶ handler runs ──▶ TalenoxClient call
                              │                  │
                              │            success│failure
                              │                  │    │
                              ▼                  ▼    ▼
                        console.log         result  TalenoxApiError thrown
                        "tool.invoke"          │           │
                                               ▼           ▼
                                        console.log   console.log "tool.error"
                                        "tool.result"       │
                                                            ▼
                                                   SDK wraps as isError:true
                                                   (verified by Task 11's test)
```

```
Deployment sequence (Task 13):

  git push ──▶ Render Blueprint build (npm ci && npm run build)
                        │
                        ▼
             Start (npm start) with env vars set
                        │
                        ▼
       Boot-time validation (this review's fix): PUBLIC_BASE_URL,
       TALENOX_CLIENT_ID/SECRET, MCP_ENCRYPTION_KEY all checked —
       fails loudly here, not mid-request, if misconfigured
                        │
                        ▼
              Manual validation checklist (Task 13 README):
              read-only tool → dry_run write → real small write
              → dashboard check → process/publish on smallest cycle
```

```
Rollback flowchart:

  Bad deploy detected ──▶ git revert the offending commit ──▶ push ──▶ Render redeploys
                                                                            │
                                                                            ▼
                                                          Grant data is session-transient —
                                                          no destructive migration to undo,
                                                          users just reconnect if needed
```

## Stale Diagram Audit

No pre-existing diagrams in this repo (fresh project) — nothing to audit for staleness.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P2, human: ~10min / CC: ~2min)** — auth — validate `MCP_ENCRYPTION_KEY` format at boot
  - Surfaced by: Section 2 (Error & Rescue Map) — missing startup validation gap
  - Files: `src/index.ts`
  - Verify: boot with a missing/malformed key, confirm it throws immediately with a clear message (already written into Task 8)
- [ ] **T2 (P1, human: ~20min / CC: ~5min)** — tools — verify/enforce error-to-isError conversion in tool handlers
  - Surfaced by: Section 2/6 (Error Map, Test Review) — unverified SDK error-propagation contract
  - Files: `src/tools/payroll.ts`, `tests/tools/payroll.test.ts` (already written into Task 11)
  - Verify: `npx vitest run tests/tools/payroll.test.ts` — if it fails, apply the try/catch fallback noted in Task 11
- [ ] **T3 (P3, human: ~10min / CC: ~2min)** — tools — deduplicate `textResult` into a shared module
  - Surfaced by: Section 5 (Code Quality) — 4x duplicated helper
  - Files: `src/tools/shared.ts`, `src/tools/employees.ts`, `src/tools/pay-items.ts`, `src/tools/cost-centres.ts`, `src/tools/payroll.ts` (already written into Task 9)
  - Verify: all tool test files still pass after the import change
- [ ] **T4 (P2, human: ~20min / CC: ~5min)** — observability — add structured invocation logging + pending-authorization sweep
  - Surfaced by: Section 8 (Observability), Section 3 (Security — unbounded memory growth)
  - Files: `src/tools/index.ts`, `src/auth/oauth-provider.ts`, `src/auth/pending-authorizations.ts` (already written into Tasks 7/12)
  - Verify: `npx vitest run tests/auth/pending-authorizations.test.ts` (sweep test), manual check of `console.log` output during a local test run

_No new tasks from Sections 1, 4, 7, 9, 10, 11 — no unaddressed findings there._

## Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | HOLD SCOPE (no response to mode question,   |
|                       | proceeded with recommended default)         |
| System Audit         | Fresh repo, 3 commits pre-review, no TODOs, |
|                       | no prior review cycles                      |
| Step 0               | Approach C (SDK auth + refresh shim) chosen |
|                       | after landscape check found PKCE/dynamic-   |
|                       | client-registration requirement             |
| Section 1  (Arch)    | 0 blocking issues (see finding 4, resolved) |
| Section 2  (Errors)  | 6 codepaths mapped, 2 GAPS found & fixed    |
| Section 3  (Security)| 1 issue found & fixed (unbounded memory)    |
| Section 4  (Data/UX) | 0 unhandled edge cases (loose zod noted,    |
|                       | not blocking)                               |
| Section 5  (Quality) | 1 DRY violation found & fixed                |
| Section 6  (Tests)   | Diagram produced, 1 gap found & fixed        |
| Section 7  (Perf)    | 0 issues (documented tradeoff, not a gap)    |
| Section 8  (Observ)  | 1 gap found & fixed (zero logging)           |
| Section 9  (Deploy)  | 0 risks flagged beyond what Task 13 covers   |
| Section 10 (Future)  | Reversibility: 4/5, debt items: 3 (all P3)   |
| Section 11 (Design)  | SKIPPED (no UI scope)                        |
+--------------------------------------------------------------------+
| NOT in scope         | written (5 items)                            |
| What already exists  | written (3 items)                            |
| Dream state delta    | written                                       |
| Error/rescue registry| 6 methods, 0 CRITICAL GAPS                   |
| Failure modes        | 5 total, 0 CRITICAL GAPS                     |
| TODOS.md updates     | 3 items proposed (not built, all P3)         |
| Scope proposals      | N/A (HOLD SCOPE — no expansions surfaced)    |
| CEO plan             | skipped (HOLD SCOPE)                         |
| Outside voice        | skipped (not probed this session)            |
| Diagrams produced    | 6 (architecture, data flow, state machine,   |
|                       | error flow, deployment sequence, rollback)   |
| Stale diagrams found | 0 (fresh project)                            |
| Unresolved decisions | 1 (mode selection defaulted, see below)      |
+====================================================================+
```

## Unresolved Decisions

- The Step 0F mode-selection question (HOLD SCOPE / SELECTIVE EXPANSION / SCOPE EXPANSION) went unanswered after 60s; proceeded with the recommended HOLD SCOPE default per the user's prior explicit scope-locking behavior earlier in this conversation. If SELECTIVE EXPANSION or SCOPE EXPANSION was actually intended, re-run this review section with that mode selected.
- The four Section 2/3/5/8 findings (boot validation, error-propagation test, DRY textResult, logging + sweep) were also auto-applied after a 60s AskUserQuestion timeout, using the recommended option for each. All four are additive, non-destructive changes to the plan document only (no code has been written yet) — review the diff in `docs/superpowers/plans/2026-07-03-talenox-mcp-implementation.md` and flag anything you'd rather revert before implementation begins.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_open | 4 findings, 4 fixed; 1 unresolved (mode selection defaulted) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | N/A (no UI scope) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**VERDICT:** CEO review complete with all findings resolved in-plan; eng review required before implementation (Eng Review not yet run — this is a personal-scope project, so running `/plan-eng-review` is optional but recommended before starting Task 1, given the OAuth architecture is genuinely nontrivial).

**UNRESOLVED DECISIONS:**
- Mode selection (HOLD SCOPE vs SELECTIVE/SCOPE EXPANSION) defaulted after a 60s timeout — confirm HOLD SCOPE was the right call, or re-run with a different mode.
