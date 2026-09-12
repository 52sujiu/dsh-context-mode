/**
 * Pre-compaction transcript archiving for DSH.
 *
 * Compaction replaces the live conversation with a generated summary and
 * prunes the events behind it, so anything the summary omits is gone from the
 * model's reach. This listener captures the transcript as compaction begins
 * and files it into the context-mode knowledge base, where `ctx_search` can
 * retrieve it afterwards.
 *
 * Storage is LAYERED rather than filtered. Every event is archived; the layers
 * differ only in the `source` label they carry, so a caller chooses precision
 * at query time:
 *
 *   session/<id>/constraint   user messages — requirements, decisions, limits
 *   session/<id>/finding      tool results — commands run and what they showed
 *   session/<id>/narrative    assistant prose — reasoning, plans, restatement
 *
 * Nothing is dropped at write time. A message the classifier files as
 * narrative is still present, so a misclassification costs a query's
 * precision rather than the content itself. That is the property a filter
 * would not have.
 *
 * The listener is a best-effort passenger on the compaction path: it never
 * throws, never blocks, and can be disabled by configuration.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { McpStdioClient } from './mcp-client.js';
/** Layer names appended to the session-scoped source label. */
export declare const LAYERS: {
    readonly constraint: "constraint";
    readonly finding: "finding";
    readonly narrative: "narrative";
};
export type LayerName = (typeof LAYERS)[keyof typeof LAYERS];
/** Configuration for the pre-compaction archiver. */
export interface PrecompactOptions {
    /** Whether to archive at all. */
    readonly enabled?: boolean;
    /** Maximum characters archived per layer, guarding against a huge transcript. */
    readonly maxCharsPerLayer?: number;
}
interface SessionEventLike {
    readonly type: string;
    readonly seq?: number;
    readonly data?: unknown;
}
/** One archived line: the event it came from and the layer it belongs to. */
interface ArchivedLine {
    readonly layer: LayerName;
    readonly text: string;
}
/**
 * Install the pre-compaction archiver.
 *
 * The listener buffers every session event as it arrives and flushes the
 * buffer when compaction begins. Buffering rather than reading the transcript
 * at compaction time matters: `compaction/prune` drops the events behind the
 * summary, and it may run before an asynchronous archive reads them. A flush
 * from our own buffer cannot race that prune.
 *
 * @param ctx - plugin context carrying the session event bus.
 * @param getClient - resolves the live MCP client, or undefined when the bridge is down.
 * @param options - enablement and size guard.
 * @returns the exact disposer that removes the listener.
 */
export declare function installPrecompactArchive(ctx: Context, getClient: () => McpStdioClient | undefined, options?: PrecompactOptions): () => void;
/**
 * Assign every transcript event to a layer.
 *
 * Classification is by event kind, not by importance scoring: a user message
 * is a constraint because of who produced it, and a tool result is a finding
 * for the same reason. Assistant prose is narrative unless it states a
 * concrete value, which is promoted to `finding` so conclusions the assistant
 * reached are searchable beside the evidence.
 */
export declare function classify(events: readonly SessionEventLike[]): ArchivedLine[];
/**
 * Whether assistant prose states a value worth retrieving on its own.
 *
 * The check targets the shapes that carry an answer: a number with a unit or
 * identifier, a filesystem path, an error identifier, or an explicit finding
 * verb. Prose that merely describes intended work does not qualify, which is
 * what keeps "I need to check the config" out of the findings layer.
 */
export declare function statesAConcreteValue(text: string): boolean;
/** Extract the plain text of one event, ignoring reasoning and non-text blocks. */
export declare function textOf(event: SessionEventLike): string;
/** Render one layer body with a retrieval hint the model can act on. */
export declare function render(text: string): string;
/** Re-exported for assertions: the content block shape this module reads. */
export type ArchivedBlock = ContentBlock;
export {};
//# sourceMappingURL=precompact.d.ts.map