import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TalenoxClient } from "../talenox/client.js";
import { textResult } from "./shared.js";

export type ToolContext = { talenox: TalenoxClient };

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function registerEmployeeTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_employees",
    {
      description: "List all employees in the Talenox account.",
    },
    async (extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get("employees");
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_employee",
    {
      description: "Get a single employee by id.",
      inputSchema: { id: z.string() },
    },
    async (args: { id: string }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get(`employees/${args.id}`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "create_employee",
    {
      description:
        "Create a new employee. `employee` is passed through to Talenox as-is; refer to the Talenox API docs for country-specific required fields (HK/ID/MY/SG).",
      inputSchema: { employee: z.record(z.string(), z.unknown()) },
    },
    async (args: { employee: Record<string, unknown> }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.post("employees", args.employee);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "update_employee",
    {
      description: "Update an existing employee by id.",
      inputSchema: { id: z.string(), employee: z.record(z.string(), z.unknown()) },
    },
    async (args: { id: string; employee: Record<string, unknown> }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.put(`employees/${args.id}`, args.employee);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_employee",
    {
      description: "Delete an employee by id.",
      inputSchema: { id: z.string() },
    },
    async (args: { id: string }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.delete(`employees/${args.id}`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
