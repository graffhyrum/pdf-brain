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

test("the running MCP server sends console.log to stderr, keeping stdout pure JSON-RPC", async () => {
  const { mkdtempSync, rmSync } = await import("fs");
  const { tmpdir } = await import("os");
  const libraryPath = mkdtempSync(join(tmpdir(), "pdf-brain-mcp-stdio-"));
  const proc = Bun.spawn(
    [process.execPath, "--preload", join(import.meta.dir, "mcp-stdio-probe.preload.ts"), join(import.meta.dir, "cli.ts"), "mcp"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PDF_LIBRARY_PATH: libraryPath } }
  );
  let stdout = "";
  let stderr = "";
  const pump = async (stream: ReadableStream<Uint8Array>, onText: (t: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) onText(decoder.decode(chunk));
  };
  pump(proc.stdout, (t) => (stdout += t));
  pump(proc.stderr, (t) => (stderr += t));
  const waitFor = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 500 && !check(); i++) await Bun.sleep(10);
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  };
  try {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    await waitFor(() => stdout.includes('"id":1'), "tools/list response");

    proc.kill("SIGUSR2");
    await waitFor(() => (stdout + stderr).includes("probe-line"), "probe line");

    expect(stderr).toContain("probe-line");
    for (const line of stdout.split("\n").filter((l) => l.trim())) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(libraryPath, { recursive: true, force: true });
  }
});
