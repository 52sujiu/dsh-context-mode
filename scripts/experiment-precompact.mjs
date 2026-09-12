/**
 * A/B+ precompact storage strategy experiment.
 *
 * Measures two questions the earlier (broken-CJK) run could not answer:
 *   1. does full-transcript storage (A) lose precision against structured
 *      storage (B+)?
 *   2. does that gap widen as the corpus grows?
 *
 * Runs each query on a fresh client so the search throttle never truncates a
 * result set, and normalizes whitespace before matching because CJK text is
 * stored segmented.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { McpStdioClient } from '../lib/types/mcp-client.js'
import { segmentCjk, buildCjkQuery } from '../lib/types/cjk.js'

const BUNDLE = new URL('../vendor/context-mode/server.bundle.mjs', import.meta.url).pathname
const DOCS = new URL('../.experiment/', import.meta.url).pathname
const norm = value => value.replace(/\s+/g, '')

const QUERIES = [
  { q: '缓存方案用什么', want: '本地文件' },
  { q: '为什么不能用 Redis', want: '环境没有' },
  { q: '分支名字叫什么', want: 'fix/pool-timeout' },
  { q: '测试失败的根因是什么', want: 'connection pool timeout' },
  { q: 'pool size 上限多少', want: '上限5' },
  { q: '部署到哪个集群', want: 'us-east-1' },
  { q: '构建耗时多久', want: '4m32s' },
  { q: '重试策略怎么改的', want: '指数退避' },
]

const label = process.argv[2] ?? 'structured'
const docPath = DOCS + (label === 'full' ? 'A-full.md' : 'B-structured.md')
const dataDir = `/tmp/dsh-exp-${label}`

// Index once.
{
  const client = new McpStdioClient(BUNDLE, {
    ...process.env,
    CONTEXT_MODE_PLATFORM: 'pi',
    CONTEXT_MODE_PROJECT_DIR: '/tmp/dsh-exp',
    CONTEXT_MODE_DIR: dataDir,
  }, process.execPath)
  client.start()
  await client.initialize(20000)
  const content = segmentCjk(readFileSync(docPath, 'utf8'))
  await client.callTool('ctx_index', { content, source: 'exp' }, new AbortController().signal)
  client.shutdown()
}

const results = []
for (const { q, want } of QUERIES) {
  const client = new McpStdioClient(BUNDLE, {
    ...process.env,
    CONTEXT_MODE_PLATFORM: 'pi',
    CONTEXT_MODE_PROJECT_DIR: '/tmp/dsh-exp',
    CONTEXT_MODE_DIR: dataDir,
  }, process.execPath)
  client.start()
  await client.initialize(20000)
  const reply = await client.callTool('ctx_search', {
    queries: [buildCjkQuery(q)],
    source: 'exp',
    limit: 3,
  }, new AbortController().signal)
  client.shutdown()

  const text = (reply.content ?? []).map(x => x.text).join('')
  // The first result block starts after the echoed query header.
  const firstBlock = text.split(/^--- \[/m)[1] ?? ''
  results.push({
    query: q,
    hit: norm(text).includes(norm(want)),
    first: norm(firstBlock.slice(0, 400)).includes(norm(want)),
  })
}

const hits = results.filter(r => r.hit).length
const firsts = results.filter(r => r.first).length
console.log(JSON.stringify({ label, hits, firsts, total: QUERIES.length, results }, null, 1))
