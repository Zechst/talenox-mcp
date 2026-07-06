import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TokenStore } from "../../src/auth/token-store.js";
import { setupTokenStore, teardownTokenStore } from "./test-utils.js";

describe("TokenStore", () => {
  let dir: string;
  let store: TokenStore;

  beforeEach(() => {
    ({ store, dir } = setupTokenStore());
  });

  afterEach(() => {
    teardownTokenStore({ store, dir });
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
