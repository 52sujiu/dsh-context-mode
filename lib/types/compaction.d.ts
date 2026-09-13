/**
 * Compaction backend that appends an archive index to every checkpoint.
 *
 * DSH's shipped backend condenses an older span of the conversation into a
 * summary and lets the raw events fall out of the derived history. The summary
 * is lossy by design: its instruction fixes the sections a checkpoint may
 * carry, and tool output has no section of its own, so a long tool result
 * survives only as whatever the summarizing model chose to keep.
 *
 * This plugin's `precompact` listener files the same span into the
 * context-mode knowledge base first, so the detail still exists and
 * `ctx_search` can reach it. What it cannot do from outside is tell the model
 * that — the checkpoint text is written here, inside the engine, and the
 * shipped engine has no reason to mention a knowledge base it does not know
 * about. That is the gap this subclass closes.
 *
 * Two deliberate choices keep the risk low:
 *
 *   - Only `summarize()` is overridden. Trigger policy, retention, the
 *     bracket-first transaction, token metering, and KV-cache-aligned replay
 *     all stay on the shipped implementation, so this cannot diverge from the
 *     behavior the rest of DSH expects.
 *   - The index is appended to the *returned* summary, never injected into the
 *     summarization instruction. The summarizing model never sees this text,
 *     so the shipped output contract ("keep every section, in order") stays
 *     intact and no model has to be trusted to follow an amended format.
 *
 * Nothing here is allowed to fail a compaction: if the index cannot be built,
 * the superseded summary is returned unchanged.
 *
 * @module dsh-context-mode/compaction
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
/**
 * The shipped summarization input and result types, derived from the base
 * class rather than restated.
 *
 * The package does not re-export them from its root, and deep-importing its
 * private `lib/types/summarizer.js` path would break on any internal move.
 * Deriving from the method signature keeps this module aligned with whatever
 * the installed version declares, and needs no import of its own.
 */
type SummarizeArgs = Parameters<BasicCompactionEngine['summarize']>;
type SummarizedResult = Awaited<ReturnType<BasicCompactionEngine['summarize']>>;
/** Session-event shapes this module reads. */
interface SessionEventLike {
    readonly type: string;
    readonly seq?: number;
    readonly data?: unknown;
}
interface SessionLike {
    readonly id?: string;
    snapshotEvents(): readonly SessionEventLike[];
    /** Current surface node sequence; the compacted span is a slice of it. */
    readonly surface?: {
        readonly nodes: readonly number[];
    };
    /** One event by sequence number, or undefined when absent. */
    eventAt?(seq: number): SessionEventLike | undefined;
}
interface AgentLike {
    readonly session?: SessionLike;
}
/**
 * A compaction engine that names the session archive in each checkpoint.
 *
 * Constructed by DSH exactly like the shipped engine it extends, so the row
 * that mounts it needs no additional wiring.
 */
export declare class DshContextModeCompaction extends BasicCompactionEngine {
    #private;
    /** Capture the compacted range for the summarizer, then run the shipped path. */
    compactRegion(...args: Parameters<BasicCompactionEngine['compactRegion']>): ReturnType<BasicCompactionEngine['compactRegion']>;
    /**
     * Summarize the replayed region, then append the transcript and archive index.
     *
     * The shipped call runs first and unmodified, so prefix-cache alignment,
     * token accounting, and the returned `SummaryResult` envelope are unchanged.
     */
    protected summarize(input: SummarizeArgs[0], agent: SummarizeArgs[1], signal?: SummarizeArgs[2]): Promise<SummarizedResult>;
}
/**
 * Build the archive-index block for one agent's session.
 *
 * The source labels are derivable without waiting on the archiver: the
 * `precompact` listener files each layer under `session/<id>/<layer>`, and the
 * session id is available here. The index therefore states *where* the detail
 * lives rather than claiming anything about what it contains.
 *
 * @param agent - owner of the session being compacted.
 * @returns the markdown block, or an empty string when no session is reachable.
 */
export declare function buildArchiveIndex(agent: AgentLike): string;
/**
 * Build the archive-index block for one archive source root.
 *
 * @param base - archive source root, e.g. `session/<id>`.
 * @returns the markdown block.
 */
export declare function buildArchiveIndexFromBase(base: string): string;
/**
 * Append an index block to the text of a summary.
 *
 * Only text blocks are touched. A summary may also carry non-text blocks, and
 * rewriting or dropping those is the shipped engine's business, not this
 * module's; they are copied through untouched.
 *
 * @param summary - the superseded summary blocks.
 * @param index - the block to append.
 * @returns new blocks with the index appended to the trailing text.
 */
export declare function appendToSummary(summary: readonly ContentBlock[], index: string): ContentBlock[];
export default DshContextModeCompaction;
//# sourceMappingURL=compaction.d.ts.map