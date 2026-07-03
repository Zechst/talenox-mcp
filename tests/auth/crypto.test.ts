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
