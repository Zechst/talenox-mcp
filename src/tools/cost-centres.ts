import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult, toErrorResult } from "./shared.js";

export function registerCostCentreTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_cost_centres",
    {
      description:
        "List cost centres configured in Talenox (needed to resolve valid cost centre IDs before creating payments).",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get("cost_centres");
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
