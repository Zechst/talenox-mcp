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
