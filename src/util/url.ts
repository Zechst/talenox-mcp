export function withQueryParams(url: URL, params: Record<string, string>): URL {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}
