/**
 * End-to-end check for pre-compaction archiving.
 *
 * Drives the real listener with a synthetic session containing a
 * `compaction/start` event, then searches each layer by `source` to prove the
 * three layers are independently addressable and hold the right content.
 *
 * Writes its report to `.precompact-report.txt` because a nested child process
 * cannot inherit this sandbox's stdout.
 */

import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { McpStdioClient } from '../lib/types/mcp-client.js'
import { installPrecompactArchive } from '../lib/types/precompact.js'
import { buildCjkQuery } from '../lib/types/cjk.js'

const BUNDLE = new URL('../vendor/context-mode/server.bundle.mjs', import.meta.url).pathname
const OUT = new URL('../.precompact-report.txt', import.meta.url).pathname
const lines = []
const say = text => lines.push(text)

const client = new McpStdioClient(BUNDLE, {
  ...process.env,
  CONTEXT_MODE_PLATFORM: 'pi',
  CONTEXT_MODE_PROJECT_DIR: '/tmp/precompact',
  CONTEXT_MODE_DIR: '/tmp/precompact-data',
}, process.execPath)
client.start()
await client.initialize(20000)

const ctx = new Context()
ctx.logger = { debug() {}, info() {}, warn() {}, error() {} }

let listener = null
ctx.on = (_name, fn) => { listener = fn; return () => { listener = null } }

installPrecompactArchive(ctx, () => client)
if (listener === null) {
  say('FAIL: listener was not registered')
  writeFileSync(OUT, lines.join('\n'))
  process.exit(1)
}

// Feed transcript events first, the way a live session does, then trigger
// compaction. The listener must have buffered them as they arrived.
const stream = [
  { type: 'user/message', seq: 0, data: { content: '不要用 Redis，我们这环境没有' } },
  { type: 'user/message', seq: 1, data: { content: '缓存走本地文件就行' } },
  { type: 'tool/result', seq: 2, data: { name: 'ctx_execute', message: { content: [{ type: 'text', text: '87 个失败全部是 connection pool timeout' }] } } },
  { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '让我先搜索一下代码库，找到所有相关调用点' }] } } },
  { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '根因是连接池配置，pool size 上限为 5' }] } } },
]

// A session whose live transcript is EMPTY: if the archive still succeeds, it
// proves the buffered events were used rather than a re-read of the log, which
// is the property that survives compaction/prune.
const session = { id: 'demo123', seq: 10, snapshotEvents: () => [] }

for (const event of stream) listener(session, event)
listener(session, { type: 'compaction/start', seq: 5, data: {} })
await new Promise(resolve => setTimeout(resolve, 3000))
say('（会话实时日志为空 —— 成功即证明走了缓冲路径）\n')

async function search(source, query) {
  const reply = await client.callTool('ctx_search', {
    queries: [buildCjkQuery(query)], source, limit: 3,
  }, new AbortController().signal)
  return (reply.content ?? []).map(x => x.text).join('')
}

const norm = value => value.replace(/\s+/g, '')
const checks = [
  ['约束层含用户约束', 'session/demo123/constraint', '为什么不能用 Redis', '环境没有'],
  ['结论层含工具结论', 'session/demo123/finding', '测试失败的根因', 'connection pool timeout'],
  ['结论层含助手发现', 'session/demo123/finding', 'pool size 上限', '上限为 5'],
  ['叙述层含助手推理', 'session/demo123/narrative', '搜索代码库', '搜索一下代码库'],
]

say('=== 分层检索验证 ===')
let pass = 0
for (const [label, source, query, want] of checks) {
  const text = await search(source, query)
  const ok = norm(text).includes(norm(want))
  if (ok) pass++
  say(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

const constraintOnly = await search('session/demo123/constraint', '搜索代码库')
const leak = norm(constraintOnly).includes(norm('搜索一下代码库'))
if (!leak) pass++
say(`  ${leak ? 'FAIL' : 'OK  '} 约束层不含助手推理（分层隔离）`)

say(`\n通过: ${pass}/${checks.length + 1}`)
client.shutdown()
writeFileSync(OUT, lines.join('\n'))
