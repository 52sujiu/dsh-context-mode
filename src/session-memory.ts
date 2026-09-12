import type { Context } from '@deepseek-ai/cordis'
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'

interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

interface SessionLike {
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
  summarySeq?: number
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
  const lines: string[] = []
  const summary = [...events].reverse().find(event => event.type === 'compaction/summary')
  if (summary !== undefined && summary.seq !== state.summarySeq) {
    const text = summaryText(summary.data)
    if (text.length > 0) lines.push(`<resume_snapshot>\n${text}\n</resume_snapshot>`)
    state = { ...state, summarySeq: summary.seq }
    states.set(key, state)
  }

  for (const event of events.slice(-MAX_EVENTS)) {
    const line = memoryLine(event)
    if (line !== undefined) lines.push(line)
  }
  if (lines.length === 0) return ''
  let text = lines.join('\n')
  if (text.length > MAX_MEMORY_LENGTH) text = text.slice(text.length - MAX_MEMORY_LENGTH)
  return `<active_memory>\n${text}\n</active_memory>`
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

function summaryText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const summary = (data as { summary?: unknown }).summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map(block => block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : '')
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_MEMORY_LENGTH)
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
