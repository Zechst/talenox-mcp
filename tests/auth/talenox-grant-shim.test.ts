import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenStore } from "../../src/auth/token-store.js";
import {
  TalenoxGrantShim,
  GrantNotFoundError,
} from "../../src/auth/talenox-grant-shim.js";
import * as talenoxOAuth from "../../src/auth/talenox-oauth-client.js";
import { setupTokenStore, teardownTokenStore } from "./test-utils.js";

describe("TalenoxGrantShim", () => {
  let dir: string;
  let store: TokenStore;
  let shim: TalenoxGrantShim;
  let idCounter: number;

  beforeEach(() => {
    ({ store, dir } = setupTokenStore());
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
    teardownTokenStore({ store, dir });
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
