import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult, toErrorResult } from "./shared.js";

const nonEmptyId = z.string().min(1);
const stringOrNumber = z.union([z.string(), z.number()]);

function dryRunResult(path: string, body: unknown) {
  return textResult({ dry_run: true, would_send: { path, body } });
}

const paymentSchema = {
  payment: z.record(z.string(), z.unknown()),
  pay_items: z.array(z.record(z.string(), z.unknown())),
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
        const body = { payment: args.payment, pay_items: args.pay_items };
        if (args.dry_run) {
          return dryRunResult(path, body);
        }
        const { talenox } = getContext(extra);
        const result = await talenox.post(path, body);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

const payrollActionSchema = {
  payroll_id: nonEmptyId,
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
        const path = pathFor(encodeURIComponent(args.payroll_id));
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
  server.registerTool(
    "create_payroll_run",
    {
      description:
        'Create a new payroll run/payment in Draft status — this is what Talenox\'s "Create new payrun" button does. `payment` requires year, month, and period (e.g. "Whole Month"); pay_group and with_pay_items are optional. `employee_ids` optionally restricts which employees the run covers. Supports dry_run.',
      inputSchema: {
        payment: z.record(z.string(), z.unknown()),
        employee_ids: z.array(z.string()).optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const body: Record<string, unknown> = { payment: args.payment };
        if (args.employee_ids) body.employee_ids = args.employee_ids;
        if (args.dry_run) {
          return dryRunResult("payroll/payroll_payment", body);
        }
        const { talenox } = getContext(extra);
        const result = await talenox.post("payroll/payroll_payment", body);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_payroll_payment",
    {
      description: "Get a single payroll payment/run by id, including its pay items and status.",
      inputSchema: { payroll_id: nonEmptyId },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get(
          `payroll/payroll_payment/${encodeURIComponent(args.payroll_id)}`,
        );
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "list_payroll_payments",
    {
      description: "List payroll payments/runs, optionally filtered by month/year.",
      inputSchema: { month: z.string().optional(), year: stringOrNumber.optional() },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const query: Record<string, string> = {};
        if (args.month) query.month = args.month;
        if (args.year !== undefined) query.year = String(args.year);
        const result = await talenox.get("payroll/payroll_payment", query);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  registerPaymentTool(
    server,
    getContext,
    "create_adhoc_payment",
    "payroll/adhoc_payment",
    "Create a one-off (adhoc) payroll payment. `payment` needs year/month/period (or an existing payment id, in which case month/year/period can be omitted); `pay_items` is an array of { employee_id, item_type, amount, remarks }. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_recurring_payment",
    "payroll/recurring_payment",
    "Create a recurring payroll payment. `payment` needs year/month/period (or an existing payment id); `pay_items` supports actual_no_of_working_days/total_no_of_working_days overrides. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_attendance_payment",
    "payroll/attendance_payment",
    "Create an attendance-based payroll payment. `payment` needs year/month/period (or an existing payment id); `pay_items` supports rate_of_pay/no_of_hours_slash_days. Supports dry_run.",
  );
  registerPaymentTool(
    server,
    getContext,
    "create_leave_payment",
    "payroll/leave_payment_or_deduction",
    "Create a leave-based payroll payment or deduction. `payment` needs year/month/period (or an existing payment id); `pay_items` supports override_working_days. Supports dry_run.",
  );

  registerPayrollActionTool(
    server,
    getContext,
    "process_payroll",
    (id) => `payroll/payroll_payment/${id}/process`,
    "Process a payroll payment/run by id. This is hard to reverse in Talenox — confirm with the user before calling without dry_run.",
  );
  registerPayrollActionTool(
    server,
    getContext,
    "draft_payroll_payment",
    (id) => `payroll/payroll_payment/${id}/draft`,
    "Revert a processed payroll payment/run back to Draft status by id. This changes live payroll state — confirm with the user before calling without dry_run.",
  );

  server.registerTool(
    "publish_payslips",
    {
      description:
        "Publish payslips for a given month/year, making them visible to employees. This is hard to reverse in Talenox — confirm with the user before calling without dry_run. Optionally restrict to specific employee_ids.",
      inputSchema: {
        month: z.string(),
        year: stringOrNumber,
        payslip_pay_date: z.string(),
        payslip_send_on_pd_setting: z.number(),
        attach_payslip_to_email: z.number(),
        employee_ids: z.array(z.string()).optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const { dry_run, ...body } = args;
        if (dry_run) {
          return dryRunResult("payroll/publish_payslips", body);
        }
        const { talenox } = getContext(extra);
        const result = await talenox.post("payroll/publish_payslips", body);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "unpublish_payslips",
    {
      description:
        "Unpublish payslips for a given month/year, hiding them from employees again. This changes live payroll state — confirm with the user before calling without dry_run. Optionally restrict to specific employee_ids.",
      inputSchema: {
        month: z.string(),
        year: stringOrNumber,
        employee_ids: z.array(z.string()).optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const { dry_run, ...body } = args;
        if (dry_run) {
          return dryRunResult("payroll/unpublish_payslips", body);
        }
        const { talenox } = getContext(extra);
        const result = await talenox.post("payroll/unpublish_payslips", body);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "export_payroll",
    {
      description: "Export payroll data for a given month/year/period.",
      inputSchema: {
        month: z.string(),
        year: stringOrNumber,
        period: z.string(),
        pay_date: z.string().optional(),
      },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.post("payroll/export_payroll", args);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_payslips_data",
    {
      description:
        "Get payslip data for a given month/year, optionally filtered to specific employee_ids.",
      inputSchema: {
        month: z.string(),
        year: stringOrNumber,
        employee_ids: z.array(z.string()).optional(),
      },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.post("payroll/get_payslips_data", args);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_payslips_pdf",
    {
      description:
        "Get payslip PDF links for the given employee_ids in a month/year, optionally including employee data.",
      inputSchema: {
        employee_ids: z.array(stringOrNumber),
        month: z.string(),
        year: stringOrNumber,
        include_employee_data: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.post("payroll/get_payslips", args);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
