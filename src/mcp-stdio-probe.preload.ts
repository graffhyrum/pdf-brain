// Test-only preload for mcp-stdio.test.ts: on SIGUSR2, write a console.log
// line from inside the running MCP server process.
process.on("SIGUSR2", () => console.log("probe-line"));
