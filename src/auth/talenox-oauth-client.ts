const TALENOX_AUTHORIZE_URL = "https://app.talenox.com/oauth/authorize";
const TALENOX_TOKEN_URL = "https://app.talenox.com/oauth/token";

export type TalenoxTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
}): string {
  const url = new URL(TALENOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function postTokenRequest(
  params: Record<string, string>,
): Promise<TalenoxTokenResponse> {
  const url = new URL(TALENOX_TOKEN_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { method: "POST" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Talenox token endpoint returned ${response.status}: ${body}`,
    );
  }
  return (await response.json()) as TalenoxTokenResponse;
}

export async function exchangeCodeForTokens(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<TalenoxTokenResponse> {
  return postTokenRequest({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
}

export async function refreshTokens(params: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  accessToken: string;
}): Promise<TalenoxTokenResponse> {
  return postTokenRequest({
    grant_type: "refresh_token",
    code: params.accessToken,
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
}
