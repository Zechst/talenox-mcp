// McpServer's internal storage of registered tools is not part of its public
// API and may differ by SDK version — this helper isolates that lookup so it
// only needs adjusting in one place if the installed SDK's internals change.
export function getRegisteredTool(server: unknown, name: string) {
  const registered = getRegisteredTools(server);
  return registered[name];
}

export function getRegisteredTools(server: unknown): Record<string, any> {
  const s = server as { _registeredTools?: Record<string, any>; tools?: Record<string, any> };
  return s._registeredTools ?? s.tools ?? {};
}
