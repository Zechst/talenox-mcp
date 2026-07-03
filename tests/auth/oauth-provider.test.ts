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

  it("rejects replaying an already-consumed authorization code (added during /plan-eng-review)", async () => {
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
    await callbackHandler(
      { query: { code: "talenox-auth-code", state: handoffState } } as any,
      { redirect: (url: string) => (finalRedirectUrl = url) } as any,
      () => {},
    );
    const mcpAuthCode = new URL(finalRedirectUrl).searchParams.get("code")!;

    // First exchange succeeds and consumes the code (single-use, per PendingAuthorizations)
    await provider.exchangeAuthorizationCode({ client_id: "mcp-client-1" } as any, mcpAuthCode);

    // Replaying the same code must fail — this is what actually prevents an
    // intercepted authorization code from being redeemed twice.
    await expect(
      provider.exchangeAuthorizationCode({ client_id: "mcp-client-1" } as any, mcpAuthCode),
    ).rejects.toThrow();
  });
});
