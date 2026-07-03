import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult, toErrorResult } from "./shared.js";

export function registerPayItemTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_pay_items",
    {
      description:
        "List custom pay items configured in Talenox (needed to resolve valid pay item IDs before creating payments).",
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get("custom_pay_items");
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
