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
  it("registers list_employee_jobs, reading the jobs array off GET employees/:employee_id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({
      id: 42,
      jobs: [{ id: 1, title: "Engineer", start_date: "01/01/2025", end_date: null }],
    });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_employee_jobs");
    const result = await tool.handler({ employee_id: "42" }, {});

    expect(talenox.get).toHaveBeenCalledWith("employees/42");
    expect(result.content[0].text).toContain("Engineer");
  });

  it("list_employee_jobs returns an empty array when the employee has no jobs field", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({ id: 42 });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "list_employee_jobs");
    const result = await tool.handler({ employee_id: "42" }, {});

    expect(result.content[0].text).toBe("[]");
  });

  it("registers get_employee_job, calling GET jobs/:job_id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({ id: 7, title: "Manager" });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee_job");
    const result = await tool.handler({ job_id: "7" }, {});

    expect(talenox.get).toHaveBeenCalledWith("jobs/7");
    expect(result.content[0].text).toContain("Manager");
  });

  it("registers create_employee_job, calling POST jobs with { employee_id, job }", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.post as any).mockResolvedValue({ id: 8 });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "create_employee_job");
    const result = await tool.handler(
      { employee_id: "42", job: { title: "Manager", start_date: "01/01/2026" } },
      {},
    );

    expect(talenox.post).toHaveBeenCalledWith("jobs", {
      employee_id: "42",
      job: { title: "Manager", start_date: "01/01/2026" },
    });
    expect(result.content[0].text).toContain("8");
  });

  it("registers update_employee_job, reading the existing job and merging the partial update before PUT", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({
      id: 7,
      title: "Front-end Developer",
      department: "Engineering & Technology",
      start_date: "01/09/2025",
      end_date: "12/06/2026",
    });
    (talenox.put as any).mockResolvedValue({ id: 7, end_date: "30/06/2026" });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "update_employee_job");
    const result = await tool.handler({ job_id: "7", job: { end_date: "30/06/2026" } }, {});

    expect(talenox.get).toHaveBeenCalledWith("jobs/7");
    expect(talenox.put).toHaveBeenCalledWith("jobs/7", {
      job: {
        id: 7,
        title: "Front-end Developer",
        department: "Engineering & Technology",
        start_date: "01/09/2025",
        end_date: "30/06/2026",
      },
    });
    expect(result.content[0].text).toContain("30/06/2026");
  });

  it("update_employee_job surfaces a TalenoxApiError from the read step", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockRejectedValue(new TalenoxApiError(404, "job not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "update_employee_job");
    const result = await tool.handler({ job_id: "999", job: { end_date: "30/06/2026" } }, {});

    expect(talenox.put).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
  });

  it("registers delete_employee_job, calling DELETE jobs/:job_id", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.delete as any).mockResolvedValue({ success: true });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "delete_employee_job");
    const result = await tool.handler({ job_id: "7" }, {});

    expect(talenox.delete).toHaveBeenCalledWith("jobs/7");
    expect(result.content[0].text).toContain("true");
  });

  it("URL-encodes job_id before building the request path", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockResolvedValue({ id: 1 });

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee_job");
    await tool.handler({ job_id: "7?x=1" }, {});

    expect(talenox.get).toHaveBeenCalledWith("jobs/7%3Fx%3D1");
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

  it("surfaces a TalenoxApiError from get_employee_job as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.get as any).mockRejectedValue(new TalenoxApiError(404, "job not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "get_employee_job");
    const result = await tool.handler({ job_id: "999" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
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
    const result = await tool.handler({ job_id: "999", job: { end_date: "30/06/2026" } }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
  });

  it("surfaces a TalenoxApiError from delete_employee_job as an MCP error result", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const talenox = makeMockTalenox();
    (talenox.delete as any).mockRejectedValue(new TalenoxApiError(404, "job not found"));

    registerJobTools(server, () => ({ talenox }));

    const tool = getRegisteredTool(server, "delete_employee_job");
    const result = await tool.handler({ job_id: "999" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("job not found");
  });
});
