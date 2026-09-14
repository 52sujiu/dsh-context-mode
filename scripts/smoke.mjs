import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/types/index.js'
import { __spillRecordsForTests, installOutputContainment } from '../lib/types/output-containment.js'
import { classify, installPrecompactArchive, isInjectedContext, statesAConcreteValue } from '../lib/types/precompact.js'
import { isFloodingSegment, isSafeCurlWget, stripQuotedContent } from '../lib/types/routing.js'

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
  const schemas = tools.schemas()
  const executeSchema = schemas.find(tool => tool.name === 'ctx_execute')
  assert.ok(
    executeSchema?.description?.includes('command output'),
    'ctx_execute description carries DSH routing guidance',
  )
  const batchSchema = schemas.find(tool => tool.name === 'ctx_batch_execute')
  assert.ok(
    batchSchema?.description?.includes('three or more independent commands'),
    'ctx_batch_execute description steers concurrent batch use',
  )
  const registeredSkills = ctx.get('skills')
  const skillNames = (await registeredSkills.list()).map(skill => skill.name)
  assert.deepEqual(
    skillNames.filter(name => name === 'context-mode' || name.startsWith('ctx-')).sort(),
    ['context-mode', 'ctx-doctor', 'ctx-index', 'ctx-insight', 'ctx-purge', 'ctx-search', 'ctx-stats', 'ctx-upgrade'],
    'all context-mode user-invocable skills are registered',
  )
  const routing = await ctx.get('systemPrompt').assemble({})
  const routingSection = routing.sections.find(section => section.name === 'dsh-context-mode:routing')
  assert.ok(routingSection?.text.includes('default'), 'routing section is injected into the system prompt')
  const schedulingSignal = new AbortController().signal
  assert.equal(tools.executionMode({
    callId: 'dsh-context-mode-parallel-smoke',
    name: 'ctx_execute',
    arguments: { language: 'javascript', code: 'console.log(1)' },
    signal: schedulingSignal,
  }).kind, 'parallel', 'ctx_execute permits parallel scheduling')
  assert.equal(tools.executionMode({
    callId: 'dsh-context-mode-exclusive-smoke',
    name: 'ctx_purge',
    arguments: {},
    signal: schedulingSignal,
  }).kind, 'exclusive', 'ctx_purge remains exclusive')

  assert.equal(stripQuotedContent("gh issue list --search 'curl wget'").includes('curl'), false, 'quoted routing text is ignored')
  assert.equal(isSafeCurlWget('curl -s -o /tmp/context-mode.json https://example.com'), true, 'silent file curl remains available')
  assert.equal(isSafeCurlWget('curl https://example.com'), false, 'stdout curl is rejected')

  for (const command of [
    'npm test',
    'pnpm run build',
    'pytest -q',
    'go test ./...',
    'cat package.json',
    'head -100 app.log',
    'git log --oneline',
    'git diff HEAD~5',
    'gh pr list',
    'kubectl get pods',
    'docker ps -a',
    'aws s3 ls',
    'rg TODO src',
    'psql -c "select 1"',
    'node -e "console.log(1)"',
  ]) {
    assert.equal(isFloodingSegment(command), true, `${command} is routed through context-mode`)
  }

  for (const command of [
    'mkdir -p src/lib',
    'git commit -m "x"',
    'git push origin main',
    'npm install left-pad',
    'cd /tmp',
    'pwd',
    'ls',
    'ls -la',
    'echo hello',
    'kill 1234',
    'npm test > /tmp/test.log',
    'cat app.log | head -20',
    'git log --oneline | tail -5',
  ]) {
    assert.equal(isFloodingSegment(command), false, `${command} stays on Bash`)
  }

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

  // Post-execute containment: an oversized result is shrunk and spilled.
  const spillDir = mkdtempSync(join(tmpdir(), 'dsh-context-mode-spill-'))
  const containmentDisposer = installOutputContainment(ctx, { maxResultBytes: 1_000, spillDir })
  const unregisterBig = tools.register({
    name: 'big_output',
    description: 'smoke-test oversized result',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => `HEAD-MARKER\n${'x'.repeat(20_000)}\nTAIL-MARKER`,
  })
  const contained = await tools.execute({
    callId: 'dsh-context-mode-containment-smoke',
    name: 'big_output',
    arguments: {},
    signal: new AbortController().signal,
  })
  const containedText = contained.content.map(block => block.text).join('')
  assert.equal(contained.isError, false, 'oversized results stay successful')
  assert.ok(containedText.includes('dsh-context-mode] Output was'), 'oversized output is summarized')
  assert.ok(containedText.includes('HEAD-MARKER'), 'head of oversized output is kept')
  assert.ok(containedText.includes('TAIL-MARKER'), 'tail of oversized output is kept')
  assert.ok(containedText.length < 12_000, 'oversized output is shrunk below the cap')
  const spills = __spillRecordsForTests()
  assert.ok(spills.length >= 1, 'oversized payload is spilled to disk')
  assert.ok(
    readFileSync(spills.at(-1).path, 'utf8').includes('TAIL-MARKER'),
    'spill file holds the complete payload',
  )
  unregisterBig()
  containmentDisposer()

  // Small results pass through untouched.
  const unregisterSmall = tools.register({
    name: 'small_output',
    description: 'smoke-test small result',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => 'small result body',
  })
  const untouched = await tools.execute({
    callId: 'dsh-context-mode-small-smoke',
    name: 'small_output',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(
    untouched.content.map(block => block.text).join(''),
    'small result body',
    'small results are not rewritten',
  )
  unregisterSmall()
  rmSync(spillDir, { recursive: true, force: true })

  // Pre-compaction archiving: every event lands in a layer, and only prose
  // that states a concrete value is promoted out of `narrative`.
  const archived = classify([
    { type: 'user/message', seq: 0, data: { content: '不要用 Redis，我们这环境没有' } },
    { type: 'tool/result', seq: 1, data: { name: 'ctx_execute', message: { content: [{ type: 'text', text: '87 个失败是 connection pool timeout' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '让我先搜索一下代码库，找到所有相关调用点' }] } } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '根因是连接池配置，pool size 上限为 5' }] } } },
  ])
  const layers = archived.map(line => line.layer)
  assert.deepEqual(layers, ['constraint', 'finding', 'narrative', 'finding'], 'events are layered by kind and content')
  assert.ok(archived[0].text.includes('不要用 Redis'), 'user text is archived verbatim')
  assert.ok(archived[2].text.includes('搜索一下代码库'), 'assistant planning prose stays in narrative')
  assert.ok(archived[3].text.includes('上限为 5'), 'assistant prose stating a value is promoted to finding')
  assert.equal(statesAConcreteValue('我需要检查一下配置文件'), false, 'intent prose is not a finding')
  assert.equal(statesAConcreteValue('根因是连接池耗尽'), true, 'stated root cause is a finding')

  // Harness-injected blocks ride on `user/message`, so they must be dropped by
  // content rather than trusted as constraints.
  assert.equal(
    isInjectedContext('<current_runtime_context>\nworkspace-write\n</current_runtime_context>'),
    true,
    'runtime context block is recognized as injected',
  )
  assert.equal(
    isInjectedContext('<active_memory>\nuser: discard injected blocks\n</active_memory>'),
    true,
    'active memory block is recognized as injected',
  )
  assert.equal(
    isInjectedContext('  <system-reminder>\nskills changed\n</system-reminder>'),
    true,
    'system reminder block is recognized as injected',
  )
  assert.equal(
    isInjectedContext('<resume_snapshot>\nearlier turns\n</resume_snapshot>'),
    true,
    'resume snapshot block is recognized as injected',
  )
  assert.equal(
    isInjectedContext('请解释一下 <active_memory> 这个标签是干嘛的'),
    false,
    'a user quoting an injected tag mid-message is still archived',
  )
  assert.equal(isInjectedContext('不要用 Redis'), false, 'ordinary user text is not injected')

  // `textOf` reads text blocks only, so a block's opening tag can be gone by
  // the time the body reaches the classifier. The headings must still match.
  assert.equal(
    isInjectedContext('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
    true,
    'runtime context heading without its tag is recognized as injected',
  )
  assert.equal(
    isInjectedContext('The available skill catalog changed. This complete catalog replaces every earlier list.'),
    true,
    'skill catalog heading without its tag is recognized as injected',
  )
  assert.equal(
    isInjectedContext('We discussed the current runtime context of this session.'),
    false,
    'the heading phrase mid-sentence does not disqualify a real message',
  )

  const filtered = classify([
    { type: 'user/message', seq: 10, data: { content: '不要用 Redis' } },
    { type: 'user/message', seq: 11, data: { content: '<active_memory>\nuser: 不要用 Redis\n</active_memory>' } },
    { type: 'user/message', seq: 12, data: { content: '<current_runtime_context>\npolicy: ask\n</current_runtime_context>' } },
  ])
  assert.deepEqual(
    filtered.map(line => line.layer),
    ['constraint'],
    'injected blocks never reach the constraint layer',
  )
  assert.ok(filtered[0].text.includes('不要用 Redis'), 'the genuine user message survives filtering')
  assert.ok(
    !filtered.some(line => line.text.includes('current_runtime_context')),
    'no runtime snapshot text is archived',
  )

  // Off by default only when disabled: the listener must not subscribe.
  const disabledDisposer = installPrecompactArchive(ctx, () => undefined, { enabled: false })
  disabledDisposer()
  const archiveDisposer = installPrecompactArchive(ctx, () => undefined)
  archiveDisposer()

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
  assert.deepEqual(
    (await skills.list()).filter(skill => skill.name === 'context-mode' || skill.name.startsWith('ctx-')).map(skill => skill.name).sort(),
    ['context-mode', 'ctx-doctor', 'ctx-index', 'ctx-insight', 'ctx-purge', 'ctx-search', 'ctx-stats', 'ctx-upgrade'],
    'all context-mode user-invocable skills are registered',
  )

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
