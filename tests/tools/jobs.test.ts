import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobTools } from "../../src/tools/jobs.js";
import type { TalenoxClient } from "../../src/talenox/client.js";
import { TalenoxApiError } from "../../src/talenox/errors.js";
import { getRegisteredTool } from "./test-utils.js";

function makeMockTalenox() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as TalenoxClient;
}

describe("job tools", () => {
  it("registers list_employee_jobs, calling GET employees/:employee_id/jobs", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue([{ id: 1, job_title: "Engineer", start_date: "2025-01-01" }]);

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_employee_jobs");
    const result = await tool.handler({ employee_id: "42" }, {});

    expect(talenox.get).toHaveBeenCalledWith("employees/42/jobs");
    expect(result.content[0].text).toContain("Engineer");
  });

  it("registers get_employee_job, calling GET employees/:employee_id/jobs/:job_id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({ id: 7, job_title: "Manager" });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee_job");
    const result = await tool.handler({ employee_id: "42", job_id: "7" }, {});

    expect(talenox.get).toHaveBeenCalledWith("employees/42/jobs/7");
    expect(result.content[0].text).toContain("Manager");
  });

  it("registers create_employee_job, calling POST employees/:employee_id/jobs with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.post as any).mockResolvedValue({ id: 8 });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "create_employee_job");
    const result = await tool.handler(
      { employee_id: "42", job: { job_title: "Manager", start_date: "2026-01-01" } },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("employees/42/jobs", {
      job_title: "Manager",
      start_date: "2026-01-01",
    });
    expect(result.content[0].text).toContain("8");
  });

  it("registers update_employee_job, calling PUT employees/:employee_id/jobs/:job_id with the given body", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.put as any).mockResolvedValue({ id: 7, end_date: "2026-06-30" });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "update_employee_job");
    const result = await tool.handler(
      { employee_id: "42", job_id: "7", job: { end_date: "2026-06-30" } },
      {},
    );

    expect(talenox.put).toHaveBeenCalledWith("employees/42/jobs/7", { end_date: "2026-06-30" });
    expect(result.content[0].text).toContain("2026-06-30");
  });

  it("registers delete_employee_job, calling DELETE employees/:employee_id/jobs/:job_id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.delete as any).mockResolvedValue({ success: true });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "delete_employee_job");
    const result = await tool.handler({ employee_id: "42", job_id: "7" }, {});

    expect(talenox.delete).toHaveBeenCalledWith("employees/42/jobs/7");
    expect(result.content[0].text).toContain("true");
  });

  it("surfaces a thrown TalenoxApiError as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockRejectedValue(new TalenoxApiError(404, "job not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee_job");
    const result = await tool.handler({ employee_id: "42", job_id: "999" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
  });

  it("URL-encodes employee_id and job_id before building the request path", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({ id: 1 });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee_job");
    await tool.handler({ employee_id: "../../v1", job_id: "7?x=1" }, {});

    expect(talenox.get).toHaveBeenCalledWith("employees/..%2F..%2Fv1/jobs/7%3Fx%3D1");
  });

  it("surfaces a TalenoxApiError from list_employee_jobs as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockRejectedValue(new TalenoxApiError(404, "employee not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_employee_jobs");
    const result = await tool.handler({ employee_id: "999" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("employee not found");
  });

  it("surfaces a TalenoxApiError from create_employee_job as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.post as any).mockRejectedValue(new TalenoxApiError(422, "start_date is required"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "create_employee_job");
    const result = await tool.handler({ employee_id: "42", job: {} }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("start_date is required");
  });

  it("surfaces a TalenoxApiError from update_employee_job as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.put as any).mockRejectedValue(new TalenoxApiError(404, "job not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "update_employee_job");
    const result = await tool.handler(
      { employee_id: "42", job_id: "999", job: { end_date: "2026-06-30" } },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
  });

  it("surfaces a TalenoxApiError from delete_employee_job as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.delete as any).mockRejectedValue(new TalenoxApiError(404, "job not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "delete_employee_job");
    const result = await tool.handler({ employee_id: "42", job_id: "999" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
  });
});
