#!/usr/bin/env node
/**
 * Behaviour checks for the active-memory navigation block.
 *
 * These assertions are deliberately structural. A substring probe such as
 * `text.includes('<resume_snapshot>')` is what let the previous revision ship
 * broken: the delimiter was the first thing trimming removed, so the probe was
 * constant-false and reported "never injected" while injection was happening.
 * Each check below therefore asserts on the SHAPE of the rendered block.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { installSessionMemory } from '../lib/types/session-memory.js'

const SESSION_ID = '51e79124-6370-4406-9680-45575202d630'

const NAV_START = '<resume_snapshot seq='
const NAV_END = '</resume_snapshot>'

/**
 * Minimal Session stand-in exposing the members the module reads.
 *
 * The session object must be STABLE across renders: the module keys its state
 * by session identity, and the production lifecycle installs the context once
 * and reuses it for the whole session. A helper that rebuilt the session (or
 * re-ran `installSessionMemory`) per render would reset that state and mask any
 * bug that depends on it being carried between turns.
 */
function makeSession(id = SESSION_ID) {
  const session = { id, seq: 0, events: [] }
  session.snapshotEvents = () => session.events
  return session
}

/** Install once, returning a function that renders the current session state. */
function makeRenderer(session) {
  let spec
  const prompt = {
    context: s => {
      spec = s
      return () => {}
    },
    getContextOrder: () => 0,
  }
  installSessionMemory({ get: () => prompt })
  return () => spec.text({ agent: { session } })
}

/** Convenience: one session, events assigned, rendered once. */
function render(events) {
  const session = makeSession()
  session.events = events
  session.seq = events.length
  return makeRenderer(session)()
}

const compactionSummary = seq => ({
  type: 'compaction/summary',
  seq,
  data: { summary: [{ text: 'x'.repeat(60_000) }] },
})

const userMessage = (seq, text) => ({
  type: 'user/message',
  seq,
  data: { content: text, source: { kind: 'user' } },
})

const toolCall = (seq, name) => ({ type: 'tool/call', seq, data: { name } })

test('navigation block is emitted with both delimiters intact', () => {
  const text = render([compactionSummary(10), userMessage(11, 'hi')])
  assert.ok(text.includes(NAV_START), `missing opening delimiter:\n${text}`)
  assert.ok(text.includes(NAV_END), `missing closing delimiter:\n${text}`)
})

test('navigation naming a resumable session is rendered exactly once', () => {
  const text = render([compactionSummary(10), userMessage(11, 'hi')])
  const count = text.split(NAV_START).length - 1
  assert.equal(count, 1, `expected one navigation block, got ${count}:\n${text}`)
})

test('navigation survives when recent events exceed the budget', () => {
  // 40 events of ~480 chars each far exceeds MAX_MEMORY_LENGTH (2000).
  const events = [compactionSummary(10)]
  for (let i = 0; i < 40; i += 1) events.push(userMessage(11 + i, 'y'.repeat(480)))
  const text = render(events)
  assert.ok(text.includes(NAV_START), 'navigation was trimmed away under budget pressure')
  assert.ok(text.includes(NAV_END), 'navigation lost its closing delimiter under pressure')
  assert.ok(text.length <= 2_000 + 32, `block exceeded budget: ${text.length} chars`)
})

test('navigation persists across repeated renders without a new compaction', () => {
  const session = makeSession()
  session.events = [compactionSummary(10), userMessage(11, 'hi')]
  session.seq = session.events.length
  const draw = makeRenderer(session)
  const first = draw()
  const second = draw()
  assert.ok(first.includes(NAV_START), `first render lost navigation:\n${first}`)
  assert.ok(second.includes(NAV_START), `second render lost navigation:\n${second}`)
})

test('navigation survives a growing event log across many turns', () => {
  // The real failure mode: every turn appends events and re-renders the whole
  // block from scratch. Production installs the context ONCE per session, so
  // state persists across turns — a guard that pushed the navigation only when
  // its text CHANGED dropped it from every turn after the first.
  const session = makeSession()
  session.events = [compactionSummary(10), userMessage(11, 'start')]
  const draw = makeRenderer(session)
  for (let turn = 0; turn < 12; turn += 1) {
    session.events.push(toolCall(12 + turn * 2, 'ctx_execute'))
    session.events.push(userMessage(13 + turn * 2, `turn ${turn}`))
    session.seq = session.events.length
    const text = draw()
    assert.ok(
      text.includes(NAV_START) && text.includes(NAV_END),
      `navigation vanished on turn ${turn} (log grew to ${session.events.length} events):\n${text}`,
    )
  }
})

test('navigation points at the three archive layers', () => {
  const text = render([compactionSummary(10), userMessage(11, 'hi')])
  for (const layer of ['constraint', 'finding', 'narrative']) {
    assert.ok(
      text.includes(`session/${SESSION_ID}/${layer}`),
      `navigation omits the ${layer} layer:\n${text}`,
    )
  }
})

test('no navigation is emitted without a compaction', () => {
  const text = render([userMessage(1, 'hello'), toolCall(2, 'read')])
  assert.ok(!text.includes(NAV_START), `unexpected navigation:\n${text}`)
})

test('summary body is not inlined', () => {
  const text = render([compactionSummary(10), userMessage(11, 'hi')])
  assert.ok(!text.includes('x'.repeat(100)), 'summary body was inlined instead of referenced')
})

test('routing text uses real newlines, not escaped backslash-n', async () => {
  // `join('\\n')` shipped for several releases because the escape was written
  // as a two-character literal, collapsing five instructions into one line.
  const { ROUTING_TEXT } = await import('../lib/types/index.js')
  assert.ok(ROUTING_TEXT.includes('\n'), 'routing text has no real newline separator')
  assert.ok(!ROUTING_TEXT.includes('\\n'), 'routing text still contains a literal backslash-n')
  assert.ok(ROUTING_TEXT.split('\n').length >= 5, 'routing instructions collapsed onto one line')
})
