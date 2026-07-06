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
