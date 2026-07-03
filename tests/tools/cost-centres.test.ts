import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCostCentreTools } from "../../src/tools/cost-centres.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";
import { getRegisteredTool } from "./test-utils.js";

describe("cost centre tools", () => {
  it("registers list_cost_centres, calling GET cost_centres", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue([{ id: 1, name: "Engineering" }]) } as unknown as TalenoxClient;

    registerCostCentreTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_cost_centres");
    const result = await tool.handler({}, {});

    expect(talenox.get).toHaveBeenCalledWith("cost_centres");
    expect(result.content[0].text).toContain("Engineering");
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result (added during /plan-eng-review)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockRejectedValue(new TalenoxApiError(500, "upstream error")) } as unknown as TalenoxClient;

    registerCostCentreTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_cost_centres");
    const result = await tool.handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("upstream error");
  });
});
