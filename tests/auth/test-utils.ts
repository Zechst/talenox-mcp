import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/auth/token-store.js";

export type TokenStoreFixture = { store: TokenStore; dir: string };

export function setupTokenStore(): TokenStoreFixture {
  process.env.MCP_ENCRYPTION_KEY = "0".repeat(63) + "1";
  const dir = mkdtempSync(join(tmpdir(), "talenox-mcp-test-"));
  const store = new TokenStore(join(dir, "tokens.db"));
  return { store, dir };
}

export function teardownTokenStore({ store, dir }: TokenStoreFixture): void {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
