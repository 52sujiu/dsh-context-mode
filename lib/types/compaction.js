import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
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
     * Summarize the replayed region, then append the archive index.
     *
     * The index is appended after `super.summarize()` resolves, so the shipped
     * call — and therefore prefix-cache alignment, token accounting, and the
     * returned `SummaryResult` envelope — are unchanged.
     */
    async summarize(input, agent, signal) {
        const result = await super.summarize(input, agent, signal);
        try {
            const index = buildArchiveIndex(agent);
            if (index.length === 0)
                return result;
            return { ...result, summary: appendToSummary(result.summary, index) };
        }
        catch {
            // An index is an improvement, never a requirement: a failure here must
            // not turn into a failed compaction.
            return result;
        }
    }
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
    const session = agent.session;
    if (session === undefined)
        return '';
    const id = session.id;
    if (typeof id !== 'string' || id.length === 0)
        return '';
    const base = `session/${id}`;
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
