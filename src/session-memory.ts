import type { Context } from '@deepseek-ai/cordis'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

interface SessionLike {
  readonly seq?: number
  readonly id?: unknown
  snapshotEvents(): readonly SessionEventLike[]
}

interface AgentLike {
  readonly session?: SessionLike
}

interface PromptContextLike {
  readonly agent?: AgentLike
  readonly scope?: unknown
}

interface MemoryState {
  readonly session: SessionLike
  lastSeq?: number
  rendered?: string
}

const CONTEXT_NAME = 'dsh-context-mode:active-memory'
const MAX_EVENTS = 50
const MAX_LINE_LENGTH = 480
const MAX_MEMORY_LENGTH = 2_000

/** Register dynamic active-memory context over DSH's durable Session log. */
export function installSessionMemory(ctx: Context): () => void {
  const prompt = ctx.get('systemPrompt', false) as SystemPrompt | undefined
  if (prompt === undefined) return () => {}
  const states = new WeakMap<object, MemoryState>()
  return prompt.context({
    name: CONTEXT_NAME,
    order: prompt.getContextOrder('SUBAGENT_DELEGATION') + 1,
    text: rawContext => {
      const context = rawContext as PromptContextLike
      return buildMemory(context.agent ?? context.scope, states)
    },
  })
}

function buildMemory(scope: unknown, states: WeakMap<object, MemoryState>): string {
  const session = sessionFromScope(scope)
  if (session === undefined) return ''
  const key = session as object
  let state = states.get(key)
  if (state === undefined) {
    state = { session }
    states.set(key, state)
  }

  const events = session.snapshotEvents()
  const currentSeq = typeof session.seq === 'number'
    ? session.seq
    : (events.at(-1)?.seq ?? -1) + 1
  if (state.rendered !== undefined && state.lastSeq === currentSeq) return state.rendered

  const lines: string[] = []
  const summary = events.findLast(event => event.type === 'compaction/summary')
  const navigation = summary === undefined ? undefined : navigationText(session, summary)
  if (navigation !== undefined) lines.push(navigation)

  for (const event of events.slice(-MAX_EVENTS)) {
    const line = memoryLine(event)
    if (line !== undefined) lines.push(line)
  }
  if (lines.length === 0) {
    state = { ...state, lastSeq: currentSeq, rendered: '' }
    states.set(key, state)
    return ''
  }
  const rendered = wrap(fitLines(lines))
  state = { ...state, lastSeq: currentSeq, rendered }
  states.set(key, state)
  return rendered
}

/** Tag overhead of the surrounding `<active_memory>` envelope, in characters. */
const ENVELOPE_OVERHEAD = '<active_memory>\n\n</active_memory>'.length

function wrap(body: string): string {
  return `<active_memory>\n${body}\n</active_memory>`
}

/**
 * Join the memory lines under the budget, counting the envelope.
 *
 * The navigation block is a fixed-size pointer, not conversation content, so it
 * is never truncated: it stays intact and the recent-event lines below it
 * absorb the trimming instead. Trimming keeps the newest events (the tail),
 * which is what a running record is for.
 */
function fitLines(lines: readonly string[]): string {
  const text = lines.join('\n')
  const budget = MAX_MEMORY_LENGTH - ENVELOPE_OVERHEAD
  if (text.length <= budget) return text
  const [head, ...rest] = lines
  const remaining = budget - head.length - 1
  if (remaining <= 0) return head
  const body = rest.join('\n')
  return `${head}\n${body.slice(body.length - remaining)}`
}

function sessionFromScope(scope: unknown): SessionLike | undefined {
  if (scope === null || typeof scope !== 'object') return undefined
  const session = (scope as AgentLike).session
  return session !== undefined && typeof session.snapshotEvents === 'function' ? session : undefined
}

function memoryLine(event: SessionEventLike): string | undefined {
  if (event.type === 'user/message') {
    const source = event.data && typeof event.data === 'object'
      ? (event.data as { source?: { kind?: string; plugin?: string } }).source
      : undefined
    if (source?.kind === 'plugin') return undefined
    const text = extractText(event.data)
    return text.length > 0 ? `user: ${clip(text)}` : undefined
  }
  if (event.type === 'tool/call') {
    const name = fieldString(event.data, 'name')
    return name === undefined ? undefined : `tool call: ${name}`
  }
  if (event.type === 'tool/result') {
    const name = fieldString(event.data, 'name')
    const failed = fieldBoolean(event.data, 'isError') === true
    return name === undefined ? undefined : `tool result${failed ? ' (error)' : ''}: ${name}`
  }
  if (event.type.startsWith('plan/') || event.type.startsWith('goal/') || event.type.startsWith('todo/')) {
    return `${event.type}: ${clip(JSON.stringify(event.data) ?? '')}`
  }
  return undefined
}

/**
 * Build the pointer that tells the model a compaction happened and where the
 * archived detail lives.
 *
 * The summary body is NOT inlined. A full summary runs to tens of thousands of
 * characters, far past this context's budget, so inlining it can only ever
 * deliver a truncated fragment with its own delimiters clipped off. The archive
 * already holds the complete text under stable `source` labels; the useful
 * thing to inject is the address, which stays small enough to never be cut.
 */
function navigationText(session: SessionLike, summary: SessionEventLike): string | undefined {
  const id = session.id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const root = `session/${id}`
  return [
    `<resume_snapshot seq="${summary.seq}">`,
    'Compacted turns are archived; nothing is inlined here. Retrieve on demand, scoping ctx_search by source:',
    `  ${root}/constraint  user requirements and decisions`,
    `  ${root}/finding     tool results and stated conclusions`,
    `  ${root}/narrative   assistant reasoning and plans`,
    'Query a concrete token (a path, a command, an error string), not a paraphrase.',
    '</resume_snapshot>',
  ].join('\n')
}

function extractText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const content = (data as { message?: { content?: unknown }; content?: unknown }).message?.content
    ?? (data as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : '')
    .filter(Boolean)
    .join('\n')
}

function fieldString(data: unknown, field: string): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const value = (data as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function fieldBoolean(data: unknown, field: string): boolean | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const value = (data as Record<string, unknown>)[field]
  return typeof value === 'boolean' ? value : undefined
}

function clip(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= MAX_LINE_LENGTH ? normalized : `${normalized.slice(0, MAX_LINE_LENGTH - 1)}…`
}
