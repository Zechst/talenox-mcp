import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPayrollTools } from "../../src/tools/payroll.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";
import { getRegisteredTool as getTool } from "./test-utils.js";

describe("payroll tools", () => {
  it("create_payroll_run calls POST payroll/payroll_payment with { payment, employee_ids }", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = {
      post: vi.fn().mockResolvedValue({ payment_id: 4, status: "Draft" }),
    } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_payroll_run");
    const result = await tool.handler(
      {
        payment: { year: 2026, month: "July", period: "Whole Month" },
        employee_ids: ["K00001"],
      },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("payroll/payroll_payment", {
      payment: { year: 2026, month: "July", period: "Whole Month" },
      employee_ids: ["K00001"],
    });
    expect(result.content[0].text).toContain("Draft");
  });

  it("create_payroll_run short-circuits on dry_run, never calling talenox.post", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn() } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_payroll_run");
    const result = await tool.handler(
      { payment: { year: 2026, month: "July", period: "Whole Month" }, dry_run: true },
      {},
    );

    expect(talenox.post).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_send.path).toBe("payroll/payroll_payment");
  });

  it("get_payroll_payment calls GET payroll/payroll_payment/:id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue({ payment_id: 4 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "get_payroll_payment");
    await tool.handler({ payroll_id: "4" }, {});

    expect(talenox.get).toHaveBeenCalledWith("payroll/payroll_payment/4");
  });

  it("list_payroll_payments calls GET payroll/payroll_payment with a month/year query", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { get: vi.fn().mockResolvedValue([]) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "list_payroll_payments");
    await tool.handler({ month: "July", year: 2026 }, {});

    expect(talenox.get).toHaveBeenCalledWith("payroll/payroll_payment", {
      month: "July",
      year: "2026",
    });
  });

  it("create_adhoc_payment calls POST payroll/adhoc_payment with { payment, pay_items }", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.handler(
      {
        payment: { id: 4 },
        pay_items: [{ employee_id: "K00001", item_type: "Allowance", amount: 100 }],
      },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("payroll/adhoc_payment", {
      payment: { id: 4 },
      pay_items: [{ employee_id: "K00001", item_type: "Allowance", amount: 100 }],
    });
    expect(result.content[0].text).toContain("1");
  });

  it("create_adhoc_payment short-circuits on dry_run, never calling talenox.post", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn() } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.handler(
      { payment: { id: 4 }, pay_items: [{ employee_id: "K00001", amount: 100 }], dry_run: true },
      {},
    );

    expect(talenox.post).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.would_send.path).toBe("payroll/adhoc_payment");
    expect(parsed.would_send.body).toEqual({
      payment: { id: 4 },
      pay_items: [{ employee_id: "K00001", amount: 100 }],
    });
  });

  it("create_recurring_payment calls POST payroll/recurring_payment", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ id: 2 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_recurring_payment");
    await tool.handler({ payment: { id: 4 }, pay_items: [] }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/recurring_payment", {
      payment: { id: 4 },
      pay_items: [],
    });
  });

  it("create_attendance_payment calls POST payroll/attendance_payment", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ id: 3 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_attendance_payment");
    await tool.handler({ payment: { id: 4 }, pay_items: [] }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/attendance_payment", {
      payment: { id: 4 },
      pay_items: [],
    });
  });

  it("create_leave_payment calls POST payroll/leave_payment_or_deduction", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ id: 5 }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_leave_payment");
    await tool.handler({ payment: { id: 4 }, pay_items: [] }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/leave_payment_or_deduction", {
      payment: { id: 4 },
      pay_items: [],
    });
  });

  it("process_payroll calls POST payroll/payroll_payment/:id/process", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ status: "Processed" }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "process_payroll");
    await tool.handler({ payroll_id: "42" }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/payroll_payment/42/process", {});
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
    expect(parsed.would_send.path).toBe("payroll/payroll_payment/42/process");
  });

  it("draft_payroll_payment calls POST payroll/payroll_payment/:id/draft", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ status: "Draft" }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "draft_payroll_payment");
    await tool.handler({ payroll_id: "42" }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/payroll_payment/42/draft", {});
  });

  it("publish_payslips calls POST payroll/publish_payslips with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ status: "ok" }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "publish_payslips");
    await tool.handler(
      {
        month: "July",
        year: 2026,
        payslip_pay_date: "31/07/2026",
        payslip_send_on_pd_setting: 0,
        attach_payslip_to_email: 0,
      },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("payroll/publish_payslips", {
      month: "July",
      year: 2026,
      payslip_pay_date: "31/07/2026",
      payslip_send_on_pd_setting: 0,
      attach_payslip_to_email: 0,
    });
  });

  it("publish_payslips short-circuits on dry_run, never calling talenox.post", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn() } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "publish_payslips");
    const result = await tool.handler(
      {
        month: "July",
        year: 2026,
        payslip_pay_date: "31/07/2026",
        payslip_send_on_pd_setting: 0,
        attach_payslip_to_email: 0,
        dry_run: true,
      },
      {},
    );

    expect(talenox.post).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
  });

  it("unpublish_payslips calls POST payroll/unpublish_payslips with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ status: "ok" }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "unpublish_payslips");
    await tool.handler({ month: "July", year: 2026 }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/unpublish_payslips", {
      month: "July",
      year: 2026,
    });
  });

  it("export_payroll calls POST payroll/export_payroll with month/year/period", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue({ payslips: [] }) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "export_payroll");
    await tool.handler({ month: "July", year: 2026, period: "Whole Month" }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/export_payroll", {
      month: "July",
      year: 2026,
      period: "Whole Month",
    });
  });

  it("get_payslips_data calls POST payroll/get_payslips_data with month/year/employee_ids", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue([{ id: 7 }]) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "get_payslips_data");
    await tool.handler({ month: "July", year: 2026, employee_ids: ["K00001"] }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/get_payslips_data", {
      month: "July",
      year: 2026,
      employee_ids: ["K00001"],
    });
  });

  it("get_payslips_pdf calls POST payroll/get_payslips with employee_ids/month/year", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = { post: vi.fn().mockResolvedValue([{ 1701: null }]) } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "get_payslips_pdf");
    await tool.handler({ employee_ids: [1701], month: "July", year: 2026 }, {});

    expect(talenox.post).toHaveBeenCalledWith("payroll/get_payslips", {
      employee_ids: [1701],
      month: "July",
      year: 2026,
    });
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result, not an unhandled rejection", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = {
      post: vi.fn().mockRejectedValue(new TalenoxApiError(422, "invalid cost centre id")),
    } as unknown as TalenoxClient;
    registerPayrollTools(server, () => ({ talenox }));

    const tool = getTool(server, "create_adhoc_payment");
    const result = await tool.handler({ payment: { id: 4 }, pay_items: [] }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid cost centre id");
  });
});
