import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMCPToolHandlers } from "./mcp-tools.js";
import { AddOptions, PDFLibrary } from "./index.js";
import { AutoTagger, type EnrichmentResult } from "./services/AutoTagger.js";
import { Ollama } from "./services/Ollama.js";
import { PDFExtractor } from "./services/PDFExtractor.js";
import { TaxonomyService } from "./services/TaxonomyService.js";

const dir = mkdtempSync(join(tmpdir(), "pdf-brain-mcp-add-"));
const notePath = join(dir, "note.md");
const noteContent = "# Effect notes\n\nLayers, services, and generators.";
writeFileSync(notePath, noteContent);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let added: { path: string; options: AddOptions }[] = [];
let enrichCalls: { path: string; content: string }[] = [];
let enrichFails = false;

beforeEach(() => {
  added = [];
  enrichCalls = [];
  enrichFails = false;
});

const library = {
  add: (path: string, options: AddOptions) => {
    added.push({ path, options });
    return Effect.succeed({
      id: "doc-1",
      title: options.title ?? "untitled",
      tags: options.tags ?? [],
    });
  },
} as unknown as PDFLibrary;

const tagger = {
  enrich: (path: string, content: string) => {
    enrichCalls.push({ path, content });
    if (enrichFails) return Effect.fail(new Error("LLM unavailable"));
    return Effect.succeed({
      title: "LLM Title",
      summary: "A summary",
      tags: ["llm-tag"],
    } as unknown as EnrichmentResult);
  },
} as unknown as AutoTagger;

const callAdd = (args: Record<string, unknown>) =>
  Effect.runPromise(
    createMCPToolHandlers()["pdf-brain_add"](args).pipe(
      Effect.provideService(PDFLibrary, library),
      Effect.provideService(AutoTagger, tagger),
      Effect.provideService(PDFExtractor, {} as never),
      Effect.provideService(Ollama, {} as never),
      Effect.provideService(TaxonomyService, {} as never)
    )
  );

describe("MCP pdf-brain_add", () => {
  test("enrich: true runs LLM enrichment and stores its title and tags", async () => {
    const result = await callAdd({ path: notePath, tags: ["mine"], enrich: true });

    expect(enrichCalls).toEqual([{ path: notePath, content: noteContent }]);
    expect(added).toHaveLength(1);
    expect(added[0].options.title).toBe("LLM Title");
    expect(added[0].options.tags).toEqual(["mine", "llm-tag"]);
    expect(result.document.title).toBe("LLM Title");
  });

  test("enrich: true keeps a title the caller passed", async () => {
    await callAdd({ path: notePath, title: "My Title", enrich: true });

    expect(enrichCalls).toHaveLength(1);
    expect(added[0].options.title).toBe("My Title");
    expect(added[0].options.tags).toEqual(["llm-tag"]);
  });

  test("without enrich, adds with only the caller's metadata", async () => {
    await callAdd({ path: notePath, title: "My Title", tags: ["mine"] });

    expect(enrichCalls).toHaveLength(0);
    expect(added[0].options.title).toBe("My Title");
    expect(added[0].options.tags).toEqual(["mine"]);
  });

  test("enrich: true still adds with the caller's metadata when enrichment fails", async () => {
    enrichFails = true;
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const result = await callAdd({ path: notePath, title: "My Title", tags: ["mine"], enrich: true });

      expect(enrichCalls).toHaveLength(1);
      expect(added).toHaveLength(1);
      expect(added[0].options.title).toBe("My Title");
      expect(added[0].options.tags).toEqual(["mine"]);
      expect(result.success).toBe(true);
      expect(errors.flat().join(" ")).toContain("LLM unavailable");
    } finally {
      console.error = originalError;
    }
  });

  test("enrich: true on a missing Markdown file skips enrichment and still adds", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const missing = join(dir, "missing.md");
      await callAdd({ path: missing, title: "My Title", enrich: true });

      expect(enrichCalls).toHaveLength(0);
      expect(added).toHaveLength(1);
      expect(added[0].path).toBe(missing);
      expect(added[0].options.title).toBe("My Title");
    } finally {
      console.error = originalError;
    }
  });

  test("without enrich, passes the caller's tags through unchanged, including []", async () => {
    await callAdd({ path: notePath, tags: [] });
    expect(added[0].options.tags).toEqual([]);

    await callAdd({ path: notePath });
    expect(added[1].options.tags).toBeUndefined();
  });
});
