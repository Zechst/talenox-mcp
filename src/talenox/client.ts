import { TalenoxApiError } from "./errors.js";
import { withQueryParams } from "../util/url.js";

const BASE_URL = "https://api.talenox.com/api/v2/";

export class TalenoxClient {
  constructor(private accessToken: string) {}

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = options.query
      ? withQueryParams(new URL(path, BASE_URL), options.query)
      : new URL(path, BASE_URL);

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new TalenoxApiError(response.status, body);
    }

    return (await response.json()) as T;
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}
