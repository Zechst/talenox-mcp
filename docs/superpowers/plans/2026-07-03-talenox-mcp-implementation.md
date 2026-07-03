# Talenox MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a remote, HTTP-based MCP server that lets Claude drive Talenox payroll processing (employees, payments, process/publish, payslips), deployable to Render, with per-user OAuth against Talenox and a persistent encrypted token store.

**Architecture:** Express HTTP server hosting both a hand-rolled OAuth authorization server (proxying to Talenox's OAuth, minting our own session tokens, storing Talenox tokens server-side in encrypted SQLite) and the MCP endpoint (`@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`). Tool handlers call a thin Talenox REST client using the current session's stored (and proactively refreshed) Talenox access token.

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

### Task 3: Persistent token store

**Files:**
- Create: `src/auth/token-store.ts`
- Test: `tests/auth/token-store.test.ts`

**Interfaces:**
- Consumes: `encrypt`, `decrypt` from `src/auth/crypto.ts` (Task 2).
- Produces:
  - `type StoredTokens = { accessToken: string; refreshToken: string; expiresAt: number }`
  - `class TokenStore { constructor(dbPath: string); saveTokens(sessionId: string, tokens: StoredTokens): void; getTokens(sessionId: string): StoredTokens | null; deleteTokens(sessionId: string): void; close(): void }`
  - `saveTokens` is used both for initial save and for refresh-rotation (same method, upsert semantics, single atomic write).

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

  it("returns null for an unknown session", () => {
    expect(store.getTokens("nope")).toBeNull();
  });

  it("saves and retrieves tokens for a session", () => {
    const tokens = { accessToken: "a1", refreshToken: "r1", expiresAt: 12345 };
    store.saveTokens("session-1", tokens);
    expect(store.getTokens("session-1")).toEqual(tokens);
  });

  it("overwrites the refresh token on rotation (upsert)", () => {
    store.saveTokens("session-1", {
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 100,
    });
    store.saveTokens("session-1", {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 200,
    });
    expect(store.getTokens("session-1")).toEqual({
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 200,
    });
  });

  it("deletes tokens for a session", () => {
    store.saveTokens("session-1", {
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: 100,
    });
    store.deleteTokens("session-1");
    expect(store.getTokens("session-1")).toBeNull();
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

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export class TokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        session_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  saveTokens(sessionId: string, tokens: StoredTokens): void {
    const upsert = this.db.prepare(`
      INSERT INTO tokens (session_id, access_token, refresh_token, expires_at)
      VALUES (@sessionId, @accessToken, @refreshToken, @expiresAt)
      ON CONFLICT(session_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at
    `);
    upsert.run({
      sessionId,
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    });
  }

  getTokens(sessionId: string): StoredTokens | null {
    const row = this.db
      .prepare(
        `SELECT access_token, refresh_token, expires_at FROM tokens WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { access_token: string; refresh_token: string; expires_at: number }
      | undefined;
    if (!row) return null;
    return {
      accessToken: decrypt(row.access_token),
      refreshToken: decrypt(row.refresh_token),
      expiresAt: row.expires_at,
    };
  }

  deleteTokens(sessionId: string): void {
    this.db.prepare(`DELETE FROM tokens WHERE session_id = ?`).run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/token-store.test.ts`
Expected: PASS (4 tests)

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

### Task 5: Session manager (proactive refresh wrapper)

**Files:**
- Create: `src/auth/session-manager.ts`
- Test: `tests/auth/session-manager.test.ts`

**Interfaces:**
- Consumes: `TokenStore` (Task 3), `refreshTokens` (Task 4).
- Produces:
  - `class SessionManager { constructor(store: TokenStore, oauthConfig: { clientId: string; clientSecret: string; redirectUri: string }); getValidAccessToken(sessionId: string): Promise<string> }`
  - `getValidAccessToken` throws `SessionNotFoundError` (exported) if no tokens exist for the session — this is what the MCP layer maps to "reconnect the connector" in Task 8.
  - Refreshes automatically when `expiresAt` is within 5 minutes (300_000ms) of now, using the injected `now()` for testability (default `Date.now`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/session-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/auth/token-store.js";
import {
  SessionManager,
  SessionNotFoundError,
} from "../../src/auth/session-manager.js";
import * as talenoxOAuth from "../../src/auth/talenox-oauth-client.js";

describe("SessionManager", () => {
  let dir: string;
  let store: TokenStore;
  let manager: SessionManager;

  beforeEach(() => {
    process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
    dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
    store = new TokenStore(join(dir, "tokens.db"));
    manager = new SessionManager(store, {
      clientId: "client-123",
      clientSecret: "secret-abc",
      redirectUri: "https://example.com/callback",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws SessionNotFoundError for an unknown session", async () => {
    await expect(manager.getValidAccessToken("nope")).rejects.toThrow(
      SessionNotFoundError,
    );
  });

  it("returns the stored access token when not near expiry", async () => {
    store.saveTokens("session-1", {
      accessToken: "acc-fresh",
      refreshToken: "ref-1",
      expiresAt: Date.now() + 20 * 60 * 1000,
    });
    const token = await manager.getValidAccessToken("session-1");
    expect(token).toBe("acc-fresh");
  });

  it("proactively refreshes when within 5 minutes of expiry, storing the new refresh_token", async () => {
    store.saveTokens("session-1", {
      accessToken: "acc-old",
      refreshToken: "ref-old",
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
    vi.spyOn(talenoxOAuth, "refreshTokens").mockResolvedValue({
      access_token: "acc-new",
      refresh_token: "ref-new",
      expires_in: 1800,
    });

    const token = await manager.getValidAccessToken("session-1");

    expect(token).toBe("acc-new");
    const stored = store.getTokens("session-1");
    expect(stored?.accessToken).toBe("acc-new");
    expect(stored?.refreshToken).toBe("ref-new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/session-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/session-manager.ts
import type { TokenStore } from "./token-store.js";
import { refreshTokens } from "./talenox-oauth-client.js";

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No stored tokens for session ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class SessionManager {
  constructor(
    private store: TokenStore,
    private oauthConfig: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
  ) {}

  async getValidAccessToken(sessionId: string): Promise<string> {
    const tokens = this.store.getTokens(sessionId);
    if (!tokens) {
      throw new SessionNotFoundError(sessionId);
    }

    if (tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return tokens.accessToken;
    }

    const refreshed = await refreshTokens({
      clientId: this.oauthConfig.clientId,
      clientSecret: this.oauthConfig.clientSecret,
      redirectUri: this.oauthConfig.redirectUri,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
    });

    this.store.saveTokens(sessionId, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    });

    return refreshed.access_token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/session-manager.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/session-manager.ts tests/auth/session-manager.test.ts
git commit -m "feat(auth): add SessionManager with proactive token refresh"
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

### Task 7: OAuth authorization server routes (Express)

**Files:**
- Create: `src/auth/oauth-routes.ts`
- Test: `tests/auth/oauth-routes.test.ts`

**Interfaces:**
- Consumes: `TokenStore` (Task 3), `buildAuthorizeUrl`/`exchangeCodeForTokens` (Task 4).
- Produces: `function createOAuthRouter(config: { publicBaseUrl: string; talenoxClientId: string; talenoxClientSecret: string; scope: string; store: TokenStore }): express.Router` mounting:
  - `GET /.well-known/oauth-authorization-server` — returns `{ issuer: publicBaseUrl, authorization_endpoint: \`${publicBaseUrl}/authorize\`, token_endpoint: \`${publicBaseUrl}/token\` }`
  - `GET /authorize` — generates a random session id, stashes it in the OAuth `state` param (prefixed, e.g. `state=<clientState>::<sessionId>`), redirects to Talenox's authorize URL via `buildAuthorizeUrl`.
  - `GET /callback` — reads `code` and `state` from Talenox's redirect, splits the session id back out of `state`, exchanges the code via `exchangeCodeForTokens`, saves tokens in the store under that session id, then returns a minted MCP session token (for v1: the session id itself, returned as `{ session_token: sessionId }` in the response body — the MCP layer in Task 8 treats this as the bearer token clients must send).
  - `GET /health` — unauthenticated, returns `{ status: "ok" }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/oauth-routes.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/auth/token-store.js";
import { createOAuthRouter } from "../../src/auth/oauth-routes.js";
import * as talenoxOAuth from "../../src/auth/talenox-oauth-client.js";

describe("OAuth routes", () => {
  let dir: string;
  let store: TokenStore;
  let app: express.Express;

  beforeEach(() => {
    process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
    dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
    store = new TokenStore(join(dir, "tokens.db"));
    app = express();
    app.use(
      createOAuthRouter({
        publicBaseUrl: "https://example.onrender.com",
        talenoxClientId: "client-123",
        talenoxClientSecret: "secret-abc",
        scope: "payroll",
        store,
      }),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("serves OAuth metadata with the public base URL as issuer", async () => {
    const res = await request(app).get(
      "/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe("https://example.onrender.com");
    expect(res.body.authorization_endpoint).toBe(
      "https://example.onrender.com/authorize",
    );
  });

  it("redirects /authorize to Talenox with a session-tagged state", async () => {
    const res = await request(app).get("/authorize?state=client-state-1");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(
      "https://app.talenox.com/oauth/authorize",
    );
    expect(location.searchParams.get("state")).toContain("client-state-1::");
  });

  it("exchanges the code on /callback and stores tokens", async () => {
    vi.spyOn(talenoxOAuth, "exchangeCodeForTokens").mockResolvedValue({
      access_token: "acc-1",
      refresh_token: "ref-1",
      expires_in: 1800,
    });

    const authRes = await request(app).get("/authorize?state=client-state-1");
    const state = new URL(authRes.headers.location).searchParams.get(
      "state",
    )!;
    const sessionId = state.split("::")[1];

    const callbackRes = await request(app)
      .get("/callback")
      .query({ code: "auth-code-xyz", state });

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body.session_token).toBe(sessionId);
    expect(store.getTokens(sessionId)).toEqual({
      accessToken: "acc-1",
      refreshToken: "ref-1",
      expiresAt: expect.any(Number),
    });
  });

  it("serves an unauthenticated health check", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Install test-only dependency and run test to verify it fails**

Run: `npm install --save-dev supertest @types/supertest && npx vitest run tests/auth/oauth-routes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/auth/oauth-routes.ts
import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { TokenStore } from "./token-store.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from "./talenox-oauth-client.js";

export function createOAuthRouter(config: {
  publicBaseUrl: string;
  talenoxClientId: string;
  talenoxClientSecret: string;
  scope: string;
  store: TokenStore;
}): Router {
  const router = Router();
  const redirectUri = `${config.publicBaseUrl}/callback`;

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/authorize`,
      token_endpoint: `${config.publicBaseUrl}/token`,
    });
  });

  router.get("/authorize", (req, res) => {
    const clientState = String(req.query.state ?? "");
    const sessionId = randomUUID();
    const combinedState = `${clientState}::${sessionId}`;

    const url = buildAuthorizeUrl({
      clientId: config.talenoxClientId,
      redirectUri,
      scope: config.scope,
      state: combinedState,
    });

    res.redirect(url);
  });

  router.get("/callback", async (req, res) => {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const sessionId = state.split("::")[1];

    if (!code || !sessionId) {
      res.status(400).json({ error: "missing code or state" });
      return;
    }

    const tokens = await exchangeCodeForTokens({
      clientId: config.talenoxClientId,
      clientSecret: config.talenoxClientSecret,
      redirectUri,
      code,
    });

    config.store.saveTokens(sessionId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    res.json({ session_token: sessionId });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/oauth-routes.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-routes.ts tests/auth/oauth-routes.test.ts package.json package-lock.json
git commit -m "feat(auth): add OAuth authorization server routes"
```

---

### Task 8: MCP server bootstrap and app wiring

**Files:**
- Create: `src/mcp-server.ts`
- Modify: `src/index.ts`
- Test: `tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: `createOAuthRouter` (Task 7), `SessionManager`/`SessionNotFoundError` (Task 5), `TokenStore` (Task 3).
- Produces: `function createApp(config: { publicBaseUrl: string; talenoxClientId: string; talenoxClientSecret: string; scope: string; store: TokenStore }): express.Express` — mounts the OAuth router and a `POST /mcp` endpoint. The `/mcp` endpoint reads `Authorization: Bearer <sessionId>`, resolves a `TalenoxClient` for the request via `SessionManager.getValidAccessToken`, attaches it to `req.talenoxClient`, and returns `401 { error: "reconnect" }` if `SessionNotFoundError` is thrown. Actual MCP request handling (tool dispatch) is wired in Task 12 once tools exist — this task stubs the MCP transport with no tools registered yet, so the plumbing is provably correct before tools are layered on.

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

  it("returns 401 with a reconnect error for an unknown session on /mcp", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer unknown-session")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "reconnect" });
  });

  it("still serves /health from the mounted OAuth router", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/mcp-server.ts`**

```typescript
// src/mcp-server.ts
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createOAuthRouter } from "./auth/oauth-routes.js";
import { SessionManager, SessionNotFoundError } from "./auth/session-manager.js";
import type { TokenStore } from "./auth/token-store.js";
import { TalenoxClient } from "./talenox/client.js";

export type AppConfig = {
  publicBaseUrl: string;
  talenoxClientId: string;
  talenoxClientSecret: string;
  scope: string;
  store: TokenStore;
};

declare module "express-serve-static-core" {
  interface Request {
    talenoxClient?: TalenoxClient;
  }
}

export function createApp(config: AppConfig): Express {
  const app = express();
  app.use(express.json());

  app.use(
    createOAuthRouter({
      publicBaseUrl: config.publicBaseUrl,
      talenoxClientId: config.talenoxClientId,
      talenoxClientSecret: config.talenoxClientSecret,
      scope: config.scope,
      store: config.store,
    }),
  );

  const sessionManager = new SessionManager(config.store, {
    clientId: config.talenoxClientId,
    clientSecret: config.talenoxClientSecret,
    redirectUri: `${config.publicBaseUrl}/callback`,
  });

  async function attachTalenoxClient(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const authHeader = req.header("authorization") ?? "";
    const sessionId = authHeader.replace(/^Bearer\s+/i, "");

    try {
      const accessToken = await sessionManager.getValidAccessToken(sessionId);
      req.talenoxClient = new TalenoxClient(accessToken);
      next();
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        res.status(401).json({ error: "reconnect" });
        return;
      }
      next(err);
    }
  }

  app.post("/mcp", attachTalenoxClient, (req, res) => {
    // Tool dispatch is wired in Task 12 once the MCP transport and tool
    // registry exist. For now, a resolved req.talenoxClient proves auth works.
    res.json({ status: "authenticated", ready: Boolean(req.talenoxClient) });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: PASS (2 tests)

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

if (!publicBaseUrl || !talenoxClientId || !talenoxClientSecret) {
  throw new Error(
    "PUBLIC_BASE_URL, TALENOX_CLIENT_ID, and TALENOX_CLIENT_SECRET must be set",
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
git add src/mcp-server.ts src/index.ts tests/mcp-server.test.ts
git commit -m "feat(server): wire OAuth routes and authenticated /mcp endpoint"
```

---

### Task 9: Employees tools

**Files:**
- Create: `src/tools/employees.ts`
- Test: `tests/tools/employees.test.ts`

**Interfaces:**
- Consumes: `TalenoxClient` (Task 6).
- Produces: `type ToolContext = { talenox: TalenoxClient }` (this is the canonical shape reused by every tools file from here on) and `function registerEmployeeTools(server: McpServer, getContext: (extra: unknown) => ToolContext): void`, registering `list_employees`, `get_employee`, `create_employee`, `update_employee`, `delete_employee` via `server.registerTool`.
- Each handler calls `TalenoxClient` methods directly and returns MCP `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

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

export type ToolContext = { talenox: TalenoxClient };

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

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

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

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

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/payroll.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/tools/payroll.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

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
Expected: PASS (4 tests)

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
- Produces: `function registerAllTools(server: McpServer, getContext: (extra: unknown) => ToolContext): void` calling every register function. `createApp`'s `/mcp` handler now constructs an `McpServer`, calls `registerAllTools` with a context getter that returns `{ talenox: req.talenoxClient! }`, and connects a `StreamableHTTPServerTransport` per request per the MCP SDK's stateless-HTTP pattern, forwarding the Express request/response into `transport.handleRequest`.

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

export function registerAllTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  registerEmployeeTools(server, getContext);
  registerPayItemTools(server, getContext);
  registerCostCentreTools(server, getContext);
  registerPayrollTools(server, getContext);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/index.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Wire the transport into `src/mcp-server.ts`**

```typescript
// src/mcp-server.ts (replace the /mcp handler body from Task 8)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools/index.js";

// ... (keep everything above attachTalenoxClient from Task 8 unchanged)

  app.post("/mcp", attachTalenoxClient, async (req, res) => {
    const server = new McpServer({ name: "talenox-mcp", version: "0.1.0" });
    registerAllTools(server, () => ({ talenox: req.talenoxClient! }));

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
```

**Note for implementer:** `StreamableHTTPServerTransport`'s exact constructor options and `handleRequest` signature may differ slightly by installed SDK version — check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js` and adjust this wiring to match if it doesn't compile as written. The per-request `new McpServer()` + `new StreamableHTTPServerTransport()` pattern (stateless mode) is the important structural decision to preserve: each HTTP request gets its own server/transport pair scoped to that request's authenticated `TalenoxClient`, so one user's session can never leak into another's tool call.

- [ ] **Step 6: Update the auth test from Task 8 to match the new response shape**

```typescript
// tests/mcp-server.test.ts — replace the "authenticated" assertion
// (the 401/reconnect test and /health test are unchanged)
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

- **Spec coverage:** Architecture (Task 8, 12, 13), Auth/persistent token store (Tasks 2-5, 7), Talenox client (Task 6), Tool set (Tasks 9-11), dry-run (Task 11), Error handling — Talenox errors passed through via `TalenoxApiError` (Task 6), reconnect-on-session-loss (Task 8) — all covered. Manual verification workflow is documented in Task 13's README rather than re-implemented as a task, since it's a human process, not code.
- **Type consistency:** `ToolContext` is defined once in `src/tools/employees.ts` (Task 9) and imported by every later tools file (Tasks 10-12) rather than redefined — checked for drift across tasks.
- **No placeholders:** every step has runnable code; the two "Note for implementer" callouts (Tasks 9 and 12) are flagged explicitly because `McpServer`/`StreamableHTTPServerTransport` internals are SDK-version-sensitive, not because the plan is leaving something undecided — the structural decision (per-request server/transport, `registerTool` contract) is fully specified either way.
