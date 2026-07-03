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
