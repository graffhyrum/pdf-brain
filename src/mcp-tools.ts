/**
 * MCP tool handlers and the enrichment step they share with the CLI `add`.
 * Kept out of cli.ts so tests can import them without running the CLI entry.
 */
import { Effect } from "effect";
import { extname } from "path";
import { AddOptions, PDFLibrary, SearchOptions } from "./index.js";
import { AutoTagger, type EnrichmentResult } from "./services/AutoTagger.js";
import { Ollama } from "./services/Ollama.js";
import { PDFExtractor } from "./services/PDFExtractor.js";
import { TaxonomyService, type Concept } from "./services/TaxonomyService.js";

/** Title and tags for `add`, merged with what LLM enrichment found. */
interface EnrichedAddMetadata {
  readonly title: string | undefined;
  readonly tags: string[];
  /** Absent when the file had no readable content to enrich. */
  readonly result?: EnrichmentResult;
}

/**
 * Run LLM enrichment on a local PDF or Markdown file before it is added.
 * A title the caller passed wins over the LLM's; LLM tags are appended.
 * The enrichment pipeline logs progress with console.log; the MCP server
 * routes that to stderr (see routeConsoleToStderr) before calling this.
 */
export const enrichAddMetadata = (
  localPath: string,
  input: {
    readonly title?: string;
    readonly tags: readonly string[];
    readonly provider?: "ollama" | "anthropic";
  }
) =>
  Effect.gen(function* () {
    const content = yield* readEnrichmentContent(localPath);
    if (!content) {
      const unenriched: EnrichedAddMetadata = {
        title: input.title,
        tags: [...input.tags],
      };
      return unenriched;
    }
    const tagger = yield* AutoTagger;
    const result = yield* tagger.enrich(localPath, content, {
      provider: input.provider,
    });
    const enriched: EnrichedAddMetadata = {
      title: input.title || result.title,
      tags: [...input.tags, ...result.tags],
      result,
    };
    return enriched;
  });

/** Text to enrich from: the first 10 pages of a PDF (max 8000 chars) or a whole Markdown file. */
const readEnrichmentContent = (localPath: string) =>
  Effect.gen(function* () {
    const ext = extname(localPath).toLowerCase();
    if (ext === ".pdf") {
      const pdfExtractor = yield* PDFExtractor;
      const extractResult = yield* Effect.either(
        pdfExtractor.extract(localPath)
      );
      if (extractResult._tag === "Left") {
        console.error(
          `[enrich] Skipping enrichment, PDF text extraction failed: ${extractResult.left}`
        );
        return undefined;
      }
      const pages = extractResult.right.pages.slice(0, 10);
      return pages.map((p) => p.text).join("\n\n").slice(0, 8000);
    }
    if (ext === ".md" || ext === ".markdown") {
      // tryPromise, not promise: a missing file must be a recoverable failure, not a defect.
      const readResult = yield* Effect.either(
        Effect.tryPromise(() => Bun.file(localPath).text())
      );
      if (readResult._tag === "Left") {
        console.error(
          `[enrich] Skipping enrichment, could not read ${localPath}: ${readResult.left}`
        );
        return undefined;
      }
      return readResult.right;
    }
    return undefined;
  });

/** Services the MCP tool handlers read from the Effect environment. */
export type MCPToolServices =
  | PDFLibrary
  | Ollama
  | TaxonomyService
  | AutoTagger
  | PDFExtractor;

/** Build the handler for each MCP tool, keyed by tool name. */
export const createMCPToolHandlers = () => {
  const toolHandlers: Record<string, (args: any) => Effect.Effect<any, any, MCPToolServices>> = {
    "pdf-brain_add": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const callerMetadata = { title: args.title, tags: args.tags ?? [] };
        const metadata =
          args.enrich === true
            ? yield* enrichAddMetadata(args.path, callerMetadata).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    // Best effort: a failed LLM call must not stop the add.
                    console.error(
                      `[pdf-brain_add] Enrichment failed, adding with caller metadata: ${error instanceof Error ? error.message : String(error)}`
                    );
                    return callerMetadata;
                  })
                )
              )
            : callerMetadata;
        const doc = yield* library.add(
          args.path,
          new AddOptions({
            title: metadata.title,
            // Fall back to args.tags, not undefined, so a caller's [] still reaches AddOptions as [].
            tags: metadata.tags.length > 0 ? metadata.tags : args.tags,
          })
        );
        return { success: true, document: { id: doc.id, title: doc.title, tags: doc.tags } };
      }),
    "pdf-brain_search": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const ollama = yield* Ollama;
        const taxonomy = yield* TaxonomyService;

        const conceptsOnly = args.conceptsOnly === true;
        const docsOnly = args.docsOnly === true;

        // Determine what to search (matching CLI logic at lines 1086-1087)
        // If both flags are true, both search flags are false (search neither)
        const searchDocs = !conceptsOnly;
        const searchConcepts = !docsOnly;

        // Handle conflicting flags: if both are true, search neither (empty results)
        if (!searchDocs && !searchConcepts) {
          return { 
            success: true, 
            type: "empty", 
            documents: [],
            concepts: []
          };
        }

        // Search concepts (if enabled)
        const conceptResults = searchConcepts
          ? yield* Effect.gen(function* () {
              const queryEmbedding = yield* ollama.embed(args.query);
              return yield* taxonomy.findSimilarConcepts(queryEmbedding, 0.3, args.limit || 10);
            }).pipe(Effect.catchAll(() => Effect.succeed([] as Concept[])))
          : [];

        // Search documents (if enabled)
        const docResults = searchDocs
          ? yield* library.search(args.query, new SearchOptions({ limit: args.limit || 10 }))
          : [];

        // Return appropriate response format based on what was searched
        if (searchConcepts && !searchDocs) {
          return { success: true, type: "concepts", results: conceptResults };
        } else if (searchDocs && !searchConcepts) {
          return { success: true, type: "documents", results: docResults };
        } else {
          // Both searched (default case)
          return { 
            success: true, 
            type: "unified", 
            documents: docResults,
            concepts: conceptResults
          };
        }
      }),
    "pdf-brain_list": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const docs = yield* library.list(args.tag);
        return { success: true, documents: docs.map(d => ({ id: d.id, title: d.title, tags: d.tags })) };
      }),
    "pdf-brain_read": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const doc = yield* library.get(args.id);
        if (!doc) {
          return yield* Effect.fail(new Error("Document not found"));
        }
        return { success: true, document: { id: doc.id, title: doc.title, path: doc.path, tags: doc.tags, pageCount: doc.pageCount, sizeBytes: doc.sizeBytes, addedAt: doc.addedAt } };
      }),
    "pdf-brain_remove": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const doc = yield* library.remove(args.id);
        return { success: true, removed: { id: doc.id, title: doc.title } };
      }),
    "pdf-brain_tag": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const doc = yield* library.tag(args.id, args.tags);
        return { success: true, document: { id: doc.id, title: doc.title, tags: doc.tags } };
      }),
    "pdf-brain_stats": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        const stats = yield* library.stats();
        return { success: true, stats };
      }),
    "pdf-brain_taxonomy_list": (args) =>
      Effect.gen(function* () {
        const taxonomy = yield* TaxonomyService;
        const concepts = yield* taxonomy.listConcepts();
        return { success: true, concepts: concepts.map(c => ({ id: c.id, prefLabel: c.prefLabel, definition: c.definition })) };
      }),
    "pdf-brain_taxonomy_search": (args) =>
      Effect.gen(function* () {
        const taxonomy = yield* TaxonomyService;
        const concepts = yield* taxonomy.listConcepts();
        const queryLower = args.query.toLowerCase();
        const results = concepts.filter(c =>
          c.prefLabel.toLowerCase().includes(queryLower) ||
          c.altLabels.some(alt => alt.toLowerCase().includes(queryLower)) ||
          (c.definition && c.definition.toLowerCase().includes(queryLower))
        );
        return { success: true, concepts: results.map(c => ({ id: c.id, prefLabel: c.prefLabel, definition: c.definition })) };
      }),
    "pdf-brain_check": (args) =>
      Effect.gen(function* () {
        const library = yield* PDFLibrary;
        yield* library.checkReady();
        return { success: true, message: "Ollama is ready" };
      }),
  };
  return toolHandlers;
};
