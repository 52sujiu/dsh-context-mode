/**
 * Scale sweep for the A/B+ precompact storage comparison.
 *
 * The 200-turn run showed only a one-query gap between full-transcript and
 * structured storage. This sweep grows the same conversation to 200 / 500 /
 * 1000 turns to test whether BM25 dilution widens the gap with corpus size,
 * which is the question a precompact strategy actually has to answer.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { McpStdioClient } from '../lib/types/mcp-client.js'
import { segmentCjk, buildCjkQuery } from '../lib/types/cjk.js'

const BUNDLE = new URL('../vendor/context-mode/server.bundle.mjs', import.meta.url).pathname
const norm = value => value.replace(/\s+/g, '')

const FACTS = [
  { role: 'user', text: '不要用 Redis，我们这环境没有' },
  { role: 'user', text: '缓存走本地文件就行' },
  { role: 'user', text: '那个分支叫 fix/pool-timeout' },
  { role: 'tool', text: '87 个失败全部是 connection pool timeout，最早一次 14:23:07' },
  { role: 'tool', text: 'pool size 上限 5' },
  { role: 'user', text: '部署目标是 us-east-1 的 staging 集群' },
  { role: 'tool', text: '构建耗时 4m32s，其中 TypeScript 编译占 3m10s' },
  { role: 'user', text: '重试策略改成指数退避，初始 200ms' },
]

const NOISES = [
  '我先跑一下测试看看失败分布。让我先检查测试框架配置，确认 runner 设置是否正确，然后逐步分析每个失败的用例，找出共同点，看看是环境问题还是代码问题。',
  '看到失败之后，我需要进一步分析这些失败的具体错误信息，看看是否有共同的错误模式，可能和并发、超时或资源限制有关，也可能是测试隔离没做好。',
  '这看起来是配置问题。我需要检查配置文件的各个参数，看看设置是否合理，以及是否有环境变量覆盖，还要确认默认值是什么。',
  '让我继续分析代码结构。首先检查项目目录布局，看看有哪些模块，理解整体架构后再定位相关代码，这样能避免改错地方。',
  '现在我需要看看配置文件，确认当前的设置，以及是否有环境变量覆盖。同时还要考虑向后兼容的问题。',
  '让我先搜索一下代码库，找到所有相关调用点，然后逐个检查它们的使用方式，确认是否需要统一修改。',
  '我需要理解这个模块的职责边界，看看它和其他模块的依赖关系，避免引入循环依赖。',
  '接下来我要看看测试文件，确认测试用例的覆盖范围，以及是否有遗漏的边界情况需要补充。',
  '这个改动可能会影响其他模块，我需要评估影响范围，看看有没有隐藏的耦合点，以及是否需要同步修改文档。',
  '让我检查一下错误处理的路径，确认异常情况下的行为是否符合预期，以及是否有资源泄漏的风险。',
]

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

function buildSession(turns) {
  const session = []
  for (let i = 0; i < turns; i++) {
    session.push({ role: 'assistant', text: NOISES[i % NOISES.length] })
    session.push({ role: 'user', text: `继续排查第 ${i} 步，看看还有什么问题` })
  }
  FACTS.forEach((f, i) => session.splice(60 + i * Math.floor(turns / 12), 0, f))
  return session
}

function render(session, mode) {
  const rows = mode === 'full'
    ? session
    : session.filter(m => m.role === 'user' || m.role === 'tool')
  return rows.map((m, i) => {
    const tag = m.role === 'user' ? '用户需求/约束' : m.role === 'tool' ? '工具结论' : '助手'
    return `## ${mode === 'full' ? '对话' : '事实'} ${i} [${tag}]\n${m.text}`
  }).join('\n\n')
}

async function index(dir, docPath) {
  rmSync(dir, { recursive: true, force: true })
  const client = new McpStdioClient(BUNDLE, {
    ...process.env,
    CONTEXT_MODE_PLATFORM: 'pi',
    CONTEXT_MODE_PROJECT_DIR: '/tmp/dsh-scale',
    CONTEXT_MODE_DIR: dir,
  }, process.execPath)
  client.start()
  await client.initialize(20000)
  await client.callTool('ctx_index', {
    content: segmentCjk(readFileSync(docPath, 'utf8')),
    source: 'exp',
  }, new AbortController().signal)
  client.shutdown()
}

async function ask(dir, query) {
  const client = new McpStdioClient(BUNDLE, {
    ...process.env,
    CONTEXT_MODE_PLATFORM: 'pi',
    CONTEXT_MODE_PROJECT_DIR: '/tmp/dsh-scale',
    CONTEXT_MODE_DIR: dir,
  }, process.execPath)
  client.start()
  await client.initialize(20000)
  const reply = await client.callTool('ctx_search', {
    queries: [buildCjkQuery(query)], source: 'exp', limit: 3,
  }, new AbortController().signal)
  client.shutdown()
  return (reply.content ?? []).map(x => x.text).join('')
}

const work = '/tmp/dsh-scale-docs'
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const rows = []
for (const turns of [200, 500, 1000]) {
  const session = buildSession(turns)
  const aPath = `${work}/a-${turns}.md`
  const bPath = `${work}/b-${turns}.md`
  writeFileSync(aPath, render(session, 'full'))
  writeFileSync(bPath, render(session, 'structured'))

  const aDir = `/tmp/dsh-scale-a-${turns}`
  const bDir = `/tmp/dsh-scale-b-${turns}`
  await index(aDir, aPath)
  await index(bDir, bPath)

  let aHits = 0, bHits = 0
  for (const { q, want } of QUERIES) {
    if (norm(await ask(aDir, q)).includes(norm(want))) aHits++
    if (norm(await ask(bDir, q)).includes(norm(want))) bHits++
  }
  rows.push({ turns, aHits, bHits, aBytes: readFileSync(aPath, 'utf8').length, bBytes: readFileSync(bPath, 'utf8').length })
  console.log(`turns=${turns}  A=${aHits}/8  B+=${bHits}/8  (A ${rows.at(-1).aBytes}B / B+ ${rows.at(-1).bBytes}B)`)
}

console.log('\n' + JSON.stringify(rows))
