import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/types/index.js'
import { isSafeCurlWget, stripQuotedContent } from '../lib/types/routing.js'

const storageDir = mkdtempSync(join(tmpdir(), 'dsh-context-mode-smoke-'))
const ctx = new Context()
ctx.logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: message => console.error(String(message)),
  error: message => console.error(String(message)),
}

const fibers = []
try {
  const systemFiber = ctx.plugin(SystemPrompt)
  fibers.push(systemFiber)
  await systemFiber.await()

  const toolsFiber = ctx.plugin(Tools)
  fibers.push(toolsFiber)
  await toolsFiber.await()

  const skillsFiber = ctx.plugin(Skills)
  fibers.push(skillsFiber)
  await skillsFiber.await()

  const bridgeFiber = ctx.plugin(plugin, {
    projectDir: process.cwd(),
    storageDir,
    handshakeTimeoutMs: 10_000,
  })
  fibers.push(bridgeFiber)
  await bridgeFiber.await()

  const tools = ctx.get('tools')
  assert.ok(tools, 'tools service is mounted')
  const names = tools.schemas().map(tool => tool.name)
  assert.ok(names.includes('ctx_execute'), 'ctx_execute is registered')
  assert.ok(names.includes('ctx_search'), 'ctx_search is registered')
  assert.equal(names.filter(name => name.startsWith('ctx_')).length, 11, 'all context-mode tools are registered')

  assert.equal(stripQuotedContent("gh issue list --search 'curl wget'").includes('curl'), false, 'quoted routing text is ignored')
  assert.equal(isSafeCurlWget('curl -s -o /tmp/context-mode.json https://example.com'), true, 'silent file curl remains available')
  assert.equal(isSafeCurlWget('curl https://example.com'), false, 'stdout curl is rejected')

  const unregisterBash = tools.register({
    name: 'bash',
    description: 'smoke-test shell',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => 'executed',
  })
  const blocked = await tools.execute({
    callId: 'dsh-context-mode-routing-smoke',
    name: 'bash',
    arguments: { command: 'curl https://example.com' },
    signal: new AbortController().signal,
  })
  assert.equal(blocked.isError, true, 'unsafe bash routing is blocked')
  unregisterBash()

  const assembly = await ctx.get('systemPrompt').assemble({
    agent: {
      session: {
        snapshotEvents: () => [
          { type: 'user/message', seq: 0, data: { content: 'retain this decision', source: { kind: 'user' } } },
          { type: 'tool/call', seq: 1, data: { name: 'ctx_execute' } },
        ],
      },
    },
  })
  const memory = assembly.contexts.find(context => context.name === 'dsh-context-mode:active-memory')
  assert.ok(memory?.text.includes('retain this decision'), 'active session memory is injected')

  const skills = ctx.get('skills')
  assert.ok(skills, 'skills service is mounted')
  assert.ok((await skills.list()).some(skill => skill.name === 'context-mode'), 'bundled context-mode skill is registered')

  const result = await tools.execute({
    callId: 'dsh-context-mode-smoke',
    name: 'ctx_execute',
    arguments: { language: 'javascript', code: 'console.log(2 + 2)' },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, 'ctx_execute succeeds')
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('4')), 'ctx_execute output reaches DSH')

  await bridgeFiber.dispose()
  assert.equal(tools.get('ctx_execute'), undefined, 'disposing the plugin unregisters its tools')
  assert.equal((await skills.list()).find(skill => skill.name === 'context-mode'), undefined, 'disposing the plugin unregisters its skill')
  console.log('dsh-context-mode smoke passed')
} finally {
  for (const fiber of fibers.reverse()) {
    if (fiber.state !== 4) await fiber.dispose()
  }
  rmSync(storageDir, { recursive: true, force: true })
}
