import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/types/index.js'

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
