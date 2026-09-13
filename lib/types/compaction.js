import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { MAX_TRANSCRIPT_CHARS, buildTranscript, renderTranscript, } from './transcript.js';
/** Heading of the appended section. Kept short; it costs context on every later request. */
const INDEX_HEADING = '## Archive Index';
/** Upper bound on the appended section, so a checkpoint can never be grown without limit. */
const MAX_INDEX_CHARS = 1_200;
/**
 * A compaction engine that names the session archive in each checkpoint.
 *
 * Constructed by DSH exactly like the shipped engine it extends, so the row
 * that mounts it needs no additional wiring.
 */
export class DshContextModeCompaction extends BasicCompactionEngine {
    /**
     * Surface range of the compaction in flight.
     *
     * `summarize()` receives only the replayed messages, not the sequence
     * numbers behind them, so the range is captured here — at the one seam that
     * knows it — and read back inside `summarize()`. Only two numbers are
     * stashed; the shipped transaction, selection, and validation are untouched.
     */
    #range;
    /** Capture the compacted range for the summarizer, then run the shipped path. */
    async compactRegion(...args) {
        this.#range = { start: args[0], end: args[1] };
        try {
            return await super.compactRegion(...args);
        }
        finally {
            // Cleared unconditionally: a stale range must never label a later summary.
            this.#range = undefined;
        }
    }
    /**
     * Summarize the replayed region, then append the transcript and archive index.
     *
     * The shipped call runs first and unmodified, so prefix-cache alignment,
     * token accounting, and the returned `SummaryResult` envelope are unchanged.
     */
    async summarize(input, agent, signal) {
        const result = await super.summarize(input, agent, signal);
        try {
            const session = agent.session;
            const base = archiveBase(session);
            if (base === undefined)
                return result;
            const appended = buildAppendices(session, this.#range, base);
            if (appended.length === 0)
                return result;
            return { ...result, summary: appendToSummary(result.summary, appended.join('\n\n')) };
        }
        catch {
            // An appendix is an improvement, never a requirement: a failure here must
            // not turn into a failed compaction.
            return result;
        }
    }
}
/** Archive source root for one session, or undefined when it cannot be named. */
function archiveBase(session) {
    const id = session?.id;
    if (typeof id !== 'string' || id.length === 0)
        return undefined;
    return `session/${id}`;
}
/**
 * Build the transcript and index blocks appended below the summary.
 *
 * The compacted events are resolved from the captured range against the
 * session's own surface, so a range that no longer matches yields no
 * transcript rather than a mislabelled one.
 */
function buildAppendices(session, range, base) {
    const blocks = [];
    const events = compactedEvents(session, range);
    if (events.length > 0) {
        const lines = buildTranscript(events, { base });
        const body = renderTranscript(lines, MAX_TRANSCRIPT_CHARS);
        if (body.length > 0)
            blocks.push(`## Conversation Transcript\n\n${body}`);
    }
    const index = buildArchiveIndexFromBase(base);
    if (index.length > 0)
        blocks.push(index);
    return blocks;
}
/** Resolve the compacted events for a captured surface range. */
function compactedEvents(session, range) {
    if (session === undefined)
        return [];
    const eventAt = session.eventAt;
    const nodes = session.surface?.nodes;
    // Without a range or a live surface, fall back to nothing rather than
    // guessing: a transcript of the wrong span is worse than no transcript.
    if (range === undefined || eventAt === undefined || nodes === undefined)
        return [];
    const out = [];
    for (const seq of nodes) {
        if (seq < range.start || seq > range.end)
            continue;
        const event = eventAt.call(session, seq);
        if (event !== undefined)
            out.push(event);
    }
    return out;
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
export function buildArchiveIndex(agent) {
    const base = archiveBase(agent.session);
    return base === undefined ? '' : buildArchiveIndexFromBase(base);
}
/**
 * Build the archive-index block for one archive source root.
 *
 * @param base - archive source root, e.g. `session/<id>`.
 * @returns the markdown block.
 */
export function buildArchiveIndexFromBase(base) {
    const lines = [
        INDEX_HEADING,
        '',
        'The raw transcript of this span was archived to the context-mode knowledge',
        'base before it was condensed, so detail the summary above omits is still',
        'retrievable with `ctx_search`. Scope each query to one layer by `source`:',
        '',
        `- \`source: "${base}/constraint"\` — user messages: requirements, decisions, limits`,
        `- \`source: "${base}/finding"\` — tool results and stated conclusions`,
        `- \`source: "${base}/narrative"\` — assistant reasoning and plans`,
        '',
        'Search for a concrete token you expect in the original (a command, an error',
        'string, a path, an identifier) rather than a paraphrase of the question.',
    ];
    const block = lines.join('\n');
    return block.length <= MAX_INDEX_CHARS ? block : `${block.slice(0, MAX_INDEX_CHARS - 1)}…`;
}
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
export function appendToSummary(summary, index) {
    const blocks = summary.map(block => ({ ...block }));
    for (let position = blocks.length - 1; position >= 0; position -= 1) {
        const block = blocks[position];
        if (block.type !== 'text' || typeof block.text !== 'string')
            continue;
        blocks[position] = { ...block, text: `${block.text}\n\n${index}` };
        return blocks;
    }
    // A summary with no text block at all: add one rather than dropping the index.
    return [...blocks, { type: 'text', text: index }];
}
export default DshContextModeCompaction;
