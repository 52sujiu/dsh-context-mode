#!/usr/bin/env node
/**
 * Remove harness-injected context blocks that earlier builds filed as
 * constraints.
 *
 * Before `isInjectedContext` existed, `precompact` classified purely on event
 * type, so the `<current_runtime_context>` / `<active_memory>` blocks DSH
 * attaches to user messages were archived as `session/<id>/constraint` — the
 * layer meant to hold requirements and decisions. Those rows are runtime
 * noise, and they are stale policy snapshots besides.
 *
 * Scope is deliberately narrow. A row is only a candidate when it lives in an
 * archived session layer AND carries an injected marker immediately after the
 * archive's own `## [layer] party (seq N)` heading. A document or source file
 * that merely *mentions* `active_memory` (the plugin's own sources do) keeps
 * its row, because such a match is never preceded by an archive heading.
 *
 * Usage:
 *   node scripts/cleanup-injected.mjs --db <path> [--apply]
 *
 * Without `--apply` nothing is written; the script only reports what it would
 * delete. Both FTS5 tables are cleaned together, since `chunks` and
 * `chunks_trigram` hold the same logical rows and would otherwise disagree.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dbIndex = args.indexOf('--db')
const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : undefined

if (dbPath === undefined) {
  console.error('usage: node scripts/cleanup-injected.mjs --db <path> [--apply]')
  process.exit(2)
}
if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`)
  process.exit(2)
}

/** Markers that identify a harness-injected block, matched after the heading. */
const MARKERS = [
  '<current_runtime_context',
  '<active_memory',
  '<system-reminder',
  '<resume_snapshot',
  'Current runtime context',
  'The available skill catalog changed',
]

/** Archive headings look like `## [约束] 用户 (seq 2766)`. */
const heading = '## [%'
const patterns = MARKERS.map(marker => `${heading}%${marker}%`)

/** Build the content predicate for one table alias. */
const clausesFor = alias => MARKERS.map(() => `(${alias}.content LIKE ?)`).join(' OR ')

const selectSql = `
  SELECT c.rowid AS rowid, s.label AS label, c.content AS content
  FROM chunks c
  JOIN sources s ON s.id = c.source_id
  WHERE s.label LIKE 'session/%'
    AND (${clausesFor('c')})
`

const db = new DatabaseSync(dbPath)
const rows = db.prepare(selectSql).all(...patterns)

// `chunks_trigram` mirrors `chunks`; the same logical row has a different
// rowid per table, so the trigram side is matched by content within the same
// session-scoped sources.
const trigramSql = `
  SELECT t.rowid AS rowid, s.label AS label, t.content AS content
  FROM chunks_trigram t
  JOIN sources s ON s.id = t.source_id
  WHERE s.label LIKE 'session/%'
    AND (${clausesFor('t')})
`
const trigramRows = db.prepare(trigramSql).all(...patterns)

console.log(`mode: ${apply ? 'APPLY' : 'DRY RUN'}`)
console.log(`database: ${dbPath}`)
console.log(`chunks rows matched: ${rows.length}`)
console.log(`chunks_trigram rows matched: ${trigramRows.length}`)

for (const row of rows) {
  const preview = row.content.replace(/\s+/g, ' ').slice(0, 96)
  console.log(`  [${row.rowid}] ${row.label}\n      ${preview}`)
}

if (rows.length === 0 && trigramRows.length === 0) {
  console.log('\nnothing to clean')
  db.close()
  process.exit(0)
}

if (!apply) {
  console.log('\ndry run only — re-run with --apply to delete these rows')
  db.close()
  process.exit(0)
}

db.exec('BEGIN')
try {
  const delChunks = db.prepare('DELETE FROM chunks WHERE rowid = ?')
  for (const row of rows) delChunks.run(row.rowid)
  const delTrigram = db.prepare('DELETE FROM chunks_trigram WHERE rowid = ?')
  for (const row of trigramRows) delTrigram.run(row.rowid)
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  console.error('cleanup failed, rolled back:', error)
  db.close()
  process.exit(1)
}

// `sources.chunk_count` is a cached tally; recompute it for the labels touched
// so the bookkeeping matches the rows that remain.
const touched = new Set([...rows, ...trigramRows].map(row => row.label))
const recount = db.prepare(`
  UPDATE sources
  SET chunk_count = (
    SELECT COUNT(*) FROM chunks c WHERE c.source_id = sources.id
  )
  WHERE label = ?
`)
for (const label of touched) recount.run(label)

// Reclaim the space freed by the deletes.
db.exec("INSERT INTO chunks(chunks) VALUES('optimize')")
db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')")

console.log(`\ndeleted ${rows.length} + ${trigramRows.length} rows, recounted ${touched.size} source(s)`)
db.close()
