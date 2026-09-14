# AGENTS.md — working notes for this repository

This folder is the `dsh-context-mode` plugin: a DSH adapter that exposes the
vendored context-mode engine as 11 `ctx_*` tools, archives the transcript before
compaction, and injects a resume navigation block.

`docs/ARCHITECTURE-AND-RESULTS.md` explains the design and the measured results.
**This file is the other half**: the facts and traps that cost real time to
discover. Read it before changing anything here.

---

## 0. Ground rules

- **Never modify DSH core.** Everything lives in this plugin or its sibling
  `dsh-context-mode-compaction`. Use the plugin API; that is not the same as
  patching official code.
- **Do not commit, tag, or publish without an explicit user request.**
- Keep the ESM contract: `"type": "module"`, `.js` import suffixes,
  `name`/`Config`/`apply` exports, no default export.
- `lib/types/` is the build output and **is committed**. Rebuild before release
  and commit the result, or the published package ships stale code.

---

## 1. Cordis plugin traps

### 1.1 Never use `#private` in a `Service` subclass

`Service`'s constructor replaces `self` with a callable proxy:

```js
// @deepseek-ai/cordis/lib/index.js:1777
if (self[symbols.invoke]) self = createCallable(name, joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker);
```

`createCallable` builds a new object via `joinPrototype`. **`#private` slots are
not carried across.** The field reads as `undefined` at runtime, usually as an
opaque `Cannot read properties of undefined` far from the real cause.

**Use a module-level `WeakMap` keyed by the instance instead.**

### 1.2 A bare package name in a preset row resolves from the *harness* base

A preset row whose `name` is a bare package (`dsh-context-mode-compaction`) is
resolved from the harness's own base, **not** from the profile that installed
it. A user-installed package is therefore invisible, and DSH marks the whole
preset `broken`.

A **relative** `name` resolves against the preset's own directory — a base a
user-installed package *can* reach. That is why `scripts/wire.mjs` rewrites the
row to a relative specifier rather than telling users to put a package name
there.

### 1.3 Preset rows are runtime state, not a patch layer

Bundle patch layers compose by `id`. Preset rows do not — they are mounted at
runtime. Do not expect a patch layer to override a preset row.

### 1.4 The package is ESM; `require` does not exist in it

A diagnostic that called `require('node:fs')` inside this package threw
`require is not defined`, and a surrounding `catch {}` swallowed it — so the log
stayed empty and the investigation went in circles.

- Use top-level `import`, or `createRequire(import.meta.url)`.
- **Never write `catch {}`.** It hides exactly the failures you are debugging.

---

## 2. Session event shapes

Verified against a real session log. Fields are **`type`, `seq`, `time`,
`data`**; `time` is epoch ms.

| Event | `data` keys that matter |
|---|---|
| `user/message` | `content`, `source`, `role`, `id` |
| `compaction/start` | **`compactionId`, `turn`** — that is all |
| `compaction/summary` | `compactionId`, `summary`, `rawOutput`, `shadowedRange`, `shadowedSeqs`, `shadowedTokenCount`, `usage`, … |

Two things that mislead:

- **`compaction/start` carries only `{compactionId, sourceCommandId?, turn}`.**
  `turn: null` means a manual `/compact`; `turn: N` means the automatic path.
  This is the **only** reliable way to tell them apart.

- **`data.summary` is a content-block array, not a string.**
  `Array.isArray(v) ? v.map(b => b.text).join('') : v`.
  Reading `v.length` on it yields the block count (usually `1`), which looks
  like "the summary is 1 character" and sends you hunting a bug that is not
  there.

### 2.1 The replacement node carries the span at the top level

A compaction writes a replacement `user/message`. Its `surfaceOp` and
`sourceEventSeqs` are **siblings of `data`**, not keys inside it.

### 2.2 Surface nodes are identity-matched and derived messages are cached

`Session.deriveEventMessage(event)` is cached per surface node, so matching
replayed `input.messages` against surface nodes works by **exact identity**.
Do not rebuild equivalent objects and expect a match.

### 2.3 `snapshotEvents()` returns the whole log by default

```ts
snapshotEvents(fromSeq?, toSeqExclusive?)
```

`fromSeq` **defaults to the start of the log**, not to the live window. A
`session/end-seed` event marks a constructor-seed boundary but does **not**
truncate the view. An earlier investigation concluded the opposite from
inference alone and was wrong; a one-line diagnostic settled it
(`firstSeq=0`).

**Measure before concluding.**

---

## 3. Compaction engine internals

Official engine:
`…/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` (note: `lib/`,
not `lib/types/`). Line numbers drift between versions; re-grep.

```
compactIfNeeded  :873  → compactRegion          (:930)   automatic
compactRegion    :930  for context-overflow (:893) and pressure (:915)
compactNow       :944  → compactSurfaceRegion   (:953)   manual — BYPASSES compactRegion
```

**`compactNow` does not go through `compactRegion`.** The `range` field is
written only by `compactRegion`, so a manual compaction produces no range. An
archiver that required `range` silently archived **nothing for 8 consecutive
manual compactions**. The fix recovers the span by identity-matching replayed
messages against surface nodes.

Transaction order:

```
compaction/start → summarizeCompaction → commitCompactionBody → compaction/end
                                          (writes summary, then replacement)
```

**The replacement node does not exist when `summarize` runs.** Do not try to
read it from inside the summarization input.

Also present in the profile: `dsh-compaction-tool-result-pruner`, which can
change what the model sees before your engine runs.

---

## 4. Archive layers

```
session/<sessionId>/constraint   user requirements and decisions
session/<sessionId>/finding      tool results + assistant conclusions
session/<sessionId>/narrative    assistant reasoning
```

Classification is by event kind **and, for assistant messages, by content**:

```ts
// src/precompact.ts — layerOf
if (type === 'user/message')    return LAYERS.constraint
if (type === 'tool/result')     return LAYERS.finding
if (type === 'assistant/message')
  return statesAConcreteValue(text) ? LAYERS.finding : LAYERS.narrative
```

**An assistant message can land in either of two layers.** Measured in one
session: 154 in `finding`, 613 in `narrative`.

Consequence: anywhere that names a layer for a clipped assistant entry **must
name both**, or most assistant prose becomes unreachable. See
`LAYERS_FOR_KIND` in the compaction package.

### 4.1 Harness-injected blocks share the `user/message` type

`<active_memory>`, `<current_runtime_context>`, `<system-reminder>`, and
`<resume_snapshot>` arrive attached to user messages. Filing them under
`constraint` both pollutes that layer and returns stale policy snapshots.
`INJECTED_CONTEXT_PATTERN` discards them, matching both the tag form and the
leading heading (a block's opening tag can be stripped before classification).

### 4.2 The knowledge base stores chunks, not messages

Tables: `sources`, `chunks`, `chunks_trigram*`. Useful columns are
`sources.label` / `sources.chunk_count`, and `chunks.content` /
`chunks.source_id`. There is **no** `source_category` column on `sources` —
guessing column names wastes a round trip; read the schema first.

Node 24 has `node:sqlite` built in. `better-sqlite3` is **not** installed in
the profile — `require('node:sqlite')` is the reliable way in.

---

## 5. Session log files

`~/.dsh/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`

**They are multi-frame zstd.** `zstdDecompressSync(wholeFile)` decodes only the
first frame and yields a single line, which looks like an empty session. Decode
frame by frame, searching for the magic bytes `28 B5 2F FD`.

There is no `timeout(1)` on this host; do not reach for it in scripts.

---

## 6. Testing

### 6.1 Every new test must be shown to fail against the bug it targets

This is not ceremony. A 9/9-green suite once verified **nothing**: the test
helper re-installed the module on every render, resetting the internal
`WeakMap`, so the buggy guard it was meant to catch evaluated as always-true.

Procedure:

1. Write the test.
2. Confirm it passes.
3. **Reintroduce the old behaviour and confirm the test fails.**
4. Restore, and confirm it passes again.

If step 3 does not fail, the test is decoration.

### 6.2 Structural assertions, not substring probes

A substring check on a dump proves nothing: this repository's own source and
the conversation's own tool output contain the very strings being searched for,
so a dump search reports success for a compaction that wrote nothing.

Anchor on line starts, address content blocks by structure, and assert on the
*shape* of what was written. `scripts/verify-checkpoint.mjs` shows the pattern.

### 6.3 `renderTranscript` joins; `buildTranscript` clips

Clipping happens in `buildTranscript` (per-entry `userLine` / `assistantLine` /
`toolLine`). `renderTranscript` only concatenates already-rendered lines and
enforces the overall size bound. Feeding it hand-written strings to test
clipping tests nothing — drive `buildTranscript` with raw events.

### 6.4 Test state must outlive one render

Real deployment installs once and renders many times. If a test re-installs per
render, any state-dependent bug is invisible. Use one session object and one
renderer across the whole test case.

---

## 7. Local install and verification

`file:` dependencies are **copied** by pnpm, not symlinked. After editing source
you must run the build **and** reinstall in the profile:

```bash
cd /Users/harness/dsh-context-mode && npm run verify
cd /Users/sujiu/.dsh/profiles/dsh-tui && pnpm install
```

A restart alone is not enough. Then restart DSH so the process reloads.

There is exactly one live copy on disk:

```
/Users/sujiu/.dsh/profiles/dsh-tui/node_modules/dsh-context-mode
```

Multiple stale `dsh` processes can be running at once; check `ps -eo pid,lstart,command`
and compare start time against your install time before trusting a result.

### 7.1 npm CDN lag is not a publish failure

`npm publish` prints `+ pkg@version` on success, but an immediate `pnpm install`
can still report `ERR_PNPM_NO_MATCHING_VERSION`. Confirm against the registry
directly:

```bash
curl -s -H 'Cache-Control: no-cache' https://registry.npmjs.org/<pkg> | grep -o '"latest":"[^"]*"'
```

If the version is there, wait and retry.

### 7.2 `lib/` vs `lib/types/`

`tsc`'s `outDir` here is `lib/types`, and `main` is `lib/types/index.js`.
`ls lib/` showing only a `types` directory is **normal**, not a missing build.

### 7.3 Stale build artifacts survive editing

`tsc` is incremental. After deleting a module or a diagnostic, the old `.js`
can remain in `lib/types/` with references intact. When a grep finds traces of
code you removed, rebuild from scratch:

```bash
rm -rf lib && npm run build
```

---

## 8. Verification habits

- **Read the schema before querying.** Guessed column and field names cost more
  than the read.
- **A probe that returns "absent" needs a positive control.** If a check reports
  nothing, first prove it can report something.
- **State the trigger condition, not just the behaviour.** "Assistant messages
  keep head 200 + tail 200" is wrong; "assistant messages **over 400 chars**
  keep head 200 + tail 200" is right.
- **Prefer numbers measured from the artifacts** over numbers recalled from
  the conversation. Session logs and the knowledge base are both queryable.

---

## 9. Layout

```
src/
  index.ts               plugin entry, 11 tools, routing injection
  mcp-client.ts          MCP bridge
  precompact.ts          pre-compaction archiving → three layers
  session-memory.ts      per-turn <active_memory> navigation
  routing.ts             routing rules
  output-containment.ts  large-output interception
  cjk.ts                 CJK segmentation
scripts/                 verify + smoke, run by `npm run verify`
skills/context-mode/     the rule set a model can load explicitly
vendor/context-mode/     vendored engine (self-contained, no external deps)
docs/                    design and measured results
```

Sibling package `dsh-context-mode-compaction` holds the compaction strategy and
has zero hard dependency on this one. Either can be replaced independently.
