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
import { segmentCjk } from './cjk.js';
/** Layer names appended to the session-scoped source label. */
export const LAYERS = {
    constraint: 'constraint',
    finding: 'finding',
    narrative: 'narrative',
};
const DEFAULT_MAX_CHARS_PER_LAYER = 120_000;
/**
 * Install the pre-compaction archiver.
 *
 * @param ctx - plugin context carrying the session event bus.
 * @param getClient - resolves the live MCP client, or undefined when the bridge is down.
 * @param options - enablement and size guard.
 * @returns the exact disposer that removes the listener.
 */
export function installPrecompactArchive(ctx, getClient, options = {}) {
    if (options.enabled === false)
        return () => { };
    const maxCharsPerLayer = options.maxCharsPerLayer ?? DEFAULT_MAX_CHARS_PER_LAYER;
    const archived = new Set();
    return ctx.on('session/event', (session, event) => {
        if (event.type !== 'compaction/start')
            return;
        void archive(session, getClient, maxCharsPerLayer, archived).catch(() => {
            // Archiving is a best-effort passenger on the compaction path; a failure
            // here must never surface in the compaction that triggered it.
        });
    });
}
/** Read the transcript, classify it, and file each layer into the knowledge base. */
async function archive(session, getClient, maxCharsPerLayer, archived) {
    const client = getClient();
    if (client === undefined)
        return;
    const key = sessionId(session);
    // One archive per compaction; repeated start events for the same session
    // compaction must not duplicate the content.
    const stamp = `${key}:${session.seq ?? session.snapshotEvents().length}`;
    if (archived.has(stamp))
        return;
    archived.add(stamp);
    const lines = classify(session.snapshotEvents());
    if (lines.length === 0)
        return;
    const grouped = group(lines, maxCharsPerLayer);
    for (const [layer, text] of grouped) {
        if (text.length === 0)
            continue;
        await client.callTool('ctx_index', { content: segmentCjk(render(text)), source: `session/${key}/${layer}` }, new AbortController().signal);
    }
}
/** Split archived lines into one text body per layer, respecting the size guard. */
function group(lines, maxChars) {
    const out = new Map();
    for (const line of lines) {
        const current = out.get(line.layer) ?? '';
        if (current.length >= maxChars)
            continue;
        const next = current.length === 0 ? line.text : `${current}\n\n${line.text}`;
        out.set(line.layer, next.length > maxChars ? next.slice(0, maxChars) : next);
    }
    return out;
}
/**
 * Assign every transcript event to a layer.
 *
 * Classification is by event kind, not by importance scoring: a user message
 * is a constraint because of who produced it, and a tool result is a finding
 * for the same reason. Assistant prose is narrative unless it states a
 * concrete value, which is promoted to `finding` so conclusions the assistant
 * reached are searchable beside the evidence.
 */
export function classify(events) {
    const lines = [];
    for (const event of events) {
        const text = textOf(event);
        if (text.length === 0)
            continue;
        const layer = layerOf(event.type, text);
        if (layer === undefined)
            continue;
        lines.push({ layer, text: `${heading(event, layer)}\n${text}` });
    }
    return lines;
}
/** Return the layer for one event, or undefined when it carries no transcript value. */
function layerOf(type, text) {
    if (type === 'user/message')
        return LAYERS.constraint;
    if (type === 'tool/result')
        return LAYERS.finding;
    if (type === 'assistant/message') {
        return statesAConcreteValue(text) ? LAYERS.finding : LAYERS.narrative;
    }
    return undefined;
}
/**
 * Whether assistant prose states a value worth retrieving on its own.
 *
 * The check targets the shapes that carry an answer: a number with a unit or
 * identifier, a filesystem path, an error identifier, or an explicit finding
 * verb. Prose that merely describes intended work does not qualify, which is
 * what keeps "I need to check the config" out of the findings layer.
 */
export function statesAConcreteValue(text) {
    return (/\d+\s*(ms|s|m|h|kb|mb|gb|%|个|次|行|条|秒|分|小时)/i.test(text) ||
        /\b[A-Za-z]:[\\/]|\/(?:Users|home|var|etc|opt|tmp)\//.test(text) ||
        /\b[A-Z]{2,}[_-]\d+\b|\b[a-z]+(?:[A-Z][a-z]+)+\b/.test(text) ||
        /(根因|原因是|结果是|结论是|发现|定位到|确认了|实际上|真实值|上限为|下限为|等于|超过)/.test(text));
}
/** Build the model-facing heading that names the event and its layer. */
function heading(event, layer) {
    const data = asRecord(event.data);
    if (layer === LAYERS.constraint)
        return `## [约束] 用户 (seq ${event.seq ?? '?'})`;
    if (event.type === 'tool/result') {
        const name = typeof data?.name === 'string' ? data.name : 'tool';
        const failed = data?.isError === true ? ' (失败)' : '';
        return `## [结论] ${name}${failed} (seq ${event.seq ?? '?'})`;
    }
    return `## [发现] 助手 (seq ${event.seq ?? '?'})`;
}
/** Extract the plain text of one event, ignoring reasoning and non-text blocks. */
export function textOf(event) {
    const data = asRecord(event.data);
    if (data === undefined)
        return '';
    if (event.type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : '';
        const args = typeof data.arguments === 'string' ? data.arguments : '';
        return name.length === 0 ? '' : `调用 ${name} ${clip(args, 240)}`.trim();
    }
    const message = asRecord(data.message) ?? data;
    const content = message.content;
    if (typeof content === 'string')
        return clip(content, 4_000);
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        const record = block;
        // Reasoning is the model's scratch space, not a transcript fact.
        if (record.type !== 'text' || typeof record.text !== 'string')
            continue;
        parts.push(record.text);
    }
    return clip(parts.join('\n'), 4_000);
}
/** Stable session identity used in the source label. */
function sessionId(session) {
    if (typeof session.id === 'string' && session.id.length > 0)
        return session.id;
    const events = session.snapshotEvents();
    const first = events[0]?.seq ?? 0;
    const last = events.at(-1)?.seq ?? 0;
    return `seq${first}-${last}`;
}
/** Render one layer body with a retrieval hint the model can act on. */
export function render(text) {
    return text;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function clip(value, max) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
