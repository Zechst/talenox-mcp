import type { Request, Response, NextFunction } from "express";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { buildAuthorizeUrl } from "./talenox-oauth-client.js";
import { TalenoxGrantShim, GrantNotFoundError } from "./talenox-grant-shim.js";
import { PendingAuthorizations } from "./pending-authorizations.js";

type HandoffPayload = {
  clientRedirectUri: string;
  clientState: string;
  codeChallenge: string;
};

type FinalCodePayload = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  codeChallenge: string;
};

export function createTalenoxOAuthProvider(config: {
  publicBaseUrl: string;
  talenoxClientId: string;
  talenoxClientSecret: string;
  scope: string;
  shim: TalenoxGrantShim;
}) {
  const redirectUri = `${config.publicBaseUrl}/callback`;
  const handoffs = new PendingAuthorizations();
  const finalCodes = new PendingAuthorizations();
  const registeredClients = new Map<string, unknown>();

  const clientsStore = {
    async getClient(clientId: string) {
      return registeredClients.get(clientId);
    },
    async registerClient(client: { client_id: string }) {
      registeredClients.set(client.client_id, client);
      return client;
    },
  };

  async function authorize(
    _client: unknown,
    params: { redirectUri: string; state?: string; codeChallenge: string },
    res: Response,
  ) {
    const handoffId = handoffs.create({
      clientRedirectUri: params.redirectUri,
      clientState: params.state ?? "",
      codeChallenge: params.codeChallenge,
    } satisfies HandoffPayload);

    const url = buildAuthorizeUrl({
      clientId: config.talenoxClientId,
      redirectUri,
      scope: config.scope,
      state: handoffId,
    });

    console.log(JSON.stringify({ event: "oauth.authorize.redirect", handoffId }));
    res.redirect(url);
  }

  const callbackHandler = async (
    req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    const code = String(req.query.code ?? "");
    const handoffId = String(req.query.state ?? "");
    const handoff = handoffs.consume(handoffId) as HandoffPayload | null;

    if (!code || !handoff) {
      console.log(
        JSON.stringify({ event: "oauth.callback.invalid_handoff", handoffId }),
      );
      res
        .status(400)
        .json({ error: "invalid or expired authorization handoff" });
      return;
    }

    let issued;
    try {
      issued = await config.shim.exchangeAuthorizationCode(code);
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "oauth.callback.exchange_failed",
          handoffId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      res.status(502).json({ error: "failed to exchange code with Talenox" });
      return;
    }

    const mcpAuthCode = finalCodes.create({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      codeChallenge: handoff.codeChallenge,
    } satisfies FinalCodePayload);

    console.log(JSON.stringify({ event: "oauth.callback.exchanged", handoffId }));

    const redirectUrl = new URL(handoff.clientRedirectUri);
    redirectUrl.searchParams.set("code", mcpAuthCode);
    redirectUrl.searchParams.set("state", handoff.clientState);
    res.redirect(redirectUrl.toString());
  };

  async function challengeForAuthorizationCode(_client: unknown, code: string) {
    const entry = finalCodes.peek(code) as FinalCodePayload | null;
    if (!entry) throw new InvalidGrantError("unknown or expired authorization code");
    return entry.codeChallenge;
  }

  async function exchangeAuthorizationCode(_client: unknown, code: string) {
    const entry = finalCodes.consume(code) as FinalCodePayload | null;
    if (!entry) throw new InvalidGrantError("unknown or expired authorization code");
    return {
      access_token: entry.accessToken,
      refresh_token: entry.refreshToken,
      expires_in: entry.expiresIn,
      token_type: "Bearer",
    };
  }

  async function exchangeRefreshToken(_client: unknown, refreshToken: string) {
    try {
      const issued = await config.shim.refresh(refreshToken);
      console.log(JSON.stringify({ event: "oauth.refresh.success" }));
      return {
        access_token: issued.accessToken,
        refresh_token: issued.refreshToken,
        expires_in: issued.expiresIn,
        token_type: "Bearer",
      };
    } catch (err) {
      if (err instanceof GrantNotFoundError) {
        console.log(JSON.stringify({ event: "oauth.refresh.invalid_grant" }));
        throw new InvalidGrantError("refresh token is invalid or expired");
      }
      throw err;
    }
  }

  async function verifyAccessToken(token: string) {
    const result = config.shim.verifyAccessToken(token);
    if (!result.valid) {
      console.log(JSON.stringify({ event: "oauth.verify.invalid_token" }));
      throw new InvalidTokenError("access token is invalid or expired");
    }
    return {
      token,
      clientId: "talenox-mcp-client",
      scopes: [config.scope],
      expiresAt: Math.floor(result.expiresAt / 1000),
    };
  }

  return {
    provider: {
      clientsStore,
      authorize,
      challengeForAuthorizationCode,
      exchangeAuthorizationCode,
      exchangeRefreshToken,
      verifyAccessToken,
    },
    callbackHandler,
  };
}
