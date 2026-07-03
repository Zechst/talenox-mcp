import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEmployeeTools, type ToolContext } from "./employees.js";
import { registerPayItemTools } from "./pay-items.js";
import { registerCostCentreTools } from "./cost-centres.js";
import { registerPayrollTools } from "./payroll.js";

export type { ToolContext };

// Wraps every tool's handler with structured invocation logging (tool name,
// dry_run flag if present, success/failure) without touching each tools file
// individually — caught as a gap during /plan-ceo-review's Section 8
// observability pass: with zero logging, a bad payroll run has no trail to
// reconstruct what Claude actually called.
function withInvocationLogging(server: McpServer): McpServer {
  const originalRegisterTool = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, schema: unknown, handler: Function) => {
    const wrappedHandler = async (args: any, extra: unknown) => {
      const dryRun =
        args && typeof args === "object" && "dry_run" in args ? args.dry_run : undefined;
      console.log(JSON.stringify({ event: "tool.invoke", tool: name, dryRun }));
      try {
        const result = await handler(args, extra);
        console.log(
          JSON.stringify({ event: "tool.result", tool: name, isError: Boolean(result?.isError) }),
        );
        return result;
      } catch (err) {
        console.log(
          JSON.stringify({
            event: "tool.error",
            tool: name,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }
    };
    return originalRegisterTool(name, schema as any, wrappedHandler as any);
  };
  return server;
}

export function registerAllTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  const loggedServer = withInvocationLogging(server);
  registerEmployeeTools(loggedServer, getContext);
  registerPayItemTools(loggedServer, getContext);
  registerCostCentreTools(loggedServer, getContext);
  registerPayrollTools(loggedServer, getContext);
}
