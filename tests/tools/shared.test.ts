import { describe, it, expect } from "vitest";
import { textResult, toErrorResult } from "../../src/tools/shared.js";

describe("textResult", () => {
  it("serializes defined data as JSON text", () => {
    const result = textResult({ id: 1 });
    expect(result.content[0].text).toBe('{"id":1}');
  });

  it("falls back to null instead of undefined text for an empty/204 response", () => {
    const result = textResult(undefined);
    expect(result.content[0].text).toBe("null");
  });
});

describe("toErrorResult", () => {
  it("surfaces an Error's message and sets isError", () => {
    const result = toErrorResult(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("boom");
  });
});
