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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import {
  MAX_TRANSCRIPT_CHARS,
  buildTranscript,
  renderTranscript,
  type TranscriptEventLike,
} from './transcript.js'

/**
 * The shipped summarization input and result types, derived from the base
 * class rather than restated.
 *
 * The package does not re-export them from its root, and deep-importing its
 * private `lib/types/summarizer.js` path would break on any internal move.
 * Deriving from the method signature keeps this module aligned with whatever
 * the installed version declares, and needs no import of its own.
 */
type SummarizeArgs = Parameters<BasicCompactionEngine['summarize']>
type SummarizedResult = Awaited<ReturnType<BasicCompactionEngine['summarize']>>

/** Heading of the appended section. Kept short; it costs context on every later request. */
const INDEX_HEADING = '## Archive Index'

/** Upper bound on the appended section, so a checkpoint can never be grown without limit. */
const MAX_INDEX_CHARS = 1_200

/** Session-event shapes this module reads. */
interface SessionEventLike {
  readonly type: string
  readonly seq?: number
  readonly data?: unknown
}

interface SessionLike {
  readonly id?: string
  snapshotEvents(): readonly SessionEventLike[]
  /** Current surface node sequence; the compacted span is a slice of it. */
  readonly surface?: { readonly nodes: readonly number[] }
  /** One event by sequence number, or undefined when absent. */
  eventAt?(seq: number): SessionEventLike | undefined
}

interface AgentLike {
  readonly session?: SessionLike
}

/** The inclusive surface range currently being compacted. */
interface CompactRange {
  readonly start: number
  readonly end: number
}

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
  #range: CompactRange | undefined

  /** Capture the compacted range for the summarizer, then run the shipped path. */
  override async compactRegion(
    ...args: Parameters<BasicCompactionEngine['compactRegion']>
  ): ReturnType<BasicCompactionEngine['compactRegion']> {
    this.#range = { start: args[0], end: args[1] }
    try {
      return await super.compactRegion(...args)
    } finally {
      // Cleared unconditionally: a stale range must never label a later summary.
      this.#range = undefined
    }
  }

  /**
   * Summarize the replayed region, then append the transcript and archive index.
   *
   * The shipped call runs first and unmodified, so prefix-cache alignment,
   * token accounting, and the returned `SummaryResult` envelope are unchanged.
   */
  protected override async summarize(
    input: SummarizeArgs[0],
    agent: SummarizeArgs[1],
    signal?: SummarizeArgs[2],
  ): Promise<SummarizedResult> {
    const result = await super.summarize(input, agent, signal)
    try {
      const session = (agent as AgentLike).session
      const base = archiveBase(session)
      if (base === undefined) return result
      const appended = buildAppendices(session, this.#range, base)
      if (appended.length === 0) return result
      return { ...result, summary: appendToSummary(result.summary, appended.join('\n\n')) }
    } catch {
      // An appendix is an improvement, never a requirement: a failure here must
      // not turn into a failed compaction.
      return result
    }
  }
}

/** Archive source root for one session, or undefined when it cannot be named. */
function archiveBase(session: SessionLike | undefined): string | undefined {
  const id = session?.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  return `session/${id}`
}

/**
 * Build the transcript and index blocks appended below the summary.
 *
 * The compacted events are resolved from the captured range against the
 * session's own surface, so a range that no longer matches yields no
 * transcript rather than a mislabelled one.
 */
function buildAppendices(
  session: SessionLike | undefined,
  range: CompactRange | undefined,
  base: string,
): string[] {
  const blocks: string[] = []
  const events = compactedEvents(session, range)
  if (events.length > 0) {
    const lines = buildTranscript(events, { base })
    const body = renderTranscript(lines, MAX_TRANSCRIPT_CHARS)
    if (body.length > 0) blocks.push(`## Conversation Transcript\n\n${body}`)
  }
  const index = buildArchiveIndexFromBase(base)
  if (index.length > 0) blocks.push(index)
  return blocks
}

/** Resolve the compacted events for a captured surface range. */
function compactedEvents(
  session: SessionLike | undefined,
  range: CompactRange | undefined,
): TranscriptEventLike[] {
  if (session === undefined) return []
  const eventAt = session.eventAt
  const nodes = session.surface?.nodes
  // Without a range or a live surface, fall back to nothing rather than
  // guessing: a transcript of the wrong span is worse than no transcript.
  if (range === undefined || eventAt === undefined || nodes === undefined) return []
  const out: TranscriptEventLike[] = []
  for (const seq of nodes) {
    if (seq < range.start || seq > range.end) continue
    const event = eventAt.call(session, seq)
    if (event !== undefined) out.push(event)
  }
  return out
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
export function buildArchiveIndex(agent: AgentLike): string {
  const base = archiveBase(agent.session)
  return base === undefined ? '' : buildArchiveIndexFromBase(base)
}

/**
 * Build the archive-index block for one archive source root.
 *
 * @param base - archive source root, e.g. `session/<id>`.
 * @returns the markdown block.
 */
export function buildArchiveIndexFromBase(base: string): string {
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
  ]
  const block = lines.join('\n')
  return block.length <= MAX_INDEX_CHARS ? block : `${block.slice(0, MAX_INDEX_CHARS - 1)}…`
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
export function appendToSummary(
  summary: readonly ContentBlock[],
  index: string,
): ContentBlock[] {
  const blocks = summary.map(block => ({ ...block }))
  for (let position = blocks.length - 1; position >= 0; position -= 1) {
    const block = blocks[position]
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    blocks[position] = { ...block, text: `${block.text}\n\n${index}` }
    return blocks
  }
  // A summary with no text block at all: add one rather than dropping the index.
  return [...blocks, { type: 'text', text: index }]
}

export default DshContextModeCompaction
