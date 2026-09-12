const CONTEXT_NAME = 'dsh-context-mode:active-memory';
const MAX_EVENTS = 50;
const MAX_LINE_LENGTH = 480;
const MAX_MEMORY_LENGTH = 2_000;
/** Register dynamic active-memory context over DSH's durable Session log. */
export function installSessionMemory(ctx) {
    const prompt = ctx.get('systemPrompt', false);
    if (prompt === undefined)
        return () => { };
    const states = new WeakMap();
    return prompt.context({
        name: CONTEXT_NAME,
        order: prompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
        text: rawContext => {
            const context = rawContext;
            return buildMemory(context.agent ?? context.scope, states);
        },
    });
}
function buildMemory(scope, states) {
    const session = sessionFromScope(scope);
    if (session === undefined)
        return '';
    const key = session;
    let state = states.get(key);
    if (state === undefined) {
        state = { session };
        states.set(key, state);
    }
    const events = session.snapshotEvents();
    const currentSeq = typeof session.seq === 'number'
        ? session.seq
        : (events.at(-1)?.seq ?? -1) + 1;
    if (state.rendered !== undefined && state.lastSeq === currentSeq)
        return state.rendered;
    const lines = [];
    const summary = events.findLast(event => event.type === 'compaction/summary');
    if (summary !== undefined && summary.seq !== state.summarySeq) {
        const text = summaryText(summary.data);
        if (text.length > 0)
            lines.push(`<resume_snapshot>\n${text}\n</resume_snapshot>`);
        state = { ...state, summarySeq: summary.seq };
        states.set(key, state);
    }
    for (const event of events.slice(-MAX_EVENTS)) {
        const line = memoryLine(event);
        if (line !== undefined)
            lines.push(line);
    }
    if (lines.length === 0) {
        state = { ...state, lastSeq: currentSeq, rendered: '' };
        states.set(key, state);
        return '';
    }
    let text = lines.join('\n');
    if (text.length > MAX_MEMORY_LENGTH)
        text = text.slice(text.length - MAX_MEMORY_LENGTH);
    const rendered = `<active_memory>\n${text}\n</active_memory>`;
    state = { ...state, lastSeq: currentSeq, rendered };
    states.set(key, state);
    return rendered;
}
function sessionFromScope(scope) {
    if (scope === null || typeof scope !== 'object')
        return undefined;
    const session = scope.session;
    return session !== undefined && typeof session.snapshotEvents === 'function' ? session : undefined;
}
function memoryLine(event) {
    if (event.type === 'user/message') {
        const source = event.data && typeof event.data === 'object'
            ? event.data.source
            : undefined;
        if (source?.kind === 'plugin')
            return undefined;
        const text = extractText(event.data);
        return text.length > 0 ? `user: ${clip(text)}` : undefined;
    }
    if (event.type === 'tool/call') {
        const name = fieldString(event.data, 'name');
        return name === undefined ? undefined : `tool call: ${name}`;
    }
    if (event.type === 'tool/result') {
        const name = fieldString(event.data, 'name');
        const failed = fieldBoolean(event.data, 'isError') === true;
        return name === undefined ? undefined : `tool result${failed ? ' (error)' : ''}: ${name}`;
    }
    if (event.type.startsWith('plan/') || event.type.startsWith('goal/') || event.type.startsWith('todo/')) {
        return `${event.type}: ${clip(JSON.stringify(event.data) ?? '')}`;
    }
    return undefined;
}
function summaryText(data) {
    if (data === null || typeof data !== 'object')
        return '';
    const summary = data.summary;
    if (!Array.isArray(summary))
        return '';
    return summary
        .map(block => block && typeof block === 'object' && typeof block.text === 'string'
        ? block.text
        : '')
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_MEMORY_LENGTH);
}
function extractText(data) {
    if (data === null || typeof data !== 'object')
        return '';
    const content = data.message?.content
        ?? data.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .map(block => block && typeof block === 'object' && typeof block.text === 'string'
        ? block.text
        : '')
        .filter(Boolean)
        .join('\n');
}
function fieldString(data, field) {
    if (data === null || typeof data !== 'object')
        return undefined;
    const value = data[field];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function fieldBoolean(data, field) {
    if (data === null || typeof data !== 'object')
        return undefined;
    const value = data[field];
    return typeof value === 'boolean' ? value : undefined;
}
function clip(value) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= MAX_LINE_LENGTH ? normalized : `${normalized.slice(0, MAX_LINE_LENGTH - 1)}…`;
}
