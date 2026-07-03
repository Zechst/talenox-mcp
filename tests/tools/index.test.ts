import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../../src/tools/index.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { getRegisteredTool, getRegisteredTools } from "./test-utils.js";

describe("registerAllTools", () => {
  it("registers every v1 tool name exactly once", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAllTools(server, () => ({ talenox: {} as TalenoxClient }));

    const registered = getRegisteredTools(server);
    const names = Object.keys(registered);

    const expected = [
      "list_employees",
      "get_employee",
      "create_employee",
      "update_employee",
      "delete_employee",
      "list_pay_items",
      "list_cost_centres",
      "create_adhoc_payment",
      "create_recurring_payment",
      "create_attendance_payment",
      "create_leave_payment",
      "process_payroll",
      "publish_payroll",
      "unpublish_payroll",
      "export_payroll",
      "get_payslip",
      "get_payslip_pdf",
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(names.length).toBe(expected.length);
  });

  it("withInvocationLogging passes args through unmodified and returns the real result (added during /plan-eng-review)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue({ id: 1, name: "Jane" }) } as unknown as TalenoxClient;

    registerAllTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee");

    // Installed SDK stores the registered handler under `.handler`
    // (older/example shape used `.callback`); fall back for either.
    const handler = tool.handler ?? tool.callback;
    const result = await handler({ id: "1" }, {});

    // Proves the logging wrapper didn't swallow args or mutate the result —
    // this test exists specifically for the wrapper added this review, not
    // just as a duplicate of Task 9's employees.test.ts coverage.
    expect(talenox.get).toHaveBeenCalledWith("employees/1");
    expect(result.content[0].text).toContain("Jane");
    expect(result.isError).toBeUndefined();
  });
});
