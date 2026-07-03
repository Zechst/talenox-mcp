import express, { type Express } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTalenoxOAuthProvider } from "./auth/oauth-provider.js";
import { TalenoxGrantShim } from "./auth/talenox-grant-shim.js";
import type { TokenStore } from "./auth/token-store.js";
import { registerAllTools } from "./tools/index.js";
import { TalenoxClient } from "./talenox/client.js";

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
  // Each /mcp request gets its own McpServer + StreamableHTTPServerTransport
  // pair, scoped to that request's authenticated Talenox access token. This
  // stateless-per-request pattern (sessionIdGenerator: undefined) guarantees
  // one user's session can never leak into another's tool call.
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: provider }),
    async (req, res) => {
      const server = new McpServer({ name: "talenox-mcp", version: "0.1.0" });
      // req.auth is attached by requireBearerAuth (installed SDK's
      // bearerAuth.js sets `req.auth = authInfo`); its `.token` is Talenox's
      // real access token, passed through untranslated per Task 7's design.
      const talenox = new TalenoxClient((req as unknown as { auth: { token: string } }).auth.token);
      registerAllTools(server, () => ({ talenox }));

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  return app;
}
