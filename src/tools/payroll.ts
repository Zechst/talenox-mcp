import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult, toErrorResult } from "./shared.js";

function dryRunResult(path: string, body: unknown) {
  return textResult({ dry_run: true, would_send: { path, body } });
}

const paymentSchema = {
  payment: z.record(z.string(), z.unknown()),
  dry_run: z.boolean().optional(),
};

function registerPaymentTool(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
  name: string,
  path: string,
  description: string,
) {
  server.registerTool(
    name,
    { description, inputSchema: paymentSchema },
    async (args, extra) => {
      try {
        if (args.dry_run) {
          return dryRunResult(path, args.payment);
        }
        const { talenox } = getContext(extra);
        const result = await talenox.post(path, args.payment);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

const payrollActionSchema = {
  payroll_id: z.string(),
  dry_run: z.boolean().optional(),
};

function registerPayrollActionTool(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
  name: string,
  pathFor: (payrollId: string) => string,
  description: string,
) {
  server.registerTool(
    name,
    { description, inputSchema: payrollActionSchema },
    async (args, extra) => {
      try {
        const path = pathFor(args.payroll_id);
        if (args.dry_run) {
          return dryRunResult(path, {});
        }
        const { talenox } = getContext(extra);
        const result = await talenox.post(path, {});
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

export function registerPayrollTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  registerPaymentTool(
    server,
    getContext,
    "create_adhoc_payment",
    "payroll/adhoc_payments",
    "Create a one-off (adhoc) payroll payment. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_recurring_payment",
    "payroll/recurring_payments",
    "Create a recurring payroll payment. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_attendance_payment",
    "payroll/attendance_payments",
    "Create an attendance-based payroll payment. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_leave_payment",
    "payroll/leave_payments",
    "Create a leave-based payroll payment. Supports dry_run.",
  );

  registerPayrollActionTool(
    server,
    getContext,
    "process_payroll",
    (id) => `payroll/${id}/process`,
    "Process a payroll run. This is hard to reverse in Talenox — confirm with the user before calling without dry_run.",
  );
  registerPayrollActionTool(
    server,
    getContext,
    "publish_payroll",
    (id) => `payroll/${id}/publish`,
    "Publish a payroll run, making payslips visible to employees. This is hard to reverse in Talenox — confirm with the user before calling without dry_run.",
  );
  registerPayrollActionTool(
    server,
    getContext,
    "unpublish_payroll",
    (id) => `payroll/${id}/unpublish`,
    "Unpublish a previously published payroll run, hiding payslips from employees again. This changes live payroll state — confirm with the user before calling without dry_run.",
  );

  server.registerTool(
    "export_payroll",
    {
      description: "Export payroll data for a given payroll run.",
      inputSchema: { payroll_id: z.string() },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get(`payroll/${args.payroll_id}/export`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_payslip",
    {
      description: "Get payslip data by payslip id.",
      inputSchema: { payslip_id: z.string() },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get(`payslips/${args.payslip_id}`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_payslip_pdf",
    {
      description: "Get the payslip PDF (or a link to it) by payslip id.",
      inputSchema: { payslip_id: z.string() },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get(`payslips/${args.payslip_id}/pdf`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
