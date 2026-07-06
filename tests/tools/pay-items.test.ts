import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPayItemTools } from "../../src/tools/pay-items.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";
import { getRegisteredTool } from "./test-utils.js";

describe("pay item tools", () => {
  it("registers list_pay_items, calling GET custom_pay_items", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue([{ id: 1, name: "Bonus" }]) } as unknown as TalenoxClient;

    registerPayItemTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_pay_items");
    const result = await tool.handler({}, {});

    expect(talenox.get).toHaveBeenCalledWith("custom_pay_items");
    expect(result.content[0].text).toContain("Bonus");
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result (added during /plan-eng-review)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockRejectedValue(new TalenoxApiError(500, "upstream error")) } as unknown as TalenoxClient;

    registerPayItemTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_pay_items");
    const result = await tool.handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("upstream error");
  });
});
