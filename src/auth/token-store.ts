import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encrypt, decrypt } from "./crypto.js";

export type StoredGrant = {
  talenoxAccessToken: string;
  talenoxRefreshToken: string;
  expiresAt: number;
};

type Row = {
  grant_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

function rowToGrant(row: Row): StoredGrant {
  return {
    talenoxAccessToken: decrypt(row.access_token),
    talenoxRefreshToken: decrypt(row.refresh_token),
    expiresAt: row.expires_at,
  };
}

export class TokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  createGrant(grantId: string, grant: StoredGrant): void {
    this.db
      .prepare(
        `INSERT INTO grants (grant_id, access_token, refresh_token, expires_at)
         VALUES (@grantId, @accessToken, @refreshToken, @expiresAt)`,
      )
      .run({
        grantId,
        accessToken: encrypt(grant.talenoxAccessToken),
        refreshToken: encrypt(grant.talenoxRefreshToken),
        expiresAt: grant.expiresAt,
      });
  }

  getGrant(grantId: string): StoredGrant | null {
    const row = this.db
      .prepare(`SELECT * FROM grants WHERE grant_id = ?`)
      .get(grantId) as Row | undefined;
    return row ? rowToGrant(row) : null;
  }

  findGrantByAccessToken(accessToken: string): StoredGrant | null {
    // access_token is stored encrypted (nondeterministic ciphertext, see Task 2),
    // so this can't be a WHERE on the encrypted column — scan and decrypt.
    // Fine at this scale (single user's active grants); revisit with a
    // deterministic HMAC lookup column if this ever needs to scale further.
    const rows = this.db.prepare(`SELECT * FROM grants`).all() as Row[];
    for (const row of rows) {
      const grant = rowToGrant(row);
      if (grant.talenoxAccessToken === accessToken) {
        return grant;
      }
    }
    return null;
  }

  rotateGrant(oldGrantId: string, newGrantId: string, grant: StoredGrant): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM grants WHERE grant_id = ?`).run(oldGrantId);
      this.createGrant(newGrantId, grant);
    });
    tx();
  }

  deleteGrant(grantId: string): void {
    this.db.prepare(`DELETE FROM grants WHERE grant_id = ?`).run(grantId);
  }

  close(): void {
    this.db.close();
  }
}
