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
