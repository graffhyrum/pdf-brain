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
  // dir and table also write to stdout by default.
  console.dir = (item: unknown, options?: Parameters<typeof Bun.inspect>[1]) =>
    process.stderr.write(`${Bun.inspect(item, options)}\n`);
  console.table = (data: Parameters<typeof Bun.inspect.table>[0]) =>
    process.stderr.write(`${Bun.inspect.table(data)}\n`);
}
