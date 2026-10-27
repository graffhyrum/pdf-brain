import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMCPToolHandlers, readEnrichmentContent } from "./mcp-tools.js";
import { AddOptions, PDFLibrary } from "./index.js";
import { AutoTagger, type EnrichmentResult } from "./services/AutoTagger.js";
import { Ollama } from "./services/Ollama.js";
import { PDFExtractor } from "./services/PDFExtractor.js";
import { TaxonomyService } from "./services/TaxonomyService.js";

// `dir` is the library root handed to the handlers; `base` also holds files outside it.
const base = mkdtempSync(join(tmpdir(), "pdf-brain-mcp-add-"));
const dir = join(base, "lib");
mkdirSync(join(dir, "sub"), { recursive: true });
const notePath = join(dir, "note.md");
const noteContent = "# Effect notes\n\nLayers, services, and generators.";
writeFileSync(notePath, noteContent);
afterAll(() => rmSync(base,{ recursive: true, force: true }));

let added: { path: string; options: AddOptions }[] = [];
let enrichCalls: { path: string; content: string }[] = [];
let enrichFails = false;
let enrichDies = false;
let llmTags = ["llm-tag"];
let pdfPages: { text: string }[] | "fail" = "fail";

beforeEach(() => {
  added = [];
  enrichCalls = [];
  enrichFails = false;
  enrichDies = false;
  llmTags = ["llm-tag"];
  pdfPages = "fail";
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
    if (enrichDies) return Effect.die(new Error("provider client crashed"));
    return Effect.succeed({
      title: "LLM Title",
      summary: "A summary",
      tags: llmTags,
    } as unknown as EnrichmentResult);
  },
} as unknown as AutoTagger;

const pdfExtractor = {
  extract: () =>
    pdfPages === "fail"
      ? Effect.fail(new Error("not a PDF"))
      : Effect.succeed({ pageCount: pdfPages.length, pages: pdfPages }),
} as never;

const callAdd = (args: Record<string, unknown>) =>
  Effect.runPromise(
    createMCPToolHandlers({ libraryRoot: dir })["pdf-brain_add"](args).pipe(
      Effect.provideService(PDFLibrary, library),
      Effect.provideService(AutoTagger, tagger),
      Effect.provideService(PDFExtractor, pdfExtractor),
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
    expect(result.enrichment).toBe("applied");
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
      expect(result.enrichment).toBe("failed");
      expect(errors.flat().join(" ")).toContain("LLM unavailable");
    } finally {
      console.error = originalError;
    }
  });

  test("enrich: true expands a leading ~ in a Markdown path", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      await callAdd({ path: "~/note.md", enrich: true });

      expect(enrichCalls).toHaveLength(1);
      expect(enrichCalls[0].content).toBe(noteContent);
      expect(added[0].options.title).toBe("LLM Title");
      expect(added[0].options.tags).toEqual(["llm-tag"]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("enrich: true on a missing Markdown file skips enrichment and still adds", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const missing = join(dir, "missing.md");
      const result = await callAdd({ path: missing, title: "My Title", enrich: true });

      expect(result.enrichment).toBe("skipped");
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

  test("enrich: true ignores a non-array tags value instead of splitting it into characters", async () => {
    await callAdd({ path: notePath, tags: "foo", enrich: true });

    expect(added[0].options.tags).toEqual(["llm-tag"]);
  });

  test("enrich: true on a PDF sends only the first 10 pages", async () => {
    pdfPages = Array.from({ length: 12 }, (_, i) => ({ text: `page ${i}` }));
    const pdfPath = join(dir, "paper.pdf");

    await callAdd({ path: pdfPath, enrich: true });

    const firstTen = pdfPages.slice(0, 10).map((p) => p.text).join("\n\n");
    expect(enrichCalls).toEqual([{ path: pdfPath, content: firstTen }]);
    expect(added[0].options.title).toBe("LLM Title");
  });

  test("enrich: true on a PDF caps the text sent at 8000 characters", async () => {
    pdfPages = Array.from({ length: 3 }, () => ({ text: "x".repeat(5000) }));

    await callAdd({ path: join(dir, "long.pdf"), enrich: true });

    expect(enrichCalls[0].content).toHaveLength(8000);
  });

  test("enrich: true on a PDF whose text extraction fails skips enrichment and still adds", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const result = await callAdd({ path: join(dir, "broken.pdf"), title: "My Title", enrich: true });

      expect(result.enrichment).toBe("skipped");
      expect(enrichCalls).toHaveLength(0);
      expect(added).toHaveLength(1);
      expect(added[0].options.title).toBe("My Title");
    } finally {
      console.error = originalError;
    }
  });

  test("enrich: true does not store a tag twice when the LLM repeats a caller tag", async () => {
    llmTags = ["mine", "llm-tag"];

    await callAdd({ path: notePath, tags: ["mine"], enrich: true });

    expect(added[0].options.tags).toEqual(["mine", "llm-tag"]);
  });

  test("enrich: true still adds with the caller's metadata when enrichment dies with a defect", async () => {
    enrichDies = true;
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const result = await callAdd({ path: notePath, title: "My Title", tags: ["mine"], enrich: true });

      expect(added).toHaveLength(1);
      expect(added[0].options.title).toBe("My Title");
      expect(added[0].options.tags).toEqual(["mine"]);
      expect(result.success).toBe(true);
      expect(result.enrichment).toBe("failed");
      expect(errors.flat().join(" ")).toContain("provider client crashed");
    } finally {
      console.error = originalError;
    }
  });

  test("enrich: true on Markdown caps the text sent at 8000 characters, like PDFs", async () => {
    const longPath = join(dir, "long.md");
    writeFileSync(longPath, "y".repeat(20000));

    await callAdd({ path: longPath, enrich: true });

    expect(enrichCalls[0].content).toHaveLength(8000);
  });

  test("enrich: true on an unsupported extension (.txt) skips enrichment and still adds", async () => {
    const txtPath = join(dir, "note.txt");
    writeFileSync(txtPath, "plain text");

    const result = await callAdd({ path: txtPath, title: "My Title", tags: ["mine"], enrich: true });

    expect(enrichCalls).toHaveLength(0);
    expect(added).toHaveLength(1);
    expect(added[0].path).toBe(txtPath);
    expect(added[0].options.title).toBe("My Title");
    expect(added[0].options.tags).toEqual(["mine"]);
    expect(result.success).toBe(true);
    expect(result.enrichment).toBe("skipped");
  });

  test("enrich: true on a URL skips enrichment and still adds", async () => {
    const result = await callAdd({ path: "https://example.com/paper.pdf", enrich: true });

    expect(result.enrichment).toBe("skipped");
    expect(enrichCalls).toHaveLength(0);
    expect(added).toHaveLength(1);
  });

  test("without enrich, the result has no enrichment field", async () => {
    const result = await callAdd({ path: notePath });

    expect("enrichment" in result).toBe(false);
  });
});

describe("MCP pdf-brain_add enrich is limited to the library", () => {
  const outsidePath = join(base, "outside.md");
  const siblingDir = `${dir}-other`;
  writeFileSync(outsidePath, "# Outside");
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, "x.md"), "# Sibling");
  symlinkSync(outsidePath, join(dir, "escape-link.md"));
  symlinkSync(notePath, join(dir, "inside-link.md"));

  const expectRejected = async (path: string) => {
    const failure = await callAdd({ path, enrich: true }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(
      `enrich is limited to files under the library (${realpathSync(dir)})`
    );
    expect(String(failure)).toContain("Retry without enrich");
    expect(added).toHaveLength(0);
    expect(enrichCalls).toHaveLength(0);
  };

  test("rejects a .. escape", async () => {
    await expectRejected(join(dir, "sub", "..", "..", "outside.md"));
  });

  test("rejects a symlink inside the library that points outside", async () => {
    await expectRejected(join(dir, "escape-link.md"));
  });

  test("rejects a sibling directory that shares the library path as a prefix", async () => {
    await expectRejected(join(siblingDir, "x.md"));
  });

  test("accepts a file inside the library, including through a symlink that stays inside", async () => {
    const direct = await callAdd({ path: notePath, enrich: true });
    const linked = await callAdd({ path: join(dir, "inside-link.md"), enrich: true });

    expect(direct.enrichment).toBe("applied");
    expect(linked.enrichment).toBe("applied");
    expect(added).toHaveLength(2);
  });

  test("does not restrict a call without enrich", async () => {
    const result = await callAdd({ path: outsidePath });

    expect("enrichment" in result).toBe(false);
    expect(added).toHaveLength(1);
  });
});

describe("readEnrichmentContent (shared by MCP add and CLI batch add)", () => {
  test("caps Markdown at 8000 characters", async () => {
    const longPath = join(dir, "batch-long.md");
    writeFileSync(longPath, "z".repeat(20000));

    const content = await Effect.runPromise(
      readEnrichmentContent(longPath).pipe(Effect.provideService(PDFExtractor, pdfExtractor))
    );

    expect(content).toHaveLength(8000);
  });
});
