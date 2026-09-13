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
/** Layer names used in the archive source label. Mirrors `precompact`'s LAYERS. */
const LAYER_CONSTRAINT = 'constraint';
const LAYER_FINDING = 'finding';
/** Head and tail kept for a user message above the clip threshold, in characters. */
export const USER_CLIP_AT = 1_000;
export const USER_CLIP_KEEP = 500;
/** Head and tail kept for every assistant message, in characters. */
export const ASSISTANT_KEEP = 200;
/** Assistant messages shorter than this are kept whole rather than split. */
const ASSISTANT_MIN_SPLIT = ASSISTANT_KEEP * 2;
/** Upper bound on the whole transcript, so one checkpoint cannot grow without limit. */
export const MAX_TRANSCRIPT_CHARS = 400_000;
/** The tag the shipped engine uses; its presence marks a prior checkpoint. */
const CHECKPOINT_MARKER = 'This is an automatically generated checkpoint';
/**
 * Whether an event is a checkpoint written by a previous compaction.
 *
 * Matched on `source` when the event still carries it, and on the checkpoint
 * preamble otherwise: a compacted replacement message is replayed back through
 * this module as an ordinary `user/message`, so the structural marker is not
 * always present by the time the text is read.
 */
export function isCheckpointEvent(event) {
    const source = sourceOf(event);
    if (source !== undefined && source.kind === 'plugin' && source.plugin === 'compact')
        return true;
    return messageText(event).includes(CHECKPOINT_MARKER);
}
/**
 * Build the transcript for a compacted span.
 *
 * @param events - the compacted events, in session order.
 * @param options - archive root and assistant policy.
 * @returns the rendered lines, oldest first.
 */
export function buildTranscript(events, options) {
    const names = toolNames(events);
    const lines = [];
    for (const event of events) {
        const line = transcriptLine(event, options, names);
        if (line !== undefined)
            lines.push(line);
    }
    return lines;
}
/**
 * Map each tool-call id to its tool name.
 *
 * A tool call is not a surface event of its own: it is a `tool-call` content
 * block inside an `assistant/message`, which is why the compacted span holds
 * no `tool/call` events at all. The result answers it by id, so the pairing is
 * collected from assistant blocks up front and looked up while rendering.
 */
function toolNames(events) {
    const names = new Map();
    for (const event of events) {
        if (event.type !== 'assistant/message')
            continue;
        const data = asRecord(event.data);
        const message = asRecord(data?.message) ?? data;
        const content = message?.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block === null || typeof block !== 'object')
                continue;
            const record = block;
            if (record.type !== 'tool-call')
                continue;
            // An assistant tool-call block carries `id`; its paired result carries
            // the same value as `toolCallId`, so both spellings are accepted.
            const id = typeof record.id === 'string'
                ? record.id
                : typeof record.toolCallId === 'string' ? record.toolCallId : undefined;
            if (id === undefined)
                continue;
            const name = typeof record.name === 'string' ? record.name : undefined;
            if (name !== undefined && name.length > 0)
                names.set(id, name);
        }
    }
    return names;
}
/** Render one event into a transcript line, or undefined when it contributes nothing. */
function transcriptLine(event, options, names) {
    const seq = typeof event.seq === 'number' ? event.seq : -1;
    if (event.type === 'tool/result')
        return toolLine(event, seq, options, names);
    // A prior checkpoint carries the previous summary; transcribing it would
    // duplicate the current summary and grow without bound across compactions.
    if (event.type === 'user/message') {
        if (isCheckpointEvent(event))
            return undefined;
        if (isInjected(event))
            return undefined;
        return userLine(event, seq, options);
    }
    if (event.type === 'assistant/message') {
        if (options.keepAssistant === false)
            return undefined;
        return assistantLine(event, seq, options);
    }
    return undefined;
}
/** A user message is kept whole unless it is long, then clipped head and tail. */
function userLine(event, seq, options) {
    const text = messageText(event).replace(/\s+/g, ' ').trim();
    if (text.length === 0)
        return undefined;
    const source = `session/<id>/${LAYER_CONSTRAINT}`;
    if (text.length <= USER_CLIP_AT) {
        return { kind: 'user', seq, text: `## [user ${seq}]\n${text}`, sourceChars: text.length };
    }
    const head = text.slice(0, USER_CLIP_KEEP);
    const tail = text.slice(-USER_CLIP_KEEP);
    const dropped = text.length - head.length - tail.length;
    return {
        kind: 'user',
        seq,
        sourceChars: text.length,
        text: [
            `## [user ${seq}]`,
            head,
            clipNotice(`${text.length}`, `${dropped}`, options.base, LAYER_CONSTRAINT, seq),
            tail,
        ].join('\n'),
    };
}
/** An assistant message keeps its head and tail; the middle stays in the archive. */
function assistantLine(event, seq, options) {
    const text = messageText(event).replace(/\s+/g, ' ').trim();
    if (text.length === 0)
        return undefined;
    if (text.length <= ASSISTANT_MIN_SPLIT) {
        return { kind: 'assistant', seq, text: `## [assistant ${seq}]\n${text}`, sourceChars: text.length };
    }
    const head = text.slice(0, ASSISTANT_KEEP);
    const tail = text.slice(-ASSISTANT_KEEP);
    const dropped = text.length - head.length - tail.length;
    return {
        kind: 'assistant',
        seq,
        sourceChars: text.length,
        text: [
            `## [assistant ${seq}]`,
            head,
            clipNotice(`${text.length}`, `${dropped}`, options.base, LAYER_FINDING, seq),
            tail,
        ].join('\n'),
    };
}
/** Tool output is never copied: one line names the call and where its output lives. */
function toolLine(event, seq, options, names) {
    const data = asRecord(event.data);
    const message = asRecord(data?.message) ?? data;
    const callId = firstCallId(message?.content);
    const name = toolNameFor(data, callId, names);
    const chars = messageText(event).length;
    return {
        kind: 'tool',
        seq,
        sourceChars: chars,
        text: `## [tool ${name} seq ${seq}, ${chars} chars \u2192 search \`${options.base}/${LAYER_FINDING}\`]`,
    };
}
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
export function clipNotice(total, dropped, base, layer, seq) {
    return (`[... ${dropped} of ${total} chars elided from seq ${seq}; ` +
        `retrieve with ctx_search(source: "${base}/${layer}") ...]`);
}
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
export function renderTranscript(lines, maxChars) {
    const rendered = lines.map(line => line.text);
    let total = rendered.reduce((sum, text) => sum + text.length + 2, 0);
    if (total <= maxChars)
        return rendered.join('\n\n');
    // Drop from the oldest until the body fits, then say how many were dropped.
    let first = 0;
    while (first < rendered.length && total > maxChars) {
        total -= rendered[first].length + 2;
        first += 1;
    }
    const droppedCount = first;
    const notice = `[... ${droppedCount} older transcript entries elided; the archived span is searchable via the archive index below ...]`;
    return [notice, ...rendered.slice(first)].join('\n\n');
}
/** Text of a message-shaped event, reading nested tool-result content too. */
function messageText(event) {
    const data = asRecord(event.data);
    if (data === undefined)
        return '';
    if (event.type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : '';
        const args = typeof data.arguments === 'string' ? data.arguments : '';
        return name.length === 0 ? '' : `${name} ${args}`.trim();
    }
    const message = asRecord(data.message) ?? data;
    return blocksToText(message?.content);
}
/** Flatten a content value (string, block array, or tool-result envelope) to text. */
function blocksToText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string') {
            parts.push(record.text);
            continue;
        }
        // tool/result wraps its payload one level down.
        if (Array.isArray(record.content)) {
            const inner = blocksToText(record.content);
            if (inner.length > 0)
                parts.push(inner);
        }
    }
    return parts.join('\n');
}
/** First tool-call id found in a tool-result content value. */
function firstCallId(content) {
    if (!Array.isArray(content))
        return undefined;
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        if (typeof record.toolCallId === 'string')
            return record.toolCallId;
    }
    return undefined;
}
/** The tool name a result belongs to, resolved from its paired call. */
function toolNameFor(data, callId, names) {
    if (data !== undefined && typeof data.name === 'string' && data.name.length > 0)
        return data.name;
    if (callId === undefined)
        return 'tool';
    const paired = names.get(callId);
    if (paired !== undefined)
        return paired;
    // The call may sit outside the compacted span; name the result by its leading
    // id segment rather than silently labelling every such line "tool".
    const head = callId.split('|')[0];
    return head.length > 0 ? head : 'tool';
}
/** Whether a user message is harness-injected context rather than a real turn. */
function isInjected(event) {
    const text = messageText(event).trimStart();
    return (text.startsWith('<current_runtime_context') ||
        text.startsWith('<active_memory') ||
        text.startsWith('<system-reminder') ||
        text.startsWith('<resume_snapshot') ||
        text.startsWith('Current runtime context') ||
        text.startsWith('The available skill catalog changed'));
}
/** The `source` record of a message-shaped event, when present. */
function sourceOf(event) {
    const data = asRecord(event.data);
    if (data === undefined)
        return undefined;
    const message = asRecord(data.message);
    const source = asRecord(message?.source) ?? asRecord(data.source);
    if (source === undefined)
        return undefined;
    return {
        kind: typeof source.kind === 'string' ? source.kind : undefined,
        plugin: typeof source.plugin === 'string' ? source.plugin : undefined,
    };
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
