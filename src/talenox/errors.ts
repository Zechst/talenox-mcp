export class TalenoxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Talenox API error ${status}: ${body}`);
    this.name = "TalenoxApiError";
  }
}
