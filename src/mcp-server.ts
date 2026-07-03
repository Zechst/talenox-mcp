import express, { type Express } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createTalenoxOAuthProvider } from "./auth/oauth-provider.js";
import { TalenoxGrantShim } from "./auth/talenox-grant-shim.js";
import type { TokenStore } from "./auth/token-store.js";

export type AppConfig = {
  publicBaseUrl: string;
  talenoxClientId: string;
  talenoxClientSecret: string;
  scope: string;
  store: TokenStore;
};

export function createApp(config: AppConfig): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const shim = new TalenoxGrantShim(config.store, {
    clientId: config.talenoxClientId,
    clientSecret: config.talenoxClientSecret,
    redirectUri: `${config.publicBaseUrl}/callback`,
  });

  const { provider, callbackHandler } = createTalenoxOAuthProvider({
    publicBaseUrl: config.publicBaseUrl,
    talenoxClientId: config.talenoxClientId,
    talenoxClientSecret: config.talenoxClientSecret,
    scope: config.scope,
    shim,
  });

  // Talenox's actual redirect target — NOT part of mcpAuthRouter.
  app.get("/callback", callbackHandler);

  app.use(
    mcpAuthRouter({
      // Our provider structurally satisfies OAuthServerProvider (all required
      // methods present; revokeToken is optional). The cast bridges the
      // provider's plain-object shape to the SDK's interface type.
      provider: provider as unknown as OAuthServerProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      scopesSupported: [config.scope],
    }),
  );

  // The installed SDK's requireBearerAuth expects `{ verifier }`
  // (an OAuthTokenVerifier), not `{ provider }` as the plan's example showed.
  // Our provider exposes verifyAccessToken, satisfying that interface.
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: provider }),
    (_req, res) => {
      // Tool dispatch is wired in Task 12 once the MCP transport and tool
      // registry exist. Reaching this point at all proves auth succeeded.
      res.json({ status: "authenticated" });
    },
  );

  return app;
}
