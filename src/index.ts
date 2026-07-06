import { createApp } from "./mcp-server.js";
import { TokenStore } from "./auth/token-store.js";
import { ENCRYPTION_KEY_PATTERN } from "./auth/crypto.js";

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
const talenoxClientId = process.env.TALENOX_CLIENT_ID;
const talenoxClientSecret = process.env.TALENOX_CLIENT_SECRET;
const tokenStorePath = process.env.TOKEN_STORE_PATH ?? "./data/tokens.db";
const encryptionKey = process.env.MCP_ENCRYPTION_KEY;

if (!publicBaseUrl || !talenoxClientId || !talenoxClientSecret) {
  throw new Error(
    "PUBLIC_BASE_URL, TALENOX_CLIENT_ID, and TALENOX_CLIENT_SECRET must be set",
  );
}

if (!encryptionKey || !ENCRYPTION_KEY_PATTERN.test(encryptionKey)) {
  throw new Error(
    "MCP_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes) " +
      "— generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

const store = new TokenStore(tokenStorePath);
const app = createApp({
  publicBaseUrl,
  talenoxClientId,
  talenoxClientSecret,
  scope: "payroll profile",
  store,
});

app.listen(port, () => {
  console.log(`talenox-mcp listening on :${port}`);
});
