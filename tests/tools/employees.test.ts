import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEmployeeTools } from "../../src/tools/employees.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";

function makeMockTalenox() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as TalenoxClient;
}

// Note: McpServer's internal storage of registered tools (`_registeredTools`)
// is not part of its public API. The installed SDK version (verified by
// reading node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js)
// stores the handler under `.handler`, not `.callback` as an earlier plan
// draft assumed — adjusted here accordingly.
function getRegisteredTool(server: McpServer, name: string) {
  return (server as any)._registeredTools?.[name] ?? (server as any).tools?.[name];
}

describe("employee tools", () => {
  it("registers list_employees, calling GET employees", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue([{ id: 1, name: "Jane" }]);

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_employees");
    expect(tool).toBeDefined();

    const result = await tool.handler({}, {});
    expect(talenox.get).toHaveBeenCalledWith("employees");
    expect(result.content[0].text).toContain("Jane");
  });

  it("registers create_employee, calling POST employees with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.post as any).mockResolvedValue({ id: 2 });

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "create_employee");
    const result = await tool.handler({ employee: { name: "New" } }, {});

    expect(talenox.post).toHaveBeenCalledWith("employees", { name: "New" });
    expect(result.content[0].text).toContain("2");
  });

  it("registers get_employee, calling GET employees/:id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({ id: 42, name: "Bob" });

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee");
    const result = await tool.handler({ id: "42" }, {});

    expect(talenox.get).toHaveBeenCalledWith("employees/42");
    expect(result.content[0].text).toContain("Bob");
  });

  it("registers update_employee, calling PUT employees/:id with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.put as any).mockResolvedValue({ id: 42, name: "Updated" });

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "update_employee");
    const result = await tool.handler({ id: "42", employee: { name: "Updated" } }, {});

    expect(talenox.put).toHaveBeenCalledWith("employees/42", { name: "Updated" });
    expect(result.content[0].text).toContain("Updated");
  });

  it("registers delete_employee, calling DELETE employees/:id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.delete as any).mockResolvedValue({ success: true });

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "delete_employee");
    const result = await tool.handler({ id: "42" }, {});

    expect(talenox.delete).toHaveBeenCalledWith("employees/42");
    expect(result.content[0].text).toContain("true");
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result (added during /plan-eng-review)", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockRejectedValue(new TalenoxApiError(404, "employee not found"));

    registerEmployeeTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee");
    const result = await tool.handler({ id: "999" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("employee not found");
  });
});
