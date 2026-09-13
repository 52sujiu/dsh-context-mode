/**
 * Conversation transcript construction for compaction checkpoints.
 *
 * DSH's shipped checkpoint is a lossy summary: its instruction fixes eight
 * sections, tool output has no section of its own, and the summarizer keeps
 * whatever prose it chose. In practice a compacted span loses most of what was
 * actually said.
 *
 * This module rebuilds the *conversation* from the compacted events instead of
 * asking a model to retell it:
 *
 *   user/message       kept whole — a requirement is a requirement. A very long
 *                      one is clipped head+tail with an archive pointer.
 *   assistant/message  head and tail only; the middle is archived and reachable.
 *   tool/result        never copied. One index line names the tool, its size,
 *                      and the archive source that holds the output.
 *
 * Every clipped or dropped region leaves a pointer naming the `source` to
 * search and the `seq` it came from, so the checkpoint says *which* event lost
 * detail rather than merely that an archive exists.
 *
 * A prior checkpoint is never transcribed: its own text is already in the
 * summary, and copying it forward would make the transcript grow without bound
 * on every compaction.
 *
 * @module dsh-context-mode/transcript
 */
/** Event shapes this module reads. Mirrors the session log. */
export interface TranscriptEventLike {
    readonly type: string;
    readonly seq?: number;
    readonly data?: unknown;
}
/** Head and tail kept for a user message above the clip threshold, in characters. */
export declare const USER_CLIP_AT = 1000;
export declare const USER_CLIP_KEEP = 500;
/** Head and tail kept for every assistant message, in characters. */
export declare const ASSISTANT_KEEP = 200;
/** Upper bound on the whole transcript, so one checkpoint cannot grow without limit. */
export declare const MAX_TRANSCRIPT_CHARS = 400000;
/** One rendered transcript entry. */
export interface TranscriptLine {
    readonly kind: 'user' | 'assistant' | 'tool';
    readonly seq: number;
    readonly text: string;
    /** Characters in the source event before any clipping. */
    readonly sourceChars: number;
}
/** Options controlling how much of each event survives into the transcript. */
export interface TranscriptOptions {
    /** Archive source root, e.g. `session/<id>`. */
    readonly base: string;
    /** Include assistant head/tail entries. Defaults to true. */
    readonly keepAssistant?: boolean;
}
/**
 * Whether an event is a checkpoint written by a previous compaction.
 *
 * Matched on `source` when the event still carries it, and on the checkpoint
 * preamble otherwise: a compacted replacement message is replayed back through
 * this module as an ordinary `user/message`, so the structural marker is not
 * always present by the time the text is read.
 */
export declare function isCheckpointEvent(event: TranscriptEventLike): boolean;
/**
 * Build the transcript for a compacted span.
 *
 * @param events - the compacted events, in session order.
 * @param options - archive root and assistant policy.
 * @returns the rendered lines, oldest first.
 */
export declare function buildTranscript(events: readonly TranscriptEventLike[], options: TranscriptOptions): TranscriptLine[];
/**
 * The archive pointer left where content was clipped.
 *
 * @param total - characters in the source event.
 * @param dropped - characters not carried into the transcript.
 * @param base - archive source root.
 * @param layer - archive layer holding the original.
 * @param seq - the source event's sequence number.
 * @returns the model-facing notice.
 */
export declare function clipNotice(total: string, dropped: string, base: string, layer: string, seq: number): string;
/**
 * Render transcript lines into one text body, stopping at the size bound.
 *
 * The bound is enforced from the end: the newest entries matter most to a
 * resuming model, so an over-long transcript keeps its tail and reports how
 * many older entries were dropped.
 *
 * @param lines - transcript lines in session order.
 * @param maxChars - upper bound on the rendered body.
 * @returns the rendered body.
 */
export declare function renderTranscript(lines: readonly TranscriptLine[], maxChars: number): string;
//# sourceMappingURL=transcript.d.ts.map