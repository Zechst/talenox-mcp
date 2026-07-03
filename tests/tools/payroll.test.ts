import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPayrollTools } from "../../src/tools/payroll.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";
import { getRegisteredTool as getTool } from "./test-utils.js";

describe("payroll tools", () => {
  it("create_adhoc_payment calls POST payroll/adhoc_payments with the given payment", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.handler(
      { payment: { employee_id: 5, amount: 100 } },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("payroll/adhoc_payments", {
      employee_id: 5,
      amount: 100,
    });
    expect(result.content[0].text).toContain("1");
  });

  it("create_adhoc_payment short-circuits on dry_run, never calling talenox.post", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn() } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.handler(
      { payment: { employee_id: 5, amount: 100 }, dry_run: true },
      {},
    );

    expect(talenox.post).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_send.body).toEqual({ employee_id: 5, amount: 100 });
  });

  it("process_payroll calls POST payroll/{id}/process", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ status: "processed" }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "process_payroll");
    await tool.handler({ payroll_id: "42" }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/42/process", {});
  });

  it("process_payroll short-circuits on dry_run, never calling talenox.post", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn() } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "process_payroll");
    const result = await tool.handler({ payroll_id: "42", dry_run: true }, {});

    expect(talenox.post).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_send.path).toBe("payroll/42/process");
  });

  it("export_payroll calls GET payroll/{id}/export", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue({ url: "https://..." }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "export_payroll");
    await tool.handler({ payroll_id: "42" }, {});

    expect(talenox.get).toHaveBeenCalledWith("payroll/42/export");
  });

  it("get_payslip calls GET payslips/{id}", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue({ id: 7 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "get_payslip");
    await tool.handler({ payslip_id: "7" }, {});

    expect(talenox.get).toHaveBeenCalledWith("payslips/7");
  });

  it("get_payslip_pdf calls GET payslips/{id}/pdf", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue({ url: "https://..." }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "get_payslip_pdf");
    await tool.handler({ payslip_id: "7" }, {});

    expect(talenox.get).toHaveBeenCalledWith("payslips/7/pdf");
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result, not an unhandled rejection", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = {
      post: vi.fn().mockRejectedValue(new TalenoxApiError(422, "invalid cost centre id")),
    } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.handler({ payment: { employee_id: 5 } }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid cost centre id");
  });
});
