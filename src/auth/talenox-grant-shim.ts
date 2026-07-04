import { randomUUID } from "node:crypto";
import type { TokenStore } from "./token-store.js";
import { exchangeCodeForTokens, refreshTokens } from "./talenox-oauth-client.js";

export type IssuedGrant = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export class GrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`No stored grant for refresh token ${grantId}`);
    this.name = "GrantNotFoundError";
  }
}

export class TalenoxGrantShim {
  constructor(
    private store: TokenStore,
    private oauthConfig: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
    },
    private idGenerator: () => string = randomUUID,
  ) {}

  async exchangeAuthorizationCode(code: string): Promise<IssuedGrant> {
    const tokens = await exchangeCodeForTokens({
      clientId: this.oauthConfig.clientId,
      clientSecret: this.oauthConfig.clientSecret,
      redirectUri: this.oauthConfig.redirectUri,
      code,
    });

    const grantId = this.idGenerator();
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    this.store.createGrant(grantId, {
      talenoxAccessToken: tokens.access_token,
      talenoxRefreshToken: tokens.refresh_token,
      expiresAt,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: grantId,
      expiresIn: tokens.expires_in,
    };
  }

  async refresh(ourRefreshToken: string): Promise<IssuedGrant> {
    const grant = this.store.getGrant(ourRefreshToken);
    if (!grant) {
      throw new GrantNotFoundError(ourRefreshToken);
    }

    const refreshed = await refreshTokens({
      clientId: this.oauthConfig.clientId,
      clientSecret: this.oauthConfig.clientSecret,
      redirectUri: this.oauthConfig.redirectUri,
      refreshToken: grant.talenoxRefreshToken,
      accessToken: grant.talenoxAccessToken,
    });

    const newGrantId = this.idGenerator();
    const expiresAt = Date.now() + refreshed.expires_in * 1000;

    this.store.rotateGrant(ourRefreshToken, newGrantId, {
      talenoxAccessToken: refreshed.access_token,
      talenoxRefreshToken: refreshed.refresh_token,
      expiresAt,
    });

    return {
      accessToken: refreshed.access_token,
      refreshToken: newGrantId,
      expiresIn: refreshed.expires_in,
    };
  }

  verifyAccessToken(
    accessToken: string,
  ): { valid: true; expiresAt: number } | { valid: false } {
    const grant = this.store.findGrantByAccessToken(accessToken);
    if (!grant || grant.expiresAt <= Date.now()) {
      return { valid: false };
    }
    return { valid: true, expiresAt: grant.expiresAt };
  }
}
