/**
 * The MCP server speaks JSON-RPC over stdout, so any stray log line there
 * corrupts the protocol stream. Send console logging to stderr instead.
 * Effect's default Console reads the global console, so it follows too.
 */
export function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}
