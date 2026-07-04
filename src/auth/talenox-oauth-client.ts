import { withQueryParams } from "../util/url.js";

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
  const url = withQueryParams(new URL(TALENOX_AUTHORIZE_URL), {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    response_type: "code",
    state: params.state,
  });
  return url.toString();
}

async function postTokenRequest(
  params: Record<string, string>,
): Promise<TalenoxTokenResponse> {
  const url = withQueryParams(new URL(TALENOX_TOKEN_URL), params);
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
