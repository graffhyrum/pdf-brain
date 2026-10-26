import { expect, test } from "bun:test";
import { join } from "path";

const helper = join(import.meta.dir, "mcp-stdio.ts");

test("routeConsoleToStderr keeps console output off stdout, the MCP protocol stream", async () => {
  const script = `
    import { Console, Effect } from "effect";
    import { routeConsoleToStderr } from ${JSON.stringify(helper)};
    routeConsoleToStderr();
    console.log("log line");
    console.info("info line");
    console.debug("debug line");
    console.dir("dir line");
    console.table(["table line"]);
    await Effect.runPromise(Console.log("effect line"));
    process.stdout.write("protocol\\n");
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  expect(stdout).toBe("protocol\n");
  for (const line of ["log line", "info line", "debug line", "dir line", "table line", "effect line"]) {
    expect(stderr).toContain(line);
  }
});
