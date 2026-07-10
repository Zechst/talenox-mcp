import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./employees.js";
import { textResult, toErrorResult } from "./shared.js";

const nonEmptyId = z.string().min(1);

const DATE_FORMAT_NOTE = "Dates use Talenox's DD/MM/YYYY format, not ISO 8601.";

export function registerJobTools(
  server: McpServer,
  getContext: (extra: unknown) => ToolContext,
): void {
  server.registerTool(
    "list_employee_jobs",
    {
      description:
        `List an employee's job/role history (each entry has its own start_date and, if applicable, end_date), separate from the employee's overall resign_date. Talenox has no dedicated list endpoint for jobs — this reads the "jobs" array embedded in the employee record. ${DATE_FORMAT_NOTE}`,
      inputSchema: { employee_id: nonEmptyId },
    },
    async (args: { employee_id: string }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const employee = await talenox.get<{ jobs?: unknown }>(
          `employees/${encodeURIComponent(args.employee_id)}`,
        );
        return textResult(employee.jobs ?? []);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_employee_job",
    {
      description: `Get a single job/role record by job id. ${DATE_FORMAT_NOTE}`,
      inputSchema: { job_id: nonEmptyId },
    },
    async (args: { job_id: string }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.get(`jobs/${encodeURIComponent(args.job_id)}`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "create_employee_job",
    {
      description:
        `Create a new job/role record for an employee (e.g. a role change or promotion) with its own start_date and end_date. \`job\` is passed through to Talenox as-is (supported fields include title, department, start_date, end_date, rate_of_pay, amount, currency, remarks); refer to the Talenox API docs for the full list. ${DATE_FORMAT_NOTE}`,
      inputSchema: { employee_id: nonEmptyId, job: z.record(z.string(), z.unknown()) },
    },
    async (args: { employee_id: string; job: Record<string, unknown> }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.post("jobs", {
          employee_id: args.employee_id,
          job: args.job,
        });
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "update_employee_job",
    {
      description: `Update an existing job/role record by job id, e.g. to set its start_date or end_date. ${DATE_FORMAT_NOTE}`,
      inputSchema: {
        job_id: nonEmptyId,
        job: z.record(z.string(), z.unknown()),
      },
    },
    async (args: { job_id: string; job: Record<string, unknown> }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.put(`jobs/${encodeURIComponent(args.job_id)}`, {
          job: args.job,
        });
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_employee_job",
    {
      description: "Delete a job/role record from an employee's job history by job id.",
      inputSchema: { job_id: nonEmptyId },
    },
    async (args: { job_id: string }, extra: unknown) => {
      try {
        const { talenox } = getContext(extra);
        const result = await talenox.delete(`jobs/${encodeURIComponent(args.job_id)}`);
        return textResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
