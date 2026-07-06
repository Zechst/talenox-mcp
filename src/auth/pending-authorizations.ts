import { randomUUID } from "node:crypto";

type Entry = { payload: unknown; expiresAt: number };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class PendingAuthorizations {
  private entries = new Map<string, Entry>();

  constructor(
    private ttlMs: number = DEFAULT_TTL_MS,
    private idGenerator: () => string = randomUUID,
  ) {}

  create(payload: unknown): string {
    this.sweep(); // opportunistic cleanup — bounds memory growth from abandoned/never-completed authorize attempts without needing a background timer
    const id = this.idGenerator();
    this.entries.set(id, { payload, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  consume(id: string): unknown | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.entries.delete(id);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }

  peek(id: string): unknown | null {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.payload;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
