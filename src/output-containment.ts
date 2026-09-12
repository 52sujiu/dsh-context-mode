/**
 * Post-execute output containment for DSH.
 *
 * The Bash routing guard stops most context-flooding commands before they run,
 * but a model can still reach one through a path the guard allows, or through
 * another tool entirely. This listener is the second line of defense: when a
 * result is oversized it keeps the head and tail, writes the full text to a
 * spill file, and tells the model how to read it back.
 *
 * The listener is cooperative: it never throws, accepts every result it does
 * not need to change, and only shrinks content larger than the configured cap.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult, PostToolDecision } from '@deepseek-ai/dsh-tools'

/** Default cap before a result is spilled: ~40 KB of model-facing text. */
const DEFAULT_MAX_RESULT_BYTES = 40_000
/** Characters kept from the head of an oversized result. */
const HEAD_CHARS = 6_000
/** Characters kept from the tail of an oversized result. */
const TAIL_CHARS = 2_000
/** Per-listener spill budget; the oldest files are pruned past this count. */
const MAX_SPILL_FILES = 20

export interface OutputContainmentOptions {
  /** Byte budget for one result's model-facing text. */
  readonly maxResultBytes?: number
  /** Directory receiving spilled payloads. */
  readonly spillDir?: string
}

interface SpillRecord {
  readonly path: string
  readonly bytes: number
}

const spilled: SpillRecord[] = []

/**
 * Install the post-execute containment listener.
 *
 * @param ctx - the plugin context whose event bus carries tool dispatch.
 * @param options - optional byte cap and spill directory.
 * @returns the exact disposer that removes the listener.
 */
export function installOutputContainment(
  ctx: Context,
  options: OutputContainmentOptions = {},
): () => void {
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
  const spillDir = options.spillDir ?? join(tmpdir(), 'dsh-context-mode-spill')

  return ctx.on('tools/post-execute', async (
    exec: Readonly<ToolExecution>,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    const content = 'content' in decision && decision.content !== undefined
      ? decision.content
      : result.content
    const text = textFromBlocks(content)
    if (text === undefined || Buffer.byteLength(text, 'utf8') <= maxResultBytes) return decision

    const record = spill(text, spillDir, exec)
    const replacement: ContentBlock[] = [{ type: 'text', text: summarize(text, record, maxResultBytes) }]
    return { kind: 'accept', content: replacement, additionalContexts: decision.additionalContexts }
  })
}

/** Concatenate text blocks, or return undefined when the result is not plain text. */
function textFromBlocks(content: readonly ContentBlock[]): string | undefined {
  const parts: string[] = []
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') return undefined
    parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Persist one oversized payload and return its locator. */
function spill(text: string, spillDir: string, exec: Readonly<ToolExecution>): SpillRecord {
  const path = join(spillDir, `${sanitize(exec.name)}-${Date.now().toString(36)}.txt`)
  const bytes = Buffer.byteLength(text, 'utf8')
  try {
    mkdirSync(spillDir, { recursive: true })
    writeFileSync(path, text, 'utf8')
    spilled.push({ path, bytes })
    while (spilled.length > MAX_SPILL_FILES) spilled.shift()
    return { path, bytes }
  } catch {
    // A missing spill directory must not fail the tool call; the caller gets a
    // truncated result without a locator.
    return { path: '', bytes }
  }
}

/** Build the model-facing replacement: head, tail, and a read-back instruction. */
function summarize(text: string, record: SpillRecord, maxResultBytes: number): string {
  const head = text.slice(0, HEAD_CHARS)
  const tail = text.slice(-TAIL_CHARS)
  const omitted = text.length - head.length - tail.length
  const lines = [
    `[dsh-context-mode] Output was ${record.bytes} bytes (limit ${maxResultBytes}); ${omitted} characters omitted from the middle.`,
  ]
  if (record.path.length > 0) {
    lines.push(`Full output saved to ${record.path}.`)
    lines.push('Read it with ctx_execute_file to analyze it in the sandbox, or ctx_index it and use ctx_search — do not cat it back into the conversation.')
  } else {
    lines.push('Use ctx_execute or ctx_batch_execute next time so the raw output never enters the conversation.')
  }
  lines.push('', '--- head ---', head, '', '--- tail ---', tail)
  return lines.join('\n')
}

/** Keep a tool name safe for a filename. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'tool'
}

/** Test-only: expose recorded spills for assertions. */
export function __spillRecordsForTests(): readonly SpillRecord[] {
  return spilled
}
